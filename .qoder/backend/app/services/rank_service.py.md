# rank_service.py

## 1. 文件路径
`backend/app/services/rank_service.py`（共 133 行）

## 2. 文件职责
排名服务：全员工「总积分」总榜（跨所有组织），小程序与管理端共用同一口径。排名在数据库内用窗口函数 `row_number()` 计算，只取榜单所需的少量行，用户量大时不做全量加载（模块 docstring，`backend/app/services/rank_service.py:1-7`）。

## 3. 业务需求
- 积分台账重构（`2f3f333`）后，排名统一按「总积分 = 步行积分 + 答题积分」从高到低，同分按累计步数降序、再按 user_id 升序，保证名次稳定且小程序/管理端/CSV 三端一致（docstring :3-5）。
- 小程序排行榜页需要：领奖台 + 荣誉卡区（第 1~10 名，`ELITE_SIZE`，:17）始终返回；第 11 名起分页；当前用户名次始终返回（`get_points_rank` docstring :92）。
- 保留旧版 `/rank/steps` 榜单契约（前 100 名 `TOP_LIMIT` + 当前用户，:16,:117-118），名次与总积分榜一致。
- 性能要求：大数据量下避免全量加载与 N+1（`agents.md` §2.4；`f59892e`、`20c79e3` 两次优化的动机）。

## 4. 核心功能
### 4.1 `ranked_users_subquery(db)`（:20-45）
全员排名子查询，输出列 `user_id / steps / points / walk_points / quiz_points / rank`（docstring :21）：
- `totals`：`daily_sport` 按用户 `sum(steps)` 分组子查询（:22-29）；
- `pts`：`points_service.points_subquery(db)` 积分台账子查询（:30）；
- `User` outerjoin 两者（:42-43），`func.row_number().over(order_by=(points.desc(), steps.desc(), User.id.asc()))` 计算名次（:40），步数/积分以 `coalesce(..., 0)` 兜底（:31-32,38-39）。

### 4.2 `_board_query(db, ranked)`（:48-63）
私有：把排名子查询 join `User` 补齐 `nickname/avatar/org_id`，按 rank 排序，供两个榜单复用。

### 4.3 `_items(db, rows, current_user_id)`（:66-82）
私有：行 → dict 序列化。组织全名经 `org_service.get_full_name_map` **批量**查询一次（:67，`20c79e3` 消除 N+1），输出 rank/user_id/nickname/avatar/org_name/steps/points/walk_points/quiz_points/is_me。

### 4.4 `get_user_rank(db, user_id) -> Optional[int]`（:85-88）
单用户名次：在排名子查询上按 user_id 取 rank 标量；无记录返回 `None`。

### 4.5 `get_points_rank(db, current_user_id, page=1, page_size=20) -> Dict`（:91-114）
总积分榜三段式返回：
- `top`：rank ≤ 10（:95）；
- `list`：rank > 10 的第 page 页，多取 1 行探测 `has_more`（:96-101,108,112）；
- `me`：当前用户行（始终查询并返回，:102,109）；
- 三段行合并后一次性进 `_items`（:103），再按长度切分 top/rest（:104）；
- `total`：`User` 表全量 count（:105）；另返回 page/page_size/has_more（:110-112）。

### 4.6 `get_steps_rank(db, current_user_id) -> Dict`（:117-133）
旧版榜单契约：单查询取 rank ≤ 100 或当前用户本人（`or_`，:120-124），返回 `list` 全量 board、`my_rank`、`my_steps`（本人不在榜时 0，:130-131）、`total`（:127-132）。

## 5. 输入与输出
| 函数 | 输入 | 输出 |
| --- | --- | --- |
| `ranked_users_subquery` | `db` | SQLAlchemy subquery 对象（列见 §4.1） |
| `get_user_rank` | `db`、`user_id: int` | `Optional[int]` |
| `get_points_rank` | `db`、`current_user_id: int`、`page: int = 1`、`page_size: int = 20` | `Dict`：`top`/`list`/`me`（`Optional[Dict]`）/`page`/`page_size`/`has_more`/`total` |
| `get_steps_rank` | `db`、`current_user_id: int` | `Dict`：`list`/`my_rank`（`Optional[int]`）/`my_steps`/`total` |

榜内元素 dict 字段见 §4.3。本文件不抛业务异常、不写库、不 commit——纯只读查询服务；snake_case dict 由路由层 schema 转 camelCase 输出。

## 6. 依赖关系
- route → service 链路：
  - `backend/app/api/routes/rank.py:22` 调用 `get_points_rank`（GET /api/rank/points，见 `docs/迭代记录.md` 的 `2f3f333` 条目）；`:28` 调用 `get_steps_rank`（旧版 /rank/steps，:16 注释）；
  - `backend/app/api/routes/points.py:19` 调用 `get_user_rank`（积分概览附带名次）。
- service → service：`backend/app/services/admin_service.py:269`（复用 `ranked_users_subquery`）、`:393`（复用 `ELITE_SIZE`）、`:588`（人员详情取 rank）；`backend/app/services/profile_service.py:167`（档案汇总取 rank）。
- import 依赖（:8-14）：`sqlalchemy.func/or_`；模型 `DailySport`、`User`；服务 `org_service`、`points_service`。
- 数据库表（只读）：`daily_sport`、`users`、积分台账（经 `points_service.points_subquery`）、组织表（经 `org_service.get_full_name_map`）。
- session 由调用方经 `Depends(get_db)` 传入（`backend/AGENTS.md` §4 不变量 6）。

## 7. 业务规则
- 排序口径（唯一真相，:40）：`points DESC → steps DESC → user_id ASC`；`row_number()` 不产生并列名次。
- 总积分 = 步行积分 + 答题积分，取自 `points_service` 台账（:30；`2f3f333` 移除登录/达标/点亮/里程碑积分后 legacy 流水不计入）。
- 全员参与排名：`User` outerjoin 运动/积分子查询（:42-43），无步数无积分的用户 rank 靠后但仍计入 `total`（:105）。
- 领奖台固定前 10（`ELITE_SIZE`，:17），分页从第 11 名起（:97）；`me` 独立查询，可能与 top/list 中的本人行重复出现（前端按 `is_me` 消费，:79）。
- 组织名批量映射一次取齐（:67），无 org_id 的用户 `org_name` 为空串（:74）。

## 8. 修改约束
- 排序口径变更必须三端同步（小程序/管理端/CSV，docstring :1 与 `docs/迭代记录.md` 的 `2f3f333` 条目均强调同口径）；`admin_service` 直接复用 `ranked_users_subquery`，改动会同时影响管理端。
- 禁止绕过 `points_service` 自行聚合积分（`backend/AGENTS.md` §4 不变量 5）；积分口径变化应改 `points_service.points_subquery` 而非本文件。
- `get_points_rank` / `get_steps_rank` 返回结构是前端 `frontend/services/rank.js` 消费契约（不变量 1），字段增删需前后端同步。
- 保持窗口函数 + 限量取行的实现方式，不得退化为全量加载后内存排序（docstring :6，`f59892e` 优化成果）。
- `TOP_LIMIT`/`ELITE_SIZE` 为模块常量（:16-17），`admin_service.py:393` 引用 `ELITE_SIZE`，改值前检查引用方。

## 9. 当前实现状态
### 已实现
- 窗口函数全员排名子查询，单次 SQL 生成名次（:20-45）。
- 总积分榜三段式（top/分页 list/me）+ has_more 探测 + total（:91-114）。
- 旧版 /rank/steps 兼容契约（:117-133）。
- `get_user_rank` 供积分页/档案/管理端人员详情复用（:85-88）。
- 组织全名批量查询，无 N+1（:67）。

### 存在问题
- 代码内未发现缺陷标记。注意点：`get_points_rank` 中当前用户若已出现在 top 或本页 list，`me` 仍会重复返回一份（:102-109），属契约设计（「me 始终返回」，:92），消费方需按 `is_me`/`user_id` 去重展示；`total` 统计全部 `User` 行（:105），含无运动/积分记录用户。

### 待开发
- 无代码内 TODO；组织维度筛选榜等扩展未见诸本文件，规划待确认。

## 10. 迭代记录
数据来源：`git log --follow backend/app/services/rank_service.py` 与 `docs/迭代记录.md` 对应条目。

### 2026-10-13（`2f3f333`，11:25）
- 需求：积分台账重构——总积分 = 步行 + 答题，排名统一按总积分，三端同口径。
- 修改内容：排名口径切换为 `points_subquery` 总积分（:30,40）；新增 `walk_points`/`quiz_points` 列（:38-39）与 `get_points_rank` 总积分榜（:91-114）；`get_steps_rank` 保留为旧版契约（:117-118）。
- 关联文件：`backend/app/services/points_service.py`、`backend/app/api/routes/rank.py`、`backend/app/api/routes/points.py`、`backend/app/services/admin_service.py`、`docker/init/017_points_ledger.sql`。
- 测试结果：`docs/迭代记录.md` 的 `2f3f333` 条目记录——SQLite 冒烟 20/20 通过（步数边界、增量不重复计分、重复同步幂等、排名顺序、档案/管理端/CSV 一致、legacy 不计入等）。

### 2026-10-11（`f59892e`，11:53）
- 需求：热点查询 SQL 聚合化与去 N+1。
- 修改内容：排行改为 `row_number()` 窗口函数，只取 Top 与本人（:20-45），不再全量加载内存排序。
- 关联文件：`backend/app/services/medal_service.py`、`backend/app/services/streak_service.py`、`docker/init/`（012 索引）等。
- 测试结果：`docs/迭代记录.md` 的 `f59892e` 条目记录——e2e_full_flow 178/178、e2e_datasync 23/23、S2–S7、P0/P1/P2、昵称冒烟全部通过；排行结果与旧实现逐项一致（92 用户 / 20 用户样本）。

### 2026-10-02（`20c79e3`，14:32）
- 需求：组织全名批量查询与驾驶舱计数优化，消除 N+1。
- 修改内容：榜单序列化改用 `org_service.get_full_name_map` 一次批量取组织全名（:67）。
- 关联文件：`backend/app/services/org_service.py`、`backend/app/services/dashboard_service.py`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `20c79e3` 条目未记录验证结果）。

### 2026-09-30（`a94e685`，18:05）
- 需求：仓库初始代码（feat: init），排名逻辑自前端 Mock 迁移入后端。
- 修改内容：创建本文件（初版为步数榜口径，后续提交演进为总积分榜）。
- 关联文件：`backend/app/api/routes/rank.py`、`frontend/services/rank.js`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `a94e685` 条目未记录验证结果）。
