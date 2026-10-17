# ws.py

## 1. 文件路径

`backend/app/core/ws.py`（71 行）

> 注意：本文件是 `core/` 下的 **WebSocket 连接管理器**，与 `backend/app/api/routes/ws.py`（WebSocket **路由端点**）同名但职责不同。两者是「基础设施 / 协议层」的分工关系，见 §6。本文档只覆盖 `core/ws.py`；`api/routes/ws.py` 另有文档（`.qoder/backend/app/api/routes/ws.py.md`，属另一批次）。

## 2. 文件职责

维护进程内的 WebSocket 连接表，并提供**从同步业务代码向所有已连接客户端广播 JSON 事件**的能力。它是后端唯一的反向推送通道（后端没有对前端的 HTTP 回调），解决的核心问题是：业务写操作运行在**同步路由的请求线程**中，而 WebSocket 发送是**协程**，必须跨线程把发送任务投递到事件循环。

模块 docstring（`:1-6`）把这三条设计前提全部写明：同步路由在线程池、`run_coroutine_threadsafe` 投递、首个连接建立时记录事件循环引用、无连接或循环不可用时静默跳过。

## 3. 业务需求

- **管理后台实时刷新**：小程序侧任何用户数据写入成功后，管理后台的驾驶舱 / 大屏 / 排行榜页面无需轮询即可感知变化并重新拉取 REST 接口。来源：提交 `82af32c`「新增 WebSocket 数据变更广播，步数/点亮/答题/勋章/组织操作实时推送管理端」。
- **管理端实时动态流**：驾驶舱 / 大屏需要滚动展示「谁完成了什么」的动态条目（含昵称与文案）。来源：提交 `be7e126`「新增统一事件系统与连续行军机制」，该提交为本文件增加了 `build_activity`。
- **消息格式契约统一**：提交 `7607d7b` 修复的第 4 处缺陷「WS 时间戳契约 BUG-004」，把 `at` 字段从毫秒整数改为 ISO 字符串，使其与 REST 接口的 `event_time` 格式一致（`docs/测试报告.md` 第一轮记录该缺陷、第二轮记录修复复测）。

## 4. 核心功能

### 4.1 模块级状态（`:14-15`）

```python
_connections: List[WebSocket] = []
_loop: Optional[asyncio.AbstractEventLoop] = None
```

- `_connections`：**进程内内存连接表**，元素是已 `accept()` 的 `WebSocket` 对象。无上限、无鉴权信息、无用户 id 关联 —— 只存连接本身。
- `_loop`：事件循环引用，供同步代码调用 `asyncio.run_coroutine_threadsafe` 时作为目标循环。初值 `None`。

两者都是**模块级全局变量**，生命周期与进程一致，不落库、不入 Redis。

### 4.2 `_now_iso()`（`:18-20`）

私有函数，返回 `datetime.utcnow().isoformat()`。docstring `:19` 明确「当前时间 ISO 字符串（UTC naive，与 REST 接口 event_time 格式一致）」。输出形如 `2026-10-17T11:06:10.123456`（**无时区后缀**，前端须用 `parseUtc` 解析，见 `.qoder/ARCHITECTURE.md` §4.5）。

### 4.3 `build_event(reason, user_id)`（`:23-25`）

构造 `data_changed` 事件字典，4 个键：

| 键 | 值 | 命名风格 |
|---|---|---|
| `type` | 字面量 `"data_changed"` | — |
| `reason` | 调用方传入的原因字符串（见 §7 的 10 种取值） | snake_case 值 |
| `user_id` | 触发该事件的用户主键 | **snake_case 键名** |
| `at` | `_now_iso()` | — |

docstring `:24` 明确「仅事件类型与元信息，**不含业务数据**」。

### 4.4 `build_activity(event_type, user_id, nickname, text)`（`:28-37`）

构造 `activity` 事件字典，6 个键：`type`（字面量 `"activity"`）、`eventType`、`userId`、`nickname`、`text`、`at`。

**注意键名风格与 `build_event` 不一致**：`build_activity` 用 **camelCase**（`eventType` / `userId`），`build_event` 用 **snake_case**（`user_id`）。两者都不是 Pydantic 模型，是手写字面量字典，`CamelModel` 的 `alias_generator` 不参与（见 §8）。docstring `:29` 说明用途「管理端驾驶舱/大屏动态流直接展示 text」。

### 4.5 `connect(ws)`（`:40-45`）— `async`

三步，顺序固定：

1. `:43` `await ws.accept()` 完成握手；
2. `:44` `_loop = asyncio.get_running_loop()`（`global _loop` 声明在 `:42`）—— **每次连接都覆写**，注释与 docstring `:41` 说明目的是「记录事件循环供同步代码投递」；
3. `:45` `_connections.append(ws)` 登记。

**唯一调用点**：`api/routes/ws.py:51`，在令牌鉴权通过之后调用（鉴权失败时路由直接 `ws.close(4401/4403)` 并 return，**不会进入 `connect`**）。

### 4.6 `disconnect(ws)`（`:48-51`）— 同步

`:50-51`：`if ws in _connections: _connections.remove(ws)`。做了存在性判断，因此**重复调用或对未登记的连接调用都安全**（不抛 `ValueError`）。

**唯一调用点**：`api/routes/ws.py:57`，位于 `except WebSocketDisconnect:` 分支内。

### 4.7 `_safe_send(ws, text)`（`:54-59`）— `async`

私有协程。`:56-59`：`try: await ws.send_text(text)` / `except Exception: pass`。docstring `:55`「单条发送，连接已关闭时静默忽略」。**捕获的是宽泛的 `Exception`**，任何发送失败（连接已关闭、对端断开、序列化后写入失败）都被吞掉，不记日志、不上抛。

### 4.8 `broadcast(event)`（`:62-71`）— 同步

对外主入口，docstring `:63`「从同步代码广播事件；投递失败静默忽略，不影响业务请求」。执行顺序：

1. `:64-65` **快速短路**：`if not _connections or _loop is None: return`。无任何连接、或从未建立过连接（`_loop` 仍为 `None`）时直接返回，**不做 JSON 序列化**。
2. `:66` `text = json.dumps(event, ensure_ascii=False)` —— **只序列化一次**，所有连接共用同一份字符串；`ensure_ascii=False` 保证中文昵称与动态文案原样输出（不转 `\uXXXX`）。
3. `:67` `for ws in list(_connections)` —— 对连接表做**快照拷贝**再遍历，因此遍历过程中若其它线程 `append` / `remove`，不会触发 `RuntimeError`，也不会漏掉/重复处理（新连接本轮可能收不到，属可接受行为）。
4. `:68-71` 逐个 `asyncio.run_coroutine_threadsafe(_safe_send(ws, text), _loop)`，外层再套 `try/except Exception: pass`。

**关键设计点**：`run_coroutine_threadsafe` 返回的 `concurrent.futures.Future` **被丢弃、不 `.result()`**，即广播是**「投递即返回」的 fire-and-forget**，业务请求线程不等待任何一条消息真正发出。这正是 docstring `:3-4` 所说的「不阻塞业务请求」。

**心跳处理**：本文件**不发送任何心跳帧**，也没有超时/空闲清理逻辑。客户端消息由 `api/routes/ws.py:53-55` 的 `while True: await ws.receive_text()` 接收后**统一忽略**（该行注释「客户端心跳等消息统一忽略」）。

## 5. 输入与输出

| 名称 | 入参 | 返回 | 异常 |
|---|---|---|---|
| `_now_iso` | 无 | `str`，UTC naive ISO 格式 | 无 |
| `build_event` | `reason: str`、`user_id: int` | `dict`（4 键，见 §4.3） | 无 |
| `build_activity` | `event_type: str`、`user_id: int`、`nickname: str`、`text: str` | `dict`（6 键，见 §4.4） | 无 |
| `connect` | `ws: WebSocket` | `None`（副作用：`accept()` + 写 `_loop` + 追加 `_connections`） | `ws.accept()` 自身的异常**未捕获**，会上抛给路由 |
| `disconnect` | `ws: WebSocket` | `None`（副作用：从 `_connections` 移除） | 无（有存在性判断） |
| `_safe_send` | `ws: WebSocket`、`text: str` | `None` | **无**（`:56-59` 全捕获） |
| `broadcast` | `event: dict` | `None` | **无**（`:70-71` 捕获投递异常）；`json.dumps` 若遇到不可序列化对象会在 `:66` 抛 `TypeError`，**该行不在 try 内**，会上抛到调用方 |

**输出格式**：所有消息都是**单帧文本**（`send_text`），内容为 `json.dumps(event, ensure_ascii=False)`。

**两类消息的完整载荷**：

```jsonc
// data_changed —— 由 build_event 构造
{"type": "data_changed", "reason": "sport.sync", "user_id": 345, "at": "2026-10-17T11:06:10.123456"}

// activity —— 由 build_activity 构造
{"type": "activity", "eventType": "DAILY_GOAL", "userId": 345, "nickname": "长**", "text": "…", "at": "2026-10-17T11:06:10.123456"}
```

（`nickname` 是否脱敏由 `settings.ACTIVITY_MASK_NICKNAME` 决定，处理在**调用方** `services/event_service.py:124-125`，本文件不做脱敏。上例仅示意结构，非真实数据。）

**WebSocket 关闭码**：由 `api/routes/ws.py` 产生，**本文件不涉及**：4401（令牌无效/用户不存在）、4403（账号停用或管理员授权被撤销）。

**本文件不产生任何 HTTP 状态码、不写数据库、不抛业务异常。**

## 6. 依赖关系

**上游依赖**：标准库 `asyncio`（`:7`）、`json`（`:8`）、`datetime`（`:9`）、`typing`（`:10`）；第三方 `fastapi.WebSocket`（`:12`）。**不 import 项目内任何模块** —— 特别地，**不依赖 `core/config.py`、不依赖 `core/database.py`、不依赖任何 service**，符合 `backend/AGENTS.md` §3.1「core 不 import 业务模块」。

**被谁依赖 —— 全部 9 个导入方**（`grep -rn "from app.core import ws" backend` 实测，均以 `as ws_manager` 别名导入）：

| 导入方 | import 行 | 使用的函数 |
|---|---|---|
| `app/api/routes/ws.py` | `:10` | `connect`（`:51`）、`disconnect`（`:57`）—— **唯一使用连接管理 API 的模块** |
| `app/services/event_service.py` | `:15` | `broadcast` + `build_activity`（`:126-128`，在 `record()` 内） |
| `app/api/routes/auth.py` | `:7` | `broadcast` + `build_event`（`:26` 封装为 `_after_sign_in`，`:103`、`:122`） |
| `app/api/routes/sport.py` | `:8` | `broadcast` + `build_event`（`:49`、`:81`） |
| `app/api/routes/quiz.py` | `:8` | `broadcast` + `build_event`（`:52`、`:70`） |
| `app/api/routes/march.py` | `:6` | `broadcast` + `build_event`（`:72`） |
| `app/api/routes/medal.py` | `:6` | `broadcast` + `build_event`（`:31`） |
| `app/api/routes/org.py` | `:8` | `broadcast` + `build_event`（`:81`） |
| `app/api/routes/admin.py` | `:17` | `broadcast` + `build_event`（`:819`） |

**与 `api/routes/ws.py` 的关系**：路由模块负责 ① 端点声明（`WS /api/ws/updates`，令牌走 query string）② 鉴权与关闭码 ③ 保活循环 ④ 断连时调用 `disconnect`；本文件负责 ① 连接表 ② 事件循环引用 ③ 消息构造 ④ 跨线程广播。**连接表只被 `connect` / `disconnect` / `broadcast` 三个函数触碰，其它模块不直接操作 `_connections`**；`grep -rn "core import ws\|core\.ws" backend/test/` 零命中，测试脚本亦不直接访问本文件的私有变量。

**消费端**（不在本文件内，供理解广播去向）：管理后台 `admin/src/utils/liveUpdates.ts`（`useLiveUpdates`，800ms 防抖后重拉 REST）；小程序 `frontend/services/ws.js`，但 `pages/home/home.js` 的 `handleWsMessage` **只处理 `type === 'activity'`**，`data_changed` 被忽略（详见 `.qoder/ARCHITECTURE.md` §6.4）。

**数据库表**：无。`activity` 消息对应的落库在 `services/event_service.py`（写 `user_event` 表），**不在本文件**。

## 7. 业务规则

1. **`data_changed` 不携带业务数据**（docstring `:24`）。设计取舍见 `.qoder/ARCHITECTURE.md` §6.3：避免「推送的数据与随后拉取的数据不一致」，也避免在广播路径上做权限过滤 —— 客户端收到通知后按自己的权限重新查询。**因此本文件不做任何按用户/按菜单的消息过滤，所有连接收到完全相同的内容。**
2. **广播是尽力而为（best-effort），失败静默**：`:64-65` 无连接时跳过、`:58-59` 发送失败吞掉、`:70-71` 投递失败吞掉。**广播失败绝不影响业务请求的成功与事务提交** —— 所有调用点都在业务写入（含 `db.commit()`）之后才广播。
3. **广播无持久化、无重放、无离线补偿**：断连期间的事件永久丢失，客户端重连后必须自行全量刷新（`.qoder/ARCHITECTURE.md` §6.5）。
4. **代码中实际出现的 10 种 `reason` 取值**（grep 实测，`data_changed` 的 `reason` 无枚举定义、无校验，纯约定字符串）：

| `reason` | 触发接口（HTTP 方法 + 完整路径） | 广播代码位置 |
|---|---|---|
| `auth.login` | `POST /api/auth/login`（`auth.py:29-30`） | `auth.py:43` → `_after_sign_in`（`:25-26`） |
| `auth.onboard` | `POST /api/auth/onboard`（`auth.py:63-64`，仅首次建号时；已入驻重复提交发 `auth.login`） | `auth.py:83` → `_after_sign_in` |
| `auth.nickname` | `PUT /api/auth/nickname`（`auth.py:93`）、`PUT /api/auth/nickname/initial`（`auth.py:112`） | `auth.py:103`、`auth.py:122` |
| `sport.sync` | `POST /api/sport/sync`（`sport.py:29-30`） | `sport.py:49` |
| `sport.add` | `POST /api/sport/add`（`sport.py:73-74`，手动补步，注释标「演示用」） | `sport.py:81` |
| `march.light-up` | `POST /api/march/light-up`（`march.py:67-68`） | `march.py:72` |
| `quiz.answer` | `POST /api/quiz/answer`（`quiz.py:39-40`） | `quiz.py:52` |
| `quiz.reset` | `POST /api/quiz/reset`（`quiz.py:67-68`，注释标「调试用」） | `quiz.py:70` |
| `medal.check` | `POST /api/medal/check`（`medal.py:26-27`） | `medal.py:31` |
| `org.select` | `POST /api/org/select`（`org.py:58-59`）、`PUT /api/admin/users/{user_id}/org`（`admin.py:800-805`，仅 `changed` 为真时广播） | `org.py:81`、`admin.py:819` |

   `activity` 类消息的 `eventType` 取值不由本文件决定，来自 `services/event_service.py` 的 `build_text(event_type, data)` 与事件常量（`FIRST_STEP` / `DAILY_GOAL` / `NODE_UNLOCK` / `BADGE_UNLOCK` 等，见提交 `be7e126` 的说明）。
5. **`api/routes/ws.py:3-5` 的模块 docstring 只列举了 6 类触发场景**（步数同步、答题提交、节点点亮、组织选定、登录、勋章发放），**未包含** `auth.onboard`、`auth.nickname`、`sport.add`、`quiz.reset` 四类。上表以代码为准，该 docstring 属描述不完整（非功能缺陷）。
6. **单进程假设**：`_connections` 是进程级变量，多进程部署（如 `gunicorn -w N`）会导致广播只命中同进程的连接。当前生产为单进程（进程管理方式**待确认**，见 `.qoder/ARCHITECTURE.md` §6.5、§16 第 3 项）。

## 8. 修改约束

- **`broadcast` 必须保持同步签名**。全部 11 个调用点都在 `def`（同步）路由或同步 service 中，改为 `async def` 会要求所有调用方加 `await`，而同步路由内无法 `await`。
- **不得删除 `:67` 的 `list(_connections)` 快照**。直接遍历 `_connections` 时，若 `disconnect` 在遍历中被调用会抛 `RuntimeError: list changed size during iteration`。
- **不得把 `:64-65` 的短路条件去掉**。`_loop is None` 时 `run_coroutine_threadsafe` 会抛 `TypeError`；虽然 `:70-71` 能兜住，但会为每个连接产生一次无谓的异常构造。
- **`at` 字段的格式是已修复过的前后端契约**（提交 `7607d7b`，BUG-004）：必须是 `datetime.utcnow().isoformat()` 形式的 UTC naive ISO 字符串，**不得改回毫秒整数**，也不得加时区后缀 —— 管理后台 `admin/src/utils/format.ts` 与小程序 `frontend/utils/util.js` 的 `parseUtc` 按无后缀 UTC 解析（`.qoder/ARCHITECTURE.md` §4.5）。
- **两个 `build_*` 函数的键名风格不一致（`user_id` vs `userId`）是既成契约**，客户端已按各自风格取值；统一风格属**破坏性变更**，需同步改管理后台 `liveUpdates.ts` 与小程序 `home.js`。
- **不得在本文件内加数据库查询或 import service**。当前零项目内依赖是 `core` 层的架构约束（`backend/AGENTS.md` §3.1）；`activity` 消息的昵称脱敏与文案生成都刻意放在调用方 `event_service.py`。
- **`connect` 会覆写 `_loop`（`:44`）**：若未来引入多事件循环（多进程 / 多 app 实例），此处需重新设计。当前单循环下无害。
- **新增 `reason` 值时**：本文件不做枚举校验，但应同步 §7 表格与 `api/routes/ws.py` 的模块 docstring，否则管理后台无法据此决定是否重拉。
- **生产环境 WebSocket 当前不可用**（`.qoder/ARCHITECTURE.md` §12.3）：nginx 未转发 `Upgrade` / `Connection` 头且缺 `proxy_http_version 1.1`，叠加微信公众平台未配置 socket 合法域名。**这是部署侧缺陷，不需要改本文件**；排查线上「WS 收不到消息」时应先确认该问题，而非怀疑广播逻辑。

## 9. 当前实现状态

**已实现**：

- 连接登记与移除（`connect` / `disconnect`），带存在性判断，重复调用安全。
- 跨线程 fire-and-forget 广播（`broadcast` + `_safe_send` + `run_coroutine_threadsafe`），不阻塞业务请求。
- 两类消息构造（`build_event` / `build_activity`），`at` 字段统一为 ISO 字符串。
- 遍历快照防并发修改、单次序列化复用、`ensure_ascii=False` 中文原样输出。
- 全部 6 个模块级名称中，5 个（`_now_iso` / `build_event` / `build_activity` / `connect` / `disconnect` / `broadcast`）均有真实调用者。

**存在问题 / 技术债**：

1. **`:10` 导入了未使用的 `Any`**（`from typing import Any, List, Optional`）。全文件仅这一处出现 `Any`（grep 计数 = 1），属死导入，自提交 `82af32c` 建立文件起即存在。**不影响功能**，按根 `agents.md` §2.2「拒绝冗余代码」可在下次触碰本文件时清理。
2. **`disconnect` 只在 `WebSocketDisconnect` 分支被调用**（`api/routes/ws.py:56-57`）。若保活循环因其它异常退出（例如 `receive_text()` 抛非 `WebSocketDisconnect` 的异常），连接**不会从 `_connections` 移除**，形成僵尸条目。后果被 `_safe_send` 的静默捕获（`:58-59`）掩盖 —— 发送失败不报错，但 `_connections` 会单调增长，且 `:64` 的「有连接」判断会因僵尸条目而误判为真，导致每次广播都做一次无用的 JSON 序列化与投递。**属真实存在的资源泄漏路径，当前无清理机制、无上限。**
3. **无服务端心跳、无空闲超时**：连接存活完全依赖客户端行为（小程序 `frontend/services/ws.js` 有 30 秒空闲主动关闭，管理后台 `liveUpdates.ts` 有指数退避重连）。半开连接（TCP 未断但对端已消失）无法被检测。
4. **`_safe_send` 与 `broadcast` 均吞掉全部异常且不记日志**（`:58-59`、`:70-71`）：线上无法观测广播失败率。项目未配置结构化日志框架（`.qoder/ARCHITECTURE.md` §10.3），故此处也无从落盘。
5. **单进程内存态**：无法水平扩容，重启即丢全部连接（见 §7 第 6 条）。
6. **`json.dumps` 在 `:66` 不在 try 内**：若某个 `build_*` 之外的调用方传入含不可序列化对象的 dict，异常会上抛到业务路由。当前全部调用点都只用 `build_event` / `build_activity` 构造（值类型为 `str` / `int`），不会触发。

**待开发**：无规划中的未完成能力。若未来需要多进程部署，需引入 Redis Pub/Sub 或等价的消息总线替换 `_connections`（`.qoder/ARCHITECTURE.md` §15 第 1 项列为已知限制，当前未实施）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/core/ws.py`（3 条提交，全部列出），验证结论对照 `docs/迭代记录.md`。

### 2026-10-08

- 需求：第一轮全链路端到端测试记录 4 处缺陷，其中 BUG-004 为「WS 时间戳契约」—— WS 消息的 `at` 用毫秒整数，与 REST 接口 `event_time` 的 ISO 字符串格式不一致，管理后台需要两套解析逻辑。
- 修改内容：提交 `7607d7b`。`:9` 的 `import time` 改为 `from datetime import datetime`；私有函数 `_now_ms() -> int`（`int(time.time() * 1000)`）替换为 `_now_iso() -> str`（`datetime.utcnow().isoformat()`，现 `:18-20`）；`build_event` 与 `build_activity` 的 `at` 值随之改变。**连接管理与广播逻辑（`connect` / `disconnect` / `_safe_send` / `broadcast`）未改动。**
- 关联文件：`admin/src/utils/liveUpdates.ts`、`admin/src/views/` 下消费动态流的页面、`docs/测试报告.md`；同批修复的另 3 处为组织主键自增（BUG-001）、答题题目归属校验（BUG-002）、补步下限（BUG-003）。
- 测试结果：修复后复测轮通过，详见 `docs/测试报告.md` 第二轮。（来源：`docs/迭代记录.md` 2026-10-08「修复全链路测试发现的 4 处缺陷并复测回归」条目的「验证」字段）

### 2026-10-01（23:39）

- 需求：统一事件系统与连续行军机制 —— 管理端驾驶舱 / 大屏需要实时滚动的「动态流」，展示用户完成事件的文案与昵称，而不仅是「数据变了」的通知。
- 修改内容：提交 `be7e126`。新增 `build_activity(event_type, user_id, nickname, text)`（现 `:28-37`），返回 camelCase 6 键字典，`at` 当时仍为 `_now_ms()`。文件由 59 行增至 71 行的结构基础（当前 71 行是 `7607d7b` 等量替换后的结果）。
- 关联文件：`app/services/event_service.py`（新增，`record()` 内调用 `broadcast(build_activity(...))`）、`app/services/streak_service.py`（新增）、`app/models/models.py`（`user_event` 表）、`docker/init/005_upgrade.sql`、`app/services/medal_service.py`。
- 测试结果：S2 冒烟脚本 8/8 通过 + 验收报告。（来源：提交信息正文）

### 2026-10-01（17:52）

- 需求：管理后台需要实时感知小程序侧的数据写入，替代轮询。
- 修改内容：提交 `82af32c`。**新建文件**，59 行：`_connections` / `_loop` 模块级状态、`_now_ms()`、`build_event()`、`connect()`、`disconnect()`、`_safe_send()`、`broadcast()`。跨线程 `run_coroutine_threadsafe` 投递方案、`list(_connections)` 快照遍历、双层静默异常吞掉等设计**自建立至今未变**。当时的 `:10` 就写入了 `from typing import Any, List, Optional`，其中 `Any` 从未被使用（见 §9 第 1 条）。
- 关联文件：`app/api/routes/ws.py`（新增，`WS /api/ws/updates` 端点）、`app/api/routes/sport.py`、`march.py`、`quiz.py`、`medal.py`、`org.py`、`app/main.py`（注册 `ws.router`）。
- 测试结果：待确认（`docs/迭代记录.md` 该条目只有「内容：步数/点亮/答题/勋章/组织操作实时推送管理端」，无「验证」字段；提交信息正文亦未记录测试结论）。
