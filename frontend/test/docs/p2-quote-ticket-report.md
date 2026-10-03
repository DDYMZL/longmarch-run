# P2-1 每日寄语 + 节点纪念票（小程序侧）测试报告

日期：2026-10-03 · 范围：首页今日寄语卡（需求 §16）、节点纪念票（需求 §19）

## 改动摘要

- `services/quote.js`（新增）：`getToday()` → `GET /api/quotes/today`。
- `pages/home/home.{js,wxml,wxss}`：今日寄语卡（位于今日行军卡与长征进度之间，无寄语时隐藏）：
  「今日寄语」+ 日期 / “内容” / —— 出处 / 关联节点 ›（点击跳节点详情，无关联节点不可点）。
- `pages/ticket/ticket.{js,wxml,wxss,json}`（新增页面，app.json 注册）：节点纪念票。
  - 数据：`/march/node/{id}`（节点名/历史日期/状态）+ `/march/footprints`（点亮日期/当日步数/累计快照），
    仅 `status=completed` 且有点亮记录的节点可生成，否则展示「该节点尚未点亮」错误态；
  - 票面（Canvas 本地绘制，无服务端图片，dpr 适配与画像雷达图一致）：红色票头「长征步迹 · 节点纪念票」、
    节点图标/名称/历史日期、打孔分隔线、「我于 {点亮日期} 完成该历史节点」、当日步数（含累计）、票号 NO.{date}-{nodeId}；
  - 「保存到相册」：`wx.canvasToTempFilePath`（2d 画布传 canvas 节点）→ `wx.saveImageToPhotosAlbum`，未授权时 toast 提示。
- `pages/node-detail/node-detail.{js,wxml,wxss}`：已点亮节点显示「🎫 生成纪念票」入口（§19 入口链路：
  我的长征 → 已点亮节点 → 节点详情 → 生成纪念票）。

## 验证结果（automator）

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P2B-01 | 今日寄语卡：内容/出处/日期非空，日期不晚于今天，卡片渲染（2026-10-03《清平乐·六盘山》→ 吴起镇） | 通过 |
| P2B-02 | 寄语跳节点：点击寄语卡跳转关联节点「吴起镇」详情 | 通过 |
| P2B-03 | 纪念票：补 2000 步点亮瑞金 → 详情页显示入口 → 票面就绪（canvas 渲染，litDate=2026-10-03、daySteps=2000） | 通过 |
| P2B-04 | 未点亮节点（遵义）直接进纪念票页显示「尚未点亮」错误态 | 通过 |

执行：`cd frontend/test/automator && node p2-quote-ticket.cjs` —— **4/4 通过**（`results-p2b.json` / `p2b.log`）。

截图证据（`frontend/test/images/`）：`33-home-quote.png`（首页寄语卡）、`34-ticket.png`（瑞金纪念票）。

## 已踩坑记录

- **34 号截图首次失败**：33 号截图后自动化桥退化，同一连接内 reLaunch 纪念票页等待超时；
  按测试协议 3b/3c 改用独立连接补拍（`shot-ticket.cjs`，连接后先 reLaunch 主动导航再截图）即成功。
- **纪念票数据依赖点亮记录**：瑞金（target=0）在路线状态上自然完成，但 fresh 用户无 LitNode 行时
  footprints 为空，纪念票会判「尚未点亮」——测试先 `POST /sport/add` + `POST /march/light-up` 产生真实点亮记录再验证。
- **WXML 自检脚本正则**：V8 不支持 `(/?)` 写法（`(?` 后必须跟特殊组前缀），需转义为 `(\/?)`
  （`frontend/test/wxml-balance-check.cjs`，本次 3 个模板均 depth=0 通过）。
