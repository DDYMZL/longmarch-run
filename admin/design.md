# design.md · 长征管理后台（Vue 3 + Element Plus）设计文档

本文档描述本目录（admin）的**模块架构设计、页面清单与关键数据流**，是管理端迭代的技术基线。规则与约定另见 `agents.md`。

## 1. 设计目标

- 「长征运动挑战」PC 管理后台：驾驶舱、数据大屏、排名洞察、路线点位、题库维护、组织架构；
- 对接 `../backend`（FastAPI）`/api/admin/*` 管理端接口，契约字段为 **snake_case**（与小程序 camelCase 不同）；
- 数据变更通过 WebSocket 实时推送（`data_changed` / `activity`），页面自动刷新。

## 2. 技术栈与结构

| 组件 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5 + TypeScript + Vite 6 | `<script setup>` 组合式 API |
| UI | Element Plus 2.9 | 图标全量全局注册（`main.ts`） |
| 图表 | ECharts | 驾驶舱运动趋势图 |
| HTTP | axios | `src/api/request.ts` 统一注入管理员 Bearer Token |
| 状态 | 无 Pinia | 登录态存 localStorage（`lm_admin_token` / `lm_admin_username`，`src/store/auth.ts`） |

```
src/
├── api/
│   ├── request.ts        # axios 实例：baseURL /api，注入 token，401 跳登录
│   └── admin.ts          # 全部管理端接口封装 + 类型（与后端 Admin* 模型一一对应）
├── store/auth.ts         # 登录态读写（localStorage）
├── router/index.ts       # 路由 + 登录守卫；/login 与 /screen 为顶层全屏路由，其余走布局子路由
├── layout/AdminLayout.vue # 深色侧边导航 + 顶栏 + <router-view>
├── utils/liveUpdates.ts  # useLiveUpdates 组合式函数（WS 连接/指数退避重连）+ formatTime/formatNumber
└── views/ + pages/       # 各业务页面
```

## 3. 页面清单

| 路由 | 页面 | 职责 |
| --- | --- | --- |
| `/login` | `views/LoginView.vue` | 管理员登录（顶层全屏） |
| `/dashboard` | `views/DashboardView.vue` | 驾驶舱：7 项核心指标卡、ECharts 运动趋势（7/30 天切换）、WS 实时动态流、长征路线总览表 |
| `/screen` | `views/ScreenView.vue` | 数据大屏（顶层深色全屏）：`fetchScreen` 单接口聚合 + WS 实时刷新；指标条/路线进度/7 日趋势/实时动态 |
| `/rankings` | `pages/RankingsView.vue` | 排名洞察：全员总榜、组织/改名筛选、CSV 导出（防公式注入）、人员详情抽屉 |
| `/route-nodes` | `views/RouteNodesView.vue` | 路线点位 CRUD 与启停；表单含历史事件卡内容字段（简介/意义/人物/地点/关键词/图片列表/音频） |
| `/questions` | `views/QuestionsView.vue` | 题库 CRUD；知识分类（event 历史事件/route 长征路线/figure 历史人物）下拉、分类列与筛选 |
| `/orgs` | `views/OrgsView.vue` | 组织架构树 CRUD 与外部同步 |

> 根路径 `/` 重定向到 `/dashboard`。驾驶舱与大屏为**整体口径**，按产品决策不含组织维度统计。

## 4. 关键数据流

### 4.1 鉴权

```
登录页 → POST /api/admin/login {username, password} → {token, username}
  → localStorage → request.ts 拦截器注入 Authorization: Bearer <token>
  → 401 时清理登录态并回 /login；路由守卫对未登录访问统一重定向
```

### 4.2 实时刷新（useLiveUpdates）

```
WS /api/ws/updates?token=<admin token>
  ├─ message {type: 'data_changed'} → 800ms 防抖重新拉取当前页数据
  ├─ message {type: 'activity'}     → 驾驶舱/大屏实时动态流 prepend（截断 20 条）
  └─ onclose → 指数退避重连（3s → ×2 → 上限 15s），页面卸载时 dispose
```

`RankingsView` 内嵌同款 WS 逻辑（早于 composable 抽取），新页面统一用 `useLiveUpdates`。

### 4.3 时间约定

后端返回 naive ISO 时间串视为 **UTC**；`formatTime` 在无时区后缀时补 `Z` 再按 zh-CN 本地时区格式化（与小程序 `util.formatTime` 同约定）。

## 5. 关键设计决策

1. **无状态库**：登录态是唯一全局状态，localStorage 足矣，不引 Pinia。
2. **大屏单接口聚合**：`/admin/screen` 一次返回指标 + 路线总览 + 7 日趋势 + 动态，减少大屏首屏请求数；后续变更靠 WS 推送触发整页防抖重拉。
3. **composable 复用**：WS 连接/重连逻辑抽为 `useLiveUpdates`，驾驶舱与大屏共享，避免重复实现。
