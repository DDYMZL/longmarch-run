<script setup lang="ts">
// AI 智能出题：填写生成参数 → 后端调 CloudBase Agent 分批生成 → 预览/逐题编辑 → 管理员确认后批量入库。
// 生成结果始终是草稿，未确认前不写库；保存时后端会重新校验，前端校验仅用于即时反馈。
import { computed, reactive, ref, watch } from 'vue'
import axios from 'axios'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { TableInstance } from 'element-plus'
import { batchSaveAiQuestions, generateAiQuestions } from '../api/admin'
import type { AiQuestionDraft, AiSaveFailure, QuestionUpsert } from '../api/admin'

const LABELS = ['A', 'B', 'C', 'D', 'E', 'F']
const COUNTS = [10, 20, 50, 100]
const TOPIC_MAX_LEN = 100
const DIFFICULTIES = [
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'hard', label: '困难' },
  { value: 'mixed', label: '混合难度' }
]
const CATEGORIES = [
  { value: 'event', label: '历史事件' },
  { value: 'route', label: '长征路线' },
  { value: 'figure', label: '历史人物' }
]
// 库内重复由后端比对全量题库得出，前端无法自行复查，故在题干未被改动前原样保留该标记
const DB_DUPLICATE = '与题库中已有题目重复'
// 错误列表比较用的分隔符：避免多条错误拼接后与单条文本误判相等
const SEP = String.fromCharCode(0)

interface DraftItem {
  key: number
  data: QuestionUpsert
  dbDuplicate: boolean
  baselineQuestion: string
  errors: string[]
}

const visible = defineModel<boolean>({ default: false })
const emit = defineEmits<{ saved: [count: number] }>()

const phase = ref<'form' | 'result'>('form')
const generating = ref(false)
const saving = ref(false)
const generateError = ref('')
const batchErrors = ref<string[]>([])
const saveFailures = ref<AiSaveFailure[]>([])
const items = ref<DraftItem[]>([])
const selection = ref<DraftItem[]>([])
const regeneratingKey = ref<number | null>(null)
const tableRef = ref<TableInstance>()

let nextKey = 1
let abortController: AbortController | null = null

const form = reactive({
  topic: '',
  count: 10,
  difficulty: 'medium',
  category: '',
  extra: ''
})

const validItems = computed(() => items.value.filter((it) => !it.errors.length))
const invalidCount = computed(() => items.value.length - validItems.value.length)

function detailOf(error: unknown): string {
  if (axios.isAxiosError(error)) return error.response?.data?.detail || error.message || ''
  return error instanceof Error ? error.message : ''
}

function cloneData(data: QuestionUpsert): QuestionUpsert {
  return { ...data, options: data.options.map((o) => ({ ...o })) }
}

function toItem(draft: AiQuestionDraft): DraftItem {
  const errors = draft.errors || []
  return {
    key: nextKey++,
    data: cloneData(draft.data),
    dbDuplicate: errors.some((e) => e.includes(DB_DUPLICATE)),
    baselineQuestion: draft.data.question,
    errors: []
  }
}

// 与后端 admin_service._validate_question 同口径，用于编辑时即时提示；入库仍以后端校验为准
function validateItem(item: DraftItem): string[] {
  const data = item.data
  const errors: string[] = []
  const text = data.question.trim()
  if (!text) errors.push('题干不能为空')
  if (data.options.length < 2) errors.push('至少需要 2 个选项')
  if (data.options.some((o) => !o.text.trim())) errors.push('选项内容不能为空')
  const labels = data.options.map((o) => o.label)
  if (new Set(labels).size !== labels.length) errors.push('选项标签重复')
  if (data.answer.length !== 1) errors.push('请选择唯一正确答案')
  else if (!labels.includes(data.answer[0])) errors.push('正确答案不在选项中')
  if (!Number.isInteger(data.score) || data.score <= 0) errors.push('分值必须为正整数')
  if (item.dbDuplicate && text === item.baselineQuestion.trim()) errors.push(DB_DUPLICATE)
  else if (text && items.value.some((o) => o !== item && o.data.question.trim() === text)) {
    errors.push('与其他题目重复')
  }
  return errors
}

function revalidateAll() {
  items.value.forEach((it) => {
    const next = validateItem(it)
    // 结果未变化时不能写回：新数组会再次触发深度 watcher，递归更新超限会中断整轮渲染
    if (signature(next) !== signature(it.errors)) it.errors = next
  })
}

function signature(errors: string[]): string {
  return errors.join(SEP)
}

watch(items, revalidateAll, { deep: true })

function applyResult(drafts: AiQuestionDraft[], errors: string[]) {
  items.value = drafts.map(toItem)
  batchErrors.value = errors || []
  saveFailures.value = []
  revalidateAll()
  tableRef.value?.clearSelection()
}

async function startGenerate() {
  const topic = form.topic.trim()
  if (!topic) {
    ElMessage.warning('请填写出题主题')
    return
  }
  generating.value = true
  generateError.value = ''
  abortController = new AbortController()
  try {
    const { data } = await generateAiQuestions(
      {
        topic,
        count: form.count,
        question_type: 'single',
        difficulty: form.difficulty,
        category: form.category || undefined,
        extra_requirements: form.extra.trim() || undefined
      },
      abortController.signal
    )
    applyResult(data.items, data.batch_errors)
    phase.value = 'result'
    if (data.batch_errors.length) {
      ElMessage.warning(`已生成 ${data.generated} 题，其中 ${data.batch_errors.length} 个批次失败`)
    } else {
      ElMessage.success(`已生成 ${data.generated} 题，请审核后保存`)
    }
  } catch (error) {
    generateError.value = axios.isCancel(error)
      ? '已取消本次生成，未产生任何题目。'
      : detailOf(error) || 'AI 生成失败，请重试'
  } finally {
    generating.value = false
    abortController = null
  }
}

function cancelGenerate() {
  abortController?.abort()
}

function handleClosed() {
  // 关闭弹窗时终止仍在进行的生成请求，避免后端继续消耗 Agent 额度
  cancelGenerate()
}

function backToForm() {
  if (items.value.length) {
    ElMessageBox.confirm('返回将丢弃当前未保存的题目草稿，确定继续吗？', '放弃草稿', {
      type: 'warning',
      confirmButtonText: '丢弃并返回',
      cancelButtonText: '继续审核'
    })
      .then(() => {
        items.value = []
        batchErrors.value = []
        saveFailures.value = []
        generateError.value = ''
        phase.value = 'form'
      })
      .catch(() => undefined)
    return
  }
  phase.value = 'form'
}

async function regenerate(item: DraftItem) {
  const suffix = `（请换一个考点，不要与「${item.data.question.slice(0, 20)}」重复）`
  const topic = form.topic.trim().slice(0, Math.max(10, TOPIC_MAX_LEN - suffix.length)) + suffix
  regeneratingKey.value = item.key
  try {
    const { data } = await generateAiQuestions({
      topic,
      count: 1,
      question_type: 'single',
      difficulty: form.difficulty,
      category: form.category || undefined,
      extra_requirements: form.extra.trim() || undefined
    })
    const draft = data.items[0]
    if (!draft) {
      ElMessage.error('AI 未返回题目，请重试')
      return
    }
    item.data = cloneData(draft.data)
    item.dbDuplicate = (draft.errors || []).some((e) => e.includes(DB_DUPLICATE))
    item.baselineQuestion = draft.data.question
    revalidateAll()
    ElMessage.success('已重新生成该题')
  } catch (error) {
    ElMessage.error(detailOf(error) || '重新生成失败，请重试')
  } finally {
    regeneratingKey.value = null
  }
}

function removeItem(item: DraftItem) {
  items.value = items.value.filter((it) => it.key !== item.key)
}

async function removeSelected() {
  if (!selection.value.length) return
  await ElMessageBox.confirm(`确定删除勾选的 ${selection.value.length} 道题目吗？`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除',
    confirmButtonClass: 'el-button--danger'
  })
  const keys = new Set(selection.value.map((it) => it.key))
  items.value = items.value.filter((it) => !keys.has(it.key))
}

function selectAllValid() {
  tableRef.value?.clearSelection()
  validItems.value.forEach((row) => tableRef.value?.toggleRowSelection(row, true))
}

function onSelectionChange(rows: DraftItem[]) {
  selection.value = rows
}

function setAnswer(item: DraftItem, label: string) {
  item.data.answer = [label]
}

function addOption(item: DraftItem) {
  if (item.data.options.length >= LABELS.length) {
    ElMessage.warning(`最多 ${LABELS.length} 个选项`)
    return
  }
  item.data.options.push({ label: LABELS[item.data.options.length], text: '' })
}

function removeOption(item: DraftItem, index: number) {
  if (item.data.options.length <= 2) {
    ElMessage.warning('至少保留 2 个选项')
    return
  }
  const answerIndex = item.data.options.findIndex((o) => o.label === item.data.answer[0])
  item.data.options.splice(index, 1)
  // 选项标签按位置重排为 A/B/C…，与「新增题目」表单行为一致，同时把答案映射到新标签
  item.data.options.forEach((o, i) => {
    o.label = LABELS[i]
  })
  if (answerIndex === index) item.data.answer = []
  else if (answerIndex > -1) item.data.answer = [LABELS[answerIndex > index ? answerIndex - 1 : answerIndex]]
}

async function handleSave() {
  if (!selection.value.length) {
    ElMessage.warning('请先勾选要保存的题目')
    return
  }
  const rows = [...selection.value]
  saving.value = true
  try {
    const { data } = await batchSaveAiQuestions(rows.map((it) => it.data))
    // failures.index 为提交列表中的序号（从 1 起），据此区分成功与失败行
    const failedIndexes = new Set(data.failures.map((f) => f.index))
    const savedKeys = new Set(
      rows.filter((_row, i) => !failedIndexes.has(i + 1)).map((row) => row.key)
    )
    items.value = items.value.filter((it) => !savedKeys.has(it.key))
    saveFailures.value = data.failures
    tableRef.value?.clearSelection()
    revalidateAll()
    if (data.failed) {
      ElMessage.warning(`已保存 ${data.saved} 题，${data.failed} 题未通过后端校验`)
    } else {
      ElMessage.success(`已保存 ${data.saved} 题到题库`)
    }
    if (data.saved) emit('saved', data.saved)
  } catch (error) {
    ElMessage.error(detailOf(error) || '保存失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="AI 智能出题"
    width="92%"
    top="4vh"
    :close-on-click-modal="false"
    class="ai-dialog"
    @closed="handleClosed"
  >
    <!-- 步骤一：生成参数 -->
    <section v-show="phase === 'form'" class="pane">
      <el-alert type="info" :closable="false" show-icon class="mb">
        <template #title>
          题目由腾讯云 CloudBase Agent 生成为<b>草稿</b>，须逐题审核并勾选后才会写入题库；生成过程不会改动现有题目。
        </template>
      </el-alert>

      <el-form :model="form" label-width="92px" class="gen-form">
        <el-form-item label="出题主题" required>
          <el-input
            v-model="form.topic"
            :maxlength="TOPIC_MAX_LEN"
            show-word-limit
            placeholder="如：红军长征中的重要战役"
          />
        </el-form-item>
        <el-form-item label="生成数量">
          <el-radio-group v-model="form.count">
            <el-radio-button v-for="c in COUNTS" :key="c" :value="c">{{ c }} 道</el-radio-button>
          </el-radio-group>
          <span class="hint">数量越大耗时越长，100 道约需 1~2 分钟</span>
        </el-form-item>
        <el-form-item label="题型">
          <el-tag type="primary" effect="plain">单选题</el-tag>
          <span class="hint">小程序答题逻辑当前仅支持单选，故 AI 出题只生成单选题</span>
        </el-form-item>
        <el-form-item label="难度">
          <el-select v-model="form.difficulty" style="width: 180px">
            <el-option v-for="d in DIFFICULTIES" :key="d.value" :label="d.label" :value="d.value" />
          </el-select>
          <span class="hint">难度仅用于约束生成，不作为题目属性入库</span>
        </el-form-item>
        <el-form-item label="知识分类">
          <el-select v-model="form.category" clearable placeholder="不限分类" style="width: 180px">
            <el-option v-for="c in CATEGORIES" :key="c.value" :label="c.label" :value="c.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="补充要求">
          <el-input
            v-model="form.extra"
            type="textarea"
            :rows="3"
            maxlength="300"
            show-word-limit
            placeholder="如：史实准确，避免重复，附详细解析"
          />
        </el-form-item>
      </el-form>

      <div v-if="generating" class="generating">
        <el-progress :percentage="100" :indeterminate="true" :show-text="false" :duration="3" />
        <p class="generating-text">正在分批调用 AI 生成 {{ form.count }} 道题目，可取消…</p>
      </div>
      <el-alert v-else-if="generateError" type="error" :closable="false" show-icon :title="generateError" />
    </section>

    <!-- 步骤二：草稿预览与审核 -->
    <section v-show="phase === 'result'" class="pane">
      <div class="summary">
        <span class="summary-total">共 <b>{{ items.length }}</b> 题</span>
        <el-tag type="success" size="small">可直接保存 {{ validItems.length }}</el-tag>
        <el-tag v-if="invalidCount" type="danger" size="small">待修正 {{ invalidCount }}</el-tag>
        <el-tag v-if="selection.length" type="primary" size="small">已勾选 {{ selection.length }}</el-tag>
        <div class="spacer" />
        <el-button size="small" @click="selectAllValid" :disabled="!validItems.length">全选可用</el-button>
        <el-button
          size="small"
          type="danger"
          plain
          :disabled="!selection.length"
          @click="removeSelected"
        >
          删除勾选
        </el-button>
      </div>

      <el-alert
        v-for="(msg, i) in batchErrors"
        :key="i"
        type="warning"
        :closable="false"
        show-icon
        :title="msg"
        class="mb"
      />
      <el-alert
        v-if="saveFailures.length"
        type="error"
        show-icon
        class="mb"
        :title="`${saveFailures.length} 题未通过后端校验，已保留在列表中`"
        @close="saveFailures = []"
      >
        <ul class="fail-list">
          <li v-for="f in saveFailures" :key="f.index">第 {{ f.index }} 条：{{ f.reason }}</li>
        </ul>
      </el-alert>

      <el-table
        ref="tableRef"
        v-loading="saving"
        :data="items"
        border
        stripe
        row-key="key"
        max-height="calc(100vh - 400px)"
        class="draft-table"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="46" reserve-selection :selectable="(row: DraftItem) => !row.errors.length" />
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="editor">
              <div class="editor-row">
                <span class="lbl">题干</span>
                <el-input
                  v-model="row.data.question"
                  type="textarea"
                  :rows="2"
                  maxlength="200"
                  show-word-limit
                />
              </div>
              <div class="editor-row">
                <span class="lbl">选项</span>
                <div class="opt-list">
                  <div v-for="(opt, i) in row.data.options" :key="i" class="opt-row">
                    <el-tag size="small" type="info">{{ opt.label }}</el-tag>
                    <el-input v-model="opt.text" maxlength="100" placeholder="选项内容" />
                    <el-radio
                      :model-value="row.data.answer[0] || ''"
                      :value="opt.label"
                      @change="setAnswer(row, opt.label)"
                    >
                      正确答案
                    </el-radio>
                    <el-button link type="danger" :icon="'Delete'" @click="removeOption(row, i)" />
                  </div>
                  <el-button
                    link
                    type="primary"
                    :icon="'Plus'"
                    :disabled="row.data.options.length >= LABELS.length"
                    @click="addOption(row)"
                  >
                    添加选项
                  </el-button>
                </div>
              </div>
              <div class="editor-row">
                <span class="lbl">解析</span>
                <el-input
                  v-model="row.data.analysis"
                  type="textarea"
                  :rows="2"
                  maxlength="300"
                  show-word-limit
                  placeholder="答题后展示给用户的解析"
                />
              </div>
              <div class="editor-row editor-inline">
                <span class="lbl">分类</span>
                <el-select v-model="row.data.category" style="width: 150px">
                  <el-option v-for="c in CATEGORIES" :key="c.value" :label="c.label" :value="c.value" />
                </el-select>
                <span class="lbl">分值</span>
                <el-input-number v-model="row.data.score" :min="1" :max="100" />
              </div>
              <el-alert
                v-if="row.errors.length"
                type="error"
                :closable="false"
                show-icon
                :title="row.errors.join('；')"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column type="index" label="#" width="52" align="center" />
        <el-table-column label="题干" min-width="300" show-overflow-tooltip>
          <template #default="{ row }">{{ row.data.question || '（空题干）' }}</template>
        </el-table-column>
        <el-table-column label="选项" width="76" align="center">
          <template #default="{ row }">{{ row.data.options.length }} 项</template>
        </el-table-column>
        <el-table-column label="答案" width="70" align="center">
          <template #default="{ row }">
            <span class="answer">{{ row.data.answer[0] || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120" align="center">
          <template #default="{ row }">
            <el-tag v-if="!row.errors.length" type="success" size="small">可保存</el-tag>
            <el-tooltip v-else :content="row.errors.join('；')" placement="top">
              <el-tag type="danger" size="small">待修正 {{ row.errors.length }}</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" align="center" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              :loading="regeneratingKey === row.key"
              @click="regenerate(row)"
            >
              重生成
            </el-button>
            <el-button link type="danger" @click="removeItem(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="题目草稿已全部处理完毕" />
        </template>
      </el-table>
    </section>

    <template #footer>
      <template v-if="phase === 'form'">
        <el-button :disabled="generating" @click="visible = false">关闭</el-button>
        <el-button v-if="generating" @click="cancelGenerate">取消生成</el-button>
        <el-button
          type="primary"
          :icon="'MagicStick'"
          :loading="generating"
          @click="startGenerate"
        >
          {{ generating ? '生成中…' : '开始生成' }}
        </el-button>
      </template>
      <template v-else>
        <el-button :disabled="saving" @click="backToForm">重新生成</el-button>
        <el-button :disabled="saving" @click="visible = false">关闭</el-button>
        <el-button type="primary" :loading="saving" :disabled="!selection.length" @click="handleSave">
          保存选中（{{ selection.length }}）
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style scoped>
.pane {
  min-height: 320px;
}

.mb {
  margin-bottom: 12px;
}

.gen-form {
  max-width: 820px;
}

.hint {
  margin-left: 12px;
  color: #909399;
  font-size: 12px;
}

.generating {
  max-width: 820px;
}

.generating-text {
  margin: 10px 0 0;
  color: #606266;
  font-size: 13px;
}

.summary {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.summary-total {
  color: #606266;
  font-size: 13px;
}

.spacer {
  flex: 1;
}

.fail-list {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
}

.answer {
  color: #67c23a;
  font-weight: 600;
}

.editor {
  padding: 4px 12px 12px 48px;
}

.editor-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 10px;
}

.editor-row .lbl {
  flex: 0 0 40px;
  padding-top: 6px;
  color: #909399;
  font-size: 13px;
}

.editor-inline {
  align-items: center;
}

.editor-inline .lbl {
  padding-top: 0;
}

.opt-list {
  flex: 1;
}

.opt-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.draft-table :deep(.el-table__expanded-cell) {
  padding: 12px 0;
}
</style>
