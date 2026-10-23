# ai_admin.py

## 1. 文件路径

`backend/app/api/routes/ai_admin.py`（381 行，`wc -l` 实测）

## 2. 文件职责

管理后台侧「AI 智能中心」的 HTTP 路由层，共 **15 个端点**，`APIRouter(prefix="/admin/ai", tags=["admin-ai"])`（`:43`），经 `backend/app/main.py:124`（import 在 `:23`，路由 import 块自 `:19` 起）以 `settings.API_PREFIX`（默认 `/api`，`backend/app/core/config.py:27`）挂载，注册在 `admin.router`（`:123`）之后，对外全部为 `/api/admin/ai/*`。分三组：知识库维护（6）、题目工坊（7）、配置中心（2）。

契约面向 admin 前端（Vue3 + TS），**字段 snake_case**（模块 docstring `:3`）：本文件的 14 个 `response_model` 是普通 `BaseModel` 的 `Admin*` 系列（`backend/app/schemas/schemas.py:1860-2007`），唯一例外是 `DELETE /knowledge/{kid}` 复用了 `CamelModel` 的 `MessageOut`（`:781`，因只有单词字段 `message` 故输出无差异）。

> **行号对照（2026-10-22 按当前源码核定；§4.1/§4.2/§4.3/§5.1/§6.3/§8 的表格与正文已逐处重标为「新」列，本块只作旧文档/旧提交的溯源用）**：`schemas.py` 旧→新 —— `MessageOut` 728→**781**、1707→**1860**（`AdminAiKnowledgeUpsert`）、1719→**1872**（`AdminAiKnowledgeOut`）、1735→**1888**（`AdminAiKnowledgeListOut`）、1744→**1897**（`AdminAiConfigValues`）、1758→**1911**（`AdminAiConfigPatchRequest`）、1772→**1925**（`AdminAiConfigOut`）、1783→**1936**（`AdminAiJobCreateRequest`）、1795→**1948**（`AdminAiDraftOut`）、1809→**1962**（`AdminAiJobOut`）、1825→**1978**（`AdminAiJobListOut`）、1830→**1983**（`AdminAiDraftListOut`）、1835→**1988**（`AdminAiDraftUpdateRequest`）、1841→**1994**（`AdminAiDraftStatusRequest`）、1845→**1998**（`AdminAiImportRequest`）、1849→**2002**（`AdminAiImportFailure`）、1854→**2007**（`AdminAiImportOut`）；`models.py` 旧→新（`b0ed585` 新增 `Chapter` 使非 AI 段整体 +19、AI 段 +23）—— 98-105→**117-124**（`SystemSetting`）、126→**145**（`Question`）、540-570/555→**563**（`AiKnowledge`，`id` 列在 **`:578`**）、旧 `:546`「空串按 NULL 存储」docstring→**`:569`**、610-631/613→**633**（`AiGenerationJob`）、634-657/637→**657**（`AiGeneratedQuestion`）、660→**683**（`AiUsageLog` 类）、旧 `:668`→**`:693`**（`__tablename__ = "ai_usage_logs"`）。

安全约定（模块 docstring `:4-6`，逐条已在代码中核实）：每个端点都用 `require_menu` 在**后端**校验菜单权限（§4.1）；配置接口只读写 AI 运行参数与提示词、**不返回任何明文密钥**（§7.5）；敏感/不可逆操作写 `audit_logs` 且**与业务同事务提交**（§7.6）。

## 3. 业务需求

对应《长征步迹 AI 智能中心开发需求 V1.0》§3.4「管理端接口」与题目工坊持久化改造，2026-10-17 以 **Phase A** 交付（提交 `1600074`）。

> **需求文档本身未入库**（`docs/` 下无该文件），条目内容以 `docs/迭代记录.md` 的 `1600074` 条目与 `backend/test/docs/s26-ai-center-report.md` 转述为准，**原始需求文本待确认**。

**当前状态是「后端就绪、管理端无入口」的预期待开发状态，不是缺陷**：`.qoder/PROJECT.md` §7「管理后台（11 菜单）」、`.qoder/ARCHITECTURE.md` §11.3、`.qoder/REQUIREMENTS.md` §10.1「菜单码」行与 §10.6「知识库 / 配置 / 题目工坊」行一致记载 —— `docker/init/022_ai_admin_menus.sql` 已向 `admin_menus` 注入 5 个 `ai_*` 菜单码，但 `admin/src/router/menus.ts`（2026-10-22 实测全文 40 行：`MENUS` **16 个** code + `MENU_GROUPS` 5 个一级分组，`dashboard` 未入任何分组故平铺）**一个 `ai_*` 都没有**，故管理后台侧边栏无 AI 智能中心入口、`admin/src/api/admin.ts` 也无本文件 15 个端点的任何调用方（grep 核实见 §6.2）。上引 `.qoder/PROJECT.md` §7「管理后台（11 菜单）」与 `.qoder/ARCHITECTURE.md` §1.2 框图的「11 菜单」均已滞后，该缺口已登记于 `.qoder/PROJECT.md` §8 文档滞后项，本文件以实测 16 项为准。

## 4. 核心功能

### 4.1 端点清单（15 个，`app.openapi()` 实测复核见 §9）

| # | 方法 | 完整路径（含路径参数） | 函数名 | 装饰器行 | 函数行 | `require_menu` 码（行号） | `response_model` |
|---|---|---|---|---|---|---|---|
| 1 | `GET` | `/api/admin/ai/knowledge` | `list_knowledge` | `:76-81` | `:82-94` | `ai_knowledge`（`:80`） | `AdminAiKnowledgeListOut`（`backend/app/schemas/schemas.py:1888`） |
| 2 | `POST` | `/api/admin/ai/knowledge` | `create_knowledge` | `:97-102` | `:103-116` | `ai_knowledge`（`:101` + `:105`） | `AdminAiKnowledgeOut`（`schemas.py:1872`） |
| 3 | `GET` | `/api/admin/ai/knowledge/{kid}` | `get_knowledge` | `:119-124` | `:125-129` | `ai_knowledge`（`:123`） | `AdminAiKnowledgeOut` |
| 4 | `PUT` | `/api/admin/ai/knowledge/{kid}` | `update_knowledge` | `:132-137` | `:138-152` | `ai_knowledge`（`:136` + `:141`） | `AdminAiKnowledgeOut` |
| 5 | `PATCH` | `/api/admin/ai/knowledge/{kid}/status` | `set_knowledge_status` | `:155-160` | `:161-175` | `ai_knowledge`（`:159` + `:164`） | `AdminAiKnowledgeOut` |
| 6 | `DELETE` | `/api/admin/ai/knowledge/{kid}` | `delete_knowledge` | `:178-183` | `:184-196` | `ai_knowledge`（`:182` + `:186`） | `MessageOut`（`schemas.py:781`，`CamelModel`） |
| 7 | `POST` | `/api/admin/ai/jobs` | `run_job` | `:200-205` | `:206-225` | `ai_workshop`（`:204` + `:208`） | `AdminAiJobOut`（`schemas.py:1962`） |
| 8 | `GET` | `/api/admin/ai/jobs` | `list_jobs` | `:228-233` | `:234-240` | `ai_workshop`（`:232`） | `AdminAiJobListOut`（`schemas.py:1978`） |
| 9 | `GET` | `/api/admin/ai/jobs/{job_id}` | `get_job` | `:243-248` | `:249-253` | `ai_workshop`（`:247`） | `AdminAiJobOut` |
| 10 | `GET` | `/api/admin/ai/drafts` | `list_drafts` | `:256-261` | `:262-270` | `ai_workshop`（`:260`） | `AdminAiDraftListOut`（`schemas.py:1983`） |
| 11 | `PUT` | `/api/admin/ai/drafts/{draft_id}` | `update_draft` | `:273-278` | `:279-291` | `ai_workshop`（`:277` + `:282`） | `AdminAiDraftOut`（`schemas.py:1948`） |
| 12 | `PATCH` | `/api/admin/ai/drafts/{draft_id}/status` | `set_draft_status` | `:294-299` | `:300-312` | `ai_workshop`（`:298` + `:303`） | `AdminAiDraftOut` |
| 13 | `POST` | `/api/admin/ai/drafts/import` | `import_drafts` | `:315-320` | `:321-338` | `ai_workshop`（`:319` + `:323`） | `AdminAiImportOut`（`schemas.py:2007`） |
| 14 | `GET` | `/api/admin/ai/config` | `get_config` | `:342-347` | `:348-349` | `ai_config`（`:346`） | `AdminAiConfigOut`（`schemas.py:1925`） |
| 15 | `PATCH` | `/api/admin/ai/config` | `patch_config` | `:352-357` | `:358-381` | `ai_config`（`:356` + `:360`） | `AdminAiConfigOut` |

**菜单码统计**：`ai_knowledge` 6 个（#1–#6）、`ai_workshop` 7 个（#7–#13）、`ai_config` 2 个（#14–#15），合计 **15**。文件中出现的 `require_menu` 字符串**只有这 3 个**（`grep -n 'require_menu("' backend/app/api/routes/ai_admin.py` 共 24 处命中，全部为这 3 码）。

**与 `docker/init/022_ai_admin_menus.sql` 的 5 个 seed 码对照**：

| seed 码 | SQL 行 | 菜单名 | `sort_order` | 本文件是否使用 |
|---|---|---|---|---|
| `ai_overview` | `:14-16` | AI运行概览 | 10 | **未使用**（无任何路由） |
| `ai_knowledge` | `:17-19` | AI知识库 | 11 | ✅ 6 个端点 |
| `ai_workshop` | `:20-22` | AI题目工坊 | 12 | ✅ 7 个端点 |
| `ai_logs` | `:23-25` | AI调用记录 | 13 | **未使用**（无任何路由） |
| `ai_config` | `:26-28` | AI配置中心 | 14 | ✅ 2 个端点 |

> `ai_logs` 不只是「本文件未用」：**全后端没有任何读取 `ai_usage_logs` 的端点**（`grep -rn "AiUsageLog\|ai_usage_logs" backend/app --include=*.py` 只命中 `backend/app/models/models.py:683`/`:693` 与 `backend/app/services/ai_usage_service.py:3`/`:14`/`:27`/`:28`/`:31`/`:56`/`:58`，均为写入与限额计数）。`ai_overview` 同样无任何后端支撑。因此 `.qoder/REQUIREMENTS.md` §10.1「后台 AI 接口」行与 `.qoder/ARCHITECTURE.md` §11.2 把「调用记录」列入 `/api/admin/ai/*` 已交付范围，与代码不符（见 §9「文档与代码不一致」）。
>
> `sort_order` 重号问题（`ai_overview`=10 与 `invites`=10、`ai_knowledge`=11 与 `activity`=11）已由 `.qoder/PROJECT.md` §8 第 26 条记录，2026-10-17 经用户决定**只记录不修改**。

**双重 `require_menu` 声明**：9 个写端点（#2/#4/#5/#6/#7/#11/#12/#13/#15）同时在 `dependencies=[Depends(require_menu(code))]` 与 `admin: AdminPrincipal = Depends(require_menu(code))` 各写一次；6 个只读端点（#1/#3/#8/#9/#10/#14）只用 `dependencies=[...]`、不取 `admin` 参数。由于 `require_menu(code)` 每次调用都返回**新的闭包对象**（`backend/app/api/deps.py:150-160`），FastAPI 以 callable 为依赖缓存键，两个 `_check` 都会执行；但其内部的 `get_current_admin` 与 `get_db` 是同一函数对象 → **每请求各只执行一次**，故净开销仅是一次多余的 `has_menu` 判断，**不产生额外查库**。属可简化的冗余写法（§8.6）。

### 4.2 模块级辅助

- **`_PROMPT_KEYS`（`:45`）**：`{"chat": "ai_prompt_chat", "route": "ai_prompt_route", "quiz": "ai_prompt_quiz"}`，供 `patch_config` 做提示词类型白名单与键名映射（`:369-371`）。**与 `backend/app/services/ai_config_service.py:92-96` 的同名常量内容完全相同**，属跨模块重复定义（§9「存在问题」第 4 条）。
- **`_audit(db, admin, action, detail)`（`:48-53`）**：写审计**但不提交**（`:49` docstring）。操作人映射：超管 → `("super", None)`，微信关联管理员 → `("user", admin.user_id)`（`:50`）；`target_user_id` 恒传 `None`（`:52` 第 4 个位置参数）；`detail` 恒注入 `{"operator": admin.username, **detail}`（`:52`）。底层 `audit_service.record`（`backend/app/services/audit_service.py:14-36`）只 `db.add`，docstring `:3-4` 明确「调用方在同一事务内完成业务变更与审计写入后统一 commit」。
- **`_knowledge_out(r: AiKnowledge)`（`:56-72`）**：ORM → 契约 dict，键为 snake_case，与 `AdminAiKnowledgeOut`（`schemas.py:1872-1887`）字段一一对应。可空文本列统一回退空值（`source or ""` `:63`、`category or ""` `:65`、`created_by or ""` `:67`、`reviewed_by or ""` `:68`、`related or []` `:64`），`:57` docstring 说明理由「本库空串按 NULL 存储」（openGauss Oracle 兼容模式，另见 `backend/app/models/models.py:569`）。

### 4.3 知识库维护（6 个端点 → `ai_knowledge_service` → 表 `ai_knowledge`）

| 端点 | service 函数 | 关键行为 |
|---|---|---|
| `GET /knowledge`（`:82-94`） | `list_knowledge`（`backend/app/services/ai_knowledge_service.py:105-135`） | 分页 + 4 个筛选；按 `updated_at desc, id desc`（`:130`）；返回 `{"total", "items"}`，items 逐条过 `_knowledge_out`（`:94`） |
| `POST /knowledge`（`:103-116`） | `create_knowledge`（`ai_knowledge_service.py:142-150`） | `_validate` 后建行，`created_by = admin.username`（`:109`、`ai_knowledge_service.py:144`）；若 `status='published'` 则同时写 `published_at` 与 `reviewed_by`（`:145-147`）。**id 由 DB `SERIAL` 分配**（`docker/init/021_ai_center.sql:12`、`backend/app/models/models.py:578`），**不走 `max(id)+1`** |
| `GET /knowledge/{kid}`（`:125-129`） | `get_knowledge`（`ai_knowledge_service.py:138-139`） | service 返回 `Optional`，路由自行判空 → **404「知识资料不存在」**（`:127-128`） |
| `PUT /knowledge/{kid}`（`:138-152`） | `update_knowledge`（`ai_knowledge_service.py:153-166`） | 整条替换（`setattr` 循环 `:159-160`）；**首次**转 published 才写 `published_at`/`reviewed_by`（`was_published` 判定 `:158`、`:161-163`）；`updated_at` 每次刷新（`:164`） |
| `PATCH /knowledge/{kid}/status`（`:161-175`） | `set_status`（`ai_knowledge_service.py:169-182`） | 状态流转：`draft`/`pending`/`published`/`rejected`/`archived`（`ALLOWED_STATUS`，`ai_knowledge_service.py:20`）；转 published 写 `published_at`+`reviewed_by`（`:177-179`） |
| `DELETE /knowledge/{kid}`（`:184-196`） | `delete_knowledge`（`ai_knowledge_service.py:185-190`） | **物理删除**（`db.delete(row)` `:189`），非软删/归档；返回 `{"message": "已删除"}`（`:196`） |

`GET /knowledge` 的 Query 参数（`:83-88`）：`page`（`ge=1`，默认 1）、`page_size`（`ge=1, le=100`，默认 20）、`keyword`（`max_length=64`，默认 `""`，`:85` description「按标题/正文模糊搜索」）、`status`（`max_length=16`，默认 `""`）、`category`（`max_length=20`，默认 `""`）、`node_id`（`Optional[int]`，默认 `None`）。`status`/`category` **不做枚举校验**，直接进 `filter`（`ai_knowledge_service.py:116-121`），传非法值只会返回空列表而非 400。

`POST`/`PUT` 请求体 `AdminAiKnowledgeUpsert`（`schemas.py:1860-1869`）：`title`（`min_length=1, max_length=200`）、`content`（`min_length=1`）、`source`（默认 `""`，`max_length=300`）、`related`（`List[str]`，默认 `[]`）、`category`（默认 `""`）、`node_id`（`Optional[int]`）、`status`（默认 `"draft"`）。service 侧 `_validate`（`ai_knowledge_service.py:53-102`）再校验一轮：标题/正文非空且标题 ≤200、来源 ≤300、`category ∈ event/route/figure/custom`（`ALLOWED_CATEGORIES` `:21`）、`related` 最多 10 条（`RELATED_MAX` `:24`、`:75`）、**`node_id` 非空时必须存在于 `route_nodes`**（`:87-88`，否则「绑定的路线节点不存在」）、`status ∈ ALLOWED_STATUS`。

### 4.4 题目工坊（7 个端点 → `ai_question_service` → 表 `ai_generation_jobs` / `ai_generated_questions`）

模块 docstring `:199` 标注为「持久化任务 / 草稿 / 导入」，与 `backend/app/services/ai_question_service.py:395-398` 的注释对应：**一次生成落一条 `ai_generation_jobs`，每道草稿落一条 `ai_generated_questions`**，区别于旧的内存态链路（§6.4）。

**#7 `POST /jobs`（`:206-225`，`run_job`）** —— 请求体 `AdminAiJobCreateRequest`（`schemas.py:1936-1945`）：`topic`（`min_length=1, max_length=100`）、`count`（默认 10，`ge=1, le=100`）、`question_type`（默认 `"single"`）、`difficulty`（默认 `"medium"`）、`category`（默认 `""`）、`extra_requirements`（默认 `""`，`max_length=300`）、`knowledge_ids`（`List[int]`，默认 `[]`，非空时以这些**已发布**资料为参考资料接地出题）。路由把 7 个字段按位置传给 `ai_question_service.run_job`（`:213-223`，定义 `ai_question_service.py:456-539`）：

1. `_validate_params`（`ai_question_service.py:279-306`）：主题非空 ≤100；`question_type` 必须 ∈ `SUPPORTED_TYPES = ("single",)`（`:28`，否则「AI 出题目前仅支持单选题（single）」）；`difficulty ∈ easy/medium/hard/mixed`（`:29`）；`category ∈ event/route/figure` 或留空（`:30`）；补充要求 ≤300；`1 ≤ count ≤ settings.AI_QUESTION_MAX_COUNT`（默认 100，`backend/app/core/config.py:98`）。
2. `_references_from_knowledge`（`:402-419`）：只取 `status='published'` 的资料（`:414`），保持传入顺序（`:417-418`），非 int 与未发布的 id **静默忽略**。
3. 建 `AiGenerationJob(job_type="question", status="running", created_by=admin.username, params={...})` 并 `db.flush()`（`:475-491`）；`params` 存生成参数快照（含过滤后的 `knowledge_ids`，`:484`）。
4. `_split_batches`（`:51-57`）按 `AI_QUESTION_BATCH_SIZE` 拆批（代码默认 10，`backend/app/core/config.py:96`；但两套环境均配置为 **5** —— `backend/.env:65`、`backend/.env.prod:79`，**生效批大小为 5**）→ `_run_batches`（`:214-253`）用 `ThreadPoolExecutor(max_workers=min(len(batches), AI_QUESTION_MAX_CONCURRENCY=3))` 并发生成（`:227-235`）。**线程内只调 `llm_service.prompt`、不碰 DB session**（`_generate_batch` `:204-211`，提示调用在 `:208`；未显式传 timeout → 共用 `LLM_TIMEOUT_SECONDS=300`，`backend/app/core/config.py:73`），故无 session 跨线程问题；但整个生成期间持有同一个 DB 会话（长事务）。单批失败不中断整体，只记 `batch_errors`（`:240-251`）。
5. 全部失败：`status='failed'` + `error` 截 500 字 + `finished_at` + **`db.commit()`**，再抛原始异常（`:498-503` 网络异常路径、`:505-513` 无返回路径），以便路由区分 502/400。
6. 成功：草稿逐条落 `AiGeneratedQuestion(status="pending")`（`:515-522`）；`job.succeeded/failed/status` 置 `success`|`partial`（`:524-532`）；`job_view` **在 commit 前构建**（`:534`，注释「规避 commit 后属性过期再查」）；`db.commit()`（`:535`）。
7. **commit 归属：service 层**（`ai_question_service.py:502`/`:510`/`:535`），路由 `run_job` **不 commit、不 rollback、不写审计** —— `:211` docstring 说明理由「任务记录本身即操作留痕（含 `created_by`/`params`/时间）」。

**#8 `GET /jobs`（`:234-240`）**：`page`/`page_size`（`:235-236`，同上默认与上限），调 `list_jobs`（`ai_question_service.py:542-551`），按 `created_at desc, id desc`；返回的 `job_view` **不含 drafts**（`:551` 未传第二参）。**无 `created_by` 过滤** —— 任何持 `ai_workshop` 的管理员都能看到全部人的任务。

**#9 `GET /jobs/{job_id}`（`:249-253`）**：调 `get_job`（`ai_question_service.py:554-564`），任务不存在 → `ValueError("任务不存在")` → 路由 **404**（`:252-253`）；返回**含全部草稿**（按 `id asc`，`:558-563`）。

**#10 `GET /drafts`（`:262-270`）**：Query `job_id`（`Optional[int]`）、`status`（`max_length=16`，默认 `""`，**不枚举校验**）、`page`（`ge=1`，默认 1）、`page_size`（**`ge=1, le=200`，默认 50**，`:266` —— 与本文件其余列表的 20/100 不同）。调 `list_drafts`（`ai_question_service.py:567-582`），按 `id desc`。

**#11 `PUT /drafts/{draft_id}`（`:279-291`，`update_draft`）**：请求体 `AdminAiDraftUpdateRequest`（`schemas.py:1988`）只有一个字段 `data: Dict[str, Any]` —— **完全自由的 JSON，无结构化 schema**。调 `ai_question_service.update_draft`（`:592-610`）：草稿不存在 → `ValueError("草稿不存在")` → 路由 **400**（`:288-290`，非 404）；`status == 'imported'` → 「已导入题库的题目不能再修改」（`:595-596`）；重算 `errors` = `admin_service._validate_question` 的结构校验（`:600-602`，定义 `backend/app/services/admin_service.py:208-233`）+ 与**当前题库**的题干查重（`:603-605`，`seen` 传空集故只做库内查重、不做草稿间查重）；若原状态为 `approved`/`rejected` 则**回退为 `pending`**（`:607-608`）。**路由 commit**（`:287`）/ rollback（`:289`），**无审计**。

**#12 `PATCH /drafts/{draft_id}/status`（`:300-312`，`set_draft_status`）**：请求体 `AdminAiDraftStatusRequest`（`schemas.py:1994`，`status: str`，**schema 层无枚举约束**）。调 `ai_question_service.set_draft_status`（`:613-632`）：`status` 必须 ∈ `("approved","rejected","pending")`，否则「草稿状态非法」→ **400**（`:615-616`）——**`imported` 不在可设列表内**，只能由 #13 导入时自动置位；已 `imported` 的草稿不可改状态（`:618-619`）；置 `approved` 前**重新做结构校验**，失败则「题目仍有问题，无法通过：{原因}」（`:620-625`）并清空 `errors`（`:626-627`）；写 `reviewed_by = admin.username`、`reviewed_at = now_utc()`（`:629-630`）。**路由 commit**（`:308`），**无审计**。

**#13 `POST /drafts/import`（`:321-338`，`import_drafts`）** —— 请求体 `AdminAiImportRequest`（`schemas.py:1998`，`draft_ids: List[int] = Field(min_length=1)`）。调 `ai_question_service.import_drafts(db, payload.draft_ids, admin.username)`（`:327`，定义 `ai_question_service.py:635-699`）：

- 空列表 → `ValueError`（`:641`，实际会先被 schema 的 `min_length=1` 拦为 422）；超过 `AI_QUESTION_MAX_COUNT` → `ValueError`（`:642-643`）→ 400。
- 一次查询取全部草稿并建 `by_id` 映射（`:645-646`），**无 N+1**。
- 逐条判定（`:652-674`）：不存在 → `failures`「草稿不存在」；`status == 'imported'` → **`skipped += 1`（幂等核心）**；`status != 'approved'` → `failures`「只有审核通过的草稿才能导入」；再过 `admin_service._validate_question`；再做题干查重（库内 + 本批内，`:669-672`）。**单条失败不阻断其他条目**。
- **id 分配方式（重点核实结论）**：走 `base_id = db.query(func.max(Question.id)).scalar() or 0`（**`backend/app/services/ai_question_service.py:678`**），再 `Question(id=base_id + offset, **data)`（`:682`）。原因是 `questions.id` 为 `INTEGER PRIMARY KEY` **无 SERIAL/自增**（`docker/init/001_schema.sql:17`，种子占用固定 id），与 `backend/app/services/ai_question_service.py:381` 注释一致。**不是** `ai_question_service.py:382`（那是旧内存态 `batch_save_questions` 的分配点），也不是 `backend/app/services/import_service.py:293`（Excel 导入确认）。
- 写库后 `db.flush()` **不提交**（`:687`，注释「由路由连同审计日志一起 commit，保证原子落库」）；导入成功的草稿置 `status='imported'`、回填 `question_id`、`reviewed_by` 保留原值否则填 actor、`reviewed_at = now_utc()`（`:683-686`）。
- **事务边界：路由层 commit**（`ai_admin.py:334`）/ rollback（`:336`），审计 `_audit(db, admin, "ai.draft.import", {imported, skipped, failed})`（`:328-333`）在同事务内 → **「题目入库 + 审计」原子落库**。
- 返回 `AdminAiImportOut`（`schemas.py:2007`）：`imported`/`skipped`/`failed`/`failures[{id, reason}]`（`failures` 元素为 `AdminAiImportFailure`，`schemas.py:2002`）。

### 4.5 配置中心（2 个端点 → `ai_config_service` → 表 `system_settings`）

**#14 `GET /config`（`:348-349`）**：直接 `return ai_config_service.get_config_view(db)`（定义 `backend/app/services/ai_config_service.py:153-183`）。**无 try/except、无 commit、不取 `admin` 参数**（只有 `dependencies=[Depends(require_menu("ai_config"))]` `:346`）。响应 `AdminAiConfigOut`（`schemas.py:1925`）六段：

| 字段 | 内容 | 键命名 |
|---|---|---|
| `values` | 生效值（DB 覆盖 > env 默认，合并逻辑 `ai_config_service.py:112-123`） | **短名**：`enabled`/`chat_daily_limit`/… |
| `defaults` | env 初始默认（`_SPEC` 的 lambda 延迟取值，`:168`） | **短名** |
| `ranges` | 每项 `{min, max, type: bool|int}`（`:169-172`） | **setting_key**：`ai_enabled`/… |
| `prompts` | `chat`/`route`/`quiz` 三类提示词当前生效文本（`:173`） | 短名 |
| `prompt_version` | 版本号（默认 `"v1"`，`:17`、`:146-150`） | — |
| `overridden` | 当前被 DB 覆盖的项（`:176-182`） | **setting_key** |

> `values`/`defaults` 用短名而 `ranges`/`overridden` 用 `ai_*` setting_key，是**刻意的键命名不对称**，前端做「已自定义」标记时须按 `ranges`/`overridden` 的键去索引，不能直接用 `values` 的键。

**#15 `PATCH /config`（`:358-381`，`patch_config`）** —— 请求体 `AdminAiConfigPatchRequest`（`schemas.py:1911`）：`values: Optional[AdminAiConfigValues]`（9 个逐项可选字段，`schemas.py:1897`）、`prompts: Optional[Dict[str, str]]`、`prompt_version: Optional[str]`。**路由自己组装 `updates` 字典**（`:363-373`）：

- `payload.values.model_dump(exclude_none=True)` 后逐键加 `ai_` 前缀（`:365-366`）。用 `exclude_none` 而非 `exclude_unset` → **`enabled=false`、`0` 等假值会被保留**，未传字段被丢弃。
- `payload.prompts` 非空时（`:367`）逐个 `kind` 校验白名单 `_PROMPT_KEYS`，未知 kind → **路由直接抛 400「未知提示词类型：{kind}」**（`:369-370`），映射到 `ai_prompt_chat`/`ai_prompt_route`/`ai_prompt_quiz`（`:371`）。
- `payload.prompt_version is not None` → `updates["ai_prompt_version"]`（`:372-373`）。
- 三项全空 → `updates` 为空 → service 抛 `ValueError("没有需要更新的配置")`（`ai_config_service.py:192-193`）→ 400。
- service `patch_config`（`ai_config_service.py:186-224`）再做**白名单 + 类型 + 范围**校验：`_BY_KEY` 内的 9 个运行参数（布尔必须传 bool `:197-200`；整数按 `_SPEC` 的 min/max 夹验，越界直接 `ValueError` 而非静默夹取 `:202-207`）、3 个提示词键（长度 ≤ `PROMPT_MAX_LEN=4000` `:209-213`）、`ai_prompt_version`（≤32 字 `:214-218`），其余键一律「不支持的配置项：{key}」（`:219-220`）。写入走 `setting_service.set_value`（`backend/app/services/setting_service.py:15-22`，upsert 到 `system_settings`）；末尾 `db.flush()`（`:223`，注释说明因 `SessionLocal` 的 `autoflush=False` 需显式 flush 才能让随后的 `get_config_view` 读到新值）后返回**最新生效视图**（`:224`），故 PATCH 响应即为新值、前端无需二次刷新。
- 审计 `_audit(db, admin, "ai.config.patch", {"keys": sorted(updates.keys())})`（`:376`）—— **只记键名、不记值**，提示词正文与配置值都不入 `audit_logs`。**路由 commit**（`:377`）/ rollback（`:379`）。

## 5. 输入与输出

### 5.1 输出字段（snake_case，普通 `BaseModel`）

| `response_model` | 定义行 | 字段 |
|---|---|---|
| `AdminAiKnowledgeOut` | `schemas.py:1872` | `id`、`title`、`content`、`source`、`related[]`、`category`、`node_id`、`status`、`created_by`、`reviewed_by`、`created_at`、`updated_at`、`published_at` |
| `AdminAiKnowledgeListOut` | `schemas.py:1888` | `total`、`items[]` |
| `AdminAiJobOut` | `schemas.py:1962` | `id`、`job_type`、`topic`、`params{}`、`requested`、`succeeded`、`failed`、`status`、`error`、`created_by`、`created_at`、`finished_at`、`drafts[]` |
| `AdminAiJobListOut` | `schemas.py:1978` | `total`、`items[]` |
| `AdminAiDraftOut` | `schemas.py:1948` | `id`、`job_id`、`data{}`、`errors[]`、`status`、`question_id`、`reviewed_by`、`reviewed_at`、`created_at` |
| `AdminAiDraftListOut` | `schemas.py:1983` | `total`、`items[]` |
| `AdminAiImportOut` | `schemas.py:2007` | `imported`、`skipped`、`failed`、`failures[{id, reason}]` |
| `AdminAiConfigOut` | `schemas.py:1925` | `values`、`defaults{}`、`ranges{}`、`prompts{}`、`prompt_version`、`overridden[]` |
| `MessageOut` | `schemas.py:781` | `message`（固定 `"已删除"`） |

`status` 取值域：`ai_knowledge.status ∈ draft/pending/published/rejected/archived`（`ai_knowledge_service.py:20`）；`ai_generation_jobs.status ∈ pending/running/success/partial/failed`（`backend/app/models/models.py:633`）；`ai_generated_questions.status ∈ pending/approved/rejected/imported`（`DRAFT_STATUSES`，`ai_question_service.py:399`；`models.py:657`）。

**无统一响应包裹层**：2xx 直接是上表结构，错误为 FastAPI 默认 `{"detail": ...}`。管理后台 `admin/src/api/request.ts:27-51` 的成功拦截器**原样返回整个 `AxiosResponse`**（`:28` 即 `(response) => response,`），`admin/src/api/admin.ts` 不拆包，由各视图调用方自行取 `.data`（`.qoder/ARCHITECTURE.md` §4.1，该节已于 2026-10-17 更正原「直接返回 `response.data`」的误述）。

### 5.2 错误码矩阵

| 场景 | 状态码 | 出处 |
|---|---|---|
| 无 token / token 无效 / `role != admin` / 管理员账号不存在 | **401** | `backend/app/api/deps.py:118-121`、`:123-126`、`:137-140` |
| 账号被停用（`typ=user` 的令牌） | **403** + `X-Account-Status: disabled` | `backend/app/api/deps.py:141` → `:46-53` |
| 无任何启用角色 / 后台权限被撤销 | **403**「后台访问权限已被撤销或禁用」 | `backend/app/api/deps.py:142-146` |
| 缺对应菜单码 | **403**「无该功能的访问权限」 | `backend/app/api/deps.py:154-157` |
| 知识资料不存在（`GET /knowledge/{kid}`） | **404** | `ai_admin.py:127-128` |
| 知识资料不存在（`PUT`/`PATCH status`/`DELETE`） | **400** | `ai_knowledge_service.py:156`/`:175`/`:188` → `ai_admin.py:149-151`/`:172-174`/`:193-195` |
| 出题任务不存在（`GET /jobs/{job_id}`） | **404** | `ai_admin.py:252-253` |
| 草稿不存在（`PUT`/`PATCH status`） | **400** | `ai_question_service.py:588` → `ai_admin.py:288-290`/`:309-311` |
| 知识/草稿字段校验失败、状态非法、已导入不可改、配置越界/未知键/空更新 | **400** | 各 service 抛 `ValueError`，路由 `except ValueError` 转换 |
| 未知提示词类型（`PATCH /config`） | **400**「未知提示词类型：{kind}」 | `ai_admin.py:369-370`（**路由内直接抛，不经 service**） |
| LLM 上游故障（仅 `POST /jobs`） | **502** | `ai_admin.py:224-225` → `backend/app/api/routes/ai.py:50-58`（`ai_http_error` 的 `LlmError` 分支 `:56-57`；`AI_ERRORS` 定义 `:42-47`） |
| 请求体 Pydantic 校验失败 | **422** | FastAPI 默认 |

> **404 与 400 的口径在本文件内不统一**：只读的 `GET /knowledge/{kid}` 与 `GET /jobs/{job_id}` 用 404，而 `PUT`/`PATCH`/`DELETE` 对同一种「资源不存在」用 400（因为它们复用 `except ValueError → 400`）。`.qoder/ARCHITECTURE.md` §4.3 记载「409 全项目未使用，冲突语义统一由 400 承载」，此处 400 承担资源不存在语义属同一取向，但前端做错误提示时须两种码都处理。
>
> `POST /jobs` 的 `except AI_ERRORS`（`:224`）在实践上**只可能命中 `LlmError`→502 与普通 `ValueError`→400 两个分支**：`AiDisabledError`（403）与 `AiLimitError`（429）不会在这条链上抛出，因为 `backend/app/services/ai_question_service.py` **既不 import `ai_usage_service`、也不调用 `ai_config_service.ensure_enabled`**（grep 核实，零命中）。模块 docstring `:7` 声明的四路映射对本文件而言是**部分不可达**的（§9）。

## 6. 依赖关系

### 6.1 import 清单（`:9-41`）

| 行 | 依赖 | 用途 |
|---|---|---|
| `:9` | `typing.Any/Dict/Optional` | 类型注解 |
| `:11` | `fastapi.APIRouter/Depends/HTTPException/Query` | 路由与协议层 |
| `:12` | `sqlalchemy.orm.Session` | 类型注解 |
| `:14` | `app.api.deps.AdminPrincipal`、`require_menu` | 管理端身份与菜单鉴权 |
| `:15` | **`app.api.routes.ai.ai_http_error`、`AI_ERRORS`** | 跨路由模块复用异常映射（见 §8.1） |
| `:16` | `app.core.database.get_db` | 会话注入 |
| `:17` | `app.models.models.AiKnowledge` | 仅用于 `_knowledge_out` 的类型注解（`:56`） |
| `:18-35` | `app.schemas.schemas` 的 16 个 `AdminAi*` + `MessageOut` | 请求/响应契约 |
| `:36-41` | `app.services`：`ai_config_service`、`ai_knowledge_service`、`ai_question_service`、`audit_service` | 业务实现与审计 |

### 6.2 被谁依赖

- `backend/app/main.py:23`（import，路由 import 块自 `:19` 起）、`:124`（`include_router`，**注册在 `admin.router`（`:123`）之后**）。
- **管理后台前端：零调用方。** `grep -rn "admin/ai\|/ai/" admin/src/api/` 只命中两处，且都属 `backend/app/api/routes/admin.py` 的旧链路 —— `admin/src/api/admin.ts:698`（`POST /admin/ai/generate-questions`）与 `:707`（`POST /admin/ai/questions/batch-save`）。本文件 15 个端点在 `admin/src/` 中无任何封装（§3）。
- 后端冒烟：`backend/test/s26_ai_center.py`（691 行）的 C/K/W 三组直接以 URL 常量调用（`:78-85` 定义 `CONFIG_URL`、`KNOWLEDGE_URL`、`JOBS_URL`、`DRAFTS_URL`、`IMPORT_URL` 等），报告 `backend/test/docs/s26-ai-center-report.md`。

### 6.3 数据库表

| 表 | 读/写 | DDL / ORM |
|---|---|---|
| `ai_knowledge` | 读、增、改、**物理删** | `docker/init/021_ai_center.sql:11-25`；`backend/app/models/models.py:563`（`AiKnowledge`） |
| `ai_generation_jobs` | 读、增、改（状态/计数/`finished_at`） | `docker/init/021_ai_center.sql:49-62`；`models.py:633`（`AiGenerationJob`） |
| `ai_generated_questions` | 读、增、改（`data`/`errors`/`status`/`question_id`/`reviewed_*`） | `docker/init/021_ai_center.sql:65-75`；`models.py:657`（`AiGeneratedQuestion`） |
| `questions` | 读（查重）、**增**（导入落库，id 由 `max+1` 分配） | `docker/init/001_schema.sql:16-`；`models.py:145-` |
| `system_settings` | 读、upsert（9 个 `ai_*` 参数 + 3 个提示词 + 版本号） | `docker/init/013_daily_quote_cycle.sql:23-27`；`models.py:117-124` |
| `route_nodes` | 只读（`node_id` 存在性校验） | `docker/init/001_schema.sql` |
| `audit_logs` | **增**（6 个 action，见 §7.6） | `docker/init/010_admin_identity.sql` |
| `admin_menus` / `admin_roles` / `admin_role_menus` / `admin_user_roles` / `users` | 只读（`require_menu` 每请求重建权限） | `docker/init/010_admin_identity.sql`、`022_ai_admin_menus.sql` |

`ai_usage_logs` **本文件既不读也不写**（§4.1 注）。

### 6.4 与 `backend/app/api/routes/admin.py` 的前缀共用与权限口径分裂

同一 URL 前缀 `/api/admin/ai/` 下还有 2 个端点**不属于本文件**，而属 `backend/app/api/routes/admin.py`：

| 端点 | 位置 | 菜单码 | 调用的 service |
|---|---|---|---|
| `POST /api/admin/ai/generate-questions` | `backend/app/api/routes/admin.py:568-589` | **`questions`**（`:572`） | `ai_question_service.generate_questions`（内存态，不落库，`ai_question_service.py:309-346`） |
| `POST /api/admin/ai/questions/batch-save` | `backend/app/api/routes/admin.py:592-606` | **`questions`**（`:596`） | `ai_question_service.batch_save_questions`（`ai_question_service.py:349-392`，id 分配在 `:382`） |

即：**旧内存态出题链路要 `questions` 菜单，新持久化工坊要 `ai_workshop` 菜单**。只有 `questions` 权限的管理员仍能经旧链路批量写题库，却看不到工坊；反之只有 `ai_workshop` 的管理员能用工坊但用不了嵌在题库页的 `admin/src/components/AiGenerateDialog.vue`。这一分裂是事实，是否为有意设计**待确认**（`ai_question_service.py:395-398` 注释只说「现有 admin 前端的旧链路保持不变，本组接口供新工坊页使用」）。

路径本身无冲突：`app.openapi()` 实测 `/api/admin/ai/*` 共 12 条唯一路径、17 个 HTTP 操作，其中 15 个属本文件、2 个属 `admin.py`。本文件内部亦无遮蔽（`POST /drafts/import` `:315` 与 `PUT /drafts/{draft_id}` `:273` 方法不同；`GET /jobs` `:228` 与 `GET /jobs/{job_id}` `:243` 路径不同）。

## 7. 业务规则

### 7.1 权限模型：菜单码不在 token 里，每请求从库重建

`require_menu(code)`（`backend/app/api/deps.py:150-160`）→ `get_current_admin`（`:109-147`）：`typ=super`（或改造前无 `typ` 的历史令牌）直接构造超管主体、`has_menu` 恒真（`:127-129`、`:105-106`）；`typ=user` 则加载 `User`（`:136`）→ `_ensure_active`（`:141`）→ `access_service.build_principal`（`:142`，定义 `backend/app/services/access_service.py:84-98`）**每次请求查库**取启用角色与菜单码并集（`:89`、`:97`），无任何启用角色返回 `None` → 403（`:143-146`）。因此**撤权/禁用即时生效**，不存在 token 内权限快照。

`ai_*` 码**可以被授予自定义角色**：`access_service._validate_menu_codes`（`:186-190`）是对**数据库 `admin_menus` 表**校验，而 022 已把 5 个 `ai_*` 码写进该表。`access_service.ALL_MENU_CODES`（`:27-39`，11 项、**不含任何 `ai_*`**）定义后全仓无引用，是死代码（`.qoder/PROJECT.md` §8 第 22 条已记录），**不构成授予限制**。

但**管理后台 UI 无法授予**：角色菜单勾选框由静态数组渲染 —— `admin/src/views/AccessView.vue:21` import `MENUS`、`:485` `v-for="m in MENUS"`，而 `admin/src/router/menus.ts` 只有 11 项且无 `ai_*`。故 Phase A 下 **`ai_*` 权限实际只有超级管理员可用**（超管 `has_menu` 恒真，不依赖授予）。022 的注释（`docker/init/022_ai_admin_menus.sql:6-7`）亦声明「默认不授予内置 operator 角色，新菜单默认仅超级管理员可见」。

### 7.2 知识资料状态流转与可见性

- 合法状态 5 个（`ai_knowledge_service.py:20`）；`set_status`（`:169-182`）**只校验取值合法性，不校验转换路径** —— 任意状态 → 任意状态均允许（含 `archived → published`、`rejected → published`），无状态机约束，也**不记录流转历史**（只有最后一次 `reviewed_by`/`published_at`）。
- 转 `published` 时写 `published_at` 与 `reviewed_by`（`:177-179`）；`update_knowledge` 仅在**首次**转 published 时写（`:158`、`:161-163`），避免重复发布刷新时间。
- **只有 `published` 会外泄到小程序**：`search_published`（`:193-224`）与 `published_for_node`（`:227-234`）都硬过滤 `status='published'`，故 `draft`/`pending`/`rejected`/`archived` 资料绝不出现在 `/api/ai/chat` 的 `sources`、`/api/ai/route-guide/{node_id}` 的正文、以及题目工坊的参考资料里（`ai_question_service.py:414`）。实测依据：`backend/test/docs/s26-ai-center-report.md` K 组 7/7「发布后才可检索」、R 组「草稿绝不出现」。

### 7.3 草稿状态流转

`pending → approved|rejected`（#12），`approved|rejected → pending`（#11 编辑后自动回退，`ai_question_service.py:607-608`），`approved → imported`（**仅** #13，`:683`）。`imported` 是**终态**：#11 与 #12 都显式拒绝修改（`:595-596`、`:618-619`），且不在 `set_draft_status` 的可设列表内（`:615`）。

**幂等性只落在 #13**：已 `imported` 的草稿再次传入 `draft_ids` 会计入 `skipped` 而非重复入库（`:657-659`）。实测依据：s26 报告 W06/W07「仅 approved 入库并回填 question_id；重复导入 skipped，题库不增」。其余 14 个端点**均不幂等**（`POST /knowledge`、`POST /jobs` 重复调用会重复建行）。

### 7.4 「不信任前端」的重复校验

草稿内容在 3 个时点各校验一遍，且每次都重新查库比对：生成时（`_build_drafts`，`ai_question_service.py:256-276`）、编辑时（`update_draft:600-605`）、审核通过时（`set_draft_status:620-625`）、导入时（`import_drafts:664-672`）。校验函数统一复用 `admin_service._validate_question`（`backend/app/services/admin_service.py:208-233`），与 Excel 导入同等强度（`ai_question_service.py:7-8` docstring 明示）。导入还额外做**批内查重**（`seen` 集合，`:673`）。

### 7.5 密钥不外泄

`GET /config` 与 `PATCH /config` 只触及 `_SPEC` 的 9 个 AI 运行参数、3 个提示词键与版本号（`ai_config_service.py:45-55`、`:92-97`、`:153-183`），**从不读取 `CLOUDBASE_API_KEY` / `CLOUDBASE_ENV_ID` / `CLOUDBASE_AGENT_ID` / `CLOUDBASE_AGENT_URL`**（这 4 项现定义在 `backend/app/core/config.py:89-93`，只在 `backend/app/services/llm_cloudbase.py` 内使用：`is_configured()` `:50-56`、`_require_key()` `:78-81`、`_auth_headers()` `:163-170`）。`LLM_PROVIDER=openai` 时生效的是另一组 `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY`（`backend/app/core/config.py:76-78`），同样只在 `backend/app/services/llm_openai.py` 内使用（`is_configured()` `:40-46`、`_require_key()` `:69-73`、`_auth_headers()` `:159-165`）；`ai_config_service` 的配置中心**两组都不读**，「不泄密钥」的结论对两家供应商都成立。`ai_config_service.py:5-6` docstring 与 `ai_admin.py:5` 均声明此约束。实测依据：s26 报告 C 组「响应不泄密钥」、G 组「响应不泄密钥」。

### 7.6 审计（6 个 action，全部与业务同事务 commit）

| action 字符串 | 端点 | 行号 | `detail` 内容 |
|---|---|---|---|
| `ai.knowledge.create` | `POST /knowledge` | `:111` | `{operator, id, status}` |
| `ai.knowledge.update` | `PUT /knowledge/{kid}` | `:147` | `{operator, id, status}` |
| `ai.knowledge.status` | `PATCH /knowledge/{kid}/status` | `:170` | `{operator, id, status}` |
| `ai.knowledge.delete` | `DELETE /knowledge/{kid}` | `:191` | `{operator, id}` |
| `ai.draft.import` | `POST /drafts/import` | `:328-333` | `{operator, imported, skipped, failed}`（**不含题目内容**） |
| `ai.config.patch` | `PATCH /config` | `:376` | `{operator, keys}`（**只记键名，不记值**） |

**不写审计的写端点有 3 个**：`POST /jobs`（`:211` docstring 说明任务记录本身即留痕）、`PUT /drafts/{draft_id}`、`PATCH /drafts/{draft_id}/status`（后两者草稿可反复修改、属可逆操作，与 `:6` docstring「敏感/不可逆操作」的界定一致，但**审核通过/驳回的操作人在草稿行上有 `reviewed_by`/`reviewed_at` 留痕**，`ai_question_service.py:629-630`）。

`target_user_id` 恒为 `None`（`:52`）—— AI 管理操作不针对具体用户。

> **管理后台审计页尚未认识这 6 个 action**：`admin/src/views/AuditView.vue:51-72` 的 `ACTION_TEXT` 共 20 项，**无任何 `ai.*` 条目**，故这些记录会按 `:131` 的 `ACTION_TEXT[row.action] || row.action` 回退成**裸 action 码**显示，且 `:105` 的筛选下拉里也选不到。属管理端待开发项（§9）。

### 7.7 事务边界（谁 commit）

| 归属 | 端点 | 行号 |
|---|---|---|
| **路由 commit**（8 个，均配套 `except ValueError → rollback + 400`） | #2 `POST /knowledge` | `:112` / rollback `:114` |
| | #4 `PUT /knowledge/{kid}` | `:148` / `:150` |
| | #5 `PATCH /knowledge/{kid}/status` | `:171` / `:173` |
| | #6 `DELETE /knowledge/{kid}` | `:192` / `:194` |
| | #11 `PUT /drafts/{draft_id}` | `:287` / `:289` |
| | #12 `PATCH /drafts/{draft_id}/status` | `:308` / `:310` |
| | #13 `POST /drafts/import` | `:334` / `:336`（service 只 `flush`，`ai_question_service.py:687`） |
| | #15 `PATCH /config` | `:377` / `:379`（service 只 `flush`，`ai_config_service.py:223`） |
| **service commit**（1 个） | #7 `POST /jobs` | `ai_question_service.py:502`/`:510`/`:535` |
| **只读、无 commit**（6 个） | #1、#3、#8、#9、#10、#14 | — |

这正是 `.qoder/ARCHITECTURE.md` §9.4 所述「两种提交约定并存」的缩影，且**在同一文件内混用**：改动任一端点前必须先确认目标 service 属于哪一种（`ai_knowledge_service` 全部只 `flush`；`ai_question_service.run_job` 自提交、`import_drafts` 只 `flush`；`ai_config_service.patch_config` 只 `flush`）。

`SessionLocal` 为 `autoflush=False, autocommit=False`（`backend/app/core/database.py:51`），故 service 内所有 `flush` 都是**显式**的，漏写会导致后续读取看不到本次变更（`ai_config_service.py:221-222` 注释即为此而写）。

### 7.8 限流与用量限额在本层的实际生效情况（grep 核实）

- **进程内 IP 限流：不生效。** 本文件未 import `app.core.rate_limit`（`grep -rn "rate_limit" backend/app/ --include=*.py` 的命中只在 `backend/app/api/routes/admin.py:16`/`:125`/`:147`/`:167` 与 `backend/app/api/routes/auth.py:7`/`:72`/`:99`）；且 `backend/app/core/rate_limit.py:31-35` 只有 `login_limiter`/`qr_create_limiter`/`qr_poll_limiter`/`invite_limiter` 四个实例，**没有 AI 限流器**。
- **AI 总开关与日限额：对管理端全部 15 个端点均不生效。** `ai_config_service.ensure_enabled` 的真实调用点只有 `backend/app/services/ai_chat_service.py:218`（`prepare_message`，chat 与 chat/stream 共用）与 `:507`（`quiz_explanation`）；`ai_usage_service.check_limits` 只有 `ai_chat_service.py:224` 与 `:508`。`backend/app/services/ai_question_service.py`、`ai_knowledge_service.py`、`ai_config_service.py` 中**均无这两个调用**（grep 核实）。
  → 实际后果：`AI_ENABLED=false` 时 `POST /api/admin/ai/jobs` **仍会真实调用当前供应商出题**；管理端出题也**不计入**用户/全站日限额、**不写 `ai_usage_logs`**。唯一的硬闸是**当前供应商所需配置缺失时，门面 `_adapter()` 或适配器在发请求前就抛 `LlmError`** → 502：cloudbase 侧查 `CLOUDBASE_API_KEY` 等（`backend/app/services/llm_cloudbase.py:50-56`、`:78-81`），openai 侧查 `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` 三项（`backend/app/services/llm_openai.py:40-46`、`:69-73`），`LLM_PROVIDER` 取值非法时门面同样抛 `LlmError`（`backend/app/services/llm_service.py:49-58`）。注意 `is_configured()` 只判「配置齐备」不判「凭证有效」——仓库内的百炼 API Key 已实测 **401 失效**（`backend/test/docs/s30-llm-provider-switch-report.md` §2.1），此时 `LLM_PROVIDER=openai` 下配置检查仍通过、真实调用会失败并映射 502。
- 数量闸：`count` 受 schema `le=100`（`AdminAiJobCreateRequest`，`schemas.py:1936`）与 `settings.AI_QUESTION_MAX_COUNT`（默认 100，`config.py:98`）双重限制；批大小与并发受 `AI_QUESTION_BATCH_SIZE`/`AI_QUESTION_MAX_CONCURRENCY`（3）限制（`config.py:96-97`）。注意 `AI_QUESTION_BATCH_SIZE` 代码默认 10，但两套环境均配置为 **5**（`backend/.env:65`、`backend/.env.prod:79`），**生效批大小为 5**。

## 8. 修改约束

1. **`from app.api.routes.ai import ai_http_error, AI_ERRORS`（`:15`）是路由→路由的横向依赖**，`backend/AGENTS.md` §3.1 的分层图（`api/routes -> api/deps -> services -> models + core`）未涵盖该方向。修改 `backend/app/api/routes/ai.py` 的这两个符号（改名、移动、改判定顺序）会**直接破坏本文件**；若要消除横向依赖，应把二者下沉到 `services` 或新建 `api/ai_errors.py`，并同批修改两个文件。
2. **`response_model` 必须用 `Admin*`（普通 `BaseModel`，snake_case）**，不得换成 `CamelModel`。`.qoder/ARCHITECTURE.md` §4.2：同一份业务数据面向两端时用两个不同 Schema，**不是**靠全局配置切换；改基类会让 admin 前端字段整体错位。`DELETE /knowledge/{kid}` 复用 `MessageOut`（`CamelModel`）之所以安全，仅因 `message` 是单词字段、camelCase 与 snake_case 同形 —— **不要照此给多词字段的端点复用 `CamelModel`**。
3. **菜单码字符串必须与 `docker/init/022_ai_admin_menus.sql` 逐字一致**，且必须存在于 `admin_menus` 表；写错不会报错，只会让所有非超管恒定 403。新增 AI 端点须先在 022 之后**新增编号迁移**补菜单码（`docker/init/SQL_CONSTRAINTS.md`：禁止修改已在生产执行过的编号脚本），并同步 `admin/src/router/menus.ts`。
4. **每个端点都必须挂 `require_menu`**（模块 docstring `:4`「不依赖前端隐藏按钮」）。管理后台**无按钮级权限**（`.qoder/PROJECT.md` §8 第 20 条），后端校验是唯一防线，漏挂即等于对全体管理员开放。
5. **`POST /drafts/import` 的「题目入库 + 审计」必须保持同事务**：`ai_question_service.import_drafts` 刻意只 `flush`（`:687` 注释），由路由在 `_audit` 之后 `commit`（`:334`）。若把 commit 移进 service，审计会与业务分离，违背 `backend/app/services/audit_service.py:3-4` 的约定与本文件 `:6` 的声明。
6. **`dependencies=[Depends(require_menu(...))]` 与 `admin: AdminPrincipal = Depends(require_menu(...))` 的双重声明可简化**（§4.1 末）：只保留 `admin` 参数形式即可同时完成鉴权与取主体，功能等价且少一次闭包调用。修改时须保留鉴权语义不变。
7. **`_knowledge_out`（`:56-72`）与 `AdminAiKnowledgeOut`（`schemas.py:1872`）必须字段同步**：前者是手写 dict，新增列时两处都要改，否则新字段会被 `response_model` 静默丢弃（FastAPI 按模型裁剪输出）。同理适用于 `ai_question_service.job_view`（`:422-439`）/`draft_view`（`:442-453`）与 `AdminAiJobOut`/`AdminAiDraftOut`。
8. **不要在路由层新增业务规则**（`backend/AGENTS.md` §3.1、§6.4）。目前唯一的边界情况是 `patch_config` 在路由内做键名映射（`ai_{key}`，`:366`）与提示词类型白名单校验（`:369-371`），而这份白名单在 `backend/app/services/ai_config_service.py:92-96` **已有一份完全相同的 `_PROMPT_KEYS`**；新增提示词类型时必须**同时**改两处，否则一边 400 一边静默丢弃。更稳妥的做法是把映射与校验整体下沉到 `ai_config_service`。
9. **`questions.id` 由应用层 `max(id)+1` 分配，改动导入路径前必须评估并发**（§9「存在问题」第 1 条）。若要加保护，四个分配点（`backend/app/services/admin_service.py:175`、`backend/app/services/ai_question_service.py:382`、`:678`、`backend/app/services/import_service.py:293`）应一并处理，只改一处不解决问题；或改为 `SERIAL`，但那需要新迁移且会影响种子固定 id（`backend/app/data/seed.py`）。
10. **不得在本文件写入任何上游凭据（`LLM_API_KEY`、`CLOUDBASE_API_KEY` 等，§7.5）或把它回显到响应/审计**。`_audit` 的 `detail` 只应放 id、状态、计数、键名一类的非敏感元数据。
11. **新增 AI 管理端点须在 `backend/app/main.py` 注册**（本模块已注册于 `:124`），并按 `backend/AGENTS.md` §5 写中文 `summary`；同时评估是否需要新增 `audit` action 与 `admin/src/views/AuditView.vue` 的 `ACTION_TEXT` 映射。

## 9. 当前实现状态

### 已实现（15/15 端点后端可用）

- 15 个端点全部落地，`require_menu` 全覆盖（无漏挂），`response_model` 全声明，异常映射齐备（§4.1、§5.2）。
- 知识库 CRUD + 状态流转、题目工坊（任务/草稿/审核/幂等导入）、配置中心读写均已实现并通过冒烟：`backend/test/s26_ai_center.py` **47/47**（C 配置中心 5/5、K 知识库 7/7、W 题目工坊 11/11、G 回归安全 2/2 覆盖本文件；H/R/Q/L 组覆盖 `backend/app/api/routes/ai.py`），报告 `backend/test/docs/s26-ai-center-report.md`；2026-10-17 关闭外网 VPN 后无 dns_shim 复跑仍 47/47（同报告 §2b，提交 `1fbacac`）。真库校验：迁移应用、6 表 9 索引 5 菜单齐备、ORM 与真库列 ALL_MATCH、JSON round-trip 正常（同报告 §2）。

### 端点数自证

`app.openapi()` 实测（2026-10-17，`backend/.venv` Python 3.13 + FastAPI 0.143.0）：`/api/admin/ai/*` 共 **12 条唯一路径、17 个 HTTP 操作**，逐项为 —— `config`[get,patch]、`drafts`[get]、`drafts/import`[post]、`drafts/{draft_id}`[put]、`drafts/{draft_id}/status`[patch]、`generate-questions`[post]、`jobs`[get,post]、`jobs/{job_id}`[get]、`knowledge`[get,post]、`knowledge/{kid}`[delete,get,put]、`knowledge/{kid}/status`[patch]、`questions/batch-save`[post]。其中 `generate-questions` 与 `questions/batch-save` 属 `backend/app/api/routes/admin.py:568`/`:592`（§6.4），**17 − 2 = 15 属本文件**，与 §4.1 表格逐行吻合。同一次实测 `/api/ai/*` = 5 路径 / **6** 操作（见 `.qoder/backend/app/api/routes/ai.py.md` §9）。

> 统计须走 `app.openapi()`：该 FastAPI 版本 `include_router` 为惰性挂载，遍历 `app.routes` 只能数到 1 个 `APIRoute`（`.qoder/ARCHITECTURE.md` §2.2 统计陷阱、`.qoder/backend/requirements.txt.md` §9 第 2 条）。

### 存在问题

1. **草稿导入的 `max(id)+1` 主键分配无并发保护（确认）。** `backend/app/services/ai_question_service.py:678` 读 `max(Question.id)` 后在 `:682` 逐条 `Question(id=base_id + offset)`，全程**无 `SELECT ... FOR UPDATE`、无 advisory lock、无唯一冲突重试**。四个 `Question.id` 分配点互不协调：`backend/app/services/admin_service.py:175`（管理端手工新增）、`backend/app/services/ai_question_service.py:382`（旧 `batch-save`）、`:678`（**本文件 #13**）、`backend/app/services/import_service.py:293`（Excel 导入确认）。并发时两者算出同一 `base_id` → 主键冲突。
   - **失败模式（由代码可确定）**：冲突异常被 `ai_question_service.py:689-692` 的 `except Exception` 捕获 → `db.rollback()` + `logger.exception` + `ValueError("导入失败，请稍后重试")` → 路由 `:335-337` → **400**；同事务的审计行（`:328-333`）一并回滚，**不会留下「有审计无导入」的脏记录**，也不会写入半批题目。
   - **未实测**：s26 是单线程 TestClient，未覆盖并发导入；openGauss 上的确切报错文本与 HTTP 表现**待确认**（本文档不修改数据库，故未做并发实测）。
   - 已由 `.qoder/PROJECT.md` §8 第 27 条登记为全项目性技术债。
2. **提示词长度上限与 `system_settings.setting_value` 列宽不匹配（静态核对结论，未实测）。** `ai_config_service.PROMPT_MAX_LEN = 4000`（`backend/app/services/ai_config_service.py:18`、校验点 `:211-212`）允许写入最长 4000 字，但落库列是 `setting_value VARCHAR(200) NOT NULL`（`docker/init/013_daily_quote_cycle.sql:25`；`grep -rn "system_settings" docker/init/*.sql` 确认 014→022 **无任何迁移加宽该列**）。三个内置默认提示词在 `backend/.venv` 中 `len()` 实测为 **chat=348、route=189、quiz=214 字**，其中 chat 与 quiz **已超过 200**。
   - 推断后果：在 openGauss 上 `PATCH /config` 写入 chat/quiz 提示词正文很可能触发「value too long for type character varying(200)」；该异常是 psycopg2 `DataError`，**不是 `ValueError`**，路由 `:378` 的 `except ValueError` 捕获不到 → **500 未处理**（后端无全局异常处理器，`.qoder/ARCHITECTURE.md` §10.3）。
   - **测试未覆盖**：`backend/test/s26_ai_center.py:258-261` 的 PATCH 只写 `values` 与 `prompt_version="v2-test"`（8 字），`:274` 只测未知 kind，**从未写入过提示词正文**；且 s26 用 SQLite 临时库（报告「脚本」段），SQLite 不强制 VARCHAR 长度，即便写了也不会报错。
   - **openGauss 上的运行时确切表现待确认**（本任务禁止改库，未实测）。修复方向二选一：把 `PROMPT_MAX_LEN` 收敛到列宽内，或新增迁移加宽 `setting_value`（后者须遵守 `docker/init/SQL_CONSTRAINTS.md`）。
3. **`ai_overview` 与 `ai_logs` 两个菜单码是空壳。** 022 已 seed（`docker/init/022_ai_admin_menus.sql:14-16`、`:23-25`），但**后端无对应端点**：`ai_usage_logs` 全项目只有写入与限额计数、**无任何读取端点**（§4.1 注、§6.3）。这与 `.qoder/REQUIREMENTS.md` §10.1「后台 AI 接口」行、`.qoder/ARCHITECTURE.md` §11.2 把「调用记录」列入 `/api/admin/ai/*` 已交付范围的表述不符 —— **属文档滞后，非本文件缺陷**；`.qoder/ARCHITECTURE.md` §11.3 与 `.qoder/REQUIREMENTS.md` §10.6「运行概览 / 调用记录」行另处已正确记为「usage / cost 统计页 待开发」。
4. **`_PROMPT_KEYS` 跨模块重复定义。** `ai_admin.py:45` 与 `backend/app/services/ai_config_service.py:92-96` 内容完全一致（同 3 项映射），违反根 `agents.md` §2.2「拒绝冗余代码」。新增提示词类型须同改两处（§8.8）。
5. **`AI_ERRORS` 的 403/429 分支在本文件不可达。** `:224` 唯一使用点是 `POST /jobs`，而该链路不会抛 `AiDisabledError` / `AiLimitError`（§7.8）。模块 docstring `:7` 声明的四路映射对本文件而言只有 502/400 两路生效。保留 `AI_ERRORS` 本身无害（未来接入开关/限额时即生效），但 docstring 措辞与现状有偏差。
6. **`POST /jobs` 是长事务 + 同步阻塞请求。** 生成期间持有同一 DB 会话（`ai_question_service.py:490-491` flush 后到 `:535` commit 之间要跑完全部批次的模型调用，中间还有 `:502`、`:510` 两次状态落库 commit），单批超时 `LLM_TIMEOUT_SECONDS=300` 秒（`backend/app/core/config.py:73`，**两套供应商共用**；旧 `CLOUDBASE_TIMEOUT_SECONDS`（180 秒）已在 `c660727` 删除），`count=100` 时按**生效批大小 5**（两套环境均配置 `AI_QUESTION_BATCH_SIZE=5`，`backend/.env:65`、`backend/.env.prod:79`；代码默认 10）拆 20 批、并发 3（`config.py:97`）→ 最坏约 7 轮 × 300 秒；单批最坏 ≈ `(1 + AI_MAX_RETRIES) × LLM_TIMEOUT_SECONDS`（`AI_MAX_RETRIES` 在 `backend/app/core/config.py:109`，默认 1）。**无异步任务队列、无进度查询、无取消机制**；`admin/src/components/AiGenerateDialog.vue` 用 `AbortController` 做前端中断（`.qoder/ARCHITECTURE.md` §11.3），但**后端不会因客户端断开而停止生成**，任务仍会落库。是否可接受**待确认**（当前无管理端工坊页调用该端点，实际未暴露）。
7. **`GET /knowledge` 的 `keyword` 检索范围与 service docstring 不符。** 路由 `:85` 的 description「按标题/正文模糊搜索」与实现一致（`ai_knowledge_service.py:126` 只 `or_(title.like, content.like)`），但 `backend/app/services/ai_knowledge_service.py:4` 的模块 docstring 称「关键词匹配（title/content/**source**）」，`search_published`（`:212-213`）同样只匹配 title/content。**service docstring 有误**，本文件描述正确。
8. **知识资料物理删除留下悬挂引用。** `DELETE /knowledge/{kid}` 真删行（`ai_knowledge_service.py:189`），而历史 `ai_messages.sources` 存的是**去规范化副本**（`{id,title,source,category}`，`ai_knowledge_service.py:237` 起 `format_sources`），`ai_generation_jobs.params.knowledge_ids` 也存 id 数组（`ai_question_service.py:484`）—— 删除后这些 id 变成悬挂引用（文本仍在，但按 id 回查会 404）。无外键约束（`ai_messages.sources` 是 JSON 列）、无删除前引用检查。是否可接受**待确认**（可视为「已发布内容对外快照」的有意设计）。

### 待开发（Phase A 的既定边界，**非缺陷**）

1. **管理后台 5 个 AI 子页面全部待开发**：知识库、题目工坊、配置中心、运行概览、调用记录。`admin/src/router/menus.ts`（11 项，无 `ai_*`）、`admin/src/api/admin.ts`（无本文件任何端点的封装）、`admin/src/views/`（无 AI 视图）三处一致（§3、§6.2）。**后端 15 个端点已就绪，DB 已有 5 个菜单码，管理端无入口** —— 这是 `.qoder/ARCHITECTURE.md` §11.3、`.qoder/REQUIREMENTS.md` §10.6「知识库 / 配置 / 题目工坊」行、`.qoder/PROJECT.md` §7 记载的预期状态。
   > 已落地的 `admin/src/components/AiGenerateDialog.vue` 是嵌在**题库维护页**的生成对话框，走 `backend/app/api/routes/admin.py:568`/`:592` 的旧链路（`questions` 菜单），**与本文件无关**，不构成「题目工坊子页面已实现」（`.qoder/ARCHITECTURE.md` §11.3 已专门澄清此点）。
2. **`ai_overview`（运行概览）与 `ai_logs`（调用记录）连后端也待开发**（§9「存在问题」第 3 条）：`ai_usage_logs` 表已建（`docker/init/021_ai_center.sql:78-90`）并已在写入，但无任何读取端点。
3. **`admin/src/views/AuditView.vue` 的 `ACTION_TEXT` 待补 6 个 `ai.*` 映射**（§7.6 注）。
4. **`ai_*` 菜单码在管理端 UI 上不可授予**（§7.1）：需在 `admin/src/router/menus.ts` 登记后，`AccessView.vue:485` 的勾选框才会出现。
5. **`ai_usage_logs.feature` 的 `question_gen` 取值从未被写入**：`backend/app/models/models.py:686` docstring 列出该值，但 `backend/app/services/ai_question_service.py` 从不调用 `ai_usage_service.record`（grep 零命中）。同族的 `route_guide` 亦从未写入（见 `.qoder/backend/app/api/routes/ai.py.md` §9）。

### 待确认

1. 《长征步迹 AI 智能中心开发需求 V1.0》原始文档未入库，§3.4 与 §13 的原文措辞**待确认**。
2. 旧链路（`questions` 菜单）与新工坊（`ai_workshop` 菜单）**长期并存还是最终收敛**，代码与文档均无说明（§6.4）；`ai_question_service.py:395-398` 只说「旧链路保持不变，本组接口供新工坊页使用」。
3. 提示词写入在 openGauss 上的实际行为（§9「存在问题」第 2 条），需一次不改数据的只读验证或在新迁移后实测。
4. `POST /jobs` 长事务/同步阻塞是否为可接受的 Phase A 取舍（§9「存在问题」第 6 条）。
5. 生产库是否已应用 `docker/init/021_ai_center.sql` 与 `022_ai_admin_menus.sql`：`.qoder/PROJECT.md` §8 第 3 条记为「生产库缺 AI 迁移 021/022（文件未提交）」，`git status` 显示这两个 SQL 仍是未跟踪文件 —— **生产环境当前状态待确认**（未应用则本文件 15 个端点会因缺表 500、`require_menu` 会因缺菜单码对非超管恒 403）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/ai_admin.py`（实测 **2 个提交**：`c660727`、`1600074`），交叉核对 `docs/迭代记录.md` 与 `backend/test/docs/s26-ai-center-report.md`。按时间倒序。

### 2026-10-22（文档校正，对应上游重构 `b712d81`）

- 需求：文档欠账校正。`b712d81`（2026-10-22，把 `llm_service.py` 拆为门面 + 双适配器 `llm_openai.py`/`llm_cloudbase.py`，按 `settings.LLM_PROVIDER` 分发）**未修改本文件源码** —— `backend/app/api/routes/ai_admin.py` 最后一次源码变更仍是 `c660727`（2026-10-19）的模块 docstring 两行；但历经多次上游提交后，本文档大量 `路径:行号` 引用与部分表述已失效，须以当前源码为准逐章校正（非简单 cloudbase→llm 字面替换）。
- 修改内容（**仅本文档，未改任何源码/配置/测试**）：§2 挂载行号（`main.py:87`→`:124`、`config.py:25`→`:27`、契约块 `:1707-1858`→`:1860-2007`、`MessageOut:180`→`:781`）并新增「行号对照」块（`schemas.py`/`models.py` 旧→新，残留旧行号按对照换算、逐处重标待复核）；§4.4 `ai_question_service.py`（现 699 行）全部行号重标（`run_job:456-539`、`_validate_params:279-306`、`_references_from_knowledge:402-419`、`_run_batches:214-253`、`import_drafts:635-699`、commit 归属 `:502`/`:510`/`:535` 等），「线程内只调 CloudBase」改为只调 `llm_service.prompt`（`_generate_batch:204-211`，未显式传 timeout → 共用 `LLM_TIMEOUT_SECONDS=300`，`config.py:73`）；§4.5/§5.1 `schemas.py` 契约行号重标；§6.2 `main.py:23`/`:124`（注册于 `admin.router`（`:123`）之后）；§6.3 ORM 行号（`models.py:563`/`:633`/`:657`）；§6.4 旧链路行号（`admin.py:568-589`/`:592-606`，`ai_question_service.py:309-346`/`:349-392`/`:382`/`:395-398`）；§7.7 flush/commit 行号（`:687`、`:502`/`:510`/`:535`）；§7.8 限流调用点（`admin.py:16`/`:125`/`:147`/`:167`、`auth.py:7`/`:72`/`:99`、`rate_limit.py:31-35`）、`ensure_enabled`/`check_limits` 现行调用点（`ai_chat_service.py:218`/`:224`/`:507`/`:508`）、数量闸（`config.py:96-98`；`AI_QUESTION_BATCH_SIZE` 代码默认 10 但两环境均设 **5** → 生效批大小 5，`.env:65`/`.env.prod:79`）；§8 条目 5/7/9/10/11（含「CloudBase 凭据」改为「上游凭据」）；§9 问题 1/6/8（批次数学按生效批大小 5 改为 20 批 → 最坏约 7 轮 × 300 秒）与待开发 5、待确认 2。
- 关联文件：`.qoder/backend/app/api/routes/ai.py.md`、`.qoder/backend/app/api/routes/admin.py.md`（姊妹文档同批校正）；上游源码 `backend/app/services/llm_service.py`（152 行门面）、`llm_base.py`（54 行）、`llm_openai.py`（346 行）、`llm_cloudbase.py`（320 行）、`ai_question_service.py`（699 行）、`backend/app/schemas/schemas.py`、`backend/app/models/models.py`、`backend/app/main.py`、`backend/app/core/config.py`。
- 测试结果：纯文档变更，无需测试。上游 `b712d81` 的测试情况据 `docs/迭代记录.md` 的 `b712d81` 条目：s30 供应商切换冒烟 23 用例全过，回归 s25 16/16、s26 47/47、s28 13/13（合计 99/99）。

### 2026-10-19（`c660727`，14:16）— AI 大模型供应商迁移（CloudBase Agent → 阿里云百炼）

- 需求：原上游绑定腾讯云 CloudBase Agent 私有 ACP 协议，换供应商需重写；统一改走 OpenAI Chat Completions 兼容协议并接入阿里云百炼，`cloudbase_service` 更名重写为 `llm_service`（`CloudBaseError` → `LlmError`），业务代码与厂商解耦。
- 修改内容（本文件 `ai_admin.py` 的行级变化，`git show` 实测 ±2 行、共 4 行，均在模块 docstring）：① 安全约定行「绝不返回任何明文密钥（CloudBase API Key 等）」改为「（LLM API Key 等）」（现 `:5`）；② 异常映射行「CloudBase→502」改为「Llm→502」（现 `:7`）。15 个端点、`require_menu`、`from app.api.routes.ai import ai_http_error, AI_ERRORS`（`:15`）与 `except AI_ERRORS as exc: raise ai_http_error(exc)`（`:224-225`）代码均未变——`AI_ERRORS` 元组内的异常类在 `backend/app/api/routes/ai.py` 侧由 `CloudBaseError` 换成了 `llm_service.LlmError`，本文件透明复用。
- 关联文件（`git show --stat c660727`，共 18 个文件）：`backend/app/services/cloudbase_service.py`（删除 228 行）→ `backend/app/services/llm_service.py`（新增 227 行）、`backend/app/core/config.py`、`backend/app/api/routes/ai.py`、`backend/app/api/routes/admin.py`、`backend/app/services/ai_chat_service.py`、`backend/app/services/ai_question_service.py`、`backend/app/services/ai_config_service.py`、`backend/app/models/models.py`、`backend/.env`、`backend/.env.prod`、`backend/test/s25*`、`backend/test/s26*`、`backend/test/serve_sqlite.py`，新增报告 `backend/test/docs/s27-llm-provider-migration-report.md`。
- 测试结果：据 `docs/迭代记录.md` 的 `c660727` 条目 —— `s25_ai_question_generate.py` **16/16**（含真实调用生成 10 题与 50 题、题库未增）、`s26_ai_center.py` **47/47**（覆盖本文件全部端点分组）；改动文件 `py_compile` 全通过；`app.openapi()` 125 条路径、18 条 AI 路由与迁移前一致；全仓 grep 无 `CloudBase`/`cloudbase` 残留（历史测试报告除外）。
- 备注：`b712d81`（2026-10-22）后续把 `llm_service.py` 拆为门面 + 双适配器（`llm_openai.py`/`llm_cloudbase.py`，按 `settings.LLM_PROVIDER` 切换），**未触及本文件**，对外符号名不变，故本文档 §5.2/§7.5/§7.8 的结论在两套供应商下均成立（相应行号已在各处按拆分后源码更新）。

### 2026-10-17（文档）

- 需求：建立 `.qoder/` 文件级文档体系，为管理后台侧 AI 路由建档。
- 修改内容：**仅新增本文档，未修改 `backend/app/api/routes/ai_admin.py` 或任何业务代码/数据库/配置/测试文件**。全文读完本文件（381 行）与其调用的 `backend/app/services/ai_question_service.py`（696 行）、`ai_knowledge_service.py`（255 行）、`ai_config_service.py`（224 行）、`audit_service.py`、`setting_service.py`、`access_service.py`、`backend/app/api/deps.py`（160 行）、`backend/app/api/routes/admin.py:495-538`、`backend/app/schemas/schemas.py:1707-1858`、`backend/app/models/models.py:540-684`、`docker/init/021_ai_center.sql`、`docker/init/022_ai_admin_menus.sql`、`docker/init/013_daily_quote_cycle.sql:23-27`、`docker/init/001_schema.sql:16-`、`admin/src/router/menus.ts`、`admin/src/views/AccessView.vue`、`admin/src/views/AuditView.vue:51-72`、`admin/src/api/admin.ts`。逐端点核对方法/路径/行号/`require_menu` 码/`response_model`/commit 归属/审计 action。
- 关联文件：`.qoder/backend/app/api/routes/ai.py.md`（同批）、`.qoder/ARCHITECTURE.md` §2.2 / §9.4 / §11、`.qoder/REQUIREMENTS.md` §10、`.qoder/PROJECT.md` §7 / §8。
- 测试结果：不涉及代码变更，无需测试。端点数以 `app.openapi()` 实测复核（`/api/admin/ai/*` = 12 路径 / 17 操作，扣除属 `admin.py` 的 2 个后为 **15**，与 §4.1 逐行吻合）。菜单码以 `grep -n 'require_menu("'` 逐字核对为 `ai_knowledge`/`ai_workshop`/`ai_config` 三个，与 022 的 5 个 seed 码对照得出 `ai_overview`/`ai_logs` 未被使用；并以 `grep -rn "AiUsageLog\|ai_usage_logs" backend/app --include=*.py` 确认全后端无 `ai_usage_logs` 读取端点。新发现并以 DDL/代码证据记录的问题：提示词 4000 字上限 vs `VARCHAR(200)` 列宽不匹配（§9 第 2 条，实测三个默认提示词长度 348/189/214）、`max(id)+1` 并发风险落在 `ai_question_service.py:674`（§9 第 1 条）、管理端出题不受 AI 总开关与日限额约束（§7.8）、`_PROMPT_KEYS` 重复定义（§9 第 4 条）、`AuditView.vue` 缺 6 个 `ai.*` 映射（§7.6）、`ai_knowledge_service.py:4` docstring 的 `source` 检索范围有误（§9 第 7 条）。

### 2026-10-17（`1600074`，11:06）

- 需求：《长征步迹 AI 智能中心开发需求 V1.0》Phase A 后端 —— §3.4 管理端接口（知识库 / 配置 / 题目工坊持久化 / 菜单鉴权）与用量日志。
- 修改内容：**新建本文件**（`git show --stat` 记为新增 381 行），含 15 个端点、`_PROMPT_KEYS`、`_audit`、`_knowledge_out`。同一提交新增 `backend/app/api/routes/ai.py`（141 行）、`backend/app/services/ai_question_service.py` **+374 行**（在既有内存态 `generate_questions`/`batch_save_questions` 之后追加「持久化题目工坊」段，即 `:391-696` 的 `run_job`/`list_jobs`/`get_job`/`list_drafts`/`update_draft`/`set_draft_status`/`import_drafts`/`job_view`/`draft_view`/`_references_from_knowledge`）、`ai_knowledge_service.py`（255 行）、`ai_config_service.py`（224 行）、`ai_usage_service.py`（70 行）、`ai_chat_service.py`（425 行）、`backend/app/main.py` +4 行（import `ai_admin` 与 `include_router`）、`backend/test/s26_ai_center.py`（691 行）与报告/结果文件；`backend/app/models/models.py` 同步 6 个 AI ORM（`:540-684`）。`docker/init/021_ai_center.sql`（6 表 9 索引）与 `022_ai_admin_menus.sql`（5 菜单码）按根 `agents.md` §1.3 **不随本提交入库**，已在本地 openGauss 应用并登记 `schema_migrations`。
- 关联文件：`backend/app/schemas/schemas.py:1706-1858`（管理端 AI 契约，snake_case）、`backend/app/api/routes/ai.py`（`ai_http_error`/`AI_ERRORS` 来源）、`backend/app/services/admin_service.py:208-233`（复用的 `_validate_question`）、`backend/app/services/audit_service.py`、`backend/app/services/access_service.py:84-98`/`:186-190`（权限重建与菜单码校验）、`admin/src/router/menus.ts`（**本次未改**，故管理端无入口）、`frontend/services/ai.js`（小程序侧，由 frontend 提交 `0052108` 同日 11:06 交付）。
- 测试结果：据 `docs/迭代记录.md` 的 `1600074` 条目 —— 冒烟 `backend/test/s26_ai_center.py` **47/47**（本文件相关：C 配置中心 5/5、K 知识库 7/7、W 题目工坊 11/11、G 回归安全 2/2「旧内存态出题链路不受影响、响应不泄密钥」）；真库校验迁移应用 / 表索引菜单齐备 / ORM 与真库列 ALL_MATCH / JSON round-trip 后回滚；报告 `backend/test/docs/s26-ai-center-report.md`。**管理后台 Vue 子页面按需求 §13 留后续阶段**（同条目原文）。同日 `1fbacac`（11:26）关闭外网 VPN 后无 dns_shim 复跑 s26 仍 **47/47**。

> 本文件在 `1600074` 之后被 `c660727`（2026-10-19）修改过一次（仅模块 docstring 两行措辞，见上方条目）；`git log --follow` 实测共返回 2 条（`c660727`、`1600074`），此后至本次文档同步无其它提交修改过本文件。
