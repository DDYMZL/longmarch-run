# access_service.py

## 1. 文件路径
`backend/app/services/access_service.py`

## 2. 文件职责
管理后台的**访问授权服务（RBAC）**：把「用户 → 启用角色 → 菜单码并集」翻译成鉴权主体，并承载人员授权列表、角色 CRUD、用户角色授权变更与审计日志查询。本文件**不解析令牌、不抛 HTTP 异常**——令牌解析与 401/403 由 `backend/app/api/deps.py` 负责，本服务只回答「这个用户有没有后台权限、有哪些菜单码」，以及执行授权侧的写操作（业务失败抛 `ValueError`，由路由转 400/404）。

## 3. 业务需求
- **权威设计出处**：`docs/identity-binding-design.md`（v1，2026-10-09）——§2「后台授权采用完整 RBAC（角色 + 菜单权限）」、§3.4 RBAC 四表、§3.5 `audit_logs`、§4.2 PC 管理侧接口与「菜单码 ↔ 接口组」映射表、§5.3 权限撤销/账号禁用即时生效、§6.5 审计范围。本文档只描述实现现状并回指该文件，不复述其正文。
- **需求清单**：`.qoder/REQUIREMENTS.md` §11.1（菜单与权限）、§11.2（人员管理）。
- **架构定位**：`.qoder/ARCHITECTURE.md` §5.3（管理端鉴权链）、§9.4（事务边界）、§10.2（审计）。
- **交付批次**：`b431e4d`（2026-10-09）创建本文件（微信扫码登录批次 2）；`4bf9acd`（2026-10-09）落地 `/admin/users|roles|audit-logs` 三组接口与 `require_menu` 挂载（批次 3）。

## 4. 核心功能

### 4.1 授权模型（`backend/app/services/access_service.py:1-5` 模块 docstring）
- 微信关联管理员：**至少拥有 1 个启用角色**即可访问后台；可见菜单 = 其全部启用角色的菜单码**并集**。
- 超级管理员（账号密码登录，`typ=super`）**不走角色体系**，拥有全部菜单——该分支在 `backend/app/api/deps.py:127-129` 直接短路，**不进入本文件**。
- 「启用」的判定字段是 `admin_user_roles.enabled`（`backend/app/models/models.py:497`），**不是角色自身的开关**——`admin_roles` 表没有 enabled 列（`backend/app/models/models.py:467-476` 仅 id/code/name/is_builtin/created_at）。

### 4.2 鉴权主体构建（读路径，每请求执行）
| 函数 | 行号 | 说明 |
|---|---|---|
| `get_enabled_roles(db, user_id)` | `:45-52` | `admin_roles` JOIN `admin_user_roles`，过滤 `user_id` + `enabled IS TRUE`（`:50`）；返回 `List[AdminRole]`。**无 order_by**，顺序由数据库决定 |
| `get_menu_codes(db, role_ids)` | `:55-66` | 空列表直接返回 `[]`（`:57-58`）；否则 `admin_menus.code` JOIN `admin_role_menus` 过滤 `role_id IN (...)`，按 `sort_order` 排序（`:63`） |
| `get_menu_items(db, codes)` | `:69-75` | 按传入 `codes` 顺序返回 `[{code, name}]`；一次查询建 code→row 映射（`:73-74`），**保持传入顺序**且跳过库中不存在的码（`:75`） |
| `get_all_menu_items(db)` | `:78-81` | 全部菜单（超管可见集合），按 `sort_order` 排序（`:80`） |
| `build_principal(db, user)` | `:84-98` | 无启用角色 → **返回 `None`（拒绝访问）**（`:89-91`）；否则返回 `{is_super: False, username: user.nickname, user_id, roles: [code], menus: [code]}`（`:92-98`） |

`build_principal` 返回的 `username` 取的是**用户昵称**（`:94`），超管分支的用户名则来自 JWT 的 `sub`（`backend/app/api/deps.py:129`）——两条路径的 `username` 语义不同。

### 4.3 人员授权列表（`list_users`，`:102-182`）
- 筛选：`keyword`（昵称模糊，`:113-114`，`icontains(..., autoescape=True)` 转义 `%`/`_`）、`org_id`（`:115-116`）、`status`（`:117-118`）、`has_access`（`:119-125`，用 `admin_user_roles.enabled IS TRUE` 的子查询做 `IN` / `NOT IN`）。
- 分页：`count()`（`:126`）+ `order_by(User.id.desc()).offset().limit()`（`:127-132`）。
- **反 N+1**：当前页 `user_ids` 一次取全部角色行（`:136-148`）、一次取组织名（`:154-159`）、一次取邀请码名（`:160-165`），共 5 条 SQL/页（count + 用户页 + 3 张关联表）。
- `has_access` 输出 = `any(r["enabled"] for r in roles_by_user[user.id])`（`:173`）；`roles` 输出**包含被禁用的角色**并带 `enabled` 标记（`:150-153`、`:174`），供管理端弹窗回显未保存勾选。
- 空页提前返回（`:133-134`），避免无谓的关联查询。

### 4.4 角色管理（`:185-319`）
| 函数 | 行号 | 行为 |
|---|---|---|
| `_validate_menu_codes` | `:186-190` | 全表取 `admin_menus.code` 建集合，非法码抛 `ValueError("无效菜单：" + 顿号拼接)` |
| `list_roles` | `:193-225` | 3 条 SQL：角色（按 id 升序，`:195`）、角色↔菜单码（按 `sort_order`，`:201`）、角色↔用户（`:207-211`，用 `set` 去重后取 `len` 作 `user_count`，`:212-214`、`:222`） |
| `create_role` | `:228-246` | `code` 自动生成 `"r" + secrets.token_hex(4)`（`:233`，9 字符，`is_builtin=False`）；`db.flush()` 取 id（`:235`）→ 批量写 `admin_role_menus`（`:236-241`）→ 审计 `access.role.create`（`:242-244`）→ `db.commit()`（`:245`） |
| `_menu_id_by_code` | `:249-250` | 单码查 id；**每个菜单码一条 SQL** |
| `_role_out` | `:253-272` | 提交后回读菜单码（`:254-261`，按 `sort_order`）与 `user_count`（`:262-264`） |
| `update_role` | `:275-298` | 名称 + **全量覆盖**菜单：先 `delete(synchronize_session=False)` 清空该角色菜单行（`:285-287`）再 `add_all`（`:288-293`）；审计 `access.role.update`（`:294-296`）；`commit`（`:297`） |
| `delete_role` | `:301-319` | 三重拒绝：角色不存在（`:305-307`）、内置角色（`:308-309`）、已被用户引用（`:310-311`）；审计写在删除**之前**（`:312-314`），随后删菜单关联行（`:315-317`）再删角色（`:318`），最后 `commit`（`:319`） |

`delete_role` 先清 `admin_role_menus` 再删 `admin_roles` 的顺序是 `4bf9acd` 修复的外键缺陷（openGauss `ForeignKeyViolation admin_role_menus_role_id_fkey`，见 `backend/test/docs/s9-rbac-access.md`「测试发现并修复的缺陷」第 1 条），**不得调换**。

### 4.5 用户角色授权（`:322-395`）
- `grant_roles(db, user_id, role_ids, actor_type, actor_id, actor_name)`（`:323-368`）：**全量覆盖**语义。
  - 前置校验：用户存在（`:331-333`）、`role_ids` 全部存在（`:334-337`，抛 `ValueError("角色不存在")`）。
  - `desired = set(role_ids)`（`:342`）——**入参重复 id 在此被去重**，因此不会撞 `uq_admin_user_role`（`backend/app/models/models.py:492`）。
  - 三向差异：现有行不在 `desired` → `db.delete` + 审计 `access.roles.revoke`（`:343-349`）；现有行在 `desired` 但 `enabled=False` → 置 True + 审计 `access.role.enable`（`:350-356`）；`desired` 中不存在的 → 新建 `enabled=True, granted_by=actor_name` + 审计 `access.roles.grant`（`:357-367`）。
  - 单次 `db.commit()`（`:368`）——**授权变更与全部审计行同事务原子落库**。
- `set_role_enabled(...)`（`:371-395`）：授权行不存在抛 `ValueError("该用户未被授予此角色")`（`:381-382`）；**状态未变则直接 return，不写审计不提交**（`:383-384`，幂等）；变更时同步刷 `updated_at`（`:385-386`）并按方向写 `access.role.enable` / `access.role.disable`（`:387-394`），`commit`（`:395`）。

### 4.6 审计日志查询（`list_audit_logs`，`:399-450`）
- 筛选：`action` 精确（`:409-410`）、`actor_type` 精确（`:411-412`）、`date`（`:413-418`）。
- **日期口径**：前端传本地（北京时间）日期，库内 `audit_logs.created_at` 是 UTC naive，故用 `local_to_utc(datetime.strptime(date, "%Y-%m-%d"))` 换算本地日界（`:415`，`backend/app/core/helpers.py:40-44`），区间为 `[start, start + 1 天)`（`:416-418`）。此换算由 `30b4458` 引入。
- 分页：`count()`（`:419`）+ `order_by(AuditLog.id.desc())`（`:420-425`）。
- **反 N+1**：把 `actor_user_id` 与 `target_user_id` 合成一个 id 集合，一次查昵称（`:428-435`）。
- `actor_name` 特判：`actor_type == ACTOR_SUPER` 时固定显示「超级管理员」（`:441`），因为超管的 `actor_user_id` 为 `NULL`（`backend/app/api/routes/admin.py:752-754` 的 `_actor` 返回 `("super", None)`）。

### 4.7 未被引用的模块级常量
- `ALL_MENU_CODES`（`:27-39`）：11 个菜单码。**定义后全仓无任何引用**（`grep -rn ALL_MENU_CODES` 仅命中定义处与 `.qoder/` 说明文档）。
- `ACTOR_USER = "user"`（`:42`）：**全仓无引用**。各处审计写入都直接传字面量 `"user"`（如 `backend/app/services/identity_service.py:117`、`backend/app/services/auth_service.py:140`、`backend/app/api/routes/admin.py:754`）。
- `ACTOR_SUPER = "super"`（`:41`）：**有**唯一引用，`:441`。

## 5. 输入与输出

### 5.1 函数签名与返回
| 函数 | 入参 | 返回 | 抛出的业务异常（`ValueError`） |
|---|---|---|---|
| `get_enabled_roles` | `db`, `user_id: int` | `List[AdminRole]`（ORM 对象） | — |
| `get_menu_codes` | `db`, `role_ids: List[int]` | `List[str]`（菜单码，可能含重复，见 §7.4） | — |
| `get_menu_items` | `db`, `codes: List[str]` | `List[dict]`，键 `code`/`name` | — |
| `get_all_menu_items` | `db` | `List[dict]`，键 `code`/`name` | — |
| `build_principal` | `db`, `user`（`User` ORM） | `Optional[dict]`，键 `is_super`/`username`/`user_id`/`roles`/`menus` | 无角色时返回 `None`（不抛异常） |
| `list_users` | `db`, `page`, `page_size`, `keyword=""`, `org_id=None`, `has_access=None`, `status=""` | `Tuple[int, List[dict]]` = (total, items) | — |
| `list_roles` | `db` | `List[dict]`，键 `id`/`code`/`name`/`is_builtin`/`menus`/`user_count` | — |
| `create_role` | `db`, `name`, `menu_codes`, `actor_type`, `actor_id` | `dict`（同 `_role_out`） | `无效菜单：<码>` |
| `update_role` | `db`, `role_id`, `name`, `menu_codes`, `actor_type`, `actor_id` | `dict`（同 `_role_out`） | `角色不存在` / `无效菜单：<码>` |
| `delete_role` | `db`, `role_id`, `actor_type`, `actor_id` | `None` | `角色不存在` / `内置角色不可删除` / `角色已授权给用户，请先移除授权` |
| `grant_roles` | `db`, `user_id`, `role_ids`, `actor_type`, `actor_id`, `actor_name` | `None` | `用户不存在` / `角色不存在` |
| `set_role_enabled` | `db`, `user_id`, `role_id`, `is_enabled`, `actor_type`, `actor_id` | `None` | `该用户未被授予此角色` |
| `list_audit_logs` | `db`, `page`, `page_size`, `action=""`, `actor_type=""`, `date=""` | `Tuple[int, List[dict]]` | `date` 非 `%Y-%m-%d` 时抛 `ValueError`（strptime，`:415`）——路由已用 `pattern` 前置拦截，见 §5.2 |

`list_users` 的 item 键：`id`/`nickname`/`avatar`/`org_id`/`org_name`/`has_access`/`roles`/`status`/`invite_code_id`/`invite_name`/`onboarded_at`（`:166-181`）。
`list_audit_logs` 的 item 键：`id`/`actor_type`/`actor_user_id`/`actor_name`/`action`/`target_user_id`/`target_name`/`detail`/`created_at`（`:436-449`），`detail` 原样透出（TEXT，内容为 JSON 字符串）。

### 5.2 route → service → schema 映射（管理端 snake_case 契约）
全部端点在 `backend/app/api/routes/admin.py`（共 57 个路由装饰器），响应模型在 `backend/app/schemas/schemas.py`：

| 端点 | 路由行号 | 权限依赖 | 调用的本文件函数 | `response_model` |
|---|---|---|---|---|
| `GET /api/admin/users` | `backend/app/api/routes/admin.py:757-775` | `require_menu("access")`（`:770`） | `list_users`（`:772`） | `AdminUserListOut`（`backend/app/schemas/schemas.py:982-984`，item `:968-979`） |
| `GET /api/admin/roles` | `backend/app/api/routes/admin.py:907-916` | `require_menu("access")`（`:914`） | `list_roles`（`:916`） | `AdminRoleListOut`（`backend/app/schemas/schemas.py:996-997`） |
| `POST /api/admin/roles` | `backend/app/api/routes/admin.py:919-935` | `require_menu("access")`（`:927`） | `create_role`（`:931-933`） | `AdminRoleOut`（`backend/app/schemas/schemas.py:987-993`） |
| `PUT /api/admin/roles/{role_id}` | `backend/app/api/routes/admin.py:938-955` | `require_menu("access")`（`:947`） | `update_role`（`:951-953`） | `AdminRoleOut` |
| `DELETE /api/admin/roles/{role_id}` | `backend/app/api/routes/admin.py:958-973` | `require_menu("access")`（`:966`） | `delete_role`（`:970`） | `MessageOut` |
| `POST /api/admin/users/{user_id}/roles` | `backend/app/api/routes/admin.py:976-995` | `require_menu("access")`（`:985`） | `grant_roles`（`:989-991`） | `MessageOut` |
| `PATCH /api/admin/users/{user_id}/roles/{role_id}/enabled` | `backend/app/api/routes/admin.py:998-1017` | `require_menu("access")`（`:1008`） | `set_role_enabled`（`:1012-1014`） | `MessageOut` |
| `GET /api/admin/audit-logs` | `backend/app/api/routes/admin.py:1020-1037` | `require_menu("audit")`（`:1032`） | `list_audit_logs`（`:1034-1036`） | `AdminAuditLogListOut`（`backend/app/schemas/schemas.py:1025-1027`，item `:1013-1022`） |
| `GET /api/admin/me` | `backend/app/api/routes/admin.py:178-195` | `get_current_admin`（`:180`） | `get_all_menu_items`（`:187`，超管）/ `get_menu_items`（`:193`） | `AdminMeOut`（`backend/app/schemas/schemas.py:953-957`） |
| `GET /api/admin/wechat/qr/{qr_id}/status` | `backend/app/api/routes/admin.py:142-175` | 公开（限流） | `build_principal`（`:158`）+ `get_menu_items`（`:162`） | `AdminQrStatusOut`（`backend/app/schemas/schemas.py:943-950`） |
| `WS /api/ws/updates`（admin 分支） | `backend/app/api/routes/ws.py:47` | 令牌 `role=admin` 且 `typ=user` | `build_principal`（返回 None → close 4403） | — |

**错误码映射**：路由统一 `except ValueError` → 400（`backend/app/api/routes/admin.py:934-935`、`:954-955`、`:971-972`、`:992-994`、`:1015-1016`）；其中 `grant_roles` 的 `用户不存在` 特判为 **404**（`:993`）、`set_role_enabled` 的唯一异常统一映射为 **404**（`:1016`，即使实际原因是「未授予此角色」）。

**查询参数校验在路由层完成**：`page >= 1`、`page_size` 1–100、`keyword` ≤64 字符、`status` 只允许 `""|active|disabled`、`actor_type` 只允许 `""|super|user`、`date` 只允许 `""|\d{4}-\d{2}-\d{2}`（`backend/app/api/routes/admin.py:763-768`、`:1026-1030`）——因此 `list_audit_logs:415` 的 `strptime` 在正常链路上不会抛异常。

## 6. 依赖关系

### 6.1 依赖
- **标准库**：`secrets`（`:6`，角色 code 生成）、`collections.defaultdict`（`:7`）、`datetime`/`timedelta`（`:8`）、`typing`（`:9`）。
- **第三方**：`sqlalchemy.orm.Session`（`:11`）。
- **项目内**：`app.core.helpers.local_to_utc`（`:13`）；ORM 模型 `AdminMenu`/`AdminRole`/`AdminRoleMenu`/`AdminUserRole`/`AuditLog`/`InviteCode`/`Organization`/`User`（`:15-24`）；`app.services.audit_service`（`:25`）。
- **数据库表**（`backend/app/models/models.py`）：`admin_menus`（`:456-464`）、`admin_roles`（`:467-476`）、`admin_role_menus`（`:479-485`）、`admin_user_roles`（`:488-500`）、`audit_logs`（`:503-516`）；只读 `users`（`:179-205`）、`organizations`（`:163-177`）、`invite_codes`（`:208-229`）。
- **无循环依赖**：本文件只 import `audit_service`，不 import 任何其他业务 service。`identity_service` 对 `get_enabled_roles` 的调用是**函数内延迟导入**（`backend/app/services/identity_service.py:107`）。

### 6.2 被依赖（backend/app 内 4 处）
| 调用方 | 行号 | 用到的函数 |
|---|---|---|
| `backend/app/api/deps.py` | `:11` import、`:142` | `build_principal` |
| `backend/app/api/routes/admin.py` | `:82` import、`:158`/`:162`/`:187`/`:193`/`:772`/`:916`/`:931`/`:951`/`:970`/`:989`/`:1012`/`:1034` | 除 `get_enabled_roles` 外全部 |
| `backend/app/api/routes/ws.py` | `:14` import、`:47` | `build_principal` |
| `backend/app/services/identity_service.py` | `:107` 延迟 import、`:109` | `get_enabled_roles` |

测试侧：`backend/test/s9_rbac_access.py`（RBAC 与审计接口 30 项）、`backend/test/s8_identity_admin.py`（身份与扫码 23 项）通过 HTTP 接口间接覆盖；两者均**不直接 import 本模块**。报告见 `backend/test/docs/s9-rbac-access.md`、`backend/test/docs/s8-identity-admin.md`。

## 7. 业务规则

### 7.1 权限校验链路（每请求查库，无缓存）
```
require_menu(code)            backend/app/api/deps.py:150-160
  └─ get_current_admin        backend/app/api/deps.py:109-147
       ├─ decode_token 失败 / role != admin       → 401（:122-126）
       ├─ typ != "user"（super 或历史无 typ 令牌） → AdminPrincipal(is_super=True) 直接放行（:127-129）
       └─ typ == "user"：查 User → _ensure_active（停用 403）→
            access_service.build_principal(db, user)   backend/app/services/access_service.py:84-98
              ├─ get_enabled_roles  (:45-52)   → 空 ⇒ None ⇒ 403「后台访问权限已被撤销或禁用」
              │                                  backend/app/api/deps.py:143-146
              └─ get_menu_codes     (:55-66)   → menus
            ↓
       AdminPrincipal.has_menu(code) = is_super or code in menus   backend/app/api/deps.py:105-106
       无权 → 403「无该功能的访问权限」（:155-157）
```
**关键设计**：权限**不写入令牌**（`backend/app/core/security.py:38-39` 注释），因此禁用角色 / 移除授权 / 停用账号在**下一个请求即生效**，12 小时令牌有效期只是兜底。WS 侧同理，在建连时查库（`backend/app/api/routes/ws.py:46-50`，无权 close 4403）。

### 7.2 事务边界（本文件属「服务层自提交」）
- **所有写函数自己 `db.commit()`**：`create_role:245`、`update_role:297`、`delete_role:319`、`grant_roles:368`、`set_role_enabled:395`。**路由层不再提交**（`backend/app/api/routes/admin.py:919-1017` 内无 `db.commit()`）。
- `audit_service.record` **只 `db.add` 不提交**（`backend/app/services/audit_service.py:2-5` docstring、`:28-36`），因此「业务变更 + 审计」由本文件的 `commit` **在同一事务内原子落库**。
- `create_role` 中途用 `db.flush()`（`:235`）而非 `commit()` 取新角色 id，保证角色行与菜单关联行同事务。
- 读函数（`get_*`/`list_*`/`build_principal`）不提交、不回滚。

### 7.3 审计写入清单（`audit_logs`）
| action 码 | 写入位置 | `target_user_id` | `detail` |
|---|---|---|---|
| `access.role.create` | `:242-244` | `None` | `{"role": name}` |
| `access.role.update` | `:294-296` | `None` | `{"role": name}` |
| `access.role.delete` | `:312-314` | `None` | `{"role": role.name}` |
| `access.roles.grant` | `:364-367` | `user_id` | `{"role_id": role_id}` |
| `access.roles.revoke` | `:346-349` | `user_id` | `{"role_id": row.role_id}` |
| `access.role.enable` | `:353-356`、`:387-394` | `user_id` | `{"role_id": ...}` |
| `access.role.disable` | `:387-394` | `user_id` | `{"role_id": ...}` |

角色级审计的 `target_user_id` 一律为 `None`，**detail 里只有角色名、没有 role_id**（`:243`、`:295`、`:313`）——被删角色事后无法从审计追溯其 id。`actor_type`/`actor_id` 由路由的 `_actor(admin)` 决定（`backend/app/api/routes/admin.py:752-754`：超管 `("super", None)`，微信关联管理员 `("user", user_id)`）。

### 7.4 幂等与并发
- `set_role_enabled` 状态未变即 return（`:383-384`）→ 重复点击不产生审计噪声。
- `grant_roles` 是全量覆盖 + `set` 去重（`:342`）→ 同一份 `role_ids` 重复提交结果一致（第二次不产生任何变更行与审计行）。
- `update_role` 用「先全删再全插」（`:285-293`）实现全量覆盖，**同一事务内**完成，中途失败整体回滚。
- **无乐观锁 / 无行锁**：两个管理员同时编辑同一角色或同一用户的授权，后提交者覆盖前者，无冲突检测。
- `get_menu_codes`（`:59-66`）**未加 `distinct()`**：同一菜单被用户的多个角色同时持有时，JOIN 会产生多行 → 返回的菜单码列表**含重复项**。下游影响：`has_menu` 用 `in` 判断不受影响（`backend/app/api/deps.py:106`）；但 `get_menu_items`（`:69-75`）按传入 `codes` 逐项输出，因此 `GET /api/admin/me` 与扫码轮询返回的 `menus` 数组**可能含重复 `{code, name}`**。管理后台侧边栏不受影响（渲染源是静态数组过滤：`admin/src/layout/AdminLayout.vue:15` `MENUS.filter(item => hasMenu(item.code))`）。

### 7.5 菜单码全集与 `require_menu` 覆盖情况（实测）
`admin_menus` 现有 **16 个菜单码**（2026-10-17 对本地开发库 `longmarch` 只读查询实测：`sort_order` 1–9 为 `dashboard`/`screen`/`rankings`/`route_nodes`/`questions`/`quotes`/`orgs`/`access`/`audit`（`docker/init/010_admin_identity.sql:106-115`），10 `invites`（`docker/init/015_invite_admission.sql:31-33`），11 `activity`（`docker/init/016_activity_settings.sql:36-38`），10/11/12/13/14 为 `ai_overview`/`ai_knowledge`/`ai_workshop`/`ai_logs`/`ai_config`（`docker/init/022_ai_admin_menus.sql:15`/`:18`/`:21`/`:24`/`:27`））。

`require_menu` 实际只用到其中 **14 个**：`backend/app/api/routes/admin.py` 11 个（`access`×9、`questions`×9、`quotes`×9、`orgs`×6、`invites`×4、`rankings`×4、`route_nodes`×4、`activity`×3、`dashboard`×3、`audit`×1、`screen`×1）+ `backend/app/api/routes/ai_admin.py` 3 个（`ai_workshop`×11、`ai_knowledge`×10、`ai_config`×3）。**`ai_overview` 与 `ai_logs` 两个菜单码在 `backend/app/` 与 `admin/src/` 中均无任何引用**（grep 无命中），属 AI 智能中心 Phase A「后端权限项先落库、页面与接口待开发」的预期状态（`.qoder/ARCHITECTURE.md` §11.3）。

## 8. 修改约束
- **不得破坏「每请求查库」的授权语义**：任何把 `menus`/`roles` 缓存进 JWT 或进程内缓存的改动，都会使「撤销即时生效」失效（`docs/identity-binding-design.md` §5.3；`backend/app/core/security.py:38-39` 注释）。
- **`build_principal` 返回 `None` 是拒绝访问的信号**，不是异常：调用方 `backend/app/api/deps.py:143-146` 与 `backend/app/api/routes/ws.py:47` 都按 `None` 分支处理，改成抛异常会同时破坏 REST 与 WS 两条链。
- **写函数必须自己 commit，且审计写入要在 commit 之前**：`audit_service.record` 不提交（`backend/app/services/audit_service.py:2-5`）；漏 commit 会丢业务变更，提前 commit 会让审计与变更分属两个事务。
- **`delete_role` 必须先删 `admin_role_menus` 再删 `admin_roles`**（`:315-318`），否则 openGauss 外键违反（`4bf9acd` 修复项）。
- **内置角色（`is_builtin=True`）不可删除**（`:308-309`），种子内置角色为 `operator`（`docker/init/010_admin_identity.sql:118`）。
- **菜单码是前后端契约**：新增菜单码需要同步 ① `docker/init/` 新增迁移（禁止改已执行过的编号脚本，`docker/init/SQL_CONSTRAINTS.md`）② `backend/app/api/routes/*.py` 的 `require_menu(code)` ③ `admin/src/router/menus.ts`（侧边栏与路由守卫的唯一来源）④ `admin/src/views/AuditView.vue` 的 `ACTION_TEXT`（若同时新增 action 码）。
- **`ALL_MENU_CODES` 不是白名单**：它无引用、也不参与任何校验（校验实际走 `_validate_menu_codes` 查库，`:186-190`）。**不得**把它当作「全部菜单码」的事实来源使用；要取全集请用 `get_all_menu_items`（`:78-81`）。
- 列表接口必须保持「批量取关联数据」的写法（`:136-165`、`:428-435`），不得退化为循环内查询（根 `agents.md` §2.4 大数据量性能要求）。
- 本文件的输出被 `AdminUserItem`/`AdminRoleOut`/`AdminAuditLogOut`（`backend/app/schemas/schemas.py:968-979`、`:987-993`、`:1013-1022`）以 **snake_case** 直接消费（管理端契约，非 `CamelModel`）；改键名即破坏 `admin/src/api/admin.ts` 类型。

## 9. 当前实现状态

### 已实现
- RBAC 读路径（`build_principal` / `get_enabled_roles` / `get_menu_codes` / `get_menu_items` / `get_all_menu_items`），支撑 `get_current_admin`、`require_menu`、`/admin/me`、扫码登录返回菜单、WS 建连校验五条链。
- 人员授权列表（含角色、后台授权、准入状态、组织名、邀请码名，5 SQL/页）。
- 角色 CRUD（自动生成 code、菜单码校验、内置禁删、被引用禁删）。
- 用户角色全量覆盖授权与单角色启停（逐项审计）。
- 审计日志分页 + action/actor_type/date 三维筛选（本地日期 → UTC 区间换算）。

### 存在问题 / 已知限制
1. **`ALL_MENU_CODES`（`:27-39`）是疑似死代码**：定义后全仓无引用，且只列 11 个码，**未包含 5 个 `ai_*` 菜单码**（`docker/init/022_ai_admin_menus.sql:15-27`）。`activity` 已在其中（`:38`，由 `ce14a95` 追加）。
   > 更正依据：`.qoder/PROJECT.md` §8「代码级技术债」第 22 项记为「未含 `activity` 与 5 个 `ai_*` 菜单码」，经逐行核对源码 `backend/app/services/access_service.py:38` 确为 `"activity"`，故该表述中「未含 `activity`」有误，准确说法是「含 `activity`、缺 5 个 `ai_*`」。
2. **`ACTOR_USER`（`:42`）是死常量**：全仓无引用，各处审计写入均传字面量 `"user"`。
3. **`admin_menus.sort_order` 真实重号 → 四处排序不稳定**：`invites`=10 与 `ai_overview`=10、`activity`=11 与 `ai_knowledge`=11（本地开发库只读查询实测确认；来源 `docker/init/015_invite_admission.sql:31-33`、`docker/init/016_activity_settings.sql:36-38`、`docker/init/022_ai_admin_menus.sql:15`/`:18`）。本文件有**四处** `order_by(AdminMenu.sort_order)`：`:63`（用户菜单码）、`:80`（全量菜单）、`:201`（角色列表的菜单码）、`:259`（`_role_out` 的菜单码），并列项之间**无二级排序键**，返回顺序由数据库决定，跨次调用可能不同。
   - 影响面：`/admin/me` 与扫码登录返回的 `menus` 顺序、角色管理页菜单勾选列表顺序。**管理后台侧边栏顺序不受影响**（由静态数组 `admin/src/router/menus.ts:3-15` 决定）。
   - **2026-10-17 经用户决定：只记录为已知问题，不修改业务代码。**
   > 更正依据：`.qoder/PROJECT.md` §8「代码级技术债」第 26 项、`.qoder/ARCHITECTURE.md` §16.1「admin_menus.sort_order 真实重号」行均记为「三处 `:63`/`:80`/`:201`」，经 `grep -n order_by backend/app/services/access_service.py` 复核，实为**四处**，遗漏了 `_role_out` 内的 `:259`。
4. **`get_menu_codes` 未去重**（`:59-66`，详见 §7.4）：用户持多个共享同一菜单的角色时，`/admin/me` 的 `menus` 数组会出现重复项。侧边栏与 `has_menu` 不受影响。
5. **`create_role` / `update_role` 未对入参菜单码去重**：`_validate_menu_codes`（`:186-190`）只校验存在性，`AdminRoleUpsert.menus` 也无唯一性约束（`backend/app/schemas/schemas.py:1000-1002`）。传入重复菜单码会在 `db.add_all`（`:236-241`、`:288-293`）时撞 `admin_role_menus` 联合主键（`backend/app/models/models.py:484-485`）抛 `IntegrityError`；路由只捕获 `ValueError`（`backend/app/api/routes/admin.py:934-935`、`:954-955`），后端无全局异常处理器（`.qoder/ARCHITECTURE.md` §10.3），故最终返回 **500** 而非 400。
6. **`_menu_id_by_code`（`:249-250`）逐码查询**：`create_role`/`update_role` 对 N 个菜单码发 N 条 SQL。当前菜单总数 16，量级可忽略，但与本文件其余部分的批量写法不一致。
7. **`create_role` 的角色 code 用 `secrets.token_hex(4)`（`:233`）**：32 bit 随机 + `admin_roles.code` 唯一索引（`backend/app/models/models.py:473`），**无冲突重试**，撞码会抛 `IntegrityError` → 500（概率极低，现状记录）。
8. **`grant_roles` 不阻止自我撤权**：持 `access` 菜单的微信关联管理员可以把 `role_ids` 传空从而移除自己的全部角色并立即失去后台访问权。路由只对「修改自己账号状态」做了自我操作拦截（`backend/app/api/routes/admin.py:789-790`），角色授权没有对应保护。
9. **角色级审计 detail 不含 role_id**（`:243`、`:295`、`:313`），删除后无法从 `audit_logs` 追溯被删角色。
10. **`audit_logs.actor_user_id` 无外键**（`backend/app/models/models.py:510`）：用户被删后审计行保留，但 `list_audit_logs` 的 `actor_name`/`target_name` 解析为 `None`（`:441`、`:444`），管理端显示为空。当前项目**无删除用户的接口**，故实际不可达（现状记录）。
11. **`set_role_enabled` 的异常统一映射为 404**（`backend/app/api/routes/admin.py:1015-1016`），但其唯一异常文案是「该用户未被授予此角色」，语义更接近 400。

### 待开发 / 待确认
- `ai_overview`、`ai_logs` 两个菜单码已在库中但**无对应接口与页面**（§7.5），属 Phase A 预期状态，后续阶段补齐（`.qoder/ARCHITECTURE.md` §11.3）。
- `docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql` 在 `git status` 中为**未跟踪文件**（按根 `agents.md` §1.3，`docker/` 目录默认不随任务提交），因此**生产库尚无 5 个 `ai_*` 菜单码**，`sort_order` 重号问题在生产也尚不存在；部署前须按 `.qoder/CHANGELOG.md` §3 迁移全表的提示补跑（本地开发库 `schema_migrations` 已登记 001→022）。
- 按钮级权限（`docs/identity-binding-design.md` §3.4 只到菜单码粒度）——**未实现，也无排期证据**，待确认。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/access_service.py`（5 个提交，本文件由 `b431e4d` 创建）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-13
- 需求：V2.0 需求一「活动时间控制」（后端）。
- 修改内容：`ce14a95` 仅在 `ALL_MENU_CODES` 追加 `"activity"`（`:38`，1 行插入），对应 `docker/init/016_activity_settings.sql:36-38` 新增的 `activity` 菜单码。**该常量无引用，故此改动无运行时效果**；本文件其余部分未变。
- 关联文件：`backend/app/services/activity_service.py`、`backend/app/api/deps.py`（`require_activity_participation`/`require_activity_view`）、`backend/app/api/routes/admin.py`、`backend/app/api/routes/activity.py`、`docker/init/016_activity_settings.sql`。
- 测试结果：`docs/迭代记录.md` 该条目记录的验证为「TestClient 冒烟通过：默认状态、时间格式错误 422、开始晚于结束 400、未发布与已结束时写接口 403、结束后可查看与不可查看两种配置、无 Token 仍返回 401；`s19_invite_admission.py` 回归 25/25 通过」——**针对活动设置功能，未覆盖本文件的 `ALL_MENU_CODES` 改动**（该常量无引用，亦无可覆盖行为）。

### 2026-10-12
- 需求：邀请码准入全链路（功能开发 / 安全加固）。
- 修改内容：`afbcba9` 为人员授权列表补齐准入维度——`import InviteCode`（`:21`）、`list_users` 新增 `status` 形参与筛选（`:109`、`:117-118`）、批量取邀请码名（`:160-165`）、输出新增 `status`/`invite_code_id`/`invite_name`/`onboarded_at` 四列（`:175-178`）、docstring 改为「含角色、后台授权与准入状态」（`:111`）；`ALL_MENU_CODES` 追加 `"invites"`（`:37`）。
- 关联文件：`backend/app/services/invite_service.py`、`backend/app/services/auth_service.py`、`backend/app/api/routes/auth.py`、`backend/app/api/routes/admin.py`、`docker/init/015_invite_admission.sql`、`admin/src/views/AccessView.vue`、`frontend/pages/onboard/`。
- 测试结果：`docs/迭代记录.md` 该条目记录「后端 `test/s19_invite_admission.py` 25/25 通过（I01–I25，含管理端 CRUD/审计/UTC）；真实 openGauss 并发 `test/s19_invite_concurrency_pg.py` 3/3；admin `npm run build` 通过；小程序侧 `node --check` 全部通过，真机扫码与 automator 三态截图未纳入本次 CI，需另行手工验收」。报告：`backend/test/docs/s19-invite-admission-report.md`。

### 2026-10-11
- 需求：管理后台代码审查修复（逻辑 / 冗余 / 大数据量性能）。
- 修改内容：`30b4458` 两处（共 5 增 2 删）——① `list_users` 关键词搜索由 `ilike(f"%{keyword}%")` 改为 `icontains(keyword, autoescape=True)`（`:114`），转义 LIKE 通配符；② `list_audit_logs` 日期筛选引入 `local_to_utc`（`:13` import、`:414-415`），把前端本地日期换算为 UTC 日界并加注释。
- 关联文件：`admin/src/router/menus.ts`（新增，菜单单一来源）、`admin/src/views/AuditView.vue`、`admin/src/composables/useLiveUpdates`、`backend/app/api/routes/admin.py`。
- 测试结果：`docs/迭代记录.md` 该条目记录「admin `npm run build` 通过；后端回归 p2_quotes 4/4、**s9 30/30**、**s8 23/23**、s12 11/11、s4 13/13、e2e_datasync 23/23；浏览器验收通过（含审计本地时间、人员授权页交互）」。报告：`admin/test/docs/s16-admin-review-fixes-report.md`。

### 2026-10-09（`4bf9acd`，10:43）
- 需求：微信身份关联设计（`docs/identity-binding-design.md`）批次 3——管理后台 RBAC 与审计接口。
- 修改内容：新增 `list_users`（人员分页 + 筛选）、`_validate_menu_codes`、`list_roles`、`create_role`、`_menu_id_by_code`、`_role_out`、`update_role`、`delete_role`、`grant_roles`、`set_role_enabled`、`list_audit_logs`；`delete_role` 补「先删 `admin_role_menus` 关联行」修复外键违反。
- 关联文件：`backend/app/api/routes/admin.py`（新增 `/admin/users|roles|audit-logs`，既有接口全部挂 `require_menu`）、`backend/app/api/deps.py`（`require_menu` 工厂）、`backend/app/api/routes/ws.py`（admin 分支查库校验）、`backend/app/schemas/schemas.py`（`AdminUser*`/`AdminRole*`/`AdminAuditLog*`）。
- 测试结果：`docs/迭代记录.md` 该条目记录「S9 集成测试 30/30 通过（`backend/test/s9_rbac_access.py`，报告 `backend/test/docs/s9-rbac-access.md`），S8 复测 23/23 回归通过；测试发现并修复删除角色未清理菜单关联行的外键缺陷」。

### 2026-10-09（`b431e4d`，10:27）
- 需求：微信身份关联设计批次 2——微信扫码登录与身份关联（后端）。
- 修改内容：**创建本文件**，初始内容为 RBAC 读路径（`get_enabled_roles` / `get_menu_codes` / `get_menu_items` / `get_all_menu_items` / `build_principal`）与 `ALL_MENU_CODES`、`ACTOR_SUPER`/`ACTOR_USER` 常量，供改造后的 `get_current_admin` 每请求查库校验。
- 关联文件：`backend/app/services/identity_service.py`（同批创建）、`backend/app/api/deps.py`、`backend/app/core/security.py`、`backend/app/api/routes/identity.py`、`backend/app/api/routes/admin.py`、`backend/app/models/models.py`（8 张新表 ORM）。
- 测试结果：`docs/迭代记录.md` 该条目记录「S8 集成测试 23/23 通过（`backend/test/s8_identity_admin.py`，报告见 `backend/test/docs/s8-identity-admin.md`）」。
