# 018_quiz_answers.sql

## 1. 文件路径

`docker/init/018_quiz_answers.sql`（27 行）

## 2. 文件职责

「逐题限时作答」建表迁移：新建 `quiz_answers` 表（`:8-23`），**一行 = 一次答题会话（`daily_questions.id`）中的一道题**，记录服务器时间的开始/截止/提交三个时刻、作答内容、判定结果、状态与该题得分（`:4-5` 头注释），并建复合索引 `ix_quiz_answers_user_date`（`:25`）。这是答题从「一次性提交整套题」改为「逐题开题、每题 90 秒服务器计时」后的**唯一权威逐题数据源**。

## 3. 业务需求

`78a12ca`（2026-10-13）「答题改为逐题限时作答——每题 90 秒服务器计时，start/answer 逐题开题判定，超时不得分不可再提交，逐题记录落库 quiz_answers（018），答题积分按逐题答对数实时同步并纳入核对重算」交付（`docs/迭代记录.md` 的 `78a12ca` 条目）。`:3` 头注释标注对应「V2.0 需求六」。业务场景：客户端计时可被绕过（改本地时间、断网重连），必须把每题的计时窗口放在服务器；同时超时后不得分且**不可再提交**，需要一行持久状态来承载「answering / answered / timeout」状态机。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:27`）。

### 4.1 `quiz_answers` 表（`:8-23`）

`CREATE TABLE IF NOT EXISTS`（§1.3 允许）。逐列：

| 列 | DDL（行号） | 业务含义 |
|---|---|---|
| `id` | `SERIAL PRIMARY KEY`（`:9`） | 自增主键 |
| `session_id` | `INTEGER NOT NULL REFERENCES daily_questions(id)`（`:10`） | 所属答题会话（当日题目缓存），**真 FK** |
| `user_id` | `INTEGER NOT NULL REFERENCES users(id)`（`:11`） | 作答用户，**真 FK**（冗余存储，避免按用户统计时 JOIN 会话表） |
| `date` | `VARCHAR(10) NOT NULL`（`:12`） | 北京时间自然日 `YYYY-MM-DD`，与 `daily_questions.date` 同源冗余 |
| `seq` | `INTEGER NOT NULL`（`:13`） | 会话内题序（当日第几题） |
| `question_id` | `INTEGER NOT NULL`（`:14`） | 题目 id，**无 FK 约束**（逻辑外键，指向 `questions.id`） |
| `started_at` | `TIMESTAMP NOT NULL`（`:15`） | 服务器开题时刻（UTC，`:5`） |
| `deadline_at` | `TIMESTAMP NOT NULL`（`:16`） | 服务器截止时刻 = `started_at + QUIZ_QUESTION_SECONDS`（`backend/app/services/quiz_service.py:375`，配置 `backend/app/core/config.py:97` 默认 90 秒） |
| `submitted_at` | `TIMESTAMP`（`:17`，可空） | 实际提交时刻；`status='answering'` 时为 NULL |
| `user_answer` | `JSON`（`:18`，可空） | 用户作答（数组，ORM 注解 `Optional[list]`） |
| `is_correct` | `BOOLEAN NOT NULL DEFAULT FALSE`（`:19`） | 判定结果，答题积分的计算依据 |
| `status` | `VARCHAR(16) NOT NULL DEFAULT 'answering'`（`:20`） | 状态机：`answering` 作答中 / `answered` 已作答 / `timeout` 已超时（`:6`） |
| `points` | `INTEGER NOT NULL DEFAULT 0`（`:21`） | 该题得分 |

三个时刻列**均无 DB 默认值**，全部由服务层显式写入（服务器时间是本迁移的核心目的，不能交给 DB 时钟）。

### 4.2 约束与索引

- `CONSTRAINT uq_quiz_answer_session_seq UNIQUE (session_id, seq)`（`:22`）：**同一会话同一题序只能开题一次**，并发开题由唯一约束兜底（`:7` 头注释）——这是防重复计时窗口的物理保证。
- `ix_quiz_answers_user_date`（`:25`，`(user_id, date)`）：支撑「按用户 + 日期」统计答对题数（`backend/app/services/points_service.py:133-144`）与题目使用次数（`quiz_service.py:104-108`）。
- **未对 `question_id` 建索引**，而 `quiz_service.py:104-108` 按 `question_id` 分组统计、`ai_chat_service.py:351-355` 按 `question_id` 过滤——两处均同时带 `user_id` 条件，可走 `ix_quiz_answers_user_date` 的前缀，故未建单列索引（是否需要补：**待确认**，本次建档禁止连库看执行计划）。

## 5. 输入与输出

- **输入（前置条件）**：`daily_questions`（`session_id` 的 FK 目标）与 `users` 必须已存在——分别由 `001_schema.sql` / 先序迁移建立；执行顺序由 `init-db.sh` 字典序保证。
- **输出**：1 张表（13 列）+ 1 个命名唯一约束 + 1 个复合索引。**不种任何数据、不修改任何既有表、不重算历史数据**（全文件 `INSERT` / `UPDATE` / `ALTER` 命中 0 次）。
- **对既有数据的影响**：零。`018` 之前已完成的答题场次没有 `quiz_answers` 行，由消费方回退处理——`quiz_records.details`（`014` 新增）用于展示回退，`points_service.quiz_correct_counts` 回退到 `quiz_records.correct_count`（`points_service.py:131-142`），`quiz_service._question_usage` 回退到 `daily_questions.question_ids`（`quiz_service.py:102`、`:112-128`）。
- **失败模式**：`CREATE INDEX IF NOT EXISTS`（`:25`）在不支持该语法的生产 openGauss 版本上语法报错、事务回滚（§9）。

## 6. 依赖关系

- **依赖先序迁移**：`001_schema.sql`（`users`）；建 `daily_questions` 的迁移（`session_id` FK 目标）。
- **与 `014_quiz_result_details.sql` 的职责划分（两者确有重叠，各存一份）**：
  - `014:8` 给 `quiz_records` 加 `details JSON` 列，存**提交时冻结的展示快照**：`[{index, question_id, type, question, options, user_answer, correct_answer, correct, score, analysis}]`（`014:5`）——含题干、选项、正确答案与解析全文，目的是答题结果页一次读取即可渲染，历史记录不回填（`014:6`）。
  - `018` 存**规范化的逐题状态机行**：服务器计时三时刻、`status`、`is_correct`、`points`，目的是防作弊计时与积分权威来源。
  - 重叠部分是「每题的 `user_answer` 与对错」；差异是 `014` 冗余含题面文本、只在提交后写一次、无计时与状态，`018` 每题一行、开题即写、承载状态流转。**积分与轮换只认 `018`**（`points_service.py:131`、`quiz_service.py:102` 注释「逐题记录为准，018 之前已完成场次回退 daily_questions」），`014` 的 `details` 仅供展示。
- **对应 ORM**：`backend/app/models/models.py:302-326`（`QuizAnswer`）——`__table_args__` 声明 `UniqueConstraint("session_id","seq", name="uq_quiz_answer_session_seq")`（`:310`）与 `Index("ix_quiz_answers_user_date","user_id","date")`（`:311`）；docstring `:303-305` 与本文件 `:4-6` 头注释同口径。
- **读写方**：
  - `backend/app/services/quiz_service.py`——唯一写入方：开题（`:375` 写 `deadline_at`）、提交判定、超时处理；`:104-108`、`:112-128` 读取做题目轮换；`:532-535` `reset_today` 按 `user_id + date` 批量删除。
  - `backend/app/services/points_service.py:133-144`——`quiz_correct_counts` 以本表 `is_correct=True` 计数为**答题积分权威来源**。
  - `backend/app/services/ai_chat_service.py:351-355`——答题讲解前校验用户确已作答该题（`status IN ('answered','timeout')`）。
  - 路由层 `backend/app/api/routes/quiz.py`（`POST /api/quiz/start`、`POST /api/quiz/answer` 等，schema `QuizAnswerOut` / `QuizAnswerRequest` 见 `backend/app/schemas/schemas.py:499`、`:528`）。

## 7. 业务规则

1. **计时只认服务器时间**：`started_at` / `deadline_at` / `submitted_at` 均由后端写入且为 UTC（`:5`），客户端倒计时仅作展示；`quiz_service.py:4` docstring 明写「计时只认服务器时间」，`:294` 返回的 `remaining_ms` 也由 `deadline_at - now` 现算。
2. **每题时限 90 秒**：`config.py:97` `QUIZ_QUESTION_SECONDS: int = 90`，另有 `QUIZ_ANSWER_GRACE_SECONDS` 宽限（`quiz_service.py:64`）。**时限不在 DDL 中**，改配置无需迁移。
3. **状态机单向**：`answering` → `answered`（提交判定）或 `answering` → `timeout`（超时）。**超时不得分且之后不可再提交**（`:6`），`points` 保持默认 0。DDL 无 CHECK 约束，状态流转完全由 `quiz_service` 应用层保证（`.qoder/ARCHITECTURE.md` §13.2「无任何 CHECK 约束」）。
4. **并发开题兜底**：同一会话同一题序并发开题时，`uq_quiz_answer_session_seq`（`:22`）让后到的一方抛 `IntegrityError`，不会开出两个计时窗口。
5. **每日一次会话**：`session_id` 指向 `daily_questions`，后者受 `uq_dailyq_user_date`（`models.py:294`）约束为每人每日一行，故「每人每日最多一套题」由上游保证，本表不再重复约束。
6. **积分联动**：每次逐题判定后按当日 `is_correct=True` 计数经 `points_service.sync_quiz_day`（`points_service.py:121-125`）重算 `quiz:日期` 台账行，纳入 `recompute_all` 全量核对（`points_service.py:14-15`）。
7. **删除口径**：仅 `quiz_service.reset_today`（`:529-540`，调试用）会删本表行，同时删 `quiz_records`、`daily_questions` 与 `quiz:日期` 的 `points_log` 行——**四者必须同批删**，否则积分核对会出现「有台账无源数据」的差异。

## 8. 修改约束

1. **禁止修改本文件**：已入库（`git ls-files` 含 `docker/init/018_quiz_answers.sql`）且属已发布编号脚本（`SQL_CONSTRAINTS.md` §3.1），需变更一律新增编号。生产库 `schema_migrations` 是否已登记 `018_quiz_answers.sql`：**待确认（本次建档禁止连库）**。
2. **可安全重跑**：全文件只有 `CREATE TABLE IF NOT EXISTS` 与 `CREATE INDEX IF NOT EXISTS`，无 INSERT/UPDATE/DELETE，重跑不破坏数据（前提是 openGauss 版本支持这两个 `IF NOT EXISTS`，见 §9）。这与 `017`/`019` 的「不可重复执行」形成对比。
3. `uq_quiz_answer_session_seq` 是并发正确性的物理基础，**不得降级为普通索引**。
4. `(user_id, date)` 冗余列是与 `daily_questions` / `quiz_records` 对齐的查询键，被 `points_service` 与 `quiz_service` 直接过滤；若改为只留 `session_id` 需同步改这两处并加 JOIN。
5. `status` 取值域 `answering` / `answered` / `timeout` 是 `quiz_service` 与 `ai_chat_service.py:355` 的硬契约，新增值须同步这两处（`ai_chat_service` 的 `IN ('answered','timeout')` 白名单尤其容易漏）。
6. 本表是**答题积分与题目轮换的权威源**（`014` 的 `details` 只是展示快照）；任何绕过 `quiz_service` 直接写本表的行为都会同时污染积分与轮换。

## 9. 当前实现状态

- **已实现**：表在用，逐题限时作答已上线（`78a12ca`）；`quiz_answers` 已成为答题积分与题目使用次数的权威数据源。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` 逐项）**：
  - **§1.1 合规（0 处）**：全文件无 `ALTER TABLE`，未命中禁用语法（已 `grep -c "ADD COLUMN IF NOT EXISTS"` 复核，命中 0）。
  - **§1.2 风险（1 处）**：`:25` 使用 `CREATE INDEX IF NOT EXISTS`，按「生产版本默认不支持」处理应改 `DO` 块 + `pg_indexes` 判定（合规写法见 `021_ai_center.sql:93-122`）。
  - **§1.3 合规**：`:8` `CREATE TABLE IF NOT EXISTS`。
  - **§1.4 不涉及**（无派生表）；**§1.5 合规**（无 `ON CONFLICT`、无 `ALTER COLUMN TYPE`、无触发器、无 JSON 路径操作符）。
  - **§2.1 合规**（`:1`/`:27`）；**§2.2 合规**（DDL 幂等、无数据写入）；**§2.3 合规**（无删数据）；**§2.4 不涉及**（无 UPDATE）。
  - **§4 部分合规**：`:3-7` 有主题、表语义、状态取值域与唯一约束说明，但**未按「变更目的 / 影响面 / 回滚」三段式分列**，且**缺回滚段**。
- **ORM 与 DDL 一致性**：逐列核对 `models.py:302-326`，**13 列的类型、可空性、默认值、约束名、索引名全部一致**（含 `is_correct DEFAULT FALSE`↔`default=False`、`status DEFAULT 'answering'`↔`default="answering"`、`points DEFAULT 0`↔`default=0`、`user_answer` 可空 JSON↔`Mapped[Optional[list]]`）。仅两处**实现机制**差异，无运行时影响（禁用 `create_all`，实际库以 DDL 为准）：
  1. `question_id` 两侧都是**无 FK 的逻辑外键**（DDL `:14` 无 `REFERENCES`，ORM `:319` 无 `ForeignKey`）——一致，属 `.qoder/ARCHITECTURE.md` §13.2 统计的 13 处逻辑外键之一。
  2. ORM 的三个时刻列（`:320-322`）与 DDL 一样**无默认值**，一致；但 `created_at` 类列本表没有，故不涉及 §13.2 的「两套时间默认值」问题。
- **DDL 未表达、由应用层承载的部分**：状态机流转规则、90 秒时限、超时不可再提交、`seq` 的取值范围（1..5，`quiz_service.DAILY_COUNT`）——DDL 无 CHECK 约束，全部只在 `quiz_service` 中。
- **回滚方式**：文件内无回滚语句，头注释也未提供（§4 违规）。手工回滚 = `DROP TABLE quiz_answers;`——会销毁全部逐题作答记录，导致答题积分退化为只能从 `quiz_records.correct_count` 回退计算（`points_service.py:142`）、题目轮换退化为只能从 `daily_questions` 回退统计（`quiz_service.py:112-128`），且 ORM `QuizAnswer` 会立即报 `UndefinedTable`。**生产不可回滚**。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/018_quiz_answers.sql`，共 **1 个提交**。

### 2026-10-13（`78a12ca`，11:54）
- 需求：V2.0 需求六——答题改为逐题限时作答，每题 90 秒服务器计时，超时不得分且不可再提交（`:3` 头注释）。
- 修改内容（涉本文件）：创建本文件。新建 `quiz_answers` 表（13 列：会话/用户/日期/题序/题目 id/三个服务器时刻/作答 JSON/判定/状态/得分）+ `uq_quiz_answer_session_seq` 唯一约束 + `ix_quiz_answers_user_date` 索引。不含任何数据写入。
- 关联文件：`backend/app/models/models.py`（`QuizAnswer`）、`backend/app/services/quiz_service.py`（逐题开题/判定/超时与题目使用次数）、`backend/app/services/points_service.py`（答题积分改以逐题答对数为准并纳入核对重算）、`backend/app/api/routes/quiz.py`、`backend/app/schemas/schemas.py`（`QuizAnswerOut`/`QuizAnswerRequest`）、小程序答题页。
- 测试结果：见 `docs/迭代记录.md` 的 `78a12ca` 条目。
