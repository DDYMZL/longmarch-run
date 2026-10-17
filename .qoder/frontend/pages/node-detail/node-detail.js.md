# node-detail.js（页面级合一：node-detail.js / node-detail.wxml / node-detail.wxss / node-detail.json）

## 1. 文件路径

- `frontend/pages/node-detail/node-detail.js`（229 行）
- `frontend/pages/node-detail/node-detail.wxml`（121 行）
- `frontend/pages/node-detail/node-detail.wxss`（250 行）
- `frontend/pages/node-detail/node-detail.json`（5 行）

四件套合计 605 行。按 `.qoder/README.md` §1「页面级合一例外」规则合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

长征路线**节点详情页（历史事件卡）**：按 query 参数 `id` 拉取单节点详情，渲染「历史图片 → 标题+关键词 → 时间/地点 → 步数数据卡 → 简介 → 历史故事 → 历史意义 → 相关人物 → 路线位置小地图」的史料卡片（`:1-7` 头注释），头部叠加**区域氛围**渐变与粒子画布（需求 §12，主题来自 `frontend/data/node-themes.js`），并提供人物志、纪念票、回首页三个出口。**任意状态节点（含未解锁）均可查看**（`frontend/AGENTS.md` §4 不变量 8）。

四件套关系：js 承担取数与预处理（状态/千分位/关键词/坐标/主题）、氛围粒子画布生命周期与三个跳转；wxml 按 `node` 是否存在整体条件渲染，可选字段逐卡 `wx:if`；wxss 只做页面级补充，卡片/按钮/入场动画复用全局 `frontend/app.wxss`（§4-2）；json 仅导航栏 3 项配置（标题被 js 动态覆盖）。四文件只服务本页。

## 3. 业务需求

- 节点三态与历史事件卡：`GET /api/march/node/{node_id}` 的 `NodeDetailOut` 契约（`.qoder/backend/app/api/routes/march.py.md` §4-§5）。
- 区域氛围（需求 §12）：`:5-6` 头注释自引；主题映射按需求 §12.3 为**纯前端配置**（`.qoder/frontend/data/node-themes.js.md` §3）。
- 相关人物 → 人物志（需求 §14.3，`:208` 注释）；节点纪念票入口（需求 §19「仅已点亮节点可见入口」，`:224` 注释；`.qoder/REQUIREMENTS.md` §6.5「节点凭证页」行）。
- **AI 讲解面板：待开发，本页无任何 AI 代码**。后端 `GET /api/ai/route-guide/{node_id}` 已就绪但前端 grep 零调用（`.qoder/backend/app/api/routes/ai.py.md` §6.2、§9「待开发」第 1 项）；状态登记见 `.qoder/REQUIREMENTS.md` §6.7「`node-detail` AI 讲解面板」行与 §10.6「`node-detail` 讲解面板」行、`.qoder/ARCHITECTURE.md` §11.3「`node-detail` AI 讲解面板」行（均标**待开发**）。本页 js/wxml 全文核实：无 `services/ai` 引用、无讲解面板节点。

## 4. 核心功能

### 4.1 `data` 状态字段（`node-detail.js:14-26`，按关注点分组）

| 分组 | 字段 | 行号 | 说明 |
|---|---|---|---|
| 节点数据 | `node` | `:15` | `NodeDetailOut` 原样（坐标有效时替换为 Number 化副本，`:56`）；null 时整页 `wx:if` 不渲染（WXML `:1`） |
| 展示预处理 | `statusText` / `targetText` / `currentText` / `keywordList` | `:16-19` | 三态中文映射（`:39-43`）；步数千分位（`util.formatNumber`，`:58-59`）；`keywords` 逗号拆分数组（`:60`，WXML 不支持原生方法调用故在 js 预处理，`frontend/AGENTS.md` §5.2） |
| 小地图 | `markers` / `hasMapPoint` | `:20-21` | 单 marker（callout 常显节点名，`:65-84`）；坐标有效性标志（`:47-53`） |
| 区域氛围 | `themeKey` / `themeEnv` / `themeBgStyle` | `:23-25` | 主题标识 / 环境描述文案 / hero 内联渐变样式串（`:61-63`，来自 `nodeThemes.getNodeTheme` + `themeBgStyle`）；`themeKey` 被自动化测试断言（`.qoder/frontend/data/node-themes.js.md` §6） |

实例字段（不入 data）：`this._atmo`（画布上下文与粒子数组，`:144`）、`this._atmoRunning`（`:145`）、`this._atmoId`（rAF/timeout 句柄，`:150`/`:152`）。

### 4.2 节点 id 的来源与生命周期

- **id 经 query 参数 `?id=` 传入**，入口共 8 处（grep `pages/node-detail` 全 frontend 核实，均 `wx.navigateTo`）：`march.js:531`、`:540`、`:1463`、`:1475`（长征页地图/节点卡，4 处）；`home.js:398`（长征记忆彩蛋）、`:407`（首页情报卡）；`profile.js:219`（我的足迹）；`person.js:45`（人物志回链节点）。不只来自 march 页。
- `onLoad(options)`（`:28-93`）：① 登录守卫——未登录 `wx.reLaunch('/pages/launch/launch')`（`:30-33`，**不带 redirect 参数**，返回后不回本页）；② `parseInt(options.id, 10)`（`:35`）→ `march.getNodeDetail(id)`（`:36-37`，含坐标回退补齐，`.qoder/frontend/services/march.js.md` §4.2）；③ 成功后一次性 setData 全部展示字段并 `wx.setNavigationBarTitle(node.name)`（`:86`）、`startAtmosphere(theme)`（`:87`）；④ 失败（含 id 非数字 → 后端 422）toast「节点不存在」+ **800ms 后 `wx.navigateBack()`**（`:89-92`）。
- `onHide`/`onUnload`（`:95-101`）：均调 `stopAtmosphere()`，动画清理齐备（§4.4）。
- `onShow`（`:103-108`）：**只恢复氛围动画**（从人物/纪念票子页返回时，`:104` 注释），**不重拉节点数据**——与 `frontend/AGENTS.md` §4 不变量 1「数据展示页必须 onShow + refresh()」存在偏差：从 ticket/person 返回或后台恢复时，`status/remain/currentSteps` 可能滞后（例如期间步数同步点亮了本节点）。是否有意为之**待确认**（§9）。
- 登录守卫仅在 `onLoad`：页面停留期间登录态失效的场景依赖 `request.js` 的 401 链路兜底（`.qoder/frontend/services/request.js.md` §4.9）。

### 4.3 渲染的数据（消费 `NodeDetailOut` 的字段逐项映射）

| 后端字段（camelCase） | js 预处理 | 渲染位置（WXML） |
|---|---|---|
| `name` | `wx.setNavigationBarTitle`（js `:86`） | 标题 `:17`、marker callout（js `:74`） |
| `icon` | — | 无图时插画占位 `:10` |
| `images` | — | 有图 swiper `:4-8`（空数组走插画分支 `:9-11`） |
| `keywords` | `keywordList` 逗号拆分（js `:60`） | 关键词 chip `:19-21` |
| `historicalTime` / `location` | — | meta 卡 `:29` / `:33`（location 为空整项隐藏） |
| `targetSteps` / `currentSteps` | `targetText`/`currentText` 千分位（js `:58-59`） | 数据卡 `:42` / `:47` |
| `status` | `statusText` 三态映射（js `:39-43`） | 状态栏 `:52`、remain-tip 条件 `:57`、纪念票按钮条件 `:113`、按钮文案 `:118` |
| `remain` | — | 「距离点亮还需 N 步」`:58` |
| `brief` / `description` / `significance` | — | 简介 `:64`、历史故事 `:70`、历史意义 `:76`（brief/significance 为空对应卡整卡隐藏） |
| `figures` / `persons` | — | 相关人物文本 `:82` + 可点 chip `:83-91` |
| `latitude` / `longitude` | `hasMapPoint` 有效性判定 + Number 化 + `markers`（js `:45-84`） | 小地图中心点 `:100-101` 与 markers `:103` |
| `id` | — | 主题查询（js `:44`）、纪念票跳转参数（js `:227`）、marker id（js `:68`） |

后端详情还下发 `audio` 字段（`.qoder/backend/app/api/routes/march.py.md` §4「详情含历史事件卡字段（brief/significance/figures/location/images/audio/keywords）」），**本页未渲染音频**——是预留还是遗漏**待确认**。

### 4.4 区域氛围粒子画布（`:110-205`）

- `startAtmosphere(theme)`（`:116-157`）：先 `stopAtmosphere()` 防重复（`:117`）；`wx.createSelectorQuery` 取 `#atmoCanvas`（Canvas 2d，WXML `:12`）节点与尺寸（`:119-122`）；按 dpr 放大画布并 `ctx.scale`（`:126-130`）；按主题 `particleConfig` 一次性生成粒子（**上限 24 颗**，`:132`，`:113` 注释「rAF 循环内零分配」）；启动循环——优先 `canvas.requestAnimationFrame`，**不可用时降级 `setTimeout(loop, 33)`**（`:149-153`，约 30fps）。
- `drawAtmosphere(t)`（`:159-196`）：每帧 `clearRect` 后按 `cfg.type` 四分支绘制——`snow` 雪花下落+横向摆动（`:167-173`）、`ember` 暖尘上升（`:174-180`）、`mist` 水雾椭圆横移（`:181-186`）、其余按 `star` 星光原地闪烁（`:187-193`）；透明度随正弦相位变化，帧末复位 `globalAlpha = 1`（`:195`）。type 枚举与 `node-themes.js` 的 `particleConfig.type` 绑定（`.qoder/frontend/data/node-themes.js.md` §8.3）。
- `stopAtmosphere()`（`:198-205`）：置 `_atmoRunning = false`（循环首行自检退出，`:147`）+ `cancelAnimationFrame` + `clearTimeout` **双保险**（`:200-203`，rAF 句柄与 timeout 句柄共用 `_atmoId`，两种清除都执行）。
- **清理核对**：`onHide`、`onUnload`、重复 `startAtmosphere` 三处均调 `stopAtmosphere`，无泄漏路径；`onShow` 恢复有 `!_atmoRunning` 防重入（`:105`）。两处边界如实记录：① `:91` 的 800ms `setTimeout(navigateBack)` **未被跟踪清理**（窗口极短，用户在 800ms 内手动返回时会多触发一次 navigateBack）；② `createSelectorQuery.exec` 回调是异步的，若 `onHide` 恰发生在 `startAtmosphere` 调用与回调之间，回调仍会置 `_atmoRunning = true` 并起循环（`:144-155` 未复查页面可见性）——理论竞态，是否实际可触发**待确认**。

### 4.5 事件处理与出站跳转（全部出口）

| 处理函数 | 行号 | 跳转/行为 |
|---|---|---|
| `goPerson` | `:210-214` | `wx.navigateTo('/pages/person/person?id=' + dataset.id)`（相关人物 chip，WXML `:84-90`） |
| `handleContinue` | `:219-221` | `wx.switchTab('/pages/home/home')`——「继续运动/去运动点亮」回首页同步步数（`:217` 注释） |
| `goTicket` | `:226-228` | `wx.navigateTo('/pages/ticket/ticket?id=' + node.id)`；入口按钮仅 `status === 'completed'` 渲染（WXML `:112-116`），与 `.qoder/REQUIREMENTS.md` §6.5「节点凭证页」行「仅已点亮节点可进入」一致——**拦截在渲染层而非 goTicket 内** |
| 加载失败回退 | `:91` | `wx.navigateBack()`（延迟 800ms） |

### 4.9 页面状态矩阵

| 状态 | 触发条件 | 呈现 | 行号 |
|---|---|---|---|
| 加载中 / 加载失败 | `node` 为 null | 整页 `wx:if` 不渲染（**无骨架屏、无 loading 提示**）；失败 toast「节点不存在」后 800ms `navigateBack` | WXML `:1`；js `:89-92` |
| 无历史图片 | `node.images.length === 0` | hero 走 emoji 插画占位（主题渐变仍生效） | WXML `:4-11` |
| 无有效坐标 | `hasMapPoint === false` | 「暂无路线点位」空态卡（与地图同尺寸） | WXML `:97-108`；js `:47-53` |
| 未点亮 | `status !== 'completed'` | remain-tip「距离点亮还需 N 步」+ 按钮文案「去运动点亮」、无纪念票入口 | WXML `:57-59`、`:113`、`:118` |
| 可选内容缺失 | `brief`/`significance` 为空、`figures` 与 `persons` 均空 | 对应卡片整卡 `wx:if` 隐藏，不留空壳 | WXML `:63`、`:74`、`:80` |

## 4-1. WXML 专章（`node-detail.wxml`，121 行）

- 整页 `wx:if="{{node}}"`（`:1`），加载前/失败时无骨架屏（`:1` 之外无内容）。
- hero 区（`:3-13`）：`hero-wrap` 绑内联 `style="{{themeBgStyle}}"` 承载区域氛围渐变；有图走 `swiper`（indicator-dots + autoplay + circular，`:4-8`），无图走主题化插画占位（大 emoji `node.icon`，`:9-11`）；`<canvas type="2d" id="atmoCanvas">` 绝对定位覆盖其上（`:12`）。
- 内容卡依次为：标题+主题环境文案+关键词 chip（`:16-22`）、历史时间/地点 meta 卡（`:25-36`）、数据卡（目标步数/你的累计步数/状态三栏 + 未点亮时「距离点亮还需 N 步」提示，`:39-60`）、简介（`wx:if brief`，`:63-65`）、历史故事（`:68-71`）、历史意义（`wx:if significance`，`:74-77`）、相关人物（`figures` 文本 + `persons` 可点 chip，`:80-92`）、路线位置（`hasMapPoint` 时渲染 `<map>`，**禁用滚动/缩放/旋转**只读展示，`:97-107`；否则「暂无路线点位」空态，`:108`）。
- 操作区（`:111-120`）：纪念票按钮（仅 completed）+「继续运动/去运动点亮」按钮。
- 卡片入场动画靠全局 `.anim-card` 类 + 内联 `animation-delay` 逐级 80ms 递增（`:39`、`:63`、`:68`、`:74`、`:80`、`:95`）；`wx:key` 用 `*this`/`id`，无原生方法调用（`frontend/AGENTS.md` §5.2）。

## 4-2. WXSS 专章（`node-detail.wxss`，250 行）

| 区块 | 关键类 | 行号 | 要点 |
|---|---|---|---|
| hero 头部 | `.hero-wrap/.hero/.hero-themed/.hero-icon/.hero-swiper/.hero-image` | `:6-64` | swiper 高 420rpx；插画 hero 高 300rpx 红渐变；**主题激活时 `.hero.hero-themed` 背景置 transparent**，让位于 `themeBgStyle` 的区域渐变（`:10-17` 及注释）；emoji 图标圆形半透明底（`:55-64`） |
| 粒子层 | `.atmo-canvas` | `:19-27` | absolute 全覆盖 + `pointer-events: none` + `z-index: 3`（不吃点击、盖在图上） |
| 标题区 | `.title-block/.title-name/.theme-env/.keyword-*` | `:29-96` | 白卡 fadeUp 入场（`:73`）；主题环境文案金色小字（`:30-35`）；关键词米黄胶囊（`:90-96`） |
| meta/数据卡 | `.meta-*/.stat-*/.remain-tip` | `:99-173` | 三态配色 `.stat-value.completed` 鎏金 `#B8860B` / `.current` 长征红 / `.unlocked` 灰（`:141-151`）；1rpx 分隔线（`:159-163`）；remain-tip 米黄底（`:165-173`） |
| 文本卡 | `.brief-card/.brief-text/.story-text/.figures-*` | `:176-218` | 简介卡米黄渐变+金边（`:176-179`）；正文两端对齐、行高 1.9（`:189-194`）；人物 chip 浅红底可点样式（`:211-218`） |
| 小地图 | `.mini-map/.map-empty` | `:221-236` | **两态同尺寸** 320rpx + 圆角，有无点位布局不跳动 |
| 操作区 | `.detail-actions/.ticket-btn` | `:238-250` | fadeUp 0.6s 延迟 0.5s 入场（`:240`）；纪念票按钮鎏金渐变（`:247-250`） |

- 通用卡片 `.card`、按钮 `.btn-primary`、入场动画 `.anim-card`/`@keyframes fadeUp` 均来自全局 `frontend/app.wxss`（`:14`、`:33`、`:300`、`:181`，grep 核实），本页 wxss 只做页面级补充，符合「复用全局样式放 app.wxss」（`frontend/AGENTS.md` §5.2）。

## 4-3. JSON 专章（`node-detail.json`，5 行）

`navigationBarTitleText: "节点详情"`（随后被 `wx.setNavigationBarTitle` 覆盖为节点名，`:86`）、红底 `#C8102E`、白字；无 `usingComponents`。非 tab 页、无页面级特殊配置（不禁滚动、不自定义导航）。

## 5. 输入与输出

- 输入：`options.id`（query，必填；缺失/非数字 → `parseInt` 得 NaN → 后端 422 → catch 分支 toast + 返回，`:89-92`）。
- 输出：无返回值；三个出站跳转 + 一个返回（§4.5）。
- 数据契约：`NodeDetailOut` camelCase（`.qoder/backend/app/api/routes/march.py.md` §5）；`persons` 元素含 `id/name`（WXML `:86-90` 消费口径）。

## 6. 依赖关系

- 上游：`frontend/services/march.js` 的 `getNodeDetail`（`:9`、`:36-37`；`.qoder/frontend/services/march.js.md` §6 列本页为其 6 个消费页之一）→ `request.js` → `GET /api/march/node/{node_id}`（挂 `require_activity_view`；活动窗关闭时 GET 被 `request.js` 防抖 reLaunch 到活动状态页，`.qoder/backend/app/api/routes/march.py.md` §4.1、`.qoder/frontend/services/request.js.md` §4.9）。
- `frontend/data/node-themes.js`（`:11`）：`getNodeTheme(node.id)`（`:44`、`:106`）与 `themeBgStyle(theme)`（`:63`）。**主题映射为纯前端配置，`route_nodes` 表无 theme 列、不对应任何后端字段**（`.qoder/frontend/data/node-themes.js.md` §6，本文档与该结论保持一致）；未知 id 兜底 ruijin 主题（同文 §4.3）。
- `frontend/utils/util.js` 的 `formatNumber`（`:10`、`:58-59`；`.qoder/frontend/utils/util.js.md` §4）。
- `getApp().globalData.loggedIn`（`:8`、`:30`）。无 Storage 读写、无 WS 订阅。
- 被依赖：§4.2 所列 8 个入口页；`frontend/app.json:9` 注册。
- **不依赖** `frontend/utils/routeCanvas.js`（该工具供 march 页星空画布使用，本页粒子画布为自有实现，全文无 require）。

## 7. 业务规则

1. **任意节点可看历史**：未解锁节点不拦截（不变量 8；后端 `march.py:60` docstring 同口径，`.qoder/backend/app/api/routes/march.py.md` §4）。
2. **节点三态文案**：`completed`→「★ 已点亮」、`current`→「◎ 进行中」、`unlocked`→「○ 未解锁」，未知值兜底「未解锁」（`:39-43`、`:57`）。
3. **纪念票入口仅已点亮**（WXML `:113`；需求 §19，`:224` 注释）。
4. **主题为前端映射**：新增节点/调整氛围只改 `node-themes.js`，不得要求后端下发（`.qoder/frontend/data/node-themes.js.md` §8.1）。
5. **粒子预算**：本页上限 24 颗（`:132`），与 march 页星空画布的粒子预算相互独立（`.qoder/frontend/data/node-themes.js.md` §7.2）。
6. 小地图只读：三禁手势（WXML `:104-106`），点位缺失走空态而非报错——`6913b00` 修复「缺点位蓝屏」的既定行为（`.qoder/frontend/services/march.js.md` §8.2）。

## 8. 修改约束

1. `stopAtmosphere` 的 rAF/timeout 双清除（`:200-203`）与降级 `setTimeout(loop, 33)`（`:152`）是低版本基础库兼容路径，不得删除（同 `frontend/AGENTS.md` §6.5「禁止删除 Canvas 离屏降级 try/catch」的兼容精神；本页降级点在 rAF 可用性判断）。
2. `getNodeDetail` 的坐标回退链不得简化为「缺坐标即报错」（`.qoder/frontend/services/march.js.md` §8.2）；本页 `hasMapPoint` 判断（`:47-53`）与 markers 构造依赖回退后的坐标。
3. `themeKey/themeEnv/themeBgStyle` 字段名被自动化测试断言（`frontend/test/automator/p2-theme-ceremony.cjs`，`.qoder/frontend/data/node-themes.js.md` §6、§8.4），改名须同步测试。
4. 不得在入口或本页拦截未解锁节点（不变量 8）；不得把登录守卫改为强制跳组织选择（不变量 5）。
5. WXML 表达式不得引入原生方法调用（如把 `keywords` 拆分移回模板），预处理必须留在 js（`frontend/AGENTS.md` §5.2）。
6. 若接入 AI 讲解面板（§3），对应后端为 `GET /api/ai/route-guide/{node_id}`（不调模型、AI 关闭仍 200、只出已审核内容，`.qoder/backend/app/api/routes/ai.py.md` §4.7、§8.6），且 `ai-chat` 的 `nodeId` 追问通道届时才可打通（`.qoder/backend/app/api/routes/ai.py.md` §9「待开发」第 3 项）。

## 9. 当前实现状态

- **已实现**：史料全卡渲染、区域氛围渐变+四类粒子动画（含清理）、小地图/空态、人物志/纪念票/回首页出口、登录守卫、加载失败回退。
- **存在问题 / 已知事项**：
  1. `onShow` 不重拉数据，与不变量 1「onShow + refresh()」存在偏差（§4.2），点亮状态可能滞后——是否有意**待确认**。
  2. `:91` 的 800ms `setTimeout(navigateBack)` 未跟踪清理（§4.4，低风险）。
  3. `exec` 异步回调与 `onHide` 的理论竞态（§4.4 边界②），未实测，**待确认**。
  4. 后端下发的 `audio` 字段未渲染（§4.3），用途**待确认**。
- **待开发**：AI 讲解面板（§3，多处总览文档已登记为待开发，后端接口已就绪）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/node-detail`，共 **8 个提交**，与 `docs/迭代记录.md` 逐 hash 核对（除 `a94e685` 早于台账口径外均有对应条目）。按时间倒序；未逐 diff 核对的提交以提交信息与关联文档为据。

### 2026-10-15（`6913b00`，13:41）
- 需求：修复节点详情路线位置缺少点位导致地图蓝屏（缺陷）。
- 修改内容（涉本文件）：小地图改为 `hasMapPoint` 有效才渲染、否则「暂无路线点位」空态（`:47-53`、WXML `:97-108`）；服务层同批加坐标回退（`.qoder/frontend/services/march.js.md` §10 同日记录列本页为关联文件）。
- 测试结果：见 `docs/迭代记录.md` 的 `6913b00` 条目（前端服务坐标回退 4/4、页面回归 11/11）。

### 2026-10-11（`01e214a`）
- 需求：V1.0 启动页自动登录并取消强制选组织。
- 修改内容（涉本文件）：登录守卫调整（现行 `:30-33` 仅校验 loggedIn、不再强制组织选择）；具体 diff 未逐行核对，以提交信息与 `frontend/AGENTS.md` §4 不变量 5 的现行口径为据。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目。

### 2026-10-04（`79004f1`，01:13）
- 需求：区域氛围与长征完成仪式（P2-2，需求 §12）。
- 修改内容（涉本文件）：hero 区接入主题渐变（`themeBgStyle` 内联样式）与氛围粒子画布（`startAtmosphere`/`drawAtmosphere`/`stopAtmosphere` 及 onHide/onUnload/onShow 清理链）；同批新建 `frontend/data/node-themes.js`（`.qoder/frontend/data/node-themes.js.md` §10 列本页为关联文件）。
- 测试结果：见 `docs/迭代记录.md` 的 `79004f1` 条目（automator `p2-theme-ceremony.cjs` 断言主题渲染）。

### 2026-10-03（`71d1b9b`，23:39）
- 需求：每日寄语与节点纪念票（P2-1，需求 §19）。
- 修改内容（涉本文件）：新增 `goTicket` 与「🎫 生成纪念票」按钮（仅已点亮节点渲染，`:223-228`、WXML `:112-116`）；以提交信息为据，diff 未逐行核对。
- 测试结果：见 `docs/迭代记录.md` 的 `71d1b9b` 条目。

### 2026-10-03（`2a178b7`，08:40）
- 需求：长征人物志与答题连胜效果（P1-8，需求 §14）。
- 修改内容（涉本文件）：新增「相关人物」chip 与 `goPerson` 跳转（`:207-214`、WXML `:79-92`，注释自引 §14.3）；以提交信息与页内注释为据，diff 未逐行核对。
- 测试结果：见 `docs/迭代记录.md` 的 `2a178b7` 条目。

### 2026-10-02（`7e587c9`，11:13）
- 需求：小程序页面高级化升级（首页重组/档案/行军日历/到达动画/情报化/勋章墙）。
- 修改内容（涉本文件）：页面视觉升级批次的一部分（现行动画卡片/排版基调）；本提交对本页的具体 diff 未核对，仅以提交信息为据。
- 测试结果：见 `docs/迭代记录.md` 的 `7e587c9` 条目。

### 2026-10-01（`6a24562`，17:53）
- 需求：服务层由本地 Mock 切换为后端真实接口。
- 修改内容（涉本文件）：`getNodeDetail` 改走真实 `GET /api/march/node/{id}`，页面改异步加载并补错误提示（`:36-92` 现行结构）；以提交信息为据（`.qoder/frontend/services/march.js.md` §10 同日记录）。
- 测试结果：见 `docs/迭代记录.md` 的 `6a24562` 条目。

### 2026-09-30（`a94e685`，18:05）
- 需求：仓库初始化（`feat: init`）。
- 修改内容（涉本文件）：创建本页四件套；初始形态（Mock 时代）未逐行核对。
- 测试结果：无记录（早于迭代台账建立口径，同 `.qoder/frontend/services/march.js.md` §10 对 init 提交的处理口径）。
