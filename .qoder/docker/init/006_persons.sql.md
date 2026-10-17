# 006_persons.sql

## 1. 文件路径

`docker/init/006_persons.sql`（25 行）

## 2. 文件职责

「长征人物志」建表迁移：新建 `persons`（人物）与 `person_nodes`（人物 ↔ 路线节点关联）两张表及 1 个索引。人物种子数据不在本文件，由 `backend/app/data/seed.py` 启动时幂等补齐（`:4` 注释；13 位人物、id 1–13，`.qoder/ARCHITECTURE.md` §13.3）。

## 3. 业务需求

`2a178b7`（2026-10-03）「长征人物志与答题连胜效果（P1-8）——人物/关联表+人物志页+即时判题连胜反馈」交付（`docs/迭代记录.md` 的 `2a178b7` 条目）。文件头注释标注对应「需求 §14：人物 ↔ 历史事件 ↔ 路线节点 三者关联」（`:5`）——人物的历史事件不单独建表，直接复用其关联节点的 `route_nodes.historical_time` 与 005 的事件卡字段（`:16` 注释）。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:25`）。

### 4.1 `persons`（`:9-14`）

| 列 | 类型/可空性 | 业务含义 |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY`（**无 SERIAL**） | 人物 id，种子显式指定 1–13；无管理端新增路径，新增靠 `max(id)+1`（`.qoder/PROJECT.md` §8「代码级技术债」第 27 项） |
| `name` | `VARCHAR(50) NOT NULL` | 人物姓名 |
| `avatar` | `VARCHAR(500)` 可空 | 头像；为空时前端展示姓名首字占位，**不伪造历史照片**（`:8` 注释） |
| `brief` | `TEXT` 可空 | 人物简介 |

字符串列可空遵循 Oracle 兼容模式约定（`''` 落库为 NULL，`:5-6` 注释）。

### 4.2 `person_nodes`（`:17-21`）

复合主键 `(person_id, node_id)`；两列均 NOT NULL 且带**真 FK**：`person_id REFERENCES persons(id)`、`node_id REFERENCES route_nodes(id)`。同一人物-节点组合唯一由 PK 保证。

### 4.3 索引（`:23`）

`idx_person_nodes_node ON person_nodes (node_id)`——支撑「按节点查人物」（node-detail 页反查）；按 person_id 查询由复合 PK 前导列覆盖。注意本索引前缀是 `idx_` 而全库其余索引为 `ix_`，命名不一致但功能无碍。

## 5. 输入与输出

- **输入（前置条件）**：001 已建 `route_nodes`（`person_nodes.node_id` 的 FK 目标）；本文件内部 `persons` 先于 `person_nodes` 创建（FK 顺序）。
- **输出**：2 张空表 + 1 个索引；数据由 seed.py 写入。
- **失败模式**：`route_nodes` 不存在时 FK 建表失败、事务回滚；重复执行安全（全部 IF NOT EXISTS）。

## 6. 依赖关系

- 依赖：`001_schema.sql`（`route_nodes`）。
- 被依赖：ORM `backend/app/models/models.py:61-78`（Person/PersonNode）；`backend/app/data/seed.py`（13 位人物种子）；小程序人物志页（`frontend/pages/person/`，P1-8 交付）；后端 person 路由/服务。

## 7. 业务规则

1. **幂等**：`CREATE TABLE IF NOT EXISTS`（§1.3 允许）+ `CREATE INDEX IF NOT EXISTS`，重跑无副作用。
2. **人物-事件-节点三元关联不建事件表**：人物相关历史事件即其关联节点的事件，历史时间读 `route_nodes.historical_time`（`:16` 注释）——避免多头真相。
3. **头像可空是内容纪律**：无可靠史料照片的人物保持 avatar 为 NULL，由前端做姓名首字占位（`:8`），不得填充 AI 生成/网图。
4. FK 为数据库级真约束：删除 `persons`/`route_nodes` 行前必须先清 `person_nodes` 关联（openGauss 无级联声明）。

## 8. 修改约束

1. **禁止修改本文件**（已在生产执行，`docker/init/SQL_CONSTRAINTS.md` §3.1）。
2. `persons.id` 无自增——若未来开放管理端新增人物，需先解决 id 分配并发保护（PROJECT.md §8 第 27 项），不得直接 INSERT 依赖数据库发号。
3. 表/列名与 ORM Person/PersonNode 是硬契约（`backend/AGENTS.md` §4.8「表结构单一来源」）。

## 9. 当前实现状态

- **已实现**：两表在用，人物志页已上线（P1-8）。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` §1）**：§1.1 不涉及（无 ALTER）；§1.2 **风险**：`:23` 使用 `CREATE INDEX IF NOT EXISTS`（默认按不支持处理，属早于约束文档的历史包袱，`.qoder/ARCHITECTURE.md` §12.4 未列 006）；§1.3 合规；§1.4 不涉及；§2.1 事务合规（`:1`/`:25`）；§2.2 幂等合规；§4 部分合规：有主题/目的/约定注释（`:3-6`）但缺「回滚」段。
- **与 ORM 的差异**：无——`models.py:61-78` 的 Person（id 无 autoincrement、avatar/brief 可空）与 PersonNode（复合 PK + 双 FK）与 DDL 完全一致。
- **回滚方式**：文件内无回滚语句。手工回滚 = `DROP TABLE person_nodes; DROP TABLE persons;`（先子后父）——销毁人物志数据（可由 seed.py 重建 13 位人物，但管理端后续编辑会丢失）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/006_persons.sql`，共 **1 个提交**。

### 2026-10-03（`2a178b7`，08:40）
- 需求：长征人物志与答题连胜效果（P1-8）。
- 修改内容（涉本文件）：创建本文件，新建 `persons`/`person_nodes` 两表与 `idx_person_nodes_node` 索引。
- 关联文件：`backend/app/models/models.py`、`backend/app/data/seed.py`、小程序人物志页、person 路由/服务。
- 测试结果：见 `docs/迭代记录.md` 的 `2a178b7` 条目。
