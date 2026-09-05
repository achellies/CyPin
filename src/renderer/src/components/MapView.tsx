import { useEffect, useRef } from 'react'
import type { Streams } from '@shared/types'
import { decodePolyline } from '../lib/polyline'
import L from 'leaflet'

export function MapView({
  streams,
  mapSummary,
  markerIndex
}: {
  streams: Streams | null
  mapSummary?: string
  markerIndex?: number | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const markerRef = useRef<L.CircleMarker | null>(null)
  const pointsRef = useRef<[number, number][]>([])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let points: [number, number][] = []
    if (streams?.latlng?.length) points = streams.latlng
    else if (mapSummary) points = decodePolyline(mapSummary)

    pointsRef.current = points
    const valid = points.filter((p) => p[0] || p[1])
    if (!valid.length) return

    const map = L.map(el, { zoomControl: true, attributionControl: false, scrollWheelZoom: false })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map)
    // 无效点（如室内骑行台 [0,0]）分段跳过，保持索引与 streams 对齐
    let segment: [number, number][] = []
    const bounds = L.latLngBounds(valid)
    const draw = () => {
      if (segment.length > 1) L.polyline(segment, { color: '#fc4c02', weight: 3, opacity: 0.9 }).addTo(map)
      segment = []
    }
    for (const p of points) {
      if (p[0] || p[1]) segment.push(p)
      else draw()
    }
    draw()
    map.fitBounds(bounds, { padding: [20, 20] })
    const start = valid[0]
    markerRef.current = L.circleMarker(start, {
      radius: 7,
      color: '#ffffff',
      weight: 2,
      fillColor: '#fc4c02',
      fillOpacity: 1
    }).addTo(map)

    return () => {
      markerRef.current = null
      map.remove()
    }
  }, [streams, mapSummary])

  // 图表悬停/缩放联动：移动地图标记
  useEffect(() => {
    const pts = pointsRef.current
    const marker = markerRef.current
    if (!pts.length || !marker || markerIndex == null) return
    const p = pts[Math.min(Math.max(markerIndex, 0), pts.length - 1)]
    if (p && (p[0] || p[1])) {
      marker.setLatLng(p)
      marker.bringToFront()
    }
  }, [markerIndex])

  const hasData = (streams?.latlng?.length ?? 0) > 0 || !!mapSummary
  return hasData ? <div id="map" ref={ref} /> : <div className="map-empty">该活动没有轨迹数据</div>
}
