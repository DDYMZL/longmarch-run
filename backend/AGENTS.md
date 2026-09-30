# AGENTS.md · 长征运动挑战后端（FastAPI）

本文档面向在该目录下工作的 AI Agent 与人类开发者，规定**项目架构约定、编码规范与上下文约束规则**。任何代码生成、修改、重构都必须遵守本文档；与本文档冲突时，以本文档为准（若确实需要变更约定，先修改本文档并说明理由）。

## 1. 项目定位

本目录是「长征主题运动 + 每日答题」小程序（`../frontend`，原生微信小程序）的**后端服务**。

- 业务逻辑由前端 `frontend/services/*.js` 的 Mock 实现**完整迁移**而来，数据结构与字段命名与前端 Mock 返回完全一致；
- 前端目前仍以本地 Mock 独立运行，后端目标是让其**平滑切换**到真实接口，因此「与前端 Mock 数据结构一致」是第一优先级约束。

## 2. 技术栈（不可随意更换）

| 组件 | 选型 | 约束 |
| --- | --- | --- |
| Web 框架 | FastAPI + Uvicorn | 同步 `def` 路由即可，无需 `async def` |
| ORM / 数据库 | SQLAlchemy 2.0（`Mapped`/`mapped_column` 风格）+ SQLite | 默认零配置；不得引入 Alembic 之外的迁移方案（当前靠 `create_all`） |
| 数据校验 | Pydantic v2 | 响应模型统一继承 `CamelModel` |
| 鉴权 | PyJWT（HS256） | Bearer Token，由 `app.core.security` 签发/校验 |
| 微信对接 | httpx（`code2Session`） | `WX_APPID`/`WX_SECRET` 为空时降级 mock openid |
| 配置 | pydantic-settings | 从环境变量 / `.env` 读取，`.env` 不入库 |

## 3. 目录结构与分层约定

```
backend/
├── run.py                    # 开发启动入口（勿在 app/ 内写启动逻辑）
└── app/
    ├── main.py               # 应用入口：lifespan 建表+种子、CORS、注册全部路由
    ├── core/                 # 基础设施（不依赖业务模块）
    │   ├── config.py         # Settings（pydantic-settings，lru_cache 单例）
    │   ├── database.py       # engine / SessionLocal / Base / get_db / init_db
    │   ├── security.py       # JWT 签发与校验（create_token / decode_token）
    │   └── helpers.py        # 日期、模拟步数等纯工具函数
    ├── models/models.py      # SQLAlchemy ORM（静态配置表 + 用户业务表）
    ├── data/seed.py          # 种子数据：路线 10 / 题库 15 / 勋章 6 / 组织树（幂等）
    ├── schemas/schemas.py    # Pydantic 请求/响应模型（CamelModel）
    ├── services/             # 业务逻辑，命名 *_service.py，与前端 services/*.js 一一对应
    └── api/
        ├── deps.py           # 依赖注入：get_db 重导出、get_current_user
        └── routes/           # 路由层，按域拆文件，与 services 同名对应
```

### 3.1 分层依赖规则（单向，禁止反向）

```
api/routes -> api/deps -> services -> models + core
schemas 被 routes/services 引用；core 不 import 业务模块
```

- **routes 层只做**：参数接收（Pydantic 模型）、调用 service、把 `ValueError` 等业务异常转成 `HTTPException`（400/404）。
- **services 层承载全部业务规则**（积分发放、步数覆盖、点亮判定、勋章判定、每日题目抽取）。路由中禁止出现业务规则代码。
- **schemas 层**是 API 契约：所有响应必须声明 `response_model`，禁止路由直接返回裸 dict/ORM 对象。

## 4. 架构不变量（改动时不得破坏）

1. **camelCase 输出契约**：所有响应模型继承 `CamelModel`（`alias_generator=to_camel`，`populate_by_name=True`，`from_attributes=True`），响应 JSON 字段必须为 camelCase 且与前端 Mock 返回结构一致。新增/修改字段若与前端 mock/data.js、services 结构不一致，视为破坏性变更。
2. **鉴权边界**：除 `POST /api/auth/login` 外，**所有**路由必须依赖 `Depends(get_current_user)`（token 无效抛 401）。新增公开接口需显式说明理由。
3. **种子幂等**：`data/seed.py` 的写入必须幂等（按主键存在即跳过），重复启动不得产生重复数据。修改种子数据时同步核对前端 `mock/data.js`。
4. **业务规则与前端 Mock 一致**（见 design.md §5）：积分规则、步数覆盖规则、每日一题规则、勋章判定阈值，前后端必须同步修改，禁止单边变更。
5. **副作用链**：凡影响步数、点亮、答题、积分的操作（sync/add/light-up/submit/login），调用后必须触发 `medal_service.check_and_grant`；积分发放必须统一走 `points_service`（保证「同日同 reason 去重」），禁止直接写 `PointsLog`。
6. **数据库会话**：一律通过 `Depends(get_db)` 获取，禁止在 service 内自建 session；session 由依赖自动关闭。
7. **JWT 载荷约定**：token 的 `sub` 为用户 id（int 的字符串形式），`app.core.security.decode_token` 失败时返回空，由 `deps.get_current_user` 统一转 401。

## 5. 编码规范（Python）

- **语言**：代码注释、docstring、异常 detail 一律使用中文（与现有代码一致）；标识符、日志使用英文。
- **格式**：PEP 8，4 空格缩进；模块级 docstring 说明职责；函数级 docstring 说明业务含义（尤其去重、幂等等关键行为）。
- **类型注解**：公开函数（service、路由依赖）必须有参数与返回类型注解，使用 `typing.Optional/List` 等（与现有代码风格一致）。
- **模型声明**：使用 SQLAlchemy 2.0 风格 `Mapped[T] = mapped_column(...)`；唯一约束用 `UniqueConstraint` 并显式命名（`uq_xxx`）。
- **Schema 声明**：响应模型字段顺序与前端 Mock 字段一致；可选字段给默认值（`Optional[int] = None`、`List[...] = []`）。
- **异常**：service 层抛 `ValueError` 表达业务失败；路由层转换为 `HTTPException`，错误 detail 面向用户（中文）。禁止 `except: pass` 吞异常。
- **配置**：新增配置项加到 `app/core/config.py` 的 `Settings`，带中文注释与默认值；禁止在业务代码中硬编码密钥/URL。
- **路由注册**：新路由文件需在 `app/main.py` 中 `app.include_router(...)` 注册；路由 `summary` 用中文一句话描述。

## 6. AI Agent 上下文约束规则（执行任务前必读）

在 backend 目录执行任何任务时：

1. **先读**：修改某域（如 quiz）前，先读 `app/api/routes/<域>.py`、`app/services/<域>_service.py`、`app/schemas/schemas.py` 相关段、`app/models/models.py` 相关模型；涉及规则时对照 `../frontend/services/<域>.js` 与 `../frontend/mock/data.js`。
2. **改接口必改三处**：新增/修改 API 需同步更新 ① `routes` ② `services`（如有业务） ③ `schemas`，并检查 `main.py` 注册与前端 Mock 结构一致性。
3. **改表结构**：涉及字段变更时，检查 `data/seed.py` 与默认值；当前无迁移工具，开发期可删 `*.db` 重建（`_smoke_test.db` 是冒烟测试产物，勿提交）。
4. **禁止行为**：
   - 禁止在路由中写业务规则；
   - 禁止绕过 `points_service` 直接写积分流水；
   - 禁止给响应加 snake_case 字段（破坏前端契约）；
   - 禁止破坏种子幂等性；
   - 禁止把 `_smoke_test.db`、`.env`、`__pycache__` 视为源码修改目标。
5. **验证**：改动后运行 `python run.py` 确认可启动；有测试习惯时用 TestClient 冒烟关键接口；接口文档以 `/docs`（Swagger）核对响应字段。
6. **同步文档**：接口、业务规则变更时，同步更新本目录 `design.md` 与 `README.md` 的「API 一览」「业务规则」章节。

## 7. 快速启动（背景知识）

```bash
cd backend
pip install -r requirements.txt
python run.py                 # 默认 http://127.0.0.1:8000，Swagger 在 /docs
```

首次启动自动建表 + 幂等写入种子数据；未配置 `WX_APPID`/`WX_SECRET` 时登录走 mock openid（开发调试用）。
