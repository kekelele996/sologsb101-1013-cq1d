/**
 * 界线测绘室侧数据模型：
 * - LngLat 经纬度坐标点、Ring 礁区面（简单多边形外环）
 * - BoundaryVersion 界线版本（测绘室管：某一版下各礁区的边界线）
 * - BeltSegment 派生段（一次界线版本下，样带被各礁区边界切成的段，按段长分摊口径）
 * - BoundaryNotice 两室对账记录（按样带编号）
 * - BoundaryRevision 界线改线动作流水（重算/重试/回滚均只动界线这侧）
 */

/** 经纬度点：[经度, 纬度] */
export type LngLat = [number, number]

/** 礁区边界线：简单多边形外环，首尾不要求重合（判定时自动闭合） */
export type Ring = LngLat[]

/** 界线版本：测绘室每改一次线产生一版；isActive 为当前生效版本 */
export interface BoundaryVersion {
  id: string
  /** 版本号，从 1 递增 */
  version: number
  /** 本版各礁区边界线：reefId -> 外环坐标 */
  reefs: Record<string, Ring>
  /** 备注（如「保护区界线重新划过」） */
  note: string
  /** 是否当前生效版本（同时只有一版为 1） */
  isActive: boolean
  /** 是否发布失败：为 1 时只允许重试界线这侧，外业数据不受影响 */
  failed: boolean
  publishedBy: string
  createdAt: number
  updatedAt: number
}

/** 派生段归属状态 */
export type SegmentStatus = 'matched' | 'pending'

/** 派生态：一条样带在某版界线下被切成的一个段 */
export interface BeltSegment {
  id: string
  /** 派生所用界线版本 */
  boundaryVersionId: string
  boundaryVersion: number
  beltId: string
  /** 两室对账的键：样带编号 */
  beltNo: string
  /** 段序号（自起点 0 起） */
  ordinal: number
  /** 段归属礁区；null 表示落在所有礁区边界之外（挂起） */
  reefId: string | null
  startM: number
  endM: number
  /** 段长（m） */
  lengthM: number
  /** 段起点 / 终点经纬度，供测绘与外业核对 */
  start: LngLat
  end: LngLat
  /** 段长 / 整段样带长度，0 ~ 1，珊瑚覆盖与鱼类计数按此分摊 */
  share: number
  status: SegmentStatus
  /** 挂起原因（落在界外 / 对不上账等） */
  reason: string
  createdAt: number
  updatedAt: number
}

/** 对账状态 */
export type NoticeStatus = 'matched' | 'pending' | 'resolved'

/** 对账记录来源方 */
export type NoticeSide = 'survey' | 'office'

/**
 * 两室对账记录（按样带编号）：
 * 外业普查组报某编号样带跨界，测绘室几何切段也判其跨界，两边对得上即 matched；
 * 只有一边认为跨界或归属礁区不一致，先挂起 pending。
 */
export interface BoundaryNotice {
  id: string
  /** 对账键：样带编号 */
  beltNo: string
  /** 报方：外业普查组 survey / 界线测绘室 office */
  side: NoticeSide
  /** 报方认定的跨界情况（两端礁区 id，未知用 null） */
  startReefId: string | null
  endReefId: string | null
  reefIds: string[]
  status: NoticeStatus
  detail: string
  boundaryVersionId: string | null
  createdAt: number
  updatedAt: number
}

/** 界线改线流水状态 */
export type RevisionState = 'draft' | 'failed' | 'done' | 'rolled_back'

/** 界线改线动作流水：测绘室改界线失败后只重试界线这侧的依据 */
export interface BoundaryRevision {
  id: string
  boundaryVersionId: string
  version: number
  state: RevisionState
  /** 失败 / 重试信息 */
  message: string
  /** 已重试次数 */
  retries: number
  /** 被本次改线压到、需要重算的样带编号 */
  affectedBeltNos: string[]
  createdAt: number
  updatedAt: number
}
