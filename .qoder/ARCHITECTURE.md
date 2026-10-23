# ARCHITECTURE · 长征步迹 系统架构

> 最后核对时间：2026-10-17（对应 HEAD `031c323`）
>
> **本文档所有结论均以实际代码与配置为依据。** 计划中但尚未落地的能力一律标注「待开发」，无法从代码/配置/Git 历史确认的标注「待确认」，不做推测性描述。文中出现的 `文件:行号` 均可直接跳转核对。

---

## 1. 四端组成与调用关系

### 1.1 组件清单

| 组件 | 目录 | 技术形态 | 对外暴露 |
|---|---|---|---|
| 微信小程序（用户端） | `frontend/` | 原生小程序，CommonJS，无构建链 | 微信客户端内运行 |
| 后端 API 服务 | `backend/` | FastAPI + SQLAlchemy 2.0 同步 ORM | `:8010`（生产经 nginx 反代到 443） |
| 管理后台 | `admin/` | Vue 3.5 + Element Plus 2.9 + Vite 6，构建为静态资源 | 生产为静态站点，走同一域名的 `/api` |
| 数据库 | `docker/` | openGauss 容器（`opengauss/opengauss-server:latest`） | 本机 `:5118`（实测 7.0.0-RC3）；生产 `127.0.0.1:5432`、**openGauss 6.0.1**（据 `backend/.env.prod:7` 注释与 `:9` 连接串，非直连实测） |
| 数据库迁移脚本 | `docker/init/` | 001–022 编号 SQL，由 `database-init` 一次性服务按字典序执行（详见 §12.4） | — |

### 1.2 调用关系图

```
   ┌──────────────────────┐            ┌──────────────────────┐
   │  微信小程序 frontend/ │            │  管理后台 admin/      │
   │  25 个页面 · 19 服务   │            │  Vue3 SPA · 11 菜单   │
   └──────────┬───────────┘            └──────────┬───────────┘
              │ HTTPS request（wx.request）        │ HTTP request（axios）
              │ wss（services/ws.js，生产不可用）    │ ws（utils/liveUpdates.ts）
              │                                   │
              ▼                                   ▼
   ┌───────────────────────────────────────────────────────────┐
   │   nginx 443（配置不在仓库内，待确认）                        │
   │   location /api  ->  proxy_pass http://127.0.0.1:8010      │
   │   ⚠ 未转发 Upgrade/Connection，wss 在 443 失败              │
   └───────────────────────────┬───────────────────────────────┘
                               ▼
   ┌───────────────────────────────────────────────────────────┐
   │   FastAPI backend/  ·  settings.API_PREFIX = "/api"        │
   │                                                            │
   │   api/routes (18 个路由模块)                                 │
   │        │  Depends                                           │
   │        ▼                                                    │
   │   api/deps.py（会话 / 用户 / 管理员 / 菜单权限 / 活动准入）      │
   │        │                                                    │
   │        ▼                                                    │
   │   services/ (30 个服务模块)  ← core/（config database security│
   │        │                        wx ws rate_limit rate limit）│
   │        ▼                                                    │
   │   models/models.py（34 张表的 ORM 映射）                      │
   └───────────────────────────┬───────────────────────────────┘
                               │ SQLAlchemy 2.0 同步引擎
                               ▼
   ┌───────────────────────────────────────────────────────────┐
   │   openGauss（Oracle 兼容模式 A：'' 落库为 NULL）              │
   │   34 张业务表 + schema_migrations                            │
   │   初始化：database-init 跑 docker/init/001..022（字典序）      │
   └───────────────────────────────────────────────────────────┘

   外部依赖：
   ┌────────────────────────────┐   ┌────────────────────────────────────┐
   │ 微信开放接口（3 个）         │   │ 大模型上游（二选一，LLM_PROVIDER）  │
   │ sns/jscode2session          │   │ openai    → 阿里云百炼             │
   │ cgi-bin/token               │   │   POST /chat/completions           │
   │ wxa/getwxacodeunlimit       │   │ cloudbase → 腾讯云 CloudBase Agent │
   └────────────────────────────┘   │   JSON-RPC 2.0 session/prompt      │
                                    │ 两家响应均可 SSE 流式；由            │
                                    │ services/llm_service.py 门面分派     │
                                    └────────────────────────────────────┘
```

### 1.3 请求方向约束

- 小程序 → 后端：`services/request.js` 统一封装，baseURL 由 `services/config.js` 在**模块加载时求值一次**，运行期不可切换（`frontend/services/config.js:11`、`:28-40`）。判定依据运行环境 `envVersion`：`trial`/`release` 恒为 `https://swkjdj.sz-watech.com/api`（发布前无需改文件）；`develop` 由 `DEV_TARGET` 常量决定（当前 `'remote'`，同上；改 `'local'` 才连本机 8010）。
- 管理后台 → 后端：axios `baseURL = '/api'`（`admin/src/api/request.ts:14-17`），开发期由 Vite 代理转发（`admin/vite.config.ts:11-17`，`changeOrigin: true`、`ws: true`），生产期与后端同域。
- 后端 → 小程序/管理后台：**只有 WebSocket 一条反向推送通道**（见第 6 节），无服务端主动 HTTP 回调。
- 后端 → 数据库：同步阻塞驱动，请求线程内完成；唯一的例外是流式 CSV 导出使用独立 Session（见 §5.4）。

---

## 2. 后端应用装配

### 2.1 应用创建与启动钩子

`backend/app/main.py`：

| 位置 | 事实 |
|---|---|
| `:41-51` | `lifespan` 启动钩子：`init_seed(db)` → `streak_service.recompute_all(db)` → `points_service.recompute_walk_all(db, fix=True)`，用运动源数据修复派生统计。**无 shutdown 钩子**，`yield` 之后为空。 |
| `:54-59` | `FastAPI(title=settings.APP_NAME, version="1.0.0", lifespan=lifespan)` |
| `:61-67` | **唯一中间件** `CORSMiddleware`：`allow_origins=settings.CORS_ORIGINS`（默认 `["*"]`，`core/config.py:107`）、`allow_credentials=False`（注释说明鉴权走 Authorization 头，无需 cookie 凭据）、`allow_methods=["*"]`、`allow_headers=["*"]` |
| `:69-87` | 注册 18 个路由模块，统一前缀 `settings.API_PREFIX`（`/api`，`core/config.py:25`） |
| `:90-92` | `GET /`（**不在 `/api` 前缀下**）健康检查，返回 `{status, app, docs}` |

**未装配的能力**（明确不存在，非「待开发」遗漏）：无自定义异常处理器（`exception_handler`）、无 gzip、无请求日志中间件、无链路追踪、无 Sentry 类错误上报、无 OpenTelemetry。

### 2.2 路由模块清单

| 路由模块 | 前缀 | 面向对象 | 说明 |
|---|---|---|---|
| `routes/auth.py` | 无（路径内写全 `/auth/*`） | 小程序 | 登录、邀请码校验、入驻、当前用户、昵称 |
| `routes/identity.py` | 无（路径内写全 `/auth/qr/*`、`/auth/identities`） | 小程序 | 扫码场景查询/确认、身份绑定列表与解绑 |
| `routes/activity.py` | `/activity` | 小程序 | 活动状态与开关 |
| `routes/sport.py` | `/sport` | 小程序 | 微信运动步数同步、历史步数、连续天数 |
| `routes/march.py` | `/march` | 小程序 | 长征路线、节点点亮、仪式 |
| `routes/quiz.py` | `/quiz` | 小程序 | 每日一题、提交、解析、记录 |
| `routes/points.py` | `/points` | 小程序 | 积分明细与汇总 |
| `routes/medal.py` | `/medal` | 小程序 | 勋章定义与我的勋章 |
| `routes/org.py` | `/org` | 小程序 | 组织树、我的组织、选定组织 |
| `routes/rank.py` | `/rank` | 小程序 | 排行榜 |
| `routes/profile.py` | `/profile` | 小程序 | 个人中心聚合 |
| `routes/persons.py` | `/persons` | 小程序 | 长征人物 |
| `routes/quotes.py` | `/quotes` | 小程序 | 每日金句 |
| `routes/broadcast.py` | `/broadcast` | 小程序 | 今日播报聚合与实时行军动态（REST 拉取） |
| `routes/ws.py` | `/ws` | 双端 | WebSocket 长连接 |
| `routes/ai.py` | `/ai` | 小程序 | AI 问答、路线讲解、答题讲解 |
| `routes/admin.py` | `/admin` | 管理后台 | 后台全部业务接口（含 Excel 导入导出、审计、RBAC） |
| `routes/ai_admin.py` | `/admin/ai` | 管理后台 | AI 智能中心后台接口（Phase A 已就绪，管理端页面**待开发**） |

> **更正（2026-10-17）**：`routes/broadcast.py` 的「面向对象」原标为**管理后台**，实为**小程序**。依据：该模块两个端点均挂 `Depends(get_current_user)`（`backend/app/api/routes/broadcast.py:15`、`:22`，是小程序用户鉴权依赖而非 `get_current_admin`），`:19` 的 summary 自述「实时行军动态（小程序）」；唯一调用方是 `frontend/services/broadcast.js:27`、`:36`（由 `frontend/pages/home/home.js:159`、`:161` 消费），`admin/src/` 全目录对 `broadcast` **零命中**。管理端的实时刷新走 WebSocket（`routes/ws.py`），不经此模块。详见 `.qoder/backend/app/api/routes/broadcast.py.md` §2。
>
> 同行核实：`routes/ws.py` 标注「双端」**正确**——小程序 `frontend/services/ws.js:35-36`（`wx.connectSocket`）与管理端 `admin/src/utils/liveUpdates.ts:62`（`new WebSocket`）都连接同一个 `/api/ws/updates`，该端点同时接受小程序用户令牌与管理端令牌（`backend/app/api/routes/ws.py:27-28`）。

**端点总数口径（2026-10-17 实测，易混淆，务必区分）**

| 口径 | 数量 | 说明 |
|---|---|---|
| 唯一路径字符串 | **107** | `app.openapi()` 的 `paths` 键数。同一路径挂多个方法（如 `/api/admin/route-nodes` 的 GET 与 POST）只算一次 |
| HTTP 方法级操作 | **125** | 18 个路由模块共 124 个装饰器（HTTP 123 + WebSocket 1），再加 `main.py:91` 直接注册在 app 上的 `GET /` 健康检查（不经任何 router） |
| WebSocket | **1** | `/api/ws/updates`，不出现在 OpenAPI 中 |
| **端点总计** | **126** | 125 HTTP + 1 WebSocket |

各模块端点数（2026-10-17 以 `grep -c "^@router\."` 逐文件实测，与 `app.openapi()` 双向吻合）：`admin.py` **57**、`ai_admin.py` **15**、`march.py` **7**、`quiz.py` **6**、`auth.py` **6**、`ai.py` **6**、`sport.py` **5**、`org.py` **5**、`identity.py` **4**、`rank.py` **2**、`profile.py` **2**、`points.py` **2**、`medal.py` **2**、`broadcast.py` **2**、`activity.py` **1**、`persons.py` **1**、`quotes.py` **1** —— HTTP 小计 **124**；另 `ws.py` **1** 个 WebSocket，18 个路由模块装饰器合计 **125**；再加 `main.py:91` 的 `GET /` 健康检查，**HTTP 方法级操作共 125**。

> **更正（2026-10-17）**：本段原写 `points.py` **1** 个端点、合计 124（把 WebSocket 也计入了该合计）。实测 `backend/app/api/routes/points.py` 有 **2** 个：`@router.get("")`（`:14`，即 `GET /api/points`，空路径装饰器易被漏数）与 `@router.get("/daily")`（`:23`）。前端两处调用可交叉印证：`frontend/services/points.js:16`、`:27`。修正后 HTTP 小计 124、装饰器合计 125，与 `app.openapi()` 实测的 125 个 HTTP 操作一致（其中 1 个是不经 router 的健康检查）。上表 107/125/1/126 四项总数**不受影响**，此前即已按 `app.openapi()` 实测得出。

> **统计陷阱**：该 FastAPI 版本的 `include_router` 是**惰性挂载**，`app.routes` 里 18 个路由模块表现为 `_IncludedRouter` 对象而**不会展开成 `APIRoute`**。直接遍历 `app.routes` 只能数到 1 个 `APIRoute`（健康检查），必须走 `app.openapi()` 或 `_IncludedRouter.original_router.routes` 才能拿到真实端点。

---

## 3. 后端分层与依赖方向

### 3.1 分层规则

```
api/routes/*.py     HTTP 协议层：参数校验（Pydantic）、状态码、response_model
      │  Depends
      ▼
api/deps.py         横切依赖：get_db / get_current_user / get_current_admin /
                    require_menu / require_activity_participation / require_activity_view
      │  调用
      ▼
services/*.py       业务逻辑层，统一签名 (db: Session, ...)；跨服务调用普遍存在
      │  使用
      ▼
models/models.py    ORM 映射（34 张表）
core/*              基础设施：config database security wx ws rate_limit
```

约束与现状：

- **服务层签名统一**为 `def xxx(db: Session, ...)`，Session 由路由层通过 `Depends(get_db)` 注入并向下传递；服务层不自行创建 Session（唯一例外见 §5.4）。
- **跨服务调用是常规做法**，例如 `services/sport_service.py:25` 调 `points_service`、`services/auth_service.py:19` 调 `invite_service`；不存在「服务层禁止互相依赖」的约束。
- **路由层不写 SQL**，业务查询一律下沉到服务层。
- 服务模块共 **30 个**，路由模块共 **18 个**（`main.py:15-33` 的 import 列表可核对）。

### 3.2 三条完整请求链（示例，用于说明分层如何协作）

1. **微信登录** `POST /api/auth/login`
   `routes/auth.py:29` → `services/auth_service.py`（`_resolve_openid` 调 `core/wx.py` 的 code2session；`_resolve_openid` 失败抛 502，**不回落到 mock**，`auth_service.py:41-48`）→ 按 `users.status` 分支返回 `active` / `disabled` / `unregistered`（`auth_service.py:68-83`）→ `core/security.py:create_access_token` 签发 7 天令牌 → `LoginResponse`（CamelModel）。

2. **步数同步** `POST /api/sport/sync`
   `routes/sport.py` → `require_activity_participation` 准入 → `services/sport_service.py`（`_resolve_steps` 解密微信运动数据 `:71-102`）→ 条件 UPDATE + `with_for_update()` 保证并发幂等（`:105-111`）→ `points_service` 重算行走积分 → `core/ws.py:broadcast(data_changed)` → `event_service` 推送 `activity` 动态（`event_service.py:106`）。

3. **管理端导出排行 CSV** `GET /api/admin/rank/export`
   `routes/admin.py:347-362` → `require_menu("rankings")` → `admin_service.iter_rank_csv`（`:433-438` 自建独立 Session，`:485` 关闭，`:238` `RANK_EXPORT_BATCH = 1000`）→ `yield_per(1000)` 流式生成 → `StreamingResponse` + UTF-8 BOM，`_csv_text`（`admin_service.py:423`）做公式注入防护。

---

## 4. API 请求与响应约定

### 4.1 无统一响应外壳

**后端不返回 `{code, data, msg}` 信封。** 2xx 时响应体就是业务 payload 本身；错误由 `HTTPException` 产生 FastAPI 默认的 `{"detail": ...}`。

- 小程序侧 `services/request.js:77` 对 2xx **直接 `resolve(res.data)`，不做任何拆包**。
- 小程序侧 `errorMessage(data, fallback)`（`request.js:48-54`）负责解析 `detail`：字符串直接用；数组（Pydantic 校验错误）则取各项 `msg` 用 `；` 拼接。
- 管理后台侧 `admin/src/api/request.ts:27-51` 的成功拦截器**原样返回整个 `AxiosResponse`**（`:28` 即 `(response) => response,`），**不做任何拆包**；`.data` 由各调用方自行取（如 `admin/src/views/DashboardView.vue:43` 的 `(await fetchDashboard()).data`、`:63` 的 `(await fetchActivities(20)).data.items`）。该拦截器只在**错误分支**参与响应体解析：取 `error.response.data.detail`（`:32`），401 时清令牌并按「是否登录页」分别提示或跳转（`:35-45`），其余非 `silent` 请求统一 `ElMessage.error`（`:46-48`）。

> **更正（2026-10-17）**：本节原写「管理后台成功拦截器**直接返回 `response.data`**，调用方拿到的即业务对象」，**有误**。依据：`admin/src/api/request.ts:27-28` 的成功回调是 `(response) => response,`，返回的是完整 `AxiosResponse`；`admin/src/api/admin.ts` 全文对 `.data` **零命中**（即 API 层不拆包）；实际拆包发生在视图层，形如 `(await fn()).data`（`admin/src/views/DashboardView.vue:43`、`:53`、`:63` 等）。因此**两端拆包位置不同**：小程序在 `services/request.js:77` 统一拆包，管理后台在调用方各自拆包。

### 4.2 双命名契约（重要）

| 调用方 | Schema 基类 | 字段风格 |
|---|---|---|
| 微信小程序 | `CamelModel`（配置 `alias_generator=to_camel`） | **camelCase** |
| 管理后台 | `Admin*` 系列，普通 `BaseModel` | **snake_case** |

同一份业务数据面向两端时使用两个不同的 Schema，**不是**靠全局配置切换。新增接口时必须先确认调用方，选对基类，否则字段名会整体错位。

### 4.3 状态码约定

| 状态码 | 语义 | 依据 |
|---|---|---|
| 200 | 成功 | — |
| 400 | 业务校验失败（含邀请码无效、Excel 行校验失败） | 各 service 抛 `HTTPException` |
| 401 | 令牌缺失/无效/过期/用户不存在 | `api/deps.py:22-41`、`:118-140` |
| 403 | 账号停用、活动准入拒绝、菜单权限不足 | `api/deps.py:49-53`、`:68-72`、`:155-157` |
| 404 | 资源不存在 | 各路由 |
| 429 | 触发限流 | `core/rate_limit.py` |
| 502 | 微信开放接口调用失败（含 code2session 失败） | `services/auth_service.py:41-48` |

**409 在全项目未被使用。** 冲突语义统一由 400 承载。

### 4.4 分页约定

请求参数：`page`（从 1 开始）+ `page_size`；响应结构：`{ total, items }`。管理后台的长列表（排行、审计、题目）均走服务端分页；**小程序端多数列表为全量拉取**（组织树、路线节点、勋章定义），依赖后端数据量小这一前提。

已知不遵循分页约定的页面：`admin/src/views/RouteNodesView.vue` 在前端做筛选，未做服务端分页（数据量小，属可接受现状，非缺陷）。

### 4.5 时间约定（三套并存，易错点）

| 层 | 约定 | 依据 |
|---|---|---|
| 数据库存储 | **UTC naive**（不带时区信息的 `datetime`） | `core/helpers.py:12-14` |
| 业务日切分 | **北京时间 UTC+8** 的自然日 | `core/helpers.py:9`、`:22-24` |
| REST 输出 | ISO 字符串（UTC naive 直接 `isoformat()`） | `core/ws.py:18-20` 明确注释「与 REST 接口 event_time 格式一致」 |
| **例外** | `quiz_records.answer_at` 存**毫秒级 BigInteger**，不是 datetime | `models/models.py:287` |
| 前端解析 | 小程序 `utils/util.js:46-49` `parseUtc`；管理后台 `utils/format.ts:29-31` `parseUtc`，两端各自实现 | — |

跨时区/跨端时间计算必须走 `parseUtc`，**不得直接 `new Date(str)`**（不同端对无时区后缀字符串的解析行为不一致）。

### 4.6 准入控制通过响应头传递

后端在 403 响应上附加自定义头，前端据此做差异化跳转：

| 响应头 | 值 | 触发条件 | 前端行为 |
|---|---|---|---|
| `X-Account-Status` | `disabled` | 账号被停用 | `request.js:81-86` 置 `err.admission='disabled'` → `clearSession()` 重登 |
| `X-Activity-Status` | `unpublished` / `not_started` / `ended` | 活动时间窗准入拒绝 | `request.js:87-91` 置 `err.activityStatus` → `redirectActivityClosed()` 跳活动页（**3 秒去抖**，`request.js:7`、`:110-119`） |

小程序 `request.js` 同时兼容小写头名。管理后台 `admin/src/api/request.ts` **未消费这两个头**，403 没有专门分支、不做跳转（已知限制）。

---

## 5. 鉴权、权限与令牌失效

### 5.1 三类 JWT

`backend/app/core/security.py`，算法 HS256（`config.py:38`），密钥 `JWT_SECRET`（`config.py:37`，默认值仅供本地开发，生产由 `.env.prod` 覆盖）。

| 工厂函数 | 位置 | 载荷 | 有效期 |
|---|---|---|---|
| `create_access_token(user_id, openid)` | `:10-19` | `sub`=用户主键字符串、`openid`、`iat`、`exp` | `JWT_EXPIRE_MINUTES`=10080（7 天，`config.py:39`） |
| `create_admin_token(username)` | `:22-32` | `sub`=用户名、`role="admin"`、`typ="super"` | `JWT_ADMIN_EXPIRE_MINUTES`=720（12 小时，`config.py:40`） |
| `create_admin_token_for_user(user_id)` | `:35-49` | `sub`=用户主键、`role="admin"`、`typ="user"` | 同上 12 小时 |

`decode_token`（`:52-59`）捕获 `jwt.PyJWTError` 后**返回 None 而非抛异常**，由调用方决定 401 文案。

关键设计：**权限不写入令牌**。`create_admin_token_for_user` 的注释（`:38-39`）明确「get_current_admin 每次请求查库校验，撤销即时生效；12 小时有效期仅作兜底」。因此 `typ=user` 的管理员令牌里只有身份、没有 menus/roles。

**无服务端会话存储、无 refresh token、无令牌黑名单。** 「令牌失效」的实现方式是：短有效期兜底 + 每请求查库重新构建权限（`typ=user`）+ 账号状态即时校验（`_ensure_active`）。超管令牌（`typ=super`）在有效期内**无法被单独吊销**，只能通过改 `JWT_SECRET` 全量失效。

### 5.2 小程序用户鉴权链

`api/deps.py:17-43` `get_current_user`：

1. `HTTPBearer(auto_error=False)` 取凭据，缺失 → 401「未登录或令牌缺失」
2. `decode_token` 失败或无 `sub` → 401「令牌无效或已过期」
3. `int(sub)` 转换失败 → 401「令牌无效」
4. 查库无此用户 → 401「用户不存在」
5. `_ensure_active(user)`（`:46-53`）：`status != active` → 403 + `X-Account-Status: disabled`

### 5.3 管理端鉴权链

`api/deps.py:109-147` `get_current_admin`：

1. 凭据缺失 → 401
2. `decode_token` 失败或 `payload["role"] != "admin"` → 401「管理员令牌无效或已过期」
3. `typ != "user"`（含 `typ="super"` 与**改造前的无 `typ` 历史令牌**）→ 直接构造 `AdminPrincipal(is_super=True)` 放行（`:127-129`）
4. `typ == "user"` → 查用户 → `_ensure_active` → `access_service.build_principal(db, user)`；返回 None（无启用角色）→ 403「后台访问权限已被撤销或禁用」

`AdminPrincipal.has_menu(code)`（`:105-106`）：`is_super or code in self.menus`。

`require_menu(code)`（`:150-160`）：菜单码粒度的依赖工厂，无权限 → 403「无该功能的访问权限」。

**RBAC 模型**：`users` ←(多对多)— `admin_user_roles` —→ `admin_roles` ←(多对多)— `admin_role_menus` —→ `admin_menus`。粒度到**菜单码**，**没有按钮级权限**（已知限制）。数据库中 `admin_menus` 共 16 个菜单码；管理后台 `admin/src/router/menus.ts` 只登记 11 个（5 个 AI 菜单尚未在前端出现，与 AI 管理子页面「待开发」状态一致）。

### 5.4 活动准入闸门

`api/deps.py:56-81` `_activity_guard(need_participate)` 工厂产出两个依赖：

- `require_activity_participation`（`need_participate=True`）：产生新业务数据的接口（步数、答题、积分、勋章、点亮）
- `require_activity_view`（`need_participate=False`）：读取成绩/排行的接口，活动结束后按 `allow_view_after_end` 放行

顺序很重要：**先完成用户鉴权（401 / 停用 403 优先），再判活动状态**，因为 `_check` 内部 `Depends(get_current_user)`。拒绝时 403 + `X-Activity-Status`。

小程序启动页 `pages/launch/launch.js:109-121` 的 `enterHome` 也做一次前置检查：`activity.getStatus().then(s => s.allowView, () => true)` —— **接口失败时默认放行**（fail-open），注释与代码一致，理由是本检查只是体验优化，后端才是最终闸门。

### 5.5 前端令牌管理与静默重登

**小程序**（键定义全部在 `frontend/services/`，页面层零 Storage）：

| 存储键 | 含义 | 定义位置 |
|---|---|---|
| `lm_auth_token` | JWT | `services/request.js:3` |
| `lm_login_user` | 后端返回的 user 快照 | `services/auth.js:10`、`services/request.js:4` |
| `lm_logged_out` | 「用户主动退出」标记，阻止静默重登 | `services/auth.js:11` |
| `lm_pending_invite` | 邀请码暂存 `{code, orgId, orgName}`（写入见 `pages/launch/launch.js:92`，读取见 `pages/onboard/onboard.js:23`） | `services/auth.js:12`、`:257-274` |
| `lm_march_intro_played` | 长征开场动画是否已播 | `services/march.js:90` |
| `lm_data_{userId}` | **遗留** Mock 数据键，仅供迁移，永不删除 | `services/store.js:15` `KEY_PREFIX` |

**24 处 Storage 调用全部位于 `services/`**（`auth.js` 16、`request.js` 3、`store.js` 3、`march.js` 2），**25 个页面 JS + `app.js` + `utils/` 中零 Storage 读写** —— 存储访问被完全收敛到服务层。

`request.js:129-160` `request()` 的重试链（严格按代码顺序）：

1. `err.activityStatus` 存在 → 除非 `skipActivityRedirect`，跳活动页；**无论如何 rethrow**
2. `err.admission === 'disabled'` → 除非 `skipAuthRetry`，`clearSession()`；rethrow
3. 非 401 或 `skipAuthRetry` → 直接 rethrow
4. 401 且未注入 `reauthHandler` → `clearSession()` + rethrow
5. 401 且有 handler → `await reauthHandler()`，然后 **`send(opts)` 精确重试一次**；重试仍 401 → `clearSession()`
6. `reauthHandler` 自身 reject：若 `loginErr.network` 为真 → **保留会话**（让页面提示重试而非踢下线）；否则 `clearSession()`

`setReauthHandler(fn)`（`request.js:23-25`）由 `auth.js:164` 注入 `relogin`，**目的是打破 request.js ↔ auth.js 的循环依赖**。

`auth.js:14-15` 的 `reloginPending` / `ensurePending` 两个模块级 Promise 实现**单飞（single-flight）去重**，确保并发 401 只触发一次 `wx.login` + 一次 `/auth/login`。

`clearSession()`（`request.js:28-45`）：删两个 Storage 键 → 复位 `globalData` → `wx.reLaunch('/pages/launch/launch')`。

**登录态语义**：`app.js:6` 注释明确 `loggedIn` **只有在后端 token 校验通过或登录成功后才为 true，本地缓存不算已登录**；`auth.updateLocalUser`（`:237-247`）刻意不改 `loggedIn`。

**管理后台**（`admin/src/store/auth.ts`）：**无 Pinia/Vuex**，基于 localStorage 的轻量 store，4 个键：

| 键 | 含义 |
|---|---|
| `lm_admin_token` | JWT |
| `lm_admin_username` | 登录名 |
| `lm_admin_menus` | 菜单码数组（**仅用于前端菜单渲染，不作为权限依据**） |
| `lm_admin_is_super` | 是否超管 |

`hasMenu`（`:27-29`）、`isLoggedIn`（`:49-52`）。401 处理在 `api/request.ts:35-45`：区分 `hadToken`（曾有令牌 → 视为过期，清会话跳登录）与无令牌（直接放行错误）。

### 5.6 路由守卫

`admin/src/router/index.ts:102-118` 全局前置守卫，4 步：白名单放行 `/login` → 未登录跳 `/login` → 已登录访问 `/login` 跳首页 → **`hasMenu` 校验当前路由所需菜单码，无权则跳 `firstAllowedPath()`（`:9-12`，取菜单表中第一个有权项；该函数的存在是为了防止「无任一菜单权限时反复重定向自身」的死循环）**。

---

## 6. WebSocket 实时推送

### 6.1 端点与鉴权

`backend/app/api/routes/ws.py`：`WS /api/ws/updates`，令牌走 **query string**（`:22` 注释说明「浏览器原生 WebSocket 无法携带请求头」）。

鉴权分支（`:30-50`）：

| 情况 | 关闭码 |
|---|---|
| `decode_token` 失败或无 `sub` | **4401** |
| 非超管且查库无此用户 | **4401** |
| 账号 `status != active`，或 `role=admin` 但 `build_principal` 返回 None（授权被撤销） | **4403** |
| 超管令牌（`role=admin` 且 `typ != "user"`） | 直接放行，不查库 |

**同时接受小程序用户令牌与管理端令牌**。建连后 `while True: await ws.receive_text()` —— 客户端心跳等消息**统一忽略**（`:54`）。

### 6.2 连接管理与跨线程广播

`backend/app/core/ws.py`：

- `:14-15` 模块级 `_connections: List[WebSocket]` 与 `_loop: Optional[AbstractEventLoop]`，**进程内内存态**。
- `:40-45` `connect()`：`await ws.accept()` 后记录 `asyncio.get_running_loop()` 供同步代码使用。
- `:48-51` `disconnect()`：由路由的 `WebSocketDisconnect` 分支调用。
- `:54-59` `_safe_send()`：单条发送，连接已关闭时静默忽略。
- `:62-71` `broadcast()`：**同步业务路由运行在请求线程中**，通过 `asyncio.run_coroutine_threadsafe(_safe_send(ws, text), _loop)` 把发送任务投递到事件循环，不阻塞业务请求。无连接或 `_loop is None` 时**静默跳过**（`:64-65`），投递异常也静默忽略（`:70-71`）。

### 6.3 两类消息

| 类型 | 构造函数 | 载荷 | 用途 |
|---|---|---|---|
| `data_changed` | `build_event(reason, user_id)`（`:23-25`） | `{type, reason, user_id, at}` —— **仅事件类型与元信息，不含业务数据** | 管理端收到后自行重新拉取 REST 接口 |
| `activity` | `build_activity(event_type, user_id, nickname, text)`（`:28-37`） | `{type, eventType, userId, nickname, text, at}` —— camelCase | 驾驶舱/大屏动态流直接展示 `text` |

`activity` 由 `services/event_service.py:106`、`:126` 推送。`data_changed` 的触发点覆盖小程序侧所有用户数据写入：步数同步、答题提交、节点点亮、组织选定、登录、勋章发放（`routes/ws.py:3-5` 文档串说明）。

**设计取舍**：`data_changed` 不携带数据，是为了避免「推送的数据与随后拉取的数据不一致」以及避免在广播路径上做权限过滤 —— 客户端收到通知后按自己的权限重新查询。

### 6.4 消费端

**管理后台**：`admin/src/utils/liveUpdates.ts` 导出 `useLiveUpdates`。800ms 防抖合并（`:22`、`:34-39`）；动态流条目使用**负数递减 id** 作为本地 key（`:24`、`:40-50`）；指数退避重连 3s→15s（`:77-92`）。**仅 3 个页面使用**（Dashboard / Screen / Rankings）。

**小程序**：`frontend/services/ws.js`（92 行）连同一端点（`:35`），`subscribe`（`:81-90`）、退避重连（`:20-28`）、空闲 30s 主动关闭（`IDLE_CLOSE_MS=30000`，`:64-74`）、`socket !== s` 陈旧连接守卫（`:39`、`:46`、`:54`）。**但 `pages/home/home.js:142-146` 的 `handleWsMessage` 只处理 `msg.type === 'activity'`，其它类型直接忽略** —— 小程序不靠 WS 做数据同步，跨 tab 一致性由 `onShow + refresh()` 保证（见 §9.2）。

### 6.5 无心跳、无重放、单进程

- **服务端不发心跳帧**，只被动 `receive_text()` 并忽略。
- **无消息重放/离线补偿**：断连期间的事件永久丢失，客户端重连后必须自己全量刷新。
- **单进程内存连接表**：`_connections` 是进程级变量，**多进程部署（gunicorn -w N）会导致广播只命中同进程的连接**。当前生产由 systemd 服务 `longmarch-backend` 托管（依据：`backend/test/docs/s26-ai-question-backend-report.md:96` 的 `systemctl restart longmarch-backend`），仓库内未见任何多 worker 配置，故按单进程理解、问题尚未暴露；**实际 worker 数未核实**，若改用 `gunicorn -w N` 必须先引入跨进程连接表。未引入 Redis/Celery（见 PROJECT.md §3）。

---

## 7. 微信能力集成

`backend/app/core/wx.py` 只对接 **3 个微信官方接口**：

| 能力 | 接口 | 位置 | 说明 |
|---|---|---|---|
| 登录换 openid | `sns/jscode2session` | `:15`、`:18-42` | 用 `wx.login` 的 code 换 `openid` + `session_key` |
| 微信运动数据解密 | 本地 AES-128-CBC | `:45-61` | 解密小程序 `wx.getWeRunData()` 返回的 `encryptedData`/`iv`，**校验 `watermark.appid`** |
| 全局凭据 | `cgi-bin/token` | `services/wechat_service.py:21-50` | 内存缓存，**TTL 7000 秒**（官方 7200，留 200 秒余量） |
| 小程序码 | `wxa/getwxacodeunlimit` | `services/wechat_service.py:13-14`、`:53-73` | 生成带 scene 的无限小程序码；`:16-19` 定义两个落地页；`:76-84` 图片缓存 |

**`session_key` 从不落库、从不打日志**（`core/wx.py:3-4` 注释明确）。

`services/auth_service.py:41-48` `_resolve_openid`：code2session 失败抛 **502，绝不回落到 mock**。`:35-38` `_mock_openid` 仅在明确的本地开发开关下生效。

**`wx_web`（网页授权）身份绑定通道为半成品**：数据库 `user_identities.provider` 支持该值，小程序 `frontend/pages/account/account.js:9-12` 的 `PROVIDER_NAMES` 已备好「微信网页授权」文案并能渲染该来源，但**小程序端无任何触发写入路径**；**管理后台也没有任何身份来源展示页**（`grep -rn "identities" admin/src/` 无命中，`routes/admin.py` 亦无相关接口）。属预留能力，当前**部分实现**。

**scene 前缀语义**（`frontend/pages/bind/bind.js:48-71`）：`L{token}` = PC 管理端登录确认，`B{token}` = 身份绑定。启动页 `launch.js:25-35` 用正则 `/(?:^|[?&])i=([A-Za-z0-9]{1,32})/` 解析小程序码 scene 中的邀请码（32 字符上限对应微信 scene 长度限制）。

---

## 8. 文件上传与 Excel 导入导出

### 8.1 上传约束

| 项 | 值 | 依据 |
|---|---|---|
| 允许扩展名 | 仅 `.xlsx` | `routes/admin.py:419-426`（校验在 `:421-422`）、`services/import_service.py:4` 文档串 |
| 大小上限 | ≤ 2 MB | 同上 |
| 解析库 | `openpyxl` | `services/import_service.py:17` |
| 上传端点 | `routes/admin.py:438-452`、`:591-605` | — |

**未引入 pandas**，所有 Excel 读写直接用 openpyxl。

### 8.2 两阶段导入（预览 → 确认）

这是本项目最复杂的一致性设计：

1. **预览阶段**：整批校验（任一行出错则**整批阻断**，不允许部分成功），把解析后的 payload 以 JSON 存入 `import_previews` 表，返回**一次性 uuid token，TTL 30 分钟**（`import_service.py:25-27`、`:124-137`）。
2. **确认阶段**（`:140-175`）：以**条件 UPDATE**（`pending → confirmed`）原子消费 token，防止重复提交；随后在**同一事务**内批量写入业务表；任何失败**全量回滚**。
3. **错误回传格式**（`:280-286`，Schema 见 `schemas.py:1115-1131`）：逐行携带行号与错误原因，前端 `ExcelImportDialog.vue` 表格化展示。
4. **模板下载**：`routes/admin.py:411-416`、`:429-435`。

前端 `admin/src/components/ExcelImportDialog.vue` 通过 `api: ExcelImportApi` prop（`:10-14`）接收**三个**接口函数（`downloadTemplate`/`preview`/`confirm`），因此**同一个组件复用于所有导入场景**；`defineExpose({downloadTemplate})`（`:101`）允许父组件直接触发模板下载。

> **更正（2026-10-17）**：上段原写「接收四个接口函数」，与 `ExcelImportDialog.vue:10-14` 的 `ExcelImportApi` 接口声明（3 个成员）不符，已按源码更正。

### 8.3 流式 CSV 导出

`StreamingResponse` + **独立 Session** + `yield_per(1000)` + **UTF-8 BOM**（Excel 打开中文不乱码）。`_csv_text`（`services/admin_service.py:423`）对以 `=`、`+`、`-`、`@` 开头的单元格做**公式注入防护**。前端 `admin/src/utils/download.ts` 提供 `saveFile` / `csvCell` / `today`。

独立 Session 的原因（`admin_service.py:433-438`、`:485`）：`StreamingResponse` 的生成器在**路由函数返回之后**才执行，此时 `Depends(get_db)` 的 Session 已被 FastAPI 关闭，故必须自建并在生成器结束时手动关闭。**这是全项目唯一的服务层自建 Session 例外。**

---

## 9. 状态与一致性架构

### 9.1 后端：以数据库为唯一权威

无应用层缓存（除微信 access_token 与小程序码图片两处**必要的**内存缓存），无 Redis。所有业务状态实时查库。派生统计（连续天数、行走积分）在**启动时以源数据重算修复**（`main.py:41-51`），保证崩溃/中断后自愈。

**积分账本设计**：`points_log` 表每人每来源每天一行，`biz_key` = `walk:{日期}` / `quiz:{日期}`，唯一约束 `(user_id, biz_key)`，**重算是幂等的**（`recompute_walk_all(fix=True)`）。总积分 = 行走积分 + 答题积分。历史遗留行按规则排除。

**并发控制**：条件 UPDATE + `with_for_update()` 行锁（`sport_service.py:105-111`）。**不使用乐观锁版本号。**

### 9.2 小程序：后端落库 + 各页 onShow 刷新

**这是小程序端最核心的架构不变量**，权威依据 `frontend/design.md:261-262`，`frontend/AGENTS.md` §4 亦列为不变量。

原因：微信小程序 5 个 tab 页是**常驻实例**，`onLoad` 只跑一次，切 tab 不重建页面。项目**没有跨页内存共享缓存层**（无 mobx/redux/自研 store 单例），`globalData` 只有 `user` / `loggedIn` / `activity` 三个字段（第三个由 `services/activity.js:14` 运行时追加，`app.js` 中未声明）。

落地：几乎所有数据页在 `onShow` 调 `refresh()`（home / march / rank / mine / profile / calendar / points / medals / quiz / quiz-records / sport-records / activity / ai-chat）。

**竞态防护：单调递增请求 ID**，每页一个私有计数器，晚到的响应被丢弃（以下均为 `frontend/pages/<页面>/<页面>.js`，与同名的 `frontend/services/*.js` 无关）：`home.js:153-286 _refreshRequestId`、`march.js:150-165 _refreshRequestId`（且 `onHide:128-135`、`onUnload:137-138` **主动 bump 以作废在途请求**）、`rank.js:53-94 _requestId`、`calendar.js:48-69 _requestId`、`points.js:43-89 _reqId`、`org-select.js:69-82 _levelRequestId`。

**账号切换隔离**：`pages/ai-chat/ai-chat.js:44-55` 在 `onShow` 比较 `this._uid` 与 `app.globalData.user.id`，不一致就清空全部会话态 —— 全项目唯一一处显式的跨账号数据清理。

**无业务数据本地缓存**：步数、路线、题目、排行等**全部每次 onShow 重新拉取**，无 TTL 缓存。

### 9.3 管理后台：WS 通知 + 按需重拉

`useLiveUpdates` 收到 `data_changed` 后 800ms 防抖，再调页面自己的 fetch 函数。不使用 WS 携带的数据。

### 9.4 事务边界（不统一，须知悉）

**两种提交约定并存**：

| 约定 | 说明 | 示例 |
|---|---|---|
| 服务层自提交 | service 内部 `db.commit()` | 多数业务 service |
| 路由层提交 | service 只 `db.add()` / 修改，由路由 `db.commit()` | 审计写入，`services/audit_service.py:2-5` 文档串明确此约定 |

`SessionLocal` 配置 `autoflush=False, autocommit=False`（`core/database.py:51`），`get_db()`（`:58-64`）在 `finally` 中 `db.close()`。**未配置连接池参数**（`:50`，使用 SQLAlchemy 默认 QueuePool）。

修改代码时**必须先确认目标 service 属于哪一种约定**，重复 commit 或漏 commit 都会导致数据不一致。

---

## 10. 限流、审计与错误处理

### 10.1 限流

`backend/app/core/rate_limit.py`：自实现 `SlidingWindowLimiter`（`:11-27`），**仅按 IP 维度**（`:38-39`），进程内内存计数。`:30-35` 定义 4 个实例：`login_limiter`（账号登录 10 次/分）、`qr_create_limiter`（扫码会话创建 10 次/分）、`qr_poll_limiter`（扫码轮询 60 次/分）、`invite_limiter`（邀请码校验/入驻 60 次/分）。触发返回 429。

全部 5 个调用点：`backend/app/api/routes/admin.py:107`（login）、`:129`（qr_create）、`:149`（qr_poll），`backend/app/api/routes/auth.py:50`、`:69`（invite）。

> **更正（2026-10-17）**：本节原写 4 个限流器「分别用于登录、邀请码校验、**AI 问答**等敏感入口」。经 grep 全量 `require_rate` 调用点核实，**`backend/app/api/routes/ai.py` 没有任何限流调用**——AI 问答的成本控制走的是另一套机制：按用户日额度（`AI_CHAT_DAILY_LIMIT`）与全站日额度（`AI_GLOBAL_DAILY_LIMIT`），由 `backend/app/services/ai_usage_service.py` 计数，生效值经 `ai_config_service.get_effective(db)` 合并。原第 4 个限流器实为扫码会话创建/轮询两项。详见 `.qoder/backend/app/core/rate_limit.py.md`。

**局限**：进程内计数 → 多进程/多实例部署下阈值会被放大 N 倍；重启即清零。当前单进程部署下可用。

### 10.2 审计

`services/audit_service.py` + `audit_logs` 表，记录管理端写操作。约定为「service `db.add`，路由 `db.commit`」（`:2-5`）。管理端 `admin/src/views/AuditView.vue` 用 `ACTION_TEXT` 20 项映射把 action 码翻译成中文。

### 10.3 错误处理与日志

- 后端：**无全局异常处理器**，未捕获异常由 FastAPI 默认转 500。业务错误统一 `HTTPException`。
- 日志：**未配置结构化日志框架**，无 logging 配置文件，仓库内亦无落盘/轮转策略。生产由 systemd 托管，进程 stdout/stderr 默认进 journald（查 `journalctl -u longmarch-backend`）——该结论来自运维会话实测，**非仓库内证据**。
- 小程序：`services/request.js:94-101` 的 `fail` 回调把原始 `errMsg` **追加进用户可见的 message**，注释说明理由「真机看不到 console，必须把错误带到界面上」；`/url not in domain list/i` 单独提示域名白名单问题。
- 小程序 `app.js` **没有 `onError` / `onUnhandledRejection` / `onPageNotFound`** —— 未捕获异常只在开发者工具 console 可见，**线上无任何回收手段**，微信侧错误上报能力也未配置（是否为有意取舍**待确认**）。

---

## 11. AI 智能中心（V1.0 Phase A，已上线）

### 11.1 外部集成

大模型上游是**可切换的双供应商**（`b712d81`，2026-10-22；此前 `c660727` 曾把上游单向迁到百炼并删掉 ACP 实现）：`backend/app/services/llm_service.py` 是**门面**，按 `LLM_PROVIDER` 分派到两个适配器之一，业务层（`ai_chat_service`、`ai_question_service`、`routes/ai.py`、`routes/ai_admin.py`、`routes/admin.py`）只 import 门面、不感知上游协议。

| `LLM_PROVIDER` | 适配器 | 协议 | 生效配置项 |
|---|---|---|---|
| `openai`（代码默认值，`core/config.py:72`） | `services/llm_openai.py` | OpenAI Chat Completions 兼容：`POST {LLM_BASE_URL}/chat/completions`，非流式与 `stream_options.include_usage` 流式 | `LLM_BASE_URL`（`:76`）/ `LLM_MODEL`（`:77`）/ `LLM_API_KEY`（`:78`）/ `LLM_EXTRA_BODY`（`:82`）/ `LLM_QUESTION_EXTRA_BODY`（`:85`） |
| `cloudbase`（**两份 env 的当前值**，开发期口径） | `services/llm_cloudbase.py` | 腾讯云 CloudBase Agent **ACP**：JSON-RPC 2.0 `session/prompt`，响应为 SSE（`agent_message_chunk` 正文 / `agent_thought_chunk` 思考 / `agent_phase` 阶段 / `usage_update` 用量 / 终态 `result.stopReason`） | `CLOUDBASE_ENV_ID`（`:89`）/ `CLOUDBASE_AGENT_ID`（`:90`）/ `CLOUDBASE_API_KEY`（`:91`）/ `CLOUDBASE_AGENT_URL`（`:93`） |

共享类型在 `services/llm_base.py`（`LlmError` / `CallResult` / `ensure_complete`），单独成模块以打破「门面 ↔ 适配器」循环导入，并使两条链路的 `isinstance` 判定指向同一个类对象。两家适配器均为 httpx **同步**客户端，并各自实现同一组符号：`is_configured()`（`llm_openai.py:40`、`llm_cloudbase.py:50`）、`model_label()`（`:49`、`:59`）、`prompt_meta()`（`:210`、`:218`）、`stream()`（`:331`、`:302`）。`LLM_TIMEOUT_SECONDS`（`core/config.py:73`）两套共用；`CLOUDBASE_TIMEOUT_SECONDS` 已随 `c660727` 移除且**刻意不恢复**（一个含义不留两个旋钮）。

四个跨供应商的口径差异（改 AI 链路前必读）：

1. **调用地址**：`CLOUDBASE_AGENT_URL` 非空时优先，否则按 `https://{CLOUDBASE_ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/{CLOUDBASE_AGENT_ID}/acp` 拼接（`llm_cloudbase._resolve_url()`，`:64`）。旧文档里的 `CLOUDBASE_ACP_URL` 是更早的旧名，现名 `CLOUDBASE_AGENT_URL`。
2. **系统提示与生成参数**：`openai` 走标准 `system` role 且 `max_tokens` 生效；`cloudbase` 只能把系统提示**前缀拼接**进用户输入，且 `max_tokens` 与 `extra_body` **被适配器忽略**——即 `AI_MAX_OUTPUT_TOKENS`（`core/config.py:107`）的硬截断与 Qwen 思考开关（`LLM_*EXTRA_BODY`）在该供应商下**静默失效**，输出长度只由提示词软约束，思考过程亦不可关闭。
3. **用量与结束原因**：`used_tokens` 在 `openai` 下是 `usage.total_tokens`（与按量计费口径一致），在 `cloudbase` 下是平台 `usage_update.used` 原值——实测量级不稳（同一供应商下出现过 254 与 19400/19641/19832），**不可作单次计费依据**；正常结束原因分别是 `stop` 与 `end_turn`/`stop_sequence`。因此 `ai_usage_logs.model` 改取 `llm_service.model_label()`（`openai` = 真实模型名，`cloudbase` = Agent ID），跨供应商做成本统计必须按供应商分段。
4. **首片延迟**：实测 `openai`（百炼）1.15~2.81s，`cloudbase` 8.6~16.7s（占总耗时 83%~88%），因为 ACP 的思考事件先于正文到达且不可关闭。SSE 逐字体验在 `cloudbase` 下明显退化，证据见 `backend/test/docs/s30-llm-provider-switch-report.md` §2.2。

**多轮对话仍是无状态的**：`ai_chat_service._history_block`（`ai_chat_service.py:138`）把最近 `cfg.context_turns` 轮历史（`AI_CONTEXT_TURNS` 默认 4，`core/config.py:110`）拼进**单个** prompt，服务端不维护模型侧会话上下文。

**流式刻意不自动重试**：非流式 `prompt_meta` 按 `AI_MAX_RETRIES`（`core/config.py:109`）重试瞬时故障；`LlmStream` 不重试——重试意味着重新生成整段回答，而增量可能已推给用户，重发会导致正文重复，故瞬时故障由前端「停止 / 重试」兜底。

**上线切换只改一行**：`.env.prod` 的 `LLM_PROVIDER` 改为 `openai` 即可（该文件 `:48` 已就地标注 ⚠⚠）；两套凭证常驻 env，无需改代码、无 SQL 迁移。注意仓库内现存的百炼 `LLM_API_KEY` 已实测 **401 `invalid_api_key` 失效**，切换前必须先在百炼控制台重置（`b712d81` 的 s30 报告 §2.1）。

配置项名称与用途的完整清单见 `.qoder/backend/app/core/config.py.md`（**本文档不记录配置值**）。

### 11.2 已交付范围（2026-10-17，backend `1600074` + frontend `0052108`）

| 端 | 已实现 |
|---|---|
| 后端 | `/api/ai/*`（问答、路线讲解、答题讲解）与 `/api/admin/ai/*`（知识库、配置、题目工坊、调用记录）；6 个 AI 服务；`docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql`；冒烟 `s26` 47/47 通过（含真实 Agent 调用） |
| 小程序 | `pages/ai-chat` 聊天页；底部「情报」tab 换防为「AI 问答」；quiz 降级子页由首页情报卡进入 |
| 数据库 | 6 张 AI 表：`ai_knowledge`、`ai_conversations`、`ai_messages`、`ai_generation_jobs`、`ai_generated_questions`、`ai_usage_logs` |

### 11.3 明确未交付（勿当作已完成）

| 项 | 状态 | 备注 |
|---|---|---|
| 管理后台 AI 子页面：知识库 / 配置 / 题目工坊 | **待开发** | 后端接口已就绪（`routes/ai_admin.py` 15 个端点，守卫菜单码 `ai_knowledge`/`ai_config`/`ai_workshop`）；`admin/src/router/menus.ts` 未登记 |
| 管理后台 AI 子页面：运行概览 / 调用记录 | **待开发** | 菜单码 `ai_overview`、`ai_logs` 已由 `022:14-15`、`:23-24` 种入，但**后端接口亦未实现**：`backend/app/api/` 全量 grep 无路由引用这两个码，`AiUsageLog` 在 api 层零引用 |
| `node-detail` AI 讲解面板 | **待开发** | `GET /api/ai/route-guide/{node_id}` 已就绪 |
| 答题页「AI 讲解」按钮 | **待开发** | `GET /api/ai/quiz-explanation/{question_id}` 已就绪 |
| usage / cost 统计页 | **待开发** | `ai_usage_logs` 表已建、写入侧 `ai_usage_service.py` 已实现，**读取侧接口未实现**（见上「调用记录」） |
| 小程序真机真实模型全链路 | **待验证** | 后端侧真实调用已于 2026-10-22 实测通过（`cloudbase` 供应商下非流式 / 流式 / 出题三条链路，见 `b712d81` 与 `backend/test/docs/s30-llm-provider-switch-report.md`）。本机 Clash fake-ip 会把网关域名解析到 `198.18.x.x`，但请求经代理正常出网，**已不需要 `dns_shim` 兜底**；真机侧（小程序客户端 → 生产后端 → 上游）仍待验证 |

> **更正（2026-10-17）**：上表首行原写「管理后台 5 个 AI 子页面（知识库/配置/题目工坊/运行概览/调用记录）| 待开发 | 后端接口已就绪」，把「接口已就绪」套用到全部 5 个页面。实测：`022_ai_admin_menus.sql:14-27` 种入 5 个菜单码，但 `backend/app/api/routes/ai_admin.py` 的 15 个端点只覆盖 3 个（`ai_knowledge` 6 个 `/knowledge*`、`ai_workshop` 7 个 `/jobs*`+`/drafts*`、`ai_config` 2 个 `/config`）；`ai_overview`、`ai_logs` 在 `backend/app/api/` 下零命中，`AiUsageLog` 仅被 `models/models.py` 与写入侧 `services/ai_usage_service.py` 引用。故拆为两行。同样的口径修正见 `REQUIREMENTS.md` §10.6、§13 与 `CHANGELOG.md`。

**题目工坊已实现的部分**：管理后台 `admin/src/components/AiGenerateDialog.vue` 已落地（表单字段 `:55-61`、`:326-366`；`AbortController` 中断 `:128-164`、`:170-173`；行内编辑 + `validateItem` `:86-104` 与后端 `_validate_question` 对齐；深监听签名比较 `:106-118` 避免递归更新；`batchSaveAiQuestions` `:276-305`，`failures.index` 为 1 基）。**注意：这与上表「题目工坊子页面待开发」并不矛盾** —— 已落地的是嵌在题库页的生成对话框，待开发的是独立的题目工坊管理页。

### 11.4 异常映射与超时口径

`routes/ai.py:42-47` 的 `AI_ERRORS` 是四元组（`AiDisabledError`、`AiLimitError`、`llm_service.LlmError`、`ValueError`；前三者均为 `ValueError` 子类，故捕获顺序不影响结果），`ai_http_error()`（`:50-58`）按 `isinstance` 判定映射：`AiDisabledError`→**403**（`:53`）、`AiLimitError`→**429**（`:55`）、`LlmError`→**502**（`:57`）、其余 `ValueError`→**400**（`:58`）。管理端 AI 路由（`routes/ai_admin.py`）复用同一函数，故**切换上游供应商不影响错误码口径**；`LLM_PROVIDER` 取值非法也走 `LlmError`→502。

**流式端点的错误只能走事件**：`POST /api/ai/chat/stream`（`:110`）在返回 `StreamingResponse` 之前完成全部前置校验（开关 / 限额 / 输入 / 会话归属）与 `LlmStream` 构造，这类失败仍是普通 JSON + 403/429/400/502；一旦 200 与响应头发出，**状态码无法再改**，中途的上游故障只能作为 `error` 事件下发（`:164`）。事件序列为 `start`（`:147`）→ `delta`*（`:155`）→ `done`（`:170`）。响应头带 `X-Accel-Buffering: no`（`_STREAM_HEADERS`，`:78`）让 nginx 只对本次响应关闭缓冲——生产 nginx 默认 `proxy_buffering on` 会把整条流缓冲完再一次性吐给小程序，逐字效果尽失，而 nginx 配置文件不在本仓库内（见 §12.2「nginx 配置文件」行）。

前端超时口径（AI 问答是**全项目超时最长的接口**）：

| 调用 | 超时 | 依据 |
|---|---|---|
| 普通接口缺省 | 10s | `frontend/services/request.js:75` |
| 非流式 `POST /ai/chat` | **60s** | `frontend/services/ai.js:41` |
| 流式 `POST /ai/chat/stream` | **120s**（未显式传参时用 `STREAM_TIMEOUT_MS`） | `frontend/services/request.js:186`、`:329` |

流式请求需 `enableChunked: true`（`request.js:328`），要求基础库 2.20.2 及以上；`supportsChunked()`（`:281-283`）判定不支持时，`ai.js:95` 降级为 `plainChatStream`（`:51-73`）——把一次性 `chat()` 的整段回答当作单个 `delta` 推出，使页面只有一条渲染路径（此时 `abort` 只停止渲染，后端仍会落库，重进会话即可看到）。

---

## 12. 生产部署架构

### 12.1 拓扑

```
   公网 HTTPS 443
        │
        ▼
   ┌─────────────────────────────────────────┐
   │ nginx（配置文件不在本仓库，待确认）        │
   │  · 静态资源：admin 构建产物               │
   │  · location /api → 127.0.0.1:8010        │
   │  · ⚠ 缺 proxy_http_version 1.1 /          │
   │      Upgrade / Connection 三行            │
   └──────────────┬──────────────────────────┘
                  ▼
   ┌──────────────────────────┐    ┌──────────────────────────┐
   │ uvicorn :8010（单进程）    │───▶│ openGauss                │
   │ systemd 托管服务         │    │ 6.0.1 / 端口 5432        │
   └──────────────────────────┘    └──────────────────────────┘
```

### 12.2 已确认事实

| 项 | 事实 | 依据 |
|---|---|---|
| 域名 | `swkjdj.sz-watech.com`，HTTPS 443 | `frontend/services/config.js:9`；`docs/迭代记录.md` 生产化条目 |
| nginx 反代 | `/api` → `127.0.0.1:8010` | `docs/迭代记录.md` |
| nginx 配置文件 | **不在本仓库**，服务器上的路径**未核实**；反代规则由运行行为反推（`/api` → `127.0.0.1:8010`，静态资源为 admin 构建产物） | 全仓 grep 无任何 nginx 配置文件 |
| 服务器部署 | 代码目录 `/mnt/data/longmarch-run`；systemd 服务 `longmarch-backend`，环境变量 `APP_ENV=prod`；日志 `journalctl -u longmarch-backend`。Python 3.14，venv `backend/.venv` | 目录/服务名/`APP_ENV`：`backend/test/docs/s26-ai-question-backend-report.md:94-96`；Python 版本与 journalctl 用法来自运维会话实测，**非仓库内证据** |
| 生产 openGauss | **6.0.1**（Ubuntu），库 `longmarch`，端口 **5432**，应用账号非开发库的 `gaussdb`。与开发容器 **7.0.0-RC3 / 5118** 存在**版本偏斜**——涉及 DDL 与方言的改动不能只靠开发库验证 | `backend/.env.prod:7` 注释与 `:9` 连接串；`docs/迭代记录.md` `fc2597e` 条目。**非直连实测**，兼容模式未知 |
| 生产迁移补跑 | `docker compose run --rm database-init`，只执行 `schema_migrations` 中缺失的编号；手工 `gsql -f` 后**必须回填**该表，否则下次重复执行 | `docker/init/init-db.sh`；PROJECT.md §数据库迁移执行 |
| `.env.prod` 占位符现状 | `DATABASE_URL`（`:9`）与 `ADMIN_PASSWORD`（`:38`）**已填入真实值**（`:8`、`:37` 的「⚠ 占位」注释均已过期）；`JWT_SECRET`（`:12`）**仍是 `REPLACE_WITH_STRONG_RANDOM_SECRET`**。大模型两套凭证**同时常驻**：`LLM_PROVIDER=cloudbase`（`:50`，上方 `:48` 有「⚠⚠ 上线前必须改为 `openai`」标记）、`LLM_API_KEY`（`:58`，2026-10-22 实测 **401 `invalid_api_key`，已失效**）、`CLOUDBASE_API_KEY`（`:68`，实测可用）。故「上线切回百炼」不是改 key，而是**先换一把有效 key 再改 `:50` 一行**。服务器上就地改过的副本是否与仓库一致**无法核实** | `backend/.env.prod` 逐行实读（值不录入本文档）；key 有效性见 `b712d81` 与 `backend/test/docs/s30-llm-provider-switch-report.md` §2.1 |
| 小程序合法域名 | **request 合法域名已配置**；**socket 合法域名未配置** | `docs/迭代记录.md` |
| 管理后台环境切换 | 单一变量 `VITE_API_PROXY`：`.env.development:3` / `.env.prod:4` | — |
| Vite 代理 | `admin/vite.config.ts:11-17`，`/api` → 目标，`changeOrigin: true`、`ws: true` | — |
| 后端环境切换 | `APP_ENV` **只从系统环境变量读取**（写进 `.env` 不生效，因为 env 文件选择发生在解析 `.env` 之前）；`APP_ENV=prod` 加载 `.env.prod`，否则 `.env` | `core/config.py:11-15` |
| 小程序环境切换 | `services/config.js` 按运行环境 `envVersion` 自动判定：`trial`/`release` 恒连远程；`develop` 由常量 `DEV_TARGET`（`:11`，`'remote'`/`'local'`）决定，`local` 时真机改用硬编码 `LAN_IP`（`:15`） | — |
| 交付产物（均 gitignore） | `backend-update.tar.gz`、`sql.tar.gz`、`admin/dist.zip` | `.gitignore` |
| `admin/dist.zip` 构建 | `admin/scripts/zip-dist.mjs`，**零依赖手写 Zip**（`zlib.deflateRawSync` + 自实现 CRC-32 + MS-DOS 时间戳；安全护栏 `:17-19`、`:65`、`:127-139`） | — |
| `vite.config.ts` **无 build 段** | 使用 Vite 默认构建配置 | `admin/vite.config.ts` |

### 12.3 阻塞级缺陷：wss 在 443 不可用

**现象**：客户端 WebSocket 关闭码 1006；用 `curl` 带 `Upgrade` 头直连返回 **FastAPI 的 404**（说明请求到达了后端但未被识别为 WS 升级）。

**根因**：nginx 未转发 `Upgrade` / `Connection` 头，且默认 `proxy_http_version 1.0`。

**修复需要三行**（尚未实施）：
```
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

**叠加因素**：微信公众平台**未配置 socket 合法域名**，即使 nginx 修好，体验版/正式版仍会被微信拦截。

**当前影响**：管理后台的实时刷新退化为「进入页面时拉取 + 手动刷新」，功能可用但非实时；小程序侧本就不依赖 WS 做数据同步，影响更小。

### 12.4 迁移执行机制

| 环节 | 机制 |
|---|---|
| 脚本位置 | `docker/init/001_*.sql` … `022_*.sql` |
| 执行者 | `docker/compose.yml:30-44` 的一次性服务 `database-init`（`restart: "no"`、`depends_on: opengauss: service_healthy`），经显式 `entrypoint: ["/bin/bash", "/docker/init/init-db.sh"]`（`:42`）运行 |
| 执行时机 | **首次初始化与后续补跑走同一条路径**，均由 `database-init` 执行；`opengauss` 主服务只挂数据卷 `opengauss-data:/var/lib/opengauss`（`:16-17`），**不挂 `./init`、从不执行迁移脚本** |
| 脚本来源 | 仅 `database-init` 挂载 `./init:/docker/init:ro`（`:44`） |
| 执行顺序 | `init-db.sh:30` 的 `for sql_file in /docker/init/*.sql` 按 shell 通配的**字典序**逐个处理 |
| 已执行登记 | `schema_migrations` 表；`init-db.sh:17` 传 `-v ON_ERROR_STOP=1` |
| 编写约束 | **`docker/init/SQL_CONSTRAINTS.md` 为权威，写迁移前必读** |

> **更正（2026-10-17）**：上表原「执行时机」行称首次初始化由 **openGauss 官方入口**执行 `/docker/init` 下脚本，并原「补跑机制」行把 `database-init` 描述为仅用于**已存在的库补跑**。二者均错。依据：`docker/compose.yml` 全文实读——`opengauss` 服务（`:4-28`）的 `volumes` 只有数据卷一项（`:16-17`），**没有** `./init` 挂载，故其官方入口看不到任何迁移脚本；唯一挂载 `./init:/docker/init:ro` 的是 `database-init`（`:44`），且它用 `entrypoint`（`:42`）**覆盖**了镜像默认入口。因此不存在「官方入口跑首次初始化 + `database-init` 补跑」两套机制，只有 `database-init` 一套，首次建库亦由它执行。该错误由第四批部署脚本建档发现（详见 `.qoder/docker/init/init-db.sh.md`、`.qoder/docker/compose.yml.md`）。

**`init-db.sh` 的执行与登记不原子**：`:34` 执行 `-f "${sql_file}"`、`:35` 才单独 `INSERT INTO schema_migrations`，是**两次独立的 gsql 调用**。脚本执行成功但登记失败（进程被杀、连接中断）时，下次启动会**重复执行**该脚本；反之若脚本中途失败，`ON_ERROR_STOP=1` 使其整体回滚、登记也不会写入，重跑安全。因此下段「重复执行会破坏数据或中止的脚本」的风险窗口不止于人为重跑。

**关键约束（摘自 `SQL_CONSTRAINTS.md`，151 行 / §1–§7）**：

- **§1.1 禁用** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`。替代写法两种：**方式 A（推荐、幂等）= DO 匿名块 + `information_schema.columns` 判定**（`:24-36`）；**方式 B = 直接 `ADD COLUMN` 不加 `IF NOT EXISTS`**（`:37`，仅当迁移编号唯一且确认从未跑过时可用，本身不幂等）
- **§1.2 `CREATE INDEX IF NOT EXISTS` 需谨慎使用**（`:43`）
- **§1.4 派生表（子查询）必须显式起别名**（历史事故 `f413ac6`）
- **§1.5 其它已知不支持/易踩的语法**表格另含两条：`ALTER TABLE ... DROP COLUMN IF EXISTS` → 同样改用 DO 块 + `information_schema` 判定（`:85`）；`INSERT ... ON CONFLICT DO UPDATE` → **生产版本可能不支持**，改用 `WHERE NOT EXISTS` 或先 UPDATE 再 INSERT（`:87`，措辞是「可能」而非绝对不支持）
- **§2.1 必须包事务**（首尾 `START TRANSACTION; ... COMMIT;`）；**§2.2 必须幂等**；**§2.3 不得删除数据**（禁 `DROP TABLE`/`TRUNCATE`/无 WHERE 的 `DELETE FROM`）；**§2.4 重算类 UPDATE 必须收敛**——WHERE 须限定 `biz_key`、`delta <> new_delta` 等条件，避免全表覆写
- **§3.1 已发布（已在生产执行过）的编号脚本不得修改**，需要变更就新增编号；**§3.2 编号必须严格递增**，禁止 `010a_xxx.sql` 之类插入编号
- **§4 每份 SQL 顶部必须有三段中文注释**：变更目的 / 影响面 / 回滚

> **更正（2026-10-17）**：上列原为 8 条无出处列表，其中两条与权威文档不符，现已逐条标注 `SQL_CONSTRAINTS.md` 章节号。① 原写「加列必须用 `DO $$ … EXCEPTION WHEN undefined_column/duplicate_column … $$` 块」——该文档 §1.1 方式 A 实为 **DO 匿名块 + `information_schema` 判定**（`:24-36`），全文**没有** `EXCEPTION WHEN` 写法，原表述系凭空构造。② 原把「Oracle 兼容模式 A 下 `''` 落库为 NULL」列为「摘自 `SQL_CONSTRAINTS.md`」——对该文件全文检索无此内容，其真实出处是 ORM 侧的 docstring `backend/app/models/models.py:546`（「本库空字符串按 NULL 存储（Oracle 兼容模式），可空文本列读取时 None 即空值」），已从本列表移出，另见 §13.2。③ 原列表漏了 §1.5 的 `DROP COLUMN IF EXISTS` 与 §2.4「重算类 UPDATE 必须收敛」，后者正是 `017_points_ledger.sql:43` 无 WHERE 全表 UPDATE 所违反的条款。两处不符由第四批 SQL 建档发现。
>
> 补充事实（非摘自约束文档，系实读 `docker/compose.yml` 所得）：`SQL_CONSTRAINTS.md` §3.2 称「`init-db.sh` 按文件名字典序执行」，与上文 §12.4 表格更正后的结论一致——执行者是 `database-init` 服务而非 openGauss 官方入口。

**历史包袱**：`002`、`005`、`013`、`014`、`015`、`017`、`019`、`020` 使用了 §1.1 明令禁用的 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（依次 4 / 18 / 2 / 1 / 3 / 5 / 3 / 1 处，均早于约束文档）；另 `004`（`:5-6`）与 `008`（`:9`）用的是不加 `IF NOT EXISTS` 的裸 `ADD COLUMN`（§1.1「方式 B」），重复执行即报列已存在。其中 `013` **重跑必中止**（首跑 `:35` DROP 掉 `daily_quotes.date` 后，重跑时 `:14`/`:31` 仍引用该列 → `UndefinedColumn` 整体回滚，且原日期值无备份不可恢复）；`019` **重跑会静默回退数据**（详见下段第 4 项）。

> **更正（2026-10-17）**：上段原列 `005`、`013`、`015`、`017`、`019`、`020` 六个脚本，**漏了 `002` 与 `014`**，且未区分「用了禁用语法」与「用了非幂等的裸 ADD COLUMN」两类。依据：对 `docker/init/*.sql` 全量 `grep -c "ADD COLUMN IF NOT EXISTS"` 实测命中 8 个文件（002=4、005=18、013=2、014=1、015=3、017=5、019=3、020=1）；`grep -n "ADD COLUMN"` 排除 `IF NOT EXISTS` 后只剩 004:5、004:6、008:9 三处。`002` 的漏列由第四批 SQL 建档发现（详见 `.qoder/docker/init/002_route_node_config.sql.md` §9）。

**重复执行会破坏数据或中止的脚本**（第四批 SQL 建档对 `001`–`022` 逐个静态审读，未连库实测）：共六类——

1. **`002_route_node_config.sql:8-36` 的 UPDATE 无 WHERE 子句**：`id` 1–10 的 `latitude`/`longitude` 被硬编码坐标**无条件覆盖**（`:10-19`、`:23-32`），管理端在「路线点位」页改过的坐标一经重跑即丢失。同一条 UPDATE 里的另两列**是**幂等的——`sort_order`（`:35`）用 `COALESCE(NULLIF(sort_order, 0), id)`、`is_enabled`（`:36`）用 `COALESCE(is_enabled, TRUE)` 且 `:41` 已置 NOT NULL 故重跑时恒非空——**只有经纬度不是**。
2. **`010_admin_identity.sql:106-123` 的菜单与角色种子是裸 INSERT**（全文件 `ON CONFLICT` 命中 0 次），重跑撞 `uq_admin_menus_code` 唯一约束并整批中止。
3. **`004`（`:5-6`）、`008`（`:9`）的裸 `ADD COLUMN`** 重跑报「列已存在」。
4. **`013_daily_quote_cycle.sql` 重跑必中止且不可恢复**：首跑 `:35` 已 `DROP COLUMN daily_quotes.date`，重跑时 `:14`/`:31` 仍引用该列 → `UndefinedColumn` 整批回滚；且该 DROP 属实质删数据（与 `SQL_CONSTRAINTS.md` §2.3 精神相悖），原日期值**无备份**，仅能从 `sort_order` 顺序与 `MIN(date)` 间接推断。
5. **`019_sport_backfill_carry.sql:15-28` 重跑会静默回退已算对的数据**：其重算 UPDATE 带 `p.delta <> c.delta` 收敛条件（符合 §2.4），但计算口径是**封顶 20000 步**，而运行期 `points_service.walk_chain` **不封顶**——故任何在 019 之后同步过运动数据的用户，其 `walk:` 行一经重跑即被回退成封顶值，日步数 >20000 者总分被压低。**分歧的成因已查证**（提交 `9cb65b8`，2026-10-15）：无上限是那次「步行积分取消单日 20000 封顶」业务规则调整后的现行口径，`017`/`019` 是调整之前冻结的历史迁移，二者不是并存的两套有效规则。**回退可自愈**：`backend/app/main.py:48` 启动时执行 `points_service.recompute_walk_all(db, fix=True)`（`:338`）按 `daily_sport` 全量核对修复，故重跑 019 造成的压低会在后端下次启动时被纠正，属**可恢复**而非永久损坏；但 019 的 DDL 部分对老库不可省（缺 `source`/`synced_at`/`sync_status` 列会使同步接口 500），不能以「不再跑 019」规避。口径分歧登记为 `.qoder/PROJECT.md` §8「代码级技术债」第 38 项。
6. **`017_points_ledger.sql:43` 是无 WHERE 的全表 UPDATE**：`UPDATE quiz_records SET points = LEAST(correct_count * 2, 10)`。与第 1、5 项不同，它是 `correct_count` 的**纯函数**，重跑结果收敛（不会「跑两次不一样」），真实风险是**无条件覆写会抹掉任何人工调整过的 `points`**，且违反 §2.4「WHERE 必须限定收敛条件」。

> **更正（2026-10-17）**：本列表原为 3 项，且上文「历史包袱」段原称「`017`、`019` 含重算类 UPDATE，**不可重复执行**」——该表述把两者混为一谈且不准确。实读源码后：`019` 确属**重跑回退数据**（现第 5 项），`017` 的重算 UPDATE 数学上**收敛**、问题是全表覆写（现第 6 项），而真正**重跑必中止**的是原先未列入的 `013`（现第 4 项）。`011`、`012`、`014`、`015`、`016`、`018`、`020`、`021`、`022` 经审读为语义幂等、可安全重跑。三处发现均由第四批 SQL 建档（`011`–`016`、`017`–`022` 两组）提出并经复核。

**`009` 在空库上可能直接失败（待确认）**：`009_org_serial.sql:12` 是 `SELECT setval('organizations_id_seq', COALESCE((SELECT MAX(id) FROM organizations), 0))`，`:11` 注释自称「空表时为 1」；但按 PostgreSQL 语义 `setval(seq, 0)` 低于默认 `minvalue=1` 会**报错**而非返回 1。而 `organizations` 表在 `docker/init/*.sql` 中**没有任何 INSERT**（全量 grep 0 命中），组织树是后端 `backend/app/data/seed.py:423` 才写入的——因此**由 `init-db.sh` 从零初始化的库在执行到 009 时该表必为空**。openGauss 的实际行为未经实测（本次建档禁止连库），故记为待确认；核实方式见 `.qoder/docker/init/009_org_serial.sql.md` §9。

**生产迁移缺口（已发生两次）**：`docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql` 已在本地 openGauss 应用并登记 `schema_migrations`，但按仓库根 `agents.md` §1.3「`docker/` 不自动提交」规则**未入库**，因此生产库缺失这两张迁移。部署新后端前**必须**比对 `schema_migrations` 与 `docker/init`，按 [[opengauss-migration-gap]] 流程补跑，否则启动即报 `UndefinedTable`/`UndefinedColumn`。

### 12.5 openGauss 兼容性补丁

`core/database.py:11-43` 对 `PGDialect._get_server_version_info` 打**进程级 monkey-patch**：

- **背景**：openGauss 的 libpq 兼容层把 `server_version_num` 报告为 `90204`（即 PostgreSQL 9.2.4），而 `version()` 返回 `openGauss x.y.z …`，SQLAlchemy 的 PG 方言无法解析，抛 `Could not determine version from string`。
- **处理**：识别到 `openGauss` 时直接返回 `(9, 2, 4)`，其余走原生解析。
- **收敛**：`:42` `if settings.DATABASE_URL.startswith("postgresql")` 才打补丁，SQLite（测试/本地）不受影响。
- **副作用**（`:24-26` 注释明确）：伪造版本号会让 SQLAlchemy 走 9.2 分支，**关闭窗口函数、`ON CONFLICT`、`JSONB` 去重等新特性的方言适配**。本项目 SQL 均为库内直接执行或基础 CRUD/聚合，不依赖上述自动方言特性，故当前安全。显式 `.over()` 窗口函数仍可用（`rank_service.py:40`、迁移 `013`、`019`）。
- **退出条件**（`:27-28`）：升级 SQLAlchemy 主版本后须回归验证，若官方方言已能解析 openGauss 应删除补丁。验证脚本 `backend/test/s21_opengauss_compat.py`。

其他兼容事实：SQLite 分支设 `check_same_thread=False`（`:45-48`，FastAPI 多线程需要）；JSON 列用 `JSON` 而非 `JSONB`；`"desc"` 是保留字需引号；`009` 做过序列修复。

---

## 13. 数据库结构总览

**34 张业务表 + `schema_migrations`**（`schema_migrations` 按设计不建 ORM 模型）。ORM 覆盖率 **34/34**，由 `backend/test/s21_opengauss_compat.py:56-60` 的用例 C03 校验。

### 13.1 分组清单

| 分组 | 表 |
|---|---|
| 配置与内容 | `system_settings`、`activity_settings`、`route_nodes`、`persons`、`person_nodes`、`daily_quotes`、`questions`、`medal_defs`、`organizations` |
| 用户业务 | `users`、`daily_sport`、`lit_nodes`、`quiz_records`、`daily_questions`、`quiz_answers`、`points_log`、`user_medals`、`user_event` |
| 身份 / RBAC / 审计 | `invite_codes`、`user_identities`、`bind_requests`、`qr_login_sessions`、`admin_menus`、`admin_roles`、`admin_role_menus`、`admin_user_roles`、`audit_logs`、`import_previews` |
| AI 智能中心 | `ai_knowledge`、`ai_conversations`、`ai_messages`、`ai_generation_jobs`、`ai_generated_questions`、`ai_usage_logs` |
| 迁移基础设施 | `schema_migrations`（无 ORM 模型） |

字段级说明（含类型、可空性、默认值、业务含义、索引、数据来源与更新规则）见 `.qoder/backend/app/models/models.py.md`；DDL 侧见 `.qoder/docker/init/*.sql.md`（逐脚本 10 章建档，含 ORM 与 DDL 分歧、幂等性与 `SQL_CONSTRAINTS.md` 违规清单）。

### 13.2 全库共性事实

- **无任何 CHECK 约束**；所有「枚举」都是 `VARCHAR` + 应用层常量校验。
- **13 处逻辑外键没有数据库级 FK 约束**（有意为之，便于迁移与数据修复）。逐列清单与 DDL 依据见 `.qoder/backend/app/models/models.py.md` §4.7。
  > **更正（2026-10-17）**：本条原写「11 处」。经对 `backend/app/models/models.py` 全文做多行感知的声明解析核实：`ForeignKey(...)` 声明共 **23 处**，与 `docker/init` 中 23 处 `REFERENCES` 一一对应；其余承载引用 id 但无 FK 声明的列共 **13 个**。差额 2 列来自迁移 `015_invite_admission.sql`（`:12` 新增 `invite_codes.org_id`、`:26` 新增 `users.invite_code_id`），即「11」是 015 之前的旧口径。另核实 `user_identities` 与 `bind_requests` 的 `app_id`/`openid`/`unionid`（`models.py:401-403`、`:424-426`）是微信侧自然键而非指向本库表的引用 id，**不计入**逻辑外键。
- 唯一约束承载幂等语义，最典型的是 `points_log (user_id, biz_key)`。
- 时间戳存在**两套默认值写法**（`default=datetime.utcnow` 与 SQL 侧 `DEFAULT`），ORM 与 DDL 需分别核对。
- 毫秒时间戳用 `BigInteger`（`quiz_records.answer_at`，`models.py:287`）。
- `Numeric` 列（`route_nodes.latitude`/`longitude`、`daily_sport.distance`）在 ORM 侧注解为 `Mapped[float]`（`models.py:55-56`、`:246`），但 **psycopg2 运行时实际返回 `decimal.Decimal`**（开发库实测 `Decimal('25.885000')`、`Decimal('4.27')`）。`Mapped[...]` 只是 typing 元数据、**不做类型强转**，故注解与运行时类型不符；对外由 Pydantic 序列化为 float。在 service 层直接对这些字段做算术或比较时需注意 Decimal/float 混用。

### 13.3 种子数据：两条互补链，互不重叠

| 链 | 位置 | 内容 |
|---|---|---|
| SQL 种子 | `docker/init/*.sql` | 权限骨架（`admin_menus` / `admin_roles`）、系统配置、活动默认值 |
| Python 种子 | `backend/app/data/seed.py`（`init_seed`，启动时幂等执行） | 面向用户的内容：**10 个路线节点**（id 1-10）、**15 道题**（id 1-15）、**12 枚勋章**、**13 位人物**、**5 条金句**（仅在表空时写入）、**13 个组织**（id 1-13） |

### 13.4 已知数据问题

`admin_menus.sort_order` 存在**重复值**：`invites`=10 与 `ai_overview`=10 冲突，`activity`=11 与 `ai_knowledge`=11 冲突。菜单排序不稳定（**待修复**，不阻塞功能）。

---

## 14. 架构不变量清单（修改代码前必读）

| # | 不变量 | 依据 |
|---|---|---|
| 1 | 后端是唯一数据权威，前端不做业务数据本地缓存 | `frontend/design.md:261`；小程序各页 `onShow + refresh()` |
| 2 | 小程序跨 tab 一致性 = `onShow + refresh()` + 单调递增 `_requestId` 竞态守卫 | 各页实现 |
| 3 | 小程序启动状态机在 `pages/launch/launch.js`，**不在 `app.js`**（`app.js` 仅 26 行，是极薄的全局状态容器，无任何生命周期钩子） | `frontend/app.js`；`app.json:2-3` 把 `launch` 放首位 |
| 4 | 401 → 单飞静默重登 → **精确重试一次**；仍失败才清会话 | `services/request.js:129-160`、`services/auth.js:14-15` |
| 5 | 准入控制走 HTTP 响应头 `X-Account-Status` / `X-Activity-Status`，不靠响应体字段 | `api/deps.py:46-81`、`services/request.js:81-91` |
| 6 | 小程序响应 camelCase（`CamelModel`），管理后台响应 snake_case（`Admin*`） | `schemas.py` |
| 7 | 无响应信封，2xx 直接返回业务 payload | `services/request.js:77`；`admin/src/api/request.ts:27-51` |
| 8 | 权限不进令牌，`typ=user` 管理员每请求查库重建 | `core/security.py:38-39`；`api/deps.py:142-147` |
| 9 | 所有 Canvas 使用 `type="2d"` 同层渲染，**全项目零 `cover-view`** | 小程序各页 WXML |
| 10 | 离屏 Canvas 一律 try/catch → null 降级 | 小程序 `utils/routeCanvas.js` 等 |
| 11 | Storage 访问只在 `services/` 层，页面 JS 零 Storage 读写 | 24 处调用全在 services |
| 12 | `session_key` 不落库、不打日志 | `core/wx.py:3-4` |
| 13 | Excel 导入任一行出错则整批阻断，确认阶段用条件 UPDATE 原子消费 token | `services/import_service.py:140-175` |
| 14 | 写 SQL 迁移前必读 `docker/init/SQL_CONSTRAINTS.md` | 该文档为权威 |
| 15 | `docker/` 改动默认不提交，除非用户明确要求 | 仓库根 `agents.md` §1.3 |
| 16 | 一个任务一个提交，提交后立即推送，并在 `docs/迭代记录.md` 追加记录 | 仓库根 `agents.md` §1 |

### 14.1 Canvas 盖 DOM 的既定解法

小程序 canvas 原生层会盖住 DOM 浮层，且 `visibility` 无效。项目采用的解法（`pages/ceremony/ceremony.js:228-240` `finalizeScene`）：动画结束后用 `canvasToTempFilePath` 导出末帧，然后 **`wx:if` 移除 canvas、换成 `<image>`**，此后 DOM 数据卡片即可正常层叠在上。新增「canvas 上盖按钮/面板」需求时必须复用此模式。

---

## 15. 已知架构级限制与风险

| # | 限制 | 影响 | 缓解现状 |
|---|---|---|---|
| 1 | WS 连接表、限流计数、access_token 缓存均为**进程内内存态** | 无法水平扩容；重启即丢 | 当前单进程部署，未暴露 |
| 2 | openGauss 版本 monkey-patch 是**进程级全局**修改 | 升级 SQLAlchemy 可能失效或产生新行为 | `startswith("postgresql")` 收敛 + `s21` 回归脚本 |
| 3 | **未引入 Alembic**，迁移靠编号 SQL + `schema_migrations` | 无自动 downgrade；已发布脚本不可改 | `SQL_CONSTRAINTS.md` 约束 + 补跑流程 |
| 4 | 用户头像**未上传到服务端**，仅本地持久化（`auth.js:18-34` `persistAvatar`，未导出） | 换设备头像丢失 | 已知取舍 |
| 5 | **调试端点 `POST /api/quiz/reset` 与 `POST /api/sport/add` 在生产环境暴露** | 可被用于刷分 | **风险项，建议加环境开关**（尚未处理） |
| 6 | AI 知识库检索为**关键词匹配**，非向量检索 | 召回质量有限 | Phase A 取舍 |
| 7 | `wx_web` 网页授权绑定通道半成品 | PC 侧身份绑定不可用 | 小程序端无入口 |
| 8 | 管理后台 **403 无专门处理分支**，不消费 `X-Account-Status` / `X-Activity-Status` | 权限被撤销时用户只看到通用错误 | 已知限制 |
| 9 | `admin/src/pages/` 与 `admin/src/views/` 目录命名不一致（`RankingsView` 在 `pages/`，来源 `81b86e5`，原因未说明） | 新人易困惑 | **待确认**是否统一 |
| 10 | `ElResult` 组件未注册但被引用 | 相关页面渲染异常 | **待修复** |
| 11 | 小程序无全局 `onError` / `onUnhandledRejection` | 线上异常无回收手段 | **待确认**是否有意 |
| 12 | `libVersion` 入库 3.0.0（`project.config.json:57`）与本地 3.17.3（`project.private.config.json`，gitignore）不一致 | 团队约定不明 | **待确认**以哪个为准 |

---

## 16. 待确认清单（架构相关）

1. 生产 nginx 配置文件的实际位置与完整内容（不在本仓库）。**其中一点已可预判为必须核实**：管理后台路由用 HTML5 history 模式（`createWebHistory()`，`admin/src/router/index.ts:98`），若 nginx 的静态站点 `location` 未配 `try_files $uri $uri/ /index.html;` 一类的 SPA 回退，则**在 `/rankings` 等深层路由上直接刷新或粘贴链接会 404**——首页 `/` 与站内点击跳转都正常，故日常验收发现不了，只有刷新才暴露。**前端侧已核实无额外约束**：`admin/vite.config.ts`（全文仅 20 行）**未设 `base`**，即默认 `/`，与 `createWebHistory()` 的根路径假设一致；因此回退规则只需处理 SPA 一项，无需兼顾子路径部署。
2. 生产 openGauss 的**兼容模式**（`datcompatibility` / `sql_compatibility`）。版本号与端口**已查证、不再是待确认项，见下节**（6.0.1 / 5432，依据配置文件而非直连实测）。
3. ~~生产后端进程管理方式（systemd / nohup / supervisor / docker）。~~ **已查证，见下节**（systemd 服务 `longmarch-backend`）。
4. 后端是否配置了访问日志落盘与轮转。
5. 小程序 `app.js` 无全局错误钩子是否为有意取舍。
6. `libVersion` 以入库的 3.0.0 还是本地的 3.17.3 为准；真机最低基础库版本要求（`app.json` 中无声明，微信也不支持在该处声明）。
7. `frontend/images/tabbar/` 下存在 `quiz.png` / `quiz-active.png` 但 `app.json` 未引用，推测是「情报」曾作为 tab 的遗留，用途待确认。
8. `admin/src/pages/` 与 `admin/src/views/` 并存的原因与是否统一。
9. ~~`Numeric` → `Mapped[float]` 的 Decimal 精度问题是否有实际业务影响。~~ **已查证，见下节。**
10. `lm_data_{userId}` 遗留 Storage 键（永不删除）是否有清理计划。
11. 调试端点 `/api/quiz/reset`、`/api/sport/add` 是否有生产环境关闭计划。
12. `frontend/AGENTS.md` §5 提到的 `NODE_COORDS` 前端硬编码坐标表**代码中不存在**（节点经纬度全部来自 `GET /api/march/route`，`services/march.js:32-46` 缺坐标时回退重拉 route 补齐）—— 该文档条目应视为已失效，是否修订待确认。

### 16.1 已查证 / 已决策（2026-10-17，不再是待确认项）

| 项 | 结论 | 依据 |
|---|---|---|
| `Numeric` → `Mapped[float]` | 运行时实际返回 `decimal.Decimal`（实测 `Decimal('25.885000')`、`Decimal('4.27')`），注解不准确；当前无业务影响，出口经 Pydantic 转 float。记为技术债 | `PROJECT.md` §8 第 28 项 |
| `admin_menus.sort_order` **真实重号** | `invites`=10 与 `ai_overview`=10、`activity`=11 与 `ai_knowledge`=11。侧边栏顺序由 `admin/src/router/menus.ts` 静态数组决定故**不受影响**；受影响的是 `access_service.py:63`/`:80`/`:201` 三处 `order_by(AdminMenu.sort_order)` 在同分时返回顺序不稳定。**用户决定：只记录为已知问题，不改业务代码** | `015:31-33`、`016:36-38`、`022:15`/`:18`；`PROJECT.md` §8 第 26 项 |
| 5 个 `ai_*` 菜单码在 admin 前端缺失 | `022_ai_admin_menus.sql` 写入 `ai_overview`/`ai_knowledge`/`ai_workshop`/`ai_logs`/`ai_config`，但 `menus.ts` 只有 11 项、**不含任何一个**。属「Phase A 后端就绪、admin 页面待开发」的预期状态，**非缺陷** | `docker/init/022_ai_admin_menus.sql:15-27` vs `admin/src/router/menus.ts:3-15` |
| 非自增主键的 id 分配 | 一律 `max(id)+1`，**无并发保护**（并发新增可撞主键）；`persons` 只有 seed、无新增代码路径 | `admin_service.py:46-47`/`:175-176`、`ai_question_service.py:378`/`:674`、`import_service.py:293`；`PROJECT.md` §8 第 27 项 |
| 逻辑外键孤儿数据 | 开发库实测 `users.org_id`、`lit_nodes.node_id`、`user_medals.medal_id`、`quiz_records.user_id`、`daily_sport.user_id`、`organizations.parent_id`、`points_log.ref_id`→`daily_questions` **全部 0 孤儿**。注意答题积分的 `ref_id` 指向 `daily_questions.id`（会话），**不是** `quiz_records.id` | `points_log.source_type` 分布实测 legacy 435 / walk 92 / quiz 13；`quiz_service.py:260`/`:452` |
| `daily_sport.is_makeup` / `makeup_at` | **纯预留死字段**：005 建列且 NOT NULL DEFAULT FALSE，但全仓无写入点，库中 0 行有值 | `models.py:235`/`:248-249`、`005_upgrade.sql:31-36`；`PROJECT.md` §8 第 29 项 |
| 开发库兼容模式与版本 | `datcompatibility='A'`、`sql_compatibility='A'`、`UTF8`/`en_US.utf8`、openGauss **7.0.0-RC3 build 01b7e318**；`schema_migrations` 已登记 001→022 全部 22 项。**A 模式来自镜像默认值**，compose 与 init-db.sh 均未显式指定 | 见上表第 2 项 |
| `march` 页双模式切换 | **有明确 UI 开关，非自动降级**：WXML 常驻两个 `bindtap="switchMode"` 按钮，初值 `real` | `march.wxml:52-64`、`march.js:49`/`:361-380` |
| 默认昵称「长征小战士」 | **ORM 列默认值**，不由接口代码显式赋值 | `backend/app/models/models.py:192` |
| 生产后端**进程管理方式** | **systemd 服务 `longmarch-backend`**，`APP_ENV=prod`，代码目录 `/mnt/data/longmarch-run`，日志走 journald。原 §16 第 3 项的四个候选（systemd / nohup / supervisor / docker）中 systemd 为正解 | `backend/test/docs/s26-ai-question-backend-report.md:94-96`（转记于 `.qoder/PROJECT.md` §5「生产拓扑」） |
| 生产 openGauss **版本与端口** | **6.0.1**（Ubuntu）、库 `longmarch`、端口 **5432**。与开发容器（`latest` 镜像、实测 7.0.0-RC3、宿主 5118）**存在版本偏斜**，涉及 DDL 与方言的改动不能只靠开发库验证。**注意依据强度**：来自配置文件而非直连实测，故其**兼容模式仍列 §16 第 2 项待确认** | `backend/.env.prod:7` 注释与 `:9` 连接串（转记于 `.qoder/PROJECT.md` §5） |
