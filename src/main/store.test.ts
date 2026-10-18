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
