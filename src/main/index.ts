import { app, BrowserWindow, ipcMain, shell, dialog, session } from 'electron'
import { join } from 'path'
import { Store } from './store'
import { StravaClient } from './strava'
import { SyncService } from './sync'
import { AnalysisEngine } from './analysis'
import { AdviceEngine } from './advice'
import { importFiles } from './import'
import type { AppSettings, SyncProgress } from '../shared/types'

let store: Store
let strava: StravaClient
let sync: SyncService
let analysis: AnalysisEngine
let advice: AdviceEngine
let mainWindow: BrowserWindow | null = null

function sendProgress(p: SyncProgress) {
  mainWindow?.webContents.send('sync:progress', p)
}

/** 应用代理设置：填写则强制走该代理，留空跟随系统 */
async function applyProxy() {
  const proxy = store?.getSettings().proxy?.trim()
  const ses = session.defaultSession
  if (proxy) {
    await ses.setProxy({ proxyRules: proxy, proxyBypassRules: '<local>' })
  } else {
    await ses.setProxy({ mode: 'system' })
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: '骑评 · 骑行数据点评',
    backgroundColor: '#0f1216',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(async () => {
  const dataDir = join(app.getPath('userData'), 'data')
  store = new Store(dataDir)
  strava = new StravaClient(store)
  analysis = new AnalysisEngine(store)
  advice = new AdviceEngine(store, analysis)
  sync = new SyncService(store, strava, (p) => sendProgress(p))

  await applyProxy()
  registerIpc()
  createWindow()

  // 启动时自动同步活动列表 + 近 30 天详细数据（静默，请求数少不会触发限流）
  if (store.getSettings().autoSync && strava.getStatus().connected) {
    sync
      .syncActivities()
      .catch(() => undefined)
      .then(() => sync.syncRecentStreams(30))
      .catch(() => undefined)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function registerIpc() {
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:save', async (_e, s: Partial<AppSettings>) => {
    const prevProxy = store.getSettings().proxy
    store.saveSettings(s)
    if (s.proxy !== undefined && s.proxy !== prevProxy) await applyProxy()
    return store.getSettings()
  })

  ipcMain.handle('strava:status', () => strava.getStatus())
  ipcMain.handle('strava:connect', async () => {
    try {
      await strava.authorize()
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) }
    }
  })
  ipcMain.handle('strava:disconnect', () => strava.disconnect())

  ipcMain.handle('sync:activities', async () => {
    try {
      return await sync.syncActivities()
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) }
    }
  })
  ipcMain.handle('sync:allStreams', async () => {
    try {
      return await sync.syncAllStreams()
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  ipcMain.handle('activities:list', (_e, filter) => {
    const list = store.listActivities(filter)
    const ftp = store.getFtp()
    return list.map((a) => {
      const { tss, method } = analysis.activityTss(a, ftp)
      return { ...a, tss, tssMethod: method }
    })
  })
  ipcMain.handle('activity:detail', async (_e, id: string) => {
    const activity = store.getActivity(id)
    if (!activity) return null
    let streams = store.getStreams(id)
    if (!streams && activity.source === 'strava') {
      try {
        streams = await sync.syncStreams(id)
      } catch {
        /* 离线或限流时返回已有数据 */
      }
    }
    const metrics = analysis.activityMetrics(activity)
    const decoupling = analysis.computeDecoupling(activity, streams)
    const review = advice.reviewActivity(
      activity,
      streams,
      { tss: Math.round(metrics.tss), tssMethod: metrics.method, intensityFactor: metrics.intensityFactor, np: metrics.np },
      decoupling
    )
    return {
      activity,
      streams,
      powerCurve: analysis.computePowerCurve(streams),
      timeInZones: analysis.computeTimeInZones(activity, streams),
      decoupling,
      tss: Math.round(metrics.tss),
      tssMethod: metrics.method,
      intensityFactor: metrics.intensityFactor,
      np: metrics.np,
      review
    }
  })

  ipcMain.handle('activity:delete', (_e, id: string) => {
    store.deleteActivity(id)
    return { ok: true }
  })

  ipcMain.handle('data:clear', () => {
    store.clearRides()
    analysis.resetMetrics()
    return { ok: true }
  })

  ipcMain.handle('dashboard:get', () => analysis.getDashboard())
  ipcMain.handle('trends:get', () => analysis.getTrends())
  ipcMain.handle('ability:get', () => analysis.getAbility())
  ipcMain.handle('advice:get', () => advice.getAdvice())
  ipcMain.handle('ftp:estimate', () => analysis.estimateFtp())
  ipcMain.handle('ftp:recompute', () => {
    analysis.recomputeFtp()
    return store.getSettings()
  })

  ipcMain.handle('import:files', async () => {
    if (!mainWindow) return { imported: 0 }
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '导入骑行文件',
      filters: [{ name: '骑行数据', extensions: ['fit', 'gpx'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled || res.filePaths.length === 0) return { imported: 0 }
    const result = await importFiles(store, res.filePaths)
    analysis.recomputeFtp()
    return result
  })
}
