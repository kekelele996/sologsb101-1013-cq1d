/**
 * 两室对账：界线测绘室（几何切段）与外业普查组（实测起止点上报）按样带编号对账。
 * - 两边都认为跨界、且跨界礁区集合一致 → matched，可入礁区白化与导出。
 * - 只有一边认为跨界、或跨界礁区集合对不上 → pending（先挂着），该样带不进礁区统计。
 * 对账只产出结论，不修改任何外业底账。
 */
import type { BeltSegment, BoundaryNotice, NoticeSide, NoticeStatus } from '@/types/boundary'

/** 外业侧上报的跨界样带（由外业依据实测起止点填报） */
export interface FieldCrossReport {
  beltId: string
  beltNo: string
  startReefId: string | null
  endReefId: string | null
  /** 外业填报备注 */
  detail: string
}

/** 某编号样带在一侧的对账信息 */
interface SideView {
  crossing: boolean
  reefIds: Set<string>
  startReefId: string | null
  endReefId: string | null
  detail: string
}

function sameReefSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

/** 测绘室侧视图：由几何切段结果直接得到 */
function officeViewOf(segments: BeltSegment[]): SideView {
  const reefIds = new Set(
    segments.filter((segment) => segment.reefId !== null).map((segment) => segment.reefId as string)
  )
  const ordered = [...segments].sort((a, b) => a.ordinal - b.ordinal)
  const first = ordered.find((segment) => segment.reefId !== null) ?? null
  const last = [...ordered].reverse().find((segment) => segment.reefId !== null) ?? null
  return {
    crossing: reefIds.size >= 2,
    reefIds,
    startReefId: first?.reefId ?? null,
    endReefId: last?.reefId ?? null,
    detail: `几何切段跨 ${reefIds.size} 个礁区，共 ${segments.length} 段`
  }
}

function fieldViewOf(report: FieldCrossReport | undefined): SideView | null {
  if (!report) return null
  const reefIds = new Set<string>()
  if (report.startReefId) reefIds.add(report.startReefId)
  if (report.endReefId) reefIds.add(report.endReefId)
  return {
    crossing: reefIds.size >= 2,
    reefIds,
    startReefId: report.startReefId,
    endReefId: report.endReefId,
    detail: report.detail
  }
}

/** 一条样带的对账结论（分别给两侧各落一条 notice） */
export interface ReconcileVerdict {
  beltId: string
  beltNo: string
  status: NoticeStatus
  reason: string
  office: SideView
  field: SideView | null
}

/**
 * 对账主函数。
 * @param segmentsByBelt 几何切段：beltId -> 该版下的段
 * @param fieldReportsByNo 外业上报：beltNo -> 上报（只有自报跨界的样带才有）
 */
export function reconcile(
  segmentsByBelt: Map<string, BeltSegment[]>,
  fieldReportsByNo: Map<string, FieldCrossReport>
): ReconcileVerdict[] {
  const beltIdByNo = new Map<string, string>()
  segmentsByBelt.forEach((segments, beltId) => {
    if (segments.length > 0) beltIdByNo.set(segments[0].beltNo, beltId)
  })
  fieldReportsByNo.forEach((report) => beltIdByNo.set(report.beltNo, report.beltId))

  const verdicts: ReconcileVerdict[] = []
  beltIdByNo.forEach((beltId, beltNo) => {
    const segments = segmentsByBelt.get(beltId) ?? []
    const office = officeViewOf(segments)
    const field = fieldViewOf(fieldReportsByNo.get(beltNo))
    const hasPendingSegment = segments.some((segment) => segment.status !== 'matched')

    let status: NoticeStatus
    let reason: string

    if (hasPendingSegment) {
      status = 'pending'
      reason = '存在落在界外或无归属的段，先挂起待测绘室核对界线'
    } else if (office.crossing && field?.crossing && sameReefSet(office.reefIds, field.reefIds)) {
      status = 'matched'
      reason = `两室一致：跨界礁区 ${Array.from(office.reefIds).join('、')}`
    } else if (!office.crossing && !field) {
      // 两边都不认为跨界：无需挂账，跳过（不落 notice）
      return
    } else if (office.crossing && !field) {
      status = 'pending'
      reason = '测绘室几何判为跨界，但外业普查组未上报跨界，待复核起止点'
    } else if (!office.crossing && field?.crossing) {
      status = 'pending'
      reason = '外业上报跨界，但新界线几何切段未跨界，待复核界线或起止点'
    } else {
      status = 'pending'
      reason = `跨界礁区对不上：测绘室 [${Array.from(office.reefIds).join('、')}] / 外业 [${
        field ? Array.from(field.reefIds).join('、') : '—'
      }]`
    }

    verdicts.push({ beltId, beltNo, status, reason, office, field })
  })

  return verdicts
}

/** 由对账结论生成两侧各一条 BoundaryNotice（供写库） */
export function verdictToNotices(
  verdict: ReconcileVerdict,
  boundaryVersionId: string,
  now: number,
  idFactory: (prefix: string) => string
): BoundaryNotice[] {
  const sides: NoticeSide[] = ['office', 'survey']
  return sides.map((side) => {
    const view = side === 'office' ? verdict.office : verdict.field
    return {
      id: idFactory(`ntc_${side}`),
      beltNo: verdict.beltNo,
      side,
      startReefId: view?.startReefId ?? null,
      endReefId: view?.endReefId ?? null,
      reefIds: view ? Array.from(view.reefIds) : [],
      status: verdict.status,
      detail: view?.detail ?? '该侧无记录',
      boundaryVersionId,
      createdAt: now,
      updatedAt: now
    }
  })
}
