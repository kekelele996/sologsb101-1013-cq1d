/** 经纬度点（十进制度）：lng 经度、lat 纬度 */
export interface LatLng {
  lat: number
  lng: number
}

/** 保护区状态 */
export type ProtectStatus = '核心区' | '缓冲区' | '实验区' | '未设区'

export const PROTECT_STATUSES: ProtectStatus[] = ['核心区', '缓冲区', '实验区', '未设区']

/**
 * 礁区：珊瑚礁普查的基本单元。
 * 界线（boundaryPolygon）由界线测绘室维护：首尾不必重复，按十进制度经纬度记录的简单多边形。
 */
export interface Reef {
  id: string
  /** 礁区名 */
  name: string
  /** 位置描述 */
  location: string
  /** 面积（km²） */
  areaKm2: number
  /** 保护区状态 */
  protectStatus: ProtectStatus
  /** 管理单位 */
  manager: string
  /** 礁区界线多边形顶点（界线测绘室口径），空数组表示界线尚未测绘 */
  boundaryPolygon: LatLng[]
  /** 界线修订序号：每次测绘室改界 +1，用于触发压旧线样带重算 */
  boundaryRev: number
  /** 界线最近一次修订时间 */
  boundaryUpdatedAt: number | null
  createdAt: number
  updatedAt: number
}

/** 礁区台账筛选条件（存于 reefStore，并同步 URL query） */
export interface ReefFilterState {
  keyword: string
  protectStatuses: ProtectStatus[]
  /** 面积下限（km²） */
  minAreaKm2: number | null
  /** 面积上限（km²） */
  maxAreaKm2: number | null
}

export function createEmptyReefFilter(): ReefFilterState {
  return {
    keyword: '',
    protectStatuses: [],
    minAreaKm2: null,
    maxAreaKm2: null
  }
}

/** 礁区面积分档，供筛选下拉使用 */
export const AREA_BUCKETS: Array<{ label: string; min: number | null; max: number | null }> = [
  { label: '全部面积', min: null, max: null },
  { label: '小于 5 km²', min: null, max: 5 },
  { label: '5 ~ 20 km²', min: 5, max: 20 },
  { label: '20 ~ 100 km²', min: 20, max: 100 },
  { label: '大于 100 km²', min: 100, max: null }
]

/** 界线最少顶点数：三个不共线的点才能围成面 */
export const BOUNDARY_MIN_POINTS = 3

/**
 * 界线测绘室校验：返回错误信息（为空表示通过）。
 * 经纬度合法性、顶点数量、是否自相交都在这里把关，测绘室改界失败时只重试界线这侧。
 */
export function validateBoundary(points: LatLng[]): string[] {
  const errors: string[] = []
  if (points.length > 0 && points.length < BOUNDARY_MIN_POINTS) {
    errors.push(`界线至少需要 ${BOUNDARY_MIN_POINTS} 个顶点（当前 ${points.length} 个）`)
  }
  points.forEach((point, index) => {
    if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
      errors.push(`第 ${index + 1} 个顶点纬度应在 -90 ~ 90 之间`)
    }
    if (!Number.isFinite(point.lng) || point.lng < -180 || point.lng > 180) {
      errors.push(`第 ${index + 1} 个顶点经度应在 -180 ~ 180 之间`)
    }
  })
  // 顶点数量较少时逐对判自相交（边界允许与隔壁礁区共边，但同一多边形内部不允许自交）
  if (points.length >= BOUNDARY_MIN_POINTS && errors.length === 0 && segmentsIntersectItself(points)) {
    errors.push('界线多边形存在自相交，请调整顶点顺序')
  }
  return errors
}

/** 简易线段相交判断（仅用于界线自相交校验，共端点、共线不算相交） */
function segmentsIntersectItself(points: LatLng[]): boolean {
  const cross = (o: LatLng, a: LatLng, b: LatLng): number =>
    (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng)
  const intersect = (p1: LatLng, p2: LatLng, p3: LatLng, p4: LatLng): boolean => {
    const d1 = cross(p3, p4, p1)
    const d2 = cross(p3, p4, p2)
    const d3 = cross(p1, p2, p3)
    const d4 = cross(p1, p2, p4)
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  }
  const n = points.length
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      // 相邻边（含首尾）共享端点，跳过
      if (Math.abs(i - j) === 1 || (i === 0 && j === n - 1)) continue
      if (intersect(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return true
    }
  }
  return false
}
