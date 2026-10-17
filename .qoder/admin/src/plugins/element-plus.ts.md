# element-plus.ts

## 1. 文件路径

`admin/src/plugins/element-plus.ts`（140 行）

## 2. 文件职责

Element Plus 按需注册插件：注册 38 个组件、`v-loading` 指令、zh-cn 语言包与按组件引入的样式，替代 `app.use(ElementPlus)` 全量注册 + `dist/index.css` 全量样式（`:1-2` 注释：约省 700KB+ CSS/JS）。由 `main.ts:80` 调用一次。

## 3. 业务需求

- 体积优化需求，`4e453a4`（2026-10-02）创建（`docs/迭代记录.md` 的 `4e453a4` 条目）。
- 此后随新页面增量登记：`71d1b9b`（日期选择）、`54a0de7`（登录双标签/授权勾选）、`30b4458`（Excel 导入弹窗）。
- `:3` 注释即维护约定：「新增组件时：在 components 与样式区各加一行即可」。

## 4. 核心功能

### 4.1 组件注册清单（`:5-46` import、`:94-133` 数组、`:136` 注册）

38 个组件：Alert、Aside、Avatar、Button、Card、Checkbox、CheckboxGroup、Container、DatePicker、Dialog、Divider、Drawer、Empty、Form、FormItem、Header、Icon、Input、InputNumber、Main、Menu、MenuItem、Option、Pagination、Progress、Radio、RadioButton、RadioGroup、Select、Switch、TabPane、Table、TableColumn、Tabs、Tag、Tooltip、TreeSelect、Upload。每个组件在 `:49-87` 有对应的 `element-plus/es/components/<name>/style/css` 样式引入（含 `base`），一一对应无缺漏。

### 4.2 指令与程序化调用样式（`:88-92`、`:137`）

- `app.use(ElLoading)`（`:137`）注册 `v-loading` 指令（各列表页大量使用，如 `views/AuditView.vue:118`）。
- `ElMessage` / `ElMessageBox` / `ElNotification` **不注册组件**——各调用方直接从 `element-plus` import（`api/request.ts:3`、`layout/AdminLayout.vue:5`、`views/OrgsView.vue:5` 等），本文件只引它们的样式（`:89-92`，`:88` 注释明示）。

### 4.3 语言包（`:47`、`:139`）

`provideGlobalConfig({ locale: zhCn }, app, true)`：第三个参数 `true` 使 `ElMessage`/`ElMessageBox` 等脱离组件树的程序化调用同样应用中文（`:138` 注释）；影响分页、日期选择器等内建文案。

### 4.4 注册完整性核对（2026-10-17 实测）

对 `admin/src` 全量 grep `<el-` 标签，共 **39 种**组件被模板使用：

- 38 种与注册清单完全重合，**无「注册但未使用」的冗余组件**；
- **唯一缺口：`el-result`**（`views/ActivityView.vue:177-179`，活动设置加载失败的错误兜底分支）未在清单中，也无对应样式引入。触发该分支时 Vue 报「Failed to resolve component: el-result」，错误提示区不渲染（页面其余部分不受影响，`v-if` 兄弟分支正常）。证实 `.qoder/PROJECT.md` §8「代码级技术债」第 18 项与 `.qoder/ARCHITECTURE.md` §15 第 10 项，且经全量核对**缺失项仅此一个**。
- 缺口来源：`e197a28`（2026-10-13）新增 `ActivityView.vue` 时未按 `:3` 约定同步本文件（该提交未触碰本文件，见 §10）。

## 5. 输入与输出

- 输入：`setupElementPlus(app: App)` 接收 Vue 应用实例（`:135`）。
- 输出：无返回值（`void`）；副作用为组件/指令/语言包注册与样式引入。无异常分支。

## 6. 依赖关系

- 依赖：`element-plus` 包（组件、`es/locale/lang/zh-cn`、各组件 `style/css` 入口）、`vue` 的 `App` 类型。
- 被依赖：`admin/src/main.ts:38`（import）、`:80`（调用）；间接被全部视图/组件模板依赖（39 种标签中的 38 种由此解析）。
- 不涉及 `api/admin.ts`、WebSocket、数据库。

## 7. 业务规则

无业务逻辑。约束性事实：管理后台界面语言固定为简体中文（zh-cn 语言包全局生效）。

## 8. 修改约束

- 新增组件必须**三处同步**：import 段、`components` 数组、样式区各加一行（`:3` 注释）；只加数组不加样式会出现「组件渲染但无样式」。
- 不得回退为全量注册（`4e453a4` 的优化目标）；`:89-92` 四个样式引入不得因「无对应组件注册」而删除——它们支撑程序化调用与 `v-loading`。
- 修复 `el-result` 缺口时须同时引入 `element-plus/es/components/result/style/css`。
- 组件样式入口用 `style/css`（编译后 CSS）而非 `style`（Sass 源码），保持与现有 38 行一致。

## 9. 当前实现状态

- **已实现**：按需注册机制可用，构建通过（历次 `npm run build` 验证见 §10 各条目）。
- **存在问题**：`ElResult` 未注册但被 `ActivityView.vue:177-179` 使用（§4.4），**待修复**；因只在「活动设置接口加载失败」的兜底分支触发，日常验收不易暴露。
- **待开发**：若后续落地 5 个 AI 管理子页面（`.qoder/ARCHITECTURE.md` §11.3），其用到的新组件需在此登记。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/plugins/element-plus.ts`，共 **4 个提交**，按时间倒序。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复（含通用 Excel 导入弹窗收口）。
- 修改内容（涉本文件）：新增 `ElUpload` 注册与样式（`components/ExcelImportDialog.vue` 使用）。
- 关联文件：`admin/src/components/ExcelImportDialog.vue`、`admin/src/main.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-09（`54a0de7`）
- 需求：扫码登录与人员授权/审计页（P3 管理端）。
- 修改内容（涉本文件）：新增 `ElCheckboxGroup`、`ElTabPane`、`ElTabs`（登录页双标签、授权页角色勾选）。
- 关联文件：`admin/src/views/LoginView.vue`、`admin/src/views/AccessView.vue`、`admin/src/views/AuditView.vue`。
- 测试结果：见 `docs/迭代记录.md` 的 `54a0de7` 条目。

### 2026-10-03（`71d1b9b`）
- 需求：每日寄语与节点纪念票（P2-1）。
- 修改内容（涉本文件）：新增 `ElDatePicker` 注册与样式。
- 关联文件：`admin/src/views/QuotesView.vue`、`admin/src/router/index.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `71d1b9b` 条目。

### 2026-10-02（`4e453a4`）
- 需求：echarts 与 Element Plus 改为按需引入（体积优化）。
- 修改内容（涉本文件）：创建本文件，初始注册 33 个组件（现 38 个中扣除后续三次新增的 5 个）+ ElLoading + zh-cn 语言包 + 按组件样式。
- 关联文件：`admin/src/main.ts`（删除全量注册）。
- 测试结果：见 `docs/迭代记录.md` 的 `4e453a4` 条目。

> 备注：`e197a28`（2026-10-13，新增使用 `<el-result>` 的 `ActivityView.vue`）未同步修改本文件，是 §9 缺口的引入点；本文件自身历史中无该提交。
