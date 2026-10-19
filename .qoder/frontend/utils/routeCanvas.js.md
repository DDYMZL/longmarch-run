# routeCanvas.js

## 1. 文件路径

`frontend/utils/routeCanvas.js`（239 行）

## 2. 文件职责

路线 Canvas 共用绘制工具：星空长征渲染内核（`utils/hudMap.js`，S2 起 march 页绘制全部收进内核）与完成仪式（`pages/ceremony`）共用，另有 `pages/ticket` 复用其圆角矩形（`frontend/utils/routeCanvas.js:1-4` docstring；ticket 引用见 `frontend/pages/ticket/ticket.js:9`）。全部为无副作用纯函数；坐标单位为 CSS px，dpr 缩放由调用方负责（`:3`）。由 march.js 抽取而来（`79004f1`，见 §10；`frontend/design.md` 「完成仪式（P2-2）」段亦记载「从 march.js 抽取的 Catmull-Rom 路线采样/星形/圆角矩形等纯函数」）。

## 3. 业务需求

- 星空长征插画地图与完成仪式动画同源绘制（需求「星空远征」双模式地图与「完成仪式」，见 `frontend/AGENTS.md` §4 不变量 6 与 `frontend/design.md` 「完成仪式（P2-2，需求 §20）」段）。
- 光晕精灵预渲染是性能需求：避免每帧创建径向渐变（`:116` JSDoc），对应根 `agents.md` §2.4 大数据量/高频渲染性能要求。

## 4. 核心功能

**Canvas 上下文类型（从调用方代码核实）**：三个消费页全部走 **Canvas 2D 新接口**——`wx.createSelectorQuery()` 取节点后 `node.getContext('2d')`（`frontend/pages/march/march.js:569`、`:581`；`frontend/pages/ceremony/ceremony.js:107`、`:116`；`frontend/pages/ticket/ticket.js:57`、`:67`）。全 `frontend/pages` grep `createCanvasContext` **零命中**，即项目不使用旧版接口；本模块所有函数只依赖标准 2D context 方法（`beginPath/moveTo/lineTo/arcTo/arc/closePath/drawImage` 等），与上下文获取方式解耦。

导出 13 个函数（`:225-239`），逐一说明（#8~#12 为 S3 `835f46f` 纯新增，#13 为 S4 `5b26b07` 纯新增，既有 7 个函数体零改动）：

| # | 函数 | 行号 | 说明 |
|---|---|---|---|
| 1 | `easeOutCubic(t)` | `:7-9` | 缓动 `1-(1-t)^3`，纯数学 |
| 2 | `drawStar(ctx, cx, cy, spikes, outerR, innerR, rot)` | `:12-23` | 只构建五角星**路径**（`beginPath…closePath`），不 fill/stroke，样式由调用方设置 |
| 3 | `drawRoundRect(ctx, x, y, w, h, r)` | `:26-35` | 圆角矩形路径，半径钳制 `min(r, w/2, h/2)`（`:27`），用 `arcTo` 四角 |
| 4 | `getCanvasNodePositions(nodes, width, height)` | `:40-55` | 经纬度 → 画布坐标归一化 |
| 5 | `sampleRoutePath(pts, segs)` | `:62-101` | Catmull-Rom 平滑采样 |
| 6 | `distToIndex(dist, len)` | `:104-113` | 距离 → 采样下标（二分） |
| 7 | `createGlowSprite(stops)` | `:120-133` | 径向光晕离屏精灵（**唯一分配资源的函数**） |
| 8 | `tracePath(ctx, path, endIdx)` | `:141-149` | 把采样路径 `path[0..endIdx]` 建成一条 polyline 当前路径（`moveTo`+逐点 `lineTo`，endIdx 钳制到末下标），只建路径不落笔；消掉 hudMap 内 3 处内联重复 |
| 9 | `drawDashFlow(ctx, path, endIdx, dash, gap, offset)` | `:153-158` | 在 `tracePath` 基础上 `setLineDash([dash,gap])`+`lineDashOffset=offset` 后 stroke，save/restore 自洁；负 offset 即流光方向 |
| 10 | `drawHexRing(ctx, cx, cy, r, rot, innerRatio)` | `:168-186` | 单个 `beginPath` 内画外六边 +（可选）内六边（`r*innerRatio`），调用方一次 stroke 得双环；只建路径不落笔 |
| 11 | `drawScanSector(ctx, r, arc)` | `:189-197` | 以原点为顶点的扇形路径（`moveTo(0,0)`+`arc(-arc/2, arc/2)`+闭合），供调用方 `translate/rotate` 后填充做雷达扫描扇；只建路径不落笔 |
| 12 | `drawHudPanel(ctx, x, y, w, h, cut)` | `:200-212` | 切角矩形（HUD 面板/边框）路径，切角钳制 `min(cut, w/2, h/2)`；只建路径不落笔 |
| 13 | `drawArcGauge(ctx, cx, cy, r, ratio)` | `:219-223` | 进度环「值弧」路径：自 12 点方向（`-Math.PI/2`）顺时针画 `ratio` 圈，`ratio` 钳制 0~1（非法值按 0）；只建路径不落笔，底环整圆与线宽/线帽/颜色由调用方另设（`utils/hudMap.js:1330`） |

### 4.1 `getCanvasNodePositions`（`:40-55`）

- 求全体节点经纬度包络（`:42-49`），映射到安全绘制区：x 占宽度的 12%–88%（`0.12 + 0.76` 归一系数，`:52`），y 占高度的 12%–84%（`0.12 + 0.72`，`:53`）；y 轴翻转（`maxLat - node.latitude`，北纬大者靠上）。
- 退化分支：`nodes` 为空返回 `[]`（`:41`）；经度或纬度跨度为 0（如单节点）时该轴取中值 `width*0.5` / `height*0.5`（`:52-53` 三元）。

### 4.2 `sampleRoutePath`（`:62-101`）

- 标准 Catmull-Rom 样条（`:75-88` 的三次多项式系数），每段采 `segs+1` 个点；首尾控制点用 `Math.max(0, i-1)` / `Math.min(n-1, i+2)` 钳位复制端点（`:67-70`）。
- 返回 `{ path, dist, len, nodePathIndex }`（`:100`）：`dist` 为累计弧长数组（`:92-95`，`Math.hypot`），`len` 为全长，`nodePathIndex[i] = i*(segs+1)` 为各节点在 path 上的下标（`:97-98`）。
- 单点路线（`n===1`）：path 仅含该点（`:65`），主循环不执行，`dist=[0]`、`len=0`。

### 4.3 `distToIndex`（`:104-113`）

二分查找满足 `dist[mid] <= len` 的最大下标（`:107-111`，`(lo+hi+1)>>1` 上取整防死循环）。星空内核用它把「已行进距离」换成路径下标（`utils/hudMap.js:203`）。

### 4.4 `createGlowSprite`（`:120-133`）

- `wx.createOffscreenCanvas({ type: '2d', width: 64, height: 64 })` 预渲染径向渐变（色标由入参 `stops` 提供，`:123-128`），绘制期调用方以 `drawImage` 缩放复用（如 `utils/hudMap.js:354-357` 建金/红/青三精灵）。
- **整体包 try/catch，失败返回 `null`**（`:121`、`:130-132`）：低版本基础库不支持离屏画布时由调用方降级——这正是 `frontend/AGENTS.md` §4 不变量 6「离屏画布相关调用必须包 try/catch 降级」的落点；调用方均以判空后直绘降级（`utils/hudMap.js` 的 `buildGlowSprites`/`drawClouds` 判空结构）。

## 5. 输入与输出

- 输入：见 §4 各函数签名；`ctx` 为 Canvas 2D 渲染上下文；`nodes` 元素须含 `latitude`/`longitude`（`:42-43`）；`pts` 元素须含 `x`/`y`；`stops` 为 `[offset, color]` 数组（`:117` JSDoc）。
- 输出：路径类函数（`drawStar`/`drawRoundRect`/`tracePath`/`drawHexRing`/`drawScanSector`/`drawHudPanel`/`drawArcGauge`）只改 ctx 当前路径，无返回值；`drawDashFlow` 自行 save/restore 并 stroke（唯一落笔的路径 helper）；`getCanvasNodePositions` 返回 `{x,y}[]`；`sampleRoutePath` 返回 `{path,dist,len,nodePathIndex}`；`distToIndex` 返回 number；`createGlowSprite` 返回离屏画布对象或 `null`。
- 异常：除 `createGlowSprite` 内部吞掉并返回 null 外，其余函数不抛不catch——空数组/单点等退化输入有显式分支（`:41`、`:65`），非法入参（如 `nodes` 为 undefined）会直接 TypeError，由调用方保证入参。

## 6. 依赖关系

- 依赖：仅 `wx.createOffscreenCanvas`（`:123`，且已 try/catch）；不 require 任何模块，无后端/Storage 交互。
- 被依赖（全仓 grep `require(.*routeCanvas` 核实的**全部**代码调用方，共 3 处；S2 起 march 页绘制收进内核，故 march.js 本身不再 require 本模块）：
  - `frontend/utils/hudMap.js:30`（require）：13 个导出**全用**——`getCanvasNodePositions`（`:212`）、`sampleRoutePath`（`:216`）、`distToIndex`（`:203`）、`easeOutCubic`（`:198` 等 4 处）、`drawStar`（`:940` 等 7 处）、`drawRoundRect`（`:1014`）、`createGlowSprite`（`:354` 等 3 处，产出 `glowGold/glowRed/glowCyan`）、`tracePath`（`:498` 等 3 处）、`drawDashFlow`（`:871`）、`drawHexRing`（`:935` 等 4 处，含 L7 图例）、`drawScanSector`（`:675`）、`drawHudPanel`（`:631` 等 4 处，含 L7 数据面板）、`drawArcGauge`（`:1330`）。
  - `frontend/pages/ceremony/ceremony.js:13`（require）：`getCanvasNodePositions`（`:143`）、`sampleRoutePath`（`:147`）、`createGlowSprite`（`:155`，产出 `this._glow`）、`easeOutCubic`（`:262`、`:281`、`:284`）、`drawStar`（`:342`、`:345`、`:349`、`:359`）。
  - `frontend/pages/ticket/ticket.js:9`（require）：仅 `drawRoundRect`（`:88`、`:96`）。
- 数据输入来源：`nodes` 的经纬度来自 march 页 `NODE_COORDS` 静态坐标表（`frontend/AGENTS.md` §4 不变量 6 提及「真实经纬度 NODE_COORDS」，其定义在 `frontend/pages/march/march.js`，属页面文档范围）。
- **无导出函数零调用**（grep 逐函数核实，见上）。

## 7. 业务规则

1. **纯函数约定**：除 `createGlowSprite` 外不持有任何状态、不产生副作用（`:3` docstring）；同一输入必得同一输出，绘制状态（fillStyle/globalAlpha 等）由调用方管理。
2. **性能设计**：光晕走 64px 离屏精灵一次烘焙、每帧 `drawImage` 复用（`:116`）；`sampleRoutePath`/`distToIndex` 让「行进进度 → 路径位置」为 O(log n) 查询，支撑 march 页逐帧动画。
3. **降级规则**：`createGlowSprite` 返回 null 时调用方跳过光晕直绘星形（`utils/hudMap.js` 的 `buildGlowSprites`/`drawClouds`/`drawNodes` 判空结构），视觉降级但功能不缺失。

## 8. 修改约束

1. **不得删除 `createGlowSprite` 的 try/catch**：`frontend/AGENTS.md` §6.5 明令「禁止删除 Canvas 离屏降级 try/catch」（不变量 6）。
2. 返回结构 `{path, dist, len, nodePathIndex}` 是 hudMap 内核与 ceremony 页的硬契约（`utils/hudMap.js:216`、`ceremony.js:147` 解构消费），改字段须双处同步；S4 起内核把 `nodePathIndex` 存为 `nodePathIdx`（`utils/hudMap.js:220`）供 L8 飞线定位终点，删该字段会击穿飞线。
3. `drawStar`/`drawRoundRect`/`tracePath`/`drawHexRing`/`drawScanSector`/`drawHudPanel`/`drawArcGauge` 保持「只建路径不落笔」语义——调用方依赖其后自行 fill/stroke（如 `utils/hudMap.js:935` 建六边环路径后由内核描边、`:1330` 建值弧后由内核设色描边）；在函数内加 fill/stroke 会破坏全部调用方。`drawDashFlow` 是唯一的例外（自带 save/restore 的 stroke），新增落笔 helper 须同样自洁。
4. **资源清理责任在调用方**（本模块无定时器/无监听器，唯一资源是 `createGlowSprite` 返回的离屏画布）：hudMap 内核在画布重建时把 `glowGold/glowRed/glowCyan` 置 null 再重烘焙（`buildStatic`/`buildGlowSprites`），`dispose` 亦置空，符合 `frontend/AGENTS.md` §4 不变量 6「渐变缓存与光晕精灵须在画布重建时重置」；ceremony 页持有 `this._glow`（`ceremony.js:152`）。离屏画布无显式销毁 API，置 null 依赖 GC 回收——模块侧无泄漏点，但若新增调用方**必须**同样在画布重建/页面卸载时释放引用，否则旧精灵随实例泄漏。
5. 归一化安全区系数（12%/76%/72%，`:52-53`）改动会同时改变 march 内核与 ceremony 的构图，勿单页私调。
6. **只增不改**（S3 起强化）：`pages/ceremony` 与 `pages/ticket` 共用本模块，S3 的 5 个新 helper（#8~#12）与 S4 的 `drawArcGauge`（#13）均为纯新增、既有 7 个函数体零改动；后续新增绘制工具同样只增，改既有函数签名/返回结构会同时击穿三处消费方。

## 9. 当前实现状态

- **已实现**：13 个导出全部被消费（§6）；march 星空内核、ceremony 仪式动画、ticket 票据圆角框三处稳定复用。S3（`835f46f`）纯新增 5 个路径/描边 helper（`tracePath`/`drawDashFlow`/`drawHexRing`/`drawScanSector`/`drawHudPanel`）供深空 HUD 仪器层与能量管路线使用；S4（`5b26b07`）再纯新增 `drawArcGauge` 供 L7 我的进度仪表环值弧使用。两批既有 7 个函数体零改动（ceremony/ticket 无回归，ticket 页在 s16 R10 通过佐证）。
- **存在问题 / 已知事项**：
  1. 模块自身无未释放资源；离屏画布生命周期完全交由调用方（§8.4）。**ceremony 页 `this._glow` 无显式释放**（2026-10-17 核实，原「待确认」已关闭）：创建于 `initScene()`（`frontend/pages/ceremony/ceremony.js:155`），每帧复用于 `:333-334`；`onHide`/`onUnload`（`:93-99`）都只调 `stopScene()`，而 `stopScene()`（`:208-215`）仅停帧（`running=false` + `cancelAnimationFrame`/`clearTimeout`），**不置空 `_glow`**，引用随 Page 实例卸载后由 GC 回收。因 `initScene()` 全页只调一次（`:62`）、`createGlowSprite` 只此一处调用，精灵从不重建，故**非无界泄漏**；但不满足 §8.4 与 `frontend/AGENTS.md` §4 不变量 6 的「显式释放」口径（march 页做到了，ceremony 页未做）。是否补 `onUnload` 置空属页面侧决定，详见 `.qoder/frontend/pages/ceremony/ceremony.js.md` §9。
  2. `distToIndex` 假定 `dist` 单调不减且 `len` 在 `[0, dist末值]` 内；超界入参返回末端/0 下标而不报错——现状行为，调用方（`utils/hudMap.js:203`）传入的是内部累计距离，实际不会越界。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/utils/routeCanvas.js`，共 **4 个提交**。按时间倒序。

### 2026-10-19（`5b26b07`）
- 需求：科技感地图五阶段方案的 S4——L7 实时数据叠加层需要「我的进度」仪表环值弧，与 hudMap 内既有的整圆底环共用一套弧线路径画法。
- 修改内容（涉本文件）：227→239 行，**纯新增** `drawArcGauge(ctx, cx, cy, r, ratio)`（#13，`:219-223`）并加入导出（`:238`）：自 12 点方向顺时针按 ratio 画弧、ratio 钳制 0~1，只建路径不落笔（线宽/线帽/颜色与底环整圆由调用方设置）。既有 12 个函数体零改动。同批本文档更正 S3 之后累积的消费方行号漂移（hudMap 的 require 与 13 处调用点、ceremony/ticket 的调用点）。
- 关联文件：`frontend/utils/hudMap.js`、`frontend/pages/march/march.js`、`frontend/services/march.js`、`frontend/test/automator/hud-overlay.cjs`（新增）。
- 测试结果：automator `hud-overlay` 10/10、`tabbar-starmap` 8/8、`p0-march` 6/6、`p1-starry-march` 4/4；`node --check` 通过；ceremony/ticket 两消费方零改动零回归。报告 `frontend/test/docs/s32-realtime-overlay-report.md`；`docs/迭代记录.md` 的 `5b26b07` 条目。

### 2026-10-19（`835f46f`）
- 需求：深空 HUD 科技感地图五阶段方案的 S3——为仪器层（雷达环/切角框/扫描扇）与能量管路线提供共用路径 helper。
- 修改内容（涉本文件）：143→227 行，**纯新增** 5 个函数 `tracePath`/`drawDashFlow`/`drawHexRing`/`drawScanSector`/`drawHudPanel`（#8~#12）并加入导出；既有 7 个函数体零改动。同批本文档更正一处 S2 引入的漂移：消费方由 `pages/march/march.js` 改为 `utils/hudMap.js`（S2 `2862453` 已把 march 绘制收进内核、march.js 不再 require 本模块，本文档 §6 当时未同步）。
- 关联文件：`frontend/utils/hudMap.js`、`frontend/pages/march/march.wxml`、`frontend/pages/march/march.wxss`。
- 测试结果：automator 四套件 `tabbar-starmap` 8/8、`p0-march` 6/6、`p1-starry-march` 4/4、`s16-review-smoke` 16/18（R7/R12 预存配置漂移）；`node --check` 通过；ceremony/ticket 两消费方零改动零回归。报告 `frontend/test/docs/s31-deep-space-hud-report.md`；`docs/迭代记录.md` 的 `835f46f` 条目。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复批次（精简 setData、共享逻辑抽取）。
- 修改内容（涉本文件，据 `git show e70b59f` diff）：新增 `createGlowSprite`——离屏光晕精灵从 march 页抽出，长征页与仪式页共用（`frontend/test/docs/s16-miniprogram-review-fixes-report.md` 亦记载「离屏光晕精灵抽到 routeCanvas.createGlowSprite」）。
- 关联文件：`frontend/pages/march/march.js`、`frontend/pages/ceremony/ceremony.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-04（`79004f1`）
- 需求：区域氛围与长征完成仪式（P2-2）。
- 修改内容（涉本文件）：创建本文件，从 march.js 抽取 Catmull-Rom 路线采样/星形/圆角矩形等共享画布纯函数，供新仪式页复用（`frontend/test/docs/p2-theme-ceremony-report.md`：「utils/routeCanvas.js（新增）：从 march.js 抽取的共享画布纯函数」）。
- 关联文件：`frontend/pages/ceremony/ceremony.js`（新增）、`frontend/data/node-themes.js`（新增）、`frontend/pages/march/march.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `79004f1` 条目。
