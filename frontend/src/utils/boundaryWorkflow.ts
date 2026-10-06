/**
 * 界线改线工作流（界线测绘室操作，外业普查组底账只读）：
 * 1. persistBoundary：落新一版 BoundaryVersion（isActive=1）+ BoundaryRevision。
 *    此步失败（如模拟发布失败）只重试界线这侧 —— 不触碰 belts/corals/fishes。
 * 2. recomputeSegments：依据新版界线重算切段，压在旧线上的样带（归属或跨界状态变化）自动重算。
 * 3. reconcileNotices：两室按样带编号重新对账；对不上先挂起（pending 段不进礁区白化与导出）。
 *
 * 外业表（belts/corals/fishes）在整个流程中从不写入，符合「测绘室改界线失败后只重试界线这侧」。
 */
import { db, createId } from '@/utils/db'
import type { Belt } from '@/types/belt'
import type { BeltSegment, BoundaryRevision, BoundaryVersion, Ring } from '@/types/boundary'
import { cutBeltByReefs, isCrossBoundary, type CutSegment } from '@/utils/geometry'
import { reconcile, verdictToNotices, type FieldCrossReport } from '@/utils/reconcile'

export interface ApplyRevisionInput {
  /** 新版各礁区边界线 reefId -> 外环 */
  reefs: Record<string, Ring>
  note: string
  publishedBy: string
  /** 外业上报的跨界样带（对账用） */
  fieldCrossReports: FieldCrossReport[]
  /** 演示用：在「发布界线」这步注入失败，验证只重试界线侧 */
  failBoundaryPublish?: boolean
}

export interface ApplyRevisionResult {
  version: BoundaryVersion
  revision: BoundaryRevision
  segments: BeltSegment[]
  /** 被新版界线压到、归属发生变化的样带编号 */
  recalculatedBeltNos: string[]
}

/** 当前生效界线版本（Dexie 对布尔索引支持不稳，直接取版本号最大且未失败的一版） */
export async function getActiveBoundaryVersion(): Promise<BoundaryVersion | null> {
  const all = await db.boundaryVersions.toArray()
  const active = all.filter((version) => version.isActive && !version.failed)
  if (active.length > 0) return active.reduce((max, item) => (item.version > max.version ? item : max))
  return all.reduce<BoundaryVersion | null>(
    (max, item) => (max === null || item.version > max.version ? item : max),
    null
  )
}

/**
 * 第 1 步：发布新界线版本（只写界线测绘室表）。
 * 失败时旧版本保持激活，外业数据不受影响，可安全重试本函数。
 */
export async function persistBoundary(input: ApplyRevisionInput): Promise<{ version: BoundaryVersion; revision: BoundaryRevision }> {
  if (input.failBoundaryPublish) {
    throw new Error('界线发布失败：边界线校验未通过（演示注入），外业普查组数据未改动，可只重试界线这侧')
  }

  const now = Date.now()
  const previous = await getActiveBoundaryVersion()
  const nextVersionNo = (previous?.version ?? 0) + 1

  // 旧版本撤活，新版本激活
  if (previous) {
    await db.boundaryVersions.update(previous.id, { isActive: false, updatedAt: now } as never)
  }
  const version: BoundaryVersion = {
    id: createId('bnd'),
    version: nextVersionNo,
    reefs: input.reefs,
    note: input.note,
    isActive: true,
    failed: false,
    publishedBy: input.publishedBy,
    createdAt: now,
    updatedAt: now
  }
  await db.boundaryVersions.put(version)

  const revision: BoundaryRevision = {
    id: createId('rev'),
    boundaryVersionId: version.id,
    version: nextVersionNo,
    state: 'done',
    message: '界线已发布，待重算切段',
    retries: 0,
    affectedBeltNos: [],
    createdAt: now,
    updatedAt: now
  }
  await db.boundaryRevisions.put(revision)
  return { version, revision }
}

/** 标记一次发布失败（不动外业表，只记流水，供「只重试界线侧」演示） */
export async function recordBoundaryFailure(input: ApplyRevisionInput, error: Error): Promise<BoundaryRevision> {
  const now = Date.now()
  const previous = await getActiveBoundaryVersion()
  const nextVersionNo = (previous?.version ?? 0) + 1
  const revision: BoundaryRevision = {
    id: createId('rev'),
    boundaryVersionId: previous?.id ?? '',
    version: nextVersionNo,
    state: 'failed',
    message: error.message,
    retries: 0,
    affectedBeltNos: [],
    createdAt: now,
    updatedAt: now
  }
  await db.boundaryRevisions.put(revision)
  return revision
}

interface SegmentSnapshot {
  beltId: string
  beltNo: string
  reefIds: Array<string | null>
  crossing: boolean
}

function snapshotOf(segments: BeltSegment[]): SegmentSnapshot {
  const ordered = [...segments].sort((a, b) => a.ordinal - b.ordinal)
  const reefIds = ordered.map((segment) => segment.reefId)
  return {
    beltId: segments[0]?.beltId ?? '',
    beltNo: segments[0]?.beltNo ?? '',
    reefIds,
    crossing: new Set(reefIds.filter((id): id is string => id !== null)).size >= 2
  }
}

function sameSnapshot(a: SegmentSnapshot, b: SegmentSnapshot): boolean {
  if (a.reefIds.length !== b.reefIds.length) return false
  return a.reefIds.every((reefId, index) => reefId === b.reefIds[index]) && a.crossing === b.crossing
}

/**
 * 第 2 + 3 步：按新版界线重算切段并对账（只读外业表，写派生表）。
 * 压在旧线上的样带 = 新旧切段归属/跨界状态不一致者，整批重算并记入流水。
 */
export async function recomputeAndReconcile(
  version: BoundaryVersion,
  revision: BoundaryRevision,
  fieldCrossReports: FieldCrossReport[]
): Promise<ApplyRevisionResult> {
  const now = Date.now()
  const [allBelts] = await Promise.all([db.belts.toArray()])

  // 旧版切段快照（按样带），用于识别压在旧线上的样带
  const oldByBelt = new Map<string, BeltSegment[]>()
  const priorVersionId = await previousVersionId(version)
  if (priorVersionId) {
    const priorSegments = await db.beltSegments.where('boundaryVersionId').equals(priorVersionId).toArray()
    priorSegments.forEach((segment) => {
      const list = oldByBelt.get(segment.beltId) ?? []
      list.push(segment)
      oldByBelt.set(segment.beltId, list)
    })
  }

  const reefRings = Object.entries(version.reefs).map(([reefId, ring]) => ({ reefId, ring }))

  // 重算（全部样带；识别被压到的）
  const newSegments: BeltSegment[] = []
  const newByBelt = new Map<string, BeltSegment[]>()
  const recalculatedBeltNos: string[] = []

  allBelts.forEach((belt) => {
    const cut: CutSegment[] = cutBeltByReefs(belt as Belt, reefRings)
    const beltSegments: BeltSegment[] = cut.map((piece) => ({
      id: createId('seg'),
      boundaryVersionId: version.id,
      boundaryVersion: version.version,
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
    newSegments.push(...beltSegments)
    newByBelt.set(belt.id, beltSegments)

    const oldSnapshot = oldByBelt.get(belt.id)
    if (oldSnapshot) {
      if (!sameSnapshot(snapshotOf(oldSnapshot), snapshotOf(beltSegments))) {
        recalculatedBeltNos.push(belt.no)
      }
    } else if (isCrossBoundary(cut)) {
      recalculatedBeltNos.push(belt.no)
    }
  })

  // 两室按样带编号对账
  const reportsByNo = new Map(fieldCrossReports.map((report) => [report.beltNo, report]))
  const verdicts = reconcile(newByBelt, reportsByNo)
  const notices = verdicts.flatMap((verdict) => verdictToNotices(verdict, version.id, now, createId))
  const pendingBeltIds = new Set(verdicts.filter((verdict) => verdict.status === 'pending').map((verdict) => verdict.beltId))
  newSegments.forEach((segment) => {
    if (pendingBeltIds.has(segment.beltId)) {
      segment.status = 'pending'
      if (!segment.reason) segment.reason = '两室按样带编号对账未通过，先挂起'
    }
  })

  // 一次事务落派生表（仍只写界线测绘室表）
  await db.transaction(
    'rw',
    [db.beltSegments, db.boundaryNotices, db.boundaryRevisions],
    async () => {
      await db.beltSegments.bulkPut(newSegments)
      // 清掉旧版对账记录，只保留当前版本（历史版本结论随 boundaryVersion 可回溯几何）
      await db.boundaryNotices.clear()
      await db.boundaryNotices.bulkPut(notices)
      await db.boundaryRevisions.update(revision.id, {
        state: 'done',
        message: `已按 v${version.version} 界线重算 ${recalculatedBeltNos.length} 条压线样带并完成对账`,
        affectedBeltNos: Array.from(new Set(recalculatedBeltNos)),
        updatedAt: now
      } as never)
    }
  )

  return { version, revision: { ...revision, affectedBeltNos: Array.from(new Set(recalculatedBeltNos)) }, segments: newSegments, recalculatedBeltNos: Array.from(new Set(recalculatedBeltNos)) }
}

async function previousVersionId(current: BoundaryVersion): Promise<string | null> {
  const older = await db.boundaryVersions.where('version').below(current.version).toArray()
  if (older.length === 0) return null
  return older.reduce((max, item) => (item.version > max.version ? item : max)).id
}

/**
 * 改线总入口：先发布界线，再重算对账。
 * 发布阶段抛错时由调用方走 retryBoundaryOnly；重算阶段不会改外业数据。
 */
export async function applyBoundaryRevision(input: ApplyRevisionInput): Promise<ApplyRevisionResult> {
  const { version, revision } = await persistBoundary(input)
  return recomputeAndReconcile(version, revision, input.fieldCrossReports)
}

/**
 * 界线发布失败后的重试：只重试界线这侧（去掉注入失败标记），
 * 成功后继续重算；外业普查组底账全程不写。
 */
export async function retryBoundaryOnly(
  lastInput: ApplyRevisionInput,
  failedRevision: BoundaryRevision
): Promise<ApplyRevisionResult> {
  const now = Date.now()
  const cleanInput: ApplyRevisionInput = { ...lastInput, failBoundaryPublish: false }
  const { version, revision } = await persistBoundary(cleanInput)
  await db.boundaryRevisions.update(failedRevision.id, {
    state: 'done',
    retries: failedRevision.retries + 1,
    message: `界线侧重试成功（第 ${failedRevision.retries + 1} 次），已发布 v${version.version}`,
    boundaryVersionId: version.id,
    updatedAt: now
  } as never)
  return recomputeAndReconcile(version, revision, cleanInput.fieldCrossReports)
}
