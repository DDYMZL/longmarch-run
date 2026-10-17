# 010_admin_identity.sql

## 1. 文件路径

`docker/init/010_admin_identity.sql`（125 行）

## 2. 文件职责

「微信身份关联 + 管理后台 RBAC」建表迁移：一次性新建 8 张表——`user_identities` / `bind_requests` / `qr_login_sessions` / `admin_menus` / `admin_roles` / `admin_role_menus` / `admin_user_roles` / `audit_logs`（`:2-3` 头注释），并种入后台菜单骨架（9 个菜单码）、内置角色 `operator` 及其菜单授权。设计出处：`docs/identity-binding-design.md`（`:1` 注释）。

## 3. 业务需求

`06b6313`（2026-10-09）「微信身份关联迁移 010 建表（身份/绑定/扫码会话/RBAC/审计 8 表+菜单与内置角色种子），ORM 模型与配置同步；ADMIN_PASSWORD 取消默认值，未配置时账号登录禁用仅允许扫码登录」交付（`docs/迭代记录.md` 的 `06b6313` 条目）。业务场景：① 管理员用小程序扫码登录 PC 管理后台（qr_login_sessions）；② 微信 openid 与后台身份绑定（user_identities/bind_requests）；③ 菜单码粒度的角色授权（RBAC 四表，`.qoder/ARCHITECTURE.md` §5.3「RBAC 模型」段）；④ 管理操作审计（audit_logs）。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:4`）… `COMMIT`（`:125`）。

### 4.1 身份关联三表

- **`user_identities`**（`:6-18`）：`id SERIAL PK`；`user_id INTEGER NOT NULL REFERENCES users(id)`（真 FK）；`provider VARCHAR(32)`（wx_mini / wx_web，后者为半成品通道，`.qoder/ARCHITECTURE.md` §7「wx_web 半成品」段）；`app_id/openid VARCHAR(64) NOT NULL`、`unionid VARCHAR(64)` 可空——微信侧自然键，非本库引用；`verified_at` 可空；`created_at/updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`（本文件是**首批使用 DB 侧时间默认值**的迁移）。双唯一约束：`uq_identity_provider_openid (provider, app_id, openid)`（`:16`，一个微信身份只属一个用户）、`uq_identity_user_channel (user_id, provider, app_id)`（`:17`，一个用户每渠道只留一条）。索引 `ix_user_identities_user_id`、`ix_user_identities_unionid`（`:20-21`）。「同一 unionid 跨用户唯一」无法用索引表达，由 identity_service 事务内校验（`models.py:388-390` docstring）。
- **`bind_requests`**（`:23-36`）：绑定请求记录。`token_hash VARCHAR(64) NOT NULL` + 唯一索引 `uq_bind_requests_token_hash`（`:38`）——**只存 SHA-256 摘要，不存可重放明文**（`models.py:410`）；`user_id` 可空 FK（发起绑定的用户）；目标身份四元组（provider/app_id/openid/unionid）来自微信服务端；`status VARCHAR(16) NOT NULL DEFAULT 'pending'`（pending/confirmed/used/cancelled/expired，`models.py:412`）；`expires_at` NOT NULL、`used_at/confirmed_at` 可空。
- **`qr_login_sessions`**（`:40-50`）：PC 扫码登录会话。`id VARCHAR(24) PK`（qrId，轮询凭证，自然主键无序列）；`scene_token_hash VARCHAR(64) NOT NULL` + 唯一索引 `uq_qr_login_scene_hash`（`:52`，与小程序码 scene 凭证分离且只存摘要）；`status DEFAULT 'pending'`（pending/scanned/confirmed/failed/cancelled/expired）；`fail_reason VARCHAR(200)` 可空；`user_id` 可空 FK（确认登录的管理员）；`token_issued BOOLEAN NOT NULL DEFAULT FALSE`——保证管理员 JWT 仅签发一次、防轮询重放（`models.py:438`）。

### 4.2 RBAC 四表

- **`admin_menus`**（`:54-59`）：`id SERIAL PK`；`code VARCHAR(32) NOT NULL` + 唯一索引 `uq_admin_menus_code`（`:61`）——code 与后端 `require_menu(code)` 依赖一一对应（`models.py:457`）；`name VARCHAR(32)`；`sort_order INTEGER NOT NULL DEFAULT 0`。
- **`admin_roles`**（`:63-69`）：`code` 唯一索引 `uq_admin_roles_code`（`:71`）；`is_builtin BOOLEAN NOT NULL DEFAULT FALSE`（内置角色不可删除，`models.py:468`）。
- **`admin_role_menus`**（`:73-77`）：复合 PK `(role_id, menu_id)`，两列均真 FK。
- **`admin_user_roles`**（`:79-88`）：`user_id` 真 FK + 唯一约束 `uq_admin_user_role (user_id, role_id)`（`:87`）；`enabled BOOLEAN NOT NULL DEFAULT TRUE`（置 FALSE 即时生效，每请求查库，`models.py:489`）；`granted_by VARCHAR(64)` 可空（操作人昵称/标识，非 FK）；`granted_at/updated_at` DB 默认 CURRENT_TIMESTAMP；索引 `ix_admin_user_roles_user_id`（`:90`）。

### 4.3 审计表 `audit_logs`（`:92-103`）

`actor_type VARCHAR(16) NOT NULL`（super=配置超管 / user=微信关联管理员，`models.py:504`）；`actor_user_id`、`target_user_id` 均**无 FK**（逻辑外键，避免审计被用户删除阻塞）；`action VARCHAR(50) NOT NULL`；`detail TEXT` 可空；`created_at` DB 默认。索引 `ix_audit_logs_created_at`、`ix_audit_logs_target`（`:102-103`）。

### 4.4 种子数据（`:105-123`，只含权限骨架，无任何凭据）

- 9 个菜单码（`:106-115`）：dashboard/screen/rankings/route_nodes/questions/quotes/orgs/access/audit，`sort_order` 1–9（本文件内无重号）。
- 内置角色 `operator`「运营管理员」`is_builtin=TRUE`（`:118`）。
- operator 授权 7 个业务菜单（`:120-123`，`INSERT ... SELECT` 双表笛卡尔 + WHERE 过滤），**不含 access/audit**——这两项默认仅超级管理员可见，可由角色管理再授予（`:105` 注释）。
- **不种任何管理员账号/密码/openid/邀请码**：账号登录口令来自环境变量 `ADMIN_PASSWORD`（同批取消默认值，未配置时禁用账号登录仅允许扫码，见 `06b6313` 提交信息），身份数据全部运行期产生。本文档依约定不记录任何凭据值。

## 5. 输入与输出

- **输入（前置条件）**：001 已建 `users`（4 处 FK 目标：`:8`、`:26`、`:45`、`:81`）；文件内部建表顺序满足 FK 依赖（admin_roles/admin_menus 先于 admin_role_menus）。
- **输出**：8 张表 + 9 个索引/唯一索引 + 种子（9 菜单、1 角色、7 条角色-菜单授权）。
- **失败模式**：**种子 INSERT 非幂等**——重跑违反 `uq_admin_menus_code`/`uq_admin_roles_code`/`admin_role_menus` PK，事务整体回滚（正常由 `schema_migrations` 防重跑，`docker/init/init-db.sh:32-36`）。

## 6. 依赖关系

- 依赖：`001_schema.sql`（`users`）；设计文档 `docs/identity-binding-design.md`。
- 被依赖：ORM `backend/app/models/models.py:385-516`（8 个模型一一对应）；后端 `identity_service`/`access_service`/`audit` 写入链路与 `require_menu`/`get_current_admin` 鉴权依赖（`backend/app/api/deps.py`）；管理端 `admin/src` 菜单渲染与角色管理页；后续迁移 015（`invites` 菜单）、016（`activity` 菜单）、022（5 个 `ai_*` 菜单）在本表追加种子。

## 7. 业务规则

1. **权限粒度到菜单码**，无按钮级权限（`.qoder/ARCHITECTURE.md` §5.3「RBAC 模型」段）。
2. **凭证只存摘要**：`token_hash`/`scene_token_hash` 均为 SHA-256，库泄露不可重放（`models.py:410`）。
3. **JWT 单次签发**：`token_issued` 防扫码轮询重放（`:46`）。
4. access/audit 双菜单默认超管专属（`:105` 注释），内置 operator 角色刻意不含。
5. `admin_user_roles.enabled=FALSE` 即时回收权限（每请求查库，无缓存失效问题）。

## 8. 修改约束

1. **禁止修改本文件**（已在生产执行，`docker/init/SQL_CONSTRAINTS.md` §3.1）；新增菜单/角色一律走新编号迁移（015/016/022 已是先例）。
2. 9 个菜单 `code` 是后端 `require_menu` 与管理端路由权限码的硬契约，不得改名。
3. `sort_order` 追加新菜单时须避开既有值——已发生 015/016/022 与本文件之外种子的重号问题（`.qoder/PROJECT.md` §8「代码级技术债」第 26 项，用户决定只记录不修改）。
4. 时间列默认值采用 DB 侧 `CURRENT_TIMESTAMP`，与 001 的「无默认 + ORM 客户端默认」并存，是全库两套默认值写法的来源之一（`.qoder/ARCHITECTURE.md` §13.2）；改表时须核对 ORM 侧对应声明。

## 9. 当前实现状态

- **已实现**：8 表全部在用；扫码登录、身份绑定、RBAC、审计均已上线（010 批次及其后 access 管理迭代）。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` §1 逐项）**：
  - §1.1 不涉及（无 ALTER）；§1.3 合规（8 处 `CREATE TABLE IF NOT EXISTS`）。
  - §1.2 **风险**：9 处 `CREATE [UNIQUE] INDEX IF NOT EXISTS`（`:20-21`、`:38`、`:52`、`:61`、`:71`、`:90`、`:102-103`），生产版本按「不支持」处理时存在失败风险。
  - §1.4 合规：`:120-123` 的 `INSERT ... SELECT` 直接 FROM 两表，无派生表。
  - §1.5 合规：未用 `ON CONFLICT`（代价是种子非幂等，见下）。
  - §2.1 事务合规（`:4`/`:125`）；**§2.2 幂等违规**：三段种子 INSERT（`:106-115`、`:118`、`:120-123`）无 `WHERE NOT EXISTS` 防重，手工重跑必失败——§1.5 对 INSERT 的现行要求正是改用 `WHERE NOT EXISTS`；§2.3 合规（无删数据）。
  - §4 部分合规：`:1-3` 有主题与影响面（8 表清单），缺「回滚」段。
- **与 ORM 的差异**：结构完全一致（8 模型逐一核对 `models.py:385-516`），仅约束实现方式有别——DDL 用命名唯一**索引**（`uq_bind_requests_token_hash`、`uq_qr_login_scene_hash`），ORM 用列级 `unique=True`（`models.py:419`、`:444`）；`audit_logs.target_user_id` ORM `index=True` 的默认索引名与 DDL 的 `ix_audit_logs_target` 不同名。因禁用 `create_all`（`backend/AGENTS.md` §4.8），实际库以本 DDL 为准，差异无运行时影响。
- **种子重号核对（PROJECT §8 第 26 项）**：本文件 9 个菜单 `sort_order` 1–9 **无重号**；该项登记的重号（invites=10 vs ai_overview=10、activity=11 vs ai_knowledge=11）出自后续 `015`/`016`/`022` 的种子（022 的 `ai_overview`=10、`ai_knowledge`=11 已按 `022_ai_admin_menus.sql:15`/`:18` 核实），与本文件无关但叠加后生效——登记属实。
- **凭据检查**：文件内**无任何密码哈希、token、openid、邀请码种子**（结构见 §4.4），无需轮换处置；`ADMIN_PASSWORD` 环境变量侧的默认值已在同批取消（`06b6313` 提交信息）。
- **回滚方式**：文件内无回滚语句。手工回滚 = 按 FK 反序 `DROP TABLE admin_role_menus, admin_user_roles, admin_roles, admin_menus, audit_logs, qr_login_sessions, bind_requests, user_identities;`——**销毁全部授权、绑定与审计数据**，且 015/016/022 已在本表追加种子、后端鉴权链路会立即失效，生产不可回滚。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/010_admin_identity.sql`，共 **1 个提交**。

### 2026-10-09（`06b6313`，10:15）
- 需求：微信身份关联与管理后台 RBAC（`docs/identity-binding-design.md`）。
- 修改内容（涉本文件）：创建本文件，建 8 表（身份/绑定/扫码会话/菜单/角色/角色菜单/用户角色/审计）+ 菜单与内置角色种子。
- 关联文件：`backend/app/models/models.py`（8 模型）、`backend/app/core/config.py`（ADMIN_PASSWORD 取消默认值）、identity/access 服务与路由、管理端登录与授权页。
- 测试结果：见 `docs/迭代记录.md` 的 `06b6313` 条目。
