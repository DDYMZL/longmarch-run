# S4 验收报告 · 星空长征实时数据叠加层（L7）与 WS 飞线（L8）

- 日期：2026-10-19
- 范围：深空 HUD 科技感地图五阶段方案的 **S4**——在 S3 视觉基线上叠加全员实时数据层（L7）与
  WS 事件飞线（L8），数据来自后端 `/march/route-stats`（S1 新增）与 `/broadcast/today`。
- 环境：微信开发者工具模拟器 + miniprogram-automator（ws://127.0.0.1:9420），后端本机 8010
  （`frontend/services/config.js` 的 `DEV_TARGET='local'`，工作区未提交残留），本地 openGauss 5118。

## 1. 改动摘要

| 文件 | 变化 | 内容 |
|---|---|---|
| `frontend/utils/hudMap.js` | 1218→1459 行 | 新增 L7/L8：`setStats`（数值一次性格式化，帧内零分配）/`playFlyLine`/`drawOverlay`（左上全员数据切角面板三行 + 右上「我的进度」仪表环 + 左下三态图例，视口固定）/`drawFlyLine`（青蓝数据包沿采样路线飞向目标节点，尾迹 8 点 + 抵达信号环，`FLY_MS=1400` 自清）；`drawNodeLabel` 在缩放 ≥`BADGE_ZOOM`(1.5) 时把全员抵达人数并入已点亮/当前节点标签（同一次 fillText）；`buildGeometry` 存 `nodePathIdx`；`dispose` 清理 `stats/flyLine/nodePathIdx/_ringPct/_ringText`；新增常量 `CYAN_HEX/OVERLAY_ROWS/OVERLAY_W/OVERLAY_H/RING_R/LEGEND/LEGEND_STEP/FLY_MS/BADGE_ZOOM` 与 `fmtNum`；文件头 docstring 升级为九层（L0~L8）与预算口径 |
| `frontend/utils/routeCanvas.js` | 227→239 行 | 纯新增第 13 个导出 `drawArcGauge`（仪表环值弧，只建路径不落笔）；既有 12 个导出零改动 |
| `frontend/services/march.js` | +12 行 | `getRouteStats()` → `GET /march/route-stats`（S1 契约），加入导出 |
| `frontend/pages/march/march.js` | 654→721 行 | `onShow` 订阅 WS、`onHide`/`onUnload` 经 `unsubscribeWs` 退订；`handleWsMessage`（`data_changed` 5s 节流后仅重拉全员统计、`activity` 转 `hud.playFlyLine(msg.nodeId)` 不发请求）；`loadOverlay`（仅星空模式发起、非阻塞、`Promise.all` 合并两接口为归一化入参、失败保持 last-good）；`refresh` 与 `switchMode→canvas` 触发；`initCanvas` 用 last-good 即时上屏 |
| `frontend/test/automator/hud-overlay.cjs` | 新增 | OV-01~OV-10 白盒断言（断言专用，不截图） |
| `frontend/test/automator/hud-overlay-shots.cjs` | 新增 | overlay-01~05 截图补拍（与断言分离） |

边界不变量保持：渲染内核仍不 require 任何 service、不读 Storage、不 `setData`；两接口响应只在页面合并，
内核只认 `{ todayUsers, todayLit, todaySteps, litMap }` 归一化入参；配色铁律扩展为「L7/L8 数据元素属仪器青蓝」。

## 2. 验证结果

| 套件 | 结果 | 说明 |
|---|---|---|
| `hud-overlay.cjs`（新增，S4 主验收） | **10/10** | 两轮全绿：种子前（`lines=["0","1","0"]`）与种子后（`lines=["8","3","5.1万"]`，`raw=[8,3,50900]`，`litMap=10=nodes`，`badgeKeys=10`） |
| `tabbar-starmap.cjs`（S2/S3 回归） | **8/8** | 第 3 次运行全绿；前两次各 1 条偶发（见备注 2），TS-03/TS-04 关键值与 S3 一致（far 110/mid 64/baked/glint 9/nearNode 0；frame 1.13~1.15ms、stars 0.09~0.12ms） |
| `p0-march.cjs` | **6/6** | 实景/星空往返与进度链路不变（ratio=0.1591） |
| `p1-starry-march.cjs` | **4/4** | 捏合钳制 2.50/pan(-220,-320)/命中 (343,375)/粒子 14，与 S2、S3 基线一致 |

OV 明细（种子后一轮）：OV-01 两接口合并注入且抵达统计覆盖全部 10 节点；OV-02 `setStats(null)` 后面板画
`--` 且 `drawOverlay` 不抛异常、last-good 可复原；OV-03 仪表环 `16%` 与 `routeProgress=0.1591` 同口径且整数未变不重建字符串；
OV-04 飞线定位 `idx=3` 正确、未知节点 999999 静默忽略、1.9s 后自清；OV-05 缩放 1 标签无徽标、缩放 2 仅 4 个已点亮/当前节点并入（`瑞金 87`/`遵义 62`/`四渡赤水 34`/`巧渡金沙江 25`）；
OV-06 预算达标；OV-07 订阅/退订/重订阅随生命周期；OV-08 `data_changed` 第二次被节流（`_statsAt` 不变）、`activity` 只画飞线（`_statsAt` 不变）；
OV-09 实景模式 `loadOverlay` 直接 resolve（`_statsAt` 保持 0）且 last-good 保留；OV-10 全程无运行时异常。

## 3. 性能与每帧预算

- 整帧（`tabbar-starmap` TS-04，120 帧均值）：**1.13~1.15ms**（S3 为 1.05ms，L7/L8 增量 ≈0.1ms，仍 ≪16ms）；星空子层 0.09~0.12ms 不变。
- `hud-overlay` OV-06 在页面 rAF 循环并发下测得 2.45ms/帧（含主线程竞争），同样 ≪16ms。
- 预算实测（OV-06 对 `ctx` 打点计数）：`fillText` **22.0**（= 预算上限：节点标签 10 + 操作提示 1 + L7 面板 6 + 仪表环 2 + 图例 3）、`drawImage` **13**（≤30）、`stroke` 43（均为仪器短弧/六边环，长折线描边仍为 L5 的 3 次）。
- 帧内零分配保持：L7 数值在 `setStats` 时格式化为显示串，仪表环百分比按整数变化缓存，飞线尾迹透明度走 `globalAlpha`。

## 4. 截图（`frontend/test/images/`）

| 文件 | 内容 |
|---|---|
| `overlay-01-hud.png` | 星空常态：左上全员面板（今日参与 8 / 今日点亮 3 / 全员步数 5.1万）、右上 16% 仪表环、左下三态图例、底部操作提示，四者视口固定 |
| `overlay-02-flyline.png` | L8 飞线飞行中：青蓝数据包（白热核心 + 双层光晕 + 信号环）沿路线飞向翻越雪山，尾迹点列可见 |
| `overlay-03-badge.png` | 缩放 2 倍：已点亮/当前节点标签并入全员抵达人数（四渡赤水 34 / 遵义 62 / 巧渡金沙江 25），面板与仪表环不随缩放移动 |
| `overlay-04-nodata.png` | 数据缺失降级：面板三行显示 `--`，其余层不受影响 |
| `overlay-05-real.png` | 实景模式对照：叠加层随画布释放，DOM 提示条与信息卡正常 |

## 5. 备注

1. **本地库种子**：为让 L7 面板呈现真实非零数据，向本地 openGauss 插入 `daily_sport` 8 行
   （date=2026-10-19，user_id 264~271，步数 2500/3200/4600/5400/6300/7800/9100/12000，合计 50900）。
   仅本地开发库、保留以便复现截图；未触碰远程/生产库。种子前一轮断言同样 10/10（数值为 0/1/0）。
2. **两条偶发失败与 S4 无关**：一次 TS-02 为自动化桥「timeout waiting for automator response」（重跑即过）；
   一次 TS-03 的 `freqs=58 < 60` 阈值失败——该阈值依赖构建期 64 颗星的随机频率去重数，属既有 flaky 断言。
   两次失败当轮 TS-08（无运行时异常）均通过。
3. `frontend/services/config.js` 的 `DEV_TARGET='local'`/`LAN_IP` 仍为工作区未提交残留（联调约定），不入库。
4. **WS 真实推送链路未做端到端触发**：需第二个客户端产生业务事件才能收到 `activity`/`data_changed`；
   本次以白盒方式断言页面两分支（OV-08）与订阅生命周期（OV-07），`services/ws.js` 本身已被首页链路覆盖。
5. 下一步 S5：帧率自适应降级（滚动 30 帧均值 >33ms 关 L4 扫描与 L8 粒子、不自动恢复）+ 真机验收。
