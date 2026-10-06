<script setup lang="ts">
/**
 * 模块 3：/sites/:id/belts 样带布设（外业普查组）
 * 录长度/朝向/调查日期及起止点坐标，回显已录记录数；
 * 列表展示界线切段后的礁区归属与两室对账状态（matched 入统 / pending 先挂起）。
 * 复用 <StatBadge>、<EmptyPanel>、<BleachTag>。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Right, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import BleachTag from '@/components/common/BleachTag.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { ORIENTATION_ORDER, useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useBoundaryStore } from '@/stores/boundaryStore'
import { BELT_LENGTH_PRESETS, ORIENTATIONS } from '@/types/belt'
import type { Belt, Orientation } from '@/types/belt'
import type { LngLat } from '@/types/boundary'
import { bleachGrade, bleachIndex, coralCoveragePct, fishDensity } from '@/utils/bleach'
import { endpointFromOrientation } from '@/utils/geometry'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()
const boundaryStore = useBoundaryStore()

const siteId = computed(() => String(route.params.id ?? ''))
const site = computed(() => reefStore.siteById(siteId.value))
const reef = computed(() => (site.value ? reefStore.reefById(site.value.reefId) : null))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  no: '',
  lengthM: 50,
  orientation: '北' as Orientation,
  surveyDate: new Date().toISOString().slice(0, 10),
  observer: '',
  startLng: 0,
  startLat: 0,
  endLng: 0,
  endLat: 0,
  autoEndpoint: true
})

/** 某样带的切段归属（当前界线版本） */
function segmentInfo(beltId: string) {
  const segments = boundaryStore.segmentsOfBelt(beltId)
  const reefNames = segments
    .map((segment) => (segment.reefId ? reefStore.reefById(segment.reefId)?.name ?? '未知礁区' : '界外'))
  const pending = segments.some((segment) => segment.status !== 'matched')
  const reefIds = new Set(segments.map((segment) => segment.reefId).filter((id): id is string => Boolean(id)))
  return {
    count: segments.length,
    reefNames: Array.from(new Set(reefNames)),
    cross: reefIds.size >= 2,
    pending,
    segments
  }
}

/** 样带各切段长度拼接，如 24m + 26m */
function segmentLengths(beltId: string): string {
  return boundaryStore
    .segmentsOfBelt(beltId)
    .map((segment) => `${segment.lengthM}m`)
    .join(' + ')
}

/** 样带行：回显珊瑚记录数、鱼类记录数、覆盖率与白化指数 */
const rows = computed(() =>
  beltStore.beltsOfSite(siteId.value).map((belt) => {
    const corals = surveyStore.coralsOfBelt(belt.id)
    const fishes = surveyStore.fishesOfBelt(belt.id)
    const coverCmTotal = corals.reduce((sum, coral) => sum + coral.coverCm, 0)
    const index = bleachIndex(corals)
    const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
    return {
      belt,
      coralCount: corals.length,
      fishCount: fishes.length,
      coverCmTotal,
      coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
      bleachIndex: index,
      grade: bleachGrade(index),
      fishDensity: fishDensity(fishTotal, belt.lengthM),
      geo: segmentInfo(belt.id)
    }
  })
)

const conflicts = computed(() => beltStore.findBeltConflicts(siteId.value))

const stats = computed(() => {
  const belts = beltStore.beltsOfSite(siteId.value)
  const totalLength = belts.reduce((sum, belt) => sum + belt.lengthM, 0)
  const coralCount = belts.reduce((sum, belt) => sum + surveyStore.coralsOfBelt(belt.id).length, 0)
  const fishCount = belts.reduce((sum, belt) => sum + surveyStore.fishesOfBelt(belt.id).length, 0)
  const crossCount = belts.filter((belt) => segmentInfo(belt.id).cross).length
  const pendingCount = belts.filter((belt) => segmentInfo(belt.id).pending).length
  return {
    beltCount: belts.length,
    totalLength,
    coralCount,
    fishCount,
    crossCount,
    pendingCount,
    orientationCount: new Set(belts.map((belt) => belt.orientation)).size
  }
})

function nextNo(): string {
  const numbers = beltStore
    .beltsOfSite(siteId.value)
    .map((belt) => Number(belt.no.replace(/[^0-9]/g, '')))
    .filter((value) => Number.isFinite(value))
  const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1
  return `T-${String(next).padStart(2, '0')}`
}

/** 按当前表单起点 / 朝向 / 长度推算终点 */
function syncAutoEndpoint(): void {
  if (!form.autoEndpoint) return
  const start: LngLat = [form.startLng, form.startLat]
  const end = endpointFromOrientation(start, form.orientation, form.lengthM)
  form.endLng = end[0]
  form.endLat = end[1]
}

function openCreate(): void {
  editingId.value = null
  const existing = beltStore.beltsOfSite(siteId.value)
  form.no = nextNo()
  form.lengthM = existing[0]?.lengthM ?? 50
  form.orientation = ORIENTATIONS[existing.length % ORIENTATIONS.length]
  form.surveyDate = new Date().toISOString().slice(0, 10)
  form.observer = existing[0]?.observer ?? ''
  // 默认起点取站位坐标（外业实测时可改）
  form.startLng = site.value?.lng ?? 0
  form.startLat = site.value?.lat ?? 0
  form.autoEndpoint = true
  syncAutoEndpoint()
  dialogVisible.value = true
}

function openEdit(belt: Belt): void {
  editingId.value = belt.id
  form.no = belt.no
  form.lengthM = belt.lengthM
  form.orientation = belt.orientation
  form.surveyDate = belt.surveyDate
  form.observer = belt.observer
  form.startLng = belt.startCoord?.[0] ?? site.value?.lng ?? 0
  form.startLat = belt.startCoord?.[1] ?? site.value?.lat ?? 0
  form.endLng = belt.endCoord?.[0] ?? form.startLng
  form.endLat = belt.endCoord?.[1] ?? form.startLat
  form.autoEndpoint = belt.geoSource === 'legacy_upgraded' || !belt.endCoord
  syncAutoEndpoint()
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.no.trim()) {
    ElMessage.warning('请填写样带编号')
    return
  }
  if (!Number.isFinite(form.lengthM) || form.lengthM <= 0) {
    ElMessage.warning('样带长度应为大于 0 的数字（m）')
    return
  }
  if (!form.surveyDate) {
    ElMessage.warning('请选择调查日期')
    return
  }
  if (![form.startLng, form.startLat, form.endLng, form.endLat].every((value) => Number.isFinite(value))) {
    ElMessage.warning('请填写合法的起点 / 终点经纬度')
    return
  }
  const duplicated = beltStore
    .beltsOfSite(siteId.value)
    .some((belt) => belt.no === form.no.trim() && belt.orientation === form.orientation && belt.id !== editingId.value)
  if (duplicated) {
    ElMessage.warning(`同一朝向（${form.orientation}）下样带编号「${form.no.trim()}」已存在`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      no: form.no.trim(),
      lengthM: form.lengthM,
      orientation: form.orientation,
      surveyDate: form.surveyDate,
      observer: form.observer.trim(),
      startCoord: [form.startLng, form.startLat] as LngLat,
      endCoord: [form.endLng, form.endLat] as LngLat,
      // 外业表单录入（含按朝向推算终点）一律记实测；legacy_upgraded 只由旧数据升级产生
      geoSource: 'field'
    } as const
    if (editingId.value) {
      await beltStore.updateBelt(editingId.value, payload)
      ElMessage.success('样带已更新，若起止点压在界线上请在界线测绘页重算')
    } else {
      const created = await beltStore.createBelt(siteId.value, payload)
      beltStore.selectBelt(created.id)
      ElMessage.success(`样带 ${created.no}（${created.orientation}向 ${created.lengthM} m）已布设，可录入底质与珊瑚计数`)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeBelt(belt: Belt): Promise<void> {
  const counts = surveyStore.beltRecordCounts[belt.id] ?? { coralCount: 0, fishCount: 0 }
  try {
    await ElMessageBox.confirm(
      `删除样带「${belt.no}」将同时删除其 ${counts.coralCount} 条珊瑚记录与 ${counts.fishCount} 条计数记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await beltStore.removeBelt(belt.id)
  ElMessage.success('样带及其记录已删除')
}

async function applyOrientationOrder(): Promise<void> {
  const belts = beltStore.beltsOfSite(siteId.value)
  if (belts.length === 0) {
    ElMessage.warning('当前站位还没有样带')
    return
  }
  const ordered = [...belts].sort(
    (a, b) => ORIENTATION_ORDER[a.orientation] - ORIENTATION_ORDER[b.orientation]
  )
  ElMessage.success(
    `朝向排序校验通过：${ordered.map((belt) => `${belt.orientation}向 ${belt.no}`).join(' → ')}`
  )
}

function gotoCorals(belt: Belt): void {
  beltStore.selectBelt(belt.id)
  void router.push(`/belts/${belt.id}/corals`)
}

function gotoFishes(belt: Belt): void {
  beltStore.selectBelt(belt.id)
  void router.push(`/belts/${belt.id}/fishes`)
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
  boundaryStore.start()
  if (site.value) reefStore.selectSite(site.value.id)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!reefStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!site"
      entity-label="站位"
      :missing-id="siteId"
      fallback-path="/reefs"
      fallback-text="返回礁区台账"
      :candidates="
        reefStore.sites.slice(0, 3).map((item) => ({
          id: item.id,
          label: `站位 ${item.no} 的样带`,
          path: `/sites/${item.id}/belts`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/reefs' }">礁区台账</el-breadcrumb-item>
            <el-breadcrumb-item v-if="reef" :to="{ path: `/reefs/${reef.id}/sites` }">{{ reef.name }} 站位</el-breadcrumb-item>
            <el-breadcrumb-item>样带布设</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            站位 {{ site.no }} · 样带布设
            <el-tag size="small" effect="plain">水深 {{ site.depthM }} m</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ site.substrate }}</el-tag>
          </h2>
          <p class="gb-hint">
            外业普查组管样带起止点、珊瑚覆盖与鱼类计数；跨界样带按段长分摊，列表显示切段归属与两室对账状态。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="Warning" @click="applyOrientationOrder">朝向排序校验</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增样带</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="样带条数" :value="stats.beltCount" suffix="条" icon="Files" />
        <StatBadge label="累计长度" :value="stats.totalLength" suffix="m" tone="info" icon="Odometer" />
        <StatBadge label="跨界样带" :value="stats.crossCount" suffix="条" tone="warning" icon="Position" />
        <StatBadge label="挂起待核" :value="stats.pendingCount" suffix="条" :tone="stats.pendingCount ? 'danger' : 'success'" icon="WarningFilled" />
      </div>

      <el-alert
        v-if="conflicts.length > 0"
        type="warning"
        show-icon
        :closable="false"
        :title="`朝向排序校验提示：${conflicts.join('、')} 存在重复编号，请调整后再开展普查`"
      />

      <EmptyPanel
        v-if="rows.length === 0"
        title="该站位还没有样带"
        description="新增第一条样带并录入长度、朝向与起止点，随后即可录入底质、珊瑚分类覆盖与鱼类计数。"
        action-text="新增样带"
        @action="openCreate"
      />

      <el-table v-else :data="rows" border stripe class="gb-table-compact">
        <el-table-column prop="belt.no" label="样带编号" width="100" />
        <el-table-column label="朝向" width="80" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.belt.orientation }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="长度 (m)" width="92" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.belt.length }}</span>
          </template>
        </el-table-column>
        <el-table-column label="起止点" min-width="190">
          <template #default="{ row }">
            <div class="gb-hint gb-mono">起 {{ row.belt.startCoord?.[0]?.toFixed(4) ?? '—' }}, {{ row.belt.startCoord?.[1]?.toFixed(4) ?? '—' }}</div>
            <div class="gb-hint gb-mono">止 {{ row.belt.endCoord?.[0]?.toFixed(4) ?? '—' }}, {{ row.belt.endCoord?.[1]?.toFixed(4) ?? '—' }}</div>
            <el-tag v-if="row.belt.geoSource === 'legacy_upgraded'" size="small" type="info" effect="plain">旧数据补整段</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="界线切段归属" min-width="170">
          <template #default="{ row }">
            <el-tag v-if="!row.geo.cross && !row.geo.pending && row.geo.segments.length" size="small" type="success" effect="plain">
              {{ row.geo.reefNames[0] || '—' }}
            </el-tag>
            <el-tag v-else-if="row.geo.cross && !row.geo.pending" size="small" type="warning" effect="plain">
              跨界分摊：{{ row.geo.reefNames.join(' / ') }}
            </el-tag>
            <el-tag v-else-if="row.geo.pending" size="small" type="danger" effect="plain">挂起待核</el-tag>
            <span v-else class="gb-hint">未切段</span>
            <div v-if="row.geo.cross" class="gb-hint gb-mono">
              {{ segmentLengths(row.belt.id) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="珊瑚 / 鱼类" width="110" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoCorals(row.belt)">{{ row.coralCount }} 珊</el-button>
            <el-button text type="primary" size="small" @click="gotoFishes(row.belt)">{{ row.fishCount }} 鱼</el-button>
          </template>
        </el-table-column>
        <el-table-column label="白化" width="140">
          <template #default="{ row }">
            <BleachTag :level="row.grade" size="small" />
            <div class="gb-hint gb-mono">指数 {{ row.bleachIndex }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Right" @click="gotoCorals(row.belt)">珊瑚</el-button>
            <el-button size="small" @click="gotoFishes(row.belt)">鱼类</el-button>
            <el-button size="small" :icon="Edit" @click="openEdit(row.belt)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeBelt(row.belt)">删</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无样带" description="点击右上角「新增样带」开始布设。" compact />
        </template>
      </el-table>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑样带（外业普查组）' : '布设样带（外业普查组）'" width="600px" :close-on-click-modal="false">
      <el-form label-width="116px">
        <el-form-item label="样带编号" required>
          <el-input v-model="form.no" placeholder="如：T-01" maxlength="24" />
        </el-form-item>
        <el-form-item label="长度" required>
          <el-input-number v-model="form.lengthM" :min="1" :max="1000" :step="1" controls-position="right" @change="syncAutoEndpoint" />
          <span class="page__unit">m</span>
          <div class="page__presets">
            <el-button
              v-for="preset in BELT_LENGTH_PRESETS"
              :key="preset"
              size="small"
              text
              type="primary"
              @click="form.lengthM = preset; syncAutoEndpoint()"
            >
              {{ preset }} m
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="朝向" required>
          <el-radio-group v-model="form.orientation" @change="syncAutoEndpoint">
            <el-radio-button v-for="item in ORIENTATIONS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="起点经纬度" required>
          <el-input-number v-model="form.startLng" :precision="6" :step="0.0001" :controls="false" placeholder="经度" @change="syncAutoEndpoint" />
          <el-input-number v-model="form.startLat" :precision="6" :step="0.0001" :controls="false" placeholder="纬度" @change="syncAutoEndpoint" />
          <span class="page__unit">外业实测起点</span>
        </el-form-item>
        <el-form-item label="终点经纬度">
          <el-input-number v-model="form.endLng" :precision="6" :step="0.0001" :controls="false" :disabled="form.autoEndpoint" placeholder="经度" />
          <el-input-number v-model="form.endLat" :precision="6" :step="0.0001" :controls="false" :disabled="form.autoEndpoint" placeholder="纬度" />
          <el-checkbox v-model="form.autoEndpoint" @change="syncAutoEndpoint">按朝向/长度推算</el-checkbox>
        </el-form-item>
        <el-form-item label="调查日期" required>
          <el-date-picker v-model="form.surveyDate" type="date" value-format="YYYY-MM-DD" placeholder="选择调查日期" />
        </el-form-item>
        <el-form-item label="调查人">
          <el-input v-model="form.observer" placeholder="如：林之遥" maxlength="20" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '布设并录入记录' }}
        </el-button>
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
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
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

.page__presets {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 4px;
}
</style>
