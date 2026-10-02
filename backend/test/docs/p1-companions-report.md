# P1-2 同组织同行者（后端侧）测试报告

日期：2026-10-03 · 范围：`GET /api/org/companions` 同组织同行者接口（需求 §9）

## 改动摘要

- `app/services/org_service.py`
  - 新增 `_subtree_org_ids(db, root_id)`：组织整表一次加载、内存 BFS 求子树 id 集（无逐层查询）；
  - 新增 `get_companions(db, user, limit)`：
    - 同行人数 = 子树成员 COUNT；
    - 今日共同前进 = 子树成员当日 `daily_sport.steps` 之和（JOIN 聚合）；
    - 同行者 = 子树成员 LEFT JOIN 当日步数，倒序限量，标 `is_self`。
- `app/api/routes/org.py`：新增 `GET /org/companions?limit=`（1~50 钳制，需用户 JWT）。
- `app/schemas/schemas.py`：新增 `CompanionItemOut` / `OrgCompanionsOut`（org 复用 `UserOrgOut`）。

## 口径与隐私（需求 §9.4）

- 「同组织」= 用户所选组织的**整棵子树**（含下级组织），与管理端组织人数统计口径一致；
- 同行者条目只下发 `nickname / avatar / todaySteps / isSelf`，不含用户 id、openid 等；
- 固定 4 次查询（子树 id / COUNT / SUM / TOP-N），无 N+1。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P1C-01 | 未选组织：org=null / memberCount=0 / companions=[] | 通过 |
| P1C-02 | 本人入列：isSelf 标记与今日步数正确 | 通过 |
| P1C-03 | 同伴加入：memberCount+1 / todayTotal+4000 / 列表按步数倒序 | 通过 |
| P1C-04 | 隐私：条目字段 ⊆ {nickname,avatar,todaySteps,isSelf} | 通过 |
| P1C-05 | limit=1 截断且第一名为最高步数 | 通过 |
| P1C-06 | 子树口径：兄弟组织成员在选父组织后计入（人数/总量/组织名） | 通过 |
| P1C-07 | 未带 token 401 | 通过 |

执行：`python test/p1_companions.py` —— **7/7 通过**（相对增量断言，不受历史测试用户影响）。

## 备注

- 组织树较小（当前 13 节点），子树 id 整表加载内存 BFS 是最简且足够快的实现；若组织规模大幅增长可改物化路径，当前不做过度设计。
