import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

interface InstallOptions { directory: string; resources: string; platform: NodeJS.Platform; executable: string; home: string; appImage?: string }
interface Receipt { id: string; version: string; installer: string; digest: string; target: string; kind: 'mac' | 'windows' | 'deb' | 'appimage'; helper: string }
const safeVersion = (version: string): boolean => /^\d+\.\d+\.\d+$/.test(version)
const normalized = (file: string, windows = false): string => windows ? path.win32.normalize(file).toLowerCase() : path.resolve(file)

export function installTarget(options: InstallOptions): { kind: Receipt['kind']; target: string } {
  if (options.platform === 'darwin') {
    const bundle = options.executable.match(/^(.*\/Hrrrwork\.app)\/Contents\//)?.[1]
    return { kind: 'mac', target: bundle && !bundle.startsWith('/Volumes/') && !bundle.includes('/AppTranslocation/') ? bundle : path.posix.join(options.home, 'Applications', 'Hrrrwork.app') }
  }
  if (options.platform === 'win32') {
    if (path.win32.basename(options.executable).toLowerCase() !== 'hrrrwork.exe') throw new Error('请先安装 Windows 安装版，再使用关闭并安装。')
    return { kind: 'windows', target: options.executable }
  }
  if (options.platform === 'linux') return { kind: options.appImage ? 'appimage' : 'deb', target: options.appImage || options.executable }
  throw new Error('此平台暂不支持直接安装。')
}

async function digest(file: string): Promise<string> {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('安装包路径不安全。')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export class InstallCoordinator {
  private cleaning: Promise<'none' | 'pending' | 'failed' | 'cleaned'> | null = null
  private get receiptFile(): string { return path.join(this.options.directory, 'pending-install.json') }
  constructor(private readonly options: InstallOptions) {}

  async prepare(installer: string, version: string): Promise<{ executable: string; args: string[] }> {
    if (!safeVersion(version) || path.dirname(installer) !== path.resolve(this.options.directory) || !/^Hrrrwork-[\d.]+-(?:mac-(?:universal|arm64|x64)\.dmg|win-x64\.exe|linux-(?:amd64\.deb|x86_64\.AppImage))$/.test(path.basename(installer))) throw new Error('安装包不属于受管理的更新缓存。')
    const { kind, target } = installTarget(this.options)
    const extension = kind === 'windows' ? '.exe' : kind === 'mac' ? '.dmg' : kind === 'deb' ? '.deb' : '.AppImage'
    if (!installer.endsWith(extension)) throw new Error('安装包与当前应用安装方式不匹配。')
    const id = randomUUID(), helper = path.join(this.options.directory, `install-${id}${kind === 'windows' ? '.ps1' : '.sh'}`)
    const receipt: Receipt = { id, version, installer, digest: await digest(installer), target, kind, helper }
    await fs.copyFile(path.join(this.options.resources, kind === 'windows' ? 'update-install.ps1' : 'update-install.sh'), helper)
    await fs.chmod(helper, 0o700)
    await fs.writeFile(this.receiptFile, JSON.stringify(receipt), { mode: 0o600 })
    const marker = path.join(this.options.directory, 'install-result')
    await fs.rm(marker, { force: true })
    const args = [String(process.pid), installer, target, version, id, marker, kind]
    if (kind === 'windows') {
      const script = await fs.readFile(helper, 'utf8')
      const encodedArgs = Buffer.from(JSON.stringify(args)).toString('base64')
      const command = `$installArgs = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedArgs}')) | ConvertFrom-Json; & {\n${script}\n} @installArgs`
      return { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')] }
    }
    return { executable: '/bin/sh', args: [helper, ...args] }
  }

  async launch(command: { executable: string; args: string[] }): Promise<void> {
    const output = await fs.open(path.join(this.options.directory, 'install.log'), 'a', 0o600)
    try {
      const child = spawn(command.executable, command.args, { detached: true, stdio: ['ignore', output.fd, output.fd], windowsHide: true, env: { ...process.env, LD_LIBRARY_PATH: undefined, LD_PRELOAD: undefined, APPDIR: undefined, APPIMAGE: undefined } })
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
    } finally { await output.close() }
  }

  cleanup(version: string): Promise<'none' | 'pending' | 'failed' | 'cleaned'> {
    if (!this.cleaning) this.cleaning = this.cleanupOnce(version).finally(() => { this.cleaning = null })
    return this.cleaning
  }

  private async cleanupOnce(version: string): Promise<'none' | 'pending' | 'failed' | 'cleaned'> {
    let receipt: Receipt
    try { receipt = JSON.parse(await fs.readFile(this.receiptFile, 'utf8')) as Receipt } catch { return 'none' }
    const directory = path.resolve(this.options.directory)
    if (!/^[a-f0-9-]{36}$/.test(receipt.id) || !safeVersion(receipt.version) || path.dirname(receipt.installer) !== directory || !path.basename(receipt.installer).startsWith(`Hrrrwork-${receipt.version}-`) || !/^[a-f0-9]{64}$/.test(receipt.digest) || receipt.helper !== path.join(directory, `install-${receipt.id}${receipt.kind === 'windows' ? '.ps1' : '.sh'}`)) return 'failed'
    let result = ''
    try { result = await fs.readFile(path.join(directory, 'install-result'), 'utf8') } catch { return 'pending' }
    if (result !== receipt.id) return result === `failed:${receipt.id}` ? 'failed' : 'pending'
    if (version !== receipt.version) return 'pending'
    const current = installTarget(this.options)
    if (current.kind !== receipt.kind || normalized(current.target, current.kind === 'windows') !== normalized(receipt.target, current.kind === 'windows')) return 'pending'
    if (await digest(receipt.installer).catch(() => '') !== receipt.digest) return 'failed'
    await fs.rm(receipt.installer)
    await fs.rm(receipt.helper, { force: true })
    await fs.rm(path.join(directory, 'install-result'), { force: true })
    await fs.rm(this.receiptFile, { force: true })
    return 'cleaned'
  }
}
