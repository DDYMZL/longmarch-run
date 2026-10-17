# 002_route_node_config.sql

## 1. 文件路径

`docker/init/002_route_node_config.sql`（43 行）

## 2. 文件职责

为**切换 openGauss 前已存在的旧库**补齐 `route_nodes` 的 4 个地图/配置列（经纬度、排序、启用标记），回填 10 个长征节点的真实坐标，并把 4 列收紧为 NOT NULL——采用「加列 → 回填 → SET NOT NULL」模式。

## 3. 业务需求

`bceeb26`（2026-10-01）「数据库由 SQLite 切换为 Docker 承载的 openGauss」同批交付（`docs/迭代记录.md` 的 `bceeb26` 条目）。实景地图模式（小程序 march 页 `<map>` + polyline/markers）要求每个路线节点有真实经纬度；管理端点位管理要求可排序、可停用。新库由 `001_schema.sql:10-13` 直接建出这 4 列，本迁移只对旧库生效（对空表/已含列的库为无操作或幂等回填）。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:43`）。

### 4.1 加列（`:3-6`）

`ALTER TABLE route_nodes ADD COLUMN IF NOT EXISTS` ×4：`latitude NUMERIC(9,6)`、`longitude NUMERIC(10,6)`、`sort_order INTEGER`、`is_enabled BOOLEAN`——均可空加入（先不设 NOT NULL，避免存量行违约）。

### 4.2 坐标与配置回填（`:8-36`）

- 单条 `UPDATE route_nodes SET ... CASE id WHEN 1..10`：为 10 个节点写入硬编码经纬度（如 id=1 瑞金 25.885/116.027，id=10 吴起镇/会宁方向 36.6/109.49，`:10-19`、`:23-32`），与 `backend/app/data/seed.py` 的 10 节点种子一一对应。
- `ELSE COALESCE(latitude, 0)`（`:20`、`:33`）：id 超出 1–10 的行保留原值、NULL 兜底为 0。
- `sort_order = COALESCE(NULLIF(sort_order, 0), id)`（`:35`）：未设置或为 0 时按 id 排序。
- `is_enabled = COALESCE(is_enabled, TRUE)`（`:36`）：默认启用。

### 4.3 收紧 NOT NULL（`:38-41`）

`ALTER COLUMN ... SET NOT NULL` ×4，使旧库结构与 `001_schema.sql:10-13` 的新库基线完全一致。

## 5. 输入与输出

- **输入（前置条件）**：001 已建 `route_nodes`（或旧库已有该表）；坐标 CASE 假定节点 id 为 1–10（seed.py 的固定编号）。
- **输出**：`route_nodes` 新增/收紧 4 列；10 个种子节点获得真实坐标。
- **失败模式**：若存在 id 1–10 之外且 `latitude` 为 NULL 的行，`ELSE COALESCE(...,0)` 已兜底，SET NOT NULL 不会失败；`ADD COLUMN IF NOT EXISTS` 在不支持该语法的生产 openGauss 上直接语法报错（见 §9）。

## 6. 依赖关系

- 依赖：`001_schema.sql`（`route_nodes` 表必须先存在，否则 `init-db.sh:17` 的 `ON_ERROR_STOP=1` 使脚本中断）。
- 被依赖：`backend/app/models/models.py:55-58`（RouteNode.latitude/longitude/sort_order/is_enabled）；小程序实景地图的节点坐标链路（`frontend/AGENTS.md` §4 不变量 6 所述 `NODE_COORDS`，坐标源自后端 `/march/route`）；005 继续对 `route_nodes` 加历史事件卡字段。

## 7. 业务规则

1. **坐标是配置数据**：以迁移内硬编码常量落库，之后管理端「路线点位」可编辑，编辑结果**不回写本文件**。
2. **回填不收敛**：`UPDATE`（`:8-36`）无 WHERE 过滤，整表覆写——首次执行安全（目标列为新加的空列），但**手工重跑会把管理端事后修改过的坐标/排序/启用状态重置为硬编码值**，违反 `SQL_CONSTRAINTS.md` §2.4「重算类 UPDATE 必须收敛」的现行要求。
3. `sort_order` 缺省语义：0 视为未设置，回落为 id。

## 8. 修改约束

1. **禁止修改本文件**（已在生产执行，`SQL_CONSTRAINTS.md` §3.1）；坐标勘误只能新增编号迁移或走管理端编辑。
2. 4 列的最终形态（NOT NULL、无 DEFAULT）必须与 `001_schema.sql:10-13`、ORM `models.py:55-58` 保持一致——三处是同一契约。
3. 硬编码坐标与 `seed.py` 节点 id 1–10 的对应关系不得错位（CASE 按 id 匹配）。

## 9. 当前实现状态

- **已实现**：旧库补列路径已随 `bceeb26` 交付；新库场景本文件近似 no-op（列已存在，UPDATE 对空表 0 行）。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` §1）**：
  - §1.1 **违规**：`:3-6` 使用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`——现行约束明令禁用（生产版本报 `syntax error at or near "NOT EXISTS"`，§7 踩坑表 2026-10-16 生产事故即此语法）。本文件早于约束文档，属历史包袱；`.qoder/ARCHITECTURE.md` §12.4「历史包袱」段原**未列 002**（只列 005/013/015/017/019/020），本文档查出后该段已于 2026-10-17 更正为完整的 8 个文件清单（002/005/013/014/015/017/019/020）并另列 004/008 的裸 `ADD COLUMN`。
  - §1.4：无派生表，不涉及。§2.1（事务）：合规。§2.2（幂等）：加列/SET NOT NULL 部分幂等，但 UPDATE 整表覆写不满足（§7 规则 2）。
  - §4 **违规**：无任何头注释（缺「变更目的/影响面/回滚」三段）。
- **ORM 对照**：`models.py:55-58` 的 `Numeric(9,6)/Numeric(10,6)/Integer/Boolean` 与 DDL 一致；ORM 注解 `Mapped[float]` 但 psycopg2 运行时返回 `Decimal`（`.qoder/ARCHITECTURE.md` §13.2 已登记）。
- **回滚方式**：文件内无回滚语句。手工回滚 = `ALTER TABLE route_nodes DROP COLUMN latitude/longitude/sort_order/is_enabled`（将破坏实景地图与点位管理功能，且 001 基线已含这 4 列，实际不应回滚）。
- **重跑风险**：手工重跑会覆写管理端编辑过的坐标（§7 规则 2）——不得绕过 `schema_migrations` 重跑（`SQL_CONSTRAINTS.md` §6）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/002_route_node_config.sql`，共 **1 个提交**。

### 2026-10-01（`bceeb26`，10:26）
- 需求：数据库由 SQLite 切换为 Docker 承载的 openGauss。
- 修改内容（涉本文件）：创建本文件，为旧库补 `route_nodes` 经纬度/排序/启用 4 列并回填 10 节点坐标。
- 关联文件：`docker/init/001_schema.sql`、`docker/compose.yml`、`docker/init/init-db.sh`。
- 测试结果：见 `docs/迭代记录.md` 的 `bceeb26` 条目。
