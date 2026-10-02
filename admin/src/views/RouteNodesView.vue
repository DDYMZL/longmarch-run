<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import {
  createRouteNode,
  fetchRouteNodes,
  setRouteNodeEnabled,
  updateRouteNode
} from '../api/admin'
import type { RouteNode, RouteNodeUpsert } from '../api/admin'

const loading = ref(false)
const nodes = ref<RouteNode[]>([])
const keyword = ref('')
const statusFilter = ref('')

const filtered = computed(() =>
  nodes.value.filter((node) => {
    if (statusFilter.value === 'enabled' && !node.is_enabled) return false
    if (statusFilter.value === 'disabled' && node.is_enabled) return false
    return !keyword.value.trim() || node.name.includes(keyword.value.trim())
  })
)

async function loadNodes() {
  loading.value = true
  try {
    const { data } = await fetchRouteNodes()
    nodes.value = data.items
  } finally {
    loading.value = false
  }
}

const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<RouteNodeUpsert>({
  name: '',
  icon: '',
  target_steps: 0,
  historical_time: '',
  description: '',
  latitude: 0,
  longitude: 0,
  sort_order: 1,
  is_enabled: true,
  brief: '',
  significance: '',
  figures: '',
  location: '',
  images: [],
  audio: '',
  keywords: ''
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入节点名称', trigger: 'blur' }],
  target_steps: [{ required: true, message: '请输入目标步数', trigger: 'change' }],
  latitude: [{ required: true, message: '请输入纬度', trigger: 'change' }],
  longitude: [{ required: true, message: '请输入经度', trigger: 'change' }],
  sort_order: [{ required: true, message: '请输入排序', trigger: 'change' }]
}

const dialogTitle = computed(() =>
  editingId.value === null ? '新增路线点位' : `编辑路线点位 #${editingId.value}`
)

function assignForm(data: RouteNodeUpsert) {
  Object.assign(form, data)
}

function openCreate() {
  const last = nodes.value[nodes.value.length - 1]
  editingId.value = null
  assignForm({
    name: '',
    icon: '',
    target_steps: last ? last.target_steps + 5000 : 0,
    historical_time: '',
    description: '',
    latitude: last ? last.latitude : 0,
    longitude: last ? last.longitude : 0,
    sort_order: last ? last.sort_order + 1 : 1,
    is_enabled: true,
    brief: '',
    significance: '',
    figures: '',
    location: '',
    images: [],
    audio: '',
    keywords: ''
  })
  dialogVisible.value = true
}

function openEdit(row: RouteNode) {
  editingId.value = row.id
  assignForm({
    name: row.name,
    icon: row.icon,
    target_steps: row.target_steps,
    historical_time: row.historical_time,
    description: row.description,
    latitude: row.latitude,
    longitude: row.longitude,
    sort_order: row.sort_order,
    is_enabled: row.is_enabled,
    brief: row.brief,
    significance: row.significance,
    figures: row.figures,
    location: row.location,
    images: [...row.images],
    audio: row.audio,
    keywords: row.keywords
  })
  dialogVisible.value = true
}

async function handleSave() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  const payload: RouteNodeUpsert = {
    name: form.name.trim(),
    icon: form.icon.trim(),
    target_steps: Number(form.target_steps),
    historical_time: form.historical_time.trim(),
    description: form.description.trim(),
    latitude: Number(form.latitude),
    longitude: Number(form.longitude),
    sort_order: Number(form.sort_order),
    is_enabled: form.is_enabled,
    brief: form.brief.trim(),
    significance: form.significance.trim(),
    figures: form.figures.trim(),
    location: form.location.trim(),
    images: form.images.map((url) => url.trim()).filter(Boolean),
    audio: form.audio.trim(),
    keywords: form.keywords.trim()
  }
  saving.value = true
  try {
    if (editingId.value === null) {
      await createRouteNode(payload)
      ElMessage.success('新增成功')
    } else {
      await updateRouteNode(editingId.value, payload)
      ElMessage.success('保存成功')
    }
    dialogVisible.value = false
    await loadNodes()
  } finally {
    saving.value = false
  }
}

function addImage() {
  if (form.images.length >= 9) {
    ElMessage.warning('最多 9 张图片')
    return
  }
  form.images.push('')
}

function removeImage(index: number) {
  form.images.splice(index, 1)
}

async function handleToggle(row: RouteNode) {
  const nextEnabled = !row.is_enabled
  await ElMessageBox.confirm(
    nextEnabled
      ? `启用“${row.name}”后，小程序会将其加入路线。`
      : `停用“${row.name}”后，小程序将隐藏该节点并重算路线完成度，历史点亮记录不会删除。`,
    nextEnabled ? '启用节点' : '停用节点',
    {
      type: 'warning',
      confirmButtonText: nextEnabled ? '确认启用' : '确认停用'
    }
  )
  await setRouteNodeEnabled(row.id, nextEnabled)
  ElMessage.success(nextEnabled ? '已启用' : '已停用')
  await loadNodes()
}

onMounted(loadNodes)
</script>

<template>
  <el-card shadow="never" class="route-card">
    <div class="toolbar">
      <el-input v-model="keyword" placeholder="按节点名称搜索" clearable class="keyword" />
      <el-select v-model="statusFilter" placeholder="全部状态" clearable class="status-filter">
        <el-option label="已启用" value="enabled" />
        <el-option label="已停用" value="disabled" />
      </el-select>
      <div class="spacer" />
      <span class="total">共 {{ nodes.length }} 个点位</span>
      <el-button type="primary" @click="openCreate">新增点位</el-button>
      <el-button @click="loadNodes">刷新</el-button>
    </div>

    <div class="table-wrap">
      <el-table
        v-loading="loading"
        :data="filtered"
        border
        stripe
        row-key="id"
        empty-text="暂无路线点位"
      >
        <el-table-column prop="sort_order" label="顺序" width="72" align="center" />
        <el-table-column prop="id" label="ID" width="64" align="center" />
        <el-table-column label="节点" min-width="150">
          <template #default="{ row }">
            <span class="node-icon">{{ row.icon }}</span>{{ row.name }}
          </template>
        </el-table-column>
        <el-table-column prop="historical_time" label="历史时间" min-width="130" />
        <el-table-column prop="target_steps" label="目标步数" width="110" align="right" />
        <el-table-column label="坐标" min-width="190">
          <template #default="{ row }">{{ row.latitude }}, {{ row.longitude }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.is_enabled ? 'success' : 'info'" size="small">
              {{ row.is_enabled ? '已启用' : '已停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="历史介绍" min-width="220" show-overflow-tooltip />
        <el-table-column label="操作" width="150" fixed="right" align="center">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link :type="row.is_enabled ? 'danger' : 'success'" @click="handleToggle(row)">
              {{ row.is_enabled ? '停用' : '启用' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="min(720px, 92vw)" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="92px">
        <div class="form-grid">
          <el-form-item label="节点名称" prop="name">
            <el-input v-model="form.name" maxlength="50" />
          </el-form-item>
          <el-form-item label="图标">
            <el-input v-model="form.icon" maxlength="16" placeholder="如 🚩" />
          </el-form-item>
          <el-form-item label="目标步数" prop="target_steps">
            <el-input-number v-model="form.target_steps" :min="0" :step="1000" controls-position="right" />
          </el-form-item>
          <el-form-item label="显示顺序" prop="sort_order">
            <el-input-number v-model="form.sort_order" :min="0" controls-position="right" />
          </el-form-item>
          <el-form-item label="纬度" prop="latitude">
            <el-input-number v-model="form.latitude" :min="-90" :max="90" :precision="6" :step="0.001" controls-position="right" />
          </el-form-item>
          <el-form-item label="经度" prop="longitude">
            <el-input-number v-model="form.longitude" :min="-180" :max="180" :precision="6" :step="0.001" controls-position="right" />
          </el-form-item>
        </div>
        <el-form-item label="历史时间">
          <el-input v-model="form.historical_time" maxlength="50" />
        </el-form-item>
        <el-form-item label="历史介绍">
          <el-input v-model="form.description" type="textarea" :rows="5" maxlength="2000" show-word-limit />
        </el-form-item>
        <el-divider content-position="left">节点详情内容（小程序节点详情页展示）</el-divider>
        <el-form-item label="一句话简介">
          <el-input v-model="form.brief" maxlength="100" show-word-limit placeholder="节点卡片上的一句话简介" />
        </el-form-item>
        <el-form-item label="历史意义">
          <el-input v-model="form.significance" type="textarea" :rows="3" maxlength="1000" show-word-limit />
        </el-form-item>
        <el-form-item label="相关人物">
          <el-input v-model="form.figures" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="多个人物用中文逗号分隔" />
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="地点">
            <el-input v-model="form.location" maxlength="100" placeholder="如 江西省瑞金市" />
          </el-form-item>
          <el-form-item label="关键词">
            <el-input v-model="form.keywords" maxlength="100" placeholder="英文逗号分隔，如 出发,集结" />
          </el-form-item>
        </div>
        <el-form-item label="图片链接">
          <div class="image-list">
            <div v-for="(_url, index) in form.images" :key="index" class="image-row">
              <el-input v-model="form.images[index]" placeholder="图片 URL" maxlength="500" />
              <el-button link type="danger" :icon="'Delete'" @click="removeImage(index)" />
            </div>
            <el-button link type="primary" :icon="'Plus'" @click="addImage">添加图片</el-button>
          </div>
        </el-form-item>
        <el-form-item label="音频链接">
          <el-input v-model="form.audio" maxlength="500" placeholder="音频 URL（可空）" />
        </el-form-item>
        <el-form-item label="启用状态">
          <el-switch v-model="form.is_enabled" active-text="启用" inactive-text="停用" />
        </el-form-item>
        <el-alert title="启用节点会按显示顺序参与路线进度计算，目标步数必须逐点递增。" type="warning" :closable="false" show-icon />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.route-card {
  min-width: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.keyword {
  width: 240px;
}

.status-filter {
  width: 140px;
}

.spacer {
  flex: 1;
}

.total {
  color: #7b8494;
  font-size: 13px;
}

.table-wrap {
  width: 100%;
  overflow-x: auto;
}

.table-wrap :deep(.el-table) {
  min-width: 1120px;
}

.node-icon {
  display: inline-block;
  width: 28px;
  font-size: 18px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 18px;
}

.form-grid :deep(.el-input-number) {
  width: 100%;
}

.image-list {
  width: 100%;
}

.image-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

@media (max-width: 760px) {
  .form-grid {
    grid-template-columns: 1fr;
  }

  .keyword,
  .status-filter {
    width: 100%;
  }

  .spacer {
    display: none;
  }
}
</style>
