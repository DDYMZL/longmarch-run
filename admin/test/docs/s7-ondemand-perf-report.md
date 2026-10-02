# S7 管理端按需引入与排名页性能优化 · 验收报告

日期：2026-10-02 ｜ 环境：admin dev server (5173) + backend (8010, openGauss) ｜ 浏览器：Chrome (browser-use)

## 范围

在不影响现有功能的前提下做打包体积与大数据量渲染优化：echarts 与 Element Plus 由全量引入改为按需引入，排名页（100+ 用户、每用户 10 节点展开行）增加客户端分页，并复用既有 `useLiveUpdates` 删除页面内重复实现的 WebSocket 代码。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/plugins/element-plus.ts` | 新增：手动按需注册 33 个组件 + 逐组件 `style/css` 入口（利用其依赖链自动带入子组件样式），`app.use(ElLoading)` 提供 v-loading 指令，`provideGlobalConfig({ locale: zhCn }, app, true)` 全局模式保证 ElMessage/ElMessageBox 等命令式组件同为中文 |
| `src/main.ts` | 移除 `ElementPlus` 全量注册与 `element-plus/dist/index.css`；图标由全量注册改为仅注册实际使用的 19 个；调用 `setupElementPlus(app)` |
| `src/views/DashboardView.vue` | echarts 按需：`echarts/core` + `BarChart/LineChart` + `Grid/Legend/Tooltip` + `CanvasRenderer`，`echarts.use([...])` 注册；图表实例类型改 `echarts.EChartsType` |
| `src/pages/RankingsView.vue` | 删除约 60 行页面内联 WS 实现（连接/重连/销毁），改复用 `useLiveUpdates`；新增客户端分页（`page/pageSize/pagedItems`，筛选条件变更时复位第 1 页，页大小 20/50/100/200 可选）；`number()` 委托 `formatNumber` |

## 打包体积对比

| 产物 | 优化前 | 优化后 | 降幅 |
| --- | --- | --- | --- |
| index（主包） | 1,208 KB / gzip 388 KB | 545 KB / gzip 187 KB | ≈55% / 52% |
| DashboardView（含 echarts） | 1,134 KB / gzip 382 KB | 542 KB / gzip 186 KB | ≈52% / 51% |

## 验收结果

| # | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| S7-A1 | `npm run build`（vue-tsc + vite）通过 | ✅ | ✓ built in 6.98s |
| S7-A2 | 驾驶舱：7 指标卡 + ECharts 趋势图 7/30 天切换正常渲染 | ✅ | s7-01-dashboard-echarts.png |
| S7-A3 | 排名页分页：底部分页器显示「共 134 条」（中文 locale 生效证据），翻页/改页大小/筛选复位正常 | ✅ | s7-02-rankings-pagination.png |
| S7-A4 | 排名页既有功能无回归：关键词筛选、组织筛选、只看变动、导出 CSV（BOM）、展开行、用户档案抽屉 | ✅ | 浏览器逐项操作通过 |
| S7-A5 | 命令式组件中文 locale：ElMessageBox 显示「取消/确定」 | ✅ | 浏览器实测 |
| S7-A6 | 组织页：表格 7 列渲染、新增组织弹窗、上级组织 tree-select 下拉 | ✅ | 浏览器实测 |
| S7-A7 | 路线点位：表格 10 行 + 编辑弹窗 el-switch「启用」勾选、内容字段回填 | ✅ | s7-03-route-node-dialog.png |
| S7-A8 | 题库维护：15 行、题型/分类筛选下拉、el-tag 分类列 | ✅ | s7-04-questions.png |
| S7-A9 | 数据大屏：指标/路线总览/趋势/动态全渲染，WS「实时已连接」（useLiveUpdates 复用正常） | ✅ | s7-05-screen.png |
| S7-A10 | 排名页内联 WS 删除后实时推送仍生效（共用 useLiveUpdates） | ✅ | data_changed 消息触发 scheduleReload |

## 备注

- 按需样式入口经核对依赖链完整：`tree-select/style/css` 带入 select+tree，`table/style/css` 带入 base/scrollbar/tooltip/checkbox，无遗漏样式。
- 排名页分页为纯客户端分页（`/admin/rankings` 一次返回全量 134 条），避免改动后端契约；数据量继续增长时可再演进为服务端分页。
- el-table 操作列 fixed:right 在窄视口下覆盖中间列是组件既有行为，与本次改动无关（对照历史截图 orgs-01-tree.png 确认）。
