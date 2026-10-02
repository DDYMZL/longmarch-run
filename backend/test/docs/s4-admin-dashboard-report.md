# S4 管理端接口 验收报告

日期：2026-10-02 ｜ 阶段：S4（管理端接口与 WS 动态）｜ 结果：**13/13 通过**（回归 S3 15/15、S2 8/8）

## 范围

| 接口 | 说明 |
| --- | --- |
| `GET /api/admin/dashboard` | 驾驶舱聚合：metrics（参与人数/今日参与/累计步数/人均步数/节点完成率/答题人数/勋章发放数）+ route_overview（每启用节点达成人数与完成率） |
| `GET /api/admin/dashboard/trend?days=7\|30` | 近 N 日趋势：每日总步数/参与人数/新增用户/新增点亮（本地日期分桶） |
| `GET /api/admin/activities?limit=50` | 实时动态：user_event 关联昵称倒序，文案与小程序足迹同源（build_text） |
| `GET /api/admin/screen` | 数据大屏单接口聚合：metrics + route_overview + 7 日 trend + 最近 20 条动态 |
| 扩展 `GET/POST/PUT /api/admin/route-nodes` | 增改 brief/significance/figures/location/images/audio/keywords 七个内容字段 |
| 扩展 `GET/POST/PUT /api/admin/questions` | 增改 category（event/route/figure 或留空，非法值 400） |

**范围决策**：组织维度（org_stats、大屏组织榜）按用户 2026-10-02 确认完全跳过（延续 2026-10-01 取消决定），dashboard/screen 均不含组织维度。

WS 动态：`/ws/updates` 接受 admin 令牌（既有）；S2 已落地的 `activity` 消息（type/eventType/userId/nickname/text/at）供驾驶舱/大屏直接插入动态列表，`data_changed` 触发整页重拉，本阶段无需改动。

## 口径说明

- 节点达成人数与完成率：以「用户累计步数 ≥ 节点目标」判定，与小程序 march 服务口径一致（步数达标即视为点亮），避免漏掉未点「点亮」按钮的用户；
- 节点完成率 = 达成最终节点人数 / 总用户数；
- trend 的 created_at / lit_at 为 UTC 存储：范围按 UTC 过滤、归桶按本地日期（helpers.to_local / local_to_utc）。

## 过程中发现并修复的预存 bug

`POST /api/admin/questions` 一直无法成功：questions.id 在 001_schema.sql 中为 `INTEGER PRIMARY KEY`（无 SERIAL，种子占用固定 id 1-15），create_question 未显式分配 id 导致 NotNullViolation。已按 create_route_node 的 max+1 模式修复。

## 冒烟脚本

`backend/test/s4_admin_dashboard.py`（黑盒，admin 登录后逐项断言）：

```
D1/D2 dashboard 指标与路线总览 ✓   T1/T2 trend 7/30 日 ✓
A1 动态含昵称文案 ✓                S1 screen 四段聚合 ✓
N1~N3 route-nodes 内容字段读写回环（不留残留）✓
Q1~Q4 questions category 读写/删除/非法 400 ✓
```

## 契约确认

- admin 接口全部 snake_case；活动文案与小程序足迹共用 event_service.build_text；
- route-nodes Out 对 Oracle 兼容模式下读回的 NULL 字符串统一归一为空串（field_validator）。
