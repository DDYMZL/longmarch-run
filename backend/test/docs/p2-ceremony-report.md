# P2-2 长征完成仪式（后端侧）测试报告

日期：2026-10-04 · 范围：完成仪式触发标记（需求 §20.4）

## 改动摘要

- `docker/init/008_route_ceremony.sql`（已应用到运行库并登记 schema_migrations）：
  `users` 新增 `route_ceremony_at TIMESTAMP NULL`——非空表示已观看首次完成仪式。
- `app/models/models.py`：`User` 同步新增 `route_ceremony_at`（未用 create_all）。
- `app/services/march_service.py`：
  - `get_route` 返回新增 `ceremony_pending`：仅当路线已完成时查一次 users 表
    （`route_ceremony_at IS NULL` → true），未完成用户零额外查询；
  - 新增 `mark_ceremony_seen`：幂等写入 `route_ceremony_at`（已标记/用户不存在直接返回）。
- `app/schemas/schemas.py`：`RouteOut` 新增 `ceremony_pending`（小程序 camelCase `ceremonyPending`）。
- `app/api/routes/march.py`：新增 `POST /api/march/ceremony` 标记仪式已观看。

## 设计取舍

- **状态存后端而非小程序本地存储**（§28 后端为唯一事实源）：换设备/重装后「仅第一次完成触发完整动画」口径一致。
- **增量字段而非新表/新状态机**：仪式标记只是一次性时间戳，挂在 users 上最简；`GET /march/route`
  附带 `ceremonyPending` 让前端在完成态直接进入触发流程，不新增往返。
- **幂等标记**：重复 POST 不清空/不报错，前端「跳过动画」与「完整看完」殊途同归。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P2C-01 | 新用户未完成路线：`GET /march/route` 返回 `ceremonyPending=false` | 通过 |
| P2C-02 | 补 70000 步 + 点亮 → `finished=true`、`ceremonyPending=true`、10/10 节点点亮 | 通过 |
| P2C-03 | `POST /march/ceremony` 后 `ceremonyPending=false`；重复调用幂等仍为 false | 通过 |
| P2C-04 | 无 token 调用 `POST /march/ceremony` 返回 401 | 通过 |

执行：`python test/p2_ceremony.py` —— **4/4 通过**。

回归：`p0_route_progress` 10/10、`p0_chapters` 10/10、`s3_aggregates` 15/15、`p1_persons` 4/4、`p2_quotes` 4/4。

## 备注

- 迁移应用插曲：`ALTER TABLE users` 曾被一条「idle in transaction」的孤儿连接持锁阻塞，
  通过 `pg_stat_activity` 定位后 `pg_terminate_backend` 放行；openGauss 无 `wait_event_type` 列。
- 管理端无需改动（§20 无后台配置面；仪式标记不需要运营干预）。
