import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WAKE_PROMPT, type ProviderId, type QuotaWakeSettings, type WakeModel,
  ConnectionState,
  RateLimitResponse,
  RelayEvent,
  RelayQueueItem,
  RelaySettings,
  RelaySnapshot,
  ThreadSummary,
  ThreadTurn
} from '../../shared/types'
import { CodexAppServer } from '../codex/CodexAppServer'
import { findCodexExecutable } from '../codex/findCodex'
import { DEFAULT_SETTINGS, JsonStore, type PersistedState } from '../store'
import { classifyLimit, getPrimaryLimits, sameUnfinishedTurn, shouldQueueTurn } from './logic'
import { ClaudeCode } from '../providers/ClaudeCode'
import { claudeTurn } from '../providers/claudeState'
import { findExecutable } from '../providers/executable'
import { lowestEffort, QuotaWake } from './QuotaWake'

interface ThreadListResult {
  data: ThreadSummary[]
  nextCursor?: string | null
}

interface TurnListResult {
  data: ThreadTurn[]
}

type LoginItemSetter = (enabled: boolean) => Promise<void> | void
type NotificationSender = (title: string, body: string) => void

export class RelayEngine extends EventEmitter {
  private state: PersistedState = { settings: structuredClone(DEFAULT_SETTINGS), queue: [], events: [], dispatched: [], wakePlans: {}, wakeReceipts: [] }
  private wake = new QuotaWake()
  private models: WakeModel[] = []
  private client: CodexAppServer | null = null
  private connection: ConnectionState = 'disconnected'
  private connectionMessage = '尚未连接'
  private codexPath = ''
  private codexInstalled = false
  private quota: RateLimitResponse | null = null
  private threads: ThreadSummary[] = []
  private lastCheckedAt: number | null = null
  private interval: NodeJS.Timeout | null = null
  private ticking = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private sending = new Set<string>()

  constructor(
    private readonly store: JsonStore,
    private readonly setLoginItem: LoginItemSetter,
    private readonly notifyUser: NotificationSender,
    private readonly claude: ClaudeCode,
    private readonly wakeDirectory = path.join(os.homedir(), '.hrrrwork', 'wake')
  ) {
    super()
    this.claude.on('run-ended', (_sessionId: string, success: boolean) => {
      this.addEvent(success ? 'success' : 'warning', success ? 'Claude Code 接力轮次已结束。' : 'Claude Code 本轮需要检查，请打开原会话查看权限或错误。')
    })
    this.claude.on('wake-ended', (sessionId: string, success: boolean) => {
      if (this.wake.complete(this.state, 'claude-code', `claude:${sessionId}`, success)) this.addEvent(success ? 'success' : 'warning', this.state.wakePlans['claude-code']!.message)
    })
  }

  async start(): Promise<void> {
    this.state = await this.store.load()
    if (this.state.settings.startAtLogin) await this.setLoginItem(true)
    await this.claude.refresh(this.state.settings.claudePath)
    await this.connect()
    this.resetInterval()
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    await this.client?.stop()
    this.claude.stop()
  }

  snapshot(): RelaySnapshot {
    return {
      providers: [{
        id: 'codex', name: 'Codex', installed: this.codexInstalled,
        connected: this.connection === 'connected', message: this.connectionMessage,
        executable: this.codexPath, quota: this.quota, lastCheckedAt: this.lastCheckedAt, models: this.models
      }, this.claude.snapshot()],
      connection: this.connection,
      connectionMessage: this.connectionMessage,
      codexPath: this.codexPath,
      quota: this.quota,
      threads: structuredClone(this.threads),
      queue: structuredClone(this.state.queue),
      events: structuredClone(this.state.events),
      settings: structuredClone(this.state.settings),
      wakePlans: structuredClone(this.state.wakePlans),
      lastCheckedAt: this.lastCheckedAt
    }
  }

  async refresh(): Promise<RelaySnapshot> {
    await this.tick(true)
    return this.snapshot()
  }

  async connectClaude(): Promise<RelaySnapshot> {
    await this.claude.refresh(this.state.settings.claudePath)
    await this.claude.connect()
    this.addEvent('success', 'Claude Code 已连接；下一轮会话将同步额度与接力状态。')
    await this.tick(true)
    return this.snapshot()
  }

  async disconnectClaude(): Promise<RelaySnapshot> {
    await this.claude.disconnect()
    this.state.queue = this.state.queue.filter(item => item.provider !== 'claude-code')
    this.addEvent('info', 'Claude Code 已断开，原状态栏已恢复。')
    await this.store.set(this.state)
    this.emitState()
    return this.snapshot()
  }

  async updateSettings(patch: Partial<RelaySettings>): Promise<RelaySnapshot> {
    const previousPath = this.state.settings.codexPath
    const safePatch: Partial<RelaySettings> = { ...patch }
    if (safePatch.graceSeconds !== undefined) {
      safePatch.graceSeconds = Math.max(15, Math.min(600, Math.round(safePatch.graceSeconds)))
    }
    if (safePatch.pollIntervalSeconds !== undefined) {
      safePatch.pollIntervalSeconds = Math.max(20, Math.min(300, Math.round(safePatch.pollIntervalSeconds)))
    }
    if (safePatch.continuePrompt !== undefined) {
      safePatch.continuePrompt = safePatch.continuePrompt.trim().slice(0, 500) || 'continue'
    }
    if (patch.quotaWake) {
      safePatch.quotaWake = structuredClone(this.state.settings.quotaWake)
      for (const id of ['codex', 'claude-code'] as ProviderId[]) {
        const change = patch.quotaWake[id]
        if (!change) continue
        safePatch.quotaWake[id] = {
          enabled: change.enabled === true,
          target: change.target === 'existing' ? 'existing' : 'new',
          threadId: typeof change.threadId === 'string' ? change.threadId.slice(0, 200) : '',
          model: typeof change.model === 'string' ? change.model.trim().slice(0, 160) || 'auto' : 'auto'
        }
      }
    }
    this.state.settings = { ...this.state.settings, ...safePatch }
    await this.store.set(this.state)
    if (patch.startAtLogin !== undefined) await this.setLoginItem(patch.startAtLogin)
    if (patch.pollIntervalSeconds !== undefined) this.resetInterval()
    if (patch.codexPath !== undefined && patch.codexPath !== previousPath) await this.reconnect()
    if (patch.claudePath !== undefined) await this.claude.refresh(patch.claudePath)
    if (patch.quotaWake) await this.tick(true)
    this.emitState()
    return this.snapshot()
  }

  async toggleWatch(threadId: string): Promise<RelaySnapshot> {
    const watched = new Set(this.state.settings.watchedThreadIds)
    if (watched.has(threadId)) watched.delete(threadId)
    else watched.add(threadId)
    this.state.settings.watchedThreadIds = [...watched]
    await this.store.set(this.state)
    this.emitState()
    return this.snapshot()
  }

  async sendNow(queueId: string): Promise<RelaySnapshot> {
    const item = this.state.queue.find((candidate) => candidate.id === queueId)
    if (item) await this.resumeItem(item, true)
    return this.snapshot()
  }

  private async connect(): Promise<void> {
    this.connection = 'connecting'
    this.connectionMessage = '正在连接 Codex…'
    this.emitState()
    try {
      this.codexPath = await findCodexExecutable(this.state.settings.codexPath)
      this.codexInstalled = Boolean(await findExecutable('codex', this.codexPath))
      this.client = new CodexAppServer(this.codexPath)
      this.client.on('disconnect', (error: Error) => {
        this.connection = 'error'
        this.connectionMessage = error.message
        this.emitState()
        this.scheduleReconnect()
      })
      this.client.on('notification', (method: string, params: unknown) => {
        if (method === 'account/rateLimits/updated') {
          const update = params as RateLimitResponse
          if (update?.rateLimits) this.quota = { ...this.quota, ...update }
          this.emitState()
        }
        if (method === 'turn/completed') {
          const result = params as { threadId?: string; turn?: { id?: string; status?: string } }
          if (result.threadId && this.wake.complete(this.state, 'codex', result.threadId, result.turn?.status === 'completed', result.turn?.id)) this.addEvent(result.turn?.status === 'completed' ? 'success' : 'warning', this.state.wakePlans.codex!.message)
        }
      })
      await this.client.start()
      this.connection = 'connected'
      this.connectionMessage = 'Codex 已连接'
      await this.loadModels()
      this.addEvent('success', '已连接 Codex，开始巡夜。')
      await this.tick(true)
    } catch (error) {
      this.connection = 'error'
      this.connectionMessage = error instanceof Error ? error.message : String(error)
      this.addEvent('error', `连接失败：${this.connectionMessage}`)
      this.scheduleReconnect()
    }
    this.emitState()
  }

  private async reconnect(): Promise<void> {
    await this.client?.stop()
    this.client = null
    await this.connect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect()
    }, 15_000)
  }

  private resetInterval(): void {
    if (this.interval) clearInterval(this.interval)
    this.interval = setInterval(
      () => void this.tick(),
      this.state.settings.pollIntervalSeconds * 1000
    )
  }

  private async tick(force = false): Promise<void> {
    if (this.ticking) return
    if (!force && !this.state.settings.enabled && !Object.values(this.state.settings.quotaWake).some(setting => setting.enabled)) return
    this.ticking = true
    try {
      await this.claude.refresh(this.state.settings.claudePath)
      let codexThreads = this.threads.filter(thread => thread.provider !== 'claude-code')
      if (this.client && this.connection === 'connected') {
        try {
          const [quota, threadResult] = await Promise.all([
            this.client.call<RateLimitResponse>('account/rateLimits/read'),
            this.client.call<ThreadListResult>('thread/list', {
              limit: 30, sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['vscode', 'cli', 'appServer']
            })
          ])
          this.quota = quota
          codexThreads = (threadResult.data ?? []).map(thread => ({ ...thread, provider: 'codex' }))
        } catch (error) {
          this.connectionMessage = error instanceof Error ? error.message : String(error)
        }
      }
      this.threads = dedupeThreads([...codexThreads, ...this.claude.threads()])
      this.lastCheckedAt = Date.now()
      const relayProviders = new Set<ProviderId>()
      if (this.state.settings.enabled) {
        await this.detectInterruptedTurns()
        for (const item of this.state.queue) relayProviders.add(item.provider ?? 'codex')
        await this.processDueQueue()
      }
      await this.processQuotaWake(relayProviders)
    } catch (error) {
      this.connectionMessage = error instanceof Error ? error.message : String(error)
      this.addEvent('warning', `本轮检查未完成：${this.connectionMessage}`)
    } finally {
      this.ticking = false
      this.emitState()
    }
  }

  private async loadModels(): Promise<void> {
    this.models = []
    if (!this.client) return
    try {
      let cursor: string | undefined
      for (let page = 0; page < 5; page++) {
        const result = await this.client.call<{ data: { model: string; displayName: string; supportedReasoningEfforts?: { reasoningEffort: string }[] }[]; nextCursor?: string | null }>('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
        this.models.push(...result.data.map(model => ({ id: model.model, name: model.displayName, efforts: model.supportedReasoningEfforts?.map(option => option.reasoningEffort) })))
        if (!result.nextCursor) break
        cursor = result.nextCursor
      }
    } catch { /* An unavailable catalog must not block normal interrupted-task relay. */ }
  }

  private async processQuotaWake(relayProviders: Set<ProviderId>): Promise<void> {
    for (const provider of this.snapshot().providers) {
      const active = this.threads.some(thread => (thread.provider ?? 'codex') === provider.id && ['active', 'inProgress'].includes(thread.status?.type ?? ''))
      await this.wake.check({
        id: provider.id, connected: provider.connected, quota: provider.quota, models: provider.models ?? [],
        busy: active || relayProviders.has(provider.id) || (provider.id === 'claude-code' && this.claude.hasActiveWork()),
        send: (settings, model) => this.sendQuotaWake(provider.id, settings, model)
      }, this.state, () => this.store.set(this.state), (message, success) => this.addEvent(success ? 'info' : 'warning', message))
    }
  }

  private async sendQuotaWake(provider: ProviderId, settings: QuotaWakeSettings, model: WakeModel): Promise<{ threadId: string; turnId?: string }> {
    if (!this.state.settings.quotaWake[provider].enabled) throw new Error('额度唤醒已关闭。')
    if (provider === 'claude-code') {
      if (settings.target === 'existing' && !settings.threadId.startsWith('claude:')) throw new Error('请选择 Claude Code 对话。')
      return this.claude.wake(settings.target === 'existing' ? settings.threadId.slice(7) : null, model.id, this.wakeDirectory, async threadId => {
        const plan = this.state.wakePlans['claude-code']
        if (plan) { plan.threadId = threadId; await this.store.set(this.state) }
      })
    }
    if (!this.client || this.connection !== 'connected') throw new Error('Codex 未连接。')
    this.quota = await this.client.call<RateLimitResponse>('account/rateLimits/read')
    if (!getPrimaryLimits(this.quota)?.primary) throw new Error('无法确认额度状态，未发送唤醒。')
    if (classifyLimit(this.quota).reached) throw new Error('额度尚未恢复可用。')
    let threadId: string
    if (settings.target === 'existing') {
      if (settings.threadId.startsWith('claude:')) throw new Error('请选择 Codex 对话。')
      const latest = await this.latestTurn(settings.threadId)
      if (latest && latest.status !== 'completed') throw new Error('指定对话不是空闲状态，未发送唤醒。')
      await this.client.call('thread/resume', { threadId: settings.threadId, excludeTurns: true })
      threadId = settings.threadId
    } else {
      await fs.mkdir(this.wakeDirectory, { recursive: true })
      const result = await this.client.call<{ thread: { id: string }; model?: string }>('thread/start', {
        model: model.id, serviceTier: 'default', allowProviderModelFallback: false, cwd: this.wakeDirectory, sandbox: 'read-only', approvalPolicy: 'untrusted',
        baseInstructions: '这是一轮简短的额度唤醒。只回复「收到」。不要调用工具、读取文件、执行命令或开展其他工作。'
      })
      if (result.model && result.model !== model.id) throw new Error('客户端切换了所选模型，未发送唤醒。')
      threadId = result.thread.id
    }
    const plan = this.state.wakePlans.codex
    if (plan) { plan.threadId = threadId; await this.store.set(this.state) }
    const result = await this.client.call<{ turn: { id: string } }>('turn/start', {
      threadId, model: model.id, serviceTierForTurn: 'default', ...(lowestEffort(model) ? { effort: lowestEffort(model) } : {}),
      input: [{ type: 'text', text: WAKE_PROMPT }]
    })
    return { threadId, turnId: result.turn.id }
  }

  private async detectInterruptedTurns(): Promise<void> {
    const watched = new Set(this.state.settings.watchedThreadIds)
    const latestByProvider = new Map<string, string>()
    for (const thread of this.threads) if (!latestByProvider.has(thread.provider ?? 'codex')) latestByProvider.set(thread.provider ?? 'codex', thread.id)
    const candidates = this.threads.filter(
      (thread) => watched.has(thread.id) || (this.state.settings.autoWatchRecent && thread.id === latestByProvider.get(thread.provider ?? 'codex'))
    )

    const turns = await Promise.allSettled(
      candidates.map(async (thread) => ({ thread, turn: await this.latestTurn(thread.id) }))
    )

    for (const result of turns) {
      if (result.status !== 'fulfilled') continue
      const { thread, turn } = result.value
      if (!turn) continue
      const claudeSession = thread.provider === 'claude-code' ? this.claude.sessions.get(thread.id.slice(7)) : null
      const limit = classifyLimit(claudeSession ? claudeSession.quota : this.quota)
      if (!limit.reached || !limit.resetAt) continue
      if (claudeSession && (!this.claude.snapshot().connected || claudeSession.status !== 'rate-limited')) continue
      // A new failure after the old reset needs a fresh window, not repeated attempts against stale data.
      if (claudeSession?.failedAt && limit.resetAt * 1000 <= claudeSession.failedAt) continue
      const explicitlyWatched = watched.has(thread.id)
      if (!shouldQueueTurn(turn, { explicitlyWatched, newestRecent: thread.id === latestByProvider.get(thread.provider ?? 'codex') })) continue
      if (this.state.dispatched.includes(`${thread.id}:${turn.id}`)) continue
      if (this.state.queue.some((item) => item.threadId === thread.id && item.turnId === turn.id)) continue

      const item: RelayQueueItem = {
        provider: thread.provider ?? 'codex',
        id: `${thread.id}:${turn.id}`,
        threadId: thread.id,
        threadName: thread.name || thread.preview || '未命名任务',
        turnId: turn.id,
        detectedAt: Date.now(),
        scheduledFor: limit.resetAt * 1000 + this.state.settings.graceSeconds * 1000,
        reason: limit.reason,
        status: 'waiting'
      }
      this.state.queue.push(item)
      this.addEvent('warning', `发现额度中断，已接住「${shortName(item.threadName)}」。`, thread.id)
      this.notifyUser('Hrrrwork 接住任务了 🌙', '额度刷新后会自动发送 continue。')
    }
    await this.store.set(this.state)
  }

  private async processDueQueue(): Promise<void> {
    const due = this.state.queue.filter((item) => item.scheduledFor <= Date.now())
    for (const item of due) await this.resumeItem(item, false)
  }

  private async resumeItem(item: RelayQueueItem, manual: boolean): Promise<void> {
    if (this.sending.has(item.id)) return
    if (item.provider === 'claude-code') {
      await this.resumeClaude(item)
      return
    }
    if (!this.client) return
    this.sending.add(item.id)
    item.status = 'sending'
    this.emitState()

    try {
      if (!manual) {
        this.quota = await this.client.call<RateLimitResponse>('account/rateLimits/read')
        const limit = classifyLimit(this.quota)
        if (limit.reached) {
          item.status = 'waiting'
          item.scheduledFor = (limit.resetAt ?? Math.floor(Date.now() / 1000 + 300)) * 1000
            + this.state.settings.graceSeconds * 1000
          this.addEvent('info', '额度仍未释放，已顺延下一次接力。', item.threadId)
          await this.store.set(this.state)
          return
        }
      }

      const latest = await this.latestTurn(item.threadId)
      if (!sameUnfinishedTurn(item.turnId, latest)) {
        this.removeQueueItem(item.id)
        this.addEvent('info', `「${shortName(item.threadName)}」已有新进展，取消重复接力。`, item.threadId)
        await this.store.set(this.state)
        return
      }

      await this.client.call('thread/resume', { threadId: item.threadId })
      await this.client.call('turn/start', {
        threadId: item.threadId,
        input: [{ type: 'text', text: this.state.settings.continuePrompt }]
      })
      this.removeQueueItem(item.id)
      this.addEvent('success', `接力成功：已向「${shortName(item.threadName)}」发送 ${this.state.settings.continuePrompt}。`, item.threadId)
      this.notifyUser('Hrrrwork 已完成接力 ✨', `「${shortName(item.threadName)}」已继续工作。`)
      await this.store.set(this.state)
    } catch (error) {
      item.status = 'waiting'
      item.scheduledFor = Date.now() + 2 * 60 * 1000
      this.addEvent('error', `接力失败，将重试：${error instanceof Error ? error.message : String(error)}`, item.threadId)
      await this.store.set(this.state)
    } finally {
      this.sending.delete(item.id)
      this.emitState()
    }
  }

  private async latestTurn(threadId: string): Promise<ThreadTurn | null> {
    if (threadId.startsWith('claude:')) {
      const session = this.claude.sessions.get(threadId.slice(7))
      return session ? claudeTurn(session) : null
    }
    if (!this.client) return null
    const result = await this.client.call<TurnListResult>('thread/turns/list', {
      threadId,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'notLoaded'
    })
    return result.data?.[0] ?? null
  }

  private async resumeClaude(item: RelayQueueItem): Promise<void> {
    this.sending.add(item.id)
    try {
      await this.claude.refresh(this.state.settings.claudePath)
      const session = this.claude.sessions.get(item.threadId.slice(7))
      if (!session || !sameUnfinishedTurn(item.turnId, claudeTurn(session))) {
        this.removeQueueItem(item.id)
        this.addEvent('info', 'Claude Code 会话已有变化，已取消重复接力。', item.threadId)
        return
      }
      const limit = classifyLimit(session.quota)
      if (!limit.resetAt || limit.resetAt * 1000 + this.state.settings.graceSeconds * 1000 > Date.now()) {
        item.scheduledFor = limit.resetAt ? limit.resetAt * 1000 + this.state.settings.graceSeconds * 1000 : Date.now() + 300000
        return
      }
      // Persist the dispatch before starting work. An uncertain result must never be blindly replayed.
      this.removeQueueItem(item.id)
      this.state.dispatched = [...this.state.dispatched, item.id].slice(-200)
      await this.store.set(this.state)
      await this.claude.resume(session.sessionId, this.state.settings.continuePrompt)
      this.addEvent('success', `Claude Code 已接力「${shortName(item.threadName)}」。`, item.threadId)
    } catch (error) {
      this.removeQueueItem(item.id)
      this.addEvent('warning', `Claude Code 接力需要检查：${error instanceof Error ? error.message : String(error)}`, item.threadId)
    } finally {
      this.sending.delete(item.id)
      await this.store.set(this.state)
      this.emitState()
    }
  }

  private removeQueueItem(id: string): void {
    this.state.queue = this.state.queue.filter((item) => item.id !== id)
  }

  private addEvent(kind: RelayEvent['kind'], message: string, threadId?: string): void {
    this.state.events.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      kind,
      message,
      threadId
    })
    this.state.events = this.state.events.slice(0, 80)
    void this.store.set(this.state).catch(error => console.warn('Could not persist relay event:', error))
    this.emitState()
  }

  private emitState(): void {
    this.emit('state', this.snapshot())
  }
}

function dedupeThreads(threads: ThreadSummary[]): ThreadSummary[] {
  const byId = new Map<string, ThreadSummary>()
  for (const thread of threads) {
    const existing = byId.get(thread.id)
    if (!existing || thread.updatedAt > existing.updatedAt) byId.set(thread.id, thread)
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

function shortName(name: string): string {
  return name.length > 28 ? `${name.slice(0, 28)}…` : name
}
