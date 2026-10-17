# points.py

## 1. 文件路径

`backend/app/api/routes/points.py`（31 行）

## 2. 文件职责

小程序积分域的 HTTP 路由层：积分概览（总/步行/答题/今日/名次）与按自然日明细。台账计算全部在 `points_service`，名次在 `rank_service`；本文件只做鉴权依赖注入、分页参数声明与概览的 `rank` 字段合并。

## 3. 业务需求

- 积分台账 V2.0（提交 `2f3f333`，2026-10-13，提交信息「新增积分概览/明细/总积分榜…」）：`points_log` 每用户每来源每天一行，覆盖式重算幂等；本文件是台账的小程序读出口。
- 「我的」积分卡与积分明细页数据源；`total = walk + quiz` 全部由后端台账计算（`points.py:16` docstring），前端不做加法。
- V2.0 活动时间控制：挂 `require_activity_view`（提交 `ce14a95`）。

## 4. 核心功能

### 4.1 端点清单（**实测 2 个**，与 `app.openapi()`、`grep -c "@router\."` 一致；任务表记 1，见下方说明）

路由前缀 `/points`（`points.py:11`），经 `backend/app/main.py:77` 以 `/api` 前缀挂载。

| 方法 | 完整路径 | 函数名 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| GET | `/api/points` | `points` | `points.py:14-20` | `require_activity_view` | `PointsSummaryOut`（`backend/app/schemas/schemas.py:542-554`） |
| GET | `/api/points/daily` | `daily` | `points.py:23-30` | `require_activity_view` | `PointsDailyOut`（`schemas.py:567-569`） |

**端点数口径说明**：概览端点装饰器为 `@router.get("")`（空路径，`points.py:14`），生成 `/api/points`（无尾斜杠）。按路径前缀正则统计端点时容易漏掉该装饰器，疑为任务表/`.qoder/ARCHITECTURE.md` §2.2 记「1 个」的原因。三方证据确认实际为 2：① `app.openapi()` 实测存在 `/api/points` 与 `/api/points/daily` 两路径；② `grep -c "@router\."` 本文件计 2；③ 小程序两个都在用——`frontend/services/points.js:16` 调 `'/points'`、`:27` 调 `'/points/daily'`。

查询参数（仅 `/daily`）：`page` 默认 1、`ge=1`；`page_size` 默认 20、`ge=1`、`le=100`（`points.py:25-26`），越界 422。

### 4.2 调用的 service 函数

| 路由 | service 调用 | 位置 |
|---|---|---|
| `points` | `points_service.get_summary` + `rank_service.get_user_rank`，路由层合并 `{**summary, "rank": ...}`（`backend/app/api/routes/points.py:17-20`，纯响应组装，非业务规则） | `backend/app/services/points_service.py:186-204`；`backend/app/services/rank_service.py:85`（get_user_rank） |
| `daily` | `points_service.get_daily_details` | `points_service.py:215-262` |

### 4.3 两个端点的口径区别（任务重点）

- **`GET /api/points`（概览，汇总值）**：`get_summary`（`points_service.py:186-204`）返回 `total`/`walk`/`quiz` + 今日两项（`todayWalkPoints`/`todayQuizPoints`）+ `todaySteps`/`todayCorrect` + `walkCarry`（零头结转步数）+ `rules`（规则文案，`:207-212`）；路由再并入 `rank`（与排行榜同一名次函数）。
- **`GET /api/points/daily`（明细，按自然日一行）**：`get_daily_details`（`points_service.py:215-262`）每天一行 `walk`/`quiz`/`total`/`steps`/`correctCount`/`updatedAt`；**响应中的 `total` 是「有台账的天数」而非积分和**（`:220`、`:230`，分页 total 语义）；`source_type in (walk, quiz)` 过滤 legacy 行（`:217-218`），legacy 台账不计入。
- **三处同源**：`/api/points`、`/api/rank/points`、`/api/profile/summary` 的积分/名次全部读同一 `points_log` 台账（`points_subquery` `backend/app/services/points_service.py:149-163`、`get_breakdown` `backend/app/services/points_service.py:176-179`、`get_user_rank` `backend/app/services/rank_service.py:85`），改口径三处同时生效。

### 4.4 事务边界与异常转换

- 两个端点均只读，无 commit；session 由 `Depends(get_db)` 注入（不变量 6）。
- 无 try/except：service 不抛 `ValueError`，路由无异常转换。积分**写入**统一走 `points_service`（不变量 5），本文件不含任何写路径。

## 5. 输入与输出

- 输入：身份取自 JWT；`/daily` 另收 `page`、`page_size`。
- 输出（camelCase，`CamelModel`，`schemas.py:17-22`）：
  - `PointsSummaryOut`：`total`/`walk`/`quiz`/`todayWalkPoints`/`todayQuizPoints`/`todaySteps`/`todayCorrect`/`walkCarry`/`rules`/`rank`（`schemas.py:542-554`）。
  - `PointsDailyOut`：`list[]`（按日条目）+ `page`/`pageSize`/`total`（天数）（`schemas.py:567-569`）。
- 错误码：401（令牌无效）；403（账号停用 `X-Account-Status`；活动不可见 `X-Activity-Status`，`backend/app/api/deps.py:46-81`）；422（分页越界）。无 400/404 路径。

## 6. 依赖关系

- **依赖模块**：`app.api.deps`、`app.core.database`、`app.models.models.User`、`app.schemas.schemas`（2 个模型）、`app.services.points_service`、`app.services.rank_service`（`points.py:2-9`）。
- **数据库表**：`points_log`（台账，只读）、`daily_sport`（todaySteps，只读）、`quiz_records`（todayCorrect，只读）。
- **被谁依赖**：`backend/app/main.py:77` 注册；小程序 `frontend/services/points.js:16`（概览）、`:27`（明细）。

## 7. 业务规则

1. **台账唯一事实源**：所有积分数字出自 `points_log` V2.0 行（每用户每来源每天一行，`biz_key`=`walk:日期`/`quiz:日期`），legacy 行不计入。
2. **步行结余口径**：每 1000 步 1 分、零头结转（`walkCarry`，`backend/app/core/config.py:102`）；答题积分＝答对×2、上限 10（`config.py:103-104`）。公式实现在 `points_service`，本文件不复述。
3. **rank 同口径**：概览的 `rank` 与排行榜名次同函数（`rank_service.get_user_rank`），不允许两处各算一套。
4. **daily 的 `total` 是天数**：分页元数据语义（`points_service.py:220`、`:230`），前端展示勿当积分和。
5. **活动只读闸门**：view 档依赖，活动结束后按配置仍可查。

## 8. 修改约束

1. **事务边界：无 commit**——本文件只读；积分写路径在 `points_service.recompute_*`（由 sport/quiz 副作用链触发），不得在本路由加写操作。
2. `@router.get("")` 空路径写法（`points.py:14`）产生无尾斜杠的 `/api/points`，改成 `"/"` 会 307 重定向、破坏小程序请求，勿动。
3. 概览的 `rank` 合并在路由层（`points.py:17-20`）是响应组装；若下沉到 service 需同步改 `ProfileSummaryOut` 复用点，保持单一口径。
4. `page_size` 上限 100（`points.py:26`）与 rank 的 50（`backend/app/api/routes/rank.py:17`）是两套契约，勿互相搬移。
5. 新增积分来源类型时须同步 `get_daily_details` 的 `source_type` 白名单（`points_service.py:217-218`），否则新来源在明细页不可见。

## 9. 当前实现状态

- **已实现**：2 个端点全部可用，前端两页均在调用。
- **存在问题 / 已知不一致**：
  1. **端点数记载不一致**：任务表与 `.qoder/ARCHITECTURE.md` §2.2 记本文件「1 个端点」，实测为 2（`app.openapi()` + grep + 前端调用三方证据，见 §4.1）。疑因 `@router.get("")` 空路径被统计正则漏掉。ARCHITECTURE 该处**待确认**是否修订。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/points.py`（3 个提交，2026-10-17 核对）。按时间倒序。

### 2026-10-13（`2f3f333`）

- 需求：积分台账 V2.0 重构（提交信息「新增积分概览/明细/总积分榜…」）。
- 修改内容：概览/明细改读 `points_log` 台账口径（含 walkCarry、today 两项、按日明细分页）。
- 关联文件：`backend/app/services/points_service.py`、`backend/app/schemas/schemas.py`、`backend/app/api/routes/rank.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-13（`ce14a95`）

- 需求：V2.0 活动时间控制。
- 修改内容：两个端点鉴权换为 `require_activity_view`。
- 关联文件：`backend/app/api/deps.py`、`backend/app/services/activity_service.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-09-30（`a94e685`）

- 需求：项目初始化。
- 修改内容：创建本文件。
- 关联文件：仓库初始代码。
- 测试结果：`docs/迭代记录.md` 该条目未记载验证结果，待确认。
