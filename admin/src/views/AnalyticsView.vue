<script setup lang="ts">
// 数据运营分析：组织对比（表格+柱状图）、邀请码转化漏斗、同步失败清单、积分健康卡
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as echarts from 'echarts/core'
import { BarChart, FunnelChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import {
  fetchAnalyticsOrgs,
  fetchInviteFunnel,
  fetchSyncFailures,
  verifyPoints
} from '../api/admin'
import type {
  OrgCompareItem,
  InviteFunnelItem,
  SyncFailureItem,
  PointsHealthResult
} from '../api/admin'
import { formatNumber } from '../utils/format'

echarts.use([BarChart, FunnelChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, CanvasRenderer])

// ---------------- 组织对比 ----------------
const orgLoading = ref(false)
const orgs = ref<OrgCompareItem[]>([])
const orgChartEl = ref<HTMLElement | null>(null)
const orgChart = shallowRef<echarts.EChartsType | null>(null)

async function loadOrgs() {
  orgLoading.value = true
  try {
    const { data } = await fetchAnalyticsOrgs()
    orgs.value = data.items
    renderOrgChart()
  } catch {
    ElMessage.error('组织对比加载失败，请重试')
    orgs.value = []
    renderOrgChart()
  } finally {
    orgLoading.value = false
  }
}

function renderOrgChart() {
  if (!orgChartEl.value) return
  if (!orgChart.value) orgChart.value = echarts.init(orgChartEl.value)
  if (!orgs.value.length) {
    orgChart.value.clear()
    orgChart.value.setOption({
      title: { text: '暂无数据', left: 'center', top: 'center', textStyle: { color: '#909399', fontSize: 14, fontWeight: 'normal' } },
      xAxis: { type: 'value', show: false },
      yAxis: { type: 'category', show: false },
      series: []
    })
    return
  }
  const items = orgs.value.slice(0, 15)
  orgChart.value.setOption({
    grid: { left: 100, right: 30, top: 40, bottom: 30 },
    tooltip: { trigger: 'axis' },
    legend: { data: ['总步数', '人均积分'], top: 4 },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: '#eef1f6' } } },
    yAxis: {
      type: 'category',
      data: items.map((o) => o.org_name),
      axisLabel: { width: 90, overflow: 'truncate' }
    },
    series: [
      {
        name: '总步数',
        type: 'bar',
        data: items.map((o) => o.total_steps),
        itemStyle: { color: '#C8102E', borderRadius: [0, 4, 4, 0] },
        barMaxWidth: 18
      },
      {
        name: '人均积分',
        type: 'bar',
        data: items.map((o) => o.avg_points),
        itemStyle: { color: '#D4A017', borderRadius: [0, 4, 4, 0] },
        barMaxWidth: 18
      }
    ]
  })
}

// ---------------- 邀请码转化漏斗 ----------------
const funnelLoading = ref(false)
const funnelData = ref<InviteFunnelItem[]>([])
const funnelChartEl = ref<HTMLElement | null>(null)
const funnelChart = shallowRef<echarts.EChartsType | null>(null)

async function loadFunnel() {
  funnelLoading.value = true
  try {
    const { data } = await fetchInviteFunnel()
    funnelData.value = data.items
    renderFunnelChart()
  } catch {
    ElMessage.error('漏斗数据加载失败，请重试')
    funnelData.value = []
    renderFunnelChart()
  } finally {
    funnelLoading.value = false
  }
}

function renderFunnelChart() {
  if (!funnelChartEl.value) return
  if (!funnelChart.value) funnelChart.value = echarts.init(funnelChartEl.value)
  // 汇总所有邀请码数据
  const sum = funnelData.value.reduce(
    (acc, item) => ({
      scan: acc.scan + item.scans,
      register: acc.register + item.onboarded,
      first_login: acc.first_login + item.first_logins,
      first_sync: acc.first_sync + item.synced
    }),
    { scan: 0, register: 0, first_login: 0, first_sync: 0 }
  )
  funnelChart.value.setOption({
    tooltip: { trigger: 'item', formatter: '{b}: {c}' },
    series: [
      {
        type: 'funnel',
        left: '10%',
        top: 20,
        bottom: 20,
        width: '80%',
        sort: 'descending',
        gap: 4,
        label: { show: true, position: 'inside', formatter: '{b}\n{c}' },
        itemStyle: { borderWidth: 0 },
        data: [
          { value: sum.scan, name: '扫码', itemStyle: { color: '#3B82F6' } },
          { value: sum.register, name: '入驻', itemStyle: { color: '#10B981' } },
          { value: sum.first_login, name: '首登', itemStyle: { color: '#D4A017' } },
          { value: sum.first_sync, name: '首次同步', itemStyle: { color: '#C8102E' } }
        ]
      }
    ]
  })
}

// ---------------- 同步失败清单 ----------------
const syncLoading = ref(false)
const syncFailures = ref<SyncFailureItem[]>([])
const syncTotal = ref(0)
const syncDays = ref(7)

async function loadSyncFailures() {
  syncLoading.value = true
  try {
    const { data } = await fetchSyncFailures(syncDays.value)
    syncFailures.value = data.items
    syncTotal.value = data.total
  } catch {
    ElMessage.error('同步失败清单加载失败，请重试')
    syncFailures.value = []
    syncTotal.value = 0
  } finally {
    syncLoading.value = false
  }
}

function handleDaysChange(days: number) {
  syncDays.value = days
  loadSyncFailures()
}

// ---------------- 积分健康 ----------------
const healthLoading = ref(false)
const health = ref<PointsHealthResult | null>(null)
const verifying = ref(false)
const fixing = ref(false)

async function handleVerify() {
  verifying.value = true
  try {
    const { data } = await verifyPoints(false)
    health.value = { mismatches: data.mismatches, users: data.users, checked_days: data.checked_days }
    ElMessage.success(`核对完成：${data.mismatches} 处差异`)
  } finally {
    verifying.value = false
  }
}

async function handleFix() {
  await ElMessageBox.confirm(
    '该操作会按当前运营参数追溯重算所有用户的历史积分，涉及全部参与用户，执行时间可能较长。确定继续吗？',
    '修复积分差异',
    { type: 'warning', confirmButtonText: '确定修复', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
  )
  fixing.value = true
  try {
    const { data } = await verifyPoints(true)
    health.value = { mismatches: 0, users: data.users, checked_days: data.checked_days }
    ElMessage.success(`修复完成：${data.fixed} 条已修正`)
  } catch {
    ElMessage.error('修复失败，请稍后重试')
  } finally {
    fixing.value = false
  }
}

// ---------------- resize ----------------
function resizeCharts() {
  orgChart.value?.resize()
  funnelChart.value?.resize()
}

onMounted(() => {
  loadOrgs()
  loadFunnel()
  loadSyncFailures()
  window.addEventListener('resize', resizeCharts)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeCharts)
  orgChart.value?.dispose()
  funnelChart.value?.dispose()
})
</script>

<template>
  <div class="analytics">
    <!-- 积分健康卡 -->
    <div v-loading="healthLoading" class="health-card" :class="{ alert: (health?.mismatches ?? 0) > 0 }">
      <div class="health-info">
        <span class="health-title">积分健康</span>
        <span v-if="health" class="health-detail">
          检查 {{ formatNumber(health.users) }} 用户 / {{ health.checked_days }} 天，
          <strong :class="{ danger: health.mismatches > 0 }">{{ health.mismatches }} 处差异</strong>
        </span>
        <span v-else class="health-detail">点击「手动核对」检测积分一致性</span>
      </div>
      <div class="health-actions">
        <el-button size="small" :loading="verifying" @click="handleVerify">手动核对</el-button>
        <el-button
          size="small"
          type="danger"
          plain
          :loading="fixing"
          :disabled="(health?.mismatches ?? 0) === 0"
          @click="handleFix"
        >
          修复差异
        </el-button>
      </div>
    </div>

    <!-- 组织对比 -->
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title">组织对比</span>
      </div>
      <div v-loading="orgLoading">
        <div ref="orgChartEl" class="chart-box"></div>
        <el-table :data="orgs" border stripe size="small" max-height="320">
          <el-table-column prop="org_name" label="组织" min-width="140" show-overflow-tooltip />
          <el-table-column prop="member_count" label="成员数" width="90" align="right" />
          <el-table-column prop="active_users" label="活跃人数" width="90" align="right" />
          <el-table-column label="总步数" width="120" align="right">
            <template #default="{ row }">{{ formatNumber(row.total_steps) }}</template>
          </el-table-column>
          <el-table-column prop="avg_steps" label="人均步数" width="100" align="right" />
          <el-table-column prop="avg_points" label="人均积分" width="100" align="right" />
          <el-table-column prop="lit_nodes" label="点亮节点" width="100" align="right" />
        </el-table>
      </div>
    </div>

    <!-- 邀请码转化漏斗 -->
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title">邀请码转化漏斗</span>
        <span class="panel-sub">扫码 → 入驻 → 首登 → 首次同步</span>
      </div>
      <div v-loading="funnelLoading" class="funnel-row">
        <div ref="funnelChartEl" class="chart-box funnel-chart"></div>
        <el-table v-if="funnelData.length > 0" :data="funnelData" border stripe size="small" max-height="280" class="funnel-table">
          <el-table-column prop="invite_name" label="邀请码" min-width="120" show-overflow-tooltip />
          <el-table-column prop="scans" label="扫码" width="80" align="right" />
          <el-table-column prop="onboarded" label="入驻" width="80" align="right" />
          <el-table-column prop="first_logins" label="首登" width="80" align="right" />
          <el-table-column prop="synced" label="首次同步" width="90" align="right" />
        </el-table>
      </div>
    </div>

    <!-- 同步失败清单 -->
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title">同步失败清单</span>
        <el-radio-group :model-value="syncDays" size="small" @change="(v: number) => handleDaysChange(v)">
          <el-radio-button :value="3">近 3 天</el-radio-button>
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
        </el-radio-group>
      </div>
      <el-table v-loading="syncLoading" :data="syncFailures" border stripe size="small" max-height="320">
        <el-table-column prop="nickname" label="用户" width="120" show-overflow-tooltip />
        <el-table-column prop="org_name" label="组织" width="140" show-overflow-tooltip />
        <el-table-column prop="date" label="日期" width="110" />
        <el-table-column prop="fail_reason" label="失败原因" min-width="200" show-overflow-tooltip />
      </el-table>
      <div v-if="!syncLoading && !syncFailures.length" class="empty-tip">暂无同步失败记录</div>
      <div v-if="syncTotal > syncFailures.length" class="more-tip">
        共 {{ syncTotal }} 条失败记录，仅展示前 {{ syncFailures.length }} 条
      </div>
    </div>
  </div>
</template>

<style scoped>
.analytics {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.health-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  background: #f0fdf4;
  border-radius: 12px;
  border: 1px solid #bbf7d0;
  transition: all 0.3s;
}

.health-card.alert {
  background: #fef2f2;
  border-color: #fecaca;
}

.health-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  margin-right: 14px;
}

.health-detail {
  font-size: 13px;
  color: #606266;
}

.health-detail .danger {
  color: #dc2626;
}

.health-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
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

.chart-box {
  height: 300px;
  margin-bottom: 14px;
}

.funnel-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: start;
}

.funnel-chart {
  height: 280px;
  margin-bottom: 0;
}

@media (max-width: 1100px) {
  .funnel-row {
    grid-template-columns: 1fr;
  }
}

.empty-tip {
  color: #909399;
  text-align: center;
  padding: 30px 0;
  font-size: 13px;
}

.more-tip {
  color: #909399;
  text-align: center;
  padding: 8px 0 0;
  font-size: 12px;
}
</style>
