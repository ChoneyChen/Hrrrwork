import { promises as fs } from 'node:fs'
import path from 'node:path'

// Launch npm shims through the bundled runtime, without cmd.exe or a shell.
export async function cliLaunch(executable: string, tool: 'claude' | 'codex', overrides: NodeJS.ProcessEnv = {}): Promise<{ executable: string; prefix: string[]; env: NodeJS.ProcessEnv }> {
  const env = { ...process.env, ...overrides }
  if (process.platform === 'linux' && env.APPDIR) {
    for (const key of ['LD_LIBRARY_PATH', 'LD_PRELOAD']) {
      if (env[key]) env[key] = env[key]!.split(':').filter(directory => directory !== env.APPDIR && !directory.startsWith(`${env.APPDIR}/`)).join(':') || undefined
    }
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    const script = path.join(path.dirname(executable), 'node_modules', tool === 'claude' ? '@anthropic-ai/claude-code/cli.js' : '@openai/codex/bin/codex.js')
    await fs.access(script)
    return { executable: process.execPath, prefix: [script], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  if (process.platform !== 'win32') {
    const script = await fs.realpath(executable)
    const file = await fs.open(script, 'r')
    try {
      const header = Buffer.alloc(256)
      const { bytesRead } = await file.read(header, 0, header.length, 0)
      if (/^#![^\n]*\bnode(?:\s|$)/.test(header.subarray(0, bytesRead).toString('utf8'))) return { executable: process.execPath, prefix: [script], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
    } finally { await file.close() }
  }
  return { executable, prefix: [], env }
}
