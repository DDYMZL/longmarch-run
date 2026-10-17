# profile_service.py

## 1. 文件路径

`backend/app/services/profile_service.py`（201 行）

## 2. 文件职责

小程序「个人档案」页的**只读聚合层**：把分散在运动、连续行军、路线、答题、勋章、积分、组织 7 个域的统计数据在一次请求内拼成 `summary`，并从统一事件表 `user_event` 生成 `timeline`（我的长征足迹）；另含需求 §17 的**五维数据画像**归一化算法（`backend/app/services/profile_service.py:1-5` 模块文档串）。

本文件**不写库**——没有任何 `db.add` / `db.commit`。

## 3. 业务需求

- 功能 1「个人档案聚合」由 `18c2121`（2026-10-02）随小程序聚合接口一批交付；功能 2.6「我的长征足迹」同批（`:1-4` 文档串标注「功能 1」「功能 2.6」）。
- 五维数据画像对应需求 §17（`:24` 注释「需求 §17.3：画像必须基于真实统计数据，各维度 0~100」；`:43-49` docstring 引 §17.2 五个维度与 §17.4「只展示数据」），由 `3202404`（2026-10-03，P1-7）交付。
- 现行需求口径见 `.qoder/REQUIREMENTS.md` §9「个人中心与我的」；聚合接口的分层与命名契约见 `.qoder/ARCHITECTURE.md` §3、§4.2。本文档不复制其正文。

## 4. 核心功能

### 4.1 画像满分参照常量（`profile_service.py:24-28`）

`PORTRAIT_DAYS_FULL = 30`（运动天数）、`PORTRAIT_STREAK_FULL = 30`（连续天数）、`PORTRAIT_QUIZ_FULL = 50`（答题次数）。`:24-25` 注释明确「满分参照值集中在此，调整口径只改配置」。`backend/test/p1_portrait.py:10` 的断言公式与本文件对齐。

### 4.2 `_portrait(...)`（`profile_service.py:31-67`）

纯函数，10 个入参全部由 `get_summary` 提供，无 DB 访问。五维公式（`:51-60`，与 `:43-49` docstring 一致）：

| 维度 | 公式 | 行号 |
|---|---|---|
| `march` 行军 | `total_steps / route_total_steps × 70 + min(sport_days, 30)/30 × 30`（分母为 0 时取 1 兜底） | `:51-52` |
| `persistence` 坚持 | `min(max_streak,30)/30 × 60 + min(current_streak,30)/30 × 40` | `:53-56` |
| `knowledge` 知识 | `min(quiz_total,50)/50 × 50 + correct_rate × 0.5` | `:57` |
| `route` 路线 | 直接取 `progress`（节点完成百分比） | `:65` |
| `achievement` 成就 | `勋章完成比例 × 70 + 已达成的连续行军里程碑档数 / 总档数 × 30` | `:58-60` |

里程碑档数取自 `event_service.STREAK_MILESTONES = [3, 7, 14, 30, 60]`（`backend/app/services/event_service.py:20`，本文件 `:59-60` 引用）。五维最终一律 `min(100, round(...))`（`:62-66`），保证 0~100 整数。

`route_total_steps` 由调用方传 `route["total_steps"]`（`:174`），其值是**最后一个启用节点的累计步数门槛**（`backend/app/services/march_service.py:157` `total_steps_target = nodes_def[-1].target_steps`）。

### 4.3 `_join_days(created_at)`（`profile_service.py:70-75`）

加入天数，**注册当天为第 1 天**（`:71` docstring）。`created_at` 为 `None` 时返回 1（`:73-74`）；否则 `to_local(created_at).date()` 把 UTC 存储转北京日期（`:74`），再与 `datetime.now().date()` 相减 +1，并用 `max(..., 1)` 兜住负值（`:75`）。

⚠ `:75` 用的是 **`datetime.now()`（服务器本地时区）**，而 `:74` 的加入日期是**北京时间**；项目其余业务日期一律走 `helpers.today_str()`（固定 UTC+8，`backend/app/core/helpers.py:22-24`）。服务器时区非 UTC+8 时，跨日临界点两者会差一天（见 §9）。

### 4.4 `get_summary(db, user)`（`profile_service.py:78-181`）

返回 6 个顶层键，由 `ProfileSummaryOut`（`backend/app/schemas/schemas.py:664-671`，`CamelModel` → 出参 camelCase）校验。逐段与对应 SQL：

| 段 | 行号 | 查询 |
|---|---|---|
| 运动统计 | `:80-91` | **1 条** SQL 聚合 `daily_sport`：`count(id)` / `sum(steps)` / `sum(distance)` / `max(steps)`，`coalesce` 兜 0；`total_distance` 保留两位（`:91`） |
| 连续行军 | `:93` | **1 条**：`streak_service.compute_streaks`（`backend/app/services/streak_service.py:52-59`，按 `is_goal_completed` 取达标日期集合后内存算连续） |
| 路线进度 | `:95-117` | `march_service.get_route`（`backend/app/services/march_service.py:190-220`）：**3 条**（启用节点、累计步数、已点亮节点）+ 全程完成时**再 1 条**查 `users.route_ceremony_at`（`march_service.py:206-209`）。本段在内存里派生 `progress`（`:98`）、`current_node`＝最后一个 completed 节点（`:100-106`）、`next_node`（`:107-117`，含 `remain`） |
| 答题统计 | `:119-130` | **1 条** SQL 聚合 `quiz_records`：`count(id)` / `sum(total_count)` / `sum(correct_count)` / `sum(case(score >= 100))`；`correct_rate = round(correct/answered×100)`，`answered` 为 0 时取 0（`:130`） |
| 勋章 | `:132-133` | **2 条**：`user_medals` 本人计数、`medal_defs` 全表计数 |
| 组织全名 | `:135` | `org_service.get_full_name`（`backend/app/services/org_service.py:72-74` → `get_path:59-69`）：**按组织层级逐级回溯，每层 1 条 SQL**，上限 32 层（`org_service.py:63` 的 `guard < 32`）。`user.org_id` 为空时直接返回 `""`，不查库 |
| 积分 + 名次 | `:165-168` | **2 条**：`points_service.get_breakdown`（`backend/app/services/points_service.py:176-179`，单条 `group by source_type`）、`rank_service.get_user_rank`（`backend/app/services/rank_service.py:85-88`，窗口函数子查询取单值） |

合计 **约 10 条 SQL + 组织层级数**（1~32）。**没有「按行循环查库」的经典 N+1**——运动与答题统计均为库内聚合（`f59892e` 的整改项，见 §10）；唯一的逐级查询是组织全路径名，且被 32 层上限与树深度（种子树为 3 级）双重约束。

返回结构（`:137-181`）：`user{nickname, avatar, org_name, created_at, join_days}`、`stats{total_steps, total_distance, sport_days, current_streak, max_streak, max_day_steps, avg_daily_steps, progress, lit_count, total_count, current_node, next_node}`、`quiz{total_count, correct_rate, full_score_count}`、`medals{owned_count, total_count}`、`points{total, walk, quiz, rank}`、`portrait{march, persistence, knowledge, route, achievement}`。

`avg_daily_steps` 在内存里算：`round(total_steps / sport_days)`，`sport_days` 为 0 时取 0（`:152`）。

### 4.5 `get_timeline(db, user_id, limit=50)`（`profile_service.py:184-201`）

**1 条** SQL：`user_event` 按 `user_id` 过滤、`event_time DESC, id DESC` 排序、`limit` 截断（`:186-192`）。文案由 `event_service.build_text(event_type, event_data)` **在内存中生成**（`:197`，纯函数、不查库），与小程序足迹、管理端实时动态同源（`:4` 文档串）。每项输出 `event_type` / `event_time` / `text` / `data`（`:194-199`），`event_data` 为 `None` 时兜空字典。

排序键含 `id DESC` 作次级键，保证同一秒内多条事件顺序稳定。索引：`docker/init/005_upgrade.sql:78-79`（`user_event(user_id)`、`user_event(event_time)`）、`docker/init/012_perf_indexes.sql:10`（`user_event(user_id, event_type)`）。

## 5. 输入与输出

### 对外 HTTP 端点（2 个）

| 方法 + 路径 | 权限依赖 | 调用点 | response_model |
|---|---|---|---|
| `GET /api/profile/summary` | `require_activity_view`（活动结束后可按配置放行） | `backend/app/api/routes/profile.py:14-16` | `ProfileSummaryOut`（`backend/app/schemas/schemas.py:664-671`） |
| `GET /api/profile/timeline?limit=` | `require_activity_view` | `backend/app/api/routes/profile.py:19-25` | `ProfileTimelineOut`（`backend/app/schemas/schemas.py:680-681`） |

- `limit` 由路由校验 `Query(50, ge=1, le=200)`（`backend/app/api/routes/profile.py:21`），越界 422；service 侧默认值同为 50（`:184`）。
- 两个端点都**只能查自己**：`user_id` 取自 `get_current_user` 返回的 `User`（`backend/app/api/routes/profile.py:16`、`:25`），不接受外部传入 id。
- 全部字段 camelCase 输出（`CamelModel`，`backend/app/schemas/schemas.py:17-22`）；子模型行号：`ProfileUser:596-607`、`ProfileNodeRef:609-613`、`ProfileNextNode:615-617`、`ProfileStats:619-632`、`ProfileQuizStats:634-638`、`ProfileMedalStats:640-643`、`ProfilePointsStats:645-652`、`ProfilePortrait:654-662`、`TimelineItem:673-678`。
- 错误码：401（无/坏 Token）、403 + `X-Account-Status: disabled`（停用）、403 + `X-Activity-Status`（活动闸门，`backend/app/api/deps.py:66-72`）。**本服务自身不抛业务异常**，无 400/404 分支。

## 6. 依赖关系

- **依赖**：`sqlalchemy`（`case`、`func`、`Session`，`:9-10`）；`backend/app/core/helpers.py`（`to_local`，`:12`）；`backend/app/models/models.py`（`DailySport`、`MedalDef`、`QuizRecord`、`RouteNode`、`User`、`UserEvent`、`UserMedal`，`:13-21`）；6 个同层 service（`:22`）：`event_service`、`march_service`、`org_service`、`points_service`、`rank_service`、`streak_service`。
  - 注意 `:13-21` 导入了 `RouteNode` 但**函数体内未直接使用**（节点查询都委托给 `march_service`）。
- **被依赖**：仅 `backend/app/api/routes/profile.py:9`（import）、`:16`、`:25`。**没有任何管理端调用**（管理端人员详情聚合是另一套实现，`backend/app/services/admin_service.py:580-595`）。
- **数据库表**（全部只读）：`daily_sport`、`quiz_records`、`user_medals`、`medal_defs`、`lit_nodes`（经 `march_service`）、`route_nodes`（经 `march_service`）、`points_log`（经 `points_service`）、`organizations`（经 `org_service`）、`users`、`user_event`。
- **前端消费**：`frontend/services/profile.js:11`（`getSummary`）、`:19-23`（`getTimeline`）；页面 `frontend/pages/profile/profile.js:56-57`（档案页同时取 summary + timeline(50)）、`frontend/pages/mine/mine.js:35`（「我的」页取 summary）、`frontend/pages/ceremony/ceremony.js:45`（仪式页取 summary，失败容错为 `null`）。

## 7. 业务规则

1. **实时聚合、不做冗余存储**：所有数字每次请求从业务表现算（`:2-3` 文档串），无缓存、无物化视图，因此与步数/答题/积分写入天然一致，代价是每次请求约 10 条 SQL。
2. **积分口径 V2.0**：`points` 段直接透传 `points_service.get_breakdown`，`total = walk + quiz`（`backend/app/services/points_service.py:176-179`）。**点亮节点不再发积分**（V2.0 已取消），故本文件不含任何积分发放逻辑。步行积分 = 累计步数 ÷ `POINTS_WALK_STEPS_PER_POINT`（默认 1000，不足不计），**无单日封顶**（历史项 `POINTS_WALK_STEP_CAP` 已删除，见 §10 的 `9cb65b8`）。`stats.total_steps` 是 `daily_sport.steps` 的**原始累计**（`:83`），与步行积分同口径。
3. **`total_distance` 是估算值**：来自 `daily_sport.distance` 求和（`:84`），该列在写入时按 `STRIDE_M`（默认 0.7 米/步）估算（`backend/app/services/sport_service.py:41-43`）。
4. **路线口径与 march 一致**：`current_node` 取最后一个 `status == "completed"` 的节点（`:100-101`），依赖 `march_service` 已把「累计步数达标的节点视为点亮」并入状态（`backend/app/services/march_service.py:196-199`）。
5. **答题正确率按「题」而非按「天」**：分母是 `sum(total_count)`（累计作答题数），分子是 `sum(correct_count)`（`:119-130`）；`quiz.total_count` 是**答题天数**（`count(QuizRecord.id)`，每日一条记录）。
6. **画像只展示数据、不做评价**（需求 §17.4，`:43`、`:49`），且必须基于真实统计（`:24`）——不得写死或按主观档位映射。
7. **隐藏勋章不影响 `medals` 计数**：`owned_count` / `total_count` 统计全部 `medal_defs` 行（`:132-133`），含 `hidden=True` 的 `fearless`。
8. **足迹文案后端生成**：`text` 由 `event_service.build_text` 统一产出（`:197`），前端不得自行拼装，否则与管理端实时动态口径分叉。
9. **幂等/并发**：只读接口，无幂等与并发约束；不在 `medal_service.check_and_grant` 副作用链上（`backend/AGENTS.md` §4 不变量 5 不涉及本文件）。

## 8. 修改约束

1. **出参 camelCase 且结构不得单边变更**：`ProfileSummaryOut` 六段结构被 `frontend/pages/profile/profile.js`、`mine.js`、`ceremony.js` 直接消费（`backend/AGENTS.md` §4 不变量 1、4）。删字段（如 `9cb65b8` 删 `scoredTotalSteps`）必须前后端同批改。
2. **新增统计项优先并入已有聚合查询**，不要在 `get_summary` 里加逐行循环查库——本文件是 `f59892e`「热点查询 SQL 聚合化」的重点整改对象（`backend/test/docs/s14-hotspot-sql-report.md:19`），退化即性能回归。
3. **画像公式改动属业务规则变更**：需同步 `frontend/pages/profile/profile.js` 的雷达卡展示、`backend/test/p1_portrait.py:10` 的断言公式与需求 §17 文档；满分参照值只改 `:26-28` 三个常量，不要在公式里散落字面量。
4. **不得改 `get_timeline` 的排序键**：`event_time DESC, id DESC`（`:189`）与管理端实时动态（`backend/app/services/event_service.py:75-84`）保持一致，缺 `id` 次级键会导致同秒事件翻页抖动。
5. **时间口径**：库内 `created_at` / `event_time` 为 UTC naive，对外展示须经 `helpers.to_local`；新增日期计算请统一用 `helpers.today_str()` / `now_beijing()` 而不是 `datetime.now()`（见 §9 已知问题 1）。
6. **不要在此处发放积分或勋章**：积分统一走 `points_service`、勋章统一走 `medal_service.check_and_grant`（`backend/AGENTS.md` §4 不变量 5）；本文件是纯读侧聚合。
7. **组织全名如需批量化**，应改用 `org_service.get_full_name_map`（`backend/app/services/org_service.py:77-82`，整表一次加载），而不是继续在单用户路径上逐级回溯。

## 9. 当前实现状态

- **已实现**：`summary` 六段聚合、五维画像、`timeline` 足迹；两端点均已挂活动查看闸门；运动/答题统计已 SQL 聚合化（`f59892e`）；积分口径已随 V2.0 台账重构对齐（`2f3f333`）并移除单日封顶字段（`9cb65b8`）。
- **存在问题（事实性陈述）**：
  1. `_join_days` 混用时区：`:74` 加入日期按北京时间，`:75` 「今天」按 `datetime.now()` 服务器本地时区。服务器时区非 UTC+8 时，跨日临界点 `join_days` 会偏差 1 天。生产服务器时区未在仓库中固化——**待确认**（`.qoder/ARCHITECTURE.md` §12 部署章节未记录 OS 时区）。
  2. `:135` 组织全名走逐级回溯（每层 1 条 SQL，上限 32 层），未使用批量版 `get_full_name_map`；单用户场景影响有限，但与本文件其余部分的「一次聚合」风格不一致。
  3. `:13-21` 导入的 `RouteNode` 未被使用（死导入）。
  4. `get_summary` 无缓存：「我的」页与档案页每次 `onShow` 都会触发全量聚合（约 10 条 SQL）。用户量增长后是否需要短 TTL 缓存——**待确认**。
- **待开发**：无（本文件范围内）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/services/profile_service.py`（**6 个提交**）与 `docs/迭代记录.md` 对应条目，按时间倒序。

> 引用约定：`docs/迭代记录.md` 按时间倒序在文件头部持续追加新条目，**行号会随每次记录整体漂移**（本次建档期间即观测到一次 +12 行偏移），因此本章对该文件一律按「提交哈希 + 日期」定位、不写行号；其余代码与测试报告引用仍为仓库根相对路径 + 行号。

### 2026-10-15（`9cb65b8`，18:03）
- 需求：步行积分取消单日 20000 封顶，改为累计步数 ÷ 1000 计分（业务规则调整）。
- 修改内容：删除 `get_summary` 中的 `scored_total_steps`（`points_service.scored_total_steps` 调用与 `stats` 字段各 1 处，共 -3 行），`stats.total_steps` 保留原始累计（`git show 9cb65b8 -- backend/app/services/profile_service.py`）。
- 关联文件：`backend/app/services/points_service.py`、`backend/app/core/config.py`（删 `POINTS_WALK_STEP_CAP`）、前端积分明细页、`backend/test/s20_v2_regression.py`。
- 测试结果：`docs/迭代记录.md` 的 `9cb65b8` 条目「验证」原文——「S20 26/26（含新边界 25000→25）、S23 13/13、S22 14/14；`node --check` 与 `py_compile` 通过。微信开发者工具机型验收需远程后端部署后执行」。

### 2026-10-15（`85c5a55`，17:38）
- 需求：「我的」页累计运动(步)与步行积分口径不一致（缺陷修复）。
- 修改内容：`get_summary` 新增 `scored_total_steps`（各日 `min(步数, 20000)` 求和）供前端展示（+3 行）。**该字段已于同日由 `9cb65b8` 删除**（见上条），当前代码不含此字段。
- 关联文件：`backend/app/services/points_service.py`（`_capped_sum` → `scored_total_steps`）、`frontend/pages/mine/mine.js`。
- 测试结果：`docs/迭代记录.md` 的 `85c5a55` 条目「验证」原文——「SQLite TestClient 冒烟通过——单日 +25000 步后 `totalSteps=25000 / scoredTotalSteps=20000 / walk=20`，再 +1500 步 scoredTotalSteps 恒 20000（封顶生效），walk = scoredTotalSteps // 1000；`node --check` 与 `py_compile` 通过」。

### 2026-10-13（`2f3f333`，11:25）
- 需求：V2.0 需求三/四——积分台账重构与总积分排名。
- 修改内容：`points` 段改为台账口径（`total = walk + quiz`），档案汇总增加总积分 / 步行积分 / 答题积分与总积分榜名次（`docs/迭代记录.md` 的 `2f3f333` 条目「内容」末项：「档案汇总、管理端排名、人员详情、CSV 均增加总积分 / 步行积分 / 答题积分」）。
- 关联文件：`backend/app/services/points_service.py`、`backend/app/services/rank_service.py`、`docker/init/017_points_ledger.sql`。
- 测试结果：`docs/迭代记录.md` 的 `2f3f333` 条目「验证」原文——「SQLite 冒烟 20/20 通过：999 / 1000 / 1999 / 20000 / 25000 步边界……档案与管理端及 CSV 一致」；「openGauss 上 016 / 017 迁移已执行……核对 132 人 111 天差异为 0」；「回归：s11 8/8、s18 14/14、s19 25/25、s6 8/8 通过」。

### 2026-10-11（`f59892e`）
- 需求：后端热点查询 SQL 聚合化与去 N+1（性能优化）。
- 修改内容：档案统计改为 SQL 聚合（`count`、`sum`、`case`），即当前 `:80-89` 运动段与 `:119-129` 答题段（`docs/迭代记录.md` 的 `f59892e` 条目「内容」：「今日播报、档案统计改为 SQL 聚合（count、sum、case）」；`backend/test/docs/s14-hotspot-sql-report.md:19`「档案页的运动、答题统计改为 SQL 聚合（count/sum/max）」）。
- 关联文件：`backend/app/services/rank_service.py`、`backend/app/services/medal_service.py`、`backend/app/services/event_service.py`、`backend/app/services/streak_service.py`、`docker/init/012_perf_indexes.sql`。
- 测试结果：`docs/迭代记录.md` 的 `f59892e` 条目「验证」原文——「openGauss 已应用 012。e2e_full_flow 178/178，e2e_datasync 23/23，S2–S7、P0/P1/P2、昵称冒烟全部通过。排行、播报结果与旧实现逐项一致（92 用户 / 20 用户样本）」。

### 2026-10-03（`3202404`，02:57）
- 需求：P1-7「我的成就总览与数据画像」。
- 修改内容：新增五维画像评分（`_portrait` 与三个满分参照常量），`get_summary` 返回值增加 `portrait` 段。
- 关联文件：`frontend/pages/profile/profile.js`（成就六格 / 雷达卡）、`backend/test/p1_portrait.py`。
- 测试结果：**待确认**（`docs/迭代记录.md` 的 `3202404` 条目只有内容摘要「画像五维评分接口+档案页成就六格/雷达卡」，未记录验证字段）。同期测试报告 `backend/test/docs/p1-portrait-report.md:34` 记载「执行：`python test/p1_portrait.py` —— **3/3 通过**」（P1O-01 值域 0~100 与全新用户基线、P1O-02 公式交叉验证、P1O-03 未带 token 401），该报告未在本次迭代记录条目中被引用。

### 2026-10-02（`18c2121`，00:12）
- 需求：新增小程序聚合接口（档案 / 足迹 / 日历 / 播报 / 知识画像）并扩展现有契约。
- 修改内容：创建本文件——`get_summary` 档案聚合（功能 1）与 `get_timeline` 足迹时间轴（功能 2.6），配套 `backend/app/api/routes/profile.py` 两个端点与 `ProfileSummaryOut` / `ProfileTimelineOut` 契约。
- 关联文件：`backend/app/api/routes/profile.py`、`backend/app/schemas/schemas.py:596-681`、`backend/app/main.py:81`、`frontend/services/profile.js`。
- 测试结果：**待确认**（`docs/迭代记录.md` 的 `18c2121` 条目只有内容摘要「新增小程序聚合接口（档案/足迹/日历/播报/知识画像）并扩展现有契约」，未记录验证字段）。同期测试报告 `backend/test/docs/s3-miniapp-aggregates-report.md:3` 记载「日期：2026-10-02 ｜ 阶段：S3（小程序聚合接口）｜ 结果：**15/15 通过**」，其 `:43` 另记「`profile_service._join_days` 按 UTC→本地日期计算」；该报告未在本次迭代记录条目中被引用。
