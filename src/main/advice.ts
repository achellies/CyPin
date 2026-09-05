import { Store } from './store'
import { AnalysisEngine, rollingMaxAvg } from './analysis'
import type { Activity, ActivityReview, AdviceItem, Streams } from '../shared/types'

const TYPE_LABELS: Record<string, string> = {
  Ride: '公路骑行',
  VirtualRide: '骑行台',
  GravelRide: '砾石骑行',
  MountainBikeRide: '山地骑行',
  EBikeRide: '电助力',
  Handcycle: '手摇',
  Commute: '通勤'
}

function fmtKm(m: number): string {
  return (m / 1000).toFixed(1)
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const min = Math.round((sec % 3600) / 60)
  return h > 0 ? `${h}h${min ? ` ${min}min` : ''}` : `${min}min`
}

function median(nums: number[]): number {
  if (!nums.length) return 0
  const s = [...nums].sort((x, y) => x - y)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** 基于训练科学规则的骑行指导建议引擎 */
export class AdviceEngine {
  constructor(
    private store: Store,
    private analysis: AnalysisEngine
  ) {}

  getAdvice(): AdviceItem[] {
    const out: AdviceItem[] = []
    const all = this.store.listActivities()
    const load = this.analysis.loadSeries(120)
    const ftp = this.store.getFtp()

    if (all.length === 0) {
      return [
        {
          level: 'info',
          category: '开始',
          title: '还没有骑行数据',
          detail: '先在「设置」中连接 Strava 并同步活动，或导入 FIT/GPX 文件，之后这里会给出个性化建议。'
        }
      ]
    }

    // ---------- 训练结构审计（近 4 周）：先查事实再给建议，避免「你已经做到」的建议 ----------
    const mondayOf = (iso: string) => {
      const d = new Date(iso)
      const day = (d.getDay() + 6) % 7
      d.setUTCDate(d.getUTCDate() - day)
      return d.toISOString().slice(0, 10)
    }
    type WeekAudit = { long: number; intensity: number; recovery: number; endScores: number[]; longMin: number[] }
    const lowEndRides: { date: string; name: string; score: number; reason: string }[] = []
    const auditByWeek = new Map<string, WeekAudit>()
    for (const a of all) {
      if (new Date(a.startDate).getTime() < Date.now() - 28 * 86400_000) continue
      const ws = mondayOf(a.startDate)
      const w = auditByWeek.get(ws) ?? { long: 0, intensity: 0, recovery: 0, endScores: [], longMin: [] }
      const course = this.analysis.classifyRide(a, this.store.getStreams(a.id))
      if (course.type === 'endurance' || a.movingTime >= 5400) {
        w.long++
        w.longMin.push(a.movingTime / 60)
        if (course.type === 'endurance' && course.score != null) {
          w.endScores.push(course.score)
          if (course.score < 70) {
            lowEndRides.push({
              date: a.startDate.slice(5, 10),
              name: a.name,
              score: course.score,
              reason: course.scoreReasons[0] ?? '有氧区间纯净度不足'
            })
          }
        }
      }
      if (course.type === 'intervals' || course.type === 'tempo') w.intensity++
      if (course.type === 'recovery') w.recovery++
      auditByWeek.set(ws, w)
    }
    const audits = [...auditByWeek.values()]
    const totalLong = audits.reduce((s, w) => s + w.long, 0)
    const totalIntensity = audits.reduce((s, w) => s + w.intensity, 0)
    const audit = {
      longPerWeek: totalLong / 4,
      intensityPerWeek: totalIntensity / 4,
      avgLongMin: totalLong ? audits.flatMap((w) => w.longMin).reduce((s, v) => s + v, 0) / totalLong : 0,
      enduranceScoreAvg: (() => {
        const es = audits.flatMap((w) => w.endScores)
        return es.length >= 2 ? es.reduce((s, v) => s + v, 0) / es.length : null
      })(),
      totalLong,
      totalIntensity
    }

    // --- 1. 疲劳状态（TSB） ---
    const today = load[load.length - 1]
    if (today) {
      if (today.tsb < -30) {
        out.push({
          level: 'danger',
          category: '疲劳管理',
          title: `疲劳累积过高（form ${today.tsb}）`,
          detail: `当前短期负荷 ATL ${today.atl} 明显高于长期负荷 CTL ${today.ctl}，过度训练风险升高。`,
          action: '安排 1-2 天完全休息或 30 分钟 Z1 恢复骑，保证睡眠。'
        })
      } else if (today.tsb > 10) {
        out.push({
          level: 'info',
          category: '状态窗口',
          title: `身体处于良好状态窗口（form ${today.tsb}）`,
          detail: '慢性负荷不高且急性负荷低，是进行高强度测试或比赛的好时机。',
          action: '可以安排一次 FTP 测试或 Z4/Z5 间歇课。'
        })
      } else {
        out.push({
          level: 'good',
          category: '疲劳管理',
          title: `训练负荷平衡良好（form ${today.tsb}）`,
          detail: `CTL ${today.ctl} / ATL ${today.atl}，保持在健康的进步区间，继续保持。`
        })
      }
    }

    // --- 2. 负荷增速：本周 TSS vs 前 4 周平均 ---
    const weekly = this.analysis.getTrends().weekly
    if (weekly.length >= 5) {
      const thisWeek = weekly[weekly.length - 1]
      const prev4 = weekly.slice(-5, -1)
      const avg4 = prev4.reduce((s, w) => s + w.tss, 0) / (prev4.length || 1)
      if (avg4 > 0 && thisWeek.tss > avg4 * 1.5 && thisWeek.tss > 150) {
        out.push({
          level: 'warn',
          category: '负荷增速',
          title: '训练负荷上升过快',
          detail: `本周 TSS ${Math.round(thisWeek.tss)} 是前四周平均（${Math.round(avg4)}）的 ${Math.round((thisWeek.tss / avg4) * 100)}%。周负荷增幅建议控制在 10% 以内。`,
          action: '削减本周剩余训练量，或把强度课改为耐力骑。'
        })
      } else if (avg4 > 0 && thisWeek.tss < avg4 * 0.6 && thisWeek.tss < 150) {
        out.push({
          level: 'info',
          category: '负荷增速',
          title: '本周训练量明显下降',
          detail: `本周 TSS ${Math.round(thisWeek.tss)}，前四周平均 ${Math.round(avg4)}。短暂减量（deload）每 3-4 周一次是正常的，连续两周以上则注意保持刺激。`
        })
      }
    }

    // --- 3. 强度分布（近一季，80/20 极化） ---
    const dash = this.analysis.getDashboard('quarter')
    const zone = dash.zoneDistribution
    const totalZoneSec = zone.reduce((s, z) => s + z.seconds, 0)
    if (totalZoneSec > 3600) {
      let easy: number
      let hard: number
      let moderate: number
      if (dash.zoneKind === 'power') {
        // 7 个功率区：Z1-2 低强度，Z3-4 中，Z5-7 高
        easy = (zone[0].seconds + zone[1].seconds) / totalZoneSec
        moderate = (zone[2].seconds + zone[3].seconds) / totalZoneSec
        hard = (zone[4].seconds + zone[5].seconds + zone[6].seconds) / totalZoneSec
      } else {
        easy = (zone[0].seconds + zone[1].seconds) / totalZoneSec
        moderate = zone[2].seconds / totalZoneSec
        hard = (zone[3].seconds + zone[4].seconds) / totalZoneSec
      }
      if (hard > 0.35) {
        out.push({
          level: 'warn',
          category: '强度分布',
          title: `高强度占比偏高（${Math.round(hard * 100)}%）`,
          detail: '极化模型建议约 80% 低强度 + 20% 高强度。高强度过多会拖慢恢复、限制有氧进步。',
          action: '把部分 Z3/Z4 骑行降到 Z2（能完整说话的强度）。'
        })
      } else if (hard < 0.08 && easy > 0.85 && totalZoneSec > 20 * 3600) {
        out.push({
          level: 'info',
          category: '强度分布',
          title: '训练缺少强度刺激',
          detail: '近 4 周几乎全是低强度骑行。要提升阈值和 VO2max，每周需要 1-2 次强度课。',
          action: '加入例如 4×5min Z5（间歇休息 3min）或 2×20min Z4。'
        })
      } else {
        out.push({
          level: 'good',
          category: '强度分布',
          title: `强度分布健康（低 ${Math.round(easy * 100)}% / 中 ${Math.round(moderate * 100)}% / 高 ${Math.round(hard * 100)}%）`,
          detail: '接近极化模型，继续维持。'
        })
      }
    }

    // --- 4. 连续骑行天数 ---
    const days = [...new Set(all.map((a) => a.startDate.slice(0, 10)))].sort()
    let streak = 1
    for (let i = days.length - 1; i > 0; i--) {
      const diff = (new Date(days[i]).getTime() - new Date(days[i - 1]).getTime()) / 86400_000
      if (diff === 1) streak++
      else break
    }
    if (streak >= 7) {
      out.push({
        level: 'warn',
        category: '恢复',
        title: `已连续骑行 ${streak} 天`,
        detail: '连续训练超过一周没有休息日，肌肉与神经系统的恢复会逐渐欠债。',
        action: '今天安排休息或 30 分钟轻松恢复骑。'
      })
    }

    // --- 5. 心率漂移（近 2 周长骑） ---
    const drifts: { a: Activity; dec: number }[] = []
    for (const a of all.slice(0, 10)) {
      if (a.movingTime < 5400) continue
      const s = this.store.getStreams(a.id)
      const dec = this.analysis.computeDecoupling(a, s)
      if (dec != null) drifts.push({ a, dec })
    }
    const badDrift = drifts.filter((d) => d.dec > 8)
    if (badDrift.length >= 2) {
      const longAlready = audit.longPerWeek >= 1
      out.push({
        level: 'info',
        category: '有氧基础',
        title: '长骑后段心率漂移明显',
        detail: `最近有 ${badDrift.length} 次长骑的心率-功率解耦超过 8%（如「${badDrift[0].a.name}」漂移 ${badDrift[0].dec}%）。说明有氧耐力底子还有提升空间，也可能与补给/脱水有关。`,
        action: longAlready
          ? `你近 4 周已有 ${audit.totalLong} 次 90 分钟以上长骑（平均 ${Math.round(audit.avgLongMin)} 分钟），长骑量不是问题，瓶颈在执行：前半程主动压心率、每 45-60 分钟补给 30-60g 碳水、高温天每小时补水 500-750ml，再观察漂移是否收窄。`
          : '增加 Z2 长骑占比；超过 90 分钟的骑行每小时补充 60g 碳水 + 500ml 水。'
      })
    }

    // --- 6. 体能（CTL）平台 ---
    if (all.length > 10) {
      const load = this.analysis.loadSeries(120)
      if (load.length >= 35) {
        const ctlNow = load[load.length - 1].ctl
        const ctl4wAgo = load[load.length - 29].ctl
        if (ctlNow - ctl4wAgo < 2) {
          out.push({
            level: 'info',
            category: '能力进展',
            title: `近 4 周体能（CTL ${ctlNow}）基本持平`,
            detail: '维持型训练量适合休整期；想继续提升需要新的训练刺激。',
            action: '二选一：把周骑行时长增加 5-10%，或保持时长不变、每周多安排 1 次高质量间歇课。'
          })
        } else {
          out.push({
            level: 'good',
            category: '能力进展',
            title: `体能持续上升（4 周 +${ctlNow - ctl4wAgo} CTL）`,
            detail: '当前训练正在转化为能力，注意疲劳管理与睡眠，避免连续透支。'
          })
        }
      }
    }

    // --- 7. 骑行结构审计：基于近 4 周实际课表给建议（已有的不再重复建议） ---
    const now = Date.now()
    const lastLong = all.find((a) => a.movingTime > 7200)
    const lastIntensity = all.find((a) => {
      if (a.weightedAverageWatts && ftp && a.weightedAverageWatts > ftp * 0.9) return true
      return a.sufferScore != null && a.sufferScore > 100
    })
    if (lastLong && now - new Date(lastLong.startDate).getTime() > 21 * 86400_000) {
      out.push({
        level: 'info',
        category: '训练结构',
        title: '超过 3 周没有 2 小时以上的长骑',
        detail: '长距离耐力骑是公路骑行的基础，建议每周至少安排一次 2 小时以上的 Z2 骑行。'
      })
    } else if (audit.longPerWeek >= 1) {
      // 长骑已经规律——不再建议「加入长骑」，转向质量与进阶
      const nEnd = audits.flatMap((w) => w.endScores).length
      const scoreTxt =
        audit.enduranceScoreAvg != null
          ? `，近 4 周 ${nEnd} 节有氧耐力课执行质量平均 ${Math.round(audit.enduranceScoreAvg)} 分（按 Z1-Z2 区间纯净度评分，不是骑得快慢）`
          : ''
      if (audit.enduranceScoreAvg != null && audit.enduranceScoreAvg < 70) {
        const worst = lowEndRides.sort((x, y) => x.score - y.score).slice(0, 2)
        const worstTxt = worst.length
          ? `拉低平均的主要是：${worst.map((r) => `${r.date}「${r.name}」${r.score} 分（${r.reason}）`).join('；')}。其余耐力课执行都不错。`
          : '常见问题是前半程骑过头或频繁拉爆式加速，把有氧课骑成了混氧课，刺激变浅、恢复变慢。'
        out.push({
          level: 'warn',
          category: '长骑质量',
          title: `长骑频率已达标（近 4 周 ${audit.totalLong} 次 90min+），但有氧课纯净度被稀释（平均 ${Math.round(audit.enduranceScoreAvg)} 分）`,
          detail: `你的长骑量足够${scoreTxt}。${worstTxt}`,
          action: '下一次长骑把心率锁在「能完整说句子」的区间，前半程刻意比感觉再慢 5%；质量分上 80 后再考虑加量。'
        })
      } else {
        out.push({
          level: 'good',
          category: '长骑结构',
          title: `长骑已规律：近 4 周 ${audit.totalLong} 次 90 分钟以上（平均 ${Math.round(audit.avgLongMin)} 分钟）${scoreTxt}`,
          detail: '有氧基础的主要来源已经稳定，不需要再加量；继续堆长骑时间的边际收益在下降。',
          action: '进阶二选一：① 每两周把其中一次延长 15-20 分钟；② 在长骑末段加 3×5min 高踏频（95+ rpm）或缓坡重复，把底子转化为踩踏效率。'
        })
      }
    }
    if (lastIntensity && now - new Date(lastIntensity.startDate).getTime() > 14 * 86400_000) {
      out.push({
        level: 'info',
        category: '训练结构',
        title: '超过 2 周没有高强度刺激',
        detail: '缺少 Z4+ 强度课，阈值能力会缓慢退步。',
        action: '本周安排一次强度课：热身 15min → 3×10min Z4（间歇 5min）→ 放松 15min。'
      })
    } else if (audit.intensityPerWeek >= 3) {
      out.push({
        level: 'warn',
        category: '训练结构',
        title: `强度课偏多：近 4 周 ${audit.totalIntensity} 次节奏/间歇课`,
        detail: '平均每周超过 3 次高强度课，恢复跟不上时强度会「变形」——练得多但质量下降。业余骑手每周 1-2 次质量课吸收效率最高。',
        action: '本周把一次强度课换成 Z2 长骑，观察下一次强度课的功率/心率是否明显变好。'
      })
    } else if (audit.intensityPerWeek >= 1) {
      out.push({
        level: 'good',
        category: '训练结构',
        title: `强度课节奏健康：近 4 周 ${audit.totalIntensity} 次（约 ${audit.intensityPerWeek.toFixed(1)} 次/周）`,
        detail: '强度与有氧的比例接近业余最优结构，保持这个节奏。'
      })
    }

    // 排序：danger > warn > info > good
    const order = { danger: 0, warn: 1, info: 2, good: 3 }
    return out.sort((a, b) => order[a.level] - order[b.level])
  }

  // ---------- 单次活动教练点评 ----------
  reviewActivity(
    a: Activity,
    streams: Streams | null,
    m: { tss: number | null; tssMethod: string | null; intensityFactor: number | null; np: number | null },
    decoupling: number | null
  ): ActivityReview {
    const store = this.store
    const highlights: string[] = []
    const concerns: string[] = []
    const suggestions: string[] = []
    const stats: { label: string; value: string }[] = []

    const hasPower = !!streams?.watts?.some((v) => v > 0) && a.deviceWatts
    const hasHr = !!streams?.heartrate?.some((v) => v > 0) || (a.averageHeartrate ?? 0) > 60
    const { tss } = m
    const if_ = m.intensityFactor
    const ftp = store.getFtp()
    const settings = store.getSettings()
    const weight = settings.weightKg
    const startMs = new Date(a.startDate).getTime()

    // ---------- 上下文：智能基线（近 8 周同类型 + 距离/爬升密度相近，取中位数） ----------
    const list = store.listActivities()
    const mpk = a.distance > 3000 ? a.totalElevationGain / (a.distance / 1000) : 0
    const before = (x: Activity, days: number) => {
      const t = new Date(x.startDate).getTime()
      return t < startMs && t > startMs - days * 86400_000
    }
    const similarWork = (x: Activity) => {
      if (a.distance > 5000 && Math.abs(x.distance - a.distance) > a.distance * 0.5) return false
      const xMpk = x.distance > 3000 ? x.totalElevationGain / (x.distance / 1000) : 0
      return Math.abs(xMpk - mpk) <= Math.max(3, mpk * 0.45)
    }
    const base8w = list.filter((x) => x.id !== a.id && x.type === a.type && x.distance > 5000 && before(x, 56))
    const matched = base8w.filter(similarWork)
    let peers: Activity[]
    let peerScope: string
    if (matched.length >= 3) {
      peers = matched
      peerScope = '近8周同类'
    } else if (base8w.length >= 3) {
      peers = base8w
      peerScope = '近8周'
    } else {
      peers = list.filter((x) => x.id !== a.id && x.type === a.type && x.distance > 5000 && before(x, 90))
      peerScope = '近90天'
    }
    const peerSpeed = peers.length >= 3 ? median(peers.map((x) => x.averageSpeed)) : 0
    const speedDiff = peerSpeed > 0 ? ((a.averageSpeed - peerSpeed) / peerSpeed) * 100 : 0
    // NP 基线（有功率的同类骑行）
    const peerNps = peers.filter((x) => x.deviceWatts && x.weightedAverageWatts).map((x) => x.weightedAverageWatts!)
    const peerNp = peerNps.length >= 3 ? median(peerNps) : 0
    const npDiff = peerNp > 0 && m.np ? ((m.np - peerNp) / peerNp) * 100 : 0
    // EF（NP/平均心率）纵向对比
    const rideEf = m.np && a.averageHeartrate && a.averageHeartrate >= 100 ? m.np / a.averageHeartrate : 0
    const peerEfs = peers
      .filter((x) => x.deviceWatts && x.weightedAverageWatts && x.averageHeartrate && x.averageHeartrate >= 100)
      .map((x) => x.weightedAverageWatts! / x.averageHeartrate!)
    const peerEf = peerEfs.length >= 3 ? median(peerEfs) : 0
    const efDiff = peerEf > 0 && rideEf > 0 ? ((rideEf - peerEf) / peerEf) * 100 : 0

    // ---------- 上下文：骑行前一周累计负荷 ----------
    const weekTss = list
      .filter((x) => {
        const t = new Date(x.startDate).getTime()
        return t <= startMs + 86400_000 && t > startMs - 7 * 86400_000
      })
      .reduce((s, x) => s + this.analysis.activityTss(x, ftp).tss, 0)

    // ---------- 上下文：骑行当天的疲劳状态（TSB） ----------
    const rideDate = a.startDate.slice(0, 10)
    const daysSince = Math.ceil((Date.now() - startMs) / 86400_000) + 2
    const lp = daysSince <= 400 ? this.analysis.loadSeries(Math.max(60, daysSince)).find((p) => p.date === rideDate) : undefined
    const tsbAt = lp?.tsb ?? null

    // ---------- 前后半程速度对比（负分割 / 掉速）——仅户外骑（骑行台虚拟速度受模拟坡度影响，对比无意义） ----------
    let fade = 0
    const vs = streams?.velocitySmooth
    if (vs && vs.length > 1200 && !a.trainer && a.type !== 'VirtualRide') {
      const segAvg = (arr: number[]) => {
        const p = arr.filter((v) => v > 0)
        return p.length ? p.reduce((s, v) => s + v, 0) / p.length : 0
      }
      const half = Math.floor(vs.length / 2)
      const first = segAvg(vs.slice(0, half))
      const second = segAvg(vs.slice(half))
      if (first > 2) fade = ((second - first) / first) * 100
    }

    // ---------- 数据速览 ----------
    stats.push({
      label: '均速',
      value: `${(a.averageSpeed * 3.6).toFixed(1)} km/h${speedDiff !== 0 ? `（${speedDiff > 0 ? '+' : ''}${Math.round(speedDiff)}% vs ${peerScope}中位）` : ''}`
    })
    if (m.np)
      stats.push({
        label: 'NP',
        value: `${Math.round(m.np)} W${weight ? ` · ${(m.np / weight).toFixed(2)} W/kg` : ''}${npDiff ? ` · ${npDiff > 0 ? '+' : ''}${Math.round(npDiff)}% vs ${peerScope}` : ''}`
      })
    if (if_ != null) stats.push({ label: '强度 IF', value: if_.toFixed(2) })
    if (a.averageHeartrate) {
      const pct = settings.lthr ? ` · ${Math.round((a.averageHeartrate / settings.lthr) * 100)}% LTHR` : ''
      stats.push({ label: '平均心率', value: `${Math.round(a.averageHeartrate)} bpm${pct}` })
    }
    if (rideEf > 0) {
      stats.push({ label: 'EF（功率/心率）', value: `${rideEf.toFixed(2)}${peerEf ? `（${peerScope}中位 ${peerEf.toFixed(2)}）` : ''}` })
    }
    if (a.averageCadence) stats.push({ label: '平均踏频', value: `${Math.round(a.averageCadence)} rpm` })
    stats.push({
      label: '爬升',
      value: `${Math.round(a.totalElevationGain)} m${a.distance > 3000 ? ` · ${(a.totalElevationGain / (a.distance / 1000)).toFixed(1)} m/km` : ''}`
    })
    const stopSec = Math.max(a.elapsedTime - a.movingTime, 0)
    if (a.elapsedTime > 1800 && stopSec / a.elapsedTime > 0.08) {
      stats.push({ label: '途中停留', value: `${Math.round(stopSec / 60)} min（${Math.round((stopSec / a.elapsedTime) * 100)}%）` })
    }
    if (a.kilojoules) {
      stats.push({
        label: '做功',
        value: `${Math.round(a.kilojoules)} kJ${a.movingTime > 600 ? ` · ${Math.round(a.kilojoules / (a.movingTime / 3600))} kJ/h` : ''}`
      })
    }
    if (tss != null) {
      stats.push({ label: 'TSS', value: `${tss}${m.tssMethod === 'estimate' || m.tssMethod === 'hr-approx' ? '（估算）' : ''}` })
    }
    if (weekTss > 0) stats.push({ label: '前 7 天 TSS', value: `${Math.round(weekTss)}（含本次）` })

    // ---------- 课型识别（L2）+ 执行质量（L3） ----------
    const course = this.analysis.classifyRide(a, streams)

    // ---------- 定级 ----------
    let grade: ActivityReview['grade'] = 'easy'
    if ((tss != null && tss >= 180) || (if_ != null && if_ >= 0.95)) grade = 'hard'
    else if ((tss != null && tss >= 100) || (if_ != null && if_ >= 0.8)) grade = 'solid'
    else if ((tss != null && tss >= 50) || a.movingTime >= 7200) grade = 'moderate'
    const gradeText = { hard: '大负荷训练日', solid: '高质量训练', moderate: '中等负荷', easy: '轻松骑' }[grade]

    // ---------- 总评 ----------
    const typeLabel = TYPE_LABELS[a.type] ?? a.type
    let summary: string
    if (tss == null) {
      summary = `本次${typeLabel} ${fmtKm(a.distance)} km、移动 ${fmtDuration(a.movingTime)}。`
    } else if (m.tssMethod === 'estimate') {
      summary = `本次${typeLabel} ${fmtKm(a.distance)} km、移动 ${fmtDuration(a.movingTime)}，TSS ${tss}（无功率/心率数据，按时间估算，点评基于速度与路线数据）。`
    } else {
      const ifTxt = if_ != null ? `、强度系数 IF ${if_.toFixed(2)}` : ''
      summary = `本次${typeLabel} ${fmtKm(a.distance)} km、移动 ${fmtDuration(a.movingTime)}，TSS ${tss}${ifTxt}——属于${gradeText}。`
    }
    if (course.type !== 'easy') summary += ` ${course.basis}。`

    // ---------- 亮点 ----------
    if (fade >= 2) {
      highlights.push(`后半程均速比前半程快 ${Math.round(fade)}%（负分割），配速策略出色，耐力底子好。`)
    } else if (fade >= -5 && grade !== 'easy') {
      highlights.push('前后半程速度几乎一致，全程配速控制稳定。')
    }
    if (speedDiff >= 5 && a.distance > 10000) {
      highlights.push(`均速比${peerScope}中位数快 ${Math.round(speedDiff)}%，状态在提升。`)
    }
    if (efDiff >= 3) {
      highlights.push(`EF（功率/心率）比${peerScope}中位数高 ${Math.round(efDiff)}%，有氧效率在进步。`)
    }
    if (tsbAt != null && tsbAt <= -15 && (speedDiff >= 5 || npDiff >= 5 || efDiff >= 3)) {
      highlights.push(`在明显疲劳期（当日 TSB ${tsbAt}）仍交出高于近期水平的表现，能力底子扎实。`)
    }
    if (decoupling != null && decoupling <= 5 && a.movingTime >= 5400) {
      highlights.push(`长骑心率漂移仅 ${decoupling}%，有氧耐力状态优秀。`)
    }
    const cad = a.averageCadence
    if (cad && (a.type === 'Ride' || a.type === 'VirtualRide') && a.movingTime > 1800 && cad >= 85 && cad <= 98) {
      highlights.push(`平均踏频 ${Math.round(cad)} rpm，处于高效踩踏区间。`)
    }
    if (hasPower && m.np && a.averageWatts && if_ != null && if_ >= 0.75) {
      const vi = m.np / a.averageWatts
      if (vi <= 1.06) {
        highlights.push(`输出非常平稳（变异指数 VI ${vi.toFixed(2)}），功率控制能力好。`)
      } else if (vi >= 1.15) {
        highlights.push(`输出波动大（VI ${vi.toFixed(2)}），包含大量变速/间歇刺激。`)
      }
    }
    if (hasPower && streams?.watts && streams.time.length >= 300) {
      const best = this.analysis.globalPowerBest()
      if (streams.time.length >= 1200) {
        const p20 = Math.round(rollingMaxAvg(streams.watts, 1200))
        if (p20 > 100 && p20 >= Math.round(best.get(1200) ?? 0)) {
          highlights.push(`本次 20 分钟最佳功率 ${p20}W，是你目前的历史纪录！可到「设置」重估 FTP。`)
        }
      }
      const p5 = Math.round(rollingMaxAvg(streams.watts, 300))
      if (p5 > 100 && p5 >= Math.round(best.get(300) ?? 0)) {
        highlights.push(`本次 5 分钟最佳功率 ${p5}W，刷新个人历史纪录。`)
      }
    }
    const mPerKm = a.distance > 3000 ? a.totalElevationGain / (a.distance / 1000) : 0
    if (a.totalElevationGain >= 1500) {
      highlights.push(`累计爬升 ${Math.round(a.totalElevationGain)} m，是一次标准的大山日训练。`)
    } else if (mPerKm >= 12 && a.totalElevationGain >= 300) {
      highlights.push(`爬升密度 ${mPerKm.toFixed(1)} m/km，爬坡强度可观。`)
    }
    if (a.movingTime >= 3 * 3600) {
      highlights.push(`移动时间 ${fmtDuration(a.movingTime)}，长距离耐力得到有效锻炼。`)
    }
    // 区间分布叙事（有逐秒数据时）
    const zones = this.analysis.computeTimeInZones(a, streams)
    const zoneTotal = zones.reduce((s, z) => s + z.seconds, 0)
    if (zoneTotal > 1800 && zones.length >= 4) {
      const easy = (zones[0].seconds + zones[1].seconds) / zoneTotal
      const hard = (zones[zones.length - 2].seconds + zones[zones.length - 1].seconds) / zoneTotal
      if (easy >= 0.7) highlights.push(`低强度区间时间占 ${Math.round(easy * 100)}%，是典型的有氧基础课。`)
      else if (hard >= 0.25) highlights.push(`高强度区间时间占 ${Math.round(hard * 100)}%，刺激充足。`)
    }
    // 课型执行质量（L3）：高分进亮点，低分进待改进
    if (course.score != null) {
      const top = course.scoreReasons[0]
      if (course.score >= 85 && top) highlights.push(`本次${course.label}执行质量 ${course.score} 分：${top}。`)
      else if (course.score < 70) concerns.push(`按${course.label}的标准，本次执行质量只有 ${course.score} 分：${top ?? '执行与课型目标有偏差'}。`)
    }
    const hour = new Date(a.startDate).getHours()
    if (hour >= 5 && hour < 8 && a.movingTime >= 3600) {
      highlights.push('清晨出门训练，自律值拉满。')
    }

    // ---------- 待改进 ----------
    if (decoupling != null && a.movingTime >= 5400) {
      if (decoupling > 8) concerns.push(`心率漂移达 ${decoupling}%，后半程有氧效率明显下降（可能与体能、高温或补给不足有关）。`)
      else if (decoupling > 5) concerns.push(`心率漂移 ${decoupling}% 略偏高，有氧耐力还有提升空间。`)
    }
    if (fade <= -10) {
      concerns.push(`后半程均速比前半程慢 ${Math.abs(Math.round(fade))}%，可能起步过猛、补给不足或耐力欠缺。`)
    }
    if (cad && cad < 75 && (a.type === 'Ride' || a.type === 'VirtualRide') && a.movingTime > 1800) {
      concerns.push(`平均踏频仅 ${Math.round(cad)} rpm 偏低，长期低踏频大齿比会加速肌肉疲劳、增加膝盖负担。`)
    }
    if (hasHr && a.averageHeartrate && if_ != null && if_ < 0.8 && a.averageHeartrate > this.analysis.hrZoneBounds()[3]) {
      concerns.push('平均心率偏高但功率强度不高，可能与高温、脱水或身体疲劳有关。')
    }
    if (!hasPower && !hasHr) {
      concerns.push('缺少功率与心率数据，训练负荷只能按时间估算；建议佩戴心率带或功率计记录。')
    }
    if (speedDiff <= -10 && grade !== 'easy' && peers.length >= 5) {
      concerns.push(
        tsbAt != null && tsbAt <= -15
          ? `均速比${peerScope}中位数慢 ${Math.abs(Math.round(speedDiff))}%，但当日 TSB ${tsbAt} 处于疲劳期，属训练中的正常回落，减量后会恢复。`
          : `均速比${peerScope}同类型中位数慢 ${Math.abs(Math.round(speedDiff))}%，若是刻意放松骑则没问题，否则留意身体状态。`
      )
    }
    if (efDiff <= -4 && grade !== 'easy') {
      concerns.push(`EF 比${peerScope}中位数低 ${Math.abs(Math.round(efDiff))}%——同样功率下心率更高，可能与疲劳、高温或脱水有关。`)
    }
    if (tsbAt != null && tsbAt >= 0 && grade !== 'easy' && (speedDiff <= -8 || efDiff <= -4) && peers.length >= 5) {
      concerns.push(`当日状态并不疲劳（TSB ${tsbAt}），但数据低于近期水平——若非刻意放松，留意睡眠或身体状态的隐性波动。`)
    }
    if (a.elapsedTime > 5400 && stopSec / a.elapsedTime > 0.25) {
      concerns.push(`途中停留占 ${Math.round((stopSec / a.elapsedTime) * 100)}%，实际训练刺激低于表观时长。`)
    }
    if (weekTss > 500) {
      concerns.push(`骑行前 7 天累计 TSS 已达 ${Math.round(weekTss)}，短期负荷偏高，注意恢复。`)
    }
    if (hour >= 23 || hour < 4) {
      concerns.push('深夜/凌晨骑行：注意安全与光照装备，且会影响睡眠恢复。')
    }

    // ---------- 建议 ----------
    if (weekTss >= 500 || (weekTss >= 350 && tss != null && tss >= 100)) {
      suggestions.push(
        `本次骑行前 7 天累计负荷已达 ${Math.round(weekTss)} TSS：明天完全休息或 20-30 分钟 Z1 恢复骑，随后两天也只安排低强度，把周负荷压回正常区间。`
      )
    } else if (tss != null && tss >= 250) {
      suggestions.push('负荷很大：明天完全休息，或只做 20-30 分钟 Z1 恢复骑，并保证睡眠。')
    } else if (tss != null && tss >= 150) {
      suggestions.push('明天安排轻松骑或休息，让身体吸收这次训练刺激。')
    } else if (tss != null && tss >= 60) {
      suggestions.push('明天可安排 Z2 耐力骑或交叉训练，注意补足碳水与蛋白质。')
    } else {
      suggestions.push('负荷不大，可保持规律骑行频率；轻松骑时把心率压在 Z1-Z2，恢复效果更好。')
    }
    if (if_ != null && if_ >= 0.95) {
      suggestions.push('阈值以上强度课后 48 小时内避免再安排高强度训练。')
    }
    if (decoupling != null && decoupling > 8 && a.movingTime >= 5400) {
      // 个性化：先核对近 4 周实际长骑频率，量够就不建议「再加长骑」
      const recentLong = list.filter((x) => {
        const t = new Date(x.startDate).getTime()
        return t < startMs && t > startMs - 28 * 86400_000 && x.movingTime >= 5400
      }).length
      suggestions.push(
        recentLong >= 4
          ? `心率漂移 ${decoupling}%：你近 4 周已有 ${recentLong} 次 90min+ 长骑，量不是问题——把补给执行做扎实（每 45-60 分钟 30-60g 碳水 + 500ml 水），并检查前半程是否骑过头。`
          : `心率漂移 ${decoupling}%：长骑频率还要加密（此前 4 周仅 ${recentLong} 次 90min+），每周固定 1 次 Z2 长骑；超过 90 分钟每小时补充 60g 碳水 + 500ml 水。`
      )
    }
    if (fade <= -10) {
      suggestions.push('前程放慢 5-10%，把力气留给后半程；先学会匀速完成，再追求更快。')
    }
    if (cad && cad < 75 && a.movingTime > 1800) {
      suggestions.push('热身中加入 3×3 分钟高踏频（95-105 rpm）练习，逐步提高踩踏效率。')
    }
    if (a.trainer) {
      suggestions.push('室内骑行散热差、出汗多：准备风扇并每小时补水 500-750 ml。')
    }
    if (a.commute) {
      suggestions.push('通勤骑强度自由，可作为主动恢复；想提升就路上加几组 1 分钟快速踏频。')
    }
    if (mPerKm >= 12) {
      suggestions.push('爬坡课注意坐姿/站姿交替，长坡保持稳定节奏（RPE 7-8）而不是忽快忽慢。')
    }
    if (suggestions.length === 0) {
      suggestions.push('保持当前节奏：每周约 80% 骑行时间留在 Z2，配合 1-2 次强度课。')
    }

    return {
      grade,
      summary,
      stats,
      course,
      highlights: highlights.slice(0, 4),
      concerns: concerns.slice(0, 4),
      suggestions: suggestions.slice(0, 4)
    }
  }
}

