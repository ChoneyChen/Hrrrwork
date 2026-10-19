import { listPackage, extractFile } from '@electron/asar'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
const resources = process.platform === 'darwin' ? 'release/mac-arm64/Hrrrwork.app/Contents/Resources' : process.platform === 'win32' ? 'release/win-unpacked/resources' : 'release/linux-unpacked/resources'
const asar = path.join(resources, 'app.asar')
const files = listPackage(asar)
assert(!files.some(file => /(?:node_modules|\.test\.|\.map$)/.test(file)), 'Build-only dependencies or tests leaked into the application')
assert((await stat(asar)).size < 1024 * 1024, 'Application payload unexpectedly exceeds 1 MiB')
const version = JSON.parse(await readFile('package.json', 'utf8')).version
assert.equal(JSON.parse(extractFile(asar, 'package.json').toString()).version, version)
await access(path.join(resources, 'update-install.sh'))
await access(path.join(resources, 'update-install.ps1'))
console.log('Packaged application payload:', (await stat(asar)).size, 'bytes; no redundant dependency tree')
for (const file of await readdir('release')) if (/\.(dmg|deb|AppImage|exe)$/.test(file) && file.startsWith(`Hrrrwork-${version}-`)) console.log(file, (await stat(path.join('release', file))).size)
