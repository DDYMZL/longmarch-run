# P0-1 行军轨迹进度字段 测试报告（后端）

日期：2026-10-02 · 范围：`GET /api/march/route` 新增 `currentNodeId / currentProgress / routeProgress`

## 用例与结果（test/p0_route_progress.py，黑盒 HTTP @8010）

| 用例 | 场景 | 期望 | 结果 |
| --- | --- | --- | --- |
| P0R-01 | 0 步新用户 | currentNodeId=2（遵义） | PASS |
| P0R-02 | 0 步 | currentProgress=0、routeProgress=0 | PASS |
| P0R-03 | 累计 2500 步 | 段内进度 0.5（遵义段） | PASS |
| P0R-04 | 累计 2500 步 | routeProgress=2500/65000 | PASS |
| P0R-05 | 累计 2500 步 | currentNodeId=2 | PASS |
| P0R-06 | 累计 7500 步 | currentNodeId=3（四渡赤水） | PASS |
| P0R-07 | 累计 7500 步 | 段内进度 (7500-5000)/5000=0.5 | PASS |
| P0R-08 | 补满 65000 步并点亮 | finished=true | PASS |
| P0R-09 | 全程完成 | currentNodeId=null | PASS |
| P0R-10 | 全程完成 | routeProgress=1 | PASS |

**10/10 通过。**

## 备注

- 计算逻辑位于 `march_service.get_route`：route_progress=累计/终点目标；current_node_id=第一个未点亮节点；current_progress=（累计-上一节点目标）/本段跨度（跨度 0 时取 1）。
- 排查插曲：8010 端口被两个 `spawn_main(parent_pid=<已死PID>)` 的孤儿 uvicorn worker 劫持，表现为新代码重启后接口仍返回旧 schema 且新服务器日志零请求；清掉孤儿后恢复。识别方法已补入项目记忆。
