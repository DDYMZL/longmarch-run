# S31 星空长征深空 HUD 视觉重构（L0~L6）测试报告

日期：2026-10-19 · 范围：frontend（深空 HUD 科技感地图五阶段方案 S3/5，视觉重做、行为与几何不变）

## 改动摘要

- **`utils/hudMap.js` 996 → 1218 行（L0~L6 深空 HUD 重绘）**。新增模块常量：`CYAN='63,216,255'`（#3FD8FF，仪器层唯一主色）、`DEEP_SKY`（四段深空底色 #050B16/#08111F/#0A1826/#0E1B2E）、`GRID=42`、`RADAR_R=0.4`、`SWEEP_S=7`/`SWEEP_ARC=1.05`（雷达扫描周期/扇角）、`SCAN_S=9`（扫描带周期）、`HINT_TEXT`（画布内操作提示文案）。新增实例状态 `glowCyan`/`_sweepGrad`/`_scanGrad`/`_hintW`（均在 `buildStatic` 复位、`dispose` 释放）。
- **分层重绘**：L0 深空底（四段渐变 + 中心青晕 + 四角暗角）→ L0 仪器（`drawRadarRing` 同心圆+十字虚线+12 刻度+N/E/S/W 标签、`drawGrid` 42px 细网格+每 4 条主网格+边框尺齿）→ L1 `drawRidges` 由「填充剪影山峦」改为**青色等高线线框**（3 层、逐层振幅衰减营造高程感，无填充）→ L2 `drawFrame` 由描金矩形改为**切角 HUD 框**（外/内双框 + 四角卡扣括号）→ L3 星空三层（星数/采样/避让不变）→ L4 `drawRadar`（旋转扫描扇，缓存径向渐变）+ `drawScanBand`（垂直扫描带，缓存线性渐变）→ L5 `drawRoute` 能量管（青发光管 + 金核 + 流光虚线，共 3 次描边）→ L6 `drawNodes` 三态六边环（已点亮金环+双金星、进行中红环+脉冲、未解锁暗青环）。
- **`drawCompass` 删除**：罗盘玫瑰的方位职责并入 `drawRadarRing`（N/E/S/W 标签 + 刻度），grep 确认无残留引用。
- **`drawHudHint` 新增（视口固定，不在 view 变换内）**：切角小面板 + 青色操作提示文字。原因是 `<canvas type="2d">` 为原生层会盖住 DOM，旧 `.map-hint` 在星空模式本就不可见（潜在缺陷），现提示直接画进画布。
- **`utils/routeCanvas.js` 143 → 227 行（5 个纯新增 helper，零修改既有函数）**：`tracePath`（路径描边复用，消掉 hudMap 内 3 处内联重复）、`drawDashFlow`（虚线流光）、`drawHexRing`（单 beginPath 画外+内六边一次 stroke 成双环）、`drawScanSector`（扫描扇路径）、`drawHudPanel`（切角矩形路径）。ceremony/ticket 两个既有消费方依赖的 7 个导出函数未动。
- **每帧性能收敛**：`drawClouds` 由每帧 3 个 `createRadialGradient` 改为复用 `glowCyan` 离屏精灵（sprite 为 null 时保留原渐变降级路径）；雷达扫描与扫描带渐变**各只创建一次**并缓存；`drawNodes` 脉冲用 `globalAlpha` 而非每帧拼 rgba 字符串；路线三次描边共用 `tracePath`。
- **`pages/march/march.wxml`**：`.map-hint` 加 `wx:if="{{mode === 'real'}}"`（星空模式提示改由画布绘制，DOM 浮层只留实景模式）。
- **`pages/march/march.wxss`**：`.route-map` 增加 `background:#050B16`，与内核 L0 深空底一致，避免首帧前白闪。
- **`pages/march/march.js` 零改动**：S2 已把绘制全部收进内核，S3 的视觉重做完全落在内核 + WXML/WXSS，页面/内核边界不变。

## 验证结果

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| `tabbar-starmap.cjs` | **8/8 PASS** | TS-03 星空三层 far=110/mid=64/baked=true/glint=9/避让 0（与 S2 基线一致）；TS-04 整帧 1.05ms、星空 0.12ms（120 帧均值，远低于 16ms 预算）；TS-05 切走暂停/切回恢复且帧推进；TS-06 实景↔星空往返画布释放与重建；TS-07 星空点击节点进详情；TS-08 无新增异常 |
| `p0-march.cjs` | **6/6 PASS** | P0M-01 实景 nodes=10/markers=11/polylines=2/进度旗在；P0M-02 `hud.calcRouteProgress` 后端字段优先=0.7；P0M-03 降级步数比例=0.5；P0M-04 `hud.currentRatio`∈[0,1]；P0M-05 切 canvas 内核就绪；P0M-06 切回实景正常 |
| `p1-starry-march.cjs` | **4/4 PASS** | P1J-01 按钮「星空长征」+view{1,0,0}+星尘 22；P1J-02 捏合 scale=2.50、pan=(-220,-320) 在 [-585,0] 内；P1J-03 双击复位{1,0,0}+单击 (343,375) 命中进详情；P1J-04 粒子 14 颗/字段齐备/超时清除/整帧无异常 |
| `s16-review-smoke.cjs` | **16/18** | R4 实景→星空→实景：`{"hud":false,"glow":false,"mode":"real","markers":11}` 证明 `dispose` 释放内核与光晕精灵且 markers 重建；R7/R12 失败为**预存配置漂移**（见备注 1），不经过 hudMap |

### 与 S2 基线的逐项对照（几何/行为不变证据）

| 指标 | S2 基线 | S3 本次 | 结论 |
| --- | --- | --- | --- |
| P1J-01 view/星尘 | `{s:1,ox:0,oy:0}` dust=22 | 同 | 完全一致 |
| P1J-02 scale/pan/clamp | 2.50 / (-220.0,-320.0) / [-585.0,0] | 同 | 完全一致 |
| P1J-03 复位/命中点 | {1,0,0} / (343,375) | 同 | 完全一致 |
| P1J-04 粒子/清除 | 14 / true | 同 | 完全一致 |
| TS-03 far/mid/baked/glint/避让 | 110/64/true/9/0 | 110/64/true/9/0 | 完全一致 |
| TS-07 首节点屏幕坐标 | (343,375) | (343,375) | 几何未变 |
| P0M-01 nodes/markers/polylines | 10/11/2 | 同 | 完全一致 |
| TS-04 整帧/星空耗时 | 0.61 / 0.27 ms | 1.05 / 0.12 ms | 整帧因新增 L1/L4/L6 层略升但仍 ≪16ms；星空层因云改精灵更快 |

**视觉对照**：改造前 `test/images/s3-before-starry.png`（=S2 版 27-march-starry.png 备份）vs 改造后 `test/images/27-march-starry.png`、`starmap-01-twinkle-a/b.png`。改造前为蓝紫夜空渐变 + 填充剪影山峦 + 灰虚线路线 + 右上罗盘玫瑰 + 描金矩形边框；改造后为近黑深空底 + 切角 HUD 框与四角卡扣 + 同心雷达环与旋转扫描扇 + 青色等高线线框 + 细网格 + 青虚线引导 + 金能量管路线（发光管+金核+流光）+ 三态六边环节点 + 带边框标签面板 + 画布内切角操作提示。节点位置、路线走向、标签排布与改造前一致（几何未动），差异为整套仪器层与配色重做。

**静态校验**：`node --check` 对 `utils/hudMap.js`、`utils/routeCanvas.js` 通过；grep 确认 `hudMap.js` 内所有 `this.*`/`routeCanvas.*` 调用均指向已定义方法/已导出函数，`drawCompass` 无残留引用；`utils/routeCanvas.js` 既有 7 个函数体零改动（ceremony/ticket 无回归，ticket 页在 s16 R10 通过佐证）。

## 备注

1. **R7/R12 的 502 与本次无关**：本地后端 `.env` 配真实 `WX_APPID/WX_SECRET` 且未开 `WX_LOGIN_ALLOW_MOCK`，两条用例建临时 mock 用户时固定 code 被 code2Session 拒（automator 执行协议 #17）。R7 完成仪式页依赖的 `utils/routeCanvas.js` 本次仅新增 helper、既有函数零改动，且 ticket 页在 s16 R10 通过，共享绘制工具无回归。
2. **`tabbar-starmap-shots.cjs` 的 `tabbar-02-quiz.png` 条目仍指向已降级的 quiz tab**；本次以 `only` 参数只补拍 `starmap-01/02` 两张，该条目待另开任务修正。
3. **TS-04 整帧 0.61→1.05ms 属预期**：S3 新增雷达环/网格/扫描扇/扫描带/六边环等仪器层；1.05ms 仍远低于 16ms（60fps）预算，且 S5 还会加帧率自适应降级兜底。星空子层 0.27→0.12ms 证明云改离屏精灵的优化生效。
4. **`.map-hint` 改实景专属是修一个潜在缺陷**：`<canvas type="2d">` 为原生层盖住 DOM，星空模式下旧 DOM 提示本就不可见；现提示由 `drawHudHint` 画进画布（视口固定），实景模式仍用 DOM 浮层。
5. 工作区遗留的非本任务改动 `frontend/services/config.js`（`DEV_TARGET='local'`、`LAN_IP` 更新，本机联调配置）按「一个任务一个提交」排除在本次提交外。
6. 下一步 S4：实时数据叠加层 L7（今日参与/点亮/全员步数、我的进度环、三态图例）+ WS `data_changed` 触发的飞线 L8，联调依赖 S1 的 `/march/route-stats`（本地 8010 已重启加载）。
