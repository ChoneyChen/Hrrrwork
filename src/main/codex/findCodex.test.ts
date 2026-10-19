import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { discoverCodex, bundledCodex, type DiscoveryOptions } from './findCodex'
import { CodexAppServer } from './CodexAppServer'
import { cliLaunch } from '../providers/cliLaunch'

let directory = ''
let options: DiscoveryOptions
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hrrrwork-codex-discovery-'))
  options = { platform: 'linux', home: path.join(directory, 'home'), systemRoot: path.join(directory, 'system'), procRoot: path.join(directory, 'proc'), env: { PATH: '' } }
  await fs.mkdir(options.home!, { recursive: true })
})
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }) })
async function binary(relative: string, script = false): Promise<string> {
  const file = path.join(directory, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, script ? await fs.readFile(path.resolve('scripts/fixtures/codex-server.cjs')) : '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return file
}

describe('Linux Codex discovery', () => {
  it.each(['resources/codex-cli/bin/codex', 'resources/codex-cli/codex', 'resources/codex', 'resources/codex-cli/vendor/x86_64-unknown-linux-gnu/codex/codex'])('finds official DEB bundle layout %s with an empty desktop PATH', async layout => {
    const file = await binary(`system/usr/lib/chatgpt/${layout}`)
    expect(await discoverCodex('', options)).toMatchObject({ executable: file, source: '桌面端内置 CLI' })
  })
  it('resolves a GUI symlink to its bundled CLI rather than starting the GUI', async () => {
    const gui = await binary('system/usr/lib/chatgpt/ChatGPT')
    const cli = await binary('system/usr/lib/chatgpt/resources/codex-cli/bin/codex')
    const link = path.join(directory, 'home', 'codex')
    await fs.symlink(gui, link)
    expect((await discoverCodex(link, options)).executable).toBe(await fs.realpath(cli))
  })
  it.each(['.nvm/versions/node/v24.20.0/bin/codex', '.local/share/fnm/node-versions/v24.20.0/installation/bin/codex', '.asdf/installs/nodejs/24.20.0/bin/codex', '.npm-global/bin/codex', '.local/bin/codex'])('finds %s without sourcing shell configuration', async layout => {
    const file = await binary(`home/${layout}`)
    expect((await discoverCodex('', options)).executable).toBe(file)
  })
  it('uses an arbitrary inherited PATH entry and rejects invalid manual paths and directories', async () => {
    const file = await binary('custom/bin/codex')
    options.env = { PATH: path.dirname(file) }
    expect((await discoverCodex('', options)).executable).toBe(file)
    expect((await discoverCodex('/missing/manual/codex', options)).executable).toBeNull()
    expect((await discoverCodex(path.dirname(file), options)).executable).toBeNull()
  })
  it('follows a same-user running desktop and copies only its Codex location overrides', async () => {
    const gui = await binary('custom/ChatGPT')
    const cli = await binary('custom/resources/codex-cli/bin/codex')
    const proc = path.join(options.procRoot!, '123')
    await fs.mkdir(proc, { recursive: true })
    await fs.symlink(gui, path.join(proc, 'exe'))
    await fs.writeFile(path.join(proc, 'cmdline'), `${gui}\0`)
    await fs.writeFile(path.join(proc, 'status'), 'PPid:\t1\n')
    await fs.writeFile(path.join(proc, 'environ'), 'CODEX_HOME=/custom/state\0CODEX_SQLITE_HOME=/custom/db\0SECRET_TOKEN=not-copied\0')
    const result = await discoverCodex('', options)
    expect(result).toMatchObject({ executable: cli, codeHome: '/custom/state', sqliteHome: '/custom/db' })
    expect(JSON.stringify(result)).not.toContain('not-copied')
  })
  it('still finds installed DEB resources if /proc cannot be inspected', async () => {
    const cli = await binary('system/usr/lib/chatgpt/resources/codex-cli/bin/codex')
    options.procRoot = '/missing/proc'
    expect((await discoverCodex('', options)).executable).toBe(cli)
  })
})

it('launches an npm Node entry without node on PATH and preserves explicit state locations', async () => {
  const file = await binary('home/.nvm/versions/node/v24/bin/codex', true)
  const launch = await cliLaunch(file, 'codex', { PATH: '/not-on-path' })
  expect(launch.executable).toBe(process.execPath)
  expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1')
  const client = new CodexAppServer(file, { PATH: '/not-on-path', CODEX_HOME: directory, CODEX_SQLITE_HOME: path.join(directory, 'database') })
  try {
    await client.start()
    expect(await client.call('test/locations')).toEqual({ codeHome: directory, sqliteHome: path.join(directory, 'database') })
    expect(await client.call('thread/list')).toMatchObject({ data: [{ id: 'ubuntu-deb-task' }] })
  } finally { await client.stop() }
})

it.skipIf(process.platform !== 'linux')('discovers a real same-user process through Ubuntu /proc with no GUI PATH', async () => {
  const file = await binary('custom/bin/codex.js', true)
  let helper: ChildProcess | undefined
  try {
    helper = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,[${JSON.stringify(file)},'--hold'],{env:{...process.env,CODEX_HOME:${JSON.stringify(directory)}}}); child.on('spawn',()=>process.stdout.write(String(child.pid)+'\\n')); process.stdin.resume(); process.on('SIGTERM',()=>{child.kill();process.exit(0)});`], { stdio: ['pipe', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => { helper!.stdout!.once('data', () => resolve()); helper!.once('error', reject) })
    const result = await discoverCodex('', { ...options, procRoot: '/proc' })
    expect(result).toMatchObject({ executable: file, codeHome: directory, source: '运行中的 Codex CLI' })
  } finally { helper?.kill() }
})

it.skipIf(!process.env.HRRRWORK_CODEX_DEB_ROOT)('initializes the real official Linux DEB CLI in an isolated profile without account login', async () => {
  const file = await bundledCodex(path.join(process.env.HRRRWORK_CODEX_DEB_ROOT!, 'usr/lib/chatgpt'), 'linux')
  expect(file).toBeTruthy()
  const client = new CodexAppServer(file!, { CODEX_HOME: options.home!, CODEX_SQLITE_HOME: options.home! })
  try {
    await client.start()
    expect(await client.call('thread/list', { limit: 1, sourceKinds: ['vscode', 'cli', 'appServer'] })).toMatchObject({ data: [] })
  } finally { await client.stop() }
}, 30000)
