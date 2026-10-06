/**
 * 界线测绘室 store：管礁区边界线版本、几何切段、两室对账与改线流水。
 * 外业普查组底账（belts/corals/fishes）本 store 只读不写；
 * 改界线走 utils/boundaryWorkflow，发布失败只重试界线这侧。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, watchTable } from '@/utils/db'
import type { BeltSegment, BoundaryNotice, BoundaryRevision, BoundaryVersion, Ring } from '@/types/boundary'
import {
  applyBoundaryRevision,
  getActiveBoundaryVersion,
  recordBoundaryFailure,
  retryBoundaryOnly
} from '@/utils/boundaryWorkflow'
import { allocate, type AllocationResult } from '@/utils/allocation'
import type { FieldCrossReport } from '@/utils/reconcile'
import { readFieldCrossReports, writeFieldCrossReports } from '@/utils/export'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'

/** 改线动作的演示入参（从页面表单构造） */
export interface PublishOptions {
  reefs: Record<string, Ring>
  note: string
  publishedBy: string
  fieldCrossReports: FieldCrossReport[]
  failBoundaryPublish?: boolean
}

export const useBoundaryStore = defineStore('boundary', () => {
  const versions = ref<BoundaryVersion[]>([])
  const segments = ref<BeltSegment[]>([])
  const notices = ref<BoundaryNotice[]>([])
  const revisions = ref<BoundaryRevision[]>([])
  const fieldReports = ref<FieldCrossReport[]>([])
  const ready = ref(false)
  const busy = ref(false)
  const message = ref<string | null>(null)
  const error = ref<string | null>(null)
  /** 最近一次发布失败的入参与流水（供「只重试界线侧」） */
  const lastFailed = ref<{ input: PublishOptions; revision: BoundaryRevision } | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<BoundaryVersion>(() => db.boundaryVersions).subscribe((rows) => {
      versions.value = rows
      ready.value = true
    })
    watchTable<BeltSegment>(() => db.beltSegments).subscribe((rows) => {
      segments.value = rows
    })
    watchTable<BoundaryNotice>(() => db.boundaryNotices).subscribe((rows) => {
      notices.value = rows
    })
    watchTable<BoundaryRevision>(() => db.boundaryRevisions).subscribe((rows) => {
      revisions.value = rows
    })
    fieldReports.value = readFieldCrossReports()
  }

  const activeVersion = computed<BoundaryVersion | null>(
    () => versions.value.find((version) => version.isActive) ?? versions.value[0] ?? null
  )

  /** 当前激活版本下的切段 */
  const activeSegments = computed<BeltSegment[]>(() =>
    activeVersion.value ? segments.value.filter((segment) => segment.boundaryVersionId === activeVersion.value!.id) : []
  )

  /** 按样带聚合当前版本切段 */
  const segmentsByBelt = computed<Map<string, BeltSegment[]>>(() => {
    const map = new Map<string, BeltSegment[]>()
    activeSegments.value.forEach((segment) => {
      const list = map.get(segment.beltId) ?? []
      list.push(segment)
      map.set(segment.beltId, list)
    })
    map.forEach((list) => list.sort((a, b) => a.ordinal - b.ordinal))
    return map
  })

  /** 当前版本的分摊结果（礁区白化与导出共用同一口径） */
  const allocation = computed<AllocationResult | null>(() => {
    const reefStore = useReefStore()
    const beltStore = useBeltStore()
    const surveyStore = useSurveyStore()
    if (!activeVersion.value || !reefStore.ready || !beltStore.ready) return null
    return allocate({
      boundaryVersion: activeVersion.value,
      segments: activeSegments.value,
      reefs: reefStore.reefs,
      sites: reefStore.sites,
      belts: beltStore.belts,
      corals: surveyStore.corals,
      fishes: surveyStore.fishes
    })
  })

  /** 样带 id -> 该样带的对账状态（取两侧中较「严重」者） */
  const noticeStatusByBeltNo = computed<Map<string, BoundaryNotice['status']>>(() => {
    const rank: Record<BoundaryNotice['status'], number> = { pending: 2, matched: 1, resolved: 0 }
    const map = new Map<string, BoundaryNotice['status']>()
    notices.value
      .filter((notice) => !activeVersion.value || notice.boundaryVersionId === activeVersion.value.id)
      .forEach((notice) => {
        const current = map.get(notice.beltNo)
        if (!current || rank[notice.status] > rank[current]) map.set(notice.beltNo, notice.status)
      })
    return map
  })

  function segmentsOfBelt(beltId: string): BeltSegment[] {
    return segmentsByBelt.value.get(beltId) ?? []
  }

  function noticeOfBeltNo(beltNo: string): BoundaryNotice[] {
    return notices.value.filter((notice) => notice.beltNo === beltNo)
  }

  /** 持久化外业跨界上报（随后应触发改线重算以重新对账） */
  function saveFieldReports(reports: FieldCrossReport[]): void {
    fieldReports.value = reports
    writeFieldCrossReports(reports)
  }

  /** 发布新版界线并自动重算对账；发布失败时记录失败，外业数据不动 */
  async function publishRevision(options: PublishOptions): Promise<AllocationResult | null> {
    busy.value = true
    error.value = null
    message.value = null
    try {
      saveFieldReports(options.fieldCrossReports)
      const result = await applyBoundaryRevision(options)
      message.value = `界线 v${result.version.version} 已发布，重算压线样带 ${result.recalculatedBeltNos.length} 条：${
        result.recalculatedBeltNos.join('、') || '无'
      }`
      lastFailed.value = null
      return allocation.value
    } catch (err) {
      const failure = err instanceof Error ? err : new Error('界线发布失败')
      error.value = failure.message
      const revision = await recordBoundaryFailure(options, failure)
      lastFailed.value = { input: options, revision }
      return null
    } finally {
      busy.value = false
    }
  }

  /** 界线发布失败后：只重试界线这侧，成功后重算；不触碰外业表 */
  async function retryFailedBoundary(): Promise<AllocationResult | null> {
    if (!lastFailed.value) {
      error.value = '没有待重试的界线发布失败记录'
      return null
    }
    busy.value = true
    try {
      const result = await retryBoundaryOnly(lastFailed.value.input, lastFailed.value.revision)
      message.value = `界线侧重试成功：v${result.version.version} 已发布并重算 ${result.recalculatedBeltNos.length} 条压线样带`
      lastFailed.value = null
      error.value = null
      return allocation.value
    } catch (err) {
      error.value = err instanceof Error ? err.message : '界线侧重试仍失败'
      return null
    } finally {
      busy.value = false
    }
  }

  /** 切换到历史界线版本（只改激活标记，派生段沿用该版本已算好的结果） */
  async function activateVersion(versionId: string): Promise<void> {
    const target = versions.value.find((item) => item.id === versionId)
    if (!target || target.failed) return
    busy.value = true
    try {
      await db.transaction('rw', [db.boundaryVersions], async () => {
        await db.boundaryVersions.toCollection().modify((version: BoundaryVersion) => {
          version.isActive = version.id === versionId
          version.updatedAt = Date.now()
        })
      })
      message.value = `已切换到界线 v${target.version}`
    } finally {
      busy.value = false
    }
  }

  async function refreshActive(): Promise<BoundaryVersion | null> {
    return getActiveBoundaryVersion()
  }

  return {
    versions,
    segments,
    notices,
    revisions,
    fieldReports,
    ready,
    busy,
    message,
    error,
    lastFailed,
    activeVersion,
    activeSegments,
    segmentsByBelt,
    allocation,
    noticeStatusByBeltNo,
    start,
    segmentsOfBelt,
    noticeOfBeltNo,
    saveFieldReports,
    publishRevision,
    retryFailedBoundary,
    activateVersion,
    refreshActive
  }
})
