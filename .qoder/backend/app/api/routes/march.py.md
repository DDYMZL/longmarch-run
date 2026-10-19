# march.py

## 1. 文件路径

`backend/app/api/routes/march.py`（90 行）

## 2. 文件职责

小程序长征路线域的 HTTP 路由层：路线节点配置、个人路线进度、全员路线抵达统计、全员共同目标、我的足迹、节点详情、点亮达标节点、完成仪式标记。路由层只做参数接收、调 `march_service` / `medal_service`、404 转换与 WebSocket 广播；点亮判定、章节计算等业务规则全部在 service 层（`backend/AGENTS.md` §3.1）。

## 3. 业务需求

- 长征路线是核心玩法：累计步数达标点亮节点，点亮后永久保留（`backend/app/services/march_service.py:3-6` 模块 docstring）。
- 章节系统（需求 §4，提交 `6a2fae3`，2026-10-02）：10 节点划分 5 章，章节状态由后端统一下发。
- 全员共同长征目标（需求 §11，提交 `c92598c`，2026-10-03）；我的长征足迹（需求 §7，提交 `ffd2570`，2026-10-03）；长征完成仪式（需求 §20.4，提交 `79004f1`，2026-10-04）。需求编号引自各 docstring，对应 V2.0 需求文档（仓库内交付说明见 `docs/长征步迹V2.0_交付说明.md`）。
- 节点坐标/排序/启停配置与 `GET /api/march/route-nodes`（提交 `e8c6a09`，2026-10-01）。
- 星空长征 HUD 数据叠加层（提交 `e72a670`，2026-10-19）：`GET /api/march/route-stats` 在地图节点上叠加「全员抵达人数/完成率」，口径与管理端驾驶舱 `route_overview` 共用 `march_service.compute_route_stats`（详见 §4.6）。

## 4. 核心功能

### 4.1 端点清单（8 个，与 `app.openapi()` 实测一致）

路由前缀 `/march`（`march.py:20`），经 `backend/app/main.py:111` 以 `/api` 前缀挂载（import 在 `main.py:27`）。

| 方法 | 完整路径 | 函数名 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| GET | `/api/march/route-nodes` | `route_nodes` | `march.py:23-31` | `require_activity_view` | `RouteNodeConfigListOut`（`backend/app/schemas/schemas.py:222`） |
| GET | `/api/march/route` | `route` | `march.py:34-36` | `require_activity_view` | `RouteOut`（`schemas.py:262`） |
| GET | `/api/march/route-stats` | `route_stats` | `march.py:39-44` | `require_activity_view` | `RouteStatsOut`（`schemas.py:289`，见 §4.6） |
| GET | `/api/march/global` | `global_goal` | `march.py:47-52` | `require_activity_view` | `GlobalGoalOut`（`schemas.py:399`） |
| GET | `/api/march/footprints` | `footprints` | `march.py:55-60` | `require_activity_view` | `FootprintsOut`（`schemas.py:421`） |
| GET | `/api/march/node/{node_id}` | `node_detail` | `march.py:63-73` | `require_activity_view` | `NodeDetailOut`（`schemas.py:303`） |
| POST | `/api/march/light-up` | `light_up` | `march.py:76-82` | `require_activity_participation` | `LightUpResult`（`schemas.py:377`） |
| POST | `/api/march/ceremony` | `ceremony` | `march.py:85-90` | `require_activity_view` | **未声明**，返回裸 dict `{"ok": True}`（见 §9 问题 1） |

`node_detail` 的路径参数必须写全：`/api/march/node/{node_id}`（`node_id: int`，非整数由 FastAPI 拦为 422）。

### 4.2 调用的 service 函数

| 路由 | service 调用 | 位置 |
|---|---|---|
| `route_nodes` | `march_service.get_route_nodes` | `backend/app/services/march_service.py:122`（内部 `_ordered_nodes` `:63`，按 sort_order,id 取启用节点） |
| `route` | `march_service.get_route` | `march_service.py:242` |
| `route_stats` | `march_service.get_route_stats`（60s 缓存包装）→ `compute_route_stats`（未缓存实现） | `march_service.py:380`；`:336` |
| `global_goal` | `march_service.get_global_goal` | `march_service.py:289` |
| `footprints` | `march_service.get_footprints` | `march_service.py:408` |
| `node_detail` | `march_service.get_node_detail` | `march_service.py:455` |
| `light_up` | `march_service.light_up_nodes` + `medal_service.check_and_grant` | `march_service.py:489`；`march.py:79-80` |
| `ceremony` | `march_service.mark_ceremony_seen` | `march_service.py:280` |

WebSocket 广播：仅 `light_up` 成功后广播 `march.light-up`（`march.py:81`，`backend/app/core/ws.py:23` build_event / `:73` broadcast）。`ceremony`、`route_stats` 均不广播。

### 4.3 `POST /api/march/light-up`：点亮判定与幂等性

- **判定规则在 service 层**：`march_service.light_up_nodes`（`march_service.py:489`）——当前累计步数（`sport_service.get_total_steps`）≥ 节点 `target_steps` 且不在 `lit_nodes` 集合中的节点，逐个新建 `LitNode`（含 `step_snapshot` 点亮时累计步数快照，`:511`）。路由层不复述公式。
- **幂等**：已点亮节点保存在 `lit_nodes`（user_id+node_id 唯一约束 `uq_lit_user_node`，`backend/app/models/models.py:284`），重复调用时 `newly` 为空，函数在 `:531` 直接返回 `([], [])`，**不产生任何写入与 commit**；有新增时 commit 在 `:533`。
- **V2.0 起点亮不再发积分**：`gained_points` 恒为 0（`march_service.py:490` docstring、`:542`）。
- **副作用**：写 `NODE_UNLOCK` 事件（`:549`）；全部点亮写 `COMPLETE_ROUTE`（`:553`）；对比点亮前后章节完成集（`chapters_before` 在 `:505` 采样），新完成章写 `CHAPTER_COMPLETE` 并随响应返回（`:555-568`）。事件经 `event_service.record`（自带 commit 与管理端动态广播，`backend/app/services/event_service.py:136`）。
- **勋章链**：路由层随后调 `medal_service.check_and_grant` 并把新获勋章并入响应 `new_medals`（`march.py:80`、`:82`），满足 `backend/AGENTS.md` 不变量 5；`e70b59f`（2026-10-11）将勋章合并进本响应，省去前端单独请求。
- 响应 `LightUpResult`：`newlyLit[]`（`LightUpNodeOut` 继承 `RouteNodeOut` 并加 gainedPoints/litAt/nextNode，`schemas.py:369`、`:362`）、`newlyCompletedChapters[]`、`newMedals[]`（`schemas.py:377`）。

### 4.4 `POST /api/march/ceremony`：幂等性与准入档位

- **幂等**：`mark_ceremony_seen`（`march_service.py:280`）——`users.route_ceremony_at` 已有值则直接 return（不写不 commit）；仅首次写入 `datetime.utcnow()`（`:285`）并 commit（`:286`）。
- 触发链：`GET /api/march/route` 在全部点亮且未观看时下发 `ceremonyPending=true`（`march_service.py:256-261`；`schemas.py:277-278`），前端播完仪式动画后调本端点标记，之后不再下发（`march.py:87-88` docstring）。
- **注意准入档位**：这是写端点但挂的是 `require_activity_view`（`march.py:86`）而非 participation——即活动结束（允许查看）时仍可标记仪式已观看。属现状事实；「标记已观看」不产生成绩数据，与 `backend/app/api/deps.py:78-81` 的注释口径（participation 用于产生新业务数据的接口）不冲突。

### 4.5 其余 GET 端点要点

- `GET /api/march/route`：节点状态现算（completed/current/unlocked，`march_service.py:175` `_route_state`），**步数达标即视为点亮且永久保留**（`:248-251`）；返回章节视图（`_chapter_views` `:127`）、行军轨迹进度（routeProgress/currentNodeId/currentProgress，`_route_state` 内 `:211-227`）与 `ceremonyPending`。
- `GET /api/march/global`：全员累计步数 = 全表 `daily_sport.steps` 之和（`:297`）；4 档里程碑为模块级常量 `GLOBAL_MILESTONES`（`:50`），达成状态实时计算（`:302`）；**总目标步数已外化到运营参数**，取 `operation_config_service.get_effective(db).global_goal_steps`（`:299`），不再是模块常量。
- `GET /api/march/footprints`：`lit_nodes` join `route_nodes`（按路线顺序）+ `daily_sport` 点亮当日步数；`lit_at` UTC 存储转本地日期（`:412`）；历史回填数据 `step_snapshot=0` 由前端判空展示（`:411` docstring）。
- `GET /api/march/node/{node_id}`：**任意状态节点均可查看历史详情（含未解锁）**（`march.py:69` docstring；`frontend/AGENTS.md` 不变量 8 禁止入口拦截）；service 返回 None（节点不存在或已停用）时路由层转 404「节点不存在」（`march.py:71-72`）；详情含历史事件卡字段（brief/significance/figures/location/images/audio/keywords）与相关人物（`person_service.get_persons_by_node`，`march_service.py:485`）。
- `GET /api/march/route-nodes`：输出启用节点配置（含真实经纬度），供小程序地图渲染（提交 `e8c6a09`）。当前小程序端无调用（grep `frontend/` 无命中），调用方为测试脚本（如 `backend/test/p0_route_progress.py`）。

### 4.6 `GET /api/march/route-stats`：全员抵达统计与 60s TTL 缓存

`e72a670`（2026-10-19）新增，星空长征深空 HUD 数据叠加层的数据源。路由层仅 3 行（`march.py:39-44`），全部规则在 service：

- **口径**：`compute_route_stats`（`march_service.py:336`，docstring `:337-345`）——累计步数 ≥ 节点 `target_steps` 即计为「抵达」，**不依赖 `lit_nodes`**，因此覆盖尚未主动点亮的用户，与个人路线的「步数达标即视为点亮」同口径。全员总数取 `users` 行数（`:347`），完成率 = `round(lit_count / total_users * 100)`、`total_users=0` 时为 0（`:359-361`）。
- **性能**：`_sorted_user_total_steps`（`:326`）一次 `GROUP BY user_id` 聚合出升序累计步数，各节点用 `bisect_left` 二分计数（`:352`），每节点 O(log U)，替代逐节点 O(U) 全表扫描。走完全程人数 = 末节点抵达人数（`:365-371`）。
- **两端共用、缓存分治**：管理端驾驶舱直连**未缓存**的 `compute_route_stats`（`backend/app/services/dashboard_service.py:39`，docstring `:36` 写明「保持驾驶舱实时口径」），保证 `route_overview` 与本接口口径不漂移；小程序侧走 `get_route_stats`（`march_service.py:380`）——march 是 tab 页、`onShow` 即刷新属高频路径，故加 60s 进程内 TTL 缓存（`_ROUTE_STATS_TTL`/`_ROUTE_STATS_CACHE` `:398-399`，沿用 `_CHAPTERS_CACHE` `:113` 的 `time.monotonic()` 写法）。
- **失效**：管理端节点的 create/update/set_enabled 三个写操作成功后调 `invalidate_route_stats_cache()`（`march_service.py:402`；调用点 `backend/app/services/admin_service.py:60`、`:82`、`:102`），与既有 `invalidate_chapter_cache()` 同一模式——否则改完 `target_steps` 后小程序侧最长 60s 仍显示旧抵达人数。
- **响应裁剪**：service 返回 `{total_users, total_steps, finished, nodes[{node_id,name,target_steps,lit_count,completion_rate}]}`，但 `RouteStatsOut` 只声明 `total_users` + `nodes`、`RouteNodeStatOut` 只声明 `node_id/lit_count/completion_rate`（`schemas.py:289`、`:281`），故 `total_steps`/`finished`/`name`/`target_steps` 被 schema 过滤掉，**不出网**（管理端驾驶舱不经 schema，仍拿全量）。
- 前端消费：`frontend/services/march.js:87` 透传；唯一调用方是长征页星空模式的 `loadOverlay()`，与 `/api/broadcast/today` 并发取数后合并注入渲染内核，失败时沿用 last-good（详见 `.qoder/frontend/services/march.js.md` §4.7）。

## 5. 输入与输出

- 输入：`node_id`（路径参数，int，`march.py:65`）；其余端点无参数，身份取自 JWT。所有响应模型继承 `CamelModel`，输出 camelCase（`schemas.py:17`）。
- 输出结构以 `schemas.py` 为准（下列为各 model 类定义起始行）：`RouteOut`（`schemas.py:262`）、`RouteNodeStatOut`（`:281`）、`RouteStatsOut`（`:289`）、`NodeDetailOut`（`:303`）、`LightUpNextNode`（`:362`）、`LightUpNodeOut`（`:369`）、`LightUpResult`（`:377`）、`GlobalGoalOut`（`:399`）、`FootprintNodeOut`（`:409`）、`FootprintsOut`（`:421`）、`RouteNodeConfigListOut`（`:222`）。
- 错误码：404（节点不存在，`march.py:72`）；401（令牌无效）；403（账号停用 `X-Account-Status`，`deps.py:46-52`；活动准入拒绝 `X-Activity-Status`，`deps.py:56-75`）；422（`node_id` 非整数）。`light-up`/`ceremony`/`route-stats` 路径上 service 不抛 `ValueError`，路由无 try 转换。
- `ceremony` 无 response_model，实际返回 `{"ok": true}`（`march.py:90`）。
- `route-stats` 的出网字段被 `RouteStatsOut` 裁剪为 `{totalUsers, nodes[{nodeId, litCount, completionRate}]}`（`schemas.py:289-293`）——service 另算的 `total_steps`/`finished`/`name`/`target_steps` 只供管理端驾驶舱使用，见 §4.6。

## 6. 依赖关系

- **依赖模块**：`app.api.deps`（两个活动准入依赖、`get_db`）、`app.core.ws`、`app.models.models.User`、`app.schemas.schemas`（7 个响应模型）、`app.services.march_service`、`app.services.medal_service`（`march.py:2-18`）。
- **service 层再依赖**：`sport_service`（累计步数）、`event_service`（事件）、`person_service`（节点相关人物）、`operation_config_service`（全员目标步数）（`march_service.py:22`）、`bisect_left`（抵达人数二分计数，`:12`）、`streak_service`（经 medal_service 间接）。
- **数据库表**：`route_nodes`（读）、`lit_nodes`（读写）、`daily_sport`（读，含 route-stats 的 `GROUP BY user_id` 聚合）、`users`（ceremony 写 `route_ceremony_at`；route-stats 读行数作分母）、`user_medals`（经 medal_service 写）、`user_event`（经 event_service 写）、`person_nodes`/`persons`（节点详情读）、`chapters`（经 `_effective_chapters` 读）。
- **被谁依赖**：`backend/app/main.py:111` 注册；小程序 `frontend/services/march.js`（`:17` route、`:33` node、`:57` light-up、`:70` global、`:78` footprints、`:87` route-stats、`:95` ceremony）。
- **本域 service 被跨服务复用**（修改时需连带回归）：`org_service.get_org_march` 调私有函数 `_ordered_nodes`/`_route_state`（`backend/app/services/org_service.py:255`、`:257`）；`dashboard_service.get_dashboard` 调 `compute_route_stats`（`dashboard_service.py:39`）；`admin_service` 三个节点写操作调 `invalidate_route_stats_cache`（`admin_service.py:60`、`:82`、`:102`）与四个章节写操作调 `invalidate_chapter_cache`（`:225`、`:242`、`:253`、`:268`）。

## 7. 业务规则

规则本体全部在 `march_service`，此处只列位置与结论：

1. **点亮判定与永久保留**：步数达标即点亮，一旦点亮不因步数下降取消（`march_service.py:3-6`、`:248-251`）；点亮落库仅由 `light_up_nodes` 完成。
2. **章节系统**：5 章 × 2 节点的兜底配置在模块常量 `CHAPTERS`（`march_service.py:25`），但**生效配置优先读 `chapters` 表**、库空才回退常量（`_effective_chapters` `:72`、`_compute_effective_chapters` `:90`，带 30s 进程内缓存 `:112-119`）；状态 COMPLETED/ACTIVE/LOCKED（`_chapter_views` `:127`）；章节完成写事件、不改点亮逻辑（需求 §4.5，`:555-568`）。
3. **全员目标**：4 档里程碑 `GLOBAL_MILESTONES`（`:50`）；**总目标步数外化到运营参数** `global_goal_steps`（`:299`），不再是模块常量；§11.3 的解锁内容/全局动画为后续增强（`:294` docstring）。
4. **完成仪式仅第一次触发**：`ceremony_pending` 只在全部点亮且 `route_ceremony_at IS NULL` 时为 true（`:256-261`）。
5. **V2.0 积分口径**：点亮/完成路线不发放积分（`:490`）；步行积分只由步数同步链经 `points_service` 产生。
6. **勋章副作用链**：light-up 后必须 `check_and_grant`（`march.py:80`，不变量 5 已满足）。
7. **全员抵达统计口径与缓存分治**：「抵达」= 累计步数 ≥ `target_steps`，**不看 `lit_nodes`**（`compute_route_stats` docstring `:339`），故与个人路线同口径且覆盖未主动点亮的用户；小程序侧 60s TTL 缓存（`get_route_stats` `:380`），管理端驾驶舱直连未缓存实现保持实时（`dashboard_service.py:36`、`:39`）；管理端改节点后必须失效缓存（`admin_service.py:60`/`:82`/`:102`）。

## 8. 修改约束

1. **事务边界：service 自提交**——`light_up_nodes` 在 `march_service.py:533` commit（事件写入由 `event_service.record` 各自 commit）、`mark_ceremony_seen` 在 `:286` commit；路由层不得 commit。
2. `light-up` 响应结构（newlyLit/newlyCompletedChapters/newMedals）是与 `frontend/pages/march/march.js`、`frontend/pages/home/home.js` 的既有契约（`e70b59f` 合并勋章后），增删字段属破坏性变更。
3. 不得给 `ceremony` 之外的端点降级准入档位；`light-up` 必须保持 `require_activity_participation`（产生新业务数据，`deps.py:78-79`）。
4. `org_service.get_org_march` 直接调用 `march_service` 的下划线私有函数 `_ordered_nodes`/`_route_state`（`org_service.py:255`、`:257`）——修改这两个函数签名会同时破坏组织长征接口。
5. 节点经纬度来自本域接口（`/api/march/route`、`/api/march/route-nodes`），前端无硬编码坐标表（`.qoder/ARCHITECTURE.md` §16 第 12 项已查证）；新增节点字段需同步 `RouteNodeConfigOut`（`schemas.py:209`）/`RouteNodeOut`（`:226`）/`NodeDetailOut`（`:303`）三处 schema。
6. **`RouteStatsOut` 是裁剪视图**：`compute_route_stats` 返回的 `total_steps`/`finished` 与逐项的 `name`/`target_steps` 被 schema 挡在网外。要给小程序多下发字段，必须同时改 `RouteStatsOut`/`RouteNodeStatOut`（`schemas.py:289`、`:281`），只改 service 返回值不生效。
7. **缓存分治不得对调**：不得让 `route-stats` 路由直连 `compute_route_stats`（march 是 tab 页、`onShow` 即刷新，会丢掉 60s 缓存把全量步数聚合压到高频路径）；也不得让 `dashboard_service` 改走 `get_route_stats`（驾驶舱要实时口径，管理员改完节点须立刻看到新数字）。
8. **新增节点写操作必须挂双失效**：任何改 `route_nodes`（目标步数/启停/排序）或 `chapters` 的管理端写路径，都要在成功后调 `invalidate_route_stats_cache()` / `invalidate_chapter_cache()`，否则小程序侧最长 60s / 30s 显示旧值。

## 9. 当前实现状态

- **已实现**：8 个端点全部可用；章节系统、全员目标、足迹、完成仪式、区域坐标配置、全员抵达统计齐备。
- **存在问题**：
  1. **`POST /api/march/ceremony` 未声明 `response_model`，返回裸 dict `{"ok": True}`**（`march.py:85`、`:90`），与 `backend/AGENTS.md` §3.1「所有响应必须声明 response_model，禁止路由直接返回裸 dict」不符。属既有偏差，功能不受影响（无 schema 校验需求）。
  2. `GET /api/march/route-nodes` 无小程序调用方，仅测试脚本使用；是否为管理端/后续预留**待确认**。
  3. `route-stats` 的 60s 缓存是**进程内**的（`march_service.py:399`），多 worker 部署时各进程独立计时，最坏延迟 60s；对展示型 HUD 可接受，但若后续要用于强一致场景需换共享缓存。该接口的 `s29_route_stats.py` 用例跑在 SQLite 上，**未在真实 openGauss 验证**（无方言相关语法，仅 `GROUP BY` 聚合 + Python 侧二分）。
  4. **四份关联 `.qoder` 文档存在跨提交累积的行号漂移**，且均未记载 `compute_route_stats`/`route-stats`：`services/march_service.py.md`（自称 434 行，实际 570）、`services/dashboard_service.py.md`（165 / 342）、`services/admin_service.py.md`（916 / 1302）、`schemas/schemas.py.md`（1858 / 2141）。漂移源自 `e72a670` 之前的多次改动（章节配置外化到 `chapters` 表、运营参数、驾驶舱重构等），**本文件的 §4.6 已按代码实读给出权威锚点**；四份文档的完整重算合并到独立文档任务，不在本次范围内。
- **待开发**：§11.3 里程碑解锁内容/全局动画/系统动态奖励钩子（`march_service.py:293-294` 注明「后续增强，不在本期」）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/march.py`（10 个提交，2026-10-19 核对）；验证细节见 `docs/迭代记录.md` 对应条目与各提交信息。按时间倒序、按主题归并。

### 2026-10-19（`e72a670`）

- 需求：星空长征深空 HUD 数据叠加层（S1 数据面补齐）——要在地图节点上叠加「全员抵达人数/完成率」，该口径原先只内联在 `dashboard_service.get_dashboard` 内部，小程序无接口可取。
- 修改内容：新增 `GET /api/march/route-stats`（`march.py:39-44`，鉴权 `require_activity_view`）；二分计数逻辑从 dashboard 上提为 `march_service.compute_route_stats` 供两端共用（**方向不能反**：`dashboard_service → org_service → march_service` 依赖链已存在，march 反向 import dashboard 会循环导入）；小程序侧加 60s 进程内 TTL 缓存，管理端驾驶舱直连未缓存实现；`admin_service` 三个节点写操作后自动失效缓存。
- 关联文件：`backend/app/services/march_service.py`、`backend/app/services/dashboard_service.py`、`backend/app/services/admin_service.py`、`backend/app/schemas/schemas.py`、`backend/design.md`、`backend/README.md`、`backend/test/s29_route_stats.py`。
- 测试结果：据提交信息与 `docs/迭代记录.md` 该条目 —— 新增 `s29_route_stats.py` **9/9 PASS**（含与 `/api/admin/dashboard` 的 `route_overview` 逐项相等、打桩计数证明 3 次请求只聚合 1 次、缓存失效前后对比）；回归 `s20_v2_regression.py` **26/26 PASS**。

### 2026-10-13（`ce14a95`）

- 需求：V2.0 活动时间控制。
- 修改内容：全部端点由 `get_current_user` 换为活动准入依赖（写接口 participation、读接口 view）。
- 关联文件：`backend/app/api/deps.py`、`backend/app/services/activity_service.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-11（`e70b59f`）

- 需求：小程序代码审查修复。
- 修改内容：`light-up` 响应合并返回 `newMedals`（路由内调 `check_and_grant` 并入结果），前端省去单独勋章请求。
- 关联文件：`frontend/pages/march/march.js`、`frontend/services/march.js`。
- 测试结果：见提交信息与 `docs/迭代记录.md`（并发请求守卫、动画恢复等前端项）。

### 2026-10-04（`79004f1`）

- 需求：区域氛围与长征完成仪式（P2-2，需求 §20.4）。
- 修改内容：新增 `POST /api/march/ceremony` 与 `route` 响应的 `ceremonyPending`；仅第一次完成触发完整动画。
- 关联文件：`backend/app/services/march_service.py`、`frontend/pages/ceremony/`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-03（`ffd2570`、`c92598c`）

- 需求：我的长征足迹地图（P1-6，需求 §7）；全员共同长征目标（P1-4，需求 §11）。
- 修改内容：新增 `GET /api/march/footprints` 与 `GET /api/march/global` 两个端点。
- 关联文件：`backend/app/services/march_service.py`、`frontend/pages/profile/`、`frontend/pages/home/home.js`。
- 测试结果：见 `docs/迭代记录.md` 对应条目。

### 2026-10-02（`6a2fae3`）

- 需求：长征章节系统（P0-3，需求 §4）。
- 修改内容：`route` 下发 chapters/currentChapterId；`light-up` 返回新完成章节并写 CHAPTER_COMPLETE 事件。
- 关联文件：`backend/app/services/march_service.py`（CHAPTERS 配置）、前端 march/home 页。
- 测试结果：据提交信息 —— 后端冒烟 **10/10**、automator **3/3**、截图 20/21 人工核对。

### 2026-10-01（`82af32c`、`e8c6a09`）

- 需求：管理端实时广播；路线节点坐标/排序/启停配置。
- 修改内容：`light-up` 成功后 WS 广播（`82af32c`）；新增 `GET /api/march/route-nodes` 输出启用节点配置（`e8c6a09`）。
- 关联文件：`backend/app/core/ws.py`、`backend/app/models/models.py`（RouteNode 新列）、`backend/app/data/seed.py`。
- 测试结果：见 `docs/迭代记录.md` 对应条目。

### 2026-09-30（`a94e685`）

- 需求：项目初始化。
- 修改内容：创建本文件，含 route / node 详情 / light-up 等初始端点。
- 关联文件：仓库初始代码。
- 测试结果：`docs/迭代记录.md` 该条目未记载验证结果，待确认。
