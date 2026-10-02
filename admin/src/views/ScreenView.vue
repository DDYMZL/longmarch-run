<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { fetchScreen, type ScreenResult } from '../api/admin'
import { formatNumber, formatTime, useLiveUpdates } from '../utils/liveUpdates'

const router = useRouter()
const loading = ref(false)
const state = ref<ScreenResult>({
  metrics: { total_users: 0, today_users: 0, total_steps: 0, avg_steps: 0, completion_rate: 0, quiz_users: 0, medals_granted: 0 },
  route_overview: [],
  trend: [],
  activities: []
})

async function load() {
  loading.value = true
  try { state.value = (await fetchScreen()).data } finally { loading.value = false }
}

let reloadTimer: number | null = null
function scheduleReload() {
  if (reloadTimer !== null) return
  reloadTimer = window.setTimeout(() => { reloadTimer = null; load() }, 800)
}

const { wsStatus } = useLiveUpdates((data) => {
  if (data.type === 'data_changed') scheduleReload()
  if (data.type === 'activity' && data.text) {
    state.value = {
      ...state.value,
      activities: [{ id: Date.now(), event_type: String(data.eventType || ''), event_time: new Date().toISOString(), user_id: 0, nickname: String(data.nickname || ''), text: String(data.text), data: {} }, ...state.value.activities].slice(0, 20)
    }
  }
})

const metricCards = computed(() => {
  const m = state.value.metrics
  return [
    { label: '参与人数', value: m.total_users, icon: '👥' },
    { label: '今日运动人数', value: m.today_users, icon: '🏃' },
    { label: '总步数', value: m.total_steps, icon: '👣' },
    { label: '人均步数', value: m.avg_steps, icon: '📊' },
    { label: '完赛率', value: m.completion_rate, icon: '🏁', suffix: '%' },
    { label: '答题人数', value: m.quiz_users, icon: '✍️' },
    { label: '勋章发放', value: m.medals_granted, icon: '🎖️' }
  ]
})
const maxSteps = computed(() => Math.max(...state.value.trend.map((p) => p.total_steps), 1))
const maxTarget = computed(() => Math.max(...state.value.route_overview.map((n) => n.target_steps), 1))

function barWidth(steps: number) { return `${Math.max(2, Math.round(steps / maxSteps.value * 100))}%` }

onMounted(load)
</script>

<template>
  <div class="screen-page">
    <header class="screen-header">
      <div class="header-side">
        <span class="ws-dot" :class="wsStatus" />
        <span class="ws-text">{{ wsStatus === 'online' ? '实时已连接' : wsStatus === 'connecting' ? '连接中…' : '已离线' }}</span>
      </div>
      <h1 class="screen-title">⭐ 长征步迹 · 数据大屏</h1>
      <div class="header-side right">
        <el-button size="small" text @click="router.push('/dashboard')">退出大屏</el-button>
      </div>
    </header>

    <div v-loading="loading && !state.metrics.total_users" class="screen-body">
      <section class="metric-strip">
        <div v-for="card in metricCards" :key="card.label" class="metric-cell">
          <div class="metric-icon">{{ card.icon }}</div>
          <div class="metric-value">{{ formatNumber(card.value) }}<span v-if="card.suffix" class="metric-suffix">{{ card.suffix }}</span></div>
          <div class="metric-label">{{ card.label }}</div>
        </div>
      </section>

      <section class="screen-main">
        <div class="screen-col">
          <div class="screen-panel">
            <h3 class="panel-title">🗺️ 长征路线总览</h3>
            <div class="route-list">
              <div v-for="node in state.route_overview" :key="node.node_id" class="route-item">
                <div class="route-head">
                  <span class="route-name">{{ node.name }}</span>
                  <span class="route-lit">{{ formatNumber(node.lit_count) }} 人抵达 · {{ node.completion_rate }}%</span>
                </div>
                <div class="route-bar">
                  <div class="route-bar-target" :style="{ width: `${Math.max(2, Math.round(node.target_steps / maxTarget * 100))}%` }" />
                  <div class="route-bar-fill" :style="{ width: `${node.completion_rate}%` }" />
                </div>
                <div class="route-target">目标 {{ formatNumber(node.target_steps) }} 步</div>
              </div>
              <el-empty v-if="!state.route_overview.length" description="暂无启用节点" :image-size="80" />
            </div>
          </div>

          <div class="screen-panel">
            <h3 class="panel-title">📈 近 7 日运动趋势</h3>
            <div class="trend-bars">
              <div v-for="p in state.trend" :key="p.date" class="trend-item">
                <span class="trend-value">{{ formatNumber(p.total_steps) }}</span>
                <div class="trend-bar-wrap"><div class="trend-bar" :style="{ width: barWidth(p.total_steps) }" /></div>
                <span class="trend-meta">{{ p.date.slice(5) }} · {{ p.active_users }}人 · +{{ p.new_lit }}节点</span>
              </div>
            </div>
          </div>
        </div>

        <div class="screen-panel activity-col">
          <h3 class="panel-title">📡 实时动态</h3>
          <div class="screen-activity">
            <div v-for="item in state.activities" :key="item.id" class="activity-line">
              <span class="activity-time">{{ formatTime(item.event_time) }}</span>
              <span class="activity-text">{{ item.text }}</span>
            </div>
            <el-empty v-if="!state.activities.length" description="暂无动态" :image-size="80" />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.screen-page {
  min-height: 100vh;
  padding: 24px 32px 32px;
  color: #f4e9d2;
  background:
    radial-gradient(1200px 500px at 20% -10%, rgba(200, 16, 46, 0.35), transparent 60%),
    radial-gradient(900px 420px at 85% 0%, rgba(212, 160, 23, 0.22), transparent 60%),
    #160a08;
}
.screen-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.screen-title { margin: 0; font-size: 28px; letter-spacing: 6px; color: #f8e8c9; text-shadow: 0 0 24px rgba(212, 160, 23, 0.5); white-space: nowrap; }
.header-side { width: 220px; display: flex; align-items: center; gap: 8px; }
.header-side.right { justify-content: flex-end; }
.ws-dot { width: 10px; height: 10px; border-radius: 50%; }
.ws-dot.online { background: #22c55e; box-shadow: 0 0 10px #22c55e; }
.ws-dot.connecting { background: #d4a017; box-shadow: 0 0 10px #d4a017; }
.ws-dot.offline { background: #ef4444; box-shadow: 0 0 10px #ef4444; }
.ws-text { font-size: 13px; color: rgba(244, 233, 210, 0.75); }
.metric-strip { display: grid; grid-template-columns: repeat(7, 1fr); gap: 14px; margin-bottom: 20px; }
.metric-cell { padding: 16px 12px; text-align: center; background: rgba(60, 20, 14, 0.75); border: 1px solid rgba(212, 160, 23, 0.35); border-radius: 12px; }
.metric-icon { font-size: 22px; }
.metric-value { margin-top: 6px; font-size: 24px; font-weight: 700; color: #ffd982; }
.metric-suffix { font-size: 14px; margin-left: 2px; }
.metric-label { margin-top: 4px; font-size: 13px; color: rgba(244, 233, 210, 0.7); }
.screen-main { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; }
.screen-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.screen-panel { padding: 18px 20px; background: rgba(40, 14, 10, 0.8); border: 1px solid rgba(212, 160, 23, 0.3); border-radius: 14px; min-width: 0; }
.panel-title { margin: 0 0 14px; font-size: 16px; color: #f2d38b; }
.route-list { display: flex; flex-direction: column; gap: 12px; }
.route-head { display: flex; justify-content: space-between; align-items: baseline; }
.route-name { font-size: 15px; font-weight: 600; }
.route-lit { font-size: 12px; color: rgba(244, 233, 210, 0.65); }
.route-bar { position: relative; height: 10px; margin-top: 6px; background: rgba(244, 233, 210, 0.12); border-radius: 5px; overflow: hidden; }
.route-bar-target { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(212, 160, 23, 0.25); border-radius: 5px; }
.route-bar-fill { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(90deg, #c8102e, #d4a017); border-radius: 5px; transition: width 0.6s ease; }
.route-target { margin-top: 4px; font-size: 11px; color: rgba(244, 233, 210, 0.5); }
.trend-bars { display: flex; flex-direction: column; gap: 10px; }
.trend-item { display: flex; align-items: center; gap: 10px; }
.trend-value { width: 90px; text-align: right; font-size: 13px; color: #ffd982; }
.trend-bar-wrap { flex: 1; height: 14px; background: rgba(244, 233, 210, 0.1); border-radius: 7px; overflow: hidden; }
.trend-bar { height: 100%; background: linear-gradient(90deg, #c8102e, #d4a017); border-radius: 7px; transition: width 0.6s ease; }
.trend-meta { width: 170px; font-size: 12px; color: rgba(244, 233, 210, 0.6); }
.activity-col { max-height: 640px; display: flex; flex-direction: column; }
.screen-activity { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.activity-line { display: flex; gap: 10px; font-size: 13px; line-height: 1.5; }
.activity-time { flex-shrink: 0; color: #d4a017; }
.activity-text { color: rgba(244, 233, 210, 0.9); }
@media (max-width: 1200px) {
  .metric-strip { grid-template-columns: repeat(4, 1fr); }
  .screen-main { grid-template-columns: 1fr; }
  .screen-title { font-size: 20px; letter-spacing: 2px; }
  .header-side { width: auto; }
}
</style>
