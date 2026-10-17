# dashboard_service.py

## 1. 文件路径

`backend/app/services/dashboard_service.py`（165 行）

## 2. 文件职责

管理端**驾驶舱**与**数据大屏**的聚合服务层：把分散在 `daily_sport` / `lit_nodes` / `users` / `quiz_records` / `user_medals` / `route_nodes` / `user_event` 七张表里的运营数据，收敛成四个只读聚合结果（核心指标 + 路线总览、近 N 日趋势、实时动态、大屏单接口聚合），供 `admin` 前端一次请求取完。

文件只读、不写库、不发事件，是本仓库中少数**完全没有事务提交**的服务。

## 3. 业务需求

| 来源 | 说明 |
|---|---|
| `.qoder/REQUIREMENTS.md` §11.5 | `DashboardView`（驾驶舱：7 张指标卡 + ECharts 双轴图）、`ScreenView`（数据大屏：纯 CSS 柱状图 + 单个 `fetchScreen` 聚合接口），两者都使用 `useLiveUpdates` |
| `.qoder/REQUIREMENTS.md` §7 末两行 | **组织排名 / 分组织积分对比已取消**；PC 端组织人数统计另行实现于 orgs 树接口——所以本文件**不含任何组织维度统计** |
| `.qoder/ARCHITECTURE.md` §9.4 | 事务边界约定；本文件属「纯只读、无 commit」一类 |
| `docs/迭代记录.md` | 提交级历史权威出处：`2289fdd`（2026-10-02 新建）、`20c79e3`（2026-10-02 计数优化）、`f59892e`（2026-10-11 去 N+1） |
| `backend/test/docs/s4-admin-dashboard-report.md` | 口径说明与首版验收（含「组织维度按用户 2026-10-02 确认完全跳过」的范围决策原文） |

`backend/app/schemas/schemas.py:1200` 的 `AdminDashboardMetrics` 文档串把这条取消决定固化在代码里：「驾驶舱核心指标（组织维度已按需求取消，不含 org 统计）」。

## 4. 核心功能

### 4.1 内部工具

| 函数 | 行号 | 行为 |
|---|---|---|
| `_user_total_steps(db)` | `backend/app/services/dashboard_service.py:30-37` | **一条** `GROUP BY user_id` 的 `SUM(steps)` 查询，返回 `{user_id: 累计步数}`。只包含**有过 `daily_sport` 记录**的用户 |
| `_enabled_nodes(db)` | `backend/app/services/dashboard_service.py:40-46` | 启用节点按 `(sort_order ASC, id ASC)` 排序，返回 ORM 行列表 |

### 4.2 `get_dashboard(db)` — `backend/app/services/dashboard_service.py:49-100`

驾驶舱聚合，返回 `{metrics, route_overview}`。**共 6 条 SQL**：

| # | 行号 | 查询 | 产出指标 |
|---|---|---|---|
| 1 | `:51` | `count(User.id)` | `total_users` |
| 2 | `:52-57` | `daily_sport` 中 `date == today_str()` 的 `distinct(user_id)` 计数 | `today_users` |
| 3 | `:58` | `_user_total_steps` | `total_steps`（`:59` 求和）、`avg_steps`（`:60`） |
| 4 | `:62` | `_enabled_nodes` | `route_overview` 的节点列表、`final_target`（`:63` 取 `nodes[-1].target_steps`） |
| 5 | `:69` | `quiz_records` 的 `distinct(user_id)` 计数 | `quiz_users` |
| 6 | `:70` | `count(UserMedal.id)` | `medals_granted` |

派生计算全部在内存完成：

- `finished`（`:64-66`）= 累计步数 ≥ **最终节点目标**的人数；`final_target` 为 0（无启用节点）时直接取 0。
- `completion_rate`（`:67`）= `round(finished / total_users * 100)`，`total_users` 为 0 时取 0。
- `route_overview`（`:72-87`）：**累计步数升序排序一次（`:73`），每节点用 `bisect_left` 二分计数（`:76`）**，复杂度 O(U·log U + 节点数·log U)，替代旧实现「逐节点全量线性扫描」的 O(节点数 × 用户数)。`:72` 注释明确这是用户量大时的关键路径。

### 4.3 `get_trend(db, days)` — `backend/app/services/dashboard_service.py:103-137`

近 N 日趋势，返回 `{days, points}`，`points` 为按日期升序的定长列表（`:137`）。**共 3 条 SQL**：

| # | 行号 | 查询 | 归桶方式 |
|---|---|---|---|
| 1 | `:111-116` | `daily_sport` 按 `date` 分组求 `SUM(steps)` 与 `COUNT(id)`，`date IN (dates)` | **SQL 侧分组**，直接落桶（`:117-120`） |
| 2 | `:125` | `users.created_at >= range_start_utc` 的**原始行** | **Python 侧**逐行 `to_local(...)` 转北京时间再取 `%Y-%m-%d` 落桶（`:126-129`） |
| 3 | `:131` | `lit_nodes.lit_at >= range_start_utc` 的**原始行** | 同上（`:132-135`） |

`dates` 来自 `recent_dates(days)`（`:105`；`backend/app/core/helpers.py:27-30`，含今天、从旧到新）。`points` 先按日期建满零值桶（`:106-109`），所以**没有数据的日期也会返回 0**，前端图表不会出现断点。

`:122` 注释解释了为什么第 2、3 条不能像第 1 条那样在 SQL 里分组：`created_at` / `lit_at` 是 **UTC naive 存储**，要按北京自然日归桶必须做时区换算，而这在 openGauss 与测试用 SQLite 上没有可移植的统一写法，因此改为「**范围按 UTC 过滤、归桶按本地日期**」——`range_start_utc` 由 `local_to_utc(dates[0] 00:00 北京时间)` 得到（`:123`；`backend/app/core/helpers.py:40-44`）。该口径在 `backend/test/docs/s4-admin-dashboard-report.md`「口径说明」一节有同样表述。

### 4.4 `get_activities(db, limit)` — `backend/app/services/dashboard_service.py:140-153`

实时动态：委托 `event_service.recent_events(db, limit)`（`:152`；`backend/app/services/event_service.py:75-84`）**一次外连接查询**同时取事件行与用户昵称，再用 `event_service.build_text`（`:149`；`backend/app/services/event_service.py:23-50`）生成展示文案。

文案与小程序「我的足迹」时间轴**同源同函数**，这是 `backend/app/services/dashboard_service.py:5` 文档串「文案与小程序足迹同源」的落点。

### 4.5 `get_screen(db)` — `backend/app/services/dashboard_service.py:156-164`

大屏单接口聚合：复用 `get_dashboard(db)`（`:158`）+ `get_trend(db, 7)`（`:162`）+ `get_activities(db, 20)`（`:163`），合计约 **10 条 SQL**，目的是把大屏的 4 次请求压成 1 次（`backend/app/schemas/schemas.py:1258` 文档串「单接口减少大屏请求数」）。

### 4.6 HTTP 出口一览

| 方法 + 路径 | 路由定义 | 权限依赖 | 查询参数 | `response_model` |
|---|---|---|---|---|
| `GET /api/admin/dashboard` | `backend/app/api/routes/admin.py:199-206` | `require_menu("dashboard")`（`:203`） | 无 | `AdminDashboardOut`（`backend/app/schemas/schemas.py:1221-1223`） |
| `GET /api/admin/dashboard/trend` | `backend/app/api/routes/admin.py:209-218` | `require_menu("dashboard")`（`:213`） | `days: int = Query(7, ge=1, le=90)`（`:216`） | `AdminTrendOut`（`backend/app/schemas/schemas.py:1236-1238`） |
| `GET /api/admin/activities` | `backend/app/api/routes/admin.py:221-230` | `require_menu("dashboard")`（`:225`） | `limit: int = Query(50, ge=1, le=200)`（`:228`） | `AdminActivityListOut`（`backend/app/schemas/schemas.py:1253-1254`） |
| `GET /api/admin/screen` | `backend/app/api/routes/admin.py:233-240` | `require_menu("screen")`（`:237`） | 无 | `AdminScreenOut`（`backend/app/schemas/schemas.py:1257-1263`） |

四个接口都**不挂活动守卫**（管理端接口一律不受 `activity_service` 闸门约束）。活动闸门清单见 `.qoder/backend/app/services/activity_service.py.md`。

## 5. 输入与输出

### 5.1 输入

| 参数 | 类型 / 约束 | 来源 |
|---|---|---|
| `db` | SQLAlchemy `Session` | `get_db`（`backend/app/core/database.py`） |
| `days` | `int`，`1 ≤ days ≤ 90`，默认 7 | `backend/app/api/routes/admin.py:216` |
| `limit` | `int`，`1 ≤ limit ≤ 200`，默认 50 | `backend/app/api/routes/admin.py:228` |

`get_screen` 内部把 `days` 固定为 7、`limit` 固定为 20（`:162-163`），不接受外部参数。

### 5.2 输出

**`get_dashboard`** → `{metrics: {...}, route_overview: [...]}`

- `metrics` 7 个键（`:90-98`，对应 `AdminDashboardMetrics`，`backend/app/schemas/schemas.py:1202-1208`）：`total_users`、`today_users`、`total_steps`、`avg_steps`、`completion_rate`、`quiz_users`、`medals_granted`。
- `route_overview` 每项 5 个键（`:78-86`，对应 `AdminRouteOverviewItem`，`backend/app/schemas/schemas.py:1214-1218`）：`node_id`、`name`、`target_steps`、`lit_count`、`completion_rate`。

**`get_trend`** → `{days: int, points: [...]}`；每个 point 5 个键（`:107`，对应 `AdminTrendPoint`，`backend/app/schemas/schemas.py:1229-1233`）：`date`、`total_steps`、`active_users`、`new_users`、`new_lit`。

**`get_activities`** → `List[Dict]`，每项 7 个键（`:143-151`，对应 `AdminActivityItem`，`backend/app/schemas/schemas.py:1244-1250`）：`id`、`event_type`、`event_time`（UTC naive `datetime`）、`user_id`、`nickname`、`text`、`data`。路由再包成 `{items: [...]}`（`backend/app/api/routes/admin.py:230`）。

**`get_screen`** → `{metrics, route_overview, trend, activities}`（`:159-164`），`trend` 直接是 `points` 数组而非 `{days, points}` 包装。

管理端 schema 全部继承普通 `BaseModel`，输出 **snake_case**（与小程序侧 `CamelModel` 的 camelCase 契约相反），见 `.qoder/backend/app/schemas/schemas.py.md`。

### 5.3 异常与错误码

本文件**不抛任何业务异常、不做任何 try 包裹**：

| 场景 | 行为 |
|---|---|
| `total_users == 0` | `avg_steps` / `completion_rate` 走 `if total_users else 0` 分支（`:60`、`:67`、`:84`），不会 `ZeroDivisionError` |
| 无启用节点 | `final_target = 0`（`:63`），`finished = 0`（`:65`），`route_overview` 为空数组 |
| `days` 超出 1~90 | 由 `Query(ge=1, le=90)` 在路由层拦成 **422**，不进服务层 |
| 无 Token / 无对应菜单权限 | 依赖层返回 **401 / 403** |
| 数据库异常 | 原样冒泡为 **500** |

## 6. 依赖关系

### 6.1 本文件依赖

| 依赖 | 行号 | 用途 |
|---|---|---|
| `bisect.bisect_left` | `backend/app/services/dashboard_service.py:11` | 路线总览的每节点达成人数二分计数 |
| `datetime.datetime` | `backend/app/services/dashboard_service.py:12` | 解析 `dates[0]` 为 `datetime` 再做时区换算（`:123`） |
| `sqlalchemy.func` | `backend/app/services/dashboard_service.py:15` | `SUM` / `COUNT` 聚合 |
| `app.core.helpers` | `backend/app/services/dashboard_service.py:18` | `local_to_utc`（`:40-44`）、`recent_dates`（`:27-30`）、`to_local`（`:33-37`）、`today_str`（`:22-24`） |
| `app.models.models` | `backend/app/services/dashboard_service.py:19-26` | `DailySport`、`LitNode`、`QuizRecord`、`RouteNode`、`User`、`UserMedal` |
| `app.services.event_service` | `backend/app/services/dashboard_service.py:27` | `build_text`、`recent_events` |

**不依赖** `core/config`（无配置项）、`points_service`（驾驶舱不展示积分）、`org_service`（组织维度已取消）、`audit_service`（只读接口不写审计）。

### 6.2 数据库对象

| 表 / 索引 | 定义位置 | 本文件用法 |
|---|---|---|
| `daily_sport` | `backend/app/models/models.py:231-252`；唯一约束 `uq_sport_user_date`（`:240`）；`date` 为 `String(10)` 且带索引（`:244`） | 累计步数、今日参与人数、趋势步数与参与人数 |
| `users` | `backend/app/models/models.py:179-205`；`created_at` 带索引（`:199`） | 总人数、趋势新增用户 |
| `lit_nodes` | `backend/app/models/models.py:255-268`；`lit_at` 带索引（`:267`） | 仅用于趋势「新增点亮」；**`route_overview` 的 `lit_count` 不查这张表** |
| `route_nodes` | `backend/app/models/models.py:32-58` | 启用节点列表与 `target_steps` |
| `quiz_records` | `backend/app/models/models.py:271-288` | 答题人数（`distinct user_id`） |
| `user_medals` | `backend/app/models/models.py:353-362` | 勋章发放总数 |
| `user_event` | `backend/app/models/models.py:365-381` | 经 `event_service.recent_events` 间接使用（本文件已不再直接导入 `UserEvent`） |
| 索引 `ix_lit_nodes_lit_at` | `docker/init/012_perf_indexes.sql:8` | 支撑 `:131` 的时间范围过滤 |
| 索引 `ix_users_created_at` | `docker/init/012_perf_indexes.sql:9` | 支撑 `:125` 的时间范围过滤 |

`docker/init/012_perf_indexes.sql:4-6` 的注释把这两个索引的用途直接写成「驾驶舱趋势『新增点亮』/『新增用户』按时间范围过滤」。

### 6.3 被谁依赖

| 调用方 | 行号 |
|---|---|
| `backend/app/api/routes/admin.py` | `:88` 导入；`:206`（dashboard）、`:218`（trend）、`:230`（activities）、`:240`（screen） |
| 路由注册 | `backend/app/main.py:86` |

**唯一调用方是 `admin.py`**，小程序侧无任何入口。

### 6.4 前端消费方

| 端 | 位置 |
|---|---|
| 管理后台 API 封装 | `admin/src/api/admin.ts:774-776`（`fetchDashboard`）、`:778-780`（`fetchDashboardTrend`）、`:782-784`（`fetchActivities`）、`:786-788`（`fetchScreen`） |
| 驾驶舱页 | `admin/src/views/DashboardView.vue:43`（dashboard）、`:53`（trend）、`:63`（activities，`limit` 传 20）、`:140`（`useLiveUpdates`） |
| 数据大屏页 | `admin/src/views/ScreenView.vue:19`（`fetchScreen`）、`:22`（`useLiveUpdates`） |
| 实时刷新 | `admin/src/utils/liveUpdates.ts:26` 的 `useLiveUpdates`，内部统一 800ms 防抖（`docs/迭代记录.md` 的 `30b4458` 条目「内容」） |
| 路由与菜单码 | `admin/src/router/index.ts:22-25`（screen）、`:33-36`（dashboard）；`admin/src/router/menus.ts:4-5` |

## 7. 业务规则

1. **节点达成口径 = 累计步数达标，不是 `lit_nodes` 有点亮记录**。`route_overview.lit_count` 与 `metrics.completion_rate` 都基于 `_user_total_steps` 的结果与 `target_steps` 比较（`:76`、`:65`），**不查 `lit_nodes`**。这与小程序 `march_service` 的口径一致（`backend/app/services/march_service.py:196-199` 同样按步数判定点亮），目的是「避免漏掉未点『点亮』按钮的用户」——`backend/test/docs/s4-admin-dashboard-report.md`「口径说明」一节原文如此。
2. **`target_steps = 0` 的节点（种子中为 id=1 瑞金，`backend/app/data/seed.py:86`）会把所有有运动记录的用户都计入 `lit_count`**。这是口径的自然结果而非缺陷，`backend/test/docs/s7-perf-refactor-report.md:48` 明确记录：「驾驶舱统计『有 DailySport 记录且总步数 ≥ 目标』的用户数，rankings 列表含 0 步用户，两者对 target=0 节点天然不等」。
3. **`avg_steps` 的分母是全部用户，不是有运动记录的用户**：`:60` 用 `total_users`（`:51` 的 `count(User.id)`），而分子 `total_steps` 只来自有 `daily_sport` 行的用户。因此从未同步过步数的用户按 0 步参与平均。
4. **`completion_rate` 的分子分母同样口径不一致**：分子 `finished` 只统计有运动记录的用户，分母是全部用户（`:67`）。
5. **业务日期固定北京时间**：`today_users` 用 `today_str()`（`:54`），趋势日期桶用 `recent_dates` / `to_local` / `local_to_utc`，全部走 `backend/app/core/helpers.py:9` 的 `BEIJING_TZ = timezone(timedelta(hours=8))`，不依赖服务器本地时区（Windows 无 tzdata）。
6. **趋势定长补零**：`points` 先建满 `days` 个零值桶（`:106-109`），落桶时用 `if key in points` 过滤（`:118`、`:128`、`:134`），因此返回数组长度恒等于 `days`，且**范围外（如未来时间）的行会被静默丢弃**。
7. **趋势的时间范围只有下界没有上界**：`:125`、`:131` 只写 `>= range_start_utc`。上界由 `if key in points` 在 Python 侧兜住，代价是**晚于今天的行仍会被查出并传输**。
8. **动态文案与小程序同源**：`get_activities` 用 `event_service.build_text`（`:149`），与小程序足迹时间轴、WS 推送使用同一函数，改文案会同时影响三处。
9. **管理端动态不脱敏昵称**：`:148` 直接返回 `nickname`。而 `event_service.list_public_activities`（小程序侧）在 `ACTIVITY_MASK_NICKNAME` 开启时会调 `mask_nickname`（`backend/app/services/event_service.py:93-99`），`event_service.record` 的 WS 广播也会脱敏（`backend/app/services/event_service.py:124-125`）。即**同一个管理端页面，WS 推来的动态可能脱敏、HTTP 拉来的动态不脱敏**。
10. **无缓存、无事务**：四个函数全部实时查库，不做任何缓存；文件内没有 `db.commit()` / `db.flush()`，符合 `.qoder/ARCHITECTURE.md` §9.4 对只读服务的预期。前端靠 `useLiveUpdates` 的 800ms 防抖 + WS 事件驱动重拉来控制请求频率。
11. **权限**：`dashboard` 菜单码管前三个接口，`screen` 菜单码单独管大屏接口（`backend/app/api/routes/admin.py:203`、`:213`、`:225`、`:237`），两者可分别授权。

## 8. 修改约束

1. **不要重新引入组织维度统计**。`backend/app/schemas/schemas.py:1200` 与 `backend/test/docs/s4-admin-dashboard-report.md`「范围决策」都记录了「组织维度（org_stats、大屏组织榜）按用户 2026-10-02 确认完全跳过」；`.qoder/REQUIREMENTS.md` §7、§12 把「组织排名 / 分组织积分对比」列为**已取消**。加字段前必须先拿到需求变更。
2. **`route_overview` 必须继续按「累计步数 ≥ target_steps」计数**。改成查 `lit_nodes` 会让驾驶舱与小程序路线图数字不一致（口径见「7. 业务规则」第 1 条），也会破坏 `backend/test/docs/s7-perf-refactor-report.md:23` 的 P1 断言。
3. **二分计数依赖 `sorted_totals` 升序且 `target_steps` 单调不减**。`:76` 的 `len - bisect_left` 只在升序数组上成立；节点顺序由 `_enabled_nodes` 的 `(sort_order, id)` 保证（`:44`）。若将来允许乱序节点或负 `target_steps`，需要重新验证。
4. **趋势的时区换算不能下沉到 SQL**。`:122` 注释已说明原因；若要优化，必须同时保证 openGauss 与测试用 SQLite 行为一致，否则会破坏 `backend/test/s4_admin_dashboard.py` 的日期断言。
5. **`recent_dates` 的顺序（从旧到新）被 `:123` 依赖**——`dates[0]` 必须是区间最早的一天。`backend/app/core/helpers.py:27-30` 改动会影响这里。
6. **返回键名是 admin 前端的硬契约**（snake_case）。`admin/src/api/admin.ts` 的 `DashboardResult` / `TrendResult` / `ActivityListResult` / `ScreenResult` 类型与之逐字段对应，改键名必须同步前端。
7. **`get_screen` 复用而非复制**。`:158-163` 直接调另外三个函数，保证大屏与驾驶舱数字必然一致；不要把逻辑拷一份进 `get_screen`。
8. **`get_activities` 的昵称来源必须走 `event_service.recent_events`**。旧实现在本文件内做了「查事件 + 再查昵称」两次查询，`f59892e` 已合并（`docs/迭代记录.md` 的 `f59892e` 条目「内容」记为「实时动态改为 join 一次取昵称」）；退回两步查询即重新引入 N+1。
9. **索引不可随意删除**：`docker/init/012_perf_indexes.sql:8-9` 的两个索引是趋势接口在数据量增长后仍可用的前提。迁移脚本已执行并登记，按仓库规则不得编辑已执行的编号脚本。
10. **本文件不得写入任何数据**（含 `db.commit()` / `db.flush()`）。它是纯读聚合层；需要落库的统计应放到对应业务服务。

## 9. 当前实现状态

### 已实现

- 驾驶舱 7 项核心指标 + 每启用节点达成人数与完成率（`get_dashboard`，6 条 SQL）。
- 近 N 日（1~90）趋势四条曲线数据：总步数 / 参与人数 / 新增用户 / 新增点亮（`get_trend`，3 条 SQL）。
- 实时动态（`get_activities`，1 条 SQL，昵称一次外连接取回）。
- 大屏单接口聚合（`get_screen`，约 10 条 SQL）。
- 路线总览计数已由 O(节点数 × 用户数) 优化为 O(U·log U + 节点数·log U)（`20c79e3`）。

### 存在问题 / 风险

1. **趋势接口把 `users.created_at` 与 `lit_nodes.lit_at` 的原始行全部拉进 Python**（`:125-135`）。`days=90` 时，注册用户数与累计点亮记录数会**全量**（从区间起点至今）加载到内存，行数随历史增长线性膨胀，而不是随 `days` 收敛。这是本文件最大的可扩展性隐患。可行的改进方向是在 SQL 侧用 `date(created_at AT TIME ZONE ...)` 之类分组，但受「8. 修改约束」第 4 条的可移植性限制。
2. **趋势查询缺时间上界**（`:125`、`:131`），未来时间的行会被查出后再被 `if key in points` 丢弃。
3. **`get_screen` 未做结果复用**：`:158` 的 `get_dashboard` 与 `:162` 的 `get_trend` 各自独立查库，其中 `_user_total_steps` 与 `daily_sport` 的分组查询有重叠扫描。10 条 SQL 对一个自动刷新的大屏页面来说不算少。
4. **昵称脱敏口径在管理端不自洽**（「7. 业务规则」第 9 条）：WS 推送按 `ACTIVITY_MASK_NICKNAME` 脱敏，HTTP `get_activities` 不脱敏。管理端是否本就不该脱敏**待确认**（`.qoder/REQUIREMENTS.md` §14 第 4 项只说明该开关用于「对外实时动态」，未覆盖管理端）。
5. **`avg_steps` / `completion_rate` 的分子分母口径不一致**（「7. 业务规则」第 3、4 条）。当前实现是有意为之（分母为全员），但与「参与用户人均步数」的直觉不同，前端指标卡文案需与此对齐。
6. **无任何缓存**。驾驶舱与大屏都靠 `useLiveUpdates` 的 WS 事件 + 800ms 防抖触发重拉；每次 `data_changed` 都会打满 6~10 条聚合 SQL。用户量增长后需要评估是否加短 TTL 缓存。

### 待开发

- 无。`.qoder/REQUIREMENTS.md` §13 待开发清单不含驾驶舱 / 大屏条目。

### 待确认

- **驾驶舱是否需要「积分」维度指标**：V2.0（`2f3f333`）已把总积分定为排名口径，但 `AdminDashboardMetrics` 仍无积分字段，是刻意不加还是尚未排期，**无需求依据**。
- **`medals_granted` 的语义**：`:70` 统计的是 `user_medals` 行数（即「发放人次」），而 `backend/app/data/seed.py:282-311` 定义 12 枚勋章；指标卡文案是否表述为「人次」**待确认**（`admin/src/views/DashboardView.vue` 的卡片标题为准）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/services/dashboard_service.py`（3 个提交）与 `docs/迭代记录.md`。按时间倒序。

### 2026-10-11

- 需求：后端热点查询 SQL 聚合化与去 N+1（性能优化 / 缺陷修复）。
- 修改内容：本文件把「查最近事件 → 收集 `user_id` → 再查昵称映射」的两步实现，改为直接消费 `event_service.recent_events(db, limit)` 的单次外连接查询，并从模型导入列表中删除不再直接使用的 `UserEvent`。对应现行 `backend/app/services/dashboard_service.py:140-153`。`docs/迭代记录.md` 的 `f59892e` 条目记为「实时动态改为 join 一次取昵称」，`backend/test/docs/s14-hotspot-sql-report.md:21` 记为「『最近事件 + 昵称』统一为一次外连接查询 `recent_events`，删除两处重复的昵称映射」。同批次还新增迁移 `docker/init/012_perf_indexes.sql`（本文件趋势查询直接受益）。
- 关联文件：`backend/app/services/event_service.py:75-84`、`backend/app/services/dashboard_service.py:19-27`、`docker/init/012_perf_indexes.sql`、`backend/app/services/rank_service.py`、`backend/app/services/profile_service.py`、`backend/app/services/broadcast_service.py`。
- 测试结果：`docs/迭代记录.md` 的 `f59892e` 条目原文——「openGauss 已应用 012。e2e_full_flow 178/178，e2e_datasync 23/23，S2–S7、P0/P1/P2、昵称冒烟全部通过。排行、播报结果与旧实现逐项一致（92 用户 / 20 用户样本）。」专项报告中驾驶舱相关的一条为 `backend/test/docs/s14-hotspot-sql-report.md:40`「`s4_admin_dashboard` 13/13」。（提交 `f59892e`）

### 2026-10-02

- 需求：组织全名批量查询与驾驶舱计数优化，消除 N+1（优化）。
- 修改内容：`route_overview` 的每节点达成人数由「逐节点对全部用户线性扫描（且同一节点的计数被重复计算两次：一次给 `lit_count`、一次给 `completion_rate`）」改为「用户累计步数升序排序一次 + `bisect_left` 二分计数」，新增 `from bisect import bisect_left`（现行 `backend/app/services/dashboard_service.py:11`、`:72-87`）。提交说明原文：「route_overview 计数由逐节点线性扫描改为排序后二分，口径经 S7 冒烟逐一核对不变。」
- 关联文件：`backend/app/services/org_service.py:77-82`（`get_full_name_map`）、`backend/app/services/admin_service.py`（`rank_overview` 点亮记录改 SQL 侧过滤）、`backend/test/s7_perf_refactor.py`、`backend/test/docs/s7-perf-refactor-report.md`。
- 测试结果：**待确认（`docs/迭代记录.md` 的 `20c79e3` 条目只有「内容：组织全名批量查询消除 N+1，驾驶舱计数优化。」一行，未记录验证字段）**。可查到的专项报告证据为 `backend/test/docs/s7-perf-refactor-report.md:16`——「每节点达成人数由『10 节点 × 全用户线性扫描』改为用户总步数排序一次 + `bisect_left` 计数（O(U·log U + 10·log U)），计数口径逐样本核对与旧实现一致」；`:23` P1 用例「驾驶舱 route_overview 各节点 lit_count 与 `/admin/rankings` 暴力计数一致（target>0 精确相等；target=0 节点按口径只计有运动记录用户，做范围校验）｜ ✅ nodes=10」；`:34`「S4 管理端驾驶舱/点位/题库 13/13」。（提交 `20c79e3`）

- 需求：管理端驾驶舱/大屏聚合接口（功能）。本文件在此提交中**新建**。
- 修改内容：新增 `GET /api/admin/dashboard`、`/dashboard/trend`、`/activities`、`/screen` 四个聚合接口与对应服务实现；节点与题库管理扩展内容字段。范围决策原文见 `backend/test/docs/s4-admin-dashboard-report.md`：「组织维度（org_stats、大屏组织榜）按用户 2026-10-02 确认完全跳过（延续 2026-10-01 取消决定），dashboard/screen 均不含组织维度。」
- 关联文件：`backend/app/api/routes/admin.py:199-240`、`backend/app/schemas/schemas.py:1198-1263`、`admin/src/views/DashboardView.vue`、`admin/src/views/ScreenView.vue`、`admin/src/api/admin.ts:773-788`、`backend/test/s4_admin_dashboard.py`。
- 测试结果：**待确认（`docs/迭代记录.md` 的 `2289fdd` 条目只有「内容：新增管理端驾驶舱/大屏聚合接口，节点与题库管理扩展内容字段。」一行，未记录验证字段）**。可查到的专项报告证据为 `backend/test/docs/s4-admin-dashboard-report.md:3`——「日期：2026-10-02 ｜ 阶段：S4（管理端接口与 WS 动态）｜ 结果：**13/13 通过**（回归 S3 15/15、S2 8/8）」。（提交 `2289fdd`）
