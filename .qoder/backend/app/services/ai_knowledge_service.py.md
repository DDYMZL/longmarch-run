# ai_knowledge_service.py

## 1. 文件路径

`backend/app/services/ai_knowledge_service.py`（255 行）

## 2. 文件职责

AI 知识资料（`ai_knowledge` 表）的**管理端 CRUD + 审核状态流转**，以及供 AI 问答/讲解使用的**「仅已发布」检索**与两种格式化输出（提示词用的「参考资料」段、对外契约用的「知识来源」列表）。模块 docstring `backend/app/services/ai_knowledge_service.py:1-7` 明确了三条设计立场：

1. `:3` 只有 `status='published'` 的资料参与问答/讲解检索，**草稿与驳回内容绝不下发**；
2. `:4-5` **检索为关键词匹配，V1.0 未接入向量语义检索，此为已知取舍**；命中不足时上层按「资料不足」处理，不编造；
3. `:6` 不信任前端传入的 id 越权，所有写操作由**路由层**校验管理员菜单权限后进入。

本模块**不含任何 `db.commit()`**（全文件只有 4 处 `db.flush()`：`:149`、`:165`、`:181`、`:190`），事务提交由路由层负责。

## 3. 业务需求

- 上游需求书为《长征步迹 AI 智能中心开发需求 V1.0》§3.4「管理端接口」中的**知识库维护**部分，于 2026-10-17 以 **Phase A** 交付（提交 `1600074`，`docs/迭代记录.md` 的 `1600074` 条目原文列有「§3.4 管理端接口（知识库/配置/题目工坊持久化/菜单鉴权 require_menu）」）。
- **需求文档本身未入库**：`docs/` 目录下不存在《长征步迹 AI 智能中心开发需求 V1.0》文件（实测 `ls docs/` 只有 8 份文档，无 AI 需求书）。需求条目内容以 `docs/迭代记录.md` 的 `1600074` 条目与 `backend/test/docs/s26-ai-center-report.md:4` 的转述为准，**原始需求文本措辞待确认**。
- 业务动因（可从代码与注释确证）：AI 回答必须「只依据已审核史实、可标注来源、资料不足时不编造」——这要求有一个**人工维护、带审核状态**的资料库作为唯一可下发内容源。`:4-5` 与 `backend/app/services/ai_config_service.py:67-68`（chat 系统提示第 3 条「不确定时如实说明『现有资料不足，无法确认』，绝不编造或猜测」）共同构成该承诺。
- 导航层出处（只回指、不复制正文）：`.qoder/REQUIREMENTS.md` §10「AI 智能中心（V1.0 Phase A）」、`.qoder/ARCHITECTURE.md` §11「AI 智能中心」与「架构级限制」第 6 条（AI 知识库检索为关键词匹配，非向量检索）、表结构见 `.qoder/backend/app/models/models.py.md`。

## 4. 核心功能

### 4.1 模块常量（`backend/app/services/ai_knowledge_service.py:20-24`）

| 常量 | 行号 | 值 | 与 DB / schema 的对应 |
|---|---|---|---|
| `ALLOWED_STATUS` | `:20` | `("draft","pending","published","rejected","archived")` | `ai_knowledge.status VARCHAR(16) DEFAULT 'draft'`（`docker/init/021_ai_center.sql:19`）；`backend/app/models/models.py:565`；`backend/app/models/models.py:543` docstring 逐值释义 |
| `ALLOWED_CATEGORIES` | `:21` | `("event","route","figure","custom")` | `category VARCHAR(20)`（`docker/init/021_ai_center.sql:17`）；`backend/app/models/models.py:544` 注明「复用题库口径 event/route/figure，另允许 custom」 |
| `TITLE_MAX_LEN` | `:22` | `200` | `title VARCHAR(200) NOT NULL`（`docker/init/021_ai_center.sql:13`）、`backend/app/models/models.py:556`、`backend/app/schemas/schemas.py:1710` |
| `SOURCE_MAX_LEN` | `:23` | `300` | `source VARCHAR(300)`（`docker/init/021_ai_center.sql:15`）、`backend/app/models/models.py:558`、`backend/app/schemas/schemas.py:1712` |
| `RELATED_MAX` | `:24` | `10` | `related JSON`（`docker/init/021_ai_center.sql:16`）为字符串数组，**DB 侧无长度约束**，10 条上限只在本服务生效 |

### 4.2 `_keywords(text, limit=12)`（`backend/app/services/ai_knowledge_service.py:27-50`）——检索词抽取

docstring `:28-33` 给出三条规则：非中文/短中文词（长度 2~4）整体作为关键词（多为专有名词，易精确命中）；较长中文串（>4 字，通常是整句提问）改取**滑动 2-gram**，避免整句几乎不可能精确命中；去标点、去重、限量，供 LIKE 匹配与命中打分。

实现：

1. `:34` `re.sub(r"[^\w\u4e00-\u9fff]+", " ", text or "")`——把非「单词字符/CJK」的连续片段替换为空格（即去标点、按标点与空白切分）。`text` 为 `None` 时按空串处理。
2. `:37-39` 内部闭包 `_add(token)`：非空、未重复、且 `len(out) < limit` 时才追加（**去重 + 限量**）。
3. `:41-49` 遍历空格切分后的每个 `seg`：
   - `:42` `has_cjk = re.search(r"[\u4e00-\u9fff]", seg)`；
   - `:43-47` **含 CJK 且 `len(seg) > 4`** → 取全部相邻 2-gram，且只保留 `re.fullmatch(r"[\u4e00-\u9fff]{2}", bigram)` 的纯汉字二元组（`:46`）；**整个 seg 本身不加入**；
   - `:48-49` **否则 `len(seg) >= 2`** → 整个 seg 作为一个关键词；
   - 长度 1 的片段（无论中英文）被丢弃。

### 4.3 `_validate(db, data)`（`backend/app/services/ai_knowledge_service.py:53-102`）——写入前校验与规整

docstring `:54`：校验并规整写入字段，返回可直接用于构造/更新模型的 dict。逐字段：

| 字段 | 校验 | 行号 | 规整结果 |
|---|---|---|---|
| `title` | strip 后非空，否则 `ValueError("标题不能为空")`；长度 > 200 抛「标题不能超过 200 字」 | `:55-59` | strip 后的字符串 |
| `content` | strip 后非空，否则 `ValueError("正文内容不能为空")`；**无长度上限** | `:60-62` | strip 后的字符串 |
| `source` | 长度 > 300 抛「来源不能超过 300 字」 | `:63-65` | 空串 → `None`（`:97`） |
| `category` | 非空且不在 `ALLOWED_CATEGORIES` → 抛「分类必须为 event/route/figure/custom 或留空」 | `:67-69` | 空串 → `None`（`:99`） |
| `related` | `None`/`""` → `[]`；`list` → 逐项 `str().strip()`、丢弃空项、**截断到前 10 项**；其他类型 → 抛「相关问题必须是字符串数组」 | `:71-77` | `List[str]` |
| `node_id` | `None`/`""`/`0` → `None`；`int()` 失败抛「节点 ID 非法」；**再查 `route_nodes` 存在性**，不存在抛「绑定的路线节点不存在」 | `:79-88` | `Optional[int]` |
| `status` | 缺省 `"draft"`；不在 `ALLOWED_STATUS` → 抛「状态非法」 | `:90-92` | 字符串 |

返回 7 键 dict（`:94-102`）：`title`/`content`/`source`/`related`/`category`/`node_id`/`status`。

> **关键行为**：返回的键集**恒定且完整**，因此 `update_knowledge` 的 `setattr` 循环（`:159-160`）是**全量覆盖**而非增量补丁——请求体未提供的字段会取 `AdminAiKnowledgeUpsert` 的默认值（`backend/app/schemas/schemas.py:1707-1716`：`source=""`、`related=[]`、`category=""`、`node_id=None`、**`status="draft"`**）。详见 §9.2 第 10 条。

`:87-88` 的存在性校验只 `SELECT route_nodes.id`，是本模块除 `ai_knowledge` 外唯一触达的表。

### 4.4 CRUD 四函数

| 函数 | 行号 | 行为 | 提交 |
|---|---|---|---|
| `get_knowledge(db, kid)` | `:138-139` | 按主键单查，返回 `Optional[AiKnowledge]`；**不存在时返回 `None` 而不抛错**（抛错由调用方决定：`update_knowledge:155-156`、`set_status:174-175`、`delete_knowledge:187-188` 抛 `ValueError("知识资料不存在")`，路由 `backend/app/api/routes/ai_admin.py:127-128` 转 404） | 只读 |
| `create_knowledge(db, data, actor)` | `:142-150` | `_validate` → `AiKnowledge(created_by=actor, **fields)`；**若 `status == "published"` 则同时写 `published_at = now_utc()` 与 `reviewed_by = actor`**（`:145-147`，即「新建即发布」允许，无需先建草稿）；`db.add` + `db.flush` | `flush` only（`:149`） |
| `update_knowledge(db, kid, data, actor)` | `:153-166` | 取行（无则 `ValueError`）→ `_validate` → 记 `was_published`（`:158`）→ 对 7 个键逐一 `setattr`（`:159-160`）→ **仅当「新状态为 published 且原本不是 published」**才写 `published_at`/`reviewed_by`（`:161-163`）→ `row.updated_at = now_utc()`（`:164`）→ `flush` | `flush` only（`:165`） |
| `set_status(db, kid, status, actor)` | `:169-182` | **先校验 status 合法性**（`:171-172`，在取行之前）→ 取行（无则 `ValueError`）→ 写 `status` → **只要 `status == "published"` 就无条件覆写 `published_at = now_utc()` 与 `reviewed_by = actor`**（`:177-179`，**无 `was_published` 守卫**）→ `updated_at = now_utc()` → `flush`。docstring `:170`：审核状态流转；发布时记录 published_at 与审核人 | `flush` only（`:181`） |
| `delete_knowledge(db, kid)` | `:185-190` | 取行（无则 `ValueError`）→ `db.delete(row)` → `flush`。**物理删除**，无软删；`archived` 状态是既有的软删替代方案但本函数不使用 | `flush` only（`:190`） |

`actor` 参数由路由传入 `admin.username`（`backend/app/api/routes/ai_admin.py:109`、`:145`、`:168`），写入 `created_by` / `reviewed_by` 两个 `VARCHAR(64)` 列（`docker/init/021_ai_center.sql:20-21`）。

### 4.5 `list_knowledge(db, page, page_size, keyword, status, category, node_id)`（`backend/app/services/ai_knowledge_service.py:105-135`）

管理端分页列表，docstring `:114`：按更新时间倒序。

- 过滤条件全部可选、AND 组合：`status` 精确等值（`:116-117`）、`category` 精确等值（`:118-119`）、`node_id` **真值判断**（`:120-121`，故 `node_id=0` 等同于不过滤）。
- `keyword`：`strip` 后非空则构造 `like = f"%{kw}%"`，对 `title` 与 `content` 做 `or_(...)` 模糊匹配（`:122-127`）。**`%` 与 `_` 未转义**，管理员搜索字面量 `%` 时会被当作通配符。
- `total = query.count()`（`:128`）——独立 COUNT 查询。
- 排序 `updated_at DESC, id DESC`（`:130`，`id` 作稳定次序兜底），分页 `offset((max(1, page) - 1) * page_size).limit(page_size)`（`:131-132`）。`page < 1` 被 `max(1, page)` 夹住；`page_size` 未在本函数夹取，由路由的 `Query(20, ge=1, le=100)` 保证（`backend/app/api/routes/ai_admin.py:84`）。
- 返回 `(total, List[AiKnowledge])`——**返回 ORM 对象**，由路由的 `_knowledge_out` 转契约 dict（`backend/app/api/routes/ai_admin.py:56-72`，含「本库空串按 NULL 存储，可空文本列读取时统一回退空值」的处理）。

### 4.6 `search_published(db, query_text, top_k, category=None)`（`backend/app/services/ai_knowledge_service.py:193-224`）——**关键词 LIKE 检索，非向量检索**

docstring `:199-201`：按关键词检索已发布资料（最多 `top_k` 条），供问答/讲解拼「参考资料」；命中排序为**标题命中优先于正文命中，其次按发布时间倒序**；无关键词时返回最新已发布若干条。

**检索方式的代码级证据（务必按此理解，勿美化为「语义检索」）**：

- `:205` `db.query(AiKnowledge).filter(AiKnowledge.status == "published")`；
- `:209-214` 对每个关键词构造 `f"%{w}%"`，生成 `title.like(like)` 与 `content.like(like)` 两类子句，全部 `or_(*clauses)` 组合；
- **全文件无 embedding、无向量列、无 pgvector / 全文检索调用**；`docker/init/021_ai_center.sql:11-25` 的建表语句中也没有任何向量列，索引只有 `(status, category)` 与 `(node_id)`（`docker/init/021_ai_center.sql:95-99`）；
- 模块 docstring `:4-5` 自认：「检索为关键词匹配……**V1.0 未接入向量语义检索，此为已知取舍**」；`.qoder/ARCHITECTURE.md`「架构级限制」第 6 条同样登记为「AI 知识库检索为**关键词匹配**，非向量检索 / 召回质量有限 / Phase A 取舍」。

执行步骤：

1. `:203` `top_k = max(1, int(top_k or 1))`——下限夹到 1（`top_k` 传 `None`/`0` 均按 1 处理）。
2. `:204` `words = _keywords(query_text)`——**使用默认 `limit=12`**，未参数化。
3. `:205-207` 过滤 `status='published'`；`category` 非空时追加等值过滤（**当前无任何调用方传 `category`**，见 §9.2 第 7 条）。
4. `:208-214` `words` 非空时构造最多 **12 × 2 = 24** 个前导通配 `LIKE` 子句并 OR 起来。
5. `:215` **SQL 侧预截断**：`order_by(published_at DESC, id DESC).limit(top_k * 3).all()`——候选池只有「最新的 3×top_k 条命中行」。
6. `:216-217` `words` 为空（例如提问全是标点或单字）→ 直接返回候选池前 `top_k` 条，即**最新已发布资料**。
7. `:219-223` 否则在 Python 侧重排：`score(row) = sum(1 for w in words if w in title)`（`:219-221`，**只统计标题命中，正文命中不加分**）；排序键 `(score, published_at or created_at)`，`reverse=True`（`:223`）。
8. `:224` 返回 `rows[:top_k]`。

### 4.7 `published_for_node(db, node_id)`（`backend/app/services/ai_knowledge_service.py:227-234`）

取绑定某路线节点的已发布资料（docstring `:228`：route-guide 固定讲解优先源），过滤 `node_id == node_id AND status == 'published'`，按 `published_at DESC, id DESC` 排序，**不加 LIMIT，返回全部**。条数截断由调用方负责（`backend/app/services/ai_chat_service.py:218` 截到 `knowledge_top_k`；`:285` 只取 `[0]`）。

### 4.8 两个格式化输出

| 函数 | 行号 | 输出 | 消费方 |
|---|---|---|---|
| `format_sources(rows)` | `:237-242` | `[{"id", "title", "source"(空回退 ""), "category"(空回退 "")}]`；docstring `:238`：**不含内部状态/审核人等字段**，即 `status`/`reviewed_by`/`created_by`/`content`/`node_id` 一律不外泄 | 写入 `ai_messages.sources`（`backend/app/services/ai_chat_service.py:253`）并作为接口 `sources` 字段返回（`:248`、`:268`、`:399`、`:405`）；契约模型 `AiSourceOut`（`backend/app/schemas/schemas.py:1621-1627`，camelCase 输出） |
| `format_context(rows)` | `:245-255` | `rows` 为空返回 `""`（`:246-247`）；否则每条拼成 `【资料{i}】{title}`（1 基编号，`:250-251`），`source` 非空时追加 `（来源：{source}）`（`:252-253`），换行后接 **`content` 全文**（`:254`），条间以空行分隔（`:255`）。**无总长度上限** | 拼进提示词「参考资料」段：`backend/app/services/ai_chat_service.py:219`（chat）、`:377`（quiz 解析）、`backend/app/services/ai_question_service.py:415`（AI 出题） |

## 5. 输入与输出

### 5.1 函数签名汇总

| 函数 | 入参 | 返回 | 抛出的 `ValueError` 文案 |
|---|---|---|---|
| `_keywords` | `text: str`, `limit: int = 12` | `List[str]`（≤ limit） | 无 |
| `_validate` | `db: Session`, `data: Dict[str, Any]` | 7 键 dict | 标题不能为空 / 标题不能超过 200 字 / 正文内容不能为空 / 来源不能超过 300 字 / 分类必须为 event/route/figure/custom 或留空 / 相关问题必须是字符串数组 / 节点 ID 非法 / 绑定的路线节点不存在 / 状态非法 |
| `list_knowledge` | `db`, `page=1`, `page_size=20`, `keyword=""`, `status=""`, `category=""`, `node_id=None` | `Tuple[int, List[AiKnowledge]]` | 无 |
| `get_knowledge` | `db`, `kid: int` | `Optional[AiKnowledge]` | 无（返回 `None`） |
| `create_knowledge` | `db`, `data: Dict`, `actor: str` | `AiKnowledge` | 同 `_validate` |
| `update_knowledge` | `db`, `kid: int`, `data: Dict`, `actor: str` | `AiKnowledge` | 知识资料不存在 + 同 `_validate` |
| `set_status` | `db`, `kid: int`, `status: str`, `actor: str` | `AiKnowledge` | 状态非法 / 知识资料不存在 |
| `delete_knowledge` | `db`, `kid: int` | `None` | 知识资料不存在 |
| `search_published` | `db`, `query_text: str`, `top_k: int`, `category: Optional[str] = None` | `List[AiKnowledge]`（≤ top_k） | 无 |
| `published_for_node` | `db`, `node_id: int` | `List[AiKnowledge]`（**无上限**） | 无 |
| `format_sources` | `rows: List[AiKnowledge]` | `List[Dict[str, Any]]` | 无 |
| `format_context` | `rows: List[AiKnowledge]` | `str`（无资料时 `""`） | 无 |

### 5.2 HTTP 层错误码

本模块只抛 `ValueError`（符合 `backend/AGENTS.md` §5「service 层抛 ValueError 表达业务失败」），由路由转 HTTP：

| 路由 | 转换 | 行号 |
|---|---|---|
| `POST /api/admin/ai/knowledge` | `ValueError` → **400**，并 `db.rollback()` | `backend/app/api/routes/ai_admin.py:113-115` |
| `GET /api/admin/ai/knowledge/{kid}` | `get_knowledge` 返回 `None` → **404**「知识资料不存在」 | `backend/app/api/routes/ai_admin.py:126-129` |
| `PUT /api/admin/ai/knowledge/{kid}` | `ValueError` → **400** + rollback（含「知识资料不存在」，**不返回 404**） | `backend/app/api/routes/ai_admin.py:149-151` |
| `PATCH /api/admin/ai/knowledge/{kid}/status` | `ValueError` → **400** + rollback | `backend/app/api/routes/ai_admin.py:172-174` |
| `DELETE /api/admin/ai/knowledge/{kid}` | `ValueError` → **400** + rollback | `backend/app/api/routes/ai_admin.py:193-195` |
| `GET /api/ai/chat` 等小程序侧 | 检索失败不抛错；`ValueError` 经 `ai_http_error` → **400** | `backend/app/api/routes/ai.py:42-50` |

注意 PUT/PATCH/DELETE 对「资料不存在」返回 **400** 而非 404，只有 GET 详情返回 404——这是现状事实（`backend/app/api/routes/ai_admin.py:128` vs `:150`）。

## 6. 依赖关系

### 6.1 依赖

- 标准库：`logging`、`re`、`typing`（`backend/app/services/ai_knowledge_service.py:8-10`）。
- SQLAlchemy：`or_`（`:12`）、`Session`（`:13`）。
- 项目内：`app.core.helpers.now_utc`（`:15`，UTC naive 时间，见 `backend/app/core/helpers.py:12-14`）；`app.models.models.AiKnowledge`、`RouteNode`（`:16`）。
- **数据库表**：`ai_knowledge`（读写，`docker/init/021_ai_center.sql:11-25`）、`route_nodes`（**只读**，`node_id` 存在性校验 `:87`）。
- **配置项：无**。本模块不 import `app.core.config`；`top_k` 由调用方从生效配置传入（`backend/app/services/ai_chat_service.py:211`、`:215`、`:376` 传 `cfg.knowledge_top_k`，来源 `AI_KNOWLEDGE_TOP_K`，env 默认 4，`backend/app/core/config.py:91`，管理端可在 1~20 覆盖，`backend/app/services/ai_config_service.py:54`）。
- **第三方库：无**（不涉及外部 HTTP 调用，因此无超时/重试/降级问题）。

### 6.2 被谁依赖

| 调用方 | 用到的函数 | 行号 |
|---|---|---|
| `backend/app/api/routes/ai_admin.py`（管理端 6 个知识库接口，全部 `require_menu("ai_knowledge")`） | `list_knowledge` `:91`、`create_knowledge` `:109`、`get_knowledge` `:126`、`update_knowledge` `:145`、`set_status` `:168`、`delete_knowledge` `:190`；import `:38` | 路由 `:76-196` |
| `backend/app/services/ai_chat_service.py` | `published_for_node` `:158`（节点背景）、`:283`（route_guide）；`search_published` `:210`、`:215`（chat）、`:376`（quiz 解析）；`format_context` `:219`、`:377`；`format_sources` `:248`、`:399`；import `:32` | — |
| `backend/app/services/ai_question_service.py` | `format_context` `:415`（把管理员勾选的已发布知识作为出题参考资料）；import `:22`。该文件 `:409-410` 另自行查询 `AiKnowledge` 并过滤 `status == "published"`，未复用本模块函数 | — |
| `backend/test/s26_ai_center.py` | K 组 K01~K07（增删改查/状态流转/校验/鉴权/密钥不泄露）、R01~R03（讲解优先取已发布知识、草稿绝不出现）、H12（回答附带已发布知识来源） | `:297-340`、`:462-496`、`:396-400` |

调用链（route → service → 本模块 → 表）：

```text
GET/POST/PUT/PATCH/DELETE /api/admin/ai/knowledge*
  → backend/app/api/routes/ai_admin.py:76-196
  → 本模块 CRUD（list/get/create/update/set_status/delete）
  → ai_knowledge

POST /api/ai/chat
  → backend/app/services/ai_chat_service.py:210、:215
  → search_published
  → ai_knowledge(status='published')

GET /api/ai/route-guide/{node_id}
  → backend/app/services/ai_chat_service.py:283
  → published_for_node
  → ai_knowledge + route_nodes

GET /api/ai/quiz-explanation/{question_id}
  → backend/app/services/ai_chat_service.py:376
  → search_published
  → ai_knowledge

POST /api/admin/ai/jobs
  → backend/app/services/ai_question_service.py:415
  → format_context
  → （纯格式化，不再查库）
```

### 6.3 事务边界（谁 commit）

**本模块从不 commit。** 4 处 `db.flush()`（`:149`、`:165`、`:181`、`:190`）只把变更推到当前事务，提交与回滚全部由 `backend/app/api/routes/ai_admin.py` 承担：成功路径 `db.commit()`（`:112`、`:148`、`:171`、`:192`，与审计写入同事务），`ValueError` 路径 `db.rollback()`（`:114`、`:150`、`:173`、`:194`）。

这与 `backend/app/services/ai_chat_service.py`（**自己 commit**，`:245`、`:263`、`:396`、`:404`）不同——`.qoder/ARCHITECTURE.md` §9.4「事务边界（不统一，须知悉）」已登记该现象并要求「修改代码时必须先确认目标 service 属于哪一种约定」。`SessionLocal` 配置 `autoflush=False`（`backend/app/core/database.py:51`），故本模块必须显式 `flush` 才能让新建行拿到主键。

## 7. 业务规则

- **发布状态流转**：5 个合法状态（`:20`），语义见 `backend/app/models/models.py:543`（draft 草稿 / pending 待审核 / published 已发布 / rejected 已驳回 / archived 已归档）。**只有 `published` 可被检索下发**（`:205`、`:231`）。代码中**没有强制的状态机**——任意状态之间都可直接跳转（`set_status` 只校验值合法性 `:171-172`，不校验来源状态），`pending`（待审核）状态**无任何代码写入**（全仓 grep 无 `status = "pending"` 的知识资料写入路径；管理端页面待开发）。
- **发布副作用**：置为 `published` 时写 `published_at`（UTC naive）与 `reviewed_by`（操作人用户名）。`create_knowledge`（`:145-147`）与 `set_status`（`:177-179`）**无条件写**；`update_knowledge`（`:161-163`）**只在 draft/其他 → published 的首次跃迁时写**。
- **`published_at` 参与检索排序**：`search_published` 的 SQL 排序（`:215`）与 Python 重排次键（`:223`）、`published_for_node` 的排序（`:232`）都以它为准，因此它既是审核留痕也是**召回优先级因子**。
- **权限校验不在本模块**：docstring `:6` 明确「所有写操作由路由层校验管理员菜单权限后进入」。6 个接口均带 `Depends(require_menu("ai_knowledge"))`（`backend/app/api/routes/ai_admin.py:80`、`:101`、`:105`、`:123`、`:136`、`:141`、`:159`、`:164`、`:182`、`:186`），菜单码 `ai_knowledge`「AI知识库」由 `docker/init/022_ai_admin_menus.sql:17-18` 落库。**本模块函数不做任何权限判断，直接调用即绕过鉴权**。
- **无归属概念**：知识资料是全局管理员维护的公共内容，`get/update/set_status/delete` 只按主键定位、**不校验操作人是否为创建者**（与 `backend/app/services/ai_chat_service.py:47-52` 的会话归属校验形成对比）。
- **审计不在本模块**：写审计由路由完成（`ai.knowledge.create`/`.update`/`.status`/`.delete`，`backend/app/api/routes/ai_admin.py:111`、`:147`、`:170`、`:191`），与业务变更**同事务提交**。
- **删除是物理删除**（`:189`），不可恢复；已发布资料被删后立即从检索结果消失（无缓存层）。
- **绑定节点必须真实存在**（`:87-88`），但**不校验节点是否已解锁/是否在活动期内**——知识资料的可下发性只由 `status` 决定。
- **幂等与并发**：无 version 列、无行锁、无 `SELECT ... FOR UPDATE`，两名管理员同时编辑同一资料为 **last-write-wins**（`setattr` 全量覆盖 `:159-160`）。`create_knowledge` 无唯一约束防重（`docker/init/021_ai_center.sql:11-25` 只有主键与两个普通索引），**同标题资料可重复创建**。

## 8. 修改约束

- **检索口径属业务规则**：把关键词匹配换成向量/语义检索会改变 AI 回答的召回与「资料不足不编造」承诺的边界，须同步更新 `.qoder/REQUIREMENTS.md` §10、`.qoder/ARCHITECTURE.md`「架构级限制」第 6 条，并新增迁移（新列/新表 + 索引）。**禁止修改已在生产执行过的 `docker/init/021_ai_center.sql`**（`.qoder/README.md` §3.7、`docker/init/SQL_CONSTRAINTS.md`）。
- **三处长度/枚举必须同步**：`TITLE_MAX_LEN`/`SOURCE_MAX_LEN`（`:22-23`）↔ DB 列宽（`docker/init/021_ai_center.sql:13`、`:15`）↔ ORM（`backend/app/models/models.py:556`、`:558`）↔ Pydantic（`backend/app/schemas/schemas.py:1710`、`:1712`）；`ALLOWED_STATUS`/`ALLOWED_CATEGORIES`（`:20-21`）↔ `backend/app/models/models.py:543-544` docstring ↔ `backend/app/schemas/schemas.py:1708` docstring。任一处单边修改都会造成 400 与 DB 约束不一致。
- **`format_sources` 的输出结构是小程序契约**（`AiSourceOut`，camelCase 输出）：增删字段须同步 `backend/app/schemas/schemas.py:1621-1627`、`frontend/services/ai.js:17` 的 JSDoc 与 `frontend/pages/ai-chat/ai-chat.js` 的渲染；**不得**把 `content`/`status`/`reviewed_by` 加进去（`:238` 的「不含内部字段」是安全约定）。
- **不得在本模块内 `db.commit()`**：现有 4 个写函数都是 `flush`-only，路由负责 commit/rollback 并与审计同事务（§6.3）。在此处 commit 会把审计写入拆到事务外，破坏 `backend/app/api/routes/ai_admin.py:6` 的「敏感/不可逆操作写 audit_logs，与业务同事务提交」约定。
- **不得在本模块内做权限判断的替代实现**：鉴权入口是路由的 `require_menu("ai_knowledge")`；若在 service 内另加一套判断，会与 `backend/app/api/routes/ai_admin.py:4`「不依赖前端隐藏按钮」的单一鉴权口径冲突。
- **`published` 是唯一可下发状态**，任何新增检索函数都必须带 `status == "published"` 过滤（`:205`、`:231` 是现有两处；`backend/app/services/ai_question_service.py:410` 是第三处），否则草稿/驳回内容会经 AI 回答外泄。
- 本文件属 `backend/app/**`，改动后须按 `.qoder/README.md` §3.4 同步更新本文档并在 §10 追加记录。

## 9. 当前实现状态

### 9.1 已实现（事实陈述，均有行号依据）

- 知识资料 CRUD 与分页列表（`:105-190`），字段校验与规整（`:53-102`），`node_id` 外键存在性校验（`:87-88`）。
- 5 态审核流转与发布留痕（`published_at` / `reviewed_by`，`:145-147`、`:161-163`、`:177-179`）。
- 「仅已发布」关键词检索（`:193-224`）与按节点取已发布资料（`:227-234`）。
- 中文友好的检索词抽取（长中文串降级为 2-gram，`:41-49`）。
- 两种输出格式化：对外来源列表（`:237-242`）与提示词参考资料段（`:245-255`）。
- 冒烟覆盖：s26 K 组 K01~K07 全通过（`docs/迭代记录.md` 的 `1600074` 条目记 47/47），R02/R03 专门断言「**草稿内容绝不出现**」（`backend/test/s26_ai_center.py:481`），H12 断言回答附带已发布知识来源（`:396-400`）。

### 9.2 存在问题 / 已知限制

1. **模块 docstring 与代码不符（文档级缺陷）**：`:4` 声称检索为关键词匹配「（title/content/**source**）」，但两处 LIKE 都**只覆盖 `title` 与 `content`**——`search_published:212-213`、`list_knowledge:126`。`source` 列从未参与匹配。
2. **检索是关键词 LIKE 匹配，不是向量/语义检索**（`:4-5` 自认，实现见 §4.6）。无同义词扩展、无错别字容错、无词频/TF-IDF 相关性；「相关性」仅等于标题命中关键词的**个数**（`:219-221`）。
3. **SQL 预截断按时间而非相关性**：`:215` 先按 `published_at DESC` 取 `top_k * 3` 条候选，再在 Python 内重排。因此一条标题全命中但发布较早的资料，可能**根本进不了候选池**，重排无从挽回。
4. **正文命中不加分**：`score()` 只统计 `w in title`（`:221`），仅正文命中的资料得分恒为 0，排序完全由 `published_at` 决定。
5. **提示词长度无上限**：`format_context` 拼接每条资料的 `content` **全文**（`:254`），而 `_validate` 对 `content` 只校验非空、**不限长度**（`:60-62`），DB 列为 `TEXT`（`docker/init/021_ai_center.sql:14`）。上层唯一的约束是条数 `knowledge_top_k`（env 默认 4，最大可配 20，`backend/app/services/ai_config_service.py:54`），因此单条超长资料即可显著撑大提示词与 token 消耗。
6. **`_keywords` 的 `limit=12` 硬编码**：`search_published:204` 调用时未传 `limit`，管理端无法调节召回宽度（`AI_KNOWLEDGE_TOP_K` 只控制返回条数，不控制关键词数）。
7. **`search_published` 的 `category` 参数是死参数**：3 处调用全部省略（`backend/app/services/ai_chat_service.py:210-212`、`:215`、`:376`），全仓无传值方。
8. **`logger` 定义后未使用**：`:8` import `logging`、`:18` `logger = logging.getLogger(__name__)`，全文件无任何 `logger.*` 调用（grep 只命中 `:18`）。
9. **`list_knowledge` 的两处边界**：`node_id` 用真值判断（`:120`），`node_id=0` 等同不过滤；`keyword` 的 `%`/`_` 未转义（`:124`），搜索字面量通配符会得到非预期结果。
10. **`update_knowledge` 全量覆盖 + `status` 默认 `draft` 的静默降级风险**：`:159-160` 对 `_validate` 返回的全部 7 键 `setattr`，而 `AdminAiKnowledgeUpsert.status` 默认值为 `"draft"`（`backend/app/schemas/schemas.py:1716`）。若调用方编辑一条**已发布**资料时未在请求体带上 `status`，该资料会被静默改回草稿并**立即从 AI 检索中消失**。管理端知识库页面**待开发**（§9.3），目前该风险没有 UI 侧防护，只有 s26 K03 用例覆盖了「带全字段编辑」的路径（`backend/test/s26_ai_center.py:315`）。
11. **`set_status` 与 `update_knowledge` 对 `published_at` 的处理不一致**：`:161` 有 `was_published` 守卫（重复发布不刷新），`:177-179` 无守卫（每次 PATCH 到 published 都刷新 `published_at`）。由于 `published_at` 是检索排序键（§7），反复 PATCH 发布会**改变该资料的召回优先级**。是否属预期——待确认。
12. **无并发控制**：无 version 列、无行锁，两管理员同时编辑为 last-write-wins；同标题资料可无限重复创建（无唯一约束）。
13. **物理删除不可恢复**（`:189`），且 `archived` 这一软删状态未被任何代码写入（§7）。
14. **外键无 `ON DELETE` 行为**：`ai_knowledge.node_id REFERENCES route_nodes(id)`（`docker/init/021_ai_center.sql:18`）未指定 `ON DELETE`，默认 NO ACTION，因此删除一条被知识资料绑定的路线节点会触发外键约束错误。`backend/app/models/models.py:562-564` 同样未声明 `ondelete`（对比 `ai_messages.conversation_id` 显式声明了 `ON DELETE CASCADE`，`docker/init/021_ai_center.sql:40`）。
15. **性能画像**：`list_knowledge` 每次请求 1 次 COUNT + 1 次分页 SELECT（`:128-134`），无 N+1；`search_published` 单次查询但含最多 24 个**前导通配** LIKE（`:209-214`），B-tree 索引不可用，实际为 `status` 过滤后的顺序扫描（可用 `ix_ai_knowledge_status_cat`，`docker/init/021_ai_center.sql:95-96`）；`backend/app/services/ai_chat_service.py:210` 与 `:215` 在「节点追问」场景会对同一问题**连续调用两次** `search_published`，即一次 chat 请求最多扫描两遍。`:4-5` 已声明这是「适配管理端人工维护的**小规模**知识库」的取舍——资料量增长后需重新评估（符合根 `agents.md` §2.4「大数据量性能保障」的主动评估要求）。

### 9.3 待开发

- **管理端「AI 知识库」页面：待开发。** 6 个接口（`GET/POST /api/admin/ai/knowledge`、`GET/PUT/DELETE /api/admin/ai/knowledge/{kid}`、`PATCH /api/admin/ai/knowledge/{kid}/status`）已在 `backend/app/api/routes/ai_admin.py:76-196` 就绪，菜单码 `ai_knowledge` 已由 `docker/init/022_ai_admin_menus.sql:17-18` 落库，但 `admin/src/router/menus.ts` **尚未登记任何 `ai_` 菜单码**（实测 grep 无命中）。这是 Phase A 的**预期状态，不是缺陷**（`.qoder/ARCHITECTURE.md` §11.3、`.qoder/REQUIREMENTS.md` §10.6）。
- **向量/语义检索：待开发**（`:5` 明示「V1.0 未接入」）。
- **`pending`（待审核）流转链路：待开发**——状态值合法但无写入路径，需管理端页面落地后才形成「草稿 → 待审核 → 发布/驳回」的完整流程。
- 本文档所述 6 个接口目前**只有 s26 冒烟（SQLite TestClient + 真库校验）覆盖，无浏览器验收报告**（管理端页面尚未开发，无从验收）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/services/ai_knowledge_service.py`（**仅 1 个提交**）与 `docs/迭代记录.md` 对应条目。工作区当前无本文件的未提交改动（`git status --short backend/app/services/` 为空）。

### 2026-10-17（`1600074`，见 `docs/迭代记录.md` 该提交条目）

- 需求：《长征步迹 AI 智能中心开发需求 V1.0》Phase A 后端 —— §3.1 历史助手、§3.2 路线节点讲解、§3.3 答题解析、**§3.4 管理端接口（知识库/配置/题目工坊持久化/菜单鉴权 require_menu）**。本文件承担其中的知识资料管理与「仅已发布」检索。
- 修改内容（涉本文件）：**新建**，255 行全量新增（`git show 1600074 --stat` 记 `255 ++++`）。含 5 个模块常量、`_keywords` 中文分词降级、`_validate` 七字段校验、CRUD 四函数、`list_knowledge` 分页、`search_published` 关键词检索、`published_for_node`、`format_sources` / `format_context` 两个格式化输出。
- 关联文件：`backend/app/services/ai_chat_service.py`（新建，主要消费方）、`ai_config_service.py`、`ai_usage_service.py`、`ai_question_service.py`（`format_context` 复用于出题参考资料）、`cloudbase_service.py`（重构）、`backend/app/api/routes/ai.py`、`ai_admin.py`（新建）、`backend/app/models/models.py`（`AiKnowledge` 等 6 个模型）、`backend/app/schemas/schemas.py`、`docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql`（`docker/` 按仓库规则不随提交）、`backend/test/s26_ai_center.py`。
- 测试结果（`docs/迭代记录.md` 的 `1600074` 条目验证字段原文）：冒烟 `test/s26_ai_center.py` **47/47**（含真实 Agent 调用 L01：reply 143 字、usedTokens=19715；**空来源场景模型拒答不编造**）；真库校验——迁移应用/表索引菜单齐备/ORM 与真库列 ALL_MATCH/JSON round-trip 后回滚、真库真实 Agent 对话一次（reply 194 字、usedTokens=431）；报告 `backend/test/docs/s26-ai-center-report.md`。**管理后台 Vue 子页面**、usage/cost 页、node-detail 讲解面板、答题页 AI 讲解按钮按需求 §13 留后续阶段。
- 与本文件直接相关的用例（`backend/test/s26_ai_center.py`）：K01 新增草稿成功（`:297`）、K02 状态流转发布后 `published_at` 落定且按状态+节点可检索（`:305`）、K03 编辑成功（`:315`）、K04 空标题/非法分类/节点不存在均 400（`:321`）、K05 无 `ai_knowledge` 菜单的管理员读写均 403（`:327`）、K06 删除后再查 404（`:336`）、K07 增删改响应不泄露密钥（`:340`）、R02/R03 无已发布知识时回退节点字段且**草稿内容绝不出现**（`:481`）、H12 回答附带后端核验的已发布知识来源（`:398`）。

### 后续（未发生，仅登记待办来源）

本文件自 `1600074` 起**无任何后续提交**。`.qoder/ARCHITECTURE.md` §11.3 与 `.qoder/REQUIREMENTS.md` §10.6 所列的后续阶段待办中，与本文件相关的是「管理后台 AI 知识库子页面」与「向量检索」，二者均为**待开发**，尚无提交号。
