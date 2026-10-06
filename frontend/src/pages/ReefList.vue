<script setup lang="ts">
/**
 * 模块 1：/reefs 礁区台账
 * 新建礁区、按保护区状态筛选；卡片汇总站位总数与本礁区平均白化指数。
 * 复用 <FilterBar>、<EmptyPanel>。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, MagicStick, Plus, Right } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import { buildQuery, queryToArray, queryToNumber } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import BleachTag from '@/components/common/BleachTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { AREA_BUCKETS, createEmptyReefFilter, PROTECT_STATUSES } from '@/types/reef'
import type { LatLng, ProtectStatus, Reef } from '@/types/reef'
import { validateBoundary } from '@/types/reef'
import { aggregateAllReefs } from '@/utils/reefAggregation'
import { initDatabase } from '@/utils/db'
import type { BoundaryChangeReport } from '@/utils/boundarySettle'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const areaBucket = ref(AREA_BUCKETS[0].label)
const form = reactive({
  name: '',
  location: '',
  areaKm2: 10,
  protectStatus: '实验区' as ProtectStatus,
  manager: ''
})

/* --------------------------- 界线测绘室：礁区界线 --------------------------- */
const boundaryDialogVisible = ref(false)
const boundaryReef = ref<Reef | null>(null)
const boundarySaving = ref(false)
const boundaryDraft = ref<Array<{ lat: number; lng: number }>>([])
const lastBoundaryReport = ref<BoundaryChangeReport | null>(null)

/** 界线点文本：每行「纬度,经度」，方便测绘室批量粘贴 */
const boundaryText = computed({
  get: () => boundaryDraft.value.map((point) => `${point.lat},${point.lng}`).join('\n'),
  set: (value: string) => {
    boundaryDraft.value = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [lat, lng] = line.split(/[,，\s\t]+/).map((cell) => Number(cell))
        return { lat, lng }
      })
  }
})

const boundaryErrors = computed<string[]>(() => validateBoundary(boundaryDraft.value as LatLng[]))

function openBoundary(reef: Reef): void {
  boundaryReef.value = reef
  boundaryDraft.value = reef.boundaryPolygon.map((point) => ({ ...point }))
  lastBoundaryReport.value = null
  boundaryDialogVisible.value = true
}

function addBoundaryPoint(): void {
  const last = boundaryDraft.value[boundaryDraft.value.length - 1] ?? { lat: 18.5, lng: 110.5 }
  boundaryDraft.value.push({ lat: last.lat, lng: last.lng })
}

function removeBoundaryPoint(index: number): void {
  boundaryDraft.value.splice(index, 1)
}

/** 界线先单独落库；失败只停在界线这侧，成功后系统只重算压旧线的样带 */
async function submitBoundary(): Promise<void> {
  if (!boundaryReef.value) return
  if (boundaryErrors.value.length > 0) {
    ElMessage.warning(`界线校验未通过：${boundaryErrors.value.join('；')}`)
    return
  }
  boundarySaving.value = true
  try {
    const report = await reefStore.saveBoundary(boundaryReef.value.id, boundaryDraft.value as LatLng[])
    lastBoundaryReport.value = report
    boundaryReef.value = reefStore.reefById(boundaryReef.value.id)
    const pendingText =
      report.pendingBeltNos.length > 0 ? `；挂账样带：${report.pendingBeltNos.join('、')}` : ''
    ElMessage.success(
      `界线已保存（修订序号 ${report.boundaryRev}），按编号重算 ${report.reconciled.length} 条压旧线样带${pendingText}`
    )
  } catch (error) {
    // 界线校验 / 落库失败：样带一侧未做任何改动，只提示重试界线这侧
    ElMessage.error(error instanceof Error ? error.message : '界线保存失败，请仅重试界线修改')
  } finally {
    boundarySaving.value = false
  }
}

/** 礁区卡片：站位 / 压线样带 / 段长分摊后的珊瑚覆盖与白化指数（与导出同一口径） */
const cards = computed(() => {
  const aggregations = aggregateAllReefs({
    reefs: reefStore.reefs,
    sites: reefStore.sites,
    belts: beltStore.belts,
    corals: surveyStore.corals,
    fishes: surveyStore.fishes
  })
  const aggByReef = new Map(aggregations.map((agg) => [agg.reefId, agg]))
  return reefStore.filteredReefs.map((reef: Reef) => {
    const sites = reefStore.sites.filter((site) => site.reefId === reef.id)
    const agg = aggByReef.get(reef.id)
    return {
      reef,
      siteCount: sites.length,
      beltCount: agg?.beltCount ?? 0,
      coralCount: agg?.coralCount ?? 0,
      fishTotal: agg?.fishTotal ?? 0,
      bleachIndex: agg?.bleachIndex ?? 0,
      grade: agg?.grade ?? '无',
      pendingBeltNos: agg?.pendingBeltNos ?? []
    }
  })
})

const filterModel = computed<FilterModel>(() => ({
  keyword: reefStore.filter.keyword,
  protectStatuses: reefStore.filter.protectStatuses,
  minAreaKm2: reefStore.filter.minAreaKm2,
  maxAreaKm2: reefStore.filter.maxAreaKm2
}))

const totals = computed(() => ({
  reefs: cards.value.length,
  sites: cards.value.reduce((sum, card) => sum + card.siteCount, 0),
  belts: cards.value.reduce((sum, card) => sum + card.beltCount, 0),
  corals: cards.value.reduce((sum, card) => sum + card.coralCount, 0),
  avgBleachIndex:
    cards.value.length === 0
      ? 0
      : Number((cards.value.reduce((sum, card) => sum + card.bleachIndex, 0) / cards.value.length).toFixed(2))
}))

async function syncQuery(): Promise<void> {
  const query = buildQuery({
    kw: reefStore.filter.keyword,
    status: reefStore.filter.protectStatuses,
    minArea: reefStore.filter.minAreaKm2,
    maxArea: reefStore.filter.maxAreaKm2
  })
  await router.replace({ query })
}

function applyQuery(): void {
  const query = route.query
  reefStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    protectStatuses: queryToArray(query.status) as ProtectStatus[],
    minAreaKm2: queryToNumber(query.minArea),
    maxAreaKm2: queryToNumber(query.maxArea)
  })
  const bucket = AREA_BUCKETS.find(
    (item) => item.min === reefStore.filter.minAreaKm2 && item.max === reefStore.filter.maxAreaKm2
  )
  areaBucket.value = bucket ? bucket.label : AREA_BUCKETS[0].label
}

function handleFilterChange(): void {
  void syncQuery()
}

function handleBucketChange(label: string): void {
  const bucket = AREA_BUCKETS.find((item) => item.label === label)
  reefStore.patchFilter({ minAreaKm2: bucket?.min ?? null, maxAreaKm2: bucket?.max ?? null })
  void syncQuery()
}

function handleReset(): void {
  reefStore.resetFilter()
  areaBucket.value = AREA_BUCKETS[0].label
  void syncQuery()
}

function openCreate(): void {
  editingId.value = null
  form.name = ''
  form.location = ''
  form.areaKm2 = 10
  form.protectStatus = '实验区'
  form.manager = ''
  dialogVisible.value = true
}

function openEdit(reef: Reef): void {
  editingId.value = reef.id
  form.name = reef.name
  form.location = reef.location
  form.areaKm2 = reef.areaKm2
  form.protectStatus = reef.protectStatus
  form.manager = reef.manager
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('请填写礁区名称')
    return
  }
  if (!Number.isFinite(form.areaKm2) || form.areaKm2 <= 0) {
    ElMessage.warning('面积应为大于 0 的数字（km²）')
    return
  }
  submitting.value = true
  try {
    if (editingId.value) {
      await reefStore.updateReef(editingId.value, { ...form })
      ElMessage.success('礁区信息已更新')
    } else {
      const created = await reefStore.createReef({
        ...form,
        boundaryPolygon: [],
        boundaryRev: 0,
        boundaryUpdatedAt: null
      })
      reefStore.selectReef(created.id)
      ElMessage.success('礁区已新建，可进入站位布设')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeReef(reef: Reef): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除礁区「${reef.name}」将同时删除其站位、样带、珊瑚记录与鱼类计数，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await reefStore.removeReef(reef.id)
  ElMessage.success('礁区及其下级数据已删除')
}

function gotoSites(reef: Reef): void {
  reefStore.selectReef(reef.id)
  void router.push(`/reefs/${reef.id}/sites`)
}

async function reseed(): Promise<void> {
  await initDatabase()
  ElMessage.success('已按需补齐演示数据（幂等播种）')
}

onMounted(() => {
  applyQuery()
  if (reefStore.reefs.length === 0) void reseed()
})

watch(
  () => route.query,
  () => {
    if (route.path !== '/reefs') return
    applyQuery()
  }
)
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">礁区台账</h2>
        <p class="gb-hint">
          维护礁区基本信息与保护区状态，卡片汇总站位总数、样带条数与平均白化指数。点击「站位布设」进入子页面。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建礁区</el-button>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'protectStatuses',
          label: '保护区状态',
          options: PROTECT_STATUSES.map((item) => ({ label: item, value: item }))
        }
      ]"
      keyword-placeholder="搜索礁区名 / 位置 / 管理单位"
      @change="handleFilterChange"
      @reset="handleReset"
    >
      <template #extra>
        <div class="page__bucket">
          <span class="page__bucket-label">礁区面积</span>
          <el-select :model-value="areaBucket" class="page__bucket-select" @change="handleBucketChange">
            <el-option v-for="bucket in AREA_BUCKETS" :key="bucket.label" :label="bucket.label" :value="bucket.label" />
          </el-select>
        </div>
      </template>
      <template #actions>
        <el-button size="small" :icon="MagicStick" @click="reseed">补齐演示数据</el-button>
      </template>
    </FilterBar>

    <div class="gb-stats-row">
      <StatBadge label="筛选后礁区" :value="totals.reefs" suffix="个" icon="Odometer" />
      <StatBadge label="站位总数" :value="totals.sites" suffix="个" tone="info" icon="Grid" />
      <StatBadge label="样带总数" :value="totals.belts" suffix="条" tone="success" icon="Files" />
      <StatBadge label="珊瑚记录" :value="totals.corals" suffix="条" icon="Histogram" />
      <StatBadge
        label="平均白化指数"
        :value="totals.avgBleachIndex"
        suffix="/ 4"
        :tone="totals.avgBleachIndex > 1 ? 'warning' : 'success'"
        :icon="totals.avgBleachIndex > 1 ? 'WarningFilled' : 'DataLine'"
      />
    </div>

    <EmptyPanel
      v-if="cards.length === 0"
      :title="reefStore.hasFilter ? '没有符合条件的礁区' : '还没有礁区'"
      :description="
        reefStore.hasFilter
          ? '当前筛选条件（保护区状态 / 面积 / 关键字）下没有礁区，可重置条件或新建一个礁区。'
          : '新建第一个礁区后即可布设站位、样带并录入珊瑚分类覆盖与鱼类计数。'
      "
      action-text="新建礁区"
      secondary-text="重置筛选"
      @action="openCreate"
      @secondary="handleReset"
    />

    <div v-else class="reef-grid">
      <el-card v-for="card in cards" :key="card.reef.id" shadow="hover" class="reef-card">
        <template #header>
          <div class="reef-card__head">
            <div>
              <strong class="reef-card__name">{{ card.reef.name }}</strong>
              <el-tag size="small" effect="plain" class="reef-card__status">{{ card.reef.protectStatus }}</el-tag>
            </div>
            <BleachTag :level="card.grade" size="small" />
          </div>
        </template>

        <div class="reef-card__stats">
          <StatBadge label="站位" :value="card.siteCount" suffix="个" size="small" tone="info" icon="Grid" />
          <StatBadge label="样带" :value="card.beltCount" suffix="条" size="small" icon="Files" />
          <StatBadge label="珊瑚记录" :value="card.coralCount" suffix="条" size="small" tone="success" icon="Histogram" />
          <StatBadge
            label="白化指数"
            :value="card.bleachIndex"
            suffix="/ 4"
            size="small"
            :tone="card.bleachIndex > 1 ? 'warning' : 'success'"
            icon="TrendCharts"
          />
        </div>

        <div class="reef-card__meta">
          <span>面积 <b class="gb-mono">{{ card.reef.areaKm2 }}</b> km²</span>
          <span>鱼获计数 <b class="gb-mono">{{ card.fishTotal }}</b></span>
          <span v-if="card.reef.manager">管理单位：{{ card.reef.manager }}</span>
        </div>

        <p v-if="card.reef.location" class="reef-card__location">{{ card.reef.location }}</p>

        <div class="reef-card__boundary">
          <el-tag size="small" :type="card.reef.boundaryPolygon.length > 0 ? 'success' : 'info'" effect="plain">
            {{ card.reef.boundaryPolygon.length > 0 ? `界线已测绘（${card.reef.boundaryPolygon.length} 顶点 · 修订 ${card.reef.boundaryRev}）` : '界线未测绘' }}
          </el-tag>
          <el-tag v-if="card.pendingBeltNos.length > 0" size="small" type="danger" effect="plain">
            挂账样带 {{ card.pendingBeltNos.join('、') }}
          </el-tag>
        </div>

        <div class="reef-card__actions">
          <el-button type="primary" size="small" :icon="Right" @click="gotoSites(card.reef)">站位布设</el-button>
          <el-button size="small" @click="openBoundary(card.reef)">界线测绘</el-button>
          <el-button size="small" :icon="Edit" @click="openEdit(card.reef)">编辑</el-button>
          <el-button size="small" type="danger" plain :icon="Delete" @click="removeReef(card.reef)">删除</el-button>
        </div>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑礁区' : '新建礁区'" width="540px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="礁区名称" required>
          <el-input v-model="form.name" placeholder="如：清澜湾珊瑚礁区" maxlength="40" show-word-limit />
        </el-form-item>
        <el-form-item label="位置">
          <el-input v-model="form.location" placeholder="如：海南文昌清澜湾东侧 3.5 km 海域" maxlength="80" />
        </el-form-item>
        <el-form-item label="面积" required>
          <el-input-number v-model="form.areaKm2" :min="0.01" :max="100000" :step="0.1" :precision="2" controls-position="right" />
          <span class="page__unit">km²</span>
        </el-form-item>
        <el-form-item label="保护区状态" required>
          <el-radio-group v-model="form.protectStatus">
            <el-radio-button v-for="status in PROTECT_STATUSES" :key="status" :value="status">{{ status }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="管理单位">
          <el-input v-model="form.manager" placeholder="如：清澜湾海洋保护站" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新建并布设站位' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="boundaryDialogVisible"
      :title="`界线测绘 · ${boundaryReef?.name ?? ''}`"
      width="720px"
      :close-on-click-modal="false"
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="界线测绘室只维护礁区边界线；保存后系统自动重算压在旧线上的样带。界线校验失败时只重试本侧，样带起止点与覆盖计数不受影响。"
        class="reef-boundary__alert"
      />
      <div class="reef-boundary">
        <div class="reef-boundary__points">
          <div v-for="(point, index) in boundaryDraft" :key="index" class="reef-boundary__row">
            <span class="gb-mono reef-boundary__idx">{{ index + 1 }}</span>
            <el-input-number v-model="point.lat" :min="-90" :max="90" :step="0.0001" :precision="4" controls-position="right" size="small" />
            <el-input-number v-model="point.lng" :min="-180" :max="180" :step="0.0001" :precision="4" controls-position="right" size="small" />
            <el-button size="small" type="danger" text :icon="Delete" @click="removeBoundaryPoint(index)" />
          </div>
          <el-button size="small" :icon="Plus" plain @click="addBoundaryPoint">追加顶点</el-button>
          <p v-if="boundaryDraft.length > 0 && boundaryDraft.length < 3" class="reef-boundary__hint">
            至少需要 3 个顶点才能围成礁区界线
          </p>
        </div>
        <div class="reef-boundary__paste">
          <span class="reef-boundary__hint">批量粘贴：每行「纬度,经度」</span>
          <el-input
            :model-value="boundaryText"
            type="textarea"
            :rows="8"
            placeholder="19.5660,110.7860&#10;19.5660,110.8140"
            @update:model-value="boundaryText = $event"
          />
          <ul v-if="boundaryErrors.length > 0" class="reef-boundary__errors">
            <li v-for="error in boundaryErrors" :key="error">{{ error }}</li>
          </ul>
        </div>
      </div>

      <el-alert
        v-if="lastBoundaryReport"
        type="success"
        :closable="false"
        show-icon
        :title="
          `已按样带编号重算 ${lastBoundaryReport.reconciled.length} 条压旧线样带：跨界 ${lastBoundaryReport.crossedBeltNos.length} 条、挂账 ${lastBoundaryReport.pendingBeltNos.length} 条。`
        "
        class="reef-boundary__alert"
      />

      <template #footer>
        <el-button @click="boundaryDialogVisible = false">关闭</el-button>
        <el-button type="primary" :loading="boundarySaving" @click="submitBoundary">保存界线并重算样带</el-button>
      </template>
    </el-dialog>
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

.page__bucket {
  display: flex;
  align-items: center;
  gap: 6px;
}

.page__bucket-label {
  font-size: 13px;
  color: #4c6663;
}

.page__bucket-select {
  width: 160px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #7c9995;
}

.reef-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 14px;
}

.reef-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.reef-card__name {
  font-size: 16px;
  color: #10312f;
}

.reef-card__status {
  margin-left: 8px;
}

.reef-card__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}

.reef-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 13px;
  color: #4c6663;
}

.reef-card__location {
  margin: 8px 0 0;
  font-size: 12px;
  color: #7c9995;
  line-height: 1.7;
}

.reef-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.reef-card__boundary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.reef-boundary {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(260px, 1fr);
  gap: 16px;
  margin-top: 10px;
}

.reef-boundary__alert {
  margin-top: 8px;
}

.reef-boundary__points {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}

.reef-boundary__row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.reef-boundary__idx {
  width: 20px;
  color: #4c6663;
}

.reef-boundary__paste {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.reef-boundary__hint {
  margin: 2px 0;
  font-size: 12px;
  color: #7c9995;
}

.reef-boundary__errors {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: #c0392b;
}
</style>
