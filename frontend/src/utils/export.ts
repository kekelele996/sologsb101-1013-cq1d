/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及按礁区/站位汇总的覆盖度结论生成。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import {
  BLEACH_LEVELS,
  type BleachLevel
} from '@/types/coralRecord'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'
import { aggregateReef } from '@/utils/reefAggregation'
import { splitBeltRecords } from '@/utils/allocation'
import { isCrossReefBelt } from '@/types/belt'
import type { Belt } from '@/types/belt'
import { splitBeltByReefs } from '@/utils/geometry'

/** 备份集合键名 */
export const BACKUP_KEYS = ['reefs', 'sites', 'belts', 'corals', 'fishes'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [reefs, sites, belts, corals, fishes] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.corals.toArray(),
    db.fishes.toArray()
  ])
  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    reefs,
    sites,
    belts,
    corals,
    fishes
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gbcoralbelt') {
    errors.push('app 字段应为 gbcoralbelt，文件来源不明')
  }
  for (const key of BACKUP_KEYS) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const normalized = normalizePayload({
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: obj.reefs ?? [],
    sites: obj.sites ?? [],
    belts: obj.belts ?? [],
    corals: obj.corals ?? [],
    fishes: obj.fishes ?? []
  })
  return { ok: true, errors, payload: normalized }
}

/**
 * 导入归一化：旧版本备份没有界线 / 起止点字段，按 v3 升级同一口径补齐——
 * 旧数据没记起止点时，按站位坐标补一条整段样带（legacyPoints 标记）。
 */
export function normalizePayload(payload: BackupPayload): BackupPayload {
  const reefs = payload.reefs.map((reef) => ({
    ...reef,
    boundaryPolygon: Array.isArray(reef.boundaryPolygon) ? reef.boundaryPolygon : [],
    boundaryRev: typeof reef.boundaryRev === 'number' ? reef.boundaryRev : 0,
    boundaryUpdatedAt: typeof reef.boundaryUpdatedAt === 'number' ? reef.boundaryUpdatedAt : null
  }))
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const belts = payload.belts.map((belt) => {
    const site = siteById.get(belt.siteId)
    const startPoint =
      belt.startPoint && Number.isFinite(belt.startPoint.lat) && Number.isFinite(belt.startPoint.lng)
        ? belt.startPoint
        : site
          ? { lat: site.lat, lng: site.lng }
          : { lat: 0, lng: 0 }
    const endPoint =
      belt.endPoint && Number.isFinite(belt.endPoint.lat) && Number.isFinite(belt.endPoint.lng)
        ? belt.endPoint
        : { ...startPoint }
    const legacyPoints = typeof belt.legacyPoints === 'boolean' ? belt.legacyPoints : !belt.startPoint
    const segments =
      Array.isArray(belt.segments) && belt.segments.length > 0
        ? belt.segments
        : splitBeltByReefs(startPoint, endPoint, belt.lengthM ?? 50, site?.reefId ?? '', reefs).segments
    return {
      ...belt,
      lengthM: typeof belt.lengthM === 'number' ? belt.lengthM : 50,
      startPoint,
      endPoint,
      legacyPoints,
      segments,
      allocationMode: belt.allocationMode === 'origin' ? ('origin' as const) : ('prorate' as const),
      settleStatus: belt.settleStatus === 'pending' ? ('pending' as const) : ('settled' as const),
      settleIssue: typeof belt.settleIssue === 'string' ? belt.settleIssue : '',
      boundaryRevByReef:
        belt.boundaryRevByReef && typeof belt.boundaryRevByReef === 'object' ? belt.boundaryRevByReef : {}
    } satisfies Belt
  })
  return { ...payload, reefs, belts }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    belts: payload.belts.length,
    corals: payload.corals.length,
    fishes: payload.fishes.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables()
  await db.transaction('rw', [db.reefs, db.sites, db.belts, db.corals, db.fishes], async () => {
    await db.reefs.bulkPut(payload.reefs)
    await db.sites.bulkPut(payload.sites)
    await db.belts.bulkPut(payload.belts)
    await db.corals.bulkPut(payload.corals)
    await db.fishes.bulkPut(payload.fishes)
  })
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()

  const reefs = payload.reefs.map((reef) => {
    const id = createId('reef')
    reefMap.set(reef.id, id)
    return { ...reef, id }
  })
  const sites = payload.sites.map((site) => {
    const id = createId('site')
    siteMap.set(site.id, id)
    return { ...site, id, reefId: reefMap.get(site.reefId) ?? site.reefId }
  })
  const belts = payload.belts.map((belt) => {
    const id = createId('belt')
    beltMap.set(belt.id, id)
    return { ...belt, id, siteId: siteMap.get(belt.siteId) ?? belt.siteId }
  })
  const corals = payload.corals.map((coral) => ({
    ...coral,
    id: createId('cor'),
    beltId: beltMap.get(coral.beltId) ?? coral.beltId
  }))
  const fishes = payload.fishes.map((fish) => ({
    ...fish,
    id: createId('fsh'),
    beltId: beltMap.get(fish.beltId) ?? fish.beltId
  }))
  return { ...payload, reefs, sites, belts, corals, fishes }
}

/** 白化等级分布：各等级累计覆盖长度 */
export type BleachDistribution = Record<BleachLevel, number>

/** 覆盖度结论行：一条样带在某礁区一侧的分摊成果（跨界样带每个礁区一行） */
export interface CoverageLine {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  lengthM: number
  /** 该礁区内的分段长度合计（m）；未跨界即样带全长 */
  segmentLengthM: number
  /** 段长占整条样带比例（0 ~ 1） */
  segmentShare: number
  orientation: string
  surveyDate: string
  observer: string
  /** 是否跨界样带 */
  crossReef: boolean
  settleStatus: 'settled' | 'pending'
  settleIssue: string
  coralCount: number
  coverCmTotal: number
  /** 珊瑚覆盖率（%，分摊覆盖长度 / 该礁区段长） */
  coveragePct: number
  /** 白化指数 0 ~ 4（分摊后的覆盖长度加权） */
  bleachIndex: number
  /** 总体白化等级 */
  grade: BleachLevel
  /** 白化占比（%，覆盖长度加权） */
  bleachedSharePct: number
  distribution: BleachDistribution
  fishTotal: number
  invertebrateTotal: number
  /** 鱼类密度（尾 / 100 m²，分摊计数 / 段长） */
  fishDensity: number
  conclusion: string
}

/**
 * 按「样带 × 礁区」生成覆盖度结论行：
 * 珊瑚覆盖与鱼类计数按段长分摊，跨界且挂账的样带不进入任何一侧。
 * 与页面礁区白化评定共用 utils/allocation 同一口径。
 */
export function buildCoverageLines(payload: BackupPayload): CoverageLine[] {
  const reefById = new Map(payload.reefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const coralsByBelt = new Map<string, typeof payload.corals>()
  payload.corals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })
  const fishesByBelt = new Map<string, typeof payload.fishes>()
  payload.fishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })

  const lines: CoverageLine[] = []
  payload.belts.forEach((belt) => {
    const site = siteById.get(belt.siteId)
    const originReef = site ? reefById.get(site.reefId) : undefined
    const corals = coralsByBelt.get(belt.id) ?? []
    const fishes = fishesByBelt.get(belt.id) ?? []
    const slices = splitBeltRecords(belt, corals, fishes)
    slices.forEach((slice) => {
      const reef = reefById.get(slice.reefId)
      const distribution: BleachDistribution = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
      BLEACH_LEVELS.forEach((level) => {
        distribution[level] = round(
          slice.corals
            .filter((coral) => coral.bleachLevel === level)
            .reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
      })
      const coverCmTotal = round(
        slice.corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      const index = bleachIndex(slice.corals)
      const sharePct = bleachedSharePct(slice.corals)
      const coverage = coralCoveragePct(coverCmTotal, slice.segmentLengthM || belt.lengthM)
      const density = fishDensity(slice.fish, slice.segmentLengthM || belt.lengthM)
      lines.push({
        beltId: belt.id,
        beltNo: belt.no,
        reefId: slice.reefId,
        reefName: reef?.name ?? '未知礁区',
        siteId: site?.id ?? '',
        siteNo: site?.no ?? '—',
        lengthM: belt.lengthM,
        segmentLengthM: slice.segmentLengthM,
        segmentShare: slice.share,
        orientation: belt.orientation,
        surveyDate: belt.surveyDate,
        observer: belt.observer,
        crossReef: isCrossReefBelt(belt),
        settleStatus: belt.settleStatus,
        settleIssue: belt.settleIssue,
        coralCount: corals.length,
        coverCmTotal,
        coveragePct: coverage,
        bleachIndex: index,
        grade: bleachGrade(index),
        bleachedSharePct: sharePct,
        distribution,
        fishTotal: slice.fish,
        invertebrateTotal: slice.invertebrate,
        fishDensity: density,
        conclusion:
          corals.length === 0
            ? '该样带尚未录入珊瑚记录'
            : belt.settleStatus === 'pending' && isCrossReefBelt(belt)
              ? `跨界样带编号 ${belt.no} 两边对账不符（${belt.settleIssue}），暂挂账不参与礁区评定`
              : isCrossReefBelt(belt)
                ? `跨界样带按段长 ${slice.segmentLengthM} m（${Math.round(slice.share * 100)}%）分摊：覆盖率 ${coverage}%，白化指数 ${index}（${bleachGrade(index)}），白化占比 ${sharePct}%`
                : `珊瑚覆盖率 ${coverage}%，白化指数 ${index}（${bleachGrade(index)}），白化占比 ${sharePct}%`
      })
    })
    // 跨界挂账样带：splitBeltRecords 返回空，补一条挂账行锚定到起点礁区，导出可见但不参与统计
    if (slices.length === 0 && isCrossReefBelt(belt)) {
      const emptyDistribution: BleachDistribution = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
      lines.push({
        beltId: belt.id,
        beltNo: belt.no,
        reefId: originReef?.id ?? '',
        reefName: `${originReef?.name ?? '未知礁区'}（挂账）`,
        siteId: site?.id ?? '',
        siteNo: site?.no ?? '—',
        lengthM: belt.lengthM,
        segmentLengthM: 0,
        segmentShare: 0,
        orientation: belt.orientation,
        surveyDate: belt.surveyDate,
        observer: belt.observer,
        crossReef: true,
        settleStatus: 'pending',
        settleIssue: belt.settleIssue,
        coralCount: 0,
        coverCmTotal: 0,
        coveragePct: 0,
        bleachIndex: 0,
        grade: '无',
        bleachedSharePct: 0,
        distribution: emptyDistribution,
        fishTotal: 0,
        invertebrateTotal: 0,
        fishDensity: 0,
        conclusion: `跨界样带编号 ${belt.no} 两边对账不符（${belt.settleIssue}），暂挂账不参与礁区评定`
      })
    }
  })

  return lines.sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/** 按礁区汇总：站位/样带数量、段长分摊后的平均白化指数与总体等级（与页面同一口径） */
export interface ReefSummary {
  reefId: string
  reefName: string
  protectStatus: string
  siteCount: number
  beltCount: number
  countedBeltCount: number
  coralCount: number
  coverCmTotal: number
  avgBleachIndex: number
  grade: BleachLevel
  fishTotal: number
  invertebrateTotal: number
  countedSegmentLengthM: number
  pendingBeltNos: string[]
}

export function buildReefSummaries(payload: BackupPayload): ReefSummary[] {
  return payload.reefs.map((reef) => {
    const agg = aggregateReef({
      reef,
      sites: payload.sites,
      belts: payload.belts,
      corals: payload.corals,
      fishes: payload.fishes
    })
    return {
      reefId: reef.id,
      reefName: reef.name,
      protectStatus: reef.protectStatus,
      siteCount: agg.siteCount,
      beltCount: agg.beltCount,
      countedBeltCount: agg.countedBeltCount,
      coralCount: agg.coralCount,
      coverCmTotal: agg.coverCmTotal,
      avgBleachIndex: agg.bleachIndex,
      grade: agg.grade,
      fishTotal: agg.fishTotal,
      invertebrateTotal: agg.invertebrateTotal,
      countedSegmentLengthM: agg.countedSegmentLengthM,
      pendingBeltNos: agg.pendingBeltNos
    }
  })
}
