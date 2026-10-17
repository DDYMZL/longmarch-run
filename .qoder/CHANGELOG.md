# CHANGELOG · 长征步迹 项目级变更记录

> 最后核对时间：2026-10-17（对应 HEAD `031c323`）

## 0. 本文档的定位与分工

**`docs/迭代记录.md` 是提交级历史的唯一权威**：138 条记录，按日期倒序，每条含提交号、时间、范围、内容摘要、验证结果。本文档**不复制**这些条目。

本文档承担的是**版本级 / 阶段级的横向影响分析** —— 按用户要求的十字段（日期、需求背景、涉及模块及文件、修改内容、数据库变更、API 变更、兼容性影响、测试结果、部署情况、未解决的问题），把散落在 138 条提交记录里的变更聚合成「一次交付做了什么、动了哪些库表和接口、对存量数据和线上有什么影响」。

**需要查某个具体提交的细节时，请到 `docs/迭代记录.md` 按提交号检索。** 本文档所有条目均标注了关键提交号作为索引。

**编写纪律**：只记录有依据的实际变更。「部署情况」在仓库内无证据时一律标 **待确认**，不推测。「未解决的问题」只列当前仍可核对为真的项。

---

## 1. 阶段索引

| # | 阶段 | 日期区间 | 主要提交 |
|---|---|---|---|
| 1 | 项目初始化与 Mock 时代 | 2026-09-30 | `80f996a`、`a94e685`、`b0ba252`、`4a26520` |
| 2 | 真实后端接入与 openGauss 迁移 | 2026-10-01 | `899`(见记录)、`892`、`886`、`829`、`837` |
| 3 | 高级化升级 P0/P1/P2 | 2026-10-01 ~ 10-04 | P0-1…P0-4、P1-1…P1-8、P2-1、P2-2 |
| 4 | 身份关联与 RBAC（批次 1–6） | 2026-10-09 | `852013f`→`06b6313`→`b431e4d`→`4bf9acd`→`54a0de7`→`6ed1999`→`c688ebb` |
| 5 | V1.0 扫码入驻与自动登录 | 2026-10-11 | `cc66b8b`、`495d845`、`67c96b1`、`225f99c`、`01e214a`、`76f8387` |
| 6 | 性能优化与代码审查整改 | 2026-10-11 | `f59892e`、`b5d6035`、`30b4458`、`e70b59f`、`d6acf7e` |
| 7 | 安全加固与邀请码准入 | 2026-10-12 | `2d20dc9`、`25c954c`、`afbcba9`、`8d63b6f` |
| 8 | V2.0 六项需求 | 2026-10-13 | `ce14a95`、`2f3f333`、`07d02af`、`78a12ca`、`19b0d73`、`e197a28`、`44eb77b`、`4f349cb` |
| 9 | 生产化与联调地址收敛 | 2026-10-13 ~ 10-16 | `ad1d747`、`1e2d53b`、`527db98`、`79cf738`、`a0ca154`、`f05531a`、`761d860`、`6cdd80a` |
| 10 | 计分规则连续修正（4 连击） | 2026-10-15 | `4afccdd`→`83d3552`→`85c5a55`→`9cb65b8` |
| 11 | openGauss 兼容事故与更正 | 2026-10-13、10-16 | `fc2597e`、`f413ac6`→`51239b5` |
| 12 | AI 出题（题库接入 CloudBase Agent） | 2026-10-16 | `ea58b6c` |
| 13 | AI 智能中心 V1.0 Phase A | 2026-10-17 | `37f3e40`、`1600074`、`0052108`、`1fbacac` |

---

## 2. 阶段详情

### 2.1 项目初始化与 Mock 时代

- **日期**：2026-09-30
- **需求背景**：从零搭建「长征运动挑战」项目，先以小程序 + Mock 数据跑通业务形态，再补管理后台骨架。
- **涉及模块及文件**：`backend/`（初始代码）、`frontend/`（初始代码）、`admin/`（基础页面与依赖配置）、`docs/`（前后端 AGENTS.md 与 design.md）
- **修改内容**：`80f996a` 建立前后端 AGENTS.md 与 design.md；`a94e685` 仓库初始代码；`b0ba252` 强制已登录用户完成组织选择流程；`4a26520` 管理后台基础页面及依赖配置。
- **数据库变更**：初始 schema（后续整理为 `docker/init/001_schema.sql`）。
- **API 变更**：初始接口集。
- **兼容性影响**：无（首个版本）。此阶段小程序数据层为本地 Mock，遗留 `lm_data_{userId}` Storage 键与 `frontend/services/store.js` 迁移逻辑即源于此。
- **测试结果**：无正式测试报告。
- **部署情况**：未部署。
- **未解决的问题**：Mock 时代遗留的 `lm_data_{userId}` 键**永不删除**，是否有清理计划待确认；`frontend/services/store.js` 仅作迁移用途仍保留在包内。

### 2.2 真实后端接入与 openGauss 迁移

- **日期**：2026-10-01（28 个提交，单日峰值）
- **需求背景**：小程序从本地 Mock 切换为真实后端接口；数据库从 SQLite 切换为 openGauss 以对齐生产；建立管理端实时刷新能力。
- **涉及模块及文件**：`backend/`（API、服务层）、`frontend/services/*`（全部服务层）、`admin/`（排名洞察、路线节点维护页）、`docker/init/`
- **修改内容**（关键条目）：数据库由 SQLite 切换为 openGauss（架构变更）；路线节点增加坐标、排序与启停配置；管理后台 API；管理后台排名洞察与路线节点维护页面；小程序由本地 Mock 切换为真实后端接口；服务层切换后端真实接口；WebSocket 数据变更广播；路线与点亮接口扩展节点信息；登录页移除昵称输入框；微信名称直登与昵称仅可修改一次；首次引导设置昵称接口；组织选择页采集微信名作为默认用户名；统一事件系统与连续行军机制；数据模型扩展（005 迁移）；管理端驾驶舱与数据大屏页面；小程序页面高级化升级；组织树接口新增直属/含下级人数统计。
- **数据库变更**：`001_schema.sql`（初始）、`002_route_node_config.sql`（坐标/排序/启停）、`003_optional_user_avatar.sql`、`004_nickname_change.sql`（一次性改名）、`005_upgrade.sql`（数据模型扩展 + 事件系统）。**注意 `005` 使用了后来被 `SQL_CONSTRAINTS.md` 禁止的语法**（早于约束文档）。
- **API 变更**：新增 `/api/admin/*` 全套、`/api/ws/updates`、`/api/march/route`（扩展节点信息）、`/api/auth/nickname/initial`。
- **兼容性影响**：**架构级** —— SQLite → openGauss 引入 Oracle 兼容模式差异（`''` 落库为 NULL）与 libpq 版本号解析问题，后者需要 `core/database.py:11-43` 的 `PGDialect._get_server_version_info` monkey-patch 才能启动。SQLite 分支保留（`database.py:45-48` 设 `check_same_thread=False`）供测试使用。
- **测试结果**：三端测试脚本、报告与页面截图；管理端数据同步与 WebSocket 实时刷新验收；数据同步 e2e 测试；自动化测试接入真实后端。
- **部署情况**：**待确认**。
- **未解决的问题**：`backend/test/e2e_full_flow`、`e2e_datasync`、`s3_aggregates` 仍按此阶段（V1）语义编写，**在当前代码下登录会 502**，属已知失效资产。

### 2.3 高级化升级 P0 / P1 / P2

- **日期**：2026-10-01 ~ 2026-10-04
- **需求背景**：依据《高级化功能增强实施计划》（1914 行需求文档，**本地附件，仓库未存档**）分三批增强产品表现力与玩法深度。14 项全部落地，另有 5 项明确不做。
- **涉及模块及文件**：`backend/`、`frontend/`、`admin/`、`docker/init/`
- **修改内容**：
  - **P0**：P0-1 行军轨迹（含设计文档同步与测试证据归档）、P0-2 首页今日行军卡状态分档与连续行军行、P0-3 长征章节系统、P0-4 长征旅程开场动画
  - **P1**：P1-1 实时行军动态、P1-2 同组织同行者、P1-3 组织共同长征目标、P1-4 全员共同长征目标、P1-5 星空长征模式升级、P1-6 我的长征足迹地图、P1-7 我的成就总览与数据画像、P1-8 长征人物志与答题连胜效果
  - **P2**：P2-1 每日寄语与节点纪念票、P2-2 区域氛围与长征完成仪式
  - 配套：小程序聚合接口、管理端驾驶舱/大屏聚合接口、echarts 与 Element Plus 按需引入、排名页分页、组织全名批量查询与驾驶舱计数优化、移除 Mock 时代死代码
- **数据库变更**：`006_persons.sql`（人物志）、`007_daily_quotes.sql`（每日寄语）、`008_route_ceremony.sql`（仪式）。
- **API 变更**：新增 `/api/persons/{person_id}`、`/api/quotes/today`、小程序聚合接口、管理端驾驶舱/大屏聚合接口。
- **兼容性影响**：章节系统 `CHAPTERS` 与全员目标 `GLOBAL_GOAL_STEPS` / `GLOBAL_MILESTONES` **硬编码在 `march_service.py:23-54`**，管理端可视化编辑被列为后续增强（至今**待开发**）。仪式页引入 Canvas 盖 DOM 问题，最终解法为 `ceremony.js:228-240` 导出末帧换 `<image>`。
- **测试结果**：小程序自动化测试脚本扩充；P0-1 测试证据归档。
- **部署情况**：**待确认**。
- **未解决的问题**：`CHAPTERS` / `GLOBAL_*` 硬编码；里程碑仪式相关钩子在 `march_service.py:242` 标记延后。

### 2.4 身份关联与 RBAC（批次 1–6）

- **日期**：2026-10-09（25 个提交）
- **需求背景**：支持「小程序微信身份 ↔ PC 管理后台账号」关联，让企业员工用微信扫码登录管理后台；同时建立菜单码粒度的 RBAC 与操作审计。
- **涉及模块及文件**：`backend/app/api/routes/identity.py`、`backend/app/services/access_service.py`、`audit_service.py`、`admin/src/views/AccessView.vue`、`AuditView.vue`、`LoginView.vue`、`frontend/pages/bind/`、`frontend/pages/account/`、`frontend/services/identity.js`、`docker/init/`
- **修改内容**（按批次时间顺序）：`852013f` 设计文档 → `06b6313` 迁移建表与配置 → `b431e4d` 微信扫码登录与身份关联后端 → `4bf9acd` 管理后台 RBAC 与审计接口 → `54a0de7` 管理后台扫码登录与人员授权/审计页 → `6ed1999` 身份关联小程序侧（扫码确认页与账号绑定页）→ `c688ebb` **批次 6：设计文档同步与全链路回归**。同日追加 `a740973` 组织架构人员明细查看、`587fd5b` 开发模式启用扫码登录与管理账号登录、`9724d9a` 修复管理端账号登录拿到 token 后仍登录失败、`1b02985` 移除误入库的微信密钥、`01f3e05` 真机调试网络失败修复（LAN_IP 改物理网卡地址）。
- **数据库变更**：`010_admin_identity.sql`（`user_identities`、`bind_requests`、`qr_login_sessions`、`admin_menus`、`admin_roles`、`admin_role_menus`、`admin_user_roles`、`audit_logs`，含 9 个基础菜单码）。
- **API 变更**：新增 `/api/auth/qr/info`、`/api/auth/qr/confirm`、`/api/auth/identities`（GET/DELETE）、`/api/admin/roles`（GET/POST）、`/api/admin/roles/{role_id}`（PUT/DELETE）、`/api/admin/users/{user_id}/roles`、`/api/admin/users/{user_id}/roles/{role_id}/enabled`、`/api/admin/audit-logs`。**鉴权链改造**：`core/security.py` 拆出 `create_admin_token`（`typ=super`）与 `create_admin_token_for_user`（`typ=user`）；`api/deps.py:109-147` 增加每请求查库重建权限。
- **兼容性影响**：**关键** —— 改造前签发的**无 `typ` 字段的历史管理员令牌被显式兼容为超管**（`api/deps.py:127-129`），避免存量会话失效。权限**不写入令牌**，因此撤销授权即时生效，12 小时有效期仅作兜底。
- **测试结果**：批次 6 全链路回归；设计文档同步。
- **部署情况**：**待确认**。
- **未解决的问题**：
  - `services/access_service.py:27-39` 的 `ALL_MENU_CODES` 为**死代码**（权限已改为查库，常量未被引用）。
  - `wx_web` 网页授权渠道**半成品**：配置项已留，小程序端无触发路径。
  - `pages/account/account` 已在 `app.json` 注册但**无任何跳转入口**（`2d20dc9` 主动隐藏）。
  - **安全事件**：`1b02985` 移除了误入库的微信密钥，但该密钥**已进入 git 历史**（`865aec4`），须在微信公众平台重置 —— 见项目记忆 `wx-secret-leak-rotation`，**是否已完成重置待确认**。

### 2.5 V1.0 扫码入驻与自动登录

- **日期**：2026-10-11
- **需求背景**：让员工通过扫企业下发的小程序码完成入驻并自动登录，替代手工输入邀请码。
- **涉及模块及文件**：`backend/app/services/wechat_service.py`、`invite_service.py`、`routes/auth.py`、`admin/src/views/InvitesView.vue`、`frontend/pages/launch/launch.js`、`frontend/services/auth.js`、`frontend/services/request.js`
- **修改内容**：`cc66b8b` 改造分析报告 → `7fcd037` 补充确认结果 → `495d845` 差异分析文档 → `67c96b1` 后端扫码入驻登录健壮性与通用入驻小程序码 → `225f99c` 管理后台员工入驻二维码查看与下载 → `01e214a` 小程序启动页自动登录与 401 静默重登 → `76f8387` 测试报告。
- **数据库变更**：无新增表。
- **API 变更**：`/api/auth/invite/verify`（只校验不核销）、`/api/auth/onboard`；管理端新增小程序码获取接口（走 `wxa/getwxacodeunlimit`）。
- **兼容性影响**：**建立了小程序端最核心的鉴权不变量** —— `request.js:129-160` 的 401 → 单飞静默重登 → 精确重试一次链路，以及 `auth.js:14-15` 的 `reloginPending` / `ensurePending` 单飞去重。此后所有页面的鉴权行为都依赖此链路，修改需全量回归。启动页 `launch.js` 承担「启动状态机」职责（`app.js` 无 `onLaunch`）。
- **测试结果**：`76f8387` V1.0 扫码入驻与自动登录测试报告。
- **部署情况**：**待确认**。
- **未解决的问题**：`WXACODE_ENV_VERSION` 代码默认 `trial`（体验版，扫码者须为体验成员），**生产是否已改 `release` 待确认**。

### 2.6 性能优化与代码审查整改

- **日期**：2026-10-11
- **需求背景**：按仓库根 `agents.md` §2「编码质量原则」（可拓展性、拒绝冗余、完成后即优化、大数据量性能保障）对三端做一轮集中整改。
- **涉及模块及文件**：`backend/app/services/*`、`admin/src/**`、`frontend/**`、`docker/init/`
- **修改内容**：`f59892e` 后端热点查询 SQL 聚合化与去 N+1；`b5d6035` 排名洞察服务端分页、筛选与**流式导出**；`30b4458` 管理后台代码审查修复（逻辑/冗余/大数据量性能）；`e70b59f` 小程序代码审查修复（同）；`d6acf7e` 每日寄语按天循环展示与 Excel 批量导入。
- **数据库变更**：`012_perf_indexes.sql`（性能索引）、`013_daily_quote_cycle.sql`（寄语循环）。**`013` 使用了后来被禁止的语法**，且含重算类 UPDATE。
- **API 变更**：排名接口改为服务端分页（`page` + `page_size` → `{total, items}`）；新增 CSV 流式导出端点。
- **兼容性影响**：流式导出引入**全项目唯一的服务层自建 Session 例外**（`admin_service.py:433-438`、`:485`），原因是 `StreamingResponse` 的生成器在路由返回后才执行，此时 `Depends(get_db)` 的 Session 已关闭。此模式不可推广到普通接口。
- **测试结果**：见 `docs/迭代记录.md` 对应条目的验证段。
- **部署情况**：**待确认**。
- **未解决的问题**：`admin/src/views/RouteNodesView.vue` 仍为前端筛选，未做服务端分页（数据量小，可接受）。

### 2.7 安全加固与邀请码准入

- **日期**：2026-10-12
- **需求背景**：收紧准入 —— 只有持有效邀请码入驻过的用户才能使用；答题改为提交后统一反馈以防作弊；隐藏暂未完成的账号绑定入口。
- **涉及模块及文件**：`backend/app/services/invite_service.py`、`quiz_service.py`、`api/deps.py`、`admin/src/views/InvitesView.vue`、`frontend/pages/launch/launch.js`、`frontend/pages/onboard/`、`frontend/pages/org-select/`、`frontend/pages/mine/mine.wxml`、`docker/init/`
- **修改内容**：`2d20dc9` 我的页隐藏「账号与绑定」入口 → `25c954c` 答题改为提交后统一反馈 → `afbcba9` **邀请码准入全链路** → `43898a2` 首次入驻后「我的」页组织回显修复 → `8d63b6f` 根目录一键启动脚本 `start.bat`。
- **数据库变更**：`014_quiz_result_details.sql`（答题结果明细）、`015_invite_admission.sql`（`invite_codes` 表 + `admin_menus` 新增 `invites` 菜单码 + 用户状态列）。
- **API 变更**：`/api/auth/login` 语义收紧为**仅已入驻用户签发令牌**，返回 `status ∈ {active, disabled, unregistered}`；新增邀请码校验/入驻接口；答题接口改为提交后返回判定与解析。
- **兼容性影响**：**用户可见的准入模型变更** —— 老用户若无入驻记录会被判为 `unregistered`。邀请码核销采用**带全部有效性条件的单条 UPDATE 按影响行数判定**，并发下不会超发。`org-select` 引入 `from=onboard` 免登录 pickMode，可选范围锁死在 `rootId` 子树内。
- **测试结果**：邀请码准入 I01–I25、P01–P03 用例；答题反馈 A01–A07 automator 用例。
- **部署情况**：**待确认**。
- **未解决的问题**：`pages/account/account` 成为**已注册但无入口**的页面；`account.js:52-78` 的 `handleUnbind` 防御分支为**死代码路径**（按钮未在 WXML 渲染）。

### 2.8 V2.0 六项需求

- **日期**：2026-10-13（22 个提交）
- **需求背景**：V2.0 交付六项需求 —— ①活动时间控制 ②（见记录）③积分台账重构 ④总积分排名 ⑤所属部门锁定 ⑥每题限时作答。
- **涉及模块及文件**：`backend/app/services/activity_service.py`、`points_service.py`、`org_service.py`、`quiz_service.py`、`rank_service.py`、`api/deps.py`、`admin/src/views/ActivityView.vue`、`admin/src/pages/RankingsView.vue`、`frontend/pages/activity/`、`points/`、`quiz-answer/`、`quiz-result/`、`docker/init/`
- **修改内容**（按提交时间正序）：
  - `ce14a95` **需求一：活动时间控制**（后端）—— 新增 `activity_service`，状态实时计算不落库，`api/deps.py` 增加 `_activity_guard` 工厂与 `require_activity_participation` / `require_activity_view` 两个依赖
  - `2f3f333` **需求三/四：积分台账重构与总积分排名**（后端）—— `points_log` 改为每人每来源每日一行 + `biz_key` 唯一；总积分 = 步行 + 答题；**移除登录/达标/点亮/里程碑积分**；排名统一按总积分（小程序/管理端/CSV 同口径）；新增积分概览/明细/总积分榜与管理端台账核对修复
  - `07d02af` **需求五：所属部门首次确定后锁定**（后端）
  - `78a12ca` **需求六：每题 90 秒限时作答**（后端）—— 逐题开题、只认服务器时间、每题仅一次提交、超时不得分
  - `19b0d73` V2.0 后端综合回归 S20 与设计文档同步
  - `e197a28` V2.0 管理后台：活动设置、排名积分化、组织调整与审计中文化
  - `44eb77b` V2.0 小程序：逐题限时答题、积分排行与明细、荣誉卡、活动状态页、组织锁定
  - `4f349cb` V2.0 交付说明文档
  - 同日追加 `2ea4797` 情报 tab 新增「情报2 · 交卷看解析」答题交互（对比演示）、`ad1d747` 联调环境默认切到已部署远程后端
- **数据库变更**：
  - `016_activity_settings.sql`（`activity_settings` 单行表 + `admin_menus` 新增 `activity` 菜单码）
  - `017_points_ledger.sql`（`points_log` 增 `source_type` / `ref_id` / `biz_key` / `created_at` / `updated_at`，`(user_id, biz_key)` 唯一；**按 `daily_sport` 回填步行积分 `floor(min(步数,20000)/1000)`，按 `quiz_records` 回填答题积分 `min(答对×2,10)`；旧流水标为 `legacy`，保留可追溯但不计入总积分**）
  - `018_quiz_answers.sql`（`quiz_answers` 逐题落库：开题/截止/提交时间、作答内容、判定、超时）
  - **`017` 含回填 UPDATE，使用了后来被禁止的语法，不可重复执行**
- **API 变更**：
  - 新增 `GET /api/activity/status`（`allowParticipate` / `allowView` / 状态文案）
  - **准入拒绝统一为 403 + `X-Activity-Status` 响应头**（`unpublished` / `not_started` / `ended`）
  - 答题接口改为逐题开题模式，下发**不含 `answer` / `analysis`**
  - 排名接口口径由步数改为总积分，返回 `walk_points` / `quiz_points` 分项
  - 新增积分概览 / 明细 / 总积分榜接口
  - `rules` 下发计分参数
- **兼容性影响**：**本项目影响面最大的一次变更**。
  - 积分语义整体重定义，存量 `points_log` 行标 `legacy` 保留但不计分 → **用户可见的积分数值发生变化**
  - 排名口径变化 → 名次全面重排
  - 答题从「一次下发整套」改为「逐题开题」→ 前端交互重写
  - 活动准入是**新增的全局闸门**，所有产生业务数据的接口都挂上 `require_activity_participation`
  - `017` 的回填是**一次性数据迁移**，重跑会产生错误结果
- **测试结果**：`19b0d73` S20 综合回归；SQLite 冒烟 20/20（999 / 1000 / 1999 / 20000 / 25000 步边界、增量不重复计分、重复同步幂等、重同步取最大值与往日校正、答题积分及重复提交、排名顺序、档案与管理端及 CSV 一致、篡改后核对能发现并修复、legacy 不计入）；积分 P01–P08 边界用例。
- **部署情况**：`4f349cb` 产出《长征步迹V2.0_交付说明》。**该文档未记录生产 openGauss 版本与端口**（曾被误引，实际无此陈述）。实际部署时间与结果**待确认**。
- **未解决的问题**：
  - `017` 回填口径 `min(步数,20000)` 在两天后被 `9cb65b8` 废弃（见 §2.10），**存量回填数据依赖启动时的 `recompute_walk_all(fix=True)` 自动上调**
  - V2.0 交付说明中的部分描述滞后于后续修正

### 2.9 生产化与联调地址收敛

- **日期**：2026-10-13 ~ 2026-10-16
- **需求背景**：把开发/联调/生产三套环境地址收敛，建立可重复的发布打包流程。
- **涉及模块及文件**：`frontend/services/config.js`、`admin/.env.development`、`admin/.env.prod`、`admin/vite.config.ts`、`admin/scripts/zip-dist.mjs`、`backend/.env.prod`、`backend/app/core/config.py`、`build-backend.bat`、`.gitignore`
- **修改内容**：
  - `ad1d747`（10-13）联调环境默认切到已部署远程后端 `120.25.171.125:8010`
  - `1e2d53b`（10-14 14:52）联调后端地址由 IP 改为域名 `swkjdj.sz-watech.com:8010`
  - `527db98`（10-14 16:26）联调后端地址改为 **HTTPS 域名（去掉 8010 端口）**
  - `79cf738`（10-14 15:10）管理后台新增打包脚本：build 后自动生成 `dist.zip`
  - `a60b94b`（10-14 16:54）小程序网络异常时透出详细原因（含微信原始 `errMsg`）
  - `a0ca154`（10-16 09:50）新增后端发布打包脚本 `build-backend.bat` 并忽略发布产物
  - `f05531a`（10-16 10:10）新增生产配置 `.env.prod` 并支持 `APP_ENV` 切换加载
  - `f413ac6` / `51239b5`（10-16）见 §2.11
  - `6cdd80a`（10-16 15:11）`build-backend.bat` 打包排除 `backend/test` 目录
  - `761d860`（10-16 20:35）admin 拆分本地/生产双环境文件
- **数据库变更**：无。
- **API 变更**：无。
- **兼容性影响**：
  - **后端地址在 4 天内改了 4 次**（IP:8010 → 域名:8010 → HTTPS 域名 → 远程后端），任何硬编码地址的脚本/文档都可能失效
  - `APP_ENV` **只从系统环境变量读取**（`config.py:12-15`，因为 env 文件选择发生在解析 `.env` 之前，写进 `.env` 不生效）—— 这是一个容易踩的坑
  - `backend/.env` 与 `backend/.env.prod` **经用户决定入库**（`.gitignore` 有 `!backend/.env` 显式放行），意味着其中的密钥已进入 git 历史
  - `a60b94b` 把微信原始 `errMsg` 追加进用户可见提示，理由是「真机看不到 console，必须把错误带到界面上」—— **注意提示文案可能包含技术细节**
  - 三个发布产物 `backend-update.tar.gz` / `sql.tar.gz` / `admin/dist.zip` 均 gitignore
  - `admin/scripts/zip-dist.mjs` 为**零依赖手写 Zip 构建器**（`zlib.deflateRawSync` + 自实现 CRC-32 + MS-DOS 时间戳），避免引入额外 npm 依赖
- **测试结果**：无专项测试报告；`6cdd80a` 的动机是发布包不应包含测试脚本。
- **部署情况**：域名 `swkjdj.sz-watech.com` 已在 HTTPS 443 上线，nginx 反代 `/api` → `127.0.0.1:8010`；小程序 request 合法域名已配置。**nginx 配置文件不在本仓库**；后端进程管理方式**待确认**。
- **未解决的问题**：
  - **wss 在 443 不可用**：客户端关闭码 1006，`curl` 带 `Upgrade` 头直连返回 FastAPI 404 → nginx 未转发 `Upgrade` / `Connection` 且默认 `proxy_http_version 1.0`。修复需三行 `proxy_http_version 1.1;` + `proxy_set_header Upgrade $http_upgrade;` + `proxy_set_header Connection "upgrade";`，**尚未实施**
  - **微信公众平台未配置 socket 合法域名**，即使 nginx 修好，体验版/正式版仍会被拦截
  - `backend/.env*` 入库导致的密钥历史暴露

### 2.10 计分规则连续修正（10-15 四连击）

- **日期**：2026-10-15（24 个提交，单日峰值）
- **需求背景**：V2.0 上线后用户对比「我的」页累计运动(步)与步行积分，发现两个数字口径不一致，疑为数据错误。排查后确认是「每日各自取整」与「每日封顶 20000」两层旧口径叠加导致，需要连续修正。
- **涉及模块及文件**：`backend/app/services/points_service.py`、`sport_service.py`、`routes/profile.py`、`frontend/pages/points/`、`frontend/pages/mine/`、`frontend/services/sport.js`、`backend/test/s20_*`、`v2-miniprogram` 测试、`docker/init/019`、`020`
- **修改内容**（时间正序，构成一条完整的修正链）：
  1. `6f2cfc3`（12:19）**近 7 日微信运动补录、步数结余积分与用户独立题目轮换** —— 微信运动按北京时间处理近 7 个自然日，缺失日期不写 0/不覆盖并返回待重试明细；历史步数可幂等校正；步行积分按每日最多 20000 计分步数顺序累计，不足 1000 步结余到下一条；每日答题按用户逐题使用次数优先抽取最少使用层
  2. `9c8f13f`（12:46）**今日行军目标由 1 万步调整为 2 万步**；5000 步门槛文案明确为「连续行军目标」
  3. `aa7dd82`（14:08）**前端服务层强制今日目标为 20000 步** —— 线上旧后端 `GET /sport/today` 仍返回 `target=10000`，首页 `refreshAll` 会覆盖初始值，故在 `services/sport.js` 的 `getToday()` 服务边界统一覆盖
  4. `4afccdd`（14:44）**步行积分统一为累计步数口径** —— 启动时按运动记录修复步行积分为累计口径，修正跨日零碎步数少计分
  5. `83d3552`（17:25）**步数同步后按运动源数据全量重算步行积分台账** —— 新增 `recompute_walk_all`（分批 500 用户、幂等覆盖）与 `recompute_all`，`main.py` 启动时在连续行军修复后执行
  6. `85c5a55`（17:38）**我的页累计运动(步)改计分口径展示** —— 新增 `scoredTotalSteps`（各日 `min(步数,20000)` 求和），「我的」页改用它
  7. `9cb65b8`（18:03）**步行积分取消单日 20000 封顶，改为累计步数 ÷ 1000 计分** —— 删除 `capped_steps` / `scored_total_steps` 与 `POINTS_WALK_STEP_CAP` 配置，`rules` 不再下发 `walkStepCap` / `walkDailyCap`，`profile/summary` 仅保留原始 `totalSteps`
  - 同日另有 UI/缺陷修复：`50aef7d` tabBar 图标 + 星空地图分层闪烁、`9c84954` 节点状态徽章虚高不居中、`72d4894` 步数重新同步兼容旧版响应报错、`b5aa5d2` 行军日历详情弹层长文本换行掉行、`6913b00` 节点详情路线位置缺少点位导致蓝屏
- **数据库变更**：`019_sport_backfill_carry.sql`（运动数据回填与结余）、`020_question_rotation.sql`（题目轮换，含题目使用次数统计）。**两者均使用了后来被禁止的语法，且含重算类 UPDATE，不可重复执行。**
- **API 变更**：
  - `GET /api/sport/today` 的 `target` 由 10000 改为 **20000**
  - `profile/summary` 的 stats 先增 `scoredTotalSteps`（`85c5a55`）**后又移除**（`9cb65b8`），最终仅保留 `totalSteps`
  - `rules` 移除 `walkStepCap` / `walkDailyCap`
- **兼容性影响**：**极高，且是同日内的反复变更**。
  - `85c5a55` 与 `9cb65b8` 相隔 25 分钟，前者引入的 `scoredTotalSteps` 字段在后者中被删除 —— **任何依赖该字段的代码都会失效**
  - 步行积分数值**整体上调**（取消封顶后，高步数用户积分增加）
  - **存量数据依赖启动时的 `recompute_walk_all(fix=True)` 自动修复**：部署后首次启动会把存量用户步行台账按新口径上调，这是一次**隐式的全量数据变更**
  - 前端 `DAILY_TARGET` 服务边界覆盖是对「线上旧后端」的兼容垫片，后端部署到位后理论上可移除（**当前仍保留**）
- **测试结果**：SQLite TestClient 冒烟 —— 单日 +25000 步后 `totalSteps=25000 / scoredTotalSteps=20000 / walk=20`，再 +1500 步 `scoredTotalSteps` 恒 20000（封顶生效）（**该断言在 `9cb65b8` 后已失效并更新为 25000 步 → 25 分**）；s20 边界用例更新；v2-miniprogram 规则断言同步更新；S22 专项回归 14/14、首页状态分档断言 5/5；`node --check` 与 `py_compile` 通过。
- **部署情况**：**待确认**。`docs/迭代记录.md` 的 `9cb65b8`、`85c5a55` 条目均明确「微信开发者工具机型验收需远程后端部署后执行（前端默认连已部署远程，未部署前该字段为旧接口缺失值）」。
- **未解决的问题**：
  - `frontend/services/sport.js` 的 `DAILY_TARGET = 20000` 强制覆盖是否仍需保留（后端已下发 20000）
  - 一天内四次修正说明计分口径**缺乏单一权威定义**，`REQUIREMENTS.md` §4 即为补齐此缺口而写

### 2.11 openGauss 兼容事故与更正

- **日期**：2026-10-13（复盘）、2026-10-16（事故与更正）
- **需求背景**：生产启动失败，排查 openGauss 与 PostgreSQL 的语法/行为差异。
- **涉及模块及文件**：`backend/app/data/seed.py`（题库 seed count 查询，`f413ac6` 改、`51239b5` 回退）、`backend/app/core/config.py`、`backend/app/core/database.py`、`backend/.env.example`（以上三者为 `fc2597e`）、`docker/init/SQL_CONSTRAINTS.md`（`1bfa90f`）、`backend/test/s21_opengauss_compat.py`（`fc2597e` 新增）
- **修改内容**：
  - `fc2597e`（10-13 18:40）**openGauss 兼容性复盘与本地代码同步整改**（审计 + 低风险修复）
  - `f413ac6`（10-16 14:30）修复 openGauss 下题库 seed count **派生表别名**导致后端启动失败
  - `51239b5`（10-16 16:15）**回退 `f413ac6` 的 count 改写（误诊），真正根因为服务器缺 `020` 迁移**
  - `1bfa90f`（10-17 00:17）新增 SQL 迁移编写约束文档 `docker/init/SQL_CONSTRAINTS.md`
- **数据库变更**：无新增迁移；`51239b5` 回退了 `f413ac6` 的代码改写。**根因是生产库缺 `020_question_rotation.sql`**。
- **API 变更**：无。
- **兼容性影响**：
  - **一次误诊**：`f413ac6` 把启动失败归因于 openGauss 派生表别名语法，实际是生产库未执行 `020` 迁移。`51239b5` 回退并更正。
  - 由此暴露出**生产库与 `docker/init` 的迁移缺口**问题，直接促成 `1bfa90f` 的 `SQL_CONSTRAINTS.md`（现为写迁移前必读的权威文档）
  - `SQL_CONSTRAINTS.md` 明确记录了两起历史事故与 §1.4 派生表别名规则
  - `s21_opengauss_compat.py` 成为 openGauss 兼容性的回归防线：C01–C04 四项，其中 **C03（`:56-60`）校验 ORM 与 SQL 表覆盖一致性（34/34）**
- **测试结果**：`s21_opengauss_compat.py` C01–C04；`43cba05`（10-17 00:15）重跑并更新 S11/S12/S17–S24 场景测试报告。
- **部署情况**：**待确认**（生产库补跑 `020` 的时间无仓库内证据）。
- **未解决的问题**：
  - **生产库迁移缺口是反复出现的问题**（已发生两次）。`docker/init/021`、`022` 当前**同样处于「本地已应用、生产缺失」状态**
  - `005`、`013`、`015`、`017`、`019`、`020` 六个迁移仍含被禁语法，**不可重跑**；若需在全新库上初始化，需按 `SQL_CONSTRAINTS.md` 重写或验证

### 2.12 AI 出题（题库接入 CloudBase Agent）

- **日期**：2026-10-16 23:19
- **需求背景**：题库人工出题效率低，接入腾讯云 CloudBase Agent 自动生成题目，人工审核后入库。
- **涉及模块及文件**：`backend/app/services/cloudbase_service.py`、`ai_question_service.py`（或同类）、`routes/ai_admin.py`、`admin/src/components/AiGenerateDialog.vue`、`admin/src/api/*`
- **修改内容**：`ea58b6c` 题库接入 CloudBase Agent AI 出题，**草稿审核后入库**。
- **数据库变更**：`ai_generation_jobs`、`ai_generated_questions`（**属 `021_ai_center.sql`，本阶段可能先用临时结构，待确认**）。
- **API 变更**：新增 AI 出题相关管理端接口（生成、查询草稿、批量保存）。
- **兼容性影响**：
  - 引入 **httpx 同步流式** 调用与 **ACP 协议（JSON-RPC 2.0 `session/prompt` + SSE）**，是项目首个外部 AI 依赖
  - 生成策略：**总量拆成多批并发调用，规避单次长回复被截断**（`AI_QUESTION_BATCH_SIZE=10`、`AI_QUESTION_MAX_CONCURRENCY=3`、`AI_QUESTION_MAX_COUNT=100`）
  - 前端 `AiGenerateDialog.vue` 的行内校验 `validateItem`（`:86-104`）**必须与后端 `_validate_question` 保持同步**，否则会出现「前端通过、后端拒绝」
  - 批量保存返回的 `failures.index` 为 **1 基**
  - `CLOUDBASE_API_KEY` **仅供后端调用，禁止写入前端代码、接口响应或日志**（`config.py:67` 注释）
- **测试结果**：见 `docs/迭代记录.md` 对应条目。
- **部署情况**：**待确认**。
- **未解决的问题**：`CLOUDBASE_TIMEOUT_SECONDS = 180` 与前端 axios `timeout = 15000`（`admin/src/api/request.ts:14-17`）存在量级差异，长生成任务需依赖异步 job 而非同步等待 —— **实际实现方式待确认**。

### 2.13 AI 智能中心 V1.0 Phase A

- **日期**：2026-10-17
- **需求背景**：《长征步迹 AI 智能中心开发需求 V1.0》按 §13 分阶段执行，Phase A = 后端全做 + 小程序聊天页；usage/cost 与管理后台 Vue 页明确延后。
- **涉及模块及文件**：
  - 后端：`routes/ai.py`、`routes/ai_admin.py`、6 个 AI 服务（`cloudbase_service.py`、`ai_chat_service.py`、`ai_config_service.py`、`ai_knowledge_service.py`、`ai_question_service.py`、`ai_usage_service.py` 等）、`core/config.py:66-91`
  - 小程序：`pages/ai-chat/`、`services/ai.js`、`app.json`（tabBar 换防）
  - 数据库：`docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql`
  - 测试：`backend/test/s26_*`、`backend/test/docs/s26-ai-center-report.md`、`frontend/test/docs/ai-chat-page-report.md`、`ai-tab-swap-report.md`
- **修改内容**：
  - `37f3e40`（00:22）新增腾讯云 CloudBase Agent 配置项（工程）
  - `1600074`（11:06）**AI 智能中心 Phase A 后端** —— `/api/ai/*` 与 `/api/admin/ai/*`、6 个服务、021/022 迁移
  - `0052108`（11:06）**小程序新增 AI 历史助手聊天页，底部「情报」tab 替换为「AI 问答」**
  - `1fbacac`（11:26）VPN 关闭后重跑 AI 智能中心真实链路（测试）
- **数据库变更**：
  - `021_ai_center.sql`：6 张表 `ai_knowledge`、`ai_conversations`、`ai_messages`、`ai_generation_jobs`、`ai_generated_questions`、`ai_usage_logs`
  - `022_ai_admin_menus.sql`：`admin_menus` 新增 **5 个 AI 菜单码**（知识库 / 配置 / 题目工坊 / 运行概览 / 调用记录）
  - ⚠ **两个文件已在本地 openGauss 应用并登记 `schema_migrations`，但按仓库根 `agents.md` §1.3「`docker/` 不自动提交」规则未入库**（`git status` 显示为 `??` 未跟踪）
- **API 变更**：
  - 新增小程序侧 `/api/ai/chat`（`POST`）、`/api/ai/route-guide/{node_id}`（`GET`）、`/api/ai/quiz-explanation/{question_id}`（`GET`）、`/api/ai/conversations`（`GET`）、`/api/ai/conversations/{conversation_id}`（`DELETE`）
  - 新增管理端 `/api/admin/ai/*` 全套（知识库 CRUD、配置读写、题目工坊、调用记录）
  - AI 运行时参数支持 **DB 覆盖 > env 默认**，由 `ai_config_service.get_effective(db)` 合并写入 `system_settings`
- **兼容性影响**：
  - **tabBar 结构变更**：第 3 个 tab 由 `quiz`（情报）换为 `ai-chat`（AI 问答）。quiz **降级为子页**，由首页情报卡进入。`frontend/images/tabbar/quiz.png` / `quiz-active.png` 成为**未引用的遗留资源**
  - `pages/ai-chat` 是 tab 页 → **常驻实例**，因此实现了全项目唯一一处显式的跨账号数据清理（`ai-chat.js:44-55` 比较 `_uid`）
  - AI 问答是**全项目唯一使用 60 秒超时的接口**（其余默认 10 秒）
  - 多轮对话为**无状态实现**（历史拼接进单个 prompt，`cloudbase_service.py:7-8`、`:206`），服务端不维护上下文
  - `AI_ENABLED = false` 时所有 AI 接口返回明确提示，**不影响其它业务**（可安全降级）
  - 全站调用上限 `AI_GLOBAL_DAILY_LIMIT = 2000` 用于**防成本失控**
  - **生产库缺 021/022** → 部署此后端版本会因 `UndefinedTable` 启动失败或运行时报错
- **测试结果**：
  - `s26` 冒烟 **47/47 通过（含真实 Agent 调用）**
  - `1fbacac` VPN 关闭后重跑真实链路
  - 报告：`backend/test/docs/s26-ai-center-report.md`、`frontend/test/docs/ai-chat-page-report.md`、`frontend/test/docs/ai-tab-swap-report.md`
- **部署情况**：**待确认**。**部署前必须按 `opengauss-migration-gap` 流程补跑 021/022**。
- **未解决的问题**（Phase A 明确延后，勿当作已完成）：
  1. 管理后台 5 个 AI 子页面（`admin/src/router/menus.ts` 未登记菜单码）。**口径更正（2026-10-17）**：原写「接口已就绪」，实测只有知识库/配置/题目工坊 3 个页面有后端接口（`routes/ai_admin.py` 15 个端点，守卫 `ai_knowledge`/`ai_config`/`ai_workshop`）；运行概览（`ai_overview`）与调用记录（`ai_logs`）**后端接口亦未实现**——这两个菜单码在 `backend/app/api/` 下零命中，`AiUsageLog` 在 api 层零引用
  2. `node-detail` AI 讲解面板（`GET /api/ai/route-guide/{node_id}` 已就绪）
  3. 答题页「AI 讲解」按钮（`GET /api/ai/quiz-explanation/{question_id}` 已就绪）
  4. usage / cost 统计页（`ai_usage_logs` 表已建、写入侧 `ai_usage_service.py` 已实现，**读取侧接口未实现**）
  5. 小程序真机真实 Agent 全链路（本机 DNS 劫持限制，需 dns_shim 或真机网络）
  6. AI 知识库检索为**关键词匹配**，非向量检索（召回质量有限）
  7. `admin_menus.sort_order` 因 `022` 新增而产生**重复值**：`invites`=10 与 `ai_overview`=10、`activity`=11 与 `ai_knowledge`=11，菜单排序不稳定

---

## 3. 数据库迁移全量清单（001 → 022）

| 编号 | 文件 | 引入阶段 | 主要内容 | 重跑风险 |
|---|---|---|---|---|
| 001 | `001_schema.sql` | 初始化 | 初始 schema | — |
| 002 | `002_route_node_config.sql` | 真实后端接入 | 路线节点坐标、排序、启停 | — |
| 003 | `003_optional_user_avatar.sql` | 真实后端接入 | 头像列可空 | — |
| 004 | `004_nickname_change.sql` | 真实后端接入 | 一次性改名 | — |
| 005 | `005_upgrade.sql` | 真实后端接入 | 数据模型扩展 + 事件系统 | ⚠ **含被禁语法** |
| 006 | `006_persons.sql` | P1-8 | 长征人物志 | — |
| 007 | `007_daily_quotes.sql` | P2-1 | 每日寄语 | — |
| 008 | `008_route_ceremony.sql` | P2-2 | 完成仪式 | — |
| 009 | `009_org_serial.sql` | 高级化 | 组织序列修复 | — |
| 010 | `010_admin_identity.sql` | 身份/RBAC | 身份关联 + RBAC + 审计（8 张表，9 个菜单码） | — |
| 011 | `011_import_previews.sql` | 性能/导入 | Excel 导入预览表 | — |
| 012 | `012_perf_indexes.sql` | 性能优化 | 性能索引 | ⚠ `CREATE INDEX IF NOT EXISTS` 需谨慎 |
| 013 | `013_daily_quote_cycle.sql` | 性能优化 | 寄语按天循环 | ⚠ **含被禁语法 + 重算 UPDATE** |
| 014 | `014_quiz_result_details.sql` | 安全加固 | 答题结果明细 | — |
| 015 | `015_invite_admission.sql` | 安全加固 | 邀请码准入 + `invites` 菜单码 | ⚠ **含被禁语法** |
| 016 | `016_activity_settings.sql` | V2.0 需求一 | 活动设置表 + `activity` 菜单码 | — |
| 017 | `017_points_ledger.sql` | V2.0 需求三/四 | 积分台账重构 + **一次性回填** | ⚠⚠ **含被禁语法 + 回填 UPDATE，绝不可重跑** |
| 018 | `018_quiz_answers.sql` | V2.0 需求六 | 逐题作答明细 | — |
| 019 | `019_sport_backfill_carry.sql` | 计分修正 | 运动数据回填与结余 | ⚠⚠ **含被禁语法 + 重算 UPDATE，绝不可重跑** |
| 020 | `020_question_rotation.sql` | 计分修正 | 题目轮换与使用次数 | ⚠ **含被禁语法**；**生产曾缺失此迁移导致启动失败** |
| 021 | `021_ai_center.sql` | AI Phase A | 6 张 AI 表 | 🔴 **未提交入库，生产缺失** |
| 022 | `022_ai_admin_menus.sql` | AI Phase A | 5 个 AI 菜单码 | 🔴 **未提交入库，生产缺失**；引入 `sort_order` 重复 |

执行机制与编写约束见 `.qoder/ARCHITECTURE.md` §12.4 与 `docker/init/SQL_CONSTRAINTS.md`（**权威，写迁移前必读**）。

---

## 4. 反复变更热点（工程信号）

以下区域在短期内被反复修改，说明其口径或环境存在结构性问题，后续改动应格外谨慎：

| 热点 | 次数与时间 | 信号 |
|---|---|---|
| **步行积分口径** | 4 次连续修正（10-15 一天内）：`4afccdd` → `83d3552` → `85c5a55` → `9cb65b8` | 计分规则缺乏单一权威定义；`REQUIREMENTS.md` §4 为补齐此缺口而写 |
| **今日目标步数** | 2 次调整（10-15）：`9c8f13f` 改 20000、`aa7dd82` 前端强制覆盖 | 前后端下发值不一致，前端加了兼容垫片 |
| **后端联调地址** | 4 次变更（10-13 ~ 10-14）：IP:8010 → 域名:8010 → HTTPS 域名 → 远程后端 | 环境配置未集中管理，硬编码地址易失效 |
| **openGauss 兼容** | 3 轮（10-13 复盘、10-16 事故+更正、10-17 约束文档） | 生产库与 `docker/init` 存在迁移缺口；曾发生一次误诊（`f413ac6` → `51239b5`） |
| **生产迁移缺口** | 2 次已发生（`020` 缺失、`021/022` 未入库） | `docker/` 不自动提交的规则与部署流程之间缺乏衔接机制 |

---

## 5. 变更记录模板（新增条目直接复制）

```markdown
### 2.x <阶段/需求名称>

- **日期**：YYYY-MM-DD（跨多日写区间）
- **需求背景**：为什么要做这件事（业务动因、缺陷现象、外部约束）
- **涉及模块及文件**：backend / frontend / admin / docker，列到关键文件路径
- **修改内容**：按提交时间正序列出，每条前缀提交号 `xxxxxxx`
- **数据库变更**：新增/修改的迁移编号与表列；是否含数据回填；**是否可重跑**
- **API 变更**：新增/修改/删除的端点，请求与响应字段变化，状态码与响应头变化
- **兼容性影响**：对存量数据、存量令牌、已发布前端、线上后端的影响；是否需要数据迁移或强制刷新
- **测试结果**：测试脚本编号与通过情况；测试报告路径
- **部署情况**：已部署 / 待部署 / **待确认**（仓库内无证据时一律写待确认）
- **未解决的问题**：本次遗留的缺陷、待开发项、待确认项
```

**维护要求**（`.qoder/README.md` §3 规则 5、7、8）：

- 跨模块变更 → 更新相关文件的 `.qoder/**.md` 文档 + 本文档 + 根 `CHANGELOG`（本文档）
- 数据库变更 → 必须记录表结构变化、迁移方式、兼容性影响，并更新 §3 迁移清单
- 缺陷修复 → 必须记录原因、修复方式、回归测试结果
- **不得覆盖、删除或随意改写已有条目**；发现历史条目有误时**追加更正说明**，保留原文（参照 `51239b5` 对 `f413ac6` 的更正方式）
- 同时按仓库根 `agents.md` §1.8 在 `docs/迭代记录.md` 追加提交级记录（**两者不可互相替代**）
