<script setup lang="ts">
/**
 * 界线测绘室页 /boundary：
 * - 管礁区边界线版本：一键发布「界线东移」的新版界线，重算压在旧线上的样带；
 * - 改界线失败演示：注入失败后只允许重试界线这侧，外业普查组数据全程不动；
 * - 两室按样带编号对账（外业上报跨界 × 几何切段跨界），对不上先挂起；
 * - 挂起样带不进礁区白化与导出，提供外业订正后重新对账入口。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, RefreshRight, Position } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import BleachTag from '@/components/common/BleachTag.vue'
import { useBoundaryStore } from '@/stores/boundaryStore'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { SEED_RINGS } from '@/utils/boundarySeed'
import { endpointFromOrientation, pointInRing } from '@/utils/geometry'
import type { Ring } from '@/types/boundary'
import type { FieldCrossReport } from '@/utils/reconcile'
import { exportAllocationCsv } from '@/utils/export'
import { initDatabase } from '@/utils/db'

const boundaryStore = useBoundaryStore()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()

const shiftDeg = ref(0.0004)
const publishNote = ref('保护区界线重新划过：清澜湾 / 龙湾界线东移')
const exportBusy = ref(false)

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
  boundaryStore.start()
})

const activeVersion = computed(() => boundaryStore.activeVersion)
const allocation = computed(() => boundaryStore.allocation)

const pendingNotices = computed(() => {
  const seen = new Map<string, (typeof boundaryStore.notices)[number]>()
  boundaryStore.notices
    .filter((notice) => notice.status === 'pending')
    .forEach((notice) => seen.set(notice.beltNo, notice))
  return Array.from(seen.values())
})

const matchedCrossNotices = computed(() => {
  const seen = new Map<string, (typeof boundaryStore.notices)[number]>()
  boundaryStore.notices
    .filter((notice) => notice.status === 'matched')
    .forEach((notice) => seen.set(notice.beltNo, notice))
  return Array.from(seen.values())
})

/** 构造界线东移后的新版各礁区外环：清澜湾东岸线 / 龙湾西岸线向东平移 */
function buildShiftedRings(): Record<string, Ring> {
  if (!activeVersion.value) return {}
  const delta = shiftDeg.value
  const next: Record<string, Ring> = {}
  Object.entries(activeVersion.value.reefs).forEach(([reefId, ring]) => {
    if (reefId === 'reef_ql01') {
      // 东界右移
      next[reefId] = ring.map(([lng, lat]) => (lng === Math.max(...SEED_RINGS.reef_ql01.map((p) => p[0])) ? [lng + delta, lat] : [lng, lat]))
    } else if (reefId === 'reef_lw04') {
      // 西界右移（两礁共边一起动）
      next[reefId] = ring.map(([lng, lat]) => (lng === Math.min(...SEED_RINGS.reef_lw04.map((p) => p[0])) ? [lng + delta, lat] : [lng, lat]))
    } else {
      next[reefId] = ring
    }
  })
  return next
}

function reefName(reefId: string | null): string {
  if (!reefId) return '界外'
  return reefStore.reefById(reefId)?.name ?? reefId
}

async function publish(shouldFail: boolean): Promise<void> {
  if (!activeVersion.value) {
    ElMessage.warning('尚无生效界线版本')
    return
  }
  const result = await boundaryStore.publishRevision({
    reefs: buildShiftedRings(),
    note: publishNote.value || `界线东移 ${(shiftDeg.value * 111320 * Math.cos((19.56 * Math.PI) / 180)).toFixed(0)} m`,
    publishedBy: '界线测绘室',
    fieldCrossReports: boundaryStore.fieldReports,
    failBoundaryPublish: shouldFail
  })
  if (result) {
    ElMessage.success(boundaryStore.message ?? '界线已发布并重算')
  } else {
    ElMessage.error(boundaryStore.error ?? '界线发布失败')
  }
}

async function retryBoundary(): Promise<void> {
  const result = await boundaryStore.retryFailedBoundary()
  if (result) ElMessage.success(boundaryStore.message ?? '界线侧重试成功')
  else ElMessage.error(boundaryStore.error ?? '重试失败')
}

/** 外业订正：用当前样带起止点重新判定两端礁区，覆盖错误上报后重新对账 */
async function correctByGeometry(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将由外业实测起止点重新判定跨界礁区，订正此前报错的上报并重新对账。挂起样带若两室一致即可销账入统。确认？',
      '外业订正后重新对账',
      { type: 'warning', confirmButtonText: '订正并重算', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  if (!activeVersion.value) return
  const rings = activeVersion.value.reefs
  const reports: FieldCrossReport[] = []
  beltStore.belts.forEach((belt) => {
    if (!belt.startCoord || !belt.endCoord || belt.geoSource === 'legacy_upgraded') return
    const startHits = Object.entries(rings).filter(([, ring]) => pointInRing(belt.startCoord as [number, number], ring)).map(([id]) => id)
    const endHits = Object.entries(rings).filter(([, ring]) => pointInRing(belt.endCoord as [number, number], ring)).map(([id]) => id)
    const startReefId = startHits[0] ?? null
    const endReefId = endHits[0] ?? null
    if (startReefId && endReefId && startReefId !== endReefId) {
      reports.push({
        beltId: belt.id,
        beltNo: belt.no,
        startReefId,
        endReefId,
        detail: `外业按实测起止点订正：${reefName(startReefId)} → ${reefName(endReefId)}`
      })
    }
  })
  const result = await boundaryStore.publishRevision({
    reefs: activeVersion.value.reefs,
    note: `界线不变（v${activeVersion.value.version}），外业订正跨界上报后重新对账`,
    publishedBy: activeVersion.value.publishedBy,
    fieldCrossReports: reports
  })
  if (result) ElMessage.success('已按实测起止点订正并重新对账')
}

async function exportCsv(): Promise<void> {
  exportBusy.value = true
  try {
    const result = await exportAllocationCsv()
    ElMessage.success(`已导出 ${result.fileName}：礁区 ${result.reefCount}、分摊行 ${result.lineCount}、挂起 ${result.pendingCount}`)
  } finally {
    exportBusy.value = false
  }
}

/** 段表展示数据 */
const segmentRows = computed(() =>
  boundaryStore.activeSegments
    .slice()
    .sort((a, b) => a.beltNo.localeCompare(b.beltNo, 'zh-Hans-CN') || a.ordinal - b.ordinal)
    .map((segment) => ({
      ...segment,
      reefName: reefName(segment.reefId),
      statusText: segment.status === 'matched' ? '入统' : '挂起'
    }))
)

const revisionRows = computed(() => boundaryStore.revisions.slice().sort((a, b) => b.version - a.version))

/** 演示：按样带起点坐标 + 朝向推算终点的说明（外业可核对） */
function previewEnd(beltId: string): string {
  const belt = beltStore.beltById(beltId)
  if (!belt || !belt.startCoord) return '—'
  const end = endpointFromOrientation(belt.startCoord, belt.orientation, belt.lengthM)
  return `${end[0].toFixed(4)}, ${end[1].toFixed(4)}`
}

void surveyStore
void RefreshRight
void Position
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">界线测绘室 · 礁区边界线与两室对账</h2>
        <p class="gb-hint">
          测绘室管礁区边界线；外业普查组管样带起止点、珊瑚覆盖与鱼类计数。跨界样带一律按段长分摊，
          礁区白化与导出共用同一口径；两边按样带编号对账，对不上先挂起，挂起段不入统不导出。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="RefreshRight" @click="correctByGeometry">外业订正后重新对账</el-button>
        <el-button type="primary" :icon="Download" :loading="exportBusy" @click="exportCsv">导出门槛 CSV</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="当前界线版本" :value="activeVersion ? `v${activeVersion.version}` : '—'" suffix="" icon="Position" />
      <StatBadge label="切段总数" :value="boundaryStore.activeSegments.length" suffix="段" tone="info" icon="Files" />
      <StatBadge label="两室一致跨界" :value="matchedCrossNotices.length" suffix="条" tone="success" icon="CircleCheckFilled" />
      <StatBadge label="挂起待核" :value="pendingNotices.length" suffix="条" :tone="pendingNotices.length ? 'danger' : 'success'" icon="WarningFilled" />
    </div>

    <el-alert v-if="boundaryStore.message" type="success" :closable="false" show-icon :title="boundaryStore.message" />
    <el-alert v-if="boundaryStore.error" type="error" :closable="false" show-icon :title="boundaryStore.error" />

    <!-- 改界线 -->
    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>重新划界线（只写界线测绘室侧）</h3>
        <span class="gb-hint">清澜湾与龙湾共边整体东移；压在旧线上的样带自动重算切段</span>
      </div>
      <el-form label-width="150px" inline>
        <el-form-item label="界线东移">
          <el-input-number v-model="shiftDeg" :min="0.0001" :max="0.002" :step="0.0001" :precision="4" controls-position="right" />
          <span class="page__unit">度（约 {{ Math.round(shiftDeg * 111320 * Math.cos((19.56 * Math.PI) / 180)) }} m）</span>
        </el-form-item>
        <el-form-item label="版本备注">
          <el-input v-model="publishNote" style="width: 320px" maxlength="60" />
        </el-form-item>
      </el-form>
      <div class="page__btns">
        <el-button type="primary" :loading="boundaryStore.busy" @click="publish(false)">发布新版界线并重算</el-button>
        <el-button type="warning" plain :loading="boundaryStore.busy" @click="publish(true)">模拟发布失败</el-button>
        <el-button
          type="danger"
          :disabled="!boundaryStore.lastFailed"
          :loading="boundaryStore.busy"
          @click="retryBoundary"
        >
          只重试界线这侧{{ boundaryStore.lastFailed ? `（已失败 ${boundaryStore.lastFailed.revision.retries} 次）` : '' }}
        </el-button>
      </div>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="发布失败时外业普查组的样带、珊瑚覆盖与鱼类计数不会被改动；点「只重试界线这侧」成功后继续重算切段。"
      />
    </el-card>

    <!-- 礁区分摊汇总（与导出同口径） -->
    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>礁区白化分摊汇总（界线 v{{ allocation?.boundaryVersion ?? '—' }}）</h3>
        <span class="gb-hint">覆盖与鱼类按段长 share 摊入；指数 = 摊入覆盖长度加权白化等级；与导出 CSV 同函数</span>
      </div>
      <el-table :data="allocation?.reefSummaries ?? []" border stripe class="gb-table-compact">
        <el-table-column prop="reefName" label="礁区" min-width="150" />
        <el-table-column prop="protectStatus" label="保护区状态" width="110" />
        <el-table-column label="摊入样带" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.beltCount }} 条</span></template>
        </el-table-column>
        <el-table-column label="摊入长度" width="110" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.allocatedLengthM }} m</span></template>
        </el-table-column>
        <el-table-column label="覆盖率" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.coveragePct }}%</span></template>
        </el-table-column>
        <el-table-column label="白化评定" width="170">
          <template #default="{ row }">
            <BleachTag :level="row.grade" size="small" />
            <span class="gb-hint gb-mono"> 指数 {{ row.bleachIndex }}</span>
          </template>
        </el-table-column>
        <el-table-column label="白化占比" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.bleachedSharePct }}%</span></template>
        </el-table-column>
        <el-table-column label="摊入鱼类" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.fishTotal }} 尾</span></template>
        </el-table-column>
        <el-table-column label="鱼类密度" width="130" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.fishDensity }} 尾/100m²</span></template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无分摊结果" description="发布界线版本后自动生成切段与礁区汇总。" compact />
        </template>
      </el-table>
    </el-card>

    <!-- 两室对账 -->
    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>两室按样带编号对账</h3>
        <span class="gb-hint">外业上报跨界 × 测绘几何跨界；礁区集合一致 → 一致，否则先挂起</span>
      </div>

      <h4 class="page__subhead">挂起待核（{{ pendingNotices.length }}）</h4>
      <el-table :data="pendingNotices" border stripe class="gb-table-compact">
        <el-table-column prop="beltNo" label="样带编号" width="100" />
        <el-table-column label="测绘室（几何切段）" min-width="200">
          <template #default="{ row }">
            <span v-if="row.side === 'survey'">—</span>
            <span v-else>{{ reefName(row.startReefId) }} → {{ reefName(row.endReefId) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="外业普查组（实测上报）" min-width="200">
          <template #default="{ row }">
            <span v-if="row.side === 'office'">—</span>
            <span v-else>{{ reefName(row.startReefId) }} → {{ reefName(row.endReefId) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="说明" min-width="220" />
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }"><el-tag size="small" type="danger" effect="plain">挂起</el-tag></template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="没有挂起样带" description="两室按样带编号全部对得上。" compact />
        </template>
      </el-table>

      <h4 class="page__subhead">两室一致、已按段长分摊（{{ matchedCrossNotices.length }}）</h4>
      <el-table :data="matchedCrossNotices" border stripe class="gb-table-compact">
        <el-table-column prop="beltNo" label="样带编号" width="100" />
        <el-table-column label="跨界礁区（一致）" min-width="260">
          <template #default="{ row }">{{ reefName(row.startReefId) }} → {{ reefName(row.endReefId) }}</template>
        </el-table-column>
        <el-table-column prop="detail" label="说明" min-width="220" />
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }"><el-tag size="small" type="success" effect="plain">一致</el-tag></template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无一致的跨界样带" description="界线东移后跨两礁的样带会在此列示。" compact />
        </template>
      </el-table>
    </el-card>

    <!-- 切段明细 -->
    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>样带切段明细（按段长分摊比例 share）</h3>
        <span class="gb-hint">旧数据升级的整段样带起点＝终点，按站位坐标做点归属</span>
      </div>
      <el-table :data="segmentRows" border stripe class="gb-table-compact" max-height="420">
        <el-table-column prop="beltNo" label="样带编号" width="90" />
        <el-table-column label="段序" width="60" align="center">
          <template #default="{ row }">#{{ row.ordinal + 1 }}</template>
        </el-table-column>
        <el-table-column prop="reefName" label="归属礁区" min-width="150" />
        <el-table-column label="沿样带 (m)" width="130" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.startM }} ~ {{ row.endM }}</span></template>
        </el-table-column>
        <el-table-column label="段长" width="90" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.lengthM }} m</span></template>
        </el-table-column>
        <el-table-column label="分摊比例" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ (row.share * 100).toFixed(1) }}%</span></template>
        </el-table-column>
        <el-table-column label="推算终点核对" width="170">
          <template #default="{ row }"><span class="gb-hint gb-mono">{{ previewEnd(row.beltId) }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'matched' ? 'success' : 'danger'" effect="plain">{{ row.statusText }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="原因" min-width="180" />
      </el-table>
    </el-card>

    <!-- 改线流水 -->
    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>改线流水（失败只重试界线侧）</h3>
      </div>
      <el-table :data="revisionRows" border stripe class="gb-table-compact">
        <el-table-column label="版本" width="80" align="center">
          <template #default="{ row }">v{{ row.version }}</template>
        </el-table-column>
        <el-table-column prop="state" label="状态" width="100" />
        <el-table-column label="重试" width="70" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.retries }}</span></template>
        </el-table-column>
        <el-table-column label="重算压线样带" min-width="160">
          <template #default="{ row }">{{ row.affectedBeltNos.join('、') || '—' }}</template>
        </el-table-column>
        <el-table-column prop="message" label="信息" min-width="260" />
      </el-table>
    </el-card>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}
.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #7c9995;
}
.page__btns {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 10px 0;
}
.page__subhead {
  margin: 14px 0 8px;
  font-size: 14px;
  color: #0b5d5a;
}
</style>
