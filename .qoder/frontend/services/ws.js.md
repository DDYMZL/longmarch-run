# ws.js

## 1. 文件路径

`frontend/services/ws.js`（92 行）

## 2. 文件职责

小程序端 WebSocket 实时推送客户端：以 `wx.connectSocket` 连接后端 `/api/ws/updates`（需求 §8.4，`:2` 注释），单连接全局复用、断线指数退避自动重连、无订阅者时延迟关闭。对外仅导出 `subscribe(fn)` 一个函数（`:92`），页面经订阅/退订驱动连接生命周期。

## 3. 业务需求

- 实时行军动态（P1-1）：`17a4d98`（2026-10-03）「公开动态流接口+WS 客户端+首页实时行军卡」交付本文件（`docs/迭代记录.md` 的 `17a4d98` 条目）。
- 空闲断开与回调隔离：`e70b59f`（2026-10-11）代码审查批次加入「ws 无订阅者 30s 后空闲断开且不再重连，回调按连接实例隔离」（`docs/迭代记录.md` 的 `e70b59f` 条目）。
- 与 REST 动态流的分工（REST 负责首屏/回场初始列表与断线补拉，WS 负责在线期间实时增量）见 `.qoder/backend/app/api/routes/broadcast.py.md` §7.1。

## 4. 核心功能

### 4.1 模块级单连接状态（`:10-18`）

`socket/connected/connecting/retry/retryTimer/idleTimer/listeners` 全部为模块级变量——小程序 CommonJS 模块单例，天然全局复用一条连接；宽限期常量 `IDLE_CLOSE_MS = 30000`（`:10`，注释：退订后短时间内切回首页可复用原连接）。

### 4.2 连接 URL 构造与登录门槛（`connect`，`:30-62`）

- `connected || connecting` 时直接返回，防并发重复连接（`:31`）。
- Token 取 `requestService.getToken()`（`:32`，即 Storage 键 `lm_auth_token`，`frontend/services/request.js:14-20`）；**无 token 不建立连接**（`:33`），即未登录状态不产生 WS 连接。
- URL：`API_BASE_URL.replace(/^http/, 'ws') + '/ws/updates?token=' + encodeURIComponent(token)`（`:35`）。`API_BASE_URL` 来自 `frontend/services/config.js:28-44`（含 `/api` 前缀）：体验版/正式版为 `https://swkjdj.sz-watech.com/api` → 替换后 `wss://…/api/ws/updates`；develop 且 `DEV_TARGET='local'`（当前值，`config.js:11`）时为 `http://127.0.0.1:8010/api`（真机为局域网 IP）→ `ws://…`。鉴权走 query 参数 `token`（小程序 `wx.connectSocket` 不便带自定义 header 的常见做法；后端校验逻辑见 `.qoder/backend/app/api/routes/ws.py.md`）。
- **回调按连接实例隔离**：`onOpen/onMessage/onClose/onError` 均先判 `socket !== s` 直接返回（`:39-40`、`:45-46`、`:53-54`），旧连接迟到的 close/error 不得重置新连接状态（`:38` 注释；`e70b59f` 引入）。

### 4.3 重连策略（指数退避，`:20-28`、`:53-61`）

- 触发：`onClose` 与 `onError` 共用 `onDead`——置 `connected/connecting=false`、清 `socket`、调 `scheduleReconnect()`（`:53-61`）。
- 退避：`delay = Math.min(15000, 1000 * 2^(retry-1))`（`:23`），即 1s → 2s → 4s → 8s → 15s 封顶（文件头注释「1s 起封顶 15s」，`:3`）。
- 复位：连接 `onOpen` 成功后 `retry = 0`（`:43`）；空闲关闭时也复位（`:68`）。
- 抑制：`retryTimer` 已存在或 `listeners.length === 0` 时**不再排程重连**（`:21`）——无订阅者时彻底停止重连，避免后台空连接持续接收广播（`:5` 注释）。
- **无应用层心跳**：本文件 1-92 行不存在 ping/pong 或定时发包逻辑；连接保活是否由服务端承担，见 `.qoder/backend/app/api/routes/ws.py.md` 与 `.qoder/backend/app/core/ws.py.md`，本文档不代为断言（**待确认**：小程序切后台被系统挂起后，回前台是否必然触发 onClose 从而走退避重连，未在本文件中显式处理，依赖平台行为）。

### 4.4 消息分发（`:45-52`）

`onMessage` 收到帧后 `JSON.parse`，解析失败**静默丢弃**（`:47-48`）；随后对 `listeners.slice()`（副本遍历，防止回调内订阅/退订引发并发修改）逐个调用，单个监听器抛异常被吞、不影响其他订阅者（`:49-51`）。消息按 `msg.type` 区分（`activity` / `data_changed` 等，`:3` 注释），**本文件不做类型过滤，原样透传**，由订阅方自行判别（首页只处理 `activity`，见 §6）。

### 4.5 订阅/退订与空闲清理（`subscribe`，`:81-90`；`closeIdle`，`:64-74`）

- `subscribe(fn)`：入列 `listeners`，若存在空闲计时器则清除（宽限期内回场复用原连接，`:83`），随即尝试 `connect()`（已连接时是 no-op，`:31`）；返回退订函数（`:85-89`）。
- 退订：从 `listeners` 移除；当订阅者归零且无计时器时，排程 30s 后 `closeIdle`（`:88`）。
- `closeIdle`：再次确认无订阅者（期间可能有人重新订阅，`:66`），取消待执行的重连计时并复位 `retry`（`:67-68`），清空连接状态后 `s.close({})`（`:69-73`）。关闭后**不会自动重连**（重连以 `listeners.length > 0` 为前提，`:21`），直到下一次 `subscribe` 才重新 `connect`。

## 5. 输入与输出

- 输入：`subscribe(fn)` 的 `fn: (msg:object)=>void`，msg 为后端推送 JSON 帧的解析结果（字段结构由后端决定，`activity` 消息与 REST `GET /broadcast/activities` 条目经同一视图函数归一，见 `.qoder/backend/app/api/routes/broadcast.py.md` §7.1）。
- 输出：退订函数（幂等性：对同一 fn 重复退订时 `indexOf` 为 -1 不再删除，`:86-87`；但**不会**取消已排程的 idleTimer，见 §9）。
- 异常：本模块所有回调内部自吞异常，不向调用方抛出；连接失败表现为 onError→退避重试，无失败通知接口。

## 6. 依赖关系

- 依赖：`frontend/services/config.js`（`:7`，`API_BASE_URL`）、`frontend/services/request.js`（`:8`，仅用其 `getToken`，不经其 request 通道）、`wx.connectSocket` 平台 API（`:36`）。
- 后端对端：`/api/ws/updates`（`.qoder/backend/app/api/routes/ws.py.md`）；广播构造与连接管理在 `.qoder/backend/app/core/ws.py.md`；`activity` 消息数据源为 `user_event` 表（`.qoder/backend/app/services/event_service.py.md`）。
- 被依赖（grep 全量核实）：
  - **唯一页面订阅者：首页** `frontend/pages/home/home.js:16`（require）、`:121-122`（`onShow` 中 `this._wsUnsub = ws.subscribe(...)`）、`:130`/`:136`（`onHide`/`onUnload` 退订并置空）；`handleWsMessage`（`:142-146`）**只处理 `msg.type === 'activity'`**：经 `broadcast.toActivityView` 归一后插入动态流顶部、最多保留 6 条；`data_changed` 等其他类型被忽略。
  - 测试脚本 `frontend/test/ws-idle-check.cjs:58-79`（直接订阅验证空闲断开逻辑，测试体系见 `.qoder/frontend/test/README.md`）。
- **导出函数零调用者：无**（唯一导出 `subscribe` 有页面与测试调用）。

## 7. 业务规则

1. **未登录不连接**：无 JWT 直接返回（`:33`）；登录态变化后由下一次 `subscribe`（首页 `onShow`）触发连接，本模块不监听登录事件。
2. **订阅者驱动生命周期**：连接只为有订阅者存在——退订归零 30s 宽限后关闭且停止重连（`:5`、`:21`、`:88`），符合根 `agents.md` §2.4 性能要求（避免后台空连接持续接收广播）。
3. **消息不过滤、异常不扩散**：类型判别责任在订阅方（`:45-52`）；单订阅者异常不影响其他订阅者（`:50`）。
4. **token 泄漏面**：JWT 以 URL query 传递（`:35`），会进入服务端/代理访问日志——是否需要在日志侧脱敏属后端/运维范畴，**待确认**（本文档仅记录现状）。

## 8. 修改约束

1. `subscribe` 返回退订函数、首页 `onHide/onUnload` 成对退订是「定时器/连接清理」审查批次的成果（`e70b59f`），不得改成常驻不退订（`frontend/AGENTS.md` §6 亦要求清理）。
2. 回调的 `socket !== s` 实例隔离判断（`:39-40`、`:46`、`:54`）不得删除——删除后旧连接迟到的 close/error 会把新连接状态打回未连接并触发多余重连（`:38` 注释）。
3. 退避上限 15s、宽限期 30s 为既定策略（`:3`、`:10`），调整需同步更新文件头注释与本文档。
4. URL 构造依赖 `API_BASE_URL` 含 `/api` 前缀且以 `http` 开头（`:35` 的 `replace(/^http/, 'ws')` 对 `https` 同样生效→`wss`）；若 `config.js` 改变前缀结构，本文件需同步。
5. **生产环境 wss 当前不可用（外部依赖，非本文件代码缺陷）**：nginx 443 server 块未转发 `Upgrade`/`Connection` 头，且微信公众平台 socket 合法域名未配置——已登记于 `.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1 项与第 2 项。修复属部署/平台配置范畴，改本文件代码无法解决；在此之前正式版首页动态流仅靠 REST（`GET /broadcast/activities`）拉取，WS 表现为连接失败→退避重试→（无订阅或持续失败）静默。

## 9. 当前实现状态

- **已实现**：单连接复用、指数退避重连（1s 起封顶 15s）、无订阅者 30s 空闲断开且不再重连、回调按连接实例隔离、消息透传分发；随 `17a4d98` 交付、`e70b59f` 加固（验证记录见 `docs/迭代记录.md` 对应条目及 `frontend/test/ws-idle-check.cjs`）。
- **存在问题 / 已知事项**：
  1. **生产 wss 链路不通**（nginx Upgrade 头未转发 + socket 合法域名未配置，`.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1、2 项）——正式版实时推送实际不可用，待部署侧修复。
  2. 退订函数重复调用不会取消已排程的 idleTimer（`:85-89` 无幂等标记）；当前唯一订阅者首页退订后置空 `_wsUnsub`（`home.js:130`、`:136`）避免了重复调用，风险未实际暴露。
  3. 无应用层心跳（§4.3），弱网/代理环境下半开连接只能依赖平台 onClose/onError 触发重连，时效性**待确认**。
- **待开发**：无（`data_changed` 消息类型后端会推送，但首页当前忽略、无消费方；是否扩展订阅方属产品决策，**待确认**）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/ws.js`，共 **2 个提交**，均在 `docs/迭代记录.md` 有条目。按时间倒序。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复批次。
- 修改内容（涉本文件）：新增无订阅者 30s 空闲断开且不再重连（`IDLE_CLOSE_MS`/`idleTimer`/`closeIdle`，`:10`、`:17`、`:64-74`、`:88`）；回调按连接实例隔离（`:38-40`、`:46`、`:54`）。
- 关联文件：`frontend/pages/home/home.js`（成对退订）等同批页面。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目；空闲断开另有 `frontend/test/ws-idle-check.cjs` 覆盖。

### 2026-10-03（`17a4d98`，00:45）
- 需求：实时行军动态（P1-1）。
- 修改内容（涉本文件）：创建本文件——`/api/ws/updates` WS 客户端、订阅分发、指数退避重连（提交信息与现码为据）。
- 关联文件：`backend/app/api/routes/ws.py`、`backend/app/services/event_service.py`、`frontend/services/broadcast.js`、`frontend/pages/home/home.js`（首页实时行军卡）。
- 测试结果：见 `docs/迭代记录.md` 的 `17a4d98` 条目。
