# S28 · AI 历史助手逐字回答（SSE 流式）小程序端验收报告

- 日期：2026-10-19
- 范围：`pages/ai-chat` 逐字渲染交互 + `services/request.js` SSE 传输层 + `services/ai.js` `chatStream` 流式客户端。目标交互对齐主流 AI 产品：正文一个字一个字拼接、生成中有光标与「停止」、可中途停止保留半截、失败可重试；**不是**一次性返回后前端假打字机。
- 脚本：
  - `frontend/test/ai-stream-check.cjs` —— 离线传输层单测（stub `wx`，不联网），覆盖分帧/UTF-8/降级/abort。
  - `frontend/test/automator/ai-chat-stream.cjs` —— 微信开发者工具端到端（模拟器 → 本机 8010 后端 → 真实大模型，全链路不 stub）。
  - `frontend/test/automator/ai-chat-stream-shots.cjs` —— 真实流式过程截图（与断言分离，避免截图退化自动化桥）。
- 结果文件：`frontend/test/ai-stream-check-results.json`（17/17）、`frontend/test/ai-stream-ui-results.json`（9/9）。
- 截图：`frontend/test/images/ai-stream-typing.png`（生成中：半截正文 + 末尾光标 + 「停止」按钮）、`frontend/test/images/ai-stream-stopped.png`（点停止后：半截回答保留、按钮回「发送」）。

## 1. 实现要点

### 1.1 传输层 `request.js`（不含业务语义）

`requestStream(opts, onEvent, onEnd)`：`wx.request({enableChunked:true})` + `onChunkReceived` 收 `ArrayBuffer`；手写**增量 UTF-8 解码**（小程序运行时没有 `TextDecoder`，多字节汉字/emoji 会被切在块边界，解码器保留尾部不完整字节待下一片，含代理对处理）；`\n\n` 分帧、容忍 `\r\n`、只解析 `data:` 行、忽略 `[DONE]`、坏块跳过不吞业务回调异常。非 2xx 把响应体按 FastAPI JSON 错误解析成与 `request()` 同构的 Error（保留 `statusCode`）。`abort()` 后不再触发任何回调。`supportsChunked()` 用 `canIUse('request.object.enableChunked')` 判定。

### 1.2 业务层 `ai.js` `chatStream`

把 SSE 事件映射为 `onStart / onDelta / onDone / onError` 四类回调，页面只面对这一条渲染路径。**降级规则**（保证重试绝不重复已显示正文）：仅当 401 / 运行时不支持分块 / 且**一个增量都没收到**就传输失败时，才退化为一次性 `chat()` 并把整段回答当单个 delta 推出；已推出增量后失败只报错不重发（后端此时已把半截落库，重发会重复）。

### 1.3 页面 `ai-chat` 打字机与停止

增量入 `_pending` 队列，`setInterval` 45ms/拍自适应吐字（`ceil(len/20)` 封顶 12 字/拍），路径级 `setData('messages[i].content')` 而非整数组重发；滚动按 300ms 节流跟随。生成中正文末尾红色闪烁光标（`.ai-cursor`）、发送按钮变「停止」（`.ai-stop`）。点停止：`abort()` + 保留已渲染半截；一个字都没出则撤空气泡并把问题还回输入框。流式失败：已出字保留半截 + 重试入口，未出字撤气泡 + 标记提问失败（403/429 转顶部常驻提示条）。收尾以 `done.reply` 为权威全文重渲染并补 `sources`/`usedTokens`。

## 2. 离线传输层单测：17/17 PASS

| 用例 | 结果 |
| --- | --- |
| C01-1/3/7 按 1/3/7 字节切片：增量拼接 == done.reply，emoji 与汉字无乱码 | PASS |
| C02 start 带 conversationId/title、delta 三片、done 带 reply/sources/usedTokens | PASS |
| C03 请求打到 /api 前缀 /ai/chat/stream，POST + 分块 + 带 JWT + 放宽超时 | PASS |
| C04 半截事件行跨片续接、\r\n 分帧、坏块跳过不中断后续事件 | PASS |
| C05/C06 429/403：错误体只在分片里也能解析 detail、保留 statusCode、不退化重试 | PASS |
| C07 401：退化为一次性 /ai/chat，整段当单个 delta 推出（页面渲染路径唯一） | PASS |
| C08 一个增量都没收到就断网 → 退化重发（后端已清掉这次提问，不会重复） | PASS |
| C09 已推出增量后断网 → 不退化重发，只报错（重发会让正文重复） | PASS |
| C10 SSE error 事件转带 message 的 Error 交页面提示，不触发退化 | PASS |
| C11 abort() 后不再有任何回调（含 abort 后仍投递的排队分片） | PASS |
| C12/C13 canIUse 不支持 / canIUse 说谎（拿不到 onChunkReceived）：均降级，功能不中断 | PASS |
| C14/C15 message/conversationId/nodeId 透传；新建会话请求体只带 message | PASS |

C11 在加固过程中暴露并修复了一个真实缺陷：`abort()` 之后已排队的分片仍可能触发 `onDelta`，把正文写进已被替换的气泡；已在 `chatStream` 事件回调首行加 `finished` 短路。

## 3. 开发者工具端到端：9/9 PASS（真实后端 + 真实模型）

| 用例 | 结果 | 关键证据 |
| --- | --- | --- |
| A1 正文分多次增长（逐字渲染，非一次性返回） | PASS | 增长次数=50 不同长度=51 单调不减=true |
| A2 首字明显早于回答结束 | PASS | 首字=1412ms 末次增长=9305ms 首字占比=15% |
| A3 生成中光标在正文末尾、发送按钮变「停止」 | PASS | cursor=true stopBtn=true |
| A4 收尾 sending 复位、光标/停止消失、正文与 blocks 非空、无失败标记 | PASS | len=171 blocks=1 |
| A5 start 写入 conversationId、done 带回 usedTokens、无 403/429 提示条 | PASS | conv=11 usedTokens=372 |
| A6 生成中点停止：半截保留（不清空、不标失败、光标态复位）且明显短于完整回答 | PASS | 停止时 12 字 → 收尾 14 字，截断阈值 86 |
| A7 停止后正文不再增长、定时器已停 | PASS | 停止后采样恒为 14 |
| A8 停止后 sending 复位、按钮回「发送」、光标消失 | PASS | sendBtnBack=true |
| A9 停止后追问仍走同一会话并继续逐字输出 | PASS | conv 不变，增长次数=42 |

逐字曲线（ms:字数，节选）：`135:0 851:0 1570:6 2256:39 2953:70 3651:85 4335:101 5035:112 5707:124 6398:131 7081:141 7781:151 8468:160 9167:169` —— 首字约 1.4s 出现后持续增长至 9.3s，证明「先出字再继续吐」。

> A6 的判据说明：tap 从发出到送达可延迟数百毫秒，期间打字机仍会正常多吐几字（实测 +2），故断言为「收尾字数 ≥ 点停止时字数、且远短于同模型完整回答」，而非严格相等；「停止后不再增长」由 A7 单独断言。

## 4. 静态校验

- `node --check`：`pages/ai-chat/ai-chat.js`、`services/ai.js`、`services/request.js`、两个测试脚本均通过。
- WXML 标签配平：`depth=0 min=0 OK`；`wx:key` 未使用 index；模板内无原生方法调用。
- 截图两张人工核对：生成中光标落在已渲染正文末尾、「停止」按钮在位；停止后半截回答原样保留、按钮回「发送」。

## 5. 注意事项

1. **分块传输需基础库 ≥ 2.20.2**（项目 libVersion 3.0.0 满足）；更老基础库走 `supportsChunked()` 降级为一次性回答，功能不中断但无逐字效果。
2. **生产需关闭代理缓冲**：后端已带 `X-Accel-Buffering: no`；若前置 nginx 仍缓冲，前端会看到「长时间无字 → 一次性全出」，表现为 A1/A2 类断言失败（详见后端报告 §5）。
3. **停止不等于撤销**：点停止后后端把已推部分落库（半截保留），会话历史里会看到这条半截回答，与页面展示一致。
