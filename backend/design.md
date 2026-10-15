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
| 安全 | `app/core/security.py` | `create_token`/`decode_token`（PyJWT HS256，`sub`=user_id）；`create_admin_token`（`typ=super`，`sub`=username）/`create_admin_token_for_user`（`typ=user`，`sub`=user_id） |
| 工具 | `app/core/helpers.py`、`app/core/wx.py` | 日期字符串、按「日期+用户」生成稳定模拟步数；微信 code2Session 与 wx.getWeRunData 加密数据 AES 解密（watermark 校验） |
| 鉴权依赖 | `app/api/deps.py` | `get_current_user`：Bearer Token 缺失/无效/用户不存在统一 401；`get_current_admin` 解析管理员令牌并**每请求查库**校验 RBAC（撤销/禁用即时生效）；`require_menu(code)` 菜单码依赖（超管全放行，角色缺菜单 403） |
| 实时推送 | `app/api/routes/ws.py` | `/api/ws/updates` WebSocket 长连接；数据变更广播 `data_changed`，用户事件广播 `activity` |
| 种子 | `app/data/seed.py` | 幂等写入：路线节点 10（含历史事件卡内容）、题库 15（含分类）、勋章 12（分类/隐藏/排序）、组织树、后台菜单 9 项与内置角色（超管/运营） |
| 业务 | `app/services/*.py` | 见 §2.3 |
| 契约 | `app/schemas/schemas.py` | 请求/响应模型；小程序侧继承 `CamelModel`（to_camel 输出 camelCase），管理端 Admin* 模型为原生 snake_case |

### 2.3 服务层与前端 Mock 的对应关系

| 后端 service | 前端 services/*.js | 核心职责 |
| --- | --- | --- |
| `auth_service` | `auth.js` | `wx_login`：code→微信 code2Session→openid→建/查用户→签发 JWT；凭证为空时 mock openid，已配置凭证时微信换取失败抛 `WxLoginError`（不回退 mock，`WX_LOGIN_ALLOW_MOCK` 仅本地测试例外）；并发首登撞 openid 唯一约束回滚复用；`update_nickname`：昵称仅可修改一次 |
| `sport_service` | `sport.js` | 今日步数查询/同步（同日覆盖）、最近 n 天记录、手动补步、行军日历聚合（按月） |
| `march_service` | `march.js` | 路线进度（节点状态 completed/current/unlocked）、节点详情（含历史事件卡 7 字段、经纬度 + persons 关联人物）、按累计步数点亮；`_route_state` 为节点状态/进度计算共用内核（个人路线与组织路线复用）；`get_global_goal` 全员共同长征目标（全员累计步数对 GLOBAL_GOAL_STEPS/GLOBAL_MILESTONES 配置，里程碑实时计算）；`get_footprints` 我的长征足迹（lit_nodes 点亮日期/快照 + daily_sport 当日步数，无冗余存储）；`mark_ceremony_seen` 长征完成仪式标记（§20.4，幂等写入 users.route_ceremony_at） |
| `quiz_service` | `quiz.js` | 按用户个人历史分层轮换抽题（同日固定于 `daily_questions`，最多 5 道）、逐题 90 秒服务器计时作答、记录/重置/知识画像 |
| `points_service` | — | V2.0 积分台账：总积分 = 步行 + 答题；`set_daily` 按「用户 + biz_key（walk/quiz:日期）」行锁覆盖，业务事务内按源数据重算（幂等）；`get_summary` / `get_daily_details` 概览与按日明细；`points_subquery` 供排名复用；`recompute_all` 按源数据分批核对/修复 |
| `activity_service` | — | 活动时间窗口：按服务器时间实时计算 unpublished/not_started/ongoing/ended，`check` 供 `require_activity_participation` / `require_activity_view` 守卫；管理端保存/发布/撤回写审计 |
| `medal_service` | `medal.js` | 12 枚勋章的判定与发放（`check_and_grant` 返回新获列表），含连续行军/步数里程碑/隐藏勋章 |
| `org_service` | `org.js` | 组织树逐级下钻、用户组织查询/选定（任意层级）；`get_companions` 同组织同行者（子树口径人数/今日总步数/同行者列表，隐私只下发昵称/头像/步数）；`get_org_march` 组织共同长征目标（子树成员累计步数映射组织路线，复用 `march_service._route_state` 现算无持久点亮） |
| `rank_service` | `rank.js` | 全员工总积分榜（跨组织；总积分降序 → 累计步数降序 → user_id 升序）；名次由库内窗口函数 `row_number()` 计算，`get_points_rank` 返回前 10 名 + 第 11 名起分页 + 本人，`ranked_users_subquery` 供管理端排名与导出复用（两端同口径） |
| `event_service` | —（足迹时间轴/实时动态数据源） | 统一事件系统：`record` 写 `user_event` 并向 WS 广播 `activity`；`build_text` 生成与小程序足迹同源的中文文案；`list_public_activities` 提供小程序实时动态（脱敏由 `ACTIVITY_MASK_NICKNAME` 控制，`mask_nickname` 实现）；事件类型如 FIRST_STEP/DAILY_GOAL/STREAK_*/NODE_LIT/MEDAL_GRANTED/QUIZ_DONE 等 |
| `streak_service` | —（内嵌于 sport 写入链） | 连续行军：写入侧 `on_sport_upsert` 在当日首次达标时维护 `users.continuous_days/max_continuous_days` 并写 DAILY_GOAL/STREAK_* 事件；读取侧 `compute_streaks` 以 `daily_sport.is_goal_completed` 重算（纯函数 `streaks_of` / `longest_run` 按自然日连续计算，缺记录的日期视为中断；勋章判定复用同一套函数）；启动兜底 `recompute_all` 流式分组计算、只批量回写变化用户 |
| `person_service` | `person.js` | 长征人物志（需求 §14）：`get_persons_by_node` 节点反查人物（节点详情 → 人物）；`get_person_detail` 人物详情（简介 + 关联节点即历史事件/历史时间，人物详情 → 节点） |
| `quote_service` | `quote.js` | 每日寄语（需求 §16、V1.1 按天循环）：`get_today` 取启用寄语按 (sort_order, id) 升序的第 `(今天−起始日期).days % N` 条（起始日在未来取第 1 条，无启用寄语返回 null），`get_cycle_info` 供管理端展示起始日期/启用条数/今日序号；管理端分页列表（节点名批量查询）与 CRUD、字段长度/排序号范围/节点存在性校验（`check_fields` 与 Excel 导入共用） |
| `setting_service` | — | 系统键值配置（`system_settings`）读写：`get_value` / `set_value`（upsert，调用方提交），当前承载寄语循环起始日期 `quote_cycle_start` |
| `import_service` | —（管理端） | Excel 批量导入通用框架（表头校验、≤2MB/≤500 行、公式注入拦截、预览令牌暂存 `import_previews`、条件更新抢占防重复确认、整批事务写入）；题库与每日寄语各自提供模板/逐行解析/确认写入 |
| `profile_service` | `profile.js` | 个人档案聚合（用户/连续行军/勋章/长征进度/足迹时间轴/五维数据画像 _portrait：行军/坚持/知识/路线/成就，仅数据不评价 §17） |
| `broadcast_service` | `broadcast.js` | 今日长征播报（全局运动汇总 + 今日长征彩蛋 + 个人当日状态）；今日人数/总步数/击败人数单条 SQL 聚合 |
| `dashboard_service` | —（管理端） | 驾驶舱指标、路线总览、运动趋势、实时动态、数据大屏聚合（整体口径，无组织维度） |
| `admin_service` | —（管理端） | 管理员登录、路线节点/题库/组织架构 CRUD、全员排名、人员详情聚合（每日寄语 CRUD 在 `quote_service`） |
| `identity_service` | `identity.js` | 微信身份关联：PC 扫码登录会话（创建/轮询/置 scanned/确认/取消/令牌单次签发）、B 场景绑定确认事务（unionid 冲突禁止自动合并）、身份列表与解绑（wx_mini 主身份禁解绑）、登录同步采集 unionid 身份行 |
| `access_service` | —（管理端） | RBAC：`build_principal` 聚合用户启用角色与菜单（超管=全部菜单）、`get_enabled_roles`、`get_menu_items`、菜单/角色 CRUD 与授权校验 |
| `audit_service` | —（管理端） | 审计日志：`record` 写 `audit_logs`（区分 super/user 操作人），分页/日期/动作/操作人筛选 |
| `wechat_service` | — | 微信服务端对接：`get_wxacode_png`（小程序码）、code2Session 开放平台 code 换取（未配置凭证时 mock） |

## 3. 核心数据模型（SQLAlchemy ORM）

### 3.1 静态配置表（启动时由 seed 幂等写入）

| 表 | 关键字段 | 约束/说明 |
| --- | --- | --- |
| `route_nodes` | id, name, target_steps(累计步数要求), historical_time, icon, description, latitude(9,6), longitude(10,6), sort_order, is_enabled(默认true), brief, significance, figures, location, images(JSON), audio, keywords | 10 行；id 从 1 起；启用节点按 `sort_order, id` 排序后 target_steps 严格递增；停用节点不影响小程序可见路线但 lit_nodes/勋章记录保留；brief/significance/figures/location/images/audio/keywords 为历史事件卡内容字段（005） |
| `questions` | id, type, question, options/answer(JSON), analysis, score, category, active | `active=false` 为软停用，不参与新抽题但保留既有任务引用；answer 不在作答接口预先下发 |
| `medal_defs` | id(str 主键), name, icon, desc, category(starter/route/challenge/complete), hidden, sort_order | 12 行：first-step/learner/persistence/luding/snow/day-10k/steps-100k/steps-500k/streak-30/master/fearless(隐藏)/victory；hidden=True 未获得时不公开条件 |
| `organizations` | id, name, parent_id(可空=顶级), level(≥1), sort_order | 多级树；用户可选定任意层级节点 |
| `persons` | id, name, avatar(可空), brief(可空) | 长征人物志（006，需求 §14）：13 行真实历史人物；avatar 空时前端展示姓名首字占位（不伪造历史照片） |
| `person_nodes` | person_id(FK), node_id(FK) | 复合主键 (person_id, node_id)：人物 ↔ 节点（历史事件）关联，22 对；idx_person_nodes_node 支撑节点反查 |
| `daily_quotes` | id(自增), content, source, sort_order(默认0), is_enabled(默认TRUE), node_id(FK,可空) | 每日寄语（007 建表，013 改为循环模型：去掉 date，新增排序号/启用状态与索引 `ix_daily_quotes_cycle(is_enabled, sort_order, id)`）：有明确出处的语录，后台维护（/admin/quotes，支持 Excel 导入）；种子仅空表写入 5 条示例，非空表不动（不复活被删寄语） |
| `system_settings` | setting_key(64,主键), setting_value(200), updated_at | 系统键值配置（013）：`quote_cycle_start`=每日寄语循环起始日期（YYYY-MM-DD，迁移时取原寄语最早日期） |

### 3.2 用户业务表

| 表 | 关键字段 | 唯一约束 | 业务含义 |
| --- | --- | --- | --- |
| `users` | id, openid(64,唯一), nickname(默认"长征小战士"), avatar(500,可空), org_id(可空), original_nickname(64,可空), nickname_changed_at(可空), continuous_days, max_continuous_days, route_ceremony_at(可空), created_at | openid 唯一 | 微信登录创建；org_id 指向 `organizations`；avatar 可为 NULL（openGauss 将空字符串转为 NULL）；original_nickname 记录登录时的微信名（曾用名），nickname_changed_at 非空表示已使用唯一一次改名机会；continuous_days/max_continuous_days 为连续行军冗余缓存（sport 写入时维护，读取以 daily_sport 重算为准）；route_ceremony_at 非空表示已观看首次长征完成仪式（§20.4，之后仅静态回顾） |
| `daily_sport` | id, user_id, date(10), steps, distance, is_goal_completed, is_makeup, makeup_at | `uq_sport_user_date`(user_id+date) | 每日步数，**同日同步覆盖而非累加**；distance 为估算公里数（steps × 步长）；is_goal_completed 为当日达标标记（连续行军判定依据）；is_makeup/makeup_at 为补签预留（未实现） |
| `lit_nodes` | id, user_id, node_id, lit_at, step_snapshot | `uq_lit_user_node`(user_id+node_id) | 已点亮节点，**点亮后永久保留**；step_snapshot 记录点亮时刻累计步数 |
| `quiz_records` | id, user_id, date, total_count, correct_count, score, points, wrong_list(JSON), details(JSON, 可空，014), answer_at | `uq_quiz_user_date`(user_id+date) | 每日答题记录，**每日仅一次**，当日全部题目作答或超时后生成；wrong_list 元素含 questionId/category 供知识画像推导（超时计入）；details 为逐题结果（我的答案/正确答案/对错/是否超时/得分/本题积分），历史记录不回填 |
| `daily_questions` | id, user_id, date, question_ids(JSON) | `uq_dailyq_user_date`(user_id+date) | 当日抽题缓存（即答题会话），保证同一天返回同一套题 |
| `quiz_answers` | id, session_id(→daily_questions), user_id, date, seq, question_id, started_at, deadline_at, submitted_at(可空), user_answer(JSON), is_correct, status(answering/answered/timeout), points | `uq_quiz_answer_session_seq`(session_id+seq)；索引 (user_id, date) | 逐题限时作答（018）：开题/截止/提交时间均为服务器 UTC 时间；status 条件更新保证每题只判定一次；答题积分按该表答对数实时同步台账 |
| `points_log` | id, user_id, date, reason(50), delta, source_type(walk/quiz/legacy), ref_id(可空), biz_key(64,可空), created_at, updated_at | `uq_points_user_biz`(user_id+biz_key)；索引 (source_type, user_id) | 积分台账（017）：每人每来源每日一行（biz_key=walk:日期 / quiz:日期），按源数据覆盖重算；ref_id 指向 daily_sport / daily_questions；V2.0 前旧规则流水为 legacy，仅追溯不计入总积分 |
| `activity_settings` | id(固定 1), name, start_at, end_at, is_published, restrict_enabled, allow_view_after_end, end_title, end_message, updated_at, updated_by | 主键 | 活动时间配置（016）：时间 UTC naive 存储；状态不落库，按服务器时间实时计算；无配置行时视为进行中、不拦截 |
| `user_medals` | id, user_id, medal_id(50), granted_at | `uq_user_medal`(user_id+medal_id) | 用户已获勋章 |
| `user_event` | id, user_id, event_type(50), event_time, data(JSON) | 无（一次性事件靠 service 层 `has_event` 去重） | 统一事件流水：FIRST_STEP/DAILY_GOAL/STREAK_*/NODE_LIT/MEDAL_GRANTED/QUIZ_DONE 等；小程序足迹时间轴与管理端实时动态共用此表，`data` 存文案参数（节点名、连续天数等） |
| `user_identities` | id, user_id, provider(wx_mini/wx_web), app_id, openid, unionid(可空), verified_at(可空), created_at, updated_at | `uq_identity_provider_openid`(provider+app_id+openid)、`uq_identity_user_channel`(user_id+provider+app_id) | 微信身份关联（010）：登录时采集；「一个 unionid 只属一个用户」无索引约束，由 identity_service 事务内校验，冲突身份禁止自动合并 |
| `bind_requests` | id, token_hash(唯一), user_id(可空), provider, app_id, openid, unionid(可空), status(pending/confirmed/used/cancelled/expired), expires_at, used_at, confirmed_at, created_at | token_hash 唯一 | 身份绑定请求（010）：绑定凭证仅存 SHA-256 摘要，不存可重放明文；目标身份来自微信服务端而非前端提交 |
| `qr_login_sessions` | id(qrId), scene_token_hash(唯一), status(pending/scanned/confirmed/failed/cancelled/expired), fail_reason, user_id, token_issued, created_at, expires_at, confirmed_at | scene_token_hash 唯一 | PC 扫码登录会话（010）：id 为轮询凭证，与小程序码内嵌 scene 凭证分离；token_issued 保证管理员 JWT 仅签发一次（防轮询重放） |
| `admin_menus` | id, code(唯一), name, sort_order | code 唯一 | 后台菜单（010）：code 与 `require_menu` 依赖一一对应，共 11 项（dashboard/screen/rankings/route_nodes/questions/quotes/orgs/access/audit，015 增 invites，016 增 activity） |
| `admin_roles` | id, code(唯一), name, is_builtin, created_at | code 唯一 | 后台角色（010）：内置角色不可删除 |
| `admin_role_menus` | role_id(FK), menu_id(FK) | 复合主键 (role_id, menu_id) | 角色↔菜单关联（010） |
| `admin_user_roles` | id, user_id, role_id, enabled, granted_by, granted_at, updated_at | `uq_admin_user_role`(user_id+role_id) | 用户角色授权（010）：enabled=False 即时生效（get_current_admin 每请求查库） |
| `audit_logs` | id, actor_type(super/user), actor_user_id(可空), action, target_user_id(可空), detail(Text,可空), created_at | 无 | 管理后台审计（010）：授权/角色变更等操作逐项记录 |

> 与前端 `services/store.js` 的数据结构对应关系：
> `dailySport`→`daily_sport`、`litNodes`→`lit_nodes`、`quizRecords`→`quiz_records`、`pointsLog`→`points_log`、`medals`→`user_medals`。

### 3.3 数据库部署与结构变更

本地 openGauss 使用数据库 `longmarch`、用户 `gaussdb`、端口 `5118`。`../docker/init/init-db.sh` 创建数据库及 `schema_migrations`，再按文件名顺序执行尚未登记的 SQL。`001_schema.sql` 是当前基线；`002_route_node_config.sql` 增加路线节点经纬度、排序和启用字段；`003_optional_user_avatar.sql` 将 avatar 改为可空（适配 openGauss 空串→NULL）；`004_nickname_change.sql` 增加曾用名与改名时间；`005_upgrade.sql` 为高级化升级：users 连续行军字段、daily_sport 距离/达标/补签预留、lit_nodes 步数快照、route_nodes 历史事件卡 7 字段、questions 分类、medal_defs 分类/隐藏/排序、新建 user_event 表。`006_persons.sql` 新建 persons（长征人物志）与 person_nodes（人物-节点关联）两表。`007_daily_quotes.sql` 新建 daily_quotes（每日寄语）。`008_route_ceremony.sql` 为 users 增加 route_ceremony_at（长征完成仪式标记）。`009_org_serial.sql` 组织主键自增。`010_admin_identity.sql` 新建 user_identities/bind_requests/qr_login_sessions/admin_menus/admin_roles/admin_role_menus/admin_user_roles/audit_logs 八表并种入菜单与内置角色。`011_import_previews.sql` 新建 Excel 导入预览暂存表。`012_perf_indexes.sql` 补充热点查询索引。`013_daily_quote_cycle.sql` 将每日寄语改为循环模型（按原日期顺序回填排序号、全部置为启用、新建 system_settings 并写入循环起始日期、删除 date 列）。`014_quiz_result_details.sql` 为答题记录增加逐题结果。`015_invite_admission.sql` 邀请码准入。`016_activity_settings.sql` 新建活动配置表（默认已发布进行中）与 activity 菜单。`017_points_ledger.sql` 积分台账化：points_log 增来源/业务键/唯一索引，按 daily_sport / quiz_records 回填步行与答题积分，旧流水标记 legacy。`018_quiz_answers.sql` 新建逐题限时作答表。后续变更新增递增编号脚本，并同步修改 SQLAlchemy ORM，FastAPI 不自动建表。

## 4. 关键接口定义

Base URL：`http://127.0.0.1:8010`，前缀 `/api`。小程序侧除 `POST /api/auth/login`、`POST /api/auth/invite/verify`、`POST /api/auth/onboard` 与 `GET /api/org/children` 外，均需 `Authorization: Bearer <token>`（小程序令牌）。响应字段全部 camelCase。管理后台 `/api/admin/*` 使用管理员令牌（`typ=super` 超管 / `typ=user` 微信关联管理员），除 `POST /api/admin/login`、`POST /api/admin/wechat/qr`、`GET /api/admin/wechat/qr/{qr_id}/status` 外均需管理员令牌，且按菜单码校验权限（`require_menu`）。

### 4.1 接口总览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 否 | 健康检查 |
| POST | `/api/auth/login` | 否 | 微信登录：`{code, avatar?}` → 仅为**已入驻**用户签发 `{status:"active", token, user}`；未入驻 `{status:"unregistered"}`、已停用 `{status:"disabled"}` 均不签发 Token；active 登录顺带采集 unionid 身份行（幂等，V2.0 起登录不再发放积分）；同一 openid 重复/并发登录复用同一用户；微信换取失败 502 |
| POST | `/api/auth/invite/verify` | 否 | 校验入驻邀请码 `{inviteCode}`（不核销，`invite_limiter` 限流），返回 `{name, orgId, orgName}`；邀请码不可用返回 400（无效/停用/过期/用满） |
| POST | `/api/auth/onboard` | 否 | 持邀请码入驻 `{code, inviteCode, nickname, orgId, avatar?}`：同一事务内条件 UPDATE 核销（used_count + 1，未过期未停用）+ 建号 + 审计 `user.onboard`；openid 唯一约束冲突回滚撤销核销复用已有用户。返回 `{token, user, created}`；邀请码不可用或组织越界 400；账号已停用 403（头 `X-Account-Status: disabled`）；微信换取失败 502 |
| GET | `/api/auth/me` | 是 | 当前用户 `{id, nickname, avatar, orgId, nicknameChangedAt}` |
| PUT | `/api/auth/nickname` | 是 | 修改昵称 `{nickname}`（每人仅一次，已修改过返回 400）→ 返回最新用户 |
| PUT | `/api/auth/nickname/initial` | 是 | 首次引导设置昵称 `{nickname}`（不消耗改名机会；已改过名返回 400）→ 返回最新用户 |
| POST | `/api/auth/qr/info` | 是 | 查询扫码场景 `{scene}`：L{token} 返回 `{type:"login", status}`（pending→置 scanned）；B{token} 返回 `{type:"bind", status, target:{provider, appId, nickname?}}`；凭证不存在/过期 404/400 |
| POST | `/api/auth/qr/confirm` | 是 | 确认/取消扫码 `{scene, action:confirm|cancel}`：L 确认校验 RBAC——无启用角色会话置 failed（403 带原因），有角色置 confirmed；B 确认事务内写 user_identities（unionid 冲突禁止自动合并，凭证单次有效） |
| GET | `/api/sport/today` | 是 | 今日步数概况 `{date, steps, target, totalSteps}` |
| POST | `/api/sport/sync` | 是 | 解密 wx.getWeRunData 的 `stepInfoList`，按北京时间处理最近 7 个自然日并逐日覆盖；缺失日不写 0、可重试。返回 `{date, steps, totalSteps, synced, status, processedDates, failedDates, pointsChange, todayWalkPoints, walkCarry}`，其中 `steps` 仅为今天 |
| GET | `/api/sport/recent?n=7` | 是 | 最近 n 天记录 `[{date, steps, text}]` |
| GET | `/api/sport/calendar?month=YYYY-MM` | 是 | 行军日历：当月每日步数/达标/答题/点亮节点 + 月统计（总步数/运动天数/日均/最高/当前连续） |
| POST | `/api/sport/add` | 是 | 手动补步（演示）：`{delta}` → 今日概况，刷新勋章 |
| GET | `/api/profile/summary` | 是 | 个人档案聚合：用户信息、加入天数/阶段、运动/答题/积分统计、连续行军、路线完成度、portrait 五维数据画像（0~100） |
| GET | `/api/profile/timeline?limit=` | 是 | 我的长征足迹：`user_event` 倒序时间轴（文案与事件表同源） |
| GET | `/api/broadcast/today` | 是 | 今日长征播报：期号、全局运动汇总、今日长征彩蛋（历史事件卡）、个人当日状态 |
| GET | `/api/broadcast/activities?limit=` | 是 | 实时行军动态（小程序）：`user_event` 关联昵称倒序；隐私边界只下发昵称/文案/类型/时间（不含 user_id 与事件参数），`ACTIVITY_MASK_NICKNAME=true` 时昵称脱敏（如「王*明」）；实时增量经 WS `activity` 消息下发 |
| GET | `/api/march/route` | 是 | 路线进度 `{nodes, currentSteps, totalSteps, litCount, totalCount, nextNode, finished, currentNodeId, currentProgress, routeProgress, ceremonyPending}`；仅统计启用节点；轨迹进度字段见下；`ceremonyPending` 仅 finished 时查一次 users 表（route_ceremony_at 为空 → true） |
| GET | `/api/march/global` | 是 | 全员共同长征目标（需求 §11）：`{totalSteps, targetSteps, progressPct, milestones[{name,steps,reached}], nextMilestone{name,steps,remain}|null}`；全员累计=全部用户 daily_sport 之和，目标/里程碑配置于 `march_service.GLOBAL_GOAL_STEPS/GLOBAL_MILESTONES` |
| GET | `/api/march/footprints` | 是 | 我的长征足迹（需求 §7）：`{nodes[{id,name,icon,litAt,litDate,daySteps,cumSteps}]}`，按路线顺序的已点亮节点；litDate 为本地日期（与 DailySport.date 同口径），cumSteps 为点亮时刻累计快照（历史回填为 0 前端判空） |
| GET | `/api/march/route-nodes` | 是 | 启用节点配置列表（含经纬度） |
| GET | `/api/march/node/{node_id}` | 是 | 节点详情（任意状态可看，含未解锁），不存在 404；含 `latitude/longitude` 路线点位及 `persons[{id,name}]` 关联人物（§14 节点 → 人物入口） |
| POST | `/api/march/light-up` | 是 | 点亮达标节点，返回 `{newlyLit: [...], newlyCompletedChapters: [...], newMedals: [...]}` 并刷新勋章（newMedals 为本次新获勋章 id；V2.0 起点亮不发放积分，gainedPoints 恒为 0） |
| POST | `/api/march/ceremony` | 是 | 标记长征完成仪式已观看（§20.4）：幂等写入 users.route_ceremony_at；仅首次完成触发完整动画，之后仪式页为静态回顾 |
| GET | `/api/quiz/daily` | 是 | 今日固定答题状态 `{date, issueNo, completed, totalCount, questionShortage, shortageMessage, ...}`：按本人历史使用次数分层随机轮换；不开题、不下发未开题目；题库不足 5 道时按实际数量返回明确状态 |
| POST | `/api/quiz/start` | 是 | 开始/继续当前题（幂等）：作答中返回同一题与 `current{seq, question, startedAt, deadlineAt, remainingMs}`（题目不含答案与解析）；当前题已截止则判超时并开下一题；全部结束返回记录 |
| POST | `/api/quiz/answer` | 是 | 提交当前题 `{questionId, answer: ["A"]}`（单选/判断恰好 1 个选项）→ `{seq, correct, correctAnswer, analysis, points, correctCount, todayPoints, finished, record?}`；未开题 / 已作答 / 超时 / 非法选项 400；同题并发只一次生效。V2.0 起移除整卷提交 `/api/quiz/submit`（V1.2 已移除 `/api/quiz/check`） |
| GET | `/api/persons/{person_id}` | 是 | 长征人物志详情（需求 §14）：`{id, name, avatar, brief, nodes[{id,name,icon,historicalTime,brief}]}`（相关历史事件=关联节点，按路线顺序）；人物不存在 404 |
| GET | `/api/quotes/today` | 是 | 今日寄语（需求 §16、V1.1）：`{id, date, content, source, node{id,name}|null}`，date 为当天；启用寄语按排序号自循环起始日期起每天一条、末条后回到第一条，同一天所有用户同一条；无启用寄语返回 null |
| GET | `/api/quiz/records` | 是 | 答题记录列表 |
| GET | `/api/quiz/knowledge` | 是 | 知识画像：总正确率 + 按题目分类（event/route/figure）的答题数与正确率 |
| POST | `/api/quiz/reset` | 是 | 重置今日答题（调试用） |
| GET | `/api/points` | 是 | 积分概览 `{total, walk, quiz, todayWalk, todayQuiz, todaySteps, todayCorrect, rank, rules}`，total 恒等于 walk + quiz，rank 为总积分榜名次 |
| GET | `/api/points/daily?page=&page_size=` | 是 | 积分明细（按自然日倒序分页）`{total, items[{date, walk, quiz, total, steps, correctCount, updatedAt}]}` |
| GET | `/api/medal/list` | 是 | 勋章列表 `{medals: [{id, name, icon, desc, owned}], ownedCount}`（先触发检查发放） |
| POST | `/api/medal/check` | 是 | 检查并发放勋章，返回 `{newly: [medalId...]}` |
| GET | `/api/org/children?parent_id=` | 否 | 按层级下钻组织树（留空返回顶级） |
| GET | `/api/org/mine` | 是 | 我的组织 `{orgId, orgName, fullName, path, locked}`（locked=已归属组织，小程序不可再改） |
| GET | `/api/org/companions?limit=` | 是 | 同组织同行者（需求 §9）：`{org, memberCount, todayTotalSteps, companions[]}`；口径为用户所选组织的整棵子树，同行者按今日步数倒序限量（≤50），条目仅昵称/头像/今日步数/isSelf（§9.4 隐私） |
| GET | `/api/org/march` | 是 | 组织共同长征目标（需求 §10）：`{org, memberCount, totalSteps, progressPct, currentNodeName, nextNodeName, finished, litCount, totalCount, nodes[]}`；组织累计步数=子树成员累计有效步数之和，`currentNodeName`=第一个未完成节点、`nextNodeName`=其后一个（§10.2），节点 pct 已完成100/当前按累计占目标比例/其余0（§10.3） |
| POST | `/api/org/select` | 是 | 首次选定组织 `{orgId}`：条件 UPDATE（org_id 为空才写入）保证并发只成功一次，之后锁定再选 403「所属部门已锁定…」；组织不存在 404 |
| GET | `/api/rank/points?page=&page_size=` | 是 | 全员工总积分榜 `{top[第1~10名], list[第11名起分页], me, page, pageSize, hasMore, total}`，条目 `{rank, userId, nickname, avatar, orgName, steps, points, walkPoints, quizPoints, isMe}` |
| GET | `/api/rank/steps` | 是 | 旧版契约（兼容保留，名次同总积分口径）`{list, myRank, mySteps, total}` |
| GET | `/api/activity/status` | 否 | 活动状态（公开）`{name, status, statusText, startAt, endAt, allowParticipate, allowView, restrictEnabled, endTitle, message, serverTime}`，status∈unpublished/not_started/ongoing/ended |
| GET | `/api/auth/identities` | 是 | 已绑定身份列表 `[{id, provider, appId, openid, verifiedAt, createdAt, isPrimary}]`（wx_mini 主身份 isPrimary=true） |
| DELETE | `/api/auth/identities/{identity_id}` | 是 | 解绑身份：主身份（wx_mini）400「微信登录凭证不可解绑」，非本人身份 400「身份不存在」，成功写审计 |
| WS | `/api/ws/updates?token=` | 是 | 实时推送长连接：数据写入广播 `data_changed`；`user_event` 写入广播 `activity`（含文案） |
| POST | `/api/admin/login` | 否 | 管理后台账号登录 `{username, password}` → `{token, username}`；`ADMIN_PASSWORD` 未配置时禁用（403「未配置管理账号密码，请使用微信扫码登录」） |
| POST | `/api/admin/wechat/qr` | 否 | 创建扫码登录会话 → `{qr_id, image?, scene, mock, expires_in}`；未配置微信凭证（mock 模式）image 为 None、scene 为明文供调试 |
| GET | `/api/admin/wechat/qr/{qr_id}/status` | 否 | 轮询扫码状态（限流 2s 起）：pending/scanned 返回状态；confirmed 返回 `{token, username, is_super, menus}`（令牌单次签发防重放）；failed 带 `fail_reason` |
| GET/POST | `/api/admin/invites` | 管理员(invites) | 邀请码分页/新建：GET `?page=&page_size=&keyword=` 返回 `{total, items[{id,code,name,remark,orgId,orgName,maxUses,usedCount,expiresAt,isEnabled,status,createdBy,createdAt}]}`（`status∈active|disabled|expired|exhausted`）；POST `{name,remark,orgId,maxUses,expiresAt}` 生成 8 位随机 code（唯一），审计 |
| PATCH | `/api/admin/invites/{id}` | 管理员(invites) | 编辑邀请码：`{name?,remark?,orgId?,maxUses?,expiresAt?,isEnabled?}`，`maxUses` 不能低于已用次数，审计（不下发原码） |
| GET | `/api/admin/invites/{id}/qrcode` | 管理员(invites) | 下发邀请小程序码 `{image?, page, scene, envVersion, mock}`：页面 `pages/launch/launch`、scene `i=<CODE>`（≤32 字符，不含敏感信息）；mock 模式 image=None 返回明文 scene 供调试 |
| PATCH | `/api/admin/users/{user_id}/status` | 管理员(access) | 启用/禁用账号 `{status: "active"|"disabled"}`：禁用后下次请求返回 403 `X-Account-Status: disabled`，审计记录操作人 |
| PUT | `/api/admin/users/{user_id}/org` | 管理员(access) | 调整用户所属组织 `{org_id}`，审计 `user.org_change`（操作人/原组织/新组织/时间）；组织未变化不写审计；用户或组织不存在 404 |
| GET/PUT | `/api/admin/activity` | 管理员(activity) | 活动设置与当前状态；PUT `{name, start_at, end_at, restrict_enabled, allow_view_after_end, end_title, end_message}`（时间按北京时间解释，开始须早于结束，否则 400），即时生效，审计 `activity.update`（before/after） |
| POST | `/api/admin/activity/publish` | 管理员(activity) | 发布/撤回 `{published}`，审计 `activity.publish` / `activity.unpublish`；未保存配置 400 |
| POST | `/api/admin/points/verify` | 管理员(rankings) | 积分台账核对 `{fix?, user_ids?}` → `{users, checked_days, mismatches, fixed, samples[{user_id, biz_key, expected, actual}]}`；fix=true 按源数据修复并写审计 `points.recompute` |
| GET | `/api/admin/me` | 管理员 | 当前管理员信息与菜单权限 `{is_super, username, menus}` |
| GET | `/api/admin/users` | 管理员(access) | 人员授权列表（昵称/组织/`status`筛选、分页）：每项含启用/禁用角色、授权人、邀请码来源（inviteCodeId/inviteName）、onboardedAt、status |
| GET | `/api/admin/roles` | 管理员(access) | 角色列表（含菜单勾选与是否内置） |
| POST | `/api/admin/roles` | 管理员(access) | 新建角色 `{name, menu_ids}`（code 由拼音首字母生成，重名 400） |
| PUT | `/api/admin/roles/{role_id}` | 管理员(access) | 编辑角色名称与菜单（内置角色 400） |
| DELETE | `/api/admin/roles/{role_id}` | 管理员(access) | 删除角色（内置/已授权 400，删除同时清理菜单关联） |
| POST | `/api/admin/users/{user_id}/roles` | 管理员(access) | 全量覆盖用户角色 `{role_ids}`（返回最新启用角色，逐项审计） |
| PATCH | `/api/admin/users/{user_id}/roles/{role_id}/enabled` | 管理员(access) | 启用/禁用单个角色授权（即时生效，不改授权关系） |
| GET | `/api/admin/audit-logs` | 管理员(audit) | 审计日志分页（日期/动作/操作人筛选，倒序） |
| GET | `/api/admin/dashboard` | 管理员(dashboard) | 驾驶舱聚合：核心指标（参与人数/今日运动/总步数/人均/完赛率/答题人数/勋章发放）+ 路线总览 |
| GET | `/api/admin/dashboard/trend?days=` | 管理员(dashboard) | 运动趋势：近 N 日每日总步数/运动人数/新增用户/新点亮节点数 |
| GET | `/api/admin/activities?limit=` | 管理员(dashboard) | 实时动态：`user_event` 关联昵称倒序 |
| GET | `/api/admin/screen` | 管理员(screen) | 数据大屏单接口聚合：指标 + 路线总览 + 7 日趋势 + 实时动态（整体口径，无组织维度） |
| GET | `/api/admin/rankings` | 管理员(rankings) | 全员排名（服务端分页）：`page`、`page_size`（≤200）、`keyword`（昵称/人员 ID 包含匹配）、`org_id`（所属组织精确匹配）、`only_changed`。全员指标（total/total_steps/total_points/completed_users/avg_progress）和荣誉榜 podium（前 10 名：1~3 领奖台、4~10 荣誉卡）不受筛选影响；`match_total` 为命中人数；`org_options` 为有成员的组织；items 只返回当前页，每人含总/步行/答题积分与全部启用节点的到达时间，名次与小程序总积分榜同口径 |
| GET | `/api/admin/rankings/export` | 管理员(rankings) | 按相同筛选条件流式导出 CSV（UTF-8 BOM，防公式注入，按批读取，每批 1000 人），时间为本地 `YYYY/MM/DD HH:mm` |
| GET | `/api/admin/users/{id}/overview` | 管理员(rankings) | 人员详情聚合（运动/答题/勋章/长征/积分） |
| GET | `/api/admin/route-nodes` | 管理员(route_nodes) | 全部路线节点列表（含停用） |
| POST | `/api/admin/route-nodes` | 管理员(route_nodes) | 新增路线节点 |
| PUT | `/api/admin/route-nodes/{id}` | 管理员(route_nodes) | 编辑路线节点（含历史事件卡 7 字段） |
| PATCH | `/api/admin/route-nodes/{id}/enabled` | 管理员(route_nodes) | 启用/停用节点 |
| GET/POST/PUT/DELETE | `/api/admin/questions[/{id}]` | 管理员(questions) | 题库 CRUD（含 category；DELETE 软停用，不破坏当天已生成任务） |
| GET/POST | `/api/admin/questions/import-template` · `import-preview` · `import-confirm` | 管理员(questions) | 题库 Excel 导入：模板下载 → 上传校验（返回 `{preview_token, total, valid_count, invalid_count, errors[{row, field, reason}]}`）→ 凭令牌确认写入 `{imported}`（令牌 30 分钟有效、单次核销，重复确认 400） |
| GET/POST/PUT/DELETE | `/api/admin/quotes[/{id}]` | 管理员(quotes) | 每日寄语 CRUD（需求 §16）：字段 `{content, source, sort_order(0~999999), is_enabled, node_id}`；GET 分页 page/pageSize 按 (sort_order, id) 升序，可选 keyword 按内容/出处模糊搜索（LIKE 通配符转义）；内容/出处为空或超 200 字、排序号越界、坏节点 400，不存在 404 |
| GET/PUT | `/api/admin/quotes/cycle` | 管理员(quotes) | 寄语循环信息 `{start_date, enabled_count, today_quote_id, today_position}`；PUT `{start_date}` 修改循环起始日期（格式非法 400） |
| GET/POST | `/api/admin/quotes/import-template` · `import-preview` · `import-confirm` | 管理员(quotes) | 寄语 Excel 导入（契约同题库导入）：表头 寄语内容/出处/排序号/启用状态/关联节点（节点填名称或 ID）；错误定位到行与字段，库内/文件内重复内容判错不覆盖；排序号留空接在库内与文件内最大值之后 |
| GET/POST/PUT/DELETE | `/api/admin/orgs[/{id}]` | 管理员(orgs) | 组织架构树 CRUD；GET 树每节点含 `direct_user_count`（直属人数）与 `total_user_count`（含下级累计，后序累加）；`POST /api/admin/orgs/sync` 从外部系统同步 |
| GET | `/api/admin/orgs/{id}/users?scope=&page=&page_size=` | 管理员(orgs) | 组织人员明细（分页）：`scope=direct` 仅直属成员（与 direct_user_count 同口径）、`scope=all` 含全部层级下级（与 total_user_count 同口径）；组织不存在 404 |

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

**开题 / 今日状态**（`POST /api/quiz/start`、`GET /api/quiz/daily` 同结构；`current.question` 不含 `answer` 与 `analysis`）：

```json
{
  "date": "2026-10-13", "issueNo": 43, "completed": false, "totalCount": 5,
  "timeLimit": 90, "serverTime": 1791863450232,
  "progress": [{ "seq": 1, "status": "answered", "correct": true }, { "seq": 2, "status": "answering", "correct": false },
               { "seq": 3, "status": "pending", "correct": false }],
  "current": { "seq": 2, "startedAt": 1791863440000, "deadlineAt": 1791863530000, "remainingMs": 79768,
               "question": { "id": 3, "type": "single", "question": "……", "options": [{ "label": "A", "text": "……" }], "score": 20 } },
  "correctCount": 1, "points": 2, "record": null
}
```

**逐题提交**（`POST /api/quiz/answer`）：

```json
// 请求（只能提交当前已开题、未截止的题目，每题一次）
{ "questionId": 3, "answer": ["A"] }
// 响应：即时判定；finished=true 时 record 为当日记录
{
  "seq": 2, "questionId": 3, "status": "answered", "correct": true, "userAnswer": ["A"], "correctAnswer": ["A"],
  "analysis": "……", "points": 2, "correctCount": 2, "todayPoints": 4, "totalCount": 5, "finished": false, "record": null
}
```

当日记录（`record`）：`{date, totalCount, correctCount, score, points, accuracy, timeoutCount, wrongList, details, answerAt}`，`details` 每项含 `timeout` 与本题 `points`。014 之前的历史记录 details 为空数组，前端回退展示 `wrongList`，不回算历史成绩。`/api/quiz/records` 列表不返回 details。

**计时与防作弊**：
- 计时只认服务器时间：开题时写 `started_at` 与 `deadline_at = started_at + QUIZ_QUESTION_SECONDS`（90 秒），前端倒计时以 `remainingMs` / `serverTime` 校准，仅用于展示。
- 只下发当前已开题的一道题，不预先下发整套题；提交时校验题目属于本人今日会话且已开题。
- 判定与超时都以 `status='answering'` 为条件更新：并发重复提交、提交与超时竞态只有一方生效；超时题不得分、之后提交一律 400。
- 截止后 `QUIZ_ANSWER_GRACE_SECONDS`（2 秒）内到达的提交视为网络延迟仍受理；被动查询（`/daily`）按截止 + 宽限判超时；主动开下一题视为放弃当前题，截止即判超时。
- 每次判定在同一事务内按本会话答对数重算当日答题积分（`biz_key=quiz:日期`），中途退出已得积分保留；核对重算以 `quiz_answers` 为源（无逐题数据的历史日回退 `quiz_records`）。

## 5. 核心业务规则（与前端 Mock 完全一致）

| 域 | 规则 |
| --- | --- |
| 步数 | 按「用户+日期」唯一；首页今日行军目标为 20000 步；后端解密 wx.getWeRunData 后按北京时间筛选最近 7 日逐日覆盖，缺失日不写 0/不覆盖旧值并返回失败原因；前端仅展示今天。`daily_sport` 记录 source/synced_at/sync_status；仅开发环境模拟，真实用户绝不造数 |
| 路线 | 累计步数 ≥ 节点 `targetSteps` 即点亮，点亮**永久保留**；节点状态 `completed`（已点亮）/ `current`（下一目标）/ `unlocked`（未解锁）；停用节点不在小程序可见路线中，不参与完成判定和排名，已有 lit_nodes 记录保留 |
| 章节 | 5 章配置于 `march_service.CHAPTERS`（每章 2 个 route_nodes 主键，划分与介绍可配置）；章内启用节点全点亮即完成，状态 `COMPLETED / ACTIVE / LOCKED`（全部停用的章节不下发）；`light_up_nodes` 对比点亮前后完成集，新完成章写 `CHAPTER_COMPLETE` 事件并随响应返回（含 title/intro 供前端仪式展示），不改变节点点亮与积分规则 |
| 答题 | 每用户独立按题目历史使用次数分层轮换：先随机取本人未使用/当前最早轮次题，不足 5 时跨下一层补足；同日固定且不重复。题库 1~4 道按实际数量并返回不足状态；软停用题不进入新任务但不影响当天既有任务。逐题 90 秒、单次提交、服务端判定保持不变 |
| 积分 | 总积分 = 步行积分 + 答题积分，只由后端计算：每日最多 20000 步参与计分，按日期累计每满 1000 步 1 分，零头结余到下一条记录，单日最高 20；答题每对 1 题 +2、每日最高 10。台账幂等覆盖；往日补录/修正从该日起联动重算后续结余；旧 legacy 流水不计入 |
| 勋章 | 12 枚分四类：入门（first-step 首次运动 / learner 答题 10 次 / persistence 连续行军 7 天）、路线（luding 点亮泸定桥 / snow 点亮雪山）、挑战（day-10k 单日万步 / steps-100k / steps-500k / streak-30 连续 30 天 / master 积分≥500 / fearless 连续 7 天日万步，隐藏）、完成（victory 全部**启用**节点点亮）；隐藏勋章未获得时不公开条件 |
| 连续行军 | 当日步数 ≥ `STREAK_GOAL_STEPS`（默认 5000）即完成当日行军；写入侧在 `is_goal_completed` 由 False 翻 True 时更新 `users.continuous_days/max_continuous_days` 并写 DAILY_GOAL/STREAK_* 事件（一次性成就按事件表去重）；读取侧以 `daily_sport.is_goal_completed` 重算为准 |
| 事件 | 所有用户侧成就（首次运动/当日达标/连续里程碑/点亮节点/获得勋章/完成答题等）统一写 `user_event`，文案由 `event_service.build_text` 生成；写事件即向 WS 广播 `activity`，任何数据写入广播 `data_changed`；小程序公开动态流（`/api/broadcast/activities` + WS）只暴露昵称/文案/类型/时间，`ACTIVITY_MASK_NICKNAME` 可开启昵称脱敏 |
| 组织 | 树形逐级下钻；用户可选定任意层级节点；`/org/children` 不鉴权可浏览；所属组织首次确定（入驻或首次选择）后即锁定，用户侧再选 403，仅管理员可调整并写审计 `user.org_change` |
| 活动窗口 | 管理端配置活动名称/起止时间（北京时间）/访问限制/结束后可查看/结束文案，发布后生效；状态按服务器时间实时计算。产生业务数据的接口（同步步数、开题答题、点亮、选组织等）挂 `require_activity_participation`，仅进行中放行；成绩/排行等读取接口挂 `require_activity_view`，结束后按 `allow_view_after_end` 放行；拒绝统一 403 + `X-Activity-Status`；鉴权先于活动校验（无 Token 恒 401）；`restrict_enabled=false` 或无配置时不拦截 |
| 昵称 | 登录时以微信昵称建号（记为曾用名）；登录**不再覆盖**昵称（头像仍随登录更新）；首次引导可经 `PUT /auth/nickname/initial` 设置昵称（不消耗改名机会）；应用内 `PUT /auth/nickname` 修改，**每人仅一次**（改后 nickname_changed_at 记录时间，再改返回 400）；曾用名与修改时间在管理端排名洞察可见 |
| 排名 | 跨组织员工个人总榜，按总积分降序、同分按累计步数降序、再按 user_id 升序（名次稳定、两端一致）；小程序 `/rank/points` 返回前 10 名 + 第 11 名起分页，`isMe` 标记本人；管理端返回全量人员（分页）及 `lit_nodes.lit_at` 节点到达时间 |
| 身份关联 | 认证（JWT）、身份关联（user_identities）、后台授权（RBAC）三层分离——绑定身份成功**不等于**拥有后台权限；`wx_mini` 登录凭证身份不可解绑；同一 `provider+app_id+openid` 全局唯一，unionid 冲突**禁止自动合并**（事务内校验，冲突时不写入不合并）；绑定凭证只存 SHA-256 摘要，确认后单次有效 |
| 扫码登录 | L 场景：创建→轮询→小程序确认（无启用角色时会话置 failed 并返回原因，有角色置 confirmed）→PC 轮询到 confirmed 后**单次签发**管理员 JWT（token_issued 原子标记防重放）；B 场景：确认后事务写 user_identities（provider 目标身份来自微信服务端） |
| RBAC 授权 | 超管（`typ=super`）全菜单放行；微信关联管理员（`typ=user`）按启用角色的菜单并集校验，`get_current_admin` **每请求查库**——角色撤销/禁用即时生效（WS 管理端分支建连查库校验，失效 4403 关闭）；授权/角色变更逐项写审计（区分 super/user 操作人） |

## 6. 关键设计决策与权衡

1. **camelCase 契约优先**：以 `CamelModel` 统一序列化而非改动前端 Mock，换来前端平滑切换；代价是后端内部保持 snake_case 与输出层的转换分离。
2. **openGauss + SQL 版本表**：数据库由根目录 Docker Compose 承载，SQLAlchemy 通过 `psycopg2` 连接 PostgreSQL 兼容协议；`schema_migrations` 保证结构脚本只执行一次，业务种子仍由后端幂等写入。
3. **勋章检查挂在副作用链尾**：运动/点亮/答题/登录后统一触发 `medal_service.check_and_grant`，避免遗漏判定时机；判定本身幂等（已拥有即跳过）。
4. **`daily_questions` 抽题缓存表**：保证「同一天同一套题」的体验与幂等语义，避免每次请求重新随机导致前后端不一致。
5. **认证/身份/授权三层分离**：JWT 只证明「是谁」，user_identities 只记录「哪些微信身份属于谁」，RBAC 才决定「能进后台做什么」；扫码确认同时校验三层，身份绑定成功不授予后台权限。
6. **扫码令牌单次签发（token_issued 原子标记）**：confirmed 后并发轮询只会签出一枚管理员 JWT，防重放；轮询接口本身不鉴权但限流，避免撞库。
7. **RBAC 每请求查库**：管理员令牌 12 小时长时效与「撤销即时生效」矛盾，靠每次请求查询启用角色/菜单解决；代价是每次管理员请求多一次数据库查询（单表索引，可接受）。
