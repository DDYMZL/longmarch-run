# routeCanvas.js

## 1. 文件路径

`frontend/utils/routeCanvas.js`（143 行）

## 2. 文件职责

路线 Canvas 共用绘制工具：星空长征（`pages/march`）与完成仪式（`pages/ceremony`）共用，另有 `pages/ticket` 复用其圆角矩形（`frontend/utils/routeCanvas.js:1-4` docstring；ticket 引用见 `frontend/pages/ticket/ticket.js:9`）。全部为无副作用纯函数；坐标单位为 CSS px，dpr 缩放由调用方负责（`:3`）。由 march.js 抽取而来（`79004f1`，见 §10；`frontend/design.md` 「完成仪式（P2-2）」段亦记载「从 march.js 抽取的 Catmull-Rom 路线采样/星形/圆角矩形等纯函数」）。

## 3. 业务需求

- 星空长征插画地图与完成仪式动画同源绘制（需求「星空远征」双模式地图与「完成仪式」，见 `frontend/AGENTS.md` §4 不变量 6 与 `frontend/design.md` 「完成仪式（P2-2，需求 §20）」段）。
- 光晕精灵预渲染是性能需求：避免每帧创建径向渐变（`:116` JSDoc），对应根 `agents.md` §2.4 大数据量/高频渲染性能要求。

## 4. 核心功能

**Canvas 上下文类型（从调用方代码核实）**：三个消费页全部走 **Canvas 2D 新接口**——`wx.createSelectorQuery()` 取节点后 `node.getContext('2d')`（`frontend/pages/march/march.js:546`、`:558`；`frontend/pages/ceremony/ceremony.js:104`、`:113`；`frontend/pages/ticket/ticket.js:54`、`:64`）。全 `frontend/pages` grep `createCanvasContext` **零命中**，即项目不使用旧版接口；本模块所有函数只依赖标准 2D context 方法（`beginPath/moveTo/lineTo/arcTo/closePath/drawImage` 等），与上下文获取方式解耦。

导出 7 个函数（`:135-143`），逐一说明：

| # | 函数 | 行号 | 说明 |
|---|---|---|---|
| 1 | `easeOutCubic(t)` | `:7-9` | 缓动 `1-(1-t)^3`，纯数学 |
| 2 | `drawStar(ctx, cx, cy, spikes, outerR, innerR, rot)` | `:12-23` | 只构建五角星**路径**（`beginPath…closePath`），不 fill/stroke，样式由调用方设置 |
| 3 | `drawRoundRect(ctx, x, y, w, h, r)` | `:26-35` | 圆角矩形路径，半径钳制 `min(r, w/2, h/2)`（`:27`），用 `arcTo` 四角 |
| 4 | `getCanvasNodePositions(nodes, width, height)` | `:40-55` | 经纬度 → 画布坐标归一化 |
| 5 | `sampleRoutePath(pts, segs)` | `:62-101` | Catmull-Rom 平滑采样 |
| 6 | `distToIndex(dist, len)` | `:104-113` | 距离 → 采样下标（二分） |
| 7 | `createGlowSprite(stops)` | `:120-133` | 径向光晕离屏精灵（**唯一分配资源的函数**） |

### 4.1 `getCanvasNodePositions`（`:40-55`）

- 求全体节点经纬度包络（`:42-49`），映射到安全绘制区：x 占宽度的 12%–88%（`0.12 + 0.76` 归一系数，`:52`），y 占高度的 12%–84%（`0.12 + 0.72`，`:53`）；y 轴翻转（`maxLat - node.latitude`，北纬大者靠上）。
- 退化分支：`nodes` 为空返回 `[]`（`:41`）；经度或纬度跨度为 0（如单节点）时该轴取中值 `width*0.5` / `height*0.5`（`:52-53` 三元）。

### 4.2 `sampleRoutePath`（`:62-101`）

- 标准 Catmull-Rom 样条（`:75-88` 的三次多项式系数），每段采 `segs+1` 个点；首尾控制点用 `Math.max(0, i-1)` / `Math.min(n-1, i+2)` 钳位复制端点（`:67-70`）。
- 返回 `{ path, dist, len, nodePathIndex }`（`:100`）：`dist` 为累计弧长数组（`:92-95`，`Math.hypot`），`len` 为全长，`nodePathIndex[i] = i*(segs+1)` 为各节点在 path 上的下标（`:97-98`）。
- 单点路线（`n===1`）：path 仅含该点（`:65`），主循环不执行，`dist=[0]`、`len=0`。

### 4.3 `distToIndex`（`:104-113`）

二分查找满足 `dist[mid] <= len` 的最大下标（`:107-111`，`(lo+hi+1)>>1` 上取整防死循环）。march 页用它把「已行进距离」换成路径下标（`march.js:1357`）。

### 4.4 `createGlowSprite`（`:120-133`）

- `wx.createOffscreenCanvas({ type: '2d', width: 64, height: 64 })` 预渲染径向渐变（色标由入参 `stops` 提供，`:123-128`），绘制期调用方以 `drawImage` 缩放复用（如 `march.js:774`、`:1174`）。
- **整体包 try/catch，失败返回 `null`**（`:121`、`:130-132`）：低版本基础库不支持离屏画布时由调用方降级——这正是 `frontend/AGENTS.md` §4 不变量 6「离屏画布相关调用必须包 try/catch 降级」的落点；调用方均以 `if (this.glowGold)` 判空后直绘（`march.js:771`、`:1172`）。

## 5. 输入与输出

- 输入：见 §4 各函数签名；`ctx` 为 Canvas 2D 渲染上下文；`nodes` 元素须含 `latitude`/`longitude`（`:42-43`）；`pts` 元素须含 `x`/`y`；`stops` 为 `[offset, color]` 数组（`:117` JSDoc）。
- 输出：路径类函数（drawStar/drawRoundRect）只改 ctx 当前路径，无返回值；`getCanvasNodePositions` 返回 `{x,y}[]`；`sampleRoutePath` 返回 `{path,dist,len,nodePathIndex}`；`distToIndex` 返回 number；`createGlowSprite` 返回离屏画布对象或 `null`。
- 异常：除 `createGlowSprite` 内部吞掉并返回 null 外，其余函数不抛不catch——空数组/单点等退化输入有显式分支（`:41`、`:65`），非法入参（如 `nodes` 为 undefined）会直接 TypeError，由调用方保证入参。

## 6. 依赖关系

- 依赖：仅 `wx.createOffscreenCanvas`（`:123`，且已 try/catch）；不 require 任何模块，无后端/Storage 交互。
- 被依赖（全仓 grep `routeCanvas` 核实的**全部**代码调用方，共 3 页）：
  - `frontend/pages/march/march.js:15`（require）：`getCanvasNodePositions`（`:583`）、`sampleRoutePath`（`:587`）、`easeOutCubic`（`:353`、`:760`、`:1119`）、`drawStar`（`:778`、`:1211`、`:1214`、`:1241`、`:1244`、`:1249`、`:1347`）、`drawRoundRect`（`:1268`）、`createGlowSprite`（`:844-845`，产出 `this.glowGold`/`this.glowRed`）、`distToIndex`（`:1357`）——7 个导出全用。
  - `frontend/pages/ceremony/ceremony.js:13`（require）：`getCanvasNodePositions`（`:140`）、`sampleRoutePath`（`:144`）、`createGlowSprite`（`:152`，产出 `this._glow`）、`easeOutCubic`（`:259`、`:278`、`:281`）、`drawStar`（`:339`、`:342`、`:346`、`:356`）。
  - `frontend/pages/ticket/ticket.js:9`（require）：仅 `drawRoundRect`（`:77`、`:85`）。
- 数据输入来源：`nodes` 的经纬度来自 march 页 `NODE_COORDS` 静态坐标表（`frontend/AGENTS.md` §4 不变量 6 提及「真实经纬度 NODE_COORDS」，其定义在 `frontend/pages/march/march.js`，属页面文档范围）。
- **无导出函数零调用**（grep 逐函数核实，见上）。

## 7. 业务规则

1. **纯函数约定**：除 `createGlowSprite` 外不持有任何状态、不产生副作用（`:3` docstring）；同一输入必得同一输出，绘制状态（fillStyle/globalAlpha 等）由调用方管理。
2. **性能设计**：光晕走 64px 离屏精灵一次烘焙、每帧 `drawImage` 复用（`:116`）；`sampleRoutePath`/`distToIndex` 让「行进进度 → 路径位置」为 O(log n) 查询，支撑 march 页逐帧动画。
3. **降级规则**：`createGlowSprite` 返回 null 时调用方跳过光晕直绘星形（`march.js:771-776` 的判空结构），视觉降级但功能不缺失。

## 8. 修改约束

1. **不得删除 `createGlowSprite` 的 try/catch**：`frontend/AGENTS.md` §6.5 明令「禁止删除 Canvas 离屏降级 try/catch」（不变量 6）。
2. 返回结构 `{path, dist, len, nodePathIndex}` 是 march/ceremony 两页的硬契约（`march.js:587`、`ceremony.js:144` 解构消费），改字段须双页同步。
3. `drawStar`/`drawRoundRect` 保持「只建路径不落笔」语义——调用方依赖其后自行 fill/stroke（如 `march.js:1268` 建路径后由页面填充）；在函数内加 fill 会破坏全部 3 个调用页。
4. **资源清理责任在调用方**（本模块无定时器/无监听器，唯一资源是 `createGlowSprite` 返回的离屏画布）：march 页在画布重建时把 `glowGold`/`glowRed` 置 null 再重烘焙（`march.js:375-376` 置空，`:844-845` 重建），符合 `frontend/AGENTS.md` §4 不变量 6「渐变缓存与光晕精灵须在画布重建时重置」；ceremony 页持有 `this._glow`（`ceremony.js:152`）。离屏画布无显式销毁 API，置 null 依赖 GC 回收——模块侧无泄漏点，但若新增调用方**必须**同样在画布重建/页面卸载时释放引用，否则旧精灵随实例泄漏。
5. 归一化安全区系数（12%/76%/72%，`:52-53`）改动会同时改变 march 与 ceremony 的构图，勿单页私调。

## 9. 当前实现状态

- **已实现**：7 个导出全部被消费（§6）；march 星空图、ceremony 仪式动画、ticket 票据圆角框三处稳定复用。
- **存在问题 / 已知事项**：
  1. 模块自身无未释放资源；离屏画布生命周期完全交由调用方（§8.4）。**ceremony 页 `this._glow` 无显式释放**（2026-10-17 核实，原「待确认」已关闭）：创建于 `initScene()`（`frontend/pages/ceremony/ceremony.js:152`），每帧复用于 `:330-331`；`onHide`/`onUnload`（`:90-96`）都只调 `stopScene()`，而 `stopScene()`（`:205-212`）仅停帧（`running=false` + `cancelAnimationFrame`/`clearTimeout`），**不置空 `_glow`**，引用随 Page 实例卸载后由 GC 回收。因 `initScene()` 全页只调一次（`:59`）、`createGlowSprite` 只此一处调用，精灵从不重建，故**非无界泄漏**；但不满足 §8.4 与 `frontend/AGENTS.md` §4 不变量 6 的「显式释放」口径（march 页做到了，ceremony 页未做）。是否补 `onUnload` 置空属页面侧决定，详见 `.qoder/frontend/pages/ceremony/ceremony.js.md` §9。
  2. `distToIndex` 假定 `dist` 单调不减且 `len` 在 `[0, dist末值]` 内；超界入参返回末端/0 下标而不报错——现状行为，调用方（`march.js:1357`）传入的是内部累计距离，实际不会越界。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/utils/routeCanvas.js`，共 **2 个提交**。按时间倒序。

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
