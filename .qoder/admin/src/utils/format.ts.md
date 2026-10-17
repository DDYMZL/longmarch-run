# format.ts

## 1. 文件路径

`admin/src/utils/format.ts`（46 行）

## 2. 文件职责

管理后台**统一的时间/数字展示格式化**工具：模块级复用 `Intl.DateTimeFormat`/`Intl.NumberFormat` 实例（注释 `:1`：表格大量行渲染时避免逐格新建），导出 `formatTime`（短时分）、`formatDateTime`（完整日期时间，可选带秒与空值占位）、`formatNumber`（zh-CN 千分位）3 个函数，并内置私有的 `parseUtc` 统一「后端 naive ISO 时间串按 UTC 解释」的时区约定（`:2`、`:29-31`）。

## 3. 业务需求

- 出自 `30b4458`（管理后台代码审查修复）：此前 `formatTime`/`formatNumber` 混在 `utils/liveUpdates.ts` 里（`01ec93c` 引入），排名、组织、审计各页又各自 `new Intl.DateTimeFormat`/`toLocaleString`，重复且逐格新建实例有渲染性能开销（报告 `admin/test/docs/s16-admin-review-fixes-report.md` A2 项）。本文件是「统一格式化 + 实例复用」的收口产物。
- 审计日志本地化展示（同提交「审计时间本地化」）：后端存 UTC，管理端按浏览器本地时区展示，秒级精度（`AuditView.vue:121` 以 `seconds = true` 调用）。

## 4. 核心功能

### 4.1 模块级 Intl 实例（`:3-27`）

| 实例 | 行号 | 格式（zh-CN，24 小时制） |
|---|---|---|
| `SHORT_TIME` | `:3-9` | `MM/DD HH:mm` |
| `FULL_TIME` | `:10-17` | `YYYY/MM/DD HH:mm` |
| `FULL_TIME_SECONDS` | `:18-26` | `YYYY/MM/DD HH:mm:ss` |
| `NUMBER` | `:27` | `Intl.NumberFormat('zh-CN')`，千分位分组 |

### 4.2 私有 `parseUtc(value)`（`:29-31`）

时区约定核心：字符串已带 `Z` 或 `±HH:MM` 后缀时按原样解析；否则（后端返回的 **UTC naive ISO**，如 `2026-10-11T10:30:00`）**补 `Z` 后缀**再解析，保证按 UTC 时刻换算到浏览器本地时区展示。注释 `:2`：与小程序 `frontend/utils/util.js` 的 `formatTime` 同一约定；`admin/design.md` §时间处理同文记载。该约定同时兼容个别带 `+08:00` 后缀的字段（如活动设置 `start_at`/`end_at`，见 `.qoder/admin/src/api/admin.ts.md` §4.10）——带后缀则不补 `Z`，按原偏移解析。

### 4.3 `formatTime(value)`（`:34-36`）

`MM/DD HH:mm` 短时格式；`null`/`undefined`/空串返回 `''`。用于实时动态流的时间列（驾驶舱/大屏）。

### 4.4 `formatDateTime(value, empty = '—', seconds = false)`（`:39-42`）

完整日期时间；空值返回 `empty`（默认长破折号 `—`，可自定义，如 `RankingsView.vue:69` 传 `'尚未到达'`）；`seconds = true` 用带秒实例（审计日志、活动设置「最近修改」）。

### 4.5 `formatNumber(value)`（`:44-46`）

zh-CN 千分位数字格式化，用于步数/人数等大数值指标卡与表格列。

## 5. 输入与输出

- 时间函数入参类型 `string | null | undefined`：**ISO 8601 字符串**（后端 snake_case 字段原样传入，如 `created_at`/`event_time`/`expires_at`），无值返回占位串，不抛错。
- `formatNumber` 入参 `number`，返回千分位字符串。
- **异常边界**：非空但非法的时间串经 `parseUtc` 得 `Invalid Date`，`Intl.DateTimeFormat.format` 会抛 `RangeError`，本文件未捕获——依赖后端始终返回合法 ISO 串（现状成立：REST 由 SQLAlchemy datetime 序列化、WS 由 `backend/app/core/ws.py:18-20` `utcnow().isoformat()` 生成，均为 naive ISO）。

## 6. 依赖关系

- **依赖**：无（零 import，仅浏览器/Node 内置 `Intl`）。
- **上游数据格式**：后端管理端接口全部 snake_case、时间为 UTC naive ISO（`admin/design.md` 时间处理段；`.qoder/ARCHITECTURE.md` §4.2 双命名契约）；WS 推送的 `at` 字段同为 naive ISO（`backend/app/core/ws.py:18-20`），经 `liveUpdates.ts:44` 转成 `ActivityItem.event_time` 后仍由本文件 `formatTime` 展示。
- **被依赖**（grep `admin/src` 实测，3 个导出全部有调用方，**无死导出**）：
  - `formatTime`：`DashboardView.vue:19`（`:205` 动态流时间列）、`ScreenView.vue:6`（`:107` 同）。
  - `formatDateTime`：`AuditView.vue:6`（`:121`，带秒）、`AccessView.vue:20`（`:352`）、`OrgsView.vue:9`（`:335`）、`ActivityView.vue:7`（`:188`、`:190`，后者带秒）、`InvitesView.vue:14`（`:234`、`:258`）、`RankingsView.vue:6`（`:69` 包装为「尚未到达」占位的 `time()`）。
  - `formatNumber`：`DashboardView.vue:19`（`:176`、`:224`）、`ScreenView.vue:6`（`:66`、`:79`、`:85`、`:95`）、`RankingsView.vue:6`（别名 `number` 导入）。

## 7. 业务规则

1. **UTC naive → 本地时区**是全项目统一展示约定（管理端本文件、小程序 `frontend/utils/util.js`），任何一侧改成「按本地解释 naive 串」都会造成两端时间差 8 小时。
2. 带时区后缀（`Z`/`±HH:MM`）的字符串**不得再补 `Z`**（`parseUtc` 的正则判别），否则带 `+08:00` 的活动时间会被错误平移。
3. `Intl` 实例必须保持模块级单例（`:1` 注释的性能动机）；新页面格式化时间/数字必须复用本文件导出，不得在页面内自建 `Intl` 实例或 `toLocaleString`（`30b4458` 收口前的状态即反面案例）。
4. 展示精度约定：动态流/大屏用分（`formatTime`），常规列表用分（`formatDateTime`），审计与「最近修改」用秒（`seconds = true`）。

## 8. 修改约束

1. `parseUtc` 的补 `Z` 规则是前后端隐式契约的一部分：后端若改为返回带时区后缀的时间（如统一 `+00:00`），本文件无需改；后端若改为返回**本地**时间，则必须同步改这里并连带核对小程序侧，属跨端破坏性变更。
2. 三个导出签名被 8 个视图/页面直接消费（§6），增参可以（保持默认值兼容），改名/改语义需全量同步调用方。
3. 不得把本文件函数改为返回 `Date` 对象或引入 dayjs 等依赖——现状零依赖是刻意选择（`30b4458` 审查方向即去冗余）。
4. 修改后按 `admin/agents.md`「必做验证」执行 `npm run build` + 浏览器核对审计/组织/邀请/活动等页时间列显示。

## 9. 当前实现状态

- **已实现**：3 个导出 + 4 个模块级实例 + 私有 `parseUtc`；逐名 grep `admin/src` 实测 **0 个死导出**（每个导出 ≥2 个调用文件）。
- **已知边界（非缺陷，登记备查）**：非法时间串会使 `Intl.format` 抛 `RangeError` 且未捕获（§5）；现状后端不产生非法串，若未来接入外部数据源需评估。
- **待确认**：无（本文件所有结论均有代码/grep/git 证据）。

## 10. 迭代记录

数据来源：`git log --follow --format='%h | %ad | %s' --date=format:'%Y-%m-%d %H:%M' -- admin/src/utils/format.ts`，共 **1 个提交**（创建后未再修改），在 `docs/迭代记录.md` 有对应条目。按时间倒序。

### 2026-10-11（`30b4458`，18:30）
- 需求：管理后台代码审查修复（逻辑/冗余/大数据量性能）——统一格式化、消除各页重复的 `Intl` 实例与 `toLocaleString`。
- 修改内容：**创建本文件**——把原在 `utils/liveUpdates.ts`（`01ec93c` 引入）的 `formatTime`/`formatNumber` 迁出，并新增 `formatDateTime`（空值占位 + 可选秒）与带秒实例；`parseUtc` 沿用「naive ISO 补 `Z`」约定。同提交将审计日志改为本地时间显示（`AuditView` 调用 `seconds = true`）。
- 关联文件：`admin/src/utils/liveUpdates.ts`（迁出方）、`AuditView.vue`、`AccessView.vue`、`OrgsView.vue`、`DashboardView.vue`、`ScreenView.vue`、`RankingsView.vue`；报告 `admin/test/docs/s16-admin-review-fixes-report.md`。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目（`npm run build` 通过，浏览器验收含审计本地时间）。
