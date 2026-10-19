import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type { UpdateSettings, UpdateState } from '../../shared/types'

const REPOSITORY = 'https://github.com/ChoneyChen/Hrrrwork'
const ENDPOINT = 'https://api.github.com/repos/ChoneyChen/Hrrrwork/releases/latest'
const MAX_SIZE = 1024 * 1024 * 1024
interface ReleaseAsset { name: string; size: number; digest: string; browser_download_url: string }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }
interface Target { platform: NodeJS.Platform; arch: string; appImage?: boolean; debian?: boolean }
interface Options extends Target {
  version: string
  directory: string
  fetch: typeof fetch
  background?: boolean
}

function versionParts(version: string): number[] | null {
  if (!/^v?\d+\.\d+\.\d+$/.test(version)) return null
  const values = version.replace(/^v/, '').split('.').map(Number)
  return values.every(Number.isSafeInteger) ? values : null
}
export function newerVersion(next: string, current: string): boolean {
  const a = versionParts(next), b = versionParts(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i] }
  return false
}

export function selectAsset(release: Release, target: Target): ReleaseAsset | null {
  if (!versionParts(release.tag_name) || release.draft || release.prerelease) return null
  const version = release.tag_name.replace(/^v/, '')
  const macSuffix = release.assets?.some(asset => asset.name === `Hrrrwork-${version}-mac-${target.arch}.dmg`) ? `mac-${target.arch}.dmg` : 'mac-universal.dmg'
  const suffix = target.platform === 'darwin' && ['arm64', 'x64'].includes(target.arch) ? macSuffix
    : target.platform === 'win32' && target.arch === 'x64' ? 'win-x64.exe'
      : target.platform === 'linux' && target.arch === 'x64' ? target.appImage || !target.debian ? 'linux-x86_64.AppImage' : 'linux-amd64.deb' : null
  if (!suffix) return null
  const name = `Hrrrwork-${version}-${suffix}`
  const asset = release.assets?.find(item => item.name === name)
  if (!asset) return null
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_SIZE || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) {
    throw new Error('发布包缺少有效的 SHA-256 校验信息，暂不下载。')
  }
  if (asset.browser_download_url !== `${REPOSITORY}/releases/download/${release.tag_name}/${name}`) throw new Error('更新包来源校验失败。')
  return asset
}

async function verified(file: string, asset: ReleaseAsset): Promise<boolean> {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.size) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return `sha256:${hash.digest('hex')}` === asset.digest
  } catch { return false }
}

export class UpdateManager extends EventEmitter {
  private state: UpdateState
  private settings: UpdateSettings = { autoCheck: false, autoDownload: false }
  private asset: ReleaseAsset | null = null
  private readyPath: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private checking: Promise<UpdateState> | null = null
  private downloading: Promise<UpdateState> | null = null
  private controller: AbortController | null = null
  private stopped = false
  private automaticDownload = false

  constructor(private readonly options: Options) {
    super()
    this.state = { status: 'idle', currentVersion: options.version, message: '更新检查尚未开始' }
  }

  snapshot(): UpdateState { return { ...this.state } }
  installationFailed(): void { this.publish({ status: 'error', message: '上次安装未完成，安装包已保留，可重新检查并安装。' }) }
  private publish(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    if (!this.stopped) this.emit('state', this.snapshot())
  }

  configure(settings: UpdateSettings): void {
    const changed = settings.autoCheck !== this.settings.autoCheck
    const enableDownload = settings.autoDownload && !this.settings.autoDownload
    this.settings = { autoCheck: settings.autoCheck === true, autoDownload: settings.autoDownload === true }
    if (changed) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      if (this.settings.autoCheck && this.options.background !== false && !this.stopped) this.schedule(12_000)
    }
    if (!settings.autoDownload && this.automaticDownload) this.controller?.abort()
    if (enableDownload && this.asset && this.state.status === 'available') void this.download(true)
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(async () => {
      this.timer = null
      await this.check()
      if (this.settings.autoCheck && !this.stopped) this.schedule(6 * 60 * 60 * 1000)
    }, delay)
    this.timer.unref()
  }

  check(): Promise<UpdateState> {
    if (this.stopped) return Promise.resolve(this.snapshot())
    if (this.downloading) return this.downloading
    if (this.checking) return this.checking
    this.checking = this.checkOnce().finally(() => { this.checking = null })
    return this.checking
  }

  private async checkOnce(): Promise<UpdateState> {
    const previous = this.snapshot()
    const previousAsset = this.asset
    this.publish({ status: 'checking', message: '正在检查 GitHub 正式版本…' })
    try {
      const response = await this.options.fetch(ENDPOINT, {
        signal: AbortSignal.timeout(20_000), credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Hrrrwork/${this.options.version}` }
      })
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub 检查频率受限，请稍后重试。' : `无法检查更新（HTTP ${response.status}）。`)
      const release = await response.json() as Release
      if (!versionParts(release.tag_name) || release.draft || release.prerelease || !Array.isArray(release.assets)) throw new Error('未找到有效的正式版本。')
      const latestVersion = release.tag_name.replace(/^v/, '')
      if (!newerVersion(latestVersion, this.options.version)) {
        this.asset = null; this.readyPath = null
        this.publish({ status: 'current', latestVersion, canDownload: false, checkedAt: Date.now(), progress: undefined, message: '已是最新版本，安心巡夜。' })
      } else {
        const asset = selectAsset(release, this.options)
        this.asset = asset
        this.publish({ status: asset ? 'available' : 'unsupported', latestVersion, canDownload: !!asset, checkedAt: Date.now(), progress: undefined,
          message: asset ? `发现 v${latestVersion}，可以下载更新。` : '此平台或架构暂无对应安装包，请到官网查看。' })
        if (asset) {
          const destination = path.join(this.options.directory, asset.name)
          if (await verified(destination, asset)) {
            this.readyPath = destination
            this.publish({ status: 'ready', progress: 100, message: '更新包已下载并通过 SHA-256 校验，可查看并安装。' })
          } else if (this.settings.autoDownload && !this.stopped) await this.download(true)
        }
      }
    } catch (error) {
      if (previous.status === 'ready') { this.asset = previousAsset; this.publish({ ...previous, message: '更新包已就绪；本次联网检查失败，可稍后重试。' }) }
      else this.publish({ status: 'error', message: error instanceof Error ? error.message : '检查失败，请检查网络后重试。' })
    }
    return this.snapshot()
  }

  download(automatic = false): Promise<UpdateState> {
    if (this.downloading) return this.downloading
    if (this.checking && !automatic) return this.checking.then(() => this.download())
    if (this.state.status === 'ready') return Promise.resolve(this.snapshot())
    if (!this.asset || this.stopped) return Promise.resolve(this.snapshot())
    this.automaticDownload = automatic
    this.downloading = this.downloadOnce(this.asset).finally(() => { this.downloading = null; this.automaticDownload = false })
    return this.downloading
  }

  private async downloadOnce(asset: ReleaseAsset): Promise<UpdateState> {
    const controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000)
    let stall: ReturnType<typeof setTimeout> | undefined
    const touch = (): void => { if (stall) clearTimeout(stall); stall = setTimeout(() => controller.abort(), 60_000) }
    const temporary = path.join(this.options.directory, `${asset.name}.${randomUUID()}.part`)
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    this.readyPath = null
    this.publish({ status: 'downloading', progress: 0, downloadedBytes: 0, totalBytes: asset.size, message: '正在后台下载，不影响巡夜…' })
    try {
      await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 })
      touch()
      const response = await this.options.fetch(asset.browser_download_url, { signal: controller.signal, credentials: 'omit', headers: { 'User-Agent': `Hrrrwork/${this.options.version}` } })
      if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}），请稍后重试。`)
      handle = await fs.open(temporary, 'wx', 0o600)
      reader = response.body.getReader()
      const hash = createHash('sha256')
      let bytes = 0, lastProgress = 0
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (controller.signal.aborted) throw new Error('下载已取消，可随时重试。')
        touch()
        bytes += value.byteLength
        if (bytes > asset.size) throw new Error('更新包大小异常，已拒绝保存。')
        hash.update(value)
        let offset = 0
        while (offset < value.length) offset += (await handle.write(value, offset, value.length - offset)).bytesWritten
        if (Date.now() - lastProgress > 200) {
          this.publish({ progress: Math.min(99, Math.floor(bytes / asset.size * 100)), downloadedBytes: bytes })
          lastProgress = Date.now()
        }
      }
      if (controller.signal.aborted) throw new Error('下载已取消，可随时重试。')
      if (bytes !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) throw new Error('更新包校验失败，已清理不完整文件，请重新下载。')
      await handle.sync(); await handle.close(); handle = undefined
      const destination = path.join(this.options.directory, asset.name)
      // Only this version's application-owned cache file may be replaced.
      await fs.rm(destination, { force: true })
      await fs.rename(temporary, destination)
      this.readyPath = destination
      this.publish({ status: 'ready', progress: 100, downloadedBytes: bytes, message: '更新包已下载并通过 SHA-256 校验，可查看并安装。' })
    } catch (error) {
      this.publish({ status: controller.signal.aborted ? 'available' : 'error', progress: undefined,
        message: controller.signal.aborted ? '下载已取消或超时，可重新下载。' : error instanceof Error ? error.message : '下载失败，请稍后重试。' })
    } finally {
      clearTimeout(timeout); if (stall) clearTimeout(stall)
      await reader?.cancel().catch(() => {})
      await handle?.close().catch(() => {})
      await fs.rm(temporary, { force: true }).catch(() => {})
      if (this.controller === controller) this.controller = null
    }
    return this.snapshot()
  }

  async installerPath(): Promise<string> {
    if (!this.readyPath || !this.asset || !await verified(this.readyPath, this.asset)) {
      this.readyPath = null
      this.publish({ status: 'error', message: '更新包不存在或已变化，请重新下载。' })
      throw new Error('更新包校验未通过，请重新下载。')
    }
    return this.readyPath
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.controller?.abort()
  }
}
