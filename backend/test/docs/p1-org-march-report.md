# P1-3 组织共同长征目标（后端侧）测试报告

日期：2026-10-03 · 范围：`GET /api/org/march` 组织共同长征目标接口（需求 §10）

## 改动摘要

- `app/services/march_service.py`
  - 抽取 `_route_state(nodes_def, lit, current_steps)`：节点状态（completed/current/unlocked）、路线进度、当前区间进度的计算内核，个人路线与组织路线共用；`get_route` 改为调用它，对外契约不变。
- `app/services/org_service.py`
  - 新增 `get_org_march(db, user)`：
    - 组织累计步数 = 子树成员 `daily_sport.steps` 全量之和（按用户+日期覆盖存储，天然无重复统计，§10.4）；
    - 组织路线按组织累计步数现算（复用 `_route_state`，组织无持久点亮概念）；
    - 节点 pct：已完成 100 / 当前节点按累计占其目标比例 / 其余 0（§10.3）；
    - 「当前到达」= 第一个未完成节点，「下一站」= 其后一个节点；全部完成时当前=末节点、下一站为空（§10.2）。
- `app/api/routes/org.py`：新增 `GET /org/march`（需用户 JWT）。
- `app/schemas/schemas.py`：新增 `OrgMarchNodeOut` / `OrgMarchOut`。

## 口径说明

- 「组织」= 用户所选组织的**整棵子树**，与 P1-2 同组织同行者、管理端人数统计口径一致；
- 固定 4 次查询（子树 id / COUNT / SUM / 节点定义），无 N+1；
- 组织进度为实时聚合，不写 `LitNode`、不发积分、不写事件（§10.4：与个人路线解耦）。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P1M-01 | 未选组织：org=null / totalSteps=0 / nodes=[] | 通过 |
| P1M-02 | 成员同步 +8000 步后 totalSteps 恰增 8000 | 通过 |
| P1M-03 | 自洽性：statuses/pct/current/next/progressPct 由响应 totalSteps 重算一致 | 通过 |
| P1M-04 | 子树口径：选父组织后兄弟组织成员步数计入 | 通过 |
| P1M-05 | 完成态边界：total≥65000 时 finished=true、litCount==totalCount、progressPct=100、current=延安、next=''；未完成时 finished == (litCount==totalCount>0) | 通过 |
| P1M-06 | 未带 token 401 | 通过 |

执行：`python test/p1_org_march.py` —— **6/6 通过**（相对增量与自洽断言，不受历史测试用户影响）。

回归：`python test/p0_route_progress.py` 10/10、`python test/p0_chapters.py` 10/10（`_route_state` 抽取零回归）。

## 备注

- `_route_state` 抽取动机：个人路线的 lit 集含历史持久点亮（点亮永久保留），组织路线则完全按累计步数现算；两者状态/进度算法相同、lit 集构造不同，故只抽计算内核、lit 集由调用方构造，避免复制整段状态机。
- P1M-05 曾误断言 `finished is False`：组织子树累计步数随测试运行单调增长，超过延安目标（65000）后 finished 恒为 true；改为「完成态显式断言 + 未完成态自洽断言」两组，对单调增长数据稳健。2026-10-09 批次 6 全链路回归进一步发现：数据库重建后子树累计不足 65000 时「完成态显式断言」失效，已改为测试内显式补步推过目标（`/sport/add` 差额），对 DB 重建同样稳健。
