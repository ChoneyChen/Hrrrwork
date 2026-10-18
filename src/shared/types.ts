export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface QuotaWindow {
  usedPercent: number
  windowDurationMins: number
  resetsAt: number
}

export interface RateLimits {
  limitId: string
  limitName?: string | null
  primary?: QuotaWindow | null
  secondary?: QuotaWindow | null
  rateLimitReachedType?: string | null
  spendControlReached?: boolean
  planType?: string | null
}

export interface RateLimitResponse {
  ordinaryUsageAllowed?: boolean
  rateLimits?: RateLimits | null
  rateLimitsByLimitId?: Record<string, RateLimits>
}

export interface ThreadSummary {
  id: string
  name?: string | null
  preview?: string | null
  source?: string | null
  cwd?: string | null
  createdAt: number
  updatedAt: number
  status?: { type: string } | null
}

export interface ThreadTurn {
  id: string
  rootTurnId?: string
  status: string
  error?: unknown
  startedAt?: number | null
  completedAt?: number | null
}

export interface RelayQueueItem {
  id: string
  threadId: string
  threadName: string
  turnId: string
  detectedAt: number
  scheduledFor: number
  reason: 'five-hour' | 'weekly' | 'usage-limit'
  status: 'waiting' | 'sending'
}

export interface RelayEvent {
  id: string
  at: number
  kind: 'info' | 'success' | 'warning' | 'error'
  message: string
  threadId?: string
}

export interface RelaySettings {
  enabled: boolean
  autoWatchRecent: boolean
  continuePrompt: string
  graceSeconds: number
  pollIntervalSeconds: number
  startAtLogin: boolean
  watchedThreadIds: string[]
  codexPath: string
}

export interface RelaySnapshot {
  connection: ConnectionState
  connectionMessage: string
  codexPath: string
  quota: RateLimitResponse | null
  threads: ThreadSummary[]
  queue: RelayQueueItem[]
  events: RelayEvent[]
  settings: RelaySettings
  lastCheckedAt: number | null
}

export interface HrrrworkApi {
  getSnapshot: () => Promise<RelaySnapshot>
  refresh: () => Promise<RelaySnapshot>
  updateSettings: (patch: Partial<RelaySettings>) => Promise<RelaySnapshot>
  toggleWatch: (threadId: string) => Promise<RelaySnapshot>
  sendNow: (queueId: string) => Promise<RelaySnapshot>
  revealLogs: () => Promise<void>
  onSnapshot: (listener: (snapshot: RelaySnapshot) => void) => () => void
}
