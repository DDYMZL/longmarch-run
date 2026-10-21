# S5 验收报告 · 星空长征帧率自适应降级（L4 扫描带 + 点亮粒子的自动关停）

- 日期：2026-10-21
- 范围：深空 HUD 科技感地图五阶段方案的 **S5**——在 S4 视觉/数据基线上加入帧率自适应降级：
  滚动 30 帧间隔均值 >33ms（即 <30fps）时置 `lowPerf`，关掉 L4 水平扫描带与点亮粒子扩散，
  雷达扇形、L5 金色流光与全部叙事/数据层保留，**降级不自动恢复**。
- 环境：微信开发者工具模拟器 + miniprogram-automator（ws://127.0.0.1:9420），后端本机 8010
  （`frontend/services/config.js` 的 `DEV_TARGET='local'`，工作区未提交残留），本地 openGauss 5118。

## 1. 改动摘要

| 文件 | 变化 | 内容 |
|---|---|---|
| `frontend/utils/hudMap.js` | 1459→1519 行 | 新增帧率自适应降级：常量 `PERF_WINDOW=30`/`PERF_BUDGET_MS=33`/`PERF_GAP_MS=1000`；实例状态 `lowPerf` + `_perfBuf/_perfI/_perfN/_perfSum/_perfLast/_perfAvg`（创建期一次性分配环形缓冲）；`samplePerf(t)` 增量维护和值（覆盖槽位先减旧值，每帧 O(1)、零分配），满窗才判定、`>PERF_GAP_MS` 的间隔视为暂停/切后台的时间跳变丢弃；`draw(t)` 首行挂钩采样；两处守卫 `if (!this.lowPerf)`（L4 扫描带、点亮粒子扩散，粒子守卫放在绘制侧以覆盖动画中途才判定出的降级）；`dispose` 复位全部采样状态。文件头 docstring 增「帧率自适应降级（S5）」段 |
| `frontend/test/automator/hud-perf.cjs` | 新增 | PD-01~PD-12 白盒断言（断言专用，不截图） |
| `frontend/test/automator/hud-perf-shots.cjs` | 新增 | perf-01/02 对照截图补拍（与断言分离） |

边界不变量保持：降级逻辑全在渲染内核，页面 `march.js` **零改动**（`startAnim` 传入的 `t` 即采样源）；
内核仍不 require 任何 service、不读 Storage、不 `setData`；配色铁律不受影响（关掉的只是氛围层）。

## 2. 验证结果

| 套件 | 结果 | 说明 |
|---|---|---|
| `hud-perf.cjs`（新增，S5 主验收） | **12/12** | 见 §2.1 明细 |
| `tabbar-starmap.cjs`（S2/S3 回归） | **8/8** | TS-03 关键值与 S3/S4 一致（far 110/mid 64/baked/glint 9/nearNode 0）；TS-04 整帧 0.74ms、星空子层 0.07ms；TS-07 命中 (343,375) |
| `p0-march.cjs` | **6/6** | 实景/星空往返与进度链路不变（ratio=0.15913846153846153） |
| `p1-starry-march.cjs` | **4/4** | 捏合钳制 2.50/pan(-220,-320)/命中 (343,375)/粒子 14，与 S2~S4 基线一致 |
| `hud-overlay.cjs`（S4 回归） | **10/10** | OV-06 预算不变（fillText 22.0/drawImage 13.0/stroke 43.0，整帧 1.49ms） |

### 2.1 PD 明细

| 用例 | 断言 | 实测 |
|---|---|---|
| PD-01 | 真实 rAF 满窗采样不降级 | `lowPerf=false n=30 avg=16.633 bufLen=30` |
| PD-02 | 30 帧均值 40ms > 33ms 触发降级 | `lowPerf=true n=30 avg=40.000` |
| PD-03 | 降级后帧间隔回到 8ms 仍降级且停止采样 | 30 帧 8ms 后 `n/avg/sum` 逐字节不变（30/40.000/1200.000） |
| PD-04 | 首帧不计数；>1s 时间跳变丢弃 | 首帧后 `n=0`；5s 跳变后 `n=0 avg=0`；随后 30×40ms 正常降级 |
| PD-05 | 满窗才判定 | 第 29 帧 `{false,29,0}` → 第 30 帧 `{true,30,100.000}` |
| PD-06 | L4 扫描带关闭 | `fillRect` 每帧 3.00→1.00，Δ=**2**（恰为扫描带的两次 fillRect） |
| PD-07 | 叙事/数据层不受影响 | `stroke` 43→43、`fillText` 22→22、`drawImage` 13→13 |
| PD-08 | 点亮粒子关闭 | `arc` 每帧 122→108，Δ=**14** = 粒子数 14 |
| PD-09 | 每帧预算 <16ms | 常态 0.783ms / 降级 0.742ms |
| PD-10 | dispose 复位与实例重建 | 释放耗时 1261ms 后 `hud` 置空；重建实例无旧标记、`lowPerf=false bufLen=30` |
| PD-11 | 重建后真实 rAF 复测 | `n=30 lowPerf=false avg=16.667` |
| PD-12 | 全程无运行时异常 | 0 |

## 3. 性能与每帧预算

- 整帧（`tabbar-starmap` TS-04，120 帧均值）**0.74ms**（S4 为 1.13~1.15ms，本机当轮更快）；
  `hud-overlay` OV-06 在页面 rAF 并发下 1.49ms，均 ≪16ms。
- PD-09 同步驱动 120 帧：常态 0.783ms、降级 0.742ms，Δ=0.042ms。
  **注意**：该 Δ 只反映 L4 扫描带（`benchFrames` 会清空 `arriveFx`，粒子收益未计入），且模拟器为软件渲染、
  两层氛围绘制本就极轻；**降级的真实收益需在真机（GPU/低端机）上度量**，见备注 4。
- 采样器自身开销：每帧一次减法+一次加法+一次比较，O(1) 零分配，不产生任何对象。

## 4. 截图（`frontend/test/images/`）

两张图刻意冻结在**同一合成时间戳 T=4.5s**（`SCAN_S=9` 的一半，扫描带正好在画面中部）且都在
`playArrive` 后 450ms 抓帧（粒子 delay 0.2~0.4s 已全部可见，实测两帧 `particles=14`），故逐像素可比：

| 文件 | 内容 |
|---|---|
| `perf-01-normal.png` | 常态：L4 水平扫描带横贯画面中部 + 四渡赤水处金色粒子扩散；雷达扇形、L5 流光、六边环节点、L7 面板/16% 仪表环/底部提示齐备 |
| `perf-02-degraded.png` | 降级：扫描带与粒子消失；雷达扇形、金色路线、节点、L7 面板、仪表环、提示**与常态完全一致** |

## 5. 备注

1. **首轮 9/12 的三条失败均为测试脚本缺陷，非内核缺陷**，已修复后复跑 12/12：
   ① PD-06/PD-08 的 `countCalls` 强制 `lowPerf=false` 时未清空上一轮遗留的 30×100ms 采样窗口，
   `samplePerf` 在第二帧即把 `lowPerf` 重新置真（正是「不自动恢复」语义），导致被守卫层只画了一帧
   （Δ 表现为总量 2/14 而非每帧 2/14）；修复为强制设定 `lowPerf` 时一并复位采样窗口。
   ② PD-10 原用固定 `sleep(1000)` 等待释放，而 `switchMode` 是先同步 `stopAnim`、再在 `setData` 回调里
   `dispose + 置空 this.hud`——实测 `data.mode` 约 400ms 翻转、`hud` 约 800~1261ms 才置空，固定 sleep 必输；
   改为轮询。同时重建后页面 rAF 立刻起转，`_perfN=0` 不可观测，故「新实例」改用标记物证（旧内核打 `__pdTag`，
   重建后标记必须消失）、「降级不跨实例继承」用 `lowPerf=false` 证。
2. **本地库「今日」数据已过期**：S4 报告插入的 `daily_sport` 种子 date=2026-10-19，本轮验收日为 2026-10-21，
   故 OV-01 与两张截图中 L7 面板读 `0/0/0`；`litMap`/徽标来自路线进度，不受影响（`litMap=10`、`badgeKeys=10`）。
3. **环境修复**：验收前发现 Docker Desktop 与 `longmarch-opengauss` 容器已停（机器连续运行两天），
   5118 拒绝连接导致登录链路全断；已启动 Docker Desktop 并 `docker start longmarch-opengauss` 恢复（容器 healthy）。
4. **真机验收未完成**：降级阈值（30fps）与降级收益需在真实低端机上度量，须人工扫码进入真机调试；
   本次授权范围仅覆盖开发者工具模拟器。真机结论待补。
5. `frontend/services/config.js` 的 `DEV_TARGET='local'`/`LAN_IP` 仍为工作区未提交残留（联调约定），不入库。
6. 下一步：真机验收补测 + `.qoder/frontend/utils/hudMap.js.md` 与 `frontend/design.md` §4.6 同步。
