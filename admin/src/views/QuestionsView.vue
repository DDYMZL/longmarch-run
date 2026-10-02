<script setup lang="ts">
// 题库维护：列表（类型筛选 + 关键字搜索）、新增、编辑、删除
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import {
  createQuestion,
  deleteQuestion,
  fetchQuestions,
  updateQuestion
} from '../api/admin'
import type { Question, QuestionOption } from '../api/admin'

const LABELS = ['A', 'B', 'C', 'D', 'E', 'F']
const CATEGORIES = [
  { value: 'event', label: '历史事件' },
  { value: 'route', label: '长征路线' },
  { value: 'figure', label: '历史人物' }
]
const categoryLabel = (value: string) => CATEGORIES.find((c) => c.value === value)?.label || '未分类'

const loading = ref(false)
const questions = ref<Question[]>([])
const filterType = ref('')
const filterCategory = ref('')
const keyword = ref('')

const filtered = computed(() =>
  questions.value.filter((q) => {
    if (filterType.value && q.type !== filterType.value) return false
    if (filterCategory.value && q.category !== filterCategory.value) return false
    if (keyword.value && !q.question.includes(keyword.value.trim())) return false
    return true
  })
)

async function loadQuestions() {
  loading.value = true
  try {
    const { data } = await fetchQuestions()
    questions.value = data.items
  } finally {
    loading.value = false
  }
}

// ---------------- 新增 / 编辑弹窗 ----------------
const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

const form = reactive({
  type: 'single',
  category: 'event',
  question: '',
  optionTexts: [] as string[],
  answer: '',
  analysis: '',
  score: 20
})

const rules: FormRules = {
  type: [{ required: true, message: '请选择题型', trigger: 'change' }],
  question: [{ required: true, message: '请输入题干', trigger: 'blur' }],
  answer: [{ required: true, message: '请选择正确答案', trigger: 'change' }],
  score: [{ required: true, message: '请输入分值', trigger: 'blur' }]
}

const dialogTitle = computed(() => (editingId.value === null ? '新增题目' : `编辑题目 #${editingId.value}`))

function switchType(type: string) {
  // 切换题型时重置选项与答案：判断题固定「正确/错误」，单选默认 4 个空选项
  form.answer = ''
  if (type === 'judge') {
    form.optionTexts = ['正确', '错误']
  } else {
    form.optionTexts = ['', '', '', '']
  }
}

function openCreate() {
  editingId.value = null
  form.type = 'single'
  form.category = 'event'
  form.question = ''
  form.optionTexts = ['', '', '', '']
  form.answer = ''
  form.analysis = ''
  form.score = 20
  dialogVisible.value = true
}

function openEdit(row: Question) {
  editingId.value = row.id
  form.type = row.type
  form.category = row.category || 'event'
  form.question = row.question
  form.optionTexts = row.options.map((o) => o.text)
  form.answer = row.answer[0] || ''
  form.analysis = row.analysis
  form.score = row.score
  dialogVisible.value = true
}

function addOption() {
  if (form.optionTexts.length >= 6) {
    ElMessage.warning('最多 6 个选项')
    return
  }
  form.optionTexts.push('')
}

function removeOption(index: number) {
  if (form.optionTexts.length <= 2) {
    ElMessage.warning('至少保留 2 个选项')
    return
  }
  form.optionTexts.splice(index, 1)
  if (form.answer === LABELS[index]) form.answer = ''
}

function validateOptions(): string | null {
  if (form.optionTexts.some((t) => !t.trim())) return '选项内容不能为空'
  return null
}

async function handleSave() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  const optionError = validateOptions()
  if (optionError) {
    ElMessage.warning(optionError)
    return
  }
  const payload = {
    type: form.type,
    category: form.category,
    question: form.question.trim(),
    options: form.optionTexts.map((text, i) => ({ label: LABELS[i], text: text.trim() })),
    answer: [form.answer],
    analysis: form.analysis.trim(),
    score: Number(form.score)
  }
  saving.value = true
  try {
    if (editingId.value === null) {
      await createQuestion(payload)
      ElMessage.success('新增成功')
    } else {
      await updateQuestion(editingId.value, payload)
      ElMessage.success('保存成功')
    }
    dialogVisible.value = false
    await loadQuestions()
  } finally {
    saving.value = false
  }
}

async function handleDelete(row: Question) {
  await ElMessageBox.confirm(`确定删除题目「${row.question}」吗？`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除',
    confirmButtonClass: 'el-button--danger'
  })
  await deleteQuestion(row.id)
  ElMessage.success('已删除')
  await loadQuestions()
}

function answerText(row: Question): string {
  return row.options
    .filter((o) => row.answer.includes(o.label))
    .map((o) => `${o.label}. ${o.text}`)
    .join('；')
}

onMounted(loadQuestions)
</script>

<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-select v-model="filterType" placeholder="全部题型" clearable style="width: 140px">
        <el-option label="单选题" value="single" />
        <el-option label="判断题" value="judge" />
      </el-select>
      <el-select v-model="filterCategory" placeholder="全部分类" clearable style="width: 140px">
        <el-option v-for="c in CATEGORIES" :key="c.value" :label="c.label" :value="c.value" />
      </el-select>
      <el-input
        v-model="keyword"
        placeholder="按题干关键字搜索"
        clearable
        style="width: 260px"
        :prefix-icon="'Search'"
      />
      <div class="spacer" />
      <span class="total">共 {{ questions.length }} 题</span>
      <el-button type="primary" :icon="'Plus'" @click="openCreate">新增题目</el-button>
      <el-button :icon="'Refresh'" @click="loadQuestions">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="filtered" border stripe row-key="id">
      <el-table-column prop="id" label="ID" width="64" align="center" />
      <el-table-column label="题型" width="90" align="center">
        <template #default="{ row }">
          <el-tag :type="row.type === 'single' ? 'primary' : 'success'" size="small">
            {{ row.type === 'single' ? '单选题' : '判断题' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="分类" width="100" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="row.category ? 'warning' : 'info'" effect="plain">{{ categoryLabel(row.category) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="question" label="题干" min-width="260" show-overflow-tooltip />
      <el-table-column label="选项" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          {{ row.options.map((o: QuestionOption) => `${o.label}.${o.text}`).join('　') }}
        </template>
      </el-table-column>
      <el-table-column label="正确答案" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="answer">{{ answerText(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="score" label="分值" width="70" align="center" />
      <el-table-column label="操作" width="140" align="center" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="640px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="题型" prop="type">
          <el-radio-group v-model="form.type" @change="switchType(form.type)">
            <el-radio-button value="single">单选题</el-radio-button>
            <el-radio-button value="judge">判断题</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="知识分类">
          <el-select v-model="form.category" style="width: 200px">
            <el-option v-for="c in CATEGORIES" :key="c.value" :label="c.label" :value="c.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="题干" prop="question">
          <el-input v-model="form.question" type="textarea" :rows="2" maxlength="200" show-word-limit
            placeholder="请输入题干" />
        </el-form-item>
        <el-form-item label="选项">
          <div class="option-list">
            <div v-for="(_text, index) in form.optionTexts" :key="index" class="option-row">
              <el-tag size="small" type="info">{{ LABELS[index] }}</el-tag>
              <el-input v-model="form.optionTexts[index]" :disabled="form.type === 'judge'"
                placeholder="选项内容" maxlength="100" />
              <el-button v-if="form.type !== 'judge'" link type="danger" :icon="'Delete'"
                @click="removeOption(index)" />
            </div>
            <el-button v-if="form.type !== 'judge'" link type="primary" :icon="'Plus'" @click="addOption">
              添加选项
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="正确答案" prop="answer">
          <el-radio-group v-model="form.answer">
            <el-radio v-for="(_text, index) in form.optionTexts" :key="index" :value="LABELS[index]">
              {{ LABELS[index] }}
            </el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="解析">
          <el-input v-model="form.analysis" type="textarea" :rows="2" maxlength="300" show-word-limit
            placeholder="答题后展示给用户的解析（可空）" />
        </el-form-item>
        <el-form-item label="分值" prop="score">
          <el-input-number v-model="form.score" :min="1" :max="100" />
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

.answer {
  color: #67c23a;
}

.option-list {
  width: 100%;
}

.option-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
</style>
