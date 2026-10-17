# login.js（登录页 · 页面级合一：login.js / login.wxml / login.wxss / login.json）

## 1. 文件路径

- `frontend/pages/login/login.js`（70 行）
- `frontend/pages/login/login.wxml`（29 行）
- `frontend/pages/login/login.wxss`（114 行）
- `frontend/pages/login/login.json`（5 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

**用户主动退出后的手动登录入口**——日常冷启动由启动页静默登录，不经本页（`login.js:2` 头注释）。页面只有一件事：把「微信授权登录」按钮同时做成头像选择器，用户选完头像即在回调里调 `auth.wxLogin({avatar})` 完成登录（`:3` 头注释流程、`:32-35`），成功后按 `redirect` 回原页或直达首页。**页面不含昵称输入框、不含任何业务逻辑与 Storage 读写**（`:4` 头注释；`frontend/AGENTS.md` §4 不变量 7）。

**入口证据**（grep `pages/login/login` 全仓，测试目录除外）：「我的」页退出登录确认后 `wx.reLaunch`（`frontend/pages/mine/mine.js:159`）；启动页在 `err.loggedOut`（用户曾主动退出）时 `wx.redirectTo` 并可带 `?redirect=`（`frontend/pages/launch/launch.js:64-65`）。页面在 `frontend/app.json:8` 注册，**不在 tabBar**（`app.json:41-72`）。

## 3. 业务需求

- 登录页移除昵称输入框、微信授权登录一步到位：`95b190b`（2026-10-01）（`docs/迭代记录.md` 的 `95b190b` 条目）。该提交信息中的「直达组织选择」已被后续 `01e214a`「取消强制选组织」调整为直达首页（现行 `:54`）。
- `?redirect=` 支持（扫码确认流程登录后原路返回）：`6ed1999`（2026-10-09）身份关联小程序侧批次交付（`docs/迭代记录.md` 的 `6ed1999` 条目；`.qoder/frontend/services/identity.js.md` §3）。
- 未入驻/已停用的准入分流：`afbcba9`（2026-10-12）邀请码准入全链路，`/auth/login` 改状态式返回，页面据 `err.admission` 交回启动页统一处理（`:58-63`；`.qoder/frontend/services/auth.js.md` §4.3）。
- 启动页自动登录后本页职责收窄为「仅手动登录」：`01e214a`（2026-10-11）。

## 4. 核心功能（login.js）

### 4.1 `data` 与实例属性

- `data`（`:11-14`）仅 2 个字段：`loading`（初值 false，按钮 `loading`/`disabled` 与防重入共用）、`errorMsg`（初值 `''`，登录失败文案）。
- 实例属性 `this.redirect`（`:18`，**非 data**）：`decodeURIComponent(options.redirect || '')`，onLoad 解析一次后全程复用。
- **无定时器句柄、无动画对象、无 Canvas、无 WebSocket、无事件监听**（全文件核实）。唯一的 `setTimeout` 在 `:49`（600ms 后跳转），**句柄未保存**，页面也没有 `onHide`/`onUnload` 钩子，故无从清理；它只在登录成功后创建，随即发生页面跳转。

### 4.2 `onLoad(options)`（`:16-26`）——已登录直接放行

解析 `redirect`（`:18`）；若 `app.globalData.loggedIn` 已为真，则**不再展示登录按钮**：有 `redirect` 就 `wx.redirectTo(this.redirect)`（`:20-21`），否则 `wx.switchTab('/pages/home/home')`（`:22-24`）。这是「本地 Token 不经后端校验不得视为已登录」不变量的下游体现——`loggedIn` 只可能由启动页 `auth.ensureLogin()` 或登录成功置真（`frontend/AGENTS.md` §4 不变量 3；`.qoder/frontend/services/auth.js.md` §4.6）。本页**无 onShow**：页面不展示任何后端数据，无需刷新链。

### 4.3 `onChooseAvatar(e)`（`:28-35`）与 `doLogin(avatar)`（`:37-69`）

按钮 `open-type="chooseAvatar"` 使微信先弹头像选择面板，回调取 `e.detail.avatarUrl`（缺省为 `''`，`:33`）后转调 `doLogin`。`doLogin`：

1. `loading` 防重入（`:42`）→ `setData({loading: true, errorMsg: ''})`（`:43`）。
2. `auth.wxLogin({ avatar })`（`:45-46`）。服务层内部链路（本页不参与、也不感知）：`wx.login` 取 code → `persistAvatar` 把临时头像转持久路径 → `POST /auth/login {code, avatar}`（`skipAuthRetry`）→ `status === 'active'` 时写 `lm_auth_token`、按需迁移遗留数据、`saveServerUser` 写 `lm_login_user` 并同步 `app.globalData`、删 `lm_logged_out`（`.qoder/frontend/services/auth.js.md` §4.2/§4.3/§4.4）。
3. **成功**（`:47-57`）：toast「登录成功」，600ms 后按 `redirect` `wx.redirectTo` 或 `wx.switchTab('/pages/home/home')`；`:51` 注释说明扫码确认流程要立即返回确认页（场景凭证有效期短，不打断）。
4. **失败**（`:58-65`）：`err.admission` 存在（未入驻 `unregistered` / 已停用 `disabled`）→ `wx.reLaunch('/pages/launch/launch')`，由启动页统一走邀请码校验或准入拦截（`:59-61` 注释）；其余错误 → `errorMsg = err.message || '微信授权失败，请重试'`。
5. `finally` 复位 `loading`（`:66-68`）。

**与 auth.js 的一致性核对**：`.qoder/frontend/services/auth.js.md` 记录的登录链路（`wx.login` → code → `POST /auth/login` → token 落 `lm_auth_token`，并以 `setReauthHandler(relogin)` 把单飞静默重登注册进 `request.js`，见其 §4.1/§4.3/§4.5）与本页调用完全吻合，本页只调 `wxLogin` 一个函数（`:46`），**不参与 401 静默重登链**（那是 request.js ↔ auth.js 之间的事）。三个 Storage 键 `lm_auth_token`/`lm_login_user`/`lm_logged_out` 全由 auth.js 读写，本页零 Storage 访问（`frontend/AGENTS.md` §3.1、§6.5）。

**每日登录积分（重要更正）**：本页代码从头到尾无任何积分逻辑（核实）；后端 `/auth/login` 自 `2f3f333`（2026-10-13）积分台账重构起**已移除 `grant_daily_login`，登录不再产生积分**（`.qoder/backend/app/api/routes/auth.py.md` §7 规则 5 与其 §10 该日条目）。`frontend/design.md:54` 仍写「登录后发每日登录积分（后端 /auth/login 内发放）」，属参考文档滞后表述（`.qoder/README.md` §2 已登记 design.md 存在滞后）。

### 4.4 出站跳转（全部出口）

| 行号 | API | 目标 |
|---|---|---|
| `:21` | `wx.redirectTo` | `this.redirect`（调用方传入，原样使用，本页不校验合法性） |
| `:23` | `wx.switchTab` | `/pages/home/home` |
| `:52` | `wx.redirectTo` | `this.redirect` |
| `:54` | `wx.switchTab` | `/pages/home/home` |
| `:61` | `wx.reLaunch` | `/pages/launch/launch`（准入分流） |

无 `wx.navigateTo`。`redirect` 的实际值由启动页扫码流程写入（`frontend/pages/launch/launch.js:64-65`），按 `:51` 注释与 `.qoder/frontend/services/identity.js.md` §3，指向扫码确认页（`pages/bind/bind`，随 `6ed1999` 交付）。

## 4-1. WXML 专章（login.wxml，29 行）

结构极简，两块：

1. **品牌 hero**（`:2-15`）：🚩 logo（`:3`）、应用名「长征运动挑战」（`:4`）、slogan「行万里路 · 学长征历史」（`:7`）、装饰性旗帜线（3 个圆点 + 2 段连接线，`:8-14`）。`:6` 注释显式说明**为何没有昵称输入框**（登录后昵称默认「长征小战士」，可在「我的」页修改一次）。
2. **操作区**（`:17-28`）：`wx:if="{{errorMsg}}"` 错误文案（`:18`）；唯一的 `<button class="btn-primary login-btn" open-type="chooseAvatar" bindchooseavatar="onChooseAvatar" loading="{{loading}}" disabled="{{loading}}">微信授权登录</button>`（`:20-26`）；底部静态说明「点击后将选择微信头像并登录 · 同意相关用户协议」（`:27`）。

**协议/隐私勾选（核实结论）**：`.agreement` 是**纯静态文本**，页面**没有 checkbox、没有勾选状态字段、没有协议链接或协议正文弹窗，登录也不做任何「已同意」校验**——点击按钮即视为同意。是否有合规要求需补真实勾选交互，**待确认**（属产品/合规决策，非代码缺陷）。

约定核对：无 `wx:for`（故无 `wx:key` 问题）、表达式仅属性访问与 `wx:if`、**无原生方法调用**（`frontend/AGENTS.md` §5.2）。

## 4-2. WXSS 专章（login.wxss，114 行）

- **本地 `@keyframes` 2 组**：`logoBreath`（logo 呼吸光晕 + 轻微缩放，2.8s 无限循环，`:36-45`）、`dotBlink`（旗帜圆点闪烁，1.8s 无限循环，`:81-84`）。
- **依赖全局 keyframes 2 组**：`fadeUp`（`frontend/app.wxss:181`）用于应用名、slogan、旗帜线、操作区的错峰入场（`:20`、`:53`、`:61`、`:97`，delay 0.1s/0.45s/0.6s/0.8s）；`popIn`（`app.wxss:205`）用于 logo 弹入，与 `logoBreath` 叠加在同一 `animation` 简写上（`:33`）。全局 `.btn-primary`（`app.wxss:33`，含 `[disabled]` 态 `:48`）供登录按钮使用。
- **选择器逐一核对无死样式**：本文件全部类选择器（`.login-page`/`.login-hero`/`.app-name`/`.logo`/`.slogan`/`.flag-line`/`.flag-dot`/`.flag-dot.gold`/`.flag-dot:last-child`/`.flag-line-conn`/`.login-actions`/`.error-tip`/`.login-btn`/`.agreement`）均在 `login.wxml` 中有对应节点（按类名逐个比对 WXML 全文核实）。
- **布局要点**：整页 `min-height: 100vh` + 单条 `linear-gradient` 在 45% 处由品牌红硬切到米色背景 `#F7F1E5`（`:1-6`，与 `frontend/AGENTS.md` §2 约定色一致）；`.login-actions` 用 `margin-top: auto` 吸底并留 140rpx 底部安全距（`:93-98`）；旗帜圆点用 `animation-delay` 做错峰（`.gold` 0.6s、`:last-child` 1.2s，`:74`、`:78`）。单位全 rpx。
- **动画清理**：两组本地 keyframes 均为 CSS 声明式（`infinite` 循环），页面销毁即终止，无 JS 句柄需清理（对照 §4.1）。

## 4-3. JSON 专章（login.json，5 行）

仅 3 个键：`navigationBarTitleText: "登录"`、`navigationBarBackgroundColor: "#C8102E"`、`navigationBarTextStyle: "white"`。后两键与 `frontend/app.json:30-32` 全局 `window` 默认一致（属冗余声明，改动无行为差异），仅标题为页面特有。无 `usingComponents`、无下拉刷新配置。

## 5. 输入与输出

- **入参**：query `redirect`（可选，URL 编码的目标路径，`:18`）。
- **出参**：`auth.wxLogin({avatar})` → `POST /api/auth/login`（`.qoder/frontend/services/auth.js.md` §4.3/§6；后端契约见 `.qoder/backend/app/api/routes/auth.py.md`）。本页无其他 service 调用。
- **错误出口**：`admission` 类错误 → `reLaunch` 启动页（`:59-62`）；其余 → `errorMsg` 文案（`:64`，WXML `:18` 渲染）。`finally` 保证按钮一定解锁（`:66-68`）。

## 6. 依赖关系

- **require（`:7-8`，2 项全部有使用）**：`services/auth`（仅 `wxLogin`）；`app = getApp()`（仅读 `globalData.loggedIn`，`:19`）。**不 require 任何其他 service/util**，零直接 `wx.request`、零 Storage 读写。
- **被依赖**：`frontend/app.json:8` 注册；`frontend/pages/mine/mine.js:159`（退出后重登）与 `frontend/pages/launch/launch.js:65`（已退出用户的冷启动兜底）两个入口；automator 脚本普遍以 `reLaunch('/pages/login/login')` 作为 E2E 起点（如 `frontend/test/automator/p0-opening.cjs:99`、`identity-ui-test.cjs:146`）。
- **数据库表**：前端不触库；登录涉及的用户表与状态字段见 `.qoder/backend/app/api/routes/auth.py.md`。

## 7. 业务规则

1. **仅已入驻用户能通过本页登录成功**：`/auth/login` 状态式返回，未入驻不建号不发 token；服务层把非 `active` 一律转成带 `admission` 属性的错误，**进入驻页还是拦截页由上层决定**，本页的选择是交回启动页（`:59-62`；`.qoder/frontend/services/auth.js.md` §7 规则 1）。
2. **主动退出后不会被静默登录**：`lm_logged_out` 标记使 `relogin` 直接 reject，启动页因此把用户送到本页手动登录（`frontend/pages/launch/launch.js:63-66`；`.qoder/frontend/services/auth.js.md` §4.5、§7 规则 2）。
3. **头像在提交后端前必须持久化**：本页只把 `chooseAvatar` 的临时路径交给 `wxLogin`（`:46`），持久化在服务层内部完成（`persistAvatar` 未导出，`.qoder/frontend/services/auth.js.md` §4.2；`frontend/AGENTS.md` §4 不变量 4）。
4. **不采集昵称**：默认昵称由后端给出，登录后在「我的」页有一次改名机会（`:4`、`:38` 注释；WXML `:6` 注释；`frontend/AGENTS.md` §4 不变量 7）。
5. **组织为选填**：登录成功直达首页，不再跳组织选择（`:54`；`frontend/AGENTS.md` §4 不变量 5）。

## 8. 修改约束

1. **禁止整文件覆盖本页面**：`frontend/AGENTS.md` §6.2 明确记载过历史事故——覆盖 `login.js` 丢失了 onLoad 自动跳转逻辑（现存 `:16-26`）。改动必须用精准替换。
2. `<button open-type="chooseAvatar">` + `bindchooseavatar` 的组合是微信登录交互契约（`frontend/AGENTS.md` §4 不变量 7）：**不得**改成先选头像再点登录的两步式，也不得新增独立「选择头像」按钮或昵称输入框。
3. `err.admission` 分支与 auth.js 的 `admissionError` 输出耦合（`.qoder/frontend/services/auth.js.md` §4.3、§8 第 6 条），新增后端状态值须同步 `:58-65`。
4. `redirect` 原样用于 `wx.redirectTo`（`:21`、`:52`），改动其解析或校验方式须同步 `frontend/pages/launch/launch.js:64-65` 的编码方式。
5. 三个 Storage 键的读写只能留在 auth.js，本页不得直接访问（`frontend/AGENTS.md` §4 不变量 3、§6.5）。
6. 导航栏主色 `#C8102E`、背景 `#F7F1E5` 与 json 三键受全局约定约束（`frontend/AGENTS.md` §2、§5.3）。

## 9. 当前实现状态

- **已实现**：头像选择即登录的一步式交互、`?redirect=` 原路返回、已登录自动放行、`admission` 错误回流启动页、错误文案与按钮 loading/防重入、品牌入场动画。页面无需清理的资源（§4.1、§4-2）。
- **存在问题 / 已知事项（事实陈述）**：
  1. **无真实协议勾选交互**：`.agreement` 为静态文本，无 checkbox 与同意校验（§4-1）。是否需补齐属合规决策，**待确认**。
  2. **`:49` 的 600ms `setTimeout` 句柄未保存**，且页面无 `onHide`/`onUnload`（§4.1）；仅在登录成功后触发并随即跳转，非无界泄漏。
  3. **`redirect` 不做合法性校验**（`:18`、`:21`、`:52`），任意传入路径都会被 `wx.redirectTo`；当前唯一调用方是启动页（`launch.js:64-65`），风险面有限——现状事实。
  4. `frontend/design.md:54` 关于「登录后发每日登录积分」的表述已滞后（后端 `2f3f333` 移除，§4.3）；`.qoder/README.md` §2 已登记 design.md 滞后，本文档只记录事实、不改该文件。
  5. `frontend/AGENTS.md` §6.2 提及的历史事故还包含「每日登录积分逻辑」，该逻辑在现行页面代码中已不存在（与第 4 条同源）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/login`（目录级，**8 个提交**），全部在 `docs/迭代记录.md` 有对应条目（按提交号逐一核对存在）。按时间倒序。除注明外，各提交对本目录的具体 diff 未逐一核对，以提交信息与该条目为据。

### 2026-10-12（`afbcba9`）
- 需求：邀请码准入全链路（后端迁移/服务/路由、admin 邀请码管理与账号启停、小程序扫码准入与入驻信息收集）。
- 修改内容（涉本目录）：`err.admission` 分流分支（`:58-63`），与服务层新增的 `admissionError`、`/auth/login` 状态式返回配套（`.qoder/frontend/services/auth.js.md` §10 同日条目）；未逐 diff 核对。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目（后端 s19 25/25 等）。

### 2026-10-11（`01e214a`）
- 需求：V1.0 启动页自动登录（后端校验 Token / 静默 wx.login / 401 静默重登重试），并取消强制选组织。
- 修改内容（涉本目录）：本页职责收窄为「主动退出后的手动登录入口」（`:2` 头注释）；登录成功改直达首页而非组织选择（`:54`）；已登录自动放行的 onLoad 分支（`:19-25`）。未逐 diff 核对。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目（`node test/auth-flow-check.cjs` 11/11、automator `v1-auto-login.cjs` 两轮 6/6）。

### 2026-10-09（`6ed1999`，12:45）
- 需求：身份关联小程序侧（批次 5）——扫码确认页 bind 与账号绑定页 account、**login redirect 支持**、mine 入口。
- 修改内容（涉本目录）：`this.redirect` 解析与两处 `wx.redirectTo` 回跳（`:18`、`:21`、`:52`），`:51` 注释「扫码确认流程：立即返回确认页（场景凭证有效期短，不打断）」。
- 测试结果：automator 15/15 断言 + 6 截图验收（提交信息；`docs/迭代记录.md` 的 `6ed1999` 条目，报告见 `frontend/test/docs/identity-bind-account-report.md`）。

### 2026-10-01（`95b190b`、`f820e0e`、`b0fd8b2`）
- 需求：`95b190b`（16:27）登录页移除昵称输入框、微信授权登录直达组织选择；`f820e0e`（15:54）微信名称直登与昵称仅可修改一次（三端）；`b0fd8b2`（10:31）小程序由本地 Mock 切换为真实后端接口。
- 修改内容（涉本目录）：`95b190b`——现行「无昵称输入框 + `open-type="chooseAvatar"` 一步登录」形态（`:3`、`:32-35`；WXML `:6`、`:20-26`）；`f820e0e`/`b0fd8b2`——登录改走 `POST /api/auth/login` 真实接口（`:45-46`），细节以提交信息为据，未逐 diff 核对。
- 测试结果：`95b190b`、`f820e0e` 见 `docs/迭代记录.md` 对应条目；`b0fd8b2` 条目仅有标题行，验证记录**待确认**（`.qoder/frontend/services/auth.js.md` §10 同日条目同述）。

### 2026-09-30（`b0ba252`、`a94e685`）
- 需求：`a94e685`（18:05）仓库初始化创建本页（Mock 版）；`b0ba252`（22:48）强制已登录用户完成组织选择流程（该强制流程后被 `01e214a` 回退，提交信息为据）。
- 修改内容（涉本目录）：`b0ba252` 的具体改动未逐 diff 核对。
- 测试结果：见 `docs/迭代记录.md` 对应条目（`a94e685` 条目仅「仓库初始代码」）。
