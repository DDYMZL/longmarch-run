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
├── router/index.ts       # 路由 + 登录守卫 + 菜单权限守卫；/login 与 /screen 为顶层全屏路由，其余走布局子路由
├── router/menus.ts       # 菜单单一来源（code/path/title/icon，与 010_admin_identity.sql 种子一致），侧边栏/守卫/角色勾选共用
├── layout/AdminLayout.vue # 深色侧边导航 + 顶栏 + <router-view>
├── utils/liveUpdates.ts  # useLiveUpdates 组合式函数（WS 连接/指数退避重连/data_changed 800ms 防抖）
├── utils/format.ts       # formatTime/formatDateTime/formatNumber（模块级复用 Intl 格式化器）
├── components/ExcelImportDialog.vue # 通用 Excel 导入弹窗（模板下载/上传校验/错误明细与 CSV 报告/令牌确认），题库与寄语共用
└── views/ + pages/       # 各业务页面
```

## 3. 页面清单

| 路由 | 页面 | 职责 |
| --- | --- | --- |
| `/login` | `views/LoginView.vue` | 管理员登录（顶层全屏） |
| `/dashboard` | `views/DashboardView.vue` | 驾驶舱：7 项核心指标卡、ECharts 运动趋势（7/30 天切换）、WS 实时动态流、长征路线总览表 |
| `/screen` | `views/ScreenView.vue` | 数据大屏（顶层深色全屏）：`fetchScreen` 单接口聚合 + WS 实时刷新；指标条/路线进度/7 日趋势/实时动态 |
| `/rankings` | `pages/RankingsView.vue` | 排名洞察：全员总榜，服务端分页；关键字（300ms 防抖）、组织、改名三项筛选；请求序号防止乱序；CSV 由后端按筛选流式导出（防公式注入）；人员详情抽屉 |
| `/route-nodes` | `views/RouteNodesView.vue` | 路线点位 CRUD 与启停；表单含历史事件卡内容字段（简介/意义/人物/地点/关键词/图片列表/音频） |
| `/questions` | `views/QuestionsView.vue` | 题库 CRUD；知识分类（event 历史事件/route 长征路线/figure 历史人物）下拉、分类列与筛选；Excel 模板下载与批量导入；复制导入（粘贴「题干 / A. B. C. D.（可分行或同一行，点号和空格可省略）/ 【答案】或答案： / 【解析】」，单次最多 500 道，预览分页后一次入库，默认每题 20 分，导入成功后再统一改分值） |
| `/quotes` | `views/QuotesView.vue` | 每日寄语 CRUD：排序号/启用开关（行内切换）/出处/关联节点；循环起始日期设置与今日展示标记（启用寄语按排序号每天轮换一条）；Excel 模板下载与批量导入 |
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
  ├─ message {type: 'data_changed'} → composable 内 800ms 防抖后回调 onDataChanged（页面只传重载函数）
  ├─ message {type: 'activity'}     → 转为 ActivityItem 回调 onActivity，驾驶舱/大屏 prepend（截断 20 条）
  └─ onclose → 指数退避重连（3s → ×2 → 上限 15s），页面卸载时 dispose（同时清理防抖定时器）
```

驾驶舱、大屏、排名洞察统一使用 `useLiveUpdates`，页面不再各自维护防抖定时器。

### 4.3 时间约定

后端返回 naive ISO 时间串视为 **UTC**；`utils/format.ts` 在无时区后缀时补 `Z` 再按 zh-CN 本地时区格式化（与小程序 `util.formatTime` 同约定）；审计日志按日期筛选时后端把本地日期换算为 UTC 区间。

### 4.4 列表加载约定

分页/筛选列表（题库、寄语、人员授权、组织成员、排名）使用请求序号守卫，只采纳最后一次请求的结果；关键字搜索走服务端并防抖（LIKE 通配符由后端转义）；筛选变化重置页码与翻页合并为一次请求。

## 5. 关键设计决策

1. **无状态库**：登录态是唯一全局状态，localStorage 足矣，不引 Pinia。
2. **大屏单接口聚合**：`/admin/screen` 一次返回指标 + 路线总览 + 7 日趋势 + 动态，减少大屏首屏请求数；后续变更靠 WS 推送触发整页防抖重拉。
3. **composable 复用**：WS 连接/重连逻辑抽为 `useLiveUpdates`，驾驶舱与大屏共享，避免重复实现。

## 6. 构建与打包

- `npm run build` = 类型检查 + `vite build` + 自动打包，产物为 `dist/` 与 `dist.zip`。
- `npm run zip` 仅重新打包（依赖已有 `dist/`），用于构建产物未变时快速出包。
- `scripts/zip-dist.mjs` 用 Node 内置 `zlib` 手写 Zip 结构（本地文件头 / 中央目录 / EOCD，CRC-32 校验），**零第三方依赖**且跨平台，规避环境无 `zip`/`7z` 可执行文件的问题；压缩后体积不减的资源自动按存储方式写入。Zip 内为 `dist` 的**内容**（`index.html`、`assets/...` 位于压缩包根目录），可直接解压部署。
- `dist.zip` 属构建产物，已在根 `.gitignore` 忽略。
