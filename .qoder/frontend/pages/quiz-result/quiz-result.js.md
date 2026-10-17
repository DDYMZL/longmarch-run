# quiz-result.js（页面级合一：quiz-result.js / .wxml / .wxss / .json）

## 1. 文件路径

- `frontend/pages/quiz-result/quiz-result.js`（137 行）
- `frontend/pages/quiz-result/quiz-result.wxml`（75 行）
- `frontend/pages/quiz-result/quiz-result.wxss`（227 行）
- `frontend/pages/quiz-result/quiz-result.json`（5 行）

四件套合一建档依据 `.qoder/README.md` §1「页面级合一例外」；`app.json` 注册于 `frontend/app.json:11`。

## 2. 文件职责

「今日长征情报」的**答题结果页**（V2.0，`:1-6` 文件头 docstring）：展示当日整卷结算——答对题数/正确率/答题积分/超时题数、逐题结果（题干、我的答案、正确答案、对错或超时、本题积分、解析），历史记录无逐题 `details` 时回退展示错题回顾 `wrongList`（`:4`）。附带三段庆贺动画：正确率数字滚动、星星逐个点亮、全对彩带。**数据不靠上游页面传参，进入后自行重拉** `quiz.getDaily()` 取 `daily.record`（`:57-61`）。

## 3. 业务需求

- V2.0 逐题限时批次的结果展示端：「结果页展示答对数、正确率、答题积分、超时题数和逐题结果」——`44eb77b`（2026-10-13）交付现行形态（`docs/迭代记录.md` 的 `44eb77b` 条目）。
- 「答题详情」逐题卡片与 wrongList 回退：`25c954c`（2026-10-12）引入（`docs/迭代记录.md` 的 `25c954c` 条目「结果页新增『答题详情』；历史记录没有 details 时回退显示错题回顾」；后端 014 迁移前 `details` 为 None 的回退口径见 `.qoder/backend/app/services/quiz_service.py.md` §9）。
- review（情报2 · 交卷看解析）模式的「统一查看全部解析」落点：`2ea4797`（2026-10-13，`docs/迭代记录.md` 的 `2ea4797` 条目；本页该提交未改文件——`git log --follow` 无此提交——解析统一展示由本页既有 details 卡片天然承载）。
- 登录守卫与卸载计时器清理：`e70b59f`（2026-10-11）批次补齐（`docs/迭代记录.md` 的 `e70b59f` 条目）。

## 4. 核心功能（quiz-result.js）

### 4.1 模块常量与纯函数

| 名称 | 行号 | 说明 |
|---|---|---|
| `CONFETTI_COLORS` | `:11` | 彩带 6 色池（长征红/鎏金等） |
| `answerText(labels, options)` | `:14-22` | 答案标签 → `"B. 遵义会议"`；空数组回退「未作答」（`:15`）。与 quiz-answer 页同名函数为相似实现（本页多回退分支），未强行抽象（根 `agents.md` §2.2；对照 `.qoder/frontend/pages/quiz-answer/quiz-answer.js.md` §8 第 7 条） |
| `buildDetails(details)` | `:25-38` | 逐题结果预处理（WXML 不支持方法调用，`:24` 注释）：拼 `key`（index+questionId，`:27`）、题型文本、`verdict`（timeout/right/wrong 三态，`:31`）、判定文本、积分文本、我的答案文本（超时显示「超时未作答」，`:34`）、正确答案文本、解析 |

### 4.2 `data` 状态字段（`:41-49`，按关注点分组）

- **结算数据**：`record`（`:42`，后端 `QuizRecordOut` 整卷记录，页面 `wx:if` 总开关，`.wxml:1`）、`details`（`:43`，`buildDetails` 产物）、`wrongCount`（`:45`，= totalCount − correctCount − timeoutCount，`:73`）。
- **动画**：`stars`（`:44`，每题一颗星 `{id, on}`）、`displayAccuracy`（`:46`，滚动中的正确率）、`confetti`（`:47`，彩带粒子数组）、`isPerfect`（`:48`，全对标记）。

**非 data 实例字段**：`this._timers`（`:56`，星星点亮 timeout 集合）、`this._scoreTimer`（`:120`，正确率滚动链）。

### 4.3 生命周期与数据获取

- `onLoad()`（`:51-107`）：
  1. **登录守卫**：`app.globalData.loggedIn` 为假即 `reLaunch('/pages/launch/launch')`（`:52-55`，不带 redirect）。
  2. **重拉而非消费传参**：调 `quiz.getDaily()`（`GET /api/quiz/daily`，`:57-58`）。**与 quiz-answer 的交接零参数**：上游经 `wx.redirectTo('/pages/quiz-result/quiz-result')` 直达（`frontend/pages/quiz-answer/quiz-answer.js:114`、`:238`），无 query/eventChannel/Storage；本页从 `daily.record` 取整卷结果（`:59-61`）。可靠性由后端保证——最后一题提交/开题时 `_finalize` 已生成当日记录，且 `get_daily` 被动查询也会补判超时并 finalize（`.qoder/backend/app/services/quiz_service.py.md` §4.2-§4.3）。
  3. `record` 为空（如直接输入路径进入）：toast「暂无答题记录」，800ms 后 `navigateBack`（失败回退 `navigateTo('/pages/quiz/quiz')`）（`:62-65`）。
  4. 结算 setData（`:68-75`）：`isPerfect`（totalCount>0 且全对，`:68`）、`details`、`stars`（totalCount 颗，`:72`）、`wrongCount`。
  5. **三段动画**：① `animateAccuracy(record.accuracy)` 正确率滚动（`:78`）；② 星星逐个点亮——答对几题亮几颗，第 i 颗在 `500 + i*220` ms 触发（`:81-85`，timeout 收入 `_timers`）；③ 全对时生成 14 片彩带（随机 left 4%-96%、delay、duration、色池轮取、尺寸，`:88-101`）——随机值仅用于动画表现，非业务数据，不违反「前端不造业务数据」（`frontend/AGENTS.md` §4 不变量 2）。
  6. 失败分支：toast「答题记录加载失败」+ 800ms 返回（`:103-106`）。活动守卫 403（GET 查看类）由 request.js 防抖跳活动状态页，本页不另行处理（`.qoder/frontend/services/request.js.md` §7 第 4 条）。
- `onShow`：**未实现**——本页只在 `onLoad` 拉取一次，不符合「数据展示页必须 onShow + refresh()」不变量（`frontend/AGENTS.md` §4 不变量 1）的字面要求；结果页数据为当日已终结记录、且上游 redirectTo 后本页总是新建实例，是否属有意豁免**待确认**。
- `onUnload()`（`:126-129`）：遍历清 `_timers`（星星）+ 清 `_scoreTimer`（滚动链）。**清理基本完备**，但 `:64`、`:105` 两个 800ms 匿名 `setTimeout` 未入 `_timers`（见 §9 已知事项 1）。

### 4.4 `animateAccuracy(target)`（`:112-124`）

1100ms 正确率数字滚动：30ms 一步的 `setTimeout` 自递归链（`:120`），三次缓出 `1-(1-p)^3`（`:117`），每步 setData `displayAccuracy`；链上只有最新一个 `_scoreTimer` 存活，`onUnload` 清它即断链（`:128`）。

### 4.5 导航

| 函数 | 行号 | 行为 |
|---|---|---|
| `handleBackHome()` | `:134-136` | `wx.switchTab('/pages/home/home')`——**唯一常驻操作按钮**（`.wxml:72-74`「返回首页」）。**无「再答一次」按钮**：每日一题只能完成一次（quiz 页 `handleTomorrow` toast 同口径，`frontend/pages/quiz/quiz.js:96-98`），重答入口不存在属预期 |
| （错误路径） | `:64`、`:105` | `wx.navigateBack` 失败回退 `wx.navigateTo('/pages/quiz/quiz')`——回退链随 `0052108` 子页化改写（`docs/迭代记录.md` 的 `0052108` 条目） |

**无分享能力**：未实现 `onShareAppMessage`/`onShareTimeline`（全文件核实）；庆祝动画为纯 CSS（§4-2），无 Canvas。

## 4-1. WXML 专章（quiz-result.wxml，75 行）

整页 `wx:if="{{record}}"`（`:1`），加载失败/无记录时白屏并由 JS toast+返回兜底（`.js:62-65`、`:103-106`）。自上而下：

- **彩带层**（`:3-10`）：`confetti.length > 0` 才渲染；每片内联 style 注入 left/尺寸/颜色/animation-delay/duration（`:8`），`wx:key="id"`。
- **成绩头部**（`:13-20`）：标题随 `isPerfect` 切换「🎉 今日情报完美破译 / 情报任务完成」（`:14`）；大字号 `correctCount / totalCount 题`（`:15`）；正确率绑定滚动值 `displayAccuracy`（`:16`）；星星列 `wx:for stars`、`wx:key="id"`、点亮加 `on` 类（`:17-19`）。
- **统计卡**（`:23-41`）：三格——答题积分 `+{{record.points}}`、答错 `wrongCount` 题、超时 `record.timeoutCount` 题；底部规则文案「答对 1 题 +2 积分，单日答题积分上限 10 分」（`:40`，与后端 `points_service.quiz_points` 口径一致，`.qoder/backend/app/api/routes/quiz.py.md` §4.4）。
- **逐题结果卡**（`:44-56`）：`details.length > 0` 时逐题渲染——序号/题型、判定徽标（`verdict` 三态类 + `verdictText` + `pointsText`）、题干、我的答案（对错着色）、正确答案、解析行（有 `analysis` 才显示，`:54`）。`wx:key="key"`（`:46`，非 index 键，符合 `frontend/AGENTS.md` §5.2）。**review 模式的「统一看解析」即落在本卡**。
- **错题回顾回退卡**（`:58-66`）：`wx:elif record.wrongList.length > 0`——014 迁移前的历史记录无 details 时展示（`:57` 注释；后端口径见 `.qoder/backend/app/services/quiz_service.py.md` §9）；`wx:key="index"` 用数据项自有 `index` 字段（题号，唯一），非数组下标。
- **完美通关卡**（`:67-69`）：details 与 wrongList 均空（全对且历史记录无明细）时显示。
- **操作区**（`:72-74`）：「返回首页」绑 `handleBackHome`。
- 卡片入场用 `anim-card` 类 + 内联 `animation-delay: 300/420/540ms` 错峰（`:23`、`:44`、`:72`）。

## 4-2. WXSS 专章（quiz-result.wxss，227 行）

- **成绩头部**：红渐变 `linear-gradient(135deg, #A00D26, #C8102E)`（`:7`）；`result-score` 110rpx 大字号 + 文字投影（`:19-25`）；标题与正确率行挂 `fadeUp` 入场（`:16`、`:34`，keyframes 在全局 `frontend/app.wxss:181`）。
- **星星**：常态半透明白（`:41-46`）；`.star.on` 金色 `#FFD766` + `starPop` 0.55s 弹跳 + 光晕（`:48-52`；keyframes 全局 `app.wxss:262`）。
- **彩带**：`.confetti-layer` fixed 全屏、`pointer-events: none`、`z-index: 999`、overflow hidden（`:55-64`，不挡按钮）；`.confetti-piece` 挂 `confettiFall` **infinite** 下落动画（`:66-73`；keyframes 全局 `app.wxss:278`）——纯 CSS 无限动画，无 JS 计时器需清理，页面卸载即随节点销毁。
- **卡片布局**：统计卡 `margin-top: -30rpx` 上叠头部（`:76-78`）；三格 flex + 1rpx 分隔线（`:80-106`）。
- **逐题/错题排版**：`detail-item`/`wrong-item` 上边框分隔、首项去边框（`:109-117`、`:152-160`，配合 WXML `first` 类）；判定色 right 绿 `#2E7D32` / wrong 红 `#C8102E` / timeout 灰 `#8A8A8A`（`:179-191`）；解析文本 `wrong-analysis` 灰色小字（`:137-142`）。
- **复用全局类**：`.card`（`app.wxss:14`）、`.btn-primary`（`app.wxss:33`）、`.anim-card`（`app.wxss:300-302`，fadeUp 0.55s）。本页 wxss 无 `prefers-reduced-motion` 降级（对照 quiz-answer.wxss:336-345 有）——星星/彩带/滚动动画对减动效偏好用户仍播放，是否需补齐**待确认**。

## 4-3. JSON 专章（quiz-result.json，5 行）

`navigationBarTitleText: "情报任务结果"`、导航栏底色 `#C8102E`、白字（`:2-4`），与全局 window 约定一致（`frontend/app.json:30-32`）。无 `usingComponents`。

## 5. 输入与输出

- **入参**：无——`onLoad` 不读 options（`:51`），上游跳转不带任何参数（§4.3；`frontend/pages/quiz-answer/quiz-answer.js:114`、`:238`、`frontend/pages/quiz/quiz.js:84`）。
- **调用的 service 与后端路径**：仅 `quiz.getDaily()` → `GET /api/quiz/daily`（`:57-58`）。消费其 `record` 字段：`correctCount`/`totalCount`/`points`/`timeoutCount`/`accuracy`/`details[]`/`wrongList[]`（`:68-78`、`.wxml:15-63`），契约见 `.qoder/backend/app/api/routes/quiz.py.md` §5（`QuizRecordOut`）与 `.qoder/frontend/services/quiz.js.md` §4.1。
- **输出/出口**：`switchTab` 首页（`:135`）；错误路径 `navigateBack`/`navigateTo` quiz 页（`:64`、`:105`）。本页不再向任何页面传数据。
- **错误码路径**：401 静默重登（request.js）；403 活动拦截（GET）自动跳活动状态页；其余 toast「答题记录加载失败」+ 返回（`:103-106`）。

## 6. 依赖关系

- **入口（grep 全量核实，3 处）**：
  1. quiz-answer 页 `applyState` 检测 `completed` 后 `redirectTo`（`frontend/pages/quiz-answer/quiz-answer.js:114`，instant 模式末题「查看本期结果」经 `handleNext`→`startQuestion` 触达）；
  2. quiz-answer 页 review 交卷态「查看全部解析」`redirectTo`（同文件 `:238`）；
  3. quiz 页已完成态「查看本期结果」`navigateTo`（`frontend/pages/quiz/quiz.js:84`）。
- **模块依赖**：`services/quiz.js`（`.js:8`）、`getApp().globalData.loggedIn`（`:7`、`:52`）。不依赖 `utils/util.js`（`answerText`/`buildDetails` 页内自带）。
- **与 quiz-answer 的分工**：作答/单题反馈在 quiz-answer，整卷结算与全量解析在本页；instant 模式解析两处都可见（单题即时 + 本页汇总），review 模式仅本页可见（`.qoder/frontend/pages/quiz-answer/quiz-answer.js.md` §7 规则 5）。
- **后端表（间接，只读）**：`quiz_records`（record/details/wrongList 来源）、经 `get_daily` 被动副作用可能写 `quiz_answers`/`quiz_records`/`points_log`（`.qoder/backend/app/api/routes/quiz.py.md` §7 第 5 条）。

## 7. 业务规则

1. **积分为展示不重算**：`record.points`、逐题 `pointsText` 均直接渲染后端值（`.wxml:26`、`.js:33`）；「答对 +2、单日上限 10」文案（`.wxml:40`）与后端 `points_service.quiz_points` 一致（`.qoder/backend/app/api/routes/quiz.py.md` §4.4），后端改规则须同步该硬编码文案。
2. **wrongCount 前端派生**：`totalCount - correctCount - timeoutCount`（`:73`）——依赖三字段口径互斥（对/错/超时），后端 `_record_out` 的 `timeoutCount` 亦从 details 统计（`.qoder/backend/app/services/quiz_service.py.md` §4.2）；014 前历史记录 details 为 None 时 timeoutCount=0，wrongCount 会吸收超时题（历史数据展示口径，属后端已知事实）。
3. **details 优先、wrongList 回退、全对提示兜底**的三级渲染（`.wxml:44-69`）。
4. **星星数 = totalCount、点亮数 = correctCount**（`:72`、`:81-85`）；全对（`isPerfect`）才放彩带（`:68`、`:88`）。
5. **一次性页面**：数据只在 `onLoad` 拉取；当日记录已终结，无刷新需求（onShow 缺失的口径见 §4.3 待确认项）。

## 8. 修改约束

1. 上游三处入口均假定本页**自取数据**（§6），若改为传参交接须同步 quiz-answer 两处 redirectTo 与 quiz 页入口，并保持无参可达（分享/重进场景）。
2. `buildDetails` 的 `key = index + '-' + questionId`（`:27`）是列表渲染键，改拼接规则不得退化为数组下标（`frontend/AGENTS.md` §5.2）。
3. 计时器清理链不得破坏：新增动画 timeout 必须收入 `this._timers` 或在 `onUnload` 显式清理（`:126-129`；`e70b59f` 批次确立）。
4. `record` 字段名（camelCase）与后端 `QuizRecordOut` 是硬契约（`.qoder/frontend/services/quiz.js.md` §8 第 1 条），`answerAt` 等时间字段为毫秒整数口径（`.qoder/backend/app/api/routes/quiz.py.md` §8 第 5 条）。
5. 彩带/星星/滚动均为逻辑层 setData 驱动的 CSS 动画，不得改为页面自造业务数据展示（不变量 2）。

## 9. 当前实现状态

- **已实现**：整卷结算展示、逐题详情与解析、wrongList 历史回退、三段庆贺动画、登录守卫、计时器清理、无记录/加载失败兜底返回。`44eb77b`/`2ea4797` 批次的 automator 验收覆盖结果页断言（`docs/迭代记录.md` 对应条目）。
- **已知事项（事实陈述）**：
  1. `:64`、`:105` 两个 800ms 匿名 `setTimeout`（toast 后返回）未收入 `_timers`，`onUnload` 不清理——用户若在 800ms 内自行返回，回调仍对已卸载页面执行 `navigateBack`（微信容错，实际风险低）。
  2. 无 `onShow + refresh()`（§4.3，是否豁免待确认）；无分享、无「再答一次」（§4.5，属产品口径而非缺失）。
  3. 页面 wxss 缺 `prefers-reduced-motion` 降级（§4-2，对照 quiz-answer 页已有）。
- **待开发**：无（本页范围内；答题 AI 讲解入口在后端侧待前端接入，`.qoder/backend/app/services/quiz_service.py.md` §9）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/quiz-result`（8 个提交，四件套同目录演进），与 `docs/迭代记录.md` 对应条目。按时间倒序、按主题归并。

### 2026-10-17（`0052108`）
- 需求：答题降级为子页（AI 问答上 tabBar）。
- 修改内容（涉本页）：回退链同步改写（现行 `navigateBack` 失败回退 quiz 页形态，`:64`、`:105`）。
- 测试结果：见 `docs/迭代记录.md` 的 `0052108` 条目。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0 逐题限时——结果页改展示答对数/正确率/答题积分/超时题数/逐题结果。
- 修改内容（涉本页）：重写为现行形态；正确率滚动、星星点亮、全对彩带动画（`:1-6` 文件头自述）。
- 关联文件：`frontend/pages/quiz-answer/`、`frontend/services/quiz.js`、后端 quiz 路由/服务。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（v2 自动化验收 14/14）。

### 2026-10-12（`25c954c`）
- 需求：提交后统一反馈，防伪造刷分。
- 修改内容（涉本页）：新增「答题详情」逐题卡；历史记录无 details 回退错题回顾（`docs/迭代记录.md` 的 `25c954c` 条目明载；后端 014 迁移同批）。
- 测试结果：见 `docs/迭代记录.md` 的 `25c954c` 条目（automator v12 A01-A07）。

### 2026-10-11（`e70b59f`）
- 需求：代码审查修复批次。
- 修改内容（涉本页）：补登录守卫（`:52-55`）；卸载清理计时器（`:126-129`）。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-03（`2a178b7`）及更早（`7e587c9`、`6a24562`、`a94e685`）
- `2a178b7`（P1-8 人物志批次）：即时判题连胜反馈涉及结果展示（本页具体 diff 未逐行核对，提交信息与台账摘要为据；该反馈形态后随 `25c954c` 移除）。
- `7e587c9`（2026-10-02）：页面高级化升级（情报化视觉改造，仅提交信息为据）。
- `6a24562`（2026-10-01）：服务层切真实接口，页面改异步加载并补错误提示（提交信息为据）。
- `a94e685`（2026-09-30）：仓库初始化创建本页；当时为 V1 整卷提交后的结果形态（由 `25c954c` 条目所述旧交互推知，init 时点代码未逐行核对，**待确认**）。
- 测试结果：见 `docs/迭代记录.md` 各自条目。
