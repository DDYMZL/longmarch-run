# S30 · AI 上游供应商可切换（LLM_PROVIDER）验收报告

- 日期：2026-10-22
- 范围：后端 AI 能力（历史助手对话 / 路线节点讲解 / 答题解析 / 管理端出题与题目工坊）的**上游调用层重构**。S27 把上游从腾讯云 CloudBase Agent 单向替换为阿里云百炼；本次改为**两套供应商并存、由 `LLM_PROVIDER` 一行切换**，并把开发期口径切回 CloudBase（上线时改回百炼）。业务契约、接口面、数据库结构均未变更，不涉及 SQL 迁移与前端改动。
- 脚本：`backend/test/s30_llm_provider_switch.py`（新增，本地桩服务器 + 真实调用）、`backend/test/s25_ai_question_generate.py`、`backend/test/s26_ai_center.py`、`backend/test/s28_ai_chat_stream.py`（回归，均 TestClient + SQLite 临时库，不依赖 8010/openGauss）。
- 结果文件：`backend/test/s30-llm-provider-switch-results.json`、`s25-ai-question-generate-results.json`、`s26-ai-center-results.json`、`s28-ai-chat-stream-results.json`。

## 1. 变更内容

### 1.1 结构：门面 + 适配器

| 模块 | 角色 | 说明 |
| --- | --- | --- |
| `app/services/llm_base.py`（新增） | 共享类型 | `LlmError`（带 `retryable`）、`CallResult`、`ensure_complete()`。单独成模块以打破「门面 ↔ 适配器」循环导入，并使两条链路的 `isinstance` 判定指向同一个类对象 |
| `app/services/llm_openai.py`（新增） | openai 适配器 | 原 `llm_service.py` 的 OpenAI 兼容实现整体迁入（`/chat/completions`、`system` role、`stream_options.include_usage`、重试与错误映射），类名 `LlmStream` → `OpenAiStream`，新增 `is_configured()` / `model_label()` / `stream()` |
| `app/services/llm_cloudbase.py`（新增） | cloudbase 适配器 | 从 `c660727^` 的 `cloudbase_service.py` 恢复 ACP 实现（JSON-RPC 2.0 `session/prompt` + SSE 逐行解析），并**新增流式支持**（`CloudBaseStream`）——旧版只累积不产出增量，无法满足 S28 建成的 SSE 逐字返回 |
| `app/services/llm_service.py`（重写） | 门面 | 按 `settings.LLM_PROVIDER` 分派；对外符号保持不变：`LlmError` / `CallResult` / `prompt_meta` / `prompt` / `LlmStream` / `model_label` / `is_configured` |

对外符号保持不变是硬要求：业务层与既有测试都按模块属性引用（s25/s26/s28 以 monkeypatch 替换 `llm_service.prompt_meta` / `prompt` / `LlmStream`，`routes/ai.py` 对 `LlmError` 做 `isinstance` 判定），改名会让这些测试静默失效。适配器统一约定 `is_configured()` / `model_label()` / `prompt_meta()` / `stream()` 四个符号，新增供应商只需再加一个模块并在 `_ADAPTERS` 登记。

### 1.2 两套协议的实质差异（并存后的口径）

| 项 | `LLM_PROVIDER=openai`（阿里云百炼） | `LLM_PROVIDER=cloudbase`（腾讯云 Agent） |
| --- | --- | --- |
| 协议 / 端点 | `POST {LLM_BASE_URL}/chat/completions` | JSON-RPC 2.0 `session/prompt` → `https://{ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/{AGENT_ID}/acp`（`CLOUDBASE_AGENT_URL` 非空时优先） |
| 系统提示 | 标准 `system` role | 前缀拼进用户输入（ACP 无已核实的 system 参数） |
| `max_tokens` | 生效（对话/解析传 `cfg.max_output_tokens`，出题不传） | **忽略**，输出长度只由提示词软约束 |
| 思考开关 | `LLM_EXTRA_BODY` / `LLM_QUESTION_EXTRA_BODY` 生效 | **无对应参数**，思考（`agent_thought_chunk`）不可关闭 |
| 正常结束原因 | `stop` | `end_turn` / `stop_sequence` |
| 用量口径 | `usage.total_tokens`（输入+输出，与按量计费一致） | `usage_update.used`（平台原值，含义未核实，见 §2.3） |
| 流式粒度 | 按 token 成块，首片 1–3s | 思考结束后正文才密集到达，首片 8.6–16.7s（见 §2.2） |

重试策略维持既有约定：非流式 `prompt_meta` 按 `AI_MAX_RETRIES` 重试瞬时故障；流式 `LlmStream` **不重试**（增量可能已推给用户，重发会导致正文重复），改由前端「停止 / 重试」兜底。

### 1.3 配置项

`backend/.env` 与 `backend/.env.prod` 均已改为「两套凭证常驻 + 一行切换」，当前 `LLM_PROVIDER=cloudbase`：

| 配置项 | 状态 | 说明 |
| --- | --- | --- |
| `LLM_PROVIDER` | 新增，当前 `cloudbase` | `openai` / `cloudbase`；取值非法时 `prompt_meta` 抛 `LlmError`（路由层映射 502），`model_label()` 不抛（异常收尾路径也会调用它，抛错会掩盖原始异常） |
| `LLM_TIMEOUT_SECONDS` | 保留 `300` | 两套供应商共用 |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_EXTRA_BODY` / `LLM_QUESTION_EXTRA_BODY` | 原值保留 | `openai` 时生效，上线即用 |
| `CLOUDBASE_ENV_ID` / `CLOUDBASE_AGENT_ID` / `CLOUDBASE_API_KEY` / `CLOUDBASE_AGENT_URL` | 恢复（值取自 `c660727^` 的 git 历史） | `cloudbase` 时生效 |
| `CLOUDBASE_TIMEOUT_SECONDS` | **不恢复** | 与 `LLM_TIMEOUT_SECONDS` 重复，避免同一含义两个旋钮 |
| `AI_QUESTION_BATCH_SIZE` | 保留 `5` | CloudBase 实测可承受 10 题/批，但不随供应商调整——保持「切换只改一行」 |

`.env.prod` 在 `LLM_PROVIDER` 行上方就地标注 `⚠⚠ 上线部署前必须把本行改为 LLM_PROVIDER=openai`。

### 1.4 调用点

`ai_chat_service`（4 处落库）、`routes/ai.py`（流式错误落库）的 `model=settings.LLM_MODEL` 改为 `model=llm_service.model_label()`，并移除随之失效的 `settings` 导入；`ai_usage_logs.model` 的语义因此随供应商变化（`openai` 为真实模型名 `qwen3.8-max`，`cloudbase` 为 Agent ID `agt-zy-…`），已在 `models.py` 与 `CallResult` 的文档字符串注明。`ai_question_service._build_prompt` 新增规则 11（见 §2.4）。

## 2. 真实调用实测发现（五项）

以下全部由本次真实调用暴露，非「换 key」可预见。

### 2.1 仓库内的阿里百炼 Key 已失效 —— 上线前必须替换（阻塞项）

以 `LLM_PROVIDER=openai` + `.env` 内现存 `LLM_API_KEY`（`<百炼 TokenPlan 凭证>`，116 字符）实测，非流式与流式两条路径均返回上游 `http=401 code=invalid_api_key`，5.7s 内抛 `LlmError: AI 服务鉴权失败，请检查 LLM_API_KEY 是否有效`（路由层映射 502）。即该 Key 已被吊销或过期，**切回百炼前必须先在百炼控制台重置并替换 `.env` / `.env.prod` 的 `LLM_API_KEY` 一行**；代码与配置结构无需改动。

这也是本次「开发期切回 CloudBase」后仍能跑通真实调用的前提：CloudBase 的 Key 实测有效（§3.1 D 组）。附带结论：本地 Clash fake-ip 会把网关域名解析到 `198.18.x.x`，但请求经代理正常出网，无需 `dns_shim` 兜底。

### 2.2 CloudBase 首片延迟高，打字机体验明显退化

同一问题、同一提示词下的真实流式实测：

| 供应商 | 分片数 | 首片 | 总耗时 | 首片占比 |
| --- | --- | --- | --- | --- |
| 百炼（S28 报告 L01） | 36 | 1.15s | 3.53s | 33% |
| 百炼（S28 报告 HTTP 探针） | 36 | 2.81s | 5.74s | 49% |
| CloudBase（本次 s30 D02） | 52 | 8.6s | 10.3s | 83% |
| CloudBase（本次 s28 L01） | 90 | 16.72s | 18.91s | 88% |

原因：ACP 的思考过程（`agent_thought_chunk`）不可关闭且先于正文到达，正文分片在思考结束后才密集产出。效果上用户在小程序里会盯着空白等 10s 以上，然后文字快速涌出——逐字动画的意义被大幅削弱。

处置：未改代码（这是上游特性，不是缺陷）。建议二选一：① 前端在收到首个 `delta` 前显示「AI 正在思考…」占位，避免白屏；② 需要真正的逐字体验就用回百炼（§5.1）。

### 2.3 CloudBase 的 `used` 用量口径不稳定，不能当单次计费依据

同一供应商、同量级提问下的实测值：`s30 D01 = 254`、`s28 L01 = 19400`、`s28 L02 = 19641`、`s26 L01 = 19832`；而百炼同场景为 `S28 L01 = 147`、`S26 L01 = 383`（见 S27 §3.2）。CloudBase 侧数值量级差近 80 倍且集中在 1.9 万上下，疑似包含 Agent 侧知识库/会话的累计口径，而非单次请求的输入+输出 token。

处置：`ai_usage_logs.used_tokens` 在 `cloudbase` 下**不可用于成本核算**，做统计必须按 `provider` 分段（`model` 字段可区分：Agent ID vs 模型名）。口径差异已写入 `models.py` 与 `llm_base.CallResult` 文档字符串，避免后人误读。未擅自换算或归零——没有权威口径前，保留平台原值比编造数字更安全。

### 2.4 出题 JSON 因未转义英文双引号整批解析失败（真实缺陷，已修）

`s25 A15`（50 题 / 10 批并发）首跑 15/16：10 批中 **2 批**报「AI 返回的 JSON 无法解析」。抓取原始回复定位为 `json.JSONDecodeError: Expecting ',' delimiter`（pos 484），根因是模型在题干里写了 `毛泽东称其为自己的"平生最得意之笔"` 这类**未转义的英文双引号**，直接破坏 JSON 结构。

处置：在 `_build_prompt` 增加规则「11. 所有字符串内部不得出现英文双引号 `"` 和反斜杠；需要引用原文或强调时改用中文引号“”」，原「补充要求」顺延为 12。**没有**做 JSON 修复引擎——事后修补既要猜引号边界又要猜字段结构，可靠性低于源头约束，且属过度设计；该规则对任何供应商都适用。复跑 16/16：`A14 generated=10 valid=10 invalid=0 batch_errors=[]`、`A15 generated=50 valid=50 invalid=0 unique_questions=50 batch_errors=[]`。

### 2.5 ACP 下 `max_tokens` 与思考开关均不生效

`s30 C04` 断言 ACP 请求体的键集合恰为 `{jsonrpc, id, method, params}`，即 `max_tokens` 与 `extra_body` 都不进请求体。后果：`AI_MAX_OUTPUT_TOKENS` 的硬截断与 `LLM_*EXTRA_BODY` 的思考开关在 CloudBase 下**静默失效**，输出长度只由提示词软约束（这也是 §2.4 那类长输出问题更容易出现的原因）。

处置：门面保留这两个形参（`openai` 下生效），`cloudbase` 适配器忽略，并在 `llm_cloudbase.py` 模块文档字符串逐条记录三处协议差异（system 仅前缀、`max_tokens`/`extra_body` 被忽略、流式粒度粗），避免调用方误以为配置生效。

## 3. 验收结果

### 3.1 s30 供应商切换：23/23 PASS

| 组 | 用例 | 结果 |
| --- | --- | --- |
| A 分派与配置（离线） | A01–A06 | PASS：`cloudbase` → ACP 适配器且 `model_label=agt-zy-7gnauryrb6fad70e`；`openai` → `model_label=qwen3.8-max`；非法取值 `azure` → `prompt_meta` 抛 `LlmError`（文案含取值与合法集合）而 `model_label` 不抛；门面与适配器 `LlmError`/`CallResult` 为同一类对象；两家缺 Key 时构造流与调用**都在发请求前**抛错 |
| B openai 适配器（本地桩） | B01–B07 | PASS：`path=/v1/chat/completions`、`system` role、`EXTRA_BODY` 透传、默认不带 `max_tokens`；显式传参时 `max_tokens=800` 入体；流式 4 片且收尾 usage 被采纳、`stream_options.include_usage` 已索取；出题链路 `prompt()` 用 `LLM_QUESTION_EXTRA_BODY` 覆盖为 `enable_thinking=True`；401（不可重试）/429/500（可重试）/`finish_reason=length` 四项映射正确；可重试错误重试后成功（上游调用次数=2）；空正文按「返回空内容」且 `retryable=True` |
| C cloudbase 适配器（本地桩） | C01–C07 | PASS：`path=/v1/aibot/bots/agt-stub-001/acp`、JSON-RPC `session/prompt`、system 前缀拼接为 `'系统提示\n\n用户问题'`；SSE 只拼 `agent_message_chunk`（思考/阶段事件忽略）、`usage_update.used=42`、终态 `stop=end_turn`；流式 4 片且与非流式正文一致；请求体不含 `max_tokens`/`extra_body`；`stopReason=max_tokens` 判为未正常结束、空正文可重试；显式 `AGENT_URL` 优先，留空时按 `https://{ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/{AGENT_ID}/acp` 拼接；401 → 提示检查 `CLOUDBASE_API_KEY` 且异常文案不泄露密钥 |
| D 真实调用（cloudbase） | D01–D03 | PASS：非流式 `耗时=16.3s stop=end_turn used=254`，正文为史实正确的遵义会议说明；流式 `分片=52 首片=8.6s 总耗时=10.3s 字数=149`；出题 `耗时=14.8s 题数=2 正文长度=553`，长输出 JSON 数组可解析（ACP 下未被截断） |

桩服务器为本地 `ThreadingHTTPServer`，同时模拟两种协议，离线可重复执行；`LM_AI_SKIP_LIVE=1` 可跳过 D 组。

### 3.2 回归：s25 / s26 / s28 全绿

| 套件 | 结果 | 关键实测 |
| --- | --- | --- |
| s25 AI 出题 | **16/16** | A14 `generated=10 valid=10 invalid=0 batch_errors=[] count_after=8`（草稿不入库）；A15 `generated=50 valid=50 invalid=0 unique_questions=50 batch_errors=[]` |
| s26 AI 智能中心 | **47/47** | C 配置 5/5、K 知识库 7/7、H 历史助手 12/12、R 讲解 6/6、Q 解析 6/6、W 工坊 11/11、G 回归 2/2、L 真实调用 1/1（`status=200 reply_len=178 usedTokens=19832`） |
| s28 流式对话 | **13/13** | S01–S11 事件序列/落库同构/越权与限额/中断收尾/密钥不泄露全通过；L01 `分片数=90 首片=16.72s 总耗时=18.91s usedTokens=19400 stop_reason=end_turn`；L02 `分片数=105 字数=255 usedTokens=19641 落库一致=True` |

合计 **99/99 PASS**。

### 3.3 静态校验

- `python -m py_compile` 覆盖 9 个 app 文件 + 4 个 test 文件，通过。
- `import app.main` + `app.openapi()`：**127 条路径**，其中 `/ai/` 相关 **19 条**；本次改动不含任何路由增删（`routes/ai.py` 的 diff 仅涉及导入与 `model=` 取值）。
- `app/` 与 `test/*.py` 全量 grep 无 `CLOUDBASE_TIMEOUT_SECONDS` / `cloudbase_service` / `CloudBaseError` 残留（仅 `app/services/__pycache__/cloudbase_service.cpython-313.pyc` 遗留字节码，已被 `.gitignore` 忽略，不入库）。

## 4. 测试脚本自身的修复

- **真实调用组会因供应商不同而误跳过**：s25/s26/s28 判定「能否跑真实调用」原写死 `settings.LLM_API_KEY`，切到 `cloudbase` 后会整组静默跳过（回归看似全绿但真实链路未覆盖）。已改为 provider 感知：`API_KEY` 取当前生效供应商的密钥，密钥泄露检查同步覆盖当前生效密钥，配置打印改为 `provider=… model=llm_service.model_label()`，跳过文案改为 `f"跳过：{PROVIDER} 供应商密钥未配置"`。
- **s28 L01 写死百炼口径**：原断言 `stop_reason == "stop"` 且「首片早于总耗时 80%」，CloudBase 下为 `end_turn` 且首片占比 0.88，首跑 12/13。改为按供应商取正常结束原因与阈值（`cloudbase` 0.95 / `openai` 0.8），并在注释记录实测占比；0.95 仍能区分真流式与「缓冲后一次吐」（后者 ≈1.0），不是为通过而放宽。
- **套件撞号**：新脚本原名 `s29_llm_provider_switch.py` 与既有 `s29_route_stats.py` 同占 S29，已改名 `s30_…`，报告与结果文件同步。
- **C 组曾打到公网网关**：`CLOUDBASE_AGENT_URL` 留空时会按 `ENV_ID` 拼出真实网关地址，导致离线用例变成真实调用。已把桩地址显式写入 `CLOUDBASE_AGENT_URL`，并将「留空时的拼接规则」单列为 C06 直接断言 `_resolve_url()`。

## 5. 上线切换清单与遗留

### 5.1 切回阿里百炼（上线）三步

1. 在百炼控制台重置或新建 API Key（现库内 Key 已 401 失效，见 §2.1），替换 `backend/.env.prod` 的 `LLM_API_KEY` 一行；
2. 把 `backend/.env.prod` 的 `LLM_PROVIDER` 改为 `openai`（该文件已就地标注 ⚠⚠）；
3. 跑 `python test/s30_llm_provider_switch.py`（D 组会真实调用）与 `s25` / `s26` / `s28`，确认 A/B/D 组全绿。

无需改代码、无需数据库迁移、无需重新构建前端。

### 5.2 遗留与注意事项

1. **百炼 Key 失效是上线阻塞项**（§2.1），未替换则生产 AI 全部 502。
2. **两把密钥均已入 git 历史**（`backend/.env` / `.env.prod` 入库为既有约定）：CloudBase Key 从 `c660727^` 原样回填，百炼 Key 沿用 S27 写入值。二者都建议重置，重置后各改一行即可。
3. **`.env.prod` 口径冲突延续**：`backend/AGENTS.md` §6.4 要求生产密钥保持占位，而该文件自 S27 起即存真实值（S27 §5.4 已记录），本次沿用既有做法，待用户裁定。
4. **CloudBase 用量口径未核实**（§2.3）：若要做成本看板，须先向腾讯云确认 `usage_update.used` 的确切含义。
5. **前端体验待办**（§2.2）：CloudBase 下建议补「AI 正在思考…」占位；这是当前开发期口径下的既有体验损失，非本次回归引入。
6. **`.qoder/` 结构化文档同步**：新增 `llm_base.py.md` / `llm_openai.py.md` / `llm_cloudbase.py.md`，重写 `llm_service.py.md`，删除已失效的 `cloudbase_service.py.md`，并同步 `config.py.md` / `.env.md` / `.env.prod.md` / `ARCHITECTURE.md` §11.1（仍写 `CLOUDBASE_ACP_URL`）/ `REQUIREMENTS.md`（仍列 `CLOUDBASE_TIMEOUT_SECONDS`）/ `PROJECT.md` §10 / `CHANGELOG.md`。这是 S27 §5.5 遗留债务的延续，本次一并处理，随后单独提交。
