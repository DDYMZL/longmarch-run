# S7 后端查询性能优化 · 冒烟报告

日期：2026-10-02 ｜ 脚本：`backend/test/s7_perf_refactor.py`（黑盒，需 8010 在线）｜ 结果：**5/5 通过**

## 范围

在接口契约与返回口径完全不变的前提下，消除管理端/小程序排名与驾驶舱聚合路径上的 N+1 查询与重复扫描，为数据量增长（用户数千级、点亮记录数万级）做准备。

## 改动

| 文件 | 改动 |
| --- | --- |
| `app/services/org_service.py` | 新增 `get_full_name_map(db, org_ids)`：一次性查出组织表 `id/name/parent_id` 三列，内存中沿父链拼接全路径名（环路保护 32 层），替代按组织逐层查库的 `_org_name_map`（每个组织每层一次 DB 往返） |
| `app/services/rank_service.py` | 删除私有 `_org_name_map`，组织全名改走 `get_full_name_map` |
| `app/services/admin_service.py`（get_rank_overview） | 点亮记录查询由「全表全列拉出后 Python 过滤」改为 SQL 侧 `.filter(LitNode.node_id.in_(启用节点))` 且只取 `user_id/node_id/lit_at` 三列；`reached_nodes` 直接字典取用；组织名走 `get_full_name_map` |
| `app/services/dashboard_service.py`（route_overview） | 每节点达成人数由「10 节点 × 全用户线性扫描」改为用户总步数排序一次 + `bisect_left` 计数（O(U·log U + 10·log U)），计数口径逐样本核对与旧实现一致 |
| `test/s5_org_user_counts.py` | 修复既有脚本报错：清理冒烟用户时先删 points_log 等子表行再删 user（此前残留积分行导致 ForeignKeyViolation，与本次优化无关） |

## 用例结果

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| P1 | 驾驶舱 route_overview 各节点 lit_count 与 `/admin/rankings` 暴力计数一致（target>0 精确相等；target=0 节点按口径只计有运动记录用户，做范围校验） | ✅ nodes=10 |
| P2 | `/admin/rankings` 134 个用户的 `org_name` 均为组织树可重建的全路径名（批量查询口径回归） | ✅ |
| P3 | rankings 每用户 `nodes` 仅含启用节点且 reached/reached_at 自洽（SQL 过滤回归） | ✅ 134 users |
| P4 | 小程序 `/rank/steps` `orgName` 同为全路径名（同一 `get_full_name_map` 口径） | ✅ board=101 |
| P5 | `/admin/screen` 单接口聚合四段齐全 | ✅ |

## 回归结果

| 套件 | 结果 |
| --- | --- |
| S3 小程序聚合接口 | 15/15 |
| S4 管理端驾驶舱/点位/题库 | 13/13 |
| S5 组织人数统计 | 7/7 |

## 复杂度对照

| 路径 | 优化前 | 优化后 |
| --- | --- | --- |
| 组织全名拼接（rankings + rank/steps） | 每组织每层 1 次 SELECT（≈Σ 深度 次往返） | 1 次 SELECT + 内存走父链 |
| get_rank_overview 点亮记录 | 全表全列拉取 + Python 过滤 | SQL 按启用节点过滤，仅 3 列 |
| route_overview 计数 | O(节点数 × 用户数) | O(U·log U + 节点数·log U) |

## 备注

- 8010 为 `run.py` 热重载进程，改动保存后自动生效；S7 结果即为新代码实测。
- lit_count 口径说明：驾驶舱统计「有 DailySport 记录且总步数 ≥ 目标」的用户数，rankings 列表含 0 步用户，两者对 target=0 节点天然不等，S7 用例按此口径设计，非缺陷。
