import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexAppServer } from './CodexAppServer'
import { RelayEngine } from '../relay/RelayEngine'
import { ClaudeCode } from '../providers/ClaudeCode'
import { DEFAULT_SETTINGS, type JsonStore } from '../store'

afterEach(() => { vi.restoreAllMocks() })

it.each(['thread/resume', 'thread/start', 'turn/start', 'thread/archive', 'thread/delete', 'thread/items/list'])('read-only observer refuses %s before touching a process', async method => {
  const client = new CodexAppServer('/unused', {}, true)
  await expect(client.call(method)).rejects.toThrow('Read-only')
})

it('refuses full histories even through read-only endpoints', async () => {
  const client = new CodexAppServer('/unused', {}, true)
  await expect(client.call('thread/read', { includeTurns: true })).rejects.toThrow('Read-only')
  await expect(client.call('thread/turns/list', { limit: 30, itemsView: 'full' })).rejects.toThrow('Read-only')
})

function fixture() {
  const claude = new ClaudeCode('/unused')
  const store = { set: vi.fn(async () => {}) } as unknown as JsonStore
  const engine = new RelayEngine(store, () => {}, () => {}, claude)
  engine['state'] = { settings: structuredClone(DEFAULT_SETTINGS), queue: [], events: [], dispatched: [], wakePlans: {}, wakeReceipts: [] }
  const calls: string[] = []
  vi.spyOn(CodexAppServer.prototype, 'start').mockResolvedValue()
  const stop = vi.spyOn(CodexAppServer.prototype, 'stop').mockResolvedValue()
  vi.spyOn(CodexAppServer.prototype, 'call').mockImplementation(async method => {
    calls.push(method)
    if (method === 'thread/read') return { thread: { id: 'target', status: { type: 'notLoaded' } } } as never
    if (method === 'thread/turns/list') return { data: [{ id: 'old', status: 'failed' }] } as never
    if (method === 'turn/start') return { turn: { id: 'new' } } as never
    return {} as never
  })
  const observer = new EventEmitter() as unknown as CodexAppServer
  observer.call = vi.fn(async method => {
    if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 18000 } } } as never
    if (method === 'thread/turns/list') return { data: [{ id: 'old', status: 'failed' }] } as never
    throw new Error(`Observer must never receive ${method}`)
  })
  engine['client'] = observer
  engine['connection'] = 'connected'
  const item = { id: 'target:old', threadId: 'target', threadName: 'task', turnId: 'old', detectedAt: 0, scheduledFor: 0, reason: 'five-hour' as const, status: 'waiting' as const }
  engine['state'].queue.push(item)
  return { engine, observer, item, stop, calls, store }
}

it('uses a dedicated writer, excludes history, and exits it on completion', async () => {
  const { engine, observer, item, stop, calls, store } = fixture()
  await Promise.all([engine.sendNow(item.id), engine.sendNow(item.id)])
  expect(calls.filter(method => method === 'turn/start')).toHaveLength(1)
  expect(store.set).toHaveBeenCalledWith(expect.objectContaining({ dispatched: ['target:old'], queue: [] }))
  expect(observer.call).not.toHaveBeenCalledWith('thread/resume', expect.anything())
  const worker = [...engine['workers'].keys()][0]
  expect(worker.call).toHaveBeenCalledWith('thread/resume', { threadId: 'target', excludeTurns: true })
  expect(engine.hasActiveWork()).toBe(true)
  worker.emit('notification', 'thread/started', { thread: { id: 'child-agent' } })
  worker.emit('notification', 'turn/completed', { threadId: 'child-agent', turn: { id: 'child-turn', status: 'completed' } })
  expect(stop).not.toHaveBeenCalled()
  worker.emit('notification', 'turn/completed', { threadId: 'target', turn: { id: 'new', status: 'completed' } })
  await vi.waitFor(() => expect(stop).toHaveBeenCalled())
  expect(engine['workers'].size).toBe(0)
  if (engine['dueTimer']) clearTimeout(engine['dueTimer'])
})

it.each(['request', 'disconnect'])('releases the writer on %s, never leaves it holding the conversation', async event => {
  const { engine, item, stop } = fixture()
  await engine.sendNow(item.id)
  const worker = [...engine['workers'].keys()][0]
  worker.emit(event, 'approval-required')
  await vi.waitFor(() => expect(stop).toHaveBeenCalled())
  expect(engine['workers'].size).toBe(0)
})

it('does not replay a turn/start timeout or retain its worker', async () => {
  const { engine, item, stop } = fixture()
  vi.spyOn(CodexAppServer.prototype, 'call').mockImplementation(async method => {
    if (method === 'turn/start') throw new Error('timed out')
    if (method === 'thread/read') return { thread: { status: { type: 'notLoaded' } } } as never
    return { data: [{ id: 'old', status: 'failed' }] } as never
  })
  await engine.sendNow(item.id)
  expect(engine.snapshot().queue).toHaveLength(0)
  expect(engine['state'].dispatched).toContain(item.id)
  expect(engine['workers'].size).toBe(0)
  expect(stop).toHaveBeenCalled()
})

it('refuses to resume a target reported as active', async () => {
  const { engine, item, calls } = fixture()
  vi.spyOn(CodexAppServer.prototype, 'call').mockResolvedValue({ thread: { status: { type: 'active' } } })
  await engine.sendNow(item.id)
  expect(calls).not.toContain('thread/resume')
  expect(engine['state'].dispatched).toHaveLength(0)
  expect(engine['workers'].size).toBe(0)
  if (engine['dueTimer']) clearTimeout(engine['dueTimer'])
})
