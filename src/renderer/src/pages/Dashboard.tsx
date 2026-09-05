import { useEffect, useState } from 'react'
import type { DashboardData } from '@shared/types'
import { Chart } from '../components/Chart'
import { StatCard } from '../components/StatCard'
import { km, duration, kmh, datetime, TYPE_LABELS } from '../lib/format'
import type { EChartsOption } from 'echarts'

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
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')

  const reload = () => window.api.getDashboard().then(setData)

  useEffect(() => {
    reload()
  }, [version])

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

  const zoneOption: EChartsOption = {
    tooltip: { formatter: (p: any) => `${p.name}: ${(p.value / 3600).toFixed(1)} 小时` },
    grid: { left: 80, right: 24, top: 8, bottom: 24 },
    xAxis: { type: 'value', axisLabel: { color: '#9aa4b0', formatter: (v: number) => `${Math.round(v / 3600)}h` }, splitLine: { lineStyle: { color: '#222932' } } },
    yAxis: { type: 'category', data: data.zoneDistribution.map((z) => z.label).reverse(), axisLabel: { color: '#9aa4b0' } },
    series: [
      {
        type: 'bar',
        data: data.zoneDistribution.map((z) => z.seconds).reverse(),
        barWidth: 16,
        itemStyle: { color: '#fc4c02', borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', color: '#9aa4b0', formatter: (p: any) => `${(p.value / 3600).toFixed(1)}h` }
      }
    ]
  }

  const tsb = data.load[data.load.length - 1]
  const zoneTotalSec = data.zoneDistribution.reduce((s, z) => s + z.seconds, 0)

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
        <StatCard label="本周距离" value={km(data.summary.weekDistance)} sub={`${data.summary.weekCount} 次骑行`} accent />
        <StatCard label="本周时长" value={duration(data.summary.weekTime)} />
        <StatCard label="本周爬升" value={Math.round(data.summary.weekElevation) + ' m'} />
        <StatCard label="7 日均速" value={kmh(data.summary.avgSpeed7d)} />
        <StatCard label="7 日平均心率" value={data.summary.avgHr7d ? Math.round(data.summary.avgHr7d) + ' bpm' : '—'} sub={data.summary.avgHr7d ? '按时长加权' : '近 7 天无心率数据'} />
        <StatCard label="7 日平均踏频" value={data.summary.avgCadence7d ? data.summary.avgCadence7d + ' rpm' : '—'} sub={data.summary.avgCadence7d ? '按时长加权' : '近 7 天无踏频数据'} />
        <StatCard label="月度距离" value={km(data.summary.monthDistance)} />
        <StatCard label="年度累计" value={km(data.summary.ytdDistance)} />
      </div>

      <div className="card">
        <h3>训练负荷（近 90 天）</h3>
        <Chart option={loadOption} height={280} />
        <div className="hint">
          CTL＝42 天指数加权日 TSS，代表长期有氧基础；ATL＝7 天，代表近期疲劳；TSB＝CTL−ATL，低于 −30 提示疲劳过度，高于 +10 表示状态峰值。
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
              强度分布（近 4 周 · {data.zoneKind === 'power' ? '功率区间' : '心率区间'}
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
                近 4 周没有可统计的心率/功率数据。同步详细数据或骑行时佩戴心率设备后，这里会展示各强度区间的时长分布。
              </div>
            )}
          </div>
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
