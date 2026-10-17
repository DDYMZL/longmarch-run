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
| 数据库 | `docker/` | openGauss 容器（`opengauss/opengauss-server:latest`） | 本机 `:5118`；生产地址见 `backend/.env.prod`（**版本与端口待确认**） |
| 数据库迁移脚本 | `docker/init/` | 001–022 编号 SQL，容器初始化时按字典序执行 | — |

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
   │   初始化：docker/init/001..022（字典序，ON_ERROR_STOP=1）      │
   └───────────────────────────────────────────────────────────┘

   外部依赖：
   ┌────────────────────────────┐   ┌────────────────────────────────┐
   │ 微信开放接口（3 个）         │   │ 腾讯云 CloudBase Agent（ACP）    │
   │ sns/jscode2session          │   │ session/prompt · JSON-RPC 2.0   │
   │ cgi-bin/token               │   │ SSE 流式响应                     │
   │ wxa/getwxacodeunlimit       │   │ 由 backend/app/services/         │
   └────────────────────────────┘   │ cloudbase_service.py 调用        │
                                    └────────────────────────────────┘
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
| `routes/broadcast.py` | `/broadcast` | 管理后台 | 实时动态流（REST 拉取） |
| `routes/ws.py` | `/ws` | 双端 | WebSocket 长连接 |
| `routes/ai.py` | `/ai` | 小程序 | AI 问答、路线讲解、答题讲解 |
| `routes/admin.py` | `/admin` | 管理后台 | 后台全部业务接口（含 Excel 导入导出、审计、RBAC） |
| `routes/ai_admin.py` | `/admin/ai` | 管理后台 | AI 智能中心后台接口（Phase A 已就绪，管理端页面**待开发**） |

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
- 管理后台侧 `admin/src/api/request.ts:27-51` 的成功拦截器**直接返回 `response.data`**，调用方拿到的即业务对象。

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
| 数据库存储 | **UTC naive**（不带时区信息的 `datetime`） | `services/helpers.py:12-14` |
| 业务日切分 | **北京时间 UTC+8** 的自然日 | `services/helpers.py:9`、`:22-24` |
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
- **单进程内存连接表**：`_connections` 是进程级变量，**多进程部署（gunicorn -w N）会导致广播只命中同进程的连接**。当前生产为单进程（进程管理方式**待确认**），故尚未暴露该问题。未引入 Redis/Celery（见 PROJECT.md §3）。

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

前端 `admin/src/components/ExcelImportDialog.vue` 通过 `api: ExcelImportApi` prop（`:10-14`）接收四个接口函数，因此**同一个组件复用于所有导入场景**；`defineExpose({downloadTemplate})`（`:101`）允许父组件直接触发模板下载。

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

`backend/app/core/rate_limit.py`：自实现 `SlidingWindowLimiter`（`:11-27`），**仅按 IP 维度**（`:38-39`），进程内内存计数。`:30-35` 定义 4 个实例，分别用于登录、邀请码校验、AI 问答等敏感入口。触发返回 429。

**局限**：进程内计数 → 多进程/多实例部署下阈值会被放大 N 倍；重启即清零。当前单进程部署下可用。

### 10.2 审计

`services/audit_service.py` + `audit_logs` 表，记录管理端写操作。约定为「service `db.add`，路由 `db.commit`」（`:2-5`）。管理端 `admin/src/views/AuditView.vue` 用 `ACTION_TEXT` 20 项映射把 action 码翻译成中文。

### 10.3 错误处理与日志

- 后端：**无全局异常处理器**，未捕获异常由 FastAPI 默认转 500。业务错误统一 `HTTPException`。
- 日志：**未配置结构化日志框架**，无 logging 配置文件（**待确认**是否有 uvicorn 默认访问日志的落盘策略）。
- 小程序：`services/request.js:94-101` 的 `fail` 回调把原始 `errMsg` **追加进用户可见的 message**，注释说明理由「真机看不到 console，必须把错误带到界面上」；`/url not in domain list/i` 单独提示域名白名单问题。
- 小程序 `app.js` **没有 `onError` / `onUnhandledRejection` / `onPageNotFound`** —— 未捕获异常只在开发者工具 console 可见，**线上无任何回收手段**，微信侧错误上报能力也未配置（是否为有意取舍**待确认**）。

---

## 11. AI 智能中心（V1.0 Phase A，已上线）

### 11.1 外部集成

`backend/app/services/cloudbase_service.py` 对接**腾讯云 CloudBase Agent**，走 **ACP 协议**（`:1-11`）：httpx **同步**客户端发起 JSON-RPC 2.0 的 `session/prompt`，响应为 **SSE 流式**。

- `:68-79` 调用地址构造：配置了 `CLOUDBASE_ACP_URL` 则直用，否则按 `https://{ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/{AGENT_ID}/acp` 拼接（与 `core/config.py:71` 注释一致）。
- `:199-220` 失败重试 + 退避。
- `:7-8`、`:206` **多轮对话是无状态的**：把历史拼接进单个 prompt，并在 `:206` 加系统提示词前缀。服务端不维护会话上下文。

配置项名称见 `core/config.py:66-91`（`CLOUDBASE_ENV_ID`、`CLOUDBASE_AGENT_ID`、`CLOUDBASE_ACP_URL` 等；**本文档不记录配置值**）。

### 11.2 已交付范围（2026-10-17，backend `1600074` + frontend `0052108`）

| 端 | 已实现 |
|---|---|
| 后端 | `/api/ai/*`（问答、路线讲解、答题讲解）与 `/api/admin/ai/*`（知识库、配置、题目工坊、调用记录）；6 个 AI 服务；`docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql`；冒烟 `s26` 47/47 通过（含真实 Agent 调用） |
| 小程序 | `pages/ai-chat` 聊天页；底部「情报」tab 换防为「AI 问答」；quiz 降级子页由首页情报卡进入 |
| 数据库 | 6 张 AI 表：`ai_knowledge`、`ai_conversations`、`ai_messages`、`ai_generation_jobs`、`ai_generated_questions`、`ai_usage_logs` |

### 11.3 明确未交付（勿当作已完成）

| 项 | 状态 | 备注 |
|---|---|---|
| 管理后台 5 个 AI 子页面（知识库/配置/题目工坊/运行概览/调用记录） | **待开发** | 后端接口已就绪，`admin/src/router/menus.ts` 未登记 |
| `node-detail` AI 讲解面板 | **待开发** | `GET /api/ai/route-guide/{node_id}` 已就绪 |
| 答题页「AI 讲解」按钮 | **待开发** | `GET /api/ai/quiz-explanation/{question_id}` 已就绪 |
| usage / cost 统计页 | **待开发** | `ai_usage_logs` 表已建 |
| 小程序真机真实 Agent 全链路 | **待验证** | 本机 DNS 劫持限制，需 dns_shim 或真机网络 |

**题目工坊已实现的部分**：管理后台 `admin/src/components/AiGenerateDialog.vue` 已落地（表单字段 `:55-61`、`:326-366`；`AbortController` 中断 `:128-164`、`:170-173`；行内编辑 + `validateItem` `:86-104` 与后端 `_validate_question` 对齐；深监听签名比较 `:106-118` 避免递归更新；`batchSaveAiQuestions` `:276-305`，`failures.index` 为 1 基）。**注意：这与上表「题目工坊子页面待开发」并不矛盾** —— 已落地的是嵌在题库页的生成对话框，待开发的是独立的题目工坊管理页。

### 11.4 异常映射

`routes/ai.py:42-50` 把 CloudBase 侧异常统一映射为对客户端友好的 HTTP 错误。AI 问答是**全项目唯一使用 60 秒超时的接口**（`frontend/services/ai.js`，其余均为默认 10 秒，`services/request.js:73`）。

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
   │ 进程管理方式待确认         │    │ 生产版本/端口待确认        │
   └──────────────────────────┘    └──────────────────────────┘
```

### 12.2 已确认事实

| 项 | 事实 | 依据 |
|---|---|---|
| 域名 | `swkjdj.sz-watech.com`，HTTPS 443 | `frontend/services/config.js:9`；`docs/迭代记录.md` 生产化条目 |
| nginx 反代 | `/api` → `127.0.0.1:8010` | `docs/迭代记录.md` |
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
| 执行时机 | 容器**首次初始化**时，openGauss 官方入口按**字典序**执行 `/docker/init` 下脚本（`docker/compose.yml` 挂载 `./init:/docker/init:ro`） |
| 补跑机制 | `docker/compose.yml` 定义第二个一次性服务 `database-init`（`restart: "no"`、`depends_on: service_healthy`），用于对已存在的库补跑迁移 |
| 已执行登记 | `schema_migrations` 表；`ON_ERROR_STOP=1` |
| 编写约束 | **`docker/init/SQL_CONSTRAINTS.md` 为权威，写迁移前必读** |

**关键约束（摘自 `SQL_CONSTRAINTS.md`）**：

- openGauss **禁止** `ADD/DROP COLUMN IF NOT EXISTS`，加列必须用 `DO $$ … EXCEPTION WHEN undefined_column/duplicate_column … $$` 块
- `CREATE INDEX IF NOT EXISTS` 需谨慎
- **派生表必须有别名**（历史事故 `f413ac6`）
- **不支持 `ON CONFLICT`**
- Oracle 兼容模式 A 下 **`''` 落库为 NULL**
- 迁移必须幂等、必须在事务中、**不得删除数据**
- 已发布脚本**不得修改**，只能新增编号
- 每个脚本必须有三段式头注释：变更目的 / 影响面 / 回滚

**历史包袱**：`005`、`013`、`015`、`017`、`019`、`020` 使用了如今被禁止的语法（它们早于约束文档），其中 `017`、`019` 含重算类 UPDATE，**不可重复执行**。

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

字段级说明（含类型、可空性、默认值、业务含义、索引、数据来源与更新规则）见 `.qoder/backend/app/models/models.py.md`（**待生成**）与 `.qoder/docker/init/*.sql.md`（**待生成**）。

### 13.2 全库共性事实

- **无任何 CHECK 约束**；所有「枚举」都是 `VARCHAR` + 应用层常量校验。
- **11 处逻辑外键没有数据库级 FK 约束**（有意为之，便于迁移与数据修复）。
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

1. 生产 nginx 配置文件的实际位置与完整内容（不在本仓库）。
2. 生产 openGauss 的版本号与端口。**开发环境已实测**：容器 `longmarch-opengauss`、宿主端口 5118、`version()` = `openGauss 7.0.0-RC3 build 01b7e318`（compiled 2026-03-25）、`datcompatibility='A'` / `sql_compatibility='A'`、库编码 `UTF8` / collate `en_US.utf8`；`compose.yml` 与 `init-db.sh` **均未显式指定编码与兼容模式**，A 模式来自镜像默认值，换镜像版本可能改变该默认值。
3. 生产后端进程管理方式（systemd / nohup / supervisor / docker）。
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
