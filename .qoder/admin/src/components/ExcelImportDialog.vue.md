# ExcelImportDialog.vue

## 1. 文件路径

`admin/src/components/ExcelImportDialog.vue`（185 行）

## 2. 文件职责

管理后台**仅有的 2 个公共组件之一**（另一个是 `AiGenerateDialog.vue`）：把「Excel 批量导入」这条在题库与每日寄语两处完全同形的交互链——下载模板 → 选文件 → 上传校验（预览）→ 展示错误明细/导出失败报告 → 确认导入——抽成一个业务无关的弹窗组件（`<script setup lang="ts">`）。业务差异全部通过 props 注入：文案（`title`/`unit`/`itemLabel`/`templateFilename`/`reportPrefix`/`tips`）与三个后端接口（`api`）。组件自身**不 import 任何具体 API 函数**，只依赖 `api/admin.ts` 导出的 `ImportPreviewResult` 类型（`:7`）。

## 3. 业务需求

- 需求来源：每日寄语按天循环展示与批量维护（V1.1 功能二，需求 §16）——运营需要一次性录入几十上百条寄语与题目，逐条手填不现实。
- `d6acf7e`（2026-10-11）新建：该提交在新增寄语导入接口的同时，把**已存在于题库页**的导入弹窗抽出为通用组件供两处复用，并顺带修复「同一弹窗无法重新选择文件」的缺陷（`docs/迭代记录.md` 的 `d6acf7e` 条目「admin：抽出通用组件 `ExcelImportDialog`，题库页改为复用。修复同一弹窗无法重新选择文件的问题」）。
- 导入的业务硬约束（整批阻断、令牌一次性、错误定位到行与字段、重复不覆盖）由后端 `import_service` 定义，本组件负责把它们如实呈现给运营，见 `.qoder/backend/app/services/import_service.py.md`。

## 4. 核心功能

### 4.1 接口契约 `ExcelImportApi`（`:10-14`）

导出 interface，**恰好 3 个成员**，全部返回原始 `AxiosResponse`（不拆包，与 `request.ts:28` 的成功拦截器一致）：

| 成员 | 签名 | 对应 `admin.ts` 封装 |
| --- | --- | --- |
| `downloadTemplate` | `() => Promise<AxiosResponse<Blob>>` | `downloadImportTemplate(url)`（`admin/src/api/admin.ts:639-641`，`responseType: 'blob'`） |
| `preview` | `(file: File) => Promise<AxiosResponse<ImportPreviewResult>>` | `previewImport(url, file)`（`admin.ts:643-647`，`FormData` 单字段 `file`） |
| `confirm` | `(previewToken: string) => Promise<AxiosResponse<{ imported: number }>>` | `confirmImport(url, token)`（`admin.ts:649-651`，body `{ preview_token }`） |

组件内所有解构都写成 `const { data } = await props.api.xxx()`（`:63`、`:79`、`:89`）。

### 4.2 本地状态（`:31-35`）

- `uploadRef`（`:31`，`UploadInstance`）：仅用于 `clearFiles()` / `handleStart()` 两个命令式调用。
- `importFile`（`:32`，`File | null`）：当前选中文件，**只存内存不落盘**，`auto-upload=false` 下由组件自己择机上传。
- `previewing`（`:33`）/ `confirming`（`:34`）：两个独立 loading 锁。
- `preview`（`:35`，`ImportPreviewResult | null`）：预览结果，含**一次性 `preview_token`**。

### 4.3 弹窗开启时的状态复位（`:37-41`）

`watch(visible, ...)` 只在 `open === true` 分支做事：清空 `importFile` 与 `preview`。复位点选在「打开」而非「关闭」，配合 `el-dialog` 的 `destroy-on-close`（`:105`），保证每次打开都是干净的初始态；`previewing`/`confirming` 不在复位列表内——它们由各自 `finally` 兜底（`:70-72`、`:83-85`），正常情况下不会残留 `true`。

### 4.4 文件选择与重选（`:43-54`、`:111-123`）

- `el-upload` 配置（`:111-119`）：`:auto-upload="false"`（**不自动上传**，`:113`）、`:show-file-list="false"`（隐藏默认文件列表，`:114`）、`accept=".xlsx"`（`:115`）、`:limit="1"`（`:116`）、`:on-change="handleFileChange"`（`:117`）、`:on-exceed="handleExceed"`（`:118`）。触发器是一个 `el-button`，文案在「选择 .xlsx 文件」与已选文件名之间切换（`:120-122`）——即用按钮文本替代被关闭的文件列表。
- `handleFileChange`（`:43-46`）：取 `file.raw ?? null` 存入 `importFile`，并**清空上一次 `preview`**（换文件后旧预览结果与旧令牌必须作废）。
- `handleExceed`（`:49-54`）：`limit=1` 时再选文件会走 exceed 而非 change，故手动 `clearFiles()` → 给新文件重派 `uid = genFileId()`（`:52`）→ `handleStart(file)`（`:53`）把它塞回上传队列，从而在同一弹窗内完成「重选文件」。`genFileId` 从 `element-plus` 直接 import（`:4`），`UploadRawFile` 只作为 `files[0]` 的类型断言（`:51`）。`:48` 注释即此意图。这是 `d6acf7e` 修的缺陷本体。
- **重选同一文件能否再次触发 change**：`el-upload` 内部是否在选择后重置 `<input type="file">.value` 属 Element Plus 实现细节，本次未核（第三方产物不在建档范围）→ **待确认**。`d6acf7e` 条目与浏览器验收记录（`docs/迭代记录.md` 的 `d6acf7e` 条目「重新选择文件」项）表明「重选文件」场景已验收通过。

### 4.5 阶段一：上传校验（`:56-73`）

`handlePreview`：无文件时 `ElMessage.warning('请先选择填写好的 .xlsx 文件')` 直接返回（`:57-60`）；置 `previewing = true` → `await props.api.preview(file)` → 写回 `preview`；按 `invalid_count` 分流提示：为 0 时 `success`「校验通过：N 行可导入」（`:66`），否则 `warning`「发现 N 行错误，修正后请重新上传」（`:68`）。**只有 `finally`，没有 `catch`**（`:70-72`）：请求失败（如文件 >2MB、表头不符、401/403）时错误由 `request.ts:46-48` 的全局拦截器弹 toast（`previewImport` 未传 `silent`），组件内 `preview` 保持为上一次的值（首次失败即保持 `null`），同时异常继续向上抛出、由 `@click` 调用方产生一次未处理的 Promise rejection（仅控制台噪声，无用户可见影响；现状事实，与 `.qoder/admin/src/layout/AdminLayout.vue.md` §4.1 记载的同类模式一致）。

### 4.6 阶段二：确认导入（`:75-86`）

`handleConfirm`：入口双重守卫 `if (!preview.value || confirming.value) return`（`:76`）——`confirming` 即重复提交锁，模板上「确认导入」按钮另绑 `:loading="confirming"`（`:152`），两处共同保证**一次性令牌不会被并发消费两次**。成功后：`ElMessage.success('成功导入 N <itemLabel>')`（`:80`）→ `visible.value = false` 关弹窗（`:81`）→ `emit('imported', data.imported)` 通知父页刷新（`:82`）。同样只有 `finally`（`:83-85`）无 `catch`：失败时弹窗**不关闭**、`preview` 不清空，错误文案由全局拦截器弹出。

### 4.7 下载模板（`:88-91`、`:101`）与错误报告（`:93-99`）

- `downloadTemplate`：`await props.api.downloadTemplate()` → `saveFile(data, props.templateFilename)`。**无 loading 态、无 try/catch**，连点会并发发起多次下载（`:110` 的按钮也未绑 disabled）——现状事实，见 §9。
- `defineExpose({ downloadTemplate })`（`:101`）：**唯一对外暴露的方法**，供父页工具栏上的「下载导入模板」按钮在**不打开弹窗**的情况下直接调用（两个调用方均以 `importDialog?.downloadTemplate()` 形式使用，见 §6）。
- `downloadErrorReport`（`:93-99`）：表头 `['Excel行号','出错字段','错误原因']`（`:95`），行数据 `e.field || '整行'` 兜底（`:96`），逐格过 `csvCell` 后以 `\r\n` 连接（`:97`），再前置 BOM `\uFEFF` 存为 `${reportPrefix}_${today()}.csv`、`text/csv;charset=utf-8`（`:98`）。`csvCell`（`admin/src/utils/download.ts:13-17`）对以 `= + - @` 开头的文本加前导单引号并转义双引号，即 `admin/agents.md`「开发约定」第 4 条要求的 **CSV 公式注入防护**——错误原因里含用户 Excel 原文，必须过这一层。`today()`（`download.ts:20-23`）用本地时区拼 `YYYY-MM-DD`（注释说明避开 `toISOString` 的 UTC 偏移）。无错误行时函数直接 return（`:94`），且按钮本身只在 `preview.errors.length` 为真时渲染（`:133-137`）。

### 4.8 模板区（`:104-160`）

- `el-dialog`（`:105`）：`v-model="visible"`（即 `defineModel`）、`:title="title"`、`width="720px"`、`destroy-on-close`；**未设** `:close-on-click-modal="false"`，点遮罩可关闭（关闭即触发 §4.3 的下次打开复位，不丢服务端数据）。
- 填写提示 `el-alert type="info"`（`:106-108`）：`v-for` 渲染 `tips`，自动加 `1. 2. 3.` 序号，`:key="tip"` 用文案本身。
- 操作行 `.import-actions`（`:109-127`）：下载模板 / 选择文件 / 上传校验三个按钮横向排列。「上传校验」按钮 `:loading="previewing" :disabled="!importFile"`（`:124`）。
- 预览结果区 `v-if="preview"`（`:129-146`）：汇总 `el-alert` 按 `invalid_count === 0` 切 `success`/`error`，文案「共 N 行：有效 X 行，错误 Y 行」（`:130-132`）；有错误时再渲染「错误明细」标题 + 下载错误报告链接按钮（`:134-137`）+ `el-table`（`:138-144`，`border size="small" max-height="280"`，三列：`row` 宽 90 居中 / `field` 宽 110 居中且 `row.field || '整行'` / `reason` `min-width="260"` + `show-overflow-tooltip`）。
- 底部（`:148-158`）：「取消」直接 `visible = false`（`:149`）；「确认导入」按钮 `:loading="confirming"`、`:disabled="!preview || preview.invalid_count > 0 || preview.valid_count === 0"`（`:153`）——即**任一行出错或无有效行时按钮不可点**，这就是「整批阻断」在前端的呈现；按钮文案动态追加数量与单位「确认导入 N <unit>」（`:156`）。

### 4.9 样式区（`:162-185`）

`scoped`，4 个类：`.import-tip{margin-bottom:14px}`（`:163-165`）、`.import-actions{display:flex;align-items:center;gap:12px;margin-bottom:14px}`（`:167-172`，未设 `flex-wrap`，窄屏下三按钮可能溢出——现状事实）、`.error-header{...space-between;margin:10px 0 6px}`（`:174-179`）、`.error-title{font-weight:600;color:#f56c6c}`（`:181-184`，Element Plus danger 色）。无 `:deep()` 穿透。

## 5. 输入与输出

### 5.1 props（`:16-26`，`defineProps<{...}>` 类型式声明，**7 个全部必填**）

| prop | 类型 | 用途 | 题库页实参 | 寄语页实参 |
| --- | --- | --- | --- | --- |
| `title` | `string` | 弹窗标题 | `批量导入题目` | `批量导入寄语` |
| `unit` | `string` | 计量单位（`:18` 注释「如『题』『条』」），仅用于确认按钮文案 | `题` | `条` |
| `itemLabel` | `string` | 成功提示中的对象名（`:20` 注释「如『道题目』『条寄语』」） | `道题目` | `条寄语` |
| `templateFilename` | `string` | 模板下载落盘文件名 | `长征步迹_题库导入模板.xlsx` | `长征步迹_每日寄语导入模板.xlsx` |
| `reportPrefix` | `string` | 错误报告 CSV 文件名前缀（后缀 `_${today()}.csv`） | `题库导入错误报告` | `寄语导入错误报告` |
| `tips` | `string[]` | 填写提示逐条渲染 | 3 条（`views/QuestionsView.vue:206-210`） | 3 条（`views/QuotesView.vue:179-183`） |
| `api` | `ExcelImportApi` | 三个后端接口 | `questionImportApi` | `quoteImportApi` |

模板文件名与后端 `_xlsx_response` 的 `Content-Disposition` 文件名同源同值（后端 `admin.py:435` 亦为「长征步迹_题库导入模板.xlsx」），改一处需同步另一处。

### 5.2 `defineModel`（`:28`）

`const visible = defineModel<boolean>({ required: true })`——**双向绑定的弹窗可见性**，`required: true` 表示父组件必须传 `v-model`（与 `AiGenerateDialog.vue:38` 的 `{ default: false }` 写法不同）。组件内部两处写回：确认导入成功后 `visible.value = false`（`:81`）、取消按钮 `visible = false`（`:149`）；`el-dialog` 自身关闭也经 `v-model` 回写（`:105`）。

### 5.3 emits（`:29`）

`imported: [count: number]`——**唯一事件**，仅在确认导入成功后触发一次（`:82`），载荷为后端返回的 `data.imported`（实际写库行数）。取消、校验失败、下载均不触发。

### 5.4 `defineExpose`（`:101`）

`{ downloadTemplate }`——**唯一暴露项**。父组件用 `ref<InstanceType<typeof ExcelImportDialog>>()` 持有实例后调 `importDialog?.downloadTemplate()`。注意该方法返回 `Promise<void>` 且内部无 try/catch，父组件也未 `await`/`.catch`，失败时表现为全局 toast + 一次未处理 rejection。

### 5.5 数据格式与错误呈现

- 入参（→ 后端）：`preview` 为 `multipart/form-data` 单字段 `file`；`confirm` 为 JSON `{ preview_token }`。
- 出参（← 后端）：`ImportPreviewResult`（`admin.ts:615-621`）= `preview_token` / `total` / `valid_count` / `invalid_count` / `errors[]`；`ImportErrorRow`（`admin.ts:609-613`）= `row`（Excel 行号）/ `field`（出错字段，可空串→前端显示「整行」）/ `reason`。后端对应 `AdminImportPreviewOut`（`backend/app/schemas/schemas.py:1123-1130`，docstring 明写「任意一行校验失败时本批次禁止确认导入」）与 `AdminImportConfirmOut`（`schemas.py:1137-1138`）。
- `confirm` 返回 `{ imported: number }`（`admin.ts:650`）。
- 错误码：文件级错误（类型/大小 >2MB/表头不符）与令牌错误均为 **400 + `{detail}`**（`backend/app/api/routes/admin.py:451-452`、`:464-465`、`:617-618`）；无 token 401、缺菜单码 403。组件不区分状态码，一律交给 `request.ts:27-51` 的全局拦截器弹 `detail`。
- 加载/空态/错误态：加载 = 两个按钮的 `:loading`；空态 = `preview` 为 `null` 时整个结果区不渲染（`v-if`，`:129`），错误表格无独立空态（仅在 `errors.length` 为真时渲染）；错误态 = 预览汇总 alert 的 `error` 变体 + 错误明细表格 + 全局 toast。

## 6. 依赖关系

### 6.1 依赖

- `vue`：`ref`、`watch`（`:3`）。
- `element-plus`：值导入 `ElMessage`、`genFileId`（`:4`）；类型导入 `UploadFile`、`UploadInstance`、`UploadRawFile`（`:5`）；模板使用 `el-dialog`/`el-alert`/`el-button`/`el-upload`/`el-table`/`el-table-column`，均由 `admin/src/plugins/element-plus.ts` 全局注册（见 `.qoder/admin/src/plugins/element-plus.ts.md`）。图标 `Download`/`FolderOpened` 以**字符串**形式传给 `:icon`（`:110`、`:120`、`:136`），依赖 `main.ts` 的全局图标注册（见 `.qoder/admin/src/main.ts.md`）。
- `axios`：仅类型 `AxiosResponse`（`:6`）——用于声明 `ExcelImportApi` 的返回类型，不发请求。
- `../api/admin`：仅类型 `ImportPreviewResult`（`:7`）；**不导入任何请求函数**，接口由 props 注入（本组件可复用的关键）。
- `../utils/download`：`csvCell`、`saveFile`、`today`（`:8`，`admin/src/utils/download.ts:13`/`:2`/`:20`）。
- 无 `store/auth`、无 `router`、无 WebSocket、无 `utils/liveUpdates`（grep 核实：`liveUpdates` 只被 DashboardView/ScreenView/RankingsView 三页引用）。

### 6.2 被谁依赖（全仓库 2 个调用方，grep `<ExcelImportDialog` 核实）

| 调用方 | import | 使用处 | `api` 实参 | `ref` 调用 |
| --- | --- | --- | --- | --- |
| `admin/src/views/QuestionsView.vue`（题库维护，路由 `/questions`，菜单码 `questions`，`router/index.ts:51-54`） | `:8` | `:299-310` | `questionImportApi`（`admin.ts:653-657`） | `:205` 声明 → `:249` `importDialog?.downloadTemplate()` |
| `admin/src/views/QuotesView.vue`（每日寄语，路由 `/quotes`，菜单码 `quotes`，`router/index.ts:57-60`） | `:17` | `:289-300` | `quoteImportApi`（`admin.ts:740-744`） | `:178` 声明 → `:242` `importDialog?.downloadTemplate()` |

两处传入的 props **除文案与 `api` 外完全一致**（`title`/`unit`/`item-label`/`template-filename`/`report-prefix`/`:tips`/`@imported`），`tips` 数组各自 3 条、内容不同（题库侧重「重复行判错不覆盖」，寄语侧重「排序号留空自动排后、启用状态默认启用」）。`@imported` 回调也不同：题库页 `handleImported`（`QuestionsView.vue:212-216`）按当前页码决定是否手动刷新；寄语页 `handleImported`（`QuotesView.vue:185-188`）重置页码后 `reloadAll()`。

### 6.3 后端接口对应表

| props.api 成员 | 题库（`questionImportApi`） | 寄语（`quoteImportApi`） | 权限 |
| --- | --- | --- | --- |
| `downloadTemplate` | `GET /api/admin/questions/import-template`（`admin.py:429-435`） | `GET /api/admin/quotes/import-template`（`admin.py:582`） | `require_menu("questions")` / `require_menu("quotes")` |
| `preview` | `POST /api/admin/questions/import-preview`（`admin.py:438-452`） | `POST /api/admin/quotes/import-preview`（`admin.py:591`） | 同上（preview 以参数依赖 `admin: AdminPrincipal = Depends(require_menu(...))` 形式声明，`admin.py:446`，因需取 `admin.username` 作操作人） |
| `confirm` | `POST /api/admin/questions/import-confirm`（`admin.py:455-466`） | `POST /api/admin/quotes/import-confirm`（`admin.py:608-619`） | 同上 |

数据库表：`import_previews`（预览暂存与令牌）+ `questions` / `daily_quotes`（确认时事务写入）。详见 `.qoder/backend/app/services/import_service.py.md` 与 `.qoder/backend/app/api/routes/admin.py.md`。

## 7. 业务规则

1. **两阶段导入**：`preview` 只做校验与暂存、返回 `preview_token`；`confirm` 凭令牌真正写库。两阶段之间用户可以下载错误报告、线下修正、重新上传。
2. **令牌一次性 + 30 分钟 TTL**：令牌仅存在于组件内存的 `preview.value.preview_token`（`:35`、`:79`），**不落 localStorage/sessionStorage、不进 URL**；服务端 `PREVIEW_TTL_MINUTES = 30`（`backend/app/services/import_service.py:27`），写入时 `expires_at = utcnow + 30min`（`import_service.py:129-133`）。过期/不存在/已用时 `confirm` 返回 400，文案分别为「预览已过期，请重新上传文件」「预览不存在，请重新上传文件」（`import_service.py:152-155`）。**前端对过期没有专门处理**：全局 toast 弹出后端文案，但 `preview` 不被清空、「确认导入」按钮仍处可点状态，用户再点仍是同一错误，必须重新走「选择文件 → 上传校验」——见 §9。
3. **任一行出错则整批阻断**：后端 `_load_preview` 发现 `payload.errors` 非空即抛「存在校验失败的数据行，本批次禁止导入」（`import_service.py:156-158`）；前端在按钮 `:disabled` 上同口径拦截（`:153`）。**不存在「只导入有效行」的部分成功语义**，`imported` 恒等于 `valid_count`。
4. **文件与行数上限**：≤2MB（`import_service.py:25`，路由层兜底文案见 `admin.py:425`）、≤500 行（`import_service.py:26`）。前端 `accept=".xlsx"` 只是选择器过滤，**不做大小/扩展名的前置校验**，超限由后端 400 报出。
5. **换文件即作废预览**：`handleFileChange`（`:45`）与 `watch(visible)`（`:39-40`）都会清 `preview`，确保「确认导入」永远对应最近一次校验的那份文件。
6. **重复提交防护**：`confirming` 逻辑锁（`:76`）+ 按钮 `:loading`（`:152`）双重；`previewing` 靠按钮 `:loading`（`:124`）。
7. **CSV 导出必须防公式注入**：所有落 CSV 的文本（含来自用户 Excel 的 `reason`）经 `csvCell`（`:97`），依据 `admin/agents.md`「开发约定」第 4 条。
8. **权限边界不在本组件**：菜单可见性由 `AdminLayout.vue` 过滤、URL 直达由路由守卫拦、接口由后端 `require_menu` 拦；本组件不做任何权限判断。

## 8. 修改约束

- **保持业务无关**：新增第三个导入场景（如路线点位批量导入）时，只在 `admin.ts` 增加一个 `xxxImportApi` 三件套并由视图传 props，**不要在本组件里写 `if (type === 'question')` 之类的分支**。`downloadImportTemplate`/`previewImport`/`confirmImport`（`admin.ts:639-651`）已是参数化实现，照抄即可。
- **`ExcelImportApi` 的三个签名是对外契约**：改返回类型（例如改成拆包后的 `data`）会同时打断 `QuestionsView.vue:308` 与 `QuotesView.vue:298` 两处传参与 `admin.ts:653-657`/`:740-744` 两个对象字面量的类型检查。
- **`defineModel<boolean>({ required: true })` 不可改成可选**：`visible` 是父组件控制弹窗的唯一通道，两个调用方都写 `v-model="importVisible"`。
- **`defineExpose` 只暴露 `downloadTemplate`**：两个父页的工具栏按钮直接依赖它（`QuestionsView.vue:249`、`QuotesView.vue:242`）；重命名即静默失效（可选链 `?.` 不报错，按钮变成无响应）。
- **`csvCell` 不得省略**：错误原因含用户可控文本，去掉即违反 `admin/agents.md`「开发约定」第 4 条。
- **`:limit="1"` 与 `handleExceed` 成对存在**：删掉 `handleExceed` 会让「重选文件」退化为用户必须先关弹窗再打开（`d6acf7e` 修的正是这个）。
- **`destroy-on-close`（`:105`）与 `watch(visible)` 的复位职责不要重复实现**：前者销毁弹窗内部 DOM，后者清组件 setup 作用域内的 ref，两者缺一不可（`importFile`/`preview` 属后者，不会被 `destroy-on-close` 清掉）。
- 视觉：错误标题色 `#f56c6c` 与 Element Plus danger 一致（`:183`）；`.import-actions` 未设 `flex-wrap`，若要满足 `admin/agents.md`「窄屏可用性」需自行补。
- 修改本文件后按 `.qoder/README.md` §3 第 4 条更新本文档 §4/§7/§9/§10，并按 `admin/agents.md`「必做验证」跑 `npm run build` + 浏览器实测（含「重新选择文件」「错误报告下载」两个历史缺陷点）。

## 9. 当前实现状态

**已实现（`d6acf7e` 起未再改动，`git log --follow` 仅 1 个提交）**

1. 两阶段导入全流程（下载模板 / 选文件 / 上传校验 / 错误明细表格 / 错误报告 CSV / 确认导入）在题库与寄语两处均已上线并通过浏览器验收（`docs/迭代记录.md` 的 `d6acf7e` 条目「验证」段：模板下载、错误导入与错误报告、重新选择文件、确认导入、题库导入回归）。
2. 整批阻断、一次性令牌、重复提交锁、CSV 公式注入防护均已落地。
3. `defineExpose` + 父页 ref 的「不开弹窗直接下模板」交互两处均在用。

**存在问题 / 已知事项（均为现状事实，未修）**

1. **三个异步入口都没有 `catch`**：`handlePreview`（`:56-73`）、`handleConfirm`（`:75-86`）、`downloadTemplate`（`:88-91`）只有 `finally`。失败提示完全依赖 `request.ts:46-48` 的全局 toast（这三个接口都未传 `silent`），异常继续上抛，在 `@click` 调用处形成未处理的 Promise rejection（控制台噪声）。
2. **令牌过期后 UI 不自愈**：`confirm` 返回 400「预览已过期」时 `preview` 不清空，「确认导入」按钮仍可点（`:153` 的 disabled 条件不含请求失败态），用户会反复撞到同一错误，只能重新上传。建议在 `handleConfirm` 的 `catch` 中对 400 清空 `preview`。
3. **「下载导入模板」无 loading 锁**（`:110`、`:88-91`）：连点会并发多次请求与多次落盘；`el-button` 也未绑 `disabled`。
4. **`.import-actions` 未设 `flex-wrap`**（`:167-172`）：窄屏下三个按钮可能横向溢出，与 `admin/agents.md`「开发约定」第 3 条的窄屏可用性要求存在张力（未实测，**待确认**）。
5. **错误明细表格无分页/虚拟滚动**：`max-height="280"` + 后端 `MAX_ROWS = 500` 上限，最坏 500 行一次性渲染。数量受后端硬上限约束，属可接受范围；错误报告 CSV 同样是全量拼接（`:97`）。

**待开发**：无（本组件功能完整；扩展方式是加 props / 加新的 `xxxImportApi`）。

**待确认**

- 重选**同一个**文件是否再次触发 `on-change`（依赖 Element Plus 内部是否重置 input.value，未核第三方产物）。
- 窄屏（如 1280px 以下）下操作行的实际表现未实测。

## 10. 迭代记录

数据来源：`git log --follow --format="%h|%ad|%s" --date=short -- admin/src/components/ExcelImportDialog.vue`，共 **1 个提交**（本文件自抽取以来未被修改过）。

### 2026-10-17（文档建档）
- 需求：补齐 `.qoder/admin/**` 文件级文档（第三批）。
- 修改内容：新建本文档，逐行核对源码 185 行、2 个调用方实参、3 组后端接口与令牌 TTL 实现。
- 关联文件：`admin/src/components/ExcelImportDialog.vue`、`admin/src/views/QuestionsView.vue`、`admin/src/views/QuotesView.vue`、`admin/src/api/admin.ts`、`admin/src/utils/download.ts`、`backend/app/api/routes/admin.py`、`backend/app/services/import_service.py`。
- 测试结果：只读核对，未执行构建与浏览器验收（本次任务明确禁止）。

### 2026-10-11（`d6acf7e`）
- 需求：每日寄语改为排序号 + 启用状态按天循环展示，并新增 Excel 模板下载与批量导入（错误定位到行与字段）。
- 修改内容（涉本文件）：**新建**本组件——把题库页原有的导入弹窗抽成通用组件（文案与三个接口全部 props 化），题库页改为复用；同时修复「同一弹窗无法重新选择文件」缺陷（`:48-54` 的 `handleExceed`：`clearFiles` + `genFileId` 重派 uid + `handleStart`）。
- 关联文件：`admin/src/views/QuotesView.vue`（新调用方）、`admin/src/views/QuestionsView.vue`（改为复用）、`admin/src/api/admin.ts`（`quoteImportApi` 与 `downloadImportTemplate`/`previewImport`/`confirmImport` 参数化）、`backend/app/api/routes/admin.py`（quotes 三个导入端点）、`backend/app/services/import_service.py`、`docker/init/013_daily_quote_cycle.sql`。
- 测试结果：见 `docs/迭代记录.md` 的 `d6acf7e` 条目（S17 13/13、S12 11/11、`npm run build` 通过、浏览器验收含「重新选择文件」「错误报告」「题库导入回归」；报告 `admin/test/docs/s17-quote-cycle-import-admin-report.md`）。
