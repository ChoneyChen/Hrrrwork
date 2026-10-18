import { promises as fs } from 'node:fs'
import path from 'node:path'

// Launch npm shims through the bundled runtime, without cmd.exe or a shell.
export async function cliLaunch(executable: string, tool: 'claude' | 'codex'): Promise<{ executable: string; prefix: string[]; env: NodeJS.ProcessEnv }> {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    const script = path.join(path.dirname(executable), 'node_modules', tool === 'claude' ? '@anthropic-ai/claude-code/cli.js' : '@openai/codex/bin/codex.js')
    await fs.access(script)
    return { executable: process.execPath, prefix: [script], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { executable, prefix: [], env: process.env }
}
