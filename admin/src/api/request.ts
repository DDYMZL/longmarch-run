// axios 实例：统一注入 Bearer Token、统一错误提示、401 跳转登录页
import axios from 'axios'
import { ElMessage } from 'element-plus'
import { clearAuth, getToken } from '../store/auth'
import router from '../router'

// silent：轮询类请求（如扫码状态）失败时不弹错误提示，由调用方自行处理
declare module 'axios' {
  export interface AxiosRequestConfig {
    silent?: boolean
  }
}

const request = axios.create({
  baseURL: '/api',
  timeout: 15000
})

request.interceptors.request.use((config) => {
  const token = getToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

request.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status
    // FastAPI 错误体：{ detail: "..." }
    const detail = error.response?.data?.detail
    const silent = !!error.config?.silent
    const onLoginPage = router.currentRoute.value.path === '/login'
    if (status === 401) {
      // 并发请求同时 401 时只有首个（清除前仍持有令牌）提示，避免连弹多条
      const hadToken = !!getToken()
      clearAuth()
      // 登录页：直接提示账号密码错误；其他页：令牌失效，提示并跳转登录
      if (onLoginPage) {
        if (!silent) ElMessage.error(detail || '用户名或密码错误')
      } else {
        if (hadToken && !silent) ElMessage.error('登录已过期，请重新登录')
        router.push('/login')
      }
    } else if (!silent) {
      ElMessage.error(detail || error.message || '请求失败')
    }
    return Promise.reject(error)
  }
)

export default request
