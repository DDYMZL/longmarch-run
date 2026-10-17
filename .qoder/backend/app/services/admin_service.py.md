# admin_service.py

## 1. 文件路径
`backend/app/services/admin_service.py`（916 行）

模块 docstring：`backend/app/services/admin_service.py:1-6`。

## 2. 文件职责
管理后台（`admin/` Vue 项目）后端业务逻辑的**单一服务模块**，覆盖 4 个管理菜单域（`route_nodes` / `questions` / `rankings` / `orgs`）的读写：

1. **路线节点维护**（`:37-138`）：增删改查、启停，并强制「启用路线目标步数严格递增」这一全局不变量。
2. **题库维护**（`:141-233`）：分页筛选、新增、整体更新、**软停用**（不物理删除），以及被三个模块复用的题目校验器 `_validate_question`。
3. **排名洞察**（`:236-485`）：全员指标 SQL 聚合 + 荣誉榜前 10 + 服务端分页明细，以及**流式 CSV 导出**生成器。
4. **人员详情聚合**（`:488-599`）：排名页点击某人后的一次性全量业务数据聚合。
5. **组织架构维护**（`:602-787`）：组织树（含直属/累计人数）、组织人员明细分页、组织增改删（含子树 level 平移与「被引用节点保留」）。
6. **组织架构外部同步**（`:790-916`）：从 `ORG_SYNC_API_URL` 全量对齐，未配置时降级用种子数据。

**本文件不负责**：管理端登录/扫码/RBAC/邀请码/审计日志查询/活动配置/驾驶舱与大屏/AI 出题——分别在 `backend/app/api/routes/admin.py`、`backend/app/services/access_service.py`、`backend/app/services/identity_service.py`、`backend/app/services/invite_service.py`、`backend/app/services/activity_service.py`、`backend/app/services/dashboard_service.py`、`backend/app/services/ai_question_service.py`。Excel 题库导入的解析与两阶段落库在 `backend/app/services/import_service.py`（仅复用本文件的 `_validate_question`）。

**本文件不写审计日志**：全文无 `audit_service` 引用（import 见 `:14-34`）。管理端审计由各路由/服务自行写入（`backend/app/api/routes/admin.py:339`、`backend/app/services/org_service.py:137`、`backend/app/services/access_service.py:242` 等）。

## 3. 业务需求
- **管理后台菜单与权限（菜单码粒度）**：`.qoder/REQUIREMENTS.md` §11.1。本文件涉及的 4 个菜单码 `route_nodes` / `questions` / `rankings` / `orgs` 由 `require_menu` 在路由层校验（`backend/app/api/routes/admin.py:248`、`:384`、`:316`、`:670`），服务层假定「已通过 `get_current_admin` 鉴权」（docstring `backend/app/services/admin_service.py:3`）。
- **排行榜（管理端口径）**：`.qoder/REQUIREMENTS.md` §7 —— 全员「总积分」总榜，小程序与管理端同一口径；管理端为服务端分页 + 荣誉榜 + 详情抽屉 + 台账核对；导出为「独立 Session + `yield_per(1000)` + UTF-8 BOM + 公式注入防护」。
- **长征路线与节点**：`.qoder/REQUIREMENTS.md` §6.1 —— 节点按 `target_steps` 累计步数解锁、点亮永久保留；本文件负责节点内容的后台维护与启停（停用不删历史点亮，`:84`）。
- **题库管理**：`.qoder/REQUIREMENTS.md` §11.3 —— 题目 CRUD；「删除题目**改为停用**，以保留已生成会话」（对应 `6f2cfc3`，2026-10-15）；AI 生成题校验「与后端 `_validate_question` 对齐」。
- **Excel 导入导出规则**：`.qoder/REQUIREMENTS.md` §11.6 —— 导出侧公式注入防护 `_csv_text`（`:423`）、流式 CSV 独立会话（`:433-485`）。
- **组织架构**：`.qoder/REQUIREMENTS.md` §2.3；「PC 端组织人数统计」2026-10-02 重新纳入并落地于 `get_org_tree`（`:603-632`）。组织**排名**/分组织积分对比已取消（`.qoder/REQUIREMENTS.md` §7 末两行），本文件无相关代码。
- **性能要求**：仓库根 `agents.md` §2.4「大数据量性能保障」——避免 N+1、批量/分页/聚合。本文件的 `_rank_summary` 直方图聚合（`:355-365`）、`_reached_map` 批量 IN（`:291-302`）、`_shift_subtree_level` 单条批量 UPDATE（`:780-787`）、`delete_org` 父链一次加载（`:749-756`）均为该要求的落地，来源提交 `f59892e`、`b5d6035`（2026-10-11）。
- **CSV 公式注入防护**：`admin/agents.md`「导出包含用户文本时必须防止 CSV 公式注入」→ `_csv_text`（`:423-426`）。

## 4. 核心功能

### 4.1 路线节点维护（`:37-138`）
| 函数 | 行号 | 说明 |
|---|---|---|
| `list_route_nodes(db)` | `:38-40` | 全量返回，`ORDER BY sort_order, id`；**无分页**（节点量小，前端 `RouteNodesView` 本地筛选，见 `.qoder/REQUIREMENTS.md` §11.5） |
| `create_route_node(db, data)` | `:43-57` | 归一化 → `max(id)+1` 显式赋主键（`:46-47`）→ `add` → `flush`（`:50`）→ 校验启用路线（`:51`）→ `commit`（`:52`）；`ValueError` 时 `rollback` 后重抛（`:53-55`） |
| `update_route_node(db, node_id, data)` | `:60-78` | 同上模式；节点不存在返回 `None`（`:66-67`）。docstring `:63` 明确「节点 id 与历史点亮关系保持不变」 |
| `set_route_node_enabled(db, node_id, is_enabled)` | `:81-97` | 启停；docstring `:84`「停用不删除历史点亮记录」；同样走 flush → 校验 → commit / rollback |
| `_normalize_route_node_data(data)` | `:100-121` | **就地修改** `data`：11 个文本字段 `strip()`（`:102-108`）、`images` 过滤空串并转 `str`（`:109-111`）；校验名称非空（`:112-113`）、`target_steps ≥ 0`（`:114-115`）、`sort_order ≥ 0`（`:116-117`）、纬度 ∈ [-90,90] 且经度 ∈ [-180,180]（`:118-121`） |
| `_validate_enabled_route(db)` | `:124-138` | 启用节点集合非空（`:132-133`），且按展示顺序 `target_steps` **严格递增**（`:134-138`），违规抛带节点名的中文 `ValueError` |

三个写函数的共同点：**先 `flush` 再校验再 `commit`**，使校验能读到本次未提交的改动；校验失败 `rollback`，异常原样上抛由路由转 400（`backend/app/api/routes/admin.py:264-267`、`:281-284`、`:301-306`）。

### 4.2 题库维护（`:141-233`）
| 函数 | 行号 | 说明 |
|---|---|---|
| `list_questions(db, page, page_size, keyword, qtype, category)` | `:142-169` | 返回 `(total, items)`。**只查 `active IS TRUE`**（`:155`）；`keyword` 用 `contains(..., autoescape=True)` 做 LIKE 通配符转义（`:156-157`，`30b4458` 引入）；`qtype`/`category` 精确匹配（`:158-161`）；`ORDER BY id` + `offset/limit`（`:163-168`） |
| `create_question(db, data)` | `:172-180` | 校验 → `max(id)+1`（`:175-176`）→ `add` → `commit`（`:178`）→ `refresh`。docstring `:173` 说明「`questions.id` 无数据库自增（种子占用固定 id），显式取 max+1」，与 `docker/init/001_schema.sql:17`（`id INTEGER PRIMARY KEY`）一致 |
| `update_question(db, question_id, data)` | `:183-193` | 校验 → 不存在返回 `None`（`:187-188`）→ `setattr` 整体覆盖（`:189-190`）→ `commit`（`:191`） |
| `delete_question(db, question_id)` | `:196-205` | **软停用**：`active = False`（`:204`）后 `commit`（`:205`）；题目不存在或已停用**静默返回**（`:202-203`，幂等）。docstring `:197-199`：停用后不再被抽取，当天已生成的答题任务仍保留可完成 |
| `_validate_question(data)` | `:208-233` | 见下方规则清单；**会就地写回 `data["category"]`**（`:217`） |

`_validate_question` 校验项（`:210-233`）：`type ∈ {single, judge}`；题干非空；`category ∈ {event, route, figure}` 或留空；选项 ≥ 2；`label` 不重复；答案非空且全部落在 `label` 集合内；单选题答案恰好 1 个；`score` 为正整数。

**跨模块复用**（下划线私有函数被外部导入，是既有事实）：`backend/app/services/ai_question_service.py:266`、`:365`、`:596`、`:619`、`:661`；`backend/app/services/import_service.py:23`（`from app.services.admin_service import _validate_question`）。

### 4.3 排名洞察（`:236-485`）
- 常量 `RANK_EXPORT_BATCH = 1000`（`:238`）：导出批大小，注释 `:237` 说明「流式游标批量读取，内存占用与总人数无关」。
- `_enabled_route_nodes(db)`（`:241-247`）：只取 `id/name/target_steps` 三列，`is_enabled IS TRUE`，按 `sort_order, id` 排序。
- `_filter_rank_users(query, keyword, org_id, only_changed)`（`:250-264`）：`keyword` 同时匹配 `lower(nickname)` 与 `cast(User.id AS VARCHAR)`，两者均 `autoescape=True`（`:254-259`）；`org_id` 精确匹配（`:260-261`）；`only_changed` 要求 `nickname_changed_at IS NOT NULL`（`:262-263`）。
- `_ranked_user_query(db, ...)`（`:267-288`）：以 `rank_service.ranked_users_subquery(db)`（`backend/app/services/rank_service.py:20-45`，窗口函数 `row_number()`）为名次来源 join `User`，`ORDER BY rank`（`:286`）。docstring `:268`：**名次始终是全员口径，筛选不改变名次**。
- `_reached_map(db, user_ids, node_ids)`（`:291-302`）：一批用户 × 启用节点的点亮时间，**一次 IN 查询**（`:296-300`），空入参直接返回 `{}`（`:293-294`）。
- `_rank_items(db, rows, route_nodes, org_names)`（`:305-339`）：把行装配为响应字典；`original_nickname` 回退为当前昵称（`:317`）；`completed_nodes` = 已点亮数（`:323`）；`last_reached_at` = 点亮时间最大值（`:325`）；`nodes` 为逐节点到达明细（`:327-336`）。
- `_rank_summary(db, node_ids)`（`:342-372`）：全员指标全部 SQL 聚合——人数（`:344`）、总步数 `sum(daily_sport.steps)`（`:345`）、总积分 `sum(points_log.delta)` 且 `source_type IN points_service.SOURCES`（`:346-351`，`backend/app/services/points_service.py:29`，即排除 `legacy` 旧流水）；完成全程人数与平均进度按「每人点亮节点数」**直方图**聚合（`:355-365`），注释 `:361`：结果行数 ≤ 节点数 + 1，与人数无关；平均进度按各人进度四舍五入（`floor(x + 0.5)`）后再平均（`:364-365`）。
- `get_rank_overview(db, page, page_size, keyword, org_id, only_changed)`（`:375-420`）：
  - `filtered` 标记（`:386`）；当前页明细 `offset/limit`（`:387-392`）；
  - 荣誉榜取 `rank_service.ELITE_SIZE`（= 10，`backend/app/services/rank_service.py:17`）条，**不受筛选影响**；仅当「无筛选且第 1 页且 `page_size ≥ 10`」时复用已取到的 `rows[:elite]` 省一次查询（`:393-398`）；
  - `match_total`：有筛选时单独 `count`，否则复用 `summary["total"]`（`:399-403`）；
  - `org_options`：取全部**非空且去重**的 `User.org_id`（`:405`），一次 `org_service.get_full_name_map` 拿全路径名（`:406`，`backend/app/services/org_service.py:77`），过滤无名组织后按名称排序（`:410-413`）；
  - `route_nodes` 返回占位结构（`reached=False`/`reached_at=None`，`:414-417`），供前端渲染表头；
  - 返回 `{**summary, match_total, org_options, route_nodes, podium, items}`（`:407-420`）。
- `_csv_text(value)`（`:423-426`）：`None` → 空串；以 `=`、`+`、`-`、`@` 开头时前置单引号，防 Excel 公式注入。
- `_export_time(value, empty)`（`:429-430`）：`to_local()` 转北京时间（`backend/app/core/helpers.py:33`）后格式化为 `%Y/%m/%d %H:%M`，空值用调用方给的占位串。
- `iter_rank_csv(keyword, org_id, only_changed)`（`:433-485`）：**生成器函数**，签名不含 `db`（唯一例外，见 §7.2）。
  - `db = SessionLocal()`（`:438`）；`io.StringIO` 缓冲 + `csv.writer(quoting=QUOTE_ALL, lineterminator="\r\n")`（`:439-440`）；内部 `flush()` 取出并清空缓冲（`:442-446`）；
  - 表头 11 个固定列 + 每个启用节点一列「<节点名>到达时间」（`:452-455`，节点名过 `_csv_text`）；首块前置 UTF-8 BOM（`:456`）；
  - 数据行：`_ranked_user_query(...).yield_per(1000)`（`:458`）+ `itertools.islice` 按 1000 人切批（`:459-462`），每批一次 `_reached_map`（`:463`）；
  - 单元格：`曾用名`仅在已改名时输出（`:466`、`:472`）；组织为空输出「未分配组织」（`:474`）；未到达节点输出「尚未到达」（`:481`）；
  - `finally: db.close()`（`:484-485`）——生成器被消费完或中途关闭都会释放会话。

### 4.4 人员详情聚合（`:488-599`）
`get_user_overview(db, user_id)`（`:489-599`）：用户不存在返回 `None`（`:494-496`，路由转 404，`backend/app/api/routes/admin.py:373-376`）。查询序列：启用节点全字段（`:497-502`）、该用户全部点亮记录建 `{node_id: lit_at}`（`:503-506`）、勋章 join `medal_defs` 按获得时间升序（`:518-533`）、积分流水按 `source_type IN SOURCES` 且 `date desc, id desc`（`:535-540`）、`sport_service.get_today`（`:542`，`backend/app/services/sport_service.py:210`）与 `get_recent(db, user_id, 7)`（`:567`，`backend/app/services/sport_service.py:318`）、全部答题记录按 `date desc`（`:543-548`）。
返回 6 个分组（`:550-599`）：`user`（含 `org_name` 全路径，`:555-559`；`original_nickname`/`nickname_changed_at`，`:560-561`）、`sport`、`quiz_records`、`medals`、`march`、`points`（`points_service.get_breakdown` 展开 + `rank_service.get_user_rank` + 流水列表，`:586-598`）。

### 4.5 组织架构维护（`:602-787`）
| 函数 | 行号 | 查询次数 | 说明 |
|---|---|---|---|
| `get_org_tree(db)` | `:603-632` | 2 | 组织全表按 `sort_order, id`（`:609`）+ 直属人数 `GROUP BY org_id`（`:610-615`）；内存建树（`:616-628`），对每个根递归挂子树并后序累加人数（`:629-631`）；返回 `{total: 节点总数, nodes: 森林}`（`:632`）。`direct_user_count` / `total_user_count` 语义见 docstring `:605-607` |
| `_accumulate_user_count(item)` | `:635-641` | 0 | 后序遍历累加，写回 `total_user_count` 并返回该子树累计值 |
| `_fill_children(item, tree_map)` | `:644-648` | 0 | 递归挂载；docstring `:645` 说明「组织树层级有限，无深递归风险」 |
| `get_org_users(db, org_id, scope, page, page_size)` | `:651-688` | 3~4 | 组织不存在返回 `None`（`:660-662`）；`scope=all` 用 `org_service.subtree_org_ids` 一次 IN 查整棵子树（`:663-665`），否则直属等值查（`:666-667`）；`count` + 分页（`:668-674`）；批量取组织全名（`:675`）。docstring `:656-658`：口径与组织树的 `direct_user_count` / `total_user_count` **严格一致** |
| `create_org(db, data)` | `:691-703` | 2 | `level` 由 `_resolve_level` 依父节点推导（`:693`）；**不显式赋 id**，走数据库序列默认值（`docker/init/001_schema.sql:34` `SERIAL`，`docker/init/009_org_serial.sql:6-12` 为 BUG-001 补建序列）；`commit`（`:701`）+ `refresh` |
| `update_org(db, org_id, data)` | `:706-730` | ≥4 | 组织不存在返回 `None`（`:711-713`）；父节点指向自身抛 `ValueError`（`:716-717`）；父节点是自身子孙（成环）抛 `ValueError`（`:718-719`）；重算 level 并记录差值（`:720-725`）；`commit`（`:726`）；差值非 0 时调 `_shift_subtree_level`（`:727-728`，**内部再 commit**，见 §7.3） |
| `delete_org(db, org_id)` | `:733-762` | 4 | 组织不存在返回 `[]`（`:738-740`）；取子树 id（`:741`）；查子树内**仍被用户引用**的组织 id（`:742-748`）；父链整表一次加载（`:749-750`）后逐级上溯，把被引用节点的祖先一并保留（`:751-756`）；其余节点单条批量 `DELETE`（`synchronize_session=False`，`:757-760`）；`commit`（`:761`）；返回**被保留**的 id 升序列表（`:762`），路由据此拼提示文案（`backend/app/api/routes/admin.py:731-734`） |
| `_resolve_level(db, parent_id)` | `:765-772` | ≤1 | 顶级为 1，否则父 `level + 1`；父不存在抛 `ValueError`（`:770-771`） |
| `_is_descendant(db, org_id, candidate_id)` | `:775-777` | 1 | 依赖 `subtree_org_ids` 返回值首元素恒为根（`[1:]` 去掉自身） |
| `_shift_subtree_level(db, root_id, diff)` | `:780-787` | 2 | 子树（不含根）**一条批量 UPDATE** 平移 level，随后 `commit`（`:787`） |

### 4.6 组织架构同步（`:790-916`）
| 函数 | 行号 | 说明 |
|---|---|---|
| `sync_orgs(db)` | `:791-858` | 全量对齐：拉源（`:801`）→ 归一化（`:802`）→ 任一原始节点缺 `level` 时按 parent 链重算全部 level（`:803-804`）→ 组织全表载入 `{id: ORM}`（`:807-809`）→ 按 id upsert，覆盖 `name/parent_id/level/sort_order`（`:811-829`）→ 数据源中已消失的本地节点：被用户引用的进 `skipped` 保留，其余批量 DELETE（`:831-849`）→ **单次 `commit`**（`:850`）→ 返回 `{source, created, updated, deleted, kept, skipped}`（`:851-858`）。`kept` = **数据源节点数** `len(nodes)`（`:856`），不是本地表最终行数 |
| `_fetch_org_source()` | `:861-875` | 读 `settings.ORG_SYNC_API_URL`（`:863`，`backend/app/core/config.py:64`）；留空返回 `"seed（未配置 ORG_SYNC_API_URL，使用内置种子数据）"` + `ORGANIZATIONS`（`:864-865`，`backend/app/data/seed.py:318`）；配置时 `httpx.get(url, timeout=10)` + `raise_for_status()` + `.json()`（`:866-869`），`HTTPError`/`ValueError` 统一转 `ValueError`（`:870-871`，路由转 502，`backend/app/api/routes/admin.py:745-748`）；接受裸数组或 `{data: [...]}`（`:872`），非数组抛格式非法（`:873-874`） |
| `_normalize_org_node(raw)` | `:878-894` | 非 dict 抛错（`:880-881`）；`id` 必须是 `int` 且 `name` 非空（`:882-885`，异常信息**回显原始节点内容**）；字段兼容 `parent_id|parentId`（`:886`）、`sort_order|sortOrder`（`:887`）；`level` 交 `_calc_level`（`:893`） |
| `_calc_level(raw)` | `:897-902` | 数据源 `level` 为正整数则采用，否则按 1 处理（由 `_rebuild_levels` 兜底修正） |
| `_rebuild_levels(nodes)` | `:905-916` | 就地重算全部 level：内部 `depth()` 递归沿 `parent_id` 上溯，`guard > 32` 防环/超深直接返回 1（`:909-913`） |

## 5. 输入与输出

### 5.1 路由映射（唯一路由层调用方 `backend/app/api/routes/admin.py`，18 处调用）
| 服务函数 | HTTP 端点 | 菜单码 | 请求体/查询参数 | `response_model` |
|---|---|---|---|---|
| `list_route_nodes` | `GET /api/admin/route-nodes`（`:248-252`） | `route_nodes` | — | `AdminRouteNodeListOut`（`backend/app/schemas/schemas.py:1363`） |
| `create_route_node` | `POST /api/admin/route-nodes`（`:259-267`） | `route_nodes` | `AdminRouteNodeUpsert`（`backend/app/schemas/schemas.py:1368`，17 字段，无 `id`） | `AdminRouteNodeOut`（`backend/app/schemas/schemas.py:1328`） |
| `update_route_node` | `PUT /api/admin/route-nodes/{node_id}`（`:274-287`） | `route_nodes` | 同上 | 同上 |
| `set_route_node_enabled` | `PATCH /api/admin/route-nodes/{node_id}/enabled`（`:294-309`） | `route_nodes` | `AdminRouteNodeEnabled`（`backend/app/schemas/schemas.py:1387`） | `AdminRouteNodeOut` |
| `get_rank_overview` | `GET /api/admin/rankings`（`:316-326`） | `rankings` | `page ≥ 1`、`page_size 1..200`（默认 50）、`keyword ≤ 64`、`org_id`、`only_changed` | `AdminRankListOut`（`backend/app/schemas/schemas.py:1428`） |
| `iter_rank_csv` | `GET /api/admin/rankings/export`（`:350-362`） | `rankings` | `keyword`、`org_id`、`only_changed` | 无（`StreamingResponse`，`text/csv; charset=utf-8` + `Content-Disposition`） |
| `get_user_overview` | `GET /api/admin/users/{user_id}/overview`（`:369-376`） | `rankings` | 路径参数 | `AdminUserOverviewOut`（`backend/app/schemas/schemas.py:1552`） |
| `list_questions` | `GET /api/admin/questions`（`:384-395`） | `questions` | `page`、`page_size 1..100`（默认 20）、`keyword`、`qtype`、`category` | `AdminQuestionListOut`（`backend/app/schemas/schemas.py:1055`） |
| `create_question` | `POST /api/admin/questions`（`:402-408`） | `questions` | `AdminQuestionUpsert`（`backend/app/schemas/schemas.py:1060`，**无 `active` 字段**） | `AdminQuestionOut`（`backend/app/schemas/schemas.py:1037`） |
| `update_question` | `PUT /api/admin/questions/{question_id}`（`:473-484`） | `questions` | 同上 | 同上 |
| `delete_question` | `DELETE /api/admin/questions/{question_id}`（`:491-495`） | `questions` | 路径参数 | `MessageOut` |
| `get_org_tree` | `GET /api/admin/orgs`（`:670-673`） | `orgs` | — | `AdminOrgTreeOut`（`backend/app/schemas/schemas.py:1282`） |
| `get_org_users` | `GET /api/admin/orgs/{org_id}/users`（`:678-693`） | `orgs` | `scope ∈ {direct, all}`（正则约束）、`page`、`page_size 1..100` | `AdminOrgUserListOut`（`backend/app/schemas/schemas.py:1321`） |
| `create_org` | `POST /api/admin/orgs`（`:700-706`） | `orgs` | `AdminOrgUpsert`（`backend/app/schemas/schemas.py:1287`） | `AdminOrgNodeOut`（`backend/app/schemas/schemas.py:1266`） |
| `update_org` | `PUT /api/admin/orgs/{org_id}`（`:713-722`） | `orgs` | 同上 | 同上 |
| `delete_org` | `DELETE /api/admin/orgs/{org_id}`（`:728-734`） | `orgs` | 路径参数 | `MessageOut` |
| `sync_orgs` | `POST /api/admin/orgs/sync`（`:741-748`） | `orgs` | — | `AdminOrgSyncOut`（`backend/app/schemas/schemas.py:1295`） |

`_validate_question` 另有两个非路由调用方：`backend/app/services/import_service.py:23`、`backend/app/services/ai_question_service.py:266`（另有 `:365`、`:596`、`:619`、`:661`）。

### 5.2 返回值形态
- **ORM 对象**：`list_route_nodes`、`create/update_route_node`、`set_route_node_enabled`、`create/update_question` 直接返回 ORM 实体，由 `response_model`（`from_attributes=True`）序列化。写函数在 `commit` 后一律 `db.refresh()`（`:56`、`:77`、`:96`、`:179`、`:192`、`:702`、`:729`），保证返回的是库内最终值。
- **裸 dict**：`get_rank_overview`、`get_user_overview`、`get_org_tree`、`get_org_users`、`sync_orgs` 返回 dict/list，键名为 **snake_case**（如 `:311-337`、`:551-598`、`:618-627`）。管理端 schema 继承 `BaseModel` 而非 `CamelModel`（`backend/app/schemas/schemas.py:1030`、`:1266`、`:1428`），即管理端契约为 snake_case，与小程序端的 camelCase 契约并存（`.qoder/ARCHITECTURE.md` §4.2）。
- **元组**：`list_questions` → `(total, items)`（`:169`）。
- **字符串生成器**：`iter_rank_csv` → `Iterator[str]`（`:433`）。
- **`None` 语义**：`update_route_node` / `set_route_node_enabled` / `update_question` / `get_user_overview` / `get_org_users` / `update_org` 用 `None` 表示「目标不存在」，由路由转 404；`delete_org` 用 `[]`、`delete_question` 用静默 `return` 表示幂等。

## 6. 依赖关系

### 6.1 上游（谁调用本文件）
- `backend/app/api/routes/admin.py`（1088 行）——唯一路由层调用方，18 处 `admin_service.*`（见 §5.1）。该文件全文**只有 1 处 `db.commit()`**（`backend/app/api/routes/admin.py:343`，位于 `POST /api/admin/points/verify` 内，用于把 `points_service.recompute_all` 的修复与 `audit_service.record`（`:339`）一起提交），与本文件无关；即本文件的全部写入都是**服务层自提交**。
- `backend/app/services/import_service.py:23` 与 `backend/app/services/ai_question_service.py:22`（导入 `admin_service`）——复用 `_validate_question`，其 docstring 明确「入库前复用 `admin_service._validate_question`（与 Excel 导入同等校验强度）」（`backend/app/services/ai_question_service.py:7`）。
- `backend/test/s22_history_sync_quiz_rotation.py:22`（导入）、`:128`、`:137`（调用 `delete_question` 构造停用题场景）。

### 6.2 下游（本文件依赖谁）
标准库 `csv` / `io` / `itertools` / `math` / `datetime` / `typing`（`:7-12`）；第三方 `httpx`（`:14`，组织同步）、`sqlalchemy`（`:15-16`，用到 `String`、`cast`、`func`、`or_`、`Session`）。

| 依赖 | 导入行 | 用到的成员 |
|---|---|---|
| `app.core.config.settings` | `:18` | `ORG_SYNC_API_URL`（`:863`；定义 `backend/app/core/config.py:64`，注释说明「留空时同步使用内置种子数据」） |
| `app.core.database.SessionLocal` | `:19` | 仅 `iter_rank_csv`（`:438`）；定义 `backend/app/core/database.py:51`（`autoflush=False, autocommit=False`） |
| `app.core.helpers.to_local` | `:20` | CSV 时间本地化（`:430`；定义 `backend/app/core/helpers.py:33`） |
| `app.data.seed.ORGANIZATIONS` | `:21` | 同步降级数据源（`:865`；定义 `backend/app/data/seed.py:318`） |
| `app.models.models` | `:22-33` | `DailySport`（`backend/app/models/models.py:231`）、`LitNode`（`:255`）、`MedalDef`（`:145`）、`Organization`（`:163`）、`PointsLog`（`:329`）、`Question`（`:126`）、`QuizRecord`（`:271`）、`RouteNode`（`:32`）、`User`（`:179`）、`UserMedal`（`:353`） |
| `app.services.org_service` | `:34` | `get_full_name`（`backend/app/services/org_service.py:72`）、`get_full_name_map`（`:77`）、`subtree_org_ids`（`:165`） |
| `app.services.points_service` | `:34` | `SOURCES`（`backend/app/services/points_service.py:29`）、`get_breakdown`（`:176`） |
| `app.services.rank_service` | `:34` | `ELITE_SIZE`（`backend/app/services/rank_service.py:17`）、`ranked_users_subquery`（`:20`）、`get_user_rank`（`:85`） |
| `app.services.sport_service` | `:34` | `get_today`（`backend/app/services/sport_service.py:210`）、`get_recent`（`:318`） |

**未依赖**：`audit_service`（不写审计）、`medal_service`（只读 `user_medals`，不触发勋章判定）、`ws`（不广播 `data_changed`）、`event_service`。分层方向 `api/routes → api/deps → services → models + core` 未被破坏（`backend/AGENTS.md` §3.1）；服务间横向调用属既有常规做法（`.qoder/ARCHITECTURE.md` §3.1）。

### 6.3 数据表
读/写 `route_nodes`、`questions`、`organizations`、`users`、`daily_sport`、`lit_nodes`、`quiz_records`、`points_log`、`medal_defs`、`user_medals`。建表来源：`docker/init/001_schema.sql:3`（`route_nodes`）、`:16`（`questions`）、`:33`（`organizations`）；`questions.category/active` 由后续迁移追加（`docker/init/020_question_rotation.sql:6-7`）；性能索引 `docker/init/012_perf_indexes.sql`（`lit_nodes.lit_at`、`users.created_at`）。

## 7. 业务规则

### 7.1 校验与数据一致性
1. **启用路线必须非空且 `target_steps` 严格递增**（`:124-138`）。任何节点新增/编辑/启停都会重跑该校验（`:51`、`:72`、`:91`），因此**不能通过管理端把路线改成空或步数倒挂**。
2. **停用节点不删历史点亮**（docstring `:84`）：`lit_nodes` 记录保留；但 `_enabled_route_nodes`（`:241-247`）只取启用节点，故停用后排名明细、人员详情、CSV 的节点列都会**少一列**，`node_count` 与 `completed_nodes` 随之变化（`:323-324`、`:352`、`:582-583`）。
3. **题目删除 = 软停用**（`:196-205`），停用后不再进入抽题；`list_questions` 只返回 `active` 题（`:155`），`AdminQuestionUpsert` 无 `active` 字段（`backend/app/schemas/schemas.py:1060-1070`），因此**停用题在管理端列表不可见、也无法通过 `PUT /admin/questions/{id}` 重新启用**。
4. **名次是全员口径**：筛选只影响返回哪些行，不改变 `rank` 值（`:267-288`）。
5. **荣誉榜恒为全员前 10**，不受筛选/分页影响（`:393-398`）。
6. **总积分口径**：只统计 `source_type IN ('walk','quiz')` 的流水，`legacy` 旧流水不计入（`:346-351`、`:535-540`）。
7. **组织人数双口径**：`direct_user_count`（直属）与 `total_user_count`（含全部下级，后序累加，`:635-641`）；`GET /orgs/{id}/users` 的 `scope=direct|all` 与之一一对应（docstring `:656-658`）。
8. **删除组织保留被引用节点及其祖先**：仍有用户归属的节点不删，其父链也保留以免树断裂（`:742-757`）；被保留 id 通过返回值告知调用方并展示给管理员（`backend/app/api/routes/admin.py:731-734`）。
9. **组织不成环**：上级不能是自身，也不能是自身的子孙（`:716-719`）；`_rebuild_levels` 另有 `guard > 32` 深度保护（`:909-913`）。
10. **同步是全量对齐**：数据源为准，本地多余节点删除（被引用者保留计入 `skipped`），`name/parent_id/level/sort_order` 全部覆盖（`:798-858`）。数据源缺 `level` 时按 `parent_id` 链整体重算（`:803-804`、`:905-916`）。
11. **改名记录**：`only_changed` 筛 `nickname_changed_at IS NOT NULL`（`:262-263`）；CSV 中「曾用名」仅对已改名用户输出（`:466`、`:472`）。

### 7.2 数据库会话与事务边界
- **除 `iter_rank_csv` 外，所有函数签名为 `(db: Session, ...)`**，Session 由路由 `Depends(get_db)` 注入（`backend/app/api/routes/admin.py:250`、`:326` 等），符合 `backend/AGENTS.md` §4.6。
- **`iter_rank_csv` 是全项目唯一的服务层自建 Session 例外**：`:438` `db = SessionLocal()`、`:484-485` `finally: db.close()`。原因写在 docstring `:436`「响应体在路由返回后才被逐块消费，不能依赖请求级会话」——`StreamingResponse` 的生成器在路由函数返回后执行，此时 `get_db` 的 `finally` 已关闭请求会话（`backend/app/core/database.py:58-64`）。该例外登记于 `.qoder/ARCHITECTURE.md` §3.1、§8.3（「这是全项目唯一的服务层自建 Session 例外」）与 `.qoder/REQUIREMENTS.md` §11.6；**`backend/AGENTS.md` §4.6 仍写作「禁止在 service 内自建 session」，未登记该例外**。
- **`db.commit()` 全部由本文件自己调用**，共 11 处：`:52`、`:73`、`:92`、`:178`、`:191`、`:205`、`:701`、`:726`、`:761`、`:787`、`:850`。只读函数（`list_*` / `get_*` / `_rank_*` / `_reached_map`）**不 commit 也不 rollback**。
- **路线节点三写函数**采用 `flush → 校验 → commit`，`ValueError` 时 `rollback` 再重抛（`:49-55`、`:70-76`、`:89-95`）；`except` 只捕获 `ValueError`，其它异常不显式回滚（由 `get_db` 关闭会话时释放）。
- `create_question` / `update_question` / `delete_question` / `create_org` / `delete_org` / `sync_orgs` **无 try/except**：校验在任何写操作之前完成（`:174`、`:185`、`:801-804`），失败时未产生脏数据。
- `iter_rank_csv` 的会话在 `finally` 关闭（`:484-485`），生成器被提前 `close()`（客户端断开）也会释放。

### 7.3 已知非原子点
`update_org` 在 `:726` 先提交本节点改动，再于 `:727-728` 调 `_shift_subtree_level`，后者在 `:787` **第二次 commit**。若两次提交之间进程中断，会出现「父节点 level 已改、子树 level 未平移」的中间态。这是既有实现，非本文档推断（代码见 `:720-730`、`:780-787`）。

### 7.4 主键分配
`create_route_node`（`:46-47`）与 `create_question`（`:175-176`）都用 `SELECT max(id) + 1` 显式赋主键，**无并发保护**。该风险登记于 `.qoder/PROJECT.md` §8 第 27 项（同类点还有 `backend/app/services/ai_question_service.py:378`、`:674` 与 `backend/app/services/import_service.py:293`）。补充事实：`route_nodes.id` 在 DDL 中是 `SERIAL`（`docker/init/001_schema.sql:4`），显式赋 id 不会推进序列；`questions.id` 是 `INTEGER PRIMARY KEY` 无序列（`docker/init/001_schema.sql:17`），必须显式赋值。`create_org`（`:691-703`）不赋 id，依赖 `organizations` 的序列默认值（`docker/init/009_org_serial.sql:6-12`）。

### 7.5 异常处理约定
- 业务失败一律抛 `ValueError`（中文 detail），由路由转 `HTTPException`：400 用于节点/题目/组织校验失败（`backend/app/api/routes/admin.py:266-267`、`:283-284`、`:305-306`、`:407-408`、`:480-481`、`:705-706`、`:718-719`），**502** 用于组织同步失败（`:747-748`）。
- 「不存在」用返回值 `None`/`[]` 表达，不抛异常（`:66-67`、`:187-188`、`:495-496`、`:661-662`、`:712-713`、`:739-740`）。
- 全文无 `except: pass`、无日志输出（无 `logging` 导入）。

### 7.6 审计
**本文件不写任何审计记录**（无 `audit_service` 导入，见 §2）。路线节点、题库、组织架构的增删改**均无审计留痕**；管理端唯一与本文件同页相关的审计是「积分核对修复」`points.recompute`（`backend/app/api/routes/admin.py:339-343`，走 `points_service`，不经本文件）与「调整用户组织」`user.org_change`（`backend/app/services/org_service.py:137`，属 `org_service`）。

## 8. 修改约束
1. **不要把 `iter_rank_csv` 改成接收 `db: Session`**。它必须自建会话（`:438`）并在 `finally` 关闭（`:484-485`）；改回请求级会话会在流式响应过程中访问已关闭的 Session。若新增其它流式导出，沿用同一模式并在 `.qoder/ARCHITECTURE.md` §8.3 登记。
2. **改动 `_validate_question` 会同时影响 Excel 导入与 AI 出题**（`backend/app/services/import_service.py:23`、`backend/app/services/ai_question_service.py:266`/`:365`/`:596`/`:619`/`:661`），且前端 `admin/src/components/AiGenerateDialog.vue` 的 `validateItem` 需与之对齐（`.qoder/REQUIREMENTS.md` §11.3）。放宽/收紧校验必须三端同步。
3. **不得移除 `flush → _validate_enabled_route → commit / rollback` 结构**（`:49-55`、`:70-76`、`:89-95`）。去掉 `flush` 会让校验读不到本次改动；去掉 `rollback` 会把失败改动残留在会话中。
4. **保持「名次全员口径」**：不要为了筛选性能把 `rank_service.ranked_users_subquery`（`backend/app/services/rank_service.py:20-45`）换成筛选后重排名，否则小程序端与管理端名次不一致（`.qoder/REQUIREMENTS.md` §7）。
5. **保持导出的既有契约**：UTF-8 BOM（`:456`）、CRLF + `QUOTE_ALL`（`:440`）、表头列顺序（`:452-455`）、「未分配组织」/「尚未到达」占位（`:474`、`:481`）、`_csv_text` 公式注入防护（`:423-426`）。`admin/src/utils/download.ts` 与 `admin/src/pages/RankingsView.vue` 直接消费该文件字节流。
6. **不要在服务层写审计以外的旁路提交**：本文件已是「服务层自提交」约定（§7.2）。若在路由层再加 `db.commit()`，会与本文件的 commit 叠加，参见 `.qoder/ARCHITECTURE.md` §9.4「修改代码时必须先确认目标 service 属于哪一种约定」。
7. **`get_org_users` 的 `scope` 口径不得漂移**：`direct` 必须等于 `direct_user_count`、`all` 必须等于 `total_user_count`（`:651-675`），否则组织页两列人数点开的明细与数字不符（`a740973` 的需求原意）。
8. **`delete_org` 的返回值语义是「被保留的 id」**（`:762`），不是「被删除的 id」；路由文案依赖它（`backend/app/api/routes/admin.py:731-734`）。
9. **`sync_orgs` 的 `kept` 字段是数据源节点数**（`:856`），改名或改语义需同步 `AdminOrgSyncOut`（`backend/app/schemas/schemas.py:1295`）与前端 `OrgsView`。
10. **主键分配**：若并发新增成为真实场景，需改造 `:46-47` / `:175-176` 的 `max(id)+1`（见 `.qoder/PROJECT.md` §8 第 27 项），并注意 `route_nodes.id` 的 `SERIAL` 序列不会因显式赋值而推进。
11. **表结构单一来源**：涉及字段增删要同步 `backend/app/models/models.py`、`docker/init/` 新增编号 SQL 与 `backend/app/data/seed.py`（`backend/AGENTS.md` §6.3）；本文件不得调用 `create_all`。
12. **性能红线**：`_rank_summary` 的直方图聚合（`:355-365`）、`_reached_map` 的批量 IN（`:291-302`）、导出的 `yield_per` + `islice` 分批（`:458-462`）都是为「人员量大时不全量加载」而写（`b5d6035`、`f59892e`）；改成 `.all()` 全量再在 Python 里算会退化。`get_user_overview` 目前对该用户的答题记录与积分流水**不做分页**（`:535-548`），若数据量增长需重新评估。

## 9. 当前实现状态
- **已实现且在线上路径中**：§4 列出的全部 17 个公开/私有函数均有调用方（§6.1）；无 TODO / FIXME / `pass` 占位、无被注释掉的死代码（全文无 `TODO`、`NotImplemented`）。
- **无单元测试文件直接对应本模块**：`backend/test/` 下以 HTTP 冒烟脚本覆盖（如 `backend/test/s22_history_sync_quiz_rotation.py:128`、`:137` 调 `delete_question`；`backend/test/s12_question_import.py` 覆盖题库导入链路）。是否存在专门针对 `admin_service` 的独立测试脚本：**待确认**。
- **`_validate_question` 是私有函数但被跨模块导入**（`backend/app/services/import_service.py:23`、`backend/app/services/ai_question_service.py:22`），命名与可见性不一致属既有事实，重命名会破坏两处导入。
- **停用题不可见且不可复活**：`list_questions` 过滤 `active`（`:155`）+ `AdminQuestionUpsert` 无 `active`（`backend/app/schemas/schemas.py:1060-1070`）。是否有「恢复停用题」的需求：**待确认**（`.qoder/REQUIREMENTS.md` §11.3 只记录「删除改为停用」）。
- **`update_org` 两次 commit 的非原子性**（§7.3）：既有实现，未见修复记录，也未在 `.qoder/PROJECT.md` §8 已知问题中检索到对应条目（检索关键词 `update_org`、`_shift_subtree_level`）——是否已被评估：**待确认**。
- **`backend/AGENTS.md` §4.6 与实现不一致**：文档写「禁止在 service 内自建 session」，而 `:438` 是刻意例外；例外只在 `.qoder/ARCHITECTURE.md` §3.1/§8.3 与 `.qoder/REQUIREMENTS.md` §11.6 登记。是否要把该例外补写进 `backend/AGENTS.md`：**待确认**（本文档为只读文档任务，未修改任何规则文件）。
- **组织同步的外部数据源从未在仓库中配置**：`ORG_SYNC_API_URL` 默认空串（`backend/app/core/config.py:64`），实际运行走 seed 降级分支（`:864-865`）。生产是否已配置真实外部接口：**待确认**（不在本文档中记录任何配置值）。
- **`sync_orgs` 的 `_normalize_org_node` 异常信息会回显原始节点内容**（`:885`）：外部接口返回体可能包含组织敏感信息并被带到 502 detail 中。是否需要脱敏：**待确认**。

## 10. 迭代记录
（按提交时间倒序；`git log --follow -- backend/app/services/admin_service.py` 共 14 次提交，全部列出）

### 2026-10-15
- 需求：每日答题改为「用户独立题目轮换」，要求删除题目不能使既有答题会话失效（`.qoder/REQUIREMENTS.md` §11.3「删除题目**改为停用**」）。
- 修改内容：`delete_question` 由「物理删除 + 清理今天及以后的 `daily_questions` 抽题缓存」改为**软停用** `active = False`（`:196-205`）；`list_questions` 增加 `active IS TRUE` 过滤（`:155`）；移除 `DailyQuestion` / `today_str` 导入（`:20`、`:22-33`）。本次 diff 为 +6 / -12 行。`questions.active` 列由 `docker/init/020_question_rotation.sql:6-7` 追加。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/services/quiz_service.py`、`backend/app/services/sport_service.py`、`docker/init/019_sport_backfill_carry.sql`、`docker/init/020_question_rotation.sql`、`backend/test/s22_history_sync_quiz_rotation.py`。
- 测试结果：`docs/迭代记录.md` 的 `6f2cfc3` 条目记录：S22 专项 13/13、S18 限时答题回归 21/21、S20 V2 回归 25/25 通过；Python 编译与前端 `node --check` 通过；报告 `backend/test/docs/s22-history-sync-quiz-rotation-report.md`。同条目「遗留」注明：本机 Docker 引擎不可用，未执行真实 openGauss 019/020 迁移与 S11。

### 2026-10-13
- 需求：V2.0 管理后台——排名洞察积分化，荣誉榜由前 3 扩至前 10（金银铜领奖台 + 4~10 名荣誉卡）。
- 修改内容：`get_rank_overview` 的荣誉榜由固定 `limit(3)` 改为 `rank_service.ELITE_SIZE`（= 10），并新增「`page_size < elite` 时不复用当前页行」的条件（`:393-398`）；docstring 改为「荣誉榜前 10 名（不受筛选影响）」（`:383`）。diff +7 / -2 行。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/services/rank_service.py:17`、`admin/src/pages/RankingsView.vue`、`backend/test/s20_v2_regression.py`。
- 测试结果：`docs/迭代记录.md` 的 `e197a28` 条目记录：`npm run build` 通过；真实后端浏览器验收 V01–V08、R01–R08、O01–O03、U01–U02、M01 全部 PASS（报告 `admin/test/docs/v2-admin-report.md`，截图 `admin/test/images/v2-01`~`v2-11`）；s20 25/25 通过；积分核对待 131 名用户、111 个用户日，差异 0。

### 2026-10-13
- 需求：V2.0 需求三/四——积分台账重构，总积分 = 步行 + 答题，排名与导出统一按总积分口径。
- 修改内容：排名明细与 CSV 增加 `total_points` / `walk_points` / `quiz_points` 三列（`:320-322`、`:475-477`）；`_rank_summary` 的总积分改为按 `points_service.SOURCES` 过滤 `points_log.delta` 求和（`:346-351`）；`_ranked_user_query` 增取窗口子查询的三个积分列（`:274-276`）；人员详情 `points` 分组改为 `points_service.get_breakdown` 展开 + 流水（`:586-598`）。diff +28 / -7 行。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/services/points_service.py`、`backend/app/services/rank_service.py`、`docker/init/017_points_ledger.sql`、`backend/app/api/routes/admin.py:330-345`（新增 `POST /api/admin/points/verify`）。
- 测试结果：`docs/迭代记录.md` 的 `2f3f333` 条目记录：SQLite 冒烟 20/20 通过（含「档案与管理端及 CSV 一致」「篡改后核对能发现并修复」「legacy 不计入」）；openGauss 上 016/017 迁移已执行、核对 132 人 111 天差异为 0；回归 s11 8/8、s18 14/14、s19 25/25、s6 8/8。同条目注明 s5、s9 因旧的首登自动建号在配置真实 WX 凭证时返回 502，属本次之前既有问题。

### 2026-10-11
- 需求：管理后台代码审查修复——搜索必须对 LIKE 通配符转义。
- 修改内容：`list_questions` 的关键字过滤加 `autoescape=True`（`:157`）。diff +1 / -1 行。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/api/routes/quotes.py`（寄语服务端搜索）、`admin/src/router/menus.ts`。
- 测试结果：`docs/迭代记录.md` 的 `30b4458` 条目记录：admin `npm run build` 通过；后端回归 p2_quotes 4/4、s9 30/30、s8 23/23、s12 11/11、s4 13/13、e2e_datasync 23/23；浏览器验收通过（含题库服务端搜索、分页/筛选单次请求、排名洞察）；报告 `admin/test/docs/s16-admin-review-fixes-report.md`。

### 2026-10-11
- 需求：排名洞察改为服务端分页/筛选与流式 CSV 导出，人员量大时不再全量加载与渲染。
- 修改内容：本文件最大一次重构（diff +217 / -70 行）。新增 `RANK_EXPORT_BATCH`（`:238`）、`_enabled_route_nodes`（`:241`）、`_filter_rank_users`（`:250`）、`_ranked_user_query`（`:267`）、`_reached_map`（`:291`）、`_rank_items`（`:305`）、`_rank_summary`（`:342`）、`_csv_text`（`:423`）、`_export_time`（`:429`）、`iter_rank_csv`（`:433`）；`get_rank_overview` 改为分页 + `match_total` / `avg_progress` / `org_options` / `podium`（`:375-420`）；`iter_rank_csv` 使用独立 `SessionLocal` 会话（`:438`、`:484-485`）。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/api/routes/admin.py:316-363`、`backend/app/schemas/schemas.py:1428`、`admin/src/pages/RankingsView.vue`、`admin/src/utils/download.ts`。
- 测试结果：`docs/迭代记录.md` 的 `b5d6035` 条目记录：新旧实现对照，92 人全量翻页逐字段相等，各项指标与 5 组筛选结果一致；S7 8/8（新增 P6–P8）、昵称 12/12、datasync 23/23、e2e_full_flow 178/178；admin `npm run build` 通过；浏览器验收（首屏、防抖、翻页、改筛选复位、组织筛选与清空、导出 19 人）全部通过；报告 `admin/test/docs/s15-rankings-server-paging-report.md`。

### 2026-10-11
- 需求：后端热点查询 SQL 聚合化与去 N+1。
- 修改内容：diff +22 / -45 行。组织树人数统计改 `group_by`（`:610-615`）；`delete_org` 父链一次加载后内存上溯（`:749-756`）；`_shift_subtree_level` 改为单条批量 UPDATE（`:780-787`）；子树查询统一复用 `org_service.subtree_org_ids`（`:741`、`:777`、`:782`）；`_rank_summary` 的完成人数/平均进度改为按点亮数直方图聚合（`:355-365`）。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/services/org_service.py:77`/`:165`、`backend/app/services/rank_service.py:20-45`、`docker/init/012_perf_indexes.sql`。
- 测试结果：`docs/迭代记录.md` 的 `f59892e` 条目记录：openGauss 已应用 012；e2e_full_flow 178/178、e2e_datasync 23/23、S2–S7、P0/P1/P2、昵称冒烟全部通过；排行与播报结果与旧实现逐项一致（92 用户 / 20 用户样本）；报告 `backend/test/docs/s14-hotspot-sql-report.md`。

### 2026-10-10
- 需求：V1.1 功能一——题库 Excel 模板下载与批量导入；题库列表改服务端分页。
- 修改内容：diff +29 / -4 行。`list_questions` 增加 `page` / `page_size` / `keyword` / `qtype` / `category` 参数并返回 `(total, items)`（`:142-169`）；`_validate_question` 抽出为可被 `import_service` 复用的独立校验器（`:208-233`）。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/services/import_service.py:23`、`backend/app/api/routes/admin.py:384-395`、`:429-466`、`docker/init/011_import_previews.sql`、`admin/src/components/ExcelImportDialog.vue`。
- 测试结果：`docs/迭代记录.md` 的 `54ea125` 条目记录：S12 后端冒烟 11/11（`backend/test/s12_question_import.py`，SQLite 临时库）；admin `npm run build` 通过。同条目注明：Docker/openGauss 未启动，迁移 011 落库与浏览器验收**待验证**；批量导入的正式使用按用户要求待准入机制完成后开放。

### 2026-10-09
- 需求：组织架构人员明细查看——组织页两列人数可点击弹窗展示人员明细。
- 修改内容：新增 `get_org_users`（`:651-688`，diff +40 / -0 行），`scope=direct|all` 两种口径与组织树的 `direct_user_count` / `total_user_count` 一致，支持分页。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/api/routes/admin.py:678-693`、`backend/app/schemas/schemas.py:1306`/`:1321`、`admin/src/views/OrgsView.vue`。
- 测试结果：**待确认**（`docs/迭代记录.md` 的 `a740973` 条目只有「内容」，未记录验证结果）。仓库中存在同日期同主题报告 `backend/test/docs/s6-org-user-detail-report.md`（日期 2026-10-09，脚本 `backend/test/s6_org_user_detail.py`，8/8 通过），但该条目未登记它。

### 2026-10-02
- 需求：组织全名批量查询与驾驶舱计数优化，消除 N+1。
- 修改内容：diff +12 / -11 行。排名与人员明细的组织名改为批量 `org_service.get_full_name_map`（`:405-406`、`:675`），人员详情组织全名单点查询（`:555-559`）。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/services/org_service.py:77`、`backend/app/services/dashboard_service.py`。
- 测试结果：**待确认**（`docs/迭代记录.md` 的 `20c79e3` 条目未记录验证结果）。仓库中存在同日期同主题报告 `backend/test/docs/s7-perf-refactor-report.md`（日期 2026-10-02，5/5 通过），但该条目未登记它。

### 2026-10-02
- 需求：组织树接口与管理端新增直属/含下级人数统计（「PC 端组织人数统计」重新纳入）。
- 修改内容：diff +23 / -1 行。`get_org_tree` 增加 `direct_user_count` / `total_user_count`（`:610-627`），新增 `_accumulate_user_count`（`:635-641`）后序累加。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/schemas/schemas.py:1266`/`:1282`、`admin/src/views/OrgsView.vue`。
- 测试结果：**待确认**（`docs/迭代记录.md` 的 `e4f21df` 条目未记录验证结果）。仓库中存在同日期同主题报告 `backend/test/docs/s5-org-user-counts-report.md`（日期 2026-10-02，7/7 通过），但该条目未登记它。

### 2026-10-02
- 需求：管理端驾驶舱/大屏聚合接口；节点与题库管理扩展内容字段。
- 修改内容：diff +13 / -2 行。路线节点内容字段（`brief` / `significance` / `figures` / `location` / `images` / `audio` / `keywords`）纳入归一化与校验（`:106-111`）。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/services/dashboard_service.py`、`backend/app/schemas/schemas.py:1328`/`:1368`、`docker/init/005_upgrade.sql:45-46`。
- 测试结果：**待确认**（`docs/迭代记录.md` 的 `2289fdd` 条目未记录验证结果）。仓库中存在同日期同主题报告 `backend/test/docs/s4-admin-dashboard-report.md`（日期 2026-10-02，13/13 通过），但该条目未登记它。

### 2026-10-01
- 需求：微信名称直登与昵称仅可修改一次；排名洞察展示改名记录（三端）。
- 修改内容：diff +4 / -0 行。排名查询与明细增加 `original_nickname` / `nickname_changed_at`（`:281-282`、`:317-318`）。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/services/auth_service.py`、`admin/src/pages/RankingsView.vue`、`frontend/pages/mine/`。
- 测试结果：**待确认**（`docs/迭代记录.md` 的 `f820e0e` 条目未记录验证结果）。

### 2026-10-01
- 需求：管理后台人员详情聚合接口（排名页点击人员展示全部业务数据）。
- 修改内容：新增 `get_user_overview`（`:489-599`，diff +112 / -1 行），一次返回基本信息、运动（今日/累计/近 7 日）、答题记录、勋章、长征节点、积分（拆分 + 名次 + 流水）。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/api/routes/admin.py:369-378`、`backend/app/schemas/schemas.py:1552`、`admin/src/pages/RankingsView.vue`。
- 测试结果：**待确认**（`docs/迭代记录.md` 的 `e7e2349` 条目只有标题与范围，未记录内容与验证结果）。

### 2026-10-01
- 需求：新增管理后台 API（登录/题库/组织架构/路线节点/排名）。
- 修改内容：文件创建（diff +558 / -0 行），初版包含路线节点维护、题库 CRUD、组织树/组织增删改与外部同步、排名列表。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/api/routes/admin.py`、`backend/app/schemas/schemas.py`、`docker/init/010_admin_identity.sql`、`admin/src/api/admin.ts`。
- 测试结果：**待确认**（`docs/迭代记录.md` 的 `337af78` 条目只有「内容：登录/题库/组织架构/路线节点/排名」，未记录验证结果）。
