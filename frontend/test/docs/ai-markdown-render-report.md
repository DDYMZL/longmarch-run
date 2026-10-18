# 测试报告：AI 问答回答轻量 markdown 渲染（2026-10-18）

## 背景与问题

AI 历史助手回答按纯文本渲染（`<text>{{content}}</text>`），模型输出的 markdown 标记（如 `**加粗**`）原样展示，用户看到一片 `**` 符号。

## 改动

| 文件 | 改动 |
| --- | --- |
| `frontend/utils/util.js` | 新增 `parseMarkdownLite`：`**加粗**`（仅配对生效，孤立 `**` 保留原文）、`#~####` 标题、`-/*` 无序列表、`数字.` 有序列表；不引第三方库，输出 WXML 直接渲染的块结构（块/段均带 `_bk`/`_sk` 键，遵守不用 index 作 wx:key 约定） |
| `frontend/pages/ai-chat/ai-chat.js` | 助手消息在发送响应与会话加载两处附 `blocks`；用户消息保持纯文本 |
| `frontend/pages/ai-chat/ai-chat.wxml` | 气泡按块渲染（标题/列表项/段落 + 行内加粗分段），各段 `<text>` 保留 `user-select` 长按复制 |
| `frontend/pages/ai-chat/ai-chat.wxss` | 加粗/标题（暗红分四级字号）/列表（悬挂缩进、红色序号符）样式 |
| `frontend/design.md` | ai-chat 行补充 markdown 渲染说明 |

## 验证

1. **Node 单测**（解析正确性）：样例含 配对加粗 / 三级标题 / 有序 / 无序 / 孤立 `**`，输出块结构与预期完全一致（孤立 `**` 原样保留在普通段）。
2. **微信开发者工具 automator**（`frontend/test/automator/mine-avatar-verify.cjs ai` 阶段，真实微信账号登录本地 8010）：向页面注入按解析产物结构构造的合成助手消息（不打真实 AI 接口），断言渲染出 3 个加粗段与标题（A6 PASS），截图 `images/ai-chat-markdown.png`（A7 PASS）——标题、加粗、有序/无序列表均正确呈现，无 `**` 残留。

## 遗留

- 答题解析（quiz-answer/quiz-result 的 `analysis`）同为 AI 生成文本，如线上出现同类问题可复用 `util.parseMarkdownLite`。
