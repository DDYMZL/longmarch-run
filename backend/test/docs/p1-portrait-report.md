# P1-7 数据画像（后端侧）测试报告

日期：2026-10-03 · 范围：`GET /api/profile/summary` 新增 `portrait` 五维数据画像（需求 §17）

## 改动摘要

- `app/services/profile_service.py`
  - 新增满分参照配置：`PORTRAIT_DAYS_FULL=30`（运动天数）、`PORTRAIT_STREAK_FULL=30`（连续天数）、`PORTRAIT_QUIZ_FULL=50`（答题次数）。
  - 新增 `_portrait(...)`：五维评分全部由 `get_summary` 已聚合的统计量推导，**不新增任何数据库查询**；
    连续里程碑档数由 `max_streak` 对 `event_service.STREAK_MILESTONES`（3/7/14/30/60）直接计数，不查 user_event。
  - `get_summary` 返回新增 `portrait` 字段。
- `app/schemas/schemas.py`：新增 `ProfilePortrait`（march/persistence/knowledge/route/achievement，均 int 默认 0），`ProfileSummaryOut` 增加 `portrait` 字段。

## 计算公式（§17.3，仅展示数据、不做「优秀/较差」类评价 §17.4）

| 维度 | 公式 |
| --- | --- |
| 行军 | 累计步数/路线全程目标×70 + min(运动天数,30)/30×30 |
| 坚持 | min(最长连续,30)/30×60 + min(当前连续,30)/30×40 |
| 知识 | min(答题次数,50)/50×50 + 正确率×0.5 |
| 路线 | 节点完成比例（litCount/totalCount×100） |
| 成就 | 勋章完成比例×70 + 连续里程碑达成档数/5×30 |

各维 `min(100, round(v))`，值域 0~100。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P1O-01 | 画像五维齐全、值域 0~100；全新用户行军/坚持/知识/成就为 0，路线=天然进度（瑞金目标 0 步天然完成 → 1/10=10） | 通过 |
| P1O-02 | 同步 8000 步点亮后：行军=10/路线=20 > 0、知识=0；五维取值与 summary 自身统计按公式交叉验证完全一致 | 通过 |
| P1O-03 | 未带 token 401 | 通过 |

执行：`python test/p1_portrait.py` —— **3/3 通过**。

回归：`python test/p1_footprints.py` 4/4、`python test/p1_global_goal.py` 4/4、`python test/p0_route_progress.py` 10/10。

## 备注

- 首次用例设计假设全新用户五维全 0，实测路线维度为 10：瑞金（目标 0 步）在路线状态口径下天然完成（与 P1K-01 空足迹不矛盾——空足迹指无 LitNode 点亮记录，路线完成度按节点状态计）。已修正断言为「路线=天然进度」并按公式交叉验证。
- 五维评分落在后端（业务规则单一事实来源），前端仅负责雷达图渲染（§17 分层约束）。
