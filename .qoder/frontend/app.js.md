# app.js

## 1. 文件路径

`frontend/app.js`（26 行）

## 2. 文件职责

小程序的**应用级入口**：向微信框架注册 `App()` 实例，承载全局登录态（`globalData.user` / `globalData.loggedIn`）与两个全局方法（`setLoginUser` 置位、`logout` 清空）。它是「登录态在内存中的唯一权威副本」的持有者，但**不负责在启动时恢复登录态**——`onLaunch` 已被移除（见 §4.3 与 §10 的 `01e214a`），启动校验由 launch 页触发 `services/auth.js` 完成。

## 3. 业务需求

- 「本地 Token 不经后端校验不得视为已登录」——`frontend/AGENTS.md` §4 第 3 条架构不变量；本文件 `:6` 的行内注释即该不变量的落点。
- 主动退出后需再次手动登录（不得静默重登）——`frontend/AGENTS.md` §7「登录态」条；实现为 `logout()`（`:21-25`）调 `auth.clearLocalUser()` 写入退出标记。

## 4. 核心功能

### 4.1 `globalData`（`:4-8`）

| 字段 | 声明行 | 初值 | 含义 |
|---|---|---|---|
| `user` | `:5` | `null` | 当前登录用户对象（结构见 `frontend/AGENTS.md` §4 第 3 条 `lm_login_user` 键定义） |
| `loggedIn` | `:7` | `false` | 是否已通过后端校验/登录成功；`:6` 注释明确「本地缓存不作数」 |

**未在本文件声明、但运行时被写入 `globalData` 的字段**：`activity`（活动状态对象），由 `frontend/services/activity.js:14` 的 `getApp().globalData.activity = status;` 动态挂载。即 `globalData` 的实际字段集 = 本文件声明的 2 个 + 服务层追加的 1 个，声明处与写入处分离（见 §9 第 2 项）。

### 4.2 `setLoginUser(user)`（`:13-16`）

把入参写入 `globalData.user`（`:14`）并置 `globalData.loggedIn = true`（`:15`）。**唯一调用方**：`frontend/pages/mine/mine.js:134`（`auth.updateNickname(name).then((updated) => { if (updated) app.setLoginUser(updated); ... })`）——改昵称成功后用后端返回的最新用户对象刷新全局态。

### 4.3 `logout()`（`:21-25`）

三步：① `auth.clearLocalUser()`（`:22`）清 Storage 登录态并写主动退出标记（实现 `frontend/services/auth.js:250`，导出于 `:285`）；② `globalData.user = null`（`:23`）；③ `globalData.loggedIn = false`（`:24`）。**唯一生产调用方**：`frontend/pages/mine/mine.js:158`（`handleLogout` 二次确认后调用，随后 `wx.reLaunch({ url: '/pages/login/login' })`，即退出后落到登录页而非启动页）。

### 4.4 **不存在的应用生命周期钩子**

本文件**没有** `onLaunch` / `onShow` / `onHide` / `onError` / `onPageNotFound` / `onUnhandledRejection` 中任何一个（全文 26 行已通读，`App({...})` 对象仅含 `globalData`、`setLoginUser`、`logout` 三个键）。历史演变：

- `onLaunch` 曾在 `a94e685`～`6a24562` 期间存在，做「恢复本地登录态」；
- `6a24562`（2026-10-01）从 `onLaunch` 中移除「登录后发放每日登录积分」的 `points.grantDailyLogin()` 调用（该职责迁至后端，见 `docs/迭代记录.md` 的 `6a24562` 条目）；
- `01e214a`（2026-10-11）**整体删除 `onLaunch`**，理由是启动时不得凭本地缓存判定已登录，改由 launch 页 `auth.ensureLogin()` 走后端 `/auth/me` 校验或静默 `wx.login`（`frontend/pages/launch/launch.js:57`）。

## 5. 输入与输出

- 输入：`setLoginUser(user)` 接收后端返回的用户对象（不做校验、不做字段裁剪，直接整体赋值）；`logout()` 无参。
- 输出：无返回值（两个方法均修改 `globalData` 副作用）；`logout()` 的持久化副作用由 `auth.clearLocalUser()` 承担。
- 异常：本文件不含任何 `try/catch`；`auth.clearLocalUser()` 内部的 Storage 异常处理见其实现文件。

## 6. 依赖关系

- **依赖（唯一）**：`frontend/services/auth.js`（`:1` `const auth = require('./services/auth');`），仅使用其 `clearLocalUser`。
- **被依赖**：微信框架在小程序启动时实例化；各页面通过 `getApp()` / `const app = getApp()` 读写 `globalData`。
- **绕过本文件直接写 `globalData` 的三处**（本文件并非唯一写入者，改动登录态语义时必须同步核对）：
  1. `frontend/services/auth.js:68-70`——登录/校验成功后 `app.globalData.user = user; app.globalData.loggedIn = !!user;`（启动页与静默重登走这条路径，**不经** `setLoginUser`）；
  2. `frontend/services/auth.js:242`——仅同步 `globalData.user`；
  3. `frontend/services/request.js:38-40`——`clearSession()` 中置 `user = null; loggedIn = false`，随后 `wx.reLaunch` 回启动页（401 静默重登仍失败时）。
- **读取方（示例，非穷举）**：`frontend/pages/home/home.js:116`、`frontend/pages/account/account.js:22`、`frontend/pages/bind/bind.js:38`、`frontend/pages/ceremony/ceremony.js:41` 均以 `if (!app.globalData.loggedIn)` 做子页登录守卫（对应 `frontend/AGENTS.md` §4 第 5 条「无全局路由守卫，子页自行判断」）。
- 不涉及后端接口、数据库表。

## 7. 业务规则

1. **`loggedIn` 的真值来源只有两条**：launch 页 `auth.ensureLogin()` 后端校验通过，或登录成功。本地 Storage 里存在 `lm_login_user`/`lm_auth_token` **不构成**已登录（`:6` 注释 + `frontend/AGENTS.md` §4 第 3 条）。因此冷启动瞬间 `loggedIn` 恒为 `false`，页面守卫在启动页完成校验前会把用户弹回 `/pages/launch/launch`——这是设计意图，不是缺陷。
2. **`logout()` 与 `clearSession()` 语义不同**：前者是用户主动退出（写 `lm_logged_out` 标记，之后需手动登录，落 `/pages/login/login`）；后者是 401 被动失效（`frontend/services/request.js:38-40`，落启动页并允许静默重登）。两者都清 `globalData`，但退出标记只有前者写。
3. **无全局定时器/网络订阅**：本文件不启动 WebSocket、不注册全局轮询；WS 连接生命周期在 `frontend/services/ws.js` 与首页（见 `.qoder/backend/app/api/routes/broadcast.py.md` §7 第 1 条对两通道的分工说明）。

## 8. 修改约束

1. **禁止在此加回 `onLaunch` 恢复本地登录态**——会直接推翻 `01e214a` 的修复（「失败可重试不假登录」）与 `frontend/AGENTS.md` §4 第 3 条不变量。
2. `globalData.user` / `loggedIn` 的**键名**被 25 个页面与多个 service 直接读取（§6），重命名属破坏性变更，须全仓 grep 同步。
3. 新增全局字段应在本文件 `globalData` 中**显式声明初值**，避免再出现 `activity` 那样的「服务层动态挂载、入口无声明」的隐式字段（§9 第 2 项）。
4. 不得在本文件写业务逻辑（登录流程在 `services/auth.js`、请求与 401 处理在 `services/request.js`）；分层约定见 `frontend/AGENTS.md` §3.1。
5. 本文件为 CommonJS（`require`），**不支持 ESM**（`frontend/AGENTS.md` §2 表「语言」行）。

## 9. 当前实现状态

- **已实现**：全局登录态容器 + `setLoginUser` / `logout` 两个方法，均有真实调用方（§4.2、§4.3）。
- **存在问题 / 已知事项**：
  1. `setLoginUser` **不是** `loggedIn` 的唯一写入通道，`services/auth.js:68-70` 与 `services/request.js:38-40` 直接赋值绕过它（§6）。方法名易被误读为「唯一置位入口」，是否收敛为单一写入函数**待确认**。
  2. `globalData.activity` 由 `services/activity.js:14` 动态挂载，本文件未声明（§4.1），入口文件无法反映 `globalData` 的完整形状。
  3. `frontend/AGENTS.md` §7「登录态」条描述 `app.globalData.user / loggedIn`「auth.js 登录/校验成功后自动同步」，与本文件代码一致；但同处「登出调 `app.logout()`」未提及 `request.js` 的被动 `clearSession()` 路径，文档覆盖面略窄（不影响代码正确性）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/app.js`，共 **5 个提交**。按时间倒序。

### 2026-10-11（`01e214a`，01:05）
- 需求：V1.0 启动页自动登录（后端校验 Token / 静默 `wx.login`、401 静默重登重试、失败可重试不假登录）并取消强制选组织。
- 修改内容（涉本文件）：**删除 `onLaunch` 整段**（原「恢复本地登录态」`this.globalData.user = auth.getLocalUser()`），并把 `loggedIn` 上方注释由「本地用户与 JWT 同时存在才视为已登录」改为「仅在后端校验 Token 通过（启动页 ensureLogin）或登录成功后置为 true，本地缓存不作数」（现 `:6`）。
- 关联文件：`frontend/pages/launch/launch.js`、`frontend/services/auth.js`、`frontend/services/request.js`、`frontend/app.json`。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目。

### 2026-10-02（`b467a8a`，14:32）
- 需求：移除 `util`/`store` 中零引用的 Mock 时代死代码。
- 修改内容（涉本文件）：从 `logout()` 中删除 `require('./services/store').clearCache();` 及其「清理内存数据缓存，避免下个用户读到脏数据」注释（内存数据缓存随 Mock 服务层一并废弃，`store.js` 此后仅保留 `migrateUserData`，见 `frontend/AGENTS.md` §3 目录树注释）。
- 关联文件：`frontend/utils/util.js`、`frontend/services/store.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `b467a8a` 条目。

### 2026-10-01（`6a24562`，17:53）
- 需求：服务层由本地 Mock 切换为后端真实接口，各页面改为异步加载并补错误提示。
- 修改内容（涉本文件）：从 `onLaunch` 中移除「登录后发放每日登录积分」逻辑（`require('./services/points').grantDailyLogin(...)`），每日登录积分改由后端在登录链路发放。
- 关联文件：`frontend/services/*.js`（全量服务层）、各页面 js。
- 测试结果：见 `docs/迭代记录.md` 的 `6a24562` 条目。

### 2026-10-01（`b0fd8b2`，10:31）
- 需求：小程序由本地 Mock 切换为真实后端接口（首批）。
- 修改内容（涉本文件）：仅改 `loggedIn` 上方注释文案（「是否已登录（本地 Mock 登录态）」→「本地用户与 JWT 同时存在才视为已登录」），无逻辑变更。
- 关联文件：`frontend/services/`（新建 request/config 等）。
- 测试结果：见 `docs/迭代记录.md` 的 `b0fd8b2` 条目。

### 2026-09-30（`a94e685`，18:05）
- 需求：项目初始化（`feat: init`）。
- 修改内容（涉本文件）：创建本文件，含 `globalData`、`onLaunch`（恢复本地登录态 + 发放每日登录积分）、`setLoginUser`、`logout`（含 `store.clearCache()`）。
- 关联文件：全仓初始骨架。
- 测试结果：初始提交，`docs/迭代记录.md` 的 `a94e685` 条目为该批次记录；本文件单独的验证结论**待确认**（提交信息未区分文件级验证）。
