<script setup lang="ts">
// 运营参数配置：GET 拉取 values/defaults/ranges/overridden，PUT 白名单提交
// 参照 AI 配置页交互模式：表单化展示、标注已覆盖项、一键重置为默认值
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { fetchOperationConfig, saveOperationConfig } from '../api/admin'
import type { OperationConfigView } from '../api/admin'

const loading = ref(false)
const saving = ref(false)
const config = ref<OperationConfigView | null>(null)
const form = reactive<Record<string, number | boolean | string>>({})

// 参数元数据：label + 分组 + 说明（key 与后端 _SPEC 小写字段名一致）
const META: Record<string, { label: string; group: string; tip?: string }> = {
  stride_m: { label: '步幅（米）', group: '运动换算', tip: '每步对应的米数，影响里程计算' },
  streak_goal_steps: { label: '连续打卡目标步数', group: '运动换算', tip: '每日达到此步数算打卡成功' },
  points_walk_steps_per_point: { label: '行走积分：每N步=1分', group: '积分规则', tip: '步数兑换积分的比率' },
  points_quiz_per_correct: { label: '答题积分：每正确1题', group: '积分规则', tip: '每答对一题获得的积分' },
  points_quiz_daily_cap: { label: '答题积分日上限', group: '积分规则', tip: '每日答题积分最多获得' },
  quiz_question_seconds: { label: '答题时间（秒）', group: '答题设置', tip: '每道题的作答时间限制' },
  quiz_answer_grace_seconds: { label: '答题宽限（秒）', group: '答题设置', tip: '超时后的额外宽限时间' },
  global_goal_steps: { label: '全局目标步数', group: '长征路线', tip: '完成长征全程所需总步数' },
  activity_mask_nickname: { label: '昵称脱敏', group: '隐私设置', tip: '公开排行榜是否对昵称脱敏显示' }
}

const GROUPS = ['运动换算', '积分规则', '答题设置', '长征路线', '隐私设置']

function groupedKeys(group: string): string[] {
  return Object.keys(META).filter((k) => META[k].group === group && k in form)
}

function isOverridden(key: string): boolean {
  return config.value?.overridden.includes(key) ?? false
}

function getRange(key: string) {
  return config.value?.ranges[key]
}

function isBoolean(key: string): boolean {
  return typeof form[key] === 'boolean'
}

const hasChanges = ref(false)

// 浮点归一化：避免 stride_m 等小数累加产生伪 diff
function normalize(v: number | boolean | string): number | boolean | string {
  if (typeof v === 'number') return Math.round(v * 1000) / 1000
  return v
}

function checkChanges() {
  if (!config.value) { hasChanges.value = false; return }
  hasChanges.value = Object.keys(form).some(
    (k) => normalize(form[k]) !== normalize(config.value!.values[k])
  )
}

async function load() {
  loading.value = true
  try {
    const { data } = await fetchOperationConfig()
    config.value = data
    // 清空并重建 form
    Object.keys(form).forEach((k) => delete form[k])
    Object.assign(form, data.values)
    checkChanges()
  } finally {
    loading.value = false
  }
}

async function handleSave() {
  // D12：只提交相对已加载值发生变化的字段，避免全量覆盖导致默认值被固化
  const diff: Record<string, number | boolean | string> = {}
  if (config.value) {
    for (const k of Object.keys(form)) {
      if (normalize(form[k]) !== normalize(config.value.values[k])) {
        diff[k] = form[k]
      }
    }
  }
  if (!Object.keys(diff).length) {
    ElMessage.info('没有需要保存的修改')
    return
  }
  saving.value = true
  // 保存前快照，失败时回滚
  const snapshot = { ...form }
  try {
    const { data } = await saveOperationConfig(diff)
    config.value = data
    Object.keys(form).forEach((k) => delete form[k])
    Object.assign(form, data.values)
    hasChanges.value = false
    ElMessage.success('运营参数已保存')
  } catch (e: unknown) {
    // D9：保存失败回滚表单到提交前状态
    Object.keys(form).forEach((k) => delete form[k])
    Object.assign(form, snapshot)
    const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
    ElMessage.error(detail || '保存失败，请稍后重试')
  } finally {
    saving.value = false
  }
}

function resetKey(key: string) {
  if (config.value) {
    form[key] = config.value.defaults[key]
  }
}

onMounted(() => {
  load()
})
</script>

<template>
  <el-card v-loading="loading" shadow="never">
    <template #header>
      <div class="card-header">
        <span class="card-title">运营参数配置</span>
        <div class="card-actions">
          <el-button :icon="'Refresh'" @click="load">重新加载</el-button>
          <el-button
            type="primary"
            :loading="saving"
            :disabled="!hasChanges"
            @click="handleSave"
          >
            保存修改
          </el-button>
        </div>
      </div>
    </template>

    <el-alert type="info" :closable="false" class="page-tip">
      修改后点击「保存修改」即时生效，影响小程序端的运动换算、积分计算、答题规则等。
      标记 <el-tag size="small" type="warning" effect="plain">已覆盖</el-tag> 的参数表示当前值与系统默认不同。
    </el-alert>

    <div v-for="group in GROUPS" :key="group" class="config-group">
      <h3 class="group-title">{{ group }}</h3>
      <el-form label-width="180px" class="config-form">
        <el-form-item v-for="key in groupedKeys(group)" :key="key">
          <template #label>
            <span class="param-label">
              {{ META[key]?.label || key }}
              <el-tag v-if="isOverridden(key)" size="small" type="warning" effect="plain" class="override-tag">已覆盖</el-tag>
            </span>
          </template>
          <div class="param-control">
            <template v-if="isBoolean(key)">
              <el-switch v-model="form[key]" @change="checkChanges" />
            </template>
            <template v-else>
              <el-input-number
                v-if="getRange(key)"
                v-model="form[key] as number"
                :min="getRange(key)!.min"
                :max="getRange(key)!.max"
                :step="getRange(key)!.step || 1"
                controls-position="right"
                style="width: 180px"
                @change="checkChanges"
              />
              <el-input
                v-else
                v-model="form[key] as string"
                style="width: 180px"
                @input="checkChanges"
              />
            </template>
            <el-button
              v-if="isOverridden(key)"
              link
              type="primary"
              class="reset-btn"
              @click="resetKey(key); checkChanges()"
            >
              重置为默认（{{ config?.defaults[key] }}）
            </el-button>
            <span v-if="META[key]?.tip" class="param-tip">{{ META[key].tip }}</span>
          </div>
        </el-form-item>
      </el-form>
    </div>

    <!-- 未知 key 兜底展示 -->
    <div v-if="Object.keys(form).some((k) => !META[k])" class="config-group">
      <h3 class="group-title">其他参数</h3>
      <el-form label-width="180px" class="config-form">
        <el-form-item v-for="key in Object.keys(form).filter((k) => !META[k])" :key="key" :label="key">
          <el-input v-model="form[key] as string" style="width: 240px" @input="checkChanges" />
        </el-form-item>
      </el-form>
    </div>
  </el-card>
</template>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.card-actions {
  display: flex;
  gap: 10px;
}

.page-tip {
  margin-bottom: 20px;
}

.config-group {
  margin-bottom: 28px;
}

.group-title {
  font-size: 14px;
  font-weight: 600;
  color: #5a1a1a;
  margin: 0 0 14px;
  padding-left: 10px;
  border-left: 3px solid #C8102E;
}

.config-form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.param-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.override-tag {
  font-size: 11px;
}

.param-control {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.param-tip {
  color: #909399;
  font-size: 12px;
}

.reset-btn {
  font-size: 12px;
}
</style>
