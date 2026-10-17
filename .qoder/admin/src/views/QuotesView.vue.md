# QuotesView.vue

## 1. 文件路径

`admin/src/views/QuotesView.vue`（408 行）

## 2. 文件职责

「每日寄语」页（`<script setup>` 单文件组件）：`daily_quotes` 表的管理端唯一维护入口。上部为循环设置条（循环起始日期 + 启用条数/今日第几条的实时概览），下部为服务端分页列表（内容/出处模糊搜索、排序号、启用开关、关联路线节点标签、今日展示标记），支持单条新增/编辑/启停/删除与 Excel 批量导入（复用 `ExcelImportDialog.vue`，经 `quoteImportApi`）。寄语按「启用集合 (sort_order, id) 升序、自起始日期起每天轮换一条」的规则在小程序首页寄语卡展示，本页的任何增删改/启停/排序调整都会即时改变今日寄语，故所有写操作后统一走 `reloadAll`（列表 + 循环概览并刷）。

## 3. 业务需求

- **需求措辞差异**：`.qoder/REQUIREMENTS.md` 没有「每日寄语」专章，仅在 §11.5「其它管理页」以 `QuotesView` 行记作「**金句管理**（增删改查 + 周期）」；页面自身、菜单（`admin/src/router/menus.ts:9`「每日寄语」）与后端注释均称「每日寄语」。两者指同一功能，本文按代码用语。
- 需求原始出处：V1.0 需求文档 **§16「每日一句长征寄语」**（`docker/init/007_daily_quotes.sql` 头注释：不虚构历史名言、必须有明确出处、后台可维护、可关联历史节点）；**V1.1 功能二**改为按天循环（`docker/init/013_daily_quote_cycle.sql` 头注释、`backend/app/services/quote_service.py:1-7` 模块 docstring、本文件 `:2` 头注释均标「需求 §16、V1.1」——所指是原始需求文档的 §16，非 `.qoder/REQUIREMENTS.md` §16）。Excel 导入通用规则见 `.qoder/REQUIREMENTS.md` §11.6 与 `.qoder/ARCHITECTURE.md` §8.2。
- 演进（`git log --follow`，共 3 个提交，详见 §10）：`71d1b9b`（2026-10-03）创建（按日期绑定：form 含必填 `date` 字段，关键字为**当前页前端过滤**）→ `30b4458`（2026-10-11）搜索改服务端防抖 + 竞态守卫 → `d6acf7e`（2026-10-11）改造为「排序号 + 启用状态按天循环」（迁移 013），新增循环设置条、启用开关列、Excel 模板下载与批量导入。

## 4. 核心功能

### 4.1 路由、菜单码与前后端双重守卫

- 路由：path `/quotes`、name `quotes`、`meta.menu = 'quotes'`，懒加载本文件（`admin/src/router/index.ts:56-61`）；侧边栏「每日寄语」+ `ChatLineSquare` 图标（`menus.ts:9`）。
- 前端守卫：`router/index.ts:112-116` 无 `quotes` 码回退 `firstAllowedPath()`（`:9-12`）；`hasMenu`（`admin/src/store/auth.ts:27-29`）；侧边栏过滤 `admin/src/layout/AdminLayout.vue:15`。
- 后端守卫：本页 9 个端点全部挂 `Depends(require_menu("quotes"))`（`backend/app/api/routes/admin.py:546`、`:562`、`:572`、`:585`、`:599`、`:612`、`:626`、`:640`、`:657`）。

### 4.2 列表加载：服务端分页 + 防抖搜索 + 竞态守卫

- 状态（`:19-27`）：`loading`、`quotes`、`total`、`page`(1)、`pageSize`(**20，固定**)、`keyword`（输入框）、`appliedKeyword`（防抖生效值）、`nodes`（关联节点下拉数据源）。
- `loadQuotes`（`:31-42`）：`requestSeq` 竞态守卫（`:30`、`:32`、`:36`、`:40`），调 `fetchQuotes(page, pageSize, appliedKeyword.trim())`；`try…finally` 无 `catch`，失败依赖 `request.ts:46-48` 全局 toast 且保留旧数据。
- 服务端搜索：`quote_service.list_quotes`（`backend/app/services/quote_service.py:136-155`）对 `content`/`source` 双列 `or_ contains(autoescape=True)` LIKE（`:140-146`），排序 `sort_order asc, id asc`（`:149`，即**循环顺序**），offset/limit 分页；`page_size ≤ 100`、`keyword max_length=64`（`admin.py:550-551`）；节点名批量 `IN` 查询回填（`:154`、`:38-42`），避免 N+1。
- 防抖（`:49-58`）：`keyword` 变化 400ms 后写 `appliedKeyword`、复位 `page = 1` 并直接调 `loadQuotes`；`onBeforeUnmount` 清定时器（`:59-61`）。翻页走 `handlePageChange`（`:44-47`，赋值 + 手动加载，分页器未用 `v-model`，`:280-287`）。
- 表格（`:248-278`）：`v-loading` + `border stripe row-key="id"`；列：排序号、寄语内容（`row.id === cycle?.today_quote_id` 时前置 success 标签「今日展示」，`:252`）、出处、启用（受控 `el-switch`，`:259-263`）、关联节点（有名→danger plain 标签，无→`—`，`:266-271`）、操作（编辑/删除，`fixed="right"`）。空态仅 `el-table` 默认文案；工具栏「共 N 条」（`:241`）。

### 4.3 循环设置条（`d6acf7e` 引入）

- 状态：`cycle: QuoteCycle | null`、`startDate`、`savingCycle`（`:64-66`）；`loadCycle`（`:68-72`）拉 `GET /admin/quotes/cycle` 并把 `start_date` 回填日期选择器。
- `reloadAll`（`:75-77`）：`Promise.all([loadQuotes(), loadCycle()])`——增删改、启停、导入都会改变今日寄语，列表与循环信息必须一起刷新（`:74` 注释）；「刷新」按钮与 `onMounted` 也走它（`:245`、`:191`）。
- `handleSaveCycle`（`:79-89`）：`startDate` 为空直接返回；`PUT /admin/quotes/cycle` 成功后用响应覆盖 `cycle` 并 toast；保存按钮 `disabled = !cycle || startDate === cycle.start_date`（`:219`，未加载或日期未变时禁点）。日期选择器 `value-format="YYYY-MM-DD"`、`:clearable="false"`（`:207-214`）。
- 概览文案（`:225-229`）：「启用寄语 N 条，按排序号自起始日期起每天展示一条、循环往复」；N>0 时追加「今日展示第 X 条」（`today_position`），N=0 时提示「当前无启用寄语，小程序不展示寄语卡」。
- 后端循环规则（`quote_service.py:1-7`、`:59-69`）：今日索引 = `(today - start).days % 启用条数`，按日期即时计算（无定时任务）；today 早于 start 时兜底第 1 条；启用条数为 0 时不展示。起始日期存 `system_settings.quote_cycle_start`（`:18`、`:48-56`），未配置兜底 `2026-10-01`（`:20`）；`get_cycle_info`（`:85-93`）返回本页消费的 4 字段。

### 4.4 新增 / 编辑弹窗

- 表单 `form` 直接以 `reactive<QuoteUpsert>` 声明（`:97-103`）：content/source/sort_order(0)/is_enabled(true)/node_id(null)。`toPayload`（`:112-120`）统一 trim 文本、`Number(sort_order) || 0`，并**只挑 5 个契约字段**——因此 `handleToggle` 传 `{...row}`（含 id/node_name）也不会把多余字段发给后端（`:157`）。
- 校验 `rules`（`:105-108`）：content、source 必填（source 的报错文案即业务规则「寄语须有明确来源」）；模板层 `maxlength`：内容 200（textarea 3 行 + show-word-limit，placeholder「请输入有明确出处的语录，勿虚构」，`:304-313`）、出处 200（placeholder「如：毛泽东《七律·长征》」，`:314-316`）；排序号 `el-input-number` 0–999999（`:318`），hint「越小越靠前；排序号相同按创建先后」（`:319`，与后端 `(sort_order, id)` 排序一致）；启用开关 hint「停用后不参与每日轮换」（`:321-324`）；关联节点 `el-select clearable`「不关联」（`:325-330`），hint「关联后小程序端可从寄语卡跳转节点详情」。
- 前后端上限一致：CONTENT_MAX_LEN/SOURCE_MAX_LEN = 200、SORT_ORDER_MAX = 999999（`quote_service.py:21-23`、`check_fields` `:99-111`）。
- `openCreate`（`:122-126`）/`openEdit`（`:128-132`，经 `toPayload(row)` 回填）；`handleSave`（`:134-151`）：validate → `createQuote`/`updateQuote` → 关弹窗 → `await reloadAll()`；`saving` 锁按钮（`:334`）。失败无 `catch`，弹窗保持打开，全局 toast。
- 后端写入链：POST/PUT 均先 `quote_service.validate_quote`（字段 + **node_id 存在性**，`:114-121`；路由内联调用 `admin.py:630`、`:644`），再 `create_quote`（`:158-168`）/`update_quote`（`:171-181`，404「寄语不存在」）。**手工新增/编辑不查重**（§9 第 3 项）。

### 4.5 启用开关与删除

- `handleToggle`（`:153-163`）：`togglingId` 令当前行开关呈 loading（`:261`）；用 `updateQuote` 全量 PUT 实现启停（**无独立启停端点**）；开关是受控组件（`:model-value` 而非 `v-model`，`:260`），请求失败时 UI 不翻转；成功后 `reloadAll()`（启停直接改变今日寄语）。
- `handleDelete`（`:165-174`）：`ElMessageBox.confirm`（**无 `.catch()`**，取消即未处理 rejection，§9 第 1 项）→ `deleteQuote` → `reloadAll()`。后端为**物理删除**（`quote_service.delete_quote:184-190`，404「寄语不存在」`admin.py:659-661`）——与题库的软停用不同，删除寄语会立即改变循环序号。

### 4.6 Excel 批量导入接线（`ExcelImportDialog`）

- 组件挂接（`:289-300`）：`title="批量导入寄语"`、`unit="条"`、`item-label="条寄语"`、`template-filename="长征步迹_每日寄语导入模板.xlsx"`（与后端 `_xlsx_response` 文件名一致，`admin.py:588`）、`report-prefix="寄语导入错误报告"`、`:tips="IMPORT_TIPS"`（`:179-183`：先下模板；**排序号留空自动排在已有寄语之后、启用状态留空默认启用**；任一行失败整批禁止、与库内重复判错不覆盖）、`:api="quoteImportApi"`。
- `quoteImportApi` 三函数（`admin/src/api/admin.ts:740-744`）：`downloadTemplate → GET /admin/quotes/import-template`、`preview → POST /admin/quotes/import-preview`、`confirm → POST /admin/quotes/import-confirm`，共用 `admin.ts:639-651` 的 blob/FormData/token 封装。工具栏「下载导入模板」直接调 `importDialog?.downloadTemplate()`（`:242`，组件 `defineExpose`，`ExcelImportDialog.vue:101`）。
- `@imported="handleImported"`（`:185-188`）：`page = 1` + `reloadAll()`（导入可能改变启用集合与今日寄语）。
- 后端链路：`admin.py:582-619` → `import_service.build_quote_template`（`:321-323`）/`preview_quote_import`（`:358-392`）/`confirm_quote_import`（`:395-410`）。表头 5 列：寄语内容/出处/排序号/启用状态/关联节点（`QUOTE_HEADERS` `:302`）；行解析（`_parse_quote_row` `:326-355`）：排序号可留空（None 表示待自动分配）、须为数字；复用 `quote_service.check_fields` 校验内容/出处/排序号（`:333-336`）；启用状态接受 启用/是/1、停用/禁用/否/0，留空默认启用（`_ENABLED_ALIASES` `:318`、`:337-339`）；关联节点接受节点 ID 或**精确名称**，查不到即整行判错（`:340-348`）。查重：内容与库内或文件内重复整行判错（`:364`、`:375-381`）。确认写入：未填排序号的行按文件顺序接在 `max(库内最大, 本批已填最大) + 1` 之后，封顶 SORT_ORDER_MAX（`:398-408`）。文件级约束（.xlsx、≤2MB、≤500 行、令牌一次性 TTL 30 分钟、整批阻断、单事务）与题库相同（`admin.py:419-426`、`import_service.py:25-27`）。
- **组件内部缺陷统一见 `.qoder/admin/src/components/ExcelImportDialog.vue.md` §9**（三个入口无 catch、token 过期不自愈、模板下载无 loading 锁等），本页不重复描述。

### 4.7 关联节点下拉

- `onMounted`（`:190-199`）：先 `reloadAll()`（未 await），再 `fetchRouteNodes(true)`——`silent = true`（`admin.ts:582-584`、`request.ts:7-12`）令节点接口失败**不弹全局 toast**，`catch` 后置空数组（`:193-198`），节点下拉加载失败不阻塞寄语维护。
- 数据源为 `GET /admin/route-nodes` → `admin_service.list_route_nodes`（`backend/app/services/admin_service.py:38-40`，按 sort_order,id 全量返回，**不过滤停用节点**）；该端点挂 `require_menu("route_nodes")`（`admin.py:248`）——只有 `quotes` 码而无 `route_nodes` 码的管理员会在此得到 403（被 silent 吞掉），下拉为空但寄语文本维护不受影响（§9 第 6 项）。

## 5. 输入与输出

- 输入：无 props / 无 emits（路由页面）。隐式输入为登录态 Token 与用户操作。
- 类型（`admin/src/api/admin.ts`）：`QuoteUpsert`（`:113-119`）、`Quote`（`:121-124`，多 `id` 与 `node_name`）、`QuoteListResult`（`:126-129`）、`QuoteCycle`（`:132-137`，`today_position` 注释 `:131`）、`RouteNode`（`:85-103`，仅下拉用）、`ImportPreviewResult`（`:615-621`，组件内消费）。
- 端点链（api 函数 → 路由 → service）：
  - `fetchQuotes(page, pageSize, keyword)`（`admin.ts:714-718`，keyword 空转 undefined）→ GET `/api/admin/quotes`（`admin.py:542-555`）→ `quote_service.list_quotes`（`:136-155`）；
  - `createQuote`（`:720-722`）→ POST（`admin.py:622-633`）→ `validate_quote` + `create_quote`；
  - `updateQuote`（`:724-726`）→ PUT `/{id}`（`admin.py:636-650`）→ `validate_quote` + `update_quote`（404）；
  - `deleteQuote`（`:728-730`）→ DELETE `/{id}`（`admin.py:653-662`）→ `delete_quote`（物理删除，404）；
  - `fetchQuoteCycle`（`:732-734`）→ GET `/cycle`（`admin.py:558-565`）→ `get_cycle_info(db, today_str())`；
  - `updateQuoteCycle(startDate)`（`:736-738`，body `{start_date}`）→ PUT `/cycle`（`admin.py:568-579`）→ `set_cycle_start`（格式错 400）+ 重读 `get_cycle_info`；
  - `quoteImportApi`（`:740-744`）→ `admin.py:582-619` → `import_service`（§4.6）。
- 请求体 Pydantic：`AdminQuoteUpsert`（`backend/app/schemas/schemas.py:1089-1096`，无长度约束，长度校验在 `check_fields`）、`AdminQuoteCycleUpdate`（`:1108-1111`）、`AdminImportConfirmRequest`（`:1133-1134`）。
- 错误码：422（Query/Pydantic）；400（`check_fields` 文案 / 「关联节点不存在」/ 日期格式 / 导入文件与令牌错误）；404（寄语不存在）；403（无 `quotes` 码；节点下拉另可能因缺 `route_nodes` 码 403，被 silent 吞掉）。
- 输出：无返回值；写 `daily_quotes` 表与 `system_settings.quote_cycle_start`；导出物为 Excel 模板与（组件内）错误报告 CSV。

## 6. 依赖关系

- 导入（`:3-17`）：`vue`（computed/onBeforeUnmount/onMounted/reactive/ref/watch）、`element-plus`（ElMessage/ElMessageBox + 表单类型）、`../api/admin`（8 个函数 + 4 个类型）、`../components/ExcelImportDialog.vue`。不引用 `utils/format`（列表无时间字段）、`utils/download`（下载逻辑在组件内）、`utils/liveUpdates`（不订阅 WebSocket）。
- 被依赖：`admin/src/router/index.ts:56-61`（`/quotes` 懒加载）。
- 数据来源：`daily_quotes` 表（`docker/init/007_daily_quotes.sql` 建表：content TEXT、source VARCHAR(200)、node_id FK → route_nodes(id)；`docker/init/013_daily_quote_cycle.sql` 加 sort_order/is_enabled 并建 `system_settings` 表写入 `quote_cycle_start`；文档 `.qoder/docker/init/007_daily_quotes.sql.md`、`.qoder/docker/init/013_daily_quote_cycle.sql.md`）；关联下拉读 `route_nodes` 表。ORM：`backend/app/models/models.py:81` `DailyQuote`。
- 后端文档：`.qoder/backend/app/api/routes/admin.py.md`、`.qoder/backend/app/services/quote_service.py.md`、`.qoder/backend/app/services/import_service.py.md`、`.qoder/backend/app/services/setting_service.py.md`。
- 关联页面/消费方：小程序首页寄语卡经 `GET /api/quotes/today`（`backend/app/api/routes/quotes.py:17` → `quote_service.get_today:72-82`）消费本页维护的数据；关联节点供小程序从寄语卡跳节点详情；节点下拉与 `views/RouteNodesView.vue` 同源（`fetchRouteNodes`）。

## 7. 业务规则

1. **权限**：全部操作需 `quotes` 菜单码（前后端双守卫，§4.1）；节点下拉额外依赖 `route_nodes` 码（§4.7）。
2. **循环规则**（后端权威，`quote_service.py:1-7`、`:59-69`）：启用寄语按 `(sort_order, id)` 升序成环；今日索引 = `(今天 − 起始日期).days % 启用条数`；今天早于起始日兜底第 1 条；启用条数 0 → 小程序不展示寄语卡。按日即时计算，改数据即生效，无定时任务。
3. **出处强制**：source 前端必填（`:107`）+ 后端非空（`check_fields:105-106`），落实需求「不虚构、有明确出处」（`007_daily_quotes.sql` 头注释）。
4. **长度/范围**：内容 ≤200、出处 ≤200、排序号 0–999999，前端 maxlength/input-number 与后端常量三方一致（§4.4）。
5. **删除是物理删除**且立即改变循环（`:171` → `quote_service.py:184-190`）；停用（is_enabled=false）保留数据但不参与轮换（`:323` hint、`_pick` 只查启用，`:61`）。
6. **导入查重、手工不查重**：Excel 导入对内容与库内/文件内重复整行判错（`import_service.py:375-381`）；手工新增/编辑无重复校验（`validate_quote:114-121`）——两种入口口径不同（§9 第 3 项）。
7. **导入排序号自动分配**：留空行按文件顺序接在库内及本批已填排序号最大值之后（`import_service.py:395-408`），与 `IMPORT_TIPS` 第 2 条文案一致（`:181`）。
8. **关联节点**：`node_id` 可空；非空时后端校验节点存在（`validate_quote:119-120`），导入侧接受 ID 或精确名称（`_parse_quote_row:340-348`）。
9. **分页口径**：单页 ≤100（`admin.py:550`），前端固定 20 无 sizes 选择器（`:23`、`:280-287`）；列表顺序即循环顺序（`quote_service.py:149`）。
10. **搜索**：keyword 同时模糊匹配内容与出处（LIKE autoescape，`quote_service.py:140-146`），400ms 防抖 + 服务端执行（`30b4458` 前为当前页前端过滤）。

## 8. 修改约束

- **写后必须 `reloadAll`**：任何改变启用集合/排序/内容/起始日期的操作都要同时刷新列表与循环概览（`:74-77` 注释），否则「今日展示」标记与概览文案会与实际循环脱节；新增写操作入口时不得只调 `loadQuotes`。
- **三方契约**：前端 `rules`/maxlength/input-number（`:105-108`、`:309`、`:315`、`:318`）↔ `quote_service.check_fields` 常量（`:21-23`、`:99-111`）↔ 导入模板说明（`import_service.QUOTE_INSTRUCTIONS:304-316` 直接引用 service 常量）须同步改；`QuoteUpsert`（`admin.ts:113-119`）↔ `AdminQuoteUpsert`（`schemas.py:1089-1096`）字段名 snake_case 一一对应。
- **循环算法在后端**：不要在页面里复算「今日第几条」，一律消费 `GET /cycle` 的 `today_position`/`today_quote_id`（`:225-229`、`:252`）；改循环规则只动 `quote_service._pick` 并同步小程序端展示。
- **启停走全量 PUT**：`updateQuote` 需要完整 `QuoteUpsert`，改造时保持 `toPayload` 的字段白名单（`:112-120`），避免把 `id`/`node_name` 回传后端；若未来后端加独立启停端点，需同步 `handleToggle`（`:153-163`）。
- **保持服务端分页/搜索**：不得回退为前端过滤（`30b4458` 已修复「只搜当前页」缺陷）；竞态守卫与 400ms 防抖是同批审查成果。
- **节点下拉的降级行为**：`fetchRouteNodes(true)` 的 silent + catch 置空（`:193-198`）是刻意设计（跨菜单码权限不阻塞本页），去掉会引入 403 toast 噪声。
- 导入接线契约：`quoteImportApi` 三函数与 `ExcelImportApi`（`ExcelImportDialog.vue:10-14`）绑定；模板文件名 props 与后端 `admin.py:588` 文件名保持一致。
- 视觉：数据页需覆盖加载、空状态、筛选和窄屏可用性（`admin/agents.md`「开发约定」第 3 条）；本页 cycle-bar 与 toolbar 均已 `flex-wrap`（`:343`、`:371`）。若加导出必须走 `csvCell` 防公式注入（第 4 条）。

## 9. 当前实现状态

- **已实现**：循环设置条（起始日期保存 + 概览文案 + 今日第几条）、服务端分页列表、内容/出处防抖搜索、竞态守卫、新增/编辑（字段校验与后端常量一致）、行内启用开关（受控、失败不翻转）、物理删除（confirm）、今日展示标记、Excel 两阶段导入（含排序号自动分配、节点名/ID 关联、查重）、节点下拉静默降级。验收记录见 §10 各提交在 `docs/迭代记录.md` 的条目。
- **存在问题 / 已知事项**：
  1. `handleDelete` 的 `ElMessageBox.confirm` **无 `.catch()`**（`:166-170`）：取消即未处理 rejection（与 `AdminLayout.vue:17-21` 同模式，本页这处未见既有文档记录）。
  2. `loadQuotes`（`:34-41`）、`loadCycle`（`:68-72`）、`handleSave`/`handleToggle` 均无 `catch`：失败时列表保留旧数据、无错误态标识；`loadCycle` 还没有竞态守卫（低频调用，风险小）。
  3. **手工与导入查重口径不一致**：Excel 导入内容重复整行判错（`import_service.py:375-381`），手工新增/编辑完全不查重（`quote_service.validate_quote:114-121`）——同一内容可经手工入口重复入库并各自参与循环。是否要统一**待确认**（未见需求条目）。
  4. 「今日展示」标记只在**今日寄语恰好位于当前页**时可见（`:252` 比较的是本页行），无「跳到今日寄语」入口；跨页时用户只能靠概览文案的「今日展示第 X 条」推断。
  5. `onMounted` 内 `reloadAll()` 未 await（`:191`）且 `loadCycle` 失败无兜底——首屏 cycle 为 null 时概览整块不渲染（`v-if="cycle"` `:225`），仅静默。
  6. 只有 `quotes` 码、没有 `route_nodes` 码的管理员：节点下拉静默为空（`:193-198` + `admin.py:248` 403），编辑已关联节点的寄语时**无法看到/保留原关联**——`el-select` 显示裸 node_id 或空，保存 `toPayload` 仍会带上原 `node_id`（`:118`），不会误清关联，但也不可改。该降级场景未见既有文档记录。
  7. `pageSize` 固定 20、分页器无 sizes 选择器（`:23`、`:282`）；寄语量增大后浏览效率低。
  8. 导入自动排序号封顶 `min(next_order, SORT_ORDER_MAX)`（`import_service.py:405`）：极端情况下多行同落 999999，按导入先后（id）排序，行为可接受但模板说明未提示该封顶。
  9. 无自定义空态/错误态文案（`el-table` 默认「暂无数据」）。
- **待开发**：无本页专属待办。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/views/QuotesView.vue`，共 **3 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目（按提交号检索）。

### 2026-10-11（`d6acf7e`）
- 需求：V1.1 功能二——每日寄语由「按日期绑定」改为「排序号 + 启用状态按天循环」（迁移 013、起始日期可配置），并新增 Excel 模板下载与批量导入（错误定位到行与字段）。
- 修改内容（涉本文件）：+188/-41（`git show --numstat` 实测）——删除 `form.date` 字段与其必填规则（原「按日期展示」模型）；表单改 `reactive<QuoteUpsert>`（sort_order/is_enabled/node_id，`:97-103`）并抽出 `toPayload`（`:112-120`）；新增循环设置条（`cycle`/`startDate`/`savingCycle`、`loadCycle`、`handleSaveCycle`，`:64-89`）与 `reloadAll`（`:75-77`）；新增行内启用开关列与 `togglingId`/`handleToggle`（`:153-163`、`:257-265`）；新增 `ExcelImportDialog` 接线与 `quoteImportApi`、`IMPORT_TIPS`、`handleImported`（`:177-188`、`:289-300`）；头注释更新为循环语义（`:2`）。
- 关联文件：`admin/src/components/ExcelImportDialog.vue`（新建，同批供题库复用）、`admin/src/views/QuestionsView.vue`（-158 行私有导入 UI）、`admin/src/api/admin.ts`（`quoteImportApi`/`QuoteCycle` 等）、`backend/app/services/quote_service.py`、`backend/app/api/routes/admin.py`、`docker/init/013_daily_quote_cycle.sql`、小程序首页寄语卡。
- 测试结果：见 `docs/迭代记录.md` 的 `d6acf7e` 条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复（本页涉及：服务端防抖搜索与 LIKE 转义、请求竞态守卫）。
- 修改内容（涉本文件）：+27/-15——删除前端 `filtered` computed（原实现只在**当前页**数据里按 keyword 过滤，搜索框占位即「按内容 / 出处搜索（当前页）」），改 `fetchQuotes(page, pageSize, appliedKeyword.trim())` 服务端搜索（`:35`）；新增 `requestSeq` 竞态守卫（`:30-40`）与 400ms 防抖 + `onBeforeUnmount` 清理（`:49-61`）；节点下拉改 `fetchRouteNodes(true)` 静默降级并把 `catch` 置空挪到赋值处（`:193-198`）。配套后端 `contains(autoescape=True)`（`quote_service.py:143-144`）。
- 关联文件：`admin/src/views/QuestionsView.vue`、`admin/src/utils/format.ts`、`backend/app/services/quote_service.py`、`backend/app/services/admin_service.py` 等。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-03（`71d1b9b`）
- 需求：每日寄语与节点纪念票（P2-1）——后台维护有出处语录、小程序首页寄语卡、Canvas 节点纪念票。
- 修改内容（涉本文件）：创建本文件（+249 行）——按日期绑定的寄语 CRUD（form 含必填 `date`）、分页列表（pageSize 20）、关键字当前页前端过滤、关联节点下拉（`fetchRouteNodes`，失败不阻塞）。
- 关联文件：`backend/app/api/routes/admin.py`（quotes CRUD）、`backend/app/services/quote_service.py`（新建）、`backend/app/api/routes/quotes.py`（小程序 `/quotes/today`）、`docker/init/007_daily_quotes.sql`、`frontend/pages/home/*`（寄语卡）、`frontend/pages/ticket/*`（纪念票）、`admin/src/api/admin.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `71d1b9b` 条目。
