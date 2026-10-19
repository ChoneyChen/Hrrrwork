import { constants, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CodexInstallation {
  executable: string | null
  source: string
  codeHome?: string
  sqliteHome?: string
}
export interface DiscoveryOptions {
  platform?: NodeJS.Platform
  home?: string
  env?: NodeJS.ProcessEnv
  systemRoot?: string
  procRoot?: string
  uid?: number
}
async function executable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await fs.access(file, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return (await fs.stat(file)).isFile()
  } catch { return false }
}
async function versionBins(base: string, suffix: string): Promise<string[]> {
  try { return (await fs.readdir(base)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(version => path.join(base, version, suffix)) } catch { return [] }
}

// Resolve the CLI inside the desktop bundle, never launch the GUI as an app-server.
export async function bundledCodex(root: string, platform: NodeJS.Platform): Promise<string | null> {
  const names = platform === 'win32' ? ['codex.exe', 'codex'] : ['codex']
  for (const directory of ['resources/codex-cli/bin', 'resources/codex-cli', 'resources', 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS', 'Contents/Resources/codex-cli/bin', 'Contents/Resources/codex-cli']) {
    for (const name of names) {
      const file = path.join(root, directory, name)
      if (await executable(file, platform)) return file
    }
  }
  const pending = [path.join(root, 'resources', 'codex-cli')]
  for (let checked = 0; pending.length && checked < 160; checked++) {
    const directory = pending.shift()!
    try {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isFile() && names.includes(entry.name) && await executable(file, platform)) return file
        if (entry.isDirectory() && path.relative(root, file).split(path.sep).length < 8 && !['node_modules', 'voice', 'codex-resources'].includes(entry.name)) pending.push(file)
      }
    } catch { /* Optional bundle layout */ }
  }
  return null
}

interface RunningCodex extends CodexInstallation { pid: number; root?: string }
async function runningCodex(options: DiscoveryOptions): Promise<RunningCodex[]> {
  const proc = options.procRoot ?? '/proc'
  const uid = options.uid ?? process.getuid?.()
  let pids: string[]
  try { pids = (await fs.readdir(proc)).filter(name => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a)).slice(0, 4096) } catch { return [] }
  const result: RunningCodex[] = []
  for (let offset = 0; offset < pids.length; offset += 24) {
    const batch = await Promise.all(pids.slice(offset, offset + 24).map(async pid => {
      try {
        const directory = path.join(proc, pid)
        if (Number(pid) === process.pid || (uid !== undefined && (await fs.stat(directory)).uid !== uid)) return null
        const [link, command, status] = await Promise.all([fs.readlink(path.join(directory, 'exe')), fs.readFile(path.join(directory, 'cmdline'), 'utf8'), fs.readFile(path.join(directory, 'status'), 'utf8')])
        if (Number(status.match(/^PPid:\s+(\d+)/m)?.[1]) === process.pid) return null
        const exe = link.replace(/ \(deleted\)$/, '')
        const basename = path.basename(exe).toLowerCase()
        const args = command.split('\0').filter(Boolean)
        let cli: string | null = null
        let root: string | undefined
        if (['chatgpt', 'codex'].includes(basename)) {
          const directory = path.dirname(exe)
          const bundled = await bundledCodex(directory, 'linux')
          if (bundled) { cli = bundled; root = directory }
          else if (basename === 'codex' && !await fs.access(path.join(directory, 'resources', 'app.asar')).then(() => true, () => false) && await executable(exe, 'linux')) cli = exe
        } else if (/^node(?:js)?$/.test(basename) && args[1] && /^codex(?:\.js|\.mjs)?$/.test(path.basename(args[1]))) {
          const script = path.isAbsolute(args[1]) ? args[1] : path.resolve(await fs.readlink(path.join(directory, 'cwd')), args[1])
          if (await executable(script, 'linux')) cli = script
        }
        if (!cli) return null
        // Copy only location overrides, never tokens or arbitrary process environment.
        let codeHome: string | undefined, sqliteHome: string | undefined
        try {
          for (const entry of (await fs.readFile(path.join(directory, 'environ'), 'utf8')).split('\0')) {
            if (entry.startsWith('CODEX_HOME=') && path.isAbsolute(entry.slice(11))) codeHome = entry.slice(11)
            if (entry.startsWith('CODEX_SQLITE_HOME=') && path.isAbsolute(entry.slice(18))) sqliteHome = entry.slice(18)
          }
        } catch { /* /proc permissions may restrict location overrides. */ }
        return { executable: cli, source: root ? '运行中的 DEB / 桌面端' : '运行中的 Codex CLI', codeHome, sqliteHome, pid: Number(pid), root } satisfies RunningCodex
      } catch { return null }
    }))
    result.push(...batch.filter((entry): entry is NonNullable<typeof entry> => entry !== null))
  }
  return result
}

export async function discoverCodex(preferred = '', options: DiscoveryOptions = {}): Promise<CodexInstallation> {
  const platform = options.platform ?? process.platform
  const home = options.home ?? os.homedir()
  const env = options.env ?? process.env
  const system = (file: string): string => options.systemRoot ? path.join(options.systemRoot, file.replace(/^\/+/, '')) : file
  const pathDirectories = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const normalize = (file: string): string => file.replace(/^(["'])(.*)\1$/, '$2').replace(/^~(?=[/\\])/, home)
  const resolved = async (candidate: string): Promise<string | null> => {
    if (!await executable(candidate, platform)) return null
    const real = await fs.realpath(candidate).catch(() => candidate)
    if (['chatgpt', 'chatgpt.exe', 'codex', 'codex.exe'].includes(path.basename(real).toLowerCase())) {
      const bundle = await bundledCodex(path.dirname(real), platform)
      if (bundle) return bundle
      if (await fs.access(path.join(path.dirname(real), 'resources', 'app.asar')).then(() => true, () => false)) return null
    }
    return candidate
  }
  if (preferred.trim()) {
    const file = normalize(preferred.trim())
    for (const candidate of /[/\\]/.test(file) ? [path.resolve(file)] : pathDirectories.map(directory => path.join(directory, file))) {
      const found = await resolved(candidate)
      if (found) return { executable: found, source: '手动指定' }
    }
    return { executable: null, source: '指定路径不是可执行的 Codex CLI，请修正或清空后自动检测。' }
  }
  if (env.CODEX_PATH) {
    const found = await resolved(normalize(env.CODEX_PATH))
    if (found) return { executable: found, source: 'CODEX_PATH' }
  }
  const processes = platform === 'linux' ? await runningCodex(options) : []
  if (processes[0]) return processes[0]
  const roots = platform === 'linux'
    ? ['/usr/lib/chatgpt', '/usr/lib/ChatGPT', '/usr/lib/codex', '/opt/chatgpt', '/opt/ChatGPT', '/opt/codex', '/opt/Codex', '/usr/share/chatgpt', '/usr/share/codex'].map(system)
    : platform === 'darwin'
      ? ['/Applications/ChatGPT.app', '/Applications/Codex.app', path.join(home, 'Applications', 'ChatGPT.app'), path.join(home, 'Applications', 'Codex.app')]
      : [path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'ChatGPT'), path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'Codex')]
  for (const root of roots) {
    const found = await bundledCodex(root, platform)
    if (found) return { executable: found, source: '桌面端内置 CLI' }
  }
  const extraDirectories = [env.CODEX_INSTALL_DIR, path.join(home, '.local', 'bin'), path.join(home, 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.npm', 'bin'), path.join(home, '.volta', 'bin'),
    ...(await versionBins(path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node'), 'bin')),
    ...(await versionBins(path.join(env.FNM_DIR || path.join(home, '.local', 'share', 'fnm'), 'node-versions'), 'installation/bin')),
    ...(await versionBins(path.join(home, '.asdf', 'installs', 'nodejs'), 'bin')),
    system('/usr/local/bin'), system('/usr/bin'), system('/bin'), ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : []),
    ...(platform === 'win32' ? [path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'), path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin')] : [])
  ].filter((entry): entry is string => Boolean(entry))
  for (const directory of new Set([...pathDirectories, ...extraDirectories])) for (const suffix of platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
    const found = await resolved(path.join(directory, `codex${suffix}`))
    if (found) return { executable: found, source: pathDirectories.includes(directory) ? 'PATH' : '常见 CLI 安装目录' }
  }
  return { executable: null, source: '未找到 Codex CLI；支持 DEB 内置资源、运行中的同用户进程及常见安装目录。' }
}

export async function findCodexExecutable(preferred = ''): Promise<string> {
  const installation = await discoverCodex(preferred)
  if (!installation.executable) throw new Error(installation.source)
  return installation.executable
}
