# ws.py（routes）

> **注意区分同名文件**：本文档对应路由文件 `backend/app/api/routes/ws.py`；连接管理器是另一个文件 `backend/app/core/ws.py`（本文一律写全路径）。

## 1. 文件路径

`backend/app/api/routes/ws.py`（58 行）

## 2. 文件职责

后端唯一的 WebSocket 端点 `WEBSOCKET /api/ws/updates` 的路由层：握手鉴权（区分小程序用户令牌与管理端令牌）、把连接交给 `backend/app/core/ws.py` 登记、维持连接直到断开。小程序侧任何用户数据写入成功后经 core/ws.py 向所有已连接客户端广播 `data_changed` 事件，管理端据此自动刷新、无需轮询（模块 docstring `:1-6`）。

## 3. 业务需求

- `82af32c`（2026-10-01）「新增 WebSocket 数据变更广播，步数/点亮/答题/勋章/组织操作实时推送管理端」（`docs/迭代记录.md` 的 `82af32c` 条目）；对应需求 §8.4（`frontend/services/ws.js:2` 注释）。
- `4bf9acd`（2026-10-09）RBAC 批次追加「WS 管理员分支建连查库校验（撤销/禁用即时断权）」；`afbcba9`（2026-10-12）准入批次追加「禁用用户 … WS 4403」（提交信息，见 `docs/迭代记录.md` 的 `4bf9acd`、`afbcba9` 条目）。

## 4. 核心功能

**1 个 WebSocket 端点**（不在 OpenAPI 中；router 前缀 `/ws`，`:16`，`backend/app/main.py:85` 以 `/api` 挂载）：

| 端点 | 函数 | 行号 |
|---|---|---|
| `WEBSOCKET /api/ws/updates` | `updates`（async） | `:19-57` |

### 4.1 握手鉴权方式（确切结论）

**令牌走 URL query string 参数 `token`**（`:22`：`token: str = Query("", description="JWT（浏览器原生 WebSocket 无法携带请求头）")`），**不是** header；数据库会话经 `Depends(get_db)` 注入（`:23`）。校验用 `core/security.decode_token`（`backend/app/core/security.py:52-59`，失败返回 None 不抛异常），分支顺序（`:30-50`）：

| 步骤 | 行号 | 条件 | 结果 |
|---|---|---|---|
| 1 | `:30-33` | `decode_token` 失败或载荷无 `sub` | `await ws.close(code=4401)`，直接 return（**不 accept**） |
| 2 | `:34-36` | `is_super_admin = payload.role == "admin" and payload.typ != "user"` | 判定是否超管令牌（含无 `typ` 的历史令牌，与 `deps.get_current_admin` 口径一致，`backend/app/api/deps.py:127-129`） |
| 3 | `:37-40` | `int(payload["sub"])` 查 `users` 表；转换失败（TypeError/ValueError）视为查无 | 得到 `user` 或 None |
| 4 | `:41-42` | 超管令牌 | **直接放行，不查库**（`sub` 是用户名而非用户 id，本就查不到） |
| 5 | `:43-45` | 非超管且 `user is None` | close **4401** |
| 6 | `:46-50` | `user.status != active`（`invite_service.STATUS_ACTIVE`），**或** `role=admin` 且 `access_service.build_principal` 返回 None（后台授权被撤销/禁用） | close **4403** |
| 7 | `:51` | 通过 | `await ws_manager.connect(ws)`（core/ws.py 内 accept 并登记，`backend/app/core/ws.py:40-45`） |

4401/4403 是自定义应用关闭码（WebSocket 4000-4999 应用保留区）；关闭发生在 `accept()` 之前。两端客户端均**不消费关闭码做差异化处理**（小程序 `frontend/services/ws.js:53-61` 与管理端 `admin/src/utils/liveUpdates.ts` 一律走退避重连），码值目前主要起服务端语义标注作用。

### 4.2 谁能连、连上后收到什么

- **双端都可连**（docstring `:27-28`「同时接受小程序用户令牌与管理端令牌」）：小程序 `frontend/services/ws.js:35` 以 `?token=` 连接（未登录不连，`:32-33`；无订阅者 30s 后主动关闭，`:64-74`）；管理后台 `admin/src/utils/liveUpdates.ts:62` 以 `?token=` 连接（Dashboard/Screen/Rankings 三页使用）。
- 连上后收到的**两类消息**（均由 `backend/app/core/ws.py` 构造、`broadcast` 下发）：
  1. `data_changed`（`build_event`，`core/ws.py:23-25`）：`{type, reason, user_id, at}`，**不含业务数据**，客户端收到后自行重拉 REST；触发点覆盖登录/入驻/改名（`routes/auth.py:26`、`:103`、`:122`）、步数、答题、点亮、组织选定、勋章发放等全部用户数据写入。
  2. `activity`（`build_activity`，`core/ws.py:28-37`）：`{type, eventType, userId, nickname, text, at}`（camelCase），实时行军动态文案，由 `backend/app/services/event_service.py:126-128` 在事件落库后推送；小程序首页只处理这一类（`frontend/pages/home/home.js:142-143`），管理端驾驶舱/大屏动态流直接展示 `text`。

### 4.3 与 `backend/app/core/ws.py` 连接管理器的分工

- **本文件（routes/ws.py）**：协议层——握手鉴权、关闭码、连接生命周期（accept 时机、`while True: await ws.receive_text()` 保活并忽略客户端一切消息 `:52-55`、`WebSocketDisconnect` 时调 `disconnect` 摘除 `:56-57`）。
- **core/ws.py**：连接表与广播——模块级 `_connections`/`_loop`（`:14-15`）、`connect`/`disconnect`（`:40-51`）、`broadcast` 经 `asyncio.run_coroutine_threadsafe` 把同步业务线程的广播投递到事件循环（`:62-71`）、两类消息构造函数（`:23-37`）。
- 本文件不 import `broadcast`，只 import `connect`/`disconnect` 所在的模块别名 `ws_manager`（`:10`）；广播由业务侧（services 与 auth 路由）调用。

### 4.4 「无心跳、无重放、单进程」三条限制的确切代码依据

1. **无心跳**：服务端从不主动发帧——建连后循环体只有 `await ws.receive_text()`，注释「客户端心跳等消息统一忽略」（`:53-55`）；`core/ws.py` 全文无 ping/pong/定时任务。连接存活完全依赖 TCP 与客户端自身逻辑（小程序端空闲 30s 主动关闭，`frontend/services/ws.js:10`、`:64-74`）。
2. **无重放**：`broadcast` 只对**当前在 `_connections` 里的连接**逐条投递（`core/ws.py:67-69`），事件不落任何队列/表（`data_changed` 本身不入库；`activity` 消息的**数据源** `user_event` 表虽入库，但 WS 通道无按连接位点补发逻辑）；断连期间事件对 WS 通道永久丢失，客户端重连后须自行全量刷新（管理端 `liveUpdates.ts` 重连后由页面 fetch 兜底）。
3. **单进程**：`_connections` 与 `_loop` 是**模块级进程内变量**（`core/ws.py:14-15`），`broadcast` 无跨进程通道（无 Redis/消息队列，全仓无相关依赖，见 `.qoder/backend/requirements.txt.md`）；多 worker 部署时广播只命中同进程连接。当前生产为单进程 uvicorn（`.qoder/ARCHITECTURE.md` §12，进程管理方式待确认）。

## 5. 输入与输出

- 输入：query 参数 `token`（JWT 字符串，三类令牌均可：用户令牌 `sub`=用户 id；`typ=super` 超管令牌 `sub`=用户名；`typ=user` 微信关联管理员令牌 `sub`=用户 id，`core/security.py:10-49`）。
- 输出（服务端 → 客户端，JSON 文本帧）：`data_changed` 与 `activity` 两类（§4.2）。客户端 → 服务端的任何消息被读取后丢弃（`:55`）。
- 异常路径：鉴权失败 close 4401/4403（§4.1）；`WebSocketDisconnect` 正常摘除（`:56-57`）；发送侧异常由 `core/ws.py:54-59` `_safe_send` 静默吞掉，不影响业务请求。

## 6. 依赖关系

- 依赖：`backend/app/core/ws.py`（connect/disconnect）、`backend/app/core/security.py`（decode_token）、`backend/app/core/database.py`（get_db）、`backend/app/models/models.py`（User）、`backend/app/services/access_service.py`（build_principal）、`backend/app/services/invite_service.py`（STATUS_ACTIVE 常量）。
- 被依赖：`backend/app/main.py:85` 注册；消费端为小程序 `frontend/services/ws.js`（首页订阅）与管理后台 `admin/src/utils/liveUpdates.ts`（3 个页面）。
- 数据库表：`users`（握手时读一次）；`admin_user_roles`/`admin_roles` 等经 `build_principal` 间接读（仅 `role=admin` 且 `typ=user` 时）。
- 事务边界：只读查询，无 commit。注意 `Depends(get_db)` 的 Session 生命周期与**整条连接**等长（握手查询后闲置，连接断开才关闭）。

## 7. 业务规则

1. 鉴权失败**不抛 HTTP 异常**，以 WS 关闭码表达（4401 未认证 / 4403 已认证但无权：账号停用或后台授权撤销）。
2. 超管令牌免查库放行 → 其**停用无法经本端点即时断权**（只能等 12h 令牌过期或改 `JWT_SECRET`），与 `deps.get_current_admin` 的既有取舍一致（`.qoder/ARCHITECTURE.md` §5.1）；`typ=user` 管理员与小程序用户则建连时查库即时断权。
3. 授权校验只发生在**建连时刻**：连接建立后权限被撤销/账号被停用，已有连接不会被服务端主动踢断（无周期性复核逻辑），直至客户端断开重连才重新校验。
4. 消息不含业务数据（`data_changed`），客户端按自身权限重拉，避免在广播路径上做权限过滤（`core/ws.py:24` docstring、`.qoder/ARCHITECTURE.md` §6.3）。

## 8. 修改约束

1. `token` 走 query 是浏览器原生 WebSocket 无法自定义 header 的既定取舍（`:22` 注释）；改为子协议或首帧认证需两端客户端（`frontend/services/ws.js`、`admin/src/utils/liveUpdates.ts`）同步改造，并评估令牌出现在 URL 中的日志泄露面（nginx/uvicorn 访问日志是否记录 query——**待确认**，nginx 配置不在仓库内）。
2. 4401/4403 语义（未认证/无权）已被 `docs/迭代记录.md` 与测试报告引用，改码需同步文档。
3. 握手分支顺序不可调换：必须先 decode、再判超管、再查库（超管 `sub` 是用户名，先 `int(sub)` 会误判）。
4. 本文件是 async 路由（全仓库其余路由为同步 def，`backend/AGENTS.md` §2），修改时不得改成同步 def（WebSocket 端点必须 async）。
5. 生产 nginx 当前未转发 Upgrade/Connection 头，wss 在 443 不可用（`.qoder/ARCHITECTURE.md` §12.3）——这是部署缺陷而非本文件问题，改动本文件不解决该缺陷。

## 9. 当前实现状态

- **已实现**：端点可用；开发环境经 S9/S8 等冒烟与 `backend/test/docs/` 报告验证（`4bf9acd` 提交信息：S9 30/30、S8 复测 23/23）。
- **存在问题 / 已知限制**：
  1. 生产 wss 因 nginx 缺 Upgrade 转发 + 微信 socket 合法域名未配置而不可用（`.qoder/ARCHITECTURE.md` §12.3），实时推送在生产退化为拉取。
  2. 无心跳、无重放、单进程（§4.4）。
  3. 建连后无持续授权复核（§7 第 3 条）。
- **待开发**：无（本文件范围内）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/ws.py`，共 **3 个提交**。按时间倒序。

### 2026-10-12（`afbcba9`）
- 需求：邀请码准入全链路。
- 修改内容（据 diff 核实）：4403 分支从「仅管理员授权撤销」扩展为「`user.status != active` **或** 管理员授权撤销」——停用账号的 WS 连接在建连时即拒绝；新增 import `invite_service`。
- 关联文件：`backend/app/api/routes/auth.py`、`backend/app/api/deps.py`、`docker/init/015_*.sql`、frontend/admin。
- 测试结果：s19 冒烟 25/25 + 真实 openGauss 并发 3/3（提交信息）。

### 2026-10-09（`4bf9acd`，10:43）
- 需求：管理后台 RBAC 与审计接口。
- 修改内容（涉本文件）：WS 管理员分支建连查库校验（`role=admin` 且 `build_principal` 为 None → 4403），授权撤销/禁用即时断权（提交信息）。
- 关联文件：`backend/app/api/routes/admin.py`、`backend/app/services/access_service.py`、`backend/app/api/deps.py`。
- 测试结果：S9 30/30、S8 复测 23/23（提交信息）。

### 2026-10-01（`82af32c`，17:52）
- 需求：管理端实时刷新。
- 修改内容：创建本文件——`WS /api/ws/updates` 端点与握手鉴权；同批在步数/点亮/答题/勋章/组织操作后接入 `core/ws.py` 广播（提交信息）。
- 关联文件：`backend/app/core/ws.py`、`admin/src/utils/liveUpdates.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `82af32c` 条目。
