# hudMap.js（星空长征渲染内核）

## 1. 文件路径

`frontend/utils/hudMap.js`（1519 行，工厂模块，唯一导出 `createHudMap`）

## 2. 文件职责

星空长征（Canvas 2D 插画地图）模式的**全部绘制状态与绘制逻辑**。`createHudMap({ ctx, cw, ch, dpr })` 返回内核实例，页面 `pages/march/march.js` 在 `initCanvas` 中创建并挂为 `page.hud`（`march.js:585`）。页面只保留：模式切换、数据拉取、rAF 循环、pan/pinch 手势数学（事件层）与命中后跳转；**本模块不 require 任何 service、不读写 Storage、不调 `getApp()`、不发请求、不 `setData`**——纯画布内核，可被 automator 经 `getCurrentPages().pop().hud` 白盒断言。S4 的实时数据同样遵守该边界：页面把 `/broadcast/today` 与 `/march/route-stats` 两个接口响应合并成归一化入参后经 `setStats` 注入（`march.js:175-197`），内核不认接口形状。S5 的帧率自适应降级同样全在内核：采样源就是页面 rAF 传入的 `t`（`march.js:601`），**页面 `march.js` 零改动**。

与页面的分工契约（两处注释互引：本文件头 JSDoc `:1-29`、`march.js:5-10` 与 `:621-623`）：

- **rAF 循环在页面**（`march.js:596-609`）：`onHide`/`onUnload`/`switchMode` 的生命周期归属不变，页面每帧只调 `hud.draw(t)`（`march.js:601`）。
- **观景变换 `view` 在内核**：页面手势直接改写 `hud.view.ox/oy/scale`，改完**必须**调 `hud.clampView()`（`march.js:659`、`:680`）；复位调 `hud.resetView()`（`march.js:695`）。
- **命中在内核**：`hud.hitTest(sx, sy)` 内部做屏幕→场景逆变换，返回节点 id 或 null（`march.js:709`）。
- **释放**：切回实景时页面调 `hud.dispose()` 并置 `hud = null`（`march.js:396-399`）。

## 3. 业务需求

文件头 docstring（`:1-29`）声明九层视觉分层、配色铁律与每帧绘制预算；绘制实现对应需求 §13.2（节点三态星形：金发光星/红呼吸星+脉冲环/暗星点）、§13.3（点亮动画四阶段：亮起→扩大→粒子扩散→稳定发光）、§13.4（星空全景低开销 rAF：构建期一次性分配、帧内零分配）、§3.5（轨迹推进：仅首次播 1400ms 入场描画，步数刷新做 800ms 增量推进）、§12（区域氛围粒子，经 `data/node-themes.js` 的 `particleConfig`）；L7/L8 两层不对应原需求文档，是 2026-10-19「科技感长征路线地图」技术方案 S4 的排期项（全员实时数据上屏 + 他人点亮事件的飞线反馈）；帧率自适应降级是同方案 S5 的排期项（低端机兜底：帧率不足时关掉纯氛围层，见 §4.5/§7 规则 9）。

本文件诞生于 2026-10-19 `2862453`（深空 HUD 科技感地图五阶段方案的 **S2**）：把原 `march.js` 约 850 行绘制逻辑**纯搬迁**至此（函数体逐行移动，仅 `this.routeData`→`this.route`、`this.dpr || 2`→`this.dpr` 等引用改名，魔数收敛为命名常量），视觉与行为零变更；搬迁前各绘制的演进史见 `.qoder/frontend/pages/march/march.js.md` §10。拆分动机：S3 的深空 HUD 视觉重做要在「行为不变的搬迁」基线上进行，重构与视觉叠加时出问题无法定位。**S3 视觉重做已于 2026-10-19 在此基线上完成**（L0~L6 深空 HUD，见 §4.5/§4.6 与 §10 第二条）：几何、星数、观景变换与命中口径全部未动，仅重做绘制体的视觉与仪器层。**S4 实时数据叠加层亦于同日完成**（L7 全员数据面板/仪表环/图例 + L8 WS 飞线，见 §4.8 与 §10 第三条）：只新增绘制层与两个注入入口，几何/星数/观景变换/命中口径依旧未动。**S5 帧率自适应降级于 2026-10-21 完成**（见 §4.5/§4.7 与 §10 第四条）：只新增采样器与两处绘制守卫，几何/星数/观景变换/命中口径与 L0~L8 分层依旧未动。

## 4. 核心功能

### 4.1 工厂与状态字段（`:103-163`）

`createHudMap(opts)` 返回对象字面量（与代码库 `Page({})` 风格一致，不用 class）。字段分组：

| 分组 | 字段 | 行 |
|---|---|---|
| 画布基础 | `ctx`、`cw`、`ch`、`dpr`（`opts.dpr \|\| 2`） | `:105-108` |
| 观景变换 | `view { scale:1, ox:0, oy:0 }` | `:111` |
| 路线与几何 | `route`、`nodeIndex`（id→下标）、`nodePts`、`path`、`pathDist`、`pathLen`、`nodePathIdx`（S4：各节点在采样路径上的下标，L8 飞线终点定位，`:120`） | `:114-120` |
| 星空元素 | `farStars`（110）、`stars`（64，前 9 颗 `glint`）、`trailDust`（22）、`regionMotes` | `:123-126` |
| 离屏资源 | `staticLayer`、`glowGold`、`glowRed`、`glowCyan`（S3 新增青色仪器光晕，`:132`） | `:129-131`、`:132` |
| 动画态 | `animStart`、`progressAnim`、`arriveFx` | `:135-137` |
| L7/L8 注入态（S4） | `stats`（`setStats` 归一化后的显示数据，null=未加载/失败画 `--`，`:140`）、`flyLine`（`{ idx, start }`，`:142`） | `:140-142` |
| 缓存 | `_goldGrad`/`_goldGradIdx`（金轨渐变按 endIdx 缓存）、`_flagGrad`、`_labelW`（标签宽度，S4 起键为含徽标的完整文本）、`_sweepGrad`/`_scanGrad`（S3 雷达扇/扫描带渐变各建一次，`:148-149`）、`_hintW`（提示文字宽度，`:151`）、`_ringPct`/`_ringText`（S4 仪表环百分比按整数变化缓存，`:153-154`） | `:145-151`、`:153-154` |
| 帧率采样（S5） | `lowPerf`（降级标记，置真后不复位）、`_perfBuf`（`PERF_WINDOW` 帧间隔环形缓冲，创建期一次性分配）、`_perfI`（下一写入槽）、`_perfN`（已填充样本数）、`_perfSum`（窗口内间隔累加，增量维护）、`_perfLast`（上一帧时间戳秒）、`_perfAvg`（最近满窗均值 ms，供测试/诊断读） | `:157-163` |

模块常量：`CLOUDS`（3 条薄雾带，`:38-42`）、`STAR_TINTS`（5 档星色，冷白×3/暖白/淡蓝，`:45`）、**S3 视觉常量** `CYAN='63,216,255'`（#3FD8FF，仪器层唯一主色，`:50`）、`DEEP_SKY`（四段深空底色带，`:52`）、`GRID=42`（网格间距，`:53`）、`RADAR_R=0.4`（雷达环半径相对 min(cw,ch)，`:54`）、`SWEEP_S=7`/`SWEEP_ARC=1.05`（雷达扇旋转周期/张角，`:55-56`）、`SCAN_S=9`（扫描带一趟秒数，`:57`）、`HINT_TEXT`（画布内操作提示文案，`:58`）、**S4 叠加层常量** `FLY_MS=1400`（飞线单趟时长，`:59`）、`BADGE_ZOOM=1.5`（人数徽标并入标签的缩放阈值，`:60`）、`OVERLAY_ROWS`（面板三行标签，`:63`）、`OVERLAY_W=126`/`OVERLAY_H=58`（面板尺寸，`:64-65`）、`RING_R=18`（仪表环半径，`:66`）、`LEGEND`（三态图例色表，`:67-71`）、`LEGEND_STEP=54`（图例水平间距，`:72`）、`CYAN_HEX='#3FD8FF'`（需整色时避免帧内拼字符串，`:51`），以及 `INTRO_MS=1400`/`PROGRESS_MS=800`/`ARRIVE_FX_MS=2400`/`PARTICLE_CAP=64`（`:85-88`，替代搬迁前的散落魔数）、**S5 降级常量** `PERF_WINDOW=30`（采样窗口帧数，`:91`）、`PERF_BUDGET_MS=33`（帧间隔预算，>33ms 即 <30fps，`:92`）、`PERF_GAP_MS=1000`（超过即视为暂停/切后台的时间跳变并丢弃该样本，`:93`）；模块级函数 `fmtNum(n)`（`:78`，≥1 亿/≥1 万缩写、其余千分位，只在 `setStats` 调用）。

### 4.2 `setRoute(route)`：入场 vs 增量的唯一判定点（`:172`）

吸收原 `march.js renderRoute` 的分支判定，使页面 `initCanvas` 与 `renderRoute` 共用一条路径：

- 记旧进度 `prevProgress`（旧 `route.routeProgress`）→ 写 `this.route` 并重建 `nodeIndex`；
- `prevProgress === null || !this.path`（首次建内核或首次拿路线）→ `buildGeometry + buildStatic + buildGlowSprites` 全量重建 + `animStart = Date.now()` 播完整入场描画；
- 否则（步数刷新）→ 只建 `progressAnim = { from: 旧进度, to: calcRouteProgress(route), start }` 做约 800ms 增量推进（§3.5「不重播完整地图动画」）。

`calcRouteProgress(route)`（`:201`）优先取后端 `routeProgress`（钳制 0~1），旧接口降级 `currentSteps/totalSteps`；`currentRatio()`（`:207`）在 `progressAnim` 期间按 `routeCanvas.easeOutCubic` 插值、到期自清并回落后端值。`dist2Index(len)` 用 `routeCanvas.distToIndex` 把弧长映射到采样下标。

### 4.3 几何构建 `buildGeometry()`（`:227`）与 `sampleSkyPoint(bandRatio)`（`:313`）

全部元素**构建期一次性分配、帧内零分配**：① `routeCanvas.getCanvasNodePositions(nodes, cw, ch)` 经纬度→画布坐标归一化（非硬编码，兼容任意节点数）；② `routeCanvas.sampleRoutePath(nodePts, 30)` Catmull-Rom 平滑采样得 `path/pathDist/pathLen`，S4 起同时保存返回的 `nodePathIndex` 为 `nodePathIdx`（`:238`，各节点在采样路径上的下标，供 L8 飞线定位终点）；③ 沿线星尘 `trailDust` 固定 22 颗（相位/频率各异）；④ 星空三层——`farStars` 110 颗（随静态层烘焙，零帧开销）、`stars` 64 颗其中前 9 颗大星带十字光芒，每颗独立周期/亮度区间/色调、约半数 `slow` 用三次方曲线做「长时微暗→缓慢增亮→渐暗」呼吸，构建期按颜色排序减少绘制期 fillStyle 切换；⑤ 区域氛围粒子 `regionMotes`：每节点 3 颗、读 `nodeThemes.getNodeTheme(node.id).particleConfig`；⑥ `_labelW = {}` 清空重建。

`sampleSkyPoint` 按概率落入左上→右中斜向银河带（近似高斯散布），其余均匀散布天空区（高度 72%），避让节点 16px、最多重试 6 次。

### 4.4 离屏层与光晕精灵（`buildStatic` `:341`、`buildGlowSprites` `:366`、`dispose` `:383`）

- `buildStatic()`（`:341`）：先重置渐变缓存 `_goldGrad/_goldGradIdx/_flagGrad` 与 S3 新增的 `_sweepGrad/_scanGrad/_hintW`（`:343-348`，不变量「画布重建时重置」），再 `wx.createOffscreenCanvas({type:'2d', width: cw*dpr, height: ch*dpr})` 烘焙 `paintScenery`；**整体 try/catch，失败置 `staticLayer = null` 降级为每帧直绘**（低版本基础库无离屏画布；`frontend/AGENTS.md` 明令禁止删除该 try/catch）。
- `buildGlowSprites()`（`:366`）：经 `routeCanvas.createGlowSprite` 预渲染金（`255,205,90`）/红（`255,80,105`）两个 64px 径向光晕精灵，S3 另建青色仪器光晕 `glowCyan`（`:375`，供 `drawClouds` 与 L8 飞线光头复用）；失败返回 null、消费处均判空。`glowCyan` 各档 alpha 偏低（为大面积薄雾设计），L8 单点使用时需**连贴两次**才够亮（`:1455-1456`）。
- `dispose()`（`:383`）：置空 `ctx`、离屏层、三精灵（含 `glowCyan` `:388`）、S4 注入态 `nodePathIdx/stats/flyLine`（`:396-398`）、渐变与宽度缓存（`:403-408`）、S4 仪表环缓存 `_ringPct/_ringText`（`:409-410`）、**S5 采样态 `lowPerf/_perfBuf/_perfI/_perfN/_perfSum/_perfLast/_perfAvg`（`:411-417`，复位后新实例从 0 重新测量）**、动画态与全部几何/星空数组——切回实景时 `<canvas>` 节点已被 `wx:else` 移除，不释放会泄漏画布上下文与离屏位图。

### 4.5 帧率采样 `samplePerf(t)`（`:429`）与单帧 `draw(t)`（`:451`）、静态 scenery（L0~L3 仪器层）

`samplePerf(t)`（`:429`，S5）：`draw` 首行挂钩（`:454`）。滚动 `PERF_WINDOW` 帧的间隔均值 > `PERF_BUDGET_MS` 即置 `lowPerf`；环形缓冲 `_perfBuf` 创建期一次性分配，覆盖槽位时先减旧值再加新值，**每帧 O(1)、零分配**；未满窗不判定（`_perfN < PERF_WINDOW` 直接返回，`_perfAvg` 保持 0）；首帧无间隔可测（`_perfLast=0`）；`dt <= 0 || dt > PERF_GAP_MS` 的样本丢弃（暂停/切后台的时间跳变）；**`lowPerf` 已真时直接 return 不再采样**——降级不自动恢复。

`draw(t)`：守卫 `!ctx || !route` 直接返回 → `samplePerf(t)` → `ctx.save` → 应用观景变换 `translate(ox,oy)+scale` → 贴 `staticLayer` 离屏图（`:466`，不可用时 `clearRect` + 直绘 `paintScenery` 降级）→ 依次 `drawRadar`（L4 旋转扫描扇，`:471`）/`drawScanBand`（L4 垂直扫描带，**S5 起包在 `if (!this.lowPerf)` 内，`:473**）/`drawClouds`/`drawStars`/`drawRegionMotes`/`drawRoute`/`drawNodes`/`drawArriveFx`（**其内粒子扩散同样包在 `if (!this.lowPerf)` 内，`:1283**）/`drawProgressFlag`/**`drawFlyLine`（L8，S4 新增，`:481`，仍在变换内故随 pan/zoom 贴合路线）** → `restore`（`:483`）→ **视口固定的两层画在变换之外**：`drawHudHint()`（`:485`）与 `drawOverlay()`（L7，S4 新增，`:486`）。

`paintScenery(ctx)`（`:494`）只进离屏层（或降级时每帧直绘），S3 重做后的顺序：① L0 深空底四段线性渐变（`DEEP_SKY`）；② 中心青色径向微光 + 四角暗角营造纵深；③ `drawRadarRing`（`:564`，L1 雷达坐标环：4 圈同心圆 + 十字虚线 + 12 刻度 + N/E/S/W 标签，**取代搬迁前的罗盘玫瑰 `drawCompass`，后者已删除**）；④ 远景微星按两档亮度各合批一次 fill；⑤ `drawRidges`（`:645`，L2 由「填充剪影山峦」改为**青色等高线线框**：3 层、逐层振幅衰减营造高程感、无填充）；⑥ `drawGrid`（`:607`，L1 42px 细网格 + 每 4 条主网格 + 与边框交点尺齿）；⑦ 青虚线路线底（未完成部分引导线，`setLineDash([7,7])`，经 `routeCanvas.tracePath`）；⑧ `drawFrame`（`:680`，L3 由描金矩形改为**切角 HUD 框**：外/内双框 + 四角卡扣括号）。

S3 两个每帧动态仪器层：`drawRadar(t)`（`:717`）把径向渐变**只建一次**缓存为 `_sweepGrad`（`:726`），每帧 `translate` 到中心 + 按 `SWEEP_S` 旋转 + `routeCanvas.drawScanSector` 填扇 + 前缘亮线；`drawScanBand(t)`（`:749`）线性渐变只建一次缓存为 `_scanGrad`（`:759`），按 `SCAN_S` 自上而下平移一条垂直扫描带 + 前缘亮线——**恰 2 次 `fillRect`、0 次 `stroke`，是 S5 降级首刀且可被 ctx 打点精确验证**。

### 4.6 动态层（每帧绘制）

- `drawClouds(t)`（`:772`）：3 条薄雾椭圆带按 `CLOUDS` 横向漂移循环；S3 改为复用 `glowCyan` 离屏精灵 `drawImage` 缩放（`:782`，消除搬迁前每帧 3 次 `createRadialGradient`），sprite 为 null 时保留原渐变+椭圆降级路径。
- `drawStars(t)`（`:802`）：逐星独立周期/相位错峰闪烁；`slow` 星三次方呼吸；`glint` 大星随亮度轻微缩放并画十字光芒；色标取 `STAR_TINTS`，同色合批（配合构建期排序）。S3 未改星数/采样/避让口径。
- `drawRegionMotes(t)`（`:835`）：区域氛围粒子四分支——snow 循环下落+横向飘摆、ember 循环上升渐隐、mist 横向漂移柔光雾团、star 原地闪烁；分支枚举与 `node-themes.js` 的 `particleConfig.type` 绑定（`.qoder/frontend/data/node-themes.js.md` §8.3）。
- `drawRoute(t)`（`:879`）：已完成段长度 = `pathLen × currentRatio()`（含增量推进）再乘 `INTRO_MS` 入场描画系数；S3 重做为**能量管**三段描边——① 青色发光管（shadowBlur 18 + 半透明青粗线）、② 金色内核（渐变按 `endIdx` 缓存 `_goldGrad/_goldGradIdx`、仅变化时重建）、③ 流光虚线（`routeCanvas.drawDashFlow`，`:927`，负 offset 做流动）；入场完成后 3 条流光彗尾沿已完成段循环（光点头复用金色光晕精灵）；星尘 `trailDust` 仅已完成段内闪烁。
- `drawNodes(t)`（`:978`）：S3 重做为**三态六边环**（`routeCanvas.drawHexRing`，completed `:991`、current `:1026`、unlocked `:1038`）——completed=金色光晕呼吸+旋转双环六边+双层五角星旋转；current=柔和外发光+双脉冲扩散环+红色六边环呼吸缩放+红色星形；unlocked=暗青六边环+暗星点；脉冲透明度用 `globalAlpha` 而非每帧拼 rgba 字符串。每节点带标签 `drawNodeLabel`（`:1056`，深色圆角底衬**加青色描边**+状态色文字，`_labelW` 缓存宽度避免每帧 `measureText`）；S4 起当 `stats` 已注入且 `view.scale >= BADGE_ZOOM` 时，把该节点点亮人数拼到标签文本尾部（`:1062-1066`，**复用同一次 `fillText`**，不为徽标新增绘制调用，`_labelW` 的键随之变成含徽标的完整文本）。
- `drawHudHint()`（`:1091`）：S3 新增、**视口固定**（在 `draw` 的 `restore` 之后调用，不随 view 变换）：切角小面板（`routeCanvas.drawHudPanel`）+ 青色操作提示文字 `HINT_TEXT`，宽度 `_hintW` 只测一次。原因是 `<canvas type="2d">` 为原生层会盖住 DOM，旧 `.map-hint` 在星空模式本就不可见（潜在缺陷），提示改画进画布；实景模式仍用 DOM 浮层（`march.wxml` 的 `.map-hint` 已加 `wx:if="{{mode === 'real'}}"`）。
- `drawProgressFlag(t)`（`:1115`）：进度旗帜=基座呼吸光晕（复用金色精灵）+3 颗循环上升光尘+旗杆旗面随路线切线方向摆动（旗面渐变 `_flagGrad` 创建一次复用，注释「渐变坐标固定（局部系）」）+旗上金星；`currentSteps<=0` 或路径不足 2 点时不画。

### 4.7 点亮动画（§13.3，`playArrive` `:1193`）

- `playArrive(ids)`（`:1193`）：公开入口（页面 `playArriveIfNeeded` 调，`march.js:317`），建 `arriveFx = { ids, start, particles: makeArriveParticles(ids) }`。
- `makeArriveParticles(ids)`（`:1206`）：fx 创建时一次性预生成，每节点 14 颗（光晕精灵不可用的低端设备减半为 6），总量 `PARTICLE_CAP=64` 封顶，避免 rAF 帧内分配。
- `drawArriveFx()`（`:1235`）：约 `ARRIVE_FX_MS`(2.4s) 的「亮起（0.6s 渐入）→ 扩大（1.2s bump 至 1.9 倍）→ 两层扩散金环 → 粒子抛物扩散渐隐（生命 0.9s）」；播完自清 `arriveFx = null`，节点回到常态呼吸无跳变。**S5 起粒子扩散整段包在 `if (!this.lowPerf)` 内（`:1283`）**——守卫放在绘制侧而非 `playArrive` 生成侧，因为降级可能在动画中途才判定出来，一处守卫即覆盖「降级前已开始播」与「降级后才触发」两种情形。

### 4.8 实时数据叠加层（S4：L7 `setStats`/`drawOverlay`，L8 `playFlyLine`/`drawFlyLine`）

- `setStats(stats)`（`:1315`）：**唯一的数据入口**，入参由页面归一化（`march.js:186-192`），形状 `{ todayUsers, todayLit, todaySteps, litMap }`；`null` → `this.stats = null`（`:1317`，面板三行画 `--`、徽标不显示、仪表环归零），否则用 `fmtNum` 预格式化三行文本为 `lines[3]`、并把 `litMap` 各节点的 `litCount` 预格式化成 `badges[nodeId]`——**格式化只在注入时做一次，帧内零字符串拼接**。
- `drawOverlay()`（`:1347`，L7）：三段视口固定仪表，全部青色仪器语言。① 左上数据面板：切角矩形（`OVERLAY_W×OVERLAY_H`，切角 7）+ 深底 `rgba(5,11,22,0.62)` + 青描边 `0.30` + 左侧青色强调竖条，三行「今日参与/今日点亮/全员步数」左标签（9px 青 0.62）右数值（11px 近白 0.92，无数据 `--`）；② 右上进度仪表环：圆心 `(cw-32, 34)`、半径 `RING_R`，底环整圆 + 值弧（`routeCanvas.drawArcGauge`，`:1390`，比例取 `currentRatio()`）+ 环内百分比（`_ringPct/_ringText` 按整数变化缓存，`:1380-1382`）+ 环下「我的进度」图注；③ 左下三态图例（`LEGEND`，`ly = ch - 46`，间距 `LEGEND_STEP`）：已点亮金/当前红/未解锁暗青，图例图形复用 `drawHexRing`（`:1407`）保持与节点同语言。
- `playFlyLine(nodeId)`（`:1335`，L8）：入口守卫 `nodeId`、`nodeIndex`、`nodePathIdx` 三者齐备（未知 id 静默忽略），置 `flyLine = { idx, start: Date.now() }`。页面在收到 WS `activity` 事件时调用（`march.js:167`），**内核不认 WS 消息形状**。
- `drawFlyLine()`（`:1422`，L8）：`k = (now - start) / FLY_MS`，`k >= 1` 自清 `flyLine = null`（`:1429`，无需页面参与）；起点 = 我方进度点 `dist2Index(pathLen × currentRatio())`，终点 = `nodePathIdx[idx]`（钳到路径末点，`:1435`），光头位置按 `easeOutCubic(k)` 插值；绘制 = 8 颗拖尾点（沿反方向等距、alpha 与半径递减）+ 光头双贴 `glowCyan`（`:1455-1456`）+ 青色信号环 + 白核 + `k > 0.75` 时在目标节点画扩散抵达环。全在观景变换内，随 pan/zoom 贴合路线。

### 4.9 观景变换与命中（`clampView` `:1486`、`resetView` `:1493`、`hitTest` `:1501`）

- `clampView()`（`:1486`）：缩放钳制 1~2.5 倍，平移钳制使场景不离开画布。
- `resetView()`（`:1493`）：复位 `{scale:1, ox:0, oy:0}`。
- `hitTest(sx, sy)`（`:1501`）：屏幕坐标按 `view` 逆变换到场景坐标，命中半径 `22/scale` 保持屏幕恒定；返回 `route.nodes[i].id` 或 null——**不校验节点状态**，未解锁节点同样命中（`frontend/AGENTS.md` 不变量 8）。

## 5. 输入与输出

- **输入**：`createHudMap({ ctx, cw, ch, dpr })`——`ctx` 为 Canvas 2D 上下文（页面已 `ctx.scale(dpr,dpr)`，`march.js:582`），`cw/ch` 为 CSS 尺寸；`setRoute(route)` 接收 `GET /api/march/route` 的响应对象（只读 `nodes/routeProgress/totalSteps/currentSteps`）；`setStats(stats)` 接收页面归一化后的实时数据 `{ todayUsers, todayLit, todaySteps, litMap }`（`litMap[nodeId] = { litCount, completionRate }`，由 `GET /march/route-stats` + `GET /broadcast/today` 合并而来，内核不认接口形状）；`playFlyLine(nodeId)` 接收节点 id（页面从 WS `activity` 事件取，`march.js:167`）。
- **输出**：无返回值、无事件回调；全部效果直接画进 `ctx`。页面与 automator 通过实例字段读状态（`view`/`nodePts`/`stars`/`trailDust`/`staticLayer`/`arriveFx`/`stats`/`flyLine` 等）。
- **导出**：`module.exports = { createHudMap }`（`:1519`），单导出。

## 6. 依赖关系

- **require（2 个）**：`./routeCanvas`（13 个导出全部被本模块使用：`getCanvasNodePositions`/`sampleRoutePath`/`distToIndex`/`easeOutCubic`/`drawStar`/`drawRoundRect`/`createGlowSprite`，S3 新增的 `tracePath`/`drawDashFlow`/`drawHexRing`/`drawScanSector`/`drawHudPanel`，S4 新增的 `drawArcGauge`）、`../data/node-themes`（`getNodeTheme`，区域粒子配置）。
- **wx API**：仅 `wx.createOffscreenCanvas`（`buildStatic` 内，try/catch 内）。
- **被依赖**：仅 `pages/march/march.js:18`。
- **不依赖**：任何 `services/*`、Storage、`getApp()`、`setData`——内核无页面耦合（grep 实证零命中），这是它能被 automator `evaluate` 白盒断言的前提。S4 的两个数据入口同样是「页面喂数据、内核只画」，未打破该边界。

## 7. 业务规则

1. **帧内零分配**：星空/星尘/粒子全部构建期或 fx 创建期一次性生成；渐变按 endIdx/局部系/一次性缓存复用（`_goldGrad`/`_flagGrad`/`_sweepGrad`/`_scanGrad`）；标签与提示宽度缓存（`_labelW` 键为含徽标的完整文本）；L7 数值在 `setStats` 时一次性 `fmtNum` 格式化、进度环百分比按整数变化缓存（`_ringPct/_ringText`）；脉冲透明度用 `globalAlpha`、整色用 `CYAN_HEX` 常量，而非每帧拼 rgba 字符串。
2. **离屏降级**：`buildStatic` 的 try/catch 失败即 `staticLayer=null`，`draw` 回退每帧直绘 `paintScenery`——功能不中断（`frontend/AGENTS.md` 不变量 6）。
3. **画布重建即重置缓存**：`buildStatic` 入口重置 `_goldGrad/_goldGradIdx/_flagGrad/_sweepGrad/_scanGrad/_hintW`（`:325-330`）；`dispose` 释放全部离屏资源、精灵与 S4 注入态/缓存。
4. **入场/增量唯一判定在 `setRoute`**：页面不得自行重播入场动画（§3.5）。
5. **命中不拦截未解锁节点**（不变量 8）。
6. **配色铁律（S3 起，S4 扩展）**：金 `#F0C65A`/红 `#FF3D57` 只用于叙事元素（路线、节点、进度旗、点亮动画）；青 `#3FD8FF`（`CYAN`/`CYAN_HEX`）**只用于仪器层与数据元素**（网格、雷达环、扫描扇/带、切角框、等高线、引导虚线、标签描边、提示面板，以及 L7 面板/仪表环与 L8 飞线），不得混用。
7. **每帧绘制预算（文件头 docstring `:24-25` 声明）**：长折线描边 ≤4（L5 能量管三次）、`drawImage` ≤30、`fillText` ≤22（节点标签 10 + 操作提示 1 + L7 面板 6 + 仪表环 2 + 图例 3）、`createLinearGradient` ≤1；S4 实测 `fillText` 22.0、`drawImage` 13、`stroke` 43（多为仪器层短弧，非长折线）。新增绘制层须在此预算内。
8. **L7 数据缺失不隐藏面板**：`setStats(null)` 或未注入时三行画 `--`、徽标不显示、仪表环归零，绘制不得抛异常（网络失败沿用页面侧的上次数据）。
9. **帧率自适应降级不自动恢复（S5）**：滚动 30 帧间隔均值 >33ms 置 `lowPerf` 后**不再复位**（实例级，`dispose` 后新实例才重新测量），避免在阈值附近反复开关造成视觉抖动；只关 L4 水平扫描带与点亮粒子扩散两个纯氛围层，雷达扇形、L5 流光与全部叙事/数据层保留；暂停/切后台造成的 >1s 时间跳变样本丢弃，不污染均值。外部（含测试）强制改写 `lowPerf` 时必须一并复位 `_perf*` 采样窗口，否则遗留的高间隔样本会在下一帧把 `lowPerf` 重新置真。

## 8. 修改约束

1. **页面与内核的边界不得反向**：内核不得 require service/读 Storage/`setData`；页面不得再持有绘制状态（`ctx` 除外的绘制字段都在 `hud` 上，automator 断言读 `page.hud.*`，五个套件 `p0-march`/`p1-starry-march`/`tabbar-starmap`/`s16-review-smoke`/`hud-overlay` 已按此口径改写且不留兼容别名）。
2. **`routeCanvas.js` 只增不改**：`pages/ceremony/ceremony.js` 与 `pages/ticket/ticket.js` 共用该模块，改返回结构 `{path,dist,len,nodePathIndex}` 或 `createGlowSprite` 签名会同时击穿三处。
3. **`buildStatic` 的 try/catch 禁止删除**（`frontend/AGENTS.md`）。
4. **`view` 改写必须配 `clampView()`**：页面手势是唯一改写方，漏钳制会让场景拖出画布。
5. `node-themes` 的 `particleConfig.type` 枚举（snow/ember/mist/star）是跨文件硬契约，改枚举须同步 `drawRegionMotes` 四分支。
6. **S3、S4 已完成（2026-10-19），S5 已完成（2026-10-21）**：L0~L6 深空 HUD 重做落在本文件 + `routeCanvas` 纯新增 helper + `march.wxml/wxss`；L7/L8 落在本文件 + `routeCanvas.drawArcGauge` + `march.js` 的 WS/取数逻辑；S5 帧率降级落在本文件的采样器 + 两处绘制守卫（`march.js` 零改动）。后续再改绘制体时保持「状态+单帧绘制」的工厂形态、页面边界、几何/星数/命中口径与 §7 的配色铁律、每帧预算、降级不自动恢复不变。
7. **视口固定层必须在 view 变换之外调用**（`draw` 的 `restore` 之后）：`drawHudHint` 与 L7 `drawOverlay` 属此类，放进变换内会随 pan/zoom 漂移；反之 L8 `drawFlyLine` 必须在变换之内（`restore` 之前），否则飞线脱离路线场景坐标。
8. **`setStats` 入参形状是页面-内核契约**：改字段名须同步 `march.js:186-192` 的归一化与 `hud-overlay.cjs` 的断言；`playFlyLine` 只接受 `nodeId`，不得改成接受 WS 消息对象（否则内核开始认协议形状）。

## 9. 当前实现状态

- **已实现**：星空模式全部绘制（L0 深空底、L1 雷达环+网格、L2 等高线线框、L3 切角框、星空三层、区域粒子、L4 扫描扇+扫描带、L5 金能量管+彗尾+星尘、L6 三态六边环节点、L7 实时数据面板+进度仪表环+三态图例+缩放人数徽标、L8 WS 飞线、进度旗、点亮动画、视口固定操作提示）、观景变换与命中、离屏降级、释放链、**帧率自适应降级（S5：`samplePerf` 滚动采样 + L4 扫描带/点亮粒子两处守卫，不自动恢复）**。2026-10-21 S5 后开发者工具自动化五套件全绿（`hud-perf` 12/12、`hud-overlay` 10/10、`tabbar-starmap` 8/8、`p0-march` 6/6、`p1-starry-march` 4/4；`s16` 的两条历史失败为预存 mock 登录配置漂移、不经本模块），几何/星数/观景变换/命中口径与 S2 基线一致，整帧耗时 S2 0.61ms → S3 1.05ms → S4 1.13~1.15ms → S5 0.74ms（`tabbar-starmap` TS-04；`hud-overlay` OV-06 在 rAF 争用下 1.49ms，均 ≪16ms 预算）。报告 `frontend/test/docs/s30-hud-kernel-extract-report.md`（S2）、`s31-deep-space-hud-report.md`（S3）、`s32-realtime-overlay-report.md`（S4）、`s33-adaptive-degradation-report.md`（S5）。
- **已知事项**：① `regionMotes` 注释称「总量 30 封顶」但循环无封顶判断（每节点 3 颗 × 当前 10 节点恰为 30），节点增加时粒子数线性增长无代码级上限（搬迁前即如此）；② `draw(t)` 的 `t` 由页面传 `Date.now()/1000`，内核不自持时钟——S5 的采样器正以此为采样源，暂停/切后台的时间跳变靠 `PERF_GAP_MS` 丢弃；③ L8 飞线的端到端触发需第二个客户端产生点亮事件，S4 只做了页面分支白盒断言 + `playFlyLine` 直接注入的视觉验证；④ 降级收益（PD-09 的 Δ 在模拟器软件渲染下仅 ~0.04ms/帧且只含扫描带）需在真机低端设备度量，见待开发。
- **待开发**：**真机验收**（降级阈值 30fps 与降级收益需人工扫码进真机调试度量；模拟器结论不代表真机）。S3、S4、S5 的代码与模拟器验收均已完成，勿再当待办引用。

## 10. 迭代记录

### 2026-10-19（`2862453`）
- 需求：深空 HUD 科技感地图五阶段方案的 S2——把绘制逻辑从页面抽离为可独立演进、可白盒断言的渲染内核，为 S3 视觉重做固化「行为不变」基线。
- 修改内容：新建本文件（996 行），从 `pages/march/march.js` 纯搬迁全部星空绘制（`march.js` 1521→654 行）；魔数收敛为 `INTRO_MS/PROGRESS_MS/ARRIVE_FX_MS/PARTICLE_CAP`；入场/增量判定上移为 `setRoute` 内部逻辑；新增公开入口 `playArrive`。同批改写 4 个 automator 套件读 `page.hud.*`、同步 `frontend/AGENTS.md` 不变量 6 与 `frontend/design.md` §4.6。
- 测试结果：automator 四套件 `tabbar-starmap` 8/8、`p0-march` 6/6、`p1-starry-march` 4/4、`s16-review-smoke` 16/18（R7/R12 为预存 mock 登录 502 配置漂移）；与搬迁前基线逐项一致、截图逐图比对一致；`node --check` 全通过。报告 `frontend/test/docs/s30-hud-kernel-extract-report.md`；`docs/迭代记录.md` 的 `2862453` 条目。

### 2026-10-19（`835f46f`）
- 需求：深空 HUD 科技感地图五阶段方案的 S3——在 S2「行为不变」基线上把星空模式重做为深空 HUD 视觉（L0~L6），几何/星数/观景变换/命中口径全部不动。
- 修改内容：本文件 996→1218 行。新增视觉常量 `CYAN/DEEP_SKY/GRID/RADAR_R/SWEEP_S/SWEEP_ARC/SCAN_S/HINT_TEXT` 与状态 `glowCyan/_sweepGrad/_scanGrad/_hintW`；新增 `drawRadarRing/drawGrid/drawRadar/drawScanBand/drawHudHint`；重做 `paintScenery`（L0 深空底+青晕+暗角）、`drawRidges`（填充山峦→青色等高线线框）、`drawFrame`（描金矩形→切角 HUD 框+四角卡扣）、`drawClouds`（每帧渐变→复用 `glowCyan` 精灵）、`drawRoute`（金能量管三段描边+流光虚线）、`drawNodes`（三态星形→三态六边环）、`drawNodeLabel`（加青描边）；删除 `drawCompass`（方位职责并入 `drawRadarRing`）。同批 `routeCanvas.js` 纯新增 5 个 helper、`march.wxml` 的 `.map-hint` 改实景专属、`march.wxss` 画布底色 `#050B16`；`march.js` 零改动。
- 测试结果：automator 四套件 `tabbar-starmap` 8/8、`p0-march` 6/6、`p1-starry-march` 4/4、`s16-review-smoke` 16/18（R7/R12 预存配置漂移）；与 S2 基线逐项一致（view{1,0,0}/星尘 22/scale 2.50/pan(-220,-320)/命中点 (343,375)/粒子 14/far 110/mid 64）；整帧 0.61→1.05ms（新增仪器层仍 ≪16ms）、星空子层 0.27→0.12ms；改造前后截图逐图比对（`s3-before-starry.png` vs `27-march-starry.png`）几何一致、仪器层与配色为重做项。`node --check` 全通过。报告 `frontend/test/docs/s31-deep-space-hud-report.md`；`docs/迭代记录.md` 的 `835f46f` 条目。

### 2026-10-19（`5b26b07`）
- 需求：科技感地图五阶段方案的 S4——把实时业务数据接上屏：L7 全员数据面板/我的进度仪表环/三态图例，L8 他人点亮事件的数据包沿路线飞向目标节点。
- 修改内容：本文件 1218→1459 行。新增常量 `CYAN_HEX/FLY_MS/BADGE_ZOOM/OVERLAY_ROWS/OVERLAY_W/OVERLAY_H/RING_R/LEGEND/LEGEND_STEP` 与模块函数 `fmtNum`；新增状态 `nodePathIdx/stats/flyLine/_ringPct/_ringText`；`buildGeometry` 保存 `sampleRoutePath` 返回的 `nodePathIndex`；新增 `setStats`（唯一数据入口，注入时一次性格式化）/`playFlyLine`/`drawOverlay`（L7）/`drawFlyLine`（L8）；`drawNodeLabel` 在 `view.scale >= 1.5` 时把节点点亮人数并入标签文本（不新增 `fillText`）；`draw` 增加变换内的 `drawFlyLine`（`:425`）与变换外的 `drawOverlay`（`:430`）；`dispose` 清理全部新增态。同批：`routeCanvas.js` 纯新增 `drawArcGauge`（227→239 行、13 导出）、`services/march.js` 新增 `getRouteStats()`、`march.js` 654→721 行（WS 订阅生命周期 + `loadOverlay` 合并 `/march/route-stats` 与 `/broadcast/today`、5s 节流、实景模式不取数、上次数据兜底重注入）、新增 automator 套件 `hud-overlay.cjs`（OV-01~OV-10）与截图脚本 `hud-overlay-shots.cjs`。
- 测试结果：新套件 `hud-overlay` 10/10（两轮）；回归 `tabbar-starmap` 8/8（第三轮通过；前两轮各一条失败为 automation 桥超时与随机星频阈值抖动，与 S4 无关）、`p0-march` 6/6、`p1-starry-march` 4/4；`TS-04` 整帧 1.05→1.13~1.15ms，`OV-06` 在 rAF 争用下 2.45ms，ctx 打点实测 `fillText` 22.0（正好在预算线上）/`drawImage` 13/`stroke` 43（多为仪器短弧）；截图 `overlay-01-hud`~`overlay-05-real` 五张 + 更新 `27-march-starry.png`（飞线光头首版过暗，经裁剪放大定位后加强拖尾与双贴光晕重拍）。`node --check` 全通过。报告 `frontend/test/docs/s32-realtime-overlay-report.md`；`docs/迭代记录.md` 的 `5b26b07` 条目。

### 2026-10-21（`23f9461`）
- 需求：科技感地图五阶段方案的 S5——低端机兜底：帧率不足时自动关掉纯氛围层，且不在阈值附近反复开关。
- 修改内容：本文件 1459→1519 行。新增常量 `PERF_WINDOW=30`/`PERF_BUDGET_MS=33`/`PERF_GAP_MS=1000`（`:91-93`）与状态 `lowPerf`+`_perfBuf/_perfI/_perfN/_perfSum/_perfLast/_perfAvg`（`:157-163`，环形缓冲创建期一次性分配）；新增 `samplePerf(t)`（`:429`，增量维护和值每帧 O(1) 零分配、满窗才判定、>1s 跳变丢弃、降级后停止采样）并在 `draw` 首行挂钩（`:454`）；两处绘制守卫 `if (!this.lowPerf)`——L4 扫描带（`:473`）与点亮粒子扩散（`:1283`，放绘制侧以覆盖动画中途才判定出的降级）；`dispose` 复位全部采样态（`:411-417`）；文件头 docstring 增「帧率自适应降级（S5）」段（`:26-29`）。**`march.js` 零改动**（采样源即页面 rAF 传入的 `t`）。同批新增 automator 套件 `hud-perf.cjs`（PD-01~PD-12）与截图脚本 `hud-perf-shots.cjs`（两态冻结同一合成时间戳 T=4.5s 逐像素可比）。
- 测试结果：新套件 `hud-perf` 12/12（首轮 9/12，三条失败均为测试脚本缺陷——强制 `lowPerf` 未清采样窗口致 `samplePerf` 次帧重置真、固定 sleep 输给异步释放竞态——修复后复跑全绿）；回归 `tabbar-starmap` 8/8（TS-03 far 110/mid 64/glint 9/nearNode 0 与 S3/S4 一致、TS-04 整帧 0.74ms）、`p0-march` 6/6（ratio=0.1591）、`p1-starry-march` 4/4（scale 2.50/pan(-220,-320)/命中 (343,375)/粒子 14）、`hud-overlay` 10/10（OV-06 fillText 22.0/drawImage 13/stroke 43 不变）；PD-06 `ΔfillRect=2`、PD-08 `Δarc=14`=粒子数、PD-03 降级后采样逐字节停止、PD-10 释放 1261ms 后换新实例不继承降级标记；截图 `perf-01-normal.png`/`perf-02-degraded.png` 差异仅扫描带与粒子。`node --check` 全通过。报告 `frontend/test/docs/s33-adaptive-degradation-report.md`；`docs/迭代记录.md` 的 `23f9461` 条目。**真机验收待人工扫码补测**。
