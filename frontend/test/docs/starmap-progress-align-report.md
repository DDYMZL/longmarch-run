# 星空长征红线终点与节点点亮对齐修复报告（缺陷）

- 日期：2026-10-27
- 类型：缺陷修复（前端渲染层，无后端/SQL/admin 变更）
- 现象：星空长征地图中红色「已完成路线」与步数、点亮节点不符——累计 46000 步、「过草地」已点亮，红线终点却停在过草地**之前**。

## 1. 根因

两套进度口径不一致，同源于累计步数但刻度不同：

| 口径 | 计算方式 | 位置 |
| --- | --- | --- |
| 节点点亮 | 累计步数 ≥ 各节点 `target_steps` **阈值**（0/5000/10000/15000/20000/25000/35000/45000/55000/65000，前 5 段各 5000 步、后 4 段各 10000 步） | `backend/app/services/march_service.py` `_route_state` / `light_up_nodes` |
| 红线终点（修复前） | `routeProgress`（累计步数 / 末节点 65000）**直接乘采样点下标**：`endIdx = floor(ratio × (path.length − 1))` | `frontend/utils/starMap.js` `drawRoute` |

`routeCanvas.sampleRoutePath` 的采样点是**每段等分**的（每节点区间固定 30 子段、31 个点），因此「全程步数比例」与「路径位置比例」只在阈值等间距时才等价；本路线阈值不等间距，误差最大出现在中段。

实测（真实账号 45651 步 / 注入 46000 步，`path.length = 279`，过草地节点下标 217）：

| 步数 | 步数比例 | 旧口径终点下标 | 过草地下标 | 结果 |
| --- | --- | --- | --- | --- |
| 46000 | 0.7077 | **196** | 217 | 红线停在翻越雪山→过草地段内 32% 处，与「已点亮」矛盾 |
| 46000 | — | 220（新口径） | 217 | 红线过过草地、未到吴起镇（248），与点亮状态一致 |

顺带查出两处同源隐患：

1. `sampleRoutePath` 的 `nodePathIndex[n-1] = (n-1)×(segs+1) = 279` **越界**（`path` 合法下标 0~278）：章节区段能量带若对末章取该下标会读到 `path[279] === undefined`（现仅「转折」章走该分支故未爆），仪式页与入场动画对末节点的比较也永远取不到。
2. 入场动画里节点显现进度用「弧长比例」而红线笔尖用「下标比例」，两者口径不同（且未同步 easing），描画时节点亮早/亮晚半拍。

## 2. 修复

| 文件 | 改动 |
| --- | --- |
| `frontend/utils/routeCanvas.js` | 新增纯函数 `locateSegment(thresholds, value)`：在「按节点累计阈值」定义的路线轴上定位 `{seg, ratio, done}`；`sampleRoutePath` 的 `nodePathIndex` 末节点钳到 `path.length-1`；导出与文件 docstring 同步 |
| `frontend/utils/starMap.js` | 新增 `buildProgressScale()`（随 `buildGeometry` 重建 `progressMarks` 与 `litFloor`）、`pathRatio()`（步数比例 → 路径位置比例，逐段换算 + 已点亮节点为下限）、`framePathRatio()`（含入场 easing）、`endIdxOf()`（下标取整带 `1e-9` 容差）；`drawRoute` 改用上述换算，旗帜显隐条件改判笔尖位置；`drawNodes` 入场显现与红线共用同一笔尖口径；删除因此不再被引用的 `pathDist`/`pathLen` 字段（含 `dispose` 重置） |
| `frontend/pages/march/march.js` | `buildMapData` 的金色已完成折线改调 `routeCanvas.locateSegment`（与星空同口径），并同样以「最远已点亮节点」为下限；删除原内联逐段循环 |

口径要点：**步数达到某节点阈值 ⇔ 红线正好走到该节点坐标**；段内按段内进度线性推进；点亮永久保留，故微信运动回算导致步数回落时红线不退回已点亮节点之前；缺 `targetSteps` 时换算退化为旧的采样点等分（不报错）。

## 3. 验证

### 3.1 语法与静态检查

`node --check` 对 `utils/routeCanvas.js`、`utils/starMap.js`、`pages/march/march.js` 及两份新脚本全部通过。

### 3.2 纯函数口径校验（新增 `frontend/test/verify-progress-mapping.cjs`，Node 直跑）

`node frontend/test/verify-progress-mapping.cjs` → **6/6 PASS**

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| R-01 | 步数正好等于各节点阈值时，红线终点下标 == 该节点采样下标且坐标重合（遵义…延安逐点） | PASS |
| R-02 | 46000 步：新口径 endIdx=220 ≥ 过草地 217，旧口径 196 < 217（缺陷复现对照） | PASS |
| R-03 | 0~65000 步全程换算单调不减、值域 [0,1]、超程封顶 | PASS |
| R-04 | 步数回落到 20000（点亮记录仍在）时红线不退到已点亮过草地之前 | PASS |
| R-05 | 缺 `targetSteps` 时 `progressMarks=null`，换算退化为等分且不抛异常 | PASS |
| R-06 | 实景 `locateSegment` 与星空 `pathRatio` 在同一步数下段号与段内比例完全一致 | PASS |

### 3.3 微信开发者工具自动化（新增 `frontend/test/automator/starmap-progress-align.cjs`）

`node starmap-progress-align.cjs` → **6/6 PASS**（自动化端口 9420）

| 用例 | 断言 | 实测 |
| --- | --- | --- |
| SP-01 | **真实账号路线**：红线终点 ≥ 最远已点亮节点下标 | 45651 步 / 过草地：endIdx=219 ≥ 217 |
| SP-02 | 采样下标末节点不越界 | path.len=279，nodePathIdx[9]=278 |
| SP-03 | 注入 46000 步：红线已过过草地、未到吴起镇 | endIdx=220，过草地 217，吴起镇 248 |
| SP-04 | 旧口径确实在过草地之前（对照取证） | 旧 endIdx=196 |
| SP-05 | 逐节点阈值即到达 + 全程单调（页内实跑内核） | strictOk=true monoOk=true litFloor=0.6923 |
| SP-06 | 实景金色折线同口径：末点已过草地纬度 | points=9，末点 lat 33.915（过草地 33.58 / 吴起镇 36.93） |

视觉证据：`frontend/test/images/starmap-progress-46000.png` —— 星空模式下「累计 46000 / 65000 步 · 已点亮 8/10」，红色已完成路径覆盖至过草地与翻越雪山，行进旗落在过草地→吴起镇段内约 10% 处，与点亮数一致。

> 实景 `<map>` 为原生组件，automator 截图取不到其图层，故实景侧以 SP-06 的 `polyline` 数据断言为准。

### 3.4 既有回归套件

- `p0-march.cjs`：**6/6 PASS**（实景 markers=11/polylines=2/进度旗在；`calcRouteProgress` 后端字段优先 0.7、降级 0.5；`currentRatio`=0.7023 与真实 45651/65000 同口径；模式往返正常）。本次未改 `calcRouteProgress`/`currentRatio` 语义，断言原样通过。
- `p1-starry-march.cjs`：4 项中 3 项 FAIL（P1J-01 星尘 `dust=0`、P1J-03 双击命中期望跳 `node-detail`、P1J-04 抵达粒子 `cleared=false`）。**改动前基线复跑同样 3 项 FAIL、失败项与实测值完全一致**（`git stash` 三份源码后重跑），属 2026-10-21 星空史诗风重构遗留的过期断言（`e8-epic-starmap-report.md` §已登记「套件处置留待后续独立任务」），非本次引入。

## 4. 影响面与遗留

- 仅渲染层：不改接口契约、不改点亮判定与落库；实景与星空两模式共用新函数，后续若管理端调整节点阈值/增删节点，换算自动跟随（不再依赖等分假设）。
- 性能：`progressMarks`（10 元素）随 `setRoute` 重建一次，帧内只多一次 10 元素内的线性定位，无新增分配。
- 遗留（未夹带本任务处理）：① `p1-starry-march.cjs`/`hud-overlay.cjs`/`hud-perf.cjs`/`tabbar-starmap.cjs` 四套过期断言待独立改写；② `.qoder/` 文档按既有约定不在业务提交里夹带修订，本次改动使 `.qoder/frontend/utils/routeCanvas.js.md` 三处陈述失效，登记待下一次 .qoder 同步处理：§4.2「`nodePathIndex[i] = i*(segs+1)`」（末节点已改为钳到 `path.length-1`）、§4 函数表与 §4.3/§4.4 的行号（`distToIndex` 起整体 +30，`sampleRoutePath` 内部 +1，文件 239→270 行，导出 13→14 个）、§6 消费方清单（新增 `pages/march/march.js` 的 `locateSegment`，且 `utils/hudMap.js` 早已更名为 `utils/starMap.js`——该节漂移属既有欠账）。

