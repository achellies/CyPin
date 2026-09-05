import { Store } from './store'
import { enrichActivity } from './analysis'
import type { Activity, Streams } from '../shared/types'

// fit-file-parser 无类型定义，用 require 引入
// eslint-disable-next-line @typescript-eslint/no-var-requires
const FitParser = require('fit-file-parser')?.default ?? require('fit-file-parser')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { XMLParser } = require('fast-xml-parser')

export async function importFiles(store: Store, files: string[]): Promise<{ imported: number; failed: string[] }> {
  let imported = 0
  const failed: string[] = []
  for (const f of files) {
    try {
      const lower = f.toLowerCase()
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs') as typeof import('fs')
      const buffer = fs.readFileSync(f)
      let result: { activity: Activity; streams: Streams } | null = null
      if (lower.endsWith('.fit')) result = await parseFit(buffer)
      else if (lower.endsWith('.gpx')) result = parseGpx(buffer, f)
      if (!result) throw new Error('无法识别的文件内容')
      if (result.streams.time.length < 10) throw new Error('文件中没有有效轨迹点')
      result.activity = enrichActivity(result.activity, result.streams)
      store.upsertActivities([result.activity])
      store.saveStreams(result.activity.id, result.streams)
      imported++
    } catch (err: any) {
      failed.push(`${f}: ${String(err?.message || err)}`)
    }
  }
  return { imported, failed }
}

async function parseFit(buffer: Buffer): Promise<{ activity: Activity; streams: Streams }> {
  const fitParser = new FitParser({
    force: true,
    speedUnit: 'm/s',
    lengthUnit: 'm',
    temperatureUnit: 'celsius',
    elapsedRecordField: true,
    mode: 'list'
  })
  const data: any = await new Promise((resolve, reject) => {
    fitParser.parse(buffer, (err: Error | null, d: any) => (err ? reject(err) : resolve(d)))
  })
  const records: any[] = data.records || []
  const session: any = data.sessions?.[0] ?? data.activity?.sessions?.[0] ?? {}

  const time: number[] = []
  const latlng: [number, number][] = []
  const distance: number[] = []
  const altitude: number[] = []
  const heartrate: number[] = []
  const cadence: number[] = []
  const watts: number[] = []
  const velocity: number[] = []

  const t0 = records.length ? new Date(records[0].timestamp).getTime() : null
  if (t0 == null || Number.isNaN(t0)) throw new Error('FIT 缺少时间戳')

  for (const r of records) {
    const ts = new Date(r.timestamp).getTime()
    if (Number.isNaN(ts)) continue
    time.push(Math.round((ts - t0) / 1000))
    const lat = r.position_lat
    const lng = r.position_long
    latlng.push(lat != null && lng != null ? [lat, lng] : [0, 0])
    distance.push(r.distance ?? 0)
    altitude.push(r.altitude ?? r.enhanced_altitude ?? 0)
    heartrate.push(r.heart_rate ?? 0)
    cadence.push(r.cadence ?? 0)
    watts.push(r.power ?? 0)
    velocity.push(r.speed ?? r.enhanced_speed ?? 0)
  }

  const movingTime = session.total_timer_time ?? session.total_elapsed_time ?? (time.at(-1) ?? 0)
  const streams: Streams = {
    time,
    latlng,
    distance,
    altitude,
    velocitySmooth: velocity,
    heartrate: heartrate.some((v) => v > 0) ? heartrate : undefined,
    cadence: cadence.some((v) => v > 0) ? cadence : undefined,
    watts: watts.some((v) => v > 0) ? watts : undefined
  }

  const startIso = new Date(t0).toISOString()
  const name: string =
    typeof session.event === 'string'
      ? session.event.replace(/_/g, ' ')
      : data.sports?.[0]?.name
        ? String(data.sports[0].name)
        : `FIT 导入 ${startIso.slice(0, 16)}`

  const activity: Activity = {
    id: `local_fit_${Math.floor(t0 / 1000)}`,
    source: 'local',
    name,
    type: 'Ride',
    startDate: startIso,
    distance: session.total_distance ?? distance.at(-1) ?? 0,
    movingTime: Math.round(movingTime),
    elapsedTime: Math.round(session.total_elapsed_time ?? movingTime),
    totalElevationGain: session.total_ascent ?? 0,
    averageSpeed: session.avg_speed ?? avg(velocity.filter((v) => v > 0)),
    maxSpeed: session.max_speed ?? Math.max(...velocity, 0),
    averageHeartrate: session.avg_heart_rate,
    maxHeartrate: session.max_heart_rate,
    averageWatts: session.avg_power,
    maxWatts: session.max_power,
    weightedAverageWatts: session.normalized_power,
    averageCadence: session.avg_cadence,
    calories: session.total_calories,
    hasHeartrate: false,
    deviceWatts: false,
    trainer: false,
    commute: false,
    startLatlng: latlng[0]?.[0] ? latlng[0] : undefined,
    endLatlng: latlng.at(-1)?.[0] ? latlng.at(-1) : undefined
  }
  return { activity, streams }
}

function parseGpx(buffer: Buffer, filename: string): { activity: Activity; streams: Streams } {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const doc = parser.parse(buffer.toString('utf-8'))
  const trk = doc?.gpx?.trk
  if (!trk) throw new Error('GPX 中没有轨迹')
  const ptsRaw: any[] = []
  const segs = Array.isArray(trk.trkseg) ? trk.trkseg : trk.trkseg ? [trk.trkseg] : []
  for (const seg of segs) {
    const pts = Array.isArray(seg.trkpt) ? seg.trkpt : seg.trkpt ? [seg.trkpt] : []
    ptsRaw.push(...pts)
  }
  if (ptsRaw.length < 10) throw new Error('GPX 轨迹点过少')

  const time: number[] = []
  const latlng: [number, number][] = []
  const distance: number[] = []
  const altitude: number[] = []
  const heartrate: number[] = []
  const cadence: number[] = []
  const watts: number[] = []
  let cumulative = 0
  let t0: number | null = null
  let prev: { lat: number; lng: number } | null = null

  for (const p of ptsRaw) {
    const lat = Number(p['@_lat'])
    const lng = Number(p['@_lon'])
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue
    const ele = Number(p.ele ?? 0)
    const ts = p.time ? new Date(p.time).getTime() : null
    if (prev) cumulative += haversine(prev.lat, prev.lng, lat, lng)
    prev = { lat, lng }
    if (t0 == null && ts != null && !Number.isNaN(ts)) t0 = ts
    time.push(ts != null && !Number.isNaN(ts) ? Math.round((ts - t0!) / 1000) : time.length)
    latlng.push([lat, lng])
    distance.push(Math.round(cumulative))
    altitude.push(ele)
    // Garmin 风格扩展：extensions > TrackPointExtension > hr / cad
    const ext = p.extensions
    let hr = 0
    let cad = 0
    let pw = 0
    if (ext) {
      for (const key of Object.keys(ext)) {
        const node = ext[key]
        if (node && typeof node === 'object') {
          hr = Number(node.hr ?? node['gpxtpx:hr'] ?? node['ns3:hr'] ?? 0)
          cad = Number(node.cad ?? node['gpxtpx:cad'] ?? node['ns3:cad'] ?? node.cadence ?? 0)
          pw = Number(node.power ?? node['ns3:PowerInWatts'] ?? node.watts ?? 0)
        }
      }
    }
    heartrate.push(hr || 0)
    cadence.push(cad || 0)
    watts.push(pw || 0)
  }

  const velocity: number[] = []
  for (let i = 0; i < time.length; i++) {
    if (i === 0) velocity.push(0)
    else {
      const dt = time[i] - time[i - 1]
      velocity.push(dt > 0 ? (distance[i] - distance[i - 1]) / dt : 0)
    }
  }
  // 3 点平滑
  const smoothed = velocity.map((v, i) => {
    if (i === 0 || i === velocity.length - 1) return v
    return (velocity[i - 1] + v + velocity[i + 1]) / 3
  })

  const movingTime = estimateMovingTime(time, smoothed)
  const startIso = t0 ? new Date(t0).toISOString() : new Date().toISOString()
  const name: string = typeof trk.name === 'string' ? trk.name : filename.replace(/\.gpx$/i, '')

  const streams: Streams = {
    time,
    latlng,
    distance,
    altitude,
    velocitySmooth: smoothed,
    heartrate: heartrate.some((v) => v > 0) ? heartrate : undefined,
    cadence: cadence.some((v) => v > 0) ? cadence : undefined,
    watts: watts.some((v) => v > 0) ? watts : undefined
  }

  const activity: Activity = {
    id: `local_gpx_${Math.floor(new Date(startIso).getTime() / 1000)}_${Math.abs(hashCode(name)) % 1000}`,
    source: 'local',
    name,
    type: 'Ride',
    startDate: startIso,
    distance: Math.round(cumulative),
    movingTime,
    elapsedTime: time.at(-1) ?? 0,
    totalElevationGain: sumGain(altitude),
    averageSpeed: movingTime ? cumulative / movingTime : 0,
    maxSpeed: Math.max(...smoothed, 0),
    hasHeartrate: false,
    deviceWatts: false,
    trainer: false,
    commute: false,
    startLatlng: latlng[0],
    endLatlng: latlng.at(-1)
  }
  return { activity, streams }
}

/** 速度低于 2 m/s 视为停留，估算移动时间 */
function estimateMovingTime(time: number[], speed: number[]): number {
  let moving = 0
  for (let i = 1; i < time.length; i++) {
    const dt = time[i] - time[i - 1]
    if (dt > 0 && dt < 30 && speed[i] > 2) moving += dt
  }
  return moving || (time.at(-1) ?? 0)
}

function sumGain(alt: number[]): number {
  let gain = 0
  for (let i = 1; i < alt.length; i++) {
    const d = alt[i] - alt[i - 1]
    if (d > 0) gain += d
  }
  return Math.round(gain)
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLng = (lng2 - lng1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}
