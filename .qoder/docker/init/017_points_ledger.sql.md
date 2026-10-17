# 017_points_ledger.sql

## 1. 文件路径

`docker/init/017_points_ledger.sql`（45 行）

## 2. 文件职责

V2.0 积分口径重构迁移：把 `points_log` 从「按次追加的流水」改造成「每人每来源每自然日一行」的**台账**——新增 `source_type` / `ref_id` / `biz_key` / `created_at` / `updated_at` 五列（`:9-13`）、建唯一索引 `uq_points_user_biz` 与辅助索引 `ix_points_log_source_user`（`:15-16`），并按新口径（总积分 = 步行积分 + 答题积分）回填历史 walk / quiz 台账（`:19-41`），最后把 `quiz_records.points` 刷成新公式（`:43`）。旧规则流水一律标记 `source_type='legacy'`，只保留追溯、不计入总积分与排名（`:4-5` 头注释）。

## 3. 业务需求

`2f3f333`（2026-10-13）「积分台账重构——总积分=步行+答题（017 迁移回填，biz_key 每日幂等、业务同事务行锁重算），步数同步只增不减并按北京时间校正往日，移除登录/达标/点亮/里程碑积分，排名统一按总积分」交付（`docs/迭代记录.md` 的 `2f3f333` 条目）。`:3` 头注释标注对应「V2.0 需求三/四」。业务场景：V2.0 之前登录、达标、点亮、里程碑等多来源各自发分，重复同步/重放请求会重复计分且口径无法核对；重构后**积分全部由后端按源数据计算**，台账可被 `points_service.recompute_all` 全量核对与修复。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:45`）。

### 4.1 台账五列（`:9-13`）

| 列 | DDL | 业务含义 |
|---|---|---|
| `source_type` | `VARCHAR(16) NOT NULL DEFAULT 'legacy'` | 来源枚举 `walk` / `quiz`；默认值 `legacy` 使**存量旧流水自动落为 legacy**，不需额外 UPDATE（`:4-5`） |
| `ref_id` | `INTEGER`（可空，无 FK） | walk 行指向 `daily_sport.id`，quiz 行指向 `daily_questions.id`（当日答题会话）（`:8`） |
| `biz_key` | `VARCHAR(64)`（可空） | 业务唯一键 `walk:YYYY-MM-DD` / `quiz:YYYY-MM-DD`（`:6`）；legacy 行为 NULL |
| `created_at` | `TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP` | 台账行创建时间 |
| `updated_at` | `TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP` | 最近一次重算覆盖时间 |

五列全部使用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（§9 记为兼容性违规）。

### 4.2 索引（`:15-16`）

- `uq_points_user_biz`（`:15`，**唯一**索引，`(user_id, biz_key)`）：台账幂等的物理承载。`biz_key` 可空是**有意设计**——legacy 行 `biz_key` 为 NULL，而唯一索引中 NULL 互不相等，故同一用户可保留任意多条 legacy 流水而不冲突；只有 walk/quiz 台账行受唯一性约束。
- `ix_points_log_source_user`（`:16`，`(source_type, user_id)`）：支撑「只统计 walk + quiz」的汇总查询（`backend/app/services/points_service.py:160`、`:168`、`:238`、`:300`）。
- 本文件**不建** `ix_points_log_user_id` / `ix_points_log_date`——这两个由 `docker/init/001_schema.sql:112-113` 建立。

### 4.3 步行积分回填（`:19-28`）

`INSERT ... SELECT` 从 `daily_sport` 生成 walk 台账行：`delta = CAST(FLOOR(LEAST(s.steps, 20000) / 1000) AS INTEGER)`（`:21`），`reason='步行积分'`、`source_type='walk'`、`ref_id=s.id`、`biz_key='walk:' || s.date`（`:20-22`）。过滤条件 `s.steps >= 1000`（`:25`）+ `NOT EXISTS`（`:26-28`）——**幂等手法是 `WHERE NOT EXISTS`，不是 `ON CONFLICT`**（openGauss 不支持，`docker/init/SQL_CONSTRAINTS.md` §1.5）。时间为 `CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`（`:23`），显式转 UTC 而非依赖列默认值。

### 4.4 答题积分回填（`:31-41`）

从 `quiz_records` 生成 quiz 台账行：`delta = LEAST(q.correct_count * 2, 10)`（`:33`，答对数 × 2、单日上限 10），`ref_id = dq.id`，`biz_key='quiz:' || q.date`。用 `LEFT JOIN daily_questions dq ON dq.user_id = q.user_id AND dq.date = q.date`（`:37`）取会话 id，故**无当日会话缓存时 `ref_id` 落 NULL**（LEFT JOIN 语义，与 `points_service._expected_for` 的 `sessions.get(...)` 一致，`points_service.py:288`）。过滤 `q.correct_count > 0`（`:38`）+ `NOT EXISTS`（`:39-41`）。

### 4.5 `quiz_records.points` 全表刷新（`:43`）

`UPDATE quiz_records SET points = LEAST(correct_count * 2, 10);` —— **无 WHERE 子句的全表重算**，把历史答题记录的冗余积分列统一到新公式（§9 记为 `SQL_CONSTRAINTS.md` §2.4 违规）。

## 5. 输入与输出

- **输入（前置条件）**：`001_schema.sql:104-113` 已建 `points_log`（原始列 `id`/`user_id`/`date`/`reason`/`delta`）；`daily_sport`、`quiz_records`、`daily_questions` 已存在且有历史数据。
- **输出**：`points_log` 新增 5 列 + 2 索引；按存量 `daily_sport`（steps ≥ 1000 的日期）与 `quiz_records`（correct_count > 0 的日期）逐日插入 walk / quiz 台账行（行数取决于存量数据，**本次建档禁止连库，实际行数待确认**）；`quiz_records.points` 全表被覆写为新公式值。
- **对既有数据的影响**：① 存量流水被列默认值批量标记为 `legacy`，**从总积分与排名中消失**（这是需求预期，不是数据丢失）；② `quiz_records.points` 被无条件覆写。
- **失败模式**：`ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 在不支持该语法的生产 openGauss 版本上直接语法报错、事务整体回滚（`SQL_CONSTRAINTS.md` §1.1、§1.2，§7 表格记有 2026-10-16 同类事故）。

## 6. 依赖关系

- **依赖先序迁移**：`001_schema.sql`（`points_log` 基础表 `:104-113`、`daily_sport`、`quiz_records`、`daily_questions`）。
- **被后续迁移依赖**：`019_sport_backfill_carry.sql` 直接读写本文件新增的 `biz_key` / `delta` / `ref_id` / `updated_at`（`019:15-28`、`:30-47`），**019 必须在 017 之后执行**（`init-db.sh` 按字典序保证）。
- **对应 ORM**：`backend/app/models/models.py:329-350`（`PointsLog`）——`__table_args__` 声明 `UniqueConstraint("user_id","biz_key", name="uq_points_user_biz")`（`:337`）与 `Index("ix_points_log_source_user","source_type","user_id")`（`:338`）；五列逐一见 `:346-350`。`QuizRecord.points` 见 `models.py:283`。
- **读写方**：
  - `backend/app/services/points_service.py`——台账唯一合法写入方：`biz_key()`（`:64-65`）、`set_daily()`（`:68-97`，行锁 `with_for_update` 内重算覆盖、**不提交**）、`recompute_walk()`（`:100-108`）、`points_subquery()`（`:149-164`）、`_verify_batch()` / `recompute_all()`（`:292-348`）。
  - `backend/app/services/sport_service.py:180`、`:339`——步数写入后调 `recompute_walk`。
  - `backend/app/services/quiz_service.py:536-539`——`reset_today` **越层直删** `points_log` 行（§7.4）。
  - `backend/app/services/admin_service.py:348`、`:537`、`:594`——管理端台账核对/修复与明细展示。

## 7. 业务规则

1. **新口径**：总积分 = 步行积分 + 答题积分，其余来源（登录/达标/点亮/里程碑）不再发放（`:4-5`）；`points_service.py:149-164` 的汇总只统计 `source_type IN ('walk','quiz')`（`SOURCES`，`:29`），legacy 行天然被排除。
2. **`biz_key` 构造规则两侧一致**：DDL 侧用字符串拼接 `'walk:' || s.date`（`:22`、`:27`）与 `'quiz:' || q.date`（`:34`、`:40`）；ORM 侧 `points_service.biz_key(source, date)` 返回 `f"{source}:{date}"`（`points_service.py:64-65`），常量 `WALK="walk"` / `QUIZ="quiz"`（`:27-28`）。**格式完全一致**，`019:28`、`:31`、`:46` 也沿用同一拼接式。
3. **每日幂等**：`(user_id, biz_key)` 唯一 + 业务事务内行锁重算覆盖（`points_service.py:73-97`：`with_for_update()` 取行，`delta` 与 `ref_id` 均未变则直接返回 False 不写），因此重复同步、重放请求、并发提交只会得到同一结果，不会重复计分。
4. **唯一约束为何防不住口径分叉**：`uq_points_user_biz` 只保证「同人同日同来源只有一行」，**不约束这一行的 `delta` 怎么算**。`delta` 的计算公式在库里存在三处独立实现——本文件 `:21`（每日各自 `floor(min(steps,20000)/1000)`）、`019:19`/`:35`（累计结余口径，仍带 20000 上限）、`points_service.walk_chain`（`:34-41`，累计结余口径、**无单日上限**）。三者对同一 `biz_key` 会算出不同 `delta`，唯一约束只会让「后写的一方覆盖前一方」，不会报错、不会告警。这正是 `quiz_service.reset_today` 能绕开口径的原因：它在 `:536-539` 直接 `db.query(PointsLog).filter(...).delete()`，**不经 `points_service.set_daily`**，删掉的是台账行本身，唯一约束对「删除」无任何约束力（`.qoder/PROJECT.md` §8「代码级技术债」第 30 项）。
   > 需更正的既有登记：第 30 项若表述为「`reset_today` 自行复制 `biz_key` 构造逻辑」，与源码不符——`quiz_service.py:538` 实际调用的是 `points_service.biz_key(points_service.QUIZ, date)`，**复用了公共函数、没有复制逻辑**；真正的问题是「越层直删、绕过 `set_daily` 的重算与行锁」。
5. **legacy 行不可回收**：`biz_key` 为 NULL 的历史流水既不会被 `set_daily` 命中（过滤条件是 `biz_key == key`），也不会被 `_verify_batch` 纳入核对（`:300` 过滤 `source_type.in_(sources)`），永久只读。
6. **`quiz_records.points` 是冗余展示列**：`:43` 刷新后，积分权威来源已是 `points_log`；`quiz_records.points` 仅供答题记录页展示。

## 8. 修改约束

1. **禁止修改本文件**：已入库（`git ls-files` 含 `docker/init/017_points_ledger.sql`）且属已发布编号脚本，`SQL_CONSTRAINTS.md` §3.1 明令「禁止修改已在生产执行过的编号脚本」，需要变更一律新增编号（`019` 已是先例）。生产库 `schema_migrations` 是否已登记 `017_points_ledger.sql`：**待确认（本次建档禁止连库）**。
2. **不可绕过 `schema_migrations` 手工全量重跑**：`SQL_CONSTRAINTS.md` §6 第一条点名本文件——`:43` 的重算 UPDATE 会覆盖管理员事后手工调整过的 `quiz_records.points`。
3. `source_type` 取值域 `walk` / `quiz` / `legacy` 是 `points_service.SOURCES`（`:29`）与 `admin_service` 过滤条件的硬契约，不得改名或新增未同步的值。
4. `biz_key` 格式 `<source>:<date>` 被 DDL 字符串拼接（本文件与 `019`）和 `points_service.biz_key` 双向依赖，**改格式等于让全部历史台账失联**。
5. `uq_points_user_biz` 依赖 `biz_key` 可空来放行 legacy 行；若把它改成 `NOT NULL`，存量 legacy 行会导致唯一索引建立失败。
6. 回填 SQL 里 `20000` / `2` / `10` 三个魔数是**硬编码**，而运行期已由 `backend/app/core/config.py:102-104` 的 `POINTS_WALK_STEPS_PER_POINT` / `POINTS_QUIZ_PER_CORRECT` / `POINTS_QUIZ_DAILY_CAP` 参数化；改配置**不会**改本文件的回填结果（§9 记为口径分歧）。

## 9. 当前实现状态

- **已实现**：台账五列、两个索引、walk/quiz 回填、`quiz_records.points` 刷新均在用；运行期由 `points_service` 维护，管理端 `admin_service` 提供核对/修复入口。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` 逐项）**：
  - **§1.1 违规（5 处）**：`:9`、`:10`、`:11`、`:12`、`:13` 全部使用禁用的 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`。应改为 §1.1 方式 A（`DO $$ … IF NOT EXISTS (SELECT 1 FROM information_schema.columns …)`）。本文件早于约束文档定稿。
  - **§1.2 风险（2 处）**：`:15`、`:16` 使用 `CREATE [UNIQUE] INDEX IF NOT EXISTS`，按「默认不支持」处理应改 `DO` 块 + `pg_indexes` 判定（对比 `021_ai_center.sql:93-122` 的合规写法）。
  - **§1.3 不涉及**（无 CREATE TABLE）；**§1.4 合规**：`:26-28`、`:39-41` 的 `NOT EXISTS` 子查询不在 FROM 子句中，`:19-24`、`:31-37` 直接 FROM 实表，无派生表。
  - **§1.5 合规**：未用 `ON CONFLICT`，改用 `WHERE NOT EXISTS`（`:26-28`、`:39-41`）——正是该节推荐的替代手法。
  - **§2.1 合规**（`:1`/`:45`）；**§2.2 部分合规**：两段 INSERT 幂等，但 `:43` 的 UPDATE 不满足「差异过滤」要求；**§2.3 合规**（无 DROP/TRUNCATE/无 WHERE 的 DELETE）；**§2.4 违规**：`:43` 的重算 UPDATE **完全没有 WHERE 子句**，未限定 `biz_key`、也未做 `points <> LEAST(...)` 差异过滤，属全表覆写。
  - **§4 部分合规**：`:3-8` 有主题与影响面说明，但**未按「变更目的 / 影响面 / 回滚」三段式分列**，且**缺回滚段**（对比 `021:4-8`、`022:4-8` 的合规写法）。
- **重跑后果（逐项）**：
  - 两段 INSERT（`:19-28`、`:31-41`）**可安全重跑**——`NOT EXISTS` 保证不产生重复行；但因此也**无法修正**已存在的错误 `delta`（只补不改）。
  - `:43` 的 UPDATE 重跑**结果收敛**（`points` 是 `correct_count` 的纯函数，跑两次同值），但会**无条件抹掉管理员对 `quiz_records.points` 的任何手工调整**，故仍属「不可重复执行」。
  - **与 `019` 的顺序耦合**：`019:15-28` 会把 walk 行 `delta` 改成累计结余口径。本文件的两段 INSERT 不 UPDATE 既有 walk 行，故在 019 之后重跑 017 **不会**把 walk 口径回退；但若 017 在 019 之后才首次执行（迁移缺口补跑顺序错乱），`:19-28` 会按**旧的每日独立取整口径**插入 walk 行，随后 019 的 `NOT EXISTS`（`:45-47`）会因行已存在而**跳过补建**，只靠 `:15-28` 的 UPDATE 修正——顺序颠倒时结果仍正确，但依赖 019 的 UPDATE 兜底。
- **ORM 与 DDL 分歧**：
  1. **步行单日上限**：DDL `:21` 用 `LEAST(s.steps, 20000)` 设 20000 步/日上限；`points_service.walk_chain`（`:34-41`）与 `_expected_for`（`:277-278`）**不设任何单日上限**，`points_service.py:4` docstring 明写「不设单日上限」，`config.py:102-104` 也**没有** walk 上限配置项。→ 本文件回填的 walk `delta` 会被运行期 `recompute_walk`（`sport_service.py:180`、`:339` 每次步数写入都调）按无上限口径**覆盖**，回填值实际是过渡态。
  2. **答题积分魔数**：DDL `:33` 硬编码 `correct_count * 2` 与上限 `10`；ORM 侧走 `settings.POINTS_QUIZ_PER_CORRECT` / `POINTS_QUIZ_DAILY_CAP`（`points_service.py:59-61`）。当前默认值一致（`config.py:103-104`），改配置即分叉。
  3. **答题积分数据源**：DDL `:36-38` 从 `quiz_records.correct_count` 取数；`points_service.quiz_correct_counts`（`:128-146`）现在**以 `quiz_answers` 逐题记录为准**、无逐题数据的历史日才回退 `quiz_records`。本文件早于 `018`，回填时 `quiz_answers` 尚不存在，故当时正确、现在只是历史兜底路径。
  4. **唯一约束实现方式**：ORM 用 `UniqueConstraint`（`models.py:337`），DDL 用 `CREATE UNIQUE INDEX`（`:15`），同名 `uq_points_user_biz`；因禁用 `create_all`（`backend/AGENTS.md` §4.8），实际库以 DDL 为准，无运行时影响。
  5. **时间默认值两套写法**：DDL `:12-13` 是 SQL 侧 `DEFAULT CURRENT_TIMESTAMP`（DB 会话时区），ORM `models.py:349-350` 是客户端 `default=datetime.utcnow`（naive UTC）。回填语句 `:23`、`:35` 显式写 `CURRENT_TIMESTAMP AT TIME ZONE 'UTC'` 规避了该差异，但**列默认值本身仍是本地时区**（`.qoder/ARCHITECTURE.md` §13.2）。
- **回滚方式**：文件内无回滚语句，头注释也**未提供**（§4 违规）。手工回滚 = `DROP INDEX ix_points_log_source_user; DROP INDEX uq_points_user_biz; DELETE FROM points_log WHERE source_type IN ('walk','quiz');` 再逐列 `ALTER TABLE points_log DROP COLUMN …`——但 `DELETE` 会销毁全部台账、`DROP COLUMN` 会让 ORM `PointsLog` 立即报 `UndefinedColumn`，且 `019` 已在其上叠加重算，**生产不可回滚**。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/017_points_ledger.sql`，共 **1 个提交**。

### 2026-10-13（`2f3f333`，11:25）
- 需求：V2.0 积分口径重构——总积分 = 步行积分 + 答题积分，移除登录/达标/点亮/里程碑积分，台账可核对可修复（`:3` 标注「V2.0 需求三/四」）。
- 修改内容（涉本文件）：创建本文件。给 `points_log` 加 `source_type`/`ref_id`/`biz_key`/`created_at`/`updated_at` 五列与 `uq_points_user_biz`、`ix_points_log_source_user` 两索引；按 `daily_sport` 回填 walk 台账、按 `quiz_records` 回填 quiz 台账（均 `WHERE NOT EXISTS` 幂等）；全表刷新 `quiz_records.points` 为 `LEAST(correct_count*2, 10)`。
- 关联文件：`backend/app/models/models.py`（`PointsLog` 五列与两约束）、`backend/app/services/points_service.py`（`biz_key`/`set_daily`/`recompute_*` 全套）、`backend/app/services/sport_service.py`、`backend/app/services/quiz_service.py`、`backend/app/services/admin_service.py`（管理端台账核对修复）、排名与 CSV 导出同口径改造。
- 测试结果：见 `docs/迭代记录.md` 的 `2f3f333` 条目。
