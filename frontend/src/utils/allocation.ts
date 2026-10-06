/**
 * 跨礁区分摊口径（唯一口径，礁区白化评定与导出共用）：
 * 珊瑚覆盖长度与鱼类计数按样带在各礁区内的段长占整条长度的比例分摊。
 * - 已对平（settled）的跨界样带：各礁区只拿自己段长比例内的覆盖长度 / 计数，
 *   白化指数在分摊后的覆盖长度上重新加权。
 * - 对不上（pending）且确实跨界的样带：先挂着，不进入任何一侧礁区的白化评定，
 *   避免两边口径不一致；待外业补正后重算。
 * - 只压在一个礁区内的样带（含旧数据升级的整段样带）：比例为 1，整条归该礁区。
 */
import type { Belt, BeltSegment } from '@/types/belt'
import type { BleachLevel, CoralRecord } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import { round } from '@/utils/bleach'

/** 样带在某礁区内的合并段长（同一礁区可能被切成多段） */
export function segmentLengthOfReef(belt: Belt, reefId: string): number {
  return round(
    belt.segments.filter((segment) => segment.reefId === reefId).reduce((sum, segment) => sum + segment.lengthM, 0),
    2
  )
}

/** 段长占整条样带长度的比例（0 ~ 1） */
export function segmentShare(belt: Belt, reefId: string): number {
  if (belt.lengthM <= 0) return 0
  return round(segmentLengthOfReef(belt, reefId) / belt.lengthM, 6)
}

/** 样带压到的礁区（按从起点方向首次出现的顺序） */
export function reefIdsOfBelt(belt: Belt): string[] {
  const ids: string[] = []
  belt.segments.forEach((segment) => {
    if (!ids.includes(segment.reefId)) ids.push(segment.reefId)
  })
  return ids
}

/** 样带分摊给各礁区的切片：覆盖长度与计数已按段长比例缩放 */
export interface ReefSlice {
  reefId: string
  /** 该礁区内的段长合计（m） */
  segmentLengthM: number
  /** 段长占比（0 ~ 1） */
  share: number
  /** 分摊后的珊瑚记录（覆盖长度按比例缩放，白化等级不变） */
  corals: Array<{ coverCm: number; bleachLevel: BleachLevel }>
  /** 分摊后的鱼类计数（尾，可为小数） */
  fish: number
  /** 分摊后的无脊椎动物计数（个，可为小数） */
  invertebrate: number
}

/**
 * 把一条样带的珊瑚记录与鱼类计数按段长拆给各礁区。
 * 跨界且挂账的样带返回空数组（不进任何一侧礁区汇总）。
 */
export function splitBeltRecords(
  belt: Belt,
  beltCorals: CoralRecord[],
  beltFishes: FishCount[]
): ReefSlice[] {
  const grouped = new Map<string, BeltSegment[]>()
  belt.segments.forEach((segment) => {
    const list = grouped.get(segment.reefId) ?? []
    list.push(segment)
    grouped.set(segment.reefId, list)
  })
  const reefIds = reefIdsOfBelt(belt)
  const crossReef = reefIds.length > 1
  if (crossReef && belt.settleStatus === 'pending') return []

  return reefIds.map((reefId) => {
    const share = segmentShare(belt, reefId)
    const corals = beltCorals.map((record) => ({
      coverCm: round(record.coverCm * share, 1),
      bleachLevel: record.bleachLevel
    }))
    const fish = round(
      beltFishes.filter((item) => item.category === '鱼类').reduce((sum, item) => sum + item.count, 0) * share,
      1
    )
    const invertebrate = round(
      beltFishes
        .filter((item) => item.category === '无脊椎动物')
        .reduce((sum, item) => sum + item.count, 0) * share,
      1
    )
    return { reefId, segmentLengthM: segmentLengthOfReef(belt, reefId), share, corals, fish, invertebrate }
  })
}
