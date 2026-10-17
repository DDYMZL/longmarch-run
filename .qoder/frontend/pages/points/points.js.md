# points.js（积分明细页 · 页面级合一：points.js / points.wxml / points.wxss / points.json）

## 1. 文件路径

- `frontend/pages/points/points.js`（108 行）
- `frontend/pages/points/points.wxml`（74 行）
- `frontend/pages/points/points.wxss`（136 行）
- `frontend/pages/points/points.json`（8 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

**积分明细页**（头注释 `points.js:1-4`）：积分汇总 hero + 今日进度与计分规则卡 + 按自然日倒序的明细表（分页，`onReachBottom` 追加）。「积分口径全部来自后端，前端仅展示」（`:3` 注释；`.qoder/frontend/services/points.js.md` §7 同口径），本页无任何积分计算与本地持久化。

**入口证据**：`app.json:25` 注册；小程序内两处 `navigateTo` 入口——「我的」页积分卡（`frontend/pages/mine/mine.js:74`）与个人档案页（`frontend/pages/profile/profile.js:126`）。非 tab 页。

## 3. 业务需求

- V2.0 批次「我的积分卡与积分明细页」`44eb77b`（2026-10-13）创建本页（提交信息；`docs/迭代记录.md` 的 `44eb77b` 条目）。
- 积分台账 V2.0 数据源：后端 `points_log` 每用户每来源每天一行（`.qoder/backend/app/api/routes/points.py.md` §3、§7 规则 1）。
- 步行积分口径两次调整的展示端落点：`6f2cfc3` 补结余步数展示、`9cb65b8` 取消单日封顶改文案（§10；口径权威 `.qoder/frontend/services/points.js.md` §3）。

## 4. 核心功能（points.js）

### 4.1 模块级常量与纯函数

- `PAGE_SIZE = 20`（`:8`）——首屏与翻页共用的每页条数。
- `toRow(d)`（`:10-20`）：明细行 → 视图行，唯一派生字段 `text = d.date.slice(5)`（「MM-DD」，`:13`）——在 js 侧预处理日期截断，遵守「WXML 不支持原生方法调用」（`frontend/AGENTS.md` §5.2）；其余 6 字段（`date/steps/correctCount/walk/quiz/total`）直传，`updatedAt` 不消费。

### 4.2 `data` 状态字段（`:23-32`，按关注点分组）

| 分组 | 字段 | 来源 |
|---|---|---|
| 汇总卡 | `summary`（`:24`，初值 null） | `points.getSummary()` 映射（`:50-61`，含派生 `today = todayWalk + todayQuiz`，`:54`） |
| 规则参数 | `rules`（`:25`） | 同一响应的 `s.rules`（`:62`；`walkStepsPerPoint/quizPerCorrect/quizDailyCap`，后端下发，`.qoder/frontend/services/points.js.md` §5） |
| 明细列表 | `items/page(初值1)/hasMore`（`:26-28`） | `points.getDaily(page, PAGE_SIZE)` |
| 加载/错误 | `loading(初值true)/loadingMore/errorMsg`（`:29-31`） | refresh 与翻页流程 |

页面实例属性（非 data）：`_reqId`（`:43`，请求序号守卫）。**无定时器、无动画句柄、无事件监听**——无需 onHide/onUnload 清理（本页也未定义这两个钩子）。

### 4.3 生命周期与刷新：`onShow`（`:34-40`）+ `refresh()`（`:42-75`）

- `onShow`：登录守卫 `app.globalData.loggedIn` 为假 → `wx.reLaunch('/pages/launch/launch')`（`:35-38`，不带 redirect；`frontend/AGENTS.md` §4 不变量 5）；否则 `refresh()`（`:39`）——符合不变量 1「数据展示页必须 onShow + refresh」。无 onLoad。
- `refresh()`：**请求序号守卫** `_reqId` 自增（`:43`），then/catch 内序号不符即丢弃（`:46`、`:71`）——onShow 与下拉刷新并发时只采纳最后一次。`Promise.all([points.getSummary(), points.getDaily(1, PAGE_SIZE)])`（`:44`）首屏双请求并发；成功单次 setData 重置全页状态并回 `page:1`（`:49-68`）；`hasMore = daily.items.length < daily.total`（`:65`，**`total` 是「有台账的天数」而非积分和**，`.qoder/backend/app/api/routes/points.py.md` §7 规则 4）；失败置 `errorMsg`（`:72`）；末段 `.then` 统一 `wx.stopPullDownRefresh()`（`:74`，非下拉路径调用亦无害）。
- `onPullDownRefresh`（`:77-79`）：直接复用 `refresh()`；下拉能力由 points.json `enablePullDownRefresh: true` 开启（§4-3）。
- `handleRetry`（`:104-107`）：错误态「重新加载」按钮，先复位 `loading/errorMsg` 再 `refresh()`。

### 4.4 分页加载更多：`onReachBottom`（`:81-102`）

- **触发与防重入**：`!hasMore || loadingMore` 直接 return（`:82`）——到底/加载中不重复请求。
- **过期丢弃**：请求前捕获当前 `_reqId`（`:84`），响应回来序号不符（期间发生过 refresh，列表已重置为第 1 页）即丢弃追加（`:89`）。
- **增量 setData**：不整表重传——以 `patch['items[' + (base + i) + ']'] = toRow(d)` 逐行定点追加（`:90-94`，`base` 为现有行数），符合大数据量列表性能要求（根 `agents.md` §2.4）。
- **到底判定**：`hasMore = daily.items.length > 0 && base + daily.items.length < daily.total`（`:95`）——空页强制置 false，防后端返回空 items 时无限触底重试。
- **失败路径**：复位 `loadingMore` + toast「加载失败，请稍后重试」，**保留已加载列表**、不改 `page`（`:98-101`），下次触底重试同一页。

## 4-1. WXML 专章（points.wxml，74 行）

顶层三态互斥 + 正常态两卡：

1. **加载态**（`:2`）：`wx:if="{{loading}}"` → 「积分数据加载中…」。
2. **错误态**（`:4-7`）：`wx:elif="{{errorMsg && !summary}}"` → 错误文案 + 「重新加载」按钮（`bindtap="handleRetry"`，`btn-ghost retry-btn`）——**仅首屏失败（summary 尚为 null）才整页报错**。
3. **汇总 hero**（`:11-31`）：总积分大字 `summary.total`；`summary.rank` 存在时显示「积分排名 第 N 名」徽标（`:14`，rank 可为 null，`.qoder/frontend/services/points.js.md` §5）；三等分 `hero-split`——步行积分/答题积分/今日获得（`+{{summary.today}}`，`:15-30`）。
4. **今日进度与规则卡**（`:34-49`）：今日步数+步行得分行、今日答对+答题得分行（`+{{summary.todayQuiz}}/{{rules.quizDailyCap}}`）；4 条规则文案全部以 `rules.*`/`summary.walkCarry` 插值（`:45-48`）——步行「每累计 N 步 1 分，不设单日上限，不足部分结余累计」、结余步数行、答题「每答对 1 题 N 分，每日最多 M 分；超时不计分」、总积分口径行。**规则数字不硬编码**，随 `rules` 下发（`9cb65b8` 起口径，§10）。
5. **每日明细卡**（`:52-72`）：表头 5 列（日期/步数/步行/答题/合计，`:55-61`）；`wx:for items` `wx:key="date"`（`:62`，date 为自然日唯一），每行 `item.text`（MM-DD）+ 数值列，答题列附 `（对N）` 子标（`correctCount > 0` 时，`:66`），合计列金色（`:67`）；底部 `load-tip` 三态——`loadingMore` → 「加载中…」、`hasMore` → 「上拉加载更多」、否则 → 「— 已显示全部 —」（`:69`）；空列表 → 全局 `empty-tip`「暂无积分记录，去走路或答题赢取积分吧」（`:71`）。

约定核对：表达式无原生方法调用（日期截断在 `toRow` 完成）；`wx:key` 用 `date` 而非 index。入场动画 `class="card anim-card"` + `style="animation-delay: 80ms/160ms"`（`:34`、`:52`，全局动画类）。

## 4-2. WXSS 专章（points.wxss，136 行）

- **依赖全局样式（app.wxss，行号实测）**：`.card`（`frontend/app.wxss:14`）、`.card-title`（`:22`）、`.btn-ghost`（`:55`，错误态重试按钮）、`.text-gold`（`:70`）、`.empty-tip`（`:83`）、`.divider`（`:91`）、`.anim-card`（`:300`）。
- **hero 深红渐变头图**：`linear-gradient(160deg, #5A0A16 → #8E1023 → #B5122C)` + 鎏金描边与金色大字/光晕（`:18-47`），配色与 points.json 导航栏 `#5A0A16` 一体（§4-3）；`.hero + .card` 负 margin `-40rpx` 使规则卡上叠头图（`:75-77`）。
- **明细表**：flex 行布局，`.col-date` 定宽 120rpx、`.col-num` 等分居中（`:94-119`）；`.col-sub` 小号灰字子标（`:121-124`）；`.gold` 合计列 `#D4A017` 加粗（`:126-129`）；`.load-tip` 底部灰字提示（`:131-136`）。
- 其余：`.state-box` 加载/错误态居中灰字（`:5-10`）、`.retry-btn`（`:12-15`）、`.today-row` 两端对齐行（`:80-85`）、`.rule-line` 小号规则文案（`:87-91`）。单位全 rpx。
- 无死选择器：本地 22 个类名逐一与 points.wxml 比对均有使用；无本地 keyframes（动画全用全局 `anim-card`）。

## 4-3. JSON 专章（points.json，8 行）

6 个键：`navigationBarTitleText: "积分明细"`；`navigationBarBackgroundColor: "#5A0A16"` + `navigationBarTextStyle: "white"`——**深红导航栏，异于全局默认 `#C8102E`**，与 hero 渐变头图（points.wxss `:22`）取同色一体；`enablePullDownRefresh: true` + `backgroundTextStyle: "light"` + `backgroundColor: "#5A0A16"`——下拉刷新配置，背景色同导航栏（下拉露出的窗口背景）。无 `usingComponents`。

## 5. 输入与输出

- **入参**：无。`navigateTo` 进入且不读 query（无 `onLoad`）。
- **出参（页面调用的 service 与后端路径）**：

| service 调用 | points.js 行号 | 后端路径 |
|---|---|---|
| `points.getSummary()` | `:44` | `GET /api/points`（`.qoder/frontend/services/points.js.md` §4 表行 1） |
| `points.getDaily(1, PAGE_SIZE)` | `:44` | `GET /api/points/daily?page=1&page_size=20`（同表行 2） |
| `points.getDaily(next, PAGE_SIZE)` | `:87` | `GET /api/points/daily?page={next}&page_size=20` |

- **命名契约**：query 参数为 snake_case `page_size`、响应体为 camelCase——服务层文档已确立该口径（`.qoder/frontend/services/points.js.md` §4 末段）。**后端页大小上限 100 已确认**：`page_size` 声明 `ge=1, le=100`、越界 422（`.qoder/backend/app/api/routes/points.py.md` §4.1「查询参数」段及 §8.4）——points.js.md §9 留的「待确认」据此可关闭。
- **错误出口**：首屏失败 → `errorMsg` 整页错误态 + 重试按钮（`:70-73`）；翻页失败 → toast、列表保留（`:98-101`）。401 静默重登、活动拦截（后端两端点挂 `require_activity_view`，points.py.md §4.1 表）统一由 request.js 链处理，页面不感知。

## 6. 依赖关系

- **require（`:5-6`，2 项全部有使用）**：`app = getApp()`（仅读 `globalData.loggedIn`）、`services/points`（3 处调用见 §5）。不依赖 utils。零直接 `wx.request`、零 Storage 读写（`frontend/AGENTS.md` §3.1/§6.5）。
- **被依赖**：`app.json:25` 注册；mine 页（`mine.js:74`）与 profile 页（`profile.js:126`）的 `navigateTo` 目标。`points.getDaily` 的全仓唯一调用方即本页（`.qoder/frontend/services/points.js.md` §6：getSummary 另有 mine 页消费）。
- **数据库表**：前端不触库；后端读 `points_log`/`daily_sport`/`quiz_records`（`.qoder/backend/app/api/routes/points.py.md` §6）。

## 7. 业务规则

1. **前端零计算口径**：唯一派生是 `today = todayWalk + todayQuiz`（`:54`，两后端字段求和展示）；步行/答题计分、结余结转（`walkCarry`）、去重全在后端 points_service（points.py.md §7 规则 1-2；`frontend/AGENTS.md` §3.1「后端是唯一数据源」）。
2. **分页语义**：`daily.total` = 有台账的**天数**（points.py.md §7 规则 4），`hasMore` 判定（`:65`、`:95`）依赖该语义，勿当积分和。
3. **登录守卫与缓存键**：本页不读写任何 Storage 键；守卫只认 `app.globalData.loggedIn`（`:35-38`）。
4. **规则文案参数化**：4 条规则行的数字全部来自 `rules`（WXML `:45-48`），后端调参数无需改前端；但**文案句式**（「不设单日上限，不足部分结余累计」等）硬编码在 WXML，口径再调整需人工同步（`9cb65b8` 即此类改动，§10）。

## 8. 修改约束

1. **`_reqId` 守卫不得移除**：onShow、下拉、翻页三路径天然并发（`:39`、`:78`、`:87`），去掉序号比对会出现旧响应覆盖新列表（`:43`、`:46`、`:89`）。
2. **增量 setData 的 `items[N]` 定点写法**（`:92-94`）与 `toRow` 输出结构绑定 WXML 渲染字段（`text/steps/walk/quiz/total/correctCount/date`），改字段须同步 §4-1 第 5 区块；`wx:key="date"` 不得改用 index（`frontend/AGENTS.md` §5.2）。
3. `summary` 映射的 10 个字段与后端 `PointsSummaryOut` 是 camelCase 硬契约（`backend/AGENTS.md` §4.1）：`todayWalk/todayQuiz` 实测对应后端 `today_walk`/`today_quiz`（`backend/app/schemas/schemas.py:548`、`backend/app/services/points_service.py:198`；`.qoder/backend/app/api/routes/points.py.md` §5 记作 `todayWalkPoints/todayQuizPoints`，与现 schema 字段名不符，以源码为准）。改字段须双端同步并核对另一消费页 mine。
4. 页大小 `PAGE_SIZE=20` 改动须保持在后端 `le=100` 内（points.py.md §8.4），且首屏/翻页共用该常量（`:8`），勿两处各写一套。
5. 保持页面零业务计算：不得把积分换算、累计或缓存写进本页（`frontend/AGENTS.md` §6.5）。

## 9. 当前实现状态

- **已实现**：汇总/规则/明细三区块、首屏并发双请求 + 序号守卫、下拉刷新、触底分页（防重入/过期丢弃/增量 setData/到底判定）、首屏错误态 + 重试、翻页失败 toast、空态文案。`git log --follow` 共 3 个提交（§10）。
- **存在问题 / 已知事项（事实陈述，代码推导）**：
  1. **`loadingMore` 卡死边界**：若翻页请求在途时发生 `refresh()`（如触底瞬间切后台再回场触发 onShow），翻页响应因 `_reqId` 不符被丢弃（`:89`）且**不复位 `loadingMore`**（复位仅在正常/失败路径 `:91`、`:99`），而 `refresh()` 的 setData 不含 `loadingMore`（`:49-68`）——此后 `:82` 恒早退，分页失效直至下次 refresh 后再次触底仍被挡。是否需补「丢弃时复位」或「refresh 时复位 loadingMore」**待确认**（现状未见修复提交）。
  2. **首屏成功后的刷新错误静默**：错误态渲染条件为 `errorMsg && !summary`（WXML `:4`），已有数据时 refresh 失败只写 `errorMsg` 不展示（`:72`），用户看旧数据且无提示——保留旧列表属合理降级，但无任何失败反馈是现状事实。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/points/`（**3 个提交**），均已核对存在于 `docs/迭代记录.md`。按时间倒序。

### 2026-10-15（`9cb65b8`、`6f2cfc3`）
- 需求：步行积分口径两步调整（全端）。
- 修改内容（涉本目录，diff 实读）：`6f2cfc3`（12:19）补结余积分展示——points.js `summary` 映射增 `walkCarry: s.walkCarry`（现 `:59`）、points.wxml 增「当前有 N 步结余」规则行（现 `:46`）；`9cb65b8`（18:03）取消单日 20000 封顶——wxml 步行规则行改为「每累计 N 步 1 分，不设单日上限，不足部分结余累计」并删除 `walkDailyCap/walkStepCap` 插值（现 `:45`），今日步行得分去掉「/上限」后缀（现 `:38`）。
- 测试结果：见 `docs/迭代记录.md` 的 `6f2cfc3`、`9cb65b8` 条目。

### 2026-10-13（`44eb77b`）
- 需求：V2.0 小程序批次「我的积分卡与积分明细页」。
- 修改内容（涉本目录）：创建四件套（提交信息为据；本批同时交付答题限时、积分排行榜、活动状态页等）。
- 测试结果：v2 自动化验收 14/14（提交信息）；详见 `docs/迭代记录.md` 的 `44eb77b` 条目。
