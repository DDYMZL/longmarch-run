<script setup lang="ts">
// 登录页：账号密码登录 + 微信扫码登录（小程序码 + 2s 轮询；mock 模式显示场景码供开发调试）
import { onBeforeUnmount, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { createWechatQr, fetchMe, login, pollWechatQr } from '../api/admin'
import type { QrCreateResult } from '../api/admin'
import { setAuth, setProfile } from '../store/auth'

const router = useRouter()
const route = useRoute()
const formRef = ref<FormInstance>()
const loading = ref(false)

// ---------------- 账号登录 ----------------
const form = reactive({
  username: 'admin',
  password: ''
})

const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

function handleLoggedIn(token: string, username: string) {
  setAuth(token, username)
  const redirect = (route.query.redirect as string) || '/'
  router.push(redirect)
}

async function handleLogin() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  loading.value = true
  try {
    const { data } = await login(form.username, form.password)
    setAuth(data.token, data.username)
    const me = await fetchMe()
    setProfile(me.data.username, me.data.is_super, me.data.menus.map((m) => m.code))
    ElMessage.success('登录成功')
    handleLoggedIn(data.token, data.username)
  } catch {
    // 错误提示已由 axios 拦截器统一处理
  } finally {
    loading.value = false
  }
}

// ---------------- 微信扫码登录 ----------------
const activeTab = ref('account')
const qr = ref<QrCreateResult | null>(null)
const qrStatusText = ref('')
const qrFailed = ref(false)
const qrFailReason = ref('')
let pollTimer: number | null = null

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

async function startQr() {
  stopPolling()
  qrFailed.value = false
  qrFailReason.value = ''
  qrStatusText.value = '正在生成小程序码…'
  try {
    const { data } = await createWechatQr()
    qr.value = data
    qrStatusText.value = data.mock ? '开发模式：请将场景码填入小程序调试入口' : '请使用手机微信扫码'
    pollTimer = window.setInterval(pollOnce, 2000)
  } catch {
    qrStatusText.value = '小程序码生成失败，请稍后重试'
  }
}

async function pollOnce() {
  if (!qr.value) return
  try {
    const { data } = await pollWechatQr(qr.value.qr_id)
    if (data.status === 'confirmed') {
      if (data.token && data.username) {
        stopPolling()
        setAuth(data.token, data.username)
        setProfile(data.username, data.is_super ?? false, (data.menus || []).map((m) => m.code))
        ElMessage.success('扫码登录成功')
        handleLoggedIn(data.token, data.username)
      } else {
        // 会话已被其他标签页签发，刷新二维码
        startQr()
      }
    } else if (data.status === 'scanned') {
      qrStatusText.value = '已扫码，请在手机上确认登录'
    } else if (data.status === 'failed') {
      stopPolling()
      qrFailed.value = true
      qrFailReason.value = data.fail_reason || '登录未获授权'
      qrStatusText.value = '登录未获授权'
    } else if (data.status === 'expired') {
      qrStatusText.value = '二维码已过期，正在刷新…'
      startQr()
    } else {
      qrStatusText.value = '请使用手机微信扫码'
    }
  } catch (error: unknown) {
    const status = (error as { response?: { status?: number } })?.response?.status
    if (status === 404) {
      startQr()
    }
    // 其余错误静默，等待下次轮询
  }
}

async function copyScene() {
  if (!qr.value?.scene) return
  try {
    await navigator.clipboard.writeText(qr.value.scene)
    ElMessage.success('场景码已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选择复制')
  }
}

function handleTabChange(name: string | number) {
  if (name === 'qr') {
    startQr()
  } else {
    stopPolling()
  }
}

onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="login-page">
    <el-card class="login-card" shadow="always">
      <div class="login-title">
        <span class="login-logo">🚩</span>
        <h2>长征运动挑战 · 管理后台</h2>
      </div>
      <el-tabs v-model="activeTab" class="login-tabs" @tab-change="handleTabChange">
        <el-tab-pane label="账号登录" name="account">
          <el-form ref="formRef" :model="form" :rules="rules" size="large" @keyup.enter="handleLogin">
            <el-form-item prop="username">
              <el-input v-model="form.username" placeholder="用户名" :prefix-icon="'User'" clearable />
            </el-form-item>
            <el-form-item prop="password">
              <el-input
                v-model="form.password"
                type="password"
                placeholder="密码（需在服务端显式配置）"
                :prefix-icon="'Lock'"
                show-password
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" class="login-btn" :loading="loading" @click="handleLogin">
                登 录
              </el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>
        <el-tab-pane label="微信扫码" name="qr">
          <div class="qr-panel">
            <div class="qr-box">
              <img v-if="qr?.image" :src="qr.image" alt="登录小程序码" class="qr-image" />
              <div v-else-if="qr?.mock" class="qr-mock">
                <span class="qr-mock-tip">开发模式无小程序码</span>
                <el-input :model-value="qr.scene || ''" readonly size="small">
                  <template #append>
                    <el-button size="small" @click="copyScene">复制场景码</el-button>
                  </template>
                </el-input>
              </div>
              <span v-else class="qr-loading">生成中…</span>
            </div>
            <p class="qr-status" :class="{ danger: qrFailed }">{{ qrStatusText }}</p>
            <p v-if="qrFailed" class="qr-fail-reason">{{ qrFailReason }}</p>
            <p v-if="qrFailed || !qr" class="qr-refresh">
              <el-button link type="primary" @click="startQr">重新获取二维码</el-button>
            </p>
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #8e0e00 0%, #1f1c18 100%);
}

.login-card {
  width: 400px;
  border-radius: 12px;
}

.login-title {
  text-align: center;
  margin-bottom: 16px;
}

.login-logo {
  font-size: 40px;
}

.login-title h2 {
  margin: 8px 0 0;
  font-size: 20px;
  color: #303133;
}

.login-btn {
  width: 100%;
}

.login-tabs :deep(.el-tabs__content) {
  min-height: 220px;
}

.qr-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 4px 0 8px;
}

.qr-box {
  width: 180px;
  height: 180px;
  display: grid;
  place-items: center;
  border: 1px dashed #dcdfe6;
  border-radius: 10px;
  background: #fafbfc;
}

.qr-image {
  width: 170px;
  height: 170px;
  display: block;
}

.qr-mock {
  width: 160px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}

.qr-mock-tip {
  color: #909399;
  font-size: 12px;
}

.qr-loading {
  color: #909399;
  font-size: 13px;
}

.qr-status {
  margin: 0;
  font-size: 14px;
  color: #606266;
}

.qr-status.danger {
  color: #c8102e;
}

.qr-fail-reason {
  margin: 0;
  font-size: 12px;
  color: #909399;
}

.qr-refresh {
  margin: 0;
}
</style>
