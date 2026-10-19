# S28 · AI 历史助手逐字回答（SSE 流式）后端验收报告

- 日期：2026-10-19
- 范围：`POST /api/ai/chat/stream`（SSE 逐字返回）+ `llm_service.LlmStream`（OpenAI 兼容流式）+ `ai_chat_service` 前置校验与收尾落库拆分。非流式 `POST /api/ai/chat` 契约不变，仅作同构对照。
- 脚本：`backend/test/s28_ai_chat_stream.py`（TestClient + SQLite 临时库，不依赖 8010/openGauss；真实调用组 L01/L02 需 `LLM_API_KEY`，可用 `LM_AI_SKIP_LIVE=1` 跳过）。
- 结果文件：`backend/test/s28-ai-chat-stream-results.json`。

## 1. 变更内容

### 1.1 端点与事件序列

`POST /api/ai/chat/stream` 以 `text/event-stream` 推送，帧格式 `data: {json}\n\n`，事件序列 `start` → `delta`* → `done`，流内失败发 `error`：

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `start` | `{type, conversationId, title}` | 首帧，前端立刻更新会话标题与归属 |
| `delta` | `{type, text}` | 一段增量正文（模型按 token 成块推送，前端再做逐字平滑） |
| `done` | `{type, usedTokens, reply, sources}` | 收尾帧；`reply` 为已落库权威全文，供前端校正本地拼接 |
| `error` | `{type, message}` | 流内失败。此时 200 与响应头已发出，状态码无法再改，错误只能走事件 |

响应头带 `X-Accel-Buffering: no` 与 `Cache-Control: no-cache`（`_STREAM_HEADERS`）。

### 1.2 前置校验不进 SSE

开关/限额/输入/会话归属校验与 `LlmStream` 构造都在返回 `StreamingResponse` **之前**完成，这类失败仍是普通 JSON + 403/429/400/502，前端无需为它们解析 SSE（S05 覆盖）。

### 1.3 中断（abort）落库语义

客户端断开使生成器提前退出时走 `_settle_aborted`：已产出增量非空 → 按拼接全文 `finalize_message` 落库（半截保留、`used_tokens=None`）；一个增量都没有 → `discard_message` 回滚并删除本次新建的空会话（S09 两分支均覆盖）。收尾失败不得掩盖触发它的原始异常。

### 1.4 服务层拆分

`ai_chat_service` 拆出 `prepare_message`（校验 + 组装 prompt + 知识来源）/ `finalize_message` / `discard_message`，供流式与非流式两条链路共用；`ChatTurn` 只携带纯数据（sources 预转 dict），使收尾可在独立 `SessionLocal()` 中执行而不触发 `DetachedInstanceError`。

## 2. 验收结果：13/13 PASS（离线 + 真实调用）

| 用例 | 结果 | 关键证据 |
| --- | --- | --- |
| S01 事件序列 start→delta*→done 且 delta 片数与模型分片一一对应 | PASS | `types=['start','delta'×4,'done']` |
| S02 增量拼接 == done.reply == 落库正文，used_tokens 落库 | PASS | `reply_len=20 stored_tokens=321` |
| S03 响应头 text/event-stream + X-Accel-Buffering:no + no-cache | PASS | `xab=no cc=no-cache` |
| S04 start 先于任何 delta 带 conversationId/title，done 带 sources | PASS | `conv=1 in_db=True sources=[…]` |
| S05 前置校验失败回普通 JSON + 正确状态码（400/401/403/429） | PASS | 空输入=400 无token=401 他人会话=400 关闭=403 限额=200/429 |
| S06 流内上游故障：已推增量保留 + 发 error 事件 + 记 error 用量 | PASS | `deltas=2 conv 2->2 msg 4->4 errlog 0->1` |
| S07 连续对话沿用同一会话、历史注入 system、限额按次扣 | PASS | `hist=True sys=True max_tokens=800` |
| S08 客户端提前断开：取消上游、只落已推部分 | PASS | 客户端只收到 2 个事件，落库为半截 |
| S09 中断收尾两分支：有增量落半截（用量记空）/ 无增量删提问与空会话 | PASS | 半截正文='只推出去的一半' tokens=None；会话数不变 |
| S10 与非流式 /ai/chat 落库同构（正文/used_tokens/sources 形态一致） | PASS | `tokens=55/55` |
| S11 SSE 响应体与错误响应均不泄露 LLM_API_KEY | PASS | — |
| **L01 真实流式调用：上游逐片到达、首片延迟远小于总耗时** | PASS | `分片数=36 首片=1.15s 总耗时=3.53s 字数=165 usedTokens=147 stop_reason=stop` |
| **L02 真实模型下 SSE 端点逐片转发：增量拼接 == done.reply == 落库正文** | PASS | `分片数=50 字数=219 usedTokens=426 落库一致=True` |

L01/L02 共同证明「真流式」而非缓冲后一次吐：上游 36 片、首片 1.15s（占总耗时 33%）；端点侧 50 片转发且落库与增量拼接一致。

## 3. 测试脚本自身的一处方法论修正

**L01 不能在 TestClient 下测「首片到达时刻」**：本版 starlette 的 `_TestClientTransport` 把整个响应体先写进 `BytesIO`、再以 `httpx.ByteStream` 一次性交给客户端（`testclient.py:296/365`），因此端点侧的逐片到达时刻在测试中不可观测。已把原单一用例拆为 L01（直接迭代 `LlmStream` 测「上游 + 解析器」逐片到达与首片延迟）+ L02（端点只断言分片数、转发一致性与落库一致），并在脚本注释中说明该限制，避免后人误以为端点首片延迟可测。

## 4. 静态与回归校验

- `python -m py_compile` 覆盖改动的 app 与 test 文件，通过。
- `import app.main` + `app.openapi()`：**126 条路径**，`/api/ai/chat/stream` 在列。
- 非流式回归 `backend/test/s26_ai_center.py`：exit code 0（全通过），流式改造未破坏既有 AI 契约。
- 真实 HTTP 探针（对 8010 本机后端）：`status=200`、`content-type=text/event-stream; charset=utf-8`、`x-accel-buffering=no`，`start@0.95s`、`分片数=36 首片=2.81s 总耗时=5.74s`（首片占比 49%），判定真流式。

## 5. 部署注意（必读）

1. **必须关闭反向代理缓冲**：响应已带 `X-Accel-Buffering: no`，nginx 见到该头会对本响应关闭 `proxy_buffering`。但若前置代理不识别该头或显式 `proxy_buffering on` 覆盖，增量会被攒到连接结束才下发，逐字效果失效、退化为一次性返回。生产 nginx 建议对 `/api/ai/chat/stream` 显式 `proxy_buffering off; proxy_cache off;` 兜底。
2. **读超时**：流式连接存活时间 = 模型生成时长，需确保代理 `proxy_read_timeout` 大于 `LLM_TIMEOUT_SECONDS`（300s），否则长回答会被代理中途掐断（前端表现为流内中断、保留半截）。
3. **用量口径**：流式与非流式同走 `ai_usage_logs`，`used_tokens` 为 `usage.total_tokens`；中断（abort）落半截时 `used_tokens=None`（用量在 error/abort 分支单独 record）。
4. **API Key 不泄露**：S11 断言 SSE 响应体与错误响应均不含 `LLM_API_KEY`；密钥仅在 `llm_service` 内组装到请求头。
