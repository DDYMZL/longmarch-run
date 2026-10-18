<script setup lang="ts">
// 章节配置：CRUD + 节点绑定（多选）+ 拖拽排序
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import {
  createChapter,
  deleteChapter,
  fetchChapters,
  fetchRouteNodes,
  reorderChapters,
  updateChapter
} from '../api/admin'
import type { ChapterItem, ChapterUpsert, RouteNode } from '../api/admin'

const loading = ref(false)
const chapters = ref<ChapterItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const keyword = ref('')
const appliedKeyword = ref('')

const nodes = ref<RouteNode[]>([])

let requestSeq = 0
async function loadChapters() {
  const seq = ++requestSeq
  loading.value = true
  try {
    const { data } = await fetchChapters(page.value, pageSize.value, appliedKeyword.value.trim())
    if (seq !== requestSeq) return
    chapters.value = data.items
    total.value = data.total
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function handlePageChange(next: number) {
  page.value = next
  loadChapters()
}

function handleSizeChange(size: number) {
  pageSize.value = size
  page.value = 1
  loadChapters()
}

let searchTimer: number | null = null
watch(keyword, (value) => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    appliedKeyword.value = value
    page.value = 1
    loadChapters()
  }, 400)
})
onBeforeUnmount(() => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
})

// ---------------- 新增 / 编辑弹窗 ----------------
const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<ChapterUpsert>({
  name: '',
  title: '',
  intro: '',
  node_ids: [],
  sort_order: 0
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入章节标识名', trigger: 'blur' }],
  title: [{ required: true, message: '请输入章节标题', trigger: 'blur' }]
}

const dialogTitle = computed(() => (editingId.value === null ? '新增章节' : `编辑章节 #${editingId.value}`))

function toPayload(c: ChapterUpsert): ChapterUpsert {
  return {
    name: c.name.trim(),
    title: c.title.trim(),
    intro: c.intro.trim(),
    node_ids: [...c.node_ids],
    sort_order: Number(c.sort_order) || 0
  }
}

function openCreate() {
  editingId.value = null
  Object.assign(form, { name: '', title: '', intro: '', node_ids: [], sort_order: chapters.value.length })
  dialogVisible.value = true
}

function openEdit(row: ChapterItem) {
  editingId.value = row.id
  Object.assign(form, toPayload(row))
  dialogVisible.value = true
}

async function handleSave() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    if (editingId.value === null) {
      await createChapter(toPayload(form))
      ElMessage.success('新增成功')
    } else {
      await updateChapter(editingId.value, toPayload(form))
      ElMessage.success('保存成功')
    }
    dialogVisible.value = false
    await loadChapters()
  } finally {
    saving.value = false
  }
}

async function handleDelete(row: ChapterItem) {
  await ElMessageBox.confirm(`确定删除章节「${row.title}」吗？`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除',
    confirmButtonClass: 'el-button--danger'
  })
  await deleteChapter(row.id)
  ElMessage.success('已删除')
  await loadChapters()
}

// ---------------- 排序：上移/下移 ----------------
const reordering = ref(false)

async function moveChapter(index: number, direction: -1 | 1) {
  const target = index + direction
  if (target < 0 || target >= chapters.value.length) return
  const list = [...chapters.value]
  const [item] = list.splice(index, 1)
  list.splice(target, 0, item)
  reordering.value = true
  try {
    const { data } = await reorderChapters(list.map((c) => c.id))
    chapters.value = data.items
    ElMessage.success('排序已更新')
  } catch (e: unknown) {
    const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
    ElMessage.error(detail || '排序失败，请稍后重试')
  } finally {
    reordering.value = false
  }
}

function nodeNames(ids: number[]): string {
  if (!ids.length) return '—'
  return ids.map((id) => nodes.value.find((n) => n.id === id)?.name || `#${id}`).join('、')
}

onMounted(async () => {
  loadChapters()
  try {
    const { data } = await fetchRouteNodes(true)
    nodes.value = data.items
  } catch {
    nodes.value = []
  }
})
</script>

<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="按名称 / 标题搜索"
        clearable
        style="width: 260px"
        :prefix-icon="'Search'"
      />
      <div class="spacer" />
      <span class="total">共 {{ total }} 条</span>
      <el-button type="primary" :icon="'Plus'" @click="openCreate">新增章节</el-button>
      <el-button :icon="'Refresh'" @click="loadChapters">刷新</el-button>
    </div>

    <el-table v-loading="loading || reordering" :data="chapters" border stripe row-key="id">
      <el-table-column prop="sort_order" label="排序" width="70" align="center" />
      <el-table-column prop="name" label="标识名" width="120" />
      <el-table-column prop="title" label="标题" width="160" />
      <el-table-column prop="intro" label="简介" min-width="200" show-overflow-tooltip />
      <el-table-column label="绑定节点" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">{{ nodeNames(row.node_ids) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="200" align="center" fixed="right">
        <template #default="{ row, $index }">
          <el-button link :disabled="$index === 0" @click="moveChapter($index, -1)">↑</el-button>
          <el-button link :disabled="$index === chapters.length - 1" @click="moveChapter($index, 1)">↓</el-button>
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

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="600px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="标识名" prop="name">
          <el-input v-model="form.name" maxlength="50" placeholder="如 chapter_1（程序标识）" />
        </el-form-item>
        <el-form-item label="标题" prop="title">
          <el-input v-model="form.title" maxlength="100" placeholder="展示标题，如「血战湘江」" />
        </el-form-item>
        <el-form-item label="简介">
          <el-input
            v-model="form.intro"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            placeholder="章节简介"
          />
        </el-form-item>
        <el-form-item label="绑定节点">
          <el-select v-model="form.node_ids" multiple filterable placeholder="选择该章节包含的路线节点" style="width: 100%">
            <el-option v-for="n in nodes" :key="n.id" :label="n.name" :value="n.id" />
          </el-select>
          <div class="hint">按节点顺序排列，章节进度依据绑定节点点亮情况计算</div>
        </el-form-item>
        <el-form-item label="排序号">
          <el-input-number v-model="form.sort_order" :min="0" :max="9999" controls-position="right" />
          <span class="hint">越小越靠前</span>
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

.hint {
  color: #909399;
  font-size: 12px;
  margin-top: 4px;
}

.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
