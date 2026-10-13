<script setup lang="ts">
// 活动设置：活动名称/起止时间/准入开关/结束页文案配置 + 发布撤回；状态与倒计时以服务端时间为准
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { fetchActivity, publishActivity, saveActivity } from '../api/admin'
import type { ActivityForm, ActivitySetting } from '../api/admin'
import { formatDateTime } from '../utils/format'

const loading = ref(false)
const loadError = ref(false)
const saving = ref(false)
const publishing = ref(false)
const setting = ref<ActivitySetting | null>(null)
const form = reactive<ActivityForm>({
  name: '',
  start_at: '',
  end_at: '',
  restrict_enabled: true,
  allow_view_after_end: true,
  end_title: '',
  end_message: ''
})

// el-date-picker 区间值与表单起止字段双向映射
const range = computed<[string, string] | null>({
  get: () => (form.start_at && form.end_at ? [form.start_at, form.end_at] as [string, string] : null),
  set: (value: [string, string] | null) => {
    form.start_at = value?.[0] ?? ''
    form.end_at = value?.[1] ?? ''
  }
})

// 服务端时间偏移：倒计时不受本机时钟误差影响
const clockOffset = ref(0)
const now = ref(Date.now())
let ticker: number | null = null
let reloading = false

const toMinute = (iso: string | null) => (iso ? iso.slice(0, 16) : '')

function fillForm(data: ActivitySetting) {
  Object.assign(form, {
    name: data.name,
    start_at: toMinute(data.start_at),
    end_at: toMinute(data.end_at),
    restrict_enabled: data.restrict_enabled,
    allow_view_after_end: data.allow_view_after_end,
    end_title: data.end_title,
    end_message: data.end_message
  })
}

function apply(data: ActivitySetting) {
  setting.value = data
  clockOffset.value = Date.parse(data.server_time) - Date.now()
  now.value = Date.now()
  fillForm(data)
}

async function load() {
  loading.value = true
  loadError.value = false
  try {
    apply((await fetchActivity()).data)
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

const countdown = computed(() => {
  const s = setting.value
  if (!s || !s.start_at || !s.end_at) return null
  const target = s.status === 'not_started' ? s.start_at : s.status === 'ongoing' ? s.end_at : null
  if (!target) return null
  const left = Math.max(0, Date.parse(target) - (now.value + clockOffset.value))
  const sec = Math.floor(left / 1000)
  return {
    label: s.status === 'not_started' ? '距开始' : '距结束',
    left,
    parts: [
      { v: Math.floor(sec / 86400), u: '天' },
      { v: Math.floor((sec % 86400) / 3600), u: '时' },
      { v: Math.floor((sec % 3600) / 60), u: '分' },
      { v: sec % 60, u: '秒' }
    ]
  }
})

function tick() {
  now.value = Date.now()
  // 倒计时归零即状态切换，重新拉取服务端状态
  if (countdown.value && countdown.value.left === 0 && !reloading) {
    reloading = true
    load().finally(() => { reloading = false })
  }
}

const dirty = computed(() => {
  const s = setting.value
  if (!s) return false
  return (
    form.name !== s.name ||
    form.start_at !== toMinute(s.start_at) ||
    form.end_at !== toMinute(s.end_at) ||
    form.restrict_enabled !== s.restrict_enabled ||
    form.allow_view_after_end !== s.allow_view_after_end ||
    form.end_title !== s.end_title ||
    form.end_message !== s.end_message
  )
})

const effects = computed(() => {
  const s = setting.value
  if (!s) return []
  return [
    { label: '小程序参与（步数同步/答题/积分）', ok: s.allow_participate },
    { label: '小程序浏览（排名/档案/记录）', ok: s.allow_view }
  ]
})

async function handleSave() {
  if (saving.value) return
  if (!form.name.trim()) return ElMessage.warning('请输入活动名称')
  if (!form.start_at || !form.end_at) return ElMessage.warning('请选择活动起止时间')
  if (form.start_at >= form.end_at) return ElMessage.warning('开始时间必须早于结束时间')
  saving.value = true
  try {
    const { data } = await saveActivity({ ...form, name: form.name.trim(), end_title: form.end_title.trim(), end_message: form.end_message.trim() })
    apply(data)
    ElMessage.success('活动设置已保存，即时生效')
  } finally {
    saving.value = false
  }
}

async function handlePublish(published: boolean) {
  if (publishing.value) return
  if (published && dirty.value) return ElMessage.warning('存在未保存的修改，请先保存活动设置')
  const tip = published
    ? '发布后小程序将按活动时间窗口控制参与与浏览，确定发布吗？'
    : '撤回后小程序将显示「活动暂未发布」，所有参与行为会被拒绝，确定撤回吗？'
  try {
    await ElMessageBox.confirm(tip, published ? '发布活动' : '撤回活动', {
      type: 'warning',
      confirmButtonText: published ? '发布' : '撤回',
      confirmButtonClass: published ? '' : 'el-button--danger'
    })
  } catch {
    return
  }
  publishing.value = true
  try {
    apply((await publishActivity(published)).data)
    ElMessage.success(published ? '活动已发布' : '活动已撤回')
  } finally {
    publishing.value = false
  }
}

function handleReset() {
  if (setting.value) fillForm(setting.value)
}

onMounted(() => {
  load()
  ticker = window.setInterval(tick, 1000)
})
onBeforeUnmount(() => {
  if (ticker !== null) window.clearInterval(ticker)
})
</script>

<template>
  <main class="activity-page" v-loading="loading">
    <el-result v-if="loadError && !setting" icon="error" title="活动设置加载失败" sub-title="请检查网络或稍后重试">
      <template #extra><el-button type="primary" :icon="'Refresh'" @click="load">重新加载</el-button></template>
    </el-result>

    <template v-else-if="setting">
      <section class="hero">
        <div class="hero-main">
          <label><i /> ACTIVITY CONTROL</label>
          <h1>{{ setting.name }}</h1>
          <p>
            <span class="badge" :class="setting.status"><i />{{ setting.status_text }}</span>
            <span v-if="setting.start_at">{{ formatDateTime(setting.start_at) }} — {{ formatDateTime(setting.end_at) }}（北京时间）</span>
          </p>
          <small v-if="setting.updated_at">最近修改：{{ setting.updated_by || '—' }} · {{ formatDateTime(setting.updated_at, '—', true) }}</small>
        </div>
        <div v-if="countdown" class="countdown">
          <span>{{ countdown.label }}</span>
          <div><template v-for="p in countdown.parts" :key="p.u"><b>{{ String(p.v).padStart(2, '0') }}</b><em>{{ p.u }}</em></template></div>
        </div>
        <div v-else class="countdown idle"><span>{{ setting.status === 'ended' ? '征程已圆满结束' : '活动尚未发布' }}</span></div>
      </section>

      <div class="grid">
        <section class="panel">
          <header><div><label>CONFIGURATION</label><h2>活动配置</h2></div><el-tag v-if="dirty" type="warning" effect="plain">有未保存的修改</el-tag></header>
          <el-form label-width="120px" class="form" @submit.prevent>
            <el-form-item label="活动名称" required>
              <el-input v-model="form.name" maxlength="64" show-word-limit placeholder="如：长征步迹·荣耀征程" />
            </el-form-item>
            <el-form-item label="活动时间" required>
              <el-date-picker
                v-model="range"
                type="datetimerange"
                format="YYYY-MM-DD HH:mm"
                value-format="YYYY-MM-DDTHH:mm"
                start-placeholder="开始时间"
                end-placeholder="结束时间"
                range-separator="至"
                :clearable="false"
              />
              <div class="hint">按北京时间解释，精确到分钟；结束时刻起视为活动已结束</div>
            </el-form-item>
            <el-form-item label="启用时间限制">
              <el-switch v-model="form.restrict_enabled" />
              <div class="hint">关闭后不论时间与发布状态，小程序均可正常参与（仅用于应急）</div>
            </el-form-item>
            <el-form-item label="结束后可浏览">
              <el-switch v-model="form.allow_view_after_end" :disabled="!form.restrict_enabled" />
              <div class="hint">开启时活动结束后仍可查看排名与个人档案，但不能再产生步数积分与答题</div>
            </el-form-item>
            <el-form-item label="结束页标题">
              <el-input v-model="form.end_title" maxlength="64" placeholder="留空使用默认：征程圆满 · 荣耀永驻" />
            </el-form-item>
            <el-form-item label="结束页寄语">
              <el-input v-model="form.end_message" type="textarea" :rows="3" maxlength="500" show-word-limit placeholder="留空使用默认结束寄语" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="saving" :disabled="!dirty" @click="handleSave">保存设置</el-button>
              <el-button :disabled="!dirty || saving" @click="handleReset">撤销修改</el-button>
            </el-form-item>
          </el-form>
        </section>

        <aside class="side">
          <section class="panel">
            <header><div><label>PUBLISH</label><h2>发布状态</h2></div></header>
            <div class="publish">
              <div class="pub-state" :class="{ on: setting.is_published }">
                <el-icon><Flag /></el-icon>
                <div><strong>{{ setting.is_published ? '已发布' : '未发布' }}</strong><span>{{ setting.is_published ? '小程序按活动时间窗口控制' : '小程序显示「活动暂未发布」' }}</span></div>
              </div>
              <el-button
                v-if="setting.is_published"
                type="danger"
                plain
                :loading="publishing"
                @click="handlePublish(false)"
              >撤回活动</el-button>
              <el-button v-else type="primary" :loading="publishing" :disabled="!setting.configured" @click="handlePublish(true)">发布活动</el-button>
            </div>
            <ul class="effects">
              <li v-for="e in effects" :key="e.label" :class="{ ok: e.ok }">
                <el-icon><component :is="e.ok ? 'CircleCheck' : 'Lock'" /></el-icon><span>{{ e.label }}</span><b>{{ e.ok ? '允许' : '拒绝' }}</b>
              </li>
            </ul>
            <p v-if="setting.message" class="block-msg">{{ setting.message }}</p>
          </section>

          <section class="panel preview">
            <header><div><label>PREVIEW</label><h2>结束页预览</h2></div></header>
            <div class="end-card">
              <el-icon><Trophy /></el-icon>
              <h3>{{ form.end_title.trim() || '征程圆满 · 荣耀永驻' }}</h3>
              <p>{{ form.end_message.trim() || '本次长征步迹活动已圆满结束，感谢每一位战友的坚持与奔跑。' }}</p>
            </div>
          </section>
        </aside>
      </div>
    </template>
  </main>
</template>

<style scoped>
.activity-page{min-width:960px;min-height:400px;color:#172033}
.hero{position:relative;min-height:170px;padding:30px 38px;display:flex;align-items:center;justify-content:space-between;gap:24px;overflow:hidden;border-radius:20px;color:#fff;background:radial-gradient(circle at 78% 20%,rgb(248 212 119/24%),transparent 30%),linear-gradient(120deg,#7d0b20,#b31230 48%,#1d2638 115%);box-shadow:0 22px 55px rgb(125 11 32/20%)}
.hero:after{content:"";position:absolute;inset:0;opacity:.12;background-image:linear-gradient(rgb(255 255 255/25%) 1px,transparent 1px),linear-gradient(90deg,rgb(255 255 255/25%) 1px,transparent 1px);background-size:34px 34px;pointer-events:none}
.hero>div{position:relative;z-index:1}
.hero label,header label{color:#f8d477;font-size:11px;font-weight:800;letter-spacing:2px}
.hero label{display:flex;align-items:center;gap:9px}.hero label i{width:7px;height:7px;border-radius:50%;background:#f8d477;box-shadow:0 0 0 6px rgb(248 212 119/14%)}
h1{margin:14px 0 10px;font-size:30px;letter-spacing:3px}
.hero p{display:flex;align-items:center;gap:14px;margin:0;color:rgb(255 255 255/80%);font-size:13px}
.hero small{display:block;margin-top:10px;color:rgb(255 255 255/55%);font-size:12px}
.badge{display:inline-flex;align-items:center;gap:7px;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;background:rgb(255 255 255/14%)}
.badge i{width:8px;height:8px;border-radius:50%;background:#8b94a3}
.badge.ongoing i{background:#3ed97a;animation:pulse 1.8s ease-out infinite}
.badge.not_started i{background:#f8d477}.badge.ended i{background:#ff8a8a}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgb(62 217 122/60%)}100%{box-shadow:0 0 0 9px rgb(62 217 122/0%)}}
.countdown{padding:16px 22px;border:1px solid rgb(248 212 119/30%);border-radius:16px;background:rgb(0 0 0/16%);text-align:center}
.countdown span{display:block;margin-bottom:8px;color:#f8d477;font-size:12px;letter-spacing:2px}
.countdown b{display:inline-block;min-width:44px;padding:6px 4px;border-radius:8px;font-size:24px;font-variant-numeric:tabular-nums;background:rgb(255 255 255/10%)}
.countdown em{margin:0 8px 0 4px;color:rgb(255 255 255/60%);font-size:12px;font-style:normal}
.countdown.idle span{margin:0;font-size:14px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:18px;margin-top:18px}
.side{display:flex;flex-direction:column;gap:18px}
.panel{padding:24px;border:1px solid #e8ecf2;border-radius:18px;background:#fff;box-shadow:0 10px 35px rgb(15 23 42/5%)}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}header label{color:#b31230}header h2{margin:4px 0 0;font-size:18px}
.form{max-width:640px}.hint{width:100%;margin-top:4px;color:#909399;font-size:12px;line-height:1.5}
.publish{display:flex;align-items:center;justify-content:space-between;gap:12px}
.pub-state{display:flex;align-items:center;gap:12px}.pub-state .el-icon{width:42px;height:42px;border-radius:12px;font-size:20px;color:#8b94a3;background:#f2f4f7}
.pub-state.on .el-icon{color:#b31230;background:#fff0f3}
.pub-state strong,.pub-state span{display:block}.pub-state span{margin-top:3px;color:#8b94a3;font-size:12px}
.effects{margin:18px 0 0;padding:0;list-style:none}
.effects li{display:flex;align-items:center;gap:8px;padding:10px 0;border-top:1px dashed #edf0f4;color:#c0392b;font-size:13px}
.effects li span{flex:1;color:#4b5668}.effects li.ok{color:#23835b}
.block-msg{margin:10px 0 0;padding:10px 12px;border-radius:10px;color:#9a6b0c;font-size:12px;background:#fff7df}
.end-card{padding:26px 20px;text-align:center;border:1px solid #f0cf79;border-radius:16px;background:linear-gradient(160deg,#fffdf7,#fff1d0)}
.end-card .el-icon{font-size:36px;color:#c99a2e}
.end-card h3{margin:10px 0 8px;color:#7d0b20;letter-spacing:2px}
.end-card p{margin:0;color:#6b5a3a;font-size:13px;line-height:1.7;white-space:pre-wrap}
@media (prefers-reduced-motion:reduce){.badge.ongoing i{animation:none}}
</style>
