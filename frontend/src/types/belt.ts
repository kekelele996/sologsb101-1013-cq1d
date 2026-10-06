import type { LatLng } from '@/types/reef'

/** 样带朝向 */
export type Orientation = '北' | '东' | '南' | '西'

export const ORIENTATIONS: Orientation[] = ['北', '东', '南', '西']

/**
 * 珊瑚覆盖与鱼类计数的跨礁区分摊口径。
 * - prorate：按段长在各礁区间分摊（唯一口径，礁区白化评定与导出共用）
 * - origin：整条留给起点所在礁区（历史归档口径，仅旧数据展示，不参与礁区统计）
 */
export type AllocationMode = 'prorate' | 'origin'

export const ALLOCATION_MODES: AllocationMode[] = ['prorate', 'origin']

export const ALLOCATION_LABELS: Record<AllocationMode, string> = {
  prorate: '按段长分摊',
  origin: '整条归起点礁区（历史口径）'
}

/**
 * 样带跨界对账状态（外业普查组按样带编号与测绘室界线对账）。
 * - settled：样带起止点、分段与界线对得上，已按段长重算
 * - pending：按编号两边对不上（缺起止点 / 找不到落点礁区 / 段长合计与总长不符），先挂着
 */
export type BeltSettleStatus = 'settled' | 'pending'

/** 样带在单个礁区内的分段（界线两侧各一段，按段长分摊覆盖与计数） */
export interface BeltSegment {
  /** 落入的礁区 id */
  reefId: string
  /** 段长（m） */
  lengthM: number
}

/** 样带：站位上布设的普查样带；起止点与跨区分段由外业普查组维护 */
export interface Belt {
  id: string
  /** 所属站位（起点所在站位，整条样带仍挂在起点站位下） */
  siteId: string
  /** 样带编号，如 T-01；跨礁区对账按该编号匹配 */
  no: string
  /** 样带长度（m） */
  lengthM: number
  /** 朝向 */
  orientation: Orientation
  /** 调查日期 */
  surveyDate: string
  /** 调查人 */
  observer: string
  /** 起点坐标（外业普查组） */
  startPoint: LatLng
  /** 终点坐标（外业普查组） */
  endPoint: LatLng
  /** 旧数据升级时按站位坐标补的整段样带，起止点重合于站位 */
  legacyPoints: boolean
  /** 按界线切出的各礁区分段；pending 或未跨界时为单段整段 */
  segments: BeltSegment[]
  /** 珊瑚覆盖 / 鱼类计数的礁区分摊口径 */
  allocationMode: AllocationMode
  /** 跨界对账状态 */
  settleStatus: BeltSettleStatus
  /** 挂账原因（对不上时记录，便于两边核对） */
  settleIssue: string
  /** 本次分段所依据的界线修订序号（按礁区记录，界线再改时据此找出压旧线的样带） */
  boundaryRevByReef: Record<string, number>
  createdAt: number
  updatedAt: number
}

/** 样带布设草稿（存于 beltStore） */
export interface BeltDraft {
  no: string
  lengthM: number
  orientation: Orientation
  surveyDate: string
  observer: string
  startPoint: LatLng
  endPoint: LatLng
}

export function createEmptyBeltDraft(no = ''): BeltDraft {
  const today = new Date().toISOString().slice(0, 10)
  const point = { lat: 0, lng: 0 }
  return {
    no,
    lengthM: 50,
    orientation: '北',
    surveyDate: today,
    observer: '',
    startPoint: { ...point },
    endPoint: { ...point }
  }
}

/** 常用样带长度预设（m） */
export const BELT_LENGTH_PRESETS: number[] = [10, 20, 25, 50, 100]

/** 段长合计与样带总长允许的误差（m），超出即对账不符、挂账 */
export const SEGMENT_LENGTH_TOLERANCE_M = 0.5

/** 判断一条样带是否压在界线两侧（跨两个及以上礁区） */
export function isCrossReefBelt(belt: Belt): boolean {
  return new Set(belt.segments.map((segment) => segment.reefId)).size > 1
}
