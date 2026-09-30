<script setup lang="ts">
// 后台整体布局：左侧菜单（题库维护 / 组织架构）+ 顶栏（当前管理员 / 退出登录）
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
      <div class="brand">🚩 长征管理后台</div>
      <el-menu :default-active="activeMenu" router background-color="#2b2f3a" text-color="#bfcbd9"
        active-text-color="#ffd04b">
        <el-menu-item index="/questions">
          <el-icon><EditPen /></el-icon>
          <span>题库维护</span>
        </el-menu-item>
        <el-menu-item index="/orgs">
          <el-icon><OfficeBuilding /></el-icon>
          <span>组织架构</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="page-title">{{ route.meta.title }}</span>
        <div class="user-area">
          <el-icon><UserFilled /></el-icon>
          <span class="username">{{ username }}</span>
          <el-button link type="danger" @click="handleLogout">退出登录</el-button>
        </div>
      </el-header>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100%;
}

.aside {
  background-color: #2b2f3a;
}

.aside :deep(.el-menu) {
  border-right: none;
}

.brand {
  height: 60px;
  line-height: 60px;
  text-align: center;
  color: #ffd04b;
  font-size: 16px;
  font-weight: 600;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
}

.page-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.user-area {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #606266;
}

.username {
  margin-right: 8px;
}

.main {
  padding: 16px;
}
</style>
