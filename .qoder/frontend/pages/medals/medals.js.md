# medals.js（勋章墙 · 页面级合一：medals.js / medals.wxml / medals.wxss / medals.json）

## 1. 文件路径

- `frontend/pages/medals/medals.js`（97 行）
- `frontend/pages/medals/medals.wxml`（45 行）
- `frontend/pages/medals/medals.wxss`（187 行）
- `frontend/pages/medals/medals.json`（5 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

勋章墙子页（`medals.js:1-4` 头注释）：按「入门/路线/挑战/完成」四类分组展示全部勋章，隐藏且未获得的勋章显示 🔒「神秘勋章」态，点击弹出详情（名称/获得时间/获得条件）。数据仅来自 `GET /api/medal/list` 一个接口，页面自身无判定逻辑（勋章评估发放在后端，§7 规则 1）。

**入口证据**（grep `pages/medals/` 全仓核实，页面注册于 `frontend/app.json:14`）：三处业务入口均 `wx.navigateTo`——首页勋章行 `frontend/pages/home/home.js:377`（`.qoder/frontend/pages/home/home.js.md` §4.8 `goMedals`）、「我的」页菜单 `frontend/pages/mine/mine.js:100`、档案页荣誉卡 `frontend/pages/profile/profile.js:119`。automator 测试经 mine 页菜单进入（`frontend/test/automator/ui-test.cjs:723-725` 等）。

## 3. 业务需求

- `a94e685`（2026-09-30）仓库初始化创建（Mock 版）；`6a24562`（2026-10-01）随服务层切真实接口改为异步加载；`7e587c9`（2026-10-02）「小程序页面高级化升级（勋章墙）」形成现行分组+神秘态+详情弹层形态（`frontend/services/medal.js` 同批创建，`.qoder/frontend/services/medal.js.md` §3）；`01e214a`（2026-10-11）启动页自动登录批次触及本页（onShow 守卫现行形态 `:25-32`，具体 diff 未核对，以提交信息为据）。各条见 `docs/迭代记录.md` 对应提交条目。
- 分类/隐藏/获得条件等扩展字段的后端需求出处（功能 9）见 `.qoder/backend/app/api/routes/medal.py.md` §3。

## 4. 核心功能（medals.js）

### 4.1 模块常量与 `data` 字段

- `CATEGORY_ORDER`（`:9-15`）：四分类的展示顺序与中文名——`starter` 入门勋章 / `route` 路线勋章 / `challenge` 挑战勋章 / `complete` 完成勋章。key 与后端 `medal_defs.category` 值对应（种子定义见 `.qoder/backend/app/api/routes/medal.py.md` §4.5/§7 规则 1）。
- `data`（`:18-23`）4 字段：`groups`（分组视图模型）、`ownedCount`/`totalCount`（头部计数）、`selected`（详情弹层当前项，null 隐藏）。无实例属性、无定时器、无 Canvas。

### 4.2 生命周期与刷新

- **`onShow`（`:25-32`）**：登录守卫——`app.globalData.loggedIn` 为假即 `wx.reLaunch('/pages/launch/launch')` 并 return（`:27-30`，`frontend/AGENTS.md` §4 不变量 5）；随后 `refresh()`。无 onLoad；每次回场重拉，符合不变量 1「数据展示页必须 onShow + refresh」。无 onHide/onUnload（无资源需清理）。
- **`refresh()`（`:34-64`）**：`medal.getMedalList()`（`:36-37`，`:35` 注释「后端勋章列表接口会自动评估发放，直接读取」）→ 成功后：① 按 `sortOrder` 升序排序（`:39`）；② 按 `CATEGORY_ORDER` 分组、逐枚经 `toDisplay` 转展示态、过滤空组（`:40-46`）；③ 未知分类兜底——不属于四个已知 key 的勋章归入「其他勋章」组（`:48-53`，`:48` 注释「未来新增分类时仍能展示」）；④ 单次 `setData` 写入 groups 与 `ownedCount`（`owned` 计数）/`totalCount`（`:55-59`）。**失败分支**：`catch` 把 groups 清空、计数归 0（`:61-63`）——页面无错误文案 UI，失败表现为「0 / 0 + 空列表」（§9 问题 2）。

### 4.3 `toDisplay(m)`（`:66-81`）——展示态转换

`locked = m.hidden && !m.owned`（`:70`）；locked 时 icon 固定 `🔒`、name 固定「神秘勋章」（条件不公开，`:67` 注释与 `.qoder/frontend/services/medal.js.md` §7 规则 2 一致）；`desc` 优先取后端 `conditionDesc`、缺失回退 `desc`（`:78`）；`grantedText` 仅在已获得且有 `grantedAt` 时经 `util.formatTime` 格式化（`:79`；`frontend/utils/util.js:37`），否则空串（WXML 据此隐藏「获得时间」行）。所有展示字段 js 侧预计算，WXML 零原生方法调用（`frontend/AGENTS.md` §5.2）。

### 4.4 事件处理（全部）

| 方法 | 行号 | 行为 |
|---|---|---|
| `handleMedalTap(e)` | `:86-90` | 取 `e.currentTarget.dataset.item` 置 `selected`，打开详情弹层；无 item 直接 return |
| `closeDetail()` | `:92-94` | `selected` 置 null 关闭弹层 |
| `noop()` | `:96` | 空函数，供弹层内容区 `catchtap` 阻止冒泡（防点内容误关，WXML `:27`） |

**页面无任何导航出口**（全文件无 navigateTo/switchTab/navigateBack），纯展示页，返回靠系统导航栏。

## 4-1. WXML 专章（medals.wxml，45 行）

四块：① 头部计数条——`{{ownedCount}} / {{totalCount}}` + 「已获得勋章」（`:2-5`）；② 分组循环——`wx:for="{{groups}}" wx:key="key"`，组标题 + 勋章网格（`:8-23`）；勋章卡 `wx:for="{{group.medals}}" wx:key="id"`，class 按状态叠加 `owned anim-glow`（已获得，全局发光动画）与 `locked`（`:12`），`data-item="{{item}}"` 传整枚数据（`:15`），卡内 icon/名称/状态三态文案「已获得 / 未解锁 / 未获得」（`:18-20`）；③ 详情弹层——`wx:if="{{selected}}"` 全屏遮罩 `bindtap="closeDetail"`（`:26`），内容卡 `anim-pop` + `catchtap="noop"`（`:27`），展示 icon/名称/状态（owned 高亮，`:30-32`）、分隔线、「获得条件」行（`:34-37`）、「获得时间」行仅 `grantedText` 非空时渲染（`:38-41`）、`btn-ghost` 关闭按钮（`:42`）；④ 无空态提示区块——groups 为空时页面只剩头部「0 / 0」（现状事实）。列表 `wx:key` 均用数据唯一字段（key/id）而非 index（`frontend/AGENTS.md` §5.2）。

## 4-2. WXSS 专章（medals.wxss，187 行）

- 头部品牌红渐变（`#A00D26→#C8102E`，`:5-10`），金色副文案（`:17-21`）；勋章卡两列网格（`width: calc(50% - 40rpx)`，`:23-31`）。
- 三态视觉：未获得卡整体 `opacity:0.55 + grayscale(0.8)`（`:38-39`）；已获得去灰 + 鎏金描边 `#E8C76A`（`:42-46`）+ 状态徽章金底（`:77-81`）；locked 卡米灰底、名称置灰（`:106-113`）。
- 分组标题带金色竖条装饰（`::before`，`:95-104`）；详情弹层 `z-index:100` 黑色半透遮罩 + 居中白卡（`:115-135`），条件/时间行左右分栏（`:165-183`）。
- 全局依赖：`.anim-glow`（`frontend/app.wxss:313`）、`.anim-pop`（`app.wxss:305`）、`.btn-ghost`（`app.wxss:55`）。
- **死选择器**：`.medal-desc`（`:60-65`）——WXML 全文无 `medal-desc` 类名（勋章卡只有 icon/name/state 三行，描述仅出现在详情弹层的 `detail-value`），确认为遗留死样式。

## 4-3. JSON 专章（medals.json，5 行）

仅 3 个键：`navigationBarTitleText: "我的勋章"`、`navigationBarBackgroundColor: "#C8102E"`、`navigationBarTextStyle: "white"`——与 `app.json` window 全局默认一致（同 home.json 的冗余声明情形，`.qoder/frontend/pages/home/home.js.md` §4-3）。无 `usingComponents`、无下拉刷新。

## 5. 输入与输出

- **入参**：无（三个入口均不带 query，无 `onLoad(options)`）。
- **出参（页面调用的 service 与后端路径）**：仅一个——`medal.getMedalList()`（`:37`）→ `GET /api/medal/list`（`.qoder/frontend/services/medal.js.md` §4，解包 `result.medals || []`）。**本页不调用 `POST /api/medal/check`**——该端点在小程序侧无任何调用方（`.qoder/backend/app/api/routes/medal.py.md` §6/§9 问题 4）。
- **错误出口**：请求失败 → 静默清空（`:61-63`）；401 静默重登、活动拦截（`/medal/list` 挂 `require_activity_view`，medal.py.md §4.1）自动跳活动状态页，均由 request.js 链处理（`.qoder/frontend/services/request.js.md` §4.9），页面不感知。

## 6. 依赖关系

- **require（`:5-7`，3 项全部有使用）**：`app = getApp()`（仅读 loggedIn）、`services/medal`（getMedalList）、`utils/util`（formatTime）。零直接 `wx.request`、零 Storage 读写（`frontend/AGENTS.md` §3.1/§6.5）。
- **被依赖**：`app.json:14` 注册；home/mine/profile 三页入口（§2）；automator 测试（`ui-test.cjs:723`、`s5-pages.cjs:244`、`e2e-manual-t11t13.cjs:124` 等）。
- **数据库表**：前端不触库；后端读写 `medal_defs`/`user_medals`/`user_event` 等（`.qoder/backend/app/api/routes/medal.py.md` §6）。

## 7. 业务规则

1. **勋章评估发放由「查看」隐式触发**：`GET /api/medal/list` 在活动开放时先执行 `check_and_grant` 再返回列表（`.qoder/backend/app/api/routes/medal.py.md` §4.3「GET 带写副作用」），故 `:35` 注释「直接读取」即完成补发，前端无需也不得本地判定（`frontend/AGENTS.md` §4 不变量 2）；活动不可参与时该接口只读不发放（medal.py.md §4.3）。
2. **广播不对称对本页的实时性后果**：`/medal/list` 发放新勋章时**不做 WebSocket 广播**，只有 `POST /api/medal/check` 发放后才广播 `medal.check`——登记于 `.qoder/PROJECT.md` §8「代码级技术债」第 32 项。后果：用户浏览勋章墙（或首页/我的页拉勋章列表）触发补发时，管理端人员档案不会实时刷新，要等下一次 `/check` 或手动刷新才可见（medal.py.md §9 问题 1 同述）。本页自身也**未订阅 WS**，页内实时性完全依赖 onShow 重拉；小程序侧无感知差异（列表响应已含新发放结果），受影响方是管理端。
3. **神秘态悬念规则**：`hidden && !owned` 不公开名称与条件（`:70`、`:76-78`），条件文案由后端 `conditionDesc` 控制（当前隐藏勋章仅 fearless，medal.py.md §7 规则 5）。
4. **分组健壮性**：排序键 `sortOrder`、分组键 `category` 均为后端下发；未知分类进「其他勋章」兜底组（`:48-53`），后端加新分类前端不丢数据。

## 8. 修改约束

1. `CATEGORY_ORDER` 的 key 与后端种子 `MEDALS[].category` 值是硬契约（`backend/app/data/seed.py`，经 medal.py.md §4.5），改 key 需双端同步；新增分类前端可零改动（兜底组），但要进主分组需在此数组登记。
2. 后端 `{medals:[...]}` → 前端数组的解包约定（`.qoder/frontend/services/medal.js.md` §8.1）与列表元素字段（id/name/icon/desc/owned/category/hidden/sortOrder/grantedAt/conditionDesc，同文 §5）是 `toDisplay` 的输入契约，删字段会破坏神秘态或时间行。
3. `data-item` 传整枚展示对象（WXML `:15`）→ `handleMedalTap` 直读 dataset（`:87`）：dataset 传对象经 WXML 序列化，字段名改动需 js/wxml 同步。
4. `wx:key` 不得改用 index；展示字段必须留在 js 侧预处理（`frontend/AGENTS.md` §5.2）。
5. 不得为「实时看到新勋章」在本页加本地判定或调用 `/medal/check` 轮询——补发职责在 `/list` 副作用链（§7 规则 1），广播补齐属后端第 32 项技术债的整改范畴。

## 9. 当前实现状态

- **已实现**：分组勋章墙、神秘态、详情弹层、onShow 守卫+重拉、未知分类兜底。`git log --follow` 共 4 个提交（§10）。
- **存在问题 / 已知事项（事实陈述）**：
  1. 死选择器 `.medal-desc`（`medals.wxss:60-65`，§4-2 确认）。
  2. 请求失败静默清空、无错误提示与重试入口（`:61-63`），用户只见「0 / 0」空页——与首页「数据加载失败」显式文案（home.js.md §4.4）口径不一致，是否补错误态**待确认**。
  3. 无空态引导文案（groups 为空且请求成功时同样只剩头部计数）——首次使用、零勋章用户的观感问题，现状事实。
  4. 管理端实时性受 `/list` 不广播影响（§7 规则 2，`.qoder/PROJECT.md` §8「代码级技术债」第 32 项），本页无需改动。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/medals/`（**4 个提交**），提交号均已在 `docs/迭代记录.md` 按 hash 核对存在。按时间倒序。各提交对本页的具体 diff 未逐一核对，以提交信息与对应条目为据。

### 2026-10-11（`01e214a`）
- 需求：V1.0 启动页自动登录并取消强制选组织。
- 修改内容（涉本文件）：onShow 登录守卫改 reLaunch 启动页的批次性调整（`:25-32` 现行形态；具体 diff 未核对，以提交信息为据）。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目。

### 2026-10-02（`7e587c9`，11:13）
- 需求：小程序页面高级化升级（勋章墙）。
- 修改内容（涉本文件）：形成现行分类分组 + 🔒 神秘态 + 详情弹层形态（提交信息「勋章墙」；同批创建 `frontend/services/profile.js` 等，`.qoder/frontend/services/profile.js.md` §10）。
- 测试结果：见 `docs/迭代记录.md` 的 `7e587c9` 条目。

### 2026-10-01（`6a24562`，17:53）
- 需求：服务层由本地 Mock 切换为后端真实接口，页面改异步加载。
- 修改内容（涉本文件）：`refresh` 改 Promise 异步并加 catch 兜底（提交信息为据）。
- 测试结果：见 `docs/迭代记录.md` 的 `6a24562` 条目。

### 2026-09-30（`a94e685`，18:05）
- 需求：仓库初始化（`feat: init`）。
- 修改内容（涉本文件）：创建本页四件套（初版为 Mock 数据形态，由后续切换提交推知）。
- 测试结果：无记录（初始化提交）。
