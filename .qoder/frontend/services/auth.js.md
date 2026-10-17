# auth.js

## 1. 文件路径

`frontend/services/auth.js`（289 行）

## 2. 文件职责

微信登录与入驻服务：以 `wx.login` 的 code 识别微信身份，经后端 `/auth/login` 状态式换取 JWT（**仅已入驻且未停用的用户签发**）；提供启动页登录校验（`ensureLogin`）、401 静默重登（`relogin`，注册进 `request.js`）、邀请码校验与入驻（`verifyInvite`/`onboard`）、昵称修改（两个入口）、本地用户缓存与 `app.globalData` 同步、主动退出标记、头像持久化、邀请码暂存。文件头 docstring `:1-6` 自述该职责划分。

## 3. 业务需求

- `b0fd8b2`（2026-10-01）小程序切换真实后端时形成登录服务（`git log --follow` 显示本文件源于 `a94e685` 初始提交、`b0fd8b2` 切真实接口）。
- `f820e0e`（2026-10-01）「微信名称直登与昵称仅可修改一次」（`docs/迭代记录.md` 的 `f820e0e` 条目）→ `updateNickname`。
- `41607bb`（2026-10-01）组织选择页采集微信名作默认用户名、不消耗改名机会（`docs/迭代记录.md` 的 `41607bb` 条目）→ `setInitialNickname`。
- `01e214a`（2026-10-11）V1.0 启动页自动登录：后端校验 Token / 静默 wx.login / 并发 401 单次重登 / 退出不假登录（`docs/迭代记录.md` 的 `01e214a` 条目）→ `ensureLogin`/`relogin`/单飞机制。
- `afbcba9`（2026-10-12）邀请码准入全链路：`/auth/login` 改状态式返回 `{status: active|unregistered|disabled, token?, user?}`，**未入驻不再自动建号也不签发 Token**；新增 `/auth/invite/verify`（不核销）与 `/auth/onboard`（原子核销+建号）（`docs/迭代记录.md` 的 `afbcba9` 条目）→ `callLogin` 状态分支、`verifyInvite`、`onboard`、`lm_pending_invite`。
- `43898a2`（2026-10-12）修复首次入驻后「我的」页不回显组织：`updateLocalUser` 同步 `app.globalData.user`；`saveServerUser` 仅在后端组织一致时保留组织名（`docs/迭代记录.md` 的 `43898a2` 条目）。
- `a60b94b`（2026-10-14）`wx.login` fail 回调附带原始 errMsg（`docs/迭代记录.md` 的 `a60b94b` 条目）。
- 登录态语义与存储键的项目级约定见 `.qoder/ARCHITECTURE.md` §5.5；技术约定权威见 `frontend/AGENTS.md` §4 不变量 3/4/5/7。

## 4. 核心功能

### 4.1 存储键（`:10-12`）

| 键 | 常量 | 用途 | 读写点 |
|---|---|---|---|
| `lm_login_user` | `USER_KEY` | 后端 user 快照（页面展示与合并依据，**不代表已登录**，`:36` 注释） | 读 `:39`，写 `:60`、`:240`，删 `:251` |
| `lm_logged_out` | `LOGGED_OUT_KEY` | 用户主动退出标记，阻止静默重登 | 读 `:47`，删 `:106`、`:211`，写 `:253` |
| `lm_pending_invite` | `INVITE_KEY` | 扫码后暂存邀请码载荷，入驻成功/放弃时清除（`:256` 注释） | 写 `:259`，读 `:267`，删 `:212`、`:274` |
| `lm_auth_token` | 复用 `requestService.TOKEN_KEY` | JWT，**键名定义在 request.js:3**，本文件只写/删 | 写 `:101`、`:206`，删 `:154`、`:252` |

与 `.qoder/ARCHITECTURE.md` §5.5 存储键表一致；Storage 访问全部收敛在 services 层（同节「24 处 Storage 调用」）。

### 4.2 `persistAvatar(tempPath)`（`:18-34`，**未导出**）

头像持久化（`frontend/AGENTS.md` §4 不变量 4）：空值→`''`；已在 `wx.env.USER_DATA_PATH` 下→原样返回（`:21-22`）；`https://` 网络头像→原样返回（`:23`）；其余（工具 `http://tmp/`、真机 `wxfile://tmp_`）经 `FileSystemManager.saveFile` 转持久路径，失败降级返回原路径（`:24-32`）。由 `callLogin`（`:90`）与 `onboard`（`:190`）在提交后端**之前**调用。注意：`frontend/AGENTS.md` 不变量 4 写作「必须经 `auth.persistAvatar`」，但该函数不在 `module.exports`（`:277-289`），页面无法直接调用——实际约束通过「页面把临时头像交给 `wxLogin`/`onboard`，内部持久化」满足（`login.js:46`、`onboard.js:80` 传参）。

### 4.3 `callLogin(avatar)`（`:84-120`，内部核心，未导出）

登录主流程：`wx.login` 取 code（无 code 即 reject「微信登录失败」，`:89`）→ `persistAvatar` → `POST /auth/login {code, avatar}`（`skipAuthRetry: true`，`:92-97`，登录接口自身 401 不触发重登环）。响应三分支（`:99-114`）：

| `result.status` | 行为 |
|---|---|
| `active`（且有 token+user） | 写 `lm_auth_token`（`:101`）→ 本地旧用户 id 与新 id 不同时 `store.migrateUserData`（遗留 Mock 数据迁移，`:102-104`）→ `saveServerUser`（`:105`）→ 删 `lm_logged_out`（`:106`）→ resolve 用户 |
| `disabled` | reject `admissionError('disabled', '账号已停用，请联系活动管理员')`（`:109-111`） |
| 其余 | 一律按 `admissionError('unregistered', '尚未入驻')` reject（`:112-113`） |

`admissionError`（`:77-79`）= `Error` 附 `admission` 属性，启动页据此分流入驻页/准入拦截页（docstring `:4`；消费点 `launch.js:57` 起）。后端契约（状态式返回、公开接口不挂鉴权）见 `.qoder/backend/app/api/routes/auth.py.md` 与 `.qoder/backend/app/api/deps.py.md` §6.4；code2session 失败后端 502（`.qoder/ARCHITECTURE.md` §7）。

### 4.4 `wxLogin(profile)`（`:126-129`）

登录页手动登录入口：取 `profile.avatar` 转调 `callLogin`。仅已入驻用户能成功（`:123` 注释「兼容旧登录页」）；未入驻抛 `admission: 'unregistered'`，由页面提示。

### 4.5 `relogin()`（`:132-140`）——401 静默重登

- `lm_logged_out` 存在 → 直接 reject `{loggedOut: true}`（`:133`），**用户主动退出后绝不静默登录**（docstring `:5`）。
- 否则以模块级 `reloginPending`（`:14`）做**单飞去重**：并发调用共享同一个 `callLogin('')` Promise，只触发一次 `wx.login` + 一次 `/auth/login`（`:134-139`；`.qoder/ARCHITECTURE.md` §5.5）。静默重登不带头像（`''`）。
- `:164` `requestService.setReauthHandler(relogin)`：把本函数注册为 request.js 的 401 处理器，注入方式打破循环依赖（`request.js:9` 注释）。

### 4.6 `ensureLogin()`（`:143-162`）——启动页唯一登录判定

- 模块级 `ensurePending`（`:15`）单飞：启动页与重试按钮并发触发只执行一次（测试 A9，`frontend/test/auth-flow-check.cjs:150-153`）。
- 已退出或本地无 token → 直接 `relogin()`（`:146-147`）。
- 有 token → `GET /auth/me`（`skipAuthRetry: true`）经后端校验（`:149-151`），成功 `saveServerUser` 刷新本地快照；**401 → 删 token → `relogin()`**（`:152-156`）；非 401（admission/network）原样抛出交启动页处理（`:142` 注释、`:153`）。
- 这是「本地 Token 不经后端校验不得视为已登录」不变量的执行点（`frontend/AGENTS.md` §4 不变量 3；`app.js:6` 注释）。

### 4.7 `saveServerUser(serverUser, previousUser)`（`:54-63`）+ `syncApp`（`:65-75`）

以后端用户为准写 `lm_login_user` 并同步 `app.globalData.user/loggedIn`（`:65-71`）。**合并规则**：仅当旧缓存与新用户 `id` 且 `orgId` 均相同，保留旧缓存的 `orgName`/`orgFullName`（`:56-58`）——因后端 `UserOut` 不含组织名称（`43898a2`，`docs/迭代记录.md` 的 `43898a2` 条目）；组织变更后旧名称随之丢弃。App 未初始化时 try/catch 吞掉（`:72-74`）。

### 4.8 入驻链路

- `verifyInvite(inviteCode)`（`:167-174`）：`POST /auth/invite/verify`（公开接口、**不核销**，`:166` 注释；后端带 60s/60 次/IP 限流，`docs/迭代记录.md` 的 `afbcba9` 条目），返回 `{name, orgId, orgName}`。启动页扫码后调用（`launch.js:90`）。
- `onboard(params)`（`:180-220`）：重新 `wx.login` 取新 code（`:187`）→ `persistAvatar` → `POST /auth/onboard {code, inviteCode, nickname, orgId, avatar}`（`skipAuthRetry`，`:191-203`）→ 成功写 token、按需 `migrateUserData`、`saveServerUser`、删 `lm_logged_out` 与 `lm_pending_invite`，resolve `{user, created}`（`:205-214`）。**幂等**：已入驻身份重复提交由后端返回同一用户（`:177-178` 注释；后端为事务内条件 UPDATE 原子核销、openid 冲突回滚复用，`docs/迭代记录.md` 的 `afbcba9` 条目）。
- `savePendingInvite`/`readPendingInvite`/`clearPendingInvite`（`:257-275`）：邀请码暂存三件套，写读均有 try/catch 降级；载荷由 `launch.js:92` 写入（`{code, orgId, orgName}`，见 `.qoder/ARCHITECTURE.md` §5.5 表）、`onboard.js:23` 读取。

### 4.9 昵称与本地用户维护

- `updateNickname(nickname)`（`:223-227`）：`PUT /auth/nickname`，**每人仅一次、后端校验**（`:222` 注释；`f820e0e`）；成功用返回用户 `updateLocalUser` 合并。
- `setInitialNickname(nickname)`（`:230-234`）：`PUT /auth/nickname/initial`，首次引导采集微信名，**不消耗唯一改名机会**（`:229` 注释；`41607bb`；`frontend/AGENTS.md` §4 不变量 7）。
- `updateLocalUser(patch)`（`:237-247`）：合并 patch 写 `lm_login_user` 并同步 `app.globalData.user`，**刻意不改 `loggedIn`**（`:236` 注释；`.qoder/ARCHITECTURE.md` §5.5「登录态语义」）；异常返回 `null`。
- `clearLocalUser()`（`:250-254`）：主动退出——删 user+token 两键、写 `lm_logged_out=1`；由 `app.js:22` 的 `app.logout()` 调用（`frontend/AGENTS.md` §7「登出调 app.logout()」）。

### 4.10 导出（`:277-289`）

11 个：`wxLogin`、`ensureLogin`、`verifyInvite`、`onboard`、`updateNickname`、`setInitialNickname`、`updateLocalUser`、`clearLocalUser`、`savePendingInvite`、`readPendingInvite`、`clearPendingInvite`。**grep 确认全部有调用方（§6），零调用导出为 0 个**；`persistAvatar`/`callLogin`/`relogin`/`saveServerUser`/`syncApp`/`admissionError`/`readLocalUser`/`isLoggedOut` 均为内部函数未导出（`relogin` 经 `setReauthHandler` 间接暴露给 request.js）。

## 5. 输入与输出

| 函数 | 输入 | 成功输出 | 失败输出（reject） |
|---|---|---|---|
| `wxLogin` | `{avatar?}` | 用户对象（含 `id/nickname/avatar/orgId` 等后端字段 + 可能保留的 `orgName/orgFullName`） | `admission:'unregistered'/'disabled'`；`wx.login` 失败「微信登录失败：<errMsg>」（`:117`）；后端 502/网络错误经 request.js 归一 |
| `ensureLogin` | — | 同上（`/auth/me` 或重登结果） | 同上 + `loggedOut:true`（已退出）；非 401 错误原样透传 |
| `verifyInvite` | `inviteCode: string` | `{name, orgId, orgName}`（`:166` 注释） | 后端 400（邀请码无效，`.qoder/ARCHITECTURE.md` §4.3）等 |
| `onboard` | `{inviteCode, nickname, orgId, avatar?}` | `{user, created}`（`:213`） | 后端 400（邀请码无效/已被核销等）；`wx.login` 失败 |
| `updateNickname` / `setInitialNickname` | `nickname: string` | 合并后的本地用户对象 | 后端 400（已改过名/昵称非法） |
| `updateLocalUser` | `patch: object` | 新用户对象；Storage 异常返回 `null`（`:245`） | 不 reject |
| `clearLocalUser` / `savePendingInvite` / `clearPendingInvite` | —/payload/— | 无返回值 | 不 reject（写失败静默，`:260-262`） |
| `readPendingInvite` | — | 载荷或 `null` | 不 reject |

**注意**：JWT 本身从不出现在返回值中，只写入 `lm_auth_token`；文档与代码均不记录任何真实 token/openid 值（`.qoder/README.md` §3 规则 14）。

## 6. 依赖关系

- **上游**：`services/request.js`（`request`/`getToken`/`TOKEN_KEY`/`setReauthHandler`，`:7`、`:146`、`:101` 等）；`services/store.js`（仅 `migrateUserData` 遗留迁移，`:8`、`:103`、`:208`）；wx API（`wx.login`/`wx.getFileSystemManager`/Storage 三件套）；`getApp().globalData`。
- **后端接口**（6 个）：`POST /auth/login`、`GET /auth/me`、`POST /auth/invite/verify`、`POST /auth/onboard`、`PUT /auth/nickname`、`PUT /auth/nickname/initial`——路由契约见 `.qoder/backend/app/api/routes/auth.py.md`；前三个中 login/verify/onboard 为公开接口（`.qoder/backend/app/api/deps.py.md` §6.4）。
- **被依赖（grep 实测，页面 6 + app.js）**：
  - `pages/launch/launch.js:15`（`:57` `ensureLogin`、`:90` `verifyInvite`、`:92` `savePendingInvite`、`:98` `clearPendingInvite`）；
  - `pages/login/login.js:7`（`:46` `wxLogin({avatar})`）；
  - `pages/onboard/onboard.js:5`（`:80` `onboard`、`:23` `readPendingInvite`、`:89` `updateLocalUser`、`:106` `clearPendingInvite`）;
  - `pages/org-select/org-select.js:15`（`:159` `setInitialNickname`、`:61`、`:164` `updateLocalUser`）；
  - `pages/mine/mine.js:7`（`:132` `updateNickname`、`:45` `updateLocalUser`）；
  - `app.js:1`（`:22` `logout()` 内调 `clearLocalUser`）。
  - 间接：所有 service 经 `request.js` 的 401 链依赖本文件 `relogin`（`request.js:147`）。
- **测试**：`frontend/test/auth-flow-check.cjs`（假宿主状态机，11 项：首登/过期 Token/wx.login 失败/并发单飞/退出拦截等，`docs/迭代记录.md` 的 `01e214a` 条目）；automator `frontend/test/automator/v1-auto-login.cjs`（真实 wx.login E2E）。

## 7. 业务规则

1. **仅已入驻用户获得 JWT**：`/auth/login` 状态式返回，未入驻不建号不发 token（`afbcba9`）；本文件把非 active 一律转 `admission` 错误，**进入驻页还是拦截页由上层（启动页）决定**（docstring `:4`），服务层不做页面跳转。
2. **静默重登三禁**：已主动退出（`lm_logged_out`）不重登（`:133`）；未入驻/已停用重登必失败并抛 admission（由 request.js `:153-157` 清会话）；重登时网络异常**保留会话**不踢下线（request.js 侧规则）。
3. **单飞并发合并**：`reloginPending`/`ensurePending` 保证并发 401 或并发启动校验只产生一次 `wx.login` + 一次后端登录调用（`:14-15`；验证记录 `docs/迭代记录.md` 的 `01e214a` 条目 A9 用例）。
4. **登录态判定以后端为准**：`ensureLogin` 有 token 必先 `GET /auth/me` 校验，401 才换 code 重登（`:149-156`）；`app.globalData.loggedIn` 只在本文件 `syncApp`（登录/校验成功）置 true，`updateLocalUser` 不改（`frontend/AGENTS.md` §4 不变量 3）。
5. **改名机会唯一**：`updateNickname` 每人一次由后端校验；`setInitialNickname` 是独立的首次采集通道，不消耗该机会（`:222`、`:229` 注释；不变量 7）。
6. **组织名称本地保留策略**：后端 user 不含 `orgName/orgFullName`，仅在 id+orgId 均未变时从旧缓存保留（`:56-58`），组织变更后必须由 org-select 页重新 `updateLocalUser` 回填（`org-select.js:61`、`:164`；`43898a2`）。
7. **账号切换迁移**：登录/入驻得到的新 user.id 与本地旧缓存不同时调 `store.migrateUserData`（`:102-104`、`:207-209`），迁移遗留 `lm_data_{userId}` Mock 数据（`.qoder/ARCHITECTURE.md` §5.5「遗留」行）。
8. **头像必须持久化后再上送**：`callLogin`/`onboard` 均先 `persistAvatar` 再发请求（`:90`、`:190`），否则重启丢头像（不变量 4）。

## 8. 修改约束

1. `:164` 的 `setReauthHandler(relogin)` 是 request.js 401 链的**唯一注入点**，删除或改为异步注册会使全部接口 401 时直接 `clearSession`（`request.js:143-146`）。
2. `relogin`/`ensureLogin` 的单飞变量（`:14-15`）与 `finally` 复位不得移除——`frontend/test/auth-flow-check.cjs` 的 A9「并发只登录一次」是既有回归项。
3. `/auth/login` 请求带 `skipAuthRetry: true`（`:95`）：登录接口自身 401/失败不得再触发重登环；`/auth/me`（`:150`）、`/auth/invite/verify`（`:171`）、`/auth/onboard`（`:195`）同理。新增登录前接口必须带此开关。
4. `lm_logged_out` 语义（写=退出、登录成功删=恢复静默登录，`:106`、`:211`、`:253`）与 `app.logout()`、启动页行为三方耦合，改键名或语义须同步 `app.js` 与 `launch.js`。
5. `saveServerUser` 的 orgName 保留条件（id+orgId 双相同）是 `43898a2` 缺陷修复成果，放宽会导致组织变更后回显旧组织名。
6. 后端 `{status, token, user}` 登录响应结构是硬契约（`.qoder/backend/app/api/routes/auth.py.md`），新增状态值必须同步 `:100-113` 的分支，否则会被兜底当作 `unregistered`。
7. 不得在任何日志/文档输出真实 token、openid（`.qoder/README.md` §3 规则 14）；code、session_key 均不落前端存储（session_key 只存在于后端，`.qoder/ARCHITECTURE.md` §7）。

## 9. 当前实现状态

- **已实现**：启动校验、静默重登（单飞）、手动登录、邀请码校验/入驻（幂等）、双昵称通道、本地缓存与全局态同步、主动退出、头像持久化、邀请码暂存。11 个导出函数 grep 确认**全部有调用方，无死导出**。
- **存在问题 / 已知事项（事实陈述）**：
  1. `frontend/AGENTS.md` §4 不变量 4 写「必须经 `auth.persistAvatar`」，但 `persistAvatar` **未导出**（§4.2），页面实际经 `wxLogin`/`onboard` 入参间接满足；AGENTS 措辞与导出面不符，属文档表述问题（本目录只记录事实，不改 AGENTS）。
  2. `onboard` 成功分支不检查 `result.token` 是否存在即写 Storage（`:206`，对比 `callLogin:100` 的三字段校验）；后端正常返回时不构成问题，异常响应会把 `undefined` 写入 `lm_auth_token`——现状事实，是否需要加同款校验**待确认**。
  3. `callLogin`/`onboard` 的 `wx.login` success 回调内错误经 Promise 链上抛，但 `wx.login` 本身**无超时控制**，依赖微信客户端行为；弱网下启动页停留时长无前端上限——现状事实。
- **待开发**：无（补签等无关本文件）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/auth.js`（**8 个提交**）与 `docs/迭代记录.md` 对应条目。按时间倒序。

### 2026-10-14（`a60b94b`）
- 需求：网络/登录异常透出详细原因。
- 修改内容（涉本文件）：两处 `wx.login` 的 fail 回调由固定文案改为附带原始 errMsg（`:117`、`:217`）（`docs/迭代记录.md` 的 `a60b94b` 条目）。
- 关联文件：`services/request.js`、`pages/launch/launch.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `a60b94b` 条目。

### 2026-10-12（`43898a2`）
- 需求：修复首次入驻后「我的」页不回显组织。
- 修改内容（涉本文件）：`updateLocalUser` 同步 `app.globalData.user`（`:241-242`）；入驻页仅在后端组织一致时回填组织名（配套 `saveServerUser` 保留条件，`:56-58`）（`docs/迭代记录.md` 的 `43898a2` 条目）。
- 关联文件：`pages/onboard/onboard.js`、`pages/org-select/org-select.js`。
- 测试结果：`node --check` 通过；Node 假宿主调用链验证；automator `onboard-org-echo.cjs` 回显正确（`docs/迭代记录.md` 的 `43898a2` 条目，报告 `frontend/test/docs/onboard-org-echo-report.md`）。

### 2026-10-12（`afbcba9`）
- 需求：邀请码准入全链路。
- 修改内容（涉本文件）：`callLogin` 改状态式三分支（active/disabled/unregistered）；新增 `verifyInvite`、`onboard`、`lm_pending_invite` 三件套与 `admissionError`（`docs/迭代记录.md` 的 `afbcba9` 条目）。
- 关联文件：后端 015 迁移、`routes/auth.py`、`pages/launch`/`pages/onboard`（新增）。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目（后端 s19 25/25 等）。

### 2026-10-11（`01e214a`）
- 需求：V1.0 启动页自动登录，取消强制选组织。
- 修改内容（涉本文件）：新增 `ensureLogin`（/auth/me 校验 + 401 换 code 重登）、`relogin` 单飞、`lm_logged_out` 拦截与 `setReauthHandler` 注册（`docs/迭代记录.md` 的 `01e214a` 条目）。
- 关联文件：`services/request.js`、`pages/launch/launch.js`、`frontend/test/auth-flow-check.cjs`（新增）。
- 测试结果：`node test/auth-flow-check.cjs` 11/11；automator `v1-auto-login.cjs` 两轮 6/6（真实 wx.login、13 次登录库中仅 1 用户）；真机扫码当时待验证（`docs/迭代记录.md` 的 `01e214a` 条目）。

### 2026-10-01（`41607bb`）
- 需求：组织选择页采集微信名作新用户默认用户名（不消耗改名机会）。
- 修改内容（涉本文件）：新增 `setInitialNickname` → `PUT /auth/nickname/initial`（`:230-234`）（`docs/迭代记录.md` 的 `41607bb` 条目）。
- 关联文件：`pages/org-select/org-select.js`、后端 `routes/auth.py`。
- 测试结果：该条目未记录验证字段，待确认。

### 2026-10-01（`f820e0e`）
- 需求：微信名称直登与昵称仅可修改一次（三端）。
- 修改内容（涉本文件）：新增 `updateNickname` → `PUT /auth/nickname`，成功后合并本地登录态（`:223-227`；`docs/迭代记录.md` 的 `f820e0e` 条目及 `frontend/test/docs/nickname-change-test-report.md`）。
- 关联文件：后端 `routes/auth.py`、admin 排名洞察。
- 测试结果：见 `docs/迭代记录.md` 的 `f820e0e` 条目。

### 2026-10-01（`b0fd8b2`）
- 需求：小程序由本地 Mock 切换为真实后端接口。
- 修改内容（涉本文件）：登录服务改走 `POST /api/auth/login` 真实接口（提交信息；该条目在 `docs/迭代记录.md` 仅有标题行）。
- 关联文件：全部 `services/*.js`。
- 测试结果：待确认（条目无验证字段）。

### 2026-09-30（`a94e685`）
- 需求：项目初始化。
- 修改内容（涉本文件）：创建本文件（当时为 Mock 登录实现，`b0fd8b2` 切真实接口）。
- 关联文件：仓库初始代码全量。
- 测试结果：待确认（`docs/迭代记录.md` 的 `a94e685` 条目仅「仓库初始代码」）。
