import { useEffect, useState } from 'react'
import type { TrendsData } from '@shared/types'
import { Chart } from '../components/Chart'
import { StatCard } from '../components/StatCard'
import { km, duration } from '../lib/format'
import type { EChartsOption } from 'echarts'

export function Trends({ version }: { version: number }) {
  const [data, setData] = useState<TrendsData | null>(null)

  useEffect(() => {
    window.api.getTrends().then(setData)
  }, [version])

  if (!data) return <div className="empty-state">加载中…</div>
  if (data.weekly.length === 0) return <div className="empty-state">暂无数据</div>

  const weeklyOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['周距离', '周 TSS'], textStyle: { color: '#9aa4b0' }, top: 0 },
    grid: { left: 56, right: 56, top: 36, bottom: 32 },
    xAxis: { type: 'category', data: data.weekly.map((w) => w.weekStart.slice(5)), axisLabel: { color: '#9aa4b0' } },
    yAxis: [
      { type: 'value', name: 'km', axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
      { type: 'value', name: 'TSS', axisLabel: { color: '#9aa4b0' }, splitLine: { show: false } }
    ],
    series: [
      {
        name: '周距离',
        type: 'bar',
        data: data.weekly.map((w) => Math.round(w.distance / 100) / 10),
        itemStyle: { color: '#fc4c02', borderRadius: [4, 4, 0, 0] }
      },
      {
        name: '周 TSS',
        type: 'line',
        yAxisIndex: 1,
        data: data.weekly.map((w) => Math.round(w.tss)),
        smooth: true,
        lineStyle: { color: '#4d9fff', width: 2 },
        itemStyle: { color: '#4d9fff' }
      }
    ]
  }

  const monthlyOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: 56, right: 24, top: 24, bottom: 32 },
    xAxis: { type: 'category', data: data.monthly.map((m) => m.month), axisLabel: { color: '#9aa4b0' } },
    yAxis: { type: 'value', name: 'km', axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
    series: [
      {
        type: 'bar',
        data: data.monthly.map((m) => Math.round(m.distance / 100) / 10),
        itemStyle: { color: '#4caf7d', borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: '#9aa4b0', formatter: (p: any) => `${p.value}` }
      }
    ]
  }

  const speedOption: EChartsOption = {
    tooltip: {
      trigger: 'axis',
      formatter: (p: any) => `${p[0].axisValue}<br/>${p[0].data?.activity || ''}<br/>均速 ${p[0].data?.value ?? p[0].value} km/h`
    },
    grid: { left: 56, right: 24, top: 24, bottom: 32 },
    xAxis: { type: 'category', data: data.speedTrend.map((s) => s.date.slice(5)), axisLabel: { color: '#9aa4b0' } },
    yAxis: { type: 'value', name: 'km/h', axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
    series: [
      {
        type: 'line',
        data: data.speedTrend.map((s) => ({ value: s.avgSpeed, activity: s.activity })),
        symbolSize: 5,
        lineStyle: { color: '#f0b429', width: 1.5 },
        itemStyle: { color: '#f0b429' },
        connectNulls: true
      }
    ]
  }

  // ---------- 训练负荷与疲劳状态（近 12 周） ----------
  const training = data.training.weeks
  const loadTsbOption: EChartsOption = {
    tooltip: {
      trigger: 'axis',
      formatter: (ps: any) =>
        `${ps[0].axisValue} 周<br/>周 TSS ${ps[0].value}<br/>周末 TSB ${ps[1]?.value ?? '—'}（体能 CTL ${training[ps[0].dataIndex]?.ctl ?? '—'}）`
    },
    legend: { data: ['周 TSS', '周末 TSB'], textStyle: { color: '#9aa4b0' }, top: 0 },
    grid: { left: 56, right: 56, top: 36, bottom: 32 },
    xAxis: { type: 'category', data: training.map((w) => w.weekStart.slice(5)), axisLabel: { color: '#9aa4b0' } },
    yAxis: [
      { type: 'value', name: 'TSS', axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
      { type: 'value', name: 'TSB', min: -80, max: 40, axisLabel: { color: '#9aa4b0' }, splitLine: { show: false } }
    ],
    series: [
      {
        name: '周 TSS',
        type: 'bar',
        data: training.map((w) => w.tss),
        itemStyle: { color: '#4d9fff', borderRadius: [4, 4, 0, 0], opacity: 0.85 },
        barMaxWidth: 26
      },
      {
        name: '周末 TSB',
        type: 'line',
        yAxisIndex: 1,
        data: training.map((w) => w.tsb),
        smooth: true,
        lineStyle: { color: '#f0b429', width: 2.5 },
        itemStyle: { color: '#f0b429' },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [
            { yAxis: 0, lineStyle: { color: '#5b6673', type: 'dashed' }, label: { formatter: '平衡', color: '#9aa4b0' } },
            {
              yAxis: -30,
              lineStyle: { color: '#e5484d', type: 'dashed' },
              label: { formatter: '过度训练风险 -30', color: '#e5484d' }
            }
          ]
        },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(240,180,41,0.18)' },
              { offset: 1, color: 'rgba(240,180,41,0)' }
            ]
          }
        }
      }
    ]
  }

  // ---------- 有氧积累与强度结构（近 12 周） ----------
  const zoneStackOption: EChartsOption = {
    tooltip: {
      trigger: 'axis',
      formatter: (ps: any) => {
        const total = ps.reduce((s: number, p: any) => s + (p.value || 0), 0)
        const lines = ps
          .filter((p: any) => p.value > 0)
          .map((p: any) => `${p.marker}${p.seriesName} ${p.value}h（${Math.round((p.value / total) * 100)}%）`)
        return `${ps[0].axisValue} 周 · 共 ${total.toFixed(1)}h<br/>${lines.join('<br/>')}`
      }
    },
    legend: { data: ['低强度 Z1-Z2', '中等 Z3', '高强度 Z4+'], textStyle: { color: '#9aa4b0' }, top: 0 },
    grid: { left: 56, right: 24, top: 36, bottom: 32 },
    xAxis: { type: 'category', data: training.map((w) => w.weekStart.slice(5)), axisLabel: { color: '#9aa4b0' } },
    yAxis: { type: 'value', name: 'h', axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
    series: [
      {
        name: '低强度 Z1-Z2',
        type: 'bar',
        stack: 'zone',
        data: training.map((w) => w.easyH),
        itemStyle: { color: '#4caf7d' },
        barMaxWidth: 26
      },
      {
        name: '中等 Z3',
        type: 'bar',
        stack: 'zone',
        data: training.map((w) => w.modH),
        itemStyle: { color: '#4d9fff' }
      },
      {
        name: '高强度 Z4+',
        type: 'bar',
        stack: 'zone',
        data: training.map((w) => w.hardH),
        itemStyle: { color: '#e5484d', borderRadius: [4, 4, 0, 0] }
      }
    ]
  }

  // ---------- 心率效率趋势：每月同条件骑（户外 45-150min）平均心率中位数 ----------
  const hrTrendOption: EChartsOption = {
    tooltip: {
      trigger: 'axis',
      formatter: (ps: any) => {
        const h = data.hrTrend[ps[0].dataIndex]
        return `${ps[0].axisValue}<br/>平均心率中位 ${ps[0].value} bpm（${h?.n ?? 0} 次同条件骑）`
      }
    },
    grid: { left: 56, right: 24, top: 24, bottom: 32 },
    xAxis: { type: 'category', data: data.hrTrend.map((h) => h.month), axisLabel: { color: '#9aa4b0' } },
    yAxis: { type: 'value', name: 'bpm', scale: true, axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
    series: [
      {
        type: 'line',
        data: data.hrTrend.map((h) => h.hr),
        smooth: true,
        symbolSize: 6,
        lineStyle: { color: '#e5484d', width: 2 },
        itemStyle: { color: '#e5484d' }
      }
    ]
  }

  const cadenceTrendOption: EChartsOption = {
    tooltip: {
      trigger: 'axis',
      formatter: (ps: any) => {
        const c = data.cadenceTrend[ps[0].dataIndex]
        return `${ps[0].axisValue}<br/>平均踏频 ${ps[0].value} rpm（${c?.n ?? 0} 次骑行）`
      }
    },
    grid: { left: 56, right: 24, top: 24, bottom: 32 },
    xAxis: { type: 'category', data: data.cadenceTrend.map((c) => c.month), axisLabel: { color: '#9aa4b0' } },
    yAxis: { type: 'value', name: 'rpm', scale: true, min: (e: { min: number; max: number }) => Math.max(0, Math.floor(e.min - 5)), axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
    series: [
      {
        type: 'line',
        data: data.cadenceTrend.map((c) => c.cadence),
        smooth: true,
        symbolSize: 6,
        lineStyle: { color: '#4d9fff', width: 2 },
        itemStyle: { color: '#4d9fff' }
      }
    ]
  }

  const totalDistance = data.monthly.reduce((s, m) => s + m.distance, 0)
  const totalTime = data.monthly.reduce((s, m) => s + m.time, 0)
  const totalElevation = data.monthly.reduce((s, m) => s + m.elevation, 0)
  const totalCount = data.monthly.reduce((s, m) => s + m.count, 0)
  const totalTss = data.monthly.reduce((s, m) => s + m.tss, 0)

  return (
    <>
      <h1 className="page-title">趋势</h1>
      <p className="page-sub">全部历史数据汇总</p>

      <div className="stat-grid">
        <StatCard label="累计距离" value={km(totalDistance)} sub={`${totalCount} 次骑行`} accent />
        <StatCard label="累计时长" value={duration(totalTime)} />
        <StatCard label="累计爬升" value={Math.round(totalElevation).toLocaleString() + ' m'} />
        <StatCard label="累计 TSS" value={Math.round(totalTss)} />
      </div>

      <div className="card">
        <h3>周训练量（距离 / TSS）</h3>
        <Chart option={weeklyOption} height={300} />
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>月度距离</h3>
          <Chart option={monthlyOption} height={260} />
        </div>
        <div className="card">
          <h3>平均速度趋势（近 60 次）</h3>
          <Chart option={speedOption} height={260} />
        </div>
      </div>

      {(data.hrTrend.length >= 2 || data.cadenceTrend.length >= 2) && (
        <div className="grid-2">
          {data.hrTrend.length >= 2 && (
            <div className="card">
              <h3>心率效率趋势（同条件骑 · 月度）</h3>
              <Chart option={hrTrendOption} height={260} />
              <p className="hint">
                取每月户外 45-150 分钟骑行的平均心率中位数。同样的骑法心率逐月下降 = 有氧效率在进步；上升则提示疲劳或退步。
              </p>
            </div>
          )}
          {data.cadenceTrend.length >= 2 && (
            <div className="card">
              <h3>踏频趋势（月度 · 按时长加权）</h3>
              <Chart option={cadenceTrendOption} height={260} />
              <p className="hint">90+ rpm 为高效区间；长期低于 75 rpm 说明依赖大齿比踩踏，肌肉负担更重。</p>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3>训练洞察</h3>
        <ul className="insight-list">
          {data.training.insights.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>训练负荷与疲劳状态（近 12 周）</h3>
        <Chart option={loadTsbOption} height={280} />
        <p className="hint">
          TSS 为每周训练负荷；TSB = 体能 − 疲劳：-10 ~ -30 是训练「甜区」，低于 -30 连续多周需主动减量，高于 0 适合测试或比赛。
        </p>
      </div>

      <div className="card">
        <h3>有氧积累与强度结构（近 12 周）{training.some((w) => w.estimated) ? ' · 部分含估算' : ''}</h3>
        <Chart option={zoneStackOption} height={280} />
        <p className="hint">极化模型：约 80% 低强度（绿）+ 少量高强度（红）训练效益最高；长时间泡在中强度（蓝）恢复慢、收益浅。</p>
      </div>
    </>
  )
}
