import { Store } from './store'
import { StravaClient } from './strava'
import { enrichActivity } from './analysis'
import type { Activity, SyncProgress } from '../shared/types'

export class SyncService {
  constructor(
    private store: Store,
    private strava: StravaClient,
    private progress: (p: SyncProgress) => void
  ) {}

  /** 增量同步活动摘要 */
  async syncActivities(): Promise<{ ok: boolean; added: number; updated: number; total: number; error?: string }> {
    if (!this.strava.getStatus().connected) {
      return { ok: false, added: 0, updated: 0, total: 0, error: '未连接 Strava' }
    }

    const last = this.store.getSettings().lastActivitySync
    const after = last ? new Date(last) : undefined
    // 多拉 3 天重叠，防止边缘数据遗漏
    const since = after ? new Date(after.getTime() - 3 * 86400_000) : undefined

    let raws: any[]
    try {
      raws = await this.withRateRetry(() => this.strava.fetchActivities(since))
    } catch (err: any) {
      return { ok: false, added: 0, updated: 0, total: 0, error: String(err?.message || err) }
    }

    const types = new Set(this.store.getSettings().rideTypes)
    const existing = new Map(this.store.listActivities().map((a) => [a.id, a]))
    let added = 0
    let updated = 0
    const items = raws
      .filter((r) => types.has(r.type ?? r.sport_type))
      .map((r) => {
        const mapped = this.strava.mapSummary(r)
        if (existing.has(mapped.id)) updated++
        else added++
        return mapped
      })
    this.store.upsertActivities(items)
    this.store.saveSettings({ lastActivitySync: new Date().toISOString() } as any)
    return { ok: true, added, updated, total: this.store.listActivities().length }
  }

  /** 拉取单次活动的 streams 并缓存，同时回填活动摘要 */
  async syncStreams(activityId: string) {
    const activity = this.store.getActivity(activityId)
    if (!activity || activity.source !== 'strava') return this.store.getStreams(activityId)
    if (this.store.hasStreams(activityId)) return this.store.getStreams(activityId)
    const raw = await this.withRateRetry(() => this.strava.fetchStreams(Number(activityId)))
    const streams = this.strava.mapStreams(raw)
    if (streams.time.length) {
      this.store.saveStreams(activityId, streams)
      this.store.upsertActivities([enrichActivity(activity, streams)])
    }
    return streams
  }

  /** 后台补全全部缺失 streams（带进度通知） */
  async syncAllStreams(): Promise<{ ok: boolean; synced: number; failed: number; error?: string }> {
    if (!this.strava.getStatus().connected) return { ok: false, synced: 0, failed: 0, error: '未连接 Strava' }
    const have = this.store.streamIds()
    const missing = this.store.listActivities().filter((a) => !have.has(a.id))
    return this.backfillStreams(missing)
  }

  /** 只补齐最近 N 天的缺失 streams（应用启动时静默调用，请求数少不触发限流） */
  async syncRecentStreams(days = 30): Promise<{ ok: boolean; synced: number; failed: number; error?: string }> {
    if (!this.strava.getStatus().connected) return { ok: false, synced: 0, failed: 0, error: '未连接 Strava' }
    const have = this.store.streamIds()
    const cutoff = Date.now() - days * 86400_000
    const missing = this.store
      .listActivities()
      .filter((a) => !have.has(a.id) && new Date(a.startDate).getTime() >= cutoff)
    return this.backfillStreams(missing)
  }

  private async backfillStreams(missing: Activity[]): Promise<{ ok: boolean; synced: number; failed: number; error?: string }> {
    let synced = 0
    let failed = 0
    for (let i = 0; i < missing.length; i++) {
      const a = missing[i]
      this.progress({
        phase: 'streams',
        current: i + 1,
        total: missing.length,
        message: `同步详细数据 ${i + 1}/${missing.length}：${a.name}`
      })
      try {
        await this.syncStreams(a.id)
        synced++
      } catch (err: any) {
        const msg = String(err?.message || err)
        console.warn(`[sync] streams ${a.id}「${a.name}」失败: ${msg}`)
        if (msg.startsWith('RATE_LIMIT')) {
          // 限流：等待后重试一次
          const sec = Math.min(Number(msg.split(':')[1] || 900), 900)
          this.progress({
            phase: 'streams',
            current: i,
            total: missing.length,
            message: `触发限流，等待 ${Math.round(sec / 60)} 分钟后自动继续…`
          })
          await new Promise((r) => setTimeout(r, (sec + 5) * 1000))
          try {
            await this.syncStreams(a.id)
            synced++
            continue
          } catch {
            /* 再失败则计入失败 */
          }
        }
        failed++
      }
      await new Promise((r) => setTimeout(r, 120))
    }
    return { ok: true, synced, failed }
  }

  /** 限流自动等待重试一次 */
  private async withRateRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err: any) {
      const msg = String(err?.message || err)
      if (msg.startsWith('RATE_LIMIT:')) {
        const sec = Math.min(Number(msg.split(':')[1] || 900), 900)
        this.progress({
          phase: 'activities',
          current: 0,
          total: 0,
          message: `触发 Strava 限流，等待 ${Math.round(sec / 60)} 分钟后自动继续…`
        })
        await new Promise((r) => setTimeout(r, (sec + 5) * 1000))
        return fn()
      }
      throw err
    }
  }
}
