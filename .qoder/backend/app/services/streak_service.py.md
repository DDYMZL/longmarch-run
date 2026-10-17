# streak_service.py

## 1. 文件路径
`backend/app/services/streak_service.py`

## 2. 文件职责
连续行军服务：以「当天步数 ≥ `STREAK_GOAL_STEPS`（默认 5000）」判定当日达标，维护 `daily_sport.is_goal_completed` 标记与 `users.continuous_days / max_continuous_days` 缓存，计算当前/历史最长连续天数，并在首次达标与跨越里程碑（3/7/14/30/60 天）时写 `DAILY_GOAL` / `STREAK_*` 事件（V2.0 起里程碑**不再发放积分**，docstring `backend/app/services/streak_service.py:5-6`）。

## 3. 业务需求
- 连续行军现行口径（5000 步门槛、当前连续允许今天未达标、缺记录视为中断、缓存字段用途、里程碑不发积分）逐条见 `.qoder/REQUIREMENTS.md` §3.2，本文不复制其正文。
- 与「今日目标 20000 步」（展示用，`backend/app/services/sport_service.py:27`）是**两个独立数字**：5000 是连续行军门槛，文案已明确区分（`docs/迭代记录.md` 提交 `9c8f13f` 条目）。
- 统一事件系统（`be7e126`，2026-10-01）引入本文件；里程碑积分在 V2.0 台账重构（`2f3f333`）中移除。

## 4. 核心功能

### 4.1 纯函数（无 DB，勋章判定复用同一套）
- `longest_run(days)`（`backend/app/services/streak_service.py:22-31`）：日期字符串集合中最长连续自然日天数；排序去重后逐日比较 `cur - prev == 1 天`，**缺记录的日期视为中断**。
- `streaks_of(achieved_days)`（`:34-49`）：由达标日期集合算 `(当前连续, 历史最长)`——「今天」取**北京时间** `now_beijing().date()`（`:42`）；今天未达标时允许从昨天起数（今日尚未结束连续仍有效，`:43-44`），昨天也未达标则为 0；历史最长取 `max(longest_run(...), current)`（`:49`）。

### 4.2 读取侧重算
- `compute_streaks(db, user_id)`（`:52-59`）：查该用户全部 `daily_sport.is_goal_completed=True` 的日期，交给 `streaks_of` 重算。**以 `daily_sport` 为唯一真相**，不读 users 缓存。

### 4.3 写入侧维护
- `on_sport_written(db, user_id, date)`（`:62-103`）：运动记录写入后的连续行军维护（由 `backend/app/services/sport_service.py:59` 的 `_after_written` 在主数据 commit 后调用）：
  1. 当日无 `daily_sport` 记录直接返回 None（`:69-75`）；
  2. 达标判定 `reached = steps >= settings.STREAK_GOAL_STEPS`（`:77`，配置读取点）；**与 `is_goal_completed` 现值相同（未翻转）则直接返回 None，不产生新事件**（`:78-79`）；
  3. 翻转时回写 `is_goal_completed` 并 commit（`:80-81`）；
  4. 重算 `compute_streaks` 并覆盖 `users.continuous_days / max_continuous_days` 缓存后再 commit（`:83-89`）——`max_continuous_days` 直接取重算值（`6f2cfc3` 起不再 `max(best, old_best)`，历史步数下调后缓存可被修正）；
  5. `reached=False`（达标翻转为未达标）到此为止，返回 None（`:90-91`）；
  6. 首次达标写 `DAILY_GOAL` 事件（含 date/steps/streak，`:93-95`）；
  7. 遍历 `event_service.STREAK_MILESTONES`（3/7/14/30/60，`backend/app/services/event_service.py:20`），满足「current ≥ 里程碑 且 旧 max_continuous_days < 里程碑 且 `has_event` 无同类事件」三条件时写 `STREAK_{n}` 事件（`:97-102`）——**只写事件，不发积分**；
  8. 返回当日首次达标后的当前连续天数（`:103`）。

### 4.4 启动兜底
- `recompute_all(db)`（`:106-130`）：全量重算 users 连续天数缓存——`yield_per(5000)` 流式读取全部达标日期按用户分组（`:111-118`），逐用户 `streaks_of` 与缓存比对，**只把不一致的用户**收集后 `bulk_update_mappings` 一次批量回写并 commit（`:120-129`）；返回更新用户数。应用启动时执行（`backend/app/main.py:47`，在步行台账修复 `:48` 之前）。

## 5. 输入与输出
- `longest_run(days: Iterable[str]) -> int`；`streaks_of(achieved_days: Set[str]) -> Tuple[int, int]`（当前, 最长）；`compute_streaks(db, user_id) -> Tuple[int, int]`。
- `on_sport_written(db, user_id, date: str) -> Optional[int]`：达标翻转且达标时返回当前连续天数，其余（无记录 / 状态未变 / 翻转为未达标）返回 None；**返回值当前无调用方消费**（`backend/app/services/sport_service.py:59` 不接收返回值）。
- `recompute_all(db) -> int`：缓存被修正的用户数。
- 无 `ValueError` 业务异常、无 HTTP 错误码——本模块不直接暴露路由，数据经 `sport_service.get_today`（`backend/app/api/routes/sport.py:24-26`，`GET /api/sport/today` 的 current_streak/max_streak/streak_goal 等字段，`backend/app/services/sport_service.py:218-233`）、`get_calendar`（`:303`）、`profile_service`（`backend/app/services/profile_service.py:93`）间接下发。

## 6. 依赖关系
- **依赖模块**：`app.core.config.settings`（`:16`）、`app.core.helpers.now_beijing`（`:17`）、ORM 模型 `DailySport/User`（`:18`）、`event_service`（`:19`）。**不依赖 points_service**（`2f3f333` 移除里程碑积分后解除该依赖）。
- **数据库表**：读写 `daily_sport`（is_goal_completed）、`users`（continuous_days/max_continuous_days 缓存，`backend/app/models/models.py:185` docstring「由 streak_service 维护」）、写 `user_event`（经 `event_service.record`）。
- **被依赖**：
  - `backend/app/services/sport_service.py:25`（`on_sport_written :59`、`compute_streaks :218`、`:303`）；
  - `backend/app/services/medal_service.py:25`（纯函数 `streaks_of :78`、`longest_run :89`——persistence/streak-30/fearless 勋章判定复用）；
  - `backend/app/services/profile_service.py:22`（`compute_streaks :93`）；
  - `backend/app/main.py:38`（启动兜底 `:47`）。
- **事务边界（谁 commit）**：`on_sport_written` 内部**分段 commit**——翻转 is_goal_completed（`:81`）、users 缓存（`:89`）、每个事件由 `event_service.record` 各自 commit（`backend/app/services/event_service.py:121`）；`recompute_all` 批量回写后一次 commit（`:129`）。**本模块不在调用方事务内运行**：它由 `sport_service._after_written` 在主数据提交后触发（`backend/app/services/sport_service.py:55-59` docstring「均在主数据提交后触发」）。

## 7. 业务规则
- **达标门槛**：当天步数 ≥ `STREAK_GOAL_STEPS=5000` 即完成当日行军（`:77`；下发给前端作 `streak_goal`，`backend/app/services/sport_service.py:229`）。达标判定用当日 `daily_sport.steps` 终值（同日步数覆盖而非累加，`backend/app/models/models.py:232`）。
- **当前连续**：从今天（**北京时间**，`:42`）往前数连续达标日；今天未达标允许从昨天起数，昨天也未达标为 0（`:43-48`）。
- **中断判定**：缺 `daily_sport` 达标记录的日期视为中断（`longest_run :23` docstring、`:28`）。
- **数据真相与缓存**：连续天数以 `daily_sport.is_goal_completed` 实时重算为准（`compute_streaks :52-59`）；`users.continuous_days / max_continuous_days` 只是缓存（供管理端列表免逐户重算，docstring `:8-9`），启动时 `recompute_all` 全量兜底（docstring `:9`）。
- **事件规则**：`DAILY_GOAL` 在「未达标→达标」翻转时写入，**不经 has_event 去重**（`:93-95`），依赖翻转本身的一次性（正常链路步数只增不减，同日最多触发一次）；`STREAK_*` 里程碑为一次性成就，以 `has_event` 事件表去重（`:99-101`）。
- **里程碑不发积分**：V2.0 起只写事件（docstring `:5-6`；`2f3f333` 删除了原 `points_service.grant("连续行军N天", ...)` 调用）。旧的「里程碑积分」属已废弃规则（`.qoder/REQUIREMENTS.md` §12）。
- **时区口径**：「今天/昨天」判定用北京时间 `now_beijing()`（`:42`；`backend/app/core/helpers.py:17-19`）；`2f3f333` 之前用 `datetime.now()`（服务器本地时区），已修正。`daily_sport.date` 本身即北京时间自然日（写入侧 `backend/app/services/sport_service.py:143` docstring）。
- **补签未实现**：本模块**不读写** `daily_sport.is_makeup / makeup_at`（两列为补签预留，`backend/app/models/models.py:235`、`:248-249`），连续行军判定只看 `steps` 与 `is_goal_completed`；全仓无补签业务写入点，属「字段已建、业务未实现」（`.qoder/REQUIREMENTS.md` §3.3）。

## 8. 修改约束
- **事件写入不得影响主流程**：事件在主数据提交后写入（`backend/app/services/event_service.py:7-8` 约定）；把 `on_sport_written` 挪进主事务或让其抛异常中断步数同步，均破坏该约定。
- **`streaks_of`/`longest_run` 是勋章判定的共用纯函数**（`backend/app/services/medal_service.py:78`、`:89`），改连续性语义会同时改变 persistence（连续 7 天）/streak-30（连续 30 天）/fearless（连续 7 天日行万步）勋章的发放——须一并回归。
- **`max_continuous_days` 直接覆盖为重算值**（`:88`）是 `6f2cfc3` 的有意修复（历史步数下调后缓存随之修正），不得改回 `max(best, old_best)`，否则错误缓存永不回退。
- **users 缓存与 `compute_streaks` 的一致性依赖两处兜底**：写入侧翻转时更新（`:83-89`）+ 启动 `recompute_all`（`backend/app/main.py:47`）。新增绕过 `on_sport_written` 的 `daily_sport` 写入路径（如数据修复脚本）后，必须手动触发重算，否则管理端列表读到过期缓存。
- `STREAK_GOAL_STEPS` 改动属业务规则变更，须前后端同步（前端展示「连续行军目标」文案与 `streak_goal` 字段，`backend/app/services/sport_service.py:229`；`backend/AGENTS.md` §4 不变量 4）。
- 里程碑档位 `3/7/14/30/60` 定义在 `event_service.STREAK_MILESTONES`（`backend/app/services/event_service.py:20`），**不在本文件**；增删档位同时影响事件文案（`event_service.build_text :40-41`）与画像统计（`backend/app/services/profile_service.py:59-60`）。
- `recompute_all` 的流式分组 + 只回写变化用户是性能修复成果（`f59892e`，报告 `backend/test/docs/s14-hotspot-sql-report.md`），不得改回逐户查询+逐户更新。

## 9. 当前实现状态
- **已实现**：达标翻转维护、连续天数重算（读取侧/写入侧/启动兜底三条路径）、DAILY_GOAL 与 STREAK_* 事件、缓存批量修复、纯函数被勋章复用。
- **事实性陈述（非缺陷判定）**：
  - 补签业务未实现：`is_makeup/makeup_at` 为预留死字段，本模块不读取（见 §7；`.qoder/REQUIREMENTS.md` §3.3、§14 第 9 条——补签产品规则无需求依据，待产品确认）。
  - `on_sport_written` 的多次分段 commit（`:81`、`:89` 及事件各自 commit）意味着「is_goal_completed 已翻转但缓存/事件未写」的中间态在进程崩溃时可能出现，由启动 `recompute_all` 兜底修复缓存（事件不补发）——现状记录，是否需要更强一致性待确认。
  - `recompute_all` 启动兜底会把全表达标日期载入内存分组（`:111-118`，`yield_per(5000)` 流式读取但 `achieved` dict 常驻），用户量大幅增长后的内存余量——待确认（无实测数据）。
  - `STREAK_*` 里程碑的「old_best < milestone」条件读的是**更新前**的 `user.max_continuous_days`（`:85`），配合 `has_event` 双重防重发。
- **无待开发项**：本文件范围内无已确认未落地的需求（补签属产品规则未确认，见上）。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/streak_service.py`（4 个提交，本文件由 `be7e126` 创建）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-15
- 需求：近 7 日微信运动补录——历史步数可下调，连续天数缓存需随之修正（`6f2cfc3`）。
- 修改内容：`on_sport_written` 在达标状态**任一方向翻转**时都重算并回写 users 缓存（原先翻转为未达标时提前返回、缓存不修正）；`max_continuous_days` 由 `max(best, old_best)` 改为直接覆盖为重算值。
- 关联文件：`backend/app/services/sport_service.py`（近 7 日补录主链路）、`backend/app/services/points_service.py`（结余积分）、`backend/app/services/quiz_service.py`（题目轮换）、`docker/init/019、020` 迁移。
- 测试结果：S22 专项 13/13（含历史下调后连续天数缓存修正断言，`backend/test/s22_history_sync_quiz_rotation.py:87`）、S18 21/21、S20 25/25；Python 编译通过（`docs/迭代记录.md`）。遗留：当时本机 Docker 不可用，未执行真实 openGauss 迁移验证。

### 2026-10-13
- 需求：V2.0 积分台账重构——移除里程碑积分（`2f3f333`）。
- 修改内容：删除跨越里程碑时的 `points_service.grant("连续行军N天", ...)` 调用（里程碑只写事件）；「今天」判定由 `datetime.now().date()` 改为 `now_beijing().date()`（北京时间口径）；解除对 points_service 的依赖。
- 关联文件：`backend/app/services/points_service.py`（台账重写）、`docker/init/017_points_ledger.sql`。
- 测试结果：SQLite 冒烟 20/20、openGauss 016/017 迁移执行、回填核对 132 人 111 天差异 0、10 线程并发补步一致；回归 s11 8/8、s18 14/14、s19 25/25、s6 8/8（`docs/迭代记录.md`）。

### 2026-10-11
- 需求：热点查询 SQL 聚合化与去 N+1（`f59892e`，性能优化/缺陷修复）。
- 修改内容：抽出纯函数 `streaks_of`/`longest_run`；**逻辑修复**——原「历史最长连续」按记录顺序计数，中间缺几天也算连续，导致最长连续天数与「坚持」「无畏」勋章被高估，改为按自然日相邻判定；`recompute_all` 改为流式分组计算、只批量回写有变化的用户（原先每用户 1 查询 + 1 更新）。
- 关联文件：`backend/app/services/medal_service.py`（复用纯函数）、`docker/init/012_perf_indexes.sql`。
- 测试结果：openGauss 已应用 012；e2e_full_flow 178/178、e2e_datasync 23/23、S2–S7 及 P0/P1/P2 冒烟全部通过（`docs/迭代记录.md`；报告 `backend/test/docs/s14-hotspot-sql-report.md:17`）。注：e2e 两脚本后按 V1 口径列为遗留（`.qoder/REQUIREMENTS.md` §15），此处验证结论为该提交当时记录。

### 2026-10-01
- 需求：统一事件系统与连续行军机制（`be7e126`）。
- 修改内容：创建本文件——`on_sport_written`（当日首次达标推进连续天数、跨越里程碑时发放积分并写事件）、`compute_streaks`、`recompute_all` 启动重算缓存；勋章体系扩展 persistence/streak-30 等判定并接入事件链。
- 关联文件：`backend/app/services/event_service.py`（新增）、`backend/app/services/sport_service.py`、`medal_service.py`、`backend/app/core/config.py`（`STREAK_GOAL_STEPS` 等 3 项新配置）。
- 测试结果：`docs/迭代记录.md` 该条目未记录验证字段；提交 `be7e126` 的 commit message 载明「新增 S2 冒烟脚本（8/8 通过）与验收报告」。
