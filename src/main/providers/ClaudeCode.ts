import { EventEmitter } from 'node:events'
import { constants, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { ProviderSnapshot, ThreadSummary } from '../../shared/types'
import { findExecutable } from './executable'
import { parseClaudeQuota, type ClaudeSessionState } from './claudeState'
import { cliLaunch } from './cliLaunch'

const configHome = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const bridgeHome = (): string => path.join(os.homedir(), '.hrrrwork', 'claude')
const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`

export function bridgeCommand(executable: string, script: string, mode: string, platform = process.platform): string {
  if (platform === 'win32') {
    const ps = `$env:ELECTRON_RUN_AS_NODE='1'; & '${executable.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}' '--hrrrwork' '${mode}'`
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`
  }
  return `ELECTRON_RUN_AS_NODE=1 ${quote(executable)} ${quote(script)} --hrrrwork ${quote(mode)}`
}

export class ClaudeCode extends EventEmitter {
  sessions = new Map<string, ClaudeSessionState>()
  private executable = ''
  private installed = false
  private connected = false
  private lastCheckedAt: number | null = null
  private children = new Map<string, ChildProcess>()

  constructor(private readonly bridgeScript: string, private readonly runtime = process.execPath) { super() }

  async refresh(preferred = ''): Promise<void> {
    this.executable = await findExecutable('claude', preferred) || ''
    this.installed = Boolean(this.executable)
    this.connected = false
    try {
      const file = path.join(configHome(), 'settings.json')
      const settings = JSON.parse(await fs.readFile(file, 'utf8'))
      const ownsStatus = this.isBridgeCommand(settings.statusLine?.command)
      const currentCommand = bridgeCommand(this.runtime, this.bridgeScript, 'status')
      if (this.installed && ownsStatus && settings.statusLine.command !== currentCommand) {
        // Portable/AppImage extraction paths change between launches. Rebind only our own commands.
        settings.statusLine.command = currentCommand
        for (const entries of Object.values(settings.hooks ?? {}) as any[][]) {
          if (!Array.isArray(entries)) continue
          for (const entry of entries) for (const hook of entry.hooks ?? []) {
            if (this.isBridgeCommand(hook.command)) hook.command = bridgeCommand(this.runtime, this.bridgeScript, 'event')
          }
        }
        await fs.writeFile(`${file}.hrrrwork.tmp`, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
        await fs.rename(`${file}.hrrrwork.tmp`, file)
      }
      this.connected = ownsStatus
    } catch { /* No configuration yet */ }
    this.sessions.clear()
    try {
      const files = (await fs.readdir(bridgeHome())).filter(file => /^[a-zA-Z0-9_-]+\.json$/.test(file) && file !== 'original-status.json')
      for (const file of files) {
        try {
          const raw = JSON.parse(await fs.readFile(path.join(bridgeHome(), file), 'utf8'))
          if (typeof raw.sessionId !== 'string' || typeof raw.cwd !== 'string' || typeof raw.revision !== 'string' || typeof raw.updatedAt !== 'number') continue
          if (!['active', 'idle', 'rate-limited'].includes(raw.status)) continue
          this.sessions.set(raw.sessionId, { ...raw, quota: parseClaudeQuota(raw.rateLimits) })
        } catch { /* One incomplete record must not hide the other sessions */ }
      }
    } catch { /* First launch */ }
    this.lastCheckedAt = Date.now()
  }

  snapshot(): ProviderSnapshot {
    const newest = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return {
      id: 'claude-code', name: 'Claude Code', installed: this.installed,
      connected: this.installed && this.connected, executable: this.executable,
      message: !this.installed ? '未安装' : !this.connected ? '已检测到 · 点击连接' : newest?.status === 'rate-limited' && !newest.quota ? '额度中断 · 等待刷新信息' : newest ? '已连接 · 本地桥接' : '已连接 · 等待下一轮会话',
      quota: newest?.quota ?? null, lastCheckedAt: this.lastCheckedAt
    }
  }

  threads(): ThreadSummary[] {
    return [...this.sessions.values()].map((session): ThreadSummary => ({
      id: `claude:${session.sessionId}`, provider: 'claude-code', name: session.name,
      cwd: session.cwd, source: 'claude-code', createdAt: session.updatedAt / 1000,
      updatedAt: session.updatedAt / 1000, status: { type: session.status }
    })).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async connect(): Promise<void> {
    if (!this.executable) throw new Error('未找到 Claude Code，请先安装或填写可执行文件路径。')
    const file = path.join(configHome(), 'settings.json')
    await fs.mkdir(configHome(), { recursive: true })
    await fs.mkdir(bridgeHome(), { recursive: true, mode: 0o700 })
    let settings: Record<string, any> = {}
    try { settings = JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Claude 设置文件无法解析，未进行修改。')
    }
    await fs.copyFile(file, `${file}.hrrrwork-backup`, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => { if (!['ENOENT', 'EEXIST'].includes(error.code ?? '')) throw error })
    if (!this.isBridgeCommand(settings.statusLine?.command)) {
      await fs.writeFile(path.join(bridgeHome(), 'original-status.json'), JSON.stringify(settings.statusLine ?? {}), { mode: 0o600 })
    }
    settings.statusLine = { ...settings.statusLine, type: 'command', command: bridgeCommand(this.runtime, this.bridgeScript, 'status') }
    settings.hooks ??= {}
    for (const event of ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']) {
      const entries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
      const retained = entries.map((entry: any) => ({ ...entry, hooks: (entry.hooks ?? []).filter((hook: any) => !this.isBridgeCommand(hook.command)) })).filter((entry: any) => entry.hooks.length)
      retained.push({ ...(event === 'StopFailure' ? { matcher: 'rate_limit' } : {}), hooks: [{ type: 'command', command: bridgeCommand(this.runtime, this.bridgeScript, 'event'), timeout: 5 }] })
      settings.hooks[event] = retained
    }
    const temporary = `${file}.hrrrwork.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(temporary, file)
    await this.refresh(this.executable)
  }

  async disconnect(): Promise<void> {
    const file = path.join(configHome(), 'settings.json')
    const settings = JSON.parse(await fs.readFile(file, 'utf8'))
    if (this.isBridgeCommand(settings.statusLine?.command)) {
      // Only restore a status line that is still ours, not one the user changed later.
      if (this.connected) {
        let original = {}
        try { original = JSON.parse(await fs.readFile(path.join(bridgeHome(), 'original-status.json'), 'utf8')) } catch { /* no previous status */ }
        if (Object.keys(original).length) settings.statusLine = original
        else delete settings.statusLine
      }
    }
    for (const event of ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']) {
      if (!Array.isArray(settings.hooks?.[event])) continue
      settings.hooks[event] = settings.hooks[event].map((entry: any) => ({ ...entry, hooks: (entry.hooks ?? []).filter((hook: any) => !this.isBridgeCommand(hook.command)) })).filter((entry: any) => entry.hooks.length)
      if (!settings.hooks[event].length) delete settings.hooks[event]
    }
    const temporary = `${file}.hrrrwork.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(temporary, file)
    await this.refresh(this.executable)
  }

  private isBridgeCommand(command: unknown): boolean {
    if (typeof command !== 'string') return false
    if (command.includes('claude-bridge.cjs')) return true
    const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)?.[1]
    return encoded ? Buffer.from(encoded, 'base64').toString('utf16le').includes('claude-bridge.cjs') : false
  }

  async resume(sessionId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.status !== 'rate-limited') throw new Error('会话已变化，已取消接力。')
    if (this.children.has(sessionId)) throw new Error('该会话已经在接力中。')
    const invocation = await cliLaunch(this.executable, 'claude')
    const child = spawn(invocation.executable, [...invocation.prefix, '--resume', sessionId, '-p', prompt, '--output-format', 'stream-json', '--verbose'], {
      cwd: session.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...invocation.env, CLAUDECODE: undefined }
    })
    this.children.set(sessionId, child)
    let failed = false
    let buffer = ''
    child.stdout?.on('data', data => {
      buffer += data.toString()
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        try { const item = JSON.parse(line); if (item.type === 'result' && (item.is_error || item.permission_denials?.length)) failed = true } catch { /* Non-JSON diagnostic */ }
      }
      if (buffer.length > 1024 * 1024) buffer = ''
    })
    child.stderr?.on('data', () => {})
    child.on('close', code => {
      this.children.delete(sessionId)
      this.emit('run-ended', sessionId, code === 0 && !failed)
    })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', error => { this.children.delete(sessionId); reject(error) }) })
  }

  stop(): void {
    // Accepted work keeps running if the tray app exits.
    for (const child of this.children.values()) child.unref()
  }
}
