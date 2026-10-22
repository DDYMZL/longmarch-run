# F1 星空长征视口 UI 精简与页面级详情弹框 · 验证报告

> 日期：2026-10-22｜范围：frontend（星空长征 Canvas 内核 + march 页弹框）｜性质：用户五点调整的实现与回归验证

## 1. 需求与决策

用户对已收口的史诗风重构（E1~E8）提出 5 点调整，四项关键决策经提问确认：

| # | 调整点 | 决策 |
| --- | --- | --- |
| 1 | 点节点弹框从地图容器内改为页面级弹出 | **全屏遮罩 + 居中对话框**，内容不变，按钮不得被遮掩 |
| 2 | 左上角数据胶囊（今日参与/点亮/步数三段） | **整个删除** |
| 3 | 底部「拖动平移…」操作提示 | 直接删除（无分支疑问） |
| 4 | 右上角进度环（金弧 + % 数字） | **整个删除** |
| 5 | 地图左侧「平行线」 | 确认即泸定桥区段 `chains` 铁索垂弧装饰，删除；底部三态图例**保留** |

## 2. 改动清单

**`utils/starMap.js`**（内核）
- 删 `drawStatsCapsule` / `drawProgressRing` / `drawHint` 三个方法及 draw() 内调用，视口固定 UI 仅剩 `drawLegend`；
- 删随之失效的 `setStats`（胶囊是唯一消费方）、`fmtNum`、常量 `HINT_TEXT`/`RING_R`、实例字段 `stats/statsText/_hintW/_ringPct/_ringText` 及 dispose 清理项；
- 删 `paintChapterScenery` 的 `chains` 分支（两条二次贝塞尔垂弧链线 + 各 10 链环节点）；
- 头注释与进入动画时间线注释同步为「视口 UI 仅图例」。

**`data/star-themes.js`**：`breakthrough.extra` 由 `'chains'` 改 `null`，extra 注释去掉 chains 项。

**`pages/march/march.js`**（死代码链清理）
- 删 `loadOverlay()`（合并 `/march/route-stats` + `/broadcast/today` 注入 `hud.setStats`，胶囊删除后无消费方）及其 3 处调用（refresh 并发拉取、switchMode 切星空、WS `data_changed` 节流重拉）；
- 删 `broadcast` require、`STATS_THROTTLE`、`_overlayStats`/`_statsAt` 残留（initCanvas 的 last-good 注入）；`handleWsMessage` 仅保留 `activity` 飞线分支；
- 星空模式由此不再发起 route-stats / broadcast 两个聚合请求。

**`pages/march/march.wxml` / `march.wxss`**（弹框页面级化）
- `.node-panel-mask` 从 `.map-wrap` 内挪到页面根级，`absolute` 改 `fixed` 全屏（z-index 90，低于抵达卡/开场 999/998），新增 `catchtouchmove` 拦背景滚动；
- `.node-panel` 底部面板改居中对话框：宽 630rpx、全圆角 + 全金色描边、`panelPop` 缩放淡入（替换 panelUp 上滑）、删 grip 把手；内容区 `scroll-view` 限高 54vh，矮屏自动收缩，底部双按钮恒完整露出；
- 快照顶替机制保留（canvas 原生层在开发者工具会盖住包括 fixed 弹框在内的全部 DOM），聚焦 420ms 补间、关闭恢复观景变换等 JS 逻辑零改动。

**测试脚本**：`epic-panel-shots.cjs` 段 1 新增几何断言（遮罩页面级且不盖原生 tabBar、弹框水平/垂直居中于页面可视区、按钮矩形完整露出）；`epic-shots.cjs` 去掉铁索措辞；两脚本 prepare 加「launch 异步重定向顶回 home」的进 march 页有限重试（本次 IDE 冷启动实测踩到）。

## 3. 验证结果

| 项 | 结果 |
| --- | --- |
| `node --check`（starMap/star-themes/march.js/两测试脚本） | 全部通过 |
| epic-shots 内核状态 | 与 E8 基线一致：`perfAvg 16.7ms`、`lowPerf=false`、远/中/近星 150/90/34、雾带 5、区段 5、粒子 57、静态层烘焙成功、10 节点 |
| epic-shots 截图 | epic-01 全景 / epic-02 缩放 / epic-03 突围章特写（铁索已消失，峡谷剪影与泸定桥图标保留）/ epic-04 会师章 全出 |
| epic-panel-shots 段 1 | 弹框打开、画布快照顶替、节点/章节正确；几何：遮罩 0~671px（页面级，不含 tabBar）、弹框 cx=195=winW/2、cy=335.5=maskH/2、actions 完整在弹框内 |
| epic-panel-shots 段 2 | 关闭后画布重建、`introSkipped=true`、观景 scale 恢复 1.8、动画循环 running |
| 截图证据 | `test/images/epic-05-node-panel.png`（居中弹框完整态）、`epic-06-panel-closed.png`（关闭恢复） |

## 4. 业务隔离核对

- 10 节点 5 章节、微信运动同步、点亮/章节/勋章/排名链路零改动；删除的均为纯展示层元素与无消费方的数据注入；
- `/api/march/route-stats`、`/api/broadcast/today` 后端接口保留（home 页今日播报等仍消费 broadcast 服务），仅 march 页星空模式不再调用；
- 图例保留；抵达卡/开场动画层级（999/998）高于弹框遮罩（90），时序互不干扰。

## 5. 已知事项

- epic-01 截图于进入动画 2600ms 处拍摄，图例淡入刚开始（uiEnd 3200ms），截图中图例较淡属既有时间线行为，非本次引入；
- 真机同层渲染下 canvas 本可盖 DOM 下方，快照顶替为开发者工具口径的统一兜底，真机表现不变。
