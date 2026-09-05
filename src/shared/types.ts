/** 共享类型：主进程与渲染进程共用 */

export interface RideTypeConfig {
  value: string
  label: string
}

export const RIDE_TYPES: RideTypeConfig[] = [
  { value: 'Ride', label: '公路骑行' },
  { value: 'VirtualRide', label: '骑行台' },
  { value: 'GravelRide', label: '砾石' },
  { value: 'MountainBikeRide', label: '山地' },
  { value: 'EBikeRide', label: '电助力' },
  { value: 'Handcycle', label: '手摇' }
]

/** 活动摘要（列表/分析用） */
export interface Activity {
  id: string
  source: 'strava' | 'local'
  name: string
  type: string
  startDate: string // ISO UTC
  distance: number // m
  movingTime: number // s
  elapsedTime: number // s
  totalElevationGain: number // m
  averageSpeed: number // m/s
  maxSpeed: number // m/s
  averageHeartrate?: number
  maxHeartrate?: number
  averageWatts?: number // 不含骑行台估算时可能没有
  weightedAverageWatts?: number // NP
  maxWatts?: number
  kilojoules?: number
  averageCadence?: number
  sufferScore?: number
  calories?: number
  hasHeartrate: boolean
  deviceWatts: boolean
  trainer: boolean
  commute: boolean
  startLatlng?: [number, number]
  endLatlng?: [number, number]
  mapSummary?: string // encoded polyline
  tzOffset?: number
}

/** streams 数据（单次骑行时序） */
export interface Streams {
  time: number[] // 相对活动开始的秒
  latlng?: [number, number][]
  distance: number[] // m
  altitude: number[] // m
  velocitySmooth?: number[] // m/s
  heartrate?: number[]
  cadence?: number[]
  watts?: number[]
  moving?: number[]
}

export interface AppSettings {
  strava?: {
    clientId: string
    clientSecret: string
  }
  ftp: {
    manual?: number | null // 手动覆盖
    auto: number | null // 自动估算
    mode: 'auto' | 'manual'
  }
  weightKg?: number
  restingHr?: number
  maxHr?: number
  lthr?: number // 乳酸阈心率
  rideTypes: string[]
  lastActivitySync?: string
  /** HTTP 代理，如 http://127.0.0.1:7890；为空则使用系统代理 */
  proxy?: string
  /** 启动时自动同步活动列表 */
  autoSync?: boolean
}

export interface HrZones {
  /** 每个区间的 bpm 上限，最后一个为 Infinity */
  bounds: number[] // [z1max, z2max, z3max, z4max] bpm
  labels: string[]
}

/** 仪表盘统计范围（周/月/季为自然周期，半年/年为滚动窗口） */
export type DashRange = 'week' | 'month' | 'quarter' | 'half' | 'year'

export interface DashboardData {
  /** 所选范围内的汇总统计（全部随范围选择器联动） */
  summary: {
    distance: number
    time: number
    elevation: number
    count: number
    /** 时长加权平均速度 m/s */
    avgSpeed: number
    avgHr: number | null
    avgCadence: number | null
    tss: number
  }
  /** 年度累计距离（固定指标，不随范围选择变化） */
  ytdDistance: number
  load: LoadPoint[]
  zoneDistribution: { label: string; seconds: number }[]
  zoneKind: 'power' | 'hr'
  /** 所选范围内心率区间分布（与功率区间并列输出，仅当有心率数据时提供） */
  hrZoneDistribution?: { label: string; seconds: number }[]
  /** 部分区间时间为平均心率估算（缺逐秒数据） */
  zoneEstimated?: boolean
  /** 尚未同步详细数据（streams）的活动数 */
  missingStreams?: number
  recent: (Activity & { tss?: number })[]
  ftp: number | null
  weightKg?: number
  bestPower: { window: number; watts: number }[] // 关键窗口最佳功率
}

export interface LoadPoint {
  date: string // YYYY-MM-DD
  tss: number
  ctl: number
  atl: number
  tsb: number
}

/** 近 12 周每周训练结构 */
export interface WeekTraining {
  weekStart: string // 周一日期 YYYY-MM-DD
  tss: number
  hours: number // 移动时间（小时）
  easyH: number // 低强度 Z1-Z2（小时）
  modH: number // 中等 Z3（小时）
  hardH: number // 高强度 Z4+（小时）
  tsb: number // 周末疲劳平衡
  ctl: number // 周末体能
  estimated: boolean // 区间时间含平均心率估算
}

/** 能力分析页聚合数据 */
export interface AbilityData {
  /** 骑手类型画像 */
  profile: {
    ftp: number | null
    best: { s5: number | null; m1: number | null; m5: number | null; m20: number | null; m60: number | null }
    /** 各项最佳功率 / FTP 比例 */
    ratios: { sprint: number; anaerobic: number; vo2: number; threshold: number }
    /** 与典型业余水平对照（100=典型） */
    radar: { sprint: number; anaerobic: number; vo2: number; threshold: number }
    type: string
    typeDesc: string
    strengths: string[]
    weaknesses: string[]
    basedOn: number
  }
  /** 全局功率-时间曲线（近 90 天 vs 之前 90 天） */
  pd: {
    windows: string[]
    current: (number | null)[]
    previous: (number | null)[]
    cp: number | null
    wPrimeJ: number | null
    /** CP 模型预测 P(t)=CP+W′/t */
    predicted: (number | null)[]
  }
  /** 功率纪录：各窗口的 PR 演进 */
  prTimeline: { label: string; events: { date: string; watts: number }[] }[]
  /** 自动检测的爬坡段 */
  climbs: {
    date: string
    activityId: string
    activityName: string
    distanceM: number
    gainM: number
    avgGradient: number
    maxGradient: number
    vam: number
    avgWatts: number | null
  }[]
  /** 有氧效率趋势（解耦 + EF），仅稳态骑 */
  aerobicTrend: { date: string; decoupling: number | null; ef: number | null }[]
  /** 全年日历热力图 */
  calendar: { date: string; tss: number; km: number }[]
  streak: { current: number; longest: number; daysThisMonth: number }
  /** 下周训练处方 */
  prescription: {
    mode: 'recovery' | 'maintain' | 'progressive' | 'opportunity'
    modeLabel: string
    thisWeekTss: number
    avg4WeekTss: number
    rampRatePct: number
    nextWeekTssMin: number
    nextWeekTssMax: number
    messages: string[]
  }
  /** 踏频-功率关系（仅功率计骑行） */
  cadence: {
    /** 抽样散点 [踏频 rpm, 功率 W] */
    scatter: [number, number][]
    /** 全部踩踏样本的踏频中位数 */
    medianCadence: number | null
    /** 高功率（≥0.75×FTP）时的踏频中位数 */
    highPowerCadence: number | null
  }
}

/** 课型识别结果（点评与建议引擎共用） */
export type CourseType = 'endurance' | 'tempo' | 'intervals' | 'recovery' | 'easy'

export interface RideCourse {
  type: CourseType
  label: string
  /** 判定依据（人话） */
  basis: string
  /** 执行质量分 0-100，null = 不评分（日常骑） */
  score: number | null
  /** 评分理由 */
  scoreReasons: string[]
  metrics: {
    z1z2Share: number
    z3Share: number
    hardShare: number
    hardBlocks: number
    if_: number | null
    hours: number
  }
}

export interface TrendsData {
  weekly: { weekStart: string; distance: number; time: number; elevation: number; tss: number; count: number }[]
  monthly: { month: string; distance: number; time: number; elevation: number; tss: number; count: number }[]
  speedTrend: { date: string; avgSpeed: number; activity: string }[]
  /** 心率效率趋势：每月「同条件骑行」（45-150min 户外骑）的平均心率中位数，趋势下降=有氧进步 */
  hrTrend: { month: string; hr: number; n: number }[]
  /** 踏频趋势：每月平均踏频（按时长加权） */
  cadenceTrend: { month: string; cadence: number; n: number }[]
  /** 月度心率区间结构：Z1-Z5 累计秒数（仅有心率数据的活动） */
  hrZoneTrend: { month: string; zones: number[] }[]
  /** 训练结构分析（替代月度 FTP 曲线） */
  training: {
    weeks: WeekTraining[]
    /** 自动生成的训练洞察与指引 */
    insights: string[]
  }
}

export type AdviceLevel = 'danger' | 'warn' | 'info' | 'good'

export interface AdviceItem {
  level: AdviceLevel
  category: string
  title: string
  detail: string
  action?: string
}

export interface PowerCurve {
  windows: { seconds: number; label: string }[]
  values: number[] // 对应窗口的最大平均功率，null 用 0 表示无数据
  ftpEstimate20min: number | null
  cp: number | null
  wPrime: number | null
}

export interface ActivityDetailData {
  activity: Activity
  streams: Streams | null
  powerCurve: PowerCurve | null
  timeInZones: { label: string; seconds: number; power?: boolean; hr?: boolean }[]
  decoupling: number | null // Pw:Hr 或 Hr:Pace 漂移 %
  tss: number | null
  tssMethod: string | null
  intensityFactor: number | null
  np: number | null
  review: ActivityReview | null
}

/** 单次活动的教练点评（规则引擎生成） */
export interface ActivityReview {
  grade: 'hard' | 'solid' | 'moderate' | 'easy'
  summary: string
  /** 数据速览（键值对，直接展示） */
  stats: { label: string; value: string }[]
  highlights: string[]
  concerns: string[]
  suggestions: string[]
  /** 课型识别 + 执行质量分（P1 课型引擎） */
  course: RideCourse | null
}

export interface SyncProgress {
  phase: 'activities' | 'streams'
  current: number
  total: number
  message: string
}
