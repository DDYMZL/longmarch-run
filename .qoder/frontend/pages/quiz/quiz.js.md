# quiz.js（今日长征情报 · 页面级合一：quiz.js / quiz.wxml / quiz.wxss / quiz.json）

## 1. 文件路径

- `frontend/pages/quiz/quiz.js`（123 行）
- `frontend/pages/quiz/quiz.wxml`（88 行）
- `frontend/pages/quiz/quiz.wxss`（208 行）
- `frontend/pages/quiz/quiz.json`（5 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

「今日长征情报」（每日一题）的**入口与状态页**：拉取本期答题状态与知识画像，按「未开始 / 作答中 / 已完成 / 无题目」四态渲染（`quiz.js:1-5` 头注释），提供**答题交互模式切换**（情报1 即时判定 / 情报2 交卷看解析，`:14-15`），并把作答交给 `quiz-answer` 页、把逐题解析交给 `quiz-result` 页。本页自身**不判题、不计分、不计时**——规则全在后端（`.qoder/frontend/services/quiz.js.md` §7）。

**入口证据**（grep `pages/quiz/quiz` 全仓，测试目录除外）：首页情报卡 `frontend/pages/home/home.js:370`（`:367` 注释「答题已非 tab，页内跳转」）；`quiz-answer` 页返回兜底 `frontend/pages/quiz-answer/quiz-answer.js:242`；`quiz-result` 页返回兜底 `frontend/pages/quiz-result/quiz-result.js:64`、`:105`。页面在 `frontend/app.json:6` 注册，**不在 tabBar**（`app.json:41-72` 五个 tab 为首页/长征/AI 问答/排行/我的）。

## 3. 业务需求

- 每日一题（本期题数、逐题限时、答题积分）：`quiz.js:3` 头注释与规则卡文案（WXML `:24-29`）；契约权威见 `.qoder/frontend/services/quiz.js.md`、`.qoder/backend/app/api/routes/quiz.py.md`。
- 知识画像（按题目分类聚合历史正确率）：`:4` 头注释「附加：知识画像」；数据由 `quiz.getKnowledge()` 提供。
- 逐题 90 秒限时形态：V2.0 `44eb77b`（2026-10-13）交付（`docs/迭代记录.md` 的 `44eb77b` 条目）。
- 「情报2 · 交卷看解析」双模式：`2ea4797`（2026-10-13）交付。提交**标题**为「情报 tab 新增「情报2·交卷看解析」答题交互，供对比演示」，提交**正文**另注明「原生 tabBar 上限 5 个，故用页内切换承载」（`git show 2ea4797` 实测）；`docs/迭代记录.md` 的 `2ea4797` 条目「说明」项同载上限 5 项、经确认改用页内切换。动因与证据链详见 §4「页内模式切换而非新增 tab」。
- 情报化页面形态（hero + 期号 + 规则卡）：`7e587c9`（2026-10-02）「小程序页面高级化升级（…情报化…）」。
- 由 tab 降级为子页：`0052108`（2026-10-17，tabBar 第 3 位换成 AI 问答）——该提交**未触及本目录**（§10 的 `git log` 输出中无此项），改动落在 `frontend/app.json` 与 `frontend/pages/home/home.js`，见 `.qoder/frontend/pages/home/home.js.md` §10 与 `frontend/test/docs/ai-tab-swap-report.md`。

## 4. 核心功能（quiz.js）

### 4.1 `data` 状态字段（`:11-26`，按关注点分组）

| 分组 | 字段 | 来源 |
|---|---|---|
| 答题状态 | `completed`（`:12`）、`started`（`:13`）、`record`（`:16`） | `daily.completed`；`started = daily.progress.some(p => p.status !== 'pending')`（`:43`）；`daily.record`（`:40`、`:44`） |
| **交互模式** | `mode`（`:15`，初值 `'instant'`） | 用户点击切换（`:67-72`）；`instant`=情报1 即时判定，`review`=情报2 交卷看解析（`:14` 注释） |
| 结果展示 | `stars`（`:17`）、`dots`（`:18`） | `stars` 由 `record.totalCount`/`correctCount` 在 js 侧生成 `{id, on}` 数组（`:45-47`）；`dots` 由 `util.quizDots(daily.progress, this.data.mode !== 'review')` 生成（`:48`） |
| 本期参数 | `issueNo`（`:19`，初值 1）、`timeLimit`（`:20`，初值 90）、`dailyCount`（`:21`，初值 5） | 分别取 `daily.issueNo`/`daily.timeLimit`/`daily.totalCount`（`:49-51`）——**`dailyCount` 是本期总题数，不是剩余题数** |
| 提示/异常 | `shortageMessage`（`:22`）、`loading`（`:23`，初值 true）、`errorMsg`（`:24`） | `daily.shortageMessage`（`:52`）；`errorMsg` 见 §4.2 |
| 知识画像 | `knowledge`（`:25`） | `quiz.getKnowledge()`，失败为 null（`:37`、`:53`） |

页面无实例属性、**无定时器、无动画对象、无 Canvas、无 WebSocket 订阅、无事件监听**（全文件核实：无 `setInterval`/`setTimeout`/`wx.createAnimation`/`createCanvasContext`/`ws.`）。

### 4.2 生命周期：只有 `onShow`（`:28-34`），无 onLoad/onHide/onUnload

登录守卫 `!app.globalData.loggedIn` → `wx.reLaunch('/pages/launch/launch')` 并 return（`:29-32`；`frontend/AGENTS.md` §4 不变量 5），随后 `this.refresh()`（`:33`）。无 `onLoad`，首帧渲染 `data` 初值（`loading: true` → WXML `:8`「加载中…」）。**无 `onHide`/`onUnload`**：本页没有任何需要清理的资源（§4.1 末段），入场动画全部由 WXSS `animation` 声明式驱动，页面销毁即随之结束，不存在 JS 侧句柄泄漏。每次 onShow 全量重拉，符合 `frontend/AGENTS.md` §4 不变量 1。

### 4.3 `refresh()`（`:36-61`）——两路并发聚合

`Promise.all([quiz.getDaily(), quiz.getKnowledge().catch(() => null)])`（`:37`）：**画像失败不阻塞主数据**（`.catch(() => null)`，`:37`；`.qoder/frontend/services/quiz.js.md` §6 同述），返回 null 时知识画像卡整块不渲染（WXML `:73`）。成功时单次 `setData` 写入 13 个字段（`:41-56`）；`errorMsg` 的推导是「未完成且本期总题数为 0」→「本期情报正在准备中，请稍后再来。」，否则清空（`:55`）。失败时 `loading: false` + `errorMsg = err.message || '网络连接异常，请检查网络后重试。'`（`:58-60`）。

**无请求序号守卫**（对照首页 `_refreshRequestId`，`.qoder/frontend/pages/home/home.js.md` §4.4）：`onShow`、`handleModeChange`、`handleRetry`、`resetToday` 成功后都会调 `refresh()`，快速连点模式切换时两次请求的响应先后不确定，见 §9。

### 4.4 模式切换与页面跳转（全部出口）

| 方法 | 行号 | 行为 / 跳转 | API |
|---|---|---|---|
| `handleModeChange(e)` | `:63-72` | 读 `dataset.mode`；与当前相同直接 return（`:69`，**防重复刷新**）；否则 `setData({mode})` 后 `refresh()`（`:70-71`）——注释 `:64-66` 说明「切换后按新模式重刷进度点着色」 | 触发 `getDaily`+`getKnowledge` |
| `handleStart()` | `:74-80` | `navigateTo /pages/quiz-answer/quiz-answer`，`review` 模式追加 `?mode=review`（`:78-79`） | — |
| `handleViewResult()` | `:82-85` | `navigateTo /pages/quiz-result/quiz-result` | — |
| `handleRetry()` | `:87-91` | 置 `loading: true`、清 `errorMsg` 后 `refresh()` | 同上 |
| `handleTomorrow()` | `:93-98` | 无跳转，toast「每天只能完成一次情报破译哦」 | — |
| `handleResetToday()` | `:100-122` | `wx.showModal`「开发调试」确认（`confirmColor: '#C8102E'`）后调 `quiz.resetToday()`，成功 `refresh()` + toast「已重置本期情报」，失败 toast | `POST /api/quiz/reset` |

**页内模式切换而非新增 tab（核实结论）**：确认成立，且**设计动因有明确提交记录支撑**——① `data.mode` 字段与 `handleModeChange` 处理器构成页内双模式（`:15`、`:67-72`），WXML 顶部即模式切换胶囊（`quiz.wxml:3-6`），规则文案随模式变化（`:25-27`），进度点着色随模式变化（`:48` 的 `reveal` 参数）；② 原生 tabBar 当前**恰好 5 项且不含本页**（`frontend/app.json:41-72`），本页仅为普通子页（`app.json:6`）。③ **动因证据（`git show 2ea4797` 实测，2026-10-17 更正本节原「待确认」结论）**：该提交**标题**为「情报 tab 新增「情报2·交卷看解析」答题交互，供对比演示」，但**正文第 2 条**明写「quiz-answer 以 `?mode=review` 支持交卷模式：…（**原生 tabBar 上限 5 个，故用页内切换承载**）」；`docs/迭代记录.md` 的 `2ea4797` 条目「说明」项同载「微信原生 tabBar 的 `list` 上限为 5 个且已占满，无法直接新增第 6 个底部 tab，**经确认**改用「情报 tab 内顶部模式切换」承载「情报2」」。④ 时间线需一并理解：`2ea4797` 时本页**自己就是第 3 个 tab（情报）**，5 个槽位已满，故新增「情报2」无处可放、只能页内切换；其后 `0052108`（2026-10-17）才把情报 tab 换成 AI 问答、本页降级为子页。**结论：上限 5 项是当初的真实动因（仅凭提交标题会漏看正文，本节原判断已更正），对现状同样成立。**

**本页不跳 `quiz-records`**：quiz.js 全文只有 `quiz-answer`（`:79`）与 `quiz-result`（`:84`）两个跳转目标；答题记录页的入口在 `frontend/pages/mine/mine.js:96` 与 `frontend/pages/profile/profile.js:117`（grep 核实）。

### 4.5 每日上限与活动准入

- **每日上限展示**：hero 副标题「本期 {{dailyCount}} 题 · 每题限时 {{timeLimit}} 秒 · 答对 1 题 +2 积分」（WXML `:16`）与规则卡「答对 1 题 +2 积分，单日答题积分上限 10 分」（WXML `:29`）——题数与限时取后端下发值（`:49-51`），**「+2 积分」「上限 10 分」为 WXML 硬编码文案**；「每天只能完成一次」由 `handleTomorrow` 的 toast 表达（`:97`）。数值权威在后端（`.qoder/frontend/services/quiz.js.md` §7 规则 4）。
- **活动准入闸门不在本页**：`data` 无活动状态字段、`require` 无 activity 服务（`:6-8`）。拦截发生在请求层——`getDaily`/`getKnowledge` 属 GET，遇活动守卫 403（`X-Activity-Status`）由 `request.js` 防抖跳活动状态页；`resetToday` 属 POST，只抛错交页面 toast（`.qoder/frontend/services/quiz.js.md` §5）。活动未进行中的横幅在首页展示，不在本页（`.qoder/frontend/pages/home/home.js.md` §4-1 第 3 项）。

## 4-1. WXML 专章（quiz.wxml，88 行）

三态互斥 + 一块常驻：

1. **模式切换胶囊**（`:3-6`）：两个 `mode-item`，`data-mode="instant|review"` 绑 `handleModeChange`，选中项加 `active`；文案「情报1 · 即时判定」/「情报2 · 交卷看解析」。**位于三态之外，任何状态下都可见可点**。
2. **加载态**（`:8`）：`wx:if="{{loading}}"` → 全局 `.empty-tip`「加载中…」。
3. **未完成态**（`:11-42`，`wx:elif="{{!completed}}"`）：hero 区（`:12-20`）含 `anim-float` 📡、标题、期号胶囊「第 {{issueNo}} 期」（`:15`）、副标题（`:16`）、`wx:if="{{started}}"` 的进度点行（`:17-19`，`wx:for="{{dots}}" wx:key="seq"`，类名 `quiz-dot {{item.cls}}`）；规则卡（`:22-30`，`anim-card` + 内联 `animation-delay: 120ms`）6 行规则中 3 行随模式变化——`instant` 显示「提交后立即判定对错」（`:25`），`review` 显示「作答过程不显示对错」（`:26`）与「全部题目交卷后，统一查看完整解析」（`:27`）；`shortageMessage`（`:32`）与 `errorMsg` + 「点击重试」（`:34-37`）；操作区单个主按钮 `disabled="{{!!errorMsg}}"`，文案随 `started` 在「继续破译 / 开始破译」间切换（`:39-41`）。
4. **已完成态**（`:45-70`，`wx:else`）：hero 换 `anim-pop` ✅ 与「第 {{issueNo}} 期 · {{record.date}}」（`:46-50`）；结果卡（`:52-63`）大号得分 `{{record.correctCount}}` + `{{record.totalCount}} 题`、`wx:for="{{stars}}" wx:key="id"` 的 ★ 行（`:54-56`）、三列统计「正确率 {{record.accuracy}}%」「答题积分 +{{record.points}}」「超时 {{record.timeoutCount}} 题」（`:57-61`）；操作区三件（`:65-69`）：「查看逐题解析」主按钮、「明天再来」`btn-ghost`、低调的「开发调试：重置本期情报」文本入口（`:68`，**只在已完成态出现**）。
5. **知识画像卡**（`:73-87`）：`wx:if="{{!loading && knowledge}}"`，标题行右侧「总正确率 {{knowledge.overallRate}}%」，`wx:for="{{knowledge.categories}}" wx:key="key"` 逐类渲染名称、「{{item.rate}}%（错 {{item.wrong}} 题）」与 `width: {{item.rate}}%` 的进度条。**已完成与未完成两态下都展示**。

约定核对：表达式仅属性访问、三元与 `!!`，**无原生方法调用**；`stars`/`dots` 均在 js 侧预生成（`:45-48`）；`wx:key` 用 `seq`/`id`/`key`，非 index（`frontend/AGENTS.md` §5.2）。

## 4-2. WXSS 专章（quiz.wxss，208 行）

- **无本地 `@keyframes`**；入场动画全部复用全局：`frontend/app.wxss` 的 `.anim-card`（`app.wxss:300`）、`.anim-pop`（`:305`）、`.anim-float`（`:309`）及 keyframes `fadeUp`（`:181`）、`popIn`（`:205`）、`floaty`（`:252`）。
- **依赖全局样式**：`.card`（`app.wxss:14`）、`.card-title`（`:22`）、`.btn-primary`（`:33`，含 `[disabled]` 态 `:48`）、`.btn-ghost`（`:55`）、`.empty-tip`（`:83`）、`.quiz-dots`（`:123`）与 `.quiz-dot` 及其状态类 `.answering`/`.done`/`.right`/`.wrong`/`.timeout`（`:128`、`:140-161`）。注意 `util.quizDots` 对非 `answered` 项**直接返回原始 status 作为 cls**（`frontend/utils/util.js:96-99`），因此 `pending` 在 `app.wxss` 无对应规则，呈 `.quiz-dot` 默认样式。
- **选择器逐一核对无死样式**：本文件 34 个选择器（含 `.mode-item.active`、`.star.on` 两个复合选择器）全部在 `quiz.wxml` 中有对应节点或条件类名（按类名逐个比对 WXML 全文核实）。
- **布局要点**：模式切换为浅褐底 + 红底白字选中态的胶囊组（`:6-29`，带 `transition`）；hero 红渐变通栏（`:32-36`），规则卡与结果卡用 `margin-top: -20rpx` 上叠 hero（`:57`、`:83`）；得分 96rpx 巨号（`:88`）；知识画像条 `linear-gradient(90deg, #C8102E, #E8C76A)` + `transition: width 0.4s`（`:203-207`）；开发调试入口刻意低调（22rpx、`#B8B0A0`、下划线，`:144-149`）。
- 单位全 rpx；主色 `#C8102E`、鎏金 `#D4A017`/`#E8C76A`、辅助褐 `#8C6B1F`/`#F0E6D2`（`:10`、`:18`、`:97`、`:107`、`:126`、`:171`）。

## 4-3. JSON 专章（quiz.json，5 行）

仅 3 个键：`navigationBarTitleText: "今日长征情报"`、`navigationBarBackgroundColor: "#C8102E"`、`navigationBarTextStyle: "white"`。后两键与 `frontend/app.json:30-32` 全局 `window` 默认一致（冗余声明）；标题为页面特有。无 `usingComponents`、无下拉刷新配置。

## 5. 输入与输出

- **入参**：无。本页不读 `onLoad(options)`，也不消费任何 query（模式是页内 `data` 状态，**不由 URL 传入**；URL 参数只用于向 `quiz-answer` 传出 `?mode=review`，`:78`）。经 `navigateTo` 进入，从 `quiz-answer`/`quiz-result` 返回时触发 onShow 重刷。
- **出参（service 调用与后端路径）**：

| service 调用 | quiz.js 行号 | 后端路径 |
|---|---|---|
| `quiz.getDaily()` | `:37` | `GET /api/quiz/daily`（`.qoder/frontend/services/quiz.js.md` §4.1，只查状态不开题） |
| `quiz.getKnowledge()` | `:37` | `GET /api/quiz/knowledge`（同文 §4.4） |
| `quiz.resetToday()` | `:110-111` | `POST /api/quiz/reset`（同文 §4.4；开发调试用） |
| `util.quizDots(progress, reveal)` | `:48` | 纯函数，无请求（`frontend/utils/util.js:94-100`） |

- **错误出口**：`getDaily` 失败 → `errorMsg` + 「点击重试」，主按钮 `disabled`（`:58-60`；WXML `:34-37`、`:40`）；`getKnowledge` 失败 → 静默隐藏画像卡；本期无题目 → `errorMsg`「本期情报正在准备中，请稍后再来。」（`:55`）；`resetToday` 失败 → toast（`:116-118`）。401/活动 403 由 `request.js` 链统一处理（`.qoder/frontend/services/quiz.js.md` §5）。

## 6. 依赖关系

- **require（`:6-8`，3 项全部有使用）**：`app = getApp()`；`services/quiz`（`getDaily`/`getKnowledge`/`resetToday`）；`utils/util`（`quizDots`）。**页面零直接 `wx.request`、零 Storage 读写**（`frontend/AGENTS.md` §3.1、§6.5）。
- **被依赖**：`frontend/app.json:6` 注册；首页情报卡入口（`frontend/pages/home/home.js:369-371`）；`quiz-answer`（`:242`）与 `quiz-result`（`:64`、`:105`）在 `navigateBack` 失败时回跳本页；automator 脚本以 `reLaunch('/pages/quiz/quiz')` 进入（tab 降级后统一改写，`frontend/test/docs/ai-tab-swap-report.md`）。
- **下游页面**：`quiz-answer`（作答，接收 `?mode=review`）、`quiz-result`（逐题解析）。两页文档见 `.qoder/frontend/pages/quiz-answer/quiz-answer.js.md`、`.qoder/frontend/pages/quiz-result/quiz-result.js.md`。
- **数据库表**：前端不触库；答题记录与积分见 `.qoder/backend/app/api/routes/quiz.py.md`。

## 7. 业务规则

1. **模式只影响展示与传参，不影响后端契约**：`review` 模式做两件事——进度点不揭示对错（`:48` 传 `reveal = mode !== 'review'`）、跳转时带 `?mode=review`（`:78`）；规则文案随之变化（WXML `:25-27`）。`getDaily`/`getKnowledge` 的请求参数与返回结构在两模式下完全相同。
2. **`started` 的判定口径**：progress 中存在任一非 `pending` 项即视为已开始（`:43`），决定按钮文案「继续破译」与进度点是否显示（WXML `:17`、`:40`）。
3. **`stars` 是纯展示派生**：按 `record.totalCount` 生成等长数组、前 `correctCount` 项点亮（`:45-47`），不代表具体题目对错（逐题结果在 `quiz-result` 页）。
4. **每日一次**：完成后再点只有 toast（`:93-98`），无重做入口；`resetToday` 是开发调试通道，包在 `wx.showModal` 确认框内（`:104-108`）。**注意后端 `POST /api/quiz/reset` 属已登记的「调试端点暴露在生产 API 面」限制**——仅挂活动参与守卫，任何登录用户可调用，见 `.qoder/PROJECT.md` §8「架构级限制」第 8 项。
5. **画像失败不阻塞主数据**（`:37`），与首页「关键路 + 可选路」分级降级的口径一致（`.qoder/frontend/pages/home/home.js.md` §4.4）。

## 8. 修改约束

1. `mode` 字段名与 `instant`/`review` 两个取值是**三处耦合**的硬契约：本页 `:15`/`:48`/`:78`、WXML `:4-5`/`:25-27`、以及 `quiz-answer` 页对 `?mode=review` 的解析（`.qoder/frontend/pages/quiz-answer/quiz-answer.js.md`）。改取值须三处同步。
2. `util.quizDots(progress, reveal)` 的输出 `{seq, cls}` 与 WXML `:18` 及 `app.wxss:128-161` 的状态类名逐字绑定（`frontend/utils/util.js:96-99`）；改类名须同时改全局样式。
3. `record` 的 `date`/`correctCount`/`totalCount`/`accuracy`/`points`/`timeoutCount` 六字段被 WXML `:49-60` 直接消费，来自后端 camelCase 契约（`.qoder/frontend/services/quiz.js.md` §8 第 1 条），改字段须前后端同步。
4. 判题、计分、超时、抽题逻辑一律留在后端，本页不得引入本地判定（`.qoder/frontend/services/quiz.js.md` §8 第 3 条；`frontend/AGENTS.md` §4 不变量 2、§6.5）。
5. `onShow` + `refresh()` 刷新链不得破坏（`frontend/AGENTS.md` §4 不变量 1）；`handleModeChange` 的同值短路（`:69`）是避免无谓重拉的唯一节流。
6. WXML 不得引入原生方法调用、`wx:key` 不得改用 index（`frontend/AGENTS.md` §5.2）；规则文案中的积分与限时数值属硬编码，后端规则调整时需人工同步（WXML `:16`、`:24`、`:29`）。

## 9. 当前实现状态

- **已实现**：四态渲染、双答题交互模式切换、进度点按模式着色、期号与限时展示、知识画像、加载失败重试、题目不足提示、开发调试重置、登录守卫、每次 onShow 全量重刷。无任何需清理的定时器/动画句柄/订阅（§4.1、§4.2）。
- **存在问题 / 已知事项（事实陈述）**：
  1. **头注释仍写「情报 Tab」**（`:2`），而本页自 `0052108` 起已是子页（`app.json:41-72` tabBar 无本页）——注释滞后于现状。
  2. **`refresh()` 无并发守卫**（§4.3）：快速连点两个模式项会发起两轮请求，后返回者覆盖先返回者，而 `dots` 的着色依赖发起时的 `this.data.mode`（`:48`），理论上可出现「mode 已切、dots 仍是旧模式着色」，下一次 onShow 或再点一次即自愈；是否有实际影响**待确认**。
  3. **积分与限时数值文案硬编码在 WXML**（`:16`、`:29`），后端规则变更需人工同步（`.qoder/frontend/pages/home/home.js.md` §9 第 4 条同口径）。
  4. **开发调试入口对所有登录用户可见**（WXML `:68`，仅样式低调，无环境开关/权限判断），配合 §7 规则 4 的后端限制，生产环境可被真实用户触发重置。
  5. `pending` 状态在 `app.wxss` 无对应 `.quiz-dot.pending` 规则（§4-2），未作答题目使用默认样式——现状事实，是否需要区分**待确认**。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/quiz`（目录级，**8 个提交**），全部在 `docs/迭代记录.md` 有对应条目（按提交号逐一核对存在）。按时间倒序。除注明外，各提交对本目录的具体 diff 未逐一核对，以提交信息与该条目为据。

### 2026-10-15（`6f2cfc3`，12:19）
- 需求：支持近 7 日步数补录结余积分与**用户独立题目轮换**（全端）。
- 修改内容（涉本目录）：提交信息为据；与本页可对应的现状是期号 `issueNo` 与本期题数 `dailyCount` 均取后端下发值（`:49`、`:51`），页面不做任何本地抽题。具体 diff 未逐行核对。
- 测试结果：见 `docs/迭代记录.md` 的 `6f2cfc3` 条目。

### 2026-10-13（`2ea4797`、`44eb77b`）
- 需求：`2ea4797`（15:20）情报 tab 新增「情报2 · 交卷看解析」答题交互，提交标题注明「供对比演示」、正文注明「原生 tabBar 上限 5 个，故用页内切换承载」；`44eb77b`（13:25）V2.0 答题 90 秒逐题限时。
- 修改内容（涉本目录）：`2ea4797`——`data.mode` 字段与 `handleModeChange`（`:15`、`:63-72`）、`handleStart` 的 `?mode=review` 传参（`:77-80`）、`quizDots` 的 reveal 参数（`:48`）、WXML 模式切换胶囊与随模式变化的规则行（`quiz.wxml:3-6`、`:25-27`）、WXSS `.mode-switch`/`.mode-item.active`（`quiz.wxss:6-29`）；`44eb77b`——`timeLimit` 字段与限时规则文案（`:20`、`:50`；WXML `:16`、`:24`）。
- 测试结果：`44eb77b` 条目记 v2 自动化验收 14/14；`2ea4797` 见其条目与 `frontend/test/docs/v2-quiz-modes-report.md`。

### 2026-10-11（`01e214a`）
- 需求：V1.0 启动页自动登录，取消强制选组织。
- 修改内容（涉本目录）：登录守卫改为 `reLaunch('/pages/launch/launch')` 的现行写法（`:29-32`）；细节以提交信息与条目为据，未逐 diff 核对。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目。

### 2026-10-02（`7e587c9`，11:13）
- 需求：小程序页面高级化升级（首页重组/档案/行军日历/到达动画/**情报化**/勋章墙）。
- 修改内容（涉本目录）：现行「hero + 期号胶囊 + 规则卡 + 结果卡 + 知识画像卡」形态与 `.quiz-hero*`/`.rule-card`/`.result-card`/`.knowledge-*` 样式（WXML `:12-87`；WXSS `:31-207`）；提交信息为据，未逐 diff 核对。
- 测试结果：见 `docs/迭代记录.md` 的 `7e587c9` 条目（automator 断言与截图巡礼）。

### 2026-10-01（`6a24562`，17:53）
- 需求：服务层由本地 Mock 切换为后端真实接口，各页面改为异步加载并补错误提示。
- 修改内容（涉本目录）：`loading`/`errorMsg` + 「点击重试」形态自此（`:23-24`、`:58-60`；WXML `:8`、`:34-37`）；提交信息为据。
- 测试结果：见 `docs/迭代记录.md` 的 `6a24562` 条目。

### 2026-09-30（`b0ba252`、`a94e685`）
- 需求：`a94e685`（18:05）仓库初始化创建本页（Mock 版，当时即为「情报」tab）；`b0ba252`（22:48）强制已登录用户完成组织选择流程（该强制流程后被 `01e214a` 回退）。
- 修改内容（涉本目录）：`b0ba252` 对本目录的具体改动未逐 diff 核对，仅提交信息为据。
- 测试结果：见 `docs/迭代记录.md` 对应条目（`a94e685` 条目仅「仓库初始代码」）。

> 补充：本页由 tab 降级为子页发生在 `0052108`（2026-10-17），该提交未触及本目录（上述 `git log` 输出中无此项），改动落在 `frontend/app.json` tabBar 与 `frontend/pages/home/home.js` 的 `goQuiz`，详见 `.qoder/frontend/pages/home/home.js.md` §10 与 `frontend/test/docs/ai-tab-swap-report.md`。
