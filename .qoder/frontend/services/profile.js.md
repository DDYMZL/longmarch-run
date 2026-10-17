# profile.js

## 1. 文件路径

`frontend/services/profile.js`（28 行）

## 2. 文件职责

个人档案服务层薄封装：档案页聚合数据（summary）与「我的长征足迹」时间轴（timeline）两个只读函数（docstring `frontend/services/profile.js:1-3`）。聚合与文案生成全在后端，前端只取数与解包。

## 3. 业务需求

「小程序页面高级化升级（首页重组/档案/行军日历/到达动画/情报化/勋章墙）」批次交付（提交 `7e587c9`，`docs/迭代记录.md` 的 `7e587c9` 条目），本文件由该提交创建（`git log --follow` 仅此 1 个提交）。后端侧同批交付聚合接口（`.qoder/backend/app/api/routes/profile.py.md`，其历史见 `18c2121`）。

## 4. 核心功能

| 函数 | 行号 | 后端接口 | 说明 |
|---|---|---|---|
| `getSummary()` | `:10-12` | `GET /api/profile/summary` | 档案页聚合：user/stats/quiz/medals/points 五段 |
| `getTimeline(limit)` | `:19-23` | `GET /api/profile/timeline?limit=` | 事件倒序时间轴；limit 为 falsy 时默认 50（`:21`），解包 `result.items || []` 返回数组（`:22`） |

请求经 `services/request.js`（`:4`），URL 拼接为 `API_BASE_URL + opts.url`（`frontend/services/request.js:69`）。足迹条目文案由后端生成（docstring `:15`），前端不做文案拼装。

## 5. 输入与输出

- `getSummary()`：无参；返回 `{user, stats, quiz, medals, points}`（JSDoc `:8`，各段为 object，具体字段以后端 schema 为准，见 `.qoder/backend/app/api/routes/profile.py.md`）。
- `getTimeline(limit)`：返回 `Array<{eventType, eventTime, text, data}>`（JSDoc `:17`）；后端无数据时为空数组（`:22` 的 `|| []` 兜底）。
- 异常：由 request.js 统一 reject（401 静默重登重试一次，`frontend/services/request.js:122-123`）。

## 6. 依赖关系

- 依赖：仅 `services/request.js`（`:4`）。**无本地缓存**（不经 `services/store.js`，不写 Storage/globalData）。
- 被依赖（grep `services/profile`）：
  - `frontend/pages/profile/profile.js:9`（`:56-57` 并行调 `getSummary()` 与 `getTimeline(50)`，档案页本体）；
  - `frontend/pages/mine/mine.js:8`（`:35` 调 `getSummary`，「我的」页档案卡）；
  - `frontend/pages/ceremony/ceremony.js:11`（`:45` `getSummary().catch(() => null)`，到达仪式页取档案数据、失败降级）。
- 后端契约文档：`.qoder/backend/app/api/routes/profile.py.md`；时间轴文案与实时动态共享后端 `build_text` 逻辑，见 `.qoder/backend/app/api/routes/broadcast.py.md` §8 第 4 条。

## 7. 业务规则

1. 前端不生成、不改写足迹文案：`text` 字段由后端事件服务统一产出（`:15`），与首页实时动态同源，改文案须改后端（多处消费的共享逻辑）。
2. timeline 默认拉 50 条（`:21`），非全量拉取，符合根 `agents.md` §2.4 大数据量性能要求；分页能力后端未提供（JSDoc 仅 limit），如足迹增长需后端扩展。

## 8. 修改约束

1. 返回结构 camelCase 硬契约（`backend/AGENTS.md` §4.1）；`getTimeline` 的解包约定（后端 `{items:[...]}` → 前端数组，`:22`）改动需与三个消费页同步。
2. 保持服务层薄：档案聚合逻辑在后端 profile 路由/服务，不得前移（`frontend/AGENTS.md` §3.1）。
3. `getSummary` 返回的 `user.avatar` 为后端下发的展示字段；本文件不涉及用户头像选择/持久化链路（那是 `services/auth.js` 的职责，`frontend/AGENTS.md` §4.4），勿在此处加头像写逻辑。

## 9. 当前实现状态

- 已实现：两个导出均有真实调用方（§6），无死代码。
- 待开发：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/profile.js`，共 **1 个提交**。

### 2026-10-02（`7e587c9`，11:13）
- 需求：小程序页面高级化升级（档案页等）。
- 修改内容（涉本文件）：创建本文件（`getSummary`/`getTimeline`），配套档案页 `pages/profile/`（提交信息为唯一证据）。
- 关联文件：`frontend/pages/profile/profile.js`、后端 `app/api/routes/profile.py`（同批聚合接口，见 `docs/迭代记录.md` 的 `18c2121` 条目）。
- 测试结果：见 `docs/迭代记录.md` 的 `7e587c9` 条目。
