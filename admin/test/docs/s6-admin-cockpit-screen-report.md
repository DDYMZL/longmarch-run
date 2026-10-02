# S6 管理端驾驶舱与数据大屏 · 验收报告

日期：2026-10-02 ｜ 环境：admin dev server (5173) + backend (8010, openGauss) ｜ 浏览器：Chrome (browser-use)

## 范围

按 `docs/upgrade-plan.md` S6 阶段，为管理端新增驾驶舱与数据大屏两个页面，并扩展路线点位、题库维护两个已有页面的表单，对接 S4 新增的管理端聚合接口（组织维度按用户决策完全跳过）。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/api/admin.ts` | Question/RouteNode 类型补 `category`、`brief/significance/figures/location/images/audio/keywords`；新增 Dashboard/Trend/Activity/Screen 类型与 `fetchDashboard/fetchDashboardTrend/fetchActivities/fetchScreen` |
| `src/utils/liveUpdates.ts` | 新增 `useLiveUpdates` 组合式函数（WS 连接/指数退避重连/消息分发）与 `formatTime/formatNumber`（naive 时间串按 UTC 处理，补 `Z` 后缀） |
| `src/views/DashboardView.vue` | 新增驾驶舱：7 张指标卡、ECharts 运动趋势图（总步数柱 + 运动人数/新点亮/新增用户线，7/30 天切换）、WS 实时动态流（activity 消息 prepend）、长征路线总览表（目标步数进度 + 达成人数 + 达成率） |
| `src/views/ScreenView.vue` | 新增数据大屏（深色全屏）：指标条、路线总览进度条、近 7 日趋势条形、实时动态流；`fetchScreen` 单接口聚合加载 + WS 实时刷新 |
| `src/router/index.ts` | 新增 `dashboard` 子路由与 `/screen` 顶层路由（同 /login 先例），根路径重定向改为 `/dashboard` |
| `src/layout/AdminLayout.vue` | 菜单新增「驾驶舱」「数据大屏」两项 |
| `src/views/RouteNodesView.vue` | 编辑表单新增 7 个内容字段（一句话简介/历史意义/相关人物/地点/关键词/图片链接动态列表/音频链接），initial/openCreate/openEdit/handleSave 四处同步 |
| `src/views/QuestionsView.vue` | 题目新增知识分类（event 历史事件/route 长征路线/figure 历史人物）：表单下拉、表格分类列、分类筛选 |

## 验收结果

| # | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| S6-01 | `npm run build` 通过 | ✅ | 构建日志 ✓ built in 7.17s |
| S6-02 | 驾驶舱：7 指标卡数据正确（117 人/370,613 步/1% 完赛等），与后端一致 | ✅ | s6-01-dashboard.png |
| S6-03 | 驾驶舱趋势图：ECharts 正常渲染，柱线混合 + 双 y 轴 + 图例 | ✅ | s6-01-dashboard.png |
| S6-04 | 驾驶舱实时动态：WS「实时连接正常」，活动条目按时间倒序展示 | ✅ | 快照 uid=1_41「实时连接正常」 |
| S6-05 | 驾驶舱路线总览：10 个启用节点的目标步数/达成人数/达成率 | ✅ | s6-01-dashboard.png |
| S6-06 | 数据大屏：深色主题、指标条、路线进度、7 日趋势、实时动态全部渲染，WS「实时已连接」 | ✅ | s6-02-screen.png |
| S6-07 | 路线点位编辑弹窗：7 个新内容字段从后端正确回填（飞夺泸定桥的简介/意义/人物/地点/关键词） | ✅ | s6-03-route-node-edit.png |
| S6-08 | 图片链接动态列表：添加 → 保存 → 后端 `images` 持久化 → 重新打开回填 → 删除 → 保存恢复 `[]` | ✅ | admin API 断言 `['https://example.com/luding-test.png']` → `[]` |
| S6-09 | 题库：分类列/分类筛选/编辑弹窗知识分类下拉（历史人物回填正确） | ✅ | s6-04-question-edit.png |
| S6-10 | 菜单与路由：新增两项菜单可点击跳转，`/` 重定向到 `/dashboard`，未登录访问被守卫拦截 | ✅ | 各页快照菜单均含 6 项 |

## 备注

- 实时动态中出现的历史文案「点亮『瑞金1』」为此前开发库节点名被污染期间产生的历史事件记录（事件文案入库即固化），节点当前名称已是「瑞金」，不影响功能。
- 大屏页面按用户决策不含任何组织维度统计；驾驶舱指标卡为整体口径。
- 浏览器会话沿用此前登录态（localStorage token），登录守卫行为未回归。
