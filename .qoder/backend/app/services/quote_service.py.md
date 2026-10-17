# quote_service.py

## 1. 文件路径

`backend/app/services/quote_service.py`（197 行）

## 2. 文件职责

「每日寄语」的服务层：把后台维护的**有出处史料语录**按天循环投放到小程序首页，并向管理端提供寄语的增删改查、启用开关、排序号维护、循环起始日期设置与字段校验。

核心设计是**无状态、无定时任务**：今日展示哪一条完全由「（今天 − 循环起始日）% 启用条数」即时算出（`backend/app/services/quote_service.py:3-5` 文档串），因此重启、多实例、跨用户结果都一致。

## 3. 业务需求

| 来源 | 说明 |
|---|---|
| 需求 §16（原始需求文档编号） | 文件头文档串 `backend/app/services/quote_service.py:1` 自述「需求 §16、V1.1 功能二」。`.qoder/` 下未单独收录该编号的原文，需求细节以本文档「7. 业务规则」中代码可验证的部分为准 |
| `.qoder/REQUIREMENTS.md` | **无独立的「每日寄语」章节**；仅 §11.5 表格中 `QuotesView`（金句管理：增删改查 + 周期）一行、§11.6 表格中的通用 Excel 导入导出规则与本文件相关 |
| `.qoder/ARCHITECTURE.md` | 分层约定（`api/routes → services → models`）与 §9.4「事务边界不统一」适用于本文件（见「7. 业务规则」末条） |
| `docs/迭代记录.md` | 提交级历史的权威出处：`71d1b9b`（2026-10-03 首版，按日期绑定）、`d6acf7e`（2026-10-11 改为按天循环 + Excel 导入）、`30b4458`（2026-10-11 服务端搜索 + LIKE 转义） |

**规则已变更提示**：V1 版本（`71d1b9b`）是「一天一条、`date` 列唯一、当天没有则回退到最近一条更早的寄语」，该规则已在 `d6acf7e` 整体废弃（`daily_quotes.date` 列被删除，见 `docker/init/013_daily_quote_cycle.sql:35`）。`backend/test/docs/p2-quotes-report.md` 记录的是**旧规则**，仅作历史证据，不代表现行实现。

## 4. 核心功能

### 4.1 模块常量

| 常量 | 行号 | 值 / 含义 |
|---|---|---|
| `CYCLE_START_KEY` | `backend/app/services/quote_service.py:18` | `"quote_cycle_start"`，`system_settings` 中存循环起始日期的键名 |
| `DEFAULT_CYCLE_START` | `backend/app/services/quote_service.py:20` | `"2026-10-01"`，仅用于**配置为空**的环境兜底；`:19` 注释说明 013 迁移会写入配置 |
| `CONTENT_MAX_LEN` | `backend/app/services/quote_service.py:21` | 200，寄语内容字数上限 |
| `SOURCE_MAX_LEN` | `backend/app/services/quote_service.py:22` | 200，出处字数上限 |
| `SORT_ORDER_MAX` | `backend/app/services/quote_service.py:23` | 999999，排序号上限 |
| `_DATE_RE` | `backend/app/services/quote_service.py:25` | `^\d{4}-\d{2}-\d{2}$`，日期字符串格式白名单 |

三个上限常量被 `backend/app/services/import_service.py:307-309`（Excel 模板填写说明文案）与 `:331`、`:405`（导入行校验与自动排序号封顶）复用，是**管理端表单与批量导入的唯一口径来源**。

### 4.2 `parse_date(value)` — `backend/app/services/quote_service.py:28-35`

先用 `_DATE_RE` 卡格式，再用 `date.fromisoformat` 卡真实日期（拦截 `2026-02-30` 这类）；两步任一失败返回 `None`，**不抛异常**。`:30` 的 `value or ""` 兼容 `None` 入参。

### 4.3 `_node_names(db, node_ids)` — `backend/app/services/quote_service.py:38-42`

批量把节点 id 换成节点名：`node_ids` 为空直接返回 `{}`（不发 SQL），否则**一条** `RouteNode.id IN (...)` 查询返回 `{id: name}`。这是本文件避免 N+1 的关键手段，`list_quotes`（`:154`）、`get_today`（`:79`）、`get_admin_out`（`:195`）三处都用它。

### 4.4 循环起始日期读写

| 函数 | 行号 | 行为 |
|---|---|---|
| `get_cycle_start(db)` | `backend/app/services/quote_service.py:48-49` | 读 `system_settings`；未配置时回落 `DEFAULT_CYCLE_START`。**每次调用都查库，无缓存** |
| `set_cycle_start(db, start_date)` | `backend/app/services/quote_service.py:52-56` | 格式非法抛 `ValueError("循环起始日期格式须为 YYYY-MM-DD")`；写值委托 `setting_service.set_value`，**自己 `db.commit()`（`:56`）** |

`setting_service.set_value` 的文档串明确「调用方负责提交」（`backend/app/services/setting_service.py:16`），所以这里的 `commit` 是契约要求，不是多余动作。

### 4.5 `_pick(db, today)` — `backend/app/services/quote_service.py:59-69`（循环命中的唯一实现）

返回 `(今日寄语行, 索引, 启用总数)`：

1. `:61` 构造启用寄语查询 `DailyQuote.is_enabled IS TRUE`；
2. `:62` `count()` 取启用总数 `total`；
3. `:63-64` `total == 0` 时返回 `(None, -1, 0)`——**无启用寄语不报错**；
4. `:65` 取起始日期，`parse_date` 失败再兜底 `DEFAULT_CYCLE_START`；
5. `:66` `days = (今天 − 起始日).days`；
6. `:67` `index = days % total if days >= 0 else 0`——起始日在未来时兜底第 1 条；
7. `:68` `ORDER BY sort_order ASC, id ASC` + `OFFSET index LIMIT 1` **单行取数，不全量加载**，命中索引 `ix_daily_quotes_cycle (is_enabled, sort_order, id)`（`backend/app/models/models.py:88`、`docker/init/013_daily_quote_cycle.sql:37`）。

`get_today` 与 `get_cycle_info` 都走这一条路径，保证「小程序看到的今日寄语」与「管理端循环概览里的今日寄语」必然一致。

### 4.6 `get_today(db, today)` — `backend/app/services/quote_service.py:72-82`

小程序侧出口。`_pick` 命中后，若 `node_id` 非空则查节点名（`:78-81`），组装 `{id, date, content, source, node}`；`node` 为 `{id, name}` 或 `None`。返回的 `date` 直接用**入参 `today`**（当天业务日期），不是寄语自身的日期——因为寄语已经不再绑定日期。

### 4.7 `get_cycle_info(db, today)` — `backend/app/services/quote_service.py:85-93`

管理端循环概览：`{start_date, enabled_count, today_quote_id, today_position}`。`today_position` 为 `index + 1`（从 1 起），无启用寄语时为 `0`。

### 4.8 校验

| 函数 | 行号 | 行为 |
|---|---|---|
| `check_fields(content, source, sort_order)` | `backend/app/services/quote_service.py:99-111` | **纯内存校验、不查库**。依次校验：内容非空、内容 ≤200 字、出处非空、出处 ≤200 字、排序号在 `0~999999`。返回中文错误串或 `None` |
| `validate_quote(db, content, source, sort_order, node_id)` | `backend/app/services/quote_service.py:114-121` | 先调 `check_fields`，再校验 `node_id` 指向的 `route_nodes` 行存在（`:119`），否则返回「关联节点不存在」 |

`check_fields` 被 `backend/app/services/import_service.py:333` 复用做 Excel 逐行校验，因此**表单与导入的错误文案完全一致**；`import_service.py:335-336` 还依赖「错误信息以字段名开头」这一隐含约定来定位出错列。

### 4.9 管理端 CRUD

| 函数 | 行号 | 事务 |
|---|---|---|
| `_admin_item(row, node_name)` | `backend/app/services/quote_service.py:124-133` | 纯组装，7 个字段 |
| `list_quotes(db, page, page_size, keyword)` | `backend/app/services/quote_service.py:136-155` | 只读。`keyword` 非空时对 `content` / `source` 做 `OR` 模糊匹配，**`contains(word, autoescape=True)`（`:143-144`）转义 LIKE 通配符**；再 `count()` + 分页查询 + 一次 `_node_names` 批量取节点名。共 3 条 SQL，无 N+1 |
| `create_quote(db, data)` | `backend/app/services/quote_service.py:158-168` | `content` / `source` 写入前 `.strip()`；**`sort_order` 原样存调用方传入值，不做自动编号**；`db.commit()` 在 `:167` |
| `update_quote(db, quote_id, data)` | `backend/app/services/quote_service.py:171-181` | 行不存在返回 `None`（由路由转 404）；全字段覆盖写；`db.commit()` 在 `:180` |
| `delete_quote(db, quote_id, data)` | `backend/app/services/quote_service.py:184-190` | **物理删除**（`db.delete`），行不存在返回 `False`；`db.commit()` 在 `:189` |
| `get_admin_out(db, row)` | `backend/app/services/quote_service.py:193-196` | 单条输出，补 `node_name` |

### 4.10 排序号自动编号（**不在本文件**）

`create_quote` 不自动编号；自动编号只在批量导入路径：`backend/app/services/import_service.py:395-410` 的 `confirm_quote_import` 内，`db_max = max(DailyQuote.sort_order) or 0`（`:399`）、与文件内已填最大值取大后 `+1`（`:401`）、逐行 `min(next_order, quote_service.SORT_ORDER_MAX)` 封顶（`:405`）。该处**无并发保护**（见「9. 当前实现状态」）。

### 4.11 HTTP 出口一览

| 方法 + 路径 | 路由定义 | 权限依赖 | 调用的服务函数 | `response_model` |
|---|---|---|---|---|
| `GET /api/quotes/today` | `backend/app/api/routes/quotes.py:17-20` | `get_current_user` | `get_today(db, today_str())` | `Optional[QuoteTodayOut]`（`backend/app/schemas/schemas.py:337-344`） |
| `GET /api/admin/quotes` | `backend/app/api/routes/admin.py:542-555` | `require_menu("quotes")`（`:546`） | `list_quotes` | `AdminQuoteListOut`（`backend/app/schemas/schemas.py:1084-1086`） |
| `GET /api/admin/quotes/cycle` | `backend/app/api/routes/admin.py:558-565` | `require_menu("quotes")`（`:562`） | `get_cycle_info` | `AdminQuoteCycleOut`（`backend/app/schemas/schemas.py:1099-1105`） |
| `PUT /api/admin/quotes/cycle` | `backend/app/api/routes/admin.py:568-579` | `require_menu("quotes")`（`:572`） | `set_cycle_start` → `get_cycle_info` | `AdminQuoteCycleOut` |
| `GET /api/admin/quotes/import-template` | `backend/app/api/routes/admin.py:582-588` | `require_menu("quotes")`（`:585`） | 经 `import_service.build_quote_template`（`backend/app/services/import_service.py:321-323`）使用本文件常量 | xlsx 文件流 |
| `POST /api/admin/quotes/import-preview` | `backend/app/api/routes/admin.py:591-605` | `require_menu("quotes")` 以参数形式注入（`:599`） | 经 `import_service.preview_quote_import`（`:358`）调用 `check_fields` | `AdminImportPreviewOut` |
| `POST /api/admin/quotes/import-confirm` | `backend/app/api/routes/admin.py:608-619` | `require_menu("quotes")`（`:612`） | 经 `import_service.confirm_quote_import`（`:395`）使用 `SORT_ORDER_MAX` | `AdminImportConfirmOut` |
| `POST /api/admin/quotes` | `backend/app/api/routes/admin.py:622-633` | `require_menu("quotes")`（`:626`） | `validate_quote` → `create_quote` → `get_admin_out` | `AdminQuoteOut`（`backend/app/schemas/schemas.py:1072-1081`） |
| `PUT /api/admin/quotes/{quote_id}` | `backend/app/api/routes/admin.py:636-650` | `require_menu("quotes")`（`:640`） | `validate_quote` → `update_quote` → `get_admin_out` | `AdminQuoteOut` |
| `DELETE /api/admin/quotes/{quote_id}` | `backend/app/api/routes/admin.py:653-662` | `require_menu("quotes")`（`:657`） | `delete_quote` | `MessageOut` |

**这些接口都不挂活动守卫**（既非 `require_activity_participation` 也非 `require_activity_view`），即活动未发布 / 已结束后寄语仍可读取。活动闸门清单见 `.qoder/backend/app/services/activity_service.py.md`。

## 5. 输入与输出

### 5.1 输入

| 参数 | 类型 / 约束 | 来源 |
|---|---|---|
| `db` | SQLAlchemy `Session` | `get_db`（`backend/app/core/database.py`） |
| `today` | `str`，`YYYY-MM-DD` | 路由层 `today_str()`（`backend/app/core/helpers.py:22-24`，固定北京时间 UTC+8） |
| `page` / `page_size` | `Query(1, ge=1)` / `Query(20, ge=1, le=100)` | `backend/app/api/routes/admin.py:549-550` |
| `keyword` | `Query("", max_length=64)` | `backend/app/api/routes/admin.py:551` |
| `data` | `AdminQuoteUpsert.model_dump()`（`backend/app/schemas/schemas.py:1089-1096`）：`content: str`、`source: str`、`sort_order: int = 0`、`is_enabled: bool = True`、`node_id: Optional[int] = None` | `backend/app/api/routes/admin.py:629`、`:643` |
| `start_date` | `AdminQuoteCycleUpdate.start_date: str`（`backend/app/schemas/schemas.py:1108-1111`） | `backend/app/api/routes/admin.py:576` |

### 5.2 输出

- `get_today` → `dict | None`，键为 `id` / `date` / `content` / `source` / `node`；经 `QuoteTodayOut`（`CamelModel`，`backend/app/schemas/schemas.py:17-22`）序列化为小程序侧 camelCase（`nodeId` 等嵌套在 `node` 对象内）。无启用寄语时接口返回 `null`（`response_model=Optional[...]`）。
- `get_cycle_info` → `dict`：`start_date` / `enabled_count` / `today_quote_id` / `today_position`；管理端为 snake_case（`AdminQuoteCycleOut` 继承普通 `BaseModel`）。
- `list_quotes` → `(total: int, items: List[dict])`，路由再包成 `{total, items}`。
- `create_quote` / `update_quote` → `DailyQuote` ORM 实例（或 `None`），由 `get_admin_out` 转 dict。
- `delete_quote` → `bool`。
- `check_fields` / `validate_quote` → `Optional[str]`（错误文案，`None` 表示通过）。
- `set_cycle_start` → `None`，失败抛 `ValueError`。

### 5.3 异常与错误码

| 场景 | 抛出位置 | HTTP |
|---|---|---|
| 循环起始日期格式非法 | `quote_service.py:54` `ValueError` | 400，`backend/app/api/routes/admin.py:577-578` 捕获转 `HTTPException` |
| 内容/出处为空、超长、排序号越界、关联节点不存在 | `quote_service.py:99-121` 返回错误串 | 400，`backend/app/api/routes/admin.py:631-632`、`:645-646` |
| 编辑/删除的寄语不存在 | `quote_service.py:173`、`:186` 返回 `None` / `False` | 404，`backend/app/api/routes/admin.py:648-649`、`:660-661` |
| 导入文件格式/表头/行数/内容错误 | `import_service.ImportError` | 400，`backend/app/api/routes/admin.py:604-605` |
| 预览令牌过期或重复确认 | `ValueError` | 400，`backend/app/api/routes/admin.py:617-618` |
| 无 Token / 无 `quotes` 菜单权限 | 依赖层 | 401 / 403 |

`_pick` 内部的 `date.fromisoformat(today)`（`:66`）**未做 try 包裹**，若调用方传入非法 `today` 会抛 `ValueError` 冒泡成 500；现网唯一调用方 `backend/app/api/routes/quotes.py:20` 传的是 `today_str()`，格式受控。

## 6. 依赖关系

### 6.1 本文件依赖

| 依赖 | 行号 | 用途 |
|---|---|---|
| `re` / `datetime.date` / `typing` | `backend/app/services/quote_service.py:8-10` | 日期解析与类型标注 |
| `sqlalchemy.or_` | `backend/app/services/quote_service.py:12` | 关键字模糊搜索的 OR 条件 |
| `app.models.models.DailyQuote` | `backend/app/services/quote_service.py:15`；模型定义 `backend/app/models/models.py:81-95` | 表 `daily_quotes` |
| `app.models.models.RouteNode` | `backend/app/services/quote_service.py:15`；模型定义 `backend/app/models/models.py:32-58` | 关联节点名与存在性校验 |
| `app.services.setting_service` | `backend/app/services/quote_service.py:16` | 读写 `system_settings` 中的 `quote_cycle_start` |

**不依赖** `core/config`（无配置项）、`core/helpers`（业务日期由路由层传入）、`audit_service`（寄语变更不写审计）。

### 6.2 数据库对象

| 对象 | 定义位置 |
|---|---|
| 表 `daily_quotes` | 建表 `docker/init/007_daily_quotes.sql:8`；改造 `docker/init/013_daily_quote_cycle.sql:8-9`（加 `sort_order` / `is_enabled`）、`:35`（删 `date` 列） |
| 索引 `ix_daily_quotes_cycle (is_enabled, sort_order, id)` | `docker/init/013_daily_quote_cycle.sql:37`；ORM 侧 `backend/app/models/models.py:88` |
| 表 `system_settings` | 建表 `docker/init/013_daily_quote_cycle.sql:23-27`；ORM `backend/app/models/models.py:98-105` |
| 外键 `daily_quotes.node_id → route_nodes.id` | `backend/app/models/models.py:93` |

`sort_order` **没有唯一约束**（`daily_quotes` 的 `__table_args__` 只有一个普通索引，`backend/app/models/models.py:88`），允许重复；重复时由 `id` 升序决定先后（`backend/app/services/quote_service.py:68`）。

### 6.3 被谁依赖

| 调用方 | 行号 |
|---|---|
| `backend/app/api/routes/quotes.py` | `:11` 导入、`:20` 调用 `get_today` |
| `backend/app/api/routes/admin.py` | `:94` 导入；`:554`、`:565`、`:576`、`:579`、`:630`、`:633`、`:644`、`:647`、`:650`、`:660` |
| `backend/app/services/import_service.py` | `:22` 导入；`:307-309`（模板文案）、`:331`、`:333`、`:405` |
| 路由注册 | `backend/app/main.py:83`（quotes）、`:86`（admin） |

### 6.4 前端消费方

| 端 | 位置 |
|---|---|
| 小程序 | `frontend/services/quote.js:10-12` 封装 `GET /quotes/today`；`frontend/pages/home/home.js:14` 引入、`:165` 与首页其它请求并发调用且 `catch(() => null)` 容错 |
| 管理后台 | `admin/src/api/admin.ts:714-743`（列表/新增/编辑/删除/循环读写/模板下载/预览/确认）；页面 `admin/src/views/QuotesView.vue`，路由 `admin/src/router/index.ts:57-60`，菜单码 `admin/src/router/menus.ts:9` |

### 6.5 种子数据

`backend/app/data/seed.py:47-78` 定义 `QUOTES`（5 条毛泽东著作语录，`sort_order` 1~5，按语义关联节点）；`_seed_quotes`（`backend/app/data/seed.py:405-412`）**仅在表为空时写入**，之后完全交由后台维护，`init_seed`（`:415-424`）在启动时幂等调用。

## 7. 业务规则

1. **循环命中公式**：启用寄语按 `(sort_order, id)` 升序共 N 条，起始日 `start` 对应第 1 条，今日索引 = `(today − start).days % N`（`backend/app/services/quote_service.py:3-4`、`:66-67`）。
2. **同一天所有用户结果一致**：索引只依赖日期与启用列表，与用户无关（`:4`）。
3. **起始日在未来**：`days < 0` 时兜底展示第 1 条（`:67`）。
4. **N = 0**：接口返回 `null`，不报错（`:63-64`、`backend/app/api/routes/quotes.py:19`）。
5. **即时生效**：增删、启停、改排序号后按最新启用列表重算，无缓存、无定时任务（`:6`）。副作用是**同一天内管理端改动会导致当日寄语立即切换**。
6. **业务日期口径**：`today` 由路由层用 `today_str()` 传入，固定北京时间 UTC+8（`backend/app/core/helpers.py:3-4`、`:22-24`），不依赖服务器时区。
7. **内容规范**：必须是**有明确出处的史料语录**，不得虚构（`backend/app/data/seed.py:45`、`backend/app/services/import_service.py:307-308`）；出处填写作者及著作。
8. **关联节点**：`node_id` 可空；关联后小程序可从寄语卡跳转节点详情（`backend/app/services/import_service.py:312`）。校验节点存在性在 `:119`。
9. **搜索**：`keyword` 对内容与出处做 OR 模糊匹配，**LIKE 通配符已转义**（`:143-144`，`30b4458` 修复）；搜索在服务端执行、作用于全表而非当前页。
10. **删除为物理删除**：无软删标记，删除后该条退出循环，N 减 1，后续索引整体前移。`daily_quotes` 没有被其它表外键引用，物理删除无级联风险。
11. **事务边界**：`set_cycle_start`（`:56`）、`create_quote`（`:167`）、`update_quote`（`:180`）、`delete_quote`（`:189`）**均由服务层自己 commit**；批量导入的写入则由 `import_service.confirm_quote_import` 在整批事务内提交（本文件不参与）。这属于 `.qoder/ARCHITECTURE.md` §9.4 记录的「事务边界不统一」中的一种：本文件与 `activity_service` 同属「服务层自提交」派。
12. **不写审计**：寄语 CRUD、启停、排序调整、循环起始日期修改**均不调用 `audit_service.record`**（本文件无该导入，`backend/app/api/routes/admin.py:542-662` 也无审计调用）。与活动配置（`backend/app/services/activity_service.py:182-185` 写审计）不同。
13. **权限**：小程序侧仅需登录（`get_current_user`），管理端全部 10 个接口需 `quotes` 菜单权限。

## 8. 修改约束

1. **不要重新引入 `date` 列语义**。`docker/init/013_daily_quote_cycle.sql:35` 已删除该列，V1 的「当天优先、否则回退最近一条」规则已废弃；`backend/test/docs/p2-quotes-report.md` 只是历史记录。
2. **`_pick` 是今日寄语的唯一实现**，`get_today` 与 `get_cycle_info` 必须继续共用它，否则小程序与管理端会出现「概览说今天是第 3 条、用户看到第 5 条」的分裂。
3. **排序必须保持 `(sort_order ASC, id ASC)`**。`OFFSET` 取数依赖排序完全确定；`sort_order` 无唯一约束，去掉 `id` 兜底会让同一天的命中结果在不同查询计划下漂移。三处排序（`:68`、`:149`）与索引列顺序（`docker/init/013_daily_quote_cycle.sql:37`）需同步修改。
4. **`check_fields` 的错误文案被导入侧当作结构化信息使用**：`backend/app/services/import_service.py:335-336` 用「错误串以哪个表头开头」来定位出错列。改文案（例如把「寄语内容不能为空」改成「内容必填」）会静默破坏导入的错误列定位。
5. **三个上限常量是模板文案与导入校验的共同来源**（`backend/app/services/import_service.py:307-309`、`:331`、`:405`），改值时导入侧自动跟随，不要另立一套常量。
6. **`set_cycle_start` 的 `ValueError` 是路由 400 的唯一依据**（`backend/app/api/routes/admin.py:577-578`），不要改成返回布尔或抛其它异常类型。
7. **迁移脚本不可回改**。`docker/init/013_daily_quote_cycle.sql` 已在本地 openGauss 执行并登记 `schema_migrations`（`docs/迭代记录.md` 的 `d6acf7e` 条目），按仓库规则不得编辑已执行的编号脚本；需要变更时新增编号迁移。
8. **种子只在空表写入**（`backend/app/data/seed.py:407-408`）。不要改成「非空也补齐」，否则会复活运营已删除的寄语。
9. **不要在本文件内写死业务日期**，`today` 一律由调用方注入（便于测试与统一时区口径）。
10. **响应命名契约**：小程序侧走 `CamelModel`、管理端走普通 `BaseModel`（snake_case），见 `.qoder/backend/app/schemas/schemas.py.md`。改 schema 基类会同时改变两端字段名。

## 9. 当前实现状态

### 已实现

- 按天循环展示（无定时任务、无缓存、多实例一致）：`_pick` / `get_today`。
- 管理端分页列表 + 服务端关键字搜索（LIKE 已转义）。
- 管理端新增 / 编辑 / 删除 / 循环起始日期读写。
- 字段与关联节点校验，且与 Excel 导入共用同一套校验。
- 无启用寄语时优雅降级为 `null`（V1 实现在空表时会 500，`docs/迭代记录.md` 的 `d6acf7e` 条目记录该缺陷，已由 `d6acf7e` 修复）。

### 存在问题 / 风险

1. **`get_cycle_info` 重复读取循环起始日期**：`_pick` 内部已经调过一次 `get_cycle_start`（`:65`），`:89` 又调一次，产生一次多余的 `system_settings` 查询。功能正确，属可优化项。
2. **`get_cycle_start` 无缓存**：每次 `_pick` 都查一次 `system_settings`。`GET /api/quotes/today` 是首页并发请求之一（`frontend/pages/home/home.js:165`），高频访问下该单行查询会被反复执行。
3. **`_pick` 的 `count()` + `OFFSET` 是两条 SQL**，`OFFSET` 在启用条数很大时仍需跳过前 index 行。当前种子仅 5 条，实际影响可忽略；若寄语规模上千需重新评估。
4. **导入侧自动排序号无并发保护**：`backend/app/services/import_service.py:399` 用 `max(sort_order)` 读当前最大值后在应用层递增，两个管理员同时确认导入会得到重复的 `sort_order`。因 `daily_quotes` 无 `sort_order` 唯一约束，**不会报错**，只会让循环顺序按 `id` 兜底，与运营预期可能不符。
5. **寄语变更不写审计**：与活动配置、题库等管理操作不一致，出问题时无法追溯是谁改了哪条寄语。是否需要补审计**待确认**（无需求依据）。
6. **同一天内管理端启停会立刻改变当日寄语**（规则 5 的副作用）。这是设计选择而非缺陷，但运营侧需要知晓。

### 待开发

- 无。`.qoder/REQUIREMENTS.md` §13 待开发清单中不含每日寄语相关条目。

### 待确认

- **生产库 `quote_cycle_start` 的实际值**：属运行时数据，不在仓库。开发库实测为 `2026-10-01`（`backend/test/docs/s17-quote-cycle-import-report.md` 第 1 节「变更要点」表）。
- **需求 §16 原文**：`.qoder/` 未收录，本文件对「§16」的引用仅来自代码文档串自述。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/services/quote_service.py`（3 个提交）与 `docs/迭代记录.md`。按时间倒序。

### 2026-10-11

- 需求：管理后台代码审查修复（逻辑 / 冗余 / 大数据量性能）。
- 修改内容：`GET /admin/quotes` 新增 `keyword`，寄语改为**服务端搜索**（原来只过滤当前页）；寄语搜索对 **LIKE 通配符做转义**。对应本文件 `backend/app/services/quote_service.py:136-155` 的 `list_quotes` 与 `:143-144` 的 `contains(word, autoescape=True)`。
- 关联文件：`backend/app/api/routes/admin.py:542-555`、`admin/src/api/admin.ts:714-718`、`admin/src/views/QuotesView.vue`。
- 测试结果：`docs/迭代记录.md` 的 `30b4458` 条目原文——「admin `npm run build` 通过。后端回归 p2_quotes 4/4、s9 30/30、s8 23/23、s12 11/11、s4 13/13、e2e_datasync 23/23。浏览器验收通过：菜单、趋势切换、驾驶舱/大屏实时推送防抖、审计本地时间、寄语与题库服务端搜索、分页/筛选单次请求、组织树与成员明细、授权弹窗、扫码轮询启停、排名洞察。」（提交 `30b4458`）
  > 注：此处引用的 `p2_quotes` 脚本已在同日 `d6acf7e` 中删除（见下条），该 4/4 结果是删除前的回归记录。

- 需求：每日寄语按天循环展示与 Excel 批量导入（新功能 / 缺陷修复）。**这是本文件现行实现的主要来源。**
- 修改内容：
  - 循环模型：新增迁移 `docker/init/013_daily_quote_cycle.sql`；寄语改用**排序号 + 启用状态**，删除 `date` 列，新增 `system_settings` 表存循环起始日期；今日寄语取法改为「启用寄语按（排序号, id）排序，取第 `(今天 − 起始日) % 启用数` 条」；新增 `setting_service`；新增 `GET/PUT /api/admin/quotes/cycle`。
  - 导入：新增模板下载 / 预览 / 确认三个接口，复用题库导入框架（预览令牌、≤2MB、≤500 行、公式注入拦截、整批事务）；错误定位到行与字段；重复内容拒绝导入不覆盖；排序号留空时按库内与文件内最大值依次加 1。
  - 测试脚本 `p2_quotes.py` 删除，新增 `backend/test/s17_quote_cycle_import.py`。
- 关联文件：`backend/app/services/quote_service.py`、`backend/app/services/setting_service.py`、`backend/app/services/import_service.py:301-410`、`backend/app/api/routes/admin.py:542-662`、`backend/app/models/models.py:81-105`、`docker/init/013_daily_quote_cycle.sql`、`admin/src/views/QuotesView.vue`、`admin/src/components/ExcelImportDialog.vue`。
- 测试结果：`docs/迭代记录.md` 的 `d6acf7e` 条目原文——「S17 13/13，S12 11/11，admin `npm run build` 通过。浏览器验收通过（新起后端 8011 + admin 5174）：今日位置计算、模板下载、错误导入与错误报告、重新选择文件、确认导入、行内启停、修改起始日期、编辑、删除、题库导入回归。迁移 013 已应用到本地 openGauss。」（提交 `d6acf7e`）
  用例级明细见 `backend/test/docs/s17-quote-cycle-import-report.md`（13/13，含 C01「无启用寄语：today 200 返回 null」、C07「按天循环：起始日当天第 1 条、次日第 2 条、第 3 天第 3 条，末条后回到第 1 条；起始日在未来兜底第 1 条」、C08「同一天不同用户、重复请求得到同一条」）。
  另：本缺陷的首次记录在 `docs/迭代记录.md` 的 `01e214a` 条目——「顺带发现：寄语表为空时 `GET /api/quotes/today` 返回 500，首页已容错，留待功能二修复。」

### 2026-10-03

- 需求：每日寄语与节点纪念票 P2-1（功能）——后台维护有出处语录、首页寄语卡、Canvas 节点纪念票。本文件在此提交中**新建**。
- 修改内容：新增 `daily_quotes` 表（迁移 007）、`DailyQuote` 模型、种子 `QUOTES`、`quote_service`（当时为按日期取寄语：`get_today` / `list_quotes` / `validate_quote` / `date_taken` / `create_quote` / `update_quote` / `delete_quote` / `get_admin_out`）、`GET /api/quotes/today`、管理端 `/api/admin/quotes` CRUD、`QuoteNodeRefOut` / `QuoteTodayOut` / `AdminQuote*` schema。**其中按日期绑定与 `date_taken`（日期唯一）规则已在 `d6acf7e` 废弃，本文件现已无 `date_taken` 函数。**
- 关联文件：`docker/init/007_daily_quotes.sql`、`backend/app/models/models.py:81-95`、`backend/app/data/seed.py:47-78`、`backend/app/api/routes/quotes.py`、`backend/app/api/routes/admin.py`、`backend/app/schemas/schemas.py:330-344`、`frontend/pages/home/home.js`。
- 测试结果：**待确认（`docs/迭代记录.md` 的 `71d1b9b` 条目未记录验证字段）**。可查到的同期测试证据为 `backend/test/docs/p2-quotes-report.md:33`——「执行：`python test/p2_quotes.py` —— **4/4 通过**」，`:35` 回归「`python test/p1_persons.py` 4/4、`python test/p1_portrait.py` 3/3」。该报告描述的 V1 日期规则与 P2A-02 回退用例**均已失效**，脚本 `p2_quotes.py` 已删除，报告仅作历史记录（`backend/test/docs/s17-quote-cycle-import-report.md` 首节明确标注「`p2-quotes-report.md` 仅作历史记录」）。
