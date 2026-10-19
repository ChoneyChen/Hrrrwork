import { describe, expect, it, vi } from 'vitest'
import { QuotaWake, chooseWakeModel, lowestEffort, type WakeProvider } from './QuotaWake'
import { DEFAULT_SETTINGS, type PersistedState } from '../store'

const now = 1_800_000_000_000
function fixture() {
  const state: PersistedState = { settings: structuredClone(DEFAULT_SETTINGS), queue: [], events: [], dispatched: [], wakePlans: {}, wakeReceipts: [] }
  state.settings.quotaWake.codex.enabled = true
  const save = vi.fn(async () => {})
  const event = vi.fn()
  const send = vi.fn(async () => ({ threadId: 'wake-thread', turnId: 'wake-turn' }))
  const provider: WakeProvider = { id: 'codex', connected: true, busy: false, models: [{ id: 'gpt-6-luna', name: 'Luna', efforts: ['low', 'medium'] }], send,
    quota: { rateLimits: { limitId: 'codex', primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: now / 1000 + 300 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: now / 1000 + 10000 } } }
  }
  const wake = new QuotaWake()
  const check = (at = now) => wake.check(provider, state, save, event, at)
  return { state, save, event, send, provider, wake, check }
}

describe('quota wake scheduling', () => {
  it('waits for the optional first time and does not send before the official refresh', async () => {
    const f = fixture()
    Object.assign(f.state.settings.quotaWake.codex, { timing: 'daily', firstWakeAt: now + 600000 })
    await f.check(now + 300000)
    expect(f.state.wakePlans.codex?.scheduledFor).toBe(now + 600000)
    expect(f.send).not.toHaveBeenCalled()
    await f.check(now + 600000)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('postpones a scheduled wake if normal work moves the next official reset later', async () => {
    const f = fixture()
    Object.assign(f.state.settings.quotaWake.codex, { timing: 'daily', firstWakeAt: now + 600000 })
    await f.check()
    f.provider.quota!.rateLimits!.primary!.resetsAt += 18000
    await f.check(now + 600000)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.state.wakePlans.codex!.scheduledFor).toBe(now + 18300000)
  })
  it('does not override the chosen daily anchor on repeated checks or restart', async () => {
    const f = fixture()
    Object.assign(f.state.settings.quotaWake.codex, { timing: 'daily', firstWakeAt: now + 600000 })
    await f.check()
    await new QuotaWake().check(f.provider, structuredClone(f.state), f.save, f.event, now + 599999)
    expect(f.send).not.toHaveBeenCalled()
    await f.check(now + 600000); await f.check(now + 610000)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('is disabled for both providers on new and upgraded installations', async () => {
    expect(Object.values(DEFAULT_SETTINGS.quotaWake).every(settings => !settings.enabled)).toBe(true)
    const f = fixture(); f.state.settings.quotaWake.codex.enabled = false
    await f.check(now + 400000)
    expect(f.state.wakePlans).toEqual({}); expect(f.send).not.toHaveBeenCalled()
  })

  it('plans and sends at reset plus grace without an interrupted task or exhausted quota', async () => {
    const f = fixture()
    await f.check()
    expect(f.state.queue).toEqual([])
    expect(f.state.wakePlans.codex?.scheduledFor).toBe(now + 360000)
    await f.check(now + 359999); expect(f.send).not.toHaveBeenCalled()
    await f.check(now + 360000)
    expect(f.send).toHaveBeenCalledExactlyOnceWith(f.state.settings.quotaWake.codex, f.provider.models[0])
  })

  it('persists the receipt before sending and survives concurrent checks and restart', async () => {
    const f = fixture()
    f.send.mockImplementation(async () => {
      expect(f.save).toHaveBeenCalled()
      expect(f.state.wakeReceipts).toEqual([`codex:${now / 1000 + 300}`])
      return { threadId: 'wake-thread', turnId: 'wake-turn' }
    })
    await Promise.all([f.check(now + 360000), f.check(now + 360000)])
    await new QuotaWake().check(f.provider, structuredClone(f.state), f.save, f.event, now + 400000)
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('waits without guessing if quota or a five-hour timestamp is missing', async () => {
    const f = fixture(); f.provider.quota = null
    await f.check(); expect(f.state.wakePlans).toEqual({})
    f.provider.quota = { rateLimits: { limitId: 'other', primary: { usedPercent: 0, resetsAt: now / 1000, windowDurationMins: 15 } } }
    await f.check(); expect(f.send).not.toHaveBeenCalled()
  })

  it('waits for the weekly window rather than spending past an exhausted weekly limit', async () => {
    const f = fixture(); f.provider.quota!.rateLimits!.secondary!.usedPercent = 100
    await f.check(now + 360000)
    expect(f.state.wakePlans.codex?.scheduledFor).toBe(now + 10060000)
    expect(f.send).not.toHaveBeenCalled()
    f.provider.quota!.rateLimits!.secondary!.usedPercent = 0
    f.provider.quota!.rateLimits!.secondary!.resetsAt += 604800
    await f.check(now + 10060000)
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('avoids active work and disconnected providers', async () => {
    const f = fixture(); f.provider.busy = true
    await f.check(now + 360000); expect(f.send).not.toHaveBeenCalled()
    f.provider.busy = false; f.provider.connected = false
    await f.check(now + 380000); expect(f.send).not.toHaveBeenCalled()
    f.provider.connected = true
    await f.check(now + 400000); expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('skips a ping if normal work already started a new window', async () => {
    const f = fixture(); await f.check()
    f.provider.quota!.rateLimits!.primary!.resetsAt += 18000
    await f.check(now + 360000)
    expect(f.state.wakePlans.codex?.status).toBe('skipped')
    await f.check(now + 400000)
    expect(f.state.wakePlans.codex?.status).toBe('waiting')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('does not replay stale windows after a long offline period', async () => {
    const f = fixture(); await f.check(now + 360000 + 1800001)
    expect(f.state.wakePlans.codex?.status).toBe('skipped')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('does not retry a failed or uncertain send', async () => {
    const f = fixture(); f.send.mockRejectedValue(new Error('response lost'))
    await f.check(now + 360000); await f.check(now + 400000)
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.state.wakePlans.codex?.status).toBe('failed')
  })

  it('never sends if the durable receipt cannot be written', async () => {
    const f = fixture(); f.save.mockRejectedValue(new Error('disk full'))
    await expect(f.check(now + 360000)).rejects.toThrow('disk full')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('does not fall back to a premium model', async () => {
    const f = fixture(); f.provider.models = [{ id: 'gpt-6-astra', name: 'Astra' }]
    await f.check(now + 360000)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.state.wakePlans.codex?.message).toContain('选择')
  })

  it('honors an explicitly selected model and conversation', async () => {
    const f = fixture()
    Object.assign(f.state.settings.quotaWake.codex, { target: 'existing', threadId: 'my-thread', model: 'gpt-6-sol' })
    f.provider.models.push({ id: 'gpt-6-sol', name: 'Sol' })
    await f.check(now + 360000)
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'my-thread', target: 'existing' }), expect.objectContaining({ id: 'gpt-6-sol' }))
  })

  it('keeps a fast completion notification rather than reverting to submitted', async () => {
    const f = fixture()
    f.send.mockImplementation(async () => {
      f.state.wakePlans.codex!.threadId = 'wake-thread'
      f.wake.complete(f.state, 'codex', 'wake-thread', true)
      return { threadId: 'wake-thread', turnId: 'wake-turn' }
    })
    await f.check(now + 360000)
    expect(f.state.wakePlans.codex?.status).toBe('completed')
  })

  it('only schedules the next cycle from a newly reported official timestamp', async () => {
    const f = fixture(); await f.check(now + 360000)
    await f.check(now + 18000000); expect(f.send).toHaveBeenCalledTimes(1)
    f.provider.quota!.rateLimits!.primary!.resetsAt += 18000
    await f.check(now + 18000000)
    expect(f.state.wakePlans.codex?.status).toBe('waiting')
  })
})

it('chooses only supported minimum effort and an explicit Claude model/Haiku alias', () => {
  expect(lowestEffort({ id: 'm', name: 'm', efforts: ['high', 'low', 'medium'] })).toBe('low')
  expect(lowestEffort({ id: 'm', name: 'm' })).toBeUndefined()
  expect(chooseWakeModel('claude-code', 'auto', [])?.id).toBe('haiku')
  expect(chooseWakeModel('claude-code', 'claude-haiku-5-5', [])?.id).toBe('claude-haiku-5-5')
  expect(chooseWakeModel('claude-code', '--bad-flag', [])).toBeNull()
})
