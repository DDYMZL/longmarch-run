# launch.js（启动页 · 页面级合一：launch.js / launch.wxml / launch.wxss / launch.json）

## 1. 文件路径

- `frontend/pages/launch/launch.js`（171 行）
- `frontend/pages/launch/launch.wxml`（25 行）
- `frontend/pages/launch/launch.wxss`（94 行）
- `frontend/pages/launch/launch.json`（5 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

小程序**冷启动唯一闸门**兼**邀请码扫码落地页**（`launch.js:1-14` 头注释）：`app.json` `pages` 数组第 1 位（`frontend/app.json:3`），冷启动默认落在本页。由于 `frontend/app.js` **没有任何生命周期钩子**（无 `onLaunch`，`.qoder/frontend/app.js.md` §4.4），「本地 Token 不经后端校验不得视为已登录」的启动校验（`frontend/AGENTS.md` §4 不变量 3）整体落在本页：调 `auth.ensureLogin()` 后端校验/静默重登（`launch.js:57`），按结果分流到首页、登录页、入驻页、活动状态页或本页拦截态；未入驻用户从本页扫邀请码进入入驻链路（`:82-107`）。

## 3. 业务需求

- `01e214a`（2026-10-11）「V1.0 启动页自动登录（后端校验 Token/静默 wx.login、401 静默重登重试、失败可重试不假登录）并取消强制选组织」——本页由该提交创建（`git log --diff-filter=A` 实测；`docs/迭代记录.md` 的 `01e214a` 条目）。
- `afbcba9`（2026-10-12）「邀请码准入全链路」——未入驻分流、邀请码校验与入驻页跳转（`:82-107`；前后端时序见 `.qoder/backend/app/api/routes/auth.py.md` §4.2）。
- `44eb77b`（2026-10-13）V2.0「活动状态页与查看拦截」——进入首页前的 `allowView` 预检（`:109-121`；`.qoder/frontend/services/activity.js.md` §6 列 `launch.js:112` 为调用方）。
- `a60b94b`（2026-10-14）网络异常透出详细原因——`:76-79` 行注释「网络类错误直接用 request.js 给出的详细原因（含原始 errMsg）」（该提交关联文件含本页，`.qoder/frontend/services/auth.js.md` §10）。

## 4. 核心功能（launch.js）

### 4.1 模块级常量与纯函数

- 常量（`:18-22`）：`HOME_PAGE`/`ONBOARD_PAGE`/`ACTIVITY_PAGE` 三个跳转目标；`DISABLED_MSG`（停用文案）、`BLOCKED_MSG`（准入拦截文案「当前小程序仅对受邀人员开放…」）。
- `parseInviteFromScene(scene)`（`:24-35`）：从场景串 `i=CODE` 提取邀请码，先 `decodeURIComponent`（失败用原文，`:28-32`），正则 `/(?:^|[?&])i=([A-Za-z0-9]{1,32})/`（`:33`）兼容 `?i=CODE` 与 `i%3DCODE`；无匹配返回 `''`。

### 4.2 `data` 状态字段（`:38-42`）与实例属性

| 分组 | 字段 | 说明 |
|---|---|---|
| 页面相位 | `phase`（`:39`） | `loading / blocked / disabled` 三态（行内注释），驱动 WXML 三分支 |
| 文案 | `message`（`:40`） | 初值「正在进入长征…」，随相位改写（`:55`、`:69`、`:79`、`:85`、`:88`、`:100`、`:105`） |
| 错误 | `errorMsg`（`:41`） | `:55` 清空、`:79` 写入，**WXML 未绑定渲染**（§9 第 2 条） |

实例属性（非 data）：`this.redirect`（`:46`，回跳目标，query 解码）、`this.inviteCode`（`:50`，query `invite` 优先、场景串兜底；`onRescan` 可覆写 `:157`）。

### 4.3 生命周期：仅 `onLoad`（`:44-52`），无 onShow/onHide/onUnload

`onLoad` 解析三个入参（头注释 `:4-7`）：`redirect`（旧扫码确认流程回跳目标，生产方为 `frontend/pages/bind/bind.js:41`）、`scene`（小程序码场景串）、`invite`（预览/测试直传邀请码），随后立即 `start()`（`:51`）。本页**无任何 setTimeout/setInterval/动画句柄**，唯一动画是 WXSS 的 CSS spinner（§4-2），无需 JS 清理。

### 4.4 路由决策全分支（冷启动真实序列）

`start()`（`:54-60`）：复位 loading 相位后调 `auth.ensureLogin()`——有本地 token 走 `GET /auth/me` 后端校验，401 删 token 换 code 静默重登；无 token/已退出直接 `relogin`（实现与单飞机制见 `.qoder/frontend/services/auth.js.md` §4.5/§4.6）。

**成功 → `enterHome()`（`:109-121`）→ `enterTarget()`（`:123-133`）**：

1. `activity.getStatus()` 取 `allowView`；**接口失败按 `true` 放行（fail-open，`:113`）**，`:110` 注释「状态获取失败不阻塞进入（后端接口仍会拦截）」——后端闸门兜底见 `.qoder/backend/app/api/routes/activity.py.md` §4。
2. `allowView === false` → `wx.reLaunch('/pages/activity/activity')`（`:116`）。
3. 无 `redirect` → `wx.switchTab('/pages/home/home')`（`:125`，首页为 tab 页，`app.json:42-47`）。
4. 有 `redirect` → `wx.redirectTo(target)`；失败降级 `switchTab` 去掉 query 的目标，再失败兜底 `switchTab` 首页（`:129-132`）。

**失败 → `handleEnsureError(err)`（`:62-80`）**，按错误属性分流（属性来源见 `.qoder/frontend/services/request.js.md` §5 拒绝值表）：

| 条件 | 行号 | 行为 |
|---|---|---|
| `err.loggedOut`（用户主动退出，auth.js 不静默重登） | `:63-66` | `wx.redirectTo('/pages/login/login')`，有 redirect 时拼 `?redirect=` 透传（消费点 `frontend/pages/login/login.js:17-21`、`:50-52`） |
| `err.admission === 'disabled'` | `:68-70` | `phase='disabled'`，展示 `DISABLED_MSG`（WXML 只有「退出小程序」按钮） |
| `err.admission === 'unregistered'` | `:72-74` | 转 `handleUnregistered()`（§4.5） |
| 其余（网络/后端错误） | `:76-79` | `phase='blocked'`，`message` 取 `err.message`（含微信原始 errMsg，`a60b94b`），fallback 区分网络/通用文案 |

### 4.5 `handleUnregistered()`（`:82-107`）——邀请码分流

- 无邀请码 → `phase='blocked'` + `BLOCKED_MSG`（`:84-86`），WXML 提供「重新扫码/退出小程序」。
- 有邀请码 → loading「正在校验邀请码…」（`:88`）→ `auth.verifyInvite(code)`（`:89-90`，`POST /auth/invite/verify`，**只查不核销**，`.qoder/backend/app/api/routes/auth.py.md` §4.2）：
  - 成功：`auth.savePendingInvite({code, orgId, orgName})` 暂存到 `lm_pending_invite`（`:92`；键与载荷见 `.qoder/frontend/services/auth.js.md` §4.1/§4.8）→ `wx.redirectTo('/pages/onboard/onboard?invite=CODE[&rootId=&rootName=]')`（`:93-95`，专属码才带组织范围参数）。
  - 失败：先 `auth.clearPendingInvite()`（`:98`）；`statusCode === 400`（邀请码无效/停用/过期/用满）展示后端 message 或 `BLOCKED_MSG`（`:99-101`）；其余按网络/通用 fallback（`:103-105`）。

### 4.6 事件处理（WXML 绑定 + 死方法）

| 方法 | 行号 | 绑定 | 行为 |
|---|---|---|---|
| `onRetry` | `:135-138` | **无（WXML 未绑定，死方法，§9 第 1 条）** | loading 相位防重入后 `start()` |
| `onRescan` | `:140-162` | WXML `:21`（blocked 相位） | `wx.scanCode` → 从扫出路径解析 `scene=` 内邀请码（`:147-148`），无则直接找 `invite=`（`:150-151`）；识别失败 toast「未识别到有效邀请码」（`:154`）；成功覆写 `this.inviteCode` 并重跑 `start()`（`:157-158`）；取消扫码 toast（`:160`） |
| `onExit` | `:164-170` | WXML `:16`（disabled）、`:22`（blocked） | `wx.exitMiniProgram`，fail 降级 `navigateBack`，整体 try/catch 兼容低版本基础库（`:168` 注释） |

## 4-1. WXML 专章（launch.wxml，25 行）

- **品牌头图**（`:2-6`）：🚩 logo + 应用名「长征运动挑战」+ 标语，无条件渲染。
- **状态区**（`:8-24`）按 `phase` 三分支：`loading`（`:9-12`，spinner + `{{message}}`）；`disabled`（`:13-17`，「账号已停用」标题 + `{{message}}` + 退出按钮）；`else` 即 `blocked`（`:18-23`，「暂无法进入」+ `{{message}}` + 「重新扫码」主按钮 + 「退出小程序」次按钮）。
- `{{message}}` 是唯一动态文案绑定；`errorMsg` 与 `onRetry` 均未出现（§9）。无列表、无 `wx:key` 场景；无原生方法调用（`frontend/AGENTS.md` §5.2）。

## 4-2. WXSS 专章（launch.wxss，94 行）

- 全屏红→米黄分色背景 `linear-gradient`（`:1-6`），头图白字（`:8-12`），logo 圆形半透明描边（`:14-23`）。
- **spinner**：56rpx 圆环 `animation: spin 0.9s linear infinite`（`:45-53`）+ 本地 `@keyframes spin`（`:55-57`）——纯 CSS 动画，相位切走即随 `wx:if` 销毁，无需 JS 清理。
- 拦截态排版：`.block-title/.block-tip`（`:81-94`）、`.retry-btn` 通栏（`:70-73`）、`.btn-secondary` 淡红描边次按钮（`:75-79`）；`.btn-primary` 复用全局（`frontend/app.wxss`，WXML `:16`、`:21` 引用）。
- **死选择器**：`.error-tip`（`:64-68`）在 launch.wxml 中无引用（两文件均已通读核实）。
- 单位全 rpx；主色 `#C8102E`/`#A00D26` 与全局约定一致（`frontend/AGENTS.md` §2）。

## 4-3. JSON 专章（launch.json，5 行）

仅 3 个键：`navigationBarTitleText: "长征运动"`、`navigationBarBackgroundColor: "#C8102E"`、`navigationBarTextStyle: "white"`（`:2-4`），与 `app.json` `window` 全局默认完全一致（`frontend/app.json:29-35`），属冗余声明。无 `usingComponents`、无下拉刷新配置。

## 5. 输入与输出

- **入参（`onLoad(options)`，`:44-52`）**：`scene`（小程序码场景串，经 URL 编码，形如 `i=CODE`）、`invite`（直传邀请码）、`redirect`（回跳目标，编码透传）——三者语义见头注释 `:4-7`。
- **出参（调用的 service 与后端路径）**：

| service 调用 | launch.js 行号 | 后端路径 |
|---|---|---|
| `auth.ensureLogin()` | `:57` | `GET /api/auth/me` 校验；无 token/401 时 `wx.login` + `POST /api/auth/login`（`.qoder/frontend/services/auth.js.md` §4.5/§4.6、`.qoder/backend/app/api/routes/auth.py.md` §4.1） |
| `auth.verifyInvite(code)` | `:90` | `POST /api/auth/invite/verify`（`frontend/services/auth.js:167-174`；限流 60 次/分/IP，`.qoder/backend/app/api/routes/auth.py.md` §4.2） |
| `auth.savePendingInvite / clearPendingInvite` | `:92` / `:98` | 无请求；Storage 键 `lm_pending_invite`（`.qoder/frontend/services/auth.js.md` §4.8） |
| `activity.getStatus()` | `:112` | `GET /api/activity/status`（`.qoder/frontend/services/activity.js.md` §4；`.qoder/backend/app/api/routes/activity.py.md` §4） |

- **错误出口**：全部收敛为 `phase` + `message` 展示（§4.4 表），页面不弹 modal、不抛错。

## 6. 依赖关系

- **require（`:15-16`）**：仅 `services/auth`、`services/activity` 两项，均有使用。零直接 `wx.request`、零直接 Storage 读写（邀请码暂存经 auth.js 封装，符合 `frontend/AGENTS.md` §3.1）。
- **被依赖（本页是全仓登录态回退的汇聚点）**：
  - `app.json:3` pages 首位（冷启动默认落地）；
  - `frontend/services/request.js:5` `LAUNCH_PAGE` 常量——401 重登失败/账号停用时 `clearSession()` 的 `reLaunch` 目标（`.qoder/frontend/services/request.js.md` §4.5）；
  - 各页登录守卫 `wx.reLaunch('/pages/launch/launch')`（grep 实测约 20 处，如 `frontend/pages/home/home.js:117`、`frontend/pages/ticket/ticket.js:21`、`frontend/pages/node-detail/node-detail.js:31`）；
  - `frontend/pages/bind/bind.js:41`（扫码确认流程未登录时带 `?redirect=` 回本页）、`frontend/pages/login/login.js:61`、`frontend/pages/activity/activity.js:53`（进首页失败的兜底）、`frontend/pages/onboard/onboard.js:27`、`:107`（无邀请码/取消时退回）。
- **下游跳转目标**：`/pages/home/home`（switchTab，`:125`）、`/pages/login/login`（redirectTo，`:65`）、`/pages/onboard/onboard`（redirectTo，`:95`）、`/pages/activity/activity`（reLaunch，`:116`）。

## 7. 业务规则

1. **启动闸门唯一执行点**：`app.globalData.loggedIn` 冷启动恒为 false，只由本页 `ensureLogin` 成功（auth.js `syncApp`）置 true（`frontend/AGENTS.md` §4 不变量 3；`.qoder/frontend/app.js.md` §7 第 1 条）。其余页面的守卫弹回本页是设计意图而非缺陷。
2. **主动退出优先**：`lm_logged_out` 存在时 auth.js 拒绝静默重登并抛 `loggedOut`（`frontend/services/auth.js:133`），本页据此送登录页手动登录（`:63-66`），绝不自动登录。
3. **verify 不核销、onboard 才核销**：本页只校验邀请码可用性并暂存（`:90-95`），核销与建号在入驻页提交时由后端原子完成（`.qoder/backend/app/api/routes/auth.py.md` §4.2）；两次调用之间码可能被用满，故失败分支要 `clearPendingInvite`（`:98`）。
4. **活动预检 fail-open**：状态接口失败默认放行（`:113`），真正的查看拦截由后端 403 + `X-Activity-Status` 头与 request.js 跳转承担（`.qoder/backend/app/api/routes/activity.py.md` §4、`.qoder/frontend/services/request.js.md` §4.9）。
5. **跳转 API 语义**：进 tab 首页用 `switchTab`（`:125`）、进入驻页用 `redirectTo`（`:95`，本页退出栈防返回）、进活动页用 `reLaunch`（`:116`，清栈）、送登录页用 `redirectTo`（`:65`）。
6. **邀请码来源优先级**：query `invite`（trim 后）> 场景串解析（`:48-50`）；`onRescan` 扫出的新码覆写后重跑全流程（`:157-158`）。

## 8. 修改约束

1. **错误属性分流与 auth.js/request.js 逐一耦合**：`err.loggedOut / err.admission / err.network / err.statusCode / err.message` 五个属性的产生点见 `.qoder/frontend/services/request.js.md` §5 与 `.qoder/frontend/services/auth.js.md` §4.5，改任一侧必须同步 `:62-107`（request.js.md §8 第 5 条同款约束）。
2. **页面路径 `/pages/launch/launch` 不可改**：被 `request.js:5` 与全仓约 20 处守卫硬编码（§6）。
3. **后端三态 `status` 字符串**（active/disabled/unregistered）是硬契约（`.qoder/backend/app/api/routes/auth.py.md` §8 第 1 条），auth.js 把非 active 归一为 `admission` 错误后本页才能分流。
4. **禁止把启动校验移回 `app.js onLaunch`**（`.qoder/frontend/app.js.md` §8 第 1 条）；本页是该校验的唯一落点。
5. `lm_pending_invite` 载荷结构 `{code, orgId, orgName}`（`:92`）与入驻页读取口径绑定（`frontend/pages/onboard/onboard.js:23`、`:30-31`），改字段需两页同步。
6. 导航栏三键与主色受全局约定约束（`frontend/AGENTS.md` §2/§5.3）。

## 9. 当前实现状态

- **已实现**：冷启动登录闸门（ensureLogin 全分支）、四路分流（首页/登录/入驻/活动状态页）、邀请码扫码落地与校验、停用/准入两类拦截页、重新扫码、退出小程序。4 个提交（§10）。
- **存在问题 / 已知事项（事实陈述，均已通读四件套核实）**：
  1. **`onRetry`（`:135-138`）是死方法**：launch.wxml 全文无任何绑定。后果：blocked 相位（含网络错误）没有「原码重试」按钮，用户只能「重新扫码」或退出——网络异常场景下重扫并非必要动作。`frontend/AGENTS.md` §5.1 明令「禁止未使用的方法残留」。
  2. **`data.errorMsg`（`:41`）写入但从未渲染**：`:55` 清空、`:79` 与 message 同值写入，WXML 只绑定 `{{message}}`——冗余字段。
  3. **死 WXSS 选择器 `.error-tip`**（`launch.wxss:64-68`），WXML 无引用。
  4. **启动链无前端超时上限**：`wx.login` 与 `ensureLogin` 均无超时控制（`.qoder/frontend/services/auth.js.md` §9 第 3 条），弱网下 loading 相位可能长时间停留且无重试按钮（叠加第 1 条）。
  5. **邀请码校验口径不一**：场景串解析限 `[A-Za-z0-9]{1,32}`（`:33`），query 直传 `invite` 仅 trim 不做格式/长度校验（`:48`），非法码交由后端 400 兜底（`:99-101`）——现状事实，是否收敛**待确认**。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --oneline -- frontend/pages/launch`（**4 个提交**，创建提交经 `--diff-filter=A` 核实），与 `docs/迭代记录.md` 对应条目交叉。按时间倒序。

### 2026-10-14（`a60b94b`，16:53）
- 需求：体验版扫码只报「网络异常」，真实原因被丢弃，真机无从定位。
- 修改内容（涉本文件）：错误分支改为透出 request.js 归一后的详细 message（`:76-79` 及其行注释「不再统一覆盖为笼统文案」）；该提交关联文件含 `pages/launch/launch.js`（`.qoder/frontend/services/auth.js.md` §10）。对本文件的具体 diff 未逐行核对，以提交信息与行注释为据。
- 测试结果：见 `docs/迭代记录.md` 的 `a60b94b` 条目。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0 活动状态页与查看拦截。
- 修改内容（涉本文件）：`enterHome` 增加 `activity.getStatus()` 的 `allowView` 预检与活动状态页分流（`:109-121`；`.qoder/frontend/services/activity.js.md` §6 将 `launch.js:112` 列为该服务调用方，§10 记本提交创建 activity.js 时关联本文件）。具体 diff 未逐行核对，以提交信息与上述文档为据。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（v2 自动化验收 14/14）。

### 2026-10-12（`afbcba9`，14:49）
- 需求：邀请码准入全链路——小程序扫码准入与入驻信息收集。
- 修改内容（涉本文件）：unregistered 分流与 `handleUnregistered`（`:72-74`、`:82-107`）、`verifyInvite` → `savePendingInvite` → 跳入驻页时序（`.qoder/backend/app/api/routes/auth.py.md` §4.2「前端时序」以 `launch.js:90` 为起点）、`onRescan` 重新扫码；同批新增 `pages/onboard`（`.qoder/frontend/services/auth.js.md` §10）。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目（后端 s19 冒烟 25/25）。

### 2026-10-11（`01e214a`，01:05）
- 需求：V1.0 启动页自动登录（后端校验 Token/静默 wx.login、失败可重试不假登录）并取消强制选组织。
- 修改内容（涉本文件）：**创建本页**（`git log --diff-filter=A` 实测本目录首个提交）——`ensureLogin` 闸门、loggedOut → 登录页、disabled/unregistered 拦截态与 `enterTarget` 回跳框架（`:44-133` 骨架；`.qoder/frontend/app.js.md` §10 同批「删除 onLaunch，启动校验改由 launch 页承担」）。
- 测试结果：`node test/auth-flow-check.cjs` 11/11、automator `v1-auto-login.cjs` 两轮 6/6（`.qoder/frontend/services/auth.js.md` §10；`docs/迭代记录.md` 的 `01e214a` 条目）。
