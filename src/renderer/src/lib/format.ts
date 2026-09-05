export function km(meters: number): string {
  if (meters >= 100000) return (meters / 1000).toFixed(1) + ' km'
  return (meters / 1000).toFixed(meters >= 10000 ? 1 : 2) + ' km'
}

export function mNum(meters: number): string {
  return Math.round(meters).toLocaleString() + ' m'
}

export function duration(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export function kmh(mps: number): string {
  return (mps * 3.6).toFixed(1) + ' km/h'
}

export function datetime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function dateShort(iso: string): string {
  return iso.slice(0, 10)
}

export const TYPE_LABELS: Record<string, string> = {
  Ride: '公路',
  VirtualRide: '骑行台',
  GravelRide: '砾石',
  MountainBikeRide: '山地',
  EBikeRide: '电助力',
  Handcycle: '手摇'
}
