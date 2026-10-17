# onboard.js（入驻页 · 页面级合一：onboard.js / onboard.wxml / onboard.wxss / onboard.json）

## 1. 文件路径

- `frontend/pages/onboard/onboard.js`（109 行）
- `frontend/pages/onboard/onboard.wxml`（30 行）
- `frontend/pages/onboard/onboard.wxss`（113 行）
- `frontend/pages/onboard/onboard.json`（5 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

**邀请码入驻信息收集页**（`onboard.js:1-4` 头注释）：启动页校验邀请码通过后落地，采集「真实姓名 + 所属组织」，提交 `auth.onboard`（`POST /auth/onboard`）一次性完成邀请码核销 + 建号 + 签发 Token，成功后进入首页。组织选择**不内嵌**，跳 `org-select` 的 pick 模式并经 eventChannel 回传（`:47-64`）；带组织范围的专属邀请码只能在该组织及其下级中选择（`:3` 注释，范围锁定实现在 org-select 侧）。

**入口证据**：生产环境唯一入口是启动页 `wx.redirectTo('/pages/onboard/onboard?invite=CODE[&rootId=&rootName=]')`（`frontend/pages/launch/launch.js:19`、`:95`）；本页在 `app.json:24` 注册（非 tab 页）。automator 测试直接 reLaunch 进入（`frontend/test/automator/onboard-org-echo.cjs:7`）。

## 3. 业务需求

- `afbcba9`（2026-10-12）「邀请码准入全链路」创建本页（`git log --diff-filter=A` 实测本目录首个提交；`docs/迭代记录.md` 的 `afbcba9` 条目）——准入模型「不自动建号、凭邀请码入驻」的小程序侧收集端，后端契约见 `.qoder/backend/app/api/routes/auth.py.md` §4.2。
- `43898a2`（2026-10-12）「修复首次入驻后『我的』页不回显组织」——成功分支按组织一致性条件回填本地组织名（`:87-93`；`docs/迭代记录.md` 的 `43898a2` 条目）。
- 姓名「入驻后可在『我的』页修改一次」的提示（WXML `:12`）对应后端唯一改名机会规则（`.qoder/backend/app/api/routes/auth.py.md` §4.3）。

## 4. 核心功能（onboard.js）

### 4.1 `data` 状态字段（`:8-18`，按关注点分组）

| 分组 | 字段 | 来源 |
|---|---|---|
| 邀请码 | `inviteCode`（`:9`） | query `invite` 优先，`lm_pending_invite` 暂存兜底（`:22-24`） |
| 组织范围（专属码） | `rootId` / `rootName`（`:14-15`） | query `rootId/rootName` 优先，pending 暂存兜底（`:30-31`） |
| 已选组织 | `orgId` / `orgName` / `orgFullName`（`:11-13`） | 初值预设为范围根（`:37-39`）；org-select 回传覆写（`:57-61`） |
| 表单 | `nickname`（`:10`） | 姓名输入（`:43-45`） |
| UI 状态 | `submitting` / `errorMsg`（`:16-17`） | 提交防重入与错误提示（`:78`、`:98-101`） |

### 4.2 生命周期：仅 `onLoad`（`:20-41`），无 onShow/onHide/onUnload

`onLoad` 双源恢复入驻上下文：query 参数（启动页 redirectTo 携带）+ `auth.readPendingInvite()`（`:23`，Storage 键 `lm_pending_invite`，由 `launch.js:92` 写入——本页不直接读 Storage，经 auth.js 封装，符合 `frontend/AGENTS.md` §3.1）。**无任何邀请码时 `wx.redirectTo` 退回启动页**由其显示准入拦截（`:25-29` 及行注释）。专属码（带 orgId）默认预选范围根组织（`:36-39` 注释「后端允许，可在下级继续细化」）。表单页无后端读接口，不适用「onShow + refresh」不变量（该不变量针对数据展示页，`frontend/AGENTS.md` §4 不变量 1）。

### 4.3 事件处理与页面跳转（全部出口）

| 方法 | 行号 | 跳转 | 说明 |
|---|---|---|---|
| `onNickInput` | `:43-45` | — | 姓名输入写 `nickname` |
| `onPickOrg` | `:47-65` | `navigateTo /pages/org-select/org-select?from=onboard[&rootId=&rootName=]` | pick 模式选组织；`events.orgPicked` 回传 `{orgId, orgName, orgFullName}` 覆写已选组织（`:55-63`；发射方 `frontend/pages/org-select/org-select.js:152`，pick 模式栈底锁定 rootId 不许越级回跳 `org-select.js:34-41`、`:112-115`、`:139-143`） |
| `onSubmit` | `:67-103` | 成功后 `switchTab /pages/home/home`（延迟 600ms，`:95`） | 见 §4.4 |
| `onCancel` | `:105-108` | `redirectTo /pages/launch/launch` | 先 `auth.clearPendingInvite()`（`:106`）再退回 |

### 4.4 `onSubmit()`（`:67-103`）——提交入驻

1. **防重入**：`submitting` 为真直接 return（`:68`）。
2. **前端校验两条**：姓名 trim 后非空（`:69-72`）、必须已选组织（`:74-76`）——**入驻场景组织为必选**，与登录后「组织选填、仅引导卡提示」（`frontend/AGENTS.md` §4 不变量 5）口径不同；校验失败写 `errorMsg` 不发请求。
3. `auth.onboard({inviteCode, nickname, orgId, avatar: ''})`（`:79-85`）：服务层内部重新 `wx.login` 取新 code → `POST /auth/onboard`（`frontend/services/auth.js:180-220`；后端在同一事务内校验组织范围、原子核销、建号、签发 Token，**幂等**——已入驻身份重复提交返回同一用户，`.qoder/backend/app/api/routes/auth.py.md` §4.2）。**页面自身零 Storage 写入**，token 落库、`lm_logged_out`/`lm_pending_invite` 清除、`app.globalData` 登录态置位全部在 auth.js 内完成（`auth.js:205-213`）。
4. **成功分支**（`:86-96`）：仅当 `res.user.orgId === this.data.orgId`（后端组织与所选一致）才 `auth.updateLocalUser({orgName, orgFullName})` 回填组织名（`:87-93`，行注释「已入驻身份重复提交时后端保留原组织」——`43898a2` 修复点，后端 `UserOut` 不含组织名，`.qoder/frontend/services/auth.js.md` §4.7）；toast 按 `res.created` 区分「入驻成功/欢迎回来」（`:94`）；`setTimeout` 600ms 后 `switchTab` 首页（`:95`，唯一定时器，无清理，§9 第 2 条）。
5. **失败分支**（`:97-102`）：复位 `submitting` 并展示 `err.message`（后端 400 具体原因如「所选组织不在邀请码允许的范围内」「邀请码使用次数已满」、403 停用、429 限流、502 微信换取失败，错误码全集见 `.qoder/backend/app/api/routes/auth.py.md` §4.2/§5）或兜底「入驻失败，请重试」。

## 4-1. WXML 专章（onboard.wxml，30 行）

- **页头**（`:2-5`）：标题「完善入驻信息」+ 副标题「扫码邀请已通过…」——即本页只应在邀请码校验通过后到达（与 `:25-29` 的无码退回逻辑呼应）。
- **表单卡**（`:7-29`）四块：
  1. 姓名行（`:8-11`）：`<input type="nickname">` 微信昵称快捷填入（`:10`，`maxlength="20"`），`bindinput="onNickInput"`；hint「入驻后可在『我的』页修改一次」（`:12`）。
  2. 组织行（`:14-20`）：整行 `bindtap="onPickOrg"`，已选显示 `orgFullName`、未选显示占位「选择所属组织」+ `›` 箭头；专属码时 hint「本邀请码仅可在「{{rootName}}」及其下级中选择」（`:21`，`wx:if="{{rootName}}"`）。
  3. 错误条（`:23`）：`wx:if="{{errorMsg}}"`。
  4. 按钮（`:25-28`）：提交按钮 `disabled/loading="{{submitting}}"`、文案随 submitting 切「提交中…/完成入驻」；取消按钮 `bindtap="onCancel"`。
- 必填星号 `*` 标注姓名与组织两项（`:9`、`:15`）；表达式无原生方法调用、无列表（`frontend/AGENTS.md` §5.2）。

## 4-2. WXSS 专章（onboard.wxss，113 行）

- 米黄底 `#F7F1E5`（`:3`）+ 白色圆角表单卡带浅阴影（`:25-30`）；标题主色 `#C8102E`（`:15`）。
- 行分隔线 `#F0E7D4`（`:34`）；`.row` 纵向排布（`:32-38`），组织行 `.row-link` 改横向两端对齐（`:40-44`）。
- 状态色：占位组织名 `#B6AEA0`（`:82-85`）、错误条淡红底红字（`:92-99`）、取消按钮透明底灰字（`:106-113`）；`.btn-primary` 复用全局（`frontend/app.wxss`，WXML `:25`）。
- **选择器逐一核对：无死选择器**（wxss 全部 18 个类均在 wxml 中出现，两文件已通读）。单位全 rpx。

## 4-3. JSON 专章（onboard.json，5 行）

`navigationBarTitleText: "完善入驻信息"`（`:2`，与全局默认「长征运动」不同，**有效声明**）+ 导航栏红底白字两键（`:3-4`，与 `app.json:29-35` 全局一致，冗余）。无 `usingComponents`。

## 5. 输入与输出

- **入参（`onLoad(options)`，`:20-41`）**：`invite`（邀请码，必填——无码退回启动页）、`rootId`/`rootName`（专属码组织范围根，可选，URL 编码）；兜底源 `lm_pending_invite` 载荷 `{code, orgId, orgName}`（写入方 `launch.js:92`）。
- **出参（调用的 service 与后端路径）**：

| service 调用 | onboard.js 行号 | 后端路径 / 副作用 |
|---|---|---|
| `auth.readPendingInvite()` | `:23` | 无请求；读 Storage `lm_pending_invite` |
| `auth.onboard(params)` | `:80-85` | `wx.login` + `POST /api/auth/onboard`（`frontend/services/auth.js:180-220`；后端核销邀请码、建 `users` 行、写审计、签发 7 天 JWT，`.qoder/backend/app/api/routes/auth.py.md` §4.2） |
| `auth.updateLocalUser(patch)` | `:89-92` | 无请求；合并写 `lm_login_user` 并同步 `app.globalData.user`（不改 `loggedIn`，`.qoder/frontend/services/auth.js.md` §4.9） |
| `auth.clearPendingInvite()` | `:106` | 无请求；删 `lm_pending_invite` |

- **输出（成功）**：`auth.onboard` resolve `{user, created}`；token 由 auth.js 写 `lm_auth_token`、登录态经 `saveServerUser → syncApp` 置 `app.globalData.loggedIn = true`（`auth.js:205-213`、`:65-71`）——本页返回时首页守卫即放行。
- **错误出口**：统一 `errorMsg` 表单内展示（`:98-101`），不用 toast/modal。

## 6. 依赖关系

- **require（`:5`）**：仅 `services/auth` 一项，4 个函数调用（§5 表）。零直接 `wx.request`、零直接 Storage（均经 auth.js，`frontend/AGENTS.md` §3.1）。
- **被依赖**：`app.json:24` 注册；`launch.js:19`/`:95` 唯一生产入口。
- **协作页**：`org-select`（pick 模式，`from=onboard` + eventChannel `orgPicked` 契约，`:53-63` ↔ `org-select.js:152`）；成功后落地 `home`（tab）。
- **后端表（经接口，不直接触库）**：`invite_codes`（条件 UPDATE 核销）、`users`（建号）、`user_identities`、`audit_logs`（`.qoder/backend/app/api/routes/auth.py.md` §6）。

## 7. 业务规则

1. **无邀请码不得入驻**：query 与 pending 双源都取不到码即退回启动页（`:25-29`）；准入拦截的展示责任在启动页（`launch.js:84-86`）。
2. **姓名 + 组织双必填**（`:70-76`）：入驻时组织必选（后端另有组织范围校验 400，`.qoder/backend/app/api/routes/auth.py.md` §4.2）；这与登录用户「组织选填」不冲突——不变量 5 禁止的是**登录后**强制跳组织选择（`frontend/AGENTS.md` §4）。
3. **组织范围锁定**：专属码的 `rootId/rootName` 传给 org-select 限定可下钻范围（`:50-52`），本页只透传不校验，越界拦截在后端（`ensure_org_in_scope`，auth.py.md §4.2）。
4. **幂等重入**：中途退出重扫/重复提交由后端返回同一用户，`created=false` 时 toast「欢迎回来」（`:94`）；此时后端保留原组织，故组织名回填必须核对 `res.user.orgId`（`:88` 行注释，`43898a2`）。
5. **取消即清暂存**：`onCancel` 先 `clearPendingInvite` 再退回（`:106-107`），防止废弃邀请码残留 Storage；入驻成功路径的清除在 auth.js 内（`auth.js:212`）。
6. **头像不采集**：本页固定传 `avatar: ''`（`:84`），头像采集属登录页 `chooseAvatar` 契约（`frontend/AGENTS.md` §4 不变量 7）。

## 8. 修改约束

1. **`orgPicked` 回传结构 `{orgId, orgName, orgFullName}` 是与 org-select 的双向硬契约**（`:56-61` ↔ `org-select.js:152`），改字段两页同步。
2. **query 参数名 `invite/rootId/rootName` 与启动页拼接侧绑定**（`launch.js:93-94`），改名两页同步；`lm_pending_invite` 载荷同理（§6）。
3. **组织名回填条件 `res.user.orgId === this.data.orgId` 不得放宽**：`43898a2` 修复成果，后端 user 不含组织名，条件回填是「我的」页回显正确性的前提（`.qoder/frontend/services/auth.js.md` §8 第 5 条同口径）。
4. **页面不得直接写 Storage**：token/user/pending 三键全部经 auth.js（`frontend/AGENTS.md` §3.1、§6.5）。
5. 后端 `OnboardResponse`（`token/user/created`）结构是硬契约（`.qoder/backend/app/api/routes/auth.py.md` §8 第 2 条），`created` 驱动 toast 文案（`:94`）。
6. `type="nickname"` 输入与「改名仅一次」提示文案（WXML `:10`、`:12`）对应后端两个昵称端点语义（auth.py.md §4.3），改文案先核对规则。

## 9. 当前实现状态

- **已实现**：邀请码双源恢复、无码退回、姓名/组织双必填校验、org-select pick 模式选择与回传、幂等入驻提交、组织名条件回填、成功进首页/取消退回。2 个提交（§10）。
- **存在问题 / 已知事项（事实陈述）**：
  1. **「token 未校验即写 Storage」的确切结论（对前序疑虑的核实与关闭）**：**属实，但代码位置不在本页**——`onboard.js` 自身零 Storage 写入（全文核实），token 写入发生在 `auth.onboard` 内部的 `frontend/services/auth.js:206`：`wx.setStorageSync(requestService.TOKEN_KEY, result.token)` **不检查 `result.token` 是否存在**（对比同文件 `callLogin` 的三字段校验 `result.status === 'active' && result.token && result.user`，`auth.js:100`）。后果：后端异常 2xx（缺 token）会把 `undefined` 写入 `lm_auth_token`；若连 `user` 也缺失，`saveServerUser`（`auth.js:210`）抛 TypeError → 走本页 `:97-102` 显示「入驻失败」。正常契约下不触发——后端 200 恒返回 `token/user/created`（`.qoder/backend/app/api/routes/auth.py.md` §5）。该事项已登记于 `.qoder/frontend/services/auth.js.md` §9 第 2 条（是否补校验**待确认**），本页无需改动，疑虑至此关闭。
  2. **成功跳转的 `setTimeout` 600ms 无清理**（`:95`）：本页无 `onUnload`；600ms 内用户若被其他跳转带走，定时器仍会触发 `switchTab` 首页——一次性短延时，现状事实。
  3. `submitting` 只在失败分支复位（`:99`），成功分支不复位——页面 600ms 后即离开且按钮已 disabled，无实际影响（现状事实）。
  4. 姓名前端限长 20（WXML `:10`）严于后端 1-64（auth.py.md §5），不构成冲突。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --oneline -- frontend/pages/onboard`（**2 个提交**，创建提交经 `--diff-filter=A` 核实），与 `docs/迭代记录.md` 对应条目交叉。按时间倒序。

### 2026-10-12（`43898a2`，16:26）
- 需求：修复首次入驻后「我的」页不回显组织。
- 修改内容（涉本文件）：成功分支新增「后端组织一致才回填组织名」的条件 `updateLocalUser`（`:87-93`；配套 auth.js `updateLocalUser` 同步 `app.globalData.user`，`.qoder/frontend/services/auth.js.md` §10 将本页列为关联文件）。
- 关联文件：`frontend/services/auth.js`、`frontend/pages/org-select/org-select.js`。
- 测试结果：`node --check` 通过；Node 假宿主调用链验证；automator `onboard-org-echo.cjs` 回显正确（`docs/迭代记录.md` 的 `43898a2` 条目，报告 `frontend/test/docs/onboard-org-echo-report.md`）。

### 2026-10-12（`afbcba9`，14:49）
- 需求：邀请码准入全链路——小程序扫码准入与入驻信息收集。
- 修改内容（涉本文件）：**创建本页**（`git log --diff-filter=A` 实测本目录首个提交）——姓名/组织表单、org-select pick 模式对接、`auth.onboard` 提交与无码退回；同批交付启动页分流、后端 `/auth/invite/verify` 与 `/auth/onboard`、admin 邀请码管理（提交信息）。
- 关联文件：`frontend/pages/launch/launch.js`、`frontend/pages/org-select/org-select.js`、`frontend/services/auth.js`、`backend/app/api/routes/auth.py`、`docker/init/015_*.sql`。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目（后端 s19 功能/权限/脱敏 25/25 + 真实 openGauss 并发 3/3）。
