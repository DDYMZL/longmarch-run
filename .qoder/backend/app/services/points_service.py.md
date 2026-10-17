# points_service.py

## 1. 文件路径
`backend/app/services/points_service.py`

## 2. 文件职责
积分台账服务（V2.0）：**总积分 = 步行积分 + 答题积分**，全部由后端按源数据（`daily_sport` / `quiz_answers`，历史日回退 `quiz_records`）计算。对外提供计分函数、每人每来源每日一行的幂等台账写入（`set_daily`）、概览/明细查询、排名子查询，以及全量核对修复（`recompute_*`）。是全后端**唯一**允许写 `points_log` 计分行（source_type=walk/quiz）的模块（`backend/AGENTS.md` §4 不变量 5）。

## 3. 业务需求
- 积分体系 V2.0 现行口径（总公式、步行累计结余口径、答题 2 分/题封顶 10、台账粒度与幂等）逐条见 `.qoder/REQUIREMENTS.md` §4，本文不复制其正文，只补文件级实现细节。
- 已废弃规则（登录/达标/点亮/里程碑积分、单日 20000 步封顶 `POINTS_WALK_STEP_CAP`、`scoredTotalSteps` 字段、`rules.walkStepCap`）集中在 `.qoder/REQUIREMENTS.md` §12，**不得当作现行规则实现**。
- 配置参数 `POINTS_WALK_STEPS_PER_POINT=1000` / `POINTS_QUIZ_PER_CORRECT=2` / `POINTS_QUIZ_DAILY_CAP=10` 定义于 `backend/app/core/config.py`（见 `.qoder/backend/app/core/config.py.md`「积分规则 V2.0」节）。

## 4. 核心功能

### 4.1 模块常量（`backend/app/services/points_service.py:27-31`）
| 常量 | 值 | 说明 |
|---|---|---|
| `WALK` / `QUIZ` | `"walk"` / `"quiz"` | 两种计分来源（source_type） |
| `SOURCES` | `(WALK, QUIZ)` | **汇总/核对只统计这两种**；V2.0 之前的旧流水 `source_type='legacy'` 保留追溯但不计入总积分（docstring `:13`；过滤见 `:160`、`:168`、`:218`、`:300`） |
| `REASONS` | walk→「步行积分」、quiz→「答题积分」 | 台账行 reason 文案（`:30`、`:86`） |
| `RECOMPUTE_BATCH` | 500 | 全量核对的用户分批大小（`:31`、`:321-322`） |

### 4.2 计分纯函数
- `walk_chain(prior_total, steps_in_order)`（`:34-41`）：按日期顺序逐日产出 `(当日步行积分, 结余步数)`——累计结余口径：`当日积分 = floor(累计/1000) − floor(前日累计/1000)`，负数步数按 0 计（`:40`），不足 1000 步的零头结余到下一条记录。
- `walk_carry(db, user_id)`（`:44-51`）：当前结余步数 = 全部 `daily_sport.steps` 之和 mod 1000。
- `walk_points(steps)`（`:54-56`）：**无历史结余时**的单日步行积分；docstring 明示台账入账应使用 `recompute_walk` / `recompute_walk_all`（backend/app 业务代码中无调用，仅测试脚本 `backend/test/s20_v2_regression.py:244` 使用）。
- `quiz_points(correct_count)`（`:59-61`）：答对 × 2，`min` 封顶 10，负数按 0。
- `biz_key(source, date)`（`:64-65`）：台账幂等键 `walk:{日期}` / `quiz:{日期}`。

### 4.3 台账写入
- `set_daily(db, user_id, source, date, delta, ref_id)`（`:68-97`）：把某来源某日积分**设为** delta（覆盖语义，非累加）。`with_for_update()` 行锁内查既存行（`:73-78`）；无行且 `delta <= 0` 不建行返回 False（`:79-81`）；有行且 delta 与 ref_id 均未变化返回 False（`:94-95`）；否则覆盖并刷新 `updated_at`（`:96`）。**自身不 commit，由调用方统一提交**（docstring `:71`）。
- `recompute_walk(db, user_id)`（`:100-108`）：按运动源数据全量核对并修复**单个用户全部**步行台账（不止本次写入日期，历史旧口径错账一并修正、缺失行补建、无运动记录的残留行清零），委托 `_verify_batch(db, [user_id], True, (WALK,))`；**调用方需已串行化该用户写入并负责提交**（docstring `:101`；实际调用方 `backend/app/services/sport_service.py:180`、`:339` 先取用户行锁 `backend/app/services/sport_service.py:151`、`:335`，后统一 commit `:182`、`:340`）。
- `sync_quiz_day(db, user_id, date, correct_count, ref_id)`（`:121-125`）：按当日答对题数重算答题积分 = `set_daily(QUIZ, quiz_points(correct_count))`；调用方（quiz_service）负责提交。

### 4.4 查询
- `walk_on(db, user_id, date)`（`:111-118`）：某日已入账步行积分。
- `quiz_correct_counts(db, user_ids, dates=None)`（`:128-146`）：`{(user_id, 日期): 答对题数}`——以 `quiz_answers`（含未完成的当日答题）为准，无逐题数据的历史日期回退 `quiz_records.correct_count`（先填 records 再用 answers 覆盖，`:142-145`）。
- `points_subquery(db)`（`:149-163`）：每人 user_id/walk/quiz/total 汇总子查询（case+sum，只统计 SOURCES），供排行榜复用（`backend/app/services/rank_service.py:30`）。
- `_sum_by_source`（`:166-173`）/ `get_breakdown`（`:176-179`）/ `get_total`（`:182-183`）：{total, walk, quiz}，total 恒等于 walk + quiz。
- `get_summary(db, user_id)`（`:186-204`）：积分概览——累计三项 + 今日两项（今日按北京时间 `today_str()`，`:188`）+ 今日步数/答对数（计分依据展示）+ 当前结余 `walk_carry` + **`rules()` 规则下发**（`:203`）。
- `rules()`（`:207-212`）：三个积分参数以 `walk_steps_per_point` / `quiz_per_correct` / `quiz_daily_cap` 下发给小程序（`:209-211`），前端规则文案以此为准（响应模型 `PointsRules`，`backend/app/schemas/schemas.py:536-539`）。
- `get_daily_details(db, user_id, page, page_size)`（`:215-262`）：积分明细按自然日倒序分页——先取 distinct 日期分页（`:217-228`），再一次性取该页日期的台账行、步数、答对数组装（避免逐日查询）；page_size 上限 100 由路由强制（`backend/app/api/routes/points.py:25-26`）。

### 4.5 核对 / 重算
- `_expected_for(db, user_ids, sources)`（`:266-289`）：按源数据计算应得积分 `{(user_id, biz_key): (delta, ref_id)}`——walk 按 `daily_sport` 日期顺序逐日走 `walk_chain`，**ref_id = `daily_sport.id`**（`:279`）；quiz 按 `quiz_correct_counts`，**ref_id = `daily_questions.id`**（sessions 映射 `:281-286`、`:288`）。
- `_verify_batch(db, user_ids, fix, sources)`（`:292-313`）：期望值 vs 台账实际值逐键比对（含 ref_id，仅当键在两侧都存在时比较 ref，`:306`），差异记入 diffs；`fix=True` 时调 `set_daily` 修复（期望中不存在的残留行清 0，`:312`）。**不 commit**。
- `_recompute(db, fix, user_ids, sources)`（`:316-335`）：按 `RECOMPUTE_BATCH=500` 分批，`fix=True` 时**每批 commit 一次**（`:327-328`）；返回 `{users, checked_days, mismatches, fixed, samples}`（samples 最多 50 条）。
- `recompute_walk_all(db, fix=False)`（`:338-340`）：全部用户、仅 walk 来源；应用启动时以 `fix=True` 执行（`backend/app/main.py:48`）。
- `recompute_all(db, fix=False, user_ids=None)`（`:343-348`）：全量或指定用户、walk+quiz 两来源；管理端核对/修复入口（`backend/app/api/routes/admin.py:329-344`，`POST /api/admin/points/verify`，菜单权限 `rankings`，fix 时写审计 `points.recompute`）。

## 5. 输入与输出
- **入参**：服务层函数统一 `(db: Session, user_id/user_ids, ...)`；无 HTTP 层概念。
- **返回**：int（计分/查询）、bool（`set_daily`/`sync_quiz_day` 返回台账是否发生变化）、dict（`get_summary`/`get_daily_details`/`_recompute` 结果）；不抛业务异常（`ValueError` 由调用方产生）。
- **路由暴露**（响应模型均 camelCase）：
  - `GET /api/points` → `PointsSummaryOut`（`backend/app/api/routes/points.py:14-20`，rank 字段由 rank_service 补充；schema `backend/app/schemas/schemas.py:542-554`）；
  - `GET /api/points/daily` → `PointsDailyOut`（`backend/app/api/routes/points.py:23-30`；schema `backend/app/schemas/schemas.py:557-569`）；
  - `POST /api/admin/points/verify` → `AdminPointsVerifyOut`（`backend/app/api/routes/admin.py:329-344`）。
- **`ref_id` 语义（关键）**：`source_type='walk'` 时指向 `daily_sport.id`（`:279`）；`source_type='quiz'` 时指向 **`daily_questions.id`（当日答题场次），不是 `quiz_records.id`**——quiz_service 传入的是 `session.id`（`backend/app/services/quiz_service.py:260`、`:452`），而 `_session` 返回 `DailyQuestion`（`backend/app/services/quiz_service.py:149`）；核对期望值同样按 `daily_questions` 建映射（`:281-288`）。库内无 DB 级外键，开发库按 `daily_questions` join 实测 0 孤儿（按 `quiz_records` join 会得出虚假孤儿）。

## 6. 依赖关系
- **依赖模块**：`app.core.config.settings`（`:23`）、`app.core.helpers.today_str`（`:24`）、ORM 模型 `DailyQuestion/DailySport/PointsLog/QuizAnswer/QuizRecord/User`（`:25`）。**不依赖任何其他 service**（被依赖方向是单向的）。
- **数据库表**：写 `points_log`（`backend/app/models/models.py:329-350`，`(user_id, biz_key)` 唯一约束 `uq_points_user_biz` `:337`）；读 `daily_sport`、`quiz_answers`、`quiz_records`、`daily_questions`、`users`。
- **被依赖（backend/app 内）**：
  - `backend/app/services/quiz_service.py:31`（`quiz_points`/`sync_quiz_day`/`biz_key`）；
  - `backend/app/services/sport_service.py:25`（`recompute_walk`/`get_total`/`walk_on`/`walk_carry`）；
  - `backend/app/services/rank_service.py:14`（`points_subquery`）；
  - `backend/app/services/medal_service.py:25`（`get_total`，master 勋章判定 `backend/app/services/medal_service.py:48`）；
  - `backend/app/services/profile_service.py:22`（`get_breakdown`，`:166`）；
  - `backend/app/services/admin_service.py:34`（`SOURCES` 过滤 `:348`、`:537`；`get_breakdown` `:587`）；
  - `backend/app/api/routes/points.py:9`、`backend/app/api/routes/admin.py:93`；
  - `backend/app/main.py:38`（启动修复 `:48`）。
  - 测试脚本：`backend/test/s18_quiz_submit_feedback.py:52`、`backend/test/s20_v2_regression.py:64`、`backend/test/s22_history_sync_quiz_rotation.py:22`。
- **事务边界（谁 commit）**：`set_daily`/`sync_quiz_day`/`recompute_walk`/`_verify_batch` **均不 commit**，由业务调用方在同一事务内提交（quiz 判定 `backend/app/services/quiz_service.py:453`、`_finalize :261`；步数同步 `backend/app/services/sport_service.py:182`、补步 `:340`）；`_recompute` 在 `fix=True` 时每批自行 commit（`:327-328`，启动兜底与管理端 verify 走此路径）。

## 7. 业务规则
- **总公式**：总积分 = 步行积分 + 答题积分（docstring `:1`；`get_breakdown :176-179`）；legacy 流水不计入（`:13`、`:160`）。
- **步行积分（累计结余口径，无单日上限）**：每满 `POINTS_WALK_STEPS_PER_POINT=1000` 步得 1 分、不足不计（`walk_chain :36-41`）；恒等式「累计步行积分 ≡ 累计计分步数 // 1000」由 `recompute_walk` 全量修复保证（docstring `:101-105`）；跨日零头结余（`walk_carry :44-51`）。**历史上曾有单日 20000 步封顶（`POINTS_WALK_STEP_CAP`，`2f3f333` 引入、`9cb65b8` 删除），已废弃**。
- **答题积分**：每答对 1 题 +2、不扣分、单日封顶 10（`quiz_points :59-61`），每日 5 题全对恰好触顶（与 `DAILY_COUNT=5` 联动，`backend/app/services/quiz_service.py:35`）。
- **台账粒度与幂等**：每人每来源每自然日一行，`biz_key` 唯一（`:8`、`:64-65`；DB 约束 `backend/app/models/models.py:337`）；写入是**按源数据重算后的覆盖**而非增量累加，重复同步/重放请求/并发只会得到同一结果、不会重复计分（docstring `:9-10`；`set_daily :94-96`）。
- **并发约束**：`set_daily` 行锁（`:76`）；单用户步行重算依赖调用方先锁用户行串行化（`recompute_walk` docstring `:101`；`backend/app/services/sport_service.py:151`、`:335`）；`(user_id, biz_key)` 唯一约束兜底并发建行。
- **时区口径**：「今日」按北京时间（`today_str()`，`:188`；`backend/app/core/helpers.py:22-24`）；台账 `updated_at` 与源数据时间列按 UTC naive（`:96` `datetime.utcnow()`）。台账 `date` 列即北京时间自然日。
- **修复语义**：核对以源数据为唯一真相——期望有而台账无 → 补建；台账有而源数据无 → 清零（`:303-312`）；delta 或 ref_id 不一致均视为差异（`:306`）。
- **规则下发**：三个积分参数经 `rules()` 随 `GET /api/points` 下发给小程序（`:207-212`），前端不得另行硬编码（`backend/AGENTS.md` §4 不变量 4）。

## 8. 修改约束
- **禁止绕过本模块直接写 `PointsLog` 计分行**（`backend/AGENTS.md` §4 不变量 5 与 §6.4）；新增积分来源须扩展 `SOURCES`/`REASONS` 并同步 `_expected_for` 的源数据口径，否则会被全量核对当成残留行清零（`:312`）。
- **`set_daily` 不得自行 commit**：它被嵌在 quiz 判定、`_finalize`、步数同步等业务事务内，提前提交会破坏「判定与积分同事务」的原子性（`backend/app/services/quiz_service.py:451-453`）。
- **答题积分 `ref_id` 指向 `daily_questions.id`**（见 §5）：做数据核对、孤儿清理或迁移时不得按 `quiz_records` join，历史上曾因此误报 13 条孤儿（实际按 `daily_questions` 为 0 条）。
- **覆盖语义不可改成增量语义**：`delta` 是「该日该来源应得总分」，改累加会破坏幂等（重复同步重复计分）。
- **步行口径改动属于业务规则变更**：须同步小程序积分页文案、`rules()` 下发字段、s20/s22/s23 测试断言与 `docs/迭代记录.md`（先例：`9cb65b8` 取消封顶时全链路同步）。
- 启动兜底 `recompute_walk_all(fix=True)`（`backend/app/main.py:48`）会在每次部署后自动把存量台账修复到当前口径——修改计分公式前须意识到该副作用（`9cb65b8` 迭代记录明确「部署后启动全量修复会自动把存量用户步行台账按新口径上调」）。
- `docker/init/017_points_ledger.sql` 的回填 UPDATE 属一次性重算脚本，不可重复执行（`.qoder/REQUIREMENTS.md` §15）。
- 响应字段为 camelCase 契约（`backend/app/schemas/schemas.py:536-569`），改名即破坏小程序积分页与排行榜。

## 9. 当前实现状态
- **已实现**：V2.0 台账模型全链路——计分函数、幂等覆盖写入、概览/明细/规则下发、排名子查询、单用户与全量核对修复、启动兜底、管理端 verify 接口。
- **事实性陈述（非缺陷判定）**：
  - `walk_points` 在 backend/app 业务代码中无调用（仅测试脚本使用），保留作纯函数口径参照，docstring 已声明入账应走 `recompute_walk`（`:54-56`）。
  - `get_summary` 每次请求实时执行 6 组查询（breakdown 聚合、今日聚合、今日步数、答对数——其中 `quiz_correct_counts` 内含 answers/records 两条查询、结余聚合，`:186-204`），无缓存；用户量增长后的性能余量——待确认（无实测数据）。
  - `_expected_for` 的 walk 核对逐行遍历该批用户全部 `daily_sport` 记录（`:273-279`），全量核对成本随历史天数线性增长；启动兜底每进程执行一次（`backend/app/main.py:48`）。
  - V1 的 `grant`/同日同 reason 去重接口已在 `2f3f333` 重写中移除，现行文件无 `grant` 函数；`backend/AGENTS.md` §4 不变量 5 中「同日同 reason 去重」的表述对应现行实现应理解为「同日同来源（biz_key）唯一」。
- **已知遗留**：旧 e2e 脚本（`backend/test/e2e_full_flow.py`、`e2e_datasync`、`s3_aggregates`）仍按 V1 流水口径断言，**不是现行规则**（`.qoder/REQUIREMENTS.md` §15）。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/points_service.py`（8 个提交）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-15
- 需求：① 步行积分取消单日 20000 封顶（`9cb65b8`）；② 「我的」页累计运动(步)口径统一（`85c5a55`，当日即被 ① 部分回退）；③ 步数同步后全量重算步行台账（`83d3552`）；④ 步行积分统一为累计口径（`4afccdd`）；⑤ 近 7 日补录结余积分（`6f2cfc3`）。
- 修改内容：`9cb65b8` 删除 `capped_steps`/`scored_total_steps` 与 `POINTS_WALK_STEP_CAP` 依赖，`rules` 不再下发 `walkStepCap/walkDailyCap`；`85c5a55` 曾将计分口径求和提为公共 `scored_total_steps`（随 `9cb65b8` 删除）；`83d3552` 删除增量 `sync_walk_from`、新增 `recompute_walk`（单用户全量修复，与启动修复共用 `_verify_batch`）；`4afccdd` 新增 `recompute_walk_all`/`recompute_all`、`_expected_for`/`_verify_batch` 支持按来源过滤、接入 `backend/app/main.py` 启动修复；`6f2cfc3` 步行积分改累计结余口径（`walk_chain` 零头结余到下一条记录）。
- 关联文件：`backend/app/services/sport_service.py`、`backend/app/main.py`、`backend/app/core/config.py`、前端积分明细页、s20/s22/s23 测试断言。
- 测试结果：`9cb65b8`：S20 26/26（含新边界 25000→25）、S23 13/13、S22 14/14；`85c5a55`：SQLite TestClient 冒烟通过（+25000 步后 totalSteps=25000/scoredTotalSteps=20000/walk=20）；`83d3552`：S23 13/13、S24-PG 真实 openGauss 6/6、S20 26/26、S22 14/14、S21 4/4，全库匿名核对 87 用户 0 不一致（报告 `backend/test/docs/walk-sync-full-recalc-fix-report.md`）；`4afccdd`：S20 26/26（P01 边界 2611→2 等）、S22 14/14、S18 21/21（报告 `backend/test/docs/walk-points-cumulative-fix-report.md`）；`6f2cfc3`：S22 13/13、S18 21/21、S20 25/25，5800 步入账 5 分结余 800 验收用例通过（均见 `docs/迭代记录.md`）。

### 2026-10-13
- 需求：① V2.0 需求六逐题限时作答的积分配套（`78a12ca`）；② V2.0 需求三/四积分台账重构（`2f3f333`）。
- 修改内容：`78a12ca` 新增 `quiz_correct_counts`（以 `quiz_answers` 为源、历史日回退 `quiz_records`），答题积分纳入核对重算；`2f3f333` 整体重写为台账模型——017 迁移加 `source_type/ref_id/biz_key` 列与 `(user_id, biz_key)` 唯一键，`set_daily` 行锁覆盖、业务同事务重算，新增概览/按日明细/`recompute_all`，旧流水标 legacy 不计入，移除 V1 的登录/达标/点亮/里程碑/答题 grant 规则。
- 关联文件：`docker/init/017_points_ledger.sql`、`018_quiz_answers.sql`、`backend/app/services/quiz_service.py`、`sport_service.py`、`rank_service.py`、`backend/app/api/routes/points.py`、`backend/app/api/routes/admin.py`。
- 测试结果：`78a12ca`：s18 21/21、s6/s11/s12/s19 全过、openGauss 并发冒烟通过（并发提交积分只记 1 次、核对重算无差异）；`2f3f333`：SQLite 冒烟 20/20（边界/幂等/篡改修复/legacy 不计入）、openGauss 017 回填 92 条步行 + 12 条答题、核对 132 人 111 天差异 0、10 线程并发补步台账一致（`docs/迭代记录.md`）。

### 2026-09-30
- 需求：项目初始化（`a94e685`）。
- 修改内容：创建本文件（V1 口径：`grant` 同日同 reason 去重；规则为每日登录 +1、运动达 5000/10000 步 +5/+10、每日答题 +5 满分 +10、点亮 +10、完成长征 +100——**全部已随 `2f3f333` 废弃**，见 `.qoder/REQUIREMENTS.md` §12）。
- 关联文件：仓库初始代码（backend + frontend）。
- 测试结果：待确认（`docs/迭代记录.md` 该条目未记录验证字段）。
