import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'

type ZoneKey = 'Z1' | 'Z2' | 'Z3' | 'Z4' | 'Z5' | 'Z6' | 'Z7'

interface Step {
  name: string
  minutes: number
  zone: ZoneKey
  note?: string
}

interface Workout {
  id: string
  name: string
  goal: string
  level: string
  durationMin: number
  estTss: number
  steps: Step[]
  tip: string
}

/** 功率区间（%FTP） */
const POWER_ZONE_PCT: Record<ZoneKey, [number, number] | null> = {
  Z1: [0, 0.55],
  Z2: [0.55, 0.75],
  Z3: [0.75, 0.9],
  Z4: [0.9, 1.05],
  Z5: [1.05, 1.2],
  Z6: [1.2, 1.5],
  Z7: [1.5, 2.5]
}

/** 心率区间（%LTHR） */
const HR_ZONE_PCT: Record<ZoneKey, [number, number] | null> = {
  Z1: [0, 0.68],
  Z2: [0.68, 0.83],
  Z3: [0.83, 0.94],
  Z4: [0.94, 1.05],
  Z5: [1.05, 1.15],
  Z6: null,
  Z7: null
}

const ZONE_COLORS: Record<ZoneKey, string> = {
  Z1: '#4caf7d',
  Z2: '#4d9fff',
  Z3: '#f0b429',
  Z4: '#fc4c02',
  Z5: '#e5484d',
  Z6: '#b04df0',
  Z7: '#f04da5'
}

const WORKOUTS: Workout[] = [
  {
    id: 'ftp-test',
    name: 'FTP 测试（20 分钟）',
    goal: '测定当前功能阈值功率，校准所有功率区间',
    level: '进阶',
    durationMin: 60,
    estTss: 75,
    tip: '测试前充分休息 1-2 天。20 分钟内输出你能维持的最大平均功率（约 RPE 9/10），完成后 FTP = 平均功率 × 0.95，填到「设置」里。',
    steps: [
      { name: '热身', minutes: 15, zone: 'Z2', note: '含 3 次 30 秒渐进加速（Z6），间隔 1 分钟轻松骑' },
      { name: '放松过渡', minutes: 5, zone: 'Z1' },
      { name: '20 分钟全力测试', minutes: 20, zone: 'Z4', note: '全力但可维持，前 3 分钟不要冲太猛' },
      { name: '放松', minutes: 15, zone: 'Z1' }
    ]
  },
  {
    id: 'threshold-2x20',
    name: '阈值间歇 2×20',
    goal: '提升 FTP 与乳酸阈值，最经典的提功率课',
    level: '进阶',
    durationMin: 80,
    estTss: 88,
    tip: '两组都要稳定在目标区间内；若第二组功率掉超 10%，说明目标定高了，下次降 5W。',
    steps: [
      { name: '热身', minutes: 15, zone: 'Z2' },
      { name: '阈值间歇 #1', minutes: 20, zone: 'Z4', note: '高踏频 85-95' },
      { name: '组间休息', minutes: 10, zone: 'Z1' },
      { name: '阈值间歇 #2', minutes: 20, zone: 'Z4' },
      { name: '放松', minutes: 15, zone: 'Z1' }
    ]
  },
  {
    id: 'sweetspot-3x12',
    name: '甜区训练 3×12',
    goal: '以较低疲劳换取阈值附近适应，性价比最高的耐力课',
    level: '中级',
    durationMin: 70,
    estTss: 72,
    tip: '甜区为 FTP 的 88-94%（Z3 顶端到 Z4 底端），呼吸加深但能短句交流。',
    steps: [
      { name: '热身', minutes: 15, zone: 'Z2' },
      { name: '甜区 #1', minutes: 12, zone: 'Z3', note: '88-94% FTP' },
      { name: '休息', minutes: 8, zone: 'Z1' },
      { name: '甜区 #2', minutes: 12, zone: 'Z3' },
      { name: '休息', minutes: 8, zone: 'Z1' },
      { name: '甜区 #3', minutes: 12, zone: 'Z3' },
      { name: '放松', minutes: 10, zone: 'Z1' }
    ]
  },
  {
    id: 'vo2-5x4',
    name: 'VO2max 间歇 5×4',
    goal: '提升最大摄氧量与高速耐力',
    level: '进阶',
    durationMin: 70,
    estTss: 80,
    tip: '强度很高，每周最多 1 次。间歇中心率会持续爬升，功率保持区间内即可。',
    steps: [
      { name: '热身', minutes: 15, zone: 'Z2', note: '含 2 次 1 分钟 Z4 激活' },
      { name: 'VO2 间歇 ×5', minutes: 4, zone: 'Z5', note: '4 分钟 × 5 组，组间 4 分钟 Z1' },
      { name: '放松', minutes: 15, zone: 'Z1' }
    ]
  },
  {
    id: 'sprints-8x30',
    name: '无氧冲刺 8×30s',
    goal: '提升冲刺能力与糖酵解功率',
    level: '中级',
    durationMin: 65,
    estTss: 60,
    tip: '每次冲刺全力输出，休息必须充分（4 分钟），否则会变成阈值训练。站姿启动，坐姿维持。',
    steps: [
      { name: '热身', minutes: 15, zone: 'Z2', note: '含 2 次 10 秒冲刺神经激活' },
      { name: '30 秒全力冲刺 ×8', minutes: 0.5, zone: 'Z7', note: '组间 4 分钟 Z1 完全恢复' },
      { name: '放松', minutes: 15, zone: 'Z1' }
    ]
  },
  {
    id: 'endurance-long',
    name: '耐力长骑 Z2',
    goal: '构建有氧基础，周末 2-4 小时',
    level: '入门',
    durationMin: 180,
    estTss: 120,
    tip: '全程保持能完整说话的强度。超过 90 分钟后每小时补充 60g 碳水 + 500ml 液体。最后可加 2×5 分钟 Z4 模拟进攻。',
    steps: [
      { name: '长距离耐力骑', minutes: 180, zone: 'Z2', note: '2-4 小时，末段可选 2×5min Z4' }
    ]
  },
  {
    id: 'recovery',
    name: '恢复骑',
    goal: '高强度课后或疲劳日促进血液循环',
    level: '入门',
    durationMin: 40,
    estTss: 18,
    tip: '真正的恢复骑要非常轻松——比你觉得“轻松”的强度再慢一档，踏频 90+。',
    steps: [
      { name: '全程轻松骑', minutes: 40, zone: 'Z1', note: '高踏频、零压力' }
    ]
  }
]

export function Workouts() {
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    window.api.getSettings().then(setSettings)
  }, [])

  const ftp = settings?.ftp.mode === 'manual' ? settings.ftp.manual : settings?.ftp.auto ?? settings?.ftp.manual
  const lthr = settings?.lthr
  const maxHr = settings?.maxHr

  const powerTarget = (z: ZoneKey): string => {
    if (!ftp) return '需设置 FTP'
    const range = POWER_ZONE_PCT[z]
    if (!range) return '全力'
    if (z === 'Z1') return `< ${Math.round((ftp * range[1]) / 5) * 5} W`
    if (z === 'Z7') return `> ${Math.round((ftp * range[0]) / 5) * 5} W`
    return `${Math.round((ftp * range[0]) / 5) * 5}–${Math.round((ftp * range[1]) / 5) * 5} W`
  }

  const hrTarget = (z: ZoneKey): string | null => {
    const range = HR_ZONE_PCT[z]
    if (!range) return null
    if (lthr) {
      if (z === 'Z1') return `< ${Math.round(lthr * range[1])} bpm`
      if (z === 'Z5') return `> ${Math.round(lthr * range[0])} bpm`
      return `${Math.round(lthr * range[0])}–${Math.round(lthr * range[1])} bpm`
    }
    if (maxHr) {
      // 无 LTHR 时用最大心率近似：Z1<60% Z2 60-70 Z3 70-80 Z4 80-90 Z5>90
      const map: Record<ZoneKey, string> = {
        Z1: `< ${Math.round(maxHr * 0.6)} bpm`,
        Z2: `${Math.round(maxHr * 0.6)}–${Math.round(maxHr * 0.7)} bpm`,
        Z3: `${Math.round(maxHr * 0.7)}–${Math.round(maxHr * 0.8)} bpm`,
        Z4: `${Math.round(maxHr * 0.8)}–${Math.round(maxHr * 0.9)} bpm`,
        Z5: `> ${Math.round(maxHr * 0.9)} bpm`,
        Z6: '',
        Z7: ''
      }
      return map[z] || null
    }
    return null
  }

  return (
    <>
      <h1 className="page-title">训练课表</h1>
      <p className="page-sub">
        基于当前 FTP {ftp ? <b style={{ color: 'var(--accent)' }}>{ftp}W</b> : '（未设置，功率目标显示为区间百分比）'}
        {lthr ? ` · LTHR ${lthr}bpm` : maxHr ? ` · 最大心率 ${maxHr}bpm` : ' · 未设置心率参数（仅显示功率目标）'}
        自动生成目标强度。建议每周：1 次强度课（阈值/VO2）+ 1 次长骑 + 2-3 次 Z2/Z1。
      </p>

      <div className="workout-grid">
        {WORKOUTS.map((w) => (
          <div key={w.id} className="card workout-card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ marginBottom: 4 }}>{w.name}</h3>
                <div className="hint">{w.goal}</div>
              </div>
              <span className="chip">{w.level}</span>
            </div>
            <div className="row" style={{ margin: '10px 0', color: 'var(--muted)', fontSize: 12 }}>
              <span>总时长 ~{w.durationMin >= 60 ? `${Math.floor(w.durationMin / 60)}h${w.durationMin % 60 ? `${w.durationMin % 60}m` : ''}` : `${w.durationMin}m`}</span>
              <span>· 预估 TSS {w.estTss}</span>
            </div>
            <div className="steps">
              {w.steps.flatMap((s, i) => {
                const reps =
                  s.name.includes('×5') || s.name.includes('×8')
                    ? s.name.includes('×5')
                      ? 5
                      : 8
                    : 1
                const rows = []
                for (let r = 0; r < reps; r++) {
                  rows.push(
                    <div className="step" key={`${i}-${r}`}>
                      <span className="step-badge" style={{ background: ZONE_COLORS[s.zone] }}>
                        {s.zone}
                      </span>
                      <span className="step-name">
                        {reps > 1 ? s.name.replace(/×\d/, `#${r + 1}`) : s.name}
                      </span>
                      <span className="step-time">{s.minutes < 1 ? '30s' : `${s.minutes}min`}</span>
                      <span className="step-target">
                        {powerTarget(s.zone)}
                        {hrTarget(s.zone) ? <span className="step-hr"> / {hrTarget(s.zone)}</span> : null}
                      </span>
                    </div>
                  )
                }
                return rows
              })}
            </div>
            <div className="advice-action" style={{ marginTop: 10, fontSize: 12 }}>
              {w.tip}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
