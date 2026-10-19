import { contextBridge, ipcRenderer } from 'electron'
import type { RelaySettings, RelaySnapshot, HrrrworkApi, UpdateState } from '../shared/types'

const api: HrrrworkApi = {
  getUpdateState: () => ipcRenderer.invoke('updates:get'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  revealUpdate: () => ipcRenderer.invoke('updates:reveal'),
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState): void => listener(state)
    ipcRenderer.on('updates:state', handler)
    return () => ipcRenderer.removeListener('updates:state', handler)
  },
  getSnapshot: () => ipcRenderer.invoke('relay:get-snapshot') as Promise<RelaySnapshot>,
  refresh: () => ipcRenderer.invoke('relay:refresh') as Promise<RelaySnapshot>,
  connectClaude: () => ipcRenderer.invoke('relay:connect-claude') as Promise<RelaySnapshot>,
  disconnectClaude: () => ipcRenderer.invoke('relay:disconnect-claude') as Promise<RelaySnapshot>,
  updateSettings: (patch: Partial<RelaySettings>) => ipcRenderer.invoke('relay:update-settings', patch) as Promise<RelaySnapshot>,
  toggleWatch: (threadId: string) => ipcRenderer.invoke('relay:toggle-watch', threadId) as Promise<RelaySnapshot>,
  sendNow: (queueId: string) => ipcRenderer.invoke('relay:send-now', queueId) as Promise<RelaySnapshot>,
  revealLogs: () => ipcRenderer.invoke('relay:reveal-logs') as Promise<void>,
  onSnapshot: (listener: (snapshot: RelaySnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: RelaySnapshot): void => listener(snapshot)
    ipcRenderer.on('relay:snapshot', handler)
    return () => ipcRenderer.removeListener('relay:snapshot', handler)
  }
}

contextBridge.exposeInMainWorld('hrrrwork', api)
