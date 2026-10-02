<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { clearAuth, getUsername } from '../store/auth'

const route = useRoute()
const router = useRouter()
const username = computed(() => getUsername() || 'admin')
const activeMenu = computed(() => route.path)

async function handleLogout() {
  await ElMessageBox.confirm('确定退出登录吗？', '提示', { type: 'warning' })
  clearAuth()
  router.push('/login')
}
</script>

<template>
  <el-container class="layout">
    <el-aside width="220px" class="aside">
      <div class="brand">
        <span class="brand-mark"><el-icon><Promotion /></el-icon></span>
        <span>长征管理后台</span>
      </div>
      <el-menu :default-active="activeMenu" router background-color="#111827" text-color="#94a3b8" active-text-color="#f8d477">
        <el-menu-item index="/dashboard"><el-icon><Odometer /></el-icon><span>驾驶舱</span></el-menu-item>
        <el-menu-item index="/screen"><el-icon><Monitor /></el-icon><span>数据大屏</span></el-menu-item>
        <el-menu-item index="/rankings"><el-icon><DataAnalysis /></el-icon><span>排名洞察</span></el-menu-item>
        <el-menu-item index="/route-nodes"><el-icon><Location /></el-icon><span>路线点位</span></el-menu-item>
        <el-menu-item index="/questions"><el-icon><EditPen /></el-icon><span>题库维护</span></el-menu-item>
        <el-menu-item index="/orgs"><el-icon><OfficeBuilding /></el-icon><span>组织架构</span></el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="page-title">{{ route.meta.title }}</span>
        <div class="user-area">
          <el-icon><UserFilled /></el-icon><span class="username">{{ username }}</span>
          <el-button link type="danger" @click="handleLogout">退出登录</el-button>
        </div>
      </el-header>
      <el-main class="main"><router-view /></el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout{height:100%}.aside{background:#111827;box-shadow:8px 0 30px rgb(15 23 42/8%)}.aside :deep(.el-menu){border-right:0}.aside :deep(.el-menu-item){margin:6px 12px;border-radius:10px}.aside :deep(.el-menu-item.is-active){background:linear-gradient(90deg,rgb(200 16 46/28%),rgb(248 212 119/8%))}.brand{height:68px;display:flex;align-items:center;justify-content:center;gap:10px;color:#f8d477;font-size:16px;font-weight:700;letter-spacing:1px}.brand-mark{width:32px;height:32px;display:grid;place-items:center;border:1px solid rgb(248 212 119/35%);border-radius:10px;background:rgb(248 212 119/10%)}.header{height:68px;display:flex;align-items:center;justify-content:space-between;background:rgb(255 255 255/88%);border-bottom:1px solid #e8ecf2;backdrop-filter:blur(14px)}.page-title{font-size:16px;font-weight:600;color:#303133}.user-area{display:flex;align-items:center;gap:8px;color:#606266}.username{margin-right:8px}.main{padding:24px;background:#f4f6fa}
</style>
