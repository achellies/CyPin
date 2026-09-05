import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'

interface Props {
  option: echarts.EChartsOption
  height?: number | string
  notMerge?: boolean
  onReady?: (chart: echarts.ECharts) => void
}

export const axisStyle = {
  textStyle: { color: '#9aa4b0' },
  axisLine: { lineStyle: { color: '#2a323d' } },
  splitLine: { lineStyle: { color: '#222932' } }
}

/** ECharts 封装：init/setOption 全部捕获错误，单个图表崩溃只降级为错误占位，不拖垮整页 */
export function Chart({ option, height = 320, notMerge = true, onReady }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const readyCb = useRef(onReady)
  readyCb.current = onReady
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    try {
      chart.current = echarts.init(el, undefined, { renderer: 'canvas' })
      readyCb.current?.(chart.current)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    const ro = new ResizeObserver(() => {
      try {
        chart.current?.resize()
      } catch {
        /* 忽略 resize 时已销毁的竞争 */
      }
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      try {
        chart.current?.dispose()
      } catch {
        /* 已销毁 */
      }
      chart.current = null
    }
  }, [])

  useEffect(() => {
    if (error || !chart.current) return
    try {
      chart.current.setOption(option, notMerge ? { notMerge: true } : undefined)
    } catch (e) {
      // setOption 失败：销毁实例避免残留半渲染状态，降级为错误占位
      setError(e instanceof Error ? e.message : String(e))
      try {
        chart.current.dispose()
      } catch {
        /* 已销毁 */
      }
      chart.current = null
    }
  }, [option, notMerge, error])

  if (error) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--muted)',
          fontSize: 13,
          background: 'var(--panel)',
          borderRadius: 8
        }}
      >
        <span>⚠️ 图表渲染失败，已跳过（不影响其他数据）</span>
        <span style={{ fontSize: 11, opacity: 0.6, maxWidth: 480, overflow: 'hidden', textOverflow: 'ellipsis' }}>{error}</span>
      </div>
    )
  }

  return <div ref={ref} style={{ width: '100%', height }} />
}
