# LoginView.vue

## 1. 文件路径

`admin/src/views/LoginView.vue`（306 行）

## 2. 文件职责

管理后台登录页（`<script setup>` 单文件组件），提供**两种**登录方式并以 `el-tabs` 切换（`:160-203`）：① 账号密码登录（内置超管，`:161-181`）；② 微信扫码登录（生成登录小程序码 + 2 秒链式轮询，`:182-202`）。登录成功后把令牌与权限档案写入 localStorage 并按 `redirect` 参数回跳。是路由表唯一公开页（`admin/src/router/index.ts:15-20`，无 `meta.menu`）。

## 3. 业务需求

- 需求出处：`.qoder/REQUIREMENTS.md` §11「管理后台功能」；鉴权与令牌模型见 `.qoder/ARCHITECTURE.md` §5.1、§5.3；守卫配合见 `.qoder/ARCHITECTURE.md` §5.6。
- 后端明确「未配置 `ADMIN_PASSWORD` 时账号登录禁用（不硬编码默认密码），仅允许微信扫码登录」（`backend/app/api/routes/admin.py:105`），故扫码登录不是可选装饰而是**唯一保底登录方式**。
- 演进：`4a26520`（2026-09-30）创建（初版仅账号密码登录）；`54a0de7`（2026-10-09，P3 管理端）加入微信扫码标签与 2s 轮询自动登录；`9724d9a`（2026-10-09）修复「先调 `/me` 未带 token 导致登录失败」；`30b4458`（2026-10-11）轮询链式化 + 代次守卫、`setAuth` 拆为 `setToken`+`setProfile`。

## 4. 核心功能

### 4.1 账号密码登录（`:16-48`）

- 表单（`:17-20`）：`username`（**有预填默认值**，便于快速登录内置超管账号；文档不复制该值）+ `password`（空）。校验规则 `rules`（`:22-25`）：两项均 `required`，`trigger: 'blur'`，提示「请输入用户名」/「请输入密码」；`el-form` 绑 `:rules` 且回车即提交（`:162`）。
- `handleLogin`（`:32-48`）流程：`formRef.validate().catch(() => false)`（`:33`，校验失败/异常统一按 false 处理）→ `login(username, password)`（`:37`）→ **先** `setToken(data.token)`（`:38`）→ **再** `fetchMe()`（`:39`）→ `setProfile(username, is_super, menus.map(code))`（`:40`）→ `ElMessage.success('登录成功')`（`:41`）→ `handleLoggedIn()`（`:42`）。
- **顺序不可调换**：`api/request.ts:19-25` 的请求拦截器每次从 `getToken()` 读令牌注入 `Authorization`，若先调 `/me` 再存令牌，`/me` 会 401（`9724d9a` 修复的正是这个缺陷）。
- 异常处理：`catch {}` 为空并注释「错误提示已由 axios 拦截器统一处理」（`:43-44`）；`finally` 关按钮 loading（`:45-47`）。
- 后端契约：`login`（`admin/src/api/admin.ts:353-355`）→ POST `/api/admin/login`（`backend/app/api/routes/admin.py:101-115`）。限流 `login_limiter`（`:107`）；未配置服务端口令 → 403「未配置管理账号密码，请使用微信扫码登录」（`:108-109`）；账号或口令不匹配 → 401「用户名或密码错误」（`:110-114`）；成功返回 `{token, username}`，签发的是**超管令牌**（`:115`）。随后 `fetchMe`（`api/admin.ts:453-455`）→ GET `/api/admin/me`（`admin.py:178-195`）：超管返回全部菜单（`access_service.get_all_menu_items`），微信关联管理员返回其角色菜单并集。

### 4.2 微信扫码登录（`:50-148`）

- 状态：`activeTab`（默认 `'account'`，`:51`）、`qr`（`:52`）、`qrStatusText`（`:53`）、`qrFailed`（`:54`）、`qrFailReason`（`:55`）。
- **轮询机制**（`30b4458` 由 `setInterval` 改为链式）：
  - `POLL_INTERVAL = 2000`（`:56`）；`pollTimer`（`:58`）保存 `setTimeout` 句柄；`pollGen`（`:59`）为代次计数。`:57` 注释说明双机制意图：**上一次请求返回后再排下一次**（慢响应时不会堆叠并发请求）+ **代次递增使在途旧回调失效**。
  - `stopPolling`（`:61-67`）：先 `pollGen++` 作废在途回调，再 `clearTimeout` 并置空句柄。
  - `schedulePoll(gen)`（`:69-74`）：2s 后清空句柄并调 `pollOnce(gen)`。
  - 清理时机：切离扫码标签（`:146`）、扫码登录成功（`:109`）、`failed`（`:119`）、组件卸载（`onBeforeUnmount(stopPolling)`，`:150`）；`expired` 与「confirmed 但无 token」走 `startQr()`，其首行即 `stopPolling()`（`:77`）。**本页用 `onBeforeUnmount` 而非 `onUnmounted`**。
- `startQr`（`:76-91`）：`stopPolling()` → 记录当前代次 `gen`（`:78`）→ 复位失败态与提示文案（`:79-81`）→ `createWechatQr()` → 代次校验（`:84`）→ 存 `qr`，按 `data.mock` 二选一提示（`:86`：mock 显示「开发模式：请将场景码填入小程序调试入口」，否则「请使用手机微信扫码」）→ `schedulePoll(gen)`。失败仅在代次未变时改提示（`:88-90`）。
- `pollOnce(gen)`（`:93-130`）：
  - `qr` 为空直接返回（`:94`）。
  - 请求异常（`:98-105`）：代次校验后取 `error.response.status`；**404**（会话不存在，对应后端 `admin.py:151-152`）→ `startQr()` 重建会话；其余错误静默 `schedulePoll(gen)` 等下次（`:101` 注释）。
  - `confirmed`（`:107-117`）：有 `token`+`username` → `stopPolling()` + `setToken` + `setProfile(username, is_super ?? false, (menus || []).map(code))` + 成功提示 + `handleLoggedIn()`；无 token → 注释「会话已被其他标签页签发，刷新二维码」并 `startQr()`（后端为单次签发防重放，`admin.py:148`、`:154-155`）。
  - `failed`（`:118-122`）：停轮询、置 `qrFailed`、`qrFailReason = data.fail_reason || '登录未获授权'`。
  - `expired`（`:123-125`）：提示「二维码已过期，正在刷新…」并 `startQr()`。
  - 其他（`:126-129`）：`scanned` → 「已扫码，请在手机上确认登录」，否则「请使用手机微信扫码」，然后续排轮询。
- `copyScene`（`:132-140`）：mock 模式下把场景码写入剪贴板（`navigator.clipboard.writeText`），失败降级为 warning「复制失败，请手动选择复制」（`:137-139`）。
- `handleTabChange`（`:142-148`）：切到 `qr` 才 `startQr()`，切走 `stopPolling()`——默认停在账号标签，进页不会自动出码、不会自动轮询。
- 后端契约：`createWechatQr`（`api/admin.ts:381-383`）→ POST `/api/admin/wechat/qr`（`admin.py:119-132`，限流 `qr_create_limiter`；未配置微信凭证或出码失败时 `image` 为 null、`mock=true` 并返回 `scene` 明文供调试）；`pollWechatQr`（`api/admin.ts:385-387`）→ GET `/api/admin/wechat/qr/{qr_id}/status`（`admin.py:142-155`，限流 `qr_poll_limiter`），**该函数带 `{ silent: true }`**。
- 返回类型：`QrCreateResult`（`api/admin.ts:358-364`：`qr_id`/`image`/`scene`/`mock`/`expires_in`）、`QrStatusResult`（`:371-379`：`status`/`fail_reason`/`expires_in`/`token`/`username`/`is_super`/`menus`）、`MenuItem`（`:366-369`：`code`/`name`）。

### 4.3 登录态写入（`store/auth.ts`）

- 本页只用两个写入函数：`setToken(token)`（`admin/src/store/auth.ts:31-33`）写 `lm_admin_token`；`setProfile(username, isSuper, menus)`（`:36-40`）写 `lm_admin_username`、`lm_admin_is_super`（`'1'`/`'0'`）、`lm_admin_menus`（JSON 数组）。键名常量见 `:2-5`，合计 **4 个 localStorage 键**，与 `clearAuth`（`:42-47`）清除的 4 键一致。
- **当前代码没有 `setAuth` 函数**：`9724d9a` 时期存在 `setAuth(token, username)`，`30b4458` 拆分为 `setToken` + `setProfile`（见 §10）。
- 写入时机：账号登录在拿到 token 后立刻 `setToken`、`/me` 回来后 `setProfile`（`:38`、`:40`）；扫码登录在 `confirmed` 分支一次性写两者（`:110-111`），令牌与档案直接来自轮询响应，**不再额外调 `/me`**。
- 与 `isLoggedIn()`（`store/auth.ts:49-52`）的关系：该函数要求「令牌 + 权限档案（超管标记或 menus 键存在）」并存，仅写 token 未写档案仍视为未登录。

### 4.4 跳转与路由守卫配合

- `handleLoggedIn`（`:27-30`）：`const redirect = (route.query.redirect as string) || '/'` → `router.push(redirect)`。`redirect` 由守卫写入（`router/index.ts:104-106`：非 `/login` 且未登录时 `{ path: '/login', query: { redirect: to.fullPath } }`）。
- 回跳 `/` 时并不必然落在驾驶舱：`/` 的 `redirect: '/dashboard'`（`router/index.ts:28-30`）会再经菜单权限守卫（`:113-116`），无 `dashboard` 菜单码的管理员被 `firstAllowedPath()`（`:9-12`）改道到其第一个可用菜单。
- 已登录再访问 `/login`：守卫直接跳 `firstAllowedPath()`；若无任何可用菜单则放行停留登录页（`router/index.ts:107-111`，防重定向死循环）。
- 本页**不做**「登录后自己判断该去哪」的逻辑，落点完全交给守卫。

### 4.5 401 分流与并发去重（`api/request.ts`）

- `request.ts:34` 以 `router.currentRoute.value.path === '/login'` 判定是否登录页，`:35-45` 分流：
  - **登录页**：只弹 `detail || '用户名或密码错误'`（`:40-41`），不跳转（已在登录页）——本页账号登录失败的提示即由此产生，故 `handleLogin` 的 `catch` 可以留空（`:43-44`）。
  - **其他页**：`hadToken`（`:37`，清除令牌前是否持有）为真才弹「登录已过期，请重新登录」，随后 `router.push('/login')`（`:42-45`）——`hadToken` 即**并发请求同时 401 的去重开关**（`:36` 注释），避免多个在途请求各弹一条。
  - 两分支都先 `clearAuth()`（`:38`）。
- `silent` 标志：`request.ts:7-12` 通过 `declare module 'axios'` 扩展 `AxiosRequestConfig.silent`，`:33` 读取，`:41`/`:43`/`:46` 三处据此抑制提示。本页依赖它的是**轮询**请求（`api/admin.ts:386` 的 `{ silent: true }`），使 2 秒一次的失败轮询不弹 toast；`createWechatQr`（`:382`）**未**加 `silent`，出码失败会同时出现全局 toast 与页内文案（`:89`）。
- 扫码相关接口公开无鉴权（`admin.py:119-155` 无 `Depends(get_current_admin)`），正常不会返回 401。

### 4.6 模板与样式（`:153-306`）

- 结构：全屏渐变容器 `.login-page`（`:154`）→ 400px 卡片（`:155`、`:217-220`）→ 标题区（🚩 + 「长征运动挑战 · 管理后台」，`:156-159`）→ `el-tabs`（`:160-203`，`@tab-change="handleTabChange"`）。
- 账号标签（`:161-181`）：`size="large"` 表单、回车提交（`:162`）；用户名输入框 `:prefix-icon="'User'"` + `clearable`（`:164`）；密码框 `type="password"` + `show-password` + `:prefix-icon="'Lock'"`，placeholder 为「密码（需在服务端显式配置）」（`:167-173`，与 `admin.py:105` 的后端约定呼应）；登录按钮 `:loading="loading"`（`:176`）。
- 扫码标签（`:182-202`）：180×180 虚线框（`:253-261`）内三态——有 `qr.image` 显示图片（`:185`）、`qr.mock` 显示只读场景码 + 「复制场景码」按钮（`:186-193`）、否则显示「生成中…」（`:194`）；状态文案 `.qr-status`（失败时加 `.danger` 类，`:196`、`:293-295`）；失败原因行（`:197`）；`qrFailed || !qr` 时显示「重新获取二维码」link 按钮（`:198-200`）。
- 样式：scoped（`:208-306`）；背景 `linear-gradient(135deg, #8e0e00 0%, #1f1c18 100%)`（`:214`）；失败态用长征红 `#c8102e`（`:294`）；`.login-tabs :deep(.el-tabs__content){min-height:220px}`（`:241-243`）防两标签高度差导致卡片跳动。

## 5. 输入与输出

- 输入：用户键入的用户名/口令；`route.query.redirect`；扫码轮询响应；剪贴板写入权限（`copyScene`）。无 props/emits。
- 输出：`localStorage` 4 个登录态键（§4.3）；`router.push` 导航；`ElMessage` 提示；剪贴板内容（mock 场景码）。
- 请求错误语义：401（口令错误 / 令牌失效）、403（服务端未配置口令，账号登录不可用）、404（扫码会话不存在）、429 类限流（`login_limiter`/`qr_create_limiter`/`qr_poll_limiter`，后端 `rate_limit.require_rate` 抛出）——除 404 由本页自行重建会话外，其余均只依赖 `request.ts` 拦截器的 toast，本页不改写错误码。
- 加载/空/错误态：登录按钮 loading（`:176`）；二维码「生成中…」占位（`:194`）；`qrFailed` + `qrFailReason` 失败态与「重新获取二维码」入口（`:196-200`）；无「记住我」、无令牌有效期/倒计时展示（`expires_in` 字段未被消费，见 §9 第 3 项）。

## 6. 依赖关系

- 依赖：`vue`（`onBeforeUnmount`/`reactive`/`ref`，`:3`）、`vue-router`（`useRoute`/`useRouter`，`:4`）、`element-plus`（`ElMessage` 直接导入 `:5`；`FormInstance`/`FormRules` 为类型导入 `:6`；card/tabs/tab-pane/form/form-item/input/button 组件由 `plugins/element-plus.ts` 注册）、`../api/admin`（`createWechatQr`/`fetchMe`/`login`/`pollWechatQr` + 2 个类型，`:7-8`）、`../store/auth`（`setProfile`/`setToken`，`:9`）。
- 图标以字符串引用（`'User'` `:164`、`'Lock'` `:171`），依赖 `main.ts:77-78` 的全局图标注册（注册清单见 `.qoder/admin/src/main.ts.md`）。
- 被依赖：`admin/src/router/index.ts:15-20`（`/login` 懒加载）。`api/request.ts:34` 以 `path === '/login'` 硬编码识别本页（改 path 需同步该处）。
- 不引用 `admin/src/components/` 公共组件；不订阅 WebSocket（未导入 `utils/liveUpdates`）；不使用 `utils/format`。
- 后端链路：`admin.py` 的 `/login`、`/me`（→ `access_service.get_all_menu_items`/`get_menu_items`）、`/wechat/qr`、`/wechat/qr/{id}/status`（→ `identity_service.create_login_session`/`poll_login_session`/`issue_admin_token`、`wechat_service.get_wxacode_png`）；涉及表 `admin_login_sessions`、`admin_menus`、`admin_user_roles`、`audit_logs`（扫码成功写 `admin.login.qr`，`backend/app/services/identity_service.py`）。

## 7. 业务规则

1. **双通道登录**：账号密码通道仅对服务端显式配置口令的内置超管开放；未配置时后端 403 并引导改用扫码（`admin.py:105`、`:108-109`）。口令值只存在于服务端配置，前端不保存、不预填（本页仅预填用户名 `:18`）。
2. **令牌先于档案**：必须先 `setToken` 再请求 `/me`（§4.1，`9724d9a` 修复点）；`isLoggedIn()` 要求两者并存（`store/auth.ts:49-52`）。
3. **权限以服务端为准**：菜单码集合来自 `/me`（账号登录）或轮询 `confirmed` 响应（扫码登录），前端只把它存进 localStorage 供菜单过滤与守卫使用；前端过滤不是安全边界，后端每请求经 `access_service.build_principal` 重建权限（`.qoder/ARCHITECTURE.md` §5.3）。
4. **扫码会话单次签发**：`confirmed` 但无 `token`/`username` 视为已被其他标签页消费，本页重建二维码而不报错（`:114-117`；后端 `admin.py:148` 注明「单次签发，防重放」）。
5. **轮询节奏**：固定 2s 的**链式**轮询（上一次返回后才排下一次），不是固定间隔并发轮询；任何终态（成功/失败）与卸载/切标签都必须停止（§4.2）。
6. **失败静默**：轮询请求以 `silent: true` 抑制全局 toast，仅 404 触发会话重建，其余错误静默续轮（`:101-103`）。
7. **回跳契约**：`redirect` query 参数名与守卫（`router/index.ts:105`）成对，缺省回跳 `/`（`:28`）。
8. **限流在后端**：登录/出码/轮询三处限流均由后端实施，前端不做失败计数或锁定。

## 8. 修改约束

- 不得把 `setToken` 移到 `fetchMe` 之后（§4.1、§7 第 2 条）；也不要在 `setProfile` 之前跳转，否则守卫可能因 `isLoggedIn()` 为假把用户弹回登录页。
- `pollWechatQr` 的 `{ silent: true }`（`api/admin.ts:386`）必须保留，否则每 2 秒的失败轮询会连弹错误提示。
- `pollGen` 与 `pollTimer` 必须成对维护：新增任何提前返回/重启路径都要先 `stopPolling()` 或校验代次，否则会出现「双份轮询」或「已卸载仍在请求」。恢复成 `setInterval` 会同时丢掉这两个保护（`30b4458` 的修复点）。
- `onBeforeUnmount(stopPolling)`（`:150`）不可删除；本页是**唯一**持有长轮询定时器的非数据页（数据页的 WS 订阅走 `utils/liveUpdates`）。
- `redirect` 参数名与 `router/index.ts:105`、`request.ts:34` 的 `/login` 路径判断构成三方契约，改动需同步。
- 不得在本页写入任何默认口令、密钥或 AppSecret（后端 `admin.py:105` 明确「不硬编码默认密码」；`.qoder/README.md` §3 第 14 条同样禁止文档出现凭据值）。
- 视觉不变量：登录页深红渐变与长征红强调色（`admin/agents.md`「开发约定」第 3 条）；两标签内容区高度差需用 `min-height`（`:241-243`）吸收。
- 若未来下线扫码登录，需同步清理 `api/admin.ts` 的 `createWechatQr`/`pollWechatQr` 与 `QrCreateResult`/`QrStatusResult`，并核对 `main.ts` 图标注册（现已存在无引用的 `Iphone` 注册，见 §9 第 2 项）。

## 9. 当前实现状态

- **已实现**：账号密码登录、微信扫码登录（含 mock 场景码开发模式）、`redirect` 回跳、轮询代次守卫与卸载清理、表单必填校验，均可用；历次浏览器验收见 §10。
- **存在问题 / 已知事项**：
  1. **扫码登录仍然在册**：`afbcba9`（2026-10-12）下线的是**员工入驻二维码**（`fetchOnboardingQr`，原挂在 `layout/AdminLayout.vue` 顶栏，已迁往 `views/InvitesView.vue`），与本页的**登录小程序码**（`createWechatQr`/`pollWechatQr`）是两套接口。本页 `:7`、`:76-130`、`:182-202` 为现行有效代码，非残留死代码。
  2. `main.ts:14`、`:54` 注册的 `Iphone` 图标在 `admin/src` 全目录无任何引用（grep 仅命中 `main.ts`）→ **死注册**；成因与是否随 `afbcba9` 移除入驻码弹窗遗留**待确认**（`main.ts` 文档由并行任务维护，此处仅记录事实）。本页自身无扫码/手机号相关的残留 UI 或死代码。
  3. `QrCreateResult.expires_in` 与 `QrStatusResult.expires_in` 均未被本页消费（`:83-87`、`:97` 只用了其他字段），二维码到期只能等轮询到 `expired` 才提示（`:123-125`），期间无剩余时间/倒计时展示。
  4. `fetchMe` 失败时令牌已写入而档案缺失：`isLoggedIn()` 为假（`store/auth.ts:49-52`）故守卫会把用户退回登录页，但 `handleLogin` 的 `catch` 不调 `clearAuth`（`:43-44`），localStorage 会残留一枚有效令牌（下次任意 401 时由 `request.ts:38` 清掉）。风险低，列为已知事项。
  5. `redirect` 直接取自 query 且未做白名单/同源校验（`:28-29`）即交给 `router.push`；能否被构造成站外跳转**待确认**（未实测）。
  6. `copyScene` 依赖 `navigator.clipboard`，在非安全上下文（HTTP 直连 IP 等）必然走 warning 分支（`:137-139`）——生产为 HTTPS 时不受影响，部署形态见 `.qoder/ARCHITECTURE.md` §12.2。
  7. 用户名输入框预填默认值（`:18`），属便利设计；若安全审计要求「不预填账号」需删除该行。
  8. `pollOnce` 在 `qr` 为空时直接 return 且**不续排轮询**（`:94`）：正常流程不会出现（`schedulePoll` 只在 `qr` 赋值后调用），但若未来调整 `startQr` 顺序需留意轮询会静默停摆。
- **待开发**：无本页专属待办。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/views/LoginView.vue`，共 **4 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复（本页涉及 2 项：扫码轮询链式化、登录态写入函数拆分）。
- 修改内容（涉本文件）：共 +51/-37 行（`git show --numstat 30b4458 -- admin/src/views/LoginView.vue` 实测）——① `window.setInterval(pollOnce, 2000)` 改为链式 `setTimeout`：新增 `POLL_INTERVAL`（`:56`）、`pollGen` 代次计数（`:59`）、`schedulePoll(gen)`（`:69-74`），`stopPolling` 增加 `pollGen++`（`:62`），`startQr`/`pollOnce` 全链路加代次校验（`:84`、`:89`、`:99`、`:106`）；② `pollOnce` 的错误分支改为「404 重建会话、其余错误静默续排」（`:98-105`），并把 `scanned` 与其他待定态合并到同一分支（`:126-129`）；③ `setAuth(token, username)` 调用替换为 `setToken(token)`，`handleLoggedIn` 不再接收参数（`:27-30`、`:38`、`:110`）；④ 导入类型增加 `QrStatusResult`（`:8`）。
- 关联文件：`admin/src/store/auth.ts`（`setAuth` → `setToken`+`setProfile`）、`admin/src/utils/format.ts`、`admin/src/views/AccessView.vue`、`admin/src/views/AuditView.vue`、`admin/src/router/menus.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-09（`9724d9a`）
- 需求：修复账号登录失败缺陷——先调 `/me` 时请求未带 token。
- 修改内容（涉本文件）：在 `login()` 成功后、`fetchMe()` 之前插入令牌写入（当时代码为 `setAuth(data.token, data.username)`，`30b4458` 后为 `setToken(data.token)`，现 `:38`），使 `api/request.ts:19-25` 的请求拦截器能为 `/me` 注入 `Authorization`。
- 关联文件：`admin/src/store/auth.ts`、`admin/src/api/request.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `9724d9a` 条目。

### 2026-10-09（`54a0de7`）
- 需求：扫码登录与人员授权/审计页（P3 管理端）。
- 修改内容（涉本文件）：新增「微信扫码」标签与 2s 轮询自动登录（提交主题「登录页双标签（账号/微信扫码+2s 轮询自动登录）」）——`createWechatQr`/`pollWechatQr` 调用、mock 场景码与复制、`confirmed`/`scanned`/`failed`/`expired` 状态机、`setProfile` 写入超管标记与菜单码；本文件逐行 diff 未核，细节以 `docs/迭代记录.md` 的 `54a0de7` 条目为准。
- 关联文件：`admin/src/api/admin.ts`、`admin/src/store/auth.ts`（`setProfile`/`hasMenu`）、`admin/src/router/index.ts`（守卫）、`backend/app/services/identity_service.py`、`backend/app/api/routes/admin.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `54a0de7` 条目（浏览器验收 20/20，修复 3 处验收缺陷）。

### 2026-09-30（`4a26520`）
- 需求：管理后台基础页面及依赖配置（初始批次）。
- 修改内容（涉本文件）：创建本文件——账号密码登录表单、必填校验、登录成功后跳转（初版无扫码标签，扫码由 `54a0de7` 引入）；本文件逐行 diff 未核，细节以 `docs/迭代记录.md` 的 `4a26520` 条目为准。
- 关联文件：`admin/src/main.ts`、`admin/src/router/index.ts`、`admin/src/api/admin.ts`、`admin/src/style.css`。
- 测试结果：见 `docs/迭代记录.md` 的 `4a26520` 条目。
