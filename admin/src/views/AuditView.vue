<script setup lang="ts">
// 审计日志：分页列表 + 日期/动作/操作人筛选，操作人与目标用户展示昵称
import { onMounted, ref } from 'vue'
import { fetchAuditLogs } from '../api/admin'
import type { AuditLogItem } from '../api/admin'

const loading = ref(false)
const logs = ref<AuditLogItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const date = ref('')
const action = ref('')
const actorType = ref('')

async function loadLogs() {
  loading.value = true
  try {
    const { data } = await fetchAuditLogs({
      page: page.value,
      page_size: pageSize.value,
      action: action.value.trim() || undefined,
      actor_type: actorType.value || undefined,
      date: date.value || undefined
    })
    logs.value = data.items
    total.value = data.total
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  page.value = 1
  loadLogs()
}

function handleReset() {
  date.value = ''
  action.value = ''
  actorType.value = ''
  handleSearch()
}

function handlePageChange(next: number) {
  page.value = next
  loadLogs()
}

function formatTime(value: string): string {
  return value ? value.replace('T', ' ').slice(0, 19) : '—'
}

function actionTagType(name: string): 'success' | 'warning' | 'danger' | 'info' {
  if (name.startsWith('access.')) return 'danger'
  if (name.includes('identity')) return 'warning'
  if (name.includes('admin.login')) return 'success'
  return 'info'
}

onMounted(loadLogs)
</script>

<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-date-picker
        v-model="date"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="按日期筛选"
        style="width: 160px"
        clearable
      />
      <el-input
        v-model="action"
        placeholder="按动作筛选（如 access.roles.grant）"
        clearable
        style="width: 260px"
        @keyup.enter="handleSearch"
      />
      <el-select v-model="actorType" placeholder="操作人类型" clearable style="width: 150px">
        <el-option label="超级管理员" value="super" />
        <el-option label="微信关联管理员" value="user" />
      </el-select>
      <el-button type="primary" :icon="'Search'" @click="handleSearch">查询</el-button>
      <el-button @click="handleReset">重置</el-button>
      <div class="spacer" />
      <span class="total">共 {{ total }} 条</span>
      <el-button :icon="'Refresh'" @click="loadLogs">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="logs" border stripe row-key="id">
      <el-table-column prop="id" label="ID" width="80" align="center" />
      <el-table-column label="时间" width="170">
        <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="操作人" min-width="140">
        <template #default="{ row }">
          <el-tag v-if="row.actor_type === 'super'" size="small" type="warning" effect="plain">超级管理员</el-tag>
          <span v-else>{{ row.actor_name || `用户#${row.actor_user_id ?? '—'}` }}</span>
        </template>
      </el-table-column>
      <el-table-column label="动作" min-width="180">
        <template #default="{ row }">
          <el-tag size="small" :type="actionTagType(row.action)" effect="plain">{{ row.action }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="目标用户" min-width="120">
        <template #default="{ row }">
          <span v-if="row.target_name">{{ row.target_name }}</span>
          <span v-else class="none">—</span>
        </template>
      </el-table-column>
      <el-table-column label="详情" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.detail">{{ row.detail }}</span>
          <span v-else class="none">—</span>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="pageSize"
      :current-page="page"
      @current-change="handlePageChange"
    />
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

.none {
  color: #c0c4cc;
}

.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
