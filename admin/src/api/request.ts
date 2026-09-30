// axios 实例：统一注入 Bearer Token、统一错误提示、401 跳转登录页
import axios from 'axios'
import { ElMessage } from 'element-plus'
import { clearAuth, getToken } from '../store/auth'
import router from '../router'

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
    const onLoginPage = router.currentRoute.value.path === '/login'
    if (status === 401) {
      clearAuth()
      // 登录页：直接提示账号密码错误；其他页：令牌失效，提示并跳转登录
      ElMessage.error(onLoginPage ? detail || '用户名或密码错误' : '登录已过期，请重新登录')
      if (!onLoginPage) {
        router.push('/login')
      }
    } else {
      ElMessage.error(detail || error.message || '请求失败')
    }
    return Promise.reject(error)
  }
)

export default request
