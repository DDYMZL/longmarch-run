<script setup lang="ts">
// 复制导入：粘贴文本 → 分页预览 → 一次写入（最多 500 道，默认 20 分）→ 导入成功后再统一改分值。
import { computed, ref, watch } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'
import { pasteImportQuestions, updateQuestionScores } from '../api/admin'
import type { AiSaveFailure, QuestionUpsert } from '../api/admin'
import { parsePastedQuestions } from '../utils/pasteQuestions'
import type { PastedQuestion } from '../utils/pasteQuestions'

const CATEGORIES = [
  { value: 'event', label: '历史事件' },
  { value: 'route', label: '长征路线' },
  { value: 'figure', label: '历史人物' }
]
const PREVIEW_PAGE_SIZE = 20
const DEFAULT_SCORE = 20

const visible = defineModel<boolean>({ default: false })
const emit = defineEmits<{ saved: [] }>()

const raw = ref('')
const category = ref('event')
const items = ref<PastedQuestion[]>([])
const overflow = ref(0)
const parsed = ref(false)
const saving = ref(false)
const scoreSaving = ref(false)
const selectedKeys = ref(new Set<number>())
const saveFailures = ref<AiSaveFailure[]>([])
const phase = ref<'edit' | 'score'>('edit')
const importedIds = ref<number[]>([])
const importedCount = ref(0)
const score = ref(DEFAULT_SCORE)
const previewPage = ref(1)

const validItems = computed(() => items.value.filter((item) => !item.errors.length))
const selectedCount = computed(
  () => validItems.value.filter((item) => selectedKeys.value.has(item.key)).length
)
const pageItems = computed(() => {
  const start = (previewPage.value - 1) * PREVIEW_PAGE_SIZE
  return items.value.slice(start, start + PREVIEW_PAGE_SIZE)
})
const pageValid = computed(() => pageItems.value.filter((item) => !item.errors.length))
const pageAllChecked = computed(
  () => pageValid.value.length > 0 && pageValid.value.every((item) => selectedKeys.value.has(item.key))
)
const pageIndeterminate = computed(() => {
  const checked = pageValid.value.filter((item) => selectedKeys.value.has(item.key)).length
  return checked > 0 && checked < pageValid.value.length
})

watch(raw, () => {
  parsed.value = false
  items.value = []
  overflow.value = 0
  selectedKeys.value = new Set()
  saveFailures.value = []
  previewPage.value = 1
})

watch(visible, (open) => {
  if (open) return
  raw.value = ''
  category.value = 'event'
  score.value = DEFAULT_SCORE
  phase.value = 'edit'
  importedIds.value = []
  importedCount.value = 0
  saving.value = false
  scoreSaving.value = false
})

function detailOf(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail
    if (typeof detail === 'string') return detail
    return error.message
  }
  return error instanceof Error ? error.message : ''
}

function optionText(row: PastedQuestion): string {
  return row.options.map((option) => `${option.label}. ${option.text}`).join('　')
}

function answerText(row: PastedQuestion): string {
  return row.options
    .filter((option) => row.answer.includes(option.label))
    .map((option) => `${option.label}. ${option.text}`)
    .join('；')
}

function replaceSelection(next: Set<number>) {
  selectedKeys.value = next
}

function toggleRow(key: number, checked: boolean) {
  const next = new Set(selectedKeys.value)
  if (checked) next.add(key)
  else next.delete(key)
  replaceSelection(next)
}

function togglePage(checked: boolean) {
  const next = new Set(selectedKeys.value)
  pageValid.value.forEach((item) => {
    if (checked) next.add(item.key)
    else next.delete(item.key)
  })
  replaceSelection(next)
}

function selectAllValid() {
  replaceSelection(new Set(validItems.value.map((item) => item.key)))
}

function handleParse() {
  const result = parsePastedQuestions(raw.value)
  items.value = result.items
  overflow.value = result.overflow
  parsed.value = true
  saveFailures.value = []
  previewPage.value = 1
  selectAllValid()
  if (!result.items.length) {
    ElMessage.warning('没有识别到题目，请按说明里的格式粘贴')
    return
  }
  const invalid = result.items.length - validItems.value.length
  if (!invalid) ElMessage.success(`识别到 ${result.items.length} 道题目`)
  else ElMessage.warning(`识别到 ${result.items.length} 道，其中 ${invalid} 道需要修改`)
}

function toPayload(row: PastedQuestion): QuestionUpsert {
  return {
    type: row.type,
    category: category.value,
    question: row.question.trim(),
    options: row.options.map((option) => ({ label: option.label, text: option.text.trim() })),
    answer: [...row.answer],
    analysis: row.analysis.trim(),
    score: DEFAULT_SCORE
  }
}

async function handleImport() {
  const rows = validItems.value.filter((item) => selectedKeys.value.has(item.key))
  if (!rows.length) {
    ElMessage.warning('请先勾选校验通过的题目')
    return
  }
  saving.value = true
  saveFailures.value = []
  try {
    const { data } = await pasteImportQuestions(rows.map(toPayload))
    const failed = new Map(data.failures.map((failure) => [failure.index, failure.reason]))
    const failedKeys = new Set<number>()
    rows.forEach((row, index) => {
      const reason = failed.get(index + 1)
      if (!reason) return
      row.errors = [reason]
      failedKeys.add(row.key)
    })
    saveFailures.value = data.failures
    if (data.saved) {
      importedIds.value = data.ids
      importedCount.value = data.saved
      score.value = DEFAULT_SCORE
      phase.value = 'score'
      emit('saved')
    }
    if (data.failed && !data.saved) {
      ElMessage.warning(`${data.failed} 道未写入`)
    } else if (data.failed) {
      ElMessage.warning(`已导入 ${data.saved} 道，${data.failed} 道未写入`)
    }
  } catch (error) {
    ElMessage.error(detailOf(error) || '导入失败，请重试')
  } finally {
    saving.value = false
  }
}

async function handleSaveScore() {
  if (!Number.isInteger(score.value) || score.value < 1 || score.value > 100) {
    ElMessage.warning('分值须为 1 到 100 的整数')
    return
  }
  if (score.value === DEFAULT_SCORE) {
    ElMessage.success(`已按每题 ${DEFAULT_SCORE} 分保存`)
    visible.value = false
    return
  }
  scoreSaving.value = true
  try {
    const { data } = await updateQuestionScores(importedIds.value, score.value)
    ElMessage.success(`已将 ${data.updated} 道题目的分值设为 ${score.value}`)
    emit('saved')
    visible.value = false
  } catch (error) {
    ElMessage.error(detailOf(error) || '分值保存失败，请重试')
  } finally {
    scoreSaving.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="phase === 'score' ? '设置分值' : '复制导入题目'"
    width="92%"
    top="4vh"
    :close-on-click-modal="false"
  >
    <template v-if="phase === 'score'">
      <el-alert type="success" :closable="false" show-icon class="gap">
        已导入 {{ importedCount }} 道题目，默认每题 {{ DEFAULT_SCORE }} 分。可以改成其他分值，只影响这一批。
      </el-alert>
      <el-alert
        v-if="saveFailures.length"
        type="warning"
        :closable="false"
        show-icon
        class="gap"
        :title="`${saveFailures.length} 道未写入`"
      >
        <ul class="fail-list">
          <li v-for="failure in saveFailures.slice(0, 8)" :key="failure.index">
            第 {{ failure.index }} 条：{{ failure.reason }}
          </li>
          <li v-if="saveFailures.length > 8">其余 {{ saveFailures.length - 8 }} 条未列出</li>
        </ul>
      </el-alert>
      <div class="settings">
        <span class="lbl">分值</span>
        <el-input-number v-model="score" :min="1" :max="100" :step="1" :precision="0" />
      </div>
    </template>

    <template v-else>
      <el-alert type="info" :closable="false" show-icon class="gap">
        每道题之间空一行，同一道题里不要空行。题干在最前，选项以 A. / B. / C. / D. 开头（也支持 A、和 A）），下一行写【答案】，【解析】可以不写。单次最多 500 道。导入成功后再设置分值，不改则每题 20 分。
      </el-alert>

      <div class="settings">
        <span class="lbl">知识分类</span>
        <el-select v-model="category" style="width: 160px">
          <el-option v-for="item in CATEGORIES" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </div>

      <el-input
        v-model="raw"
        type="textarea"
        :rows="8"
        resize="vertical"
        placeholder="在这里粘贴题目，例如：&#10;中央红军长征的起点是（ ）。&#10;A. 井冈山&#10;B. 瑞金&#10;C. 延安&#10;D. 遵义&#10;【答案】B&#10;【解析】1934年10月，中央红军从江西瑞金出发。"
      />

      <div class="parse-row">
        <el-button type="primary" plain @click="handleParse">解析预览</el-button>
        <span v-if="parsed" class="summary">
          共 {{ items.length }} 道，可导入 {{ validItems.length }} 道
          <template v-if="selectedCount">，已勾选 {{ selectedCount }} 道</template>
        </span>
        <el-button v-if="validItems.length" link type="primary" @click="selectAllValid">全选可导入</el-button>
      </div>

      <el-alert
        v-if="overflow"
        type="warning"
        :closable="false"
        show-icon
        class="gap"
        :title="`单次最多预览 500 道，还有 ${overflow} 道未列入，请分批粘贴`"
      />

      <el-table v-if="items.length" :data="pageItems" border stripe row-key="key" max-height="360">
        <el-table-column width="52" align="center">
          <template #header>
            <el-checkbox
              :model-value="pageAllChecked"
              :indeterminate="pageIndeterminate"
              :disabled="!pageValid.length"
              @change="togglePage(Boolean($event))"
            />
          </template>
          <template #default="{ row }">
            <el-checkbox
              :model-value="selectedKeys.has(row.key)"
              :disabled="!!row.errors.length"
              @change="toggleRow(row.key, Boolean($event))"
            />
          </template>
        </el-table-column>
        <el-table-column label="#" width="64" align="center">
          <template #default="{ row }">{{ items.indexOf(row) + 1 }}</template>
        </el-table-column>
        <el-table-column label="题型" width="80" align="center">
          <template #default="{ row }">{{ row.type === 'judge' ? '判断' : '单选' }}</template>
        </el-table-column>
        <el-table-column prop="question" label="题干" min-width="220" show-overflow-tooltip />
        <el-table-column label="选项" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ optionText(row) }}</template>
        </el-table-column>
        <el-table-column label="答案" min-width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ answerText(row) || '—' }}</template>
        </el-table-column>
        <el-table-column prop="analysis" label="解析" min-width="160" show-overflow-tooltip />
        <el-table-column label="校验" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.errors.length" class="bad">{{ row.errors.join('；') }}</span>
            <span v-else class="ok">可导入</span>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-if="items.length > PREVIEW_PAGE_SIZE"
        v-model:current-page="previewPage"
        :page-size="PREVIEW_PAGE_SIZE"
        :total="items.length"
        layout="total, prev, pager, next"
        class="pager"
        size="small"
      />
    </template>

    <template #footer>
      <template v-if="phase === 'score'">
        <el-button @click="visible = false">完成</el-button>
        <el-button type="primary" :loading="scoreSaving" @click="handleSaveScore">保存分值</el-button>
      </template>
      <template v-else>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!selectedCount" @click="handleImport">
          导入勾选的题目
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style scoped>
.gap {
  margin-bottom: 12px;
}

.settings {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.lbl {
  color: #606266;
  font-size: 14px;
}

.parse-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0;
}

.summary {
  color: #606266;
  font-size: 13px;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}

.ok {
  color: #67c23a;
}

.bad {
  color: #f56c6c;
}

.fail-list {
  margin: 6px 0 0;
  padding-left: 18px;
}
</style>
