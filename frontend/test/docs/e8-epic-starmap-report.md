# E8 星空长征史诗风视觉重构（E1~E7）测试报告

> 日期：2026-10-21 ｜ 范围：`frontend/pages/march` 星空模式 + `utils/starMap.js`（新内核）+ `data/star-themes.js`（新配置）
> 性质：纯前端视觉重构（推翻 HUD 仪器风，重做史诗风），**业务数据与接口契约零改动**
> 关联：`docs/迭代记录.md` 2026-10-21 段（E1~E7 七条）；本文档为汇总验收报告

---

## 1. 重构范围与提交

| 阶段 | 提交 | 内容 |
| --- | --- | --- |
| E1 | `2ca1800` | 新建 `data/star-themes.js`：PALETTE 全局配色、5 章节主题（雾带色/环境粒子/剪影装饰）、10 节点差异化历史图标折线集（纯视觉数据，无业务字段） |
| E2 | `618050f` | 新建 `utils/starMap.js` 渲染内核并接管星空模式（对外接口与 hudMap 全对齐，march.js 仅换 require）；深空星幕分层烘焙 + 红金路线 + 节点三态基础版；HUD 仪器层全部移除；L7 克制化（数据胶囊+进度环+图例+提示） |
| E3 | `c1b0271` | 章节区段氛围：突围峡谷折岭、翻越雪山尖峰、泸定铁索垂弧、延安地平线天光、赤水红色能量带（全部静态烘焙） |
| E4 | `4b4164f` | 节点四态强化（金双环/环绕粒子/关键节点刻度）+ 10 节点差异化历史图标接入；修复 2.5x 缩放标签重叠（字号按 1/view.scale 反调保持屏幕恒定 10px） |
| E5 | `e3d7f94` | 动画系统：进入时间线（完整 3200ms/精简 900ms，纯时间推导可中断可重入）、抵达解锁四阶段、延安页内终点仪式（3600ms）+ 常亮胜利光环；march.js 接 playFinale |
| E6 | `9fbf677` | 页内玻璃详情面板：focusNode 420ms 平滑聚焦 → 画布快照顶替原生层 → 面板滑入；关闭恢复原观景变换 + dismissIntro 防重播；面板复用 `march.getNodeDetail` |
| E7 | `db03385` | 删除旧内核 `utils/hudMap.js`（1519 行）与其失效文档；AGENTS.md 不变量 6、design.md §4.6 同步至史诗风口径；降级守卫逐点核对 |

## 2. 业务隔离核对（硬约束）

1. **10 节点 5 章节真实业务数据保留**：内核节点几何由 `routeCanvas.getCanvasNodePositions()` 按后端下发经纬度归一化计算，非硬编码；`star-themes.js` 的 `NODE_THEME_MAP` 按 route_nodes 主键绑定（管理端编辑章节归属后氛围跟节点走）。注入测试的节点坐标取自 `backend/app/data/seed.py` 真实配置。
2. **不伪造步数/积分/完成状态**：全部进度、状态、点亮、章节、仪式触发均读 `GET /march/route` 等后端响应；注入式测试（FAKE_ROUTE/FINALE_ROUTE）仅存在于 `test/automator/*.cjs` 模拟器测试态，不进入任何业务链路。
3. **既有功能零破坏**：微信运动同步（`handleSyncSteps`→`sport.syncToday`）、积分计算、节点点亮（`lightUpNodes` 幂等）、章节进度、勋章、排名相关代码路径零改动（`git diff` 仅涉 march 页四件套、starMap.js、star-themes.js 与测试资产）。
4. **接口契约未动**：`setRoute(route)`/`setStats(归一化)` 入参形状与 hudMap 时代一致，`loadOverlay` 归一化逻辑未改；WS 订阅/退订生命周期未改。

## 3. 验证结果

> 全部 automator 验证采用「渲染数据注入」口径：**远程后端 swkjdj.sz-watech.com 当日不可达（curl 三次 10s 超时）**，模拟器内注入路线数据（仅模拟器测试态、不动登录链路与业务数据）。真实数据链路回归待后端恢复后进行。

| 套件 | 结果 | 关键断言 |
| --- | --- | --- |
| `epic-shots.cjs`（E2~E4，E8 回归重跑） | ✅ 4/4 | 内核状态 `{"lowPerf":false,"perfAvg":16.7,"farStars":150,"midStars":90,"nearStars":34,"nebulas":5,"chapterZones":5,"envMotes":57,"staticLayer":true,"routeNodes":10}`；全景/1.8x 缩放/突围章特写（峡谷剪影、铁索、泸定桥图标）/会师章特写（天光、延安图标与关键刻度） |
| `epic-anim-shots.cjs`（E5） | ✅ 3/3 | 350ms 星幕淡入中段、1500ms 路线描画推进至金沙江（未到处节点 35% 暗态）、终点仪式 1800ms（重亮+汇聚中，状态 `{"finale":true,"particles":30,"finished":true}`） |
| `epic-panel-shots.cjs`（E6） | ✅ 2/2 | 面板打开 `{"open":true,"coverCanvas":true,"shot":true,"name":"飞夺泸定桥","chapter":"第三章 · 突围","ready":true}`；关闭恢复 `{"introSkipped":true,"scale":1.8,"running":true}`（观景变换恢复为聚焦值而非重置、入场动画不重播） |
| `node --check` | ✅ | starMap.js / march.js / 全部测试脚本 |

截图证据：`frontend/test/images/epic-01-overview.png` ~ `epic-06-panel-closed.png`、`epic-anim-01~03`。

**性能实测（模拟器）**：perfAvg 16.6~16.7ms（约 60fps），lowPerf=false；离屏静态层烘焙、光晕精灵预渲染、帧内零分配、粒子上限 64 均保持。模拟器为软件渲染，真机收益与降级触发需真机验收（见 §5）。

## 4. 已知问题与降级口径

1. **E6 两张截图分辨率偏低**：IDE 重启后模拟器窗口变小所致（epic-05/06 约 180px 宽，E1~E4 为 363px 宽），仅作状态存证，断言均通过。
2. **旧 HUD 内核 automator 套件失效（预期内）**：`tabbar-starmap.cjs`（far 110/mid 64 星数断言）、`hud-overlay.cjs`（L7 面板断言）、`hud-perf.cjs`（扫描带/六边环断言）针对已删除的 HUD 内核结构，视觉重构使其断言过期；`p0-march.cjs`、`p1-starry-march.cjs` 的通用接口部分（calcRouteProgress/view/hitTest/playArrive）在新内核仍对齐。套件处置（改写适配新内核或归档）留待后续独立任务。
3. **详情接口契约未在本次验证**：后端不可达期间 E6 面板史料字段经 `mergePanelNode`（即详情回包同一入口）注入验证；`getNodeDetail` 真实回包的面板补全待后端恢复后回归（接口契约由 node-detail 页既有功能覆盖，风险低）。
4. **`.qoder` 文档缺口**：`starMap.js`/`star-themes.js` 建档与 `march.js.md` 等 HUD 口径文档的全量重锚登记在 PROJECT.md §10「增量与缺口」（缺档 #12/#13，当前 183/196），为独立补档任务。

## 5. 待办（交接）

1. **业务联动回归**：后端恢复后，真机/模拟器走真实链路（登录 → 同步步数 → 点亮 → 章节 → 仪式 → 面板详情补全）完整回归一遍。
2. **真机验收**：低端机帧率与降级触发（S5 口径 30 帧均值 >33ms 粘性降级）、canvas 原生层与面板快照在真机同层渲染下的表现、电池/发热。
3. **失效 automator 套件处置**：改写 `tabbar-starmap`/`hud-overlay`/`hud-perf` 适配新内核，或归档为 HUD 时代历史套件。
4. **`.qoder` 补档**：starMap.js.md 建档 + march.js.md 全量重锚（PROJECT.md §10 缺口 #12/#13 与同节登记的漂移项）。
