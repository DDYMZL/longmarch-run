# persons.py

## 1. 文件路径

`backend/app/api/routes/persons.py`（21 行）

## 2. 文件职责

小程序「长征人物志」域的 HTTP 路由层：人物详情单端点。数据组装在 `person_service`；本文件只做鉴权注入与 404 转换（service 返回 `None` → `HTTPException 404`）。

## 3. 业务需求

- 长征人物志（需求 §14，`persons.py:1` 模块 docstring）：人物头像/名称/简介 + 相关历史事件（路线节点）与历史时间（`persons.py:16` docstring）。
- 设计上**不建知识图谱**，仅维护 `person_nodes` 一张关联表（§14.4，`backend/app/services/person_service.py:1-5` docstring）。
- 人物入口在节点详情：`march_service.get_node_detail` 返回该节点关联人物列表（`backend/app/services/march_service.py:350` → `person_service.get_persons_by_node` `person_service.py:13-22`），用户点击后进入本端点看详情。
- 创建于提交 `2a178b7`（2026-10-03，「长征人物志与答题连胜效果（P1-8）——人物/关联表+人物志页+即时判题连胜反馈」），创建即现形态。

## 4. 核心功能

### 4.1 端点清单（1 个，与 `app.openapi()` 实测一致）

路由前缀 `/persons`（`persons.py:11`），经 `backend/app/main.py:82` 以 `/api` 前缀挂载。

| 方法 | 完整路径 | 函数名 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| GET | `/api/persons/{person_id}` | `detail` | `persons.py:14-20` | `get_current_user`（**仅登录，无活动闸门**） | `PersonDetailOut`（`backend/app/schemas/schemas.py:320-327`） |

路径参数：`person_id: int`（`persons.py:15`）——非整数由 FastAPI 返回 422；查无此人返回 404「人物不存在」（`persons.py:18-19`）。

### 4.2 调用的 service 函数

| 路由 | service 调用 | 位置 |
|---|---|---|
| `detail` | `person_service.get_person_detail` | `backend/app/services/person_service.py:25-52` |

`get_person_detail` 组装：`persons` 表主记录 + 经 `person_nodes` 关联的**启用**路线节点（`route_nodes.is_enabled` 过滤，按 `sort_order`/`id` 排序），返回 `id/name/avatar/brief/nodes[]`（节点含 `id/name/icon/historicalTime/brief`）。

### 4.3 事务边界与异常转换

- 只读端点，service 无 commit；session 由 `Depends(get_db)` 注入（不变量 6）。
- 异常转换模式：service 返回 `None` → 路由层 `HTTPException(404)`（`persons.py:18-19`）；本文件无 `ValueError`→400 路径。

### 4.4 鉴权档位说明

本端点挂 `get_current_user` 而非 `require_activity_view`（`persons.py:15`）：人物志是静态百科内容，不含用户业务数据，活动结束后仍可查阅。与同批 `quotes.py` 一致，属静态内容域的既定档位选择（是否需统一到 view 档见 §9）。

## 5. 输入与输出

- 输入：路径参数 `person_id`（int）；身份取自 JWT（仅用于鉴权，不影响返回内容——人物详情对所有用户相同）。
- 输出（camelCase，`CamelModel`，`schemas.py:17-22`）：`PersonDetailOut`＝`id/name/avatar/brief/nodes[]`（`schemas.py:320-327`）。
- 错误码：401（令牌无效）；403（账号停用 `X-Account-Status: disabled`，`backend/app/api/deps.py:17-53`）；404（人物不存在）；422（person_id 非整数）。

## 6. 依赖关系

- **依赖模块**：`app.api.deps`、`app.core.database`、`app.models.models.User`、`app.schemas.schemas`（1 个模型）、`app.services.person_service`（`persons.py:2-9`）。
- **数据库表**：`persons`（只读）、`person_nodes`（关联表，只读）、`route_nodes`（只读，is_enabled 过滤）。
- **被谁依赖**：`backend/app/main.py:82` 注册；小程序 `frontend/services/person.js:12`（`'/persons/' + id`）；人物列表入口在节点详情（`march_service.py:350`，不经本文件）。
- **种子数据**：13 位人物（`.qoder/ARCHITECTURE.md` §13.3，`backend/app/data/seed.py` 写入）。

## 7. 业务规则

1. **只展详情不展列表**：本域无 `/persons` 列表端点，人物列表仅随节点详情下发（`person_service.get_persons_by_node`），产品路径为「节点 → 人物 → 详情」。
2. **节点关联过滤**：详情里的 `nodes[]` 只含启用节点（`is_enabled`），禁用节点即使在 `person_nodes` 有关联也不下发。
3. **无知识图谱**：人物-节点关系仅一张 `person_nodes` 关联表，不引入图结构（§14.4）。
4. **静态内容**：详情与用户无关、与活动状态无关，登录即可读。

## 8. 修改约束

1. **事务边界：无 commit**——本文件与 `person_service` 查询均只读，路由层不得引入写操作。
2. `person_id` 是数据库自增 int 主键（非字符串 slug），前端 `frontend/services/person.js:12` 直接拼 URL，改主键形态属破坏性变更。
3. 404 转换在路由层（`persons.py:18-19`），若改为 service 抛 `ValueError` 需同步换异常转换模式，保持全项目「route 层 ValueError→HTTPException」约定（`backend/AGENTS.md` §3.1）。
4. 新增人物走 `seed.py` 种子 + `person_nodes` 关联，勿在路由/service 里加写接口（管理侧暂无维护界面）。

## 9. 当前实现状态

- **已实现**：1 个端点可用；创建提交 `2a178b7`（2026-10-03）即现形态，此后无改动。
- **存在问题 / 已知不一致**：
  1. 鉴权档位为 `get_current_user`（无活动闸门），与多数业务端点的 view 档不同；因属静态百科内容，现状可接受，是否需要统一**待确认**。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/persons.py`（仅 1 个提交，2026-10-17 核对）。

### 2026-10-03（`2a178b7`）

- 需求：P1-8 长征人物志与答题连胜效果（需求 §14）。
- 修改内容：创建本文件（人物详情端点），创建即现形态。提交信息：「长征人物志与答题连胜效果（P1-8）——人物/关联表+人物志页+即时判题连胜反馈」。
- 关联文件：`backend/app/services/person_service.py`、`backend/app/models/models.py`（persons/person_nodes 表）、`backend/app/data/seed.py`、`frontend/pages` 人物志页。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。
