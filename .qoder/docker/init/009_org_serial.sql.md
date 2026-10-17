# 009_org_serial.sql

## 1. 文件路径

`docker/init/009_org_serial.sql`（14 行）

## 2. 文件职责

修复 BUG-001：`organizations.id` 早期建表为 `INTEGER PRIMARY KEY`（无 SERIAL 序列），管理端新增组织时插入 NULL 主键报 500。本迁移为**已存在的库**补建序列 `organizations_id_seq`、把 `id` 列默认值接管为 `nextval`，并将序列当前值对齐到 `MAX(id)`；新库由同批修改的 `001_schema.sql:34` SERIAL 直接创建（`:1-3` 头注释自述）。

## 3. 业务需求

`7607d7b`（2026-10-08）「修复全链路测试发现的 4 处缺陷并复测回归（组织主键自增/答题题目校验/补步下限/WS 时间戳契约）」中的「组织主键自增」缺陷修复（`docs/迭代记录.md` 的 `7607d7b` 条目）。业务侧需求：管理端「组织架构」页新增组织必须能自动发号（`admin/src` orgs 菜单，`010_admin_identity.sql:113` 种子）。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:4`）… `COMMIT`（`:14`）；说明性注释在事务之前（`:1-3`）。

### 4.1 补建序列（`:6`）

`CREATE SEQUENCE IF NOT EXISTS organizations_id_seq;`——命名与 PostgreSQL/openGauss 对 `SERIAL` 列自动生成序列的命名约定（`<表>_<列>_seq`）一致：新库中 001 的 SERIAL 已隐式创建同名序列，本语句为 no-op；旧库则在此显式补建。

### 4.2 接管列默认值（`:8-9`）

`ALTER TABLE organizations ALTER COLUMN id SET DEFAULT nextval('organizations_id_seq');`——使旧库的 INSERT 省略 id 时也能发号，与 SERIAL 行为等价。

### 4.3 对齐序列值（`:12`）

`SELECT setval('organizations_id_seq', COALESCE((SELECT MAX(id) FROM organizations), 0));`——注释（`:11`）说明意图：下一次 `nextval` 返回 `MAX(id)+1`，空表时为 1。`MAX(id)` 是标量子查询，不是 FROM 派生表，`SQL_CONSTRAINTS.md` §1.4 的别名要求不适用。

## 5. 输入与输出

- **输入（前置条件）**：001 已建 `organizations` 表（新旧两种形态均可：SERIAL 或 INTEGER PK）。
- **输出**：序列存在且 `id` 默认值 = `nextval`；序列水位 = 当前 `MAX(id)`。无表结构/数据变更。
- **失败模式**：见 §9——空表时 `setval(seq, 0)` 在 PostgreSQL 语义下越界报错（序列 minvalue=1），openGauss 行为是否一致**待确认**（本次任务禁止连库验证）；`:11` 注释声称「空表时为 1」，若 openGauss 与 PG 行为相同，则**全新空库跑到本行会失败**。

## 6. 依赖关系

- 依赖：`001_schema.sql`（`organizations` 表）；与 001 的 SERIAL 修改（`7607d7b`）是同一缺陷的两半——001 管新库、009 管旧库。
- 被依赖：管理端组织新增链路（后端 org/admin service 的 INSERT）；ORM `backend/app/models/models.py:171`（`Organization.id` 未声明 `autoincrement=True`，完全依赖本迁移建立的 DB 侧默认值发号）。

## 7. 业务规则

1. **幂等性（部分）**：`CREATE SEQUENCE IF NOT EXISTS` 与 `SET DEFAULT` 重跑无害；但重跑 `setval(..., MAX(id))` 会把序列水位**拉回**当前最大值——若期间有序列已发出但尚未落库的号（并发 INSERT 进行中），重跑可能导致后续主键冲突。正常路径由 `schema_migrations` 保证只跑一次。
2. 序列名 `organizations_id_seq` 是隐式契约：改名会与 001 SERIAL 自动生成的序列脱钩，产生双序列。
3. 不删除数据、不改行内容（§2.3 合规）。

## 8. 修改约束

1. **禁止修改本文件**（已在生产执行，`SQL_CONSTRAINTS.md` §3.1）——包括把 `COALESCE(..., 0)` 改成 `..., 1)` 这类看似安全的修复；如需修正空表边界，只能新增编号迁移。
2. `organizations.id` 的发号职责在数据库侧（序列默认值），后端不得再对组织表用 `max(id)+1` 手工发号（对照 `.qoder/PROJECT.md` §8「代码级技术债」第 27 项对其它表的登记）。
3. 迁移文件顶部注释在 `START TRANSACTION` 之前，与 `SQL_CONSTRAINTS.md` §4 模板顺序（事务在最前）不同——属既有事实，不要仿写。

## 9. 当前实现状态

- **已实现**：BUG-001 修复生效；全链路测试复测回归通过（见 `docs/迭代记录.md` 的 `7607d7b` 条目）。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md`）**：
  - §1.1/§1.2/§1.3 不涉及（无 ADD COLUMN、无 CREATE INDEX、无 CREATE TABLE）；`CREATE SEQUENCE IF NOT EXISTS` 未列入约束文档任何表格——按 §1.5 末段要求「未在表中出现的语法先本地跑通再生产 dry-run」，`7607d7b` 批次已经过全链路测试，视为已验证。
  - §1.4 合规（`:12` 为标量子查询，非 FROM 派生表）。§2.1 事务合规（`:4`/`:14`）。§2.2：部分幂等（§7 规则 1）。
  - §4 部分合规：`:1-3` 有目的与影响面说明，但缺「回滚」段，且注释位于事务外（§8 规则 3）。
  - **空表边界风险（待确认）**：`setval(seq, 0)` 在 PostgreSQL 会报 `value 0 is out of bounds`（minvalue=1）；openGauss 是否同样拒绝、以及本地/生产库执行本迁移时 `organizations` 是否恒非空（seed 13 个组织在后端启动时才写入，迁移时可能为空），本次任务禁止连库无法验证——**待确认**（需要一次本地 `docker compose run --rm database-init` 空库复跑取证）。
- **与 ORM 的差异**：`Organization.id` ORM 无 `autoincrement=True`（`models.py:171`），依赖本迁移的 DB 默认值——功能等价，但 ORM 元数据不体现自增语义（对照 `RouteNode.id` 显式声明 `autoincrement=True`，`models.py:42`）。
- **回滚方式**：文件内无回滚语句。手工回滚 = `ALTER TABLE organizations ALTER COLUMN id DROP DEFAULT; DROP SEQUENCE organizations_id_seq;`——将**重新引入 BUG-001**（管理端新增组织报 500），且新库中该序列被 001 的 SERIAL 依赖、DROP 会破坏 SERIAL 默认值，实际不可回滚。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/009_org_serial.sql`，共 **1 个提交**。

### 2026-10-08（`7607d7b`，19:35）
- 需求：全链路测试缺陷修复——组织主键自增（BUG-001）。
- 修改内容（涉本文件）：新建本文件，为存量库补建 `organizations_id_seq`、接管 `id` 默认值并对齐水位。
- 关联文件：`docker/init/001_schema.sql`（同批把 `organizations.id` 改为 SERIAL）、后端组织管理与全链路测试脚本。
- 测试结果：见 `docs/迭代记录.md` 的 `7607d7b` 条目。
