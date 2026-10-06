/**
 * 界线几何：测绘室礁区界线（经纬度简单多边形）与外业样带起止点的求交切段。
 * 跨界样带在此切成各礁区分段，段长由样带起止点沿走向的比例折算，合计等于样带总长。
 * 本应用为纯前端工具，几何计算用经纬度平面 + 局部比例尺，精度满足外业分段分摊口径。
 */
import type { LatLng } from '@/types/reef'
import type { Reef } from '@/types/reef'
import type { BeltSegment } from '@/types/belt'
import { round } from '@/utils/bleach'

const EARTH_RADIUS_M = 6371008.8
const DEG2RAD = Math.PI / 180

/** 两点间大圆距离（m，Haversine） */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG2RAD
  const dLng = (b.lng - a.lng) * DEG2RAD
  const lat1 = a.lat * DEG2RAD
  const lat2 = b.lat * DEG2RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** 射线法判断点是否落在多边形内（边上按在内处理） */
export function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  const n = polygon.length
  if (n < 3) return false
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].lng
    const yi = polygon[i].lat
    const xj = polygon[j].lng
    const yj = polygon[j].lat
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi || Number.EPSILON) + xi
    if (intersects) inside = !inside
  }
  return inside
}

interface LineCross {
  /** 沿样带方向的交点参数（0 起点 ~ 1 终点） */
  t: number
}

/** 线段 AB 与多边形某条边 CD 的交点参数（仅取严格穿过的交点） */
function crossingParam(a: LatLng, b: LatLng, c: LatLng, d: LatLng): number | null {
  const cross = (p: LatLng, q: LatLng, r: LatLng): number =>
    (q.lng - p.lng) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lng - p.lng)
  const rxs = cross(a, b, c)
  const sxd = cross(c, d, a)
  const rxd = cross(a, b, d)
  const sxs = cross(c, d, b)
  const straddle1 = (rxs > 0 && rxd < 0) || (rxs < 0 && rxd > 0)
  const straddle2 = (sxd > 0 && sxs < 0) || (sxd < 0 && sxs > 0)
  if (!straddle1 || !straddle2) return null
  // 求交点在 AB 上的参数 t
  const dc = { lat: d.lat - c.lat, lng: d.lng - c.lng }
  const denom = (b.lng - a.lng) * dc.lat - (b.lat - a.lat) * dc.lng
  if (denom === 0) return null
  const t = ((c.lng - a.lng) * dc.lat - (c.lat - a.lat) * dc.lng) / denom
  return t > 0 && t < 1 ? t : null
}

/** 收集样带与某礁区界线的全部穿越参数 */
function edgeCrossings(start: LatLng, end: LatLng, polygon: LatLng[]): LineCross[] {
  const result: LineCross[] = []
  const n = polygon.length
  for (let i = 0; i < n; i += 1) {
    const t = crossingParam(start, end, polygon[i], polygon[(i + 1) % n])
    if (t !== null) result.push({ t })
  }
  return result
}

function pointAt(start: LatLng, end: LatLng, t: number): LatLng {
  return {
    lat: start.lat + (end.lat - start.lat) * t,
    lng: start.lng + (end.lng - start.lng) * t
  }
}

/** 切段结果 */
export interface SplitBeltResult {
  /** 从起点到终点排序的礁区分段（段长合计等于样带总长） */
  segments: BeltSegment[]
  /** 对不上时的原因（非空时调用方按挂账处理） */
  issues: string[]
  /** 是否压在两个及以上礁区 */
  crossed: boolean
}

/**
 * 按礁区界线把样带起止点切成各礁区分段。
 * 没有任何已测绘界线时，整条落回起点站位所属礁区。
 */
export function splitBeltByReefs(
  start: LatLng,
  end: LatLng,
  lengthM: number,
  originReefId: string,
  reefs: Reef[]
): SplitBeltResult {
  const issues: string[] = []
  const surveyed = reefs.filter((reef) => reef.boundaryPolygon.length >= 3)
  if (surveyed.length === 0) {
    return {
      segments: [{ reefId: originReefId, lengthM: round(lengthM, 2) }],
      issues,
      crossed: false
    }
  }

  const reefAt = (point: LatLng): Reef | undefined => surveyed.find((reef) => pointInPolygon(point, reef.boundaryPolygon))
  if (!reefAt(start)) issues.push('起点不在任一已测绘礁区界线内')
  if (!reefAt(end)) issues.push('终点不在任一已测绘礁区界线内')

  const cuts = new Set<number>([0, 1])
  surveyed.forEach((reef) => {
    edgeCrossings(start, end, reef.boundaryPolygon).forEach((cross) => cuts.add(round(cross.t, 6)))
  })
  const params = Array.from(cuts).sort((a, b) => a - b)

  const raw: Array<BeltSegment & { portion: number }> = []
  params.slice(0, -1).forEach((t0, index) => {
    const t1 = params[index + 1]
    const mid = pointAt(start, end, (t0 + t1) / 2)
    const reef = reefAt(mid)
    if (!reef) {
      issues.push(`样带自起点 ${Math.round(t0 * lengthM)} ~ ${Math.round(t1 * lengthM)} m 段不落在任何礁区界线内`)
      return
    }
    raw.push({ reefId: reef.id, lengthM: 0, portion: t1 - t0 })
  })

  // 相邻同礁区的子段先按礁区汇总段长比例（两侧界线共边会产生零间隔切点）
  const portionByReef = new Map<string, number>()
  const orderedReefIds: string[] = []
  raw.forEach((piece) => {
    if (!orderedReefIds.includes(piece.reefId)) orderedReefIds.push(piece.reefId)
    portionByReef.set(piece.reefId, (portionByReef.get(piece.reefId) ?? 0) + piece.portion)
  })

  let allocated = 0
  const segments: BeltSegment[] = orderedReefIds.map((reefId, index) => {
    const portion = portionByReef.get(reefId) ?? 0
    if (index === orderedReefIds.length - 1) {
      // 末段吃舍入余差，保证段长合计严格等于样带总长
      const lastLength = round(lengthM - allocated, 2)
      allocated = lengthM
      return { reefId, lengthM: Math.max(0, lastLength) }
    }
    const pieceLength = round(lengthM * portion, 2)
    allocated += pieceLength
    return { reefId, lengthM: pieceLength }
  })

  const finalSegments =
    segments.length > 0 ? segments : [{ reefId: originReefId, lengthM: round(lengthM, 2) }]
  const crossed = new Set(finalSegments.map((segment) => segment.reefId)).size > 1

  return { segments: finalSegments, issues: Array.from(new Set(issues)), crossed }
}

/** 段长合计（m） */
export function totalSegmentLength(segments: BeltSegment[]): number {
  return round(
    segments.reduce((sum, segment) => sum + segment.lengthM, 0),
    2
  )
}
