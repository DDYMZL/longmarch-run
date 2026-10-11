# S15 排名洞察服务端分页 / 筛选 / 流式导出 测试报告

- 日期：2026-10-11
- 范围：backend `/api/admin/rankings`、`/api/admin/rankings/export`；admin `pages/RankingsView.vue`
- 环境：openGauss（docker 5118），后端 8010（`WX_LOGIN_ALLOW_MOCK=true`），admin dev 5173，Chrome（browser-use）

## 1. 改动摘要

| 位置 | 原实现 | 现实现 |
| --- | --- | --- |
| 后端 `/admin/rankings` | 每次请求加载全部用户、步数与启用节点点亮记录，在 Python 中排序后一次返回全员 | 名次由窗口函数 `rank_service.ranked_users_subquery` 计算。筛选（关键字 / 组织 / 已改名）在 SQL 中执行；只对当前页用户查询点亮记录。指标改为 SQL 聚合：完成全程人数与平均进度按「点亮节点数」分布聚合，结果行数不超过节点数 + 1 |
| 后端导出 | 无（前端用全量数据拼 CSV） | `/admin/rankings/export` 返回 `StreamingResponse`：独立会话，`yield_per(1000)` 流式游标，按批查点亮记录，服务端防公式注入，UTF-8 BOM |
| admin 页面 | 拉取全量数据后在前端筛选、分页、导出 | 服务端分页；关键字 300ms 防抖；改筛选时复位到第 1 页，只发一次请求；请求序号丢弃乱序响应；页码越界自动回到最后一页；导出改为下载后端生成的 blob |
| 公共工具 | 下载逻辑和 csvCell 写在各页面中 | 新增 `admin/src/utils/download.ts`（saveFile / csvCell / 本地日期 today） |

## 2. 口径一致性（新旧实现对照）

脚本把 git HEAD 的旧版 `get_rank_overview` 与新实现对同一个库运行，逐项比较：

| 检查项 | 结果 |
| --- | --- |
| 按 page_size=37 翻页拼出的全量 items 与旧实现逐字段相等（92 人） | ✅ |
| total / total_steps / completed_users / route_nodes / 组织选项集合 | ✅ 全部相等 |
| avg_progress 与旧前端算法（逐人 Math.round 后取平均） | ✅ 16 = 16 |
| 领奖台与旧实现前三名一致 | ✅ |
| 筛选 `e2e`、`1`、只看改名、组织精确匹配、`%`（LIKE 通配符转义）与旧前端过滤逻辑一致 | ✅ 全部一致 |
| CSV 行数、BOM、表头；`=1+1 / +x / -5 / @a` 前置单引号 | ✅ |

## 3. 冒烟回归

| 套件 | 结果 |
| --- | --- |
| `test/s7_perf_refactor.py`（新增 P6 筛选翻页、P7 全员指标、P8 流式导出） | 8/8 ✅ |
| `test/nickname_change_smoke.py`（N07 改为按 only_changed + 人员 ID 筛选查询） | 12/12 ✅ |
| `test/e2e_datasync.py`（B01 校验分页条数） | 23/23 ✅ |
| `test/e2e_full_flow.py` | 178/178 ✅ |
| 参数校验：`page_size=500`、`page=0` | 422 ✅ |

## 4. 浏览器验收（admin `npm run build` 通过）

| 场景 | 结果 |
| --- | --- |
| 首屏：指标（107 人 / 1,114,588 步 / 15% / 12 人完成全程）、领奖台、当前页 50 行、「共 107 条」、实时通道在线 | ✅ |
| 关键字连续输入 `1` → `11`：防抖后只发 1 次请求，命中 1 条，领奖台不变 | ✅ |
| 翻到第 2 页：名次从 51 开始 | ✅ |
| 在第 2 页勾选「只看已改名」：复位到第 1 页，只发 1 次请求，19 条全部带改名标签 | ✅ |
| 导出：请求 `/admin/rankings/export?only_changed=true`，文件名 `全员长征排名_2026-10-11.csv`，19 行数据 + 表头，提示「已导出 19 人」 | ✅ |
| 组织下拉（可搜索，8 个有成员的组织）：选择「长征集团总部」后命中 15 条且组织列一致；清空后恢复 107 条 | ✅ |

截图：`../images/rankings-11-server-paging.png`

## 5. 性能说明

- 单次请求的数据库开销：一次窗口排序（所有用户），加上若干聚合查询。Python 侧只处理当前页（≤200 人）和点亮节点数分布（≤ 节点数 + 1 行），内存与总人数无关。
- 导出采用流式游标加分批（每批 1000 人）查询点亮记录。响应边生成边发送，内存占用与总人数无关。
- 依赖索引：`lit_nodes(user_id, node_id)` 唯一索引、`daily_sport(user_id, date)` 唯一索引、`users.org_id`。
