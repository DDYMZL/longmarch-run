// 管理后台登录态：token / 用户名 / 菜单权限持久化到 localStorage，页面刷新不丢失
const TOKEN_KEY = 'lm_admin_token'
const USERNAME_KEY = 'lm_admin_username'
const MENUS_KEY = 'lm_admin_menus'
const IS_SUPER_KEY = 'lm_admin_is_super'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function getUsername(): string {
  return localStorage.getItem(USERNAME_KEY) || ''
}

export function getIsSuper(): boolean {
  return localStorage.getItem(IS_SUPER_KEY) === '1'
}

export function getMenus(): string[] {
  try {
    return JSON.parse(localStorage.getItem(MENUS_KEY) || '[]')
  } catch {
    return []
  }
}

export function hasMenu(code: string): boolean {
  return getIsSuper() || getMenus().includes(code)
}

export function setAuth(token: string, username: string): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USERNAME_KEY, username)
}

// 登录成功后写入用户档案（超管标记与菜单码集合），菜单渲染与路由守卫据此判断
export function setProfile(username: string, isSuper: boolean, menus: string[]): void {
  localStorage.setItem(USERNAME_KEY, username)
  localStorage.setItem(IS_SUPER_KEY, isSuper ? '1' : '0')
  localStorage.setItem(MENUS_KEY, JSON.stringify(menus))
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USERNAME_KEY)
  localStorage.removeItem(MENUS_KEY)
  localStorage.removeItem(IS_SUPER_KEY)
}

export function isLoggedIn(): boolean {
  // 需同时存在令牌与权限档案（菜单或超管标记）；仅残留旧令牌视为未登录，避免路由守卫死循环
  return !!getToken() && (getIsSuper() || localStorage.getItem(MENUS_KEY) !== null)
}
