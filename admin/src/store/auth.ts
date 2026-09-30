// 管理后台登录态：token 持久化到 localStorage，页面刷新不丢失
const TOKEN_KEY = 'lm_admin_token'
const USERNAME_KEY = 'lm_admin_username'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function getUsername(): string {
  return localStorage.getItem(USERNAME_KEY) || ''
}

export function setAuth(token: string, username: string): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USERNAME_KEY, username)
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USERNAME_KEY)
}

export function isLoggedIn(): boolean {
  return !!getToken()
}
