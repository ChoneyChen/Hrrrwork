import type { ProviderId, QuotaWakeSettings, RateLimitResponse, WakeModel } from '../../shared/types'
import type { PersistedState } from '../store'
import { getPrimaryLimits } from './logic'
import { dailyWakeSlots } from '../../shared/wakeSchedule'

const LIGHT_MODELS = ['gpt-6-luna', 'gpt-5.6-luna']
export function chooseWakeModel(provider: ProviderId, requested: string, models: WakeModel[]): WakeModel | null {
  if (provider === 'claude-code') {
    const id = requested === 'auto' ? 'haiku' : requested
    return /^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{0,159}$/.test(id) ? { id, name: id } : null
  }
  if (requested !== 'auto') return models.find(model => model.id === requested) ?? null
  return LIGHT_MODELS.map(id => models.find(model => model.id === id)).find(Boolean) ?? null
}

export function lowestEffort(model: WakeModel): string | undefined {
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].find(effort => model.efforts?.includes(effort))
}

export interface WakeProvider {
  id: ProviderId
  connected: boolean
  quota: RateLimitResponse | null
  models: WakeModel[]
  busy: boolean
  send: (settings: QuotaWakeSettings, model: WakeModel) => Promise<{ threadId: string; turnId?: string }>
}

export class QuotaWake {
  private running = new Set<ProviderId>()

  async check(provider: WakeProvider, state: PersistedState, save: () => Promise<void>, event: (message: string, success: boolean) => void, now = Date.now()): Promise<void> {
    const settings = state.settings.quotaWake[provider.id]
    if (!settings.enabled || this.running.has(provider.id)) return
    const limits = getPrimaryLimits(provider.quota)
    const primary = limits?.primary
    if (!primary || primary.windowDurationMins !== 300 || !Number.isFinite(primary.resetsAt) || primary.resetsAt <= 0) return
    let plan = state.wakePlans[provider.id]
    const resetAt = primary.resetsAt
    const daily = settings.timing === 'daily'
    const scheduleKey = daily ? `daily:${settings.firstWakeAt}` : 'reset'
    const grace = daily ? 0 : state.settings.graceSeconds * 1000
    if (daily && (!settings.firstWakeAt || !Number.isFinite(settings.firstWakeAt))) return
    if (plan && (plan.scheduleKey ?? 'reset') !== scheduleKey && !['dispatching', 'submitted'].includes(plan.status)) { delete state.wakePlans[provider.id]; plan = undefined }
    if (!plan || (plan.status !== 'waiting' && resetAt > plan.resetAt)) {
      const key = `${provider.id}:${resetAt}`
      if (state.wakeReceipts.includes(key)) return
      const slotAt = daily ? dailyWakeSlots(settings.firstWakeAt!, Math.max(resetAt * 1000, now - 30 * 60 * 1000), 1)[0] : undefined
      if (daily && !slotAt) return
      plan = { resetAt, scheduledFor: slotAt ?? resetAt * 1000 + grace, status: 'waiting', scheduleKey, slotAt, message: daily ? '等待定时唤醒' : '等待官方五小时窗口刷新' }
      state.wakePlans[provider.id] = plan
    }
    if (plan.status !== 'waiting') return
    // If normal work already opened a newer window, don't inject an unnecessary ping.
    if (resetAt > plan.resetAt && primary.usedPercent > 0 && now >= plan.resetAt * 1000) {
      if (!daily) { plan.status = 'skipped'; plan.message = '新窗口已有用量，本次无需唤醒'; await save(); return }
      plan.resetAt = resetAt
      plan.scheduledFor = Math.max(plan.scheduledFor, resetAt * 1000)
      plan.message = '新的额度窗口已开始，等待刷新后再唤醒'
    } else if (daily && resetAt > plan.resetAt && now < plan.resetAt * 1000) {
      plan.resetAt = resetAt
      plan.scheduledFor = Math.max(plan.scheduledFor, resetAt * 1000)
    }
    const blockedUntil = [limits?.primary, limits?.secondary]
      .filter(window => window && window.usedPercent >= 99.9 && window.resetsAt * 1000 > now)
      .map(window => window!.resetsAt * 1000 + grace)
    // Keep a known weekly postponement even after that weekly timestamp passes.
    plan.scheduledFor = Math.max(plan.scheduledFor, plan.resetAt * 1000 + grace, ...blockedUntil)
    if (now < plan.scheduledFor) { await save(); return }
    if (now - plan.scheduledFor > 30 * 60 * 1000) {
      plan.status = 'skipped'; plan.message = '错过窗口超过 30 分钟，不补发旧唤醒'
      await save(); return
    }
    if (!provider.connected || provider.busy) {
      plan.message = !provider.connected ? '等待应用连接' : '正在工作或接力中，暂不打扰'
      await save(); return
    }
    // A fresh Codex read must confirm capacity; Claude's local status line may stay stale until the next request.
    if (provider.id === 'codex' && ((primary.usedPercent >= 99.9 && resetAt * 1000 <= now) || provider.quota?.ordinaryUsageAllowed === false || limits?.spendControlReached)) {
      plan.message = '等待额度恢复可用'; await save(); return
    }
    const model = chooseWakeModel(provider.id, settings.model, provider.models)
    if (!model) { plan.message = '未发现可用轻量模型，请在设置中选择'; await save(); return }
    if (settings.target === 'existing' && !settings.threadId) { plan.message = '请先选择唤醒对话'; await save(); return }
    this.running.add(provider.id)
    try {
      const key = `${provider.id}:${plan.resetAt}`
      if (state.wakeReceipts.includes(key)) { plan.status = 'skipped'; plan.message = '本窗口已有发送记录'; return }
      plan.status = 'dispatching'; plan.model = model.id; plan.message = '正在发起唤醒'
      state.wakeReceipts = [...state.wakeReceipts, key].slice(-200)
      // Durable at-most-once receipt BEFORE creating a thread or sending a message.
      await save()
      const result = await provider.send(settings, model)
      Object.assign(plan, result, { sentAt: now })
      if (plan.status === 'dispatching') { plan.status = 'submitted'; plan.message = '唤醒已提交，等待完成确认' }
      event(`${provider.id === 'codex' ? 'Codex' : 'Claude Code'} 已提交额度唤醒。`, true)
    } catch (error) {
      plan.status = 'failed'; plan.message = `需要检查，不自动重发：${error instanceof Error ? error.message : String(error)}`
      event(plan.message, false)
    } finally {
      this.running.delete(provider.id)
      await save()
    }
  }

  complete(state: PersistedState, provider: ProviderId, threadId: string, success: boolean, turnId?: string): boolean {
    const plan = state.wakePlans[provider]
    if (!plan || !['dispatching', 'submitted'].includes(plan.status) || plan.threadId !== threadId || (plan.turnId && turnId && plan.turnId !== turnId)) return false
    plan.status = success ? 'completed' : 'failed'
    plan.message = success ? '唤醒轮次已完成；窗口以官方数据为准' : '唤醒未完成，请检查原对话；本窗口不重发'
    return true
  }
}
