# 001_schema.sql

## 1. 文件路径

`docker/init/001_schema.sql`（125 行）

## 2. 文件职责

全库**基线建表迁移**：一次性创建 11 张核心表（路线节点、题库、勋章定义、组织、用户及 6 张用户业务表）与 13 个索引，是 `docker/init/` 编号迁移序列的第一环，也是后续 002–022 全部结构变更的基础。

## 3. 业务需求

`bceeb26`（2026-10-01）「数据库由 SQLite 切换为 Docker 承载的 openGauss」交付：把原先 SQLite 单文件库的结构落成 openGauss DDL，覆盖小程序全部核心业务——长征路线点亮、每日步数、每日一题、积分、勋章、组织归属（`docs/迭代记录.md` 的 `bceeb26` 条目）。表结构权威说明见 `.qoder/ARCHITECTURE.md` §13「数据库结构总览」。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:125`）。

### 4.1 静态配置表（4 张，数据由 `backend/app/data/seed.py` 启动时幂等写入，本文件只建结构）

| 表 | 行号 | 关键字段（类型 / 可空性） |
|---|---|---|
| `route_nodes` | `:3-14` | `id SERIAL PK`；`name VARCHAR(50)`、`target_steps INTEGER`（累计步数门槛）、`historical_time VARCHAR(50)`、`icon VARCHAR(16)`、`description TEXT` 均 NOT NULL；`latitude NUMERIC(9,6)`、`longitude NUMERIC(10,6)`、`sort_order INTEGER`、`is_enabled BOOLEAN` 均 NOT NULL（这 4 列自 `bceeb26` 初版即在基线中；同批的 002 面向切换前已存在的旧库补列回填）。**所有列均无 DB 侧 DEFAULT** |
| `questions` | `:16-24` | `id INTEGER PK`（**无 SERIAL**，seed 显式指定 id 1–15；管理端新增靠 `max(id)+1`，见 `.qoder/PROJECT.md` §8「代码级技术债」第 27 项）；`type VARCHAR(10)`（single/judge）、`question TEXT`、`options JSON`、`answer JSON`、`analysis TEXT`、`score INTEGER` 均 NOT NULL |
| `medal_defs` | `:26-31` | `id VARCHAR(50) PK`（字符串勋章码）；`name VARCHAR(50)`、`icon VARCHAR(16)`、`"desc" VARCHAR(200)` NOT NULL——`desc` 是保留字必须带引号（`.qoder/ARCHITECTURE.md` §12.5） |
| `organizations` | `:33-39` | `id SERIAL PK`（`7607d7b` 由 `INTEGER PRIMARY KEY` 改为 SERIAL，存量库由 009 补序列）；`name VARCHAR(80)` NOT NULL；`parent_id INTEGER` 可空、**无 FK**（逻辑外键，树形自引用）；`level`、`sort_order` NOT NULL。索引 `ix_organizations_parent_id`（`:41-42`） |

### 4.2 用户主表

`users`（`:44-51`）：`id SERIAL PK`；`openid VARCHAR(64)` NOT NULL + 唯一索引 `ix_users_openid`（`:53`）；`nickname VARCHAR(64)` NOT NULL（无 DEFAULT，登录时由后端写入）；`avatar VARCHAR(500)` NOT NULL（**后被 003 放宽为可空**）；`org_id INTEGER` 可空、无 FK、索引 `ix_users_org_id`（`:54`）；`created_at TIMESTAMP` NOT NULL、无 DEFAULT（ORM 侧 `default=datetime.utcnow` 为客户端默认，`backend/app/models/models.py:199`；索引由 012 补建）。

### 4.3 用户业务表（6 张，全部带 `user_id INTEGER NOT NULL REFERENCES users(id)` 真 FK）

| 表 | 行号 | 唯一约束 | 索引 | 说明 |
|---|---|---|---|---|
| `daily_sport` | `:56-62` | `uq_sport_user_date (user_id, date)` | `:64-65`（user_id、date） | `date VARCHAR(10)`（YYYY-MM-DD 字符串，非 DATE 类型）；`steps INTEGER` NOT NULL；同日覆盖而非累加（ORM docstring `models.py:232`） |
| `lit_nodes` | `:67-73` | `uq_lit_user_node (user_id, node_id)` | `:75`（user_id） | `node_id INTEGER` NOT NULL、**无 FK 指向 route_nodes**（逻辑外键）；`lit_at TIMESTAMP` NOT NULL；点亮永久保留 |
| `quiz_records` | `:77-88` | `uq_quiz_user_date (user_id, date)` | `:90-91` | `total_count/correct_count/score/points INTEGER`、`wrong_list JSON` NOT NULL；`answer_at BIGINT`（毫秒时间戳，`.qoder/ARCHITECTURE.md` §13.2） |
| `daily_questions` | `:93-99` | `uq_dailyq_user_date (user_id, date)` | `:101-102` | `question_ids JSON` NOT NULL，当天抽题缓存 |
| `points_log` | `:104-110` | 无（初版） | `:112-113` | `reason VARCHAR(50)`、`delta INTEGER`；「同日同 reason 去重」由 `points_service` 应用层保证（`backend/AGENTS.md` §4 不变量 5）；`biz_key/source_type/ref_id/created_at/updated_at` 与 `uq_points_user_biz` 由 017 补 |
| `user_medals` | `:115-121` | `uq_user_medal (user_id, medal_id)` | `:123` | `medal_id VARCHAR(50)`、**无 FK 指向 medal_defs**（逻辑外键）；`granted_at TIMESTAMP` NOT NULL |

## 5. 输入与输出

- **输入（前置条件）**：无前置迁移（编号最小）；要求 `init-db.sh` 已建库并创建 `schema_migrations` 表（`docker/init/init-db.sh:20-28`）。
- **输出**：11 张空表 + 13 个索引；执行成功后 `init-db.sh:35` 向 `schema_migrations` 登记 `001_schema.sql`。
- **失败模式**：任一语句失败即整体回滚（事务 + `gsql -v ON_ERROR_STOP=1`，`init-db.sh:17`）；库中已有同名表但结构不同时 `IF NOT EXISTS` 会**静默跳过**而不报错，导致结构漂移不易察觉。

## 6. 依赖关系

- 依赖：openGauss 基础 DDL 能力；无表级依赖。
- 被依赖：**全部后续迁移**（002/005 改 `route_nodes`，003/004/005/008/015 改 `users`，005/019 改 `daily_sport`，005 改 `lit_nodes/questions/medal_defs`，006/007 FK 指向 `route_nodes`，009 修 `organizations`，010 FK 指向 `users`，017 改 `points_log`）；ORM `backend/app/models/models.py`（不变量「表结构单一来源」，`backend/AGENTS.md` §4.8）；种子 `backend/app/data/seed.py`。

## 7. 业务规则

1. **幂等**：11 处 `CREATE TABLE IF NOT EXISTS`（§1.3 允许语法）+ 13 处 `CREATE INDEX IF NOT EXISTS`，重复执行无副作用、不改数据。
2. **日期一律 `VARCHAR(10)`** 存北京时间自然日字符串（`daily_sport/lit_nodes/quiz_records/daily_questions/points_log`），时间戳列存 UTC naive（`.qoder/ARCHITECTURE.md` §13.2）。
3. **唯一约束承载业务语义**：一人一天一条步数/答题/抽题记录、一人一节点一次点亮、一人一勋章一次发放——并发写入由数据库唯一约束兜底。
4. **逻辑外键有意不建 FK**：`lit_nodes.node_id`、`user_medals.medal_id`、`users.org_id`、`organizations.parent_id` 均无 `REFERENCES`（全库 13 处逻辑外键之一部，`.qoder/ARCHITECTURE.md` §13.2）。
5. 无任何 CHECK 约束，`type/reason` 等「枚举」均为 VARCHAR + 应用层校验（`.qoder/ARCHITECTURE.md` §13.2）。

## 8. 修改约束

1. **禁止修改本文件**：已在生产执行，`docker/init/SQL_CONSTRAINTS.md` §3.1 规定需要变更就新增编号（历史上 `7607d7b` 曾把 `organizations.id` 改为 SERIAL——因 `CREATE TABLE IF NOT EXISTS` 对存量库是 no-op 才未出事故，且同批新增 009 兜底存量库；**不应再效仿**）。
2. 表名/列名/唯一约束名是 ORM 与全部后续迁移的硬契约；`uq_*` 约束名被 ORM `UniqueConstraint(name=...)` 显式引用（`models.py:240` 等）。
3. `"desc"` 引号不可去掉（保留字）。
4. 新增列不得回填进本文件，只能加新编号迁移。

## 9. 当前实现状态

- **已实现**：基线 11 表全部在用；当前库的真实形态 = 本文件 + 002–022 叠加（如 `users` 已有 15 列、`points_log` 已有 biz_key 体系）。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` §1 逐项）**：
  - §1.1（禁 `ADD COLUMN IF NOT EXISTS`）：不涉及（本文件无 ALTER）。
  - §1.2（`CREATE INDEX IF NOT EXISTS` 谨慎）：**13 处使用**（`:41`、`:53-54`、`:64-65`、`:75`、`:90-91`、`:101-102`、`:112-113`、`:123`），生产版本按「不支持」处理时存在失败风险；属早于约束文档的历史包袱（`.qoder/ARCHITECTURE.md` §12.4「历史包袱」段只登记 §1.1 **禁用**语法 `ADD COLUMN IF NOT EXISTS` 的 8 个文件与 `004`/`008` 的裸 `ADD COLUMN`，**不含** §1.2「谨慎使用」类的 `CREATE INDEX IF NOT EXISTS`；后者全库共 12 个文件命中，以本文件的 13 处〔12 普通 + 1 唯一〕为最多，故本文件未列入 §12.4 属**口径差异而非遗漏**）。
  - §1.3（`CREATE TABLE IF NOT EXISTS` 允许）：合规。§1.4（派生表别名）：不涉及。§2.1（事务）：合规（`:1`/`:125`）。
  - §4（三段式头注释）：**缺失**——文件无「变更目的/影响面/回滚」注释（早于约束文档）。
- **与 ORM 的差异**（对照 `models.py`）：
  1. 本文件所有 NOT NULL 列**均无 DB 侧 DEFAULT**，而 ORM 大量声明 `default=...`（如 `RouteNode.target_steps default=0`，`models.py:44`）——均为 SQLAlchemy 客户端默认，INSERT 时由 ORM 补值，直连 SQL 插入则必须显式给值。
  2. `Organization.id` ORM 未声明 `autoincrement=True`（`models.py:171`），依赖 DDL 的 SERIAL 默认值发号。
  3. `quiz_records.details`（014）、`daily_sport.source/synced_at/sync_status`（019）、`users.status/invite_code_id/onboarded_at`（015）等 ORM 列不在本文件中，由后续迁移补齐。
- **回滚方式**：文件内无回滚语句。手工回滚只能按 FK 反序 `DROP TABLE`（先 `user_medals/points_log/daily_questions/quiz_records/lit_nodes/daily_sport`，再 `users/organizations/medal_defs/questions/route_nodes`），**会销毁全部业务数据**，仅限废弃整库场景；生产不适用。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/001_schema.sql`，共 **2 个提交**。按时间倒序。

### 2026-10-08（`7607d7b`，19:35）
- 需求：全链路测试缺陷修复（BUG-001 组织主键无自增）。
- 修改内容（涉本文件）：`organizations.id` 由 `INTEGER PRIMARY KEY` 改为 `SERIAL PRIMARY KEY`，使新库直接带自增序列；存量库由同批新增的 `009_org_serial.sql` 兜底。
- 关联文件：`docker/init/009_org_serial.sql`（新增）及同批后端修复（详见 `docs/迭代记录.md` 的 `7607d7b` 条目）。
- 测试结果：见 `docs/迭代记录.md` 的 `7607d7b` 条目。

### 2026-10-01（`bceeb26`，10:26）
- 需求：数据库由 SQLite 切换为 Docker 承载的 openGauss。
- 修改内容（涉本文件）：创建本文件，落基线 11 表 + 13 索引。
- 关联文件：`docker/compose.yml`、`docker/init/init-db.sh`、`backend/app/core/database.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `bceeb26` 条目。
