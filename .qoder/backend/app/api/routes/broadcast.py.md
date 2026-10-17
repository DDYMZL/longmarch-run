# broadcast.py

## 1. 文件路径

`backend/app/api/routes/broadcast.py`（27 行）

## 2. 文件职责

「今日播报」聚合与「实时行军动态」两个只读端点的路由层，各一行核心逻辑，业务全在 `backend/app/services/broadcast_service.py` 与 `backend/app/services/event_service.py`。

**面向对象（从代码与调用方核实）**：**小程序**，不是管理后台。依据：① 两个端点都挂小程序用户鉴权 `Depends(get_current_user)`（`:15`、`:22`），管理端令牌走的是 `get_current_admin` 体系；② 唯一调用方是 `frontend/services/broadcast.js:27`、`:36`（首页 `frontend/pages/home/home.js:159`、`:161` 消费）；③ `admin/src/` 全目录 grep `broadcast` 无任何 API 调用命中；④ 端点 2 的 summary 自标「实时行军动态（小程序）」（`:19`）。注意 `.qoder/ARCHITECTURE.md:112` 的路由清单把本模块标为「管理后台」，**与上述代码事实不符**（管理端的实时动态走 WebSocket `activity` 消息而非本 REST 接口，见 §7），该总览表条目应更正。

## 3. 业务需求

- 端点 1：需求「功能 6 全局播报 + 功能 7 长征记忆彩蛋」（`broadcast_service.py:1` docstring），`18c2121`（2026-10-02）「新增小程序聚合接口（档案/足迹/日历/播报/知识画像）」交付（`docs/迭代记录.md:808`）。
- 端点 2：需求 §8.3/8.5「实时行军动态」（路由 docstring `:25`），P1-1 批次 `17a4d98`（2026-10-03）交付（`docs/迭代记录.md:728`）。

## 4. 核心功能

**2 个端点**（router 前缀 `/broadcast`，`:11`，`backend/app/main.py:84` 以 `/api` 挂载）：

| # | 方法+路径 | 函数 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| 1 | `GET /api/broadcast/today` | `today` | `:14-16` | `Depends(get_current_user)` | `BroadcastTodayOut` |
| 2 | `GET /api/broadcast/activities` | `activities` | `:19-26` | `Depends(get_current_user)` | `ActivitiesOut` |

### 4.1 `GET /api/broadcast/today`（`:14-16`）

调 `broadcast_service.get_today(db, current.id)`（`backend/app/services/broadcast_service.py:44-107`），返回三段聚合（Schema `backend/app/schemas/schemas.py:685-710`）：

- `global`（全平台今日）：`todayUsers`/`todaySteps`/`todayLitCount`/`todayQuizUsers`/`totalUsers`——单条聚合 SQL 取参与人数/总步数/击败人数（`broadcast_service.py:56-66`），点亮数按本地今日 0 点换算 UTC 比较（`:68-72`）。
- `personal`（当前用户）：`todaySteps`/`beatPercent`（击败百分比 `:76`）/`remainToNext`/`nextNodeName`（复用 `march_service.get_route`，`:78-79`）。
- `memory`（长征记忆彩蛋，可为 null）：优先按当天「月-日」匹配 `route_nodes.historical_time`，无匹配时按年内第几天轮转推荐（`:27-41`）。

### 4.2 `GET /api/broadcast/activities`（`:19-26`）

- 参数：query `limit: int = 10`（`:21`，普通 int 参数，无 Pydantic/Query 约束注解），路由内钳制到 1..50：`max(1, min(limit, 50))`（`:26`）；非法值（如非数字）由 FastAPI 返回 422。
- 调 `event_service.list_public_activities`（`backend/app/services/event_service.py:87-103`）：`user_event` 表倒序取 N 条并外连接 `users` 取昵称（`recent_events:75-84`，单次查询无 N+1），返回条目 `{id, eventType, eventTime, nickname, text}`（`ActivityItemOut`，`schemas.py:713-720`）。
- **隐私边界（需求 §8.5）**：只下发昵称/行为文案/事件类型与时间，**不含 user_id、openid 与事件参数**（`event_service.py:90-91` docstring 与 `:94-102` 实现一致；对比 `IdentityOut` 同款收敛）；配置 `ACTIVITY_MASK_NICKNAME`（`backend/app/core/config.py:99`，默认关）开启时昵称脱敏为「王*明」式（`event_service.mask_nickname:63-72`）。
- 返回裸 dict `{"items": [...]}` 经 `response_model=ActivitiesOut`（`schemas.py:723-724`）序列化——dict→模型转换由 FastAPI 完成，符合「声明 response_model」约束。

## 5. 输入与输出

- 输入：端点 1 无参数；端点 2 仅 `limit`（默认 10，钳制 1..50）。
- 输出：见 §4；均为 `CamelModel` camelCase。
- 错误码：401（令牌缺失/无效，`backend/app/api/deps.py:22-41`）、403+`X-Account-Status: disabled`（账号停用，`deps.py:46-53`）、422（limit 非整数）。无 400/404 业务分支（两个 service 对空数据返回零值/空列表而非报错）。

## 6. 依赖关系

- 依赖：`backend/app/api/deps.py`（get_current_user）、`backend/app/core/database.py`（get_db）、`backend/app/services/broadcast_service.py`、`backend/app/services/event_service.py`、`backend/app/schemas/schemas.py`。
- 间接依赖（经 broadcast_service）：`march_service.get_route`、`core/helpers.py`（today_str/local_to_utc）。
- 被依赖：`backend/app/main.py:84` 注册；小程序 `frontend/services/broadcast.js`（`getToday`/`getActivities`），最终消费页为首页（`frontend/pages/home/home.js:159`、`:161`——动态流失败不阻塞首页主数据）。
- 数据库表（全部只读）：`daily_sport`、`lit_nodes`、`quiz_records`、`users`、`route_nodes`（today）；`user_event` + `users`（activities）。无写操作、无事务提交。
- **未挂活动准入闸门**：两端点仅 `get_current_user`，不带 `require_activity_view`（对照 `backend/app/api/deps.py:79-81`），活动结束后可读性由闸门缺席自然保证；这是现状事实，是否有意为之**待确认**（同批读接口多数挂了 `require_activity_view`）。

## 7. 业务规则

1. **与 WebSocket 推送的关系（同一数据源的两种通道）**：`GET /broadcast/activities` 与 WS `activity` 消息**读同一张 `user_event` 表、用同一个 `build_text` 生成文案**——WS 侧在事件落库时即时广播（`event_service.record:106-129`，`:126-128` 调 `core/ws.py:build_activity`），REST 侧按需拉取最近 N 条（`list_public_activities:87-103`）。分工：REST 负责首屏/回场时的**初始列表与断线补拉**，WS 负责在线期间的**实时增量**；小程序首页把两者经同一视图函数 `toActivityView` 归一（`frontend/services/broadcast.js:8-20` 注释明确两通道字段映射；WS 增量插入动态流顶部、最多 6 条，`frontend/pages/home/home.js:139-146`）。`/broadcast/today` 无 WS 对应消息，仅靠页面 `onShow + refresh()` 重拉（`data_changed` 消息在首页被忽略，`home.js:143` 只处理 `activity`）。
2. **管理端不消费本文件**：管理端驾驶舱/大屏动态流直接用 WS `activity` 消息（`core/ws.py:29` docstring、`admin/src/utils/liveUpdates.ts:1`），无 REST 拉取路径（§2）。
3. `limit` 钳制 1..50 防全量拉取（`:26`），符合根 `agents.md` §2.4 大数据量性能要求；`recent_events` 单次外连接查询避免 N+1（`event_service.py:76-84`）。
4. 「今日」口径为北京时间自然日（`today_str`，`backend/app/core/helpers.py`；`broadcast_service.py:46`）。

## 8. 修改约束

1. 响应结构与 `frontend/services/broadcast.js`、首页消费代码是 camelCase 硬契约（不变量 1），`global` 段经 `Field(alias="global")` 输出（`schemas.py:708`，Python 关键字冲突处理），改字段名需双端同步。
2. `ActivityItemOut` **不得加入 userId/openid/事件参数**——隐私边界是需求 §8.5 的明确要求（`event_service.py:90-91`），WS `activity` 消息含 `userId` 属管理端通道，两者口径不同，勿「对齐」。
3. 路由层保持薄：聚合逻辑在 broadcast_service、事件查询在 event_service，不得上移（`backend/AGENTS.md` §3.1）。
4. 修改动态文案 `build_text` 会同时影响 REST 与 WS 两通道及「我的长征足迹」时间轴（`event_service.py:3-5` docstring），属三处消费的共享逻辑。

## 9. 当前实现状态

- **已实现**：2 个端点均可用；随 `18c2121`、`17a4d98` 交付（验证记录见 §10 与 `docs/迭代记录.md` 对应条目）。
- **存在问题 / 已知事项**：
  1. `.qoder/ARCHITECTURE.md:112` 将本模块面向对象误标为「管理后台」（§2 给出代码证据），待总览文档更正。
  2. 两端点未挂 `require_activity_view` 活动闸门（§6，是否有意待确认）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/broadcast.py`，共 **2 个提交**。按时间倒序。

### 2026-10-03（`17a4d98`，00:45，`docs/迭代记录.md:728`）
- 需求：实时行军动态（P1-1）。
- 修改内容（涉本文件）：新增 `GET /broadcast/activities` 公开动态流接口（limit 钳制 1..50）；同批交付 WS 客户端（`frontend/services/ws.js`）与首页实时行军卡（提交信息）。
- 关联文件：`backend/app/services/event_service.py`、`frontend/services/broadcast.js`、`frontend/pages/home/home.js`。
- 测试结果：见 `docs/迭代记录.md:728` 条目。

### 2026-10-02（`18c2121`，00:12，`docs/迭代记录.md:808`）
- 需求：小程序聚合接口批次（档案/足迹/日历/播报/知识画像）。
- 修改内容（涉本文件）：创建本文件，新增 `GET /broadcast/today` 今日播报聚合。
- 关联文件：`backend/app/services/broadcast_service.py`、`backend/app/api/routes/profile.py` 等同批路由。
- 测试结果：见 `docs/迭代记录.md:808` 条目。
