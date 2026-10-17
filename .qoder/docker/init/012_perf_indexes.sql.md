# 012_perf_indexes.sql

## 1. 文件路径

`docker/init/012_perf_indexes.sql`（12 行）

## 2. 文件职责

纯索引迁移：为三个大数据量热点查询补建索引（`:3-6` 头注释逐条说明用途），不改任何表结构与数据。属根 `agents.md` §2.4「大数据量性能保障」要求的落地——与同批的后端 SQL 聚合化、去 N+1 改造（`f59892e` 提交信息）配套。

## 3. 业务需求

`f59892e`（2026-10-11）「热点查询 SQL 聚合化与去 N+1（排行窗口函数、勋章/播报/档案聚合、连续行军按自然日连续修复、批量重算与组织子树批量更新、新增 012 索引）」交付（`docs/迭代记录.md` 的 `f59892e` 条目）。业务场景（`:4-6` 注释）：

1. 今日播报「今日点亮数」、驾驶舱趋势「新增点亮」——按时间范围过滤 `lit_nodes.lit_at`；
2. 驾驶舱趋势「新增用户」——按注册时间范围过滤 `users.created_at`；
3. 一次性成就去重 `has_event`——按 `(user_id, event_type)` 定位 `user_event`（`backend/app/services/event_service.py:53`，被 `sport_service.py:66`、`streak_service.py:99` 等阈值判定调用）。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:12`）；注释在事务内（`:3-6`），缺「回滚」段（`SQL_CONSTRAINTS.md` §4 部分合规）。

### 4.1 三条 `CREATE INDEX IF NOT EXISTS`（`:8-10`）

| 行 | 索引 | 表(列) | ORM 侧对应声明 |
|---|---|---|---|
| `:8` | `ix_lit_nodes_lit_at` | `lit_nodes (lit_at)` | `LitNode.lit_at` `index=True`（`models.py:267`，SQLAlchemy 默认索引名即此名） |
| `:9` | `ix_users_created_at` | `users (created_at)` | `User.created_at` `index=True`（`models.py:199`） |
| `:10` | `ix_user_event_user_type` | `user_event (user_id, event_type)` | `UserEvent.__table_args__` 显式 `Index("ix_user_event_user_type", ...)`（`models.py:375`） |

三个索引名与 ORM 默认/显式命名**完全一致**——本迁移的作用是把 ORM 元数据里已声明、但因禁用 `create_all` 而从未落到存量库的索引，通过 DDL 补齐（新库同样由本文件建立）。

## 5. 输入与输出

- **输入（前置条件）**：`lit_nodes`、`users`（001 建）、`user_event`（`005_upgrade.sql:70` 建）三表已存在。
- **输出**：3 个 B-tree 索引；无表结构变更、无数据变更、无种子。
- **失败模式**：`IF NOT EXISTS` 重跑 no-op，幂等；风险仅在生产 openGauss 不支持 `CREATE INDEX IF NOT EXISTS` 时整条语句报语法错（§1.2，见 §9）。大表建索引会持锁扫表，生产执行时长待确认（本次建档禁止连库）。

## 6. 依赖关系

- 依赖：`001_schema.sql`（`users`、`lit_nodes`）、`005_upgrade.sql`（`user_event`）。
- 与之相关的既有索引：`005_upgrade.sql:78-79` 已建 `ix_user_event_user_id`、`ix_user_event_time`——**`ix_user_event_user_type` 并非 005 所建**，005 里不存在该复合索引（实测 grep 0 命中）；本文件 `:10` 是它在 DDL 侧的唯一出处。建成后 `ix_user_event_user_id`（单列 `user_id`）成为复合索引 `(user_id, event_type)` 的左前缀，**功能冗余**（可被复合索引覆盖），未删除属保守处理。
- 被依赖：播报/驾驶舱趋势聚合查询（rank/dashboard 服务链路，`f59892e` 同批改造）、`event_service.has_event`（`event_service.py:53`）。

## 7. 业务规则

1. **幂等**：三条均 `IF NOT EXISTS`，手工重跑无副作用（`SQL_CONSTRAINTS.md` §2.2 合规）。
2. 索引是**性能契约不是功能契约**：删除任何一条不会报错，只会让对应热点查询退化为全表扫描。
3. 索引名与 ORM 声明同名是隐式契约：若未来放开 `create_all`（当前禁用）或做结构比对，同名才不会产生重复索引。

## 8. 修改约束

1. **禁止修改本文件**（编号脚本一经生产执行不得修改，`SQL_CONSTRAINTS.md` §3.1）。是否已在生产 `schema_migrations` 登记：待确认（本次建档禁止连库）；按功能上线时间（2026-10-11）推定已执行。
2. 新增索引一律走新编号迁移；对既有表补索引前先核对 ORM 是否已声明同名索引（`models.py`），避免 DDL/ORM 两侧名字打架。
3. 不要顺手在本文件补 `DROP INDEX ix_user_event_user_id`（冗余左前缀）——属删改已发布脚本，如需清理另立编号并评估。

## 9. 当前实现状态

- **已实现**：三索引随 `f59892e` 批次上线，聚合化查询改造同批交付。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md`）**：
  - §1.1 不涉及（实测 `ADD COLUMN IF NOT EXISTS` 命中 0 处）；§1.3 不涉及（无建表）。
  - §1.2 **谨慎项 3 处**（`:8-10`）：生产版本按「不支持」处理时三条均会失败。本文件早于约束文档定稿，属历史包袱；`013` 之后的新迁移应改 DO 块 + `pg_indexes` 判定。
  - §1.4/§1.5 不涉及；§2.1 事务合规（`:1`/`:12`）；§2.2 幂等合规；§2.3 合规。
  - §4 部分合规：`:3-6` 有主题与逐条用途（影响面），缺「回滚」段。
- **与 ORM 的差异**：无——三个索引名、列组合与 `models.py:267`、`:199`、`:375` 逐一对应（此前「`ix_user_event_user_type` 只存在于 ORM/012 之一」的口径**不成立**：005 从未建过它，ORM 与 012 两侧同名共存）。
- **冗余索引**：`ix_user_event_user_id`（`005_upgrade.sql:78`）被 `:10` 复合索引左前缀覆盖，仍在库中（未删除）；是否清理待确认。
- **回滚方式**：文件内无回滚语句。手工回滚 = `DROP INDEX ix_lit_nodes_lit_at; DROP INDEX ix_users_created_at; DROP INDEX ix_user_event_user_type;`——只损失性能不损失数据，可安全回滚。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/012_perf_indexes.sql`，共 **1 个提交**。

### 2026-10-11（`f59892e`，11:53）
- 需求：热点查询性能保障（播报/驾驶舱趋势/成就去重）。
- 修改内容（涉本文件）：新建本文件，补建 `ix_lit_nodes_lit_at`、`ix_users_created_at`、`ix_user_event_user_type` 三索引。
- 关联文件：后端排行/勋章/播报/档案聚合与去 N+1 改造（rank/medal/event/streak/org 等服务）、`backend/app/models/models.py:375`（`UserEvent` 复合索引声明）。
- 测试结果：见 `docs/迭代记录.md` 的 `f59892e` 条目。
