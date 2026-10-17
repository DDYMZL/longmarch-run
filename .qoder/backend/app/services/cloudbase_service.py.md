# cloudbase_service.py

## 1. 文件路径

`backend/app/services/cloudbase_service.py`（228 行）

## 2. 文件职责

腾讯云 CloudBase Agent 的 **ACP 协议调用封装**，全项目唯一与 AI 网关通信的出口。职责单一（`backend/app/services/cloudbase_service.py:3`）：发一次提示词、收完整文本回复——以 JSON-RPC 2.0 调 `session/prompt`，解析 SSE 事件流，只拼接 `agent_message_chunk` 的正文并忽略思考过程，同时捕获平台报告的 `usage_update.used` 用量与终态 `stopReason`，供上层写入 `ai_usage_logs`（`backend/app/services/cloudbase_service.py:1-11`）。

本文件**不接触数据库**（无 `Session` 参数、无任何 ORM import，`backend/app/services/cloudbase_service.py:12-20`），是纯粹的外部 HTTP 客户端 + 流解析层。

对外暴露 4 个符号：`CloudBaseError`（`backend/app/services/cloudbase_service.py:31`）、`CallResult`（`backend/app/services/cloudbase_service.py:44`）、`prompt_meta`（`backend/app/services/cloudbase_service.py:192`）、兼容包装 `prompt`（`backend/app/services/cloudbase_service.py:223`）。

## 3. 业务需求

- **`ea58b6c`（2026-10-16 23:19）创建本文件**：题库接入 CloudBase Agent AI 出题，「`services/cloudbase_service.py` 封装腾讯云 CloudBase Agent 的 ACP 协议调用（JSON-RPC `session/prompt` + SSE，累积 `agent_message_chunk` 文本、`stopReason` 终止）」（`docs/迭代记录.md:53` 条目原文）。
- **`1600074`（2026-10-17 11:06）重构为可复用调用层**：AI 智能中心 Phase A 需要把用量与耗时带回给上层落库，故拆出 `_request_once` + `prompt_meta`，新增 `CallResult`/`_StreamState`/`retryable` 与重试退避（据 `git show 1600074 -- backend/app/services/cloudbase_service.py`，132 增 47 删）。
- 导航层出处（本文档只回指、不复制正文）：`.qoder/ARCHITECTURE.md` §11.1「外部集成」、`.qoder/REQUIREMENTS.md` §10.4「多轮对话实现方式」、配置项清单见 `.qoder/backend/app/core/config.py.md` §5「腾讯云 CloudBase Agent」。
- **安全需求**（`backend/app/services/cloudbase_service.py:10`）：API Key 仅在本模块内组装到请求头，不写日志、不进异常消息、不下发前端；`backend/app/core/config.py:67` 有同义约束注释。
- 上游需求书为《长征步迹 AI 智能中心开发需求 V1.0》（按 §13 分阶段，Phase A = 后端全做 + 小程序聊天页）。**该需求文档本身未入库**（`docs/` 下无此文件，实测 `ls docs/` 仅 8 份文档），条目内容以 `docs/迭代记录.md:31`、`backend/test/docs/s26-ai-center-report.md:4` 的转述为准，原始需求文本措辞**待确认**。本文件属传输层，需求书未对其单独提出条目。

## 4. 核心功能

### 4.1 模块常量（`backend/app/services/cloudbase_service.py:24-28`）

| 常量 | 行号 | 值 / 含义 |
|---|---|---|
| `_ACP_PATH` | `:25` | `"/v1/aibot/bots/{agent_id}/acp"`；`:24` 注释说明网关会自动建会话，**因此无需先调 `session/new` 传 sessionId** |
| `_STREAM_DONE` | `:26` | `"[DONE]"`，SSE 流结束哨兵 |
| `_NORMAL_STOP_REASONS` | `:28` | `("end_turn", "stop_sequence")`；`:27` 注释：其余取值（如 `max_tokens`）意味着回复被截断，**JSON 必然不完整** |

### 4.2 `CloudBaseError(ValueError)`（`backend/app/services/cloudbase_service.py:31-41`）

- 继承 `ValueError`，`:33-34` docstring 明确「继承 ValueError 以便路由层统一转换，但**需先于 ValueError 捕获**以映射为 502」。
- `__init__(message, *, retryable=False)`（`:39-41`）：`retryable` 为**仅限关键字**参数。
- `:35-36` docstring 给出可重试判定口径：`retryable=True` 表示瞬时故障（超时 / 5xx / 429 / 网络 / 空回复）；配置缺失、鉴权失败、回复截断等重试无益，标记为不可重试。

### 4.3 `CallResult` dataclass（`backend/app/services/cloudbase_service.py:44-55`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `text` | `str` | 无（必填） | 拼接并 strip 后的完整正文（`:181`） |
| `used_tokens` | `Optional[int]` | `None` | 平台 `usage_update.used` **原值**；`:47-48` docstring 明确「含义未核实为精确计费口径，如实记录不换算」，平台未报告时为 `None` |
| `stop_reason` | `str` | `""` | 终态帧的 `stopReason` |
| `elapsed_ms` | `int` | `0` | 本次 HTTP 往返耗时（`:49` docstring） |

### 4.4 `_StreamState` dataclass（`backend/app/services/cloudbase_service.py:58-65`）

SSE 消费过程的累积状态：`chunks: List[str]`、`used_tokens: Optional[int]`、`stop_reason: str`、`done: bool`。

### 4.5 `_resolve_url()`（`backend/app/services/cloudbase_service.py:68-79`）——ACP 地址拼接规则

1. `settings.CLOUDBASE_AGENT_URL.strip()` 非空 → **直接返回该显式地址**（`:70-72`）。
2. 否则读 `settings.CLOUDBASE_ENV_ID` 与 `settings.CLOUDBASE_AGENT_ID`（均 strip，`:73-74`）；任一为空 → 抛**不可重试** `CloudBaseError`，detail「AI 服务未配置，请在后端环境变量中设置 CLOUDBASE_ENV_ID 与 CLOUDBASE_AGENT_ID」（`:75-78`）。
3. 拼接（`:79`）：`https://{env_id}.api.tcloudbasegateway.com` + `_ACP_PATH.format(agent_id=agent_id)`，即 `https://{ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/{AGENT_ID}/acp`。与 `backend/app/core/config.py:71` 的注释口径一致。

> **文档滞后提示**：`.qoder/ARCHITECTURE.md` §11.1 两处把该配置项写作 `CLOUDBASE_ACP_URL`，代码与配置定义中的真名是 **`CLOUDBASE_AGENT_URL`**（`backend/app/core/config.py:72`）。以代码为准。

### 4.6 `_http_error(status_code)`（`backend/app/services/cloudbase_service.py:82-92`）

把上游 HTTP 状态码翻译成面向用户的中文提示（`:83` docstring：不暴露密钥与内部细节）。**返回值类型是 `CloudBaseError` 实例而非字符串**（`ea58b6c` 时返回 `str`，`1600074` 改为返回异常对象，据该提交 diff）。

| 状态码 | detail 文案 | `retryable` | 行号 |
|---|---|---|---|
| 401 / 403 | AI 服务鉴权失败，请检查 CLOUDBASE_API_KEY 是否有效 | False | `:84-85` |
| 404 | AI 服务地址或 Agent ID 不正确 | False | `:86-87` |
| 429 | AI 服务请求过于频繁，请稍后重试 | **True** | `:88-89` |
| ≥ 500 | AI 服务暂时不可用，请稍后重试 | **True** | `:90-91` |
| 其他 | AI 服务返回异常状态码 {status_code} | False | `:92` |

### 4.7 `_consume_line(line, state)`（`backend/app/services/cloudbase_service.py:95-138`）——SSE 单行解析

`:98-104` docstring 记录了 **4 种实测事件形态**（正文分片 / `usage_update` 用量 / 终态帧 / `[DONE]`），这是真实调用留痕而非推测；`:105` 说明 `agent_thought_chunk`（思考过程）与 `agent_phase` 均不属于正文，直接忽略。

解析顺序：

1. `line.strip()` 后不以 `data:` 开头 → return（`:107-109`）。
2. 去掉 `data:` 前缀再 strip；空载荷 → return（`:110-112`）。
3. 载荷等于 `[DONE]` → `state.done = True` 并 return（`:113-115`）。
4. `json.loads` 失败 → **静默 return**，不抛错（`:116-119`）；解析结果非 `dict` → return（`:120-121`）。
5. `event["error"]` 真值 → 抛**可重试** `CloudBaseError`「AI 服务返回错误，请重试」（`:122-123`）。
6. `event["result"]` 是 `dict`（终态帧）→ 写 `state.stop_reason` 并置 `state.done = True`，return（`:124-128`）。**截断判定不在这里做**，移到 `_request_once` 读完流之后（`:177-180`）。
7. `params.update.sessionUpdate == "agent_message_chunk"` 且 `content.type == "text"` → 追加 `content.text`（缺省空串）到 `state.chunks`（`:129-134`）。
8. `== "usage_update"` 且 `used` 是 `int` → 写 `state.used_tokens`（`:135-138`）。

### 4.8 `_request_once(text, timeout)`（`backend/app/services/cloudbase_service.py:141-189`）

- **每次调用都重新解析地址**（`:143`），不缓存 URL。
- 请求体（`:144-149`）：`{"jsonrpc": "2.0", "id": 1, "method": "session/prompt", "params": {"prompt": [{"type": "text", "text": text}]}}`。`id` **恒为 1**、不递增；**不传 sessionId**（依据 `:24` 注释）。
- 请求头（`:150-155`）：
  - `Content-Type: application/json; charset=utf-8`——`:151` 注释：显式声明 charset，避免中文提示词被上游按其他编码解释；
  - `Accept: text/event-stream`；
  - `Authorization: Bearer {settings.CLOUDBASE_API_KEY.strip()}`（`:154`）——**密钥在本文件内唯一被使用的位置**。
- 传输：`httpx.Client(timeout=timeout)` 同步客户端 + `client.stream("POST", url, json=body, headers=headers)`（`:159-160`）。`timeout` 原样透传给 httpx，即按 httpx 语义同时作用于连接/读/写/池。
- 非 200：先 `response.read()`（排空响应体，避免连接复用异常）再抛 `_http_error(status_code)`（`:161-163`）。
- 读流：逐行 `response.iter_lines()` 喂 `_consume_line`，一旦 `state.done` 立即 `break`（`:164-167`）——**不读完整个流**。
- 异常处理顺序（`:168-175`）：
  1. `CloudBaseError` → 原样上抛（`:168-169`）；
  2. `httpx.TimeoutException` → 可重试「AI 生成超时，请稍后重试」（`:170-171`）；
  3. `httpx.HTTPError` → 只把 `exc.__class__.__name__` 写 warning 日志（`:173` 注释：避免把 URL/请求细节写进日志），抛可重试「AI 服务请求失败，请检查服务器网络后重试」（`:172-175`）。
- 耗时：`time.monotonic()` 起止（`:157`、`:176`），**覆盖整个 SSE 读流过程**；异常分支不会走到 `:176`，因此失败调用拿不到 `elapsed_ms`。
- 截断校验（`:177-180`）：`stop_reason` 非空且不在 `_NORMAL_STOP_REASONS` → 抛**不可重试** `CloudBaseError`「AI 回复未正常结束（{stop_reason}），请减少单次生成数量后重试」。detail 中回显了上游 `stopReason` 原文（英文枚举值，非敏感）。
- 空回复校验（`:181-183`）：`"".join(state.chunks).strip()` 为空 → 抛**可重试** `CloudBaseError`「AI 服务返回空内容，请重试」。
- 成功返回 `CallResult(text, used_tokens, stop_reason, elapsed_ms)`（`:184-189`）。

### 4.9 `prompt_meta(text, *, system=None, timeout=None, max_retries=None)`（`backend/app/services/cloudbase_service.py:192-220`）

对外主入口，`system`/`timeout`/`max_retries` 三个参数**均为仅限关键字**（`:194` 的 `*`）。

1. **API Key 前置校验**（`:204-205`）：`settings.CLOUDBASE_API_KEY.strip()` 为空即抛不可重试 `CloudBaseError`「AI 服务未配置，请在后端环境变量中设置 CLOUDBASE_API_KEY」。此校验**先于** `_resolve_url()` 的 ENV_ID/AGENT_ID 校验发生。
2. **系统提示注入方式**（`:206`）：`f"{system.strip()}\n\n{text}"`，即「系统提示 + 空行 + 用户输入」的**前缀拼接**；`system` 为 `None` 或 strip 后为空则原样使用 `text`。`:8` 注释说明这是刻意选择——「不使用未经核实的 ACP 参数」。
3. **超时**（`:207`）：`effective_timeout = timeout or settings.CLOUDBASE_TIMEOUT_SECONDS`（env 默认 180，`backend/app/core/config.py:73`，注释「单批调用超时（秒）」）。注意 `or` 语义：显式传 `0` 会回落到默认值。
4. **重试次数**（`:208`）：`attempts = 1 + max(0, settings.AI_MAX_RETRIES if max_retries is None else max_retries)`。缺省取 `AI_MAX_RETRIES`（env 默认 1，`backend/app/core/config.py:89`；管理端可在 0~3 范围内覆盖，`backend/app/services/ai_config_service.py:52`）；负数被 `max(0, ...)` 夹到 0。即**默认共尝试 2 次**（1 次原始 + 1 次重试）。
5. **重试循环**（`:210-218`）：`_request_once` 成功立即 `return`；捕获 `CloudBaseError` 后，**不可重试 或 已是最后一次尝试 → 直接 `raise`**（`:214-215`）；否则记一条 info 日志（`:217`，第 3 个格式化参数是**固定字符串 `"transient"`**，不含异常消息）并 `time.sleep(0.5 * (attempt + 1))` 退避（`:218`）：第 1 次重试前睡 0.5s，第 2 次前 1.0s，第 3 次前 1.5s（线性退避，无抖动）。
6. `:219-220` 是 `# 理论不可达：循环内要么 return 要么 raise` 的兜底 `raise last_error or CloudBaseError(...)`。

> **阻塞提示**：`time.sleep` 与 `httpx.Client` 都是**同步阻塞**调用，运行在 FastAPI 同步 `def` 路由的线程池线程内（`backend/AGENTS.md` §2 约定「同步 `def` 路由即可」）。重试等待期间会占用一个 worker 线程。

### 4.10 `prompt(text, timeout=None)`（`backend/app/services/cloudbase_service.py:223-228`）

- 向后兼容包装：`return prompt_meta(text, timeout=timeout).text`（`:228`）。`:224` docstring 标注「向后兼容出题链路」。
- **不接受 `system`、不接受 `max_retries`** → 走此入口的调用固定使用 `AI_MAX_RETRIES` 缺省重试次数，且**无系统提示前缀**（出题链路的角色约束直接写在提示词正文里，`backend/app/services/ai_question_service.py:60` 的 `_build_prompt`）。
- `timeout` 在此为**位置参数**（与 `prompt_meta` 的仅限关键字不同）。
- 唯一调用方：`backend/app/services/ai_question_service.py:204-206`（AI 出题分批生成）。
- `prompt` 内部通过模块全局名调用 `prompt_meta`，因此测试中 `cloudbase_service.prompt_meta = _fake` 的打桩对 `prompt` 同样生效（`backend/test/s26_ai_center.py:115-131` 即依赖此行为）。

## 5. 输入与输出

### 5.1 `prompt_meta` 参数与返回

| 参数 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `text` | `str` | 必填（位置参数） | 用户侧提示词正文；**不做长度校验**，长度控制由上层负责（`backend/app/services/ai_chat_service.py:196-197` 校验 `max_input_chars`） |
| `system` | `Optional[str]` | `None`（keyword-only） | 系统提示；非空时前缀拼接（`:206`） |
| `timeout` | `Optional[float]` | `None`（keyword-only） | 秒；`None` 或 `0` 回落到 `CLOUDBASE_TIMEOUT_SECONDS`（`:207`） |
| `max_retries` | `Optional[int]` | `None`（keyword-only） | `None` 时取 `settings.AI_MAX_RETRIES`（`:208`） |

返回 `CallResult`（见 §4.3）。

### 5.2 异常与对外状态码

本模块**只抛 `CloudBaseError`**（`ValueError` 子类），无自定义错误码字段；`retryable` 属性只影响本模块是否重试，不对外暴露。HTTP 状态码由调用方映射：

| 调用方 | 映射 | 行号 |
|---|---|---|
| `backend/app/api/routes/ai.py` | `ai_http_error` 内 `isinstance` 判定 → **502** | `backend/app/api/routes/ai.py:48-49` |
| `backend/app/api/routes/admin.py` | `except cloudbase_service.CloudBaseError` → **502**（`:518` 注释：先于 ValueError 捕获） | `backend/app/api/routes/admin.py:517-519` |
| `backend/app/api/routes/ai_admin.py` | 复用 `AI_ERRORS` + `ai_http_error` → **502** | `backend/app/api/routes/ai_admin.py:15`、`:224-225` |

detail 文案**原样透传到小程序与管理后台**，因此所有 detail 都写成面向终端用户的中文（§4.6、§4.8）。

### 5.3 上游契约（出站）

- 协议：HTTPS POST，JSON-RPC 2.0 `session/prompt`，响应 `text/event-stream`。
- 鉴权：`Authorization: Bearer <CLOUDBASE_API_KEY>`（`:154`）。
- 期望的 SSE 事件形态见 `:98-104`（实测记录）。

## 6. 依赖关系

### 6.1 依赖

- 第三方：`httpx`（`backend/app/services/cloudbase_service.py:18`，同步客户端 + `stream`）。
- 标准库：`json`、`logging`、`time`、`dataclasses.dataclass/field`、`typing.List/Optional`（`:12-16`）。
- 配置：`from app.core.config import settings`（`:20`），读取 6 个配置项——
  | 配置项 | 引用行 | 定义 |
  |---|---|---|
  | `CLOUDBASE_AGENT_URL` | `:70` | `backend/app/core/config.py:72` |
  | `CLOUDBASE_ENV_ID` | `:73` | `backend/app/core/config.py:68` |
  | `CLOUDBASE_AGENT_ID` | `:74` | `backend/app/core/config.py:69` |
  | `CLOUDBASE_API_KEY` | `:154`、`:204` | `backend/app/core/config.py:70` |
  | `CLOUDBASE_TIMEOUT_SECONDS` | `:207` | `backend/app/core/config.py:73` |
  | `AI_MAX_RETRIES` | `:208` | `backend/app/core/config.py:89` |
- 外部服务：腾讯云 CloudBase Agent 网关（域名由 `_resolve_url()` 拼接，`:79`）。
- **数据库表：无**（本模块不 import 任何 ORM 模型，也不接收 `Session`）。

### 6.2 被谁依赖（backend/app 内 4 个文件）

| 文件 | 用到的符号 | 行号 |
|---|---|---|
| `backend/app/services/ai_chat_service.py` | `prompt_meta`（历史助手对话、答题解析）、`CloudBaseError`（捕获后回滚+记 error 日志） | import `:34`；调用 `:233`、`:384`；捕获 `:239`、`:390` |
| `backend/app/services/ai_question_service.py` | `prompt`（分批出题）、`CloudBaseError`（类型保留以映射 502） | import `:22`；调用 `:204-206`；`:324` 注释 |
| `backend/app/api/routes/ai.py` | **仅** `CloudBaseError`（异常映射，不发起调用） | import `:28`；`AI_ERRORS` `:37`；`ai_http_error` `:48-49` |
| `backend/app/api/routes/admin.py` | **仅** `CloudBaseError` | import `:87`；捕获 `:517` |

调用链（route → service → 本模块 → 外部）：

```text
POST /api/ai/chat              → routes/ai.py:53-65      → ai_chat_service.send_message:233      → prompt_meta → CloudBase Agent
GET  /api/ai/quiz-explanation/* → routes/ai.py:126-141    → ai_chat_service.quiz_explanation:384  → prompt_meta → CloudBase Agent
POST /api/admin/ai/generate-questions → routes/admin.py:505-521 → ai_question_service._generate_batch:204 → prompt → CloudBase Agent
POST /api/admin/ai/jobs         → routes/ai_admin.py:200-225 → ai_question_service（同上一链路）
GET  /api/ai/route-guide/*      → routes/ai.py:113-123    → ai_chat_service.route_guide          → **不调用本模块**
```

### 6.3 测试覆盖

- `backend/test/s25_ai_question_generate.py`：`:68` import；`:122-133` 以 monkeypatch 替换 `cloudbase_service.prompt`（保存原值、用后还原）；`:237-240` 构造 4 类 `CloudBaseError`（超时/鉴权失败/服务不可用/回复截断）断言路由返回 502 且 detail 含预期关键词。
- `backend/test/s26_ai_center.py`：`:72` import；`:115-131` 打桩 `prompt_meta` 返回固定 `CallResult`；`:136-150` 打桩 `prompt`；`:407`、`:634` 构造 `retryable=True` 的 `CloudBaseError` 验证 502（H11 / G 组）。
- 测试体系总览见 `.qoder/backend/test/README.md`（`s26` 条目记「47/47 通过（含真实 Agent）」）。
- **打桩约定**：两个脚本都直接替换模块属性，因此这两个函数不得改为在模块内绑定局部别名后调用，否则打桩失效。

## 7. 业务规则

- **无状态多轮**：`:7` 注释明确「多轮对话不依赖网关会话续接（**未验证**），由上层把最近历史拼进单次提示词（无状态）」。本模块每次调用都是独立 HTTP 请求，不缓存 sessionId、不复用连接（`with httpx.Client(...)` 每次新建，`:159`）。历史的拼接责任在 `backend/app/services/ai_chat_service.py:133-148`（`_history_block`）。
- **系统提示只做前缀拼接**（`:8`、`:206`），不使用未经核实的 ACP 参数——这是刻意的保守选择，改动前需对真实网关重新核实。
- **只取正文**：`agent_thought_chunk`（思考过程）、`agent_phase` 一律忽略（`:105`），思考过程不落库、不下发前端。
- **截断即失败，绝不返回半截文本**：`stopReason` 非 `end_turn`/`stop_sequence` → 抛错（`:177-180`）。对 AI 出题链路尤其关键（`:27` 注释：截断后 JSON 必然不完整）。
- **空回复视为瞬时故障并重试**（`:181-183`，`retryable=True`）。
- **重试仅限 `retryable`**：配置缺失（`:76`、`:205`）、鉴权失败 401/403（`:85`）、404（`:87`）、未知状态码（`:92`）、回复截断（`:178`）**不重试**；超时（`:171`）、网络错误（`:175`）、429（`:89`）、5xx（`:91`）、SSE error 帧（`:123`）、空回复（`:183`）**重试**。
- **用量口径不换算**：`used_tokens` 是平台 `usage_update.used` 原值（`:47-48`、`:135-138`），上层原样写入 `ai_messages.used_tokens`（`backend/app/services/ai_chat_service.py:254`）与 `ai_usage_logs.used_tokens`（`backend/app/services/ai_chat_service.py:260`、`:402`）。
- **密钥安全**：`:10`（模块约定）、`:83`（错误文案不含内部细节）、`:174`（日志只记异常类名）、`:217`（重试日志只记固定字符串）。密钥唯一出现位置是 `:154` 的请求头组装。

## 8. 修改约束

- **异常 detail 会直达终端用户**（§5.2），不得把 URL、请求体、响应体、密钥、堆栈写进 detail；`:83` 与 `:10` 是明文约束。当前唯一回显上游内部值的位置是 `:179` 的 `stopReason`（英文枚举，非敏感），扩展时勿引入更多。
- **日志不得引入 URL / 密钥 / 提示词全文**：`:173-174`、`:217` 是现有口径，新增日志须遵循同样克制。
- **`CloudBaseError` 必须继续继承 `ValueError`**：`:33-34` docstring 是明文要求。当前 3 个路由调用点都显式列出了 `CloudBaseError`（`backend/app/api/routes/ai.py:37`、`backend/app/api/routes/admin.py:517`、`backend/app/api/routes/ai_admin.py:15`），但继承关系是「未来新增调用点只写 `except ValueError` 也能兜住上游故障」的保险；改基类会让这类调用点把 502 误报成 400。
- **`prompt(text, timeout)` 的签名是既有契约**：`backend/app/services/ai_question_service.py:204` 以位置参数调用。新增能力应扩展 `prompt_meta`，不要把 `prompt` 改成仅限关键字或移除。
- **`retryable` 是仅限关键字参数**（`:39`），测试脚本以 `CloudBaseError(msg, retryable=True)` 形式构造（`backend/test/s26_ai_center.py:407`、`:634`），改为位置参数会破坏调用点语义。
- **超时口径不要混用**：`CLOUDBASE_TIMEOUT_SECONDS`（默认 180）是 **AI 出题单批**的口径（`backend/app/core/config.py:73` 注释）；AI 问答/答题解析走管理端可配的 `ai_request_timeout`（env 默认 60，`backend/app/core/config.py:88`），由 `backend/app/services/ai_chat_service.py:236`、`:387` 显式传入 `timeout=cfg.request_timeout`。把 180 当成问答超时会导致前端先断开（见 §9 第 1 条）。
- **请求体结构（`:144-149`）与 SSE 事件形态（`:98-104`）来自实测**，任何改动都需对真实 CloudBase 网关重新验证；`.qoder/ARCHITECTURE.md` §11.3 记录「小程序真机真实 Agent 全链路**待验证**（本机 DNS 劫持限制）」。真实调用的网络前置条件见 `.qoder/backend/test/README.md` 的 `dns_shim.py` 条目。
- **本模块不得引入数据库依赖**：分层约定 `api/routes -> api/deps -> services -> models + core`（`backend/AGENTS.md` §3.1），但本服务被设计为无 DB 的纯外部客户端，用量落库由 `backend/app/services/ai_usage_service.py` 承担；在此处 import ORM 会把外部调用与事务边界耦合。
- 本文件属 `backend/app/**`，改动后须按 `.qoder/README.md` §3.4 同步更新本文档的「核心功能/业务规则/当前实现状态」并追加「迭代记录」。

## 9. 当前实现状态

### 9.1 已实现（事实陈述，均有行号依据）

- ACP 地址拼接与显式覆盖（`:68-79`）、Bearer 鉴权头（`:154`）。
- SSE 流解析：正文累积、用量捕获、终态识别、`[DONE]` 提前退出（`:95-138`、`:164-167`）。
- 状态码 → 中文提示映射与 `retryable` 分级（`:82-92`）。
- 瞬时故障重试 + 线性退避（`:208-218`）。
- 截断拒绝（`:177-180`）、空回复拒绝（`:181-183`）。
- 密钥不外泄的三处防线（`:83`、`:174`、`:217`）。
- 向后兼容入口 `prompt`（`:223-228`）。
- **真实链路已验证**（非推断）：`docs/迭代记录.md:31`（`1600074`）记 s26 冒烟 47/47，「含真实 Agent 调用 L01：reply 143 字、usedTokens=19715」；`docs/迭代记录.md:21`（`1fbacac`）记 VPN 关闭后重跑 s26 全量 47/47，「L01 真实 Agent 原生网络直达（reply 163 字、usedTokens=19989）」。这两条同时证明 `agent_message_chunk` 与 `usage_update.used` 的事件形态（`:98-104`）确为实测。

### 9.2 存在问题 / 已知限制

1. **后端重试总耗时可超过前端超时**（跨端事实）：AI 问答的 `timeout` 取 `cfg.request_timeout`（env 默认 60 秒，`backend/app/core/config.py:88`），`max_retries` 取 `cfg.max_retries`（env 默认 1，`:89`），最坏情况 ≈ 60 + 0.5 + 60 = **120.5 秒**（`:208`、`:218`）；而小程序 chat 请求超时为 **60 秒**（`frontend/services/ai.js:23`）。即前端会先超时报错，后端仍可能重试成功并写入 `ai_messages` 与 `ai_usage_logs` 成功记录（`backend/app/services/ai_chat_service.py:249-263`），造成「前端显示失败、后端已扣当日额度」。是否为预期取舍——**待确认**。
2. **失败调用无耗时数据**：`elapsed_ms` 只在成功路径计算（`:176`），异常分支不经过该行；上层 error 日志也显式传 `None`（`backend/app/services/ai_chat_service.py:243`）或不传（`:392-395`），因此 `ai_usage_logs.elapsed_ms` 对所有 `status='error'` 记录恒为 NULL，无法统计失败耗时分布。
3. **`last_error` 属冗余赋值**：`:209` 声明、`:216` 赋值，但只被 `:219-220` 的兜底分支读取，而 `:219` 注释已自认该分支「理论不可达」。不影响功能（事实陈述，非缺陷判定）。
4. **无连接池复用**：`:159` 每次调用新建 `httpx.Client`，高频调用下有重复 TLS 握手开销。当前由 AI 日限额兜底（`backend/app/services/ai_usage_service.py:35-42`），量级有限。
5. **终态帧之后的事件会被丢弃**：`:127` 与 `:114` 都会置 `done`，`:166-167` 随即 break。按 `:98-104` 的实测形态这是安全的；若上游改变事件顺序（例如把 `usage_update` 放在终态帧之后），用量将丢失。
6. **AI 接口无 IP 维度限流**：`backend/app/api/routes/ai.py` 未使用 `backend/app/core/rate_limit.py`（该文件只定义 `login_limiter`/`qr_create_limiter`/`qr_poll_limiter`/`invite_limiter` 4 个实例，`backend/app/core/rate_limit.py:31-35`）。AI 侧的频控是另一套**按用户的日调用额度**（`backend/app/services/ai_usage_service.py:35-42`，路由映射 429 见 `backend/app/api/routes/ai.py:46-47`）。详见 `.qoder/backend/app/core/rate_limit.py.md` §6 与 `.qoder/ARCHITECTURE.md` §10.1。
7. **导航层文档名称滞后**：`.qoder/ARCHITECTURE.md` §11.1 写作 `CLOUDBASE_ACP_URL`，代码真名为 `CLOUDBASE_AGENT_URL`（`backend/app/core/config.py:72`）。
8. **测试脚本内有一处过期文案**：`backend/test/s25_ai_question_generate.py:237` 构造的 `CloudBaseError("AI 生成超时，请减少数量或稍后重试")` 用的是 `1600074` 之前的旧文案（现为「AI 生成超时，请稍后重试」，`:171`）。该用例断言的是路由 502 与 detail 含「超时」，**仍然通过**，只是构造文案与生产实际不再一致（事实陈述）。

### 9.3 待开发

- 本模块无待开发项：Phase A 已交付（`.qoder/ARCHITECTURE.md` §11.2）。
- `.qoder/ARCHITECTURE.md` §11.3 所列的「管理后台 5 个 AI 子页面、node-detail 讲解面板、答题页 AI 讲解按钮、usage/cost 统计页」均为**待开发**，但它们不影响本文件——本文件只是被调用的传输层。
- **真机（非模拟器）真实 Agent 链路待验证**（`docs/迭代记录.md:21` 的「待验证」字段原文）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/services/cloudbase_service.py`（**2 个提交**）与 `docs/迭代记录.md` 对应条目，按时间倒序。工作区当前无本文件的未提交改动（`git status --short backend/app/services/` 为空）。

### 2026-10-17（`1600074`，`docs/迭代记录.md:31`）

- 需求：AI 智能中心 Phase A（§3.1 历史助手 / §3.2 路线节点讲解 / §3.3 答题解析 / §3.4 管理端接口）需要把模型用量与耗时带回上层落 `ai_usage_logs`，并对上游瞬时故障做可控重试。
- 修改内容（涉本文件，据 `git show 1600074 -- backend/app/services/cloudbase_service.py` 核实，132 增 47 删）：
  - 模块 docstring 扩写：新增「捕获 `usage_update.used` 用量与终态 `stopReason`」「多轮对话不依赖网关会话续接（未验证）」「系统提示以前缀拼接注入」三段（`:1-11`）；
  - `CloudBaseError` 新增 `__init__(message, *, retryable=False)`（`:39-41`）与 docstring 的可重试口径（`:35-36`）；
  - 新增 `CallResult`（`:44-55`）与 `_StreamState`（`:58-65`）两个 dataclass；
  - `_http_error` 返回类型由 `str` 改为 `CloudBaseError`，429 与 ≥500 标记 `retryable=True`，docstring 由「面向管理员」改为「面向用户」（`:82-92`）；
  - `_consume_line` 签名由 `(line, chunks) -> bool` 改为 `(line, state) -> None`，新增 `usage_update.used` 捕获（`:135-138`），并把 `stopReason` 截断判定从行内移到 `_request_once` 读完流之后（`:177-180`）；
  - 原 `prompt()` 拆为 `_request_once()`（`:141-189`）+ `prompt_meta()`（`:192-220`），`prompt()` 降级为薄包装（`:223-228`）；
  - 新增 `time.monotonic()` 耗时测量（`:157`、`:176`）、重试循环与 `0.5s×次数` 线性退避（`:210-218`）；
  - 超时文案由「AI 生成超时，请减少数量或稍后重试」改为「AI 生成超时，请稍后重试」并标记可重试（`:171`）。
- 关联文件：`backend/app/services/ai_chat_service.py`（新建）、`ai_knowledge_service.py`（新建）、`ai_config_service.py`、`ai_usage_service.py`、`backend/app/api/routes/ai.py`、`ai_admin.py`、`backend/app/models/models.py`、`docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql`（`docker/` 按仓库规则不随提交）。
- 测试结果（`docs/迭代记录.md:31` 验证字段原文）：冒烟 `test/s26_ai_center.py` **47/47**（含真实 Agent 调用 L01：reply 143 字、usedTokens=19715；空来源场景模型拒答不编造）；真库校验——迁移应用/表索引菜单齐备/ORM 与真库列 ALL_MATCH/JSON round-trip 后回滚、真库真实 Agent 对话一次（reply 194 字、usedTokens=431）；报告 `backend/test/docs/s26-ai-center-report.md`。管理后台 Vue 子页面、usage/cost 页、node-detail 讲解面板、答题页 AI 讲解按钮按需求 §13 留后续阶段。

### 2026-10-16（`ea58b6c`，`docs/迭代记录.md:53`）

- 需求：题库接入 CloudBase Agent AI 出题（草稿审核后入库），Excel 导入完整保留。
- 修改内容（涉本文件）：**创建本文件**，封装腾讯云 CloudBase Agent 的 ACP 协议调用——JSON-RPC `session/prompt` + SSE，累积 `agent_message_chunk` 文本、按 `stopReason` 终止；当时对外只有 `prompt(text, timeout) -> str` 一个入口，`_http_error` 返回字符串，`_consume_line` 返回布尔，无 `retryable`、无重试、无用量捕获、无耗时测量（据 `git show 1600074` 的删除行反推）。
- 关联文件：`backend/app/services/ai_question_service.py`、`backend/app/api/routes/admin.py`、`backend/app/core/config.py`（`CLOUDBASE_*` 5 项与 `AI_QUESTION_*` 3 项）、`admin/src/components/AiGenerateDialog.vue`、`backend/test/s25_ai_question_generate.py`。
- 测试结果（`docs/迭代记录.md:53` 验证字段原文）：后端冒烟 `test/s25_ai_question_generate.py` **16/16** 通过（含真实 Agent 生成 10 题与 50 题、401/403 越权、响应体不含密钥、小程序答题接口契约未变）；admin `npm run build` 通过；浏览器真机验收 10 项全通过（截图 `admin/test/images/s26-01~09`，报告 `admin/test/docs/s26-ai-question-admin-report.md`、`backend/test/docs/s26-ai-question-backend-report.md`）；**无任何数据库结构或数据变更**。

### 相关但不改本文件的提交（供追溯）

- `37f3e40`（2026-10-17 00:22，`docs/迭代记录.md:36`）：`backend/.env` / `.env.prod` 新增 `CLOUDBASE_ENV_ID/AGENT_ID/API_KEY/AGENT_URL` 及 AI 运行参数配置项，供本模块读取；验证字段记「配置项由 `app/core/config.py` Settings 读取并在 s26 冒烟 C 组覆盖（key 已配置且响应不泄露）」。
- `1fbacac`（2026-10-17 11:26，`docs/迭代记录.md:21`）：VPN 关闭后重跑 s26 全量 **47/47**，L01 真实 Agent 原生网络直达（reply 163 字、usedTokens=19989）；新增 `frontend/test/automator/ai-chat-live.cjs` 全真链路 4/4。范围仅测试与报告，未改本文件。
