# 020_question_rotation.sql

## 1. 文件路径

`docker/init/020_question_rotation.sql`（9 行）

## 2. 文件职责

给题库 `questions` 加软停用开关：新增 `active BOOLEAN NOT NULL DEFAULT TRUE`（`:6`）与索引 `ix_questions_active`（`:7`）。**文件名叫「题目轮换」，但 DDL 交付的只有软停用标志位**——用户独立轮换本身是纯应用层逻辑（按 `quiz_answers` 统计每人每题使用次数），不需要新列。加 `active` 的直接目的是让「管理端删题」改为软停用，从而使停用题不参与**之后**的新抽题、但**当天已生成的题目仍可继续作答**，避免管理端操作使既有 `daily_questions` / `quiz_answers` 失效（`:4-5` 头注释）。

## 3. 业务需求

`6f2cfc3`（2026-10-15）「全端: 支持近7日步数补录结余积分与用户独立题目轮换」交付（`docs/迭代记录.md` 的 `6f2cfc3` 条目），与 `019_sport_backfill_carry.sql` **同一个提交**。业务场景两个：

1. **用户独立题目轮换**：题库只有 15 题（`backend/app/data/seed.py` 种入），若全体用户共用一个轮换游标，先答的用户会决定后答用户看到什么；改为**每人独立**按「该用户各题已使用次数」分层随机抽题（`backend/app/services/quiz_service.py:131-140` 的 `_pick_questions`：先取使用次数最少的一层，不足 5 题时依次跨入下一轮补足）。这条需求**不产生任何 DDL**。
2. **删题不破坏进行中会话**：管理端把题目从题库移除时，若物理删除，当天已抽到该题的用户 `daily_questions.question_ids` 与 `quiz_answers.question_id` 会指向不存在的行；软停用只让题目退出后续抽题池。这条需求产生 `active` 列。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:9`）。

### 4.1 `questions.active` 列（`:6`）

`ALTER TABLE questions ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;`

- `NOT NULL DEFAULT TRUE` 使**存量 15 题自动全部为可用**，无需额外 UPDATE，也不影响已生成的会话。
- 语义：`TRUE` 参与抽题；`FALSE` 已软停用（管理端「删除」的实际动作）。
- 使用 `ADD COLUMN IF NOT EXISTS`（§9 记为兼容性违规）。

### 4.2 `ix_questions_active` 索引（`:7`）

`CREATE INDEX IF NOT EXISTS ix_questions_active ON questions (active);`

- 索引名 `ix_questions_active` 与 ORM 的 SQLAlchemy 默认命名（`ix_<表名>_<列名>`，来自 `models.py:142` 的 `index=True`）**完全一致**。
- 支撑的查询：`quiz_service.py:133`（抽题池）、`admin_service.py:155`（管理端题库列表）、`ai_question_service.py:184`（AI 出题去重时取现有题干）——三处都是 `filter(Question.active.is_(True))`。
- **选择性极低**：`active` 是布尔列且绝大多数行为 `TRUE`，单列 B-tree 索引的实际收益有限；`questions` 表仅 15 行量级（种子）+ AI 导入增量，全表扫描成本也很低。是否需要保留该索引：**待确认**（本次建档禁止连库看执行计划与行数）。

## 5. 输入与输出

- **输入（前置条件）**：`questions` 表已存在（由 `001_schema.sql` 建立，种子 15 题由 `backend/app/data/seed.py` 在应用启动时幂等写入，`.qoder/ARCHITECTURE.md` §13.3）。
- **输出**：`questions` 新增 1 列 + 1 索引。**不种任何数据、不重算历史数据、不建表、不删数据**（全文件 `INSERT` / `UPDATE` / `DELETE` / `CREATE TABLE` 命中 0 次）。
- **对既有数据的影响**：存量题目行 `active` 被默认值批量置为 `TRUE`，行为不变（全部题目继续可抽）。
- **失败模式**：`ADD COLUMN IF NOT EXISTS`（`:6`）与 `CREATE INDEX IF NOT EXISTS`（`:7`）在不支持该语法的生产 openGauss 版本上语法报错、事务回滚。**本文件已实际造成过一次生产故障**：`SQL_CONSTRAINTS.md` §7 表格记录 `f413ac6`「后端启动 seed 阶段报 openGauss 派生表列名歧义」，其**真正根因是 020 迁移未跑**（表格原文），当时的错误修复 `51239b5` 回退了表象修补。

## 6. 依赖关系

- **依赖先序迁移**：`001_schema.sql`（`questions` 表）。与 `017`/`018`/`019` **无依赖关系**（虽与 `019` 同提交，但两者操作不同的表）。
- **对应 ORM**：`backend/app/models/models.py:142` —— `active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)`。`index=True` 生成的默认索引名即 `ix_questions_active`，与 DDL `:7` 同名。`Question` 类 docstring `:127-130` 未提及 `active`（说明该列的语义只写在迁移注释里）。
- **读写方**：
  - `backend/app/services/quiz_service.py:133`——`_pick_questions` 只在 `active=True` 的题目里抽（**读**，抽题池过滤）。
  - `backend/app/services/admin_service.py:155`——管理端题库列表只列可用题（**读**）；`:202-204`——管理端「删除题目」的实际实现：`if question is None or not question.active` 判重复停用，随后 `question.active = False`（**写**，软停用）。
  - `backend/app/services/ai_question_service.py:184`——AI 出题时取现有题干做去重参照，只取可用题（**读**）。
  - 用户独立轮换的统计源不是本列，而是 `quiz_answers`（`quiz_service.py:104-108`）与 018 之前场次的回退源 `daily_questions.question_ids`（`quiz_service.py:112-128`）。
- **与 `005_upgrade.sql` 的 `ix_user_event_user_type` 无关（已复核）**：该索引**不是 005 建的**——`005_upgrade.sql:78-79` 建的是 `ix_user_event_user_id` 与 `ix_user_event_time`；`ix_user_event_user_type` 由 `docker/init/012_perf_indexes.sql:10` 建立，对应 ORM `models.py:377` 的 `Index("ix_user_event_user_type","user_id","event_type")`。本文件只操作 `questions` 表，与 `user_event` 表、与该索引**没有任何关系**，也不共享任何列或命名。

## 7. 业务规则

1. **软停用而非物理删除**：管理端删题 = `question.active = False`（`admin_service.py:204`）。停用题**退出后续抽题池**（`quiz_service.py:133`），但**当天已生成的 `daily_questions` 与已开题的 `quiz_answers` 继续有效**，用户仍可作答（`:4-5` 头注释）。这是 `question_id` 在 `018` 中刻意**不设 FK 约束**（`018:14`）的配套设计——物理删除会因 FK 而失败或产生悬挂引用，软停用两者都不会。
2. **重复停用是幂等的**：`admin_service.py:202` 先判 `not question.active` 再决定动作，重复点击删除不会产生副作用。
3. **默认值即「全部可用」**：`DEFAULT TRUE`（`:6`）保证迁移当天所有存量题（含 `seed.py` 的 15 题）立即可抽，不需要配套的数据回填语句。
4. **用户独立轮换**：每人一套使用次数计数，抽题时「先取使用次数最少的一层，不足时依次跨入下一轮补足」（`quiz_service.py:131-140`）；每日最多 5 题且同日固定（`quiz_service.py:4`、`DAILY_COUNT`）。**这套规则完全在应用层，DDL 不参与**。
5. **停用题不影响积分与核对**：`points_service.quiz_correct_counts`（`:128-146`）按 `quiz_answers.is_correct` 计数，不看 `questions.active`；已作答的停用题照常计分。
6. **AI 导入的新题默认可用**：`ai_question_service` 导入正式题库时若不显式设置 `active`，由 ORM 客户端默认 `True`（`models.py:142`）或 DDL 服务端默认 `TRUE`（`:6`）兜底，两者一致。

## 8. 修改约束

1. **禁止修改本文件**：已入库（`git ls-files` 含 `docker/init/020_question_rotation.sql`）且属已发布编号脚本（`SQL_CONSTRAINTS.md` §3.1），需变更一律新增编号。生产库 `schema_migrations` 是否已登记 `020_question_rotation.sql`：**待确认（本次建档禁止连库）**；但 `SQL_CONSTRAINTS.md` §7 记录 `f413ac6` 的根因是「020 迁移未跑」，说明当时生产确实缺失，其后是否已补跑未记录。
2. **可安全重跑**：全文件只有一条 `ADD COLUMN IF NOT EXISTS` 与一条 `CREATE INDEX IF NOT EXISTS`，**无 INSERT / UPDATE / DELETE**，不含重算类语句——与 `017`、`019` 的「不可重复执行」不同，本文件重跑不会破坏任何数据（前提是 openGauss 版本支持这两个 `IF NOT EXISTS`，见 §9）。
3. **不得把 `active` 改成可空或改默认值**：`NOT NULL DEFAULT TRUE` 是「存量题默认可用」这条规则的唯一承载；改成可空会让 `filter(Question.active.is_(True))` 漏掉 NULL 行，等价于静默停用一批题目。
4. **不得把软停用改回物理删除**：会立即破坏 `daily_questions.question_ids`（JSON 数组内的 id，无 FK 保护）与 `quiz_answers.question_id`（无 FK），使进行中的答题会话取不到题干。
5. `ix_questions_active` 索引名与 ORM `index=True` 的默认命名一致（`models.py:142`）；若手工改名，ORM 侧与实际库会出现两个同列索引（因禁用 `create_all`，不会自动纠正，但会让后续迁移的 `pg_indexes` 判定失效）。

## 9. 当前实现状态

- **已实现**：`active` 列与索引在用；管理端删题已是软停用（`admin_service.py:202-204`）；用户独立轮换已上线（`quiz_service.py:102-140`）。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` 逐项）**：
  - **§1.1 违规（1 处）**：`:6` 使用禁用的 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，应改为 §1.1 方式 A（`DO $$ … IF NOT EXISTS (SELECT 1 FROM information_schema.columns …)`）。本文件早于约束文档定稿。
  - **§1.2 风险（1 处）**：`:7` 使用 `CREATE INDEX IF NOT EXISTS`，按「生产版本默认不支持」处理应改 `DO` 块 + `pg_indexes` 判定（合规写法见 `021_ai_center.sql:93-122`）。`:7` 的写法**恰好就是 `SQL_CONSTRAINTS.md` §1.2 示例代码块里的原文**（该示例正是以 `questions` / `ix_questions_active` 举例），说明约束文档在定稿时参照了本文件作为反例。
  - **§1.3 不涉及**（无 CREATE TABLE）；**§1.4 不涉及**（无派生表）；**§1.5 合规**（无 `ON CONFLICT`、无 `ALTER COLUMN TYPE`、无触发器、无 JSON 操作符）。
  - **§2.1 合规**（`:1`/`:9`）；**§2.2 合规**（DDL 幂等、无数据写入）；**§2.3 合规**（无删数据）；**§2.4 不涉及**（无 UPDATE）。
  - **§4 部分合规**：`:3-5` 有主题与变更目的（含「为什么是软停用」的理由），但**未按「变更目的 / 影响面 / 回滚」三段式分列**，且**缺回滚段与影响面段**（未说明涉及哪张表、是否影响接口契约）。
- **ORM 与 DDL 一致性**：`models.py:142` 与 `:6-7` **类型、非空性、索引名全部一致**。唯一差异是默认值机制——DDL 是服务端 `DEFAULT TRUE`，ORM 是客户端 `default=True` 且**无 `server_default`**；因禁用 `create_all`（`backend/AGENTS.md` §4.8），实际库以 DDL 为准，无运行时影响。**未发现任何列名/类型/可空性/索引名分歧。**
- **命名与内容不符（文档层面，非缺陷）**：文件名 `question_rotation` 指向「用户独立题目轮换」，但轮换逻辑不需要 DDL；本文件实际交付的是**题目软停用**。轮换与软停用是同一提交 `6f2cfc3` 里两个相关但独立的需求，只有后者落到了 SQL。阅读时勿按文件名推断功能。
- **回滚方式**：文件内无回滚语句，头注释也未提供（§4 违规）。手工回滚 = `DROP INDEX ix_questions_active; ALTER TABLE questions DROP COLUMN active;`——会让 `quiz_service.py:133`、`admin_service.py:155`/`:202-204`、`ai_question_service.py:184` 四处立即报 `UndefinedColumn`（抽题、题库列表、删题、AI 出题全线 500），且**软停用状态会永久丢失**（列删掉后无法区分哪些题曾被停用）。**生产不可回滚**。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/020_question_rotation.sql`，共 **1 个提交**。

### 2026-10-15（`6f2cfc3`，12:18）
- 需求：支持用户独立题目轮换；配套把管理端「删除题目」改为软停用，避免停用题使当天已生成的 `daily_questions` / `quiz_answers` 失效（`:4-5` 头注释）。
- 修改内容（涉本文件）：创建本文件。给 `questions` 加 `active BOOLEAN NOT NULL DEFAULT TRUE` 与 `ix_questions_active` 索引。无数据写入、无历史重算。
- 关联文件：`backend/app/models/models.py`（`Question.active`）、`backend/app/services/quiz_service.py`（`_pick_questions` 按 `active` 过滤 + `_question_usage` 按用户统计使用次数实现独立轮换）、`backend/app/services/admin_service.py`（题库列表过滤 + 删题改软停用）、`backend/app/services/ai_question_service.py`（AI 出题去重只取可用题）、`docker/init/019_sport_backfill_carry.sql`（同一提交）。
- 测试结果：见 `docs/迭代记录.md` 的 `6f2cfc3` 条目。**后续生产事故**：`docker/init/SQL_CONSTRAINTS.md` §7 表格记录 `f413ac6` 症状为「后端启动 seed 阶段报 openGauss 派生表列名歧义」，其**真正根因是本迁移未在生产执行**；表象修补 `51239b5` 已被回退。
