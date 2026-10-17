# AdminLayout.vue

## 1. 文件路径

`admin/src/layout/AdminLayout.vue`（53 行）

## 2. 文件职责

管理后台壳布局（`<script setup>` 单文件组件）：深色侧边栏（品牌区 + 按登录菜单权限过滤的 11 项菜单）+ 顶栏（页面标题、超管徽标、用户名、退出登录）+ 内容区 `<router-view>`。是 `/` 布局路由的父组件，10 个业务子页在其内容区渲染（`router/index.ts:27-93`）。

## 3. 业务需求

- 视觉语言要求：深色导航、长征红与鎏金强调色（`admin/agents.md`「开发约定」第 3 条）。
- `4a26520`（2026-09-30）创建；`54a0de7`（2026-10-09）接入菜单权限过滤与超管标识；`225f99c`（2026-10-11）顶栏加「入驻二维码」查看/下载弹窗；`30b4458` 菜单数组改读 `router/menus.ts`（单一来源）；`afbcba9`（2026-10-12）二维码功能整体迁出到 `views/InvitesView.vue`（本文件 -45 行）。

## 4. 核心功能

### 4.1 脚本区（`:1-22`）

- `username`（`:11`）：`getUsername() || 'admin'` 兜底展示。
- `isSuper`（`:12`）、`activeMenu = route.path`（`:13`）。
- `visibleMenus`（`:15`）：`MENUS.filter((item) => hasMenu(item.code))`——超管全量（`hasMenu` 内 `isSuper` 短路，`store/auth.ts:27-29`），普通管理员按登录时保存的菜单码过滤；`:2` 注释明确「路由守卫兜底」（本过滤只是 UI 层，越权直达 URL 由 `router/index.ts:113-116` 拦截、接口由后端 `require_menu` 拦截）。
- `handleLogout`（`:17-21`）：`ElMessageBox.confirm('确定退出登录吗？')` → `clearAuth()` → `router.push('/login')`。取消 confirm 会 reject，函数无 catch，产生未处理的 Promise rejection（仅控制台可见，无用户影响；现状事实）。

### 4.2 模板区（`:24-49`）

- `el-aside`（220px，`:26`）：品牌区「长征管理后台」+ Promotion 图标（`:27-30`）；`el-menu` 开 `router` 模式、`:default-active="activeMenu"`，深色配色内联属性 `background-color="#111827"` / `text-color="#94a3b8"` / `active-text-color="#f8d477"`（鎏金，`:31`）。
- 菜单项 `v-for="item in visibleMenus"`，`:key="item.path"`、`:index="item.path"`（router 模式下 index 即导航目标）；图标经 `<component :is="item.icon">` 动态解析（`:33`），依赖 `main.ts` 的全局图标注册。
- `el-header`（`:38-45`）：`route.meta.title` 页面标题（`:39`）；超管显示 `el-tag`「超级管理员」（warning/plain，`:41`）；UserFilled 图标 + 用户名（`:42`）；「退出登录」link 按钮（danger，`:43`）。
- `el-main` 内容区 `<router-view />`（`:46`）。

### 4.3 样式区（`:51-53`）

scoped、单行压缩写法。要点：`.layout{height:100%}`（依赖 `style.css:1-7` 的满高链）；菜单激活项背景为长征红→鎏金渐变 `linear-gradient(90deg, rgb(200 16 46/28%), rgb(248 212 119/8%))`（`rgb(200 16 46)` 即 `#C8102E` 长征红）；顶栏半透明白 + `backdrop-filter: blur(14px)`；`.main{padding:24px;background:#f4f6fa}`（与 `style.css:15` body 底色一致）。`:deep()` 穿透 el-menu 内部样式。

### 4.4 与实时推送、API 层的关系

本文件**不调用任何 `api/admin.ts` 函数、不订阅 WebSocket**——WS 实时刷新（`utils/liveUpdates.ts` 的 `useLiveUpdates`）由各数据页自行接入（`.qoder/ARCHITECTURE.md` §6.4：仅 Dashboard/Screen/Rankings 三页）。曾有的 `fetchOnboardingQr` 调用已随 `afbcba9` 迁出（§3）。

## 5. 输入与输出

- 输入：无 props/emits；隐式输入为 `store/auth` 的 localStorage 登录态与 `route.meta.title`（由 `router/index.ts` 各路由声明）。
- 输出：无；副作用仅退出登录（清 4 键 + 跳 `/login`）。
- 加载/空态/错误态：不适用（壳组件无异步数据）；`visibleMenus` 为空时侧边栏无菜单项，但该状态被路由守卫的「零菜单停留登录页」逻辑（`router/index.ts:107-111`）实际屏蔽。

## 6. 依赖关系

- 依赖：`vue`（computed）、`vue-router`（useRoute/useRouter）、`element-plus`（`ElMessageBox` 直接 import `:5`；el-container/aside/menu/menu-item/header/main/tag/button/icon 组件由 `plugins/element-plus.ts` 注册）、`../store/auth`（`:6`，4 个函数）、`../router/menus`（`:7`，MENUS）。
- 图标组件：Promotion、UserFilled 及 `MENUS.icon` 的 11 个图标名，全部依赖 `main.ts` 全局注册。
- 被依赖：`router/index.ts:29`（`/` 布局路由懒加载）。
- 与公共组件的关系：不引用 `components/`（ExcelImportDialog、AiGenerateDialog 由各视图自行使用）。

## 7. 业务规则

1. 菜单可见性 = `hasMenu(code)`（超管全量）；顺序 = `MENUS` 数组顺序（`router/menus.ts:3-15`）。
2. 高亮规则：`default-active` 绑定 `route.path`，菜单 `index` 即 path，router 模式点击即导航——`/screen` 是顶层路由（不在本布局内），从大屏页看不到侧边栏高亮属预期。
3. 退出登录必须二次确认（warning 弹窗）；确认后仅清除本地登录态并跳登录页，**不调用任何服务端登出接口**（现行代码无 logout 请求；后端令牌无服务端吊销机制，`.qoder/ARCHITECTURE.md` §5.1「无服务端会话存储、无 refresh token、无令牌黑名单」）。
4. 前端菜单过滤不是安全边界（§4.1），与 `store/auth.ts` §7.2 同一规则。

## 8. 修改约束

- **新菜单入口改 `router/menus.ts`，不改本文件**：`admin/agents.md`「开发约定」第 2 条写的是「在 `src/layout/AdminLayout.vue` 增加菜单入口」，该表述滞后于 `30b4458` 的菜单单一来源重构（现本文件仅消费 `MENUS`）——已作为文档滞后项在此记录，agents.md 本身不在本文档修改范围。
- 视觉不变量：深色导航（#111827）、长征红 #C8102E 与鎏金 #f8d477 强调色（`admin/agents.md`）；`.main` 背景与 `style.css` body 底色需保持同为 #f4f6fa。
- 顶栏元素依赖 `route.meta.title`：新增路由漏写 `meta.title` 时顶栏标题为空、浏览器标题退化为「管理后台」（`router/index.ts:103`）。
- `el-menu` 的深色配色写在模板内联属性上（`:31`），改主题需同时改内联属性与 scoped 样式两处。
- 不要在壳组件里加全局数据请求/WS 订阅（现状职责边界，见 §4.4）。

## 9. 当前实现状态

- **已实现**：布局、权限过滤菜单、退出登录全部可用；历次浏览器验收见 §10。
- **存在问题 / 已知事项**：
  1. `handleLogout` 取消确认时产生未捕获的 Promise rejection（§4.1，仅控制台噪声）。
  2. `admin/agents.md` 的「在 AdminLayout.vue 增加菜单入口」表述滞后（§8）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/layout/AdminLayout.vue`，共 **8 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-12（`afbcba9`）
- 需求：邀请码准入全链路。
- 修改内容（涉本文件）：删除顶栏「入驻二维码」按钮与弹窗（-45 行，含 `fetchOnboardingQr` 调用），功能迁入新建的 `views/InvitesView.vue`。
- 关联文件：`admin/src/views/InvitesView.vue`、`admin/src/router/menus.ts`（增 invites）。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复——菜单单一来源。
- 修改内容（涉本文件）：删除内联 `MENU_ITEMS` 数组（9 项），改为 `import { MENUS } from '../router/menus'` 并以其过滤渲染。
- 关联文件：`admin/src/router/menus.ts`（新建）、`admin/src/router/index.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-11（`225f99c`）
- 需求：顶栏员工入驻二维码查看与下载。
- 修改内容（涉本文件）：+47 行——顶栏「入驻二维码」按钮、弹窗（小程序码图片/场景码/环境标签）、`fetchOnboardingQr` 加载与下载逻辑（`afbcba9` 全部迁出）。
- 关联文件：`admin/src/api/admin.ts`、`admin/src/main.ts`（Iphone 图标）、`backend/app/services/wechat_service.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `225f99c` 条目。

### 2026-10-09（`54a0de7`）
- 需求：扫码登录与人员授权/审计页（P3 管理端）。
- 修改内容（涉本文件）：菜单改按 `hasMenu` 权限过滤、新增超管徽标（与 `store/auth.ts` 同批引入的 `getIsSuper`/`hasMenu` 对应；本文件逐行 diff 未核，以 `docs/迭代记录.md` 的 `54a0de7` 条目为准）。
- 关联文件：`admin/src/store/auth.ts`、`admin/src/router/index.ts`、`admin/src/views/AccessView.vue`。
- 测试结果：见 `docs/迭代记录.md` 的 `54a0de7` 条目（浏览器验收 20/20）。

### 2026-10-03（`71d1b9b`）
- 需求：每日寄语与节点纪念票（P2-1）。
- 修改内容（涉本文件）：随新增「每日寄语」页调整菜单项（本文件逐行 diff 未核，以 `docs/迭代记录.md` 的 `71d1b9b` 条目为准）。
- 关联文件：`admin/src/views/QuotesView.vue`、`admin/src/router/index.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `71d1b9b` 条目。

### 2026-10-02（`01ec93c`）
- 需求：驾驶舱与数据大屏页面。
- 修改内容（涉本文件）：随新增驾驶舱页调整菜单项；数据大屏为顶层全屏路由、不经本布局（本文件逐行 diff 未核，以 `docs/迭代记录.md` 的 `01ec93c` 条目为准）。
- 关联文件：`admin/src/views/DashboardView.vue`、`admin/src/views/ScreenView.vue`。
- 测试结果：见 `docs/迭代记录.md` 的 `01ec93c` 条目。

### 2026-10-01（`81b86e5`）
- 需求：排名洞察与路线节点维护页面。
- 修改内容（涉本文件）：随新增两页调整菜单项（本文件逐行 diff 未核，以 `docs/迭代记录.md` 的 `81b86e5` 条目为准）。
- 关联文件：`admin/src/pages/RankingsView.vue`、`admin/src/views/RouteNodesView.vue`、`admin/src/style.css`。
- 测试结果：见 `docs/迭代记录.md` 的 `81b86e5` 条目。

### 2026-09-30（`4a26520`）
- 需求：管理后台基础页面及依赖配置（初始批次）。
- 修改内容（涉本文件）：创建本文件（102 行初版：侧边菜单 + 顶栏 + 内容区）。
- 关联文件：`admin/src/main.ts`、`admin/src/router/index.ts`、`admin/src/style.css`。
- 测试结果：见 `docs/迭代记录.md` 的 `4a26520` 条目。
