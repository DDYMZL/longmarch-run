<script setup lang="ts">
// 管理后台布局：侧边菜单按登录时保存的菜单权限渲染（超管全量），路由守卫兜底；
// 菜单按 MENU_GROUPS 做一级分组（el-sub-menu 折叠），未分组菜单平铺为一级项；整栏可收起为图标栏
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { clearAuth, getIsSuper, getUsername, hasMenu } from '../store/auth'
import { MENUS, MENU_GROUPS } from '../router/menus'

const route = useRoute()
const router = useRouter()
const username = computed(() => getUsername() || 'admin')
const isSuper = computed(() => getIsSuper())
const activeMenu = computed(() => route.path)
const collapsed = ref(false)

const menuByCode = new Map(MENUS.map((m) => [m.code, m]))
const groupedCodes = new Set(MENU_GROUPS.flatMap((g) => g.children))

// 未分组菜单（含新增的未分组菜单）作为一级项平铺，避免新增菜单从侧边栏丢失
const visibleTopMenus = computed(() => MENUS.filter((m) => !groupedCodes.has(m.code) && hasMenu(m.code)))

// 分组内按权限过滤子菜单；过滤后为空的分组整体隐藏
const visibleGroups = computed(() =>
  MENU_GROUPS.map((g) => ({
    ...g,
    items: g.children
      .map((c) => menuByCode.get(c))
      .filter((m): m is (typeof MENUS)[number] => !!m && hasMenu(m.code))
  })).filter((g) => g.items.length > 0)
)

// default-openeds 仅初始化读取一次：自动展开当前路由所在分组，刷新后仍能看到高亮项
const defaultOpeneds = MENU_GROUPS.filter((g) =>
  g.children.some((c) => menuByCode.get(c)?.path === route.path)
).map((g) => g.code)

async function handleLogout() {
  await ElMessageBox.confirm('确定退出登录吗？', '提示', { type: 'warning' })
  clearAuth()
  router.push('/login')
}
</script>

<template>
  <el-container class="layout">
    <el-aside :width="collapsed ? '64px' : '220px'" class="aside">
      <div class="brand">
        <span class="brand-mark"><el-icon><Promotion /></el-icon></span>
        <span v-show="!collapsed" class="brand-name">长征管理后台</span>
      </div>
      <el-menu
        :default-active="activeMenu"
        :default-openeds="defaultOpeneds"
        :collapse="collapsed"
        unique-opened
        router
        background-color="#111827"
        text-color="#94a3b8"
        active-text-color="#f8d477"
      >
        <el-menu-item v-for="item in visibleTopMenus" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon><span>{{ item.title }}</span>
        </el-menu-item>
        <el-sub-menu v-for="group in visibleGroups" :key="group.code" :index="group.code">
          <template #title>
            <el-icon><component :is="group.icon" /></el-icon><span>{{ group.title }}</span>
          </template>
          <el-menu-item v-for="item in group.items" :key="item.path" :index="item.path">
            <el-icon><component :is="item.icon" /></el-icon><span>{{ item.title }}</span>
          </el-menu-item>
        </el-sub-menu>
      </el-menu>
      <div class="aside-footer" @click="collapsed = !collapsed">
        <el-icon><Fold v-if="!collapsed" /><Expand v-else /></el-icon>
      </div>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="page-title">{{ route.meta.title }}</span>
        <div class="user-area">
          <el-tag v-if="isSuper" size="small" type="warning" effect="plain">超级管理员</el-tag>
          <el-icon><UserFilled /></el-icon><span class="username">{{ username }}</span>
          <el-button link type="danger" @click="handleLogout">退出登录</el-button>
        </div>
      </el-header>
      <el-main class="main"><router-view /></el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout{height:100%}.aside{background:#111827;box-shadow:8px 0 30px rgb(15 23 42/8%);display:flex;flex-direction:column;transition:width .2s}.aside :deep(.el-menu){border-right:0;flex:1}.aside :deep(.el-menu-item),.aside :deep(.el-sub-menu__title){margin:6px 12px;border-radius:10px}.aside :deep(.el-menu--collapse .el-menu-item),.aside :deep(.el-menu--collapse .el-sub-menu__title){margin:6px}.aside :deep(.el-menu-item.is-active){background:linear-gradient(90deg,rgb(200 16 46/28%),rgb(248 212 119/8%))}.aside :deep(.el-sub-menu.is-active>.el-sub-menu__title){color:#f8d477}.aside-footer{height:48px;display:flex;align-items:center;justify-content:center;color:#94a3b8;cursor:pointer;border-top:1px solid rgb(255 255 255/8%)}.aside-footer:hover{color:#f8d477}.brand{height:68px;display:flex;align-items:center;justify-content:center;gap:10px;color:#f8d477;font-size:16px;font-weight:700;letter-spacing:1px;white-space:nowrap;overflow:hidden}.brand-mark{width:32px;height:32px;flex:none;display:grid;place-items:center;border:1px solid rgb(248 212 119/35%);border-radius:10px;background:rgb(248 212 119/10%)}.header{height:68px;display:flex;align-items:center;justify-content:space-between;background:rgb(255 255 255/88%);border-bottom:1px solid #e8ecf2;backdrop-filter:blur(14px)}.page-title{font-size:16px;font-weight:600;color:#303133}.user-area{display:flex;align-items:center;gap:8px;color:#606266}.username{margin-right:8px}.main{padding:24px;background:#f4f6fa}
</style>
