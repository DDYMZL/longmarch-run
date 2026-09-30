// 路由：登录页 + 后台布局（题库维护 / 组织架构），带登录守卫
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
    path: '/',
    component: () => import('../layout/AdminLayout.vue'),
    redirect: '/questions',
    children: [
      {
        path: 'questions',
        name: 'questions',
        component: () => import('../views/QuestionsView.vue'),
        meta: { title: '题库维护' }
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
