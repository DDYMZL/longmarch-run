<script setup lang="ts">
// Excel 批量导入弹窗：下载模板 → 选择文件上传校验 → 展示错误明细/报告 → 确认导入（令牌一次性）
import { ref, watch } from 'vue'
import { ElMessage, genFileId } from 'element-plus'
import type { UploadFile, UploadInstance, UploadRawFile } from 'element-plus'
import type { AxiosResponse } from 'axios'
import type { ImportPreviewResult } from '../api/admin'
import { csvCell, saveFile, today } from '../utils/download'

export interface ExcelImportApi {
  downloadTemplate: () => Promise<AxiosResponse<Blob>>
  preview: (file: File) => Promise<AxiosResponse<ImportPreviewResult>>
  confirm: (previewToken: string) => Promise<AxiosResponse<{ imported: number }>>
}

const props = defineProps<{
  title: string
  // 计量单位，如「题」「条」
  unit: string
  // 成功提示中的对象名，如「道题目」「条寄语」
  itemLabel: string
  templateFilename: string
  reportPrefix: string
  tips: string[]
  api: ExcelImportApi
}>()

const visible = defineModel<boolean>({ required: true })
const emit = defineEmits<{ imported: [count: number] }>()

const uploadRef = ref<UploadInstance>()
const importFile = ref<File | null>(null)
const previewing = ref(false)
const confirming = ref(false)
const preview = ref<ImportPreviewResult | null>(null)

watch(visible, (open) => {
  if (!open) return
  importFile.value = null
  preview.value = null
})

function handleFileChange(file: UploadFile) {
  importFile.value = file.raw ?? null
  preview.value = null
}

// limit=1 时再次选择会触发 exceed，替换为新文件以便修正后在同一弹窗重新上传
function handleExceed(files: File[]) {
  uploadRef.value?.clearFiles()
  const file = files[0] as UploadRawFile
  file.uid = genFileId()
  uploadRef.value?.handleStart(file)
}

async function handlePreview() {
  if (!importFile.value) {
    ElMessage.warning('请先选择填写好的 .xlsx 文件')
    return
  }
  previewing.value = true
  try {
    const { data } = await props.api.preview(importFile.value)
    preview.value = data
    if (data.invalid_count === 0) {
      ElMessage.success(`校验通过：${data.valid_count} 行可导入`)
    } else {
      ElMessage.warning(`发现 ${data.invalid_count} 行错误，修正后请重新上传`)
    }
  } finally {
    previewing.value = false
  }
}

async function handleConfirm() {
  if (!preview.value || confirming.value) return
  confirming.value = true
  try {
    const { data } = await props.api.confirm(preview.value.preview_token)
    ElMessage.success(`成功导入 ${data.imported} ${props.itemLabel}`)
    visible.value = false
    emit('imported', data.imported)
  } finally {
    confirming.value = false
  }
}

async function downloadTemplate() {
  const { data } = await props.api.downloadTemplate()
  saveFile(data, props.templateFilename)
}

function downloadErrorReport() {
  if (!preview.value?.errors.length) return
  const header = ['Excel行号', '出错字段', '错误原因']
  const rows = preview.value.errors.map((e) => [e.row, e.field || '整行', e.reason])
  const content = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  saveFile(`\uFEFF${content}`, `${props.reportPrefix}_${today()}.csv`, 'text/csv;charset=utf-8')
}

defineExpose({ downloadTemplate })
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="720px" destroy-on-close>
    <el-alert type="info" :closable="false" class="import-tip">
      <p v-for="(tip, i) in tips" :key="tip">{{ i + 1 }}. {{ tip }}</p>
    </el-alert>
    <div class="import-actions">
      <el-button :icon="'Download'" @click="downloadTemplate">下载导入模板</el-button>
      <el-upload
        ref="uploadRef"
        :auto-upload="false"
        :show-file-list="false"
        accept=".xlsx"
        :limit="1"
        :on-change="handleFileChange"
        :on-exceed="handleExceed"
      >
        <el-button type="primary" plain :icon="'FolderOpened'">
          {{ importFile ? importFile.name : '选择 .xlsx 文件' }}
        </el-button>
      </el-upload>
      <el-button type="primary" :loading="previewing" :disabled="!importFile" @click="handlePreview">
        上传校验
      </el-button>
    </div>

    <template v-if="preview">
      <el-alert :type="preview.invalid_count === 0 ? 'success' : 'error'" :closable="false" class="import-tip">
        共 {{ preview.total }} 行：有效 {{ preview.valid_count }} 行，错误 {{ preview.invalid_count }} 行
      </el-alert>
      <template v-if="preview.errors.length">
        <div class="error-header">
          <span class="error-title">错误明细</span>
          <el-button link type="primary" :icon="'Download'" @click="downloadErrorReport">下载错误报告</el-button>
        </div>
        <el-table :data="preview.errors" border size="small" max-height="280">
          <el-table-column prop="row" label="Excel行号" width="90" align="center" />
          <el-table-column label="出错字段" width="110" align="center">
            <template #default="{ row }">{{ row.field || '整行' }}</template>
          </el-table-column>
          <el-table-column prop="reason" label="错误原因" min-width="260" show-overflow-tooltip />
        </el-table>
      </template>
    </template>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="confirming"
        :disabled="!preview || preview.invalid_count > 0 || preview.valid_count === 0"
        @click="handleConfirm"
      >
        确认导入{{ preview && preview.valid_count ? ` ${preview.valid_count} ${unit}` : '' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.import-tip {
  margin-bottom: 14px;
}

.import-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.error-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 10px 0 6px;
}

.error-title {
  font-weight: 600;
  color: #f56c6c;
}
</style>
