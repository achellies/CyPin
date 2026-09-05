import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { gunzipSync, gzipSync } from 'zlib'
import type { Activity, AppSettings, Streams } from '../shared/types'

export interface ActivityFilter {
  type?: string
  from?: string
  to?: string
  search?: string
}

const DEFAULT_SETTINGS: AppSettings = {
  ftp: { mode: 'auto', auto: null, manual: null },
  rideTypes: ['Ride', 'VirtualRide', 'GravelRide', 'MountainBikeRide']
}

/** JSON + gzip 文件存储：activities.json + streams/<id>.json.gz + settings.json */
export class Store {
  dir: string
  settingsFile: string
  activitiesFile: string
  streamsDir: string

  /** 数据版本号：任何数据变更（增删流/设置）都会自增，用于分析结果缓存失效 */
  version = 0

  private activities: Activity[] | null = null
  private settings: AppSettings | null = null
  onActivityChange?: () => void

  constructor(dataDir: string) {
    this.dir = dataDir
    this.settingsFile = join(dataDir, 'settings.json')
    this.activitiesFile = join(dataDir, 'activities.json')
    this.streamsDir = join(dataDir, 'streams')
    mkdirSync(this.streamsDir, { recursive: true })
  }

  // ---------- settings ----------
  getSettings(): AppSettings {
    if (!this.settings) {
      let s: AppSettings
      if (!existsSync(this.settingsFile)) {
        s = { ...DEFAULT_SETTINGS }
      } else {
        try {
          const raw = JSON.parse(readFileSync(this.settingsFile, 'utf-8'))
          s = { ...DEFAULT_SETTINGS, ...raw, ftp: { ...DEFAULT_SETTINGS.ftp, ...raw.ftp } }
        } catch {
          s = { ...DEFAULT_SETTINGS }
        }
      }
      this.settings = s
    }
    return this.settings
  }

  saveSettings(patch: Partial<AppSettings>) {
    const next = { ...this.getSettings(), ...patch }
    this.settings = next
    writeFileSync(this.settingsFile, JSON.stringify(next, null, 2))
    this.version++
  }

  /** 当前生效的 FTP */
  getFtp(): number | null {
    const s = this.getSettings()
    if (s.ftp.mode === 'manual' && s.ftp.manual) return s.ftp.manual
    return s.ftp.auto ?? s.ftp.manual ?? null
  }

  // ---------- activities ----------
  private loadActivities(): Activity[] {
    if (this.activities) return this.activities
    let list: Activity[] = []
    if (existsSync(this.activitiesFile)) {
      try {
        list = JSON.parse(readFileSync(this.activitiesFile, 'utf-8'))
      } catch {
        list = []
      }
    }
    this.activities = list
    return list
  }

  private persistActivities() {
    writeFileSync(this.activitiesFile, JSON.stringify(this.loadActivities()))
  }

  upsertActivities(items: Activity[]) {
    const map = new Map(this.loadActivities().map((a) => [a.id, a]))
    for (const a of items) map.set(a.id, a)
    this.activities = [...map.values()].sort(
      (x, y) => new Date(y.startDate).getTime() - new Date(x.startDate).getTime()
    )
    this.persistActivities()
    this.version++
    this.onActivityChange?.()
  }

  listActivities(filter?: ActivityFilter): Activity[] {
    let list = [...this.loadActivities()]
    if (filter?.type && filter.type !== 'all') list = list.filter((a) => a.type === filter.type)
    if (filter?.from) list = list.filter((a) => a.startDate >= filter.from!)
    if (filter?.to) list = list.filter((a) => a.startDate <= filter.to!)
    if (filter?.search) {
      const q = filter.search.toLowerCase()
      list = list.filter((a) => a.name.toLowerCase().includes(q))
    }
    return list.sort((x, y) => new Date(y.startDate).getTime() - new Date(x.startDate).getTime())
  }

  getActivity(id: string): Activity | undefined {
    return this.loadActivities().find((a) => a.id === id)
  }

  // ---------- streams ----------
  getStreams(id: string): Streams | null {
    const f = join(this.streamsDir, `${id}.json.gz`)
    if (!existsSync(f)) return null
    try {
      return JSON.parse(gunzipSync(readFileSync(f)).toString('utf-8')) as Streams
    } catch {
      return null
    }
  }

  saveStreams(id: string, s: Streams) {
    writeFileSync(join(this.streamsDir, `${id}.json.gz`), gzipSync(Buffer.from(JSON.stringify(s))))
    this.version++
  }

  hasStreams(id: string): boolean {
    return existsSync(join(this.streamsDir, `${id}.json.gz`))
  }

  streamIds(): Set<string> {
    return new Set(readdirSync(this.streamsDir).filter((f) => f.endsWith('.json.gz')).map((f) => f.replace('.json.gz', '')))
  }

  /** 删除单次活动及其 streams */
  deleteActivity(id: string) {
    this.activities = this.loadActivities().filter((a) => a.id !== id)
    this.persistActivities()
    const f = join(this.streamsDir, `${id}.json.gz`)
    if (existsSync(f)) rmSync(f)
    this.version++
    this.onActivityChange?.()
  }

  /** 清空全部骑行数据（保留设置与 Strava 授权） */
  clearRides() {
    this.activities = []
    writeFileSync(this.activitiesFile, '[]')
    for (const f of readdirSync(this.streamsDir)) rmSync(join(this.streamsDir, f))
    this.version++
    this.onActivityChange?.()
  }
}
