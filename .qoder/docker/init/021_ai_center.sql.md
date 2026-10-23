# 021_ai_center.sql

## 1. 文件路径

`docker/init/021_ai_center.sql`（124 行）

> **⚠ 本文件未入库（untracked）**：`git status --porcelain -- docker/init/` 输出 `?? docker/init/021_ai_center.sql`，`git ls-files docker/init/` 中**不含**本文件。原因是仓库根 `agents.md` §1.3 规定「`docker/` 目录下的代码不自动提交」。后果：① `git log --follow` 与 `git blame` 对本文件**无任何输出**，§10 无法给出本文件的提交号；② **生产 openGauss 缺失本迁移**（`.qoder/PROJECT.md` §8「阻塞级」第 3 项、`.qoder/ARCHITECTURE.md` §12.4「生产迁移缺口」段）。

## 2. 文件职责

「AI 智能中心」建表迁移：一次性新建 **6 张 `ai_*` 表**——`ai_knowledge`（`:11-25`）/ `ai_conversations`（`:28-35`）/ `ai_messages`（`:38-46`）/ `ai_generation_jobs`（`:49-62`）/ `ai_generated_questions`（`:65-75`）/ `ai_usage_logs`（`:78-90`），并在一个 `DO $$ … END $$` 匿名块内用 `pg_indexes` 判定幂等地建 **9 个索引**（`:93-122`）。支撑历史问答会话、知识资料审核、AI 出题任务与草稿、调用日志与日限额计数（`:4-5` 头注释）。

**本文件不种任何数据**（全文件 `INSERT` / `UPDATE` / `DELETE` / `ALTER` 命中 **0** 次）——AI 配置项**不在数据库中种子化**，见 §5 与 §9。

## 3. 业务需求

《长征步迹 AI 智能中心开发需求 V1.0》Phase A（2026-10-17 交付）。对应后端提交 `1600074`「AI 智能中心 Phase A（历史助手/路线讲解/答题解析/管理端接口/题目工坊持久化）」——该提交新增 6 个 AI 服务与 `backend/app/models/models.py` 的 148 行（即本文件镜像的 6 个 ORM 模型），但**未包含本 SQL 文件**（`git show --stat 1600074` 的 15 个文件里没有任何 `docker/init/*`，正是 §1 所述不入库规则的直接证据）。

六个业务场景（`:4-5`、`:10`、`:27`、`:37`、`:48`、`:64`、`:77` 各处注释）：

1. **历史助手问答**：小程序 `pages/ai-chat` 多轮对话，会话与消息落库（`ai_conversations` / `ai_messages`）。
2. **路线讲解**：`GET /api/ai/route-guide/{node_id}` 优先取该节点绑定的已发布知识资料（`ai_knowledge.node_id`）。
3. **答题解析**：`GET /api/ai/quiz-explanation/{question_id}`。
4. **知识资料审核**：管理端录入 → 待审 → 发布，仅 `published` 参与正式检索（`:10`）。
5. **题库工坊**：一次生成请求落一条任务、每道草稿落一行，支持列表回溯、逐条编辑/审核、幂等导入正式题库（`ai_generation_jobs` / `ai_generated_questions`，见 `backend/app/services/ai_question_service.py:392-395` 注释）。
6. **用量限额**：按 `(user_id, day_key)` 做日限额计数与后续用量/成本统计（`ai_usage_logs`，`:77`）。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:124`）。

### 4.1 `ai_knowledge` 知识资料（`:11-25`）

`id SERIAL PK`；`title VARCHAR(200) NOT NULL`、`content TEXT NOT NULL`（题干正文，检索源）；`source VARCHAR(300)` 可空（出处）；`related JSON` 可空（相关/推荐问题字符串数组，路线节点固定讲解用，ORM `models.py:559-560`）；`category VARCHAR(20)` 可空（复用题库口径 `event`/`route`/`figure`，另允许 `custom`，`models.py:544`）；`node_id INTEGER REFERENCES route_nodes(id)` 可空（**真 FK**，非空表示绑定路线节点固定讲解，`:10`）；`status VARCHAR(16) NOT NULL DEFAULT 'draft'`；`created_by` / `reviewed_by VARCHAR(64)` 可空（操作人标识，**非 FK**）；`created_at` / `updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`；`published_at TIMESTAMP` 可空。

### 4.2 `ai_conversations` 会话（`:28-35`）

`user_id INTEGER NOT NULL REFERENCES users(id)`（**真 FK**）——归属由 JWT 用户确定，**跨用户不可读写**（`:27`）；`title VARCHAR(100)` 可空；`status VARCHAR(16) NOT NULL DEFAULT 'active'`（`active` 正常 / `archived` 归档，`models.py:576`）；`created_at` / `updated_at` DB 默认。`:27` 明确「删除时服务层显式连同消息一并删除」——**不依赖数据库级联**（尽管 `:40` 仍声明了 `ON DELETE CASCADE`，见 §7.2）。

### 4.3 `ai_messages` 消息（`:38-46`）

`conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE`（`:40`，本文件**唯一一处级联删除声明**）；`role VARCHAR(16) NOT NULL`（`user`/`assistant`/`system`，`:37`，**无默认值**）；`content TEXT NOT NULL`；`sources JSON` 可空（**后端核验过的**知识来源列表，`:37`，不是模型自报的引用）；`used_tokens INTEGER` 可空（**平台原值**，`:37`；ORM `models.py:593` 指明是 `usage_update.used`，assistant 消息未报告时为空）；`created_at` DB 默认。

### 4.4 `ai_generation_jobs` 出题任务（`:49-62`）

`job_type VARCHAR(20) NOT NULL DEFAULT 'question'`；`topic VARCHAR(100) NOT NULL`；`params JSON` 可空（生成参数快照 `topic`/`count`/`difficulty`/`category`/`extra`/`knowledge_ids`，`models.py:614`）；三个计数列 `requested` / `succeeded` / `failed INTEGER NOT NULL DEFAULT 0`（`:54-56`，请求/成功/失败数）；`status VARCHAR(16) NOT NULL DEFAULT 'pending'`；`error TEXT` 可空；`created_by VARCHAR(64)` 可空；`created_at` DB 默认；`finished_at TIMESTAMP` 可空。

### 4.5 `ai_generated_questions` 题目草稿（`:65-75`）

`job_id INTEGER REFERENCES ai_generation_jobs(id)` 可空（**真 FK**）；`data JSON NOT NULL`（题目内容 JSON，`:64`，本文件**唯一一处 NOT NULL 的 JSON 列**）；`errors JSON` 可空（待修正问题列表）；`status VARCHAR(16) NOT NULL DEFAULT 'pending'`；`reviewed_by VARCHAR(64)` / `reviewed_at TIMESTAMP` 可空；`question_id INTEGER` 可空且**无 FK**（导入正式题库后的 `questions.id`，`:64`；幂等依据——已导入的草稿不再重复入库，`models.py:638`）；`created_at` DB 默认。

### 4.6 `ai_usage_logs` 调用日志（`:78-90`）

`user_id INTEGER` 可空**无 FK**、`conversation_id INTEGER` 可空**无 FK**（`:80-81`，日志表刻意不建 FK，避免会话删除阻塞日志留存）；`feature VARCHAR(30) NOT NULL`（`chat`/`route_guide`/`quiz_explanation`/`question_gen`，ORM docstring 现 `models.py:686`）；`model VARCHAR(64)` 可空（列声明现 `models.py:703`）——**取值随 `settings.LLM_PROVIDER` 而异**，写入值是 `llm_service.model_label()`（`app/services/llm_service.py:67-74`；`models.py:688-690` 已同口径）：`openai` 下为**真实模型名**（即 `LLM_MODEL`，`config.py:77` 注明「同时作为 `ai_usage_logs.model` 的取值」），`cloudbase` 下因 ACP 不暴露模型名而**沿用 Agent ID**（`config.py:90` 同注）。口径沿革：建档时（2026-10-17）为「暂存 Agent ID、底层模型名需控制台确认」→ `c660727` 迁阿里云百炼后为真实模型名 → `b712d81` 起两者随供应商并存；`LLM_PROVIDER` 取值非法时 `model_label()` **不抛异常**、原样返回该取值（`llm_service.py:70-74`，避免在异常收尾路径掩盖原始错误）。`used_tokens` / `elapsed_ms INTEGER` 可空（`used_tokens` 列现 `models.py:704`）——**`used_tokens` 口径随供应商不同**（写入点 `ai_chat_service.py:295`，值为 `CallResult.used_tokens`，见 `app/services/llm_base.py:32-34`）：`openai` = `usage.total_tokens`（输入+输出，与按量计费一致）；`cloudbase` = 平台 `usage_update.used` **原值**（含义未经核实、如实记录不换算，**实测量级不稳，不可作单次计费依据**）；上游未报告用量时为 NULL。**同一口径也适用于 §4.3 的 `ai_messages.used_tokens`**（写入点 `ai_chat_service.py:287`）——§4.3 原文「平台原值」与 ORM docstring `models.py:616`「平台 `usage_update.used` 原值」只在 `cloudbase` 下成立，属**源码注释滞后**（本次禁改源码，仅在此登记，待随源码修订）。`status VARCHAR(16) NOT NULL DEFAULT 'success'`（`success`/`error`，现 `models.py:687`）；`error_code VARCHAR(50)` 可空——**当前唯一写入值是 `llm`**（自 `c660727` 起；建档时上游为腾讯云 CloudBase，故当时口径是 `cloudbase`，`b712d81` 后**两套供应商统一仍写 `llm`**，不再随供应商变化。写入点仅 3 处：`ai_chat_service.py:352`、`:529`、`routes/ai.py:160`，均为 `status="error"` 的失败收尾）；`day_key VARCHAR(10) NOT NULL`（**北京时间**当日 `YYYY-MM-DD`，`:77`，限额计数键）；`created_at` DB 默认。

### 4.7 索引 DO 块（`:93-122`，9 个索引）

`DO $$ BEGIN … END $$;` 内逐条 `IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = … AND indexname = …) THEN CREATE INDEX …`。`:92` 注释说明理由：「openGauss 部分版本不支持 `CREATE INDEX IF NOT EXISTS`，统一用 DO 块 + `pg_indexes` 判定（幂等）」——**这正是 `SQL_CONSTRAINTS.md` §1.2 要求的合规写法**，本文件是全 `docker/init/` 中的正面范例。

| 索引 | 行号 | 表 / 列 |
|---|---|---|
| `ix_ai_knowledge_status_cat` | `:95-97` | `ai_knowledge (status, category)` |
| `ix_ai_knowledge_node` | `:98-100` | `ai_knowledge (node_id)` |
| `ix_ai_conversations_user_updated` | `:101-103` | `ai_conversations (user_id, updated_at)` |
| `ix_ai_messages_conv_id` | `:104-106` | `ai_messages (conversation_id, id)` |
| `ix_ai_jobs_created` | `:107-109` | `ai_generation_jobs (created_at)` |
| `ix_ai_genq_status` | `:110-112` | `ai_generated_questions (status)` |
| `ix_ai_genq_job` | `:113-115` | `ai_generated_questions (job_id)` |
| `ix_ai_usage_user_day` | `:116-118` | `ai_usage_logs (user_id, day_key)` |
| `ix_ai_usage_day` | `:119-121` | `ai_usage_logs (day_key)` |

## 5. 输入与输出

- **输入（前置条件）**：`route_nodes`（`:18` FK 目标）、`users`（`:30` FK 目标）必须已存在；文件内部建表顺序满足 FK 依赖（`ai_conversations` `:28` 先于 `ai_messages` `:38`；`ai_generation_jobs` `:49` 先于 `ai_generated_questions` `:65`）。
- **输出**：**6 张表 + 9 个索引**。**种子数据 0 条**——本文件不含任何 `INSERT`。
- **⚠ 关于「AI 配置项种子」的更正**：本文件**不种任何 AI 配置项**。AI 配置的存放位置是两处，都不在本迁移里：
  1. **`.env` / `.env.prod`**：**当前口径（`b712d81` 之后）是「双供应商并存、`LLM_PROVIDER` 一行切换」**，配置项**名称**见 `backend/app/core/config.py:68-93`（建档时记的 `:66-91` 已随该文件增行而下移）与 `.qoder/ARCHITECTURE.md` §11.1；**本文档依 `.qoder/README.md` §3.14 不记录任何值**：
     - 开关与共用项：`LLM_PROVIDER`（`:72`，默认 `openai`，两份 env 当前为 `cloudbase`）、`LLM_TIMEOUT_SECONDS`（`:73`，两套供应商共用；**`CLOUDBASE_TIMEOUT_SECONDS` 已在 `b712d81` 移除且不恢复**，避免同义双旋钮）；
     - `openai` 段（OpenAI Chat Completions 兼容，阿里云百炼等）：`LLM_BASE_URL`（`:76`）、`LLM_MODEL`（`:77`）、`LLM_API_KEY`（`:78`）、`LLM_EXTRA_BODY`（`:82`）、`LLM_QUESTION_EXTRA_BODY`（`:85`，出题链路覆盖项）；
     - `cloudbase` 段（腾讯云 CloudBase Agent ACP）：`CLOUDBASE_ENV_ID`（`:89`）、`CLOUDBASE_AGENT_ID`（`:90`）、`CLOUDBASE_API_KEY`（`:91`）、`CLOUDBASE_AGENT_URL`（`:93`，留空时按 ENV_ID/AGENT_ID 拼接网关地址）。⚠ **建档时写的 `CLOUDBASE_ACP_URL` 是更早的旧名，现名 `CLOUDBASE_AGENT_URL`**；ACP 无 `max_tokens` 与思考开关，故两个 `*_EXTRA_BODY` 在 `cloudbase` 下被适配器忽略。
     - 沿革：CloudBase 那批配置项由提交 `37f3e40`「chore(config): 新增腾讯云 CloudBase Agent 相关配置项」加入（只改 `backend/.env` 与 `backend/.env.prod`，**不涉及任何 SQL**）；`c660727` 把上游单向迁到阿里云百炼（`CLOUDBASE_*` → `LLM_*`）；`b712d81` 恢复 ACP 实现并改为可切换，两套凭证常驻 env。**三次上游变更都没有引入任何 SQL 迁移，本文件的 6 张表结构零变化**（变化的只是 `ai_usage_logs` 的写入侧口径，见 §4.6）。
  2. **`system_settings` 表**：管理端可改的覆盖值 + 提示词模板，`backend/app/services/ai_config_service.py:3` 明写「生效值 = `system_settings`（管理端可改）覆盖 > `Settings`（`.env` 初始默认）」；键集合见该文件 `_BY_KEY`（`:56`）、`_PROMPT_KEYS`（`:92`）、`_PROMPT_VERSION_KEY`（`:97`）。`system_settings` 表由先序迁移建立，**本文件不新增配置种子行**——首次读取走 `.env` 默认值，管理端保存时才写 `system_settings`。
  - 因此**本文件不含任何形似密钥/Token/环境 ID 的种子值**，无需轮换处置（§9「敏感信息检查」）。
- **对既有数据的影响**：**零**。`:6` 头注释明写「仅新增表与索引，不改动任何现有业务表、不重算历史数据、不影响已有接口契约」；`:7` 补充「新表全部独立于现有 `questions`/`users`/`route_nodes`，**AI 关闭时不被读写，业务零影响**」。已逐条复核：无 `ALTER TABLE`、无 `UPDATE`、无 `DELETE`、无对既有表的 `INSERT`。
- **失败模式**：`:18`/`:30`/`:40`/`:67` 四处 FK 要求目标表存在，否则建表失败；`DO` 块内任一条 `CREATE INDEX` 失败会让整个匿名块报错、事务回滚。

## 6. 依赖关系

- **依赖先序迁移**：建 `route_nodes`、`users` 的迁移（`001_schema.sql` 等）。与 `017`–`020` **无依赖关系**（操作完全不同的表）。
- **被后续迁移依赖**：`022_ai_admin_menus.sql` 在**逻辑上**配套（种入 5 个 `ai_*` 菜单码供 `/api/admin/ai/*` 的 `require_menu` 使用），但两者**无 SQL 级依赖**——022 只写 `admin_menus`，不引用任何 `ai_*` 表。
- **对应 ORM**（6 个模型，`backend/app/models/models.py`）：

| 表 | ORM 类 / 行号 | 索引声明 |
|---|---|---|
| `ai_knowledge` | `AiKnowledge`，`:540-570` | `:550-553`（2 个） |
| `ai_conversations` | `AiConversation`，`:573-587` | `:580`（1 个） |
| `ai_messages` | `AiMessage`，`:590-607` | `:597`（1 个） |
| `ai_generation_jobs` | `AiGenerationJob`，`:610-631` | `:618`（1 个） |
| `ai_generated_questions` | `AiGeneratedQuestion`，`:634-657` | `:642-645`（2 个） |
| `ai_usage_logs` | `AiUsageLog`，`:660-684` | `:669-672`（2 个） |

- **读写方（6 个 AI 服务，均由 `1600074` 引入）**：
  - `backend/app/services/ai_knowledge_service.py`——`ai_knowledge` 的 CRUD 与审核状态流转；应用层白名单 `ALLOWED_STATUS`（`:20`）、`ALLOWED_CATEGORIES`（`:21`）、长度上限 `TITLE_MAX_LEN=200`（`:22`）、`SOURCE_MAX_LEN=300`（`:23`）、`RELATED_MAX=10`（`:24`）。
  - `backend/app/services/ai_chat_service.py`——`ai_conversations` / `ai_messages` 读写；`:351-355` 答题讲解前用 `QuizAnswer.status IN ('answered','timeout')` 校验用户确已作答。
  - `backend/app/services/ai_question_service.py`——`ai_generation_jobs` / `ai_generated_questions` 读写；`:392-395` 注释说明「一次生成落一条任务、每道草稿落一行、支持幂等导入题库」，草稿状态白名单 `DRAFT_STATUSES`（`:395`）；`:184` 取 `Question.active.is_(True)` 的题干做去重参照。
  - `backend/app/services/ai_usage_service.py`——`ai_usage_logs` 写入（`record`，`:45-67`，`day_key=today_str()` 见 `:67`）与限额计数（`count_today`，`:24-31`，只数 `status='success'`）；`check_limits`（`:35`）消费 `ai_config_service.AiConfig`。
  - `backend/app/services/ai_config_service.py`——读 `system_settings`（**不读本文件的任何表**）。
  - **大模型上游调用层（不落库，故不在「6 个 AI 服务」计数内）**：现为「门面 + 适配器 + 共享类型」四个模块——`backend/app/services/llm_service.py`（门面，按 `settings.LLM_PROVIDER` 从 `_ADAPTERS`（`:41`）分派，对外符号 `LlmError`/`CallResult`/`prompt_meta`/`prompt`/`LlmStream`/`model_label`/`is_configured`）、`llm_openai.py`（OpenAI Chat Completions 兼容，httpx 同步客户端）、`llm_cloudbase.py`（腾讯云 CloudBase Agent ACP：JSON-RPC 2.0 `session/prompt` + SSE 逐行解析，httpx 同步客户端）、`llm_base.py`（共享 `LlmError`/`CallResult`/`ensure_complete`，**纯标准库**，单独成模块以打破「门面 ↔ 适配器」循环导入）。**沿革**：建档时是单个 `cloudbase_service.py`（抛 `CloudBaseError`）→ `c660727` 经 `git mv` 更名为 `llm_service.py` 并整体改为百炼实现（`CloudBaseError`→`LlmError`）→ `6a4dbb7` 在其上加 `LlmStream` 支撑 SSE 真流式 → `b712d81` 拆为上述四个模块、恢复 ACP 实现并改为可切换。**写入本文件 `ai_usage_logs.model` 的 `model_label()` 即出自该门面**（`llm_service.py:67-74`）。
  - 路由层：`backend/app/api/routes/ai.py`（小程序侧 `/api/ai/*`）、`backend/app/api/routes/ai_admin.py`（管理侧 `/api/admin/ai/*`，`require_menu("ai_knowledge")` 见 `:80`/`:101`/`:105`/`:123`/`:136`/`:141`/`:159`/`:164`/`:182`/`:186`，`require_menu("ai_workshop")` 见 `:204`/`:208`/`:232`/`:247`/`:260`/`:277`/`:282`/`:298`）。
- **小程序侧**：`frontend/pages/ai-chat/`（由 `0052108` 引入）、`frontend/services/ai.js`。

## 7. 业务规则

1. **仅 `published` 参与正式问答检索**：`ai_knowledge.status` 的 5 值域中只有 `published` 进入检索源（`:10` 头注释、`models.py:543-544`）；`node_id` 非空的已发布资料是路线节点固定讲解的优先来源（`models.py:545`）。
2. **`ON DELETE CASCADE` 是兜底而非主路径**：`:40` 声明了级联，但 `:27` 明确「删除会话时**服务层显式**连同消息一并删除，**不依赖数据库级联**」（`models.py:576` 同口径）。两层保险：服务层显式删 + DB 级联兜底。
3. **会话归属强隔离**：`ai_conversations.user_id NOT NULL`（`:30`）+ 归属由 JWT 用户确定，跨用户不可读写（`:27`）。
4. **日限额口径**：`ai_usage_logs` 中 `status='success'` 的记录按 `day_key`（**北京时间**当日）计数（`:77`、`ai_usage_service.py:3`、`:27-28`）。`day_key` 与 `points_log`/`daily_sport` 的 `date` 同为北京时间口径（`helpers.today_str`，`models.py:664`），而 `created_at` 系列是 UTC——**同一行里两种时区口径并存**，查询时勿混用。
5. **草稿导入幂等**：`ai_generated_questions.question_id` 非空即「已导入正式题库」，不再重复入库（`:64`、`models.py:638`）。该列**无 FK**，故导入后即使题目被软停用（`020`）也不影响草稿行。
6. **日志不含敏感信息**：`ai_usage_service.py:5` 明写「日志只记 user_id/feature/token/耗时/错误码，**不含 API Key、JWT 或敏感个人资料**」——这是 `ai_usage_logs` 列集合（`:78-90`）不含任何凭据列的设计约束。
7. **AI 关闭时零读写**：`:7` 承诺「AI 关闭时不被读写，业务零影响」，开关由 `ai_config_service.ensure_enabled`（`:126`）判定，配置来自 `system_settings` / `.env`，**不在本迁移中**。
8. **空字符串按 NULL 存储**：`models.py:546` 明写「本库空字符串按 NULL 存储（Oracle 兼容模式），可空文本列读取时 None 即空值」——影响 `source`、`title`、`content` 等文本列的判空写法（须用 `IS NULL` 而非 `= ''`）。

## 8. 修改约束

1. **⚠ 本文件未入库，故生产库缺失**：这是与 `017`–`020` 最关键的差别。`SQL_CONSTRAINTS.md` §3.1「禁止修改已在生产执行过的编号脚本」对本文件的适用情况是——**本地 openGauss 已应用并登记 `schema_migrations`，生产库尚未执行**。因此：
   - **本地视角**：已执行过，按 §3.1 不应修改；
   - **生产视角**：从未执行，理论上仍可修改；
   - **实际约束**：一旦按 `.qoder/ARCHITECTURE.md` §12.4「生产迁移缺口」流程补跑到生产，本文件即冻结。**当前处于「可改但不应改」的窗口期**；若确需变更结构，正确做法是保持 `021` 不动、新增 `023_*.sql`，避免本地与生产 `schema_migrations` 同名不同内容（那会导致补跑时被跳过、生产永久缺列）。
2. **入库前必须补齐的头注释**：本文件 `:4-8` 已有完整「变更目的 / 影响面 / 回滚」三段式（`SQL_CONSTRAINTS.md` §4 的合规范例），修改时不得删减。
3. **6 张表名与 9 个索引名是 ORM 硬契约**：`models.py:549`/`:579`/`:596`/`:617`/`:641`/`:668` 的 `__tablename__` 与 `:551-552`/`:580`/`:597`/`:618`/`:643-644`/`:670-671` 的 `Index(...)` 名称逐一对应，改名会让 ORM 与实际库脱钩（因禁用 `create_all`，不会自动纠正）。
4. **不得给本文件加 CHECK 约束来「收紧」状态取值域**：全库口径是「无任何 CHECK 约束，所有枚举都是 `VARCHAR` + 应用层常量校验」（`.qoder/ARCHITECTURE.md` §13.2）。单独给 `ai_*` 表加 CHECK 会造成两套口径，且生产 openGauss 版本对 CHECK 的支持**待确认**。
5. **`ai_usage_logs` 的两个 id 列刻意无 FK**（`:80-81`），加 FK 会让会话删除失败或产生悬挂引用报错，属破坏性变更。
6. 生产补跑前须按 `SQL_CONSTRAINTS.md` §6「只跑缺失编号」流程：先比对 `schema_migrations` 与 `docker/init/` 清单差异，补跑后**必须回填** `schema_migrations`（`:141`）。

## 9. 当前实现状态

- **已实现（本地）**：6 表 + 9 索引已在本地 openGauss 应用并登记 `schema_migrations`；后端 6 个 AI 服务、`/api/ai/*` 与 `/api/admin/ai/*` 已上线；小程序 `pages/ai-chat` 已交付。冒烟 `s26` 47/47 通过（含真实 Agent 调用，`1600074`；VPN 关闭后重跑真实链路 `1fbacac`）。
- **未实现（勿当作已完成，`.qoder/ARCHITECTURE.md` §11.3）**：管理后台 5 个 AI 子页面全部待开发（其中「题目工坊」已落地的是嵌在题库页的 `admin/src/components/AiGenerateDialog.vue`，独立工坊页仍待开发）；`ai_overview` / `ai_logs` 两个菜单码对应的**后端接口亦未实现**；`node-detail` AI 讲解面板、答题页「AI 讲解」按钮、usage/cost 统计页（`ai_usage_logs` 读取侧接口）均待开发。
- **⚠ 生产库缺失（阻塞级）**：`.qoder/PROJECT.md` §8「阻塞级」第 3 项、`.qoder/ARCHITECTURE.md` §12.4「生产迁移缺口」段——部署新后端前**必须**比对 `schema_migrations` 与 `docker/init`，否则启动即报 `UndefinedTable`。生产库当前 `schema_migrations` 实际内容：**待确认（本次建档禁止连库）**。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` 逐项）——本文件是全库合规度最高的迁移**：
  - **§1.1 合规（0 处）**：全文件无 `ALTER TABLE`，未命中禁用语法（已 `grep -c "ADD COLUMN IF NOT EXISTS"` 复核，命中 0）。
  - **§1.2 合规**：**未使用** `CREATE INDEX IF NOT EXISTS`，9 个索引全部走 `DO` 块 + `pg_indexes` 判定（`:93-122`），是该节要求写法的正面范例。
  - **§1.3 合规**：6 处 `CREATE TABLE IF NOT EXISTS`（`:11`、`:28`、`:38`、`:49`、`:65`、`:78`）。
  - **§1.4 合规**：`DO` 块内的 `SELECT 1 FROM pg_indexes WHERE …` 是普通表查询，**无派生表**。
  - **§1.5 合规**：未用 `ON CONFLICT`（也不需要——本文件无 INSERT）；未用 `ALTER COLUMN TYPE`；未用 `CREATE OR REPLACE TRIGGER`；未用 JSON 路径操作符 `@>`/`?`/`?&`（`related`/`sources`/`params`/`data`/`errors` 五个 JSON 列只做整列读写）。
  - **§2.1 合规**（`:1`/`:124`）；**§2.2 合规**（`CREATE TABLE IF NOT EXISTS` + `DO` 块判定，重跑无副作用）；**§2.3 合规**（无 DROP/TRUNCATE/DELETE）；**§2.4 不涉及**（无 UPDATE）。
  - **§4 完全合规**：`:4-8` 三段式头注释齐全——变更目的（`:4-5`）、影响面（`:6-7`）、回滚（`:8`）。**本批 6 个文件中只有 `021`、`022` 满足 §4**。
  - **可安全重跑**：全文件无 INSERT/UPDATE/DELETE，`CREATE TABLE IF NOT EXISTS` + `pg_indexes` 判定双重幂等，重跑是纯 no-op。与 `017`/`019` 的「不可重复执行」形成对比。
- **DDL 与 ORM 逐项核对结果：状态取值域与默认值全部一致**（这是本次建档的重点核对项）：

| 列 | DDL | ORM 默认值 | 应用层白名单 | 结论 |
|---|---|---|---|---|
| `ai_knowledge.status` | `DEFAULT 'draft'`（`:19`） | `"draft"`（`models.py:565`） | `ai_knowledge_service.py:20` `ALLOWED_STATUS = ("draft","pending","published","rejected","archived")` | **三方一致**；DDL docstring `models.py:543` 列出同一 5 值 |
| `ai_knowledge.category` | 可空无默认（`:17`） | `Optional[str] default=None`（`:561`） | `ai_knowledge_service.py:21` `("event","route","figure","custom")` | 一致（`models.py:544` 同口径） |
| `ai_conversations.status` | `DEFAULT 'active'`（`:32`） | `"active"`（`:585`） | 未找到白名单常量 | 默认值一致；取值域仅 `models.py:576` docstring（`active`/`archived`）记载，**是否有应用层校验：待确认** |
| `ai_messages.role` | NOT NULL 无默认（`:41`） | `String(16)` 无默认（`:603`） | 未找到白名单常量 | 一致；取值域见 `models.py:591`（`user`/`assistant`/`system`） |
| `ai_generation_jobs.status` | `DEFAULT 'pending'`（`:57`） | `"pending"`（`:627`） | 未找到白名单常量 | 默认值一致；取值域 `models.py:613`（`pending`/`running`/`success`/`partial`/`failed`）——**已复核，与任务给定行号一致** |
| `ai_generation_jobs.job_type` | `DEFAULT 'question'`（`:51`） | `"question"`（`:621`） | 未找到白名单常量 | 一致；**取值域未在任何注释中记载：待确认** |
| `ai_generated_questions.status` | `DEFAULT 'pending'`（`:70`），且 `:64` 注释直接列出 4 值 | `"pending"`（`:653`） | `ai_question_service.py:395` `DRAFT_STATUSES = ("pending","approved","rejected","imported")` | **三方一致**（DDL 注释 `:64`、ORM docstring `:637`、应用层常量）——**已复核，与任务给定两处行号一致** |
| `ai_usage_logs.status` | `DEFAULT 'success'`（`:86`） | `"success"`（`:681`） | `ai_usage_service.py:28` 按 `== "success"` 计数 | 一致；取值域 `models.py:664`（`success`/`error`） |
| `ai_usage_logs.feature` | NOT NULL 无默认（`:82`） | `String(30)` 无默认（`:677`） | 未找到白名单常量 | 一致；取值域 `models.py:663`（`chat`/`route_guide`/`quiz_explanation`/`question_gen`） |

  **关键结论：DDL 里没有任何 CHECK 约束**（6 张表逐列核对，0 处），因此**不存在「DDL CHECK 与 ORM 取值域冲突」的可能**；所有状态取值域只由「DDL 注释 + ORM docstring + 应用层常量」三处文字/代码约定，其中 `ai_knowledge.status`、`ai_knowledge.category`、`ai_generated_questions.status` 三处有应用层白名单硬校验，其余（`ai_conversations.status`、`ai_messages.role`、`job_type`、`ai_usage_logs.feature`）**只有 docstring 约定、未见白名单常量**——这与 `.qoder/ARCHITECTURE.md` §13.2「无任何 CHECK 约束，所有枚举都是 VARCHAR + 应用层常量校验」的全库口径一致，但「应用层常量校验」在 AI 表上只覆盖了 3/7 个枚举列。
- **DDL 与 ORM 的其余分歧（均为机制差异，无运行时影响；因禁用 `create_all`，实际库以 DDL 为准）**：
  1. **时间默认值两套写法**：DDL 6 张表的 `created_at`/`updated_at`/`finished_at` 等全部是 `TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`（**DB 会话时区**），ORM 对应列全部是 `default=datetime.utcnow`（**客户端 naive UTC**，`models.py:568-569`、`:586-587`、`:607`、`:630-631`、`:657`、`:684`）且**无 `server_default`**。经 ORM 写入的行是 UTC，经裸 SQL 写入的行是 DB 时区——`.qoder/ARCHITECTURE.md` §13.2 记录的「两套默认值写法」在 AI 六表上全线存在。`published_at`/`reviewed_at`/`finished_at` 可空无默认，两侧一致。
  2. **列长度校验双写**：DDL `title VARCHAR(200)`（`:12`）/ `source VARCHAR(300)`（`:14`）与 `ai_knowledge_service.py:22-23` 的 `TITLE_MAX_LEN=200`/`SOURCE_MAX_LEN=300` 数值一致——**两处硬编码同一个魔数**，改 DDL 需同步改常量（属可接受的显式校验，但存在漂移风险）。
  3. **`related` 数组长度上限只在应用层**：`ai_knowledge_service.py:24` `RELATED_MAX = 10`，DDL 无对应约束（JSON 列本身也无法表达）。
  4. **FK 与逻辑外键划分两侧完全一致**：4 处真 FK（DDL `:18`/`:30`/`:40`/`:67` ↔ ORM `:562-564`/`:583`/`:600-602`/`:648-650`，含 `ON DELETE CASCADE` ↔ `ondelete="CASCADE"`）；3 处无 FK 的逻辑外键（DDL `:73` `question_id`、`:80` `user_id`、`:81` `conversation_id` ↔ ORM `:656`、`:675`、`:676`）——后三者计入 `.qoder/ARCHITECTURE.md` §13.2 的「13 处逻辑外键」。
  5. **`ai_messages.conversation_id` 的 ORM 索引声明**：ORM `:597` 声明 `Index("ix_ai_messages_conv_id","conversation_id","id")`，DDL `:105` 同名同列——一致。
  6. **9 个索引名逐一比对：全部一致，无多余无缺失**（DDL `:95`-`:120` ↔ ORM `:551`、`:552`、`:580`、`:597`、`:618`、`:643`、`:644`、`:670`、`:671`）。
- **敏感信息检查**：**本文件不含任何敏感种子值**——无 `INSERT`、无口令/密码/Token/AppSecret/JWT 密钥/连接串、无 CloudBase 环境 ID 或 API Key、无邀请码明文、无真实 openid/unionid。全部 6 张表的凭据类字段（`created_by`/`reviewed_by`）只存操作人标识（`VARCHAR(64)`），且由运行期写入而非种子。`ai_usage_service.py:5` 进一步保证运行期日志也不含 API Key/JWT。**无需轮换处置。**
- **回滚方式**：`:8` 头注释已给出——「无副作用，可直接忽略；如需彻底回退，单独走运维流程 DROP 这 6 张 `ai_*` 表（**不在本脚本内**）」。即本文件**不含回滚语句**，这是有意设计（符合 `SQL_CONSTRAINTS.md` §2.3「迁移不删除数据」）。手工回滚顺序须按 FK 反序：`DROP TABLE ai_usage_logs, ai_generated_questions, ai_generation_jobs, ai_messages, ai_conversations, ai_knowledge;`——会销毁全部 AI 会话历史、知识库审核记录与出题草稿，且 ORM 六个模型会立即报 `UndefinedTable`。**生产尚未执行，故生产侧无需回滚。**

## 10. 迭代记录

> **数据来源说明**：本文件按仓库根 `agents.md` §1.3「`docker/` 目录下的代码不自动提交」**未入库**，`git status --porcelain` 显示 `?? docker/init/021_ai_center.sql`，`git ls-files docker/init/` 不含本文件，故 `git log --follow -- docker/init/021_ai_center.sql` 与 `git blame` **均无输出**——**本节不列本文件自身的提交号，以下条目引用的是引入对应功能的后端/前端提交**（已逐个 `git show --stat` 核实确属 AI 智能中心）。

### 2026-10-22

- 需求：AI 上游三次变更（`c660727` 腾讯云 CloudBase Agent → 阿里云百炼、`6a4dbb7` SSE 真流式、`b712d81` 改为 `LLM_PROVIDER` 可切换的双供应商）后，校正本文档中对 `ai_usage_logs.model` / `used_tokens` / `error_code` 取值口径与 AI 配置项、上游模块清单的过期表述。**本次源码与 SQL 均未改动**：`docker/init/021_ai_center.sql` 一字未动（根 `agents.md` §4 与 `SQL_CONSTRAINTS.md` §3.1 的禁改口径；且三次上游变更**表结构零变化、无需任何迁移**），属**纯文档同步**（补 `c660727`/`6a4dbb7` 欠账 + `b712d81` 口径）。
- 修改内容：① §4.6 重写 `ai_usage_logs` 三列的取值口径——`model` 由「暂存 Agent ID」改为**随 `LLM_PROVIDER` 取真实模型名或 Agent ID**（写入点 `llm_service.model_label()`，`llm_service.py:67-74`；非法 provider 时不抛异常）、`used_tokens` 明确**两套供应商口径不同**（openai = `usage.total_tokens`；cloudbase = `usage_update.used` 原值，量级不稳不可作单次计费依据，`llm_base.py:32-34`）、`error_code` 补记**自 `c660727` 起为 `llm`（不再是建档时的 `cloudbase`），`b712d81` 后两套供应商统一仍写 `llm`**（写入点仅 `ai_chat_service.py:352`、`:529`、`routes/ai.py:160`）；并注明同一 `used_tokens` 口径也适用于 §4.3 的 `ai_messages.used_tokens`（`ai_chat_service.py:287`），§4.3 与 ORM docstring `models.py:616` 的「平台原值」只在 cloudbase 下成立，属源码注释滞后。② §5 的 AI 配置项清单按 `config.py:68-93` 重写为「开关 + 共用超时 / openai 段 / cloudbase 段」三组，更正旧名 `CLOUDBASE_ACP_URL` → **`CLOUDBASE_AGENT_URL`**，补记 `LLM_PROVIDER`、`LLM_TIMEOUT_SECONDS`（`CLOUDBASE_TIMEOUT_SECONDS` 已移除且不恢复）与两个 `*_EXTRA_BODY`，并保留 `37f3e40` 的历史事实、补上「上游现为可切换（`b712d81`）」的当前口径。③ §6 读写方把已不存在的 `cloudbase_service.py` 更正为「门面 `llm_service.py` + `llm_openai.py` + `llm_cloudbase.py` + `llm_base.py`」四模块并给出完整沿革（含 `6a4dbb7` 的 `LlmStream`）。④ §4.3/§4.6 中与本次口径直接相关的 `models.py` 引用行号已按当前文件刷新。
- 关联文件：`backend/app/services/llm_service.py`、`llm_base.py`、`llm_openai.py`、`llm_cloudbase.py`、`backend/app/core/config.py:68-93`、`backend/app/services/ai_chat_service.py`、`backend/app/api/routes/ai.py`、`backend/app/models/models.py`（AI 六模型 docstring）、`backend/test/s30_llm_provider_switch.py`；文档侧 `.qoder/backend/test/README.md` §3.1、`.qoder/backend/requirements.txt.md` §4。
- 测试结果：本次未跑测试、未连库（纯文档修订，SQL 与源码零改动）。口径均以 2026-10-22 实读源码为据（`llm_service.py`、`llm_base.py`、`config.py:58-102`、`ai_chat_service.py:285-300`、`models.py` AI 段与 `grep -n error_code`）。`b712d81` 自身的验证结论（s30 23/23、s25 16/16、s26 47/47、s28 13/13，合计 99/99，**无 SQL 迁移**）见 `docs/迭代记录.md` 的 `b712d81` 条目与 `backend/test/docs/s30-llm-provider-switch-report.md`。
- **遗留待确认（本次未处理）**：① **`models.py` 行号漂移**——`b712d81` 给 `AiMessage`/`AiUsageLog` 的 docstring 补了用量口径说明，六个 AI 模型的类起始行整体下移 **23 行**（建档时 `:540`/`:573`/`:590`/`:610`/`:634`/`:660` → 现 `:563`/`:596`/`:613`/`:633`/`:657`/`:683`，文件共 709 行，2026-10-22 `grep -n "^class Ai"` 实测）。本次只刷新了 §4.3/§4.6 中与 `model`/`used_tokens`/`error_code` 直接相关的引用，**§6「对应 ORM」表的 6 处类范围与 9 处 `Index(...)` 行号、以及 §7/§9 中其余形如 `models.py:NNN` 的引用仍是 2026-10-17 建档时的行号，未逐条复核**，引用前请先按类名定位（可视为约 +23 行的近似值）。② **生产库是否已执行本迁移**：§1/§8.1/§9 记「生产 openGauss 缺失 `021`/`022`」为 2026-10-17 口径，而本次任务口径称 `021` 属「已在生产执行过的编号脚本」——两者不一致，生产 `schema_migrations` 实际内容**待确认**（本次禁止连库核对，未凭推测下结论）。

### 2026-10-17（`1fbacac`，11:26）
- 需求：VPN 关闭后重跑 AI 智能中心真实链路，验证无需 dns_shim。
- 修改内容（涉本文件）：**未改动本文件**。该提交只更新测试报告与结果 JSON、新增 `frontend/test/automator/ai-chat-live.cjs`（5 个文件）；核实结论是本文件的表结构在真实 Agent 全链路下已通过验证。
- 关联文件：`backend/test/docs/s26-ai-center-report.md`、`backend/test/s26-ai-center-results.json`、`frontend/test/automator/ai-chat-live.cjs`、`frontend/test/docs/ai-chat-page-report.md`。
- 测试结果：s26 **47/47** 通过（无 DNS shim）；小程序模拟器真实 Agent E2E **4/4** 通过。见 `docs/迭代记录.md` 的 `1fbacac` 条目。

### 2026-10-17（`1600074` / `0052108`，均 11:06）
- 需求：《长征步迹 AI 智能中心开发需求 V1.0》Phase A——后端全做 + 小程序聊天页；usage/cost 与管理后台 Vue 页明确延后。
- 修改内容（涉本文件）：本文件在此期间创建并应用于本地 openGauss（建 6 表 + 9 索引），但**未被这两个提交纳入版本库**。`1600074`（后端，15 个文件、+3422 行）新增 `backend/app/models/models.py` 的 148 行——即本文件镜像的 6 个 ORM 模型（`models.py:540-684`）——以及 6 个 AI 服务、`routes/ai.py`、`routes/ai_admin.py`、`schemas.py` 244 行、冒烟脚本 `s26_ai_center.py`；`git show --stat 1600074` 的文件清单中**无任何 `docker/init/*`**，是本文件未入库的直接证据。`0052108`（前端，30 个文件）新增 `frontend/pages/ai-chat/` 四件套与 `frontend/services/ai.js`，并把底部「情报」tab 换防为「AI 问答」。
- 关联文件：`backend/app/models/models.py:540-684`、`backend/app/services/ai_{chat,knowledge,question,usage,config}_service.py`、`backend/app/services/cloudbase_service.py`、`backend/app/api/routes/ai.py`、`backend/app/api/routes/ai_admin.py`、`docker/init/022_ai_admin_menus.sql`（同批未入库）、`frontend/pages/ai-chat/`、`frontend/services/ai.js`。
- 测试结果：`1600074` 冒烟 s26 **47/47** 通过（含真实 Agent 调用），报告 `backend/test/docs/s26-ai-center-report.md`；`0052108` 报告 `frontend/test/docs/ai-chat-page-report.md`、`ai-tab-swap-report.md`。见 `docs/迭代记录.md` 的 `1600074`、`0052108` 条目。

### 2026-10-17（`37f3e40`，00:22）
- 需求：新增腾讯云 CloudBase Agent 相关配置项，为 AI 智能中心提供外部集成凭据。
- 修改内容（涉本文件）：**未改动本文件，且不涉及任何 SQL**——该提交只改 `backend/.env`（+14 行）与 `backend/.env.prod`（+19/−3 行）。这构成 §5「本文件不种 AI 配置项」的直接证据：**AI 配置走环境变量 + `system_settings` 覆盖（`ai_config_service.py:3`），不走数据库种子**。
- 关联文件：`backend/.env`、`backend/.env.prod`（配置项名称见 `backend/app/core/config.py:66-91`；**依 `.qoder/README.md` §3.14，本文档不记录任何值**）。
- 测试结果：见 `docs/迭代记录.md` 的 `37f3e40` 条目。
