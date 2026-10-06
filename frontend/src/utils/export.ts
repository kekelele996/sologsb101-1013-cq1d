/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入。
 * 礁区白化与导出共用 utils/allocation.ts 的按段长分摊口径，页面与导出不会出现两套数。
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
import { allocate, type AllocationResult } from '@/utils/allocation'
import type { FieldCrossReport } from '@/utils/reconcile'

/** 备份集合键名 */
export const BACKUP_KEYS = [
  'reefs',
  'sites',
  'belts',
  'corals',
  'fishes',
  'boundaryVersions',
  'beltSegments',
  'boundaryNotices',
  'boundaryRevisions'
] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 外业跨界上报不在 BACKUP_KEYS 强制校验内（运行态数据），但随快照一并保存 */
const EMPTY_COUNTS = (): CountMap => ({
  reefs: 0,
  sites: 0,
  belts: 0,
  corals: 0,
  fishes: 0,
  boundaryVersions: 0,
  beltSegments: 0,
  boundaryNotices: 0,
  boundaryRevisions: 0
})

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [reefs, sites, belts, corals, fishes, boundaryVersions, beltSegments, boundaryNotices, boundaryRevisions] =
    await Promise.all([
      db.reefs.toArray(),
      db.sites.toArray(),
      db.belts.toArray(),
      db.corals.toArray(),
      db.fishes.toArray(),
      db.boundaryVersions.toArray(),
      db.beltSegments.toArray(),
      db.boundaryNotices.toArray(),
      db.boundaryRevisions.toArray()
    ])
  // 外业跨界上报存 localStorage（轻量运行态），导出时一并带上
  const fieldCrossReports = readFieldCrossReports()
  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    reefs,
    sites,
    belts,
    corals,
    fishes,
    boundaryVersions,
    beltSegments,
    boundaryNotices,
    boundaryRevisions,
    fieldCrossReports
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
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: obj.reefs ?? [],
    sites: obj.sites ?? [],
    belts: obj.belts ?? [],
    corals: obj.corals ?? [],
    fishes: obj.fishes ?? [],
    boundaryVersions: obj.boundaryVersions ?? [],
    beltSegments: obj.beltSegments ?? [],
    boundaryNotices: obj.boundaryNotices ?? [],
    boundaryRevisions: obj.boundaryRevisions ?? [],
    fieldCrossReports: Array.isArray(obj.fieldCrossReports) ? obj.fieldCrossReports : []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    belts: payload.belts.length,
    corals: payload.corals.length,
    fishes: payload.fishes.length,
    boundaryVersions: payload.boundaryVersions.length,
    beltSegments: payload.beltSegments.length,
    boundaryNotices: payload.boundaryNotices.length,
    boundaryRevisions: payload.boundaryRevisions.length
  }
}

/** 触发浏览器下载 */
function downloadText(fileName: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  downloadText(fileName, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8')
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
      await db.reefs.bulkPut(payload.reefs)
      await db.sites.bulkPut(payload.sites)
      await db.belts.bulkPut(payload.belts)
      await db.corals.bulkPut(payload.corals)
      await db.fishes.bulkPut(payload.fishes)
      await db.boundaryVersions.bulkPut(payload.boundaryVersions)
      await db.beltSegments.bulkPut(payload.beltSegments)
      await db.boundaryNotices.bulkPut(payload.boundaryNotices)
      await db.boundaryRevisions.bulkPut(payload.boundaryRevisions)
    }
  )
  writeFieldCrossReports(payload.fieldCrossReports ?? [])
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()
  const versionMap = new Map<string, string>()

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

  const boundaryVersions = payload.boundaryVersions.map((version) => {
    const id = createId('bnd')
    versionMap.set(version.id, id)
    const remappedReefs = Object.fromEntries(
      Object.entries(version.reefs).map(([reefId, ring]) => [reefMap.get(reefId) ?? reefId, ring])
    )
    return { ...version, id, reefs: remappedReefs, isActive: false }
  })
  const beltSegments = payload.beltSegments.map((segment) => ({
    ...segment,
    id: createId('seg'),
    boundaryVersionId:
      versionMap.get(segment.boundaryVersionId) ?? segment.boundaryVersionId,
    beltId: beltMap.get(segment.beltId) ?? segment.beltId,
    reefId: segment.reefId ? reefMap.get(segment.reefId) ?? segment.reefId : null
  }))
  const boundaryNotices = payload.boundaryNotices.map((notice) => ({
    ...notice,
    id: createId('ntc'),
    boundaryVersionId: notice.boundaryVersionId
      ? versionMap.get(notice.boundaryVersionId) ?? notice.boundaryVersionId
      : null,
    startReefId: notice.startReefId ? reefMap.get(notice.startReefId) ?? notice.startReefId : null,
    endReefId: notice.endReefId ? reefMap.get(notice.endReefId) ?? notice.endReefId : null,
    reefIds: notice.reefIds.map((reefId) => reefMap.get(reefId) ?? reefId)
  }))
  const boundaryRevisions = payload.boundaryRevisions.map((revision) => ({
    ...revision,
    id: createId('rev'),
    boundaryVersionId: versionMap.get(revision.boundaryVersionId) ?? revision.boundaryVersionId
  }))
  const fieldCrossReports: FieldCrossReport[] = (payload.fieldCrossReports ?? []).map((report) => ({
    ...report,
    beltId: beltMap.get(report.beltId) ?? report.beltId,
    startReefId: report.startReefId ? reefMap.get(report.startReefId) ?? report.startReefId : null,
    endReefId: report.endReefId ? reefMap.get(report.endReefId) ?? report.endReefId : null
  }))

  return {
    ...payload,
    reefs,
    sites,
    belts,
    corals,
    fishes,
    boundaryVersions,
    beltSegments,
    boundaryNotices,
    boundaryRevisions,
    fieldCrossReports
  }
}

/* ------------------------- 分摊口径（页面与导出共用） ------------------------- */

/** 以当前激活界线版本对一份快照执行分摊 */
export function allocatePayload(payload: BackupPayload): AllocationResult {
  const active = payload.boundaryVersions.find((version) => version.isActive) ?? null
  const segments = active ? payload.beltSegments.filter((segment) => segment.boundaryVersionId === active.id) : []
  return allocate({
    boundaryVersion: active,
    segments,
    reefs: payload.reefs,
    sites: payload.sites,
    belts: payload.belts,
    corals: payload.corals,
    fishes: payload.fishes
  })
}

/* ------------------------------- CSV 导出 ------------------------------- */

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(headers: string[], rows: Array<Array<string | number>>): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
}

/** 导出礁区分摊汇总 + 样带×礁区分摊行 + 挂起清单 CSV（带 UTF-8 BOM，Excel 可直接打开） */
export async function exportAllocationCsv(): Promise<{ fileName: string; reefCount: number; lineCount: number; pendingCount: number }> {
  const payload = await buildBackupPayload()
  const result = allocatePayload(payload)
  const reefName = new Map(payload.reefs.map((reef) => [reef.id, reef.name]))

  const reefCsv = toCsv(
    ['界线版本', '礁区', '保护区状态', '摊入样带条数', '摊入长度m', '珊瑚覆盖cm', '覆盖率%', '白化指数', '总体等级', '白化占比%', '鱼类尾', '无脊椎动物', '鱼类密度尾每100m2'],
    result.reefSummaries.map((row) => [
      result.boundaryVersion ?? '',
      row.reefName,
      row.protectStatus,
      row.beltCount,
      row.allocatedLengthM,
      row.coverCm,
      row.coveragePct,
      row.bleachIndex,
      row.grade,
      row.bleachedSharePct,
      row.fishTotal,
      row.invertebrateTotal,
      row.fishDensity
    ])
  )

  const lineCsv = toCsv(
    ['界线版本', '礁区', '站位', '样带编号', '摊入长度m', '分摊比例', '珊瑚覆盖cm', '覆盖率%', '白化指数', '总体等级', '白化占比%', '鱼类尾', '无脊椎动物', '鱼类密度尾每100m2'],
    result.lines.map((line) => [
      result.boundaryVersion ?? '',
      reefName.get(line.reefId) ?? line.reefId,
      line.siteNo,
      line.beltNo,
      line.allocatedLengthM,
      line.share,
      line.coverCm,
      line.coveragePct,
      line.bleachIndex,
      line.grade,
      line.bleachedSharePct,
      line.fishTotal,
      line.invertebrateTotal,
      line.fishDensity
    ])
  )

  const pendingCsv = toCsv(
    ['界线版本', '样带编号', '挂起段长m', '分摊比例', '挂起原因'],
    result.pending.map((item) => [item.boundaryVersion, item.beltNo, item.lengthM, item.share, item.reason])
  )

  const text = `﻿# 礁区分摊汇总（按段长分摊，界线版本 v${result.boundaryVersion ?? '—'}）\n${reefCsv}\n\n# 样带×礁区分摊行\n${lineCsv}\n\n# 挂起清单（对不上/界外，未入礁区统计）\n${pendingCsv}\n`
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')
  const fileName = `${DB_NAME}-allocation-v${result.boundaryVersion ?? 'x'}-${stamp}.csv`
  downloadText(fileName, text, 'text/csv;charset=utf-8')
  stampBackupTime(new Date().toISOString())
  return { fileName, reefCount: result.reefSummaries.length, lineCount: result.lines.length, pendingCount: result.pending.length }
}

/* ---------------------- 外业跨界上报（localStorage 运行态） ---------------------- */

const FIELD_REPORTS_KEY = 'gbcoralbelt:field-cross-reports'

export function readFieldCrossReports(): FieldCrossReport[] {
  try {
    const raw = localStorage.getItem(FIELD_REPORTS_KEY)
    if (!raw) return seedFieldCrossReportsFallback()
    const parsed = JSON.parse(raw) as FieldCrossReport[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function writeFieldCrossReports(reports: FieldCrossReport[]): void {
  try {
    localStorage.setItem(FIELD_REPORTS_KEY, JSON.stringify(reports))
  } catch {
    // 忽略
  }
}

/** 全新库首次打开：localStorage 尚无外业上报，给出与播种一致的默认两条 */
function seedFieldCrossReportsFallback(): FieldCrossReport[] {
  const seeded: FieldCrossReport[] = [
    { beltId: 'belt_ql01_b', beltNo: 'T-02', startReefId: 'reef_ql01', endReefId: 'reef_lw04', detail: '外业实测：东向 50 m 样带尾端越过界线进入隔壁礁区' },
    { beltId: 'belt_lw01_a', beltNo: 'T-01', startReefId: 'reef_lw04', endReefId: 'reef_dz03', detail: '外业记录：西向起点在龙湾，终点疑入大洲岛礁区（待核）' }
  ]
  writeFieldCrossReports(seeded)
  return seeded
}

export { EMPTY_COUNTS }
