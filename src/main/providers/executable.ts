import { constants, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export async function findExecutable(name: string, preferred = ''): Promise<string | null> {
  const home = os.homedir()
  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  directories.push(path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin')
  if (process.platform === 'win32') directories.push(path.join(process.env.APPDATA ?? '', 'npm'))
  try {
    const base = path.join(home, '.nvm', 'versions', 'node')
    const versions = await fs.readdir(base)
    directories.push(...versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(v => path.join(base, v, 'bin')))
  } catch { /* nvm is optional */ }
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const candidates = [preferred, ...directories.flatMap(dir => extensions.map(ext => path.join(dir, name + ext)))].filter(Boolean)
  if (name === 'claude') candidates.push(path.join(home, '.claude', 'local', 'claude'))
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      if ((await fs.stat(candidate)).isFile()) return candidate
    } catch { /* continue discovery */ }
  }
  return null
}
