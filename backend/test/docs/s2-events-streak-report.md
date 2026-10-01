# S2 事件系统与连续行军 验证报告

日期：2026-10-01
范围：`event_service`(新) / `streak_service`(新) / `sport_service` / `march_service` / `quiz_service` / `medal_service` / `core/ws.py` / `core/config.py` / `main.py`

## 1. 实现要点

- **user_event 统一事件**：运动/答题/点亮/勋章/连续行军全部落 `user_event`，`event_service.record` 同时经 WS 广播 `activity` 消息（含昵称与文案），供管理端动态流；足迹时间轴（S3）同源。
- **连续行军**：当日步数 ≥ `STREAK_GOAL_STEPS`(5000) 记达标；`on_sport_written` 在「当日首次达标」时推进 users 缓存并发里程碑（3/7/14/30/60 天，积分 5/10/20/30/60，事件表去重=一次性成就）；`compute_streaks` 以 `daily_sport.is_goal_completed` 为准（今日未达标允许连续算到昨日）；启动 `recompute_all` 全量兜底。
- **新勋章判定**：persistence(连续7天)/streak-30(连续30天)/day-10k(单日破万)/steps-100k/steps-500k/fearless(隐藏，连续7天每天破万)，均在 `check_and_grant` 内以记录实时计算。
- **light-up 扩展**：`LitNode.step_snapshot` 记录点亮时刻累计步数；点亮/完成路线写 NODE_UNLOCK/COMPLETE_ROUTE。
- **quiz**：提交写 QUIZ_COMPLETE/QUIZ_FULL_SCORE；`wrong_list` 元素落库新增 `question_id`/`category`（知识画像数据源；响应模型暂按既有契约过滤，S3 扩展）。
- **历史数据**：启动重算只回写连续天数缓存，不补写历史事件（避免动态流刷屏）；足迹自今日起累积。

## 2. 冒烟结果（`test/s2_streak_events.py`，8/8 通过）

| 用例 | 结果 |
| --- | --- |
| A1 首次运动写 FIRST_STEP、未达标无 DAILY_GOAL、连续=0 | PASS（路由勋章链同步发 first-step，属预期） |
| A2 当日达 5000 写 DAILY_GOAL、连续=1 | PASS |
| A3 单日破万写 STEP_10000 | PASS |
| A4 first-step/day-10k 勋章发放 + 2 条 BADGE_UNLOCK | PASS |
| A5 点亮节点 1/2/3 → 3 条 NODE_UNLOCK、step_snapshot=11000 | PASS |
| B1 历史 2 天 + 今日达标 → 连续 3 天、STREAK_3、积分「连续行军3天」+5 | PASS |
| B2 同日再写不重复产生 DAILY_GOAL/STREAK_3 | PASS |
| C1 WS 收到 activity 消息（type/eventType/nickname/text/at 齐全） | PASS |

补充单测：
- 满分答题 → QUIZ_COMPLETE + QUIZ_FULL_SCORE 落库，score=100、points=15 ✓
- 全错答题 → DB `wrong_list[0]` 含 `question_id=4, category=event` ✓（API 响应按 WrongItem 契约过滤新字段，S3 决定是否暴露）

## 3. 过程记录

- 冒烟断言两轮修正：A1 断言未计入路由侧勋章链事件；A5 改用节点 id 比较（控制台 GBK 显示乱码不影响数据，但名称比较有编码风险）。
- 后台任务「failed」提示为假警报：两个 python 进程（reloader+worker）均在存活服务；后续重启前先 `netstat`+`tasklist` 复核。

## 4. 结论

事件系统与连续行军链路就绪，可进入 S3（小程序聚合接口：profile/timeline/calendar/broadcast/knowledge 等）。
