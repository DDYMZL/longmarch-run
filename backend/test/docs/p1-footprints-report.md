# P1-6 我的长征足迹（后端侧）测试报告

日期：2026-10-03 · 范围：`GET /api/march/footprints` 我的长征足迹接口（需求 §7）

## 改动摘要

- `app/services/march_service.py`
  - 新增 `get_footprints(db, user_id)`：LitNode JOIN RouteNode（仅启用节点、按路线顺序）；
    `lit_date` = lit_at 经 `to_local` 转本地日期（与 `DailySport.date` 同口径）；
    `day_steps` = 点亮当日步数（按点亮日期集合一次 IN 查询，无 N+1）；
    `cum_steps` = `LitNode.step_snapshot`（点亮时刻累计步数快照，历史回填数据为 0 由前端判空）。
- `app/api/routes/march.py`：新增 `GET /march/footprints`（需用户 JWT）。
- `app/schemas/schemas.py`：新增 `FootprintNodeOut` / `FootprintsOut`。

## 数据来源（需求 §7.4）

完全复用现有三张表：节点点亮记录（lit_nodes）、每日运动记录（daily_sport）、路线节点配置（route_nodes），**未新增任何冗余存储**。固定 2 次查询（JOIN 主查询 + 当日步数 IN 查询）。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P1K-01 | 未点亮节点的用户返回空足迹 nodes=[] | 通过 |
| P1K-02 | 同步 8000 步点亮后：瑞金/遵义按路线顺序、litDate=今日（2026-10-03）、daySteps=8000、遵义 cumSteps=8000（点亮时刻快照） | 通过 |
| P1K-03 | 足迹字段限于契约集合 {id,name,icon,litAt,litDate,daySteps,cumSteps}，无 userId | 通过 |
| P1K-04 | 未带 token 401 | 通过 |

执行：`python test/p1_footprints.py` —— **4/4 通过**。

回归：`python test/p1_global_goal.py` 4/4、`python test/p0_route_progress.py` 10/10、`python test/p0_chapters.py` 10/10。

## 备注

- lit_at 为 UTC 存储，`to_local` 转本地日期后再对齐 `DailySport.date`（本地口径），避免跨时区日期错位（如 UTC 23 点点亮落入次日）。
- 同一补步点亮场景下多节点共享同一 litDate 与 step_snapshot（一次 light-up 调用内点亮），属预期口径：§7.3 的「累计步数」语义为点亮时刻累计值。
- 测试用例名曾含「⊆」字符触发 Windows GBK 控制台 UnicodeEncodeError，已改纯中文表述（控制台输出编码约束）。
