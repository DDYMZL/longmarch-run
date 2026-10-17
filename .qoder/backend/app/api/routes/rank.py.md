# rank.py

## 1. 文件路径

`backend/app/api/routes/rank.py`（29 行）

## 2. 文件职责

小程序排行榜域的 HTTP 路由层：全员工总积分榜（新版分页契约）与旧版步数榜契约。排序口径、top/分页切分、本人名次计算全部在 `rank_service`；本文件只做参数接收、鉴权依赖注入与透传。

## 3. 业务需求

- 全员跨组织总积分榜，「与管理端排名同一口径」（`rank.py:1` 模块 docstring；`backend/app/services/rank_service.py:1-6` docstring 同述）。
- V2.0 活动时间控制：榜单查询挂 `require_activity_view`，活动结束后按配置仍可只读查看（提交 `ce14a95`，2026-10-13）。
- 积分台账 V2.0 重构后榜单改按 `points_log` 台账积分排序（提交 `2f3f333`，2026-10-13，其提交信息含「新增积分概览/明细/总积分榜」）。

## 4. 核心功能

### 4.1 端点清单（2 个，与 `app.openapi()` 实测一致）

路由前缀 `/rank`（`rank.py:11`），经 `backend/app/main.py:80` 以 `/api` 前缀挂载。

| 方法 | 完整路径 | 函数名 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| GET | `/api/rank/points` | `points_rank` | `rank.py:14-22` | `require_activity_view` | `PointsRankOut`（`backend/app/schemas/schemas.py:836-845`） |
| GET | `/api/rank/steps` | `steps_rank` | `rank.py:25-28` | `require_activity_view` | `RankListOut`（`schemas.py:829-833`） |

查询参数（仅 `/points`）：`page` 默认 1、`ge=1`，语义为「第 11 名起的分页页码」（`rank.py:16`）；`page_size` 默认 20、`ge=1`、`le=50`（`rank.py:17`）。超限由 FastAPI 返回 422。

### 4.2 调用的 service 函数

| 路由 | service 调用 | 位置 |
|---|---|---|
| `points_rank` | `rank_service.get_points_rank` | `backend/app/services/rank_service.py:91-114` |
| `steps_rank` | `rank_service.get_steps_rank` | `rank_service.py:117-133` |

service 内部再调 `org_service.get_full_name_map` 批量取组织全路径名防 N+1（`rank_service.py:66-82` `_items`）。

### 4.3 排序与名次规则（规则位置，不复述实现）

- 排序键：总积分降序 → 累计步数降序 → `user_id` 升序，由窗口函数 `row_number().over(...)` 生成名次（`rank_service.py:40`，子查询 `ranked_users_subquery` `:20-45`）。**严格排序、无并列名次**：同分同步骤用户按 user_id 决定先后，各自名次唯一。
- 窗口函数依赖 openGauss 兼容层（`backend/app/core/database.py` monkey-patch，`.qoder/ARCHITECTURE.md` §12.5 引 `rank_service.py:40`）。
- `/points` 响应切分（`rank_service.py:91-114`）：`top` 恒为第 1-10 名（`ELITE_SIZE=10`，`:17`）；`list` 为第 11 名起按 page/page_size 分页，`has_more` 用 limit+1 探测（`:99`、`:112`）；`me` 恒返回本人条目（含本人真实名次，`:102`、`:109`）；`total` 为全用户数（`:105`）。
- `/steps` 旧版契约（`rank_service.py:117-133`）：`list` 为前 100 名（`TOP_LIMIT=100`，`:16`）+ 本人（若不在前 100），名次与总积分榜一致（`rank.py:27` docstring）。
- **不受组织范围过滤**：两榜均为全员跨组织榜，无任何 org_id 过滤条件。

### 4.4 事务边界

两个端点均为纯只读查询，service 内无 commit/flush；session 由 `Depends(get_db)` 注入并在请求结束时关闭（`rank.py:19`、`:26`）。

### 4.5 异常转换模式

无 try/except：service 不抛 `ValueError`，路由无转换逻辑。可能的错误全部来自依赖链（401/403）与参数校验（422）。

## 5. 输入与输出

- 输入：身份取自 JWT；`/points` 另收 `page`、`page_size` 查询参数（见 §4.1）。
- 输出（camelCase，`CamelModel`，`schemas.py:17-22`）：
  - `PointsRankOut`：`top[]` + `list[]` + `me` + `page`/`pageSize`/`hasMore`/`total`（`schemas.py:836-845`）。
  - `RankListOut`：`list[]` + `myRank` + `mySteps` + `total`（`schemas.py:829-833`）。
- 错误码：401（令牌无效/过期）；403（账号停用 `X-Account-Status: disabled`；活动不可见 `X-Activity-Status`，`backend/app/api/deps.py:46-81`）；422（page/page_size 越界）。无 400/404 路径。

## 6. 依赖关系

- **依赖模块**：`app.api.deps`、`app.core.database`、`app.models.models.User`、`app.schemas.schemas`（2 个模型）、`app.services.rank_service`（`rank.py:2-9`）。
- **service 层再依赖**：`points_service`（台账积分子查询）、`org_service.get_full_name_map`、`daily_sport` 步数聚合。
- **数据库表**：`points_log`（积分来源，只读）、`daily_sport`（步数，只读）、`users`/`orgs`（展示字段，只读）。
- **被谁依赖**：`backend/app/main.py:80` 注册；小程序 `frontend/services/rank.js:16` **只调 `/rank/points`**；`/api/rank/steps` 无小程序调用方，调用者为测试脚本（`backend/test/e2e_datasync.py:120`、`backend/test/e2e_full_flow.py:340`）；管理端排名走 admin 路由复用 `rank_service` 同一口径，不经本文件。`profile_service.get_summary` 也调 `rank_service.get_user_rank`（`backend/app/services/profile_service.py:165-168`），与本文件同一名次来源。

## 7. 业务规则

1. **单一口径**：小程序榜、管理端榜、`/profile/summary` 的排名同源 `rank_service`，改排序键三处同时生效。
2. **无并列名次**：`row_number()` 而非 `rank()/dense_rank()`（`rank_service.py:40`），同分用户名次不同。
3. **积分口径**：榜单积分＝`points_log` V2.0 台账（`source_type in (walk, quiz)`，legacy 行不计入），与 `GET /api/points` 的 `total` 同源。
4. **top 恒返**：`/points` 的 `top`（前 10）与 `me` 不受分页参数影响，任何 page 都返回。
5. **活动只读闸门**：view 档依赖——活动结束且 `allow_view_after_end` 开启时榜单仍可查（只读端点，无副作用风险）。

## 8. 修改约束

1. **事务边界：无 commit**——本文件与 `rank_service` 的榜单查询均只读，路由层不得引入写操作或 commit。
2. 排序表达式（`rank_service.py:40`）是管理端/小程序共同口径，改动需同时核对 admin 路由与 `profile_service` 的名次展示。
3. `page` 语义是「第 11 名起的页码」而非全榜页码（top 10 不参与分页，`rank.py:16`、`rank_service.py:99`），改分页逻辑时勿把 top 计入 offset。
4. `page_size` 上限 50 在路由层声明（`rank.py:17`），`TOP_LIMIT=100`/`ELITE_SIZE=10` 在 service 常量（`rank_service.py:16-17`），两处不要互相搬移。
5. `/rank/steps` 是旧版契约（`rank.py:25` summary「排行榜（旧版契约）」），仅测试脚本在用；下线前需先改 `backend/test/e2e_datasync.py:120`、`backend/test/e2e_full_flow.py:340`。

## 9. 当前实现状态

- **已实现**：2 个端点全部可用；分页、本人名次、组织全路径名展示齐备。
- **存在问题 / 已知不一致**：
  1. `/api/rank/steps` 无小程序调用方（仅测试脚本），属旧版契约遗留（`rank.py:25`），是否保留**待确认**。
  2. 同分用户无并列名次（`row_number`，`rank_service.py:40`）是现状设计；若产品要求并列需改窗口函数，**待确认**是否有此需求。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/rank.py`（3 个提交，2026-10-17 核对）。按时间倒序。

### 2026-10-13（`2f3f333`）

- 需求：积分台账 V2.0 重构（提交信息含「新增积分概览/明细/总积分榜」）。
- 修改内容：榜单积分来源改为 `points_log` 台账口径，新增 `GET /rank/points` 分页契约（top/list/me/page/hasMore），保留 `/rank/steps` 为旧版契约。
- 关联文件：`backend/app/services/rank_service.py`、`backend/app/schemas/schemas.py`、`backend/app/services/points_service.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-13（`ce14a95`）

- 需求：V2.0 活动时间控制。
- 修改内容：两个端点鉴权换为 `require_activity_view`。
- 关联文件：`backend/app/api/deps.py`、`backend/app/services/activity_service.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-09-30（`a94e685`）

- 需求：项目初始化。
- 修改内容：创建本文件（初始为步数榜）。
- 关联文件：仓库初始代码。
- 测试结果：`docs/迭代记录.md` 该条目未记载验证结果，待确认。
