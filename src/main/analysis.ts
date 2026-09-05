import { Store } from './store'
import type {
  AbilityData,
  Activity,
  CourseType,
  DashboardData,
  DashRange,
  LoadPoint,
  PowerCurve,
  RideCourse,
  Streams,
  TrendsData,
  WeekTraining
} from '../shared/types'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

/** 可信时间下限：早于 2001-01-01 的时间戳视为设备时钟错误（epoch 脏数据），不参与按日期的聚合与展示 */
const MIN_PLAUSIBLE_TS = Date.UTC(2001, 0, 1)
function plausibleDate(iso: string): boolean {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) && t >= MIN_PLAUSIBLE_TS
}

const POWER_ZONE_BOUNDS = [0.55, 0.75, 0.9, 1.05, 1.2, 1.5]
const POWER_ZONE_LABELS = ['Z1 恢复', 'Z2 耐力', 'Z3 节奏', 'Z4 阈值', 'Z5 VO2', 'Z6 无氧', 'Z7 极限']
const HR_ZONE_LABELS = ['Z1 恢复', 'Z2 耐力', 'Z3 节奏', 'Z4 阈值', 'Z5 极限']
/** hrTSS 每小时系数（Z1-Z5） */
const HR_TSS_PER_HOUR = [35, 55, 75, 90, 105]

/** 仪表盘统计范围的起点时间戳：周/月/季为自然周期起点，半年/年为滚动窗口 */
function rangeStartTs(range: DashRange): number {
  const now = new Date()
  if (range === 'week') {
    const d = new Date(now)
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  if (range === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  if (range === 'quarter') return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1).getTime()
  if (range === 'half') return now.getTime() - 182 * 86400_000
  return now.getTime() - 365 * 86400_000
}

/** 各范围对应的负荷图天数（CTL 是 42 天指数加权，短于 28 天的曲线无意义，week 显示 28 天） */
const RANGE_LOAD_DAYS: Record<DashRange, number> = { week: 28, month: 31, quarter: 92, half: 182, year: 365 }

const POWER_CURVE_WINDOWS = [
  { seconds: 1, label: '1s' },
  { seconds: 5, label: '5s' },
  { seconds: 15, label: '15s' },
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '1min' },
  { seconds: 120, label: '2min' },
  { seconds: 300, label: '5min' },
  { seconds: 600, label: '10min' },
  { seconds: 1200, label: '20min' },
  { seconds: 3600, label: '60min' }
]

/** 能力分析页的功率-时间曲线窗口 */
const PD_WINDOWS = [
  { seconds: 5, label: '5s' },
  { seconds: 15, label: '15s' },
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '1min' },
  { seconds: 120, label: '2min' },
  { seconds: 300, label: '5min' },
  { seconds: 600, label: '10min' },
  { seconds: 1200, label: '20min' },
  { seconds: 1800, label: '30min' },
  { seconds: 3600, label: '60min' }
]

interface CachedMetrics {
  [id: string]: { ftp: number; tss: number; method: string; np?: number }
}

/** 页面级结果缓存：数据版本号或 FTP 变化时自动失效；键支持动态参数（如 dashboard:quarter） */
type CachedPage = string

const dayStr = (iso: string) => iso.slice(0, 10)

export class AnalysisEngine {
  private metricsFile: string
  private metrics: CachedMetrics
  private pageCache = new Map<CachedPage, { key: string; data: unknown }>()

  constructor(private store: Store) {
    this.metricsFile = join(store.dir, 'computed-metrics.json')
    try {
      this.metrics = existsSync(this.metricsFile) ? JSON.parse(readFileSync(this.metricsFile, 'utf-8')) : {}
    } catch {
      this.metrics = {}
    }
  }

  /** 页面结果缓存：相同数据版本直接返回上次结果（页面反复切换零开销） */
  private cached<T>(page: CachedPage, fn: () => T): T {
    const key = `${this.store.version}:${this.store.getFtp() ?? ''}`
    const hit = this.pageCache.get(page)
    if (hit && hit.key === key) return hit.data as T
    const data = fn()
    this.pageCache.set(page, { key, data })
    return data
  }

  private persistMetrics() {
    writeFileSync(this.metricsFile, JSON.stringify(this.metrics))
  }

  /** 清空计算缓存（清空骑行数据后调用） */
  resetMetrics() {
    this.metrics = {}
    this.pageCache.clear()
    try {
      if (existsSync(this.metricsFile)) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs') as typeof import('fs')
        fs.rmSync(this.metricsFile, { force: true })
      }
    } catch {
      /* ignore */
    }
  }

  // ---------- 心率区间 ----------
  hrZoneBounds(): number[] {
    const s = this.store.getSettings()
    const base = s.lthr ?? s.maxHr
    if (s.lthr) return [0.68, 0.83, 0.94, 1.05].map((r) => Math.round(s.lthr! * r))
    if (s.maxHr) return [0.6, 0.7, 0.8, 0.9].map((r) => Math.round(s.maxHr! * r))
    // 从历史数据推断 maxHr
    const observed = this.store
      .listActivities()
      .map((a) => a.maxHeartrate ?? 0)
      .reduce((m, v) => Math.max(m, v), 0)
    if (observed > 100) return [0.6, 0.7, 0.8, 0.9].map((r) => Math.round(observed * r))
    return [120, 140, 160, 175]
  }

  hrZoneIndex(bpm: number): number {
    const b = this.hrZoneBounds()
    for (let i = 0; i < b.length; i++) if (bpm <= b[i]) return i
    return 4
  }

  // ---------- TSS ----------
  /** 计算单次活动 TSS（功率 > 心率 > 估算），带缓存 */
  activityTss(a: Activity, ftp: number | null): { tss: number; method: string; np?: number } {
    if (ftp && a.weightedAverageWatts && a.deviceWatts) {
      const np = a.weightedAverageWatts
      const if_ = np / ftp
      const tss = ((a.movingTime * np * if_) / (ftp * 3600)) * 100
      return { tss: Math.round(tss * 10) / 10, method: 'power', np }
    }
    const cached = this.metrics[a.id]
    if (cached && cached.ftp === ftp) return cached as any
    let result: { tss: number; method: string; np?: number }

    const streams = this.store.getStreams(a.id)
    if (streams?.heartrate?.length && streams.heartrate.some((v) => v > 0)) {
      const zones = this.timeInHrZones(streams)
      let tss = 0
      zones.forEach((sec, i) => {
        tss += (sec / 3600) * HR_TSS_PER_HOUR[i]
      })
      result = { tss: Math.round(tss * 10) / 10, method: 'hr' }
    } else if (a.averageHeartrate && a.averageHeartrate > 60) {
      // 只有平均心率：按平均心率所在区间估算，打折
      const zi = this.hrZoneIndex(a.averageHeartrate)
      result = {
        tss: Math.round((a.movingTime / 3600) * HR_TSS_PER_HOUR[zi] * 0.8 * 10) / 10,
        method: 'hr-approx'
      }
    } else {
      // 无功率无心率：按中等强度估算
      result = { tss: Math.round((a.movingTime / 3600) * 40 * 10) / 10, method: 'estimate' }
    }
    this.metrics[a.id] = { ftp: ftp ?? 0, tss: result.tss, method: result.method }
    return result
  }

  /** 批量重算 TSS 缓存（FTP 变化后调用） */
  recomputeFtp() {
    const ftp = this.estimateFtp().recommended
    const s = this.store.getSettings()
    this.store.saveSettings({ ftp: { ...s.ftp, auto: ftp } })
    this.metrics = {}
    this.pageCache.clear()
    const ftpNow = this.store.getFtp()
    for (const a of this.store.listActivities()) {
      this.activityTss(a, ftpNow)
    }
    this.persistMetrics()
  }

  // ---------- FTP 估算 ----------
  /**
   * 由最佳功率窗口推算 FTP 候选：
   * 1) 20 分钟法：best20 × 0.95（标准 Coggan 公式）
   * 2) 3/12 分钟临界功率 CP 模型（CP 与 FTP 接近，对有氧型骑手更准）
   * 取两者较大值——日常骑行未全力时 20min 法偏保守，CP 更能反映有氧能力。
   */
  private ftpFromBest(best: Map<number, number>): {
    from20: number | null
    cp: number | null
    wPrime: number | null
    estimate: number | null
  } {
    const best20 = best.get(1200) ?? null
    const best3 = best.get(180)
    const best12 = best.get(720)
    const from20 = best20 ? Math.round(best20 * 0.95) : null
    let cp: number | null = null
    let wPrime: number | null = null
    if (best3 && best12) {
      cp = Math.round((best12 * 720 - best3 * 180) / (720 - 180))
      wPrime = Math.round((best3 - cp) * 180)
      // CP 模型在数据不足时可能离谱，钳制到 20min 法 ±15%
      if (from20 && (cp < from20 * 0.85 || cp > from20 * 1.15)) cp = null
    }
    const estimate = from20 != null ? Math.max(from20, cp ?? 0) : cp
    return { from20, cp, wPrime, estimate }
  }

  estimateFtp(): {
    recommended: number | null
    from20min: number | null
    cp: number | null
    wPrime: number | null
    best20: number | null
    basedOn: number // 有功率 streams 的活动数
  } {
    const best = this.globalPowerBest()
    const best20 = best.get(1200) ?? null
    const { from20, cp, wPrime, estimate } = this.ftpFromBest(best)
    const withPower = this.countStreamsWithPower()
    const recommended = estimate ?? this.store.getSettings().ftp.manual ?? null
    return { recommended, from20min: from20, cp, wPrime, best20, basedOn: withPower }
  }

  private countStreamsWithPower(): number {
    let n = 0
    for (const a of this.store.listActivities()) {
      if (a.deviceWatts && this.store.hasStreams(a.id)) n++
    }
    return n
  }

  /** 全部活动合并功率曲线：窗口秒数 → 最大平均功率（可按日期区间过滤） */
  globalPowerBest(range?: { fromMs?: number; toMs?: number }): Map<number, number> {
    const best = new Map<number, number>()
    for (const a of this.store.listActivities()) {
      if (!a.deviceWatts) continue
      if (range) {
        const t = new Date(a.startDate).getTime()
        if (range.fromMs != null && t < range.fromMs) continue
        if (range.toMs != null && t > range.toMs) continue
      }
      const s = this.store.getStreams(a.id)
      if (!s?.watts?.length) continue
      for (const w of POWER_CURVE_WINDOWS) {
        const v = rollingMaxAvg(s.watts, w.seconds)
        if (v > (best.get(w.seconds) ?? 0)) best.set(w.seconds, v)
      }
    }
    return best
  }

  /** 指定窗口集合与日期区间的最佳功率 */
  private bestCurve(fromMs: number | null, toMs: number | null, windows: number[]): Map<number, number> {
    const best = new Map<number, number>()
    for (const a of this.store.listActivities()) {
      if (!a.deviceWatts) continue
      const t = new Date(a.startDate).getTime()
      if (fromMs != null && t < fromMs) continue
      if (toMs != null && t > toMs) continue
      const s = this.store.getStreams(a.id)
      if (!s?.watts?.length) continue
      for (const sec of windows) {
        const v = rollingMaxAvg(s.watts, sec)
        if (v > (best.get(sec) ?? 0)) best.set(sec, v)
      }
    }
    return best
  }

  // ---------- 曲线/区间 ----------
  /** 功率落在 7 个 Coggan 区间的秒数（采样点视为 1s） */
  private powerZoneSeconds(watts: number[], ftp: number): number[] {
    const zones = new Array(7).fill(0)
    for (const w of watts) {
      if (w <= 0) continue
      let zi = 6
      for (let i = 0; i < POWER_ZONE_BOUNDS.length; i++) {
        if (w <= ftp * POWER_ZONE_BOUNDS[i]) {
          zi = i
          break
        }
      }
      zones[zi]++
    }
    return zones
  }

  /** 单次活动的完整指标：TSS / 方法 / NP / IF */
  activityMetrics(a: Activity): { tss: number; method: string; np: number | null; intensityFactor: number | null } {
    const ftp = this.store.getFtp()
    const { tss, method, np } = this.activityTss(a, ftp)
    const npFinal = np ?? a.weightedAverageWatts ?? null
    const intensityFactor = npFinal && ftp ? Math.round((npFinal / ftp) * 1000) / 1000 : null
    return { tss, method, np: npFinal, intensityFactor }
  }

  computePowerCurve(streams: Streams | null): PowerCurve | null {
    if (!streams?.watts?.length) return null
    const values = POWER_CURVE_WINDOWS.map((w) => Math.round(rollingMaxAvg(streams.watts!, w.seconds)))
    const p20 = values[8] || null
    const p3 = values[4] // 1min 窗口没有 3min；用 2min/5min 两点模型
    const p5 = values[6]
    let cp: number | null = null
    let wPrime: number | null = null
    if (p3 && p5) {
      cp = Math.round((p5 * 300 - p3 * 120) / (300 - 120))
      wPrime = Math.round((p3 - cp) * 120)
      if (p20 && (cp < p20 * 0.85 || cp > p20 * 1.15)) cp = null
    }
    return {
      windows: POWER_CURVE_WINDOWS,
      values,
      ftpEstimate20min: p20 ? Math.round(p20 * 0.95) : null,
      cp,
      wPrime
    }
  }

  computeTimeInZones(a: Activity, streams: Streams | null) {
    const out: { label: string; seconds: number; power?: boolean; hr?: boolean }[] = []
    const ftp = this.store.getFtp()
    // 功率区间与心率区间并列输出（有哪种就给哪种），不再二选一
    if (streams?.watts?.length && ftp && a.deviceWatts) {
      const zones = this.powerZoneSeconds(streams.watts, ftp)
      zones.forEach((sec, i) => out.push({ label: POWER_ZONE_LABELS[i], seconds: sec, power: true }))
    }
    if (streams?.heartrate?.length) {
      const zones = this.timeInHrZones(streams)
      zones.forEach((sec, i) => out.push({ label: HR_ZONE_LABELS[i], seconds: sec, hr: true }))
    }
    return out
  }

  private timeInHrZones(streams: Streams): number[] {
    const zones = new Array(5).fill(0)
    if (!streams.heartrate) return zones
    for (const hr of streams.heartrate) {
      if (hr > 0) zones[this.hrZoneIndex(hr)]++
    }
    return zones
  }

  /** 功率区间秒数（按活动持久化缓存，避免每次解析大 streams 文件） */
  private powerZoneSecondsCached(a: Activity, ftp: number): number[] | null {
    const key = a.id + ':pzone'
    const c = this.metrics[key] as unknown as { v: number; ftp: number; seconds: number[] } | undefined
    if (c && c.ftp === ftp && c.v === this.store.version) return c.seconds
    const streams = this.store.getStreams(a.id)
    if (!streams?.watts?.length) return null
    const seconds = this.powerZoneSeconds(streams.watts, ftp)
    ;(this.metrics as Record<string, unknown>)[key] = { v: this.store.version, ftp, seconds }
    return seconds
  }

  /** 心率区间秒数（按活动持久化缓存，键含心率区间边界，改 LTHR 后自动重算） */
  private hrZoneSecondsCached(a: Activity): number[] | null {
    const key = a.id + ':hzone'
    const bounds = this.hrZoneBounds()
    const c = this.metrics[key] as unknown as { v: number; bounds: number[]; seconds: number[] } | undefined
    if (c && c.bounds.join() === bounds.join() && c.v === this.store.version) return c.seconds
    const streams = this.store.getStreams(a.id)
    if (!streams?.heartrate?.length) return null
    const seconds = this.timeInHrZones(streams)
    ;(this.metrics as Record<string, unknown>)[key] = { v: this.store.version, bounds, seconds }
    return seconds
  }

  // ---------- 课型识别（点评 L2/L3 与建议引擎共用底座） ----------
  /** 统计高于阈值（功率 Z4 下界 / 心率 Z4 下界）的连续强度块数量（≥45s 计一块，间隔 ≥45s 分组） */
  private countHardBlocks(a: Activity, streams: Streams | null, powerBased: boolean): number {
    const ftp = this.store.getFtp()
    let series: number[] | null = null
    let threshold = 0
    if (powerBased && streams?.watts?.length && ftp) {
      series = streams.watts
      threshold = ftp * 1.05
    } else if (streams?.heartrate?.length) {
      series = streams.heartrate
      threshold = this.hrZoneBounds()[3]
    }
    if (!series) return 0
    const W = 15 // 30s 滑动平均去毛刺
    let blocks = 0
    let inBlock = false
    let blockLen = 0
    let gapLen = 999
    for (let i = 0; i < series.length; i++) {
      let sum = 0
      let n = 0
      for (let j = Math.max(0, i - W); j < i; j++) {
        sum += series[j]
        n++
      }
      const above = n > 0 && sum / n > threshold
      if (above) {
        if (!inBlock) {
          inBlock = true
          blockLen = 0
        }
        blockLen++
        gapLen = 0
      } else if (inBlock) {
        gapLen++
        if (gapLen > 45) {
          if (blockLen >= 45) blocks++
          inBlock = false
        }
      }
    }
    if (inBlock && blockLen >= 45) blocks++
    return blocks
  }

  /** 课型识别 + 执行质量分（结果按活动持久化缓存；ALGO 变更后旧缓存自动失效） */
  private static COURSE_ALGO = 2

  classifyRide(a: Activity, streams: Streams | null): RideCourse {
    const key = a.id + ':course'
    const ftp = this.store.getFtp()
    const c = this.metrics[key] as unknown as { v: number; ftp: number; algo: number; course: RideCourse } | undefined
    if (c && c.v === this.store.version && c.ftp === (ftp ?? 0) && c.algo === AnalysisEngine.COURSE_ALGO) return c.course

    const hours = a.movingTime / 3600
    const if_ = ftp && a.deviceWatts && a.weightedAverageWatts ? a.weightedAverageWatts / ftp : null

    // 区间占比：功率 7 区优先，心率 5 区降级
    let z1z2Share = 0
    let z3Share = 0
    let hardShare = 0
    let powerBased = false
    const pz = ftp && a.deviceWatts ? this.powerZoneSecondsCached(a, ftp) : null
    if (pz) {
      const t = pz.reduce((s, v) => s + v, 0)
      if (t > 300) {
        powerBased = true
        z1z2Share = (pz[0] + pz[1]) / t
        z3Share = pz[2] / t
        hardShare = (pz[3] + pz[4] + pz[5] + pz[6]) / t
      }
    }
    if (!powerBased) {
      const hz = this.hrZoneSecondsCached(a)
      if (hz) {
        const t = hz.reduce((s, v) => s + v, 0)
        if (t > 300) {
          z1z2Share = (hz[0] + hz[1]) / t
          z3Share = hz[2] / t
          hardShare = (hz[3] + hz[4]) / t
        }
      }
    }
    const noZone = z1z2Share === 0 && z3Share === 0 && hardShare === 0
    const hardBlocks = noZone ? 0 : this.countHardBlocks(a, streams, powerBased)

    // 分类：先看强度结构（间歇/节奏），再看低强度课的时长语义。
    // 注意：IF≤0.7 不能直接判恢复骑——长距离低强度骑（IF 0.55-0.7、Z1Z2 占比高）是标准有氧耐力课，
    // 如 MyWhoosh Zone 2 Steady（1.5h+ 纯 Z2、IF 0.6）；恢复骑应是「短 + 低强度 + 无高强度块」
    let type: CourseType
    if (noZone) type = hours >= 1.5 ? 'endurance' : 'easy'
    else if (hours < 0.33) type = 'easy'
    else if (hardShare >= 0.22 && hardBlocks >= 3) type = 'intervals'
    else if (hardShare >= 0.3) type = 'tempo'
    else if (z3Share >= 0.35) type = 'tempo'
    else if (if_ != null && if_ <= 0.7 && hours < 1.0 && hardShare < 0.08) type = 'recovery'
    else if (z1z2Share >= 0.6 && hours >= 1.25) type = 'endurance'
    else if (z1z2Share >= 0.8 && hours >= 0.75) type = 'endurance'
    else if (if_ != null && if_ <= 0.65 && hardShare < 0.08) type = 'recovery'
    else type = 'easy'

    const LABEL: Record<CourseType, string> = {
      endurance: '有氧耐力课',
      tempo: '节奏/阈值课',
      intervals: '间歇强度课',
      recovery: '恢复骑',
      easy: '日常骑'
    }
    const pctS = (v: number) => Math.round(v * 100) + '%'
    let basis: string
    switch (type) {
      case 'endurance':
        basis = noZone
          ? `无心率/功率明细，按时长 ${hours.toFixed(1)}h 粗分为有氧长骑`
          : `按 Z1-Z2 占比 ${pctS(z1z2Share)}、时长 ${hours.toFixed(1)}h 判定为有氧耐力课`
        break
      case 'tempo':
        basis = `按阈值以上强度占比 ${pctS(z3Share + hardShare)}、高强度块 ${hardBlocks} 组判定为节奏课`
        break
      case 'intervals':
        basis = `检测到 ${hardBlocks} 组高强度块（Z4+ 占比 ${pctS(hardShare)}），判定为间歇课`
        break
      case 'recovery':
        basis = `强度因子 ${if_ != null ? if_.toFixed(2) : '低'}（远低于 FTP 水平），判定为恢复骑`
        break
      default:
        basis = `强度结构不典型（Z2 ${pctS(z1z2Share)} / Z3 ${pctS(z3Share)} / Z4+ ${pctS(hardShare)}），按日常骑处理`
    }

    // 执行质量分
    let score: number | null = null
    const reasons: string[] = []
    switch (type) {
      case 'endurance': {
        score = Math.round(z1z2Share * 100)
        if (hardShare > 0.08) {
          score -= 20
          reasons.push(`有氧课里高强度占比 ${pctS(hardShare)} 偏高，有氧刺激被稀释`)
        } else if (!noZone) {
          reasons.push(`Z1-Z2 占比 ${pctS(z1z2Share)}，有氧刺激纯净`)
        }
        if (if_ != null && if_ > 0.85) {
          score -= 10
          reasons.push(`平均强度 IF ${if_.toFixed(2)} 偏高，名为有氧实为节奏`)
        }
        if (hours >= 1.5) reasons.push(`时长 ${hours.toFixed(1)}h，有氧体积达标`)
        score = Math.max(30, Math.min(99, score))
        break
      }
      case 'tempo': {
        const t = z3Share + hardShare
        score = Math.max(40, Math.min(99, Math.round(100 - Math.abs(t - 0.55) * 150)))
        reasons.push(
          t >= 0.5
            ? `阈值强度占比 ${pctS(t)}，刺激到位`
            : `阈值强度占比仅 ${pctS(t)}，节奏段可以再压实（减少 Z2 穿插）`
        )
        break
      }
      case 'intervals': {
        score = Math.min(99, 55 + hardBlocks * 8 + (hardShare >= 0.25 ? 10 : 0))
        reasons.push(`${hardBlocks} 组高强度块、Z4+ 占比 ${pctS(hardShare)}`)
        if (powerBased && hardShare < 0.18) reasons.push('有效高强度时间偏少：可能组间休息过长或组数不足')
        break
      }
      case 'recovery': {
        if (if_ != null && if_ > 0.8) {
          score = 45
          reasons.push(`IF ${if_.toFixed(2)} 对恢复骑来说太猛——身体没有恢复，疲劳会滚雪球；把功率上限锁在 Z1`)
        } else if (z1z2Share >= 0.85 || (if_ != null && if_ <= 0.7)) {
          score = 90
          reasons.push('强度控制得当，是真正的恢复骑')
        } else {
          score = 70
          reasons.push('强度略偏高，恢复效果打了折扣')
        }
        break
      }
      default:
        score = null
    }

    const course: RideCourse = {
      type,
      label: LABEL[type],
      basis,
      score,
      scoreReasons: reasons,
      metrics: { z1z2Share, z3Share, hardShare, hardBlocks, if_, hours }
    }
    ;(this.metrics as Record<string, unknown>)[key] = {
      v: this.store.version,
      ftp: ftp ?? 0,
      algo: AnalysisEngine.COURSE_ALGO,
      course
    }
    return course
  }

  /** 有氧解耦 Pw:Hr（有功率+心率时）或 Hr:Pace 近似 */
  computeDecoupling(a: Activity, streams: Streams | null): number | null {
    if (!streams?.heartrate?.length) return null
    const hasPower = !!streams.watts?.length && a.deviceWatts && this.store.getFtp() != null
    const half = Math.floor(streams.time.length / 2)
    if (half < 60) return null
    const ef = (from: number, to: number) => {
      let hr = 0
      let n = 0
      let work = 0
      for (let i = from; i < to; i++) {
        if (streams.heartrate![i] > 0) {
          hr += streams.heartrate![i]
          n++
          work += hasPower ? Math.max(streams.watts![i], 0) : streams.distance[i + 1] ? streams.distance[i + 1] - streams.distance[i] : 0
        }
      }
      if (!n || !hr) return 0
      return work / (hr / n)
    }
    const ef1 = ef(0, half)
    const ef2 = ef(half, streams.time.length)
    if (!ef1) return null
    const dec = ((ef1 - ef2) / ef1) * 100
    return Math.round(dec * 10) / 10
  }

  // ---------- 训练负荷 ----------
  private dailyTss(daysBack = 180): Map<string, number> {
    const map = new Map<string, number>()
    const ftp = this.store.getFtp()
    for (const a of this.store.listActivities()) {
      const { tss } = this.activityTss(a, ftp)
      const d = dayStr(a.startDate)
      map.set(d, (map.get(d) ?? 0) + tss)
    }
    this.persistMetrics()
    return map
  }

  loadSeries(daysBack = 120): LoadPoint[] {
    const daily = this.dailyTss(daysBack)
    const out: LoadPoint[] = []
    let ctl = 0
    let atl = 0
    const today = new Date()
    for (let i = daysBack; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400_000)
      const ds = d.toISOString().slice(0, 10)
      const tss = daily.get(ds) ?? 0
      ctl += (tss - ctl) / 42
      atl += (tss - atl) / 7
      out.push({ date: ds, tss: Math.round(tss), ctl: Math.round(ctl), atl: Math.round(atl), tsb: Math.round(ctl - atl) })
    }
    return out
  }

  // ---------- 聚合视图 ----------
  getDashboard(range: DashRange = 'quarter'): DashboardData {
    return this.cached(`dashboard:${range}`, () => this.computeDashboard(range))
  }

  private computeDashboard(range: DashRange): DashboardData {
    const all = this.store.listActivities()
    const ftp = this.store.getFtp()
    const startTs = rangeStartTs(range)
    // 所选范围（自然周/月/季起点或滚动窗口），1970 脏时间戳天然被 startTs 过滤
    const inRange = (a: Activity) => plausibleDate(a.startDate) && new Date(a.startDate).getTime() >= startTs
    const scope = all.filter(inRange)

    const load = this.loadSeries(RANGE_LOAD_DAYS[range])
    // 所选范围区间分布：功率与心率并列统计（同一批活动两种视角）
    const hrZoneSec = new Array(5).fill(0)
    const powerZoneSec = new Array(7).fill(0)
    let estimatedSec = 0
    for (const a of scope) {
      // 功率与心率并列统计（同一批活动两种视角），不再互斥跳过
      let usedPower = false
      if (ftp && a.deviceWatts) {
        const pz = this.powerZoneSecondsCached(a, ftp)
        if (pz) {
          pz.forEach((v, i) => (powerZoneSec[i] += v))
          usedPower = true
        }
      }
      const hz = this.hrZoneSecondsCached(a)
      if (hz) {
        hz.forEach((v, i) => (hrZoneSec[i] += v))
      } else if (!usedPower && a.averageHeartrate && a.averageHeartrate > 60 && a.movingTime > 0) {
        // 无逐秒数据且无功率：把整段移动时间计入平均心率所在区间（估算）
        hrZoneSec[this.hrZoneIndex(a.averageHeartrate)] += a.movingTime
        estimatedSec += a.movingTime
      }
    }
    const powerTotal = powerZoneSec.reduce((s2, v) => s2 + v, 0)
    const usePowerZones = powerTotal > 3600
    const zoneDistribution = usePowerZones
      ? POWER_ZONE_LABELS.map((label, i) => ({ label, seconds: powerZoneSec[i] }))
      : HR_ZONE_LABELS.map((label, i) => ({ label, seconds: hrZoneSec[i] }))
    const zoneEstimated = !usePowerZones && estimatedSec > 0 && estimatedSec > hrZoneSec.reduce((s2, v) => s2 + v, 0) * 0.3
    // 心率区间并列输出：即使功率区间可用也提供（仪表盘双卡展示）
    const hrTotal = hrZoneSec.reduce((s2, v) => s2 + v, 0)
    const hrZoneDistribution = hrTotal > 1800 ? HR_ZONE_LABELS.map((label, i) => ({ label, seconds: hrZoneSec[i] })) : undefined

    const best = this.globalPowerBest()
    const bestPower = [60, 300, 1200]
      .map((sec) => ({ window: sec, watts: Math.round(best.get(sec) ?? 0) }))
      .filter((x) => x.watts > 0)

    // 尚未同步详细数据的 Strava 活动数
    const missingStreams = all.filter((a) => a.source === 'strava' && !this.store.hasStreams(a.id)).length

    // 所选范围平均心率 / 踏频（按骑行时长加权，过滤明显无效值）
    const hrSamples = scope.filter((a) => a.averageHeartrate && a.averageHeartrate > 60 && a.movingTime > 300)
    const cadSamples = scope.filter((a) => a.averageCadence && a.averageCadence > 30 && a.movingTime > 300)
    const weighted = (arr: Activity[], pick: (a: Activity) => number) => {
      const t = sum(arr.map((a) => a.movingTime))
      return t > 0 ? sum(arr.map((a) => pick(a) * a.movingTime)) / t : null
    }

    return {
      summary: {
        distance: sum(scope.map((a) => a.distance)),
        time: sum(scope.map((a) => a.movingTime)),
        elevation: sum(scope.map((a) => a.totalElevationGain)),
        count: scope.length,
        avgSpeed: scope.length ? weighted(scope, (a) => a.averageSpeed) ?? 0 : 0,
        avgHr: hrSamples.length ? Math.round(weighted(hrSamples, (a) => a.averageHeartrate!) ?? 0) || null : null,
        avgCadence: cadSamples.length ? Math.round((weighted(cadSamples, (a) => a.averageCadence!) ?? 0) * 10) / 10 || null : null,
        tss: Math.round(sum(scope.map((a) => this.activityTss(a, ftp).tss)))
      },
      ytdDistance: sum(all.filter((a) => plausibleDate(a.startDate) && a.startDate.slice(0, 4) === new Date().toISOString().slice(0, 4)).map((a) => a.distance)),
      load,
      zoneDistribution,
      zoneKind: usePowerZones ? 'power' : 'hr',
      hrZoneDistribution,
      zoneEstimated,
      missingStreams,
      recent: all.slice(0, 8).map((a) => ({ ...a, tss: Math.round(this.activityTss(a, ftp).tss) })),
      ftp,
      weightKg: this.store.getSettings().weightKg,
      bestPower
    }
  }

  getTrends(): TrendsData {
    return this.cached('trends', () => this.computeTrends())
  }

  private computeTrends(): TrendsData {
    const all = this.store.listActivities()
    const ftp = this.store.getFtp()
    const weekly = new Map<string, { distance: number; time: number; elevation: number; tss: number; count: number }>()
    const monthly = new Map<string, { distance: number; time: number; elevation: number; tss: number; count: number }>()

    for (const a of all) {
      if (!plausibleDate(a.startDate)) continue
      const d = new Date(a.startDate)
      const wk = weekStart(d)
      const mh = a.startDate.slice(0, 7)
      const { tss } = this.activityTss(a, ftp)
      const w = weekly.get(wk) ?? { distance: 0, time: 0, elevation: 0, tss: 0, count: 0 }
      w.distance += a.distance
      w.time += a.movingTime
      w.elevation += a.totalElevationGain
      w.tss += tss
      w.count++
      weekly.set(wk, w)
      const m = monthly.get(mh) ?? { distance: 0, time: 0, elevation: 0, tss: 0, count: 0 }
      m.distance += a.distance
      m.time += a.movingTime
      m.elevation += a.totalElevationGain
      m.tss += tss
      m.count++
      monthly.set(mh, m)
    }
    this.persistMetrics()

    const speedTrend = all
      .filter((a) => a.distance > 5000 && plausibleDate(a.startDate))
      .slice(0, 60)
      .reverse()
      .map((a) => ({ date: a.startDate.slice(0, 10), avgSpeed: Math.round(a.averageSpeed * 3.6 * 10) / 10, activity: a.name }))

    // ---------- 近 12 周训练结构：有氧积累 / 强度分布 / 疲劳状态 ----------
    const loadAll = this.loadSeries(120)
    const pointByDate = new Map(loadAll.map((p) => [p.date, p]))
    const WEEKS = 12
    const monday = weekStart(new Date())
    const mondayDate = new Date(monday + 'T00:00:00Z')
    const trainingWeeks: WeekTraining[] = []
    for (let i = WEEKS - 1; i >= 0; i--) {
      const ws = new Date(mondayDate.getTime() - i * 7 * 86400_000).toISOString().slice(0, 10)
      trainingWeeks.push({
        weekStart: ws,
        tss: 0,
        hours: 0,
        easyH: 0,
        modH: 0,
        hardH: 0,
        tsb: 0,
        ctl: 0,
        estimated: false
      })
    }
    const weekIdx = new Map(trainingWeeks.map((w, i) => [w.weekStart, i]))
    for (const a of all) {
      const idx = weekIdx.get(weekStart(new Date(a.startDate)))
      if (idx == null) continue
      const w = trainingWeeks[idx]
      const { tss } = this.activityTss(a, ftp)
      w.tss += tss
      w.hours += a.movingTime / 3600
      // 强度归属：功率区间 > 心率区间 > 平均心率估算（均走持久化缓存）
      if (ftp && a.deviceWatts) {
        const z = this.powerZoneSecondsCached(a, ftp)
        if (z) {
          w.easyH += (z[0] + z[1]) / 3600
          w.modH += z[2] / 3600
          w.hardH += (z[3] + z[4] + z[5] + z[6]) / 3600
          continue
        }
      }
      const hz = this.hrZoneSecondsCached(a)
      if (hz) {
        w.easyH += (hz[0] + hz[1]) / 3600
        w.modH += hz[2] / 3600
        w.hardH += (hz[3] + hz[4]) / 3600
      } else if (a.averageHeartrate && a.averageHeartrate > 60 && a.movingTime > 0) {
        const zi = this.hrZoneIndex(a.averageHeartrate)
        const h = a.movingTime / 3600
        if (zi <= 1) w.easyH += h
        else if (zi === 2) w.modH += h
        else w.hardH += h
        w.estimated = true
      }
    }
    // 周末（或今天）的 TSB / CTL
    const todayStr = new Date().toISOString().slice(0, 10)
    for (let i = 0; i < trainingWeeks.length; i++) {
      const ws = trainingWeeks[i].weekStart
      const weekEnd = new Date(new Date(ws + 'T00:00:00Z').getTime() + 6 * 86400_000).toISOString().slice(0, 10)
      const p = pointByDate.get(weekEnd > todayStr ? todayStr : weekEnd)
      if (p) {
        trainingWeeks[i].tsb = p.tsb
        trainingWeeks[i].ctl = p.ctl
      }
    }
    trainingWeeks.forEach((w) => {
      w.hours = Math.round(w.hours * 10) / 10
      w.easyH = Math.round(w.easyH * 10) / 10
      w.modH = Math.round(w.modH * 10) / 10
      w.hardH = Math.round(w.hardH * 10) / 10
      w.tss = Math.round(w.tss)
    })

    // ---------- 训练洞察（明确指引） ----------
    const insights: string[] = []
    const last4 = trainingWeeks.slice(-4)
    const prev8 = trainingWeeks.slice(0, -4)
    const sumW = (arr: WeekTraining[], f: (w: WeekTraining) => number) => arr.reduce((s, w) => s + f(w), 0)
    const l4Time = sumW(last4, (w) => w.hours)
    const weeksWithRiding = trainingWeeks.filter((w) => w.hours > 0).length
    if (weeksWithRiding >= 4 && l4Time > 1) {
      const easyPct = (sumW(last4, (w) => w.easyH) / l4Time) * 100
      const modPct = (sumW(last4, (w) => w.modH) / l4Time) * 100
      const hardPct = (sumW(last4, (w) => w.hardH) / l4Time) * 100
      const hoursPerWeek = l4Time / 4
      const tssPerWeek = sumW(last4, (w) => w.tss) / 4
      const prevHours = sumW(prev8, (w) => w.hours) / Math.max(prev8.length, 1)

      // 有氧基础
      if (easyPct >= 75) {
        insights.push(`有氧基础扎实：近 4 周低强度（Z1-Z2）占比 ${Math.round(easyPct)}%，符合极化模型。继续保持。`)
      } else if (easyPct >= 60) {
        insights.push(`有氧占比 ${Math.round(easyPct)}% 接近但低于推荐的 80%：把部分中等强度骑（Z3「灰色区间」）换成轻松长骑，有氧收益更大。`)
      } else {
        insights.push(`有氧占比仅 ${Math.round(easyPct)}%，明显不足：训练偏「中不溜」，刺激浅恢复慢。建议近 4 周把中等强度骑降为 Z2，每周加 1 次 90 分钟长骑。`)
      }
      // 高强度
      if (hardPct > 30) {
        insights.push(`高强度占比 ${Math.round(hardPct)}% 过高，连续多周易积累疲劳；降到 15-20%（每周 1-2 次质量课）效率更高。`)
      } else if (hardPct < 5) {
        insights.push(`近 4 周几乎没有高强度刺激（${Math.round(hardPct)}%）：可加入每周 1-2 次间歇课（如 4×5min Z5）提升最大摄氧量。`)
      } else {
        insights.push(`强度结构：低 ${Math.round(easyPct)}% / 中 ${Math.round(modPct)}% / 高 ${Math.round(hardPct)}%，接近极化模型，保持。`)
      }
      // 训练量变化
      if (prevHours > 0) {
        const delta = ((hoursPerWeek - prevHours) / prevHours) * 100
        if (delta > 30) {
          insights.push(`周均骑行 ${hoursPerWeek.toFixed(1)} 小时，比之前 8 周均值高 ${Math.round(delta)}%——加量太快有受伤风险，遵循每周 +10% 原则。`)
        } else if (delta < -20) {
          insights.push(`周均骑行 ${hoursPerWeek.toFixed(1)} 小时，比之前 8 周低 ${Math.abs(Math.round(delta))}%；若是减量周则正常，否则注意保持规律。`)
        } else {
          insights.push(`周均骑行 ${hoursPerWeek.toFixed(1)} 小时 / ${Math.round(tssPerWeek)} TSS，训练量稳定（变化 ${delta >= 0 ? '+' : ''}${Math.round(delta)}%）。`)
        }
      }
      // 过度训练判断
      const tsbNow = loadAll[loadAll.length - 1].tsb
      if (tsbNow < -30) {
        insights.push(`当前 TSB ${tsbNow}，疲劳深度过大（< -30 属过度训练风险区）：建议本周减量 30-50%，只做 Z1-Z2，直到 TSB 回到 -10 以上。`)
      } else if (tsbNow < -10) {
        insights.push(`当前 TSB ${tsbNow}，处于「训练甜区」（-10 ~ -30）：体能正在积累，再坚持 1-2 周后安排 3-4 天减量周吸收训练。`)
      } else if (tsbNow > 10) {
        insights.push(`当前 TSB ${tsbNow}，身体已充分恢复：这是安排测试（20min FTP test）或比赛的好时机。`)
      } else {
        insights.push(`当前 TSB ${tsbNow}，状态平衡。`)
      }
    } else {
      insights.push('有效训练数据还不足 4 周，再积累一段时间后这里会给出有氧结构与疲劳管理的具体建议。')
    }

    // ---------- 心率效率趋势：每月「同条件骑行」（户外 45-150min）平均心率中位数，趋势下降 = 有氧进步 ----------
    const hrByMonth = new Map<string, number[]>()
    const cadByMonth = new Map<string, { sum: number; t: number; n: number }>()
    for (const a of all) {
      if (!plausibleDate(a.startDate)) continue
      const mh = a.startDate.slice(0, 7)
      if (a.type === 'Ride' && !a.trainer && a.averageHeartrate && a.averageHeartrate >= 100 && a.movingTime >= 2700 && a.movingTime <= 9000) {
        const arr = hrByMonth.get(mh) ?? []
        arr.push(a.averageHeartrate)
        hrByMonth.set(mh, arr)
      }
      if ((a.type === 'Ride' || a.type === 'VirtualRide') && a.averageCadence && a.averageCadence > 50 && a.movingTime > 900) {
        const c = cadByMonth.get(mh) ?? { sum: 0, t: 0, n: 0 }
        c.sum += a.averageCadence * a.movingTime
        c.t += a.movingTime
        c.n++
        cadByMonth.set(mh, c)
      }
    }
    const monthKeys = [...new Set([...hrByMonth.keys(), ...cadByMonth.keys()])].sort().slice(-12)

    // ---------- 月度心率区间结构：Z1-Z5 累计秒数（走持久化缓存） ----------
    const hrZoneByMonth = new Map<string, number[]>()
    for (const a of all) {
      if (!plausibleDate(a.startDate) || !a.hasHeartrate || a.movingTime < 900) continue
      const z = this.hrZoneSecondsCached(a)
      if (!z) continue
      const mh = a.startDate.slice(0, 7)
      const acc = hrZoneByMonth.get(mh) ?? new Array(5).fill(0)
      for (let i = 0; i < 5; i++) acc[i] += z[i]
      hrZoneByMonth.set(mh, acc)
    }
    const hrZoneTrend = [...hrZoneByMonth.entries()]
      .sort()
      .slice(-12)
      .map(([month, zones]) => ({ month, zones }))
    const hrTrend = monthKeys
      .map((m) => {
        const arr = hrByMonth.get(m)
        return { month: m, hr: arr && arr.length >= 2 ? Math.round(median(arr)) : null, n: arr?.length ?? 0 }
      })
      .filter((x): x is { month: string; hr: number; n: number } => x.hr != null)
    const cadenceTrend = monthKeys
      .map((m) => {
        const c = cadByMonth.get(m)
        return { month: m, cadence: c ? Math.round((c.sum / c.t) * 10) / 10 : null, n: c?.n ?? 0 }
      })
      .filter((x): x is { month: string; cadence: number; n: number } => x.cadence != null)

    return {
      weekly: [...weekly.entries()].sort().map(([weekStart, v]) => ({ weekStart, ...v })),
      monthly: [...monthly.entries()].sort().map(([month, v]) => ({ month, ...v })),
      speedTrend,
      hrTrend,
      cadenceTrend,
      hrZoneTrend,
      training: { weeks: trainingWeeks, insights }
    }
  }

  // ---------- 能力分析 ----------
  getAbility(): AbilityData {
    return this.cached('ability', () => this.computeAbility())
  }

  private computeAbility(): AbilityData {
    const all = this.store.listActivities()
    const ftp = this.store.getFtp()
    const nowMs = Date.now()
    const day = 86400_000
    const pdSecs = PD_WINDOWS.map((w) => w.seconds)
    const fitWindows = [...pdSecs, 180, 720]

    // ---- 全局功率-时间曲线：近 90 天 vs 之前 90 天 ----
    const cur = this.bestCurve(nowMs - 90 * day, null, fitWindows)
    const prev = this.bestCurve(nowMs - 180 * day, nowMs - 90 * day, fitWindows)
    const { cp, wPrime } = this.ftpFromBest(cur)
    const predicted: (number | null)[] = cp && wPrime ? PD_WINDOWS.map((w) => Math.round(cp + wPrime / w.seconds)) : []

    // ---- 骑手类型画像（全历史最佳） ----
    const allBest = this.bestCurve(null, null, [5, 60, 300, 1200, 3600])
    const g = (sec: number) => (allBest.get(sec) ?? 0) > 0 ? Math.round(allBest.get(sec)!) : null
    const s5 = g(5)
    const m1 = g(60)
    const m5 = g(300)
    const m20 = g(1200)
    const m60 = g(3600)
    const REF = { sprint: 2.3, anaerobic: 1.45, vo2: 1.2, threshold: 1.0 }
    const ratios =
      ftp && m20
        ? {
            sprint: Math.round(((s5 ?? 0) / ftp) * 100) / 100,
            anaerobic: Math.round(((m1 ?? 0) / ftp) * 100) / 100,
            vo2: Math.round(((m5 ?? 0) / ftp) * 100) / 100,
            threshold: Math.round((m20 / ftp) * 100) / 100
          }
        : null
    const radar = ratios
      ? {
          sprint: Math.round((ratios.sprint / REF.sprint) * 100),
          anaerobic: Math.round((ratios.anaerobic / REF.anaerobic) * 100),
          vo2: Math.round((ratios.vo2 / REF.vo2) * 100),
          threshold: Math.round((ratios.threshold / REF.threshold) * 100)
        }
      : null
    let type = '均衡型'
    let typeDesc = '各项能力发展均衡，按极化模型系统训练即可持续进步。'
    if (radar) {
      const { sprint, anaerobic, vo2 } = radar
      if (sprint >= 110) {
        type = '冲刺爆发型'
        typeDesc = '短时爆发力突出。比赛终端冲刺是武器，但有氧底子决定你能把它带到终点——保持耐力课的同时打磨冲刺技巧。'
      } else if (anaerobic >= 110) {
        type = '无氧能力强型'
        typeDesc = '1 分钟级别的无氧输出出色，适合进攻型骑行和短坡拉爆对手。注意无氧能力来得快去得也快，维持即可。'
      } else if (vo2 >= 110) {
        type = 'VO2max / 爬坡型'
        typeDesc = '5 分钟功率相对突出，爬坡和长上拉是你的主场。把 FTP 再抬上去，优势区间会更大。'
      } else if (sprint <= 92 && vo2 >= 100) {
        type = '计时赛型'
        typeDesc = '匀速输出能力强、爆发一般——TT/缓坡长爬是优势地形，避免拼短冲。'
      }
    }
    const STRENGTH_META: Record<string, string> = {
      sprint: '短时冲刺爆发（5s）',
      anaerobic: '无氧能力（1min）',
      vo2: '最大摄氧（5min）',
      threshold: '阈值耐力（20min）'
    }
    const WEAK_TIP: Record<string, string> = {
      sprint: '每周加 1 次短冲课：6×15s 全力起步冲（齿比 53×14），完全恢复。',
      anaerobic: '每周加 1 次 40/20s 间歇 ×8 组（40s Z6 + 20s 放松）。',
      vo2: '每周 1-2 次 4×4min @ 118% FTP，组间休息 3min。',
      threshold: '每周 1 次 2×20min @ 95-100% FTP，组间休息 5min。'
    }
    const strengths = radar
      ? (Object.entries(radar) as [string, number][])
          .filter(([, v]) => v >= 108)
          .map(([k]) => STRENGTH_META[k])
      : []
    const weaknesses = radar
      ? (Object.entries(radar) as [string, number][])
          .filter(([, v]) => v <= 92)
          .map(([k]) => `${STRENGTH_META[k]}相对偏弱 → ${WEAK_TIP[k]}`)
      : []

    // ---- PR 演进时间线 ----
    const prWindows = [
      { sec: 5, label: '5 秒冲刺' },
      { sec: 60, label: '1 分钟' },
      { sec: 300, label: '5 分钟' },
      { sec: 1200, label: '20 分钟' }
    ]
    const withPowerAsc = all
      .filter((a) => a.deviceWatts && plausibleDate(a.startDate))
      .sort((x, y) => new Date(x.startDate).getTime() - new Date(y.startDate).getTime())
    const prTimeline = prWindows.map((w) => {
      const events: { date: string; watts: number }[] = []
      let best = 0
      for (const a of withPowerAsc) {
        const s = this.store.getStreams(a.id)
        if (!s?.watts?.length) continue
        const v = Math.round(rollingMaxAvg(s.watts, w.sec))
        if (v > best + 1) {
          events.push({ date: a.startDate.slice(0, 10), watts: v })
          best = v
        }
      }
      return { label: w.label, events }
    })

    // ---- 爬坡段检测（有海拔流的骑行） ----
    const climbs: AbilityData['climbs'] = []
    for (const a of all) {
      if (!plausibleDate(a.startDate)) continue
      const s = this.store.getStreams(a.id)
      if (!s?.altitude?.length) continue
      for (const c of this.detectClimbs(a, s)) climbs.push(c)
    }
    climbs.sort((x, y) => y.gainM * y.avgGradient - x.gainM * x.avgGradient)
    climbs.splice(20)

    // ---- 有氧效率趋势（稳态骑：解耦 + EF） ----
    const aerobicTrend: AbilityData['aerobicTrend'] = []
    for (const a of all) {
      if (!plausibleDate(a.startDate)) continue
      if (a.movingTime < 2700) continue
      if (a.weightedAverageWatts && a.averageWatts && a.weightedAverageWatts / a.averageWatts > 1.12) continue
      const s = this.store.getStreams(a.id)
      if (!s?.heartrate?.length || !a.deviceWatts || !s.watts?.length) continue
      const dec = this.computeDecoupling(a, s)
      const avgHr = a.averageHeartrate
      if (!avgHr || avgHr < 100) continue
      const ef = Math.round((a.weightedAverageWatts! / avgHr) * 1000) / 1000
      aerobicTrend.push({ date: a.startDate.slice(0, 10), decoupling: dec, ef })
      if (aerobicTrend.length >= 60) break
    }
    aerobicTrend.reverse()

    // ---- 全年日历 + 连续性 ----
    const byDay = new Map<string, { tss: number; km: number }>()
    for (const a of all) {
      const d = a.startDate.slice(0, 10)
      const acc = byDay.get(d) ?? { tss: 0, km: 0 }
      acc.tss += this.activityTss(a, ftp).tss
      acc.km += a.distance
      byDay.set(d, acc)
    }
    const calendar: AbilityData['calendar'] = []
    const today = new Date()
    for (let i = 364; i >= 0; i--) {
      const ds = new Date(today.getTime() - i * day).toISOString().slice(0, 10)
      const acc = byDay.get(ds)
      calendar.push({ date: ds, tss: acc ? Math.round(acc.tss) : 0, km: acc ? Math.round(acc.km) : 0 })
    }
    let current = 0
    let longest = 0
    let run = 0
    for (let i = 0; i < calendar.length; i++) {
      if (calendar[i].km > 0) {
        run++
        longest = Math.max(longest, run)
      } else if (i < calendar.length - 1) {
        run = 0
      }
    }
    // 当前连续：从今天或昨天往回数
    for (let i = calendar.length - 1; i >= 0; i--) {
      if (calendar[i].km > 0) current++
      else if (i === calendar.length - 1) continue // 今天还没骑不算断
      else break
    }
    const daysThisMonth = calendar.filter((c) => c.date.slice(0, 7) === today.toISOString().slice(0, 7) && c.km > 0).length

    // ---- 下周训练处方 ----
    const load = this.loadSeries(120)
    const thisWeekTss = load.slice(-7).reduce((s, p) => s + p.tss, 0)
    const avg4WeekTss = Math.round(load.slice(-28).reduce((s, p) => s + p.tss, 0) / 4)
    const tsbNow = load[load.length - 1].tsb
    const rampRatePct = avg4WeekTss > 0 ? Math.round(((thisWeekTss - avg4WeekTss) / avg4WeekTss) * 100) : 0
    let mode: AbilityData['prescription']['mode'] = 'progressive'
    let modeLabel = '渐进加量'
    let tssMin = Math.round((avg4WeekTss * 1.05) / 10) * 10
    let tssMax = Math.round((avg4WeekTss * 1.15) / 10) * 10
    const messages: string[] = []
    if (tsbNow <= -30) {
      mode = 'recovery'
      modeLabel = '减量恢复周'
      tssMin = Math.round((avg4WeekTss * 0.4) / 10) * 10
      tssMax = Math.round((avg4WeekTss * 0.6) / 10) * 10
      messages.push(`当前 TSB ${tsbNow}，疲劳深度过大。下周总负荷压到 ${tssMin}~${tssMax} TSS（约为周均的 40-60%）。`)
      messages.push('全部骑行控制在 Z1-Z2，去掉所有高强度课；保持骑行频率但单次缩短。')
      messages.push('恢复到位的标志：TSB 回到 -10 以上、晨起静息心率回落、主观疲劳感消失，再恢复正常训练。')
    } else if (tsbNow <= -10) {
      mode = 'maintain'
      modeLabel = '负荷维持周'
      tssMin = Math.round((avg4WeekTss * 0.95) / 10) * 10
      tssMax = Math.round((avg4WeekTss * 1.05) / 10) * 10
      messages.push(`当前 TSB ${tsbNow}，处于训练甜区。下周总负荷维持 ${tssMin}~${tssMax} TSS，不要再加量。`)
      messages.push('结构保持：约 80% 低强度 + 最多 1 次高质量间歇课；关注睡眠与静息心率，出现异常立即转为恢复周。')
      messages.push('连续维持 2-3 周后，主动安排 3-4 天的半减量周吸收训练。')
    } else if (tsbNow > 10) {
      mode = 'opportunity'
      modeLabel = '状态新鲜，可上强度'
      tssMin = Math.round((avg4WeekTss * 1.1) / 10) * 10
      tssMax = Math.round((avg4WeekTss * 1.25) / 10) * 10
      messages.push(`当前 TSB ${tsbNow}，身体充分恢复。下周是安排高强度刺激的好窗口，总负荷 ${tssMin}~${tssMax} TSS。`)
      messages.push('优先安排 2 次质量课（如 2×20min 阈值、4×4min VO2max）；这也是做 20 分钟 FTP 测试的最佳时机。')
    } else {
      mode = 'progressive'
      modeLabel = '渐进加量周'
      const cap = Math.round((avg4WeekTss * 1.15) / 10) * 10
      tssMin = Math.round((avg4WeekTss * 1.02) / 10) * 10
      tssMax = Math.min(Math.round((avg4WeekTss * 1.15) / 10) * 10, cap)
      messages.push(`当前 TSB ${tsbNow}，状态平衡。下周可渐进加量到 ${tssMin}~${tssMax} TSS（周增幅不超过 15%）。`)
      messages.push('加量优先加 Z2 骑行时长，而不是提高强度；若本周已比周均高出 10% 以上，下周改为维持。')
      messages.push('骑行中 RPE 持续 ≥8 或静息心率连续 2 天升高 5bpm 以上，立即转为恢复周。')
    }
    if (rampRatePct > 30 && mode !== 'recovery') {
      messages.push(`注意：本周 TSS 已比周均高 ${rampRatePct}%，即便状态感觉良好，下周也建议先维持量，把增幅控制在 10% 以内。`)
    }

    // ---- 踏频-功率关系（仅功率计骑行，流数据抽样） ----
    const cadWatts: { cad: number; w: number }[] = []
    for (const a of all) {
      if (!a.deviceWatts) continue
      const s = this.store.getStreams(a.id)
      if (!s?.watts || !s.cadence) continue
      const stride = Math.max(1, Math.floor(s.watts.length / 400))
      for (let i = 0; i < s.watts.length; i += stride) {
        const w = s.watts[i]
        const c = s.cadence[i]
        if (w > 50 && c > 10) cadWatts.push({ cad: c, w })
      }
    }
    const allCads = cadWatts.map((x) => x.cad)
    const highCads = ftp ? cadWatts.filter((x) => x.w >= ftp * 0.75).map((x) => x.cad) : []
    let cadScatter = cadWatts.map((x) => [Math.round(x.cad), Math.round(x.w)] as [number, number])
    if (cadScatter.length > 2000) {
      const stride = Math.ceil(cadScatter.length / 2000)
      cadScatter = cadScatter.filter((_, i) => i % stride === 0)
    }

    return {
      profile: {
        ftp,
        best: { s5, m1, m5, m20, m60 },
        ratios: ratios ?? { sprint: 0, anaerobic: 0, vo2: 0, threshold: 0 },
        radar: radar ?? { sprint: 0, anaerobic: 0, vo2: 0, threshold: 0 },
        type,
        typeDesc,
        strengths,
        weaknesses,
        basedOn: this.countStreamsWithPower()
      },
      pd: {
        windows: PD_WINDOWS.map((w) => w.label),
        current: PD_WINDOWS.map((w) => (cur.get(w.seconds) ? Math.round(cur.get(w.seconds)!) : null)),
        previous: PD_WINDOWS.map((w) => (prev.get(w.seconds) ? Math.round(prev.get(w.seconds)!) : null)),
        cp,
        wPrimeJ: wPrime,
        predicted
      },
      prTimeline,
      climbs,
      aerobicTrend,
      calendar,
      streak: { current, longest, daysThisMonth },
      prescription: {
        mode,
        modeLabel,
        thisWeekTss,
        avg4WeekTss,
        rampRatePct,
        nextWeekTssMin: tssMin,
        nextWeekTssMax: tssMax,
        messages
      },
      cadence: {
        scatter: cadScatter,
        medianCadence: allCads.length ? Math.round(median(allCads)) : null,
        highPowerCadence: highCads.length ? Math.round(median(highCads)) : null
      }
    }
  }

  /** 从海拔流检测爬坡段（坡度 ≥2.8%、长度 ≥400m、爬升 ≥20m） */
  private detectClimbs(a: Activity, s: Streams): AbilityData['climbs'] {
    const alt = s.altitude!
    const time = s.time
    const n = alt.length
    if (n < 300 || time.length !== n) return []
    const dist = s.distance?.length === n ? s.distance : null
    // 海拔平滑（前后 5 采样滑动平均）
    const sm = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      let c = 0
      for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) {
        sum += alt[j]
        c++
      }
      sm[i] = sum / c
    }
    const delta = (i: number, j: number) => (dist ? Math.max(dist[j] - dist[i], 1) : Math.max(time[j] - time[i], 1))
    // 20 采样窗口梯度标记
    const W = 20
    const climbing = new Uint8Array(n)
    for (let i = W; i < n; i++) {
      const dh = sm[i] - sm[i - W]
      if (dh / delta(i - W, i) >= 0.028) climbing[i] = 1
    }
    // 合并成段：先填补 30 采样内的短暂中断（防止同一段爬坡被拆成两段重叠区间），再提取连续段
    const filled = new Uint8Array(climbing)
    for (let i = 1; i < n - 1; i++) {
      if (!filled[i]) {
        let j = i
        while (j < n && !filled[j]) j++
        if (j - i <= 30 && j < n) for (let k = i; k < j; k++) filled[k] = 1
        i = j
      }
    }
    const runs: [number, number][] = []
    let start = -1
    for (let i = 1; i < n; i++) {
      if (filled[i] && start < 0) start = i
      else if (!filled[i] && start >= 0) {
        if (i - start >= 60) runs.push([start, i])
        start = -1
      }
    }
    if (start >= 0 && n - start >= 60) runs.push([start, n])
    const out: AbilityData['climbs'] = []
    for (const [m0, m1] of runs) {
      // 梯度窗口滞后 W 采样：起点向前扩展 W 补回坡脚；爬升取净海拔差（与码表/Strava 口径一致）
      const i0 = Math.max(0, m0 - W)
      const i1 = Math.min(n - 1, m1)
      const distanceM = dist ? dist[i1] - dist[i0] : 0
      const gain = Math.max(sm[i1] - sm[i0], 0)
      let maxGradient = 0
      for (let i = i0 + W; i <= i1; i++) {
        const g = (sm[i] - sm[i - W]) / delta(i - W, i)
        if (g > maxGradient) maxGradient = g
      }
      if (gain < 20 || distanceM < 400) continue
      const avgGradient = gain / distanceM
      if (avgGradient < 0.028) continue
      let wattSum = 0
      let wattN = 0
      if (s.watts?.length === n) {
        for (let i = i0; i < i1; i++) {
          if (s.watts[i] > 0) {
            wattSum += s.watts[i]
            wattN++
          }
        }
      }
      const duration = time[i1] - time[i0]
      out.push({
        date: a.startDate.slice(0, 10),
        activityId: a.id,
        activityName: a.name,
        distanceM: Math.round(distanceM),
        gainM: Math.round(gain),
        avgGradient: Math.round(avgGradient * 1000) / 10,
        maxGradient: Math.round(maxGradient * 1000) / 10,
        vam: duration > 0 ? Math.round((gain / duration) * 3600) : 0,
        avgWatts: wattN > 0 ? Math.round(wattSum / wattN) : null
      })
    }
    return out
  }
}

function median(nums: number[]): number {
  if (!nums.length) return 0
  const s = [...nums].sort((x, y) => x - y)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function sum(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0)
}

/** 本周一（ISO 周）YYYY-MM-DD */
function weekStart(d: Date): string {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = (dt.getUTCDay() + 6) % 7
  dt.setUTCDate(dt.getUTCDate() - day)
  return dt.toISOString().slice(0, 10)
}

/** 滑动窗口最大平均功率 O(n·w)，窗口大时用分块优化 */
export function rollingMaxAvg(values: number[], window: number): number {
  if (!values.length || window <= 0) return 0
  if (window === 1) return Math.max(...values)
  const n = values.length
  if (n < window) {
    // 数据不足窗口长度：全段平均
    return sum(values) / n
  }
  // 前缀和
  const pre = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + values[i]
  let best = 0
  for (let i = window; i <= n; i++) {
    const avg = (pre[i] - pre[i - window]) / window
    if (avg > best) best = avg
  }
  return best
}

/** 标准化功率 NP：30s 滑动平均值四次方平均后开四次方（Coggan） */
export function normalizedPower(watts: number[] | undefined): number | null {
  if (!watts) return null
  const pos = watts.filter((w) => w > 0)
  if (pos.length === 0) return null
  if (pos.length < 60) return Math.round(sum(pos) / pos.length)
  const win = 30
  let rolling = 0
  let sum4 = 0
  let count = 0
  for (let i = 0; i < pos.length; i++) {
    rolling += pos[i]
    if (i >= win) rolling -= pos[i - win]
    if (i >= win - 1) {
      const m = rolling / win
      sum4 += m ** 4
      count++
    }
  }
  return Math.round(Math.pow(sum4 / count, 0.25))
}

/** 用 streams 回填活动摘要中缺失的统计字段（本地导入 / Strava 摘要缺字段时） */
export function enrichActivity(a: Activity, s: Streams): Activity {
  const out = { ...a }
  const mean = (arr?: number[]) => {
    const v = (arr ?? []).filter((x) => x > 0)
    return v.length ? sum(v) / v.length : 0
  }

  if (s.heartrate?.some((v) => v > 0)) {
    out.hasHeartrate = true
    if (!out.averageHeartrate) out.averageHeartrate = Math.round(mean(s.heartrate) * 10) / 10
    if (!out.maxHeartrate) out.maxHeartrate = Math.max(...s.heartrate.filter((v) => v > 0))
  }
  if (s.watts?.some((v) => v > 0)) {
    out.deviceWatts = true
    const np = normalizedPower(s.watts)
    if (!out.weightedAverageWatts && np) out.weightedAverageWatts = np
    if (!out.averageWatts) out.averageWatts = Math.round(mean(s.watts))
    if (!out.maxWatts) out.maxWatts = Math.max(...s.watts.filter((v) => v > 0))
  }
  if (s.cadence?.some((v) => v > 0) && !out.averageCadence) {
    out.averageCadence = Math.round(mean(s.cadence) * 10) / 10
  }
  if (s.altitude?.length && !out.totalElevationGain) {
    let gain = 0
    for (let i = 1; i < s.altitude.length; i++) {
      const d = s.altitude[i] - s.altitude[i - 1]
      if (d > 0) gain += d
    }
    out.totalElevationGain = Math.round(gain)
  }
  if ((!out.distance || out.distance === 0) && s.distance?.length) {
    out.distance = Math.round(Math.max(...s.distance))
  }
  if ((!out.movingTime || out.movingTime === 0) && s.time?.length) {
    out.movingTime = s.time[s.time.length - 1]
  }
  if (!out.startLatlng && s.latlng?.some((p) => p[0] || p[1])) {
    const first = s.latlng.find((p) => p[0] || p[1])
    const last = [...s.latlng].reverse().find((p) => p[0] || p[1])
    if (first) out.startLatlng = first
    if (last) out.endLatlng = last
  }
  return out
}
