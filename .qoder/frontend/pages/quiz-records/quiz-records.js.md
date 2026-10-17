# quiz-records.js（页面级合一：quiz-records.js / quiz-records.wxml / quiz-records.wxss / quiz-records.json）

## 1. 文件路径

- `frontend/pages/quiz-records/quiz-records.js`（41 行）
- `frontend/pages/quiz-records/quiz-records.wxml`（23 行）
- `frontend/pages/quiz-records/quiz-records.wxss`（49 行）
- `frontend/pages/quiz-records/quiz-records.json`（5 行）

子页（非 tabBar，`frontend/app.json:13` 注册）。按 `.qoder/README.md` §1「页面级合一例外」规则合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

答题历史记录页：把后端逐日答题记录渲染成一张表格——日期 / 答对题数 / 正确率 / 超时题数 / 答题积分（docstring `quiz-records.js:1-3`）。纯只读展示，无任何交互出口（除登录守卫）。

## 3. 业务需求

- 每日一题域的历史查询页；现行「超时/积分」列形态随 V2.0 逐题限时改造同步更新——「结果页展示答对数、正确率、答题积分、超时题数…答题首页与答题记录同步改造」（`docs/迭代记录.md` 的 `44eb77b` 条目）。
- 后端契约：`GET /api/quiz/records` 返回从新到旧的逐日记录列表（`.qoder/backend/app/api/routes/quiz.py.md` §5）。

## 4. 核心功能（quiz-records.js）

### 4.1 `data` 状态字段（`:8-10`）

仅 `records: []` 一个字段（表格行数组）。**无 loading / errorMsg 状态**：加载中与失败都表现为空列表（见 §4.3、§9）。

### 4.2 生命周期：仅 `onShow`（`:12-19`）

登录守卫——`!app.globalData.loggedIn` → `wx.reLaunch('/pages/launch/launch')` 并 return（`:13-17`，`frontend/AGENTS.md` §4 不变量 5）；随后 `refresh()`（不变量 1「onShow + refresh()」，从答题页返回时记录即时更新）。**无 `onLoad/onHide/onUnload`**：页面无定时器、无 Canvas、无监听器，无需清理。

### 4.3 `refresh()`（`:21-40`）

1. 调 `quiz.getRecords()`（`:22-23`）→ `GET /api/quiz/records`（`.qoder/frontend/services/quiz.js.md` §4 表第 5 行）。
2. 成功：`map` 裁剪为 7 个表格字段并预计算 `text = r.date.slice(5)`（月-日短日期，`:26-34`）——`slice` 在 js 侧完成，符合「WXML 不支持原生方法调用」（`frontend/AGENTS.md` §5.2）。注释自述「丢弃 wrongList 等明细，减小 setData 体积」（`:25`，字段精简由 `e70b59f` 批次落地，台账「答题记录字段精简」）；现行后端记录列表本就不含逐题 details（`.qoder/backend/app/api/routes/quiz.py.md` §5），`wrongList` 属对历史响应形态的防御性丢弃。
3. 失败：`catch` 静默置 `records: []`（`:37-39`），**无 toast、无错误态**——与空记录共用同一展示。

## 4-1. WXML 专章（quiz-records.wxml，23 行）

- 单卡片结构：全局 `card`/`card-title` 容器（`frontend/app.wxss:14`、`:22`）+ 标题「答题记录」。
- `records.length > 0` 时渲染表格：表头 5 列「日期/答对/正确率/超时/积分」（`:6-12`）；数据行 `wx:for wx:key="date"`（每日一行、日期唯一，`:13`），单元格依次为 `text`（月-日）、`correctCount/totalCount`、`accuracy%`（满分 100 时加 `full` 金色类，`:16`）、`timeoutCount题`、`+points`（`:14-18`）。
- 空态（`:21`）：「暂无答题记录，去完成今日答题吧」——纯文案，**无跳转按钮**，不可点击进入答题。
- 行无 `bindtap`：本页**不提供**逐题解析/回看入口；逐题结果与解析在 quiz-result / quiz-answer 页（`frontend/services/quiz.js` 的 `getDaily().record` 与 `answer().analysis` 消费方，`.qoder/frontend/services/quiz.js.md` §6）。

## 4-2. WXSS 专章（quiz-records.wxss，49 行）

flex 五列表格：日期列 `flex: 1.4`、数值列 `flex: 1` 居中（`:28-35`）；表头灰字下边框、数据行末行去线（`:12-26`）；正确率红色 `#C8102E` 加粗、满分转金 `#B8860B`（`:37-44`）；积分金色 `#D4A017`（`:46-49`）。无动画、无媒体查询。

## 4-3. JSON 专章（quiz-records.json，5 行）

`navigationBarTitleText: "答题记录"`；`navigationBarBackgroundColor: "#C8102E"` 与 `navigationBarTextStyle: "white"` 与全局 window 配置同值（`frontend/app.json:30-32`），属显式重复声明。未开启下拉刷新。

## 5. 输入与输出

- 输入：无页面参数（`onShow` 不读 options）。
- 输出：纯展示，无回传。请求 `getRecords()` 无参；响应为逐日记录数组（含 `date/totalCount/correctCount/accuracy/timeoutCount/points`，`.qoder/frontend/services/quiz.js.md` §4.4）。
- 错误路径：401 静默重登重试一次；活动结束/未开始时 GET 403（`X-Activity-Status`，后端 `require_activity_view`）由 `request.js` 防抖跳活动状态页（`.qoder/frontend/services/request.js.md` §4.9；`.qoder/backend/app/api/routes/quiz.py.md` §4.1）——该跳转发生在页面 catch 之前，页面自身不感知。

## 6. 依赖关系

- 依赖：`frontend/services/quiz.js`（`:5`，仅用 `getRecords`）；`getApp().globalData.loggedIn`（`:4`、`:14`）。**不读写 Storage、无缓存键**。
- 入口（grep 页面路径实测）：「我的」页菜单 `frontend/pages/mine/mine.js:96` `wx.navigateTo`；档案页菜单映射 `frontend/pages/profile/profile.js:117`。自动化测试经 mine 页第 3 项菜单进入（`frontend/test/automator/ui-test.cjs:713-715`）。
- 跳出：无（除守卫 `reLaunch` 启动页）；与 quiz / quiz-answer / quiz-result 页无直接跳转关系（§4-1）。
- 后端链路：`services/quiz.js` → `request.js` → `GET /api/quiz/records`（`quiz_service.get_records`，表 `quiz_records` 只读，`.qoder/backend/app/api/routes/quiz.py.md` §4.2、§6）。

## 7. 业务规则

1. **全量拉取、无分页（性能记录项）**：前端一次性取全部历史（`:22-23`），后端该端点也无分页参数（`.qoder/backend/app/api/routes/quiz.py.md` §5 输入「无」）。对照根 `agents.md` §2.4「大数据量性能保障」：列表规模 = 用户参与天数（每日一行），且后端已剔除逐题 details 控制体积（同文 §5），前端再做字段裁剪——当前活动周期内有界；若活动长期运行（数百天以上）该表会随行数线性增长，**是否需要分页/上限待确认**（现状如实记录，非已确认缺陷）。
2. 记录逐日一行、从新到旧（后端排序）；正确率/超时数/积分均由后端计算，前端零加工（`frontend/AGENTS.md` §4 不变量 2）。
3. `onShow` 必刷：完成当日答题后返回本页即见新行（不变量 1）。

## 8. 修改约束

1. 响应字段 camelCase 硬契约（`totalCount/accuracy/timeoutCount` 等），改动需后端 quiz 三处 + `services/quiz.js` + 本页同步（`.qoder/README.md` §3 规则 6）。
2. `text`（`date.slice(5)`）必须留在 js 侧预处理，不得移入 WXML 表达式（`frontend/AGENTS.md` §5.2）；`wx:key="date"` 依赖每日一行的唯一性。
3. 不得移除 `onShow` 登录守卫与 `refresh()`（不变量 1、5）。
4. 若给本页增加解析/回看入口，逐题明细需另调 `getDaily().record` 或新接口——`/quiz/records` 列表刻意不含 details（`.qoder/backend/app/api/routes/quiz.py.md` §5），不得要求后端在该列表加回明细。

## 9. 当前实现状态

- **已实现**：表格展示（5 列）、满分高亮、空态文案；随 V2.0 `44eb77b` 通过自动化验收（`docs/迭代记录.md` 的 `44eb77b` 条目，14/14）。
- **事实陈述（非缺陷登记）**：① 无 loading 态与错误提示——请求期间显示空态文案，失败静默清空（`:37-39`），用户无法区分「无记录」与「加载失败」；② 空态文案引导「去完成今日答题」但无跳转（§4-1）。
- **待确认**：长周期活动下全量拉取是否需要分页/条数上限（§7 第 1 条）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/quiz-records`（5 个提交）与 `docs/迭代记录.md` 对应条目；对本页的逐文件改动以提交信息/台账摘要为据。按时间倒序。

### 2026-10-13（`44eb77b`）
- 需求：V2.0 答题改逐题 90 秒限时。
- 修改内容（涉本页面）：「答题首页与答题记录同步改造」（台账原文）；现行「超时/积分」列与字段集即该批次形态。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（`v2-miniprogram.cjs` 14/14）。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复。
- 修改内容（涉本页面）：性能项「答题记录字段精简」（台账原文），即现行 `map` 裁剪 7 字段 + `text` 预计算（`:26-34`）。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目（`s16-review-smoke.cjs` 18/18）。

### 2026-10-11（`01e214a`）
- 需求：V1.0 启动页自动登录。
- 修改内容（涉本页面）：「各页登录守卫改为跳启动页」（台账原文），即现行 `onShow` 守卫（`:13-17`）。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目。

### 2026-10-01（`6a24562`）
- 需求：服务层切后端真实接口。
- 修改内容（涉本页面）：页面改异步加载（台账「各页面改为异步加载并补错误提示」；本页现行为 catch 静默清空，与「补错误提示」的差异属后续形态，未逐 diff 核对）。
- 测试结果：该条目未记录针对本页的验证。

### 2026-09-30（`a94e685`）
- 需求：项目初始化。
- 修改内容（涉本页面）：创建本页（初始为 Mock 数据源，由 `6a24562` 提交信息推知）。
- 测试结果：`docs/迭代记录.md` 的 `a94e685` 条目无验证字段（待确认）。
