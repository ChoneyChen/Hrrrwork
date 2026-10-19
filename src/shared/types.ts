export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'
export type ProviderId = 'codex' | 'claude-code'

export interface UpdateSettings { autoCheck: boolean; autoDownload: boolean }
export interface UpdateState {
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported'
  currentVersion: string
  latestVersion?: string
  message: string
  checkedAt?: number
  progress?: number
  downloadedBytes?: number
  totalBytes?: number
}

export interface WakeModel {
  id: string
  name: string
  efforts?: string[]
}

export interface QuotaWakeSettings {
  enabled: boolean
  target: 'new' | 'existing'
  threadId: string
  model: string
}

export interface WakePlan {
  resetAt: number
  scheduledFor: number
  status: 'waiting' | 'dispatching' | 'submitted' | 'completed' | 'skipped' | 'failed'
  message: string
  threadId?: string
  turnId?: string
  model?: string
  sentAt?: number
}

export const WAKE_PROMPT = '唤醒，仅需回复收到'
export const DEFAULT_QUOTA_WAKE: Record<ProviderId, QuotaWakeSettings> = {
  codex: { enabled: false, target: 'new', threadId: '', model: 'auto' },
  'claude-code': { enabled: false, target: 'new', threadId: '', model: 'auto' }
}

export interface ProviderSnapshot {
  id: ProviderId
  name: string
  installed: boolean
  connected: boolean
  message: string
  executable: string
  quota: RateLimitResponse | null
  lastCheckedAt: number | null
  models?: WakeModel[]
  discoverySource?: string
  dataDirectory?: string
}

export interface QuotaWindow {
  usedPercent: number
  usageKnown?: boolean
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
  provider?: ProviderId
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
  provider?: ProviderId
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
  claudePath: string
  quotaWake: Record<ProviderId, QuotaWakeSettings>
  updates: UpdateSettings
}

export interface RelaySnapshot {
  providers: ProviderSnapshot[]
  connection: ConnectionState
  connectionMessage: string
  codexPath: string
  quota: RateLimitResponse | null
  threads: ThreadSummary[]
  queue: RelayQueueItem[]
  events: RelayEvent[]
  settings: RelaySettings
  wakePlans: Partial<Record<ProviderId, WakePlan>>
  lastCheckedAt: number | null
}

export interface HrrrworkApi {
  getUpdateState: () => Promise<UpdateState>
  checkForUpdates: () => Promise<UpdateState>
  downloadUpdate: () => Promise<UpdateState>
  revealUpdate: () => Promise<void>
  onUpdateState: (listener: (state: UpdateState) => void) => () => void
  getSnapshot: () => Promise<RelaySnapshot>
  refresh: () => Promise<RelaySnapshot>
  updateSettings: (patch: Partial<RelaySettings>) => Promise<RelaySnapshot>
  toggleWatch: (threadId: string) => Promise<RelaySnapshot>
  sendNow: (queueId: string) => Promise<RelaySnapshot>
  revealLogs: () => Promise<void>
  connectClaude: () => Promise<RelaySnapshot>
  disconnectClaude: () => Promise<RelaySnapshot>
  onSnapshot: (listener: (snapshot: RelaySnapshot) => void) => () => void
}
