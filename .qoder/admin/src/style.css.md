# style.css

## 1. 文件路径

`admin/src/style.css`（18 行）

## 2. 文件职责

全局基础样式：html/body/#app 满高与边距清零、全局 `border-box` 盒模型、body 字体栈与页面底色。是全应用唯一一份非 scoped、非组件库的全局 CSS。

## 3. 业务需求

PC 管理后台全局视觉基线，随初始批次 `4a26520`（2026-09-30）创建；`81b86e5`（2026-10-01，排名洞察与路线节点页批次）调整底色并补盒模型/字体渲染属性。

## 4. 核心功能

### 4.1 满高与重置（`:1-7`）

`html, body, #app { height: 100%; margin: 0; padding: 0 }`——为 `layout/AdminLayout.vue:52` 的 `.layout{height:100%}` 及 el-container 全屏布局提供高度链前提；缺失时侧边栏无法撑满视口。

### 4.2 全局盒模型（`:9-11`）

`* { box-sizing: border-box }`——影响包括 Element Plus 内部元素在内的所有组件，`81b86e5` 引入。

### 4.3 body 字体与底色（`:13-18`）

字体栈 Helvetica Neue / PingFang SC / Microsoft YaHei；底色 `#f4f6fa`（`81b86e5` 由 `#f5f7fa` 改来，与 `AdminLayout.vue:52` `.main{background:#f4f6fa}` 一致）；抗锯齿与文本渲染优化两属性。

README §5「Vue3 管理后台」补充要点（路由权限码、表格/弹窗、分页、WebSocket 等）对本文件均不适用——它不含任何业务逻辑与组件交互。

## 5. 输入与输出

无导入导出（纯 CSS）。唯一加载点：`admin/src/main.ts:39` `import './style.css'`。

## 6. 依赖关系

- 依赖：无。
- 被依赖：`main.ts`（全局生效）；与 `plugins/element-plus.ts:49-92` 的组件样式、各 `.vue` 文件 scoped 样式共存（打包顺序上组件样式先于本文件被求值，但实际优先级由选择器决定）。
- 主题色事实：本文件**未定义** CSS 变量；长征红（`#C8102E`/`rgb(200 16 46)`）与鎏金（`#f8d477`）等主题色散落在各组件 scoped 样式中（如 `AdminLayout.vue:52`）。

## 7. 业务规则

无。

## 8. 修改约束

- 改 body 底色需同步 `AdminLayout.vue:52` `.main` 的背景色（当前两处同为 `#f4f6fa`，无变量关联，纯手工一致）。
- `*` 通配选择器覆盖 Element Plus 内部结构，新增全局规则（尤其标签选择器、reset 类规则）可能波及组件库样式，需浏览器实测（`admin/agents.md`「必做验证」）。

## 9. 当前实现状态

已实现，无已知问题。主题色无 CSS 变量收敛属现状事实（是否重构无排期证据，不作为缺陷记录）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/style.css`，共 **2 个提交**，按时间倒序。

### 2026-10-01（`81b86e5`）
- 需求：管理后台新增排名洞察与路线节点维护页面。
- 修改内容（涉本文件）：新增 `* { box-sizing: border-box }`；body 底色 `#f5f7fa` → `#f4f6fa`；补 `-webkit-font-smoothing` 与 `text-rendering` 两属性。
- 关联文件：`admin/src/pages/RankingsView.vue`、`admin/src/views/RouteNodesView.vue`、`admin/src/router/index.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `81b86e5` 条目。

### 2026-09-30（`4a26520`）
- 需求：管理后台基础页面及依赖配置（初始批次）。
- 修改内容（涉本文件）：创建本文件（满高重置 + body 字体/底色）。
- 关联文件：`admin/src/main.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `4a26520` 条目。
