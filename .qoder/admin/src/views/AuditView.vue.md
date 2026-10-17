# AuditView.vue

## 1. 文件路径

`admin/src/views/AuditView.vue`（191 行）

## 2. 文件职责

「审计日志」页（`<script setup>` 单文件组件）：**纯只读**的服务端分页列表，支持按日期、动作码、操作人类型三条件筛选；把后端动作码映射为中文标签并按语义配色，时间统一按本地时区格式化（含秒）。是管理端唯一的操作留痕查询入口，无任何增删改能力。

## 3. 业务需求

- 需求出处：`.qoder/REQUIREMENTS.md` §11「管理后台功能」；审计写入链路见 `.qoder/ARCHITECTURE.md` §5.3 与 `.qoder/backend/app/services/audit_service.py.md`（若已建档）；长列表必须分页的要求见根 `agents.md` §2.4。
- 菜单码 `audit` 由 `docker/init/010_admin_identity.sql:115` 种入（`sort_order` 9），`:105` 注释明确「`access`/`audit` 默认仅超级管理员可见，可由角色管理授予自定义角色」，`:117-123` 给内置角色 `operator` 授权时**刻意排除** `access`/`audit`。
- 演进：`54a0de7`（2026-10-09，P3 管理端）创建本页；`30b4458`（2026-10-11）审计时间本地化（删除页面私有 `formatTime`，改走共享 `utils/format`）；`e197a28`（2026-10-13）审计动作中文化 + 动作筛选由自由输入框改为可创建下拉。

## 4. 核心功能

### 4.1 路由与权限码

- 路由：path `/audit`、name `audit`、`meta.menu = 'audit'`，懒加载本文件（`admin/src/router/index.ts:80-85`）；侧边栏条目「审计日志」+ `Document` 图标（`admin/src/router/menus.ts:13`）。
- 前端守卫：`router/index.ts:113-116`（无 `audit` 码则回退 `firstAllowedPath()`）；侧边栏过滤见 `layout/AdminLayout.vue:15`。
- 后端守卫：`GET /api/admin/audit-logs` 挂 `Depends(require_menu("audit"))`（`backend/app/api/routes/admin.py:1032`）。前端隐藏不是安全边界，越权直连只会得到后端 403。

### 4.2 列表加载与服务端分页

- 状态（`:8-15`）：`loading`、`logs`、`total`、`page`(1)、`pageSize`(**20**)、`date`、`action`、`actorType`。
- `loadLogs`（`:17-32`）：调 `fetchAuditLogs({page, page_size, action(trim 后空则不传), actor_type, date})`，把 `data.items`/`data.total` 写入本地；`finally` 关 loading（`:29-31`）。
- **分页在服务端**：后端 `access_service.list_audit_logs`（`backend/app/services/access_service.py:399-450`）先 `query.count()` 再 `order_by(AuditLog.id.desc()).offset((page-1)*page_size).limit(page_size)`（`:419-425`），单页上限 100（`admin.py:1027`）。**本页不做任何前端过滤/切片**，满足根 `agents.md` §2.4 对长列表的要求。
- 昵称解析也在服务端批量完成：先收集本页行的 `actor_user_id`/`target_user_id`，一次 `IN` 查询取昵称（`access_service.py:428-435`），避免 N+1。
- 触发：`onMounted(loadLogs)`（`:82`）、「查询」（`:111` → `handleSearch`）、分页器（`:155` → `handlePageChange`）、「刷新」（`:115` 直接调 `loadLogs`）。
- `handleSearch`（`:34-37`）先把 `page` 复位为 1；`handlePageChange`（`:46-49`）只改 `page` 后重拉；`handleReset`（`:39-44`）清空三个筛选条件再走 `handleSearch`。
- 表格（`:118-147`）：`v-loading` + `border stripe row-key="id"`；列为 ID、时间、操作人、动作、目标用户、详情（`show-overflow-tooltip` `:141`）。分页器 `layout="total, prev, pager, next"`（`:149-156`），**无每页条数选择器**，`pageSize` 固定 20。

### 4.3 查询条件（三维）

| 维度 | 前端控件 | 传参 | 后端处理 |
|---|---|---|---|
| 时间范围 | `el-date-picker type="date"`，`value-format="YYYY-MM-DD"`（`:88-95`） | `date` | 本地日界换算 UTC 区间：`local_to_utc(strptime(date))` 到 `+1 天`（`access_service.py:413-418`；`local_to_utc` 由 `app.core.helpers` 导入，`access_service.py:13`） |
| 动作类型 | `el-select` + `filterable allow-create default-first-option`（`:96-106`），选项由 `ACTION_TEXT` 生成（`:105`） | `action`（trim 后空则不传，`:23`） | 等值匹配 `AuditLog.action == action`（`access_service.py:409-410`），后端 `max_length=64`（`admin.py:1028`） |
| 操作人 | `el-select`：超级管理员 `super` / 微信关联管理员 `user`（`:107-110`） | `actor_type` | 等值匹配（`access_service.py:411-412`），后端 `pattern="^(|super|user)$"`（`admin.py:1029`） |

- 目标用户（`target_user_id`/`target_name`）**只展示不作为筛选条件**（`:135-140`）；无「按目标用户查询」入口。
- 动作下拉开了 `allow-create`（`:101`），可手输 `ACTION_TEXT` 之外的动作码直接查询，后端等值匹配不到即返回空列表（不报错）。
- 仅单日粒度，无起止时间范围筛选（§9 第 4 项）。

### 4.4 时间本地化（`30b4458` 修复点）

- 现行实现：`:6` 导入 `formatDateTime`，模板 `:121` 调 `formatDateTime(row.created_at, '—', true)`——第三参 `true` 表示带秒。
- 落到共享工具：`admin/src/utils/format.ts:39-42` 用模块级复用的 `FULL_TIME_SECONDS`（`Intl.DateTimeFormat('zh-CN', …second:'2-digit', hour12:false)`，`:18-26`）格式化 `parseUtc(value)`；`parseUtc`（`:29-31`）对无时区后缀的串补 `Z`，即**后端返回 UTC naive ISO，前端按浏览器本地时区展示**（`format.ts:2` 注释，与小程序 `util.formatTime` 同约定）。
- 因此「审计时间本地化」是**前端格式化**，不是后端改返本地时间；后端仍原样返回 `row.created_at`（`access_service.py:446`）。
- 修复前本页有私有 `formatTime`，实现为 `value.replace('T', ' ').slice(0, 19)`（`30b4458` 删除），直接把 UTC 串当本地时间显示（差 8 小时）。现统一走 `utils/format.ts`，与 `views/AccessView.vue:20`/`:352` 等页**同一函数同一约定，未发现同类逻辑的重复实现**。

### 4.5 动作码中文化与标签配色（`e197a28` 引入）

- `ACTION_TEXT`（`:51-72`）：20 个动作码 → 中文名，覆盖 `admin.login.qr`、`identity.bind.confirm`/`identity.unbind`、`access.roles.grant`/`revoke`、`access.role.create`/`update`/`delete`/`enable`/`disable`、`activity.update`/`publish`/`unpublish`、`points.recompute`、`user.org_change`/`onboard`/`enable`/`disable`、`invite.create`/`update`。
- 渲染（`:129-134`）：标签文本 `ACTION_TEXT[row.action] || row.action`（**未命中回退原始码**，`:131`）；命中时在标签右侧追加灰色小字原始码（`:132`，`v-if="ACTION_TEXT[row.action]"`，样式 `.action-code` `:181-185`），便于按码排查与复制。
- `actionTagType`（`:74-80`）按语义分档：`access.*` 与 `user.disable` → `danger`；`activity.*` 与 `points.*` → `primary`；含 `identity` 与 `user.org_change` → `warning`；含 `admin.login` → `success`；其余 → `info`。
- 筛选下拉的选项也来自同一张表（`:105`），故**新增动作码只需改 `ACTION_TEXT` 一处**即可同时更新筛选项与展示（未登记码仍可手输查询）。

### 4.6 操作人与目标用户展示

- 操作人列（`:123-128`）：`actor_type === 'super'` 显示 warning 标签「超级管理员」（后端也把该情形下的 `actor_name` 置为同一文案，`access_service.py:441`）；否则显示 `actor_name`，缺失时回退 `` `用户#${row.actor_user_id ?? '—'}` ``（`:126`）。
- 目标用户列（`:135-140`）：有 `target_name` 显示昵称，否则 `—`（`.none` 样式 `:177-179`）；用户被删除或目标为空（如角色类操作 `target_user_id` 为 null）即落到 `—`。
- 详情列（`:141-146`）：直接展示后端 `detail` 文本（`audit_service.record` 写入的 JSON/文案摘要），超长由 `show-overflow-tooltip` 截断；本页**不解析 detail 结构**、不做键值展开。

### 4.7 只读性核实

本页**确无任何写操作入口**：

- 只导入 `fetchAuditLogs` 一个 API 函数（`:4`），未导入任何 POST/PUT/PATCH/DELETE 类函数。
- 模板中无 `el-dialog`、无 `el-form`、无「新建/编辑/删除/导出」按钮；工具栏只有日期选择、两个下拉、「查询」「重置」「刷新」（`:87-116`），表格无操作列（`:118-147`）。
- 唯一副作用是查询请求本身；`audit_logs` 表只由后端各服务经 `audit_service.record` 写入（`.qoder/ARCHITECTURE.md` §5.3）。

### 4.8 与公共组件、实时推送的关系

- **不引用 `admin/src/components/` 下任何公共组件**（导入仅 `:3-6`：`vue`、`../api/admin`、类型、`../utils/format`）。
- **不订阅 WebSocket**：未导入 `utils/liveUpdates`，新审计记录需手动「刷新」或重新查询才可见（与 `.qoder/ARCHITECTURE.md` §6.4「仅 Dashboard/Screen/Rankings 三页接入实时推送」一致）。

## 5. 输入与输出

- 输入：无 props / 无 emits。隐式输入为 `store/auth` 的 localStorage 登录态（经 `api/request.ts:19-25` 注入 Bearer Token）与用户的筛选/翻页操作。
- 请求参数类型 `AuditQuery`（`admin/src/api/admin.ts:569-575`）：`page`、`page_size`、`action?`、`actor_type?`、`date?`；空串在发送前被转为 `undefined`（`:23-25`）。
- 响应类型 `AuditLogListResult`（`api/admin.ts:564-567`）：`{ total, items }`；行结构 `AuditLogItem`（`:552-562`）：`id`、`actor_type`、`actor_user_id`、`actor_name`、`action`、`target_user_id`、`target_name`、`detail`、`created_at`。
- 后端端点：`fetchAuditLogs`（`api/admin.ts:577-579`）→ GET `/api/admin/audit-logs`（`admin.py:1020-1033`）→ `access_service.list_audit_logs`（`:399-450`）。参数校验失败由 FastAPI 返回 422，权限不足 403。
- 输出：无返回值；仅渲染。
- 加载态：`v-loading="loading"`（`:118`）；空态：`el-table` 默认「暂无数据」（**无自定义 empty 插槽/文案**）；错误态：本页无局部处理，`loadLogs` 为 `try…finally` 无 `catch`（`:19-31`）且 `onMounted`/事件处未 `.catch()`，接口失败时依赖 `request.ts:46-48` 的全局 toast，同时**表格保留上一次成功的数据**（§9 第 3 项）。

## 6. 依赖关系

- 依赖：`vue`（`onMounted`/`ref`，`:3`）、`../api/admin`（`fetchAuditLogs` + `AuditLogItem`，`:4-5`）、`../utils/format`（`formatDateTime`，`:6`）、`element-plus`（card/date-picker/select/option/button/table/table-column/tag/pagination/icon 由 `plugins/element-plus.ts` 注册）。
- 图标以字符串引用（`'Search'` `:111`、`'Refresh'` `:115`），依赖 `main.ts:77-78` 的全局图标注册（注册清单见 `.qoder/admin/src/main.ts.md`）。
- 被依赖：`admin/src/router/index.ts:80-85`（`/audit` 懒加载）。
- 数据来源：`audit_logs` 表（建表与索引见 `docker/init/010_admin_identity.sql:102-103`：`ix_audit_logs_created_at`、`ix_audit_logs_target`）；写入方为后端各服务（`access_service`、`invite_service`、`org_service`、`identity_service`、`activity_service`、`auth_service` 及 `api/routes/admin.py`、`org.py`、`quiz.py`）。
- 关联页面：本页展示的动作绝大多数由 `views/AccessView.vue`、`views/InvitesView.vue`、`views/ActivityView.vue` 的操作产生；`access`/`audit` 两菜单码的授予在 `views/AccessView.vue` 的「角色管理」标签完成。

## 7. 业务规则

1. **只读**：审计日志无增删改（§4.7）；后端也未向管理端暴露删除/修改审计的接口。
2. **权限**：需 `audit` 菜单码；种子数据默认只让超级管理员可见（`docker/init/010_admin_identity.sql:105`、`:117-123`），其他角色须由「人员授权 → 角色管理」显式勾选（`admin/src/router/menus.ts:13`）。
3. **排序固定**：`id desc`（`access_service.py:421`），即最新在前；页面不提供排序切换。
4. **时区口径**：库内存 UTC naive，展示按浏览器本地时区（§4.4）；日期筛选按**本地日界**换算成 UTC 区间（`access_service.py:413-418`），因此「今天」的边界与运维直觉一致。
5. **分页口径**：`total` 为筛选条件下的总条数（`access_service.py:419`），单页 ≤ 100（`admin.py:1027`），前端固定 20（`:12`）。
6. **操作人类型**只有 `super`（内置账号口令/超管令牌）与 `user`（微信关联管理员）两种（`admin.py:1029`、`access_service.py:41-42` 的 `ACTOR_SUPER`/`ACTOR_USER`）。
7. **动作码回退**：未登记进 `ACTION_TEXT` 的动作码原样显示并着 `info` 标签（`:74-80`、`:131`），不会因缺映射而渲染失败。
8. 敏感信息：`detail` 内容由后端脱敏后写入（如邀请码准入链路明确「日志/响应脱敏，不含 openid/session_key」，见 `docs/迭代记录.md` 的 `afbcba9` 条目），本页原样展示、不做二次加工，也不应在此处补充明文敏感字段。

## 8. 修改约束

- **不得改为前端全量过滤**：审计表随活动持续写入，必须保持服务端分页 + 服务端筛选（根 `agents.md` §2.4）；`page_size` 上限受后端 `le=100` 约束（`admin.py:1027`），放开需后端同步。
- 新增后端审计动作码时同步维护 `ACTION_TEXT`（`:51-72`）与 `actionTagType`（`:74-80`）；只加后端不加前端不会报错，但记录只显示原始码（可用、体验降级）。
- 时间展示必须继续走 `utils/format.ts` 的 `formatDateTime`，不得再引入页面私有格式化函数（`30b4458` 已收敛过一次，见 §4.4）。
- `actor_type` 取值范围是「前端下拉 / 后端 `pattern` / `access_service` 常量」三方契约，新增类型需三处同步（`:107-110`、`admin.py:1029`、`access_service.py:41-42`）。
- 本页是只读页，**不要在此加写操作**（如「清除日志」「标记已读」）；若确有需求须先在后端补权限与审计（清除审计本身也需留痕），并同步 `.qoder/ARCHITECTURE.md` §5.3。
- 表格 `row-key="id"`（`:118`）用于行复用，增删列时保留；详情列的 `show-overflow-tooltip`（`:141`）是长文本溢出的唯一防线，去掉会导致行高失控。
- 视觉：需覆盖加载、空状态、筛选与窄屏可用性（`admin/agents.md`「开发约定」第 3 条）；本页空态目前只有 Element Plus 默认文案（§9 第 3 项）。

## 9. 当前实现状态

- **已实现**：服务端分页列表、三维筛选（日期/动作/操作人类型）、重置、刷新、动作码中文化与配色、时间本地化（含秒）、操作人与目标昵称展示，均可用；历次浏览器验收见 §10。
- **已实现且符合规范**：**服务端分页**（`:20-26` + `access_service.py:419-425`），非前端全量过滤，满足根 `agents.md` §2.4；**确无写操作入口**（§4.7）；**未订阅 WebSocket**（§4.8）；**时间格式化与其它页面一致**（同用 `utils/format.ts` 的 `formatDateTime`，未发现重复实现）。
- **存在问题 / 已知事项**：
  1. **缺请求竞态守卫**：`loadLogs`（`:17-32`）拿到响应即无条件写 `logs`/`total`，没有 `views/AccessView.vue` 那样的序号守卫（对比 `AccessView.vue:49`、`:62`、`:66`）。快速连点「查询」/翻页/改筛选时，先发的慢响应可能覆盖后发的快响应，出现「条件与结果不匹配」。`30b4458` 的「请求竞态守卫」只落到部分页面——该提交对本文件的改动仅含时间格式化（§10），属**同类逻辑覆盖不全**，建议按 AccessView 的 `requestSeq` 模式补齐。
  2. `ACTION_TEXT`（`:51-72`）缺 3 个后端仍在写入的动作码：`org.select`（`backend/app/api/routes/org.py`、`backend/app/api/routes/admin.py`）、`quiz.answer` 与 `quiz.reset`（`backend/app/api/routes/quiz.py`）。这些记录会显示原始码 + `info` 标签（回退逻辑正常，不报错），但无法从下拉直接选中，需手输（`allow-create`）。
  3. 无自定义空态与错误态：请求失败时表格保留上一次数据（`:27-28` 只在成功路径执行），用户可能把旧结果误读为最新；空结果只有 Element Plus 默认「暂无数据」，未区分「无记录」与「筛选过严」。
  4. 日期筛选只有单日粒度，无起止范围（`:88-95`），跨日排查需逐日查询。是否需要范围选择**待确认**（未见相关需求条目）。
  5. 本页无导出入口。审计日志导出是否属需求范围**待确认**（`admin/agents.md`「开发约定」第 4 条对导出有 CSV 公式注入防护要求，若新增导出须遵守）。
  6. `loadLogs` 无 `catch`（`:19-31`），失败时产生未处理的 Promise rejection（仅控制台噪声，用户已见拦截器 toast）——与 `views/AccessView.vue` §9 同一模式。
  7. `pageSize` 固定 20 且分页器无每页条数选择器（`:12`、`:151`），排查大批量记录时只能逐页翻。
- **待开发**：无本页专属待办；AI 智能中心若引入 `ai_*` 类审计动作，需同步 `ACTION_TEXT`（`.qoder/admin/src/router/index.ts.md` §9「待开发」）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/views/AuditView.vue`，共 **3 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-13（`e197a28`）
- 需求：V2.0 管理后台——审计动作中文化（同批含活动设置页、排名洞察积分化、人员组织调整弹窗）。
- 修改内容（涉本文件）：共 +44/-9 行（`git show --numstat e197a28 -- admin/src/views/AuditView.vue` 实测）——① 新增 `ACTION_TEXT` 20 项动作码中文映射（`:51-72`）；② `actionTagType` 返回类型增加 `primary`，配色规则细化到 `user.disable`/`activity.*`/`points.*`/`user.org_change`（`:74-80`）；③ 动作筛选由 `el-input`（占位「按动作筛选（如 access.roles.grant）」）改为 `el-select` + `filterable allow-create default-first-option`，选项由 `ACTION_TEXT` 生成（`:96-106`）；④ 动作列改为「中文标签 + 灰色小字原始码」，新增 `.action-code` 样式（`:129-134`、`:181-185`）。
- 关联文件：`admin/src/views/AccessView.vue`（组织调整弹窗）、`admin/src/views/ActivityView.vue`、`backend/app/services/activity_service.py`（`activity.*` 动作）、`backend/app/services/points_service.py`（`points.recompute`）。
- 测试结果：见 `docs/迭代记录.md` 的 `e197a28` 条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复（本页涉及 1 项：审计时间本地化）。
- 修改内容（涉本文件）：删除页面私有 `formatTime`（原实现 `value.replace('T', ' ').slice(0, 19)`，把库内 UTC naive 串当本地时间直接显示），改为 `import { formatDateTime } from '../utils/format'`（`:6`）并在时间列调用 `formatDateTime(row.created_at, '—', true)`（`:121`），经 `parseUtc` 补 `Z` 后按浏览器本地时区格式化（含秒）。该提交对本文件**仅此一处改动**，未附带竞态守卫（§9 第 1 项）。
- 关联文件：`admin/src/utils/format.ts`、`admin/src/views/AccessView.vue`、`admin/src/views/LoginView.vue`、`admin/src/views/DashboardView.vue` 等 8 个视图。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-09（`54a0de7`）
- 需求：扫码登录与人员授权/审计页（P3 管理端 RBAC）。
- 修改内容（涉本文件）：创建本文件——审计日志分页列表 + 日期/动作/操作人类型筛选 + 动作标签配色（初版动作为自由文本输入、时间为私有 `formatTime`）。
- 关联文件：`admin/src/views/AccessView.vue`（新建）、`admin/src/views/LoginView.vue`、`admin/src/router/index.ts`（`/audit` 路由与菜单守卫）、`admin/src/api/admin.ts`（`fetchAuditLogs`）、`backend/app/api/routes/admin.py`（`/admin/audit-logs` + `require_menu("audit")`）、`backend/app/services/access_service.py`（`list_audit_logs`）、`docker/init/010_admin_identity.sql`（`admin_menus`/`audit_logs` 种子与建表）。
- 测试结果：见 `docs/迭代记录.md` 的 `54a0de7` 条目（浏览器验收 20/20，修复 3 处验收缺陷）。
