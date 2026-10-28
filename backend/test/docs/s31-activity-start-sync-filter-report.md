# S31 · 步数同步按 PC 端活动开始日过滤 验收报告

- 日期：2026-10-28
- 范围：后端 `app/services/sport_service.py` 的**微信运动步数同步窗口口径**。此前 `/api/sport/sync` 固定同步最近 7 个北京时间自然日、不感知活动时间，活动开始日之前的数据（如活动 10.1 开始时的 9 月步数）也会被写入并计入累计步数与步行积分。本次改为：同步窗口以 PC 端（管理后台）配置的活动开始时间为下限，开始日之前的日期一律不入账。
- 不涉及数据库结构变更（无 SQL 迁移）、不涉及前端改动（响应字段与结构不变，仅 `processedDates` 可能变短）。
- 脚本：`backend/test/s31_activity_start_sync_filter.py`（新增，TestClient + SQLite 临时库，不依赖 8010/openGauss）。
- 结果文件：`backend/test/s31-activity-start-sync-filter-results.json`。

## 1. 变更内容

| 位置 | 改动 |
| --- | --- |
| `sport_service._activity_start_date(db)`（新增私有函数） | 读 `activity_settings`（单行 id=1）的 `start_at`（库内 UTC naive），按北京时间换算为 `YYYY-MM-DD` 自然日；**无配置行时返回 `None` 表示不过滤**，与 `activity_service` 「配置不存在按不限制处理」的既有口径一致 |
| `sport_service.sync_today` | `expected_dates` 由 `recent_dates(7)` 改为「最近 7 日中不早于活动开始日」的子集，一处过滤同时决定三件事：写入的日期、`processedDates`、`failedDates` 的候选集 |
| 模块 docstring / `sync_today` docstring | 补写活动开始日过滤口径，避免后续误读为「无脑同步 7 日」 |

### 1.1 关键行为边界

| 场景 | 行为 |
| --- | --- |
| 未配置活动时间（`activity_settings` 无行） | 不过滤，最近 7 日照旧全部入账（存量行为不变） |
| 开始日落在 7 日窗口中间（如开始于 3 天前） | 只写入开始日及之后的日期；开始日之前的日期**既不写入，也不进入 `failedDates`**（属活动范围外，不是同步失败，管理端失败清单不被污染） |
| 开始日在未来（活动未开始，且关闭参与限制放行准入） | 窗口为空，一个日期都不写，响应 `status=success`、`processedDates/failedDates` 均为空；开启参与限制时由既有 `require_activity_participation` 直接 403，走不到同步逻辑 |
| 历史存量数据 | **只拦新同步，不追溯**：活动开始前已入库的记录与其对应的积分、日历、记录列表、排名统计一律保持原样（本次按用户确认的口径实现） |
| 幂等性 | 过滤后的窗口仍走原「逐日覆盖 + `recompute_walk` 全量核对」链路，同日重复同步不重复加分 |

口径细节：开始日取**北京时间自然日**粒度（配置精确到分钟，如 10.1 08:00 则整个 10.1 计入），与步数本身「按北京时间自然日归日」的既有口径一致；比较用 `YYYY-MM-DD` 字符串（字典序即时间序），不引入额外时区换算。

## 2. 测试结果

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| A01 | 未配置活动时间 → 最近 7 日全部入账、`totalSteps=7000`、`processedDates` 为 7 日、`failedDates` 空 | PASS |
| A02 | 开始日为 3 天前 → 仅写入开始日之后 4 天，`totalSteps=4000` | PASS |
| A03 | 开始日之前的 3 天未入库，且 `failedDates` 为空（不误报失败） | PASS |
| A04 | 同日重复同步 → 仍为 4 天、`synced=false`、步数不变（幂等） | PASS |
| A05 | 开始日为明天（未开始、关闭限制放行）→ 一个日期都不写、不标记失败、`status=success` | PASS |

`S31 步数同步按活动开始日过滤: 5/5 通过`

回归（同链路，未受本次改动影响）：

| 脚本 | 结果 |
| --- | --- |
| `s23_walk_sync_recalc.py`（同步→步行积分全量重算） | 13/13 通过 |
| `s22_history_sync_quiz_rotation.py`（历史同步与题目轮换） | 14/14 通过 |

## 3. 未覆盖与遗留

- **生产 openGauss 侧未冒烟**：本机 Docker Desktop 未运行、5118 库不可用，本次仅在 SQLite 临时库上验证；改动为纯 Python 逻辑过滤，不依赖任何方言特性，但上线后建议用真机点一次同步、核对活动开始前日期不再出现在运动记录与失败清单中。
- **真机微信返回范围**：`wx.getWeRunData` 实际返回约 30 日数据，本次只收紧入库窗口，未改变「微信缺某日数据即报 `failedDates`」的既有行为。
- **答题「第 N 期」基准未联动**：`quiz_service._issue_no` 仍以环境变量 `ACTIVITY_START_DATE`（当前默认 `2026-09-01`）为第 1 期基准，与 PC 端配置的活动时间不是同一来源。若需要期数也跟随后台配置，属另一项变更，需单独确认。
