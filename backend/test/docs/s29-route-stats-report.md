# S29 全员路线抵达统计 `/march/route-stats` 冒烟测试报告

- 脚本：`backend/test/s29_route_stats.py`（SQLite + TestClient，不依赖 8010 端口进程、不碰共享 openGauss）
- 时间：2026-10-19
- 结果：**9/9 通过**；`s20_v2_regression.py` 复测 **26/26 通过**（回归无破坏）
- 关联需求：小程序「星空长征」地图升级为深空 HUD 展示型路线图，需叠加各节点全员抵达人数

## 一、本次改动

| 位置 | 改动 |
| --- | --- |
| `app/services/march_service.py` | 新增 `_sorted_user_total_steps` / `compute_route_stats`（未缓存实现）/ `get_route_stats`（60s TTL 缓存）/ `invalidate_route_stats_cache` |
| `app/services/dashboard_service.py` | `get_dashboard` 改为调用 `march_service.compute_route_stats`；删除重复的 `_user_total_steps`、`_enabled_nodes` 与 `bisect_left`、`RouteNode` 导入 |
| `app/services/admin_service.py` | 节点新增/编辑/启停成功后调用 `invalidate_route_stats_cache()`（与既有 `invalidate_chapter_cache()` 同一模式） |
| `app/api/routes/march.py` | 新增 `GET /route-stats`，鉴权沿用 `require_activity_view` |
| `app/schemas/schemas.py` | 新增 `RouteNodeStatOut` / `RouteStatsOut`（CamelModel） |

**为什么抽共用函数**：抵达人数口径（累计步数达标即视为抵达）原先只内联在 `get_dashboard`
里，小程序若另写一份必然漂移。抽取后两端同源，且顺带消除了 `march_service._ordered_nodes`
与 `dashboard_service._enabled_nodes` 的重复查询实现。

**为什么不能反过来放 dashboard_service**：`dashboard_service → org_service → march_service`
已存在依赖链，`march_service` 反向 import `dashboard_service` 会构成循环导入。故共用函数落在
`march_service`（节点抵达本就是 march 域的业务规则），由 dashboard 消费。

**为什么加缓存**：底层是全量用户步数聚合。march 是 tab 页、`onShow` 即刷新，属高频路径；
展示型 HUD 可接受 60s 延迟。管理端驾驶舱**不走缓存**（直接调 `compute_route_stats`），
实时口径未被改变（R08 专门验证）。

## 二、覆盖矩阵

测试数据：5 个用户（累计步数 500 / 1500 / 6000 / 25000 / 无记录），4 个节点
（甲站 1000、乙站 5000、丙站 20000 启用；停用站 30000 停用，sort_order 最大）。

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| R01 鉴权 | 未带 token → 401 | PASS |
| R02 契约 | 响应仅 `{totalUsers, nodes}`，节点项仅 `{nodeId, litCount, completionRate}`，全 camelCase 无 snake_case 泄漏 | PASS |
| R03 口径 | 抵达人数 `[3,2,1]`（二分计数正确），完成率 `[60,40,20]` = round(lit/5×100)，totalUsers=5 | PASS |
| R04 过滤排序 | 仅 3 个启用节点、按 sort_order 升序（抵达人数递减）；停用节点存在于 admin 列表但不出现在本接口 | PASS |
| R05 两端一致 | 与 `/api/admin/dashboard` 的 `route_overview` 逐项（node_id/lit_count/completion_rate）完全相等；`metrics` 的 total_users=5、total_steps=33000、avg_steps=6600、completion_rate=20 与重构前口径一致 | PASS |
| R06 缓存命中 | 打桩计数 `_sorted_user_total_steps`：连续 3 次请求只聚合 1 次 | PASS |
| R07 失效重算 | 追加步数后未失效 → 仍返回旧值 `[3,2,1]`；调 `invalidate_route_stats_cache()` → `[4,3,2]`，聚合次数 +1 | PASS |
| R08 管理端实时性 | march 侧缓存 `[4,3,2]` 期间新增用户步数，`/api/admin/dashboard` 立即变为 `[5,4,3]`、total_steps=83000；march 侧再请求仍为缓存值 → 证明驾驶舱实时口径未被缓存破坏 | PASS |
| R09 管理端联动失效 | `PUT /api/admin/route-nodes/{丙站}` 把 target_steps 20000→60000 后，小程序侧无需手工失效即从 `[5,4,3]` 变为 `[5,4,0]` | PASS |

R09 特意选择修改**末节点**：`_validate_enabled_route` 要求启用节点目标步数随 sort_order
严格递增，改首节点会触发 400 而测不到失效逻辑。

## 三、回归

- `s20_v2_regression.py` **26/26 通过**（覆盖活动准入、步行/答题积分、总积分榜、组织选择等，
  其中 C01/C03 涉及管理端与小程序同口径比对）。
- `s9_rbac_access.py` 有 2 处失败，均为**预存的测试脚本漂移**，与本次改动无关：
  - A1 硬编码 `len(me["menus"]) == 9`，实际菜单已增至 21 个（该脚本上次更新为 2026-10-09，
    其后新增了驾驶舱/大屏/AI 中心等菜单）；
  - A2a 断言 detail 含「撤销或禁用」，实际返回「管理员令牌无效」。
  两处失败点都不在 dashboard 数据链路上；本次改动的 dashboard 正确性由 S29 R05/R08 直接验证。

## 四、残留数据清理

脚本使用独立临时库 `backend/test/_smoke_s29.db`，`finally` 中 `engine.dispose()` 后删除
（Windows 文件锁需先 dispose，否则 PermissionError）；结果 JSON 输出到
`backend/test/s29-route-stats-results.json`。未写入共享 openGauss，未新增任何生产数据。

## 五、未覆盖 / 后续

- 未在真实 openGauss 上验证（本接口无 DDL、无方言相关语法，仅 `GROUP BY` 聚合 + Python 侧
  二分，SQLite 与 openGauss 行为一致）。生产部署后建议按 `s4_admin_dashboard.py` 方式对
  `/api/march/route-stats` 与 `/api/admin/dashboard` 做一次同口径比对。
- 缓存为**进程内**：多 worker 部署时各进程独立计时，最坏延迟为 60s，对展示场景可接受。
