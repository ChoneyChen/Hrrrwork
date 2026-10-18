import { describe, expect, it } from 'vitest'
import { claudeTurn, parseClaudeQuota, type ClaudeSessionState } from './claudeState'
import { bridgeCommand } from './ClaudeCode'
import { classifyLimit, sameUnfinishedTurn } from '../relay/logic'

describe('Claude Code adapter', () => {
  it('maps official status line windows including weekly exhaustion', () => {
    const quota = parseClaudeQuota({ five_hour: { used_percentage: 10, resets_at: 2000 }, seven_day: { used_percentage: 100, resets_at: 9000 } })
    expect(classifyLimit(quota, 1000)).toEqual({ reached: true, resetAt: 9000, reason: 'weekly' })
  })
  it('does not invent quota for missing or malformed subscription data', () => {
    expect(parseClaudeQuota(undefined)).toBeNull()
    expect(parseClaudeQuota({ five_hour: { used_percentage: null, resets_at: null } })).toBeNull()
  })
  it('a new active prompt cancels an old queued failure', () => {
    const failed: ClaudeSessionState = { sessionId: 'session', cwd: '/project', name: 'test', revision: 'r1', updatedAt: 100000, quota: null, status: 'rate-limited' }
    expect(sameUnfinishedTurn('r1', claudeTurn(failed))).toBe(true)
    expect(sameUnfinishedTurn('r1', claudeTurn({ ...failed, revision: 'r2', status: 'active' }))).toBe(false)
  })
  it('quotes paths with spaces and apostrophes without shell expansion', () => {
    const command = bridgeCommand("/Users/sam's Mac/Hrrrwork", '/a b/claude-bridge.cjs', 'status', 'darwin')
    expect(command).toContain("'\\''")
    expect(command).toContain('--hrrrwork')
    expect(command).not.toContain('$(')
  })
  it('uses an encoded PowerShell command on Windows', () => {
    const command = bridgeCommand('C:\\Program Files\\Hrrrwork.exe', 'C:\\a b\\claude-bridge.cjs', 'status', 'win32')
    const decoded = Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le')
    expect(decoded).toContain("$env:ELECTRON_RUN_AS_NODE='1'")
    expect(decoded).toContain('C:\\Program Files\\Hrrrwork.exe')
  })
})
