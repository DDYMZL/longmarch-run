# auth.ts

## 1. 文件路径

`admin/src/store/auth.ts`（52 行）

## 2. 文件职责

管理后台登录态的轻量 store：token / 用户名 / 菜单权限码 / 超管标记持久化到 localStorage（4 个键），提供读写与 `hasMenu`/`isLoggedIn` 判断，页面刷新不丢失。**不是 Pinia/Vuex**——项目决策「无状态库：登录态是唯一全局状态，localStorage 足矣」（`admin/design.md` §5 决策 1；`.qoder/ARCHITECTURE.md` §5.5「管理后台」段同述）。

## 3. 业务需求

- 管理后台登录会话保持（`4a26520` 创建，仅 token+username）。
- P3 管理端 RBAC：微信扫码登录与菜单权限（`54a0de7` 增加 `lm_admin_menus`/`lm_admin_is_super` 两键与 `hasMenu`/`setProfile`；设计出处 `docs/identity-binding-design.md`，转引自 `.qoder/backend/app/services/access_service.py.md` §3）。
- `30b4458` 代码审查：`setAuth(token, username)` 拆为 `setToken(token)`（用户名移入 `setProfile` 统一写入），`isLoggedIn` 收紧为「令牌 + 权限档案并存」。

## 4. 核心功能

### 4.1 存储键（`:2-5`）

| 键 | 内容 | 写入方 |
|---|---|---|
| `lm_admin_token` | JWT（超管 `typ=super` 或微信关联管理员 `typ=user`，12 小时有效，`.qoder/ARCHITECTURE.md` §5.1） | `setToken` |
| `lm_admin_username` | 登录名/昵称 | `setProfile` |
| `lm_admin_menus` | 菜单码数组的 JSON 串（管理端 snake_case 码，如 `route_nodes`） | `setProfile` |
| `lm_admin_is_super` | `'1'`/`'0'` 字符串 | `setProfile` |

### 4.2 读函数（`:7-29`）

- `getToken()`（`:7-9`）/`getUsername()`（`:11-13`）：空值兜底 `''`。
- `getIsSuper()`（`:15-17`）：严格 `=== '1'`。
- `getMenus()`（`:19-25`）：JSON 解析失败（手改坏值）静默返回 `[]`，不抛异常。
- `hasMenu(code)`（`:27-29`）：`getIsSuper() || getMenus().includes(code)`——超管短路全通过，与后端 `AdminPrincipal.has_menu`（`.qoder/ARCHITECTURE.md` §5.3）同构。

### 4.3 写函数（`:31-47`）

- `setToken(token)`（`:31-33`）：仅写令牌（登录接口先返回 token，档案随后写，见 §7.1）。
- `setProfile(username, isSuper, menus)`（`:36-40`）：一次写用户名、超管标记、菜单码三键（`:35` 注释：菜单渲染与路由守卫据此判断）。
- `clearAuth()`（`:42-47`）：删除全部 4 键。

### 4.4 `isLoggedIn()`（`:49-52`）

要求**令牌与权限档案并存**：`!!getToken() && (getIsSuper() || MENUS_KEY !== null)`。`:50` 注释：仅残留旧令牌（`54a0de7` 之前版本写入的、无菜单档案的 token）视为未登录，避免路由守卫在「已登录但零菜单」分支死循环（对应 `router/index.ts:107-111`）。

## 5. 输入与输出

- 输入：`setProfile(username: string, isSuper: boolean, menus: string[])` 等；来源为后端登录链路响应（snake_case 契约：`is_super`、`menus[].code`，`views/LoginView.vue:40`、`:111` 处映射）。
- 输出：string / boolean / string[]；无 Promise、无异常抛出（`getMenus` 内部捕获 JSON 错误）。
- 无网络请求；本文件不校验令牌有效性（过期由后端 401 触发 `api/request.ts:35-45` 清理）。

## 6. 依赖关系

- 依赖：仅浏览器 `localStorage`，零 import。
- 被依赖（5 处，grep 实测）：`api/request.ts:4`（getToken 注入 / clearAuth）、`router/index.ts:5`（hasMenu、isLoggedIn 守卫）、`layout/AdminLayout.vue:6`（getUsername/getIsSuper/hasMenu/clearAuth）、`utils/liveUpdates.ts:5`（getToken 拼 WS query 令牌）、`views/LoginView.vue:9`（setToken/setProfile）。
- 数据来源接口（经 `api/admin.ts`）：`POST /api/admin/login`（token）、`GET /api/admin/me`（username/is_super/menus，账号登录第二步）、`GET /api/admin/wechat/qr/{qr_id}/status`（扫码登录一次返回 token+username+is_super+menus）——见 `.qoder/backend/app/api/routes/admin.py.md` §4.7、§4.8。

## 7. 业务规则

1. **两条登录链的写入次序**：账号登录为 `login → setToken → fetchMe → setProfile` 两步（`views/LoginView.vue:37-40`）；扫码登录轮询到 `confirmed` 后一次写齐（`:108-111`）。中间态（有 token 无档案）被 `isLoggedIn` 判为未登录。
2. **本地菜单码仅作 UI 依据，不是权限事实来源**：后端权限不进令牌、每请求查库重建（`.qoder/ARCHITECTURE.md` §5.1、§14 不变量 8；`.qoder/backend/app/services/access_service.py.md` §7.1）；篡改 `lm_admin_menus` 只能骗过前端渲染，接口仍按库内角色返回 403。
3. 超管标记 `is_super` 本地为 `'1'/'0'` 字符串（localStorage 无布尔类型），读取端严格比较。
4. `menus` 可能含重复码（后端 `get_menu_codes` 未去重，`access_service.py.md` §7.4），`includes` 判断不受影响。
5. 登出/401 均走 `clearAuth` 全清 4 键，无部分清理路径。

## 8. 修改约束

- 4 个键名是浏览器端持久化契约：改键名等于全量强制登出，且 `isLoggedIn` 的 `MENUS_KEY !== null` 判断（`:51`）与 `router/index.ts:107-111` 的防死循环逻辑耦合，不能只改一处。
- `clearAuth` 必须清全部键；新增登录态字段时同步扩 `setProfile`/`clearAuth`/`isLoggedIn` 三处。
- 不得把 localStorage 档案升级为「前端权限判定事实来源」（如按菜单隐藏按钮做安全控制）——权限粒度与即时撤销语义由后端保证（`.qoder/PROJECT.md` §8「代码级技术债」第 20 项记录了无按钮级权限的现状）。
- `setToken` 与 `setProfile` 不可合并回旧 `setAuth`：扫码链在轮询回调里同时写两者，账号链则依赖两步分离（先拿 token 再查档案）。

## 9. 当前实现状态

- **已实现**：4 键读写、`hasMenu`/`isLoggedIn`、5 个消费方全部接通；历次浏览器验收见 §10。
- **存在问题 / 已知限制**：本地令牌无过期时间记录，过期只能等下一次请求 401 才被动清理（现状设计，非缺陷）；localStorage 可被同域脚本读取，属 JWT 存 localStorage 的通用风险（项目未记录为待办）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/store/auth.ts`，共 **3 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复。
- 修改内容（涉本文件）：`setAuth(token, username)` 拆为 `setToken(token)`（用户名改由 `setProfile` 写入）；调用方同步调整。
- 关联文件：`admin/src/views/LoginView.vue`、`admin/src/router/menus.ts`（新建）。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-09（`54a0de7`）
- 需求：扫码登录与人员授权/审计页（P3 管理端 RBAC）。
- 修改内容（涉本文件）：新增 `lm_admin_menus`/`lm_admin_is_super` 两键与 `getIsSuper`/`getMenus`/`hasMenu`/`setProfile`；`clearAuth` 扩至 4 键；`isLoggedIn` 收紧为「令牌 + 权限档案并存」（防守卫死循环）。
- 关联文件：`admin/src/router/index.ts`（菜单权限守卫）、`admin/src/views/LoginView.vue`（扫码登录）、`admin/src/layout/AdminLayout.vue`。
- 测试结果：见 `docs/迭代记录.md` 的 `54a0de7` 条目（浏览器验收 20/20）。

### 2026-09-30（`4a26520`）
- 需求：管理后台基础页面及依赖配置（初始批次）。
- 修改内容（涉本文件）：创建本文件（token/username 两键 + `setAuth`/`clearAuth`/`isLoggedIn`）。
- 关联文件：`admin/src/api/request.ts`、`admin/src/views/LoginView.vue`。
- 测试结果：见 `docs/迭代记录.md` 的 `4a26520` 条目。
