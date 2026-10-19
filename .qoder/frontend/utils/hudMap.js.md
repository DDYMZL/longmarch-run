# hudMap.js（星空长征渲染内核）

## 1. 文件路径

`frontend/utils/hudMap.js`（996 行，工厂模块，唯一导出 `createHudMap`）

## 2. 文件职责

星空长征（Canvas 2D 插画地图）模式的**全部绘制状态与绘制逻辑**。`createHudMap({ ctx, cw, ch, dpr })` 返回内核实例，页面 `pages/march/march.js` 在 `initCanvas` 中创建并挂为 `page.hud`（`march.js:520`）。页面只保留：模式切换、数据拉取、rAF 循环、pan/pinch 手势数学（事件层）与命中后跳转；**本模块不 require 任何 service、不读写 Storage、不调 `getApp()`、不发请求、不 `setData`**——纯画布内核，可被 automator 经 `getCurrentPages().pop().hud` 白盒断言。

与页面的分工契约（两处注释互引：本文件头 JSDoc `:1-16`、`march.js:5-6` 与 `:553-556`）：

- **rAF 循环在页面**（`march.js:529-542`）：`onHide`/`onUnload`/`switchMode` 的生命周期归属不变，页面每帧只调 `hud.draw(t)`（`march.js:534`）。
- **观景变换 `view` 在内核**：页面手势直接改写 `hud.view.ox/oy/scale`，改完**必须**调 `hud.clampView()`（`march.js:592`、`:613`）；复位调 `hud.resetView()`（`march.js:628`）。
- **命中在内核**：`hud.hitTest(sx, sy)` 内部做屏幕→场景逆变换，返回节点 id 或 null（`march.js:642`）。
- **释放**：切回实景时页面调 `hud.dispose()` 并置 `hud = null`（`march.js:331-335`）。

## 3. 业务需求

文件头 docstring（`:1-16`）声明边界；绘制实现对应需求 §13.2（节点三态星形：金发光星/红呼吸星+脉冲环/暗星点）、§13.3（点亮动画四阶段：亮起→扩大→粒子扩散→稳定发光）、§13.4（星空全景低开销 rAF：构建期一次性分配、帧内零分配）、§3.5（轨迹推进：仅首次播 1400ms 入场描画，步数刷新做 800ms 增量推进）、§12（区域氛围粒子，经 `data/node-themes.js` 的 `particleConfig`）。

本文件诞生于 2026-10-19 `2862453`（深空 HUD 科技感地图五阶段方案的 **S2**）：把原 `march.js` 约 850 行绘制逻辑**纯搬迁**至此（函数体逐行移动，仅 `this.routeData`→`this.route`、`this.dpr || 2`→`this.dpr` 等引用改名，魔数收敛为命名常量），视觉与行为零变更；搬迁前各绘制的演进史见 `.qoder/frontend/pages/march/march.js.md` §10。拆分动机：S3 的深空 HUD 视觉重做要在「行为不变的搬迁」基线上进行，重构与视觉叠加时出问题无法定位。

## 4. 核心功能

### 4.1 工厂与状态字段（`:44-82`）

`createHudMap(opts)` 返回对象字面量（与代码库 `Page({})` 风格一致，不用 class）。字段分组：

| 分组 | 字段 | 行 |
|---|---|---|
| 画布基础 | `ctx`、`cw`、`ch`、`dpr`（`opts.dpr \|\| 2`） | `:46-49` |
| 观景变换 | `view { scale:1, ox:0, oy:0 }` | `:52` |
| 路线与几何 | `route`、`nodeIndex`（id→下标）、`nodePts`、`path`、`pathDist`、`pathLen` | `:55-60` |
| 星空元素 | `farStars`（110）、`stars`（64，前 9 颗 `glint`）、`trailDust`（22）、`regionMotes` | `:63-66` |
| 离屏资源 | `staticLayer`、`glowGold`、`glowRed` | `:69-71` |
| 动画态 | `animStart`、`progressAnim`、`arriveFx` | `:74-76` |
| 缓存 | `_goldGrad`/`_goldGradIdx`（金轨渐变按 endIdx 缓存）、`_flagGrad`、`_labelW`（标签宽度） | `:79-82` |

模块常量：`CLOUDS`（3 条薄雾带，`:22-27`）、`STAR_TINTS`（5 档星色，冷白×3/暖白/淡蓝，`:29`）、`INTRO_MS=1400`/`PROGRESS_MS=800`/`ARRIVE_FX_MS=2400`/`PARTICLE_CAP=64`（`:31-34`，替代搬迁前的散落魔数）。

### 4.2 `setRoute(route)`：入场 vs 增量的唯一判定点（`:91-118`）

吸收原 `march.js renderRoute` 的分支判定，使页面 `initCanvas` 与 `renderRoute` 共用一条路径：

- 记旧进度 `prevProgress`（旧 `route.routeProgress`，`:93-95`）→ 写 `this.route` 并重建 `nodeIndex`（`:96-99`）；
- `prevProgress === null || !this.path`（首次建内核或首次拿路线）→ `buildGeometry + buildStatic + buildGlowSprites` 全量重建 + `animStart = Date.now()` 播完整入场描画（`:100-105`）；
- 否则（步数刷新）→ 只建 `progressAnim = { from: 旧进度, to: calcRouteProgress(route), start }` 做约 800ms 增量推进（`:106-110`，§3.5「不重播完整地图动画」）。

`calcRouteProgress(route)`（`:120-124`）优先取后端 `routeProgress`（钳制 0~1），旧接口降级 `currentSteps/totalSteps`；`currentRatio()`（`:126-143`）在 `progressAnim` 期间按 `routeCanvas.easeOutCubic` 插值、到期自清并回落后端值。`dist2Index(len)` 用 `routeCanvas.distToIndex` 把弧长映射到采样下标。

### 4.3 几何构建 `buildGeometry()`（`:146-229`）与 `sampleSkyPoint(bandRatio)`（`:231-250`）

全部元素**构建期一次性分配、帧内零分配**：① `routeCanvas.getCanvasNodePositions(nodes, cw, ch)` 经纬度→画布坐标归一化（非硬编码，兼容任意节点数）；② `routeCanvas.sampleRoutePath(nodePts, 30)` Catmull-Rom 平滑采样得 `path/pathDist/pathLen`；③ 沿线星尘 `trailDust` 固定 22 颗（相位/频率各异）；④ 星空三层——`farStars` 110 颗（随静态层烘焙，零帧开销）、`stars` 64 颗其中前 9 颗大星带十字光芒，每颗独立周期/亮度区间/色调、约半数 `slow` 用三次方曲线做「长时微暗→缓慢增亮→渐暗」呼吸，构建期按颜色排序减少绘制期 fillStyle 切换；⑤ 区域氛围粒子 `regionMotes`：每节点 3 颗、读 `nodeThemes.getNodeTheme(node.id).particleConfig`；⑥ `_labelW = {}` 清空重建。

`sampleSkyPoint` 按概率落入左上→右中斜向银河带（近似高斯散布），其余均匀散布天空区（高度 72%），避让节点 16px、最多重试 6 次。

### 4.4 离屏层与光晕精灵（`:258-310`）

- `buildStatic()`（`:258-278`）：先重置渐变缓存 `_goldGrad/_goldGradIdx/_flagGrad`（不变量「画布重建时重置」），再 `wx.createOffscreenCanvas({type:'2d', width: cw*dpr, height: ch*dpr})` 烘焙 `paintScenery`；**整体 try/catch，失败置 `staticLayer = null` 降级为每帧直绘**（低版本基础库无离屏画布；`frontend/AGENTS.md` 明令禁止删除该 try/catch）。
- `buildGlowSprites()`（`:280-289`）：经 `routeCanvas.createGlowSprite` 预渲染金（`255,205,90`）/红（`255,80,105`）两个 64px 径向光晕精灵，失败返回 null、消费处均判空。
- `dispose()`（`:291-310`）：置空 `ctx`、离屏层、双精灵、动画态与全部几何/星空数组——切回实景时 `<canvas>` 节点已被 `wx:else` 移除，不释放会泄漏画布上下文与离屏位图。

### 4.5 单帧 `draw(t)`（`:314-346`）与静态 scenery

`draw(t)`：守卫 `!ctx || !route` 直接返回 → `ctx.save` → 应用观景变换 `translate(ox,oy)+scale` → 贴 `staticLayer` 离屏图（不可用时 `clearRect` + 直绘 `paintScenery` 降级）→ 依次 `drawClouds/drawStars/drawRegionMotes/drawRoute/drawNodes/drawArriveFx/drawProgressFlag` → `restore`。

`paintScenery(ctx)`（`:348-416`）只进离屏层（或降级时每帧直绘），按注释序号：① 夜空底色四段线性渐变；② 中心径向微光营造纵深；③ 42px 经纬网格；③.5 远景微星按两档亮度各合批一次 fill；④ 三层程序化山峦 `drawRidges`（`:418-454`：纵向渐变填充+山脊高光线，正弦叠加生成山脊）；⑤ 金色双线边框四角描金 `drawFrame`（`:456-479`）+ 右上罗盘玫瑰 `drawCompass`（`:481-508`，四向指针+N 字）；⑥ 虚线路线底（未完成部分引导线，`setLineDash([7,7])`）。

### 4.6 动态层（每帧绘制）

- `drawClouds(t)`（`:510-531`）：3 条薄雾椭圆带按 `CLOUDS` 横向漂移循环，每帧各建一次径向渐变。
- `drawStars(t)`（`:533-564`）：逐星独立周期/相位错峰闪烁；`slow` 星三次方呼吸；`glint` 大星随亮度轻微缩放并画十字光芒；色标取 `STAR_TINTS`，同色合批（配合构建期排序）。
- `drawRegionMotes(t)`（`:566-605`）：区域氛围粒子四分支——snow 循环下落+横向飘摆、ember 循环上升渐隐、mist 横向漂移柔光雾团、star 原地闪烁；分支枚举与 `node-themes.js` 的 `particleConfig.type` 绑定（`.qoder/frontend/data/node-themes.js.md` §8.3）。
- `drawRoute(t)`（`:607-693`）：已完成段长度 = `pathLen × currentRatio()`（含增量推进）再乘 `INTRO_MS` 入场描画系数；金色渐变按 `endIdx` 缓存 `_goldGrad/_goldGradIdx`、仅变化时重建（入场结束后即固定，避免每帧 `createLinearGradient`）；外发光层一次 shadowBlur 描边 + 内核亮线；入场完成后 3 条流光彗尾沿已完成段循环（光点头复用金色光晕精灵）；星尘 `trailDust` 仅已完成段内闪烁。
- `drawNodes(t)`（`:695-753`）：三态星形（§13.2）——completed=金色光晕呼吸+双层五角星旋转；current=柔和外发光+双脉冲扩散环+红色星形呼吸缩放（另叠一层慢呼吸红色柔光）；unlocked=暗色小星点；每节点带标签 `drawNodeLabel`（`:755-776`，深色圆角底衬+状态色文字，`_labelW` 缓存宽度避免每帧 `measureText`）。
- `drawProgressFlag(t)`（`:778-847`）：进度旗帜=基座呼吸光晕（复用金色精灵）+3 颗循环上升光尘+旗杆旗面随路线切线方向摆动（旗面渐变 `_flagGrad` 创建一次复用，注释「渐变坐标固定（局部系）」）+旗上金星；`currentSteps<=0` 或路径不足 2 点时不画。

### 4.7 点亮动画（§13.3，`:856-958`）

- `playArrive(ids)`（`:856-867`）：公开入口（页面 `playArriveIfNeeded` 调，`march.js:253`），建 `arriveFx = { ids, start, particles: makeArriveParticles(ids) }`。
- `makeArriveParticles(ids)`（`:869-896`）：fx 创建时一次性预生成，每节点 14 颗（光晕精灵不可用的低端设备减半为 6），总量 `PARTICLE_CAP=64` 封顶，避免 rAF 帧内分配。
- `drawArriveFx()`（`:898-958`）：约 `ARRIVE_FX_MS`(2.4s) 的「亮起（0.6s 渐入）→ 扩大（1.2s bump 至 1.9 倍）→ 两层扩散金环 → 粒子抛物扩散渐隐（生命 0.9s）」；播完自清 `arriveFx = null`，节点回到常态呼吸无跳变。

### 4.8 观景变换与命中（`:963-994`）

- `clampView()`（`:963-968`）：缩放钳制 1~2.5 倍，平移钳制使场景不离开画布。
- `resetView()`（`:970-976`）：复位 `{scale:1, ox:0, oy:0}`。
- `hitTest(sx, sy)`（`:978-994`）：屏幕坐标按 `view` 逆变换到场景坐标，命中半径 `22/scale` 保持屏幕恒定；返回 `route.nodes[i].id` 或 null——**不校验节点状态**，未解锁节点同样命中（`frontend/AGENTS.md` 不变量 8）。

## 5. 输入与输出

- **输入**：`createHudMap({ ctx, cw, ch, dpr })`——`ctx` 为 Canvas 2D 上下文（页面已 `ctx.scale(dpr,dpr)`，`march.js:517`），`cw/ch` 为 CSS 尺寸；`setRoute(route)` 接收 `GET /api/march/route` 的响应对象（只读 `nodes/routeProgress/totalSteps/currentSteps`）。
- **输出**：无返回值、无事件回调；全部效果直接画进 `ctx`。页面与 automator 通过实例字段读状态（`view`/`nodePts`/`stars`/`trailDust`/`staticLayer`/`arriveFx` 等）。
- **导出**：`module.exports = { createHudMap }`（`:996`），单导出。

## 6. 依赖关系

- **require（2 个）**：`./routeCanvas`（`getCanvasNodePositions`/`sampleRoutePath`/`distToIndex`/`easeOutCubic`/`drawStar`/`drawRoundRect`/`createGlowSprite`，`:146`、`:126`、`:348-847` 各处、`:280-289`）、`../data/node-themes`（`getNodeTheme`，`:196` 区域粒子配置）。
- **wx API**：仅 `wx.createOffscreenCanvas`（`:265`，try/catch 内）。
- **被依赖**：仅 `pages/march/march.js:14`。
- **不依赖**：任何 `services/*`、Storage、`getApp()`、`setData`——内核无页面耦合（grep 实证零命中），这是它能被 automator `evaluate` 白盒断言的前提。

## 7. 业务规则

1. **帧内零分配**：星空/星尘/粒子全部构建期或 fx 创建期一次性生成；渐变按 endIdx/局部系缓存复用；标签宽度缓存。
2. **离屏降级**：`buildStatic` 的 try/catch 失败即 `staticLayer=null`，`draw` 回退每帧直绘 `paintScenery`——功能不中断（`frontend/AGENTS.md` 不变量 6）。
3. **画布重建即重置缓存**：`buildStatic` 入口重置 `_goldGrad/_goldGradIdx/_flagGrad`；`dispose` 释放全部离屏资源。
4. **入场/增量唯一判定在 `setRoute`**：页面不得自行重播入场动画（§3.5）。
5. **命中不拦截未解锁节点**（不变量 8）。

## 8. 修改约束

1. **页面与内核的边界不得反向**：内核不得 require service/读 Storage/`setData`；页面不得再持有绘制状态（`ctx` 除外的绘制字段都在 `hud` 上，automator 断言读 `page.hud.*`，四个套件 `p0-march`/`p1-starry-march`/`tabbar-starmap`/`s16-review-smoke` 已按此口径改写且不留兼容别名）。
2. **`routeCanvas.js` 只增不改**：`pages/ceremony/ceremony.js` 与 `pages/ticket/ticket.js` 共用该模块，改返回结构 `{path,dist,len,nodePathIndex}` 或 `createGlowSprite` 签名会同时击穿三处。
3. **`buildStatic` 的 try/catch 禁止删除**（`frontend/AGENTS.md`）。
4. **`view` 改写必须配 `clampView()`**：页面手势是唯一改写方，漏钳制会让场景拖出画布。
5. `node-themes` 的 `particleConfig.type` 枚举（snow/ember/mist/star）是跨文件硬契约，改枚举须同步 `drawRegionMotes` 四分支。
6. S3（深空 HUD 视觉重构 L0~L6）将重写 `paintScenery`/`drawRoute`/`drawNodes` 等绘制体并新增 `routeCanvas` 纯函数（只增）；改时保持本文件「状态+单帧绘制」的工厂形态与页面边界不变。

## 9. 当前实现状态

- **已实现**：星空模式全部绘制（静态 scenery、星空三层、区域粒子、金轨+彗尾+星尘、三态节点、进度旗、点亮动画）、观景变换与命中、离屏降级、释放链。2026-10-19 开发者工具自动化四套件全绿（`tabbar-starmap` 8/8、`p0-march` 6/6、`p1-starry-march` 4/4、`s16` 16/18，两条失败为预存 mock 登录配置漂移、不经本模块），关键数值与搬迁前基线逐项一致（view{1,0,0}/星尘 22/scale 2.50/pan(-220,-320)/命中点 (343,375)/粒子 14/far 110/mid 64），整帧耗时 1.40→0.61ms。报告 `frontend/test/docs/s30-hud-kernel-extract-report.md`。
- **已知事项**：① `regionMotes` 注释称「总量 30 封顶」但循环无封顶判断（每节点 3 颗 × 当前 10 节点恰为 30），节点增加时粒子数线性增长无代码级上限（搬迁前即如此）；② 每帧 `drawClouds` 建 3 次径向渐变，是帧内少数分配点（搬迁前即如此，S5 帧率降级时评估）；③ `draw(t)` 的 `t` 由页面传 `Date.now()/1000`，内核不自持时钟。
- **待开发**：S3 视觉重构（L0~L6）、S4 实时数据叠加层 `setStats`/`playFlyLine`、S5 帧率自适应降级（均已在方案中排期，尚未实现——勿当作既有功能引用）。

## 10. 迭代记录

### 2026-10-19（`2862453`）
- 需求：深空 HUD 科技感地图五阶段方案的 S2——把绘制逻辑从页面抽离为可独立演进、可白盒断言的渲染内核，为 S3 视觉重做固化「行为不变」基线。
- 修改内容：新建本文件（996 行），从 `pages/march/march.js` 纯搬迁全部星空绘制（`march.js` 1521→654 行）；魔数收敛为 `INTRO_MS/PROGRESS_MS/ARRIVE_FX_MS/PARTICLE_CAP`；入场/增量判定上移为 `setRoute` 内部逻辑；新增公开入口 `playArrive`。同批改写 4 个 automator 套件读 `page.hud.*`、同步 `frontend/AGENTS.md` 不变量 6 与 `frontend/design.md` §4.6。
- 测试结果：automator 四套件 `tabbar-starmap` 8/8、`p0-march` 6/6、`p1-starry-march` 4/4、`s16-review-smoke` 16/18（R7/R12 为预存 mock 登录 502 配置漂移）；与搬迁前基线逐项一致、截图逐图比对一致；`node --check` 全通过。报告 `frontend/test/docs/s30-hud-kernel-extract-report.md`；`docs/迭代记录.md` 的 `2862453` 条目。
