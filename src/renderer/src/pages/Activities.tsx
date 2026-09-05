import { useEffect, useMemo, useState } from 'react'
import type { ActivityRow } from '@shared/api'
import { km, duration, kmh, datetime, TYPE_LABELS } from '../lib/format'

const METHOD_LABEL: Record<string, string> = {
  power: '功率',
  hr: '心率',
  'hr-approx': '心率≈',
  estimate: '估算'
}

export function Activities({ version, onOpenDetail }: { version: number; onOpenDetail: (id: string) => void }) {
  const [rows, setRows] = useState<ActivityRow[]>([])
  const [type, setType] = useState('all')
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    window.api.listActivities({ type, search, from: from || undefined, to: to || undefined }).then(setRows)
  }, [version, type, search, from, to])

  const totals = useMemo(
    () => ({
      distance: rows.reduce((s, r) => s + r.distance, 0),
      time: rows.reduce((s, r) => s + r.movingTime, 0),
      elevation: rows.reduce((s, r) => s + r.totalElevationGain, 0),
      tss: rows.reduce((s, r) => s + (r.tss ?? 0), 0)
    }),
    [rows]
  )

  return (
    <>
      <h1 className="page-title">活动</h1>
      <p className="page-sub">
        共 {rows.length} 次 · 合计 {km(totals.distance)} · {duration(totals.time)} · 爬升 {Math.round(totals.elevation)}m · TSS {Math.round(totals.tss)}
      </p>

      <div className="card">
        <div className="row">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">全部类型</option>
            {Object.entries(TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <input placeholder="搜索名称…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 200 }} />
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span style={{ color: 'var(--muted)' }}>至</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>名称</th>
              <th>类型</th>
              <th>距离</th>
              <th>时间</th>
              <th>均速</th>
              <th>爬升</th>
              <th>心率</th>
              <th>踏频</th>
              <th>NP</th>
              <th>TSS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} onClick={() => onOpenDetail(a.id)}>
                <td style={{ color: 'var(--muted)' }}>{datetime(a.startDate)}</td>
                <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</td>
                <td>
                  <span className="chip">{TYPE_LABELS[a.type] ?? a.type}</span>
                </td>
                <td>{km(a.distance)}</td>
                <td>{duration(a.movingTime)}</td>
                <td>{kmh(a.averageSpeed)}</td>
                <td>{Math.round(a.totalElevationGain)}m</td>
                <td>{a.averageHeartrate ? Math.round(a.averageHeartrate) : '—'}</td>
                <td>{a.averageCadence ? Math.round(a.averageCadence) : '—'}</td>
                <td>{a.weightedAverageWatts ? Math.round(a.weightedAverageWatts) + 'W' : '—'}</td>
                <td>
                  <span className="chip tss" title={`来源：${METHOD_LABEL[a.tssMethod ?? ''] ?? '—'}`}>
                    {a.tss != null ? Math.round(a.tss) : '—'}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} style={{ textAlign: 'center', color: 'var(--muted)', padding: 40, cursor: 'default' }}>
                  没有找到活动，请先在「设置」同步 Strava 或导入文件
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
