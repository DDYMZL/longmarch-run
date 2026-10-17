# activity.js（活动状态页 · 页面级合一：activity.js / activity.wxml / activity.wxss / activity.json）

## 1. 文件路径

- `frontend/pages/activity/activity.js`（59 行）
- `frontend/pages/activity/activity.wxml`（35 行）
- `frontend/pages/activity/activity.wxss`（157 行）
- `frontend/pages/activity/activity.json`（8 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

活动未发布 / 未开始 / 已结束时的**统一引导页**（`activity.js:1-5` 头注释）：展示活动名称、状态徽章、起止时间、结束标题与提示文案；`allowView` 时提供进入首页/查看排行两个出口，否则仅「刷新状态」。

**入口证据**（grep `pages/activity/` 全仓核实，页面注册于 `frontend/app.json:26`），三条路径、两种导航方式：

1. **request.js 自动重定向（主要入口）**：任何页面的查看类 GET 被活动闸门拦截（403 + `X-Activity-Status: unpublished|not_started|ended`）时，`redirectActivityClosed()` 以 3 秒去抖 `wx.reLaunch` 到本页（`frontend/services/request.js:6` `ACTIVITY_PAGE` 常量、`:110-119`；机制详见 `.qoder/frontend/services/request.js.md` §4.8/§4.9 第 1 步——仅 GET 且未传 `skipActivityRedirect` 才跳，POST 参与类只抛错）。
2. **启动页分流**：launch 页登录后调 `getStatus()`，`allowView` 为假即 `wx.reLaunch(ACTIVITY_PAGE)`（`frontend/pages/launch/launch.js:20`、`:112-118`；接口失败默认放行 fail-open，`.qoder/backend/app/api/routes/activity.py.md` §6）。
3. **首页活动横幅**：`frontend/pages/home/home.js:356` `goActivity` 以 `wx.navigateTo` 进入（home.js.md §4.8）。

## 3. 业务需求

V2.0「活动状态页与查看拦截」批次交付，`git log --follow` 仅 **1 个提交** `44eb77b`（2026-10-13，见 §10）；同批交付 `frontend/services/activity.js`（`.qoder/frontend/services/activity.js.md` §3）与后端公开状态端点（`.qoder/backend/app/api/routes/activity.py.md` §3）。

## 4. 核心功能（activity.js）

### 4.1 常量与 `data` 字段

- `STATUS_ICON`（`:8-13`）：四种活动状态的图标映射——`unpublished` 📜 / `not_started` ⏳ / `ongoing` 🚩 / `ended` 🏆；未匹配兜底 🚩（`:37`）。key 与后端 `status` 枚举一致（activity.py.md §4）。
- `data`（`:16-23`）6 字段：`loading`（初值 true）/`errorMsg`（加载失败文案）/`status`（后端状态对象整体）/`icon`/`title`/`rangeText`（三个 js 侧预计算的展示字段）。无实例属性、无定时器、无 Canvas、无 WS 订阅。

### 4.2 生命周期与刷新

- **`onShow`（`:25-27`）**：只调 `refresh()`。**无登录守卫**——本页可在登录前到达（launch 分流路径），数据源 `GET /api/activity/status` 是公开端点、无鉴权（activity.py.md §3/§4），故不适用子页守卫不变量（`frontend/AGENTS.md` §4 不变量 5 针对需登录数据；现状事实）。无 onHide/onUnload（无资源需清理）。
- **`refresh()`（`:29-46`）**：置 `loading:true` 清 `errorMsg` → `activity.getStatus()`（`:32`）→ 成功：单次 setData 写入 `status` 整体 + 派生三字段——`icon = STATUS_ICON[s.status] || '🚩'`（`:37`）、`title = ended ? s.endTitle : s.name`（`:38`，结束态标题换后端下发的结束文案）、`rangeText = activity.formatRange(s)`（`:39`，ISO 时间截为「YYYY-MM-DD HH:mm 至 …」，activity.js.md §4）；失败：`errorMsg = err.message || '活动状态获取失败，请稍后重试'`（`:42-44`）；finally 语义的尾 `.then(() => wx.stopPullDownRefresh())`（`:45`，成功失败都停下拉动画）。
- **`onPullDownRefresh`（`:48-50`）**：复用 `refresh()`（json 开启下拉刷新，§4-3）。

### 4.3 事件处理与导航出口（全部）

| 方法 | 行号 | 行为 |
|---|---|---|
| `goHome()` | `:52-54` | `wx.switchTab('/pages/home/home')`，失败兜底 `wx.reLaunch('/pages/launch/launch')`（tab 切换异常时回启动链） |
| `goRank()` | `:56-58` | `wx.switchTab('/pages/rank/rank')` |
| `refresh`（WXML 按钮复用） | `:29` | 错误面板「重新获取」与不可查看态「刷新状态」按钮直接绑定（WXML `:9`、`:32`） |

## 4-1. WXML 专章（activity.wxml，35 行）

深红氛围背景两装饰层（`bg-grid` 金线网格 + `bg-glow` 顶部光晕，`:2-3`）后三态互斥（wx:if/elif/else）：① 加载态——`loading && !status` 时「正在获取活动状态…」（`:5`）；② 错误态——`errorMsg && !status` 时错误文案 + 「重新获取」按钮（`:7-10`）；③ 主面板（`:12-34`）：图标徽章（`anim-pop` 全局动画，`:13`）、品牌名 `status.name`、大标题 `title`、状态徽章 `status-chip status-{{status.status}}`（动态类名拼接，`:16`）、`status.message` 提示、活动时间卡（`rangeText` 非空时，`:18-21`）。**note 三分支**（`:23-25`）：ended+allowView→「成绩与排行可继续查看，不再产生新的步数、答题与积分」；ended 不可查看→「成绩查看通道已关闭」；其余不可参与（未发布/未开始）→「活动开始后即可同步步数、参与答题并获得积分」。**actions 区**（`:27-33`）：`allowView` 时两按钮——主按钮文案随 `allowParticipate` 切「进入征程 / 进入首页」（`:29`，进行中经首页横幅进入时即显「进入征程」）+「查看积分排行」；不可查看时仅「刷新状态」（`:32`）。表达式无原生方法调用，展示字段全部 js 侧预计算（§4.2）。

## 4-2. WXSS 专章（activity.wxss，157 行）

- 独立深红主题（区别于全站浅底）：页面 170° 深红渐变 `#2A040B→#8E1023`（`:1-9`）、金色网格与光晕装饰（`:11-32`）、文字米金 `#FFF6DC` 系。
- 徽章圆形金边发光（`:47-57`）；大标题金色 `#FFD766` + text-shadow（`:66-73`）；状态徽章基础样式 `.status-chip`（金描边胶囊，`:75-82`）+ 两个状态覆写——`.status-ended` 金底深红字（`:84-87`）、`.status-ongoing` 绿底白字（`:89-93`）；**`unpublished`/`not_started` 无专属覆写**，动态类 `status-unpublished`/`status-not_started` 落空、仅呈现基础金描边样式（现状事实，非死选择器）。
- 按钮两态：`.btn-gold` 金渐变实心 / `.btn-line` 透明描边（`:132-152`），`::after` 去微信默认边框（`:154-157`）。
- 全局依赖仅 `.anim-pop`（`frontend/app.wxss:305`）；全部选择器与 WXML 逐一对照均有使用，无死选择器。

## 4-3. JSON 专章（activity.json，8 行）

6 个键：`navigationBarTitleText: "活动状态"`、`navigationBarBackgroundColor: "#2A040B"`（深红主题，偏离全局 `#C8102E`）、`navigationBarTextStyle: "white"`、**`enablePullDownRefresh: true`**（配合 `onPullDownRefresh`，本页是三个页面文档中唯一开启下拉刷新的）、`backgroundTextStyle: "light"`、`backgroundColor: "#2A040B"`（下拉露出的窗口背景同主题色）。无 `usingComponents`。

## 5. 输入与输出

- **入参**：无。reLaunch/navigateTo 均不带 query，页面不读 `onLoad(options)`。
- **出参（页面调用的 service 与后端路径）**：仅一个——`activity.getStatus()`（`:32`）→ `GET /api/activity/status`（公开端点、无鉴权、实时计算不落库，`.qoder/backend/app/api/routes/activity.py.md` §4；service 侧带 `skipActivityRedirect: true`，`.qoder/frontend/services/activity.js.md` §4）。`activity.formatRange` 为纯函数无请求（`:39`）。
- **错误出口**：请求失败 → `errorMsg` 面板 + 重试按钮（`:42-44`、WXML `:7-10`），无自动重试。

## 6. 依赖关系

- **require（`:6`，仅 1 项）**：`services/activity`（getStatus/formatRange）。不依赖 `getApp()`、零 Storage、零 WS、零直接 `wx.request`（`frontend/AGENTS.md` §3.1/§6.5）。
- **被依赖**：`app.json:26` 注册；`frontend/services/request.js:6` 将本页路径硬编码为活动拦截跳转目标 `ACTIVITY_PAGE`（request.js.md §4.1）；`frontend/pages/launch/launch.js:20` 同款常量；home 页横幅入口（§2）；automator 验收 `frontend/test/automator/v2-miniprogram.cjs:414`、`:489`。
- **数据库表**：前端不触库；后端只读 `activity_settings` 单行（activity.py.md §6）。

## 7. 业务规则

1. **各状态渲染矩阵**（代码逐行核实）：

| status | 图标 | title | note | 按钮 |
|---|---|---|---|---|
| unpublished / not_started | 📜 / ⏳ | `name` | 「活动开始后即可…」 | `allowView` 决定：真→进入首页+排行；假→仅刷新状态 |
| ongoing | 🚩 | `name` | 无（`allowParticipate` 为真不落任何 note 分支，WXML `:23-25`） | 进入征程 + 查看积分排行 |
| ended（allowView） | 🏆 | `endTitle` | 「成绩与排行可继续查看…」 | 进入首页 + 查看积分排行 |
| ended（不可查看） | 🏆 | `endTitle` | 「查看通道已关闭…」 | 仅刷新状态 |

2. **本页不会成为重定向循环的源头**（任务核查项，代码证实）：本页发出的唯一请求 `getStatus` 在 service 层固定携带 `skipActivityRedirect: true`（`.qoder/frontend/services/activity.js.md` §4/§8.1），request.js 的活动拦截跳转对它不生效（`.qoder/frontend/services/request.js.md` §4.9 第 1 步）；该端点又是公开无鉴权接口，401/403 拦截路径均不可达。故「活动页发请求 → 又被拦回活动页」的自引用循环被 service 层开关阻断；即使他页并发被拦，request.js 的 3 秒模块级去抖也只 reLaunch 一次（request.js.md §4.8/§9 已知事项 2）。
3. **再入口语义**：`allowView` 为真才给首页/排行出口（WXML `:28-31`）；为假时用户被留在本页，唯一操作是「刷新状态」——无返回登录/首页路径（reLaunch 进入时页面栈也已清空），头注释「可查看时提供进入首页 / 排行入口」（`:4`）与实现一致。经首页横幅 navigateTo 进入的场景不受影响（系统返回键可回首页）。
4. 状态判定（含 `allowView` = ended 后按 `allow_view_after_end` 配置）全在后端实时计算（activity.py.md §4/§7），前端不比对时间（activity.js.md §7 规则 1）。

## 8. 修改约束

1. **不得移除 service 层的 `skipActivityRedirect: true`**（`.qoder/frontend/services/activity.js.md` §8.1）——它是本页免循环的唯一保障（§7 规则 2）；同理，本页不得引入其他会触发活动拦截的 GET 请求，除非同样跳过跳转。
2. `STATUS_ICON` 的 key 与后端 `status` 四枚举值是硬契约，且同一组值被 `X-Activity-Status` 响应头复用（activity.py.md §8.2），改值需前后端三处同步。
3. `frontend/services/request.js:6` 与 `frontend/pages/launch/launch.js:20` 硬编码本页路径，页面改名/移动需同步两处常量。
4. WXML 状态徽章用动态类名 `status-{{status.status}}`（`:16`）：新增状态值时需同步补 WXSS 覆写（当前 unpublished/not_started 已落空，§4-2）。
5. 展示字段（icon/title/rangeText）必须留在 js 侧预处理（`frontend/AGENTS.md` §5.2）。

## 9. 当前实现状态

- **已实现**：四状态渲染、错误重试、下拉刷新、allowView/allowParticipate 双标志驱动的出口与文案、防自引用循环。单提交交付后经 v2 自动化验收（§10）。
- **存在问题 / 已知事项（事实陈述）**：
  1. `unpublished`/`not_started` 徽章无专属配色（§4-2），视觉上与默认描边态无区分——是否补样式属设计决策，**待确认**。
  2. ongoing 态无 note 文案（§7 规则 1 表），进行中经横幅进入时面板略空——现状事实。
  3. 不可查看态（`allowView=false`）用户无任何离开路径（§7 规则 3），只能反复刷新等待状态变化——设计如此（拦截语义），照实记录。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/activity/`，仅 **1 个提交**，已在 `docs/迭代记录.md` 按 hash 核对存在。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0 小程序批次——活动状态页与查看拦截。
- 修改内容（涉本文件）：创建本页四件套并注册 `app.json`；同批交付 `services/activity.js`、request.js 的 `X-Activity-Status` 消费与 3 秒去抖跳转、launch 页分流、首页活动横幅（`.qoder/frontend/services/request.js.md` §10、`.qoder/frontend/services/activity.js.md` §10 同日记载）。
- 关联文件：`frontend/services/activity.js`、`frontend/services/request.js`、`frontend/pages/launch/launch.js`、`frontend/pages/home/home.js`、后端 activity 域。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（提交信息自述 v2 自动化验收 14/14，含本页截图 `v2-miniprogram.cjs:489-490`）。
