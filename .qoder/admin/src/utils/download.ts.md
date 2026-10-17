# download.ts

## 1. 文件路径

`admin/src/utils/download.ts`（23 行）

## 2. 文件职责

管理后台的**浏览器落盘与 CSV 安全工具**：提供 3 个导出——`saveFile`（把接口返回的 Blob 或前端拼接的文本保存为本地文件，`:2-10`）、`csvCell`（前端拼 CSV 时的单元格转义 + 防公式注入，`:13-17`）、`today`（本地时区 `YYYY-MM-DD`，用于导出文件名，`:20-23`）。全文件零依赖、零状态，纯函数集合。

## 3. 业务需求

- `admin/agents.md`「开发约定」第 4 条：**导出包含用户文本时必须防止 CSV 公式注入**——`csvCell` 是该约定在前端侧的唯一落点（后端侧对应 `backend/app/services/admin_service.py:423-426` 的 `_csv_text`，分工见 §7.2）。
- 排名洞察流式导出（V2.0，`b5d6035`）：后端返回 CSV Blob，前端需统一落盘逻辑，本文件随该需求创建，同时删除了 RankingsView 页面内此前手写的 Blob 下载与 CSV 拼接代码。
- Excel 导入的错误报告下载（`30b4458` 代码审查「题库的下载与 CSV 逻辑复用 utils/download」）：导入预览失败的错误清单由前端拼 CSV 落盘。

## 4. 核心功能

### 4.1 `saveFile(data, filename, type?)`（`:2-10`）

统一落盘：`data` 为 Blob（接口 `responseType: 'blob'` 的返回值）时直接使用，为字符串时以 `type`（默认 `application/octet-stream`）包成 Blob（`:3`）；`URL.createObjectURL` 建临时链接（`:4`），动态创建 `<a>` 设置 `href`/`download` 后 `click()` 触发下载（`:5-8`），随即 `URL.revokeObjectURL(url)` 释放（`:9`）——**创建与释放成对，无 Blob URL 泄漏**（释放紧跟 click，依赖浏览器在 click 时已排队下载；管理后台验收环境为 Chromium 系浏览器，未见兼容问题，其他内核是否有提前释放风险**待确认**）。

### 4.2 `csvCell(value)`（`:13-17`）

CSV 单元格安全转义，两步：

1. **防公式注入**（`:15`）：文本以 `=`、`+`、`-`、`@` 四个字符之一开头时（正则 `/^[=+\-@]/`）加前导单引号 `'`，使 Excel/WPS 按文本而非公式求值；`null`/`undefined` 先归一为空串（`:14`）。
2. **CSV 引用转义**（`:16`）：整体包双引号，内部双引号翻倍（`"` → `""`），值含逗号/换行也安全。

覆盖边界：只匹配**首字符**，不处理「前导空白 + `=`」或制表符开头的变体，也不拦截字符串中部的危险序列（CSV 语义下中部字符不构成公式）；未对前导 `'` 做递归处理（值本身以 `'=` 开头时不再叠加）。

### 4.3 `today()`（`:20-23`）

返回**本地时区**当天日期 `YYYY-MM-DD`（月/日补零）。注释 `:19` 说明动机：`toISOString()` 是 UTC，东八区凌晨导出会得到前一天的日期，故手工用 `getFullYear/getMonth/getDate` 拼接。

## 5. 输入与输出

| 导出 | 入参 | 返回 |
|---|---|---|
| `saveFile` | `data: Blob \| string`；`filename: string`；`type = 'application/octet-stream'` | 无返回值；副作用为触发浏览器下载 |
| `csvCell` | `value: unknown` | `string`：带双引号包裹的安全 CSV 单元格文本 |
| `today` | 无 | `string`：如 `2026-10-11` |

三者均不抛业务异常、无错误码；`saveFile` 在浏览器禁用下载等场景的行为由浏览器决定，本文件不感知成败。

## 6. 依赖关系

- **依赖**：无（零 import，仅用浏览器原生 `Blob`/`URL`/`document`）。
- **被依赖**（grep `admin/src` 实测，仅 2 个文件、覆盖全部 3 个导出）：
  - `admin/src/pages/RankingsView.vue:7` 导入 `saveFile`/`today`；`:75-76` 将 `exportRankings`（`.qoder/admin/src/api/admin.ts.md` §4.3，`responseType: 'blob'` + `timeout: 0`）返回的 CSV Blob 落盘为 `全员长征排名_<today()>.csv`。该 CSV 的防注入由**后端**完成（§7.2），前端只做保存。
  - `admin/src/components/ExcelImportDialog.vue:8` 导入全部 3 个；`:90` 保存模板下载 Blob；`:97-98` 将导入错误清单（Excel行号/出错字段/错误原因）逐格过 `csvCell`、`\r\n` 连接、前置 `\uFEFF` BOM 后以 `text/csv;charset=utf-8` 落盘为 `<reportPrefix>_<today()>.csv`。
- **同源逻辑（另一端）**：`backend/app/services/admin_service.py:423-426` `_csv_text`（详见 §7.2），文档见 `.qoder/backend/app/services/admin_service.py.md`。

## 7. 业务规则

1. **CSV 防公式注入危险字符集为 `= + - @` 首字符**，处理手法是**前缀单引号**（非制表符、非改字符）；前后端两侧使用同一字符集。
2. **前后端职责分工明确，不属重复实现**（根 `agents.md` §2.2）：谁生成 CSV 谁负责转义——后端流式生成的排名导出 CSV 在 `admin_service.py` 内用 `_csv_text` 转义（`:454`、`:471-474`，配合 `csv.writer` 完成引用转义，BOM 在 `:456`）；前端拼接的导入错误报告 CSV 用 `csvCell` 转义（`ExcelImportDialog.vue:97`）。两处运行时不同（Python / 浏览器），无法共享代码。差异：`csvCell` 额外承担双引号包裹与 `""` 翻倍（因为前端是手工 `join(',')`，无 csv writer），`_csv_text` 只做前缀（引用转义交给 `csv.writer`）。
3. **导出文件名日期用本地时区**（`today()`），不得改回 `toISOString().slice(0,10)`（凌晨会差一天，`:19` 注释即此教训）。
4. 前端落盘的 CSV 需自带 `\uFEFF` BOM 才能在 Excel 正确识别 UTF-8——由调用方添加（`ExcelImportDialog.vue:98`），`saveFile` 本身不加。

## 8. 修改约束

1. `csvCell` 的危险字符集与前缀手法如需调整，必须与后端 `admin_service.py:423-426` `_csv_text` 同步评估（同一业务规则的两端实现），并遵守 `admin/agents.md` 的防注入约定。
2. `saveFile` 的 `URL.createObjectURL`/`revokeObjectURL` 成对关系不得破坏（去掉 `:9` 即内存泄漏）；新增 Blob 下载场景必须复用本函数，不得在页面内另写一份（`b5d6035`/`30b4458` 两次重构的目的即收口重复实现）。
3. 三个导出的签名被 `RankingsView.vue` 与 `ExcelImportDialog.vue` 直接消费，改动签名属破坏性变更，需同步两处调用方。
4. 修改后按 `admin/agents.md`「必做验证」执行 `npm run build` + 浏览器实测导出/下载。

## 9. 当前实现状态

- **已实现**：3 个导出全部有调用方（逐名 grep `admin/src` 实测，**无死导出**）；Blob URL 创建/释放成对（`:4`/`:9`）。
- **已知边界（非缺陷，登记备查）**：
  1. `csvCell` 仅拦截首字符命中 `= + - @` 的文本，「前导空白/制表符 + 公式字符」的变体不在覆盖范围（`:15` 正则实测）；后端 `_csv_text` 同样只看首字符（`text[:1]`），两端口径一致。
  2. `saveFile` 在 `click()` 后立即 `revokeObjectURL`（`:8-9`），依赖浏览器已排队下载；Chromium 系验收环境未见问题，非 Chromium 内核兼容性**待确认**。
- **待确认**：除上述两条外无。

## 10. 迭代记录

数据来源：`git log --follow --format='%h | %ad | %s' --date=format:'%Y-%m-%d %H:%M' -- admin/src/utils/download.ts`，共 **1 个提交**（创建后未再修改），在 `docs/迭代记录.md` 有对应条目。按时间倒序。

### 2026-10-11（`b5d6035`，17:55）
- 需求：排名洞察改服务端分页/筛选与流式 CSV 导出（性能优化，人员量大时不再全量加载与前端渲染）。
- 修改内容：**创建本文件**——新增 `saveFile`/`csvCell`/`today`；删除 RankingsView 页面内的全量过滤、前端拼 CSV 代码。同日 `30b4458`（管理后台代码审查修复）将题库导入的模板下载与错误报告 CSV 逻辑也收口到本文件（该提交未改动本文件源码，改的是调用方）。
- 关联文件：`admin/src/pages/RankingsView.vue`、`admin/src/api/admin.ts`（`exportRankings`）、`backend/app/services/admin_service.py`（`_csv_text`/流式导出）、`backend/app/api/routes/admin.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `b5d6035` 条目（新旧实现对照 92 人逐字段相等、浏览器验收导出 19 人通过）与 `30b4458` 条目。
