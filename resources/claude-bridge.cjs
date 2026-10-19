// Runs with the bundled Electron runtime; no extra Node installation is required.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const base = path.join(os.homedir(), '.hrrrwork', 'claude')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { if (input.length < 1024 * 1024) input += chunk })
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input)
    const id = data.session_id
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return
    fs.mkdirSync(base, { recursive: true, mode: 0o700 })
    const file = path.join(base, `${id}.json`)
    let previous = {}
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    const mode = process.argv.at(-1)
    const event = data.hook_event_name
    const now = Date.now()
    const revision = event === 'UserPromptSubmit' ? String(now) : previous.revision || String(now)
    let status = previous.status || 'idle'
    if (event === 'UserPromptSubmit') status = 'active'
    if (event === 'Stop' || event === 'SessionEnd') status = previous.status === 'rate-limited' ? 'rate-limited' : 'idle'
    if (event === 'StopFailure') status = data.error === 'rate_limit' ? 'rate-limited' : 'idle'
    const state = {
      sessionId: id,
      cwd: typeof data.cwd === 'string' ? data.cwd : previous.cwd || '',
      name: data.session_name || previous.name || path.basename(data.cwd || '') || 'Claude Code 会话',
      revision,
      status,
      failedAt: event === 'StopFailure' && data.error === 'rate_limit' ? now : event === 'UserPromptSubmit' ? null : previous.failedAt || null,
      updatedAt: now,
      quotaUpdatedAt: data.rate_limits ? now : previous.quotaUpdatedAt || previous.updatedAt || now,
      rateLimits: data.rate_limits || previous.rateLimits || null
    }
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
    fs.renameSync(temporary, file)
    if (mode === 'status') {
      let original = ''
      try { original = JSON.parse(fs.readFileSync(path.join(base, 'original-status.json'), 'utf8')).command || '' } catch {}
      if (original) {
        // Preserve the user's pre-existing status line and its exact stdin.
        const child = spawnSync(original, { shell: true, input, encoding: 'utf8', timeout: 4000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
        if (child.stdout) process.stdout.write(child.stdout)
      } else process.stdout.write('☾ Hrrrwork · 接力守护中')
    }
  } catch { /* Hooks must never interrupt the user's Claude session. */ }
})
