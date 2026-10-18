<script setup lang="ts">
// 勋章管理：CRUD + hidden/category/sort_order 字段
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import {
  createMedal,
  deleteMedal,
  fetchMedals,
  updateMedal
} from '../api/admin'
import type { MedalItem, MedalUpsert } from '../api/admin'

const loading = ref(false)
const medals = ref<MedalItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const keyword = ref('')
const appliedKeyword = ref('')

let requestSeq = 0
async function loadMedals() {
  const seq = ++requestSeq
  loading.value = true
  try {
    const { data } = await fetchMedals(page.value, pageSize.value, appliedKeyword.value.trim())
    if (seq !== requestSeq) return
    medals.value = data.items
    total.value = data.total
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function handlePageChange(next: number) {
  page.value = next
  loadMedals()
}

function handleSizeChange(size: number) {
  pageSize.value = size
  page.value = 1
  loadMedals()
}

let searchTimer: number | null = null
watch(keyword, (value) => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    appliedKeyword.value = value
    page.value = 1
    loadMedals()
  }, 400)
})
onBeforeUnmount(() => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
})

// ---------------- 新增 / 编辑弹窗 ----------------
const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<MedalUpsert>({
  id: '',
  name: '',
  icon: '',
  desc: '',
  category: '',
  hidden: false,
  sort_order: 0
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入勋章名称', trigger: 'blur' }]
}

const dialogTitle = computed(() => (editingId.value === null ? '新增勋章' : `编辑勋章「${editingId.value}」`))

const CATEGORIES = ['里程', '答题', '连续', '特殊', '活动']

function toPayload(m: MedalUpsert): MedalUpsert {
  return {
    ...m,
    name: m.name.trim(),
    icon: m.icon.trim(),
    desc: m.desc.trim(),
    category: m.category.trim(),
    sort_order: Number(m.sort_order) || 0
  }
}

function openCreate() {
  editingId.value = null
  Object.assign(form, { id: '', name: '', icon: '', desc: '', category: '', hidden: false, sort_order: 0 })
  dialogVisible.value = true
}

function openEdit(row: MedalItem) {
  editingId.value = row.id
  Object.assign(form, {
    id: row.id,
    name: row.name,
    icon: row.icon,
    desc: row.desc,
    category: row.category,
    hidden: row.hidden,
    sort_order: row.sort_order
  })
  dialogVisible.value = true
}

async function handleSave() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const payload = toPayload(form)
    if (editingId.value === null) {
      await createMedal(payload)
      ElMessage.success('新增成功')
    } else {
      await updateMedal(editingId.value, payload)
      ElMessage.success('保存成功')
    }
    dialogVisible.value = false
    await loadMedals()
  } finally {
    saving.value = false
  }
}

async function handleDelete(row: MedalItem) {
  await ElMessageBox.confirm(`确定删除勋章「${row.name}」吗？删除后已获得该勋章的用户不受影响。`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除',
    confirmButtonClass: 'el-button--danger'
  })
  await deleteMedal(row.id)
  ElMessage.success('已删除')
  await loadMedals()
}

async function handleToggleHidden(row: MedalItem, hidden: boolean) {
  await updateMedal(row.id, { ...row, hidden })
  ElMessage.success(hidden ? '已隐藏' : '已显示')
  await loadMedals()
}

onMounted(() => {
  loadMedals()
})
</script>

<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="按名称 / 分类搜索"
        clearable
        style="width: 260px"
        :prefix-icon="'Search'"
      />
      <div class="spacer" />
      <span class="total">共 {{ total }} 条</span>
      <el-button type="primary" :icon="'Plus'" @click="openCreate">新增勋章</el-button>
      <el-button :icon="'Refresh'" @click="loadMedals">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="medals" border stripe row-key="id">
      <el-table-column prop="sort_order" label="排序" width="70" align="center" />
      <el-table-column label="图标" width="60" align="center">
        <template #default="{ row }">
          <span v-if="row.icon" class="medal-icon">{{ row.icon }}</span>
          <span v-else class="none">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" label="名称" width="140" />
      <el-table-column prop="desc" label="描述" min-width="200" show-overflow-tooltip />
      <el-table-column prop="category" label="分类" width="100" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.category" size="small" effect="plain">{{ row.category }}</el-tag>
          <span v-else class="none">—</span>
        </template>
      </el-table-column>
      <el-table-column label="隐藏" width="80" align="center">
        <template #default="{ row }">
          <el-switch
            :model-value="row.hidden"
            @change="(v: string | number | boolean) => handleToggleHidden(row, Boolean(v))"
          />
        </template>
      </el-table-column>
      <el-table-column prop="id" label="标识" width="130" show-overflow-tooltip />
      <el-table-column label="操作" width="140" align="center" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="pager"
      layout="total, sizes, prev, pager, next"
      :total="total"
      :page-size="pageSize"
      :page-sizes="[10, 20, 50, 100]"
      :current-page="page"
      @current-change="handlePageChange"
      @size-change="handleSizeChange"
    />

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="560px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item v-if="editingId === null" label="标识 ID">
          <el-input v-model="form.id" placeholder="留空由后端自动生成（如 medal_xxx）" />
          <div class="hint">全局唯一字符串标识，创建后不可修改</div>
        </el-form-item>
        <el-form-item v-else label="标识 ID">
          <el-input :model-value="editingId" disabled />
        </el-form-item>
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" maxlength="50" placeholder="勋章名称" />
        </el-form-item>
        <el-form-item label="图标">
          <el-input v-model="form.icon" maxlength="10" placeholder="Emoji 或图标标识" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input
            v-model="form.desc"
            type="textarea"
            :rows="2"
            maxlength="200"
            show-word-limit
            placeholder="勋章说明（获得条件等）"
          />
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="form.category" filterable allow-create placeholder="选择或输入分类" style="width: 200px">
            <el-option v-for="c in CATEGORIES" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序号">
          <el-input-number v-model="form.sort_order" :min="0" :max="999999" controls-position="right" />
          <span class="hint">越小越靠前</span>
        </el-form-item>
        <el-form-item label="隐藏">
          <el-switch v-model="form.hidden" />
          <span class="hint">隐藏后小程序端不展示该勋章</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.spacer {
  flex: 1;
}

.toolbar :deep(.el-button + .el-button) {
  margin-left: 0;
}

.total {
  color: #909399;
  font-size: 13px;
}

.none {
  color: #c0c4cc;
}

.medal-icon {
  font-size: 22px;
}

.hint {
  margin-left: 10px;
  color: #909399;
  font-size: 12px;
}

.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
