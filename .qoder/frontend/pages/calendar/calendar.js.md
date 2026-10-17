# calendar.js（行军日历 · 页面级合一：calendar.js / calendar.wxml / calendar.wxss / calendar.json）

## 1. 文件路径

- `frontend/pages/calendar/calendar.js`（160 行）
- `frontend/pages/calendar/calendar.wxml`（97 行）
- `frontend/pages/calendar/calendar.wxss`（257 行）
- `frontend/pages/calendar/calendar.json`（5 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

行军日历子页：按月展示逐日步数四档热力色阶（0 无 / 1: 1-4999 / 2: 5000-9999 达标 / 3: 10000+，`calendar.js:3` 头注释，档位定义与后端 `_level_of` 一致，`backend/app/services/sport_service.py:236-242`）、月统计条（月总步数/运动天数/日均/单日最高/连续行军）与当日详情弹层（步数/达标/答题/点亮节点，`:4` 注释）。数据全部来自单一接口 `GET /api/sport/calendar?month=YYYY-MM`，页面本地只做格子拼装与格式化。

**入口证据**（全仓 grep `/pages/calendar/calendar`，产品代码 3 处）：「我的」页菜单 `frontend/pages/mine/mine.js:88`、首页连续行军卡 `frontend/pages/home/home.js:389`（`goCalendar`）、档案页 `frontend/pages/profile/profile.js:115`、`:213`。`app.json:18` pages 注册（非 tab 页，均经 `navigateTo` 进入）。

## 3. 业务需求

- 页面由「小程序页面高级化升级（首页重组/档案/**行军日历**/到达动画/情报化/勋章墙）」批次创建（`7e587c9`，2026-10-02；后端聚合接口同批 `18c2121` 先行交付，`docs/迭代记录.md` 对应条目、`.qoder/backend/app/api/routes/sport.py.md` §10）。
- `b5aa5d2`（2026-10-15）修复详情弹层「点亮节点」长文本整盒换行掉行（现 `calendar.wxss:245-253` 注释与 `display:block` 修复）。
- `01e214a`（2026-10-11）登录守卫改 reLaunch 启动页；`e70b59f`（2026-10-11）代码审查批次（并发请求守卫等，现 `_requestId` 形态，`:47-49`）。各条见 `docs/迭代记录.md`。

## 4. 核心功能（calendar.js）

### 4.1 模块级常量与纯函数（`:10-15`）

- `WEEKDAYS`（`:10`）：日～六表头数组，直接进 data（`:25`）。
- `monthStr(y, m)`（`:13-15`）：拼 `YYYY-MM`（`util.pad` 补零），是后端 month 参数的唯一生成点（格式受控，后端做 400 校验，`.qoder/backend/app/api/routes/sport.py.md` §4.4）。

### 4.2 `data` 状态字段（`:18-29`，按关注点分组）

| 分组 | 字段 | 来源 |
|---|---|---|
| 加载态 | `loading(初值true)/errorMsg`（`:19-20`） | `loadMonth` 流程（`:50-51`、`:70`） |
| 月份游标 | `year(初值2026)/month(初值10)/monthTitle/isCurrentMonth(初值true)`（`:21-24`） | `onLoad` 以设备本地时间覆盖（`:31-34`）、`loadMonth` 写标题与当月判定（`:53-54`） |
| 网格 | `weekdays/cells`（`:25-26`） | `buildCells`（`:63`） |
| 统计与弹层 | `stats(初值null)/selected(初值null)`（`:27-28`） | 接口 `res.stats`（`:64`）、`handleDayTap`（`:140-152`） |

页面实例属性（非 data）：`_requestId`（`:48-49`，请求序号守卫）。**无定时器、无动画句柄、无事件监听、无 WS 订阅**（全文件无 setInterval/setTimeout/canvas/ws）。

### 4.3 生命周期

- **`onLoad`（`:31-34`）**：以 `new Date()`（设备本地时间）初始化 `year/month` 游标，覆盖 data 占位初值。
- **`onShow`（`:36-42`）**：① 登录守卫：`app.globalData.loggedIn` 为假即 `wx.reLaunch('/pages/launch/launch')` 并 return（`:37-39`；子页自守卫，`frontend/AGENTS.md` §4 不变量 5）；② `loadMonth()`（`:41`）。**刷新策略 = 每次 onShow 重拉当前游标月份**（不变量 1）；从详情弹层返回本页不触发 onShow（弹层是页内 setData，非路由）。
- **无 `onHide`/`onUnload`**：无任何需清理的 JS 资源（§4.2），详情弹层为纯 data 状态、页面卸载随实例销毁——现状事实，非遗漏。

### 4.4 `loadMonth()`（`:44-72`）——单接口加载 + 请求序号守卫

1. **守卫**：`_requestId` 自增并留存（`:48-49`），响应回调里序号不等于当前值即丢弃（`:60`、`:69`）——快速切换月份只采纳最后一次请求，避免旧月份数据覆盖（`:47` 注释；`e70b59f` 批次模式，与首页 `_refreshRequestId` 同款，`.qoder/frontend/pages/home/home.js.md` §4.4）。
2. **头部小 setData**（`:50-55`）：置 loading、清 errorMsg、拼 `monthTitle`（`YYYY 年 M 月`）、算 `isCurrentMonth`（游标与设备本地当前年月全等）。
3. **请求**：`sport.getCalendar(monthStr(year, month))`（`:57-58`）→ `GET /api/sport/calendar?month=YYYY-MM`（`frontend/services/sport.js:121-123`，`.qoder/frontend/services/sport.js.md` §4.8）。
4. **成功**（`:59-67`）：一次 setData 提交 `cells`（`buildCells` 拼装）、`stats`、`selected:null`（换月自动关弹层）、`loading:false`。
5. **失败**（`:68-71`）：`errorMsg: '日历加载失败，请稍后重试'` 整页错误态（WXML `:3`）。

### 4.5 `buildCells(year, month, days)`（`:77-109`）——月历格子拼装

- 后端 `days[]` 建 `date → info` 映射（`:78-81`）；后端对整月每日**恒返回一条**（无记录补 0 步，`backend/app/services/sport_service.py:285-299`），前端仍留 `|| {date, steps:0, level:0}` 兜底（`:93`）。
- `todayStr = util.formatDate(new Date())`（`:83`，**设备本地时区**，`frontend/utils/util.js:14-17` 用本地 getter）；首日星期 `new Date(year, month-1, 1).getDay()`、当月天数 `new Date(year, month, 0).getDate()`（`:84-85`）。
- 前导空格子 `{key:'blank-'+i, blank:true}`（`:88-90`）+ 逐日格子（`:91-107`）：`key=dateStr`（wx:key 用日期串）、`day/date/steps/level/goalCompleted/quizDone/quizScore/litNodes/isToday`，布尔字段 `!!` 归一、`litNodes` 数组兜底（`:101-104`）。

### 4.6 月份导航（`:111-132`）

- `prevMonth`（`:111-120`）：月减 1、跨年借位（`:114-117`），**无下界**——可无限翻向历史月份（后端按 month 查库，空月返回全 0 格子）。
- `nextMonth`（`:122-132`）：**上界 = 设备本地当前月**——`isCurrentMonth` 为真直接 return（`:123`，WXML `:10` 同步置灰 `disabled` 类）；否则月加 1 跨年进位（`:126-129`）。
- 两个方向都是 setData 游标后调 `loadMonth()`（`:118-119`、`:130-131`）。

### 4.7 `handleDayTap(e)`（`:137-153`）与详情弹层

点击格子取 `dataset.cell`（WXML `:49` 整格传入），空格子直接 return（`:139`）；**不发任何请求**——详情数据全部来自月接口已下发的格子字段，页内预格式化后一次 setData 打开弹层（`:140-152`）：`stepsText`（`util.formatNumber` 千分位）、`litNodesText`（`litNodes.join('、')`，供 WXML 直绑）、其余字段透传。`closeDetail`（`:155-157`）置 `selected:null` 关闭；`noop`（`:159`）供弹层卡片 `catchtap` 阻止冒泡到遮罩（WXML `:74`）。

### 4.8 时区口径核对（本次建档专项，逐行核实）

**后端为北京时间自然日**：`BEIJING_TZ = UTC+8`（`backend/app/core/helpers.py:9`）、`today_str()` 取北京时间当日（`helpers.py:19`、`:22`）；`daily_sport.date` 由微信步数按北京时间归日写入（`.qoder/backend/app/api/routes/sport.py.md` §4.3 第 2 点；V2.0 起「业务日期统一北京时间」，同文 §10 `ce14a95` 条目）；点亮时间 UTC 存储、按北京时间归格（`sport_service.py:282-283` 调 `to_local`，`helpers.py:37`）。
**本页全部用设备本地时间**：`onLoad` 游标（`calendar.js:32-33`）、`isCurrentMonth`（`:46`、`:54`）、`todayStr`（`:83`，经 `util.formatDate` 本地 getter）。
**结论（事实陈述）**：设备时区 = UTC+8（国内手机常态）时两端口径一致；设备处于其他时区时，在日界前后会出现 ① `isToday` 高亮格与后端「今日」错位一天、② 初始游标月份与 `nextMonth` 上界相对后端当前月偏移一个月的边界现象。前端无任何时区换算代码，属**潜在边界不一致**，是否有实际用户影响**待确认**。

## 4-1. WXML 专章（calendar.wxml，97 行）

三态外层：`loading` →「日历加载中…」（`:2`）、`errorMsg` → 错误文案（`:3`）、`wx:else` 正常块（`:5-96`），复用全局 `empty-tip` 样式。正常块自上而下：

1. **月份切换条**（`:7-11`）：‹ `prevMonth` / 标题 `monthTitle` / › `nextMonth`（`isCurrentMonth` 时加 `disabled` 类置灰，`:10`；点击拦截在 js `:123`）。
2. **月统计条**（`:14-37`）：`wx:if="{{stats}}"`，5 格直绑 `stats.monthSteps/sportDays/avgSteps/maxSteps/currentStreak`（连续行军带 🔥 前缀与 `text-red`，`:33`）——字段为后端 `SportCalendarOut.stats` 的 camelCase 形态（`sport_service.py:305-315`）。
3. **月历卡**（`:40-70`）：星期表头 `wx:for weekdays` `wx:key="*this"`（`:42`，纯字符串列表用 `*this` 合规）；格子 `wx:for cells` `wx:key="key"`，class 拼 `blank`/`lv-{{item.level}}`/`today`（`:48`；lv-0 与 blank 格无对应样式规则即无底色，属预期），`data-cell="{{item}}"` 整对象入 dataset（`:49`）；格内日号 + 标记行——📝 答题完成、⭐ 有点亮节点（`:52-58`）。**色阶图例**（`:63-69`）：三档色点阈值文案（1-4999 / 5000+ 达标 / 10000+）与 📝/⭐ 说明，阈值**硬编码**、须与后端 `_level_of`（`sport_service.py:236-242`）人工同步。
4. **当日详情弹层**（`:73-95`）：`wx:if="{{selected}}"` 全屏遮罩 `bindtap="closeDetail"`，卡片 `catchtap="noop"` + `anim-pop` 入场（`:74`）；标题行拼日期与「（今天）」（`:76`）；步数大字（`:78`）；达标行两分支——达成显示「🎯 已达成连续行军目标（**5000 步**）」（阈值硬编码，与后端 `streakGoal=5000` 对应，`.qoder/frontend/services/sport.js.md` §4.7）、未达成灰字（`:79-81`）；分割线后两行——每日情报（完成/得分 or 未完成，`:83-87`）、点亮节点（金色 ⭐ 列表 or「无」，`:88-92`）；关闭按钮 `btn-ghost`（`:93`）。

约定核对：展示值均为 js 预计算字段（`stepsText/litNodesText/monthTitle`），WXML 表达式无原生方法调用；两个列表 `wx:key` 分别为 `key`（日期串）与 `*this`，非 index（`frontend/AGENTS.md` §5.2）。

## 4-2. WXSS 专章（calendar.wxss，257 行）

- **依赖全局样式**：`empty-tip`（`frontend/app.wxss:83`）、`card`（`app.wxss:14`）、`text-red/text-gray/text-gold`（`app.wxss:74/:78/:70`）、`divider`（`app.wxss:91`）、`btn-ghost`（`app.wxss:55`）、`anim-pop`（`app.wxss:305`）。**本文件无局部 keyframes**。
- **色阶实现**：`.day-cell.lv-1/2/3 .day-num` 三档底色（米黄 `#f6e7c9` → 鎏金 `#e8c76a` → 红渐变 `#c8102e→#a00d26`，`:112-127`）；`.today` 红描边（`:129-131`）；图例色点复用同名 `lv-*`（`:173-183`）。格子 14.28% 七列 flex-wrap 网格（`:82-95`）。
- **弹层**：遮罩 fixed 全屏 `z-index:100`（`:186-197`）；`b5aa5d2` 修复点——`.detail-value` 显式 `display:block` + `max-width:400rpx` + `word-break:break-all`（`:245-253`，`:245` 注释「text 组件需显式块级化，否则长内容时整个盒子会被挤到下一行」）。
- 单位全 rpx；配色沿用主色 `#c8102e`、标题深红 `#5a1a1a`、鎏金 `#d4a017`（`:27`、`:18`、`:229`）。**逐选择器对照 WXML 未发现死选择器**（`.blank` 的透明底规则 `:97-99` 亦有命中）。

## 4-3. JSON 专章（calendar.json，5 行）

3 键：`navigationBarTitleText: "行军日历"`、`navigationBarBackgroundColor: "#F7F1E5"`、`navigationBarTextStyle: "black"`——导航栏**有意区别于全局红底白字**（`app.json:29-32`），用米金底黑字的子页浅色导航（是否属统一子页规范**待确认**，其余子页 json 未逐一核对）。无 `usingComponents`、无下拉刷新配置。

## 5. 输入与输出

- **入参**：无。三个入口均 `navigateTo` 且不带 query（`mine.js:88`、`home.js:389`、`profile.js:115`/`:213`），页面不读 `onLoad(options)`，初始月份恒为设备当前月（`:31-34`）。
- **出参（页面调用的 service 与后端路径）**：

| service 调用 | calendar.js 行号 | 后端路径 |
|---|---|---|
| `sport.getCalendar(month)` | `:58` | `GET /api/sport/calendar?month=YYYY-MM`（`frontend/services/sport.js:121-123`；路由 `require_activity_view` 活动查看闸门，`.qoder/backend/app/api/routes/sport.py.md` §4.1/§4.4） |
| `util.pad/formatDate/formatNumber` | `:14`、`:83`、`:143` 等 | 纯函数，无请求（`.qoder/frontend/utils/util.js.md` §4） |

- **响应消费**：`{month, days[], stats}`——`days[]` 元素字段 `date/steps/level/goalCompleted/quizDone/quizScore/litNodes`（`:93-104` 逐字段消费；后端组装 `sport_service.py:285-299`），`stats` 5 键（WXML `:17-33`）。`month` 回显字段页面未使用（后端原样回传，`sport_service.py:306`）。
- **错误出口**：请求失败 → `errorMsg` 整页错误态（`:70`）；401/403 由 request.js 链处理（静默重登；活动结束查看拦截自动跳活动状态页，`.qoder/frontend/services/sport.js.md` §7 第 5 条）。

## 6. 依赖关系

- **require（`:6-8`，3 项全部有使用）**：`app = getApp()`、`services/sport`（唯一数据源）、`utils/util`。页面零直接 `wx.request`、零 Storage 读写（`frontend/AGENTS.md` §3.1、§6.5）。
- **被依赖**：`app.json:18` 注册；mine/home/profile 三页的导航目标（§2 入口证据）；automator 巡礼与专项测试（`frontend/test/automator/calendar-detail-layout.cjs`、`s5-pages.cjs` 等）。
- **数据库表**：前端不触库；后端日历只读 `daily_sport`/`quiz_records`/`lit_nodes` join `route_nodes`，并经 `streak_service.compute_streaks` 取连续行军（`.qoder/backend/app/api/routes/sport.py.md` §4.4/§6、`sport_service.py:256-303`）。

## 7. 业务规则

1. **登录守卫与缓存键**：守卫只认 `app.globalData.loggedIn`（`:37-39`）；本页不读写任何 Storage 键。
2. **色阶与达标口径以后端为准**：`level` 四档由后端 `_level_of` 计算（`sport_service.py:236-242`），前端只映射类名；「达标」= 单日 ≥5000 步（连续行军目标），弹层文案与图例阈值为前端硬编码镜像（§4-1 第 3/4 点）。
3. **月份边界**：只允许翻到设备本地当前月为止（`:123`），历史月不设下界；换月即重置弹层（`:65`）。
4. **详情零额外请求**：当日详情完全复用月接口数据（`:140-152`），点格子不触网——大数据量约束下整月一次拉取、页内消化（根 `agents.md` §2.4）。
5. **setData 模式核对**：每次 `loadMonth` 共 2 次 setData（头部小对象 `:50-55` + cells/stats 合并一次 `:61-66`），cells 数组 ≤ 37 个对象（6 空格 + 31 天）整体提交但**每轮加载仅一次、非高频**；点格子/关弹层各 1 次小 setData（`:140`、`:156`）。未发现根 `agents.md` §2.4 所警示的「频繁 setData 大对象」模式（`frontend/AGENTS.md` 无 setData 专项不变量，精简要求出自 `e70b59f` 批次，提交信息为据）。

## 8. 修改约束

1. **`_requestId` 守卫不得移除**：快速连点 ‹/› 会并发多个月份请求，去掉守卫会出现旧响应覆盖新响应（`:47` 注释；同首页守卫契约，`.qoder/frontend/pages/home/home.js.md` §8 第 2 条）。
2. **month 参数格式硬约束**：`monthStr` 输出必须保持 `YYYY-MM`（后端长度/分隔符/数字三重校验，非法 400，`.qoder/backend/app/api/routes/sport.py.md` §4.4）；service 侧拼接未编码，依赖本格式受控（`.qoder/frontend/services/sport.js.md` §9 第 2 条）。
3. **阈值/文案双端镜像**：图例三档阈值（WXML `:64-66`）与弹层「5000 步」（WXML `:80`）是后端 `_level_of`/`streakGoal` 的前端镜像，后端调参必须同步改此处（`backend/AGENTS.md` §4.4「禁止单边变更」同理）。
4. **days 元素字段与后端 Schema 是 camelCase 硬契约**（`:93-104` 逐字段消费；`backend/AGENTS.md` §4.1），删改字段须双端同步。
5. `wx:key="key"`（日期串/`blank-i`，`:89`、`:95`）不得改用 index；`.detail-value` 的 `display:block` 修复（`b5aa5d2`）不得回退，否则长点亮列表换行掉行复发。
6. 展示字段（`stepsText/litNodesText/monthTitle`）必须留在 js 侧预处理（WXML 不支持原生方法调用，`frontend/AGENTS.md` §5.2）。

## 9. 当前实现状态

- **已实现**：月历四档色阶网格、月统计条、月份导航（含当月右边界与置灰）、当日详情弹层（零额外请求）、请求序号守卫、登录守卫、加载/错误/正常三态。`git log --follow` 共 4 个提交（§10）。
- **存在问题 / 已知事项（事实陈述）**：
  1. **时区边界不一致**（§4.8）：页面全用设备本地时间、后端全用北京时间自然日；非 UTC+8 设备在日界/月界会出现「今天」高亮错位与当前月偏移——前端无换算代码，实际影响面**待确认**。
  2. `prevMonth` 无下界（`:111-120`），可翻至任意历史空月（接口正常返回全 0 格子），是否需限制到入驻月**待确认**（现状事实）。
  3. `onLoad` 只在首次进入执行；页面驻留跨日（如挂后台过夜）后再 onShow，游标月份与 `isToday` 沿用旧值——`loadMonth` 会用 `new Date()` 重算 `isCurrentMonth`（`:46`）但 `todayStr` 也在 `buildCells` 内重算（`:83`），跨月驻留时游标不自动进位；现状事实，是否有实际影响**待确认**。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/calendar`（**4 个提交**），全部在 `docs/迭代记录.md` 有对应条目（按提交号逐一核对存在）。按时间倒序；除注明外，各提交对本文件的具体 diff 未逐一核对，以提交信息与该条目为据。

### 2026-10-15（`b5aa5d2`）
- 需求：修复日历详情弹层「点亮节点」长文本整盒换行掉行。
- 修改内容（涉本文件）：`.detail-value` 显式块级化 + 限宽断行（`calendar.wxss:245-253`，`:245` 注释与修复一致）；配套测试报告 `frontend/test/docs/calendar-detail-layout-report.md`、脚本 `frontend/test/automator/calendar-detail-layout.cjs`（grep 命中，范围含 calendar.wxml/.wxss）。
- 测试结果：见 `docs/迭代记录.md` 的 `b5aa5d2` 条目。

### 2026-10-11（`e70b59f`、`01e214a`）
- 需求：小程序代码审查修复批次（`e70b59f`：并发请求守卫、精简 setData 与列表 key 等）；V1.0 启动页自动登录并取消强制选组织（`01e214a`）。
- 修改内容（涉本文件）：`_requestId` 请求序号守卫现行形态（`:47-49`、`:60`、`:69`）；onShow 守卫 reLaunch launch（`:36-42`）。条目未逐项列出本文件改动，细节以提交信息为据。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f`、`01e214a` 条目。

### 2026-10-02（`7e587c9`）
- 需求：小程序页面高级化升级（首页重组/档案/**行军日历**/到达动画/情报化/勋章墙）。
- 修改内容（涉本文件）：创建 calendar 页四件套（后端接口 `18c2121` 已先行备好，`.qoder/frontend/services/sport.js.md` §10 同批记录 `getCalendar` 新增）。
- 测试结果：见 `docs/迭代记录.md` 的 `7e587c9` 条目。
