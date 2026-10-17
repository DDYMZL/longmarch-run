# InvitesView.vue

## 1. 文件路径

`admin/src/views/InvitesView.vue`（351 行）

## 2. 文件职责

「入驻邀请码」页（`<script setup>` 单文件组件）：管理 `invite_codes` 表——**生成**邀请码（可限定组织范围、使用次数上限、有效期）、**编辑**、行内**启用/停用**开关、以及为每个码调微信接口生成并**下载入驻小程序码**；列表按名称模糊搜索、服务端分页，并把后端派生的 `active/disabled/expired/exhausted` 状态映射为中文标签与配色。本页是「只有持有效邀请码入驻过的用户才能登录使用」这一准入模型（`.qoder/REQUIREMENTS.md` §2.2「准入模型」行）在管理端的唯一发码入口，取代了 `afbcba9` 之前 `AdminLayout` 顶栏那个不分码的通用「入驻二维码」按钮。

## 3. 业务需求

- 需求出处：`.qoder/REQUIREMENTS.md` §2.2「入驻与邀请码」（准入模型 / 邀请码格式 / scene 格式 / 核销方式 / 一次性语义 / 组织越界 / 敏感信息约束各行）、§11.2「人员管理」的「邀请码生成与维护」行、§11.5「其它管理页」的 `InvitesView` 行；菜单与权限模型见 §11.1。
- 数据库：`docker/init/015_invite_admission.sql` 建 `invite_codes` 表、`:12` 增 `invite_codes.org_id`、`:26` 增 `users.invite_code_id`、`:31-33` 把 `invites` 菜单码插入 `admin_menus`；**该迁移不含任何邀请码种子数据**——码值全部在运行时由 `backend/app/services/invite_service.py:33-34` 生成。详见 `.qoder/docker/init/015_invite_admission.sql.md`。
- 演进（数据来源 `git log --follow --oneline -- admin/src/views/InvitesView.vue`）：**只有 1 个提交** `afbcba9`（2026-10-12，「邀请码准入全链路」），+351/-0 创建本文件，此后未再改动。同提交对 `admin/src/layout/AdminLayout.vue` 是 **+2/-45**（下线旧的顶栏「入驻二维码」按钮与弹窗），对 `admin/src/api/admin.ts` +59/-3、`admin/src/router/index.ts` +6、`admin/src/router/menus.ts` +1、`admin/src/views/AccessView.vue` +63/-3。
- **`Iphone` 死图标的来源已确证**（`.qoder/PROJECT.md` §8「代码级技术债」第 37 项原标「失效时点待确认」）：`Iphone` 由 `225f99c`（2026-10-11，「顶栏新增员工入驻二维码查看与下载」）随 `AdminLayout.vue` 的 `<el-icon><Iphone /></el-icon>入驻二维码` 按钮引入；`afbcba9`（2026-10-12）删除该按钮与整个入驻码弹窗（`AdminLayout.vue` -45 行），`Iphone` 自此零引用而 `admin/src/main.ts` 的注册未同步清理。**失去引用的文件是 `layout/AdminLayout.vue`，不是本文件**——本页从创建起就没有引用过 `Iphone`（`git log -S "Iphone" -- admin/src` 只命中 `225f99c` 与 `afbcba9`，且 `afbcba9` 对本文件是纯新增 351 行）。`Timer` 则由 `e197a28`（2026-10-13）作为 `+` 行加入 `main.ts`，同批创建的 `views/ActivityView.vue` 用的是 `Flag`/`CircleCheck`/`Lock`/`Trophy`，故 `Timer` **自加入起即为死注册**。

## 4. 核心功能

### 4.1 路由、菜单码与前后端权限守卫

- 路由：path `/invites`、name `invites`、`meta: { title: '入驻邀请码', menu: 'invites' }`（`admin/src/router/index.ts:75-78`）；侧边栏条目「入驻邀请码」+ `Promotion` 图标（`admin/src/router/menus.ts:12`，图标已在 `admin/src/main.ts:24`/`:64` 注册）。
- 前端守卫：`store/auth.ts:27-29` 的 `hasMenu('invites')`（超管恒真）→ 无权回退 `firstAllowedPath()`（`router/index.ts:9-12`）；侧边栏过滤 `layout/AdminLayout.vue:15`。
- 后端守卫：本页调用的 4 个邀请码接口全部 `Depends(require_menu("invites"))`——`admin.py:834`（列表）、`:848`（生成）、`:868`（编辑/启停）、`:889`（小程序码）。
- **跨权限依赖**：`onMounted` 还调 `fetchOrgTree(true)`（`:188`）→ `GET /api/admin/orgs`，后端要求 `require_menu("orgs")`（`admin.py:670`）。`silent=true` 使无 `orgs` 权限的管理员拿到 403 时**不弹全局错误提示**（`api/request.ts:7-12`、`:33`），`catch` 分支把 `orgOptions` 置空（`:190-192`），组织范围下拉随即只剩空列表。这与 `.qoder/admin/src/views/AccessView.vue.md` §4.2 描述的降级方式完全一致；差别在于**本页没有为「组织下拉为空」提供任何提示或 tooltip**，管理员只会看到空下拉，无法区分「无 orgs 权限」「组织表为空」「请求失败」（§9 第 8 项）。

### 4.2 状态清单

| 状态 | 行 | 含义 |
|---|---|---|
| `STATUS_LABEL` | `:16-21` | 4 个状态码 → 中文（可用 / 已停用 / 已过期 / 已用满） |
| `STATUS_TYPE` | `:22-27` | 4 个状态码 → 标签色（success / info / warning / danger） |
| `ENV_LABELS` | `:28` | 小程序版本 `release/trial/develop` → 正式版 / 体验版 / 开发版 |
| `loading` | `:30` | 表格 `v-loading`（`:214`） |
| `items` / `total` | `:31-32` | 当前页数据与总条数 |
| `page` / `pageSize` | `:33-34` | 页码（1）与**固定 10**（`ref`，但无每页条数选择器） |
| `keyword` | `:35` | 名称搜索关键字 |
| `orgOptions` | `:36` | 压平后的 `{id, name}` 组织下拉项 |
| `requestSeq` | `:45` | 模块级自增序号，请求竞态守卫 |
| `dialogVisible`/`saving`/`editingId` | `:70-72` | 新建/编辑弹窗；`editingId === null` 即新建 |
| `form` | `:73-80` | `{ name, remark, org_id, max_uses, expires_at(Date\|null), is_enabled }` |
| `togglingId` | `:139` | 行内启停互斥锁（一次只允许一行在途） |
| `qrVisible`/`qrLoading`/`qr`/`qrInvite` | `:154-157` | 小程序码弹窗 |
| `dialogTitle` | `:181-183` | computed，「生成入驻邀请码」/「编辑邀请码 #id」 |

### 4.3 列表加载：服务端分页 + 竞态守卫

- `loadList`（`:46-57`）：`const seq = ++requestSeq` → `fetchInvites(page, pageSize, keyword.trim())` → `if (seq !== requestSeq) return`（`:51`）→ 写 `items`/`total`；`finally` 内同样只在 `seq === requestSeq` 时关 loading（`:55`）。**只采纳最后一次请求**，与 `AccessView.vue` 的 `requestSeq`、`OrgsView.vue` 的 `memberSeq` 同一模式。**无 `catch`**（§9 第 2 项）。
- 分页与筛选全在**服务端**：`invite_service.list_invites`（`backend/app/services/invite_service.py:149-164`）先按 `name.icontains(keyword, autoescape=True)` 过滤（`:153-154`，转义 LIKE 通配符）→ `count()` → `order_by(InviteCode.id.desc()).offset().limit()`（`:156-161`）→ 一次 `IN` 查询批量补组织名（`:162`、`_org_names:111-116`），无 N+1。满足根 `agents.md` §2.4。
- 触发：输入框回车与清空（`:204-205`）、「查询」按钮（`:207`）→ `handleSearch`（`:59-62`，先把 `page` 复位 1）；分页器 `@current-change` → `handlePageChange`（`:64-67`）；「刷新」（`:211`）直接调 `loadList`。**无防抖**（与 `AccessView` 同，靠显式触发 + 竞态守卫兜底）。
- 表格（`:214-267`）：`v-loading` + `border stripe row-key="id"`；分页器 `layout="total, prev, pager, next"`（`:269-276`）。

### 4.4 组织范围下拉（复用组织树）

- `flattenOrg(nodes, prefix = '')`（`:38-43`）：递归压平为「总部 / 一部 / 一班」式完整路径项，用 `flatMap` 前序拼接。
- `onMounted`（`:185-193`）：先 `loadList()`（未 await），再 `await fetchOrgTree(true)` 填充 `orgOptions`，失败置空。
- **与 `views/AccessView.vue:41-46` 的 `flattenOrg` 是重复实现**（同名、同 ` / ` 分隔符、同前序拼接语义，均由 `30b4458`/`afbcba9` 时期引入），未抽到 `utils/`，属根 `agents.md` §2.2「拒绝冗余代码」的现存违例（§9 第 9 项）。
- 下拉 `:287-295`：`el-select` + `clearable` + `filterable`，占位「不限（可任选组织入驻）」，`org_id === null` 即不限组织。
- **只在挂载时拉一次**：在 `OrgsView` 里增删改或同步组织后回到本页，下拉是旧数据，需整页刷新（§9 第 10 项）。

### 4.5 表格列（`:214-267`）

| 列 | 行 | 说明 |
|---|---|---|
| 名称 | `:215` | `prop="name"`，`show-overflow-tooltip` |
| 邀请码 | `:216-220` | `span.code-mono`（`:344` 等宽 + 字距），**明文展示码值** |
| 组织范围 | `:221-226` | 有 `org_name` 显示名称；否则 `el-tag type="info" effect="plain"`「不限」 |
| 使用次数 | `:227-231` | `used_count / max_uses`，`max_uses == null` 显示「∞」（`:229`） |
| 有效期 | `:232-237` | 有值走 `formatDateTime(row.expires_at)`；否则 `el-tag`「长期有效」 |
| 状态 | `:238-244` | `STATUS_TYPE[row.status]` + `STATUS_LABEL[row.status]`（带 `as InviteStatus` 断言） |
| 启停 | `:245-254` | `el-switch`，见 §4.7 |
| 创建 | `:255-260` | 两行：`created_by`（空显示 `—`）+ `.muted` 的 `formatDateTime(created_at)` |
| 操作 | `:261-266` | `width="180"` `fixed="right"`：小程序码 / 编辑。**无删除** |

### 4.6 新建 / 编辑弹窗与校验（`:278-318`）

- 打开：`openCreate()`（`:91-95`）先 `resetForm()`（`:82-89`，六字段复位、`is_enabled` 默认 `true`）；`openEdit(row)`（`:97-107`）回填，其中 `expires_at` 用 `new Date(row.expires_at)` 把 UTC ISO 转成 `Date`（`:103-104` 注释「Date 会自动转本地时区显示」）。
- **`el-form` 没有 `:model` / `:rules` / `ref`**（`:279`）：`<el-form-item label="名称" required>` 的 `required` 只画星号，校验是 `saveInvite`（`:109-137`）里的命令式判断——只检查名称非空，空则 `ElMessage.warning('请输入邀请码名称')` 并 return（`:110-114`）。其余约束全部落到后端（§9 第 5 项）。
- 字段控件：名称 `el-input maxlength="64"`（`:281`，与 `schemas.py:914`/`:923` 的 `max_length=64` 对齐）；备注 `type="textarea" :rows="2" maxlength="200"`，占位「选填，仅管理员可见」（`:284`，对齐 `schemas.py:915`/`:924`）；组织范围见 §4.4；使用次数上限 `el-input-number :min="1" :precision="0" controls-position="right"`，旁注「留空表示不限次数；编辑时不得低于已使用次数」（`:298-299`）；有效期 `el-date-picker type="datetime"`，旁注「按本地时区设置，提交转为 UTC 存储」（`:302-308`）；「启用」开关**仅编辑态渲染**（`v-if="editingId !== null"`，`:310-312`）。
- 提交 payload（`:117-124`）：`name` trim；`remark` trim 后空则 `null`；`org_id`/`max_uses` 原值（`null` = 不限）；`expires_at` 走 `Date.toISOString()`——**带 `Z` 的 UTC ISO**，`:122` 注释说明是为了让后端 `_InviteExpiry` 校验并统一存 UTC naive。新建走 `createInvite(payload)`（不含 `is_enabled`，后端默认启用）；编辑走 `updateInvite(id, { ...payload, is_enabled })`（`:125-131`）。
- 成功后 `ElMessage.success` → 关弹窗 → `await loadList()`；`try…finally` **无 `catch`**，故后端 400（如「使用次数上限不能低于已使用次数」）时弹窗**保持打开**、用户可改后重试——行为正确，但会产生未处理 rejection。
- 因为 payload 五个字段总是显式出现，`AdminInviteUpdate` 的 `exclude_unset`（`admin.py:870`）不会误丢弃它们，**可以把 `remark`/`org_id`/`max_uses`/`expires_at` 显式清空为 `null`**（`schemas.py:921` 文档串即此语义）。

### 4.7 行内启停开关

- `toggleEnabled(row, enabled)`（`:140-151`）：`:141` 全局互斥（有任意一行在途直接 return）；`togglingId = row.id` → `updateInvite(row.id, { is_enabled: next })`（**只发这一个字段**）→ `Object.assign(row, data)` 用后端返回的完整对象就地更新该行（含重新派生的 `status`）→ 提示「已启用」/「已停用」；`finally` 复位。
- 开关绑定是**单向** `:model-value="row.is_enabled"` + `:loading="togglingId === row.id"` + `:disabled="togglingId !== null && togglingId !== row.id"`（`:248-250`）：请求失败时 `row` 未被改写，开关自动弹回原态，无需手动回滚——这是本页写得较稳的一处。
- 后端 `update_invite`（`invite_service.py:197-216`）对部分字段用 `fields.get(k, invite.<k>)` 兜住未传字段，故只发 `is_enabled` 不会清掉 `org_id`/`max_uses`/`expires_at`；同时写审计 `invite.update`，明细只含 `{invite_id, name, fields: sorted(fields)}`（`:210-213`）——**不含码值**。
- `admin.py:871-872` 另有一道拦截：若显式把 `name` 或 `is_enabled` 传成 `null` 直接 400「名称与启用状态不能为空」。

### 4.8 小程序码弹窗与下载（`:320-335`）

- `openQr(row)`（`:159-170`）：记 `qrInvite`、清空 `qr`、开弹窗、`qrLoading = true` → `fetchInviteQr(row.id)` → 写 `qr`；`try…finally` 无 `catch`（失败时弹窗停在空白 + 全局 toast）。
- 弹窗内容：`qr.image` 存在则渲染 `<img>`（`:323`，260×260，`:348`）；否则渲染 `el-alert type="warning"`「未配置微信凭证或生成失败，暂无法出码」+ 描述「请在后端 .env 配置 WX_APPID / WX_SECRET 后重试」（`:324-325`，**只提配置项名称，不涉及值**）；固定说明文案强调「码内仅含该邀请码标识，不含任何个人信息」（`:326`，与 `admin.py:891` 的接口文档串一致）；下面两行元信息是邀请码明文（`:327`）与小程序版本（`:328`，经 `ENV_LABELS` 映射，未命中回退原始值）。
- `downloadQr()`（`:172-179`）：`qr.image` 或 `qrInvite` 缺失直接 return；否则建 `<a>`、`href` 指向 **data URL**、`download` 为「邀请码_{名称}_{码值}.png」后 `click()`。底部「下载图片」按钮 `:disabled="!qr?.image"`（`:333`）。
- **本页未复用 `utils/download.ts` 的 `saveFile` 是正确的**：`saveFile`（`admin/src/utils/download.ts:2-4`）会把字符串参数包成 `new Blob([data])`，对 `data:image/png;base64,…` 会导出成一个文本文件而不是图片。若日后重构为「后端返回 Blob」才可改用 `saveFile`。
- 后端链路：`admin.py:881-903` → `invite_service.get_invite`（不存在抛 404）→ `invite_service.scene_of(code)`（`:37`，`i={code}`）→ `wechat_service.get_invite_image(scene)` → `wechat_service.to_data_url(image)`；返回 `{image, page, scene, env_version, mock}`，其中 `mock = (image is None)`。

### 4.9 状态派生与展示（不落库）

- `status` 完全由后端每次请求实时算：`invite_service._status_of`（`:119-128`）先跑 `_check_usable`（`:41-51`），捕获 `InviteError` 后**按优先级**判定——`is_enabled` 为假 → `disabled`；`expires_at <= now` → `expired`；否则 → `exhausted`；未抛异常 → `active`。即**停用优先于过期**：一个既停用又过期的码显示「已停用」。
- 前端只做码→中文与码→颜色的两张静态表（`:16-27`），不参与判定；`as InviteStatus` 断言（`:240-241`）意味着后端若返回表外状态，标签会渲染成空文本 + `undefined` 类型（§9 第 11 项）。

### 4.10 加载 / 空 / 错误态

- 加载：表格 `v-loading="loading"`（`:214`）、弹窗保存按钮 `:loading="saving"`（`:316`）、行内开关 `:loading`（`:249`）、小程序码区 `v-loading="qrLoading"`（`:321`，`.qr-box` 有 `min-height:160px` 防跳动，`:347`）。
- 空态：**无自定义空态**——列表为空只有 Element Plus 默认「暂无数据」，未区分「没有邀请码」与「搜索没命中」；组织下拉为空时也无提示（§9 第 8 项）。
- 错误态：无局部错误 UI，全部依赖 `api/request.ts:46-48` 的全局 toast；`fetchOrgTree(true)` 的 403 被 `silent` 抑制并落到 `catch`（`:190-192`）。
- 本页**没有任何 `ElMessageBox.confirm`**，因此不存在 `OrgsView`/`AccessView`/`AdminLayout` 那种「确认框取消 → 未处理 rejection」的问题；停用邀请码也**不做二次确认**（§9 第 6 项）。

### 4.11 与公共组件、实时推送的关系

- **不引用 `admin/src/components/` 下任何公共组件**（导入仅 `:4-14`）；两个弹窗都是页内内联 `el-dialog`。**不做 Excel 批量导入**（未使用 `ExcelImportDialog.vue`），发码只能逐个生成。
- **不订阅 WebSocket**（未导入 `utils/liveUpdates`）：`used_count` 与 `status` 的变化（员工在小程序端扫码入驻）需手动「刷新」才可见（与 `.qoder/ARCHITECTURE.md` §6.4 一致）。
- 时间格式化统一走 `utils/format.ts` 的 `formatDateTime`（`:14` 导入，`:234`、`:258` 调用），**无页面私有 formatter**。
- 图标以字符串引用（`'Search'` `:207`、`'Plus'` `:210`、`'Refresh'` `:211`），已在 `admin/src/main.ts:26`/`:66`、`:22`/`:62`、`:25`/`:65` 注册；本页**未引用 `Iphone`**（§3）。

## 5. 输入与输出

- 输入：无 props / 无 emits。隐式输入为 `store/auth` 的 localStorage 登录态（`api/request.ts:19-25` 注入 Bearer Token）与用户的搜索 / 翻页 / 弹窗表单 / 开关操作。
- 输出：无返回值；副作用经后端落库并写审计。
- 调用的 `api/admin.ts` 函数与后端链路（`request.ts:28` 的成功拦截器返回**完整 AxiosResponse**，故处处 `const { data } = await …` 自行解包；`baseURL` 为 `/api`）：

| 前端函数（`admin/src/api/admin.ts`） | 方法与路径 | 后端权限 | route → service | 本页调用点 |
|---|---|---|---|---|
| `fetchInvites(page, pageSize, keyword)`（`:430-432`） | GET `/api/admin/invites` | `require_menu("invites")`（`admin.py:834`） | `admin.py:829-837` → `invite_service.list_invites:149-164` | `:50` |
| `createInvite(data)`（`:434-436`） | POST `/api/admin/invites` | 同上（`admin.py:848`） | `admin.py:845-856` → `invite_service.create_invite:181-194` | `:126` |
| `updateInvite(id, data)`（`:438-440`） | PATCH `/api/admin/invites/{id}` | 同上（`admin.py:868`） | `admin.py:864-878` → `invite_service.update_invite:197-216` | `:129`（编辑）、`:145`（启停） |
| `fetchInviteQr(id)`（`:442-444`） | GET `/api/admin/invites/{id}/qrcode` | 同上（`admin.py:889`） | `admin.py:886-903` → `invite_service.get_invite:219-220` + `scene_of:37` + `wechat_service.get_invite_image` | `:165` |
| `fetchOrgTree(true)`（`:747-749`） | GET `/api/admin/orgs` | **`require_menu("orgs")`**（`admin.py:670`） | `admin.py:672-673` → `admin_service.get_org_tree:603-632` | `:188`（silent） |

- TS 类型（均在 `admin/src/api/admin.ts`）：`InviteStatus`（`:390`，四值联合）、`InviteItem`（`:392-406`）、`InviteListResult`（`:408-411`）、`InviteUpsert`（`:414-420`，`:413` 注释说明 `null` 语义与 `expires_at` 为带时区 ISO）、`InviteQrResult`（`:422-428`）、`OrgNode`（`:41-50`）。`updateInvite` 的第二参类型是 `Partial<InviteUpsert> & { is_enabled?: boolean }`（`:438`），故启停只发一个字段是类型安全的。
- 请求体校验：`AdminInviteCreate`（`backend/app/schemas/schemas.py:913-917`）`name` 1–64 必填、`remark` ≤200、`max_uses` `ge=1`；`AdminInviteUpdate`（`:920-927`）全字段可选 + `is_enabled`；两者共同继承 `_InviteExpiry`（`:902-910`），其 `field_validator` 把 `expires_at` 经 `local_to_utc` 统一转 UTC naive。
- 错误码：422（Pydantic 校验失败，如 `max_uses=0`）；403（无 `invites`/`orgs` 权限）；404（`admin.py:877` 把 `ValueError("邀请码不存在")` 映射为 404，`get_invite` 同）；400（「组织不存在」`invite_service.py:169`、「使用次数上限须大于 0」`:171`、「使用次数上限不能低于已使用次数（N）」`:206`、「名称与启用状态不能为空」`admin.py:872`）。

## 6. 依赖关系

- 导入（`:4-14`）：`vue`（`computed`/`onMounted`/`reactive`/`ref`）、`element-plus`（`ElMessage`，**未导入 `ElMessageBox`**）、`../api/admin`（5 个函数）、`../api/admin` 类型（`InviteItem`/`InviteQrResult`/`InviteStatus`/`OrgNode`）、`../utils/format`（`formatDateTime`）。
- 模板组件由 `admin/src/plugins/element-plus.ts:94-133` 按需注册：card/input/button/table/table-column/tag/switch/dialog/form/form-item/input-number/select/option/date-picker/pagination/alert/icon 全部在册，本页**无组件漏注册问题**。
- 被依赖：`admin/src/router/index.ts:75-78`（`/invites` 懒加载）。
- 数据来源表：`invite_codes`（含 `org_id`）、`organizations`（组织范围下拉与 `org_name`）、`users`（`invite_code_id` 记录入驻来源，本页不直接读，由 `AccessView` 展示）、`audit_logs`（`invite.create`/`invite.update` 由后端写入，在 `AuditView` 呈现）。
- 后端服务详见 `.qoder/backend/app/services/invite_service.py.md`、`.qoder/backend/app/api/routes/admin.py.md`；微信出码见 `backend/app/core/wx.py` / `wechat_service`（`.qoder/backend/app/services/` 下对应文档）。
- 关联页面：`views/OrgsView.vue`（组织树的维护方，本页是其消费方）、`views/AccessView.vue`（展示用户的邀请码来源与入驻时间、账号启停；同一 `afbcba9` 提交引入）、`views/AuditView.vue`（`ACTION_TEXT` 含 `invite.create`/`invite.update`）。小程序侧对接 `pages/launch`（扫码落地 + `phase = blocked`）、`pages/onboard`（入驻信息收集）、`services/auth.js`（`lm_pending_invite` 暂存），见 `.qoder/REQUIREMENTS.md` §2.2。

## 7. 业务规则

1. **权限**：进入与全部邀请码写操作都需 `invites` 菜单码（超管恒真，`store/auth.ts:27-29`）；该码由 `docker/init/015_invite_admission.sql:31-33` 后补进 `admin_menus`，未包含在 `010` 的初始 9 码里，因此**老库必须先跑 015 迁移**，否则角色勾不到、非超管永久 403。
2. **码值由后端生成、前端不可指定**：`createInvite` 的 payload 里没有 `code` 字段（`:117-124`），后端 `InviteCode(code=generate_code(), …)`（`invite_service.py:185`）用 `secrets.choice` 从字母+数字表取 **16 位**（`:19-20`、`:33-34`）。前端只读展示，不提供「自定义码」「重新生成码」入口。
3. **状态是派生值，不落库**：`_status_of`（`invite_service.py:119-128`）每次请求实时算；判定优先级 **disabled > expired > exhausted > active**，故「已停用」会掩盖「已过期」。前端两张表（`:16-27`）只做展示映射。
4. **停用即时生效、并发不超发**：核销走「带全部有效性条件的单条 UPDATE，按影响行数判定成功」（`invite_service.py:77-91`，条件含 `is_enabled`、`expires_at IS NULL OR > now`、次数未满），因此开关一关，正在扫码的用户立刻拿不到准入；并发核销不会突破 `max_uses`。
5. **一次性语义**：邀请码只决定「**首次入驻**」资格；已入驻用户后续登录不再校验原码，过期 / 停用 / 用满都不影响存量用户（`.qoder/REQUIREMENTS.md` §2.2「一次性语义」行）。本页停用某个码**不会**踢掉已入驻的人。
6. **有效期口径**：前端 `el-date-picker` 采集本地时间 → `Date.toISOString()` 提交带 `Z` 的 UTC ISO（`:123`）→ 后端 `_InviteExpiry.to_utc` 经 `local_to_utc` 存 **UTC naive**（`schemas.py:907-910`、`core/helpers.py:40-44`）→ 展示时 `formatDateTime` 经 `parseUtc` 补 `Z` 再按浏览器本地时区渲染（`utils/format.ts:29-31`、`:39-42`）。`:308` 的提示「按本地时区设置，提交转为 UTC 存储」即此约定，与全后台一致。`expires_at` 为空即「长期有效」（`:235`）。
7. **次数上限**：`max_uses` 为 `null` 即不限（显示「∞」，`:229`）；非空须 ≥1（前端 `:min="1"` `:298`、后端 `Field(ge=1)` `schemas.py:917`）；**编辑时不得低于 `used_count`**，该约束**只在后端**（`invite_service.py:205-206`），前端仅以旁注提示（`:299`）。
8. **组织范围**：`org_id` 为 `null` 即「不限（可任选组织入驻）」；绑定组织后，员工只能在该组织的**子树**内入驻，越界由后端拒绝（`invite_service.ensure_org_in_scope:73`、`_ensure_in_scope:64-70`）。组织不存在时生成/编辑直接 400（`_validate_fields:167-169`）。
9. **敏感信息**：邀请码属入驻凭证，**不写入日志与审计明细**——`invite.create` 只记 `{invite_id, name}`（`invite_service.py:188-191`），`invite.update` 只记 `{invite_id, name, fields}`（`:210-213`）；小程序码 scene 只含 `i={code}`，不含 OpenID/Token/个人信息（`admin.py:891` 文档串、`:326` 界面文案）。本文档同样不记录任何真实码值。
10. **无删除**：接口层没有 `DELETE /admin/invites/{id}`，页面也没有删除按钮（`:261-266`）。废弃码只能停用——因为 `users.invite_code_id`（`015_invite_admission.sql:26`）是历史入驻来源的外键依据，删码会丢来源追溯。
11. **排序与分页固定**：列表按 `id desc`（最新在前，`invite_service.py:157`），无排序切换；单页 ≤100（`admin.py:831`），前端固定 10（`:34`）。
12. **搜索只按名称**：`icontains` 作用于 `InviteCode.name`（`:154`），**不支持按码值搜索**，与 `:201` 占位「按名称搜索」一致。
13. **出码依赖微信凭证**：未配置 `WX_APPID`/`WX_SECRET`（或调用失败）时 `image` 为 `null`、`mock` 为 `true`，页面显示警告条并禁用下载（`:323-325`、`:333`）。小程序版本由后端 `settings.WXACODE_ENV_VERSION` 决定（`admin.py:902`），前端只做中文映射（`:28`、`:328`）。
14. **启停与编辑共用一个接口**：PATCH 是部分更新（`exclude_unset`，`admin.py:870`），行内开关只发 `is_enabled`，弹窗保存发全量五字段 + `is_enabled`；两者都会写 `invite.update` 审计。

## 8. 修改约束

- **菜单码四方一致**：`admin/src/router/menus.ts:12` 的 `code`、`router/index.ts:78` 的 `meta.menu`、后端 `require_menu("invites")`（`admin.py:834`/`:848`/`:868`/`:889`）、数据库 `admin_menus.code`（`docker/init/015_invite_admission.sql:31-33`）必须逐字相同（同 `.qoder/admin/src/views/AccessView.vue.md` §8 第 1 条）。
- **`silent=true` 不可去掉**（`:188`）：`fetchOrgTree(true)` 的 403 抑制是「只有 `invites` 权限、没有 `orgs` 权限」的管理员的唯一保护，改回非 silent 会让这类管理员每次进页都吃一个 403 弹窗（`api/request.ts:33`）。反之，**不得把后端 `/admin/orgs` 的权限放宽到 `invites`** 来「修」这个下拉——那会破坏 `OrgsView` 的权限边界。
- **状态码值四方一致**：`InviteStatus`（`api/admin.ts:390`）、`STATUS_LABEL`/`STATUS_TYPE`（`:16-27`）、后端 `_status_of`（`invite_service.py:119-128`）三处必须同步；新增状态若只加后端，前端会渲染空标签（§9 第 11 项）。
- **`null` 语义是契约**：`org_id`/`max_uses`/`expires_at` 的 `null` 表示「不限」，且依赖 `exclude_unset` 区分「未传」与「传 null 清空」（`schemas.py:921`、`admin.py:870`）。改 payload 组装方式（例如过滤掉 null 字段）会让「清空组织范围 / 改为长期有效 / 改为不限次数」失效。
- **`expires_at` 必须继续以带时区 ISO 提交**（`:123`）：`_InviteExpiry` 对 naive 值走 `local_to_utc` 的「视为北京时间」分支（`core/helpers.py:42-43`），若前端改传 naive 串会让有效期偏移 8 小时。
- **竞态守卫三处成对保留**：`requestSeq` 自增（`:47`）、赋值前判等（`:51`）、`finally` 内判等（`:55`）。
- **`togglingId` 互斥与单向 `:model-value` 不可改成 `v-model`**（`:141`、`:248`）：改成 `v-model` 后请求失败时开关会停在错误位置（当前靠「不改写 `row`」自动弹回）。
- **不得在本页明文打印码值到日志/审计**，也不得把码值写进任何入库文档（`admin/agents.md` 与根 `.qoder/README.md` §3.14 的敏感信息约束）；界面展示码值是业务需要（管理员要发给员工），但新增导出/复制功能时须重新评估。
- **列表必须保持服务端分页**（根 `agents.md` §2.4）；`page_size` 上限受后端 `le=100` 约束（`admin.py:831`），放开需后端同步。
- **`name` 的 `maxlength="64"`、`remark` 的 `maxlength="200"`**（`:281`、`:284`）对应 `schemas.py:914-915`/`:923-924`，改一处要改另一处。
- **下载逻辑不要盲目改用 `utils/download.ts` 的 `saveFile`**（§4.8）：它会把 data URL 字符串包成 Blob 而导出文本文件。
- 视觉与可用性：需覆盖加载 / 空态 / 筛选与窄屏可用性（`admin/agents.md`「开发约定」第 3 条）；操作列已 `fixed="right"`（`:261`），加列注意总宽。

## 9. 当前实现状态

**已实现**

- 邀请码分页列表（名称搜索）、生成、编辑、行内启停、小程序码生成与下载、组织范围限定（复用组织树 + 完整路径下拉）、使用次数上限、有效期（本地时区输入 / UTC 存储 / 本地时区展示）、四态中文标签与配色、创建人与创建时间展示。
- **符合规范的点**：**服务端分页 + 服务端筛选**（`:50` + `invite_service.py:153-161`）；**请求竞态守卫**（`requestSeq`）；行内开关**单向绑定 + 互斥 + 失败自动弹回**（`:141`、`:248-250`、`:146`）；`fetchOrgTree(true)` 的 **silent 降级**（`:188-192`）；**时间格式化统一走共享工具、无私有 formatter**；组织下拉显示**完整路径**（`:38-43`）；**本页无任何确认框，因而不存在「取消 → 未处理 rejection」问题**；页面用到的全部组件与图标均已注册；敏感信息处理正确（界面不打印到日志，后端审计不含码值）。

**存在问题 / 已知事项**

1. **无删除能力**：接口与 UI 都没有删除（`:261-266`）。这是有意设计（`users.invite_code_id` 需保留入驻来源，§7 第 10 项），但**长期会累积废弃码**，且列表无「只看可用」筛选，找有效码要翻页。是否需要状态筛选或软删除**待确认**（未见需求条目）。
2. **多处 `try…finally` 无 `catch`**：`loadList`（`:49-56`）、`saveInvite`（`:116-136`）、`toggleEnabled`（`:144-150`）、`openQr`（`:164-169`）、`onMounted` 里的 `loadList()`（`:186`，未 await 也未 catch）。接口失败时产生未处理 rejection（仅控制台噪声，用户已见拦截器 toast），且**列表保留上一次数据、无局部错误提示**。与 `.qoder/admin/src/views/AccessView.vue.md` §9、`.qoder/admin/src/views/AuditView.vue.md` §9 第 6 项同一模式，**未针对本文件记录过**。
3. **`el-form` 无 `:model`/`:rules`/`ref`**（`:279`）：只有名称非空一条命令式校验（`:110-114`）。「编辑时 `max_uses` 不得低于 `used_count`」这条真实约束只在后端（`invite_service.py:205-206`），前端仅以旁注文字提示（`:299`），用户要等 400 才知道；`el-form-item` 也不会显示字段级错误文案。与 `OrgsView.vue:296` 用 `FormRules` 的写法不一致。
4. **有效期可选到过去时刻**：前端无 `disabled-date`（`:302-307`），后端 `_InviteExpiry`（`schemas.py:902-910`）与 `_validate_fields`（`invite_service.py:167-171`）也不校验是否在未来 → 可以生成一个**状态立刻就是「已过期」**的码，且小程序码照样能出（`:333` 只看 `qr.image`），员工扫了必然被拒。是否需要前端拦「不得早于当前时间」**待确认**。
5. **小程序码弹窗对 `mock` 标志无判断**：`InviteQrResult.mock`（`api/admin.ts:427`，后端 `admin.py:903` 为 `image is None`）在本页**完全未被使用**（全文只出现在类型里）。当前「无图 = mock」两者等价，故暂无可见问题；但若后端将来返回一张占位图并置 `mock: true`，`:323` 会把它当真实小程序码展示、`:333` 也允许下载，管理员会把无效码发出去。建议改为 `v-if="qr.image && !qr.mock"`。**未记录**。
6. **停用无二次确认**：行内开关一拨即停用（`:140-151`），而停用是**即时断准入**的破坏性操作（`invite_service.py:77-91`），正在扫码入驻的员工会立刻失败。对照 `AccessView.vue` 的账号停用是**有**二次确认的（该文档 §4.4 第 2 条）。是否需要补确认**待确认**（未看到相关需求，且开关可即时恢复，风险有限）。
7. **`qr.page` / `qr.scene` 未展示**（`api/admin.ts:424-425`）：`scene` 是排查「扫码进不了入驻页」的关键信息，界面只显示码值与版本。属可观测性缺口，非缺陷。
8. **组织下拉为空时无任何解释**：`orgOptions` 置空的三种原因（无 `orgs` 权限 / 组织表为空 / 请求失败，`:190-192`）在 UI 上不可区分，下拉既无 `no-data-text` 也无 tooltip；`AccessView.vue` 对同类情况至少给了 `el-tooltip` 说明「需同时拥有「组织架构」菜单权限」（该文档 §4.6）。**未记录**。
9. **`flattenOrg` 与 `AccessView.vue:41-46` 重复实现**（§4.4）：同名同语义的两份代码分散在两个视图，未抽到 `admin/src/utils/`，违反根 `agents.md` §2.2「重复出现的相似逻辑应抽取公共实现」。两处将来若只改其一，会出现「组织下拉路径格式不一致」。**未记录**。
10. **组织下拉只在 `onMounted` 拉一次**（`:185-193`）：在 `OrgsView` 改完组织回到本页不会刷新，可能把邀请码绑到已删除/已改名的组织 id 上（后端 `_validate_fields` 只校验「组织存在」，改名后的显示不同步）。
11. **状态标签对未知值无回退**：`:240-241` 直接以 `row.status as InviteStatus` 索引两张表，后端若返回表外状态则渲染空文本 + `undefined` 标签类型。对照 `AuditView.vue` 的动作码有「未命中回退原始码」（该文档 §4.5）。
12. **无自定义空态、无错误态**（§4.10），与 `admin/agents.md`「开发约定」第 3 条「数据页需覆盖加载、空状态、筛选和窄屏可用性」相比偏弱。
13. `pageSize` 固定 10 且分页器无每页条数选择器（`:34`、`:271-275`）；无排序切换（后端固定 `id desc`）。
14. **搜索无防抖**（只有回车 / 清空 / 按钮三种显式触发，`:204-207`）：与 `AccessView` 同口径，靠竞态守卫兜底，可接受。
15. **无导出入口**（本页不涉及 `utils/download.ts` 的 CSV 能力，故 CSV 公式注入防护在此不适用；若日后加导出须遵守 `admin/agents.md`「开发约定」第 4 条）。
16. 小程序码下载文件名内嵌**真实码值**（`:177`）：属管理员侧的必要信息，但下载文件会离开受控环境，是否需要水印/审计**待确认**。

**待开发**

- 无本页专属待办条目。可选改进（均为上面 §9 项的延伸，非既有需求）：状态筛选、`mock` 判断、组织下拉失败提示、`flattenOrg` 抽取公共实现。AI 智能中心的 5 个 `ai_*` 菜单码与本页无关。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/views/InvitesView.vue`，共 **1 个提交**；增删行数取自 `git show --numstat afbcba9 -- admin/src/views/InvitesView.vue`。该提交在 `docs/迭代记录.md` 有对应条目。

### 2026-10-12（`afbcba9`）
- 需求：邀请码准入全链路（管理后台侧）——把原先「一个通用入驻二维码」升级为「按邀请码发码、可限组织/次数/有效期、可启停、可逐码出小程序码」，配合 `/api/auth/login` 改为状态式返回（`active`/`unregistered`/`disabled`）且未入驻不建号。
- 修改内容（涉本文件）：**+351/-0，创建本文件**，即当前全部内容——① 列表（服务端分页 + `requestSeq` 竞态守卫 + 名称搜索，`:45-67`、`:214-276`）；② 生成/编辑弹窗（`:69-137`、`:278-318`，含 `expires_at` 以 `toISOString()` 提交、`is_enabled` 仅编辑态渲染）；③ 行内启停（`togglingId` 互斥 + `Object.assign(row, data)` 就地更新，`:139-151`、`:245-254`）；④ 小程序码弹窗与 data URL 下载（`:153-179`、`:320-335`）；⑤ 四态中文/配色映射与 `ENV_LABELS`（`:16-28`）；⑥ 组织范围下拉复用 `/admin/orgs` 并以 `flattenOrg` 显示完整路径、`fetchOrgTree(true)` silent 降级（`:36-43`、`:185-193`、`:286-296`）。创建时即已具备竞态守卫与 silent 降级，故未受后续 `30b4458` 类修复影响（该提交早于本文件一天）。
- 关联文件：`admin/src/api/admin.ts`（+59/-3，`fetchInvites`/`createInvite`/`updateInvite`/`fetchInviteQr` 与 5 个类型）、`admin/src/router/index.ts`（+6，`/invites` 路由）、`admin/src/router/menus.ts`（+1，`invites` 菜单项）、`admin/src/views/AccessView.vue`（+63/-3，邀请码来源/入驻时间/账号状态列与 `status` 筛选、账号启停）、**`admin/src/layout/AdminLayout.vue`（+2/-45，下线顶栏「入驻二维码」按钮与弹窗，即 `Iphone` 图标失去引用之处，§3）**、`docker/init/015_invite_admission.sql`、`backend/app/services/invite_service.py`、`backend/app/api/routes/admin.py`、`backend/app/schemas/schemas.py`、`frontend/pages/launch`、`frontend/pages/onboard`、`frontend/services/auth.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目（同提交含 `admin/test/docs/s19-invite-admin-report.md` 与 `s19-invite-frontend-report.md` 两份验收报告）。
