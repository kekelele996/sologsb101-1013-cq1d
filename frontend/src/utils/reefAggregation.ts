/**
 * 礁区级白化与覆盖聚合（唯一口径，页面 store 与 JSON 导出共用）。
 * 跨界样带的珊瑚覆盖与鱼类计数按 utils/allocation 的段长比例切片计入各礁区；
 * 跨界挂账样带不计入任何一侧，避免两边白化指数一高一低对不上。
 */
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord, BleachLevel } from '@/types/coralRecord'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import { bleachGrade, bleachIndex, round } from '@/utils/bleach'
import { splitBeltRecords } from '@/utils/allocation'

export interface ReefAggregation {
  reefId: string
  siteCount: number
  beltCount: number
  /** 计入本礁区的样带数（跨界样带按切片计 1 次，挂账跨界样带计 0） */
  countedBeltCount: number
  coralCount: number
  /** 分摊后的覆盖长度合计（cm） */
  coverCmTotal: number
  /** 段长加权白化指数：把全部切片记录放一起按覆盖长度加权 */
  bleachIndex: number
  grade: BleachLevel
  fishTotal: number
  invertebrateTotal: number
  /** 本礁区计入的样带段长合计（m） */
  countedSegmentLengthM: number
  /** 压界但挂账、未计入的样带编号 */
  pendingBeltNos: string[]
  distribution: Record<BleachLevel, number>
}

/**
 * 计算一个礁区的白化聚合。
 * 输入该礁区站位下的样带（含跨界样带：其分段里也会带上本礁区）。
 */
export function aggregateReef(params: {
  reef: Reef
  sites: Site[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
}): ReefAggregation {
  const { reef, sites, belts, corals, fishes } = params
  const siteIds = new Set(sites.filter((site) => site.reefId === reef.id).map((site) => site.id))
  // 压到本礁区的样带 = 起点站位在本礁区，或跨界分段里带本礁区
  const touchedBelts = belts.filter(
    (belt) => siteIds.has(belt.siteId) || belt.segments.some((segment) => segment.reefId === reef.id)
  )
  const coralsByBelt = new Map<string, CoralRecord[]>()
  corals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })
  const fishesByBelt = new Map<string, FishCount[]>()
  fishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })

  const slicedCorals: Array<{ coverCm: number; bleachLevel: BleachLevel }> = []
  let fishTotal = 0
  let invertebrateTotal = 0
  let countedSegmentLengthM = 0
  let countedBeltCount = 0
  const pendingBeltNos: string[] = []

  touchedBelts.forEach((belt) => {
    const slices = splitBeltRecords(
      belt,
      coralsByBelt.get(belt.id) ?? [],
      fishesByBelt.get(belt.id) ?? []
    )
    const mine = slices.find((slice) => slice.reefId === reef.id)
    const crossReef = slices.length > 1 || new Set(belt.segments.map((s) => s.reefId)).size > 1
    if (!mine) {
      if (crossReef && belt.settleStatus === 'pending') pendingBeltNos.push(belt.no)
      return
    }
    countedBeltCount += 1
    countedSegmentLengthM = round(countedSegmentLengthM + mine.segmentLengthM, 2)
    slicedCorals.push(...mine.corals)
    fishTotal = round(fishTotal + mine.fish, 1)
    invertebrateTotal = round(invertebrateTotal + mine.invertebrate, 1)
  })

  const index = bleachIndex(slicedCorals)
  const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
  BLEACH_LEVELS.forEach((level) => {
    distribution[level] = round(
      slicedCorals
        .filter((record) => record.bleachLevel === level)
        .reduce((sum, record) => sum + record.coverCm, 0),
      1
    )
  })

  // 珊瑚记录条数按分摊比例折算为等效条数（仅展示用）
  const coralCount = round(
    touchedBelts.reduce((sum, belt) => {
      const mineShare = belt.segments
        .filter((segment) => segment.reefId === reef.id)
        .reduce((acc, segment) => acc + (belt.lengthM > 0 ? segment.lengthM / belt.lengthM : 0), 0)
      return sum + (coralsByBelt.get(belt.id)?.length ?? 0) * mineShare
    }, 0),
    1
  )

  return {
    reefId: reef.id,
    siteCount: sites.filter((site) => site.reefId === reef.id).length,
    beltCount: touchedBelts.length,
    countedBeltCount,
    coralCount,
    coverCmTotal: round(
      slicedCorals.reduce((sum, record) => sum + record.coverCm, 0),
      1
    ),
    bleachIndex: index,
    grade: bleachGrade(index),
    fishTotal,
    invertebrateTotal,
    countedSegmentLengthM,
    pendingBeltNos: Array.from(new Set(pendingBeltNos)),
    distribution
  }
}

/** 全部礁区聚合（保持礁区台账顺序） */
export function aggregateAllReefs(params: {
  reefs: Reef[]
  sites: Site[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
}): ReefAggregation[] {
  return params.reefs.map((reef) => aggregateReef({ ...params, reef }))
}
