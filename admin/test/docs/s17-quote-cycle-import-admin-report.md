# S17 每日寄语页：按天循环设置与 Excel 导入 · 管理后台测试报告

- 日期：2026-10-11
- 范围：admin `views/QuotesView.vue`、新组件 `components/ExcelImportDialog.vue`、`views/QuestionsView.vue`（改用通用导入弹窗）、`api/admin.ts`
- 环境：后端新进程 `uvicorn app.main:app --port 8011`（openGauss :5118，已执行迁移 013），admin `VITE_API_PROXY=http://127.0.0.1:8011 npx vite --port 5174`，Chrome 实机验收（视口约 830px 宽）

## 1. 改动

| 编号 | 位置 | 内容 |
| --- | --- | --- |
| A1 | ExcelImportDialog.vue（新） | 题库页内联导入逻辑抽成通用组件：下载模板、选择文件上传校验、统计与错误明细表、下载错误报告 CSV（防公式注入）、有错误行禁止确认、令牌确认；标题/单位/提示/接口通过 props 传入，`defineExpose` 暴露 `downloadTemplate` 供工具栏按钮复用 |
| A2 | ExcelImportDialog.vue | 修复原题库弹窗缺陷：`el-upload :limit="1"` 时第二次选择文件被静默忽略，修正后无法在同一弹窗重新上传；改用 Element Plus 官方 `on-exceed` 替换文件写法 |
| A3 | api/admin.ts | 导入三接口抽取私有 helper，导出 `questionImportApi` / `quoteImportApi`；新增 `fetchQuoteCycle` / `updateQuoteCycle`；Quote 类型改为 排序号 + 启用状态（去掉 date） |
| A4 | QuotesView.vue | 顶部循环设置条（起始日期 + 保存，未改动时禁用；启用条数与今日序号说明）；工具栏「下载导入模板」「批量导入」；表格新增排序号列、行内启用开关（切换中 loading）、今日展示标记；表单日期改为排序号 + 启用；增删改/启停/导入后同时刷新列表与循环信息；窄屏下设置条与工具栏自动换行 |
| A5 | QuestionsView.vue | 删除约 60 行内联导入状态/函数/弹窗及导入样式，改用 `<ExcelImportDialog>` |

## 2. 验证结果

### 2.1 构建

| 项目 | 结果 |
| --- | --- |
| `npm run build`（vue-tsc + vite） | 通过 |

### 2.2 浏览器实机验收

| 场景 | 结果 | 截图 |
| --- | --- | --- |
| 寄语列表：按排序号 1~5 展示，第 1 条带「今日展示」标记；循环条显示「启用寄语 5 条…今日展示第 1 条」（起始 2026-10-01，今天 10-11，10 % 5 = 0） | 通过 | `quotes-cycle-01-list.png` |
| 下载导入模板：`GET /admin/quotes/import-template` 200，文件名「长征步迹_每日寄语导入模板.xlsx」，含寄语数据/填写说明两表 | 通过 | — |
| 上传含错文件（4 行）：统计「有效 1 行，错误 3 行」，错误明细定位到行与字段（3 寄语内容 库内重复 / 4 寄语内容 为空 / 5 排序号 非法），确认按钮禁用；下载错误报告 CSV 内容与表格一致 | 通过 | `quotes-cycle-02-import-errors.png` |
| 同一弹窗再次选择修正后的文件：文件名切换、重新校验「有效 2 行，错误 0 行」，确认按钮可用（A2 修复点） | 通过 | `quotes-cycle-03-import-ok.png` |
| 确认导入：提示「成功导入 2 条寄语」，新行排序号 6、7（空排序号接在最大值后），「停用」行开关为关；启用 6 条、今日第 5 条（10 % 6 = 4） | 通过 | — |
| 行内启用开关：启用第 7 条 → 启用 7 条、今日第 4 条，标记移至第 4 行；再停用恢复 6 条、第 5 条 | 通过 | — |
| 修改起始日期为 2026-10-09 并保存：提示「起始日期已保存」，今日第 3 条，标记随之移动，保存按钮回到禁用 | 通过 | `quotes-cycle-04-start-date.png` |
| 编辑弹窗：内容/出处/排序号/启用/关联节点回填正确；排序号改为 0 并启用后保存，该行排到首位 | 通过 | `quotes-cycle-05-edit.png` |
| 删除：确认框显示寄语内容，删除两条测试数据后恢复 5 条；起始日期恢复 2026-10-01，今日第 1 条 | 通过 | — |
| 题库页回归：工具栏下载模板 `GET /admin/questions/import-template` 200；批量导入弹窗标题/提示正确，上传表头不符文件提示「表头与模板不一致，请下载最新模板填写」，确认禁用 | 通过 | `quotes-cycle-06-question-import-regression.png` |

> 验收结束后测试数据已全部清理，实库寄语恢复为原 5 条、起始日期 2026-10-01。
