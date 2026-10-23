# llm_cloudbase.py

## 1. 文件路径

`backend/app/services/llm_cloudbase.py`（320 行）

## 2. 文件职责

大模型适配器 · **腾讯云 CloudBase Agent（ACP 私有协议）**。按 JSON-RPC 2.0 调用 `session/prompt`，解析 SSE 事件流：只拼接 `agent_message_chunk` 的正文，忽略 `agent_thought_chunk`（思考过程）与 `agent_phase`（阶段），同时捕获平台报告的 `usage_update.used` 用量与终态 `result.stopReason`，供上层落 `ai_usage_logs`（`backend/app/services/llm_cloudbase.py:3-5`）。

与 OpenAI 兼容适配器的三处协议差异（`:7-12`，换回本供应商时须知道）：① **系统提示只能前缀拼接**进用户输入；② **不接受 `max_tokens` / `extra_body`**（ACP 无可核实的对应参数，二者被忽略）；③ **流式粒度粗**（见 §9 第 4 条对该说法的实测质疑）。

本文件不接触数据库，也不 import 门面 `llm_service`（避免循环 import），只被门面按 `LLM_PROVIDER=cloudbase` 分派调用。

## 3. 业务需求

- 需求来源：`b712d81`（2026-10-22）用户要求「把 AI key 切回之前那把（腾讯云 CloudBase），上线再用阿里这套」；因直接 revert 会杀掉 `6a4dbb7` 建成的 SSE 流式，改为两套供应商并存、`LLM_PROVIDER` 一行切换。见 `docs/迭代记录.md` 的 `b712d81` 条目。
- **代码来龙去脉**（git 层面本文件首次出现于 `b712d81`，但实现是**恢复**而非新写）：ACP 实现原位于 `backend/app/services/cloudbase_service.py`，由 `ea58b6c`（2026-10-16，题库接入 CloudBase Agent AI 出题）创建、`1600074`（2026-10-17，AI 智能中心 Phase A）重构出 `_request_once` / `prompt_meta` / `CallResult` / `_StreamState` / `retryable` 与重试退避；`c660727`（2026-10-19）把该文件 `git mv` 成 `llm_service.py` 并重写为百炼实现，**ACP 代码整块删除**。本次从 `c660727^` 恢复（`git show c660727^:backend/app/services/cloudbase_service.py` 可看原版），并做四处刻意改动（见 §10）。
- 承接的业务链路：与 openai 适配器完全相同的四条（AI 历史助手对话含 SSE 流式、答题解析、后台 AI 出题；路线节点讲解不调模型），业务层不感知供应商。
- 当前生效状态：`backend/.env:38` 与 `backend/.env.prod:50` 的 `LLM_PROVIDER` 均取 `cloudbase`（开发/联调期口径）；两份文件就地标注**上线部署前必须改回 `openai`**（`backend/.env:37`、`backend/.env.prod:48-49`）。
- 安全需求（`:17`）：API Key 仅在本模块内组装到请求头，不写日志、不进异常消息、不下发前端。
- 导航层出处（只回指）：`.qoder/ARCHITECTURE.md` §11.1「外部集成」已按本文件与 `CLOUDBASE_AGENT_URL`（`backend/app/core/config.py:93`）的现行名称收录 ACP 协议、地址拼接与 SSE 事件形态；`.qoder/CHANGELOG.md` §2.14、`.qoder/decisions/README.md` §1.7 记该次「门面 + 双适配器」取舍。

## 4. 核心功能

### 4.1 符号清单

| 名称 | 行号 | 说明 |
|---|---|---|
| 模块 docstring | `:1-18` | 协议、三处差异、无状态多轮、安全约定 |
| `logger` | `:30` | 模块级 logger；3 处 warning（`:125`、`:213`、`:297`）与 1 处 info（`:244`） |
| `_ACP_PATH` | `:33` | `"/v1/aibot/bots/{agent_id}/acp"`，端点路径模板 |
| `_SSE_DATA_PREFIX` / `_STREAM_DONE` | `:34` / `:35` | `"data:"` / `"[DONE]"` |
| `_NORMAL_STOP_REASONS` | `:36-37` | `("end_turn", "stop_sequence")`；注释：其余取值（如 `max_tokens`）意味着回复被截断，出题的 JSON 必然不完整 |
| `_StreamState`（`@dataclass`） | `:40-47` | SSE 消费过程的累积状态 |
| `is_configured()` | `:50-56` | 适配器契约①：Key 必备 + 地址可确定，**不抛异常** |
| `model_label()` | `:59-61` | 适配器契约②：`CLOUDBASE_AGENT_ID`，为空则字面量 `"cloudbase-agent"` |
| `_resolve_url()` | `:64-75` | 显式地址优先，否则按 ENV_ID + AGENT_ID 拼接 |
| `_require_key()` | `:78-82` | API Key 校验，为空抛 `LlmError` |
| `_http_error(status_code)` | `:85-95` | 状态码 → 中文提示 + `retryable` 分级 |
| `_consume_line(line, state)` | `:98-150` | SSE 单行解析，**返回本次新增的正文片段**（无正文返回 `None`） |
| `_build_body(text)` | `:153-160` | JSON-RPC 2.0 `session/prompt` 请求体 |
| `_auth_headers()` | `:163-170` | `Content-Type` + `Accept: text/event-stream` + `Bearer` |
| `_join_system(system, text)` | `:173-175` | 系统提示前缀拼接 |
| `_finish(state, started)` | `:178-187` | 累积状态 → `CallResult` + 完整性校验（流式与非流式共用） |
| `_request_once(text, timeout)` | `:190-215` | 发一次调用并阻塞读 SSE 到结束 |
| `prompt_meta(...)` | `:218-247` | 适配器契约③：非流式主入口 + 瞬时故障重试 |
| `class CloudBaseStream` | `:250-299` | 一次流式调用（`__init__` `:260-273`、`__iter__` `:275-299`） |
| `stream(...)` | `:302-320` | 适配器契约④：流式工厂，门面 `LlmStream` 转发到此 |

### 4.2 `_StreamState`（`:40-47`）

`chunks: List[str]`（`field(default_factory=list)`，`:44`）、`used_tokens: Optional[int] = None`（`:45`）、`stop_reason: str = ""`（`:46`）、`done: bool = False`（`:47`）。非流式与流式共用同一个状态结构，是「两条路径同构」（s30 C 组断言项）的实现基础。

### 4.3 配置齐备判定、模型标识与地址解析（`:50-82`）

- `is_configured()`（`:50-56`）：`CLOUDBASE_API_KEY` 为空直接 False（`:52-53`）；`CLOUDBASE_AGENT_URL` 非空即 True（`:54-55`）；否则要求 `CLOUDBASE_ENV_ID` 与 `CLOUDBASE_AGENT_ID` 同时非空（`:56`）。
- `model_label()`（`:59-61`）：返回 `settings.CLOUDBASE_AGENT_ID.strip()`，为空时返回字面量 `"cloudbase-agent"`。`:60` 说明理由：**ACP 不暴露真实模型名**，沿用迁移前的 Agent ID。因此 `ai_usage_logs.model` 的语义随供应商变化（`backend/app/models/models.py:688-689`），Agent ID 形如 `agt-…`。
- `_resolve_url()`（`:64-75`）：
  1. `CLOUDBASE_AGENT_URL` 非空 → **直接返回该显式地址**（`:66-68`）；
  2. 否则读 `CLOUDBASE_ENV_ID` 与 `CLOUDBASE_AGENT_ID`（`:69-70`），任一为空 → 抛**不可重试** `LlmError`「AI 服务未配置，请在后端环境变量中设置 CLOUDBASE_ENV_ID 与 CLOUDBASE_AGENT_ID」（`:71-74`）；
  3. 拼接（`:75`）：`https://{env_id}.api.tcloudbasegateway.com` + `_ACP_PATH.format(agent_id=agent_id)`。与 `backend/app/core/config.py:92` 的注释口径一致。
- `_require_key()`（`:78-82`）：为空抛不可重试 `LlmError`「AI 服务未配置，请在后端环境变量中设置 CLOUDBASE_API_KEY」。此校验**先于** `_resolve_url()` 发生（`:232-233`、`:269-270`）。

### 4.4 错误映射（`:85-95`）

| 状态码 | 文案 | `retryable` | 行号 |
|---|---|---|---|
| 401 / 403 | AI 服务鉴权失败，请检查 CLOUDBASE_API_KEY 是否有效 | False | `:87-88` |
| 404 | AI 服务地址或 Agent ID 不正确 | False | `:89-90` |
| 429 | AI 服务请求过于频繁，请稍后重试 | **True** | `:91-92` |
| ≥ 500 | AI 服务暂时不可用，请稍后重试 | **True** | `:93-94` |
| 其他 | AI 服务返回异常状态码 {status_code} | False | `:95` |

**无 402 分支**（openai 适配器有，`backend/app/services/llm_openai.py:85-86`）；本适配器也不解析上游错误码（无 `_error_code`），文案不点名内部细节（`:86` docstring）。

### 4.5 `_consume_line(line, state)`（`:98-150`）——SSE 单行解析

`:103-110` docstring 记录了 **4 种实测事件形态**（正文分片 / `usage_update` 用量 / 终态帧 / `[DONE]`），`:110` 说明 `agent_thought_chunk`（思考过程）与 `agent_phase` 均不属于正文、直接忽略。与原版（`c660727^`）的关键差异：**返回值由 `None` 改为「本次新增的正文片段」**（`:101`），流式模式据此往下游推增量。

解析顺序：

1. `line.strip()` 后不以 `data:` 开头 → `None`（`:112-114`）；
2. 去掉前缀再 strip，空载荷 → `None`（`:115-117`）；
3. 载荷等于 `[DONE]` → `state.done = True`，返回 `None`（`:118-120`）；
4. `json.loads` 失败 → warning「cloudbase stream: skip unparsable chunk」后返回 `None`（`:121-126`，`:124` 注释：丢一片只少几个字，中断整条流会让已显示的半截回答失去下文）；非 dict → `None`（`:127-128`）；
5. `event["error"]` 真值 → 抛**可重试** `LlmError`「AI 服务返回错误，请重试」（`:129-130`）；
6. `event["result"]` 是 dict（终态帧）→ 写 `state.stop_reason` 并置 `done`，返回 `None`（`:131-135`）——**截断判定不在这里做**，移到 `_finish`（`:186`）；
7. `params.update.sessionUpdate == "agent_message_chunk"` 且 `content.type == "text"` → 追加 `content.text` 到 `state.chunks` 并**返回该片段**（`:138-145`）；
8. `== "usage_update"` 且 `used` 是 int → 写 `state.used_tokens`（`:146-149`）；
9. 其余事件类型（`agent_thought_chunk` / `agent_phase` / 未知）落到 `:150` 返回 `None`。

### 4.6 请求组装（`:153-175`）

- `_build_body(text)`（`:153-160`）：`{"jsonrpc": "2.0", "id": 1, "method": "session/prompt", "params": {"prompt": [{"type": "text", "text": text}]}}`。`id` **恒为 1**、不递增；**不传 sessionId**——`:15-16` 说明网关会自动建会话，因此无需先调 `session/new`。请求体键集合恰为 `{jsonrpc, id, method, params}`（s30 C 组直接断言）。
- `_auth_headers()`（`:163-170`）：`Content-Type: application/json; charset=utf-8`（`:166` 注释：显式声明 charset，避免中文提示词被上游按其他编码解释）、`Accept: text/event-stream`（`:168`）、`Authorization: Bearer <CLOUDBASE_API_KEY>`（`:169`）——**密钥在本文件内唯一被使用的位置**。
- `_join_system(system, text)`（`:173-175`）：`f"{system.strip()}\n\n{text}"`，即「系统提示 + 空行 + 用户输入」的**前缀拼接**；`system` 为 `None` 或 strip 后为空则原样返回 `text`。`:174` 注明理由：ACP 无经核实的 `system` 参数。

### 4.7 非流式：`_request_once` + `prompt_meta`（`:178-247`）

`_finish(state, started)`（`:178-187`）：把累积状态收敛成 `CallResult`（`text` 为 `"".join(state.chunks).strip()`，`elapsed_ms` 由 `time.monotonic()` 差值换算），随后 `ensure_complete(result, _NORMAL_STOP_REASONS)`（`:186`）——截断与空回复都在此抛出。**流式与非流式共用本函数**，是两者结果同构的保证。

`_request_once(text, timeout)`（`:190-215`）：

- 每次调用**重新解析地址**（`:192`），不缓存 URL；
- 传输 `httpx.Client(timeout=timeout)` + `client.stream("POST", url, json=_build_body(text), headers=_auth_headers())`（`:196-199`），`timeout` 原样透传给 httpx（按 httpx 语义同时作用于连接/读/写/池）；
- 非 200：先 `response.read()` 排空响应体（`:201`）再 `raise _http_error(status_code)`（`:202`）；
- 读流：逐行 `response.iter_lines()` 喂 `_consume_line`，一旦 `state.done` 立即 `break`（`:203-206`）——**不读完整个流**；
- 异常顺序（`:207-214`）：`LlmError` 原样上抛 → `httpx.TimeoutException` 可重试超时 → `httpx.HTTPError` 只记 `exc.__class__.__name__`（`:212` 注释：避免把 URL/请求细节写进日志）并抛可重试；
- 收尾 `return _finish(state, started)`（`:215`）。

`prompt_meta(text, *, system=None, timeout=None, max_retries=None, max_tokens=None, extra_body=None)`（`:218-247`）：

1. `_require_key()`（`:232`）；
2. `final_text = _join_system(system, text)`（`:233`）——**系统提示在此处就并入正文**，后续所有环节只见一段文本；
3. `effective_timeout = timeout or settings.LLM_TIMEOUT_SECONDS`（`:234`；两套供应商共用该配置，`backend/app/core/config.py:73`）；
4. `attempts = 1 + max(0, settings.AI_MAX_RETRIES if max_retries is None else max_retries)`（`:235`），默认共尝试 2 次；
5. 重试循环（`:237-245`）：不可重试或最后一次 → `raise`（`:241-242`）；否则 info 日志（`:244`，第 3 个参数是固定字符串 `"transient"`）+ `time.sleep(0.5 * (attempt + 1))` 线性退避（`:245`）；
6. `:246-247` 是自带「理论不可达」注释的兜底 `raise`。
7. **`max_tokens` / `extra_body` 仅为门面统一签名而保留，此处忽略**（`:230` docstring 明写，理由见模块 docstring `:9-10`）。

### 4.8 流式：`CloudBaseStream`（`:250-299`）与 `stream()`（`:302-320`）

- `__init__`（`:260-273`）：`_require_key()`（`:269`）→ `self._url = _resolve_url()`（`:270`）→ `self._body = _build_body(_join_system(system, text))`（`:271`，**system 在构造期就已拼进请求体**）→ `self._timeout = timeout or settings.LLM_TIMEOUT_SECONDS`（`:272`）→ `self.result = None`（`:273`）。`:253-254` 说明构造即校验的理由：使「未配置」在响应头发出之前就以普通 JSON + 502 返回，而不是退化成流中途的 `error` 事件（对应路由实现 `backend/app/api/routes/ai.py:126-137`）。
- `__iter__`（`:275-299`）：`httpx.Client(timeout=self._timeout)` + `client.stream("POST", self._url, json=self._body, headers=_auth_headers())`（`:279-282`）→ 非 200 先 `read()` 再抛 `_http_error`（`:283-285`）→ 逐行 `_consume_line`，**返回的片段非空即 `yield`**（`:286-289`），`state.done` 即 `break`（`:290-291`）→ 异常处理与非流式同构（`:292-298`）→ `self.result = _finish(state, started)`（`:299`）。
- **不做自动重试**（`:256`）：增量可能已推给用户，重发会导致正文重复。
- 消费方提前退出（客户端断开）时 `:299` 不执行，`result` 保持 `None`（`:257`），调用方须自行判定（`backend/app/api/routes/ai.py:98-101`）。
- `stream(...)`（`:302-320`）：模块级工厂，返回 `CloudBaseStream`；`:312` 注明 `max_tokens` / `extra_body` 是本适配器忽略的参数，仅为与门面签名一致而保留。

## 5. 输入与输出

### 5.1 参数与返回

| 入口 | 参数 | 返回 |
|---|---|---|
| `prompt_meta`（`:218-226`） | `text: str`（位置）；keyword-only：`system`、`timeout`、`max_retries`、`max_tokens`（**忽略**）、`extra_body`（**忽略**） | `CallResult` |
| `stream`（`:302-309`） | `text: str`（位置）；keyword-only：`system`、`timeout`、`max_tokens`（**忽略**）、`extra_body`（**忽略**） | `CloudBaseStream` |
| `CloudBaseStream.__iter__` | — | `Iterator[str]`，逐个 `yield` 增量正文；迭代结束后 `.result` 为 `CallResult` 或 `None` |
| `is_configured` / `model_label` | 无 | `bool` / `str` |

`text` 不做长度校验（长度控制在上层，`backend/app/core/config.py:106` 的 `AI_MAX_INPUT_CHARS`）。`CallResult.used_tokens` 为平台 `usage_update.used` **原值**，含义未经核实、不换算（`backend/app/services/llm_base.py:33-34`）。

### 5.2 异常

**只抛 `LlmError`**（从 `backend/app/services/llm_base.py:28` import，**不是** `c660727` 之前的 `CloudBaseError`）。HTTP 映射与 openai 适配器完全一致：502（`backend/app/api/routes/ai.py:56-57`、`backend/app/api/routes/admin.py:585-587`、`backend/app/api/routes/ai_admin.py:15` + `:224-225`）。文案原样透传到小程序与管理后台，全部为面向终端用户的中文；s30 C 组断言「401 → 提示检查 `CLOUDBASE_API_KEY` 且异常文案不泄露密钥」。

### 5.3 上游契约（出站）

- 协议：HTTPS `POST`，JSON-RPC 2.0 `session/prompt`，响应 `text/event-stream`。
- 地址：`CLOUDBASE_AGENT_URL` 非空时直用，否则 `https://{CLOUDBASE_ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/{CLOUDBASE_AGENT_ID}/acp`（`:64-75`）。
- 鉴权：`Authorization: Bearer <CLOUDBASE_API_KEY>`（`:169`）。
- 期望的 SSE 事件形态见 `:103-110`（实测记录）：`agent_message_chunk`（正文）/ `agent_thought_chunk`（思考，忽略）/ `agent_phase`（阶段，忽略）/ `usage_update`（用量）/ 终态 `result.stopReason` / `[DONE]`。
- 多轮对话**无状态**（`:14`）：不依赖网关会话续接（**未验证**），由上层把最近历史拼进单次提示词；不传 sessionId、不缓存会话。

### 5.4 读取的配置项（全部来自 `backend/app/core/config.py`）

| 配置项 | 本文件引用行 | 定义行 | 用途 |
|---|---|---|---|
| `CLOUDBASE_API_KEY` | `:52`、`:79`、`:169` | `backend/app/core/config.py:91` | Bearer 鉴权（**值不入文档**） |
| `CLOUDBASE_AGENT_URL` | `:54`、`:66` | `:93` | 显式 ACP 地址；留空则拼接 |
| `CLOUDBASE_ENV_ID` | `:56`、`:69`、`:75` | `:89` | 拼接网关域名 |
| `CLOUDBASE_AGENT_ID` | `:56`、`:61`、`:70`、`:75` | `:90` | 拼接端点路径，兼作 `ai_usage_logs.model` |
| `LLM_TIMEOUT_SECONDS` | `:234`、`:272` | `:73` | 单批调用超时，**两套供应商共用** |
| `AI_MAX_RETRIES` | `:235` | `:109` | 缺省重试次数 |

**`CLOUDBASE_TIMEOUT_SECONDS` 已不存在**（`c660727` 收敛、`b712d81` 未恢复）：不得在本文件重新引用该配置项。`LLM_EXTRA_BODY` / `LLM_QUESTION_EXTRA_BODY` 亦不被本文件读取（ACP 无对应参数，门面传入的 `extra_body` 在 `:230`、`:312` 被忽略）。

## 6. 依赖关系

### 6.1 依赖

- 第三方：`httpx`（`:25`；同步 `Client` + `stream`）。
- 标准库：`json`（`:19`）、`logging`（`:20`）、`time`（`:21`）、`dataclasses.dataclass/field`（`:22`）、`typing`（`:23`）。
- 项目内：`app.core.config.settings`（`:27`）、`app.services.llm_base` 的 `CallResult` / `LlmError` / `ensure_complete`（`:28`）。
- 外部服务：腾讯云 CloudBase Agent 网关（域名由 `_resolve_url()` 拼接，`:75`）。
- **数据库表：无**（不 import ORM、不接收 `Session`）。

### 6.2 被谁依赖

实测命令：`grep -rn "llm_cloudbase" backend/`。

| 依赖方 | 位置 | 说明 |
|---|---|---|
| `backend/app/services/llm_service.py` | import `:26`；登记进 `_ADAPTERS` `:41` | **唯一的生产调用方**（门面按 `LLM_PROVIDER` 分派） |
| `backend/test/s30_llm_provider_switch.py` | import `:61`；类型同一性断言 `:244`；C 组本地桩 7 项；`:432` 直接断言 `_resolve_url()` 的拼接规则 | 直接 import 以断言适配器行为 |
| `backend/app/core/config.py` | `:71` 注释提及（**非 import**） | 说明适配器归属 |

**业务层无任何文件直接 import 本模块**——一律只 import 门面 `llm_service`（与 `backend/app/services/llm_service.py:3` 的设计约定一致）。调用链与 openai 适配器完全相同，见 `.qoder/backend/app/services/llm_openai.py.md` §6.2。

## 7. 业务规则

1. **系统提示只能前缀拼接**（`:8`、`:173-175`、`:233`、`:271`）：ACP 的 `system` 参数未经核实，沿用迁移前做法；改动前需对真实网关重新核实。
2. **`max_tokens` 与 `extra_body` 被忽略**（`:9-10`、`:230`、`:312`）：ACP 无对应参数，因此 `AI_MAX_OUTPUT_TOKENS`（env 默认 800，`backend/app/core/config.py:107`）的**硬截断在本供应商下静默失效**，思考开关（`LLM_EXTRA_BODY` / `LLM_QUESTION_EXTRA_BODY`）同样无效；输出长度只能靠提示词软约束（`ai_config_service` 的提示词里已写「不超过 N 字」，见 `:10` 注释）。上层照常传参：`backend/app/api/routes/ai.py:134`（`max_tokens=turn.cfg.max_output_tokens`）、`backend/app/services/ai_chat_service.py:346`、`:523`。
3. **只取正文**：`agent_thought_chunk`（思考过程）与 `agent_phase` 一律忽略（`:110`、`:150`），思考过程不落库、不下发前端。
4. **截断即失败，绝不返回半截文本**：`stopReason` 非 `end_turn` / `stop_sequence` → `_finish` 抛不可重试 `LlmError`（`:186`、`:36-37`）。对 AI 出题链路尤其关键（截断后 JSON 必然不完整）。s30 D03 实测出题长输出在 ACP 下**未被截断**（2 题 / 14.8s / 正文 553 字）。
5. **空回复视为瞬时故障并可重试**（由 `ensure_complete` 判定，`backend/app/services/llm_base.py:53-54`）。
6. **重试仅限 `retryable`**：配置缺失（`:72`、`:81`）、鉴权失败 401/403（`:88`）、404（`:90`）、未知状态码（`:95`）、回复截断（`:186`）**不重试**；超时（`:210`、`:295`）、网络错误（`:211-214`、`:296-298`）、429（`:92`）、5xx（`:94`）、SSE `error` 帧（`:130`）、空回复**重试**。**流式一律不重试**（`:256`）。
7. **无状态多轮**（`:14-16`）：每次调用独立 HTTP 请求，不缓存 sessionId、不复用连接（`with httpx.Client(...)` 每次新建，`:196`、`:279`）；网关自动建会话，故无需 `session/new`。
8. **用量口径不换算**：`used_tokens` 是平台 `usage_update.used` 原值（`:146-149`），且实测量级不稳（见 §9 第 2 条），**不可作单次计费依据**。
9. **终态帧即停**：`result` 帧或 `[DONE]` 置 `done` 后立即 `break`（`:118-120`、`:131-135`、`:205-206`、`:290-291`），终态之后的事件会被丢弃。
10. **密钥安全**：`:17`（模块约定）、`:86`（错误文案不含内部细节）、`:212-213` 与 `:297`（日志只记异常类名）、`:244`（重试日志只记固定字符串）。密钥唯一出现位置是 `:169` 的请求头组装。

## 8. 修改约束

- **适配器契约的四个符号必须齐备且签名不变**：`is_configured()`、`model_label()`、`prompt_meta()`、`stream()`（约定见 `backend/app/services/llm_service.py:11-13`）。门面以关键字参数逐个转发（`:92-99`、`:138-144`），改参数名会在运行时分派那一刻才 AttributeError。`max_tokens` / `extra_body` 虽然被忽略，**也必须留在签名里**，否则门面转发即 TypeError。
- **不得改回 `CloudBaseError`**：本文件必须抛 `llm_base.LlmError`（`:28`），这是 `c660727` 之后全链路统一的异常类型；路由层的 `isinstance` 判定（`backend/app/api/routes/ai.py:56`）与 s25/s26/s28/s30 的构造点都按现名硬编码，另立异常类会让 502 映射与既有断言静默失效。
- **不得恢复 `CLOUDBASE_TIMEOUT_SECONDS`**：该配置项在 `c660727` 被删除、`b712d81` 明确以两套供应商共用的 `LLM_TIMEOUT_SECONDS`（`backend/app/core/config.py:73`）取代（`:234`、`:272`）。恢复它会让「切换供应商只改一行 env」失效，并在 `Settings` 里留下无默认值的悬空项。
- **不得删 `CloudBaseStream` / `stream()`**：门面 `LlmStream` 只调 `_adapter().stream(...)`（`backend/app/services/llm_service.py:138`）。原版 `cloudbase_service.py` 只累积全文、不产出增量，**撑不起 `6a4dbb7` 的 SSE 逐字返回**——这正是本次恢复时新增流式的原因；把流式退回「累积后一次返回」会让 `POST /api/ai/chat/stream` 退化为一次性响应（前端逐字效果失效，且 s28 的「首片早于总耗时」断言不通过）。
- **`_consume_line` 的事件形态（`:103-110`）与请求体结构（`:153-160`）来自实测**，任何改动都需对真实 CloudBase 网关重新验证（s30 C 组用本地桩断言了请求体键集合、system 前缀拼接、只拼正文、`usage_update.used`、终态 `end_turn`）。
- **`_NORMAL_STOP_REASONS` 只能是 `("end_turn", "stop_sequence")`**（`:37`），与 openai 的 `("stop",)` 不可混用。
- **`_finish` 必须由流式与非流式共用**（`:215`、`:299`）：这是「两条路径结果同构」的实现点，分叉后截断/空回复校验会只在一侧生效。
- **不得 import 门面 `llm_service`**（循环 import）；不得引入 ORM / `Session`（本模块是无 DB 的纯外部客户端，分层约定见 `backend/AGENTS.md` §3.1）。
- **日志克制**：不得引入 URL、请求体、提示词全文、密钥（现有口径 `:125`、`:213`、`:244`、`:297`）。
- **系统提示不得改用未经核实的 ACP `system` 参数**（`:8`、`:174`），除非先对真实网关核实其行为。
- 本文件属 `backend/app/**`，改动后须按 `.qoder/README.md` §3.4 同步更新本文档并追加「迭代记录」。

## 9. 当前实现状态

### 已实现

- ACP 地址拼接与显式覆盖（`:64-75`）、Bearer + `Accept: text/event-stream` 鉴权头（`:163-170`）。
- SSE 流解析：正文累积与**增量产出**、用量捕获、终态识别、`[DONE]` 提前退出、坏片跳过（`:98-150`）。
- 状态码 → 中文提示映射与 `retryable` 分级（`:85-95`）；瞬时故障重试 + 线性退避（`:235-245`）。
- 截断拒绝与空回复拒绝（经 `_finish` → `ensure_complete`，`:186`）。
- 流式与非流式结果同构（共用 `_StreamState` 与 `_finish`）。
- **本地桩已实测**：s30 C 组 7 项 PASS（`backend/test/docs/s30-llm-provider-switch-report.md` §4「C cloudbase 适配器（本地桩）」行）——`path=/v1/aibot/bots/agt-stub-001/acp`、JSON-RPC `session/prompt`、system 前缀拼接为 `'系统提示\n\n用户问题'`、SSE 只拼 `agent_message_chunk`（思考/阶段事件忽略）、`usage_update.used=42`、终态 `stop=end_turn`、流式 4 片且与非流式正文一致、请求体不含 `max_tokens`/`extra_body`、`stopReason=max_tokens` 判为未正常结束、空正文可重试、显式 `AGENT_URL` 优先与留空拼接规则、401 文案不泄密钥。
- **真实链路已实测**（本次唯一跑通真实调用的供应商）：s30 D 组 3 项 PASS（同报告 §4「D 真实调用（cloudbase）」行）——非流式 `耗时=16.3s stop=end_turn used=254`（正文为史实正确的遵义会议说明）；流式 `分片=52 首片=8.6s 总耗时=10.3s 字数=149`；出题 `耗时=14.8s 题数=2 正文长度=553`，长输出 JSON 数组可解析（ACP 下未被截断）。回归 s26 L01 `reply_len=178 usedTokens=19832`、s28 L01 `分片数=90 首片=16.72s 总耗时=18.91s usedTokens=19400 stop_reason=end_turn`、L02 `分片数=105 字数=255 usedTokens=19641 落库一致=True`。

### 存在问题 / 限制

1. **首片延迟高，打字机体验明显退化**：`backend/test/docs/s30-llm-provider-switch-report.md` §2.2 对照表——CloudBase 首片 8.6s（s30 D02，52 片 / 总 10.3s，占比 83%）与 16.72s（s28 L01，90 片 / 总 18.91s，占比 88%），而百炼为 1.15s（36 片 / 3.53s，33%）与 2.81s（36 片 / 5.74s，49%）。原因是思考结束后正文才密集到达。这是「上线前切回 `openai`」的实测依据之一。
2. **`usage_update.used` 量级不稳，不可作单次计费依据**：同报告 §3——同一供应商、同量级提问下实测 254（s30 D01）/ 19400（s28 L01）/ 19641（s28 L02）/ 19832（s26 L01），量级差近 80 倍且集中在 1.9 万上下，疑似包含 Agent 侧知识库/会话的累计口径。真实含义——**待确认**。
3. **`max_tokens` / `extra_body` 静默失效**（§7 第 2 条）：`AI_MAX_OUTPUT_TOKENS` 与思考开关在本供应商下没有任何约束力，管理端配置中心调这两项不会生效。是否需要在管理端界面按供应商置灰——**待确认**。
4. **模块 docstring 的分片数说法与实测不一致**：`:11-12` 记「实测一次简短提问的正文只推 1 个 chunk，故小程序逐字效果主要由前端平滑动画承担」，而 `b712d81` 的 s30 D02 实测流式 **52 片**、s28 L01 实测 **90 片**（同报告 §2.2 表）。两处口径不一致（可能对应不同提问长度或不同 Agent 配置），孰为当前事实——**待确认**；本文档如实并列记录，不择一采信。
5. **`_http_error` 无 402 分支**：CloudBase 侧欠费/付费问题会落到「其他」分支，文案为「AI 服务返回异常状态码 402」，不如 openai 适配器的「账户余额不足，请充值后重试」明确（事实陈述）。
6. **无连接池复用**：`:196`、`:279` 每次调用新建 `httpx.Client`，高频调用下有重复 TLS 握手开销；当前由 AI 日限额兜底（`backend/app/services/ai_usage_service.py:35-42`）。
7. **失败调用无耗时数据**：`_finish` 只在成功路径调用（`:215`、`:299`），异常分支不产生 `elapsed_ms`，故 `ai_usage_logs.elapsed_ms` 对 `status='error'` 记录恒为 NULL。
8. **重试总耗时可超过前端超时**（跨端事实，与 openai 适配器同）：问答 `timeout` 取 `cfg.request_timeout`（env 默认 60，`backend/app/core/config.py:108`）+ 默认 1 次重试 → 最坏 ≈120.5 秒（`:234-235`、`:245`），而小程序 `chat` 请求超时 60 秒（`frontend/services/ai.js:41`）。ACP 首片本就 8~17s，该窗口更容易被触发。是否为预期取舍——**待确认**。
9. **终态帧之后的事件会被丢弃**：`:131-135` 与 `:118-120` 都置 `done`，随后 `break`（`:205-206`、`:290-291`）。按 `:103-110` 的实测形态这是安全的；若上游改变事件顺序（例如把 `usage_update` 放在终态帧之后），用量将丢失。
10. **ACP 的 `system` 参数与会话续接均未核实**（`:8`、`:14`）：前者导致只能前缀拼接，后者导致必须无状态多轮。
11. ~~**导航层与配置文档滞后**~~ **已修正（2026-10-22，同批文档提交）**：`.qoder/ARCHITECTURE.md` §11.1「外部集成」已重写为「门面 + 双适配器」口径，本协议的文件名与配置项名均已更正（`llm_cloudbase.py`、`CLOUDBASE_AGENT_URL`），并把四条跨供应商口径差异（地址拼接、system 前缀 + `max_tokens`/`extra_body` 静默失效、`used_tokens` 量级不稳、首片时延）写进正文；`.qoder/REQUIREMENTS.md` §10.2 已把 `CLOUDBASE_TIMEOUT_SECONDS` 替换为 `LLM_TIMEOUT_SECONDS`、§10.4 已改引 `ai_chat_service.py:138` 与本文件 `:173-175`；`.qoder/backend/app/core/config.py.md` 已按现行源码重锚行号并拆出 cloudbase 配置段；`.qoder/backend/app/services/ai_chat_service.py.md` 已全文改为 `LlmError` / `llm_service.model_label()` / `error_code="llm"` 口径。
12. **上线口径**：`backend/.env.prod:48-49` 就地标注「⚠⚠ 上线部署前必须把本行改为 `LLM_PROVIDER=openai`」，当前 `:50` 仍为 `cloudbase`；切换三步见 `backend/test/docs/s30-llm-provider-switch-report.md` §5.1（重置并替换 `.env.prod` 的 `LLM_API_KEY` → 改 `LLM_PROVIDER` 为 `openai` → 复跑 s30 含 D 组与 s25/s26/s28），无需改代码、无 SQL 迁移、无需重新构建前端。

## 10. 迭代记录

数据来源：`git log --oneline -- backend/app/services/llm_cloudbase.py`（**仅 1 个提交**，本文件在 git 中首次出现于 `b712d81`）与 `docs/迭代记录.md` 对应条目，按时间倒序。实现的**前身**是 `backend/app/services/cloudbase_service.py`（`ea58b6c` 创建 → `1600074` 重构 → `c660727` 被 `git mv` 成 `llm_service.py` 并重写为百炼实现，ACP 代码整块删除），见本节末「相关提交」。原文档 `.qoder/backend/app/services/cloudbase_service.py.md` 已随本次建档任务删除（源文件在 `c660727` 已不存在）。

### 2026-10-22（`b712d81`，见 `docs/迭代记录.md` 该提交条目）

- 需求：用户要求「把 AI key 切回之前那把，上线再用阿里这套」；经核实其指的是仓库里原有的**腾讯云 CloudBase Agent** 凭证。因 `c660727` 已删 ACP 实现、`6a4dbb7` 又在其上建成 SSE 流式，直接 revert 会连带杀掉流式功能，故改为两套供应商并存、`LLM_PROVIDER` 一行切换。
- 修改内容：**新建本文件（320 行）**，ACP 实现从 `c660727^` 的 `cloudbase_service.py` 恢复，并做**四处刻意改动**：
  1. 抛 `LlmError` 而非 `CloudBaseError`（`:28` import 自 `llm_base`），与另一条链路统一异常类型；
  2. 返回 `llm_base.CallResult` 而非模块内自定义的同名 dataclass（原 `CallResult` 定义随之下沉到 `llm_base`）；
  3. 超时改用两套供应商共用的 `settings.LLM_TIMEOUT_SECONDS`（`:234`、`:272`），**`CLOUDBASE_TIMEOUT_SECONDS` 不再存在、不恢复**；
  4. **新增 `CloudBaseStream`（`:250-299`）与模块级 `stream()` 工厂（`:302-320`）**——旧版只累积全文、不产出增量，撑不起 `6a4dbb7` 的 SSE 逐字返回；为此把 `_consume_line` 的返回值由 `None` 改为「本次新增的正文片段」（`:101`、`:144`），并把截断/空回复校验收敛到共用的 `_finish`（`:178-187`）。
  另外新增适配器契约要求的 `is_configured()`（`:50-56`）与 `model_label()`（`:59-61`）；`prompt_meta` 签名扩为与门面一致的 6 参数形式，其中 `max_tokens` / `extra_body` 显式忽略（`:230`）。
- 关联文件：`backend/app/services/llm_base.py`（新建）、`llm_openai.py`（新建，原实现迁入）、`llm_service.py`（重写为门面）、`backend/app/core/config.py`（`LLM_PROVIDER`、`LLM_TIMEOUT_SECONDS` 与 `CLOUDBASE_*` 配置段）、`ai_chat_service.py` / `routes/ai.py` / `models.py`（`model=` 改取 `model_label()`）、`backend/.env` 与 `.env.prod`（两套凭证常驻，当前 `cloudbase`）、新增 `backend/test/s30_llm_provider_switch.py` 与报告、s25/s26/s28 provider 感知化、`backend/design.md` §2 服务表。
- 测试结果：据 `docs/迭代记录.md` 的 `b712d81` 条目——**s30 23/23 PASS**：A 组含「`cloudbase` 下 `model_label()` 等于 `CLOUDBASE_AGENT_ID`」（`backend/test/s30_llm_provider_switch.py:228-231`）、「缺 `CLOUDBASE_API_KEY` 时在发请求前就抛错」（`:250-255`）；C 组 7 项本地桩全通过；**D 组 3 项真实调用全通过**（本次唯一跑通真实链路的供应商，明细见 §9「已实现」末条）。回归 **s25 16/16**、**s26 47/47**（L01 `reply_len=178 usedTokens=19832`）、**s28 13/13**（L01 `分片数=90 首片=16.72s stop_reason=end_turn`；同条目备注①记 s28 L01 原写死 `stop_reason=="stop"` 与「首片早于总耗时 80%」，已改为按供应商取 `end_turn` / 0.95）。桩服务器为本地 `ThreadingHTTPServer` 同时模拟两协议、离线可重复，`LM_AI_SKIP_LIVE=1` 可跳 D 组。报告 `backend/test/docs/s30-llm-provider-switch-report.md`。

### 相关但不改本文件的提交（供追溯实现来源）

- `c660727`（2026-10-19）：`cloudbase_service.py` → `llm_service.py` 更名重写为百炼实现，逐行解析 SSE 拼接 `agent_message_chunk` 的 `_StreamState` / `_consume_line`（约 45 行）**整块删除**——即本文件所恢复的那部分代码被删的提交。
- `1600074`（2026-10-17）：AI 智能中心 Phase A，在 `cloudbase_service.py` 内拆出 `_request_once` + `prompt_meta`，新增 `CallResult` / `_StreamState` / `retryable` 与重试退避（本文件这些结构的直接来源）。验证记 s26 47/47，含真实 Agent 调用 L01 `reply 143 字、usedTokens=19715`。
- `ea58b6c`（2026-10-16）：题库接入 CloudBase Agent AI 出题，创建 `cloudbase_service.py`，封装 ACP 协议调用（JSON-RPC `session/prompt` + SSE，累积 `agent_message_chunk` 文本、`stopReason` 终止）；当时对外只有 `prompt(text, timeout) -> str`。
- `37f3e40`（2026-10-17）：`backend/.env` / `.env.prod` 新增 `CLOUDBASE_ENV_ID/AGENT_ID/API_KEY/AGENT_URL` 等配置项，供本文件读取（值不入文档）。
