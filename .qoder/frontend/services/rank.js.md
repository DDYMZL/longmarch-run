# rank.js

## 1. 文件路径

`frontend/services/rank.js`（22 行）

## 2. 文件职责

排行榜服务层薄封装：仅「全员工总积分榜」一个只读分页函数，与管理端「排名洞察」同一口径，数据全部来自后端（docstring `frontend/services/rank.js:1-3`）。

## 3. 业务需求

- 初版随项目初始化交付（`a94e685`，Mock），`6a24562` 切换为后端真实接口；V2.0 批次「积分排行榜（领奖台/荣誉榜/分页）」演进（`44eb77b`）。三条均见 `docs/迭代记录.md` 对应条目。
- 需求来源文档编号：待确认（docstring 未标注）。

## 4. 核心功能

| 函数 | 行号 | 后端接口 | 说明 |
|---|---|---|---|
| `getPointsRank(page, pageSize)` | `:14-18` | `GET /api/rank/points?page=&page_size=` | 总积分榜分页；`page`/`pageSize` falsy 时默认 1/20（`:16`），query 字符串拼接 |

- 请求经 `services/request.js`（`:4`），URL 拼接为 `API_BASE_URL + opts.url`（`frontend/services/request.js:69`）。
- 返回结构语义（JSDoc `:7-8`、`:12`，为后端口径的前端记录）：`top` 为第 1~10 名（领奖台），`list` 为第 11 名起的第 page 页（荣誉榜），`me` 为当前用户（未上榜为 null）；排序为总积分降序，同分按累计步数、再按用户 ID；榜单项 `{rank, userId, nickname, avatar, orgName, steps, points, walkPoints, quizPoints, isMe}`。
- 注意 query 参数名为 snake_case `page_size`（`:16`），响应体为 camelCase。

## 5. 输入与输出

- 输入：`page`（第 11 名起的分页页码，从 1 开始）、`pageSize`（JSDoc `:10` 声明后端上限 50，以后端文档为准）。
- 输出：`{top:Array, list:Array, me:object|null, page, pageSize, hasMore, total}`（JSDoc `:11`）。
- 异常：由 request.js 统一 reject（401 静默重登重试一次，`frontend/services/request.js:122-123`）。

## 6. 依赖关系

- 依赖：仅 `services/request.js`（`:4`）。**无本地缓存**（不经 `services/store.js`）。
- 被依赖（grep `services/rank`）：仅 `frontend/pages/rank/rank.js:7`（`:56` 首屏 `getPointsRank(1, PAGE_SIZE)`，`:92` 滚动翻页）。
- 后端契约文档：`.qoder/backend/app/api/routes/rank.py.md`。

## 7. 业务规则

1. 排名计算、同分排序、top/list/me 切分全部在后端；前端只传分页参数并渲染，不做本地排序。
2. 与管理端「排名洞察」同一口径（`:2`）：口径变更须后端统一改，双端自然一致，禁止前端单独加工。

## 8. 修改约束

1. 返回结构 camelCase 硬契约（`backend/AGENTS.md` §4.1）；`top/list/me/hasMore` 字段改动需与 rank 页同步。
2. 保持服务层薄：不得加入本地榜单缓存或模拟数据（`frontend/AGENTS.md` §3.1「后端是唯一数据源」）。
3. `page_size` query 名与后端 FastAPI 参数一致，勿改 camelCase。

## 9. 当前实现状态

- 已实现：唯一导出 `getPointsRank` 有真实调用方（§6），无死代码。
- 待确认：`pageSize` 后端上限 50 为 JSDoc 声明（`:10`），本次未复核后端实现。
- 待开发：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/rank.js`，共 **3 个提交**，按时间倒序。各提交对本文件的具体改动以提交信息与 `docs/迭代记录.md` 对应条目为据。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0——积分排行榜（领奖台/荣誉榜/分页）。
- 修改内容（涉本文件）：配合排行榜页升级（提交信息为唯一证据）。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（v2 自动化验收 14/14）。

### 2026-10-01（`6a24562`，17:53）
- 需求：服务层由本地 Mock 切换为后端真实接口。
- 修改内容（涉本文件）：改为经 request.js 调 `/rank/points`（提交信息为唯一证据）。
- 测试结果：见 `docs/迭代记录.md` 的 `6a24562` 条目。

### 2026-09-30（`a94e685`，18:05）
- 需求：项目初始化。
- 修改内容（涉本文件）：创建（`feat: init`，初版为 Mock 实现）。
- 测试结果：无（初始化提交）。
