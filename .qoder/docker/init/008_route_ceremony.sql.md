# 008_route_ceremony.sql

## 1. 文件路径

`docker/init/008_route_ceremony.sql`（11 行）

## 2. 文件职责

为「长征完成仪式」功能给 `users` 表加一列 `route_ceremony_at TIMESTAMP NULL`：非空表示用户已观看过「首次完成长征」仪式动画，用于保证仪式只完整播放一次。

## 3. 业务需求

`79004f1`（2026-10-04）「区域氛围与长征完成仪式（P2-2）——节点区域主题映射+氛围粒子、完成仪式动画页与仅首次触发标记」交付（`docs/迭代记录.md` 的 `79004f1` 条目）。文件头注释标注「需求 §20」，触发规则（§20.4，`:6-7` 注释）：路线全部点亮且该字段为空时，`GET /march/route` 下发 `ceremony_pending=true`；前端播放完整仪式后调 `POST /march/ceremony` 写入本列；此后仅展示「已完成长征」。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:11`）。

### 4.1 加列（`:9`）

`ALTER TABLE users ADD COLUMN route_ceremony_at TIMESTAMP NULL;`——裸 ADD COLUMN（`SQL_CONSTRAINTS.md` §1.1 方式 B，不带 IF NOT EXISTS），可空、无 DEFAULT；存量用户全部为 NULL（= 未观看，符合条件者下次进路线页可触发仪式）。

## 5. 输入与输出

- **输入（前置条件）**：001 已建 `users` 表。
- **输出**：`users` 新增 1 个可空时间戳列；无数据回填。
- **失败模式**：**非幂等**——列已存在时重跑报 duplicate column，事务回滚、`ON_ERROR_STOP=1` 中断批次（正常由 `schema_migrations` 防重跑，`docker/init/init-db.sh:32-36`）。

## 6. 依赖关系

- 依赖：`001_schema.sql`（`users`）。
- 被依赖：ORM `backend/app/models/models.py:200-201`（`route_ceremony_at` 可空，与 DDL 一致）；后端 `march_service`/`routes/march.py` 的 `ceremony_pending` 判定与 `POST /api/march/ceremony` 标记端点（`:6-7` 注释所述链路；该端点无 response_model 的问题登记于 `.qoder/PROJECT.md` §8「代码级技术债」第 31 项）；小程序 `frontend/pages/ceremony/` 仪式动画页。

## 7. 业务规则

1. **一次性仪式**：`route_ceremony_at IS NULL` ⇔ 尚未观看；写入后即永久展示「已完成长征」，不再触发（§20.4，`:5-7` 注释）。
2. 该列只由 `POST /march/ceremony` 链路写入一次，无更新/清空场景。
3. 时间语义：存 UTC naive（全库约定，`.qoder/ARCHITECTURE.md` §13.2）。

## 8. 修改约束

1. **禁止修改本文件**（已在生产执行，`SQL_CONSTRAINTS.md` §3.1）。
2. 不得加 NOT NULL/DEFAULT——「NULL = 未观看」是触发判定的业务语义。
3. 手工补跑后必须回填 `schema_migrations`（`SQL_CONSTRAINTS.md` §6），否则重复执行必然失败（本文件非幂等）。

## 9. 当前实现状态

- **已实现**：生效中，ORM/DDL 一致；仪式链路已上线（P2-2）。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` §1）**：§1.1 合规（方式 B 裸 ADD，未用被禁语法；代价是非幂等）；§1.2/§1.4/§1.5 不涉及；§2.1 事务合规（`:1`/`:11`）；**§2.2 幂等违规**：未用 DO 块 + information_schema 判定（方式 A）；§4 部分合规：有目的与规则注释（`:3-7`）但缺「影响面/回滚」标准段。
- **回滚方式**：文件内无回滚语句。手工回滚 = `ALTER TABLE users DROP COLUMN route_ceremony_at;`——**丢失全部「已观看仪式」标记**，回滚后已完成长征的用户会再次触发完整仪式；生产不应回滚。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/008_route_ceremony.sql`，共 **1 个提交**。

### 2026-10-04（`79004f1`，01:13）
- 需求：区域氛围与长征完成仪式（P2-2，需求 §20）。
- 修改内容（涉本文件）：创建本文件，`users` 加 `route_ceremony_at` 首次完成仪式标记列。
- 关联文件：`backend/app/models/models.py`、`backend/app/api/routes/march.py`、`backend/app/services/march_service.py`、小程序 ceremony 页。
- 测试结果：见 `docs/迭代记录.md` 的 `79004f1` 条目。
