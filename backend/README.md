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
    ├── 001_schema.sql        # backend 基线表结构
    ├── 002_route_node_config.sql  # 路线节点增加经纬度/排序/启用
    ├── 003_optional_user_avatar.sql  # avatar 改为可空
    ├── 004_nickname_change.sql  # 曾用名与改名时间
    └── 005_upgrade.sql       # 高级化升级：连续行军/事件表/历史事件卡/题目分类/勋章分类
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
    ├── models/models.py      # ORM 模型（静态配置表 + 用户业务表 + 事件表）
    ├── data/seed.py          # 种子数据：路线10（含历史内容）/ 题库15（含分类）/ 勋章12
    ├── schemas/schemas.py    # Pydantic 请求/响应模型
    ├── services/             # 业务逻辑（含 event/streak/profile/broadcast/dashboard）
    └── api/                  # 依赖与路由（含 ws/updates 实时推送）
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
| PUT | `/api/auth/nickname` | 修改昵称（body: `nickname`），每人仅一次，已修改过返回 400 |
| PUT | `/api/auth/nickname/initial` | 首次引导设置昵称（body: `nickname`），不消耗改名机会，已改过名返回 400 |
| GET | `/api/sport/today` | 今日步数概况 |
| POST | `/api/sport/sync` | 同步今日步数（同日覆盖，非累加） |
| GET | `/api/sport/recent?n=7` | 最近 n 天运动记录 |
| GET | `/api/sport/calendar?month=YYYY-MM` | 行军日历（当月每日步数/达标/答题/点亮 + 月统计） |
| POST | `/api/sport/add` | 手动补充步数（演示用，body: `delta`） |
| GET | `/api/profile/summary` | 个人档案聚合（加入天数/连续行军/各项统计/路线完成度） |
| GET | `/api/profile/timeline` | 我的长征足迹（user_event 时间轴） |
| GET | `/api/broadcast/today` | 今日长征播报（期号/全局汇总/今日长征彩蛋/个人状态） |
| GET | `/api/march/route` | 长征路线进度（含各节点状态，仅统计启用节点） |
| GET | `/api/march/route-nodes` | 启用节点配置列表（含经纬度，供小程序缓存） |
| GET | `/api/march/node/{node_id}` | 节点详情（任意状态可查看） |
| POST | `/api/march/light-up` | 点亮达标节点、发放积分 |
| GET | `/api/quiz/daily` | 今日题目（同一天同一套题） |
| POST | `/api/quiz/submit` | 提交答卷（每日一次，body: `answers`） |
| GET | `/api/quiz/records` | 答题记录 |
| GET | `/api/quiz/knowledge` | 知识画像（总正确率 + 分类正确率） |
| POST | `/api/quiz/reset` | 重置今日答题（调试用） |
| GET | `/api/points` | 积分总额与流水 |
| GET | `/api/medal/list` | 勋章列表（含未获得） |
| POST | `/api/medal/check` | 检查并发放勋章 |
| GET | `/api/org/children?parentId=` | 按层级获取下级组织（留空返回顶级；无需鉴权） |
| GET | `/api/org/mine` | 我的所属组织（含全路径） |
| POST | `/api/org/select` | 选定/修改所属组织（body: `orgId`，可选任意层级） |
| GET | `/api/rank/steps` | 全员工累计步数总榜（跨所有组织，标记我的名次） |
| WS | `/api/ws/updates?token=` | 实时推送：数据变更 `data_changed`、用户事件 `activity` |
| POST | `/api/admin/login` | 管理后台登录（body: `username`/`password`） |
| GET | `/api/admin/dashboard` | 驾驶舱聚合（核心指标 + 路线总览） |
| GET | `/api/admin/dashboard/trend?days=` | 运动趋势（近 N 日） |
| GET | `/api/admin/activities?limit=` | 实时动态（user_event 倒序） |
| GET | `/api/admin/screen` | 数据大屏聚合（指标 + 路线总览 + 7 日趋势 + 动态） |
| GET | `/api/admin/rankings` | 管理端全员排名、统计概览及每人全部节点到达时间 |
| GET | `/api/admin/users/{id}/overview` | 人员详情聚合（运动/答题/勋章/长征/积分） |
| GET | `/api/admin/route-nodes` | 全部路线节点列表（含停用节点） |
| POST | `/api/admin/route-nodes` | 新增路线节点（校验坐标/步数/排序/递增） |
| PUT | `/api/admin/route-nodes/{id}` | 编辑路线节点（含历史事件卡内容字段） |
| PATCH | `/api/admin/route-nodes/{id}/enabled` | 启用/停用路线节点 |
| GET/POST/PUT/DELETE | `/api/admin/questions[/{id}]` | 题库 CRUD（含知识分类） |
| GET/POST/PUT/DELETE | `/api/admin/orgs[/{id}]` | 组织架构 CRUD；`POST /api/admin/orgs/sync` 外部同步 |

## 业务规则（与前端 Mock 完全一致）

- **步数**：按 `用户 + 日期` 唯一，同日同步为覆盖而非累加；未接入真实微信运动时按「日期+用户」生成稳定模拟步数（4000~12999）。
- **路线**：累计步数达到节点 `targetSteps` 即点亮，**点亮后永久保留**；节点状态分 `completed / current / unlocked`。管理后台可启停节点，停用节点不在小程序可见路线中，不参与完成判定和排名，但已有点亮记录保留。
- **答题**：每日随机 5 题、每题 20 分、满分 100；同一用户同一天仅可完成一次；题目接口**不返回答案**。
- **积分**：登录 +1、运动 5000/10000 步 +5/+10、答题 +5 满分额外 +10、点亮节点 +10、完成路线 +100；**同日同原因去重**。
- **勋章**：12 枚分入门/路线/挑战/完成四类：`first-step`（首次运动）、`learner`（10 次答题）、`persistence`（连续行军 7 天）、`luding`/`snow`（点亮泸定桥/雪山）、`day-10k`（单日万步）、`steps-100k`/`steps-500k`（累计 10 万/50 万步）、`streak-30`（连续行军 30 天）、`master`（积分≥500）、`fearless`（连续 7 天日万步，隐藏）、`victory`（全部**启用**节点点亮）。
- **连续行军**：当日步数 ≥ 5000（`STREAK_GOAL_STEPS` 可配）即完成当日行军；`daily_sport.is_goal_completed` 为判定依据，`users.continuous_days/max_continuous_days` 为冗余缓存。
- **事件系统**：用户成就（首次运动/当日达标/连续里程碑/点亮/勋章/答题等）统一落 `user_event` 并生成中文文案，小程序足迹时间轴与管理端实时动态共用此数据源。
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

1. 前端 `frontend/services/auth.js` 已对接真实后端登录（`wx.login` → `POST /api/auth/login` → JWT）；`march.js` 已对接路线节点配置（`GET /api/march/route-nodes`，三级降级：网络→缓存→内置 Mock）。
2. 其余业务（sport/quiz/points/medal/org/rank）也已全量切换为真实接口（`wx.request` + JWT）；**响应字段为 camelCase，与原 Mock 返回结构一致**，前端页面层零改动。
3. 登录流程：前端 `wx.login()` 拿 `code` → `POST /api/auth/login` → 保存 `token` 到 `lm_auth_token` → 后续请求带 `Authorization: Bearer <token>`。401 时自动清理登录态并跳转登录页。
4. 管理端实时推送：`GET /api/ws/updates?token=<JWT>` 建立 WebSocket 长连接（admin 与用户 token 均可），小程序侧任何用户数据写入（步数/答题/点亮/组织/登录/勋章）成功后广播 `data_changed` 事件，`user_event` 写入时额外广播 `activity`（含昵称与文案）；管理端驾驶舱/数据大屏据此自动刷新并滚动实时动态。

## 待完善（生产化 TODO）

- **微信登录**：配置真实 `WX_APPID`/`WX_SECRET`，`code2Session` 走真实接口。
- **微信运动步数**：`wx.getWeRunData` 返回加密数据，需在后端用 `session_key` 解密后落库（当前为模拟步数）。
- **头像存储**：`chooseAvatar` 得到的是小程序本地临时路径，对后端无意义；生产需前端上传头像文件到后端/对象存储，`avatar` 存可访问 URL。
- **数据库迁移**：引入 Alembic 管理表结构变更。
