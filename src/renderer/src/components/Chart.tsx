import { useEffect, useRef } from 'react'
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

export function Chart({ option, height = 320, notMerge = true, onReady }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const readyCb = useRef(onReady)
  readyCb.current = onReady

  useEffect(() => {
    const el = ref.current
    if (!el) return
    chart.current = echarts.init(el, undefined, { renderer: 'canvas' })
    readyCb.current?.(chart.current)
    const ro = new ResizeObserver(() => chart.current?.resize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.current?.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption(option, notMerge ? { notMerge: true } : undefined)
  }, [option, notMerge])

  return <div ref={ref} style={{ width: '100%', height }} />
}
