<script setup lang="ts">
// 入驻邀请码：生成/编辑/启停/查看小程序码；状态汇总可用/停用/过期/用满。
// 组织选择器复用 /admin/orgs 树（空=不限组织）；有效期按本地时区输入、提交带 Z 的 ISO。
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  createInvite,
  fetchInvites,
  fetchInviteQr,
  fetchOrgTree,
  updateInvite
} from '../api/admin'
import type { InviteItem, InviteQrResult, InviteStatus, OrgNode } from '../api/admin'
import { formatDateTime } from '../utils/format'

const STATUS_LABEL: Record<InviteStatus, string> = {
  active: '可用',
  disabled: '已停用',
  expired: '已过期',
  exhausted: '已用满'
}
const STATUS_TYPE: Record<InviteStatus, 'success' | 'info' | 'warning' | 'danger'> = {
  active: 'success',
  disabled: 'info',
  expired: 'warning',
  exhausted: 'danger'
}
const ENV_LABELS: Record<string, string> = { release: '正式版', trial: '体验版', develop: '开发版' }

const loading = ref(false)
const items = ref<InviteItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const keyword = ref('')
const orgOptions = ref<{ id: number; name: string }[]>([])

function flattenOrg(nodes: OrgNode[], prefix = ''): { id: number; name: string }[] {
  return nodes.flatMap((n) => {
    const name = prefix ? `${prefix} / ${n.name}` : n.name
    return [{ id: n.id, name }, ...flattenOrg(n.children || [], name)]
  })
}

let requestSeq = 0
async function loadList() {
  const seq = ++requestSeq
  loading.value = true
  try {
    const { data } = await fetchInvites(page.value, pageSize.value, keyword.value.trim())
    if (seq !== requestSeq) return
    items.value = data.items
    total.value = data.total
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function handleSearch() {
  page.value = 1
  loadList()
}

function handlePageChange(next: number) {
  page.value = next
  loadList()
}

// ---------------- 新建/编辑弹窗 ----------------
const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)
const form = reactive({
  name: '',
  remark: '',
  org_id: null as number | null,
  max_uses: null as number | null,
  expires_at: null as Date | null,
  is_enabled: true
})

function resetForm() {
  form.name = ''
  form.remark = ''
  form.org_id = null
  form.max_uses = null
  form.expires_at = null
  form.is_enabled = true
}

function openCreate() {
  editingId.value = null
  resetForm()
  dialogVisible.value = true
}

function openEdit(row: InviteItem) {
  editingId.value = row.id
  form.name = row.name
  form.remark = row.remark || ''
  form.org_id = row.org_id
  form.max_uses = row.max_uses
  // 有效期为 UTC ISO，Date 会自动转本地时区显示
  form.expires_at = row.expires_at ? new Date(row.expires_at) : null
  form.is_enabled = row.is_enabled
  dialogVisible.value = true
}

async function saveInvite() {
  const name = form.name.trim()
  if (!name) {
    ElMessage.warning('请输入邀请码名称')
    return
  }
  saving.value = true
  try {
    const payload = {
      name,
      remark: form.remark.trim() || null,
      org_id: form.org_id,
      max_uses: form.max_uses,
      // 带时区 ISO，便于后端 _InviteExpiry 校验并统一存 UTC naive
      expires_at: form.expires_at ? form.expires_at.toISOString() : null
    }
    if (editingId.value === null) {
      await createInvite(payload)
      ElMessage.success('已生成邀请码')
    } else {
      await updateInvite(editingId.value, { ...payload, is_enabled: form.is_enabled })
      ElMessage.success('已保存')
    }
    dialogVisible.value = false
    await loadList()
  } finally {
    saving.value = false
  }
}

const togglingId = ref<number | null>(null)
async function toggleEnabled(row: InviteItem, enabled: unknown) {
  if (togglingId.value !== null) return
  const next = !!enabled
  togglingId.value = row.id
  try {
    const { data } = await updateInvite(row.id, { is_enabled: next })
    Object.assign(row, data)
    ElMessage.success(next ? '已启用' : '已停用')
  } finally {
    togglingId.value = null
  }
}

// ---------------- 小程序码 ----------------
const qrVisible = ref(false)
const qrLoading = ref(false)
const qr = ref<InviteQrResult | null>(null)
const qrInvite = ref<InviteItem | null>(null)

async function openQr(row: InviteItem) {
  qrInvite.value = row
  qr.value = null
  qrVisible.value = true
  qrLoading.value = true
  try {
    const { data } = await fetchInviteQr(row.id)
    qr.value = data
  } finally {
    qrLoading.value = false
  }
}

function downloadQr() {
  const image = qr.value?.image
  if (!image || !qrInvite.value) return
  const link = document.createElement('a')
  link.href = image
  link.download = `邀请码_${qrInvite.value.name}_${qrInvite.value.code}.png`
  link.click()
}

const dialogTitle = computed(() =>
  editingId.value === null ? '生成入驻邀请码' : `编辑邀请码 #${editingId.value}`
)

onMounted(async () => {
  loadList()
  try {
    const { data } = await fetchOrgTree(true)
    orgOptions.value = flattenOrg(data.nodes)
  } catch {
    orgOptions.value = []
  }
})
</script>

<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="按名称搜索"
        clearable
        style="width: 220px"
        @keyup.enter="handleSearch"
        @clear="handleSearch"
      />
      <el-button type="primary" :icon="'Search'" @click="handleSearch">查询</el-button>
      <div class="spacer" />
      <span class="total">共 {{ total }} 个</span>
      <el-button type="primary" :icon="'Plus'" @click="openCreate">生成邀请码</el-button>
      <el-button :icon="'Refresh'" @click="loadList">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="items" border stripe row-key="id">
      <el-table-column prop="name" label="名称" min-width="160" show-overflow-tooltip />
      <el-table-column label="邀请码" width="190">
        <template #default="{ row }">
          <span class="code-mono">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column label="组织范围" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.org_name">{{ row.org_name }}</span>
          <el-tag v-else size="small" type="info" effect="plain">不限</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="使用次数" width="110" align="center">
        <template #default="{ row }">
          {{ row.used_count }} / <span class="muted">{{ row.max_uses == null ? '∞' : row.max_uses }}</span>
        </template>
      </el-table-column>
      <el-table-column label="有效期" width="170" align="center">
        <template #default="{ row }">
          <span v-if="row.expires_at">{{ formatDateTime(row.expires_at) }}</span>
          <el-tag v-else size="small" type="info" effect="plain">长期有效</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag :type="STATUS_TYPE[row.status as InviteStatus]" size="small" effect="plain">
            {{ STATUS_LABEL[row.status as InviteStatus] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="启停" width="90" align="center">
        <template #default="{ row }">
          <el-switch
            :model-value="row.is_enabled"
            :loading="togglingId === row.id"
            :disabled="togglingId !== null && togglingId !== row.id"
            @change="toggleEnabled(row, $event)"
          />
        </template>
      </el-table-column>
      <el-table-column label="创建" width="150" align="center">
        <template #default="{ row }">
          <div>{{ row.created_by || '—' }}</div>
          <div class="muted">{{ formatDateTime(row.created_at) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180" align="center" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openQr(row)">小程序码</el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
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

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="520px" destroy-on-close>
      <el-form label-width="110px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" maxlength="64" placeholder="如：10 月华东新员工" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" maxlength="200" type="textarea" :rows="2" placeholder="选填，仅管理员可见" />
        </el-form-item>
        <el-form-item label="组织范围">
          <el-select
            v-model="form.org_id"
            placeholder="不限（可任选组织入驻）"
            clearable
            filterable
            style="width: 100%"
          >
            <el-option v-for="o in orgOptions" :key="o.id" :label="o.name" :value="o.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="使用次数上限">
          <el-input-number v-model="form.max_uses" :min="1" :precision="0" controls-position="right" placeholder="不限" style="width: 180px" />
          <span class="hint">留空表示不限次数；编辑时不得低于已使用次数</span>
        </el-form-item>
        <el-form-item label="有效期至">
          <el-date-picker
            v-model="form.expires_at"
            type="datetime"
            placeholder="留空表示长期有效"
            style="width: 220px"
          />
          <span class="hint">按本地时区设置，提交转为 UTC 存储</span>
        </el-form-item>
        <el-form-item v-if="editingId !== null" label="启用">
          <el-switch v-model="form.is_enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveInvite">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="qrVisible" :title="`邀请码 · ${qrInvite?.name || ''}`" width="420px" align-center>
      <div v-loading="qrLoading" class="qr-box">
        <template v-if="qr">
          <img v-if="qr.image" :src="qr.image" alt="邀请码小程序码" class="qr-img" />
          <el-alert v-else type="warning" :closable="false" show-icon title="未配置微信凭证或生成失败，暂无法出码"
            description="请在后端 .env 配置 WX_APPID / WX_SECRET 后重试" />
          <p class="qr-tip">员工扫码进入入驻页填写姓名与组织即可完成注册；码内仅含该邀请码标识，不含任何个人信息。</p>
          <p class="qr-meta">邀请码：<span class="code-mono">{{ qrInvite?.code }}</span></p>
          <p class="qr-meta">小程序版本：{{ ENV_LABELS[qr.env_version] || qr.env_version }}</p>
        </template>
      </div>
      <template #footer>
        <el-button @click="qrVisible = false">关闭</el-button>
        <el-button type="primary" :disabled="!qr?.image" @click="downloadQr">下载图片</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.spacer { flex: 1; }
.total { color: #909399; font-size: 13px; }
.muted { color: #909399; font-size: 12px; }
.code-mono { font-family: Consolas, Menlo, monospace; letter-spacing: 1px; }
.hint { margin-left: 10px; color: #909399; font-size: 12px; }
.pager { margin-top: 14px; justify-content: flex-end; }
.qr-box { min-height: 160px; text-align: center; }
.qr-img { width: 260px; height: 260px; }
.qr-tip { margin: 12px 0 4px; color: #606266; font-size: 13px; line-height: 1.6; }
.qr-meta { margin: 0; color: #909399; font-size: 12px; }
</style>
