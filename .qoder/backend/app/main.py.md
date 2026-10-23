# main.py

## 1. 文件路径

`backend/app/main.py`（92 行）

## 2. 文件职责

FastAPI 应用对象的**唯一装配点**：定义启动钩子（写入种子数据 + 修复派生统计）、创建 `app` 实例、注册唯一的中间件（CORS）、把 18 个路由模块挂到统一前缀下，并额外暴露一个不在 `/api` 前缀内的健康检查端点。

模块 docstring（`:1-9`）同时承担了「怎么启动」的说明：`cd backend` → `pip install -r requirements.txt` → `python run.py`（或 `uvicorn app.main:app --reload`），接口文档在 `http://127.0.0.1:8010/docs`。

## 3. 业务需求

- **应用装配**：`backend/AGENTS.md` §3 把本文件定位为「应用入口：lifespan 写入种子、CORS、注册全部路由」，§5 编码规范要求「新路由文件需在 `app/main.py` 中 `app.include_router(...)` 注册」。
- **启动自愈**：派生统计（连续行军天数、步行积分台账）可能因进程崩溃、迁移遗漏或规则变更而与源数据（`daily_sport`）不一致，故每次启动都以源数据全量重算修复。这是 `.qoder/ARCHITECTURE.md` §9.1「以数据库为唯一权威 + 启动时以源数据重算修复」的落地点。
- **种子数据**：路线节点、题库、勋章、人物、金句、组织树等静态内容必须在应用可用前就位（`backend/AGENTS.md` §4 架构不变量 3「种子幂等」）。
- **跨域**：开发期管理后台（Vite dev server `:5173`）与后端（`:8010`）不同源，需要 CORS 放行。生产期同域，CORS 不生效但保留。

## 4. 核心功能

### 4.1 导入区（`:10-38`）

| 行号 | 导入 |
|---|---|
| `:10` | `contextlib.asynccontextmanager`（用于 `lifespan`） |
| `:12-13` | `fastapi.FastAPI`、`fastapi.middleware.cors.CORSMiddleware` |
| `:15-34` | `app.api.routes` 下的 **18 个路由模块**，按字母序书写：`activity`、`admin`、`ai`、`ai_admin`、`auth`、`broadcast`、`identity`、`march`、`medal`、`org`、`persons`、`points`、`profile`、`quiz`、`quotes`、`rank`、`sport`、`ws` |
| `:35` | `app.core.config.settings` |
| `:36` | `app.core.database.SessionLocal`（**只导入 `SessionLocal`，不导入 `init_db`** —— 建表不在启动流程内，见 §7 第 5 条） |
| `:37` | `app.data.seed.init_seed` |
| `:38` | `app.services.points_service`、`app.services.streak_service` |

`app/api/routes/` 目录下共 18 个 `.py` 业务模块（另有 `__init__.py`），**全部被导入、全部被注册，无遗漏也无多余**。

### 4.2 启动钩子 `lifespan`（`:41-51`）

`@asynccontextmanager`（`:41`）+ `async def lifespan(app: FastAPI)`（`:42`），docstring `:43`「应用启动：幂等写入种子数据，并以运动源数据修复派生统计」。

执行顺序（`:44-51`）：

1. `:44` `db = SessionLocal()` —— **在应用入口自建 Session**（不是 `Depends(get_db)`，因为此时没有请求上下文）。
2. `:46` `init_seed(db)` → `app/data/seed.py:415-424`，依次幂等写入路线节点 / 题库 / 勋章 / 人物 / 金句 / 组织（组织仅在表为空时写入，`seed.py:422-423`），末尾 `db.commit()`（`seed.py:424`）。
3. `:47` `streak_service.recompute_all(db)` → `app/services/streak_service.py:106-118`，全量重算 `users` 的连续天数缓存（以 `daily_sport.is_goal_completed` 为准），`yield_per(5000)` 流式分组，只回写不一致的用户，返回更新用户数（**返回值被丢弃**）。
4. `:48` `points_service.recompute_walk_all(db, fix=True)` → `app/services/points_service.py:338-340`，按每日运动源数据核对全部用户的**步行**积分，`fix=True` 时幂等修复历史台账（分批 500 用户，返回统计字典，**返回值被丢弃**）。
5. `:49-50` `finally: db.close()` —— 无论成功失败都关闭 Session。
6. `:51` `yield` —— **`yield` 之后没有任何代码，即无 shutdown 钩子**。

**顺序有依赖**：`init_seed` 必须最先（后续重算要读到路线节点等静态数据）；`streak` 与 `points` 两次重算之间无数据依赖，但 `points` 的重算以 `daily_sport` 为源、与 `streak` 的结论互不影响，故当前顺序可互换（提交 `4afccdd` 的说明明确「在连续行军修复后执行步行台账修复」，是追加而非调整）。

**异常行为**：`:45-50` 的 `try/finally` **只保证关闭 Session，不捕获异常**。任一步骤抛异常都会向上传播出 `lifespan`，导致 **ASGI 启动失败、进程退出**。这不是理论风险：`docs/迭代记录.md` 2026-10-16 记录过一次真实事故 —— 生产库缺 `020_question_rotation.sql` 迁移（`questions` 表无 `active` 列），启动时 `init_seed` 内的查询抛 `psycopg2.errors.UndefinedColumn`，服务无法启动。

### 4.3 应用实例（`:54-59`）

```python
app = FastAPI(
    title=settings.APP_NAME,          # :55  值来自 core/config.py:24
    description="长征主题运动与每日答题小程序后端 API",   # :56  硬编码字面量
    version="1.0.0",                  # :57  硬编码字面量
    lifespan=lifespan,                # :58
)
```

**未传入的参数**（即全部使用 FastAPI 默认值，属实际存在的现状而非遗漏推测）：`docs_url` / `redoc_url` / `openapi_url` **未做环境门控** —— `settings.DEBUG`（`core/config.py:26`）在本文件中**零引用**，因此 `/docs`、`/redoc`、`/openapi.json` 在生产环境同样可访问。

### 4.4 中间件（`:61-67`）

**只注册了一个中间件**，`CORSMiddleware`：

| 行号 | 参数 | 值 |
|---|---|---|
| `:63` | `allow_origins` | `settings.CORS_ORIGINS`（默认 `["*"]`，定义在 `core/config.py:107`，可由 env 覆盖） |
| `:64` | `allow_credentials` | `False`，行尾注释「鉴权走 Authorization 头，无需 cookie 凭据」 |
| `:65` | `allow_methods` | `["*"]` |
| `:66` | `allow_headers` | `["*"]` |

`allow_credentials=False` 与 `allow_origins=["*"]` 的组合是 CORS 规范允许的（带凭据时规范禁止通配来源，此处不带凭据故合法）。

**未注册的中间件 / 能力**（grep 确认本文件无相关关键字）：无 `GZipMiddleware`、无请求日志中间件、无链路追踪、无 Sentry 类错误上报、无 OpenTelemetry、**无 `@app.exception_handler(...)`**、**无 `app.mount(...)` / `StaticFiles`（不托管任何静态文件）**、**无 `Base.metadata.create_all`、无 `schema_migrations` 相关逻辑**。未捕获异常由 FastAPI 默认转 500；管理后台的静态资源由 nginx 直接托管（`.qoder/ARCHITECTURE.md` §12.1），不经本应用。

### 4.5 路由注册（`:69-87`）—— 共 **18 个** `include_router`

`:69` `_prefix = settings.API_PREFIX`（值 `/api`，定义在 `core/config.py:25`）。**18 个调用全部使用同一个 `prefix=_prefix`**，各模块自身的二级前缀由模块内 `APIRouter(prefix=...)` 决定。

下表逐个核对（「模块内前缀」列的行号为各路由文件中 `router = APIRouter(...)` 所在行，均已 grep 验证）：

| # | `main.py` 行 | 模块 | 模块内前缀（定义行） | 最终 URL 前缀 | 面向对象 |
|---|---|---|---|---|---|
| 1 | `:70` | `activity` | `/activity`（`activity.py:9`） | `/api/activity` | 小程序（`/status` 为公开接口） |
| 2 | `:71` | `auth` | **无**（`auth.py:22`，`APIRouter(tags=["auth"])`） | `/api/auth/*`（路径写全在装饰器里：`/auth/login`、`/auth/invite/verify`、`/auth/onboard`、`/auth/me`、`/auth/nickname`、`/auth/nickname/initial`） | 小程序 |
| 3 | `:72` | `identity` | **无**（`identity.py:24`） | `/api/auth/qr/info`、`/api/auth/qr/confirm`、`/api/auth/identities`、`/api/auth/identities/{identity_id}` | 小程序 |
| 4 | `:73` | `sport` | `/sport`（`sport.py:21`） | `/api/sport` | 小程序 |
| 5 | `:74` | `march` | `/march`（`march.py:19`） | `/api/march` | 小程序 |
| 6 | `:75` | `quiz` | `/quiz`（`quiz.py:21`） | `/api/quiz` | 小程序 |
| 7 | `:76` | `ai` | `/ai`（`ai.py:31`） | `/api/ai` | 小程序 |
| 8 | `:77` | `points` | `/points`（`points.py:11`） | `/api/points` | 小程序 |
| 9 | `:78` | `medal` | `/medal`（`medal.py:12`） | `/api/medal` | 小程序 |
| 10 | `:79` | `org` | `/org`（`org.py:20`） | `/api/org` | 小程序 |
| 11 | `:80` | `rank` | `/rank`（`rank.py:11`） | `/api/rank` | 小程序 |
| 12 | `:81` | `profile` | `/profile`（`profile.py:11`） | `/api/profile` | 小程序 |
| 13 | `:82` | `persons` | `/persons`（`persons.py:11`） | `/api/persons` | 小程序 |
| 14 | `:83` | `quotes` | `/quotes`（`quotes.py:14`） | `/api/quotes` | 小程序 |
| 15 | `:84` | `broadcast` | `/broadcast`（`broadcast.py:11`） | `/api/broadcast` | 小程序（今日播报聚合） |
| 16 | `:85` | `ws` | `/ws`（`ws.py:16`） | `/api/ws/updates`（WebSocket） | 双端 |
| 17 | `:86` | `admin` | `/admin`（`admin.py:98`） | `/api/admin` | 管理后台 |
| 18 | `:87` | `ai_admin` | `/admin/ai`（`ai_admin.py:43`） | `/api/admin/ai` | 管理后台 |

**注册顺序与导入顺序不同**：`:15-34` 的 import 是字母序，`:70-87` 的注册是「小程序业务域 → WS → 管理端」的分组序。

**`/api/admin/ai/*` 由两个模块共同承载**：`admin.py` 自身含 `/ai/generate-questions` 与 `/ai/questions/batch-save`（配上前缀 `/admin` 即 `/api/admin/ai/...`），`ai_admin.py` 提供 `/api/admin/ai/knowledge`、`/config`、`/drafts`、`/drafts/{draft_id}`、`/drafts/{draft_id}/status`、`/drafts/import`、`/jobs`、`/jobs/{job_id}`、`/knowledge/{kid}`、`/knowledge/{kid}/status`。两组具体路径**无重叠**（已逐条比对），因此 `admin`（`:86`）先于 `ai_admin`（`:87`）注册不会造成路由遮蔽；但**新增 `/api/admin/ai/**` 路径时必须同时检查两个模块**，否则可能引入 FastAPI 按注册顺序匹配导致的遮蔽。

`admin.py` 内也**不存在**顶层单段路径参数路由（如 `/{x}`），故 `:86` 与 `:87` 之间无遮蔽风险。

### 4.6 健康检查（`:90-92`）

```python
@app.get("/", tags=["health"], summary="健康检查")   # :90
def health():                                        # :91
    return {"status": "ok", "app": settings.APP_NAME, "docs": "/docs"}   # :92
```

- **路径是根 `/`，不在 `/api` 前缀下**（用 `@app.get` 直接挂在 app 上，不经 `include_router`）。生产经 nginx 反代时只转发 `/api`，故 **`/` 在生产环境从公网不可达**（推断依据为 `.qoder/ARCHITECTURE.md` §12.1 的 `location /api` 拓扑；nginx 配置不在仓库内，**待确认**）。
- **未声明 `response_model`**，与 `backend/AGENTS.md` §3.1「所有响应必须声明 `response_model`」的约定不一致（该约定面向业务接口；此处为运维端点，是否属豁免**待确认**）。
- 无鉴权依赖，返回内容不含敏感信息（仅 `status` / 应用名 / 文档路径）。

## 5. 输入与输出

**本文件不定义业务请求/响应模型**，只定义一个端点：

| 端点 | 方法 | 权限依赖 | 请求参数 | `response_model` | 响应体 | 错误码 |
|---|---|---|---|---|---|---|
| `/` | GET | 无（公开） | 无 | **未声明** | `{"status": "ok", "app": "<settings.APP_NAME>", "docs": "/docs"}` | 无自定义错误码 |

`settings.APP_NAME` 的默认值为 `长征运动挑战 API`（`core/config.py:24`），可被 env 覆盖。

**启动钩子的输入输出**：`lifespan` 接收 `app: FastAPI`（未使用该参数，仅为签名要求）；三个调用的返回值（`init_seed` 返回 `None`、`recompute_all` 返回更新用户数 `int`、`recompute_walk_all` 返回统计 `Dict`）**全部被丢弃**，不落日志、不写入任何地方。因此**启动修复的结果当前不可观测**（无日志输出）。

**异常与错误码**：本文件不产生任何 `HTTPException`。启动期异常直接导致进程退出（见 §4.2）。

## 6. 依赖关系

**直接依赖**：

| 依赖 | 用途 | 文档 |
|---|---|---|
| `app.api.routes.*`（18 个模块） | 路由注册 | 各自文档（另一批次） |
| `app.core.config.settings` | 读 `APP_NAME`（`:55`、`:92`）、`CORS_ORIGINS`（`:63`）、`API_PREFIX`（`:69`） | `.qoder/backend/app/core/config.py.md`（另一批次） |
| `app.core.database.SessionLocal` | 启动钩子内自建 Session（`:44`） | `.qoder/backend/app/core/database.py.md`（另一批次） |
| `app.data.seed.init_seed` | 种子数据（`:46`） | `.qoder/backend/app/data/seed.py.md`（待生成） |
| `app.services.streak_service` | 启动重算连续天数（`:47`） | 待生成 |
| `app.services.points_service` | 启动修复步行积分台账（`:48`） | 待生成 |

**间接依赖**：导入 18 个路由模块会级联导入 `api/deps.py`、`app/services/` 下全部 **35 个业务模块**（2026-10-23 `ls backend/app/services/*.py` 实测共 36 个文件 = `__init__.py`（仅 1 行包 docstring，不计）+ 32 个 `*_service.py` + 大模型适配层 `llm_base.py` / `llm_openai.py` / `llm_cloudbase.py`；AI 上游由 `llm_service.py` 门面按 `settings.LLM_PROVIDER` 分派到 `llm_openai`（OpenAI Chat Completions 兼容）或 `llm_cloudbase`（腾讯云 CloudBase Agent ACP），见 `app/services/llm_service.py:26`、`:41`。其中 `operation_config_service.py` 与 `upload_service.py` 尚无 `.qoder/` 建档，见 `.qoder/PROJECT.md` §10「增量与缺口」节）、`models/models.py`（**35** 张表的 ORM 映射，2026-10-23 `grep -c '^class ' backend/app/models/models.py` 与 `grep -c '__tablename__'` 双双实测 35；建档时写的 34 已随 `b0ed585` 新增 `Chapter`（`models.py:61`）过期）、`core/security.py`、`core/wx.py`、`core/ws.py`、`core/rate_limit.py`、`core/helpers.py`、`schemas/schemas.py`。**因此「能否成功 import `app.main`」本身就是全项目导入链与 ORM 映射的健康检查**（`docs/迭代记录.md` 多条记录以「ORM 与 `app.main` 导入正常」作为验证项）。

**数据库表**：启动钩子间接读写 `route_nodes`、`questions`、`medal_defs`、`persons`、`person_nodes`、`daily_quotes`、`organizations`（种子）；`daily_sport`、`users`（连续天数重算）；`daily_sport`、`points_log`、`users`（步行积分修复）。**不触碰 `schema_migrations`** —— 迁移由 `docker/init/*.sql` 在数据库容器初始化时执行（`.qoder/ARCHITECTURE.md` §12.4），本文件完全不参与。

**被谁依赖**：

| 依赖方 | 方式 |
|---|---|
| `backend/run.py:11` | `uvicorn.run("app.main:app", ...)`，**开发启动入口** |
| `backend/test/serve_sqlite.py:33`、`:40` | `from app.main import app` → `uvicorn.run(app, host="127.0.0.1", port=8010, log_level="info")`，浏览器验收专用（该脚本另在 `:35` 调 `Base.metadata.create_all`，属 test 目录的例外，不进部署包） |
| 18 个冒烟测试脚本 | `from app.main import app` + `TestClient(app)`（`s5`、`s6`、`s8`、`s9`、`s11`、`s12`、`s17`、`s18`、`s19`×2、`s20`、`s22`、`s23`、`s24`、`s25`、`s26`、`s28`、`s29`）。**`s30_llm_provider_switch.py` 不挂载 `app.main`** —— 它直接测 `llm_service` 门面与两个适配器（自建本地桩服务器），故不在本行计数内 |
| 生产 uvicorn 进程 | 启动命令**待确认**（`.qoder/ARCHITECTURE.md` §16 第 3 项） |

**测试与 lifespan 的关系（重要）**：Starlette 的 `TestClient` 只在**作为上下文管理器进入时**才驱动 ASGI lifespan。仓库内 18 处 `TestClient(app)`（2026-10-22 实测 `grep -rn "TestClient(app)" backend/test/*.py`）中，只有 `s5_org_user_counts.py:74` 与 `s6_org_user_detail.py:87` 写作 `with TestClient(app) as client:`（会执行 `lifespan`），其余 16 处写作 `client = TestClient(app)`（**不执行 `lifespan`**，因此不写种子、不做重算）。这解释了为什么多数冒烟脚本需要自己准备数据，也是新增测试时的易踩点。

## 7. 业务规则

1. **启动即自愈**：每次进程启动都会以 `daily_sport` 为源数据全量重算连续天数与步行积分台账（`:47-48`）。`recompute_walk_all(fix=True)` 是**幂等覆盖**（`points_log` 的唯一约束 `(user_id, biz_key)` 保证一人一来源一天一行，见 `.qoder/ARCHITECTURE.md` §9.1），因此重复启动不会产生重复流水，也**不删除数据、不改答题积分**（提交 `4afccdd` 说明明确）。
2. **种子必须幂等**（`backend/AGENTS.md` §4 不变量 3）：`init_seed` 按主键存在即跳过，组织树仅在表空时写入。
3. **建表不由应用负责**（`backend/AGENTS.md` §4 不变量 8、§6.4「禁止在后端启动流程中调用 `Base.metadata.create_all`」）：表结构的唯一执行来源是 `docker/init/*.sql`。本文件自提交 `bceeb26` 起已移除 `init_db()` 调用，当前**不含任何 DDL**。
4. **全部业务路由共享同一前缀 `/api`**（`:69`），且前缀来自配置而非硬编码。`GET /` 是**唯一**不在该前缀下的端点。
5. **鉴权不在本文件**：`backend/AGENTS.md` §4 不变量 2「除 `POST /api/auth/login` 外所有路由必须依赖 `Depends(get_current_user)`」由各路由模块与 `api/deps.py` 落实，本文件不做全局鉴权中间件。
6. **准入控制走响应头**（`X-Account-Status` / `X-Activity-Status`），由 `api/deps.py` 在 `HTTPException.headers` 中设置，本文件不参与（`.qoder/ARCHITECTURE.md` 不变量 5）。
7. **CORS 不带凭据**（`:64`）：鉴权走 `Authorization` 头，不使用 cookie；改为 `True` 会与 `allow_origins=["*"]` 冲突（CORS 规范禁止），必须同时收敛来源白名单。

## 8. 修改约束

- **新增路由文件必须同时改两处**：`:15-34` 的 import 元组（字母序）与 `:70-87` 的 `include_router`（业务分组序）。只改一处会导致 `NameError` 或路由 404（`backend/AGENTS.md` §5「路由注册」、§6.2「改接口必改三处」亦要求检查 `main.py` 注册）。
- **不得在本文件调用 `Base.metadata.create_all` 或任何 DDL**（`backend/AGENTS.md` §6.4 明令禁止）。表结构变更只能新增 `docker/init/NNN_*.sql`。
- **不得删除或调换 `:46-48` 的顺序而不评估依赖**：`init_seed` 必须先于两次重算；重算失败会导致启动失败（无异常捕获）。
- **`lifespan` 内新增的任何操作都会拖慢每次启动并可能让服务起不来**：`recompute_walk_all` 已是全用户批量扫描（分批 500），启动耗时随数据量线性增长。新增启动任务前应评估是否可延后到首次请求或改为独立脚本。
- **`yield`（`:51`）之后目前为空**：若需增加 shutdown 清理（关闭连接池、刷新缓冲等），必须写在 `yield` 之后且自行捕获异常，否则关闭期异常会掩盖原始退出原因。
- **不得把 `:90` 的健康检查挪进 `/api` 前缀**：容器/反代的存活探针通常打根路径；同时该端点是冒烟测试确认「应用能起来」的最轻量入口（`docs/迭代记录.md` 2026-10-13 条目以「`TestClient` 启动应用健康检查 200」作为验证项）。
- **`version="1.0.0"`（`:57`）是硬编码字面量**，与 `settings` 无关、与仓库 tag 无关联机制。若需版本追溯，需自行改造（当前**无**自动版本注入）。
- **改 `CORS_ORIGINS` 默认值需同步 `core/config.py:107`**，本文件只读不定义。
- **`settings.DEBUG` 未接入本文件**：若要做「生产关闭 `/docs`」，需显式传 `docs_url=None if not settings.DEBUG else "/docs"`（以及 `redoc_url`、`openapi_url`）。当前**未实施**，属已知现状（`.qoder/ARCHITECTURE.md` §15 未单列此项）。

## 9. 当前实现状态

**已实现**：

- `lifespan` 启动钩子：种子 + 连续天数重算 + 步行积分修复，`finally` 保证 Session 关闭（`:41-51`）。
- `FastAPI` 实例，`title` 来自配置、`description` 与 `version` 硬编码（`:54-59`）。
- 唯一中间件 `CORSMiddleware`，四项参数齐备（`:61-67`）。
- **18 个** `include_router`，覆盖 `app/api/routes/` 下全部 18 个业务模块，统一前缀 `/api`（`:69-87`）。
- 根路径健康检查（`:90-92`）。

**存在问题 / 已知现状**：

1. **无 shutdown 钩子**（`:51` 的 `yield` 后为空）：数据库连接池由 SQLAlchemy 在进程退出时回收，无显式关闭。当前无资源需要主动释放，**非缺陷**，但新增长生命周期资源时需补齐。
2. **无全局异常处理器**：未捕获异常由 FastAPI 默认转 500，响应体为默认 `{"detail":"Internal Server Error"}`，不含 trace id（`.qoder/ARCHITECTURE.md` §10.3）。
3. **无请求日志中间件、无结构化日志配置**：启动钩子的重算结果（更新了多少用户、修复了多少条台账）**被丢弃且不落日志**（`:47-48`），线上无法确认自愈是否生效、修复了多少数据。这是提交 `4afccdd` 的验证只能靠冒烟脚本（S20/S22）而非生产日志的原因。
4. **`/docs`、`/redoc`、`/openapi.json` 无环境门控**：`settings.DEBUG` 在本文件零引用，生产环境同样暴露完整接口文档。是否属有意取舍**待确认**。
5. **`GET /` 未声明 `response_model`**，与 `backend/AGENTS.md` §3.1 的表述不完全一致（该约定语境是业务接口）。是否需补齐**待确认**。
6. **启动失败即进程退出，且错误信息只出现在 uvicorn 控制台**：无重试、无降级启动（例如「种子失败也先起服务」）。已发生过的真实后果见 §4.2 引用的 2026-10-16 事故。是否需要更友好的启动失败提示**待确认**。
7. **`/api/admin/ai/*` 命名空间由两个模块分担**（`admin.py` 2 条 + `ai_admin.py` 10 条），当前无路径冲突，但属易踩点（见 §4.5 末段）。

**待开发**：本文件无规划中的未完成能力。`.qoder/ARCHITECTURE.md` §2.1 列出的「未装配能力」（gzip、请求日志、链路追踪、Sentry、OpenTelemetry）均为**明确不存在**，非遗漏。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/main.py`（12 条提交，全部列出），验证结论对照 `docs/迭代记录.md`。

### 2026-10-23（同批交付前复核补正，未单独提交）

- 需求：本批文档在提交前做了一轮「抽查引用」复核，发现 §6「间接依赖」段两处计数仍不准，就地补正（与上方 `2026-10-22` 条目同属一次未提交的文档同步，故另立本条留痕、不改写上一条）。
- 修改内容：① `app/services/` 模块数由「**35 个模块**（32 个 `*_service.py` + 三个适配器）」改写为可审计的算式——`ls backend/app/services/*.py` 实测 **36 个文件** = `__init__.py`（仅 1 行包 docstring，不计入业务模块）+ 32 个 `*_service.py` + `llm_base.py`/`llm_openai.py`/`llm_cloudbase.py`，故**业务模块 35 个**；原写法会让人用 `ls` 复核时得到 36 而对不上。同时补记 `operation_config_service.py`、`upload_service.py` 两个模块尚无 `.qoder/` 建档（实测 `.qoder/backend/app/services/*.md` 共 33 份 = 35 − 2），指向 `.qoder/PROJECT.md` §10「增量与缺口」节。② 同段 `models/models.py`「**34** 张表的 ORM 映射」更正为 **35**：`grep -c '^class '` 与 `grep -c '__tablename__'` 双双实测 35，`b0ed585` 新增的 `Chapter`（`backend/app/models/models.py:61`）未被计入；此更正与同批 `.qoder/backend/app/models/models.py.md` 的「34 → 35 个模型」口径对齐。
- 关联文件（均未修改，仅作计数来源）：`backend/app/services/`（目录清单）、`backend/app/models/models.py`、`.qoder/backend/app/models/models.py.md`、`.qoder/PROJECT.md`。
- 测试结果：纯文档复核，未跑测试、源码零改动。计数以 2026-10-23 的 `ls`/`grep -c` 实测为准。

### 2026-10-22

- 需求：AI 上游三次变更（`c660727` 迁阿里云百炼、`6a4dbb7` SSE 真流式、`b712d81` 改为 `LLM_PROVIDER` 可切换的双供应商）后，校正本文档中已过期的服务模块清单与测试挂载点统计。**本次源码未改（`backend/app/main.py` 三个提交均未触碰），属文档同步**。
- 修改内容：① §6「间接依赖」把「全部 30 个 service」更正为 `app/services/` 下 **35 个模块**（32 个 `*_service.py` + `llm_base.py`/`llm_openai.py`/`llm_cloudbase.py`），并说明 AI 上游现为 `llm_service.py` 门面按 `settings.LLM_PROVIDER` 分派（`app/services/llm_service.py:26`、`:41`）；② §6「被谁依赖」的冒烟脚本行由 16 个更正为 **18 个**（补 `s28_ai_chat_stream.py`、`s29_route_stats.py`），并注明 `s30_llm_provider_switch.py` 不挂载 `app.main`；③ 同节「测试与 lifespan 的关系」的 `TestClient(app)` 计数由 16 处更正为 **18 处**（`with` 形式仍只有 `s5`/`s6` 两处，其余 16 处不驱动 lifespan）。§4 的 import 清单、18 个 `include_router`、健康检查等表述与当前源码一致，未改；§10 既有历史记录（含 2026-10-17 条目中「真实 CloudBase Agent 调用」的当时口径）按 `.qoder/README.md` §3.11 **原样保留**。
- 关联文件：`backend/app/services/llm_service.py`、`llm_base.py`、`llm_openai.py`、`llm_cloudbase.py`、`backend/app/core/config.py`（`LLM_PROVIDER` 等，`:68-93`）、`backend/test/s28_ai_chat_stream.py`、`backend/test/s29_route_stats.py`、`backend/test/s30_llm_provider_switch.py`、`.qoder/backend/test/README.md`。
- 测试结果：本次未跑测试（纯文档修订，源码零改动）。统计口径以 2026-10-22 的 `ls backend/app/services/`、`grep -rn "TestClient(app)" backend/test/*.py`、`grep -rln "from app.main import app" backend/test/*.py` 实测为准；`b712d81` 自身的验证结论（s30 23/23、s25 16/16、s26 47/47、s28 13/13，合计 99/99）见 `docs/迭代记录.md` 的 `b712d81` 条目与 `.qoder/backend/test/README.md` §3.1。

### 2026-10-17

- 需求：V1.0 AI 智能中心 Phase A —— 历史助手 / 路线讲解 / 答题解析 / 管理端接口 / 题目工坊持久化。
- 修改内容：提交 `1600074`。import 元组新增 `ai`、`ai_admin`（`:18-19`）；注册新增 `ai.router`（`:76`，插在 `quiz` 之后）与 `ai_admin.router`（`:87`，追加在 `admin` 之后）。`include_router` 由 16 个增至 **18 个**（当前版本）。
- 关联文件：`app/api/routes/ai.py`、`app/api/routes/ai_admin.py`（均新增）、6 个 `app/services/ai_*_service.py`、`app/models/models.py`、`docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql`、`frontend/pages/ai-chat/`。
- 测试结果：冒烟 `backend/test/s26_ai_center.py` **47/47** 通过（含真实 CloudBase Agent 调用 L01：reply 143 字、usedTokens=19715）；真库校验（迁移应用 / 表索引菜单齐备 / ORM 与真库列 ALL_MATCH / JSON round-trip 后回滚 / 真库真实 Agent 对话一次）；报告 `backend/test/docs/s26-ai-center-report.md`。（来源：`docs/迭代记录.md` 2026-10-17 条目的「验证」字段）

### 2026-10-15

- 需求：修复「跨日零碎步数被丢弃」—— 步行积分台账若仍是按日向下取整的回填值，500+500+1611=2611 步只得 1 分。
- 修改内容：提交 `4afccdd`。`:38` 的 import 由 `from app.services import streak_service` 改为 `from app.services import points_service, streak_service`；`lifespan` 内在 `streak_service.recompute_all(db)` 之后新增 `points_service.recompute_walk_all(db, fix=True)`（`:48`）；docstring 由「幂等写入静态种子数据；全量重算连续行军缓存（daily_sport 为准兜底）」改为「应用启动：幂等写入种子数据，并以运动源数据修复派生统计」（`:43`）。
- 关联文件：`app/services/points_service.py`（新增 `recompute_walk_all` / `recompute_all`，`_expected_for` / `_verify_batch` 支持按来源过滤）、`backend/README.md`、`backend/design.md`、`frontend/services/` 积分规则注释。
- 测试结果：S20 回归 **26/26**（含边界 2611→2、1999→1、2000→2，以及 P01A 历史错账修复且答题 7 分不变）；S22 **14/14**（跨日结转、重复同步幂等）；S18 **21/21**；报告 `backend/test/docs/walk-points-cumulative-fix-report.md`。当时本地 Docker 未启动，线上真实数据记为「待部署启动后自动修复复核」。（来源：`docs/迭代记录.md` 2026-10-15「步行积分统一为累计步数口径」条目）

### 2026-10-13

- 需求：V2.0 需求一「活动时间控制」—— 新增公开的活动状态接口。
- 修改内容：提交 `ce14a95`。import 元组新增 `activity`（`:16`）；注册新增 `activity.router`（`:70`，置于全部业务路由之前）。`include_router` 由 15 个增至 16 个。
- 关联文件：`app/api/routes/activity.py`（新增）、`app/services/activity_service.py`（新增）、`app/api/deps.py`（新增 `require_activity_participation` / `require_activity_view`）、`app/core/helpers.py`、`docker/init/016_activity_settings.sql`。
- 测试结果：TestClient 冒烟通过（默认状态、时间格式错误 422、开始晚于结束 400、未发布与已结束时写接口 403、结束后可查看与不可查看两种配置、无 Token 仍 401）；`s19_invite_admission.py` 回归 25/25。（来源：`docs/迭代记录.md` 2026-10-13 条目的「验证」字段）

### 2026-10-09

- 需求：微信扫码登录与身份关联（批次 2）—— 新增扫码场景查询/确认与身份绑定列表接口。
- 修改内容：提交 `b431e4d`。import 元组新增 `identity`；注册新增 `identity.router`（现 `:72`，紧随 `auth.router`，因两者共用 `/auth/*` 路径空间）。`include_router` 由 14 个增至 15 个。
- 关联文件：`app/api/routes/identity.py`（新增）、`app/services/identity_service.py`、`app/core/security.py`、`app/core/rate_limit.py`（新建）、`app/api/deps.py`、`docker/init/010_*.sql`。
- 测试结果：S8 集成测试 **23/23** 通过（`backend/test/s8_identity_admin.py`，报告 `backend/test/docs/s8-identity-admin.md`）。（来源：`docs/迭代记录.md` 2026-10-09 条目）

### 2026-10-03（23:39）

- 需求：每日寄语与节点纪念票（P2-1）—— 后台维护有出处语录，首页展示寄语卡。
- 修改内容：提交 `71d1b9b`。import 元组新增 `quotes`；注册新增 `quotes.router`（现 `:83`）。`include_router` 由 13 个增至 14 个。
- 关联文件：`app/api/routes/quotes.py`（新增）、`app/services/quote_service.py`、`app/api/routes/admin.py`（语录 CRUD 与导入）、`frontend/pages/home/`、`frontend/pages/ticket/`、`admin/src/views/`。
- 测试结果：待确认（`docs/迭代记录.md` 2026-10-03「每日寄语与节点纪念票 P2-1」条目存在，但本次核对未逐字读取其「验证」字段内容）。

### 2026-10-03（08:40）

- 需求：长征人物志与答题连胜效果（P1-8）。
- 修改内容：提交 `2a178b7`。import 元组新增 `persons`；注册新增 `persons.router`（现 `:82`）。`include_router` 由 12 个增至 13 个。
- 关联文件：`app/api/routes/persons.py`（新增）、`app/models/models.py`（`persons` / `person_nodes`）、`frontend/pages/person/`。
- 测试结果：待确认（同上，`docs/迭代记录.md` 2026-10-03 存在对应条目，本次核对未逐字读取其「验证」字段）。

### 2026-10-02

- 需求：新增小程序聚合接口（档案 / 足迹 / 日历 / 播报 / 知识画像）并扩展现有契约。
- 修改内容：提交 `18c2121`。import 由单行改为**多行括号元组**（`:15-34` 的书写形式自此确立），新增 `broadcast`、`profile`；注册新增 `profile.router`（现 `:81`）与 `broadcast.router`（现 `:84`）。`include_router` 由 10 个增至 12 个。
- 关联文件：`app/api/routes/profile.py`、`app/api/routes/broadcast.py`（均新增）、`app/services/profile_service.py`、`dashboard_service.py`、`broadcast_service.py`、`app/core/helpers.py`（新增 `to_local` / `local_to_utc`）。
- 测试结果：S3 冒烟 **15/15** 通过（`test/s3_aggregates.py` + 验收报告）。（来源：提交信息正文）

### 2026-10-01（23:39）

- 需求：统一事件系统与连续行军机制 —— 连续天数缓存需要在启动时以 `daily_sport` 为准兜底重算。
- 修改内容：提交 `be7e126`。`:38` 新增 `from app.services import streak_service`；`lifespan` 内在 `init_seed(db)` 之后新增 `streak_service.recompute_all(db)`（现 `:47`）；docstring 改为「应用启动：幂等写入静态种子数据；全量重算连续行军缓存（daily_sport 为准兜底）」。
- 关联文件：`app/services/streak_service.py`、`app/services/event_service.py`（均新增）、`app/core/ws.py`（新增 `build_activity`）、`app/models/models.py`、`docker/init/005_upgrade.sql`。
- 测试结果：S2 冒烟脚本 **8/8** 通过 + 验收报告。（来源：提交信息正文）

### 2026-10-01（17:52）

- 需求：新增 WebSocket 数据变更广播，向管理端实时推送。
- 修改内容：提交 `82af32c`。import 新增 `ws`；注册新增 `ws.router`（现 `:85`，置于 `admin` 之前）。`include_router` 由 9 个增至 10 个。
- 关联文件：`app/api/routes/ws.py`（新增）、`app/core/ws.py`（新建）。
- 测试结果：待确认（`docs/迭代记录.md` 2026-10-01「WebSocket 数据变更广播（功能）」条目只有内容摘要，无「验证」字段）。

### 2026-10-01（10:29）

- 需求：新增管理后台 API（登录 / 题库 / 组织架构 / 路线节点 / 排名）。
- 修改内容：提交 `337af78`。import 新增 `admin`；注册新增 `admin.router`（现 `:86`）。`include_router` 由 8 个增至 9 个。
- 关联文件：`app/api/routes/admin.py`（新增）、`app/api/deps.py`（新增 `get_current_admin`）、`app/schemas/schemas.py`（`Admin*` 系列 snake_case 契约）、`app/services/admin_service.py`、`org_service.py`。
- 测试结果：待确认（`docs/迭代记录.md` 2026-10-01「管理后台 API（功能）」条目只有「内容：登录/题库/组织架构/路线节点/排名」，无「验证」字段）。

### 2026-10-01（10:26）

- 需求：数据库由 SQLite 切换为 Docker 承载的 openGauss；表结构改由 `docker/init/*.sql` 单一来源维护。
- 修改内容：提交 `bceeb26`。**移除建表逻辑**：`:36` 的 import 由 `from app.core.database import SessionLocal, init_db` 改为只导入 `SessionLocal`，`lifespan` 内删去 `init_db()` 调用；docstring 由「应用启动：建表 + 写入静态种子数据（均幂等）」改为「应用启动：幂等写入静态种子数据」；模块 docstring 的接口文档地址由 `http://127.0.0.1:8000/docs` 改为 `:8010`（`:8`），标题由「初始化数据库与种子数据」改为「初始化种子数据」（`:1`）。**自此本文件不含任何 DDL**（`backend/AGENTS.md` §4 不变量 8 的落地）。
- 关联文件：`app/core/database.py`（移除 `init_db` / `create_all`，新增 openGauss 版本兼容补丁）、`docker/compose.yml`、`docker/init/001~003`、`app/core/config.py`、`backend/.env.example`、`backend/run.py`（端口 8000→8010）、`requirements.txt`（新增 `psycopg2-binary`）。
- 测试结果：待确认（`docs/迭代记录.md` 2026-10-01「数据库由 SQLite 切换为 openGauss（架构变更）」条目只有「内容：切换为 Docker 承载的 openGauss」，无「验证」字段；提交信息正文列出了变更点但未记测试结论）。

### 2026-09-30

- 需求：项目初始化。
- 修改内容：提交 `a94e685`（`feat: init`）。**新建文件**，61 行：`lifespan`（当时含 `init_db()` 建表 + `init_seed`）、`FastAPI(...)`、`CORSMiddleware`、**8 个** `include_router`（`auth`、`sport`、`march`、`quiz`、`points`、`medal`、`org`、`rank`，import 为单行 `from app.api.routes import auth, march, medal, org, points, quiz, rank, sport`）、根路径健康检查。CORS 四项参数、`_prefix = settings.API_PREFIX` 的写法与健康检查端点**自建立至今未变**。
- 关联文件：`app/api/routes/` 初始 8 个路由模块、`app/services/` 初始 service、`app/core/`（`config.py` / `database.py` / `security.py` / `helpers.py`）、`app/data/seed.py`、`app/models/models.py`、`app/schemas/schemas.py`。
- 测试结果：待确认（`docs/迭代记录.md` 2026-09-30「项目初始化（init）」条目仅记「内容：仓库初始代码」，无验证结论）。
