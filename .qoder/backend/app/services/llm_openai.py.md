# llm_openai.py

## 1. 文件路径

`backend/app/services/llm_openai.py`（346 行）

## 2. 文件职责

大模型适配器 · **OpenAI Chat Completions 兼容协议**（阿里云百炼等）。职责单一（`backend/app/services/llm_openai.py:3-5`）：发一次提示词、收文本回复——`POST {LLM_BASE_URL}/chat/completions`，系统提示走标准 `system` role（**不前缀拼进用户输入**），并取回 `usage.total_tokens` 与 `finish_reason` 供上层落 `ai_usage_logs`。

两种调用模式（`:7-10`）：`prompt_meta`（非流式，出题需要完整 JSON 才能解析）与 `OpenAiStream`（流式，把小程序 AI 问答的首字延迟从整段耗时压到 1~2 秒）。本模块只依赖 OpenAI 兼容契约、**不感知具体厂商**（`:14-16`）：换同类供应商只改 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`，厂商专有参数一律走 `LLM_EXTRA_BODY` / `LLM_QUESTION_EXTRA_BODY` 透传。

本文件不接触数据库，也不 import 门面 `llm_service`（避免循环 import），只被门面按 `LLM_PROVIDER=openai` 分派调用。

## 3. 业务需求

- 需求来源：`b712d81`（2026-10-22）把 AI 上游改为「门面 + 适配器」的可切换双供应商结构，见 `docs/迭代记录.md` 的 `b712d81` 条目。本文件是其中 `openai` 一侧的适配器。
- **代码来龙去脉**：本模块的实现**整体迁自** `c660727`（2026-10-19，供应商由腾讯云 CloudBase Agent 迁到阿里云百炼）与 `6a4dbb7`（2026-10-19，AI 问答改 SSE 真流式）时期的 `backend/app/services/llm_service.py`——即当时的单文件实现被拆成「门面 + 本适配器」。git 层面本文件**首次出现于 `b712d81`**（`git log --oneline -- backend/app/services/llm_openai.py` 仅 1 条），本文档不追溯更早的建档历史。
- 承接的业务链路（四条，全部经门面 `llm_service` 到达本模块）：AI 历史助手对话（含 SSE 流式）、答题解析、后台 AI 出题；路线节点讲解**不调模型**（`backend/app/api/routes/ai.py:6-7`）。
- 厂商解耦需求的实证（`c660727` 提交信息与 `docs/迭代记录.md` 该条目内容②）：接入百炼通用地址 + `qwen3.8-max`，按量计费；思考 token 不受 `max_tokens` 约束且同样计费，故用 `LLM_EXTRA_BODY` 关思考压时延与成本，出题链路再用 `LLM_QUESTION_EXTRA_BODY` 单独恢复思考。
- 安全需求（`:18`）：API Key 仅在本模块内组装到请求头，不写日志、不进异常消息、不下发前端。
- 导航层出处（只回指）：`.qoder/ARCHITECTURE.md` §11.1「外部集成」（已按「门面 + 双适配器」口径重写并收录本文件）、`.qoder/backend/app/core/config.py.md`（配置项清单，已拆为「供应商与共用项 / openai 段 / cloudbase 段」三表）、`.qoder/CHANGELOG.md` §2.14、`.qoder/decisions/README.md` §1.7。

## 4. 核心功能

### 4.1 符号清单

| 名称 | 行号 | 说明 |
|---|---|---|
| 模块 docstring | `:1-19` | 职责、两种调用模式、无状态多轮、厂商解耦与安全约定 |
| `logger` | `:30` | 模块级 logger；4 处 warning（`:82`、`:195`、`:295`、`:319`）与 1 处 info（`:236`） |
| `_CHAT_PATH` | `:32` | `"/chat/completions"`，与 base_url 拼接的固定路径 |
| `_NORMAL_STOP_REASONS` | `:33-34` | `("stop",)`；注释：其余取值（如 `length`）意味着回复被截断 |
| `_SSE_DATA_PREFIX` / `_SSE_DONE` | `:36` / `:37` | `"data:"` / `"[DONE]"`，SSE 分片格式与流结束哨兵 |
| `is_configured()` | `:40-46` | 适配器契约①：三项配置齐备即 True，**不抛异常** |
| `model_label()` | `:49-51` | 适配器契约②：返回 `settings.LLM_MODEL.strip()`（真实模型名） |
| `_resolve_url()` | `:54-59` | base_url 去尾斜杠 + `_CHAT_PATH`；base 为空抛 `LlmError` |
| `_resolve_model()` | `:62-66` | 模型名；为空抛 `LlmError` |
| `_require_key()` | `:69-73` | API Key；为空抛 `LlmError`（**密钥值不出现在文案里，只提配置项名**） |
| `_http_error(status_code, code="")` | `:76-93` | 状态码 → 中文提示 + `retryable` 分级 |
| `_error_code(payload)` | `:96-103` | 从错误响应体取供应商错误码，仅写日志 |
| `_build_messages(text, system)` | `:106-112` | 组装消息数组，system 独立成 role |
| `_parse_reply(payload, elapsed_ms)` | `:115-130` | 从响应体取正文 / 用量 / 结束原因 → `CallResult` |
| `_build_body(text, system, max_tokens, extra_body, stream)` | `:133-156` | 请求体组装，非流式与流式共用 |
| `_auth_headers()` | `:159-165` | `Content-Type`（显式 charset=utf-8）+ `Authorization: Bearer` |
| `_read_json(response)` | `:168-174` | 读流式响应的错误体（httpx 要求先 `read()`） |
| `_request_once(...)` | `:177-207` | 发一次非流式调用 |
| `prompt_meta(...)` | `:210-239` | 适配器契约③：非流式主入口 + 瞬时故障重试 |
| `class OpenAiStream` | `:242-328` | 一次流式调用（`__init__` `:254-266`、`__iter__` `:268-328`） |
| `stream(...)` | `:331-346` | 适配器契约④：流式工厂，门面 `LlmStream` 转发到此 |

### 4.2 配置齐备判定与模型标识（`:40-51`）

- `is_configured()`（`:40-46`）：`LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` 三项 strip 后均非空才 True。供门面 `is_configured()`（`backend/app/services/llm_service.py:61-64`）与冒烟脚本判定「能否跑真实调用」（`backend/test/s30_llm_provider_switch.py:233-236`）。**只判配置齐备，不判凭证有效性**（见 §9）。
- `model_label()`（`:49-51`）：返回 `settings.LLM_MODEL.strip()`，即写入 `ai_usage_logs.model` 的**真实模型名**（`backend/app/core/config.py:77` 注释「同时作为 ai_usage_logs.model 的取值」）。与 cloudbase 适配器返回 Agent ID 形成对照（`backend/app/services/llm_cloudbase.py:59-61`）。

### 4.3 地址与凭证解析（`:54-73`）

三个 `_resolve_*` / `_require_*` 函数各自抛**不可重试** `LlmError`，文案点名缺失的配置项：`LLM_BASE_URL`（`:57-58`）、`LLM_MODEL`（`:64-65`）、`LLM_API_KEY`（`:71-72`）。`_resolve_url()`（`:56`）先 `rstrip("/")` 再拼 `/chat/completions`，因此 base_url 末尾带不带斜杠都可（`backend/.env` 内就地注释「base_url 末尾不要带 /chat/completions」）。

### 4.4 错误映射（`:76-103`）

`_http_error(status_code, code="")` 返回 `LlmError` **实例**（不是字符串），由调用方 `raise`：

| 状态码 | 文案 | `retryable` | 行号 |
|---|---|---|---|
| 401 / 403 | AI 服务鉴权失败，请检查 LLM_API_KEY 是否有效 | False | `:83-84` |
| 402 | AI 服务账户余额不足，请充值后重试 | False | `:85-86` |
| 404 | AI 服务地址或模型名称不正确 | False | `:87-88` |
| 429 | AI 服务请求过于频繁，请稍后重试 | **True** | `:89-90` |
| ≥ 500 | AI 服务暂时不可用，请稍后重试 | **True** | `:91-92` |
| 其他 | AI 服务返回异常状态码 {status_code} | False | `:93` |

`code` 为供应商错误码，仅 `logger.warning("llm upstream error: http=%d code=%s", ...)` 写日志辅助排障（`:81-82`），**不进用户可见文案**。`_error_code(payload)`（`:96-103`）依次尝试 `error.code` → `error.type` → 顶层 `code`，结构不符返回空串（不影响主流程）。

> 与 cloudbase 适配器的差异：本模块有 **402（余额不足）** 分支，`backend/app/services/llm_cloudbase.py:85-95` 没有。

### 4.5 请求体组装（`:106-112`、`:133-156`）

- `_build_messages`（`:106-112`）：`system` 非空且 strip 后非空时**独立成一条 `system` role 消息**（`:109-110`），用户输入另成 `user` 消息（`:111`）——这是与 ACP「前缀拼接」的关键协议差异。
- `_build_body`（`:133-156`）非流式与流式共用，差异只在 stream 相关字段：
  1. 基础三项 `model` / `messages` / `stream`（`:141-145`）；
  2. `max_tokens` **仅在真值时传**（`:146-148`，`:146` 注释：未显式指定时交由供应商默认值，出题链路依赖长输出，不能被对话的 800 上限截断）；
  3. `body.update(settings.LLM_EXTRA_BODY)`（`:150`）后再 `body.update(extra_body)`（`:151-152`）——**合并顺序 `LLM_EXTRA_BODY` < 调用方 `extra_body`**，与 `backend/app/core/config.py:83` 注释一致，出题链路即靠此把思考模式覆盖回来；
  4. 流式时追加 `stream_options = {"include_usage": True}`（`:153-155`），`:154` 注释：上游默认不在流式响应里报用量，须显式索取，否则 `ai_usage_logs.used_tokens` 恒为空。

### 4.6 非流式：`_request_once` + `prompt_meta`（`:177-239`）

`_request_once(text, system, timeout, max_tokens, extra_body=None)`（`:177-207`）：

- 传输 `httpx.post(url, json=body, headers=_auth_headers(), timeout=timeout)`（`:188-190`），**同步阻塞**，运行在 FastAPI 同步 `def` 路由的线程池线程内（`backend/AGENTS.md` §2）。
- `httpx.TimeoutException` → 可重试「AI 生成超时，请稍后重试」（`:191-192`）；`httpx.HTTPError` → 只记 `exc.__class__.__name__`（`:194` 注释：避免把 URL/请求细节写进日志），抛可重试「AI 服务请求失败，请检查服务器网络后重试」（`:193-196`）。
- `elapsed_ms` 用 `time.monotonic()` 起止（`:186`、`:197`）。
- 响应体 `json()` 失败按 `None` 处理（`:199-202`）；非 200 → `raise _http_error(status_code, _error_code(payload))`（`:203-204`）；200 → `_parse_reply`（`:205`）+ `ensure_complete(result, _NORMAL_STOP_REASONS)`（`:206`）。

`prompt_meta(text, *, system=None, timeout=None, max_retries=None, max_tokens=None, extra_body=None)`（`:210-239`）：

1. `_require_key()` 前置校验（`:225`）——**在发请求之前**抛错，使「未配置」以普通 JSON + 502 返回；
2. `effective_timeout = timeout or settings.LLM_TIMEOUT_SECONDS`（`:226`；注意 `or` 语义，显式传 `0` 会回落到默认 300 秒）；
3. `attempts = 1 + max(0, settings.AI_MAX_RETRIES if max_retries is None else max_retries)`（`:227`）——缺省取 `AI_MAX_RETRIES`（env 默认 1，`backend/app/core/config.py:109`），负数被夹到 0，即默认共尝试 2 次；
4. 重试循环（`:229-237`）：成功立即 `return`；捕获 `LlmError` 后「不可重试 **或** 已是最后一次尝试 → 直接 `raise`」（`:232-234`）；否则记 info 日志（`:236`，第 3 个参数是固定字符串 `"transient"`，不含异常消息）并 `time.sleep(0.5 * (attempt + 1))` 线性退避（`:237`，无抖动）；
5. `:238-239` 是自带注释「理论不可达」的兜底 `raise`。

`_parse_reply`（`:115-130`）：payload 非 dict → 抛可重试「AI 服务返回内容格式异常，请重试」（`:117-118`）；`choices[0]` 缺失或非 dict 时兜成空 dict（`:119-122`）；`used_tokens` 取 `usage.total_tokens` 且**仅当为 int**（`:123-124`、`:127`）；正文取 `choices[0].message.content` 并 strip（`:126`）；`stop_reason` 取 `finish_reason`（`:128`）。

### 4.7 流式：`OpenAiStream`（`:242-328`）与 `stream()`（`:331-346`）

- `__init__`（`:254-266`）：`_require_key()`（`:263`）→ `_build_body(..., stream=True)`（`:264`）→ `self._timeout = timeout or settings.LLM_TIMEOUT_SECONDS`（`:265`）→ `self.result = None`（`:266`）。**构造即校验配置**，`:245-246` 说明理由：使「未配置」这类错误在响应头发出之前就以普通 JSON + 502 返回，而不是退化成流中途的 `error` 事件（此时状态码已无法更改）。对应路由实现见 `backend/app/api/routes/ai.py:126-137`（`LlmStream` 构造被包在返回 `StreamingResponse` 之前的 `try` 里）。
- `__iter__`（`:268-328`）：`httpx.stream("POST", ...)`（`:274-280`）→ 非 200 时 `raise _http_error(status_code, _error_code(_read_json(response)))`（`:281-284`）→ 逐行 `response.iter_lines()`：
  | 处理 | 行号 |
  |---|---|
  | 不以 `data:` 开头的行跳过 | `:286-287` |
  | 载荷为 `[DONE]` → `break` | `:288-290` |
  | `json.loads` 失败 → warning「skip unparsable chunk」后 **continue**（`:294` 注释：丢一片只少几个字，中断整条流会让已显示的半截回答失去下文） | `:291-296` |
  | 非 dict 分片跳过 | `:297-298` |
  | `usage.total_tokens` 为 int 时采纳（收尾分片才带） | `:299-303` |
  | `choices` 缺失或空 → 跳过（`:305` 注释：只带 usage 的收尾分片没有 choices） | `:304-307` |
  | `choices[0].finish_reason` 非空 → 记 `stop_reason` | `:308-310` |
  | 只取 `choices[0].delta.content` 作为增量：`append` 到 `parts` 并 **`yield`**（`:311` 注释：`reasoning_content` 是思考过程，既不展示给用户也不入库） | `:311-315` |
- 异常映射与非流式同构：`TimeoutException` → 可重试超时（`:316-317`）；`HTTPError` → 只记类名 + 可重试（`:318-320`）。
- 迭代正常结束后组装 `self.result = CallResult(text="".join(parts).strip(), ...)`（`:322-327`）并 `ensure_complete(self.result, _NORMAL_STOP_REASONS)`（`:328`）。**消费方提前退出（客户端断开）时不执行这两行，`result` 保持 `None`**（`:251`），调用方须自行判定（`backend/app/api/routes/ai.py:98-101`）。
- `stream(...)`（`:331-346`）：模块级工厂，返回 `OpenAiStream`，签名与门面 `LlmStream.__init__` 的转发处逐参数一致（`backend/app/services/llm_service.py:138-144`）。**门面只认这个工厂函数**，不直接引用类名。

## 5. 输入与输出

### 5.1 参数与返回

| 入口 | 参数 | 返回 |
|---|---|---|
| `prompt_meta`（`:210-218`） | `text: str`（位置）；keyword-only：`system`、`timeout`、`max_retries`、`max_tokens`、`extra_body` | `CallResult`（`backend/app/services/llm_base.py:28-40`） |
| `stream`（`:331-338`） | `text: str`（位置）；keyword-only：`system`、`timeout`、`max_tokens`、`extra_body`（**无 `max_retries`**，流式不重试） | `OpenAiStream` |
| `OpenAiStream.__iter__` | — | `Iterator[str]`，逐个 `yield` 增量正文；迭代结束后 `.result` 为 `CallResult` 或 `None` |
| `is_configured` / `model_label` | 无 | `bool` / `str` |

`text` 不做长度校验，长度控制由上层负责（`backend/app/services/ai_chat_service.py` 按 `cfg.max_input_chars` 校验，env 默认 500，`backend/app/core/config.py:106`）。

### 5.2 异常

**只抛 `LlmError`**（`backend/app/services/llm_base.py:16-25`），无自定义错误码字段；`retryable` 只影响本模块是否重试。HTTP 映射由调用方完成：`backend/app/api/routes/ai.py:56-57`（502）、`backend/app/api/routes/admin.py:585-587`（502，注释「先于 ValueError 捕获」）、`backend/app/api/routes/ai_admin.py:15` + `:224-225`（复用同一映射）。文案原样透传到小程序与管理后台，因此全部写成面向终端用户的中文。

### 5.3 上游契约（出站）

- 协议：HTTPS `POST {LLM_BASE_URL}/chat/completions`，请求体键为 `model` / `messages` / `stream`（+ 可选 `max_tokens`、`stream_options`，+ `LLM_EXTRA_BODY` 与调用方 `extra_body` 透传的任意键）。
- 鉴权：`Authorization: Bearer <LLM_API_KEY>`（`:164`），`Content-Type: application/json; charset=utf-8`（`:163`，`:162` 注释：显式声明 charset，避免中文提示词被上游按其他编码解释）。
- 非流式响应：JSON，读 `choices[0].message.content` / `choices[0].finish_reason` / `usage.total_tokens`。
- 流式响应：SSE，正文行以 `data:` 开头，结束标记 `data: [DONE]`；增量在 `choices[0].delta.content`，用量在收尾分片的 `usage.total_tokens`。
- 多轮对话**无状态**（`:12`）：不依赖服务端会话续接，由上层把最近历史拼进单次提示词（拼接责任在 `backend/app/services/ai_chat_service.py` 的 `_history_block`）。

### 5.4 读取的配置项（全部来自 `backend/app/core/config.py`）

| 配置项 | 本文件引用行 | 定义行 | 用途 |
|---|---|---|---|
| `LLM_BASE_URL` | `:43`、`:56` | `backend/app/core/config.py:76` | Chat Completions 基址 |
| `LLM_MODEL` | `:44`、`:51`、`:63` | `:77` | 模型名，兼作 `ai_usage_logs.model` |
| `LLM_API_KEY` | `:45`、`:70` | `:78` | Bearer 鉴权（**值不入文档**） |
| `LLM_EXTRA_BODY` | `:150` | `:82` | 供应商专有参数透传（如关思考） |
| `LLM_TIMEOUT_SECONDS` | `:226`、`:265` | `:73` | 单批调用超时，两套供应商共用 |
| `AI_MAX_RETRIES` | `:227` | `:109` | 缺省重试次数（管理端配置中心可覆盖） |

`LLM_QUESTION_EXTRA_BODY`（`backend/app/core/config.py:85`）不由本文件读取，而是门面 `prompt()` 以 `extra_body=` 传入（`backend/app/services/llm_service.py:111-113`），在 `:151-152` 合并。

## 6. 依赖关系

### 6.1 依赖

- 第三方：`httpx`（`:25`；非流式 `httpx.post`、流式 `httpx.stream`，均为**同步**）。
- 标准库：`json`（`:20`）、`logging`（`:21`）、`time`（`:22`）、`typing`（`:23`）。
- 项目内：`app.core.config.settings`（`:27`）、`app.services.llm_base` 的 `CallResult` / `LlmError` / `ensure_complete`（`:28`）。
- 外部服务：任一 OpenAI Chat Completions 兼容端点（当前配置为阿里云百炼通用地址）。
- **数据库表：无**（不 import ORM、不接收 `Session`）。用量落库由 `backend/app/services/ai_usage_service.py` 承担。

### 6.2 被谁依赖

实测命令：`grep -rn "llm_openai" backend/`。

| 依赖方 | 位置 | 说明 |
|---|---|---|
| `backend/app/services/llm_service.py` | import `:26`；登记进 `_ADAPTERS` `:41` | **唯一的生产调用方**（门面按 `LLM_PROVIDER` 分派） |
| `backend/test/s30_llm_provider_switch.py` | import `:62`；类型同一性断言 `:244`；B 组本地桩 7 项 | 直接 import 以断言适配器行为 |
| `backend/app/core/config.py` | `:71`、`:79` 注释提及（**非 import**） | 说明适配器与透传参数的关系 |

**业务层（`ai_chat_service` / `ai_question_service` / `routes/*`）无任何文件直接 import 本模块**——一律只 import 门面 `llm_service`（实测 grep 结果，与 `backend/app/services/llm_service.py:3` 的设计约定一致）。

调用链（route → service → 门面 → 本模块 → 外部）：

```text
POST /api/ai/chat            → ai_chat_service.send_message:341   → llm_service.prompt_meta → prompt_meta:210
POST /api/ai/chat/stream     → routes/ai.py:130 LlmStream         → llm_service.LlmStream   → stream:331 → OpenAiStream
GET  /api/ai/quiz-explanation/{id} → ai_chat_service:518          → llm_service.prompt_meta → prompt_meta:210
POST /api/admin/ai/generate-questions → ai_question_service:208   → llm_service.prompt      → prompt_meta:210
POST /api/admin/ai/jobs      → ai_admin.py:224-225（同一出题服务） → 同上
GET  /api/ai/route-guide/{id} → ai_chat_service.route_guide       → 不调模型
```

## 7. 业务规则

1. **系统提示走标准 `system` role**（`:106-112`），不与用户输入混在一条消息里——与 cloudbase 适配器的「前缀拼接」是本架构最显眼的协议差异。
2. **`max_tokens` 不显式传即不下发**（`:146-148`），交由供应商默认值：出题链路依赖长输出，不能被对话侧的 800 上限截断。
3. **`extra_body` 合并顺序固定**：`LLM_EXTRA_BODY`（全局）先、调用方 `extra_body`（场景）后（`:150-152`），后者可覆盖前者；出题链路据此把思考模式覆盖回来（`backend/app/services/llm_service.py:102-113`）。
4. **流式必须索取用量**：`stream_options.include_usage`（`:153-155`），否则 `ai_usage_logs.used_tokens` 恒为空。
5. **只取正文增量**：`delta.content` 之外的 `reasoning_content`（思考过程）既不展示给用户也不入库（`:311-312`）。
6. **坏片跳过、不整流**：单片 JSON 解析失败只 warning 后 continue（`:291-296`）。
7. **非流式重试、流式不重试**：`prompt_meta` 仅对 `retryable=True` 的 `LlmError` 重试（`:229-237`）；`OpenAiStream` 明确不重试（`:248-249`：重试意味着重新生成整段回答，而增量可能已推给用户，重发会导致正文重复；瞬时故障改由前端「停止 / 重试」兜底）。
8. **截断即失败**：`finish_reason` 不是 `stop` → `ensure_complete` 抛不可重试 `LlmError`（`:206`、`:328`、`:34`）。
9. **提前退出即无结果**：客户端断开时 `result` 为 `None`（`:251`），不得据此落库。
10. **密钥安全三处防线**：只在 `_auth_headers()` 组装（`:159-165`）；日志只记异常类名与状态码/错误码（`:82`、`:195`、`:236`、`:319`）；异常文案只提配置项名不提值（`:71-72`）。
11. **无状态多轮**（`:12`）：每次调用都是独立 HTTP 请求，不缓存会话、不复用连接。

## 8. 修改约束

- **适配器契约的四个符号必须齐备且签名不变**：`is_configured()`、`model_label()`、`prompt_meta()`、`stream()`（约定见 `backend/app/services/llm_service.py:11-13`）。门面以关键字参数逐个转发（`:92-99`、`:138-144`），改参数名或删参数会在**运行时**分派那一刻才 AttributeError；新增供应商也要按同一组符号实现并在 `_ADAPTERS` 登记。
- **`stream()` 工厂不得删**：门面 `LlmStream.__init__` 只调 `_adapter().stream(...)`（`backend/app/services/llm_service.py:138`），不引用 `OpenAiStream` 类名；若只保留类而删工厂，流式链路即断。类名 `OpenAiStream` 本身不被业务层引用（s28 经门面构造，`backend/test/s28_ai_chat_stream.py:466`），改名需同步 `:338` 的返回类型注解。
- **`_NORMAL_STOP_REASONS` 只能是 `("stop",)`**（`:34`）：它作为 `ensure_complete` 的白名单入参，与 cloudbase 的 `("end_turn", "stop_sequence")` 不可混用；混用会让截断检测在某一侧失效。
- **不得在本模块写厂商专有参数**（如 `enable_thinking`）：`:14-16` 明确一律走 `LLM_EXTRA_BODY` / `LLM_QUESTION_EXTRA_BODY` 透传，写死会让「换同类供应商只改 env」失效。
- **不得删 `stream_options.include_usage`**（`:153-155`）：删掉后流式对话的 `used_tokens` 恒为空，`ai_usage_logs` 与 `ai_messages` 的用量统计静默失真。
- **不得给流式加重试**（`:248-249`）：会导致用户屏幕上正文重复。
- **不得 import 门面 `llm_service`**（循环 import）；也不得引入 ORM / `Session`（本模块是无 DB 的纯外部客户端，分层约定见 `backend/AGENTS.md` §3.1）。
- **日志克制**：不得引入 URL、请求体、提示词全文、密钥（现有口径 `:82`、`:195`、`:236`、`:295`、`:319`）。
- **401/403 文案点名 `LLM_API_KEY` 是刻意的**（便于运维定位），但只写配置项名，不得输出 key 值或其片段。
- 本文件属 `backend/app/**`，改动后须按 `.qoder/README.md` §3.4 同步更新本文档并追加「迭代记录」。

## 9. 当前实现状态

### 已实现

- 非流式与流式两条路径、错误映射与 `retryable` 分级、瞬时故障线性退避重试、截断与空回复拒绝、用量索取、思考过程过滤（§4 各条，均有行号依据）。
- **本地桩已实测**：s30 B 组 7 项 PASS（`backend/test/docs/s30-llm-provider-switch-report.md` §4「B openai 适配器（本地桩）」行）——`path=/v1/chat/completions`、`system` role、`EXTRA_BODY` 透传、默认不带 `max_tokens` 而显式传参时 `max_tokens=800` 入体、流式 4 片且收尾 usage 被采纳、`stream_options.include_usage` 已索取、出题链路 `prompt()` 覆盖为 `enable_thinking=True`、401（不可重试）/429/500（可重试）/`finish_reason=length` 四项映射、可重试错误重试后成功（上游调用次数=2）、空正文可重试。
- **真实链路历史实测**（`LLM_PROVIDER=openai` 时期）：`docs/迭代记录.md` 的 `6a4dbb7` 条目记 s28 13/13，L01 真实调用上游 36 片、首片 1.15s / 总 3.53s；`c660727` 条目记 s25 16/16（真实生成 10 题与 50 题）、s26 47/47（L01 `usedTokens=383`）。

### 存在问题 / 限制

1. **仓库内百炼 API Key 已 401 失效**：`backend/test/docs/s30-llm-provider-switch-report.md` §2.1 实测以 `LLM_PROVIDER=openai` + `.env` 现存 Key 调用，非流式与流式两条路径均返回上游 `http=401 code=invalid_api_key`，5.7s 内抛「AI 服务鉴权失败，请检查 LLM_API_KEY 是否有效」（路由映射 502）。**上线切换前必须先在百炼控制台重置并替换 `backend/.env.prod` 的 `LLM_API_KEY` 一行**（同报告 §5.1 的三步之一）；因此本次 `b712d81` 的 D 组真实调用只在 cloudbase 侧跑过，本适配器的真实链路自 Key 失效起**未再验证**。
2. `is_configured()` 只判「三项非空」，**不判凭证有效性**：Key 已失效时仍返回 True（§9 第 1 条的实测即此情形），冒烟脚本会照常尝试真实调用并失败。是否需要加连通性探测——**待确认**。
3. **无连接池复用**：非流式每次 `httpx.post`（`:188`）、流式每次 `httpx.stream`（`:274`）新建连接，高频调用下有重复 TLS 握手开销；当前由 AI 日限额兜底（`backend/app/services/ai_usage_service.py:35-42`），量级有限。
4. **重试总耗时可超过前端超时**（跨端事实）：AI 问答的 `timeout` 取 `cfg.request_timeout`（env 默认 60，`backend/app/core/config.py:108`）、`max_retries` 默认 1（`:109`），最坏 ≈ 60 + 0.5 + 60 = **120.5 秒**（`:226-227`、`:237`）；而小程序 `chat` 请求超时为 **60 秒**（`frontend/services/ai.js:41` 的 `timeout: 60000`）。即前端会先超时报错，后端仍可能重试成功并写入 `ai_messages` 与 `ai_usage_logs` 成功记录，造成「前端显示失败、后端已扣当日额度」。是否为预期取舍——**待确认**（该问题在 ACP 时期即存在，非本次引入）。
5. `last_error` 属冗余赋值：`:228` 声明、`:235` 赋值，只被 `:238-239` 自带「理论不可达」注释的兜底分支读取（事实陈述，不影响功能）。
6. **失败调用无耗时数据**：`elapsed_ms` 只在成功路径计算（`:197`），异常分支不经过该行，故 `ai_usage_logs.elapsed_ms` 对 `status='error'` 记录恒为 NULL。
7. ~~**导航层文档滞后**~~ **已修正（2026-10-22，同批文档提交）**：`.qoder/ARCHITECTURE.md` §11.1「外部集成」已重写为「门面 + 双适配器」口径并收录本文件（含 `openai` 侧的 `LLM_*` 生效配置项、`system` role 注入方式、`usage.total_tokens` 用量口径与首片时延实测）；`.qoder/backend/app/core/config.py.md` 的配置项表已删去 `CLOUDBASE_TIMEOUT_SECONDS` 并补齐 `LLM_PROVIDER` / `LLM_TIMEOUT_SECONDS` / `LLM_*` 段。
8. ~~**测试体系总览未收录 s30**~~ **已修正（2026-10-22，同批文档提交）**：`.qoder/backend/test/README.md` §3.1 已补 `s28_ai_chat_stream.py` 与 `s30_llm_provider_switch.py` 两行、`s25`/`s26` 行改为 provider 感知表述，并记「AI 四套脚本本轮合计 99/99」。

## 10. 迭代记录

数据来源：`git log --oneline -- backend/app/services/llm_openai.py`（**仅 1 个提交**，本文件为 `b712d81` 新建）与 `docs/迭代记录.md` 对应条目，按时间倒序。本文件是原 `llm_service.py` 实现的迁入，其**代码**历史可追至 `c660727` / `6a4dbb7`，见本节末「相关提交」。

### 2026-10-22（`b712d81`，见 `docs/迭代记录.md` 该提交条目）

- 需求：用户要求把 AI key 切回原有腾讯云 CloudBase 凭证、上线再用阿里云百炼；因 `c660727` 已删 ACP 实现、`6a4dbb7` 又在其上建成 SSE 流式，直接 revert 会杀掉流式，故改为两套供应商并存、`LLM_PROVIDER` 一行切换。
- 修改内容：**新建本文件（346 行）**，把 `6a4dbb7` 版 `backend/app/services/llm_service.py`（361 行）中的 OpenAI 兼容实现整体迁入——`POST {base_url}/chat/completions`、`system` role、`stream_options.include_usage`、按 `AI_MAX_RETRIES` 重试瞬时故障、状态码 → 中文提示的错误映射，全部保持原行为。三处结构性调整：① 流式类名 `LlmStream` → `OpenAiStream`（`LlmStream` 留给门面做转发壳，`backend/app/services/llm_service.py:116-152`）；② **新增 `is_configured()`（`:40-46`）与 `model_label()`（`:49-51`）**，满足适配器契约并让 `ai_usage_logs.model` 的取值随供应商切换；③ **新增模块级 `stream()` 工厂（`:331-346`）**供门面统一分派。`LlmError` / `CallResult` / 完整性校验改为从 `backend/app/services/llm_base.py` import（`:28`），原 `_check_complete()` 由 `ensure_complete(result, ("stop",))` 取代（`:206`、`:328`）。
- 关联文件：`backend/app/services/llm_base.py`（新建）、`llm_cloudbase.py`（新建）、`llm_service.py`（重写为门面）、`backend/app/core/config.py`（`LLM_PROVIDER` / `LLM_TIMEOUT_SECONDS` 与两套配置段）、`ai_chat_service.py` / `routes/ai.py` / `models.py`（`model=` 改取 `model_label()`）、`backend/.env` 与 `.env.prod`（两套凭证常驻，当前 `LLM_PROVIDER=cloudbase`）、新增 `backend/test/s30_llm_provider_switch.py`、s25/s26/s28 三套脚本 provider 感知化。
- 测试结果：据 `docs/迭代记录.md` 的 `b712d81` 条目——**s30 23/23 PASS**，其中 B 组（本适配器，本地桩）7 项全通过（明细见 §9「已实现」第 2 条）；A 组验证 `openai` 下 `model_label()` 等于 `LLM_MODEL`、缺 `LLM_API_KEY` 时在发请求前就抛错（`backend/test/s30_llm_provider_switch.py:233-236`、`:258-263`）；D 组真实调用本次在 cloudbase 侧执行。回归 **s25 16/16**、**s26 47/47**、**s28 13/13**。同条目备注①记 s25/s26/s28 原写死 `settings.LLM_API_KEY` 判定「能否跑真实调用」，切到 cloudbase 后会整组静默跳过，已改为 provider 感知。报告 `backend/test/docs/s30-llm-provider-switch-report.md`。

### 相关但不改本文件的提交（供追溯代码来源）

- `6a4dbb7`（2026-10-19）：AI 问答改 SSE 真流式，在当时的 `llm_service.py` 内新增 `LlmStream`（该版本 `:260`）——本文件 `OpenAiStream` 的前身；同版本 `_check_complete()`（`:217`）即 `llm_base.ensure_complete()` 的前身。验证记 s28 13/13、真实调用 36 片、首片 1.15s。
- `c660727`（2026-10-19）：供应商由腾讯云 CloudBase Agent 迁到阿里云百炼，`cloudbase_service.py` 更名 `llm_service.py` 并重写为 OpenAI Chat Completions 兼容实现（`CloudBaseError` → `LlmError`、`CLOUDBASE_*` → `LLM_*`、`ai_usage_logs.error_code` 由 `cloudbase` 改为 `llm`），本文件的协议实现即源于此。**该提交当时未同步 `.qoder/`**，缺口登记于 `.qoder/PROJECT.md` §10「仍缺档（13 份，待补）」表第 1 项。
