# P1-1 实时行军动态（小程序侧）测试报告

日期：2026-10-03 · 范围：首页「⚡实时行军」卡片（REST 快照 + WS 实时置顶）、WS 客户端、动态视图模型

## 改动摘要

- `services/ws.js`（新增）：WebSocket 客户端单例——`/api/ws/updates?token=`，未登录不连接；断线指数退避重连（1s 起、封顶 15s）；`subscribe(fn)` 订阅/退订。
- `services/broadcast.js`：新增 `getActivities(limit)`（REST 快照）与 `toActivityView(item)`（REST 条目与 WS 消息共用的视图模型：事件图标映射 + 昵称兜底「战友」+ 相对时间）。
- `utils/util.js`：新增 `formatRelative`（刚刚 / N分钟前 / N小时前 / 昨天 / M-D；内部 `parseUtc` 处理后端 UTC naive ISO）。
- `pages/home/home.{js,wxml,wxss}`：⚡实时行军卡（LIVE 呼吸灯、动态列表、空态）；`onShow` 订阅 WS、`onHide/onUnload` 退订；`refreshAll` 第 6 路拉取动态快照（失败不阻塞主数据）；WS `activity` 消息置顶插入（最多 6 条，单条小 setData）。

## 设计要点

- **REST 为权威快照**：WS 推送的事件均已落 `user_event`，刷新时快照自含，直接整体替换；WS 只负责停留期间的实时增量。
- **隐私**：只渲染昵称/文案/类型/时间，WS 消息中的 `userId` 不进入视图模型。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P1F-01 | REST 快照：API 触发本人事件后重进首页，动态流含本人昵称与「首次完成运动同步」文案 | 通过 |
| P1F-02 | WS 实时：停留首页不刷新，API 再触发事件后「完成当日行军目标」自动置顶 | 通过 |
| P1F-03 | 视图模型：图标/昵称齐备，相对时间为「刚刚」 | 通过 |

执行：`node test/automator/p1-activities.cjs`（results-p1f.json）—— **3/3 通过**；视觉证据 `test/images/23-home-activities.png`（滚动至卡片位置拍摄）人工核对通过。

## 踩坑记录（复用价值）

- **登录页不采集昵称**：现流程后端默认昵称「长征小战士」，首次引导在**组织选择页**设置（`org.setData({nickname})` + `confirmSelect`）；automator 脚本若只在 login 页 setData 昵称将静默无效，动态流昵称断言随之失败。
- **断言找条目要同时匹配昵称+文案**：同一用户一次动作常连发多事件（FIRST_STEP + BADGE_UNLOCK），`find(nickname)` 取到的可能是最新的勋章事件而非目标事件。

## 备注

- JS 语法：`node --check` 全部通过。
- WS 连接为 app 级单例，登出后无订阅者空转；重连时实时读取最新 token，未登录不再发起连接。
