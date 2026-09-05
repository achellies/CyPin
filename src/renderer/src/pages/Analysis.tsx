import { useEffect, useState } from 'react'
import type { AbilityData } from '@shared/types'
import { Chart } from '../components/Chart'
import { StatCard } from '../components/StatCard'
import type { EChartsOption } from 'echarts'

const fmtW = (v: number | null | undefined) => (v ? `${v} W` : '—')

export function Analysis({ version, onOpenDetail }: { version: number; onOpenDetail?: (id: string) => void }) {
  const [data, setData] = useState<AbilityData | null>(null)

  useEffect(() => {
    window.api.getAbility().then(setData)
  }, [version])

  if (!data) return <div className="empty-state">加载中…</div>
  if (!data.profile.ftp || data.profile.basedOn === 0)
    return (
      <div className="empty-state">
        <div className="big">◈</div>
        能力分析需要功率计数据和 FTP 设置。请先同步带功率的骑行，并在设置中配置 FTP。
      </div>
    )

  const { profile, pd, prTimeline, climbs, aerobicTrend, calendar, streak, prescription } = data
  const hasPrev = pd.previous.some((v) => v != null)

  // ---------- 1. 骑手画像雷达 ----------
  const radarOption: EChartsOption = {
    radar: {
      indicator: [
        { name: '冲刺 5s', max: 130 },
        { name: '无氧 1min', max: 130 },
        { name: 'VO2 5min', max: 130 },
        { name: '阈值 20min', max: 130 }
      ],
      radius: '68%',
      axisName: { color: '#9aa4b0', fontSize: 12 },
      splitNumber: 4,
      splitArea: { show: false },
      splitLine: { lineStyle: { color: '#222932' } },
      axisLine: { lineStyle: { color: '#262e39' } }
    },
    series: [
      {
        type: 'radar',
        data: [
          {
            value: [profile.radar.sprint, profile.radar.anaerobic, profile.radar.vo2, profile.radar.threshold],
            name: '相对业余典型水平'
          }
        ],
        areaStyle: { color: 'rgba(252,76,2,0.22)' },
        lineStyle: { color: '#fc4c02', width: 2 },
        itemStyle: { color: '#fc4c02' },
        symbolSize: 4
      }
    ]
  }

  const bestItems = [
    { k: '5s 冲刺', v: profile.best.s5, r: profile.ratios.sprint },
    { k: '1 分钟', v: profile.best.m1, r: profile.ratios.anaerobic },
    { k: '5 分钟', v: profile.best.m5, r: profile.ratios.vo2 },
    { k: '20 分钟', v: profile.best.m20, r: profile.ratios.threshold },
    { k: '60 分钟', v: profile.best.m60, r: profile.best.m60 ? profile.best.m60 / profile.ftp! : null }
  ]

  // ---------- 2. 功率-时间曲线 ----------
  const PD_LABEL: Record<number, string> = {
    5: '5s', 15: '15s', 30: '30s', 60: '1min', 120: '2min',
    300: '5min', 600: '10min', 1200: '20min', 1800: '30min', 3600: '60min'
  }
  const pdSecs = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600]
  const pdOption: EChartsOption = {
    tooltip: {
      trigger: 'axis',
      formatter: (ps: any) => `${PD_LABEL[ps[0].value[0]] ?? ps[0].value[0]}<br/>` + ps.map((p: any) => `${p.marker}${p.seriesName} ${p.value[1] ?? '—'} W`).join('<br/>')
    },
    legend: { data: ['近 90 天', '90-180 天', 'CP 模型'], textStyle: { color: '#9aa4b0' }, top: 0 },
    grid: { left: 56, right: 24, top: 36, bottom: 40 },
    xAxis: {
      type: 'log',
      min: 4,
      max: 4200,
      axisLabel: { color: '#9aa4b0', formatter: (v: number) => PD_LABEL[v] ?? '' },
      splitLine: { show: false }
    },
    yAxis: { type: 'value', name: 'W', axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
    series: [
      {
        name: '近 90 天',
        type: 'line',
        data: pdSecs.map((s, i) => [s, pd.current[i]]),
        lineStyle: { color: '#fc4c02', width: 2.5 },
        itemStyle: { color: '#fc4c02' },
        symbolSize: 5,
        connectNulls: true,
        ...(pd.cp
          ? {
              markLine: {
                silent: true,
                symbol: 'none',
                data: [{ yAxis: pd.cp, lineStyle: { color: '#4caf7d', type: 'dashed' }, label: { formatter: `CP ${pd.cp}W`, color: '#4caf7d' } }]
              }
            }
          : {})
      },
      {
        name: '90-180 天',
        type: 'line',
        data: pdSecs.map((s, i) => [s, pd.previous[i]]),
        lineStyle: { color: '#5b6673', width: 1.5, type: 'dashed' },
        itemStyle: { color: '#5b6673' },
        symbolSize: 4,
        connectNulls: true
      },
      ...(pd.predicted.length
        ? [
            {
              name: 'CP 模型',
              type: 'line' as const,
              data: pdSecs.map((s, i) => [s, pd.predicted[i]]),
              lineStyle: { color: '#f0b429', width: 1, type: 'dotted' as const },
              itemStyle: { color: '#f0b429' },
              symbol: 'none',
              connectNulls: true
            }
          ]
        : [])
    ]
  }

  // ---------- 3. PR 演进 ----------
  const PR_COLORS = ['#e5484d', '#f0b429', '#4d9fff', '#4caf7d']
  const prOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: prTimeline.map((p) => p.label), textStyle: { color: '#9aa4b0' }, top: 0 },
    grid: { left: 56, right: 24, top: 36, bottom: 40 },
    xAxis: { type: 'time', axisLabel: { color: '#9aa4b0' } },
    yAxis: { type: 'value', name: 'W', scale: true, axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
    series: prTimeline.map((p, i) => ({
      name: p.label,
      type: 'line' as const,
      data: p.events.map((e) => [e.date, e.watts]),
      step: 'end' as const,
      showSymbol: true,
      symbolSize: 5,
      lineStyle: { color: PR_COLORS[i % PR_COLORS.length], width: 2 },
      itemStyle: { color: PR_COLORS[i % PR_COLORS.length] }
    }))
  }

  // ---------- 4. 有氧效率趋势 ----------
  const aerobicOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['心率解耦 %', 'EF (功率/心率)'], textStyle: { color: '#9aa4b0' }, top: 0 },
    grid: { left: 56, right: 56, top: 36, bottom: 40 },
    xAxis: { type: 'category', data: aerobicTrend.map((a) => a.date.slice(5)), axisLabel: { color: '#9aa4b0' } },
    yAxis: [
      { type: 'value', name: '解耦 %', scale: true, axisLabel: { color: '#9aa4b0', formatter: (v: number) => v + '%' }, splitLine: { lineStyle: { color: '#222932' } } },
      { type: 'value', name: 'EF', scale: true, axisLabel: { color: '#9aa4b0' }, splitLine: { show: false } }
    ],
    series: [
      {
        name: '心率解耦 %',
        type: 'line',
        data: aerobicTrend.map((a) => a.decoupling),
        connectNulls: true,
        symbolSize: 4,
        lineStyle: { color: '#4caf7d', width: 2 },
        itemStyle: { color: '#4caf7d' },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: 5, lineStyle: { color: '#5b6673', type: 'dashed' }, label: { formatter: '有氧基准 5%', color: '#9aa4b0' } }]
        }
      },
      {
        name: 'EF (功率/心率)',
        type: 'line',
        yAxisIndex: 1,
        data: aerobicTrend.map((a) => a.ef),
        connectNulls: true,
        symbolSize: 4,
        lineStyle: { color: '#4d9fff', width: 2 },
        itemStyle: { color: '#4d9fff' }
      }
    ]
  }

  // ---------- 5. 全年训练日历热力图 ----------
  const maxTss = Math.max(...calendar.map((c) => c.tss), 100)
  const calendarOption: EChartsOption = {
    tooltip: {
      formatter: (p: any) => {
        const c = calendar[p.dataIndex]
        return `${c.date}<br/>TSS ${c.tss} · ${(c.km / 1000).toFixed(1)} km`
      }
    },
    visualMap: {
      min: 0,
      max: maxTss,
      type: 'continuous',
      orient: 'horizontal',
      left: 'center',
      bottom: 4,
      itemWidth: 10,
      itemHeight: 80,
      text: ['高', '低'],
      textStyle: { color: '#9aa4b0', fontSize: 11 },
      inRange: { color: ['#1d242e', '#2d5aa8', '#fc4c02'] }
    },
    calendar: {
      range: [calendar[0].date, calendar[calendar.length - 1].date],
      cellSize: ['auto', 15],
      left: 40,
      right: 16,
      top: 30,
      itemStyle: { color: '#1d242e', borderColor: '#0f1216', borderWidth: 2, borderRadius: 3 },
      splitLine: { show: false },
      monthLabel: { color: '#9aa4b0', fontSize: 11 },
      dayLabel: { color: '#5b6673', fontSize: 10, firstDay: 1, nameMap: ['日', '一', '二', '三', '四', '五', '六'] },
      yearLabel: { show: false }
    },
    series: [
      {
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data: calendar.map((c) => [c.date, c.tss])
      }
    ]
  }

  // ---------- 6. 踏频-功率关系 ----------
  const cadenceOption: EChartsOption | null =
    data.cadence && data.cadence.scatter.length > 0
      ? {
          tooltip: { formatter: (p: any) => `${p.value[0]} rpm · ${p.value[1]} W` },
          grid: { left: 56, right: 24, top: 20, bottom: 40 },
          xAxis: { type: 'value', name: 'rpm', min: 40, axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
          yAxis: { type: 'value', name: 'W', scale: true, axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
          series: [
            {
              type: 'scatter',
              data: data.cadence.scatter,
              symbolSize: 4,
              itemStyle: { color: 'rgba(252,76,2,0.4)' }
            }
          ]
        }
      : null

  return (
    <>
      <h1 className="page-title">能力分析</h1>
      <p className="page-sub">
        基于最近 {profile.basedOn} 次带功率的骑行 · FTP {profile.ftp} W
      </p>

      <div className="stat-grid">
        <StatCard label="20min 最佳" value={fmtW(profile.best.m20)} sub={`${profile.ratios.threshold.toFixed(2)}× FTP`} accent />
        <StatCard label="5min 最佳" value={fmtW(profile.best.m5)} sub={`${profile.ratios.vo2.toFixed(2)}× FTP`} />
        <StatCard label="1min 最佳" value={fmtW(profile.best.m1)} sub={`${profile.ratios.anaerobic.toFixed(2)}× FTP`} />
        <StatCard label="5s 最佳" value={fmtW(profile.best.s5)} sub={`${profile.ratios.sprint.toFixed(2)}× FTP`} />
        <StatCard label="临界功率 CP" value={fmtW(pd.cp)} sub={pd.wPrimeJ ? `W′ ${Math.round(pd.wPrimeJ)} J` : undefined} />
      </div>

      <div className="card">
        <h3>骑手画像</h3>
        <div className="profile-grid">
          <Chart option={radarOption} height={260} />
          <div>
            <div className="type-badge">{profile.type}</div>
            <p className="profile-desc">{profile.typeDesc}</p>
            {profile.strengths.length > 0 && (
              <ul className="insight-list good">
                {profile.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
            {profile.weaknesses.length > 0 && (
              <ul className="insight-list weak">
                {profile.weaknesses.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
            {profile.strengths.length === 0 && profile.weaknesses.length === 0 && (
              <p className="hint">各能力维度均衡，无特别突出或短板。</p>
            )}
            <div className="best-grid">
              {bestItems.map((b) => (
                <div className="best-item" key={b.k}>
                  <div className="k">{b.k}</div>
                  <div className="v">{b.v ?? '—'}</div>
                  <div className="r">{b.r ? `${b.r.toFixed(2)}× FTP` : ''}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <p className="hint">雷达图以业余认真训练骑手的典型功率比例（5s≈2.3×FTP、1min≈1.45×、5min≈1.2×、20min=1.0×FTP）为 100 基准。</p>
      </div>

      <div className="card">
        <h3>功率-时间曲线（近 90 天 vs 之前 90 天）</h3>
        <Chart option={pdOption} height={300} />
        <p className="hint">
          {pd.cp && pd.wPrimeJ
            ? `CP 模型：临界功率 ${pd.cp} W，无氧储备 W′ ${Math.round(pd.wPrimeJ)} J（约 ${Math.round(pd.wPrimeJ / pd.cp * 10) / 10}s 全力输出）。曲线高于模型说明短时能力相对突出。`
            : '数据积累到足够骑行后，这里会给出 CP / W′ 模型拟合。'}
          {hasPrev && ' 虚线为上一个 90 天，可对比近期进步。'}
        </p>
      </div>

      {prTimeline.some((p) => p.events.length > 0) && (
        <div className="card">
          <h3>个人纪录演进（每次刷新 PR 记录一点）</h3>
          <Chart option={prOption} height={280} />
          <p className="hint">台阶上升表示刷新了对应时间窗口的功率纪录；越近期跳升越密集，说明状态在进步。</p>
        </div>
      )}

      {aerobicTrend.length > 0 && (
        <div className="card">
          <h3>有氧效率趋势（稳态骑）</h3>
          <Chart option={aerobicOption} height={280} />
          <p className="hint">
            解耦 = 后半段心率漂移幅度：&lt;5% 说明有氧底子扎实，长期下降即进步。EF = NP/平均心率，趋势上升说明同样心率能输出更大功率。
          </p>
        </div>
      )}

      {cadenceOption && data.cadence && (
        <div className="card">
          <h3>
            踏频-功率关系 · 全程中位 {data.cadence.medianCadence ?? '—'} rpm · 大功率（≥75% FTP）中位 {data.cadence.highPowerCadence ?? '—'} rpm
          </h3>
          <Chart option={cadenceOption} height={280} />
          <p className="hint">
            每个点是从功率计骑行中抽样的一秒踩踏。点云向右上倾斜、踏频稳定在 85-95 属高效；大功率踏频明显低于全程中位，说明发力依赖大齿比，可用低踏频练习改善。
          </p>
        </div>
      )}

      <div className="card">
        <h3>全年训练日历</h3>
        <div className="stat-grid" style={{ marginBottom: 8 }}>
          <StatCard label="当前连续骑行" value={`${streak.current} 天`} sub="按自然日" />
          <StatCard label="最长连续" value={`${streak.longest} 天`} />
          <StatCard label="本月骑行天数" value={`${streak.daysThisMonth} 天`} />
        </div>
        <Chart option={calendarOption} height={200} />
      </div>

      {climbs.length > 0 && (
        <div className="card">
          <h3>爬坡段检测（Top {climbs.length}）</h3>
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>骑行</th>
                <th>长度</th>
                <th>爬升</th>
                <th>平均坡度</th>
                <th>最大坡度</th>
                <th>VAM</th>
                <th>均功</th>
              </tr>
            </thead>
            <tbody>
              {climbs.map((c, i) => (
                <tr key={i} onClick={() => onOpenDetail?.(c.activityId)}>
                  <td>{c.date}</td>
                  <td>{c.activityName}</td>
                  <td>{(c.distanceM / 1000).toFixed(2)} km</td>
                  <td>{c.gainM} m</td>
                  <td>{c.avgGradient}%</td>
                  <td>{c.maxGradient}%</td>
                  <td>{c.vam} m/h</td>
                  <td>{fmtW(c.avgWatts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">自动识别 ≥2.8% 坡度、≥400m、爬升 ≥20m 的爬坡段，按难度（爬升×坡度）排序。VAM 为每小时爬升速度，点击行查看活动详情。</p>
        </div>
      )}

      <div className="card">
        <h3>下周训练处方</h3>
        <div className="rx-head">
          <span className={`rx-badge ${prescription.mode}`}>{prescription.modeLabel}</span>
          <span className="rx-range">
            建议 {prescription.nextWeekTssMin}~{prescription.nextWeekTssMax} TSS
          </span>
        </div>
        <div className="stat-grid" style={{ marginBottom: 12 }}>
          <StatCard label="本周 TSS" value={Math.round(prescription.thisWeekTss)} />
          <StatCard label="4 周周均 TSS" value={prescription.avg4WeekTss} />
          <StatCard
            label="增幅"
            value={`${prescription.rampRatePct >= 0 ? '+' : ''}${prescription.rampRatePct}%`}
            sub={prescription.rampRatePct > 30 ? '超出安全范围' : '安全范围内'}
          />
        </div>
        <ul className="insight-list">
          {prescription.messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
        <p className="hint">处方基于当前 TSB（疲劳/freshness）、4 周负荷均值与增幅速率自动生成，用于防止过度训练。</p>
      </div>
    </>
  )
}
