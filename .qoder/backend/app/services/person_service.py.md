# person_service.py

## 1. 文件路径
`backend/app/services/person_service.py`（共 52 行）

## 2. 文件职责
长征人物志服务：维护「人物 ↔ 历史事件（路线节点）」的关联查询，提供节点的相关人物列表与人物详情（含关联节点及其历史时间）。按 docstring（`backend/app/services/person_service.py:1-5`），不建知识图谱，仅依赖 `person_nodes` 一张关联表（需求 §14.4 本期范围）。

## 3. 业务需求
- 需求来源：需求文档 §14「长征人物志」（docstring :1 引用；§14.2 定义人物详情内容，§14.4 界定本期只维护关联表）。
- 业务场景一：小程序节点详情页展示「相关人物」入口（`backend/app/services/march_service.py:350` 在节点详情聚合中调用 `get_persons_by_node`）。
- 业务场景二：人物志页展示人物头像/名称/简介与其相关历史事件（节点）及历史时间，历史时间取自 `route_nodes.historical_time`（docstring :3）。

## 4. 核心功能
### 4.1 `get_persons_by_node(db, node_id) -> List[Dict]`（:13-22）
节点的相关人物列表：`persons` 表 join `person_nodes`（`PersonNode.person_id == Person.id`，:17），按 `node_id` 过滤（:18），按人物 id 升序（:19），只查 `Person.id`、`Person.name` 两列（:16），返回 `[{"id", "name"}]`（:22）。

### 4.2 `get_person_detail(db, person_id) -> Optional[Dict]`（:25-52）
人物详情（§14.2）：
1. 按主键查 `Person`，不存在返回 `None`（:27-29）；
2. join `person_nodes` 查该人物关联的 `RouteNode`，过滤 `RouteNode.is_enabled` 为真（:30-36），按 `sort_order` 升序、再按 id 升序排列（:34）；
3. 返回 dict：`id/name/avatar/brief` + `nodes` 数组，每个节点含 `id/name/icon/historical_time/brief`（:37-52）；`avatar`、`brief` 为 None 时以空串兜底（:40-41,48）。

## 5. 输入与输出
| 函数 | 输入 | 输出 |
| --- | --- | --- |
| `get_persons_by_node` | `db: Session`、`node_id: int` | `List[Dict]`，元素为 `{"id": int, "name": str}`；无关联人物返回空列表 |
| `get_person_detail` | `db: Session`、`person_id: int` | `Optional[Dict]`，结构见 §4.2；人物不存在返回 `None`（由路由转 404，见 `backend/app/api/routes/persons.py:17` 调用处） |

本文件不抛业务异常、不写库、不 commit——纯只读查询服务。

## 6. 依赖关系
- route → service → model 链路：
  - `backend/app/api/routes/persons.py:17` 调用 `get_person_detail`（人物详情接口）；
  - `backend/app/services/march_service.py:350` 调用 `get_persons_by_node`（节点详情聚合的 `persons` 字段）。
- import 依赖（:6-10）：仅模型 `Person`、`PersonNode`、`RouteNode`（`backend/app/models/models.py`），不依赖其他 service、schema 或 core 模块。
- 数据库表（只读）：`persons`、`person_nodes`、`route_nodes`。
- session 由调用方经 `Depends(get_db)` 传入，本服务不自建 session（`backend/AGENTS.md` §4 不变量 6）。

## 7. 业务规则
- 人物与历史事件的关联完全由 `person_nodes` 关联表驱动，服务内不做任何推断（docstring :3-4）。
- 人物详情只返回启用节点（`RouteNode.is_enabled.is_(True)`，:33），停用节点不出现在人物志页；节点列表展示顺序为 `sort_order` → `id`（:34），与行军路线顺序一致。
- `get_persons_by_node` 不过滤节点启用状态（:15-21）——按 node_id 直查关联，节点是否有效由调用方（节点详情链路）保证。
- 排序确定性：人物列表按 `Person.id` 升序（:19），保证多次请求结果稳定。

## 8. 修改约束
- 返回结构被前端人物志页与节点详情页消费，字段名是 camelCase 契约的组成部分（经 schemas 转换，`backend/AGENTS.md` §4 不变量 1）；新增字段需同步前端 `frontend/services/person.js`。
- 禁止在本服务内写库或 commit（当前为纯读服务，事务边界归调用方路由）。
- 若未来扩展知识图谱（超出 §14.4 本期范围），需先更新需求文档，不得直接在此文件加图谱逻辑。
- 人物、关联表数据结构变更需同步 `backend/app/models/models.py`、`backend/app/data/seed.py` 与 `docker/init/` 迁移 SQL（`backend/AGENTS.md` §6.3）。

## 9. 当前实现状态
### 已实现
- 节点相关人物列表查询，单条 join SQL、只取两列（:13-22）。
- 人物详情：基础信息 + 启用关联节点 + 历史时间，两次查询完成、无 N+1（:25-52）。
- 人物不存在返回 `None` 交由路由处理（:27-29）。

### 存在问题
- 代码内未发现缺陷标记；`get_person_detail` 对 `persons` 与关联节点分两次查询（:27,:30-36），数据量小（人物志为静态配置数据），当前无性能问题。

### 待开发
- 无代码内 TODO。需求 §14.4 明确本期不建知识图谱（docstring :4），图谱化属后续范围，具体规划待确认。

## 10. 迭代记录
数据来源：`git log --follow backend/app/services/person_service.py` 与 `docs/迭代记录.md` 对应条目。

### 2026-10-03（`2a178b7`，08:40）
- 需求：长征人物志与答题连胜效果（P1-8）。
- 修改内容：新建本文件（该提交为本文件唯一提交），实现 `get_persons_by_node` 与 `get_person_detail`；同批新增人物/关联表与小程序人物志页、即时判题连胜反馈。
- 关联文件：`backend/app/models/models.py`（Person/PersonNode）、`backend/app/api/routes/persons.py`、`backend/app/services/march_service.py`、`frontend/pages/person/`、`docker/init/` 迁移 SQL。
- 测试结果：待确认（`docs/迭代记录.md` 的 `2a178b7` 条目未记录验证结果）。
