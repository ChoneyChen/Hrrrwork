import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'

interface RpcResponse<T> {
  id?: number
  result?: T
  error?: { code?: number; message?: string; data?: unknown }
  method?: string
  params?: unknown
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

export class CodexAppServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, PendingCall>()
  private stopping = false

  constructor(private readonly executable: string) {
    super()
  }

  async start(): Promise<void> {
    if (this.child) return
    this.stopping = false
    this.child = spawn(this.executable, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env
    })

    const lines = readline.createInterface({ input: this.child.stdout })
    lines.on('line', (line) => this.handleLine(line))
    this.child.stderr.on('data', (data) => this.emit('stderr', data.toString()))
    this.child.on('error', (error) => this.handleExit(error))
    this.child.on('exit', (code) => {
      if (!this.stopping) this.handleExit(new Error(`Codex App Server exited (${code ?? 'unknown'})`))
    })

    await this.call('initialize', {
      clientInfo: { name: 'hrrrwork', title: 'Hrrrwork', version: '0.1.1' },
      capabilities: { experimentalApi: true }
    })
    this.notify('initialized', {})
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.child?.kill()
    this.child = null
    this.rejectPending(new Error('Codex App Server stopped'))
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    if (!this.child?.stdin.writable) throw new Error('Codex App Server is not connected')
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    })
    this.write({ id, method, params })
    return promise
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params })
  }

  private write(message: object): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    let message: RpcResponse<unknown>
    try {
      message = JSON.parse(line) as RpcResponse<unknown>
    } catch {
      return
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `RPC error ${message.error.code ?? ''}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.method) this.emit('notification', message.method, message.params)
  }

  private handleExit(error: Error): void {
    this.child = null
    this.rejectPending(error)
    this.emit('disconnect', error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
