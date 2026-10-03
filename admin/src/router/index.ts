// 路由：登录页 + 后台布局（排名洞察 / 题库维护 / 组织架构），带登录守卫
import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { isLoggedIn } from '../store/auth'

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
    meta: { title: '数据大屏' }
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
        meta: { title: '驾驶舱' }
      },
      {
        path: 'rankings',
        name: 'rankings',
        component: () => import('../pages/RankingsView.vue'),
        meta: { title: '排名洞察' }
      },
      {
        path: 'route-nodes',
        name: 'route-nodes',
        component: () => import('../views/RouteNodesView.vue'),
        meta: { title: '路线点位' }
      },
      {
        path: 'questions',
        name: 'questions',
        component: () => import('../views/QuestionsView.vue'),
        meta: { title: '题库维护' }
      },
      {
        path: 'quotes',
        name: 'quotes',
        component: () => import('../views/QuotesView.vue'),
        meta: { title: '每日寄语' }
      },
      {
        path: 'orgs',
        name: 'orgs',
        component: () => import('../views/OrgsView.vue'),
        meta: { title: '组织架构' }
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
    return { path: '/' }
  }
  return true
})

export default router
