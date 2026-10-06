/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（礁区 → 站位 → 样带 → 珊瑚记录/鱼类计数）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 *
 * v3 起「拆管」：
 * - 界线测绘室：boundary_versions（礁区边界线版本）、belt_segments（几何切段，派生）、
 *   boundary_notices（两室对账）、boundary_revisions（改线流水，失败只重试界线侧）
 * - 外业普查组：belts 增加起止点坐标与坐标来源；旧数据无起止点，升级时按站位坐标补一条整段样带
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { BeltSegment, BoundaryNotice, BoundaryRevision, BoundaryVersion } from '@/types/boundary'
import { cutBeltByReefs } from '@/utils/geometry'
import type { FieldCrossReport } from '@/utils/reconcile'
import { createBoundaryBootstrap } from '@/utils/boundarySeed'
import { createId as makeId } from '@/utils/id'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbcoralbelt'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbcoralbelt:db-version',
  lastBackupAt: 'gbcoralbelt:last-backup-at',
  lastReefId: 'gbcoralbelt:last-reef-id'
} as const

/** 备份文件结构，供 utils/export.ts 与覆盖度汇总页使用 */
export interface BackupPayload {
  app: 'gbcoralbelt'
  dbVersion: number
  exportedAt: string
  reefs: Reef[]
  sites: Site[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
  boundaryVersions: BoundaryVersion[]
  beltSegments: BeltSegment[]
  boundaryNotices: BoundaryNotice[]
  boundaryRevisions: BoundaryRevision[]
  /** 外业普查组填报的跨界样带（按样带编号对账） */
  fieldCrossReports: FieldCrossReport[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  belts!: Table<Belt, string>
  corals!: Table<CoralRecord, string>
  fishes!: Table<FishCount, string>
  boundaryVersions!: Table<BoundaryVersion, string>
  beltSegments!: Table<BeltSegment, string>
  boundaryNotices!: Table<BoundaryNotice, string>
  boundaryRevisions!: Table<BoundaryRevision, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      reefs: 'id, name, protectStatus',
      sites: 'id, reefId, no',
      belts: 'id, siteId, no, surveyDate',
      corals: 'id, beltId, genus, form',
      fishes: 'id, beltId, family, sizeClass'
    })

    // v2：补齐筛选与统计需要的索引（位置/面积、经纬度/水深、样带长度与朝向、白化等级、类别）
    this.version(2)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与必填字段，避免列表排序与筛选拿到 undefined
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['reefs', () => ({ manager: '', areaKm2: 0 })],
          ['sites', () => ({ lat: 0, lng: 0, depthM: 5, substrate: '珊瑚礁石' })],
          ['belts', () => ({ lengthM: 50, orientation: '北', observer: '' })],
          ['corals', () => ({ coverCm: 0, bleachLevel: '无', remark: '' })],
          ['fishes', () => ({ count: 0, sizeClass: '11-20cm', category: '鱼类' })]
        ]
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, factory())
            })
        }
      })

    // v3：拆管 —— 界线测绘室四表 + 样带起止点。旧数据无起止点，按站位坐标补一条整段样带
    this.version(DB_VERSION)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, geoSource, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt',
        boundaryVersions: 'id, version, isActive, failed, updatedAt',
        beltSegments: 'id, boundaryVersionId, beltId, beltNo, reefId, status, updatedAt',
        boundaryNotices: 'id, beltNo, side, status, boundaryVersionId, updatedAt',
        boundaryRevisions: 'id, boundaryVersionId, version, state, updatedAt'
      })
      .upgrade(async (tx) => {
        const sites = await tx.table<Site, string>('sites').toArray()
        const siteById = new Map(sites.map((site) => [site.id, site]))
        // 旧数据没记起止点：按站位坐标补一条整段样带（起终点相同，标记 legacy_upgraded）
        await tx
          .table<Belt, string>('belts')
          .toCollection()
          .modify((belt) => {
            const row = belt as Belt & Record<string, unknown>
            if (row.startCoord !== undefined && row.endCoord !== undefined) return
            const site = siteById.get(String(row.siteId))
            if (site) {
              row.startCoord = [site.lng, site.lat]
              row.endCoord = [site.lng, site.lat]
            } else {
              row.startCoord = null
              row.endCoord = null
            }
            row.geoSource = 'legacy_upgraded'
          })

        // 为旧库补一版初始界线与派生段（复用与播种相同的几何口径）
        const reefs = await tx.table<Reef, string>('reefs').toArray()
        const beltsAfter = await tx.table<Belt, string>('belts').toArray()
        if (reefs.length > 0) {
          const bootstrap = createBoundaryBootstrap({ reefs, belts: beltsAfter })
          await tx.table('boundaryVersions').bulkPut(bootstrap.versions)
          await tx.table('beltSegments').bulkPut(bootstrap.segments)
          await tx.table('boundaryNotices').bulkPut(bootstrap.notices)
          await tx.table('boundaryRevisions').bulkPut(bootstrap.revisions)
        }
      })
  }
}

export const db = new CoralBeltDatabase()

/** 主键生成统一从 utils/id 转出，页面与 store 既有 `import { createId } from '@/utils/db'` 不变 */
export { makeId as createId }

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCoral {
  id: string
  beltId: string
  genus: string
  form: CoralRecord['form']
  coverCm: number
  bleachLevel: CoralRecord['bleachLevel']
  remark: string
}

interface SeedFish {
  id: string
  beltId: string
  family: string
  count: number
  sizeClass: FishCount['sizeClass']
  category: FishCount['category']
}

interface SeedBelt {
  id: string
  siteId: string
  no: string
  lengthM: number
  orientation: Belt['orientation']
  surveyDate: string
  observer: string
  startCoord: [number, number]
  endCoord: [number, number]
  geoSource: Belt['geoSource']
  corals: SeedCoral[]
  fishes: SeedFish[]
}

/**
 * 播种演示数据：4 个礁区 → 5 个站位 → 7 条样带 → 珊瑚记录 + 鱼类计数。
 * 其中：
 * - belt_ql01_b（T-02）一头在清澜湾、一头伸进隔壁龙湾，外业与测绘两室一致 → matched 分摊；
 * - belt_lw01_a（T-01）跨界但外业报错礁区，对不上 → 先挂起 pending；
 * - belt_ql02_a 为旧数据形态（起止点同站位坐标，legacy_upgraded）。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)

  const reefs: Array<Omit<Reef, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'reef_ql01',
      name: '清澜湾珊瑚礁区',
      location: '海南文昌清澜湾东侧 3.5 km 海域',
      areaKm2: 18.6,
      protectStatus: '核心区',
      manager: '清澜湾海洋保护站'
    },
    {
      id: 'reef_yr02',
      name: '永兴岛西侧礁盘',
      location: '西沙永兴岛西侧礁盘外缘',
      areaKm2: 42.3,
      protectStatus: '缓冲区',
      manager: '西沙海洋环境监测中心'
    },
    {
      id: 'reef_dz03',
      name: '大洲岛南岸礁区',
      location: '万宁大洲岛南岸潮下带',
      areaKm2: 6.4,
      protectStatus: '实验区',
      manager: '大洲岛国家级自然保护区管理处'
    },
    {
      id: 'reef_lw04',
      name: '龙湾隔壁礁区',
      location: '清澜湾保护区东侧界线外相邻礁盘',
      areaKm2: 9.8,
      protectStatus: '缓冲区',
      manager: '龙湾海监站'
    }
  ]

  const sites: Array<Omit<Site, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'site_ql_01',
      reefId: 'reef_ql01',
      no: 'S-01',
      lat: 19.5621,
      lng: 110.7924,
      depthM: 4.2,
      substrate: '珊瑚礁石'
    },
    {
      id: 'site_ql_02',
      reefId: 'reef_ql01',
      no: 'S-02',
      lat: 19.55,
      lng: 110.7918,
      depthM: 8.6,
      substrate: '礁砂'
    },
    {
      id: 'site_yr_01',
      reefId: 'reef_yr02',
      no: 'S-01',
      lat: 16.8342,
      lng: 112.3286,
      depthM: 12.4,
      substrate: '砾石'
    },
    {
      id: 'site_dz_01',
      reefId: 'reef_dz03',
      no: 'S-01',
      lat: 18.6712,
      lng: 110.4913,
      depthM: 6.8,
      substrate: '岩礁'
    },
    {
      id: 'site_lw_01',
      reefId: 'reef_lw04',
      no: 'S-01',
      lat: 19.5608,
      lng: 110.7934,
      depthM: 5.1,
      substrate: '珊瑚礁石'
    }
  ]

  // 外业实测起止点（跨界样带一头一尾分属两礁）
  const belts: SeedBelt[] = [
    {
      id: 'belt_ql01_a',
      siteId: 'site_ql_01',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: today,
      observer: '林之遥',
      startCoord: [110.7924, 19.5621],
      endCoord: [110.7924, 19.5626],
      geoSource: 'field',
      corals: [
        { id: 'cor_ql01a_1', beltId: 'belt_ql01_a', genus: '鹿角珊瑚属', form: '枝状', coverCm: 860, bleachLevel: '无', remark: '长势良好' },
        { id: 'cor_ql01a_2', beltId: 'belt_ql01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 540, bleachLevel: '轻', remark: '局部褪色' },
        { id: 'cor_ql01a_3', beltId: 'belt_ql01_a', genus: '滨珊瑚属', form: '块状', coverCm: 1120, bleachLevel: '无', remark: '' },
        { id: 'cor_ql01a_4', beltId: 'belt_ql01_a', genus: '软珊瑚属', form: '软珊瑚', coverCm: 380, bleachLevel: '轻', remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql01a_1', beltId: 'belt_ql01_a', family: '雀鲷科', count: 46, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_ql01a_2', beltId: 'belt_ql01_a', family: '蝴蝶鱼科', count: 18, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01a_3', beltId: 'belt_ql01_a', family: '鹦嘴鱼科', count: 7, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01a_4', beltId: 'belt_ql01_a', family: '海胆科', count: 12, sizeClass: '0-10cm', category: '无脊椎动物' }
      ]
    },
    {
      // 跨界样带：清澜湾 → 龙湾隔壁，高白化在起点侧；两室一致，按段长分摊
      id: 'belt_ql01_b',
      siteId: 'site_ql_01',
      no: 'T-02',
      lengthM: 50,
      orientation: '东',
      surveyDate: today,
      observer: '林之遥',
      startCoord: [110.7924, 19.5622],
      endCoord: [110.7930, 19.5622],
      geoSource: 'field',
      corals: [
        { id: 'cor_ql01b_1', beltId: 'belt_ql01_b', genus: '蔷薇珊瑚属', form: '叶状', coverCm: 720, bleachLevel: '中', remark: '边缘白化明显' },
        { id: 'cor_ql01b_2', beltId: 'belt_ql01_b', genus: '蜂巢珊瑚属', form: '块状', coverCm: 980, bleachLevel: '轻', remark: '' },
        { id: 'cor_ql01b_3', beltId: 'belt_ql01_b', genus: '鹿角珊瑚属', form: '枝状', coverCm: 430, bleachLevel: '重', remark: '大面积白化，部分死亡' }
      ],
      fishes: [
        { id: 'fsh_ql01b_1', beltId: 'belt_ql01_b', family: '隆头鱼科', count: 22, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01b_2', beltId: 'belt_ql01_b', family: '刺尾鱼科', count: 15, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01b_3', beltId: 'belt_ql01_b', family: '砗磲科', count: 3, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      // 旧数据：无实测起止点，升级/播种时按站位坐标补整段
      id: 'belt_ql02_a',
      siteId: 'site_ql_02',
      no: 'T-01',
      lengthM: 30,
      orientation: '南',
      surveyDate: today,
      observer: '周渝',
      startCoord: [110.7918, 19.55],
      endCoord: [110.7918, 19.55],
      geoSource: 'legacy_upgraded',
      corals: [
        { id: 'cor_ql02a_1', beltId: 'belt_ql02_a', genus: '滨珊瑚属', form: '块状', coverCm: 1240, bleachLevel: '无', remark: '' },
        { id: 'cor_ql02a_2', beltId: 'belt_ql02_a', genus: '陀螺珊瑚属', form: '块状', coverCm: 260, bleachLevel: '死亡', remark: '仅存骨骼，附着藻类' }
      ],
      fishes: [
        { id: 'fsh_ql02a_1', beltId: 'belt_ql02_a', family: '石斑鱼科', count: 4, sizeClass: '>30cm', category: '鱼类' },
        { id: 'fsh_ql02a_2', beltId: 'belt_ql02_a', family: '海参科', count: 6, sizeClass: '21-30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_yr01_a',
      siteId: 'site_yr_01',
      no: 'T-01',
      lengthM: 100,
      orientation: '西',
      surveyDate: today,
      observer: '陈立群',
      startCoord: [112.3286, 16.8342],
      endCoord: [112.3275, 16.8342],
      geoSource: 'field',
      corals: [
        { id: 'cor_yr01a_1', beltId: 'belt_yr01_a', genus: '星珊瑚属', form: '块状', coverCm: 1580, bleachLevel: '轻', remark: '' },
        { id: 'cor_yr01a_2', beltId: 'belt_yr01_a', genus: '柳珊瑚属', form: '软珊瑚', coverCm: 640, bleachLevel: '中', remark: '水流较强区域' },
        { id: 'cor_yr01a_3', beltId: 'belt_yr01_a', genus: '石芝珊瑚属', form: '叶状', coverCm: 480, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_yr01a_1', beltId: 'belt_yr01_a', family: '笛鲷科', count: 28, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_yr01a_2', beltId: 'belt_yr01_a', family: '篮子鱼科', count: 11, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_yr01a_3', beltId: 'belt_yr01_a', family: '法螺科', count: 2, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_dz01_a',
      siteId: 'site_dz_01',
      no: 'T-01',
      lengthM: 25,
      orientation: '东',
      surveyDate: today,
      observer: '陈立群',
      startCoord: [110.4913, 18.6712],
      endCoord: [110.4916, 18.6712],
      geoSource: 'field',
      corals: [
        { id: 'cor_dz01a_1', beltId: 'belt_dz01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 520, bleachLevel: '重', remark: '受台风扰动后白化' },
        { id: 'cor_dz01a_2', beltId: 'belt_dz01_a', genus: '蜂巢珊瑚属', form: '块状', coverCm: 310, bleachLevel: '中', remark: '' }
      ],
      fishes: [
        { id: 'fsh_dz01a_1', beltId: 'belt_dz01_a', family: '雀鲷科', count: 34, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_dz01a_2', beltId: 'belt_dz01_a', family: '海星科', count: 5, sizeClass: '11-20cm', category: '无脊椎动物' }
      ]
    },
    {
      // 跨界样带，但外业把对侧礁区错报成大洲岛 → 对不上，先挂起
      id: 'belt_lw01_a',
      siteId: 'site_lw_01',
      no: 'T-01',
      lengthM: 40,
      orientation: '西',
      surveyDate: today,
      observer: '陈立群',
      startCoord: [110.7934, 19.5608],
      endCoord: [110.7928, 19.5608],
      geoSource: 'field',
      corals: [
        { id: 'cor_lw01a_1', beltId: 'belt_lw01_a', genus: '鹿角珊瑚属', form: '枝状', coverCm: 640, bleachLevel: '轻', remark: '' },
        { id: 'cor_lw01a_2', beltId: 'belt_lw01_a', genus: '滨珊瑚属', form: '块状', coverCm: 420, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_lw01a_1', beltId: 'belt_lw01_a', family: '蝴蝶鱼科', count: 19, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_lw01_a2', beltId: 'belt_lw01_a', family: '海胆科', count: 8, sizeClass: '0-10cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_lw01_b',
      siteId: 'site_lw_01',
      no: 'T-02',
      lengthM: 30,
      orientation: '东',
      surveyDate: today,
      observer: '陈立群',
      startCoord: [110.7934, 19.5609],
      endCoord: [110.7937, 19.5609],
      geoSource: 'field',
      corals: [
        { id: 'cor_lw01b_1', beltId: 'belt_lw01_b', genus: '蜂巢珊瑚属', form: '块状', coverCm: 360, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_lw01b_1', beltId: 'belt_lw01_b', family: '雀鲷科', count: 15, sizeClass: '0-10cm', category: '鱼类' }
      ]
    }
  ]

  // 外业普查组填报的跨界样带（按样带编号与测绘室对账）
  const fieldCrossReports: FieldCrossReport[] = [
    // T-02：两室一致（清澜湾 ↔ 龙湾）
    { beltId: 'belt_ql01_b', beltNo: 'T-02', startReefId: 'reef_ql01', endReefId: 'reef_lw04', detail: '外业实测：东向 50 m 样带尾端越过界线进入隔壁礁区' },
    // 龙湾 T-01：外业把对侧错报成大洲岛 reef_dz03，与几何（清澜湾）对不上 → 挂起
    { beltId: 'belt_lw01_a', beltNo: 'T-01', startReefId: 'reef_lw04', endReefId: 'reef_dz03', detail: '外业记录：西向起点在龙湾，终点疑入大洲岛礁区（待核）' }
  ]

  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.boundaryVersions, db.beltSegments, db.boundaryNotices, db.boundaryRevisions],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset
      })

      await db.reefs.bulkPut(reefs.map((reef, index) => ({ ...reef, ...stamp(index) })))
      await db.sites.bulkPut(sites.map((site, index) => ({ ...site, ...stamp(100 + index) })))
      await db.belts.bulkPut(
        belts.map((belt, index) => {
          const { corals, fishes, ...rest } = belt
          void corals
          void fishes
          return { ...rest, ...stamp(200 + index) }
        })
      )
      await db.corals.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.corals.map((coral, coralIndex) => ({ ...coral, ...stamp(300 + beltIndex * 100 + coralIndex) }))
        )
      )
      await db.fishes.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.fishes.map((fish, fishIndex) => ({ ...fish, ...stamp(400 + beltIndex * 100 + fishIndex) }))
        )
      )

      // 界线测绘室：初始界线版本 + 几何切段 + 两室对账（与旧库升级同一口径）
      const bootstrap = createBoundaryBootstrap({ reefs, belts, fieldCrossReports, baseTime: now })
      await db.boundaryVersions.bulkPut(bootstrap.versions)
      await db.beltSegments.bulkPut(bootstrap.segments)
      await db.boundaryNotices.bulkPut(bootstrap.notices)
      await db.boundaryRevisions.bulkPut(bootstrap.revisions)
    }
  )
}

/** 打开数据库并幂等播种：仅当礁区表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.reefs.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.reefs,
      db.sites,
      db.belts,
      db.corals,
      db.fishes,
      db.boundaryVersions,
      db.beltSegments,
      db.boundaryNotices,
      db.boundaryRevisions
    ],
    async () => {
      await Promise.all([
        db.reefs.clear(),
        db.sites.clear(),
        db.belts.clear(),
        db.corals.clear(),
        db.fishes.clear(),
        db.boundaryVersions.clear(),
        db.beltSegments.clear(),
        db.boundaryNotices.clear(),
        db.boundaryRevisions.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与覆盖度页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [reefs, sites, belts, corals, fishes, boundaryVersions, beltSegments, boundaryNotices, boundaryRevisions] =
    await Promise.all([
      db.reefs.count(),
      db.sites.count(),
      db.belts.count(),
      db.corals.count(),
      db.fishes.count(),
      db.boundaryVersions.count(),
      db.beltSegments.count(),
      db.boundaryNotices.count(),
      db.boundaryRevisions.count()
    ])
  return { reefs, sites, belts, corals, fishes, boundaryVersions, beltSegments, boundaryNotices, boundaryRevisions }
}

/** 写入结构版本号到 localStorage，便于覆盖度页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastReefId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastReefId)
  } catch {
    return null
  }
}

export function writeLastReefId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastReefId)
    else localStorage.setItem(LS_KEYS.lastReefId, id)
  } catch {
    // 忽略
  }
}

// 几何切段在播种/升级中复用，保留引用以防 tree-shaking 误判（纯类型场景无副作用）
void cutBeltByReefs
