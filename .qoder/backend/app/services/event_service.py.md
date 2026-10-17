# event_service.py

## 1. 文件路径
`backend/app/services/event_service.py`

## 2. 文件职责
统一业务事件的**唯一写入与读取入口**：把运动 / 答题 / 点亮 / 章节完成 / 勋章 / 连续行军 / 完成长征等重要行为落到 `user_event` 表，按事件类型生成对外展示文案，并在提交后向所有已连接的 WebSocket 客户端广播 `activity` 消息（`backend/app/services/event_service.py:1-9`、`:106-129`）。

全仓 `user_event` 的**唯一写入点**是本文件的 `record()`——在 `backend/app/` 下 grep `UserEvent(` 只命中 `backend/app/services/event_service.py:114`。读取方除本文件外只有 `backend/app/services/profile_service.py:187-189`（按 user_id 直查时间轴）。

## 3. 业务需求
- **实时行军动态（需求 §8.3/§8.5）**：小程序首页「⚡实时行军卡」的 REST 快照走 `GET /api/broadcast/activities`（`backend/app/api/routes/broadcast.py:19-26`），实时增量走 WS `activity` 消息；管理端驾驶舱/大屏动态流走 `GET /api/admin/activities` 与 `GET /api/admin/screen`（`backend/app/api/routes/admin.py:221-230`、`:233-240`）。三处共用 `build_text()` 文案，即 docstring `:5` 所说「管理端实时动态通过 WebSocket『activity』消息推送同一份文案」。
- **隐私边界（需求 §8.5）**：对外只下发昵称 / 行为文案 / 事件类型与时间，不含 `user_id`、openid 与事件参数（`:90-91` 注释、`backend/app/schemas/schemas.py:714` 注释）；`ACTIVITY_MASK_NICKNAME` 开启时昵称脱敏为「王\*明」形态（`mask_nickname()`，`:63-72`）。开关的生产取值**待确认**（`.qoder/REQUIREMENTS.md` §14 待确认项 4）。
- **一次性成就去重**：`STREAK_*`、`TOTAL_STEPS_*` 以事件表为去重依据（`has_event()`，`:53-60`）。
- **V2.0 积分口径变更**：`2f3f333`（2026-10-13）起里程碑与点亮不再发放积分，事件仅作成就记录（`:19` 注释由「达成时发放积分并写 STREAK_* 事件」改为「达成时写 STREAK_* 事件」，同提交删除 `MILESTONE_POINTS` 常量）。
- 需求条目汇总见 `.qoder/REQUIREMENTS.md`；WebSocket 机制见 `.qoder/ARCHITECTURE.md` §6（本文档只引用不展开，连接管理器建档见 `.qoder/backend/app/core/ws.py.md`）。

## 4. 核心功能

### 4.1 常量 `STREAK_MILESTONES`（`:19-20`）
`[3, 7, 14, 30, 60]`（天）。达成时由 `backend/app/services/streak_service.py:97-102` 写 `STREAK_{n}` 事件。三个外部消费方：
- `backend/app/services/streak_service.py:97`（里程碑事件判定）；
- `backend/app/services/sport_service.py:219-221`（取「下一个大于当前连续天数」的里程碑下发给小程序）；
- `backend/app/services/profile_service.py:59-60`（成就画像：`achievement_v = medal_ratio*70 + 里程碑达成数/len(STREAK_MILESTONES)*30`）。

### 4.2 `build_text(event_type, data=None) -> str`（`:23-50`）
纯函数，按事件类型生成中文文案；`data` 为 `user_event.event_data`（JSON）。逐分支：

| 行号 | 事件类型 | 文案 | 取用的 `data` 键 |
|---|---|---|---|
| `:26-27` | `FIRST_STEP` | 首次完成运动同步，迈出长征第一步 | 无 |
| `:28-29` | `DAILY_GOAL` | 完成当日行军目标（N 步），连续行军 M 天 | `steps`（默认 0）、`streak`（默认 1） |
| `:30-31` | `NODE_UNLOCK` | 点亮「节点名」 | `nodeName` |
| `:32-33` | `CHAPTER_COMPLETE` | 完成长征章节「章标题」 | `chapterName` |
| `:34-35` | `BADGE_UNLOCK` | 获得勋章「勋章名」 | `medalName` |
| `:36-37` | `QUIZ_COMPLETE` | 完成今日答题，得分 N | `score` |
| `:38-39` | `QUIZ_FULL_SCORE` | 今日答题满分通关 | 无 |
| `:40-41` | `STREAK_*`（前缀匹配） | 连续行军 N 天达成 | `days`，缺省回退 `event_type[7:]`（即从类型名截出天数） |
| `:42-43` | `STEP_10000` | 单日步数突破 10,000 | 无 |
| `:44-45` | `TOTAL_STEPS_100000` | 累计步数突破 100,000 | 无 |
| `:46-47` | `TOTAL_STEPS_500000` | 累计步数突破 500,000 | 无 |
| `:48-49` | `COMPLETE_ROUTE` | 完成长征路线，全部节点点亮 | 无 |
| `:50` | 其它 | **原样返回 `event_type` 字符串** | — |

`build_text` 的外部调用方：`backend/app/services/dashboard_service.py:149`（管理端动态）、`backend/app/services/profile_service.py:197`（我的成就时间轴），以及本文件 `:100`、`:127`。

### 4.3 `has_event(db, user_id, event_type) -> bool`（`:53-60`）
`SELECT id ... WHERE user_id=? AND event_type=? LIMIT 1`，命中 `user_event(user_id, event_type)` 复合索引（`backend/app/models/models.py:375`，由 `docker/init/012_perf_indexes.sql` 建立，见 `docs/迭代记录.md` `f59892e` 条目）。调用方：`backend/app/services/sport_service.py:66`、`backend/app/services/streak_service.py:99`。

### 4.4 `mask_nickname(nickname) -> str`（`:63-72`）
昵称脱敏，规则（`:65-72`）：先 `strip()`；空串 → `"战友"`；长度 1 → 原样；长度 2 → 首字 + `*`；长度 ≥3 → 首字 + `*` + 末字。按 Python 字符（码点）计数，非字节。除本文件 `:99`、`:125` 外，仅测试脚本 `backend/test/p1_activities.py:133` 直接 import 校验。

### 4.5 `recent_events(db, limit) -> List[Tuple[UserEvent, str]]`（`:75-84`）
单次外连接查询取「最近 limit 条事件 + 用户昵称」：`UserEvent` LEFT OUTER JOIN `User`（`:79`），排序 `event_time DESC, id DESC`（`:80`），昵称 `None` 归一为空串（`:84`）。由 `f59892e` 从 `list_public_activities` 中抽出，供管理端动态复用（`backend/app/services/dashboard_service.py:152`），消除原先「查事件 + 按 id 批量查昵称」的两段式写法。

### 4.6 `list_public_activities(db, limit=10) -> List[Dict]`（`:87-103`）
小程序实时行军动态。`:93` 读 `get_settings().ACTIVITY_MASK_NICKNAME` 决定是否脱敏（`:99`），`:100` 用 `build_text(r.event_type, r.event_data or {})` 生成文案。返回 dict 键固定为 `id / event_type / event_time / nickname / text`（`:95-101`）——**不含 `user_id`、不含 `event_data`**，与 `backend/app/schemas/schemas.py:713-720` 的 `ActivityItemOut` 一一对应，经 `CamelModel` 输出为 camelCase。

### 4.7 `record(db, user_id, event_type, data=None, event_time=None) -> UserEvent`（`:106-129`）
唯一写入 + 广播路径，四步：
1. `:114-119` 构造 `UserEvent`；`event_data` 缺省 `{}`，`event_time` 缺省 `datetime.utcnow()`（UTC naive，与库内时间列同口径）。
2. `:120-121` `db.add(event)` + **`db.commit()`**（事务边界见 §7）。
3. `:123-125` 提交后回查 `User.nickname`（只取 scalar 列），按开关脱敏。
4. `:126-128` `ws_manager.broadcast(ws_manager.build_activity(event_type, user_id, nickname, build_text(...)))`，`:129` 返回 `event`。

**`event_time` 形参当前无任何调用方传入**（在 `backend/` 下 grep `event_time=` 只命中 `backend/app/services/event_service.py:118` 自身），属预留能力；返回值 `event` 亦被全部 11 个调用点忽略。

## 5. 输入与输出

| 函数 | 输入 | 输出 | 异常 |
|---|---|---|---|
| `build_text` | `event_type: str`、`data: Optional[dict]` | `str`（未知类型原样返回类型名） | 无（`data=None` 由 `:25` 归一为 `{}`） |
| `has_event` | `db`、`user_id: int`、`event_type: str` | `bool` | 无 |
| `mask_nickname` | `nickname: str`（可为 `None`/空） | `str` | 无 |
| `recent_events` | `db`、`limit: int` | `List[Tuple[UserEvent, str]]`（倒序） | 无；`limit` 不做上下界收敛，由调用方负责 |
| `list_public_activities` | `db`、`limit: int = 10` | `List[Dict]`，键见 §4.6 | 无 |
| `record` | `db`、`user_id`、`event_type`、`data`、`event_time` | `UserEvent`（已提交实例） | **不捕获任何异常**：`db.commit()` 失败会向上抛（见 §9） |

对外 HTTP/WS 出口与错误码（本文件不直接定义路由，均为调用方）：

| 出口 | 方法与路径 | 权限依赖 | 参数与限流 | 响应模型 |
|---|---|---|---|---|
| 小程序动态快照 | `GET /api/broadcast/activities` | `Depends(get_current_user)`（`backend/app/api/routes/broadcast.py:22`） | `limit` 默认 10，路由内 `max(1, min(limit, 50))` 收敛（`backend/app/api/routes/broadcast.py:26`） | `ActivitiesOut` |
| 管理端动态 | `GET /api/admin/activities` | `require_menu("dashboard")`（`backend/app/api/routes/admin.py:225`） | `limit: Query(50, ge=1, le=200)`（`:228`） | `AdminActivityListOut` |
| 管理端大屏 | `GET /api/admin/screen` | `require_menu("screen")`（`backend/app/api/routes/admin.py:237`） | 内部固定取 20 条（`backend/app/services/dashboard_service.py:163`） | `AdminScreenOut` |
| WS 实时增量 | `WS /api/ws/updates` | 令牌走 query；4401/4403 关闭码（`backend/app/api/routes/ws.py:30-50`） | — | `activity` 消息 |

**管理端与小程序动态的字段差异（事实）**：`backend/app/services/dashboard_service.py:140-153` 额外下发 `user_id` 与原始 `data`，且**不做昵称脱敏**；小程序侧 `list_public_activities` 两者都不下发且按开关脱敏。管理端走 RBAC 鉴权，属预期差异。

**WS `activity` 消息含 `userId`**：`backend/app/core/ws.py:28-37` 的 `build_activity` 载荷为 `{type, eventType, userId, nickname, text, at}`（camelCase）。而 `WS /api/ws/updates` **同时接受小程序用户令牌**（`backend/app/api/routes/ws.py:28`、`:43-50`），即小程序客户端能收到含其他用户 `userId` 的 `activity` 消息；小程序端只取 `icon/nickname/text/timeText`、忽略 `userId`（`frontend/services/broadcast.js:11-20`、`frontend/pages/home/home.js:142-146`），管理端则消费 `userId`（`admin/src/utils/liveUpdates.ts:40-46`）。这与 REST 侧「不含 user_id」的隐私口径不一致，属现状记录（是否需收敛**待确认**）。

## 6. 依赖关系

**依赖（`:10-17`）**
- 标准库 `datetime`、`typing`；SQLAlchemy `Session`。
- `app.core.ws`（别名 `ws_manager`，`:15`）：`broadcast()` 与 `build_activity()`。跨线程投递与静默失败语义见 `.qoder/backend/app/core/ws.py.md`。
- `app.core.config.get_settings`（`:16`）——**全仓唯一用 `get_settings()` 而非 `settings` 单例的消费方**（见 §8）。
- `app.models.models.User` / `UserEvent`（`:17`）：表 `user_event`（`backend/app/models/models.py:365-381`）、`users`（`:179-205`）。
- **不依赖任何其它 service**，是 services 层依赖图的叶子（被 6 个 service 反向依赖）。

**被依赖（写入方，11 个调用点）**

| 事件类型 | 调用位置 | 是否先查 `has_event` 去重 |
|---|---|---|
| `FIRST_STEP` | `backend/app/services/sport_service.py:57` | 否（靠「该用户首条 `daily_sport`」条件，`:189`） |
| `STEP_10000` | `backend/app/services/sport_service.py:62` | 否（靠当日步数跨越 10000 的边界条件，`:61`） |
| `TOTAL_STEPS_100000` / `TOTAL_STEPS_500000` | `backend/app/services/sport_service.py:67` | **是**（`:66`） |
| `DAILY_GOAL` | `backend/app/services/streak_service.py:93` | 否（靠「达标状态发生翻转」条件，`:78-80`） |
| `STREAK_3/7/14/30/60` | `backend/app/services/streak_service.py:102` | **是**（`:99-101`） |
| `BADGE_UNLOCK` | `backend/app/services/medal_service.py:103` | 否（靠 `user_medals` 已拥有集合，`:94`） |
| `QUIZ_COMPLETE` | `backend/app/services/quiz_service.py:266` | 否（靠 `quiz_records` 每日唯一约束，`:258-264`） |
| `QUIZ_FULL_SCORE` | `backend/app/services/quiz_service.py:271` | 否（同上） |
| `NODE_UNLOCK` | `backend/app/services/march_service.py:410` | 否（靠 `lit_nodes` 未点亮集合，`:374`） |
| `COMPLETE_ROUTE` | `backend/app/services/march_service.py:417` | 否（靠「本次有新点亮」+ 全部点亮，`:394`、`:416`） |
| `CHAPTER_COMPLETE` | `backend/app/services/march_service.py:424` | 否（靠点亮前后完成集差集，`:369`、`:422`） |

**被依赖（读取方）**：`backend/app/api/routes/broadcast.py:9`、`:26`；`backend/app/services/dashboard_service.py:27`、`:149`、`:152`；`backend/app/services/profile_service.py:22`、`:59-60`、`:197`；`backend/app/services/sport_service.py:220`；`backend/app/services/streak_service.py:19`、`:97`。

**数据库表**：`user_event`（写 + 读）、`users`（只读昵称）。

## 7. 业务规则

- **事务边界：`record()` 自己 `db.commit()`（`:121`）。** 这是本文件最需要注意的一条——它会连带提交**调用方 session 中所有尚未提交的变更**。全部 11 个调用点都遵循 docstring `:7` 的约定「事件在主数据提交后写入」：`backend/app/services/sport_service.py:182` 先 commit 再于 `:188-190` 调 `_after_written`；`backend/app/services/march_service.py:397` 先 commit 再于 `:410`/`:417`/`:424` 写事件；`backend/app/services/quiz_service.py:261` 先 commit 再于 `:266` 写事件；`backend/app/services/medal_service.py:99` 先 commit 再于 `:103` 写事件；`backend/app/services/streak_service.py:81`/`:89` 先 commit 再于 `:93`/`:102` 写事件。因此 `record()` 的 commit 实际上只提交事件行本身。
- **一次 `record()` = 一个独立事务 + 一次 WS 广播。** 批量写事件（如 `light_up_nodes` 一次点亮多节点）会产生 N 次 commit 与 N 次广播，不具原子性；中途失败会留下「部分事件已写」的状态。
- **广播在 commit 之后**（`:121` → `:126`），故 WS 客户端收到 `activity` 时数据必已落库；反之 `broadcast()` 内部静默吞掉所有异常（`backend/app/core/ws.py:62-71`），无连接或事件循环不可用时直接 return，不影响业务。
- **无消息重放**：WS 断连期间的事件永久丢失，客户端重连后靠 REST 快照（`GET /api/broadcast/activities`）补齐（`.qoder/ARCHITECTURE.md` §6.5；小程序 `frontend/pages/home/home.js:124` 在 `onShow` 里 `refreshAll()`）。
- **消息持久化**：`activity` 消息本身不持久化，但其内容全部来自已落库的 `user_event` 行，故「持久化的是事件、不是消息」。
- **去重责任在调用方**：本文件不做任何幂等判断，`record()` 被调两次就写两行。需要一次性的成就必须先 `has_event()`。
- **排序口径**：`event_time DESC, id DESC`（`:80`）。`event_time` 为 UTC naive（`:118`），前端按 ISO 串转相对时间（`frontend/services/broadcast.js:12`、`:18`）。
- **脱敏是展示层行为，不改库**：`user_event` 与 `users.nickname` 始终存明文，脱敏只发生在 `:99`（REST）与 `:125`（WS）两个出口。

## 8. 修改约束

- **事件类型字符串是跨端契约**：`frontend/utils/util.js:68-80` 的 `EVENT_ICONS` 按 `eventType` 精确匹配取图标，`:82-86` 对 `STREAK_` 前缀特殊处理，未命中回落 `📌`。新增/改名事件类型必须同步该映射，否则小程序动态流只显示通用图钉。
- **`build_text()` 是文案唯一来源**（`:24` docstring「足迹时间轴与管理端动态共用」）。禁止在路由层或前端另写文案，否则三处出口会出现同一事件不同措辞。
- **`:50` 的兜底 `return event_type`** 意味着忘记加分支不会报错、只会把英文常量直接展示给用户；新增事件类型时必须同时补 `build_text` 分支。
- **`STREAK_MILESTONES` 不得为空列表**：`backend/app/services/profile_service.py:60` 以 `len(event_service.STREAK_MILESTONES)` 作除数，空列表会 `ZeroDivisionError`。
- **隐私边界不得放宽**：`list_public_activities` 的返回键集合（`:95-101`）与 `ActivityItemOut`（`backend/app/schemas/schemas.py:713-720`）绑定；加入 `user_id` / `event_data` 即违反需求 §8.5（`:90-91` 注释）。
- **`get_settings()` 与 `settings` 的写法不一致（现状，须点明）**：本文件 `:16` 写 `from app.core.config import get_settings`，在 `:93`、`:124` 调用 `get_settings().ACTIVITY_MASK_NICKNAME`；而 `backend/app/services/sport_service.py:21`、`backend/app/services/streak_service.py:16` 等同层模块一律 `from app.core.config import settings` 直接用单例。因 `get_settings` 带 `lru_cache`（`backend/app/core/config.py:110-112`）且模块级 `settings = get_settings()`（`backend/app/core/config.py:115`），两种方式拿到的是**同一实例**，运行期无差异；但测试脚本惯用「直接改写 `settings` 单例属性」来模拟配置（`.qoder/backend/app/core/config.py.md` §6），该手法对本文件同样有效（同一对象）。属可读性/一致性问题，非功能缺陷；`17a4d98` 引入，至今未统一。
- **`datetime.utcnow()` 直写而非 `helpers.now_utc()`**：`:118` 直接用标准库，而同层 `backend/app/services/sport_service.py:129` 用 `now_utc()`（`backend/app/core/helpers.py:12-14`，实现即 `datetime.utcnow()`）。取值等价，风格不统一。
- **`record()` 内不得引入业务判定**：判定逻辑（是否首次、是否跨越阈值）全部留在调用方，本文件只负责落库 + 文案 + 广播。
- 修改本文件后须同步 `.qoder/ARCHITECTURE.md` §6.3（两类 WS 消息）与 `.qoder/backend/app/models/models.py.md`（`user_event` 表说明）。

## 9. 当前实现状态

**已实现**
- 13 类事件文案（含 `STREAK_*` 前缀匹配）与未知类型兜底（`:23-50`）。
- 事件写入 + WS `activity` 广播（`:106-129`），提交后广播、广播失败静默。
- 一次性成就去重查询（`:53-60`），命中 `ix_user_event_user_type` 索引。
- 昵称脱敏（`:63-72`）与 `ACTIVITY_MASK_NICKNAME` 双路生效（REST `:93`/`:99`、WS `:124`/`:125`）。
- 动态流单次外连接查询（`:75-84`），管理端与小程序共用（`f59892e` 去 N+1 结论）。

**存在问题（事实性陈述）**
- **docstring `:7-8` 的「事件写入失败不得影响主流程」在代码中没有任何强制手段**：`record()` 内无 `try/except`，11 个调用点也均未包裹。若 `:121` 的 commit 抛异常，异常会一路上抛到路由层变成 500，而此时**主数据已在此前的 commit 中落库**，形成「主数据成功、接口报错」的不一致。docstring 表达的是设计意图，实现只做到了「事件写在主数据提交之后」（顺序保证），未做到「失败隔离」。
- **docstring `:4` 的「小程序『我的长征足迹』由该表直接生成」与实现口径不符**：`GET /api/march/footprints` 由 `backend/app/services/march_service.py:273-317` 查 `lit_nodes` + `daily_sport` 生成，不读 `user_event`。实际按 `user_event` 生成时间轴的是「我的成就」页（`backend/app/services/profile_service.py:187-197`）。属 docstring 滞后（`be7e126` 写入，`ffd2570` 引入足迹接口后未修订）。
- **`record()` 每条事件多一次 `users` 单列查询**（`:123`）取昵称；批量事件场景（如一次点亮 5 个节点 + 完成 2 章 + 完成路线 = 8 条事件）即 8 次额外 SELECT，加上 `expire_on_commit` 默认开启（`backend/app/core/database.py:51` 未关闭）导致提交后 ORM 属性失效需回读。当前事件量级下未观测到问题，属潜在热点。
- **`backend/app/models/models.py:368-370` 的 `event_type` 取值枚举不全**：漏 `CHAPTER_COMPLETE`（`6a2fae3` 引入）与 `TOTAL_STEPS_500000`。以本文件 `build_text` 分支为准。
- **WS `activity` 载荷含 `userId`，小程序令牌亦可建连**（见 §5 末段）。是否需要在广播路径上按客户端类型过滤——**待确认**。

**待开发**
- 系统级事件通道（非用户维度）：`backend/app/services/march_service.py:241-242` 注明全员目标里程碑的「解锁内容 / 全局动画 / 系统动态」奖励钩子需系统级事件通道，**不在本期**。当前 `user_event.user_id` 为 NOT NULL 外键（`backend/app/models/models.py:378`），无「系统事件」承载方式。
- 事件的分页/按类型筛选查询：当前只有「最近 N 条」一种读法（`:75-84`），管理端 `limit` 上限 200（`backend/app/api/routes/admin.py:228`），无历史翻页能力。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/event_service.py`（5 个提交）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-13
- 需求：V2.0 积分台账重构——总积分 = 步行 + 答题，移除登录/达标/点亮/里程碑积分。
- 修改内容：`2f3f333` 删除 `MILESTONE_POINTS` 常量（原 `{3:5, 7:10, 14:20, 30:30, 60:60}`），`:19` 注释由「达成时发放积分并写 STREAK_* 事件」改为「达成时写 STREAK_* 事件」（1 insertion / 2 deletions）。
- 关联文件：`backend/app/services/points_service.py`、`backend/app/services/sport_service.py`、`backend/app/services/march_service.py`、`backend/app/services/streak_service.py`、`docker/init/017_points_ledger.sql`。
- 测试结果：`docs/迭代记录.md` 该条目记载——SQLite 冒烟 20/20（含 999/1000/1999/20000/25000 步边界、重复同步幂等、legacy 不计入）；openGauss 上 016/017 迁移已执行、回填 92 条步行 + 12 条答题、核对 132 人 111 天差异 0、10 线程并发补步后与台账一致；回归 s11 8/8、s18 14/14、s19 25/25、s6 8/8。同条目并记「s5、s9 依赖旧的首登自动建号，在本地已配置真实 WX 凭证时登录返回 502，这是本次之前就存在的问题」。

### 2026-10-11
- 需求：后端热点查询 SQL 聚合化与去 N+1。
- 修改内容：`f59892e` 新增 `recent_events()`（单次外连接取事件 + 昵称，`:75-84`），`list_public_activities` 改为消费它（原先「查事件 + `User.id.in_(...)` 批量查昵称」两段式）；`record()` 的昵称查询由「取整个 `User` 实体再判空」改为 `db.query(User.nickname).scalar() or ""`（`:123`）；`typing` 导入补 `Tuple`（`:11`）。16 insertions / 19 deletions。
- 关联文件：`backend/app/services/dashboard_service.py`（新增 `get_activities` 复用 `recent_events`）、`docker/init/012_perf_indexes.sql`（含 `user_event(user_id, event_type)` 索引）、`backend/test/docs/s14-hotspot-sql-report.md`。
- 测试结果：`docs/迭代记录.md` 该条目记载——openGauss 已应用 012；e2e_full_flow 178/178、e2e_datasync 23/23、S2–S7、P0/P1/P2、昵称冒烟全部通过；「排行、播报结果与旧实现逐项一致（92 用户 / 20 用户样本）」。

### 2026-10-03
- 需求：实时行军动态 P1-1（需求 §8.3/§8.5）。
- 修改内容：`17a4d98` 新增 `mask_nickname()`（`:63-72`）与 `list_public_activities()`（`:87-103`），新增 `from app.core.config import get_settings`（`:16`）——本文件成为全仓唯一用 `get_settings()` 的消费方；`record()` 内按开关对 WS 广播昵称脱敏（`:124-125`）。46 insertions。
- 关联文件：`backend/app/core/config.py`（新增 `ACTIVITY_MASK_NICKNAME`）、`backend/app/api/routes/broadcast.py`、`frontend/services/ws.js`、`frontend/services/broadcast.js`、`frontend/pages/home/home.js`（实时行军卡）。
- 测试结果：待确认（`docs/迭代记录.md` 该条目未记录验证字段，仅有「内容：公开动态流接口+WS 客户端+首页实时行军卡」）。`17a4d98` 提交信息自述「验证：后端冒烟 7/7、automator 3/3（含 WS 实时置顶），截图 23」；相关测试脚本 `backend/test/p1_activities.py`（`:133` 直接 import `mask_nickname` 断言）。

### 2026-10-02
- 需求：长征章节系统 P0-3（需求 §4）。
- 修改内容：`6a2fae3` 在 `build_text()` 中新增 `CHAPTER_COMPLETE` 分支（`:32-33`，文案「完成长征章节「章标题」」，取 `data.chapterName`）。2 insertions。
- 关联文件：`backend/app/services/march_service.py`（新增 `CHAPTERS` 与 `CHAPTER_COMPLETE` 事件写入）、`frontend/pages/march/march.js`、`frontend/utils/arrivePopup.js`。
- 测试结果：待确认（`docs/迭代记录.md` 该条目未记录验证字段，仅有「内容：5 章配置化划分、章节完成仪式与 CHAPTER_COMPLETE 事件」）。`6a2fae3` 提交信息自述「验证：后端冒烟 10/10、automator 3/3（含重构后回归）、截图 20/21 人工核对；设计文档与测试报告同步」。

### 2026-10-01
- 需求：统一事件系统与连续行军机制（数据模型扩展迁移 005 配套）。
- 修改内容：`be7e126` 创建本文件（85 行）：模块 docstring、`STREAK_MILESTONES`、`MILESTONE_POINTS`（后由 `2f3f333` 删除）、`build_text`（当时 11 个分支，无 `CHAPTER_COMPLETE`）、`has_event`、`record`（当时昵称查询为取整个 `User` 实体，且无脱敏）。
- 关联文件：`backend/app/services/streak_service.py`（同提交新建）、`backend/app/models/models.py`（`UserEvent`）、`docker/init/005_upgrade.sql`、`backend/app/services/sport_service.py`、`backend/app/services/march_service.py`、`backend/app/services/quiz_service.py`、`backend/app/services/medal_service.py`、`backend/test/s2_streak_events.py`（同提交新建，186 行）与报告 `backend/test/docs/s2-events-streak-report.md`。
- 测试结果：待确认（`docs/迭代记录.md` 该条目未记录验证字段，仅有「内容：新增统一事件系统与连续行军机制，勋章体系扩展判定并接入事件链」）。`be7e126` 提交信息自述「新增 S2 冒烟脚本（8/8 通过）与验收报告」。
