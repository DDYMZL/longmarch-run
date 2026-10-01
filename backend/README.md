# 长征运动挑战 · 后端（FastAPI）

长征主题「运动 + 每日答题」小程序的后端服务。业务逻辑由前端 `frontend/services/*.js` 的 Mock 实现**完整迁移**而来，数据结构与字段命名保持一致，前端可平滑切换。

## 技术栈

| 组件 | 选型 | 说明 |
| --- | --- | --- |
| Web 框架 | FastAPI + Uvicorn | 异步、自带 Swagger 文档 |
| ORM / 数据库 | SQLAlchemy 2.0 + openGauss | Docker 承载，`psycopg2` 连接 PostgreSQL 兼容协议 |
| 数据校验 | Pydantic v2 | 响应统一 camelCase 输出 |
| 鉴权 | PyJWT | 登录签发 Bearer Token |
| HTTP 客户端 | httpx | 调用微信 `code2Session` |

## 目录结构

```
docker/
├── compose.yml               # openGauss 服务、端口、账号和数据卷
└── init/
    ├── init-db.sh            # 建库并按文件名顺序执行未应用的 SQL
    └── 001_schema.sql        # backend 基线表结构
backend/
├── requirements.txt          # 依赖
├── .env.example              # 环境变量样例（复制为 .env）
├── run.py                    # 开发启动入口
└── app/
    ├── main.py               # 应用入口：种子数据 + 注册路由
    ├── core/                 # 基础设施
    │   ├── config.py         # 配置（pydantic-settings）
    │   ├── database.py       # 引擎 / 会话 / Base
    │   ├── security.py       # JWT 签发与校验
    │   └── helpers.py        # 日期、Mock 步数工具
    ├── models/models.py      # ORM 模型（静态配置表 + 用户业务表）
    ├── data/seed.py          # 种子数据：路线10 / 题库15 / 勋章6
    ├── schemas/schemas.py    # Pydantic 请求/响应模型
    ├── services/             # 业务逻辑（对应前端 services/*.js）
    └── api/                  # 依赖与路由
```

## 快速开始

先在项目根目录启动 openGauss。首次启动时，`database-init` 会创建数据库和全部表；后续启动只执行尚未登记的 SQL 文件。

```bash
docker compose -f docker/compose.yml up -d

cd backend
python -m venv .venv
# Windows:  .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env        # Windows；macOS/Linux 用 cp
python run.py                 # 或 uvicorn app.main:app --reload
```

| 数据库项 | 值 |
| --- | --- |
| 地址 | `127.0.0.1` |
| 端口 | `5118` |
| 数据库 | `longmarch` |
| 用户 | `gaussdb` |
| 密码 | `LongMarch@123` |

- 服务地址：<http://127.0.0.1:8010>
- 交互式文档（Swagger）：<http://127.0.0.1:8010/docs>
- 后端启动时只幂等写入业务种子数据，不负责建库建表。
- 密码中的 `@` 在 `DATABASE_URL` 中写为 `%40`。

## 配置项（.env）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql+psycopg2://gaussdb:LongMarch%40123@127.0.0.1:5118/longmarch` | 本地 Docker openGauss 连接串 |
| `JWT_SECRET` | 开发默认值 | **生产务必修改** |
| `JWT_EXPIRE_MINUTES` | `10080`（7天） | 令牌有效期 |
| `WX_APPID` / `WX_SECRET` | 空 | 留空时登录使用 mock openid，便于本地调试 |
| `CORS_ORIGINS` | `["*"]` | 跨域来源（JSON 数组） |

## 鉴权

除 `POST /api/auth/login` 外，所有接口都需要请求头：

```
Authorization: Bearer <登录返回的 token>
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 健康检查 |
| POST | `/api/auth/login` | 微信登录（body: `code`、可选 `nickname`/`avatar`），返回 `token` + `user` |
| GET | `/api/auth/me` | 当前登录用户信息 |
| GET | `/api/sport/today` | 今日步数概况 |
| POST | `/api/sport/sync` | 同步今日步数（同日覆盖，非累加） |
| GET | `/api/sport/recent?n=7` | 最近 n 天运动记录 |
| POST | `/api/sport/add` | 手动补充步数（演示用，body: `delta`） |
| GET | `/api/march/route` | 长征路线进度（含各节点状态） |
| GET | `/api/march/node/{node_id}` | 节点详情（任意状态可查看） |
| POST | `/api/march/light-up` | 点亮达标节点、发放积分 |
| GET | `/api/quiz/daily` | 今日题目（同一天同一套题） |
| POST | `/api/quiz/submit` | 提交答卷（每日一次，body: `answers`） |
| GET | `/api/quiz/records` | 答题记录 |
| POST | `/api/quiz/reset` | 重置今日答题（调试用） |
| GET | `/api/points` | 积分总额与流水 |
| GET | `/api/medal/list` | 勋章列表（含未获得） |
| POST | `/api/medal/check` | 检查并发放勋章 |
| GET | `/api/org/children?parentId=` | 按层级获取下级组织（留空返回顶级；无需鉴权） |
| GET | `/api/org/mine` | 我的所属组织（含全路径） |
| POST | `/api/org/select` | 选定/修改所属组织（body: `orgId`，可选任意层级） |
| GET | `/api/rank/steps` | 全员工累计步数总榜（跨所有组织，标记我的名次） |
| GET | `/api/admin/rankings` | 管理端全员排名、统计概览及每人全部节点到达时间 |

## 业务规则（与前端 Mock 完全一致）

- **步数**：按 `用户 + 日期` 唯一，同日同步为覆盖而非累加；未接入真实微信运动时按「日期+用户」生成稳定模拟步数（4000~12999）。
- **路线**：累计步数达到节点 `targetSteps` 即点亮，**点亮后永久保留**；节点状态分 `completed / current / unlocked`。
- **答题**：每日随机 5 题、每题 20 分、满分 100；同一用户同一天仅可完成一次；题目接口**不返回答案**。
- **积分**：登录 +1、运动 5000/10000 步 +5/+10、答题 +5 满分额外 +10、点亮节点 +10、完成路线 +100；**同日同原因去重**。
- **勋章**：`first-step`（首次运动）、`learner`（10 次答题）、`master`（积分≥500）、`luding`/`snow`（点亮节点 6/7）、`victory`（全部点亮）。
- **组织架构**：多级树（种子 13 个节点，4 级），用户可选定**任意层级**节点作为所属组织，登录后可随时修改。
- **排名**：**员工个人**总榜（非组织间排名），按累计步数（`DailySport.steps` 求和）降序，跨所有组织；同分按 `user_id` 升序保证名次稳定；返回前 `TOP_LIMIT`（默认 100）条并始终包含当前用户。

## 数据库结构维护

backend 所需的建库、建表、索引和结构变更统一维护在根目录 `docker/init/`：

1. `init-db.sh` 创建 `longmarch` 数据库和 `schema_migrations` 版本表。
2. `*.sql` 按文件名顺序执行，成功后写入版本表，同一脚本不会重复执行。
3. 新增或修改表结构时，新建递增编号脚本（如 `002_add_xxx.sql`），不要修改已在共享数据库执行过的脚本。
4. SQLAlchemy ORM 模型必须与 SQL 脚本同步修改；后端不调用 `create_all`。

本地需要彻底重建数据库时，可先执行 `docker compose -f docker/compose.yml down -v` 删除数据卷，再重新 `up -d`。该命令会清空本地数据库数据。

## 与前端对接说明

1. 前端 `frontend/services/` 目前仍是本地 Mock（读写 Storage），可独立运行、无需后端。
2. 切换到真实后端时，将各 service 内部实现改为 `wx.request` 调用上表接口即可；**响应字段已统一为 camelCase，与原 Mock 返回结构一致**，页面层无需改动。
3. 登录流程：前端 `wx.login()` 拿 `code` → `POST /api/auth/login` → 保存 `token` → 后续请求带 `Authorization: Bearer <token>`。

## 待完善（生产化 TODO）

- **微信登录**：配置真实 `WX_APPID`/`WX_SECRET`，`code2Session` 走真实接口。
- **微信运动步数**：`wx.getWeRunData` 返回加密数据，需在后端用 `session_key` 解密后落库（当前为模拟步数）。
- **头像存储**：`chooseAvatar` 得到的是小程序本地临时路径，对后端无意义；生产需前端上传头像文件到后端/对象存储，`avatar` 存可访问 URL。
- **数据库迁移**：引入 Alembic 管理表结构变更。
