# org.js

## 1. 文件路径

`frontend/services/org.js`（55 行）

## 2. 文件职责

组织架构服务层：把后端 `/org/*` 五个接口封装为小程序页面可直接消费的 Promise 函数，覆盖「逐级浏览组织树 → 首次选定组织 → 我的组织 → 同组织同行者 → 组织集体长征」全链路（`frontend/services/org.js:1-3` 模块 docstring）。本文件无任何业务规则，纯转发 `requestService.request`（`:4`），符合 `frontend/AGENTS.md` §3.1「services 层所有数据读写经 request.js 调后端接口」。

## 3. 业务需求

- 组织浏览与选定：入驻/登录流程中组织为**选填**项，用户可逐级下钻组织树后选定（`frontend/AGENTS.md` §4.5「不得再强制跳组织选择」）。
- `getCompanions`：需求 §9「同组织同行者」（`frontend/services/org.js:34` 注释），P1-2 批次 `f37e3d7`（2026-10-03）交付（`docs/迭代记录.md` 的 `f37e3d7` 条目）。
- `getOrgMarch`：需求 §10「组织共同长征目标」（`:42` 注释），P1-3 批次 `b4a8910`（2026-10-03）交付（`docs/迭代记录.md` 的 `b4a8910` 条目）。
- `locked` 锁定语义（V2.0「组织锁定只读」）：`44eb77b`（2026-10-13）引入（`docs/迭代记录.md` 的 `44eb77b` 条目）。

## 4. 核心功能

导出 5 个函数（`module.exports`，`:49-55`），全部经 `requestService.request`（JWT 注入与 401 静默重登由 `frontend/services/request.js` 统一处理，见 `.qoder/frontend/services/request.js.md`〔如已建档〕）：

| # | 函数 | 行号 | 后端端点 | 返回值处理 |
|---|---|---|---|---|
| 1 | `getChildren(parentId)` | `:11-14` | `GET /api/org/children[?parentId=]` | **解包**：`result.nodes \|\| []`（`:13`），页面拿到裸数组 |
| 2 | `getMine()` | `:20-22` | `GET /api/org/mine` | 原样返回 `{orgId, orgName, fullName, path, locked, scopeOrgId, scopeOrgName}`（JSDoc `:18`） |
| 3 | `select(orgId)` | `:29-31` | `POST /api/org/select`，body `{orgId}` | 原样返回选定后组织信息（含 `locked`，JSDoc `:27`） |
| 4 | `getCompanions(limit)` | `:37-39` | `GET /api/org/companions?limit=`，**limit 为空时前端默认 6**（`:38`） | 原样返回 `{org, memberCount, todayTotalSteps, companions}` |
| 5 | `getOrgMarch()` | `:45-47` | `GET /api/org/march` | 原样返回 `{org, memberCount, totalSteps, progressPct, currentNodeName, nextNodeName, finished, nodes}` |

后端各端点的参数钳制、响应 Schema 与错误码见 `.qoder/backend/app/api/routes/org.py.md`（其 §4.3-4.6 与输入输出表），本文档不重复。

## 5. 输入与输出

- `getChildren(parentId)`：`parentId` 为 `number|null`；**falsy（null/undefined/0/空串）时不带 query 参数即返回顶级组织**（`:12` 三元判断）。组织 id 均为正整数，故 `0` 落入顶级分支不构成实际问题。
- `getCompanions(limit)`：query 拼接 `limit || 6`（`:38`），服务端另有 1..50 钳制（`.qoder/backend/app/api/routes/org.py.md` 输入输出表）。
- `select(orgId)`：POST JSON `{orgId}`（`:30`）。
- 异常：网络失败/401/400（如二次改选被后端拒绝）均以 Promise reject 冒泡到页面，本文件不 catch、不兜底——错误提示是页面职责（`6a24562` 起页面「补错误提示」，见 §10）。

## 6. 依赖关系

- 依赖：`./request`（`:4`）→ `./config`（API_BASE_URL）→ 后端 `backend/app/api/routes/org.py`。
- 被依赖（grep `services/org` 全量核实，测试目录除外）：
  - `frontend/pages/home/home.js:13`（require）；`:162` `org.getCompanions(6).catch(() => null)`、`:163` `org.getOrgMarch().catch(() => null)`——首页「组织同行卡」「集体长征卡」，**失败不阻塞首页主数据**（`:162` 行内注释）。
  - `frontend/pages/org-select/org-select.js:14`（require）；`:55` `.getMine()`（进页回显当前组织与锁定态）、`:72` `.getChildren(parentId)`（逐级下钻）、`:162` `.select(orgId)`（确认选定）。
- **零调用方导出**：无——5 个导出函数均有页面调用（上述 grep 证据）。

## 7. 业务规则

1. **组织选定一次性、锁定后只读**：`select` 注释明示「选定后锁定，后端拒绝二次修改」（`:25`）；`getMine().locked === true` 表示已选定并锁定，「调整需联系管理员」（`:17`）。前端不做锁定判断，强制约束在后端（`.qoder/backend/app/api/routes/org.py.md` §4.6）。
2. **`GET /api/org/children` 完全无鉴权（含未登录）**：组织树须在入驻/绑定前可浏览，属架构级已登记的有意豁免——见 `.qoder/PROJECT.md` §8「架构级限制」第 33 项，代码证据与讨论见 `.qoder/backend/app/api/routes/org.py.md`。本文件因此可在登录前调用 `getChildren`（org-select 页由首页引导卡进入，`frontend/AGENTS.md` §4.5）。
3. 其余四个端点均需登录态（JWT），401 时 `request.js` 静默重登并重试一次（`frontend/AGENTS.md` §7「服务层请求示例」）。
4. 同行者列表按「今日步数倒序」（`:34` JSDoc），排序在后端完成，前端不重排。

## 8. 修改约束

1. 返回结构是页面硬契约（`frontend/AGENTS.md` §1「服务层返回结构稳定是最高优先级约束」）：`getChildren` 的**解包行为**（页面拿数组而非 `{nodes}`）与其余四函数的原样透传口径不同，改动须同步 `org-select.js`/`home.js`。
2. 字段命名 camelCase，与后端 `CamelModel` 输出对齐（`.qoder/backend/app/api/routes/org.py.md`）；改字段须前后端同步（根 `.qoder/README.md` §3 规则 6）。
3. 不得在本层加入锁定/权限判断的「前端预拦截」——锁定语义以后端为准，前端仅透传 `locked` 供页面渲染只读态（V2.0 `44eb77b`）。
4. 不得绕过 request.js 直发请求（`frontend/AGENTS.md` §6.5）。

## 9. 当前实现状态

- **已实现**：5 个函数全部可用且全部有真实调用方（§6 grep 证据）；对应后端 5 端点文档见 `.qoder/backend/app/api/routes/org.py.md`。
- **存在问题 / 已知事项**：`GET /org/children` 匿名可浏览组织树为已登记架构级限制（`.qoder/PROJECT.md` §8「架构级限制」第 33 项），非本文件缺陷。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/org.js`，共 **5 个提交**；均已核对存在于 `docs/迭代记录.md`。按时间倒序。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0 小程序批次（组织锁定只读、「我的」组织名以后端全称回填等）。
- 修改内容（涉本文件）：组织锁定只读口径落地（`locked` 语义，`:17`、`:25` 注释）；细节以提交信息与 `docs/迭代记录.md` 的 `44eb77b` 条目为准。
- 关联文件：`frontend/pages/org-select/org-select.js`、`frontend/pages/mine/*` 等（同批 V2.0 改动）。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（提交信息载明 v2 自动化验收 14/14）。

### 2026-10-03（`b4a8910`，01:42）
- 需求：组织共同长征目标（P1-3，需求 §10）。
- 修改内容（涉本文件）：新增 `getOrgMarch()`（`:41-47`）；同批后端组织集体长征接口 + 首页集体长征卡（提交信息）。
- 关联文件：`backend/app/api/routes/org.py`、`frontend/pages/home/home.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `b4a8910` 条目。

### 2026-10-03（`f37e3d7`，01:17）
- 需求：同组织同行者（P1-2，需求 §9）。
- 修改内容（涉本文件）：新增 `getCompanions(limit)`（`:33-39`）；同批后端组织同行接口 + 首页组织同行卡（提交信息）。
- 关联文件：`backend/app/api/routes/org.py`、`frontend/pages/home/home.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `f37e3d7` 条目。

### 2026-10-01（`6a24562`，17:53）
- 需求：服务层由本地 Mock 切换为后端真实接口。
- 修改内容（涉本文件）：`getChildren/getMine/select` 改为经 `request.js` 调真实接口，页面改异步加载并补错误提示（提交信息）。
- 关联文件：`frontend/services/request.js` 及全部页面消费方。
- 测试结果：见 `docs/迭代记录.md` 的 `6a24562` 条目。

### 2026-09-30（`a94e685`，18:05）
- 需求：项目初始化（Mock 时代）。
- 修改内容（涉本文件）：创建 `org.js`（本地 Mock 实现，后经 `6a24562` 切换为真实接口）。
- 关联文件：全仓库初始提交。
- 测试结果：初始化提交，无独立测试记录（提交信息为唯一证据）。
