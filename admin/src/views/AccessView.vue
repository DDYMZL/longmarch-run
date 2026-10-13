<script setup lang="ts">
// 人员授权：人员列表筛选（支持停用筛选 + 启停切换）、角色全量覆盖授权、单角色启用/禁用（禁用即时生效）、
// 调整所属组织（小程序首次入驻后锁定，仅管理员可改并留审计）；
// 角色管理：角色 CRUD + 菜单勾选（内置角色禁删、被引用角色删除时后端拒绝）
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createRole,
  deleteRole,
  fetchAdminUsers,
  fetchOrgTree,
  fetchRoles,
  grantUserRoles,
  setUserOrg,
  setUserRoleEnabled,
  setUserStatus,
  updateRole
} from '../api/admin'
import type { AdminUserItem, OrgNode, RoleItem, UserStatus } from '../api/admin'
import { formatDateTime } from '../utils/format'
import { MENUS } from '../router/menus'

const MENU_NAME: Record<string, string> = Object.fromEntries(MENUS.map((m) => [m.code, m.title]))

const activeTab = ref('users')

// ---------------- 人员授权 ----------------
const loading = ref(false)
const users = ref<AdminUserItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const keyword = ref('')
const orgId = ref<number | null>(null)
const hasAccess = ref<boolean | null>(null)
const statusFilter = ref<UserStatus | ''>('')
const orgOptions = ref<{ id: number; name: string }[]>([])
const roles = ref<RoleItem[]>([])

// 下拉展示完整路径（如「总部 / 一部 / 一班」），同名下级组织可区分
function flattenOrg(nodes: OrgNode[], prefix = ''): { id: number; name: string }[] {
  return nodes.flatMap((n) => {
    const name = prefix ? `${prefix} / ${n.name}` : n.name
    return [{ id: n.id, name }, ...flattenOrg(n.children || [], name)]
  })
}

// 只采纳最后一次请求，避免快速翻页/筛选时旧响应覆盖新结果
let requestSeq = 0
async function loadUsers() {
  const seq = ++requestSeq
  loading.value = true
  try {
    const { data } = await fetchAdminUsers({
      page: page.value,
      page_size: pageSize.value,
      keyword: keyword.value.trim() || undefined,
      org_id: orgId.value ?? undefined,
      has_access: hasAccess.value ?? undefined,
      status: statusFilter.value || undefined
    })
    if (seq !== requestSeq) return
    users.value = data.items
    total.value = data.total
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function handleSearch() {
  page.value = 1
  loadUsers()
}

function handlePageChange(next: number) {
  page.value = next
  loadUsers()
}

// ---- 设置角色弹窗（全量覆盖授权 + 单角色启用/禁用） ----
const grantDialog = ref(false)
const grantUser = ref<AdminUserItem | null>(null)
const checkedRoleIds = ref<number[]>([])
const savingGrant = ref(false)

function openGrant(row: AdminUserItem) {
  grantUser.value = row
  // 勾选态表示「已授权」（含被禁用的角色）；仅禁用不改变授权关系，保存时不得丢失
  checkedRoleIds.value = row.roles.map((r) => r.id)
  grantDialog.value = true
}

async function saveGrant() {
  if (!grantUser.value) return
  savingGrant.value = true
  try {
    await grantUserRoles(grantUser.value.id, checkedRoleIds.value)
    ElMessage.success('已更新授权')
    grantDialog.value = false
    await loadUsers()
  } finally {
    savingGrant.value = false
  }
}

const togglingRoleId = ref<number | null>(null)

const togglingStatusId = ref<number | null>(null)

async function toggleUserStatus(row: AdminUserItem, enabled: unknown) {
  if (togglingStatusId.value !== null) return
  const next: UserStatus = enabled ? 'active' : 'disabled'
  if (next === 'disabled') {
    try {
      await ElMessageBox.confirm(
        `确定停用「${row.nickname}」吗？停用后小程序立即无法使用，受保护接口返回 403。`,
        '停用确认',
        { type: 'warning', confirmButtonText: '停用', confirmButtonClass: 'el-button--danger' }
      )
    } catch {
      return
    }
  }
  togglingStatusId.value = row.id
  try {
    await setUserStatus(row.id, next)
    ElMessage.success(next === 'active' ? '已启用' : '已停用（即时生效）')
    row.status = next
  } finally {
    togglingStatusId.value = null
  }
}

async function toggleRoleEnabled(role: { id: number; name: string }, enabled: unknown) {
  const user = grantUser.value
  if (!user || togglingRoleId.value !== null) return
  const on = !!enabled
  togglingRoleId.value = role.id
  try {
    await setUserRoleEnabled(user.id, role.id, on)
  } finally {
    togglingRoleId.value = null
  }
  ElMessage.success(on ? `已启用「${role.name}」` : `已禁用「${role.name}」（即时生效）`)
  // 弹窗内本地同步开关状态，不重置尚未保存的勾选；列表重拉以刷新「后台权限」列
  if (grantUser.value?.id === user.id) {
    grantUser.value = {
      ...user,
      roles: user.roles.map((r) => (r.id === role.id ? { ...r, enabled: on } : r))
    }
  }
  loadUsers()
}

function onGrantCheck(role: RoleItem, checked: unknown) {
  if (checked) {
    if (!checkedRoleIds.value.includes(role.id)) {
      checkedRoleIds.value.push(role.id)
    }
  } else {
    checkedRoleIds.value = checkedRoleIds.value.filter((id) => id !== role.id)
  }
}

// ---- 调整所属组织 ----
const orgDialog = ref(false)
const orgUser = ref<AdminUserItem | null>(null)
const targetOrgId = ref<number | null>(null)
const savingOrg = ref(false)

function openOrgChange(row: AdminUserItem) {
  orgUser.value = row
  targetOrgId.value = row.org_id
  orgDialog.value = true
}

async function saveOrgChange() {
  const user = orgUser.value
  if (!user || targetOrgId.value === null || savingOrg.value) return
  if (targetOrgId.value === user.org_id) {
    orgDialog.value = false
    return
  }
  savingOrg.value = true
  try {
    await setUserOrg(user.id, targetOrgId.value)
    ElMessage.success('已调整所属组织')
    orgDialog.value = false
    await loadUsers()
  } finally {
    savingOrg.value = false
  }
}

// ---------------- 角色管理 ----------------
const roleDialog = ref(false)
const editingRoleId = ref<number | null>(null)
const savingRole = ref(false)
const roleForm = reactive({ name: '', menus: [] as string[] })

async function loadRoles() {
  const { data } = await fetchRoles()
  roles.value = data.items
}

function openCreateRole() {
  editingRoleId.value = null
  roleForm.name = ''
  roleForm.menus = []
  roleDialog.value = true
}

function openEditRole(row: RoleItem) {
  editingRoleId.value = row.id
  roleForm.name = row.name
  roleForm.menus = [...row.menus]
  roleDialog.value = true
}

async function saveRole() {
  if (!roleForm.name.trim()) {
    ElMessage.warning('请输入角色名称')
    return
  }
  savingRole.value = true
  try {
    const payload = { name: roleForm.name.trim(), menus: roleForm.menus }
    if (editingRoleId.value === null) {
      await createRole(payload)
      ElMessage.success('新建成功')
    } else {
      await updateRole(editingRoleId.value, payload)
      ElMessage.success('保存成功')
    }
    roleDialog.value = false
    await loadRoles()
  } finally {
    savingRole.value = false
  }
}

async function handleDeleteRole(row: RoleItem) {
  await ElMessageBox.confirm(`确定删除角色「${row.name}」吗？已授权给用户的角色无法删除。`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除',
    confirmButtonClass: 'el-button--danger'
  })
  await deleteRole(row.id)
  ElMessage.success('已删除')
  await loadRoles()
}

onMounted(async () => {
  loadUsers()
  loadRoles()
  try {
    // 无组织架构菜单权限时隐藏组织筛选，不弹错误
    const { data } = await fetchOrgTree(true)
    orgOptions.value = flattenOrg(data.nodes)
  } catch {
    orgOptions.value = []
  }
})
</script>

<template>
  <el-card shadow="never">
    <el-tabs v-model="activeTab">
      <!-- ============ 人员授权 ============ -->
      <el-tab-pane label="人员授权" name="users">
        <div class="toolbar">
          <el-input
            v-model="keyword"
            placeholder="按昵称搜索"
            clearable
            style="width: 220px"
            :prefix-icon="'Search'"
            @keyup.enter="handleSearch"
            @clear="handleSearch"
          />
          <el-select
            v-if="orgOptions.length"
            v-model="orgId"
            placeholder="组织筛选"
            clearable
            filterable
            style="width: 240px"
          >
            <el-option v-for="o in orgOptions" :key="o.id" :label="o.name" :value="o.id" />
          </el-select>
          <el-select v-model="hasAccess" placeholder="后台权限" clearable style="width: 140px">
            <el-option label="有后台权限" :value="true" />
            <el-option label="无后台权限" :value="false" />
          </el-select>
          <el-select v-model="statusFilter" placeholder="账号状态" clearable style="width: 140px">
            <el-option label="启用中" value="active" />
            <el-option label="已停用" value="disabled" />
          </el-select>
          <el-button type="primary" :icon="'Search'" @click="handleSearch">查询</el-button>
          <div class="spacer" />
          <span class="total">共 {{ total }} 人</span>
          <el-button :icon="'Refresh'" @click="loadUsers">刷新</el-button>
        </div>

        <el-table v-loading="loading" :data="users" border stripe row-key="id">
          <el-table-column prop="id" label="ID" width="70" align="center" />
          <el-table-column label="昵称" min-width="160">
            <template #default="{ row }">
              <div class="user-cell">
                <el-avatar :size="28" :src="row.avatar || undefined">{{ (row.nickname || '?').slice(0, 1) }}</el-avatar>
                <span>{{ row.nickname }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="组织" min-width="130" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.org_name">{{ row.org_name }}</span>
              <span v-else class="none">—</span>
            </template>
          </el-table-column>
          <el-table-column label="角色" min-width="220">
            <template #default="{ row }">
              <template v-if="row.roles.length">
                <el-tag
                  v-for="r in row.roles"
                  :key="r.id"
                  size="small"
                  class="role-tag"
                  :type="r.enabled ? 'danger' : 'info'"
                  effect="plain"
                >{{ r.name }}{{ r.enabled ? '' : '（已禁用）' }}</el-tag>
              </template>
              <span v-else class="none">—</span>
            </template>
          </el-table-column>
          <el-table-column label="后台权限" width="110" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="row.has_access ? 'success' : 'info'" effect="plain">
                {{ row.has_access ? '可访问' : '无权限' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="邀请码" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.invite_name">{{ row.invite_name }}</span>
              <span v-else-if="row.invite_code_id" class="none">—</span>
              <el-tag v-else size="small" type="info" effect="plain">历史用户</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="入驻时间" width="150" align="center">
            <template #default="{ row }">
              <span v-if="row.onboarded_at">{{ formatDateTime(row.onboarded_at) }}</span>
              <span v-else class="none">—</span>
            </template>
          </el-table-column>
          <el-table-column label="账号状态" width="110" align="center">
            <template #default="{ row }">
              <el-switch
                :model-value="row.status === 'active'"
                :loading="togglingStatusId === row.id"
                :disabled="togglingStatusId !== null && togglingStatusId !== row.id"
                active-text="启用"
                inactive-text="停用"
                inline-prompt
                @change="toggleUserStatus(row, $event)"
              />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170" align="center" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openGrant(row)">设置角色</el-button>
              <el-tooltip :disabled="!!orgOptions.length" content="需同时拥有「组织架构」菜单权限">
                <span>
                  <el-button link type="primary" :disabled="!orgOptions.length" @click="openOrgChange(row)">调整组织</el-button>
                </span>
              </el-tooltip>
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

        <el-dialog v-model="grantDialog" :title="`设置角色 · ${grantUser?.nickname || ''}`" width="520px" destroy-on-close>
          <p class="dialog-tip">勾选即授予角色，取消勾选将移除；禁用仅保留授权但立即失去对应权限。</p>
          <el-empty v-if="!roles.length" description="暂无角色，请先在「角色管理」中创建" :image-size="60" />
          <div v-for="role in roles" :key="role.id" class="grant-row">
            <el-checkbox
              :model-value="checkedRoleIds.includes(role.id)"
              @change="onGrantCheck(role, $event)"
            >
              {{ role.name }}
              <span v-if="role.is_builtin" class="role-meta">内置</span>
              <span class="role-meta">{{ role.menus.map((c) => MENU_NAME[c] || c).join(' / ') }}</span>
            </el-checkbox>
            <el-switch
              v-if="grantUser && checkedRoleIds.includes(role.id)"
              :model-value="grantUser.roles.find((r) => r.id === role.id)?.enabled ?? true"
              :loading="togglingRoleId === role.id"
              :disabled="togglingRoleId !== null || !grantUser.roles.some((r) => r.id === role.id)"
              @change="toggleRoleEnabled(role, $event)"
            />
          </div>
          <template #footer>
            <el-button @click="grantDialog = false">取消</el-button>
            <el-button type="primary" :loading="savingGrant" @click="saveGrant">保存授权</el-button>
          </template>
        </el-dialog>

        <el-dialog v-model="orgDialog" :title="`调整组织 · ${orgUser?.nickname || ''}`" width="480px" destroy-on-close>
          <p class="dialog-tip">小程序端组织在首次入驻后锁定，仅管理员可在此调整；调整即时生效并记录审计日志。</p>
          <el-form label-width="80px">
            <el-form-item label="当前组织">
              <span v-if="orgUser?.org_name">{{ orgUser.org_name }}</span>
              <span v-else class="none">未分配组织</span>
            </el-form-item>
            <el-form-item label="调整为" required>
              <el-select v-model="targetOrgId" filterable placeholder="选择组织" style="width: 100%">
                <el-option v-for="o in orgOptions" :key="o.id" :label="o.name" :value="o.id" />
              </el-select>
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="orgDialog = false">取消</el-button>
            <el-button
              type="primary"
              :loading="savingOrg"
              :disabled="targetOrgId === null || targetOrgId === orgUser?.org_id"
              @click="saveOrgChange"
            >确认调整</el-button>
          </template>
        </el-dialog>
      </el-tab-pane>

      <!-- ============ 角色管理 ============ -->
      <el-tab-pane label="角色管理" name="roles">
        <div class="toolbar">
          <div class="spacer" />
          <el-button type="primary" :icon="'Plus'" @click="openCreateRole">新建角色</el-button>
          <el-button :icon="'Refresh'" @click="loadRoles">刷新</el-button>
        </div>

        <el-table :data="roles" border stripe row-key="id">
          <el-table-column prop="id" label="ID" width="70" align="center" />
          <el-table-column prop="name" label="角色名称" min-width="140">
            <template #default="{ row }">
              <span>{{ row.name }}</span>
              <el-tag v-if="row.is_builtin" size="small" type="warning" effect="plain" class="builtin-tag">内置</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="code" label="标识" min-width="110" show-overflow-tooltip />
          <el-table-column label="菜单权限" min-width="240">
            <template #default="{ row }">
              <el-tag v-for="c in row.menus" :key="c" size="small" type="danger" effect="plain" class="role-tag">
                {{ MENU_NAME[c] || c }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="user_count" label="授权人数" width="90" align="center" />
          <el-table-column label="操作" width="140" align="center" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openEditRole(row)">编辑</el-button>
              <el-tooltip :disabled="!row.is_builtin" content="内置角色不可删除">
                <span>
                  <el-button link type="danger" :disabled="row.is_builtin" @click="handleDeleteRole(row)">删除</el-button>
                </span>
              </el-tooltip>
            </template>
          </el-table-column>
        </el-table>

        <el-dialog v-model="roleDialog" :title="editingRoleId === null ? '新建角色' : `编辑角色 #${editingRoleId}`" width="520px" destroy-on-close>
          <el-form label-width="90px">
            <el-form-item label="角色名称" required>
              <el-input v-model="roleForm.name" maxlength="32" placeholder="如：运营管理员" />
            </el-form-item>
            <el-form-item label="菜单权限">
              <el-checkbox-group v-model="roleForm.menus">
                <el-checkbox v-for="m in MENUS" :key="m.code" :value="m.code">{{ m.title }}</el-checkbox>
              </el-checkbox-group>
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="roleDialog = false">取消</el-button>
            <el-button type="primary" :loading="savingRole" @click="saveRole">保存</el-button>
          </template>
        </el-dialog>
      </el-tab-pane>
    </el-tabs>
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

.user-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.none {
  color: #c0c4cc;
}

.role-tag {
  margin-right: 4px;
  margin-bottom: 2px;
}

.builtin-tag {
  margin-left: 6px;
}

.dialog-tip {
  margin: 0 0 12px;
  color: #909399;
  font-size: 12px;
}

.grant-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px dashed #ebeef5;
}

.role-meta {
  margin-left: 6px;
  color: #909399;
  font-size: 12px;
}

.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
