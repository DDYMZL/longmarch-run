# quiz-answer.js（页面级合一：quiz-answer.js / .wxml / .wxss / .json）

## 1. 文件路径

- `frontend/pages/quiz-answer/quiz-answer.js`（244 行）
- `frontend/pages/quiz-answer/quiz-answer.wxml`（95 行）
- `frontend/pages/quiz-answer/quiz-answer.wxss`（345 行）
- `frontend/pages/quiz-answer/quiz-answer.json`（5 行）

四件套合一建档依据 `.qoder/README.md` §1「页面级合一例外」；`app.json` 注册于 `frontend/app.json:10`。

## 2. 文件职责

「今日长征情报」的**逐题作答页**（V2.0 逐题限时形态，`:1-10` 文件头 docstring）：进入即调 `quiz.start()` 开题（幂等，中途返回续答当前题），90 秒环形倒计时（以服务器 `remainingMs` 为基准），选中选项后**每题提交一次**即时判定；倒计时归零进入超时态锁定本题。支持两种交互模式：`instant` 即时判定（提交后立即反馈对错/正确答案/解析/得分）与 `review` 交卷看解析（作答中不揭示对错，逐题静默推进，全部提交后跳结果页统一看解析）（`:7-9`）。判题、计分、超时判定全部在后端（`.qoder/backend/app/services/quiz_service.py.md` §4.4），页面不做任何本地判定。

## 3. 业务需求

- V2.0 需求六「每题限时作答」：逐题 90 秒、计时以服务器为准、每题一次提交、超时不得分——`44eb77b`（2026-10-13）交付本页现行形态（`docs/迭代记录.md` 的 `44eb77b` 条目；后端契约见 `.qoder/backend/app/api/routes/quiz.py.md` §4.3）。
- 「情报2 · 交卷看解析」对比演示模式：`2ea4797`（2026-10-13）交付（`docs/迭代记录.md` 的 `2ea4797` 条目）。
- 防伪造刷分（题目不预下发答案/解析、提交服务端判定）：`25c954c` 确立（`.qoder/backend/app/api/routes/quiz.py.md` §3）。
- 登录守卫与卸载计时器清理：`e70b59f`（2026-10-11）代码审查批次补齐（`docs/迭代记录.md` 的 `e70b59f` 条目「答题、结果……页补登录守卫；卸载时清理计时器」）。

## 4. 核心功能（quiz-answer.js）

### 4.1 模块常量与纯函数

| 名称 | 行号 | 说明 |
|---|---|---|
| `WARN_SECONDS = 10` | `:15` | 最后 10 秒进入警示色 |
| `TICK_MS = 250` | `:16` | 倒计时 setInterval 间隔 |
| `ringStyle(remainSec, limit, warn)` | `:19-23` | 剩余比例 → `conic-gradient` 内联样式串；警示色 `#E0453A`、常态金色 `#D4A017` |
| `buildOptions(options, picked, correctLabels)` | `:26-37` | 选项展示态：传 `correctLabels` 时标 `right`/`wrong`（提交后），否则仅标 `selected`（作答中） |
| `answerText(labels, options)` | `:40-47` | 答案标签 → `"B. 遵义会议"` 展示文本（WXML 不支持方法调用，逻辑层预拼，符合 `frontend/AGENTS.md` §5.2） |

### 4.2 `data` 状态字段（`:50-70`，按关注点分组）

- **模式与状态机**：`mode`（`:52`，`instant`/`review`）、`phase`（`:54`，`loading / answering / feedback / timeout / submitted / error` 六态，`:53` 注释）、`errorMsg`（`:55`）、`submitting`（`:62`，提交中防重）、`isLast`（`:68`）。
- **进度**：`seq`/`total`（`:56-57`）、`dots`（`:58`，逐题进度点，经 `util.quizDots` 生成，`frontend/utils/util.js:94-100`）。
- **题目与选项**：`question`（`:59`）、`options`（`:60`，含展示态 `state`）、`selected`（`:61`，当前选中标签）。
- **倒计时**：`remainSec`（`:63`）、`timeLimit`（`:64`，后端下发，默认 90）、`warn`（`:65`）、`ring`（`:66`，内联样式串）。
- **反馈**：`feedback`（`:67`，instant 模式提交后 `{correct, points, correctText, analysis, correctCount, todayPoints}`，`:206-213`）。
- **动画**：`questionAnim`（`:69`，题目卡入场类名）。

**非 data 实例字段**：`this.mode`（`:77`）、`this._starting`（`:97-98`，开题防重入）、`this._question`（`:122`，当前题原始数据，提交时用其 `id`/`options`）、`this._deadline`（`:123`，本地截止时间戳）、`this._timer`（`:140`，倒计时 interval）、`this._animTimer`（`:137`，入场动画 timeout）。

### 4.3 生命周期

- `onLoad(options)`（`:72-83`）：① 登录守卫——`app.globalData.loggedIn` 为假即 `wx.reLaunch('/pages/launch/launch')`（`:73-76`，不带 `?redirect=`，守卫模式见 `frontend/AGENTS.md` §4 不变量 5）；② 解析 `options.mode`，仅 `'review'` 生效、其余一律回落 `instant`（`:77`）；review 模式改导航栏标题为「情报2 · 交卷看解析」（`:78-80`）；③ `startQuestion()` 开题（`:82`）。
- `onShow()`（`:85-88`）：切后台/锁屏回来时，若仍在作答中立即 `tick()` 按本地截止时间重算剩余秒数（`:86` 注释；不累计误差的设计见 `:5` 文件头）。
- `onHide`：**未实现**——倒计时 interval 不在切后台时暂停，靠 `onShow` 重算兜底（`:5`、`:86`）。
- `onUnload()`（`:90-93`）：`stopTimer()` 清倒计时 interval + `clearTimeout(this._animTimer)`。**计时器清理完备**（interval 与两个 timeout 均有清理路径：`:91-92`、`:138`、`:154-157`、`:160`、`:186`），系 `e70b59f` 批次要求（`docs/迭代记录.md` 的 `e70b59f` 条目）。
- 本页**无 `onShow + refresh()` 数据重拉**：作答状态由 `quiz.start()` 幂等语义承载（重进即续答），与展示页刷新不变量（`frontend/AGENTS.md` §4 不变量 1）的口径差异是否有意豁免，**待确认**。

### 4.4 开题链：`startQuestion` → `applyState`

- `startQuestion()`（`:96-109`）：`this._starting` 防重入（`:97-98`，`finally` 复位 `:106-108`）；置 `phase: 'loading'` 后调 `quiz.start()`（`POST /api/quiz/start`），失败置 `phase: 'error'` + `errorMsg`（`:104`）。
- `applyState(state)`（`:112-141`）：
  - `state.completed` → **`wx.redirectTo('/pages/quiz-result/quiz-result')`**（`:113-115`，跳转详情见 §7 规则 1）；
  - `current` 为空 → error 态「今日题目正在准备中」（`:118-121`，对应后端题库不足/未开题场景，`.qoder/backend/app/services/quiz_service.py.md` §4.2 `_plan`）；
  - 正常开题：缓存 `_question`，**本地截止时间 = `Date.now() + current.remainingMs`**（`:122-123`，服务器计时基准，`:5` 文件头）；一次性 setData 进度/题目/选项/`isLast`（`seq >= totalCount`，`:129`）/`dots`（`util.quizDots(state.progress, this.mode !== 'review')`——review 模式已答题显示中性 `done` 不显对错，`:130`；`util.js:95-98`）；30ms 后加 `q-slide-in` 入场动画类（`:137`）；先 `stopTimer()` 再立即 `tick()` 并起新 interval（`:138-140`，避免换题残留旧计时）。

### 4.5 倒计时：`tick` / `stopTimer` / `enterTimeout`

- `tick()`（`:144-152`）：`remainMs = max(0, _deadline - Date.now())`；**只在整秒变化时 setData**（`:147`，250ms 轮询但降频渲染，符合根 `agents.md` §2.4 性能要求）；`remainSec <= 10` 置 `warn`（`:148`）；归零且未在提交中 → `enterTimeout()`（`:151`）。
- `stopTimer()`（`:154-157`）：clearInterval 并置空。
- `enterTimeout()`（`:159-165`）：停表、`phase: 'timeout'`，并把当前题进度点标为 `timeout`（`:163`，路径式 setData `dots[seq-1].cls`）。超时后 WXML 不再渲染提交按钮（`.wxml:85-92`），且 `handleSelect`/`handleSubmit` 均校验 `phase === 'answering'`（`:169`、`:177`）双重锁定。

### 4.6 选择与提交：`handleSelect` / `handleSubmit`

- `handleSelect(e)`（`:168-172`）：仅 `answering` 且非提交中可选；从 `dataset.label` 取标签，提交前可反复改选（`:167` 注释）。
- `handleSubmit()`（`:175-229`）——**每题一次、逐题提交模型**（无整卷提交）：
  - **防双重提交三重守卫**：① `phase !== 'answering' || submitting` 直接 return（`:176-177`）；② 未选答案 toast「请先选择答案」（`:178-181`）；③ WXML 按钮 `loading="{{submitting}}" disabled="{{submitting || !selected}}"`（`.wxml:87-88`）。后端侧另有条件 UPDATE 并发兜底（`.qoder/backend/app/services/quiz_service.py.md` §4.4 第 6 步）。
  - 调 `quiz.answer(this._question.id, selected)`（`:183-184`，`POST /api/quiz/answer`，service 侧包装为 `answer: [label]` 数组，`.qoder/frontend/services/quiz.js.md` §4.3）；成功即 `stopTimer()`（`:186`）。
  - **review 分支**（`:187-199`）：不揭示对错；`res.finished` 为真 → `phase: 'submitted'` 交卷态（`:189-195`，进度点标 `done`），否则直接 `startQuestion()` 静默开下一题（`:197`）。
  - **instant 分支**（`:201-214`）：`phase: 'feedback'`；用 `res.correctAnswer` 重建选项态（正确项 `right`、我的错选 `wrong`，`:204`）；进度点按对错标 `right`/`wrong`（`:205`）；组装 `feedback`（本题得分 `points`、正确答案文本 `correctText`、**解析 `analysis`**、今日答对数、今日答题积分，`:206-213`）——**解析仅在提交后由后端下发**，作答阶段题目不含 answer/analysis（`.qoder/backend/app/api/routes/quiz.py.md` §8 第 3 条）。
  - **错误分支**（`:216-225`）：message 含「超时」→ `enterTimeout()`（`:218-219`，对应后端 `ANSWER_TIMEOUT` 400）；含「重复提交」→ `startQuestion()` 以后端状态为准继续（`:220-223`，对应 `ALREADY_ANSWERED`，多端并发场景）；一律 toast 后端中文 message。错误文案与后端 `ValueError` detail 逐字耦合（`.qoder/backend/app/services/quiz_service.py.md` §4.1 三条文案常量）。
  - `finally` 复位 `submitting`（`:226-228`）。

### 4.7 导航处理

| 函数 | 行号 | 行为 |
|---|---|---|
| `handleNext()` | `:232-234` | 反馈/超时/error 态点按钮：再走 `startQuestion()`——后端 `start` 幂等，已答完则 `completed` 转结果页，未答完开下一题 |
| `handleViewResult()` | `:237-239` | review 交卷态「查看全部解析」：`wx.redirectTo('/pages/quiz-result/quiz-result')` |
| `handleBack()` | `:241-243` | `wx.navigateBack`，失败（页面栈无上级，如被 redirectTo 直达）回退 `wx.navigateTo('/pages/quiz/quiz')`——回退链随 `0052108`「答题降级为子页」改写（`docs/迭代记录.md` 的 `0052108` 条目） |

### 4.8 双模式与「页内模式切换」的架构事实（已核实）

「交卷看解析」没有新增第 6 个 tabBar 页，而是以 `?mode=` 参数在同一答题页内切换交互模式。证据链：① `data.mode` 字段与 `onLoad` 解析 `options.mode`（`:52`、`:77-81`）；② `frontend/app.json:41-72` tabBar `list` 恰为 5 项（首页/长征/AI 问答/排行/我的），已占满；③ 模式切换 UI 在上游 quiz 页顶部（`frontend/pages/quiz/quiz.js:67-72` `handleModeChange`、`:77-80` `handleStart` 拼 `?mode=review`）；④ `docs/迭代记录.md` 的 `2ea4797` 条目明载「微信原生 tabBar 的 `list` 上限为 5 个且已占满，无法直接新增第 6 个底部 tab，经确认改用『情报 tab 内顶部模式切换』承载『情报2』」。

## 4-1. WXML 专章（quiz-answer.wxml，95 行）

按 `phase` 六态分支渲染：

- `loading`：居中提示「情报加载中…」（`:2`）；`error`：状态盒 + `errorMsg` + 「重新加载」（绑 `handleNext`）+「返回」（绑 `handleBack`）（`:4-9`）。
- 其余四态共用骨架（`:11-94`）：
  - **头部**（`:13-26`）：进度文案随模式切换（`mode === 'review' ? '情报2 破译' : '情报破译'`，`:15`）；进度点 `wx:for dots`、`wx:key="seq"`（`:17`，非 index 键，符合 `frontend/AGENTS.md` §5.2）；**环形倒计时**——外圈 `style="{{ring}}"` 注入 conic-gradient（`:20`），警示/完成附加类 `ring-warn`/`ring-done`，内圈数字超时态显示 0、单位文案三态「秒/超时/已交」（`:22-23`）。
  - **题目卡**（`:29-34`）：题型徽标（`question.type === 'judge'` → 判断题/单选题，`:30-32`）、题干；入场动画类 `{{questionAnim}}`。
  - **选项列表**（`:37-49`）：`wx:key="label"`（`:40`）；`data-label` 传参绑 `handleSelect`；非作答中附加 `locked` 类；`option-mark` 提交后显示 ✓/✗（`:47`）。`:36` 注释明确两种模式的揭示差异。
  - **review 提示条**（`:52`）：仅 `mode === 'review' && phase === 'answering'` 显示「作答中不显示对错，交卷后统一查看解析」。
  - **反馈卡**（`:55-63`）：instant 提交后——对错判定、`+N 积分`/「本题不得分」、答错时正确答案行、**解析行 `feedback.analysis`**（`:61`）、汇总行「今日已答对 N 题 · 答题积分 M」（`:62`）。
  - **超时卡**（`:65-71`）与**交卷卡**（`:74-80`，review 全部提交后）。
  - **操作区**（`:83-93`）：三态互斥按钮——`answering` 提交（loading/disabled 见 §4.6）、`submitted`「查看全部解析」（绑 `handleViewResult`）、其余「下一题/查看本期结果」（`isLast` 决定文案，绑 `handleNext`）。

## 4-2. WXSS 专章（quiz-answer.wxss，345 行）

- **头部渐变**：`linear-gradient(135deg, #7D0B20, #C8102E)`（`:10`），延续导航栏主色 `#C8102E` 约定（`frontend/AGENTS.md` §2）。
- **环形倒计时**：`.ring` 150rpx 圆 + `transition: background 0.25s linear`（`:35-44`）——conic-gradient 由 JS 内联注入，CSS 只做过渡；`.ring-warn` 挂 `ringPulse` 1s 无限脉冲（`:70-76`、`:82-85`）；`.ring-done` 降透明度（`:78-80`）。
- **动画**：题目入场 `qSlideIn` 0.38s 右滑淡入（`:92-105`）；选中 `pickPop` 0.3s 弹跳（`:146`、`:163-167`）；反馈卡 `fadeUp`（`:222`，**keyframes 定义在全局** `frontend/app.wxss:181`）。
- **状态色**：选项 right 绿 `#2E9E5B` / wrong 红 `#C8102E`（`:149-157`、`:187-195`、`:211-217`）；反馈卡左边框按 ok/bad/timeout/submitted 四色（`:220-239`）；解析块米黄底 `.fb-analysis`（`:284-292`）。
- **无障碍**：`@media (prefers-reduced-motion: reduce)` 关闭全部动画与过渡（`:336-345`）。
- **复用全局类**（页面 wxss 未重复定义）：`.card`（`app.wxss:14`）、`.btn-primary`（`app.wxss:33`）、`.quiz-dots`/`.quiz-dot` 及 right/wrong/timeout/done 状态（`app.wxss:123-161`）。

## 4-3. JSON 专章（quiz-answer.json，5 行）

`navigationBarTitleText: "今日长征情报"`、导航栏底色 `#C8102E`、白字（`:2-4`）——与全局 window 配置一致（`frontend/app.json:30-32`）；review 模式在 `onLoad` 动态改题为「情报2 · 交卷看解析」（`.js:78-80`）。无 `usingComponents`（页面不使用自定义组件）。

## 5. 输入与输出

- **入参**：query `mode`（可选，仅 `'review'` 生效，`.js:77`）。无 eventChannel、无 Storage 读写（符合 `frontend/AGENTS.md` §3.1 pages 层禁直读 Storage）。
- **调用的 service 与后端路径**：`quiz.start()` → `POST /api/quiz/start`（`.js:101`）；`quiz.answer(questionId, label)` → `POST /api/quiz/answer`（`.js:184`）。契约与返回结构见 `.qoder/frontend/services/quiz.js.md` §4.2-§4.3、`.qoder/backend/app/api/routes/quiz.py.md` §5。
- **错误路径**：两个 POST 遇活动准入 403（`X-Activity-Status`）**只抛错由本页 toast**，不自动跳活动页（POST 参与类分流，`.qoder/frontend/services/request.js.md` §7 第 4 条）；401 由 request.js 静默重登重试一次（同文 §4.9）。
- **出参（向 quiz-result 的交接）**：见 §6 与 §7 规则 1。

## 6. 依赖关系

- **入口（grep 全量核实，唯一）**：quiz 页「开始破译」`wx.navigateTo('/pages/quiz-answer/quiz-answer' + suffix)`（`frontend/pages/quiz/quiz.js:79`，review 模式带 `?mode=review`，`:78`）。quiz 页本身由首页情报卡进入（`0052108` 降级后，`docs/迭代记录.md` 的 `0052108` 条目）。
- **出口**：
  - `wx.redirectTo('/pages/quiz-result/quiz-result')`——两处：`applyState` 检测 `completed`（`.js:114`）与 review 交卷态「查看全部解析」（`.js:238`）。**redirectTo 替换本页**，结果页返回时直接回 quiz 页而非本页（防止返回键回到已完成的作答态）。
  - `wx.navigateBack` + 失败回退 `wx.navigateTo('/pages/quiz/quiz')`（`.js:242`）。
- **answer → result 交接机制（核实结论）**：**不传任何参数**——无 query、无 eventChannel、无 Storage 中转；quiz-result 在自身 `onLoad` 重新调 `quiz.getDaily()`（`GET /api/quiz/daily`）从 `daily.record` 取整卷结果（`frontend/pages/quiz-result/quiz-result.js:57-61`）。正确性依赖后端：最后一题提交/开题时 `_finalize` 已生成当日 `quiz_records`（`.qoder/backend/app/services/quiz_service.py.md` §4.2 `_finalize`、§4.3 `get_daily`），因此结果页重拉必能取到 record。
- **模块依赖**：`services/quiz.js`（`.js:12`）、`utils/util.js` 的 `quizDots`（`.js:13`、`:130`；`util.js:94-100`）、`getApp().globalData.loggedIn`（`.js:11`、`:73`）。
- **后端表（间接）**：`daily_questions`/`quiz_answers`/`quiz_records`/`points_log`（写入均在后端，`.qoder/backend/app/api/routes/quiz.py.md` §6）。

## 7. 业务规则

1. **逐题提交模型，非整卷提交**：每次 `handleSubmit` 只结算当前一题（`.js:175-229`）；「下一题」由后端 `start` 幂等开题（`.js:232-234`、`:96-109`）；整卷完成（`completed`/`finished`）由后端判定，前端仅在 instant 模式末题反馈后借「查看本期结果」按钮再触一次 `start` 得到 `completed` 转结果页（`.js:113-115`、`.wxml:92`）。V1 的整卷提交形态已随 `25c954c`→`44eb77b` 废除（`docs/迭代记录.md` 对应条目）。
2. **计时只认服务器**：本地截止 = 响应时刻 + `remainingMs`（`.js:123`）；切后台回来按 `Date.now()` 重算（`:85-88`）；后端另有 2 秒宽限受理网络延迟提交（`.qoder/backend/app/services/quiz_service.py.md` §7「宽限」）——前端超时态与后端受理窗口不完全同步属预期，冲突时以后端 message 分流（`.js:218-219`）。
3. **超时锁定**：归零即 `enterTimeout`，不再允许选择/提交（`.js:151`、`:159-165`、`:169`、`:177`）；超时不得分由后端保证。
4. **每题一次提交**：前端 `submitting` + phase 守卫（§4.6），后端 `ALREADY_ANSWERED` 兜底；收到「重复提交」错误时以后端状态为准续答（`.js:220-223`）。
5. **review 模式不揭示**：作答中选项仅中性 `selected`、进度点 `done`（`.js:130`、`:187-199`；`util.js:95-98`）；解析统一在结果页展示。instant 模式解析在反馈卡即时展示（`.js:210`、`.wxml:61`）。
6. **登录守卫**：`onLoad` 检查 `loggedIn`，未登录 reLaunch 启动页（`.js:73-76`）；无活动准入前置检查——活动拦截由 request.js 响应头分流（§5）。

## 8. 修改约束

1. `phase` 六态与 WXML 分支、按钮互斥一一对应（`.wxml:2-93`），增删状态须同步四处（data 注释 `:53`、WXML、按钮区、`tick`/`enterTimeout` 判定）。
2. 后端错误 message 的**子串匹配**（「超时」`:218`、「重复提交」`:220`）与后端 `ValueError` 文案（`.qoder/backend/app/services/quiz_service.py.md` §4.1）是隐式契约，后端改文案须同步本文件。
3. `answer` 的标签经 service 包装为单元素数组上送（`.qoder/frontend/services/quiz.js.md` §8 第 2 条），页面侧保持传裸标签字符串（`.js:184`）。
4. 计时基准（`_deadline` 推算式）与 `onShow` 重算、`onUnload` 清理是 `e70b59f`/`44eb77b` 两批次的确立行为，改倒计时实现不得移除清理链（§4.3）。
5. 到结果页必须保持 `redirectTo`（而非 navigateTo），否则返回键会回到已完成作答页（§6「出口」）。
6. 页面不得引入本地判题/计分（`frontend/AGENTS.md` §6.5；防刷分背景见 `25c954c`）。
7. `answerText` 与 quiz-result 页存在相似实现（本页 `:40-47`，结果页 `frontend/pages/quiz-result/quiz-result.js:14-22` 多「未作答」回退）——仅两处且逻辑简单，按根 `agents.md` §2.2 未强行抽象；若第三处出现应提取到 `utils/util.js`。

## 9. 当前实现状态

- **已实现**：逐题限时作答全链路（开题/选择/提交/超时/续答）、双交互模式、环形倒计时与警示、即时反馈与解析展示、交卷态、登录守卫、计时器清理。`2ea4797` 交付时有 automator 专项验收 5/5（M1-M6，`docs/迭代记录.md` 的 `2ea4797` 条目、`frontend/test/docs/v2-quiz-modes-report.md`）。
- **已知事项（事实陈述）**：
  1. 请求无取消/序号守卫：`startQuestion`/`handleSubmit` 进行中若页面被卸载，`then/finally` 仍会对已卸载页面 setData（`.js:102-108`、`:226-228`）——微信仅告警不崩溃；`e70b59f` 批次给部分页面加过请求序号守卫（`.qoder/frontend/services/request.js.md` §4.9 末段），本页未加。
  2. `applyState` 每次覆盖 `this._animTimer` 不清旧值（`.js:137`）：旧 timeout（30ms）通常已触发，实际影响可忽略，`onUnload` 只清最后一个。
  3. 后端「AI 讲解」按钮属待开发前端项（`.qoder/backend/app/services/quiz_service.py.md` §9「待开发」），本页尚无入口。
- **待开发**：无（本页范围内）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/quiz-answer`（9 个提交，四件套同目录演进），与 `docs/迭代记录.md` 对应条目。按时间倒序、按主题归并。

### 2026-10-17（`0052108`）
- 需求：AI 问答上 tabBar，答题降级为首页情报卡入口子页。
- 修改内容（涉本页）：quiz-answer/quiz-result 回退链同步改写（现行 `handleBack` 的 navigateBack + 失败回退 quiz 页形态，`:241-243`）。
- 测试结果：见 `docs/迭代记录.md` 的 `0052108` 条目（automator tab 换防 5/5 等）。

### 2026-10-13（`2ea4797`，15:20）
- 需求：新增「情报2 · 交卷看解析」对比演示模式（tabBar 5 项占满，改页内模式切换，§4.8）。
- 修改内容（涉本页）：新增 `?mode=review` 支持——提交后不揭示对错、静默推进、末题进交卷态、「查看全部解析」跳结果页；review 改导航标题；`quizDots` 增 `reveal` 开关配合中性进度点。
- 关联文件：`frontend/pages/quiz/quiz.js`（模式切换 UI）、`frontend/utils/util.js`、`frontend/app.wxss`。
- 测试结果：`docs/迭代记录.md` 的 `2ea4797` 条目——automator `v2-quiz-modes.cjs` 5/5，截图 60-63 人工核对，`node --check` 通过。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0——答题改逐题 90 秒限时。
- 修改内容（涉本页）：重写为现行形态——环形倒计时（服务器 remainingMs 基准、末 10 秒警示、切后台重算）、每题一次提交即时反馈、超时态锁定。
- 关联文件：`frontend/services/quiz.js`、`frontend/pages/quiz/`、`quiz-result`、后端 quiz 路由/服务（`78a12ca`）。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（v2 自动化验收 14/14）。

### 2026-10-12（`25c954c`）
- 需求：答题改为提交后统一反馈，防伪造刷分。
- 修改内容（涉本页）：作答中改中性选中高亮，移除连胜徽章/对错提示/即时判题；新增「上一题」回看改选与整卷提交校验（该整卷形态次日即被 `44eb77b` 逐题限时改造取代，中间态代码未留存核对）。
- 测试结果：见 `docs/迭代记录.md` 的 `25c954c` 条目（automator v12 A01-A07）。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复批次。
- 修改内容（涉本页）：补登录守卫；卸载时清理计时器（现行 `onUnload` 形态，`:90-93`）。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-03（`2a178b7`）及更早（`7e587c9`、`6a24562`、`a94e685`）
- `2a178b7`（P1-8 人物志批次）：即时判题连胜反馈（该形态后随 `25c954c` 移除；本页具体 diff 未逐行核对，提交信息与台账摘要为据）。
- `7e587c9`（2026-10-02）：小程序页面高级化升级（情报化改造涉及本页文案与视觉，仅提交信息为据）。
- `6a24562`（2026-10-01）：服务层切换真实后端接口，页面改异步加载并补错误提示（提交信息为据）。
- `a94e685`（2026-09-30）：仓库初始化创建本页；当时为 V1 整卷作答形态（由 `25c954c` 条目所述旧交互推知，init 时点代码未逐行核对，**待确认**）。
- 测试结果：`2a178b7` 见 `docs/迭代记录.md` 对应条目；其余见各自条目。
