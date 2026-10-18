import { constants, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function nvmCandidates(home: string): Promise<string[]> {
  const versions = path.join(home, '.nvm', 'versions', 'node')
  try {
    const entries = await fs.readdir(versions)
    return entries
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => path.join(versions, version, 'bin', 'codex'))
  } catch {
    return []
  }
}

export async function findCodexExecutable(preferred = ''): Promise<string> {
  const home = os.homedir()
  const candidates: string[] = []

  if (preferred.trim()) candidates.push(preferred.trim())
  if (process.env.CODEX_PATH) candidates.push(process.env.CODEX_PATH)

  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      ...(await nvmCandidates(home))
    )
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    candidates.push(
      path.join(appData, 'npm', 'codex.cmd'),
      path.join(appData, 'npm', 'codex.exe'),
      path.join(localAppData, 'Programs', 'ChatGPT', 'resources', 'codex-cli', 'codex.exe'),
      path.join(localAppData, 'Programs', 'Codex', 'resources', 'codex-cli', 'codex.exe')
    )
  } else {
    candidates.push(
      path.join(home, '.local', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/usr/bin/codex',
      '/opt/ChatGPT/resources/codex-cli/codex',
      ...(await nvmCandidates(home))
    )
  }

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate
  }

  // Let Node resolve PATH. A useful spawn error will be shown if it is absent.
  return process.platform === 'win32' ? 'codex.cmd' : 'codex'
}
