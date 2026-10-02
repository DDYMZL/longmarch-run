<script setup lang="ts">
// 驾驶舱：核心指标 + 运动趋势（7/30 天）+ 路线总览 + 实时动态
// 组织维度统计已按需求取消（2026-10-01 决策），本页只做整体指标
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
// echarts 按需引入：仅注册柱状图/折线图与所需组件，替代全量 import（约省 1MB 打包体积）
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import {
  fetchActivities,
  fetchDashboard,
  fetchDashboardTrend,
  type ActivityItem,
  type DashboardResult,
  type TrendResult
} from '../api/admin'
import { formatNumber, formatTime, useLiveUpdates } from '../utils/liveUpdates'

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

const loading = ref(false)
const trendLoading = ref(false)
const days = ref<7 | 30>(7)
const dashboard = ref<DashboardResult>({ metrics: { total_users: 0, today_users: 0, total_steps: 0, avg_steps: 0, completion_rate: 0, quiz_users: 0, medals_granted: 0 }, route_overview: [] })
const trend = ref<TrendResult>({ days: 7, points: [] })
const activities = ref<ActivityItem[]>([])

const metricCards = computed(() => [
  { key: 'total_users', label: '参与总人数', value: dashboard.value.metrics.total_users, icon: '👥' },
  { key: 'today_users', label: '今日运动人数', value: dashboard.value.metrics.today_users, icon: '🏃' },
  { key: 'total_steps', label: '累计总步数', value: dashboard.value.metrics.total_steps, icon: '👟' },
  { key: 'avg_steps', label: '人均步数', value: dashboard.value.metrics.avg_steps, icon: '📊' },
  { key: 'completion_rate', label: '路线完成率', value: dashboard.value.metrics.completion_rate, suffix: '%', icon: '🏁' },
  { key: 'quiz_users', label: '今日答题人数', value: dashboard.value.metrics.quiz_users, icon: '📝' },
  { key: 'medals_granted', label: '勋章发放数', value: dashboard.value.metrics.medals_granted, icon: '🏅' }
])

const maxTarget = computed(() => Math.max(1, ...dashboard.value.route_overview.map((n) => n.target_steps)))

async function loadDashboard() {
  dashboard.value = (await fetchDashboard()).data
}

async function loadTrend() {
  trendLoading.value = true
  try {
    trend.value = (await fetchDashboardTrend(days.value)).data
    renderChart()
  } finally {
    trendLoading.value = false
  }
}

async function loadActivities() {
  activities.value = (await fetchActivities(20)).data.items
}

async function load() {
  loading.value = true
  try {
    await Promise.all([loadDashboard(), loadTrend(), loadActivities()])
  } finally {
    loading.value = false
  }
}

// ---------------- 趋势图（echarts） ----------------
const chartEl = ref<HTMLElement | null>(null)
const chart = shallowRef<echarts.EChartsType | null>(null)

function renderChart() {
  if (!chartEl.value) return
  if (!chart.value) chart.value = echarts.init(chartEl.value)
  const points = trend.value.points
  chart.value.setOption({
    grid: { left: 50, right: 24, top: 42, bottom: 30 },
    tooltip: { trigger: 'axis' },
    legend: { data: ['总步数', '运动人数', '新点亮', '新增用户'], top: 4 },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.date.slice(5)),
      axisLine: { lineStyle: { color: '#c9d2e0' } }
    },
    yAxis: [
      { type: 'value', name: '步数', splitLine: { lineStyle: { color: '#eef1f6' } } },
      { type: 'value', name: '人数/节点', splitLine: { show: false } }
    ],
    series: [
      {
        name: '总步数',
        type: 'bar',
        data: points.map((p) => p.total_steps),
        itemStyle: { color: '#C8102E', borderRadius: [4, 4, 0, 0] },
        barMaxWidth: 22
      },
      {
        name: '运动人数',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        data: points.map((p) => p.active_users),
        itemStyle: { color: '#D4A017' },
        lineStyle: { width: 2.5 }
      },
      {
        name: '新点亮',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        data: points.map((p) => p.new_lit),
        itemStyle: { color: '#3B82F6' },
        lineStyle: { width: 2 }
      },
      {
        name: '新增用户',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        data: points.map((p) => p.new_users),
        itemStyle: { color: '#10B981' },
        lineStyle: { width: 2, type: 'dashed' }
      }
    ]
  })
}

function resizeChart() {
  chart.value?.resize()
}

// ---------------- 实时推送 ----------------
let reloadTimer: number | null = null

function scheduleReload() {
  if (reloadTimer !== null) return
  reloadTimer = window.setTimeout(() => {
    reloadTimer = null
    loadDashboard()
    loadTrend()
  }, 800)
}

const { wsStatus } = useLiveUpdates((data) => {
  if (data.type === 'data_changed') scheduleReload()
  if (data.type === 'activity' && data.text) {
    // 实时动态：新事件直接插入顶部，无需整表刷新
    activities.value = [
      {
        id: Date.now(),
        event_type: data.eventType || '',
        event_time: data.at || '',
        user_id: data.userId || 0,
        nickname: data.nickname || '',
        text: data.text,
        data: {}
      },
      ...activities.value
    ].slice(0, 20)
  }
})

function switchDays(value: 7 | 30) {
  if (days.value === value) return
  days.value = value
  loadTrend()
}

const wsText = computed(() => (wsStatus.value === 'online' ? '实时连接正常' : wsStatus.value === 'connecting' ? '实时连接中…' : '实时连接断开，自动重连'))

onMounted(() => {
  load()
  window.addEventListener('resize', resizeChart)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeChart)
  if (reloadTimer !== null) window.clearTimeout(reloadTimer)
  chart.value?.dispose()
})
</script>

<template>
  <div v-loading="loading" class="dashboard">
    <!-- 指标卡 -->
    <div class="metric-grid">
      <div v-for="card in metricCards" :key="card.key" class="metric-card">
        <div class="metric-icon">{{ card.icon }}</div>
        <div class="metric-body">
          <div class="metric-value">{{ formatNumber(card.value) }}{{ card.suffix || '' }}</div>
          <div class="metric-label">{{ card.label }}</div>
        </div>
      </div>
    </div>

    <div class="panel-row">
      <!-- 趋势图 -->
      <div class="panel trend-panel">
        <div class="panel-head">
          <span class="panel-title">运动趋势</span>
          <el-radio-group :model-value="days" size="small" @change="(v: number) => switchDays(v as 7 | 30)">
            <el-radio-button :value="7">近 7 天</el-radio-button>
            <el-radio-button :value="30">近 30 天</el-radio-button>
          </el-radio-group>
        </div>
        <div v-loading="trendLoading" ref="chartEl" class="trend-chart"></div>
      </div>

      <!-- 实时动态 -->
      <div class="panel activity-panel">
        <div class="panel-head">
          <span class="panel-title">实时动态</span>
          <span class="ws-badge" :class="wsStatus">{{ wsText }}</span>
        </div>
        <div v-if="!activities.length" class="empty-tip">暂无动态</div>
        <div v-else class="activity-list">
          <div v-for="item in activities" :key="item.id" class="activity-item">
            <div class="activity-text">{{ item.text }}</div>
            <div class="activity-time">{{ formatTime(item.event_time) }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 路线总览 -->
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title">长征路线总览</span>
        <span class="panel-sub">各节点达成人数（含未解锁的后续节点）</span>
      </div>
      <el-table :data="dashboard.route_overview" size="large">
        <el-table-column prop="name" label="节点" min-width="140">
          <template #default="{ row }">
            <span class="node-name">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="target_steps" label="目标步数" width="120" align="right">
          <template #default="{ row }">{{ formatNumber(row.target_steps) }}</template>
        </el-table-column>
        <el-table-column label="步数进度" min-width="220">
          <template #default="{ row }">
            <el-progress :percentage="Math.round((row.target_steps / maxTarget) * 100)" :stroke-width="10" color="#C8102E" :show-text="false" />
          </template>
        </el-table-column>
        <el-table-column prop="lit_count" label="达成人数" width="100" align="right" />
        <el-table-column label="达成率" width="160">
          <template #default="{ row }">
            <el-progress :percentage="row.completion_rate" :stroke-width="14" color="#D4A017" />
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
}

.metric-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 4px 16px rgb(140 30 30 / 6%);
}

.metric-icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  font-size: 24px;
  border-radius: 12px;
  background: linear-gradient(135deg, rgb(200 16 46 / 10%), rgb(212 160 23 / 14%));
}

.metric-value {
  font-size: 24px;
  font-weight: 700;
  color: #303133;
  line-height: 1.2;
}

.metric-label {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.panel-row {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 18px;
}

@media (max-width: 1100px) {
  .panel-row {
    grid-template-columns: 1fr;
  }
}

.panel {
  background: #fff;
  border-radius: 14px;
  padding: 18px 20px;
  box-shadow: 0 4px 16px rgb(140 30 30 / 6%);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.panel-title {
  font-size: 15px;
  font-weight: 600;
  color: #5a1a1a;
}

.panel-sub {
  font-size: 12px;
  color: #909399;
}

.trend-chart {
  height: 320px;
}

.activity-panel {
  display: flex;
  flex-direction: column;
}

.ws-badge {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 10px;
  color: #909399;
  background: #f4f6fa;
}

.ws-badge.online {
  color: #0e8a5f;
  background: rgb(16 185 129 / 12%);
}

.activity-list {
  flex: 1;
  overflow-y: auto;
  max-height: 320px;
}

.activity-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px dashed #f0e6d2;
  font-size: 13px;
}

.activity-item:last-child {
  border-bottom: none;
}

.activity-text {
  color: #303133;
  flex: 1;
  line-height: 1.5;
}

.activity-time {
  color: #b3bcc9;
  font-size: 12px;
  flex-shrink: 0;
}

.empty-tip {
  color: #909399;
  text-align: center;
  padding: 40px 0;
  font-size: 13px;
}

.node-name {
  font-weight: 600;
  color: #5a1a1a;
}
</style>
