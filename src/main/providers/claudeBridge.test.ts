import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ClaudeCode } from './ClaudeCode'

let fixture = ''
afterEach(async () => {
  vi.restoreAllMocks()
  if (fixture) await fs.rm(fixture, { recursive: true, force: true })
  fixture = ''
})

describe('Claude bridge lifecycle', () => {
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
    await adapter.disconnect()
    const restored = JSON.parse(await fs.readFile(configFile, 'utf8'))
    expect(restored.statusLine).toEqual(original.statusLine)
    expect(restored.hooks.Stop).toEqual(original.hooks.Stop)
    expect(restored.hooks.StopFailure).toBeUndefined()
  })
})
