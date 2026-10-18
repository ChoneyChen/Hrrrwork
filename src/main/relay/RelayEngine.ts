import { EventEmitter } from 'node:events'
import type {
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
import { JsonStore, type PersistedState } from '../store'
import { classifyLimit, sameUnfinishedTurn, shouldQueueTurn } from './logic'

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
  private state: PersistedState = { settings: {} as RelaySettings, queue: [], events: [] }
  private client: CodexAppServer | null = null
  private connection: ConnectionState = 'disconnected'
  private connectionMessage = '尚未连接'
  private codexPath = ''
  private quota: RateLimitResponse | null = null
  private threads: ThreadSummary[] = []
  private lastCheckedAt: number | null = null
  private interval: NodeJS.Timeout | null = null
  private ticking = false
  private reconnectTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: JsonStore,
    private readonly setLoginItem: LoginItemSetter,
    private readonly notifyUser: NotificationSender
  ) {
    super()
  }

  async start(): Promise<void> {
    this.state = await this.store.load()
    if (this.state.settings.startAtLogin) await this.setLoginItem(true)
    await this.connect()
    this.resetInterval()
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    await this.client?.stop()
  }

  snapshot(): RelaySnapshot {
    return {
      connection: this.connection,
      connectionMessage: this.connectionMessage,
      codexPath: this.codexPath,
      quota: this.quota,
      threads: structuredClone(this.threads),
      queue: structuredClone(this.state.queue),
      events: structuredClone(this.state.events),
      settings: structuredClone(this.state.settings),
      lastCheckedAt: this.lastCheckedAt
    }
  }

  async refresh(): Promise<RelaySnapshot> {
    await this.tick(true)
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
    this.state.settings = { ...this.state.settings, ...safePatch }
    await this.store.set(this.state)
    if (patch.startAtLogin !== undefined) await this.setLoginItem(patch.startAtLogin)
    if (patch.pollIntervalSeconds !== undefined) this.resetInterval()
    if (patch.codexPath !== undefined && patch.codexPath !== previousPath) await this.reconnect()
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
      })
      await this.client.start()
      this.connection = 'connected'
      this.connectionMessage = 'Codex 已连接'
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
    if (this.ticking || !this.client || this.connection !== 'connected') return
    if (!force && !this.state.settings.enabled) return
    this.ticking = true
    try {
      const [quota, threadResult] = await Promise.all([
        this.client.call<RateLimitResponse>('account/rateLimits/read'),
        this.client.call<ThreadListResult>('thread/list', {
          limit: 30,
          sortKey: 'updated_at',
          sortDirection: 'desc',
          sourceKinds: ['vscode', 'cli']
        })
      ])
      this.quota = quota
      this.threads = dedupeThreads(threadResult.data ?? [])
      this.lastCheckedAt = Date.now()
      if (this.state.settings.enabled) {
        await this.detectInterruptedTurns()
        await this.processDueQueue()
      }
      this.connectionMessage = 'Codex 已连接'
    } catch (error) {
      this.connectionMessage = error instanceof Error ? error.message : String(error)
      this.addEvent('warning', `本轮检查未完成：${this.connectionMessage}`)
    } finally {
      this.ticking = false
      this.emitState()
    }
  }

  private async detectInterruptedTurns(): Promise<void> {
    const limit = classifyLimit(this.quota)
    if (!limit.reached || !limit.resetAt || this.threads.length === 0) return

    const watched = new Set(this.state.settings.watchedThreadIds)
    const newest = this.threads[0]
    const candidates = this.threads.filter(
      (thread) => watched.has(thread.id) || (this.state.settings.autoWatchRecent && thread.id === newest.id)
    )

    const turns = await Promise.all(
      candidates.map(async (thread) => ({ thread, turn: await this.latestTurn(thread.id) }))
    )

    for (const { thread, turn } of turns) {
      if (!turn) continue
      const explicitlyWatched = watched.has(thread.id)
      if (!shouldQueueTurn(turn, { explicitlyWatched, newestRecent: thread.id === newest.id })) continue
      if (this.state.queue.some((item) => item.threadId === thread.id && item.turnId === turn.id)) continue

      const item: RelayQueueItem = {
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
      this.notifyUser('SleepRelay 接住任务了 🌙', '额度刷新后会自动发送 continue。')
    }
    await this.store.set(this.state)
  }

  private async processDueQueue(): Promise<void> {
    const due = this.state.queue.filter((item) => item.scheduledFor <= Date.now())
    for (const item of due) await this.resumeItem(item, false)
  }

  private async resumeItem(item: RelayQueueItem, manual: boolean): Promise<void> {
    if (!this.client) return
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
      if (!manual && !sameUnfinishedTurn(item.turnId, latest)) {
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
      this.notifyUser('SleepRelay 已完成接力 ✨', `「${shortName(item.threadName)}」已继续工作。`)
      await this.store.set(this.state)
    } catch (error) {
      item.status = 'waiting'
      item.scheduledFor = Date.now() + 2 * 60 * 1000
      this.addEvent('error', `接力失败，将重试：${error instanceof Error ? error.message : String(error)}`, item.threadId)
      await this.store.set(this.state)
    } finally {
      this.emitState()
    }
  }

  private async latestTurn(threadId: string): Promise<ThreadTurn | null> {
    if (!this.client) return null
    const result = await this.client.call<TurnListResult>('thread/turns/list', {
      threadId,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'notLoaded'
    })
    return result.data?.[0] ?? null
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
    void this.store.set(this.state)
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
