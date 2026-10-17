# medal.js

## 1. 文件路径

`frontend/services/medal.js`（18 行）

## 2. 文件职责

勋章服务层薄封装：仅「勋章列表」一个只读函数。勋章的评估与发放在后端于步数/答题/点亮等行为后统一触发（docstring `frontend/services/medal.js:1-3`），前端只取列表展示。

## 3. 业务需求

- 初版随项目初始化交付（`a94e685`，Mock）；`b0fd8b2`/`6a24562` 切换为后端真实接口；`7e587c9` 勋章墙页面高级化；`e70b59f` 代码审查批次优化（light-up 合并返回 newMedals 省去单独勋章请求）。各条见 `docs/迭代记录.md` 对应条目。
- 需求来源文档编号：待确认（docstring 未标注）。

## 4. 核心功能

| 函数 | 行号 | 后端接口 | 说明 |
|---|---|---|---|
| `getMedalList()` | `:12-14` | `GET /api/medal/list` | 取勋章列表，解包 `result.medals || []` 返回数组（`:13`） |

- 请求经 `services/request.js`（`:4`），URL 拼接为 `API_BASE_URL + opts.url`（`frontend/services/request.js:69`）。
- 后端返回前已自动检查发放（docstring `:7`），即读接口本身带「补发」副作用，前端无需另行触发。
- 列表元素含 `category/hidden/sortOrder/grantedAt/conditionDesc`；隐藏勋章未获得时条件不公开（docstring `:8`）。

## 5. 输入与输出

- `getMedalList()`：无参；返回 `Array<{id, name, icon, desc, owned, category, hidden, sortOrder, grantedAt|null, conditionDesc}>`（JSDoc `:9-10`）；后端无数据时为空数组（`:13` 的 `|| []` 兜底）。
- 异常：由 request.js 统一 reject（401 静默重登重试一次，`frontend/services/request.js:122-123`）。

## 6. 依赖关系

- 依赖：仅 `services/request.js`（`:4`）。**无本地缓存**（不经 `services/store.js`）；勋章「持有」状态以后端为准。
- 被依赖（grep `services/medal`）：
  - `frontend/pages/home/home.js:11`（`:160` 首屏并行请求中调 `getMedalList`，首页荣誉卡）；
  - `frontend/pages/medals/medals.js:6`（`:37` 调用，勋章墙页本体）；
  - `frontend/pages/mine/mine.js:9`（`:35` 并行调用，「我的」页荣誉卡）。
- 后端契约文档：`.qoder/backend/app/api/routes/medal.py.md`。

## 7. 业务规则

1. 勋章判定阈值与发放逻辑全在后端 medal_service（`backend/AGENTS.md` §4.5：影响步数/点亮/答题/积分的操作必须触发 `medal_service.check_and_grant`），前端不做判定、不本地造勋章。
2. 隐藏勋章的悬念设计（未获得不公开条件）由后端 `conditionDesc` 控制（`:8`），前端不得用其他字段反推展示。
3. `e70b59f` 后点亮动画所需新勋章由 light-up 接口合并返回，点亮链路不再单独调本服务（提交信息）；本服务仅服务三处列表展示。

## 8. 修改约束

1. 解包约定（后端 `{medals:[...]}` → 前端数组，`:13`）是三个消费页的隐式契约，改动需同步。
2. 返回结构 camelCase 硬契约（`backend/AGENTS.md` §4.1）；勋章字段与后端 schema、种子数据（6 枚勋章，`backend/AGENTS.md` §3）对应，改字段需双端同步。
3. 保持服务层薄：不得加入本地勋章缓存或 Mock 数据（`frontend/AGENTS.md` §3.1）。

## 9. 当前实现状态

- 已实现：唯一导出 `getMedalList` 有 3 个页面调用（§6），无死代码。
- 待开发：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/medal.js`，共 **5 个提交**，按时间倒序。各提交对本文件的具体改动以提交信息与 `docs/迭代记录.md` 对应条目为据。

### 2026-10-11（`e70b59f`，19:18）
- 需求：小程序代码审查修复批次。
- 修改内容（涉本文件）：属「删除无引用服务与冗余字段、light-up 合并返回 newMedals 省去单独勋章请求」优化范围（提交信息为唯一证据）。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-02（`7e587c9`，11:13）
- 需求：小程序页面高级化升级（勋章墙）。
- 修改内容（涉本文件）：配合勋章墙页面升级（提交信息为唯一证据）。
- 测试结果：见 `docs/迭代记录.md` 的 `7e587c9` 条目。

### 2026-10-01（`6a24562`，17:53）
- 需求：服务层由本地 Mock 切换为后端真实接口（第二批页面异步化）。
- 修改内容（涉本文件）：随批次调整（提交信息为唯一证据）。
- 测试结果：见 `docs/迭代记录.md` 的 `6a24562` 条目。

### 2026-10-01（`b0fd8b2`，10:31）
- 需求：小程序由本地 Mock 切换为真实后端接口。
- 修改内容（涉本文件）：改为经 request.js 调 `/medal/list`（提交信息为唯一证据）。
- 测试结果：见 `docs/迭代记录.md` 的 `b0fd8b2` 条目。

### 2026-09-30（`a94e685`，18:05）
- 需求：项目初始化。
- 修改内容（涉本文件）：创建（`feat: init`，初版为 Mock 实现）。
- 测试结果：无（初始化提交）。
