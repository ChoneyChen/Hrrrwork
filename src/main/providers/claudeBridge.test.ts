import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ClaudeCode } from './ClaudeCode'
import { WAKE_PROMPT } from '../../shared/types'

let fixture = ''
afterEach(async () => {
  vi.restoreAllMocks()
  if (fixture) await fs.rm(fixture, { recursive: true, force: true })
  fixture = ''
})

describe('Claude bridge lifecycle', () => {
  it('creates a bounded wake with the selected model and no built-in or MCP tools', async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'hrrrwork-claude-wake-'))
    const adapter = new ClaudeCode('/unused/claude-bridge.cjs')
    const launch = vi.spyOn(adapter as unknown as { launch: (id: string, cwd: string, args: string[], wake: boolean) => Promise<void> }, 'launch').mockResolvedValue()
    const starting = vi.fn(async () => {})
    const result = await adapter.wake(null, 'haiku', fixture, starting)
    expect(result.threadId).toMatch(/^claude:[a-f0-9-]{36}$/)
    expect(starting).toHaveBeenCalledWith(result.threadId)
    const [id, cwd, args, wake] = launch.mock.calls[0]
    expect(cwd).toBe(fixture); expect(wake).toBe(true)
    expect(args).toEqual(expect.arrayContaining(['--session-id', id, '-p', WAKE_PROMPT, '--model', 'haiku', '--tools', '', '--disallowedTools', 'mcp__*', '--max-turns', '1']))
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('only resumes the explicitly selected idle Claude session', async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'hrrrwork-claude-target-'))
    const adapter = new ClaudeCode('/unused/claude-bridge.cjs')
    const launch = vi.spyOn(adapter as unknown as { launch: (id: string, cwd: string, args: string[], wake: boolean) => Promise<void> }, 'launch').mockResolvedValue()
    adapter.sessions.set('chosen', { sessionId: 'chosen', cwd: fixture, name: 'Chosen', revision: 'r1', status: 'active', updatedAt: Date.now(), quota: null })
    await expect(adapter.wake('chosen', 'sonnet', fixture)).rejects.toThrow('空闲')
    expect(launch).not.toHaveBeenCalled()
    adapter.sessions.get('chosen')!.status = 'idle'
    await adapter.wake('chosen', 'sonnet', fixture)
    expect(launch.mock.calls[0][2]).toEqual(expect.arrayContaining(['--resume', 'chosen', '--model', 'sonnet']))
    expect(launch.mock.calls[0][2]).not.toContain('--session-id')
  })

  it('keeps hooks and status line, captures quota failure, and sees manual continuation', async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'hrrrwork-bridge-'))
    vi.spyOn(os, 'homedir').mockReturnValue(fixture)
    const claudeDirectory = path.join(fixture, '.claude')
    await fs.mkdir(claudeDirectory)
    const configFile = path.join(claudeDirectory, 'settings.json')
    const original = { statusLine: { type: 'command', command: 'echo original-status' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo original-hook' }] }] }, permissions: { defaultMode: 'default' } }
    await fs.writeFile(configFile, JSON.stringify(original))
    const script = path.resolve('resources/claude-bridge.cjs')
    const adapter = new ClaudeCode(script)
    await adapter.refresh(process.execPath)
    await adapter.connect()
    await adapter.connect()
    const configured = JSON.parse(await fs.readFile(configFile, 'utf8'))
    expect(configured.hooks.Stop).toHaveLength(2)
    expect(configured.permissions).toEqual(original.permissions)
    const relocated = new ClaudeCode('/relocated/Hrrrwork/claude-bridge.cjs', '/relocated/Hrrrwork/runtime')
    await relocated.refresh(process.execPath)
    const rebound = JSON.parse(await fs.readFile(configFile, 'utf8'))
    expect(rebound.statusLine.command).toContain('/relocated/Hrrrwork/runtime')
    expect(rebound.hooks.Stop[0].hooks[0].command).toBe('echo original-hook')
    expect(rebound.hooks.Stop[1].hooks[0].command).toContain('/relocated/Hrrrwork/claude-bridge.cjs')
    const savedStatus = JSON.parse(await fs.readFile(path.join(fixture, '.hrrrwork/claude/original-status.json'), 'utf8'))
    expect(savedStatus.command).toBe('echo original-status')
    function emit(payload: object, mode = 'event'): string {
      const child = spawnSync(process.execPath, [script, mode], {
        input: JSON.stringify({ session_id: 'fixture-session', cwd: fixture, ...payload }),
        encoding: 'utf8', env: { ...process.env, HOME: fixture, USERPROFILE: fixture }
      })
      expect(child.status).toBe(0)
      return child.stdout
    }
    emit({ hook_event_name: 'UserPromptSubmit' })
    expect(emit({ rate_limits: { five_hour: { used_percentage: 100, resets_at: 9999999999 } } }, 'status')).toContain('original-status')
    emit({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'private text must not persist' })
    await adapter.refresh(process.execPath)
    expect(adapter.snapshot().connected).toBe(true)
    expect(adapter.sessions.get('fixture-session')?.status).toBe('rate-limited')
    const file = path.join(fixture, '.hrrrwork/claude/fixture-session.json')
    expect(await fs.readFile(file, 'utf8')).not.toContain('private text')
    emit({ hook_event_name: 'UserPromptSubmit' })
    await adapter.refresh(process.execPath)
    expect(adapter.sessions.get('fixture-session')?.status).toBe('active')
    adapter['captureQuota']({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 9999999999 })
    adapter['captureQuota']({ status: 'allowed', rateLimitType: 'seven_day', resetsAt: 99999999999, utilization: .35 })
    await adapter.refresh(process.execPath)
    expect(adapter.snapshot().quota?.rateLimits?.primary?.usageKnown).toBe(false)
    expect(adapter.snapshot().quota?.rateLimits?.secondary?.usedPercent).toBe(35)
    await adapter.disconnect()
    const restored = JSON.parse(await fs.readFile(configFile, 'utf8'))
    expect(restored.statusLine).toEqual(original.statusLine)
    expect(restored.hooks.Stop).toEqual(original.hooks.Stop)
    expect(restored.hooks.StopFailure).toBeUndefined()
  })
})
