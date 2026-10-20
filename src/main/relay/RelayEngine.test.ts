import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayEngine } from './RelayEngine'
import { ClaudeCode } from '../providers/ClaudeCode'
import { DEFAULT_SETTINGS, type JsonStore } from '../store'
import type { CodexAppServer } from '../codex/CodexAppServer'
import type { ClaudeSessionState } from '../providers/claudeState'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WAKE_PROMPT } from '../../shared/types'

function fixture(resetOffset = 300, wakeDirectory?: string) {
  const now = Date.now()
  const claude = new ClaudeCode('/unused/claude-bridge.cjs')
  const session: ClaudeSessionState = {
    sessionId: 'fixture', cwd: '/project', name: 'Claude task', revision: 'turn-1',
    status: 'rate-limited', updatedAt: now, failedAt: now - 120000,
    quota: { rateLimits: { limitId: 'claude-code', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + resetOffset } } }
  }
  claude.sessions.set(session.sessionId, session)
  vi.spyOn(claude, 'refresh').mockResolvedValue()
  vi.spyOn(claude, 'snapshot').mockReturnValue({ id: 'claude-code', name: 'Claude Code', installed: true, connected: true, message: '', executable: '/claude', quota: session.quota, lastCheckedAt: now })
  const resume = vi.spyOn(claude, 'resume').mockResolvedValue()
  const store = { set: vi.fn(async () => {}) } as unknown as JsonStore
  const engine = new RelayEngine(store, () => {}, () => {}, claude, wakeDirectory)
  engine['state'] = { settings: structuredClone(DEFAULT_SETTINGS), queue: [], events: [], dispatched: [], wakePlans: {}, wakeReceipts: [] }
  engine['threads'] = claude.threads()
  vi.spyOn(engine as unknown as { createWorker: () => Promise<CodexAppServer> }, 'createWorker').mockImplementation(async () => ({
    call: async (method: string, params: Record<string, unknown>) => method === 'thread/read' ? { thread: { id: params.threadId, status: { type: 'idle' } } } : engine['client']!.call(method, params),
    stop: vi.fn(async () => {})
  }) as unknown as CodexAppServer)
  return { engine, claude, session, resume, store }
}

afterEach(() => { vi.useRealTimers() })

describe('multi-provider relay safety', () => {
  it('rejects a first wake before the official reset and accepts the reset itself', async () => {
    const { engine } = fixture()
    const reset = Date.now() + 1800000
    engine['quota'] = { rateLimits: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: reset / 1000 } } }
    const settings = { ...engine.snapshot().settings.quotaWake.codex, timing: 'daily' as const, firstWakeAt: reset - 60000 }
    await expect(engine.updateSettings({ quotaWake: { ...engine.snapshot().settings.quotaWake, codex: settings } })).rejects.toThrow('不能早于')
    expect(engine.snapshot().settings.quotaWake.codex.timing).toBe('reset')
    await engine.updateSettings({ quotaWake: { ...engine.snapshot().settings.quotaWake, codex: { ...settings, firstWakeAt: reset } } })
    expect(engine.snapshot().settings.quotaWake.codex.firstWakeAt).toBe(reset)
  })
  it('shows Codex tasks even when the quota endpoint fails and does not send without quota', async () => {
    const { engine } = fixture()
    engine['connection'] = 'connected'
    engine['client'] = { call: vi.fn(async (method: string) => {
      if (method === 'thread/list') return { data: [{ id: 'desktop-task', createdAt: 0, updatedAt: Date.now() / 1000 }] }
      throw new Error('quota temporarily unavailable')
    }) } as unknown as CodexAppServer
    await engine['tick'](true)
    expect(engine.snapshot().threads.some(thread => thread.id === 'desktop-task')).toBe(true)
    expect(engine.snapshot().quota).toBeNull()
    expect(engine.snapshot().connectionMessage).toContain('额度读取失败')
    expect(engine.snapshot().queue.some(item => (item.provider ?? 'codex') === 'codex')).toBe(false)
  })

  it('keeps available quota visible when only task listing fails', async () => {
    const { engine } = fixture()
    const quota = { rateLimits: { limitId: 'codex', primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 1000 } } }
    engine['connection'] = 'connected'
    engine['client'] = { call: vi.fn(async (method: string) => {
      if (method === 'account/rateLimits/read') return quota
      throw new Error('thread temporarily unavailable')
    }) } as unknown as CodexAppServer
    await engine['tick'](true)
    expect(engine.snapshot().quota).toEqual(quota)
    expect(engine.snapshot().connectionMessage).toContain('任务读取失败')
  })
  it('still queues Claude when the Codex thread reader fails', async () => {
    const { engine } = fixture()
    engine['client'] = { call: vi.fn().mockRejectedValue(new Error('Codex unavailable')) } as unknown as CodexAppServer
    engine['threads'].unshift({ id: 'codex-fixture', provider: 'codex', name: 'Codex task', cwd: '/project', createdAt: 0, updatedAt: Date.now() / 1000 })
    await engine['detectInterruptedTurns']()
    expect(engine.snapshot().queue.map(item => item.provider)).toEqual(['claude-code'])
  })

  it('persists one dispatch receipt before starting and never requeues the same failure', async () => {
    const { engine, resume, store } = fixture(-90)
    await engine['detectInterruptedTurns']()
    const id = engine.snapshot().queue[0].id
    await Promise.all([engine.sendNow(id), engine.sendNow(id)])
    expect(resume).toHaveBeenCalledExactlyOnceWith('fixture', 'continue')
    expect(store.set).toHaveBeenCalledWith(expect.objectContaining({ dispatched: [id], queue: [] }))
    await engine['detectInterruptedTurns']()
    expect(engine.snapshot().queue).toHaveLength(0)
  })

  it('cancels a queued relay after the user manually continues the session', async () => {
    const { engine, session, resume } = fixture(-90)
    await engine['detectInterruptedTurns']()
    const id = engine.snapshot().queue[0].id
    session.revision = 'new-user-turn'
    session.status = 'active'
    await engine.sendNow(id)
    expect(resume).not.toHaveBeenCalled()
    expect(engine.snapshot().queue).toHaveLength(0)
  })
})

describe('prompt reset scheduling and minimal reads', () => {
  it('does not inspect any conversation turns while quota is available', async () => {
    const { engine } = fixture()
    const call = vi.fn()
    engine['client'] = { call } as unknown as CodexAppServer
    engine['threads'] = [{ id: 'normal-work', createdAt: 1, updatedAt: 2 }]
    engine['quota'] = { rateLimits: { limitId: 'codex', primary: { usedPercent: 32, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 1000 } } }
    await engine['detectInterruptedTurns']()
    expect(call).not.toHaveBeenCalled()
  })

  it('fires at the exact reset instead of waiting for the polling interval', async () => {
    vi.useFakeTimers()
    const { engine } = fixture()
    engine['state'].queue = [{ id: 'q', threadId: 'thread', threadName: 'task', turnId: 't', detectedAt: Date.now(), scheduledFor: Date.now() + 2500, reason: 'five-hour', status: 'waiting' }]
    const processDue = vi.spyOn(engine as unknown as { processDueQueue: () => Promise<void> }, 'processDueQueue').mockResolvedValue()
    engine['scheduleDueCheck']()
    await vi.advanceTimersByTimeAsync(2499)
    expect(processDue).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(processDue).toHaveBeenCalledOnce()
    await engine.stop()
  })

  it('backs off five seconds when the server still reports a spent, already-reset window', async () => {
    const { engine } = fixture()
    const item = { id: 'q', threadId: 'thread', threadName: 'task', turnId: 't', detectedAt: 0, scheduledFor: Date.now() - 1000, reason: 'five-hour' as const, status: 'waiting' as const }
    engine['state'].queue = [item]
    const call = vi.fn().mockResolvedValue({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Date.now() / 1000 - 30 } } })
    engine['client'] = { call, stop: vi.fn() } as unknown as CodexAppServer
    await engine['processDueQueue']()
    expect(item.scheduledFor).toBeGreaterThanOrEqual(Date.now() + 4900)
    expect(call.mock.calls.every(([method]) => method === 'account/rateLimits/read')).toBe(true)
    await engine.stop()
  })
})

describe('wake provider dispatch', () => {
  it('creates a short readonly Codex conversation even when interrupted-task relay is off', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hrrrwork-wake-dispatch-'))
    try {
      const { engine } = fixture(300, directory)
      engine['state'].settings.enabled = false
      engine['state'].settings.quotaWake.codex.enabled = true
      engine['connection'] = 'connected'
      engine['models'] = [{ id: 'gpt-6-luna', name: 'Luna', efforts: ['medium', 'low'] }]
      const quota = { ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', primary: { usedPercent: 20, resetsAt: Date.now() / 1000 - 90, windowDurationMins: 300 } } }
      const call = vi.fn(async (method: string) => {
        if (method === 'account/rateLimits/read') return quota
        if (method === 'thread/list') return { data: [] }
        if (method === 'thread/start') return { thread: { id: 'new-wake' }, model: 'gpt-6-luna' }
        if (method === 'turn/start') return { turn: { id: 'new-turn' } }
        throw new Error(method)
      })
      engine['client'] = { call } as unknown as CodexAppServer
      await engine['tick']()
      expect(call).toHaveBeenCalledWith('thread/start', expect.objectContaining({ sandbox: 'read-only', model: 'gpt-6-luna', allowProviderModelFallback: false }))
      expect(call).toHaveBeenCalledWith('turn/start', expect.objectContaining({ threadId: 'new-wake', model: 'gpt-6-luna', effort: 'low', input: [{ type: 'text', text: WAKE_PROMPT }] }))
      expect(engine.snapshot().wakePlans.codex?.status).toBe('submitted')
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  })

  it('uses the chosen idle Codex conversation, never starts a new one', async () => {
    const { engine } = fixture()
    engine['connection'] = 'connected'
    const settings = { enabled: true, target: 'existing' as const, threadId: 'chosen', model: 'gpt-6-luna' }
    engine['state'].settings.quotaWake.codex = settings
    const call = vi.fn(async (method: string) => {
      if (method === 'account/rateLimits/read') return { rateLimits: { limitId: 'codex', primary: { usedPercent: 0, resetsAt: Date.now() / 1000 + 18000, windowDurationMins: 300 } } }
      if (method === 'thread/turns/list') return { data: [{ id: 'old-turn', status: 'completed' }] }
      if (method === 'turn/start') return { turn: { id: 'wake-turn' } }
      return {}
    })
    engine['client'] = { call } as unknown as CodexAppServer
    await engine['sendQuotaWake']('codex', settings, { id: 'gpt-6-luna', name: 'Luna' })
    expect(call).toHaveBeenCalledWith('thread/resume', { threadId: 'chosen', excludeTurns: true })
    expect(call.mock.calls.some(([method]) => method === 'thread/start')).toBe(false)
  })

  it('refuses a non-idle target instead of appending a wake prompt', async () => {
    const { engine } = fixture()
    engine['connection'] = 'connected'
    engine['state'].settings.quotaWake.codex.enabled = true
    const call = vi.fn(async (method: string) => method === 'thread/turns/list' ? { data: [{ id: 'active-turn', status: 'inProgress' }] } : { rateLimits: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 18000 } } })
    engine['client'] = { call } as unknown as CodexAppServer
    await expect(engine['sendQuotaWake']('codex', { enabled: true, target: 'existing', threadId: 'chosen', model: 'auto' }, { id: 'gpt-6-luna', name: 'Luna' })).rejects.toThrow('空闲')
    expect(call.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
  })
})
