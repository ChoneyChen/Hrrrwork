import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { QuotaWindow } from '../../shared/types'
import { QuotaCard, remainingQuota } from './QuotaCard'
import { classifyLimit } from '../../main/relay/logic'

const quota = (usedPercent: number): QuotaWindow => ({ usedPercent, windowDurationMins: 300, resetsAt: 1_800_000_000 })

describe('remaining quota presentation', () => {
  it.each([[32, 68], [34, 66], [0, 100], [100, 0], [-5, 100], [110, 0]])('converts %s%% used to %s%% remaining', (used, remaining) => {
    const window = quota(used)
    const markup = renderToStaticMarkup(<QuotaCard title="5 小时额度" window={window} accent="coral" />)
    expect(remainingQuota(window)).toBe(remaining)
    expect(markup).toContain(`<small>剩余</small>${remaining}%`)
    expect(markup).toContain(`aria-valuenow="${remaining}"`)
    expect(markup).toContain(`width:${remaining}%`)
    expect(window.usedPercent).toBe(used)
  })
  it.each([null, undefined, { ...quota(0), usageKnown: false }, quota(NaN), quota(Infinity)])('keeps unknown usage unknown rather than showing a full allowance', window => {
    const markup = renderToStaticMarkup(<QuotaCard title="每周额度" window={window} accent="blue" />)
    expect(remainingQuota(window)).toBeNull()
    expect(markup).toContain('<small>剩余</small>—')
    expect(markup).not.toContain('aria-valuenow=')
    expect(markup).toContain('用量尚未同步')
  })
  it('shows a truly empty bar only when exhausted', () => {
    const exhausted = renderToStaticMarkup(<QuotaCard title="5 小时额度" window={quota(100)} accent="coral" />)
    expect(exhausted).toContain('额度已用尽，等待刷新')
    const nearlyExhausted = renderToStaticMarkup(<QuotaCard title="5 小时额度" window={quota(99.8)} accent="coral" />)
    expect(nearlyExhausted).toContain('<small>剩余</small>&lt;1%')
    expect(nearlyExhausted).toContain('余量不多')
    expect(nearlyExhausted).not.toContain('已用尽')
  })
  it('does not invert the internal exhaustion and relay condition', () => {
    for (const used of [0, 32, 34, 99.8, 100]) {
      const window = quota(used)
      remainingQuota(window)
      expect(classifyLimit({ rateLimits: { limitId: 'codex', primary: window } }, 1_799_999_000).reached).toBe(used >= 100)
    }
  })
})
