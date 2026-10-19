import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newerVersion, selectAsset, UpdateManager } from './UpdateManager'

const bytes = Buffer.from('a verified Hrrrwork installation package')
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
function release(version = '1.3.0') {
  return { tag_name: `v${version}`, draft: false, prerelease: false,
    assets: ['mac-universal.dmg', 'win-x64.exe', 'linux-amd64.deb', 'linux-x86_64.AppImage'].map(suffix => {
      const name = `Hrrrwork-${version}-${suffix}`
      return { name, size: bytes.length, digest, browser_download_url: `https://github.com/ChoneyChen/Hrrrwork/releases/download/v${version}/${name}` }
    }) }
}
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); vi.useRealTimers() })
async function manager(body = bytes, metadata = release()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hrrrwork-update-test-'))
  temporary.push(directory)
  const fetcher = vi.fn(async (url: unknown) => String(url).includes('api.github.com') ? Response.json(metadata) : new Response(body))
  const updater = new UpdateManager({ version: '1.2.0', directory, platform: 'linux', arch: 'x64', debian: true, fetch: fetcher as typeof fetch, background: false })
  return { updater, fetcher, directory }
}

describe('release selection', () => {
  it('compares numeric stable versions only', () => {
    expect(newerVersion('v1.10.0', '1.9.2')).toBe(true)
    for (const version of ['1.2.0', '1.1.9', '1.3.0-beta', '../../1.3.0', 'latest']) expect(newerVersion(version, '1.2.0')).toBe(false)
  })
  it.each([
    ['darwin', 'arm64', false, false, 'mac-universal.dmg'], ['darwin', 'x64', false, false, 'mac-universal.dmg'],
    ['win32', 'x64', false, false, 'win-x64.exe'], ['linux', 'x64', false, true, 'linux-amd64.deb'],
    ['linux', 'x64', true, true, 'linux-x86_64.AppImage'], ['linux', 'x64', false, false, 'linux-x86_64.AppImage']
  ])('selects %s/%s package', (platform, arch, appImage, debian, suffix) => {
    expect(selectAsset(release(), { platform: platform as NodeJS.Platform, arch, appImage, debian })?.name).toBe(`Hrrrwork-1.3.0-${suffix}`)
  })
  it('does not serve x64 binaries to unsupported architectures', () => {
    for (const platform of ['linux', 'win32'] as const) expect(selectAsset(release(), { platform, arch: 'arm64' })).toBeNull()
    expect(selectAsset({ ...release(), prerelease: true }, { platform: 'darwin', arch: 'arm64' })).toBeNull()
  })
  it('rejects missing digests, unsafe URLs and oversized files', () => {
    for (const change of [{ digest: '' }, { browser_download_url: 'https://evil.example/installer' }, { size: 2 ** 40 }]) {
      const value = release(); Object.assign(value.assets[2], change)
      expect(() => selectAsset(value, { platform: 'linux', arch: 'x64', debian: true })).toThrow()
    }
  })
})

describe('update download', () => {
  it('automatically downloads, verifies and reuses the matching cache', async () => {
    const { updater, fetcher } = await manager()
    updater.configure({ autoCheck: true, autoDownload: true })
    expect((await updater.check()).status).toBe('ready')
    const installer = await updater.installerPath()
    expect(await fs.readFile(installer)).toEqual(bytes)
    await updater.check()
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(updater.snapshot().progress).toBe(100)
    updater.stop()
  })
  it('honors auto-download off and shares concurrent operations', async () => {
    const { updater, fetcher } = await manager()
    updater.configure({ autoCheck: false, autoDownload: false })
    const first = updater.check()
    expect(updater.check()).toBe(first)
    expect((await first).status).toBe('available')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const download = updater.download()
    expect(updater.download()).toBe(download)
    expect((await download).status).toBe('ready')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([Buffer.from('bad'), Buffer.alloc(bytes.length, 1), Buffer.alloc(bytes.length + 1)])('rejects a corrupt or incomplete payload', async (body) => {
    const { updater, directory } = await manager(body)
    await updater.check()
    expect((await updater.download()).status).toBe('error')
    expect(await fs.readdir(directory)).toEqual([])
    await expect(updater.installerPath()).rejects.toThrow()
  })
  it('revalidates the package before revealing it', async () => {
    const { updater } = await manager()
    await updater.check(); await updater.download()
    const installer = await updater.installerPath()
    await fs.writeFile(installer, Buffer.alloc(bytes.length, 0))
    await expect(updater.installerPath()).rejects.toThrow()
    expect((await updater.download()).status).toBe('ready')
  })
  it('does not downgrade or download an equal version', async () => {
    const { updater, fetcher } = await manager(bytes, release('1.2.0'))
    updater.configure({ autoCheck: true, autoDownload: true })
    expect((await updater.check()).status).toBe('current')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('reports network failures without crashing', async () => {
    const { updater, fetcher } = await manager()
    fetcher.mockRejectedValueOnce(new Error('offline'))
    expect((await updater.check()).status).toBe('error')
    expect((await updater.check()).status).toBe('available')
  })
  it('starts checking after 12s and repeats every six hours; switch off cancels the timer', async () => {
    const { directory, fetcher } = await manager()
    vi.useFakeTimers()
    const updater = new UpdateManager({ version: '1.2.0', directory, platform: 'linux', arch: 'x64', fetch: fetcher as typeof fetch })
    updater.configure({ autoCheck: true, autoDownload: false })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    updater.configure({ autoCheck: false, autoDownload: false })
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    updater.stop()
  })
})
