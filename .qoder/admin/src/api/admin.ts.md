# admin.ts

## 1. 文件路径

`admin/src/api/admin.ts`（788 行）

## 2. 文件职责

管理后台**唯一的 API 层**：把 `backend/app/api/routes/admin.py` 的全部 **57 个** `/api/admin/*` 端点封装成 53 个可调用导出（51 个函数 + `questionImportApi` / `quoteImportApi` 两个对象）与 74 个类型导出（70 个 `export interface` + 4 个 `export type`，grep 计数），供全部视图/页面/组件引用。文件头注释自述：类型定义与后端 `app/schemas/schemas.py` 的 `Admin*` 模型一一对应（`:1`）。本文件不发请求细节逻辑——HTTP、Bearer Token 注入、错误 toast、401 跳转全部由 `admin/src/api/request.ts` 承担。

## 3. 业务需求

对应 `.qoder/REQUIREMENTS.md` §11「管理后台功能」全部子节（菜单权限 / 人员 / 题库 / 活动配置 / 导入导出等），需求来源明细（identity-binding 设计、V1.1 功能一二、V2.0 三项需求、AI Phase A）已由 `.qoder/backend/app/api/routes/admin.py.md` §3 表格逐条登记，本文件是其前端镜像，不重复罗列。AI 智能中心 15 个新端点（`backend/app/api/routes/ai_admin.py`）**刻意不在本文件封装**——Phase A 边界为「后端就绪、管理端无入口」（`.qoder/backend/app/api/routes/ai_admin.py.md` §3、§6.2）。

## 4. 核心功能

**契约总述**：全部接口字段为 **snake_case**（如 `parent_id`、`target_steps`、`page_size`），与后端 `Admin*` 普通 `BaseModel` 对齐（`.qoder/ARCHITECTURE.md` §4.2 双命名契约；小程序侧 camelCase 与本文件无关）。函数**参数**用 camelCase（`pageSize`、`orgId`、`isEnabled`），在调用边界手工转换为 snake_case 请求体/查询参数（`:296`、`:505`、`:543`、`:547-549`、`:737`、`:769`）。所有函数返回 `Promise<AxiosResponse<T>>`（泛型即后端 `response_model` 的 TS 镜像），调用方自行取 `.data`（见 §5）。

按后端域分组（行号均为本文件实读）：

### 4.1 登录与会话（4 个）

| 导出 | 行号 | 方法 + 后端路径 | 用途 |
|---|---|---|---|
| `login` | `:353-355` | `POST /admin/login` | 账号密码登录，返回 `{token, username}` |
| `createWechatQr` | `:381-383` | `POST /admin/wechat/qr` | 生成微信扫码登录小程序码 |
| `pollWechatQr` | `:385-387` | `GET /admin/wechat/qr/{qr_id}/status` | 轮询扫码状态；**`silent: true`**（轮询失败不弹全局 toast） |
| `fetchMe` | `:453-455` | `GET /admin/me` | 取当前管理员身份/`is_super`/菜单码，用于侧边栏渲染 |

### 4.2 驾驶舱与数据大屏（4 个）

| 导出 | 行号 | 方法 + 后端路径 | 用途 |
|---|---|---|---|
| `fetchDashboard` | `:774-776` | `GET /admin/dashboard` | 驾驶舱指标 + 路线点亮总览 |
| `fetchDashboardTrend` | `:778-780` | `GET /admin/dashboard/trend` | 按 `days` 取趋势 |
| `fetchActivities` | `:782-784` | `GET /admin/activities` | 实时动态流（REST 初始拉取；增量走 WS，`.qoder/ARCHITECTURE.md` §6.4） |
| `fetchScreen` | `:786-788` | `GET /admin/screen` | 数据大屏一次性聚合 |

### 4.3 排名洞察、人员详情与积分台账（4 个）

| 导出 | 行号 | 方法 + 后端路径 | 用途 |
|---|---|---|---|
| `fetchUserOverview` | `:280-282` | `GET /admin/users/{user_id}/overview` | 人员详情五段聚合 |
| `fetchRankings` | `:295-297` | `GET /admin/rankings` | 服务端分页/筛选排名（`page`+`page_size`+`rankParams`） |
| `exportRankings` | `:299-301` | `GET /admin/rankings/export` | **流式 CSV 导出**：`responseType: 'blob'` + `timeout: 0`（不限时），仅传筛选不传分页 |
| `verifyPoints` | `:307-309` | `POST /admin/points/verify` | 积分台账核对/修复，`timeout: 0`；**只传 `{fix}`**，后端可选的 `user_ids` 前端从未使用 |

私有辅助 `rankParams`（`:291-293`）：`keyword` 空串→`undefined`（不发该参数）、`org_id` 用 `??` 保留 0、`only_changed` false→`undefined`。

### 4.4 人员授权 / 角色 / 审计（10 个）

| 导出 | 行号 | 方法 + 后端路径 | 用途 |
|---|---|---|---|
| `fetchAdminUsers` | `:495-497` | `GET /admin/users` | 人员列表（`AdminUserQuery` 原样透传，`status` 可为 `''`） |
| `setUserStatus` | `:499-501` | `PATCH /admin/users/{id}/status` | 启用/停用账号 |
| `setUserOrg` | `:504-506` | `PUT /admin/users/{id}/org` | 管理员调整用户所属组织（注释 `:503`：组织首定后用户侧锁定，写审计 `user.org_change`） |
| `fetchRoles` / `createRole` / `updateRole` / `deleteRole` | `:521-523` / `:530-532` / `:534-536` / `:538-540` | `GET/POST /admin/roles`、`PUT/DELETE /admin/roles/{id}` | 角色 CRUD |
| `grantUserRoles` | `:542-544` | `POST /admin/users/{id}/roles` | 授予角色（`{role_ids}`，全量覆盖语义） |
| `setUserRoleEnabled` | `:546-550` | `PATCH /admin/users/{id}/roles/{roleId}/enabled` | 单角色启停（`{is_enabled}`） |
| `fetchAuditLogs` | `:577-579` | `GET /admin/audit-logs` | 审计日志分页查询 |

### 4.5 入驻邀请码（4 个）

| 导出 | 行号 | 方法 + 后端路径 | 用途 |
|---|---|---|---|
| `fetchInvites` | `:430-432` | `GET /admin/invites` | 分页 + `keyword || undefined` |
| `createInvite` | `:434-436` | `POST /admin/invites` | 新建（注释 `:413`：`org_id`/`max_uses`/`expires_at` 传 null 表示不限） |
| `updateInvite` | `:438-440` | `PATCH /admin/invites/{id}` | 部分更新（`Partial<InviteUpsert> & {is_enabled?}`，后端按 `exclude_unset` 处理） |
| `fetchInviteQr` | `:442-444` | `GET /admin/invites/{id}/qrcode` | 取该邀请码的入驻小程序码 |

### 4.6 路线节点（4 个）

| 导出 | 行号 | 方法 + 后端路径 | 用途 |
|---|---|---|---|
| `fetchRouteNodes` | `:582-584` | `GET /admin/route-nodes` | 列表；带 `silent = false` 参数（`QuotesView.vue:194` 以 `true` 调用做下拉数据源，静默失败） |
| `createRouteNode` / `updateRouteNode` | `:586-588` / `:590-592` | `POST /admin/route-nodes`、`PUT /admin/route-nodes/{id}` | 新建/整条更新（`RouteNodeUpsert = Omit<RouteNode,'id'>`，`:105`） |
| `setRouteNodeEnabled` | `:594-598` | `PATCH /admin/route-nodes/{id}/enabled` | 启停（`{is_enabled}`） |

### 4.7 题库 CRUD、Excel 导入与 AI 出题（7 个导出 + 3 个私有辅助）

| 导出 | 行号 | 方法 + 后端路径 | 用途 |
|---|---|---|---|
| `fetchQuestions` | `:623-625` | `GET /admin/questions` | `QuestionQuery` 原样透传（`keyword`/`qtype`/`category` 可为空串） |
| `createQuestion` / `updateQuestion` / `deleteQuestion` | `:627-629` / `:631-633` / `:635-637` | `POST/PUT/DELETE /admin/questions(/{id})` | 题目 CRUD（删除为后端软停用） |
| `questionImportApi` | `:653-657` | 见下 | 题库导入三件套对象 |
| `generateAiQuestions` | `:697-703` | `POST /admin/ai/generate-questions` | AI 出题：`timeout: 0`（分钟级）+ `signal?: AbortSignal`（用户可取消）+ `silent: true`（错误在弹窗内联展示，注释 `:695-696`） |
| `batchSaveAiQuestions` | `:705-711` | `POST /admin/ai/questions/batch-save` | 草稿批量入库，`silent: true` |

私有导入辅助（**两套导入共用**，`d6acf7e` 由题库专用函数泛化而来）：`downloadImportTemplate(url)`（`:639-641`，`responseType: 'blob'`）、`previewImport(url, file)`（`:643-647`，**构造 `FormData`，字段名固定 `file`**，与后端 `UploadFile = File(...)` 对齐）、`confirmImport(url, token)`（`:649-651`，传 `{preview_token}`）。`questionImportApi`（`:653-657`）与 `quoteImportApi`（`:740-744`）以同一形状注入通用组件 `admin/src/components/ExcelImportDialog.vue` 的 `api: ExcelImportApi` prop（该组件 `:10-14` 声明 3 个函数、返回 `AxiosResponse`）。

### 4.8 每日寄语（7 个）

| 导出 | 行号 | 方法 + 后端路径 | 用途 |
|---|---|---|---|
| `fetchQuotes` | `:714-718` | `GET /admin/quotes` | 分页 + `keyword || undefined`（服务端搜索） |
| `createQuote` / `updateQuote` / `deleteQuote` | `:720-722` / `:724-726` / `:728-730` | `POST/PUT/DELETE /admin/quotes(/{id})` | 寄语 CRUD（删除为后端硬删除） |
| `fetchQuoteCycle` / `updateQuoteCycle` | `:732-734` / `:736-738` | `GET/PUT /admin/quotes/cycle` | 按天循环起始日（`{start_date}`；`QuoteCycle.today_position` 语义见注释 `:131`） |
| `quoteImportApi` | `:740-744` | import-template / import-preview / import-confirm | 寄语导入三件套（复用 §4.7 私有辅助） |

### 4.9 组织架构（6 个）

| 导出 | 行号 | 方法 + 后端路径 | 用途 |
|---|---|---|---|
| `fetchOrgTree` | `:747-749` | `GET /admin/orgs` | 组织树（含 `direct_user_count`/`total_user_count`）；带 `silent` 参数（`AccessView.vue:258`、`InvitesView.vue:188` 以 `true` 调用） |
| `createOrg` / `updateOrg` / `deleteOrg` | `:751-753` / `:755-757` / `:759-761` | `POST/PUT/DELETE /admin/orgs(/{id})` | 组织 CRUD |
| `syncOrgs` | `:763-765` | `POST /admin/orgs/sync` | 从外部接口同步组织 |
| `fetchOrgUsers` | `:767-771` | `GET /admin/orgs/{orgId}/users` | 人员明细，`scope: 'direct' | 'all'` + 分页 |

### 4.10 活动设置（3 个）

| 导出 | 行号 | 方法 + 后端路径 | 用途 |
|---|---|---|---|
| `fetchActivity` | `:340-342` | `GET /admin/activity` | 读活动设置（`start_at`/`end_at` 为带 `+08:00` 的 ISO，注释 `:314`） |
| `saveActivity` | `:344-346` | `PUT /admin/activity` | 保存（`ActivityForm`，时间传北京时间 `YYYY-MM-DDTHH:mm`，注释 `:314`） |
| `publishActivity` | `:348-350` | `POST /admin/activity/publish` | 发布/撤回（`{published}`） |

## 5. 输入与输出

- **返回值统一为 `Promise<AxiosResponse<T>>`**：`request.ts:28` 的成功拦截器原样返回 `response`（**不拆包**），各视图自行取 `.data`（如 `DashboardView.vue:43`、`RankingsView.vue:75`）。泛型 `T` 即 §4 各表对应接口的 TS 类型，与后端 `Admin*` schema 字段一一对应。
- **错误**：拦截器统一 `ElMessage.error(detail || ...)` 后 `Promise.reject`（`request.ts:46-49`），本文件自身**零 try/catch、不吞错误**；`silent: true`（`pollWechatQr` `:386`、`generateAiQuestions` `:701`、`batchSaveAiQuestions` `:709`）与 `silent` 参数（`fetchRouteNodes` `:582`、`fetchOrgTree` `:747`）只抑制全局 toast，Promise 照常 reject，由调用方处理。
- **超时**：默认 15s（`request.ts:16`）；`timeout: 0`（不限时）仅 3 处——`exportRankings` `:300`、`verifyPoints` `:308`、`generateAiQuestions` `:699`。
- **blob 响应** 2 处：`exportRankings`（`:300`）与 `downloadImportTemplate`（`:640`），落盘由调用方经 `admin/src/utils/download.ts` 的 `saveFile` 完成（`RankingsView.vue:75-76`）。
- 错误码语义（400/401/403/404/422/429/502）由后端决定，见 `.qoder/backend/app/api/routes/admin.py.md` §5.4；401 触发 `request.ts:35-45` 的清会话 + 跳 `/login`。

## 6. 依赖关系

- **依赖**：仅 `./request`（`:2`）。`request.ts` 再依赖 axios、`element-plus`（ElMessage）、`../store/auth`（getToken/clearAuth，localStorage 键见 `.qoder/ARCHITECTURE.md` §5.5）、`../router`（401 跳转）。baseURL `/api`（`request.ts:15`），开发环境经 `admin/vite.config.ts:11-12` 的 `/api` proxy 转发后端。
- **后端对应**：`backend/app/api/routes/admin.py` 57 个端点**全部**被本文件覆盖、一一对应，无遗漏（`.qoder/backend/app/api/routes/admin.py.md` §6.3 实测结论）；其中 `POST /admin/ai/generate-questions` 与 `POST /admin/ai/questions/batch-save` 属旧内存态 AI 链路（定义在 admin.py 而非 ai_admin.py，`require_menu("questions")`，见 `.qoder/backend/app/api/routes/ai_admin.py.md` §6.4）。`ai_admin.py` 的 15 个端点在本文件**零封装**（Phase A 预期）。
- **被依赖**（grep 全部 53 个导出实测，每个至少 1 处调用）：`src/views/` 11 个视图（LoginView、DashboardView、ScreenView、AccessView、AuditView、InvitesView、OrgsView、QuestionsView、QuotesView、RouteNodesView、ActivityView）、`src/pages/RankingsView.vue`、`src/components/AiGenerateDialog.vue`（AI 两函数）、`src/components/ExcelImportDialog.vue`（经两个 importApi 对象间接消费类型）。

## 7. 业务规则

1. **snake_case 双侧硬契约**：本文件所有接口字段与后端 `Admin*` schema 逐字段对应（`:1` 注释），与小程序 camelCase 契约互不相干（`.qoder/ARCHITECTURE.md` §4.2）；改任一侧字段名即破坏性变更。
2. **本层零鉴权逻辑**：Bearer Token 注入、401 处理在 `request.ts:19-25`、`:35-45`；菜单权限由后端 `require_menu` 闸门 + 前端路由守卫（`.qoder/ARCHITECTURE.md` §5.3、§5.6）承担，本文件不做权限判断。`login`/`createWechatQr`/`pollWechatQr` 对应后端 3 个免鉴权限流端点。
3. **扫码令牌单次签发**：后端只在首次 `confirmed` 轮询返回 `token`（`.qoder/backend/app/api/routes/admin.py.md` §4.7），故 `pollWechatQr` 的调用方（LoginView）必须在第一次拿到 `confirmed + token` 时立即落盘；`silent` 保证轮询期间不弹错误。
4. **导入令牌一次性**：`previewImport` 返回 `preview_token`（TTL 30 分钟），`confirmImport` 消费后不可重用，重复确认由后端 400（`.qoder/ARCHITECTURE.md` §8.2）。
5. **积分口径与小程序同源**：`OverviewPoints` 注释 `:262`——`total = walk + quiz`，`rank` 为总积分榜名次；`RankItem` 含 `total_points`/`walk_points`/`quiz_points`（`:286`）。
6. **podium 不受筛选影响**：`RankResult.podium` 为全员前 10（注释 `:287`），筛选只作用于 `items`。
7. **导出与列表同口径**：`exportRankings` 与 `fetchRankings` 共用 `rankParams`（`:291-293`），保证「所见即所导」。

## 8. 修改约束

1. 57 个端点的路径/方法/字段是双侧硬契约：改动必须同步 `backend/app/api/routes/admin.py`（routes/services/schemas 三处，`backend/AGENTS.md` §6.2）与本文件及调用视图（`.qoder/README.md` §3 规则 6）。
2. **不得把字段改成 camelCase**，也不得给管理端接口引入小程序侧结构（`.qoder/ARCHITECTURE.md` 不变量，§4.2）。
3. `questionImportApi`/`quoteImportApi` 的对象形状必须与 `ExcelImportDialog.vue:10-14` 的 `ExcelImportApi` 接口（3 个函数、返回 `AxiosResponse`）保持一致，否则通用导入弹窗编译失败。
4. `timeout: 0` 的 3 处（导出/积分核对/AI 生成）与 `generateAiQuestions` 的 `signal` 透传不得移除——对应操作耗时可达分钟级，`AiGenerateDialog.vue` 依赖 `AbortController` 取消。
5. 新增导入场景必须复用 `:639-651` 三个私有辅助（FormData 字段名 `file`、blob 下载、`preview_token` 确认），不得另写一份（根 `agents.md` §2.2）。
6. 若想把「调用方取 `.data`」改为拦截器拆包，须一次性改全部 13 个调用文件（§6），属破坏性重构。
7. 修改后按 `admin/agents.md`「必做验证」执行 `npm run build` + 浏览器真实交互验收；本文件不含 CSV 拼接逻辑，导出防公式注入在后端（`admin_service._csv_text`）与 `utils/download.ts:13-17`，勿在本层重复实现。

## 9. 当前实现状态

- **已实现**：53 个导出全部有调用方（逐名 grep `admin/src`，**无死导出**）；覆盖后端 admin.py 全部 57 个端点。历史上的两个死/废导出已清理：`MENU_CATALOG`（`54a0de7` 加入，`30b4458` 移除，菜单单一来源改 `router/menus.ts`）、`fetchOnboardingQr`（`225f99c` 加入，`afbcba9` 随全局入驻码下线移除）。
- **发现的文档/代码不一致（本文件无权修改，仅登记）**：
  1. ~~`.qoder/ARCHITECTURE.md` §4.1 与 `.qoder/backend/app/api/routes/ai_admin.py.md` §5.1 均称「`request.ts:27-51` 成功拦截器直接返回 `response.data`」~~ —— **已于 2026-10-17 核实并更正**：`request.ts:28` 原样返回 `AxiosResponse`，由调用方取 `.data`（§5）；两处文档均已改写并各留更正说明。
  2. ~~`.qoder/ARCHITECTURE.md` §8.2 称 `ExcelImportDialog` 的 api prop「接收四个接口函数」~~ —— **已于 2026-10-17 核实并更正**：`ExcelImportApi`（`ExcelImportDialog.vue:10-14`）实为 **3 个**函数（`downloadTemplate`/`preview`/`confirm`），§8.2 已改写并留更正说明。
  3. 目录约定不一致：`RankingsView.vue` 位于 `src/pages/`，其余 11 个视图在 `src/views/`（ls 实测），属历史遗留摆放——**已登记**于 `.qoder/ARCHITECTURE.md` §8 表格第 9 项（状态「待确认是否统一」），本条不重复登记。
  4. `:112` 注释「需求 §16」沿用早期需求文档章节号，与现行 REQUIREMENTS.md 编号不对应（同 `backend/app/api/routes/admin.py:541`，已在 `.qoder/backend/app/api/routes/admin.py.md` §3 注记：现行「每日寄语/金句」内容归 `.qoder/REQUIREMENTS.md` §11.5，该节以「金句管理」为名）。
- **已知事实（非缺陷）**：`verifyPoints` 未暴露后端可选参数 `user_ids`（全员核对是唯一前端场景）；`fetchQuestions` 的 `keyword/qtype/category` 前后端均无长度上限（后端侧见 `.qoder/backend/app/api/routes/admin.py.md` §9.3 第 3 条）。
- **待确认**：无（本文件所有结论均有代码/grep/git 证据）。

## 10. 迭代记录

数据来源：`git log --follow --format='%h | %ad | %s' --date=format:'%Y-%m-%d %H:%M' -- admin/src/api/admin.ts`，共 **16 个提交**，全部在 `docs/迭代记录.md` 有对应条目。按时间倒序；同日多提交合并于一个日期标题下。

### 2026-10-16（`ea58b6c`，23:19）
- 需求：题库接入 CloudBase Agent AI 出题（草稿审核后入库）。
- 修改内容（涉本文件）：新增 `AiGeneratePayload`/`AiQuestionDraft`/`AiGenerateResult`/`AiSaveFailure`/`AiBatchSaveResult` 5 个类型与 `generateAiQuestions`（timeout 0 + AbortSignal + silent）、`batchSaveAiQuestions`（`:659-711`）。
- 关联文件：`backend/app/api/routes/admin.py:500-538`、`admin/src/components/AiGenerateDialog.vue`。
- 测试结果：见 `docs/迭代记录.md` 的 `ea58b6c` 条目。

### 2026-10-13（`e197a28`，12:28）
- 需求：V2.0——活动设置页、排名洞察积分化、人员组织调整。
- 修改内容（涉本文件）：`RankItem`/`RankResult` 增 `total_points`/`walk_points`/`quiz_points`；新增 `verifyPoints` + `PointsDiff`/`PointsVerifyResult`；新增活动设置组 `ActivityStatus`/`ActivityForm`/`ActivitySetting` + `fetchActivity`/`saveActivity`/`publishActivity`；新增 `setUserOrg`。
- 关联文件：`admin/src/views/ActivityView.vue`、`src/pages/RankingsView.vue`、后端 `activity_service`/`points_service`/`org_service`。
- 测试结果：见 `docs/迭代记录.md` 的 `e197a28` 条目。

### 2026-10-12（`afbcba9`，14:49）
- 需求：邀请码准入全链路（小程序仅对受邀人员开放）。
- 修改内容（涉本文件）：删除 `fetchOnboardingQr`/`OnboardingQrResult`（全局入驻码下线）；新增邀请码组 `InviteStatus`/`InviteItem`/`InviteListResult`/`InviteUpsert`/`InviteQrResult` + `fetchInvites`/`createInvite`/`updateInvite`/`fetchInviteQr`，及 `setUserStatus` + `UserStatus`。
- 关联文件：`admin/src/views/InvitesView.vue`、`AccessView.vue`、后端 `invite_service`、迁移 `015`。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目。

### 2026-10-11（`d6acf7e` 20:14、`30b4458` 18:30、`b5d6035` 17:55、`225f99c` 00:45）
- 需求：寄语按天循环 + Excel 导入（V1.1 功能二）；管理后台代码审查修复；排名服务端分页与流式导出；顶栏入驻二维码。
- 修改内容（涉本文件）：`d6acf7e`——题库导入三函数泛化为私有 `downloadImportTemplate`/`previewImport`/`confirmImport`，产出 `questionImportApi`/`quoteImportApi` 两个对象；新增 `QuoteCycle`/`QuoteUpsert` 重构 + `fetchQuoteCycle`/`updateQuoteCycle`。`30b4458`——移除 `MENU_CATALOG`（菜单单一来源改 `router/menus.ts`）；`fetchRouteNodes`/`fetchOrgTree` 增 `silent` 参数；`fetchQuotes` 增 `keyword`。`b5d6035`——新增 `RankNode`/`RankItem`/`RankResult`/`RankFilter` + `rankParams`/`fetchRankings`/`exportRankings`（blob + timeout 0）。`225f99c`——新增 `fetchOnboardingQr`（次日链路被 `afbcba9` 替换，函数于 `afbcba9` 删除）。
- 关联文件：`admin/src/components/ExcelImportDialog.vue`、`src/pages/RankingsView.vue`、`src/utils/download.ts`、后端 `quote_service`/`import_service`/`admin_service`。
- 测试结果：见 `docs/迭代记录.md` 的 `d6acf7e`、`30b4458`、`b5d6035`、`225f99c` 条目。

### 2026-10-10（`54ea125`，23:31）
- 需求：V1.1 功能一——题库 Excel 模板下载与批量导入，题库列表服务端分页。
- 修改内容（涉本文件）：`fetchQuestions` 由无参改为 `QuestionQuery`；新增 `ImportErrorRow`/`ImportPreviewResult` 与题库导入三函数（后于 `d6acf7e` 泛化）。
- 关联文件：`admin/src/components/ExcelImportDialog.vue`、后端 `import_service`、迁移 `011`。
- 测试结果：见 `docs/迭代记录.md` 的 `54ea125` 条目。

### 2026-10-09（`54a0de7` 12:10、`a740973` 09:35）
- 需求：P3 管理端扫码登录与人员授权/审计页；组织人员明细查看。
- 修改内容（涉本文件）：`54a0de7`——新增扫码登录组（`QrCreateResult`/`MenuItem`/`QrStatusResult` + `createWechatQr`/`pollWechatQr`）、`MeResult` + `fetchMe`、`MENU_CATALOG`（后移除）、人员授权/角色/审计全套类型与 9 个函数（`fetchAdminUsers`…`fetchAuditLogs`）。`a740973`——新增 `OrgUserItem`/`OrgUserListResult` + `fetchOrgUsers`（scope direct/all + 分页）。
- 关联文件：`admin/src/views/LoginView.vue`、`AccessView.vue`、`AuditView.vue`、`OrgsView.vue`、后端 `access_service`/`identity_service`。
- 测试结果：见 `docs/迭代记录.md` 的 `54a0de7`、`a740973` 条目。

### 2026-10-03（`71d1b9b`，23:39）
- 需求：P2-1 每日寄语与节点纪念票——后台维护有出处语录。
- 修改内容（涉本文件）：新增 `Quote`/`QuoteListResult`/`QuoteUpsert` + `fetchQuotes`/`createQuote`/`updateQuote`/`deleteQuote`（寄语 CRUD 最初形态）。
- 关联文件：`admin/src/views/QuotesView.vue`、后端 `quote_service`。
- 测试结果：见 `docs/迭代记录.md` 的 `71d1b9b` 条目。

### 2026-10-02（`e4f21df` 13:01、`01ec93c` 11:51）
- 需求：组织树人数统计；驾驶舱与数据大屏页面。
- 修改内容（涉本文件）：`e4f21df`——`OrgNode` 增 `direct_user_count`/`total_user_count` 两字段（git show 实测仅此改动）。`01ec93c`——新增驾驶舱/大屏 8 个类型 + `fetchDashboard`/`fetchDashboardTrend`/`fetchActivities`/`fetchScreen`。
- 关联文件：`admin/src/views/OrgsView.vue`、`DashboardView.vue`、`ScreenView.vue`、后端 `dashboard_service`。
- 测试结果：见 `docs/迭代记录.md` 的 `e4f21df`、`01ec93c` 条目。

### 2026-10-01（`f820e0e` 15:54、`81b86e5` 10:30）
- 需求：排名洞察展示改名记录（三端）；管理后台排名洞察与路线节点维护页。
- 修改内容（涉本文件）：`f820e0e`——新增 `Overview*` 10 个类型 + `fetchUserOverview`（含 `original_nickname`/`nickname_changed_at` 改名字段）。`81b86e5`——新增 `RouteNode`/`RouteNodeUpsert`/`RouteNodeListResult` + 路线节点 4 函数。
- 关联文件：`admin/src/pages/RankingsView.vue`、`src/views/RouteNodesView.vue`、后端 `admin_service`。
- 测试结果：见 `docs/迭代记录.md` 的 `f820e0e`、`81b86e5` 条目。

### 2026-09-30（`4a26520`，22:50）
- 需求：管理后台基础页面初建。
- 修改内容（涉本文件）：**创建本文件**——`login` + 题库 CRUD 4 函数 + 组织 CRUD/同步 5 函数及 `LoginResult`/`Question*`/`Org*`/`MessageResult` 等基础类型。
- 关联文件：`admin/src/api/request.ts`、`src/views/LoginView.vue`、`QuestionsView.vue`、`OrgsView.vue`、后端 `admin.py` 初版（`337af78`）。
- 测试结果：见 `docs/迭代记录.md` 的 `4a26520` 条目。
