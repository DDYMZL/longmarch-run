<script setup lang="ts">
// 每日寄语维护（需求 §16）：有出处的史料语录，按日期展示，可关联路线节点
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import {
  createQuote,
  deleteQuote,
  fetchQuotes,
  fetchRouteNodes,
  updateQuote
} from '../api/admin'
import type { Quote, RouteNode } from '../api/admin'

const loading = ref(false)
const quotes = ref<Quote[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const keyword = ref('')

const nodes = ref<RouteNode[]>([])

const filtered = computed(() =>
  keyword.value
    ? quotes.value.filter(
        (q) => q.content.includes(keyword.value.trim()) || q.source.includes(keyword.value.trim())
      )
    : quotes.value
)

async function loadQuotes() {
  loading.value = true
  try {
    const { data } = await fetchQuotes(page.value, pageSize.value)
    quotes.value = data.items
    total.value = data.total
  } finally {
    loading.value = false
  }
}

function handlePageChange(next: number) {
  page.value = next
  loadQuotes()
}

// ---------------- 新增 / 编辑弹窗 ----------------
const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

const form = reactive({
  date: '',
  content: '',
  source: '',
  node_id: null as number | null
})

const rules: FormRules = {
  date: [{ required: true, message: '请选择日期', trigger: 'change' }],
  content: [{ required: true, message: '请输入寄语内容', trigger: 'blur' }],
  source: [{ required: true, message: '请填写出处（寄语须有明确来源）', trigger: 'blur' }]
}

const dialogTitle = computed(() => (editingId.value === null ? '新增寄语' : `编辑寄语 #${editingId.value}`))

function openCreate() {
  editingId.value = null
  form.date = ''
  form.content = ''
  form.source = ''
  form.node_id = null
  dialogVisible.value = true
}

function openEdit(row: Quote) {
  editingId.value = row.id
  form.date = row.date
  form.content = row.content
  form.source = row.source
  form.node_id = row.node_id
  dialogVisible.value = true
}

async function handleSave() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  const payload = {
    date: form.date,
    content: form.content.trim(),
    source: form.source.trim(),
    node_id: form.node_id
  }
  saving.value = true
  try {
    if (editingId.value === null) {
      await createQuote(payload)
      ElMessage.success('新增成功')
    } else {
      await updateQuote(editingId.value, payload)
      ElMessage.success('保存成功')
    }
    dialogVisible.value = false
    await loadQuotes()
  } finally {
    saving.value = false
  }
}

async function handleDelete(row: Quote) {
  await ElMessageBox.confirm(`确定删除 ${row.date} 的寄语吗？`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除',
    confirmButtonClass: 'el-button--danger'
  })
  await deleteQuote(row.id)
  ElMessage.success('已删除')
  await loadQuotes()
}

onMounted(async () => {
  loadQuotes()
  try {
    const { data } = await fetchRouteNodes()
    nodes.value = data.items
  } catch {
    // 节点下拉加载失败不阻塞寄语维护
  }
})
</script>

<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="按内容 / 出处搜索（当前页）"
        clearable
        style="width: 260px"
        :prefix-icon="'Search'"
      />
      <div class="spacer" />
      <span class="total">共 {{ total }} 条</span>
      <el-button type="primary" :icon="'Plus'" @click="openCreate">新增寄语</el-button>
      <el-button :icon="'Refresh'" @click="loadQuotes">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="filtered" border stripe row-key="id">
      <el-table-column prop="id" label="ID" width="64" align="center" />
      <el-table-column prop="date" label="日期" width="120" align="center" sortable />
      <el-table-column prop="content" label="寄语内容" min-width="280" show-overflow-tooltip />
      <el-table-column prop="source" label="出处" min-width="200" show-overflow-tooltip />
      <el-table-column label="关联节点" width="130" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.node_name" size="small" type="danger" effect="plain">{{ row.node_name }}</el-tag>
          <span v-else class="none">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="140" align="center" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="pageSize"
      :current-page="page"
      @current-change="handlePageChange"
    />

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="560px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="日期" prop="date">
          <el-date-picker
            v-model="form.date"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择展示日期"
            style="width: 200px"
          />
          <span class="hint">同一日期仅一条；当天无寄语时小程序展示最近一条更早寄语</span>
        </el-form-item>
        <el-form-item label="寄语内容" prop="content">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            placeholder="请输入有明确出处的语录，勿虚构"
          />
        </el-form-item>
        <el-form-item label="出处" prop="source">
          <el-input v-model="form.source" maxlength="200" placeholder="如：毛泽东《七律·长征》" />
        </el-form-item>
        <el-form-item label="关联节点">
          <el-select v-model="form.node_id" clearable placeholder="不关联" style="width: 200px">
            <el-option v-for="n in nodes" :key="n.id" :label="n.name" :value="n.id" />
          </el-select>
          <span class="hint">关联后小程序端可从寄语卡跳转节点详情</span>
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
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.spacer {
  flex: 1;
}

.total {
  color: #909399;
  font-size: 13px;
}

.none {
  color: #c0c4cc;
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
