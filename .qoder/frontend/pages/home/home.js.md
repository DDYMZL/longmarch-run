# home.js（首页 · 页面级合一：home.js / home.wxml / home.wxss / home.json）

## 1. 文件路径

- `frontend/pages/home/home.js`（409 行）
- `frontend/pages/home/home.wxml`（305 行）
- `frontend/pages/home/home.wxss`（862 行）
- `frontend/pages/home/home.json`（5 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

小程序**默认落地 tabBar 页**与数据枢纽：以「今日行军卡 → 今日寄语 → 迷你长征路线 → 连续行军 → 今日长征情报 → 长征记忆 → 勋章行 → 实时行军动态 → 组织同行 → 集体长征 → 全员同行」的卡片流聚合展示 11 路后端数据（`home.js:1-6` 头注释、`:151-289`）；承载唯一的微信运动步数同步入口（`handleSyncSteps`，`:312-353`）与全仓唯一的 WebSocket 页面订阅（`:121-146`）。

**入口证据**：`app.json` `pages` 数组第 2 位为 `pages/home/home`（`frontend/app.json:4`，第 1 位是启动页 launch，`:3`）；tabBar `list` 首项即首页（`app.json:42-47`，5 个 tab 顺序：首页/长征/AI 问答/排行/我的）。冷启动实际路径是 launch 页自动登录通过后 `wx.switchTab({ url: '/pages/home/home' })`（`frontend/pages/launch/launch.js:18`、`:125`、`:131` 失败兜底同跳首页）。

## 3. 业务需求

首页是逐批次叠加而成的聚合页，各卡片对应的需求批次（提交号均见于 `docs/迭代记录.md` 对应条目）：

| 区块 | 需求 | 交付提交 |
|---|---|---|
| 卡片流总体结构（今日行军/迷你路线/情报/记忆/勋章） | 页面高级化升级（首页重组） | `7e587c9`（2026-10-02） |
| 今日行军状态分档文案 + 连续行军 | P0-2（`home.js:20-26` 注释标需求 §6.3/6.4） | `81a1b66` |
| 抵达事件卡 / 章节完成仪式弹层 | P0-3 长征章节系统 | `6a2fae3` |
| 实时行军动态（REST + WS） | P1-1（`:85` 注释标需求 §8） | `17a4d98` |
| 组织同行 | P1-2（`:87` 注释标需求 §9） | `f37e3d7` |
| 集体长征 | P1-3（`:94` 注释标需求 §10） | `b4a8910` |
| 全员同行 | P1-4（`:101` 注释标需求 §11） | `c92598c` |
| 今日寄语卡 | P2-1（`:79` 注释标需求 §16） | `71d1b9b` |
| 活动未进行中横幅 | V2.0 活动状态与查看拦截 | `44eb77b` |
| 情报卡改页内跳转（答题降级为子页） | AI 问答 tab 替换情报 tab | `0052108`（2026-10-17） |

## 4. 核心功能（home.js）

### 4.1 模块级纯函数（`:28-40`）

- `activityBanner(s)`（`:28-33`）：活动状态 → 横幅视图模型。`s` 为空或 `allowParticipate` 为真返回 `null`（不展示）；`status === 'ended'` 返回 `{tag:'已结束', text: endTitle + ' · 成绩可查看，不再计分'}`；其余（未开始等）用 `s.statusText` 作 tag、`s.message + formatRange(s)` 作 text（`:31` 调 `activity.formatRange`）。
- `marchStatusText(steps, goal, target)`（`:35-40`）：四档状态文案，**按真实数据分档、不随机生成**（`:20-26` 注释标需求 §6.3/6.4）：0 步→「今天还没有开始行军」；≥target→「今日行军目标已完成」；≥goal→「今日连续行军目标已完成」；其余→「正在向下一站前进」。goal 即后端下发的 `streakGoal`（5000），target 为 20000（`.qoder/frontend/services/sport.js.md` §4.1：target 由 sport.js 服务边界强制覆盖为 20000）。

### 4.2 `data` 状态字段（`:43-112`，按关注点分组）

| 分组 | 字段 | 来源 |
|---|---|---|
| 用户 | `user`（`:44`） | `app.globalData.user`（onShow `:120`） |
| 今日行军 | `todaySteps/dailyTarget(初值20000)/stepPercent/marchStatus/syncing/syncError`（`:46-51`） | `sport.getToday` + `animateSteps` + 同步流程 |
| 今日播报（个人） | `beatPercent/remainToNext/nextNodeName`（`:53-55`） | `broadcast.getToday` 的 `personal` 段（`:201-203`） |
| 长征路线 | `routeLoading(初值true)/routeError/litCount/totalCount(初值10)/finished/routeNodesPreview`（`:57-62`） | `march.getRoute`（`:206-211`，preview 取前 6 节点） |
| 连续行军 | `currentStreak/streakGoal(初值5000)/todayGoalCompleted/nextStreakMilestone/streakRemain`（`:64-68`） | `sport.getToday`（`:195-199`） |
| 今日情报 | `quizCompleted/quizCorrect/quizTotal(初值5)/quizPoints/quizRemain(初值5)/quizStarted/issueNo`（`:70-76`） | `quiz.getDaily`（`:213-219`；`quizRemain` 为 progress 中 pending/answering 计数，`quizStarted` 为存在非 pending 项） |
| 长征记忆 | `memory`（`:78`） | `broadcast.getToday` 的 `memory` 段（`:204`，可为 null） |
| 今日寄语 | `quote`（`:80`） | `quote.getToday`（`:225`，无 content 时置 null 隐藏卡片） |
| 勋章行 | `medalPreview/medalOwned/medalTotal`（`:82-84`） | `medal.getMedalList`（`:184-187`、`:221-223`） |
| 实时行军动态 | `activities`（`:86`） | REST `broadcast.getActivities(6)` + WS 增量（§4.4/§4.5） |
| 组织同行 | `orgChecked/orgName/orgFullName/memberCount/orgTodayStepsText/companions`（`:88-93`） | `org.getCompanions(6)`（`:233-248`） |
| 集体长征 | `omProgress/omTotalText/omCurrent/omNext/omFinished/omNodes`（`:95-100`） | `org.getOrgMarch`（`:250-264`） |
| 全员同行 | `ggTotalText/ggProgress/ggNextName/ggRemainText/ggAllDone/ggMilestones`（`:102-107`） | `march.getGlobalGoal`（`:266-279`） |
| 弹层/横幅 | `litPopup`（`:109`，由 arrivePopup 模块写入）、`activityBanner`（`:111`） | 同步流程 / `activity.getStatus`（`:226`） |

页面实例属性（非 data）：`_wsUnsub`（`:121`）、`_refreshRequestId`（`:153`）、`stepsTimer`（`:306`）、`popupTimer`（由 `arrivePopup.playArriveQueue` 回写，`.qoder/frontend/utils/arrivePopup.js.md` §4.3）。

### 4.3 生命周期（无 onLoad）

- **`onShow`（`:114-125`）——冷启动与回场唯一入口**：① 登录守卫：`app.globalData.loggedIn` 为假即 `wx.reLaunch('/pages/launch/launch')` 并 return（`:116-119`；守卫约定见 `frontend/AGENTS.md` §4 不变量 5）；② `setData({user})`（`:120`）；③ 幂等订阅 WS：仅 `!this._wsUnsub` 时 `ws.subscribe`（`:121-123`）；④ `refreshAll()`（`:124`）。**刷新策略 = 每次 onShow 全量重拉 11 路接口**，无本地缓存、无节流（不变量 1「数据展示页必须 onShow + refresh」的落点）。冷启动没有单独的 onLoad 逻辑，首帧渲染 data 初值（`routeLoading: true` 显示「路线加载中…」，`home.wxml:104`）。
- **`onHide`（`:127-131`）与 `onUnload`（`:133-137`）内容完全相同**：清 `stepsTimer`（clearInterval）、清 `popupTimer`（clearTimeout）、调 `_wsUnsub()` 退订 WS 并置 null。tab 页常态是切 tab 触发 onHide 不触发 onUnload；reLaunch 回启动页时触发 onUnload。

### 4.4 `refreshAll()`（`:151-289`）——并发聚合刷新

- **请求序号守卫**（`:153-154`、`:169`、`:286`）：自增 `_refreshRequestId`，`then/catch` 里序号不等于当前值即丢弃——onShow 与同步后刷新并发时只采纳最后一次结果（`:152` 注释；`e70b59f` 引入，`.qoder/frontend/services/request.js.md` §4.9 末段同述）。
- **`Promise.all` 11 路**（`:155-167`）分两类：**前 5 路为关键数据、不带 catch**——`sport.getToday`/`march.getRoute`/`quiz.getDaily`/`broadcast.getToday`/`medal.getMedalList`，任一失败整个 all reject，走 `:285-288` 置 `routeLoading:false` + `routeError:'数据加载失败，请稍后重试'`（WXML `:105` 在路线卡内展示该文案）；**后 6 路各自 `.catch(() => null)` 独立降级**——`broadcast.getActivities(6)`（`:161` 行内注释「动态流失败不阻塞首页主数据」）、`org.getCompanions(6)`、`org.getOrgMarch`、`march.getGlobalGoal`、`quote.getToday`、`activity.getStatus`（`:162-166`）。返回 null 的区块**跳过 patch、保留旧值/初值**（`:229`、`:233`、`:250`、`:266` 的 `!== null` 判断；`quote`/`activityBanner` 例外——它们在主 patch 内，失败时分别为 null，`:225-226`）。
- **单次合并 setData**（`:189-280`）：主数据 + 可选区块合并为一个 `patch` 一次提交（`:189` 注释「减少逻辑层到渲染层的通信次数」，`e70b59f` 精简 setData 批次）；随后 `:283` 调 `animateSteps(today.steps)` 做步数滚动。
- 派生计算：`stepPercent = min(100, round(steps/target*100))`（`:181`）；勋章已获得按 `grantedAt` 字符串倒序取前 6（`:184-187`）；集体长征节点 `pctLabel`（completed→'✓'、current→'N%'、其余→'0%'，`:261`）；全员里程碑 `mark`（reached→'✓' 否则 '○'，`:276`）；数字格式化用 `util.formatNumber`（千分位，`:239`、`:245`、`:253`）与 `util.formatCn`（中文万亿缩写，`:268`、`:271`）（`.qoder/frontend/utils/util.js.md`）。

### 4.5 实时行军动态：REST 快照 + WS 增量的合并（已逐行核实）

- **WS 增量**：`handleWsMessage(msg)`（`:142-146`）只处理 `msg.type === 'activity'`，**其余类型（含 `data_changed`）直接 return 忽略**（`:143`；与 `.qoder/frontend/services/ws.js.md` §6 一致）。命中后经 `broadcast.toActivityView(msg)` 归一（`:144`，视图模型 `{id, icon, nickname, text, timeText}` 见 `.qoder/frontend/services/broadcast.js.md` §4.1），再 `setData({ activities: [item].concat(this.data.activities).slice(0, 6) })`（`:145`）——**新条目插入列表顶部、总长截断为 6、每条消息一次小 setData**（`:140` 注释与实现相符）。
- **REST 初始/回场列表**：`broadcast.getActivities(6)`（`:161`）成功时 `patch.activities = activities.slice(0, 6)`（`:229-231`），**整体覆盖**现有列表；`:228` 注释给出理由：「REST 为权威快照（WS 期间的事件已落库，快照自含）」。失败（null）时不写 `activities`，WS 已插入的条目得以保留。
- **订阅建立/拆除**：建立在 `onShow`（`:121-123`，`ws.subscribe` 内部触发连接，未登录不连接、断线指数退避、无订阅者 30s 空闲断开均由 ws.js 模块承担，`.qoder/frontend/services/ws.js.md` §4.2/§4.3/§4.5）；拆除在 `onHide`/`onUnload`（`:130`、`:136`）。
- **生产环境降级（阻塞项，如实记录）**：生产 wss 当前不通——nginx 443 未转发 `Upgrade`/`Connection` 头、微信 socket 合法域名未配置，登记于 `.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1 项与第 2 项（`.qoder/frontend/services/ws.js.md` §8 第 5 条同述）。**页面可优雅降级**：WS 连接失败只表现为 ws.js 内部 onError→退避重试→静默，不向页面抛错（ws.js.md §5「无失败通知接口」）；动态流退化为每次 onShow 的 REST 拉取（`:161`），且该行自带 `.catch(() => null)`，即便 REST 也失败仍不阻塞其余 10 路主数据（`:161` 注释 + `.qoder/backend/app/api/routes/broadcast.py.md` §6 同口径，已在代码核实）。

### 4.6 `animateSteps(target)`（`:294-307`）——步数滚动动画

先清旧 `stepsTimer`（`:295`）；起止值相同直接返回（`:297`）；否则以 900ms 时长、`setInterval` 30ms 步进（≈30fps 节流，`:292` 注释）做 easeOutCubic 缓动（`:302`），每帧一次 `setData({todaySteps})`（`:303`），进度到 1 时自清（`:304`）。句柄存实例属性 `this.stepsTimer`（`:306`）。

### 4.7 `handleSyncSteps()`（`:312-353`）——步数同步唯一入口

`syncing` 防重入（`:313`）→ `sport.syncToday()`（`:317`，微信运动授权→code→加密数据上送 `POST /sport/sync`，链路见 `.qoder/frontend/services/sport.js.md` §4.6）→ 成功后接 `march.lightUpNodes()`（`:320`，`POST /march/light-up`，后端同时判定章节并发勋章，`:319` 注释）。结果分支（`:322-344`）：

1. 有新点亮节点或新完成章节 → `arrivePopup.playArriveQueue(this, ...)` 播放「抵达事件卡→章节完成仪式卡」队列（`:323-325`，返回值未使用；模块契约见 `.qoder/frontend/utils/arrivePopup.js.md` §4.3/§6）；
2. 否则有新勋章 → toast「获得新勋章！」（`:326-327`）；
3. 否则 `failedDates.length > 0` → toast「已同步N天，M天待重试」（`:328-333`）；
4. 否则 `synced || pointsChange !== 0` → success toast，按 `historyDetailsAvailable` 区分「近7天步数已同步/步数已同步」（`:334-338`）；
5. 否则 → 「近7天已是最新/步数已是最新」（`:339-343`）。

随后 `refreshAll()` 重拉全页（`:345`）。**失败路径**：链上任一环节（含 lightUpNodes）reject → `syncError` 展示 `err.message` 或兜底文案（`:347-349`，WXML `:77` 渲染）；`finally` 复位 `syncing`（`:350-352`）。**注意 `onShow` 不会自动同步**——只读 `sport.getToday()`（`:156`），写路径必须用户点按钮触发。

### 4.8 事件处理与页面跳转（全部出口）

| 方法 | 行号 | 跳转 | API |
|---|---|---|---|
| `goActivity` | `:355-357` | `navigateTo /pages/activity/activity` | — |
| `goMarch` | `:362-364` | `switchTab /pages/march/march` | — |
| `goQuiz` | `:369-371` | `navigateTo /pages/quiz/quiz`（答题已非 tab，`:367` 注释） | — |
| `goMedals` | `:376-378` | `navigateTo /pages/medals/medals` | — |
| `goOrgSelect` | `:381-383` | `navigateTo /pages/org-select/org-select?from=home`（组织选填引导，`frontend/AGENTS.md` §4 不变量 5/7） | — |
| `goCalendar` | `:388-390` | `navigateTo /pages/calendar/calendar` | — |
| `goMemoryNode` | `:395-399` | `navigateTo /pages/node-detail/node-detail?id={memory.nodeId}`（memory 为空不可点） | — |
| `goQuoteNode` | `:404-408` | `navigateTo /pages/node-detail/node-detail?id={quote.node.id}`（无关联节点不可点，`:402` 注释标需求 §16.3） | — |
| `handleSyncSteps` | `:312` | 无跳转 | §4.7 |

## 4-1. WXML 专章（home.wxml，305 行）

自上而下 12 个区块（均绑定 §4.8/§4.7 事件）：

1. **抵达/章节弹层**（`:3-28`）：`wx:if="{{litPopup}}"` 全屏遮罩；`litPopup.kind === 'chapter'` 渲染章节卡（title/intro，`:4-9`），否则节点抵达卡（icon/name/historicalTime/nextName+nextRemain，全走完显示「🏆 长征路线已全部完成！」，`:10-27`）；8 个粒子元素 p1-p8（`:12-21`）配合 WXSS `burst` 动画。字段契约来自 arrivePopup.js（其文档 §8 第 1 条）。
2. **用户信息栏**（`:31-40`）：头像 `image`/占位 🏃 二选一（`:33-34`），昵称 + 固定副标语。
3. **活动横幅**（`:43-47`）：`wx:if="{{activityBanner}}"`，整条 `bindtap="goActivity"`。
4. **今日行军卡**（`:50-84`）：大号步数（`:57`）、`marchStatus`（`:60`）、目标+击败比例行（`:61`）、进度条 `width:{{stepPercent}}%`（`:64`）、下一站提示三分支（有下一站/finished/连续行军 inline，`:70-75`）、`syncError`（`:77`）、同步按钮 `loading/disabled="{{syncing}}"` 且文案随 `todaySteps>0` 切换「重新同步/同步微信步数」（`:80-82`）。
5. **今日寄语卡**（`:87-95`）：`wx:if="{{quote}}"` + `bindtap="goQuoteNode"`，展示 content/source/关联节点。
6. **长征进度卡**（`:98-125`）：标题行 `bindtap="goMarch"`；`routeLoading`/`routeError`/正常三态（`:104-106`）；迷你路线 `wx:for routeNodesPreview` `wx:key="id"`，节点三态样式（completed→★+lit、current→pulse，`:116-117`），末节点不画连接线（`:119`）。
7. **连续行军卡**（`:128-149`）：整卡 `bindtap="goCalendar"`；天数大字 + 达标态 + 里程碑提示（有无 `nextStreakMilestone` 两分支，`:143-146`）。
8. **今日长征情报卡**（`:152-168`）：期数 `issueNo`、徽标三分支（已完成/剩N题/N道题，`:155`）；完成态显示得分与积分（`:158-163`）；未完成态含**硬编码规则文案**「每题限时 90 秒，答对 1 题 +2 积分（每日上限 10 分）」（`:165`）与「开始/继续破译」按钮 `bindtap="goQuiz"`（`:166`）。
9. **长征记忆卡**（`:171-179`）：`wx:if="{{memory}}"` + `bindtap="goMemoryNode"`。
10. **勋章行**（`:182-194`）：标题行与每个勋章项都 `bindtap="goMedals"`，`wx:key="id"`，空态提示。
11. **实时行军动态卡**（`:197-213`）：LIVE 徽标（`:200`）；空态「还没有动态，等你迈出第一步」（`:202`）；`wx:for activities` `wx:key="id"`（WS 合成 id 见 `.qoder/frontend/services/broadcast.js.md` §7 规则 2），每行 icon/nickname/text/timeText（`:204-211`）。
12. **组织三卡**：未选组织引导条（`orgChecked && !orgName` 时整卡 `bindtap="goOrgSelect"`，`:216-219`）；组织同行卡（`wx:if="{{orgName}}"`，人数/今日共同前进双统计 + 同行者列表 `wx:key="rowKey"`、自己高亮，`:220-250`）；集体长征卡（同条件，进度条 + 节点胶囊列表 `wx:key="id"`，`:253-277`）；全员同行卡（无条件渲染，总步数 + 进度条 + 里程碑 `wx:key="name"`，`:280-304`）。

约定核对：所有展示字段（`stepsText/orgTodayStepsText/pctLabel/mark/timeText/rowKey` 等）均在 js 侧预计算（`:239-277`），WXML 表达式无原生方法调用；列表 `wx:key` 均用数据唯一字段而非 index（`frontend/AGENTS.md` §5.2）。入场动画用 `class="anim-card"` + 内联 `style="animation-delay: 60ms…620ms"` 逐卡错峰（`:50`、`:87`、`:98`、`:128`、`:152`、`:171`、`:182`、`:197`、`:216`/`:220`、`:253`、`:280`）。

## 4-2. WXSS 专章（home.wxss，862 行）

- **依赖全局样式**：`.card/.card-title/.btn-primary/.empty-tip/.progress-bar/.progress-inner/.link-more` 与动画类 `.anim-card/.anim-pop/.anim-glow`、keyframes `popIn/spinIn/pulseRed/shimmer` 均定义于 `frontend/app.wxss`（`app.wxss:14-322` 实测），本文件直接引用：如 `.progress-shine` 用全局 `shimmer`（`home.wxss:136`）、`.pulse-current` 用全局 `pulseRed`（`:544`）、`.lit-card` 用 `popIn`（`:462`）、`.lit-star.anim-pop` 用 `spinIn`（`:471`）。
- **本地 keyframes 3 组**：`fadeIn`（弹层遮罩淡入，`:447`、`:450-453`）、`burst`（金色粒子爆发，以 CSS 变量 `--dx/--dy` 定 8 向位移，`:489-504`；变量赋值 `:492-499`）、`livePulse`（LIVE 绿点脉冲，`:562`、`:565-569`）。
- **布局要点**：`.user-bar` 品牌红渐变头图（`:46-52`），`.sport-card` 负 margin 上叠（`:90-93`），`.activity-banner` 负 margin 插入头图与行军卡之间并用相邻兄弟选择器补间距（`:11`、`:20-22`）；迷你路线横向滚动（`overflow-x:auto`，`:212-218`）；勋章 6 列均分（`width:16.6%`，`:417`）；长文本一律 `ellipsis` 截断（如 `:34-39`、`:593-601`、`:720-728`）。
- 单位全 rpx；配色沿用导航主色 `#C8102E` 与鎏金 `#D4A017`/`#E8C76A` 系（如 `:111`、`:240-247`）；弹层 `z-index:999`（`:443`）。数字类字段指定 `DIN Alternate` 字体族（`:674`、`:747`、`:768`、`:827`）。

## 4-3. JSON 专章（home.json，5 行）

仅 3 个键：`navigationBarTitleText: "长征运动"`、`navigationBarBackgroundColor: "#C8102E"`、`navigationBarTextStyle: "white"`——与 `app.json` `window` 全局默认完全一致（`app.json:29-35`），属冗余声明、改动无行为差异。无 `usingComponents`（页面不使用自定义组件）、无下拉刷新配置。

## 5. 输入与输出

- **入参**：无。tab 页经 `switchTab` 进入，不接收 query 参数（全文件无 `onLoad(options)`）。
- **出参（页面调用的 service 与后端路径）**：

| service 调用 | home.js 行号 | 后端路径（service 源码行号） |
|---|---|---|
| `sport.getToday()` | `:156` | `GET /api/sport/today`（`frontend/services/sport.js:113`） |
| `sport.syncToday()` | `:317` | `POST /api/sport/sync`（`sport.js:99`） |
| `march.getRoute()` | `:157` | `GET /api/march/route`（`frontend/services/march.js:17`） |
| `march.lightUpNodes()` | `:320` | `POST /api/march/light-up`（`march.js:57`） |
| `march.getGlobalGoal()` | `:164` | `GET /api/march/global`（`march.js:70`） |
| `quiz.getDaily()` | `:158` | `GET /api/quiz/daily`（`frontend/services/quiz.js:17`） |
| `medal.getMedalList()` | `:160` | `GET /api/medal/list`（`frontend/services/medal.js:13`） |
| `broadcast.getToday()` | `:159` | `GET /api/broadcast/today`（`.qoder/backend/app/api/routes/broadcast.py.md` §4.1） |
| `broadcast.getActivities(6)` | `:161` | `GET /api/broadcast/activities?limit=6`（同文 §4.2） |
| `broadcast.toActivityView(msg)` | `:144` | 纯函数，无请求 |
| `org.getCompanions(6)` | `:162` | `GET /api/org/companions?limit=6`（`frontend/services/org.js:38`） |
| `org.getOrgMarch()` | `:163` | `GET /api/org/march`（`org.js:46`） |
| `quote.getToday()` | `:165` | `GET /api/quotes/today`（`.qoder/frontend/services/quote.js.md` §4） |
| `activity.getStatus()` / `formatRange` | `:166` / `:31` | `GET /api/activity/status`（`.qoder/frontend/services/activity.js.md` §4） |
| `ws.subscribe(fn)` | `:122` | `WS /api/ws/updates?token=…`（`frontend/services/ws.js:35`，`.qoder/frontend/services/ws.js.md` §4.2） |

- **错误出口**：关键 5 路失败 → `routeError` 文案（`:287`）；同步失败 → `syncError`（`:348`）；可选 6 路失败 → 静默降级（对应卡片隐藏或保留旧值）。401/403 统一由 request.js 链处理（静默重登重试一次 / 活动拦截跳转，`.qoder/frontend/services/request.js.md` §4.9），页面不感知。

## 6. 依赖关系

- **require（`:7-18`，12 项全部有使用）**：`app = getApp()`；service 9 个——`sport/march/quiz/medal/broadcast/org/quote/activity/ws`；工具 2 个——`utils/util`（`formatNumber/formatCn`）、`utils/arrivePopup`（`playArriveQueue`）。页面零直接 `wx.request`、零 Storage 读写（符合 `frontend/AGENTS.md` §3.1 分层与 §6.5 禁止行为；登录态仅经 `app.globalData`）。
- **被依赖**：`app.json` pages/tabBar 注册（`app.json:4`、`:43`）；launch 页登录成功后的 `switchTab` 目标（`launch.js:18`、`:125`、`:131`）；`frontend/services/broadcast.js` 与 `frontend/services/ws.js` 的**唯一页面消费方/订阅者**（`.qoder/frontend/services/broadcast.js.md` §6、`.qoder/frontend/services/ws.js.md` §6）；`sport.syncToday` 的全仓唯一页面调用点（`.qoder/frontend/services/sport.js.md` §6）。
- **数据库表**：前端不触库；各接口涉及的表见对应后端路由文档（如 `.qoder/backend/app/api/routes/broadcast.py.md` §6）。

## 7. 业务规则

1. **登录守卫与缓存键**：本页不读写任何 Storage 键（登录态键 `lm_login_user`/`lm_auth_token` 仅 auth.js/request.js 管理，`frontend/AGENTS.md` §4 不变量 3）；守卫只认 `app.globalData.loggedIn`，为假立即 reLaunch 启动页（`:116-119`），不在首页做任何自动登录。
2. **动态流合并语义**：WS 增量头插、上限 6 条（`:145`）；REST 快照成功即整体覆盖（`:229-231`），依据是「WS 事件已落库、快照自含」（`:228` 注释；通道分工权威见 `.qoder/backend/app/api/routes/broadcast.py.md` §7 规则 1）。首页只消费 `activity` 消息，`data_changed` 被忽略（`:143`）。
3. **降级次序**：动态流/组织三卡/寄语/活动横幅任一失败均不阻塞其余数据（`:161-166` 逐项 catch）；关键 5 路失败才整页报错（`:285-288`）。活动状态失败时横幅为 null 即不展示（`:166` 行内注释）。
4. **同步语义**：`synced:false && pointsChange:0` 是「已是最新」而非错误（`:339-343`；`.qoder/frontend/services/sport.js.md` §8 第 2 条）；幂等/覆盖规则全在后端（同文 §7 规则 1）。同步后必须 `lightUpNodes` 再 `refreshAll`，点亮/章节/勋章的展示以弹层队列优先于 toast（`:322-344` 分支顺序）。
5. **状态文案分档不随机**（`:20-26` 注释）：`marchStatus` 四档、`activityBanner` 三态均由真实数据推导。
6. **组织为选填**：未选组织只展示引导条（WXML `:216-219`），不强制跳转（`frontend/AGENTS.md` §4 不变量 5）。

## 8. 修改约束

1. **定时器/订阅清理契约**：`stepsTimer`/`popupTimer`/`_wsUnsub` 三者的属性名与 onHide/onUnload 清理（`:127-137`）不得破坏——`popupTimer` 名字被 arrivePopup 模块硬编码读写（其文档 §8 第 2 条）；WS 成对退订是 `e70b59f` 审查批次成果（`.qoder/frontend/services/ws.js.md` §8 第 1 条）。新增任何定时器/动画/监听必须同步补进这两个钩子。
2. **请求序号守卫不得移除**：onShow 与同步后 `refreshAll` 天然并发（`:124`、`:345`），去掉 `_refreshRequestId` 会出现旧响应覆盖新响应（`:152` 注释）。
3. **`toActivityView` 输出结构与 WXML 渲染是硬契约**（`.qoder/frontend/services/broadcast.js.md` §8 第 1 条）；`litPopup` 卡片字段契约见 `.qoder/frontend/utils/arrivePopup.js.md` §8 第 1 条——两处改字段都须同步本页 WXML。
4. **同步响应分支与 sport.js 12 键逐字段绑定**（`:328-343`；`.qoder/frontend/services/sport.js.md` §8 第 1 条），删改字段破坏滚动发布兼容。
5. 展示字段必须在 js 侧预处理（WXML 不支持原生方法调用，`frontend/AGENTS.md` §5.2）；列表 `wx:key` 不得改用 index；`wx:key="rowKey"` 的合成规则在 `:241`（`i + '_' + nickname`）。
6. 主色 `#C8102E`、卡片流结构与 home.json 三键受全局约定约束（`frontend/AGENTS.md` §2/§5.3）；本页是 automator 截图巡礼与断言的主要对象（`.qoder/frontend/test/README.md`），改布局会影响既有测试基线。

## 9. 当前实现状态

- **已实现**：11 路数据聚合与单次合并 setData、请求序号守卫、WS 实时增量（开发环境）、步数滚动动画、同步→点亮→弹层队列全链、活动横幅、组织/集体/全员三卡、寄语卡、登录守卫与定时器全清理。`git log --follow` 共 19 个提交（§10）。
- **存在问题 / 已知事项（事实陈述）**：
  1. **生产环境实时动态不可用**（外部部署问题，非本页代码缺陷）：wss 链路阻塞见 §4.5 与 `.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1、2 项；本页已优雅降级为 REST-only，无需改页面代码，修复属 nginx/微信平台配置范畴。
  2. **REST 快照覆盖 WS 增量的时间窗**：`getActivities` 请求发出到 `setData(patch)`（`:280`）之间到达的 WS 消息会被快照整体覆盖丢弃（`:145` 与 `:229-231` 的先后关系决定）；下一次 onShow 或 WS 新消息即自愈，属理论边界，是否有实际影响**待确认**。
  3. **onHide 后仍可能启动步数动画**：若 `refreshAll` 在页面隐藏后才 resolve，`:283` 会照常调 `animateSteps` 新建 `stepsTimer`；该定时器最长 900ms 自清（`:304`）且 onUnload 兜底（`:134`），非无界泄漏，但会在后台做若干次无意义 setData——现状事实。
  4. 情报卡规则文案（90 秒/+2 积分/上限 10 分）硬编码在 WXML `:165`，后端规则调整时需人工同步（`44eb77b` 引入限时规则，提交信息为据）。
  5. WS 合成 id 同毫秒碰撞（`wx:key` 重复）边界见 `.qoder/frontend/services/broadcast.js.md` §7 规则 2（**待确认**）。
- **待开发**：无（`data_changed` 消息本页忽略，是否消费属产品决策，`.qoder/frontend/services/ws.js.md` §9）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/home/home.js`（**19 个提交**），全部在 `docs/迭代记录.md` 有对应条目（按提交号逐一核对存在）。按时间倒序、按主题分组；除注明外，各提交对本文件的具体 diff 未逐一核对，以提交信息与该条目为据。

### 2026-10-17（`0052108`）
- 需求：AI 历史助手聊天页上线，底部「情报」tab 替换为「AI 问答」，答题降级为首页情报卡入口的子页。
- 修改内容（涉本文件）：`goQuiz` 现为 `navigateTo`（`:369-371`，`:367` 注释「答题已非 tab」）；tab 顺序变化见 `app.json:54-59`。
- 测试结果：见 `docs/迭代记录.md` 的 `0052108` 条目。

### 2026-10-15（`9c8f13f`、`72d4894`、`6f2cfc3`）
- 需求：今日目标调为 2 万步（`9c8f13f`，data 初值 `dailyTarget: 20000`，`:47`）；重新同步兼容旧后端响应（`72d4894`，分支提示消费 `historyDetailsAvailable`，`:334-343`）；近 7 日步数补录与结余积分（`6f2cfc3`，`failedDates/processedDates/pointsChange` 分支，`:328-338`）。
- 测试结果：`72d4894`/`6f2cfc3` 条目记录了 Node 注入断言与后端冒烟结果，详见 `docs/迭代记录.md` 对应条目；`9c8f13f` 见其条目。

### 2026-10-13（`44eb77b`）
- 需求：V2.0 活动状态页与查看拦截。
- 修改内容（涉本文件）：新增 `activityBanner` 纯函数与横幅区块（`:27-33`、`:111`、`:166`、`:226`；WXML `:43-47`）、`goActivity` 跳转（`:355-357`）。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（v2 自动化验收 14/14）。

### 2026-10-11（`e70b59f`、`01e214a`）
- 需求：小程序代码审查修复批次（`e70b59f`）：并发请求守卫（`_refreshRequestId`，`:153-154`）、Tab/后台动画恢复与计时器清理（onHide/onUnload 现行形态，`:127-137`）、ws 空闲断开配套成对退订（`:121-123`、`:130`）、精简 setData（单次合并 patch，`:189-280`）与列表 key（companions `rowKey`，`:241`）。启动页自动登录（`01e214a`）：onShow 登录守卫改 reLaunch launch、取消强制选组织（`:114-119`）。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f`、`01e214a` 条目。

### 2026-10-10（`b1dc700`）
- 需求：移除首页「演示 +2000步」按钮（假步数污染真实数据）。
- 修改内容（涉本文件）：删除演示按钮及其处理器（现码已无残留，条目记「全仓 grep 确认」）；三件套同批改（条目关联文件列 `home.js/.wxml/.wxss`）。
- 测试结果：见 `docs/迭代记录.md` 的 `b1dc700` 条目。

### 2026-10-03（`17a4d98`、`f37e3d7`、`b4a8910`、`c92598c`、`71d1b9b`）
- 需求：P1-1～P1-4 与 P2-1 五连批——实时行军动态（`:121-146` WS 订阅与头插合并、`:161` REST 拉取、WXML `:197-213`）、组织同行（`:162`、`:232-248`）、集体长征（`:163`、`:249-264`）、全员同行（`:164`、`:265-279`）、今日寄语卡（`:165`、`:224-225`、WXML `:87-95`）。
- 测试结果：各条目见 `docs/迭代记录.md`（`17a4d98` 条目含 WS 验证记录）。

### 2026-10-02（`6a2fae3`、`81a1b66`、`7e587c9`）
- 需求：P0-3 章节系统（抵达/章节弹层接入 `arrivePopup.playArriveQueue`，`:323-325`；WXML `:3-28` 弹层升级）；P0-2 状态分档文案与连续行军行（`:20-40`、`:193-199`）；首页重组（现行卡片流结构与 `refreshAll` 聚合形态的起点，`:1-6` 头注释）。
- 测试结果：`7e587c9` 条目记 automator 断言与截图巡礼通过（报告 `frontend/test/docs/s5-pages-report.md`）；其余见对应条目。

### 2026-10-01（`6a24562`）
- 需求：服务层由本地 Mock 切换为后端真实接口，页面改异步加载并补错误提示（`routeError`/`syncError` 展示形态自此，`:287`、`:348`）。
- 测试结果：该条目未记录验证字段，待确认。

### 2026-09-30（`b0ba252`、`a94e685`）
- 需求：`a94e685` 仓库初始化创建首页（Mock 版）；`b0ba252` 强制已登录用户完成组织选择（该强制流程后被 `01e214a`「取消强制选组织」回退，两条提交信息为据；现行组织入口为选填引导卡，`:381-383`）。
- 测试结果：见 `docs/迭代记录.md` 对应条目（`a94e685` 条目仅「仓库初始代码」）。
