# liveUpdates.ts

## 1. 文件路径

`admin/src/utils/liveUpdates.ts`（108 行）

## 2. 文件职责

管理端 **WebSocket 实时刷新的组合式函数（composable）**：封装对后端 `/api/ws/updates` 的长连接（token query 鉴权、指数退避重连、连接状态 `wsStatus`），把两类广播消息——`data_changed`（数据变更，800ms 合并防抖后回调一次）与 `activity`（实时动态，转成 `ActivityItem` 直接上屏）——分发给页面传入的 handlers，并在组件卸载时自动清理连接与定时器（头注释 `:1-2`）。

## 3. 业务需求

- 驾驶舱/数据大屏/排名洞察需要「小程序侧任何用户写入（步数同步、答题、点亮节点等）后管理端自动刷新，无需轮询」——后端 `backend/app/api/routes/ws.py` 模块 docstring `:1-6` 即此需求；管理端消费侧即本文件。
- `01ec93c`（驾驶舱与大屏页面）创建本文件时注释自述「模式抽自 RankingsView」：排名页（`81b86e5`）最初内联实现了 WS + 退避重连，此处抽成 composable 供三页复用。
- `30b4458`（代码审查修复）解决三页各自维护 800ms 防抖定时器、且大屏定时器卸载不清理的缺陷：防抖与清理全部收进 composable（报告 `admin/test/docs/s16-admin-review-fixes-report.md` A1 项）。

## 4. 核心功能

### 4.1 消息类型与常量（`:7-24`）

- `LiveMessage`（`:7-14`，模块私有）：后端广播的 camelCase 载荷——`type` + 可选 `eventType`/`userId`/`nickname`/`text`/`at`。与后端构造函数字段逐一对应：`data_changed` 为 `{type, reason, user_id, at}`（`backend/app/core/ws.py:23-25`，本文件不读 `reason`/`user_id`），`activity` 为 `{type, eventType, userId, nickname, text, at}`（`ws.py:28-37`）。
- `LiveHandlers`（`:16-20`）：`onDataChanged?()`（同一窗口内多次广播合并为一次回调）与 `onActivity?(item)`。
- `RELOAD_DELAY = 800`（`:22`）：合并防抖窗口。
- `liveActivitySeq`（`:24`）：**模块级**递减负数序列，作推送动态的行 key（注释 `:23`：推送动态无库内 id，负数避免与 REST 拉取的真实 id 及同毫秒事件冲突；跨组件实例共享，全局唯一）。

### 4.2 `useLiveUpdates(handlers)`（`:26-108`）

返回 `{ wsStatus }`（`:107`），`wsStatus: Ref<'connecting' | 'online' | 'offline'>`（`:27`）供页面渲染连接状态角标。内部闭包持有 `socket`/`reconnectTimer`/`reloadTimer`/`reconnectDelay`（初始 3000ms）/`disposed`（`:28-32`）。

- **`handle(data)`（`:34-51`）消息分发**：
  - `data_changed` 且传了 `onDataChanged` 且 `reloadTimer === null` 时，安排 800ms 后回调一次（`:35-39`）——**窗口内后续广播被合并丢弃**（首事件触发式节流）；定时器触发后窗口重开。
  - `activity` 且 `text` 非空且传了 `onActivity` 时，转成 `ActivityItem`（`:40-50`）：`id` 取 `--liveActivitySeq`（负数）、`event_type`/`event_time`（`at` 缺失时兜底 `new Date().toISOString()`）/`user_id`/`nickname` 逐字段映射、`data` 置空对象。类型即 `.qoder/admin/src/api/admin.ts.md` 中 REST `fetchActivities` 同一 `ActivityItem`（`admin/src/api/admin.ts:180-188`），故推送项可与 REST 初始列表混排。
- **`connect()`（`:53-82`）建连**：`disposed` 后不再连（`:54`）；`getToken()`（`admin/src/store/auth.ts:7-9`，localStorage 键 `lm_admin_token`）为空则置 `offline` 并**直接返回、不安排重试**（`:55-59`）；按页面协议选 `ws/wss`，连 `${location.host}/api/ws/updates?token=<encodeURIComponent(token)>`（`:61-62`，浏览器原生 WebSocket 无法带请求头，故 token 走 query——与后端 `ws.py:22` 的 `Query` 参数对应）；`onopen` 置 `online` 并复位退避 3000ms（`:64-67`）；`onmessage` JSON 解析失败（心跳等非 JSON）静默忽略（`:68-76`）；`onclose` 清 `socket` 并在未 dispose 时进入重连（`:77-80`）；`onerror` 主动 `close()` 转入重连路径（`:81`）。
- **`scheduleReconnect()`（`:84-92`）指数退避重连**：置 `offline`，`reconnectDelay` 后重试；退避 3000ms 起步、每次 ×2、**上限 15000ms**（`:91`），连接成功复位；**无重试次数上限**（无限重连直至页面卸载或连上）。
- **`dispose()`（`:94-102`）清理**：置 `disposed`，清 `reconnectTimer`/`reloadTimer` 两个定时器，摘除 `socket.onclose` 后再 `close()`（`:99-100`，防止主动关闭又触发重连）。
- **生命周期挂接（`:104-105`）**：`onMounted(connect)`、`onBeforeUnmount(dispose)`——**每个调用组件实例独立一条连接、卸载即清理**，不存在订阅后未退订导致回调堆积的问题（`30b4458` 前大屏页定时器未清理的缺陷已由本结构根治；grep 实测三个调用页均无残留的自建 WS 定时器）。

### 4.3 与轮询的关系

三个调用页均**无 `setInterval` 轮询兜底**（grep `admin/src` 实测，唯一命中是 `ActivityView.vue:168` 的活动倒计时 ticker，与实时刷新无关）；REST 只在进入页面/筛选变化时拉取，增量全靠本 WS（`.qoder/ARCHITECTURE.md` §6.4「实时推送」同此口径）。WS 断开期间数据不刷新，仅有 `wsStatus` 角标提示「已断开，重连中」。

## 5. 输入与输出

- **入参**：`handlers: LiveHandlers`（两个可选回调）。回调在防抖定时器/消息事件中执行，页面侧需自保幂等（`onDataChanged` 通常是重新 `load()` 当前页）。
- **返回**：`{ wsStatus }`；三态语义——`connecting`（建连中）、`online`（已连上）、`offline`（无 token 或断开待重连）。
- **WS 端点契约**：`GET(ws) /api/ws/updates?token=<JWT>`；后端鉴权失败以 **4401** 关闭（token 无效/用户不存在），管理员授权撤销或账号停用 **4403** 关闭（`ws.py:25`、`:32`、`:44`、`:49`）；该端点**同时接受小程序用户令牌与管理端令牌**（`ws.py:27-28` docstring：超管令牌直接放行，微信关联管理员令牌建连时查库校验启用角色）。管理端传入的是管理员登录 JWT（账号密码或扫码登录所得）。
- **无 HTTP 错误码/axios 参与**：本文件不走 `admin/src/api/request.ts`，故 `AxiosRequestConfig.silent` 标志（`request.ts:8-12` 声明）与本文件**无关、未使用**；WS 失败不弹任何 toast，仅体现在 `wsStatus`。

## 6. 依赖关系

- **依赖**：`vue`（`onBeforeUnmount`/`onMounted`/`ref`，`:3`）、`../api/admin` 的 `ActivityItem` 类型（`:4`）、`../store/auth` 的 `getToken`（`:5`）。
- **后端对应**：`backend/app/api/routes/ws.py`（端点与鉴权）+ `backend/app/core/ws.py`（连接表与 `broadcast`/`build_event`/`build_activity`）；小程序侧同端点的另一消费者是 `frontend/services/ws.js`（文档 `.qoder/frontend/services/ws.js.md`），两端各自实现、共用后端广播。
- **开发环境链路**：连接目标是 `location.host`，dev 下即 Vite 5173，经 `admin/vite.config.ts:11-16` 的 `/api` proxy（`ws: true`）转发后端；生产由 nginx 反代（见 §9 遗留问题）。
- **被依赖**（grep 实测 3 处）：`DashboardView.vue:18`（`:140-149` 传 `onDataChanged`=刷新指标+趋势、`onActivity`=插顶保留 20 条；`:157` 状态文案）、`ScreenView.vue:5`（`:22-27` 同型 handlers；`:53-54` 状态点）、`RankingsView.vue:5`（`:61` 仅传 `onDataChanged: load` 重载当前页；`:148` 状态角标）。

## 7. 业务规则

1. **合并防抖窗口 800ms**：一次批量写入引发的多条 `data_changed` 只触发一次整页刷新（保护后端，避免刷新风暴）；窗口值改动需与页面加载耗时权衡。
2. **推送动态 id 为负数且模块级递减**：只作 Vue 行 key，不入库、不跨刷新稳定；页面把推送项与 REST 项混排时依赖「真实 id 恒为正」不冲突（`:23` 注释）。
3. **动态流上限由页面裁剪**（驾驶舱/大屏各 `slice(0, 20)`），本文件不限流。
4. **无 token 不建连**：登录态是建连前提；路由守卫已保证未登录进不了这三个页面，`offline` 分支属兜底。
5. **重连不区分关闭码**：4401/4403（鉴权类关闭）与普通断网同样进入无限退避重连（`onclose` 未读 `event.code`，`:77-80`）——令牌过期场景下 axios 侧 401 会清会话跳登录页（`request.ts:35-45`），页面随即卸载、`dispose` 终止重连；但若页面停留在无 REST 请求状态，会以 ≤15s 间隔持续重试。此为已知取舍（§9）。
6. 客户端**不发送心跳**，只容忍收到的非 JSON 心跳帧（`:73` 注释）；后端也不下发心跳（`ws.py:52-55` 仅循环 `receive_text` 忽略），断线检测完全依赖 TCP/代理触发 `onclose`。

## 8. 修改约束

1. `/api/ws/updates` 的 URL、`token` query 参数名、消息字段名（`type`/`eventType`/`userId`/`nickname`/`text`/`at`）是与后端 `core/ws.py:23-37` 及小程序 `frontend/services/ws.js` 的**三端隐式契约**，改动必须三端同步（`.qoder/README.md` §3 规则 6）。注意后端广播字段是 camelCase（`eventType`）而 REST `ActivityItem` 是 snake_case（`event_type`），`:41-49` 的转换层不得省略。
2. `onMounted`/`onBeforeUnmount` 挂接（`:104-105`）决定了本函数**只能在组件 setup 同步调用**；`dispose` 中「先摘 `onclose` 再 `close()`」的顺序（`:99-100`）不得颠倒，否则卸载会触发一次多余重连。
3. 新增消费页面必须传 handlers 复用本 composable，不得在页面内另写 WebSocket/防抖定时器（`30b4458` 收口前的三页各自实现即反面案例；根 `agents.md` §2.2）。
4. 退避参数（3000 起步、×2、15000 上限）与合并窗口 800ms 是审查后定值，调整需重测驾驶舱/大屏/排名三页的实时表现。
5. 修改后按 `admin/agents.md`「必做验证」执行 `npm run build` + 浏览器实测（触发小程序侧写入观察自动刷新、断开后端观察重连角标、切页观察连接释放）。

## 9. 当前实现状态

- **已实现**：连接/鉴权/退避重连/合并防抖/动态转换/卸载清理全链路；三个调用页零自建定时器（grep 实测）；无订阅泄漏（清理契约见 §4.2）。`30b4458` 修复的「大屏定时器未清理」缺陷已由结构消除。
- **已知风险/取舍（登记，未改代码）**：
  1. 重连不读关闭码（`:77-80`）：4401/4403 鉴权失败也会无限重连（≤15s/次）；依赖 REST 401 跳登录页间接终止，纯停留页面会持续空转重试。
  2. 无 token 时置 `offline` 且不安排重试（`:56-59`）：若同页面内后续才写入 token（现状不存在该流程），连接不会自愈。
  3. 无客户端心跳：空闲连接被中间代理静默掐断时，感知延迟取决于浏览器何时触发 `onclose`。
  4. **生产 wss 443 未通（运维遗留）**：`docs/迭代记录.md` 的 `527db98` 条目记载实测 `wss://swkjdj.sz-watech.com/api/ws/updates` 握手失败（客户端 1006），根因 nginx 未透传 `Upgrade`/`Connection` 头；仓库内未见后续修复记录，**生产实时推送是否已恢复待确认**（接口本身不受影响，WS 失败自动重连）。同一事实已登记为 `.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1 项（nginx 缺 `proxy_http_version 1.1` + `Upgrade`/`Connection` 透传）、第 2 项（公众平台 socket 合法域名未配置），本文档不重复维护，以 §8 为准。
- **待确认**：上述第 4 条；其余结论均有代码/grep/git 证据。

## 10. 迭代记录

数据来源：`git log --follow --format='%h | %ad | %s' --date=format:'%Y-%m-%d %H:%M' -- admin/src/utils/liveUpdates.ts`，共 **2 个提交**，均在 `docs/迭代记录.md` 有对应条目。按时间倒序。

### 2026-10-11（`30b4458`，18:30）
- 需求：管理后台代码审查修复（逻辑/冗余/大数据量性能）。
- 修改内容：API 从单一 `onMessage(data)` 回调改为 `LiveHandlers { onDataChanged, onActivity }`；`data_changed` 800ms 合并防抖收进 composable（三页删除各自定时器，大屏原未清理）；`activity` 统一转 `ActivityItem`（模块级负数自增 id 防 key 冲突）；`dispose` 增加 `reloadTimer` 清理；`formatTime`/`formatNumber` 迁出至新建的 `utils/format.ts`；无 token 分支补置 `offline`。
- 关联文件：`admin/src/utils/format.ts`（新建）、`DashboardView.vue`、`ScreenView.vue`、`RankingsView.vue`；报告 `admin/test/docs/s16-admin-review-fixes-report.md`。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目（`npm run build` 通过；浏览器验收含驾驶舱/大屏实时推送防抖）。

### 2026-10-02（`01ec93c`，11:51）
- 需求：管理端驾驶舱与数据大屏页面（P2）。
- 修改内容：**创建本文件**——`useLiveUpdates` 组合式函数（WS 连接/指数退避重连/消息分发，模式抽自 RankingsView 内联实现），当时同文件还含 `formatTime`/`formatNumber`（naive 时间串补 `Z` 按 UTC 处理，后迁出）；`LiveMessage` 类型当时为导出。
- 关联文件：`admin/src/views/DashboardView.vue`、`ScreenView.vue`（新建）、`backend/app/api/routes/ws.py`、`backend/app/core/ws.py`；报告 `admin/test/docs/s6-admin-cockpit-screen-report.md`。
- 测试结果：见 `docs/迭代记录.md` 的 `01ec93c` 条目。
