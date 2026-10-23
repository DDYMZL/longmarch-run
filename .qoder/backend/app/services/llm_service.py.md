# llm_service.py

## 1. 文件路径

`backend/app/services/llm_service.py`（152 行）

## 2. 文件职责

**大模型调用门面**：按 `settings.LLM_PROVIDER` 从 `_ADAPTERS` 字典选择上游适配器，对业务层暴露唯一入口（`backend/app/services/llm_service.py:1`）。AI 问答、路线讲解、答题解析、后台出题四条链路都只 import 本模块、不感知具体供应商（`:3`）；换供应商只改 env 的 `LLM_PROVIDER` 一行，两套凭证常驻配置文件、无需改代码（`:4`）。

本文件**不含任何协议细节**：没有 httpx、没有 URL 拼接、没有 SSE 解析、没有错误码映射，只做「读配置 → 选适配器 → 转发参数 → 透传结果/异常」。协议实现分别在 `backend/app/services/llm_openai.py`（OpenAI Chat Completions 兼容）与 `backend/app/services/llm_cloudbase.py`（腾讯云 CloudBase Agent ACP），共用类型在 `backend/app/services/llm_base.py`。

对外符号（`:15-19` 明列，业务层与测试脚本均按此引用，**勿改名**）：`LlmError` / `CallResult`（从 `llm_base` 重导出，与各适配器抛出/构造的是同一个类对象）、`prompt_meta` / `prompt`（非流式）、`LlmStream`（流式）、`model_label`（写入 `ai_usage_logs.model` 的模型标识）。

## 3. 业务需求

- 需求来源：`b712d81`（2026-10-22）用户要求「把 AI key 切回之前那把（腾讯云 CloudBase），上线再用阿里这套」。因 `c660727` 已删除 ACP 实现、其后 `6a4dbb7` 又在 OpenAI 兼容层上建成 SSE 流式对话，直接 revert 会连带杀掉流式功能，故改为**两套供应商并存、`LLM_PROVIDER` 一行切换**的门面 + 适配器结构。见 `docs/迭代记录.md` 的 `b712d81` 条目。
- 门面的三项价值（均出自 `:1-22` 模块 docstring 与实测调用点）：
  1. **业务层与厂商解耦**：4 个业务调用点（`ai_chat_service.py:341`、`:518`、`ai_question_service.py:208`、`routes/ai.py:130`）不出现任何供应商名字或配置项；
  2. **扩展点单一**：新增供应商只需再加一个适配器模块并在 `_ADAPTERS` 登记（`:13`）；
  3. **类型与异常统一**：`LlmError` / `CallResult` 由本文件重导出（`:27`、`:29-37`），保证路由层 `isinstance` 判定与测试打桩指向同一个类对象。
- 出题链路的特殊需求（`:104-107`）：出题要求严格 JSON 数组，百炼实测关闭思考模式后批次解析失败率明显上升（5 批挂 1 批），故 `prompt()` 叠加 `LLM_QUESTION_EXTRA_BODY` 恢复思考模式；出题由管理员触发且分批并发，可承受其额外时延与 token 开销。
- 流式需求（`6a4dbb7`，2026-10-19）：`POST /api/ai/chat/stream` 的 SSE 真流式逐字回答，事件序列 `start` → `delta`* → `done`，中途失败发 `error`；`LlmStream` 即该链路的上游侧迭代器。
- 建档债务：本文件自 `c660727` 引入起**一直没有 `.qoder/` 文档**，缺口登记于 `.qoder/PROJECT.md` §10「仍缺档（13 份，待补）」表第 1 项（「`backend/app/services/llm_service.py` ｜ `c660727`（2026-10-19，AI 供应商迁百炼） ｜ 一」）；`6a4dbb7` 同样未同步。本文档为该缺口的补建。
- 安全约定（`:21`）：API Key 只在适配器内组装到请求头，不写日志、不进异常消息、不下发前端。

## 4. 核心功能

### 4.1 符号清单

| 名称 | 行号 | 说明 |
|---|---|---|
| 模块 docstring | `:1-22` | 供应商对照表（`:6-9`）、适配器约定（`:11-13`）、对外符号清单（`:15-19`）、安全约定（`:21`） |
| `__all__` | `:29-37` | 7 个对外符号：`CallResult`、`LlmError`、`LlmStream`、`is_configured`、`model_label`、`prompt`、`prompt_meta` |
| `PROVIDER_OPENAI` / `PROVIDER_CLOUDBASE` | `:39` / `:40` | `"openai"` / `"cloudbase"` 两个合法取值常量 |
| `_ADAPTERS` | `:41` | `{PROVIDER_OPENAI: llm_openai, PROVIDER_CLOUDBASE: llm_cloudbase}`，**值是模块对象** |
| `_current()` | `:44-46` | 当前 provider 对应的适配器模块；取值非法返回 `None`（**不抛异常**） |
| `_adapter()` | `:49-58` | 当前生效的适配器模块；取值非法抛 `LlmError`（路由层映射 502） |
| `is_configured()` | `:61-64` | 当前供应商所需配置是否齐备（供冒烟脚本判定，不抛异常） |
| `model_label()` | `:67-74` | 写入 `ai_usage_logs.model` 的模型标识；**刻意不抛异常** |
| `prompt_meta(...)` | `:77-99` | 非流式：一次拿完整正文 + 用量 |
| `prompt(text, timeout=None)` | `:102-113` | 非流式的出题专用包装，叠加 `LLM_QUESTION_EXTRA_BODY` |
| `class LlmStream` | `:116-152` | 流式转发壳（`__init__` `:129-144`、`__iter__` `:146-148`、`result` property `:150-152`） |

### 4.2 供应商分派（`:39-58`）

- `_ADAPTERS`（`:41`）把 provider 字符串映射到**适配器模块**，因此分派即「取模块属性」，无实例化、无状态。
- `_current()`（`:44-46`）：`_ADAPTERS.get(settings.LLM_PROVIDER.strip().lower())`——对大小写与首尾空白容错；取值非法返回 `None` 而**不抛异常**，供 `is_configured()` / `model_label()` 这两个「不得抛错」的入口使用。
- `_adapter()`（`:49-58`）：在 `_current()` 为 `None` 时抛 `LlmError`，文案「AI 服务未配置：LLM_PROVIDER 取值非法（{provider}），应为 {' / '.join(sorted(_ADAPTERS))} 之一」（`:54-57`）——**合法取值集合由 `_ADAPTERS` 动态生成**，新增供应商无需改文案。s30 A03 实测把 provider 设为 `azure` 时该异常抛出且文案含合法集合、`model_label()` 原样返回 `"azure"`（`backend/test/s30_llm_provider_switch.py:238-241`）。
- **每次调用都重新读 `settings.LLM_PROVIDER`**（`:46`、`:53`、`:74`），不做模块级缓存；但 `settings` 本身是 `lru_cache` 单例（`backend/app/core/config.py:142-147`），故运行期改 env 不生效，切换供应商须重启进程（见 §9 第 4 条）。

### 4.3 `is_configured()`（`:61-64`）

`adapter = _current()`；`return bool(adapter and adapter.is_configured())`。语义：**provider 合法且该供应商所需配置齐备**。不抛异常（`:62` docstring：供冒烟脚本判定能否跑真实调用）。实际判定下沉到适配器——openai 查 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` 三项（`backend/app/services/llm_openai.py:40-46`），cloudbase 查 `CLOUDBASE_API_KEY` + 地址可确定（`backend/app/services/llm_cloudbase.py:50-56`）。

### 4.4 `model_label()`（`:67-74`）

返回适配器给出的模型标识：`openai` 为真实模型名（`settings.LLM_MODEL`，如 `qwen3.8-max`），`cloudbase` 为 Agent ID（形如 `agt-…`，为空时字面量 `"cloudbase-agent"`）。

**刻意不抛异常**（`:69-72` docstring）：provider 取值非法时原样返回该值（`:74`，`settings.LLM_PROVIDER.strip() or "unknown"`）。理由是异常收尾路径也会调用它——`backend/app/api/routes/ai.py:158-161`（流内失败记 error 日志）、`backend/app/services/ai_chat_service.py:350-353`、`:527-530`——若在此抛错会**掩盖原始错误**。

`ai_usage_logs.model` 的语义因此随供应商变化，跨供应商不可直接比较（`backend/app/models/models.py:688-689` docstring 已同步记载该口径）。

### 4.5 `prompt_meta(...)`（`:77-99`）

签名：`prompt_meta(text, *, system=None, timeout=None, max_retries=None, max_tokens=None, extra_body=None) -> CallResult`（`:77-85`，除 `text` 外全部 keyword-only）。实现是**纯转发**（`:92-99`）：`_adapter().prompt_meta(text, system=..., timeout=..., max_retries=..., max_tokens=..., extra_body=...)`，六个参数逐个原样传递，不做任何加工。

行为差异由适配器决定（`:88-90` docstring 已注明）：`system` 非空时 openai 走 `system` role、cloudbase 前缀拼接；`max_tokens` / `extra_body` 在 cloudbase 下被忽略；瞬时故障由适配器按 `settings.AI_MAX_RETRIES` 重试；失败抛 `LlmError`。

### 4.6 `prompt(text, timeout=None)`（`:102-113`）

出题链路专用：`return prompt_meta(text, timeout=timeout, extra_body=settings.LLM_QUESTION_EXTRA_BODY).text`（`:111-113`）——只取正文、**丢弃用量与耗时**（出题链路不写 `ai_usage_logs`，见 `.qoder/backend/app/services/ai_usage_service.py.md` §6.2）。

- 叠加 `LLM_QUESTION_EXTRA_BODY` 的理由见 `:104-107`（出题需严格 JSON，关思考后批次解析失败率上升）；合并顺序为 `LLM_EXTRA_BODY` < `LLM_QUESTION_EXTRA_BODY`（`backend/app/core/config.py:83`、实现在 `backend/app/services/llm_openai.py:150-152`）。**CloudBase 无思考开关，该覆盖项被适配器忽略**（`:107`）。
- **不接受 `system` / `max_tokens` / `extra_body`**：出题的角色约束写在提示词正文里（`backend/app/services/ai_question_service.py:208-210` 的唯一调用点只传 `text`），输出长度只受 `LLM_TIMEOUT_SECONDS`（缺省 300 秒）与提示词软约束限制。
- `timeout` 在此为**位置参数**（`:102`），与 `prompt_meta` 的仅限关键字不同——沿 `c660727` 之前 `cloudbase_service.prompt` 的旧契约，不得改成 keyword-only（见 §8）。
- 内部通过**模块全局名**调用 `prompt_meta`（`:111`），因此测试中 `llm_service.prompt_meta = _fake` 的打桩对 `prompt` 同样生效（`backend/test/s26_ai_center.py:141-155` 依赖此行为）。

### 4.7 `class LlmStream`（`:116-152`）

一次流式调用的**转发壳**（`:118`：仅做转发，实际协议由当前适配器实现）：

- `__init__(text, *, system=None, timeout=None, max_tokens=None, extra_body=None)`（`:129-144`）：唯一动作是 `self._impl = _adapter().stream(text, system=..., timeout=..., max_tokens=..., extra_body=...)`（`:138-144`）。**构造即校验配置**（`:119-122`）：使「未配置 / 供应商取值非法」这类错误在响应头发出之前就以普通 JSON + 502 返回，而不是退化成流中途的 `error` 事件（此时状态码已无法更改）。对应路由实现见 `backend/app/api/routes/ai.py:126-137`（`LlmStream` 构造被包在返回 `StreamingResponse` 之前的 `try` 里，异常经 `AI_ERRORS` → `ai_http_error` 映射）。
- `__iter__`（`:146-148`）：`for piece in self._impl: yield piece`——增量正文原样透传，不缓冲、不改写、不合并。
- `result` property（`:150-152`）：`return self._impl.result`，即适配器在迭代正常结束后组装的 `CallResult`（`backend/app/services/llm_openai.py:322-328`、`backend/app/services/llm_cloudbase.py:299`）；**消费方提前退出时为 `None`**（`:126`），调用方须自行判定，不得据此落库（实际兜底见 `backend/app/api/routes/ai.py:98-101`）。
- **与非流式 `prompt_meta` 的关键差异：不做自动重试**（`:122-124`）：重试意味着重新生成整段回答，而增量可能已经推给了用户，重发会导致正文重复；瞬时故障改由前端「停止 / 重试」兜底。
- 无 `max_retries` 参数（`:129-137`），与两个适配器的 `stream()` 工厂签名一致。

## 5. 输入与输出

### 5.1 参数与返回

| 入口 | 参数 | 返回 | 抛出 |
|---|---|---|---|
| `is_configured()`（`:61`） | 无 | `bool` | 不抛 |
| `model_label()`（`:67`） | 无 | `str` | **不抛**（非法 provider 原样返回该值） |
| `prompt_meta()`（`:77-85`） | `text: str` + keyword-only `system` / `timeout` / `max_retries` / `max_tokens` / `extra_body` | `CallResult` | `LlmError` |
| `prompt()`（`:102`） | `text: str`、`timeout`（位置或关键字） | `str`（正文） | `LlmError` |
| `LlmStream()`（`:129-137`） | `text: str` + keyword-only `system` / `timeout` / `max_tokens` / `extra_body` | 可迭代对象，`yield str` 增量；`.result` → `Optional[CallResult]` | 构造期与迭代期均可能抛 `LlmError` |

`CallResult` 与 `LlmError` 的定义见 `.qoder/backend/app/services/llm_base.py.md` §4.2-§4.3；本文件只是重导出（`:27`）。

### 5.2 异常与对外状态码

本模块**只抛 `LlmError`**（`ValueError` 子类），`retryable` 属性只影响适配器是否重试、不对外暴露。HTTP 映射由调用方完成：

| 调用方 | 映射 | 行号 |
|---|---|---|
| `backend/app/api/routes/ai.py` | `AI_ERRORS` 元组含 `LlmError`（`:45`）；`ai_http_error` 内 `isinstance` 判定 → **502** | `:42-47`、`:56-57` |
| `backend/app/api/routes/admin.py` | `except llm_service.LlmError` → **502**（`:586` 注释：先于 ValueError 捕获，`LlmError` 继承 ValueError 但属上游故障） | `:585-587` |
| `backend/app/api/routes/ai_admin.py` | 复用 `AI_ERRORS` + `ai_http_error` → **502** | `:15`、`:224-225` |
| `POST /api/ai/chat/stream` 流内失败 | 200 与响应头已发出，**状态码无法再改**，故错误只能走 `error` 事件（`{"type":"error","message":...}`） | `backend/app/api/routes/ai.py:156-165` |

detail 文案原样透传到小程序与管理后台，因此适配器给出的文案都是面向终端用户的中文（不含密钥、URL、堆栈）。

### 5.3 读取的配置项

| 配置项 | 引用行 | 定义行 | 用途 |
|---|---|---|---|
| `LLM_PROVIDER` | `:46`、`:53`、`:74` | `backend/app/core/config.py:72` | 选择适配器；`openai`（默认）/ `cloudbase` |
| `LLM_QUESTION_EXTRA_BODY` | `:112` | `:85` | 出题链路覆盖项（恢复思考模式） |

其余 `LLM_*` / `CLOUDBASE_*` / `LLM_TIMEOUT_SECONDS` / `AI_MAX_RETRIES` 全部由适配器自行读取，本文件不碰（这是「门面不感知厂商」的实现体现）。当前 `backend/.env:38` 与 `backend/.env.prod:50` 的 `LLM_PROVIDER` 均取 `cloudbase`（开发期口径），两份文件就地标注上线前须改回 `openai`（`backend/.env:37`、`backend/.env.prod:48-49`）。

## 6. 依赖关系

### 6.1 依赖

- 标准库：`typing.Any` / `Dict` / `Iterator` / `Optional`（`:23`）。
- 项目内：`app.core.config.settings`（`:25`）、`app.services.llm_cloudbase` 与 `app.services.llm_openai`（`:26`）、`app.services.llm_base` 的 `CallResult` / `LlmError`（`:27`）。
- **无第三方库**（不 import httpx）；**无数据库依赖**（不 import ORM、不接收 `Session`）。
- 外部服务：间接——由当前适配器访问阿里云百炼或腾讯云 CloudBase Agent 网关。

### 6.2 被谁依赖

实测命令：`grep -rn "llm_service" backend/`（下表「位置」列行号均属同行「依赖方」列的文件）。

| 依赖方 | 位置 | 用到的符号 |
|---|---|---|
| `backend/app/services/ai_chat_service.py` | import `:38`；`:275`、`:295`、`:341-348`、`:351`、`:518-528`、`:536` | `CallResult`（类型注解）、`model_label`、`prompt_meta`、`LlmError` |
| `backend/app/services/ai_question_service.py` | import `:22`；调用 `:208-210` | `prompt`（分批出题） |
| `backend/app/api/routes/ai.py` | import `:34`；`:45`、`:56`、`:89`、`:99-101`、`:130-135`、`:156`、`:160`、`:166`、`:171-172` | `LlmError`（502 映射）、`LlmStream`（构造 + 迭代 + `.result`）、`CallResult`（断开兜底构造）、`model_label` |
| `backend/app/api/routes/admin.py` | import `:103`；捕获 `:585-587` | `LlmError`（502 映射，不发起调用） |
| `backend/app/api/routes/ai_admin.py` | `:15`（复用 `routes.ai` 的 `AI_ERRORS` / `ai_http_error`）、`:224-225` | 间接依赖 `LlmError` |
| `backend/app/models/models.py` | `:688-689` docstring 提及（**非 import**） | — |
| `backend/app/core/config.py` | `:71`、`:79` 注释提及（**非 import**） | — |
| `backend/test/s25_ai_question_generate.py` | import `:68`；打桩 `:125-136`；`:154`；构造 `LlmError` `:245-248` | `prompt`（monkeypatch）、`model_label`、`LlmError` |
| `backend/test/s26_ai_center.py` | import `:72`；打桩 `:118-136`（`prompt_meta`）、`:141-155`（`prompt`）；`:240`、`:412`、`:639` | `prompt_meta`、`prompt`、`CallResult`、`model_label`、`LlmError` |
| `backend/test/s28_ai_chat_stream.py` | import `:65`；打桩 `:144-174`（`LlmStream`）、`:179-190`（`prompt_meta`）；`:224`、`:322`、`:466` | `LlmStream`、`prompt_meta`、`CallResult`、`model_label`、`LlmError` |
| `backend/test/s30_llm_provider_switch.py` | import `:63`；A 组 `:228-263`；B/C/D 组 `:276-505` | 全部 7 个符号 + `PROVIDER_OPENAI` / `PROVIDER_CLOUDBASE`（`:69-70`） |

**依赖方向是单向的**：业务层 → 门面 → 适配器 → `llm_base`。业务层无任何文件 import `llm_openai` / `llm_cloudbase` / `llm_base`（三份 grep 实测），符合 `:3` 的设计约定。

调用链：

```text
POST /api/ai/chat                    → ai_chat_service.send_message:341    → prompt_meta  → 适配器.prompt_meta
POST /api/ai/chat/stream             → routes/ai.py:130                    → LlmStream    → 适配器.stream
GET  /api/ai/quiz-explanation/{id}   → ai_chat_service:518                 → prompt_meta  → 适配器.prompt_meta
POST /api/admin/ai/generate-questions→ ai_question_service:208（分批并发） → prompt       → prompt_meta
POST /api/admin/ai/jobs              → ai_admin.py:224-225（同一出题服务） → prompt       → prompt_meta
GET  /api/ai/route-guide/{node_id}   → ai_chat_service.route_guide         → 不调模型
```

## 7. 业务规则

1. **供应商选择在每次调用时读取**（`:46`、`:53`、`:74`），但 `settings` 为 `lru_cache` 单例（`backend/app/core/config.py:142-147`），故**切换供应商须重启后端进程**；provider 取值对大小写与首尾空白容错（`.strip().lower()`）。
2. **非法 provider 的两种行为刻意不同**：`_adapter()` 抛 `LlmError`（→ 502，`:49-58`），`is_configured()` 返回 False、`model_label()` 返回该非法值本身（`:61-74`）——后两者服务于「判定」与「异常收尾落库」，抛错会掩盖原始错误。
3. **出题链路强制叠加 `LLM_QUESTION_EXTRA_BODY`**（`:111-113`）：走 `prompt()` 的调用一律带上该覆盖项，无法在调用点关闭；cloudbase 下被适配器忽略。
4. **流式不重试**（`:122-124`），非流式按 `AI_MAX_RETRIES` 重试（由适配器执行，`:90`）。
5. **构造即校验配置**（`:119-122`）：未配置 / provider 非法的错误必须在响应头发出之前暴露，才能以普通 JSON + 502 返回；一旦进入流，只能发 `error` 事件。
6. **客户端断开时 `result` 为 `None`**（`:126`）：调用方须自行判定，不得据此落库。路由层的实际处理是把已推增量拼成半截全文落库（`backend/app/api/routes/ai.py:98-102`），一个增量都没有则删除本次提问（`:104`）。
7. **`model_label()` 的语义随供应商变化**（`:68`）：`openai` 为真实模型名、`cloudbase` 为 Agent ID；`ai_usage_logs.model` 因此**不可跨供应商比较**（`backend/app/models/models.py:688-689`），成本统计须按供应商分段。
8. **门面不含协议知识**：正常结束原因白名单、错误码映射、SSE 事件形态、system 注入方式全部留在适配器；本文件唯一的「供应商知识」是 `_ADAPTERS` 的两个键（`:39-41`）。
9. **无状态多轮**：门面不缓存任何会话或连接，历史拼接由上层负责（`backend/app/services/ai_chat_service.py` 的 `_history_block`）。
10. **密钥安全**（`:21`）：门面不读任何 `*_API_KEY`，因此不可能泄露；密钥只在适配器内组装请求头。

## 8. 修改约束

- **对外符号名不得改**（`__all__` `:29-37` 的 7 个符号 + `PROVIDER_OPENAI` / `PROVIDER_CLOUDBASE`）。既有引用点全部按现名硬编码，改名会让打桩与判定**静默失效**（脚本仍绿，但不再覆盖真实行为）：
  - s25 以 monkeypatch 替换 `llm_service.prompt`（`backend/test/s25_ai_question_generate.py:125-136`）；
  - s26 替换 `llm_service.prompt_meta` 与 `llm_service.prompt`（`backend/test/s26_ai_center.py:118-136`、`:141-155`）；
  - s28 替换 `llm_service.LlmStream` 与 `llm_service.prompt_meta`（`backend/test/s28_ai_chat_stream.py:144-174`、`:179-190`）；
  - `routes/ai.py:56` 对 `LlmError` 做 `isinstance` 判定、`routes/admin.py:585` 用 `except llm_service.LlmError`；
  - s30 直接断言 `llm_service.LlmError is llm_base.LlmError is llm_openai.LlmError is llm_cloudbase.LlmError`（`backend/test/s30_llm_provider_switch.py:243-246`）与 `PROVIDER_*` 常量（`:69-70`）。
- **`LlmError` / `CallResult` 必须继续从 `llm_base` 重导出**（`:27`），不得在本文件另行定义或复制：本地定义会让上述 `isinstance` / 类型同一性断言全部失效。
- **适配器契约**：新增供应商必须实现 `is_configured()` / `model_label()` / `prompt_meta()` / `stream()` 四个符号（`:11-13`），签名与本文件的转发处逐参数一致（`:92-99`、`:138-144`），并在 `_ADAPTERS`（`:41`）登记。少任一符号只会在**运行时分派那一刻** AttributeError。
- **`model_label()` 不得改为抛异常**（`:67-74`）：异常收尾路径（`backend/app/api/routes/ai.py:160`、`backend/app/services/ai_chat_service.py:351`、`:528`）都会调用它，抛错会掩盖触发收尾的原始错误。
- **流式不得加自动重试**（`:122-124`）：增量可能已推给用户，重发导致正文重复。
- **`prompt(text, timeout)` 的签名是既有契约**：`timeout` 可为位置参数（沿 `c660727` 之前的 `cloudbase_service.prompt`）；新增能力应扩展 `prompt_meta`，不要把 `prompt` 改成仅限关键字或删除。
- **`prompt()` 内部必须以模块全局名调用 `prompt_meta`**（`:111`）：s26 的打桩依赖此行为（`backend/test/s26_ai_center.py:141-155`）；改成局部别名绑定或 `from ... import prompt_meta` 会使打桩失效。
- **门面不得引入协议细节**（httpx、URL、SSE 解析、错误码映射、`_NORMAL_STOP_REASONS`）：一旦写入，「换供应商只改一行 env」与「新增供应商只加一个适配器」两个扩展点同时失效。
- **不得 import 适配器以外的业务模块**：`llm_service` 位于 services 层且被 routes 与多个 service 引用，引入 `ai_config_service` / ORM 会造成循环依赖并破坏分层（`backend/AGENTS.md` §3.1）。
- 密钥不得进日志、异常消息、响应（`:21`）；本文件当前无任何日志语句（未 import `logging`，`:23`），新增日志须遵循同样克制。
- 本文件属 `backend/app/**`，改动后须按 `.qoder/README.md` §3.4 同步更新本文档并追加「迭代记录」。

## 9. 当前实现状态

### 已实现

- 门面 7 个对外符号齐备（`:29-37`），双供应商分派（`:39-58`），流式与非流式两条转发路径（`:77-152`）。
- 业务层 4 条链路全部经门面，无一处直接 import 适配器（§6.2 实测）。
- **s30 A 组 6 项实测 PASS**（`backend/test/docs/s30-llm-provider-switch-report.md` §4「A 分派与配置」行）：两家 `model_label` 正确、非法取值 `azure` 抛错且文案含合法集合、门面与适配器类型同一、缺 Key 时在发请求前就抛错。
- 回归全绿：s25 16/16、s26 47/47、s28 13/13（`docs/迭代记录.md` 的 `b712d81` 条目）。
- 出题链路真实验证（cloudbase 侧）：s30 D03 `耗时=14.8s 题数=2 正文长度=553`，长输出 JSON 数组可解析、未被截断（同报告 §4「D 真实调用（cloudbase）」行）。

### 存在问题 / 限制

1. ~~**建档债务已补，但导航层与同目录文档仍滞后**~~ **导航层与同目录文档已于同批文档提交（2026-10-22）一并修正**：
   - `.qoder/ARCHITECTURE.md` §11.1「外部集成」已重写为「门面 + 双适配器 + `LLM_PROVIDER` 分派」口径（含供应商对照表、统一四符号、四条跨供应商口径差异、上线一行切换与百炼 Key 已失效的警示）；§1.2 外部依赖框图已改为「大模型上游（二选一）」；§11.4 更名并重写为「异常映射与超时口径」（`AI_ERRORS` → `ai_http_error()` → 403/429/502/400，流式错误只能走事件，前端 10s/60s/120s 三档超时与降级路径）；§11.3「小程序真机真实模型全链路」行已记后端侧三条链路实测通过；§12.2「`.env.prod` 占位符现状」行已记 `LLM_PROVIDER=cloudbase`（`:50`）与两套凭证现状。
   - `.qoder/REQUIREMENTS.md` §10.2 依据行号已重锚、§10.3 已把 `CLOUDBASE_TIMEOUT_SECONDS` 换成 `LLM_TIMEOUT_SECONDS` 并补 `LLM_PROVIDER` 双供应商说明、§10.4 已改引 `ai_chat_service.py:138` 与两家适配器的 system 注入差异、§10.1 已补 `POST /api/ai/chat/stream`、§10.6 真机行已更新。
   - `.qoder/backend/app/core/config.py.md` 已按现行 147 行版重锚全部行号，并把旧「腾讯云 CloudBase Agent」单表拆为「供应商与共用项 / openai 段 / cloudbase 段」三表。
   - `.qoder/backend/app/services/ai_chat_service.py.md` 已全文改为 `LlmError` / `llm_service.model_label()` / `error_code="llm"` 口径。
   - `.qoder/backend/test/README.md` §3.1 已补 `s28_ai_chat_stream.py` 与 `s30_llm_provider_switch.py` 两行、`s25`/`s26` 行改为 provider 感知表述，并记「AI 四套脚本合计 99/99」。
   - `.qoder/CHANGELOG.md` 新增 §2.14「AI 上游三连变：迁百炼 → SSE 真流式 → 供应商可切换」（十个模板字段齐备）、§1 阶段索引补第 14 行、§4「反复变更热点」新增「AI 上游供应商」一行；`.qoder/decisions/README.md` §1.7 由 9 行扩为 **16 行**，新增 7 条决策索引（门面 + 双适配器、统一四符号、`AI_QUESTION_BATCH_SIZE` 不随供应商联动、流式不重试、`CLOUDBASE_TIMEOUT_SECONDS` 删除后超时单旋钮、系统提示下发位置随厂商而异、出题 JSON 解析失败在提示词层修而不引入修复引擎）。
   - `.qoder/PROJECT.md` §9 已按实测重写 `.env.prod` 行（只有 `JWT_SECRET` 是占位符）、§8「文档滞后项」新增 2 行（`backend/AGENTS.md` §6「禁止行为」末项与 `.env.prod` 存真实密钥的口径冲突待用户裁定；`admin/src/components/AiGenerateDialog.vue:322` 硬编码「腾讯云 CloudBase Agent」文案）、§10 缺档表 #1 划除并把覆盖率更新为已建 186 / 应建 198 / 93.9%。
   - 同批还删除了失效档 `.qoder/backend/app/services/cloudbase_service.py.md`（其源文件已在 `c660727` 更名重写，旧文档描述的 `CloudBaseError` / `CLOUDBASE_ACP_URL` 等符号全部不存在）。
   - ~~**仍待办**（不属本批文档范围）~~ **同批已全部清完（2026-10-22 复核）**：原先点名的 `admin.py.md`、`ai.py.md`、`ai_admin.py.md`、`ai_question_service.py.md`、`ai_usage_service.py.md`、`ai_config_service.py.md`、`ai_knowledge_service.py.md`、`ai-chat.js.md`、`QuestionsView.vue.md`、`021_ai_center.sql.md` 均已改为门面/适配器口径。全仓 `.qoder/**/*.md` 按 `cloudbase_service` / `CloudBaseError` / `CLOUDBASE_ACP_URL` / `CLOUDBASE_TIMEOUT_SECONDS` 四个旧符号复扫，**已无任何「断言当前状态」的残留**；剩余命中全部属两类合法文本：① 各文件 §10 历史迭代记录里的「关联文件」清单（按 `.qoder/README.md` §3 第 11 条保留原文，实测仅 `helpers.py.md`、`models.py.md`、`ai_knowledge_service.py.md`、`setting_service.py.md`、`requirements.txt.md`、`test/README.md`、`QuestionsView.vue.md` 各 1~2 处）；② 正文中**明确表述为「已更名/已删除」的对照说明**（如 `.qoder/ARCHITECTURE.md` §11.1「调用地址」条、`.qoder/REQUIREMENTS.md` §10.3「`LLM_TIMEOUT_SECONDS`」行、`.qoder/PROJECT.md` §10「文档覆盖率」、`build-prod.bat.md` §9 第 10 条），删掉反而会丢失溯源线索。
2. **`is_configured()` 只判配置齐备、不判凭证有效性**：仓库内百炼 Key 已 401 失效（`backend/test/docs/s30-llm-provider-switch-report.md` §2.1），此时 `LLM_PROVIDER=openai` 下 `is_configured()` 仍返回 True，冒烟脚本会照常尝试真实调用并失败。**上线切换前必须重置并替换 `.env.prod` 的 `LLM_API_KEY`**（同报告 §5.1 第 1 步）。
3. **`model_label()` 在 provider 非法时会把非法值写进 `ai_usage_logs.model`**（`:74`）：仅在 `prompt_meta` / `LlmStream` 已经抛错、随后走 error 日志的路径上发生（`backend/app/api/routes/ai.py:156-161`），s30 A03 实测 `label == "azure"`。属刻意取舍（不掩盖原始错误），但会污染 `model` 列的取值域。
4. **切换供应商须重启进程**：`_current()` 每次读 `settings.LLM_PROVIDER`（`:46`），但 `settings` 是 `lru_cache` 单例（`backend/app/core/config.py:142-147`），运行期改 env 不生效。是否需要支持热切换（如管理端配置中心覆盖）——**待确认**。
5. **`prompt()` 丢弃用量与耗时**（`:111-113` 只取 `.text`）：出题链路因此不写 `ai_usage_logs`、不消耗日额度（与 `.qoder/backend/app/services/ai_usage_service.py.md` §6.2「不被依赖」的记载一致）。按量计费下出题成本无法从用量表统计——是否要补记——**待确认**。
6. **`LlmStream` 是一次性对象**：`__iter__` 直接迭代 `self._impl`（`:146-148`），二次迭代会得到空序列（适配器内部的 HTTP 流已消费完）；现有唯一调用方只迭代一次（`backend/app/api/routes/ai.py:153`）。
7. **两套供应商能力不对等**（门面统一签名掩盖了差异）：cloudbase 下 `max_tokens` 与 `extra_body` 静默失效，故 `AI_MAX_OUTPUT_TOKENS` 硬截断与思考开关无效；首片延迟 8.6~16.7s vs 百炼 1.15~2.81s；`used_tokens` 量级不稳。明细见 `.qoder/backend/app/services/llm_cloudbase.py.md` §9。
8. 本文件无任何日志语句（未 import `logging`，`:23`）：provider 分派、重试与上游错误全部由适配器记日志，门面层无排障留痕（事实陈述）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/services/llm_service.py`（**3 个提交**：`b712d81`、`6a4dbb7`、`c660727`；`--follow` 止于 `c660727`，因该提交把文件重写、相似度低于改名跟踪阈值，但改名事实由 `c660727` 的提交信息「cloudbase_service 更名 llm_service」与 `docs/迭代记录.md` 该条目范围栏「`services/cloudbase_service.py` → `services/llm_service.py` 更名重写」双重记录）与 `docs/迭代记录.md` 对应条目，按时间倒序。更名前的历史（`ea58b6c`、`1600074`）见本节末。

### 2026-10-22（`b712d81`，见 `docs/迭代记录.md` 该提交条目）

- 需求：用户要求「把 AI key 切回之前那把，上线再用阿里这套」；直接 revert `c660727` 会连带杀掉 `6a4dbb7` 建成的 SSE 流式，故改为两套供应商并存、`LLM_PROVIDER` 一行切换。
- 修改内容：**本文件由 361 行的单文件实现重写为 152 行的门面**。① 删除全部协议实现（URL 解析、请求体组装、鉴权头、SSE 解析、错误码映射、重试循环），迁至新建的 `backend/app/services/llm_openai.py`；② `LlmError` / `CallResult` / 完整性校验下沉到新建的 `backend/app/services/llm_base.py`，本文件改为重导出（`:27`）以保持对外符号名不变；③ 新增 `PROVIDER_OPENAI` / `PROVIDER_CLOUDBASE` 常量与 `_ADAPTERS` 分派表（`:39-41`）、`_current()` / `_adapter()`（`:44-58`）、`is_configured()`（`:61-64`）、`model_label()`（`:67-74`，**刻意不抛异常**）；④ `LlmStream` 由「OpenAI 协议实现」改为**转发壳**（`:116-152`，构造时调 `_adapter().stream(...)`），流式不重试的语义与「构造即校验配置」的理由保留在 docstring（`:119-124`）；⑤ `prompt()` 保留出题链路叠加 `LLM_QUESTION_EXTRA_BODY` 的行为（`:102-113`）。配套：`backend/app/core/config.py` 新增 `LLM_PROVIDER`（`:72`）与 `LLM_TIMEOUT_SECONDS`（`:73`，两套共用）及 `CLOUDBASE_*` 配置段（`:87-93`）；`ai_chat_service.py`（4 处）与 `routes/ai.py`（1 处）把 `model=settings.LLM_MODEL` 改为 `model=llm_service.model_label()`，这两个文件**不再 import `settings`**（用途消失）；`backend/.env` 与 `.env.prod` 两套凭证常驻，当前 `LLM_PROVIDER=cloudbase`（`.env.prod` 就地标注上线前改回 `openai`）。
- 关联文件：新建 `backend/app/services/llm_base.py`、`llm_openai.py`、`llm_cloudbase.py`；改 `backend/app/core/config.py`、`ai_chat_service.py`、`routes/ai.py`、`models/models.py`（`:688-689` 记载 `model` 与 `used_tokens` 的新口径）、`ai_question_service.py`（出题提示词新增规则 11）、`backend/.env`、`backend/.env.prod`、`backend/design.md` §2 服务表；新增 `backend/test/s30_llm_provider_switch.py` 与 `backend/test/docs/s30-llm-provider-switch-report.md`；s25/s26/s28 三套改为 provider 感知。**无 SQL 迁移、无接口面增删、无前端/admin 变更。**
- 测试结果：据 `docs/迭代记录.md` 的 `b712d81` 条目——新增 **s30 23/23 PASS**（A 组分派与配置 6 项、B 组 openai 本地桩 7 项、C 组 cloudbase 本地桩 7 项、D 组真实调用 3 项；桩服务器为本地 `ThreadingHTTPServer` 同时模拟两协议、离线可重复，`LM_AI_SKIP_LIVE=1` 可跳 D 组）；回归 **s25 16/16**（A14 `generated=10 valid=10 batch_errors=[]`、A15 `generated=50 valid=50 unique_questions=50 batch_errors=[]`）、**s26 47/47**（L01 `reply_len=178 usedTokens=19832`）、**s28 13/13**（L01 `分片数=90 首片=16.72s 总耗时=18.91s stop_reason=end_turn`）。同条目备注①记三套脚本原写死 `settings.LLM_API_KEY` 判定「能否跑真实调用」，切到 cloudbase 后会整组静默跳过，已改为 provider 感知；备注②记**上线切换三步**（报告 §5.1）。报告 `backend/test/docs/s30-llm-provider-switch-report.md`。

### 2026-10-19（`6a4dbb7`，见 `docs/迭代记录.md` 该提交条目）

- 需求：AI 问答改为 SSE 真流式逐字回答（打字机渲染 + 中途停止），把首字延迟从整段耗时压下来。
- 修改内容（涉本文件，当时为百炼单供应商实现，361 行）：新增 `LlmStream` 逐块迭代器（该版本 `:260`，OpenAI `stream:true`，思考文本不展示不落库）与 `_check_complete()`（该版本 `:217`，后于 `b712d81` 下沉为 `llm_base.ensure_complete()`）；流式**不做自动重试**（增量可能已推给用户，重发会正文重复），「构造即校验配置」以便未配置类错误仍以普通 JSON + 502 返回。配套 `ai_chat_service` 拆出 `prepare_message` / `finalize_message` / `discard_message`，`routes/ai.py` 新增 `POST /api/ai/chat/stream`（事件序列 `start` → `delta`* → `done`，流内失败发 `error`；响应带 `X-Accel-Buffering: no` 关闭代理缓冲）。
- 关联文件：`backend/app/services/ai_chat_service.py`、`backend/app/api/routes/ai.py`、`backend/design.md`、新增 `backend/test/s28_ai_chat_stream.py` 与报告；前端 `frontend/services/request.js`（新增 `requestStream`）、`frontend/services/ai.js`、`frontend/pages/ai-chat/*`。
- 测试结果：据同条目——后端 **s28 13/13 PASS**（真实调用 L01 上游 36 片、首片 1.15s / 总 3.53s；L02 端点 50 片、增量拼接 == `done.reply` == 落库；中断两分支、与非流式同构、不泄密钥均过），`s26` 回归 exit 0，openapi **126 条路径**含新端点；前端离线传输层单测 17/17、微信开发者工具端到端 9/9（首字 1412ms / 总 9305ms）。备注记生产部署须关代理缓冲且 `proxy_read_timeout` 须大于 `LLM_TIMEOUT_SECONDS`（300s）。

### 2026-10-19（`c660727`，见 `docs/迭代记录.md` 该提交条目）

- 需求：AI 大模型供应商由腾讯云 CloudBase Agent（ACP 私有协议）迁移到阿里云百炼（OpenAI 兼容协议）。换供应商必须重写而非改配置——原实现绑定 ACP 的 JSON-RPC + SSE 流解析。
- 修改内容（涉本文件）：`backend/app/services/cloudbase_service.py` **更名重写**为本文件；协议整体替换为 `POST {base_url}/chat/completions`，删除逐行解析 SSE 拼接 `agent_message_chunk` 的 `_StreamState` / `_consume_line`（约 45 行），直接取 `choices[0].message.content`；系统提示由「前缀拼进用户输入」改为标准 `system` role；用量取 `usage.total_tokens`、正常结束原因由 `end_turn`/`stop_sequence` 改为 `stop`；异常 `CloudBaseError` → `LlmError` 并新增 `retryable` 标记；配置由 `CLOUDBASE_*` 五项收敛为 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_TIMEOUT_SECONDS`（180→300），并新增 `LLM_EXTRA_BODY` / `LLM_QUESTION_EXTRA_BODY` 透传供应商专有参数；`ai_usage_logs.error_code` 由 `cloudbase` 改为 `llm`。
- 关联文件：backend 共 18 个文件（`core/config.py`、`.env`、`.env.prod`、`models/models.py`、`ai_chat_service.py`、`ai_question_service.py`、`ai_config_service.py`、`routes/ai.py`、`routes/admin.py`、`routes/ai_admin.py`、`test/s25*`、`test/s26*`、`test/serve_sqlite.py`，新增 `test/docs/s27-llm-provider-migration-report.md`）；未改前端/管理端，无 SQL 迁移。
- 测试结果：据同条目——**s25 16/16 PASS**（A14 真实生成 10 道单选题、A15 真实生成 50 道题 `unique_questions=50 batch_errors=[]`）、**s26 47/47 PASS**（L01 `status=200 reply_len=152 usedTokens=383`）；改动文件 `py_compile` 全通过；`import app.main` + `app.openapi()` **125 条路径**、18 条 AI 路由与迁移前一致；全仓 grep 无 `CloudBase`/`cloudbase` 残留。报告 `backend/test/docs/s27-llm-provider-migration-report.md`。备注①记**用量口径不可跨期比较**（迁移前同场景 19989、迁移后 383）；备注②记 API Key 已入 git 历史、建议在百炼控制台重置（**该 Key 现已实测 401 失效**，见 §9 第 2 条）。**本次提交未同步 `.qoder/`**：原 `.qoder/backend/app/services/cloudbase_service.py.md` 随源文件失效但一直未删，本文件也一直缺档（`.qoder/PROJECT.md` §10「仍缺档（13 份，待补）」表第 1 项），两者均在 `b712d81` 之后的本次建档任务中处理（新建 4 份 + 删除失效的 1 份）。

### 更名前的历史（`backend/app/services/cloudbase_service.py`，供追溯）

`git log --follow --oneline -- backend/app/services/cloudbase_service.py` 实测 3 条（`c660727`、`1600074`、`ea58b6c`）：

- `1600074`（2026-10-17）：AI 智能中心 Phase A。在 `cloudbase_service.py` 内拆出 `_request_once` + `prompt_meta`，新增 `CallResult` / `_StreamState` / `retryable` 与重试退避，把用量与耗时带回上层落 `ai_usage_logs`。验证记 s26 47/47（含真实 Agent 调用 L01：reply 143 字、usedTokens=19715）。
- `ea58b6c`（2026-10-16）：题库接入 CloudBase Agent AI 出题，**创建** `cloudbase_service.py`，封装 ACP 协议调用（JSON-RPC `session/prompt` + SSE，累积 `agent_message_chunk` 文本、`stopReason` 终止），当时对外只有 `prompt(text, timeout) -> str`。验证记 s25 16/16（含真实 Agent 生成 10 题与 50 题）。
- 该文件的 ACP 实现在 `b712d81` 被恢复为 `backend/app/services/llm_cloudbase.py`（详见 `.qoder/backend/app/services/llm_cloudbase.py.md` §10）。
