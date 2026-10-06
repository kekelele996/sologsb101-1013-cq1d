/**
 * 界线测绘室初始装配：根据礁区与样带几何产出一版初始界线、
 * 几何切段（按段长分摊）、两室对账记录与改线流水。
 * 首次播种与旧库 v3 升级共用本文件，保证口径一致。
 */
import type { Belt } from '@/types/belt'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { BeltSegment, BoundaryNotice, BoundaryRevision, BoundaryVersion, Ring } from '@/types/boundary'
import { createId } from '@/utils/id'
import { cutBeltByReefs, type CutSegment } from '@/utils/geometry'
import { reconcile, verdictToNotices, type FieldCrossReport } from '@/utils/reconcile'

/** 演示礁区的初始边界线（外环坐标）。清澜湾与龙湾在 110.7927 经线相邻共边。 */
export const SEED_RINGS: Record<string, Ring> = {
  // 清澜湾（西）
  reef_ql01: [
    [110.79, 19.547],
    [110.7927, 19.547],
    [110.7927, 19.563],
    [110.79, 19.563]
  ],
  // 龙湾隔壁礁区（东，与清澜湾共边）
  reef_lw04: [
    [110.7927, 19.547],
    [110.7945, 19.547],
    [110.7945, 19.563],
    [110.7927, 19.563]
  ],
  // 永兴岛西侧礁盘
  reef_yr02: [
    [112.3265, 16.833],
    [112.3305, 16.833],
    [112.3305, 16.836],
    [112.3265, 16.836]
  ],
  // 大洲岛南岸礁区
  reef_dz03: [
    [110.49, 18.67],
    [110.493, 18.67],
    [110.493, 18.673],
    [110.49, 18.673]
  ]
}

/** 以站位坐标为中心的默认礁区边界（旧库升级时没有预置界线，用站位兜出一个小区） */
function fallbackRing(sites: Site[], reefId: string): Ring | null {
  const own = sites.filter((site) => site.reefId === reefId)
  if (own.length === 0) return null
  const lngs = own.map((site) => site.lng)
  const lats = own.map((site) => site.lat)
  const minLng = Math.min(...lngs) - 0.002
  const maxLng = Math.max(...lngs) + 0.002
  const minLat = Math.min(...lats) - 0.002
  const maxLat = Math.max(...lats) + 0.002
  return [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat]
  ]
}

/** 切段所需的样带字段（播种时含或不含时间戳均可） */
export type BootstrapBelt = Pick<
  Belt,
  'id' | 'siteId' | 'no' | 'lengthM' | 'orientation' | 'startCoord' | 'endCoord' | 'geoSource'
>

export interface BootstrapInput {
  reefs: Array<Pick<Reef, 'id'>>
  belts: BootstrapBelt[]
  sites?: Site[]
  fieldCrossReports?: FieldCrossReport[]
  baseTime?: number
  note?: string
  versionNo?: number
}

export interface BootstrapResult {
  versions: BoundaryVersion[]
  segments: BeltSegment[]
  notices: BoundaryNotice[]
  revisions: BoundaryRevision[]
}

/**
 * 装配一版界线：切段 → 对账 → 落流水。
 * 旧库升级（无外业上报、无站点兜底几何）与首次播种都走这里。
 */
export function createBoundaryBootstrap(input: BootstrapInput): BootstrapResult {
  const { reefs, belts, sites = [], fieldCrossReports = [], baseTime = Date.now() } = input
  const versionNo = input.versionNo ?? 1
  const now = baseTime

  // reefId -> 外环
  const reefRings = reefs
    .map((reef) => ({ reefId: reef.id, ring: SEED_RINGS[reef.id] ?? fallbackRing(sites, reef.id) }))
    .filter((entry): entry is { reefId: string; ring: Ring } => entry.ring !== null)

  const versionId = createId('bnd')
  const version: BoundaryVersion = {
    id: versionId,
    version: versionNo,
    reefs: Object.fromEntries(reefRings.map((entry) => [entry.reefId, entry.ring])),
    note: input.note ?? (versionNo === 1 ? '初始界线版本（旧账按站位坐标补整段）' : `界线版本 v${versionNo}`),
    isActive: true,
    failed: false,
    publishedBy: '界线测绘室',
    createdAt: now,
    updatedAt: now
  }

  // 几何切段（按段长分摊口径）
  const segments: BeltSegment[] = []
  const segmentsByBelt = new Map<string, BeltSegment[]>()
  belts.forEach((belt, beltIndex) => {
    const cut: CutSegment[] = cutBeltByReefs(belt, reefRings)
    const beltSegments: BeltSegment[] = cut.map((piece) => ({
      id: createId(`seg_${beltIndex}`),
      boundaryVersionId: versionId,
      boundaryVersion: versionNo,
      beltId: belt.id,
      beltNo: belt.no,
      ordinal: piece.ordinal,
      reefId: piece.reefId,
      startM: piece.startM,
      endM: piece.endM,
      lengthM: piece.lengthM,
      start: piece.start,
      end: piece.end,
      share: piece.share,
      status: piece.status,
      reason: piece.reason,
      createdAt: now,
      updatedAt: now
    }))
    segments.push(...beltSegments)
    segmentsByBelt.set(belt.id, beltSegments)
  })

  // 两室按样带编号对账
  const reportsByNo = new Map(fieldCrossReports.map((report) => [report.beltNo, report]))
  const verdicts = reconcile(segmentsByBelt, reportsByNo)
  const notices: BoundaryNotice[] = verdicts.flatMap((verdict) =>
    verdictToNotices(verdict, versionId, now, createId)
  )

  // 对不上的样带：对应段改挂 pending，使其不进礁区白化与导出
  const pendingBeltIds = new Set(verdicts.filter((verdict) => verdict.status === 'pending').map((verdict) => verdict.beltId))
  segments.forEach((segment) => {
    if (pendingBeltIds.has(segment.beltId)) {
      segment.status = 'pending'
      if (!segment.reason) segment.reason = '两室按样带编号对账未通过，先挂起'
    }
  })

  const affectedBeltNos = Array.from(
    new Set(segments.filter((segment) => segment.reefId !== null).map((segment) => segment.beltNo))
  )
  const revision: BoundaryRevision = {
    id: createId('rev'),
    boundaryVersionId: versionId,
    version: versionNo,
    state: 'done',
    message: '界线版本已发布并完成切段重算',
    retries: 0,
    affectedBeltNos,
    createdAt: now,
    updatedAt: now
  }

  return { versions: [version], segments, notices, revisions: [revision] }
}
