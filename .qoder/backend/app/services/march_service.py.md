# march_service.py

## 1. 文件路径

`backend/app/services/march_service.py`（434 行）

## 2. 文件职责

长征路线服务层（自前端 `frontend/services/march.js` Mock 迁移而来，见模块 docstring `backend/app/services/march_service.py:1`）。承载「沿长征路线行进」核心玩法的全部业务规则：按累计步数计算节点点亮状态与路线进度、章节系统、全员共同目标、我的足迹、节点详情，以及点亮落库与事件写入。路由层 `backend/app/api/routes/march.py` 只做参数接收与调用，业务规则全部在本文件（符合 `backend/AGENTS.md` §3.1 分层约定）。

## 3. 业务需求

- 核心玩法：用户每日步数累计推进其在 10 个长征路线节点上的位置，达标即点亮节点（点亮永久保留），对应模块 docstring 的状态规则（`backend/app/services/march_service.py:3-6`）。
- 章节系统（代码注释标注为「需求 §4」，`backend/app/services/march_service.py:8-10`）：10 节点划分 5 章，章节最后节点点亮写 `CHAPTER_COMPLETE` 事件。
- 全员共同长征目标（注释标注「需求 §11」，`backend/app/services/march_service.py:46-47`）：全员累计步数对 2 亿步总目标的进度与里程碑。
- 我的长征足迹（注释标注「需求 §7」，`backend/app/services/march_service.py:274`）：点亮日期 + 当日步数 + 点亮时累计步数快照。
- 完成仪式（注释标注「需求 §20.4」，`backend/app/services/march_service.py:204`）：全部点亮且未观看过仪式时下发 `ceremony_pending`，仅首次触发完整动画。
- 需求原始文档在 `docs/长征步迹V*`（见 `.qoder/README.md` §6 说明）；本文引用的 §编号均以源码注释为准，未逐条核对原始需求文档（待确认）。

## 4. 核心功能

行号均指 `backend/app/services/march_service.py`。

- **模块级配置**
  - `CHAPTERS`（:23-44）：5 章 × 每章 2 个 `node_ids`（对应 `route_nodes` 主键），含 `name/title/intro`；调整章节划分只改此配置。
  - `GLOBAL_GOAL_STEPS = 200_000_000`（:48）、`GLOBAL_MILESTONES`（:49-54，5000万/1亿/1.5亿/2亿四档）。
- **私有查询/计算辅助**
  - `_lit_node_ids(db, user_id)`（:57-59）：查 `lit_nodes` 得该用户已点亮节点 id 集合。
  - `_ordered_nodes(db)`（:62-68）：启用节点按 `sort_order, id` 升序（个人/组织路线共用）。
  - `_chapter_views(nodes)`（:76-110）：由节点状态计算章节视图；状态 `COMPLETED`（全点亮）/`ACTIVE`（第一个未完成章）/`LOCKED`（其后各章）；节点全部停用的章节跳过不下发（:85-87）；返回 `(views, current_chapter_id)`。
  - `_completed_chapters(lit_ids, enabled_ids)`（:113-120）：返回指定点亮集合下已完成的章节配置。
  - `_route_state(nodes_def, lit, current_steps)`（:123-187）：核心纯计算——节点状态列表（`completed/current/unlocked`，:133-137）、`lit_count/total_count/finished/next_node`（:153-157），以及行军轨迹进度 `route_progress`（累计/终点目标，封顶 1.0，:163-165）、`current_node_id`（下一站，全程完成为 None）、`current_progress`（本段内进度，跨度 0 时取 1，:166-175）。
- **对外服务函数**
  - `get_route_nodes(db)`（:71-73）：启用节点配置列表。
  - `get_route(db, user_id)`（:190-225）：查启用节点 + `sport_service.get_total_steps` 累计步数 + 已点亮集合；**步数达标即视为点亮（内存合并，永久保留、步数下降不取消，:196-199）**；调 `_route_state` 与 `_chapter_views`；`finished` 且 `users.route_ceremony_at` 为空时置 `ceremony_pending=True`（仅此场景查一次 users，:204-209）。
  - `mark_ceremony_seen(db, user_id)`（:228-234）：幂等标记仪式已观看——用户不存在或已标记直接返回（:231-232），否则写 `route_ceremony_at = datetime.utcnow()` 并 `db.commit()`（:233-234）。
  - `get_global_goal(db)`（:237-270）：全员累计步数 = 全表 `SUM(daily_sport.steps)`（`func.coalesce` 防 NULL，:244-246）；里程碑 `reached` 实时计算（:247-250）；`progress_pct` 保留 1 位小数封顶 100（:255-259）；`next_milestone` 为第一个未达成档（:251, :261-269）。§11.3 的解锁内容/全局动画等奖励钩子明确标注为后续增强（:241-242）。
  - `get_footprints(db, user_id)`（:273-317）：`lit_nodes JOIN route_nodes`（仅启用节点，按路线序，:281-287）；点亮日期集合二次查 `daily_sport` 当日步数（避免逐节点 N+1，:293-302）；每节点输出 `lit_at/lit_date`（UTC 转本地日期，用 `to_local`，:291, :305）、`day_steps`、`cum_steps`（`step_snapshot`，历史回填为 0 由前端判空，:314）。
  - `get_node_detail(db, user_id, node_id)`（:320-351）：内部调 `get_route` 取状态与剩余步数（:322, :330, :338-340）；节点不存在或停用返回 `None`（:323-329）；任意状态节点均可查看（:321）；附带历史事件卡字段 `brief/significance/figures/location/images/audio/keywords`（:343-349）与 `persons`（`person_service.get_persons_by_node`，:350）。
  - `light_up_nodes(db, user_id)`（:354-434）：**唯一写 `lit_nodes` 的入口**。按累计步数找出达标且未点亮节点，逐个 `db.add(LitNode(step_snapshot=current_steps))`（:373-392）；无新点亮提前返回 `([], [])`（:394-395）；`db.commit()` 落库（:397）；提交后为每个新点亮节点补 `gained_points=0`（V2.0 起起点亮/完成路线不再发放积分，:355, :406）、`lit_at`、`next_node`（本次操作后第一个未达标节点的名称与剩余步数，全部点亮为 None，:398-408）；随后逐个写 `NODE_UNLOCK` 事件（:409-415）、全部点亮时写 `COMPLETE_ROUTE`（:416-417）、对比点亮前后完成集写新完成章节的 `CHAPTER_COMPLETE` 事件并返回章节仪式数据（:369, :419-432）。返回 `(newly, new_chapters)`。

## 5. 输入与输出

路由层契约见 `backend/app/api/routes/march.py`；响应模型（`CamelModel`，输出 camelCase）定义于 `backend/app/schemas/schemas.py`：`RouteNodeConfigListOut`（:222）、`RouteOut`（:262）、`NodeDetailOut`（:288）、`LightUpResult`（:362）、`GlobalGoalOut`（:384）、`FootprintsOut`（:406）。

| HTTP | 路径 | 权限依赖 | response_model | service 调用 |
| --- | --- | --- | --- | --- |
| GET | `/api/march/route-nodes` | `require_activity_view` | `RouteNodeConfigListOut` | `get_route_nodes`（`backend/app/api/routes/march.py:22-30`） |
| GET | `/api/march/route` | `require_activity_view` | `RouteOut` | `get_route`（`backend/app/api/routes/march.py:33-35`） |
| GET | `/api/march/global` | `require_activity_view` | `GlobalGoalOut` | `get_global_goal`（`backend/app/api/routes/march.py:38-43`） |
| GET | `/api/march/footprints` | `require_activity_view` | `FootprintsOut` | `get_footprints`（`backend/app/api/routes/march.py:46-51`） |
| GET | `/api/march/node/{node_id}` | `require_activity_view` | `NodeDetailOut` | `get_node_detail`，返回 None 时路由抛 404「节点不存在」（`backend/app/api/routes/march.py:54-64`） |
| POST | `/api/march/light-up` | `require_activity_participation` | `LightUpResult` | `light_up_nodes` + `medal_service.check_and_grant` + WS 广播（`backend/app/api/routes/march.py:67-73`） |
| POST | `/api/march/ceremony` | `require_activity_view` | **无**（唯一没有 response_model 的 march 端点），返回裸 `{"ok": True}`（`backend/app/api/routes/march.py:76-81`） | `mark_ceremony_seen` |

主要返回结构（Python 侧 dict，经 schema 转 camelCase）：

- `get_route`（:211-225）：`nodes[{id,name,icon,target_steps,status,remain,historical_time,description,latitude,longitude}]`（节点字段构造见 :138-151）、`current_steps/total_steps/lit_count/total_count/next_node/finished/current_node_id/current_progress/route_progress/chapters/current_chapter_id/ceremony_pending`。
- `get_global_goal`（:252-270）：`total_steps/target_steps/progress_pct/milestones[{name,steps,reached}]/next_milestone{name,steps,remain}|None`。
- `get_footprints`（:303-317）：`nodes[{id,name,icon,lit_at,lit_date,day_steps,cum_steps}]`。
- `light_up_nodes`（:379-392, :405-408, :430-432）：`(newly[{...,gained_points,lit_at,next_node{name,remain}|None}], new_chapters[{id,name,title,intro}])`；路由包装为 `{newly_lit, newly_completed_chapters, new_medals}`（`backend/app/api/routes/march.py:73`）。
- 异常：本文件不主动抛业务异常（无 `raise`/`ValueError`）；`get_node_detail` 以返回 `None` 表达「节点不存在」，由路由转 404。

## 6. 依赖关系

- **import**（`backend/app/services/march_service.py:12-20`）：`app.core.helpers.to_local`（UTC→本地日期）；ORM 模型 `DailySport/LitNode/RouteNode/User`；服务 `event_service/person_service/sport_service`。
- **调用的服务**：`sport_service.get_total_steps`（`backend/app/services/sport_service.py:31`，累计步数唯一口径）；`event_service.record`（`backend/app/services/event_service.py:106-129`，写 `user_event` 并**自行 commit**（:120-121）、WS 广播管理端动态）；`person_service.get_persons_by_node`（`backend/app/services/person_service.py:13`）。
- **数据库表**：`route_nodes`（`backend/app/models/models.py:32`）、`lit_nodes`（`backend/app/models/models.py:255-268`，`uq_lit_user_node` 唯一约束 :262，`lit_at` :267、`step_snapshot` :268）、`users.route_ceremony_at`（`backend/app/models/models.py:201`）、`daily_sport`、`user_event`（经 event_service）。
- **被谁依赖**：
  - 路由 `backend/app/api/routes/march.py`（全部 7 个端点，见 §5 表）。
  - `backend/app/services/profile_service.py:95` 与 `backend/app/services/broadcast_service.py:78` 调 `get_route`（档案聚合/播报）。
  - `backend/app/services/org_service.py:254-256` 跨服务复用**私有函数** `_ordered_nodes` 与 `_route_state`（组织共同长征按步数现算、无持久点亮）。
- **事务边界**：session 一律来自路由 `Depends(get_db)`（不变量 6）；本文件两处 commit——`mark_ceremony_seen:234`、`light_up_nodes:397`；`light_up_nodes` 中事件写入在 :397 commit **之后**，由 `event_service.record` 各自独立 commit（非同一事务）。

## 7. 业务规则

1. **节点状态三态**（:3-6, :133-137）：`completed`（在点亮集合中）；`current`（无上一节点，或累计步数 ≥ 上一节点 `target_steps`）；`unlocked`（未达上一节点）。
2. **点亮永久保留**：`get_route` 中步数达标即并入 lit 集合，即使步数下降也不取消（:196-199）；持久化仅发生在 `light_up_nodes` 写 `LitNode`（:373-397），因此 `lit_nodes` 只在用户调用 `POST /march/light-up` 后新增。
3. **V2.0 积分规则**：起点亮/完成路线不再发放积分，`gained_points` 恒为 0（:355, :406），且本文件不触碰 `points_service`/`PointsLog`（积分台账重构见 §10 `2f3f333`）。
4. **章节规则**（:76-120）：章内**启用**节点全点亮即完成（停用节点不计入分母，:85, :117-118）；全部停用的章节不下发（:86-87）；`CHAPTER_COMPLETE` 仅对本次新完成的章节写入（前后完成集对比，:369, :421-423），不改变节点点亮逻辑（:363）。
5. **完成仪式幂等**：`ceremony_pending` 仅在 `finished` 且 `route_ceremony_at IS NULL` 时为 True（:206-209）；`mark_ceremony_seen` 重复调用无副作用（:231-232）。
6. **事件链**：`light_up_nodes` 写 `NODE_UNLOCK`（每节点一条，含 `nodeId/nodeName/stepSnapshot`，:409-415）、`COMPLETE_ROUTE`（`len(lit) >= len(nodes_def)` 时，:416-417）、`CHAPTER_COMPLETE`（:424-429）；事件同时用于「我的足迹/管理端动态」同源展示（:361-362）。
7. **全员目标口径**：全员累计 = 全部用户 `daily_sport.steps` 之和（按用户+日期覆盖存储，无重复统计，:240-241）；里程碑达成实时计算、不落库（:247-250）。
8. **足迹口径**：`lit_date` 为本地日期（与 `DailySport.date` 同口径，`lit_at` 按 UTC 存储转本地，:277-279）；`cum_steps` 取点亮时刻快照，历史回填数据为 0 由前端判空（:278-279, :314）。
9. **进度计算统一在后端**：`route_progress/current_node_id/current_progress` 由 `_route_state` 计算，小程序只负责表现（:159-162）。
10. **并发**：`lit_nodes` 的 `(user_id, node_id)` 唯一约束（`backend/app/models/models.py:262`）兜底重复点亮；本文件未捕获 `IntegrityError`。

## 8. 修改约束

- **不变量 5 副作用链**（`backend/AGENTS.md` §4.5）：`POST /march/light-up` 属「影响点亮」的操作，路由调用后必须触发 `medal_service.check_and_grant`（现于 `backend/app/api/routes/march.py:71`）；如未来恢复点亮积分，必须走 `points_service`，禁止直接写 `PointsLog`。
- **不变量 1 camelCase 契约**（`backend/AGENTS.md` §4.1）：本文件返回 snake_case dict，由 `RouteOut` 等 `CamelModel` 转 camelCase；增删字段必须同步 `backend/app/schemas/schemas.py` 与前端 `frontend/services/march.js` 消费结构，否则视为破坏性变更。
- **不变量 6 会话来源**（`backend/AGENTS.md` §4.6）：禁止在本文件内自建 session；commit 责任见 §6 事务边界。
- `_route_state` 的入参约定（lit 集合由调用方构造、组织路线现算无持久点亮，:126-129）被 `backend/app/services/org_service.py:254-256` 依赖，改签名/语义会连带破坏组织共同长征。
- `CHAPTERS.node_ids` 对应 `route_nodes` 主键（:22）；种子路线为 10 节点（`backend/app/data/seed.py`），改章节划分需与节点数据同步。
- 点亮「永久保留、步数下降不取消」是与前端 Mock 一致的规则（`backend/AGENTS.md` §4.4），不得单边变更。
- `get_footprints` 不新增冗余存储、数据源限定 `lit_nodes + daily_sport`（:276-277），扩展足迹字段时优先复用现有表。

## 9. 当前实现状态

### 已实现

- 节点状态/路线进度/行军轨迹进度统一后端计算（:123-187），个人路线 `get_route`（:190-225）。
- 章节系统：配置、章节视图、当前章节、`CHAPTER_COMPLETE` 事件与仪式数据返回（:23-44, :76-120, :419-432）。
- 点亮落库（含 `step_snapshot`）、`NODE_UNLOCK`/`COMPLETE_ROUTE` 事件、下一站信息（:354-434）。
- 全员共同目标进度与里程碑（:237-270）。
- 我的长征足迹（点亮日期/当日步数/累计快照，:273-317）。
- 节点详情（任意状态可看，含历史事件卡与人物志入口，:320-351）。
- 完成仪式标记：`ceremony_pending` 下发（:204-209）与幂等标记（:228-234）。

### 存在问题

- `POST /api/march/ceremony` 无 `response_model`，直接返回裸 `{"ok": True}`（`backend/app/api/routes/march.py:76-81`），是 march 域唯一违反 `backend/AGENTS.md` §3.1「所有响应必须声明 response_model、禁止裸 dict」的端点（已在源码逐行核实）。
- `get_node_detail` 每次调用都完整重算 `get_route`（:322），包含累计步数、点亮集合、章节视图与仪式判断；单节点详情场景存在冗余计算（10 节点规模下影响有限，属性能注意点而非缺陷）。
- `light_up_nodes` 的点亮落库（:397 commit）与事件写入（`event_service.record` 内部各自 commit，`backend/app/services/event_service.py:120-121`）不在同一事务：若事件写入失败，点亮已提交而事件缺失；并发重复点亮依赖 `uq_lit_user_node` 唯一约束兜底但代码未捕获 `IntegrityError`（:373-397），冲突时将抛未处理异常。
- `org_service` 跨模块调用本文件私有函数 `_ordered_nodes/_route_state`（`backend/app/services/org_service.py:254-256`），私有约定被打破，重构时需同步。

### 待开发

- 章节配置的管理端可视化编辑（源码注释标注「后续增强」，:9, :47）。
- 全员目标 §11.3 的里程碑解锁内容/全局动画/系统动态等奖励钩子（源码注释标注「需系统级事件通道，不在本期」，:241-242）。

## 10. 迭代记录

数据来源：`git log --follow -- backend/app/services/march_service.py` 与 `docs/迭代记录.md` 对应提交条目（按提交号引用，不引行号）。

### 2026-10-15（`6913b00`，13:40）
- 需求：节点详情页小地图因接口缺经纬度落到默认海域（蓝屏缺陷）。
- 修改内容：`get_node_detail` 返回补充 `latitude/longitude`（+2 行，现 :341-342）；`NodeDetailOut` 同步扩展；前端按节点 ID 从 `/march/route` 回退补齐。
- 关联文件：`backend/app/schemas/schemas.py`、`frontend/services/march.js`、`frontend/pages/node-detail/*`。
- 测试结果：后端坐标契约 2/2、前端 4/4、S5 页面回归 11/11 通过（`docs/迭代记录.md` 的 `6913b00` 条目；报告 `backend/test/docs/node-detail-map-fix-report.md`）。

### 2026-10-13（`2f3f333`，11:25）
- 需求：积分台账重构（V2.0），总积分=步行+答题，移除点亮/里程碑等积分。
- 修改内容：本文件 +4/-6——`light_up_nodes` 移除积分发放，`gained_points` 恒为 0（:355, :406）。
- 关联文件：`backend/app/services/points_service.py`、`docker/init/017_points_ledger.sql` 等。
- 测试结果：SQLite 冒烟 20/20、openGauss 迁移回填核对差异 0、回归 s11/s18/s19/s6 通过（`docs/迭代记录.md` 的 `2f3f333` 条目）。

### 2026-10-11（`f59892e`，11:53）
- 需求：热点查询 SQL 聚合化与去 N+1（S14）。
- 修改内容：本文件 +3/-8——删除重复的 `_total_steps`，统一复用 `sport_service.get_total_steps`（:193, :365）。
- 关联文件：`backend/app/services/sport_service.py`、`docker/init/012_perf_indexes.sql`。
- 测试结果：见报告 `backend/test/docs/s14-hotspot-sql-report.md`（`docs/迭代记录.md` 的 `f59892e` 条目未列逐条验证结果，待确认）。

### 2026-10-04（`79004f1`，01:13）
- 需求：区域氛围与长征完成仪式（P2-2）。
- 修改内容：本文件 +19/-1——新增 `mark_ceremony_seen`（:228-234）与 `get_route` 的 `ceremony_pending` 判定（:204-209）。
- 关联文件：`backend/app/api/routes/march.py`、`backend/app/models/models.py`（`route_ceremony_at`）、`frontend/pages/ceremony/*`。
- 测试结果：见报告 `backend/test/docs/p2-ceremony-report.md`（`docs/迭代记录.md` 的 `79004f1` 条目仅一句内容摘要，详细验证待确认）。

### 2026-10-03（`2a178b7`，08:40）
- 需求：长征人物志与答题连胜效果（P1-8）。
- 修改内容：本文件 +2/-1——`get_node_detail` 返回新增 `persons`（`person_service.get_persons_by_node`，:350）。
- 关联文件：`backend/app/services/person_service.py`、`backend/app/schemas/schemas.py`、`frontend/pages/person/*`。
- 测试结果：见报告 `backend/test/docs/p1-persons-report.md`（`docs/迭代记录.md` 的 `2a178b7` 条目仅一句内容摘要，详细验证待确认）。

### 2026-10-03（`ffd2570`，02:35）
- 需求：我的长征足迹地图（P1-6，需求 §7）。
- 修改内容：本文件 +48——新增 `get_footprints`（:273-317）。
- 关联文件：`backend/app/api/routes/march.py`、`backend/app/schemas/schemas.py`（`FootprintsOut`）、`frontend/pages/profile/*`。
- 测试结果：见报告 `backend/test/docs/p1-footprints-report.md`（`docs/迭代记录.md` 的 `ffd2570` 条目仅一句内容摘要，详细验证待确认）。

### 2026-10-03（`c92598c`，02:02）
- 需求：全员共同长征目标（P1-4，需求 §11）。
- 修改内容：本文件 +47——新增 `GLOBAL_GOAL_STEPS/GLOBAL_MILESTONES`（:48-54）与 `get_global_goal`（:237-270）。
- 关联文件：`backend/app/api/routes/march.py`、`backend/app/schemas/schemas.py`（`GlobalGoalOut`）、`frontend/pages/home/*`。
- 测试结果：见报告 `backend/test/docs/p1-global-goal-report.md`（`docs/迭代记录.md` 的 `c92598c` 条目仅一句内容摘要，详细验证待确认）。

### 2026-10-03（`b4a8910`，01:42）
- 需求：组织共同长征目标（P1-3）。
- 修改内容：本文件 +36/-14——抽出 `_ordered_nodes/_route_state` 供组织路线复用（:62-68, :123-187）。
- 关联文件：`backend/app/services/org_service.py`、`backend/app/api/routes/org.py`、`frontend/pages/home/*`。
- 测试结果：见报告 `backend/test/docs/p1-org-march-report.md`（`docs/迭代记录.md` 的 `b4a8910` 条目仅一句内容摘要，详细验证待确认）。

### 2026-10-02（`6a2fae3`，23:07）
- 需求：长征章节系统（P0-3，需求 §4）。
- 修改内容：本文件 +131/-30——新增 `CHAPTERS` 配置（:23-44）、`_chapter_views/_completed_chapters`（:76-120），`get_route` 下发 `chapters/current_chapter_id`（:222-223），`light_up_nodes` 写 `CHAPTER_COMPLETE` 并返回新完成章节（:419-434）。
- 关联文件：`backend/app/api/routes/march.py`、`backend/app/schemas/schemas.py`、`frontend/pages/march/*`。
- 测试结果：见报告 `backend/test/docs/p0-chapters-report.md`（`docs/迭代记录.md` 的 `6a2fae3` 条目仅一句内容摘要，详细验证待确认）。

### 2026-10-02（`05180c2`，21:03）
- 需求：行军轨迹进度改由后端统一计算（P0-1，文档 §3.6）。
- 修改内容：本文件 +21——`_route_state` 新增 `route_progress/current_node_id/current_progress`（:159-175）。
- 关联文件：`backend/app/schemas/schemas.py`、`frontend/pages/march/*`（步数刷新改增量动画）。
- 测试结果：见报告 `backend/test/docs/p0-route-progress-report.md`（`docs/迭代记录.md` 的 `05180c2` 条目仅一句内容摘要，详细验证待确认）。

### 2026-10-02（`18c2121`，00:12）
- 需求：新增小程序聚合接口（档案/足迹/日历/播报/知识画像）并扩展现有契约。
- 修改内容：本文件 +25/-2（档案/播报聚合复用 `get_route`；具体字段扩展明细待确认，可查 `git show 18c2121 -- backend/app/services/march_service.py`）。
- 关联文件：`backend/app/services/profile_service.py`、`backend/app/services/broadcast_service.py`、`backend/app/api/routes/profile.py`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `18c2121` 条目仅一句内容摘要）。

### 2026-10-01（`be7e126`，23:39）
- 需求：统一事件系统与连续行军机制，勋章体系接入事件链。
- 修改内容：本文件 +14/-3——`light_up_nodes` 接入 `event_service.record` 写 `NODE_UNLOCK/COMPLETE_ROUTE` 事件（:409-417）。
- 关联文件：`backend/app/services/event_service.py`、`backend/app/services/medal_service.py`、`backend/app/models/models.py`（`user_event`）。
- 测试结果：待确认（`docs/迭代记录.md` 的 `be7e126` 条目仅一句内容摘要）。

### 2026-10-01（`895282b`，17:53）
- 需求：路线与点亮接口返回节点历史时间、描述与经纬度，支撑前端节点详情展示。
- 修改内容：本文件 +8——节点结构补 `historical_time/description/latitude/longitude`（:146-149, :387-390）。
- 关联文件：`backend/app/schemas/schemas.py`、`backend/app/models/models.py`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `895282b` 条目仅一句内容摘要）。

### 2026-10-01（`e8c6a09`，10:28）
- 需求：路线节点增加坐标、排序与启停配置。
- 修改内容：本文件 +17/-3——节点查询改按 `sort_order` 排序并过滤 `is_enabled`（`_ordered_nodes`，:62-68）。
- 关联文件：`backend/app/models/models.py`（`RouteNode`）、`backend/app/data/seed.py`、`docker/init/`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `e8c6a09` 条目无内容与验证字段）。

### 2026-09-30（`a94e685`，18:05）
- 需求：项目初始化（前端 Mock 业务逻辑迁移至后端服务层）。
- 修改内容：本文件创建（+125 行），含节点状态计算与点亮基础逻辑。
- 关联文件：`backend/app/api/routes/march.py`、`frontend/services/march.js`。
- 测试结果：待确认（`docs/迭代记录.md` 无 `a94e685` 条目）。
