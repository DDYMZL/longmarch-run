<script setup lang="ts">
// 每日寄语维护（需求 §16、V1.1）：启用寄语按排序号自起始日期起每天轮换一条，可关联路线节点，支持 Excel 批量导入
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import {
  createQuote,
  deleteQuote,
  fetchQuoteCycle,
  fetchQuotes,
  fetchRouteNodes,
  quoteImportApi,
  updateQuote,
  updateQuoteCycle
} from '../api/admin'
import type { Quote, QuoteCycle, QuoteUpsert, RouteNode } from '../api/admin'
import ExcelImportDialog from '../components/ExcelImportDialog.vue'

const loading = ref(false)
const quotes = ref<Quote[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const keyword = ref('')
const appliedKeyword = ref('')

const nodes = ref<RouteNode[]>([])

// 服务端按内容/出处搜索；只采纳最后一次请求
let requestSeq = 0
async function loadQuotes() {
  const seq = ++requestSeq
  loading.value = true
  try {
    const { data } = await fetchQuotes(page.value, pageSize.value, appliedKeyword.value.trim())
    if (seq !== requestSeq) return
    quotes.value = data.items
    total.value = data.total
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function handlePageChange(next: number) {
  page.value = next
  loadQuotes()
}

let searchTimer: number | null = null
watch(keyword, (value) => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    appliedKeyword.value = value
    page.value = 1
    loadQuotes()
  }, 400)
})
onBeforeUnmount(() => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
})

// ---------------- 循环设置 ----------------
const cycle = ref<QuoteCycle | null>(null)
const startDate = ref('')
const savingCycle = ref(false)

async function loadCycle() {
  const { data } = await fetchQuoteCycle()
  cycle.value = data
  startDate.value = data.start_date
}

// 增删改、启停、导入都会改变今日寄语，列表与循环信息一起刷新
function reloadAll() {
  return Promise.all([loadQuotes(), loadCycle()])
}

async function handleSaveCycle() {
  if (!startDate.value) return
  savingCycle.value = true
  try {
    const { data } = await updateQuoteCycle(startDate.value)
    cycle.value = data
    ElMessage.success('起始日期已保存')
  } finally {
    savingCycle.value = false
  }
}

// ---------------- 新增 / 编辑弹窗 ----------------
const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<QuoteUpsert>({
  content: '',
  source: '',
  sort_order: 0,
  is_enabled: true,
  node_id: null
})

const rules: FormRules = {
  content: [{ required: true, message: '请输入寄语内容', trigger: 'blur' }],
  source: [{ required: true, message: '请填写出处（寄语须有明确来源）', trigger: 'blur' }]
}

const dialogTitle = computed(() => (editingId.value === null ? '新增寄语' : `编辑寄语 #${editingId.value}`))

function toPayload(q: QuoteUpsert): QuoteUpsert {
  return {
    content: q.content.trim(),
    source: q.source.trim(),
    sort_order: Number(q.sort_order) || 0,
    is_enabled: q.is_enabled,
    node_id: q.node_id
  }
}

function openCreate() {
  editingId.value = null
  Object.assign(form, { content: '', source: '', sort_order: 0, is_enabled: true, node_id: null })
  dialogVisible.value = true
}

function openEdit(row: Quote) {
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
      await createQuote(toPayload(form))
      ElMessage.success('新增成功')
    } else {
      await updateQuote(editingId.value, toPayload(form))
      ElMessage.success('保存成功')
    }
    dialogVisible.value = false
    await reloadAll()
  } finally {
    saving.value = false
  }
}

const togglingId = ref<number | null>(null)
async function handleToggle(row: Quote, enabled: boolean) {
  togglingId.value = row.id
  try {
    await updateQuote(row.id, toPayload({ ...row, is_enabled: enabled }))
    ElMessage.success(enabled ? '已启用' : '已停用')
    await reloadAll()
  } finally {
    togglingId.value = null
  }
}

async function handleDelete(row: Quote) {
  await ElMessageBox.confirm(`确定删除寄语「${row.content}」吗？`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除',
    confirmButtonClass: 'el-button--danger'
  })
  await deleteQuote(row.id)
  ElMessage.success('已删除')
  await reloadAll()
}

// ---------------- Excel 批量导入 ----------------
const importVisible = ref(false)
const importDialog = ref<InstanceType<typeof ExcelImportDialog>>()
const IMPORT_TIPS = [
  '先下载导入模板，按「填写说明」工作表的要求填写寄语内容与出处；',
  '排序号留空则自动排在已有寄语之后，启用状态留空默认启用；',
  '上传文件后系统逐行校验，任意一行失败则整批禁止导入；与库内已有寄语重复的行会判错（不覆盖）。'
]

function handleImported() {
  page.value = 1
  reloadAll()
}

onMounted(async () => {
  reloadAll()
  try {
    // 节点下拉加载失败不阻塞寄语维护，也不弹错误
    const { data } = await fetchRouteNodes(true)
    nodes.value = data.items
  } catch {
    nodes.value = []
  }
})
</script>

<template>
  <el-card shadow="never">
    <div class="cycle-bar">
      <div class="cycle-setting">
        <span class="cycle-label">循环起始日期</span>
        <el-date-picker
          v-model="startDate"
          type="date"
          value-format="YYYY-MM-DD"
          :clearable="false"
          placeholder="选择起始日期"
          style="width: 160px"
        />
        <el-button
          type="primary"
          plain
          :loading="savingCycle"
          :disabled="!cycle || startDate === cycle.start_date"
          @click="handleSaveCycle"
        >
          保存
        </el-button>
      </div>
      <span v-if="cycle" class="cycle-info">
        启用寄语 {{ cycle.enabled_count }} 条，按排序号自起始日期起每天展示一条、循环往复；
        <template v-if="cycle.enabled_count">今日展示第 {{ cycle.today_position }} 条</template>
        <template v-else>当前无启用寄语，小程序不展示寄语卡</template>
      </span>
    </div>

    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="按内容 / 出处搜索"
        clearable
        style="width: 260px"
        :prefix-icon="'Search'"
      />
      <div class="spacer" />
      <span class="total">共 {{ total }} 条</span>
      <el-button :icon="'Download'" @click="importDialog?.downloadTemplate()">下载导入模板</el-button>
      <el-button :icon="'Upload'" @click="importVisible = true">批量导入</el-button>
      <el-button type="primary" :icon="'Plus'" @click="openCreate">新增寄语</el-button>
      <el-button :icon="'Refresh'" @click="reloadAll">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="quotes" border stripe row-key="id">
      <el-table-column prop="sort_order" label="排序号" width="80" align="center" />
      <el-table-column label="寄语内容" min-width="280" show-overflow-tooltip>
        <template #default="{ row }">
          <el-tag v-if="row.id === cycle?.today_quote_id" size="small" type="success" class="today-tag">今日展示</el-tag>
          {{ row.content }}
        </template>
      </el-table-column>
      <el-table-column prop="source" label="出处" min-width="200" show-overflow-tooltip />
      <el-table-column label="启用" width="80" align="center">
        <template #default="{ row }">
          <el-switch
            :model-value="row.is_enabled"
            :loading="togglingId === row.id"
            @change="(v: string | number | boolean) => handleToggle(row, Boolean(v))"
          />
        </template>
      </el-table-column>
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

    <ExcelImportDialog
      ref="importDialog"
      v-model="importVisible"
      title="批量导入寄语"
      unit="条"
      item-label="条寄语"
      template-filename="长征步迹_每日寄语导入模板.xlsx"
      report-prefix="寄语导入错误报告"
      :tips="IMPORT_TIPS"
      :api="quoteImportApi"
      @imported="handleImported"
    />

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="560px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
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
        <el-form-item label="排序号">
          <el-input-number v-model="form.sort_order" :min="0" :max="999999" controls-position="right" />
          <span class="hint">越小越靠前；排序号相同按创建先后</span>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.is_enabled" />
          <span class="hint">停用后不参与每日轮换</span>
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
.cycle-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 10px 14px;
  margin-bottom: 14px;
  background: #fdf6ec;
  border-radius: 4px;
}

.cycle-setting {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
}

.cycle-label {
  font-weight: 600;
  color: #606266;
}

.cycle-info {
  color: #909399;
  font-size: 13px;
}

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

.today-tag {
  margin-right: 6px;
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
