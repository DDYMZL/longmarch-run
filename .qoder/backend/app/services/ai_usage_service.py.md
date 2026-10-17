# ai_usage_service.py

## 1. 文件路径

`backend/app/services/ai_usage_service.py`（70 行）

## 2. 文件职责

AI 调用计数与限额服务：按**北京时间当日**统计 `ai_usage_logs` 中 `status='success'` 的记录，实现「单用户日限额」与「全站日限额」两道调用前闸门，并在每次模型调用后写入一条用量日志（成功/失败）。模块 docstring（`backend/app/services/ai_usage_service.py:1-6`）明确计数口径为「只统计真正完成模型调用的成功记录；失败或被拒不计入限额」，并声明日志**只记 user_id/feature/token/耗时/错误码，不含 API Key、JWT 或敏感个人资料**。

## 3. 业务需求

- 需求来源：《长征步迹 AI 智能中心开发需求 V1.0》Phase A——普通用户每天模型调用次数上限（防滥用）与全站每天调用上限（**防成本失控**），见 `backend/app/core/config.py:84-85` 注释、`.qoder/REQUIREMENTS.md` §10.2。后端提交 `1600074`（2026-10-17）。
- 用量/成本统计页属**待开发**（`.qoder/ARCHITECTURE.md` §11.3、`.qoder/REQUIREMENTS.md` §10.6：「usage / cost 统计页 待开发（`ai_usage_logs` 表已建）」）。本文件当前只承担**计数与写入**，不承担任何对外查询接口。
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

- 日期由 `today_str()`（`:26`）取得，实现见 `backend/app/core/helpers.py:22-24` → `now_beijing()`（`:17-19`）→ 固定偏移 `BEIJING_TZ = timezone(timedelta(hours=8))`（`:9`）。**是北京时间当日，不是 UTC**；与模块 docstring `:3-4`、`backend/app/models/models.py:664`（「day_key 为北京时间当日 YYYY-MM-DD」）三处一致。因用固定偏移而非 `zoneinfo`，不依赖服务器本地时区与 tzdata（`backend/app/core/helpers.py:3-4`）。
- 只筛 `status == "success"`（`:28`），**不按 feature 过滤**（见 §7 第 2 条）。
- `int(query.scalar() or 0)`（`:32`）兜住 `count()` 理论上的 `None`。
- 索引匹配：带 `user_id` 时命中 `ix_ai_usage_user_day (user_id, day_key)`，全站计数命中 `ix_ai_usage_day (day_key)`（`backend/app/models/models.py:669-672`；DDL `docker/init/021_ai_center.sql:116-121`）。

### 4.3 `check_limits`（`:35-42`）

判定顺序与语义（`:36` docstring「用户限额优先，其次全站」）：

1. `cfg.chat_daily_limit > 0` 且 `count_today(db, user_id) >= cfg.chat_daily_limit` → `AiLimitError("今日 AI 提问次数已用完，请明天再来")`（`:37-39`）。
2. `cfg.global_daily_limit > 0` 且 `count_today(db) >= cfg.global_daily_limit` → `AiLimitError("当前 AI 使用人数较多，请稍后再试")`（`:40-42`）。
3. **`limit <= 0` 视为不限**（两个 `if` 的外层条件即 `> 0`），因此管理端把限额改成 0 就等于关闭该项限制。

`cfg` 为 `AiConfig` 快照（类型从 `backend/app/services/ai_config_service.py:15` 导入，`:35` 入参），由调用方传入，本函数**不自行查配置**，避免重复读 `system_settings`。

### 4.4 `record`（`:45-70`）

- 除 `db` 外全部为**关键字-only 参数**（`:47` 的 `*`）：`feature`（必填）、`user_id`、`conversation_id`、`model`、`used_tokens`、`elapsed_ms`、`status="success"`（`:54`）、`error_code`。
- 组装 `AiUsageLog`（`:58-68`），`day_key=today_str()`（`:67`）与计数口径同源，**写入时的日期不取调用方传参**，因此跨零点的调用会落到调用发生那一刻的北京时间日期。
- `db.add(row)`（`:69`）后 `return row`（`:70`）；**不 flush、不 commit**（`:57`）。由于 `SessionLocal` 为 `autoflush=False`（`backend/app/core/database.py:51`），返回的 `row.id` 在调用方 flush/commit 前为 `None`；现有 4 个调用点均未使用返回值。

### 4.5 调用点与事务边界（谁 commit）

本模块**只写不提交**，提交全部发生在 `backend/app/services/ai_chat_service.py`：

| 场景 | `check_limits` | `record` | commit 位置 | 说明 |
|---|---|---|---|---|
| 历史助手对话成功 | `backend/app/services/ai_chat_service.py:198` | `:258-262`（`status="success"`、带 `conversation_id`、`used_tokens`、`elapsed_ms`） | `:263` | 与 assistant 消息、`conv.updated_at` 同事务 |
| 历史助手对话上游故障 | 同上 | `:241-244`（`status="error"`、`error_code="cloudbase"`、`elapsed_ms=None`、无 `conversation_id`） | `:245` | 先 `db.rollback()`（`:240`）丢弃本次用户消息与新建会话，再单独记 error 日志并提交；随后抛出 → 路由映射 502 |
| 答题解析（题库无解析，调模型）成功 | `backend/app/services/ai_chat_service.py:374` | `:400-403`（`feature=quiz_explanation`、无 `conversation_id`） | `:404` | 题库已有解析时在 `:370-371` 提前 return，**不校验限额、不写日志** |
| 答题解析上游故障 | 同上 | `:392-395`（`status="error"`、`error_code="cloudbase"`，`elapsed_ms` 用默认 `None`） | `:396` | 同样先 `db.rollback()`（`:391`） |

`model` 字段四处均传 `settings.CLOUDBASE_AGENT_ID`（`backend/app/services/ai_chat_service.py:242`、`:260`、`:393`、`:401`），即**暂存 Agent ID 而非底层模型名**（`backend/app/models/models.py:665` 注明「底层模型名需控制台确认」）。

## 5. 输入与输出

- 入参：`db: Session`（`Depends(get_db)`，`backend/app/core/database.py:58-64`）；`cfg: AiConfig`（`backend/app/services/ai_config_service.py:28-40`）；`user_id: int`（`check_limits` 必填，来自 JWT 用户，不接受客户端指定）。
- 返回：`count_today` → `int`；`check_limits` → `None`（无超限即静默通过）；`record` → 未提交的 `AiUsageLog` ORM 实例。
- 异常：`AiLimitError`（`:39`、`:42`），消息文案即面向用户的中文提示。
- 错误码映射：`backend/app/api/routes/ai.py:34-39` 把 `AiLimitError` 放进 `AI_ERRORS` 联合类型，`ai_http_error`（`:42-50`）在 `AiDisabledError` 之后、`ValueError` 之前判定 → **429**。管理端 AI 路由复用同一映射（`backend/app/api/routes/ai_admin.py:15`、`:224-225`）。
- 无 HTTP 端点直接暴露本模块：全仓无任何读取 `ai_usage_logs` 的接口（`AiUsageLog` 的引用点只有 `backend/app/models/models.py:660` 与本文件 `:14`、`:27-31`、`:56-58`）。
- 小程序侧对 429 的呈现：`frontend/pages/ai-chat/ai-chat.js` 把 403/429 转为顶部常驻提示条（见 `.qoder/REQUIREMENTS.md` §10.1 与 `docs/迭代记录.md` 提交 `0052108` 条目）。

## 6. 依赖关系

### 6.1 依赖

- 标准库：`logging`（`:7`）、`typing.Optional`（`:8`）。
- 第三方：`sqlalchemy.func`（`:10`）、`sqlalchemy.orm.Session`（`:11`）。
- 项目内：`app.core.helpers.today_str`（`:13`）、`app.models.models.AiUsageLog`（`:14`）、`app.services.ai_config_service.AiConfig`（`:15`，**仅类型导入**，不调用其任何函数）。
- 数据库表：`ai_usage_logs`（模型 `backend/app/models/models.py:660-684`；DDL `docker/init/021_ai_center.sql:78-90`；索引 `:116-121`）。列为 `id`(SERIAL PK)、`user_id`、`conversation_id`、`feature VARCHAR(30) NOT NULL`、`model VARCHAR(64)`、`used_tokens`、`elapsed_ms`、`status VARCHAR(16) NOT NULL DEFAULT 'success'`、`error_code VARCHAR(50)`、`day_key VARCHAR(10) NOT NULL`、`created_at`。`user_id`/`conversation_id` 为**逻辑外键**（DDL 无 FOREIGN KEY 约束，见 `.qoder/backend/app/models/models.py.md` §外键）。
- 无第三方 HTTP 依赖（不调 CloudBase）。

### 6.2 被谁依赖

| 依赖方 | 位置 | 用到的符号 |
|---|---|---|
| `backend/app/services/ai_chat_service.py` | `:33`（import）、`:198`、`:241`、`:258`、`:374`、`:392`、`:400` | `check_limits`、`record` |
| `backend/app/api/routes/ai.py` | `:27`（import）、`:36`、`:46` | `AiLimitError`（429 映射） |
| `backend/test/s26_ai_center.py` | 经 HTTP 间接覆盖（`:427-437` H10、`:404-415` H11、`:447-451` H14）；**无脚本直接 import 本模块** | — |

**不被依赖**：`backend/app/services/ai_question_service.py`（其 import 列表 `backend/app/services/ai_question_service.py:19-22` 不含本模块）、`backend/app/api/routes/ai_admin.py`（`:36-41` 的 import 不含本模块）——即 **AI 出题与题目工坊不写用量日志、不消耗日额度**。

## 7. 业务规则

1. **计数口径 = 北京时间当日 + `status='success'`**（`:26-29`）。失败记录（`status='error'`）与被闸门拒绝的请求（403 未开放、429 超限、400 参数错）**都不计入限额**（`:4-5` docstring），因此上游故障不会白白吃掉用户额度。
2. **限额是「跨 feature 共享」的**：`count_today` 只按 `day_key`/`status`/`user_id` 过滤，不区分 feature。配置项名为 `AI_CHAT_DAILY_LIMIT`（`backend/app/core/config.py:84`「普通用户每天最多模型调用次数」），实际同时约束**历史助手对话**与**无解析时的答题解析**两类调用，二者共用同一份每日额度。
3. **判定顺序**：用户限额先于全站限额（`:37-42`），文案不同以便前端区分「自己用完了」与「系统繁忙」。
4. **`limit <= 0` 即不限**（`:37`、`:40`）；上限受配置中心范围约束（`ai_chat_daily_limit` 0~100000、`ai_global_daily_limit` 0~1000000，`backend/app/services/ai_config_service.py:47-48`）。
5. **闸门在调用前、计数在调用后**：`check_limits` 在拼提示词与调模型之前执行（`backend/app/services/ai_chat_service.py:198` 早于 `:233`），成功日志在拿到回复之后写入（`:258-262`）。**无预扣/无行锁**，同一用户的并发请求可能全部通过校验后再各自写入，导致实际次数略超限额（见 §9 第 1 条）。
6. **日志内容最小化**：只写 user_id / conversation_id / feature / model(Agent ID) / used_tokens / elapsed_ms / status / error_code / day_key，不含提问正文、回答正文、密钥与 JWT（`:5`；对照 `backend/app/models/models.py:660-684` 列清单）。提问与回答正文只存 `ai_messages`（`backend/app/services/ai_chat_service.py:229`、`:249-255`）。
7. **feature 取值现状**：代码中实际写入的只有 `chat`（`FEATURE_CHAT`，`backend/app/services/ai_chat_service.py:39`）与 `quiz_explanation`（`FEATURE_QUIZ`，`:41`）。`FEATURE_ROUTE = "route_guide"` 在 `:40` 定义但**全仓无任何使用点**（节点讲解不调模型、不写日志，`backend/app/services/ai_chat_service.py:274-277`）；`backend/app/models/models.py:663` docstring 列举的 `question_gen` **全仓无写入点**（grep 仅命中该注释本身）。

## 8. 修改约束

- **`day_key` 必须继续用 `helpers.today_str()`**（`:26`、`:67`）：写入与计数同源，改成 UTC 或本地时区会让历史数据与新数据落在不同自然日口径上，且与步数/答题/积分的北京时间口径（`backend/app/core/helpers.py:1-5`）分裂。
- **`record` 不得自行 commit**（`:57`）：调用方要把用量日志与业务数据（assistant 消息 / 会话更新时间）放在同一事务；上游故障路径还依赖「先 `rollback` 丢弃半截对话、再单独记 error 日志」的顺序（`backend/app/services/ai_chat_service.py:240-245`）。
- **只统计 `success`** 这一过滤条件（`:28`）是「失败不消耗额度」规则的实现点，改动即改变用户可见的额度行为。
- `AiLimitError` 必须继续继承 `ValueError`（`:20`）：`backend/app/api/routes/ai.py:34-39` 的 `AI_ERRORS` 与 `ai_http_error`（`:42-50`）依赖「子类先于 `ValueError` 判定」的顺序来给出 429；换成非 ValueError 基类会漏捕获成 500。
- 新增 feature 时应同时在 `backend/app/services/ai_chat_service.py:39-41` 常量区登记，并同步 `backend/app/models/models.py:663` 的 docstring 取值清单，避免注释与实现继续分叉。
- 若把出题链路接入用量统计，注意 `ai_question_service` 的批次是**多线程并发**调用（`backend/app/services/ai_question_service.py:225-231`），SQLAlchemy Session 不可跨线程共享，`record` 只能在主线程的会话里调用。
- 日志表只增不删、无归档任务（现状）；`used_tokens` 为平台原值、未换算成费用（`backend/app/services/cloudbase_service.py:48-49`）。

## 9. 当前实现状态

### 已实现

- 单用户日限额与全站日限额两道闸门（`:35-42`），429 语义与中文文案齐备。
- 成功/失败两类用量日志落库（`:45-70`），失败不消耗额度。
- 北京时间自然日口径（`:26`、`:67`）。
- 冒烟已验证（`backend/test/s26-ai-center-results.json`：47/47 全通过）：H10 把 `chat_daily_limit` 降到 2 后「前 2 次 200、第 3 次 429」（`backend/test/s26_ai_center.py:427-437`）；H11 上游故障 → 502、会话/消息数不变、`status='error'` 日志 ≥1（`:404-415`）；H14 成功调用写入 `ai_usage_logs`（`feature=chat`，实测 success_logs=4，`:447-451`）。

### 存在问题 / 限制

1. **限额校验无并发保护（事实陈述）**：`check_limits` 只做「先读计数、后调模型、成功后再写日志」，中间无预扣记录、无行锁、无唯一约束。同一用户（或全站）并发请求可同时通过校验，实际成功次数会超出 `chat_daily_limit`/`global_daily_limit`。当前小程序为单用户手动提问、并发面窄，未暴露；与 `.qoder/ARCHITECTURE.md` §15 第 1 条「限流计数为进程内内存态、无法水平扩容」属同类限制。是否需要收紧（如先写 pending 记录再更新状态）——**待确认**。
2. **全站日限额分支无冒烟覆盖**：`backend/test/s26_ai_center.py` 全文没有触发 `global_daily_limit` 的用例（该键名只出现在 C01 的配置视图响应断言里，`backend/test/s26-ai-center-results.json` C01 detail），`:40-42` 的 429 路径仅由代码审阅确认，未实测。
3. **`ai_usage_logs` 无任何读取接口**：表已建、日志在写，但用量/成本统计页与查询端点均属待开发（`.qoder/ARCHITECTURE.md` §11.3）。当前该表数据只能直接查库查看。
4. `FEATURE_ROUTE`（`backend/app/services/ai_chat_service.py:40`）与 `backend/app/models/models.py:663` 注释中的 `question_gen` 均为**无写入点的取值**（§7 第 7 条）：前者是死常量，后者是注释与实现分叉。是否保留待后续阶段决定——**待确认**。
5. `logging` 已导入且建了 `logger`（`:7`、`:17`），但本文件无任何日志语句；超限与写日志失败都是静默的（异常由调用方事务处理）。现状记录。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/services/ai_usage_service.py`（**仅 1 个提交**，本文件创建后无后续修改）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-17（`1600074`）

- 需求：AI 智能中心 Phase A——普通用户每天模型调用次数上限与全站每天调用上限（防成本失控），并把每次调用（含失败）落 `ai_usage_logs` 供后续用量/成本统计。
- 修改内容：新建本文件（70 行，全部为新增）：`AiLimitError`、`count_today`（北京时间当日 + `status='success'`，可选按 user_id）、`check_limits`（用户限额优先、其次全站、`limit<=0` 不限）、`record`（关键字-only 参数，写 `day_key`，不 commit）。配套在 `backend/app/core/config.py:84-85` 新增 `AI_CHAT_DAILY_LIMIT` / `AI_GLOBAL_DAILY_LIMIT` 两个 env 默认项，并纳入配置中心可覆盖范围（`backend/app/services/ai_config_service.py:47-48`）。
- 关联文件：`backend/app/services/ai_chat_service.py`（4 个 `record` 调用点与 2 个 `check_limits` 调用点、commit 位置）、`backend/app/api/routes/ai.py`（`AI_ERRORS` 与 429 映射）、`backend/app/services/ai_config_service.py`（`AiConfig`）、`backend/app/models/models.py:660-684`、`docker/init/021_ai_center.sql:78-90`/`:116-121`（按根 `agents.md` §1.3 未随提交入库）。
- 测试结果：据 `docs/迭代记录.md` 该提交条目——冒烟 `backend/test/s26_ai_center.py` **47/47**（含真实 Agent 调用 L01：reply 143 字、usedTokens=19715；空来源场景模型拒答不编造）；真库校验迁移应用 / 表索引菜单齐备 / ORM 与真库列 ALL_MATCH / JSON round-trip 后回滚、真库真实 Agent 对话一次（reply 194 字、usedTokens=431）；报告 `backend/test/docs/s26-ai-center-report.md`。与本文件直接相关的用例：H10 用户日限额「前 2 次 200、第 3 次 429」（`backend/test/s26_ai_center.py:427-437`）、H11 上游故障 502 + 回滚不残留 + error 日志（`:404-415`）、H14 成功调用写入 `ai_usage_logs`（`:447-451`）；结果 JSON `backend/test/s26-ai-center-results.json` 记 `total=47 passed=47 failed=0`。同条目记载 usage/cost 统计页按需求 §13 留后续阶段。
