# app.json

## 1. 文件路径

`frontend/app.json`（75 行）

## 2. 文件职责

小程序的**全局配置文件**：注册全部 25 个页面路径、声明 5 个底部 tab、设定全局窗口外观（导航栏长征红 + 米白背景），并把索引规则指向 `sitemap.json`。微信开发者工具以 `project.config.json` 的 `miniprogramRoot: "frontend/"`（`project.config.json:56`）为根，故本文件的实际生效路径是 `<miniprogramRoot>/app.json`。

## 3. 业务需求

- 5 个 tab 的业务定位（首页 / 长征 / AI 问答 / 排行 / 我的）见 `frontend/AGENTS.md` §7「背景知识速查」第 1 条；本文不复述各页职责，页面级说明见 `.qoder/frontend/pages/<页>/<页>.js.md`。
- 导航栏主色 `#C8102E`、背景 `#F7F1E5` 是 `frontend/AGENTS.md` §2 表「视图」行规定的约定色。

## 4. 核心功能

### 4.1 `pages`（`:2-28`，共 25 条）

数组**首项即小程序启动页**：`pages/launch/launch`（`:3`）——冷启动落在启动页做后端登录校验与邀请码准入落地，而非直接进首页。

按声明顺序（`:3-27`）：

| # | 路径 | 行 | 类型 |
|---|---|---|---|
| 1 | `pages/launch/launch` | `:3` | 启动页（非 tab） |
| 2 | `pages/home/home` | `:4` | tab 1 |
| 3 | `pages/march/march` | `:5` | tab 2 |
| 4 | `pages/quiz/quiz` | `:6` | 子页（原 tab 3「情报」，`0052108` 起降级，见 §4.2） |
| 5 | `pages/mine/mine` | `:7` | tab 5 |
| 6 | `pages/login/login` | `:8` | 子页 |
| 7 | `pages/node-detail/node-detail` | `:9` | 子页 |
| 8 | `pages/quiz-answer/quiz-answer` | `:10` | 子页 |
| 9 | `pages/quiz-result/quiz-result` | `:11` | 子页 |
| 10 | `pages/sport-records/sport-records` | `:12` | 子页 |
| 11 | `pages/quiz-records/quiz-records` | `:13` | 子页 |
| 12 | `pages/medals/medals` | `:14` | 子页 |
| 13 | `pages/org-select/org-select` | `:15` | 子页 |
| 14 | `pages/rank/rank` | `:16` | tab 4 |
| 15 | `pages/profile/profile` | `:17` | 子页 |
| 16 | `pages/calendar/calendar` | `:18` | 子页 |
| 17 | `pages/person/person` | `:19` | 子页 |
| 18 | `pages/ticket/ticket` | `:20` | 子页 |
| 19 | `pages/ceremony/ceremony` | `:21` | 子页 |
| 20 | `pages/bind/bind` | `:22` | 子页 |
| 21 | `pages/account/account` | `:23` | 子页 |
| 22 | `pages/onboard/onboard` | `:24` | 子页 |
| 23 | `pages/points/points` | `:25` | 子页 |
| 24 | `pages/activity/activity` | `:26` | 子页 |
| 25 | `pages/ai-chat/ai-chat` | `:27` | tab 3（`0052108` 新增） |

**注册 ↔ 磁盘一致性核对（本次建档实测）**：`ls frontend/pages` 得到 25 个目录（account、activity、ai-chat、bind、calendar、ceremony、home、launch、login、march、medals、mine、node-detail、onboard、org-select、person、points、profile、quiz、quiz-answer、quiz-records、quiz-result、rank、sport-records、ticket），与上表 **1:1 完全对应**：无「目录存在但未注册」的页面，也无「已注册但目录缺失」的路径。与 `frontend/AGENTS.md` §7 的「5 tab + launch + 19 子页 = 25」口径亦一致。

### 4.2 `tabBar`（`:36-73`）

全局项：`color: "#999999"`（未选中文字，`:37`）、`selectedColor: "#C8102E"`（选中文字，长征红，`:38`）、`backgroundColor: "#FFFFFF"`（`:39`）、`borderStyle: "black"`（上边框色，`:40`）。

`list` 5 项（`:41-72`，微信要求 2～5 项，此处取上限）：

| 序 | `pagePath` | `text` | `iconPath` | `selectedIconPath` | 行 |
|---|---|---|---|---|---|
| 1 | `pages/home/home` | 首页 | `images/tabbar/home.png` | `images/tabbar/home-active.png` | `:42-47` |
| 2 | `pages/march/march` | 长征 | `images/tabbar/march.png` | `images/tabbar/march-active.png` | `:48-53` |
| 3 | `pages/ai-chat/ai-chat` | AI 问答 | `images/tabbar/ai.png` | `images/tabbar/ai-active.png` | `:54-59` |
| 4 | `pages/rank/rank` | 排行 | `images/tabbar/rank.png` | `images/tabbar/rank-active.png` | `:60-65` |
| 5 | `pages/mine/mine` | 我的 | `images/tabbar/mine.png` | `images/tabbar/mine-active.png` | `:66-71` |

5 个 `pagePath` 均出现在 `pages` 数组中（tab 页必须已注册，微信硬性要求）——已逐条核对通过。

**图标资源实测**：`frontend/images/tabbar/` 下有 12 个 png（ai/ai-active、home/home-active、march/march-active、mine/mine-active、quiz/quiz-active、rank/rank-active）。其中 `quiz.png` 与 `quiz-active.png` **已无任何引用**：`0052108`（2026-10-17）把第 3 个 tab 从「情报」（`pages/quiz/quiz` + quiz 图标）整项替换为「AI 问答」（`pages/ai-chat/ai-chat` + ai 图标），quiz 页降级为子页但图标未清理。属遗留静态资源（按 `.qoder/README.md` §4「纯静态资源」行不单独建档），可安全删除但需同步确认无别处引用。

### 4.3 `window`（`:29-35`）

| 键 | 值 | 行 | 作用 |
|---|---|---|---|
| `navigationBarBackgroundColor` | `#C8102E` | `:30` | 导航栏背景（长征红） |
| `navigationBarTitleText` | `长征运动` | `:31` | 默认标题；各页可在自己的 `<页>.json` 中用同名键覆盖 |
| `navigationBarTextStyle` | `white` | `:32` | 导航栏文字/状态栏前景色（仅 `white`/`black` 可选） |
| `backgroundColor` | `#F7F1E5` | `:33` | 窗体下拉时露出的背景色（米白） |
| `backgroundTextStyle` | `dark` | `:34` | 下拉 loading 三点样式（`dark`/`light`） |

与 `frontend/app.wxss:6` 的 `page { background: #F7F1E5; }` 同色，保证下拉回弹时不出现色差。

### 4.4 `sitemapLocation`（`:74`）

值为 `"sitemap.json"`，相对 `miniprogramRoot`（即 `frontend/`）解析 → 指向 `frontend/sitemap.json`。详见 `.qoder/frontend/sitemap.json.md`。`project.config.json:34` 的 `checkSiteMap: true` 使开发者工具在编译时校验该文件存在性与格式。

### 4.5 **本文件不存在的配置键**（通读 75 行确认，不得凭空补写）

`subpackages`/`subPackages`、`preloadRule`、`permission`、`requiredPrivateInfos`、`lazyCodeLoading`、`style`/`darkmode`/`themeLocation`、`networkTimeout`、`debug`、`functionalPages`、`usingComponents`（全局自定义组件）、`plugins`、`workers`、`resizable`、`singlePage`、`supportedMaterials`、`tabBar.custom`、`tabBar.position`。

其中两项值得说明：

- **无 `permission` / `requiredPrivateInfos`**：与代码事实一致——`frontend/` 下（排除 `test/`）grep `getLocation`、`chooseLocation`、`getFuzzyLocation`、`onLocationChange` **零命中**，即小程序未调用任何需要位置权限声明的接口。长征地图用的是原生 `<map>` 组件 + 写死的 `NODE_COORDS` 经纬度（`frontend/AGENTS.md` §2 表「地图」行、§4 第 6 条），不读取用户定位。若后续新增定位功能，必须同时补这两个键，否则真机直接失败。
- **无 `subpackages`**：25 个页面全部在主包。主包体积靠 `project.config.json:3-19` 的 `packOptions.ignore` 排除 `test/`、`design.md`、`AGENTS.md` 控制在 2M 内（`docs/迭代记录.md` 的 `2d6345d` 条目）。页面数继续增长时需重新评估分包，见 §9。

## 5. 输入与输出

- 输入：无运行时入参；由微信框架在启动时解析。
- 输出：向框架提供路由表（`pages`）、tab 结构与外观（`tabBar`）、全局窗口默认值（`window`）、索引规则位置（`sitemapLocation`）。
- 错误形态：`pages` 中路径对应的四件套缺失、或 `tabBar.list[].pagePath` 未在 `pages` 注册，均在**编译期**由开发者工具报错（不产生运行时异常）。当前两项校验均通过（§4.1、§4.2）。

## 6. 依赖关系

- **依赖**：`frontend/pages/**` 的 25 套页面四件套（路径必须存在）；`frontend/images/tabbar/*.png` 的 10 个在用图标；`frontend/sitemap.json`。
- **被依赖**：微信框架；`frontend/AGENTS.md` §5.3 规定「新增页面必须同步在 `app.json` 的 `pages` 中注册（tab 页还需 tabBar 配置）」，即所有新增页面的注册落点都是本文件。
- **与 `project.config.json` 的关系**：本文件的路径基准由 `project.config.json:56` 的 `miniprogramRoot` 决定；`packOptions.ignore` 影响本文件所注册页面之外哪些资源进包。
- 不直接依赖后端；页面与后端的契约在各 `services/*.js`（分层见 `frontend/AGENTS.md` §3.1）。

## 7. 业务规则

1. **启动页是 `pages/launch/launch` 而非首页**（`pages` 首项决定，`:3`）。所有登录校验、邀请码准入判定在 launch 完成后才 `wx.switchTab` 进首页或 `wx.reLaunch` 去活动状态页（`frontend/pages/launch/launch.js:116`、`:125`、`:131`）。改动 `pages` 数组**顺序**会改变冷启动落点，属高危操作。
2. **tab 页与子页的跳转 API 不同**：tab 页只能 `wx.switchTab`，子页用 `navigateTo`/`reLaunch`。登录守卫失败统一 `reLaunch('/pages/launch/launch')`（`frontend/AGENTS.md` §4 第 5 条），因为 launch 非 tab 页、`switchTab` 到不了。
3. **`quiz` 不再是 tab**（`0052108` 之后）：`pages/quiz/quiz` 仍是注册页面，入口改为首页情报卡（`frontend/AGENTS.md` §7 第 1 条括注）。任何仍按「情报 tab」假设写的跳转（`switchTab` 到 quiz）都会失败。
4. **tabBar 顺序即用户可见顺序**：home → march → ai-chat → rank → mine，与 `pages` 数组顺序无关（`pages` 里 mine 在第 5、ai-chat 在第 25）。

## 8. 修改约束

1. 新增页面必须四件套齐备且路径与本文件登记一致（`frontend/AGENTS.md` §5.3）；删除页面须同步删注册项，否则编译期报错。
2. 改 `tabBar` 需同步：① 对应页面的 `pagePath` 已在 `pages` 注册；② 两个图标文件真实存在于 `frontend/images/tabbar/`；③ 所有 `wx.switchTab` 调用点的路径。tab 数量上限 5，当前已满，**再加 tab 必须先挤掉一个**。
3. `window.navigationBarBackgroundColor` 的 `#C8102E` 与 `backgroundColor` 的 `#F7F1E5` 是全局约定色（`frontend/AGENTS.md` §2 表「视图」行；§5.2 明确「页面级样式不覆盖 tabBar 与导航栏约定色」），改动会波及 25 个页面的视觉一致性与 `frontend/app.wxss` 的配色假设。
4. **不要在此文件添加 `permission`/`requiredPrivateInfos` 之外的隐私声明来「预防性」占位**——目前无定位类接口（§4.5），空声明会触发微信审核侧的权限质询。
5. `sitemapLocation` 改名需同步重命名 `frontend/sitemap.json`，否则 `checkSiteMap`（`project.config.json:34`）编译报错。

## 9. 当前实现状态

- **已实现**：25 个页面全部注册且与磁盘目录 1:1 对应；5 个 tab 齐备且图标文件均存在；全局窗口配色与 `app.wxss` 一致；`sitemapLocation` 指向存在的文件。
- **存在问题 / 已知事项**：
  1. `frontend/images/tabbar/quiz.png`、`quiz-active.png` 自 `0052108` 起成为无引用遗留资源（§4.2），待清理。
  2. 无分包：25 页 + 全部图片在主包，体积控制目前仅靠 `packOptions.ignore` 排除测试目录与开发文档（`docs/迭代记录.md` 的 `2d6345d` 条目记为「主包体积降至 2M 内」）。**距 2M 上限的当前余量待确认**（本次建档未执行开发者工具「代码依赖分析」，无实测数据）。
  3. `pages` 数组顺序无业务分组（tab 页与子页混排，如 mine 在第 5、points 在第 23），新增页面一律追加到末尾（`ai-chat` 即追加于 `:27`）。是否重排为「tab 页集中」**待确认**——重排本身有风险：首项决定启动页（§7 第 1 条）。
- **待开发**：无（本文件无待实现配置项）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/app.json`，共 **11 个提交**。按时间倒序。以下「修改内容」中，`0052108`、`50aef7d` 两项经 `git show` 逐行核对；其余提交仅据提交信息与关联页面推断涉及本文件的具体键，**推断部分已标注**。

### 2026-10-17（`0052108`，11:06）
- 需求：新增 AI 历史助手聊天页，底部「情报」tab 替换为「AI 问答」（答题降级为首页情报卡入口子页）。
- 修改内容（`git show` 核实）：① `pages` 末尾追加 `pages/ai-chat/ai-chat`（现 `:27`）；② `tabBar.list` 第 3 项由 `pages/quiz/quiz`/「情报」/quiz 图标 整项替换为 `pages/ai-chat/ai-chat`/「AI 问答」/ai 图标（现 `:54-59`）。
- 关联文件：`frontend/pages/ai-chat/*`（新建）、`frontend/app.wxss`（同步改注释）、`frontend/pages/home/*`（情报卡入口）、`frontend/services/`（AI 问答接口）。
- 测试结果：见 `docs/迭代记录.md` 的 `0052108` 条目。

### 2026-10-15（`50aef7d`，10:48）
- 需求：底部 tabBar 增加普通/选中态图标；星空地图改为分层错峰闪烁并加强当前节点柔光。
- 修改内容（`git show` 核实，仅涉 tabBar 部分）：5 个 tab 项各补 `iconPath` 与 `selectedIconPath` 两个键（此前只有 `pagePath` + `text`，即纯文字 tab），新增 `frontend/images/tabbar/` 下 10 个 png 引用。
- 关联文件：`frontend/images/tabbar/*.png`（新增）、`frontend/pages/march/march.wxss`（星空地图动画）。
- 测试结果：见 `docs/迭代记录.md` 的 `50aef7d` 条目。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0 小程序——答题 90 秒逐题限时、积分排行榜（领奖台/荣誉榜/分页）、我的积分卡与积分明细页、我的长征荣誉卡、活动状态页与查看拦截、组织锁定只读；「我的」组织名以后端全称回填；新增 v2 自动化验收（14/14）与报告。
- 修改内容（涉本文件，据提交信息推断）：`pages` 追加 `pages/points/points`、`pages/activity/activity` 等 V2.0 新页面注册项。**具体追加了哪几条未逐行核对，待确认**。
- 关联文件：`frontend/pages/points/*`、`frontend/pages/activity/*`、`frontend/services/activity.js`、后端积分与活动模块。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（提交信息记为 v2 自动化验收 14/14）。

### 2026-10-12（`afbcba9`，14:49）
- 需求：邀请码准入全链路（后端迁移/服务/路由/测试、admin 邀请码管理与账号启停、小程序扫码准入与入驻信息收集）。
- 修改内容（涉本文件，据提交信息推断）：`pages` 追加扫码准入与入驻信息收集相关页面注册项（`pages/onboard/onboard` 等）。**具体条目待确认**。
- 关联文件：`frontend/pages/onboard/*`、`frontend/pages/launch/launch.js`、后端邀请码模块、admin 邀请码管理页。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目。

### 2026-10-11（`01e214a`，01:05）
- 需求：V1.0 启动页自动登录（后端校验 Token/静默 `wx.login`、401 静默重登重试、失败可重试不假登录）并取消强制选组织。
- 修改内容（涉本文件，据提交信息与 `.qoder/frontend/app.js.md` §10 同批记录推断）：`pages` 追加 `pages/launch/launch` 并置于首项（启动页），使冷启动先落后 launch。**该条为本文件的推断结论，未逐行核对 diff，待确认**。
- 关联文件：`frontend/app.js`（删 `onLaunch`）、`frontend/pages/launch/*`（新建）、`frontend/services/auth.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目。

### 2026-10-09（`6ed1999`，12:45）
- 需求：身份关联小程序侧（批次 5）——扫码确认页 bind 与账号绑定页 account、login redirect 支持、mine 入口。
- 修改内容（涉本文件，据提交信息推断）：`pages` 追加 `pages/bind/bind`、`pages/account/account`（现 `:22-23`）。
- 关联文件：`frontend/pages/bind/*`、`frontend/pages/account/*`、`frontend/pages/login/login.js`、`frontend/pages/mine/mine.js`、`frontend/services/identity.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `6ed1999` 条目（提交信息记为 automator 15/15 断言 + 6 截图验收）。

### 2026-10-04（`79004f1`，01:13）
- 需求：区域氛围与长征完成仪式（P2-2）——节点区域主题映射 + 氛围粒子、完成仪式动画页与仅首次触发标记。
- 修改内容（涉本文件，据提交信息推断）：`pages` 追加 `pages/ceremony/ceremony`（现 `:21`）。
- 关联文件：`frontend/pages/ceremony/*`、`frontend/pages/march/*`、后端节点区域主题数据。
- 测试结果：见 `docs/迭代记录.md` 的 `79004f1` 条目。

### 2026-10-03（`71d1b9b`，23:39）
- 需求：每日寄语与节点纪念票（P2-1）——后台维护有出处语录、首页寄语卡、Canvas 节点纪念票。
- 修改内容（涉本文件，据提交信息推断）：`pages` 追加 `pages/ticket/ticket`（现 `:20`）。
- 关联文件：`frontend/pages/ticket/*`、`frontend/pages/home/*`、`frontend/services/quote.js`、后端语录模块、admin 语录维护页。
- 测试结果：见 `docs/迭代记录.md` 的 `71d1b9b` 条目。

### 2026-10-03（`2a178b7`，08:40）
- 需求：长征人物志与答题连胜效果（P1-8）——人物/关联表 + 人物志页 + 即时判题连胜反馈。
- 修改内容（涉本文件，据提交信息推断）：`pages` 追加 `pages/person/person`（现 `:19`）。
- 关联文件：`frontend/pages/person/*`、`frontend/pages/quiz-answer/*`、后端人物表与关联表迁移。
- 测试结果：见 `docs/迭代记录.md` 的 `2a178b7` 条目。

### 2026-10-02（`7e587c9`，11:13）
- 需求：小程序页面高级化升级（首页重组/档案/行军日历/到达动画/情报化/勋章墙）。
- 修改内容（涉本文件，据提交信息推断）：`pages` 追加 `pages/profile/profile`、`pages/calendar/calendar`（现 `:17-18`）等高级化新增页面；可能同期调整 tabBar 文案（「情报」称谓）。**具体条目待确认**。
- 关联文件：`frontend/pages/profile/*`、`frontend/pages/calendar/*`、`frontend/pages/home/*`、`frontend/app.wxss`（全局动画体系）。
- 测试结果：见 `docs/迭代记录.md` 的 `7e587c9` 条目。

### 2026-09-30（`a94e685`，18:05）
- 需求：项目初始化（`feat: init`）。
- 修改内容（涉本文件）：创建本文件，含初始 `pages`、`window`、`tabBar`（纯文字 tab）、`sitemapLocation`。初始页面清单未逐行核对。
- 关联文件：全仓初始骨架。
- 测试结果：初始提交；本文件单独的验证结论**待确认**（见 `docs/迭代记录.md` 的 `a94e685` 条目）。
