# design.md · 长征运动挑战后端（FastAPI）设计文档

本文档描述本目录（backend）的**模块架构设计、核心数据模型与关键接口定义**，是前后端联调与后续迭代的技术基线。规则与约定另见 `AGENTS.md`，接口与规则的日常速查见 `README.md`。

## 1. 设计目标

- 将前端 `../frontend/services/*.js` 的 Mock 业务逻辑**完整迁移**为服务端实现；
- 响应结构（字段名、嵌套关系、枚举值）与前端 Mock **完全一致**，前端切换后端时页面层零改动；
- 零配置可运行（默认 SQLite + mock openid），兼顾后续生产化（可换 PostgreSQL/MySQL、真实微信凭证）。

## 2. 模块架构设计

### 2.1 分层架构

```
                 ┌────────────────────────────────────────────┐
  HTTP 请求 ───▶ │  api/routes/*.py   路由层（8 个域，21 个端点）  │
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
| 应用入口 | `app/main.py` | lifespan 内建表 + 种子；CORS；注册 8 个路由；`/` 健康检查 |
| 配置 | `app/core/config.py` | `Settings`（pydantic-settings）：APP/DB/JWT/WX/CORS，`lru_cache` 单例 |
| 数据库 | `app/core/database.py` | `engine`、`SessionLocal`、`Base`、`get_db`、`init_db`（`create_all`） |
| 安全 | `app/core/security.py` | `create_token`/`decode_token`（PyJWT HS256，`sub`=user_id） |
| 工具 | `app/core/helpers.py` | 日期字符串、按「日期+用户」生成稳定模拟步数 |
| 鉴权依赖 | `app/api/deps.py` | `get_current_user`：Bearer Token 缺失/无效/用户不存在统一 401 |
| 种子 | `app/data/seed.py` | 幂等写入：路线节点 10、题库 15、勋章 6、组织树 |
| 业务 | `app/services/*.py` | 见 §2.3 |
| 契约 | `app/schemas/schemas.py` | 请求/响应模型；响应继承 `CamelModel`（to_camel 输出 camelCase） |

### 2.3 服务层与前端 Mock 的对应关系

| 后端 service | 前端 services/*.js | 核心职责 |
| --- | --- | --- |
| `auth_service` | `auth.js` | `wx_login`：code→微信 code2Session→openid→建/查用户→签发 JWT；凭证为空时 mock openid |
| `sport_service` | `sport.js` | 今日步数查询/同步（同日覆盖）、最近 n 天记录、手动补步 |
| `march_service` | `march.js` | 路线进度（节点状态 completed/current/unlocked）、节点详情、按累计步数点亮 |
| `quiz_service` | `quiz.js` | 每日抽 5 题（同用户同日同套，缓存于 `daily_questions`）、判分提交（每日一次）、记录、重置 |
| `points_service` | `points.js` | 积分总额、流水；`grant` 按「同日同 reason」去重；`grant_daily_login` 等快捷方法 |
| `medal_service` | `medal.js` | 6 枚勋章的判定与发放（`check_and_grant` 返回新获列表） |
| `org_service` | `org.js` | 组织树逐级下钻、用户组织查询/选定（任意层级） |
| `rank_service` | `rank.js` | 全员工累计步数总榜（跨组织，降序，标记我的名次） |

## 3. 核心数据模型（SQLAlchemy ORM）

### 3.1 静态配置表（启动时由 seed 幂等写入）

| 表 | 关键字段 | 约束/说明 |
| --- | --- | --- |
| `route_nodes` | id, name, target_steps(累计步数要求), historical_time, icon, description | 10 行；id 从 1 起，与前端 `mock/data.js ROUTE_NODES` 一致 |
| `questions` | id, type(single/judge), question, options(JSON), answer(JSON), analysis, score(20) | 15 行；`answer` 不通过任何接口下发 |
| `medal_defs` | id(str 主键), name, icon, desc | 6 行：first-step/learner/master/luding/snow/victory |
| `organizations` | id, name, parent_id(可空=顶级), level(≥1), sort_order | 多级树；用户可选定任意层级节点 |

### 3.2 用户业务表

| 表 | 关键字段 | 唯一约束 | 业务含义 |
| --- | --- | --- | --- |
| `users` | id, openid(64,唯一), nickname(默认"长征小战士"), avatar(500), org_id(可空), created_at | openid 唯一 | 微信登录创建；org_id 指向 `organizations` |
| `daily_sport` | id, user_id, date(10), steps | `uq_sport_user_date`(user_id+date) | 每日步数，**同日同步覆盖而非累加** |
| `lit_nodes` | id, user_id, node_id, lit_at | `uq_lit_user_node`(user_id+node_id) | 已点亮节点，**点亮后永久保留** |
| `quiz_records` | id, user_id, date, total_count, correct_count, score, points, wrong_list(JSON), answer_at | `uq_quiz_user_date`(user_id+date) | 每日答题记录，**每日仅一次** |
| `daily_questions` | id, user_id, date, question_ids(JSON) | `uq_dailyq_user_date`(user_id+date) | 当日抽题缓存，保证同一天返回同一套题 |
| `points_log` | id, user_id, date, reason(50), delta | 无表级唯一（去重在 service 层） | 积分流水；**同日同 reason 去重** |
| `user_medals` | id, user_id, medal_id(50), granted_at | `uq_user_medal`(user_id+medal_id) | 用户已获勋章 |

> 与前端 `services/store.js` 的数据结构对应关系：
> `dailySport`→`daily_sport`、`litNodes`→`lit_nodes`、`quizRecords`→`quiz_records`、`pointsLog`→`points_log`、`medals`→`user_medals`。

## 4. 关键接口定义

Base URL：`http://127.0.0.1:8000`，前缀 `/api`。除 `POST /api/auth/login` 与 `GET /api/org/children` 外，均需 `Authorization: Bearer <token>`。响应字段全部 camelCase。

### 4.1 接口总览（21 个端点）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 否 | 健康检查 |
| POST | `/api/auth/login` | 否 | 微信登录：`{code, nickname?, avatar?}` → `{token, user}`；顺带发放每日登录积分 |
| GET | `/api/auth/me` | 是 | 当前用户 `{id, nickname, avatar, orgId}` |
| GET | `/api/sport/today` | 是 | 今日步数概况 `{date, steps, target, totalSteps}` |
| POST | `/api/sport/sync` | 是 | 同步今日步数（模拟），返回 `{date, steps, totalSteps, synced}` 并刷新勋章 |
| GET | `/api/sport/recent?n=7` | 是 | 最近 n 天记录 `[{date, steps, text}]` |
| POST | `/api/sport/add` | 是 | 手动补步（演示）：`{delta}` → 今日概况，刷新勋章 |
| GET | `/api/march/route` | 是 | 路线进度 `{nodes, currentSteps, totalSteps, litCount, totalCount, nextNode, finished}` |
| GET | `/api/march/node/{node_id}` | 是 | 节点详情（任意状态可看，含未解锁），不存在 404 |
| POST | `/api/march/light-up` | 是 | 点亮达标节点，返回 `{newlyLit: [...]}`，发放积分并刷新勋章 |
| GET | `/api/quiz/daily` | 是 | 今日题目 `{date, completed, questions?, record?}`（同天同套，不含答案） |
| POST | `/api/quiz/submit` | 是 | 提交答卷 `{answers: [{questionId, answer[]}]}` → 判分记录；重复提交 400 |
| GET | `/api/quiz/records` | 是 | 答题记录列表 |
| POST | `/api/quiz/reset` | 是 | 重置今日答题（调试用） |
| GET | `/api/points` | 是 | 积分总额与流水 `{total, logs: [{date, reason, delta}]}` |
| GET | `/api/medal/list` | 是 | 勋章列表 `{medals: [{id, name, icon, desc, owned}], ownedCount}`（先触发检查发放） |
| POST | `/api/medal/check` | 是 | 检查并发放勋章，返回 `{newly: [medalId...]}` |
| GET | `/api/org/children?parent_id=` | 否 | 按层级下钻组织树（留空返回顶级） |
| GET | `/api/org/mine` | 是 | 我的组织 `{orgId, orgName, fullName, path}` |
| POST | `/api/org/select` | 是 | 选定/修改组织 `{orgId}`；组织不存在 404 |
| GET | `/api/rank/steps` | 是 | 全员工累计步数榜 `{list: [{rank, userId, nickname, avatar, orgName, steps, isMe}], myRank, mySteps, total}` |

### 4.2 关键请求/响应示例

**登录**（`POST /api/auth/login`）：

```json
// 请求
{ "code": "wx-login-code", "nickname": "小战士", "avatar": "https://..." }
// 响应
{
  "token": "<JWT>",
  "user": { "id": 1, "nickname": "小战士", "avatar": "https://...", "orgId": null }
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
  "finished": false
}
```

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
| 路线 | 累计步数 ≥ 节点 `targetSteps` 即点亮，点亮**永久保留**；节点状态 `completed`（已点亮）/ `current`（下一目标）/ `unlocked`（未解锁） |
| 答题 | 每日随机 5 题、每题 20 分、满分 100；同一用户同一天仅可提交一次；题目接口**不下发答案**；`/quiz/reset` 仅供调试 |
| 积分 | 登录 +1；运动 5000 步 +5、10000 步 +10；答题 +5、满分额外 +10；点亮节点 +10；完成路线 +100；**同日同 reason 去重** |
| 勋章 | `first-step` 首次运动；`learner` 累计答题 10 次；`master` 积分 ≥ 500；`luding` 点亮 6 个节点；`snow` 点亮 7 个；`victory` 全部点亮 |
| 组织 | 树形逐级下钻；用户可选定任意层级节点；`/org/children` 不鉴权可浏览 |
| 排名 | 跨组织员工个人总榜，按累计步数降序；`isMe` 标记本人行 |

## 6. 关键设计决策与权衡

1. **camelCase 契约优先**：以 `CamelModel` 统一序列化而非改动前端 Mock，换来前端平滑切换；代价是后端内部保持 snake_case 与输出层的转换分离。
2. **SQLite + 幂等种子**：零配置保证「clone 即跑」；种子幂等使启动建库不依赖迁移工具。生产化 TODO（真实 code2Session、微信步数解密、头像上传、Alembic）见 `README.md`。
3. **勋章检查挂在副作用链尾**：运动/点亮/答题/登录后统一触发 `medal_service.check_and_grant`，避免遗漏判定时机；判定本身幂等（已拥有即跳过）。
4. **`daily_questions` 抽题缓存表**：保证「同一天同一套题」的体验与幂等语义，避免每次请求重新随机导致前后端不一致。
