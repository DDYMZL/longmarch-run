# 015_invite_admission.sql

## 1. 文件路径

`docker/init/015_invite_admission.sql`（42 行）

## 2. 文件职责

「邀请码准入」全链路的结构迁移（`:3-6` 头注释）：① 新建 `invite_codes` 表（PC 后台生成的入驻邀请码，`:7-21`）；② 给 `users` 加准入三列 `status`/`invite_code_id`/`onboarded_at` 并回填存量用户（`:25-29`）；③ 种入 `invites` 后台菜单并授权内置 `operator` 角色（`:31-40`）。首次入驻必须持有效邀请码，`/auth/login` 不再自动建号（`:4` 注释）。

## 3. 业务需求

`afbcba9`（2026-10-12）「邀请码准入全链路（后端迁移/服务/路由/测试、admin 邀请码管理与账号启停、小程序扫码准入与入驻信息收集）」交付（`docs/迭代记录.md` 的 `afbcba9` 条目）。需求出处：`.qoder/REQUIREMENTS.md` §2.2「入驻与邀请码」。业务规则（`:5-6` 注释）：`invite_codes.code` 即小程序码 scene 参数（`i=<code>`，scene 上限 32 字符）；`org_id` 非空时入驻仅允许选择该组织及其下级；`max_uses` 为空不限次数；时间均为 UTC。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:42`）；注释在事务内（`:3-6`、`:23-24`），缺「回滚」段。

### 4.1 建表 `invite_codes`（`:7-20`）

| 列 | 类型/约束 | 业务含义 |
|---|---|---|
| `id` | `SERIAL` PRIMARY KEY | 自增主键 |
| `code` | `VARCHAR(32)` NOT NULL + 唯一索引 `uq_invite_codes_code`（`:21`） | 邀请码明文（运行期由 `invite_service.generate_code` 随机生成，`invite_service.py:32-33`；**本文件不种任何码值**），兼作小程序码 scene 参数 |
| `name` | `VARCHAR(64)` NOT NULL | 用途名称（如批次/渠道） |
| `remark` | `VARCHAR(200)` 可空 | 备注 |
| `org_id` | `INTEGER` 可空，**无 REFERENCES** | 组织范围限定（逻辑外键 → `organizations.id`，`.qoder/ARCHITECTURE.md` §13.2「13 处逻辑外键」条）；非空时入驻只能选该组织及其下级（`invite_service.ensure_org_in_scope`，`invite_service.py:73-74`） |
| `max_uses` | `INTEGER` 可空 | 可用次数上限，NULL 不限 |
| `used_count` | `INTEGER` NOT NULL DEFAULT 0 | 已用次数，仅由条件 UPDATE 原子递增（见 §7 规则 2） |
| `expires_at` | `TIMESTAMP` 可空 | 过期时间（UTC），NULL 不过期 |
| `is_enabled` | `BOOLEAN` NOT NULL DEFAULT TRUE | 停用开关 |
| `created_by` | `VARCHAR(64)` 可空 | 创建管理员标识（非 FK） |
| `created_at`/`updated_at` | `TIMESTAMP` NOT NULL DEFAULT CURRENT_TIMESTAMP | DB 侧时间默认值 |

### 4.2 `users` 加准入三列并回填（`:25-29`）

- `:25` `status VARCHAR(16) NOT NULL DEFAULT 'active'`——active 正常 / disabled 停用（禁止访问受保护接口，`:23` 注释）；
- `:26` `invite_code_id INTEGER` 可空（逻辑外键 → `invite_codes.id`，无 REFERENCES）——为空即「015 之前的历史用户」（`:24` 注释、`models.py:202`）；
- `:27` `onboarded_at TIMESTAMP` 可空；`:28` `UPDATE users SET onboarded_at = created_at WHERE onboarded_at IS NULL`——存量用户（含历史自动建号用户）全部保留并回填（`:24` 注释），WHERE 收敛、幂等（§2.2/§2.4 合规）；
- `:29` `CREATE INDEX IF NOT EXISTS ix_users_invite_code_id`。

### 4.3 菜单种子（`:31-40`）

- `:31-33`：INSERT `admin_menus` (`invites`,「入驻邀请码」, `sort_order=10`)，`WHERE NOT EXISTS` 防重（§1.5 推荐写法，幂等）。
- `:35-40`：INSERT `admin_role_menus`，把 `invites` 菜单授予内置 `operator` 角色（`admin_roles.code='operator'` × `admin_menus.code='invites'` 双表 SELECT + `WHERE NOT EXISTS`），幂等。**与 016 不同：本菜单默认对 operator 可见**（010 建 RBAC 骨架、022 建 AI 菜单，见 §7 规则 4）。

## 5. 输入与输出

- **输入（前置条件）**：`001_schema.sql`（`users`）、`010_admin_identity.sql`（`admin_menus`/`admin_roles`/`admin_role_menus` 及其唯一约束）。
- **输出**：1 张新表 + 1 个唯一索引；`users` 加 3 列 + 1 个索引 + 存量行 `onboarded_at` 回填；`admin_menus` 1 行、`admin_role_menus` 1 行种子（仅权限骨架，无凭据）。
- **失败模式**：全部语句带 `IF [NOT] EXISTS`/`WHERE NOT EXISTS`/收敛 WHERE，**语义上可重跑**；但在生产老版本 openGauss 上首跑会在 `:25` 因 §1.1 禁用语法失败（见 §9）。

## 6. 依赖关系

- 依赖：`001`（`users`）、`010`（RBAC 三表；`operator` 角色与 `uq_admin_menus_code`）。
- 被依赖：
  - ORM：`InviteCode`（`models.py:208-228`）、`User.status/invite_code_id/onboarded_at`（`models.py:203-205`）。
  - 服务：`backend/app/services/invite_service.py`（校验 `_check_usable` `:41-50`、原子核销 `consume` `:77-91`、组织范围 `ensure_org_in_scope` `:73-74`、`user_scope_org` `:93-100`、管理端列表 `list_invites` `:149-164`）；`backend/app/services/access_service.py`（用户列表按 `status` 过滤与输出，`:117-118`、`:175-178`）；`backend/app/services/auth_service.py`（`onboard` 入驻建号 `:92`）。
  - 路由：`backend/app/api/routes/auth.py`（`/auth/invite/verify` `:47`、`/auth/onboard` `:63`）；`backend/app/api/routes/admin.py`（邀请码管理与账号启停，`require_menu("invites")` `:834`、`:848`、`:868`、`:889`）。
  - 鉴权依赖：`backend/app/api/deps.py` 对 `status='disabled'` 用户返回 403 + `X-Account-Status: disabled` 头（`:47-52`），小程序据此清会话（`.qoder/ARCHITECTURE.md` §14 不变量 5）。
  - 后续迁移：`022_ai_admin_menus.sql` 在同表追加 `ai_*` 菜单（与本文件 `sort_order` 撞号，见 §7 规则 4）。

## 7. 业务规则

1. **准入状态机**：`users.status` 仅 active/disabled 两态（无 CHECK 约束，应用层常量）；disabled 即时断权（每请求查库，无缓存失效问题）。
2. **核销原子性**：`invite_service.consume`（`:77-91`）用条件 UPDATE（`is_enabled=TRUE` 且未用满且未过期才 `used_count+1`）原子核销，并发入驻不会超额——openGauss 不支持 `ON CONFLICT`（`SQL_CONSTRAINTS.md` §1.5）下的标准替代手法，DDL 与实现一致。
3. **历史用户豁免**：`invite_code_id IS NULL` = 015 之前的存量用户，保留且回填 `active`/`onboarded_at=created_at`（`:24` 注释、`:28`）。
4. **`sort_order` 重号（已知问题，只记录不修改）**：`:32` 的 `invites=10` 与 `022_ai_admin_menus.sql:15` 的 `ai_overview=10` 冲突，登记于 `.qoder/PROJECT.md` §8「代码级技术债」第 26 项与 `.qoder/ARCHITECTURE.md` §13.4；2026-10-17 经用户决定**只记录不修改**（菜单排序不稳定，不阻塞功能）。
5. `code` 一旦生成不变更（小程序码已印刷/分发的场景），停用走 `is_enabled`/`expires_at`。

## 8. 修改约束

1. **禁止修改本文件**（`SQL_CONSTRAINTS.md` §3.1）。是否已在生产 `schema_migrations` 登记：待确认（本次建档禁止连库）；按功能上线时间（2026-10-12）推定已执行。
2. `status`/`invite_code_id`/`onboarded_at` 三列名是后端鉴权与 admin 用户管理的硬契约；`invites` 菜单码是 `require_menu("invites")` 的硬契约，均不得改名。
3. `sort_order=10` 的重号问题**不要**通过修改本文件解决（已锁定 + 用户已决定只记录）；如未来要修，走新编号迁移统一重排。
4. `invite_codes.org_id`、`users.invite_code_id` 刻意不加 FK（逻辑外键，便于数据修复，`.qoder/ARCHITECTURE.md` §13.2）——补 FK 属架构变更，需先过决策记录。

## 9. 当前实现状态

- **已实现**：邀请码生成/校验/核销、扫码准入、账号启停、入驻信息收集全链路已上线（`afbcba9` 批次）。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md`）**：
  - §1.1 **违规 3 处**（`:25`、`:26`、`:27` `ADD COLUMN IF NOT EXISTS`）：生产老版本不支持（2026-10-16 事故根因）。已列入 `.qoder/ARCHITECTURE.md` §12.4「历史包袱」清单（015=3 处，实测复核一致）。
  - §1.2 谨慎项 2 处（`:21` `CREATE UNIQUE INDEX IF NOT EXISTS`、`:29` `CREATE INDEX IF NOT EXISTS`）；§1.3 合规（`:7`）。
  - §1.4 合规（`:35-40` 直接 FROM 两表，无派生表）；§1.5 合规（种子均 `WHERE NOT EXISTS`，未用 `ON CONFLICT`）。
  - §2.1 事务合规（`:1`/`:42`）；§2.2 幂等合规（除 §1.1 语法问题外语义可重跑）；§2.3 合规（无删数据，回填带收敛 WHERE）。
  - §4 部分合规：`:3-6`/`:23-24` 有目的/影响面，缺「回滚」段。
- **与 ORM 的差异**：
  1. `code` 唯一性：DDL 用命名唯一**索引** `uq_invite_codes_code`（`:21`），ORM 用列级 `unique=True`（`models.py:218`）——与 010 同一模式，实际库以 DDL 为准。
  2. `users.invite_code_id` 索引：ORM `index=True`（`models.py:204`）默认名即 `ix_users_invite_code_id`，与 `:29` 同名，一致。
  3. `status`：ORM `Mapped[str]` 非 Optional → NOT NULL + 客户端 `default="active"`（`models.py:203`），DDL 侧另有 `DEFAULT 'active'`（`:25`），双默认值并存（`.qoder/ARCHITECTURE.md` §13.2）。
  4. `created_at`/`updated_at`：DDL `CURRENT_TIMESTAMP` vs ORM `datetime.utcnow` 客户端默认（`models.py:227-228`）。
- **敏感数据检查**：文件内**无任何邀请码种子、口令、openid**——邀请码全部运行期随机生成（`invite_service.py:33-34`），无需轮换处置。
- **回滚方式**：文件内无回滚语句。手工回滚 = 删两行菜单种子、`ALTER TABLE users DROP COLUMN status, DROP COLUMN invite_code_id, DROP COLUMN onboarded_at;`、`DROP TABLE invite_codes;`——将销毁全部邀请码与准入状态，且 `deps.py` 断权链路、`/auth/onboard`、admin 邀请码页立即报 UndefinedColumn，**生产不可回滚**。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/015_invite_admission.sql`，共 **1 个提交**。

### 2026-10-12（`afbcba9`，14:49）
- 需求：入驻与邀请码准入（`.qoder/REQUIREMENTS.md` §2.2「入驻与邀请码」）。
- 修改内容（涉本文件）：新建本文件；建 `invite_codes` 表与唯一索引；`users` 加 `status`/`invite_code_id`/`onboarded_at` 并回填；种入 `invites` 菜单并授权 `operator`。
- 关联文件：`backend/app/models/models.py`（`InviteCode`/`User`）、`invite_service.py`、`access_service.py`、`auth_service.py`、`api/routes/auth.py`、`api/routes/admin.py`、`api/deps.py`、admin 邀请码管理与账号启停页、小程序扫码准入与入驻信息收集。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目。
