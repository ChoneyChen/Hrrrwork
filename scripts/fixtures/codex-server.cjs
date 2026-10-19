#!/usr/bin/env node
// Isolated protocol fixture. Never sends inference or reads real account data.
const readline = require('node:readline')
if (process.argv.includes('--hold')) setInterval(() => {}, 1000)
else readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const result = message.method === 'initialize' ? { userAgent: 'hrrrwork-test' }
    : message.method === 'thread/list' ? { data: [{ id: 'ubuntu-deb-task', name: 'Ubuntu fixture', createdAt: 1, updatedAt: 2 }] }
      : message.method === 'test/locations' ? { codeHome: process.env.CODEX_HOME, sqliteHome: process.env.CODEX_SQLITE_HOME }
        : {}
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n')
})
