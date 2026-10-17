# index.ts（router）

## 1. 文件路径

`admin/src/router/index.ts`（120 行）

## 2. 文件职责

管理后台路由表与全局前置守卫：14 条路由记录（登录页、顶层全屏数据大屏、`AdminLayout` 布局下 10 个业务子页、通配重定向），承担未登录拦截、菜单权限拦截与 `document.title` 设置。

## 3. 业务需求

- 需求出处：`.qoder/REQUIREMENTS.md` §11「管理后台功能」（§11.1 菜单与权限）；`.qoder/ARCHITECTURE.md` §5.6「路由守卫」。
- `4a26520`（2026-09-30）创建基础路由；`54a0de7`（2026-10-09）引入登录守卫 + 菜单权限守卫（P3 管理端 RBAC 批次）；`30b4458` 回退顺序改读 `router/menus.ts`（菜单单一来源）；`afbcba9`、`e197a28` 分别扩邀请码与活动设置路由。

## 4. 核心功能

### 4.1 路由表（`:14-95`）

| path | name | 组件（全部懒加载） | meta.menu 权限码 | 行号 |
|---|---|---|---|---|
| `/login` | login | `../views/LoginView.vue` | 无（公开） | `:15-20` |
| `/screen` | screen | `../views/ScreenView.vue`（顶层全屏，不套布局） | `screen` | `:21-26` |
| `/` | — | `../layout/AdminLayout.vue`，`redirect: '/dashboard'` | — | `:27-93` |
| `dashboard` | dashboard | `../views/DashboardView.vue` | `dashboard` | `:32-37` |
| `rankings` | rankings | **`../pages/RankingsView.vue`** | `rankings` | `:38-43` |
| `route-nodes` | route-nodes | `../views/RouteNodesView.vue` | `route_nodes` | `:44-49` |
| `questions` | questions | `../views/QuestionsView.vue` | `questions` | `:50-55` |
| `quotes` | quotes | `../views/QuotesView.vue` | `quotes` | `:56-61` |
| `orgs` | orgs | `../views/OrgsView.vue` | `orgs` | `:62-67` |
| `access` | access | `../views/AccessView.vue` | `access` | `:68-73` |
| `invites` | invites | `../views/InvitesView.vue` | `invites` | `:74-79` |
| `audit` | audit | `../views/AuditView.vue` | `audit` | `:80-85` |
| `activity` | activity | `../views/ActivityView.vue` | `activity` | `:86-91` |
| `/:pathMatch(.*)*` | — | 重定向 `/` | — | `:94` |

每条业务路由 `meta` 均含 `title`（用于 `document.title` 与 `AdminLayout` 顶栏）与 `menu`（权限码，与 `router/menus.ts` 的 `code` 逐字一致）。注意 path 用连字符（`route-nodes`）而菜单码用下划线（`route_nodes`），见 `.qoder/backend/app/api/routes/admin.py.md:370`。

### 4.2 `firstAllowedPath()`（`:9-12`）

按 `MENUS` 数组顺序（即侧边栏顺序）找第一个 `hasMenu(code)` 命中的菜单返回其 path；全都不命中时返回 `'/login'`——该返回值同时被守卫用作「已登录但零菜单时停留登录页」的哨兵（`:110`）。

### 4.3 全局前置守卫（`:102-118`）

按序四步：
1. 设置 `document.title` 为 `${meta.title || '管理后台'} · 长征运动挑战`（`:103`）。
2. 非 `/login` 且 `!isLoggedIn()` → 重定向 `/login?redirect=<fullPath>`（`:104-106`），登录成功后由 `LoginView.vue:27-30` 消费 `redirect` 参数回跳。
3. 已登录访问 `/login` → 跳 `firstAllowedPath()`；若无任何可用菜单则放行停留登录页（`:107-111`，`:108` 注释：避免 `/login ↔ /dashboard` 重定向死循环）。
4. 菜单权限守卫：目标路由声明了 `meta.menu` 且 `!hasMenu(menu)` → 回退 `firstAllowedPath()`（`:113-116`，`:112` 注释：避免与默认重定向互相跳转成环）。

### 4.4 history 模式（`:97-100`）

`createWebHistory()`（HTML5 history）。生产环境依赖 nginx 对静态站点的 SPA 回退重写——nginx 配置不在仓库内（`.qoder/ARCHITECTURE.md` §12.2「nginx 配置文件」行），是否已配置回退**待确认**。

### 4.5 `pages/` 与 `views/` 目录并存核实（任务要求专项）

- 仅 `rankings` 一条从 `../pages/RankingsView.vue` 导入（`:41`），其余 11 个业务页面全部从 `../views/` 导入；两者都是同样的懒加载 `import()`，vue-router 对目录无任何差别对待，**该拆分无功能效果**（无独立 chunk 策略、无守卫差异、无构建配置区分）。
- 溯源：`git log --follow` 显示 `RankingsView.vue` 由 `81b86e5`（2026-10-01「管理后台新增排名洞察与路线节点维护页面」）一次性引入 `pages/` 目录，同批的 `RouteNodesView.vue` 却放在 `views/`；代码注释、提交信息与 `docs/迭代记录.md` 的 `81b86e5` 条目均未说明理由。
- 与 `.qoder/PROJECT.md` §8「代码级技术债」第 19 项、`.qoder/ARCHITECTURE.md` §15 第 9 项、§16 第 8 项记录一致；是否统一到 `views/` 仍**待确认**（用户未决策）。

## 5. 输入与输出

- 输入：浏览器 URL；`store/auth` 的登录态（`isLoggedIn`/`hasMenu`）。
- 输出：默认导出 `router` 实例（`:120`）；副作用为导航与 `document.title`。
- 守卫返回值语义：`true` 放行；`{path, query?}` 重定向。无异常抛出。

## 6. 依赖关系

- 依赖：`vue-router`；`../store/auth`（`:5`）；`./menus`（`:6`，`MENUS` 单一来源）；12 个视图组件 + `AdminLayout.vue`（懒加载）。
- 被依赖：`main.ts:37`/`:81`（装载）；`api/request.ts:5`（401 时读 `currentRoute` 判断是否登录页并 `push('/login')`）；`App.vue:2` 的 `<router-view>`。
- 后端契约：11 个 `meta.menu` 码与后端 `require_menu` 使用的 11 个码一一对应（`.qoder/backend/app/api/routes/admin.py.md:353-372`）；数据库 `admin_menus` 另有 5 个 `ai_*` 码未登记于此（AI 管理子页面待开发，预期状态，`.qoder/backend/app/services/access_service.py.md` §7.5）。
- 不直接调用 `api/admin.ts`，不订阅 WebSocket。

## 7. 业务规则

1. **登录守卫**：未登录访问任何非 `/login` 路由一律带 `redirect` 参数跳登录页（`:104-106`）。
2. **菜单权限守卫**：按 `meta.menu` 码做前端拦截，无权回退第一个可用菜单（`:113-116`）。
3. **前端拦截仅体验层**：真实权限校验在后端——权限不写入令牌，`get_current_admin` 每请求查库经 `access_service.build_principal` 重建（`.qoder/ARCHITECTURE.md` §5.3 与 §14 不变量 8）；篡改 localStorage 菜单只会得到后端 403。
4. **防死循环设计**：`isLoggedIn` 要求令牌 + 权限档案并存（`store/auth.ts:49-52`）、零菜单停留登录页（`:107-111`）、菜单回退用 `firstAllowedPath` 而非固定 `/dashboard`（`:113-116`），三处配合消除重定向环。
5. 权限粒度到菜单/路由级，**无按钮级权限**（`.qoder/PROJECT.md` §8「代码级技术债」第 20 项）。
6. `/screen` 是顶层路由但同样受登录与 `screen` 菜单码守卫（守卫按 `to.path !== '/login'` 与 `meta.menu` 判断，与是否套布局无关）。

## 8. 修改约束

- **菜单码三方一致**：`meta.menu`、`router/menus.ts` 的 `code`、后端 `require_menu(code)` 必须逐字相同；写错不会报错，只会让所有非超管永久 403（`.qoder/backend/app/api/routes/admin.py.md:429`）。新增菜单码还须先落 `docker/init` 迁移（`access_service.py.md` §8）。
- 新页面注册路由后须同步 `router/menus.ts`（侧边栏与回退顺序的单一来源）——只加路由不加菜单，页面将无入口且回退顺序不含它。
- 守卫内三步判断的顺序（登录 → 登录页回跳 → 菜单权限）不可调换；`firstAllowedPath` 的兜底 `'/login'` 哨兵语义（`:11`）与 `:110` 的停留判断耦合，不得单改。
- 通配路由（`:94`）必须保持在路由表末位。
- `redirect` query 是 `LoginView` 回跳契约（`views/LoginView.vue:28`），改参数名需双处同步。

## 9. 当前实现状态

- **已实现**：14 条路由 + 四步守卫全部可用；历次浏览器验收见 §10 各条目。
- **存在问题 / 已知事项**：
  1. `pages/` 与 `views/` 目录并存且无功能区分（§4.5，`.qoder/PROJECT.md` §8 第 19 项），是否统一待确认。
  2. 无按钮级权限（`.qoder/PROJECT.md` §8 第 20 项），敏感操作依赖后端二次校验兜底。
  3. 生产 nginx 的 SPA 回退配置未核实（§4.4）。
- **待开发**：5 个 AI 管理子页面路由（后端 `ai_knowledge`/`ai_workshop`/`ai_config` 接口已就绪，`.qoder/ARCHITECTURE.md` §11.3）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/router/index.ts`，共 **8 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-13（`e197a28`）
- 需求：V2.0 管理后台——活动设置页等。
- 修改内容（涉本文件）：新增 `/activity` 子路由（`activity` 菜单码，`:86-91`）。
- 关联文件：`admin/src/views/ActivityView.vue`、`admin/src/router/menus.ts`、`backend/app/api/routes/admin.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `e197a28` 条目。

### 2026-10-12（`afbcba9`）
- 需求：邀请码准入全链路。
- 修改内容（涉本文件）：新增 `/invites` 子路由（`invites` 菜单码，`:74-79`）。
- 关联文件：`admin/src/views/InvitesView.vue`、`admin/src/router/menus.ts`、`admin/src/layout/AdminLayout.vue`。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复（菜单单一来源等）。
- 修改内容（涉本文件）：`firstAllowedPath` 的菜单顺序改读新建的 `router/menus.ts`（该提交创建 `MENUS` 数组，`:1-2` 注释「侧边栏渲染、无权限回退顺序……共用」）；本文件逐行 diff 未核，细节以 `docs/迭代记录.md` 的 `30b4458` 条目为准。
- 关联文件：`admin/src/router/menus.ts`（新建）、`admin/src/layout/AdminLayout.vue`。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-09（`54a0de7`）
- 需求：扫码登录与人员授权/审计页（P3 管理端）。
- 修改内容（涉本文件）：新增 `/access`、`/audit` 子路由；引入登录守卫与菜单权限守卫（提交信息「菜单权限守卫与回退」；守卫现行实现即该批次引入、`30b4458` 微调）。
- 关联文件：`admin/src/views/AccessView.vue`、`admin/src/views/AuditView.vue`、`admin/src/store/auth.ts`（hasMenu/isLoggedIn）。
- 测试结果：见 `docs/迭代记录.md` 的 `54a0de7` 条目（浏览器验收 20/20）。

### 2026-10-03（`71d1b9b`）
- 需求：每日寄语与节点纪念票（P2-1）。
- 修改内容（涉本文件）：新增 `/quotes` 子路由（`quotes` 菜单码）。
- 关联文件：`admin/src/views/QuotesView.vue`、`backend/app/api/routes/admin.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `71d1b9b` 条目。

### 2026-10-02（`01ec93c`）
- 需求：驾驶舱与数据大屏页面。
- 修改内容（涉本文件）：新增 `/dashboard` 子路由与顶层 `/screen` 全屏路由；`/` 重定向目标指向 dashboard。
- 关联文件：`admin/src/views/DashboardView.vue`、`admin/src/views/ScreenView.vue`。
- 测试结果：见 `docs/迭代记录.md` 的 `01ec93c` 条目。

### 2026-10-01（`81b86e5`）
- 需求：排名洞察与路线节点维护页面。
- 修改内容（涉本文件）：新增 `/rankings`（**组件取自 `../pages/`**，目录拆分即源于此，§4.5）与 `/route-nodes` 子路由。
- 关联文件：`admin/src/pages/RankingsView.vue`、`admin/src/views/RouteNodesView.vue`、`admin/src/style.css`。
- 测试结果：见 `docs/迭代记录.md` 的 `81b86e5` 条目。

### 2026-09-30（`4a26520`）
- 需求：管理后台基础页面及依赖配置（初始批次）。
- 修改内容（涉本文件）：创建本文件（51 行：登录页 + 布局 + 题库/组织等基础子路由，无权限守卫）。
- 关联文件：`admin/src/main.ts`、`admin/src/layout/AdminLayout.vue`、`admin/src/views/LoginView.vue`。
- 测试结果：见 `docs/迭代记录.md` 的 `4a26520` 条目。
