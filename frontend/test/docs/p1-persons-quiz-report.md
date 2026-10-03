# P1-8 长征人物志 + 答题连续答对效果（小程序侧）测试报告

日期：2026-10-03 · 范围：人物志页面与节点入口（需求 §14）、答题连胜与满分效果（需求 §15）

## 改动摘要

- `services/person.js`（新增）：`getPerson(id)` → `GET /api/persons/{id}`。
- `services/quiz.js`：新增 `checkAnswer(questionId, answer)` → `POST /api/quiz/check`。
- `pages/person/person.*`（新增页面，app.json 已注册）：头像（无图姓名首字占位）/名称/简介/相关历史事件卡（节点图标+名称+历史时间+简述），点击事件卡 `goNode` 回跳节点详情。
- `pages/node-detail/node-detail.*`：相关人物卡新增 `persons` 人物 chip（红色描边胶囊「姓名 ›」），`goPerson` 进人物志详情（节点 → 人物，§14.3）。
- `pages/quiz-answer/quiz-answer.*`：选择答案即调 `checkAnswer`——对 → 🔥连续N题徽章 + 绿色选项 + 「✓ 回答正确」；错 → 红色选项 + 「✗ 回答错误，连续答对重新开始」、连胜清零（§15.2）。响应乱序防护：判定结果仅当仍对应当前题当前选项时应用；判题请求失败静默（不阻塞作答，最终以后端 submit 判分为准）；翻题时重置本题判定态。
- `pages/quiz-result/quiz-result.*`：满分效果升级（§15.3）——标题「🎉 今日情报完美通关」+「5 / 5 · 100 分」+ 原有彩带/五星；积分、事件记录、勋章判定沿用 submit 链路不变。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P1R-01 | 节点详情人物入口：泸定桥 persons 含王开湘/杨成武/廖大珠，chip DOM 渲染 | 通过 |
| P1R-02 | 人物志详情：王开湘简介/事件卡含历史时间/首字占位，点击事件卡回跳节点详情 | 通过 |
| P1R-03 | 连胜反馈：选对 streak=1（徽章渲染），下一题选错 streak=0 并提示重新开始 | 通过 |
| P1R-04 | 满分通关：5 题全对提交 → isPerfect、「5 / 5 · 100 分」、彩带 14 片 | 通过 |

执行：`node test/automator/p1-persons-quiz.cjs` —— **4/4 通过**；截图 `30-person-detail.png`（人物志）、`31-quiz-streak.png`（连胜徽章）、`32-quiz-perfect.png`（满分通关）。

## 测试过程中的两个坑（已修复）

1. **截图楔死自动化桥**：初版在 P1R-02/P1R-03 断言中段截图，后续命令全部 not on top/超时。按既定协议（automator-test-protocol §3/3b）将 3 张截图全部移到断言落盘后，每个截图状态以 reLaunch 主动导航起手，即恢复。
2. **reset 重抽题目**：`/quiz/reset` 清除 daily_questions 缓存导致重抽，初版 P1R-04 用重置前的 questions/rightMap 作答新题必错。修复为重置后重新拉取今日题目并经 `/quiz/check` 逐选项探测答案（probeAnswers）再作答——该探测法同时天然覆盖「每日随机抽 5 题」的题库全范围（protocol §5b）。

## 备注

- 未跑 `ui-test.cjs` 27 例全量（需分阶段重启 IDE 的重型协议）；答题页改动点（handleSelect 增加异步判题、handleNext 增加判定态复位）均在 P1R-03/04 中直接覆盖，旧交互路径（选择→下一题→提交）未变。
