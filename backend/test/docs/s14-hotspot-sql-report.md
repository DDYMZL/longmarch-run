# S14 后端热点查询 SQL 化与去 N+1 · 回归报告

日期：2026-10-11 ｜ 环境：openGauss（docker，5118）+ uvicorn 8010（`WX_LOGIN_ALLOW_MOCK=true` 仅本地测试）｜ 结果：**16 套件全部通过**

## 范围

接口契约不变。把高频接口里「整表拉进 Python 再求和/排序」的写法改成库内聚合，去掉逐行查询（N+1），保证用户与运动记录量很大时响应时间稳定。

## 改动

| 文件 | 改动 |
| --- | --- |
| `rank_service.py` | 小程序总榜改用窗口函数 `row_number()` 在库内排名，只取前 100 名和本人；原先每次请求加载全部用户。`ranked_users_subquery` 供管理端排名复用 |
| `sport_service.py` | `get_total_steps` 用 SQL `sum` 统计累计步数（原先拉全部行在 Python 求和）；写入后累计步数由「写前总数 + 本次增量」推出，省掉 2 次重复统计 |
| `march_service.py` | 删除重复的 `_total_steps`，复用 `sport_service.get_total_steps` |
| `medal_service.py` | 勋章判定只查一次 `daily_sport`，在内存中算出全部运动类指标（原先 6 次查询）；积分总额复用 `points_service.get_total`，删除重复的 `_total_points` |
| `streak_service.py` | 抽出纯函数 `streaks_of` / `longest_run`。**逻辑修复**：原「历史最长连续」只按记录顺序计数，中间缺了几天（没有记录）也算连续，导致最长连续天数、「坚持」「无畏」勋章被高估；现按自然日判断是否相邻。启动兜底 `recompute_all` 改为流式分组计算，只批量回写有变化的用户（原先每个用户 1 次查询 + 1 次更新） |
| `broadcast_service.py` | 今日播报的人数、总步数、击败人数合成一条 SQL 聚合（原先拉今日全部运动行） |
| `profile_service.py` | 档案页的运动、答题统计改为 SQL 聚合（count/sum/max） |
| `quiz_service.py` | 抽题只查题目 id；判分只查今日抽中的题（原先两处都全表加载题库） |
| `event_service.py` / `dashboard_service.py` | 「最近事件 + 昵称」统一为一次外连接查询 `recent_events`，删除两处重复的昵称映射；`record` 只查昵称一列 |
| `admin_service.py` | 删题时只清理今天及以后的抽题缓存（原先扫全表）；删组织时祖先保留逻辑改为整表父链一次加载（原先每个节点每一层查一次）；子树层级平移改为一条批量 UPDATE；删除与 `org_service` 重复的子树遍历（原实现 `pop(0)` 为 O(n²)）；删除 `_calc_level` 未使用的参数 |
| `org_service.py` | 下级数量统计改为 `group by count`；`subtree_org_ids` 改为公开函数供管理端复用 |
| `docker/init/012_perf_indexes.sql` + `models.py` | 新增索引 `lit_nodes(lit_at)`、`users(created_at)`、`user_event(user_id, event_type)`，覆盖今日点亮、趋势统计与成就去重查询 |

## 正确性核对

- 小程序总榜：与「全量加载 + Python 排序」的参考实现逐行比对（92 名用户，名次、步数、user_id 完全一致，本人名次一致）。
- 今日播报：今日人数 20、总步数 359388、击败百分比均与参考实现一致。
- 启动 `recompute_all` 正常完成。

## 回归结果

| 套件 | 结果 |
| --- | --- |
| e2e_full_flow | 178/178 |
| e2e_datasync | 23/23 |
| s2_streak_events | 8/8 |
| s3_aggregates | 15/15 |
| s4_admin_dashboard | 13/13 |
| s5_org_user_counts | 7/7 |
| s6_org_user_detail | 8/8 |
| s7_perf_refactor | 5/5 |
| p0_route_progress / p0_chapters | 10/10、10/10 |
| p1_activities / portrait / companions / org_march / footprints | 7/7、3/3、7/7、6/6、4/4 |
| p2_ceremony | 4/4 |
| nickname_change_smoke | 12/12 |

说明：本地 `.env` 配置了真实微信凭证，冒烟脚本使用模拟 code 登录，需要以 `WX_LOGIN_ALLOW_MOCK=true` 启动后端（in-process 的 s5 也需设置该环境变量）。
