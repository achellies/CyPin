/** 解码 Google/Strava encoded polyline（精度 5） */
export function decodePolyline(str: string, precision = 5): [number, number][] {
  let index = 0
  let lat = 0
  let lng = 0
  const coordinates: [number, number][] = []
  const factor = Math.pow(10, precision)

  while (index < str.length) {
    let byte = 0
    let shift = 0
    let result = 0
    do {
      byte = str.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    const latitudeChange = result & 1 ? ~(result >> 1) : result >> 1

    shift = 0
    result = 0
    do {
      byte = str.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    const longitudeChange = result & 1 ? ~(result >> 1) : result >> 1

    lat += latitudeChange
    lng += longitudeChange
    coordinates.push([lat / factor, lng / factor])
  }
  return coordinates
}
