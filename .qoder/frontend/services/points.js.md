# points.js

## 1. 文件路径

`frontend/services/points.js`（34 行）

## 2. 文件职责

积分域服务层薄封装：仅「积分概览」与「按日积分明细」两个只读函数。积分全部由后端台账计算，前端只展示（docstring `frontend/services/points.js:1-6`），本文件无本地计算、无缓存、无写入接口。

## 3. 业务需求

- V2.0 批次「我的积分卡与积分明细页」（提交 `44eb77b`，`docs/迭代记录.md` 的 `44eb77b` 条目）交付消费页并演进本服务。
- 步行积分口径两次调整：`4afccdd` 改为按运动记录累计口径、`9cb65b8` 取消单日封顶改为「累计步数每满 1000 步计 1 分」（两条见 `docs/迭代记录.md` 对应条目；docstring `:4-5` 与最终口径一致）。
- 需求来源文档编号：待确认（docstring 未标注需求章节号，仅注明「以后端 rules 为准」）。

## 4. 核心功能

请求统一经 `services/request.js`：URL 拼接为 `API_BASE_URL + opts.url`（`frontend/services/request.js:69`，`API_BASE_URL` 来自 `services/config.js`，`request.js:1`），即实际命中后端 `/api/points*`。

| 函数 | 行号 | 后端接口 | 说明 |
|---|---|---|---|
| `getSummary()` | `:15-17` | `GET /api/points` | 积分概览（总分/步行分/答题分/今日数据/排名/规则参数） |
| `getDaily(page, pageSize)` | `:25-29` | `GET /api/points/daily?page=&page_size=` | 按自然日倒序分页明细 |

`getDaily` 以字符串拼接 query（`:27`），`page`/`pageSize` 为 falsy 时默认 1/20；注意 query 参数名是 snake_case 的 `page_size`（与后端 FastAPI query 契约一致，响应体才是 camelCase）。

## 5. 输入与输出

- `getSummary()`：无参；返回 `{total, walk, quiz, todayWalk, todayQuiz, todaySteps, todayCorrect, rank|null, rules:{walkStepsPerPoint, quizPerCorrect, quizDailyCap}}`（JSDoc `:11-13`）。
- `getDaily(page, pageSize)`：返回 `{total, items:[{date, walk, quiz, total, steps, correctCount, updatedAt|null}]}`（JSDoc `:23`）；JSDoc `:22` 声明 pageSize 后端上限 100，已核实为真（`Query(20, ge=1, le=100)`，`backend/app/api/routes/points.py:26`；越界返回 422，契约见 `.qoder/backend/app/api/routes/points.py.md` §5）。
- 异常：由 `request.js` 统一 reject——JWT 自动注入，401 静默重登并重试一次，仍失败清登录态回启动页（`frontend/services/request.js:122-123`）。

## 6. 依赖关系

- 依赖：仅 `services/request.js`（`:7`）。**不经 `services/store.js` 缓存**（store.js 仅保留登录迁移职责，见 `frontend/AGENTS.md` §3/§4.2），也不直接依赖 config.js。
- 被依赖（grep `services/points`）：
  - `frontend/pages/mine/mine.js:10`（`:35` 调 `getSummary`，「我的」页积分卡）；
  - `frontend/pages/points/points.js:6`（`:44` 首屏 `getSummary + getDaily(1, PAGE_SIZE)`，`:87` 翻页 `getDaily`）。
- 后端契约文档：`.qoder/backend/app/api/routes/points.py.md`。

## 7. 业务规则

前端不实现任何积分规则，docstring 仅记录口径（`:4-5`）：总积分 = 步行积分 + 答题积分；步行按日期累计步数每满 1000 步计 1 分、不设单日上限（零头结余累计）；答题每答对 1 题 +2、单日上限 10。实际计算与「同日同 reason 去重」在后端（`backend/AGENTS.md` §4.5：积分发放统一走 points_service）。

## 8. 修改约束

1. 返回结构 camelCase 是与后端 schema 的硬契约（`backend/AGENTS.md` §4.1）；改字段需双端同步，并核对消费页 mine/points。
2. 保持服务层薄：不得把积分计算、本地累计或 Storage 持久化写进本文件（`frontend/AGENTS.md` §3.1「后端是唯一数据源」）。
3. 修改积分口径时须同步更新 docstring `:4-5` 与后端规则（`backend/AGENTS.md` §4.4「禁止单边变更」），历史上 `4afccdd`/`9cb65b8` 均为全端口径同步提交。

## 9. 当前实现状态

- 已实现：两个函数均可用，两个导出都有真实调用方（§6），无死代码。
- 待确认：无（原「`pageSize` 后端上限 100 未复核」一项已于 2026-10-17 核实关闭——后端 `Query(20, ge=1, le=100)`，`backend/app/api/routes/points.py:26`，越界 422）。
- 待开发：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/points.js`，共 **6 个提交**，按时间倒序。各提交对本文件的具体改动仅以提交信息与 `docs/迭代记录.md` 对应条目为据。

### 2026-10-15（`9cb65b8`，18:03）
- 需求：步行积分口径调整（全端）。
- 修改内容（涉本文件）：docstring 口径更新为「每满 1000 步计 1 分、不设单日上限」（提交信息：取消单日 20000 封顶）。
- 测试结果：见 `docs/迭代记录.md` 的 `9cb65b8` 条目。

### 2026-10-15（`4afccdd`，14:44）
- 需求：步行积分改累计口径（全端）。
- 修改内容（涉本文件）：随口径调整同步（提交信息：按运动记录修复步行积分为累计口径）。
- 测试结果：见 `docs/迭代记录.md` 的 `4afccdd` 条目。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0 小程序批次。
- 修改内容（涉本文件）：配合「我的积分卡与积分明细页」交付（提交信息为唯一证据）。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（v2 自动化验收 14/14）。

### 2026-10-11（`e70b59f`，19:18）
- 需求：小程序代码审查修复批次。
- 修改内容（涉本文件）：属「删除无引用服务与冗余字段」清理范围（提交信息为唯一证据）。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-01（`6a24562`，17:53）
- 需求：服务层由本地 Mock 切换为后端真实接口。
- 修改内容（涉本文件）：改为经 request.js 调 `/points*` 真实接口（提交信息为唯一证据）。
- 测试结果：见 `docs/迭代记录.md` 的 `6a24562` 条目。

### 2026-09-30（`a94e685`，18:05）
- 需求：项目初始化。
- 修改内容（涉本文件）：创建（`feat: init`，初版为 Mock 实现）。
- 测试结果：无（初始化提交）。
