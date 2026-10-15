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
    ├── 005_upgrade.sql       # 高级化升级：连续行军/事件表/历史事件卡/题目分类/勋章分类
    └── 010_admin_identity.sql  # 身份关联/RBAC/审计八表 + 菜单与内置角色种子
backend/
├── requirements.txt          # 依赖
├── .env.example              # 环境变量样例（复制为 .env）
├── run.py                    # 开发启动入口
└── app/
    ├── main.py               # 应用入口：种子数据 + 注册路由
    ├── core/                 # 基础设施
    │   ├── config.py         # 配置（pydantic-settings）
    │   ├── database.py       # 引擎 / 会话 / Base
    │   ├── security.py       # JWT 签发与校验（小程序 + 超管/关联管理员）
    │   └── helpers.py        # 日期、Mock 步数工具
    ├── models/models.py      # ORM 模型（静态配置表 + 用户业务表 + 事件表 + 身份/RBAC/审计表）
    ├── data/seed.py          # 种子数据：路线10（含历史内容）/ 题库15（含分类）/ 勋章12 / 菜单9 / 内置角色
    ├── schemas/schemas.py    # Pydantic 请求/响应模型
    ├── services/             # 业务逻辑（含 identity/access/audit/wechat）
    └── api/                  # 依赖与路由（含 ws/updates 实时推送与管理后台 RBAC 接口）
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
- 后端启动时幂等写入业务种子数据，并按 `daily_sport` 分批核对修复步行积分台账；不负责建库建表。
- 密码中的 `@` 在 `DATABASE_URL` 中写为 `%40`。

## 配置项（.env）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql+psycopg2://gaussdb:LongMarch%40123@127.0.0.1:5118/longmarch` | 本地 Docker openGauss 连接串 |
| `JWT_SECRET` | 开发默认值 | **生产务必修改** |
| `JWT_EXPIRE_MINUTES` | `10080`（7天） | 小程序令牌有效期 |
| `JWT_ADMIN_EXPIRE_MINUTES` | `720`（12小时） | 管理员令牌有效期（RBAC 每请求查库，长时效兜底） |
| `ADMIN_PASSWORD` | 空 | 管理后台账号密码；**留空则账号登录禁用**，仅允许微信扫码登录（不设默认密码） |
| `WX_APPID` / `WX_SECRET` | 空 | 留空时登录使用 mock openid，便于本地调试；已配置时微信换取失败返回 502 |
| `WX_LOGIN_ALLOW_MOCK` | `false` | 仅本地 automator 测试：已配置凭证时换取失败仍回退 mock openid；**生产必须为 false** |
| `WX_WEB_APPID` / `WX_WEB_SECRET` | 空 | 微信网页授权渠道凭证（阶段2 门控，未配置不开放） |
| `WXACODE_ENV_VERSION` | `trial` | 小程序码环境版本：开发期 `trial`（体验版码，扫码者须为体验成员）；生产发布后改 `release` |
| `QR_LOGIN_TTL_SECONDS` | `300` | PC 扫码登录会话有效期 |
| `BIND_REQUEST_TTL_SECONDS` | `600` | 身份绑定请求有效期 |
| `CORS_ORIGINS` | `["*"]` | 跨域来源（JSON 数组） |

## 鉴权

- **小程序令牌**（`typ=user`，`sub`=user_id）：除 `POST /api/auth/login`、`POST /api/auth/invite/verify`、`POST /api/auth/onboard`、`GET /api/org/children`、`GET /api/activity/status` 外，所有小程序接口都需要请求头：
  ```
  Authorization: Bearer <登录返回的 token>
  ```
- **管理员令牌**：`typ=super`（配置超管，`sub`=username，账号登录签发）/ `typ=user`（微信关联管理员，`sub`=user_id，扫码确认后由 PC 轮询接口**单次签发**）。`/api/admin/*` 除 `POST /api/admin/login`、`POST /api/admin/wechat/qr`、`GET /api/admin/wechat/qr/{qr_id}/status` 外均需管理员令牌，并按菜单码校验（超管全放行；角色缺菜单 403）。`get_current_admin` **每请求查库**，角色撤销/禁用即时生效。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 健康检查 |
| GET | `/api/activity/status` | 活动状态（公开，启动页登录前判定）：`{name, status, statusText, startAt, endAt, allowParticipate, allowView, restrictEnabled, endTitle, message, serverTime}`，时间均为 +08:00 |
| POST | `/api/auth/login` | 微信登录（body: `code`、可选 `avatar`）：仅为**已入驻**用户签发 `{status:"active", token, user}`；未入驻 `{status:"unregistered"}`、已停用 `{status:"disabled"}` 均不签发 Token；微信换取失败 502 |
| POST | `/api/auth/invite/verify` | 校验入驻邀请码 `{inviteCode}`（不核销，限流），返回 `{name, orgId, orgName}`；不可用（无效/停用/过期/用满）400 |
| POST | `/api/auth/onboard` | 持邀请码入驻 `{code, inviteCode, nickname, orgId, avatar?}`：原子核销 + 建号 + 签发 Token，返回 `{token, user, created}`；已入驻身份重复提交幂等返回；邀请码不可用或组织越界 400；账号已停用 403（头 `X-Account-Status: disabled`） |
| GET | `/api/auth/me` | 当前登录用户信息 |
| PUT | `/api/auth/nickname` | 修改昵称（body: `nickname`），每人仅一次，已修改过返回 400 |
| PUT | `/api/auth/nickname/initial` | 首次引导设置昵称（body: `nickname`），不消耗改名机会，已改过名返回 400 |
| GET | `/api/sport/today` | 今日步数概况 |
| POST | `/api/sport/sync` | 解密并同步微信运动最近 7 个北京时间自然日；缺失日期不写 0 且可重试，返回今日步数、成功/失败日期、积分修正与步数结余 |
| GET | `/api/sport/recent?n=7` | 最近 n 天运动记录 |
| GET | `/api/sport/calendar?month=YYYY-MM` | 行军日历（当月每日步数/达标/答题/点亮 + 月统计） |
| POST | `/api/sport/add` | 手动补充步数（演示用，body: `delta`） |
| GET | `/api/profile/summary` | 个人档案聚合（加入天数/连续行军/各项统计/路线完成度）；stats 含 `totalSteps` 原始累计与 `scoredTotalSteps` 计分口径（各日封顶 20000 求和） |
| GET | `/api/profile/timeline` | 我的长征足迹（user_event 时间轴） |
| GET | `/api/broadcast/today` | 今日长征播报（期号/全局汇总/今日长征彩蛋/个人状态） |
| GET | `/api/march/route` | 长征路线进度（含各节点状态，仅统计启用节点） |
| GET | `/api/march/route-nodes` | 启用节点配置列表（含经纬度） |
| GET | `/api/march/node/{node_id}` | 节点详情（任意状态可查看，含路线经纬度） |
| POST | `/api/march/light-up` | 点亮达标节点、发放积分并判定勋章（返回 newMedals） |
| GET | `/api/quiz/daily` | 今日固定答题状态（按用户个人使用轮次随机抽题；逐题进度、当前题、题库不足状态；不开题） |
| POST | `/api/quiz/start` | 开始/继续当前题（幂等，每题 90 秒服务器计时） |
| POST | `/api/quiz/answer` | 提交当前题（body: `questionId`、`answer`；每题一次，超时拒绝） |
| GET | `/api/quiz/records` | 答题记录 |
| GET | `/api/quiz/knowledge` | 知识画像（总正确率 + 分类正确率） |
| POST | `/api/quiz/reset` | 重置今日答题（调试用） |
| GET | `/api/points` | 积分概览：`total`（= walk + quiz）/ `walk` / `quiz` / 今日两项及计分依据 / `walkCarry` 当前步数结余 / `rank` / `rules` |
| GET | `/api/points/daily?page=&page_size=` | 积分明细：按自然日倒序分页，每天步行/答题积分与当日步数、答对数 |
| GET | `/api/medal/list` | 勋章列表（含未获得） |
| POST | `/api/medal/check` | 检查并发放勋章 |
| GET | `/api/org/children?parentId=` | 按层级获取下级组织（留空返回顶级；无需鉴权） |
| GET | `/api/org/mine` | 我的所属组织（含全路径、`locked` 是否已锁定、专属码范围 `scopeOrgId`） |
| POST | `/api/org/select` | 首次选定所属组织（body: `orgId`，可选任意层级）；已有组织 403「所属部门已锁定」，`org_id IS NULL` 条件更新防并发 |
| GET | `/api/rank/points?page=&page_size=` | 全员工总积分榜：`top` 第 1~10 名、`list` 第 11 名起分页、`me` 当前用户（始终返回） |
| GET | `/api/rank/steps` | 旧版榜单契约（前 100 名 + 我），名次与总积分榜一致 |
| GET | `/api/quotes/today` | 今日寄语（启用寄语按排序号自循环起始日期起每天一条循环；无启用寄语返回 null） |
| POST | `/api/auth/qr/info` | 查询扫码场景 `{scene}`：L 登录确认 / B 绑定确认（含目标渠道信息），pending 置 scanned |
| POST | `/api/auth/qr/confirm` | 确认/取消扫码 `{scene, action}`：L 无后台角色 403（会话置 failed），有角色置 confirmed；B 事务写身份（unionid 冲突不合并） |
| GET | `/api/auth/identities` | 当前用户已绑定身份列表（wx_mini 主身份不可解绑） |
| DELETE | `/api/auth/identities/{id}` | 解绑身份（主身份 400，写审计） |
| WS | `/api/ws/updates?token=` | 实时推送：数据变更 `data_changed`、用户事件 `activity` |
| POST | `/api/admin/login` | 管理后台账号登录（body: `username`/`password`；`ADMIN_PASSWORD` 未配置时 403，仅扫码登录） |
| POST | `/api/admin/wechat/qr` | 创建扫码登录会话（无需鉴权）：mock 模式返回明文 scene 供调试 |
| GET | `/api/admin/wechat/qr/{qr_id}/status` | 轮询扫码状态（无需鉴权，限流）：confirmed 时单次签发管理员令牌与菜单 |
| GET/POST | `/api/admin/invites[?keyword=&page=]` | 入驻邀请码列表（分页/关键字）/ 生成（`{name, remark?, org_id?, max_uses?, expires_at?}`，`expires_at` 带时区 ISO 存 UTC naive） |
| PATCH | `/api/admin/invites/{id}` | 部分更新：名称/备注/组织范围/次数上限/有效期/启停（`max_uses` 不得低于 `used_count`） |
| GET | `/api/admin/invites/{id}/qrcode` | 邀请码小程序码 `{image?, page:"pages/launch/launch", scene:"i=<code>", env_version, mock}`：码内仅含邀请码标识，不含个人信息/OpenID/Token，成功结果进程内缓存；mock 模式 image 为 None |
| PATCH | `/api/admin/users/{uid}/status` | 启用/停用用户 `{status:"active"|"disabled"}`（即时断权；超管以外禁止改自身） |
| GET | `/api/admin/me` | 当前管理员信息与菜单权限 |
| GET | `/api/admin/dashboard` | 驾驶舱聚合（核心指标 + 路线总览） |
| GET | `/api/admin/dashboard/trend?days=` | 运动趋势（近 N 日） |
| GET | `/api/admin/activities?limit=` | 实时动态（user_event 倒序） |
| GET | `/api/admin/screen` | 数据大屏聚合（指标 + 路线总览 + 7 日趋势 + 动态） |
| GET | `/api/admin/rankings` | 管理端全员排名（与小程序同口径按总积分）：服务端分页与筛选（关键字/组织/已改名），全员指标（含总积分）与前 10 名荣誉榜，当前页每人总/步行/答题积分与全部节点到达时间 |
| POST | `/api/admin/points/verify` | 积分台账核对 `{fix?, user_ids?}`：按每日步数/答题记录重算比对，`fix=true` 修复差异并写审计 `points.recompute` |
| GET | `/api/admin/rankings/export` | 按筛选条件流式导出排名 CSV（含总积分/步行积分/答题积分列） |
| GET | `/api/admin/users/{id}/overview` | 人员详情聚合（运动/答题/勋章/长征/积分） |
| GET | `/api/admin/route-nodes` | 全部路线节点列表（含停用节点） |
| POST | `/api/admin/route-nodes` | 新增路线节点（校验坐标/步数/排序/递增） |
| PUT | `/api/admin/route-nodes/{id}` | 编辑路线节点（含历史事件卡内容字段） |
| PATCH | `/api/admin/route-nodes/{id}/enabled` | 启用/停用路线节点 |
| GET/POST/PUT/DELETE | `/api/admin/questions[/{id}]` | 题库 CRUD（DELETE 为软停用，不影响当天已生成任务） |
| GET | `/api/admin/questions/import-template` | 下载题库 Excel 导入模板（数据表 + 填写说明） |
| POST | `/api/admin/questions/import-preview` / `import-confirm` | 题库批量导入：上传 .xlsx 逐行校验返回预览令牌与错误明细 → 凭令牌一次性整批写入 |
| GET/POST/PUT/DELETE | `/api/admin/quotes[/{id}]` | 每日寄语 CRUD（排序号/启用状态/出处/关联节点；按排序号升序分页，keyword 搜内容/出处） |
| GET/PUT | `/api/admin/quotes/cycle` | 寄语循环信息（起始日期、启用条数、今日展示寄语与序号）/ 修改循环起始日期 `{start_date}` |
| GET | `/api/admin/quotes/import-template` | 下载寄语 Excel 导入模板（寄语内容/出处/排序号/启用状态/关联节点 + 填写说明） |
| POST | `/api/admin/quotes/import-preview` / `import-confirm` | 寄语批量导入：逐行校验（定位到行与字段，库内/文件内重复判错不覆盖）→ 凭令牌一次性写入 |
| GET/POST/PUT/DELETE | `/api/admin/orgs[/{id}]` | 组织架构 CRUD；GET 树每节点含 `direct_user_count`（直属人数）与 `total_user_count`（含下级累计）；`POST /api/admin/orgs/sync` 外部同步 |
| GET | `/api/admin/orgs/{id}/users?scope=&page=&page_size=` | 组织人员明细（分页）：`scope=direct` 仅直属成员，`scope=all` 含全部层级下级，与组织树两列统计口径一致 |
| GET | `/api/admin/users?keyword=&org_id=&status=&page=` | 人员授权列表（昵称/组织/账号状态筛选、分页），每项含启用/禁用角色、`status`、`invite_code_id`、`invite_name`、`onboarded_at` |
| PUT | `/api/admin/users/{user_id}/org` | 管理员调整用户所属组织 `{org_id}`（菜单 access）；写审计 `user.org_change`（操作人/原组织/新组织/时间），未变化不写；用户或组织不存在 404 |
| GET/POST | `/api/admin/roles[/{id}]` | 角色列表/新建（含菜单勾选）；PUT 编辑名称与菜单、DELETE 删除（内置/已授权 400） |
| POST | `/api/admin/users/{uid}/roles` | 全量覆盖用户角色 `{role_ids}`（逐项审计） |
| PATCH | `/api/admin/users/{uid}/roles/{rid}/enabled` | 启用/禁用单个角色授权（即时生效，不改授权关系） |
| GET | `/api/admin/audit-logs?date=&action=&actor=` | 审计日志分页（日期/动作/操作人筛选，倒序） |
| GET/PUT | `/api/admin/activity` | 活动设置（菜单 `activity`）：查看当前配置与实时状态 / 保存 `{name, start_at, end_at, restrict_enabled, allow_view_after_end, end_title?, end_message?}`（北京时间、精确到分钟、开始须早于结束，写审计 `activity.update`） |
| POST | `/api/admin/activity/publish` | 发布/撤回活动 `{published}`（审计 `activity.publish`/`activity.unpublish`），即时生效 |

## 业务规则（与前端 Mock 完全一致）

- **步数**：按 `用户 + 日期` 唯一；首页今日行军目标为 20000 步。`wx.getWeRunData` 的加密 `stepInfoList` 由后端校验解密，以北京时间筛选最近 7 个自然日并逐日覆盖。微信本次未返回的日期不写 0、不覆盖旧值，响应列入 `failedDates` 供重试；前端当前步数区只展示今天。仅 mock 用户/未配置微信凭证的开发环境按「日期+用户」稳定模拟最近 7 日，真实用户绝不造数。每日记录保存 `source / synced_at / sync_status`。
- **路线**：累计步数达到节点 `targetSteps` 即点亮，**点亮后永久保留**；节点状态分 `completed / current / unlocked`。管理后台可启停节点，停用节点不在小程序可见路线中，不参与完成判定和排名，但已有点亮记录保留。
- **答题**：每个用户独立按题目历史使用次数轮换，优先从本人未使用/当前轮使用次数最少的题中随机抽取；不足 5 题时逐层跨入下一轮补足，当天不重复，同日 `daily_questions` 固定不重抽。题库仅 1~4 道时按实际数量返回并给出 `questionShortage / shortageMessage`。题目停用不再进入新任务，但当天既有任务仍可完成。逐题开题与 90 秒服务器计时、单次提交和超时规则保持不变。
- **积分**（V2.0）：**总积分 = 步行积分 + 答题积分**，仅后端计算。步行每日最多取 20000 步参与计分，按日期顺序累计后每满 1000 步得 1 分，不足 1000 的零头结余到下一条运动记录（单日最高仍为 20）；答题每答对 1 题 +2、单日最高 10。台账按 `用户 + 来源 + 日期` 唯一并覆盖重算；步数同步/补录/修正后会按运动源数据全量核对修复该用户步行台账（累计步行积分恒等于 累计计分步数 ÷ 1000 向下取整），重复同步与重放不重复计分；应用启动时同样仅按 `daily_sport` 修复历史步行台账，不改答题积分。旧 `legacy` 流水仅追溯不计入。
- **勋章**：12 枚分入门/路线/挑战/完成四类：`first-step`（首次运动）、`learner`（10 次答题）、`persistence`（连续行军 7 天）、`luding`/`snow`（点亮泸定桥/雪山）、`day-10k`（单日万步）、`steps-100k`/`steps-500k`（累计 10 万/50 万步）、`streak-30`（连续行军 30 天）、`master`（积分≥500）、`fearless`（连续 7 天日万步，隐藏）、`victory`（全部**启用**节点点亮）。
- **连续行军**：当日步数 ≥ 5000（`STREAK_GOAL_STEPS` 可配）即完成当日行军；`daily_sport.is_goal_completed` 为判定依据，`users.continuous_days/max_continuous_days` 为冗余缓存。
- **事件系统**：用户成就（首次运动/当日达标/连续里程碑/点亮/勋章/答题等）统一落 `user_event` 并生成中文文案，小程序足迹时间轴与管理端实时动态共用此数据源。
- **组织架构**：多级树（种子 13 个节点，4 级），用户可选定**任意层级**节点作为所属组织，**首次确定（入驻或首次选择）后锁定**，用户侧无修改入口，仅管理员可调整并留审计；管理端组织树按节点统计直属人数与含下级累计人数。
- **排名**：**员工个人**总榜（非组织间排名），按总积分降序，同分按累计步数降序、再按 `user_id` 升序保证名次稳定；小程序、管理端、CSV 与「我的」名次共用 `rank_service.ranked_users_subquery`。
- **每日寄语**：启用寄语按 `(sort_order, id)` 升序排列共 N 条，今日展示第 `(今天 − 循环起始日期).days % N` 条（起始日期存 `system_settings.quote_cycle_start`，后台可改；起始日期在未来时展示第 1 条）；同一天所有用户看到同一条，停用/新增/删除后按最新启用列表重算；无启用寄语返回 null。Excel 导入未填排序号的行接在库内与文件内已填排序号最大值之后。
- **身份关联**：认证（JWT）/ 身份关联（user_identities）/ 后台授权（RBAC）三层分离，绑定身份成功**不等于**拥有后台权限；`wx_mini` 登录凭证身份不可解绑；同一 `provider+app_id+openid` 全局唯一，unionid 冲突**禁止自动合并**；绑定凭证只存 SHA-256 摘要，确认后单次有效。
- **扫码登录**：L 场景创建→轮询→小程序确认（无启用角色会话置 failed 并返回原因）→PC 轮询 confirmed 后**单次签发**管理员 JWT（token_issued 原子标记防重放）。
- **邀请码准入**：PC 后台生成邀请码（名称/可选组织范围/可选次数上限/可选有效期）；员工扫邀请码小程序码落地 `pages/launch/launch`，`scene=i=<code>`。启动页按 `wx.login` 识别微信身份：active 直接进入首页；unregistered + 有效邀请码 → 入驻页填姓名/组织（专属码仅可在允许组织范围内选）；无效邀请码或无邀请码扫描 → 准入拦截。入驻接口在一个事务中条件 UPDATE 核销（`used_count < max_uses` 且未过期未停用）+ 建号 + 审计，openid 唯一约束冲突回滚撤销核销；并发首登复用同一用户仅核销一次。历史用户（无 `invite_code_id`）保持 active 不受限。
- **RBAC**：超管全菜单放行；微信关联管理员按启用角色的菜单并集校验，每请求查库——撤销/禁用即时生效；授权/角色变更逐项写审计。

- **活动时间控制**：`activity_settings` 单行配置，状态按服务器时间实时计算（未发布/未开始/进行中/已结束，北京时间）。启用访问限制时：非进行中拒绝全部写接口（步数同步/补充、答题、点亮、勋章检查、组织选择），403 + 头 `X-Activity-Status`；读接口（排行/积分/档案/路线/答题记录等）在活动结束后按 `allow_view_after_end` 放行；`/medal/list` 在不可参与时只读不发放。鉴权先于活动校验（无 Token 仍 401）。业务日期统一按北京时间（UTC+8）。

## 数据库结构维护

backend 所需的建库、建表、索引和结构变更统一维护在根目录 `docker/init/`：

1. `init-db.sh` 创建 `longmarch` 数据库和 `schema_migrations` 版本表。
2. `*.sql` 按文件名顺序执行，成功后写入版本表，同一脚本不会重复执行。
3. 新增或修改表结构时，新建递增编号脚本（如 `002_add_xxx.sql`），不要修改已在共享数据库执行过的脚本。
4. SQLAlchemy ORM 模型必须与 SQL 脚本同步修改；后端不调用 `create_all`。

本地需要彻底重建数据库时，可先执行 `docker compose -f docker/compose.yml down -v` 删除数据卷，再重新 `up -d`。该命令会清空本地数据库数据。

## 与前端对接说明

1. 前端 `frontend/services/auth.js` 已对接真实后端登录（`wx.login` → `POST /api/auth/login` → JWT）；`march.js` 已对接路线数据（`GET /api/march/route`，节点配置随路线统一下发）。
2. 其余业务（sport/quiz/points/medal/org/rank）也已全量切换为真实接口（`wx.request` + JWT）；**响应字段为 camelCase，与原 Mock 返回结构一致**，前端页面层零改动。
3. 登录流程：前端 `wx.login()` 拿 `code` → `POST /api/auth/login` → active 时保存 `token` 到 `lm_auth_token`，unregistered 走 `/auth/invite/verify` + `/auth/onboard` 入驻（扫邀请码进入启动页）。后续请求带 `Authorization: Bearer <token>`；启动页先 `GET /api/auth/me` 后端校验 Token，401 时静默 `wx.login` 重登并重试一次，重登失败回启动页；受保护接口对已停用用户返回 403（头 `X-Account-Status: disabled`），前端据此清登录态并回启动页展示准入拦截。
4. 管理端实时推送：`GET /api/ws/updates?token=<JWT>` 建立 WebSocket 长连接（admin 与用户 token 均可），小程序侧任何用户数据写入（步数/答题/点亮/组织/登录/勋章）成功后广播 `data_changed` 事件，`user_event` 写入时额外广播 `activity`（含昵称与文案）；管理端驾驶舱/数据大屏据此自动刷新并滚动实时动态。

## 待完善（生产化 TODO）

- **微信登录**：配置真实 `WX_APPID`/`WX_SECRET`，`code2Session` 走真实接口。
- **微信运动真机验收**：前端 `wx.getWeRunData` 取加密数据连同 `wx.login` code 上送，后端已按 `stepInfoList` 实际返回范围处理最近 7 日；仍需在已开通微信运动的真机账号验证微信侧实际返回范围及跨午夜归日。
- **头像存储**：`chooseAvatar` 得到的是小程序本地临时路径，对后端无意义；生产需前端上传头像文件到后端/对象存储，`avatar` 存可访问 URL。
- **数据库迁移**：引入 Alembic 管理表结构变更。
