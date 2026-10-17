# medal_service.py

## 1. 文件路径
`backend/app/services/medal_service.py`（共 152 行）

## 2. 文件职责
勋章服务：根据用户的运动、答题、积分、点亮、连续行军等行为数据自动判定并发放勋章；提供勋章墙列表（含未获得状态）与已获得数量统计。业务逻辑自前端 `frontend/services/medal.js` Mock 迁移而来（模块 docstring，`backend/app/services/medal_service.py:1-11`）。

## 3. 业务需求
- 勋章由后端在业务数据变化后自动发放，前端不本地造数（`backend/AGENTS.md` §4 不变量 5「副作用链」：凡影响步数/点亮/答题/积分的操作必须触发 `medal_service.check_and_grant`）。
- 勋章墙（功能 9）需展示 category / hidden / sort_order / granted_at / condition_desc 扩展字段，隐藏勋章未获得时不公开获取条件（`backend/app/services/medal_service.py:117-121,144`）。
- 新获勋章写入 `BADGE_UNLOCK` 事件，供「我的足迹」与管理端动态同源展示（`backend/app/services/medal_service.py:10`）。
- 勋章判定阈值属前后端必须同步修改的业务规则（`backend/AGENTS.md` §4 不变量 4）。

## 4. 核心功能
### 4.1 `_owned_ids(db, user_id)`（:28-30）
查询 `user_medals` 表得到用户已拥有的勋章 id 集合。

### 4.2 `check_and_grant(db, user_id) -> List[str]`（:33-113）
检查并发放勋章，返回本次新获得的勋章 id 列表。流程：
1. 取已拥有集合（:35）；
2. 单次查询 `daily_sport` 全部行，在内存派生指标：是否有运动记录、总步数、达标日集合、单日 ≥10000 步的日期集合（:37-46，f59892e 的「勋章检查合并为单次查询」优化）；
3. 查答题次数（`quiz_records` count，:47）、总积分（`points_service.get_total`，:48）；
4. 查已点亮节点集合 `lit_nodes`，并按「总步数 ≥ 节点 target_steps 即视为点亮」的 march 服务口径补充启用节点（:50-61）；
5. 逐项判定候选勋章（:63-90，规则见 §7）；
6. 对未拥有的候选逐个 `db.add(UserMedal(...))`（:92-97），有新勋章时 `db.commit()`（:99），再批量查 `MedalDef` 并逐条调用 `event_service.record(db, user_id, "BADGE_UNLOCK", {...})` 写事件（:100-112）。

### 4.3 `get_medal_list(db, user_id) -> List[Dict]`（:116-147）
勋章墙列表：按 `app/data/seed.py` 中 `MEDALS` 的定义顺序（:126）遍历，从 `medal_defs` 表取展示数据，合并 `user_medals.granted_at`（:122-123），返回 id/name/icon/desc/owned/category/hidden/sort_order/granted_at/condition_desc；隐藏且未获得时 condition_desc 固定为「获得条件暂未公布」（:144）。seed 中存在但 `medal_defs` 表缺失的条目直接跳过（:128-129）。

### 4.4 `get_owned_count(db, user_id) -> int`（:150-152）
`user_medals` 表按用户 count，已获得勋章数量。

## 5. 输入与输出
| 函数 | 输入 | 输出 |
| --- | --- | --- |
| `check_and_grant` | `db: Session`、`user_id: int` | `List[str]`，本次新获得勋章 id（无新勋章返回空列表） |
| `get_medal_list` | 同上 | `List[Dict]`，字段见 §4.3；`granted_at` 为 datetime 或 None |
| `get_owned_count` | 同上 | `int` |

本文件不抛业务异常（无 `raise`/`ValueError`）；输出为服务层 dict，由路由的 `MedalListOut` / `MedalGrantResult`（`backend/app/api/routes/medal.py:9`）转 camelCase 响应。

## 6. 依赖关系
- route → service → model 链路：
  - `backend/app/api/routes/medal.py:19,21,22,29`（GET /api/medal/list、POST /api/medal/check）；
  - 副作用链调用方：`backend/app/api/routes/sport.py:48,80`（步数同步/补录）、`backend/app/api/routes/march.py:71`（点亮）、`backend/app/api/routes/quiz.py:35,51`（答题）。
- import 依赖（:12-25）：`app.data.seed` 的 `MEDALS`、`MEDAL_NODE_MAP`；模型 `DailySport`、`LitNode`、`MedalDef`、`QuizRecord`、`RouteNode`、`UserMedal`；服务 `event_service`、`points_service`、`streak_service`。
- 数据库表：`user_medals`（读写）、`daily_sport`、`quiz_records`、`lit_nodes`、`route_nodes`、`medal_defs`（只读）、`points_log`（经 `points_service.get_total` 间接）、事件表（经 `event_service.record` 间接）。
- 不依赖 `app.core.database`，session 一律由调用方经 `Depends(get_db)` 传入（`backend/AGENTS.md` §4 不变量 6）。

## 7. 业务规则
勋章判定条件（`check_and_grant` :63-90，与模块 docstring :4-9 一致）：

| 勋章 id | 条件 | 代码行 |
| --- | --- | --- |
| first-step | 存在任一 `daily_sport` 记录 | :64-65 |
| learner | 答题记录数 ≥ 10 | :66-67 |
| master | `points_service.get_total` 总积分 ≥ 500 | :68-69 |
| luding / snow | 点亮 `MEDAL_NODE_MAP` 对应节点（id 6 / 7，`backend/app/data/seed.py:314`） | :70-73 |
| victory | 启用节点非空且全部点亮（含按总步数推定点亮） | :74-75 |
| persistence / streak-30 | 达标日最长连续 ≥ 7 / ≥ 30 天（`streak_service.streaks_of`） | :78-82 |
| day-10k | 存在单日 ≥ 10000 步 | :83-84 |
| steps-100k / steps-500k | 累计步数 ≥ 10 万 / 50 万 | :85-88 |
| fearless（隐藏） | 单日 ≥10000 步的日期最长连续 ≥ 7 天（`streak_service.longest_run`） | :89-90 |

其他规则：
- 幂等：只发放 `owned` 中不存在的勋章（:93-97），重复调用不产生重复行。
- 事务边界：本服务在 `check_and_grant` 内部自行 `db.commit()`（:99）；`BADGE_UNLOCK` 事件在 commit 之后经 `event_service.record` 写入（:103-112），其内部事务处理由 `event_service` 负责（见 `.qoder/backend/app/services/event_service.py.md`）。
- 点亮口径：节点是否点亮同时看 `lit_nodes` 表与「总步数 ≥ target_steps」（:58-61），与 march 服务一致；仅统计 `is_enabled` 为真的节点（:55）。

## 8. 修改约束
- 判定阈值变更必须前后端同步（`backend/AGENTS.md` §4 不变量 4，对照 `frontend/services/medal.js`）。
- 禁止绕过 `points_service` 直接查/写积分（不变量 5）；master 条件取的是总积分口径，不得改回直接聚合 `PointsLog`。
- 新增影响步数/点亮/答题/积分的接口时，路由层必须补 `check_and_grant` 调用（不变量 5）。
- 服务内禁止自建 session（不变量 6）；注意 `check_and_grant` 会 commit 调用方传入的 session，若在外层事务中调用需评估提交时机。
- `get_medal_list` 返回结构被 `MedalListOut` 与前端勋章墙消费，字段为 camelCase 契约的一部分（不变量 1），不得单边改名。
- 新增勋章：需同步 `backend/app/data/seed.py`（MEDALS 定义）、`docker/init/` 建表/种子 SQL 与本文件判定分支。

## 9. 当前实现状态
### 已实现
- 11 类勋章自动判定与幂等发放（:63-99）。
- `BADGE_UNLOCK` 事件写入，含 medalId/medalName/hidden（:100-112）。
- 勋章墙扩展字段与隐藏条件遮蔽（:116-147）；已获得数量统计（:150-152）。
- 运动类条件单次查询内存派生，避免逐勋章重复查库（:37-46）。

### 存在问题
- master 勋章口径与展示文案不一致：代码按「总积分（步行+答题）≥ 500」判定（:48,68-69），而种子文案为「累计答题积分达到 500」（`backend/app/data/seed.py:304`）。`.qoder/REQUIREMENTS.md` §8.3 记录修正方向为待定，当前代码未改。
- GET /api/medal/list 有写副作用但不广播：`backend/app/api/routes/medal.py:18-19` 在活动可参与时于查询接口内执行 `check_and_grant`（可能 commit），而 POST /api/medal/check 发放后广播 `medal.check`（`backend/app/api/routes/medal.py:29-31`），/list 路径发放的新勋章不会触发 WS 广播，管理端档案实时刷新依赖 /check 或后续广播，两条路径行为不对称。
- `check_and_grant` 内部 commit（:99）使调用方无法把勋章发放与自身业务写入合并为单一事务（如答题提交链路 `backend/app/api/routes/quiz.py:35,51`）。

### 待开发
- master 阈值口径修正（改文案或改判定）——待产品确认（`.qoder/REQUIREMENTS.md` §8.3 标记待定）。
- 其余无代码内 TODO；未确认的规划不在此列出。

## 10. 迭代记录
数据来源：`git log --follow backend/app/services/medal_service.py` 与 `docs/迭代记录.md` 对应条目。

### 2026-10-11（`f59892e`，11:53）
- 需求：热点查询 SQL 聚合化与去 N+1，保障大数据量性能。
- 修改内容：勋章检查合并为单次 `daily_sport` 查询、内存派生各指标（:37-46）；同批还包含排行窗口函数、播报/档案聚合、连续行军按自然日修复、012 索引。
- 关联文件：`backend/app/services/rank_service.py`、`backend/app/services/broadcast_service.py`、`backend/app/services/profile_service.py`、`backend/app/services/streak_service.py`、`docker/init/`（012 索引）等。
- 测试结果：`docs/迭代记录.md` 的 `f59892e` 条目记录——openGauss 已应用 012；e2e_full_flow 178/178、e2e_datasync 23/23、S2–S7、P0/P1/P2、昵称冒烟全部通过。

### 2026-10-02（`18c2121`，00:12）
- 需求：新增小程序聚合接口（档案/足迹/日历/播报/知识画像）并扩展现有契约。
- 修改内容：本文件随聚合接口契约调整（具体改动范围以该提交 diff 为准）。
- 关联文件：`backend/app/api/routes/`（聚合接口路由）、`backend/app/services/profile_service.py` 等。
- 测试结果：待确认（`docs/迭代记录.md` 的 `18c2121` 条目未记录验证结果）。

### 2026-10-01（`be7e126`，23:39）
- 需求：统一事件系统与连续行军机制，勋章体系扩展判定并接入事件链。
- 修改内容：新增 persistence/streak-30/day-10k/steps-100k/steps-500k/fearless 等判定与 `BADGE_UNLOCK` 事件写入（:77-112），引入 `event_service`、`streak_service` 依赖（:25）。
- 关联文件：`backend/app/services/event_service.py`、`backend/app/services/streak_service.py`、`backend/app/data/seed.py`（12 勋章）、`docker/init/`（005 迁移）。
- 测试结果：待确认（`docs/迭代记录.md` 的 `be7e126` 条目未记录验证结果）。

### 2026-10-01（`e8c6a09`，10:28）
- 需求：路线节点增加坐标、排序与启停配置。
- 修改内容：节点判定改为仅统计 `is_enabled` 节点（:55），victory 条件适配启停配置（:74）。
- 关联文件：`backend/app/models/models.py`（RouteNode）、`backend/app/data/seed.py`、`backend/app/services/march_service.py`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `e8c6a09` 条目未记录内容与验证结果）。

### 2026-09-30（`a94e685`，18:05）
- 需求：仓库初始代码（feat: init），勋章逻辑自前端 Mock 迁移入后端。
- 修改内容：创建本文件，实现基础勋章判定、列表与计数。
- 关联文件：`backend/app/api/routes/medal.py`、`backend/app/data/seed.py`、`frontend/services/medal.js`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `a94e685` 条目未记录验证结果）。
