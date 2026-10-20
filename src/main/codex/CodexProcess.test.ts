import { expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexAppServer } from './CodexAppServer'
import { RelayEngine } from '../relay/RelayEngine'
import { ClaudeCode } from '../providers/ClaudeCode'
import { JsonStore } from '../store'

it('keeps observation unloaded and really exits the dedicated writer process after completion', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hrrrwork-access-'))
  const executable = path.join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  const script = process.platform === 'win32' ? path.join(directory, 'node_modules/@openai/codex/bin/codex.js') : executable
  await fs.mkdir(path.dirname(script), { recursive: true })
  await fs.copyFile(path.resolve('scripts/fixtures/codex-access.cjs'), script)
  if (process.platform !== 'win32') await fs.chmod(script, 0o755)
  const env = { CODEX_HOME: directory, CODEX_SQLITE_HOME: directory }
  const observer = new CodexAppServer(executable, env, true)
  const engine = new RelayEngine(new JsonStore(path.join(directory, 'state.json')), () => {}, () => {}, new ClaudeCode('/unused'))
  try {
    await observer.start()
    engine['client'] = observer
    engine['codexPath'] = executable
    engine['workerEnvironment'] = env
    const read = () => observer.call<{ thread: { status: { type: string } } }>('thread/read', { threadId: 'target', includeTurns: false })
    await observer.call('thread/turns/list', { threadId: 'target', limit: 1, itemsView: 'notLoaded' })
    expect((await read()).thread.status.type).toBe('notLoaded')
    await expect(observer.call('thread/resume', { threadId: 'target' })).rejects.toThrow('Read-only')
    engine['state'].queue = [{ id: 'target:old', threadId: 'target', turnId: 'old', threadName: 'Isolated test', reason: 'five-hour', detectedAt: 0, scheduledFor: 0, status: 'waiting' }]
    await engine.sendNow('target:old')
    const worker = [...engine['workers'].keys()][0]
    const child = worker['child']!
    expect(child.pid).toBeGreaterThan(0)
    expect(child).not.toBe(observer['child'])
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(engine['workers'].size).toBe(0)
    expect((await read()).thread.status.type).toBe('notLoaded')
  } finally { await engine.stop(); await observer.stop(); await fs.rm(directory, { recursive: true, force: true }) }
})
