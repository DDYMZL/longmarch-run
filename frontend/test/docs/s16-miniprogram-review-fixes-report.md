# S16 小程序代码审查修复测试报告

日期：2026-10-11 · 范围：`frontend/` 全量代码审查（逻辑正确性、冗余清理、大数据量渲染性能）+ 配套后端 `POST /api/march/light-up` 返回 `newMedals`

## 1. 改动摘要

### 1.1 逻辑缺陷修复

| 位置 | 问题 | 修复 |
| --- | --- | --- |
| `pages/home` | `refreshAll` 并发（onShow + 同步完成后刷新）时旧请求晚到会覆盖新数据 | `_refreshRequestId` 守卫 then/catch 两支 |
| `pages/march` | 从子页返回 Tab 时星空画布动画不恢复；开场动画被 onHide 打断后计时器丢失 | `onShow` 先恢复 `startAnim`；`onHide` 清理并置空 `_introTimer`，`maybePlayIntro` 补启 |
| `pages/march` | 星空→实景切换后仍持有已销毁画布及离屏缓存；实景 markers 用旧路线 | 切实景时释放 ctx/canvas/staticLayer/glow/arriveFx，并用最新路线重建 |
| `pages/ceremony` | 动画播放中切后台再回来动画停住 | `onShow` 续播（未收尾时） |
| `pages/org-select` | 层级快速下钻时旧层响应覆盖新层；确认按钮可重复提交 | `_levelRequestId` 守卫 + `_selecting` 防重入 |
| `pages/quiz-answer` / `quiz-result` / `person` / `org-select` | 缺登录守卫，冷启动直达会无 Token 请求 | 统一 `app.globalData.loggedIn` 守卫回启动页 |
| `pages/quiz-answer` / `quiz-result` | 页面卸载后计时器仍 setData | `_animTimer` / `_timers` / `_scoreTimer` 在 onUnload 清理 |
| `pages/rank` | 下拉刷新立即停 spinner；失败清空已有榜单 | 刷新完成后停 spinner；失败保留旧数据并提示 |
| `services/ws.js` | 页面全部退订后连接仍常驻、断线仍无限重连；旧连接迟到回调会重置新连接状态 | 无订阅者 30s 空闲关闭且不重连；回调按连接实例隔离 |
| `utils/util.formatTime` | 后端 naive UTC 时间按本地时区解析偏 8 小时 | 统一走 `parseUtc` |

### 1.2 冗余清理

- 删除无引用的 `services/points.js`、`medal.checkAndGrant`、`sport.DAILY_TARGET`、`node-themes` 导出的 `THEMES`。
- 删除 `home` 的 `totalSteps`/`nextNode` 与 `playLitPopup` 包装，以及 `march` 的 `chapters`、`nodePathIndex`、空 `onReady`。还删除了 `ceremony` 的 `_staticMode` 与重复的 `drawFrame(99)`，以及 `ticket` 的本地 `roundRect`（复用 `routeCanvas.drawRoundRect`）。
- 事件图标映射抽到 `util.EVENT_ICONS` / `eventIcon()`，播报与档案页共用。
- 离屏光晕精灵抽到 `routeCanvas.createGlowSprite`，长征页与仪式页共用。
- 开场动画 Storage 读写收归 `services/march.js`（`hasPlayedIntro` / `markIntroPlayed`），页面不再直接访问 Storage。

### 1.3 性能（大数据量）

- **少一次请求**：点亮后不再单独请求 `POST /medal/check`；后端 light-up 在同一事务内判定勋章，并返回 `newMedals`。
- **首页**：只做一次合并 setData；步数没变化时跳过滚动动画；同行者头像 `lazy-load`。
- **长征页**：
  - `nodes` 只下发列表渲染需要的 6 个字段（`toViewNode`）；
  - 节点 id→索引改为 Map（`nodeIndex`），粒子与抵达特效不再做 O(n) 查找；
  - 当前章节只下发单个对象。
- **答题页**：题目和作答保存在逻辑层，不进 data，选择选项时不再整体传输题目。
- **答题记录**：只映射展示所需字段。
- **列表 key**：勋章与星级改为 `{id,…}` 结构，以 `wx:key="id"` 稳定 diff。
- **仪式页**：天空渐变按状态缓存；光晕改用离屏精灵 drawImage，替代每帧新建径向渐变。
- **排行榜**：头像 `lazy-load`。

## 2. 验证结果

| 套件 | 方式 | 结果 |
| --- | --- | --- |
| `test/automator/s16-review-smoke.cjs` | 微信开发者工具（自动化端口 9420）+ 本地后端 8010 真实页面 | **18/18 通过**，全程无页面异常 |
| `test/ws-idle-check.cjs` | Node 虚拟时钟模拟 `wx.connectSocket` | **8/8 通过** |
| `test/auth-flow-check.cjs` | 登录状态机回归 | 11/11 通过 |
| `test/wxml-balance-check.cjs` | WXML 标签配平 | 全部 OK |
| `node --check` | 所有改动 JS | 通过 |
| 后端黑盒回归 | p0_chapters / p0_route_progress / p2_ceremony / p1_footprints / p1_activities / p1_portrait / s2_streak_events / s3_aggregates / e2e_datasync | 10/10、10/10、4/4、4/4、7/7、3/3、8/8、15/15、23/23 |
| light-up `newMedals` | mock 用户 sync → light-up → 再次 light-up | 响应键 `newlyLit,newlyCompletedChapters,newMedals`；重复调用幂等（空列表） |

### 2.1 开发者工具冒烟明细（s16-review-smoke）

| 编号 | 场景 | 结果 |
| --- | --- | --- |
| R1 | 冷启动经启动页自动登录到首页，合并 setData 后数据完整、无冗余字段 | PASS（lit=5/10，寄语卡展示） |
| R2 | 首页连续两次 refreshAll，只采纳最后一次 | PASS |
| R3 | 长征页节点精简为 6 字段、当前章节卡含 progressPct、markers 11 个 | PASS |
| R4 | 实景→星空→实景：画布和离屏缓存已释放，markers 重建 | PASS |
| R5 | marker 选中节点（toViewNode），列表节点点击 data-id 跳详情 | PASS（id=2） |
| R6 | 子页返回长征 Tab，onShow 恢复动画 | PASS |
| R7 | 完成仪式（临时 mock 用户 +70000 步走完全程）：动画、切后台续播、跳过收尾 | PASS |
| R8 | 排行榜下拉刷新，条数保持 | PASS（100 条） |
| R9 | 我的页勋章 `{id,icon}` | PASS |
| R10 | 日历 / 档案 / 账号 / 答题记录（字段精简）/ 人物志 / 组织选择 / 纪念票页面打开 | 7 项 PASS |
| R11 | 今日未答题直达结果页，回退答题页 | PASS（预期分支） |
| R12 | 答题全流程（临时 mock 用户）：5 题 → 提交 → 结果页分数滚动、星级 = round(score/20)、离开清理 | PASS（60 分 3 星） |

## 3. 遗留与说明

- R7/R12 使用临时 mock 用户（只在测试期间替换开发者工具 Storage 里的 Token，结束后恢复），开发者工具主用户的数据不受影响。
- `newMedals` 在本地验证中为空列表：步数类勋章已在 `/sport/sync`、`/sport/add` 副链路发放，light-up 只补发点亮/章节相关勋章。前端处理分支（无点亮但有新勋章时提示「获得新勋章！」）与原先 `checkAndGrant` 的行为一致。
- 真机微信运动同步链路不在本轮范围，沿用 V1.1 真机验收计划。
