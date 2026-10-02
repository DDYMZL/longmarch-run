# P1-4 全员共同长征目标（后端侧）测试报告

日期：2026-10-03 · 范围：`GET /api/march/global` 全员共同长征目标接口（需求 §11）

## 改动摘要

- `app/services/march_service.py`
  - 新增模块级配置 `GLOBAL_GOAL_STEPS = 2亿`、`GLOBAL_MILESTONES`（5000万/1亿/1.5亿/2亿，名称随配置可改，管理端可视化编辑为后续增强）；
  - 新增 `get_global_goal(db)`：全员累计步数 = 全部用户 `daily_sport.steps` 之和（单条 SUM 聚合）；里程碑 reached 实时计算；`nextMilestone` 为首个未达成项（含 remain），全部达成时为 null；`progressPct` 保留 1 位小数。
- `app/api/routes/march.py`：新增 `GET /march/global`（需用户 JWT）。
- `app/schemas/schemas.py`：新增 `GlobalMilestoneOut` / `GlobalGoalNextOut` / `GlobalGoalOut`。

## 口径与边界

- 全员累计按用户+日期覆盖存储求和，天然无重复统计（§11 与 §10.4 同口径）；
- 单查询聚合，无 N+1；进度为实时计算，不落库；
- §11.3 的里程碑奖励（解锁内容/地图主题/全局动画/系统动态）本期不实现：系统动态需系统级事件通道（`user_event.user_id` 非空，属表结构变更），解锁类奖励需配套内容模型，均列为后续增强；本期「里程碑奖励」以首页卡片 ✓ 达成为展示闭环。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P1N-01 | targetSteps=2 亿、4 个里程碑名称/步数递增、progressPct 与 totalSteps 自洽（0.5 ↔ 1,000,613） | 通过 |
| P1N-02 | 两新用户跨组织补步 30000+12000 → 全员累计精确 +42000（无重复统计） | 通过 |
| P1N-03 | 里程碑 reached == (total ≥ steps)；nextMilestone=5000万 且 remain=48,999,387 精确 | 通过 |
| P1N-04 | 未带 token 401 | 通过 |

执行：`python test/p1_global_goal.py` —— **4/4 通过**（相对增量与自洽断言，不受历史数据影响）。

回归：`python test/p1_org_march.py` 6/6、`python test/p0_route_progress.py` 10/10、`python test/p0_chapters.py` 10/10。
