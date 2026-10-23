# ai_question_service.py

## 1. 文件路径

`backend/app/services/ai_question_service.py`（699 行）

## 2. 文件职责

AI 出题服务：调用大模型生成「中国工农红军长征」单项选择题草稿，逐题做结构规整、内容校验与查重，经管理员人工确认后写入正式题库 `questions`。上游不绑定厂商——本文件只 import `llm_service` 门面（`:22`），由门面按 `settings.LLM_PROVIDER` 分派到 `llm_openai`（OpenAI Chat Completions 兼容，如阿里云百炼）或 `llm_cloudbase`（腾讯云 CloudBase Agent ACP 私有协议）。文件内含**两条并行链路**：

- **内存态旧链路**（`generate_questions` `:309-346` / `batch_save_questions` `:349-392`）：生成结果只在 HTTP 响应里返回草稿、不落库，管理员在弹窗内编辑/剔除后再调保存接口入库。当前 admin 前端唯一在用的链路。
- **持久化题目工坊**（`:395-699`）：一次生成落一条 `ai_generation_jobs` 任务，每道草稿落一条 `ai_generated_questions`，支持任务/草稿列表回溯、逐条编辑与审核、幂等导入题库。`:395-398` 的区块注释明确「现有 admin 前端的旧链路保持不变，本组接口供新工坊页使用」；**新工坊页属待开发**（`.qoder/ARCHITECTURE.md` §11.3）。

实际 HTTP 调用不在本文件：`_generate_batch`（`:204-211`）只调 `llm_service.prompt`（`:208-210`）；门面 `backend/app/services/llm_service.py` 按 `settings.LLM_PROVIDER` 分派，协议编解码 / 流式或非流式 / 重试退避全部在**当前生效的适配器**里（`llm_openai.py` = OpenAI 兼容 / `llm_cloudbase.py` = ACP），门面本身不含协议知识（均由同批 backend services 建档覆盖，本文档只引用不展开）。

## 3. 业务需求

- **需求来源①**：题库接入 CloudBase Agent AI 出题，草稿审核后入库（提交 `ea58b6c`，2026-10-16；`docs/迭代记录.md`「题库接入 CloudBase Agent AI 出题，草稿审核后入库（功能）」条目）。要求：生成参数含主题（必填）、数量 10/20/50/100、分类、难度（**仅作提示词参数，不入库**）、附加要求；题型固定单选；原有 Excel 批量导入与题目增删改查全部保留。
- **需求来源②**：《长征步迹 AI 智能中心开发需求 V1.0》**§3.4 题目工坊**（`:395` 区块注释直接标注该章节号），Phase A 后端提交 `1600074`（2026-10-17）。
- **设计约束**（模块 docstring `:1-10`，逐条对应实现）：
  1. 仅生成单选题（`type=single`），与小程序答题逻辑「单答案提交」保持一致（`:4`；`:26-27` 注明多选题需同步改判分与小程序交互，属破坏性变更，故不开放）。
  2. 难度只作提示词参数、不入库，因为 `questions` 表无 difficulty 列（`:5`；列清单见 `backend/app/models/models.py:145-161`、DDL `docker/init/001_schema.sql:16-24`）。
  3. 生成结果一律是草稿，不直接写库；管理员确认后由 `batch_save_questions` 落库（`:6`）。
  4. 入库前复用 `admin_service._validate_question`（**与 Excel 导入同等校验强度**），并重新做库内/批内查重，**不信任前端回传内容**（`:7-8`）。
  5. 大批量拆成多批并发调用模型，规避单次长回复被截断（`:9`；`backend/app/core/config.py:95` 注释同一口径）。
- 导航层见 `.qoder/REQUIREMENTS.md` §10.1/§10.3 与 `.qoder/ARCHITECTURE.md` §11.2/§11.3，本文档不复述其正文。
- **管理端现状**：嵌在题库页的「AI 智能出题」全屏对话框 `admin/src/components/AiGenerateDialog.vue` 已落地并走旧链路（`.qoder/ARCHITECTURE.md` §11.3 末段专门说明「这与题目工坊子页面待开发并不矛盾」）；独立的题目工坊管理页**待开发**。

## 4. 核心功能

### 4.1 模块常量（`:24-48`）

| 常量 | 行号 | 值 | 用途 |
|---|---|---|---|
| `logger` | `:24` | — | `logger.info` 4 处（`:335`、`:391`、`:536`、`:693`）、`logger.exception` 2 处（`:389`、`:691`） |
| `SUPPORTED_TYPES` | `:28` | `("single",)` | 题型白名单，校验点 `:293-294` |
| `SUPPORTED_DIFFICULTIES` | `:29` | `("easy","medium","hard","mixed")` | 难度白名单，校验点 `:295-296` |
| `SUPPORTED_CATEGORIES` | `:30` | `("event","route","figure")` | 分类白名单（可空），校验点 `:297-299`；与 `backend/app/services/admin_service.py:215` 的取值一致 |
| `TOPIC_MAX_LEN` | `:32` | `100` | 主题长度上限，校验点 `:291-292`；与 `AdminAiJobCreateRequest.topic` 的 `max_length=100`（`backend/app/schemas/schemas.py:1936` 起）及 admin 前端 `TOPIC_MAX_LEN`（`admin/src/components/AiGenerateDialog.vue`）三处同值 |
| `EXTRA_MAX_LEN` | `:33` | `300` | 补充要求长度上限，校验点 `:300-302` |
| `DEFAULT_SCORE` | `:34` | `20` | AI 生成题目的固定分值（`:163`、`:181`）；与 `AdminQuestionUpsert.score` 默认值 20 一致（`backend/app/schemas/schemas.py:1151` 起） |
| `OPTION_LABELS` | `:35` | `("A"…"F")` | label 补齐用（`:139`）与提示词/空白占位切片用（`:89`、`:159`） |
| `DEFAULT_OPTION_COUNT` | `:36` | `4` | **仅用于提示词与空白占位**（`:87`、`:89`、`:159`），不用于校验（见 §7 第 5 条） |
| `_DIFFICULTY_TEXT` | `:38-43` | 4 项中文描述 | 难度 → 提示词文案（`:76`），未命中回退 `medium` |
| `_CATEGORY_TEXT` | `:44-48` | 3 项中文描述 | 分类 → 提示词文案（`:79`） |
| `DRAFT_STATUSES` | `:399` | `("pending","approved","rejected","imported")` | **定义后全仓无任何引用**（死常量，见 §9） |

### 4.2 内部工具函数

| 函数 | 行号 | 职责 |
|---|---|---|
| `_split_batches(count, batch_size)` | `:51-57` | 把总题数拆成批次列表；`size = max(1, batch_size)` 兜住 0/负数（`:53`），`[size] * (count // size)` 加余数批（`:54-56`）。docstring 举例：25 题、每批 10 → `[10, 10, 5]` |
| `_build_prompt(topic, count, difficulty, category, extra, references="")` | `:60-104` | 构建提示词，约束模型只输出可直接 `json.loads` 的题目数组（详见 §4.4） |
| `_extract_json_array(reply)` | `:107-122` | 从回复提取 JSON 数组：**容忍代码围栏**（`:110-112`，剥掉首个 ``` 行与末尾 ```）与前后多余文本（`:113`，取首个 `[` 到末个 `]`）；找不到括号/`json.loads` 失败/结果非 list 分别抛 `ValueError`（`:114-121`），文案面向管理员（「AI 返回内容不是 JSON 数组，请重试」/「AI 返回的 JSON 无法解析，请重试」） |
| `_normalize_options(raw_options)` | `:125-141` | 规整为 `[{"label","text"}]`；兼容三种写法 `{label,text}` / `{label,content}` / 纯字符串数组（`:133-137`）；label 缺失时按顺序补 `A/B/C/D…`，超 6 个退化为序号字符串（`:138-139`） |
| `_normalize_answer(raw_answer)` | `:144-150` | 统一为大写 label 数组，兼容 `"B"` / `["B"]` / `["b"]`（`:146-150`）；非 list 抛 `ValueError("answer 字段必须是数组")` |
| `_blank_question(category)` | `:153-165` | 结构完整但内容为空的占位题目，供无法解析的条目使用，**保证前端可渲染并手工修正**（`:154` docstring） |
| `_normalize_item(raw, category)` | `:168-183` | 单个元素 → `questions` 表结构；非 dict 抛 `ValueError("题目必须是 JSON 对象")`、`options` 非 list 抛 `ValueError("options 字段必须是数组")`（`:170-174`） |
| `_existing_question_texts(db)` | `:186-189` | 库内**启用**题干集合（`filter(Question.active.is_(True))`），「口径与 Excel 导入预览一致」（`:187` docstring） |
| `_duplicate_reasons(text, existing, seen)` | `:192-201` | 返回重复原因列表；题干为空时**不报重复**（交由校验环节报「题干不能为空」，`:193`、`:195-196`）；库内重复 → `["与题库中已有题目重复"]`，批内重复 → `["与本次生成的其他题目重复"]`（`:197-200`） |
| `_generate_batch(topic, count, difficulty, category, extra, references="")` | `:204-211` | 调 `llm_service.prompt(_build_prompt(...))`（`:208-210`）并解析成原始元素列表；**不触碰 `db`**（并发安全前提，见 §8） |
| `_run_batches(...)` | `:214-253` | 并发执行各批次（详见 §4.5） |
| `_build_drafts(db, elements, category)` | `:256-276` | 原始元素 → 草稿列表（详见 §4.6） |
| `_validate_params(...)` | `:279-306` | 校验并规整出题参数（详见 §4.3） |
| `_references_from_knowledge(db, knowledge_ids)` | `:402-419` | 知识接地：按传入 ID 拼「参考资料」（详见 §4.8） |
| `job_view(job, drafts=None)` | `:422-439` | `AiGenerationJob` → dict；`drafts is not None` 时才附 `drafts` 键（`:437-438`），对应 `AdminAiJobOut.drafts` 默认 `[]`（`backend/app/schemas/schemas.py:1962` 起） |
| `draft_view(draft)` | `:442-453` | `AiGeneratedQuestion` → dict，对应 `AdminAiDraftOut`（`backend/app/schemas/schemas.py:1948` 起） |
| `_get_draft(db, draft_id)` | `:585-589` | 取草稿，不存在抛 `ValueError("草稿不存在")` |

两个 view 函数对可空列统一 `or ""` / `or {}` / `or []` 兜底（`:427`、`:432-433`、`:446-450`），因为本库空字符串按 NULL 存储（`backend/app/models/models.py:569`）。

### 4.3 参数校验 `_validate_params`（`:279-306`）

返回 `(topic, count, difficulty, category, extra)`，全部为 strip 后的值。逐条规则：

| 规则 | 行号 | 失败文案 |
|---|---|---|
| 主题非空 | `:288-290` | 出题主题不能为空 |
| 主题 ≤ 100 字 | `:291-292` | 出题主题不能超过 100 字 |
| 题型 ∈ `SUPPORTED_TYPES` | `:293-294` | AI 出题目前仅支持单选题（single） |
| 难度 ∈ `SUPPORTED_DIFFICULTIES` | `:295-296` | 难度必须为 easy（简单）/ medium（中等）/ hard（困难）/ mixed（混合） |
| 分类为空或 ∈ `SUPPORTED_CATEGORIES` | `:297-299` | 分类必须为 event（历史事件）/ route（长征路线）/ figure（历史人物）或留空 |
| 补充要求 ≤ 300 字 | `:300-302` | 补充要求不能超过 300 字 |
| `1 <= count <= settings.AI_QUESTION_MAX_COUNT` | `:303-305` | 生成数量必须在 1~{max_count} 之间 |

`max_count` 在**运行时**读 `settings.AI_QUESTION_MAX_COUNT`（`:303`），而 schema 侧 `count` 硬编码 `le=100`（`backend/app/schemas/schemas.py:1233` 起的 `AdminAiGenerateRequest` 与 `:1936` 起的 `AdminAiJobCreateRequest`）：调大 env 值不会放开 HTTP 上限（先被 Pydantic 拦成 422），调小则 service 层 400 生效。

### 4.4 提示词构建 `_build_prompt`（`:60-104`）

按行拼接，顺序为：

1. `references` 非空时**前置注入**参考资料段（`:68-73`）：「请严格依据以下已审核的参考资料出题，不要超出资料范围编造史实」+ 资料正文（docstring `:65` 说明「题目工坊按已发布知识出题」）。
2. 主题与数量：「请围绕主题「{topic}」生成 {count} 道中国工农红军长征相关的单项选择题。」（`:75`）。
3. 难度要求（`:76`，查 `_DIFFICULTY_TEXT`，未命中回退 medium）。
4. 分类侧重（`:78-79`，`category` 为空则整行不输出）。
5. **11 条输出要求**（`:80-99`）：只输出一个 JSON 数组、不要解释/前后缀/Markdown 围栏（第 1 条，`:83`）；数组长度恰好为 count（第 2 条，`:84`）；每元素只含 `question`/`options`/`answer`/`analysis` 四字段（第 3 条，`:85-86`）；`options` 固定 4 个、形如 `{"label":"A","text":"…"}`、label 依次 A、B、C、D（第 4 条，`:87-89`）；`answer` 必须是只含 1 个元素的数组（第 5 条，`:90`）；有且仅有一个正确答案、错误选项须有明显区分度（第 6 条，`:91`）；`analysis` 用 1~3 句中文（第 7 条，`:92`）；各题题干与选项不得重复或高度雷同（第 8 条，`:93`）；**史实必须准确、无法确认的不要编造**（第 9 条，`:94`）；简体中文、不要出现题号编号（第 10 条，`:95`）；**所有字符串内部不得出现英文双引号与反斜杠，需要引用原文或强调时改用中文引号**（第 11 条，`:99`，`b712d81` 新增，见下）。
6. `extra` 非空时追加**第 12 条**补充要求（`:101-103`）；序号在 `b712d81` 前为「11.」，现因插入新规则而后移。

**第 11 条的来历（源码 `:96-98` 原注释）**：实测模型会在题干里写未转义的英文双引号（如把「平生最得意之笔」直接加英文引号），导致整批 JSON 解析失败（10 批挂 2 批）；显式在提示词层禁止内层英文引号比事后写 JSON 修复引擎更可靠，且**对任何供应商都适用**。该条与 `LLM_PROVIDER` 无关，切回 OpenAI 兼容上游后同样生效。

第 1~5 条与解析/规整函数一一对应（`_extract_json_array` ↔ 第 1 条、`_normalize_item` ↔ 第 3 条、`_normalize_options` ↔ 第 4 条、`_normalize_answer` ↔ 第 5 条），第 6/8 条由 `admin_service._validate_question` 与 `_duplicate_reasons` 在服务端兜底复核——**提示词只是请求，不是保证**；第 11 条同理，只降低失败率，`_extract_json_array` 仍会对残留的非法 JSON 抛 `ValueError`。

### 4.5 分批并发策略 `_run_batches`（`:214-253`）与三个配置项的实际使用点

| 配置项（env 默认见 `backend/app/core/config.py`） | 代码默认 | 使用点 | 作用 |
|---|---|---|---|
| `AI_QUESTION_BATCH_SIZE`（`:96`） | 10 | `:323`（`generate_questions`）、`:494`（`run_job`） | 传给 `_split_batches` 决定每批题数 → 批数 = ⌈count / batch_size⌉ |
| `AI_QUESTION_MAX_CONCURRENCY`（`:97`） | 3 | `:227` | `workers = max(1, min(len(batches), settings.AI_QUESTION_MAX_CONCURRENCY))`——**既不超过批数，也不低于 1** |
| `AI_QUESTION_MAX_COUNT`（`:98`） | 100 | `:303`（生成数量上限）、`:358`（单次保存上限）、`:642-643`（单次导入上限） | 三处独立限制：生成、批量保存、草稿导入 |

`AI_QUESTION_BATCH_SIZE` 的**代码默认是 10**（`config.py:96`）；`c660727` 记载的「降至 5」属 env 覆盖——`backend/.env:65` 与 `backend/.env.prod:79` 均为 `AI_QUESTION_BATCH_SIZE=5`（两份 env 均入库），运行期实际取 5，代码默认值仅在 env 缺该项时生效；`b712d81` 明确保持 5 不随供应商调整。

执行细节：

- `ThreadPoolExecutor(max_workers=workers)`（`:229`），用 dict 推导一次性 submit 全部批次并记住批次序号（`:230-235`）。
- `as_completed` 收集（`:236`）；**单批失败不影响其他批次**：`except Exception` 把异常连同批次号记入 `outcomes`（`:238-241`，`:240` 注释「批次级兜底：任何单批异常都不得中断整体生成」）。
- `outcomes.sort(key=lambda item: item[0])`（`:242`）：完成顺序被打乱后**按批次序号重排**，保证题目顺序与请求批次一致。
- 汇总（`:243-253`）：成功批 `elements.extend(data or [])`；失败批 `errors.append(f"第 {index + 1} 批生成失败：{exc}")`，并保留 `first_error`（**首个异常保留原类型**，`:224-225` docstring 说明「以便全部失败时路由层仍能区分 502（上游故障）与 400（参数/解析问题）」）。
- 返回 `(elements, errors, first_error)`（`:221`、`:253`）。
- 线程内只有 HTTP、无数据库访问（`_generate_batch` `:204-211`），因此 Session 不跨线程共享；这也是本函数唯一可安全并发的前提。上游门面与适配器同样不在线程内碰 `db`（`llm_service` 无数据库依赖）。
- 无取消检查点：线程池会跑完全部批次（`:229-241`），客户端断开连接不会中止生成。

### 4.6 草稿组装 `_build_drafts`（`:256-276`）

对每个原始元素：

1. `_normalize_item` 抛 `ValueError` → 用 `_blank_question(category)` 占位，并把异常文案记入 `errors`（`:263-267`）；**该条目不进 `seen`**，因此多条结构非法的空白草稿之间不会互相判重。
2. 规整成功 → 调 `admin_service._validate_question(data)`，`ValueError` 记入 `errors`（`:269-272`）；再 `_duplicate_reasons(data["question"], existing, seen)` 追加库内/批内重复原因（`:273`）；随后 `seen.add(data["question"].strip())`（`:274`）。
3. 每条产出 `{"index": len(drafts) + 1, "data": data, "errors": errors}`（`:275`）——**`index` 从 1 起**，与 `AdminAiSaveFailure.index` 的口径一致（`backend/app/schemas/schemas.py:1276` 起）。

`errors` 非空即「待修正」，`generate_questions` 据此统计 `invalid_count`（`:334`、`:342-343`）。

### 4.7 旧链路（内存态）

**`generate_questions(db, topic, count, question_type="single", difficulty="medium", category="", extra_requirements="")`（`:309-346`）**

- docstring `:318` 明确「不写入正式题库（内存态，供旧预览链路）」。
- 流程：`_validate_params`（`:319-321`）→ `_split_batches`（`:323`）→ `_run_batches`（`:324-326`，**未传 `references`，故旧链路不支持知识接地出题**）→ 全部批次失败时抛 `first_error`（保留 `LlmError` 类型，`:327-330` 注释原文「全部批次失败：抛出原始异常，保留 LlmError 类型以便路由映射为 502」），无异常但无元素则 `ValueError("AI 未返回任何题目，请重试")`（`:331`）→ `_build_drafts`（`:333`）→ `logger.info` 打点（`:335-338`，只记长度与计数，**不记主题与题目正文**）。
- 返回（`:339-346`）：`{requested, generated, valid_count, invalid_count, items, batch_errors}`，对应 `AdminAiGenerateOut`（`backend/app/schemas/schemas.py:1259` 起）。
- 数据库：只读 `questions`（`:188`），**不写、不 commit**。

**`batch_save_questions(db, items)`（`:349-392`）**

- 空列表 → `ValueError("没有需要保存的题目")`（`:356-357`）；条数 > `AI_QUESTION_MAX_COUNT` → `ValueError(f"单次最多保存 {max_count} 道题目")`（`:358-360`）。
- 逐条**重新**校验（`admin_service._validate_question`，`:367-372`）与查重（库内 + 批内，`:373-377`），未通过的记 `{"index": index, "reason": …}` 进 `failures`（index 从 1 起，`:366`）并跳过；通过的进 `pending`。
- 写入（`:380-390`）：`base_id = db.query(func.max(Question.id)).scalar() or 0`（`:382`，`:381` 注释「questions.id 无数据库自增（种子占用固定 id），与新增/导入一致显式取 max+1 连续分配」），逐条 `Question(id=base_id + offset, **data)`（`:384-385`），**`db.commit()`（`:386`）**；任何异常 → `db.rollback()` + `logger.exception` + `ValueError("保存失败，请稍后重试")`（`:387-390`）。
- docstring `:352-354`：「不信任前端：每条都重新过 `admin_service._validate_question` 与库内/批内查重。通过校验的题目在单事务内写入，数据库异常整体回滚；未通过的跳过并计入失败明细，从而实现『部分失败可统计』而不产生半批脏数据。」
- 返回 `{saved, failed, failures}`（`:392`），对应 `AdminAiBatchSaveOut`（`backend/app/schemas/schemas.py:1283` 起）。

### 4.8 持久化题目工坊（`:395-699`）

**`_references_from_knowledge(db, knowledge_ids)`（`:402-419`）**：`int()` 容错跳过非法 ID（`:405-409`）；只取 `status == "published"` 的资料（`:412-416`，`:403` docstring「未发布的忽略」）；按**传入顺序**重排（`:417-418`）；交 `ai_knowledge_service.format_context` 拼成「【资料N】标题（来源：X）\n正文」段落（`:419`；实现 `backend/app/services/ai_knowledge_service.py:245` 起）。

**`run_job(db, actor, topic, count, question_type="single", difficulty="medium", category="", extra_requirements="", knowledge_ids=None)`（`:456-539`）**

1. `_validate_params`（`:471-473`）→ `_references_from_knowledge`（`:474`）。
2. 建任务行（`:475-489`）：`job_type="question"`、`status="running"`、`created_by=actor`、`requested=count`、`params` 为参数快照（含过滤后的 `knowledge_ids`，`:484`）；`db.add(job)` + **`db.flush()`**（`:490-491`）以取得 `job.id`（`SessionLocal` 为 `autoflush=False`，`backend/app/core/database.py:51`）。
3. 生成（`:493-497`）包在 `try` 内；上游/网络异常 → `job.status="failed"`、`job.error=str(exc)[:500]`、`job.finished_at=now_utc()`、**`db.commit()`**（`:498-502`）后**原样 raise**（`:503`），docstring `:469` 说明「任务落 failed 并落库，再抛出原始异常供路由区分 502/400」。
4. `elements` 为空 → `status="failed"`、`failed=count`、`error` 取 `first_error` 或「AI 未返回任何题目」（均截断 500 字）、`finished_at`、**`db.commit()`**（`:505-510`），再抛 `first_error` 或 `ValueError`（`:511-513`）。
5. `_build_drafts`（`:515`）后逐条建 `AiGeneratedQuestion(job_id=job.id, data=…, errors=…, status="pending")`（`:516-522`）。
6. 汇总（`:524-532`）：`succeeded = generated`；`failed = max(0, count - generated)`；`status = "success" if (failed == 0 and not batch_errors) else "partial"`；有批次错误时 `job.error = "；".join(batch_errors)[:500]`；`finished_at = now_utc()`。
7. `db.flush()`（`:533`）→ **`view = job_view(job, draft_rows)`（`:534`，注释「提交前构建视图，规避 commit 后属性过期再查」）** → `db.commit()`（`:535`）→ `logger.info`（`:536-538`）→ 返回 view（`:539`）。
8. **本函数自行 commit（`:502`、`:510`、`:535` 三处）**；路由不再 commit、也不写审计——`backend/app/api/routes/ai_admin.py:211` docstring：「任务记录本身即操作留痕（含 created_by/params/时间）」。

**查询三函数**

| 函数 | 行号 | 说明 |
|---|---|---|
| `list_jobs(db, page=1, page_size=20)` | `:542-551` | `count()` + `order_by(created_at DESC, id DESC)` + offset/limit（`:547` 用 `max(1, page)` 兜住非法页码）；返回 `(total, [job_view(j)])`，**不含草稿** |
| `get_job(db, job_id)` | `:554-564` | 任务不存在 → `ValueError("任务不存在")`（`:556-557`，路由转 **404**）；草稿按 `id ASC` 全量附在 `drafts`（`:558-563`，**不分页**） |
| `list_drafts(db, job_id=None, status="", page=1, page_size=50)` | `:567-582` | 两个可选过滤（`:571-574`），`order_by(id DESC)`（`:577`）；返回 `(total, [draft_view(d)])` |

**`update_draft(db, draft_id, data, actor)`（`:592-610`）**：`imported` 不可改（`:595-596`，`ValueError("已导入题库的题目不能再修改")`）；`draft.data = dict(data)` **整体替换**（`:597`）；重算 `errors` = 结构校验（`:599-602`）+ **仅库内查重**（`:603-605`，`seen` 传空集，故不检测与同任务其他草稿的重复）；`approved`/`rejected` 改动后回到 `pending`（`:607-608`，docstring `:593`「改动后回到待审核」）；`db.flush()`（`:609`），**由路由 commit**（`backend/app/api/routes/ai_admin.py:287`）。**`actor` 参数在函数体内未被使用**（本文件 `:594-610` 无引用）。

**`set_draft_status(db, draft_id, status, actor)`（`:613-632`）**：`status` 只接受 `approved`/`rejected`/`pending`（`:615-616`）；`imported` 不可改状态（`:618-619`）；置 `approved` 前**重新结构校验**，失败抛 `ValueError(f"题目仍有问题，无法通过：{exc}")`（`:620-625`），通过则回写 `draft.data` 并清空 `errors`（`:626-627`）；写 `reviewed_by=actor`、`reviewed_at=now_utc()`（`:629-630`）；`db.flush()`（`:631`），**由路由 commit**（`backend/app/api/routes/ai_admin.py:308`）。注意**审核环节不做查重**，重复题在导入阶段才被拦（本文件 `:669-672`）。

**`import_drafts(db, draft_ids, actor)`（`:635-699`）**

- 空列表 → `ValueError("没有需要导入的题目")`（`:640-641`）；条数 > `settings.AI_QUESTION_MAX_COUNT` → `ValueError(f"单次最多导入 {…} 道题目")`（`:642-643`）。
- **一次 `IN` 查询**取全部草稿行（`:645`，避免逐条查库）+ `by_id` 映射（`:646`）+ 一次取库内题干集合（`:647`）。
- 逐 ID 判定（`:652-674`）：草稿不存在 → `failures[{id, reason:"草稿不存在"}]`；`status == "imported"` → `skipped += 1`（**幂等**，`:657-659`）；`status != "approved"` → `failures[…"只有审核通过的草稿才能导入"]`；重新 `_validate_question`（`:663-668`）；库内/批内查重（`:669-673`）；全部通过 → `to_import`。
- 写入（`:676-692`）：`base_id = db.query(func.max(Question.id)).scalar() or 0`（`:678`），逐条 `Question(id=base_id+offset, **data)` 并把草稿置 `imported`、回填 `question_id`、`reviewed_by = draft.reviewed_by or actor`、`reviewed_at = now_utc()`（`:680-686`）；**`db.flush()` 而非 commit**（`:687`，注释「不在此提交：由路由连同审计日志一起 commit，保证原子落库」）；异常 → `db.rollback()` + `logger.exception` + `ValueError("导入失败，请稍后重试")`（`:689-692`）。
- 返回 `{imported, skipped, failed, failures}`（`:694-699`），对应 `AdminAiImportOut`（`backend/app/schemas/schemas.py:2007` 起）。路由写审计 `ai.draft.import`（记 imported/skipped/failed 计数）后 commit（`backend/app/api/routes/ai_admin.py:328-334`）。

## 5. 输入与输出

### 5.1 HTTP 端点（9 个触及本模块；管理端契约，字段 **snake_case**，`backend/app/api/routes/ai_admin.py:3` docstring）

（下表行号约定：「路由位置」「调用的函数」「异常映射」三列的行号属该行「路由位置」列写明的路由文件；「请求体」「`response_model`」两列的行号属 `backend/app/schemas/schemas.py`。）

| 方法 | 完整路径 | 路由位置 | 权限依赖 | 请求体（`backend/app/schemas/schemas.py`） | `response_model`（`backend/app/schemas/schemas.py`） | 调用的函数 | 异常映射 |
|---|---|---|---|---|---|---|---|
| POST | `/api/admin/ai/generate-questions` | `backend/app/api/routes/admin.py:568-589` | `require_menu("questions")` | `AdminAiGenerateRequest`（`backend/app/schemas/schemas.py:1233` 起） | `AdminAiGenerateOut`（`:1259` 起） | `generate_questions`（`:576-584`） | `llm_service.LlmError` → **502**（`:585-587`，注释「先于 ValueError 捕获：LlmError 继承 ValueError，但属上游故障应返回 502」）；`ValueError` → **400**（`:588-589`） |
| POST | `/api/admin/ai/questions/batch-save` | `backend/app/api/routes/admin.py:592-606` | `require_menu("questions")` | `AdminAiBatchSaveRequest`（`backend/app/schemas/schemas.py:1270` 起，`questions: List[AdminQuestionUpsert]`） | `AdminAiBatchSaveOut`（`:1283` 起） | `batch_save_questions`（`:602-604`，路由侧 `item.model_dump()` 转 dict） | `ValueError` → **400**（`:605-606`；service 内部已 rollback） |
| POST | `/api/admin/ai/jobs` | `backend/app/api/routes/ai_admin.py:200-225` | `require_menu("ai_workshop")` | `AdminAiJobCreateRequest`（`backend/app/schemas/schemas.py:1936` 起，含 `knowledge_ids`） | `AdminAiJobOut`（`:1962` 起） | `run_job`（`:213-223`） | `AI_ERRORS` → `ai_http_error`（`:224-225`）：403/429/**502**/400 |
| GET | `/api/admin/ai/jobs` | `backend/app/api/routes/ai_admin.py:228-240` | `require_menu("ai_workshop")` | Query `page`(≥1)、`page_size`(1~100) | `AdminAiJobListOut`（`:1978` 起） | `list_jobs`（`:239`） | 无 try（参数由 Query 约束，非法 → 422） |
| GET | `/api/admin/ai/jobs/{job_id}` | `backend/app/api/routes/ai_admin.py:243-253` | `require_menu("ai_workshop")` | 路径参数 | `AdminAiJobOut` | `get_job`（`:251`） | `ValueError` → **404**（`:252-253`） |
| GET | `/api/admin/ai/drafts` | `backend/app/api/routes/ai_admin.py:256-270` | `require_menu("ai_workshop")` | Query `job_id`、`status`、`page`、`page_size`(1~200，默认 50) | `AdminAiDraftListOut`（`:1983` 起） | `list_drafts`（`:269`） | 无 try |
| PUT | `/api/admin/ai/drafts/{draft_id}` | `backend/app/api/routes/ai_admin.py:273-291` | `require_menu("ai_workshop")` | `AdminAiDraftUpdateRequest`（`:1988` 起，`data: Dict`） | `AdminAiDraftOut`（`:1948` 起） | `update_draft`（`:286`）+ `db.commit()`（`:287`） | `ValueError` → **400** + rollback（`:288-290`） |
| PATCH | `/api/admin/ai/drafts/{draft_id}/status` | `backend/app/api/routes/ai_admin.py:294-312` | `require_menu("ai_workshop")` | `AdminAiDraftStatusRequest`（`:1994` 起，`status: str`） | `AdminAiDraftOut` | `set_draft_status`（`:307`）+ `db.commit()`（`:308`） | `ValueError` → **400** + rollback（`:309-311`） |
| POST | `/api/admin/ai/drafts/import` | `backend/app/api/routes/ai_admin.py:315-338` | `require_menu("ai_workshop")` | `AdminAiImportRequest`（`:1998` 起，`draft_ids: List[int]`，`min_length=1`） | `AdminAiImportOut`（`:2007` 起） | `import_drafts`（`:327`）+ 审计 + `db.commit()`（`:328-334`） | `ValueError` → **400** + rollback（`:335-337`） |

两个路由前缀：`backend/app/api/routes/admin.py:116` 为 `/admin`，`backend/app/api/routes/ai_admin.py:43` 为 `/admin/ai`，均经 `backend/app/main.py` 以 `settings.API_PREFIX`（`/api`）挂载。`require_menu` 语义见 `backend/app/api/deps.py:150-160`（无该菜单码 → 403）。`ai_admin.py` 的异常映射直接复用小程序 AI 路由的 `ai_http_error` / `AI_ERRORS`（`backend/app/api/routes/ai_admin.py:15` import，定义在 `backend/app/api/routes/ai.py:42`（`AI_ERRORS` 元组，`:45` 含 `llm_service.LlmError`）与 `:50`（`ai_http_error`，`:56` 把 `LlmError` 映射 **502**））；旧链路两个端点则在 `admin.py` 内自行 `try/except`，**两处口径相同但代码不共享**。

**审计差异（事实）**：`POST /drafts/import` 写审计（`backend/app/api/routes/ai_admin.py:328-333`）；旧链路两个端点（`backend/app/api/routes/admin.py:574-589`、`:598-606`）、`POST /jobs`、`PUT /drafts/{id}`、`PATCH /drafts/{id}/status` **均不写 `audit_logs`**。

### 5.2 单条题目草稿的数据结构

`_normalize_item`（`:175-183`）与 `_blank_question`（`:155-165`）产出同构 dict，与 `AdminQuestionUpsert`（`backend/app/schemas/schemas.py:1151` 起）及 `questions` 表列（`backend/app/models/models.py:153-161`）一一对应：

| 字段 | 类型 | 取值 | 来源 |
|---|---|---|---|
| `type` | str | 恒 `"single"` | `:176`（硬编码，不取模型输出） |
| `question` | str | 题干，strip | `:177` |
| `options` | list | `[{"label": "A", "text": "…"}, …]` | `:178` → `_normalize_options` |
| `answer` | list | 大写 label 数组，单选须恰好 1 个 | `:179` → `_normalize_answer` |
| `analysis` | str | 解析，strip | `:180` |
| `score` | int | 恒 `DEFAULT_SCORE`(20) | `:181` |
| `category` | str | 请求参数传入的分类（可为空串） | `:182` |

`admin_service._validate_question`（`backend/app/services/admin_service.py:208-233`）的 8 条规则中，`type`（`:210`）与 `score`（`:232`）对 AI 生成项恒成立，实际起作用的是：题干非空、category 合法、选项 ≥2、label 不重复、answer 非空且都在 label 中、单选 answer 恰好 1 个。**该函数会就地改写传入 dict 的 `category`**（`backend/app/services/admin_service.py:217`），因此本文件各处调用前都先 `dict(...)` 拷贝（`:367`、`:600`、`:621`、`:663`）。

### 5.3 返回结构汇总

| 函数 | 返回 |
|---|---|
| `generate_questions` | `{requested, generated, valid_count, invalid_count, items[{index,data,errors}], batch_errors[str]}`（`:339-346`） |
| `batch_save_questions` | `{saved, failed, failures[{index,reason}]}`（`:392`，index 1 基） |
| `run_job` / `get_job` | `job_view`：`{id, job_type, topic, params, requested, succeeded, failed, status, error, created_by, created_at, finished_at, drafts[…]}`（`:423-439`） |
| `list_jobs` / `list_drafts` / `get_job` 的分页版 | `(total, [view…])` 元组（`:551`、`:582`） |
| `update_draft` / `set_draft_status` | `draft_view`：`{id, job_id, data, errors, status, question_id, reviewed_by, reviewed_at, created_at}`（`:443-453`） |
| `import_drafts` | `{imported, skipped, failed, failures[{id,reason}]}`（`:694-699`，`failures` 用 `id` 而非 `index`） |

## 6. 依赖关系

### 6.1 依赖

- 标准库：`json`、`logging`、`concurrent.futures.ThreadPoolExecutor / as_completed`、`typing`（`:11-14`）。
- 第三方：`sqlalchemy.func`、`sqlalchemy.orm.Session`（`:16-17`）。
- 项目内：
  - `app.core.config.settings`（`:19`）——只读 3 个 `AI_QUESTION_*`（`:227`、`:303`、`:323`、`:358`、`:494`、`:642-643`）。**不读任何 `LLM_*` / `CLOUDBASE_*` 项**，供应商选择完全由门面内部决定。
  - `app.core.helpers.now_utc`（`:20`）——`finished_at` / `reviewed_at`（`:501`、`:509`、`:532`、`:630`、`:686`）。
  - `app.models.models`（`:21`）：`AiGeneratedQuestion`、`AiGenerationJob`、`AiKnowledge`、`Question`。
  - `app.services.admin_service`（`:22`）：**跨模块调用私有函数 `_validate_question`**（`:270`、`:369`、`:600`、`:623`、`:665`）。
  - `app.services.ai_knowledge_service`（`:22`）：`format_context`（`:419`）。
  - `app.services.llm_service`（`:22`）：`prompt`（调用点 `:208-210`）。**只依赖门面**，不 import `llm_base` / `llm_openai` / `llm_cloudbase`，也不 import `LlmError`——异常类型靠路由层 `except llm_service.LlmError` 识别（`backend/app/api/routes/admin.py:585`）。
- 数据库表：`questions`（读 `:188`、读 max(id) `:382`/`:678`、写 `:385`/`:682`）、`ai_generation_jobs`（写 `:475-491`、读 `:543`/`:555`）、`ai_generated_questions`（写 `:518-522`、读 `:559`/`:570`/`:586`/`:645`、改 `:597-608`/`:626-630`/`:683-686`）、`ai_knowledge`（只读 `published`，`:412-416`）。
- **不依赖** `ai_config_service` / `ai_usage_service`（import 清单 `:19-22` 无二者）：出题链路**不校验 AI 总开关、不受日限额约束、不写 `ai_usage_logs`**（见 §9 第 9 条）。

### 6.2 被谁依赖

（下表「位置」列的行号均属同行「依赖方」列的文件。）

| 依赖方 | 位置 | 用到的函数 |
|---|---|---|
| `backend/app/api/routes/admin.py` | `:101`（import）、`:576`、`:602` | `generate_questions`、`batch_save_questions` |
| `backend/app/api/routes/ai_admin.py` | `:39`（import）、`:213`、`:239`、`:251`、`:269`、`:286`、`:307`、`:327` | `run_job`、`list_jobs`、`get_job`、`list_drafts`、`update_draft`、`set_draft_status`、`import_drafts` |
| `admin/src/api/admin.ts` | `:697-703`（`generateAiQuestions`，`timeout: 0` + `signal` + `silent`，`:699` 即 `timeout: 0`）、`:705-711`（`batchSaveAiQuestions`） | 仅旧链路两个端点 |
| `admin/src/components/AiGenerateDialog.vue` | 经上述两个 api 函数 | 旧链路的表单/预览/编辑/批量保存 UI |
| 测试 | `backend/test/s25_ai_question_generate.py`（A 组出题用例）、`backend/test/s26_ai_center.py`（W 组工坊 + G 组旧链路回归与安全）、`backend/test/s30_llm_provider_switch.py`（`b712d81` 新增：门面分派 / 两协议桩 / 真实调用，经 HTTP 与桩间接覆盖本链路） | 均经 HTTP 调用，**无脚本直接 import 本模块** |

**工坊 7 个端点当前无管理端调用方**：`admin/src` 全目录只出现 `/admin/ai/generate-questions` 与 `/admin/ai/questions/batch-save` 两个路径（grep `admin/src` 命中仅 `admin/src/api/admin.ts:698`、`:707`），与「题目工坊管理页待开发」一致。

## 7. 业务规则

1. **题型固定单选**：`:28`、`:293-294`；`:26-27` 注释说明理由——小程序答题接口强制提交单个答案（`quiz_service` 校验），多选题需同步改判分与小程序交互，属破坏性变更。
2. **难度不入库**：`:5`、`:29`、`:295-296`；难度只影响 `_DIFFICULTY_TEXT` 的提示词文案（`:76`）。`mixed` 表示难易混合（`:42`）。
3. **分值恒 20**：`:34`、`:163`、`:181`；AI 不能自行决定分值。
4. **生成即草稿、人工确认才入库**：`:6`、`:318`、`:349-355`、`:636`。工坊链路多一层审核态（`approved`）才允许导入（`:660-662`）。
5. **选项数不强制 4 个**：提示词要求固定 4 个（`:87-89`），`DEFAULT_OPTION_COUNT` 只用于提示词与空白占位（`:36`、`:159`）；`_normalize_item` 不裁剪也不补齐条数，校验只要求 ≥2 且 label 唯一（`backend/app/services/admin_service.py:219-223`）。模型返回 3 或 5 个选项时草稿照样通过。
6. **不信任前端**：保存（`:352`）与导入（`:636`）都重新做完整校验 + 库内/批内查重，不复用生成阶段的结论。
7. **查重口径**：库内取 `active=True` 的题干（`:188`），**精确字符串匹配 strip 后的题干**（`:194-200`），无模糊/相似度比对；软停用题目（`admin_service.delete_question` 只置 `active=False`，`backend/app/services/admin_service.py:196-205`）不参与查重，因此可导入与已停用题目同题干的题。`questions` 表对题干**无唯一约束**（`docker/init/001_schema.sql:16-24`），查重完全是应用层行为。
8. **部分失败可统计、不阻断**：批级（`:240-241`、`:246-252`）、条目级（`:370-376`、`:654-672`）都是「记失败、继续处理其余」。
9. **草稿状态流转**：`pending` →（审核）`approved`/`rejected` →（导入）`imported`；`imported` 为终态，不可编辑（`:595-596`）也不可改状态（`:618-619`）；编辑 `approved`/`rejected` 的草稿会退回 `pending`（`:607-608`）。
10. **导入幂等**：已 `imported` 的草稿重复导入 → 计入 `skipped`、不再写库（`:657-659`）；冒烟 W07 实测「重复导入已导入草稿被 skipped，题库不再新增」（`backend/test/s26_ai_center.py:611-617`）。
11. **任务状态判定**：`success`（无失败且无批次错误）/ `partial`（其余有产出的情况）/ `failed`（无产出或上游异常）（`:498-513`、`:527-529`）；`error` 字段一律截断 500 字（`:500`、`:508`、`:531`）。
12. **知识接地只走工坊链路**：`run_job` 支持 `knowledge_ids`（`:465`、`:474`），`generate_questions` 不传 `references`（`:324-326`）；只有 `published` 资料会进提示词（`:414`），未发布/草稿资料绝不外泄。
13. **日志最小化**：4 处 `logger.info` 只记长度与计数（`:335-338`、`:391`、`:536-538`、`:693`），不记主题原文、题目正文或密钥；2 处 `logger.exception` 只在 DB 写入失败时打栈（`:389`、`:691`）。
14. **提示词与上游供应商解耦**：`_build_prompt` 全文不含任何厂商名、模型名或协议细节，11 条输出要求（`:83-99`）对 `openai` 与 `cloudbase` 两套适配器同样下发；切换 `LLM_PROVIDER` 不需要改本文件。其中第 11 条（禁止字符串内部出现英文双引号与反斜杠，`:99`）是为压 JSON 解析失败率而加的**通用**约束，源码 `:96-98` 的注释记录了它在 CloudBase Agent 上的实测来历（10 批挂 2 批），但规则本身与厂商无关。

## 8. 修改约束

- **不得在 `_generate_batch` / 线程池任务内使用 `db`**：SQLAlchemy Session 非线程安全，当前 `_generate_batch`（`:204-211`）只做 HTTP 是并发安全的前提；数据库读写全部留在主线程（`:258`、`:362`、`:645-647`）。
- **只能经 `llm_service` 门面调用上游**：本文件不得 import `llm_base` / `llm_openai` / `llm_cloudbase`，也不得直接读 `settings.LLM_*` / `settings.CLOUDBASE_*`；供应商分派、超时、重试、`LLM_QUESTION_EXTRA_BODY` 全部在门面与适配器内完成（`backend/app/services/llm_service.py:102-113`）。绕过门面会让「改一行 `LLM_PROVIDER` 即切换上游」的约定失效。
- **`questions.id` 取号方式必须与全仓一致**：`max(id)+1`（`:382`、`:678`）与 `backend/app/services/admin_service.py:175-176`（新增题目）、`backend/app/services/import_service.py:293-295`（Excel 导入确认）同源（`:381` 注释明示）。改为数据库自增或序列属跨 3 处 + 迁移的变更，须整体评估。
- **校验必须继续复用 `admin_service._validate_question`**（`:7-8`），不得在本文件另写一套，否则 AI 出题与 Excel 导入的校验强度会分叉；同时注意它会就地改写 `category`（`backend/app/services/admin_service.py:217`），传参前必须 `dict(...)` 拷贝（本文件 4 处已如此）。
- **事务边界不得挪动**：`import_drafts` 必须保持 flush-only（`backend/app/services/ai_question_service.py:687` 注释），否则题目写入与审计日志（`backend/app/api/routes/ai_admin.py:328-334`）不再原子；`update_draft`/`set_draft_status` 同理（`backend/app/services/ai_question_service.py:609`、`:631`）。反之，`batch_save_questions`（`:386`）与 `run_job`（`:502`、`:510`、`:535`）是**service 自行 commit**，路由不再 commit——改动时不要把两种口径混用。
- **`run_job` 必须在 commit 前构建视图**（`:534` 注释）：commit 后 ORM 属性过期，再访问会触发额外查询甚至在已关闭会话上报错。
- **旧链路契约冻结**：`:398` 注释「现有 admin 前端的旧链路（generate-questions/batch-save）保持不变」；`AdminAiGenerateOut` / `AdminAiBatchSaveOut` 字段与 `failures[].index` 的 1 基口径（`:275`、`:366`）已被 `admin/src/components/AiGenerateDialog.vue` 消费，改动即破坏管理端。
- **提示词的输出约束与解析函数必须同步改**：`:83-90` 的第 1~5 条对应 `_extract_json_array`（`:107-122`）/`_normalize_item`（`:168-183`）/`_normalize_options`（`:125-141`）/`_normalize_answer`（`:144-150`）；只改一侧会导致解析全批失败。**追加/删除输出要求时须连带重排末尾序号**：`b712d81` 插入第 11 条后，`extra` 那条已由「11.」改为「12.」（`:103`），漏改会让模型收到两个同号要求。
- **开放多选题属破坏性变更**（`:26-27`）：须同步 `SUPPORTED_TYPES`（`:28`）、判分逻辑（`backend/app/services/quiz_service.py`）与小程序答题交互，禁止只改本文件。
- **难度若要入库**须新增编号迁移加列并同步 ORM（`backend/app/models/models.py:145-161`），遵守 `docker/init/SQL_CONSTRAINTS.md`，禁止改已执行过的 `docker/init/001_schema.sql`。
- **密钥不得出现在提示词、日志、异常消息或响应中**（`backend/app/core/config.py:69` 注释「API Key 仅供后端调用，禁止写入前端代码、接口响应或日志」；门面安全约定 `backend/app/services/llm_service.py:21`；密钥唯一组装点是两个适配器的 `_auth_headers()`，docstring 均明写「API Key 只在此处出现，不写日志、不进异常消息」——`backend/app/services/llm_openai.py:159-165`、`backend/app/services/llm_cloudbase.py:163-170`；`.qoder/README.md` §3.14）；冒烟 A13（`backend/test/s25_ai_question_generate.py:380-388`）与 G02（`backend/test/s26_ai_center.py:656`）专门断言响应不泄露 API Key——**被断言的键名随 `LLM_PROVIDER` 变化**（`settings.CLOUDBASE_API_KEY` 或 `settings.LLM_API_KEY`，见 `backend/test/s26_ai_center.py:77-79`），不要把断言写死成单一供应商的键名。
- 新增写库路径应保留 `try/except → rollback + logger.exception + ValueError(中文)` 的兜底形态（`:387-390`、`:689-692`），以便路由层统一转 400。
- **异常类型只认 `llm_service.LlmError`**：路由层 502/400 的分流依赖它（`backend/app/api/routes/admin.py:585-589`），且 `first_error` 必须原样透传以保留类型（`:327-330`）；在本文件内 catch 后改抛 `ValueError` 会把上游故障降级成 400。

## 9. 当前实现状态

### 已实现

- 旧链路：分批并发生成、JSON 容错解析、逐题规整/校验/查重、草稿预览、批量保存（`:51-392`）。
- 工坊链路：任务与草稿持久化、任务/草稿分页列表与详情、草稿编辑与审核、幂等导入题库（`:395-699`）。
- 知识接地出题（`knowledge_ids` → 已发布资料进提示词，`:402-419`、`:474`）。
- 批级容错与部分成功语义（`partial` 状态、`batch_errors`、`failures` 明细）。
- 上游供应商无关：经 `llm_service` 门面调用，`LLM_PROVIDER` 取 `openai` 或 `cloudbase` 均可出题（`c660727` 完成解耦，`b712d81` 补回 CloudBase ACP 适配器并新增提示词第 11 条压 JSON 解析失败率）。
- 冒烟已验证：`backend/test/s25_ai_question_generate.py`（A09「批量保存重新校验：合法项入库且 id 自 max+1 连续」、A10 库内/批内重复拦截、A14/A15 真实上游生成 10 题与 50 题分批）；`backend/test/s26_ai_center.py` W 组（任务/草稿落库、列表回溯、编辑重算 errors、审核、导入、幂等、鉴权 403、知识接地、失败落 failed + 502）与 G 组（旧链路回归 + 不泄露密钥）；`b712d81` 另记 `s25 16/16`、`s26 47/47`、`s30 23/23`、`s28 13/13`，合计 99/99（结果 JSON `backend/test/s30-llm-provider-switch-results.json`）。**用例定位行号本次未逐一复核——待确认。**

### 存在问题 / 限制

1. **`questions.id` 用 `max(id)+1` 取号，无并发保护**（`:382`、`:678`）：无 `with_for_update()`、无唯一冲突重试、无数据库序列。两个管理员同时批量保存/导入会算出同一 `base_id` → 主键冲突 → 被 `:387-390` / `:689-692` 的宽 `except Exception` 兜住 → `rollback` + `ValueError`「保存失败/导入失败，请稍后重试」→ 400，**不产生半批脏数据，但需人工重试**。该结论与 `.qoder/ARCHITECTURE.md` §16.1「非自增主键的 id 分配：一律 `max(id)+1`，无并发保护（并发新增可撞主键）」一致。同一模式亦见 `backend/app/services/admin_service.py:175-176`、`backend/app/services/import_service.py:293-295`。**并发冲突路径未实测**（冒烟为单线程串行）。
2. **`import_drafts` 无草稿级并发保护**：`:645` 的 `IN` 查询不加行锁，`status='approved'` 的判定与 `status='imported'` 的回写之间没有原子性保证；`questions.question` 无唯一约束（`docker/init/001_schema.sql:16-24`），故两个管理员并发导入同一草稿理论上可产生重复题干并互相覆盖 `question_id`（本文件 `:683-684`）。属代码层面推断，**未实测**，管理端单人操作场景下概率极低。
3. **`update_draft` 的 `actor` 参数未被使用**（`:592` 声明，`:594-610` 函数体无引用）：草稿编辑不记录操作人；对应路由 `PUT /api/admin/ai/drafts/{draft_id}` 也不写审计（`backend/app/api/routes/ai_admin.py:285-291`），`PATCH .../status` 同样不写审计（`:306-312`），审核环节仅靠 `reviewed_by`/`reviewed_at`（本文件 `:629-630`）留痕。对比 `import_drafts` 有 `ai.draft.import` 审计——留痕强度不一致，现状记录。
4. **`update_draft` 的查重只比库内、不比同任务其他草稿**（`:603-605` 传空 `seen`）：把同一任务内两条草稿改成相同题干不会被标记重复，要到导入阶段才被拦（`:669-672`）。
5. **错误码不一致**：「任务不存在」→ **404**（`backend/app/api/routes/ai_admin.py:252-253`），「草稿不存在」→ **400**（`:288-290`、`:309-311` 把 `ValueError` 一律转 400）。
6. **草稿排序方向相反**：`list_drafts` 按 `id DESC`（`:577`），`get_job` 附带的草稿按 `id ASC`（`:561`）——同一批草稿在列表页与任务详情里顺序相反。
7. **`DRAFT_STATUSES`（`:399`）是死常量**：全仓无引用（grep 仅命中定义行）。同时 `AiGenerationJob.status` 的 `pending`/`running` 两值（`backend/app/models/models.py:636`）在当前**同步**实现下不会落库：`run_job` 只在 `:502`/`:510`/`:535` 三处 commit，此时 status 已是 `failed`/`success`/`partial`；`:487` 的 `"running"` 仅存在于未提交事务内。无异步任务队列，故 `GET /api/admin/ai/jobs` 永远看不到 `running` 行。
8. **`run_job` 的异常兜底只覆盖生成阶段**（`:493-503`）：`_build_drafts` 与草稿写入（`:515-522`）不在 `try` 内；若此处抛异常（如 DB 故障），事务随会话关闭被回滚（`get_db` 只 `close()`，`backend/app/core/database.py:58-64`），库里不会留下 `running` 僵尸行，但非 `ValueError`/`LlmError` 的异常会冒泡成 500。
9. **AI 出题不受 AI 总开关与日限额约束、不写用量日志**：本文件不 import `ai_config_service`/`ai_usage_service`（`:19-22`），`generate_questions`/`run_job` 均无 `ensure_enabled`/`check_limits` 调用（对照 `backend/app/services/ai_chat_service.py:218`、`:224`、`:507`、`:508`）。因此管理端把 `ai_enabled` 关掉后，出题接口仍会真实调用上游并产生费用；出题次数也不计入 `ai_usage_logs`（`backend/app/models/models.py:686` 注释里的 `question_gen` 取值全仓无写入点）。这与 `backend/app/core/config.py:103` 注释「AI 总开关；关闭后所有 AI 接口返回明确提示」不一致（`backend/app/services/ai_config_service.py:22-25` 的 docstring 口径更窄、与代码一致）。是有意设计还是遗漏——**待确认**。
10. **出题链路的超时/重试用 env 值，配置中心改不动**：`_generate_batch` 调 `llm_service.prompt`（`:208-210`）→ 门面内固定 `prompt_meta(text, timeout=None, extra_body=settings.LLM_QUESTION_EXTRA_BODY)`（`backend/app/services/llm_service.py:111-113`）→ 适配器内 `effective_timeout = timeout or settings.LLM_TIMEOUT_SECONDS`（`llm_openai.py:226` / `llm_cloudbase.py:234`，代码默认 **300 秒**，`backend/app/core/config.py:73`）、`attempts = 1 + settings.AI_MAX_RETRIES`（`llm_openai.py:227` / `llm_cloudbase.py:235`，默认 1 → 共 2 次）。管理端改 `ai_request_timeout`/`ai_max_retries` 对出题**完全无效**：出题走的是 `prompt`（不传 timeout/max_retries），且这两项与 `AI_QUESTION_*` 三项都不在 `backend/app/services/ai_config_service.py:45-55` 的 `_SPEC` 白名单内。单批最坏耗时 ≈ `(1 + AI_MAX_RETRIES) × LLM_TIMEOUT_SECONDS`，再叠加批数（⌈count / batch_size⌉，当前 `.env` 的 batch_size 为 5）与并发上限 3。`c660727` 已删除原 `CLOUDBASE_TIMEOUT_SECONDS`（180 秒），超时改为两套供应商共用 `LLM_TIMEOUT_SECONDS`。另注意 `prompt()` 强制叠加的 `LLM_QUESTION_EXTRA_BODY`（叠加理由：出题要严格 JSON、实测关思考模式后批次解析失败率上升，`config.py:83-85` 注释）只在 OpenAI 兼容适配器下生效（合并顺序 `LLM_EXTRA_BODY` < 该项，`llm_openai.py:150`、`:223`）；cloudbase 适配器**忽略 `extra_body` 与 `max_tokens`**（ACP 无对应参数，`llm_cloudbase.py:230`、`config.py:88` 注释），故 `LLM_PROVIDER=cloudbase` 时该覆盖项与 `AI_MAX_OUTPUT_TOKENS` 硬截断均静默失效。admin 前端因此设 `timeout: 0`（`admin/src/api/admin.ts:695-703`，注释原文「耗时可达分钟级：不设前端超时（timeout: 0），由用户通过 signal 主动取消」，`:699` 即 `timeout: 0`）。
11. **客户端中断不终止服务端生成**：本文件无任何取消检查点，线程池（`:229-241`）会跑完全部批次；前端 `AbortController` 只断开 HTTP 连接，上游调用与费用照常发生。
12. **查重集合每次全表加载**：`_existing_question_texts`（`:186-189`）把全部启用题干读进内存建集合，`generate_questions`（`:258`）、`batch_save_questions`（`:362`）、`import_drafts`（`:647`）各调一次，`update_draft` 每次编辑也调一次（`:604`）。当前题库量级（开发库数十题）无压力；题干为 `TEXT` 列，题量增长后属线性内存/IO 开销（对照根 `agents.md` §2.4「避免全量拉取」）。**未做批量/分页优化**。
13. `run_job` 的 `params.knowledge_ids` 过滤用 `str(k).strip().isdigit()`（`:484`），而 `_references_from_knowledge` 用 `int()` + try/except（`:405-409`），两者对负数 ID 口径不同；因 schema 已声明 `List[int]`（`backend/app/schemas/schemas.py:1936` 起的 `AdminAiJobCreateRequest`）且负数 ID 匹配不到任何行，实际无影响。
14. `docs/迭代记录.md` 提交 `ea58b6c` 条目把保存接口写作 `POST /api/admin/questions/batch-ai`，与代码实际路径 `POST /api/admin/ai/questions/batch-save`（`backend/app/api/routes/admin.py:592-593`）不符；**以代码为准**（`.qoder/README.md` 卷首约定）。
15. **提示词第 11 条只降低概率、不消除失败**：源码 `:96-98` 注明「未做 JSON 修复引擎」。模型仍可能在题干里写未转义引号导致整批 `_extract_json_array` 抛 `ValueError`，此时该批计入 `batch_errors`、任务落 `partial`；已生成的其他批不受影响，但用户会看到「第 N 批生成失败：AI 返回的 JSON 无法解析，请重试」。属已知取舍，非缺陷。

### 待开发

- 独立的「题目工坊」管理页（`.qoder/ARCHITECTURE.md` §11.3、`.qoder/REQUIREMENTS.md` §10.6）：工坊 7 个端点已就绪但无前端调用方（§6.2）；`ai_workshop` 菜单码只落库（`docker/init/022_ai_admin_menus.sql`），`admin/src/router/menus.ts` 未登记。
- 出题用量/成本纳入 `ai_usage_logs` 与统计页（§9 第 9 条）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/services/ai_question_service.py`（**4 个提交**）与 `docs/迭代记录.md` 对应条目，按时间倒序。历史条目中的 `路径:行号` 均为建档当时的快照，随其它文件演进可能已失效，以 §1~§9 正文复核后的行号为准。

### 2026-10-22（`b712d81`）

- 需求：AI 上游改为**可切换供应商**——`c660727` 把上游单向替换成阿里云百炼并删掉了 ACP 实现，此后又在 OpenAI 兼容层上建成 SSE 流式对话，「换回原来那把 key」已不是改配置能做到的事。本次改为门面 + 适配器：`llm_service` 按 `LLM_PROVIDER` 分派到 `llm_openai` 或 `llm_cloudbase`，两套凭证常驻 env，上线只改 `LLM_PROVIDER=openai` 一行即可切回百炼。真实调用实测发现出题 10 批挂 2 批，根因是模型在题干里写未转义英文双引号破坏 JSON。
- 修改内容：本文件 +5/-1 行（695 → 699 行）。`_build_prompt` 在 10 条输出要求后**新增第 11 条**「所有字符串内部不得出现英文双引号 `"` 和反斜杠；需要引用原文或强调时改用中文引号“”」（`:99`，含 `:96-98` 三行实测来历注释），并把 `extra` 那条的序号由「11.」改为「12.」（`:103`）。**未做 JSON 修复引擎**——选择在提示词层禁止，因为该约束对任何供应商都适用。`_generate_batch` 的调用点（`llm_service.prompt`）与 import 行本次未动，门面/适配器切换对本文件透明。
- 关联文件：`backend/app/services/llm_service.py`（门面，`prompt` 内固定叠加 `LLM_QUESTION_EXTRA_BODY`，`:102-113`）、`backend/app/services/llm_openai.py`、`backend/app/services/llm_cloudbase.py`（从 git 历史恢复并补流式增量）、`backend/app/services/llm_base.py`（共享 `LlmError`/`CallResult`，下沉以打破循环导入）、`backend/app/core/config.py`（`LLM_PROVIDER` `:72`）、`backend/test/s30_llm_provider_switch.py`（新增）、`backend/app/services/ai_chat_service.py`、`backend/app/api/routes/ai.py`、`backend/app/models/models.py`（`ai_usage_logs.model` 改取 `model_label()`）。
- 测试结果：据 `docs/迭代记录.md` 该提交条目——新增 `s30`（分派/两协议桩/真实调用）**23/23**，回归 `s25` **16/16**、`s26` **47/47**、`s28` **13/13**，合计 **99/99**；`py_compile` 全通过，openapi 127 条路径、接口面无增删。同条目记载的真实调用实测四项处置：① 仓库内百炼 Key 已 401 失效，上线前必须重置（阻塞项）；② CloudBase 首片延迟 8.6~16.7s（百炼 1~3s），源于 ACP 思考不可关；③ CloudBase 的 `usage_update.used` 量级不稳（254 vs 1.9 万），不可作单次计费依据；④ 出题 10 批挂 2 批 → 加提示词规则后**复跑 50/50 全通过**。**本次文档改动未执行任何测试**（按任务约束）。
- 补充核实：① `AI_QUESTION_BATCH_SIZE` 运行期取值已核实为 **5**——`backend/.env:65` 与 `backend/.env.prod:79` 均设 5（两份 env 均入库），代码默认值 10（`config.py:96`）仅在 env 缺该项时生效，`b712d81` 明确保持 5 不随供应商调整；② `admin/src/api/admin.ts` 的 `generateAiQuestions` 行号已复核为 `:697-703`（`:699` 即 `timeout: 0`）、`batchSaveAiQuestions` 为 `:705-711`；③ 与本文件直接相关的部分用例行号已复核（s25 A13 `:380-388`、s26 W07 `:611-617`、G02 `:656`），其余未逐一复核。

### 2026-10-19（`c660727`）

- 需求：AI 大模型供应商由腾讯云 CloudBase Agent（ACP 私有协议）迁移到阿里云百炼（OpenAI Chat Completions 兼容协议）。原实现绑定 ACP（JSON-RPC + SSE 流解析），换供应商需重写；本次统一走 OpenAI 兼容协议，业务代码与厂商解耦。
- 修改内容：本文件 +11/-11 行（行数不变，仍 695 行），**纯改名与措辞中性化**：① import 由 `cloudbase_service` 改为 `llm_service`（`:22`）；② `_generate_batch` 的调用由 `cloudbase_service.prompt(...)` 改为 `llm_service.prompt(...)`（`:208-210`）；③ 模块 docstring 首行「调用 CloudBase Agent 生成题目草稿」→「调用大模型生成题目草稿」（`:1`）、设计约束第 5 条「并发调用 Agent」→「并发调用模型」（`:9`）；④ `_build_prompt`/`_extract_json_array`/`_normalize_options`/`_normalize_answer`/`_normalize_item` 五处 docstring 的「Agent」→「模型」（`:63`、`:108`、`:126`、`:145`、`:169`）；⑤ `generate_questions` 全部批次失败处的注释「保留 CloudBaseError 类型以便路由映射为 502」→「保留 LlmError 类型…」（`:328`）。**业务逻辑、提示词正文、事务边界、返回结构均未变**。
- 关联文件：`backend/app/services/cloudbase_service.py` → `backend/app/services/llm_service.py`（更名 + 删除 SSE 解析改非流式）、`backend/app/core/config.py`（`CLOUDBASE_ENV_ID`/`AGENT_ID`/`API_KEY` 三项收敛为 `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY`，新增 `LLM_EXTRA_BODY`/`LLM_QUESTION_EXTRA_BODY`，删除 `CLOUDBASE_TIMEOUT_SECONDS` 改用 `LLM_TIMEOUT_SECONDS`）、`backend/app/api/routes/admin.py`（`except llm_service.LlmError` → 502，`:585-587`）、`backend/app/services/ai_chat_service.py`、`backend/app/services/ai_config_service.py`、`backend/app/api/routes/ai.py`、`backend/test/s25_ai_question_generate.py`、`backend/test/s26_ai_center.py`。
- 测试结果：据 `docs/迭代记录.md` 该提交条目——`s25` AI 出题 **16/16**、`s26` AI 中心 **47/47** 全通过，含真实调用生成 10 题与 50 题；报告 `backend/test/docs/s27-llm-provider-migration-report.md`。同条目记载实测发现并处置的三处推理模型特性：思考 token 不受 `max_tokens` 约束且同样计费、关闭思考后出题 JSON 解析失败率上升（5 批挂 1 批）、单批 10 题开思考超 300s 读超时——故新增 `LLM_EXTRA_BODY` 透传供应商专有参数：对话/讲解/解析关思考压时延与成本，**出题链路由 `LLM_QUESTION_EXTRA_BODY` 单独恢复思考**，`AI_QUESTION_BATCH_SIZE` 降至 5。**本次文档改动未执行任何测试**（按任务约束）。
- 文档侧核实：`AI_QUESTION_BATCH_SIZE` 降至 5 是 **env 覆盖**，代码默认值未改过——`backend/app/core/config.py:96` 的代码默认至今仍为 10，运行期取值来自 `backend/.env:65` 与 `backend/.env.prod:79`（两份 env 均入库，均为 `AI_QUESTION_BATCH_SIZE=5`）。

### 2026-10-17（`1600074`）

- 需求：《长征步迹 AI 智能中心开发需求 V1.0》§3.4 题目工坊——生成结果需可回溯、可逐条审核、可幂等导入，而非只在弹窗内存态存在。
- 修改内容：本文件 +357/-17 行（355 → 695 行；`git show --numstat 1600074`）。新增「持久化题目工坊」整段（`:391-695`）：`DRAFT_STATUSES`、`_references_from_knowledge`（知识接地出题）、`job_view`/`draft_view`、`run_job`（任务 + 草稿落库、失败也落 `failed` 可回溯）、`list_jobs`/`get_job`/`list_drafts`、`update_draft`（编辑重算 errors、回到 pending）、`set_draft_status`（approved 前重新校验）、`import_drafts`（幂等导入 + flush-only 交路由与审计同事务提交）。为支持参考资料出题，`_build_prompt`/`_generate_batch`/`_run_batches` 增加 `references` 参数（`:60-61`、`:200-201`、`:210-217`），import 增加 `now_utc`、`AiGeneratedQuestion`/`AiGenerationJob`/`AiKnowledge` 与 `ai_knowledge_service`（`:20-22`）。旧链路 `generate_questions`/`batch_save_questions` **行为保持不变**，仅 docstring 补注「内存态，供旧预览链路」（`:314`）。
- 关联文件：`backend/app/api/routes/ai_admin.py`（工坊 7 个端点）、`backend/app/schemas/schemas.py`（`AdminAiJob*`/`AdminAiDraft*`/`AdminAiImport*`）、`backend/app/models/models.py:610-657`、`backend/app/services/ai_knowledge_service.py`、`docker/init/021_ai_center.sql`、`docker/init/022_ai_admin_menus.sql`（后两者按根 `agents.md` §1.3 未随提交入库）。
- 测试结果：据 `docs/迭代记录.md` 该提交条目——冒烟 `backend/test/s26_ai_center.py` **47/47**（含真实 Agent 调用 L01：reply 143 字、usedTokens=19715；空来源场景模型拒答不编造）；真库校验迁移应用 / 表索引菜单齐备 / ORM 与真库列 ALL_MATCH / JSON round-trip 后回滚、真库真实 Agent 对话一次（reply 194 字、usedTokens=431）；报告 `backend/test/docs/s26-ai-center-report.md`。与本文件直接相关的用例：W01 任务与草稿持久化落库（`backend/test/s26_ai_center.py:542-554`）、W02 列表与详情可回溯（`:556-563`）、W03 按任务查草稿（`:565-569`）、W04 编辑草稿重算 errors（`:571-579`）、W05 审核通过/驳回（`:581-592`）、W06 仅通过项入库 + 置 imported + 回填 question_id + 驳回项计入 failed（`:594-604`）、W07 导入幂等 skipped（`:606-612`）、W09 无 `ai_workshop` 菜单 403（`:614-618`）、W10 知识接地资料进提示词（`:620-631`）、W11 生成失败 → 502 且任务以 failed 落库（`:633-640`）、G01 旧链路不受影响（`:642-649`）、G02 响应不泄露密钥（`:651-652`）。同条目记载「管理后台 Vue 子页面、usage/cost 页…按需求 §13 留后续阶段」。

### 2026-10-16（`ea58b6c`）

- 需求：题库接入腾讯云 CloudBase Agent AI 出题，生成结果作为草稿、经管理员审核后入库；原有 Excel 导入与题目增删改查完整保留。
- 修改内容：新建本文件（355 行）：模块 docstring 的 5 条设计约束（`:1-10`）、常量区（`:28-48`）、`_split_batches` 分批、`_build_prompt` 10+1 条输出约束、`_extract_json_array` 剥 ```json 围栏、`_normalize_options`/`_normalize_answer`/`_blank_question`/`_normalize_item` 规整、`_existing_question_texts` + `_duplicate_reasons` 查重、`_run_batches` 线程池并发与批级容错、`_build_drafts`、`_validate_params`、`generate_questions`（返回草稿不写库）、`batch_save_questions`（二次服务端校验 + `max(id)+1` 连续取号 + 单事务写入）。
- 关联文件：`backend/app/services/cloudbase_service.py`（ACP 协议封装，同批新建）、`backend/app/api/routes/admin.py`（`POST /api/admin/ai/generate-questions`、`POST /api/admin/ai/questions/batch-save`）、`backend/app/schemas/schemas.py:1141-1195`、`backend/app/core/config.py:66-78`（`CLOUDBASE_*` 4 项 + `AI_QUESTION_*` 3 项）、`admin/src/components/AiGenerateDialog.vue`、`admin/src/api/admin.ts:695-711`。
- 测试结果：据 `docs/迭代记录.md` 该提交条目——后端冒烟 `backend/test/s25_ai_question_generate.py` **16/16** 通过（含真实 Agent 生成 10 题与 50 题、401/403 越权、响应体不含密钥、小程序答题接口契约未变）；admin `npm run build` 通过；浏览器真机验收 **10 项全通过**（截图 `admin/test/images/s26-01~09`，报告 `admin/test/docs/s26-ai-question-admin-report.md`、`backend/test/docs/s26-ai-question-backend-report.md`）：AI 生成 10 题 → 编辑校验 → 删草稿 → 全选 → 保存 8 题（列表 15→23）→ 取消生成提示 → Excel 导入 2 题（总数 25）；**无任何数据库结构或数据变更**（复用现有 `questions` 表与字段）。同条目另记一处 admin 侧缺陷修复（结果面板 DOM 冻结在「生成中」，根因为 `watch` 深度监听递归更新，改为按签名比对），与本文件无关。

> 2026-10-22 更正：上条 `ea58b6c`（2026-10-16）关联文件中的 `backend/app/services/cloudbase_service.py` 为当时文件名，`c660727` 更名重写为 `llm_service.py`、`b712d81` 拆为 `llm_service.py` 门面 + `llm_openai.py`/`llm_cloudbase.py` 双适配器（共享类型在 `llm_base.py`）；`backend/app/core/config.py:66-78` 配置段现为 `config.py:68-93`（大模型共用段 + 双供应商段）与 `:95-98`（AI 出题策略段，`AI_QUESTION_*` 三项在 `:96-98`），`CLOUDBASE_TIMEOUT_SECONDS` 已删除；`backend/app/schemas/schemas.py:1141-1195` 中旧链路两类现位于 `:1233`（`AdminAiGenerateRequest`）与 `:1259`（`AdminAiGenerateOut`）起；`admin/src/api/admin.ts:695-711` 经复核仍有效。按 `.qoder/README.md` §3.11，历史条目正文保持原样，仅作本条追加更正。
