# ceremony.js（长征完成仪式 · 页面级合一：ceremony.js / ceremony.wxml / ceremony.wxss / ceremony.json）

## 1. 文件路径

- `frontend/pages/ceremony/ceremony.js`（430 行）
- `frontend/pages/ceremony/ceremony.wxml`（40 行）
- `frontend/pages/ceremony/ceremony.wxss`（91 行）
- `frontend/pages/ceremony/ceremony.json`（6 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

长征完成仪式页（需求 §20，`ceremony.js:1-8` 头注释）：全屏 Canvas 2D 深色星空下播放约 8.1 秒的完成仪式动画（最后一段路线推进 → 末节点点亮发光 → 金线扫过全程 → 全节点齐亮脉冲 → 星空展开 →「我的长征 / 完成了」→ 完成数据卡）；**仅首次完成播放完整动画**（后端下发 `route.ceremonyPending` 决定，`:5` 注释），观看确认后调 `POST /api/march/ceremony` 落库标记，之后再进只静态展示「已完成长征」+ 完成数据（回顾态，`:6` 注释、`:124-128`）。

**入口证据**（grep `pages/ceremony/` 全仓核实，页面注册于 `frontend/app.json:21`）：唯一业务入口是长征 tab 页，两处均 `wx.navigateTo` 且**不带任何 query 参数**——数据由本页 onLoad 自行拉取：

1. `frontend/pages/march/march.js:180-196` `maybeStartCeremony(route)`：路线数据含 `ceremonyPending` 时自动触发，`setTimeout` 延迟（等待到达弹层播完，`_popupMs`，`:189-195`）后跳转；march 页生命周期内只自动触发一次（`_ceremonyStarted` 防重入，`:188` 注释、`:193`）。
2. `frontend/pages/march/march.js:201-204` `goCeremony()`：完成横幅手动入口，仅 `finished` 时可点（`:202`）。

另有 automator 测试直接 reLaunch/navigateTo 本页（`frontend/test/automator/p2-theme-ceremony.cjs:213`、`:237`、`frontend/test/automator/s16-review-smoke.cjs:138`）。

**四件套关系**：js 承载全部状态与 Canvas 绘制逻辑；wxml 只有「画布/快照 + 跳过按钮 + 数据卡」三个受 `data` 驱动的挂载点（§4-1），动画本体不经 WXML；wxss 负责深空主题与数据卡升起动画（§4-2），与画布内绘制互不重叠；json 以深色导航栏 + `disableScroll` 保证全屏沉浸（§4-3）。`frontend/design.md:50-65` 页面清单表对本页有一段概述（时间轴/数据来源/快照机制），细节以本文档与源码为准。

## 3. 业务需求

- 需求 §20.2（动画流程）、§20.3（完成数据卡）、§20.4（仅第一次完成触发完整动画、观看后标记）——出处标注见 `ceremony.js:1-8` 头注释与 `:121`、`:125`、`:418` 行内注释。
- `79004f1`（2026-10-04）「区域氛围与长征完成仪式（P2-2）」创建本页与后端 `POST /api/march/ceremony`、`ceremonyPending` 字段（`docs/迭代记录.md` 的 `79004f1` 条目；后端侧见 `.qoder/backend/app/api/routes/march.py.md` §10）。
- `e70b59f`（2026-10-11）代码审查批次：离屏光晕精灵抽到 `routeCanvas.createGlowSprite` 共用（`.qoder/frontend/utils/routeCanvas.js.md` §10，其关联文件列有本页）。
- `01e214a`（2026-10-11）启动页自动登录批次触及本目录（`git log --follow`）；对本页的具体 diff 未逐行核对，现行 onLoad 登录守卫形态（`:41-44` reLaunch 启动页）与该批次主题一致，以提交信息为据。

## 4. 核心功能（ceremony.js）

### 4.1 仪式时间轴常量 `TL`（`:15-24`，单位秒）

| 常量 | 时刻 | 阶段（对应需求 §20.2 步骤） |
|---|---|---|
| `SEG_END` | 1.2 | 最后一段路线推进（drawFrame `:275-279`） |
| `GLOW_END` | 2.6 | 末节点点亮发光：扩散环 + 粒子（`:352-382`） |
| `SWEEP_END` | 5.0 | 整条路线金线扫过点亮（`:280-285`） |
| `PULSE_END` | 5.8 | 全节点齐亮脉冲（`:316-317`） |
| `STARS_END` | 7.0 | 星空展开（追加 50 颗星 + 背景提亮，`:259`、`:272-273`） |
| `TEXT2_AT` | 7.5 | 第二行文字「完成了」淡入 + DOM 侧 `showFinalText`（`:219-220`、`:394-399`） |
| `STATS_AT` | 8.1 | 完成数据卡升起 + 收尾快照（`:216-218`） |

时间轴以 `Date.now() - this._startAt` 的真实秒数推进（`:192`），切后台回来续播不跳变（`:86` 注释）。

### 4.2 `data` 状态字段（`:27-38`，按关注点分组）

| 分组 | 字段 | 说明 |
|---|---|---|
| 加载/模式 | `ready`（`:28`）、`pending`（`:29`） | 数据就绪；是否首次仪式（false = 回顾态） |
| 动画阶段 | `phase`（`:30`，anim→done）、`showFinalText`（`:31`）、`showStats`（`:32`） | 由 `tickTimeline`/`skipAnim`/回顾态分支切换 |
| 完成数据 | `stats`（`:33`） | `buildStats` 产物（§4.8） |
| 画布快照 | `sceneShot`（`:36`）、`coverCanvas`（`:37`） | 收尾后最终帧静态图路径与「以图代布」开关（`:34-35` 注释：规避 canvas 原生层在开发者工具中覆盖 DOM 的问题） |

页面实例属性（非 data，均在 `initScene`/`buildScene`/`startLoop` 挂到 `this`）：`_route`（`:52`）、`_canvas`/`_ctx`/`_cw`/`_ch`（`:115-118`）、`_startAt`（`:122`）、`_animId`/`running`（`:196`/`:198`/`:201`）、`_finalized`（`:230`）、`nodePts`/`path`/`pathDist`/`pathLen`/`nodePathIndex`（`:140-148`）、`_skyGrads`/`_glow`（`:151-152`）、`starsBase`/`starsMore`（`:168-169`）、`burst`（`:173`）。其中 `pathDist`、`pathLen` 赋值后全文再无读取（仅 `:146-147` 两处），属冗余保留字段（现状事实，见 §9）。

### 4.3 生命周期

- **`onLoad`（`:40-65`）**：① 登录守卫：`app.globalData.loggedIn` 为假即 `wx.reLaunch('/pages/launch/launch')` 并 return（`:41-44`，`frontend/AGENTS.md` §4 不变量 5）；② `Promise.all([march.getRoute(), profile.getSummary().catch(() => null)])`（`:45`，档案失败降级为 null 不阻塞）；③ 路线未完成（`!route.finished`）→ toast「长征尚未完成」+ 800ms 后 `navigateBack`（`:47-50`）；④ 成功 → 存 `_route`、按 `ceremonyPending` 置 `pending`、`buildStats`、`initScene()`（`:52-59`）；⑤ 请求失败 → toast「加载失败」+ 800ms `navigateBack`（`:61-64`）。两个 800ms `setTimeout` 未存句柄、卸载不清理（§9）。
- **`onShow`（`:85-88`）**：仅做动画续播——`_ctx` 存在且 `pending` 且未收尾（`!_finalized`）时 `startLoop()`（`:87`）；不重拉数据（一次性仪式页，非数据展示页）。
- **`onHide`（`:90-92`）与 `onUnload`（`:94-96`）**：内容相同，都只调 `stopScene()`（停帧，§4.5）；**不释放 `_glow`/`_canvas` 等资源引用**——这是 `.qoder/frontend/utils/routeCanvas.js.md` §9 问题 1 留待本页核查的开放问题，定论见 §8.1 与 §9。

### 4.4 场景构建：`initScene`（`:100-130`）与 `buildScene`（`:132-186`）

- `initScene`：取窗口宽高（`wx.getSystemInfoSync`，`:101-103`），`createSelectorQuery` 取 `#ceremonyCanvas` 节点，按 dpr 放大画布物理尺寸并 `ctx.scale(dpr, dpr)`（`:110-114`）；随后 `buildScene()`，并按 `pending` 分流：首次 → 记 `_startAt` 并 `startLoop()`（`:120-123`）；回顾态 → 直接 `setData({phase:'done', showFinalText:true, showStats:true})` + `finalizeScene()`（`:124-128`）。查询无结果（节点未渲染）时静默 return（`:108`）。
- `buildScene`（`:132` 注释「构建期固定资源…帧内零分配」）：
  - 路线布局：`routeCanvas.getCanvasNodePositions(nodes, cw, ch*0.58)` 后整体下移 `ch*0.06`（`:138-143`，上部 58% 留给路线、下方留文字与数据卡）；`routeCanvas.sampleRoutePath(nodePts, 30)` 取 Catmull-Rom 采样（`:144-148`，返回结构契约见 `.qoder/frontend/utils/routeCanvas.js.md` §8.2）。
  - 渐变缓存 `_skyGrads = {}` 与光晕精灵 `_glow = routeCanvas.createGlowSprite([...金色两档色标])`（`:150-152`）——`createGlowSprite` 内部 try/catch、低版本基础库返回 null（routeCanvas.js.md §4.4），本页绘制侧有 `if (this._glow)` 判空 + 径向渐变直绘降级（`:330-338`）。
  - 星点：基础 70 颗 + 展开阶段追加 50 颗（`:154-169`，位置/半径/相位/频率随机，构建期一次生成）。
  - 末节点点亮粒子 `burst`：26 颗，从最后节点位置随机角度/速度抛出（`:171-185`，`:171` 注释「§13.3 同规格」）。

### 4.5 动画循环与清理：`startLoop`（`:188-203`）/ `stopScene`（`:205-212`）/ `tickTimeline`（`:214-222`）

- `startLoop`：先 `stopScene()` 防双循环（`:189`）；每帧按真实时间 `t` 调 `drawFrame(t)` + `tickTimeline(t)`，续帧优先 `canvas.requestAnimationFrame`、无则 `setTimeout(loop, 16)` 兜底（`:195-199`），句柄统一存 `this._animId`；`running` 标志位（`:201`）+ 循环头部 `!this.running || !this._ctx` 双保险退出（`:191`）。
- `stopScene`：置 `running=false`，`_animId` 存在时既 `cancelAnimationFrame` 又 `clearTimeout`（两种续帧方式共用一个句柄变量，`:207-210`），最后 `_animId = undefined`。**本页全部定时器/动画帧清单**：① 续帧句柄 `_animId`（rAF 或 16ms setTimeout）——由 `stopScene` 清理，onHide/onUnload 均调用；② onLoad 两处 800ms `navigateBack` 延时（`:49`、`:63`）——**未存句柄、不清理**；③ 无 `setInterval`、无 `wx.createAnimation`（全文核实）。
- `tickTimeline`：到 `STATS_AT` 且未展示 → 一次性切 done 态并 `finalizeScene()`（`:216-218`）；到 `TEXT2_AT` 且未展示 → 只开 `showFinalText`（`:219-221`）。每分支靠 data 布尔自锁，只触发一次（`:214` 注释）。

**本页全部资源与清理对照**（逐行核实的完整清单）：

| 资源 | 创建点 | 清理点 | 结论 |
|---|---|---|---|
| 续帧句柄 `_animId`（rAF 或 16ms setTimeout） | `:196`/`:198` | `stopScene`（`:205-212`），onHide/onUnload 均调（`:90-96`） | ✅ 成对清理 |
| 800ms navigateBack 定时器 ×2 | `:49`、`:63` | 无（未存句柄） | ⚠ 卸载不清理，见 §9 问题 2 |
| `_glow` 离屏光晕精灵 | `:152` | 无显式释放 | ⚠ 随 Page 实例 GC，见 §8.1/§9 问题 1 |
| `_skyGrads` 渐变缓存 ×2 档 | `:151`、`:267` | 无显式释放 | 同上 |
| `_canvas`/`_ctx` 画布引用 | `:115-116` | 无（`coverCanvas` 后 WXML 已移除节点，引用仍持有） | 同上 |
| 星点/粒子/采样路径数组 | `:140-185` | 无 | 同上（纯 JS 对象，随实例 GC） |
| `sceneShot` 临时图片文件 | `:233-236` | 无显式删除 | 依赖微信临时文件机制，§9 问题 4 |
| `wx.createAnimation` / `setInterval` | — | — | 全文不存在 |

### 4.6 收尾快照：`finalizeScene`（`:224-240`）

`_finalized` 防重入（`:229-230`）→ `stopScene()` 停帧 → `drawFrame(99)` 画最终帧（t=99 使所有阶段进度钳到 1）→ `wx.canvasToTempFilePath` 把画布导出为临时图片，成功则 `setData({sceneShot, coverCanvas:true})`（`:233-237`）——WXML 随即**移除 canvas、换成 image**（`ceremony.wxml:2-4`，注释说明原生 canvas 层不透明且 visibility 在开发者工具不生效，DOM 数据卡须浮在静态图上）；导出失败静默降级保留画布（`:238`，真机同层渲染下数据卡仍可见）。临时文件路径未显式清理（微信临时文件机制管理，§9）。

### 4.7 跳过动画：`skipAnim`（`:242-248`）

仅首次仪式动画期间可用（WXML `:7` 按钮条件 `pending && phase === 'anim'`）；把 `_startAt` 回拨到 `STATS_AT` 之后（`:245`），直接置 done 态并 `finalizeScene()`。

### 4.8 `drawFrame(t)`（`:252-401`）——单帧绘制管线（按帧内顺序）

1. **深空背景**（`:258-270`）：星空展开系数 `expand` 由 `PULSE_END→STARS_END` 区间做 easeOutCubic 归一（`:259`）；线性渐变按 `expand > 0` 分「base / expanded」两档缓存于 `_skyGrads`（`:260-268`，首帧创建、后续帧零分配），底色三段 `#070D1A → #0D1B30 → #14263E/#1A2E4A`，铺满全屏。
2. **星野**（`:272-273`）：基础层 `starsBase` 70 颗以 `0.55 + expand*0.45` 的透明度缩放常显；展开后追加 `starsMore` 50 颗、透明度随 `expand` 渐显（需求 §20.2「星空模式展开」，`:154` 注释）。`drawStarfield`（`:403-414`）逐颗按 `sin(t*freq + phase)` 正弦闪烁，画毕复位 `globalAlpha=1`。
3. **路线进度双驱动**（`:275-285`）：末段推进 `segP`——`t/SEG_END` easeOutCubic，映射到最后一段采样区间（`lastSegStart = nodePathIndex[n-2]`，`:277-279`）；整线扫过 `sweepP`——`GLOW_END→SWEEP_END` 区间归一，映射全程采样下标（`:281-284`）；金色段终点 `goldIdx = max(segIdx, sweepIdx)`（`:285`），两阶段无缝衔接。
4. **路线描画**（`:287-312`）：先画虚线底线（`setLineDash([6,7])`、淡蓝 `rgba(165,195,225,0.28)`、2px，`:288-296`）；`goldIdx > 0` 时叠画金色已点亮段——`shadowColor rgba(255,196,74,0.85)` + `shadowBlur 12` 光晕、`#F0C65A` 4.5px 圆头线帽（`:299-312`）。
5. **十节点**（`:314-350`）：点亮判定——末节点在 GLOW 阶段完成即亮（`glowT >= 1`）或被扫过（`:321-322`），其余节点只看扫过下标（`:323-324`）；`glowT`/`pulseT` 分别为末节点发光与齐亮脉冲的阶段进度（`:315-316`），齐亮脉冲 `allLitPulse = sin(pulseT*π)` 仅在 `PULSE_END` 前有效（`:317`）。已亮节点：呼吸缩放 `breathe`（`:327`）× 脉冲放大 `bump`（`:328`）决定尺寸；光晕优先 `_glow` 精灵 `drawImage`、精灵为 null 时降级为径向渐变直绘（`:330-338`，routeCanvas.js.md §7 规则 3 的调用方落点）；再叠双层五角星（`routeCanvas.drawStar` 建路径 + 页面自填 `#E8B84B` 外层 / `#FFF7DC` 内层，`:339-344`，符合「只建路径不落笔」契约 routeCanvas.js.md §8.3）。未亮节点画暗色小星（`rgba(120,145,175,0.5)`，`:345-349`）。
6. **末节点发光特效**（`:352-382`，仅 `0 < glowT < 1` 期间）：放大亮星（`:356-358`）；两圈错相扩散环——半径 `10 + pr*52`、线宽与透明度随进度衰减（`:359-369`）；`burst` 26 颗粒子按各自 `delay` 起跑、0.9s 生命周期内做 `vy*dt + 20*dt²` 抛物运动并渐隐（`:370-381`）。
7. **最终文字**（`:384-400`）：「我的长征」（22px、`#F5D9A0`）自 `STARS_END` 起 0.6s 淡入，「完成了」（bold 44px、`#FFE9A8`）自 `TEXT2_AT` 起 0.6s 淡入，位于画布 68% 高度处（路线区之下、数据卡之上）；透明度用 `globalAlpha` 控制并复位。

`t=99` 是特殊入参：`finalizeScene` 用它一步画出所有阶段钳满的终帧（`:232`），跳过/回顾态与动画收尾共用同一帧内容。

### 4.9 `buildStats(route, summary)`（`:67-83`）——完成数据卡（§20.3）

6 项数据与来源：累计行军 `summary.stats.totalSteps`（null 时回退 `route.currentSteps`，`:74`）、运动天数 `stats.sportDays`（`:75`）、答题次数 `quiz.totalCount`（`:76`）、路线 `route.litCount/totalCount`（`:77-78`）、勋章 `medals.ownedCount/totalCount`（`:79-80`）、累计积分 `points.total`（`:81`）。步数与积分经 `util.formatNumber` 千分位格式化（`:74`、`:81`；`frontend/utils/util.js:20`）。summary 为 null（档案接口失败降级）时四段各取 `{}` 兜底、计数项展示 0（`:69-72`），路线两项不受影响。

### 4.10 交互与出口：`handleConfirm`（`:418-429`）

「收下这份荣光 / 返回」按钮（WXML `:38`）：回顾态（`!pending`）直接返回；首次仪式态先 `march.markCeremony()`（`POST /api/march/ceremony`，标记已观看，`.qoder/frontend/services/march.js.md` §4.5），`.catch(() => {})` **标记失败也照常返回**（`:427`，下次进入会重播动画——后端幂等规则见 `.qoder/backend/app/api/routes/march.py.md` §4.4）。返回动作 `wx.navigateBack`，失败（页面栈无上级，如测试 reLaunch 直达）兜底 `wx.switchTab('/pages/march/march')`（`:420`）。**页面全部导航出口**：`:42` reLaunch launch（未登录）、`:49`/`:63` navigateBack（未完成/加载失败）、`:420` navigateBack→switchTab march（确认）。

## 4-1. WXML 专章（ceremony.wxml，40 行）

结构极简，共 4 块：① 画布/快照二选一——`<canvas wx:if="{{!coverCanvas}}" type="2d" id="ceremonyCanvas">` 全屏（`:3`），收尾后换 `<image wx:if="{{coverCanvas && sceneShot}}" mode="aspectFill">`（`:4`，`:2` 注释说明替换原因）；② 跳过按钮 `wx:if="{{pending && phase === 'anim'}}"`（`:7`）；③ 完成数据卡 `wx:if="{{showStats && stats}}"`（`:10-39`）：标题按 `pending` 二选一「长征完成 · 我的征程 / 已完成长征」（`:11`），6 宫格 `stats-item` 展示 §4.9 六项（`:12-37`，标签「累计行军（步）/运动天数（天）/答题（次）/路线/勋章/累计积分」）；④ 确认按钮（全局 `btn-primary` + 本地 `confirm-btn`，`:38`）。无列表循环、无 `wx:key` 需求；表达式仅三元与 `&&`，无原生方法调用（`frontend/AGENTS.md` §5.2）。

## 4-2. WXSS 专章（ceremony.wxss，91 行）

- 深空主题独立于全站暖色系：页面 `position:fixed` 全屏、背景 `#070D1A`（`:1-8`），与画布渐变起始色一致（`ceremony.js:264`）。
- 画布/快照共用 `.ceremony-canvas` 绝对定位铺满（`:10-16`）；跳过按钮右上描边胶囊 `z-index:5`（`:18-28`）；数据卡 `.stats-panel` 底部升起动画 `panelRise 0.6s`（本地唯一 keyframes，`:31-53`）、鎏金描边（`rgba(212,160,23,0.4)`，`:37`）`z-index:6`；6 宫格 `width:33.33%` 三列换行（`:64-73`）；数值金色 `#FFE9A8`、标签淡蓝白（`:75-86`）；确认按钮覆写 `btn-primary` 为暗金渐变（`:88-91`）。
- 全局依赖仅 `.btn-primary`（`frontend/app.wxss:33`）；无死选择器（10 个类名与 WXML 逐一对照均有使用）。

## 4-3. JSON 专章（ceremony.json，6 行）

4 个键：`navigationBarTitleText: "长征完成仪式"`、`navigationBarBackgroundColor: "#070D1A"`（**刻意偏离**全站主色 `#C8102E`，与深空画布一体）、`navigationBarTextStyle: "white"`、`disableScroll: true`（全屏动画页禁滚动）。无 `usingComponents`。

## 5. 输入与输出

- **入参**：无。两个入口均不带 query（§2），页面不读 `onLoad(options)` 参数。
- **出参（页面调用的 service 与后端路径）**：

| service 调用 | ceremony.js 行号 | 后端路径 |
|---|---|---|
| `march.getRoute()` | `:45` | `GET /api/march/route`（`.qoder/frontend/services/march.js.md` §4.1；含 `ceremonyPending`/`finished`，`.qoder/backend/app/api/routes/march.py.md` §4.4/§4.5） |
| `profile.getSummary()` | `:45`（`.catch(() => null)` 降级） | `GET /api/profile/summary`（`.qoder/frontend/services/profile.js.md` §4） |
| `march.markCeremony()` | `:426` | `POST /api/march/ceremony`（`.qoder/frontend/services/march.js.md` §4.5）。**后端该端点未声明 `response_model`、返回裸 `{"ok": true}`**，登记于 `.qoder/PROJECT.md` §8「代码级技术债」第 31 项（另见 `.qoder/backend/app/api/routes/march.py.md` §9 问题 1）；本页不消费响应体，`ok` 字段仅 JSDoc 约定 |

- **错误出口**：路线未完成/加载失败 → toast + navigateBack（`:47-50`、`:61-64`）；markCeremony 失败 → 静默吞掉照常返回（`:427`）。GET 类请求遇活动拦截（403 + `X-Activity-Status`）由 request.js 防抖 reLaunch 到活动状态页（`.qoder/frontend/services/request.js.md` §4.8/§4.9），POST 的 ceremony 标记被拦只抛错、由 `:427` 吞掉。

## 6. 依赖关系

- **require（`:9-13`，5 项全部有使用）**：`app = getApp()`（仅读 `globalData.loggedIn`）；`services/march`（getRoute/markCeremony）；`services/profile`（getSummary）；`utils/util`（formatNumber）；`utils/routeCanvas`（getCanvasNodePositions `:140`、sampleRoutePath `:144`、createGlowSprite `:152`、easeOutCubic `:259`/`:278`/`:281`、drawStar `:339`/`:342`/`:346`/`:356`——与 `.qoder/frontend/utils/routeCanvas.js.md` §6 所列一致，未用 distToIndex/drawRoundRect）。页面零直接 `wx.request`、零 Storage 读写（`frontend/AGENTS.md` §3.1/§6.5）。
- **被依赖**：`app.json:21` 注册；march 页两个入口（§2）；automator 测试 `p2-theme-ceremony.cjs`、`s16-review-smoke.cjs`；`frontend/test/wxml-balance-check.cjs:6` 把本页 WXML 列入平衡检查清单。
- **数据库表**：前端不触库；`POST /march/ceremony` 写 `users.route_ceremony_at`（`.qoder/backend/app/api/routes/march.py.md` §6）。

## 7. 业务规则

1. **仅首次播放完整动画**：`pending` 完全由后端 `ceremonyPending` 决定（`:53`），判定在后端（全部点亮且 `route_ceremony_at IS NULL`，`.qoder/backend/app/api/routes/march.py.md` §7 规则 4）；标记走后端持久化，换设备不重播（`.qoder/frontend/services/march.js.md` §7 规则 4）。
2. **未完成不得停留**：`!route.finished` 一律 toast + 返回（`:47-50`），页面不提供任何未完成态 UI。
3. **登录守卫**：仅 onLoad 检查 `app.globalData.loggedIn`（`:41-44`）；onShow 只负责续播不重复守卫——本页不重新拉数据，守卫口径与不变量 5「onShow/onLoad 自行判断」相符（现状事实）。
4. **回顾态零动画**：`pending=false` 时不启动循环，直接静态终帧 + 数据卡（`:124-128`）。
5. **帧内零分配**：粒子/星点/采样路径/光晕精灵/渐变全部构建期固定（`:7`、`:132` 注释），绘制帧只读缓存——对应根 `agents.md` §2.4 性能要求与 `frontend/AGENTS.md` §4 不变量 6。

## 8. 修改约束

1. **`_glow` 与画布资源的释放结论（回答 routeCanvas.js.md §9 问题 1 的开放项）**：本页**确实创建**光晕精灵——`ceremony.js:152` `this._glow = routeCanvas.createGlowSprite(...)`，并在 `:330-331` 每帧 `drawImage` 复用。`onHide`（`:90-92`）/`onUnload`（`:94-96`）只调 `stopScene()`，而 `stopScene`（`:205-212`）仅停动画帧（cancelAnimationFrame/clearTimeout），**没有把 `_glow`/`_skyGrads`/`_canvas`/`_ctx` 置 null，也没有任何显式释放**。即：离屏画布引用随 Page 实例存活，直至页面卸载后实例整体被 GC 回收。与 march 页「画布重建时置 null 再重烘焙」（`march.js:375-376`，routeCanvas.js.md §8.4）不同，本页画布生命周期内**从不重建**（`initScene` 仅 onLoad 触发一次），故不构成随重建累积的泄漏；但按 routeCanvas.js.md §8.4「新增调用方必须在画布重建/页面卸载时释放引用」的口径，本页**缺少卸载时的显式释放**，属登记在案的差距而非无界泄漏（详见 §9 问题 1）。补释放时应在 `onUnload`（而非 onHide，onShow 续播还要用 `_ctx`/`_glow`，`:87`）置空 `_glow/_skyGrads/_canvas/_ctx`。
2. **`coverCanvas` 快照机制不得简化**：canvas→image 替换是为解决原生 canvas 层盖住 DOM 数据卡的开发者工具问题（`:34-35`、`ceremony.wxml:2` 注释）；删掉快照分支会让数据卡在工具中被画布遮挡。
3. `sampleRoutePath` 返回结构 `{path, dist, len, nodePathIndex}` 与归一化安全区系数是 march/ceremony 双页硬契约（`.qoder/frontend/utils/routeCanvas.js.md` §8.2/§8.5），改动画构图勿单页私调系数。
4. `TL` 时刻与 `tickTimeline` 的 data 布尔自锁（`:216`、`:219`）配对：新增阶段必须保持「只触发一次」语义，否则动画期间反复 setData。
5. `_animId` 一个变量承载 rAF 与 setTimeout 两种句柄，`stopScene` 对两者都清（`:207-210`）——拆成两个变量时务必两处都清（`frontend/AGENTS.md` §4 不变量 6 的清理精神；home.js.md §8.1 同款契约）。
6. WXML 展示字段全部 js 侧预计算（`stats.*Text` 等），不得引入原生方法调用；`disableScroll`、深色导航栏（json 4 键）是全屏沉浸体验的一部分。

## 9. 当前实现状态

- **已实现**：首次/回顾双态、8.1s 六阶段动画、跳过、收尾快照、完成数据卡、markCeremony 标记链、onShow 续播、onHide/onUnload 停帧。`git log --follow` 共 3 个提交（§10）。
- **存在问题 / 已知事项（事实陈述）**：
  1. **`_glow` 等画布资源无卸载期显式释放**（§8.1 定论）：`stopScene` 只停帧不清引用（`:205-212`），`_glow`/`_skyGrads`/`_canvas`/`_ctx`/星点/粒子数组全部保留到 Page 实例 GC；且 `coverCanvas=true` 后 WXML 已移除 canvas 节点（`ceremony.wxml:3`），`_canvas`/`_ctx`/`_glow` 仍被实例持有直至卸载。单次访问单份资源、无重建路径，**非无界泄漏**；是否按 routeCanvas.js.md §8.4 补 `onUnload` 置空属整改决策，**待确认**（routeCanvas.js.md §9 问题 1 的开放项据此可关闭为「未显式释放，随实例 GC」）。
  2. onLoad 两处 800ms `setTimeout(navigateBack)`（`:49`、`:63`）未存句柄：用户在 800ms 内自行返回时定时器仍会触发一次多余 `navigateBack`——边界极窄，现状事实。
  3. `pathDist`/`pathLen`（`:146-147`）赋值后无任何读取，属从 march 页复用采样代码带来的冗余字段。
  4. `finalizeScene` 的 `canvasToTempFilePath` 回调（`:235-237`）与 800ms 定时器均可能在页面卸载后 setData/navigateBack（微信仅告警不崩溃）；临时图片文件未显式删除，依赖微信临时文件回收机制，是否有累计占用**待确认**。
  5. 回顾态 `stats` 依赖 onShow 不刷新：从 march 页二次进入时数据为进入时刻快照（本页 onLoad 一次性拉取），期间步数变化不反映——与页面「仪式回顾」定位相符，现状事实。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/ceremony/`（**3 个提交**），提交号均已在 `docs/迭代记录.md` 按 hash 核对存在。按时间倒序。除 `79004f1`（创建提交，配套报告 `frontend/test/docs/p2-theme-ceremony-report.md`）外，各提交对本页的具体 diff 未逐一核对，以提交信息与既有条目为据。

### 2026-10-11（`e70b59f`、`01e214a`）
- 需求：小程序代码审查修复批次（`e70b59f`）；V1.0 启动页自动登录并取消强制选组织（`01e214a`）。
- 修改内容（涉本文件）：`e70b59f` 将离屏光晕精灵抽取为 `routeCanvas.createGlowSprite` 供本页与 march 页共用（`.qoder/frontend/utils/routeCanvas.js.md` §10 明记关联本页；现行 `:152` 调用即该形态）；`01e214a` 触及本目录，推测与 onLoad 登录守卫改 reLaunch 启动页（`:41-44` 现行形态）相关——**具体 diff 未核对，以提交信息为据**。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f`、`01e214a` 条目。

### 2026-10-04（`79004f1`，01:13）
- 需求：区域氛围与长征完成仪式（P2-2，需求 §20）。
- 修改内容（涉本文件）：创建本页四件套并在 `app.json` 注册（`frontend/test/docs/p2-theme-ceremony-report.md:21`「新增页面」）；同批交付后端 `POST /api/march/ceremony`、`ceremonyPending` 字段与 `services/march.js` 的 `markCeremony`（`.qoder/backend/app/api/routes/march.py.md` §10、`.qoder/frontend/services/march.js.md` §10 同日记载）。
- 关联文件：`frontend/utils/routeCanvas.js`（新增）、`frontend/data/node-themes.js`、`frontend/pages/march/march.js`、后端 march 路由/服务。
- 测试结果：见 `docs/迭代记录.md` 的 `79004f1` 条目；automator 专项 `frontend/test/automator/p2-theme-ceremony.cjs`。
