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
}

export function parseClaudeQuota(raw: unknown): RateLimitResponse | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  function parse(value: unknown, minutes: number): QuotaWindow | null {
    if (!value || typeof value !== 'object') return null
    const window = value as Record<string, unknown>
    if (typeof window.used_percentage !== 'number' || !Number.isFinite(window.used_percentage)
      || typeof window.resets_at !== 'number' || !Number.isFinite(window.resets_at)) return null
    return { usedPercent: Math.max(0, window.used_percentage), resetsAt: window.resets_at, windowDurationMins: minutes }
  }
  const primary = parse(record.five_hour, 300)
  const secondary = parse(record.seven_day, 10080)
  if (!primary && !secondary) return null
  return { rateLimits: { limitId: 'claude-code', primary, secondary } }
}

export function claudeTurn(session: ClaudeSessionState): ThreadTurn {
  return {
    id: session.revision,
    status: session.status === 'rate-limited' ? 'failed' : session.status === 'active' ? 'inProgress' : 'completed',
    error: session.status === 'rate-limited' ? { code: 'rate_limit' } : null,
    startedAt: Math.floor(session.updatedAt / 1000)
  }
}
