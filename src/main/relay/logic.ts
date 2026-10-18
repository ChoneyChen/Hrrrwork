import type { RateLimitResponse, RateLimits, ThreadTurn } from '../../shared/types'

export interface LimitState {
  reached: boolean
  resetAt: number | null
  reason: 'five-hour' | 'weekly' | 'usage-limit'
}

const QUOTA_ERROR_PATTERN = /(usage|rate)[ _-]?limit|quota|额度|用量限制|too many requests|insufficient_quota/i

export function getPrimaryLimits(response: RateLimitResponse | null): RateLimits | null {
  if (!response) return null
  if (response.rateLimitsByLimitId?.codex) return response.rateLimitsByLimitId.codex
  if (response.rateLimits) return response.rateLimits
  const first = response.rateLimitsByLimitId
    ? Object.values(response.rateLimitsByLimitId)[0]
    : undefined
  return first ?? null
}

export function classifyLimit(response: RateLimitResponse | null, nowSeconds = Date.now() / 1000): LimitState {
  const limits = getPrimaryLimits(response)
  if (!limits) return { reached: false, resetAt: null, reason: 'usage-limit' }

  const primaryReached = (limits.primary?.usedPercent ?? 0) >= 99.9
  const secondaryReached = (limits.secondary?.usedPercent ?? 0) >= 99.9
  const type = limits.rateLimitReachedType?.toLowerCase() ?? ''
  const explicitlyReached = Boolean(type) || response?.ordinaryUsageAllowed === false || limits.spendControlReached === true
  const reached = primaryReached || secondaryReached || explicitlyReached

  if (!reached) return { reached: false, resetAt: null, reason: 'usage-limit' }

  let reason: LimitState['reason'] = 'usage-limit'
  let resetAt: number | null = null

  if (secondaryReached || /secondary|week/.test(type)) {
    reason = 'weekly'
    resetAt = limits.secondary?.resetsAt ?? null
  } else if (primaryReached || /primary|five|5h/.test(type)) {
    reason = 'five-hour'
    resetAt = limits.primary?.resetsAt ?? null
  }

  if (!resetAt) {
    const futureWindows = [limits.primary, limits.secondary]
      .filter((window) => window && window.resetsAt > nowSeconds)
      .map((window) => window!.resetsAt)
    resetAt = futureWindows.length ? Math.min(...futureWindows) : Math.floor(nowSeconds + 300)
  }

  return { reached, resetAt, reason }
}

export function isInterruptedTurn(turn: ThreadTurn | null): boolean {
  return turn?.status === 'interrupted' || turn?.status === 'failed'
}

export function hasQuotaError(turn: ThreadTurn): boolean {
  if (!turn.error) return false
  try {
    return QUOTA_ERROR_PATTERN.test(JSON.stringify(turn.error))
  } catch {
    return false
  }
}

export function shouldQueueTurn(
  turn: ThreadTurn | null,
  options: { explicitlyWatched: boolean; newestRecent: boolean; nowSeconds?: number }
): boolean {
  if (!turn || !isInterruptedTurn(turn)) return false
  if (hasQuotaError(turn)) return true
  if (options.explicitlyWatched) return true

  const now = options.nowSeconds ?? Date.now() / 1000
  const startedAt = turn.startedAt ?? 0
  const recent = startedAt > 0 && now - startedAt <= 30 * 60
  return options.newestRecent && recent
}

export function sameUnfinishedTurn(expectedTurnId: string, latest: ThreadTurn | null): boolean {
  return Boolean(latest && latest.id === expectedTurnId && isInterruptedTurn(latest))
}
