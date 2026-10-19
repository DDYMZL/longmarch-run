# march.js（长征路线页 · 页面级合一）

> 按 `.qoder/README.md` §1「页面级合一」规则，本文档覆盖 `frontend/pages/march/` 四件套：`march.js`（654 行）、`march.wxml`（135 行）、`march.wxss`（529 行）、`march.json`（5 行）。WXML / WXSS / JSON 专章见 §4-1–§4-3。**星空长征的绘制状态与绘制逻辑不在本页**，全部在 `utils/hudMap.js` 渲染内核（`.qoder/frontend/utils/hudMap.js.md`），本页只留模式切换、数据拉取、rAF 循环、手势事件转发与命中跳转。

## 1. 文件路径

`frontend/pages/march/march.js`、`march.wxml`、`march.wxss`、`march.json`

## 2. 文件职责

长征 Tab 主页面：展示路线总览（累计步数、点亮进度、当前章节卡），提供**双模式地图**——默认实景 `<map>`（后端下发经纬度 + markers/polyline）与 Canvas 2D「星空长征」插画地图（绘制内核为 `utils/hudMap.js`，实例挂 `this.hud`）；承载开场动画（首次完整开场/非首次纱幕）、抵达事件卡队列播放、完成仪式跳转触发与就地同步行军步数（B6）；下方为可点击的节点列表。数据全部来自 `services/march.js`（后端 `/march/route`、`/march/light-up`）与 `services/sport.js`（`/sport/sync`），页面不直接发请求、不直接读写 Storage（`frontend/AGENTS.md` §3.1）。

## 3. 业务需求

文件头 docstring（`march.js:1-9`）自引：星空绘制收在渲染内核的边界声明（`:5-6`）、星空全景 §13.4 拖动/捏合/双击复位（`:7`）、「任意节点含未解锁可看历史」（`:8`，不变量 8 的落点 `:637-638`、`:647-648` 注释）。绘制侧需求（§13.2 节点三态星形、§13.3 点亮动画、§12 区域氛围、§3.5 轨迹推进）的落点已随 S2 搬迁到 `.qoder/frontend/utils/hudMap.js.md` §3；本页保留的需求为：开场动画 §5（`:72-76` 注释）、章节卡 §4.4（`:266` 注释）、抵达事件卡 §4.5（`:239-243` 注释）、完成仪式 §20（`:207-211` 注释，§20.4 仅第一次）、就地同步 B6（`:177-181` 注释）。双模式地图与 Canvas 清理约定是 `frontend/AGENTS.md` §4 不变量 6 的落点（内核侧见 hudMap 文档 §8）。

## 4. 核心功能

### 4.1 页面入口与生命周期

- **入口**：tabBar 第 2 个 tab「长征」（`frontend/app.json`，`pagePath: pages/march/march`），无其它页面 `navigateTo` 进入本页（tab 页只能 switchTab）。
- **无 `onLoad`/`onReady`**：全部初始化在 `onShow` 完成（`:61-70`）——① 登录守卫：`!app.globalData.loggedIn` 时 `wx.reLaunch('/pages/launch/launch')`（`:62-65`；tab 页同样自守卫，配合 `frontend/AGENTS.md` §4 不变量 5）；② `maybePlayIntro()`（`:66`）；③ 星空动画恢复：`this.hud && this.routeData` 时 `startAnim()`（`:68`，注释说明 onHide 停掉了动画，先用已有路线恢复、刷新失败画面也不冻结）；④ `refresh()`（`:69`，满足不变量 1「onShow + refresh」）。
- **`onHide`（`:119-126`）**：递增 `_refreshRequestId` 作废在途刷新（`:120`）→ 清 4 个定时器（`:121-124`）→ `stopAnim()`（`:125`）。
- **`onUnload`（`:128-136`）**：同 onHide，另清 `_veilTimer`（`:133`）→ `stopAnim()`（`:135`）。

**定时器 / 动画 / 监听器全量盘点（逐一实读）**：

| # | 句柄 | 创建点 | onHide 清理 | onUnload 清理 | 其它清理点 | 说明 |
|---|---|---|---|---|---|---|
| 1 | `_introTimer` | `:81`（切走后重计时）、`:92`（首次，3350ms） | ✅ `:123`（清后置 null） | ✅ `:132` | `dismissIntro` `:103` | 开场动画自动结束 |
| 2 | `_veilTimer` | `:88`（560ms 纱幕） | ❌ **未清**（见 §9 第 1 条） | ✅ `:133` | 无 | 唯一未双清的定时器 |
| 3 | `_viewTimer` | `:458`（700ms 镜头俯冲第二段） | ✅ `:121` | ✅ `:130` | `playViewAnim` 入口先清 `:451` | 实景镜头动画 |
| 4 | `popupTimer` | arrivePopup 模块递归 setTimeout 回写（`.qoder/frontend/utils/arrivePopup.js.md` §4.3） | ✅ `:122` | ✅ `:131` | 模块内每卡播放前先清（同文档 §8.2 契约） | 抵达卡队列 |
| 5 | `_ceremonyTimer` | `:223`（延时 = `_popupMs`） | ✅ `:124`（清后置 null） | ✅ `:134`（清后置 null） | 回调内自清 `:224` | 仪式跳转 |
| 6 | `animId`（rAF 链） | `startAnim` `:536`（`canvas.requestAnimationFrame`）或 `:538`（降级 `setTimeout(loop,16)`） | ✅ `stopAnim()` `:125` | ✅ `stopAnim()` `:135` | `switchMode` `:323`、`startAnim` 自防双链 `:530` | `stopAnim` `:544-551` 双清 + `running=false` 兜底 `:533` |

`arriveFx` / `progressAnim` 两个帧驱动动画态**已不在本页**，随 S2 迁入渲染内核（`.qoder/frontend/utils/hudMap.js.md` §4.2、§4.7）；本页经 `hud.playArrive(ids)` 触发（`:253`）。

事件监听器全部为 WXML 声明式绑定（tap/touch/marker 事件，§4-1），随页面销毁自动释放；**无 `wx.onXxx` 全局事件订阅、无 WebSocket 订阅**（`:10-15` require 清单即全部模块依赖，无 `services/ws.js`）。

### 4.2 数据刷新链 `refresh()`（`:140-170`）

并发竞态守卫：每次调用生成自增 `requestId` 写入 `this._refreshRequestId`（`:141-142`），两个 `.then` 各校验一次，不匹配即丢弃（`:150`、`:160`；`e70b59f` 引入，见 `.qoder/frontend/services/request.js.md` §4.9 末段「页面级并发竞态守卫在各页面自行实现」）。链路：

1. `march.lightUpNodes()`（`:147` → `POST /api/march/light-up`，`.qoder/frontend/services/march.js.md` §4.3）——幂等点亮达标节点，失败兜底为空数组（`:148`）；结果暂存 `this._pendingLit` / `this._pendingChapters`（`:151-152`）；有新点亮/新完成章节时置 `app.globalData.homeDirty = true` 让首页强制刷新（`:154-156`）。
2. `march.getRoute()`（`:157` → `GET /api/march/route`）；响应带 `_fromCache` 时 toast 提示「网络异常，当前为最近缓存数据」（`:162`，last-good 缓存兜底口径）。
3. `renderRoute(route)` → `playArriveIfNeeded()` → `maybeStartCeremony(route)`（`:163-165`）。
4. 整链 `.catch` 静默：网络失败保留上一次渲染（`:167-169` 注释）；light-up 单独失败也兜底为空点亮结果继续拉路线（`:148`），即「点亮失败不阻塞路线展示」。

`refresh()` **返回 Promise**（`:146`），供下拉刷新 `onPullDownRefresh`（`:173-175`，完成后 `wx.stopPullDownRefresh`）与 `handleSyncSteps` 复用。

**就地同步行军步数（B6）`handleSyncSteps()`（`:182-205`）**：`data.syncing` 锁防重复触发（`:183-184`、`:203`）；`sport.syncToday()` 内部处理微信运动授权（拒绝走 authGuide 引导，`.qoder/frontend/services/sport.js.md`）；成功后置 `homeDirty` 并按 `synced/historyDetailsAvailable/failedDates` 三档 toast（`:189-196`），再 `refresh()` 走完整点亮+重绘链（`:197`）；失败 toast 错误信息（`:200`）。入口为头部「同步行程」按钮（`march.wxml`，§4-1）。

### 4.3 开场动画（§5，`:77-117`）

- `maybePlayIntro()`（`:77-93`）：模块实例标记 `_introChecked` 保证只判定一次；已判定过且开场仍在播（onHide 清掉定时器后回来）时重新计时 3350ms 自动结束（`:80-82`）。首次判定走 `march.hasPlayedIntro()`（`:86`，Storage 键 `lm_march_intro_played` 收归服务层，`.qoder/frontend/services/march.js.md` §4.6）：已播过 → `showVeil` 纱幕 + `_veilTimer` 560ms 后关闭（`:87-88`）；未播过 → `showIntro` + `_introTimer` 3350ms（`:91-92`）。
- `skipIntro()`（`:96-98`）→ `dismissIntro()`（`:101-117`）：清 `_introTimer`、`setData({showIntro:false})`、`march.markIntroPlayed()` 写标记（`:105`）；补播被开场压后的实景镜头动画 `playViewAnim`（`:106-109`）、抵达卡队列 `playArriveIfNeeded`（`:110`）、顺延的完成仪式 `_ceremonyRoute`（`:112-116`）。
- 3350ms 与 wxss `introFadeOut 0.45s ease 2.85s`（`march.wxss:453`）配合：2.85s 起淡出、3.3s 结束，留 50ms 余量。

### 4.4 路线渲染 `renderRoute(route)`（`:263-312`）

网络刷新与本地渲染共用同一入口（`:258-262` 注释），按 `data.mode` 分流：

- **公共段（`:264-281`）**：`this.routeData = route`（`:264`，实景分支与命中/列表消费它；星空绘制读的是内核 `hud.route`）→ 章节卡（§4.4 需求）：按 `route.currentChapterId` 匹配当前章，`finished` 且有章节时展示末章（`:267-270`）；`progressPct = Math.round(progress*100)` 预计算供 WXML 进度条（`:279`，遵守 `frontend/AGENTS.md` §5.2「WXML 不做原生调用」）→ `setData` 负载：`nodes` 经 `toViewNode` 裁剪为 6 字段（`:18-27`，注释「减小 setData 体积」）+ 5 个进度标量 + `currentChapter`（`:271-281`）。
- **real 分支（`:283-305`）**：`buildMapData` 产出 markers/polylines（§4.5）；`selectedNode` 默认选中 current 节点，无 current 取首个非 completed，再兜底第一个（`:285-289`）；配 `nodeThemes` 生成信息卡主题样式与环境描述（`:290`、`:295-296`）；首次进入且不在开场中时播 `playViewAnim` 镜头俯冲（`_viewPlayed` 防重播，`:300-303`）。
- **canvas 分支（`:307-311`）**：`setData(patch)` 后若 `this.hud` 已存在（即已切过星空模式）则 `this.hud.setRoute(route)` + `startAnim()`——**入场描画 vs 增量推进的判定在内核 `setRoute` 内部**（按是否已有采样路径区分，`.qoder/frontend/utils/hudMap.js.md` §4.2），本页不再持有 `prevProgress`/`nodeIndex`/`progressAnim`。
- **进度换算已迁出**：`calcRouteProgress`/`currentRatio` 现为内核方法（`hud.calcRouteProgress`/`hud.currentRatio`），automator 经 `page.hud` 断言（`frontend/test/automator/p0-march.cjs` P0M-02~04）。

### 4.5 实景地图模式（`:344-499`）

`buildMapData(route)`（`:344-445`）产出 `<map>` 组件数据，坐标取后端下发的 `node.latitude/longitude`（`:346-349`，**无前端硬编码坐标表**，见 §8.7）：

- **已完成轨迹 `donePts`**（`:353-371`）：逐节点累计（`cur >= targets[i]` 即收入），当前目标段内按步数比例线性插值出旗帜位置。
- **节点 markers**（`:379-397`）：每节点 16×16 默认图标 + `callout` 点击气泡（`display:'BYCLICK'`，completed ★金 / current ◎红 / unlocked ○灰三套配色 `:374-378`）；注释说明用点击气泡替代常驻 label，避免密集点位名称错位/重叠（`:373`）。
- **进度旗帜 marker**（`:400-419`）：未完成且有已行进段时追加 `id: 999` 的「🚩 我在这里」label marker。
- **polylines**（`:422-442`）：两条——灰色全程底 `#B9B2A4CC` width 5 + 金色已完成段 `#D4A017` width 7 带描边与箭头（`arrowLine: true`）。

其余函数：

- `playViewAnim()`（`:450-464`）：镜头俯冲两段式——先重置全国视野（lat 34.5 / lng 108.5 / scale 4，`:452-457`），`_viewTimer` 700ms 后 `setData includePoints` 收缩到全部节点包络（`:458-463`）。
- `handleMarkerTap`（`:470-481`）：点 marker 只选中节点并刷信息卡主题（不跳转，`:466-469` 注释），`nodeThemes.getNodeTheme/themeSoftStyle` 生成柔和主题样式与环境描述（`:475-480`）。
- `handleCalloutTap`（`:486-490`）：点气泡直达 `node-detail?id=`。
- `goSelectedDetail`（`:495-499`）：信息卡「查看详情」按钮。
- 三个事件对 id=999 旗帜均忽略（`:472`、`:488`），且**不校验节点状态**——未解锁节点同样可选中/进详情（不变量 8）。

### 4.6 Canvas 星空模式：页面侧只剩建内核与 rAF

- **Canvas 类型（实测）**：WXML `<canvas type="2d" id="routeMap">`（`march.wxml:83-91`）；`initCanvas()`（`:503-524`）用 `wx.createSelectorQuery().select('#routeMap').fields({node:true,size:true})` 取节点后 `node.getContext('2d')`（`:504-516`），即 **Canvas 2D 新接口**，非旧版 `wx.createCanvasContext`（与 `.qoder/frontend/utils/routeCanvas.js.md` §4 的核实结论一致）。dpr 取 `wx.getSystemInfoSync().pixelRatio || 2`（`:511`），画布物理尺寸 = CSS 尺寸 × dpr 并 `ctx.scale(dpr,dpr)`（`:513-517`）。
- **建内核**：`this.canvas = node` 后 `this.hud = hudMap.createHudMap({ ctx, cw: width, ch: height, dpr })`（`:519-520`），已有路线则 `hud.setRoute(this.routeData)`（`:521`，首次建内核 ⇒ 内核内 `path` 为空 ⇒ 全量重建+入场描画），再 `startAnim()`（`:522`）。
- **`initCanvas` 的唯一调用点是 `switchMode`**（`:326`）：默认 real 模式不进 Canvas。`switchMode`（`:319-339`）先 `stopAnim()`（`:323`）；切到 canvas 走 `initCanvas`；切回 real 时在 setData 回调里 `hud.dispose()` + `hud = null` + `canvas = null`（`:331-335`）——**释放画布上下文、离屏静态层与光晕精灵**（`<canvas>` 节点已被 `wx:else` 移除），随后用最新路线 `renderRoute` 重建实景 markers（`:336`）并播镜头动画（`:337`）。
- **rAF 循环留在页面**：`startAnim()`（`:529-542`）先 `stopAnim()` 防双链；循环体每帧 `this.hud.draw(Date.now()/1000)`（`:534`），续帧优先 `canvas.requestAnimationFrame`（Canvas 2D 节点级 rAF，`:535-536`），不可用时降级 `setTimeout(loop,16)`（`:538`）。`stopAnim()`（`:544-551`）置 `running=false`、`cancelAnimationFrame` + `clearTimeout` 双清、句柄置 undefined。**只在星空模式且页面前台时运转**：onHide/onUnload/switchMode/startAnim 四处都调 stopAnim（`:125`、`:135`、`:323`、`:530`）。
- **绘制管线全在内核**：静态 scenery 离屏烘焙、星空三层、区域粒子、金轨+彗尾、三态节点、进度旗、点亮动画、观景钳制与命中逆变换——逐函数见 `.qoder/frontend/utils/hudMap.js.md` §4.5–§4.8。重绘时机：星空模式+页面前台由 rAF 持续逐帧；数据变化不直接触发重绘（`renderRoute` 只写 `routeData`/调 `hud.setRoute`，由下一帧 `draw` 自然读取）；real 模式无 Canvas 绘制。画布尺寸固定 750×860rpx（`march.wxss:126-130`），无 resize/scroll 监听。

### 4.7 星空全景手势（§13.4，`:558-644`）

pan/pinch 手势数学属事件层、留在本页；**观景变换 `view` 由内核持有**，改写后必须调 `hud.clampView()`（`:553-556` 区块注释）：

- `onMapTouchStart`（`:558-577`）：单指建 pan 手势（记起点/当前偏移/时间，偏移初值读 `hud.view.ox/oy`），双指建 pinch（记初始指距/`hud.view.scale`/中心锚点）；`!this.hud` 直接返回。
- `onMapTouchMove`（`:579-615`）：pan 位移超 6px 判 moved 后写 `v.ox/v.oy` + `hud.clampView()`（`:588-593`）；pinch 以双指中心为锚点缩放（保持锚点场景坐标不动，`:605-612`）+ `hud.clampView()`（`:613`）；单指转双指时重新锚定基准避免跳变（`:596-604`）。
- `onMapTouchEnd`（`:617-634`）：干净单指轻点（未移动且 <350ms）→ 300ms 内二连击 `hud.resetView()`（`:626-629`），否则 `hitNode`（`:632`）。
- `hitNode`（`:640-644`）：委托 `hud.hitTest(sx, sy)`（屏幕→场景逆变换与命中半径 22/scale 在内核），命中即 `navigateTo node-detail?id=`——含未解锁节点（`:636-639` 注释，不变量 8）。

### 4.8 节点点亮动画链与完成仪式

**点亮链（步数同步 → light-up → 弹窗 → 重绘）**：首页或本页 `handleSyncSteps` 同步步数落库（`.qoder/frontend/services/sport.js.md`）→ 本页 onShow/下拉/同步后 `refresh()` 调 `POST /march/light-up`（后端幂等判定与 `newlyLit/newlyCompletedChapters/newMedals` 三段返回见 `.qoder/backend/app/api/routes/march.py.md` §4.3）→ `playArriveIfNeeded()`（`:244-256`）：开场期间暂缓由 `dismissIntro` 补播（`:246`）；消费并清空 `_pendingLit/_pendingChapters`（`:247-250`）；有内核时 `this.hud.playArrive(lit.map(n => n.id))` 触发星空点亮动画（`:253`）；`this._popupMs = arrivePopup.playArriveQueue(this, lit, chapters)`（`:255`，队列播放器写 `data.litPopup` 与 `page.popupTimer`，返回总时长，`.qoder/frontend/utils/arrivePopup.js.md` §4.3）。粒子预生成与四阶段绘制在内核（`.qoder/frontend/utils/hudMap.js.md` §4.7）。

- **完成仪式（§20）`maybeStartCeremony(route)`（`:212-228`）**，逐步：
  1. 触发条件：后端 `GET /march/route` 下发 `ceremonyPending=true`（全部点亮且未观看时才有，`.qoder/backend/app/api/routes/march.py.md` §4.4），否则直接 return（`:213`）。
  2. 开场播放中 → 存入 `_ceremonyRoute` 顺延，由 `dismissIntro` 再触发（`:214-217`、`:112-116`）。
  3. `_ceremonyStarted` 或 `_ceremonyTimer` 已存在则不重复安排（`:220`）；定时器被 onHide 取消（切 tab）时允许下次 onShow 经 refresh 重新安排（`:218-219` 注释）。
  4. 延时 = 抵达卡队列总时长 `_popupMs`（消费后置 0，`:221-222`），保证 §20.2「事件卡队列播完再进仪式」。
  5. 到点置 `_ceremonyStarted=true` 并 `wx.navigateTo('/pages/ceremony/ceremony')`（`:223-227`）——**本页生命周期内只自动触发一次**（`:210` 注释，用户中途返回不循环跳转；tab 页常驻不 unload，故返回后不再自动跳）。
  6. 已观看标记由仪式页调 `markCeremony` 向后端落库（`.qoder/frontend/services/march.js.md` §4.5），本页只消费 `ceremonyPending` 不写入。
- `goCeremony()`（`:233-236`）：`finished` 时头部横幅（`march.wxml:38`）手动进仪式页复看（§20.4）。

## 4-1. WXML 专章（`march.wxml`，135 行）

| 区块 | 行号 | 内容与绑定 |
|---|---|---|
| 开场动画覆盖层 | `:3-11` | `wx:if="{{showIntro}}"`，四行文案（1934 / 🚩 瑞金·1934年10月 / 长征开始 / 你的长征旅程 正式开始，`:5-8`），整层 `bindtap="skipIntro"` 点击任意处跳过（`:3`），右下角跳过提示（`:10`） |
| 过渡纱幕 | `:14` | `wx:if="{{showVeil}}"`，纯视觉层（wxss 侧 `pointer-events:none` 不拦截操作） |
| 抵达事件卡弹层 | `:17-32` | `wx:if="{{litPopup}}"`；`kind==='chapter'` 渲染章节卡（🚩 + title + intro，`:18-23`），否则节点卡（★ +「恭喜抵达」+ icon/name + historicalTime + nextName/nextRemain，无下一站时显示「🏆 长征路线已全部完成！」，`:24-31`）——字段与 `arrivePopup.buildQueue` 卡片结构一一对应（`.qoder/frontend/utils/arrivePopup.js.md` §8.1 硬契约） |
| 路线总览头部 | `:35-39` | 标题 +「累计 x/y 步 · 已点亮 n/m」；`finished` 时完成横幅 `bindtap="goCeremony"`（`:38`） |
| 当前章节卡 | `:42-50` | `wx:if="{{currentChapter}}"`；title、litCount/totalCount、进度条 `style="width: {{currentChapter.progressPct}}%"`（`:48`，js 侧预计算） |
| 模式切换 | `:53-64` | 双按钮 `data-mode="real"/"canvas"` + `bindtap="switchMode"`，active 类按 `mode` 三元切换 |
| 地图区 | `:67-108` | 见下述要点 |
| 节点列表 | `:111-134` | `wx:for="{{nodes}}"` + `wx:key="id"`；每项 `data-id` + `bindtap="handleNodeTap"`；图标/名称/徽章按 `item.status` 三态；current 项额外显示「当前进度 x/y 步 · 还需 n 步」（`:129-131`） |

地图区要点：

1. `<map>` 折线属性写作 **`polyline="{{polylines}}"`**（`:77`，`frontend/AGENTS.md` §5.2 特别提示的属性名）；`include-points`/`markers` 绑定同名字段（`:75-76`）；`bindmarkertap`/`bindcallouttap`（`:80-81`）；`enable-scroll`/`enable-zoom` 开启（`:78-79`）。
2. `<canvas type="2d" id="routeMap">` 与 `<map>` 用 `wx:if="{{mode === 'real'}}"` / `wx:else` 互斥（`:69`、`:84`）——切回实景时 canvas 节点被移除，这正是 `switchMode` 必须 `hud.dispose()` 释放画布资源的原因（`march.js:329-335` 注释）；三个 touch 事件绑定全景手势（`:88-90`）。
3. `map-hint` 提示条按模式切换文案（`:92`，实景「点击地图节点查看信息…」/星空「拖动/双指缩放…双击复位」）。**注意**：`<canvas type="2d">` 在开发者工具中是不透明原生层、位于所有 DOM 之上且 `visibility` 无效，星空模式下该提示条实际被画布盖住（S3 计划把提示文案画进画布内）。
4. 选中节点信息卡仅 real 模式且有选中时渲染（`:95-107`）：`style="{{selectedThemeStyle}}"` 区域氛围主题（§12）、图标/徽章三态、current 态显示步数进度、`selectedThemeEnv` 环境描述、「查看详情」按钮 `bindtap="goSelectedDetail"`（`:106`）。
5. 列表项交错入场 `style="animation-delay: {{index * 70}}ms"`（`:116`，乘法表达式合法）；状态文案全部用三元表达式内联（`:96`、`:100`、`:121`、`:126`），**全文件无原生方法调用**，符合 §5.2。

## 4-2. WXSS 专章（`march.wxss`，529 行）

全部 rpx 单位；头部渐变 `#A00D26 → #C8102E`（`:6-10`）与导航栏主色一致（`frontend/AGENTS.md` §2 约定色）。区块一览：

| 区块 | 行号 | 要点 |
|---|---|---|
| 页面容器 | `:1-3` | 底部留白 60rpx |
| 头部总览 | `:5-34` | 标题/副标题 fadeUp 交错入场（`:16`、`:23`）；`finish-banner` 完成横幅半透明白底 popIn（`:26-34`） |
| 章节卡 | `:36-86` | 负 margin 叠在头部下缘（`:38`）；进度条金色渐变 + `transition: width 0.6s`（`:72-77`）；章节仪式卡 intro 文案样式（`:79-86`） |
| 模式切换 | `:88-114` | 胶囊双按钮（左圆角 `:101`、相邻右圆角 `:106-108`）；active 态长征红渐变+红投影（`:110-114`） |
| 地图容器 | `:116-157` | `map-wrap` 圆角裁切 + cardIn 入场（`:117-124`），`position:relative` 供内部绝对定位（`:155-157`）；`route-map`/`route-map-real` 均固定 **750×860rpx**（`:126-137`）；`map-hint` 底部居中悬浮提示条，`pointer-events:none` 不挡手势（`:139-153`） |
| 选中节点信息卡 | `:159-255` | 绝对定位浮于地图下部（`bottom: 92rpx` 避开提示条，`:160-171`）；圆形图标与徽章按 completed（金渐变）/current（红描边）/默认灰三态（`:173-230`）；区域氛围说明行（§12，`:238-244`）；描边按钮（`:246-255`） |
| 节点列表 | `:257-371` | 卡片项 `:active` 缩放 0.97 反馈（`:273-275`）；`anim-card` 交错入场（`:277-281`，延迟由 WXML 内联）；图标 current 态 pulseRed 脉冲 / completed 态 pulseGlow 呼吸（`:300-311`）；名称/徽章/目标/还需步数按状态配色（`:329-371`） |
| 抵达卡弹层 | `:373-438` | fixed 全屏遮罩 z-index 999 + litFadeIn（`:374-391`）；卡片米金渐变、popIn 弹性曲线 `cubic-bezier(0.34,1.56,0.64,1)`（`:393-402`）；大星 spinIn（`:404-410`） |
| 开场动画 | `:440-529` | 覆盖层红渐变、z-index 999、整层 2.85s 起 0.45s 淡出（`:441-454`）；四行文案依次 0.15s/0.85s/1.55s/2.25s 延迟入场（`:462-498`，年份 128rpx 金字 `:469-475`）；跳过按钮右下角半透明（`:500-507`）；纱幕 z-index 998 + `pointer-events:none` 不拦截操作（`:513-524`） |

keyframes 归属：本文件自定义 `pulseRed`（`:313-316`）、`litFadeIn`（`:388-391`）、`introFadeOut`（`:509-511`）、`veilOut`（`:526-529`）；引用的 `fadeUp/popIn/spinIn/cardIn/pulseGlow` 定义在全局 `frontend/app.wxss`（实测 `app.wxss:169-242` 存在同名 keyframes）。注意 `pulseRed` 在 `app.wxss:242` 也有定义，页面样式后加载生效（页面内以本文件 `:313-316` 为准）。

## 4-3. JSON 专章（`march.json`，5 行）

仅 3 项页面配置：`navigationBarTitleText: "长征路线"`、`navigationBarBackgroundColor: "#C8102E"`、`navigationBarTextStyle: "white"`（`march.json:2-4`）。无 `usingComponents`（页面不用自定义组件）、无 `disableScroll`；`enablePullDownRefresh` 由页面 `onPullDownRefresh`（`march.js:173-175`）配合——**注意 json 仅 3 项配置，下拉刷新实际依赖全局或后续配置，实读 json 未见 `enablePullDownRefresh` 键，若下拉不生效先查此处**。页面注册与 tabBar 配置在 `frontend/app.json`，符合 `frontend/AGENTS.md` §5.3「page.json 只声明页面自己的配置」。

## 5. 输入与输出

**`data` 状态字段（按关注点分组，`:30-59`）**：

| 分组 | 字段 | 说明 |
|---|---|---|
| 路线/进度 | `nodes`、`currentSteps`、`totalSteps`、`litCount`、`totalCount`、`finished`、`currentChapter` | 由 `renderRoute` 的 patch 一次性 setData（`:271-281`）；`nodes` 为 `toViewNode` 裁剪后的 6 字段视图对象 |
| 实景地图 | `mode`（'real'/'canvas'）、`mapLat`/`mapLng`/`mapScale`（初始 34.5/108.5/4）、`includePoints`、`markers`、`polylines`、`selectedNode`、`selectedThemeStyle`、`selectedThemeEnv` | 仅 real 模式消费；`selectedTheme*` 为 §12 区域氛围内联样式/文案 |
| 动画/弹层 | `showIntro`、`showVeil`、`litPopup` | 开场/纱幕/抵达卡；`litPopup` 由 arrivePopup 模块经 `setData` 写入 |
| 就地同步 | `syncing` | B6 同步锁（`:57-58`、`:183-184`、`:203`） |

**实例属性（非 data、不走 setData，均挂 Page 实例）**：

| 分组 | 属性 | 写入点 |
|---|---|---|
| 路线快照 | `routeData` | `renderRoute` `:264`（实景分支与列表消费；星空绘制读内核 `hud.route`） |
| Canvas 基础 | `canvas`、`hud`（渲染内核实例） | `initCanvas` `:519-520`；`switchMode` 切回 real 时 `hud.dispose()` 后置 null `:331-335` |
| 手势 | `_gesture`、`_lastTap` | `:563/:598`、`:626-631` |
| 动画态 | `animId`、`running` | §4.1 盘点表 #6（rAF 链在页面；`arriveFx`/`progressAnim` 在内核） |
| 流程态 | `_refreshRequestId`、`_pendingLit`、`_pendingChapters`、`_popupMs`、`_introChecked`、`_viewPlayed`、`_ceremonyStarted`、`_ceremonyRoute` | §4.2、§4.3、§4.8 |

**绘制状态全部在内核实例上**（`view`/`nodePts`/`path`/`farStars`/`stars`/`trailDust`/`regionMotes`/`staticLayer`/`glowGold`/`glowRed`/`_goldGrad`/`_flagGrad`/`_labelW`/`animStart`/`progressAnim`/`arriveFx`），清单见 `.qoder/frontend/utils/hudMap.js.md` §4.1；automator 白盒断言读 `page.hud.*`。

**页面跳转出口**：`node-detail?id=`（4 处：`:489`、`:498`、`:643`、`:652`）、`ceremony`（`:226`、`:235`）、`launch`（未登录 reLaunch，`:63`）。

**事件处理一览（WXML 绑定 → js）**：`skipIntro`、`goCeremony`、`switchMode`、`handleMarkerTap`、`handleCalloutTap`、`goSelectedDetail`、`onMapTouchStart/Move/End`、`handleNodeTap`、`handleSyncSteps`。

## 6. 依赖关系

- **require（`:11-15`，全部 5 个）**：`services/march.js`（`lightUpNodes/getRoute/hasPlayedIntro/markIntroPlayed` 四个函数被调用：`:86`、`:105`、`:147`、`:157`；该服务 8 个导出中本页用 4 个，`.qoder/frontend/services/march.js.md` §4）、`services/sport.js`（`syncToday`，`:186`，B6 就地同步）、`utils/arrivePopup.js`（`playArriveQueue`，`:255`）、`utils/hudMap.js`（`createHudMap`，`:520`；S2 起替代本页原先对 `utils/routeCanvas.js` 的直接依赖——**本页已不再 require routeCanvas**，共享画布纯函数改由内核消费）、`data/node-themes.js`（`getNodeTheme/themeSoftStyle`，`:290-296`、`:475-480`）。
- **wx API**：`createSelectorQuery`、`getSystemInfoSync`（`:511`）、`reLaunch/navigateTo/setData/setTimeout/showToast`（`:162`、`:191-200`）。
- **后端路径（经服务层）**：`GET /api/march/route`、`POST /api/march/light-up`（`.qoder/backend/app/api/routes/march.py.md` §4.1）、`POST /api/sport/sync`（经 `sport.syncToday`）。
- **不依赖**：`services/ws.js`（**本页无 WebSocket 订阅**，`:11-15` 的 require 清单即全部依赖）。
- **被依赖**：`frontend/app.json` tabBar 注册；无其它页面 require 本页。

## 7. 业务规则

1. **onShow + refresh**（不变量 1）：每次显隐都重走 light-up → route 链；`_refreshRequestId` 保证旧响应不覆盖新响应（`:141-160`）。下拉刷新与就地同步复用同一 `refresh()`（`:174`、`:197`）。
2. **登录守卫**：onShow 检查 `app.globalData.loggedIn`，未登录 reLaunch 启动页（`:62-65`）。
3. **任意节点可看历史**（不变量 8）：列表点击、Canvas 命中（内核 `hitTest`）、marker 点选、气泡直达四条入口均不拦截未解锁节点。
4. **轨迹推进分级**（§3.5）：首次渲染播 1400ms 完整入场描画 + 实景镜头俯冲各一次（`_viewPlayed` 防重播，`:106-109`、`:300-303`）；此后步数刷新只做 800ms 增量推进——**判定在内核 `setRoute`**（`.qoder/frontend/utils/hudMap.js.md` §4.2），本页不得自行重播。
5. **点亮动画只由 light-up 响应驱动**：已点亮节点点击仅看详情、不重播动画（`:242` 注释）；触发经 `hud.playArrive`（`:253`）。
6. **两个「仅首次」标记存储位置不同**：开场动画标记在本地 Storage（换设备重播）；完成仪式 `ceremonyPending` 由后端持久化判定（换设备不重播），本页只消费不写入（`.qoder/frontend/services/march.js.md` §7.4）。
7. **仪式跳转排队规则**（§20.2）：开场动画 > 抵达卡队列 > 仪式跳转，依次顺延（`:214-217`、`:221-222`）；页面生命周期内自动触发仅一次（`:220`、`:225`）。
8. **跨页脏标记**：light-up 有新点亮/新完成章节、或就地同步成功时置 `app.globalData.homeDirty = true`（`:155`、`:189`），首页 onShow 据此绕过 30s 节流强制刷新。
9. **性能预算**（§13.4 + 根 `agents.md` §2.4）：星空元素构建期一次性分配、点亮粒子限量、静态层离屏烘焙、渐变与标签宽度缓存均在**内核**（`.qoder/frontend/utils/hudMap.js.md` §7）；本页侧为 setData 负载经 `toViewNode` 裁剪（`:18-27`）。
10. **V2.0 积分口径**：点亮不发放积分、抵达卡不含积分字段（`.qoder/frontend/services/march.js.md` §7.2）。

## 8. 修改约束

1. **不变量 6 的落点已拆分**（`frontend/AGENTS.md` §4）：绘制侧（每帧读 `hud.route`、静态元素只烘焙一次、`_goldGrad/_flagGrad` 与光晕精灵画布重建时重置、离屏 try/catch 禁删）在 `utils/hudMap.js`（`.qoder/frontend/utils/hudMap.js.md` §8）；**本页侧**约束为：切回实景必须 `hud.dispose()` 并置 null（`:331-335`）、改写 `hud.view` 后必须 `hud.clampView()`（`:592`、`:613`）、rAF 循环的 onHide/onUnload 清理不得移除（`:125`、`:135`）。
2. `popupTimer` / `data.litPopup` 属性名是与 arrivePopup 模块的清理契约（`.qoder/frontend/utils/arrivePopup.js.md` §8.2），onHide/onUnload 按此名 clearTimeout（`:122`、`:131`）。
3. `routeCanvas` 返回结构 `{path,dist,len,nodePathIndex}` 与 `node-themes` 的 `particleConfig.type` 枚举是跨文件硬契约，消费方现为**内核**（`.qoder/frontend/utils/hudMap.js.md` §8.2/§8.5）；本页不再直接解构，改这些字段不触及本页。
4. light-up/route 响应字段（`newlyLit/newlyCompletedChapters/routeProgress/chapters/currentChapterId/ceremonyPending/finished/_fromCache`）是后端 camelCase 契约（`.qoder/backend/app/api/routes/march.py.md` §8.2），增删须双端同步。
5. `<map>` 的 `polyline` 属性名、`wx:key="id"`、WXML 禁原生方法调用等遵守 `frontend/AGENTS.md` §5.2。
6. 新增定时器/动画必须同时挂入 onHide 与 onUnload 清理（本页既有 5 个定时器 + 1 个 rAF 链全部双清，`_veilTimer` 例外见 §9 第 1 条，勿再扩大例外）。
7. **automator 断言口径**：四个套件（`p0-march`/`p1-starry-march`/`tabbar-starmap`/`s16-review-smoke`）自 S2 起读 `page.hud.*` 且不留兼容别名；给内核加兼容转发或把绘制状态搬回页面会静默破坏断言。
8. `frontend/AGENTS.md` §4 不变量 6 提到的「真实经纬度 `NODE_COORDS`」静态坐标表**在现行代码中不存在**（全 `frontend/` grep 零命中；坐标由 `/march/route` 下发，`march.js:346-349`）——该不变量措辞滞后，按代码事实理解，勿据此恢复硬编码坐标。

## 9. 当前实现状态

- **已实现**：双模式地图、开场动画、章节卡、抵达卡队列、星空点亮动画与全景手势（绘制在内核）、完成仪式触发、增量轨迹推进、并发刷新守卫、下拉刷新与就地同步行军步数（B6）；提交演进见 §10。
- **存在问题 / 已知事项（逐条实读取证）**：
  1. **`_veilTimer` 未在 `onHide` 清理**：onHide 清了 `_viewTimer/popupTimer/_introTimer/_ceremonyTimer`（`:121-124`）但没有 `_veilTimer`，仅 `onUnload` 清（`:133`）。纱幕 560ms 内切走 tab 时定时器仍会触发一次 `setData({showVeil:false})`（`:88`）——影响极小（单次、幂等），但与本页「定时器双清」惯例不对称，属轻微泄漏点。
  2. **`stopAnim` 混用两种句柄空间**：`:546-549` 对同一 `animId` 先 `canvas.cancelAnimationFrame` 再 `clearTimeout`——rAF 句柄传给 clearTimeout（或反之）是无效操作但无害；现状能正确停链（`running=false` 兜底 `:533`），非缺陷，记录为事实。
  3. **无 `onLoad`**：全部逻辑挂 onShow，首次进入即触发一次完整 light-up + route 请求；属设计选择（tab 页复用），非缺陷。
  4. `wx.getSystemInfoSync()`（`:511`）为微信已标记废弃的同步接口——现状可用，未迁移 `wx.getWindowInfo` 等新接口，是否迁移**待确认**。
  5. **WebSocket**：本页不订阅任何 WS 消息（§6），故生产环境 wss 不可用的阻塞问题（已登记为 `.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1 项与第 2 项）**不影响本页**；路线渲染与完成仪式链路全部走 REST。（S4 计划在本页订阅 WS 做实时叠加，届时本条失效。）
  6. 抵达卡弹层无点击关闭绑定（`march.wxml:17-32` 遮罩层无 bindtap），只能等队列自动播完——现状行为，是否符合预期**待确认**。
  7. **`map-hint` 在星空模式被画布盖住**：`<canvas type="2d">` 是开发者工具中的不透明原生层、位于 DOM 之上且 `visibility` 无效，`march.wxml:92` 的提示条星空模式下不可见——S3 计划把提示文案画进画布内解决。
  8. **`march.json` 未见 `enablePullDownRefresh`**（§4-3）：`onPullDownRefresh` 已实现（`:173-175`）但页面配置仅 3 项，下拉刷新是否真能触发**待实测确认**。
- **待开发**：S3 深空 HUD 视觉重构（L0~L6，含 `map-hint` 入画布）、S4 实时数据叠加层 + WS 飞线、S5 帧率自适应降级（方案已排期，尚未实现——勿当作既有功能引用）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/march/march.js` + `git log --oneline -- frontend/pages/march/`；提交号在 `docs/迭代记录.md` 均有对应条目。按时间倒序、按主题归并；未逐行核对 diff 的条目以提交信息为据并注明。

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
