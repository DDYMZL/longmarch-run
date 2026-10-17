# util.js

## 1. 文件路径

`frontend/utils/util.js`（111 行）

## 2. 文件职责

小程序通用纯工具集：日期/时间格式化（含后端 UTC naive ISO 的本地化解析）、数字千分位与中文大数格式化、用户事件图标映射、答题进度点归一（`frontend/utils/util.js:1-3` docstring）。按 `frontend/AGENTS.md` §5.1 约定「日期/文本等纯函数放 `utils/util.js`；禁止在多个 service 复制同一工具函数」，本文件是全仓唯一的此类工具落点。

CommonJS 模块，无 wx API 依赖、无状态、无副作用；导出 8 个函数（`:102-111`），另有 1 个内部函数 `parseUtc`（`:46-49`，**未导出**，仅被 `formatTime`/`formatRelative` 复用）。

## 3. 业务需求

- 步数/积分/榜单等数字的展示格式化（P0 页面高级化起，`7e587c9`）；
- 实时行军动态的相对时间「刚刚 / N分钟前…」（P1-1，`17a4d98`，`frontend/test/docs/p1-activities-report.md`）；
- 全员共同长征目标的中文大数「X.XX亿 / X.X万」（P1-4，`c92598c`，`frontend/test/docs/p1-global-goal-report.md`）；
- V2.0 答题逐题进度点与「交卷模式不泄露对错」（`44eb77b` 新增、`2ea4797` 加 `reveal` 开关，`frontend/test/docs/v2-quiz-modes-report.md`）。

## 4. 核心功能

导出函数逐个列出（签名 + 行号 + 一句话职责；调用方为全仓 grep `util.<fn>` 核实结果）：

| # | 函数 | 行号 | 职责 | 代码调用方（示例，非穷举处已注） |
|---|---|---|---|---|
| 1 | `pad(n)` | `:6-8` | 个位数补零为两位字符串 | `frontend/pages/calendar/calendar.js:14`、`:92` |
| 2 | `formatDate(d = new Date())` | `:14-17` | Date → `YYYY-MM-DD`（本地时区） | `calendar.js:83` |
| 3 | `formatNumber(num)` | `:20-22` | 千分位（`25000 → 25,000`），falsy 输入按 0 | node-detail/ceremony/ticket/calendar/profile/home 多页（如 `frontend/pages/profile/profile.js:75-93`、`frontend/pages/home/home.js:239-253`） |
| 4 | `formatCn(num)` | `:25-30` | 中文大数：≥1亿 → `X.XX亿`，≥1万 → `X.X万`（去尾零），否则千分位 | `home.js:268`、`:271`（全员目标卡） |
| 5 | `formatTime(iso)` | `:37-43` | 后端 UTC naive ISO → 本地 `YYYY-MM-DD HH:mm`，无效返回 `''` | `frontend/pages/account/account.js:40-41`、`frontend/pages/medals/medals.js:79`、`profile.js:66` |
| 6 | `formatRelative(iso)` | `:55-65` | 相对时间：`刚刚`(<1min) / `N分钟前` / `N小时前` / `昨天`(<48h) / `M-D` | `frontend/services/broadcast.js:18`、`frontend/pages/ai-chat/ai-chat.js:188` |
| 7 | `eventIcon(eventType)` | `:82-86` | 用户事件类型 → emoji 图标；`STREAK_*` 前缀统一 🔥，未知 📌 | `broadcast.js:15`、`profile.js:65` |
| 8 | `quizDots(progress, reveal = true)` | `:94-100` | 答题逐题进度 → `{seq, cls}` 点列；`reveal=false`（交卷模式）时已答题显示中性 `done` 不泄露对错 | `frontend/pages/quiz/quiz.js:48`、`frontend/pages/quiz-answer/quiz-answer.js:130` |

内部实现要点：

- **`parseUtc(iso)`（`:46-49`，内部）**：后端时间列为 UTC 存储的 naive ISO（无时区后缀，`:34` 注释），统一补 `'Z'` 后缀按 UTC 解析；已带 `Z` 的不重复追加（`indexOf('Z')` 判断，`:48`）；空值/无效返回 `NaN`。`formatTime` 与 `formatRelative` 共用（`:38`、`:56`），修复了此前本地时区误读偏 8 小时的缺陷（`e70b59f`，见 §10；`frontend/test/docs/s16-miniprogram-review-fixes-report.md` 「后端 naive UTC 时间按本地时区解析偏 8 小时 → 统一走 parseUtc」）。
- **`EVENT_ICONS` 常量表（`:68-80`，未导出）**：11 个事件类型到 emoji 的映射（FIRST_STEP/DAILY_GOAL/NODE_UNLOCK/CHAPTER_COMPLETE/BADGE_UNLOCK/QUIZ_COMPLETE/QUIZ_FULL_SCORE/STEP_10000/TOTAL_STEPS_100000/TOTAL_STEPS_500000/COMPLETE_ROUTE），时间轴与实时动态共用（`:67` 注释）。
- **`quizDots` 的 cls 取值**：`right / wrong / done / timeout / answering / pending`（`:92` JSDoc）——`answered` 状态按 `reveal` 映射为 right/wrong 或 done，其余状态原样透传（`:98`）。

## 5. 输入与输出

- 输入/输出：见 §4 表格；全部为纯函数，异常路径只有「无效时间返回 `''`」（`:39`、`:57`）与「falsy 数字按 0」（`:21`、`:26`）两类静默兜底，不抛错。
- `formatNumber` 对**小数**输入会把千分位逗号也插入小数部分（正则 `\B(?=(\d{3})+(?!\d))` 作用于整个数字字符串，`:21`），如 `1234.5678 → 1,234.5,678`；现有调用方传入的均为整数步数/积分（§4 表），未观察到小数入参——是否需要支持小数**待确认**（现状按整数口径使用）。

## 6. 依赖关系

- 依赖：无（零 require、零 wx API）。
- 被依赖（全仓 grep `utils/util` 的 require 方，共 **13 个**）：`frontend/services/broadcast.js:5`（服务层唯一使用者），页面 12 个——`pages/account:6`、`pages/ai-chat:11`、`pages/calendar:8`、`pages/ceremony:12`、`pages/home:17`、`pages/medals:7`、`pages/node-detail:10`、`pages/profile:11`、`pages/quiz:8`、`pages/quiz-answer:13`、`pages/ticket:8`（均 `const util = require('../../utils/util')` 形式）。
- 上游数据契约：`formatTime`/`formatRelative` 的入参格式与后端 UTC naive ISO 时间列绑定（`:34-35`）；`eventIcon` 的事件类型枚举与后端 `event_service.build_text` 的 eventType 口径对应（消费点 `broadcast.js:15`，后端侧见 `.qoder/backend/app/services/event_service.py.md`）；`quizDots` 的 `progress` 结构与后端答题进度字段（`seq/status/correct`）一致（`:90` JSDoc）。

## 7. 业务规则

1. **时区口径**：后端存 UTC naive，前端展示转本地（北京时间）——所有时间展示必须经 `parseUtc` 补 `Z`，直接 `new Date(iso)` 会偏 8 小时（§4，历史缺陷已修）。
2. **交卷模式不泄露对错**：`quizDots(progress, false)` 时已答题统一 `done` 中性态（`:91` JSDoc、`:98`），quiz 页按 `mode !== 'review'` 传参（`quiz.js:48`、`quiz-answer.js:130`）。
3. **相对时间分档**：<1min 刚刚、<1h 分钟、<24h 小时、<48h 昨天、更早 `M-D`（`:59-64`）——与实时动态卡展示需求一致（`frontend/design.md` 首页实时行军段「相对时间（util.formatRelative）」）。
4. 图标兜底：未知事件类型统一 📌、连续打卡类（STREAK_ 前缀）统一 🔥（`:83-85`），新增后端事件类型不会渲染出 undefined。

## 8. 修改约束

1. **零死代码要求**：本文件历史上两次清理 Mock 时代死函数（`b467a8a` 删 `recentDates/randomInt/shuffle/seededSteps`，`frontend/test/docs/s7-cleanup-smoke-report.md`；更早的清理见该报告）。当前 **8 个导出全部有真实调用方**（§4/§6 grep 核实），新增导出前须确认有消费方，避免再积压死代码（根 `agents.md` §2.2）。
2. `parseUtc` 保持内部私有：其 `'Z'` 追加逻辑专为后端 naive ISO 设计，若导出被用于已带时区/非 ISO 字符串会产生错误偏移。
3. 时间函数返回值 `''` 兜底是 WXML 直绑契约（页面不做二次判空），改为抛错会破坏 12 个页面。
4. `quizDots` 的 `cls` 枚举值与 `app.wxss`/页面 WXSS 的点样式类名一一对应（`right/wrong/done/timeout/answering/pending`），改名须同步样式。
5. 按 `frontend/AGENTS.md` §5.1，禁止把这里的函数复制进 service/页面。

## 9. 当前实现状态

- **已实现**：8 个导出函数全部在用，覆盖 13 个消费文件（§6）。
- **存在问题 / 已知事项**：
  1. `formatNumber` 小数输入行为未定义（§5，现调用方均为整数，待确认是否需要修）。
  2. 无零调用导出（grep 核实）——`pad` 虽主要作内部补零用，但 calendar 页有 2 处外部调用（`calendar.js:14`、`:92`），不属死代码。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/utils/util.js`，共 **9 个提交**；对应条目均见 `docs/迭代记录.md`。按时间倒序。早期提交（`7e587c9`、`a94e685`）对本文件的具体改动仅有提交信息与测试报告佐证，未逐一核对 diff。

### 2026-10-17（`0052108`）
- 需求：AI 历史助手聊天页（情报 tab 替换为 AI 问答）。
- 修改内容（涉本文件，据 `git show 0052108` diff）：仅注释——`quizDots` JSDoc「答题 tab 与答题页共用」改为「quiz 页与答题页共用」（答题从 tab 降级为子页）。
- 关联文件：`frontend/pages/ai-chat/ai-chat.js`（新增，消费 `formatRelative`）、`frontend/app.json`。
- 测试结果：见 `docs/迭代记录.md` 的 `0052108` 条目。

### 2026-10-13（`2ea4797`）
- 需求：情报 tab「交卷看解析」答题交互对比演示。
- 修改内容（涉本文件）：`quizDots` 新增 `reveal` 开关，交卷模式已答题统一中性 `done`（`frontend/test/docs/v2-quiz-modes-report.md`）。
- 测试结果：见 `docs/迭代记录.md` 的 `2ea4797` 条目。

### 2026-10-13（`44eb77b`）
- 需求：V2.0 小程序批次（答题 90 秒逐题限时等）。
- 修改内容（涉本文件，据 `git show 44eb77b` diff）：新增 `quizDots(progress)` 并导出。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（v2 自动化验收 14/14）。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复批次。
- 修改内容（涉本文件，据 `git show e70b59f` diff）：① 新增 `EVENT_ICONS` 表与 `eventIcon`；② `formatTime` 改走新抽出的 `parseUtc`，修复 naive UTC 按本地时区解析偏 8 小时的缺陷。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-03（`c92598c`）
- 需求：全员共同长征目标（P1-4）。
- 修改内容（涉本文件）：新增 `formatCn` 中文大数格式化（`frontend/test/docs/p1-global-goal-report.md`）。
- 测试结果：见 `docs/迭代记录.md` 的 `c92598c` 条目。

### 2026-10-03（`17a4d98`）
- 需求：实时行军动态（P1-1）。
- 修改内容（涉本文件）：新增 `formatRelative` 相对时间（`frontend/test/docs/p1-activities-report.md`）。
- 测试结果：见 `docs/迭代记录.md` 的 `17a4d98` 条目。

### 2026-10-02（`b467a8a`）
- 需求：清理 Mock 时代零引用死代码。
- 修改内容（涉本文件）：删除 `recentDates/randomInt/shuffle/seededSteps`（全仓 grep 零引用），保留 `pad/formatDate/formatNumber/formatTime`（`frontend/test/docs/s7-cleanup-smoke-report.md`）。
- 测试结果：见 `docs/迭代记录.md` 的 `b467a8a` 条目。

### 2026-10-02（`7e587c9`）
- 需求：小程序页面高级化升级（首页重组/档案/行军日历/到达动画/情报化/勋章墙）。
- 修改内容（涉本文件）：提交信息未列明本文件细节，具体改动**仅以提交信息为据**（推测与新增页面的格式化需求相关，未核 diff）。
- 测试结果：见 `docs/迭代记录.md` 的 `7e587c9` 条目。

### 2026-09-30（`a94e685`）
- 需求：项目初始化（feat: init）。
- 修改内容（涉本文件）：创建本文件；初始导出集合未核 diff，以 `b467a8a` 清理记录反推含 Mock 时代工具函数。
- 测试结果：见 `docs/迭代记录.md` 的 `a94e685` 条目。
