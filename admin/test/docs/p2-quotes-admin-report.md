# P2-1 每日寄语维护（管理端）测试报告

日期：2026-10-03 · 范围：每日寄语后台维护页（需求 §16.4：寄语句后台可维护、可关联节点）

## 改动摘要

- `src/api/admin.ts`：`Quote` / `QuoteListResult` / `QuoteUpsert` 类型与 `fetchQuotes`（分页）/ `createQuote` / `updateQuote` / `deleteQuote`。
- `src/views/QuotesView.vue`（新增）：列表（日期/内容/出处/关联节点 tag，当前页关键字搜索，分页）+ 新增/编辑弹窗
  （el-date-picker 选日期、内容 200 字、出处必填——提示「须有明确来源，勿虚构」、节点下拉可清空）+ 删除二次确认。
- `src/router/index.ts`：注册 `/quotes`（标题「每日寄语」）；`src/layout/AdminLayout.vue`：菜单新增「每日寄语」（ChatLineSquare 图标）。
- `src/plugins/element-plus.ts`：按需注册新增 `ElDatePicker` 及样式；`src/main.ts`：按需图标新增 `ChatLineSquare`。

## 验证结果（浏览器真实交互）

`npm run build` 通过（vue-tsc + vite，QuotesView 5.82 kB）；`npm run dev` 启动后在浏览器验收：

| 场景 | 结果 |
| --- | --- |
| 菜单「每日寄语」进入 `/quotes`，列表展示 5 条种子寄语（日期倒序、出处、节点 tag、分页条） | 通过 |
| 新增：日期 2026-10-06 + 内容 + 出处 + 关联瑞金 → 保存成功，列表变 6 条且新行显示瑞金 tag | 通过 |
| 编辑：打开自动回填全部字段，修改内容保存后列表即时更新 | 通过 |
| 删除：二次确认弹窗（「确定删除 2026-10-06 的寄语吗？」）→ 确认后回到 5 条种子状态 | 通过 |

截图证据（`admin/test/images/`）：`p2-01-quotes.png`（列表 + 新增按钮 + 分页）、`p2-02-quotes-node.png`（出处/关联节点列）。

## 交互备注

- el-date-picker 面板展开时会遮挡下方节点下拉（验收中首次点击报 "Element is covered"）；按 Enter 收起日期面板，
  或 Tab 移焦后用方向键展开节点下拉均可正常选择——属 Element Plus 常规交互，非缺陷。
