# P1-1 实时行军动态（后端侧）测试报告

日期：2026-10-03 · 范围：`GET /api/broadcast/activities` 公开动态流接口、隐私边界、WS activity 推送、昵称脱敏

## 改动摘要

- `app/services/event_service.py`
  - 新增 `list_public_activities(db, limit)`：`user_event` 按 `event_time desc, id desc` 取前 N 条，昵称按 user_id 集合批量查询（无 N+1）；
  - 新增 `mask_nickname`（2 字「张*」、3 字及以上「王*明」、单字/空兜底）；
  - `record()` 广播 `activity` 时若开启脱敏则先 mask 昵称。
- `app/api/routes/broadcast.py`：新增 `GET /broadcast/activities?limit=`（1~50 钳制），需用户 JWT。
- `app/schemas/schemas.py`：新增 `ActivityItemOut` / `ActivitiesOut`。
- `app/core/config.py`：新增 `ACTIVITY_MASK_NICKNAME: bool = False`（需求 §8.5）。

## 隐私边界（需求 §8.5）

公开动态流只下发 `id / eventType / eventTime / nickname / text`，不含 `user_id`、`openid` 与事件参数（`data`）；WS `activity` 消息沿用原结构（`userId` 供管理端驾驶舱使用，小程序视图模型不读取）。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P1A-01 | 响应形状与隐私：字段 ⊆ {id,eventType,eventTime,nickname,text} | 通过 |
| P1A-02 | 本人 FIRST_STEP 事件入流（昵称/文案正确） | 通过 |
| P1A-03 | NODE_UNLOCK 文案含节点名（瑞金） | 通过 |
| P1A-04 | limit=2 截断生效 | 通过 |
| P1A-05 | 未带 token 401 | 通过 |
| P1A-06 | WS 连接后触发事件，收到 activity 推送（asyncio + websockets） | 通过 |
| P1A-07 | mask_nickname 规则（空/单字/双字/多字） | 通过 |

执行：`python test/p1_activities.py`（脚本头部已处理 `sys.path` 以便 `import app.*`）—— **7/7 通过**。

## 备注

- 默认不脱敏（`ACTIVITY_MASK_NICKNAME=False`），管理端现有动态展示零影响；开启后 REST 与 WS 两路同时脱敏。
- 动态流读 `user_event` 单表 + 一次昵称批量查询，限量 ≤50，无大数据量隐患。
