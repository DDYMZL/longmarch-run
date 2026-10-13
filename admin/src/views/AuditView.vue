<script setup lang="ts">
// 审计日志：分页列表 + 日期/动作/操作人筛选，操作人与目标用户展示昵称
import { onMounted, ref } from 'vue'
import { fetchAuditLogs } from '../api/admin'
import type { AuditLogItem } from '../api/admin'
import { formatDateTime } from '../utils/format'

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

const ACTION_TEXT: Record<string, string> = {
  'admin.login.qr': '扫码登录后台',
  'identity.bind.confirm': '绑定管理员身份',
  'identity.unbind': '解绑管理员身份',
  'access.roles.grant': '授予角色',
  'access.roles.revoke': '回收角色',
  'access.role.create': '新建角色',
  'access.role.update': '编辑角色',
  'access.role.delete': '删除角色',
  'access.role.enable': '启用角色',
  'access.role.disable': '禁用角色',
  'activity.update': '保存活动设置',
  'activity.publish': '发布活动',
  'activity.unpublish': '撤回活动',
  'points.recompute': '积分核对修复',
  'user.org_change': '调整所属组织',
  'user.onboard': '邀请码入驻',
  'user.enable': '启用账号',
  'user.disable': '停用账号',
  'invite.create': '新建邀请码',
  'invite.update': '修改邀请码'
}

function actionTagType(name: string): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  if (name.startsWith('access.') || name === 'user.disable') return 'danger'
  if (name.startsWith('activity.') || name.startsWith('points.')) return 'primary'
  if (name.includes('identity') || name === 'user.org_change') return 'warning'
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
      <el-select
        v-model="action"
        placeholder="按动作筛选"
        clearable
        filterable
        allow-create
        default-first-option
        style="width: 220px"
      >
        <el-option v-for="(text, code) in ACTION_TEXT" :key="code" :label="text" :value="code" />
      </el-select>
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
        <template #default="{ row }">{{ formatDateTime(row.created_at, '—', true) }}</template>
      </el-table-column>
      <el-table-column label="操作人" min-width="140">
        <template #default="{ row }">
          <el-tag v-if="row.actor_type === 'super'" size="small" type="warning" effect="plain">超级管理员</el-tag>
          <span v-else>{{ row.actor_name || `用户#${row.actor_user_id ?? '—'}` }}</span>
        </template>
      </el-table-column>
      <el-table-column label="动作" min-width="180">
        <template #default="{ row }">
          <el-tag size="small" :type="actionTagType(row.action)" effect="plain">{{ ACTION_TEXT[row.action] || row.action }}</el-tag>
          <span v-if="ACTION_TEXT[row.action]" class="action-code">{{ row.action }}</span>
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

.action-code {
  margin-left: 6px;
  color: #a0a7b3;
  font-size: 11px;
}

.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
