# quote.js

## 1. 文件路径

`frontend/services/quote.js`（16 行）

## 2. 文件职责

「每日寄语」服务层薄封装：仅「今日寄语」一个只读函数，取有出处的史料语录（可关联路线节点），docstring `frontend/services/quote.js:1-3`。

## 3. 业务需求

- 需求 §16「每日寄语」（docstring `:2` 标注）。P2-1 批次「每日寄语与节点纪念票」交付（提交 `71d1b9b`，`docs/迭代记录.md` 的 `71d1b9b` 条目），本文件由该提交创建。
- `d6acf7e` 批次「每日寄语改为排序号+启用状态按天循环展示」演进展示规则（`docs/迭代记录.md` 的 `d6acf7e` 条目；该条目范围列为 backend、admin、docker、docs，但 `git log --follow` 显示本文件亦被该提交触及，据现 docstring `:7` 与新规则一致，推断为口径注释更新，具体 diff 未逐行核对）。

## 4. 核心功能

| 函数 | 行号 | 后端接口 | 说明 |
|---|---|---|---|
| `getToday()` | `:10-12` | `GET /api/quotes/today` | 今日寄语；后台启用寄语按排序号每天轮换一条（同一天所有用户相同），无启用寄语返回 null（docstring `:7`） |

请求经 `services/request.js`（`:4`），URL 拼接为 `API_BASE_URL + opts.url`（`frontend/services/request.js:69`）。

## 5. 输入与输出

- `getToday()`：无参；返回 `{id, date, content, source, node:?{id, name}} | null`（JSDoc `:8`）——`node` 为可关联的路线节点，null 表示后台未配置启用寄语。
- 异常：由 request.js 统一 reject（401 静默重登重试一次，`frontend/services/request.js:122-123`）；唯一调用方已 catch 降级（§6）。

## 6. 依赖关系

- 依赖：仅 `services/request.js`（`:4`）。**无本地缓存**（不经 `services/store.js`）；「每天轮换一条」的日期口径在后端计算。
- 被依赖（grep `services/quote`）：仅 `frontend/pages/home/home.js:14`（`:165` `getToday().catch(() => null)`，首页寄语卡，失败不展示、不阻塞首屏）。
- 后端契约文档：`.qoder/backend/app/api/routes/quotes.py.md`。

## 7. 业务规则

1. 轮换规则（排序号 + 启用状态 + 按天循环、起始日期可配置）全在后端与后台管理端维护（`d6acf7e` 提交信息），前端不实现任何轮换/随机逻辑，也不得本地缓存跨日复用（同一天同用户重复拉取结果一致，由后端保证）。
2. 寄语内容为「有出处的史料语录」（`:2`、`:8` 的 `source` 字段），文案由后台录入，前端原样展示。

## 8. 修改约束

1. 返回结构 camelCase 硬契约（`backend/AGENTS.md` §4.1）；可为 null 的约定（`:8`）消费页 home 已依赖，改动需同步。
2. 保持服务层薄：不得加入本地寄语数据或缓存（`frontend/AGENTS.md` §3.1）。
3. 函数名 `getToday` 与 `services/sport.js`、`services/broadcast.js` 中的同名函数无关（各自模块作用域），grep 排查调用方时勿混淆（如 `frontend/pages/home/home.js:156-165` 三处 `getToday` 分属 sport/broadcast/quote）。

## 9. 当前实现状态

- 已实现：唯一导出 `getToday` 有真实调用方（§6），无死代码。
- 待开发：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/quote.js`，共 **2 个提交**，按时间倒序。

### 2026-10-11（`d6acf7e`，20:14）
- 需求：每日寄语改为排序号+启用状态按天循环展示（迁移 013、起始日期可配置）。
- 修改内容（涉本文件）：仅能由 `git log --follow` 确认本文件被该提交触及；推断为 docstring 口径更新（`:7`，见 §3 说明）。
- 测试结果：见 `docs/迭代记录.md` 的 `d6acf7e` 条目。

### 2026-10-03（`71d1b9b`，23:39）
- 需求：每日寄语与节点纪念票（P2-1，需求 §16）。
- 修改内容（涉本文件）：创建本文件（`getToday`）；同批交付后台语录维护、首页寄语卡、Canvas 节点纪念票（提交信息为唯一证据）。
- 关联文件：`frontend/pages/home/home.js`、后端 `app/api/routes/quotes.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `71d1b9b` 条目。
