# models.py

## 1. 文件路径

`backend/app/models/models.py`（684 行）

## 2. 文件职责

后端唯一的 ORM 映射文件：以 SQLAlchemy 2.0 声明式风格（`Mapped[T]` / `mapped_column`）定义 34 个模型类，与 openGauss 库中 34 张业务表一一对应（第 35 张 `schema_migrations` 按设计不建 ORM 模型，`ARCHITECTURE.md` §13）。本文件只负责「Python 对象 ↔ 表结构」映射：不建表（DDL 唯一来源是 `docker/init/*.sql`，不变量 8，禁止 `create_all`）、不含业务逻辑、不定义 `relationship()`（全文件 grep 0 命中，跨表查询由 service 层手写 join/聚合）。

## 3. 业务需求

各模型是相应业务域的持久化载体：长征路线与节点点亮、每日答题、步数与积分、勋章、组织架构、邀请码准入、微信身份关联与管理端 RBAC、审计与 Excel 导入、活动时间控制、AI 智能中心。

**字段级说明不在本文档重复**：34 张表的完整分组目录见 `ARCHITECTURE.md` §13.1，类型/可空性/默认值/索引的 DDL 权威来源是 `docker/init/*.sql`（对应文档 `.qoder/docker/init/*.sql.md` 待生成）。本文档只记录 ORM 文件自身的事实：模型清单、声明约定、类型映射问题与约束语义。

## 4. 核心功能

### 4.1 `Base` 来源与 `CamelModel` 位置

- `Base` 从 `app.core.database` 导入（`:28`），是 `DeclarativeBase` 子类（`core/database.py:54`）；本文件不自建 metadata。
- `CamelModel` **不在本文件**：Pydantic 响应基类（`alias_generator=to_camel`、`populate_by_name=True`、`from_attributes=True`）定义在 `app/schemas/schemas.py:17-22`。ORM 模型只管库读写，camelCase 输出契约由 schemas 层完成（不变量 1）。

### 4.2 顶部 docstring 与分组注释（`:1-9`、`:31`、`:178`、`:384`、`:539`）

顶部 docstring 把模型分为「静态配置数据」与「用户业务数据」两类，并声明与前端 `services/store.js` 用户数据结构（dailySport/litNodes/quizRecords/pointsLog/medals/firstSyncAt）的对应关系。该 docstring 停留在早期口径（详见 §9 文档滞后）。文件内现有 4 个分组注释：静态配置数据（`:31`）、用户业务数据（`:178`）、微信身份关联与管理后台 RBAC（`:384`，注明设计文档 `docs/identity-binding-design.md`）、AI 智能中心 021（`:539`）。

### 4.3 34 个模型类清单（按文件内分组注释；一句话职责 + 类定义行号）

**静态配置数据（`:31` 起，9 个）**

| 模型 | 行号 | 表 | 职责 |
|---|---|---|---|
| `RouteNode` | `:32` | route_nodes | 长征路线节点（`target_steps` 累计步数要求）+「历史事件卡」内容字段（brief/significance/figures/location/images/audio/keywords，种子仅补空值） |
| `Person` | `:61` | persons | 长征人物志（需求 §14），avatar 空时前端展示姓名首字 |
| `PersonNode` | `:72` | person_nodes | 人物 ↔ 节点复合主键关联 |
| `DailyQuote` | `:81` | daily_quotes | 每日寄语，启用项按 (sort_order, id) 升序按天循环展示 |
| `SystemSetting` | `:98` | system_settings | 系统级键值配置（如寄语循环起始日期 `quote_cycle_start`） |
| `ActivitySetting` | `:108` | activity_settings | 活动时间控制（单行 id=1，016 迁移；状态由 activity_service 实时计算） |
| `Question` | `:126` | questions | 题库（single/judge，知识画像分类 event/route/figure） |
| `MedalDef` | `:145` | medal_defs | 勋章定义（字符串主键；hidden 勋章不公开获取条件） |
| `Organization` | `:163` | organizations | 组织架构多级树（parent_id 空为顶级） |

**用户业务数据（`:178` 起，10 个）**

| 模型 | 行号 | 表 | 职责 |
|---|---|---|---|
| `User` | `:179` | users | 用户主表：openid 唯一、准入状态、改名一次记录、连续行军缓存、完成仪式标记 |
| `InviteCode` | `:208` | invite_codes | 入驻邀请码（`used_count` 仅由 invite_service 条件 UPDATE 原子递增） |
| `DailySport` | `:231` | daily_sport | 每日步数（同日覆盖不累加；含 2 个补签预留死字段，见 §9） |
| `LitNode` | `:255` | lit_nodes | 已点亮节点（永久保留；`step_snapshot` 历史回填为 0） |
| `QuizRecord` | `:271` | quiz_records | 每日答题结果（每日一次；`answer_at` 为毫秒时间戳） |
| `DailyQuestion` | `:290` | daily_questions | 当日抽题缓存（同一天返回同一套题） |
| `QuizAnswer` | `:302` | quiz_answers | 逐题限时作答（018：服务器计时、answering/answered/timeout） |
| `PointsLog` | `:329` | points_log | 积分台账（017：walk/quiz 每人每日每来源一行，`biz_key` 幂等；legacy 仅追溯不计分） |
| `UserMedal` | `:353` | user_medals | 用户已获勋章 |
| `UserEvent` | `:365` | user_event | 统一业务事件（「我的长征足迹」与管理端实时动态同源） |

**微信身份关联与管理后台 RBAC / 审计 / 导入（`:384` 起，9 个）**

| 模型 | 行号 | 表 | 职责 |
|---|---|---|---|
| `UserIdentity` | `:385` | user_identities | 微信身份关联（wx_mini / wx_web 渠道） |
| `BindRequest` | `:409` | bind_requests | 身份绑定请求（凭证仅存 SHA-256 摘要，不存明文） |
| `QrLoginSession` | `:434` | qr_login_sessions | PC 扫码登录会话（`token_issued` 保证 JWT 仅签发一次） |
| `AdminMenu` | `:456` | admin_menus | 后台菜单（code 与 `require_menu` 依赖一一对应） |
| `AdminRole` | `:467` | admin_roles | 后台角色（is_builtin 不可删除） |
| `AdminRoleMenu` | `:479` | admin_role_menus | 角色 ↔ 菜单复合主键关联 |
| `AdminUserRole` | `:488` | admin_user_roles | 用户角色授权（enabled=False 即时生效，get_current_admin 每请求查库） |
| `AuditLog` | `:503` | audit_logs | 管理后台审计日志（actor_type: super/user） |
| `ImportPreview` | `:519` | import_previews | Excel 两阶段导入预览暂存（token 主键、一次性、会过期） |

**AI 智能中心（`:539` 起，6 个，021 迁移）**

| 模型 | 行号 | 表 | 职责 |
|---|---|---|---|
| `AiKnowledge` | `:540` | ai_knowledge | AI 知识资料（仅 published 参与正式问答检索） |
| `AiConversation` | `:573` | ai_conversations | AI 会话（归属由 JWT 用户确定） |
| `AiMessage` | `:590` | ai_messages | AI 消息（role: user/assistant/system；含核验后的来源列表） |
| `AiGenerationJob` | `:610` | ai_generation_jobs | 题目生成任务（题目工坊） |
| `AiGeneratedQuestion` | `:634` | ai_generated_questions | AI 题目草稿（审核后导入正式题库） |
| `AiUsageLog` | `:660` | ai_usage_logs | AI 调用日志（(user_id, day_key) 日限额计数与用量统计） |

合计 34 个 `__tablename__`（grep 计数核实）。ORM 覆盖率 34/34 由 `backend/test/s21_opengauss_compat.py:56-60` 用例 C03 校验（`ARCHITECTURE.md` §13）。注意：`ARCHITECTURE.md` §13.1 的分组与本文件注释分组略有差异——`invite_codes` 在那里归「身份/RBAC/审计」组，在本文件中位于「用户业务数据」段（`:208`）。

### 4.4 类型映射约定

| SQLAlchemy 类型 | 用途 | 示例（行号） |
|---|---|---|
| `Integer` / `BigInteger` | 整数；**毫秒时间戳** | `quiz_records.answer_at` 用 `BigInteger`（`:287`）——全库唯一毫秒时间戳列，不是 `DateTime`（`ARCHITECTURE.md` §4.5 例外项） |
| `String(n)` / `Text` | 短文本 / 长文本 | 全部枚举状态列也是 `String` + 应用层常量（见 §7） |
| `Boolean` | 开关/标记 | `is_published :117`、`is_goal_completed :247` 等 |
| `DateTime` | UTC naive 时间 | 业务日切分按北京时间在 helpers 层处理（`ARCHITECTURE.md` §4.5） |
| `JSON` | 数组/对象列 | `questions.options :137`、`quiz_records.wrong_list :284`/`details :286`、`user_event.event_data :381` 等；用 `JSON` 而非 `JSONB`（`ARCHITECTURE.md` §12.5） |
| `Numeric` | 经纬度与距离 | `route_nodes.latitude :55`、`longitude :56`、`daily_sport.distance :246` |

**已确认问题——`Numeric` 列注解为 `Mapped[float]` 与运行时类型不符**（依据：`ARCHITECTURE.md` §13.2 / §16.1，开发库实测）：上述三列注解为 `Mapped[float]`（`:55-56`、`:246`），但 psycopg2 运行时实际返回 `decimal.Decimal`（实测 `Decimal('25.885000')`、`Decimal('4.27')`）。`Mapped[...]` 只是 typing 元数据，SQLAlchemy **不据此做类型强转**，故注解与运行时类型不符；对外出口经 Pydantic 序列化为 float，当前无业务影响，记为技术债。在 service 层直接对这三个字段做算术或比较时须注意 Decimal/float 混用。

### 4.5 主键与默认值约定

- **自增整型主键**为主流；**非自增主键**三类：字符串主键（`medal_defs.id :154`、`qr_login_sessions.id :443`、`import_previews.token :529`、`system_settings.setting_key :103`）、复合主键（`person_nodes :77-78`、`admin_role_menus :484-485`）、显式赋值整型（`persons.id :66`、`questions.id :134`、`organizations.id :171`、`activity_settings.id :113` 单行 id=1）。非自增整型主键的新增记录由业务代码 `max(id)+1` 分配，**无并发保护**（`ARCHITECTURE.md` §16.1）。
- **两套默认值并存**：Python 侧 `default=`（如 `datetime.utcnow`、字符串常量）仅对 ORM 插入生效；SQL 侧 `DEFAULT` 写在 `docker/init` DDL 中，直接 SQL 写入时由它兜底——改默认值必须两处分别核对（`ARCHITECTURE.md` §13.2）。
- **`users.nickname` 列默认值 `"长征小战士"`（`:192`）**：这是登录默认昵称的真实来源——ORM 列默认值，不由接口代码显式赋值（`ARCHITECTURE.md` §16.1 已查证）。
- **空字符串 = NULL**：openGauss Oracle 兼容模式 A 下 `''` 落库为 NULL；字符串内容列保持可空，读取时 `None` 即空值（`RouteNode` docstring `:36-37`、`AiKnowledge` docstring `:546`）。

### 4.6 唯一约束与索引声明

- **唯一约束**：一律在 `__table_args__` 用 `UniqueConstraint` 声明并显式命名 `uq_xxx`（`backend/AGENTS.md` §5），共 10 处：`uq_sport_user_date :240`、`uq_lit_user_node :262`、`uq_quiz_user_date :275`、`uq_dailyq_user_date :294`、`uq_quiz_answer_session_seq :310`、`uq_points_user_biz :337`、`uq_user_medal :357`、`uq_identity_provider_openid :394`、`uq_identity_user_channel :395`、`uq_admin_user_role :492`。另有 6 处列级 `unique=True`：`users.openid :191`、`invite_codes.code :218`、`bind_requests.token_hash :419`、`qr_login_sessions.scene_token_hash :444`、`admin_menus.code :462`、`admin_roles.code :473`。
- **索引**两种声明方式：列级 `index=True`（如 `users.openid/org_id/created_at/invite_code_id :191/:194/:199/:204`、各业务表 `user_id` 与 `date` 列、`lit_nodes.lit_at :267`、`user_event.event_time :380`、`questions.active :142`、`organizations.parent_id :173`、`audit_logs.target_user_id/created_at :513/:516`）；`__table_args__` 中 `Index(...)`（命名 `ix_xxx`）共 13 处：`ix_daily_quotes_cycle :88`、`ix_quiz_answers_user_date :311`、`ix_points_log_source_user :338`、`ix_user_event_user_type :375`、`ix_ai_knowledge_status_cat :551`、`ix_ai_knowledge_node :552`、`ix_ai_conversations_user_updated :580`、`ix_ai_messages_conv_id :597`、`ix_ai_jobs_created :618`、`ix_ai_genq_status :643`、`ix_ai_genq_job :644`、`ix_ai_usage_user_day :670`、`ix_ai_usage_day :671`。

### 4.7 外键：23 处 `ForeignKey` + 13 个无约束的逻辑外键列

- 全文件 **23 处 `ForeignKey(...)` 声明**（grep 计数），与 `docker/init` DDL 中 23 处 `REFERENCES` 一一对应。唯一的级联删除是 `ai_messages.conversation_id` 的 `ondelete="CASCADE"`（`:600-602`，DDL `021_ai_center.sql:40`）；同时 `AiConversation` docstring（`:576`）说明服务层删除会话时仍**显式连同消息一并删除**、不依赖数据库级联——两层保障并存。
- **逻辑外键没有数据库级 FK 约束**（`ARCHITECTURE.md` §13.2 已核实：「11 处逻辑外键没有数据库级 FK 约束，有意为之，便于迁移与数据修复」）。按「ORM 无 `ForeignKey` 声明且 DDL 无 `REFERENCES`、但列承载引用 id」的口径逐条核对本文件与 `docker/init`，共列出 **13 列**：

| 列 | 行号 | DDL 依据 |
|---|---|---|
| `organizations.parent_id` → organizations.id | `:173` | `001_schema.sql:36` |
| `users.org_id` → organizations.id | `:194` | `001_schema.sql:49` |
| `users.invite_code_id` → invite_codes.id | `:204` | `015_invite_admission.sql:26` |
| `invite_codes.org_id` → organizations.id | `:221` | `015_invite_admission.sql:12` |
| `lit_nodes.node_id` → route_nodes.id | `:266` | `001_schema.sql:70` |
| `quiz_answers.question_id` → questions.id | `:319` | `018_quiz_answers.sql:14` |
| `points_log.ref_id` → daily_sport.id（walk）/ daily_questions.id（quiz） | `:347` | `017_points_ledger.sql:8-10` |
| `user_medals.medal_id` → medal_defs.id | `:361` | `001_schema.sql:118` |
| `audit_logs.actor_user_id` → users.id | `:510` | `010_admin_identity.sql:95` |
| `audit_logs.target_user_id` → users.id | `:512` | `010_admin_identity.sql:97` |
| `ai_generated_questions.question_id` → questions.id | `:656` | `021_ai_center.sql:73` |
| `ai_usage_logs.user_id` → users.id | `:675` | `021_ai_center.sql:80` |
| `ai_usage_logs.conversation_id` → ai_conversations.id | `:676` | `021_ai_center.sql:81` |

  本清单 13 列与 `ARCHITECTURE.md` 的「11 处」存在计数差异（疑为是否计入审计/日志表列的口径不同），「11」的精确列口径**待确认**。注意答题积分的 `ref_id` 指向 `daily_questions.id`（当日会话），**不是** `quiz_records.id`（`017_points_ledger.sql:8` 注释、`ARCHITECTURE.md` §16.1）。开发库实测 7 项抽查（users.org_id、lit_nodes.node_id、user_medals.medal_id、quiz_records.user_id、daily_sport.user_id、organizations.parent_id、points_log.ref_id）**全部 0 孤儿**（`ARCHITECTURE.md` §16.1）。

## 5. 输入与输出

本文件无函数与接口，「输入输出」即 ORM 类的运行时行为：

- **读**：查询返回模型实例；`DateTime` 列为 naive `datetime`（UTC）；`JSON` 列返回 `list`/`dict`；`Numeric` 列返回 `decimal.Decimal`（见 §4.4，`Mapped[float]` 注解不可信）；`BigInteger answer_at` 返回 `int` 毫秒值。
- **写**：Python 侧 `default=` 仅在 ORM flush 时生效；绕过 ORM 的直接 SQL 写入由 DDL 的 SQL 侧 `DEFAULT` 兜底。
- **异常**：违反唯一约束时 SQLAlchemy 抛 `IntegrityError`，并发场景（重复答题提交、邀请码核销、积分重算）由 service 层捕获/回滚，唯一约束是最后一道兜底（见 §7）。

## 6. 依赖关系

- **上游**：仅 `sqlalchemy` 与 `app.core.database.Base`（`:10-28`），不依赖任何业务模块——处于分层最底层（`api/routes → api/deps → services → models + core`，`backend/AGENTS.md` §3.1）。
- **下游（被引用）**：`app/data/seed.py:11`（7 个配置类模型）、`app/api/deps.py:10`（User）、几乎全部 services 与 routes 模块、后端测试脚本（如 `s21_opengauss_compat.py` 校验 ORM 与真库列一致）。
- **表结构执行来源**：`docker/init/001-022` 编号迁移。建表对应关系（grep DDL 核实）：001 建初始 11 表（route_nodes/questions/medal_defs/organizations/users/daily_sport/lit_nodes/quiz_records/daily_questions/points_log/user_medals）；005 user_event；006 persons/person_nodes；007 daily_quotes；010 身份/RBAC/审计 8 表；011 import_previews；013 system_settings（并重构 daily_quotes）；015 invite_codes；016 activity_settings；018 quiz_answers；021 AI 6 表。002/003/004/008/009/012/014/017/019/020/022 为加列、改列、索引与数据迁移。

## 7. 业务规则（模型层承载的幂等与并发语义）

- **唯一约束即幂等/并发兜底**（docstring 与 `ARCHITECTURE.md` §9.1）：
  - `uq_sport_user_date`：步数同日覆盖而非累加（`:232`）；
  - `uq_quiz_user_date`：每日仅一次答题，并发提交由唯一约束兜底（`:272`）；
  - `uq_dailyq_user_date`：同一天返回同一套题（`:291`）；
  - `uq_lit_user_node`：点亮后永久保留（`:256`）；
  - `uq_points_user_biz`：积分台账每人每来源每日一行（`biz_key` = `walk:{日期}` / `quiz:{日期}`），重算幂等（`:330`）；
  - `uq_quiz_answer_session_seq`：同会话同题号仅一条作答记录（`:310`）。
- **「一个 unionid 只属一个用户」无法用索引表达**（同一用户多渠道持有相同 unionid），由 identity_service 在事务内校验，冲突身份禁止自动合并（`UserIdentity` docstring `:386-389`）。
- **枚举/状态字段全库无 CHECK 约束**（`ARCHITECTURE.md` §13.2），均为 `VARCHAR` + 应用层常量：`users.status`（`:202-203`）、`daily_sport.source/sync_status`（`:236`、`:250`、`:252`）、`quiz_answers.status`（`:305`、`:325`）、`points_log.source_type`（`:330-332`、`:346`）、`bind_requests.status`（`:412`、`:427`）、`qr_login_sessions.status`（`:437`、`:445`）、`import_previews.status/biz_type`（`:524`、`:530-532`）、`ai_knowledge.status`（`:543`、`:565`）、`ai_conversations.status`（`:575`、`:585`）、`ai_generation_jobs.status`（`:613`、`:627`）、`ai_generated_questions.status`（`:637`、`:653`）、`ai_usage_logs.feature/status`（`:663-664`、`:677`、`:681`）。合法值以各 docstring 与 service 层常量为准。
- **派生缓存字段**：`User.continuous_days/max_continuous_days`（`:197-198`）由 streak_service 在 sport 写入链路维护，启动时按 daily_sport 全量重算兜底（docstring `:184-185`）。
- `quiz_records.details`（`:285-286`，014 新增）历史记录为 `None`，展示时回退 `wrong_list`。

## 8. 修改约束

- **不变量 8（表结构单一来源）**：改模型必须配套新增编号迁移（`docker/init/SQL_CONSTRAINTS.md` 为权威，已发布脚本不得修改），反之迁移加列也必须同步本文件；禁止由 FastAPI 启动流程 `create_all`。
- 新增模型需同步：`ARCHITECTURE.md` §13 表目录、`s21_opengauss_compat.py` 的 ORM 覆盖率校验、（如涉及种子）`data/seed.py`。
- 声明风格：SQLAlchemy 2.0 `Mapped[T] = mapped_column(...)`；唯一约束显式命名 `uq_xxx`、索引 `ix_xxx`（`backend/AGENTS.md` §5 与本文件既有惯例）。
- 新字段若面向小程序输出，必须核对 schemas 层 camelCase 契约（不变量 1）；面向管理后台则为 snake_case（`ARCHITECTURE.md` §4.2）。
- `Numeric` 三列的 `Mapped[float]` 注解是已登记技术债：不要单点「修正」注解或加类型转换器而不做回归——出口经 Pydantic 序列化，改动会影响 `latitude/longitude/distance` 三个字段的对外契约（`ARCHITECTURE.md` §16.1）。
- 引入 `relationship()` 需谨慎：现有 service 层全部手写查询/聚合，惰性加载关系易引入 N+1（编码质量原则，根 `agents.md` §2.4）。
- 死字段 `is_makeup`/`makeup_at`（`:248-249`）启用前必须先补迁移与业务写入点，不得假设存量数据有值。

## 9. 当前实现状态

- **已实现**：34/34 模型与开发库表列一致（s21 用例 C03、s26 真库校验 ORM 与真库列 ALL_MATCH，`ARCHITECTURE.md` §13 / §11.2）。
- **文档滞后 ①（勋章数量）**：`backend/AGENTS.md:39` 仍写种子为「勋章 6」，而 `data/seed.py` 实际 **12 枚**（其 docstring `:3` 自述「勋章定义(12)」，`MEDALS` 列表 `:282` 起实测 12 项；提交 `d0933fb` 2026-10-01「种子升级为12勋章」），开发库 `medal_defs` 亦为 12 行（`ARCHITECTURE.md` §13.3）。**以代码/数据库为准。** 更正说明：经逐行核对，本文件顶部 docstring（`:1-9`）本身不含勋章数量，「勋章 6」字样位于 `backend/AGENTS.md`，非本文件。
- **文档滞后 ②（本文件 docstring 分组口径）**：顶部 docstring（`:3-5`）只列出静态配置 3 个模型（RouteNode/Question/MedalDef）与用户业务 8 个模型，未含其后的 Person/PersonNode/DailyQuote/SystemSetting/ActivitySetting/Organization、InviteCode/UserEvent，以及 `:384`（身份/RBAC/审计/导入 9 个）与 `:539`（AI 6 个）两大分组；文件内分组注释是最新口径。
- **死字段**：`daily_sport.is_makeup`（`:248`）/ `makeup_at`（`:249`），docstring `:235` 自述「补签预留字段」；`005_upgrade.sql:31-36` 建列且 NOT NULL DEFAULT FALSE，但**全仓无业务写入点，开发库实测 0 行有值**——纯预留死字段（`ARCHITECTURE.md` §16.1 已查证）。
- **技术债**：`Numeric` 列 `Mapped[float]` 注解与运行时 `decimal.Decimal` 不符（§4.4），当前无业务影响。
- **已知风险**：逻辑外键无 DB 级约束（§4.7，开发库抽查 0 孤儿）；非自增主键 `max(id)+1` 分配无并发保护（`ARCHITECTURE.md` §16.1）。
- **待确认**：`ARCHITECTURE.md` §13.2「11 处逻辑外键」的精确列口径（本文档逐条枚举为 13 列，差异疑为是否计入 audit_logs / ai_usage_logs 列）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/models/models.py`（共 18 次提交）+ `docs/迭代记录.md`。按主题归并、时间倒序；每条引用的提交号均真实存在。

### 2026-10-17
- 需求：AI 智能中心 Phase A（提交 `1600074`）。
- 修改内容：新增 6 个 Ai* 模型（`:539-684`：AiKnowledge/AiConversation/AiMessage/AiGenerationJob/AiGeneratedQuestion/AiUsageLog，6 表 9 索引），对应 021/022 迁移。
- 关联文件：6 个 AI 服务、`routes/ai.py`、`routes/ai_admin.py`、`docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql`。
- 测试结果：冒烟 `s26_ai_center.py` 47/47（含真实 Agent 调用）；真库校验 ORM 与真库列 ALL_MATCH、JSON round-trip（`docs/迭代记录.md`）。

### 2026-10-15
- 需求：近 7 日步数补录结余积分与用户独立题目轮换（提交 `6f2cfc3`，019/020 迁移）。
- 修改内容：`DailySport` 新增 `source/synced_at/sync_status`（`:250-252`）；`Question` 新增 `active` 列（带索引，`:142`）。
- 关联文件：`services/sport_service.py`、`services/quiz_service.py`、`docker/init/019_sport_backfill_carry.sql`、`020_question_rotation.sql`。
- 测试结果：S22 专项 13/13、S18 限时答题回归 21/21、S20 V2 回归 25/25；当时本机 Docker 不可用、019/020 未在真库执行（迭代记录遗留项），此后开发库 `schema_migrations` 已登记 001→022 全部（`ARCHITECTURE.md` §16.1）。

### 2026-10-13
- 需求：答题逐题限时作答、积分台账重构、活动时间控制（同日三提交 `78a12ca`、`2f3f333`、`ce14a95`，对应 018/017/016 迁移）。
- 修改内容：新增 `QuizAnswer`（`:302-326`，(session_id, seq) 唯一）；`PointsLog` 重构——新增 `source_type/ref_id/biz_key` 与 `uq_points_user_biz`、`ix_points_log_source_user`（`:336-350`）；新增 `ActivitySetting`（`:108-123`）。
- 关联文件：`services/quiz_service.py`、`services/points_service.py`、`services/activity_service.py`、`docker/init/016/017/018` 迁移。
- 测试结果：s18 重写为限时作答用例 21/21；积分 SQLite 冒烟 20/20，openGauss 016/017 应用后回填 92 条步行 + 12 条答题、132 人 111 天核对差异 0、10 线程并发一致；活动准入 TestClient 冒烟通过、s19 回归 25/25（`docs/迭代记录.md`）。

### 2026-10-12
- 需求：答题提交后统一反馈与邀请码准入全链路（提交 `25c954c`、`afbcba9`，对应 014/015 迁移）。
- 修改内容：`QuizRecord` 新增 `details` JSON 列（`:285-286`，历史记录不回填）；新增 `InviteCode`（`:208-228`），`User` 新增 `status/invite_code_id/onboarded_at`（`:202-205`）。
- 关联文件：`services/quiz_service.py`、`services/invite_service.py`、`api/deps.py`（`_ensure_active`）、`docker/init/014/015` 迁移。
- 测试结果：S18 14/14（含 8 线程并发提交仅 1 次积分、伪造刷分拦截），迁移 014 已应用本地 openGauss；s19 25/25 + 真实 openGauss 并发 3/3（`docs/迭代记录.md`）。

### 2026-10-10 ~ 2026-10-11
- 需求：Excel 批量导入、每日寄语循环展示、热点查询性能优化（提交 `54ea125`、`d6acf7e`、`f59892e`，对应 011/013/012 迁移）。
- 修改内容：新增 `ImportPreview`（`:519-536`）；`DailyQuote` 重构——删除按日期唯一列、改 `sort_order/is_enabled` 循环展示并新增 `ix_daily_quotes_cycle`（`:88-95`），新增 `SystemSetting`（`:98-105`）；性能索引——`User.created_at`、`LitNode.lit_at` 加 `index=True`（`:199`、`:267`）、新增 `ix_user_event_user_type`（`:375`）。
- 关联文件：`services/import_service.py`、`services/quote_service.py`、`docker/init/011/012/013` 迁移、admin 导入弹窗组件。
- 测试结果：S12 11/11 + admin build（`54ea125`）；S17 13/13、S12 11/11、迁移 013 已应用 + 浏览器验收（`d6acf7e`）；012 已应用、e2e_full_flow 178/178、e2e_datasync 23/23、排行/播报与旧实现逐项一致（`f59892e`）。

### 2026-10-09
- 需求：微信身份关联与管理端 RBAC 建表（提交 `06b6313`，010 迁移）。
- 修改内容：新增 8 个模型（`:385-516`：UserIdentity/BindRequest/QrLoginSession/AdminMenu/AdminRole/AdminRoleMenu/AdminUserRole/AuditLog）。
- 关联文件：`docker/init/010_admin_identity.sql`、`services/access_service.py`/`identity_service.py`、`api/deps.py`（AdminPrincipal 改造，提交 `b431e4d`）。
- 测试结果：database-init 容器成功应用 010（建表 + 种子 INSERT 0 9/1/7）；ORM 与 app.main 导入正常（`docs/迭代记录.md`）。

### 2026-10-03 ~ 2026-10-04
- 需求：高级化功能 P1-8 / P2-1 / P2-2（提交 `2a178b7`、`71d1b9b`、`79004f1`，对应 006/007/008 迁移）。
- 修改内容：新增 `Person`/`PersonNode`（`:61-78`）；新增 `DailyQuote`（`:81-95`，初版按日期唯一，后被 `d6acf7e` 重构）；`User` 新增 `route_ceremony_at`（`:200-201`，完成仪式仅首次触发标记）。
- 关联文件：`routes/persons.py`、`routes/quotes.py`、`routes/march.py`、`docker/init/006/007/008` 迁移、小程序 person/ticket/ceremony 页。
- 测试结果：待确认（`docs/迭代记录.md` 对应条目未记录验证细节）。

### 2026-10-01
- 需求：数据模型扩展 005、昵称仅可修改一次、路线节点坐标配置（提交 `d0933fb`、`f820e0e`、`e8c6a09`，对应 005/004/002+003 迁移）。
- 修改内容：新增 `UserEvent`（`:365-381`），`User` 新增 `continuous_days/max_continuous_days`（`:197-198`），`RouteNode` 新增历史事件卡 7 字段（`:48-54`），`Question` 新增 `category`（`:141`），种子升级为 12 勋章（`d0933fb`）；`User` 新增 `original_nickname/nickname_changed_at`（`:195-196`，`f820e0e`）；`RouteNode` 新增 `latitude/longitude/sort_order/is_enabled` 且 id 改自增（`:42`、`:55-58`），`User.avatar` 改可空（`:193`），`QuizRecord` 新增 `answer_at` BigInteger（`:287`，`e8c6a09`）。
- 关联文件：`data/seed.py`、`services/event_service.py`/`streak_service.py`、`docker/init/002/003/004/005` 迁移。
- 测试结果：待确认（`docs/迭代记录.md` 对应条目未记录验证细节）。

### 2026-09-30
- 需求：项目初始化（提交 `a94e685`，对应 001 迁移）。
- 修改内容：文件创建，初始 11 个模型：RouteNode/Question/MedalDef/Organization/User/DailySport/LitNode/QuizRecord/DailyQuestion/PointsLog/UserMedal。
- 关联文件：`docker/init/001_schema.sql`、`core/database.py`、`data/seed.py`。
- 测试结果：待确认（初始提交，无测试记录）。
