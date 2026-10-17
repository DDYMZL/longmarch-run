# ScreenView.vue

## 1. 文件路径

`admin/src/views/ScreenView.vue`（172 行）

## 2. 文件职责

「数据大屏」页（`<script setup>` 单文件组件）：面向投屏/展示场景的深色全屏页面，注册在 AdminLayout **之外**的顶级路由 `/screen`（`admin/src/router/index.ts:21-26`），无侧边栏与顶栏。单个聚合接口 `fetchScreen()` 一次取回核心指标、路线总览、近 7 日趋势与最近 20 条动态，全部图表用**纯 CSS 柱状条**实现（不用 ECharts，`.qoder/REQUIREMENTS.md` §11.5「ScreenView」行），并订阅 WebSocket 实时刷新。是三个实时页（Dashboard/Screen/Rankings）中唯一走「单接口聚合」的一页，纯只读，无任何写操作。

## 3. 业务需求

- 需求出处：`.qoder/REQUIREMENTS.md` §11.5「其它管理页」`ScreenView` 行（「数据大屏：纯 CSS 柱状图（不用 ECharts）+ 单个 `fetchScreen` 聚合接口，使用 `useLiveUpdates`」）；实时推送架构见 `.qoder/ARCHITECTURE.md` §6.4。
- 与驾驶舱的分工：同一份后端聚合（`dashboard_service.get_screen` 内部直接复用 `get_dashboard` + `get_trend(db, 7)` + `get_activities(db, 20)`，`backend/app/services/dashboard_service.py:156-164`），大屏是驾驶舱数据的免交互展示版，适合挂墙投屏；驾驶舱（`views/DashboardView.vue`）提供 7/30 天切换与 ECharts 交互。
- 演进（`git log --follow`，共 2 个提交）：
  - `01ec93c`（2026-10-02）创建本页（+180 行），同批创建 `DashboardView.vue` 与 `utils/liveUpdates.ts`；
  - `30b4458`（2026-10-11）代码审查修复：WS 防抖收口进 `useLiveUpdates` 回调对象、格式化工具改从 `utils/format` 导入（+6/-14）。

## 4. 核心功能

### 4.1 路由与权限码

- 路由：path `/screen`、name `screen`、`meta.menu = 'screen'`，**顶级路由**（不在 `/` → AdminLayout 的 children 内，`router/index.ts:21-26`），因此整页脱离后台框架全屏渲染。侧边栏仍有「数据大屏」+ `Monitor` 图标入口（`admin/src/router/menus.ts:5`，`MENUS` 第 2 项），点击即跳出布局进入本页。
- 前端守卫：与其它页共用 `router/index.ts:112-116` 的 `meta.menu` 拦截，无 `screen` 码回退 `firstAllowedPath()`。
- 后端守卫：`GET /api/admin/screen` 挂 `Depends(require_menu("screen"))`（`backend/app/api/routes/admin.py:237`）→ `dashboard_service.get_screen`（`admin.py:239-240`）。注意菜单码 `screen` 与 `dashboard` 是两个独立权限，驾驶舱接口不会因有 `screen` 而放行。
- 退出：头部「退出大屏」文字按钮 `router.push('/dashboard')`（`:58`）——若当前管理员无 `dashboard` 码，由路由守卫再回退到其第一个可用菜单（不会死循环，`router/index.ts:108-116` 注释即防环设计）。

### 4.2 状态与单接口加载

- 状态（`:9-15`）：`loading`、`state`（`ScreenResult`，初始为全 0 指标 + 三个空数组，避免首帧模板取值报错）。
- `load`（`:17-20`）：`fetchScreen()` → 整体替换 `state`，`try…finally` 控制 loading，**无 catch、无竞态守卫**（§9 第 1、2 项）。触发点：`onMounted(load)`（`:46`）与 WS `data_changed`（`:23`）。
- `metricCards`（`:29-40`）：7 张指标卡（参与人数/今日运动人数/总步数/人均步数/完赛率%/答题人数/勋章发放），emoji 图标，**不依赖 `main.ts` 图标注册**；模板 `:key="card.label"`（`:64`）。
- `maxSteps`（`:41`）/`maxTarget`（`:42`）：趋势条与路线条的相对刻度分母，`Math.max(..., 1)` 兜底防除零。
- `barWidth`（`:44`）：趋势条宽度百分比，下限 2% 保证 0 值也可见。

### 4.3 实时推送（WebSocket）订阅生命周期

- `useLiveUpdates`（`:22-27`）：`onDataChanged: load`——任何数据变更广播都在 800ms 合并窗口后整页重拉（`liveUpdates.ts:22`、`:35-39`）；`onActivity`——新动态以展开语法插入 `state.activities` 顶部并 `slice(0, 20)`（`:25`，与后端 `get_screen` 返回 20 条的口径一致，`dashboard_service.py:163`），推送行 id 为 composable 内递减负数（`liveUpdates.ts:23-24`、`:42`）。
- 连接/重连/清理由 composable 托管：`onMounted(connect)`、`onBeforeUnmount(dispose)`（`liveUpdates.ts:104-105`），token 走 query（`:62`），断线指数退避 3s→15s（`:84-92`）。本页**无自建定时器**，卸载无泄漏。
- 状态展示：头部左侧圆点 `.ws-dot`（online 绿/connecting 金/offline 红，`:53`、`:132-135`）+ 文案「实时已连接 / 连接中… / 已离线」（`:54`，内联三元，与 Dashboard 的 `wsText` computed 写法不同但语义一致）。
- 生产环境 WS 不可用属部署层已知阻塞（nginx 缺 Upgrade 头、微信侧无 socket 合法域名）：见 `.qoder/ARCHITECTURE.md` §12.3 与 `.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1、2 项；届时大屏静止于最后一次成功加载的数据，不在本页重复维护该事实。

### 4.4 模板结构（纯 CSS 图表）与加载/空/错误态

- 头部（`:51-60`）：WS 状态（左）、标题「⭐ 长征步迹 · 数据大屏」（中，`:56`）、「退出大屏」按钮（右）。
- **加载遮罩条件**：`v-loading="loading && !state.metrics.total_users"`（`:62`）——仅首次（尚无数据）时显示整屏 loading，WS 静默刷新期间不闪遮罩，适合投屏；副作用是「全员总数恰为 0」时每次刷新都会出现遮罩（§9 第 4 项）。
- 指标条（`:63-69`）：7 列 grid（`:137`），≤1200px 降为 4 列（`:167`）。
- 路线总览面板（`:73-89`）：每节点一行——名称 + 「N 人抵达 · x%」（`:79`）；双层 CSS 条：`.route-bar-target` 宽度 = 目标步数相对 `maxTarget`（`:82`，展示节点门槛比例），`.route-bar-fill` 宽度 = `completion_rate`（`:83`，红→金渐变 + 0.6s 过渡 `:153`）；下方「目标 N 步」（`:85`）。空态 `el-empty`「暂无启用节点」（`:87`）。
- 趋势面板（`:91-100`）：固定近 7 日（后端 `get_trend(db, 7)`，`dashboard_service.py:162`，**无天数切换**），每日一行：步数值 + CSS 横条（`barWidth`）+ 「MM-DD · N人 · +N节点」（`:97`，`p.date.slice(5)`）。**无空态**（§9 第 3 项）。
- 动态面板（`:103-112`）：右列，`max-height 640px` 内滚动（`:161-162`），每条为 `formatTime(event_time)` + `text`（`:107-108`）；空态 `el-empty`「暂无动态」（`:110`）。
- 错误态：`load` 无 catch，失败依赖 `api/request.ts:46-48` 全局 toast，大屏保留旧数据（§9 第 2 项）。
- 深色主题（`:119-127`）：暗红/鎏金径向渐变背景，与 `admin/agents.md`「长征红与鎏金强调色」的视觉语言一致；窄屏降级见 `:166-171`（主区单列、标题缩小）。

### 4.5 与另两实时页的关系

- 与 `views/DashboardView.vue`：同数据源（`dashboard_service`），大屏=单接口 + CSS 图 + 固定 7 天 + 整页替换刷新；驾驶舱=3 接口 + ECharts + 7/30 切换 + 分面板刷新（含 `trendSeq` 守卫）。修改指标口径时两页与后端聚合需同步核对。
- 与 `pages/RankingsView.vue`：同用 `useLiveUpdates`；本页与 Dashboard 消费 `onActivity` 增量事件，Rankings 只订阅 `onDataChanged`。
- 不引用 `admin/src/components/` 下任何公共组件；Element Plus 仅用 `el-button`/`el-empty` + `v-loading`（均由 `plugins/element-plus.ts` 注册）。

## 5. 输入与输出

- 输入：无 props / 无 emits。隐式输入为 localStorage 登录态（HTTP Bearer 与 WS token query）与 WS 推送消息。
- API：`fetchScreen`（`admin/src/api/admin.ts:786-787`）→ GET `/api/admin/screen` → `ScreenResult`（`admin.ts:194-199`）：`metrics: DashboardMetrics`（7 指标，同驾驶舱）、`route_overview: RouteOverviewItem[]`（字段 `admin.ts:155-160`：node_id/name/target_steps/lit_count/completion_rate）、`trend: TrendPoint[]`（`:167-173`）、`activities: ActivityItem[]`（`:180-188`）。
- 后端链路：`admin.py:233-240`（`require_menu("screen")`）→ `dashboard_service.get_screen`（`dashboard_service.py:156-164`）= `get_dashboard`（`:49`）+ `get_trend(db,7)`（`:103`）+ `get_activities(db,20)`（`:140-153`，`user_event` 表倒序关联昵称）。响应模型 `AdminScreenOut`（`admin.py:235`）。
- WS 消息：`{type:'data_changed'}` / `{type:'activity',…}`（`liveUpdates.ts:7-14`、`:34-50`）。
- 输出：无返回值，仅渲染；无写操作。
- 加载态：条件式整屏 `v-loading`（`:62`）；空态：路线/动态两处 `el-empty`（`:87`、`:110`），趋势无；错误态：无局部处理。

## 6. 依赖关系

- 导入：`vue`（computed/onMounted/ref，`:2`）、`vue-router`（`useRouter`，`:3`）、`../api/admin`（`fetchScreen` + `ScreenResult`，`:4`）、`../utils/liveUpdates`（`:5`）、`../utils/format`（`formatNumber`/`formatTime`，`:6`）。
- 被依赖：`admin/src/router/index.ts:24`（`/screen` 懒加载）。
- 后端数据源：与驾驶舱完全同源（`dashboard_service`，涉及表见 `.qoder/backend/app/services/dashboard_service.py.md`）；动态读 `user_event`（经 `event_service.recent_events`）。WS 端见 `.qoder/backend/app/api/routes/ws.py.md`。
- 关联页面：`views/DashboardView.vue`（数据同源、交互版）、`pages/RankingsView.vue`（同 composable）、侧边栏入口在 `layout/AdminLayout.vue`（本页自身不含布局）。
- 工具文档：`.qoder/admin/src/utils/liveUpdates.ts.md`、`.qoder/admin/src/utils/format.ts.md`、`.qoder/admin/src/api/admin.ts.md`。

## 7. 业务规则

1. **权限**：进入需 `screen` 菜单码；后端 `require_menu("screen")` 独立于 `dashboard`（§4.1）。无权限直连 URL 会被前端守卫弹回，绕过前端则后端 403。
2. **单接口聚合**：一屏数据只发一个 `GET /admin/screen`，刷新即整体替换 `state`（`:19`）——大屏场景优先保证「一帧数据内部一致」，不做分面板局部刷新。
3. **趋势固定近 7 日、动态固定最近 20 条**：由后端聚合写死（`dashboard_service.py:162-163`），前端无切换控件；改口径须动后端。
4. **时区口径**：后端 UTC naive → `parseUtc` 补 `Z` → 浏览器本地时区展示（`utils/format.ts:2`、`:29-31`）；动态时间为 MM/DD HH:mm（`formatTime`）。
5. **两类条宽度语义不同**：路线面板的暗色底条是「目标步数相对最大目标」的刻度（`:82`），渐变填充条才是达成率（`:83`）；趋势条是「当日步数相对 7 日最大值」（`:44`、`:96`），均为相对刻度，无数值坐标轴。
6. **WS 刷新节奏**：`data_changed` 800ms 合并防抖（composable 内），高频步数同步不会打爆聚合接口；`activity` 事件即时插顶。
7. **只读**：无任何写接口；大屏不做管理操作，退出即回驾驶舱（`:58`）。

## 8. 修改约束

- **保持纯 CSS 图表**：`.qoder/REQUIREMENTS.md` §11.5 明确本页不用 ECharts——这是与驾驶舱的刻意分工（大屏零图表库依赖、渲染轻量）；引入 ECharts 前须先改需求文档并说明理由。
- **保持单接口聚合**：不得把本页拆成多接口分面板刷新（会破坏「一帧一致」并加重高频刷新负担）；新增展示字段应扩展后端 `get_screen`/`AdminScreenOut` 并同步 `ScreenResult` 类型（`admin.ts:194-199`），前后端契约三处同改（route/service/schema，根 `agents.md` §2 与 `.qoder/README.md` §3.6）。
- `v-loading` 的「仅首次加载」条件（`:62`）是投屏防闪烁设计，改成无条件 `loading` 会让每次 WS 刷新整屏白闪。
- `activities` 插顶必须保持 `slice(0, 20)`（`:25`），否则长时间挂墙会无限增长（大数据量性能，根 `agents.md` §2.4）。
- 格式化继续走 `utils/format.ts`（`:6`），不得回退页内私有实现（`30b4458` 收敛点）。
- 深色主题色值（红 `#c8102e`/金 `#d4a017` 渐变，`:153`、`:159`）与驾驶舱图表配色同源，调整视觉时两页一起改（`admin/agents.md`「开发约定」第 3 条）。
- 顶级路由位置不可挪进 AdminLayout children：挪入会给大屏套上侧边栏，破坏投屏形态（`router/index.ts:21-26`）。
- 生产 WS 不可用是部署层问题（`.qoder/ARCHITECTURE.md` §12.3），不要在本页内绕过。

## 9. 当前实现状态

- **已实现**：单接口聚合大屏（7 指标卡、路线总览双层 CSS 条、近 7 日趋势条、最近 20 条动态）、WS 实时刷新与状态圆点、退出大屏、深色主题与 ≤1200px 窄屏降级；浏览器验收见 §10（`01ec93c` 的 s6 报告、`30b4458` 的 s16 报告含 `s16-01-screen-live.png` 实时推送截图）。
- **存在问题 / 已知事项**：
  1. **无竞态守卫**：`load`（`:17-20`）无 seq 守卫，手动进页加载与 WS 防抖刷新并发时，慢的旧响应可能后到并覆盖新数据（单接口幂等读，影响小但存在；对比 `DashboardView.vue:47-60` 的 `trendSeq`、`RankingsView.vue:29-46` 的 `requestSeq`）。
  2. **无 `catch`**：`load` 为 `try…finally`，`onMounted(load)`（`:46`）未 `.catch()`——失败产生未处理 Promise rejection（用户见 `request.ts:46-48` 全局 toast），大屏静默保留旧数据且无任何「数据可能过期」提示；投屏场景下无人值守时尤其难察觉（三实时页同模式）。
  3. **趋势面板无空态**：`state.trend` 为空时只剩标题（`:91-100`），不像路线/动态有 `el-empty`（`:87`、`:110`）。
  4. `v-loading` 条件依赖 `total_users`（`:62`）：全员总数为 0 的空库阶段，每次 WS 刷新都会闪整屏遮罩；有数据后则永不显示加载态（设计取舍，见 §8）。
  5. 「退出大屏」固定跳 `/dashboard`（`:58`）：无 `dashboard` 码的管理员会被守卫再弹到 `firstAllowedPath()`，多一跳；`screen`/`dashboard` 权限通常成对授予，实际影响小。
  6. 生产环境 WS 不可用（`.qoder/ARCHITECTURE.md` §12.3、`.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1、2 项）——大屏在生产实际不会自动刷新；本地开发不受影响。
  7. no-token 分支置 `offline` 后不再重试（`liveUpdates.ts:56-59`）：登录态过期时头部文案停在「已离线」且不再重连，需人工刷新页面（composable 层共性问题）。
- **待开发**：无本页专属待办。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/views/ScreenView.vue`，共 **2 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复（本页涉及：实时推送防抖收口与统一格式化）。
- 修改内容（涉本文件）：+6/-14 行（`git show --numstat` 实测）——① `formatNumber`/`formatTime` 改从 `utils/format` 导入（原先从 `utils/liveUpdates` 转口，`:5-6`）；② 删除页内自建 `scheduleReload` 800ms 防抖，`useLiveUpdates` 改为 `{onDataChanged: load, onActivity}` 回调对象，动态行不再页内手拼 `ActivityItem`（id/时间戳改由 composable 统一生成，`:22-27`）；③ 移除对应的本地 `reloadTimer` 清理逻辑。
- 关联文件：`admin/src/utils/liveUpdates.ts`、`admin/src/utils/format.ts`（新建）、`admin/src/views/DashboardView.vue`、`admin/src/pages/RankingsView.vue` 等；验收报告 `admin/test/docs/s16-admin-review-fixes-report.md`（含 `s16-01-screen-live.png`）。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-02（`01ec93c`）
- 需求：新增驾驶舱与数据大屏页面（同批扩展路线点位/题库表单内容字段）。
- 修改内容（涉本文件）：创建本文件（+180 行）——顶级路由全屏深色大屏初版：单接口 `fetchScreen` 聚合、纯 CSS 路线/趋势条、WS 实时刷新（初版为页内自建防抖 + 手拼动态行，后被 `30b4458` 收口）。
- 关联文件：`admin/src/views/DashboardView.vue`（新建）、`admin/src/utils/liveUpdates.ts`（新建）、`admin/src/api/admin.ts`（`fetchScreen`/`ScreenResult`）、`admin/src/router/index.ts`（`/screen` 顶级路由）、`admin/src/layout/AdminLayout.vue`（菜单入口）、后端 `dashboard_service.get_screen`；报告 `admin/test/docs/s6-admin-cockpit-screen-report.md`。
- 测试结果：见 `docs/迭代记录.md` 的 `01ec93c` 条目。
