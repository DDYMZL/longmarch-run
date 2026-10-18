<script setup lang="ts">
// 人物志维护：CRUD + 关联节点（多选）+ 头像上传 + 可选 Excel 导入
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules, UploadRequestOptions } from 'element-plus'
import {
  createPerson,
  deletePerson,
  fetchPersons,
  fetchRouteNodes,
  personImportApi,
  updatePerson,
  uploadPersonAvatar
} from '../api/admin'
import type { PersonItem, PersonUpsert, RouteNode } from '../api/admin'
import ExcelImportDialog from '../components/ExcelImportDialog.vue'

const loading = ref(false)
const persons = ref<PersonItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const keyword = ref('')
const appliedKeyword = ref('')

const nodes = ref<RouteNode[]>([])

let requestSeq = 0
async function loadPersons() {
  const seq = ++requestSeq
  loading.value = true
  try {
    const { data } = await fetchPersons(page.value, pageSize.value, appliedKeyword.value.trim())
    if (seq !== requestSeq) return
    persons.value = data.items
    total.value = data.total
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function handlePageChange(next: number) {
  page.value = next
  loadPersons()
}

function handleSizeChange(size: number) {
  pageSize.value = size
  page.value = 1
  loadPersons()
}

let searchTimer: number | null = null
watch(keyword, (value) => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    appliedKeyword.value = value
    page.value = 1
    loadPersons()
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

const form = reactive<PersonUpsert>({
  name: '',
  avatar: '',
  brief: '',
  node_ids: []
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入人物姓名', trigger: 'blur' }]
}

const dialogTitle = computed(() => (editingId.value === null ? '新增人物' : `编辑人物 #${editingId.value}`))

function toPayload(p: PersonUpsert): PersonUpsert {
  return {
    name: p.name.trim(),
    avatar: p.avatar.trim(),
    brief: p.brief.trim(),
    node_ids: [...p.node_ids]
  }
}

function openCreate() {
  editingId.value = null
  Object.assign(form, { name: '', avatar: '', brief: '', node_ids: [] })
  dialogVisible.value = true
}

function openEdit(row: PersonItem) {
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
      await createPerson(toPayload(form))
      ElMessage.success('新增成功')
    } else {
      await updatePerson(editingId.value, toPayload(form))
      ElMessage.success('保存成功')
    }
    dialogVisible.value = false
    await loadPersons()
  } finally {
    saving.value = false
  }
}

async function handleDelete(row: PersonItem) {
  await ElMessageBox.confirm(`确定删除人物「${row.name}」吗？`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除',
    confirmButtonClass: 'el-button--danger'
  })
  await deletePerson(row.id)
  ElMessage.success('已删除')
  await loadPersons()
}

// ---------------- 头像上传 ----------------
const avatarUploading = ref(false)

async function handleAvatarUpload(options: UploadRequestOptions) {
  avatarUploading.value = true
  try {
    const { data } = await uploadPersonAvatar(options.file)
    form.avatar = data.url
    ElMessage.success('头像上传成功')
  } catch {
    ElMessage.error('头像上传失败，请检查文件格式（jpg/png/webp，≤2MB）')
  } finally {
    avatarUploading.value = false
  }
}

// ---------------- Excel 批量导入 ----------------
const importVisible = ref(false)
const importDialog = ref<InstanceType<typeof ExcelImportDialog>>()
const IMPORT_TIPS = [
  '先下载导入模板，按「填写说明」工作表的要求填写人物信息；',
  '关联节点填写节点 ID，多个用英文逗号分隔；',
  '上传文件后系统逐行校验，任意一行失败则整批禁止导入。'
]

function handleImported() {
  page.value = 1
  loadPersons()
}

function nodeNames(ids: number[]): string {
  if (!ids.length) return '—'
  return ids.map((id) => nodes.value.find((n) => n.id === id)?.name || `#${id}`).join('、')
}

onMounted(async () => {
  loadPersons()
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
        placeholder="按姓名 / 简介搜索"
        clearable
        style="width: 260px"
        :prefix-icon="'Search'"
      />
      <div class="spacer" />
      <span class="total">共 {{ total }} 条</span>
      <el-button :icon="'Download'" @click="importDialog?.downloadTemplate()">下载导入模板</el-button>
      <el-button :icon="'Upload'" @click="importVisible = true">批量导入</el-button>
      <el-button type="primary" :icon="'Plus'" @click="openCreate">新增人物</el-button>
      <el-button :icon="'Refresh'" @click="loadPersons">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="persons" border stripe row-key="id">
      <el-table-column prop="id" label="ID" width="70" align="center" />
      <el-table-column label="头像" width="70" align="center">
        <template #default="{ row }">
          <el-avatar v-if="row.avatar" :src="row.avatar" :size="36" />
          <span v-else class="none">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" label="姓名" width="120" />
      <el-table-column prop="brief" label="简介" min-width="240" show-overflow-tooltip />
      <el-table-column label="关联节点" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">{{ nodeNames(row.node_ids) }}</template>
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
      layout="total, sizes, prev, pager, next"
      :total="total"
      :page-size="pageSize"
      :page-sizes="[10, 20, 50, 100]"
      :current-page="page"
      @current-change="handlePageChange"
      @size-change="handleSizeChange"
    />

    <ExcelImportDialog
      ref="importDialog"
      v-model="importVisible"
      title="批量导入人物"
      unit="位"
      item-label="位人物"
      template-filename="长征步迹_人物导入模板.xlsx"
      report-prefix="人物导入错误报告"
      :tips="IMPORT_TIPS"
      :api="personImportApi"
      @imported="handleImported"
    />

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="580px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="姓名" prop="name">
          <el-input v-model="form.name" maxlength="50" placeholder="人物姓名" />
        </el-form-item>
        <el-form-item label="头像">
          <div class="avatar-field">
            <div class="avatar-preview">
              <el-avatar v-if="form.avatar" :src="form.avatar" :size="64" />
              <div v-else class="avatar-placeholder">暂无</div>
            </div>
            <div class="avatar-controls">
              <el-upload
                :show-file-list="false"
                :http-request="handleAvatarUpload"
                accept="image/jpeg,image/png,image/webp"
              >
                <el-button type="primary" plain size="small" :loading="avatarUploading">
                  {{ avatarUploading ? '上传中…' : '上传图片' }}
                </el-button>
              </el-upload>
              <el-input
                v-model="form.avatar"
                size="small"
                placeholder="或直接粘贴图片 URL"
                style="width: 260px"
              />
            </div>
          </div>
          <div class="hint">支持 jpg/png/webp，≤2MB；上传成功后自动填入 URL</div>
        </el-form-item>
        <el-form-item label="简介">
          <el-input
            v-model="form.brief"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            placeholder="人物简介"
          />
        </el-form-item>
        <el-form-item label="关联节点">
          <el-select v-model="form.node_ids" multiple filterable placeholder="选择关联节点" style="width: 100%">
            <el-option v-for="n in nodes" :key="n.id" :label="n.name" :value="n.id" />
          </el-select>
          <div class="hint">人物在小程序端展示时将关联到对应路线节点</div>
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

.hint {
  color: #909399;
  font-size: 12px;
  margin-top: 4px;
}

.avatar-field {
  display: flex;
  align-items: center;
  gap: 14px;
}

.avatar-preview {
  flex-shrink: 0;
}

.avatar-placeholder {
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #f5f7fa;
  border: 1px dashed #dcdfe6;
  color: #c0c4cc;
  font-size: 12px;
}

.avatar-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
