import { app, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  try {
    for (const [width, height] of [[1180, 800], [960, 640], [960, 680], [1600, 1000]]) {
      const window = new BrowserWindow({ width, height, useContentSize: true, show: false, webPreferences: { offscreen: true } })
      await window.loadFile(path.join(root, 'out/renderer/index.html'), { query: { capture: '1' } })
      await new Promise(resolve => setTimeout(resolve, 150))
      const report = await window.webContents.executeJavaScript(`(() => {
        window.scrollTo(0, 500);
        const box = document.querySelector('.app-shell').getBoundingClientRect();
        const panels = [...document.querySelectorAll('.dashboard-grid > *')].map(node => { const r = node.getBoundingClientRect(); return { bottom: r.bottom, right: r.right }; });
        const clippedQuotas = [...document.querySelectorAll('.quota-card')].filter(card => card.querySelector('.quota-footer').getBoundingClientRect().bottom > card.getBoundingClientRect().bottom - 4).length;
        document.querySelectorAll('.provider-tab')[1].click();
        return { viewport: [innerWidth, innerHeight], scroll: [scrollX, scrollY], documentSize: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], box: [box.width, box.height], panels, clippedQuotas };
      })()`)
      if (report.clippedQuotas || report.scroll.some(v => v !== 0) || report.documentSize[0] > width || report.documentSize[1] > height || report.panels.some(p => p.bottom > height || p.right > width)) throw new Error(JSON.stringify(report))
      console.log(JSON.stringify(report))
      await new Promise(resolve => setTimeout(resolve, 50))
      await writeFile(path.join(os.tmpdir(), `hrrrwork-app-${width}-${height}.png`), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`document.querySelector('[aria-label="设置"]').click()`)
      await new Promise(resolve => setTimeout(resolve, 300))
      const settings = await window.webContents.executeJavaScript(`(() => {
        const drawer = document.querySelector('.settings-drawer');
        const bounds = drawer.getBoundingClientRect();
        return { width: drawer.clientWidth, content: drawer.scrollWidth, top: bounds.top, bottom: bounds.bottom, wake: !!document.getElementById('wake-title'), target: document.querySelector('[aria-label="唤醒目标"]').value };
      })()`)
      if (!settings.wake || settings.content > settings.width || settings.top < 0 || settings.bottom > height || settings.target !== 'new') throw new Error(JSON.stringify(settings))
      await writeFile(path.join(os.tmpdir(), `hrrrwork-settings-${width}-${height}.png`), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`document.querySelector('[aria-label="唤醒目标"]').value = 'existing'; document.querySelector('[aria-label="唤醒目标"]').dispatchEvent(new Event('change', {bubbles:true}));`)
      await new Promise(resolve => setTimeout(resolve, 50))
      if (!await window.webContents.executeJavaScript(`!!document.querySelector('[aria-label="唤醒对话"]')`)) throw new Error('Existing conversation selector did not open')
      window.destroy()
    }
    app.quit()
  } catch (error) { console.error(error); app.exit(1) }
})
