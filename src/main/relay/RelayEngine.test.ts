import { describe, expect, it, vi } from 'vitest'
import { RelayEngine } from './RelayEngine'
import { ClaudeCode } from '../providers/ClaudeCode'
import { DEFAULT_SETTINGS, type JsonStore } from '../store'
import type { CodexAppServer } from '../codex/CodexAppServer'
import type { ClaudeSessionState } from '../providers/claudeState'

function fixture(resetOffset = 300) {
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
  const engine = new RelayEngine(store, () => {}, () => {}, claude)
  engine['state'] = { settings: { ...DEFAULT_SETTINGS, watchedThreadIds: [] }, queue: [], events: [], dispatched: [] }
  engine['threads'] = claude.threads()
  return { engine, claude, session, resume, store }
}

describe('multi-provider relay safety', () => {
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
