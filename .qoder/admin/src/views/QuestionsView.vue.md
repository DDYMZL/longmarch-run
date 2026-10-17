# QuestionsView.vue

## 1. 文件路径

`admin/src/views/QuestionsView.vue`（404 行）

## 2. 文件职责

「题库维护」页（`<script setup>` 单文件组件）：每日一题题库的管理端唯一维护入口，提供服务端分页 + 题型/知识分类/题干关键字三维筛选的列表，单题新增/编辑/软删除弹窗（动态选项 2–6 个、单选/判断双题型），并挂接两条批量入库通道——Excel 批量导入（复用公共组件 `ExcelImportDialog.vue`，经 `questionImportApi` 走「模板下载 → 预览校验 → 确认写入」两阶段）与 AI 智能出题（复用 `AiGenerateDialog.vue`，草稿审核后批量保存）。页面自身不做任何答题业务逻辑，只维护 `questions` 表内容。

## 3. 业务需求

- 需求出处：`.qoder/REQUIREMENTS.md` §11.3「题库管理」（题目 CRUD、删除改为停用、Excel 导入、AI 出题各行的依据列均指向本文件）；题库与答题的关系见 §5「每日答题」（「题库不足」「题库规模」两行：种子 15 题、题库不足须返回明确状态）；AI 出题需求见 §10「AI 智能中心」与 §10.3「AI 出题策略」；Excel 导入通用规则见 §11.6 与 `.qoder/ARCHITECTURE.md` §8.2。
- 菜单码 `questions` 在 `admin/src/router/menus.ts:8` 登记（侧边栏「题库维护」，`EditPen` 图标）；AI 出题复用同一菜单码鉴权（`backend/app/api/routes/admin.py:504`、`:528`），因此 AI 出题不是 AI 智能中心 Phase A 的 `ai_*` 菜单页面（详见 `.qoder/admin/src/components/AiGenerateDialog.vue.md`）。
- 演进（`git log --follow`，共 6 个提交，详见 §10）：`4a26520`（2026-09-30）创建（全量加载 + 前端过滤）→ `01ec93c`（2026-10-02）增加知识分类 → `54ea125`（2026-10-10）改服务端分页并加页面私有 Excel 导入 → `30b4458`（2026-10-11）竞态守卫 + 防抖搜索收敛 → `d6acf7e`（2026-10-11）私有导入 UI 整体替换为公共 `ExcelImportDialog`（-158 行）→ `ea58b6c`（2026-10-16）接入 AI 智能出题弹窗。

## 4. 核心功能

### 4.1 路由、菜单码与前后端双重守卫

- 路由：path `/questions`、name `questions`、`meta.menu = 'questions'`，懒加载本文件（`admin/src/router/index.ts:50-55`）。注意菜单码 `questions` 与路由 path 同名，而 `route_nodes` 码对应 `/route-nodes`（下划线/连字符差异是刻意保留的，见 `menus.ts:7-8`）。
- 前端守卫：`router/index.ts:112-116`（无 `questions` 码回退 `firstAllowedPath()`，`:9-12`）；`hasMenu = getIsSuper() || getMenus().includes(code)`（`admin/src/store/auth.ts:27-29`）；侧边栏过滤 `admin/src/layout/AdminLayout.vue:15`。
- 后端守卫：本页调用的全部 7 个题库端点 + 2 个 AI 端点都挂 `Depends(require_menu("questions"))`（`backend/app/api/routes/admin.py:384`、`:402`、`:432`、`:446`、`:459`、`:473`、`:491`、`:504`、`:528`）。前端隐藏不是安全边界。

### 4.2 列表状态与服务端分页加载

- 状态（`:19-27`）：`loading`、`questions`、`total`、`page`(1)、`pageSize`(20)、`filterType`、`filterCategory`、`keyword`（输入框绑定）、`appliedKeyword`（防抖后实际生效值）。
- `loadQuestions`（`:31-54`）：带 `requestSeq` 竞态守卫（`:30`、`:32`、`:42`、`:52`），只采纳最后一次请求；调 `fetchQuestions({page, page_size, keyword(trim 后空则 undefined), qtype, category})`；**末页越界回退**（`:44-48`）：当前页返回空且 `page > lastPage` 时把 `page` 改为最后一页（由 watch 自动重拉），处理「删除末页最后一题」场景。`try…finally` 无 `catch`，失败依赖 `request.ts:46-48` 全局 toast，且保留上一次数据（§9 第 2 项）。
- 分页在服务端：`admin_service.list_questions`（`backend/app/services/admin_service.py:142-169`）过滤 `active == True`（`:155`，软删除题不出现在列表），`keyword` 用 `contains(..., autoescape=True)` LIKE 转义（`:157`），`qtype`/`category` 精确匹配（`:158-161`），`order_by(Question.id)` **升序**（`:164`）+ offset/limit；单页上限 100（`admin.py:388`）。
- 触发链（`:56-69`）：`keyword` 输入 400ms 防抖写入 `appliedKeyword`（`:57-63`）；watch `[pageSize, filterType, filterCategory, appliedKeyword]` 复位 `page = 1`（`:65`）；watch `[page, pageSize, filterType, filterCategory, appliedKeyword]` 触发 `loadQuestions` 且 `immediate: true`（`:66`，初始加载即由此 watch 完成，无 `onMounted`）；两个 watch 同一 flush 内合并为一次请求（`:64` 注释）。`onBeforeUnmount` 清理防抖定时器（`:67-69`）。
- 表格（`:256-288`）：`v-loading` + `border stripe row-key="id"`；列：ID、题型（single→primary「单选题」/judge→success「判断题」标签，`:258-264`）、分类（`categoryLabel` 有值→warning、空→info「未分类」，`:265-269`、`:17`）、题干/选项/正确答案（均 `show-overflow-tooltip`；选项拼接 `label.text` 以全角空格分隔 `:273`；答案 `answerText` `:196-201` 把 answer 标签映射回「A. 文本」）、分值、操作（编辑/删除，`fixed="right"`）。分页器（`:290-297`）`layout="total, sizes, prev, pager, next"`，`page-sizes [10,20,50,100]`，`v-model` 双绑 page/pageSize。
- 空态：仅 `el-table` 默认「暂无数据」，无自定义 empty 插槽；工具栏显示「共 N 题」（`:248`）。

### 4.3 新增 / 编辑弹窗

- 常量：`LABELS = ['A'…'F']`（`:11`）、`CATEGORIES`（event 历史事件 / route 长征路线 / figure 历史人物，`:12-16`）。**这两组常量在 `AiGenerateDialog.vue` 内逐字重复**（已记录于 `.qoder/admin/src/components/AiGenerateDialog.vue.md`，本页 §9 第 5 项）。
- 表单状态 `form`（`:77-85`）：`type`('single')、`category`('event')、`question`、`optionTexts: string[]`、`answer`（单个标签字符串）、`analysis`、`score`(20)。`editingId`（`:74`）区分新增/编辑，标题 `dialogTitle`（`:94`）。
- `switchType`（`:96-104`）：切题型清空答案；judge 固定选项「正确/错误」，single 重置 4 个空选项。
- `openCreate`（`:106-116`）重置为默认值；`openEdit`（`:118-128`）回填，`category` 空时回退 `'event'`（`:121`），`answer` 取 `row.answer[0]`（`:124`，列表答案恒单元素）。
- 选项增删：`addOption` 上限 6（`:130-136`）、`removeOption` 下限 2 且删除项若为当前答案则清空答案（`:138-145`）；judge 题型选项输入框禁用、无增删按钮（`:335`、`:337`、`:340`）。
- 校验：`rules`（`:87-92`）type/question/answer/score 必填；`validateOptions`（`:147-150`）选项文本不能为空白；模板层 `maxlength`：题干 200、选项 100、解析 300（`:328`、`:336`、`:353`），`el-input-number` 分值 1–100（`:357`）。**这些长度/上限均为前端约束，后端不校验**（§8）。
- `handleSave`（`:152-183`）：表单校验 → 选项校验 → 组 payload（题干/选项/解析 trim，选项按序配 `LABELS[i]`，`answer: [form.answer]` 恒单元素数组，`:160-168`）→ `createQuestion` 或 `updateQuestion(editingId)` → 关弹窗、`loadQuestions()`；`saving` 状态锁按钮（`:362`）。`try…finally` 无 `catch`，失败时弹窗**保持打开**（`dialogVisible = false` 在 await 之后），全局 toast 报错。
- `handleDelete`（`:185-194`）：`ElMessageBox.confirm`（**无 `.catch()`**，取消即产生未处理 rejection，§9 第 1 项）→ `deleteQuestion` → 刷新。后端为**软停用**：`admin_service.delete_question`（`:196-205`）置 `active = False`，幂等；停用题不再被抽取但当天已生成的答题任务保留（`docker/init/020_question_rotation.sql` 注释）。

### 4.4 Excel 批量导入接线（`ExcelImportDialog`）

- 组件挂接（`:299-310`）：`v-model="importVisible"`，props：`title="批量导入题目"`、`unit="题"`、`item-label="道题目"`、`template-filename="长征步迹_题库导入模板.xlsx"`、`report-prefix="题库导入错误报告"`、`:tips="IMPORT_TIPS"`（`:206-210`，三条：先下模板按说明填写 / 任一行失败整批禁止 / 与库内重复判错不覆盖）、`:api="questionImportApi"`。
- 传入的三个接口函数（`admin/src/api/admin.ts:653-657`）：`downloadTemplate → GET /admin/questions/import-template`（blob）、`preview → POST /admin/questions/import-preview`（FormData）、`confirm → POST /admin/questions/import-confirm`（`{preview_token}`）；底层共用 `downloadImportTemplate/previewImport/confirmImport`（`admin.ts:639-651`）。
- 工具栏「下载导入模板」按钮不打开弹窗，直接调 `importDialog?.downloadTemplate()`（`:249`，经组件 `defineExpose`，`ExcelImportDialog.vue:101`）；「批量导入」按钮置 `importVisible = true`（`:250`）。
- `@imported="handleImported"`（`:212-216`）：确认导入成功后，若已在第 1 页手动 `loadQuestions()`，否则置 `page = 1` 由 watch 重拉。**组件内部缺陷（无 catch、token 过期不自愈、模板下载无 loading 锁等）统一见 `.qoder/admin/src/components/ExcelImportDialog.vue.md` §9，本页不重复描述。**
- 后端链路：`admin.py:429-466` → `import_service.build_question_template`（`:204-206`）/ `preview_question_import`（`:255-286`）/ `confirm_question_import`（`:289-298`）。文件级约束：仅 `.xlsx`、≤2MB（`admin.py:419-426`）、单次 ≤500 行（`import_service.py:26`）、预览令牌一次性 TTL 30 分钟（`:27`）、任一行出错整批阻断、确认阶段单事务写入（`.qoder/REQUIREMENTS.md` §11.6）。
- 行校验（`import_service._parse_question_row` `:209-252`）：题型接受「单选/single/判断/judge」别名（`:196`）、分类接受中文或英文别名或留空（`:197-201`、`:222-227`）、分值默认 20 须正整数（`:228-235`）、判断题固定 A正确/B错误 且答案接受「正确/错误/对/错/A/B」（`:237-242`）、单选从选项A–F 收集**非空**选项（`:244-249`）、最终复用与手工新增同一套 `_validate_question`（`:251` → `admin_service.py:208-233`）。查重：与库内题干重复、与文件内前文行重复均整行判错（`:260-276`）。确认写入时 id 取 `max+1` 连续分配（`:289-298`）。

### 4.5 AI 智能出题接线（`AiGenerateDialog`）

- `ea58b6c` 引入：导入组件（`:9`）、`aiVisible` 状态与 `handleAiSaved`（`:219-227`）、工具栏「AI 智能出题」按钮（`MagicStick` 图标，`:251`）、组件挂载 `<AiGenerateDialog v-model="aiVisible" @saved="handleAiSaved" />`（`:312`）。
- `handleAiSaved`（`:221-227`）：保存成功后清空 `filterType/filterCategory/appliedKeyword/keyword` 四个筛选，再复用 `handleImported` 回到第 1 页刷新。
- 弹窗内部（参数表单、生成/取消、草稿逐题编辑校验、勾选批量保存到 `POST /api/admin/ai/questions/batch-save`）全部封装在组件内，走旧链路 `admin.py:500-538` + `ai_question_service`，与 AI 智能中心 Phase A 的 `ai_*` 菜单无关——细节与缺陷见 `.qoder/admin/src/components/AiGenerateDialog.vue.md`，本页只负责挂接与刷新。

### 4.6 与公共工具的关系

- 本页**不再直接使用** `utils/download.ts`：`30b4458` 曾把私有 csvCell/saveFile 收敛到该工具，`d6acf7e` 把整个导入 UI（含模板下载、错误报告 CSV）移入 `ExcelImportDialog` 后，本页对 `utils/download` 的导入随之删除（现导入仅 `:3-9`）。错误报告 CSV 的公式注入防护由组件侧经 `csvCell`（`admin/src/utils/download.ts:13-17`）承担。
- 不使用 `utils/format.ts`（列表无时间字段）、不订阅 WebSocket（未导入 `utils/liveUpdates`）。
- 图标全部以字符串引用（Search/Download/Upload/MagicStick/Plus/Refresh/Delete），均已在 `admin/src/main.ts` 全局注册（`:48`、`:50`、`:57`、`:62`、`:65-66`、`:71`），无失配。

## 5. 输入与输出

- 输入：无 props / 无 emits（路由页面）。隐式输入为 `store/auth` 登录态（`request.ts:19-25` 注入 Bearer Token）与用户操作。
- 请求/响应类型（`admin/src/api/admin.ts`）：`Question`（`:15-24`）、`QuestionOption`（`:10-13`）、`QuestionListResult`（`:26-29`）、`QuestionUpsert`（`:31-39`）、`QuestionQuery`（`:601-607`）、`ImportPreviewResult`（`:615-621`）、`ImportErrorRow`（`:609-613`）。
- 端点链（api 函数 → 路由 → service）：
  - `fetchQuestions`（`admin.ts:623-625`）→ GET `/api/admin/questions`（`admin.py:380-395`）→ `admin_service.list_questions`（`:142-169`）；
  - `createQuestion`（`:627-629`）→ POST（`admin.py:398-408`）→ `create_question`（`:172-180`，id 显式 max+1，无数据库自增）；
  - `updateQuestion`（`:631-633`）→ PUT `/{id}`（`admin.py:469-484`）→ `update_question`（`:183-193`，404「题目不存在」）；
  - `deleteQuestion`（`:635-637`）→ DELETE `/{id}`（`admin.py:487-495`）→ `delete_question`（`:196-205`，软停用，返回 `{message}`，类型 `MessageResult` `admin.ts:139-141`）；
  - `questionImportApi` 三函数（`:653-657`）→ `admin.py:429-466` → `import_service`（见 §4.4）。
- 请求体 Pydantic：`AdminQuestionUpsert`（`backend/app/schemas/schemas.py:1060-1069`，**无任何长度/范围约束**，业务校验全在 `_validate_question`）；`AdminImportConfirmRequest`（`:1133-1134`）。
- 错误码：参数校验失败 422（FastAPI Query/Pydantic）；业务失败 400（`ValueError` → HTTPException，`admin.py:407-408` 等）；题目不存在 404；导入文件类型/大小/表头错误 400（`admin.py:421-425`、`import_service.ImportError` `:451-452`）；令牌过期/已消费 400（`import_service.py:140-175`）；无权限 403。
- 输出：无返回值，纯渲染 + 对 `questions` 表的写操作。

## 6. 依赖关系

- 导入（`:3-9`）：`vue`（computed/onBeforeUnmount/reactive/ref/watch）、`element-plus`（ElMessage/ElMessageBox + FormInstance/FormRules 类型）、`../api/admin`（5 个函数 + 2 个类型）、`../components/ExcelImportDialog.vue`、`../components/AiGenerateDialog.vue`。
- 被依赖：`admin/src/router/index.ts:50-55`（`/questions` 懒加载）。
- 数据来源：`questions` 表（`active` 软停用列与索引由 `docker/init/020_question_rotation.sql` 加入；种子 15 题见 `.qoder/REQUIREMENTS.md` §5「题库规模」行；文档 `.qoder/docker/init/020_question_rotation.sql.md`）。
- 后端文档：`.qoder/backend/app/api/routes/admin.py.md`、`.qoder/backend/app/services/admin_service.py.md`、`.qoder/backend/app/services/import_service.py.md`、`.qoder/backend/app/services/ai_question_service.py.md`。
- 关联页面/组件：`AiGenerateDialog.vue`（复制了本页 `LABELS`/`CATEGORIES`）、`ExcelImportDialog.vue`（同一组件被寄语页复用）；消费方为小程序每日一题（`backend/app/services/quiz_service.py`）。

## 7. 业务规则

1. **权限**：查看与全部写操作需 `questions` 菜单码（前端守卫 + 后端 `require_menu` 双保险，§4.1）。
2. **删除即软停用**：DELETE 只置 `active = False`（`admin_service.py:196-205`），列表恒过滤 `active == True`（`:155`）；已生成的当日答题任务不受影响（`020_question_rotation.sql` 注释）。操作幂等，无恢复入口（§9 第 7 项）。
3. **题目合法性**（后端 `_validate_question` `admin_service.py:208-233`，手工与导入共用）：type ∈ {single, judge}；题干非空；category ∈ {event, route, figure} 或空；选项 ≥2 且 label 不重复；答案非空且都在 label 中；single 恰好 1 个答案；score 为正整数。
4. **前端补充约束**（仅 UI 层）：选项 2–6 个、选项文本非空（`:131`、`:139`、`:147-150`）、judge 选项固定「正确/错误」（`:99-101`）、题干 ≤200 / 选项 ≤100 / 解析 ≤300 字、分值 1–100（`:328`、`:336`、`:353`、`:357`）。
5. **排序固定 id 升序**（`admin_service.py:164`），新题（含导入、AI 保存）总在列表**末尾**；页面不提供排序切换。
6. **导入两阶段**：预览整批校验（任一行失败整批阻断），确认令牌一次性、TTL 30 分钟、单事务写入（§4.4；`.qoder/REQUIREMENTS.md` §11.6）。
7. **导入查重**：题干与库内或文件内重复即整行判错，**不覆盖**（`import_service.py:269-276`）。
8. **搜索**：keyword 对题干 LIKE 模糊（autoescape 转义 `%_\`，`admin_service.py:157`）；qtype/category 精确等值（`:158-161`）。
9. **分页口径**：单页 ≤100（`admin.py:388`），前端默认 20 可选 10/20/50/100；`total` 为筛选后总数。
10. **AI 出题**：生成只返回草稿不入库，须管理员审核后 batch-save（`admin.py:498-499` 注释），复用 `questions` 菜单码。

## 8. 修改约束

- **三方校验契约**：前端 `rules`/`validateOptions`（`:87-92`、`:147-150`）↔ 后端 `_validate_question`（`admin_service.py:208-233`）↔ 导入 `_parse_question_row`（`import_service.py:209-252`）必须同步修改；AI 出题的前端 `validateItem` 是第四份拷贝（`.qoder/admin/src/components/AiGenerateDialog.vue.md`）。改任何一处校验（如放宽选项数）都要核对其余三处。
- **删除语义不可改回硬删除**：软停用是为保护 `daily_questions`/`quiz_answers` 既有会话（`020_question_rotation.sql`；`.qoder/REQUIREMENTS.md` §11.3「删除题目」行）；`active` 过滤在 service 层，前端不要自行加「显示已停用」开关而不改后端。
- **`LABELS`/`CATEGORIES` 双份拷贝**：改分类枚举（值或文案）必须同步 `AiGenerateDialog.vue` 内的逐字副本与后端 `_QUESTION_CATEGORY_ALIASES`（`import_service.py:197-201`）、`_validate_question` 的 category 白名单（`admin_service.py:215-216`）。
- **保持服务端分页/搜索**：不得改回前端全量过滤（根 `agents.md` §2.4；`54ea125` 专门做过这次改造）；竞态守卫 `requestSeq`（`:30-53`）与 400ms 防抖（`:56-63`）是 `30b4458` 审查修复成果，删除会回退已修缺陷。
- **watch 合并请求的结构**（`:65-66`）：page 复位 watch 与加载 watch 必须保持「复位在前、加载在后」的同源触发列表，否则会出现同一操作发两次请求或漏请求。
- **导入接线契约**：`questionImportApi` 三函数签名与 `ExcelImportApi`（`ExcelImportDialog.vue:10-14`）绑定；模板文件名/报告前缀等 props 与后端 `_xlsx_response` 文件名（`admin.py:435`）宜保持一致。
- 表格 `row-key="id"`、`show-overflow-tooltip` 列与 `fixed="right"` 操作列在增删列时保留；数据页需覆盖加载、空状态、筛选和窄屏可用性（`admin/agents.md`「开发约定」第 3 条）。
- 若未来给本页加 CSV 导出，必须走 `utils/download.ts` 的 `csvCell`（公式注入防护，`admin/agents.md`「开发约定」第 4 条）。

## 9. 当前实现状态

- **已实现**：服务端分页 + 三维筛选 + 防抖搜索 + 竞态守卫 + 末页越界回退；新增/编辑弹窗（双题型、动态选项、分类）；软删除；Excel 两阶段批量导入（公共弹窗）；模板直接下载；AI 智能出题挂接。历次浏览器验收见 §10 各提交在 `docs/迭代记录.md` 的条目。
- **存在问题 / 已知事项**：
  1. `handleDelete` 的 `ElMessageBox.confirm` **无 `.catch()`**（`:186-190`）：点「取消」即产生未处理的 Promise rejection（仅控制台噪声）。与 `AdminLayout.vue:17-21` 同模式，该模式已在 `.qoder/admin/src/layout/AdminLayout.vue` 相关文档记录，但本页这处未见既有文档记录。
  2. `loadQuestions` 为 `try…finally` 无 `catch`（`:34-53`）：请求失败时表格保留上一次数据且无错误态标识，用户可能把旧结果当最新（与 `.qoder/admin/src/views/AuditView.vue.md` §9 第 3 项同模式）。
  3. **导入/AI 保存后回第 1 页看不到新题**：列表按 id 升序（`admin_service.py:164`），新题在**最后一页**；而 `handleImported`（`:212-216`）与 `handleAiSaved` 注释均称「回到第一页…才能看到刚保存的题目」（`:220`），行为与注释相悖——除非筛选恰好只剩一页。属体验缺陷 + 误导性注释，未见既有文档记录。
  4. 前端长度/上限约束（题干 200、选项 100、解析 300、分值 ≤100、选项 ≤6）**后端一律不校验**（`AdminQuestionUpsert` `schemas.py:1060-1069` 无约束；`_validate_question` 无长度检查），绕过 UI 直调 API 可写入超长文本；DB 列是否有长度上限**待确认**（查 `backend/app/models/models.py:126` 起的 `Question` 列定义与 `docker/init/` 建表 SQL）。
  5. `LABELS`/`CATEGORIES`（`:11-16`）与 `AiGenerateDialog.vue` 内副本逐字重复——**已记录**于 `.qoder/admin/src/components/AiGenerateDialog.vue.md`，此处仅指认。
  6. 后端不校验选项文本非空（`_validate_question` 只查数量与 label），空文本选项仅被前端 `validateOptions` 与导入解析（收集非空单元格，`import_service.py:247-248`）挡住；API 直调可产生空选项题目。
  7. 软删除后**无恢复/查看已停用题目的入口**（列表恒过滤 `active`，`admin_service.py:155`），误删只能改库。是否属需求缺口**待确认**。
  8. 无自定义空态文案；`el-table` 默认「暂无数据」不区分「题库为空」与「筛选过严」。
  9. 本页无 CSV 导出入口（错误报告 CSV 在 `ExcelImportDialog` 内）；题库导出是否属需求**待确认**。
- **待开发**：无本页专属待办。AI 管理子页面（`ai_*` 菜单码）待开发是全局状态（`.qoder/admin/src/router/index.ts.md` §9），与本页的 AI 出题弹窗无关。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/views/QuestionsView.vue`，共 **6 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目（按提交号检索）。

### 2026-10-16（`ea58b6c`）
- 需求：题库接入 CloudBase Agent AI 出题（草稿审核后入库），Excel 导入完整保留。
- 修改内容（涉本文件）：+15/-0（`git show --numstat` 实测）——导入 `AiGenerateDialog`（`:9`）；新增 `aiVisible` 与 `handleAiSaved`（清筛选 + 回第 1 页刷新，`:219-227`）；工具栏加「AI 智能出题」按钮（`:251`）；挂载弹窗组件（`:312`）。
- 关联文件：`admin/src/components/AiGenerateDialog.vue`（新建）、`admin/src/api/admin.ts`（`generateAiQuestions`/`batchSaveAiQuestions`）、`backend/app/api/routes/admin.py:500-538`、`backend/app/services/ai_question_service.py`、`backend/app/services/cloudbase_service.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `ea58b6c` 条目（提交信息载：冒烟 16/16 含真实 Agent 10/50 题，浏览器验收截图 s26-01~09，无数据库变更）。

### 2026-10-11（`d6acf7e`）
- 需求：每日寄语循环改造同批——抽取通用导入弹窗供题库复用，并修复同一弹窗无法重选文件。
- 修改内容（涉本文件）：+28/-158——删除页面私有导入实现（`importFile`/`previewing`/`confirming`/`preview` 状态、`openImport`/`handleFileChange`/`handlePreview`/`handleConfirmImport`、模板下载与错误报告 CSV 私有逻辑及对 `utils/download` 的导入，均 `54ea125`/`30b4458` 引入），替换为 `<ExcelImportDialog :api="questionImportApi">`（`:299-310`）+ `IMPORT_TIPS`（`:206-210`）+ `handleImported`（`:212-216`）。
- 关联文件：`admin/src/components/ExcelImportDialog.vue`（新建）、`admin/src/views/QuotesView.vue`、`admin/src/api/admin.ts`（`questionImportApi`/`quoteImportApi` 改对象注入）、`docker/init/013_daily_quote_cycle.sql`、`backend/app/services/import_service.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `d6acf7e` 条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复（本页涉及：请求竞态守卫、服务端防抖搜索与 LIKE 转义、下载工具收敛）。
- 修改内容（涉本文件）：+32/-40——新增 `requestSeq` 竞态守卫与末页越界回退（`:30`、`:42-48`）；关键字改 400ms 防抖 + `appliedKeyword`（`:56-63`），筛选/页码变化合并为单次请求的双 watch 结构（`:64-66`）；`onBeforeUnmount` 清定时器（`:67-69`）；删除私有 `csvCell` 与两处手写 `URL.createObjectURL` 下载，改用 `utils/download` 的 `saveFile`/`today`/`csvCell`（该导入后被 `d6acf7e` 随私有导入 UI 一并移除）；配套后端 `contains(autoescape=True)` LIKE 转义（`admin_service.py:157`）。
- 关联文件：`admin/src/utils/format.ts`、`admin/src/utils/download.ts`、`admin/src/views/QuotesView.vue`、`admin/src/views/AuditView.vue` 等 8 个视图、`backend/app/services/admin_service.py`、`backend/app/services/quote_service.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-10（`54ea125`）
- 需求：题库支持 Excel 模板下载与批量导入（预览校验 + 事务写入 + 防重复提交），题库列表改服务端分页。
- 修改内容（涉本文件）：+219/-16——列表由「一次全量拉取 + 前端 `filtered` computed 过滤」改为服务端分页（`fetchQuestions` 带 page/page_size/keyword/qtype/category）；新增页面私有导入弹窗（文件选择、预览统计与逐行错误表、错误报告 CSV 下载、模板下载、确认导入锁）。
- 关联文件：`backend/app/api/routes/admin.py`（import-template/preview/confirm 三端点）、`backend/app/services/import_service.py`（新建）、`admin/src/api/admin.ts`、`admin/src/utils/download.ts`、`docker/init/011_import_previews.sql`（预览暂存表，文档 `.qoder/docker/init/011_import_previews.sql.md`）。
- 测试结果：见 `docs/迭代记录.md` 的 `54ea125` 条目。

### 2026-10-02（`01ec93c`）
- 需求：题库新增知识分类（event/route/figure）：表单下拉、分类列与筛选（同批新增驾驶舱与数据大屏、路线点位表单扩展）。
- 修改内容（涉本文件）：+25/-0——新增 `CATEGORIES` 常量与 `categoryLabel`（`:12-17`）、`filterCategory` 状态并加入前端过滤、表单 `category` 字段（默认 event）、新增/编辑/保存链路带上 category、表格分类列与筛选下拉。
- 关联文件：`admin/src/views/RouteNodesView.vue`、`admin/src/views/DashboardView.vue`、`admin/src/views/ScreenView.vue`、`backend`（category 字段与校验）。
- 测试结果：见 `docs/迭代记录.md` 的 `01ec93c` 条目。

### 2026-09-30（`4a26520`）
- 需求：新增管理后台基础页面及依赖配置（管理后台首批交付）。
- 修改内容（涉本文件）：创建本文件（+299 行）——题目 CRUD 弹窗（题型/题干/动态选项/答案/解析/分值）+ 全量列表 + 前端 `filtered` computed 过滤（题型/关键字），`fetchQuestions()` 不带分页参数，无导入、无分类。
- 关联文件：`admin/src/api/admin.ts`、`admin/src/router/index.ts`、`admin/src/layout/AdminLayout.vue`、`backend/app/api/routes/admin.py`、`backend/app/services/admin_service.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `4a26520` 条目。
