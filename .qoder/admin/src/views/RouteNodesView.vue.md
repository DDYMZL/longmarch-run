# RouteNodesView.vue

## 1. 文件路径

`admin/src/views/RouteNodesView.vue`（396 行）

## 2. 文件职责

「路线点位」页（`<script setup>` 单文件组件）：`route_nodes` 表（长征路线 10 个种子节点及其扩展字段）的管理端唯一维护入口。一次性全量拉取节点列表，前端按名称关键字与启用状态过滤；提供新增/编辑弹窗（基础字段 + 01ec93c 扩展的「节点详情内容」字段组：一句话简介、历史意义、相关人物、地点、关键词、图片链接列表、音频链接）与启用/停用切换（confirm 提示路线影响）。**无删除入口**（后端也无 DELETE 端点，节点只能停用）；**无 Excel 导入、无 CSV 导出、无分页**——与题库/寄语两页不同，本页是纯表单维护页。保存与启停均由后端校验「启用路线目标步数随展示顺序严格递增、至少保留一个启用节点」，前端仅以 `el-alert` 提示该约束。

## 3. 业务需求

- 需求出处：`.qoder/REQUIREMENTS.md` §6「长征路线与节点点亮」（§6.1「节点」各行：节点数 10、解锁依据 `target_steps`、点亮永久保留；§6.1 末注明「这些是种子默认值，**管理端可改**（`route_nodes` 表可编辑）」）与 §11.5「其它管理页」`RouteNodesView` 行（「路线节点管理：**前端做筛选，未做服务端分页**（数据量小）」——本页现状与该行描述一致）。
- 节点详情内容字段服务于小程序节点详情页/历史事件卡（`backend/app/models/models.py:33-35` ORM docstring：brief/significance/figures/location/images/audio/keywords 为「历史事件卡」字段；`:35` 起）。
- **无 Excel 导入 / CSV 导出需求记录**：`.qoder/REQUIREMENTS.md` §11.6 的导入导出规则不覆盖路线节点，git 历史（仅 2 个提交，见 §10）中也从未出现过导入/导出代码。
- 演进：`81b86e5`（2026-10-01）创建（基础字段维护 + 启停 confirm + 前端过滤）→ `01ec93c`（2026-10-02）表单扩展 7 个节点详情内容字段与图片列表（≤9 张）。此后未再改动。

## 4. 核心功能

### 4.1 路由、菜单码与前后端双重守卫

- 路由：path `/route-nodes`、name `route-nodes`、`meta.menu = 'route_nodes'`，懒加载本文件（`admin/src/router/index.ts:44-49`）。**菜单码用下划线 `route_nodes`、路由 path 用连字符 `/route-nodes`**，属刻意差异（`admin/src/router/menus.ts:7`）；`meta.title`「路线点位」与 `menus.ts:7` 的 title 是两份手工同步的副本（`router/index.ts` 12 处 `meta.title` 皆如此）。
- 前端守卫：`router/index.ts:112-116` 无 `route_nodes` 码回退 `firstAllowedPath()`（`:9-12`）；`hasMenu`（`admin/src/store/auth.ts:27-29`）；侧边栏过滤 `admin/src/layout/AdminLayout.vue:15`（图标 `Location`）。
- 后端守卫：4 个端点全挂 `Depends(require_menu("route_nodes"))`（`backend/app/api/routes/admin.py:248`、`:259`、`:274`、`:294`）。

### 4.2 全量加载与前端过滤（无分页）

- 状态（`:13-16`）：`loading`、`nodes`（全量）、`keyword`、`statusFilter`。
- `loadNodes`（`:26-34`）：`fetchRouteNodes()`（不 silent）→ `nodes.value = data.items`；`try…finally` 无 `catch`（失败全局 toast、保留旧数据）、**无竞态守卫**（本页无自动重拉，仅 mount/刷新/保存后调用，风险低）。触发：`onMounted(loadNodes)`（`:188`）、「刷新」按钮（`:202`）、保存/启停成功后（`:153`、`:185`）。
- `filtered` computed（`:18-24`）：状态过滤（enabled/disabled）+ `node.name.includes(keyword.trim())` 前端包含匹配（**非服务端搜索**、无防抖、无 LIKE 转义问题——纯内存过滤）。数据量小（种子 10 节点），符合 `.qoder/REQUIREMENTS.md` §11.5 该行备注与根 `agents.md` §2.4 的权衡。
- 后端 `admin_service.list_route_nodes`（`backend/app/services/admin_service.py:38-40`）：按 `(sort_order, id)` 升序全量返回，无分页参数、无 enabled 过滤。
- 表格（`:205-243`）：外层 `.table-wrap` 横向滚动 + 表格 `min-width: 1120px`（`:346-353`）；`border stripe row-key="id"`、自定义空态 `empty-text="暂无路线点位"`（`:212`）。列：顺序(sort_order)、ID、节点（emoji 图标 `.node-icon` + 名称，`:216-220`）、历史时间、目标步数（右对齐）、坐标（`latitude, longitude` 原样拼接，`:223-225`）、状态（success「已启用」/info「已停用」标签）、历史介绍（`show-overflow-tooltip`）、操作（编辑 + 停用/启用，`fixed="right"`，`:234-241`）。
- 工具栏（`:193-203`）：关键字输入、状态 `el-select`（clearable）、**「共 N 个点位」按 `nodes.length` 全量计数**（`:200`，不随筛选变化）、「新增点位」、「刷新」。

### 4.3 新增 / 编辑弹窗

- 表单 `form` 以 `reactive<RouteNodeUpsert>` 声明（`:40-57`），16 个字段与契约类型一一对应；`assignForm`（`:71-73`）用 `Object.assign` 整体覆写。
- `openCreate`（`:75-97`）**预填**：取 `nodes` 末位元素（列表按 sort_order,id 排序，即当前路线最后一个节点，且**不受前端筛选影响**）——`target_steps = last.target_steps + 5000`、`latitude/longitude = last 的坐标`、`sort_order = last.sort_order + 1`（`:76`、`:81`、`:84-86`）；空列表时全为 0/1。
- `openEdit`（`:99-120`）逐字段回填，`images: [...row.images]` 浅拷贝避免直接改列表数据（`:115`）。
- 校验 `rules`（`:59-65`）：name/target_steps/latitude/longitude/sort_order 必填（trigger: blur/change）。模板层约束：name maxlength 50、icon 16（placeholder「如 🚩」）、historical_time 50、description textarea 5 行 2000、brief 100（show-word-limit）、significance 1000、figures 500（placeholder「多个人物用中文逗号分隔」）、location 100、keywords 100（placeholder「英文逗号分隔」）、图片/音频 URL 各 500（`:248-302`）；`el-input-number`：target_steps min 0 step 1000、sort_order min 0、latitude ±90 / longitude ±180（precision 6、step 0.001）（`:254-265`）。
- 表单布局：`.form-grid` 双列网格（基础字段组 `:247-266` 与 地点/关键词 `:283-290`），`el-divider`「节点详情内容（小程序节点详情页展示）」分隔扩展字段区（`:273`）；末尾常驻 `el-alert`「启用节点会按显示顺序参与路线进度计算，目标步数必须逐点递增。」（`:306`）；启用状态 `el-switch`（active-text/inactive-text，`:303-305`）。弹窗宽 `min(720px, 92vw)`、`destroy-on-close`（`:245`）。
- `handleSave`（`:122-157`）：validate → 组 payload（全部文本 `.trim()`；`images` 逐项 trim 并 `filter(Boolean)` 去空行，`:125-142`）→ `createRouteNode`/`updateRouteNode(editingId)` → 关弹窗、`await loadNodes()`；`saving` 锁按钮（`:310`）。无 `catch`，失败弹窗保持打开、全局 toast（后端 400 的递增校验文案由此透出）。
- 图片列表：`addImage` 上限 9（`:159-165`，超出 warning「最多 9 张图片」）、`removeImage`（`:167-169`）；**仅前端限制**（§9 第 5 项）。

### 4.4 启用 / 停用切换（无删除）

- `handleToggle`（`:171-186`）：先 `ElMessageBox.confirm`（**无 `.catch()`**，取消即未处理 rejection，§9 第 3 项），提示文案区分方向——启用：「启用后小程序会将其加入路线」；停用：「停用后小程序将隐藏该节点并重算路线完成度，**历史点亮记录不会删除**」（`:174-177`）→ `setRouteNodeEnabled(row.id, nextEnabled)`（PATCH）→ toast + `loadNodes()`。无行级 loading 锁（§9 第 7 项）。
- 后端 `admin_service.set_route_node_enabled`（`:81-97`）与 create/update（`:43-78`）共用同一提交模式：改库 → `flush` → `_validate_enabled_route` → 通过才 `commit`，否则 `rollback` 并抛 `ValueError` → 路由转 400（`admin.py:264-267`、`:281-286`、`:301-308`；节点不存在 404 `:285-286`、`:307-308`）。
- `_validate_enabled_route`（`admin_service.py:124-138`）两条硬约束：① 启用节点非空（「至少需要保留一个启用节点」`:132-133`）；② 启用节点按 `(sort_order, id)` 排序后 `target_steps` **严格递增**（`:134-138`，报错文案含冲突两节点名）。前端不做该预校验（§9 第 4 项）。
- **无删除能力**：本页无删除按钮，后端也无 `DELETE /admin/route-nodes/{id}` 端点（`admin.py:243-309` 仅 GET/POST/PUT/PATCH）。节点 id 被 `daily_quotes.node_id` 外键（`docker/init/007_daily_quotes.sql:13`）与历史点亮记录引用，只可停用不可删——与停用 confirm 文案「历史点亮记录不会删除」一致。

### 4.5 与公共组件/工具的关系

- **不引用 `components/` 下任何公共组件**（无 `ExcelImportDialog`、无 `AiGenerateDialog`；导入仅 `:2-11`）。
- 不使用 `utils/download.ts`、`utils/format.ts`（列表无时间字段）、不订阅 WebSocket。
- 图标以字符串引用（`'Delete'` `:295`、`'Plus'` `:297`），均已在 `admin/src/main.ts` 全局注册（`:48`、`:62`）；侧边栏 `Location` 图标来自 `menus.ts:7`。
- 窄屏适配：`@media (max-width: 760px)` 时 form-grid 单列、关键字/状态筛选全宽、spacer 隐藏（`:382-395`）；toolbar `flex-wrap`（`:326`）。

## 5. 输入与输出

- 输入：无 props / 无 emits（路由页面）。隐式输入为登录态 Token（`request.ts:19-25`）与用户操作。
- 类型（`admin/src/api/admin.ts`）：`RouteNode`（`:85-103`，17 字段含 `id`）、`RouteNodeUpsert = Omit<RouteNode, 'id'>`（`:105`）、`RouteNodeListResult`（`:107-110`）。
- 端点链（api 函数 → 路由 → service）：
  - `fetchRouteNodes(silent?)`（`admin.ts:582-584`）→ GET `/api/admin/route-nodes`（`admin.py:244-252`）→ `admin_service.list_route_nodes`（`:38-40`）；响应 `{total: len(items), items}`；
  - `createRouteNode`（`:586-588`）→ POST（`admin.py:255-267`）→ `create_route_node`（`:43-57`，**id 显式取 max+1**，无数据库自增）；
  - `updateRouteNode`（`:590-592`）→ PUT `/{id}`（`admin.py:270-287`）→ `update_route_node`（`:60-78`，404「路线节点不存在」）；
  - `setRouteNodeEnabled`（`:594-598`，body `{is_enabled}`）→ PATCH `/{id}/enabled`（`admin.py:290-309`）→ `set_route_node_enabled`（`:81-97`）。
- 请求体 Pydantic：`AdminRouteNodeUpsert`（`backend/app/schemas/schemas.py:1368-1382`：name 1–50、icon ≤16、target_steps ≥0、historical_time ≤50、latitude ±90、longitude ±180、sort_order ≥0、brief ≤200、figures ≤500、location ≤100、images `List[str]`；audio/keywords 的长度约束在 `:1382` 之后，**待确认**具体数值）、`AdminRouteNodeEnabled`（`:1387-1388`）。
- 服务端二次校验：`_normalize_route_node_data`（`admin_service.py:100-121`）trim 全部文本、剔除空 images 项、name 非空、target_steps/sort_order ≥0、经纬度范围（与 Pydantic 部分重叠，双保险）。
- 错误码：422（Pydantic 字段约束）；400（`ValueError` 文案：递增冲突/至少一个启用节点/name 空/范围非法）；404（节点不存在）；403（无 `route_nodes` 码）。
- 输出：无返回值；写 `route_nodes` 表，直接影响小程序路线进度计算（`march_service`）与寄语关联下拉（`views/QuotesView.vue`）。

## 6. 依赖关系

- 导入（`:2-11`）：`vue`（computed/onMounted/reactive/ref）、`element-plus`（ElMessage/ElMessageBox + FormInstance/FormRules 类型）、`../api/admin`（4 个函数 + 2 个类型）。
- 被依赖：`admin/src/router/index.ts:44-49`（`/route-nodes` 懒加载）。
- 数据来源：`route_nodes` 表（种子 10 节点由 `backend/app/data/seed.py` 写入，`.qoder/REQUIREMENTS.md` §6.1「节点数」行；`docker/init/002_route_node_config.sql` 配置节点详情字段——**注意其 `:8-36` 的 UPDATE 无 WHERE 子句，id 1–10 的经纬度在每次重跑初始化时被无条件覆盖**，已记录于 `.qoder/ARCHITECTURE.md` §12.4；文档 `.qoder/docker/init/002_route_node_config.sql.md`）。ORM：`backend/app/models/models.py:32` `RouteNode`。
- 后端文档：`.qoder/backend/app/api/routes/admin.py.md`、`.qoder/backend/app/services/admin_service.py.md`。
- 关联页面：`views/QuotesView.vue` 的关联节点下拉读同一 `fetchRouteNodes`；小程序 `pages/march`（路线/点亮）、`pages/node-detail`（详情内容字段消费方）；排名洞察（`pages/RankingsView.vue`）展示节点到达时间。

## 7. 业务规则

1. **权限**：查看与全部写操作需 `route_nodes` 菜单码（前端守卫 + 后端 `require_menu` 双保险，§4.1）。
2. **启用路线两条硬约束**（后端事务内校验，`admin_service._validate_enabled_route:124-138`）：至少保留一个启用节点；启用节点按 `(sort_order, id)` 排序后 `target_steps` 严格递增。任何 create/update/启停违反即整体回滚返回 400。
3. **节点只可停用不可删除**：无删除端点与入口（§4.4）；停用不删除历史点亮记录（confirm 文案 `:176`、`admin_service.py:84` docstring），小程序隐藏该节点并重算完成度。
4. **列表顺序即路线顺序**：`(sort_order, id)` 升序（`admin_service.py:40`），页面不提供排序切换；`openCreate` 依末位节点预填 `target_steps + 5000`、`sort_order + 1`（`:81-86`）。
5. **字段上限**：前端 maxlength（name 50 / icon 16 / historical_time 50 / description 2000 / brief 100 / significance 1000 / figures 500 / location 100 / keywords 100 / URL 500）与后端 Pydantic 约束大体对齐，其中 brief 前端 100 严于后端 200（`schemas.py:1378`）；images ≤9 张仅前端限制。
6. **文本归一化在后端**：所有文本字段 trim、空图片 URL 剔除（`_normalize_route_node_data:100-111`；前端 `handleSave` 也做了一遍，`:125-142`，双保险）。
7. **id 稳定性**：新增节点 id 取 `max(id) + 1`（`admin_service.py:46-47`，与 questions 同因——种子占用固定 id、无自增依赖），编辑不改 id，保证点亮记录与寄语 `node_id` 外键不漂移（`update_route_node:63` docstring「节点 id 与历史点亮关系保持不变」）。
8. **筛选是纯前端行为**：keyword/状态过滤不改查询（`:18-24`），「共 N 个点位」恒为全量数（`:200`）。
9. 本页数据无时间字段，不涉及时区口径。

## 8. 修改约束

- **递增/非空约束的提示链**：后端 `_validate_enabled_route`（`admin_service.py:124-138`）是唯一强制点，前端只有 `el-alert`（`:306`）与 confirm 文案；若要前端预校验，必须与后端规则完全一致（比较基准是**启用节点**按 `(sort_order, id)` 的相邻对，不是全量节点），否则会挡住后端本可接受的保存。
- **不得引入删除节点功能**而不先处理引用完整性：`daily_quotes.node_id` 外键（`007_daily_quotes.sql:13`）、历史点亮/排名数据均按 node_id 关联；现行「只停用」是刻意设计（§7 第 3 条）。
- **契约三处同步**：`RouteNodeUpsert`（`admin.ts:105`）↔ `AdminRouteNodeUpsert`（`schemas.py:1368` 起）↔ ORM `RouteNode`（`models.py:32` 起）字段一一对应（管理端 snake_case）；增字段还须同步 `_normalize_route_node_data` 的 trim 清单（`admin_service.py:102-111`）、本页 `openCreate`/`openEdit`/`handleSave` 三处字段列举（`:78-95`、`:101-118`、`:125-142`）与小程序消费端。
- **坐标数据慎改**：`docker/init/002_route_node_config.sql` 重跑会无条件覆盖 id 1–10 经纬度（`.qoder/ARCHITECTURE.md` §12.4）；在本页改坐标属正常途径，但须知道初始化重跑的覆盖行为。
- **若数据量增长须改服务端分页/搜索**：当前全量加载 + 前端过滤仅在「数据量小」前提下成立（`.qoder/REQUIREMENTS.md` §11.5 `RouteNodesView` 行、根 `agents.md` §2.4）；改造时参照 `QuestionsView.vue:30-66` 的 requestSeq + 防抖模式。
- `row-key="id"`、`.table-wrap` 横向滚动 + `min-width: 1120px`（`:346-353`）与 760px 媒体查询（`:382-395`）是窄屏可用性防线（`admin/agents.md`「开发约定」第 3 条），增删列时保留。
- 若未来给本页加导出/导入：导出必须走 `utils/download.ts` 的 `csvCell`（`admin/agents.md` 第 4 条）；导入应复用 `ExcelImportDialog` + 后端两阶段令牌模式（`.qoder/ARCHITECTURE.md` §8.2），并注意导入也必须过 `_validate_enabled_route`。

## 9. 当前实现状态

- **已实现**：全量列表（路线顺序）+ 名称/状态前端过滤 + 自定义空态（`:212`）；新增（带末位节点预填）/编辑（16 字段全量表单，双列布局 + 详情字段分区）；启用/停用（双向 confirm 文案说明路线影响）；后端递增与非空启用校验的 400 透出；窄屏横向滚动与媒体查询。验收记录见 §10。
- **存在问题 / 已知事项**：
  1. **无 Excel 导入 / CSV 导出 / 分页**（`:26-34` 全量加载；全文无 `ExcelImportDialog`/`utils/download` 引用）——与题库、寄语两页能力不对齐；当前无需求记录（§3），数据量小可接受，是否补齐**待确认**。
  2. `handleSave` 的 `el-alert`（`:306`）之外**无前端递增预校验**：违反约束要等后端 400 才发现，且报错只在保存时触发；停用/启用同样（`handleToggle` 无预检）。
  3. `handleToggle` 的 `ElMessageBox.confirm` **无 `.catch()`**（`:173-182`）：取消即未处理 rejection（与 `AdminLayout.vue:17-21` 同模式，本页这处未见既有文档记录）。
  4. `loadNodes` 无 `catch`、无竞态守卫（`:26-34`）：失败保留旧数据且无错误态标识；本页调用频率低，风险小于题库/寄语页。
  5. `images` ≤9 仅前端限制（`:159-165`）：后端 `List[str]` 无数量约束（`schemas.py:1382`）、`_normalize_route_node_data` 只去空（`admin_service.py:109-111`）；图片/音频 **URL 格式与协议不校验**（`:294`、`:301` 仅 maxlength 500），任意字符串可入库并在小程序端渲染。DB 侧 images 存储类型与长度上限**待确认**（查 `models.py:32` 起列定义）。
  6. 关键字过滤用 `includes` 大小写敏感、仅匹配 `name`（`:22`），不含历史时间/介绍等字段；纯前端行为，无服务端搜索。
  7. `handleToggle` 无行级 loading/禁用锁（对比 `QuotesView.vue:153-163` 的 `togglingId`）：请求期间可重复点击并发 PATCH（后端幂等，最终一致，但会产生多余请求）。
  8. 「共 N 个点位」按全量 `nodes.length` 计数（`:200`），与筛选后可见行数不一致，易误读。
  9. `openCreate` 预填取的是**未过滤**列表末位（`:76`）：若末位节点已停用，预填的 `target_steps + 5000` 与坐标仍以其为基准；预填只是便利值，保存时以后端校验为准。
  10. `latitude/longitude` 必填规则（`:62-63`）对数值 0 视为已填（async-validator 语义），`openCreate` 空列表兜底 0（`:84-85`），可保存出 (0,0) 坐标节点；后端范围校验同样放行（`admin_service.py:118-121`）。
- **待开发**：无本页专属待办；导入/导出/服务端分页均无需求记录（§9 第 1 项待确认）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/views/RouteNodesView.vue`，共 **2 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目（按提交号检索）。

### 2026-10-02（`01ec93c`）
- 需求：路线点位表单扩展节点详情内容字段（同批新增驾驶舱/数据大屏页面、题库知识分类）。
- 修改内容（涉本文件）：+85/-4（`git show --numstat` 实测）——`form`/`openCreate`/`openEdit`/`handleSave` 四处字段清单各追加 brief/significance/figures/location/images/audio/keywords 7 字段；新增 `addImage`（上限 9）/`removeImage`；模板加 `el-divider`「节点详情内容」分区、7 个输入控件与图片链接列表 UI；新增 `.image-list`/`.image-row` 样式。
- 关联文件：`admin/src/views/QuestionsView.vue`（知识分类）、`admin/src/views/DashboardView.vue`/`ScreenView.vue`（新建）、`admin/src/api/admin.ts`（RouteNode 类型扩展）、`backend`（schemas/admin_service/模型扩展）、小程序节点详情页。
- 测试结果：见 `docs/迭代记录.md` 的 `01ec93c` 条目。

### 2026-10-01（`81b86e5`）
- 需求：管理后台新增排名洞察与路线节点维护页面。
- 修改内容（涉本文件）：创建本文件（+315 行）——全量节点列表（`fetchRouteNodes`）+ 前端 `filtered` 过滤（名称/状态）+ 新增/编辑弹窗（name/icon/target_steps/historical_time/description/latitude/longitude/sort_order/is_enabled 基础字段）+ 启用/停用 confirm 切换（`handleToggle`）+ `empty-text="暂无路线点位"` 空态与窄屏样式。
- 关联文件：`admin/src/pages/RankingsView.vue`（新建）、`admin/src/api/admin.ts`、`admin/src/router/index.ts`、`admin/src/layout/AdminLayout.vue`、`backend/app/api/routes/admin.py`（route-nodes 四端点）、`backend/app/services/admin_service.py`（`_validate_enabled_route` 等）。
- 测试结果：见 `docs/迭代记录.md` 的 `81b86e5` 条目。
