import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { InstallCoordinator, installTarget } from './InstallCoordinator'
const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hrrrwork-install-'))
  roots.push(root)
  const directory = path.join(root, 'updates')
  await fs.mkdir(directory)
  const target = path.join(root, 'Hrrrwork App.AppImage')
  const file = path.join(directory, 'Hrrrwork-2.1.0-linux-x86_64.AppImage')
  await fs.writeFile(file, '#!/bin/sh\nexit 0\n')
  const options = { directory, resources: path.resolve('resources'), platform: 'linux' as const, executable: target, home: root, appImage: target }
  return { root, directory, target, file, options, coordinator: new InstallCoordinator(options) }
}
describe('verified install handoff', () => {
  it('keeps packages until the expected version starts from the expected location', async () => {
    const f = await fixture()
    await f.coordinator.prepare(f.file, '2.1.0')
    const receipt = JSON.parse(await fs.readFile(path.join(f.directory, 'pending-install.json'), 'utf8'))
    expect(await f.coordinator.cleanup('2.0.0')).toBe('pending')
    await fs.writeFile(path.join(f.directory, 'install-result'), receipt.id)
    expect(await f.coordinator.cleanup('2.0.0')).toBe('pending')
    expect(await new InstallCoordinator({ ...f.options, appImage: `${f.target}.other` }).cleanup('2.1.0')).toBe('pending')
    expect(await f.coordinator.cleanup('2.1.0')).toBe('cleaned')
    await expect(fs.access(f.file)).rejects.toThrow()
    expect(await f.coordinator.cleanup('2.1.0')).toBe('none')
  })
  it('retains installers after cancellation, failure or cache tampering', async () => {
    const f = await fixture()
    await f.coordinator.prepare(f.file, '2.1.0')
    const receipt = JSON.parse(await fs.readFile(path.join(f.directory, 'pending-install.json'), 'utf8'))
    await fs.writeFile(path.join(f.directory, 'install-result'), `failed:${receipt.id}`)
    expect(await f.coordinator.cleanup('2.1.0')).toBe('failed')
    await fs.access(f.file)
    await fs.writeFile(path.join(f.directory, 'install-result'), receipt.id)
    await fs.writeFile(f.file, 'changed')
    expect(await f.coordinator.cleanup('2.1.0')).toBe('failed')
    await fs.access(f.file)
  })
  it('rejects paths outside managed cache and mismatched installer formats', async () => {
    const f = await fixture()
    await expect(f.coordinator.prepare(path.join(f.root, 'outside.AppImage'), '2.1.0')).rejects.toThrow()
    await expect(f.coordinator.prepare(f.file, '../../2.1')).rejects.toThrow()
    const deb = path.join(f.directory, 'Hrrrwork-2.1.0-linux-amd64.deb')
    await fs.writeFile(deb, 'package')
    await expect(f.coordinator.prepare(deb, '2.1.0')).rejects.toThrow('不匹配')
  })
  it('selects installed Mac, translocated Mac, DEB and Windows targets', () => {
    const base = { directory: '/cache', resources: '/resources', executable: '', home: '/Users/a' }
    expect(installTarget({ ...base, platform: 'darwin', executable: '/Applications/Hrrrwork.app/Contents/MacOS/Hrrrwork' }).target).toBe('/Applications/Hrrrwork.app')
    expect(installTarget({ ...base, platform: 'darwin', executable: '/Volumes/Hrrrwork/Hrrrwork.app/Contents/MacOS/Hrrrwork' }).target).toBe('/Users/a/Applications/Hrrrwork.app')
    expect(installTarget({ ...base, platform: 'linux', executable: '/opt/Hrrrwork/hrrrwork' }).kind).toBe('deb')
    expect(installTarget({ ...base, platform: 'win32', executable: 'C:\\Apps\\Hrrrwork.exe' }).kind).toBe('windows')
  })
  it.skipIf(process.platform === 'win32')('runs AppImage replacement with spaces safely and marks success', async () => {
    const f = await fixture()
    await fs.writeFile(f.target, 'old package')
    await exec('/bin/sh', [path.resolve('resources/update-install.sh'), '99999999', f.file, f.target, '2.1.0', 'test-token', path.join(f.directory, 'result'), 'appimage'])
    expect(await fs.readFile(f.target, 'utf8')).toContain('#!/bin/sh')
    expect(await fs.readFile(path.join(f.directory, 'result'), 'utf8')).toBe('test-token')
    await fs.access(f.file)
  })
  it.skipIf(process.platform !== 'darwin')('stages and replaces only the requested Mac app bundle', async () => {
    const f = await fixture()
    const source = path.join(f.root, 'source app'), target = path.join(f.root, 'Hrrrwork.app')
    await fs.mkdir(path.join(source, 'Contents'), { recursive: true })
    await fs.writeFile(path.join(source, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>2.1.0</string></dict></plist>')
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'old'), 'old')
    await exec('/bin/sh', [path.resolve('resources/update-install.sh'), 'perform-mac', source, target, '2.1.0', 'test-token'])
    await expect(fs.access(path.join(target, 'old'))).rejects.toThrow()
    expect(await fs.readFile(path.join(target, 'Contents/Info.plist'), 'utf8')).toContain('2.1.0')
  })
})
