import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    show: false,
    backgroundColor: '#f5f0e7',
    webPreferences: { offscreen: true }
  })
  await window.loadFile(path.join(root, 'out/renderer/index.html'), { query: { capture: '1' } })
  await new Promise((resolve) => setTimeout(resolve, 900))
  const image = await window.webContents.capturePage()
  await mkdir(path.join(root, 'docs'), { recursive: true })
  await writeFile(path.join(root, 'docs', 'dashboard.png'), image.toPNG())
  app.quit()
})
