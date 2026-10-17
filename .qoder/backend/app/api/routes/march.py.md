# march.py

## 1. 文件路径

`backend/app/api/routes/march.py`（82 行）

## 2. 文件职责

小程序长征路线域的 HTTP 路由层：路线节点配置、个人路线进度、全员共同目标、我的足迹、节点详情、点亮达标节点、完成仪式标记。路由层只做参数接收、调 `march_service` / `medal_service`、404 转换与 WebSocket 广播；点亮判定、章节计算等业务规则全部在 service 层（`backend/AGENTS.md` §3.1）。

## 3. 业务需求

- 长征路线是核心玩法：累计步数达标点亮节点，点亮后永久保留（`backend/app/services/march_service.py:3-6` 模块 docstring）。
- 章节系统（需求 §4，提交 `6a2fae3`，2026-10-02）：10 节点划分 5 章，章节状态由后端统一下发。
- 全员共同长征目标（需求 §11，提交 `c92598c`，2026-10-03）；我的长征足迹（需求 §7，提交 `ffd2570`，2026-10-03）；长征完成仪式（需求 §20.4，提交 `79004f1`，2026-10-04）。需求编号引自各 docstring，对应 V2.0 需求文档（仓库内交付说明见 `docs/长征步迹V2.0_交付说明.md`）。
- 节点坐标/排序/启停配置与 `GET /api/march/route-nodes`（提交 `e8c6a09`，2026-10-01）。

## 4. 核心功能

### 4.1 端点清单（7 个，与 `app.openapi()` 实测一致）

路由前缀 `/march`（`march.py:19`），经 `backend/app/main.py:74` 以 `/api` 前缀挂载。

| 方法 | 完整路径 | 函数名 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| GET | `/api/march/route-nodes` | `route_nodes` | `march.py:22-30` | `require_activity_view` | `RouteNodeConfigListOut`（`backend/app/schemas/schemas.py:222`） |
| GET | `/api/march/route` | `route` | `march.py:33-35` | `require_activity_view` | `RouteOut`（`schemas.py:262`） |
| GET | `/api/march/global` | `global_goal` | `march.py:38-43` | `require_activity_view` | `GlobalGoalOut`（`schemas.py:384`） |
| GET | `/api/march/footprints` | `footprints` | `march.py:46-51` | `require_activity_view` | `FootprintsOut`（`schemas.py:406`） |
| GET | `/api/march/node/{node_id}` | `node_detail` | `march.py:54-64` | `require_activity_view` | `NodeDetailOut`（`schemas.py:288`） |
| POST | `/api/march/light-up` | `light_up` | `march.py:67-73` | `require_activity_participation` | `LightUpResult`（`schemas.py:362`） |
| POST | `/api/march/ceremony` | `ceremony` | `march.py:76-81` | `require_activity_view` | **未声明**，返回裸 dict `{"ok": True}`（见 §9 问题 1） |

`node_detail` 的路径参数必须写全：`/api/march/node/{node_id}`（`node_id: int`，非整数由 FastAPI 拦为 422）。

### 4.2 调用的 service 函数

| 路由 | service 调用 | 位置 |
|---|---|---|
| `route_nodes` | `march_service.get_route_nodes` | `backend/app/services/march_service.py:71-73`（内部 `_ordered_nodes` `:62-68`，按 sort_order,id 取启用节点） |
| `route` | `march_service.get_route` | `march_service.py:190-225` |
| `global_goal` | `march_service.get_global_goal` | `march_service.py:237-270` |
| `footprints` | `march_service.get_footprints` | `march_service.py:273-317` |
| `node_detail` | `march_service.get_node_detail` | `march_service.py:320-351` |
| `light_up` | `march_service.light_up_nodes` + `medal_service.check_and_grant` | `march_service.py:354-434`；`march.py:70-71` |
| `ceremony` | `march_service.mark_ceremony_seen` | `march_service.py:228-234` |

WebSocket 广播：仅 `light_up` 成功后广播 `march.light-up`（`march.py:72`，`backend/app/core/ws.py:23`/`:62`）。`ceremony` 不广播。

### 4.3 `POST /api/march/light-up`：点亮判定与幂等性

- **判定规则在 service 层**：`march_service.light_up_nodes`（`march_service.py:354-434`）——当前累计步数（`sport_service.get_total_steps`）≥ 节点 `target_steps` 且不在 `lit_nodes` 集合中的节点，逐个新建 `LitNode`（含 `step_snapshot` 点亮时累计步数快照，`:375`）。路由层不复述公式。
- **幂等**：已点亮节点保存在 `lit_nodes`（user_id+node_id 唯一，`backend/app/models/models.py:255`），重复调用时 `newly` 为空，函数在 `:394-395` 直接返回 `([], [])`，**不产生任何写入与 commit**；有新增时 commit 在 `:397`。
- **V2.0 起点亮不再发积分**：`gained_points` 恒为 0（`march_service.py:355` docstring、`:406`）。
- **副作用**：写 `NODE_UNLOCK` 事件；全部点亮写 `COMPLETE_ROUTE`；对比点亮前后章节完成集，新完成章写 `CHAPTER_COMPLETE` 并随响应返回（`:409-432`）。事件经 `event_service.record`（自带 commit 与管理端动态广播，`backend/app/services/event_service.py:106-129`）。
- **勋章链**：路由层随后调 `medal_service.check_and_grant` 并把新获勋章并入响应 `new_medals`（`march.py:71`、`:73`），满足 `backend/AGENTS.md` 不变量 5；`e70b59f`（2026-10-11）将勋章合并进本响应，省去前端单独请求。
- 响应 `LightUpResult`：`newlyLit[]`（含 gainedPoints/litAt/nextNode，`schemas.py:354-359`）、`newlyCompletedChapters[]`、`newMedals[]`。

### 4.4 `POST /api/march/ceremony`：幂等性与准入档位

- **幂等**：`mark_ceremony_seen`（`march_service.py:228-234`）——`users.route_ceremony_at` 已有值则直接 return（不写不 commit）；仅首次写入 `datetime.utcnow()` 并 commit。
- 触发链：`GET /api/march/route` 在全部点亮且未观看时下发 `ceremonyPending=true`（`march_service.py:204-209`；`schemas.py:277-278`），前端播完仪式动画后调本端点标记，之后不再下发（`march.py:78-79` docstring）。
- **注意准入档位**：这是写端点但挂的是 `require_activity_view`（`march.py:77`）而非 participation——即活动结束（允许查看）时仍可标记仪式已观看。属现状事实；「标记已观看」不产生成绩数据，与 `backend/app/api/deps.py:78-81` 的注释口径（participation 用于产生新业务数据的接口）不冲突。

### 4.5 其余 GET 端点要点

- `GET /api/march/route`：节点状态现算（completed/current/unlocked，`march_service.py:123-187` `_route_state`），**步数达标即视为点亮且永久保留**（`:196-199`）；返回章节视图（`_chapter_views` `:76-110`）、行军轨迹进度（routeProgress/currentNodeId/currentProgress，`:159-175`）与 `ceremonyPending`。
- `GET /api/march/global`：全员累计步数 = 全表 `daily_sport.steps` 之和（`:244-246`），总目标 2 亿步与 4 档里程碑为模块级常量（`GLOBAL_GOAL_STEPS`/`GLOBAL_MILESTONES`，`:48-54`），达成状态实时计算。
- `GET /api/march/footprints`：`lit_nodes` join `route_nodes`（按路线顺序）+ `daily_sport` 点亮当日步数；`lit_at` UTC 存储转本地日期（`:290-316`）；历史回填数据 `step_snapshot=0` 由前端判空展示（`:278-279` docstring）。
- `GET /api/march/node/{node_id}`：**任意状态节点均可查看历史详情（含未解锁）**（`march.py:60` docstring；`frontend/AGENTS.md` 不变量 8 禁止入口拦截）；service 返回 None（节点不存在或已停用）时路由层转 404「节点不存在」（`march.py:62-63`）；详情含历史事件卡字段（brief/significance/figures/location/images/audio/keywords）与相关人物（`person_service.get_persons_by_node`，`march_service.py:350`）。
- `GET /api/march/route-nodes`：输出启用节点配置（含真实经纬度），供小程序地图渲染（提交 `e8c6a09`）。当前小程序端无调用（grep `frontend/` 无命中），调用方为测试脚本（如 `backend/test/p0_route_progress.py`）。

## 5. 输入与输出

- 输入：`node_id`（路径参数，int）；其余端点无参数，身份取自 JWT。所有响应模型继承 `CamelModel`，输出 camelCase（`schemas.py:17-22`）。
- 输出结构以 `schemas.py` 为准：`RouteOut`（`schemas.py:262-278`）、`NodeDetailOut`（`:288-307`）、`GlobalGoalOut`（`:384-391`）、`FootprintsOut`（`:406-409`）、`LightUpResult`（`:362-365`）、`RouteNodeConfigListOut`（`:222-223`）。
- 错误码：404（节点不存在，`march.py:63`）；401（令牌无效）；403（账号停用 `X-Account-Status`；活动准入拒绝 `X-Activity-Status`，`deps.py:46-81`）；422（`node_id` 非整数）。`light-up`/`ceremony` 路径上 service 不抛 `ValueError`，路由无 try 转换。
- `ceremony` 无 response_model，实际返回 `{"ok": true}`（`march.py:81`）。

## 6. 依赖关系

- **依赖模块**：`app.api.deps`（两个活动准入依赖、`get_db`）、`app.core.ws`、`app.models.models.User`、`app.schemas.schemas`（6 个响应模型）、`app.services.march_service`、`app.services.medal_service`（`march.py:2-17`）。
- **service 层再依赖**：`sport_service`（累计步数）、`event_service`（事件）、`person_service`（节点相关人物）、`streak_service`（经 medal_service 间接）（`march_service.py:18-20`）。
- **数据库表**：`route_nodes`（读）、`lit_nodes`（读写）、`daily_sport`（读）、`users`（ceremony 写 `route_ceremony_at`）、`user_medals`（经 medal_service 写）、`user_event`（经 event_service 写）、`person_nodes`/`persons`（节点详情读）。
- **被谁依赖**：`backend/app/main.py:74` 注册；小程序 `frontend/services/march.js`（`:17` route、`:33` node、`:57` light-up、`:70` global、`:78` footprints、`:86` ceremony）；`org_service.get_org_march` 复用 `march_service._ordered_nodes`/`_route_state`（`backend/app/services/org_service.py:254-256`，跨服务调用私有函数，见 §8）。

## 7. 业务规则

规则本体全部在 `march_service`，此处只列位置与结论：

1. **点亮判定与永久保留**：步数达标即点亮，一旦点亮不因步数下降取消（`march_service.py:3-6`、`:196-199`）；点亮落库仅由 `light_up_nodes` 完成。
2. **章节系统**：5 章 × 2 节点配置在 `CHAPTERS`（`march_service.py:23-44`）；状态 COMPLETED/ACTIVE/LOCKED（`:76-110`）；章节完成写事件、不改点亮逻辑（需求 §4.5，`:363`）。
3. **全员目标**：2 亿步、4 档里程碑（`:48-54`）；§11.3 的解锁内容/全局动画为后续增强（`:241-242` docstring）。
4. **完成仪式仅第一次触发**：`ceremony_pending` 只在全部点亮且 `route_ceremony_at IS NULL` 时为 true（`:204-209`）。
5. **V2.0 积分口径**：点亮/完成路线不发放积分（`:355`）；步行积分只由步数同步链经 `points_service` 产生。
6. **勋章副作用链**：light-up 后必须 `check_and_grant`（`march.py:71`，不变量 5 已满足）。

## 8. 修改约束

1. **事务边界：service 自提交**——`light_up_nodes` 在 `march_service.py:397` commit（事件写入由 `event_service.record` 各自 commit）、`mark_ceremony_seen` 在 `:234` commit；路由层不得 commit。
2. `light-up` 响应结构（newlyLit/newlyCompletedChapters/newMedals）是与 `frontend/pages/march/march.js`、`frontend/pages/home/home.js` 的既有契约（`e70b59f` 合并勋章后），增删字段属破坏性变更。
3. 不得给 `ceremony` 之外的端点降级准入档位；`light-up` 必须保持 `require_activity_participation`（产生新业务数据，`deps.py:78`）。
4. `org_service.get_org_march` 直接调用 `march_service` 的下划线私有函数 `_ordered_nodes`/`_route_state`（`org_service.py:254-256`）——修改这两个函数签名会同时破坏组织长征接口。
5. 节点经纬度来自本域接口（`/api/march/route`、`/api/march/route-nodes`），前端无硬编码坐标表（`.qoder/ARCHITECTURE.md` §16 第 12 项已查证）；新增节点字段需同步 `RouteNodeConfigOut`/`RouteNodeOut`/`NodeDetailOut` 三处 schema。

## 9. 当前实现状态

- **已实现**：7 个端点全部可用；章节系统、全员目标、足迹、完成仪式、区域坐标配置齐备。
- **存在问题**：
  1. **`POST /api/march/ceremony` 未声明 `response_model`，返回裸 dict `{"ok": True}`**（`march.py:76`、`:81`），与 `backend/AGENTS.md` §3.1「所有响应必须声明 response_model，禁止路由直接返回裸 dict」不符。属既有偏差，功能不受影响（无 schema 校验需求）。
  2. `GET /api/march/route-nodes` 无小程序调用方，仅测试脚本使用；是否为管理端/后续预留**待确认**。
- **待开发**：§11.3 里程碑解锁内容/全局动画/系统动态奖励钩子（`march_service.py:241-242` 注明「后续增强，不在本期」）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/march.py`（9 个提交，2026-10-17 核对）；验证细节见 `docs/迭代记录.md` 对应条目与各提交信息。按时间倒序、按主题归并。

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
