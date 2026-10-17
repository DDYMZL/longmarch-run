# menus.ts

## 1. 文件路径

`admin/src/router/menus.ts`（15 行）

## 2. 文件职责

菜单目录的**唯一来源**：11 项 `{ code, path, title, icon }` 只读常量数组（`as const`），供侧边栏渲染、路由守卫的无权限回退顺序、角色菜单勾选与菜单名展示共用（`:1-2` 头注释明示四个消费方）。

## 3. 业务需求

- `30b4458`（2026-10-11，管理后台代码审查修复）创建，把原先内联在 `AdminLayout.vue` 的 `MENU_ITEMS` 抽出为单一来源（该提交 diff 可证：AdminLayout 删除 9 项内联数组改 import 本文件）。
- `afbcba9`（2026-10-12）追加 `invites`；`e197a28`（2026-10-13）追加 `activity`。
- 与数据库菜单种子保持一致：`:1` 注释指明对应 `docker/init/010_admin_identity.sql`（前 9 码）；`invites`/`activity` 分别由 `docker/init/015_invite_admission.sql`、`016_activity_settings.sql` 种入（`.qoder/backend/app/services/access_service.py.md` §7.5）。

## 4. 核心功能

### 4.1 `MENUS` 数组（`:3-15`）

| # | code（= 后端菜单码） | path | title | icon |
|---|---|---|---|---|
| 1 | `dashboard` | `/dashboard` | 驾驶舱 | Odometer |
| 2 | `screen` | `/screen` | 数据大屏 | Monitor |
| 3 | `rankings` | `/rankings` | 排名洞察 | DataAnalysis |
| 4 | `route_nodes` | `/route-nodes` | 路线点位 | Location |
| 5 | `questions` | `/questions` | 题库维护 | EditPen |
| 6 | `quotes` | `/quotes` | 每日寄语 | ChatLineSquare |
| 7 | `orgs` | `/orgs` | 组织架构 | OfficeBuilding |
| 8 | `access` | `/access` | 人员授权 | Setting |
| 9 | `invites` | `/invites` | 入驻邀请码 | Promotion |
| 10 | `audit` | `/audit` | 审计日志 | Document |
| 11 | `activity` | `/activity` | 活动设置 | Flag |

- **数组顺序 = 侧边栏顺序 = 无权限回退优先级**（`router/index.ts:9-12` 用 `MENUS.find` 取第一个有权项）。
- `icon` 是图标**组件名字符串**，依赖 `main.ts` 的全局图标注册，由 `AdminLayout.vue:33` 的 `<component :is="item.icon">` 解析。
- `code` 与 `path` 命名风格不同是刻意的：菜单码用下划线（`route_nodes`，与数据库 `admin_menus.code` 一致），路由路径用连字符（`/route-nodes`），见 `.qoder/backend/app/api/routes/admin.py.md:370`。

### 4.2 与后端菜单码的对应关系

11 个 `code` 与后端 `require_menu` 实际使用的 11 个码**一一对应、无多无少**（`.qoder/backend/app/api/routes/admin.py.md:372`）。数据库 `admin_menus` 另有 5 个 `ai_*` 码未登记于此——属「AI 管理子页面待开发」的预期状态，非缺陷（`.qoder/ARCHITECTURE.md` §16.1「5 个 ai_* 菜单码在 admin 前端缺失」行）。

## 5. 输入与输出

导出唯一常量 `MENUS`（`as const` 只读元组，字面量类型）。无函数、无副作用、无异步。

## 6. 依赖关系

- 依赖：无（纯常量，零 import）。
- 被依赖：`layout/AdminLayout.vue:7`/`:15`（侧边栏过滤渲染）、`router/index.ts:6`/`:10`（`firstAllowedPath` 回退顺序）；`:2` 注释还声明「角色菜单勾选与菜单名展示共用」——即 `views/AccessView.vue`（角色管理弹窗的菜单勾选列表，具体引用行属该视图文档范围）。
- 一致性契约（非代码依赖）：数据库 `admin_menus` 种子（`docker/init/010/015/016`）、后端 `require_menu` 码、`router/index.ts` 的 `meta.menu`。

## 7. 业务规则

1. `code` 是前后端权限契约：后端按同码 `require_menu(code)` 校验（403），前端仅用它做菜单过滤与守卫回退（体验层）。
2. 超管不经此过滤逻辑判断——`hasMenu` 内部 `isSuper` 短路（`store/auth.ts:27-29`），`MENUS` 仍决定超管侧边栏的全量渲染与顺序。
3. `admin_menus.sort_order` 在数据库中存在重号（`invites`=10 与 `ai_overview`=10、`activity`=11 与 `ai_knowledge`=11），但**侧边栏顺序由本数组决定，不受影响**（`.qoder/ARCHITECTURE.md` §16.1「admin_menus.sort_order 真实重号」行）。

## 8. 修改约束

- 新增菜单码必须四处同步（`.qoder/backend/app/services/access_service.py.md` §8）：① `docker/init` 新增编号迁移（禁止改已执行脚本）② 后端路由 `require_menu(code)` ③ 本文件 ④ 若带新审计 action 码则 `views/AuditView.vue` 的 `ACTION_TEXT`。漏掉本文件则页面无入口；写错 `code` 则非超管永久 403 且无报错。
- 调整数组顺序会同时改变侧边栏顺序与「无权限时的回退落地页」优先级，属行为变更而非纯样式变更。
- `as const` 不可去掉（消费方依赖字面量类型）；`icon` 值必须是 `main.ts` 已注册的图标名。
- `title` 同时是浏览器标签页与顶栏标题的来源之一（经 `router/index.ts` 各路由 `meta.title`，两处文案目前逐字一致，改一处需同步另一处——`meta.title` 并不读本文件）。

## 9. 当前实现状态

- **已实现**：11 项菜单与后端码、路由表三方一致（§4.2）。
- **存在问题**：无本文件自身缺陷。相关已知项：`meta.title` 与本文件 `title` 是两份手工同步的文案（`router/index.ts` 未复用 `MENUS`），属轻微冗余，未见总览文档记录。
- **待开发**：5 个 `ai_*` 菜单（后端接口仅 3 个就绪，`.qoder/ARCHITECTURE.md` §11.3）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/router/menus.ts`，共 **3 个提交**（本文件由 `30b4458` 创建），按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-13（`e197a28`）
- 需求：V2.0 管理后台——活动设置页。
- 修改内容（涉本文件）：追加 `{ code: 'activity', path: '/activity', title: '活动设置', icon: 'Flag' }`（`:14`）。
- 关联文件：`admin/src/router/index.ts`、`admin/src/views/ActivityView.vue`、`docker/init/016_activity_settings.sql`。
- 测试结果：见 `docs/迭代记录.md` 的 `e197a28` 条目。

### 2026-10-12（`afbcba9`）
- 需求：邀请码准入全链路。
- 修改内容（涉本文件）：追加 `{ code: 'invites', path: '/invites', title: '入驻邀请码', icon: 'Promotion' }`（`:12`）。
- 关联文件：`admin/src/router/index.ts`、`admin/src/views/InvitesView.vue`、`docker/init/015_invite_admission.sql`。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复——菜单单一来源。
- 修改内容（涉本文件）：创建本文件，初始 9 项（dashboard/screen/rankings/route_nodes/questions/quotes/orgs/access/audit）。
- 关联文件：`admin/src/layout/AdminLayout.vue`（删除内联 `MENU_ITEMS` 改用本文件）、`admin/src/router/index.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。
