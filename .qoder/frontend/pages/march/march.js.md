# march.js（长征路线页 · 页面级合一）

> 按 `.qoder/README.md` §1「页面级合一」规则，本文档覆盖 `frontend/pages/march/` 四件套：`march.js`（1477 行，小程序最大单文件）、`march.wxml`（135 行）、`march.wxss`（529 行）、`march.json`（5 行）。WXML / WXSS / JSON 专章见 §4-1–§4-3。

## 1. 文件路径

`frontend/pages/march/march.js`、`march.wxml`、`march.wxss`、`march.json`

## 2. 文件职责

长征 Tab 主页面：展示路线总览（累计步数、点亮进度、当前章节卡），提供**双模式地图**——默认实景 `<map>`（后端下发经纬度 + markers/polyline）与 Canvas 2D「星空长征」插画地图（星形节点、星河轨迹、区域氛围粒子、点亮动画、全景手势）；承载开场动画（首次完整开场/非首次纱幕）、抵达事件卡队列播放与完成仪式跳转触发；下方为可点击的节点列表。数据全部来自 `services/march.js`（后端 `/march/route`、`/march/light-up`），页面不直接发请求、不直接读写 Storage（`frontend/AGENTS.md` §3.1）。

## 3. 业务需求

文件头 docstring（`march.js:1-11`）自引需求编号：星空长征视觉规则 §13.2（节点三态星形）、点亮动画 §13.3（亮起→扩大→粒子扩散→稳定发光）、星空全景 §13.4（拖动/捏合/双击复位、低开销 rAF）、开场动画 §5（首次完整播放可跳过、非首次快速纱幕，`:82-84` 注释）、区域氛围 §12（信息卡主题色 + 环境粒子，`:58`、`:633` 注释）、章节卡 §4.4（`:277` 注释）、抵达事件卡 §4.5（`:209` 注释）、轨迹推进 §3.5（`:264-265` 注释）、完成仪式 §20（`:176-178` 注释，§20.4 仅第一次）。双模式地图与 Canvas 清理约定是 `frontend/AGENTS.md` §4 不变量 6 的落点；「任意节点含未解锁可看历史」为不变量 8（`:10` docstring、`:1451`、`:1470` 注释）。

## 4. 核心功能

### 4.1 页面入口与生命周期

- **入口**：tabBar 第 2 个 tab「长征」（`frontend/app.json:49-52`，`pagePath: pages/march/march`），无其它页面 `navigateTo` 进入本页（tab 页只能 switchTab）。
- **无 `onLoad`/`onReady`**：全部初始化在 `onShow` 完成（`:70-79`）——① 登录守卫：`!app.globalData.loggedIn` 时 `wx.reLaunch('/pages/launch/launch')`（`:71-74`；tab 页同样自守卫，配合 `frontend/AGENTS.md` §4 不变量 5）；② `maybePlayIntro()`（`:75`）；③ 星空动画恢复：`this.ctx && this.routeData` 时 `startAnim()`（`:77`，注释说明 onHide 停掉了动画，先用已有路线恢复、刷新失败画面也不冻结）；④ `refresh()`（`:78`，满足不变量 1「onShow + refresh」）。
- **`onHide`（`:128-135`）**：递增 `_refreshRequestId` 作废在途刷新（`:129`）→ 清 4 个定时器（`:130-133`）→ `stopAnim()`（`:134`）。
- **`onUnload`（`:137-145`）**：同 onHide，另清 `_veilTimer`（`:142`）→ `stopAnim()`（`:144`）。

**定时器 / 动画 / 监听器全量盘点（逐一实读）**：

| # | 句柄 | 创建点 | onHide 清理 | onUnload 清理 | 其它清理点 | 说明 |
|---|---|---|---|---|---|---|
| 1 | `_introTimer` | `:90`（切走后重计时）、`:101`（首次，3350ms） | ✅ `:132`（清后置 null） | ✅ `:141` | `dismissIntro` `:112` | 开场动画自动结束 |
| 2 | `_veilTimer` | `:97`（560ms 纱幕） | ❌ **未清**（见 §9 第 1 条） | ✅ `:142` | 无 | 唯一未双清的定时器 |
| 3 | `_viewTimer` | `:500`（700ms 镜头俯冲第二段） | ✅ `:130` | ✅ `:139` | `playViewAnim` 入口先清 `:493` | 实景镜头动画 |
| 4 | `popupTimer` | arrivePopup 模块递归 setTimeout 回写（`.qoder/frontend/utils/arrivePopup.js.md` §4.3） | ✅ `:131` | ✅ `:140` | 模块内每卡播放前先清（同文档 §8.2 契约） | 抵达卡队列 |
| 5 | `_ceremonyTimer` | `:191`（延时 = `_popupMs`） | ✅ `:133`（清后置 null） | ✅ `:143`（清后置 null） | 回调内自清 `:192` | 仪式跳转 |
| 6 | `animId`（rAF 链） | `startAnim` `:695`（`canvas.requestAnimationFrame`）或 `:697`（降级 `setTimeout(loop,16)`） | ✅ `stopAnim()` `:134` | ✅ `stopAnim()` `:144` | `switchMode` `:365`、`startAnim` 自防双链 `:689` | `stopAnim` `:703-710` 双清 + `running=false` 兜底 `:692` |
| 7 | `arriveFx`（动画态） | `playArriveIfNeeded` `:222-226` | 随 rAF 停止而冻结 | 随页面销毁 | 2.4s 播完自清 `:756-757`；`switchMode` 置 null `:377` | 非定时器，帧驱动 |
| 8 | `progressAnim`（动画态） | `renderRoute` `:327` | 随 rAF 停止而冻结 | 随页面销毁 | 800ms 到期自清 `:349-351` | 帧驱动 |

事件监听器全部为 WXML 声明式绑定（tap/touch/marker 事件，§4-1），随页面销毁自动释放；**无 `wx.onXxx` 全局事件订阅、无 WebSocket 订阅**（`:12-16` require 清单即全部模块依赖，无 `services/ws.js`）。

### 4.2 数据刷新链 `refresh()`（`:149-173`）

并发竞态守卫：每次调用生成自增 `requestId` 写入 `this._refreshRequestId`（`:150-151`），两个 `.then` 各校验一次，不匹配即丢弃（`:159`、`:165`；`e70b59f` 引入，见 `.qoder/frontend/services/request.js.md` §4.9 末段「页面级并发竞态守卫在各页面自行实现」）。链路：

1. `march.lightUpNodes()`（`:156` → `POST /api/march/light-up`，`.qoder/frontend/services/march.js.md` §4.3）——幂等点亮达标节点，失败兜底为空数组（`:157`）；结果暂存 `this._pendingLit` / `this._pendingChapters`（`:160-161`）。
2. `march.getRoute()`（`:162` → `GET /api/march/route`）。
3. `renderRoute(route)` → `playArriveIfNeeded()` → `maybeStartCeremony(route)`（`:166-168`）。
4. 整链 `.catch` 静默：网络失败保留上一次渲染（`:170-172` 注释）；light-up 单独失败也兜底为空点亮结果继续拉路线（`:157`），即「点亮失败不阻塞路线展示」。

**步数同步不在本页**：本页 require 清单无 `services/sport.js`（`:12-16`）；微信运动同步链（授权→code→加密数据上送 `POST /sport/sync`）由首页触发（`.qoder/frontend/services/sport.js.md` §4.6），本页仅在 onShow 时经 light-up 消费其落库后的累计步数结果——这解释了「首页同步 → 切到长征 tab → onShow refresh 点亮」的跨页联动路径。

### 4.3 开场动画（§5，`:86-126`）

- `maybePlayIntro()`（`:86-102`）：模块实例标记 `_introChecked` 保证只判定一次；已判定过且开场仍在播（onHide 清掉定时器后回来）时重新计时 3350ms 自动结束（`:89-91`）。首次判定走 `march.hasPlayedIntro()`（`:95`，Storage 键 `lm_march_intro_played` 收归服务层，`.qoder/frontend/services/march.js.md` §4.6）：已播过 → `showVeil` 纱幕 + `_veilTimer` 560ms 后关闭（`:96-97`）；未播过 → `showIntro` + `_introTimer` 3350ms（`:100-101`）。
- `skipIntro()`（`:105-107`）→ `dismissIntro()`（`:110-126`）：清 `_introTimer`、`setData({showIntro:false})`、`march.markIntroPlayed()` 写标记（`:114`）；补播被开场压后的实景镜头动画 `playViewAnim`（`:115-118`）、抵达卡队列 `playArriveIfNeeded`（`:119`）、顺延的完成仪式 `_ceremonyRoute`（`:121-125`）。
- 3350ms 与 wxss `introFadeOut 0.45s ease 2.85s`（`march.wxss:453`）配合：2.85s 起淡出、3.3s 结束，留 50ms 余量。

### 4.4 路线渲染 `renderRoute(route)`（`:266-331`）

网络刷新与本地渲染共用同一入口（`:262` 注释），按 `data.mode` 分流：

- **公共段（`:267-291`）**：
  - 记旧进度 `prevProgress`（`:267-270`）→ `this.routeData = route`（`:271`，Canvas 每帧绘制一律读它，不变量 6）→ 建 `nodeIndex`（id→路线下标，供点亮特效/粒子定位，`:272-274`）。
  - 章节卡（§4.4 需求）：按 `route.currentChapterId` 匹配当前章，`finished` 且有章节时展示末章（`:277-280`）；`progressPct = Math.round(progress*100)` 预计算供 WXML 进度条（`:288-290`，遵守 `frontend/AGENTS.md` §5.2「WXML 不做原生调用」）。
  - `setData` 负载：`nodes` 经 `toViewNode` 裁剪为 6 字段（`:28-38`，注释「减小 setData 体积」，`e70b59f` 批次）+ 5 个进度标量 + `currentChapter`（`:281-291`）。
- **real 分支（`:293-315`）**：`buildMapData` 产出 markers/polylines（§4.5）；`selectedNode` 默认选中 current 节点，无 current 取首个非 completed，再兜底第一个（`:295-299`）；配 `nodeThemes` 生成信息卡主题样式与环境描述（`:300`、`:305-306`）；首次进入且不在开场中时播 `playViewAnim` 镜头俯冲（`_viewPlayed` 防重播，`:309-313`）。
- **canvas 分支（`:317-330`）**，仅 `this.ctx` 已存在（即已切过星空模式）时绘制：
  - 首次渲染（`prevProgress === null || !this.path`）→ `buildMap + buildStaticLayer + buildGlowSprites + animStart=Date.now()`，播完整入场描画（`:319-324`）；
  - 步数刷新 → 只建 `progressAnim = {from: 旧进度, to: calcRouteProgress(route), start}` 做约 800ms 增量推进（`:325-328`，§3.5「不重播完整地图动画」）；
  - 两分支末尾都 `startAnim()`（`:329`）。
- **进度换算**：`calcRouteProgress`（`:336-339`）优先取后端 `routeProgress`（钳制 0~1），旧接口降级为 `currentSteps/totalSteps`（后端统一计算见 `05180c2`，`.qoder/backend/app/api/routes/march.py.md` §4.5）；`currentRatio`（`:344-354`）在 `progressAnim` 期间按 `routeCanvas.easeOutCubic` 插值，800ms 到期自清并回到后端值（`:349-351`）。

### 4.5 实景地图模式（`:386-541`）

`buildMapData(route)`（`:386-487`）产出 `<map>` 组件数据，坐标取后端下发的 `node.latitude/longitude`（`:388-391`，**无前端硬编码坐标表**，见 §8.7）：

- **已完成轨迹 `donePts`**（`:394-413`）：逐节点累计（`cur >= targets[i]` 即收入），当前目标段内按步数比例线性插值出旗帜位置。
- **节点 markers**（`:415-439`）：每节点 16×16 默认图标 + `callout` 点击气泡（`display:'BYCLICK'`，completed ★金 / current ◎红 / unlocked ○灰三套配色 `:416-420`）；注释说明用点击气泡替代常驻 label，避免密集点位名称错位/重叠（`:415`）。
- **进度旗帜 marker**（`:442-461`）：未完成且有已行进段时追加 `id: 999` 的「🚩 我在这里」label marker。
- **polylines**（`:463-484`）：两条——灰色全程底 `#B9B2A4CC` width 5 + 金色已完成段 `#D4A017` width 7 带描边与箭头（`arrowLine: true`）。

其余函数：

- `playViewAnim()`（`:492-506`）：镜头俯冲两段式——先重置全国视野（lat 34.5 / lng 108.5 / scale 4，`:494-499`），`_viewTimer` 700ms 后 `setData includePoints` 收缩到全部节点包络（`:500-505`）。
- `handleMarkerTap`（`:512-523`）：点 marker 只选中节点并刷信息卡主题（不跳转，`:509` 注释），`nodeThemes.getNodeTheme/themeSoftStyle` 生成柔和主题样式与环境描述（`:517`、`:520-521`）。
- `handleCalloutTap`（`:528-532`）：点气泡直达 `node-detail?id=`。
- `goSelectedDetail`（`:537-541`）：信息卡「查看详情」按钮。
- 三个事件对 id=999 旗帜均忽略（`:514`、`:530`），且**不校验节点状态**——未解锁节点同样可选中/进详情（不变量 8）。

### 4.6 Canvas 星空模式：初始化与渲染管线

- **Canvas 类型（实测）**：WXML `<canvas type="2d" id="routeMap">`（`march.wxml:83-91`）；`initCanvas()`（`:545-575`）用 `wx.createSelectorQuery().select('#routeMap').fields({node:true,size:true})` 取节点后 `node.getContext('2d')`（`:546-558`），即 **Canvas 2D 新接口**，非旧版 `wx.createCanvasContext`（与 `.qoder/frontend/utils/routeCanvas.js.md` §4 的核实结论一致）。dpr 取 `wx.getSystemInfoSync().pixelRatio || 2`，画布物理尺寸 = CSS 尺寸 × dpr 并 `ctx.scale(dpr,dpr)`（`:553-559`）。初始化后依次 `buildMap → buildStaticLayer → buildGlowSprites → animStart → startAnim`（`:569-573`），并重置观景变换 `this.view = {scale:1, ox:0, oy:0}`（`:567`）。
- **`initCanvas` 的唯一调用点是 `switchMode`**（`:368`）：默认 real 模式不进 Canvas；切到星空时才建画布。`switchMode`（`:361-381`）切回 real 时先 `stopAnim()`（`:365`），并在 setData 回调里把 `ctx/canvas/staticLayer/glowGold/glowRed/arriveFx` 全部置 null（`:371-377`）——**其中 `:375-376` 正是 `routeCanvas.js.md` §8.4 记录的光晕精灵释放点，本次实读确认无误**（`this.glowGold = null; this.glowRed = null;`），随后用最新路线 `renderRoute` 重建实景 markers 并播镜头动画（`:378-379`）。
- **静态资源构建 `buildMap()`（`:580-657`）**——全部元素构建期一次性分配、帧内零分配（`:604-605`、`:634` 注释）：
  1. `routeCanvas.getCanvasNodePositions(nodes, cw, ch)` 经纬度→画布坐标归一化（`:583`）；
  2. `sampleRoutePath(nodePts, 30)` Catmull-Rom 平滑采样得 `path/pathDist/pathLen`（`:586-590`，每段 30 采样点）；
  3. 沿线星尘 `trailDust` 固定 22 颗（相位/频率各异，数量固定不随帧分配，`:592-602`）；
  4. 星空三层（`:604-631` 注释：远景静态烘焙进离屏层 / 中景错峰呼吸 / 近景亮星十字光芒）——`farStars` 110 颗（`:606-610`）、`stars` 64 颗其中前 9 颗为大星（`:611-629`），按颜色排序减少绘制期 fillStyle 切换（`:630-631`）；
  5. 区域氛围粒子 `regionMotes`：每节点 3 颗、读 `nodeThemes.getNodeTheme(node.id).particleConfig`（`:633-653`；注释称总量 30 封顶但代码无封顶判断，见 §9 第 3 条）；
  6. 节点名标签宽度缓存 `_labelW` 置空重建（`:655-656`）。
  星点位置由 `sampleSkyPoint(bandRatio)`（`:665-684`）采样：按概率落入左上→右中斜向银河带（近似高斯散布），其余均匀散布天空区（高度 72%），避让节点 16px 范围、最多重试 6 次。
- **离屏层与精灵**：`buildStaticLayer()`（`:816-832`）先重置渐变缓存 `_goldGrad/_goldGradIdx/_flagGrad`（`:818-820`，不变量 6「画布重建时重置」），再 `wx.createOffscreenCanvas({type:'2d'})` 烘焙 `paintScenery`，**整体 try/catch，失败置 `staticLayer=null` 降级为每帧直绘**（`:821-831`；禁止删除该 try/catch，`frontend/AGENTS.md` §6.5）。`buildGlowSprites()`（`:838-846`）经 `routeCanvas.createGlowSprite` 预渲染金/红两个 64px 径向光晕精灵（失败返回 null，消费处均判空，`:771`、`:1172`、`:1210`、`:1219`、`:1237`、`:1296`）。
- **动画循环**：`startAnim()`（`:688-701`）先 `stopAnim()` 防双链；循环体每帧 `draw(Date.now()/1000)`，续帧优先 `canvas.requestAnimationFrame`（Canvas 2D 节点级 rAF，`:694-695`），不可用时降级 `setTimeout(loop,16)`（`:697`）。`stopAnim()`（`:703-710`）置 `running=false`、`cancelAnimationFrame` + `clearTimeout` 双清、句柄置 undefined。**只在星空模式且页面前台时运转**：onHide/onUnload/switchMode/startAnim 四处都调 stopAnim（`:134`、`:144`、`:365`、`:689`）。
- **每帧 `draw(t)`（`:714-743`）**：`ctx.save` → 应用观景变换 `translate(ox,oy)+scale`（`:721-724`）→ 贴 `staticLayer` 离屏图（不可用时 clearRect + 直绘 `paintScenery` 降级，`:728-733`）→ 依次 `drawClouds/drawStars/drawRegionMotes/drawRoute/drawNodes/drawArriveFx/drawProgressFlag`（`:734-740`）→ `restore`。
- **静态 scenery `paintScenery(ctx)`（`:852-919`）**——只烘焙进离屏层（或降级时每帧直绘），按注释序号：① 夜空底色四段线性渐变（`:855-862`）；② 中心径向微光营造纵深（`:864-869`）；③ 42px 经纬网格（`:871-882`）；③.5 远景微星按两档亮度各合批一次 fill（`:884-895`）；④ 三层程序化山峦 `drawRidges`（`:897-898` 调用，`:922-957` 实现：纵向渐变填充+山脊高光线，正弦叠加生成山脊）；⑤ 金色双线边框四角描金 `drawFrame`（`:959-982`）+ 右上罗盘玫瑰 `drawCompass`（`:984-1011`，四向指针+N 字）；⑥ 虚线路线底（未完成部分引导线，`setLineDash([7,7])`，`:904-918`）。
- **动态层（每帧绘制，逐函数实读）**：
  - `drawClouds`（`:1014-1031`）：3 条薄雾椭圆带按 `CLOUDS` 常量（`:19-23`，相对坐标+尺度+速度）横向漂移循环，每帧各建一次径向渐变。
  - `drawStars`（`:1037-1064`）：逐星独立周期/相位错峰闪烁；`slow` 星用三次方曲线做「长时微暗→缓慢增亮→渐暗」呼吸（`:1042`）；大星（`glint`）随亮度轻微缩放并画十字光芒（`:1050-1061`）；色标取 `STAR_TINTS`（`:26`），同色合批减少 fillStyle 切换（`:1044-1047`，配合 `:631` 的构建期排序）。
  - `drawRegionMotes`（`:1070-1108`）：区域氛围粒子四分支——snow 循环下落+横向飘摆（`:1075-1082`）、ember 循环上升渐隐（`:1083-1090`）、mist 横向漂移柔光雾团（`:1091-1097`）、star 原地闪烁（`:1098-1104`）；分支枚举与 `node-themes.js` 的 `particleConfig.type` 绑定（`.qoder/frontend/data/node-themes.js.md` §8.3）。
  - `drawRoute`（`:1111-1196`）：已完成段长度 = `pathLen × currentRatio()`（含增量推进动画），再乘 1400ms 入场描画系数（`:1116-1119`）；金色渐变按 `endIdx` 缓存 `_goldGrad/_goldGradIdx`，仅变化时重建（`:1123-1132`，注释：入场结束后即固定，避免每帧 createLinearGradient）；外发光层一次 shadowBlur 描边 + 内核亮线（`:1133-1152`）；入场完成后 3 条流光彗尾沿已完成段循环，光点头复用金色光晕精灵（`:1155-1181`）；星尘 `trailDust` 仅已完成段内闪烁（`:1183-1195`）。
  - `drawNodes`（`:1199-1256`）：三态星形（§13.2）——completed=金色光晕呼吸+双层五角星旋转（`:1206-1216`）；current=柔和外发光+双脉冲扩散环+红色星形呼吸缩放（`:1217-1246`）；unlocked=暗色小星点（`:1247-1252`）；每节点带标签 `drawNodeLabel`（`:1259-1279`，深色圆角底衬+状态色文字，`_labelW` 缓存宽度避免每帧 measureText `:1264-1265`）。
  - `drawArriveFx`（`:750-810`）：见 §4.8。
  - `drawProgressFlag`（`:1282-1351`）：进度旗帜=基座呼吸光晕（复用金色精灵 `:1296-1301`）+3 颗循环上升光尘（`:1303-1311`）+旗杆旗面随路线切线方向摆动（`:1314-1336`），旗面渐变 `_flagGrad` 创建一次复用（`:1337-1344` 注释「渐变坐标固定（局部系）」），旗上金星 `:1346-1349`；`currentSteps<=0` 或路径不足 2 点时不画（`:1285`）。
- **重绘时机小结**：
  - 星空模式 + 页面前台 → rAF 持续逐帧重绘（星闪/呼吸/彗尾等需持续动画，`:9` docstring「仅当前节点持续动画，保证 rAF 低开销」）；onHide/onUnload/切回实景即停（§4.1 盘点表 #6）。
  - 数据变化不直接触发重绘：`renderRoute` 只更新 `routeData/progressAnim` 等实例属性，由下一帧的 `draw` 自然读取（不变量 6「每帧绘制一律读 this.routeData」）。
  - real 模式无 Canvas 绘制，视图更新全部由 setData 驱动 `<map>` 与列表。
  - 画布尺寸固定 750×860rpx（`march.wxss:126-130`），**无 resize 监听、无页面 scroll 监听**；星空「视口」交互全部由 `view` 变换 + touch 手势承担（§4.7），页面本身随外层原生滚动。

### 4.7 星空全景手势（§13.4，`:1362-1467`）

- `clampView`（`:1363-1369`）：缩放钳制 1~2.5 倍，平移不使场景离开画布。`resetView`（`:1371-1373`）。
- `onMapTouchStart`（`:1375-1392`）：单指建 pan 手势（记起点/当前偏移/时间），双指建 pinch（记初始指距/缩放/中心锚点）。
- `onMapTouchMove`（`:1394-1429`）：pan 位移超 6px 判 moved 后平移+钳制；pinch 以双指中心为锚点缩放（保持锚点场景坐标不动，`:1420-1425`）；单指转双指时重新锚定基准避免跳变（`:1410-1417`）。
- `onMapTouchEnd`（`:1431-1448`）：干净单指轻点（未移动且 <350ms）→ 300ms 内二连击 `resetView`（`:1440-1444`），否则 `hitNode`。
- `hitNode`（`:1453-1467`）：屏幕坐标按 `view` 逆变换到场景坐标，命中半径 `22/scale` 保持屏幕恒定（`:1458`），命中即 `navigateTo node-detail?id=`——含未解锁节点（`:1451` 注释，不变量 8）。

### 4.8 节点点亮动画链与完成仪式

**点亮链（步数同步 → light-up → 弹窗 → 重绘）**：首页同步步数落库（`.qoder/frontend/services/sport.js.md` §4.6）→ 本页 onShow `refresh()` 调 `POST /march/light-up`（后端幂等判定与 `newlyLit/newlyCompletedChapters/newMedals` 三段返回见 `.qoder/backend/app/api/routes/march.py.md` §4.3）→ `playArriveIfNeeded()`（`:212-230`）：开场期间暂缓由 `dismissIntro` 补播（`:214`）；消费并清空 `_pendingLit/_pendingChapters`（`:215-218`）；星空模式下建 `arriveFx = {ids, start, particles}`（`:221-227`）；`this._popupMs = arrivePopup.playArriveQueue(this, lit, chapters)`（`:229`，队列播放器写 `data.litPopup` 与 `page.popupTimer`，返回总时长，`.qoder/frontend/utils/arrivePopup.js.md` §4.3）。

- `makeArriveParticles(ids)`（`:236-259`）：fx 创建时一次性生成，每节点 14 颗（光晕精灵不可用的低端设备减半为 6），总量 `CAP=64` 封顶（`:238-239`），避免 rAF 帧内分配（`:234` 注释）。
- `drawArriveFx()`（`:750-810`）：约 2.4s 的「亮起（0.6s 渐入）→ 扩大（1.2s bump 至 1.9 倍）→ 两层扩散金环 → 粒子抛物扩散渐隐（生命 0.9s）」；播完自清 `this.arriveFx = null`（`:756-757`），节点回到常态呼吸无跳变（`:748` 注释）。
- **完成仪式（§20）`maybeStartCeremony(route)`（`:180-196`）**，逐步：
  1. 触发条件：后端 `GET /march/route` 下发 `ceremonyPending=true`（全部点亮且未观看时才有，`.qoder/backend/app/api/routes/march.py.md` §4.4），否则直接 return（`:181`）。
  2. 开场播放中 → 存入 `_ceremonyRoute` 顺延，由 `dismissIntro` 再触发（`:182-185`、`:121-125`）。
  3. `_ceremonyStarted` 或 `_ceremonyTimer` 已存在则不重复安排（`:186-188`）；定时器被 onHide 取消（切 tab）时允许下次 onShow 经 refresh 重新安排（`:186-187` 注释）。
  4. 延时 = 抵达卡队列总时长 `_popupMs`（消费后置 0，`:189-190`），保证 §20.2「事件卡队列播完再进仪式」（`:228` 注释）。
  5. 到点置 `_ceremonyStarted=true` 并 `wx.navigateTo('/pages/ceremony/ceremony')`（`:191-195`）——**本页生命周期内只自动触发一次**（`:178` 注释，用户中途返回不循环跳转；tab 页常驻不 unload，故返回后不再自动跳）。
  6. 已观看标记由仪式页调 `markCeremony` 向后端落库（`.qoder/frontend/services/march.js.md` §4.5），本页只消费 `ceremonyPending` 不写入。
- `goCeremony()`（`:201-204`）：`finished` 时头部横幅（`march.wxml:38`）手动进仪式页复看（§20.4）。

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
2. `<canvas type="2d" id="routeMap">` 与 `<map>` 用 `wx:if="{{mode === 'real'}}"` / `wx:else` 互斥（`:69`、`:84`）——切回实景时 canvas 节点被移除，这正是 `switchMode` 必须释放画布资源的原因（`march.js:371` 注释）；三个 touch 事件绑定全景手势（`:88-90`）。
3. `map-hint` 提示条按模式切换文案（`:92`，实景「点击地图节点查看信息…」/星空「拖动/双指缩放…双击复位」）。
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

仅 3 项页面配置：`navigationBarTitleText: "长征路线"`、`navigationBarBackgroundColor: "#C8102E"`、`navigationBarTextStyle: "white"`（`march.json:2-4`）。无 `usingComponents`（页面不用自定义组件）、无 `disableScroll`/`enablePullDownRefresh` 等其它配置。页面注册与 tabBar 配置在 `frontend/app.json`（`:5`、`:49-52`），符合 `frontend/AGENTS.md` §5.3「page.json 只声明页面自己的配置」。

## 5. 输入与输出

**`data` 状态字段（按关注点分组，`:41-68`）**：

| 分组 | 字段 | 说明 |
|---|---|---|
| 路线/进度 | `nodes`、`currentSteps`、`totalSteps`、`litCount`、`totalCount`、`finished`、`currentChapter` | 由 `renderRoute` 的 patch 一次性 setData（`:281-291`）；`nodes` 为 `toViewNode` 裁剪后的 6 字段视图对象 |
| 实景地图 | `mode`（'real'/'canvas'）、`mapLat`/`mapLng`/`mapScale`（初始 34.5/108.5/4）、`includePoints`、`markers`、`polylines`、`selectedNode`、`selectedThemeStyle`、`selectedThemeEnv` | 仅 real 模式消费；`selectedTheme*` 为 §12 区域氛围内联样式/文案 |
| 动画/弹层 | `showIntro`、`showVeil`、`litPopup` | 开场/纱幕/抵达卡；`litPopup` 由 arrivePopup 模块经 `setData` 写入 |

**实例属性（非 data、不走 setData，均挂 Page 实例）**：

| 分组 | 属性 | 写入点 |
|---|---|---|
| 路线快照 | `routeData`、`nodeIndex` | `renderRoute` `:271`、`:273-274` |
| Canvas 基础 | `canvas`、`ctx`、`cw`、`ch`、`dpr` | `initCanvas` `:561-565`；`switchMode` 切回 real 时置 null `:372-373` |
| 观景/手势 | `view`（scale/ox/oy）、`_gesture`、`_lastTap` | `:567`、`:1372`、`:1378/:1384`、`:1440-1445` |
| 路线几何 | `nodePts`、`path`、`pathDist`、`pathLen` | `buildMap` `:583-590` |
| 构建期元素 | `trailDust`、`farStars`、`stars`、`regionMotes`、`_labelW` | `buildMap` `:594-656` |
| 离屏资源 | `staticLayer`、`glowGold`、`glowRed` | `buildStaticLayer` `:827/:830`、`buildGlowSprites` `:844-845`；释放 `:374-376` |
| 渐变缓存 | `_goldGrad`、`_goldGradIdx`、`_flagGrad` | 重置 `:818-820`；懒建 `:1124-1131`、`:1338-1343` |
| 动画态 | `animStart`、`animId`、`running`、`arriveFx`、`progressAnim` | §4.1 盘点表 #6-8 |
| 流程态 | `_refreshRequestId`、`_pendingLit`、`_pendingChapters`、`_popupMs`、`_introChecked`、`_viewPlayed`、`_ceremonyStarted`、`_ceremonyRoute` | §4.2、§4.3、§4.8 |

**页面跳转出口**：`node-detail?id=`（4 处：`:531`、`:540`、`:1463`、`:1475`）、`ceremony`（`:194`、`:203`）、`launch`（未登录 reLaunch，`:72`）。

**事件处理一览（WXML 绑定 → js）**：`skipIntro`、`goCeremony`、`switchMode`、`handleMarkerTap`、`handleCalloutTap`、`goSelectedDetail`、`onMapTouchStart/Move/End`、`handleNodeTap`。

## 6. 依赖关系

- **require（`:12-16`，全部 4 个）**：`services/march.js`（`lightUpNodes/getRoute/hasPlayedIntro/markIntroPlayed` 四个函数被调用：`:95`、`:114`、`:156`、`:162`；该服务 8 个导出中本页用 4 个，`.qoder/frontend/services/march.js.md` §4）、`utils/arrivePopup.js`（`playArriveQueue`，`:229`）、`utils/routeCanvas.js`（7 个导出全用：`getCanvasNodePositions:583`、`sampleRoutePath:587`、`easeOutCubic:353/:760/:1119`、`drawStar:778` 等 7 处、`drawRoundRect:1268`、`createGlowSprite:844-845`、`distToIndex:1357`，清单见 `.qoder/frontend/utils/routeCanvas.js.md` §6）、`data/node-themes.js`（`getNodeTheme/themeSoftStyle`，`:300`、`:305`、`:517`、`:520`、`:639`）。
- **wx API**：`createSelectorQuery`、`getSystemInfoSync`（`:553`）、`createOffscreenCanvas`（`:823`，try/catch 内）、`reLaunch/navigateTo/setData/setTimeout`。
- **后端路径（经服务层）**：`GET /api/march/route`、`POST /api/march/light-up`（`.qoder/backend/app/api/routes/march.py.md` §4.1；service 层规则见 `.qoder/backend/app/services/march_service.py.md`）。
- **不依赖**：`services/sport.js`（步数同步在首页）、`services/ws.js`（**本页无 WebSocket 订阅**，`:12-16` 的 require 清单即全部依赖）。
- **被依赖**：`frontend/app.json` tabBar 注册；无其它页面 require 本页。

## 7. 业务规则

1. **onShow + refresh**（不变量 1）：每次显隐都重走 light-up → route 链；`_refreshRequestId` 保证旧响应不覆盖新响应（`:150-165`）。
2. **登录守卫**：onShow 检查 `app.globalData.loggedIn`，未登录 reLaunch 启动页（`:71-74`）。
3. **任意节点可看历史**（不变量 8）：列表点击、Canvas 命中、marker 点选、气泡直达四条入口均不拦截未解锁节点。
4. **轨迹推进分级**（§3.5）：首次渲染播 1400ms 完整入场描画 + 实景镜头俯冲各一次（`_viewPlayed` 防重播，`:115-118`、`:310-313`）；此后步数刷新只做 800ms 增量推进（`:325-328`）。
5. **点亮动画只由 light-up 响应驱动**：已点亮节点点击仅看详情、不重播动画（`:210` 注释）。
6. **两个「仅首次」标记存储位置不同**：开场动画标记在本地 Storage（换设备重播）；完成仪式 `ceremonyPending` 由后端持久化判定（换设备不重播），本页只消费不写入（`.qoder/frontend/services/march.js.md` §7.4）。
7. **仪式跳转排队规则**（§20.2）：开场动画 > 抵达卡队列 > 仪式跳转，依次顺延（`:182-185`、`:189-190`）；页面生命周期内自动触发仅一次（`:188`、`:193`）。
8. **性能预算**（§13.4 + 根 `agents.md` §2.4）：星空元素构建期一次性分配（星尘 22 / 远星 110 / 闪星 64 / 氛围粒子每节点 3）、点亮粒子每节点 14（低端 6）总量 64 封顶、静态层离屏烘焙、金轨渐变按 endIdx 缓存、标签宽度缓存、setData 负载经 `toViewNode` 裁剪。
9. **V2.0 积分口径**：点亮不发放积分、抵达卡不含积分字段（`.qoder/frontend/services/march.js.md` §7.2；`44eb77b` 同批删除了本页弹层积分展示，见 §10）。

## 8. 修改约束

1. **不变量 6 全部适用**（`frontend/AGENTS.md` §4）：每帧绘制读 `this.routeData`；静态元素只在 `buildStaticLayer` 烘焙一次；`_goldGrad/_flagGrad` 与光晕精灵在画布重建时重置（`:818-820`、`:375-376`）；离屏画布调用必须保留 try/catch 降级（`:821-831`，§6.5 明令禁删）。
2. `popupTimer` / `data.litPopup` 属性名是与 arrivePopup 模块的清理契约（`.qoder/frontend/utils/arrivePopup.js.md` §8.2），onHide/onUnload 按此名 clearTimeout（`:131`、`:140`）。
3. `routeCanvas` 返回结构 `{path,dist,len,nodePathIndex}` 与 `node-themes` 的 `particleConfig.type` 枚举是跨文件硬契约（`.qoder/frontend/utils/routeCanvas.js.md` §8.2、`.qoder/frontend/data/node-themes.js.md` §8.3），改字段须同步本页 `:587` 解构与 `:1075-1104` 分支。
4. light-up/route 响应字段（`newlyLit/newlyCompletedChapters/routeProgress/chapters/currentChapterId/ceremonyPending/finished`）是后端 camelCase 契约（`.qoder/backend/app/api/routes/march.py.md` §8.2），增删须双端同步。
5. `<map>` 的 `polyline` 属性名、`wx:key="id"`、WXML 禁原生方法调用等遵守 `frontend/AGENTS.md` §5.2。
6. 新增定时器/动画必须同时挂入 onHide 与 onUnload 清理（本页既有 5 个定时器 + 1 个 rAF 链全部双清，`_veilTimer` 例外见 §9 第 1 条，勿再扩大例外）。
7. `frontend/AGENTS.md` §4 不变量 6 提到的「真实经纬度 `NODE_COORDS`」静态坐标表**在现行代码中不存在**（全 `frontend/` grep 零命中；坐标由 `/march/route` 下发，`march.js:388-391`，`.qoder/backend/app/api/routes/march.py.md` §8.5 同结论）——该不变量措辞滞后，按代码事实理解，勿据此恢复硬编码坐标。

## 9. 当前实现状态

- **已实现**：双模式地图、开场动画、章节卡、抵达卡队列、星空点亮动画与全景手势、完成仪式触发、增量轨迹推进、并发刷新守卫；15 个提交演进见 §10。
- **存在问题 / 已知事项（逐条实读取证）**：
  1. **`_veilTimer` 未在 `onHide` 清理**：onHide 清了 `_viewTimer/popupTimer/_introTimer/_ceremonyTimer`（`:130-133`）但没有 `_veilTimer`，仅 `onUnload` 清（`:142`）。纱幕 560ms 内切走 tab 时定时器仍会触发一次 `setData({showVeil:false})`（`:97`）——影响极小（单次、幂等），但与本页「定时器双清」惯例不对称，属轻微泄漏点。
  2. **`stopAnim` 混用两种句柄空间**：`:705-708` 对同一 `animId` 先 `canvas.cancelAnimationFrame` 再 `clearTimeout`——rAF 句柄传给 clearTimeout（或反之）是无效操作但无害；现状能正确停链（`running=false` 兜底 `:692`），非缺陷，记录为事实。
  3. **`regionMotes` 注释与代码不一致**：`:633-634` 注释称「总量 30 封顶」，但 `:636-653` 循环无封顶判断（每节点 3 颗 × 当前 10 节点恰为 30）；后端若增加节点，粒子数将随节点数线性增长而无代码级上限。
  4. **无 `onLoad`**：全部逻辑挂 onShow，首次进入即触发一次完整 light-up + route 请求；属设计选择（tab 页复用），非缺陷。
  5. `wx.getSystemInfoSync()`（`:553`）为微信已标记废弃的同步接口——现状可用，未迁移 `wx.getWindowInfo` 等新接口，是否迁移**待确认**。
  6. **WebSocket**：本页不订阅任何 WS 消息（§6），故生产环境 wss 不可用的阻塞问题（已登记为 `.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1 项与第 2 项）**不影响本页**；路线渲染与完成仪式链路全部走 REST。
  7. 抵达卡弹层无点击关闭绑定（`march.wxml:17-32` 遮罩层无 bindtap），只能等队列自动播完——现状行为，是否符合预期**待确认**。
- **待开发**：无（本页范围内）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/march/march.js`（13 个提交）+ `git log --oneline -- frontend/pages/march/`（四件套合计 15 个提交，另 2 个只动 wxml/wxss）；全部 15 个提交号在 `docs/迭代记录.md` 均有对应条目（逐一 grep 核实）。按时间倒序、按主题归并；未逐行核对 diff 的条目以提交信息为据并注明。

### 2026-10-15（`9c84954`、`50aef7d`）
- 需求：视觉缺陷修复与星空地图优化。
- 修改内容：`9c84954` 仅改 `march.wxml`（节点状态徽章 text 内换行渲染空行，收为单行，git stat 实测 1 文件 +1/-3）；`50aef7d` 改 `march.js`（星空地图分层错峰闪烁、加强当前节点柔光——对应现行 `drawStars` slow 星三次方呼吸 `:1042` 与 current 节点柔光 `:1219-1224`）并同批交付 tabBar 图标。
- 测试结果：见 `docs/迭代记录.md` 的 `9c84954`、`50aef7d` 条目。

### 2026-10-13（`44eb77b`）
- 需求：V2.0 小程序批次（答题限时/积分排行/活动拦截等）。
- 修改内容（涉本四件套，git stat 实测仅 wxml/wxss）：删除抵达卡弹层的积分展示（wxml -1 行、wxss -10 行；口径见 `.qoder/frontend/services/march.js.md` §7.2「点亮不再发放积分」）。
- 测试结果：提交信息自述「新增 v2 自动化验收（14/14）与报告」；细节见 `docs/迭代记录.md` 的 `44eb77b` 条目。

### 2026-10-11（`e70b59f`、`01e214a`）
- 需求：小程序代码审查修复批次；V1.0 启动页自动登录。
- 修改内容（涉本文件）：`e70b59f` 落地并发请求守卫 `_refreshRequestId`、onShow 动画恢复（`:77`）、登录守卫与计时器清理（onHide/onUnload 现行结构）、`toViewNode` 精简 setData、消费 arrivePopup 返回时长 `_popupMs`（关联文件清单与逐项见 `docs/迭代记录.md` 的 `e70b59f` 条目及 `.qoder/frontend/utils/arrivePopup.js.md` §10）；`01e214a` 同批取消强制选组织（本页 diff 未逐行核对，以提交信息为据）。
- 测试结果：见 `docs/迭代记录.md` 对应条目。

### 2026-10-04（`79004f1`）
- 需求：区域氛围与长征完成仪式（P2-2，需求 §12/§20）。
- 修改内容（涉本文件）：接入 `node-themes` 主题（选中卡柔和样式 + 星空环境粒子）、`maybeStartCeremony/goCeremony` 仪式触发链、完成横幅；同批新建 `routeCanvas.js`（从本页抽取共享画布纯函数）与 ceremony 页（`.qoder/frontend/utils/routeCanvas.js.md` §10、`.qoder/frontend/data/node-themes.js.md` §10）。
- 测试结果：见 `docs/迭代记录.md` 的 `79004f1` 条目（automator `p2-theme-ceremony.cjs`）。

### 2026-10-03（`54e5ec5`）
- 需求：星空长征模式升级（P1-5，需求 §13）。
- 修改内容（涉本文件）：节点星形化、点亮粒子动画、星图拖动/捏合缩放/双击复位（现行 §4.6-§4.8 星空管线的主体；diff 未逐行核对，以提交信息为据）。
- 测试结果：见 `docs/迭代记录.md` 的 `54e5ec5` 条目。

### 2026-10-02（`a6b59f5`、`6a2fae3`、`05180c2`、`7e587c9`）
- 需求：开场动画（P0-4，§5）；章节系统（P0-3，§4）；行军轨迹进度后端化；页面高级化升级。
- 修改内容（涉本文件）：`a6b59f5` 首次完整开场 + 非首次 500ms 纱幕（现行 `maybePlayIntro/dismissIntro`）；`6a2fae3` 章节卡与章节完成仪式卡队列（`currentChapter`、arrivePopup 接入）；`05180c2` 步数刷新改增量动画推进、进度改读后端 `routeProgress`（现行 `calcRouteProgress/progressAnim`）；`7e587c9` 到达动画等页面升级（diff 未逐行核对，以提交信息为据）。
- 测试结果：见 `docs/迭代记录.md` 对应条目（`6a2fae3` 条目据提交信息含后端冒烟 10/10、automator 3/3）。

### 2026-10-01（`6a24562`、`b0fd8b2`）
- 需求：服务层由本地 Mock 切换为后端真实接口。
- 修改内容（涉本文件）：页面改异步加载并补错误提示（现行 `refresh()` 链的前身；两提交具体 diff 未逐行核对，以提交信息为据）。
- 测试结果：见 `docs/迭代记录.md` 对应条目。

### 2026-09-30（`b0ba252`、`a94e685`）
- 需求：`a94e685` 仓库初始化创建本页；`b0ba252` 强制已登录用户完成组织选择（该强制流程后被 `01e214a`「取消强制选组织」撤销，见 `.qoder/frontend/services/march.js.md` §10 同日记录）。
- 修改内容（涉本文件）：init 时点形态未逐行核对，以提交信息为据。
- 测试结果：`docs/迭代记录.md` 对应条目。
