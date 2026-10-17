# bind.js（扫码确认页 · 页面级合一：bind.js / bind.wxml / bind.wxss / bind.json）

## 1. 文件路径

- `frontend/pages/bind/bind.js`（195 行）
- `frontend/pages/bind/bind.wxml`（35 行）
- `frontend/pages/bind/bind.wxss`（136 行）
- `frontend/pages/bind/bind.json`（4 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

**扫码确认落地页**（头注释 `bind.js:1-5`）：处理 PC 管理后台出示的二维码被微信扫码后的两类确认——`L{token}` 前缀为 **PC 管理后台扫码登录确认**，`B{token}` 前缀为**第三方身份绑定确认**（凭证格式与「仅后端可生成」见 `.qoder/frontend/services/identity.js.md` §2）。流程：解析 scene → 未登录先经 launch 自动登录（携带 redirect 回本页）→ `qrInfo` 查场景 → 按状态渲染确认卡/结果/错误 → `confirm/cancel` → 结果态。**本页不是邀请码/组织绑定页**（入驻邀请码 `i=CODE` 场景由 launch 页处理，`frontend/pages/launch/launch.js:5`、`:25-31`，与本页无关）。

**入口证据**：`app.json` `pages` 注册于 `frontend/app.json:22`。**小程序内无任何导航入口**——grep 全 frontend 的 `pages/bind/bind` 仅命中 app.json 注册与本页自身的 redirect 回跳串（`bind.js:40`）。实际入口是微信「扫一扫」PC 端小程序码：管理后台登录页调 `POST /api/admin/wechat/qr` 生成携带 scene 的小程序码（`.qoder/backend/app/api/routes/identity.py.md` §4.1 第 1 步），扫码冷启动直达本页 `onLoad(options)`。

## 3. 业务需求

- PC 扫码登录确认：需求「微信扫码登录与身份关联（批次 2）」后端侧 `b431e4d` 交付（`.qoder/backend/app/api/routes/identity.py.md` §3），业务时序见该文档 §4.1。
- 本页与 account 页、identity 服务：批次 5「身份关联小程序侧」`6ed1999`（2026-10-09）交付（`docs/迭代记录.md` 的 `6ed1999` 条目；`.qoder/frontend/services/identity.js.md` §3）。
- B 前缀绑定场景属 `wx_web`（开放平台网站应用）渠道的**预留半程**：确认/取消流程就绪，但全代码库无创建 `BindRequest` 行的生产入口（`.qoder/PROJECT.md` §8「架构级限制」第 10 项、`.qoder/backend/app/api/routes/identity.py.md` §7 规则 5），即 **bind 模式当前生产不可达**（详见 §9）。

## 4. 核心功能（bind.js）

### 4.1 `data` 状态字段（`:10-24`，按关注点分组）

| 分组 | 字段 | 写入点 |
|---|---|---|
| 页面状态机 | `phase`（`loading\|confirm\|done\|error`，`:11`） | `renderConfirm`/`showDone`/`showError` |
| 场景模式 | `mode`（`login\|bind`，`:12`） | `loadScene` 按 scene 前缀置位（`:52`、`:54`） |
| 确认卡文案 | `title/desc/hint/confirmText(初值'确认')/status`（`:13-17`） | `renderConfirm`（`:99-121`） |
| 结果态 | `resultIcon/resultTitle/resultDesc`（`:18-20`） | `showDone`（`:169-176`） |
| 错误态 | `errorTitle/errorDesc`（`:21-22`） | `showError`（`:178-184`） |
| 防重入 | `submitting`（`:23`） | `handleConfirm`/`handleCancel` 置位、末段 `.then` 复位（`:126`、`:144`、`:151`、`:165`） |

页面实例属性（非 data）：`this.scene`（`:37`，decode 后的场景凭证，供 confirm/cancel 复用）。

### 4.2 生命周期：仅 onLoad（`:26-45`），无 onShow/onHide/onUnload

`onLoad(options)` 四步：① `decodeURIComponent(options.scene)`，decode 抛异常时回退用原始串（`:27-32` try/catch）；② scene 缺失 → `showError('无效的扫码场景', …)` 终止（`:33-36`）；③ 登录守卫：`app.globalData.loggedIn` 为假 → `wx.reLaunch('/pages/launch/launch?redirect=' + encodeURIComponent('/pages/bind/bind?scene=…'))`（`:38-43`；launch 页对 `redirect` 的承接见 `frontend/pages/launch/launch.js:46`、`:124-129`，登录不可用时透传给 login 页 `:64-65`；守卫约定 `frontend/AGENTS.md` §4 不变量 5）；④ `loadScene()`（`:44`）。

**无定时器、无动画句柄、无事件监听、无 WS 订阅**——三个清理钩子（onHide/onUnload）不存在也无清理债务；加载态的 `pulse` 动画是纯 CSS（`bind.wxss:28-35`），随页面销毁自然结束。本页是一次性确认页，未实现 `onShow + refresh()`（不变量 1 针对数据展示页；本页回前台不重查场景状态，现状事实，见 §9）。

### 4.3 `loadScene()`（`:48-71`）——前缀分流 + 场景查询

- 先按 `scene.charAt(0)` 本地分流：`L` → `mode:'login'`（`:51-52`）、`B` → `mode:'bind'`（`:53-54`）、其他 → `showError('无效的扫码场景', '场景凭证格式不正确…')` 且**不发请求**（`:55-57`）。后端对非 L/B 前缀同样 400（`.qoder/backend/app/api/routes/identity.py.md` §4.2），前缀是「小程序码 scene ↔ 本页分发 ↔ 后端分发」三方契约（同文 §8.1）。
- `identity.qrInfo(scene)`（`:60-61`）成功 → `renderByStatus(info)`（`:62`）；失败按 message 分类（`:63-70`）：匹配 `/不存在或已过期/` → 「凭证不存在或已过期」+ 引导回 PC 重新获取二维码；其余 → 「查询失败」+ 原始 message 或「网络异常，请重试」。
- 注意：**L 场景 `qrInfo` 查询即把会话置 `scanned`**（`.qoder/frontend/services/identity.js.md` §4 表行 1；后端 `mark_scanned` 见 identity.py.md §4.1 第 3 步），PC 轮询端由此感知「已扫码」。

### 4.4 `renderByStatus(info)`（`:74-96`）——状态 → 视图映射

| `info.status` | 渲染 | 行号 |
|---|---|---|
| `pending` / `scanned` | `renderConfirm(info)` 确认卡 | `:76-79` |
| `confirmed` / `used` | `showDone('已确认', …)`，文案随 mode：login→「PC 端即将进入管理后台」、bind→「身份绑定已完成」 | `:80-86` |
| `cancelled` | `showDone('已取消', '本次扫码请求已取消')` | `:87-90` |
| `failed` | `showError('该请求未获授权', info.failReason ‖ 兜底文案)` | `:91-94` |
| 其他（含 `expired`） | `showError('凭证已失效', …)` | `:95` |

状态机取值权威在后端（`pending/scanned/confirmed/failed/cancelled/used/expired`，`.qoder/backend/app/api/routes/identity.py.md` §5）。重复扫已确认的码会落到 `confirmed/used` 分支直接展示结果，不再出现确认按钮——**一次性凭证语义由后端状态机保证**（`.qoder/frontend/services/identity.js.md` §7 规则 2：确认后凭证失效，重复 confirm 后端 400）。

### 4.5 `renderConfirm(info)`（`:99-121`）——两种模式文案

- login（`:100-108`）：标题「确认登录 PC 管理后台？」+ 本人操作提示 + `confirmText:'确认登录'`；`status` 存 `info.status`。
- bind（`:109-120`）：标题「确认绑定新身份？」；desc 拼 `target.provider` 与 `target.appId`（`:115`）；hint 拼 `target.nickname`（存在时括注，`:110-111`、`:116`）+「绑定后该身份可用于登录 PC 端管理后台」；`confirmText:'确认绑定'`。`target` 不含 openid（后端隐私边界，`.qoder/frontend/services/identity.js.md` §8.2）；nickname 字段实际不下发（§9 已知事项 2）。

### 4.6 `handleConfirm()`（`:124-146`）与 `handleCancel()`（`:149-167`）

两者共用骨架：`submitting` 防重入（`:125`、`:150`）→ `identity.qrConfirm(this.scene, 'confirm'|'cancel')`（`:128`、`:153`）→ 成功/失败渲染 → 末段 `.then` 复位 `submitting`（`:143-145`、`:164-166`，充当 finally）。

- **confirm 成功**：`showDone('已完成', res.message ‖ 按 mode 兜底文案)`（`:129-132`）；后端成功 message 如「登录已确认」（`.qoder/backend/app/api/routes/identity.py.md` §4.1 第 4 步）。
- **confirm 失败**（`:133-142`）按 message 正则分类：`/未获授权|无后台访问权限|权限/` → 「未获授权」错误页（对应后端 403，无后台角色授权，identity.py.md §4.1 第 4 步）；`/不存在或已过期/` → 凭证过期页（404）；其余 → 「操作失败」。
- **cancel 成功**：`showDone('已取消', …)`（`:154`）。**cancel 失败**（`:155-163`）：message 匹配 `/不存在或已过期|仅对/` → **重新 `loadScene()` 查询并展示真实终态**（`:158-159`，行内注释「场景已进入终态时取消无效」——对应后端 cancel 仅 pending/scanned 生效、终态 400 的状态机，identity.py.md §4.1 第 4 步/§4.2）；其余 → 「操作失败」。

### 4.7 结果展示与关闭（`:169-194`）

- `showDone(title, desc)`（`:169-176`）：`phase:'done'`；icon 按 title 区分——「已取消」→ ⏸、其余 → ✅（`:172`）。
- `showError(title, desc)`（`:178-184`）：`phase:'error'`。
- `handleClose()`（`:187-194`）：`getCurrentPages().length > 1` → `wx.navigateBack()`；否则（扫码冷启动页面栈只有本页）→ `wx.switchTab('/pages/home/home')`。

## 4-1. WXML 专章（bind.wxml，35 行）

单容器 `.bind-page` 内按 `phase` 四分支互斥渲染，无列表、无 `wx:for`：

1. **loading**（`:3-6`）：`wx:if="{{phase === 'loading'}}"`，🔍 图标带 `pulse` 动画类 + 「正在查询扫码请求…」。
2. **confirm**（`:9-18`）：`wx:elif`，🚩 徽标 + `title/desc/hint` 三行文案 + 双按钮行——「取消」`btn-ghost bindtap="handleCancel" disabled="{{submitting}}"`（`:15`）、`{{confirmText}}` `btn-primary bindtap="handleConfirm" loading/disabled="{{submitting}}"`（`:16`）。
3. **done**（`:21-26`）：`resultIcon/resultTitle/resultDesc` + 「完成」按钮 `bindtap="handleClose"`。
4. **error**（`:29-34`）：`wx:else` 兜底，⚠️ + `errorTitle/errorDesc` + 「知道了」按钮 `bindtap="handleClose"`。

表达式全部为字段直读，无原生方法调用（`frontend/AGENTS.md` §5.2）；无 `wx:key` 场景。

## 4-2. WXSS 专章（bind.wxss，136 行）

- **布局**：`.bind-page` 全屏 flex 垂直居中，背景为品牌米色渐变 `#F7F1E5 → #FDF6EA`（`:1-9`，底色与 `frontend/AGENTS.md` §2 约定一致）。
- **两套卡片同构**：`.state-card`（加载/结果/错误共用，`:12-21`）与 `.confirm-card`（`:57-66`）——白底、24rpx 圆角、红调阴影、`#F0E6D2` 描边；`.confirm-badge` 品牌红渐变方块徽标 `#C8102E → #8E0E00`（`:68-79`）；`.confirm-hint` 米黄警示条（`:95-105`）。
- **本地 keyframes 1 组**：`bind-pulse`（加载图标呼吸缩放，`:28-35`），由 `.pulse` 类引用（`:28-30`）。
- **按钮**：`.btn-primary`（红底白字，含 `[disabled]` 变灰态 `:123-126`）与 `.btn-ghost`（白底红边，`:128-136`）均**本地定义**；app.wxss 存在同名全局 `.btn-ghost`（`frontend/app.wxss:55` 实测），页面样式在同优先级下覆盖全局。主色 `#C8102E` 符合全局约定。
- 无死选择器：15 个类名（另含 `.btn-primary[disabled]` 属性变体）逐一与 bind.wxml 比对均有使用（含 `pulse/state-btn/confirm-actions` 等）。

## 4-3. JSON 专章（bind.json，4 行）

仅 2 个键：`navigationBarTitleText: "扫码确认"`、`usingComponents: {}`。未声明导航栏颜色 → 继承 `app.json` `window` 全局默认（`#C8102E` 底 + white 字，`frontend/app.json:29-35`，转引自 `.qoder/frontend/pages/home/home.js.md` §4-3 的实测记录）。无下拉刷新配置。

## 5. 输入与输出

- **入参**：`onLoad(options)` 仅消费 `options.scene`（扫码携带的完整凭证串，含 L/B 前缀，≤32 字符受微信 scene 硬限制，`.qoder/backend/app/api/routes/identity.py.md` §8.2）；另可经 launch/login 的 `redirect` 回跳重新带入（`:40-41`）。
- **出参（页面调用的 service 与后端路径）**：

| service 调用 | bind.js 行号 | 后端路径 |
|---|---|---|
| `identity.qrInfo(scene)` | `:61` | `POST /api/auth/qr/info`（`.qoder/frontend/services/identity.js.md` §4 表行 1） |
| `identity.qrConfirm(scene, 'confirm')` | `:128` | `POST /api/auth/qr/confirm`（同表行 2） |
| `identity.qrConfirm(scene, 'cancel')` | `:153` | 同上 |

- **错误出口**：全部经 `showError` 渲染为错误态卡片（无 toast）；后端错误码 → 页面文案的映射由 message 正则分类完成（§4.3/§4.6），401/403 账号态等统一由 request.js 链处理（`.qoder/frontend/services/identity.js.md` §5：异常以 reject 冒泡到页面自行提示）。

## 6. 依赖关系

- **require（`:6-7`，2 项全部有使用）**：`app = getApp()`（仅读 `globalData.loggedIn`）、`services/identity`（3 处调用见 §5）。页面零直接 `wx.request`、零 Storage 读写（符合 `frontend/AGENTS.md` §3.1/§6.5；登录态仅经 globalData）。
- **被依赖**：`app.json:22` 注册；launch 页 `redirect` 机制的回跳目标（`bind.js:40`、`launch.js:7` 注释「旧有的扫码确认流程回跳目标」）；PC 管理后台登录页出示的小程序码落地页（identity.py.md §4.1）。automator 验收报告 `frontend/test/docs/identity-bind-account-report.md`（identity.py.md §9 转引）。
- **数据库表**：前端不触库；后端涉 `qr_login_sessions`/`bind_requests`/`user_identities`/`audit_logs`（`.qoder/backend/app/api/routes/identity.py.md` §6）。

## 7. 业务规则

1. **登录守卫与缓存键**：本页不读写任何 Storage 键；守卫在 `onLoad` 判断 `app.globalData.loggedIn`，未登录 reLaunch launch 并以 `redirect` 保留 scene 回跳（`:38-43`），登录成功后回本页重走 `onLoad`。
2. **一次性凭证**：confirm/cancel 后凭证进入终态，重扫只展示结果态（§4.4）；并发/重复 confirm 的幂等拒绝全在后端（400「已使用或已失效」，identity.py.md §4.1 第 4 步），前端不做缓存。
3. **本人操作确认**：确认卡 hint 明确要求核对发起端（`:105`、`:116`），取消/确认双按钮对等展示——防钓鱼扫码的交互层。
4. **授权门槛**：login 场景确认者须已有后台角色授权，否则后端 403、页面渲染「未获授权」错误态（`:135-136`；identity.py.md §4.1 第 4 步）。
5. **绑定三重唯一性校验**（身份已属他人/同渠道已绑/unionid 冲突 → 400）全在后端事务内，前端只透传展示（`.qoder/frontend/services/identity.js.md` §7 规则 4）。

## 8. 修改约束

1. **L/B 前缀三方契约**：scene 前缀同时被小程序码生成（后端）、本页 `:50-57` 分发、后端 `qr/info`/`qr/confirm` 分发消费，改前缀需三端同步（identity.py.md §8.1）。
2. **错误分类依赖后端中文 detail 文案**：`:65`、`:135`、`:137`、`:158` 的四处正则直接匹配后端错误 message（如「不存在或已过期」「无后台访问权限」），后端改文案会静默破坏分类降级为通用错误——改任一侧须核对另一侧。
3. `qrInfo` 返回结构（`type/status/target/expiresAt/failReason`）是本页渲染契约；`target` 不得假设含 openid（identity.js.md §8.2）。
4. `submitting` 防重入与末段 `.then` 复位（`:143-145`、`:164-166`）不得移除，否则确认卡可连点重复提交。
5. scene 必须经 `encodeURIComponent` 进出（`:40-41` 与 `:29` 对称），token 含特殊字符时截断即失效。

## 9. 当前实现状态

- **已实现**：L 场景（PC 扫码登录确认）全链路可用，随 `6ed1999` 交付并经 automator 15/15 断言验收（identity.js.md §9）；四态渲染、防重入、cancel 失败重查、冷启动关闭兜底齐备。
- **存在问题 / 已知事项（事实陈述）**：
  1. **bind 模式（B 场景）生产不可达**：全代码库无创建 `BindRequest` 行的入口，绑定只有确认/取消半程（`.qoder/PROJECT.md` §8「架构级限制」第 10 项、identity.py.md §7 规则 5）——本页 `:53-54`、`:109-120` 的 bind 分支属预留代码，仅测试 fixture 可触发。
  2. `:111` 消费 `target.nickname`，但后端 `QrInfoOut.target` 仅下发 `provider/appId`（identity.py.md §4.2），nickname 括注分支实际不生效。
  3. `:92` 消费 `info.failReason`，但该字段在 `qr/info` 响应中恒为 null（identity.py.md §5 已知事项 2，失败原因由 PC 轮询接口取），实际总走兜底文案「请联系管理员为你的账号授权后台访问」。
  4. 无 `onShow`：页面回前台不重查场景状态（如 PC 端已取消，手机端仍停留在旧确认卡，提交时才由后端 400 拦截并经 `:158-159` 重查）——一次性确认页的现状设计，是否需补 onShow 重查**待确认**。
- **待开发**：无（bind 半程的缺失在后端凭证创建入口，非本页）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/bind/`（**2 个提交**），均已核对存在于 `docs/迭代记录.md`。按时间倒序。

### 2026-10-11（`01e214a`）
- 需求：V1.0 启动页自动登录并取消强制选组织。
- 修改内容（涉本文件）：未登录守卫由 `reLaunch /pages/login/login?redirect=` 改为 `reLaunch /pages/launch/launch?redirect=`，注释同步为「未登录先经启动页自动登录」（`:38-43`；diff 实读确认仅此一处）。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目。

### 2026-10-09（`6ed1999`）
- 需求：身份关联小程序侧（批次 5）。
- 修改内容（涉本文件）：创建四件套——扫码确认页（L/B 双模式、qrInfo/qrConfirm 对接）；同批交付 account 页、`services/identity.js`、login redirect 支持与 mine 入口（提交信息）。
- 关联文件：`frontend/pages/account/account.js`、`frontend/services/identity.js`、`backend/app/api/routes/identity.py`。
- 测试结果：automator 15/15 断言 + 6 截图验收（提交信息）；详见 `docs/迭代记录.md` 的 `6ed1999` 条目。
