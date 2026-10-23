# llm_base.py

## 1. 文件路径

`backend/app/services/llm_base.py`（54 行）

## 2. 文件职责

大模型适配层的**供应商无关共用类型**：`LlmError`（上游故障的统一异常，带 `retryable` 标记）、`CallResult`（一次成功调用的正文 / 用量 / 结束原因 / 耗时）、`ensure_complete()`（截断与空回复都不作为成功结果上抛）。

单独成模块的理由写在模块 docstring（`backend/app/services/llm_base.py:3-4`）：门面 `llm_service` 需要 import 各供应商适配器，适配器又要共用同一套异常与结果结构；若把这两个类型定义在门面里，就会形成 `llm_service` ↔ 适配器 的**循环 import**。本文件因此不含任何 HTTP、配置读取与数据库依赖——import 只有 `dataclasses` 与 `typing`（`:12-13`）。

## 3. 业务需求

- 需求来源：`b712d81`（2026-10-22）把 AI 上游改为「门面 + 适配器」的可切换双供应商结构（`LLM_PROVIDER` = `openai` / `cloudbase`），见 `docs/迭代记录.md` 的 `b712d81` 条目。门面与两个适配器必须共用同一份类型定义，本文件即该公共层。
- **「同一个类对象」是硬需求，不是风格偏好**：路由层靠 `isinstance` / `except` 把上游故障映射为 502（`backend/app/api/routes/ai.py:56-57`、`backend/app/api/routes/admin.py:585-587`），适配器抛的异常与门面重导出的必须是同一个类，否则判定静默失效。s30 冒烟对此有直接断言（`backend/test/s30_llm_provider_switch.py:243-246`：`llm_service.LlmError is llm_base.LlmError is llm_openai.LlmError is llm_cloudbase.LlmError`，以及门面构造的 `CallResult` 是 `llm_base.CallResult` 的实例）。
- `ensure_complete()` 的存在理由（`:46-47`）：截断意味着出题链路的 JSON 必然不完整、对话链路只给出半截回答，两者都不可用；空回复多为上游瞬时异常。两家供应商「正常结束」的取值不同（OpenAI 兼容协议为 `stop`，ACP 为 `end_turn` / `stop_sequence`），故白名单由适配器传入（`:9-10`），本文件不硬编码任一供应商的取值。
- 导航层出处（本文档只回指、不复制正文）：`.qoder/ARCHITECTURE.md` §11.1「外部集成」（已按「门面 + 双适配器」口径重写并收录本文件）、`.qoder/REQUIREMENTS.md` §10.4「多轮对话实现方式」、`.qoder/CHANGELOG.md` §2.14、`.qoder/decisions/README.md` §1.7。

## 4. 核心功能

### 4.1 符号清单

| 名称 | 行号 | 说明 |
|---|---|---|
| 模块 docstring | `:1-11` | 成模块理由（打破循环 import）+ 三个符号的职责 |
| `LlmError(ValueError)` | `:16-25` | 所有上游故障（配置缺失、鉴权失败、超时、5xx、回复截断）的统一异常类型 |
| `LlmError.__init__(message, *, retryable=False)` | `:23-25` | `retryable` 为**仅限关键字**参数 |
| `CallResult`（`@dataclass`） | `:28-40` | 一次成功调用的结果，供上层落 `ai_usage_logs` |
| `ensure_complete(result, normal_stop_reasons)` | `:43-54` | 完整性校验；返回 `None`，不合格即抛 `LlmError` |

### 4.2 `LlmError`（`:16-25`）

- 继承 `ValueError`（`:16`）。`:7` 明确「继承 ValueError 以便路由层沿用既有映射，但需**先于** `ValueError` 捕获以映射为 502」——实际捕获顺序见 `backend/app/api/routes/ai.py:42-47`（`AI_ERRORS` 元组把 `LlmError` 排在 `ValueError` 之前）与 `backend/app/api/routes/admin.py:585-589`（`except llm_service.LlmError` 在 `except ValueError` 之前）。
- `retryable` 判定口径写在 `:19-20`：`True` 表示瞬时故障（超时 / 5xx / 429 / 网络 / 空回复），可重试；配置缺失、鉴权失败、欠费、回复截断等重试无益，标记为不可重试。
- `self.retryable`（`:25`）是两个适配器重试循环的唯一判据：`backend/app/services/llm_openai.py:232-234`、`backend/app/services/llm_cloudbase.py:240-242`。**流式路径不读该标记**（两条流式实现都不重试）。

### 4.3 `CallResult`（`:28-40`）

| 字段 | 类型 | 默认 | 行号 | 说明 |
|---|---|---|---|---|
| `text` | `str` | 无（必填） | `:37` | 拼接并 strip 后的完整正文 |
| `used_tokens` | `Optional[int]` | `None` | `:38` | 用量；上游未报告时为 `None` |
| `stop_reason` | `str` | `""` | `:39` | 上游报告的结束原因原值 |
| `elapsed_ms` | `int` | `0` | `:40` | 本次 HTTP 往返耗时 |

`used_tokens` 的口径随供应商而异，`:33-34` docstring 明写：OpenAI 兼容协议取 `usage.total_tokens`（输入+输出，与按量计费一致）；CloudBase 取平台 `usage_update.used` **原值**，「含义未经核实，如实记录不换算」。实测佐证：`backend/test/docs/s30-llm-provider-switch-report.md` §3 记录同一供应商、同量级提问下 CloudBase 侧数值为 254 / 19400 / 19641 / 19832，量级差近 80 倍，**不可作单次计费依据**；百炼同场景为 147 / 383。

### 4.4 `ensure_complete(result, normal_stop_reasons)`（`:43-54`）

两条校验，顺序即代码顺序：

1. **截断**（`:49-52`）：`result.stop_reason` **非空**且不在白名单 → 抛**不可重试** `LlmError`，文案「AI 回复未正常结束（{stop_reason}），请缩短输入或减少单次生成数量后重试」。文案中回显上游 `stopReason` 原文（英文枚举值，非敏感）。`stop_reason` 为空串时**跳过**本检查——上游未报告结束原因不视为截断（客户端打断的流式收尾即属此情形，见 `backend/app/api/routes/ai.py:99-101`）。
2. **空回复**（`:53-54`）：`result.text` 为空 → 抛**可重试** `LlmError`「AI 服务返回空内容，请重试」。

调用点共 3 处（两个适配器、三种模式）：

| 调用方 | 行号 | 传入的白名单 |
|---|---|---|
| `backend/app/services/llm_openai.py`（非流式 `_request_once`） | `:206` | `_NORMAL_STOP_REASONS = ("stop",)`（`llm_openai.py:34`） |
| `backend/app/services/llm_openai.py`（流式 `OpenAiStream.__iter__` 收尾） | `:328` | 同上 |
| `backend/app/services/llm_cloudbase.py`（`_finish`，非流式与流式共用） | `:186` | `_NORMAL_STOP_REASONS = ("end_turn", "stop_sequence")`（`llm_cloudbase.py:37`） |

## 5. 输入与输出

- 本文件**无 HTTP 端点、无配置读取、无数据库访问**，是纯类型与校验工具模块。
- `ensure_complete`：入参 `result: CallResult` + `normal_stop_reasons: Tuple[str, ...]`（`:43`）；返回 `None`；不合格抛 `LlmError`。
- `LlmError`：构造形式 `LlmError(message)` 或 `LlmError(message, retryable=True)`；`str(exc)` 即面向终端用户的中文文案。
- `CallResult` 由适配器以关键字参数构造（`llm_openai.py:125-130`、`:322-327`；`llm_cloudbase.py:180-185`），消费方：
  - `backend/app/services/ai_chat_service.py:275`（`finalize_message` 的类型注解）、`:285-288`（取 `text` / `used_tokens` 落 `ai_messages`）、`:295-296`（落 `ai_usage_logs` 的 `used_tokens` / `elapsed_ms`）、`:537`（答题解析成功日志）；
  - `backend/app/api/routes/ai.py:99-101`（客户端断开且流未产出 `result` 时**手工兜底构造**一个 `CallResult`，`used_tokens=None` / `stop_reason=""` / `elapsed_ms=0`）、`:166`、`:171-172`（`done` 事件取 `used_tokens` / `text`）；
  - 测试脚本以门面重导出的名字构造（`backend/test/s26_ai_center.py:127`、`backend/test/s28_ai_chat_stream.py:166`、`:182`、`backend/test/s30_llm_provider_switch.py:245`）。
- **异常文案原样透传给小程序与管理后台**（`backend/app/api/routes/ai.py:57`、`backend/app/api/routes/admin.py:587`），故本文件的两条文案都是面向终端用户的中文，不含 URL、请求体、密钥与堆栈。
- 失败路径**不构造** `CallResult`，因此 `ai_usage_logs.elapsed_ms` 对 `status='error'` 记录恒为 NULL（`backend/app/services/ai_chat_service.py:352` 显式传 `None`）。

## 6. 依赖关系

### 6.1 依赖

- 标准库：`dataclasses.dataclass`（`:12`）、`typing.Optional` / `Tuple`（`:13`）。
- **无第三方库、无项目内 import**：不 import `settings`、不 import 适配器、不 import ORM。这是它能被门面与两个适配器同时共用而不产生循环的前提。
- 数据库表：无。

### 6.2 被谁依赖

实测命令：`grep -rn "llm_base" backend/`。

| 依赖方 | 位置 | 用到的符号 |
|---|---|---|
| `backend/app/services/llm_service.py` | import `:27`；重导出并列入 `__all__` `:29-37`；`:54` 抛 `LlmError` | `CallResult`、`LlmError` |
| `backend/app/services/llm_openai.py` | import `:28`；抛出 `:58`、`:65`、`:72`，构造并返回 `:84-93`；构造结果 `:125-130`、`:322-327`；校验 `:206`、`:328` | `CallResult`、`LlmError`、`ensure_complete` |
| `backend/app/services/llm_cloudbase.py` | import `:28`；抛出 `:72`、`:81`、`:130`，构造并返回 `:87-95`；构造结果 `:180-185`；校验 `:186` | 同上 |
| `backend/test/s30_llm_provider_switch.py` | import `:60`；类型同一性断言 `:243-246` | `LlmError`、`CallResult` |
| `backend/app/models/models.py` | `:688` docstring 提及 `used_tokens` 口径出处（**非 import**） | — |

**业务层（`services/` 与 `api/routes/`）无任何文件直接 import `llm_base`**——一律经门面 `llm_service` 取符号（上表即全部命中）。这一分层是本文件的隐含约束（见 §8）。

## 7. 业务规则

1. **异常类型唯一**：全链路只认 `LlmError`；`retryable` 只影响适配器是否重试，不对外暴露、不写进 HTTP 响应体。
2. **「未正常结束」与「空回复」都不算成功**（`:44-48`）：出题链路的 JSON 必然不完整、对话链路只给半截回答，两者都不可用，因此以异常而非「返回残缺 `CallResult`」的方式表达。
3. **空回复归为瞬时故障**（`retryable=True`，`:54`），非流式路径会按 `settings.AI_MAX_RETRIES` 重试；**截断归为不可重试**（`:50-52`），重试只会再次截断。
4. **`stop_reason` 为空即不判截断**（`:49` 的 `and result.stop_reason`）：上游未报告结束原因（如客户端打断后的兜底构造）不应被误判为截断。
5. **用量不做跨供应商换算**：`used_tokens` 一律为上游原值（`:33-34`）。因此 `ai_usage_logs.used_tokens` 的历史数据**跨供应商不可直接比较**，成本统计须按供应商分段——与 `docs/迭代记录.md` 的 `c660727` 条目备注①「用量口径不可跨期比较」同口径。
6. **正常结束原因白名单属供应商知识**，只存在于适配器（`llm_openai.py:34`、`llm_cloudbase.py:37`），本文件只接受入参。

## 8. 修改约束

- **不得把这三个符号移回门面 `llm_service.py`**：`:3-4` 记录的循环 import 会立即发生（门面 import 适配器，适配器 import 门面取类型）。
- **不得改名、不得另立同义类型**。既有引用点全部按现名硬编码：
  - `isinstance` / `except`：`backend/app/api/routes/ai.py:56`、`backend/app/api/routes/admin.py:585`、`backend/app/services/ai_chat_service.py:348`、`:525`；
  - 测试直接构造：`backend/test/s25_ai_question_generate.py:245-248`、`backend/test/s26_ai_center.py:412`、`:639`、`backend/test/s28_ai_chat_stream.py:322`；
  - 类型同一性断言：`backend/test/s30_llm_provider_switch.py:243-246`。
  改名或复制定义会让这些断言**静默失效**（脚本仍绿，但不再覆盖真实行为）。
- `retryable` 必须保持**仅限关键字**（`:23`）：测试脚本以 `LlmError(msg, retryable=True)` 形式构造，改成位置参数会破坏调用点语义。
- `LlmError` 必须继续继承 `ValueError`（`:16`）：`backend/app/api/routes/ai.py:42-47` 的 `AI_ERRORS` 依赖「子类先于 `ValueError` 判定」给出 502；换基类会把上游故障漏成 400。
- `ensure_complete` 的白名单**只能由适配器传入**（`:43`），不得在本文件写死 `stop` 或 `end_turn`，否则新增供应商必须改动本文件，破坏「新增供应商只加一个适配器模块」的扩展点（`backend/app/services/llm_service.py:13`）。
- `CallResult` 的 4 个字段被 `ai_chat_service.finalize_message`（`:281-297`）与 `routes/ai.py` 的 `done` 事件（`:171-172`）逐字段消费；**新增字段必须给默认值**，删改字段名属破坏性变更。
- **本文件不得引入 `settings`、httpx 或 ORM 依赖**：一旦读配置，「供应商无关」即失效，且两个适配器会因配置解析差异分叉。
- 异常文案直达终端用户：不得把 URL、请求体、响应体、密钥、堆栈写进 message（与 `llm_openai.py:18`、`llm_cloudbase.py:17` 的安全约定一致）。
- 本文件属 `backend/app/**`，改动后须按 `.qoder/README.md` §3.4 同步更新本文档的「核心功能 / 业务规则 / 当前实现状态」并追加「迭代记录」。

## 9. 当前实现状态

### 已实现

- 三个符号齐备，被门面与两个适配器共用（§6.2 实测表）；类型同一性由 s30 A 组实测断言（`backend/test/docs/s30-llm-provider-switch-report.md` §4「A 分派与配置」行）。
- `ensure_complete` 在两条协议、流式与非流式共 3 个调用点生效（§4.4 表）；s30 B 组验证 `finish_reason=length` 与空正文、C 组验证 `stopReason=max_tokens` 与空正文（同报告 §4「B openai 适配器（本地桩）」「C cloudbase 适配器（本地桩）」行）。

### 存在问题 / 限制

1. ~~**导航层文档滞后**~~ **已修正（2026-10-22，同批文档提交）**：`.qoder/ARCHITECTURE.md` §11.1「外部集成」已重写为「门面 + 双适配器 + `LLM_PROVIDER` 分派」口径并收录本文件（配置项名同时更正为 `CLOUDBASE_AGENT_URL`，`backend/app/core/config.py:93`）；`.qoder/REQUIREMENTS.md` §10.2「运行时默认值」已把 `CLOUDBASE_TIMEOUT_SECONDS` 替换为两套共用的 `LLM_TIMEOUT_SECONDS`；§10.4「多轮对话实现方式」已改引 `ai_chat_service.py:138` 与两家适配器的 system 注入差异。`.qoder/decisions/README.md` §1.7 已补「门面 + 双适配器」与「`llm_base` 打破循环导入」两条决策索引。
2. **CloudBase 侧 `used_tokens` 口径待确认**：`:33-34` 自认「含义未经核实」，s30 报告 §3 实测数值在 254 与 1.9 万之间跳动，疑似包含 Agent 侧知识库/会话累计口径。是否要按供应商做归一化或标注——**待确认**。
3. `elapsed_ms` 默认 `0` 而非 `None`，无法区分「耗时 0ms」与「未测量」；当前失败路径不构造 `CallResult`，问题未暴露（事实陈述）。
4. `ensure_complete` 只在**迭代正常结束后**调用：流式被消费方提前 `break` 时不校验（`llm_openai.py:322-328`、`llm_cloudbase.py:299` 均在循环之后），属刻意设计（提前退出的收尾由 `backend/app/api/routes/ai.py:86-107` 的 `_settle_aborted` 处理）。

## 10. 迭代记录

数据来源：`git log --oneline -- backend/app/services/llm_base.py`（**仅 1 个提交**，本文件为 `b712d81` 新建，此前不存在）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-22（`b712d81`，见 `docs/迭代记录.md` 该提交条目）

- 需求：用户要求「把 AI key 切回之前那把，上线再用阿里这套」。因 `c660727` 已把 ACP 实现整块删除、其后 `6a4dbb7` 又在 OpenAI 兼容层上建成 SSE 流式对话，直接 revert 会连带杀掉流式功能，故改为**两套供应商并存、`LLM_PROVIDER` 一行切换**的门面 + 适配器结构；本文件是该结构必需的公共类型层（打破「门面 ↔ 适配器」循环 import，并使两条链路的 `isinstance` 判定指向同一个类对象）。
- 修改内容：**新建本文件（54 行）**。把原先位于 `llm_service.py`（`6a4dbb7` 版）内的三个定义下沉为供应商无关模块——`LlmError`（保留 `retryable` 仅限关键字参数）、`CallResult`（4 字段不变，docstring 补记两家 `used_tokens` 口径差异）、以及原 `_check_complete()`（该提交版本 `git show 6a4dbb7:backend/app/services/llm_service.py` 的 `:217`）改名为 `ensure_complete()`，并把「正常结束原因白名单」由模块常量改为**入参**，使同一函数能同时服务 `("stop",)` 与 `("end_turn", "stop_sequence")` 两套口径。门面 `backend/app/services/llm_service.py:27` 从本模块重导出 `LlmError` / `CallResult`，对外符号名保持不变。
- 关联文件：`backend/app/services/llm_service.py`（重写为门面）、`backend/app/services/llm_openai.py`（新建，原实现迁入）、`backend/app/services/llm_cloudbase.py`（新建，从 `c660727^` 恢复 ACP 实现并补流式）、`backend/app/core/config.py`（新增 `LLM_PROVIDER`、`LLM_TIMEOUT_SECONDS` 与两套配置段）、`backend/app/services/ai_chat_service.py` / `backend/app/api/routes/ai.py` / `backend/app/models/models.py`（用量日志 model 标识改取 `model_label()`）、`backend/.env` 与 `backend/.env.prod`、新增 `backend/test/s30_llm_provider_switch.py`。
- 测试结果：据 `docs/迭代记录.md` 的 `b712d81` 条目——新增 **s30 23/23 PASS**，A 组 6 项含「门面与适配器类型同一」「两家 `model_label` 正确」「缺 Key 时在发请求前就抛错」；B 组 7 项含 `finish_reason=length` 映射与「空正文按『返回空内容』且 `retryable=True`」；C 组 7 项含 `stopReason=max_tokens` 判为未正常结束、空正文可重试。回归 **s25 16/16**、**s26 47/47**、**s28 13/13**。报告 `backend/test/docs/s30-llm-provider-switch-report.md`。

### 相关但不改本文件的提交（供追溯）

- `c660727`（2026-10-19）：AI 供应商由腾讯云 CloudBase Agent 迁到阿里云百炼，`cloudbase_service.py` 更名 `llm_service.py`，异常 `CloudBaseError` → `LlmError` 并新增 `retryable` 标记——本文件承接的正是该版本引入的两个类型（当时仍定义在 `llm_service.py` 内）。
- `6a4dbb7`（2026-10-19）：AI 问答改 SSE 真流式，`llm_service.py` 新增 `LlmStream` 与 `_check_complete()`（本文件 `ensure_complete()` 的前身）。
- `1600074`（2026-10-17）：AI 智能中心 Phase A，在 `cloudbase_service.py` 内首次引入 `CallResult` 与 `retryable`（本文件两个类型的原始出处）。
