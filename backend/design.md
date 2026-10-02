# design.md · 长征运动挑战后端（FastAPI）设计文档

本文档描述本目录（backend）的**模块架构设计、核心数据模型与关键接口定义**，是前后端联调与后续迭代的技术基线。规则与约定另见 `AGENTS.md`，接口与规则的日常速查见 `README.md`。

## 1. 设计目标

- 将前端 `../frontend/services/*.js` 的 Mock 业务逻辑**完整迁移**为服务端实现；
- 响应结构（字段名、嵌套关系、枚举值）与前端 Mock **完全一致**，前端切换后端时页面层零改动；
- 使用根目录 `docker/compose.yml` 承载 openGauss，通过 PostgreSQL 兼容协议连接；数据库结构由 `docker/init/` 统一维护，同时保留 mock openid 便于本地联调。

## 2. 模块架构设计

### 2.1 分层架构

```
                 ┌────────────────────────────────────────────┐
  HTTP 请求 ───▶ │  api/routes/*.py   路由层（含管理后台接口）      │
                 │  参数校验 / service 调用 / 业务异常→HTTPException│
                 └───────────────┬────────────────────────────┘
                                 │  Depends(get_db) / get_current_user
                 ┌───────────────▼────────────────────────────┐
                 │  api/deps.py      依赖注入                  │
                 │  get_db 重导出 · get_current_user（JWT→User） │
                 └───────────────┬────────────────────────────┘
                 ┌───────────────▼────────────────────────────┐
                 │  services/*_service.py   业务层（与前端同名）    │
                 │  auth / sport / march / quiz / points /     │
                 │  medal / org / rank —— 承载全部业务规则        │
                 └───────┬────────────────────┬───────────────┘
                 ┌───────▼───────┐    ┌───────▼───────────────┐
                 │ models/models  │    │ schemas/schemas       │
                 │ SQLAlchemy 2.0 │    │ Pydantic v2（CamelModel）│
                 └───────┬───────┘    └───────────────────────┘
                 ┌───────▼───────────────────────────────────┐
                 │ core/：config · database · security · helpers│
                 │ data/seed.py：静态种子（幂等）                │
                 └───────────────────────────────────────────┘
```

### 2.2 模块职责矩阵

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 应用入口 | `app/main.py` | lifespan 内写入种子；CORS；注册路由；`/` 健康检查 |
| 配置 | `app/core/config.py` | `Settings`（pydantic-settings）：APP/DB/JWT/WX/CORS/行军目标（`STREAK_GOAL_STEPS`，默认 5000）/步长（`STRIDE_M`），`lru_cache` 单例 |
| 数据库 | `app/core/database.py` | `engine`、`SessionLocal`、`Base`、`get_db`；不负责建表 |
| 数据库部署 | `../docker/` | openGauss Compose 配置、建库脚本、表结构和递增 SQL 变更 |
| 安全 | `app/core/security.py` | `create_token`/`decode_token`（PyJWT HS256，`sub`=user_id） |
| 工具 | `app/core/helpers.py` | 日期字符串、按「日期+用户」生成稳定模拟步数 |
| 鉴权依赖 | `app/api/deps.py` | `get_current_user`：Bearer Token 缺失/无效/用户不存在统一 401；`get_current_admin` 校验管理员 token |
| 实时推送 | `app/api/routes/ws.py` | `/api/ws/updates` WebSocket 长连接；数据变更广播 `data_changed`，用户事件广播 `activity` |
| 种子 | `app/data/seed.py` | 幂等写入：路线节点 10（含历史事件卡内容）、题库 15（含分类）、勋章 12（分类/隐藏/排序）、组织树 |
| 业务 | `app/services/*.py` | 见 §2.3 |
| 契约 | `app/schemas/schemas.py` | 请求/响应模型；小程序侧继承 `CamelModel`（to_camel 输出 camelCase），管理端 Admin* 模型为原生 snake_case |

### 2.3 服务层与前端 Mock 的对应关系

| 后端 service | 前端 services/*.js | 核心职责 |
| --- | --- | --- |
| `auth_service` | `auth.js` | `wx_login`：code→微信 code2Session→openid→建/查用户→签发 JWT；凭证为空时 mock openid；`update_nickname`：昵称仅可修改一次 |
| `sport_service` | `sport.js` | 今日步数查询/同步（同日覆盖）、最近 n 天记录、手动补步、行军日历聚合（按月） |
| `march_service` | `march.js` | 路线进度（节点状态 completed/current/unlocked）、节点详情（含历史事件卡 7 字段）、按累计步数点亮；`_route_state` 为节点状态/进度计算共用内核（个人路线与组织路线复用）；`get_global_goal` 全员共同长征目标（全员累计步数对 GLOBAL_GOAL_STEPS/GLOBAL_MILESTONES 配置，里程碑实时计算）；`get_footprints` 我的长征足迹（lit_nodes 点亮日期/快照 + daily_sport 当日步数，无冗余存储） |
| `quiz_service` | `quiz.js` | 每日抽 5 题（同用户同日同套，缓存于 `daily_questions`）、判分提交（每日一次）、记录、重置、知识画像（按题目分类统计正确率） |
| `points_service` | `points.js` | 积分总额、流水；`grant` 按「同日同 reason」去重；`grant_daily_login` 等快捷方法 |
| `medal_service` | `medal.js` | 12 枚勋章的判定与发放（`check_and_grant` 返回新获列表），含连续行军/步数里程碑/隐藏勋章 |
| `org_service` | `org.js` | 组织树逐级下钻、用户组织查询/选定（任意层级）；`get_companions` 同组织同行者（子树口径人数/今日总步数/同行者列表，隐私只下发昵称/头像/步数）；`get_org_march` 组织共同长征目标（子树成员累计步数映射组织路线，复用 `march_service._route_state` 现算无持久点亮） |
| `rank_service` | `rank.js` | 全员工累计步数总榜（跨组织，降序，标记我的名次） |
| `event_service` | —（足迹时间轴/实时动态数据源） | 统一事件系统：`record` 写 `user_event` 并向 WS 广播 `activity`；`build_text` 生成与小程序足迹同源的中文文案；`list_public_activities` 提供小程序实时动态（脱敏由 `ACTIVITY_MASK_NICKNAME` 控制，`mask_nickname` 实现）；事件类型如 FIRST_STEP/DAILY_GOAL/STREAK_*/NODE_LIT/MEDAL_GRANTED/QUIZ_DONE 等 |
| `streak_service` | —（内嵌于 sport 写入链） | 连续行军：写入侧 `on_sport_upsert` 在当日首次达标时维护 `users.continuous_days/max_continuous_days` 并写 DAILY_GOAL/STREAK_* 事件；读取侧 `compute_streaks` 以 `daily_sport.is_goal_completed` 重算 |
| `profile_service` | `profile.js` | 个人档案聚合（用户/连续行军/勋章/长征进度/足迹时间轴/五维数据画像 _portrait：行军/坚持/知识/路线/成就，仅数据不评价 §17） |
| `broadcast_service` | `broadcast.js` | 今日长征播报（全局运动汇总 + 今日长征彩蛋 + 个人当日状态） |
| `dashboard_service` | —（管理端） | 驾驶舱指标、路线总览、运动趋势、实时动态、数据大屏聚合（整体口径，无组织维度） |
| `admin_service` | —（管理端） | 管理员登录、路线节点/题库/组织架构 CRUD、全员排名、人员详情聚合 |

## 3. 核心数据模型（SQLAlchemy ORM）

### 3.1 静态配置表（启动时由 seed 幂等写入）

| 表 | 关键字段 | 约束/说明 |
| --- | --- | --- |
| `route_nodes` | id, name, target_steps(累计步数要求), historical_time, icon, description, latitude(9,6), longitude(10,6), sort_order, is_enabled(默认true), brief, significance, figures, location, images(JSON), audio, keywords | 10 行；id 从 1 起；启用节点按 `sort_order, id` 排序后 target_steps 严格递增；停用节点不影响小程序可见路线但 lit_nodes/勋章记录保留；brief/significance/figures/location/images/audio/keywords 为历史事件卡内容字段（005） |
| `questions` | id, type(single/judge), question, options(JSON), answer(JSON), analysis, score(20), category(event/route/figure) | 15 行；`answer` 不通过任何接口下发；`category` 支撑知识画像（005） |
| `medal_defs` | id(str 主键), name, icon, desc, category(starter/route/challenge/complete), hidden, sort_order | 12 行：first-step/learner/persistence/luding/snow/day-10k/steps-100k/steps-500k/streak-30/master/fearless(隐藏)/victory；hidden=True 未获得时不公开条件 |
| `organizations` | id, name, parent_id(可空=顶级), level(≥1), sort_order | 多级树；用户可选定任意层级节点 |

### 3.2 用户业务表

| 表 | 关键字段 | 唯一约束 | 业务含义 |
| --- | --- | --- | --- |
| `users` | id, openid(64,唯一), nickname(默认"长征小战士"), avatar(500,可空), org_id(可空), original_nickname(64,可空), nickname_changed_at(可空), continuous_days, max_continuous_days, created_at | openid 唯一 | 微信登录创建；org_id 指向 `organizations`；avatar 可为 NULL（openGauss 将空字符串转为 NULL）；original_nickname 记录登录时的微信名（曾用名），nickname_changed_at 非空表示已使用唯一一次改名机会；continuous_days/max_continuous_days 为连续行军冗余缓存（sport 写入时维护，读取以 daily_sport 重算为准） |
| `daily_sport` | id, user_id, date(10), steps, distance, is_goal_completed, is_makeup, makeup_at | `uq_sport_user_date`(user_id+date) | 每日步数，**同日同步覆盖而非累加**；distance 为估算公里数（steps × 步长）；is_goal_completed 为当日达标标记（连续行军判定依据）；is_makeup/makeup_at 为补签预留（未实现） |
| `lit_nodes` | id, user_id, node_id, lit_at, step_snapshot | `uq_lit_user_node`(user_id+node_id) | 已点亮节点，**点亮后永久保留**；step_snapshot 记录点亮时刻累计步数 |
| `quiz_records` | id, user_id, date, total_count, correct_count, score, points, wrong_list(JSON), answer_at | `uq_quiz_user_date`(user_id+date) | 每日答题记录，**每日仅一次**；wrong_list 元素含 questionId/category 供知识画像推导 |
| `daily_questions` | id, user_id, date, question_ids(JSON) | `uq_dailyq_user_date`(user_id+date) | 当日抽题缓存，保证同一天返回同一套题 |
| `points_log` | id, user_id, date, reason(50), delta | 无表级唯一（去重在 service 层） | 积分流水；**同日同 reason 去重** |
| `user_medals` | id, user_id, medal_id(50), granted_at | `uq_user_medal`(user_id+medal_id) | 用户已获勋章 |
| `user_event` | id, user_id, event_type(50), event_time, data(JSON) | 无（一次性事件靠 service 层 `has_event` 去重） | 统一事件流水：FIRST_STEP/DAILY_GOAL/STREAK_*/NODE_LIT/MEDAL_GRANTED/QUIZ_DONE 等；小程序足迹时间轴与管理端实时动态共用此表，`data` 存文案参数（节点名、连续天数等） |

> 与前端 `services/store.js` 的数据结构对应关系：
> `dailySport`→`daily_sport`、`litNodes`→`lit_nodes`、`quizRecords`→`quiz_records`、`pointsLog`→`points_log`、`medals`→`user_medals`。

### 3.3 数据库部署与结构变更

本地 openGauss 使用数据库 `longmarch`、用户 `gaussdb`、端口 `5118`。`../docker/init/init-db.sh` 创建数据库及 `schema_migrations`，再按文件名顺序执行尚未登记的 SQL。`001_schema.sql` 是当前基线；`002_route_node_config.sql` 增加路线节点经纬度、排序和启用字段；`003_optional_user_avatar.sql` 将 avatar 改为可空（适配 openGauss 空串→NULL）；`004_nickname_change.sql` 增加曾用名与改名时间；`005_upgrade.sql` 为高级化升级：users 连续行军字段、daily_sport 距离/达标/补签预留、lit_nodes 步数快照、route_nodes 历史事件卡 7 字段、questions 分类、medal_defs 分类/隐藏/排序、新建 user_event 表。后续变更新增递增编号脚本，并同步修改 SQLAlchemy ORM，FastAPI 不自动建表。

## 4. 关键接口定义

Base URL：`http://127.0.0.1:8010`，前缀 `/api`。除 `POST /api/auth/login` 与 `GET /api/org/children` 外，均需 `Authorization: Bearer <token>`。响应字段全部 camelCase。

### 4.1 接口总览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 否 | 健康检查 |
| POST | `/api/auth/login` | 否 | 微信登录：`{code, nickname?, avatar?}` → `{token, user}`；顺带发放每日登录积分；昵称仅在首次创建时写入，后续登录不覆盖 |
| GET | `/api/auth/me` | 是 | 当前用户 `{id, nickname, avatar, orgId, nicknameChangedAt}` |
| PUT | `/api/auth/nickname` | 是 | 修改昵称 `{nickname}`（每人仅一次，已修改过返回 400）→ 返回最新用户 |
| PUT | `/api/auth/nickname/initial` | 是 | 首次引导设置昵称 `{nickname}`（不消耗改名机会；已改过名返回 400）→ 返回最新用户 |
| GET | `/api/sport/today` | 是 | 今日步数概况 `{date, steps, target, totalSteps}` |
| POST | `/api/sport/sync` | 是 | 同步今日步数（模拟），返回 `{date, steps, totalSteps, synced}` 并刷新勋章 |
| GET | `/api/sport/recent?n=7` | 是 | 最近 n 天记录 `[{date, steps, text}]` |
| GET | `/api/sport/calendar?month=YYYY-MM` | 是 | 行军日历：当月每日步数/达标/答题/点亮节点 + 月统计（总步数/运动天数/日均/最高/当前连续） |
| POST | `/api/sport/add` | 是 | 手动补步（演示）：`{delta}` → 今日概况，刷新勋章 |
| GET | `/api/profile/summary` | 是 | 个人档案聚合：用户信息、加入天数/阶段、运动/答题/积分统计、连续行军、路线完成度、portrait 五维数据画像（0~100） |
| GET | `/api/profile/timeline?limit=` | 是 | 我的长征足迹：`user_event` 倒序时间轴（文案与事件表同源） |
| GET | `/api/broadcast/today` | 是 | 今日长征播报：期号、全局运动汇总、今日长征彩蛋（历史事件卡）、个人当日状态 |
| GET | `/api/broadcast/activities?limit=` | 是 | 实时行军动态（小程序）：`user_event` 关联昵称倒序；隐私边界只下发昵称/文案/类型/时间（不含 user_id 与事件参数），`ACTIVITY_MASK_NICKNAME=true` 时昵称脱敏（如「王*明」）；实时增量经 WS `activity` 消息下发 |
| GET | `/api/march/route` | 是 | 路线进度 `{nodes, currentSteps, totalSteps, litCount, totalCount, nextNode, finished, currentNodeId, currentProgress, routeProgress}`；仅统计启用节点；轨迹进度字段见下 |
| GET | `/api/march/global` | 是 | 全员共同长征目标（需求 §11）：`{totalSteps, targetSteps, progressPct, milestones[{name,steps,reached}], nextMilestone{name,steps,remain}|null}`；全员累计=全部用户 daily_sport 之和，目标/里程碑配置于 `march_service.GLOBAL_GOAL_STEPS/GLOBAL_MILESTONES` |
| GET | `/api/march/footprints` | 是 | 我的长征足迹（需求 §7）：`{nodes[{id,name,icon,litAt,litDate,daySteps,cumSteps}]}`，按路线顺序的已点亮节点；litDate 为本地日期（与 DailySport.date 同口径），cumSteps 为点亮时刻累计快照（历史回填为 0 前端判空） |
| GET | `/api/march/route-nodes` | 是 | 启用节点配置列表（含经纬度），小程序缓存使用 |
| GET | `/api/march/node/{node_id}` | 是 | 节点详情（任意状态可看，含未解锁），不存在 404 |
| POST | `/api/march/light-up` | 是 | 点亮达标节点，返回 `{newlyLit: [...], newlyCompletedChapters: [...]}`，发放积分并刷新勋章 |
| GET | `/api/quiz/daily` | 是 | 今日题目 `{date, completed, questions?, record?}`（同天同套，不含答案） |
| POST | `/api/quiz/submit` | 是 | 提交答卷 `{answers: [{questionId, answer[]}]}` → 判分记录；重复提交 400 |
| GET | `/api/quiz/records` | 是 | 答题记录列表 |
| GET | `/api/quiz/knowledge` | 是 | 知识画像：总正确率 + 按题目分类（event/route/figure）的答题数与正确率 |
| POST | `/api/quiz/reset` | 是 | 重置今日答题（调试用） |
| GET | `/api/points` | 是 | 积分总额与流水 `{total, logs: [{date, reason, delta}]}` |
| GET | `/api/medal/list` | 是 | 勋章列表 `{medals: [{id, name, icon, desc, owned}], ownedCount}`（先触发检查发放） |
| POST | `/api/medal/check` | 是 | 检查并发放勋章，返回 `{newly: [medalId...]}` |
| GET | `/api/org/children?parent_id=` | 否 | 按层级下钻组织树（留空返回顶级） |
| GET | `/api/org/mine` | 是 | 我的组织 `{orgId, orgName, fullName, path}` |
| GET | `/api/org/companions?limit=` | 是 | 同组织同行者（需求 §9）：`{org, memberCount, todayTotalSteps, companions[]}`；口径为用户所选组织的整棵子树，同行者按今日步数倒序限量（≤50），条目仅昵称/头像/今日步数/isSelf（§9.4 隐私） |
| GET | `/api/org/march` | 是 | 组织共同长征目标（需求 §10）：`{org, memberCount, totalSteps, progressPct, currentNodeName, nextNodeName, finished, litCount, totalCount, nodes[]}`；组织累计步数=子树成员累计有效步数之和，`currentNodeName`=第一个未完成节点、`nextNodeName`=其后一个（§10.2），节点 pct 已完成100/当前按累计占目标比例/其余0（§10.3） |
| POST | `/api/org/select` | 是 | 选定/修改组织 `{orgId}`；组织不存在 404 |
| GET | `/api/rank/steps` | 是 | 全员工累计步数榜 `{list: [{rank, userId, nickname, avatar, orgName, steps, isMe}], myRank, mySteps, total}` |
| WS | `/api/ws/updates?token=` | 是 | 实时推送长连接：数据写入广播 `data_changed`；`user_event` 写入广播 `activity`（含文案） |
| POST | `/api/admin/login` | 否 | 管理后台登录 `{username, password}` → `{token, username}` |
| GET | `/api/admin/dashboard` | 管理员 | 驾驶舱聚合：核心指标（参与人数/今日运动/总步数/人均/完赛率/答题人数/勋章发放）+ 路线总览 |
| GET | `/api/admin/dashboard/trend?days=` | 管理员 | 运动趋势：近 N 日每日总步数/运动人数/新增用户/新点亮节点数 |
| GET | `/api/admin/activities?limit=` | 管理员 | 实时动态：`user_event` 关联昵称倒序 |
| GET | `/api/admin/screen` | 管理员 | 数据大屏单接口聚合：指标 + 路线总览 + 7 日趋势 + 实时动态（整体口径，无组织维度） |
| GET | `/api/admin/rankings` | 管理员 | 全员排名统计；每人包含累计步数、组织、全部路线节点及实际到达时间 |
| GET | `/api/admin/users/{id}/overview` | 管理员 | 人员详情聚合（运动/答题/勋章/长征/积分） |
| GET | `/api/admin/route-nodes` | 管理员 | 全部路线节点列表（含停用） |
| POST | `/api/admin/route-nodes` | 管理员 | 新增路线节点 |
| PUT | `/api/admin/route-nodes/{id}` | 管理员 | 编辑路线节点（含历史事件卡 7 字段） |
| PATCH | `/api/admin/route-nodes/{id}/enabled` | 管理员 | 启用/停用节点 |
| GET/POST/PUT/DELETE | `/api/admin/questions[/{id}]` | 管理员 | 题库 CRUD（含 category 分类） |
| GET/POST/PUT/DELETE | `/api/admin/orgs[/{id}]` | 管理员 | 组织架构树 CRUD；GET 树每节点含 `direct_user_count`（直属人数）与 `total_user_count`（含下级累计，后序累加）；`POST /api/admin/orgs/sync` 从外部系统同步 |

### 4.2 关键请求/响应示例

**登录**（`POST /api/auth/login`）：

```json
// 请求
{ "code": "wx-login-code", "nickname": "小战士", "avatar": "https://..." }
// 响应
{
  "token": "<JWT>",
  "user": { "id": 1, "nickname": "小战士", "avatar": "https://...", "orgId": null, "nicknameChangedAt": null }
}
```

**路线进度**（`GET /api/march/route`）：

```json
{
  "nodes": [
    { "id": 1, "name": "瑞金", "icon": "🚩", "targetSteps": 0, "status": "completed", "remain": 0 }
  ],
  "currentSteps": 8236, "totalSteps": 45000, "litCount": 2, "totalCount": 10,
  "nextNode": { "id": 3, "name": "四渡赤水", "icon": "🛶", "targetSteps": 10000, "status": "current", "remain": 1764 },
  "finished": false,
  "currentNodeId": 3, "currentProgress": 0.65, "routeProgress": 0.18,
  "chapters": [
    { "id": 1, "name": "出发", "title": "第一章 · 出发", "status": "COMPLETED",
      "nodeIds": [1, 2], "litCount": 2, "totalCount": 2, "progress": 1, "intro": "……" },
    { "id": 2, "name": "转折", "title": "第二章 · 转折", "status": "ACTIVE",
      "nodeIds": [3, 4], "litCount": 0, "totalCount": 2, "progress": 0, "intro": "……" }
  ],
  "currentChapterId": 2
}
```

`currentNodeId` / `currentProgress` / `routeProgress` 为行军轨迹进度字段（006 高级化迭代）：
当前前往节点（下一站，全程完成时为 null）、当前区间段内进度 0~1、全程进度 0~1；
由后端统一计算，小程序只负责表现。

`chapters` / `currentChapterId` 为长征章节字段（006 P0-3）：

- **章节配置**：`march_service.CHAPTERS` 模块级配置（5 章 × 每章 2 节点，`node_ids` 对应 route_nodes 主键，介绍为公开史实概述）；调整章节划分只需改配置，管理端可视化编辑为后续增强。
- **章节状态**：基于节点状态计算——章内启用节点全部点亮为 `COMPLETED`，第一个未完成章为 `ACTIVE`，之后各章为 `LOCKED`；节点全部停用的章节跳过不下发；全部完成时 `currentChapterId` 为 null。
- **章节完成判定**：`light_up_nodes` 对比本次点亮前后已完成章节集合，新增完成章写入 `CHAPTER_COMPLETE` 事件（我的足迹与管理端动态同源），并在响应 `newlyCompletedChapters` 中返回 `{id, name, title, intro}` 供前端章节完成仪式展示；章节完成不改变既有节点点亮逻辑与积分规则。

**今日题目**（`GET /api/quiz/daily`，`questions` 不含 `answer`）：

```json
{
  "date": "2026-09-30", "completed": false,
  "questions": [
    { "id": 3, "type": "single", "question": "……", "options": [{ "label": "A", "text": "……" }], "analysis": "……", "score": 20 }
  ],
  "record": null
}
```

**提交答卷**（`POST /api/quiz/submit`）：

```json
// 请求
{ "answers": [{ "questionId": 3, "answer": ["A"] }] }
// 响应（每日仅一次，重复提交返回 400）
{
  "date": "2026-09-30", "totalCount": 5, "correctCount": 4, "score": 80, "points": 5,
  "wrongList": [{ "index": 2, "question": "……", "correctAnswer": "B", "analysis": "……" }],
  "answerAt": 1760000000000
}
```

## 5. 核心业务规则（与前端 Mock 完全一致）

| 域 | 规则 |
| --- | --- |
| 步数 | 按「用户+日期」唯一，同日同步**覆盖**；未接真实微信运动时按「日期+用户」生成稳定模拟步数（4000~12999）；`/sport/add` 演示补步 |
| 路线 | 累计步数 ≥ 节点 `targetSteps` 即点亮，点亮**永久保留**；节点状态 `completed`（已点亮）/ `current`（下一目标）/ `unlocked`（未解锁）；停用节点不在小程序可见路线中，不参与完成判定和排名，已有 lit_nodes 记录保留 |
| 章节 | 5 章配置于 `march_service.CHAPTERS`（每章 2 个 route_nodes 主键，划分与介绍可配置）；章内启用节点全点亮即完成，状态 `COMPLETED / ACTIVE / LOCKED`（全部停用的章节不下发）；`light_up_nodes` 对比点亮前后完成集，新完成章写 `CHAPTER_COMPLETE` 事件并随响应返回（含 title/intro 供前端仪式展示），不改变节点点亮与积分规则 |
| 答题 | 每日随机 5 题、每题 20 分、满分 100；同一用户同一天仅可提交一次；题目接口**不下发答案**；`/quiz/reset` 仅供调试 |
| 积分 | 登录 +1；运动 5000 步 +5、10000 步 +10；答题 +5、满分额外 +10；点亮节点 +10；完成路线 +100；**同日同 reason 去重** |
| 勋章 | 12 枚分四类：入门（first-step 首次运动 / learner 答题 10 次 / persistence 连续行军 7 天）、路线（luding 点亮泸定桥 / snow 点亮雪山）、挑战（day-10k 单日万步 / steps-100k / steps-500k / streak-30 连续 30 天 / master 积分≥500 / fearless 连续 7 天日万步，隐藏）、完成（victory 全部**启用**节点点亮）；隐藏勋章未获得时不公开条件 |
| 连续行军 | 当日步数 ≥ `STREAK_GOAL_STEPS`（默认 5000）即完成当日行军；写入侧在 `is_goal_completed` 由 False 翻 True 时更新 `users.continuous_days/max_continuous_days` 并写 DAILY_GOAL/STREAK_* 事件（一次性成就按事件表去重）；读取侧以 `daily_sport.is_goal_completed` 重算为准 |
| 事件 | 所有用户侧成就（首次运动/当日达标/连续里程碑/点亮节点/获得勋章/完成答题等）统一写 `user_event`，文案由 `event_service.build_text` 生成；写事件即向 WS 广播 `activity`，任何数据写入广播 `data_changed`；小程序公开动态流（`/api/broadcast/activities` + WS）只暴露昵称/文案/类型/时间，`ACTIVITY_MASK_NICKNAME` 可开启昵称脱敏 |
| 组织 | 树形逐级下钻；用户可选定任意层级节点；`/org/children` 不鉴权可浏览 |
| 昵称 | 登录时以微信昵称建号（记为曾用名）；登录**不再覆盖**昵称（头像仍随登录更新）；首次引导可经 `PUT /auth/nickname/initial` 设置昵称（不消耗改名机会）；应用内 `PUT /auth/nickname` 修改，**每人仅一次**（改后 nickname_changed_at 记录时间，再改返回 400）；曾用名与修改时间在管理端排名洞察可见 |
| 排名 | 跨组织员工个人总榜，按累计步数降序；小程序用 `isMe` 标记本人行，管理端返回全量人员及 `lit_nodes.lit_at` 节点到达时间 |

## 6. 关键设计决策与权衡

1. **camelCase 契约优先**：以 `CamelModel` 统一序列化而非改动前端 Mock，换来前端平滑切换；代价是后端内部保持 snake_case 与输出层的转换分离。
2. **openGauss + SQL 版本表**：数据库由根目录 Docker Compose 承载，SQLAlchemy 通过 `psycopg2` 连接 PostgreSQL 兼容协议；`schema_migrations` 保证结构脚本只执行一次，业务种子仍由后端幂等写入。
3. **勋章检查挂在副作用链尾**：运动/点亮/答题/登录后统一触发 `medal_service.check_and_grant`，避免遗漏判定时机；判定本身幂等（已拥有即跳过）。
4. **`daily_questions` 抽题缓存表**：保证「同一天同一套题」的体验与幂等语义，避免每次请求重新随机导致前后端不一致。
