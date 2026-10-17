# request.ts

## 1. 文件路径

`admin/src/api/request.ts`（53 行）

## 2. 文件职责

管理后台唯一的 axios 实例：`baseURL '/api'`、15 秒超时、请求拦截注入管理员 Bearer Token、响应拦截统一错误 toast、401 清登录态并跳登录页；扩展 `silent` 请求选项供轮询类调用关闭全局报错。所有后端调用经 `api/admin.ts` 走本实例（`admin/agents.md`「开发约定」第 1 条）。

## 3. 业务需求

- `4a26520`（2026-09-30）随初始批次创建（token 注入 + 401 跳转 + 统一错误提示）。
- `54a0de7`（2026-10-09）扫码登录引入 2 秒轮询：新增 `silent` 配置项，轮询失败不弹全局 toast，由调用方内联展示（`:7` 注释）。
- `30b4458`（2026-10-11）代码审查：并发请求同时 401 时只有首个（清除前仍持有令牌）弹「登录已过期」，避免连弹多条（`:36` 注释）。

## 4. 核心功能

### 4.1 实例配置（`:14-17`）

`axios.create({ baseURL: '/api', timeout: 15000 })`。开发期 `/api` 由 Vite 代理转发到后端，生产期与后端同域（`.qoder/ARCHITECTURE.md` §1.3「管理后台 → 后端」段、§12.2「Vite 代理」行）。

### 4.2 `silent` 选项的模块扩充（`:8-12`）

`declare module 'axios'` 给 `AxiosRequestConfig` 增加 `silent?: boolean`——TypeScript 模块扩充，使 `admin.ts` 调用处传 `{ silent: true }` 能通过类型检查。现有消费点（grep 实测，均在 `api/admin.ts`）：扫码状态轮询（`:386`）、AI 出题流式/批处理调用（`:696-709`）、`fetchRouteNodes`/`fetchOrgTree` 的 silent 形参（`:582-583`、`:747-748`）。

### 4.3 请求拦截器（`:19-25`）

从 `store/auth.getToken()` 读令牌，非空则写 `Authorization: Bearer <token>`；无令牌时不带头（供 `/admin/login`、扫码等公开端点使用）。

### 4.4 响应拦截器（`:27-51`）

- **成功：原样透传完整 `AxiosResponse`**（`:28` `(response) => response`），调用方以 `const { data } = await xxx()` 解构（如 `views/LoginView.vue:37`）。
- 错误分支（`:29-50`）：取 `status`、FastAPI 错误体 `detail`（`:30-32`）、`silent`（`:33`）、是否登录页（`:34`）。
  - **401**（`:35-45`）：先记 `hadToken = !!getToken()` 再 `clearAuth()`；登录页上仅提示 `detail || '用户名或密码错误'`（不跳转）；其他页在 `hadToken && !silent` 时提示「登录已过期，请重新登录」并 `router.push('/login')`（无令牌/ silent 时静默跳转）。
  - **非 401**（`:46-48`）：`!silent` 时 toast `detail || error.message || '请求失败'`。
  - 一律 `Promise.reject(error)`（`:49`），调用方可继续 catch。

## 5. 输入与输出

- 输入：`AxiosRequestConfig`（含扩展 `silent`）；由 `api/admin.ts` 各函数传入。
- 输出：成功为 `Promise<AxiosResponse>`（业务 payload 在 `.data`，snake_case 契约——管理端字段风格，`.qoder/ARCHITECTURE.md` §4.2、§14 不变量 6）；失败为 reject 原始 axios error（已附带 toast 副作用）。
- 错误码消费：仅对 401 特判；400/403/404/422/429/500 等统一走「detail toast」路径（后端状态码语义见 `.qoder/ARCHITECTURE.md` §4.3）。

## 6. 依赖关系

- 依赖：`axios`；`element-plus` 的 `ElMessage`（`:3`，直接 import，样式由 `plugins/element-plus.ts:90` 保证）；`../store/auth`（`:4` getToken/clearAuth）；`../router`（`:5`，读当前路由 + 401 跳转）。
- 被依赖：`admin/src/api/admin.ts`（**唯一** import 方，grep 实测）——788 行 API 层全部经本实例，见 `.qoder/admin/src/api/admin.ts.md`。
- 与 `router/index.ts` 存在环形引用链（request → router → views 懒加载 → api/admin → request）：因 views 均为动态 import，运行时不构成循环初始化问题（现状事实，未见过故障记录）。

## 7. 业务规则

1. **401 双语义**：登录页上 = 凭证错误（提示 detail），其他页 = 令牌过期（清态 + 提示 + 跳登录）。`hadToken` 判断实现「并发 401 只弹一次」（`:36-37` 注释）。
2. **无 403 专门分支**：不消费后端 `X-Account-Status`/`X-Activity-Status` 响应头，权限被撤销时用户只见通用错误 toast——已知限制（`.qoder/ARCHITECTURE.md` §4.6、§15 第 8 项）。小程序端 `services/request.js` 有对应处理，**两端策略不同，勿互相对齐**。
3. **无自动重试/静默重登**：与小程序「401 单飞重登 + 精确重试一次」（`.qoder/ARCHITECTURE.md` §14 不变量 4）不同，管理端 401 一律回登录页，属两端各自契约。
4. 后端无响应信封，2xx 即业务 payload（`.qoder/ARCHITECTURE.md` §4.1、不变量 7）。
5. `silent: true` 的调用方须自行处理错误展示（`:7` 注释约定），当前用于轮询与 AI 生成场景。

## 8. 修改约束

- **成功拦截器必须继续返回完整 `AxiosResponse`**：`admin.ts` 全部函数签名按 `AxiosResponse<T>` 标注、调用方按 `{ data }` 解构；改成返回 `response.data` 会破坏所有调用点（`.qoder/ARCHITECTURE.md` §4.1 原表述「成功拦截器直接返回 response.data」与代码不符，**已于 2026-10-17 更正为「原样返回整个 `AxiosResponse`、由调用方取 `.data`」**，见 §9）。
- `declare module 'axios'` 扩充不可删（`silent` 的类型来源）。
- `clearAuth()` 必须在 `router.push('/login')` 之前（否则守卫按已登录把 `/login` 弹回业务页，`router/index.ts:107-111`）。
- timeout 15000 是全局值；个别长耗时接口（AI 出题）在 `api/admin.ts` 调用处自带 `signal`/silent 处理，改全局超时前先核对该处。
- 错误提示文案面向管理员（中文），`detail` 透传后端文案——后端改 detail 会直接改变管理端 toast。

## 9. 当前实现状态

- **已实现**：注入、401 处理、silent、统一 toast 全部可用；历次验收见 §10。
- **存在问题 / 已知事项**：
  1. 无 403 专门分支、不消费准入响应头（§7.2，总览已记录为架构级限制）。
  2. ~~**文档-代码不一致**：`.qoder/ARCHITECTURE.md` §4.1 写「`admin/src/api/request.ts:27-51` 的成功拦截器直接返回 `response.data`」~~ —— **已于 2026-10-17 由总览维护方更正**：§4.1 现表述为「成功拦截器原样返回整个 `AxiosResponse`（`:28` 即 `(response) => response,`），不做任何拆包，`.data` 由各调用方自行取」，并附更正说明块；`.qoder/backend/app/api/routes/ai_admin.py.md` §5.1 的同一误述一并更正。本条已闭环。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/api/request.ts`，共 **3 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复。
- 修改内容（涉本文件）：401 分支重构——新增 `hadToken` 快照，登录页/非登录页拆开提示逻辑，并发 401 只弹首条。
- 关联文件：`admin/src/router/menus.ts`、`admin/src/utils/liveUpdates.ts` 等同批审查文件。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-09（`54a0de7`）
- 需求：扫码登录（2 秒轮询）与人员授权/审计页。
- 修改内容（涉本文件）：新增 `silent` 配置项（含 axios 模块扩充），轮询失败不弹全局错误。
- 关联文件：`admin/src/views/LoginView.vue`、`admin/src/api/admin.ts`（pollWechatQr 传 silent）。
- 测试结果：见 `docs/迭代记录.md` 的 `54a0de7` 条目（浏览器验收 20/20）。

### 2026-09-30（`4a26520`）
- 需求：管理后台基础页面及依赖配置（初始批次）。
- 修改内容（涉本文件）：创建本文件（41 行：实例配置、token 注入、401 清态跳转、统一错误 toast）。
- 关联文件：`admin/src/api/admin.ts`、`admin/src/store/auth.ts`、`admin/src/router/index.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `4a26520` 条目。
