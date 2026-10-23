# ai_usage_service.py

## 1. 文件路径

`backend/app/services/ai_usage_service.py`（70 行）

## 2. 文件职责

AI 调用计数与限额服务：按**北京时间当日**统计 `ai_usage_logs` 中 `status='success'` 的记录，实现「单用户日限额」与「全站日限额」两道调用前闸门，并在每次模型调用后写入一条用量日志（成功/失败）。模块 docstring（`backend/app/services/ai_usage_service.py:1-6`）明确计数口径为「只统计真正完成模型调用的成功记录；失败或被拒不计入限额」，并声明日志**只记 user_id/feature/token/耗时/错误码，不含 API Key、JWT 或敏感个人资料**。

## 3. 业务需求

- 需求来源：《长征步迹 AI 智能中心开发需求 V1.0》Phase A——普通用户每天模型调用次数上限（防滥用）与全站每天调用上限（**防成本失控**），见 `backend/app/core/config.py:104-105` 注释、`.qoder/REQUIREMENTS.md` §10.2。后端提交 `1600074`（2026-10-17）。
- 用量/成本统计页属**待开发**（`.qoder/ARCHITECTURE.md` §11.3、`.qoder/REQUIREMENTS.md` §10.6「usage / cost 统计页」行原文：「usage / cost 统计页 ｜ **待开发**（ai_usage_logs 表已建、写入侧 ai_usage_service.py 已实现；**读取侧接口未实现**，见本表「运行概览 / 调用记录」行）」；引文中的 ai_usage_service.py 即本文件 `backend/app/services/ai_usage_service.py`，原文写的是裸文件名，此处按 `.qoder/README.md` §3 引用规范展开）。本文件当前只承担**计数与写入**，不承担任何对外查询接口。
- 自然日口径与全项目一致：每日步数、答题、积分、限额统一按北京时间当日（`backend/app/core/helpers.py:1-5` 模块 docstring、`:22-24`）。

## 4. 核心功能

### 4.1 符号清单

| 名称 | 行号 | 说明 |
|---|---|---|
| `logger` | `:17` | 模块级 logger；**本文件当前无任何日志输出语句**（`:7` 导入 `logging` 仅为取 logger） |
| `AiLimitError(ValueError)` | `:20-21` | 超出日调用限额；docstring 注明「路由层映射为 429，返回『今日次数已用完』等明确提示」 |
| `count_today(db, user_id=None)` | `:24-32` | 统计当日成功调用数：`user_id` 非空为该用户，否则为全站 |
| `check_limits(db, cfg, user_id)` | `:35-42` | 调用前限额校验，超限抛 `AiLimitError` |
| `record(db, *, feature, ...)` | `:45-70` | 写入一条调用日志（**不提交**，由调用方随业务事务一起 commit，`:57` docstring） |

### 4.2 `count_today`（`:24-32`）

```text
SELECT count(ai_usage_logs.id)
WHERE day_key = <北京时间当日 YYYY-MM-DD> AND status = 'success' [AND user_id = :user_id]
```

- 日期由 `today_str()`（`:26`）取得，实现见 `backend/app/core/helpers.py:22-24` → `now_beijing()`（`:17-19`）→ 固定偏移 `BEIJING_TZ = timezone(timedelta(hours=8))`（`:9`）。**是北京时间当日，不是 UTC**；与模块 docstring `:3-4`、`backend/app/models/models.py:687`（「day_key 为北京时间当日 YYYY-MM-DD」）三处一致。因用固定偏移而非 `zoneinfo`，不依赖服务器本地时区与 tzdata（`backend/app/core/helpers.py:3-4`）。
- 只筛 `status == "success"`（`:28`），**不按 feature 过滤**（见 §7 第 2 条）。
- `int(query.scalar() or 0)`（`:32`）兜住 `count()` 理论上的 `None`。
- 索引匹配：带 `user_id` 时命中 `ix_ai_usage_user_day (user_id, day_key)`，全站计数命中 `ix_ai_usage_day (day_key)`（`backend/app/models/models.py:694-697`；DDL `docker/init/021_ai_center.sql:116-121`）。**`b712d81` 只改了 `AiUsageLog` 的 docstring，表结构/列/索引零变化，故索引匹配结论不变。**

### 4.3 `check_limits`（`:35-42`）

判定顺序与语义（`:36` docstring「用户限额优先，其次全站」）：

1. `cfg.chat_daily_limit > 0` 且 `count_today(db, user_id) >= cfg.chat_daily_limit` → `AiLimitError("今日 AI 提问次数已用完，请明天再来")`（`:37-39`）。
2. `cfg.global_daily_limit > 0` 且 `count_today(db) >= cfg.global_daily_limit` → `AiLimitError("当前 AI 使用人数较多，请稍后再试")`（`:40-42`）。
3. **`limit <= 0` 视为不限**（两个 `if` 的外层条件即 `> 0`），因此管理端把限额改成 0 就等于关闭该项限制。

`cfg` 为 `AiConfig` 快照（类型从 `backend/app/services/ai_config_service.py:15` 导入，`:35` 入参），由调用方传入，本函数**不自行查配置**，避免重复读 `system_settings`。

### 4.4 `record`（`:45-70`）

- 除 `db` 外全部为**关键字-only 参数**（`:47` 的 `*`）：`feature`（必填）、`user_id`、`conversation_id`、`model`、`used_tokens`、`elapsed_ms`、`status="success"`（`:54`）、`error_code`。
- 组装 `AiUsageLog`（`:58-68`），`day_key=today_str()`（`:67`）与计数口径同源，**写入时的日期不取调用方传参**，因此跨零点的调用会落到调用发生那一刻的北京时间日期。
- `db.add(row)`（`:69`）后 `return row`（`:70`）；**不 flush、不 commit**（`:57`）。由于 `SessionLocal` 为 `autoflush=False`（`backend/app/core/database.py:51`），返回的 `row.id` 在调用方 flush/commit 前为 `None`；现有 **5 个调用点**均未使用返回值。

### 4.5 调用点与事务边界（谁 commit）

本模块**只写不提交**。提交发生在调用方：非流式在 `backend/app/services/ai_chat_service.py`，**流式在 `backend/app/api/routes/ai.py` 的 SSE 生成器内（该生成器自建 `SessionLocal()`，`:141`）**。下表行号属同行「场景」所列文件：

| 场景 | `check_limits` | `record` | commit 位置 | 说明 |
|---|---|---|---|---|
| 历史助手对话成功（非流式与流式共用） | `backend/app/services/ai_chat_service.py:224`（`prepare_message`） | `backend/app/services/ai_chat_service.py:293-297`（`finalize_message`：`status="success"`、带 `conversation_id`、`used_tokens`、`elapsed_ms`） | `:298` | 与 assistant 消息、`conv.updated_at` 同事务 |
| 历史助手对话上游故障（非流式） | 同上（`:224`） | `backend/app/services/ai_chat_service.py:350-353`（`status="error"`、`error_code="llm"`、`elapsed_ms=None`、无 `conversation_id`） | `:354` | **`6a4dbb7` 起先 `discard_message(db, turn)`（`:349`）显式删除已 commit 的用户消息与空会话，再单独记 error 日志并提交**；随后裸 `raise`（`:355`）→ 路由映射 502。改造前这里是 `db.rollback()` |
| 历史助手对话上游故障（**流式**，新增） | 同上（`prepare_message:224`，在开流之前） | `backend/app/api/routes/ai.py:158-161`（`feature=FEATURE_CHAT`、`model=llm_service.model_label()`、`status="error"`、`error_code="llm"`） | `backend/app/api/routes/ai.py:162` | 先 `discard_message`（`:157`）；HTTP 状态码已是 200，失败只能以 SSE `error` 事件下发（`:164`）。客户端断连走 `_settle_aborted`（`:86-107`） |
| 答题解析（题库无解析，调模型）成功 | `backend/app/services/ai_chat_service.py:508` | `backend/app/services/ai_chat_service.py:535-538`（`feature=quiz_explanation`、无 `conversation_id`） | `:539` | 题库已有解析时在 `:504-505` 提前 return，**不校验限额、不写日志** |
| 答题解析上游故障 | 同上（`:508`） | `backend/app/services/ai_chat_service.py:527-530`（`status="error"`、`error_code="llm"`，`elapsed_ms` 用默认 `None`） | `:531` | **仍先 `db.rollback()`（`:526`）**——本函数不写会话表，无需 `discard_message` |

**`model` 字段五处均传 `llm_service.model_label()`**（`backend/app/services/ai_chat_service.py:295`、`:351`、`:528`、`:536`，流式在 `backend/app/api/routes/ai.py:160`）。`c660727`/`b712d81` 之后语义已变：**不再是硬编码的 Agent ID**，而是「当前生效上游的模型标识」——`LLM_PROVIDER=openai` 时为真实模型名（`settings.LLM_MODEL`，`backend/app/core/config.py:77`），`LLM_PROVIDER=cloudbase` 时仍是 Agent ID（ACP 协议不暴露模型名）。取值实现 `backend/app/services/llm_service.py:67-74`（**provider 非法时原样返回、不抛异常**），字段语义见 `backend/app/models/models.py:689-690`。**因此该列的历史数据跨供应商不可直接聚合。**

## 5. 输入与输出

- 入参：`db: Session`（`Depends(get_db)`，`backend/app/core/database.py:58-64`）；`cfg: AiConfig`（`backend/app/services/ai_config_service.py:28-40`）；`user_id: int`（`check_limits` 必填，来自 JWT 用户，不接受客户端指定）。
- 返回：`count_today` → `int`；`check_limits` → `None`（无超限即静默通过）；`record` → 未提交的 `AiUsageLog` ORM 实例。
- 异常：`AiLimitError`（`:39`、`:42`），消息文案即面向用户的中文提示。
- 错误码映射：`backend/app/api/routes/ai.py:42-47` 把 `AiLimitError` 放进 `AI_ERRORS` 联合类型，`ai_http_error`（`:50-58`）在 `AiDisabledError` 之后、`ValueError` 之前判定 → **429**；同元组内的 `LlmError` → **502**（`:56-57`，`c660727` 前为 `CloudBaseError`）。管理端 AI 路由复用同一映射（`backend/app/api/routes/ai_admin.py:15`、`:224-225`）。
- 无 HTTP 端点直接暴露本模块：全仓无任何读取 `ai_usage_logs` 的接口（`AiUsageLog` 的引用点只有 `backend/app/models/models.py:683` 与本文件 `:14`、`:27-31`、`:56-58`）。
- 小程序侧对 429 的呈现：`frontend/pages/ai-chat/ai-chat.js` 把 403/429 转为顶部常驻提示条（见 `.qoder/REQUIREMENTS.md` §10.1 与 `docs/迭代记录.md` 提交 `0052108` 条目）。**流式端点（`6a4dbb7` 新增）的 429 仍在响应头之前抛出**（`check_limits` 位于 `prepare_message`，`backend/app/api/routes/ai.py:127-129`），故状态码语义与非流式一致。

## 6. 依赖关系

### 6.1 依赖

- 标准库：`logging`（`:7`）、`typing.Optional`（`:8`）。
- 第三方：`sqlalchemy.func`（`:10`）、`sqlalchemy.orm.Session`（`:11`）。
- 项目内：`app.core.helpers.today_str`（`:13`）、`app.models.models.AiUsageLog`（`:14`）、`app.services.ai_config_service.AiConfig`（`:15`，**仅类型导入**，不调用其任何函数）。
- 数据库表：`ai_usage_logs`（模型 `backend/app/models/models.py:683-709`；DDL `docker/init/021_ai_center.sql:78-90`；索引 `:116-121`）。列为 `id`(SERIAL PK)、`user_id`、`conversation_id`、`feature VARCHAR(30) NOT NULL`、`model VARCHAR(64)`、`used_tokens`、`elapsed_ms`、`status VARCHAR(16) NOT NULL DEFAULT 'success'`、`error_code VARCHAR(50)`、`day_key VARCHAR(10) NOT NULL`、`created_at`。`user_id`/`conversation_id` 为**逻辑外键**（DDL 无 FOREIGN KEY 约束，见 `.qoder/backend/app/models/models.py.md` §4.7）。**列清单在 `b712d81` 后无任何变化（只改了 docstring），故无 SQL 迁移。**
- 无第三方 HTTP 依赖：**不调任何 LLM 上游**（既不 import `llm_service`，也不 import 两个适配器 `llm_openai`/`llm_cloudbase`；`c660727` 前文中写作「不调 CloudBase」，现上游已可切换，措辞随之改为供应商无关）。

### 6.2 被谁依赖

（下表「位置」列的行号均属同行「依赖方」列的文件。）

| 依赖方 | 位置 | 用到的符号 |
|---|---|---|
| `backend/app/services/ai_chat_service.py` | `:37`（import）、`:224`、`:293`、`:350`、`:508`、`:527`、`:535` | `check_limits`、`record` |
| `backend/app/api/routes/ai.py` | `:30-35`（import 段内含本模块）、`:42-47`、`:50-58`、`:158-161` | `AiLimitError`（429 映射）、**`record`（流式失败留痕，`6a4dbb7` 新增调用点）** |
| `backend/test/s26_ai_center.py` | 经 HTTP 间接覆盖（H11 `:409`、H10 `:432`、H13/H14 `:452`）；**无脚本直接 import 本模块** | — |

**不被依赖**：`backend/app/services/ai_question_service.py`（其服务导入行 `backend/app/services/ai_question_service.py:22` 为 `from app.services import admin_service, ai_knowledge_service, llm_service`，不含本模块）、`backend/app/api/routes/ai_admin.py`（import 段不含本模块）——即 **AI 出题与题目工坊不写用量日志、不消耗日额度**。

## 7. 业务规则

1. **计数口径 = 北京时间当日 + `status='success'`**（`:26-29`）。失败记录（`status='error'`）与被闸门拒绝的请求（403 未开放、429 超限、400 参数错）**都不计入限额**（`:4-5` docstring），因此上游故障不会白白吃掉用户额度。
2. **限额是「跨 feature 共享」的**：`count_today` 只按 `day_key`/`status`/`user_id` 过滤，不区分 feature。配置项名为 `AI_CHAT_DAILY_LIMIT`（`backend/app/core/config.py:104`「普通用户每天最多模型调用次数」），实际同时约束**历史助手对话**与**无解析时的答题解析**两类调用，二者共用同一份每日额度。
3. **判定顺序**：用户限额先于全站限额（`:37-42`），文案不同以便前端区分「自己用完了」与「系统繁忙」。
4. **`limit <= 0` 即不限**（`:37`、`:40`）；上限受配置中心范围约束（`ai_chat_daily_limit` 0~100000、`ai_global_daily_limit` 0~1000000，`backend/app/services/ai_config_service.py:47-48`）。
5. **闸门在调用前、计数在调用后**：`check_limits` 在拼提示词与调模型之前执行（`backend/app/services/ai_chat_service.py:224` 早于 `:341`；流式同样在 `prepare_message` 内、**开流之前**），成功日志在拿到回复之后写入（`:293-297`）。**无预扣/无行锁**，同一用户的并发请求可能全部通过校验后再各自写入，导致实际次数略超限额（见 §9 第 1 条）。
6. **日志内容最小化**：只写 user_id / conversation_id / feature / model（**当前生效上游的模型标识**，见 §4.5）/ used_tokens / elapsed_ms / status / error_code / day_key，不含提问正文、回答正文、密钥与 JWT（`:5`；对照 `backend/app/models/models.py:683-709` 列清单）。提问与回答正文只存 `ai_messages`（`backend/app/services/ai_chat_service.py:256-258`、`:281-289`）。
7. **`error_code` 取值已供应商无关**：`c660727` 起上游故障统一写 `"llm"`（`backend/app/services/ai_chat_service.py:352`、`:529`、`backend/app/api/routes/ai.py:161`），**不再是 `"cloudbase"`**。因此按 `error_code` 统计失败时，历史数据会同时存在 `'cloudbase'` 与 `'llm'` 两种取值，需一并归并。
8. **feature 取值现状**：代码中实际写入的只有 `chat`（`FEATURE_CHAT`，`backend/app/services/ai_chat_service.py:44`）与 `quiz_explanation`（`FEATURE_QUIZ`，`:46`）。`FEATURE_ROUTE = "route_guide"` 在 `:45` 定义但**全仓无任何使用点**（节点讲解不调模型、不写日志，`backend/app/services/ai_chat_service.py:360-364`；`suggested_questions`（`:448-468`）同样不写日志）；`backend/app/models/models.py:686` docstring 列举的 `question_gen` **全仓无写入点**（grep 仅命中该注释本身）。

## 8. 修改约束

- **`day_key` 必须继续用 `helpers.today_str()`**（`:26`、`:67`）：写入与计数同源，改成 UTC 或本地时区会让历史数据与新数据落在不同自然日口径上，且与步数/答题/积分的北京时间口径（`backend/app/core/helpers.py:1-5`）分裂。
- **`record` 不得自行 commit**（`:57`）：调用方要把用量日志与业务数据（assistant 消息 / 会话更新时间）放在同一事务；上游故障路径还依赖「先清理半截对话、再单独记 error 日志」的顺序——chat 走 `discard_message`（`backend/app/services/ai_chat_service.py:349` → `:308-325`），quiz 走 `db.rollback()`（`:526`），流式走 `backend/app/api/routes/ai.py:157`。
- **只统计 `success`** 这一过滤条件（`:28`）是「失败不消耗额度」规则的实现点，改动即改变用户可见的额度行为。
- `AiLimitError` 必须继续继承 `ValueError`（`:20`）：`backend/app/api/routes/ai.py:42-47` 的 `AI_ERRORS` 与 `ai_http_error`（`:50-58`）依赖「子类先于 `ValueError` 判定」的顺序来给出 429；换成非 ValueError 基类会漏捕获成 500。同元组内的 `LlmError`（`backend/app/services/llm_base.py:16-25`）也是 `ValueError` 子类 → 502。
- 新增 feature 时应同时在 `backend/app/services/ai_chat_service.py:44-46` 常量区登记，并同步 `backend/app/models/models.py:686` 的 docstring 取值清单，避免注释与实现继续分叉。
- **`error_code` 不得写供应商名**：固定 `"llm"`，供应商信息只体现在 `model`（`llm_service.model_label()`）里。写回 `"cloudbase"`/`"openai"` 会让 `b712d81` 的可切换设计在统计侧失效。
- 若把出题链路接入用量统计，注意 `ai_question_service` 的批次是**多线程并发**调用（`_run_batches`，`backend/app/services/ai_question_service.py:214`，线程池 workers 见 `:227`），SQLAlchemy Session 不可跨线程共享，`record` 只能在主线程的会话里调用。
- 日志表只增不删、无归档任务（现状）；**`used_tokens` 为上游原值、未换算成费用，且口径随供应商而异**——OpenAI 兼容侧取 `usage.total_tokens`，CloudBase ACP 侧取 `usage_update.used` 原值（`backend/app/services/llm_base.py:30-35`）。做成本统计必须先按 `model` 分段，不得跨供应商直接求和。

## 9. 当前实现状态

### 已实现

- 单用户日限额与全站日限额两道闸门（`:35-42`），429 语义与中文文案齐备。
- 成功/失败两类用量日志落库（`:45-70`），失败不消耗额度。
- 北京时间自然日口径（`:26`、`:67`）。
- 冒烟已验证（`backend/test/s26-ai-center-results.json`：47/47 全通过）：H10 把 `chat_daily_limit` 降到 2 后「前 2 次 200、第 3 次 429」（`backend/test/s26_ai_center.py:432`）；H11 上游故障 → 502、会话/消息数不变、`status='error'` 日志 ≥1（`:409`）；H13/H14 密钥不泄露 + 成功调用写入 `ai_usage_logs`（`feature=chat`，实测 success_logs=4，`:452`）。**注：上述行号为当前文件位置；`c660727` 之后 s26 的用例断言已改为按 `settings.LLM_PROVIDER` 选择待掩码的密钥变量（`backend/test/s26_ai_center.py:75-79`），不再硬编码某一供应商的 Key。**

### 存在问题 / 限制

1. **限额校验无并发保护（事实陈述）**：`check_limits` 只做「先读计数、后调模型、成功后再写日志」，中间无预扣记录、无行锁、无唯一约束。同一用户（或全站）并发请求可同时通过校验，实际成功次数会超出 `chat_daily_limit`/`global_daily_limit`。当前小程序为单用户手动提问、并发面窄，未暴露。注意计数**落库**（`ai_usage_logs`），因此不属 `.qoder/ARCHITECTURE.md` §15 第 1 条「WS 连接表、限流计数、access_token 缓存均为进程内内存态」所指的那类限流——本模块的计数重启不丢、多进程可见；但「先读后写、无锁」的竞态在多进程部署下同样存在。是否需要收紧（如先写 pending 记录再更新状态）——**待确认**。
2. **全站日限额分支无冒烟覆盖**：`backend/test/s26_ai_center.py` 全文没有触发 `global_daily_limit` 的用例（该键名只出现在 C01 的配置视图响应断言里，`backend/test/s26-ai-center-results.json` C01 detail），`:40-42` 的 429 路径仅由代码审阅确认，未实测。
3. **`ai_usage_logs` 无任何读取接口**：表已建、日志在写，但用量/成本统计页与查询端点均属待开发（`.qoder/ARCHITECTURE.md` §11.3）。当前该表数据只能直接查库查看。
4. `FEATURE_ROUTE`（`backend/app/services/ai_chat_service.py:45`）与 `backend/app/models/models.py:686` 注释中的 `question_gen` 均为**无写入点的取值**（§7 第 8 条）：前者是死常量，后者是注释与实现分叉。是否保留待后续阶段决定——**待确认**。
5. `logging` 已导入且建了 `logger`（`:7`、`:17`），但本文件无任何日志语句；超限与写日志失败都是静默的（异常由调用方事务处理）。现状记录。
6. **`used_tokens` 与 `model` 两列现在是「跨供应商不可比」的（`b712d81` 引入的新限制）**：`used_tokens` 在 OpenAI 兼容侧是 `usage.total_tokens`（含提示词），在 CloudBase ACP 侧是 `usage_update.used` 原值（`backend/app/services/llm_base.py:30-35`）；`model` 则一边是真实模型名、一边是 Agent ID（§4.5）。因此**未来的用量/成本统计页必须先按 `model` 或供应商分段再聚合**，直接 `SUM(used_tokens)` 会得出无意义数字。历史数据里还混有 `error_code='cloudbase'` 的旧行（§7 第 7 条）。这是登记在写入侧的既成事实，读取侧接口尚未开发（第 3 条），故暂无实际错误报表。
7. **`ai_messages.used_tokens` 同样受此影响**（`backend/app/models/models.py:616`、`:629`）：流式与非流式写入的都是 `result.used_tokens`（`backend/app/services/ai_chat_service.py:287`），口径随供应商而变。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/services/ai_usage_service.py`（**仅 1 个提交**，本文件创建后无后续修改）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-22（仅文档校正）

- 需求：补齐 AI 栈文档欠账。**本次源码未改（`backend/app/services/ai_usage_service.py` 仍为 70 行、四个符号一字未动），属补 `c660727`（LLM 上游由腾讯云 CloudBase Agent 迁至阿里云百炼：`cloudbase_service.py` → `llm_service.py`、`CloudBaseError` → `LlmError`、`CLOUDBASE_*` → `LLM_*`）与 `6a4dbb7`（AI 对话改真流式 SSE，`ai_chat_service` 拆出 `prepare_message`/`finalize_message`/`discard_message`，新增 `POST /api/ai/chat/stream`）的文档欠账**；`b712d81`（上游改为可切换双供应商门面）进一步改变了本模块写入的 `model` / `used_tokens` 两列语义。
- 修改内容（**未改任何源码/配置/测试**）：
  - §4.5 调用点表由 **4 处扩为 5 处**，新增「历史助手对话上游故障（流式）」一行（`record` 在 `backend/app/api/routes/ai.py:158-161`、commit 在 `:162`、`discard_message` 在 `:157`、SSE `error` 事件在 `:164`）；其余四行行号全部按 `ai_chat_service.py` 现状重编号（`check_limits` `:198`/`:374` → **`:224`/`:508`**；`record` `:258-262`/`:241-244`/`:400-403`/`:392-395` → **`:293-297`/`:350-353`/`:535-538`/`:527-530`**；commit `:263`/`:245`/`:404`/`:396` → **`:298`/`:354`/`:539`/`:531`**）。
  - §4.5 的 `model` 段：`settings.CLOUDBASE_AGENT_ID`（Agent ID）→ **`llm_service.model_label()`**，并写明「OpenAI 兼容侧为真实模型名、CloudBase ACP 侧仍为 Agent ID」「provider 非法时原样返回不抛异常」（`backend/app/services/llm_service.py:67-74`；字段语义 `backend/app/models/models.py:689-690`）。
  - 全篇 `error_code="cloudbase"` → **`"llm"`**（§4.5 表、§7 新增第 7 条），并提示历史数据两种取值需归并。
  - chat 失败路径的事务描述：「先 `db.rollback()`」→ **「先 `discard_message(db, turn)`（`:349` → `:308-325`）显式删除已 commit 的用户消息与空会话」**；并注明 `quiz_explanation` **仍用 `db.rollback()`（`:526`）**，两条路径不可混用（§8）。
  - §5/§8：`AI_ERRORS` 与 `ai_http_error` 的行号 `backend/app/api/routes/ai.py:34-39`/`:42-50` → **`:42-47`/`:50-58`**，并补 `LlmError` → 502（`:56-57`）。
  - §6.1：「不调 CloudBase」→ **「不调任何 LLM 上游（既不 import `llm_service`，也不 import `llm_openai`/`llm_cloudbase`）」**；`models.py:660-684` → **`:683-709`**，并注明**列清单零变化、无 SQL 迁移**。
  - §6.2：`ai_chat_service.py` import 行 `:33` → **`:37`**；`routes/ai.py` import `:27` → **`:30-35`**，并把它从「只用 `AiLimitError`」改为**同时是 `record` 的调用方**；`ai_question_service` 的依据改为现行导入行 `:22`（`from app.services import admin_service, ai_knowledge_service, llm_service`）。
  - §7/§8/§9：`config.py:84`→`:104`、`:84-85`→`:104-105`；`FEATURE_*` 常量 `:39`/`:40`/`:41` → **`:44`/`:45`/`:46`**；`models.py:663` → **`:686`**；`ai_chat_service.py:274-277` → **`:360-364`**；`ai_question_service.py:225-231` → **`_run_batches` `:214`（workers `:227`）**；`cloudbase_service.py:48-49` → **`llm_base.py:30-35`**；`models.py:664`/`:669-672` → **`:687`/`:694-697`**；s26 用例行号 H10/H11/H14 → **`:432`/`:409`/`:452`**。
  - §9 新增第 6、7 条：**`used_tokens` 与 `model` 跨供应商不可比**（未来统计页必须先分段聚合），以及 `ai_messages.used_tokens`（`models.py:616`、`:629`）同受此影响。
- 关联文件（本次**只改文档**；以下为其所描述的源码，均未修改）：`backend/app/services/ai_usage_service.py`、`ai_chat_service.py`、`llm_service.py`、`llm_base.py`、`llm_openai.py`、`llm_cloudbase.py`、`ai_question_service.py`、`backend/app/api/routes/ai.py`、`backend/app/core/config.py`、`backend/app/models/models.py`、`backend/test/s26_ai_center.py`、`s28_ai_chat_stream.py`。同批修订的 `.qoder/` 文档：`ai_chat_service.py.md`、`ai_question_service.py.md`、`ai_config_service.py.md`、`setting_service.py.md`、`../models/models.py.md`、`../core/helpers.py.md`。
- 测试结果：**本次为纯文档改动，按任务约束未执行任何测试、未跑校验脚本**。既有测试结论（s26 47/47）转引自 `docs/迭代记录.md` 的 `1600074` 条目与仓库内 `backend/test/s26-ai-center-results.json`；`6a4dbb7`/`b712d81` 的验证结论见 `docs/迭代记录.md` 各该提交条目（**本次未逐条复核其通过用例数，标记待确认**）。
- 待确认项：① `b712d81` 条目中 s28/s30 的具体通过用例数；② 管理端是否计划按供应商分段展示用量/成本（读取侧接口尚未开发）。

### 2026-10-17（`1600074`）

- 需求：AI 智能中心 Phase A——普通用户每天模型调用次数上限与全站每天调用上限（防成本失控），并把每次调用（含失败）落 `ai_usage_logs` 供后续用量/成本统计。
- 修改内容：新建本文件（70 行，全部为新增）：`AiLimitError`、`count_today`（北京时间当日 + `status='success'`，可选按 user_id）、`check_limits`（用户限额优先、其次全站、`limit<=0` 不限）、`record`（关键字-only 参数，写 `day_key`，不 commit）。配套在 `backend/app/core/config.py:84-85` 新增 `AI_CHAT_DAILY_LIMIT` / `AI_GLOBAL_DAILY_LIMIT` 两个 env 默认项，并纳入配置中心可覆盖范围（`backend/app/services/ai_config_service.py:47-48`）。
- 关联文件：`backend/app/services/ai_chat_service.py`（4 个 `record` 调用点与 2 个 `check_limits` 调用点、commit 位置）、`backend/app/api/routes/ai.py`（`AI_ERRORS` 与 429 映射）、`backend/app/services/ai_config_service.py`（`AiConfig`）、`backend/app/models/models.py:660-684`、`docker/init/021_ai_center.sql:78-90`/`:116-121`（按根 `agents.md` §1.3 未随提交入库）。
- 测试结果：据 `docs/迭代记录.md` 该提交条目——冒烟 `backend/test/s26_ai_center.py` **47/47**（含真实 Agent 调用 L01：reply 143 字、usedTokens=19715；空来源场景模型拒答不编造）；真库校验迁移应用 / 表索引菜单齐备 / ORM 与真库列 ALL_MATCH / JSON round-trip 后回滚、真库真实 Agent 对话一次（reply 194 字、usedTokens=431）；报告 `backend/test/docs/s26-ai-center-report.md`。与本文件直接相关的用例：H10 用户日限额「前 2 次 200、第 3 次 429」（`backend/test/s26_ai_center.py:427-437`）、H11 上游故障 502 + 回滚不残留 + error 日志（`:404-415`）、H14 成功调用写入 `ai_usage_logs`（`:447-451`）；结果 JSON `backend/test/s26-ai-center-results.json` 记 `total=47 passed=47 failed=0`。同条目记载 usage/cost 统计页按需求 §13 留后续阶段。
