# profile.py

## 1. 文件路径

`backend/app/api/routes/profile.py`（26 行）

## 2. 文件职责

小程序「我的」个人档案域的 HTTP 路由层：档案聚合页与长征足迹时间轴。六类数据聚合、画像五维计算全部在 `profile_service`；本文件只做鉴权依赖注入、limit 参数声明与 timeline 的 `{"items": ...}` 包装。

## 3. 业务需求

- 「我的」页一屏聚合用户信息/运动统计/答题统计/勋章/积分名次/画像五维（需求 §17，画像满分参照 `.qoder/ARCHITECTURE.md` §17.2/§17.3）。
- 长征足迹时间轴：按时间倒序展示用户行为事件（同步步数、点亮节点、答题、勋章解锁等）。
- 创建于提交 `18c2121`（2026-10-02），其提交信息：「新增 profile/summary、profile/timeline、sport/calendar、broadcast/today、quiz/knowledge 五个接口…S3 冒烟 15/15 通过（test/s3_aggregates.py + 验收报告）」。

## 4. 核心功能

### 4.1 端点清单（2 个，与 `app.openapi()` 实测一致）

路由前缀 `/profile`（`profile.py:11`），经 `backend/app/main.py:81` 以 `/api` 前缀挂载。

| 方法 | 完整路径 | 函数名 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| GET | `/api/profile/summary` | `summary` | `profile.py:14-16` | `require_activity_view` | `ProfileSummaryOut`（`backend/app/schemas/schemas.py:664-670`） |
| GET | `/api/profile/timeline` | `timeline` | `profile.py:19-25` | `require_activity_view` | `ProfileTimelineOut`（`schemas.py:680-681`） |

查询参数（仅 `/timeline`）：`limit` 默认 50、`ge=1`、`le=200`（`profile.py:21`），越界 422。

### 4.2 调用的 service 函数

| 路由 | service 调用 | 位置 |
|---|---|---|
| `summary` | `profile_service.get_summary`（传整个 `User` 对象） | `backend/app/services/profile_service.py:78-181` |
| `timeline` | `profile_service.get_timeline`，路由层包 `{"items": ...}`（`profile.py:25`） | `profile_service.py:184-201` |

### 4.3 `get_summary` 聚合的六类数据（`profile_service.py:78-181`）

1. **user**：昵称/头像/组织全路径名/`join_days`（注册当天为第 1 天，`_join_days` `:70-75`）。
2. **stats**：`daily_sport` 的打卡天数/总步数/总距离/单日最高（`:80-91`）+ `streak_service.compute_streaks` 连续天数（`:93`）+ `march_service.get_route` 派生路线进度/current_node/next_node（`:95-117`）。
3. **quiz**：`quiz_records` 聚合答题次数/正确率等，`full_score_count`＝score≥100 的次数（`:119-130`、`:125`）。
4. **medals**：`user_medals` 已获数 + `medal_defs` 总数（12，`:132-133`）。
5. **points**：`points_service.get_breakdown` + `rank_service.get_user_rank`（`:165-168`）——**与 `GET /api/points`、`GET /api/rank/points` 同源台账口径**（`ProfilePointsStats` docstring「与『我的』积分卡同源」，`schemas.py:646`）。
6. **portrait**：画像五维（`_portrait` `:31-67`），满分参照常量 `PORTRAIT_*_FULL=30/30/50`（`:26-28`）。

### 4.4 `get_timeline` 数据源

- **数据源是 `user_event` 表**（非各业务表拼接）：按 `event_time desc, id desc` 取 limit 条（`profile_service.py:184-201`），展示文案由 `event_service.build_text` 生成。
- 事件由各业务写路径经 `event_service.record` 落库（自带 commit），timeline 本身纯只读。

### 4.5 事务边界与异常转换

- 两个端点均只读，service 内无 commit；session 由 `Depends(get_db)` 注入（不变量 6）。
- 无 try/except：service 不抛 `ValueError`，路由无异常转换。错误仅来自依赖链（401/403）与参数校验（422）。

## 5. 输入与输出

- 输入：身份取自 JWT；`/timeline` 另收 `limit`。
- 输出（camelCase，`CamelModel`，`schemas.py:17-22`）：
  - `ProfileSummaryOut`：`user`/`stats`/`quiz`/`medals`/`points`/`portrait` 六段（`schemas.py:664-670`，子模型含 `ProfilePointsStats` `:646` 等）。
  - `ProfileTimelineOut`：`items[]`（事件条目，`schemas.py:680-681`）。
- 错误码：401（令牌无效）；403（账号停用 `X-Account-Status`；活动不可见 `X-Activity-Status`，`backend/app/api/deps.py:46-81`）；422（limit 越界）。无 400/404 路径。

## 6. 依赖关系

- **依赖模块**：`app.api.deps`、`app.core.database`、`app.models.models.User`、`app.schemas.schemas`（2 个模型）、`app.services.profile_service`（`profile.py:2-9`）。
- **service 层再依赖**：`streak_service`、`march_service.get_route`、`points_service.get_breakdown`、`rank_service.get_user_rank`、`org_service`（组织全路径名）、`event_service.build_text`。
- **数据库表**：`users`/`orgs`/`daily_sport`/`quiz_records`/`user_medals`/`medal_defs`/`points_log`/`lit_nodes`/`route_nodes`/`user_event`（全部只读）。
- **被谁依赖**：`backend/app/main.py:81` 注册；小程序 `frontend/services/profile.js:11`（summary）、`:21`（timeline）。

## 7. 业务规则

1. **同源口径**：积分与名次段直接复用 `points_service`/`rank_service`，禁止在 profile 内另行统计积分（不变量 5 的积分统一原则）。
2. **join_days 口径**：注册当天计为第 1 天（`profile_service.py:70-75`），非「满 24h 加一」。
3. **timeline 只反映已落 `user_event` 的行为**：新增业务事件类型需走 `event_service.record` 才会出现在足迹里。
4. **活动只读闸门**：view 档依赖，活动结束且允许查看时档案仍可访问。
5. **medal 总数**：summary 的 `medals.total` 取自 `medal_defs` 表实数（当前 12），不硬编码。

## 8. 修改约束

1. **事务边界：无 commit**——本文件与 `profile_service` 两个查询均只读，路由层不得引入写操作。
2. `get_summary` 传参是 **`User` 对象**（`profile.py:16`），`get_timeline` 传 `current.id`（`:25`），两者签名不同，改动时勿混。
3. `{"items": ...}` 包装在路由层（`profile.py:25`）而非 service 返回 dict，`ProfileTimelineOut` 依赖该键名。
4. 画像满分常量 `PORTRAIT_*_FULL`（`profile_service.py:26-28`）与前端进度条展示耦合，调整需同步 `frontend/pages/profile`。
5. summary 是单请求六段聚合，新增段注意 N+1（现有实现用批量/聚合查询），勿在循环内逐条查库。

## 9. 当前实现状态

- **已实现**：2 个端点全部可用；创建提交 `18c2121` 记载 S3 冒烟 15/15 通过（`backend/test/s3_aggregates.py`）。
- **存在问题 / 已知不一致**：无（未发现分层违规或口径偏差）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/profile.py`（2 个提交，2026-10-17 核对）。按时间倒序。

### 2026-10-13（`ce14a95`）

- 需求：V2.0 活动时间控制。
- 修改内容：两个端点鉴权换为 `require_activity_view`。
- 关联文件：`backend/app/api/deps.py`、`backend/app/services/activity_service.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-02（`18c2121`）

- 需求：「我的」档案聚合与长征足迹（S3 批次）。
- 修改内容：创建本文件，含 summary/timeline 两个端点。提交信息：「新增 profile/summary、profile/timeline、sport/calendar、broadcast/today、quiz/knowledge 五个接口…」。
- 关联文件：`backend/app/services/profile_service.py`、`backend/app/schemas/schemas.py`。
- 测试结果：S3 冒烟 15/15 通过（`backend/test/s3_aggregates.py` + 验收报告，据提交信息）。
