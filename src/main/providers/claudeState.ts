import type { QuotaWindow, RateLimitResponse, ThreadTurn } from '../../shared/types'

export interface ClaudeSessionState {
  sessionId: string
  cwd: string
  name: string
  revision: string
  status: 'active' | 'idle' | 'rate-limited'
  updatedAt: number
  failedAt?: number | null
  quota: RateLimitResponse | null
  quotaUpdatedAt?: number
}

export function parseClaudeQuota(raw: unknown): RateLimitResponse | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  function parse(value: unknown, minutes: number): QuotaWindow | null {
    if (!value || typeof value !== 'object') return null
    const window = value as Record<string, unknown>
    if (typeof window.resets_at !== 'number' || !Number.isFinite(window.resets_at)) return null
    const known = typeof window.used_percentage === 'number' && Number.isFinite(window.used_percentage)
    if (!known && window.usage_known !== false) return null
    return { usedPercent: known ? Math.max(0, window.used_percentage as number) : window.exhausted === true ? 100 : 0, ...(known ? {} : { usageKnown: false }), resetsAt: window.resets_at, windowDurationMins: minutes }
  }
  const primary = parse(record.five_hour, 300)
  const secondary = parse(record.seven_day, 10080)
  if (!primary && !secondary) return null
  return { rateLimits: { limitId: 'claude-code', primary, secondary } }
}

// SDKRateLimitEvent uses camelCase timestamps and optional fractional utilization.
// Missing utilization is NOT treated as a reported 0% usage.
export function claudeStreamLimits(info: unknown): Record<string, unknown> | null {
  if (!info || typeof info !== 'object') return null
  const raw = info as Record<string, unknown>
  if (!['allowed', 'allowed_warning', 'rejected'].includes(String(raw.status))) return null
  if (!['five_hour', 'seven_day'].includes(String(raw.rateLimitType)) || typeof raw.resetsAt !== 'number' || !Number.isFinite(raw.resetsAt)) return null
  const known = typeof raw.utilization === 'number' && Number.isFinite(raw.utilization)
  return { [String(raw.rateLimitType)]: { resets_at: raw.resetsAt, used_percentage: known ? (raw.utilization as number) * 100 : null, usage_known: known, exhausted: raw.status === 'rejected' } }
}

export function claudeTurn(session: ClaudeSessionState): ThreadTurn {
  return {
    id: session.revision,
    status: session.status === 'rate-limited' ? 'failed' : session.status === 'active' ? 'inProgress' : 'completed',
    error: session.status === 'rate-limited' ? { code: 'rate_limit' } : null,
    startedAt: Math.floor(session.updatedAt / 1000)
  }
}
