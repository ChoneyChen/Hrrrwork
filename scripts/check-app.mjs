import { app, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
app.on('window-all-closed', () => {})
const pause = () => new Promise(resolve => setTimeout(resolve, 80))
app.whenReady().then(async () => {
  try {
    for (const [width, height] of [[1180, 800], [960, 640], [960, 680], [1600, 1000]]) {
      const window = new BrowserWindow({ width, height, useContentSize: true, show: false, webPreferences: { offscreen: true } })
      const js = code => window.webContents.executeJavaScript(code)
      await window.loadFile(path.join(root, 'out/renderer/index.html'), { query: { capture: '1' } })
      await pause()
      for (const mode of ['watch', 'wake']) {
        if (mode === 'wake') { await js(`document.querySelectorAll('.mode-tabs button')[1].click()`); await pause() }
        const report = await js(`(() => { window.scrollTo(0,500); return { mode: ${JSON.stringify(mode)}, viewport: [innerWidth, innerHeight], scroll: [scrollX,scrollY], document: [document.documentElement.scrollWidth,document.documentElement.scrollHeight], panels: [...document.querySelectorAll('.screen .panel, .feature-hero, .quota-card')].map(n => {const r=n.getBoundingClientRect();return [r.right,r.bottom]}), clippedQuota: [...document.querySelectorAll('.quota-card')].some(n=>n.querySelector('.quota-footer').getBoundingClientRect().bottom>n.getBoundingClientRect().bottom-3), quota:[...document.querySelectorAll('.meter')].map(n=>Number(n.getAttribute('aria-valuenow'))) } })()`)
        if (report.document[0] > width || report.document[1] > height || report.scroll.some(v => v) || report.clippedQuota || report.panels.some(([right, bottom]) => right > width || bottom > height) || JSON.stringify(report.quota) !== '[68,66]') throw Error(JSON.stringify(report))
        console.log(JSON.stringify({ width, height, ...report }))
        await writeFile(path.join(os.tmpdir(), `hrrrwork-v2-${mode}-${width}.png`), (await window.webContents.capturePage()).toPNG())
      }
      await js(`document.querySelectorAll('.timing-tabs button')[1].click()`); await pause()
      const schedule = await js(`({ min:document.querySelector('[aria-label="首个唤醒时间"]').min, slots:document.querySelectorAll('.schedule-slots > span').length, disabled:document.querySelector('[aria-label="开启唤醒"]').disabled })`)
      if (!schedule.min || schedule.slots !== 4 || !schedule.disabled) throw Error('Invalid daily schedule editor: '+JSON.stringify(schedule))
      await js(`document.querySelector('.schedule-editor button').click()`); await pause()
      await js(`document.querySelector('[aria-label="开启唤醒"]').click()`); await pause()
      await js(`document.querySelectorAll('.mode-tabs button')[0].click()`); await pause()
      await js(`document.querySelector('[aria-label="开启巡夜"]').click()`); await pause()
      await js(`document.querySelectorAll('.mode-tabs button')[1].click()`); await pause()
      if (!await js(`document.querySelector('[aria-label="开启唤醒"]').getAttribute('aria-checked')==='true'`)) throw Error('Night watch must not disable wake')
      await js(`document.querySelector('[aria-label="设置"]').click()`); await pause()
      const settings = await js(`(() => {const n=document.querySelector('.settings-drawer');const r=n.getBoundingClientRect();return {overflow:n.scrollWidth>n.clientWidth,top:r.top,bottom:r.bottom}})()`)
      if (settings.overflow || settings.top < 0 || settings.bottom > height) throw Error(JSON.stringify(settings))
      await js(`document.querySelector('.update-actions button').click()`); await pause()
      if (!await js(`document.querySelector('.update-status').textContent.includes('最新版本')`)) throw Error('Update control failed')
      window.destroy()
    }
    app.quit()
  } catch (error) { console.error(error); app.exit(1) }
})
