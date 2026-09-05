import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/api'
import type { SyncProgress } from '../shared/types'

const api: Api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: unknown) => ipcRenderer.invoke('settings:save', s),

  stravaStatus: () => ipcRenderer.invoke('strava:status'),
  stravaConnect: () => ipcRenderer.invoke('strava:connect'),
  stravaDisconnect: () => ipcRenderer.invoke('strava:disconnect'),

  syncActivities: () => ipcRenderer.invoke('sync:activities'),
  syncAllStreams: () => ipcRenderer.invoke('sync:allStreams'),

  listActivities: (filter?: unknown) => ipcRenderer.invoke('activities:list', filter),
  getActivityDetail: (id: string) => ipcRenderer.invoke('activity:detail', id),

  getDashboard: () => ipcRenderer.invoke('dashboard:get'),
  getTrends: () => ipcRenderer.invoke('trends:get'),
  getAbility: () => ipcRenderer.invoke('ability:get'),
  getAdvice: () => ipcRenderer.invoke('advice:get'),
  estimateFtp: () => ipcRenderer.invoke('ftp:estimate'),
  recomputeFtp: () => ipcRenderer.invoke('ftp:recompute'),
  deleteActivity: (id: string) => ipcRenderer.invoke('activity:delete', id),
  clearData: () => ipcRenderer.invoke('data:clear'),

  importFiles: () => ipcRenderer.invoke('import:files'),

  onSyncProgress(cb: (p: SyncProgress) => void) {
    const listener = (_e: unknown, p: SyncProgress) => cb(p)
    ipcRenderer.on('sync:progress', listener)
    return () => ipcRenderer.removeListener('sync:progress', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
