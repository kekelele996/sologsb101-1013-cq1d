import 'fake-indexeddb/auto'
import { db, initDatabase, seedDemoData } from './src/utils/db.ts'
import { getActiveBoundaryVersion, applyBoundaryRevision, retryBoundaryOnly } from './src/utils/boundaryWorkflow.ts'
import { allocate } from './src/utils/allocation.ts'
import { readFieldCrossReports } from './src/utils/export.ts'
import { SEED_RINGS } from './src/utils/boundarySeed.ts'

function snapshot() {
  return {
    belts: 0, corals: 0, fishes: 0
  }
}
void snapshot

async function loadAllocation() {
  const [reefs,sites,belts,corals,fishes,versions,segments] = await Promise.all([
    db.reefs.toArray(), db.sites.toArray(), db.belts.toArray(), db.corals.toArray(),
    db.fishes.toArray(), db.boundaryVersions.toArray(), db.beltSegments.toArray()])
  const active = versions.find(v=>v.isActive)!
  const segs = segments.filter(s=>s.boundaryVersionId===active.id)
  return allocate({boundaryVersion:active,segments:segs,reefs,sites,belts,corals,fishes})
}

await db.open()
await db.table('reefs').count() === 0
await seedDemoData()

// 记录外业底账指纹
const beltFingerprintBefore = JSON.stringify(await db.belts.toArray())
const coralCount = await db.corals.count()
const fishCount = await db.fishes.count()

let res = await loadAllocation()
console.log('== 初始版本 v%d ==', res.boundaryVersion)
res.reefSummaries.filter(r=>r.beltCount>0).forEach(r=>{
  console.log(`  ${r.reefName}: 样带${r.beltCount} 摊入${r.allocatedLengthM}m 覆盖${r.coverCm}cm 指数${r.bleachIndex} 鱼${r.fishTotal}`)
})
console.log('  挂起段:', res.pending.length, '整条挂起:', res.fullyPendingBeltNos)
const t02 = res.lines.filter(l=>l.beltNo==='T-02' && l.siteNo==='S-01')
console.log('  T-02(清澜S01) 分摊行:', t02.map(l=>`${l.reefId}:${(l.share*100).toFixed(0)}%`).join(' '))

// 1) 模拟界线发布失败
const reports = readFieldCrossReports()
const active = await getActiveBoundaryVersion()
const shifted: Record<string,any> = {}
Object.entries(active!.reefs).forEach(([reefId,ring])=>{
  if(reefId==='reef_ql01') shifted[reefId]=ring.map(([lng,lat])=> lng===Math.max(...SEED_RINGS.reef_ql01.map(p=>p[0]))?[lng+0.0004,lat]:[lng,lat])
  else if(reefId==='reef_lw04') shifted[reefId]=ring.map(([lng,lat])=> lng===Math.min(...SEED_RINGS.reef_lw04.map(p=>p[0]))?[lng+0.0004,lat]:[lng,lat])
  else shifted[reefId]=ring
})
let failed = false
try {
  await applyBoundaryRevision({reefs:shifted,note:'失败演示',publishedBy:'测绘室',fieldCrossReports:reports,failBoundaryPublish:true})
} catch(e) { failed = true; console.log('\n== 发布失败（预期）==', (e as Error).message.slice(0,30)) }
const failedRevs = await db.boundaryRevisions.where('state').equals('failed' as never).toArray()
console.log('  失败流水条数:', failedRevs.length)
const activeAfterFail = await getActiveBoundaryVersion()
console.log('  失败后仍是版本 v', activeAfterFail?.version, '（旧版保持激活）')
console.log('  外业 belts 指纹未变:', JSON.stringify(await db.belts.toArray())===beltFingerprintBefore, '| corals', await db.corals.count()===coralCount, '| fishes', await db.fishes.count()===fishCount)

// 2) 只重试界线这侧
const lastFailed = failedRevs[failedRevs.length-1]
const retryResult = await retryBoundaryOnly(
  {reefs:shifted,note:'重试',publishedBy:'测绘室',fieldCrossReports:reports},
  lastFailed
)
console.log('\n== 重试界线侧成功 == 版本 v', retryResult.version.version, '| 重算压线样带:', retryResult.recalculatedBeltNos)
console.log('  外业数据仍未变: corals', await db.corals.count()===coralCount, 'fishes', await db.fishes.count()===fishCount)

res = await loadAllocation()
console.log('\n== 重算后版本 v%d ==', res.boundaryVersion)
res.reefSummaries.filter(r=>r.beltCount>0).forEach(r=>{
  console.log(`  ${r.reefName}: 样带${r.beltCount} 摊入${r.allocatedLengthM}m 覆盖${r.coverCm}cm 指数${r.bleachIndex} 鱼${r.fishTotal}`)
})
const t02after = res.lines.filter(l=>l.beltNo==='T-02' && l.siteNo==='S-01')
console.log('  原跨界 T-02 现归属行数:', t02after.length, t02after.map(l=>`${l.reefId}:${(l.share*100).toFixed(0)}%`).join(' '))
const lwT01 = res.lines.filter(l=>l.beltNo==='T-01' && l.siteNo==='S-01')
console.log('  龙湾 T-01(对不上) 入统行数:', lwT01.length, '（应0，仍挂起）挂起段:', res.pending.length)

const revs = await db.boundaryRevisions.toArray()
console.log('\n流水:', revs.map(r=>`v${r.version}:${r.state}/重试${r.retries}/[${r.affectedBeltNos.join(',')}]`).join('  '))
console.log('\nfailed flag was:', failed)
