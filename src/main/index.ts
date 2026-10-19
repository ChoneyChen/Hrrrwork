import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, Notification, shell, Tray } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RelaySettings, RelaySnapshot } from '../shared/types'
import { setStartAtLogin } from './autostart'
import { RelayEngine } from './relay/RelayEngine'
import { JsonStore } from './store'
import { ClaudeCode } from './providers/ClaudeCode'
import { UpdateManager } from './updates/UpdateManager'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
// Keep existing settings and queued relays when upgrading from the original name.
app.setPath('userData', path.join(app.getPath('appData'), 'sleep-relay'))
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let engine: RelayEngine | null = null
let updates: UpdateManager | null = null
let isQuitting = false

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

app.on('second-instance', () => showWindow())

app.whenReady().then(async () => {
  updates = new UpdateManager({
    version: app.getVersion(), directory: path.join(app.getPath('userData'), 'updates'),
    platform: process.platform, arch: process.arch, appImage: !!process.env.APPIMAGE,
    debian: existsSync('/etc/debian_version'), background: app.isPackaged,
    fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, { ...init, bypassCustomProtocolHandlers: true })
  })
  updates.on('state', (state) => mainWindow?.webContents.send('updates:state', state))
  const store = new JsonStore(path.join(app.getPath('userData'), 'relay-state.json'))
  const bridgeScript = app.isPackaged ? path.join(process.resourcesPath, 'claude-bridge.cjs') : path.resolve('resources/claude-bridge.cjs')
  engine = new RelayEngine(
    store,
    setStartAtLogin,
    (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show()
    },
    new ClaudeCode(bridgeScript),
    path.join(app.getPath('userData'), 'wake')
  )

  createWindow()
  createTray()
  registerIpc()
  engine.on('state', (snapshot: RelaySnapshot) => {
    updates?.configure(snapshot.settings.updates)
    mainWindow?.webContents.send('relay:snapshot', snapshot)
    updateTray(snapshot)
  })
  await engine.start()
  updates.configure(engine.snapshot().settings.updates)

  if (process.argv.includes('--hidden')) mainWindow?.hide()
})

app.on('before-quit', () => {
  isQuitting = true
  void engine?.stop()
  updates?.stop()
})

app.on('window-all-closed', () => {
  // Hrrrwork lives in the tray on every desktop platform.
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 680,
    show: false,
    title: 'Hrrrwork',
    backgroundColor: '#f6f1e8',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 17 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      scrollBounce: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(currentDirectory, '../renderer/index.html'))
  }
}

function showWindow(): void {
  if (!mainWindow) return
  mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

function createTray(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.resolve('resources/icon.png')
  const image = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 })
  tray = new Tray(image)
  tray.setToolTip('Hrrrwork · 睡眠接力')
  tray.on('click', () => showWindow())
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Hrrrwork', click: () => showWindow() },
    { label: '立即检查', click: () => void engine?.refresh() },
    { label: '检查软件更新', click: () => { showWindow(); void updates?.check() } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]))
}

function updateTray(snapshot: RelaySnapshot): void {
  if (!tray) return
  const waiting = snapshot.queue.length
  const state = snapshot.settings.enabled ? '巡夜中' : Object.values(snapshot.settings.quotaWake).some(setting => setting.enabled) ? '接力暂停 · 唤醒开启' : '已暂停'
  tray.setToolTip(`Hrrrwork · ${state}${waiting ? ` · ${waiting} 个待接力` : ''}`)
}

function registerIpc(): void {
  ipcMain.handle('updates:get', () => updates?.snapshot())
  ipcMain.handle('updates:check', () => updates?.check())
  ipcMain.handle('updates:download', () => updates?.download())
  ipcMain.handle('updates:reveal', async () => {
    if (updates) shell.showItemInFolder(await updates.installerPath())
  })
  ipcMain.handle('relay:get-snapshot', () => engine?.snapshot())
  ipcMain.handle('relay:refresh', () => engine?.refresh())
  ipcMain.handle('relay:connect-claude', () => engine?.connectClaude())
  ipcMain.handle('relay:disconnect-claude', () => engine?.disconnectClaude())
  ipcMain.handle('relay:update-settings', (_event, patch: Partial<RelaySettings>) => engine?.updateSettings(patch))
  ipcMain.handle('relay:toggle-watch', (_event, threadId: string) => engine?.toggleWatch(threadId))
  ipcMain.handle('relay:send-now', (_event, queueId: string) => engine?.sendNow(queueId))
  ipcMain.handle('relay:reveal-logs', async () => {
    await shell.openPath(app.getPath('userData'))
  })
}
