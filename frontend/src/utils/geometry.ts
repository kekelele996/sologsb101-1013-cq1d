/**
 * 界线几何：经纬度平面化与「样带 × 礁区边界」切段。
 * 纯函数，不碰数据库 —— 测绘室改界线、外业对账、旧数据升级、导出都走同一套切段逻辑。
 *
 * 口径（本系统统一采用）：
 * 跨界样带按段长分摊。样带被各礁区边界线切成若干段，
 * 每段段长 / 整条样带长度 = share；珊瑚覆盖长度与鱼类计数都乘 share 摊到对应礁区。
 */
import type { Belt, BeltGeoSource } from '@/types/belt'
import type { BeltSegment, LngLat, Ring } from '@/types/boundary'

/** 浮点比较容差（沿样带方向的参数 t，0 ~ 1） */
const EPS = 1e-9

/** 平面坐标（米） */
interface XY {
  x: number
  y: number
}

/** 经纬度 → 局部平面（米）。等距圆柱投影，取参照纬度压缩经度，足够样带尺度（百米级）使用 */
export function project(lng: number, lat: number, refLat: number): XY {
  const metersPerDeg = 111320
  return {
    x: lng * metersPerDeg * Math.cos((refLat * Math.PI) / 180),
    y: lat * metersPerDeg
  }
}

/** 两点平面距离（米） */
export function distanceMeters(a: LngLat, b: LngLat): number {
  const refLat = (a[1] + b[1]) / 2
  const pa = project(a[0], a[1], refLat)
  const pb = project(b[0], b[1], refLat)
  return Math.hypot(pa.x - pb.x, pa.y - pb.y)
}

/** 射线法判定点是否在简单多边形内（边界点算在内） */
export function pointInRing(p: LngLat, ring: Ring): boolean {
  if (ring.length < 3) return false
  let inside = false
  const [x, y] = p
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || Number.MIN_VALUE) + xi
    if (intersect) inside = !inside
    // 点正好落在边上
    const cross = (xj - xi) * (y - yi) - (yj - yi) * (x - xi)
    const onSegment =
      Math.abs(cross) < 1e-9 &&
      Math.min(xi, xj) - EPS <= x &&
      x <= Math.max(xi, xj) + EPS &&
      Math.min(yi, yj) - EPS <= y &&
      y <= Math.max(yi, yj) + EPS
    if (onSegment) return true
  }
  return inside
}

/**
 * 线段（样带）与多边形各边求交，返回交点在线段上的参数 t（0 ~ 1，去重、去端点）。
 * 端点在边上时按 0/1 处理但不视作穿越（相邻样带不会因共享端点重复切）。
 */
function ringCrossings(start: XY, end: XY, ring: Ring, refLat: number): number[] {
  if (ring.length < 3) return []
  const ts: number[] = []
  const dx = end.x - start.x
  const dy = end.y - start.y
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = project(ring[j][0], ring[j][1], refLat)
    const b = project(ring[i][0], ring[i][1], refLat)
    const ex = b.x - a.x
    const ey = b.y - a.y
    const denom = dx * ey - dy * ex
    if (Math.abs(denom) < 1e-12) continue
    // 求解 start + t*(end-start) = a + u*(b-a)
    const ox = a.x - start.x
    const oy = a.y - start.y
    const t = (ox * ey - oy * ex) / denom
    const u = (ox * dy - oy * dx) / denom
    if (t > EPS && t < 1 - EPS && u >= -EPS && u <= 1 + EPS) ts.push(t)
  }
  return dedupeSort(ts)
}

function dedupeSort(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const result: number[] = []
  sorted.forEach((value) => {
    if (result.length === 0 || Math.abs(value - result[result.length - 1]) > 1e-7) result.push(value)
  })
  return result
}

function lerpLngLat(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** 切段原始结果（未写库前的纯数据，id / 时间戳由调用方补） */
export interface CutSegment {
  ordinal: number
  reefId: string | null
  startM: number
  endM: number
  lengthM: number
  share: number
  start: LngLat
  end: LngLat
  status: BeltSegment['status']
  reason: string
}

/**
 * 把一条样带按当前版各礁区边界切成归属段。
 * @param belt 样带（需含起止点；旧数据补的整段起终点相同）
 * @param reefRings 当前界线版本下的 reefId -> 外环
 */
export function cutBeltByReefs(
  belt: Pick<Belt, 'lengthM' | 'startCoord' | 'endCoord' | 'geoSource'>,
  reefRings: Array<{ reefId: string; ring: Ring }>
): CutSegment[] {
  const total = Math.max(0, belt.lengthM)
  const start = belt.startCoord
  const end = belt.endCoord
  if (!start || !end || total <= 0) {
    return degenerate(total, null, '样带缺少起止点坐标，待外业补测', [0, 0] as LngLat, [0, 0] as LngLat)
  }

  // 旧数据升级：起终点相同的整段样带，按站位坐标做点归属
  const degeneratePoint = samePoint(start, end) || belt.geoSource === ('legacy_upgraded' satisfies BeltGeoSource)
  if (degeneratePoint) {
    const hit = reefRings.find(({ ring }) => pointInRing(start, ring))
    if (hit) {
      return [{
        ordinal: 0,
        reefId: hit.reefId,
        startM: 0,
        endM: total,
        lengthM: total,
        share: 1,
        start,
        end,
        status: 'matched',
        reason: '旧数据按站位坐标补的整段样带，点归属'
      }]
    }
    return degenerate(total, null, '站位坐标不在任一礁区界线内，先挂起待测绘室核对', start, end)
  }

  const refLat = (start[1] + end[1]) / 2
  const p0 = project(start[0], start[1], refLat)
  const p1 = project(end[0], end[1], refLat)

  // 收集全部穿越参数
  const cuts = new Set<number>()
  reefRings.forEach(({ ring }) => ringCrossings(p0, p1, ring, refLat).forEach((t) => cuts.add(t)))
  const breaks = dedupeSort([0, ...cuts, 1])

  // 逐片按中点定归属
  const pieces: CutSegment[] = []
  for (let i = 0; i < breaks.length - 1; i++) {
    const t0 = breaks[i]
    const t1 = breaks[i + 1]
    if (t1 - t0 < EPS) continue
    const mid = lerpLngLat(start, end, (t0 + t1) / 2)
    const owner = reefRings.find(({ ring }) => pointInRing(mid, ring))
    pieces.push({
      ordinal: i,
      reefId: owner ? owner.reefId : null,
      startM: roundM(t0 * total),
      endM: roundM(t1 * total),
      lengthM: roundM((t1 - t0) * total),
      share: roundShare(t1 - t0),
      start: lerpLngLat(start, end, t0),
      end: lerpLngLat(start, end, t1),
      status: owner ? 'matched' : 'pending',
      reason: owner ? '' : '该段落在全部礁区界线之外，先挂起'
    })
  }

  // 合并相邻同归属段
  const merged: CutSegment[] = []
  pieces.forEach((piece) => {
    const prev = merged[merged.length - 1]
    if (prev && prev.reefId === piece.reefId && prev.status === piece.status) {
      prev.endM = piece.endM
      prev.lengthM = roundM(prev.lengthM + piece.lengthM)
      prev.share = roundShare(prev.share + piece.share)
      prev.end = piece.end
      prev.reason = piece.reason || prev.reason
    } else {
      merged.push({ ...piece })
    }
  })
  merged.forEach((segment, index) => {
    segment.ordinal = index
  })

  // 归一化：消除分摊比例的浮点尾差，保证各段 share 合计恰好 1
  normalizeShares(merged)
  return merged
}

function degenerate(total: number, reefId: string | null, reason: string, start: LngLat, end: LngLat): CutSegment[] {
  return [{ ordinal: 0, reefId, startM: 0, endM: total, lengthM: total, share: 1, start, end, status: 'pending', reason }]
}

function samePoint(a: LngLat, b: LngLat): boolean {
  return Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS
}

function normalizeShares(segments: CutSegment[]): void {
  if (segments.length === 0) return
  const sum = segments.reduce((acc, segment) => acc + segment.share, 0)
  if (sum <= 0) return
  const last = segments[segments.length - 1]
  last.share = roundShare(1 - segments.slice(0, -1).reduce((acc, segment) => acc + segment.share, 0))
  if (last.share < 0) last.share = 0
  void sum
}

function roundM(value: number): number {
  return Math.round(value * 1000) / 1000
}

function roundShare(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** 段是否跨界（一条样带出现两个及以上不同归属礁区） */
export function isCrossBoundary(segments: CutSegment[]): boolean {
  const reefs = new Set(segments.filter((segment) => segment.reefId !== null).map((segment) => segment.reefId))
  return reefs.size >= 2
}

/** 按朝向与样带长度由起点推算终点（外业未实测终点时的默认值，北+ 纬度 / 东+ 经度） */
export function endpointFromOrientation(start: LngLat, orientation: string, lengthM: number): LngLat {
  const [lng, lat] = start
  const metersPerDeg = 111320
  const dLat = lengthM / metersPerDeg
  const dLng = lengthM / (metersPerDeg * Math.cos((lat * Math.PI) / 180))
  switch (orientation) {
    case '北':
      return [lng, roundCoord(lat + dLat)]
    case '南':
      return [lng, roundCoord(lat - dLat)]
    case '东':
      return [roundCoord(lng + dLng), lat]
    case '西':
      return [roundCoord(lng - dLng), lat]
    default:
      return [lng, lat]
  }
}

function roundCoord(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

