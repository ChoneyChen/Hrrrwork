import { contextBridge, ipcRenderer } from 'electron'
import type { RelaySettings, RelaySnapshot, HrrrworkApi } from '../shared/types'

const api: HrrrworkApi = {
  getSnapshot: () => ipcRenderer.invoke('relay:get-snapshot') as Promise<RelaySnapshot>,
  refresh: () => ipcRenderer.invoke('relay:refresh') as Promise<RelaySnapshot>,
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
