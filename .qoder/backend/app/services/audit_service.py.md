# audit_service.py

## 1. 文件路径
`backend/app/services/audit_service.py`（全文 36 行）

## 2. 文件职责
全后端**唯一**的审计日志写入入口：把「谁（actor）对谁（target）做了什么（action）、附什么详情（detail）」组装成一行 `AuditLog` 并 `db.add()` 到**调用方传入的会话**，**自身不 commit**。调用方在同一事务内完成业务变更与审计写入后统一提交，从而保证「业务变更 + 审计」原子落库（`backend/app/services/audit_service.py:1-5` 模块 docstring 即为此约定的权威表述）。

## 3. 业务需求
- 来源：微信身份关联与扫码登录改造「批次 2」。设计文档 `docs/identity-binding-design.md`（选型「小程序码扫码登录 + 完整 RBAC」，设计 8 张新表含 `audit_logs`，见 `docs/迭代记录.md` `852013f` 条目）；本文件与建表迁移 `docker/init/010_admin_identity.sql:92-103`（`audit_logs` 表 + `created_at`、`target_user_id` 两个索引）同批落地。
- 业务目的：管理端敏感写操作（角色/授权变更、活动发布、人员启停与改组织、积分台账修复、AI 配置与知识资料变更）必须可追溯，供管理后台「审计日志」页查询。
- 导航层：`.qoder/ARCHITECTURE.md` §9.4「事务边界（不统一，须知悉）」把本文件列为「路由/调用方提交」约定的代表例；§10.2「审计」给出端到端概览；`.qoder/REQUIREMENTS.md` §11.2 记录「审计日志查看 已实现」。**本文档只补文件级细节，不复述上述正文。**

## 4. 核心功能
本文件只有 **1 个公开函数**，无类、无私有函数、无常量。

### 4.1 `record(db, actor_type, actor_user_id, action, target_user_id, detail=None) -> None`（`backend/app/services/audit_service.py:14-36`）
执行两步，无分支之外的其它逻辑：

1. **detail 归一化**（`:23-27`）
   - `detail is None` → `detail_text = None`，落库为 `NULL`（`:23`）；
   - `detail` 是 `str` → **原样存入**，不做 JSON 包装（`:26` 的 `isinstance(detail, str)` 分支）；
   - 其它对象 → `json.dumps(detail, ensure_ascii=False)`（`:26`），中文不转义为 `\uXXXX`，便于管理端直接展示与人工排查。
2. **加入会话**（`:28-36`）
   - `db.add(AuditLog(actor_type=..., actor_user_id=..., action=..., target_user_id=..., detail=detail_text))`，5 个业务列全部由入参直接映射，无任何加工或校验；
   - `created_at` **不显式赋值**，由 ORM 列默认 `datetime.utcnow` 在 flush 时生成（`backend/app/models/models.py:516`），即库内为 **UTC naive**，与 `.qoder/ARCHITECTURE.md` §4.5 的时间约定一致。

### 4.2 刻意不做的事（读代码可直接确认）
- **无 `db.commit()` / `db.flush()` / `db.rollback()`**：全文 36 行内不存在任何事务控制语句（`:2-5` docstring 明示这是设计意图，不是遗漏）。
- **无入参校验**：不检查 `actor_type` 是否为 `super`/`user`、不检查 `action` 长度是否超列宽、不检查 `detail` 是否可 JSON 序列化（后果见 §9）。
- **无幂等/去重**：每次调用必写一行；同一业务动作重复提交会产生重复审计行（是否需要在调用方去重属调用方职责）。
- **不读取审计**：查询侧在 `backend/app/services/access_service.py:399-449`（`list_audit_logs`），不在本文件。

## 5. 输入与输出

### 5.1 入参（`:14-21`）
| 参数 | 类型注解 | 必填 | 落库列 | 实际取值口径 |
|---|---|---|---|---|
| `db` | `Session` | 是 | — | 调用方持有的会话（请求级 `Depends(get_db)`，或调用方自建） |
| `actor_type` | `str` | 是 | `audit_logs.actor_type` | 仅两种：`"super"`（配置账号超管）/ `"user"`（微信关联管理员）；常量定义在 `backend/app/services/access_service.py:41-42`，用户侧调用直接写字面量 `"user"` |
| `actor_user_id` | `Optional[int]` | 是（可传 `None`） | `actor_user_id` | `actor_type="super"` 时**恒为 `None`**（超管来自 env 配置、无 `users` 行）；`"user"` 时为管理员对应的 `users.id`。判定逻辑见 `backend/app/api/routes/admin.py:752-754`（`_actor`）与 `backend/app/api/routes/ai_admin.py:48-53`（`_audit`） |
| `action` | `str` | 是 | `action` | 点分动作码，全量清单见 §7.1 |
| `target_user_id` | `Optional[int]` | 是（可传 `None`） | `target_user_id` | 被操作人 id；对角色/活动/邀请码等非人员对象传 `None` |
| `detail` | `Optional[object] = None` | 否（默认 `None`） | `detail` | dict / 字符串 / `None`；见 §4.1 |

### 5.2 返回值与异常
- 返回 `None`（`:21`），调用方无法从返回值判断成功与否。
- **本函数体内不主动抛任何业务异常**。可能的运行期异常均来自下游：
  - `json.dumps` 遇到不可序列化对象抛 `TypeError`（`:26`，未捕获）；
  - `db.add` 本身不触库，但调用方后续 `commit()`/`flush()` 时若列宽超限或约束冲突会抛 SQLAlchemy 异常。
- 因此本函数**不产生 HTTP 错误码**；错误码由调用方路由决定（如 `backend/app/api/routes/ai_admin.py:113-115` 把 `ValueError` 转 400 并 `db.rollback()`，此时同一事务内的审计行一并回滚）。

### 5.3 落库表结构（`audit_logs`）
| 列 | ORM（`backend/app/models/models.py:503-516`） | DDL（`docker/init/010_admin_identity.sql:92-100`） | 说明 |
|---|---|---|---|
| `id` | `Mapped[int]` PK `autoincrement=True`（`:508`） | `SERIAL PRIMARY KEY`（`:93`） | 自增，本文件不干预 |
| `actor_type` | `String(16)` 非空（`:509`） | `VARCHAR(16) NOT NULL`（`:94`） | `super` / `user` |
| `actor_user_id` | `Integer` 可空（`:510`） | `INTEGER`（`:95`） | 超管为 NULL |
| `action` | `String(50)` 非空（`:511`） | `VARCHAR(50) NOT NULL`（`:96`） | 动作码 |
| `target_user_id` | `Integer` 可空 + `index=True`（`:512-514`） | `INTEGER`（`:97`）+ 索引 `ix_audit_logs_target`（`:103`） | 按被操作人查询 |
| `detail` | `Text` 可空（`:515`） | `TEXT`（`:98`） | JSON 字符串或纯文本 |
| `created_at` | `DateTime` 非空，默认 `datetime.utcnow` + `index=True`（`:516`） | `TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`（`:99`）+ 索引 `ix_audit_logs_created_at`（`:102`） | UTC naive；管理端按日期筛选时由 `access_service.py:412-418` 把本地日界换算为 UTC 区间 |

## 6. 依赖关系

### 6.1 本文件依赖（`:6-11`，共 3 个 import 语句）
| 依赖 | 用途 |
|---|---|
| 标准库 `json`（`:6`） | detail 序列化（`:26`） |
| 标准库 `typing.Optional`（`:7`） | 类型注解 |
| `sqlalchemy.orm.Session`（`:9`） | 类型注解 |
| `app.models.models.AuditLog`（`:11`） | 唯一 ORM 依赖 |

**不依赖** `app.core.config`、`app.core.database`、任何其它 service，也不 import FastAPI —— 位于 `backend/AGENTS.md` §3.1 分层图 `services -> models + core` 的最底层，无反向依赖、无循环依赖风险。

数据库表：仅写 `audit_logs`（读也不读）。第三方库：无（httpx / openpyxl 等一概不涉及）。

### 6.2 被谁依赖（全仓 grep `audit_service`，共 **9 个 backend/app 文件**）
| 调用方 | import 位置 | `record` 调用点 | 同事务 commit 位置 |
|---|---|---|---|
| `backend/app/services/access_service.py` | `:25` | `:242`、`:294`、`:312`、`:346`、`:353`、`:364`、`:387` | `:245`、`:297`、`:319`、`:368`、`:395` |
| `backend/app/services/activity_service.py` | `:18` | `:182`、`:199` | `:186`、`:203` |
| `backend/app/services/auth_service.py` | `:19` | `:139`（在 `db.flush()` 之后、`IntegrityError` 兜底之前） | `:143` |
| `backend/app/services/identity_service.py` | `:20` | `:117`、`:228`、`:259` | `:118`、`:236`、`:260` |
| `backend/app/services/invite_service.py` | `:17` | `:188`、`:210`、`:234` | `:192`、`:214`、`:239` |
| `backend/app/services/org_service.py` | `:13` | `:137` | `:147` |
| `backend/app/api/routes/admin.py` | `:86` | `:339`（`POST /api/admin/points/verify`，仅 `fix=True` 时写） | `:343` |
| `backend/app/api/routes/ai_admin.py` | `:40` | 经本文件私有包装 `_audit`（`:48-53`）间接调用，调用点 `:111`、`:147`、`:170`、`:191`、`:328-333`、`:376` | `:112`、`:148`、`:171`、`:192`、`:334`、`:377` |

**注意分层例外**：`routes/admin.py` 与 `routes/ai_admin.py` 是**路由层直接 import 本 service**（而非经由某个业务 service）。这与 `backend/AGENTS.md` §3.1「routes 层只做参数接收/调用 service/异常转换」不冲突（写审计不是业务规则），但意味着「谁 commit」必须在路由内自行保证——两处均已在 `record` 之后显式 `db.commit()`。

**未使用本文件的写操作（事实陈述）**：`backend/app/services/admin_service.py` 全文没有 `audit_service` 引用，因此路线节点、题库、组织架构（含 `sync_orgs`）的管理端写操作**当前不写审计**；`backend/app/services/quote_service.py` 的寄语增删改同样不写审计。是否属于遗漏 —— 待确认。

### 6.3 读取侧（不属于本文件，仅列出以免误改）
`backend/app/services/access_service.py:399-449` `list_audit_logs(db, page, page_size, action, actor_type, date)`：按 action / actor_type / 本地日期筛选，`order_by(AuditLog.id.desc())` 分页，批量解析操作人与目标昵称避免 N+1，`actor_type == "super"` 时 `actor_name` 固定显示「超级管理员」（`:441`）。对应路由 `GET /api/admin/audit-logs`（菜单码 `audit`，见 `backend/app/services/access_service.py:36`）。

## 7. 业务规则

### 7.1 action 码全量清单（全仓 grep `audit_service.record` 与 `_audit(db, admin, ...)` 得出，共 **26 个**）
| 域 | action 码 | 写入点 |
|---|---|---|
| RBAC | `access.role.create` / `access.role.update` / `access.role.delete` | `access_service.py:243` / `:295` / `:313` |
| RBAC | `access.roles.grant` / `access.roles.revoke` / `access.role.enable` / `access.role.disable` | `access_service.py:347`、`:365`、`:354`、`:391`（enable/disable 由 `is_enabled` 三元决定） |
| 活动 | `activity.update` / `activity.publish` / `activity.unpublish` | `activity_service.py:183`、`:200` |
| 人员 | `user.onboard` / `user.enable` / `user.disable` / `user.org_change` | `auth_service.py:140`、`invite_service.py:236`、`org_service.py:138` |
| 身份 | `admin.login.qr` / `identity.bind.confirm` / `identity.unbind` | `identity_service.py:117`、`:232`、`:259` |
| 邀请码 | `invite.create` / `invite.update` | `invite_service.py:189`、`:211` |
| 积分 | `points.recompute` | `routes/admin.py:340` |
| AI | `ai.knowledge.create` / `.update` / `.status` / `.delete` / `ai.config.patch` / `ai.draft.import` | `routes/ai_admin.py:111`、`:147`、`:170`、`:191`、`:376`、`:331` |

> `.qoder/ARCHITECTURE.md` §10.2 记载管理端 `admin/src/views/AuditView.vue` 用 `ACTION_TEXT` **20 项**映射把 action 码翻译成中文。后端现有 **26 个** action 码，两者差额与具体未覆盖项属管理端文档范围 —— 待确认（本次未核对 `AuditView.vue`）。

### 7.2 事务与原子性
- **审计与业务变更必须同事务**：这是本文件存在的唯一理由（`:2-5`）。所有 9 个调用方均遵守「先改业务对象 → `record()` → `commit()`」顺序，失败路径 `rollback()` 会把审计行一起撤销（例：`routes/ai_admin.py:113-115`）。
- **`auth_service.py:137-149` 是唯一在 `record` 前显式 `db.flush()` 的调用方**：因为要先拿到新用户 id 才能写 `actor_user_id`/`target_user_id`；`IntegrityError` 时 `rollback()` 并走「已存在用户续登」分支（`:144-149`），此时审计行不落库。
- **会话配置放大了「忘 commit」的后果**：`SessionLocal` 为 `autoflush=False, autocommit=False`（`backend/app/core/database.py:51`），`get_db()` 在 `finally` 中 `db.close()`（`:58-64`）。调用方若漏掉 `commit()`，审计行**静默丢失**且无任何报错。

### 7.3 actor 判定规则
- 超管（`typ=super` 令牌，来自 env `ADMIN_USERNAME`/`ADMIN_PASSWORD` 账号登录）→ `("super", None)`；微信关联管理员（`typ=user`）→ `("user", user_id)`。两处等价实现：`routes/admin.py:752-754`、`routes/ai_admin.py:49-50`（**代码重复**，见 §9）。
- `operator`（管理员用户名字符串）**不进列**，而是塞进 `detail` JSON（如 `routes/admin.py:341`、`routes/ai_admin.py:52`、`activity_service.py:184`、`org_service.py:140`）。原因：超管无 `users` 行，`actor_user_id` 为 NULL 时仍需可读的操作人标识。

### 7.4 时间与筛选
`created_at` 存 UTC naive；管理端「按日期筛选」传入的是本地日期字符串，由 `access_service.py:412-418` 用 `local_to_utc` 换算成 `[start, start+1day)` 的 UTC 区间。本文件只负责写，不参与该换算。

## 8. 修改约束
1. **禁止在本函数内加 `db.commit()` / `db.flush()`**：会破坏「变更 + 审计」同事务原子性（`:2-5` 明示约定，`.qoder/ARCHITECTURE.md` §9.4 亦以此为「路由层提交」约定的样例）。若确需 flush，应由调用方自行处理（参照 `auth_service.py:138`）。
2. **新增 action 码时须同步管理端中文映射**：`admin/src/views/AuditView.vue` 的 `ACTION_TEXT`（`.qoder/ARCHITECTURE.md` §10.2）。否则审计页显示原始英文码。按根 `agents.md` §1.5，跨端变更应在同一提交内并说明范围。
3. **`actor_type` 只能是 `super` / `user`**：读取侧 `access_service.py:441` 用 `actor_type == ACTOR_SUPER` 判定显示名，新增第三种取值会让审计页显示空操作人。
4. **列宽硬约束**：`actor_type ≤ 16`、`action ≤ 50`（`models.py:509`/`:511`，DDL `010_admin_identity.sql:94`/`:96`）。本函数不做长度校验，超长会在调用方 `commit()` 时抛数据库错误 → 500。
5. **`detail` 必须是可 JSON 序列化对象或字符串**：本函数不捕获 `TypeError`。含 `datetime`/`Decimal`/ORM 对象的 dict 会直接抛错（注意 `.qoder/PROJECT.md` §8 技术债 #28：`Numeric` 列运行期返回 `decimal.Decimal`，**不可直接放进 detail**）。
6. **不得改为异步/后台写审计**：会脱离调用方事务，违反 §7.2。
7. **迁移约束**：`audit_logs` 结构由 `docker/init/010_admin_identity.sql` 定义，改动须新增递增编号迁移并遵守 `docker/init/SQL_CONSTRAINTS.md`，**禁止修改已在生产执行过的 010**（根 `agents.md` §1.7、`.qoder/README.md` §3.7）。
8. **敏感信息**：`detail` 会明文落库并可被管理端读取，**禁止写入** token、密码、AppSecret、完整 openid/unionid。现状：`identity_service.py:234` 只写 `provider` 与 `app_id`，不写 openid/unionid；`010_admin_identity.sql` 与 `docs/identity-binding-design.md` 亦记录「凭证只存摘要」。新增调用点须保持同一口径（`.qoder/README.md` §3.14）。

## 9. 当前实现状态

**已实现**
- 单一 `record` 函数 + 「不提交、调用方统一 commit」约定，9 个调用方全部遵守（逐个核对 commit 行号，见 §6.2 表）。
- detail 三态归一化（`None` / `str` / JSON），中文不转义（`:26`）。
- 覆盖 26 个 action 码、7 个业务域（RBAC、活动、人员、身份、邀请码、积分、AI）。

**存在的问题（均为代码级事实，附依据）**
1. **无入参校验，超长/非法值延迟到 commit 才炸**：`action > 50` 字符或 `actor_type > 16` 字符时，`record` 静默通过，错误在调用方 `commit()` 处以数据库异常形式暴露为 500（依据：`:28-36` 无校验；列宽见 `models.py:509`/`:511`）。
2. **`json.dumps` 的 `TypeError` 未捕获**（`:26`）：detail 含不可序列化对象时直接抛出，且此时业务对象已被修改但事务未提交，调用方是否有 `rollback()` 取决于各自实现（`routes/ai_admin.py:114` 有；`access_service.py:245` 附近无 try/except）。
3. **actor 判定逻辑重复两份**：`routes/admin.py:752-754` 的 `_actor` 与 `routes/ai_admin.py:48-53` 的 `_audit` 各自实现同一套 `is_super → ("super", None)` 三元判定，未下沉到本文件。按根 `agents.md` §2.2「重复出现的相似逻辑应抽取公共实现」，属可收敛点（当前仅两处、逻辑简单，是否抽取待确认）。
4. **审计覆盖不完整**：`admin_service.py`（路线节点/题库/组织架构 CRUD 与 `sync_orgs`）与 `quote_service.py`（寄语增删改）**均不写审计**（全仓 grep 确认二者无 `audit_service` 引用）。这些同样是管理端写操作。是否为有意取舍 —— 待确认。
5. **后端 26 个 action 码 vs 管理端 `ACTION_TEXT` 20 项映射**（`.qoder/ARCHITECTURE.md` §10.2）存在数量差；具体缺哪几项未核对 —— 待确认。

**待开发**：无（本文件功能完整，无 TODO / 占位分支）。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/audit_service.py`（**仅 1 个提交**，`git log --diff-filter=A` 确认该提交即创建提交）与 `docs/迭代记录.md` 对应条目。本文件自 2026-10-09 创建以来**未再被修改**。

### 2026-10-09
- 需求：微信扫码登录与身份关联（批次 2）——管理端写操作需可追溯，配套 RBAC 与审计日志。
- 修改内容：`b431e4d` 新建本文件（36 行），提供 `record()`：detail 三态归一化（`None`/字符串/`json.dumps(..., ensure_ascii=False)`）+ `db.add(AuditLog(...))`，**只入会话不提交**，由调用方在同一事务内统一 commit（`:1-5` docstring 确立该约定）。同批建表迁移 `docker/init/010_admin_identity.sql:92-103`。提交内容为：小程序码扫码会话（创建/轮询/确认/取消/令牌单次签发）、绑定确认事务（凭证只存摘要、openid/unionid 冲突拒绝合并）、身份列表与解绑（wx_mini 主身份禁解绑）、登录同步采集 unionid、管理员令牌 `typ` 区分超管/关联管理员 + `get_current_admin` 每请求查库校验（撤销即时生效）、登录/扫码/轮询限流；新增 `/auth/qr/*`、`/auth/identities*`、`/admin/wechat/qr*`、`/admin/me`。
- 关联文件：`backend/app/services/identity_service.py`（`:117`、`:228`、`:259`）、`backend/app/services/auth_service.py`（`:139`）、`backend/app/api/routes/admin.py`、`backend/app/api/routes/ai_admin.py`、`backend/app/models/models.py:503-516`、`docker/init/010_admin_identity.sql`。
- 测试结果：S8 集成测试 **23/23 通过**（`backend/test/s8_identity_admin.py`，报告 `backend/test/docs/s8-identity-admin.md`）——原文见 `docs/迭代记录.md` `b431e4d` 条目「验证」字段。

### 后续间接扩展（未改动本文件，仅新增调用点，供追溯）
以下提交向本文件既有的 `record()` 增加了新的 action 码，`git log --follow` 不含它们（本文件内容零变更），故只作索引，验证结论以 `docs/迭代记录.md` 对应条目为准：

| 日期 | 提交 | 新增 action 域 | `docs/迭代记录.md` 记载的验证 |
|---|---|---|---|
| 2026-10-13 | `ce14a95` | `activity.update` / `activity.publish` / `activity.unpublish`（`activity_service.py:182`、`:199`） | 见该条目「验证」字段（本次未逐字摘录 —— 待确认） |
| 2026-10-13 | `2f3f333` | `points.recompute`（`routes/admin.py:339`） | 「SQLite 冒烟 20/20…篡改后核对能发现并修复」等，见该条目 |
| 2026-10-13 | `e197a28` | 人员改组织审计 `user.org_change`（`org_service.py:137`）+ 审计动作中文化（管理端） | 「`npm run build` 通过；浏览器验收 V01–V08、R01–R08、O01–O03、U01–U02、M01 全部 PASS；s20 25/25」 |
| 2026-10-09 | `06b6313` 之后的 RBAC 提交 | `access.*` 7 个码（`access_service.py:242`–`:394`） | 「S9 集成测试 30/30 通过（`backend/test/s9_rbac_access.py`，报告 `backend/test/docs/s9-rbac-access.md`），S8 复测 23/23 回归通过」 |
| 2026-10-17 | `1600074` | `ai.knowledge.*` 4 个 + `ai.config.patch` + `ai.draft.import`（`routes/ai_admin.py`） | 「冒烟 `test/s26_ai_center.py` 47/47（含真实 Agent 调用）；真库校验迁移/表索引/ORM 列 ALL_MATCH」（转引自 `.qoder/backend/app/core/config.py.md` §10 同日条目） |
