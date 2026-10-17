# AI 历史助手聊天页（小程序 §3.1）· 验收报告

- 日期：2026-10-17
- 范围：`pages/ai-chat/ai-chat`（现为 tabBar 第 3 项「AI 问答」，见 `ai-tab-swap-report.md`）、服务层 `services/ai.js`（chat/listConversations/getConversation/deleteConversation，chat 超时 60s）。
- 环境：微信开发者工具 automator（`cli auto --auto-port 9420`），断言脚本 `test/automator/ai-chat-render.cjs`，截图脚本 `test/automator/ai-chat-shots.cjs <empty|conversation|drawer|banner>`（每状态独立连接）。
- 不依赖后端/Agent：登录态与对话数据经 `evaluate`/`setData` 注入代表数据（空状态、含来源/失败/加载态的对话、会话列表），仅验收渲染与交互结构，不伪造任何真实业务结果。

## 断言结果（4/4 PASS）

| 编号 | 用例 | 结果 |
| --- | --- | --- |
| V1 | 进入 ai-chat 页（登录态注入后不被守卫弹回） | PASS |
| V2 | 空状态：常见问题 4 条、消息为空 | PASS |
| V3 | 对话渲染：4 条消息 + 标题 + 知识来源/失败重试/加载三点态 | PASS |
| V4 | 会话抽屉：显示 2 条会话（切换/删除入口在列） | PASS |

## 视觉证据

| 截图 | 内容 |
| --- | --- |
| `../images/ai-chat-empty.png` | 空状态：灯笼 + 4 条常见问题引导 |
| `../images/ai-chat-conversation.png` | 用户/AI 气泡、AI 回答下《来源》块、失败气泡「点击重试」、加载三点 |
| `../images/ai-chat-drawer.png` | 左上「会话」抽屉：会话列表与删除入口 |
| `../images/ai-chat-banner.png` | AI 未开放/额度用尽时顶部常驻提示条 |

## 交互与守卫要点（代码走查 + 断言覆盖）

- 发送：乐观插入用户气泡 + 加载占位，成功替换为带 sources 的助手气泡，失败移除占位并标记用户气泡 `failed`，气泡内「点击重试」重发。
- 403/429 转顶部提示条（banner），其余错误 toast；会话归属由后端 JWT 判定，前端不传 user_id。
- `onShow` 登录守卫；账号切换（`globalData.user.id` 变化）时清空当前会话与抽屉列表（tab 化后跨账号复用同一 tab 页实例的必要重置）。

## 待验证

- 真实 Agent 回答的端到端展示（发送→后端→CloudBase Agent→回显 sources）：本机 DNS 劫持限制，后端侧已真实验证（见 `backend/test/docs/s26-ai-center-report.md`），小程序真机链路待验证。
