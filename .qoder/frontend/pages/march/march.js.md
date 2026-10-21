# march.js（长征路线页 · 页面级合一）

> **⚠ 勘误（2026-10-21，史诗风重构 E1~E7）**：绘制内核已由 `utils/hudMap.js`（HUD 仪器风）**重写为 `utils/starMap.js`（史诗风）**并随 E7 删除旧内核；本文档中全部「hudMap」「L0~L8」「六边环节点」「雷达/扫描」等表述指向已删除的 HUD 内核，仅具历史参考价值；行号锚点（721 行口径）也已随 E1~E6 漂移。**以源码为准**。新内核现状见 `frontend/design.md` §4.6（2026-10-21 口径）与 `docs/迭代记录.md` 2026-10-21 段；`starMap.js` 的 .qoder 建档与本文档的全量重锚在文档 backlog。E6 起「命中跳转 node-detail」改为「打开页内玻璃详情面板（画布快照顶替原生层）+ 面板内『查看完整详情』跳转」。

> 按 `.qoder/README.md` §1「页面级合一」规则，本文档覆盖 `frontend/pages/march/` 四件套：`march.js`（721 行）、`march.wxml`（140 行）、`march.wxss`（548 行）、`march.json`（6 行）。WXML / WXSS / JSON 专章见 §4-1–§4-3。**星空长征的绘制状态与绘制逻辑不在本页**，全部在 `utils/hudMap.js` 渲染内核（`.qoder/frontend/utils/hudMap.js.md`），本页只留模式切换、数据拉取、rAF 循环、手势事件转发与命中跳转；S4 起另加 WS 订阅与 L7 叠加层取数（数据合并后注入内核，绘制仍全在内核）。

## 1. 文件路径

`frontend/pages/march/march.js`、`march.wxml`、`march.wxss`、`march.json`

## 2. 文件职责

长征 Tab 主页面：展示路线总览（累计步数、点亮进度、当前章节卡），提供**双模式地图**——默认实景 `<map>`（后端下发经纬度 + markers/polyline）与 Canvas 2D「星空长征」插画地图（绘制内核为 `utils/hudMap.js`，实例挂 `this.hud`）；承载开场动画（首次完整开场/非首次纱幕）、抵达事件卡队列播放、完成仪式跳转触发与就地同步行军步数（B6）；下方为可点击的节点列表。S4 起本页另承担星空模式的**实时数据供给**：订阅 WS（`services/ws.js`）把 `activity` 事件转成内核飞线、`data_changed` 节流后重拉全员统计，并把 `/march/route-stats` 与 `/broadcast/today` 两个聚合响应合并成归一化入参交给 `hud.setStats`。数据全部来自 `services/march.js`（后端 `/march/route`、`/march/light-up`、`/march/route-stats`）、`services/sport.js`（`/sport/sync`）与 `services/broadcast.js`（`/broadcast/today`），页面不直接发请求、不直接读写 Storage（`frontend/AGENTS.md` §3.1）。

## 3. 业务需求

文件头 docstring（`march.js:1-11`）自引：星空绘制收在渲染内核的边界声明（`:5-6`）、星空全景 §13.4 拖动/捏合/双击复位（`:7`）、「任意节点含未解锁可看历史」（`:8`，不变量 8 的落点 `:703-706`、`:713-715` 注释）、S4 实时叠加的页面侧职责与「内核不认接口形状」（`:9-10`）。绘制侧需求（§13.2 节点三态星形、§13.3 点亮动画、§12 区域氛围、§3.5 轨迹推进）的落点已随 S2 搬迁到 `.qoder/frontend/utils/hudMap.js.md` §3；本页保留的需求为：开场动画 §5（`:79-83` 注释）、章节卡 §4.4（`:330` 注释）、抵达事件卡 §4.5（`:302-307` 注释）、完成仪式 §20（`:271-275` 注释，§20.4 仅第一次）、就地同步 B6（`:241-245` 注释）、L7/L8 实时叠加（科技感地图方案 S4，`:154-158` 与 `:170-174` 注释）。双模式地图与 Canvas 清理约定是 `frontend/AGENTS.md` §4 不变量 6 的落点（内核侧见 hudMap 文档 §8）。

## 4. 核心功能

### 4.1 页面入口与生命周期

- **入口**：tabBar 第 2 个 tab「长征」（`frontend/app.json`，`pagePath: pages/march/march`），无其它页面 `navigateTo` 进入本页（tab 页只能 switchTab）。
- **无 `onLoad`/`onReady`**：全部初始化在 `onShow` 完成（`:67-77`）——① 登录守卫：`!app.globalData.loggedIn` 时 `wx.reLaunch('/pages/launch/launch')`（`:68-71`；tab 页同样自守卫，配合 `frontend/AGENTS.md` §4 不变量 5）；② `maybePlayIntro()`（`:72`）；③ 星空动画恢复：`this.hud && this.routeData` 时 `startAnim()`（`:74`，注释说明 onHide 停掉了动画，先用已有路线恢复、刷新失败画面也不冻结）；④ **WS 订阅（S4，`:75`）**：仅在 `_wsUnsub` 未持有时 `ws.subscribe((msg) => this.handleWsMessage(msg))`，重复 onShow 不会重复订阅；⑤ `refresh()`（`:76`，满足不变量 1「onShow + refresh」）。
- **`onHide`（`:126-134`）**：递增 `_refreshRequestId` 作废在途刷新（`:127`）→ `unsubscribeWs()`（`:128`）→ 清 4 个定时器（`:129-132`）→ `stopAnim()`（`:133`）。
- **`onUnload`（`:136-145`）**：同 onHide，另清 `_veilTimer`（`:142`）→ `stopAnim()`（`:144`）。
- **`unsubscribeWs()`（`:148-152`）**：onHide/onUnload 共用的退订入口，退订后置 `_wsUnsub = null`，使下次 onShow 能重新订阅；`services/ws` 在无订阅者时内部延迟关闭连接（`.qoder/frontend/services/ws.js.md`）。

**定时器 / 动画 / 监听器全量盘点（逐一实读）**：

| # | 句柄 | 创建点 | onHide 清理 | onUnload 清理 | 其它清理点 | 说明 |
|---|---|---|---|---|---|---|
| 1 | `_introTimer` | `:88`（切走后重计时）、`:99`（首次，3350ms） | ✅ `:131`（清后置 null） | ✅ `:141` | `dismissIntro` `:110` | 开场动画自动结束 |
| 2 | `_veilTimer` | `:95`（560ms 纱幕） | ❌ **未清**（见 §9 第 1 条） | ✅ `:142` | 无 | 唯一未双清的定时器 |
| 3 | `_viewTimer` | `:523`（700ms 镜头俯冲第二段） | ✅ `:129` | ✅ `:139` | `playViewAnim` 入口先清 `:516` | 实景镜头动画 |
| 4 | `popupTimer` | arrivePopup 模块递归 setTimeout 回写（`.qoder/frontend/utils/arrivePopup.js.md` §4.3） | ✅ `:130` | ✅ `:140` | 模块内每卡播放前先清（同文档 §8.2 契约） | 抵达卡队列 |
| 5 | `_ceremonyTimer` | `:287`（延时 = `_popupMs`） | ✅ `:132`（清后置 null） | ✅ `:143`（清后置 null） | 回调内自清 `:288` | 仪式跳转 |
| 6 | `animId`（rAF 链） | `startAnim` `:603`（`canvas.requestAnimationFrame`）或 `:605`（降级 `setTimeout(loop,16)`） | ✅ `stopAnim()` `:133` | ✅ `stopAnim()` `:144` | `switchMode` `:387`、`startAnim` 自防双链 `:597` | `stopAnim` `:611-618` 双清 + `running=false` 兜底 `:600` |
| 7 | `_wsUnsub`（WS 订阅，S4） | `onShow` `:75`（`ws.subscribe`） | ✅ `:128` | ✅ `:138` | `unsubscribeWs` `:148-152` 退订后置 null | 唯一的非定时器句柄，双清口径与定时器一致 |

`arriveFx` / `progressAnim` 两个帧驱动动画态**已不在本页**，随 S2 迁入渲染内核（`.qoder/frontend/utils/hudMap.js.md` §4.2、§4.7）；本页经 `hud.playArrive(ids)` 触发（`:317`）。S4 的 L8 飞线态 `flyLine` 同样只在内核，本页经 `hud.playFlyLine(nodeId)` 触发（`:167`）。

事件监听器除 WXML 声明式绑定（tap/touch/marker 事件，§4-1，随页面销毁自动释放）外，S4 起新增**一个 WS 订阅**（`_wsUnsub`，见盘点表 #7）；**无 `wx.onXxx` 全局事件订阅**（`:13-19` require 清单即全部模块依赖）。

### 4.2 数据刷新链 `refresh()`（`:201-234`）

并发竞态守卫：每次调用生成自增 `requestId` 写入 `this._refreshRequestId`（`:202-203`），两个 `.then` 各校验一次，不匹配即丢弃（`:214`、`:224`；`e70b59f` 引入，见 `.qoder/frontend/services/request.js.md` §4.9 末段「页面级并发竞态守卫在各页面自行实现」）。链路：

0. **先非阻塞触发 L7 叠加层取数**（S4，`:206`）：`this.loadOverlay()` 不 `return`、不参与下面的链式流程与竞态守卫（全员数据与自己的路线互不依赖，失败也不影响路线），详见 §4.9。
1. `march.lightUpNodes()`（`:211` → `POST /api/march/light-up`，`.qoder/frontend/services/march.js.md` §4.3）——幂等点亮达标节点，失败兜底为空数组（`:212`）；结果暂存 `this._pendingLit` / `this._pendingChapters`（`:215-216`）；有新点亮/新完成章节时置 `app.globalData.homeDirty = true` 让首页强制刷新（`:217-220`）。
2. `march.getRoute()`（`:221` → `GET /api/march/route`）；响应带 `_fromCache` 时 toast 提示「网络异常，当前为最近缓存数据」（`:226`，last-good 缓存兜底口径）。
3. `renderRoute(route)` → `playArriveIfNeeded()` → `maybeStartCeremony(route)`（`:227-229`）。
4. 整链 `.catch` 静默：网络失败保留上一次渲染（`:231-233` 注释）；light-up 单独失败也兜底为空点亮结果继续拉路线（`:212`），即「点亮失败不阻塞路线展示」。

`refresh()` **返回 Promise**（`:210`），供下拉刷新 `onPullDownRefresh`（`:237-239`，完成后 `wx.stopPullDownRefresh`）与 `handleSyncSteps` 复用。

**就地同步行军步数（B6）`handleSyncSteps()`（`:246-269`）**：`data.syncing` 锁防重复触发（`:247-248`、`:267`）；`sport.syncToday()` 内部处理微信运动授权（拒绝走 authGuide 引导，`.qoder/frontend/services/sport.js.md`）；成功后置 `homeDirty` 并按 `synced/historyDetailsAvailable/failedDates` 三档 toast（`:252-260`），再 `refresh()` 走完整点亮+重绘链（`:261`）；失败 toast 错误信息（`:264`）。入口为头部「同步行程」按钮（`march.wxml`，§4-1）。

### 4.3 开场动画（§5，`:84-124`）

- `maybePlayIntro()`（`:84-100`）：模块实例标记 `_introChecked` 保证只判定一次；已判定过且开场仍在播（onHide 清掉定时器后回来）时重新计时 3350ms 自动结束（`:87-89`）。首次判定走 `march.hasPlayedIntro()`（`:93`，Storage 键 `lm_march_intro_played` 收归服务层，`.qoder/frontend/services/march.js.md` §4.6）：已播过 → `showVeil` 纱幕 + `_veilTimer` 560ms 后关闭（`:94-95`）；未播过 → `showIntro` + `_introTimer` 3350ms（`:98-99`）。
- `skipIntro()`（`:103-105`）→ `dismissIntro()`（`:108-124`）：清 `_introTimer`、`setData({showIntro:false})`、`march.markIntroPlayed()` 写标记（`:112`）；补播被开场压后的实景镜头动画 `playViewAnim`（`:113-116`）、抵达卡队列 `playArriveIfNeeded`（`:117`）、顺延的完成仪式 `_ceremonyRoute`（`:119-123`）。
- 3350ms 与 wxss `introFadeOut 0.45s ease 2.85s`（`march.wxss:453`）配合：2.85s 起淡出、3.3s 结束，留 50ms 余量。

### 4.4 路线渲染 `renderRoute(route)`（`:327-376`）

网络刷新与本地渲染共用同一入口（`:322-326` 注释），按 `data.mode` 分流：

- **公共段（`:328-345`）**：`this.routeData = route`（`:328`，实景分支与命中/列表消费它；星空绘制读的是内核 `hud.route`）→ 章节卡（§4.4 需求）：按 `route.currentChapterId` 匹配当前章，`finished` 且有章节时展示末章（`:331-334`）；`progressPct = Math.round(progress*100)` 预计算供 WXML 进度条（`:343`，遵守 `frontend/AGENTS.md` §5.2「WXML 不做原生调用」）→ `setData` 负载：`nodes` 经 `toViewNode` 裁剪为 6 字段（`:24-33`，注释「减小 setData 体积」）+ 5 个进度标量 + `currentChapter`（`:335-345`）。
- **real 分支（`:347-369`）**：`buildMapData` 产出 markers/polylines（§4.5）；`selectedNode` 默认选中 current 节点，无 current 取首个非 completed，再兜底第一个（`:349-353`）；配 `nodeThemes` 生成信息卡主题样式与环境描述（`:354`、`:359-360`）；首次进入且不在开场中时播 `playViewAnim` 镜头俯冲（`_viewPlayed` 防重播，`:364-367`）。
- **canvas 分支（`:371-375`）**：`setData(patch)` 后若 `this.hud` 已存在（即已切过星空模式）则 `this.hud.setRoute(route)` + `startAnim()`——**入场描画 vs 增量推进的判定在内核 `setRoute` 内部**（按是否已有采样路径区分，`.qoder/frontend/utils/hudMap.js.md` §4.2），本页不再持有 `prevProgress`/`nodeIndex`/`progressAnim`。L7 叠加数据不在此处刷新（走 `loadOverlay`，§4.9）。
- **进度换算已迁出**：`calcRouteProgress`/`currentRatio` 现为内核方法（`hud.calcRouteProgress`/`hud.currentRatio`），automator 经 `page.hud` 断言（`frontend/test/automator/p0-march.cjs` P0M-02~04）。

### 4.5 实景地图模式（`:409-564`）

`buildMapData(route)`（`:409-510`）产出 `<map>` 组件数据，坐标取后端下发的 `node.latitude/longitude`（`:411-414`，**无前端硬编码坐标表**，见 §8.8）：

- **已完成轨迹 `donePts`**（`:418-436`）：逐节点累计（`cur >= targets[i]` 即收入），当前目标段内按步数比例线性插值出旗帜位置。
- **节点 markers**（`:444-462`）：每节点 16×16 默认图标 + `callout` 点击气泡（`display:'BYCLICK'`，completed ★金 / current ◎红 / unlocked ○灰三套配色 `:439-443`）；注释说明用点击气泡替代常驻 label，避免密集点位名称错位/重叠（`:438`）。
- **进度旗帜 marker**（`:465-484`）：未完成且有已行进段时追加 `id: 999` 的「🚩 我在这里」label marker。
- **polylines**（`:487-507`）：两条——灰色全程底 `#B9B2A4CC` width 5 + 金色已完成段 `#D4A017` width 7 带描边与箭头（`arrowLine: true`）。

其余函数：

- `playViewAnim()`（`:515-529`）：镜头俯冲两段式——先重置全国视野（lat 34.5 / lng 108.5 / scale 4，`:517-522`），`_viewTimer` 700ms 后 `setData includePoints` 收缩到全部节点包络（`:523-528`）。
- `handleMarkerTap`（`:535-546`）：点 marker 只选中节点并刷信息卡主题（不跳转，`:531-534` 注释），`nodeThemes.getNodeTheme/themeSoftStyle` 生成柔和主题样式与环境描述（`:540-545`）。
- `handleCalloutTap`（`:551-555`）：点气泡直达 `node-detail?id=`。
- `goSelectedDetail`（`:560-564`）：信息卡「查看详情」按钮。
- 三个事件对 id=999 旗帜均忽略（`:537`、`:553`），且**不校验节点状态**——未解锁节点同样可选中/进详情（不变量 8）。

### 4.6 Canvas 星空模式：页面侧只剩建内核与 rAF

- **Canvas 类型（实测）**：WXML `<canvas type="2d" id="routeMap">`（`march.wxml:83-91`）；`initCanvas()`（`:568-591`）用 `wx.createSelectorQuery().select('#routeMap').fields({node:true,size:true})` 取节点后 `node.getContext('2d')`（`:569-581`），即 **Canvas 2D 新接口**，非旧版 `wx.createCanvasContext`（与 `.qoder/frontend/utils/routeCanvas.js.md` §4 的核实结论一致）。dpr 取 `wx.getSystemInfoSync().pixelRatio || 2`（`:576`），画布物理尺寸 = CSS 尺寸 × dpr 并 `ctx.scale(dpr,dpr)`（`:578-582`）。
- **建内核**：`this.canvas = node` 后 `this.hud = hudMap.createHudMap({ ctx, cw: width, ch: height, dpr })`（`:584-585`），已有路线则 `hud.setRoute(this.routeData)`（`:586`，首次建内核 ⇒ 内核内 `path` 为空 ⇒ 全量重建+入场描画），**S4 另把 last-good 的 `_overlayStats` 立即回灌** `hud.setStats`（`:588`，切回星空模式先出上次数值再由 `loadOverlay` 刷新），再 `startAnim()`（`:589`）。
- **`initCanvas` 的唯一调用点是 `switchMode`**（`:390`）：默认 real 模式不进 Canvas。`switchMode`（`:383-404`）先 `stopAnim()`（`:387`）；切到 canvas 走 `initCanvas` + `loadOverlay()`（`:390-391`）；切回 real 时在 setData 回调里 `hud.dispose()` + `hud = null` + `canvas = null`（`:394-400`）——**释放画布上下文、离屏静态层与光晕精灵**（`<canvas>` 节点已被 `wx:else` 移除），随后用最新路线 `renderRoute` 重建实景 markers（`:401`）并播镜头动画（`:402`）。
- **rAF 循环留在页面**：`startAnim()`（`:596-609`）先 `stopAnim()` 防双链；循环体每帧 `this.hud.draw(Date.now()/1000)`（`:601`），续帧优先 `canvas.requestAnimationFrame`（Canvas 2D 节点级 rAF，`:602-603`），不可用时降级 `setTimeout(loop,16)`（`:605`）。`stopAnim()`（`:611-618`）置 `running=false`、`cancelAnimationFrame` + `clearTimeout` 双清、句柄置 undefined。**只在星空模式且页面前台时运转**：onHide/onUnload/switchMode/startAnim 四处都调 stopAnim（`:133`、`:144`、`:387`、`:597`）。
- **绘制管线全在内核**：静态 scenery 离屏烘焙、星空三层、区域粒子、金轨+彗尾、三态节点、进度旗、点亮动画、L7 数据叠加层、L8 飞线、观景钳制与命中逆变换——逐函数见 `.qoder/frontend/utils/hudMap.js.md` §4.5–§4.9。重绘时机：星空模式+页面前台由 rAF 持续逐帧；数据变化不直接触发重绘（`renderRoute` 只写 `routeData`/调 `hud.setRoute`，`loadOverlay` 只调 `hud.setStats`，均由下一帧 `draw` 自然读取）；real 模式无 Canvas 绘制。画布尺寸固定 750×860rpx（`march.wxss:126-130`），无 resize/scroll 监听。

### 4.7 星空全景手势（§13.4，`:625-711`）

pan/pinch 手势数学属事件层、留在本页；**观景变换 `view` 由内核持有**，改写后必须调 `hud.clampView()`（`:620-623` 区块注释）：

- `onMapTouchStart`（`:625-644`）：单指建 pan 手势（记起点/当前偏移/时间，偏移初值读 `hud.view.ox/oy`），双指建 pinch（记初始指距/`hud.view.scale`/中心锚点）；`!this.hud` 直接返回。
- `onMapTouchMove`（`:646-682`）：pan 位移超 6px 判 moved 后写 `v.ox/v.oy` + `hud.clampView()`（`:656-660`）；pinch 以双指中心为锚点缩放（保持锚点场景坐标不动，`:672-679`）+ `hud.clampView()`（`:680`）；单指转双指时重新锚定基准避免跳变（`:663-671`）。
- `onMapTouchEnd`（`:684-701`）：干净单指轻点（未移动且 <350ms）→ 300ms 内二连击 `hud.resetView()`（`:693-696`），否则 `hitNode`（`:699`）。
- `hitNode`（`:707-711`）：委托 `hud.hitTest(sx, sy)`（屏幕→场景逆变换与命中半径 22/scale 在内核），命中即 `navigateTo node-detail?id=`——含未解锁节点（`:703-706` 注释，不变量 8）。

### 4.8 节点点亮动画链与完成仪式

**点亮链（步数同步 → light-up → 弹窗 → 重绘）**：首页或本页 `handleSyncSteps` 同步步数落库（`.qoder/frontend/services/sport.js.md`）→ 本页 onShow/下拉/同步后 `refresh()` 调 `POST /march/light-up`（后端幂等判定与 `newlyLit/newlyCompletedChapters/newMedals` 三段返回见 `.qoder/backend/app/api/routes/march.py.md` §4.3）→ `playArriveIfNeeded()`（`:308-320`）：开场期间暂缓由 `dismissIntro` 补播（`:310`）；消费并清空 `_pendingLit/_pendingChapters`（`:311-314`）；有内核时 `this.hud.playArrive(lit.map(n => n.id))` 触发星空点亮动画（`:317`）；`this._popupMs = arrivePopup.playArriveQueue(this, lit, chapters)`（`:319`，队列播放器写 `data.litPopup` 与 `page.popupTimer`，返回总时长，`.qoder/frontend/utils/arrivePopup.js.md` §4.3）。粒子预生成与四阶段绘制在内核（`.qoder/frontend/utils/hudMap.js.md` §4.7）。

- **完成仪式（§20）`maybeStartCeremony(route)`（`:276-292`）**，逐步：
  1. 触发条件：后端 `GET /march/route` 下发 `ceremonyPending=true`（全部点亮且未观看时才有，`.qoder/backend/app/api/routes/march.py.md` §4.4），否则直接 return（`:277`）。
  2. 开场播放中 → 存入 `_ceremonyRoute` 顺延，由 `dismissIntro` 再触发（`:278-281`、`:119-123`）。
  3. `_ceremonyStarted` 或 `_ceremonyTimer` 已存在则不重复安排（`:284`）；定时器被 onHide 取消（切 tab）时允许下次 onShow 经 refresh 重新安排（`:282-283` 注释）。
  4. 延时 = 抵达卡队列总时长 `_popupMs`（消费后置 0，`:285-286`），保证 §20.2「事件卡队列播完再进仪式」。
  5. 到点置 `_ceremonyStarted=true` 并 `wx.navigateTo('/pages/ceremony/ceremony')`（`:287-291`）——**本页生命周期内只自动触发一次**（`:274` 注释，用户中途返回不循环跳转；tab 页常驻不 unload，故返回后不再自动跳）。
  6. 已观看标记由仪式页调 `markCeremony` 向后端落库（`.qoder/frontend/services/march.js.md` §4.5），本页只消费 `ceremonyPending` 不写入。
- `goCeremony()`（`:297-300`）：`finished` 时头部横幅（`march.wxml:38`）手动进仪式页复看（§20.4）。

### 4.9 实时数据叠加层的页面侧（S4，`:148-197`）

L7/L8 的绘制全在内核（`.qoder/frontend/utils/hudMap.js.md` §4.8），本页只负责「取数 + 归一化 + 注入 + WS 生命周期」三件事：

- **`loadOverlay()`（`:175-197`）**：唯一取数入口。① **模式守卫**：`data.mode !== 'canvas'` 直接 `Promise.resolve()`（`:176`）——实景模式没有消费方，不产生任何请求；② 记 `_statsAt = Date.now()` 作节流基准（`:177`，**在请求发出前就写**，故并发/失败也占用一个节流窗口）；③ `Promise.all([march.getRouteStats(), broadcast.getToday()])`（`:178`，两个聚合接口并发）；④ 合并归一化为 `_overlayStats = { todayUsers, todayLit: global.todayLitCount, todaySteps, litMap }`（`:186-191`，`litMap[nodeId] = { nodeId, litCount, completionRate }` 由 `route-stats` 的 `nodes` 数组转 map），再 `hud.setStats(this._overlayStats)`（`:192`，内核在注入时一次性格式化，见 hudMap 文档 §4.8）；⑤ `.catch` 静默（`:194-196`）：失败**不清空**内核已注入的数据（last-good），首次即失败则内核显示 `--`。
- **三个触发点**：`refresh()` 开头非阻塞触发（`:206`）、`switchMode` 切到 canvas 时（`:391`）、WS `data_changed` 节流后（`:164`）。`initCanvas` 不取数、只回灌 last-good（`:588`）。
- **`handleWsMessage(msg)`（`:159-168`）**：`data_changed` → 距上次 `_statsAt` 不足 `STATS_THROTTLE`（5000ms，`:21`）直接丢弃，否则 `loadOverlay()`（`:161-166`）——**刻意不重拉 `/march/route`**，他人数据变更不该重绘自己的路线；`activity` 且带 `nodeId` 且有内核 → `hud.playFlyLine(msg.nodeId)`（`:167`），**纯绘制反馈、不发任何请求**；其它消息类型忽略。
- **订阅生命周期**：`onShow` 订阅（`:75`）、`onHide`/`onUnload` 经 `unsubscribeWs()` 退订（`:128`、`:138`、`:148-152`）。切 tab 再回来会重新订阅，`ws.subscribe` 幂等由 `_wsUnsub` 是否持有保证。
- **WS 消息契约**：`type` 与 `nodeId`（camelCase）由后端 `app/core/ws.py` 的 `build_event`/`build_activity` 决定（`.qoder/backend/app/core/ws.py.md`、`.qoder/frontend/services/ws.js.md`）；本页只认这两个字段，不解析 payload 其余部分。

## 4-1. WXML 专章（`march.wxml`，140 行）

| 区块 | 行号 | 内容与绑定 |
|---|---|---|
| 开场动画覆盖层 | `:3-11` | `wx:if="{{showIntro}}"`，四行文案（1934 / 🚩 瑞金·1934年10月 / 长征开始 / 你的长征旅程 正式开始，`:5-8`），整层 `bindtap="skipIntro"` 点击任意处跳过（`:3`），右下角跳过提示（`:10`） |
| 过渡纱幕 | `:14` | `wx:if="{{showVeil}}"`，纯视觉层（wxss 侧 `pointer-events:none` 不拦截操作） |
| 抵达事件卡弹层 | `:17-32` | `wx:if="{{litPopup}}"`；`kind==='chapter'` 渲染章节卡（🚩 + title + intro，`:18-23`），否则节点卡（★ +「恭喜抵达」+ icon/name + historicalTime + nextName/nextRemain，无下一站时显示「🏆 长征路线已全部完成！」，`:24-31`）——字段与 `arrivePopup.buildQueue` 卡片结构一一对应（`.qoder/frontend/utils/arrivePopup.js.md` §8.1 硬契约） |
| 路线总览头部 | `:35-39` | 标题 +「累计 x/y 步 · 已点亮 n/m」；`finished` 时完成横幅 `bindtap="goCeremony"`（`:38`） |
| 当前章节卡 | `:42-50` | `wx:if="{{currentChapter}}"`；title、litCount/totalCount、进度条 `style="width: {{currentChapter.progressPct}}%"`（`:48`，js 侧预计算） |
| 模式切换 | `:53-64` | 双按钮 `data-mode="real"/"canvas"` + `bindtap="switchMode"`，active 类按 `mode` 三元切换 |
| 地图区 | `:70-113` | 见下述要点 |
| 节点列表 | `:116-139` | `wx:for="{{nodes}}"`（`:118`）+ `wx:key="id"`；每项 `data-id` + `bindtap="handleNodeTap"`；图标/名称/徽章按 `item.status` 三态；current 项额外显示「当前进度 x/y 步 · 还需 n 步」 |

地图区要点：

1. `<map>` 折线属性写作 **`polyline="{{polylines}}"`**（`:80`，`frontend/AGENTS.md` §5.2 特别提示的属性名）；`include-points`/`markers` 绑定同名字段（`:78-79`）；`bindmarkertap`/`bindcallouttap`（`:83-84`）；`enable-scroll`/`enable-zoom` 开启（`:81-82`）。
2. `<canvas type="2d" id="routeMap">` 与 `<map>` 用 `wx:if="{{mode === 'real'}}"` / `wx:else` 互斥（`:72`、`:87`）——切回实景时 canvas 节点被移除，这正是 `switchMode` 必须 `hud.dispose()` 释放画布资源的原因（`march.js:329-335` 注释）；三个 touch 事件绑定全景手势（`:91-93`）。
3. `map-hint` 提示条**仅实景模式渲染**（`:97`，`wx:if="{{mode === 'real'}}"`，文案「点击地图节点查看信息…」）。**S3（`835f46f`）修正了原生层遮挡缺陷**：`<canvas type="2d">` 在开发者工具中是不透明原生层、位于所有 DOM 之上且 `visibility` 无效，星空模式下 DOM 提示条本就不可见；现星空模式的操作提示由内核 `hud.drawHudHint` 直接画进画布（视口固定切角面板，`.qoder/frontend/utils/hudMap.js.md` §4.6），DOM 浮层只留实景模式。
4. 选中节点信息卡仅 real 模式且有选中时渲染（`:100-112`）：`style="{{selectedThemeStyle}}"` 区域氛围主题（§12）、图标/徽章三态、current 态显示步数进度、`selectedThemeEnv` 环境描述、「查看详情」按钮 `bindtap="goSelectedDetail"`（`:111`）。
5. 列表项交错入场 `style="animation-delay: {{index * 70}}ms"`（`:121`，乘法表达式合法）；状态文案全部用三元表达式内联（节点卡与列表多处），**全文件无原生方法调用**，符合 §5.2。

## 4-2. WXSS 专章（`march.wxss`，548 行）

全部 rpx 单位；头部渐变 `#A00D26 → #C8102E`（`:6-10`）与导航栏主色一致（`frontend/AGENTS.md` §2 约定色）。区块一览：

| 区块 | 行号 | 要点 |
|---|---|---|
| 页面容器 | `:1-3` | 底部留白 60rpx |
| 头部总览 | `:5-52` | 标题/副标题 fadeUp 交错入场；`finish-banner` 完成横幅半透明白底 popIn（`:43-52`）；就地同步按钮（B6，`:26-42`） |
| 章节卡 | `:53-104` | 负 margin 叠在头部下缘；进度条金色渐变 + `transition: width 0.6s`（`:82-88`）；章节仪式卡 intro 文案样式（`:97-104`） |
| 模式切换 | `:105-132` | 胶囊双按钮（左圆角、相邻右圆角 `:123-126`）；active 态长征红渐变+红投影（`:127-132`） |
| 地图容器 | `:133-176` | `map-wrap` 圆角裁切 + cardIn 入场（`:134-141`）与 `position:relative` 供内部绝对定位（`:174-176`）；`route-map`/`route-map-real` 均固定 **750×860rpx**（`:144-149`、`:152-156`）；**S3 给 `.route-map` 加 `background:#050B16`**（`:148`，与内核 L0 深空底一致、避免首帧前白闪）；`map-hint` 底部居中悬浮提示条，`pointer-events:none` 不挡手势（`:158-172`，仅实景模式渲染，见 §4-1 要点 3） |
| 选中节点信息卡 | `:178-275` | 绝对定位浮于地图下部（避开提示条，`:179-190`）；圆形图标与徽章按 completed（金渐变）/current（红描边）/默认灰三态；区域氛围说明行（§12，`:257-275`）；描边按钮 |
| 节点列表 | `:276-391` | 卡片项 `:active` 缩放 0.97 反馈；`anim-card` 交错入场（`:297` 起，延迟由 WXML 内联）；图标 current 态 pulseRed 脉冲 / completed 态 pulseGlow 呼吸；名称/徽章/目标/还需步数按状态配色 |
| 抵达卡弹层 | `:392-458` | fixed 全屏遮罩 z-index 999 + litFadeIn（`:393-410`）；卡片米金渐变、popIn 弹性曲线 `cubic-bezier(0.34,1.56,0.64,1)`；大星 spinIn |
| 开场动画 | `:459-548` | 覆盖层红渐变、z-index 999、整层 2.85s 起 0.45s 淡出；四行文案依次 0.15s/0.85s/1.55s/2.25s 延迟入场（年份 128rpx 金字 `:488`）；跳过按钮右下角半透明（`:519`）；纱幕 z-index 998 + `pointer-events:none` 不拦截操作（`:533` 起） |

keyframes 归属：本文件自定义 `pulseRed`（`:332-335`）、`litFadeIn`（`:407-410`）、`introFadeOut`（`:528-530`）、`veilOut`（`:545-548`）；引用的 `fadeUp/popIn/spinIn/cardIn/pulseGlow` 定义在全局 `frontend/app.wxss`（实测 `app.wxss:169-242` 存在同名 keyframes）。注意 `pulseRed` 在 `app.wxss:242` 也有定义，页面样式后加载生效（页面内以本文件 `:332-335` 为准）。

## 4-3. JSON 专章（`march.json`，6 行）

4 项页面配置：`navigationBarTitleText: "长征路线"`、`navigationBarBackgroundColor: "#C8102E"`、`navigationBarTextStyle: "white"`（`march.json:2-4`）、`enablePullDownRefresh: true`（`:5`，`53f2d62` 与页面 `onPullDownRefresh` 同批加入，配合 `march.js:237-239`）。无 `usingComponents`（页面不用自定义组件）、无 `disableScroll`。页面注册与 tabBar 配置在 `frontend/app.json`，符合 `frontend/AGENTS.md` §5.3「page.json 只声明页面自己的配置」。

（本文档曾记「json 仅 3 项配置、未见 `enablePullDownRefresh`」，2026-10-19 实读 `march.json` 更正：该键自 `53f2d62` 起存在，下拉刷新配置完整；原 §9 第 8 条待确认项随之关闭。）

## 5. 输入与输出

**`data` 状态字段（按关注点分组，`:36-65`）**：

| 分组 | 字段 | 说明 |
|---|---|---|
| 路线/进度 | `nodes`、`currentSteps`、`totalSteps`、`litCount`、`totalCount`、`finished`、`currentChapter` | 由 `renderRoute` 的 patch 一次性 setData（`:335-345`）；`nodes` 为 `toViewNode` 裁剪后的 6 字段视图对象 |
| 实景地图 | `mode`（'real'/'canvas'）、`mapLat`/`mapLng`/`mapScale`（初始 34.5/108.5/4）、`includePoints`、`markers`、`polylines`、`selectedNode`、`selectedThemeStyle`、`selectedThemeEnv` | 仅 real 模式消费；`selectedTheme*` 为 §12 区域氛围内联样式/文案；`mode` 同时是 L7 取数的守卫条件（`:176`） |
| 动画/弹层 | `showIntro`、`showVeil`、`litPopup` | 开场/纱幕/抵达卡；`litPopup` 由 arrivePopup 模块经 `setData` 写入 |
| 就地同步 | `syncing` | B6 同步锁（`:63-64`、`:247-248`、`:267`） |

**S4 的 L7/L8 数据不进 `data`**：全员统计与飞线态都是绘制态，直接注入内核（`hud.setStats`/`hud.playFlyLine`），不 `setData`、不触发 WXML 重渲染。

**实例属性（非 data、不走 setData，均挂 Page 实例）**：

| 分组 | 属性 | 写入点 |
|---|---|---|
| 路线快照 | `routeData` | `renderRoute` `:328`（实景分支与列表消费；星空绘制读内核 `hud.route`） |
| Canvas 基础 | `canvas`、`hud`（渲染内核实例） | `initCanvas` `:584-585`；`switchMode` 切回 real 时 `hud.dispose()` 后置 null `:394-400` |
| L7/L8（S4） | `_overlayStats`（last-good 归一化数据）、`_statsAt`（节流基准）、`_wsUnsub`（WS 退订函数） | `loadOverlay` `:177`、`:186-192`；`initCanvas` 回灌 `:588`；`onShow` `:75` / `unsubscribeWs` `:148-152` |
| 手势 | `_gesture`、`_lastTap` | `:630/:665`、`:693-698` |
| 动画态 | `animId`、`running` | §4.1 盘点表 #6（rAF 链在页面；`arriveFx`/`progressAnim`/`flyLine` 在内核） |
| 流程态 | `_refreshRequestId`、`_pendingLit`、`_pendingChapters`、`_popupMs`、`_introChecked`、`_viewPlayed`、`_ceremonyStarted`、`_ceremonyRoute` | §4.2、§4.3、§4.8 |

**绘制状态全部在内核实例上**（`view`/`nodePts`/`path`/`nodePathIdx`/`farStars`/`stars`/`trailDust`/`regionMotes`/`staticLayer`/`glowGold`/`glowRed`/`glowCyan`/`stats`/`flyLine`/`_goldGrad`/`_flagGrad`/`_sweepGrad`/`_scanGrad`/`_labelW`/`_hintW`/`_ringPct`/`_ringText`/`animStart`/`progressAnim`/`arriveFx`），清单见 `.qoder/frontend/utils/hudMap.js.md` §4.1；automator 白盒断言读 `page.hud.*`。

**页面跳转出口**：`node-detail?id=`（4 处：`:554`、`:563`、`:710`、`:719`）、`ceremony`（`:290`、`:299`）、`launch`（未登录 reLaunch，`:69`）。

**事件处理一览（WXML 绑定 → js）**：`skipIntro`、`goCeremony`、`switchMode`、`handleMarkerTap`、`handleCalloutTap`、`goSelectedDetail`、`onMapTouchStart/Move/End`、`handleNodeTap`、`handleSyncSteps`；非 WXML 入口另有 `onPullDownRefresh`（`:237`）与 WS 回调 `handleWsMessage`（`:159`，经 `ws.subscribe` 注册）。

## 6. 依赖关系

- **require（`:13-19`，全部 7 个）**：`services/march.js`（`hasPlayedIntro/markIntroPlayed/lightUpNodes/getRoute/getRouteStats` 五个函数被调用：`:93`、`:112`、`:211`、`:221`、`:178`；该服务 9 个导出中本页用 5 个，`.qoder/frontend/services/march.js.md` §4）、`services/sport.js`（`syncToday`，`:250`，B6 就地同步）、`services/broadcast.js`（`getToday`，`:178`，S4 取今日播报全局段）、`services/ws.js`（`subscribe`，`:75`，S4 订阅推送）、`utils/arrivePopup.js`（`playArriveQueue`，`:319`）、`utils/hudMap.js`（`createHudMap`，`:585`；S2 起替代本页原先对 `utils/routeCanvas.js` 的直接依赖——**本页已不再 require routeCanvas**，共享画布纯函数改由内核消费）、`data/node-themes.js`（`getNodeTheme/themeSoftStyle`，`:354-360`、`:540-545`）。
- **wx API**：`createSelectorQuery`、`getSystemInfoSync`（`:576`）、`reLaunch/navigateTo/setData/setTimeout/showToast`（`:226`、`:255-264`）。
- **后端路径（经服务层）**：`GET /api/march/route`、`POST /api/march/light-up`、`GET /api/march/route-stats`（`.qoder/backend/app/api/routes/march.py.md` §4.1/§4.6）、`POST /api/sport/sync`（经 `sport.syncToday`）、`GET /api/broadcast/today`（经 `broadcast.getToday`）、WS 推送 `activity`/`data_changed`（`app/core/ws.py`）。
- **被依赖**：`frontend/app.json` tabBar 注册；无其它页面 require 本页。

## 7. 业务规则

1. **onShow + refresh**（不变量 1）：每次显隐都重走 light-up → route 链；`_refreshRequestId` 保证旧响应不覆盖新响应（`:202-224`）。下拉刷新与就地同步复用同一 `refresh()`（`:238`、`:261`）。
2. **登录守卫**：onShow 检查 `app.globalData.loggedIn`，未登录 reLaunch 启动页（`:68-71`）。
3. **任意节点可看历史**（不变量 8）：列表点击、Canvas 命中（内核 `hitTest`）、marker 点选、气泡直达四条入口均不拦截未解锁节点。
4. **轨迹推进分级**（§3.5）：首次渲染播 1400ms 完整入场描画 + 实景镜头俯冲各一次（`_viewPlayed` 防重播，`:113-116`、`:364-367`）；此后步数刷新只做 800ms 增量推进——**判定在内核 `setRoute`**（`.qoder/frontend/utils/hudMap.js.md` §4.2），本页不得自行重播。
5. **点亮动画只由 light-up 响应驱动**：已点亮节点点击仅看详情、不重播动画（`:306` 注释）；触发经 `hud.playArrive`（`:317`）。L8 飞线则只由 WS `activity` 驱动（`:167`），与自己的点亮动画互不相干。
6. **两个「仅首次」标记存储位置不同**：开场动画标记在本地 Storage（换设备重播）；完成仪式 `ceremonyPending` 由后端持久化判定（换设备不重播），本页只消费不写入（`.qoder/frontend/services/march.js.md` §7.4）。
7. **仪式跳转排队规则**（§20.2）：开场动画 > 抵达卡队列 > 仪式跳转，依次顺延（`:278-281`、`:285-286`）；页面生命周期内自动触发仅一次（`:284`、`:289`）。
8. **跨页脏标记**：light-up 有新点亮/新完成章节、或就地同步成功时置 `app.globalData.homeDirty = true`（`:219`、`:253`），首页 onShow 据此绕过 30s 节流强制刷新。
9. **性能预算**（§13.4 + 根 `agents.md` §2.4）：星空元素构建期一次性分配、点亮粒子限量、静态层离屏烘焙、渐变与标签宽度缓存、L7 数值注入时一次性格式化均在**内核**（`.qoder/frontend/utils/hudMap.js.md` §7）；本页侧为 setData 负载经 `toViewNode` 裁剪（`:24-33`）、L7 数据不进 `data`、WS `data_changed` 5s 节流（`:21`、`:163`）。
10. **V2.0 积分口径**：点亮不发放积分、抵达卡不含积分字段（`.qoder/frontend/services/march.js.md` §7.2）。
11. **L7 取数只在星空模式**（S4）：`loadOverlay` 首行即模式守卫（`:176`），实景模式下 WS `data_changed` 与 `refresh` 都不会产生聚合请求；他人数据变更**不重拉 `/march/route`**（`:154-158` 注释），自己的进度只由 refresh/同步步数驱动。

## 8. 修改约束

1. **不变量 6 的落点已拆分**（`frontend/AGENTS.md` §4）：绘制侧（每帧读 `hud.route`、静态元素只烘焙一次、`_goldGrad/_flagGrad` 与光晕精灵画布重建时重置、离屏 try/catch 禁删）在 `utils/hudMap.js`（`.qoder/frontend/utils/hudMap.js.md` §8）；**本页侧**约束为：切回实景必须 `hud.dispose()` 并置 null（`:394-400`）、改写 `hud.view` 后必须 `hud.clampView()`（`:659`、`:680`）、rAF 循环的 onHide/onUnload 清理不得移除（`:133`、`:144`）。
2. `popupTimer` / `data.litPopup` 属性名是与 arrivePopup 模块的清理契约（`.qoder/frontend/utils/arrivePopup.js.md` §8.2），onHide/onUnload 按此名 clearTimeout（`:130`、`:140`）。
3. `routeCanvas` 返回结构 `{path,dist,len,nodePathIndex}` 与 `node-themes` 的 `particleConfig.type` 枚举是跨文件硬契约，消费方现为**内核**（`.qoder/frontend/utils/hudMap.js.md` §8.2/§8.5）；本页不再直接解构，改这些字段不触及本页。
4. light-up/route 响应字段（`newlyLit/newlyCompletedChapters/routeProgress/chapters/currentChapterId/ceremonyPending/finished/_fromCache`）是后端 camelCase 契约（`.qoder/backend/app/api/routes/march.py.md` §8.2），增删须双端同步；S4 新增的 `route-stats` 字段（`totalUsers/nodes[].nodeId/litCount/completionRate`）与 `broadcast/today` 的 `global.todayUsers/todayLitCount/todaySteps` 同样是双端契约，改动须同步 `loadOverlay` 的归一化（`:186-191`）与内核 `setStats`（hudMap 文档 §8.8）。
5. `<map>` 的 `polyline` 属性名、`wx:key="id"`、WXML 禁原生方法调用等遵守 `frontend/AGENTS.md` §5.2。
6. 新增定时器/动画/订阅必须同时挂入 onHide 与 onUnload 清理（本页既有 5 个定时器 + 1 个 rAF 链 + 1 个 WS 订阅全部双清，`_veilTimer` 例外见 §9 第 1 条，勿再扩大例外）。
7. **automator 断言口径**：五个套件（`p0-march`/`p1-starry-march`/`tabbar-starmap`/`s16-review-smoke`/`hud-overlay`）自 S2 起读 `page.hud.*` 且不留兼容别名；给内核加兼容转发或把绘制状态搬回页面会静默破坏断言。
8. `frontend/AGENTS.md` §4 不变量 6 提到的「真实经纬度 `NODE_COORDS`」静态坐标表**在现行代码中不存在**（全 `frontend/` grep 零命中；坐标由 `/march/route` 下发，`march.js:411-414`）——该不变量措辞滞后，按代码事实理解，勿据此恢复硬编码坐标。
9. **WS 订阅与取数不得下沉到内核**（S4）：`services/ws` 只能由本页 require；内核只接受 `setStats(归一化对象)` 与 `playFlyLine(nodeId)`，把 WS 消息对象或接口响应直接丢给内核会击穿「内核不认协议形状」的边界（hudMap 文档 §8.8）。

## 9. 当前实现状态

- **已实现**：双模式地图、开场动画、章节卡、抵达卡队列、星空点亮动画与全景手势（绘制在内核）、完成仪式触发、增量轨迹推进、并发刷新守卫、下拉刷新与就地同步行军步数（B6）、**S4 实时数据叠加层的页面侧（WS 订阅 + 双接口合并注入 + last-good 回灌）**；提交演进见 §10。
- **存在问题 / 已知事项（逐条实读取证）**：
  1. **`_veilTimer` 未在 `onHide` 清理**：onHide 清了 `_viewTimer/popupTimer/_introTimer/_ceremonyTimer`（`:129-132`）但没有 `_veilTimer`，仅 `onUnload` 清（`:142`）。纱幕 560ms 内切走 tab 时定时器仍会触发一次 `setData({showVeil:false})`（`:95`）——影响极小（单次、幂等），但与本页「定时器双清」惯例不对称，属轻微泄漏点。
  2. **`stopAnim` 混用两种句柄空间**：`:613-616` 对同一 `animId` 先 `canvas.cancelAnimationFrame` 再 `clearTimeout`——rAF 句柄传给 clearTimeout（或反之）是无效操作但无害；现状能正确停链（`running=false` 兜底 `:600`），非缺陷，记录为事实。
  3. **无 `onLoad`**：全部逻辑挂 onShow，首次进入即触发一次完整 light-up + route 请求；属设计选择（tab 页复用），非缺陷。
  4. `wx.getSystemInfoSync()`（`:576`）为微信已标记废弃的同步接口——现状可用，未迁移 `wx.getWindowInfo` 等新接口，是否迁移**待确认**。
  5. **WebSocket（S4 起本页已订阅）**：本页在星空模式消费 `activity`/`data_changed` 两类推送（§4.9）。生产环境 wss 不可用的阻塞问题（登记于 `.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1、2 项）**会影响 L7/L8 的实时性**（飞线不出现、全员数据只能靠 refresh 触发的一次性拉取），但**不影响路线主链**——`/march/route`、light-up、完成仪式全部走 REST。
  6. 抵达卡弹层无点击关闭绑定（`march.wxml:17-32` 遮罩层无 bindtap），只能等队列自动播完——现状行为，是否符合预期**待确认**。
  7. **`map-hint` 原生层遮挡已于 S3 修复（`835f46f`）**：`<canvas type="2d">` 是开发者工具中的不透明原生层、位于 DOM 之上且 `visibility` 无效；现 `march.wxml:97` 的 DOM 提示条加 `wx:if="{{mode === 'real'}}"` 只留实景模式，星空模式的操作提示由内核 `hud.drawHudHint` 画进画布（视口固定），缺陷关闭。
  8. **L7/L8 的端到端链路未在真机验证**：S4 只做了页面分支白盒断言（`hud-overlay.cjs` OV-07/OV-08/OV-09）与直接调 `playFlyLine` 的视觉验证；WS `activity` 由第二个客户端点亮触发、以及生产 wss 下的表现，留待 S5 真机验收。
- **待开发**：S5 帧率自适应降级 + 真机验收（方案已排期，尚未实现——勿当作既有功能引用）。S3 深空 HUD 视觉重构（`835f46f`）与 S4 实时叠加层（`5b26b07`）均已于 2026-10-19 完成，勿再当待办引用。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/march/march.js` + `git log --oneline -- frontend/pages/march/`；提交号在 `docs/迭代记录.md` 均有对应条目。按时间倒序、按主题归并；未逐行核对 diff 的条目以提交信息为据并注明。

### 2026-10-19（`835f46f`）
- 需求：深空 HUD 科技感地图五阶段方案的 S3——星空模式视觉重做为深空 HUD（L0~L6），几何/行为不变。
- 修改内容（涉本四件套，仅 wxml/wxss，`march.js` 零改动）：`march.wxml` 的 `.map-hint` 加 `wx:if="{{mode === 'real'}}"`（`:97`，星空提示改由内核画进画布，修复原生层遮挡缺陷）；`march.wxss` 的 `.route-map` 加 `background:#050B16`（`:148`，与内核 L0 深空底一致、避免首帧白闪）。绘制重做全部在 `utils/hudMap.js` 与 `utils/routeCanvas.js`（见两文档 §10 的同提交条目）。
- 测试结果：automator 四套件 `tabbar-starmap` 8/8、`p0-march` 6/6、`p1-starry-march` 4/4、`s16-review-smoke` 16/18（R7/R12 预存 mock 登录 502）；与 S2 基线逐项一致；改造前后截图逐图比对几何一致。报告 `frontend/test/docs/s31-deep-space-hud-report.md`；`docs/迭代记录.md` 的 `835f46f` 条目。

### 2026-10-19（`2862453`）
- 需求：深空 HUD 科技感地图五阶段方案的 S2——抽离渲染内核，为 S3 视觉重做固化「行为不变」基线。
- 修改内容：新建 `utils/hudMap.js`（996 行），本页 1521→654 行：删除全部绘制方法与绘制状态（`buildMap`/`buildStaticLayer`/`buildGlowSprites`/`paintScenery`/`drawRidges`/`drawFrame`/`drawCompass`/`drawClouds`/`drawStars`/`drawRegionMotes`/`drawRoute`/`drawNodes`/`drawNodeLabel`/`drawProgressFlag`/`drawArriveFx`/`makeArriveParticles`/`calcRouteProgress`/`currentRatio`/`dist2Index`/`sampleSkyPoint`/`clampView`/`resetView`），`initCanvas` 改建内核（`:520`）、`renderRoute` canvas 分支改 `hud.setRoute`（`:309`）、`switchMode` 切实景改 `hud.dispose`（`:331-335`）、手势改读写 `hud.view` + `hud.clampView()`、`hitNode` 委托 `hud.hitTest`、`playArriveIfNeeded` 改 `hud.playArrive`（`:253`）；onShow 动画恢复条件改 `this.hud && this.routeData`（`:68`）。同批改写 4 个 automator 套件、同步 `frontend/AGENTS.md` 不变量 6 与 `frontend/design.md` §4.6。
- 测试结果：automator 四套件 `tabbar-starmap` 8/8、`p0-march` 6/6、`p1-starry-march` 4/4、`s16-review-smoke` 16/18（R7/R12 预存 mock 登录 502）；关键数值与搬迁前基线逐项一致、截图逐图比对一致。报告 `frontend/test/docs/s30-hud-kernel-extract-report.md`；`docs/迭代记录.md` 的 `2862453` 条目。

### 2026-10-18（`53f2d62`）
- 需求：十项增强小程序端落地（B6 就地同步行军步数等）。
- 修改内容（涉本文件，实读确认）：新增 `handleSyncSteps`（`:182-205`）与 `data.syncing`、`onPullDownRefresh`（`:173-175`）；`refresh()` 改返回 Promise 并在 light-up 有新结果时置 `app.globalData.homeDirty`（`:154-156`）；route 响应 `_fromCache` 时 toast 缓存提示（`:162`）。
- 测试结果：见 `docs/迭代记录.md` 的 `53f2d62` 条目。

### 2026-10-15（`9c84954`、`50aef7d`）
- 需求：视觉缺陷修复与星空地图优化。
- 修改内容：`9c84954` 仅改 `march.wxml`（节点状态徽章 text 内换行渲染空行，收为单行）；`50aef7d` 改星空地图分层错峰闪烁、加强当前节点柔光（绘制实现现已在内核 `drawStars`/`drawNodes`，`.qoder/frontend/utils/hudMap.js.md` §4.6）并同批交付 tabBar 图标。
- 测试结果：见 `docs/迭代记录.md` 的 `9c84954`、`50aef7d` 条目。

### 2026-10-13（`44eb77b`）
- 需求：V2.0 小程序批次（答题限时/积分排行/活动拦截等）。
- 修改内容（涉本四件套，git stat 实测仅 wxml/wxss）：删除抵达卡弹层的积分展示（口径见 `.qoder/frontend/services/march.js.md` §7.2「点亮不再发放积分」）。
- 测试结果：提交信息自述「新增 v2 自动化验收（14/14）与报告」；细节见 `docs/迭代记录.md` 的 `44eb77b` 条目。

### 2026-10-11（`e70b59f`、`01e214a`）
- 需求：小程序代码审查修复批次；V1.0 启动页自动登录。
- 修改内容（涉本文件）：`e70b59f` 落地并发请求守卫 `_refreshRequestId`、onShow 动画恢复（`:68`）、登录守卫与计时器清理（onHide/onUnload 现行结构）、`toViewNode` 精简 setData、消费 arrivePopup 返回时长 `_popupMs`（关联文件清单与逐项见 `docs/迭代记录.md` 的 `e70b59f` 条目及 `.qoder/frontend/utils/arrivePopup.js.md` §10）；`01e214a` 同批取消强制选组织（本页 diff 未逐行核对，以提交信息为据）。
- 测试结果：见 `docs/迭代记录.md` 对应条目。

### 2026-10-04（`79004f1`）
- 需求：区域氛围与长征完成仪式（P2-2，需求 §12/§20）。
- 修改内容（涉本文件）：接入 `node-themes` 主题（选中卡柔和样式 + 星空环境粒子）、`maybeStartCeremony/goCeremony` 仪式触发链、完成横幅；同批新建 `routeCanvas.js`（从本页抽取共享画布纯函数）与 ceremony 页（`.qoder/frontend/utils/routeCanvas.js.md` §10、`.qoder/frontend/data/node-themes.js.md` §10）。
- 测试结果：见 `docs/迭代记录.md` 的 `79004f1` 条目（automator `p2-theme-ceremony.cjs`）。

### 2026-10-03（`54e5ec5`）
- 需求：星空长征模式升级（P1-5，需求 §13）。
- 修改内容（涉本文件）：节点星形化、点亮粒子动画、星图拖动/捏合缩放/双击复位——绘制主体现已在内核（`.qoder/frontend/utils/hudMap.js.md` §4.5–§4.8），手势数学仍在本页 §4.7；diff 未逐行核对，以提交信息为据。
- 测试结果：见 `docs/迭代记录.md` 的 `54e5ec5` 条目。

### 2026-10-02（`a6b59f5`、`6a2fae3`、`05180c2`、`7e587c9`）
- 需求：开场动画（P0-4，§5）；章节系统（P0-3，§4）；行军轨迹进度后端化；页面高级化升级。
- 修改内容（涉本文件）：`a6b59f5` 首次完整开场 + 非首次 500ms 纱幕（现行 `maybePlayIntro/dismissIntro`）；`6a2fae3` 章节卡与章节完成仪式卡队列（`currentChapter`、arrivePopup 接入）；`05180c2` 步数刷新改增量动画推进、进度改读后端 `routeProgress`（判定现已在内核 `setRoute`）；`7e587c9` 到达动画等页面升级（diff 未逐行核对，以提交信息为据）。
- 测试结果：见 `docs/迭代记录.md` 对应条目（`6a2fae3` 条目据提交信息含后端冒烟 10/10、automator 3/3）。

### 2026-10-01（`6a24562`、`b0fd8b2`）
- 需求：服务层由本地 Mock 切换为后端真实接口。
- 修改内容（涉本文件）：页面改异步加载并补错误提示（现行 `refresh()` 链的前身；两提交具体 diff 未逐行核对，以提交信息为据）。
- 测试结果：见 `docs/迭代记录.md` 对应条目。

### 2026-09-30（`b0ba252`、`a94e685`）
- 需求：`a94e685` 仓库初始化创建本页；`b0ba252` 强制已登录用户完成组织选择（该强制流程后被 `01e214a`「取消强制选组织」撤销，见 `.qoder/frontend/services/march.js.md` §10 同日记录）。
- 修改内容（涉本文件）：init 时点形态未逐行核对，以提交信息为据。
- 测试结果：`docs/迭代记录.md` 对应条目。
