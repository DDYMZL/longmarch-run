# org-select.js（组织架构选择 · 页面级合一：org-select.js / org-select.wxml / org-select.wxss / org-select.json）

## 1. 文件路径

- `frontend/pages/org-select/org-select.js`（199 行）
- `frontend/pages/org-select/org-select.wxml`（67 行）
- `frontend/pages/org-select/org-select.wxss`（224 行）
- `frontend/pages/org-select/org-select.json`（5 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

组织树**逐级下钻选择器**：每次只向后端请求一层子组织，用面包屑记录已下钻路径，任意层级都可直接「选定」为该用户的所属组织（`org-select.js:1-12` 头注释，交互约定见 `:4-8`）。同一份页面代码承载**两种模式**：登录后的持久化选组织（写后端 + 回填本地用户缓存），以及入驻场景的 pick 模式（不要求登录、不调后端写入，仅经 `eventChannel` 把选定结果回传入驻页）。组织一经选定即锁定，再次进入只读展示（`:11` 头注释、`:53-62`）。

**入口证据**（grep `pages/org-select/org-select` 全仓，测试目录除外）：

| 入口 | 代码位置 | query |
|---|---|---|
| 首页「未选组织」引导卡 | `frontend/pages/home/home.js:382`（`:380` 注释「选填，选定后返回首页」） | `?from=home` |
| 「我的」页组织架构项 | `frontend/pages/mine/mine.js:105`（`:103` 注释「未选定进入选择；已选定锁定只读」） | `?from=mine` |
| 入驻页选组织 | `frontend/pages/onboard/onboard.js:50-54`，带 `events: { orgPicked(res) }` 回调（`:55-58`） | `?from=onboard[&rootId=&rootName=]` |

页面在 `frontend/app.json:15` 注册，**不在 tabBar**（`app.json:41-72` 五个 tab 为首页/长征/AI 问答/排行/我的）。

## 3. 业务需求

- 组织为**选填**项，不得强制跳转（`frontend/AGENTS.md` §4 不变量 5；`01e214a`「取消强制选组织」）。
- 首次登录采集真实姓名作默认用户名、且不消耗「每人仅一次」改名机会：`41607bb`（2026-10-01）交付（`docs/迭代记录.md` 的 `41607bb` 条目；`frontend/AGENTS.md` §4 不变量 7）。
- 入驻准入链路要求「邀请码带 orgId 的只能在该组织及其下级中选择」：`afbcba9`（2026-10-12）交付 pick 模式与 `rootId` 范围限制（`frontend/pages/onboard/onboard.js:3` 注释、`docs/迭代记录.md` 的 `afbcba9` 条目）。
- 组织选定后锁定只读、调整需联系管理员：V2.0 `44eb77b`（2026-10-13）交付（`docs/迭代记录.md` 的 `44eb77b` 条目；`.qoder/frontend/services/org.js.md` §7 规则 1）。
- 姓名提示语移至输入框旁侧（不占 placeholder）：`2cfa336`（2026-10-02）。

## 4. 核心功能（org-select.js）

### 4.1 `data` 状态字段（`:18-29`，按关注点分组）

| 分组 | 字段 | 说明 |
|---|---|---|
| 下钻路径 | `stack`（`:19`，`[{id,name}]`） | 面包屑数据源；`drillInto` 追加（`:101`）、`onTapCrumb` 截断（`:118-122`） |
| 当前层级 | `list`（`:20`）、`currentId`（`:21`，null=顶级）、`currentFullName`（`:22`） | 全部由 `loadLevel` 写入（`:75-79`、`:83`） |
| 选定回显 | `selectedId`（`:23`） | onLoad 取 `user.orgId`（`:50`）；选定成功后置为本次 orgId（`:169`） |
| pick 模式范围 | `rootId`（`:24`） | 仅 pick 分支写入（`:40`）；供 WXML 面包屑判定栈底（`org-select.wxml:14`、`:16`） |
| 姓名采集 | `showNickInput`（`:25`）、`nickname`（`:26`） | `showNickInput = from==='home' && !user.nicknameChangedAt`（`:51`） |
| 锁定只读 | `locked`（`:27`）、`lockedName`（`:28`） | 由 `org.getMine()` 的 `locked` 决定（`:57-62`） |

页面实例属性（**非 data**）：`pickMode`（`:34`）、`this.rootId`（`:35`，与 `data.rootId` 并存，非 pick 模式下两者均为 null）、`_levelRequestId`（`:69-70`）、`_selecting`（`:141-142`）。

### 4.2 生命周期：只有 `onLoad`（`:31-65`），无 onShow/onHide/onUnload

- **pick 模式分支**（`from === 'onboard'`，`:34`、`:37-43`）：**不读 `app.globalData`、不做登录校验、不采集昵称**（`:38` 注释「入驻场景尚未登录」）；`rootId`/`rootName` 由 query 解析（`:35-36`，`decodeURIComponent`）；`rootId` 有值时把它作为栈底预置进 `stack`（`:39`），随后 `loadLevel(this.rootId || null)`（`:41`）并 return。
- **常规模式分支**（`:44-64`）：① 登录守卫 `!app.globalData.loggedIn` → `wx.reLaunch('/pages/launch/launch')` 并 return（`:44-47`；`frontend/AGENTS.md` §4 不变量 5）；② `selectedId` 回显 + `showNickInput` 判定（`:48-52`）；③ `org.getMine()` 决定形态——`locked` 为假则 `loadLevel(null)` 进入可浏览列表（`:57-60`），为真则 `auth.updateLocalUser({orgId, orgName, orgFullName: mine.fullName})` 回填本地缓存（`:61`）并切只读卡（`:62`，同时强制关掉昵称采集）；④ **`getMine()` 失败降级为可浏览列表**（`:64` `.catch(() => this.loadLevel(null))`），即锁定态用户遇网络错误仍会看到可选列表，二次选定由后端拒绝（`.qoder/frontend/services/org.js.md` §7 规则 1）。
- **无 onShow**：层级切换全部在同一页面实例内用 `setData` 完成，不压页面栈，故没有「回场重拉」场景；`frontend/AGENTS.md` §4 不变量 1 针对数据展示页，本页是否需要 onShow 刷新属产品判断，**待确认**。

### 4.3 `loadLevel(parentId)`（`:67-85`）——按层拉取 + 请求序号守卫

`parentId` 为 `null` 表示顶级（`:67` JSDoc）。自增 `_levelRequestId` 并在 `then/catch` 中比对，**快速连点下钻/回跳时只采纳最后一次请求**（`:69-70`、`:74`、`:82`；`:67` 注释；同批审查成果见 `docs/迭代记录.md` 的 `e70b59f` 条目）。成功时一次 `setData` 写入 `list`（`org.getChildren` 已解包为裸数组，`.qoder/frontend/services/org.js.md` §4 表第 1 行）、`currentId = parentId`、`currentFullName = stack` 各级 name 以 ` / ` 拼接（`:75-79`，读取的是调用方已更新过的 `this.data.stack`）。失败时置 `list: []`、`currentFullName: ''`（`:81-84`），**无错误文案字段、无 toast**。

### 4.4 下钻与回跳

| 方法 | 行号 | 行为 |
|---|---|---|
| `onTapRow(e)` | `:88-97` | 读 `dataset.id/name/has`；`hasChildren` 为真 → `drillInto`，否则（末级）直接 `confirmSelect` |
| `drillInto(id, name)` | `:100-104` | `stack.concat([{id,name}])` → `setData` → `loadLevel(id)` |
| `onTapCrumb(e)` | `:113-125` | 按 `dataset.index` 回跳：`minIndex = pickMode && rootId ? 0 : -1`（`:115`），`safeIndex = Math.max(index, minIndex)`（`:116`）——**pick 模式不允许回到 rootId 之上**；`safeIndex < 0` 清空栈回顶级，否则 `stack.slice(0, safeIndex+1)`；随后按新栈末级 `loadLevel`（`:124`） |
| `onSelectCurrent()` | `:128-132` | 顶部「选择该组织」按钮：`currentId` 存在即选定当前浏览层级（任意层级可选中，`:8` 头注释） |
| `onNickInput(e)` | `:135-137` | 写 `data.nickname` |
| `findNode(orgId)` | `:179-188` | 先在 `list` 线性查找，找不到再取 `stack` 末级比对，仍无返回 `null` |

### 4.5 `confirmSelect(orgId)`（`:140-177`）——选定提交（两条完全不同的出口）

`_selecting` 防重入（`:141-142`）。

1. **pick 模式**（`:143-156`）：拼 `fullName`（`stack` 加上「若选的不是当前层级则补该节点」，`:145-149`）→ `getOpenerEventChannel().emit('orgPicked', {orgId, orgName, orgFullName})`（`:150-153`，`orgName` 取节点名、无节点时退回 fullName）→ `wx.navigateBack()`（`:154`）→ return。**不调任何后端写接口、不写 Storage**。
2. **常规模式**（`:157-176`）：先按需 `auth.setInitialNickname(nick)`，其 `.catch(() => null)` **吞掉改名失败**，不阻塞选组织（`:157-160`）；再 `org.select(orgId)`（`:162`）→ `auth.updateLocalUser({orgId: res.orgId, orgName: res.orgName, orgFullName: res.fullName})`（`:163-168`）→ `setData({selectedId})`（`:169`）→ success toast「已选定组织」（`:170`）→ `setTimeout(..., 600)` 后 `afterSelect()`（`:171`）。失败分支复位 `_selecting` 并 toast `err.message || '选定失败，请重试'`（`:173-176`）。
3. `afterSelect()`（`:191-198`）：`getCurrentPages().length > 1` → `wx.navigateBack()`，否则 `wx.switchTab('/pages/mine/mine')`。

### 4.6 定时器与清理（逐项核实）

全文件仅 1 个定时器：`:171` 的 `setTimeout(() => this.afterSelect(), 600)`。**句柄未保存到实例属性，页面也没有 `onHide`/`onUnload` 钩子，故无从清理**。无 `setInterval`、无 `wx.createAnimation`、无 Canvas、无 WebSocket 订阅、无 `wx.onXxx` 监听。实际影响面：该定时器只在选定成功后创建，600ms 后页面正常已被 `navigateBack` 销毁。

## 4-1. WXML 专章（org-select.wxml，67 行）

顶层二分支：`wx:if="{{locked}}"` 只读卡（`:1-8`）／`wx:else` 选择态（`:10-67`）。

1. **锁定只读卡**（`:2-7`）：🔒 图标 + 「我的所属组织」+ `lockedName` + 「所属组织选定后已锁定，如需调整请联系管理员」。
2. **面包屑**（`:12-22`）：`scroll-view scroll-x`；首项固定 `data-index="-1"`，文案为 `stack.length && stack[0].id === rootId ? stack[0].name : '全部组织'`（`:14`）——**pick 模式栈底显示 root 组织名而非「全部组织」**；随后 `wx:for="{{stack}}" wx:key="id"`（`:15`），内层 `wx:if="{{index > 0 || stack[0].id !== rootId}}"`（`:16`）避免把 root 重复渲染一遍，分隔符 `›` + `data-index="{{index}}"`（`:17-18`），末级加 `crumb-active`。
3. **姓名采集块**（`:25-37`，`wx:if="{{showNickInput}}"`）：标签「姓名」+ `<input type="nickname" value="{{nickname}}" bindinput="onNickInput">`（`:28-33`）+ 旁侧提示「请输入真实姓名」（`:34`）+ 块下说明「未填写将使用默认昵称，选定组织后可在「我的」页修改一次」（`:36`）——**可跳过，无必填校验**。
4. **当前层级条**（`:40-46`，`wx:if="{{currentId}}"`）：「当前层级」+ `currentFullName` + `bindtap="onSelectCurrent"` 的「选择该组织」按钮。
5. **组织列表**（`:49-64`）：`wx:for="{{list}}" wx:key="id"`，已选项加 `org-item-selected`（`:51`）；`org-main` 携 `data-id/data-name/data-has` 绑 `bindtap="onTapRow"`（`:55`），有下级显示「{{item.childCount}} 个下级 ›」（`:57`），末级显示「末级组织」（`:58`）；右侧「选定」按钮用 **`catchtap="onTapSelect"`**（`:60`）阻止冒泡到整行的下钻；空列表显示全局 `.empty-tip`「该组织暂无下级」（`:63`）。
6. **底部说明**（`:66`）：解释点击语义与锁定规则。

约定核对：表达式只有属性访问与三元判断，**无原生方法调用**；列表 `wx:key` 用 `id` 而非 index（`frontend/AGENTS.md` §5.2）；`currentFullName`、`childCount` 等展示值均在 js/后端侧备好。

## 4-2. WXSS 专章（org-select.wxss，224 行）

- **无本地 `@keyframes`、无 `animation` 声明**——本页不参与入场动画体系（对照首页 `anim-card` 用法，`.qoder/frontend/pages/home/home.js.md` §4-2）。
- **依赖全局样式一处**：`.empty-tip`（WXML `:63`）定义于 `frontend/app.wxss:83`，本文件未重复定义。
- **选择器逐一核对无死样式**：本文件 31 个类选择器（`.org-page`/`.nick-*` 7 个/`.crumb*` 5 个/`.current-*` 5 个/`.org-*` 8 个/`.locked-*` 5 个）全部在 `org-select.wxml` 中有对应节点（按类名逐个比对 WXML 全文核实）。
- **布局要点**：面包屑用 `white-space: nowrap` + `.crumb-inner` 的 `inline-flex` 实现横向滚动（`:55`、`:61-63`）；`.org-item` 左内边距 28rpx、右仅 8rpx 以容纳「选定」胶囊按钮（`:136`），`.org-main` `overflow: hidden`（`:152`）、`.current-name` 单行省略号（`:111-113`）；`.org-select-btn` 白底红边胶囊（`:171-181`）。
- **配色**：单位全 rpx；导航主色 `#C8102E` 用于姓名提示、面包屑选中、当前层级按钮、已选边框与「选定」按钮（`:41`、`:72`、`:119`、`:143`、`:163`、`:175-176`）；鎏金系 `#B8860B`/`#E8C76A` 用于提示与锁定卡标签（`:48`、`:103`、`:210`）；锁定卡为深红渐变 + 半透明金边（`:197-198`）。

## 4-3. JSON 专章（org-select.json，5 行）

仅 3 个键：`navigationBarTitleText: "选择组织架构"`、`navigationBarBackgroundColor: "#C8102E"`、`navigationBarTextStyle: "white"`。后两键与 `frontend/app.json:30-32` 的全局 `window` 默认值完全一致（属冗余声明，改动无行为差异），仅标题为页面特有。无 `usingComponents`、无下拉刷新配置。

## 5. 输入与输出

- **入参（query）**：`from`（`home`/`mine`/`onboard`，决定 pick 模式与是否采集姓名，`:33-34`、`:51`）、`rootId`（数字，pick 模式可选范围根，`:35`）、`rootName`（URL 编码，栈底显示名，`:36`）。
- **出参（service 调用与后端路径）**：

| service 调用 | org-select.js 行号 | 后端路径 |
|---|---|---|
| `org.getMine()` | `:55` | `GET /api/org/mine`（`.qoder/frontend/services/org.js.md` §4 表第 2 行） |
| `org.getChildren(parentId)` | `:72` | `GET /api/org/children[?parentId=]`，返回 `nodes[]`（id/name/parentId/level/hasChildren/childCount），service 层解包为裸数组（`.qoder/backend/app/api/routes/org.py.md` §4.3 与输入输出表） |
| `org.select(orgId)` | `:162` | `POST /api/org/select`，body `{orgId}` |
| `auth.setInitialNickname(nick)` | `:159` | `PUT /api/auth/nickname/initial`（`.qoder/frontend/services/auth.js.md` §4.9） |
| `auth.updateLocalUser(patch)` | `:61`、`:164` | 无请求；写 `lm_login_user` 并同步 `app.globalData.user`（auth.js.md §4.9） |
| `getOpenerEventChannel().emit('orgPicked', …)` | `:150-152` | 无请求；跨页事件回传，消费方 `frontend/pages/onboard/onboard.js:55-58` |

- **错误出口**：`getMine` 失败 → 静默降级为可浏览列表（`:64`）；`getChildren` 失败 → 空列表（`:83`）；`select` 失败 → toast（`:175`）；`setInitialNickname` 失败 → 被 `.catch(() => null)` 吞掉（`:159`）。401 由 `request.js` 链统一静默重登并重试一次（`.qoder/frontend/services/request.js.md`、`.qoder/frontend/services/auth.js.md` §4.5），页面不感知。

## 6. 依赖关系

- **require（`:13-15`，3 项全部有使用）**：`app = getApp()`；`services/org`（`getMine`/`getChildren`/`select`）；`services/auth`（`setInitialNickname`/`updateLocalUser`）。**页面零直接 `wx.request`、零 Storage 读写**（登录态与组织名回填全部经 `auth.updateLocalUser`，符合 `frontend/AGENTS.md` §3.1 与 §6.5）。
- **被依赖**：`frontend/app.json:15` 注册；三个入口页（§2 表）；automator 脚本以本页作为登录后的落地判定（如 `frontend/test/automator/p0-opening.cjs:112`、`nickname-test.cjs:17`）。
- **数据库表**：前端不触库；组织树与用户组织字段见 `.qoder/backend/app/api/routes/org.py.md`。

## 7. 业务规则

1. **`GET /api/org/children` 无需鉴权即可浏览整棵组织树**——这是**有意设计**（入驻前需先选组织），代价是**组织架构与每一级名称对未登录调用方完全可见**。已作为架构级限制登记于 `.qoder/PROJECT.md` §8「架构级限制」第 33 项，代码证据与讨论见 `.qoder/backend/app/api/routes/org.py.md`；服务层视角同述于 `.qoder/frontend/services/org.js.md` §7 规则 2。本页因此能在 pick 模式（未登录）下正常下钻（`:37-43`）。其余三个端点均需 JWT。
2. **组织选定一次性、锁定后只读**：前端不做锁定判定，只透传后端 `locked` 渲染只读卡（`:57-62`；`.qoder/frontend/services/org.js.md` §8 第 3 条）；二次修改由后端拒绝。
3. **pick 模式越界防护**：`rootId` 既是面包屑栈底显示的依据（WXML `:14`、`:16`），也是 `onTapCrumb` 的 `minIndex` 下限（`:115-116`）——两处构成同一套「不得越出邀请码授权范围」的约束，改一处必须同步另一处。
4. **姓名采集只在 `from=home` 且 `nicknameChangedAt` 为空时出现**（`:51`），可跳过；走 `PUT /auth/nickname/initial`，**不消耗「每人仅一次」的改名机会**（`frontend/AGENTS.md` §4 不变量 7；`.qoder/frontend/services/auth.js.md` §7 规则 5）。
5. **组织名回填是硬要求**：后端 `user` 不含 `orgName/orgFullName`，选定成功后必须由本页 `auth.updateLocalUser` 写回，否则「我的」页不回显组织（`:61`、`:163-168`；`43898a2` 缺陷修复成果，`.qoder/frontend/services/auth.js.md` §7 规则 6）。
6. **并发只采纳最后一次层级请求**（`:69-70`、`:74`、`:82`），避免快速连点下钻时旧响应覆盖新响应。

## 8. 修改约束

1. `orgPicked` 事件名与 `{orgId, orgName, orgFullName}` 三字段载荷是与入驻页的硬契约（`:152` ↔ `frontend/pages/onboard/onboard.js:55-58`），改字段须双页同步。
2. `org.getChildren` 的**解包行为**（页面拿到裸数组而非 `{nodes}`）与 org 服务其余函数的原样透传口径不同（`.qoder/frontend/services/org.js.md` §8 第 1 条），页面 `setData({list})` 直接依赖该形态。
3. 列表项字段 `hasChildren`/`childCount`/`name`/`id` 来自后端 `OrgChildrenOut`（`.qoder/backend/app/api/routes/org.py.md` 输入输出表），WXML `:55-58` 与之逐字段绑定。
4. `catchtap`（WXML `:60`）不得改成 `bindtap`，否则「选定」会同时触发整行下钻。
5. 展示字段必须在 js 侧预处理（`currentFullName`/`fullName` 均在 js 拼接，`:78`、`:145-149`），WXML 不得引入原生方法调用；`wx:key` 不得改用 index（`frontend/AGENTS.md` §5.2）。
6. 新增任何定时器/监听必须同时补 `onHide`/`onUnload` 钩子——本页当前**没有**这两个钩子（§4.6）。
7. 导航栏主色 `#C8102E` 与 json 三键受全局约定约束（`frontend/AGENTS.md` §2、§5.3）。

## 9. 当前实现状态

- **已实现**：逐级下钻与面包屑回跳、任意层级选定、末级整行即选、姓名采集（可跳过、失败不阻塞）、锁定只读态、pick 模式范围限制与 `eventChannel` 回传、层级请求并发守卫、选定后本地组织名回填。
- **存在问题 / 已知事项（事实陈述）**：
  1. **`loadLevel` 失败静默**：catch 只置空列表与空路径名（`:81-84`），`data` 中没有错误文案字段，WXML `:63` 统一显示「该组织暂无下级」——用户无法区分「加载失败」与「真的没有下级」，也没有重试入口（对比 quiz 页的 `errorMsg` + 点击重试形态）。
  2. **`getMine()` 失败降级会绕过锁定只读态**：已锁定用户在网络异常时看到可浏览的可选列表（`:64`），点选定后由后端拒绝并 toast（`:173-176`）；前端不做二次拦截，属既有取舍。
  3. **`:171` 的 600ms `setTimeout` 句柄未保存且无 `onHide`/`onUnload` 可清理**（§4.6）；仅在选定成功后触发，页面随即销毁，非无界泄漏。
  4. **pick 模式下 `_selecting` 置 true 后不复位**（`:141-142`、`:154`）：依赖 `navigateBack` 销毁页面；入驻页以 `navigateTo` 进入本页（`onboard.js:53`），页面栈必 > 1，正常路径不会卡死，但无失败兜底——是否需要补 `wx.navigateBack({ fail })` 回退**待确认**。
  5. **匿名可浏览整棵组织树**是已登记的架构级限制（`.qoder/PROJECT.md` §8「架构级限制」第 33 项），非本页缺陷。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/org-select`（目录级，**10 个提交**），全部在 `docs/迭代记录.md` 有对应条目（按提交号逐一核对存在）。按时间倒序、按主题分组；除注明外，各提交对本目录的具体 diff 未逐一核对，以提交信息与该条目为据。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0 小程序批次——组织锁定只读、「我的」组织名以后端全称回填。
- 修改内容（涉本目录）：`locked`/`lockedName` 只读卡形态（`:27-28`、`:57-62`；WXML `:1-8`；WXSS `.locked-*` `:191-224`）；`updateLocalUser` 回填 `fullName`（`:61`、`:167`）。
- 关联文件：`frontend/services/org.js`、`frontend/pages/mine/*`。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（v2 自动化验收 14/14）。

### 2026-10-12（`43898a2`、`afbcba9`）
- 需求：`43898a2` 修复首次入驻后「我的」页不回显组织；`afbcba9` 邀请码准入全链路（小程序扫码准入与入驻信息收集）。
- 修改内容（涉本目录）：`43898a2`——`auth.updateLocalUser` 同步 `app.globalData.user` 后本页回填组织名的现行写法（`:61`、`:163-168`；`.qoder/frontend/services/auth.js.md` §10 同日条目明载关联本文件）；`afbcba9`——pick 模式与 `rootId`/`rootName` 范围限制、`orgPicked` 回传（`:34-43`、`:115-116`、`:143-156`）。
- 测试结果：`43898a2` 条目记 `node --check`、Node 假宿主调用链与 automator `onboard-org-echo.cjs` 回显正确；`afbcba9` 见其条目（后端 s19 25/25 等）。

### 2026-10-11（`e70b59f`、`01e214a`）
- 需求：`e70b59f` 小程序代码审查修复批次（并发请求守卫、登录守卫与计时器清理、精简 setData 与列表 key）；`01e214a` V1.0 启动页自动登录并**取消强制选组织**。
- 修改内容（涉本目录）：`_levelRequestId` 请求序号守卫（`:69-70`、`:74`、`:82`）与单次合并 `setData`（`:75-79`）；登录守卫改为 `reLaunch('/pages/launch/launch')`（`:44-47`），组织由强制改为选填（现行 `from=home` 引导入口即此调整结果，`frontend/pages/home/home.js:380-383`）。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f`、`01e214a` 条目。

### 2026-10-02（`2cfa336`，13:15）
- 需求：真实姓名采集提示语移至输入框旁侧。
- 修改内容（涉本目录）：WXML 采集块去掉 `placeholder`、旁侧新增 `nick-hint`「请输入真实姓名」、标签由「昵称」改「姓名」（WXML `:24-37`）；WXSS 新增 `.nick-hint`（`:36-42`）——与 `frontend/test/docs/realname-hint-test-report.md` 记载的改动面一致。
- 测试结果：见 `docs/迭代记录.md` 的 `2cfa336` 条目。

### 2026-10-01（`41607bb`、`a417136`）
- 需求：`41607bb` 组织选择页采集微信名作为新用户默认用户名（不消耗改名机会）；`a417136` 组织选择页切换真实后端接口（补小程序 Mock 迁移）。
- 修改内容（涉本目录）：`41607bb`——`showNickInput`/`nickname` 字段、采集块与 `auth.setInitialNickname` 调用（`:25-26`、`:51`、`:157-160`；WXML `:25-37`）；`a417136`——改走 `services/org` 真实接口（`:55`、`:72`、`:162`）。
- 测试结果：`docs/迭代记录.md` 的 `41607bb` 条目未记录验证字段，**待确认**；`a417136` 见其条目。

### 2026-09-30（`b0ba252`、`a94e685`）
- 需求：`a94e685` 仓库初始化创建本页（Mock 版）；`b0ba252` 强制已登录用户完成组织选择流程（该强制流程后被 `01e214a`「取消强制选组织」回退，两条提交信息为据；现行入口为选填引导，`:51`、§2 表）。
- 测试结果：见 `docs/迭代记录.md` 对应条目（`a94e685` 条目仅「仓库初始代码」）。
