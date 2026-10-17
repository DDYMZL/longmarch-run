# AccessView.vue

## 1. 文件路径

`admin/src/views/AccessView.vue`（559 行）

## 2. 文件职责

「人员授权」页（`<script setup>` 单文件组件），一页两标签承担两类不同职责：

- **人员授权标签**（`name="users"`，`:270-439`）：面向**小程序用户准入与授权**——用户分页列表（昵称/组织/角色/后台权限/邀请码来源/入驻时间/账号状态）、角色全量覆盖授权、单角色启用禁用、账号启停、调整所属组织。
- **角色管理标签**（`name="roles"`，`:442-494`）：面向**后台 RBAC**——角色 CRUD 与「角色→菜单码」勾选，内置角色禁删、被引用角色删除由后端拒绝。

两标签共用同一份 `roles` 数据（`:38`）与菜单码→中文名映射 `MENU_NAME`（`:23`）。本文件顶部注释（`:1-4`）即按这两块分述职责。

## 3. 业务需求

- 需求出处：`.qoder/REQUIREMENTS.md` §11「管理后台功能」（§11.1 菜单与权限）；鉴权模型见 `.qoder/ARCHITECTURE.md` §5.3；路由守卫见 `.qoder/ARCHITECTURE.md` §5.6。
- 菜单码种子与「`access`/`audit` 默认仅超级管理员可见」的口径写在 `docker/init/010_admin_identity.sql:105`（注释）与 `:114`（`access`，`sort_order` 8）；内置角色 `operator`（运营管理员）刻意**不**含 `access`/`audit`（`:117-123`）。
- 演进：`54a0de7`（2026-10-09，P3 管理端）创建本页；`30b4458`（2026-10-11）代码审查修复（请求竞态守卫、菜单码单一来源、授权弹窗保留未保存勾选、组织下拉显示完整路径）；`afbcba9`（2026-10-12）随邀请码准入全链路新增邀请码来源/入驻时间/账号状态列与 `status` 筛选、账号启停；`e197a28`（2026-10-13）新增「调整所属组织」弹窗。

## 4. 核心功能

### 4.1 路由与权限码

- 路由：path `/access`、name `access`、`meta.menu = 'access'`，懒加载本文件（`admin/src/router/index.ts:68-73`）；侧边栏条目「人员授权」+ `Setting` 图标（`admin/src/router/menus.ts:11`）。
- 前端守卫：`router/index.ts:113-116` 按 `meta.menu` 拦截，无权回退 `firstAllowedPath()`。
- 后端守卫：本页调用的 9 个 `access` 系接口全部挂 `Depends(require_menu("access"))`，组织树接口挂 `require_menu("orgs")`（逐条见 §5 表）。前端过滤只是体验层，真实边界在后端（`.qoder/ARCHITECTURE.md` §5.3）。

### 4.2 状态与初始加载

- 列表态：`loading`/`users`/`total`/`page`/`pageSize`(10)/`keyword`/`orgId`/`hasAccess`/`statusFilter`/`orgOptions`/`roles`（`:28-38`）。
- `flattenOrg`（`:41-46`）：把组织树压平成「总部 / 一部 / 一班」式完整路径下拉项，解决同名下级组织无法区分的问题（`:40` 注释，`30b4458` 引入 `prefix` 参数）。
- `onMounted`（`:253-263`）：并发触发 `loadUsers()`、`loadRoles()`，随后 `await fetchOrgTree(true)`——`silent=true` 使无 `orgs` 菜单权限时的 403 不弹全局错误提示（`:257` 注释），失败即把 `orgOptions` 置空（`:260-262`），组织筛选下拉与「调整组织」按钮随之隐藏/禁用（`:282`、`:372-376`）。

### 4.3 人员列表加载与请求竞态守卫

- `loadUsers`（`:50-68`）：模块级自增序号 `requestSeq`（`:49`），进入即 `const seq = ++requestSeq`（`:51`），响应回来先判 `if (seq !== requestSeq) return`（`:62`）再赋值，`finally` 中同样只在 `seq === requestSeq` 时才关 loading（`:66`）——**只采纳最后一次请求**，避免快速翻页/筛选时旧响应覆盖新结果（`:48` 注释，`30b4458` 引入）。
- 查询参数（`:54-61`）：`page`/`page_size`/`keyword`(trim 后空则不传)/`org_id`/`has_access`/`status`，全部**服务端**过滤与分页；后端 `access_service.list_users`（`backend/app/services/access_service.py:102-134`）用 `offset/limit` 取页、`icontains(..., autoescape=True)` 做昵称模糊匹配并转义 LIKE 通配符（`:113-114`），角色/组织名/邀请码名批量查询避免 N+1（`:136-161`）。
- 触发方式：输入框回车与清空（`:278-279`）、「查询」按钮（`:299`）走 `handleSearch`（`:70-73`，先把 `page` 复位为 1）；分页器 `@current-change` 走 `handlePageChange`（`:75-78`）；「刷新」按钮直接调 `loadUsers`（`:302`）。**本页无防抖**（`30b4458` 的「服务端防抖搜索」只落在题库/寄语页），靠显式触发 + 竞态守卫兜底。
- 表格（`:305-379`）：`v-loading` + `border stripe row-key="id"`；列依次为 ID、昵称（头像回退首字符 `:310`）、组织（空显示 `—` `:315-320`）、角色标签（启用=danger、禁用=info 且后缀「（已禁用）」`:321-335`）、后台权限（可访问/无权限 `:336-342`）、邀请码（有名称显示名称；有 `invite_code_id` 无名称显示 `—`；两者皆无显示「历史用户」标签 `:343-349`）、入驻时间（`formatDateTime` `:350-355`）、账号状态开关（`:356-368`）、操作列（固定右侧 `:369-378`）。
- 分页器（`:381-388`）：`layout="total, prev, pager, next"`，**无每页条数选择器**，`pageSize` 固定 10（`:32`）。

### 4.4 账号启停（准入侧）

`toggleUserStatus`（`:110-132`）：

1. 全局互斥——已有切换在途（`togglingStatusId !== null`）直接 return（`:111`），配合开关的 `:loading` 与「其他行禁用」（`:360-361`）防连点。
2. 仅**停用**方向弹二次确认（`:113-123`），文案明确「停用后小程序立即无法使用，受保护接口返回 403」，确认按钮为 danger；取消走 `catch { return }`（`:120-122`），无未处理 rejection。
3. 调 `setUserStatus` 后本地就地改 `row.status`（`:128`）而不整表重拉；启用/停用分别提示「已启用」/「已停用（即时生效）」。
4. 后端 `admin.py:783-791` 额外限制：非超管不能修改**自己**的账号状态（400）。

### 4.5 设置角色弹窗（全量覆盖授权 + 单角色启停）

- 打开：`openGrant(row)`（`:86-91`）把 `row.roles` 的全部 id 写入 `checkedRoleIds`——**勾选态语义是「已授权」，含被禁用的角色**（`:88` 注释），禁用不解除授权关系，保存时不得丢失。
- 勾选变更：`onGrantCheck`（`:155-163`）手动维护数组（未用 `el-checkbox-group`），逐行 `el-checkbox` 的 `:model-value` 反查 `checkedRoleIds.includes`（`:394-397`）。
- 保存：`saveGrant`（`:93-104`）调 `grantUserRoles(userId, checkedRoleIds)` → 后端 `access_service.grant_roles`（`backend/app/services/access_service.py:323-368`）为**全量覆盖**语义：新增授权、移除不在列表中的、列表内已禁用的角色统一重新启用，且逐项写审计（`access.roles.grant`/`access.roles.revoke`/`access.role.enable`）。成功后关弹窗并 `await loadUsers()`。
- 弹窗内单角色开关（`:402-408`）：仅对已勾选（已授权）的角色渲染；`:disabled` 条件为「有切换在途」**或**「该角色尚未保存进授权关系」（`:406`），即新勾选未保存的角色不能直接切开关。
- `toggleRoleEnabled`（`:134-153`）是 `30b4458`「授权弹窗保留未保存勾选」的落点：
  - 用户对象改为从 `grantUser.value` 内部取（`:135`），并用 `togglingRoleId` 做互斥（`:136`、`:138-143`）。
  - 成功后**不再**用列表新数据整体替换 `grantUser` 与 `checkedRoleIds`（旧实现会 `checkedRoleIds.value = fresh.roles.map(...)`，从而抹掉用户尚未保存的勾选），改为只把该角色的 `enabled` 就地合并进 `grantUser.roles`（`:145-151`，`:145` 注释「不重置尚未保存的勾选」）。
  - 末尾 `loadUsers()` **未 await**（`:152`），用于刷新列表「后台权限」列。
- 空态：无角色时弹窗显示 `el-empty`「暂无角色，请先在「角色管理」中创建」（`:392`）。
- 弹窗底部为「取消 / 保存授权」（`:410-413`），`destroy-on-close`（`:390`）。

### 4.6 调整所属组织弹窗

- `openOrgChange`（`:171-175`）预填 `targetOrgId = row.org_id`；`saveOrgChange`（`:177-193`）在目标与当前相同或为空时直接关弹窗/返回（`:179-183`），确认按钮亦按同条件禁用（`:434`）；成功后提示并 `await loadUsers()`。
- 弹窗提示语（`:417`）写明业务规则：小程序端组织在首次入驻后锁定，仅管理员可在此调整，调整即时生效并记录审计日志（后端动作码 `user.org_change`，`backend/app/services/org_service.py`）。
- 可用性依赖组织树是否拉取成功（`:374` 的 `:disabled="!orgOptions.length"`），并以 `el-tooltip` 说明「需同时拥有「组织架构」菜单权限」（`:372`）。

### 4.7 角色管理（RBAC CRUD）

- `loadRoles`（`:201-204`）：取全量角色（后端 `/admin/roles` 无分页参数，`admin.py:907-916`），**无 loading 标志、无 try/catch**。
- 表格（`:449-476`）：ID、角色名称（内置角色加 warning「内置」标签 `:451-456`）、标识 `code`、菜单权限（把菜单码经 `MENU_NAME` 转中文名标签 `:458-464`）、授权人数 `user_count`、操作列。
- 新建/编辑共用弹窗（`:478-493`）：`openCreateRole`（`:206-211`）清空表单；`openEditRole`（`:213-218`）以 `[...row.menus]` 拷贝避免直接改列表对象；表单为「角色名称」（`maxlength="32"`，`:481`）+「菜单权限」`el-checkbox-group`（`:483-487`）。
- **菜单勾选树的保存时机**：勾选只改本地 `roleForm.menus`，点「保存」才由 `saveRole`（`:220-240`）一次性提交 `{name, menus}`——新建走 `createRole`、编辑走 `updateRole`，即菜单码为**全量覆盖**（后端 `access_service.update_role:275-298` 先删该角色全部 `admin_role_menus` 再重建）。名称为空时前端拦下并 warning（`:221-224`），不发请求。
- 删除：`handleDeleteRole`（`:242-251`）先 `ElMessageBox.confirm`（danger 按钮，文案「已授权给用户的角色无法删除」），再调 `deleteRole`。**该函数无 try/catch**，取消确认会产生未处理的 Promise rejection（与 `layout/AdminLayout.vue` 的 `handleLogout` 同一模式）。
- 内置角色：删除按钮 `:disabled="row.is_builtin"` 且 tooltip「内置角色不可删除」（`:469-473`）；后端同样拒绝（`access_service.delete_role:301-311`：`is_builtin` → 「内置角色不可删除」，被 `admin_user_roles` 引用 → 「角色已授权给用户，请先移除授权」）。**编辑未做内置保护**：前端「编辑」按钮对内置角色同样可点（`:468`），后端 `update_role` 也无 `is_builtin` 分支（`:275-298`），即内置角色 `operator` 的名称与菜单集合可被改（含清空菜单）。

### 4.8 菜单码来源（本页勾选清单从哪来）

- 本页的菜单勾选项与中文名映射**均来自前端静态数组** `MENUS`（`admin/src/router/menus.ts:3-15`，11 项）：`:21` 导入，`:23` 建 `MENU_NAME`（`code → title`），`:485` 渲染勾选框。`30b4458` 之前用的是 `api/admin.ts` 导出的 `MENU_CATALOG`，该提交改为读 `MENUS` 后 `MENU_CATALOG` 已从 `api/admin.ts` 移除（现 `admin/src` 全目录 grep 无 `MENU_CATALOG`）。
- **不由后端下发**：`/admin/me` 只返回当前管理员自己可见的菜单（`admin.py:178-195`），本页勾选清单不取自它。
- 因此「菜单码清单」这一事实现存三处定义：① 前端 `router/menus.ts:3-15`（11 码，侧边栏/回退顺序/本页勾选共用）；② 数据库 `admin_menus`（`docker/init/010_admin_identity.sql:106-115` 种 9 码 + `015_invite_admission.sql:31-33` 加 `invites` + `016_activity_settings.sql:36-38` 加 `activity` + `022_ai_admin_menus.sql:14-27` 加 5 个 `ai_*`，合计 16 码）；③ 后端 `access_service.ALL_MENU_CODES`（`:27-39`，11 码）。详见 §9 第 5 项。
- 保存时后端以**数据库**为准校验：`_validate_menu_codes`（`access_service.py:186-190`）查 `admin_menus` 全表，前端传来的码不在库内即抛「无效菜单：…」→ 400。

### 4.9 与公共组件、实时推送的关系

- **不引用 `admin/src/components/` 下任何公共组件**（导入见 `:5-21`），弹窗均为本页内联 `el-dialog`。
- **不订阅 WebSocket**：未导入 `utils/liveUpdates`，授权变更靠操作后主动 `loadUsers()`/`loadRoles()` 刷新（与 `.qoder/ARCHITECTURE.md` §6.4「仅 Dashboard/Screen/Rankings 三页接入实时推送」一致）。

## 5. 输入与输出

- 输入：无 props / 无 emits。隐式输入为 `store/auth` 的 localStorage 登录态（经 `api/request.ts:19-25` 注入 Bearer Token）与用户交互（筛选、分页、弹窗表单）。
- 输出：无返回值；副作用全部经后端落库并写审计日志。
- 调用的 `api/admin.ts` 函数与后端路径（`request.ts:15` 的 `baseURL` 为 `/api`）：

| 前端函数（`admin/src/api/admin.ts`） | 方法与路径 | 后端权限守卫 | 本页调用点 |
|---|---|---|---|
| `fetchAdminUsers`（`:495-497`） | GET `/api/admin/users` | `require_menu("access")`（`backend/app/api/routes/admin.py:770`） | `:54` |
| `setUserStatus`（`:499-501`） | PATCH `/api/admin/users/{id}/status` | 同上（`admin.py:787`） | `:126` |
| `setUserOrg`（`:504-506`） | PUT `/api/admin/users/{id}/org` | 同上（`admin.py:809`） | `:186` |
| `fetchRoles`（`:521-523`） | GET `/api/admin/roles` | 同上（`admin.py:914`） | `:202` |
| `createRole`（`:530-532`） | POST `/api/admin/roles` | 同上（`admin.py:927`） | `:229` |
| `updateRole`（`:534-536`） | PUT `/api/admin/roles/{id}` | 同上（`admin.py:947`） | `:232` |
| `deleteRole`（`:538-540`） | DELETE `/api/admin/roles/{id}` | 同上（`admin.py:966`） | `:248` |
| `grantUserRoles`（`:542-544`） | POST `/api/admin/users/{id}/roles` | 同上（`admin.py:985`） | `:97` |
| `setUserRoleEnabled`（`:546-550`） | PATCH `/api/admin/users/{id}/roles/{roleId}/enabled` | 同上（`admin.py:1008`） | `:140` |
| `fetchOrgTree(true)`（`:747-749`） | GET `/api/admin/orgs` | `require_menu("orgs")`（`admin.py:670`） | `:258`（silent） |

- 数据类型：`AdminUserItem`/`UserRoleItem`/`AdminUserQuery`/`UserStatus`（`api/admin.ts:458-493`）、`RoleItem`/`RoleUpsert`（`:508-528`）、`OrgNode`（`:41-50`）。
- 加载态：列表 `v-loading="loading"`（`:305`）、三个保存按钮 `:loading`（`:412`、`:433`、`:491`）、两个行内开关 `:loading`（`:360`、`:405`）。**角色管理表格无 loading**（§9 第 2 项）。
- 空态：表格用 Element Plus 默认「暂无数据」；授权弹窗有自定义 `el-empty`（`:392`）；组织/入驻时间/邀请码等空值统一显示 `—`（`.none` 样式 `:522-524`）。
- 错误态：本页无局部错误处理，全部依赖 `api/request.ts:27-51` 的响应拦截器弹 `detail`；`fetchOrgTree` 因 `silent=true` 被抑制（`:258`、`request.ts:33`）。`loadUsers`/`loadRoles`/`saveGrant`/`saveRole`/`saveOrgChange` 均为 `try…finally` 无 `catch`，且调用处未 `.catch()`（如 `:254-255`），接口失败时会产生未处理的 Promise rejection（仅控制台噪声，用户已见 toast）。

## 6. 依赖关系

- 依赖：`vue`（`onMounted`/`reactive`/`ref`，`:5`）、`element-plus`（`ElMessage`/`ElMessageBox` 直接导入 `:6`；card/tabs/tab-pane/input/select/option/button/table/table-column/avatar/tag/tooltip/switch/dialog/form/form-item/checkbox/checkbox-group/empty/pagination 由 `plugins/element-plus.ts` 注册）、`../api/admin`（10 个函数 + 4 个类型，`:7-19`）、`../utils/format`（`formatDateTime`，`:20`）、`../router/menus`（`MENUS`，`:21`）。
- 图标以字符串形式引用（`'Search'` `:277`/`:299`、`'Refresh'` `:302`/`:446`、`'Plus'` `:445`），依赖 `main.ts:77-78` 的全局图标注册（注册清单见 `.qoder/admin/src/main.ts.md`）。
- 被依赖：`admin/src/router/index.ts:68-73`（`/access` 懒加载）。
- 后端链路：`admin.py` 路由 → `access_service`（用户列表/角色/授权）与 `org_service.admin_set_user_org`（组织调整）→ `audit_service.record` 写 `audit_logs`；相关表 `users`、`admin_roles`、`admin_role_menus`、`admin_user_roles`、`admin_menus`、`organizations`、`invite_codes`、`audit_logs`。
- 下游可见性：本页授权结果决定其他管理员登录后的菜单集合（`/admin/me` → `store/auth` → `AdminLayout` 菜单过滤与路由守卫）。审计结果在 `views/AuditView.vue` 呈现。

## 7. 业务规则

1. **权限**：进入本页需 `access` 菜单码（超管恒真，`store/auth.ts:27-29`）；页面内所有写操作后端再校验一次 `require_menu("access")`，前端禁用/隐藏不是安全边界。
2. **授权语义**：勾选=已授权（含禁用角色）；保存为**全量覆盖**，未勾选即回收；被回收/新增/重新启用逐项写审计（§4.5）。
3. **禁用 vs 回收**：单角色开关只改 `admin_user_roles.enabled`，保留授权关系；禁用**即时生效**（后端每请求经 `access_service.build_principal` 重建权限，`.qoder/ARCHITECTURE.md` §5.3）。开关仅在角色已存在于授权关系时可用（`:406`）。
4. **账号启停**：停用即时生效，小程序端所有受保护接口返回 403（提示文案 `:116`）；停用需二次确认，启用不需；非超管不能改自己的账号状态（`admin.py:789-790`）。
5. **`has_access` 筛选口径**：后端按「是否存在**启用**的角色授权」判定（`access_service.py:119-125`），仅有禁用角色的用户算「无后台权限」。
6. **组织归属**：小程序端首次入驻后锁定，仅管理员可改，改动即时生效并写审计 `user.org_change`（`:417`、`api/admin.ts:503` 注释）；目标组织与当前相同视为无操作（`:180-183`）。
7. **角色删除**：内置角色不可删（前端禁用 + 后端拒绝）；已被用户授权的角色不可删（后端拒绝，前端仅在确认文案中提示 `:243`，实际拦截在后端）。
8. **角色菜单**：提交前前端只校验名称非空（`:221`）；菜单码合法性由后端按 `admin_menus` 表校验（`access_service.py:186-190`）。角色 `code` 由后端自动生成（`r` + 随机十六进制，`access_service.py:233`），前端只读展示（`:457`）。
9. **内置角色可编辑**：现行实现允许改内置角色名称与菜单集合（§4.7 末），是否应禁止**待确认**（代码与提交信息均无相关约束说明）。

## 8. 修改约束

- **菜单码三方一致**：`router/menus.ts` 的 `code`、路由 `meta.menu`、后端 `require_menu(code)`、数据库 `admin_menus.code` 必须逐字相同（`.qoder/admin/src/router/index.ts.md` §8）。本页勾选清单直接取 `MENUS`，新增菜单码若只加到 DB 不加到 `MENUS`，角色管理界面就勾不到它。
- 不得把 `MENUS` 的 `title` 当权限依据：`MENU_NAME` 只用于展示，未知码回退显示原始码（`:400`、`:461`）。
- 竞态守卫不可退化：`requestSeq` 的自增、判等、`finally` 内判等三处（`:49`、`:62`、`:66`）必须成对保留；新增任何写操作后的重拉都应经 `loadUsers()` 而非直接改 `users`。
- `checkedRoleIds` 必须继续表示「已授权全集」（含禁用角色），否则保存会把禁用角色误回收（`:88` 注释即此约束）。
- `toggleRoleEnabled` 不得恢复「用列表新数据整体替换 `grantUser`/`checkedRoleIds`」的旧写法（会丢失未保存勾选，`30b4458` 修复点）。
- 停用/删除等破坏性操作必须保留二次确认与 danger 按钮样式（`:113-123`、`:243-247`）。
- 组织筛选与「调整组织」的可用性依赖 `fetchOrgTree(true)` 的 silent 降级，改回非 silent 会让无 `orgs` 权限的管理员每次进页都吃到一个 403 弹窗。
- 视觉与可用性：需覆盖加载/空态/筛选与窄屏可用性（`admin/agents.md`「开发约定」第 3 条）；操作列已 `fixed="right"`（`:369`），加列时注意总宽。

## 9. 当前实现状态

- **已实现**：人员分页筛选（昵称/组织/后台权限/账号状态）、角色全量覆盖授权、单角色启停、账号启停、调整所属组织、角色 CRUD 与菜单勾选，均可用；历次浏览器验收见 §10。
- **存在问题 / 已知事项**：
  1. `handleDeleteRole`（`:242-251`）取消确认时产生未捕获的 Promise rejection（与 `layout/AdminLayout.vue` §9 第 1 项同模式，仅控制台噪声）。
  2. `loadRoles`（`:201-204`）无 loading 态、无错误处理：角色表拉取失败时静默显示空表，且授权弹窗只会提示「暂无角色」（`:392`），用户无法区分「真没有角色」与「拉取失败」。
  3. `toggleRoleEnabled` 末尾 `loadUsers()` 未 await（`:152`），与紧随其后的 `saveGrant` 内 `await loadUsers()`（`:100`）可能并发；有 `requestSeq` 守卫故最终一致，但会多一次请求。
  4. 角色管理表格无分页（`:449`），`/admin/roles` 后端亦无分页参数（`admin.py:907-916`）。当前角色数量很小，风险低；若角色规模增长需按根 `agents.md` §2.4 补服务端分页。
  5. **同一事实（菜单码清单）三处定义**：① 前端 `admin/src/router/menus.ts:3-15`（11 码，静态，本页勾选清单来源）；② 数据库 `admin_menus`（16 码 = 9 种子 + `invites` + `activity` + 5 个 `ai_*`，见 `docker/init/010_admin_identity.sql:106-115`、`015_invite_admission.sql:31-33`、`016_activity_settings.sql:36-38`、`022_ai_admin_menus.sql:14-27`）；③ 后端 `backend/app/services/access_service.py:27-39` 的 `ALL_MENU_CODES`（11 码，**定义后全后端无任何引用**，grep 仅命中定义行本身）。后果：新增菜单码需人工同步 4 个位置（3 处清单 + 路由 `meta.menu`），漏同步不会报错，只会让角色勾不到或永久 403。与 `.qoder/PROJECT.md` §8「代码级技术债」第 22 项相关（该项称 `ALL_MENU_CODES` 未含 `activity`，实测已含 `activity` 与 `invites`，仅缺 5 个 `ai_*`——总览文档此处需更正）。
  6. 5 个 `ai_*` 菜单码在库中存在但不在 `MENUS` 里，故本页无法把它们授予任何角色（AI 管理子页面尚未开发，属预期状态，`.qoder/admin/src/router/index.ts.md` §9「待开发」）。
  7. 无按钮级权限：凡能进入本页即可执行全部授权/角色/启停/组织调整操作，唯一边界是后端 `require_menu("access")`（`.qoder/PROJECT.md` §8「代码级技术债」第 20 项）。
  8. 「调整组织」按钮的可用性由**组织树是否拉取成功**间接决定（`:282`、`:374`），而后端该接口只校验 `access` 菜单码（`admin.py:805-810`）——UI 口径（需 `orgs`）严于后端口径（只需 `access`）。不构成交叉提权（前端更严），但两处口径不一致，是否统一到后端**待确认**。
  9. `saveRole` 未做名称重复校验，重名角色由后端决定接受与否（`access_service.create_role:229-237` 未见唯一性检查，`admin_roles.code` 唯一但 `name` 未见约束）——重名是否被拒绝**待确认**（未实测）。
- **待开发**：无本页专属待办；AI 管理子页面落地后需把 `ai_*` 码纳入 `MENUS`（§9 第 6 项）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/views/AccessView.vue`，共 **4 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-13（`e197a28`）
- 需求：V2.0 管理后台——人员组织调整弹窗（同批含活动设置页、排名洞察积分化、审计动作中文化）。
- 修改内容（涉本文件）：新增「调整所属组织」弹窗与 `setUserOrg` 调用（现行代码 `:165-193`、`:416-438`）；增删行数以 `git show --numstat e197a28 -- admin/src/views/AccessView.vue` 实测为准（+63/-2），本文件逐行 diff 未核，细节以 `docs/迭代记录.md` 的 `e197a28` 条目为准。
- 关联文件：`admin/src/api/admin.ts`（`setUserOrg`）、`admin/src/views/AuditView.vue`（`user.org_change` 动作中文）、`backend/app/services/org_service.py`、`backend/app/api/routes/admin.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `e197a28` 条目。

### 2026-10-12（`afbcba9`）
- 需求：邀请码准入全链路（管理后台侧）。
- 修改内容（涉本文件）：+63/-3 行，按提交说明新增「邀请码来源 / 入驻时间 / 账号状态」三列与 `status` 筛选（现行代码 `:343-368`、`:295-298`）及账号启停 `toggleUserStatus`（`:110-132`）；本文件逐行 diff 未核，细节以 `docs/迭代记录.md` 的 `afbcba9` 条目为准。
- 关联文件：`admin/src/views/InvitesView.vue`（新建）、`admin/src/api/admin.ts`、`docker/init/015_invite_admission.sql`、`backend/app/services/invite_service.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复（本页涉及 4 项：请求竞态守卫、菜单单一来源、授权弹窗保留未保存勾选、组织下拉完整路径）。
- 修改内容（涉本文件）：+45/-23 行——① `loadUsers` 加 `requestSeq` 竞态守卫（`:49`、`:62`、`:66`）；② 菜单清单由 `api/admin.ts` 的 `MENU_CATALOG` 改读 `router/menus.ts` 的 `MENUS`（`:21`、`:23`、`:485`）；③ `toggleRoleEnabled` 改为就地合并 `enabled`、不再重置 `checkedRoleIds`（`:134-153`），并加 `togglingRoleId` 互斥与开关 `:loading`；④ `flattenOrg` 加 `prefix` 参数显示组织完整路径（`:41-46`），组织下拉加 `filterable` 并加宽（`:281-290`）；⑤ `fetchOrgTree` 改传 `silent=true` 并把失败分支显式置空 `orgOptions`（`:258-262`）。
- 关联文件：`admin/src/router/menus.ts`（新建）、`admin/src/api/admin.ts`、`admin/src/views/LoginView.vue`、`admin/src/views/AuditView.vue`。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-09（`54a0de7`）
- 需求：扫码登录与人员授权/审计页（P3 管理端 RBAC）。
- 修改内容（涉本文件）：创建本文件——人员授权标签（列表 + 设置角色弹窗）与角色管理标签（CRUD + 菜单勾选）初版。
- 关联文件：`admin/src/views/AuditView.vue`（新建）、`admin/src/views/LoginView.vue`、`admin/src/store/auth.ts`（`hasMenu`/`isLoggedIn`）、`admin/src/router/index.ts`（`/access` 路由与守卫）、`backend/app/api/routes/admin.py`、`backend/app/services/access_service.py`、`docker/init/010_admin_identity.sql`。
- 测试结果：见 `docs/迭代记录.md` 的 `54a0de7` 条目（浏览器验收 20/20，修复 3 处验收缺陷）。
