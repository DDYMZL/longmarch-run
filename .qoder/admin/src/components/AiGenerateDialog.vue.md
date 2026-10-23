# AiGenerateDialog.vue

## 1. 文件路径

`admin/src/components/AiGenerateDialog.vue`（658 行；脚本 `:1-306`、模板 `:308-558`、样式 `:560-658`）

## 2. 文件职责

管理后台**仅有的 2 个公共组件之一**（另一个是 `ExcelImportDialog.vue`），也是全后台唯一的 AI 相关前端代码：嵌在「题库维护」页里的两阶段出题弹窗——① 填写生成参数调后端 LLM 上游分批生成**草稿**（上游由后端 `LLM_PROVIDER` 决定、可切换：`openai` = 阿里云百炼 / `cloudbase` = 腾讯云 CloudBase Agent；当前开发期为 cloudbase，上线部署前切回 openai。分派门面为 `backend/app/services/llm_service.py:1-22`，本组件与 `admin.ts` 对供应商完全无感知）；② 在草稿表格里逐题审核/编辑/重生成/删除，勾选后批量入库。组件自身承担全部前端即时校验、取消链路（`AbortController`）与失败明细呈现；**不写库、不持久化草稿**，关闭弹窗即丢弃（`:170-173`、§7 第 1 条）。

## 3. 业务需求

- 需求来源：题库运营成本高——手工逐条录入题目慢，需要 AI 批量产出候选题，但**必须由管理员审核后才入库**（`:2-3` 注释：「生成结果始终是草稿，未确认前不写库；保存时后端会重新校验，前端校验仅用于即时反馈」）。
- `ea58b6c`（2026-10-16 23:19）新建，与后端 `POST /api/admin/ai/generate-questions`、`POST /api/admin/ai/questions/batch-save` 同批交付（`docs/迭代记录.md` 的 `ea58b6c` 条目）。
- **与「AI 智能中心 Phase A」的关系（易误解，务必区分）**：Phase A 由 `1600074`（2026-10-17）交付，新增 `backend/app/api/routes/ai_admin.py` 的 15 个 `/api/admin/ai/*` 端点（知识库 / 出题任务 jobs / 持久化草稿 drafts / 配置中心）与 `pending/approved/rejected/imported` 草稿状态机。本组件**不属于 Phase A**，走的是 `backend/app/api/routes/admin.py:568`/`:592` 的**旧链路**、挂在 `questions` 菜单下；`backend/app/services/ai_question_service.py:398` 明写「现有 admin 前端的旧链路（generate-questions/batch-save）保持不变，本组接口供新工坊页使用」。详见 `.qoder/backend/app/api/routes/ai_admin.py.md` §9「待开发」第 1 条及其下的澄清引注。

## 4. 核心功能

### 4.1 常量与本地类型（`:11-36`）

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `LABELS`（`:11`） | `['A'…'F']` | 选项标签池，同时是选项数上限 6（`:254`、`:461`） |
| `COUNTS`（`:12`） | `[10, 20, 50, 100]` | 生成数量单选按钮（`:336-338`） |
| `TOPIC_MAX_LEN`（`:13`） | `100` | 主题输入 `maxlength`（`:330`）与重生成拼接的截断基准（`:197`） |
| `DIFFICULTIES`（`:14-19`） | `easy/medium/hard/mixed` | 难度下拉（`:346-348`） |
| `CATEGORIES`（`:20-24`） | `event/route/figure` | 生成参数分类下拉（`:352-354`）与草稿编辑器分类下拉（`:481-483`） |
| `DB_DUPLICATE`（`:25-26`） | `'与题库中已有题目重复'` | 后端错误串的特征子串；`:25` 注释说明「库内重复由后端比对全量题库得出，前端无法自行复查，故在题干未被改动前原样保留该标记」 |
| `SEP`（`:27-28`） | `\u0000` | 错误列表签名分隔符，避免多条错误拼接后与单条文本误判相等 |

`interface DraftItem`（`:30-36`）= `key`（表格 `row-key`，由模块级 `nextKey` 自增，`:52`）/ `data`（`QuestionUpsert`，可编辑副本）/ `dbDuplicate`（后端判定的库内重复标记）/ `baselineQuestion`（AI 原始题干，用于判断「题干是否被改过」）/ `errors`（前端实时校验结果）。**注意：`DraftItem` 没有任何 `status` 字段**——本组件不存在草稿状态机（§7 第 6 条）。

### 4.2 状态字段（`:38-61`）

- `visible = defineModel<boolean>({ default: false })`（`:38`）、`emit('saved', count)`（`:39`）。
- `phase: 'form' | 'result'`（`:41`）——两阶段切换开关，模板用 `v-show`（`:319`、`:376`）而非 `v-if`，故两 pane 的 DOM 常驻。
- `generating`（`:42`）/ `saving`（`:43`）：两个 loading 锁。
- `generateError`（`:44`）：生成阶段错误文案，内联 alert 展示（`:372`）。
- `batchErrors`（`:45`）：后端返回的**批次级**失败信息（`data.batch_errors`），逐条渲染 warning alert（`:395-403`）。
- `saveFailures`（`:46`，`AiSaveFailure[]`）：保存阶段**单题级**失败明细（`:404-415`）。
- `items`（`:47`，`DraftItem[]`）/ `selection`（`:48`）/ `regeneratingKey`（`:49`，正在重生成的行 key）/ `tableRef`（`:50`，`TableInstance`）。
- `nextKey`、`abortController`（`:52-53`）为**非响应式模块级变量**（`let`），不进 ref。
- `form = reactive({ topic, count: 10, difficulty: 'medium', category: '', extra: '' })`（`:55-61`）。
- 派生：`validItems`（`:63`，`errors` 为空的项）、`invalidCount`（`:64`，`items.length - validItems.length`）。

### 4.3 前端实时校验（`:86-118`）

`validateItem(item)`（`:87-104`，`:86` 注释自称「与后端 `admin_service._validate_question` 同口径」）依次检查：题干非空（`:91`）、选项 ≥2（`:92`）、选项内容非空（`:93`）、标签不重复（`:94-95`）、答案恰为 1 个且在标签内（`:96-97`）、分值为正整数（`:98`）、库内重复（`:99`，仅当 `dbDuplicate` 为真**且题干未被改动**时保留）或批内重复（`:100-102`）。

与后端 `backend/app/services/admin_service.py:208-233` 逐条比对，**口径并不完全一致**（详见 §9「存在问题」第 5 条）：前端多查「选项内容非空」（后端不查），少查 `type ∈ single/judge`（`:210-211`）与 `category ∈ event/route/figure 或空`（`:214-216`）。

`revalidateAll`（`:106-112`）遍历全部 `items` 重算，并用 `signature(next) !== signature(it.errors)`（`:110`、`:114-116`）做**签名比对后才写回**——`:109` 注释记录了原因：「新数组会再次触发深度 watcher，递归更新超限会中断整轮渲染」。这是 `ea58b6c` 条目「缺陷修复」段记载的那个 bug 的修复本体。深度 watcher 在 `:118`：`watch(items, revalidateAll, { deep: true })`。

### 4.4 阶段一：生成（`:128-168`）

`startGenerate`：主题空则 `ElMessage.warning('请填写出题主题')` 返回（`:129-133`）；置 `generating = true`、清 `generateError`、**新建 `AbortController`**（`:134-136`）；调 `generateAiQuestions({ topic, count, question_type: 'single', difficulty, category: form.category || undefined, extra_requirements: form.extra.trim() || undefined }, abortController.signal)`（`:138-148`）——`question_type` **硬编码 `'single'`**，模板上以只读 tag 呈现并说明「小程序答题逻辑当前仅支持单选」（`:341-344`）。

成功：`applyResult(data.items, data.batch_errors)`（`:149`）→ `phase = 'result'`（`:150`）→ 按 `batch_errors.length` 分流提示（`:151-155`）。`applyResult`（`:120-126`）把草稿映射为 `DraftItem`（`toItem`，`:75-84`，其中 `cloneData`（`:71-73`）对 `data` 与每个 `option` 做浅拷贝以脱离后端对象）、写 `batchErrors`、**清空 `saveFailures`**、`revalidateAll()`、`tableRef.clearSelection()`。

失败（`:156-159`）：`axios.isCancel(error)` 为真时写「已取消本次生成，未产生任何题目。」，否则 `detailOf(error) || 'AI 生成失败，请重试'`；`detailOf`（`:66-69`）对 axios 错误取 `error.response?.data?.detail || error.message`。`finally`（`:160-163`）复位 `generating` 并把 `abortController` 置回 `null`。

**取消链路**：`cancelGenerate()`（`:166-168`）= `abortController?.abort()`，由两处触发——「取消生成」按钮（`:539`，仅在 `generating` 时渲染）与 `el-dialog` 的 `@closed="handleClosed"`（`:316` → `:170-173`，`:171` 注释「关闭弹窗时终止仍在进行的生成请求，避免后端继续消耗 Agent 额度」）。`signal` 经 `generateAiQuestions` 透传给 axios（`admin/src/api/admin.ts:697-703`），该函数同时设 `timeout: 0`（不设前端超时，因生成可达分钟级）与 `silent: true`（错误不走全局 toast，改由本组件内联展示）。

### 4.5 阶段二：审核与编辑（`:175-274`、`:376-534`）

- `backToForm`（`:175-193`）：`items` 非空时先 `ElMessageBox.confirm('返回将丢弃当前未保存的题目草稿…')`，确认后清空 `items`/`batchErrors`/`saveFailures`/`generateError` 并回到 `form`；**这里显式 `.catch(() => undefined)`**（`:189`）吞掉取消。
- `regenerate(item)`（`:195-223`）：单题重生成。把主题改写为 `原主题截断 + '（请换一个考点，不要与「<题干前 20 字>」重复）'`（`:196-197`，`slice(0, Math.max(10, TOPIC_MAX_LEN - suffix.length))` 保证拼接后不超 100 字），以 `count: 1` 调 `generateAiQuestions`（`:200-207`）——**不传 `signal`**；返回空则 `ElMessage.error('AI 未返回题目，请重试')`（`:209-212`）；否则覆写 `item.data`/`dbDuplicate`/`baselineQuestion` 并 `revalidateAll()`（`:213-216`）。`regeneratingKey` 提供行级 loading（`:198`、`:221`、`:522`）。
- `removeItem`（`:225-227`）：按 `key` 过滤删除单行，**无二次确认、不 `clearSelection()`**。
- `removeSelected`（`:229-238`）：`await ElMessageBox.confirm(...)`（`:231-235`）**未接 catch**——用户点「取消」会产生一次未处理的 Promise rejection（与 `backToForm` 的处理方式不一致）。
- `selectAllValid`（`:240-243`）：先 `clearSelection()` 再对 `validItems` 逐行 `toggleRowSelection(row, true)`——即「全选可用」只选校验通过的行。
- `onSelectionChange`（`:245-247`）同步 `selection`；`setAnswer`（`:249-251`）把答案写成单元素数组。
- `addOption`（`:253-259`）：上限 6（`LABELS.length`），新标签按位置取 `LABELS[options.length]`。
- `removeOption(item, index)`（`:261-274`）：下限 2；删除后**按位置把标签重排为 A/B/C…**（`:269-271`，`:268` 注释说明与「新增题目」表单行为一致），并把答案映射到新标签——删的正是答案项时清空答案（`:272`），删的是答案之前的项时答案标签左移一位（`:273`）。
- 展开行编辑器（`:429-496`）：题干 textarea（`maxlength=200`）、选项列表（标签 tag + 内容 input `maxlength=100` + 「正确答案」radio + 删除按钮 + 添加选项）、解析 textarea（`maxlength=300`，`:476` placeholder「答题后展示给用户的解析」）、分类 select + 分值 `el-input-number :min="1" :max="100"`（`:481-485`）、行内错误 alert（`:487-493`）。
- 表格主体（`:417-533`）：`v-loading="saving"`、`row-key="key"`、`max-height="calc(100vh - 400px)"`、多选列 `reserve-selection` + `:selectable="(row) => !row.errors.length"`（`:428`，**有错误的行不可勾选**）、序号列、题干列（空题干显示「（空题干）」，`:499`）、选项数列、答案列（`:506` 显示 `answer[0] || '—'`）、状态列（`:509-516`：无错→success「可保存」，有错→danger「待修正 N」+ tooltip 展示错误串）、操作列（重生成 / 删除，`fixed="right"`）、`#empty` 插槽「题目草稿已全部处理完毕」（`:530-532`）。
- 汇总条（`:377-393`）：共 N 题 / 可直接保存 N / 待修正 N（`v-if="invalidCount"`）/ 已勾选 N（`v-if="selection.length"`）+「全选可用」「删除勾选」两个按钮。

### 4.6 批量保存与失败明细（`:276-305`）

`handleSave`：无勾选则 warning 返回（`:277-280`）；快照 `const rows = [...selection.value]`（`:281`，避免请求期间选择变化）；`saving = true` → `batchSaveAiQuestions(rows.map(it => it.data))`（`:284`，`admin.ts:705-711`，`silent: true`，**沿用全局默认 15s 超时**，未设 `timeout: 0`）。

结果处理（`:285-299`）：`failedIndexes = new Set(data.failures.map(f => f.index))`（`:286`），`savedKeys` = `rows` 中**下标 +1 不在 `failedIndexes`** 的行的 `key`（`:287-289`，`:285` 注释「`failures.index` 为提交列表中的序号（从 1 起）」，与后端 `ai_question_service.py:366` 的 `enumerate(items, start=1)` 对齐）→ 从 `items` 中剔除已保存行（`:290`）→ 写 `saveFailures`（`:291`）→ `clearSelection()`（`:292`）→ `revalidateAll()`（`:293`）→ 按 `data.failed` 分流提示（`:294-298`）→ `if (data.saved) emit('saved', data.saved)`（`:299`）。

失败项呈现（`:404-415`）：一个可关闭的 `error` alert，标题「N 题未通过后端校验，已保留在列表中」，正文 `<ul>` 逐条 `第 {{ f.index }} 条：{{ f.reason }}`（`:412-414`），`@close="saveFailures = []"`（`:410`）。**失败行不会被剔除**（`:290` 只删 `savedKeys`），用户可就地修正后重新勾选保存。`AiSaveFailure` = `{ index, reason }`（`admin.ts:684-687`，后端 `AdminAiSaveFailure`，`backend/app/schemas/schemas.py:1276-1280`）。

`catch`（`:300-301`）：`ElMessage.error(detailOf(error) || '保存失败，请重试')`；`finally`（`:302-304`）复位 `saving`。

### 4.7 弹窗与底部按钮（`:309-317`、`:536-556`）

`el-dialog`：`title="AI 智能出题"`、`width="92%"`、`top="4vh"`（近全屏宽）、`:close-on-click-modal="false"`（防误点遮罩丢草稿）、`class="ai-dialog"`、`@closed="handleClosed"`。**未设 `destroy-on-close`**，且组件内**没有 `watch(visible)`**（`watch` 只用于 `:118` 的 items 深度监听）——因此关闭再打开时 `phase`/`form`/`items` 全部原样保留（§9「存在问题」第 2 条）。

底部按 `phase` 切换（`:537-555`）：form 阶段 =「关闭」（`:disabled="generating"`）+「取消生成」（仅 `generating` 时）+「开始生成 / 生成中…」（`:loading="generating"`、`MagicStick` 图标）；result 阶段 =「重新生成」（`:disabled="saving"`）+「关闭」（`:disabled="saving"`）+「保存选中（N）」（`:loading="saving"`、`:disabled="!selection.length"`）。

form 阶段还有一个内联进度区（`:368-371`）：`el-progress :percentage="100" :indeterminate="true" :duration="3"` + 「正在分批调用 AI 生成 N 道题目，可取消…」（**无真实进度**，后端不提供进度查询）。顶部 info alert 明示「题目由腾讯云 CloudBase Agent 生成为**草稿**，须逐题审核并勾选后才会写入题库；生成过程不会改动现有题目」（`:320-324`）。**该 alert 是源码硬编码的 UI 字符串（`:322`，上文照抄原文）**：自 `b712d81` 起上游由后端 `LLM_PROVIDER` 决定、可切换，`LLM_PROVIDER=openai`（阿里云百炼）时「腾讯云 CloudBase Agent」字样与实际供应商不符；本次文档同步未改源码，是否另开任务修正该文案（同类还有 `:2` 文件头注释「后端调 CloudBase Agent 分批生成」）待用户定夺。

### 4.8 样式（`:560-658`）

`scoped`；`.pane{min-height:320px}`（`:561-563`，防两阶段切换时高度跳动）、`.gen-form`/`.generating` 限宽 820px、`.hint` 灰色 12px 提示文字、`.summary` flex + `flex-wrap: wrap`（`:589-595`，窄屏可换行）、`.spacer{flex:1}`、`.fail-list` 12px 列表、`.answer` 绿色加粗（`#67c23a`）、`.editor`/`.editor-row`/`.opt-row` 编辑器布局（标签列 `flex: 0 0 40px`）、`.draft-table :deep(.el-table__expanded-cell){padding:12px 0}`（`:655-657`，唯一的 `:deep()` 穿透）。

### 4.9 无轮询、无 WebSocket、无本地持久化（grep 核实）

组件不 import `utils/liveUpdates`（该 composable 只被 `views/DashboardView.vue:18`、`views/ScreenView.vue:5`、`pages/RankingsView.vue:5` 使用），不设任何 `setInterval`/`setTimeout`/`onUnmounted`，不写 localStorage/sessionStorage，不订阅 WebSocket。生成是**一次同步长请求**（`timeout: 0`），进度只靠 `indeterminate` 进度条示意；因此**没有需要清理的定时器或订阅**（§9）。

## 5. 输入与输出

### 5.1 props / model / emits

- **props：无**（`defineProps` 未出现）。唯一输入通道是 `defineModel<boolean>({ default: false })`（`:38`）——注意与 `ExcelImportDialog.vue:28` 的 `{ required: true }` 不同，本组件的 `v-model` 有默认值，父组件理论上可不传（实际唯一调用方传了）。
- **emits：`saved: [count: number]`**（`:39`），仅在 `data.saved > 0` 时触发一次（`:299`），载荷为后端实际入库题数。生成完成、取消、删除草稿、保存全失败均**不**触发。
- **`defineExpose`：无**——不向父组件暴露任何方法（对比 `ExcelImportDialog.vue:101`）。父页只能通过 `v-model` 开关与 `@saved` 回调交互。

### 5.2 出参：调用的 API 与后端路径

| 调用点 | `admin.ts` 函数 | 后端路径 | `response_model` | 权限 |
| --- | --- | --- | --- | --- |
| `:138`、`:200` | `generateAiQuestions(data, signal?)`（`admin.ts:697-703`；`timeout: 0`、`signal`、`silent: true`） | `POST /api/admin/ai/generate-questions`（`backend/app/api/routes/admin.py:568-589`） | `AdminAiGenerateOut` | `require_menu("questions")`（`admin.py:572`） |
| `:284` | `batchSaveAiQuestions(questions)`（`admin.ts:705-711`；`silent: true`，超时沿用默认 15s） | `POST /api/admin/ai/questions/batch-save`（`admin.py:592-606`） | `AdminAiBatchSaveOut` | `require_menu("questions")`（`admin.py:596`） |

请求体 `AiGeneratePayload`（`admin.ts:660-667`）= `topic` / `count` / `question_type` / `difficulty` / `category?` / `extra_requirements?`；后端 `AdminAiGenerateRequest`（`backend/app/schemas/schemas.py:1233-1245`）对应字段默认值 `count=10 (ge=1, le=100)`（`:1241`）、`question_type="single"`（`:1242`）、`difficulty="medium"`（`:1243`）、`category=""`（`:1244`）、`extra_requirements=""`（`:1245`），docstring（`:1236-1237`）明写「`question_type` 目前仅支持 single；`difficulty` 只作为生成提示词参数，不入库（questions 表无难度列）」。

响应 `AiGenerateResult`（`admin.ts:675-682`）= `requested` / `generated` / `valid_count` / `invalid_count` / `items: AiQuestionDraft[]` / `batch_errors: string[]`；`AiQuestionDraft`（`admin.ts:669-673`）= `index` / `data: QuestionUpsert` / `errors: string[]`。**本组件只消费 `items`、`batch_errors`、`generated` 三个字段**（`:149-155`），`requested`/`valid_count`/`invalid_count` 未使用（前端的 `validItems`/`invalidCount` 由本地重算，`:63-64`）。`AiQuestionDraft.index` 亦未使用（本地用 `nextKey` 另发 key，`:78`）。

保存响应 `AiBatchSaveResult`（`admin.ts:689-693`）= `saved` / `failed` / `failures: AiSaveFailure[]`。`QuestionUpsert`（`admin.ts:31-39`）= `type` / `question` / `options[{label,text}]` / `answer[]` / `analysis` / `score` / `category`。

### 5.3 错误码与呈现分工

- `generateAiQuestions`：400 = 参数非法（`ValueError`，`admin.py:588-589`）；502 = LLM 上游故障（`admin.py:585-587`，注释说明 `LlmError` 继承 `ValueError` 故先捕获——`c660727` 起异常类由 `CloudBaseError` 更名为 `LlmError`，定义于 `backend/app/services/llm_base.py:16-26`；`b712d81` 起上游由 `LLM_PROVIDER` 决定、可切换：`openai` = 阿里云百炼 / `cloudbase` = 腾讯云 CloudBase Agent，当前开发期为 cloudbase、上线切回 openai，502 语义对两家供应商一致）；401/403 = 令牌或菜单码问题。因 `silent: true`，`request.ts:46-48` 不弹 toast：`startGenerate` 走内联 `generateError` alert（`:372`），`regenerate` 走 `ElMessage.error`（`:219`）。401 仍会触发 `request.ts:35-45` 的 `clearAuth()` + 跳登录页（该分支不受 `silent` 抑制跳转，只抑制提示）。
- `batchSaveAiQuestions`：400 = 「没有需要保存的题目」/「单次最多保存 N 道题目」（`ai_question_service.py:356-360`）或写库异常兜底「保存失败，请稍后重试」（`ai_question_service.py:387-390`）；**单题校验失败不是 HTTP 错误**，而是 200 + `failures[]`（部分成功语义）。
- 加载态：`generating`（生成按钮 loading + 进度条 + 关闭按钮 disabled）、`saving`（表格 `v-loading` + 三个底部按钮 loading/disabled）、`regeneratingKey`（单行「重生成」按钮 loading）。
- 空态：`items` 为空时表格 `#empty`「题目草稿已全部处理完毕」（`:530-532`）；`phase === 'form'` 且未生成时只有表单与提示 alert。

## 6. 依赖关系

### 6.1 依赖

- `vue`：`computed`、`reactive`、`ref`、`watch`（`:4`）。
- `axios`：**值导入**（`:5`），用于 `axios.isAxiosError`（`:67`）与 `axios.isCancel`（`:157`）——这是本组件与 `ExcelImportDialog.vue:6`（仅类型导入）的差别。
- `element-plus`：值导入 `ElMessage`、`ElMessageBox`（`:6`）；类型导入 `TableInstance`（`:7`）；模板使用 `el-dialog`/`el-alert`/`el-form`/`el-form-item`/`el-input`/`el-radio-group`/`el-radio-button`/`el-radio`/`el-tag`/`el-select`/`el-option`/`el-progress`/`el-table`/`el-table-column`/`el-tooltip`/`el-button`/`el-input-number`/`el-empty`，均由 `admin/src/plugins/element-plus.ts` 注册；图标 `MagicStick`/`Delete`/`Plus` 以字符串传 `:icon`（`:542`、`:455`、`:460`），依赖 `main.ts` 全局图标注册。
- `../api/admin`：`batchSaveAiQuestions`、`generateAiQuestions`（`:8`）+ 类型 `AiQuestionDraft`、`AiSaveFailure`、`QuestionUpsert`（`:9`）。
- **不依赖**：`../api/request`（间接）、`../store/auth`、`../router`、`../utils/*`（既不用 `download.ts` 也不用 `liveUpdates.ts`）、`./ExcelImportDialog.vue`。

### 6.2 被谁依赖（全仓库 **1 个**调用方，grep `<AiGenerateDialog` 核实）

`admin/src/views/QuestionsView.vue`（题库维护，路由 `/questions`，`name: 'questions'`，`meta: { title: '题库维护', menu: 'questions' }`，`router/index.ts:51-54`）：

- import：`QuestionsView.vue:9`。
- 使用：`QuestionsView.vue:312` —— `<AiGenerateDialog v-model="aiVisible" @saved="handleAiSaved" />`，**实参只有 `v-model` 与 `@saved` 两项**（组件无 props，故不存在实参差异；与 `ExcelImportDialog` 在 `:299-310` 的 9 项传参形成对比）。
- 开关：工具栏「AI 智能出题」按钮（`QuestionsView.vue:251`，`MagicStick` 图标）置 `aiVisible = true`；`aiVisible` 声明于 `:219`。
- 回调：`handleAiSaved`（`QuestionsView.vue:220-227`，`:220` 注释「新题在列表末尾，回到第一页并清除筛选才能看到刚保存的题目」）清空 `filterType`/`filterCategory`/`appliedKeyword`/`keyword` 四个筛选后复用 `handleImported()`（`:212-216`）回首页刷新。**回调忽略了 `saved` 载荷**（形参为空），只用事件本身作刷新信号。

### 6.3 菜单码与权限

菜单码 `questions`（`router/menus.ts:8`，「题库维护」，图标 `EditPen`）。前端三层：侧边栏按 `hasMenu('questions')` 过滤（`.qoder/admin/src/layout/AdminLayout.vue.md` §4.1）、路由守卫拦 URL 直达（`.qoder/admin/src/router/index.ts.md`）、后端两个端点各自 `Depends(require_menu("questions"))`（`admin.py:572`、`:596`）。**本组件不做任何权限判断**，也无 `ai_*` 菜单码——Phase A 新增的 `ai_workshop` 等 5 个菜单码与本组件无关（`.qoder/backend/app/api/routes/ai_admin.py.md` §9「待开发」第 1、4 条）。

### 6.4 数据库表

旧链路**不新增表、不写任何中间态**：`generate_questions`（`backend/app/services/ai_question_service.py:309`）只调 `llm_service.prompt`（`:208`，经门面按 `LLM_PROVIDER` 分派到当前上游适配器）+ 校验 + 返回草稿，全程无 `db.add`/`commit`；`batch_save_questions`（`ai_question_service.py:349-392`）在单事务内写 `questions` 表，id 取 `max(id)+1` 连续显式分配（`:381-386`，注释说明该表无数据库自增）。Phase A 的 `ai_generation_jobs` / `ai_generated_questions` / `ai_knowledge` / `ai_usage_logs` 四张表**与本组件无关**（见 `.qoder/backend/app/api/routes/ai_admin.py.md` §6.3）。

## 7. 业务规则

1. **草稿不入库、不持久化**：生成结果只存在于组件内存的 `items`。关闭弹窗（`:316` `@closed`）、点「重新生成」并确认丢弃（`:177-188`）都会永久丢失；**刷新页面 / 关闭浏览器无法恢复**。这是与 Phase A「题目工坊」（草稿落 `ai_generated_questions` 表、可跨会话审核）的根本差别。
2. **保存必须显式勾选**：`:selectable` 排除有 `errors` 的行（`:428`），「保存选中」在无勾选时 disabled（`:552`），`handleSave` 再加一道 warning 兜底（`:277-280`）。**不存在「全部保存」入口**。
3. **后端不信任前端**：`batch_save_questions` 对每条重新跑 `_validate_question` + 库内/批内查重（`ai_question_service.py:366-378`，校验在 `:369`、查重在 `:373`），故前端校验只用于即时反馈（`:3` 注释、`:86` 注释）。前端 `errors` 非空但被绕过的行不会入库，会以 `failures[{index, reason}]` 回来。
4. **部分成功语义**：保存是「通过的入库、不通过的跳过并计入失败明细」，单事务写入、异常整体回滚（`ai_question_service.py:380-390`）。`failures.index` 从 1 起、相对于**本次提交的勾选数组**（不是表格序号）——因此 `:413` 显示的「第 N 条」在勾选子集或与表格顺序不一致时会对不上号（§9「存在问题」第 4 条）。
5. **库内重复标记的生命周期**：`dbDuplicate` 由后端 `errors` 中的特征串识别（`:80`、`:214`），仅在题干未被改动前保留（`:99` 比对 `baselineQuestion`）；一旦管理员改了题干，前端就不再报重复，**交由保存时后端重新查重**（`:369`）。这是「前端无法自查库内重复」的有意取舍（`:25` 注释）。
6. **无草稿状态机**：`DraftItem` 无 `status` 字段，前端只有二元「可保存 / 待修正」（由 `errors.length` 派生，`:511-514`）。后端 `DRAFT_STATUSES = ("pending","approved","rejected","imported")`（`ai_question_service.py:399`）属 Phase A 的 `ai_generated_questions` 表，**与本组件无任何交集**——旧链路的 `batch-save` 直接写 `questions`，不产生也不消费草稿状态。
7. **题型固定单选**：`question_type: 'single'` 硬编码（`:142`、`:202`），UI 以只读 tag 呈现并说明原因（`:342-343`）；与后端 `schemas.py:1236` docstring 的限定一致。
8. **难度不入库**：`difficulty` 只作为提示词参数（`:349` hint「难度仅用于约束生成，不作为题目属性入库」，后端 `schemas.py:1237`）。
9. **选项标签恒为 A/B/C… 连续**：增删选项后按位置重排（`:258`、`:269-271`），答案随标签迁移（`:272-273`）；上限 6、下限 2。
10. **取消只中断前端等待**：`abortController.abort()` 让 axios 抛取消错误、UI 显示「已取消本次生成，未产生任何题目。」（`:157-158`），但**后端不会因客户端断开而停止**——见 §9「存在问题」第 1 条。
11. **无幂等键**：连续两次「保存选中」若第一次已入库、第二次仍提交同样内容，会被后端查重拦下并计入 `failures`（不会重复入库），但用户看到的是「未通过后端校验」而非「已保存过」。
12. **上游供应商与生成参数口径（`c660727`/`b712d81` 后端演进，本组件无感知、契约零变化）**：上游由后端 `LLM_PROVIDER` 决定、可切换（`openai` = 阿里云百炼 / `cloudbase` = 腾讯云 CloudBase Agent），当前开发期为 cloudbase、上线部署前须切回 openai（门面 `backend/app/services/llm_service.py:1-22`）。分批大小取 `AI_QUESTION_BATCH_SIZE`：`backend/app/core/config.py:96` 默认 10，但当前 `backend/.env` 与 `.env.prod` 均实配 **5**（`.env` 注释明写「CloudBase 可承受 10 题/批，但此处不随供应商调整——保持『切换只改 LLM_PROVIDER 一行』」），即 ACP 口径下 100 题分 20 批。出题提示叠加 `LLM_QUESTION_EXTRA_BODY`（`enable_thinking`，恢复百炼思考模式以降低批次 JSON 解析失败率）；**ACP（cloudbase）无思考开关，该覆盖项被适配器忽略**（`llm_service.py:102-113`）。用量口径随供应商而异：openai 取 `usage.total_tokens`（与按量计费一致）；**CloudBase 取平台 `usage_update.used` 原值、含义未经核实，不可作计费依据**（`llm_base.py:28-40`）——且旧链路本就不写 `ai_usage_logs`，该用量口径只影响 Phase A 新链路。

## 8. 修改约束

- **不要在本组件里引入草稿持久化 / 状态机**：那属 Phase A 的 `ai_workshop` 题目工坊页（`/api/admin/ai/drafts*`，`.qoder/backend/app/api/routes/ai_admin.py.md` §4.4），应新建视图而不是改造本弹窗；旧链路被后端明确要求「保持不变」（`ai_question_service.py:394`）。
- **`revalidateAll` 的签名比对（`:110`、`:114-116`）不可删**：删掉即复现 `ea58b6c` 修掉的「结果面板 DOM 冻结在生成中」缺陷（深度 watcher 自触发 → Vue 递归更新超限中断整轮渲染，`docs/迭代记录.md` 的 `ea58b6c` 条目「缺陷修复」段）。同理，`SEP` 用 `\u0000` 而非普通分隔符也不能改（`:27-28`）。
- **`cloneData`（`:71-73`）必须保留**：直接把 `draft.data` 赋给 `items` 会让编辑器改动污染 `applyResult` 收到的原始响应对象；`options` 也要逐个浅拷贝，否则选项编辑会串改。
- **`generateAiQuestions` 的 `timeout: 0` 与 `silent: true` 不可去掉**（`admin.ts:695-702`，其上方注释即为此约束的说明）：100 道题按 `AI_QUESTION_BATCH_SIZE` 分批（`backend/app/core/config.py:96` 默认 10，当前 `.env`/`.env.prod` 实配 5，即 20 批）、并发 3（`config.py:97`）、单批超时 `LLM_TIMEOUT_SECONDS=300` 秒（`config.py:73`，两套供应商共用），默认 15s 必然超时；`silent` 去掉则错误会同时出现在全局 toast 与内联 alert 两处。
- **`failures.index` 的 1 起序号约定**（`:285-289` ↔ `ai_question_service.py:366`）是双端隐式契约，任一侧改成 0 起都会导致「成功行被当失败行剔除」或反之。
- **`question_type: 'single'` 硬编码**（`:142`、`:202`）：放开需同时改小程序答题逻辑与 `questions.type` 契约，不是前端单点改动。
- **`COUNTS`/`TOPIC_MAX_LEN` 与后端上限同源**：`COUNTS` 最大值 100 必须 ≤ 后端 `count le=100`（`schemas.py:1241`）与 `AI_QUESTION_MAX_COUNT = 100`（`config.py:98`），否则保存会整批 400。改后端上限时须同步改本文件（当前是双端各写一份，§9「存在问题」第 6 条）。
- **`LABELS`/`CATEGORIES` 与 `QuestionsView.vue:11-16` 逐字重复**：改分类枚举要同时改两处（外加后端 `admin_service.py:215` 的白名单），属已知重复定义。
- **`@closed` 钩子（`:316` → `:170-173`）是唯一的资源清理点**：本组件无 `onUnmounted`；若将来加定时器/订阅，必须在此处或 `onUnmounted` 补齐清理。
- 视觉：`.pane{min-height:320px}` 与 `width="92%" top="4vh"` 共同保证两阶段切换不跳动、长表格可用；`.summary` 的 `flex-wrap` 是窄屏可用性的落点（`admin/agents.md`「开发约定」第 3 条）。
- 修改后按 `.qoder/README.md` §3 第 4 条更新本文档 §4/§7/§9/§10；验证须按 `admin/agents.md`「必做验证」跑 `npm run build` + 浏览器真实交互（生成/取消/编辑/勾选/保存/失败明细六条路径），并注意**真实生成会消耗当前 `LLM_PROVIDER` 上游的额度/Token**（`openai` = 阿里云百炼按量计费、`cloudbase` = 腾讯云 CloudBase Agent 额度；当前开发期为 cloudbase，上线切回 openai，口径见 §7 第 12 条）。

## 9. 当前实现状态

**已实现（`ea58b6c` 起未再改动，`git log --follow` 仅 1 个提交）**

1. 参数表单（主题 / 数量 / 难度 / 分类 / 补充要求，题型固定单选）、生成中可取消、草稿表格审核、展开行逐题编辑（题干 / 选项增删改 / 答案 / 解析 / 分类 / 分值）、单题重生成、单行删除、批量删除勾选、全选可用、勾选批量保存、批次级与单题级两类失败明细——全部可用。
2. 前端实时校验 + 深度 watcher 递归更新缺陷已修（`:106-116`）。
3. 验收：`docs/迭代记录.md` 的 `ea58b6c` 条目「验证」段——后端冒烟 `test/s25_ai_question_generate.py` 16/16、admin `npm run build` 通过、浏览器真机验收 10 项全通过（AI 生成 10 题 → 编辑校验 → 删草稿 → 全选 → 保存 8 题（列表 15→23）→ 取消生成提示 → Excel 导入 2 题（总数 25）），截图 `admin/test/images/s26-01~09`，报告 `admin/test/docs/s26-ai-question-admin-report.md`、`backend/test/docs/s26-ai-question-backend-report.md`。
4. **Phase A 边界的如实结论**：管理端 AI 能力目前**只有本弹窗这一处已落地**，且它走旧链路、挂 `questions` 菜单；Phase A 的 5 个 AI 子页面（知识库 / 题目工坊 / 配置中心 / 运行概览 / 调用记录）在管理端**全部待开发**——`router/menus.ts`（11 项，无 `ai_*`）、`admin/src/api/admin.ts`（除 `:698`、`:707` 两个旧链路外无任何 `/admin/ai/*` 封装）、`admin/src/views/`（无 AI 视图）三处一致（grep 核实）。此前「管理端 AI 页面待开发」的记载**并不指本组件**，指的就是这 5 个子页面（`.qoder/backend/app/api/routes/ai_admin.py.md` §9「待开发」第 1 条）。

**存在问题 / 风险（均为源码可证的现状事实，未修）**

1. **取消后存在「孤儿计算」，但不存在「孤儿任务记录」。** `abortController.abort()` 只中断前端 axios 等待；`ai_generate_questions` 是同步端点（`admin.py:574-589`），客户端断开不会中止服务端执行，`_run_batches`（`ai_question_service.py:214-253`，调用点 `:324-326`）会继续跑完全部批次、继续消耗当前 `LLM_PROVIDER` 上游的额度/Token，然后丢弃结果。由于旧链路**不写 `ai_generation_jobs`、不写 `ai_usage_logs`**（`generate_questions` 全程无 `db.add`/`commit`，grep 核实），这次消耗在数据库与审计里**完全不可观测**。`:171` 注释声称「避免后端继续消耗 Agent 额度」与后端实际行为**不符**（同一结论亦见 `.qoder/backend/app/api/routes/ai_admin.py.md` §9「存在问题」第 6 条，那里针对的是新链路 `POST /jobs`）。`count=100` 时最坏约 7 轮 × 300s（按当前 env 实配 5 题/批 = 20 批、并发 3、单批超时 `LLM_TIMEOUT_SECONDS=300`）。
2. **弹窗关闭不重置状态**：无 `destroy-on-close`（`:309-317`）、无 `watch(visible)`，故关闭后重开会看到上次的 `phase`、`form`、`items`（含未保存草稿）原样恢复。可解读为「防误关丢草稿」的有意设计（与 `:close-on-click-modal="false"` 一致），但与 `ExcelImportDialog.vue:37-41` 的「打开即复位」相反；**是否有意待确认**。副作用：`nextKey`（`:52`）单调递增不复位（无害），以及用户可能在不知情的情况下把上次会话的旧草稿保存入库。
3. **`regenerate` 不在取消链路内**：`:200-207` 不传 `signal`，`abortController` 在此期间为 `null`，故 `handleClosed`（`:170-173`）无法中断它；关闭弹窗后重生成的响应仍会写回 `item.data`（`:213-215`）——若此前已 `backToForm` 清空 `items`，写入的是脱离表格的游离对象（无异常，但请求与额度白耗）。`regenerate` 也无重入锁（只有行级 loading `:522`，用户可同时对多行点「重生成」并发多个请求）。
4. **`saveFailures` 的「第 N 条」易误读**：`f.index` 相对于本次提交的勾选数组（`:285-289`、`ai_question_service.py:362`），而 alert 文案（`:409`、`:413`）未说明这一点；当用户只勾选了部分行时，「第 3 条」并不等于表格第 3 行。
5. **前后端校验口径不完全一致**（`:86` 注释自称「同口径」，实际有出入）：前端多一条「选项内容不能为空」（`:93`），后端 `_validate_question` 不查（`admin_service.py:208-233` 无对应分支）；前端不查 `type`（后端 `:210-211`）与 `category` 白名单（后端 `:214-216`）——若 AI 返回的 `category` 不在 `event/route/figure` 内，前端标「可保存」、后端保存时判失败进 `failures`。此外 `batchSaveAiQuestions` 未设 `timeout: 0`（`admin.ts:705-711`），100 题保存沿用 15s 默认超时，是否够用**待确认**（后端保存路径无外部调用，通常远快于生成）。
6. **双端重复定义取值范围**：`COUNTS = [10,20,50,100]`（`:12`）、`TOPIC_MAX_LEN = 100`（`:13`）、`DIFFICULTIES`（`:14-19`）、`CATEGORIES`（`:20-24`）全部硬编码，而后端 Phase A 已提供 `GET /api/admin/ai/config` 下发 `values/defaults/ranges/prompts`（`AdminAiConfigOut`，`backend/app/schemas/schemas.py:1925`；`.qoder/backend/app/api/routes/ai_admin.py.md` §5.1、§4.5），`admin.ts` 无对应封装、本组件未消费。同时后端约束散落在 `schemas.py:1241`（`count le=100`）与 `config.py:98`（`AI_QUESTION_MAX_COUNT = 100`）。属**双端（且后端内部两处）重复定义**，改上限需人工同步 3 处。
7. **`removeSelected` 未 catch 取消**（`:229-238`）：用户在确认框点「取消」会产生一次未处理的 Promise rejection；同文件 `backToForm` 已用 `.catch(() => undefined)`（`:189`）处理同类情况，两处不一致。
8. **`reserve-selection` + 直接改 `items` 的选中项残留风险**：表格开了 `row-key="key"`（`:423`）与 `reserve-selection`（`:428`），而 `removeItem`（`:225-227`）与 `removeSelected`（`:236-237`）只过滤 `items`、不调 `clearSelection()`（只有 `applyResult:125`、`handleSave:292`、`selectAllValid:241` 调了）。Element Plus 在该模式下按 rowKey 保留选中项，被移除的行是否残留在 `selection` 中取决于组件内部实现（第三方产物未核）→ **待确认**；若残留，「保存选中（N）」的计数会虚高，且 `handleSave` 会把已删除的草稿一并提交（后端会因查重/校验拦下并计入 `failures`，不会脏写）。
9. **深度 watcher 的 O(n²) 重算**：`watch(items, revalidateAll, { deep: true })`（`:118`）在展开行编辑器里每敲一个字就全量重算，而 `validateItem` 内含 `items.value.some(...)`（`:100`）→ 单次击键 O(n²)。`count=100` 时约 1 万次字符串比较/击键；配合 `:110` 的签名比对可避免无限递归，但仍是可感的输入延迟风险（根 `agents.md` §2.4「大数据量性能保障」）。未实测，**待确认**实际卡顿程度。
10. **无真实进度**：`el-progress :percentage="100" :indeterminate="true"`（`:369`）只是动画，后端不提供进度查询端点（旧链路无 job 记录）；100 题需等 1~2 分钟（`:339` hint 已如实告知用户）。

**待开发**：本组件自身无待开发项；管理端 AI 的 5 个子页面待开发（见上「已实现」第 4 条）。

**待确认清单**：① 弹窗状态不重置是否有意（第 2 条）；② `reserve-selection` 下删除行的选中残留（第 8 条）；③ 100 题保存 15s 超时是否够用（第 5 条）；④ 深度 watcher 的实际输入延迟（第 9 条）；⑤ 旧链路与新工坊长期并存还是最终收敛（`.qoder/backend/app/api/routes/ai_admin.py.md` §9「待确认」第 2 条，代码与文档均无说明）。

## 10. 迭代记录

数据来源：`git log --follow --format="%h|%ad|%s" --date=short -- admin/src/components/AiGenerateDialog.vue`，共 **1 个提交**（本文件自创建以来未被修改过）。

### 2026-10-22（文档同步，admin 源码零改动）
- 需求：偿还 `.qoder/` 文档欠账——`c660727`（2026-10-19，AI 上游由腾讯云 CloudBase Agent 单向迁至阿里云百炼，`cloudbase_service.py`→`llm_service.py`、`CloudBaseError`→`LlmError`、配置 `CLOUDBASE_*`→`LLM_*`）与 `b712d81`（2026-10-22，上游改为按 `LLM_PROVIDER` 可切换的双供应商门面：`llm_service.py` 分派 `llm_openai.py`/`llm_cloudbase.py`，共享类型在 `llm_base.py`）之后，本文档仍写「502 = CloudBase 上游故障（`CloudBaseError`）」「消耗 CloudBase Agent 额度」等过期表述。本次 admin 源码未改、接口契约（请求/响应字段）零变化，属纯文档同步。
- 修改内容：① §2/§5.3/§8/§9 的上游表述改为「由后端 `LLM_PROVIDER` 决定、可切换（`openai` = 阿里云百炼 / `cloudbase` = 腾讯云 CloudBase Agent），当前开发期为 cloudbase、上线部署前切回 openai」；② 502 错误码改注 `LlmError`（`admin.py:585-587`，实读核实）；③ 校正随后端演进漂移的行号引用（`admin.py` AI 段 `:568-606`、`ai_question_service.py:214-399`、`schemas.py:1233-1280`/`:1925`、`config.py:73`/`:96-98`）；④ §4.7 为源码 info alert 的「腾讯云 CloudBase Agent」硬编码 UI 文案加括注（原文照抄未改；`LLM_PROVIDER=openai` 时与实际供应商不符，是否另开任务改 UI 文案待用户定夺）；⑤ §7 新增第 12 条，如实记录 ACP 口径：`AI_QUESTION_BATCH_SIZE` 当前两份 env 实配 5（不随供应商调整）、`LLM_QUESTION_EXTRA_BODY` 思考开关在 cloudbase 下被适配器忽略、CloudBase 用量数值（`usage_update.used` 原值）不可作计费依据。
- 关联文件：仅本文档（核实依据：`backend/app/api/routes/admin.py:566-606`、`backend/app/services/llm_service.py`、`llm_base.py`、`ai_question_service.py:204-399`、`backend/app/core/config.py:70-98`、`backend/.env`/`backend/.env.prod` 只读键名、`admin/src/components/AiGenerateDialog.vue:322`）。
- 测试结果：只读核对，未执行构建、未调用任何 AI 接口（本次任务明确禁止）。

### 2026-10-17（文档建档）
- 需求：补齐 `.qoder/admin/**` 文件级文档（第三批）。
- 修改内容：新建本文档，逐行核对源码 658 行、唯一调用方 `QuestionsView.vue:312` 的实参、两个后端端点与权限、前后端校验口径差异、取消链路与旧/新链路边界。
- 关联文件：`admin/src/components/AiGenerateDialog.vue`、`admin/src/views/QuestionsView.vue`、`admin/src/api/admin.ts`、`admin/src/api/request.ts`、`admin/src/router/index.ts`、`admin/src/router/menus.ts`、`backend/app/api/routes/admin.py`、`backend/app/services/ai_question_service.py`、`backend/app/services/admin_service.py`、`backend/app/schemas/schemas.py`、`backend/app/core/config.py`。
- 测试结果：只读核对，未执行构建、未启动 dev server、未调用任何 AI 接口（本次任务明确禁止）。

### 2026-10-16（`ea58b6c`，23:19）
- 需求：题库接入 CloudBase Agent AI 出题，草稿审核后入库。
- 修改内容（涉本文件）：**新建**本组件（658 行）——题库页新增「AI 智能出题」按钮与近全屏宽弹窗，实现「表单 → 生成中可取消 → 结果预览：逐题编辑 / 删选项 / 单题重生 / 勾选批量保存」，前端实时校验题干为空、选项不足 2、答案缺失或非法、草稿内与库内重复；保存后由父页回列表首页并清筛选。同批修复缺陷：结果面板 DOM 冻结在「生成中」而组件状态已是 `phase=result`——`watch(items, revalidateAll, { deep: true })` 每次写回全新 `errors` 数组再次触发自身深度监听，Vue 递归更新超限中断整轮渲染；改为按签名比对、结果未变化不写回（`:106-116`）。
- 关联文件：`admin/src/views/QuestionsView.vue`（按钮 + 调用方 + `handleAiSaved`）、`admin/src/api/admin.ts`（`generateAiQuestions`/`batchSaveAiQuestions` 与 5 个 AI 类型）、`admin/src/main.ts`（`MagicStick` 图标）、`backend/app/api/routes/admin.py:500`/`:524`、`backend/app/services/ai_question_service.py`、`backend/app/services/cloudbase_service.py`、`backend/app/schemas/schemas.py`。**原有 Excel 批量导入、模板下载、题目增删改查全部保留未改动**（`ExcelImportDialog.vue` 无本次提交记录）。
- 测试结果：见 `docs/迭代记录.md` 的 `ea58b6c` 条目（后端冒烟 16/16、`npm run build` 通过、浏览器真机验收 10/10，无任何数据库结构或数据变更）。**注意**：该条目正文把批量保存端点写作 `POST /api/admin/questions/batch-ai`，与实际源码 `admin.ts:707`、`backend/app/api/routes/admin.py:525` 的 `/api/admin/ai/questions/batch-save` 不符（`git log -S 'batch-ai'` 全仓库零命中，说明该路径从未存在过），属台账笔误；按 `.qoder/README.md` §3 第 11 条不在本文档内改写历史，仅在此注明更正依据。
