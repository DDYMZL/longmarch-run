# quiz.js

## 1. 文件路径

`frontend/services/quiz.js`（74 行）

## 2. 文件职责

小程序「每日一题 / 今日长征情报」域的服务层：封装后端 `/api/quiz/*` 的 6 个接口（今日状态、开题、逐题提交、知识画像、答题记录、重置）。V2.0 起为「逐题限时」形态（`:2` docstring 自标「答题服务（V2.0 逐题限时）」），本文件不含任何判题/计分逻辑，全部规则以后端为准（`:4` 注释「规则（以后端为准）」）。

## 3. 业务需求

- 每日一题（5 题/日、限时作答、答题积分）：文件头规则注释（`frontend/services/quiz.js:4-5`）；后端契约与规则权威见 `.qoder/backend/app/api/routes/quiz.py.md`、`.qoder/backend/app/services/quiz_service.py.md`。
- 知识画像（按题目分类聚合历史正确率）：`:44` JSDoc。`getKnowledge` 具体由哪个提交引入未逐 diff 核对（`18c2121` 台账条目提及后端聚合接口批次含「知识画像」，但该提交未触及本文件，本文件历史见 §10），**待确认**。
- 逐题限时 + 交卷看解析双模式：V2.0 批次 `44eb77b`（2026-10-13）交付（`docs/迭代记录.md` 的 `44eb77b` 条目「改为逐题 90 秒限时，计时以服务器为准」）。
- 防伪造刷分（提交/判定的服务端约束）：`25c954c`（2026-10-12）批次确立（`docs/迭代记录.md` 的 `25c954c` 条目）。

## 4. 核心功能

**导出 6 个函数**（`module.exports`，`:67-74`），全部经 `requestService.request`（`:7`）调后端：

| # | 函数 | 行号 | 后端接口 | 说明 |
|---|---|---|---|---|
| 1 | `getDaily()` | `:16-18` | `GET /api/quiz/daily` | 今日答题状态（**不开题**） |
| 2 | `start()` | `:24-26` | `POST /api/quiz/start` | 开始或继续当前题（幂等） |
| 3 | `answer(questionId, label)` | `:35-41` | `POST /api/quiz/answer` | 提交当前题答案（每题一次，即时判定） |
| 4 | `getKnowledge()` | `:47-49` | `GET /api/quiz/knowledge` | 知识画像（分类正确率聚合） |
| 5 | `getRecords()` | `:55-57` | `GET /api/quiz/records` | 答题记录（新到旧） |
| 6 | `resetToday()` | `:63-65` | `POST /api/quiz/reset` | 重置今日答题（开发调试用，`:60` 注释） |

### 4.1 `getDaily`（`:16-18`）

JSDoc 声明返回 `{date, issueNo, completed, totalCount, timeLimit, serverTime, progress[{seq,status,correct}], current, correctCount, points, record}`（`:11-14`）。关键语义（`:10` 注释）：**只查状态不开题**——未开题时 `current` 为 `null`；已完成时 `record` 含逐题结果。`current` 非空时含 `{seq, question, startedAt, deadlineAt, remainingMs}`（`:13`），是逐题倒计时的服务器时间基准。

### 4.2 `start`（`:24-26`）

`POST /quiz/start`，幂等（`:21` 注释）：作答中重复调用返回**同一题**与服务器剩余毫秒；当前题已截止则后端判超时并开下一题（`:21-22`）。返回结构同 `getDaily`（`:22`）。

### 4.3 `answer`（`:35-41`）

请求体 `{questionId, answer: [label]}`（`:39`）——选项标签以**单元素数组**上送（数组形态与后端多选题契约兼容，本页当前为单选交互；后端校验见 `.qoder/backend/app/api/routes/quiz.py.md`）。返回 `{seq, status, correct, userAnswer, correctAnswer, analysis, points, correctCount, todayPoints, totalCount, finished, record}`（`:32-33`）：即时判定下发对错、双方答案与**解析（analysis）**，`finished` 标记今日是否已全部完成，完成时 `record` 带回整卷结果。

### 4.4 `getKnowledge` / `getRecords` / `resetToday`（`:47-65`)

纯透传。知识画像返回 `{categories[{key,name,rate,asked,wrong}], overallRate}`（`:45`），分类为历史事件/长征路线/历史人物（`:44`）；记录页返回数组含正确率 `accuracy` 与超时题数 `timeoutCount`（`:52`）；`resetToday` 返回 `{message}`（`:61`）。

## 5. 输入与输出

- 输入：仅 `answer(questionId, label)` 带请求体；其余无参数。
- 输出：Promise，resolve 为后端 camelCase JSON（契约见 §4 JSDoc；权威在后端 schemas，见 `.qoder/backend/app/api/routes/quiz.py.md`）。
- 错误：`request.js` 统一抛带中文 message 的 `Error`；401 静默重登重试一次（`frontend/services/request.js:129-160`）；**GET 类**（daily/knowledge/records）遇活动守卫 403（`X-Activity-Status`）防抖跳活动状态页，**POST 类**（start/answer/reset）只抛错交页面提示（`request.js:87-91`、`:106-119`、`:132-136`，该拦截分流由 `44eb77b` 引入，见 `docs/迭代记录.md` 的 `44eb77b` 条目）。超时用默认 10s（`request.js:73`），本文件未覆写。

## 6. 依赖关系

- 依赖：`frontend/services/request.js`（`:7`）→ `config.js` → 后端 `/api/quiz/*`（`.qoder/backend/app/api/routes/quiz.py.md`、`.qoder/backend/app/services/quiz_service.py.md`）。无本地 Storage、无业务数据落地（符合 `frontend/AGENTS.md` §4.2「后端是唯一数据源」）。
- 被依赖（grep `require('../../services/quiz')` 全量核实，5 个页面）：
  - `frontend/pages/home/home.js:10`——`getDaily()`（`:158`，首页情报卡状态）；
  - `frontend/pages/quiz/quiz.js:7`——`getDaily()` + `getKnowledge().catch(() => null)`（`:37`，画像失败不阻塞主数据）；`resetToday()`（`:110-111`，包在 `wx.showModal`「开发调试」确认框内，`:105-108`，确认后清除本期记录并 `refresh()`）；
  - `frontend/pages/quiz-answer/quiz-answer.js:12`——`.start()`（`:101`，进入即开题）、`.answer(this._question.id, selected)`（`:184`，选择提交）；
  - `frontend/pages/quiz-result/quiz-result.js:8`——`getDaily()`（`:57-58`，结果页从 `daily.record` 取整卷结果，无 record 时 toast「暂无答题记录」并返回，`:62-64`）；
  - `frontend/pages/quiz-records/quiz-records.js:5`——`getRecords()`（`:22-23`）。
- **导出函数零调用者：无**（6 个导出均有页面调用，grep 核实）。
- 页面形态说明：quiz 相关 UI 为**子页而非 tabBar 页**——原生 tabBar 固定 5 个（首页/长征/AI 问答/排行/我的，`frontend/AGENTS.md` §7），quiz 由首页情报卡进入（`0052108` 提交信息「答题降级为首页情报卡入口子页」）；作答双模式（情报1 即时判定 / 情报2 交卷看解析）在 quiz 页**顶部切换**并经 `?mode=instant|review` 传给 quiz-answer 页（`frontend/design.md:61`、`:181-182`；design.md 属参考文档、已知存在滞后，此处与现码调用链一致）。

## 7. 业务规则

1. **每日 5 题、逐题开题**：`totalCount`/`timeLimit(90)`/抽题固定性均由后端下发与保证（`:4`、`:11-13`）；前端不抽题、不缓存题目。
2. **计时只认服务器时间**：`start`/`getDaily` 下发 `serverTime` 与 `remainingMs`（`:12-13`、`:21`），页面倒计时以「收到响应时刻 + remainingMs」推算本地截止（`frontend/design.md:61`）；超时不得分（`:5`），超时判定也在后端（`:21-22`「已截止则判超时并开下一题」）。
3. **每题仅可提交一次**（`:5`、`:29`）；重复提交/伪造提交由后端约束兜底（`25c954c` 确立「提交须覆盖今日全部题目防伪造刷分」、并发唯一约束，见 `docs/迭代记录.md` 的 `25c954c` 条目；V2.0 逐题形态下的对应校验见 `.qoder/backend/app/services/quiz_service.py.md`）。
4. **答题积分**：现行代码注释为「答对 1 题 +2 积分，单日答题积分上限 10」（`:5`）；`answer` 返回的 `points`（本题得分）与 `todayPoints`（今日累计答题积分）供页面展示（`:33`）。历史上 `25c954c` 条目记载当时规则为「5 题 × 20 分」，V2.0（`44eb77b`）改造后以现行注释与后端实现为准——数值口径的权威在 `.qoder/backend/app/services/quiz_service.py.md` / `points_service.py.md`。
5. **`start` 幂等**：中途退出再进入继续当前题，不重置计时（`:21`），页面依赖此语义实现「返回续答」。

## 8. 修改约束

1. 返回结构为页面硬契约（`frontend/AGENTS.md` §1），字段 camelCase；改动须与后端三处（routes/services/schemas）同步（`.qoder/README.md` §3 规则 6）。
2. `answer` 的 `answer: [label]` 数组包装是后端契约（`:39`），不得改成裸字符串。
3. 判题、计分、超时、抽题逻辑一律留在后端，本文件与页面不得引入本地判定（`frontend/AGENTS.md` §4.2、§6.5；`25c954c` 曾因防刷分专门收紧）。
4. `resetToday` 是开发调试入口（`:60`），页面侧已用确认框包裹（`quiz.js:105-114`）；若后端为 reset 增加环境开关或权限，本文件调用方式需同步。
5. 历史上 `checkAnswer`（单题判题）已随 `25c954c` 删除（`docs/迭代记录.md` 的 `25c954c` 条目「services/quiz.js 删除 checkAnswer」），不得以旧名恢复。

## 9. 当前实现状态

- **已实现**：6 个接口封装全部可用、全部有调用方（§6）；V2.0 逐题限时形态随 `44eb77b` 交付（验证：`docs/迭代记录.md` 的 `44eb77b` 条目，v2 自动化验收 14/14）。
- **存在问题 / 已知事项**：无代码级问题记录。`frontend/test/docs/miniprogram-test-report.md` 曾记载 quiz 页 onLoad 未登录读取 `app.globalData.user.id` 抛 TypeError 的历史缺陷（该报告 :99 引用的旧代码形态与现行 `quiz.js:37` 无参调用不符，应已修复；修复提交未单独核对，**待确认**）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/quiz.js`，共 **6 个提交**，均在 `docs/迭代记录.md` 有条目。按时间倒序。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0 小程序——答题 90 秒逐题限时。
- 修改内容（涉本文件）：改为现行形态——`getDaily`/`start` 下发 `timeLimit/serverTime/remainingMs`、`answer` 逐题提交即时判定返回解析与得分（`:9-41`）；同批 `request.js` 增加活动守卫 403 分流（影响本文件所有调用的错误路径）。
- 关联文件：`frontend/pages/quiz/quiz.js`、`quiz-answer`、`quiz-result`、后端 quiz 路由/服务。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（v2 自动化验收 14/14）。

### 2026-10-12（`25c954c`，13:04）
- 需求：答题改为提交后统一反馈（防伪造刷分）。
- 修改内容（涉本文件）：删除 `checkAnswer` 单题判题函数（`docs/迭代记录.md` 的 `25c954c` 条目明载）；接口形态随「统一提交」调整（该形态已被次日 `44eb77b` 再次改造，中间态代码未留存核对）。
- 关联文件：后端移除 `POST /api/quiz/check`、迁移 `014_quiz_result_details.sql`。
- 测试结果：见 `docs/迭代记录.md` 的 `25c954c` 条目（后端 S18 14/14、automator v12 A01-A07）。

### 2026-10-03（`2a178b7`，08:40）
- 需求：长征人物志与答题连胜效果（P1-8）。
- 修改内容（涉本文件）：即时判题连胜反馈相关调整（提交信息与台账摘要为据，具体 diff 未逐行核对；该反馈后随 `25c954c` 移除）。
- 关联文件：人物/关联表、人物志页。
- 测试结果：见 `docs/迭代记录.md` 的 `2a178b7` 条目。

### 2026-10-02（`7e587c9`，11:13）
- 需求：小程序页面高级化升级（首页重组/情报化等）。
- 修改内容（涉本文件）：仅提交信息为据（情报化改造涉及答题入口与文案），具体 diff 未逐行核对。
- 测试结果：见 `docs/迭代记录.md` 的 `7e587c9` 条目。

### 2026-10-01（`6a24562`，17:53）
- 需求：服务层由本地 Mock 切换为后端真实接口。
- 修改内容（涉本文件）：改为经 `requestService.request` 调 `/quiz/*` 真实接口，页面改异步加载并补错误提示（提交信息为据）。
- 关联文件：`frontend/services/request.js` 及同批各 service。
- 测试结果：见 `docs/迭代记录.md` 的 `6a24562` 条目。

### 2026-09-30（`a94e685`，18:05）
- 需求：仓库初始化（`feat: init`）。
- 修改内容（涉本文件）：创建本文件；初始为本地 Mock 实现（由 `6a24562`「由本地 Mock 切换为真实接口」提交信息推知，init 时点代码未逐行核对）。
- 测试结果：无记录（以提交信息为据）。
