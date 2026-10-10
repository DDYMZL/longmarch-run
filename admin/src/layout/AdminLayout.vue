<script setup lang="ts">
// 管理后台布局：侧边菜单按登录时保存的菜单权限渲染（超管全量），路由守卫兜底
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { clearAuth, getIsSuper, getUsername, hasMenu } from '../store/auth'
import { fetchOnboardingQr, type OnboardingQrResult } from '../api/admin'

const route = useRoute()
const router = useRouter()
const username = computed(() => getUsername() || 'admin')
const isSuper = computed(() => getIsSuper())
const activeMenu = computed(() => route.path)

const ENV_LABELS: Record<string, string> = { release: '正式版', trial: '体验版', develop: '开发版' }
const qrVisible = ref(false)
const qrLoading = ref(false)
const qr = ref<OnboardingQrResult | null>(null)

async function openOnboardingQr() {
  qrVisible.value = true
  if (qr.value?.image) return
  qrLoading.value = true
  try {
    const { data } = await fetchOnboardingQr()
    qr.value = data
  } finally {
    qrLoading.value = false
  }
}

function downloadOnboardingQr() {
  const image = qr.value?.image
  if (!image) return
  const link = document.createElement('a')
  link.href = image
  link.download = `长征步迹_入驻小程序码.${image.startsWith('data:image/png') ? 'png' : 'jpg'}`
  link.click()
}

const MENU_ITEMS = [
  { path: '/dashboard', code: 'dashboard', title: '驾驶舱', icon: 'Odometer' },
  { path: '/screen', code: 'screen', title: '数据大屏', icon: 'Monitor' },
  { path: '/rankings', code: 'rankings', title: '排名洞察', icon: 'DataAnalysis' },
  { path: '/route-nodes', code: 'route_nodes', title: '路线点位', icon: 'Location' },
  { path: '/questions', code: 'questions', title: '题库维护', icon: 'EditPen' },
  { path: '/quotes', code: 'quotes', title: '每日寄语', icon: 'ChatLineSquare' },
  { path: '/orgs', code: 'orgs', title: '组织架构', icon: 'OfficeBuilding' },
  { path: '/access', code: 'access', title: '人员授权', icon: 'Setting' },
  { path: '/audit', code: 'audit', title: '审计日志', icon: 'Document' }
]

const visibleMenus = computed(() => MENU_ITEMS.filter((item) => hasMenu(item.code)))

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
        <el-menu-item v-for="item in visibleMenus" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon><span>{{ item.title }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="page-title">{{ route.meta.title }}</span>
        <div class="user-area">
          <el-button link type="primary" @click="openOnboardingQr"><el-icon><Iphone /></el-icon>入驻二维码</el-button>
          <el-tag v-if="isSuper" size="small" type="warning" effect="plain">超级管理员</el-tag>
          <el-icon><UserFilled /></el-icon><span class="username">{{ username }}</span>
          <el-button link type="danger" @click="handleLogout">退出登录</el-button>
        </div>
      </el-header>
      <el-main class="main"><router-view /></el-main>
    </el-container>
    <el-dialog v-model="qrVisible" title="员工入驻二维码" width="400px" align-center>
      <div v-loading="qrLoading" class="qr-box">
        <template v-if="qr">
          <img v-if="qr.image" :src="qr.image" alt="入驻小程序码" class="qr-img" />
          <el-alert v-else type="warning" :closable="false" show-icon title="未配置微信凭证或生成失败，暂无法出码"
            description="请在后端 .env 配置 WX_APPID / WX_SECRET 后重试" />
          <p class="qr-tip">员工微信扫码即自动登录进入小程序首页，无需填写信息。码内不含任何个人信息，可张贴或群发。</p>
          <p class="qr-meta">小程序版本：{{ ENV_LABELS[qr.env_version] || qr.env_version }}</p>
        </template>
      </div>
      <template #footer>
        <el-button @click="qrVisible = false">关闭</el-button>
        <el-button type="primary" :disabled="!qr?.image" @click="downloadOnboardingQr">下载图片</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<style scoped>
.layout{height:100%}.aside{background:#111827;box-shadow:8px 0 30px rgb(15 23 42/8%)}.aside :deep(.el-menu){border-right:0}.aside :deep(.el-menu-item){margin:6px 12px;border-radius:10px}.aside :deep(.el-menu-item.is-active){background:linear-gradient(90deg,rgb(200 16 46/28%),rgb(248 212 119/8%))}.brand{height:68px;display:flex;align-items:center;justify-content:center;gap:10px;color:#f8d477;font-size:16px;font-weight:700;letter-spacing:1px}.brand-mark{width:32px;height:32px;display:grid;place-items:center;border:1px solid rgb(248 212 119/35%);border-radius:10px;background:rgb(248 212 119/10%)}.header{height:68px;display:flex;align-items:center;justify-content:space-between;background:rgb(255 255 255/88%);border-bottom:1px solid #e8ecf2;backdrop-filter:blur(14px)}.page-title{font-size:16px;font-weight:600;color:#303133}.user-area{display:flex;align-items:center;gap:8px;color:#606266}.username{margin-right:8px}.main{padding:24px;background:#f4f6fa}.qr-box{min-height:120px;text-align:center}.qr-img{width:260px;height:260px}.qr-tip{margin:12px 0 4px;color:#606266;font-size:13px;line-height:1.6}.qr-meta{margin:0;color:#909399;font-size:12px}
</style>
