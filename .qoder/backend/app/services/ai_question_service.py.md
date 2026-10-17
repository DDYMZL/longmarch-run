# ai_question_service.py

## 1. 文件路径

`backend/app/services/ai_question_service.py`（695 行）

## 2. 文件职责

AI 出题服务：调用腾讯云 CloudBase Agent 生成「中国工农红军长征」单项选择题草稿，逐题做结构规整、内容校验与查重，经管理员人工确认后写入正式题库 `questions`。文件内含**两条并行链路**：

- **内存态旧链路**（`generate_questions` `:305-342` / `batch_save_questions` `:345-388`）：生成结果只在 HTTP 响应里返回草稿、不落库，管理员在弹窗内编辑/剔除后再调保存接口入库。当前 admin 前端唯一在用的链路。
- **持久化题目工坊**（`:391-695`）：一次生成落一条 `ai_generation_jobs` 任务，每道草稿落一条 `ai_generated_questions`，支持任务/草稿列表回溯、逐条编辑与审核、幂等导入题库。`:391-394` 的区块注释明确「现有 admin 前端的旧链路保持不变，本组接口供新工坊页使用」；**新工坊页属待开发**（`.qoder/ARCHITECTURE.md` §11.3）。

实际 HTTP 调用不在本文件：`_generate_batch`（`:200-207`）只调 `cloudbase_service.prompt`，ACP 协议 / SSE 解析 / 重试退避全部在 `backend/app/services/cloudbase_service.py`（该文件由同批 backend services 建档覆盖，本文档只引用不展开）。

## 3. 业务需求

- **需求来源①**：题库接入 CloudBase Agent AI 出题，草稿审核后入库（提交 `ea58b6c`，2026-10-16；`docs/迭代记录.md`「题库接入 CloudBase Agent AI 出题，草稿审核后入库（功能）」条目）。要求：生成参数含主题（必填）、数量 10/20/50/100、分类、难度（**仅作提示词参数，不入库**）、附加要求；题型固定单选；原有 Excel 批量导入与题目增删改查全部保留。
- **需求来源②**：《长征步迹 AI 智能中心开发需求 V1.0》**§3.4 题目工坊**（`:391` 区块注释直接标注该章节号），Phase A 后端提交 `1600074`（2026-10-17）。
- **设计约束**（模块 docstring `:1-10`，逐条对应实现）：
  1. 仅生成单选题（`type=single`），与小程序答题逻辑「单答案提交」保持一致（`:4`；`:26-27` 注明多选题需同步改判分与小程序交互，属破坏性变更，故不开放）。
  2. 难度只作提示词参数、不入库，因为 `questions` 表无 difficulty 列（`:5`；列清单见 `backend/app/models/models.py:126-142`、DDL `docker/init/001_schema.sql:16-24`）。
  3. 生成结果一律是草稿，不直接写库；管理员确认后由 `batch_save_questions` 落库（`:6`）。
  4. 入库前复用 `admin_service._validate_question`（**与 Excel 导入同等校验强度**），并重新做库内/批内查重，**不信任前端回传内容**（`:7-8`）。
  5. 大批量拆成多批并发调用 Agent，规避单次长回复被截断（`:9`；`backend/app/core/config.py:75` 注释同一口径）。
- 导航层见 `.qoder/REQUIREMENTS.md` §10.1/§10.3 与 `.qoder/ARCHITECTURE.md` §11.2/§11.3，本文档不复述其正文。
- **管理端现状**：嵌在题库页的「AI 智能出题」全屏对话框 `admin/src/components/AiGenerateDialog.vue` 已落地并走旧链路（`.qoder/ARCHITECTURE.md` §11.3 末段专门说明「这与题目工坊子页面待开发并不矛盾」）；独立的题目工坊管理页**待开发**。

## 4. 核心功能

### 4.1 模块常量（`:24-48`）

| 常量 | 行号 | 值 | 用途 |
|---|---|---|---|
| `logger` | `:24` | — | `logger.info` 4 处（`:331`、`:387`、`:532`、`:689`）、`logger.exception` 2 处（`:385`、`:687`） |
| `SUPPORTED_TYPES` | `:28` | `("single",)` | 题型白名单，校验点 `:289-290` |
| `SUPPORTED_DIFFICULTIES` | `:29` | `("easy","medium","hard","mixed")` | 难度白名单，校验点 `:291-292` |
| `SUPPORTED_CATEGORIES` | `:30` | `("event","route","figure")` | 分类白名单（可空），校验点 `:293-295`；与 `backend/app/services/admin_service.py:215` 的取值一致 |
| `TOPIC_MAX_LEN` | `:32` | `100` | 主题长度上限，校验点 `:287-288`；与 `AdminAiJobCreateRequest.topic` 的 `max_length=100`（`backend/app/schemas/schemas.py:1786`）及 admin 前端 `TOPIC_MAX_LEN`（`admin/src/components/AiGenerateDialog.vue:13`）三处同值 |
| `EXTRA_MAX_LEN` | `:33` | `300` | 补充要求长度上限，校验点 `:296-298` |
| `DEFAULT_SCORE` | `:34` | `20` | AI 生成题目的固定分值（`:159`、`:177`）；与 `AdminQuestionUpsert.score` 默认值 20 一致（`backend/app/schemas/schemas.py:1068`） |
| `OPTION_LABELS` | `:35` | `("A"…"F")` | label 补齐用（`:135`）与提示词/空白占位切片用（`:89`、`:155`） |
| `DEFAULT_OPTION_COUNT` | `:36` | `4` | **仅用于提示词与空白占位**（`:87`、`:89`、`:155`），不用于校验（见 §7 第 5 条） |
| `_DIFFICULTY_TEXT` | `:38-43` | 4 项中文描述 | 难度 → 提示词文案（`:76`），未命中回退 `medium` |
| `_CATEGORY_TEXT` | `:44-48` | 3 项中文描述 | 分类 → 提示词文案（`:79`） |
| `DRAFT_STATUSES` | `:395` | `("pending","approved","rejected","imported")` | **定义后全仓无任何引用**（死常量，见 §9） |

### 4.2 内部工具函数

| 函数 | 行号 | 职责 |
|---|---|---|
| `_split_batches(count, batch_size)` | `:51-57` | 把总题数拆成批次列表；`size = max(1, batch_size)` 兜住 0/负数（`:53`），`[size] * (count // size)` 加余数批（`:54-56`）。docstring 举例：25 题、每批 10 → `[10, 10, 5]` |
| `_build_prompt(topic, count, difficulty, category, extra, references="")` | `:60-100` | 构建提示词，约束 Agent 只输出可直接 `json.loads` 的题目数组（详见 §4.4） |
| `_extract_json_array(reply)` | `:103-118` | 从回复提取 JSON 数组：**容忍代码围栏**（`:106-108`，剥掉首个 ``` 行与末尾 ```）与前后多余文本（`:109`，取首个 `[` 到末个 `]`）；找不到括号/`json.loads` 失败/结果非 list 分别抛 `ValueError`（`:110-117`），文案面向管理员（「AI 返回内容不是 JSON 数组，请重试」/「AI 返回的 JSON 无法解析，请重试」） |
| `_normalize_options(raw_options)` | `:121-137` | 规整为 `[{"label","text"}]`；兼容三种写法 `{label,text}` / `{label,content}` / 纯字符串数组（`:129-133`）；label 缺失时按顺序补 `A/B/C/D…`，超 6 个退化为序号字符串（`:134-135`） |
| `_normalize_answer(raw_answer)` | `:140-146` | 统一为大写 label 数组，兼容 `"B"` / `["B"]` / `["b"]`（`:142-146`）；非 list 抛 `ValueError("answer 字段必须是数组")` |
| `_blank_question(category)` | `:149-161` | 结构完整但内容为空的占位题目，供无法解析的条目使用，**保证前端可渲染并手工修正**（`:150` docstring） |
| `_normalize_item(raw, category)` | `:164-179` | 单个元素 → `questions` 表结构；非 dict 抛 `ValueError("题目必须是 JSON 对象")`、`options` 非 list 抛 `ValueError("options 字段必须是数组")`（`:166-170`） |
| `_existing_question_texts(db)` | `:182-185` | 库内**启用**题干集合（`filter(Question.active.is_(True))`），「口径与 Excel 导入预览一致」（`:183` docstring） |
| `_duplicate_reasons(text, existing, seen)` | `:188-197` | 返回重复原因列表；题干为空时**不报重复**（交由校验环节报「题干不能为空」，`:189`、`:191-192`）；库内重复 → `["与题库中已有题目重复"]`，批内重复 → `["与本次生成的其他题目重复"]`（`:193-196`） |
| `_generate_batch(topic, count, difficulty, category, extra, references="")` | `:200-207` | 调 `cloudbase_service.prompt(_build_prompt(...))` 并解析成原始元素列表；**不触碰 `db`**（并发安全前提，见 §8） |
| `_run_batches(...)` | `:210-249` | 并发执行各批次（详见 §4.5） |
| `_build_drafts(db, elements, category)` | `:252-272` | 原始元素 → 草稿列表（详见 §4.6） |
| `_validate_params(...)` | `:275-302` | 校验并规整出题参数（详见 §4.3） |
| `_references_from_knowledge(db, knowledge_ids)` | `:398-415` | 知识接地：按传入 ID 拼「参考资料」（详见 §4.8） |
| `job_view(job, drafts=None)` | `:418-435` | `AiGenerationJob` → dict；`drafts is not None` 时才附 `drafts` 键（`:433-434`），对应 `AdminAiJobOut.drafts` 默认 `[]`（`backend/app/schemas/schemas.py:1822`） |
| `draft_view(draft)` | `:438-449` | `AiGeneratedQuestion` → dict，对应 `AdminAiDraftOut`（`backend/app/schemas/schemas.py:1795-1806`） |
| `_get_draft(db, draft_id)` | `:581-585` | 取草稿，不存在抛 `ValueError("草稿不存在")` |

两个 view 函数对可空列统一 `or ""` / `or {}` / `or []` 兜底（`:423`、`:428-429`、`:442-446`），因为本库空字符串按 NULL 存储（`backend/app/models/models.py:546`）。

### 4.3 参数校验 `_validate_params`（`:275-302`）

返回 `(topic, count, difficulty, category, extra)`，全部为 strip 后的值。逐条规则：

| 规则 | 行号 | 失败文案 |
|---|---|---|
| 主题非空 | `:284-286` | 出题主题不能为空 |
| 主题 ≤ 100 字 | `:287-288` | 出题主题不能超过 100 字 |
| 题型 ∈ `SUPPORTED_TYPES` | `:289-290` | AI 出题目前仅支持单选题（single） |
| 难度 ∈ `SUPPORTED_DIFFICULTIES` | `:291-292` | 难度必须为 easy（简单）/ medium（中等）/ hard（困难）/ mixed（混合） |
| 分类为空或 ∈ `SUPPORTED_CATEGORIES` | `:293-295` | 分类必须为 event（历史事件）/ route（长征路线）/ figure（历史人物）或留空 |
| 补充要求 ≤ 300 字 | `:296-298` | 补充要求不能超过 300 字 |
| `1 <= count <= settings.AI_QUESTION_MAX_COUNT` | `:299-301` | 生成数量必须在 1~{max_count} 之间 |

`max_count` 在**运行时**读 `settings.AI_QUESTION_MAX_COUNT`（`:299`），而 schema 侧 `count` 硬编码 `le=100`（`backend/app/schemas/schemas.py:1150`、`:1787`）：调大 env 值不会放开 HTTP 上限（先被 Pydantic 拦成 422），调小则 service 层 400 生效。

### 4.4 提示词构建 `_build_prompt`（`:60-100`）

按行拼接，顺序为：

1. `references` 非空时**前置注入**参考资料段（`:68-73`）：「请严格依据以下已审核的参考资料出题，不要超出资料范围编造史实」+ 资料正文（docstring `:65` 说明「题目工坊按已发布知识出题」）。
2. 主题与数量：「请围绕主题「{topic}」生成 {count} 道中国工农红军长征相关的单项选择题。」（`:75`）。
3. 难度要求（`:76`，查 `_DIFFICULTY_TEXT`，未命中回退 medium）。
4. 分类侧重（`:78-79`，`category` 为空则整行不输出）。
5. **10 条输出要求**（`:80-96`）：只输出一个 JSON 数组、不要解释/前后缀/Markdown 围栏（第 1 条）；数组长度恰好为 count（第 2 条）；每元素只含 `question`/`options`/`answer`/`analysis` 四字段（第 3 条）；`options` 固定 4 个、形如 `{"label":"A","text":"…"}`、label 依次 A、B、C、D（第 4 条，`:87-89`）；`answer` 必须是只含 1 个元素的数组（第 5 条）；有且仅有一个正确答案、错误选项须有明显区分度（第 6 条）；`analysis` 用 1~3 句中文（第 7 条）；各题题干与选项不得重复或高度雷同（第 8 条）；**史实必须准确、无法确认的不要编造**（第 9 条）；简体中文、不要出现题号编号（第 10 条）。
6. `extra` 非空时追加第 11 条补充要求（`:97-99`）。

第 1~5 条与解析/规整函数一一对应（`_extract_json_array` ↔ 第 1 条、`_normalize_item` ↔ 第 3 条、`_normalize_options` ↔ 第 4 条、`_normalize_answer` ↔ 第 5 条），第 6/8 条由 `admin_service._validate_question` 与 `_duplicate_reasons` 在服务端兜底复核——**提示词只是请求，不是保证**。

### 4.5 分批并发策略 `_run_batches`（`:210-249`）与三个配置项的实际使用点

| 配置项（env 默认见 `backend/app/core/config.py`） | 默认 | 使用点 | 作用 |
|---|---|---|---|
| `AI_QUESTION_BATCH_SIZE`（`:76`） | 10 | `:319`（`generate_questions`）、`:490`（`run_job`） | 传给 `_split_batches` 决定每批题数 → 批数 = ⌈count / batch_size⌉ |
| `AI_QUESTION_MAX_CONCURRENCY`（`:77`） | 3 | `:223` | `workers = max(1, min(len(batches), settings.AI_QUESTION_MAX_CONCURRENCY))`——**既不超过批数，也不低于 1** |
| `AI_QUESTION_MAX_COUNT`（`:78`） | 100 | `:299`（生成数量上限）、`:354`（单次保存上限）、`:638-639`（单次导入上限） | 三处独立限制：生成、批量保存、草稿导入 |

执行细节：

- `ThreadPoolExecutor(max_workers=workers)`（`:225`），用 dict 推导一次性 submit 全部批次并记住批次序号（`:226-231`）。
- `as_completed` 收集（`:232`）；**单批失败不影响其他批次**：`except Exception` 把异常连同批次号记入 `outcomes`（`:234-237`，`:236` 注释「批次级兜底：任何单批异常都不得中断整体生成」）。
- `outcomes.sort(key=lambda item: item[0])`（`:238`）：完成顺序被打乱后**按批次序号重排**，保证题目顺序与请求批次一致。
- 汇总（`:239-249`）：成功批 `elements.extend(data or [])`；失败批 `errors.append(f"第 {index + 1} 批生成失败：{exc}")`，并保留 `first_error`（**首个异常保留原类型**，`:220-221` docstring 说明「以便全部失败时路由层仍能区分 502（上游故障）与 400（参数/解析问题）」）。
- 返回 `(elements, errors, first_error)`（`:217`、`:249`）。
- 线程内只有 HTTP、无数据库访问（`_generate_batch` `:200-207`），因此 Session 不跨线程共享；这也是本函数唯一可安全并发的前提。
- 无取消检查点：线程池会跑完全部批次（`:225-237`），客户端断开连接不会中止生成。

### 4.6 草稿组装 `_build_drafts`（`:252-272`）

对每个原始元素：

1. `_normalize_item` 抛 `ValueError` → 用 `_blank_question(category)` 占位，并把异常文案记入 `errors`（`:259-263`）；**该条目不进 `seen`**，因此多条结构非法的空白草稿之间不会互相判重。
2. 规整成功 → 调 `admin_service._validate_question(data)`，`ValueError` 记入 `errors`（`:265-268`）；再 `_duplicate_reasons(data["question"], existing, seen)` 追加库内/批内重复原因（`:269`）；随后 `seen.add(data["question"].strip())`（`:270`）。
3. 每条产出 `{"index": len(drafts) + 1, "data": data, "errors": errors}`（`:271`）——**`index` 从 1 起**，与 `AdminAiSaveFailure.index` 的口径一致（`backend/app/schemas/schemas.py:1185-1189`）。

`errors` 非空即「待修正」，`generate_questions` 据此统计 `invalid_count`（`:330`、`:338-339`）。

### 4.7 旧链路（内存态）

**`generate_questions(db, topic, count, question_type="single", difficulty="medium", category="", extra_requirements="")`（`:305-342`）**

- docstring `:314` 明确「不写入正式题库（内存态，供旧预览链路）」。
- 流程：`_validate_params`（`:315-317`）→ `_split_batches`（`:319`）→ `_run_batches`（`:320-322`，**未传 `references`，故旧链路不支持知识接地出题**）→ 全部批次失败时抛 `first_error`（保留 `CloudBaseError` 类型，`:323-326` 注释说明「以便路由映射为 502」），无异常但无元素则 `ValueError("AI 未返回任何题目，请重试")`（`:327`）→ `_build_drafts`（`:329`）→ `logger.info` 打点（`:331-334`，只记长度与计数，**不记主题与题目正文**）。
- 返回（`:335-342`）：`{requested, generated, valid_count, invalid_count, items, batch_errors}`，对应 `AdminAiGenerateOut`（`backend/app/schemas/schemas.py:1168-1176`）。
- 数据库：只读 `questions`（`:184`），**不写、不 commit**。

**`batch_save_questions(db, items)`（`:345-388`）**

- 空列表 → `ValueError("没有需要保存的题目")`（`:352-353`）；条数 > `AI_QUESTION_MAX_COUNT` → `ValueError(f"单次最多保存 {max_count} 道题目")`（`:354-356`）。
- 逐条**重新**校验（`admin_service._validate_question`，`:363-368`）与查重（库内 + 批内，`:369-373`），未通过的记 `{"index": index, "reason": …}` 进 `failures`（index 从 1 起，`:362`）并跳过；通过的进 `pending`。
- 写入（`:376-386`）：`base_id = db.query(func.max(Question.id)).scalar() or 0`（`:378`，`:377` 注释「questions.id 无数据库自增（种子占用固定 id），与新增/导入一致显式取 max+1 连续分配」），逐条 `Question(id=base_id + offset, **data)`（`:380-381`），**`db.commit()`（`:382`）**；任何异常 → `db.rollback()` + `logger.exception` + `ValueError("保存失败，请稍后重试")`（`:383-386`）。
- docstring `:348-350`：「不信任前端：每条都重新过 `admin_service._validate_question` 与库内/批内查重。通过校验的题目在单事务内写入，数据库异常整体回滚；未通过的跳过并计入失败明细，从而实现『部分失败可统计』而不产生半批脏数据。」
- 返回 `{saved, failed, failures}`（`:388`），对应 `AdminAiBatchSaveOut`（`backend/app/schemas/schemas.py:1192-1195`）。

### 4.8 持久化题目工坊（`:391-695`）

**`_references_from_knowledge(db, knowledge_ids)`（`:398-415`）**：`int()` 容错跳过非法 ID（`:401-405`）；只取 `status == "published"` 的资料（`:408-412`，`:399` docstring「未发布的忽略」）；按**传入顺序**重排（`:413-414`）；交 `ai_knowledge_service.format_context` 拼成「【资料N】标题（来源：X）\n正文」段落（`:415`；实现 `backend/app/services/ai_knowledge_service.py:245-255`）。

**`run_job(db, actor, topic, count, question_type="single", difficulty="medium", category="", extra_requirements="", knowledge_ids=None)`（`:452-535`）**

1. `_validate_params`（`:467-469`）→ `_references_from_knowledge`（`:470`）。
2. 建任务行（`:471-485`）：`job_type="question"`、`status="running"`、`created_by=actor`、`requested=count`、`params` 为参数快照（含过滤后的 `knowledge_ids`，`:480`）；`db.add(job)` + **`db.flush()`**（`:486-487`）以取得 `job.id`（`SessionLocal` 为 `autoflush=False`，`backend/app/core/database.py:51`）。
3. 生成（`:489-493`）包在 `try` 内；上游/网络异常 → `job.status="failed"`、`job.error=str(exc)[:500]`、`job.finished_at=now_utc()`、**`db.commit()`**（`:494-498`）后**原样 raise**（`:499`），docstring `:465` 说明「任务落 failed 并落库，再抛出原始异常供路由区分 502/400」。
4. `elements` 为空 → `status="failed"`、`failed=count`、`error` 取 `first_error` 或「AI 未返回任何题目」（均截断 500 字）、`finished_at`、**`db.commit()`**（`:501-506`），再抛 `first_error` 或 `ValueError`（`:507-509`）。
5. `_build_drafts`（`:511`）后逐条建 `AiGeneratedQuestion(job_id=job.id, data=…, errors=…, status="pending")`（`:512-518`）。
6. 汇总（`:520-528`）：`succeeded = generated`；`failed = max(0, count - generated)`；`status = "success" if (failed == 0 and not batch_errors) else "partial"`；有批次错误时 `job.error = "；".join(batch_errors)[:500]`；`finished_at = now_utc()`。
7. `db.flush()`（`:529`）→ **`view = job_view(job, draft_rows)`（`:530`，注释「提交前构建视图，规避 commit 后属性过期再查」）** → `db.commit()`（`:531`）→ `logger.info`（`:532-534`）→ 返回 view（`:535`）。
8. **本函数自行 commit（`:498`、`:506`、`:531` 三处）**；路由不再 commit、也不写审计——`backend/app/api/routes/ai_admin.py:211` docstring：「任务记录本身即操作留痕（含 created_by/params/时间）」。

**查询三函数**

| 函数 | 行号 | 说明 |
|---|---|---|
| `list_jobs(db, page=1, page_size=20)` | `:538-547` | `count()` + `order_by(created_at DESC, id DESC)` + offset/limit（`:543` 用 `max(1, page)` 兜住非法页码）；返回 `(total, [job_view(j)])`，**不含草稿** |
| `get_job(db, job_id)` | `:550-560` | 任务不存在 → `ValueError("任务不存在")`（`:552-553`，路由转 **404**）；草稿按 `id ASC` 全量附在 `drafts`（`:554-559`，**不分页**） |
| `list_drafts(db, job_id=None, status="", page=1, page_size=50)` | `:563-578` | 两个可选过滤（`:567-570`），`order_by(id DESC)`（`:573`）；返回 `(total, [draft_view(d)])` |

**`update_draft(db, draft_id, data, actor)`（`:588-606`）**：`imported` 不可改（`:591-592`，`ValueError("已导入题库的题目不能再修改")`）；`draft.data = dict(data)` **整体替换**（`:593`）；重算 `errors` = 结构校验（`:595-598`）+ **仅库内查重**（`:599-601`，`seen` 传空集，故不检测与同任务其他草稿的重复）；`approved`/`rejected` 改动后回到 `pending`（`:603-604`，docstring `:589`「改动后回到待审核」）；`db.flush()`（`:605`），**由路由 commit**（`backend/app/api/routes/ai_admin.py:287`）。**`actor` 参数在函数体内未被使用**（本文件 `:590-606` 无引用）。

**`set_draft_status(db, draft_id, status, actor)`（`:609-628`）**：`status` 只接受 `approved`/`rejected`/`pending`（`:611-612`）；`imported` 不可改状态（`:614-615`）；置 `approved` 前**重新结构校验**，失败抛 `ValueError(f"题目仍有问题，无法通过：{exc}")`（`:616-621`），通过则回写 `draft.data` 并清空 `errors`（`:622-623`）；写 `reviewed_by=actor`、`reviewed_at=now_utc()`（`:625-626`）；`db.flush()`（`:627`），**由路由 commit**（`backend/app/api/routes/ai_admin.py:308`）。注意**审核环节不做查重**，重复题在导入阶段才被拦（本文件 `:665-668`）。

**`import_drafts(db, draft_ids, actor)`（`:631-695`）**

- 空列表 → `ValueError("没有需要导入的题目")`（`:636-637`）；条数 > `settings.AI_QUESTION_MAX_COUNT` → `ValueError(f"单次最多导入 {…} 道题目")`（`:638-639`）。
- **一次 `IN` 查询**取全部草稿行（`:641`，避免逐条查库）+ `by_id` 映射（`:642`）+ 一次取库内题干集合（`:643`）。
- 逐 ID 判定（`:648-670`）：草稿不存在 → `failures[{id, reason:"草稿不存在"}]`；`status == "imported"` → `skipped += 1`（**幂等**，`:653-655`）；`status != "approved"` → `failures[…"只有审核通过的草稿才能导入"]`；重新 `_validate_question`（`:659-664`）；库内/批内查重（`:665-669`）；全部通过 → `to_import`。
- 写入（`:672-688`）：`base_id = db.query(func.max(Question.id)).scalar() or 0`（`:674`），逐条 `Question(id=base_id+offset, **data)` 并把草稿置 `imported`、回填 `question_id`、`reviewed_by = draft.reviewed_by or actor`、`reviewed_at = now_utc()`（`:676-682`）；**`db.flush()` 而非 commit**（`:683`，注释「不在此提交：由路由连同审计日志一起 commit，保证原子落库」）；异常 → `db.rollback()` + `logger.exception` + `ValueError("导入失败，请稍后重试")`（`:685-688`）。
- 返回 `{imported, skipped, failed, failures}`（`:690-695`），对应 `AdminAiImportOut`（`backend/app/schemas/schemas.py:1854-1858`）。路由写审计 `ai.draft.import`（记 imported/skipped/failed 计数）后 commit（`backend/app/api/routes/ai_admin.py:328-334`）。

## 5. 输入与输出

### 5.1 HTTP 端点（9 个触及本模块；管理端契约，字段 **snake_case**，`backend/app/api/routes/ai_admin.py:3` docstring）

（下表行号约定：「路由位置」「调用的函数」「异常映射」三列的行号属该行「路由位置」列写明的路由文件；「请求体」「`response_model`」两列的行号属 `backend/app/schemas/schemas.py`。）

| 方法 | 完整路径 | 路由位置 | 权限依赖 | 请求体（`backend/app/schemas/schemas.py`） | `response_model`（`backend/app/schemas/schemas.py`） | 调用的函数 | 异常映射 |
|---|---|---|---|---|---|---|---|
| POST | `/api/admin/ai/generate-questions` | `backend/app/api/routes/admin.py:500-521` | `require_menu("questions")` | `AdminAiGenerateRequest`（`backend/app/schemas/schemas.py:1142-1154`） | `AdminAiGenerateOut`（`:1168`） | `generate_questions`（`:508-516`） | `CloudBaseError` → **502**（`:517-519`，注释「先于 ValueError 捕获」）；`ValueError` → **400**（`:520-521`） |
| POST | `/api/admin/ai/questions/batch-save` | `backend/app/api/routes/admin.py:524-538` | `require_menu("questions")` | `AdminAiBatchSaveRequest`（`backend/app/schemas/schemas.py:1179-1182`，`questions: List[AdminQuestionUpsert]`） | `AdminAiBatchSaveOut`（`:1192`） | `batch_save_questions`（`:534-536`，路由侧 `item.model_dump()` 转 dict） | `ValueError` → **400**（`:537-538`；service 内部已 rollback） |
| POST | `/api/admin/ai/jobs` | `backend/app/api/routes/ai_admin.py:200-225` | `require_menu("ai_workshop")` | `AdminAiJobCreateRequest`（`backend/app/schemas/schemas.py:1783-1792`，含 `knowledge_ids`） | `AdminAiJobOut`（`:1809`） | `run_job`（`:213-223`） | `AI_ERRORS` → `ai_http_error`（`:224-225`）：403/429/**502**/400 |
| GET | `/api/admin/ai/jobs` | `backend/app/api/routes/ai_admin.py:228-240` | `require_menu("ai_workshop")` | Query `page`(≥1)、`page_size`(1~100) | `AdminAiJobListOut`（`:1825`） | `list_jobs`（`:239`） | 无 try（参数由 Query 约束，非法 → 422） |
| GET | `/api/admin/ai/jobs/{job_id}` | `backend/app/api/routes/ai_admin.py:243-253` | `require_menu("ai_workshop")` | 路径参数 | `AdminAiJobOut` | `get_job`（`:251`） | `ValueError` → **404**（`:252-253`） |
| GET | `/api/admin/ai/drafts` | `backend/app/api/routes/ai_admin.py:256-270` | `require_menu("ai_workshop")` | Query `job_id`、`status`、`page`、`page_size`(1~200，默认 50) | `AdminAiDraftListOut`（`:1830`） | `list_drafts`（`:269`） | 无 try |
| PUT | `/api/admin/ai/drafts/{draft_id}` | `backend/app/api/routes/ai_admin.py:273-291` | `require_menu("ai_workshop")` | `AdminAiDraftUpdateRequest`（`:1835-1838`，`data: Dict`） | `AdminAiDraftOut`（`:1795`） | `update_draft`（`:286`）+ `db.commit()`（`:287`） | `ValueError` → **400** + rollback（`:288-290`） |
| PATCH | `/api/admin/ai/drafts/{draft_id}/status` | `backend/app/api/routes/ai_admin.py:294-312` | `require_menu("ai_workshop")` | `AdminAiDraftStatusRequest`（`:1841-1842`，`status: str`） | `AdminAiDraftOut` | `set_draft_status`（`:307`）+ `db.commit()`（`:308`） | `ValueError` → **400** + rollback（`:309-311`） |
| POST | `/api/admin/ai/drafts/import` | `backend/app/api/routes/ai_admin.py:315-338` | `require_menu("ai_workshop")` | `AdminAiImportRequest`（`:1845-1846`，`draft_ids: List[int]`，`min_length=1`） | `AdminAiImportOut`（`:1854`） | `import_drafts`（`:327`）+ 审计 + `db.commit()`（`:328-334`） | `ValueError` → **400** + rollback（`:335-337`） |

两个路由前缀：`backend/app/api/routes/admin.py:98` 为 `/admin`，`backend/app/api/routes/ai_admin.py:43` 为 `/admin/ai`，均经 `backend/app/main.py:86`、`:87` 以 `settings.API_PREFIX`（`/api`）挂载。`require_menu` 语义见 `backend/app/api/deps.py:150-160`（无该菜单码 → 403）。

**审计差异（事实）**：`POST /drafts/import` 写审计（`backend/app/api/routes/ai_admin.py:328-333`）；旧链路两个端点（`backend/app/api/routes/admin.py:506-521`、`:530-538`）、`POST /jobs`、`PUT /drafts/{id}`、`PATCH /drafts/{id}/status` **均不写 `audit_logs`**。

### 5.2 单条题目草稿的数据结构

`_normalize_item`（`:171-179`）与 `_blank_question`（`:151-161`）产出同构 dict，与 `AdminQuestionUpsert`（`backend/app/schemas/schemas.py:1060-1069`）及 `questions` 表列一一对应：

| 字段 | 类型 | 取值 | 来源 |
|---|---|---|---|
| `type` | str | 恒 `"single"` | `:172`（硬编码，不取 Agent 输出） |
| `question` | str | 题干，strip | `:173` |
| `options` | list | `[{"label": "A", "text": "…"}, …]` | `:174` → `_normalize_options` |
| `answer` | list | 大写 label 数组，单选须恰好 1 个 | `:175` → `_normalize_answer` |
| `analysis` | str | 解析，strip | `:176` |
| `score` | int | 恒 `DEFAULT_SCORE`(20) | `:177` |
| `category` | str | 请求参数传入的分类（可为空串） | `:178` |

`admin_service._validate_question`（`backend/app/services/admin_service.py:208-233`）的 8 条规则中，`type`（`:210`）与 `score`（`:232`）对 AI 生成项恒成立，实际起作用的是：题干非空、category 合法、选项 ≥2、label 不重复、answer 非空且都在 label 中、单选 answer 恰好 1 个。**该函数会就地改写传入 dict 的 `category`**（`backend/app/services/admin_service.py:217`），因此本文件各处调用前都先 `dict(...)` 拷贝（`:363`、`:596`、`:617`、`:659`）。

### 5.3 返回结构汇总

| 函数 | 返回 |
|---|---|
| `generate_questions` | `{requested, generated, valid_count, invalid_count, items[{index,data,errors}], batch_errors[str]}`（`:335-342`） |
| `batch_save_questions` | `{saved, failed, failures[{index,reason}]}`（`:388`，index 1 基） |
| `run_job` / `get_job` | `job_view`：`{id, job_type, topic, params, requested, succeeded, failed, status, error, created_by, created_at, finished_at, drafts[…]}`（`:419-435`） |
| `list_jobs` / `list_drafts` / `get_job` 的分页版 | `(total, [view…])` 元组（`:547`、`:578`） |
| `update_draft` / `set_draft_status` | `draft_view`：`{id, job_id, data, errors, status, question_id, reviewed_by, reviewed_at, created_at}`（`:439-449`） |
| `import_drafts` | `{imported, skipped, failed, failures[{id,reason}]}`（`:690-695`，`failures` 用 `id` 而非 `index`） |

## 6. 依赖关系

### 6.1 依赖

- 标准库：`json`、`logging`、`concurrent.futures.ThreadPoolExecutor / as_completed`、`typing`（`:11-14`）。
- 第三方：`sqlalchemy.func`、`sqlalchemy.orm.Session`（`:16-17`）。
- 项目内：
  - `app.core.config.settings`（`:19`）——只读 3 个 `AI_QUESTION_*`（`:223`、`:299`、`:319`、`:354`、`:490`、`:638-639`）。
  - `app.core.helpers.now_utc`（`:20`）——`finished_at` / `reviewed_at`（`:497`、`:505`、`:528`、`:626`、`:682`）。
  - `app.models.models`（`:21`）：`AiGeneratedQuestion`、`AiGenerationJob`、`AiKnowledge`、`Question`。
  - `app.services.admin_service`（`:22`）：**跨模块调用私有函数 `_validate_question`**（`:266`、`:365`、`:596`、`:619`、`:661`）。
  - `app.services.ai_knowledge_service`（`:22`）：`format_context`（`:415`）。
  - `app.services.cloudbase_service`（`:22`）：`prompt`（`:204-206`）。
- 数据库表：`questions`（读 `:184`、读 max(id) `:378`/`:674`、写 `:381`/`:678`）、`ai_generation_jobs`（写 `:471-487`、读 `:539`/`:551`）、`ai_generated_questions`（写 `:514-518`、读 `:555`/`:566`/`:582`/`:641`、改 `:593-604`/`:622-626`/`:679-682`）、`ai_knowledge`（只读 `published`，`:408-412`）。
- **不依赖** `ai_config_service` / `ai_usage_service`（import 清单 `:19-22` 无二者）：出题链路**不校验 AI 总开关、不受日限额约束、不写 `ai_usage_logs`**（见 §9 第 9 条）。

### 6.2 被谁依赖

（下表「位置」列的行号均属同行「依赖方」列的文件。）

| 依赖方 | 位置 | 用到的函数 |
|---|---|---|
| `backend/app/api/routes/admin.py` | `:85`（import）、`:508`、`:534` | `generate_questions`、`batch_save_questions` |
| `backend/app/api/routes/ai_admin.py` | `:39`（import）、`:213`、`:239`、`:251`、`:269`、`:286`、`:307`、`:327` | `run_job`、`list_jobs`、`get_job`、`list_drafts`、`update_draft`、`set_draft_status`、`import_drafts` |
| `admin/src/api/admin.ts` | `:697-703`（`generateAiQuestions`，`timeout: 0` + `signal` + `silent`）、`:705-711`（`batchSaveAiQuestions`） | 仅旧链路两个端点 |
| `admin/src/components/AiGenerateDialog.vue` | 经上述两个 api 函数 | 旧链路的表单/预览/编辑/批量保存 UI |
| 测试 | `backend/test/s25_ai_question_generate.py`（A01~A16 共 16 用例）、`backend/test/s26_ai_center.py`（W01~W11 工坊组 + G01/G02 旧链路回归与安全） | 均经 HTTP 调用，**无脚本直接 import 本模块** |

**工坊 7 个端点当前无管理端调用方**：`admin/src` 全目录只出现 `/admin/ai/generate-questions` 与 `/admin/ai/questions/batch-save` 两个路径（grep `admin/src` 命中仅 `admin/src/api/admin.ts:698`、`:707`），与「题目工坊管理页待开发」一致。

## 7. 业务规则

1. **题型固定单选**：`:28`、`:289-290`；`:26-27` 注释说明理由——小程序答题接口强制提交单个答案（`quiz_service` 校验），多选题需同步改判分与小程序交互，属破坏性变更。
2. **难度不入库**：`:5`、`:29`、`:291-292`；难度只影响 `_DIFFICULTY_TEXT` 的提示词文案（`:76`）。`mixed` 表示难易混合（`:42`）。
3. **分值恒 20**：`:34`、`:159`、`:177`；AI 不能自行决定分值。
4. **生成即草稿、人工确认才入库**：`:6`、`:314`、`:345-351`、`:632`。工坊链路多一层审核态（`approved`）才允许导入（`:656-658`）。
5. **选项数不强制 4 个**：提示词要求固定 4 个（`:87-89`），`DEFAULT_OPTION_COUNT` 只用于提示词与空白占位（`:36`、`:155`）；`_normalize_item` 不裁剪也不补齐条数，校验只要求 ≥2 且 label 唯一（`backend/app/services/admin_service.py:219-223`）。Agent 返回 3 或 5 个选项时草稿照样通过。
6. **不信任前端**：保存（`:348`）与导入（`:632`）都重新做完整校验 + 库内/批内查重，不复用生成阶段的结论。
7. **查重口径**：库内取 `active=True` 的题干（`:184`），**精确字符串匹配 strip 后的题干**（`:190-196`），无模糊/相似度比对；软停用题目（`admin_service.delete_question` 只置 `active=False`，`backend/app/services/admin_service.py:196-205`）不参与查重，因此可导入与已停用题目同题干的题。`questions` 表对题干**无唯一约束**（`docker/init/001_schema.sql:16-24`），查重完全是应用层行为。
8. **部分失败可统计、不阻断**：批级（`:236-237`、`:242-248`）、条目级（`:366-372`、`:650-668`）都是「记失败、继续处理其余」。
9. **草稿状态流转**：`pending` →（审核）`approved`/`rejected` →（导入）`imported`；`imported` 为终态，不可编辑（`:591-592`）也不可改状态（`:614-615`）；编辑 `approved`/`rejected` 的草稿会退回 `pending`（`:603-604`）。
10. **导入幂等**：已 `imported` 的草稿重复导入 → 计入 `skipped`、不再写库（`:653-655`）；冒烟 W07 实测「重复导入已导入草稿被 skipped，题库不再新增」（`backend/test/s26_ai_center.py:606-612`）。
11. **任务状态判定**：`success`（无失败且无批次错误）/ `partial`（其余有产出的情况）/ `failed`（无产出或上游异常）（`:494-509`、`:523-525`）；`error` 字段一律截断 500 字（`:496`、`:504`、`:527`）。
12. **知识接地只走工坊链路**：`run_job` 支持 `knowledge_ids`（`:461`、`:470`），`generate_questions` 不传 `references`（`:320-322`）；只有 `published` 资料会进提示词（`:410`），未发布/草稿资料绝不外泄。
13. **日志最小化**：4 处 `logger.info` 只记长度与计数（`:331-334`、`:387`、`:532-534`、`:689`），不记主题原文、题目正文或密钥；2 处 `logger.exception` 只在 DB 写入失败时打栈（`:385`、`:687`）。

## 8. 修改约束

- **不得在 `_generate_batch` / 线程池任务内使用 `db`**：SQLAlchemy Session 非线程安全，当前 `_generate_batch`（`:200-207`）只做 HTTP 是并发安全的前提；数据库读写全部留在主线程（`:254`、`:358`、`:641-643`）。
- **`questions.id` 取号方式必须与全仓一致**：`max(id)+1`（`:378`、`:674`）与 `backend/app/services/admin_service.py:175-176`（新增题目）、`backend/app/services/import_service.py:293-295`（Excel 导入确认）同源（`:377` 注释明示）。改为数据库自增或序列属跨 3 处 + 迁移的变更，须整体评估。
- **校验必须继续复用 `admin_service._validate_question`**（`:7-8`），不得在本文件另写一套，否则 AI 出题与 Excel 导入的校验强度会分叉；同时注意它会就地改写 `category`（`backend/app/services/admin_service.py:217`），传参前必须 `dict(...)` 拷贝（本文件 4 处已如此）。
- **事务边界不得挪动**：`import_drafts` 必须保持 flush-only（`backend/app/services/ai_question_service.py:683` 注释），否则题目写入与审计日志（`backend/app/api/routes/ai_admin.py:328-334`）不再原子；`update_draft`/`set_draft_status` 同理（`backend/app/services/ai_question_service.py:605`、`:627`）。反之，`batch_save_questions`（`:382`）与 `run_job`（`:498`、`:506`、`:531`）是**service 自行 commit**，路由不再 commit——改动时不要把两种口径混用。
- **`run_job` 必须在 commit 前构建视图**（`:530` 注释）：commit 后 ORM 属性过期，再访问会触发额外查询甚至在已关闭会话上报错。
- **旧链路契约冻结**：`:394` 注释「现有 admin 前端的旧链路（generate-questions/batch-save）保持不变」；`AdminAiGenerateOut` / `AdminAiBatchSaveOut` 字段与 `failures[].index` 的 1 基口径（`:271`、`:362`）已被 `admin/src/components/AiGenerateDialog.vue` 消费，改动即破坏管理端。
- **提示词的输出约束与解析函数必须同步改**：`:82-96` 的第 1~5 条对应 `_extract_json_array`（`:103-118`）/`_normalize_item`（`:164-179`）/`_normalize_options`（`:121-137`）/`_normalize_answer`（`:140-146`）；只改一侧会导致解析全批失败。
- **开放多选题属破坏性变更**（`:26-27`）：须同步 `SUPPORTED_TYPES`（`:28`）、判分逻辑（`backend/app/services/quiz_service.py`）与小程序答题交互，禁止只改本文件。
- **难度若要入库**须新增编号迁移加列并同步 ORM（`backend/app/models/models.py:126-142`），遵守 `docker/init/SQL_CONSTRAINTS.md`，禁止改已执行过的 `docker/init/001_schema.sql`。
- **密钥不得出现在提示词、日志、异常消息或响应中**（`backend/app/services/cloudbase_service.py:10`；`.qoder/README.md` §3.14）；冒烟 A13（`backend/test/s25_ai_question_generate.py:380`）与 G02（`backend/test/s26_ai_center.py:651-652`）专门断言响应不泄露 `CLOUDBASE_API_KEY`。
- 新增写库路径应保留 `try/except → rollback + logger.exception + ValueError(中文)` 的兜底形态（`:383-386`、`:685-688`），以便路由层统一转 400。

## 9. 当前实现状态

### 已实现

- 旧链路：分批并发生成、JSON 容错解析、逐题规整/校验/查重、草稿预览、批量保存（`:51-388`）。
- 工坊链路：任务与草稿持久化、任务/草稿分页列表与详情、草稿编辑与审核、幂等导入题库（`:391-695`）。
- 知识接地出题（`knowledge_ids` → 已发布资料进提示词，`:398-415`、`:470`）。
- 批级容错与部分成功语义（`partial` 状态、`batch_errors`、`failures` 明细）。
- 冒烟已验证：`backend/test/s25_ai_question_generate.py` 16/16（A09「批量保存重新校验：合法项入库且 id 自 max+1 连续」、A10 库内/批内重复拦截、A14/A15 真实 Agent 生成 10 题与 50 题分批）；`backend/test/s26_ai_center.py` W01~W11（任务/草稿落库、列表回溯、编辑重算 errors、审核、导入、幂等、鉴权 403、知识接地、失败落 failed + 502）与 G01/G02（旧链路回归 + 不泄露密钥），结果 JSON `backend/test/s26-ai-center-results.json` 记 `total=47 passed=47 failed=0`。

### 存在问题 / 限制

1. **`questions.id` 用 `max(id)+1` 取号，无并发保护**（`:378`、`:674`）：无 `with_for_update()`、无唯一冲突重试、无数据库序列。两个管理员同时批量保存/导入会算出同一 `base_id` → 主键冲突 → 被 `:383-386` / `:685-688` 的宽 `except Exception` 兜住 → `rollback` + `ValueError`「保存失败/导入失败，请稍后重试」→ 400，**不产生半批脏数据，但需人工重试**。该结论与 `.qoder/ARCHITECTURE.md` §16.1「非自增主键的 id 分配：一律 `max(id)+1`，无并发保护（并发新增可撞主键）」一致（该条目已把 `backend/app/services/ai_question_service.py:378`/`:674` 列为证据之一）。同一模式亦见 `backend/app/services/admin_service.py:175-176`、`backend/app/services/import_service.py:293-295`。**并发冲突路径未实测**（冒烟为单线程串行）。
2. **`import_drafts` 无草稿级并发保护**：`:641` 的 `IN` 查询不加行锁，`status='approved'` 的判定与 `status='imported'` 的回写之间没有原子性保证；`questions.question` 无唯一约束（`docker/init/001_schema.sql:16-24`），故两个管理员并发导入同一草稿理论上可产生重复题干并互相覆盖 `question_id`（本文件 `:679-680`）。属代码层面推断，**未实测**，管理端单人操作场景下概率极低。
3. **`update_draft` 的 `actor` 参数未被使用**（`:588` 声明，`:590-606` 函数体无引用）：草稿编辑不记录操作人；对应路由 `PUT /api/admin/ai/drafts/{draft_id}` 也不写审计（`backend/app/api/routes/ai_admin.py:285-291`），`PATCH .../status` 同样不写审计（`:306-312`），审核环节仅靠 `reviewed_by`/`reviewed_at`（本文件 `:625-626`）留痕。对比 `import_drafts` 有 `ai.draft.import` 审计——留痕强度不一致，现状记录。
4. **`update_draft` 的查重只比库内、不比同任务其他草稿**（`:599-601` 传空 `seen`）：把同一任务内两条草稿改成相同题干不会被标记重复，要到导入阶段才被拦（`:665-668`）。
5. **错误码不一致**：「任务不存在」→ **404**（`backend/app/api/routes/ai_admin.py:252-253`），「草稿不存在」→ **400**（`:288-290`、`:309-311` 把 `ValueError` 一律转 400）。
6. **草稿排序方向相反**：`list_drafts` 按 `id DESC`（`:573`），`get_job` 附带的草稿按 `id ASC`（`:557`）——同一批草稿在列表页与任务详情里顺序相反。
7. **`DRAFT_STATUSES`（`:395`）是死常量**：全仓无引用（grep 仅命中定义行）。同时 `AiGenerationJob.status` 的 `pending`/`running` 两值（`backend/app/models/models.py:613`）在当前**同步**实现下不会落库：`run_job` 只在 `:498`/`:506`/`:531` 三处 commit，此时 status 已是 `failed`/`success`/`partial`；`:483` 的 `"running"` 仅存在于未提交事务内。无异步任务队列，故 `GET /api/admin/ai/jobs` 永远看不到 `running` 行。
8. **`run_job` 的异常兜底只覆盖生成阶段**（`:489-499`）：`_build_drafts` 与草稿写入（`:511-518`）不在 `try` 内；若此处抛异常（如 DB 故障），事务随会话关闭被回滚（`get_db` 只 `close()`，`backend/app/core/database.py:58-64`），库里不会留下 `running` 僵尸行，但非 `ValueError`/`CloudBaseError` 的异常会冒泡成 500。
9. **AI 出题不受 AI 总开关与日限额约束、不写用量日志**：本文件不 import `ai_config_service`/`ai_usage_service`（`:19-22`），`generate_questions`/`run_job` 均无 `ensure_enabled`/`check_limits` 调用（对照 `backend/app/services/ai_chat_service.py:192`、`:198`、`:373`、`:374`）。因此管理端把 `ai_enabled` 关掉后，出题接口仍会真实调用 Agent 并产生费用；出题次数也不计入 `ai_usage_logs`（`backend/app/models/models.py:663` 注释里的 `question_gen` 取值全仓无写入点）。这与 `backend/app/core/config.py:83` 注释「AI 总开关；关闭后所有 AI 接口返回明确提示」不一致（`backend/app/services/ai_config_service.py:22-25` 的 docstring 口径更窄、与代码一致）。是有意设计还是遗漏——**待确认**。
10. **出题链路的超时/重试用 env 值，配置中心改不动**：`_generate_batch` 调 `cloudbase_service.prompt`（`:204-206`）→ `prompt_meta(text, timeout=None)`（`backend/app/services/cloudbase_service.py:223-228`）→ `timeout = settings.CLOUDBASE_TIMEOUT_SECONDS`（180 秒）、`max_retries = settings.AI_MAX_RETRIES`（`backend/app/services/cloudbase_service.py:207-208`）。管理端改 `ai_request_timeout`/`ai_max_retries` 对出题无效（这两项不在 `backend/app/services/ai_config_service.py:45-55` 的出题相关范围内——`AI_QUESTION_*` 三项也不在 `_SPEC` 中）。单批最坏耗时 ≈ `(1 + AI_MAX_RETRIES) × CLOUDBASE_TIMEOUT_SECONDS`，再叠加批数（⌈count/10⌉）与并发 3。admin 前端因此设 `timeout: 0`（`admin/src/api/admin.ts:695-703`，注释原文「耗时可达分钟级：不设前端超时（timeout: 0），由用户通过 signal 主动取消」，`:699` 即 `timeout: 0`）。
11. **客户端中断不终止服务端生成**：本文件无任何取消检查点，线程池（`:225-237`）会跑完全部批次；前端 `AbortController` 只断开 HTTP 连接，Agent 调用与费用照常发生。
12. **查重集合每次全表加载**：`_existing_question_texts`（`:182-185`）把全部启用题干读进内存建集合，`generate_questions`（`:254`）、`batch_save_questions`（`:358`）、`import_drafts`（`:643`）各调一次，`update_draft` 每次编辑也调一次（`:600`）。当前题库量级（开发库数十题）无压力；题干为 `TEXT` 列，题量增长后属线性内存/IO 开销（对照根 `agents.md` §2.4「避免全量拉取」）。**未做批量/分页优化**。
13. `run_job` 的 `params.knowledge_ids` 过滤用 `str(k).strip().isdigit()`（`:480`），而 `_references_from_knowledge` 用 `int()` + try/except（`:401-405`），两者对负数 ID 口径不同；因 schema 已声明 `List[int]`（`backend/app/schemas/schemas.py:1792`）且负数 ID 匹配不到任何行，实际无影响。
14. `docs/迭代记录.md` 提交 `ea58b6c` 条目把保存接口写作 `POST /api/admin/questions/batch-ai`，与代码实际路径 `POST /api/admin/ai/questions/batch-save`（`backend/app/api/routes/admin.py:524-525`）不符；**以代码为准**（`.qoder/README.md` 卷首约定）。

### 待开发

- 独立的「题目工坊」管理页（`.qoder/ARCHITECTURE.md` §11.3、`.qoder/REQUIREMENTS.md` §10.6）：工坊 7 个端点已就绪但无前端调用方（§6.2）；`ai_workshop` 菜单码只落库（`docker/init/022_ai_admin_menus.sql`），`admin/src/router/menus.ts` 未登记。
- 出题用量/成本纳入 `ai_usage_logs` 与统计页（§9 第 9 条）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/services/ai_question_service.py`（**2 个提交**）与 `docs/迭代记录.md` 对应条目，按时间倒序。

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
