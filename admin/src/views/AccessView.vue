<script setup lang="ts">
// 人员授权：人员列表筛选、角色全量覆盖授权、单角色启用/禁用（禁用即时生效）；
// 角色管理：角色 CRUD + 菜单勾选（内置角色禁删、被引用角色删除时后端拒绝）
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  MENU_CATALOG,
  createRole,
  deleteRole,
  fetchAdminUsers,
  fetchOrgTree,
  fetchRoles,
  grantUserRoles,
  setUserRoleEnabled,
  updateRole
} from '../api/admin'
import type { AdminUserItem, OrgNode, RoleItem } from '../api/admin'

const MENU_NAME: Record<string, string> = Object.fromEntries(
  MENU_CATALOG.map((m) => [m.code, m.name])
)

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
const orgOptions = ref<{ id: number; name: string }[]>([])
const roles = ref<RoleItem[]>([])

function flattenOrg(nodes: OrgNode[]): { id: number; name: string }[] {
  return nodes.flatMap((n) => [{ id: n.id, name: n.name }, ...flattenOrg(n.children || [])])
}

async function loadUsers() {
  loading.value = true
  try {
    const { data } = await fetchAdminUsers({
      page: page.value,
      page_size: pageSize.value,
      keyword: keyword.value.trim() || undefined,
      org_id: orgId.value ?? undefined,
      has_access: hasAccess.value ?? undefined
    })
    users.value = data.items
    total.value = data.total
  } finally {
    loading.value = false
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

async function toggleRoleEnabled(user: AdminUserItem | null, role: { id: number; name: string }, enabled: unknown) {
  if (!user) return
  const on = !!enabled
  await setUserRoleEnabled(user.id, role.id, on)
  ElMessage.success(on ? `已启用「${role.name}」` : `已禁用「${role.name}」（即时生效）`)
  await loadUsers()
  if (grantUser.value?.id === user.id) {
    const fresh = users.value.find((u) => u.id === user.id)
    if (fresh) {
      grantUser.value = fresh
      // 保持「已授权」勾选（禁用仅影响开关状态，不撤销授权）
      checkedRoleIds.value = fresh.roles.map((r) => r.id)
    }
  }
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
    const { data } = await fetchOrgTree()
    orgOptions.value = flattenOrg(data.nodes)
  } catch {
    // 无组织架构菜单权限时隐藏组织筛选
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
          <el-select v-if="orgOptions.length" v-model="orgId" placeholder="组织筛选" clearable style="width: 180px">
            <el-option v-for="o in orgOptions" :key="o.id" :label="o.name" :value="o.id" />
          </el-select>
          <el-select v-model="hasAccess" placeholder="后台权限" clearable style="width: 140px">
            <el-option label="有后台权限" :value="true" />
            <el-option label="无后台权限" :value="false" />
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
          <el-table-column label="操作" width="110" align="center" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openGrant(row)">设置角色</el-button>
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
              :model-value="grantUser?.roles.find((r) => r.id === role.id)?.enabled ?? true"
              :disabled="!(grantUser?.roles.some((r) => r.id === role.id) ?? false)"
              @change="toggleRoleEnabled(grantUser, role, $event)"
            />
          </div>
          <template #footer>
            <el-button @click="grantDialog = false">取消</el-button>
            <el-button type="primary" :loading="savingGrant" @click="saveGrant">保存授权</el-button>
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
                <el-checkbox v-for="m in MENU_CATALOG" :key="m.code" :value="m.code">{{ m.name }}</el-checkbox>
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
