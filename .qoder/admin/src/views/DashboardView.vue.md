# DashboardView.vue

## 1. 文件路径

`admin/src/views/DashboardView.vue`（390 行）

## 2. 文件职责

「驾驶舱」页（`<script setup>` 单文件组件），管理后台登录后的默认首页（`/` 重定向到 `/dashboard`，`admin/src/router/index.ts:30`）：一屏聚合①7 张核心指标卡、②近 7/30 天运动趋势 ECharts 双轴图（柱=总步数，线=运动人数/新点亮/新增用户）、③最近 20 条实时动态列表、④长征路线总览表（各节点目标步数、相对进度、达成人数与达成率）。是三个订阅 WebSocket 实时推送的页面之一（另两页为 `views/ScreenView.vue`、`pages/RankingsView.vue`，`.qoder/ARCHITECTURE.md` §6.4）；纯只读展示，无任何写操作入口。文件头注释（`:2-3`）明确：组织维度统计已按需求取消（2026-10-01 决策），本页只做整体指标。

## 3. 业务需求

- 需求出处：`.qoder/REQUIREMENTS.md` §11.5「其它管理页」`DashboardView` 行（「驾驶舱：7 张指标卡 + ECharts 双轴图（`trendSeq`），使用 `useLiveUpdates`」）；「组织排名 / 分组织积分对比」已废弃见 `.qoder/REQUIREMENTS.md` §12 同名行（对应本文件 `:2-3` 注释的取消决策）。
- 实时推送链路（后端 `/api/ws/updates` 广播 `data_changed`/`activity` → 前端防抖刷新）见 `.qoder/ARCHITECTURE.md` §6.4 与 `.qoder/admin/src/utils/liveUpdates.ts.md`。
- 演进（`git log --follow`，共 3 个提交）：
  - `01ec93c`（2026-10-02）创建本页（+397 行），同批创建 `ScreenView.vue` 与 `utils/liveUpdates.ts`；
  - `4e453a4`（2026-10-02）ECharts 由全量 `import * as echarts from 'echarts'` 改为按需注册（本文件 +8/-2，注释称约省 1MB 打包体积，`:5`）；
  - `30b4458`（2026-10-11）代码审查修复：WS 防抖收口进 `useLiveUpdates`、`formatNumber`/`formatTime` 改从 `utils/format` 导入、`loadTrend` 加 `trendSeq` 竞态守卫（+16/-29）。

## 4. 核心功能

### 4.1 路由与权限码

- 路由：path `/dashboard`、name `dashboard`、`meta.menu = 'dashboard'`，作为 AdminLayout 的子路由懒加载本文件（`admin/src/router/index.ts:32-37`）；`/` 重定向到本页（`:30`）。侧边栏条目「驾驶舱」+ `Odometer` 图标（`admin/src/router/menus.ts:4`，`MENUS` 数组第 1 项，即无权限回退 `firstAllowedPath()` 的最高优先级）。
- 前端守卫：`router/index.ts:112-116` 按 `meta.menu` 拦截，无 `dashboard` 码回退第一个可用菜单；侧边栏过滤见 `layout/AdminLayout.vue:15`。
- 后端守卫：本页调用的 3 个接口全部挂 `Depends(require_menu("dashboard"))`——`GET /api/admin/dashboard`（`backend/app/api/routes/admin.py:203`）、`GET /api/admin/dashboard/trend`（`:213`）、`GET /api/admin/activities`（`:225`）。前端隐藏不是安全边界。

### 4.2 状态与数据加载

- 状态（`:23-28`）：`loading`（整页遮罩）、`trendLoading`（趋势图局部遮罩）、`days`（`7 | 30`，默认 7）、`dashboard`（`DashboardResult`，初始为全 0 指标 + 空 `route_overview`）、`trend`（`TrendResult`，初始 `{days:7, points:[]}`）、`activities`（`ActivityItem[]`）。
- `metricCards`（`:30-38`）：computed，把 7 个指标（参与总人数/今日运动人数/累计总步数/人均步数/路线完成率(%)/今日答题人数/勋章发放数）拼成卡片数组，图标为 emoji 字符串（👥🏃👟📊🏁📝🏅），**不依赖 `main.ts` 的 Element Plus 图标注册**。
- `maxTarget`（`:40`）：`Math.max(1, ...route_overview.map(target_steps))`，作为「步数进度」列的相对刻度分母（`1` 兜底防除零）。
- `loadDashboard`（`:42-44`）：`fetchDashboard()` → 写 `dashboard`。无 catch、无竞态守卫。
- `loadTrend`（`:49-60`）：`trendSeq` 竞态守卫（`:47` 注释「快速切换 7/30 天时只采纳最后一次请求」，`30b4458` 引入）——进入取 `seq = ++trendSeq`（`:50`），响应后 `seq !== trendSeq` 即丢弃（`:54`），`finally` 仅同序号才关 `trendLoading`（`:58`）；成功后 `renderChart()`（`:56`）。
- `loadActivities`（`:62-64`）：`fetchActivities(20)` 取最近 20 条动态（后端 `limit` 参数默认 50、上限 200，`admin.py:228`；本页固定传 20）。
- `load`（`:66-73`）：`Promise.all` 并发三个加载函数，`try…finally` 控制整页 loading，**无 catch**。触发点：`onMounted`（`:159-162`）与 WS `data_changed` 回调（`:141-144`）。
- `switchDays`（`:151-155`）：同值直接 return，否则改 `days` 并重拉趋势；由模板 `el-radio-group` 的 `@change` 调用（`:187`）。

### 4.3 趋势图（ECharts 按需引入）

- 按需注册（`:5-9`、`:21`）：仅 `BarChart`/`LineChart` + `Grid`/`Legend`/`Tooltip` 组件 + `CanvasRenderer`（`4e453a4` 改造点）。
- `chartEl`/`chart`（`:76-77`）：DOM ref + `shallowRef` 持有实例（浅响应避免 ECharts 内部对象被深度代理）。
- `renderChart`（`:79-133`）：懒初始化（`:81`），`setOption` 画双 Y 轴——左轴「步数」柱状（长征红 `#C8102E`，`:101`），右轴「人数/节点」三条平滑折线：运动人数（鎏金 `#D4A017`，`:110`）、新点亮（蓝 `#3B82F6`，`:119`）、新增用户（绿 `#10B981` 虚线，`:128`）；X 轴为 `p.date.slice(5)`（MM-DD，`:89`）。
- `resizeChart`（`:135-137`）：window `resize` 监听在 `onMounted` 挂（`:161`）、`onBeforeUnmount` 摘除并 `chart.dispose()`（`:163-166`），无监听器/实例泄漏。

### 4.4 实时推送（WebSocket）订阅生命周期

- `useLiveUpdates`（`:140-149`）：`onDataChanged` → 重拉 `loadDashboard()` + `loadTrend()`（**不重拉动态列表**，动态靠 `onActivity` 增量）；`onActivity` → 新事件插入 `activities` 顶部并 `slice(0, 20)`（`:147` 注释「无需整表刷新」）。
- 生命周期由 composable 托管：`onMounted(connect)` / `onBeforeUnmount(dispose)`（`admin/src/utils/liveUpdates.ts:104-105`），连接 `/api/ws/updates?token=…`（`:62`），`data_changed` 在 800ms 窗口内合并为一次回调（`RELOAD_DELAY`，`:22`、`:35-39`），断线指数退避重连 3s→15s（`:84-92`）。推送动态的 `id` 用递减负数避免与库内 id 冲突（`:23-24`、`:42`；`30b4458` 前本页用 `Date.now()` 自造 id，已收口）。
- `wsText`（`:157`）：`online`→「实时连接正常」/`connecting`→「实时连接中…」/其余→「实时连接断开，自动重连」，渲染为动态面板右上角徽标（`:199`，`.ws-badge.online` 绿色样式 `:342-345`）。
- **生产环境 WebSocket 不可用**（nginx 未配 Upgrade 头、微信侧无 socket 合法域名）属环境级已知阻塞，见 `.qoder/ARCHITECTURE.md` §12.3 与 `.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1、2 项；届时本页退化为「进页一次性加载」，不在本页重复维护该事实。

### 4.5 模板结构与加载/空/错误态

- 指标卡网格（`:172-180`）：`grid auto-fit minmax(180px,1fr)` 自适应列数（`:249-253`），值经 `formatNumber` 千分位（`:176`），完成率带 `%` 后缀（`:35`、`:176`）。
- 趋势面板（`:184-193`）：标题 + 7/30 天 `el-radio-group`（`:187-190`）+ 图表容器 `v-loading="trendLoading"`（`:192`，高 320px `:325-327`）。**趋势数据为空时无空态提示**，ECharts 渲染空坐标系。
- 动态面板（`:196-208`）：空态为自定义 `.empty-tip`「暂无动态」（`:201`）；列表项左侧 `text`、右侧 `formatTime(event_time)`（MM/DD HH:mm，`:205`、`utils/format.ts:33-36`）；`max-height:320px` 内滚动（`:347-351`）。
- 路线总览表（`:212-238`）：`el-table size="large"`，列为节点名（`.node-name` 加粗 `:218-222`）、目标步数（千分位 `:223-225`）、步数进度（**相对 `maxTarget` 的宽度**、`show-text=false`、红色 `:226-230`）、达成人数（`:231`）、达成率（后端算好的 `completion_rate` 直接进 `el-progress`、鎏金色 `:232-236`）。表头副标题注明「各节点达成人数（含未解锁的后续节点）」（`:215`）。**无自定义空态**（`route_overview` 为空时是 Element Plus 默认「暂无数据」）。
- 整页 `v-loading="loading"`（`:170`）。错误态：本页所有加载函数均无 `catch`，接口失败依赖 `api/request.ts:46-48` 全局 toast，面板保留上一次成功数据，并产生未处理的 Promise rejection（§9 第 1 项）。
- 窄屏：`panel-row`（趋势 2fr + 动态 1fr）在 ≤1100px 折为单列（`:288-298`），满足 `admin/agents.md`「开发约定」第 3 条的窄屏要求。

### 4.6 与公共组件、其它两实时页的关系

- 不引用 `admin/src/components/` 下任何公共组件；所用 Element Plus 组件（radio-group/radio-button/table/table-column/progress + v-loading 指令）均由 `plugins/element-plus.ts` 按需注册。
- 与 `views/ScreenView.vue` 共用同一后端聚合服务 `dashboard_service`（大屏是其单接口封装版，见 `.qoder/admin/src/views/ScreenView.vue.md`）；与 `pages/RankingsView.vue` 共用 `useLiveUpdates`，但本页额外消费 `onActivity` 增量事件（Rankings 只订阅 `onDataChanged`）。

## 5. 输入与输出

- 输入：无 props / 无 emits。隐式输入为 `store/auth` 的 localStorage 登录态（`api/request.ts` 注入 Bearer Token；WS 连接亦取 `getToken()`，`liveUpdates.ts:55-62`）、`days` 切换与 WS 推送消息。
- 调用的 `api/admin.ts` 函数与类型：

| 前端函数 | 方法与路径 | 类型 | 后端链路 |
|---|---|---|---|
| `fetchDashboard`（`admin.ts:774-775`） | GET `/api/admin/dashboard` | `DashboardResult`（`:162-165`，含 `metrics` + `route_overview: RouteOverviewItem[]`，后者字段见 `:155-160`） | `admin.py:199-206` → `dashboard_service.get_dashboard`（`dashboard_service.py:49`） |
| `fetchDashboardTrend`（`:778-779`） | GET `/api/admin/dashboard/trend?days=` | `TrendResult`（`:175-178`）/ `TrendPoint`（`:167-173`：date/total_steps/active_users/new_users/new_lit） | `admin.py:209-218`（`days` 校验 `ge=1, le=90`，`:216`）→ `dashboard_service.get_trend`（`:103`） |
| `fetchActivities`（`:782-783`） | GET `/api/admin/activities?limit=` | `ActivityListResult`（`:190-192`）/ `ActivityItem`（`:180-188`：id/event_type/event_time/user_id/nickname/text/data） | `admin.py:221-230`（`limit` 校验 `ge=1, le=200` 默认 50，`:228`）→ `dashboard_service.get_activities`（`:140-153`，`user_event` 倒序关联昵称） |

- WS 输入消息：`{type:'data_changed'}` 与 `{type:'activity', eventType, userId, nickname, text, at}`（`liveUpdates.ts:7-14`、`:34-50`）。
- 输出：无返回值，仅渲染；无写操作。
- 加载态：整页 `v-loading`（`:170`）+ 趋势局部 `v-loading`（`:192`）；空态：动态列表自定义「暂无动态」（`:201`），路线表/趋势图无自定义空态；错误态：无局部处理（§4.5）。

## 6. 依赖关系

- 导入：`vue`（computed/onBeforeUnmount/onMounted/ref/shallowRef，`:4`）、`echarts/core`+`echarts/charts`+`echarts/components`+`echarts/renderers`（`:6-9`）、`../api/admin`（3 函数 + 3 类型，`:10-17`）、`../utils/liveUpdates`（`:18`）、`../utils/format`（`formatNumber`/`formatTime`，`:19`）。
- 被依赖：`admin/src/router/index.ts:35`（`/dashboard` 懒加载）。
- 后端数据源：指标/路线总览/趋势由 `dashboard_service` 聚合（涉及表与 SQL 口径见 `.qoder/backend/app/services/dashboard_service.py.md`）；实时动态读 `user_event` 表（`dashboard_service.py:140-153` 经 `event_service.recent_events`）。WS 广播端见 `.qoder/backend/app/api/routes/ws.py.md` 与 `.qoder/backend/app/services/event_service.py.md`。
- 关联页面：`views/ScreenView.vue`（同数据的大屏版）、`pages/RankingsView.vue`（同用 `useLiveUpdates`）、`layout/AdminLayout.vue`（父布局与菜单过滤）。
- 工具文档：`.qoder/admin/src/utils/liveUpdates.ts.md`、`.qoder/admin/src/utils/format.ts.md`、`.qoder/admin/src/api/admin.ts.md`。

## 7. 业务规则

1. **权限**：进入需 `dashboard` 菜单码（超管恒真，`store/auth.ts:27-29`）；三个接口后端各自再校验 `require_menu("dashboard")`（§4.1）。
2. **只做整体指标**：组织维度统计已废弃（`:2-3` 注释；`.qoder/REQUIREMENTS.md` §12「组织排名 / 分组织积分对比」行），不得在本页恢复分组织对比。
3. **时区口径**：后端返回 UTC naive ISO，前端经 `parseUtc` 补 `Z` 按浏览器本地时区展示（`utils/format.ts:2`、`:29-31`）；动态时间用 `formatTime`（MM/DD HH:mm）。
4. **趋势天数**：前端只开放 7/30 两档（`:151-155`、`:187-190`）；后端允许 1–90（`admin.py:216`），前端超出档位属未开放能力而非违约。
5. **动态列表恒为最近 20 条**：初始拉取 `fetchActivities(20)`（`:63`），WS 增量插入后 `slice(0, 20)`（`:147`），不会无限增长。
6. **「步数进度」列是相对刻度**：宽度 = 该节点目标步数 / 全部节点最大目标步数（`:40`、`:228`），只用于横向对比节点门槛，**不是达成率**；达成率单独一列（`:232-236`）由后端 `completion_rate` 给出。
7. **竞态口径**：趋势请求只采纳最后一次（`trendSeq`，`:47-60`）；WS `data_changed` 800ms 合并防抖在 composable 内完成（`liveUpdates.ts:22`、`:35-39`），本页不再自建防抖（`30b4458` 收口）。
8. **只读**：本页无任何写接口调用，指标异常的修复入口在其它页（如排名页「积分核对」）。

## 8. 修改约束

- **实时推送防抖不得回退为页内自建**：`30b4458` 已把「800ms 合并刷新 + 断线重连 + 卸载清理」收口进 `useLiveUpdates`（`admin/src/utils/liveUpdates.ts:1-2` 注释即此约定），本页只传 `onDataChanged`/`onActivity` 回调；新增实时页也应复用该 composable（`.qoder/ARCHITECTURE.md` §6.4）。
- `trendSeq` 守卫的三处（自增 `:50`、判等丢弃 `:54`、`finally` 判等 `:58`）必须成对保留；给 `loadDashboard`/`loadActivities` 补守卫时按 `pages/RankingsView.vue:29-46` 的 `requestSeq` 模式，勿另造机制。
- 时间/数字格式化必须继续走 `utils/format.ts`（`formatTime`/`formatNumber`），不得再引入页面私有格式化（`30b4458` 已收敛，见 `.qoder/admin/src/utils/format.ts.md`）。
- ECharts 保持按需引入（`:5-9`、`:21`）：新增图表类型/组件须同步在 `echarts.use([...])` 注册，改回全量 `import 'echarts'` 会回退约 1MB 体积优化（`4e453a4`）；`chart` 必须保持 `shallowRef` 且卸载时 `dispose()`（`:77`、`:165`）。
- 指标卡图标是 emoji 文本（`:31-37`），若改为 Element Plus 图标组件，必须在 `main.ts` 全局注册（`main.ts:41` 注释「模板中实际用到的图标……按需全局注册」），否则渲染为空。
- 「步数进度」相对刻度与「达成率」两列语义不同（§7 第 6 条），改列时不得混用分母。
- 视觉：保持长征红 `#C8102E` / 鎏金 `#D4A017` 强调色（`:101`、`:110`、`:228`、`:234`，`admin/agents.md`「开发约定」第 3 条）；数据页需覆盖加载、空状态、筛选和窄屏可用性——本页空态目前不完整（§9 第 3 项），补强时勿删既有 `empty-tip`。
- 生产 WS 不可用是部署层问题（`.qoder/ARCHITECTURE.md` §12.3），不要试图在本页内加重连“修复”绕过。

## 9. 当前实现状态

- **已实现**：7 指标卡、7/30 天双轴趋势图（含 resize 与 dispose）、最近 20 条实时动态（WS 增量插顶）、路线总览表（相对进度 + 达成率）、WS 状态徽标、窄屏单列降级；浏览器验收见 §10（`01ec93c` 的 `admin/test/docs/s6-admin-cockpit-screen-report.md`、`30b4458` 的 s16 报告）。
- **已实现且符合规范**：趋势请求竞态守卫（`:47-60`）；防抖收口至共享 composable（`:140-149`）；格式化统一走 `utils/format`（`:19`）；ECharts/Element Plus 均按需引入（`:5-9`、`:21`）；定时器与事件监听在 `onBeforeUnmount` 全部清理（`:163-166` + `liveUpdates.ts:94-105`）。
- **存在问题 / 已知事项**：
  1. **竞态守卫覆盖不全**：仅 `loadTrend` 有 `trendSeq`（`:47-60`）；`loadDashboard`（`:42-44`）与 `loadActivities`（`:62-64`）无守卫，WS 防抖刷新与手动进页并发时理论上可被慢的旧响应覆盖（对比 `pages/RankingsView.vue:29-46` 全量守卫）。
  2. **全链路无 `catch`**：`load`/`loadDashboard`/`loadTrend`/`loadActivities` 均 `try…finally` 无 catch，`onMounted(load)`（`:160`）未 `.catch()`——接口失败产生未处理 Promise rejection（仅控制台噪声，用户见 `request.ts:46-48` 全局 toast），且各面板保留上一次成功数据，可能被误读为最新（与 `.qoder/admin/src/views/AuditView.vue.md` §9 第 6 项同模式）。
  3. **空态不完整**：路线总览表只有 Element Plus 默认「暂无数据」，趋势图 points 为空时渲染空坐标系无提示（`:192`）；仅动态列表有自定义空态（`:201`）。
  4. `Promise.all`（`:69`）任一请求失败即整批 reject：`loading` 会正常关闭（`finally`），但另外两个成功的结果照常写入——表现为“部分面板有数据、部分陈旧”，无失败面板级提示。
  5. 动态条数上限 20 硬编码两处（`:63` 拉取、`:147` 裁剪），调整需同改；后端 `limit` 支持到 200（`admin.py:228`）。
  6. 生产环境 WS 不可用（`.qoder/ARCHITECTURE.md` §12.3、`.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1、2 项）——本页“实时”能力在生产实际退化为进页一次性加载；本地开发（vite 代理）不受影响。
  7. `no-token` 分支置 `offline` 后不再重试（`liveUpdates.ts:56-59`）：登录态过期时本页 WS 徽标停留在「实时连接断开，自动重连」但实际不会重连，文案与行为不完全一致（属 composable 层问题，三实时页共有）。
- **待开发**：无本页专属待办。趋势天数档位如需扩展（后端已支持 1–90），属新需求，未见需求条目——是否需要**待确认**。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/views/DashboardView.vue`，共 **3 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复（本页涉及：实时推送防抖收口与统一格式化、请求竞态守卫）。
- 修改内容（涉本文件）：+16/-29 行（`git show --numstat` 实测）——① `formatNumber`/`formatTime` 改从 `utils/format` 导入（原先从 `utils/liveUpdates` 转口，`:18-19`）；② `loadTrend` 加 `trendSeq` 竞态守卫（`:47-60`）；③ 删除页内自建 `scheduleReload` 800ms 防抖，`useLiveUpdates` 改为 `{onDataChanged, onActivity}` 回调对象形态，动态 id 由 `Date.now()` 改为 composable 内递减负数（`:140-149`）；④ `onBeforeUnmount` 移除本地 `reloadTimer` 清理（防抖已入 composable）。
- 关联文件：`admin/src/utils/liveUpdates.ts`、`admin/src/utils/format.ts`（新建）、`admin/src/views/ScreenView.vue`、`admin/src/pages/RankingsView.vue` 等 8 个视图与后端 `admin.py`/`access_service.py`/`admin_service.py`；验收报告 `admin/test/docs/s16-admin-review-fixes-report.md`。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-02（`4e453a4`）
- 需求：打包体积优化——ECharts 与 Element Plus 改按需引入（同批给排名页加前端分页）。
- 修改内容（涉本文件）：+8/-2 行——`import * as echarts from 'echarts'` 改为 `echarts/core` + 按需注册 `BarChart`/`LineChart`/`Grid`/`Legend`/`Tooltip`/`CanvasRenderer`（`:5-9`、`:21`）；实例类型 `echarts.ECharts` 改 `echarts.EChartsType`（`:77`）。
- 关联文件：`admin/src/main.ts`、`admin/src/plugins/element-plus.ts`、`admin/src/pages/RankingsView.vue`；报告 `admin/test/docs/s7-ondemand-perf-report.md`（含本页截图 `s7-01-dashboard-echarts.png`）。
- 测试结果：见 `docs/迭代记录.md` 的 `4e453a4` 条目。

### 2026-10-02（`01ec93c`）
- 需求：新增驾驶舱与数据大屏页面（同批扩展路线点位/题库表单内容字段）。
- 修改内容（涉本文件）：创建本文件（+397 行）——指标卡 + 双轴趋势图 + 实时动态 + 路线总览的初版，含页内自建 800ms 防抖与 `Date.now()` 动态 id（后被 `30b4458` 收口）。
- 关联文件：`admin/src/views/ScreenView.vue`（新建）、`admin/src/utils/liveUpdates.ts`（新建）、`admin/src/api/admin.ts`、`admin/src/router/index.ts`、`admin/src/layout/AdminLayout.vue`、`admin/package.json`（引入 echarts）；报告 `admin/test/docs/s6-admin-cockpit-screen-report.md`。
- 测试结果：见 `docs/迭代记录.md` 的 `01ec93c` 条目。
