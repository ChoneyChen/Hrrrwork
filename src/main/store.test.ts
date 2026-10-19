import { expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JsonStore } from './store'

it('serializes overlapping queue and event writes and retains dispatch receipts on restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hrrrwork-store-'))
  try {
    const file = path.join(directory, 'state.json')
    const store = new JsonStore(file)
    const initial = await store.load()
    const receipt = { ...initial, dispatched: ['claude:session:revision'] }
    await Promise.all([store.set(initial), store.set(receipt)])
    expect((await new JsonStore(file).load()).dispatched).toEqual(receipt.dispatched)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

it('migrates v1.0 settings without enabling automatic wake and keeps wake receipts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hrrrwork-migration-'))
  try {
    const file = path.join(directory, 'state.json')
    await fs.writeFile(file, JSON.stringify({ settings: { enabled: false, continuePrompt: 'keep going' }, queue: [], events: [] }))
    const store = new JsonStore(file)
    const state = await store.load()
    expect(state.settings.continuePrompt).toBe('keep going')
    expect(state.settings.quotaWake.codex.enabled).toBe(false)
    expect(state.settings.quotaWake['claude-code'].enabled).toBe(false)
    state.wakeReceipts.push('codex:123')
    state.wakePlans.codex = { resetAt: 123, scheduledFor: 124000, status: 'submitted', message: 'submitted', threadId: 'wake-thread' }
    await store.set(state)
    const restored = await new JsonStore(file).load()
    expect(restored.wakeReceipts).toEqual(['codex:123'])
    expect(restored.wakePlans.codex?.status).toBe('failed')
    expect(restored.wakePlans.codex?.message).toContain('不会重复')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
