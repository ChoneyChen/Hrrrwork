import { describe, expect, it } from 'vitest'
import type { RateLimitResponse, ThreadTurn } from '../../shared/types'
import { classifyLimit, sameUnfinishedTurn, shouldQueueTurn } from './logic'

const now = 1_800_000_000

describe('classifyLimit', () => {
  it('recognizes the five-hour window', () => {
    const response: RateLimitResponse = {
      ordinaryUsageAllowed: false,
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now + 300 },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: now + 5000 }
      }
    }
    expect(classifyLimit(response, now)).toEqual({
      reached: true,
      resetAt: now + 300,
      reason: 'five-hour'
    })
  })

  it('prefers the weekly reset when the secondary window is exhausted', () => {
    const response: RateLimitResponse = {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now + 300 },
        secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: now + 5000 }
      }
    }
    expect(classifyLimit(response, now).reason).toBe('weekly')
    expect(classifyLimit(response, now).resetAt).toBe(now + 5000)
  })

  it('does not treat high-but-available usage as exhausted', () => {
    const response: RateLimitResponse = {
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: now + 300 }
      }
    }
    expect(classifyLimit(response, now).reached).toBe(false)
  })
})

describe('turn safety checks', () => {
  const interrupted: ThreadTurn = {
    id: 'turn-1',
    status: 'interrupted',
    startedAt: now - 60,
    error: null
  }

  it('queues an explicitly watched interrupted turn', () => {
    expect(shouldQueueTurn(interrupted, { explicitlyWatched: true, newestRecent: false, nowSeconds: now })).toBe(true)
  })

  it('does not queue an old unselected interruption', () => {
    expect(shouldQueueTurn(
      { ...interrupted, startedAt: now - 7200 },
      { explicitlyWatched: false, newestRecent: true, nowSeconds: now }
    )).toBe(false)
  })

  it('cancels when another turn has appeared', () => {
    expect(sameUnfinishedTurn('turn-1', { ...interrupted, id: 'turn-2' })).toBe(false)
    expect(sameUnfinishedTurn('turn-1', interrupted)).toBe(true)
  })
})
