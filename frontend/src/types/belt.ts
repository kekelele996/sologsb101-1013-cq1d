/** 样带朝向 */
import type { LngLat } from '@/types/boundary'

export type Orientation = '北' | '东' | '南' | '西'

export const ORIENTATIONS: Orientation[] = ['北', '东', '南', '西']

/** 样带坐标来源：外业实测起止点 / 旧数据升级时按站位坐标补的整段 */
export type BeltGeoSource = 'field' | 'legacy_upgraded'

/** 样带：站位上布设的普查样带（外业普查组管：起止点、珊瑚覆盖、鱼类计数） */
export interface Belt {
  id: string
  /** 所属站位 */
  siteId: string
  /** 样带编号，如 T-01（两室对账键） */
  no: string
  /** 样带长度（m） */
  lengthM: number
  /** 朝向 */
  orientation: Orientation
  /** 调查日期 */
  surveyDate: string
  /** 调查人 */
  observer: string
  /** 起点经纬度（外业普查组测定） */
  startCoord: LngLat | null
  /** 终点经纬度（外业普查组测定） */
  endCoord: LngLat | null
  /** 坐标来源：实测，或旧数据升级时按站位坐标补的整段 */
  geoSource: BeltGeoSource
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
  startLng: number | null
  startLat: number | null
  endLng: number | null
  endLat: number | null
}

export function createEmptyBeltDraft(no = ''): BeltDraft {
  return {
    no,
    lengthM: 50,
    orientation: '北',
    surveyDate: new Date().toISOString().slice(0, 10),
    observer: '',
    startLng: null,
    startLat: null,
    endLng: null,
    endLat: null
  }
}

/** 常用样带长度预设（m） */
export const BELT_LENGTH_PRESETS: number[] = [10, 20, 25, 50, 100]
