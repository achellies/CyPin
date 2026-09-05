import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ActivityDetailData, AppSettings } from '@shared/types'
import { Chart } from '../components/Chart'
import { MapView } from '../components/MapView'
import { km, duration, kmh, datetime, mNum, TYPE_LABELS } from '../lib/format'
import type { EChartsOption } from 'echarts'

const TSS_METHOD_LABEL: Record<string, string> = {
  power: '功率',
  hr: '心率区间',
  'hr-approx': '心率估算',
  estimate: '时长估算'
}

const GRADE_LABEL: Record<string, string> = {
  hard: '大负荷',
  solid: '高质量',
  moderate: '中等负荷',
  easy: '轻松骑'
}

/** 专业术语的白话解释（hover 显示） */
const TERM_EXPLAIN: Record<string, string> = {
  均速: '移动时间内的平均速度（不含等红灯、停车）',
  NP: '标准化功率：把变速骑折算成「匀速骑」的等效功率，比平均功率更能反映真实强度',
  '强度 IF': '强度系数 = NP ÷ FTP。0.75 以上才算有质量的训练，0.95+ 接近 1 小时极限',
  平均心率: '骑行全程心率的平均值，同样路线下越低说明有氧能力越好',
  'EF（功率/心率）': '有氧效率 = 功率 ÷ 心率。同样心率能输出更大功率 = 有氧效率提升',
  平均踏频: '每分钟踏板圈数（rpm）。85-95 较高效；长期偏低说明依赖大齿比，肌肉更容易疲劳',
  爬升: '全程累计上升高度',
  途中停留: '总时长减去移动时间，包含等红灯、买水、休息',
  做功: '全程输出能量（kJ），数值上约等于消耗的千卡',
  TSS: '训练负荷分数：1 小时全力骑 ≈ 100 分。用于量化每天练了多少、需要多久恢复',
  '前 7 天 TSS': '本次骑行前 7 天的累计训练负荷，超过 500 属于短期高负荷',
  '心率-功率解耦': '后半程心率相对前半程升高的幅度（%）。越低 = 有氧耐力越稳；大于 8% 说明耐力或补给有短板',
  'NP 功体比': 'NP ÷ 体重（W/kg），衡量爬坡与巡航能力的关键数字',
  心率区间: '按乳酸阈心率百分比分 5 档：Z1<68%、Z2 68-83%、Z3 83-94%、Z4 94-105%、Z5>105%。有氧基础主要靠 Z1-Z2 积累，Z4+ 提升阈值能力'
}

function termExplain(label: string): string | undefined {
  if (!label) return undefined
  if (TERM_EXPLAIN[label]) return TERM_EXPLAIN[label]
  if (label.startsWith('TSS')) return TERM_EXPLAIN['TSS']
  if (label.startsWith('NP（')) return TERM_EXPLAIN['NP']
  if (label.startsWith('NP ')) return TERM_EXPLAIN['NP 功体比']
  if (label.includes('IF')) return TERM_EXPLAIN['强度 IF']
  if (label.includes('EF')) return TERM_EXPLAIN['EF（功率/心率）']
  if (label.includes('解耦') || label.includes('漂移')) return TERM_EXPLAIN['心率-功率解耦']
  return undefined
}

/** 有白话解释的术语：虚线下划线，hover/聚焦弹出白话解释（原生 title 在部分环境下不显示，改用自绘气泡） */
export function Term({ label, children }: { label: string; children?: ReactNode }) {
  const [tip, setTip] = useState<{ x: number; y: number; above: boolean } | null>(null)
  const explain = termExplain(label)
  if (!explain) return <>{children ?? label}</>
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const above = r.top > 130
    setTip({ x: r.left, y: above ? r.top - 8 : r.bottom + 8, above })
  }
  return (
    <span
      className="term-tip"
      tabIndex={0}
      onMouseEnter={(ev) => show(ev.currentTarget)}
      onMouseLeave={() => setTip(null)}
      onFocus={(ev) => show(ev.currentTarget)}
      onBlur={() => setTip(null)}
    >
      {children ?? label}
      {tip &&
        createPortal(
          <div
            className="term-pop"
            style={{
              left: Math.min(tip.x, window.innerWidth - 320),
              top: tip.y,
              transform: tip.above ? 'translateY(-100%)' : undefined
            }}
          >
            <b>{label}</b>
            <span>{explain}</span>
          </div>,
          document.body
        )}
    </span>
  )
}

function scoreColor(v: number): string {
  return v >= 80 ? 'var(--green)' : v >= 60 ? 'var(--yellow)' : 'var(--red)'
}

function timeLabel(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function Detail({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<ActivityDetailData | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [markerIdx, setMarkerIdx] = useState<number | null>(null)

  useEffect(() => {
    window.api.getActivityDetail(id).then(setData)
    window.api.getSettings().then(setSettings)
  }, [id])

  if (!data) return <div className="empty-state">加载中…（首次打开会自动从 Strava 拉取详细数据）</div>

  const { activity: a, streams } = data

  const xData = streams ? streams.time.map((t) => timeLabel(t)) : []

  // 4 个数据网格布局：速度 / 心率 / 功率 / 海拔。
  // 关键：grid/xAxis/yAxis/series 的 index 必须按「过滤后」的顺序统一分配，
  // 否则缺某段流的活动（如骑行台无海拔）会出现 gridIndex 错位 → ECharts 崩溃 → 整页白屏
  const activeSections = [
    { arr: streams?.velocitySmooth, name: '速度', color: '#4d9fff', unit: 'm/s' },
    { arr: streams?.heartrate, name: '心率', color: '#e5484d', unit: 'bpm' },
    { arr: streams?.watts, name: '功率', color: '#fc4c02', unit: 'W' },
    { arr: streams?.altitude, name: '海拔', color: '#4caf7d', unit: 'm' }
  ].filter((d): d is { arr: number[]; name: string; color: string; unit: string } => !!d.arr && d.arr.some((v) => v > 0))

  const hasStreams = !!streams && streams.time.length > 0 && activeSections.length > 0
  const detailOption: EChartsOption | null = hasStreams
    ? ({
        tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
        axisPointer: { link: [{ xAxisIndex: 'all' }] },
        grid: activeSections.map((_, i) => ({ left: 54, right: 54, top: 20 + i * 122, height: 90 })),
        xAxis: activeSections.map((_, i) => ({
          type: 'category' as const,
          data: xData,
          gridIndex: i,
          boundaryGap: false,
          axisLabel: { color: '#9aa4b0', show: i === activeSections.length - 1 },
          axisTick: { show: i === activeSections.length - 1 }
        })),
        yAxis: activeSections.map((d, i) => ({
          type: 'value' as const,
          name: d.unit,
          nameTextStyle: { color: '#9aa4b0' },
          axisLabel: { color: '#9aa4b0' },
          splitLine: { lineStyle: { color: '#222932' } },
          gridIndex: i
        })),
        dataZoom: [
          { type: 'inside', xAxisIndex: activeSections.map((_, i) => i) },
          { type: 'slider', xAxisIndex: activeSections.map((_, i) => i), bottom: 0, height: 22 }
        ],
        series: activeSections.map((d, i) => ({
          name: d.name,
          type: 'line' as const,
          xAxisIndex: i,
          yAxisIndex: i,
          data: d.arr,
          showSymbol: false,
          lineStyle: { width: 1.2, color: d.color },
          sampling: 'lttb' as const
        })),
        legend: { data: activeSections.map((d) => d.name), top: 0, textStyle: { color: '#9aa4b0' } }
      } as unknown as EChartsOption)
    : null

  const curveOption: EChartsOption | null = data.powerCurve
    ? {
        tooltip: { trigger: 'axis', formatter: (p: any) => `${p[0].name}: ${p[0].value} W` },
        grid: { left: 54, right: 20, top: 20, bottom: 32 },
        xAxis: { type: 'category', data: data.powerCurve.windows.map((w) => w.label), axisLabel: { color: '#9aa4b0' } },
        yAxis: { type: 'value', axisLabel: { color: '#9aa4b0' }, splitLine: { lineStyle: { color: '#222932' } } },
        series: [
          {
            type: 'line',
            data: data.powerCurve.values,
            smooth: true,
            lineStyle: { color: '#fc4c02', width: 2.5 },
            itemStyle: { color: '#fc4c02' },
            areaStyle: { color: 'rgba(252,76,2,0.15)' }
          }
        ]
      }
    : null

  // 功率区间 / 心率区间并列展示（有哪种就给哪种）
  const POWER_ZONE_COLORS = ['#5b8def', '#4d9fff', '#4caf7d', '#f0b429', '#e5484d', '#ff6b9d', '#a855f7']
  const HR_ZONE_COLORS = ['#4d9fff', '#4caf7d', '#f0b429', '#e5484d', '#a855f7']
  const zoneBarOption = (zones: { label: string; seconds: number }[], colors: string[]): EChartsOption => ({
    tooltip: { formatter: (p: any) => `${p.name}: ${Math.round(p.value / 60)} min` },
    grid: { left: 80, right: 24, top: 8, bottom: 24 },
    xAxis: { type: 'value', axisLabel: { color: '#9aa4b0', formatter: (v: number) => `${Math.round(v / 60)}m` }, splitLine: { lineStyle: { color: '#222932' } } },
    yAxis: { type: 'category', data: zones.map((z) => z.label).reverse(), axisLabel: { color: '#9aa4b0' } },
    series: [
      {
        type: 'bar',
        data: zones.map((z, i) => ({ value: z.seconds, itemStyle: { color: colors[colors.length - zones.length + i] ?? colors[0], borderRadius: [0, 4, 4, 0] } })).reverse(),
        barWidth: 14
      }
    ]
  })
  const powerZones = data.timeInZones.filter((z) => z.power)
  const hrZones = data.timeInZones.filter((z) => z.hr)
  const powerZoneOption = powerZones.length > 0 ? zoneBarOption(powerZones, POWER_ZONE_COLORS) : null
  const hrZoneOption = hrZones.length > 0 ? zoneBarOption(hrZones, HR_ZONE_COLORS) : null

  return (
    <>
      <button className="back-btn" onClick={onBack}>
        ← 返回活动列表
      </button>
      <div className="page-header">
        <div>
          <h1 className="page-title" style={{ fontSize: 19 }}>
            {a.name}
          </h1>
          <p className="page-sub">
            {datetime(a.startDate)} · {TYPE_LABELS[a.type] ?? a.type}
            {data.decoupling != null && (
              <>
                {' · '}
                <Term label="心率-功率解耦">心率-功率解耦 {data.decoupling}%</Term>
              </>
            )}
          </p>
        </div>
        <button
          className="btn small"
          style={{ color: 'var(--red)' }}
          onClick={async () => {
            if (window.confirm(`确定删除「${a.name}」？\nStrava 活动删除后可重新同步恢复；本地导入文件需重新导入。`)) {
              await window.api.deleteActivity(id)
              onBack()
            }
          }}
        >
          删除该活动
        </button>
      </div>

      <div className="card">
        <div className="detail-stats">
          <div className="item">
            <div className="k">距离</div>
            <div className="v">{km(a.distance)}</div>
          </div>
          <div className="item">
            <div className="k">移动时间</div>
            <div className="v">{duration(a.movingTime)}</div>
          </div>
          <div className="item">
            <div className="k">平均速度</div>
            <div className="v">{kmh(a.averageSpeed)}</div>
          </div>
          <div className="item">
            <div className="k"><Term label="爬升" /></div>
            <div className="v">{mNum(a.totalElevationGain)}</div>
          </div>
          {a.averageHeartrate && (
            <div className="item">
              <div className="k"><Term label="平均心率" /></div>
              <div className="v">{Math.round(a.averageHeartrate)} bpm</div>
            </div>
          )}
          {a.maxHeartrate && (
            <div className="item">
              <div className="k">最大心率</div>
              <div className="v">{Math.round(a.maxHeartrate)} bpm</div>
            </div>
          )}
          {a.weightedAverageWatts && (
            <div className="item">
              <div className="k"><Term label="NP（标准化功率）" /></div>
              <div className="v">{Math.round(a.weightedAverageWatts)} W</div>
            </div>
          )}
          {a.maxWatts && (
            <div className="item">
              <div className="k">最大功率</div>
              <div className="v">{Math.round(a.maxWatts)} W</div>
            </div>
          )}
          {a.averageCadence && (
            <div className="item">
              <div className="k"><Term label="平均踏频" /></div>
              <div className="v">{Math.round(a.averageCadence)}</div>
            </div>
          )}
          {a.calories && (
            <div className="item">
              <div className="k">消耗</div>
              <div className="v">{Math.round(a.calories)} kcal</div>
            </div>
          )}
          {data.tss != null && (
            <div className="item">
              <div className="k"><Term label={`TSS（${TSS_METHOD_LABEL[data.tssMethod ?? ''] ?? data.tssMethod}）`} /></div>
              <div className="v">{data.tss}</div>
            </div>
          )}
          {data.intensityFactor != null && (
            <div className="item">
              <div className="k"><Term label="强度系数 IF" /></div>
              <div className="v">{data.intensityFactor.toFixed(2)}</div>
            </div>
          )}
          {data.np && settings?.weightKg && (
            <div className="item">
              <div className="k"><Term label="NP 功体比" /></div>
              <div className="v">{(data.np / settings.weightKg).toFixed(2)} W/kg</div>
            </div>
          )}
        </div>
      </div>

      {data.review && (
        <div className="card review-card">
          <h3>
            教练点评
            <span className={`review-badge ${data.review.grade}`}>{GRADE_LABEL[data.review.grade]}</span>
          </h3>
          <p className="review-summary">{data.review.summary}</p>
          {data.review.course && data.review.course.type !== 'easy' && (
            <div className="course-block">
              <div className="course-head">
                <span className={`course-badge ${data.review.course.type}`}>{data.review.course.label}</span>
                <span className="course-basis">{data.review.course.basis}</span>
              </div>
              {data.review.course.score != null && (
                <div className="course-score">
                  <div className="score-num" style={{ color: scoreColor(data.review.course.score) }}>
                    {data.review.course.score}
                    <small>执行质量分</small>
                  </div>
                  <div className="score-body">
                    <div className="score-bar">
                      <div
                        className="score-fill"
                        style={{ width: `${data.review.course.score}%`, background: scoreColor(data.review.course.score) }}
                      />
                    </div>
                    {data.review.course.scoreReasons.length > 0 && (
                      <ul className="score-reasons">
                        {data.review.course.scoreReasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {data.review.stats.length > 0 && (
            <div className="review-stats">
              {data.review.stats.map((s) => (
                <div key={s.label} className="review-stat">
                  <div className="k">
                    <Term label={s.label} />
                  </div>
                  <div className="v">{s.value}</div>
                </div>
              ))}
            </div>
          )}
          <div className="review-grid">
            {data.review.highlights.length > 0 && (
              <div className="review-col good">
                <h4>亮点</h4>
                <ul>
                  {data.review.highlights.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              </div>
            )}
            {data.review.concerns.length > 0 && (
              <div className="review-col warn">
                <h4>待改进</h4>
                <ul>
                  {data.review.concerns.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              </div>
            )}
            {data.review.suggestions.length > 0 && (
              <div className="review-col tip">
                <h4>下一步建议</h4>
                <ul>
                  {data.review.suggestions.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <h3>轨迹{markerIdx != null && streams ? ` · ${timeLabel(streams.time[Math.min(markerIdx, streams.time.length - 1)] ?? 0)}` : ''}</h3>
        <MapView streams={streams} mapSummary={a.mapSummary} markerIndex={markerIdx} />
      </div>

      {detailOption && (
        <div className="card">
          <h3>数据曲线（鼠标悬停可在地图上联动定位）</h3>
          <Chart
            option={detailOption}
            height={activeSections.length * 122 + 70}
            onReady={(chart) => {
              chart.on('updateAxisPointer', (e: any) => {
                const info = e?.axesInfo?.find((x: any) => x.axisDim === 'x')
                if (info && typeof info.value === 'number') setMarkerIdx(info.value)
              })
            }}
          />
        </div>
      )}

      <div className="grid-2">
        {curveOption && (
          <div className="card">
            <h3>
              功率曲线 {data.powerCurve?.ftpEstimate20min ? `· 20min 推算 FTP ${data.powerCurve.ftpEstimate20min}W` : ''}
              {data.powerCurve?.cp ? ` · CP ${data.powerCurve.cp}W / W′ ${data.powerCurve.wPrime}kJ` : ''}
            </h3>
            <Chart option={curveOption} height={260} />
          </div>
        )}
        {hrZoneOption && (
          <div className="card">
            <h3>
              <Term label="心率区间">心率区间</Term>时间分布
            </h3>
            <Chart option={hrZoneOption} height={200} />
          </div>
        )}
        {powerZoneOption && (
          <div className="card">
            <h3>功率区间时间分布</h3>
            <Chart option={powerZoneOption} height={260} />
          </div>
        )}
      </div>
    </>
  )
}
