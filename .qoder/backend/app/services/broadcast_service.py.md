# broadcast_service.py

## 1. 文件路径
`backend/app/services/broadcast_service.py`（107 行）

## 2. 文件职责
「今日播报」聚合的唯一实现：一次请求内把全平台今日数据（`global`）、当前用户今日数据与击败百分比（`personal`）、长征记忆彩蛋节点（`memory`）三段拼成一个 dict 返回（`backend/app/services/broadcast_service.py:44-107`）。**全文件只读**——无 `db.add()`、无 `db.commit()`、无 `db.flush()`、不写任何表。

**范围澄清（与文件名/路由名易混淆之处，务必区分）**：本文件**不涉及 WebSocket，也不涉及实时行军动态流**。路由模块 `backend/app/api/routes/broadcast.py` 的两个端点分属两套互不相干的逻辑：

| 端点 | 实现方 | 是否本文件 |
|---|---|---|
| `GET /api/broadcast/today`（`:14-16`） | `broadcast_service.get_today` | **是** |
| `GET /api/broadcast/activities`（`:19-26`） | `event_service.list_public_activities`（`backend/app/services/event_service.py:87-103`） | 否 |

WS `activity` 消息同样由 `event_service.record()` 在事件落库后广播（`backend/app/services/event_service.py:126-128`），连接管理器在 `backend/app/core/ws.py`。因此「广播的订阅/推送机制、断线重连语义、消息持久化」这三件事**全部不在本文件**：持久化的是 `user_event` 表的**事件行**（不是消息），推送无重放、断连期间的事件靠 REST 快照补齐。详见 `.qoder/backend/app/services/event_service.py.md` §7 与 `.qoder/backend/app/core/ws.py.md`，本文档不重复展开。

## 3. 业务需求
- 需求来源：PRD「**功能 6 每日长征播报 + 功能 7 长征记忆彩蛋**」，接口契约与示例报文见 `docs/upgrade-plan.md:196-207`（该文件按 `.qoder/README.md` §2 属「历史快照，不随代码更新」，但为本功能唯一书面需求出处）。模块 docstring `backend/app/services/broadcast_service.py:1` 直接自标「功能 6 全局播报 + 功能 7 长征记忆彩蛋」。
- 交付批次：`18c2121`（2026-10-02）「新增小程序聚合接口（档案/足迹/日历/播报/知识画像）」（`docs/迭代记录.md` 的 `18c2121` 条目）。
- **`.qoder/REQUIREMENTS.md` 无对应条目**：全文 grep「播报」「长征记忆」「彩蛋」均无命中，属需求清单缺项（现状事实，非本文件问题）。
- 消费方**只有小程序首页**：`frontend/pages/home/home.js:159` 在 `refreshAll` 的 `Promise.all` 中调用 `broadcast.getToday()`。管理端不消费本文件（`admin/src/` 下 grep `broadcast` 无 API 调用命中，佐证见 `.qoder/backend/app/api/routes/broadcast.py.md` §2）。
- 首页布局需求（长征记忆卡与今日行军卡的 `beatPercent`/`remainToNext`）见 `docs/upgrade-plan.md:276`、`frontend/design.md:45`。

## 4. 核心功能

### 4.1 模块级常量与正则
- `:1-6` docstring 声明三段口径，并写明 memory 的规则：「按当天『月-日』匹配 `route_nodes.historical_time`（如「1935年5月29日」），无匹配时按年内第几天轮转推荐一个节点」。
- `_MD_PATTERN = re.compile(r"(\d{1,2})月(\d{1,2})日")`（`:18`）：全文件唯一正则，用于从 `historical_time` 抽取「月/日」。**要求「月」后紧跟 1~2 位数字再跟「日」**，只到月的写法一律不匹配。

### 4.2 `_history_md(historical_time) -> Optional[tuple]`（`:21-24`）
`:23` 先 `historical_time or ""` 兜底 `None`（`RouteNode.historical_time` 声明 `default=""` 且「空字符串按 NULL 存储」，见 `backend/app/models/models.py:36-37`、`:45`），`:24` 命中返回 `(int(月), int(日))`，未命中返回 `None`。

**匹配能力的实际边界（以种子数据核实）**：`backend/app/data/seed.py:86-185` 的 10 个节点中，只有 id 6「飞夺泸定桥」的 `historical_time` 是完整的「1935年5月29日」（`backend/app/data/seed.py:141`）；其余 9 个都是只到月的形式——「1934年10月」（`:86`）、「1935年1月」（`:97`）、「1935年1-3月」（`:108`）、「1935年5月」（`:119`、`:130`）、「1935年6月」（`:152`）、「1935年8月」（`:163`）、「1935年10月」（`:174`）、「1936年10月」（`:185`）。故在默认数据下**全年只有 5 月 29 日能走精确匹配分支（`:39-40`）**，其余 364/365 天全部落到轮转兜底（`:41`）。管理端可编辑 `historical_time`（节点 CRUD 见 `backend/app/services/admin_service.py:38-138`），运营补全日期即可让对应天精确命中。仓内存档的真实响应可佐证：`backend/test/e2e-full-results.json:925` 记录的 `memory` 为「nodeId 2 / 遵义 / historicalTime『1935年1月』」，即轮转结果。

### 4.3 `_pick_memory(db, today) -> Optional[RouteNode]`（`:27-41`）
1. `:29-34` 查全部**启用**节点（`RouteNode.is_enabled.is_(True)`），排序 `sort_order ASC, id ASC`——与 `march_service._ordered_nodes`（`backend/app/services/march_service.py:62-68`）**完全同口径**。
2. `:35-36` 无启用节点 → 返回 `None`。这是 `memory` 段为 null 的**唯一**条件。
3. `:37` `md = (today.month, today.day)`；`:38-40` 顺序遍历，第一个「月-日」相等的节点即返回（多个命中时取 `sort_order` 最靠前者）。
4. `:41` 兜底轮转 `nodes[today.timetuple().tm_yday % len(nodes)]`——按**年内第几天**取模，保证同一天全平台看到同一节点、且逐日变化。`tm_yday` 取值 1..366，故索引 0（首节点）仅在 `tm_yday % len(nodes) == 0` 时命中。
5. 形参名为 `today`，但调用处传入的是 `datetime.now()`（`:81`），即**服务器本地 naive 时间**——时区问题见 §7 第 2 条。

### 4.4 `get_today(db, user_id) -> Dict`（`:44-107`）
唯一对外函数。逐步：

| 步骤 | 行号 | 查询 / 计算 | SQL 次数 |
|---|---|---|---|
| 业务日 | `:46` | `date = today_str()`（北京时间 `YYYY-MM-DD`） | 0 |
| 本地时刻 | `:47` | `now = datetime.now()`（服务器本地 naive） | 0 |
| 我的今日步数 | `:49-54` | `daily_sport.steps` 按 `(user_id, date)`，`.scalar() or 0` | 1 |
| 全平台聚合 | `:55-66` | **单条 SQL** 同时取 `count(id)`（今日参与人数）、`coalesce(sum(coalesce(steps,0)),0)`（今日总步数）、`sum(case(steps <= my_steps → 1 else 0))`（步数不高于我的人数）；`:66` 三个值统一 `int()` 收敛（`Decimal`/`None` 归一） | 1 |
| 今日点亮数 | `:68-72` | `count(lit_nodes.id) WHERE lit_at >= day_start_utc`，其中 `day_start_utc = local_to_utc(now.replace(hour=0, minute=0, second=0, microsecond=0))`（`:69`） | 1 |
| 今日答题人数 | `:73` | `count(quiz_records.id) WHERE date = ?` | 1 |
| 总用户数 | `:74` | `count(users.id)` | 1 |
| 击败百分比 | `:76` | `round(beaten / today_users * 100) if today_users else 0` | 0 |
| 下一站 | `:78-79` | `march_service.get_route(db, user_id)` → 只取 `route["next_node"]` | 3~4 |
| 记忆彩蛋 | `:81` | `_pick_memory(db, now)` | 1 |
| 组装返回 | `:83-107` | 三段 dict | 0 |

`march_service.get_route`（`backend/app/services/march_service.py:190-225`）内部依次执行 `_ordered_nodes`（`:192`，查 `route_nodes`）、`sport_service.get_total_steps`（`:193`，`sum(daily_sport.steps)`）、`_lit_node_ids`（`:194`，查 `lit_nodes`），路线已完成时再查一次 `users.route_ceremony_at`（`:207-209`）。因此 **`/api/broadcast/today` 单次请求合计 9 条 SQL（路线已完成时 10 条）**，其中 `route_nodes` 被查 2 次（`:29-34` 与 `backend/app/services/march_service.py:62-68`）、`daily_sport` 被查 3 次（`:49-54`、`:57-65`、`sport_service.get_total_steps`）、`lit_nodes` 被查 2 次（`:70-72` 与 `backend/app/services/march_service.py:57-59`）。`f59892e` 只把「今日全平台聚合」合并为一条 SQL，跨 service 的重复查询未消除。

## 5. 输入与输出

**入参**：`db: Session`、`user_id: int`（由 `backend/app/api/routes/broadcast.py:16` 传 `current.id`）。**返回**：裸 `Dict`（非 Pydantic 模型），由路由的 `response_model=BroadcastTodayOut`（`backend/app/api/routes/broadcast.py:14`、`backend/app/schemas/schemas.py:707-710`）序列化，`CamelModel` 输出 camelCase。

| 段 | Python 键 | 输出键 | 来源行 | 口径 |
|---|---|---|---|---|
| `global` | `today_users` | `todayUsers` | `:85` | 今日有 `daily_sport` 行的用户数 |
| `global` | `today_steps` | `todaySteps` | `:86` | 今日全平台步数合计 |
| `global` | `today_lit_count` | `todayLitCount` | `:87` | 今日全平台点亮记录条数 |
| `global` | `today_quiz_users` | `todayQuizUsers` | `:88` | 今日答题记录条数 |
| `global` | `total_users` | `totalUsers` | `:89` | `users` 全表行数 |
| `personal` | `today_steps` | `todaySteps` | `:92` | 本人今日步数 |
| `personal` | `beat_percent` | `beatPercent` | `:93` | 击败百分比 0~100（含自己，见 §7.3） |
| `personal` | `remain_to_next` | `remainToNext` | `:94` | 距下一站剩余步数；无下一站时 `0` |
| `personal` | `next_node_name` | `nextNodeName` | `:95` | 下一站名称；无下一站时 `""` |
| `memory` | `node_id` / `title` / `historical_time` / `brief` | `nodeId` / `title` / `historicalTime` / `brief` | `:99-102` | `title` 取 `RouteNode.name`；`historical_time`/`brief` 为 `None` 时归一空串 |

- `global` 段在 Pydantic 侧字段名为 `global_`，靠 `Field(alias="global")` 输出（`backend/app/schemas/schemas.py:708`）——`global` 是 Python 关键字，这是既定的规避写法（`backend/test/docs/s3-miniapp-aggregates-report.md:51` 已作为契约注意项记录）。
- `memory` 段可为 `None`（`:104-105`），对应 `Optional[BroadcastMemory]`（`backend/app/schemas/schemas.py:710`）。
- `node_id` 为 `int`（`RouteNode.id`），`title` 为 `str`；**不含坐标、不含 `description`/`significance`/`images` 等详情字段**。
- **本文件不抛业务异常、也不捕获异常**：无 `raise`、无 `try/except`。所有分支对空数据返回零值或 `None`，故无 400/404 业务分支。异常只可能来自底层 SQL 或 `march_service.get_route`，会原样上抛至路由层成 500。
- HTTP 层错误码全部由路由与依赖产生：401（令牌缺失/无效，`backend/app/api/deps.py:17-43`）、403 + `X-Account-Status: disabled`（账号停用，`backend/app/api/deps.py:46-53`）。**本端点未挂活动守卫** `require_activity_view`（对照 `backend/app/api/deps.py:79-81`），事实与待确认项见 `.qoder/backend/app/api/routes/broadcast.py.md` §6。

## 6. 依赖关系

**依赖（`:7-16`）**
- 标准库：`re`（`:7`）、`datetime`（`:8`）、`typing` 的 `Dict`/`Optional`（`:9`）。
- SQLAlchemy：`case`、`func`（`:11`）、`Session`（`:12`）。
- `app.core.helpers`（`:14`）：`local_to_utc`（用于 `:69`）、`today_str`（用于 `:46`）。实现与口径见 `.qoder/backend/app/core/helpers.py.md`。
- `app.models.models`（`:15`）：`DailySport`、`LitNode`、`QuizRecord`、`RouteNode`、`User`。
- `app.services.march_service`（`:16`）：**services 层内部横向依赖**，只用 `get_route`（`:78`）。`march_service` 自身又依赖 `sport_service` 与 `event_service`（`backend/app/services/march_service.py:20`），故本文件的传递依赖面比 import 看起来更大；但依赖方向无环（`march_service` 不反向依赖 `broadcast_service`）。
- **不依赖** `app.core.config`（全文件无任何配置项读取）、**不依赖** `app.core.ws`、**不依赖** `event_service`。

**被依赖**
- 生产代码中**唯一**调用方：`backend/app/api/routes/broadcast.py:9`（import）、`:16`（调用 `get_today`）。全仓 grep `broadcast_service` 在 `backend/app/` 下只命中这一处路由文件。
- 小程序链路：`frontend/services/broadcast.js:26-28`（`getToday()` → `request({url:'/broadcast/today'})`）→ `frontend/pages/home/home.js:159`（`refreshAll` 的 `Promise.all` 第 4 项）→ `:173` 取为 `cast` → `:201-204` 映射进页面 `data`。
- 测试：`backend/test/s3_aggregates.py:170-180`（B1/B2 两项断言）。

**数据库表（全部只读，无写、无提交）**

| 表 | 模型定义 | 用途 | 查询行号 |
|---|---|---|---|
| `daily_sport` | `backend/app/models/models.py:231-252` | 本人今日步数 + 全平台聚合 | `:49-54`、`:57-65` |
| `lit_nodes` | `backend/app/models/models.py:255-268` | 今日点亮条数 | `:70-72` |
| `quiz_records` | `backend/app/models/models.py:271-287` | 今日答题人数 | `:73` |
| `users` | `backend/app/models/models.py:179-205` | 总用户数 | `:74` |
| `route_nodes` | `backend/app/models/models.py:32-58` | 记忆彩蛋候选（+ 经 `march_service` 求下一站） | `:29-34` |

索引：`lit_nodes.lit_at` 上的 `ix_lit_nodes_lit_at` 由 `docker/init/012_perf_indexes.sql:8` 建立（该文件 `:4` 的注释直接点名「今日播报『今日点亮数』」为受益方；迁移由 `f59892e` 同批引入，见 `docs/迭代记录.md` 的 `f59892e` 条目），支撑 `:71` 的范围扫描。

## 7. 业务规则

1. **事务边界：本文件不开启、也不提交事务。** 无 `db.add()` / `db.commit()` / `db.flush()` / `db.rollback()`；运行在 `get_db` 提供的请求级 session 中（`backend/app/core/database.py:58-64`），其 `finally` 只 `db.close()`。`SessionLocal` 配置为 `autoflush=False, autocommit=False`（`backend/app/core/database.py:51`），故本文件的查询不会意外 flush 同 session 的 pending 变更。**谁 commit：没有人**——这是 services 层少数纯读聚合之一。
2. **「今日」有两套口径且不一致（事实）**：`date` 用 `today_str()` = **北京时间**自然日（`:46`，实现 `backend/app/core/helpers.py:22-24`，模块 docstring `:3-4` 明确「不依赖服务器本地时区」）；`now` 用 `datetime.now()` = **服务器本地时区** naive（`:47`）。`now` 参与两处计算：`:69` 的「本地今日 0 点 → UTC」换算、`:81` 的记忆彩蛋取「月-日」与年内第几天。而 `local_to_utc` 的实现是把 naive 入参**当成北京时间**处理（`backend/app/core/helpers.py:40-44`）。因此当服务器时区不是 UTC+8（例如部署在 UTC 容器）时：`lit_at` 的比较窗口整体偏移 8 小时（`todayLitCount` 多算或少算），`memory` 会在北京时间 00:00–08:00 之间取到**前一天**的月-日与 `tm_yday`。开发机为 Windows 中国时区，两者恰好重合，故该偏差在本地不可见。是否统一改为 `now_beijing()`（`backend/app/core/helpers.py:17-19`）——**待确认**。相关历史：`backend/test/docs/s3-miniapp-aggregates-report.md:36-43` 记录过同源缺陷「UTC 存储时间 vs 本地业务日期错位（8 小时）……凌晨时段跨日误判（`todayLitCount=0`）」，当时修复方式是新增 `to_local`/`local_to_utc` 并在 `:69` 做换算，**未改 `datetime.now()` 的取值来源**。
3. **`beatPercent` 含自己**：`beaten` 的条件是 `steps <= my_steps`（`:61`，闭区间），本人当日行也计入，故最小非零值为 `1/today_users`，且**当日唯一参与者得 100%**。本人今日无 `daily_sport` 行时 `my_steps = 0`（`:53`），`beaten` 即「今日步数为 0 的行数」。`today_users == 0` 时短路为 `0`（`:76`），不会除零。测试 `backend/test/s3_aggregates.py:175` 断言 `1 <= beatPercent <= 100`，与该口径一致。
4. **`todayUsers` / `todayQuizUsers` 是「行数」而非显式去重人数**：分别为 `count(daily_sport.id)`（`:59`）与 `count(quiz_records.id)`（`:73`）。之所以等价于人数，靠唯一约束 `uq_sport_user_date`（`backend/app/models/models.py:240`）与 `uq_quiz_user_date`（`backend/app/models/models.py:275`）保证「每人每日至多一行」。**删改这两个约束会让字段语义静默失真**。
5. **`todayUsers` 的分母是「今日已同步者」**：用户当天未调 `POST /api/sport/sync` 就没有 `daily_sport` 行，不计入参与人数。`totalUsers` 则是 `users` 全表 `count`，**不过滤 `status`**（`:74`；`users.status` 见 `backend/app/models/models.py:203`），停用账号仍计入总人数。二者分母口径不同，`todayUsers / totalUsers` 不是严格的「参与率」。
6. **`todayLitCount` 是「全平台点亮记录条数」**：无 `user_id` 过滤（本就是全局指标），且**不 join `route_nodes`**（`:70-72`），故已停用节点的历史点亮记录只要 `lit_at` 落在窗口内仍会计入。同一用户重复点亮同一节点不可能发生（`uq_lit_user_node`，`backend/app/models/models.py:262`）。
7. **幂等性**：`get_today` 无副作用、无写库、无外部 HTTP 调用，同一天内多次调用返回同一结果（`_pick_memory` 只依赖月-日与 `tm_yday`），可安全重试与并发调用；跨 0 点（按服务器本地时区）才可能变化。**并发约束：无**——不加锁、不用 `with_for_update()`，读到的是各条 SQL 各自时刻的快照（未开启显式事务隔离级别设置）。
8. **`personal.remainToNext` / `nextNodeName` 完全由 `march_service` 决定**：`next_node` 是 `_route_state` 里第一个 `status != "completed"` 的节点（`backend/app/services/march_service.py:156`），全程点亮后为 `None`，本文件回落 `0` / `""`（`:94-95`）。注意 `get_route` 的点亮集合是「持久点亮 ∪ 步数达标现算」（`backend/app/services/march_service.py:196-199`，仅内存合并、不落库），因此**播报里的下一站可能领先于 `lit_nodes` 表**（步数已够但用户未调点亮接口时，播报已视该节点为完成）。
9. **无缓存、无节流**：每次请求跑满 9~10 条 SQL；首页 `onShow` 即触发（`frontend/pages/home/home.js:124` → `:151` `refreshAll` → `:159`）。
10. **降级行为**：本文件不调用任何外部 HTTP（无微信接口），因此**不存在外部依赖降级路径**。`memory` 的「精确匹配 → 日轮转」是**业务兜底**而非故障降级：正则不匹配（`:39` 全部落空）即走 `:41`，与数据库/网络健康无关。

## 8. 修改约束

1. **返回 dict 的三段键名与字段名是跨端硬契约**：`global`/`personal`/`memory`（`:84`、`:91`、`:97`）与 `BroadcastTodayOut`（`backend/app/schemas/schemas.py:707-710`）逐字段绑定；小程序首页直接读 `cast.personal.beatPercent`、`cast.personal.remainToNext`、`cast.personal.nextNodeName`、`cast.memory`（`frontend/pages/home/home.js:201-204`）。改键名须同步 schema + 小程序首页 + `backend/test/s3_aggregates.py:171-180` 断言。
2. **`global` 段目前无前端消费方**：`frontend/pages/home/home.js` 只映射 `cast.personal.*` 与 `cast.memory`（`:201-204`），未读 `cast.global`；在 `frontend/` 下 grep `cast.global`、`todayUsers`、`todayLitCount`、`todayQuizUsers`、`totalUsers` **均无命中**。因此 `:55-66` 的聚合 SQL 与 `:73-74` 的两次 count，当前只服务于契约完整性与测试断言（`backend/test/s3_aggregates.py:173-174`）。若要下线须先确认无未纳入仓库的消费端——是否保留**待确认**。
3. **`global` 输出键必须保持 `global`**：Python 侧字段名 `global_` 靠 `Field(alias="global")` 输出（`backend/app/schemas/schemas.py:708`），改 alias 会破坏契约。
4. **`memory` 只暴露 4 个字段**（`:99-102`）：节点详情的 `significance`/`figures`/`location`/`images`/`audio`/`keywords` 一律不下发；前端点卡片跳 `node-detail` 再取（`frontend/pages/home/home.js:395-399` `goMemoryNode`，卡片 `frontend/pages/home/home.wxml:170-179`）。要扩展内容应走 `GET /api/march/node/{id}`，不要在本段塞字段。
5. **`_pick_memory` 的节点排序必须与路线一致**：`sort_order ASC, id ASC`（`:32`）与 `backend/app/services/march_service.py:66` 相同；不一致会让轮转推荐顺序与路线顺序错位。
6. **正则 `:18` 是彩蛋精确匹配的唯一入口**：只认「N月N日」。若运营要求支持「N年N月」或区间（种子里的「1935年1-3月」即属此类，`backend/app/data/seed.py:108`），必须同时改 `_MD_PATTERN` 与 `_history_md`，并重新定义「多个节点命中同一天」的取舍（当前 `:38-40` 取第一个）。
7. **保持只读**：本文件一旦出现 `db.commit()`，会把同一 session 里上游未提交的变更一起提交（同类问题参见 `.qoder/backend/app/services/event_service.py.md` §7 与 §9）。
8. **不要在路由层做聚合**：分层约定要求 route 薄、service 承载业务（`backend/AGENTS.md`），`.qoder/backend/app/api/routes/broadcast.py.md` §8.3 已把这条列为该路由的修改约束。反向亦然：`broadcast.py:16` 只有一行 `return broadcast_service.get_today(...)`，聚合逻辑不得上移。
9. **首页对本接口的失败容忍度低于其它聚合接口（改动需知悉）**：`frontend/pages/home/home.js:159` 的 `broadcast.getToday()` **没有** `.catch(() => null)` 包裹（对比同批 `:161-166` 的动态流/组织/集体长征/全员同行/寄语/活动状态六项都有），因此本接口一旦 500，整个 `Promise.all` reject，首页落到 `:285-288` 的 `.catch`，只 `setData({routeLoading:false, routeError:'数据加载失败，请稍后重试'})`——**首页主数据全部不渲染**。给本文件加字段/加查询时须评估失败面。
10. 修改本文件后须同步 `.qoder/backend/app/api/routes/broadcast.py.md` §4.1、`.qoder/backend/app/schemas/schemas.py.md` 的「今日播报」段（`:63` 行索引）。

## 9. 当前实现状态

**已实现**
- `GET /api/broadcast/today` 三段聚合可用：`global` 5 字段、`personal` 4 字段、`memory` 4 字段（`:83-107`）。
- 全平台今日参与人数 / 总步数 / 击败人数**单条 SQL** 完成（`:55-66`），系 `f59892e` 的性能优化成果（`backend/test/docs/s14-hotspot-sql-report.md:18`：「今日播报的人数、总步数、击败人数合成一条 SQL 聚合（原先拉今日全部运动行）」）。
- 今日点亮数按「本地今日 0 点换算 UTC」比较，修复了早期 8 小时错位（`:68-69` 注释 + `backend/test/docs/s3-miniapp-aggregates-report.md:42`）。
- 长征记忆彩蛋：精确匹配 + 日轮转双策略，同一天全平台一致（`:27-41`）。

**存在问题（事实性陈述，非缺陷判定）**
1. **时区口径混用**：`today_str()`（北京时间）与 `datetime.now()`（服务器本地）并存于同一函数（`:46-47`），详见 §7.2。非 UTC+8 部署会让 `todayLitCount` 与 `memory` 出现最多 8 小时 / 1 天的偏差。本地开发环境不可见。
2. **重复查询与过度计算**：`route_nodes` 查 2 次、`daily_sport` 查 3 次、`lit_nodes` 查 2 次（§4.4 末段）。`get_route` 返回 13 个键，本文件只用 `next_node` 一个（`:79`），其余 12 个（含完整的 `nodes` 列表与 `chapters` 视图）全部丢弃。
3. **既有说明文档把「期号」写进本接口**：`backend/README.md:122`、`backend/design.md:153`、`frontend/design.md:87` 均称 `/api/broadcast/today` 返回「期号」。实际 `BroadcastTodayOut`（`backend/app/schemas/schemas.py:685-710`）**无任何期号字段**；期号 `issueNo` 属 `GET /api/quiz/daily`（`docs/upgrade-plan.md:209-211`、`backend/test/docs/s3-miniapp-aggregates-report.md:16`）。属文档滞后，需按 `.qoder/README.md` §3.11 更正原始文档（本目录不复制其内容）。
4. **精确匹配分支在默认数据下几乎不生效**：种子 10 个节点里只有 1 个（id 6）的 `historical_time` 含完整「月-日」（§4.2），故 docstring `:4` 承诺的「按当天月-日匹配」能力全年只有 5 月 29 日可用。是数据问题而非代码问题，但会让「彩蛋」看起来与当天历史无关。
5. **`memory` 为 null 的唯一条件是「无启用节点」**（`:35-36`），而 schema 与前端都按可空处理（`backend/app/schemas/schemas.py:710`、`frontend/pages/home/home.wxml:171` 的 `wx:if="{{memory}}"`）——正常运营态下该分支不可达，属防御性代码。
6. **`_history_md` 的返回类型标注为 `Optional[tuple]`（`:21`）**，未写元素类型；实际返回 `Tuple[int, int]`。仅标注精度问题，无运行期影响。

**待开发**
- `global` 段的小程序展示：契约已下发但首页未消费（§8.2），是否补 UI——**待确认**（无任何需求文档或迭代记录提及）。
- 播报本身的「期号」概念：需求侧未提出（见问题 3），无开发计划记录。
- 播报结果的缓存：当前无缓存（§7.9），未见性能优化提案记录。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/broadcast_service.py`（**2 个提交**）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-11
- 需求：后端热点查询 SQL 聚合化与去 N+1（性能优化）。
- 修改内容：`f59892e` 把「今日全平台参与人数 / 总步数 / 击败人数」由「先拉今日全部 `daily_sport` 行、再在 Python 里累加」改为**单条聚合 SQL**（`:55-66`，使用 `func.count` / `func.sum` / `case`，`:66` 统一 `int()` 收敛），并新增 `from sqlalchemy import case, func`（`:11`）。17 insertions / 8 deletions。
- 关联文件：`backend/app/services/event_service.py`（新增 `recent_events` 单次外连接）、`backend/app/services/profile_service.py`、`backend/app/services/rank_service.py`、`backend/app/services/streak_service.py`、`docker/init/012_perf_indexes.sql`（新增 `lit_nodes.lit_at` 索引，支撑 `:71`）、报告 `backend/test/docs/s14-hotspot-sql-report.md`。
- 测试结果：`docs/迭代记录.md` 的 `f59892e` 条目「验证」字段原文——「openGauss 已应用 012。e2e_full_flow 178/178，e2e_datasync 23/23，S2–S7、P0/P1/P2、昵称冒烟全部通过。排行、播报结果与旧实现逐项一致（92 用户 / 20 用户样本）。」本文件对应报告条目为 `backend/test/docs/s14-hotspot-sql-report.md:18`。

### 2026-10-02
- 需求：小程序聚合接口批次（档案 / 足迹 / 日历 / **播报** / 知识画像），对应 PRD 功能 6 全局播报 + 功能 7 长征记忆彩蛋（`docs/upgrade-plan.md:196-207`）。
- 修改内容：`18c2121` 创建本文件（98 行）：模块 docstring、`_MD_PATTERN`、`_history_md`、`_pick_memory`、`get_today`。当时全平台聚合仍为「拉今日全部运动行再 Python 累加」，`f59892e` 才改为单条 SQL；当时今日点亮数的 UTC/本地换算已由同批新增的 `helpers.local_to_utc` 承担（`:68-69`）。
- 关联文件：`backend/app/api/routes/broadcast.py`（同提交新建 `GET /broadcast/today`）、`backend/app/schemas/schemas.py:685-710`（`BroadcastGlobal`/`BroadcastPersonal`/`BroadcastMemory`/`BroadcastTodayOut`）、`backend/app/core/helpers.py`（同批新增 `to_local`/`local_to_utc`）、`frontend/services/broadcast.js`、`frontend/pages/home/home.js`（长征记忆卡 + `beatPercent`/`remainToNext`）、`backend/test/s3_aggregates.py:169-180`（B1/B2 断言）。
- 测试结果：待确认（`docs/迭代记录.md` 的 `18c2121` 条目未记录验证字段，仅有「内容：新增小程序聚合接口（档案/足迹/日历/播报/知识画像）并扩展现有契约」）。**另有独立验收报告可作证据**：`backend/test/docs/s3-miniapp-aggregates-report.md`（2026-10-02，S3 阶段）记载 **15/15 通过**，其中 `:31` 为「B1/B2 broadcast 全局/个人/记忆 ✓」，`:42` 记录修复项「`broadcast_service` 今日点亮数以本地 0 点的 UTC 等价比较」，`:51` 记录契约注意项「`broadcast/today` 顶层键 `global`（Python 端字段名 `global_`，别名输出）」。该报告与本提交的对应关系由报告日期、阶段名（S3 小程序聚合接口）与 `:15` 的接口清单共同确认。
