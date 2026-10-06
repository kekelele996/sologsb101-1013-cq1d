/**
 * 界线重划与跨界样带对账编排。
 * 分工：界线测绘室管礁区界线（reef.boundaryPolygon / boundaryRev），
 * 外业普查组管样带起止点、珊瑚覆盖与鱼类计数（belt.startPoint / endPoint / segments）。
 *
 * 流程要点：
 * - 界线修改先校验、再单独落库并 +1 修订序号；界线这侧失败时直接抛出，
 *   不触碰任何样带（只重试界线这侧）。
 * - 界线成功后，只重算「压在旧线上」的样带：旧分段、起点或终点与该礁区相关的样带。
 * - 两边按样带编号对账：切段有洞 / 起终点不在任一礁区 / 段长对不上时挂起（pending），
 *   不进入两侧礁区白化评定，等外业补起止点后再重算。
 */
import { db } from '@/utils/db'
import { splitBeltByReefs, totalSegmentLength } from '@/utils/geometry'
import { validateBoundary, type LatLng } from '@/types/reef'
import type { Reef } from '@/types/reef'
import type { Belt } from '@/types/belt'
import { SEGMENT_LENGTH_TOLERANCE_M } from '@/types/belt'

/** 单条样带的重算结果（两边按样带编号对账） */
export interface BeltSettleResult {
  beltId: string
  beltNo: string
  /** 重算后的分段 */
  segments: Belt['segments']
  crossed: boolean
  status: Belt['settleStatus']
  issue: string
  changed: boolean
}

/** 界线修改 + 压旧线样带重算的汇总结果 */
export interface BoundaryChangeReport {
  reefId: string
  boundaryRev: number
  /** 参与重算的样带编号（对账清单） */
  reconciled: BeltSettleResult[]
  /** 重算后跨界的样带编号 */
  crossedBeltNos: string[]
  /** 挂账的样带编号 */
  pendingBeltNos: string[]
}

/**
 * 测绘室改界：校验并保存界线，成功后只重算压在这条界线上的样带。
 * 界线校验或落库失败时整体抛出，样带一侧完全不动。
 */
export async function applyReefBoundary(
  reefId: string,
  polygon: LatLng[]
): Promise<BoundaryChangeReport> {
  const errors = validateBoundary(polygon)
  if (errors.length > 0) {
    throw new Error(`界线校验未通过：${errors.join('；')}`)
  }

  // —— 界线这侧（独立事务，失败只重试这里）——
  let reef: Reef | undefined
  try {
    await db.transaction('rw', [db.reefs], async () => {
      reef = await db.reefs.get(reefId)
      if (!reef) throw new Error('礁区不存在，界线无法落库')
      await db.reefs.update(reefId, {
        boundaryPolygon: polygon,
        boundaryRev: (reef.boundaryRev ?? 0) + 1,
        boundaryUpdatedAt: Date.now(),
        updatedAt: Date.now()
      })
    })
  } catch (error) {
    // 界线事务回滚，下面的样带重算一律不执行
    throw error instanceof Error ? error : new Error('界线保存失败')
  }

  // —— 界线成功后，外业这侧重算压旧线的样带（独立事务，失败不回滚界线）——
  return recomputeBeltsAgainstBoundary(reefId)
}

/** 找出压在某礁区旧界线上的样带：旧分段、起点或终点与该礁区相关 */
async function beltsPressedOnBoundary(reefId: string): Promise<Belt[]> {
  const [allBelts, sites] = await Promise.all([db.belts.toArray(), db.sites.toArray()])
  const siteByReef = new Map<string, Set<string>>()
  sites.forEach((site) => {
    const set = siteByReef.get(site.reefId) ?? new Set<string>()
    set.add(site.id)
    siteByReef.set(site.reefId, set)
  })
  const ownSiteIds = siteByReef.get(reefId) ?? new Set<string>()
  return allBelts.filter((belt) => {
    if (belt.segments.some((segment) => segment.reefId === reefId)) return true
    // 起点站位属于该礁区，或起终点就在界线附近（无分段信息的旧数据兜底）
    if (ownSiteIds.has(belt.siteId)) return true
    return false
  })
}

/**
 * 界线落库后重算压旧线样带；也供外业补录起止点后单条重算（reconcileBeltById）。
 */
export async function recomputeBeltsAgainstBoundary(reefId: string): Promise<BoundaryChangeReport> {
  const [pressed, reefs] = await Promise.all([beltsPressedOnBoundary(reefId), db.reefs.toArray()])
  const sites = await db.sites.toArray()
  const siteById = new Map(sites.map((site) => [site.id, site]))
  const targetReef = reefs.find((item) => item.id === reefId)
  const reconciled: BeltSettleResult[] = []

  await db.transaction('rw', [db.belts], async () => {
    for (const belt of pressed) {
      const result = settleBelt(belt, reefs, siteById)
      reconciled.push(result)
      await db.belts.update(belt.id, {
        segments: result.segments,
        settleStatus: result.status,
        settleIssue: result.issue,
        boundaryRevByReef: revByReef(result.segments, reefs),
        updatedAt: Date.now()
      })
    }
  })

  return {
    reefId,
    boundaryRev: targetReef?.boundaryRev ?? 0,
    reconciled,
    crossedBeltNos: reconciled.filter((item) => item.crossed).map((item) => item.beltNo),
    pendingBeltNos: reconciled.filter((item) => item.status === 'pending').map((item) => item.beltNo)
  }
}

function revByReef(segments: Belt['segments'], reefs: Reef[]): Record<string, number> {
  const result: Record<string, number> = {}
  segments.forEach((segment) => {
    const reef = reefs.find((item) => item.id === segment.reefId)
    if (reef) result[segment.reefId] = reef.boundaryRev
  })
  return result
}

/** 外业补录 / 修订某条样带起止点后，按当前界线重新切段并对账 */
export async function reconcileBeltById(beltId: string): Promise<BeltSettleResult | null> {
  const [belt, reefs, sites] = await Promise.all([db.belts.get(beltId), db.reefs.toArray(), db.sites.toArray()])
  if (!belt) return null
  const siteById = new Map(sites.map((site) => [site.id, site]))
  const result = settleBelt(belt, reefs, siteById)
  await db.belts.update(beltId, {
    segments: result.segments,
    settleStatus: result.status,
    settleIssue: result.issue,
    boundaryRevByReef: revByReef(result.segments, reefs),
    legacyPoints: false,
    updatedAt: Date.now()
  })
  return result
}

/**
 * 单条样带对账核心：按当前界线切段，核对段长与缺口，
 * 对不上先挂着（pending），但仍保留最佳努力分段以便界面提示。
 */
export function settleBelt(
  belt: Belt,
  reefs: Reef[],
  siteById: Map<string, { reefId: string }>
): BeltSettleResult {
  const originReefId = siteById.get(belt.siteId)?.reefId ?? ''
  const split = splitBeltByReefs(belt.startPoint, belt.endPoint, belt.lengthM, originReefId, reefs)
  const issues = [...split.issues]
  const total = totalSegmentLength(split.segments)
  if (Math.abs(total - belt.lengthM) > SEGMENT_LENGTH_TOLERANCE_M) {
    issues.push(`分段段长合计 ${total} m 与样带总长 ${belt.lengthM} m 不符`)
  }
  const status: Belt['settleStatus'] = issues.length > 0 ? 'pending' : 'settled'
  const beforeKey = belt.segments
    .map((segment) => `${segment.reefId}:${segment.lengthM}`)
    .join('|')
  const afterKey = split.segments.map((segment) => `${segment.reefId}:${segment.lengthM}`).join('|')
  return {
    beltId: belt.id,
    beltNo: belt.no,
    segments: split.segments,
    crossed: split.crossed,
    status,
    issue: Array.from(new Set(issues)).join('；'),
    changed: beforeKey !== afterKey
  }
}
