<script setup lang="ts">
// 组织架构维护：树形表格展示、新增/编辑/删除节点、一键同步外部系统组织架构
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { createOrg, deleteOrg, fetchOrgTree, syncOrgs, updateOrg } from '../api/admin'
import type { OrgNode } from '../api/admin'

const loading = ref(false)
const syncing = ref(false)
const total = ref(0)
const treeData = ref<OrgNode[]>([])
const lastSyncSource = ref('')

async function loadTree() {
  loading.value = true
  try {
    const { data } = await fetchOrgTree()
    treeData.value = data.nodes
    total.value = data.total
  } finally {
    loading.value = false
  }
}

// ---------------- 同步 ----------------
async function handleSync() {
  await ElMessageBox.confirm(
    '将从外部系统全量同步组织架构：新增/更新节点，外部已删除且无用户归属的节点会被移除。是否继续？',
    '同步组织架构',
    { type: 'warning', confirmButtonText: '开始同步' }
  )
  syncing.value = true
  try {
    const { data } = await syncOrgs()
    lastSyncSource.value = data.source
    await loadTree()
    ElNotification({
      title: '同步完成',
      type: 'success',
      message: `数据源：${data.source}\n新增 ${data.created} 个、更新 ${data.updated} 个、删除 ${data.deleted} 个，现有 ${data.kept} 个节点` +
        (data.skipped.length ? `\n以下节点仍被用户引用已保留：${data.skipped.join('、')}` : ''),
      duration: 6000
    })
  } finally {
    syncing.value = false
  }
}

// ---------------- 新增 / 编辑弹窗 ----------------
const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

const form = reactive({
  name: '',
  parent_id: null as number | null,
  sort_order: 0
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入组织名称', trigger: 'blur' }]
}

const dialogTitle = computed(() => (editingId.value === null ? '新增组织' : `编辑组织 #${editingId.value}`))

// el-tree-select 数据：编辑时禁用自身及其子孙（防止产生环）
const parentTreeData = computed(() => {
  const disabledIds = editingId.value === null ? new Set<number>() : collectSubtreeIds(treeData.value, editingId.value)
  const build = (nodes: OrgNode[]): any[] =>
    nodes.map((n) => ({
      value: n.id,
      label: n.name,
      disabled: disabledIds.has(n.id),
      children: build(n.children || [])
    }))
  return build(treeData.value)
})

function collectSubtreeIds(nodes: OrgNode[], rootId: number): Set<number> {
  const result = new Set<number>()
  const walk = (list: OrgNode[], inside: boolean) => {
    for (const n of list) {
      const hit = inside || n.id === rootId
      if (hit) result.add(n.id)
      walk(n.children || [], hit)
    }
  }
  walk(nodes, false)
  return result
}

function openCreate(parent: OrgNode | null) {
  editingId.value = null
  form.name = ''
  form.parent_id = parent ? parent.id : null
  form.sort_order = 0
  dialogVisible.value = true
}

function openEdit(row: OrgNode) {
  editingId.value = row.id
  form.name = row.name
  form.parent_id = row.parent_id
  form.sort_order = row.sort_order
  dialogVisible.value = true
}

async function handleSave() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  const payload = {
    name: form.name.trim(),
    parent_id: form.parent_id,
    sort_order: Number(form.sort_order)
  }
  saving.value = true
  try {
    if (editingId.value === null) {
      await createOrg(payload)
      ElMessage.success('新增成功')
    } else {
      await updateOrg(editingId.value, payload)
      ElMessage.success('保存成功')
    }
    dialogVisible.value = false
    await loadTree()
  } finally {
    saving.value = false
  }
}

async function handleDelete(row: OrgNode) {
  const hasChildren = (row.children || []).length > 0
  await ElMessageBox.confirm(
    hasChildren
      ? `「${row.name}」下还有 ${row.children.length} 个子组织，将级联删除整棵子树（仍被用户引用的节点会自动保留）。是否继续？`
      : `确定删除组织「${row.name}」吗？`,
    '删除确认',
    { type: 'warning', confirmButtonText: '删除', confirmButtonClass: 'el-button--danger' }
  )
  const { data } = await deleteOrg(row.id)
  ElMessage.success(data.message)
  await loadTree()
}

onMounted(loadTree)
</script>

<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-button type="warning" :icon="'Refresh'" :loading="syncing" @click="handleSync">
        同步组织架构
      </el-button>
      <el-button type="primary" :icon="'Plus'" @click="openCreate(null)">新增顶级组织</el-button>
      <el-button :icon="'Refresh'" @click="loadTree">刷新</el-button>
      <div class="spacer" />
      <span class="total">共 {{ total }} 个组织节点</span>
    </div>
    <el-alert
      v-if="lastSyncSource"
      class="sync-tip"
      type="info"
      :closable="false"
      show-icon
      title=""
    >
      <template #default>
        最近一次同步数据源：{{ lastSyncSource }}
      </template>
    </el-alert>

    <el-table
      v-loading="loading"
      :data="treeData"
      row-key="id"
      border
      default-expand-all
      :tree-props="{ children: 'children' }"
    >
      <el-table-column prop="name" label="组织名称" min-width="260" />
      <el-table-column prop="id" label="ID" width="80" align="center" />
      <el-table-column prop="level" label="层级" width="80" align="center">
        <template #default="{ row }">
          <el-tag size="small" type="info">L{{ row.level }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="sort_order" label="排序" width="80" align="center" />
      <el-table-column label="直属人数" width="100" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="row.direct_user_count > 0 ? 'success' : 'info'">
            {{ row.direct_user_count }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="成员总数（含下级）" width="140" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="row.total_user_count > 0 ? 'warning' : 'info'">
            {{ row.total_user_count }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="220" align="center" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openCreate(row)">新增下级</el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="480px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="组织名称" prop="name">
          <el-input v-model="form.name" maxlength="80" placeholder="请输入组织名称" />
        </el-form-item>
        <el-form-item label="上级组织">
          <el-tree-select
            v-model="form.parent_id"
            :data="parentTreeData"
            check-strictly
            clearable
            placeholder="留空表示顶级组织"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="排序号">
          <el-input-number v-model="form.sort_order" :min="0" :max="9999" />
          <span class="form-tip">同级内按排序号升序展示</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
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

.sync-tip {
  margin-bottom: 12px;
}

.form-tip {
  margin-left: 10px;
  color: #909399;
  font-size: 12px;
}
</style>
