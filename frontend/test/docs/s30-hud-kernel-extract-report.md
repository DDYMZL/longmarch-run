# S30 星空长征渲染内核抽离（utils/hudMap.js）测试报告

日期：2026-10-19 · 范围：frontend（深空 HUD 科技感地图五阶段方案 S2/5，纯搬迁、视觉行为不变）

## 改动摘要

- **新增 `frontend/utils/hudMap.js`（996 行）**：星空模式全部绘制状态与方法迁入渲染内核，工厂函数 `createHudMap({ ctx, cw, ch, dpr })` 返回实例挂 `page.hud`。持有：观景变换 `view`、路线几何（`nodePts`/`path`/`pathDist`）、星空三层（`farStars`/`stars`/`trailDust`/`regionMotes`）、离屏静态层与光晕精灵、入场/增量/点亮三类动画状态，以及 `setRoute`/`calcRouteProgress`/`currentRatio`/`buildGeometry`/`buildStatic`/`draw`/`clampView`/`resetView`/`hitTest`/`playArrive`/`dispose` 等方法。
- **`pages/march/march.js` 1521 → 654 行**：只保留模式切换、数据拉取、手势事件转发、命中后跳转与 rAF 循环（`onHide`/`onUnload` 生命周期归属不变，每帧只调 `hud.draw(t)`）；删除全部绘制方法与绘制状态。切回实景时 `hud.dispose()` 释放画布上下文、离屏层与光晕精灵。
- **职责边界**：pan/pinch 手势数学留在页面（事件层），改写 `hud.view` 后**必须**调 `hud.clampView()`；命中测试 `hud.hitTest()` 内部做屏幕→场景逆变换；「入场描画 vs 增量推进」的判定由 `renderRoute` 上移到 `hud.setRoute` 内部（按是否已有采样路径区分），使 `initCanvas` 与 `renderRoute` 共用一条路径。
- **魔数收敛为命名常量**：`INTRO_MS=1400`、`PROGRESS_MS=800`、`ARRIVE_FX_MS=2400`、`PARTICLE_CAP=64`。
- **零视觉变更**：绘制函数体逐行搬迁，仅 `this.routeData`→`this.route`、`this.dpr || 2`→`this.dpr` 等引用改名；离屏降级 try/catch 原样保留。
- **4 个 automator 套件改读 `page.hud.*`**（按既定决定不留兼容别名）：`p0-march.cjs` 的 P0M-02~05 改为先切 canvas 建内核再对 `hud` 断言；`p1-starry-march.cjs` 的就绪判定/`pageState`/fx replay/复位改走 `hud`；`tabbar-starmap.cjs` 的 `marchState`/TS-03/TS-04/TS-05/TS-06/TS-07 改走 `hud`；`s16-review-smoke.cjs` 的 R4 改断言 `hud`/`hud.glowGold`。
- **顺带修正两处预存漂移**（否则桥被拒/登录 502，套件根本跑不起来）：`tabbar-starmap.cjs` 的 `TABS` 由已降级的 quiz 改为现行第 3 tab `ai-chat`（2026-10-17 tab 重构遗留）；`p1-starry-march.cjs` 删除 mock code 登录 + 强制选组织 + 注入 8000 步（本地后端配真实微信凭证后 mock code 被 code2Session 拒、V1.0 起登录直接进首页、组织选填），改为复用模拟器持久登录态且不写业务数据。
- **文档同步**：`frontend/AGENTS.md` 不变量 6 改写为内核边界（`hud.view` 改写须 `clampView`、切实景须 `dispose`、rAF 留页面）；`frontend/design.md` §4.6「插画模式」「行军轨迹」两段改述 `utils/hudMap.js` 与 `hud.setRoute` 的入场/增量判定。

## 验证结果

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| `tabbar-starmap.cjs` | **8/8 PASS** | TS-03 星空三层 far=110/mid=64/baked=true/glint=9/避让 0；TS-04 整帧 0.61ms、星空 0.27ms（120 帧均值）；TS-05 切走暂停/切回恢复且帧推进；TS-06 实景↔星空往返画布释放与重建；TS-07 星空点击节点进详情；TS-08 无新增异常 |
| `p0-march.cjs` | **6/6 PASS** | P0M-01 实景 nodes=10/markers=11/polylines=2/进度旗在；P0M-02 `hud.calcRouteProgress` 后端字段优先=0.7；P0M-03 降级步数比例=0.5；P0M-04 `hud.currentRatio`∈[0,1]；P0M-05 切 canvas 内核就绪；P0M-06 切回实景正常 |
| `p1-starry-march.cjs` | **4/4 PASS** | P1J-01 按钮「星空长征」+view{1,0,0}+星尘 22；P1J-02 捏合 scale=2.50、pan=(-220,-320) 在 [-585,0] 内；P1J-03 双击复位{1,0,0}+单击 (343,375) 命中进详情；P1J-04 粒子 14 颗/字段齐备/超时清除/整帧无异常 |
| `s16-review-smoke.cjs` | **16/18** | R4 实景→星空→实景：`{"hud":false,"glow":false,"mode":"real","markers":11}` 证明 `dispose` 释放内核与光晕精灵且 markers 重建；R7/R12 失败为**预存配置漂移**（见备注），不经过 hudMap |

### 与搬迁前基线的逐项对照（行为不变证据）

| 指标 | 搬迁前（历史 results） | 搬迁后（本次） | 结论 |
| --- | --- | --- | --- |
| P1J-01 view/星尘 | `{"s":1,"ox":0,"oy":0}` dust=22 | 同 | 完全一致 |
| P1J-02 scale/pan/clamp | 2.50 / (-220.0,-320.0) / [-585.0,0] | 同 | 完全一致 |
| P1J-03 复位/命中点 | {1,0,0} / (343,375) | 同 | 完全一致 |
| P1J-04 粒子/清除 | 14 / true | 同 | 完全一致 |
| TS-03 far/mid/baked/glint/避让 | 110/64/true/9/0 | 110/64/true/9/0 | 完全一致 |
| TS-07 首节点屏幕坐标 | (343,375) | (343,375) | 几何未变 |
| TS-04 整帧/星空耗时 | 1.40 / 0.62 ms | 0.61 / 0.27 ms | 更快（无回归） |
| P0M-01 nodes/markers/polylines | 10/11/2 | 同 | 完全一致 |

**视觉对照**：`test/images/27-march-starry.png`、`starmap-01-twinkle-a/b.png` 与 git HEAD 版（搬迁前）逐图比对——山峦三层轮廓、路线走向与虚线引导段、10 个节点标签位置、右上罗盘玫瑰、四角描金边框、金轨+进度旗+呼吸光点全部一致；差异仅为星点闪烁相位（构建期随机）与页面 chrome（「同步行程」按钮、AI 问答 tab 属其他迭代）。

**静态校验**：`node --check` 对 `utils/hudMap.js`、`pages/march/march.js` 及 4 个改动 `.cjs` 全通过；grep 确认 march.js 无残留 `this.ctx/this.view/staticLayer/arriveFx/calcRouteProgress/...` 引用，hudMap.js 内无 `routeData`/`getApp()`/`this.data` 等页面耦合；`utils/routeCanvas.js` 与 `pages/ceremony/ceremony.js` 本次未改（`git diff` 为空），ceremony 依赖的 5 个导出函数齐全。

## 备注

1. **R7/R12 的 502 与本次无关**：本地后端 `.env` 配了真实 `WX_APPID/WX_SECRET` 且未开 `WX_LOGIN_ALLOW_MOCK`，两条用例建临时 mock 用户时固定 code 被 code2Session 拒（见 automator 执行协议 #17）。R7 是完成仪式页（需 `route.finished` 的已走完全程用户），其绘制依赖的 `utils/routeCanvas.js` 本次零改动，且该模块另一消费方 ticket 页在 s16 R10「打开 ticket 页无异常」通过，故共享绘制工具无回归。
2. **`tabbar-starmap-shots.cjs` 的 `tabbar-02-quiz.png` 条目仍指向已降级的 quiz tab**（2026-10-17 tab 重构遗留）；本次以 `only` 参数只补拍 `starmap-01/02` 两张，该条目待另开任务修正。
3. **TS-03 的 freqs/slow/loRange 每次运行数值不同**：星点周期与亮度区间为构建期随机生成，断言口径是唯一性/范围/计数区间而非定值，故基线对照只取 far/mid/baked/glint/避让这些确定性字段。
4. **8010 上运行的是 S1 之前的旧后端进程**（无 `/march/route-stats`）。S2 只依赖 `/march/route`、`/sport/*` 等既有接口，未重启；S4 实时叠加层联调前须重启以加载 S1 新接口。
5. 工作区遗留的非本任务改动 `frontend/services/config.js`（`DEV_TARGET='local'`、`LAN_IP` 更新，本机联调配置）按「一个任务一个提交」排除在本次提交外。
