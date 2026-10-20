#!/usr/bin/env node
const readline = require('node:readline')
let loaded = false
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method } = JSON.parse(line)
  if (id === undefined) return
  let result = {}
  if (method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 18000 } } }
  if (method === 'thread/list') result = { data: [{ id: 'target', name: 'Isolated test', createdAt: 1, updatedAt: 2, status: { type: loaded ? 'idle' : 'notLoaded' } }] }
  if (method === 'thread/read') result = { thread: { id: 'target', status: { type: loaded ? 'idle' : 'notLoaded' } } }
  if (method === 'thread/turns/list') result = { data: [{ id: 'old', status: 'failed', error: { message: 'usage limit' } }] }
  if (method === 'thread/resume') { loaded = true; result = { thread: { id: 'target' } } }
  if (method === 'turn/start') result = { turn: { id: 'new' } }
  process.stdout.write(JSON.stringify({ id, result }) + '\n')
  if (method === 'turn/start') setTimeout(() => process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'target', turn: { id: 'new', status: 'completed' } } }) + '\n'), 80)
})
