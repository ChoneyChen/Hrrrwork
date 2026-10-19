import { listPackage, extractFile } from '@electron/asar'
import { access, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
const resources = process.platform === 'darwin' ? 'release/mac-arm64/Hrrrwork.app/Contents/Resources' : process.platform === 'win32' ? 'release/win-unpacked/resources' : 'release/linux-unpacked/resources'
const asar = path.join(resources, 'app.asar')
const files = listPackage(asar)
assert(!files.some(file => /(?:node_modules|\.test\.|\.map$)/.test(file)), 'Build-only dependencies or tests leaked into the application')
assert((await stat(asar)).size < 1024 * 1024, 'Application payload unexpectedly exceeds 1 MiB')
assert.equal(JSON.parse(extractFile(asar, 'package.json').toString()).version, '2.0.0')
await access(path.join(resources, 'update-install.sh'))
await access(path.join(resources, 'update-install.ps1'))
console.log('Packaged application payload:', (await stat(asar)).size, 'bytes; no redundant dependency tree')
for (const file of await readdir('release')) if (/\.(dmg|deb|AppImage|exe)$/.test(file) && file.startsWith('Hrrrwork-2.0.0-')) console.log(file, (await stat(path.join('release', file))).size)
