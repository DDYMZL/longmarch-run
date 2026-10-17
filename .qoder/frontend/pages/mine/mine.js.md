# mine.js（我的 · 页面级合一：mine.js / mine.wxml / mine.wxss / mine.json）

## 1. 文件路径

- `frontend/pages/mine/mine.js`（164 行）
- `frontend/pages/mine/mine.wxml`（106 行）
- `frontend/pages/mine/mine.wxss`（258 行）
- `frontend/pages/mine/mine.json`（5 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

小程序**「我的」tabBar 页**（第 5 个 tab）与个人中心枢纽：头部展示头像/昵称（含一次性改名入口）/组织全称/勋章图标条，正文为积分卡、数据统计卡与 7 项功能菜单，底部退出登录（`mine.js:1-5` 头注释、`frontend/app.json:66-71` tabBar 第 5 项 `pages/mine/mine`，`app.json:7` pages 注册）。本页是**多数二级页的产品代码唯一入口**：profile / points / calendar / sport-records / quiz-records / medals / org-select 均从本页菜单进入（§4.6）。

## 3. 业务需求

页面为逐批次叠加（提交号均见于 `docs/迭代记录.md` 对应条目）：

| 区块/能力 | 需求 | 交付提交 |
|---|---|---|
| 页面初版（Mock 期） | 项目初始化 | `a94e685`（2026-09-30） |
| 修改昵称（仅一次）+ 已改名隐藏入口 | 微信名称直登与昵称仅可修改一次 | `f820e0e`、`aebbd79`（2026-10-01） |
| 弹窗提示语位置两次调整 | 真实姓名采集体验 | `2cfa336`、`a6f174a`（2026-10-02，现行形态 `mine.js:119` 注释） |
| 页面高级化（积分/统计/菜单卡结构） | 首页重组/档案/行军日历批次 | `7e587c9`（2026-10-02） |
| 「账号与绑定」入口（bind/account） | 身份关联批次 5 | `6ed1999`（2026-10-09），**后由 `2d20dc9` 隐藏**（2026-10-12，account 页与后端绑定接口保留，提交信息为据） |
| 登录守卫改 reLaunch launch | V1.0 启动页自动登录 | `01e214a`（2026-10-11） |
| 代码审查修复批次（精简 setData 等） | 小程序代码审查 | `e70b59f`（2026-10-11） |
| 积分卡/组织锁定只读/组织全称回填 | V2.0 小程序批次 | `44eb77b`（2026-10-13） |
| 累计运动(步)改计分口径展示 | 与步行积分同口径 | `85c5a55`（2026-10-15） |
| 积分口径「每满 1000 步 1 分、无单日封顶」 | 全端口径调整 | `9cb65b8`（2026-10-15；口径权威见 `.qoder/frontend/services/points.js.md` §7） |

## 4. 核心功能（mine.js）

### 4.1 `data` 状态字段（`:13-23`，按关注点分组）

| 分组 | 字段 | 来源 |
|---|---|---|
| 用户 | `user`（`:14`，初值 null） | `app.globalData.user` / `auth.updateLocalUser` 回填（`:43-46`） |
| 档案统计 | `totalSteps/litCount/totalCount(初值10)/quizCount`（`:15-18`） | `profile.getSummary`（`:50-53`） |
| 积分卡 | `points`（`:19`，初值 null，WXML 空值显示 `--`） | `points.getSummary` 重组（`:54-62`） |
| 勋章条 | `medalIcons/medalCount/medalTotal`（`:20-22`） | `medal.getMedalList`（`:63-65`，icons 取已拥有前 6 枚的 `{id, icon}`） |

页面**无实例属性、无定时器、无动画句柄、无事件监听**（全文件无 setInterval/setTimeout/ws/canvas）。

### 4.2 生命周期

- **`onShow`（`:25-31`）——唯一生命周期钩子**：① 登录守卫：`app.globalData.loggedIn` 为假即 `wx.reLaunch('/pages/launch/launch')` 并 return（`:26-28`；tab 页同样自守卫，`frontend/AGENTS.md` §4 不变量 5）；② `refresh()`（`:30`）。**刷新策略 = 每次 onShow 全量重拉 3 路接口**，无缓存、无节流（不变量 1「数据展示页必须 onShow + refresh」的落点）。无 `onLoad`（首帧渲染 data 初值，积分显示 `--`）。
- **无 `onHide`/`onUnload`**：页面无任何 JS 定时器/订阅/监听（§4.1），无需清理；入场动画为纯 CSS（`anim-float`/`anim-card`，见 §4-2），无 JS 句柄可泄漏——现状事实，非遗漏。

### 4.3 `refresh()`（`:33-71`）——三路并发聚合

- `Promise.all([profile.getSummary(), medal.getMedalList(), points.getSummary()])`（`:35`；勋章列表接口带「自动评估发放」副作用，`:34` 注释与 `.qoder/frontend/services/medal.js.md` §4 一致）。
- **组织全称回填**（`:41-46`）：以 `summary.user.orgName` 为准，与本地缓存 `orgFullName` 不同才调 `auth.updateLocalUser({orgFullName})` 写回 `lm_login_user` 并同步 `app.globalData.user`（`:41` 注释「重新登录或管理员调整组织后本地无/旧名称」；`updateLocalUser` 不改 `loggedIn`，`.qoder/frontend/services/auth.js.md` §4.9）。`44eb77b` 交付（提交信息「『我的』组织名以后端全称回填」）。
- **单次合并 setData**（`:48-66`）：user + 统计 4 字段 + points 重组对象 + 勋章 3 字段一次提交（`e70b59f`「精简 setData」批次的现行形态，提交信息为据）。`points.today = todayWalk + todayQuiz` 为页内加法（`:58`），其余字段直传后端值（`:55-61`）。
- **失败静默降级**（`:68-70`）：任一路 reject 只回写 `user: app.globalData.user`，**不展示错误提示、不清空旧统计**——本页无 errorMsg 类字段（WXML 亦无错误态），与首页的 `routeError` 处理不同；现状事实。

### 4.4 `handleEditNickname()`（`:112-146`）——一次性改名

前端兜底拦截 `user.nicknameChangedAt` 有值的二次修改（toast「昵称仅可修改一次」，`:115-118`；入口本身已按该字段隐藏，WXML `:10-11`、`:110` 注释）。`wx.showModal({editable:true})` 采集（提示语放 title、不放 placeholderText，模拟器叠层规避，`:119` 注释，`a6f174a`）→ 空值拦截（`:127-130`）→ `auth.updateNickname(name)`（`:131-132`，`PUT /auth/nickname`，**每人仅一次由后端校验**，`.qoder/frontend/services/auth.js.md` §4.9）→ 成功 `app.setLoginUser(updated)` 刷全局态 + setData + success toast（`:133-136`）；失败 toast `err.message`（`:138-143`）。

### 4.5 `handleLogout()`（`:151-163`）——退出登录链

`wx.showModal` 确认（confirmColor 主红，`:152-155`）→ 确认后：

1. `app.logout()`（`:158`）：内部调 `auth.clearLocalUser()`（删 `lm_login_user` + `lm_auth_token`、写 `lm_logged_out=1`）并重置 `globalData.user=null / loggedIn=false`（`frontend/app.js:21-25`；键语义 `.qoder/frontend/services/auth.js.md` §4.1/§4.9）。
2. `wx.reLaunch({url:'/pages/login/login'})`（`:159`）——**跳登录页而非启动页**：因 `lm_logged_out` 标记会阻止 launch 页静默重登（`.qoder/frontend/services/auth.js.md` §7 规则 2「用户主动退出后绝不静默登录」），必须手动登录，与 `frontend/AGENTS.md` §7「登出调 app.logout()，之后需登录页手动登录」一致。

### 4.6 事件处理与页面跳转（全部出口，逐行核实）

| 方法 | 行号 | 跳转 | 触发点（WXML） |
|---|---|---|---|
| `goPoints` | `:73-75` | `navigateTo /pages/points/points` | 积分卡整卡 `:30` + 菜单「积分明细」`:73` |
| `goRank` | `:77-79` | `switchTab /pages/rank/rank` | 积分卡第三格 `catchtap`（`:46`，阻止冒泡到整卡 goPoints） |
| `goProfile` | `:82-84` | `navigateTo /pages/profile/profile` | 菜单「我的长征」`:77` |
| `goCalendar` | `:87-89` | `navigateTo /pages/calendar/calendar` | 菜单「行军日历」`:81` |
| `goSportRecords` | `:91-93` | `navigateTo /pages/sport-records/sport-records` | 菜单「运动记录」`:89` |
| `goQuizRecords` | `:95-97` | `navigateTo /pages/quiz-records/quiz-records` | 菜单「答题记录」`:93` |
| `goMedals` | `:99-101` | `navigateTo /pages/medals/medals` | 头部勋章条 `:20` + 菜单「我的勋章」`:97` |
| `goOrgSelect` | `:104-106` | `navigateTo /pages/org-select/org-select?from=mine` | 头部组织行 `:14` + 菜单「组织架构」`:85` |
| `handleEditNickname` | `:112` | 无跳转（弹窗） | `:11` |
| `handleLogout` | `:151` | 确认后 `reLaunch /pages/login/login` | `:104` |
| onShow 守卫 | `:27` | `reLaunch /pages/launch/launch` | — |

**跨页对账（供 reconciliation）**：全仓 grep `/pages/profile/profile`，产品代码中的入口**只有本页 `mine.js:83`**（其余命中均为 automator 测试脚本），而 `profile.js:6` docstring 自称「入口：行军日历」——该 docstring 与代码不符（行军日历反而是 profile 页的**出口**：`profile.js:115`、`:213` navigateTo calendar）。本页不跳转 account / bind / person / ticket / ceremony / node-detail / activity / ai-chat；「账号与绑定」入口已由 `2d20dc9` 移除（§3、§9）。

## 4-1. WXML 专章（mine.wxml，106 行）

自上而下 5 个区块：

1. **头部红渐变区**（`:3-27`）：头像 `image`/占位 🏃 二选一（`:5-6`）；昵称 + 改名入口（`wx:if="{{!user.nicknameChangedAt}}"`，`:11`）；组织行整行 `bindtap="goOrgSelect"`，文案 `user.orgFullName || '点击选择组织架构'`，右侧按 `user.orgId` 显示 🔒（已选锁定）或 ›（可选）（`:14-18`，锁定只读语义 `mine.js:103` 注释）；勋章条整行 `bindtap="goMedals"`，`wx:for medalIcons` `wx:key="id"` + `medalCount/medalTotal`，空态「🏅 暂无勋章，快去运动答题吧 ›」（`:20-26`）。
2. **积分卡**（`:30-51`）：整卡 `bindtap="goPoints"`；总积分大字（null 显示 `--`，`:35`）；今日增量行 `wx:if="{{points}}"`（`:36`）；三格拆分——步行积分/答题积分/积分排名（`points.rank` 显示「第 N 名」，第三格 `catchtap="goRank"`，`:37-50`）。
3. **数据统计卡**（`:54-69`）：三格——累计运动(步) `totalSteps`、已点亮节点 `litCount / totalCount`、累计答题(次) `quizCount`。
4. **功能菜单卡**（`:72-101`）：7 个 `menu-item`，顺序为积分明细/我的长征/行军日历/组织架构/运动记录/答题记录/我的勋章，与 §4.6 一一对应。
5. **退出按钮**（`:103-105`）：`<button bindtap="handleLogout">`。

约定核对：展示值全部为 data 直绑或简单三元/`||` 兜底，无原生方法调用（`points.today` 的加法在 js 侧 `:58` 完成，`frontend/AGENTS.md` §5.2）；唯一列表 `wx:key="id"` 非 index；入场动画 `anim-float`（头像 `:4`）与 `anim-card` + 内联 `animation-delay: 60/140/280ms` 三卡错峰（`:30`、`:54`、`:72`）。

## 4-2. WXSS 专章（mine.wxss，258 行）

- **依赖全局样式**：`card`（`frontend/app.wxss:14`，WXML `:54`/`:72`）、`anim-card`（`app.wxss:300`）、`anim-float`（`app.wxss:309`）；**本文件无局部 keyframes**。
- **布局要点**：头部品牌红渐变 `#A00D26→#C8102E`（`:7`）；积分卡深红鎏金「荣耀红金」渐变 + 金边（`:128-138`），`margin-top:-30rpx` 负边距上叠头部（`:130`）；勋章图标 52rpx 圆形金边（`:105-114`）；昵称/组织文本 `ellipsis` 截断（`:44-51`、`:83-88`）；菜单项 `last-child` 去底边线（`:234-236`）；退出按钮白底红字、`::after` 去原生边框（`:248-258`）。
- 单位全 rpx；主色 `#C8102E` 与鎏金 `#E8C76A`/`#FFD766`/`#FFE9A8` 系（`:150`、`:163`、`:58` 等）。**逐选择器对照 WXML 未发现死选择器**（本页 34 个类全部有命中）。

## 4-3. JSON 专章（mine.json，5 行）

仅 3 键：`navigationBarTitleText: "我的"`（与 tabBar text 一致，`app.json:68`）、`navigationBarBackgroundColor: "#C8102E"`、`navigationBarTextStyle: "white"`——后两键与 `app.json` `window` 全局默认相同（`app.json:29-32`），属冗余声明。无 `usingComponents`、无下拉刷新配置。

## 5. 输入与输出

- **入参**：无。tab 页经 `switchTab` 进入，不接收 query（全文件无 `onLoad(options)`）。
- **出参（页面调用的 service 与后端路径）**：

| service 调用 | mine.js 行号 | 后端路径 |
|---|---|---|
| `profile.getSummary()` | `:35` | `GET /api/profile/summary`（`.qoder/frontend/services/profile.js.md` §4） |
| `medal.getMedalList()` | `:35` | `GET /api/medal/list`（`.qoder/frontend/services/medal.js.md` §4，带自动发放副作用） |
| `points.getSummary()` | `:35` | `GET /api/points`（`.qoder/frontend/services/points.js.md` §4；该文档 §6 记录的本页引用行号 `mine.js:10`/`:35` 与现码一致） |
| `auth.updateNickname(name)` | `:132` | `PUT /api/auth/nickname`（`.qoder/frontend/services/auth.js.md` §4.9） |
| `auth.updateLocalUser(patch)` | `:45` | 无请求（本地 Storage + globalData，同文 §4.9） |
| `app.logout()` | `:158` | 无请求（内部 `auth.clearLocalUser()`，`frontend/app.js:21-25`） |

- **错误出口**：`refresh` 失败静默（`:68-70`）；改名失败 toast（`:138-143`）。401/403 由 request.js 链统一处理（静默重登重试一次/活动拦截，`.qoder/frontend/services/request.js.md`），页面不感知。

## 6. 依赖关系

- **require（`:6-10`，5 项全部有使用）**：`app = getApp()`；service 4 个——`auth/profile/medal/points`。页面零直接 `wx.request`、零 Storage 直接读写（登录缓存仅经 auth.js，`frontend/AGENTS.md` §3.1、§6.5）。
- **被依赖**：`app.json` pages/tabBar 注册（`app.json:7`、`:66-71`）；作为 profile/points/calendar/sport-records/quiz-records/medals 等子页的产品代码入口（§4.6；其中 profile 页的唯一产品入口，见 §4.6 跨页对账）。
- **数据库表**：前端不触库；各接口涉及的表见对应后端路由文档（如 `.qoder/backend/app/api/routes/sport.py.md` §6）。

## 7. 业务规则

1. **登录守卫与缓存键**：守卫只认 `app.globalData.loggedIn`，为假 reLaunch 启动页（`:26-28`）；本页不直接读写 `lm_login_user`/`lm_auth_token`/`lm_logged_out`，均经 auth.js（不变量 3）。
2. **改名机会唯一**：入口按 `nicknameChangedAt` 隐藏（WXML `:11`）+ js 兜底拦截（`:115-118`）+ 后端最终校验，三层防重复（`.qoder/frontend/services/auth.js.md` §7 规则 5）。
3. **组织选定后锁定只读**：本页仅导航到 org-select（`from=mine`），展示 🔒 并提示联系管理员的逻辑在 org-select 页（`:103` 注释；`44eb77b`「组织锁定只读」）。
4. **组织全称以后端为准**：`summary.user.orgName` 与本地不一致即回填缓存（`:41-46`），保证管理员调整组织后本地名称自愈。
5. **积分口径**：总积分 = 步行 + 答题，全部由后端台账计算、页面只做加法 `today = todayWalk + todayQuiz`（`:58`）；步行积分「每满 1000 步 1 分、无单日上限」的权威见 `.qoder/frontend/services/points.js.md` §7（`9cb65b8`）。
6. **退出即断静默重登**：`lm_logged_out` 写入后 launch 页不再自动登录，必须经 login 页手动登录（§4.5）。

## 8. 修改约束

1. **登出三方耦合**：`app.logout()`/`lm_logged_out` 语义/launch 页行为三者联动（`.qoder/frontend/services/auth.js.md` §8 第 4 条），改退出流程须同步 `app.js` 与 `launch.js`；`:159` 的 reLaunch 目标是 **login** 页，改成 launch 会被静默重登「弹回」，破坏主动退出语义。
2. **`goRank` 必须用 `switchTab`**（`:78`，rank 是 tab 页）；WXML `:46` 的 `catchtap` 不得改为 `bindtap`，否则点排名格会同时触发整卡 goPoints。
3. **points 对象 7 键与 WXML 直绑是硬契约**（`:54-62` ↔ WXML `:35-48`），后端字段 camelCase 契约见 `.qoder/frontend/services/points.js.md` §8 第 1 条（消费页明列 mine/points）。
4. `updateLocalUser` 返回值可能为 null（Storage 异常，`.qoder/frontend/services/auth.js.md` §5），`:45` 的 `|| cached` 兜底不得移除。
5. 展示字段须在 js 侧预处理（WXML 不支持原生方法调用）；`wx:key="id"` 不得改 index（`frontend/AGENTS.md` §5.2）。
6. 主色 `#C8102E`、页面 json 三键受全局约定约束（`frontend/AGENTS.md` §2/§5.3）；本页在 automator 巡礼断言清单内（`frontend/test/automator/s16-review-smoke.cjs` 等），改布局影响测试基线。

## 9. 当前实现状态

- **已实现**：三路聚合刷新（单次合并 setData）、组织全称回填、一次性改名、勋章条、积分卡与排名入口、7 项菜单导航、退出登录链、登录守卫。`git log --follow` 共 14 个提交（§10）。
- **存在问题 / 已知事项（事实陈述）**：
  1. **`refresh` 失败无任何用户可见提示**（`:68-70` 仅回写 user），弱网下统计/积分停留在初值或旧值——现状事实，是否补错误态**待确认**。
  2. `totalCount` 初值 10 硬编码（`:17`），成功后被后端值覆盖（`:52`）；失败时「已点亮节点」按 `/10` 展示旧口径。
  3. **profile 页 docstring 入口描述与代码不符**：`profile.js:6` 写「入口：行军日历」，实际唯一产品入口是本页 `mine.js:83`（§4.6 跨页对账；本文档只记录，不改 profile 侧）。
  4. account/bind 入口已隐藏（`2d20dc9`），account 页现仅测试脚本直达（提交信息为据）；身份绑定功能的正式入口恢复与否**待确认**。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/mine`（**14 个提交**），全部在 `docs/迭代记录.md` 有对应条目（按提交号逐一核对存在）。按时间倒序、按主题分组；除注明外，各提交对本文件的具体 diff 未逐一核对，以提交信息与该条目为据。

### 2026-10-15（`9cb65b8`、`85c5a55`）
- 需求：步行积分口径调整（全端）：取消单日封顶改「累计步数每满 1000 步 1 分」（`9cb65b8`）；「我的」页累计运动(步)改与步行积分同口径的计分展示（`85c5a55`，涉 WXML 统计格文案，现 `mine.wxml:58`「累计运动(步)」）。
- 测试结果：见 `docs/迭代记录.md` 的 `9cb65b8`、`85c5a55` 条目。

### 2026-10-13（`44eb77b`）
- 需求：V2.0 小程序批次——「我的积分卡与积分明细页」「组织锁定只读」「『我的』组织名以后端全称回填」。
- 修改内容（涉本文件）：积分卡区块（`:54-62`、WXML `:30-51`）、`goPoints` 入口（`:73-75`）、组织全称回填（`:41-46`）、组织行 🔒 只读展示（WXML `:14-18`）。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（v2 自动化验收 14/14）。

### 2026-10-12（`2d20dc9`）
- 需求：隐藏「我的」页「账号与绑定」入口（account 页与后端绑定接口保留），身份截图脚本改直接导航 account 页。
- 修改内容（涉本文件）：删除 bind/account 菜单项及处理器（现码无残留；入口为 `6ed1999` 所加）。
- 测试结果：见 `docs/迭代记录.md` 的 `2d20dc9` 条目。

### 2026-10-11（`e70b59f`、`01e214a`）
- 需求：小程序代码审查修复批次（`e70b59f`：精简 setData 与登录守卫等）；V1.0 启动页自动登录并取消强制选组织（`01e214a`）。
- 修改内容（涉本文件）：`refresh` 单次合并 setData 现行形态（`:48-66`）；onShow 守卫 reLaunch launch（`:26-28`）。细节以提交信息与条目为据。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f`、`01e214a` 条目。

### 2026-10-09（`6ed1999`）
- 需求：身份关联小程序侧（批次 5）：bind/account 页与 mine 入口。
- 修改内容（涉本文件）：新增「账号与绑定」菜单入口（后由 `2d20dc9` 隐藏）。
- 测试结果：见 `docs/迭代记录.md` 的 `6ed1999` 条目（automator 15/15 + 6 截图）。

### 2026-10-02（`a6f174a`、`2cfa336`、`7e587c9`）
- 需求：昵称弹窗提示语移至标题（`a6f174a`，现 `:119-121`）；真实姓名采集提示位置调整（`2cfa336`）；页面高级化升级批次（`7e587c9`，现行卡片流结构与三路聚合的起点）。
- 测试结果：见 `docs/迭代记录.md` 对应条目。

### 2026-10-01（`aebbd79`、`f820e0e`）
- 需求：微信名称直登与昵称仅可修改一次（三端，`f820e0e`）；已改名用户隐藏修改按钮 + 弹窗提示仅一次（`aebbd79`，现 WXML `:11` 与 `:115-118`）。
- 测试结果：见 `docs/迭代记录.md` 的 `f820e0e`、`aebbd79` 条目。

### 2026-09-30（`b0ba252`、`a94e685`）
- 需求：`a94e685` 仓库初始化创建本页（Mock 版）；`b0ba252` 强制已登录用户完成组织选择（该强制流程后被 `01e214a` 取消，两条提交信息为据；现行组织入口为选填/锁定只读，`:103-106`）。
- 测试结果：见 `docs/迭代记录.md` 对应条目（`a94e685` 条目仅「仓库初始代码」）。
