import { useEffect, useState } from 'react'
import type { DashboardData, DashRange } from '@shared/types'
import { Chart } from '../components/Chart'
import { StatCard } from '../components/StatCard'
import { km, duration, kmh, datetime, TYPE_LABELS } from '../lib/format'
import type { EChartsOption } from 'echarts'

/** 统计范围选项：全仪表盘联动（周/月/季为自然周期，半年/年为滚动窗口） */
const RANGES: { key: DashRange; label: string }[] = [
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'quarter', label: '本季度' },
  { key: 'half', label: '半年' },
  { key: 'year', label: '一年' }
]

/** 各范围对应的负荷图展示天数文案 */
const RANGE_LOAD_DAYS_LABEL: Record<DashRange, string> = {
  week: '28 天',
  month: '31 天',
  quarter: '一个季度',
  half: '半年',
  year: '一年'
}

export function Dashboard({
  version,
  onOpenDetail,
  onGoSettings
}: {
  version: number
  onOpenDetail: (id: string) => void
  onGoSettings: () => void
}) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [range, setRange] = useState<DashRange>('quarter')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')

  const reload = () => window.api.getDashboard(range).then(setData)

  useEffect(() => {
    reload()
  }, [version, range])

  useEffect(() => {
    return window.api.onSyncProgress((p) => {
      if (p.phase === 'streams' && p.total > 0) {
        setSyncing(true)
        setSyncMsg(p.message)
        if (p.current >= p.total) {
          setSyncing(false)
          setSyncMsg('')
          reload()
        }
      }
    })
  }, [])

  const startStreamSync = async () => {
    setSyncing(true)
    setSyncMsg('正在同步详细数据…')
    await window.api.syncAllStreams()
    setSyncing(false)
    setSyncMsg('')
    reload()
  }

  if (!data) return <div className="empty-state">加载中…</div>

  if (data.recent.length === 0) {
    return (
      <div className="empty-state">
        <div className="big">🚴</div>
        <h2>还没有骑行数据</h2>
        <p>先到「设置」连接 Strava 并同步，或导入 FIT/GPX 文件。</p>
        <button className="btn primary" onClick={onGoSettings}>
          去设置
        </button>
      </div>
    )
  }

  const loadOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['CTL 长期负荷', 'ATL 短期负荷', 'TSB 状态'], textStyle: { color: '#9aa4b0' }, top: 0 },
    grid: { left: 40, right: 16, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: data.load.map((p) => p.date.slice(5)), axisLabel: { color: '#9aa4b0' } },
    yAxis: { type: 'value', axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
    series: [
      { name: 'CTL 长期负荷', type: 'line', data: data.load.map((p) => p.ctl), showSymbol: false, lineStyle: { width: 2, color: '#fc4c02' } },
      { name: 'ATL 短期负荷', type: 'line', data: data.load.map((p) => p.atl), showSymbol: false, lineStyle: { width: 1.5, color: '#4d9fff' } },
      {
        name: 'TSB 状态',
        type: 'line',
        data: data.load.map((p) => p.tsb),
        showSymbol: false,
        lineStyle: { width: 1.5, color: '#4caf7d' },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: -30 }, { yAxis: 10 }],
          lineStyle: { type: 'dashed', color: '#5a6472' },
          label: { color: '#5a6472', formatter: '{b}' }
        }
      }
    ]
  }

  // 横向区间条形图（功率区间单色 / 心率区间 5 色分段）
  const HR_ZONE_COLORS = ['#4d9fff', '#4caf7d', '#f0b429', '#e5484d', '#a855f7']
  const zoneOptionOf = (dist: { label: string; seconds: number }[], colors: string[]): EChartsOption => ({
    tooltip: { formatter: (p: any) => `${p.name}: ${(p.value / 3600).toFixed(1)} 小时` },
    grid: { left: 80, right: 46, top: 8, bottom: 24 },
    xAxis: { type: 'value', axisLabel: { color: '#9aa4b0', formatter: (v: number) => `${Math.round(v / 3600)}h` }, splitLine: { lineStyle: { color: '#222932' } } },
    yAxis: { type: 'category', data: dist.map((z) => z.label).reverse(), axisLabel: { color: '#9aa4b0' } },
    series: [
      {
        type: 'bar',
        data: dist.map((z, i) => ({ value: z.seconds, itemStyle: { color: colors[colors.length - dist.length + i] ?? colors[0] } })).reverse(),
        barWidth: 16,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', color: '#9aa4b0', formatter: (p: any) => `${(p.value / 3600).toFixed(1)}h` }
      }
    ]
  })

  const zoneOption = zoneOptionOf(data.zoneDistribution, ['#fc4c02'])
  const hrZoneOption = data.hrZoneDistribution ? zoneOptionOf(data.hrZoneDistribution, HR_ZONE_COLORS) : null

  const tsb = data.load[data.load.length - 1]
  const zoneTotalSec = data.zoneDistribution.reduce((s, z) => s + z.seconds, 0)
  const rangeLabel = RANGES.find((r) => r.key === range)?.label ?? ''

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">仪表盘</h1>
          <p className="page-sub">
            {tsb ? `当前状态 TSB ${tsb.tsb}（CTL ${tsb.ctl} / ATL ${tsb.atl}）` : ''}{' '}
            {data.ftp ? `· FTP ${data.ftp}W${data.weightKg ? `（${(data.ftp / data.weightKg).toFixed(2)} W/kg）` : ''}` : ''}
          </p>
        </div>
        <div className="seg" role="tablist">
          {RANGES.map((r) => (
            <button key={r.key} className={range === r.key ? 'seg-btn active' : 'seg-btn'} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {data.missingStreams != null && data.missingStreams > 0 && (
        <div className="card sync-banner">
          <div className="sync-banner-text">
            <b>还有 {data.missingStreams} 次骑行的详细数据未同步</b>
            <span>
              详细数据（逐秒心率/功率/轨迹）是强度分布、功率曲线、心率漂移、FTP 自动估算的基础。
              启动时已自动同步最近 30 天，点击按钮后台补齐全部历史（自动处理限流）。
            </span>
            {syncMsg && <span style={{ color: 'var(--blue)' }}>{syncMsg}</span>}
          </div>
          <button className="btn primary" disabled={syncing} onClick={startStreamSync}>
            {syncing ? '同步中…' : '后台同步全部详细数据'}
          </button>
        </div>
      )}

      <div className="stat-grid">
        <StatCard label={`${rangeLabel}距离`} value={km(data.summary.distance)} sub={`${data.summary.count} 次骑行`} accent />
        <StatCard label={`${rangeLabel}时长`} value={duration(data.summary.time)} />
        <StatCard label={`${rangeLabel}爬升`} value={Math.round(data.summary.elevation) + ' m'} />
        <StatCard label={`${rangeLabel}训练负荷`} value={data.summary.tss > 0 ? String(data.summary.tss) : '—'} sub="TSS 合计" />
        <StatCard label={`${rangeLabel}均速`} value={kmh(data.summary.avgSpeed)} sub="按时长加权" />
        <StatCard label={`${rangeLabel}平均心率`} value={data.summary.avgHr ? Math.round(data.summary.avgHr) + ' bpm' : '—'} sub={data.summary.avgHr ? '按时长加权' : `${rangeLabel}无心率数据`} />
        <StatCard label={`${rangeLabel}平均踏频`} value={data.summary.avgCadence ? data.summary.avgCadence + ' rpm' : '—'} sub={data.summary.avgCadence ? '按时长加权' : `${rangeLabel}无踏频数据`} />
        <StatCard label="年度累计" value={km(data.ytdDistance ?? 0)} sub="全范围固定指标" />
      </div>

      <div className="card">
        <h3>训练负荷（{range === 'week' ? '近 28 天' : `近 ${RANGE_LOAD_DAYS_LABEL[range]}`}）</h3>
        <Chart option={loadOption} height={280} />
        <div className="hint">
          CTL＝42 天指数加权日 TSS，代表长期有氧基础；ATL＝7 天，代表近期疲劳；TSB＝CTL−ATL，低于 −30 提示疲劳过度，高于 +10 表示状态峰值。
          {range === 'week' && ' 本周范围较短，负荷图固定显示 28 天。'}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>近期骑行</h3>
          <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>名称</th>
                  <th>距离</th>
                  <th>均速</th>
                  <th>心率</th>
                  <th>踏频</th>
                  <th>TSS</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((a) => (
                  <tr key={a.id} onClick={() => onOpenDetail(a.id)}>
                    <td style={{ color: 'var(--muted)' }}>{datetime(a.startDate).slice(5, 10)}</td>
                    <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {a.name} <span className="chip">{TYPE_LABELS[a.type] ?? a.type}</span>
                    </td>
                    <td>{km(a.distance)}</td>
                    <td>{kmh(a.averageSpeed)}</td>
                    <td style={{ color: 'var(--muted)' }}>{a.averageHeartrate ? Math.round(a.averageHeartrate) : '—'}</td>
                    <td style={{ color: 'var(--muted)' }}>{a.averageCadence ? Math.round(a.averageCadence) : '—'}</td>
                    <td style={{ color: 'var(--muted)' }}>{a.tss != null ? Math.round(a.tss) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        </div>
        <div>
          <div className="card">
            <h3>
              强度分布（近 {rangeLabel} · {data.zoneKind === 'power' ? '功率区间' : '心率区间'}
              {data.zoneEstimated ? ' · 含估算' : ''}）
            </h3>
            {zoneTotalSec > 0 ? (
              <>
                <Chart option={zoneOption} height={200} />
                <div className="hint">
                  {data.zoneEstimated
                    ? '部分骑行缺少逐秒数据，按平均心率估算区间时间；同步详细数据后会更精确。'
                    : '极化模型：约 80% 低强度 + 20% 高强度。'}
                </div>
              </>
            ) : (
              <div className="hint" style={{ padding: '30px 0', textAlign: 'center' }}>
                所选范围内没有可统计的心率/功率数据。同步详细数据或骑行时佩戴心率设备后，这里会展示各强度区间的时长分布。
              </div>
            )}
          </div>
          {data.zoneKind === 'power' && data.hrZoneDistribution && hrZoneOption && (
            <div className="card">
              <h3>心率区间分布（{rangeLabel}）</h3>
              <Chart option={hrZoneOption} height={200} />
              <div className="hint">按乳酸阈心率分 5 档，与功率区间互为补充：有氧刺激主要看 Z1-Z2（蓝+绿）的量，Z4+（红+紫）是阈值以上刺激。</div>
            </div>
          )}
          <div className="stat-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
            {data.bestPower.map((p) => (
              <StatCard
                key={p.window}
                label={p.window === 60 ? '最佳 1min 功率' : p.window === 300 ? '最佳 5min 功率' : '最佳 20min 功率'}
                value={p.watts + ' W'}
                sub={data.weightKg ? `${(p.watts / data.weightKg).toFixed(2)} W/kg` : undefined}
                accent={p.window === 1200}
              />
            ))}
          </div>
          {data.bestPower.length === 0 && (
            <div className="card">
              <div className="hint" style={{ textAlign: 'center', padding: '12px 0' }}>
                暂无功率数据（需要功率计/骑行台 + 详细数据同步）。
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
