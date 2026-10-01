# S3 小程序聚合接口 验收报告

日期：2026-10-02 ｜ 阶段：S3（小程序聚合接口）｜ 结果：**15/15 通过**

## 范围

| 接口 | 说明 |
| --- | --- |
| `GET /api/profile/summary` | 档案聚合：用户信息（含 joinDays）+ 运动/路线统计 + 答题 + 勋章 + 积分 |
| `GET /api/profile/timeline?limit=50` | 我的长征足迹（user_event 倒序，文案后端生成） |
| `GET /api/sport/calendar?month=YYYY-MM` | 行军日历：整月逐日步数档位/达标/答题/点亮标记 + 月度统计 |
| `GET /api/sport/today` 扩展 | currentStreak/maxStreak/streakGoal/todayGoalCompleted/nextStreakMilestone/streakRemain |
| `POST /api/march/light-up` 扩展 | newlyLit 元素含 gainedPoints/litAt/nextNode{name,remain} |
| `GET /api/march/node/{id}` 扩展 | brief/significance/figures/location/images/audio/keywords |
| `GET /api/broadcast/today` | 全局播报 + 个人播报（beatPercent/remainToNext）+ 长征记忆彩蛋 |
| `GET /api/quiz/daily` 扩展 | issueNo（第 N 期，基准 2026-09-01） |
| `GET /api/quiz/knowledge` | 知识画像：event/route/figure 三分类正确率 + overallRate |
| `GET /api/medal/list` 扩展 | category/hidden/sortOrder/grantedAt/conditionDesc（隐藏未获得不公开条件） |
| submit wrongList | 元素新增 questionId/category（schema 同步暴露） |

## 冒烟脚本

`backend/test/s3_aggregates.py`（黑盒，需后端 8010 运行）。场景：新用户 6000 步 → 全错答卷 → 点亮 → 逐项断言。

```
Q1 quiz/daily issueNo=32 ✓        Q2 wrongList 含 questionId/category ✓
M1 light-up gainedPoints/litAt/nextNode ✓   M2 node 详情内容字段 ✓
S1 sport/today 连续行军字段 ✓      C1/C2/C3 calendar 格子/统计/格式校验 ✓
Q3 knowledge 全错画像 ✓           D1 medal 扩展字段+隐藏条件 ✓
P1/P2 summary ✓                   T1 timeline 文案 ✓
B1/B2 broadcast 全局/个人/记忆 ✓
```

## 过程中发现并修复的问题

**UTC 存储时间 vs 本地业务日期错位（8 小时）**：库内 `lit_at`/`created_at`/`event_time` 均为
`datetime.utcnow` naive 存储，而业务日期（daily_sport.date 等）按本地时区。新聚合按本地
日期分桶/比较时在凌晨时段跨日误判（日历点亮标记缺失、todayLitCount=0、joinDays=2）。

修复：`helpers` 新增 `to_local()` / `local_to_utc()`，三处调用点统一换算：
- `sport_service.get_calendar` 点亮记录按月范围（UTC 边界）过滤、按本地日期归格；
- `broadcast_service` 今日点亮数以本地 0 点的 UTC 等价比较；
- `profile_service._join_days` 按 UTC→本地日期计算。

另：uvicorn WatchFiles 本次未捕获 app/ 源码改动（仅捕获到 test/ 文件），重启进程后加载新代码。
冒烟异常时仍须先确认 8010 进程服务的是否为新代码。

## 契约确认

- 全部新字段 camelCase 输出（`issueNo`/`gainedPoints`/`litAt`/`nextNode`/`beatPercent`/`grantedAt`/`conditionDesc`/`overallRate` 等）；
- `broadcast/today` 顶层键 `global`（Python 端字段名 `global_`，别名输出）；
- 答案仍不下发；knowledge 只返回正确率聚合。
