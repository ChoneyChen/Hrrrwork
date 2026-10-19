import { app, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  try {
    for (const [label, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
      const window = new BrowserWindow({ width, height, show: false, webPreferences: { offscreen: true } })
      await window.loadFile(path.join(root, 'docs/index.html'))
      await window.webContents.executeJavaScript(`Promise.all([...document.images].map(img => { img.loading = 'eager'; return img.decode(); }))`)
      const commands = await window.webContents.executeJavaScript(`(() => {
        const selected = [];
        for (const tab of document.querySelectorAll('[data-os]')) {
          tab.click();
          selected.push({ os: tab.dataset.os, command: document.getElementById('download-command').textContent, selected: tab.getAttribute('aria-selected') });
        }
        return selected;
      })()`)
      if (commands.length !== 3 || commands.some(item => item.selected !== 'true' || !item.command.includes('v2.0.2'))) throw new Error('Download commands did not switch correctly')
      await window.webContents.executeJavaScript(`document.querySelector('[data-os="mac"]').click();document.getElementById('mac-architecture').value='x64';document.getElementById('mac-architecture').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-preview="wake"]').click();`)
      if (!await window.webContents.executeJavaScript(`document.getElementById('download-command').textContent.includes('mac-x64.dmg')`)) throw new Error('Intel download command is incorrect')
      await window.webContents.executeJavaScript(`document.getElementById('preview-image').decode()`)
      if (!await window.webContents.executeJavaScript(`document.getElementById('preview-image').getAttribute('src')==='wake.png'`)) throw new Error('Wake preview did not switch')
      const report = await window.webContents.executeJavaScript(`({
        title: document.title,
        viewport: innerWidth,
        content: document.documentElement.scrollWidth,
        images: [...document.images].map(img => ({src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0})),
        brokenAnchors: [...document.querySelectorAll('a[href^="#"]')].filter(a => a.hash && !document.getElementById(a.hash.slice(1))).map(a => a.hash),
        downloads: [...document.querySelectorAll('a[href*="/releases/download/"]')].map(a => a.href)
      })`)
      if (report.content > report.viewport || report.images.some(img => !img.loaded) || report.brokenAnchors.length) {
        throw new Error(`${label}: ${JSON.stringify(report)}`)
      }
      await writeFile(path.join(os.tmpdir(), `hrrrwork-site-${label}.png`), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`document.getElementById('command-line').scrollIntoView({ block: 'center', behavior: 'instant' })`)
      await new Promise(resolve => setTimeout(resolve, 50))
      await writeFile(path.join(os.tmpdir(), `hrrrwork-command-${label}.png`), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`document.getElementById('wake').scrollIntoView({ block: 'start', behavior: 'instant' })`)
      await new Promise(resolve => setTimeout(resolve, 50))
      await writeFile(path.join(os.tmpdir(), `hrrrwork-wake-${label}.png`), (await window.webContents.capturePage()).toPNG())
      console.log(JSON.stringify({ label, ...report }))
      window.destroy()
    }
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
