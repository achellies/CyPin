import { net, shell } from 'electron'
import { Store } from './store'
import type { Activity, Streams } from '../shared/types'

const TOKEN_FILE = 'strava-token.json'
const REDIRECT_PORT = 8765
const SCOPES = 'read,profile:read_all,activity:read_all'

interface TokenData {
  access_token: string
  refresh_token: string
  expires_at: number
  athlete?: { id: number; firstname?: string; lastname?: string }
}

/** Strava OAuth + API 客户端（使用 Electron net 走系统代理） */
export class StravaClient {
  constructor(private store: Store) {}

  private tokenFile() {
    return `${this.store.dir}/${TOKEN_FILE}`
  }

  private token: TokenData | null = null
  private loadToken() {
    if (this.token) return this.token
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs') as typeof import('fs')
      this.token = JSON.parse(fs.readFileSync(this.tokenFile(), 'utf-8'))
    } catch {
      this.token = null
    }
    return this.token
  }

  private saveToken(t: TokenData | null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    if (t) fs.writeFileSync(this.tokenFile(), JSON.stringify(t, null, 2))
    else fs.rmSync(this.tokenFile(), { force: true })
    this.token = t
  }

  hasCredentials(): boolean {
    const s = this.store.getSettings()
    return !!(s.strava?.clientId && s.strava?.clientSecret)
  }

  getStatus() {
    const t = this.loadToken()
    return {
      connected: !!t,
      connectedAs: t?.athlete ? [t.athlete.firstname, t.athlete.lastname].filter(Boolean).join(' ') : null,
      credentialsOk: this.hasCredentials(),
      tokenExpired: !!t && t.expires_at * 1000 < Date.now()
    }
  }

  disconnect() {
    this.saveToken(null)
  }

  /** 浏览器授权流程：打开浏览器 → 本地服务器接收回调 → 换 token */
  async authorize() {
    if (!this.hasCredentials()) throw new Error('请先在设置中填写 Client ID / Client Secret')
    const s = this.store.getSettings()
    const redirectUri = `http://localhost:${REDIRECT_PORT}/callback`
    const authUrl =
      `https://www.strava.com/oauth/authorize?client_id=${encodeURIComponent(s.strava!.clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${SCOPES}` +
      `&approval_prompt=auto`

    const code = await new Promise<string>((resolve, reject) => {
      const server = require('http').createServer((req: any, res: any) => {
        const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`)
        if (url.pathname === '/callback') {
          const c = url.searchParams.get('code')
          const err = url.searchParams.get('error')
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(c ? '<h2>授权成功！请回到 BikeCycle 应用。</h2>' : `<h2>授权失败：${err || '未知错误'}</h2>`)
          setTimeout(() => server.close(), 500)
          if (c) resolve(c)
          else reject(new Error('用户取消了授权'))
        } else {
          res.writeHead(404)
          res.end()
        }
      })
      server.on('error', (e: any) => {
        if (e.code === 'EADDRINUSE') reject(new Error('回调端口 8765 被占用，请关闭占用该端口的程序后重试'))
        else reject(e)
      })
      server.listen(REDIRECT_PORT, async () => {
        shell.openExternal(authUrl)
      })
      // 5 分钟超时
      setTimeout(() => {
        server.close()
        reject(new Error('授权超时'))
      }, 5 * 60 * 1000).unref()
    })

    await this.exchangeToken(code, redirectUri)
  }

  private async exchangeToken(code: string, redirectUri: string) {
    const s = this.store.getSettings()
    const body = new URLSearchParams({
      client_id: s.strava!.clientId,
      client_secret: s.strava!.clientSecret,
      code,
      grant_type: 'authorization_code'
    })
    const res = await net.fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
    if (!res.ok) throw new Error(`换取 token 失败: HTTP ${res.status} ${await res.text()}`)
    const data = (await res.json()) as TokenData
    this.saveToken(data)
  }

  private async accessToken(): Promise<string> {
    const t = this.loadToken()
    if (!t) throw new Error('未连接 Strava')
    if (t.expires_at * 1000 > Date.now() + 60_000) return t.access_token
    // 刷新
    const s = this.store.getSettings()
    const body = new URLSearchParams({
      client_id: s.strava!.clientId,
      client_secret: s.strava!.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token
    })
    const res = await net.fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
    if (!res.ok) throw new Error(`刷新 token 失败: HTTP ${res.status}`)
    const data = (await res.json()) as TokenData
    this.saveToken({ ...t, ...data })
    return data.access_token
  }

  /** 带限流处理的 GET */
  private async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const token = await this.accessToken()
    const qs = params
      ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]) as [string, string][])
      : ''
    const res = await net.fetch(`https://www.strava.com/api/v3${path}${qs}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 900)
      throw new Error(`RATE_LIMIT:${retryAfter}`)
    }
    if (res.status === 401) {
      // token 突然失效，强制刷新一次重试
      const t = this.loadToken()
      if (t) this.saveToken({ ...t, expires_at: 0 })
      const token2 = await this.accessToken()
      const res2 = await net.fetch(`https://www.strava.com/api/v3${path}${qs}`, {
        headers: { Authorization: `Bearer ${token2}` }
      })
      if (!res2.ok) throw new Error(`Strava API 错误: HTTP ${res2.status}`)
      return (await res2.json()) as T
    }
    if (!res.ok) throw new Error(`Strava API 错误: HTTP ${res.status}`)
    return (await res.json()) as T
  }

  async getAthlete() {
    return this.get<any>('/athlete')
  }

  /** 分页拉取骑行类活动（增量：after=上次同步时间） */
  async fetchActivities(after?: Date, perPage = 100): Promise<any[]> {
    const out: any[] = []
    let page = 1
    for (;;) {
      const params: Record<string, string | number> = { per_page: perPage, page }
      if (after) params.after = Math.floor(after.getTime() / 1000)
      const items = await this.get<any[]>('/athlete/activities', params)
      if (!items.length) break
      out.push(...items)
      if (items.length < perPage) break
      page++
      await this.throttle()
    }
    return out
  }

  async fetchStreams(activityId: number): Promise<any[]> {
    const keys = 'time,latlng,distance,altitude,velocity_smooth,heartrate,cadence,watts,moving,grade_smooth'
    return this.get<any[]>(`/activities/${activityId}/streams`, { keys, key_by_type: 'false' })
  }

  private lastCall = 0
  /** 简单限流：两次调用至少间隔 150ms，避免打满 200/15min */
  private async throttle() {
    const wait = this.lastCall + 150 - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastCall = Date.now()
  }

  /** Strava 活动摘要 → 本地 Activity */
  mapSummary(raw: any): Activity {
    return {
      id: String(raw.id),
      source: 'strava',
      name: raw.name ?? '',
      type: raw.type ?? raw.sport_type ?? 'Ride',
      startDate: raw.start_date,
      distance: raw.distance ?? 0,
      movingTime: raw.moving_time ?? 0,
      elapsedTime: raw.elapsed_time ?? 0,
      totalElevationGain: raw.total_elevation_gain ?? 0,
      averageSpeed: raw.average_speed ?? 0,
      maxSpeed: raw.max_speed ?? 0,
      averageHeartrate: raw.average_heartrate,
      maxHeartrate: raw.max_heartrate,
      averageWatts: raw.average_watts,
      weightedAverageWatts: raw.weighted_average_watts,
      maxWatts: raw.max_watts,
      kilojoules: raw.kilojoules,
      averageCadence: raw.average_cadence,
      sufferScore: raw.suffer_score,
      calories: raw.calories,
      hasHeartrate: !!raw.has_heartrate,
      deviceWatts: !!raw.device_watts,
      trainer: !!raw.trainer,
      commute: !!raw.commute,
      startLatlng: raw.start_latlng && raw.start_latlng[0] != null ? raw.start_latlng : undefined,
      endLatlng: raw.end_latlng && raw.end_latlng[0] != null ? raw.end_latlng : undefined,
      mapSummary: raw.map?.summary_polyline
    }
  }

  /** Strava streams → 本地 Streams。兼容数组格式与 key_by_type 对象格式（实测返回对象） */
  mapStreams(raw: any[] | Record<string, { data?: any[] }> | null): Streams {
    const byType: Record<string, any> = {}
    if (Array.isArray(raw)) {
      for (const s of raw) byType[s.type] = s.data
    } else if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) byType[k] = (v as any)?.data ?? v
    }
    const time: number[] = byType.time || []
    const s: Streams = {
      time,
      latlng: byType.latlng,
      distance: byType.distance || [],
      altitude: byType.altitude || [],
      velocitySmooth: byType.velocity_smooth,
      heartrate: byType.heartrate,
      cadence: byType.cadence,
      watts: byType.watts,
      moving: byType.moving
    }
    return s
  }
}
