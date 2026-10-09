// 路由：登录页 + 后台布局（驾驶舱 / 数据大屏 / 排名洞察 / 路线点位 / 题库 / 寄语 /
// 组织架构 / 人员授权 / 审计日志），带登录守卫与菜单权限守卫
import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { hasMenu, isLoggedIn } from '../store/auth'

// 菜单顺序（与侧边栏一致）：无权限访问页面时回退到第一个可用菜单
const MENU_ORDER = [
  { path: '/dashboard', code: 'dashboard' },
  { path: '/screen', code: 'screen' },
  { path: '/rankings', code: 'rankings' },
  { path: '/route-nodes', code: 'route_nodes' },
  { path: '/questions', code: 'questions' },
  { path: '/quotes', code: 'quotes' },
  { path: '/orgs', code: 'orgs' },
  { path: '/access', code: 'access' },
  { path: '/audit', code: 'audit' }
]

function firstAllowedPath(): string {
  const item = MENU_ORDER.find((m) => hasMenu(m.code))
  return item ? item.path : '/login'
}

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { title: '登录' }
  },
  {
    path: '/screen',
    name: 'screen',
    component: () => import('../views/ScreenView.vue'),
    meta: { title: '数据大屏', menu: 'screen' }
  },
  {
    path: '/',
    component: () => import('../layout/AdminLayout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('../views/DashboardView.vue'),
        meta: { title: '驾驶舱', menu: 'dashboard' }
      },
      {
        path: 'rankings',
        name: 'rankings',
        component: () => import('../pages/RankingsView.vue'),
        meta: { title: '排名洞察', menu: 'rankings' }
      },
      {
        path: 'route-nodes',
        name: 'route-nodes',
        component: () => import('../views/RouteNodesView.vue'),
        meta: { title: '路线点位', menu: 'route_nodes' }
      },
      {
        path: 'questions',
        name: 'questions',
        component: () => import('../views/QuestionsView.vue'),
        meta: { title: '题库维护', menu: 'questions' }
      },
      {
        path: 'quotes',
        name: 'quotes',
        component: () => import('../views/QuotesView.vue'),
        meta: { title: '每日寄语', menu: 'quotes' }
      },
      {
        path: 'orgs',
        name: 'orgs',
        component: () => import('../views/OrgsView.vue'),
        meta: { title: '组织架构', menu: 'orgs' }
      },
      {
        path: 'access',
        name: 'access',
        component: () => import('../views/AccessView.vue'),
        meta: { title: '人员授权', menu: 'access' }
      },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('../views/AuditView.vue'),
        meta: { title: '审计日志', menu: 'audit' }
      }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to) => {
  document.title = `${to.meta.title || '管理后台'} · 长征运动挑战`
  if (to.path !== '/login' && !isLoggedIn()) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
  if (to.path === '/login' && isLoggedIn()) {
    // 已登录但无任何可用菜单时停留在登录页，避免 /login ↔ /dashboard 重定向死循环
    const fallback = firstAllowedPath()
    return fallback === '/login' ? true : { path: fallback }
  }
  // 菜单权限守卫：无该菜单码的页面回退到第一个可用菜单（避免与默认重定向互相跳转成环）
  const menu = to.meta.menu as string | undefined
  if (to.path !== '/login' && menu && !hasMenu(menu)) {
    return { path: firstAllowedPath() }
  }
  return true
})

export default router
