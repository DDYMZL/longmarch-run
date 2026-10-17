# main.ts

## 1. 文件路径

`admin/src/main.ts`（82 行）

## 2. 文件职责

管理后台 SPA 的应用入口：创建 Vue 应用实例，按需全局注册 30 个 Element Plus 图标组件，调用 `plugins/element-plus.ts` 完成组件/指令/语言包注册，装载路由与全局样式后挂载到 `#app`。

## 3. 业务需求

- 管理后台基础工程搭建，`4a26520`（2026-09-30）创建（`docs/迭代记录.md` 的 `4a26520` 条目）。
- `4e453a4`（2026-10-02）把 Element Plus 从全量注册改为按需注册（`docs/迭代记录.md` 的 `4e453a4` 条目），本文件随之从 `import * as ElementPlusIconsVue` 全量图标注册改为显式清单。
- 图标全局注册同时支撑三种用法：模板直接写 `<Refresh />`、字符串引用 `:icon="'Refresh'"`（`:41` 注释明示，实例见 `admin/src/views/ActivityView.vue:178`）、以及 `router/menus.ts` 的 `icon` 字段经 `AdminLayout.vue:33` 的 `<component :is>` 动态解析——后两种都依赖「组件已按名全局注册」这一前提。

## 4. 核心功能

### 4.1 图标按需全局注册（`:2-34`、`:42-79`）

- `:2-34` 从 `@element-plus/icons-vue` 显式 import 30 个图标；`:42-74` 组成 `icons` 对象（键 = 组件名，PascalCase）；`:77-79` 遍历 `app.component(key, component)` 逐个全局注册。
- 30 个图标中 28 个在 `admin/src` 其余文件有实际引用（含 `router/menus.ts` 的字符串字段），**2 个为死注册**（见 §9）。

### 4.2 应用装配（`:76-82`）

顺序：`createApp(App)`（`:76`）→ 注册图标（`:77-79`）→ `setupElementPlus(app)`（`:80`）→ `app.use(router)`（`:81`）→ `app.mount('#app')`（`:82`）。全部注册均先于挂载完成。

### 4.3 全局样式引入（`:39`）

`import './style.css'` 是唯一的全局 CSS 引入点；Element Plus 组件样式在 `plugins/element-plus.ts:49-92` 按组件引入，不经本文件。

## 5. 输入与输出

无导出（副作用模块）。输入为宿主页面的 `#app` 挂载节点；输出为已挂载的应用实例。装配失败（如组件解析失败）表现为运行时 Vue 警告，无错误码。

## 6. 依赖关系

- 依赖：`vue`、`@element-plus/icons-vue`、`./App.vue`、`./router`（`router/index.ts`）、`./plugins/element-plus`、`./style.css`。
- 被依赖：应用装配链顶层，`admin/src` 内无 import 方（由 Vite 入口 `admin/index.html` 加载；该引用细节属 `index.html` 文档范围）。
- 不调用任何 `api/admin.ts` 接口，不订阅 WebSocket。

## 7. 业务规则

无业务逻辑。约定：图标注册键必须与模板/字符串引用名一致（PascalCase）；`router/menus.ts` 新增菜单时其 `icon` 字段值必须是本文件已注册的图标名，否则 `<component :is>` 解析为空。

## 8. 修改约束

- 新增图标需在 import 段（`:2-34`）与 `icons` 对象（`:42-74`）各加一行（`:41` 注释即此约定）；删除图标前先全仓 grep 字符串引用（`menus.ts` 的 icon 字段与 `:icon="'Xxx'"` 不会被组件标签 grep 命中）。
- 不得回退为 Element Plus / 图标全量注册——`4e453a4` 专为体积优化改为按需（`plugins/element-plus.ts:2` 注释：约省 700KB+）。
- `setupElementPlus` 与 `app.use(router)` 必须在 `mount` 之前；本文件不得写业务逻辑。

## 9. 当前实现状态

- **已实现**：入口装配完整可用，随历次批次交付（见 §10）。
- **存在问题（死代码，2026-10-17 grep 实测）**：
  1. `Iphone`（`:14`、`:54`）：`225f99c` 为 AdminLayout 顶栏「入驻二维码」按钮引入，`afbcba9` 将该功能移入 `views/InvitesView.vue` 并删除按钮，本文件未同步清理，现全 `admin/src` 无引用。
  2. `Timer`（`:28`、`:68`）：`e197a28`（V2.0 活动设置/排名积分化批次）引入，现全 `admin/src` 无引用；引用点何时被移除**待确认**（需逐提交排查 `e197a28` 之后的视图改动）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/main.ts`，共 **8 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-16（`ea58b6c`）
- 需求：题库接入 CloudBase Agent AI 出题。
- 修改内容（涉本文件）：新增 `MagicStick` 图标注册（AI 出题入口按钮，`views/QuestionsView.vue` / `components/AiGenerateDialog.vue` 使用）。
- 关联文件：`admin/src/components/AiGenerateDialog.vue`、`backend/app/api/routes/ai_admin.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `ea58b6c` 条目。

### 2026-10-13（`e197a28`）
- 需求：V2.0 管理后台（活动设置页、排名洞察积分化）。
- 修改内容（涉本文件）：新增 `Coin`/`Flag`/`Medal`/`Timer`/`Trophy` 5 个图标（Flag 为活动设置菜单图标；Timer 现已无引用，见 §9）。
- 关联文件：`admin/src/views/ActivityView.vue`、`admin/src/pages/RankingsView.vue`、`admin/src/router/index.ts`、`admin/src/router/menus.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `e197a28` 条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复。
- 修改内容（涉本文件）：新增 `FolderOpened`/`Upload` 图标（通用 Excel 导入弹窗 `components/ExcelImportDialog.vue` 使用）。
- 关联文件：`admin/src/components/ExcelImportDialog.vue`、`admin/src/router/menus.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-11（`225f99c`）
- 需求：顶栏员工入驻二维码查看与下载。
- 修改内容（涉本文件）：新增 `Iphone` 图标注册（顶栏按钮；`afbcba9` 删除按钮后成为死代码，见 §9）。
- 关联文件：`admin/src/layout/AdminLayout.vue`、`admin/src/api/admin.ts`、`backend/app/services/wechat_service.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `225f99c` 条目。

### 2026-10-09（`54a0de7`）
- 需求：扫码登录与人员授权/审计页（P3 管理端）。
- 修改内容（涉本文件）：新增 `Document`/`Setting` 图标（审计日志、人员授权菜单图标）。
- 关联文件：`admin/src/views/LoginView.vue`、`admin/src/views/AccessView.vue`、`admin/src/views/AuditView.vue`、`admin/src/router/index.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `54a0de7` 条目。

### 2026-10-03（`71d1b9b`）
- 需求：每日寄语与节点纪念票（P2-1）。
- 修改内容（涉本文件）：新增 `ChatLineSquare` 图标（每日寄语菜单图标）。
- 关联文件：`admin/src/views/QuotesView.vue`、`admin/src/router/index.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `71d1b9b` 条目。

### 2026-10-02（`4e453a4`）
- 需求：echarts 与 Element Plus 改为按需引入（体积优化）。
- 修改内容（涉本文件）：删除 `import ElementPlus`、全量图标注册与 `dist/index.css`；改为显式 import 20 个图标 + 调用新建的 `setupElementPlus`。
- 关联文件：`admin/src/plugins/element-plus.ts`（新建）。
- 测试结果：见 `docs/迭代记录.md` 的 `4e453a4` 条目。

### 2026-09-30（`4a26520`）
- 需求：管理后台基础页面及依赖配置（初始批次）。
- 修改内容（涉本文件）：创建本文件。
- 关联文件：`admin/src/App.vue`、`admin/src/router/index.ts`、`admin/src/api/request.ts`、`admin/src/store/auth.ts` 等。
- 测试结果：见 `docs/迭代记录.md` 的 `4a26520` 条目。
