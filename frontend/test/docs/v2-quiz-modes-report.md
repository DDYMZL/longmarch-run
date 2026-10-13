# 情报 tab 双答题交互模式 · 验收报告

- 日期：2026-10-13
- 范围：`frontend` 小程序「情报」tab（`pages/quiz/quiz`、`pages/quiz-answer/quiz-answer`、`utils/util.js`、`app.wxss`）
- 目标：在同一「情报」tab 内提供两种答题交互，供领导对比演示：
  - **情报1 · 即时判定**（原有）：每题提交后立即显示对/错、正确答案与解析；
  - **情报2 · 交卷看解析**（新增）：作答过程不显示对错，逐题静默推进，全部提交后统一查看全部解析。
- 后端未改动，两模式共用同一套每日答题链路（`/quiz/start`、`/quiz/answer`）。

## 1. 实现要点

| 位置 | 变更 |
| --- | --- |
| `pages/quiz/quiz.*` | 顶部新增模式切换（情报1 即时判定 / 情报2 交卷看解析）；规则文案随模式变化；开始按钮按模式带 `?mode=review` 跳转；进度点按模式着色（交卷模式已答题不揭示对错） |
| `pages/quiz-answer/quiz-answer.*` | 通过 `?mode=` 支持两种交互：`instant` 即时反馈；`review` 提交后不揭示对错、静默推进下一题，最后一题提交进入「交卷态」，点「查看全部解析」跳 `quiz-result` 统一展示 |
| `utils/util.js` | `quizDots(progress, reveal)` 新增 `reveal` 开关；交卷模式已答题统一为中性 `done` |
| `app.wxss` | 新增 `.quiz-dot.done` 中性态样式（灰蓝，区别于 right/wrong/timeout） |

> 说明：微信原生 tabBar 的 `list` 上限为 5 个，现有 5 个 tab 已占满，无法直接新增第 6 个底部 tab；经确认采用「情报 tab 内顶部模式切换」方案承载「情报2」。

## 2. 自动化验收（微信开发者工具，5/5 通过）

脚本：`frontend/test/automator/v2-quiz-modes.cjs`（结果 `results-v2-quiz-modes.json`）。

```
PASS | M1 情报 tab 模式切换（默认即时判定→情报2） | default=instant active=情报2 · 交卷看解析
PASS | M2 即时判定：提交后即时反馈对错/解析 | correct=true marked=true dot=true
PASS | M3 交卷模式：作答中提交不揭示对错、静默推进 | 5 题均无对错泄露
PASS | M5 交卷模式：5 题提交后进入交卷态，进度点全为 done | phase=submitted dots=done,done,done,done,done card=1
PASS | M6 交卷模式：查看全部解析 → 结果页逐题解析 | details=5 correct=5/5
合计 5/5 通过
```

- **M2** 为即时判定回归：确认改造后原有交互（提交即反馈、选项 right/wrong、进度点 right/wrong）行为不变。
- **M3** 关键断言：交卷模式每轮作答态均满足「选项无 right/wrong、进度点无 right/wrong、`feedback=null`」，且提交后 `seq` 静默 +1（不进入 `feedback`）。
- **M6** 交卷后进入结果页，逐题解析 5 条一次性展示（即「交卷后看全部解析」）。

## 3. 视觉证据（`frontend/test/images/`）

| 截图 | 内容 |
| --- | --- |
| `60-v2-quiz-mode-switch.png` | 情报 tab：顶部模式切换，情报2 高亮 |
| `61-v2-quiz2-answering.png` | 情报2 作答中：选项已选中但无对/错标记，提示「作答中不显示对错，交卷后统一查看解析」 |
| `62-v2-quiz2-submitted.png` | 情报2 交卷态：`5/5`、环形「已交」、进度点全为中性 done、「✓ 全部题目已提交」+「查看全部解析」 |
| `63-v2-quiz2-result.png` | 交卷后结果页：答对数/正确率 + 逐题「我的答案/正确答案/解析」一次性展示 |

## 4. 复跑方法

```bash
# cwd 必须为 frontend/test/automator；后端 8010 运行，开发者工具 cli auto --auto-port 9420
node v2-quiz-modes.cjs                       # 5/5 断言
node v2-quiz-modes-shots.cjs                 # 4 张截图（每状态独立连接，失败自愈重试）
node v2-quiz-modes-shots.cjs --only=63       # 仅补拍指定状态
```

前置：`../v12-fixture.json`（测试用户 token 与全题库答案）；脚本会调用 `/quiz/reset` 重置测试用户当日答题。

## 5. 已知限制 / 备注

- 截图会让自动化桥退化（本套件通病）：截图脚本按「每个状态独立连接 + 失败时 `cli auto` 自愈重试」实现；多次反复截图后建议清理残留 IDE 进程后再跑。
- 两模式共用同一天「每日答题」记录（每日一次）：演示两种效果之间需在情报 tab 点「开发调试：重置本期情报」。
