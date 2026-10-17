# OrgsView.vue

## 1. 文件路径

`admin/src/views/OrgsView.vue`（406 行）

## 2. 文件职责

「组织架构」页（`<script setup>` 单文件组件）：以 Element Plus **树形表格**一次性展示后端返回的完整组织树（`organizations` 表），提供组织节点的**新增 / 编辑 / 删除（级联，被用户引用的节点自动保留）**、**一键从外部系统全量同步组织架构**，以及点击「直属人数 / 成员总数（含下级）」两列标签打开的**分页人员明细弹窗**（`direct` / `all` 两种口径，与树上统计同源）。本页是 `organizations` 表在管理端唯一的维护入口，也是「组织维度人数统计」需求在 PC 端的落点（组织排名与按组织积分对比已取消，见 `.qoder/REQUIREMENTS.md` §2.3「PC 端组织人数统计」行）。

## 3. 业务需求

- 需求出处：`.qoder/REQUIREMENTS.md` §2.3「组织架构」（结构 / 种子数据 / 排序 / 锁定规则 / 外部同步 / PC 端组织人数统计各行）与 §11.5「其它管理页」`OrgsView` 行；菜单与权限模型见 §11.1；权限粒度为**菜单码、无按钮级权限**（§11.1「权限粒度」行）。
- 菜单码 `orgs` 由 `docker/init/010_admin_identity.sql` 种入 `admin_menus`（该文件的迁移说明见 `.qoder/docker/init/010_admin_identity.sql.md`）；内置角色 `operator` 是否含 `orgs` 以该 SQL 为准。`organizations` 建表见 `docker/init/001_schema.sql:33-42`（`id SERIAL PRIMARY KEY`、`name VARCHAR(80) NOT NULL`、`parent_id`、`level NOT NULL`、`sort_order NOT NULL`，索引 `ix_organizations_parent_id`，**无 name 唯一约束**），说明见 `.qoder/docker/init/001_schema.sql.md`。序列修复见 `docker/init/009_org_serial.sql:12`（`.qoder/docker/init/009_org_serial.sql.md`）；组织树种子由 `backend/app/data/seed.py:318`（`ORGANIZATIONS` 常量，13 个组织）在 `:423` 写入，**没有任何迁移脚本 INSERT 组织数据**。
- 演进（数据来源 `git log --follow --oneline -- admin/src/views/OrgsView.vue`，共 5 个提交）：
  - `4a26520`（2026-09-30）创建本页（树形表格 + 增删改 + 同步）。
  - `e4f21df`（2026-10-02）新增「直属人数 / 成员总数（含下级）」两列——提交说明明确「组织维度需求重新纳入（**仅人数统计，不含排名**）」。
  - `7607d7b`（2026-10-08）`handleSave` 补 `catch`（保存失败保持弹窗打开）。
  - `a740973`（2026-10-09）新增 `GET /admin/orgs/{id}/users` 对接的人员明细弹窗（分页、空态、点击不触发展开）。
  - `30b4458`（2026-10-11）大组织树按需展开（`EXPAND_ALL_LIMIT`）、人员明细请求竞态守卫（`memberSeq`）、删除页面私有 `memberTime` 改用共享 `formatDateTime`。

## 4. 核心功能

### 4.1 路由、菜单码与前后端权限守卫

- 路由：path `/orgs`、name `orgs`、`meta: { title: '组织架构', menu: 'orgs' }`（`admin/src/router/index.ts:63-66`）；侧边栏条目「组织架构」+ `OfficeBuilding` 图标（`admin/src/router/menus.ts:10`，该图标已在 `admin/src/main.ts:21`/`:61` 全局注册）。
- 前端守卫：`store/auth.ts:27-29` 的 `hasMenu('orgs')`（超管恒真）→ `router/index.ts` 无权回退 `firstAllowedPath()`（`:9-12`）；侧边栏过滤 `layout/AdminLayout.vue:15`。
- 后端守卫：本页调用的 **6 个接口全部**挂 `Depends(require_menu("orgs"))`——`admin.py:670`（树）、`:680`（人员明细）、`:700`（新增）、`:713`（编辑）、`:728`（删除）、`:741`（同步）。前端隐藏不是安全边界。
- **本页与后端口径一致**（都要求 `orgs`），不存在 `.qoder/admin/src/views/AccessView.vue.md` §9 第 8 项那类「UI 严于/宽于后端」的错配。反向的耦合是：`AccessView`「调整所属组织」与 `InvitesView`「组织范围」下拉都要调 `/admin/orgs`，但后端 `PUT /admin/users/{id}/org` 只校验 `access`（`admin.py:805-810`），详见该文档 §9 第 8 项。

### 4.2 状态清单

| 状态 | 行 | 含义 |
|---|---|---|
| `loading` | `:11` | 树表格 `v-loading`（`:245`） |
| `syncing` | `:12` | 「同步组织架构」按钮 `:loading`（`:223`） |
| `total` | `:13` | 节点总数，来自 `data.total`（`:35`）；同时驱动 `expandKeys` 的展开策略 |
| `treeData` | `:14` | `OrgNode[]`，**完整树**（后端一次返回，无分页） |
| `lastSyncSource` | `:15` | 最近一次同步的数据源描述，驱动 `:231-242` 的 `el-alert` |
| `EXPAND_ALL_LIMIT` | `:17` | 常量 200，超过则只展开顶级 |
| `expandKeys` | `:18-28` | computed，递归收集要展开的 row-key |
| `dialogVisible`/`saving`/`editingId`/`formRef` | `:66-69` | 新增/编辑弹窗；`editingId === null` 即新增 |
| `form` | `:71-75` | `{ name, parent_id, sort_order }`，对应 `OrgUpsert` |
| `rules` | `:77-79` | 仅一条：`name` required（`trigger: 'blur'`） |
| `dialogTitle` | `:81` | computed，「新增组织」/「编辑组织 #id」 |
| `parentTreeData` | `:84-94` | computed，`el-tree-select` 数据，编辑时禁用自身及子孙 |
| `memberDialogVisible`/`memberLoading`/`memberScope`/`memberOrgId`/`memberOrgName`/`memberTotal`/`memberItems`/`memberPage` | `:166-173` | 人员明细弹窗 |
| `memberPageSize` | `:174` | **普通常量 20**（非 ref），无每页条数选择器 |
| `memberDialogTitle` | `:176-180` | computed，按 `memberScope` 区分两种口径标题 |
| `memberSeq` | `:192` | 模块级自增序号，请求竞态守卫 |

### 4.3 树加载与「按需展开」渲染策略

- `loadTree`（`:30-39`）：`const { data } = await fetchOrgTree()`（**未传 `silent`**，默认 `false`，故失败会弹全局 toast，符合「本页就是 orgs 权限页」的定位）→ 写 `treeData`/`total`；`try…finally` 关 loading，**无 `catch`**（§9 第 2 项）。触发点：`onMounted(loadTree)`（`:217`）、「刷新」按钮（`:227`）、以及同步/保存/删除成功后（`:52`、`:143`、`:162`）。
- 后端 `admin_service.get_org_tree`（`backend/app/services/admin_service.py:603-632`）：一次 `db.query(Organization).order_by(sort_order, id).all()` 全表加载 + 一次 `GROUP BY org_id` 的人数聚合（`:610-615`，避免 N+1），在内存里用 `tree_map` 挂 children（`_fill_children:644-648`）并后序累加 `total_user_count`（`_accumulate_user_count:635-641`）。**接口无分页参数**。
- `expandKeys`（`:18-28`）：`walk(treeData.value, total.value <= EXPAND_ALL_LIMIT)`——节点总数 ≤200 时深度遍历收集全部 id（全展开），否则 `deep=false` 只收集顶级 id。`:16` 注释即「节点过多时只展开顶级，避免整棵树一次性渲染全部行」，是 `30b4458` 的落点。
- `:249` 是**单向绑定** `:expand-row-keys="expandKeys"`（非 `v-model`），因此每次 `loadTree()` 重建数据后展开态都会回到计算值，用户手动展开的分支在增删改/同步/刷新后被重置（§9 第 4 项）。
- 表格未开 `lazy`，`:250` 只有 `:tree-props="{ children: 'children' }"`：**全树常驻内存**，展开策略只影响可见行数，不影响传输量（§8）。

### 4.4 树形表格列（`:244-293`）

| 列 | 行 | 说明 |
|---|---|---|
| 组织名称 | `:252` | `prop="name"`，`min-width="260"`，树形缩进由此列承担；**只显示本级名称，不显示完整路径** |
| ID | `:253` | `width="80"` 居中 |
| 层级 | `:254-258` | `el-tag size="small" type="info"`，文案 `L{level}`；`level` 由后端维护（顶级 1，`_resolve_level:765-772`） |
| 排序 | `:259` | `prop="sort_order"` |
| 直属人数 | `:260-272` | `el-tag`，>0 为 `success` 否则 `info`；`class="count-tag"`（`:386-393` 鼠标手型 + hover 上浮）、`title="查看直属人员明细"`、`@click.stop="openMemberDialog(row, 'direct')"` |
| 成员总数（含下级） | `:273-285` | 同上，>0 为 `warning`，`@click.stop="openMemberDialog(row, 'all')"` |
| 操作 | `:286-292` | `width="220"` `fixed="right"`：新增下级 / 编辑 / 删除 |

`@click.stop`（`:267`、`:280`）是 `a740973` 的显式验收点（提交说明「点击不触发展开且关闭后页面状态保持」）——去掉 `.stop` 会让人数标签同时切换行展开态。

### 4.5 新增 / 编辑弹窗（`:295-319`）

- 打开：`openCreate(parent)`（`:109-115`）——`parent` 为 `null` 时是「新增顶级组织」（`:226`），否则由行内「新增下级」传入该行（`:288`）预填 `parent_id`；`openEdit(row)`（`:117-123`）回填三字段。两者都不重置校验态，靠 `destroy-on-close`（`:295`）保证下次是干净表单。
- 表单校验：`rules` 只有 `name` 必填（`:78`）。`handleSave`（`:125-149`）先 `await formRef.value?.validate().catch(() => false)`，不通过直接 return；通过后组 payload：`name` **trim**、`parent_id` 原值（可为 `null`）、`sort_order` 经 `Number()` 归一。
- 控件约束：名称 `el-input maxlength="80"`（`:298`，与 `001_schema.sql:35` 的 `VARCHAR(80)` 对齐）；上级组织 `el-tree-select` + `check-strictly` + `clearable` + 占位「留空表示顶级组织」（`:301-308`）；排序号 `el-input-number :min="0" :max="9999"`（`:311`，**上限仅前端约束，后端 `int(data.get("sort_order") or 0)` 无界**，`admin_service.py:698`）。
- **前端防环**：`parentTreeData`（`:84-94`）在编辑态用 `collectSubtreeIds(treeData, editingId)`（`:96-107`）算出「自身 + 全部子孙」的 id 集合并逐项 `disabled`，从下拉里就选不到会成环的父节点。**后端有独立同名校验**：`admin_service.update_org:715-719` 对 `parent_id == org_id` 抛「上级组织不能是自身」、对 `_is_descendant`（`:775-777`）抛「上级组织不能是自身的下级，否则将产生环」→ 路由转 400（`admin.py:717-719`）。两侧都要保留（§8）。
- 保存：新增走 `createOrg(payload)`、编辑走 `updateOrg(editingId, payload)`（`:135-141`），成功提示后 `dialogVisible = false` 并 `await loadTree()`；`catch {}` 空实现 + 注释「错误提示由 axios 拦截器统一弹出；保持弹窗打开便于修改后重试」（`:144-145`，`7607d7b` 补入）——**本页唯一有 `catch` 的写操作**。
- 后端副作用：`create_org` 自动算 `level`（`:691-703`）；`update_org` 在父节点变更后 `_shift_subtree_level` 用**单条批量 UPDATE** 平移整棵子树的 `level`（`:727-728`、`:780-787`）。**组织架构的增删改不写审计日志**（`admin_service.py:691-762` 无 `audit_service.record` 调用），与邀请码 / 活动 / 授权 / 用户组织调整都留痕的做法不一致（§9 第 12 项）。

### 4.6 删除（级联 + 保留被引用节点）

- `handleDelete(row)`（`:151-163`）：先按 `row.children.length` 生成两套确认文案——有子组织时明示「将级联删除整棵子树（仍被用户引用的节点会自动保留）」并给出子组织数量；确认框 `type="warning"`、确认按钮文案「删除」+ `confirmButtonClass: 'el-button--danger'`（`:158`）。
- **`await ElMessageBox.confirm(...)` 未包 try/catch**（`:153-159`），取消即产生未处理的 Promise rejection（§9 第 1 项）。
- 后续 `const { data } = await deleteOrg(row.id)` → `ElMessage.success(data.message)` → `await loadTree()`（`:160-162`），同样无 `catch`；接口失败时既不提示（拦截器已弹）也不刷新。
- 后端 `admin_service.delete_org`（`:733-762`）：取子树 id 集合 → 查子树内**被用户引用**的 org_id → 沿 `parent_of` 全表映射逐级上溯把**祖先也保留**（`:749-756`，注释说明「否则树断裂」，且父链一次加载不再查库）→ 其余批量 DELETE → 返回 `sorted(kept_ids)`；路由把非空 `kept` 拼成「部分节点仍被用户引用已保留：[ids]」（`admin.py:731-734`），即 `data.message` 直接来自后端。

### 4.7 一键同步外部组织架构

- `handleSync`（`:42-63`）：确认框文案完整交代语义（「新增/更新节点，外部已删除且无用户归属的节点会被移除」），`type="warning"`、确认按钮「开始同步」；同样**无 try/catch**（§9 第 1 项）。随后 `syncing = true` → `syncOrgs()` → 写 `lastSyncSource` → `await loadTree()` → `ElNotification`（`duration: 6000`）汇报 `source` 与 `created/updated/deleted/kept`，若 `skipped` 非空追加「以下节点仍被用户引用已保留：…」；`finally` 复位 `syncing`。
- 后端 `admin_service.sync_orgs`（`:791-858`）：`_fetch_org_source`（`:861-875`）在 `ORG_SYNC_API_URL` 为空时降级返回 `("seed（未配置 ORG_SYNC_API_URL，使用内置种子数据）", ORGANIZATIONS)`，配置时 `httpx.get(url, timeout=10)` 并接受裸数组或 `{data: [...]}`、字段兼容 `parentId|parent_id`/`sortOrder|sort_order`；按 **id upsert**（name/parent_id/level/sort_order 全量覆盖），数据源中不存在的本地节点无用户引用则删、有引用则计入 `skipped`（`:831-849`）。外部接口失败抛 `ValueError` → 路由转 **502**（`admin.py:745-748`）。
- `kept` 的语义是 `len(nodes)`，即**数据源节点数**（`:856`），不含本地额外保留的 `skipped` 节点，故 `:56` 的「现有 {kept} 个节点」在有 skipped 时会小于库里实际节点数（§9 第 8 项）。
- `source` 在 `external` 模式下是 `f"external（{url}）"`（`:875`），**原样回显 `ORG_SYNC_API_URL`** 到界面（`:51`、`:56`、`:240`）；配置该 URL 时不应内嵌 token 等凭证（§9 第 9 项）。
- `lastSyncSource` 只是组件内 `ref`，切页或刷新即丢失，不是持久化的「上次同步时间」（页面上也没有同步时间展示）。

### 4.8 人员明细弹窗（分页 + 竞态守卫）

- `openMemberDialog(row, scope)`（`:182-189`）：写 `memberScope`/`memberOrgId`/`memberOrgName`，`memberPage` 复位 1，开弹窗后 `await loadMembers()`。**不清空 `memberItems`**，故切换组织时旧数据会在 loading 遮罩下短暂可见（§9 第 10 项）。
- `loadMembers`（`:194-211`）：`memberOrgId === null` 直接 return；`const seq = ++memberSeq`（`:196`）→ 请求 → `if (seq !== memberSeq) return`（`:205`）→ 赋值；`finally` 内也只在 `seq === memberSeq` 时关 loading（`:209`）。`:191` 注释「快速切换组织/翻页时只采纳最后一次请求」，与 `.qoder/admin/src/views/AccessView.vue.md` §4.3 描述的 `requestSeq` 同一模式（`30b4458` 引入）。**主树的 `loadTree` 没有同类守卫**（树只有单一请求源，风险低）。
- 分页在**服务端**：`fetchOrgUsers(orgId, scope, page, 20)` → `admin.py:676-693`（`scope` 受 `pattern="^(direct|all)$"`、`page_size` 受 `ge=1, le=100` 约束，组织不存在返回 404）→ `admin_service.get_org_users`（`:651-688`）：`scope=all` 用 `org_service.subtree_org_ids` 一次 `IN` 查询整棵子树（`:663-665`），`direct` 用 `org_id ==`；先 `count()` 再 `order_by(User.id).offset().limit()`；组织全名经 `org_service.get_full_name_map` **批量**取（`:675`），无 N+1。
- 口径与树上数字严格一致（`admin_service.py:656-658` 文档串），这是 `a740973` 的核心验收点。
- 弹窗表格（`:322-341`）：人员ID / 昵称（`el-avatar :size="28"` + `memberInitial` 首字回退，`:213-215` 空名回退「员」）/ 所属组织（`show-overflow-tooltip`）/ 注册时间（`formatDateTime(row.created_at)`，`:335`）；**自定义空态** `<template #empty>` → `el-empty description="该统计口径下暂无人员"`（`:338-340`）。分页器 `layout="total, prev, pager, next"` + `background`（`:343-350`），`@current-change="loadMembers"`。

### 4.9 加载 / 空 / 错误态

- 加载：树 `v-loading="loading"`（`:245`）、人员弹窗 `v-loading="memberLoading"`（`:322`）、两个按钮 `:loading`（`:223`、`:317`）。
- 空态：人员弹窗有自定义 `el-empty`（`:338-340`）；**主树无自定义空态**，`treeData` 为空时只有 Element Plus 默认「暂无数据」。
- 错误态：本页无局部错误 UI（无 `el-result`/`el-alert` 错误分支）；`loadTree`/`handleSync`/`handleDelete` 均无 `catch`，失败仅靠 `api/request.ts:46-48` 的全局 toast，且**树保留上一次成功的数据**。唯一的信息条是 `:231-242` 的同步数据源 `el-alert`（`type="info"`，`title=""` + `#default` 插槽，`:closable="false"`）。

### 4.10 与公共组件、实时推送的关系

- **不引用 `admin/src/components/` 下任何公共组件**（导入仅 `:4-9`），两个弹窗都是页内内联 `el-dialog`。
- **不做 Excel 批量导入**：未使用 `admin/src/components/ExcelImportDialog.vue`（其 `ExcelImportApi` 三函数契约见该组件 `:10-14`）。组织数据的批量入口是 §4.7 的外部系统同步，不是 Excel。
- **不订阅 WebSocket**：未导入 `utils/liveUpdates`，人数变化需手动「刷新」（与 `.qoder/ARCHITECTURE.md` §6.4「仅 Dashboard/Screen/Rankings 三页接入实时推送」一致）。
- **无导出**：未使用 `utils/download.ts`。
- 时间格式化统一走 `admin/src/utils/format.ts` 的 `formatDateTime`（`:9` 导入，`:335` 调用）；`30b4458` 已删除本页私有 `memberTime`，**当前无私有格式化函数**。

## 5. 输入与输出

- 输入：无 props / 无 emits。隐式输入为 `store/auth` 的 localStorage 登录态（`api/request.ts:19-25` 注入 Bearer Token）与用户的树操作 / 弹窗表单。
- 输出：无返回值；副作用全部经后端落库。
- 调用的 `api/admin.ts` 函数与后端链路（`request.ts` 的 `baseURL` 为 `/api`；`request.ts:28` 的成功拦截器返回**完整 AxiosResponse**，故本页处处 `const { data } = await …` 自行解包）：

| 前端函数（`admin/src/api/admin.ts`） | 方法与路径 | 后端权限 | route → service | 本页调用点 |
|---|---|---|---|---|
| `fetchOrgTree(silent = false)`（`:747-749`） | GET `/api/admin/orgs` | `require_menu("orgs")`（`admin.py:670`） | `admin.py:672-673` → `admin_service.get_org_tree:603-632` | `:33`（未传 silent） |
| `fetchOrgUsers(orgId, scope, page, pageSize)`（`:767-771`） | GET `/api/admin/orgs/{id}/users` | 同上（`admin.py:680`） | `admin.py:682-693` → `admin_service.get_org_users:651-688` | `:199-204` |
| `createOrg(data)`（`:751-753`） | POST `/api/admin/orgs` | 同上（`admin.py:700`） | `admin.py:702-706` → `admin_service.create_org:691-703` | `:136` |
| `updateOrg(id, data)`（`:755-757`） | PUT `/api/admin/orgs/{id}` | 同上（`admin.py:713`） | `admin.py:715-722` → `admin_service.update_org:706-730` | `:139` |
| `deleteOrg(id)`（`:759-761`） | DELETE `/api/admin/orgs/{id}` | 同上（`admin.py:728`） | `admin.py:730-734` → `admin_service.delete_org:733-762` | `:160` |
| `syncOrgs()`（`:763-765`） | POST `/api/admin/orgs/sync` | 同上（`admin.py:741`） | `admin.py:743-748` → `admin_service.sync_orgs:791-858` | `:50` |

- TS 类型（均在 `admin/src/api/admin.ts`）：`OrgNode`（`:41-50`，含 `direct_user_count`/`total_user_count`/`children`）、`OrgTreeResult`（`:52-55`，`{ total, nodes }`）、`OrgUpsert`（`:57-61`）、`OrgSyncResult`（`:63-70`，`skipped: number[]`）、`OrgUserItem`（`:72-78`）、`OrgUserListResult`（`:80-83`）；删除返回 `MessageResult`（`:760`）。
- 错误码：参数校验失败 422（FastAPI）；无权限 403；组织不存在 404（`admin.py:692`、`:721`）；父节点非法 / 成环 400（`admin.py:705-706`、`:718-719`）；外部同步接口失败 **502**（`admin.py:747-748`）。

## 6. 依赖关系

- 导入（`:4-9`）：`vue`（`computed`/`onMounted`/`reactive`/`ref`）、`element-plus`（`ElMessage`/`ElMessageBox`/`ElNotification` 直接导入；类型 `FormInstance`/`FormRules`）、`../api/admin`（6 个函数）、`../api/admin` 类型（`OrgNode`/`OrgUserItem`）、`../utils/format`（`formatDateTime`）。
- 模板组件由 `admin/src/plugins/element-plus.ts` 按需注册：card/button/alert/table/table-column/tag/dialog/form/form-item/input/input-number/tree-select/select 无/avatar/empty/pagination/icon 全部在清单内（`:94-133`）——本页**不存在** `ActivityView` 那种组件漏注册问题。
- 图标以字符串引用（`'Refresh'` `:223`/`:227`、`'Plus'` `:226`），依赖 `admin/src/main.ts` 的全局图标注册（`Refresh` `:25`/`:65`、`Plus` `:22`/`:62`），已核对全部在册。
- 被依赖：`admin/src/router/index.ts:63-66`（`/orgs` 懒加载）。
- 数据来源表：`organizations`（结构 `docker/init/001_schema.sql:33-42`）、`users`（人数统计与明细的 `org_id`）。后端服务详见 `.qoder/backend/app/services/admin_service.py.md` 与 `.qoder/backend/app/services/org_service.py.md`（`subtree_org_ids`、`get_full_name_map`）；路由详见 `.qoder/backend/app/api/routes/admin.py.md`。
- 关联页面：`views/AccessView.vue`（「调整所属组织」消费同一棵树，`fetchOrgTree(true)` silent 降级）、`views/InvitesView.vue`（邀请码「组织范围」下拉消费同一棵树，`fetchOrgTree(true)`）；`views/AuditView.vue` **看不到本页的操作**（组织架构增删改不写审计，§9 第 12 项）。小程序侧 `pages/org-select`、`services/org.js` 读取同一张表（`.qoder/REQUIREMENTS.md` §2.3）。

## 7. 业务规则

1. **权限**：进入与全部写操作都需 `orgs` 菜单码；超管恒真（`store/auth.ts:27-29`）。前端隐藏/禁用不是安全边界，后端 6 个接口逐个 `require_menu("orgs")`（§4.1）。
2. **树结构**：`parent_id` 为空即顶级，`level` 顶级为 1、否则父 `level + 1`，由后端计算（`admin_service._resolve_level:765-772`），前端不提交 `level`（`OrgUpsert` 只有三字段，`api/admin.ts:57-61`）。
3. **禁止成环**：父节点不能是自身、也不能是自身的子孙；前端在 `el-tree-select` 里 `disabled` 掉整棵子树（`:84-94`），后端独立校验并抛中文错误（`admin_service.py:715-719`）。
4. **父节点变更级联改层级**：`level` 差值非 0 时对整棵子树（不含根）做单条批量 UPDATE 平移（`admin_service.py:724-728`、`:780-787`）。
5. **删除是级联但非无条件**：整棵子树删除，**仍被用户引用的节点及其全部祖先保留**，保留 id 通过 `message` 回传并原样提示（`admin_service.py:733-762`、`admin.py:731-734`）。删除组织不会删除或改写用户。
6. **同步是全量对齐**：按 id upsert，数据源没有的本地节点删除（有用户引用则保留并计入 `skipped`）；未配置 `ORG_SYNC_API_URL` 时数据源就是内置种子 `ORGANIZATIONS`（`admin_service.py:791-858`、`:861-875`）。**同步会覆盖手工改过的 name/parent_id/sort_order/level**。
7. **人数口径**：`direct_user_count` = `users.org_id == 本节点`；`total_user_count` = 本节点及全部子孙的累计（后序累加，`admin_service.py:635-641`）。人员明细弹窗的 `direct`/`all` 与这两个数字**同口径**（`:651-688`），是 `a740973` 的硬约束。
8. **组织排名不存在**：本页只有人数统计，不做排名、不做按组织积分对比（`e4f21df` 提交说明与 `.qoder/REQUIREMENTS.md` §2.3「PC 端组织人数统计」行）。**不得据此页推断存在组织排名功能**。
9. **排序口径**：树内同级按 `sort_order, id` 升序（`admin_service.py:609`，与小程序侧 `org_service.py:38` 一致）；`:312` 的表单提示「同级内按排序号升序展示」即此规则。人员明细按 `User.id` 升序（`:670`），非注册时间倒序。
10. **组织锁定**：用户所属组织首次确定后锁定，用户侧不可改，仅管理员可调整（在 `AccessView` 完成，非本页）；本页删除组织时若仍有用户归属则该节点被保留而不是把用户踢出组织（`.qoder/REQUIREMENTS.md` §2.3「锁定规则」行）。
11. **时区口径**：库内 `users.created_at` 为 UTC naive，前端 `formatDateTime`（`utils/format.ts:39-42`）经 `parseUtc`（`:29-31`）补 `Z` 后按浏览器本地时区渲染（`:335`），与全后台一致。
12. **无名称唯一性约束**：同级重名组织可创建、可保存（`001_schema.sql:33-39` 无 unique、`admin_service.create_org/update_org` 无重名校验）。
13. **分页口径**：人员明细 `total` 为该口径下的总人数，单页 ≤100（`admin.py:686`），前端固定 20（`:174`）。

## 8. 修改约束

- **菜单码四方一致**：`admin/src/router/menus.ts:10` 的 `code`、`router/index.ts:66` 的 `meta.menu`、后端 `require_menu("orgs")`（`admin.py:670` 等 6 处）、数据库 `admin_menus.code`（`docker/init/010_admin_identity.sql`）必须逐字相同（同 `.qoder/admin/src/views/AccessView.vue.md` §8 第 1 条）。注意菜单码用下划线、路由 path 用连字符是有意区分（本页两者恰好都是 `orgs`）。
- **`OrgNode` 是三个页面的共同契约**：改字段要同时核对 `views/AccessView.vue`（`flattenOrg`）与 `views/InvitesView.vue:38-43`（`flattenOrg`）以及后端 `admin_service.get_org_tree:618-627`、`api/admin.ts:41-50`。
- **不得把树改成前端分页/切片**：`total` 与 `expandKeys` 的展开策略都以「后端返回全树」为前提；反之，**也不得在节点规模增长后继续无条件全量拉取**——根 `agents.md` §2.4 要求长列表分页或虚拟滚动，本页当前对树的唯一优化是 `EXPAND_ALL_LIMIT`（`:17`、`:18-28`）。若引入懒加载需同步改 `expandKeys`（依赖完整 children）与 `collectSubtreeIds`（`:96-107` 依赖完整子树做防环），并让后端提供子树接口。
- **人员明细必须保持服务端分页**（`:199-204` + `admin.py:686` 的 `le=100`），不得改为一次拉全量再前端切片。
- **竞态守卫三处成对保留**：`memberSeq` 自增（`:196`）、赋值前判等（`:205`）、`finally` 内判等（`:209`）。
- **`@click.stop` 必须保留**（`:267`、`:280`）：否则点击人数标签会连带切换树行展开态，破坏 `a740973` 的验收结论。
- **前端防环与后端防环都要保留**：只留前端会因直连接口绕过而成环；只留后端会让用户在下拉里选到非法父节点、保存时才吃 400。
- **`name` 的 `maxlength="80"`（`:298`）对应 `VARCHAR(80)`**（`001_schema.sql:35`），改一处要改另一处；后端 `AdminOrgUpsert.name` 无 `max_length`（`schemas.py:1290`），超长目前只靠前端与 DB 报错拦住。
- **时间展示必须继续走 `utils/format.ts`**，不得再引入页面私有格式化函数（`30b4458` 已删除 `memberTime` 收敛过一次）。
- **破坏性操作保留二次确认与 danger 按钮**（`:153-159`）；同步是覆盖式操作，其确认文案（`:44`）不得弱化为普通提示。
- 视觉与可用性：需覆盖加载 / 空态 / 筛选与窄屏可用性（`admin/agents.md`「开发约定」第 3 条）。操作列已 `fixed="right"`（`:286`），加列注意总宽；本页**无筛选/搜索**（§9 第 3 项）。
- 新增组件时须同步 `admin/src/plugins/element-plus.ts` 的按需注册清单（该清单是手工维护，漏项即运行时不渲染，见 `.qoder/admin/src/plugins/element-plus.ts.md`）。

## 9. 当前实现状态

**已实现**

- 组织树形表格展示（名称 / ID / 层级 / 排序 / 直属人数 / 成员总数 / 操作）、节点新增（顶级与下级）、编辑、级联删除（保留被引用节点）、一键外部同步（含结果通知与数据源信息条）、两种口径的分页人员明细弹窗（含自定义空态、头像首字回退、注册时间本地化）。
- **符合规范的点**：人员明细为**服务端分页**（`:199-204`）；有**请求竞态守卫**（`memberSeq`）；大组织树有**按需展开**限流（`EXPAND_ALL_LIMIT`）；后端聚合与人员明细均**批量查询避免 N+1**；`handleSave` 有 `catch` 且失败保持弹窗打开；时间格式化统一走共享工具、**无私有 formatter**；页面用到的全部组件与图标均已注册。

**存在问题 / 已知事项**

1. **两处 `ElMessageBox.confirm` 无 try/catch，取消即未处理 rejection**：`handleSync`（`:43-47`）、`handleDelete`（`:153-159`）。与 `.qoder/admin/src/views/AccessView.vue.md` §9 第 1 项、`layout/AdminLayout.vue` 的 `handleLogout` 同一模式（本仓库反复出现的写法）；对照 `views/ActivityView.vue:144-152` 是**正确写法**（`try { await confirm } catch { return }`）。仅控制台噪声，用户无感。**未在既有 `.qoder` 文档中针对本文件记录**。
2. **`loadTree` / `syncOrgs` / `deleteOrg` 无 `catch`**（`:30-39`、`:49-62`、`:160`）：失败时树保留上一次数据、`lastSyncSource` 保持旧值、无局部错误提示，用户可能把旧树误读为最新。`onMounted(loadTree)`（`:217`）与「刷新」（`:227`）均未 `.catch()`。
3. **树无搜索 / 无筛选 / 无分页**：只能靠展开逐层找。后端 `get_org_tree` 是全表加载（`admin_service.py:609`）+ 全量嵌套返回，`EXPAND_ALL_LIMIT` 只限制**渲染行数**、不限制传输与内存。当前 13 个种子组织下无风险；组织规模上千后需按根 `agents.md` §2.4 引入懒加载或服务端搜索。**未在既有 `.qoder` 文档中记录**。
4. **手动展开态在每次 `loadTree()` 后被重置**：`:249` 是单向 `:expand-row-keys`，`expandKeys` 只由 `treeData`/`total` 决定。新增/编辑/删除/同步/刷新后用户原先展开的分支会收起（节点数 >200 时更是只剩顶级）。**未记录**。
5. **上级组织下拉只显示本级名称，不显示完整路径**（`parentTreeData` 的 `label: n.name`，`:89`）：同名组织在不同分支下无法区分。`30b4458` 已为 `AccessView` 的 `flattenOrg` 加了 `prefix` 完整路径，本页的树选择器未同等处理。叠加第 12 项（无重名校验）后更易选错父节点。**未记录**。
6. **`ElNotification` 的多行文案不会换行**：`:56-57` 用 `\n` 拼接同步结果，而 `message` 作为字符串渲染时 HTML 会折叠空白，实际会挤成一行（除非全局样式设了 `white-space: pre-line`，未见）。属代码层判断，**未在浏览器实测确认**（本任务禁止运行构建/开发服务器）；验证方式：执行一次同步后观察通知排版。
7. **`parentTreeData` 返回类型为 `any[]`**（`:86`）：绕过了 `OrgNode` 的类型约束，`el-tree-select` 数据结构改动不会被 `vue-tsc` 发现。
8. **同步结果文案与 `kept` 语义不完全对齐**：`kept = len(nodes)` 是数据源节点数（`admin_service.py:856`），不含本地因被引用而额外保留的 `skipped` 节点，故 `:56` 的「现有 N 个节点」在有 skipped 时小于库里实际数量。**未记录**。
9. **`ORG_SYNC_API_URL` 原文回显到界面**：`admin_service.py:875` 返回 `f"external（{url}）"`，经 `:51` 写入 `lastSyncSource`，在 `el-alert`（`:240`）与通知（`:56`）中展示。配置该 URL 时不得内嵌 token/密钥，否则会随界面外泄（本文件不记录任何实际值）。**未记录**。
10. **切换组织时人员弹窗短暂显示上一个组织的行**：`openMemberDialog`（`:182-189`）不清空 `memberItems`，靠 `v-loading` 遮罩掩盖。
11. **主树无自定义空态**：仅人员弹窗有 `el-empty`（`:338-340`）；空树只有 Element Plus 默认文案，与 `admin/agents.md`「开发约定」第 3 条「覆盖空状态」的要求相比偏弱。
12. **组织架构增删改与同步均不写审计日志**：`admin_service.py:691-762`、`:791-858` 无 `audit_service.record`，`views/AuditView.vue` 的 `ACTION_TEXT` 中也没有任何 `org.*` 组织维护动作（只有 `user.org_change` 是「改用户所属组织」，由 `AccessView` 触发）。**后果**：谁删了整棵子树、谁做了覆盖式同步，事后无留痕。与邀请码（`invite.create`/`invite.update`）、活动（`activity.*`）、授权（`access.*`）都留痕的做法不一致。是否需要补审计**待确认**（未见需求条目）。
13. `memberPageSize` 是普通常量（`:174`），分页器无每页条数选择器（`:347`）。
14. **无导出入口**。组织数据导出是否属需求范围**待确认**（若新增须遵守 `admin/agents.md`「开发约定」第 4 条的 CSV 公式注入防护，用 `utils/download.ts:13-17` 的 `csvCell`）。

**待开发**

- 无本页专属待办条目。可选改进（均为上面 §9 项的自然延伸，非既有需求）：组织树搜索/懒加载、上级组织下拉显示完整路径、组织维护写审计。AI 智能中心的 5 个 `ai_*` 菜单码与本页无关（`.qoder/admin/src/router/index.ts.md` §9「待开发」）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/views/OrgsView.vue`，共 **5 个提交**，按时间倒序；增删行数取自 `git show --numstat <hash> -- admin/src/views/OrgsView.vue`。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复（本页涉及 3 项：大组织树按需展开、人员明细请求竞态守卫、统一时间格式化）。
- 修改内容（涉本文件）：+22/-16 行——① 新增 `import { formatDateTime } from '../utils/format'`（`:9`）与 `EXPAND_ALL_LIMIT = 200` + `expandKeys` computed（`:16-28`），表格绑定 `:expand-row-keys`（`:249`）；② `loadMembers` 加 `memberSeq` 竞态守卫（`:191-192`、`:196`、`:205`、`:209`）；③ **删除页面私有 `memberTime`**（原实现自建 `Intl.DateTimeFormat` 并对无时区串补 `Z`），注册时间改调 `formatDateTime(row.created_at)`（`:335`）。本次**未**给 `loadTree`/`handleSync`/`handleDelete` 加 `catch`（§9 第 1、2 项）。
- 关联文件：`admin/src/utils/format.ts`、`admin/src/views/AccessView.vue`、`admin/src/views/AuditView.vue`、`admin/src/router/menus.ts`（新建）等 8 个视图。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-09（`a740973`）
- 需求：组织架构人员明细查看——两列人数可点击查看对应口径的人员明细（分页、含空状态、点击不触发展开、关闭后页面状态保持）。
- 修改内容（涉本文件）：+134/-4 行——新增人员明细弹窗整套状态与逻辑（`:166-215`：`memberScope`/`memberOrgId`/`memberPage`/`memberPageSize`、`memberDialogTitle`、`openMemberDialog`、`loadMembers`、`memberInitial`）、弹窗模板（`:321-355`，含 `#empty` 自定义空态与分页器）、两列人数标签加 `class="count-tag"` + `title` + `@click.stop`（`:262-270`、`:275-283`）与 `.count-tag`/`.member-cell`/`.member-pagination` 样式（`:386-405`）。该提交同时引入了后来被 `30b4458` 删除的私有 `memberTime`。
- 关联文件：`admin/src/api/admin.ts`（`fetchOrgUsers`、`OrgUserItem`、`OrgUserListResult`）、`backend/app/api/routes/admin.py`（`GET /admin/orgs/{id}/users` + `require_menu("orgs")`）、`backend/app/services/admin_service.py`（`get_org_users`）、`backend/app/schemas/schemas.py`（`AdminOrgUserListOut`）。
- 测试结果：见 `docs/迭代记录.md` 的 `a740973` 条目。

### 2026-10-08（`7607d7b`）
- 需求：修复全链路测试发现的 4 处缺陷（本页涉及「组织主键自增」一项的前端配合）。
- 修改内容（涉本文件）：+2/-0 行——`handleSave` 补 `catch {}` 与注释「错误提示由 axios 拦截器统一弹出；保持弹窗打开便于修改后重试」（`:144-145`），使保存失败（如 400 成环/父节点不存在）时弹窗不再被 `finally` 之外的异常路径带崩、且用户可改后重试。
- 关联文件：`docker/init/009_org_serial.sql`（组织主键序列修复）、`backend/app/api/routes/quiz.py`、`backend/app/services/sport_service.py`、WS 时间戳契约相关后端文件。
- 测试结果：见 `docs/迭代记录.md` 的 `7607d7b` 条目。

### 2026-10-02（`e4f21df`）
- 需求：组织树接口与管理端新增直属/含下级人数统计；提交说明明确「组织维度需求重新纳入（**仅人数统计，不含排名**）」。
- 修改内容（涉本文件）：+14/-0 行——在「排序」列后插入「直属人数」（`el-tag`，>0 为 `success`）与「成员总数（含下级）」（>0 为 `warning`）两列，直接读 `row.direct_user_count` / `row.total_user_count`。此版两列**尚不可点击**（`a740973` 才加弹窗）。
- 关联文件：`backend/app/services/admin_service.py`（`get_org_tree` 加人数聚合与后序累加）、`backend/app/schemas/schemas.py`、`admin/src/api/admin.ts`（`OrgNode` 两个计数字段）。
- 测试结果：见 `docs/迭代记录.md` 的 `e4f21df` 条目。

### 2026-09-30（`4a26520`）
- 需求：新增管理后台基础页面及依赖配置（管理后台初版）。
- 修改内容（涉本文件）：+254/-0 行，创建本文件——树形表格（名称 / ID / 层级 / 排序 / 操作）、新增顶级组织与新增下级、编辑弹窗（`el-tree-select` 选父节点 + `collectSubtreeIds` 防环）、级联删除确认、一键同步（`ElNotification` 汇报结果 + `lastSyncSource` 信息条）。初版**无**人数两列、**无**人员明细弹窗、**无** `formatDateTime` 导入。
- 关联文件：`admin/src/router/index.ts`、`admin/src/layout/AdminLayout.vue`、`admin/src/api/admin.ts`、`admin/src/plugins/element-plus.ts`、`admin/package.json`、`backend/app/api/routes/admin.py`（组织维护 6 个接口）、`backend/app/services/admin_service.py`、`backend/app/schemas/schemas.py`（`AdminOrgUpsert`/`AdminOrgSyncOut`）。
- 测试结果：见 `docs/迭代记录.md` 的 `4a26520` 条目。
