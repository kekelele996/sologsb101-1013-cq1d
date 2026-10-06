/**
 * 样带 store：维护样带布设草稿、朝向排序与站位下的样带列表。
 * 样带按朝向顺序（北→东→南→西）再按编号排序，便于外业按方向逐条普查。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Belt, BeltDraft, Orientation } from '@/types/belt'
import { ORIENTATIONS, createEmptyBeltDraft } from '@/types/belt'
import type { LatLng } from '@/types/reef'
import { reconcileBeltById, settleBelt, type BeltSettleResult } from '@/utils/boundarySettle'

/** 朝向排序权重：北 → 东 → 南 → 西 */
export const ORIENTATION_ORDER: Record<Orientation, number> = {
  北: 0,
  东: 1,
  南: 2,
  西: 3
}

export const useBeltStore = defineStore('belt', () => {
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const currentBeltId = ref<string | null>(null)
  const draft = ref<BeltDraft>(createEmptyBeltDraft())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
      ready.value = true
      error.value = null
    })
  }

  /** 某站位下的样带：先按朝向（北→东→南→西）再按编号排序 */
  function beltsOfSite(siteId: string | null | undefined): Belt[] {
    if (!siteId) return []
    return belts.value
      .filter((belt) => belt.siteId === siteId)
      .sort((a, b) => {
        const orderDiff = ORIENTATION_ORDER[a.orientation] - ORIENTATION_ORDER[b.orientation]
        if (orderDiff !== 0) return orderDiff
        return a.no.localeCompare(b.no, 'zh-Hans-CN')
      })
  }

  const currentBelt = computed<Belt | null>(
    () => belts.value.find((belt) => belt.id === currentBeltId.value) ?? null
  )

  /** 站位 id → 样带数与总长度 */
  const siteBeltStats = computed<Record<string, { count: number; totalLengthM: number }>>(() => {
    const stats: Record<string, { count: number; totalLengthM: number }> = {}
    belts.value.forEach((belt) => {
      const bucket = stats[belt.siteId] ?? { count: 0, totalLengthM: 0 }
      bucket.count += 1
      bucket.totalLengthM += belt.lengthM
      stats[belt.siteId] = bucket
    })
    return stats
  })

  /** 挂账样带（两边按编号对账对不上，先挂着不进礁区白化评定） */
  const pendingBelts = computed<Belt[]>(() => belts.value.filter((belt) => belt.settleStatus === 'pending'))

  /** 压在两个及以上礁区的跨界样带 */
  const crossReefBelts = computed<Belt[]>(() => {
    const cross = (belt: Belt): boolean => new Set(belt.segments.map((segment) => segment.reefId)).size > 1
    return belts.value.filter(cross)
  })

  /** 某条样带在各礁区的分段（挂账 / 跨界提示用） */
  function segmentsOfBelt(beltId: string | null | undefined): Belt['segments'] {
    const belt = belts.value.find((item) => item.id === beltId)
    return belt ? belt.segments : []
  }

  /** 朝向分布统计（按样带条数） */
  const orientationStats = computed<Record<Orientation, number>>(() => {
    const stats: Record<Orientation, number> = { 北: 0, 东: 0, 南: 0, 西: 0 }
    belts.value.forEach((belt) => {
      stats[belt.orientation] += 1
    })
    return stats
  })

  /** 朝向排序校验：同一站位内朝向 + 编号重复时返回提示 */
  function findBeltConflicts(siteId: string | null | undefined): string[] {
    if (!siteId) return []
    const seen = new Map<string, string>()
    const conflicts: string[] = []
    beltsOfSite(siteId).forEach((belt) => {
      const key = `${belt.orientation}-${belt.no}`
      if (seen.has(key)) conflicts.push(`${belt.orientation}向 ${belt.no}`)
      else seen.set(key, belt.id)
    })
    return conflicts
  }

  function resetDraft(no = ''): void {
    draft.value = createEmptyBeltDraft(no)
  }

  function selectBelt(id: string | null): void {
    currentBeltId.value = id
  }

  function beltById(id: string | null | undefined): Belt | null {
    if (!id) return null
    return belts.value.find((belt) => belt.id === id) ?? null
  }

  /** 新建样带时按当前界线切段；取不到界线信息时整段先挂在起点礁区 */
  async function initialSegments(
    siteId: string,
    startPoint: LatLng,
    endPoint: LatLng,
    lengthM: number
  ): Promise<Pick<Belt, 'segments' | 'settleStatus' | 'settleIssue' | 'boundaryRevByReef'>> {
    const [site, reefs, sites] = await Promise.all([db.sites.get(siteId), db.reefs.toArray(), db.sites.toArray()])
    if (!site) {
      return { segments: [], settleStatus: 'pending', settleIssue: '站位不存在', boundaryRevByReef: {} }
    }
    const probe: Belt = {
      id: '__probe__',
      siteId,
      no: '',
      lengthM,
      orientation: '北',
      surveyDate: '',
      observer: '',
      startPoint,
      endPoint,
      legacyPoints: false,
      segments: [],
      allocationMode: 'prorate',
      settleStatus: 'settled',
      settleIssue: '',
      boundaryRevByReef: {},
      createdAt: 0,
      updatedAt: 0
    }
    const result = settleBelt(probe, reefs, new Map(sites.map((item) => [item.id, { reefId: item.reefId }])))
    const revByReef: Record<string, number> = {}
    result.segments.forEach((segment) => {
      const reef = reefs.find((item) => item.id === segment.reefId)
      if (reef) revByReef[segment.reefId] = reef.boundaryRev
    })
    return {
      segments: result.segments,
      settleStatus: result.status,
      settleIssue: result.issue,
      boundaryRevByReef: revByReef
    }
  }

  async function createBelt(
    siteId: string,
    payload: Omit<Belt, 'id' | 'createdAt' | 'updatedAt' | 'siteId' | 'segments' | 'settleStatus' | 'settleIssue' | 'boundaryRevByReef' | 'legacyPoints' | 'allocationMode'>
  ): Promise<Belt> {
    const now = Date.now()
    const settled = await initialSegments(siteId, payload.startPoint, payload.endPoint, payload.lengthM)
    const row: Belt = {
      ...payload,
      ...settled,
      allocationMode: 'prorate',
      legacyPoints: false,
      siteId,
      id: createId('belt'),
      createdAt: now,
      updatedAt: now
    }
    await db.belts.put(row)
    return row
  }

  /** 外业补录 / 修订起止点后按当前界线重新切段对账 */
  async function reconcileBelt(id: string): Promise<BeltSettleResult | null> {
    return reconcileBeltById(id)
  }

  async function updateBelt(id: string, patch: Partial<Belt>): Promise<void> {
    const affectsSegments =
      'startPoint' in patch || 'endPoint' in patch || 'lengthM' in patch || 'siteId' in patch
    await db.belts.update(id, { ...patch, updatedAt: Date.now() } as never)
    // 起止点或长度一变，分段与对账状态必须按当前界线重算，保持与礁区白化同一口径
    if (affectsSegments) await reconcileBeltById(id)
  }

  /** 删除样带：级联删除其珊瑚记录与鱼类计数 */
  async function removeBelt(id: string): Promise<void> {
    await db.transaction('rw', [db.belts, db.corals, db.fishes], async () => {
      await db.corals.where('beltId').equals(id).delete()
      await db.fishes.where('beltId').equals(id).delete()
      await db.belts.delete(id)
    })
    if (currentBeltId.value === id) selectBelt(null)
  }

  /** 批量改写朝向（同站位多条样带统一方向） */
  async function bulkSetOrientation(ids: string[], orientation: Orientation): Promise<number> {
    const now = Date.now()
    await db.belts
      .where('id')
      .anyOf(ids)
      .modify((belt) => {
        belt.orientation = orientation
        belt.updatedAt = now
      })
    return ids.length
  }

  return {
    belts,
    ready,
    error,
    currentBeltId,
    currentBelt,
    draft,
    siteBeltStats,
    orientationStats,
    start,
    beltsOfSite,
    findBeltConflicts,
    resetDraft,
    selectBelt,
    beltById,
    createBelt,
    updateBelt,
    reconcileBelt,
    removeBelt,
    bulkSetOrientation,
    pendingBelts,
    crossReefBelts,
    segmentsOfBelt,
    orientations: ORIENTATIONS
  }
})
