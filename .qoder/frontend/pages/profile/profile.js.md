# profile.js（页面级合一：我的长征 · 个人档案页）

> 本文档为「页面级合一」文档（`.qoder/README.md` §1），覆盖 `frontend/pages/profile/` 四件套：`profile.js`（221 行）、`profile.wxml`（195 行）、`profile.wxss`（501 行）、`profile.json`（5 行），合计 922 行。

## 1. 文件路径

`frontend/pages/profile/profile.js` + 同目录 `.wxml` / `.wxss` / `.json`；在 `frontend/app.json:17` 注册（非 tab 页）。

## 2. 文件职责

**只读**的个人档案聚合展示页（页面 docstring `profile.js:1-7`）：头部（头像/昵称/组织/参与第 N 天/阶段称号）→ 荣誉卡（总积分/排名/步行与答题拆分）→ 核心数据 5+5 格 → 成就总览六格（点击直达详情）→ 数据画像五维雷达（Canvas 2D）→ 长征进度条 → 足迹地图（点击节点展开抵达详情）→ 历史数据区 → 长征足迹时间轴。

**本页无任何编辑能力**：不含表单、不改昵称/头像/组织——「个人信息编辑」链路不在本页（头像选择与持久化在登录链路的 `services/auth.js`，见 `.qoder/frontend/services/auth.js.md` 与 `frontend/AGENTS.md` §4 不变量 4、7；组织/昵称在 org-select 页）。本页头像仅是展示后端下发的 `summary.user.avatar`（`profile.wxml:9`，无头像时 🏃 占位 `profile.wxml:10`），页面 js 中无 `wx.chooseAvatar` / `FileSystemManager` 调用（全文核实）。

## 3. 业务需求

- 页面随「小程序页面高级化升级」批次创建（`7e587c9`，2026-10-02，`docs/迭代记录.md` 的 `7e587c9` 条目「首页重组/档案/行军日历…」）；聚合接口由后端同批 `18c2121` 交付（`.qoder/frontend/services/profile.js.md` §3）。
- 足迹地图卡对应需求 §7（P1-6，`ffd2570`）；成就六格与数据画像对应需求 §18 / §17（P1-7，`3202404`）——需求编号取自页面注释（`profile.js:39`、`:42`、`:21`）与提交信息。
- 荣誉卡为 V2.0「我的长征荣誉卡」（`44eb77b`，`docs/迭代记录.md` 的 `44eb77b` 条目内容第 3 段「『我的长征』新增荣誉卡」）。

## 4. 核心功能（profile.js）

### 4.1 入口与生命周期

| 钩子 | 行号 | 职责 |
|---|---|---|
| `onShow` | `:46-52` | 登录守卫：`app.globalData.loggedIn` 为假即 `wx.reLaunch('/pages/launch/launch')`（`:47-49`，不变量 5 的子页自守卫模式）；已登录则 `this.refresh()`。符合不变量 1「数据展示页必须 onShow + refresh」 |
| `onLoad` / `onHide` / `onUnload` | — | **均未定义**。本页无定时器、无动画帧循环、无事件监听器（全文核实），故无清理需求；Canvas 为一次性绘制（§4.5），每次 refresh 重绘前重置画布尺寸（`:142-143`） |

**入口页（grep `pages/profile/profile` 全仓实测）**：唯一 navigateTo 来源是「我的」tab 页 `frontend/pages/mine/mine.js:83`。注意 `profile.js:6` docstring 写「入口：行军日历」，与 grep 结果不符（calendar 页无跳转本页的代码），属注释滞后或笔误，**待确认**原意。

### 4.2 `data` 状态字段（`:31-44`）

| 分组 | 字段 | 说明 |
|---|---|---|
| 页面态 | `loading`（初始 true）、`errorMsg` | 三态渲染开关（WXML §4-1.1） |
| 聚合数据 | `summary` | 后端 `/profile/summary` 原样存放（user/stats/quiz/medals/points/portrait 六段被 WXML 与雷达消费） |
| 派生展示 | `stage` | 阶段称号，本地函数 `stageTitle(progress)` 计算（`:14-19`）：≥100「长征先锋」、≥60「铁血战士」、≥30「行军骨干」、否则「红军新兵」——**纯前端展示口径，不落库** |
| 派生展示 | `totalStepsText`、`distanceText` | `util.formatNumber(totalSteps)`、`totalDistance.toFixed(1)`（`:93-94`） |
| 时间轴 | `timeline` | `getTimeline(50)` 结果预格式化为 `{key, text, icon, timeText}`（`:62-67`）；`key` 为 `eventType_eventTime_i` 复合键（`e70b59f` 引入，见 §10）；icon 用 `util.eventIcon` |
| 足迹地图 | `footprints`、`fpSelected` | 已点亮节点链视图模型 `{id,name,icon,litDate,dayStepsText,cumStepsText,isLast}`（`:70-78`）；`fpSelected` 为当前展开详情的节点 id（0 = 全收起） |
| 成就总览 | `achievements` | 六格 `{key,icon,label,value}`（`:80-87`），key 同时是跳转路由选择键（§4.4） |

### 4.3 `refresh()`（`:54-103`）——三请求并发

`Promise.all`：① `profile.getSummary()`；② `profile.getTimeline(50)`；③ `march.getFootprints().catch(() => null)`（`:55-58`）——**足迹失败不阻塞档案主数据**（`:58` 注释），失败时 `footprints` 置空数组（`:70`）。成功一次性 `setData` 全部派生字段（`:88-97`，符合 `e70b59f` 批次「精简 setData」方向），回调里再画雷达（`:98`）。任一硬失败（①②）→ `loading:false` + `errorMsg:'档案加载失败，请稍后重试'`（`:100-102`）。**全量刷新策略：无乐观更新、无本地缓存**，每次 onShow 从后端重拉（服务层 `profile.js` 无缓存，`.qoder/frontend/services/profile.js.md` §6）。

累计快照为 0（历史回填数据）时 `cumStepsText` 展示「—」（`:76`，需求 §7.2/§7.3 注释）。

### 4.4 事件处理与出站跳转

| 处理函数 | 行号 | 行为 |
|---|---|---|
| `toggleFootprint(e)` | `:106-109` | 点击足迹节点：再点同一节点收起（`fpSelected` 置 0），否则展开该节点抵达详情（WXML `:152-165`） |
| `goAchievement(e)` | `:112-123` | 成就六格按 `data-key` 查导航表跳转：march→`/pages/calendar/calendar`（navigateTo）、route→`/pages/march/march`（**switchTab**，tab 页）、quiz→`/pages/quiz-records/quiz-records`、streak→`/pages/sport-records/sport-records`、medal→`/pages/medals/medals`、points→`goPoints()`；未知 key 不动作（`:122`） |
| `goPoints()` | `:125-127` | `/pages/points/points`（荣誉卡整卡 bindtap 也走它，WXML `:23`） |
| `goCalendar()` | `:212-214` | `/pages/calendar/calendar`（进度卡「行军日历 ›」链接） |
| `goNodeDetail(e)` | `:216-220` | `/pages/node-detail/node-detail?id=<id>`（当前/下一站节点 chip；id 为空直接 return） |

### 4.5 `drawPortrait()`（`:130-210`）——五维雷达 Canvas 2D

`wx.createSelectorQuery().in(this).select('#portraitCanvas')` 取 Canvas 2D 节点（`:134-138`，节点不存在直接 return `:139`）；按 `wx.getSystemInfoSync().pixelRatio`（`:141`）放大画布并 `ctx.scale(dpr)`（`:142-145`）后 `clearRect` 重绘。绘制内容：3 层五边形网格（外圈描边加深 `:156-166`）→ 5 条中心辐射线（`:167-175`）→ 数值多边形（红色 `#C8102E` 描边 + 16% 透明填充，`:177-188`）→ 顶点金色圆点（`:190-196`）→ 轴标签与分值文字（`:198-208`）。轴序常量 `PORTRAIT_DIMS`（`:22-28`）：行军/坚持/知识/路线/成就，自顶部顺时针（需求 §17.2 注释）；取值 `portrait[key]` 钳制 0..100（`:154`）。**仅呈现数据不做评价**（`:129` 注释，需求 §17.4）。无 `summary.portrait` 时整段跳过（`:132`）。一次性绘制，无 rAF/定时器。

## 4-1. WXML 专章（profile.wxml，195 行）

### 4-1.1 三态与结构

`loading` →「档案加载中…」（`:2`）；`errorMsg` → 错误文案（`:3`）；否则 `<block wx:else>` 渲染全部内容（`:5-194`）。卡片依次：头部（`:7-20`）、荣誉卡（`:23-46`，`bindtap="goPoints"`）、核心数据主 5 格 + 副 5 格（`:49-94`，副格用 `stat-grid-sub` 分隔）、成就六格（`:97-106`，`wx:for="{{achievements}}" wx:key="key"`）、雷达 `<canvas type="2d" id="portraitCanvas">`（`:111`）、长征进度（`:115-135`）、足迹地图（`:138-169`）、历史数据（`:172-178`）、时间轴（`:181-193`）。入场动画靠全局 `anim-card` 类 + 内联 `animation-delay`（`:49` 等，样式在 `frontend/app.wxss:300`，`cardIn` keyframes `app.wxss:169`）。

### 4-1.2 关键绑定与表达式

- 头像有无分支：`wx:if="{{summary.user.avatar}}"` image / 否则 🏃 占位（`:9-10`）。
- 进度条宽度内联样式 `width: {{summary.stats.progress}}%`（`:121`）。
- 下一站 chip：`summary.stats.nextNode` 存在显示「还差 N 步」，否则「🎉 已完成长征路线」（`:130-133`）。
- 足迹展开：`fpSelected === item.id` 控制详情块与圆点高亮（`:144`、`:152`）；链条连线用 `wx:if="{{!item.isLast}}"`（`:145`）。
- 两个空状态：足迹「还没有点亮任何节点…」（`:140`）、时间轴「暂无足迹，去运动或答题吧」（`:183`）。
- 时间轴 `wx:key="key"`（`:185`，复合键，符合 `frontend/AGENTS.md` §5.2「wx:key 勿用 index」）；表达式全部为属性访问/比较/算术，无原生方法调用（文案与格式化在 js 预处理，§4.2）。

## 4-2. WXSS 专章（profile.wxss，501 行）

分区：页面底（`:2-6`，米白 `#f5f3ee`）→ 头部红渐变横幅（`:8-75`，`#c8102e→#a00d24`，头像圆框、金/白 tag）→ 荣誉卡深红鎏金（`:78-191`，`honor-glow` 径向光斑 `:90-98`、排名圆环 `:128-139`、总积分 72rpx 金字 `:163-169`）→ 核心数据格（`:194-237`）→ 成就六格 33.33% 宽 flex-wrap（`:240-269`）→ 雷达画布 600×600rpx（`:272-277`）→ 进度与节点 chip（`:280-320`）→ 历史数据行（`:323-342`）→ 时间轴（`:345-382`）→ 足迹链（`:385-501`，红点金晕 `.fp-dot.active` `:412-415`、渐变连线 `:417-422`、米金详情卡 `:453-459`）。数字用 `'DIN Alternate'` 字体族（`:262`、`:450`、`:465`、`:494`）。

**已知冗余（全文对照 WXML 核实）**：`.sub-cell`/`.sub-num`（`:227-237`）、`.route-bar`/`.route-text`（`:286-295`）、`.history-label`/`.history-value`（`:335-342`）共 6 个选择器在 `profile.wxml` 中无任何使用（副格实际复用 `stat-cell`/`stat-num`）；反向地，WXML `:124` 的 `.route-done` 在本文件与 `app.wxss` 均无规则，按默认块级渲染。属遗留死样式，未清理（清理属代码改动，超出建档范围）。

## 4-3. JSON 专章（profile.json，5 行）

仅 3 项导航栏配置：标题「我的长征」、背景 `#C8102E`、白字（`:2-4`）。无 `usingComponents`、**无 `enablePullDownRefresh`**（页面也未定义 `onPullDownRefresh`，下拉刷新不生效；刷新依赖 onShow）。

## 5. 输入与输出

- **入参**：无 query 参数。页面未定义 `onLoad`（全文核实，生命周期见 §4.1），唯一入口 `frontend/pages/mine/mine.js:83` 的 `navigateTo` 不带任何参数。
- **出参（页面调用的 service 与后端路径）**：

| service 调用 | profile.js 行号 | 入参 | 后端路径（service 源码行号） | 返回结构与页面消费 |
|---|---|---|---|---|
| `profile.getSummary()` | `:56` | 无 | `GET /api/profile/summary`（`frontend/services/profile.js:11`） | 六段聚合对象 `user/stats/quiz/medals/points/portrait`，原样存入 `data.summary`（`:91`）；逐字段清单见 §6 末条 |
| `profile.getTimeline(50)` | `:57` | `limit=50` | `GET /api/profile/timeline?limit=50`（`frontend/services/profile.js:21`） | 服务层已兜底为数组（`frontend/services/profile.js:22` 取 `result.items`，缺失则空数组）；元素为 `{eventType, eventTime, text, data}`（其 JSDoc `frontend/services/profile.js:17`）。页面只消费 `eventType`（→ icon）、`eventTime`（→ timeText）、`text`，**`data` 字段未被消费**（`:62-67`） |
| `march.getFootprints()` | `:58` | 无 | `GET /api/march/footprints`（`frontend/services/march.js:78`） | 页面取 `fpData.nodes`（缺失则空数组，`:70`），每节点消费 `id/name/icon/litDate/daySteps/cumSteps`（`:71-77`）；其余字段是否下发**待确认**（字段权威在后端 schema） |

- **渲染输出（data 字段 → WXML 区块）**：`loading`/`errorMsg` 三态开关（WXML `:2-3`）；`summary.user.*` 头部（`:7-20`）；`summary.points.*` + `stage` 荣誉卡（`:23-46`）；`totalStepsText`/`distanceText` 与 `summary.stats.*`/`summary.quiz.*`/`summary.medals.*` 核心数据 5+5 格（`:49-94`）；`achievements` 成就六格（`:97-106`）；`summary.portrait` → Canvas 雷达（`:111`，绘制流程见 §4.5）；`summary.stats.progress`/`currentNode`/`nextNode` 进度卡（`:115-135`）；`footprints`/`fpSelected` 足迹地图（`:138-169`）；`summary.quiz.totalCount` 与 `summary.medals.*` 历史数据（`:172-178`）；`timeline` 时间轴（`:181-193`）。
- **空态与错误出口**：加载中「档案加载中…」（WXML `:2`）；`getSummary`/`getTimeline` 任一 reject → `errorMsg = '档案加载失败，请稍后重试'`（`:101`，WXML `:3`，无重试按钮）；`getFootprints` 失败 → `footprints` 空数组 → 足迹空态（WXML `:140`）；`timeline` 为空 → 时间轴空态（WXML `:183`）；节点累计快照为 0 → `cumStepsText` 显示「—」（`:76`）；`summary.points.rank` 为假值 → 荣誉卡显示「--」（WXML `:32`）。401/403 由 request.js 链统一处理（静默重登重试 / 活动拦截跳转，`.qoder/frontend/services/request.js.md` §4.9），页面不感知。

## 6. 依赖关系

- **上游 service**（页面零直接请求、零 Storage 读写，符合 `frontend/AGENTS.md` §3.1/§6.5）：
  - `services/profile.js`：`getSummary()` → `GET /api/profile/summary`、`getTimeline(50)` → `GET /api/profile/timeline?limit=50`（`profile.js:56-57` 调用；契约见 `.qoder/frontend/services/profile.js.md` §4，后端见 `.qoder/backend/app/api/routes/profile.py.md`）。
  - `services/march.js`：`getFootprints()` → `GET /api/march/footprints`（`profile.js:58`；`.qoder/frontend/services/march.js.md` §4.4，后端见 `.qoder/backend/app/api/routes/march.py.md`）。
  - `utils/util.js`：`formatNumber` / `formatTime` / `eventIcon`（`profile.js:11`；源码 `frontend/utils/util.js:20`、`:37`、`:82`，文档 `.qoder/frontend/utils/util.js.md`）。
- **wx API**：`reLaunch`/`navigateTo`/`switchTab`、`createSelectorQuery`、`getSystemInfoSync`（仅雷达 dpr）。
- **被依赖（入站）**：`pages/mine/mine.js:83`（§4.1）。
- **summary 消费字段**（从 WXML/JS 实读归纳，字段权威在后端 schema）：`user{avatar,nickname,orgName,joinDays}`、`stats{totalSteps,totalDistance,sportDays,currentStreak,maxStreak,maxDaySteps,avgDailySteps,litCount,totalCount,progress,currentNode{id,icon,name},nextNode{id,name,remain}}`、`quiz{totalCount,correctRate,fullScoreCount}`、`medals{ownedCount,totalCount}`、`points{total,rank,walk,quiz}`、`portrait{march,persistence,knowledge,route,achievement}`。

## 7. 业务规则

1. **登录守卫**：onShow 检查 `globalData.loggedIn`，未登录 reLaunch 启动页、**不带 `?redirect=` 回跳参数**（`profile.js:47-49`）——回档案页需重新从「我的」进入；与不变量 5 一致。
2. **阶段称号阈值（30/60/100）是前端本地口径**（`:14-19`），后端无对应字段；四档称号仅用于头部 tag 与荣誉卡展示（`profile.wxml:17`、`:27`）。
3. **足迹卡降级语义**：`getFootprints` 失败时仅足迹区为空数组（`:58` 的 `.catch(() => null)` → `:70`），summary/timeline 主数据照常渲染，不整页报错。
4. **时间轴窗口口径**：限 50 条为服务层默认（`.qoder/frontend/services/profile.js.md` §7 第 2 条），非全量拉取，符合根 `agents.md` §2.4。

## 8. 修改约束

1. **成就六格 key→路由映射**（`:114-121`）与 WXML `data-key` 绑定；`route` 格目标是 tab 页必须 `switchTab`（`:116`），改成 navigateTo 会静默失败。
2. **`:58` 的 `.catch(() => null)` 不可移除**：足迹失败一旦 reject 冒泡进 `Promise.all` 的 catch，整页会显示「档案加载失败」（`:100-102`）。
3. **时间轴/足迹文案只读**：`text` 由后端事件服务统一产出（`.qoder/frontend/services/profile.js.md` §7 第 1 条），页面不得本地拼文案。
4. **camelCase 契约**：summary/portrait 字段名与后端 schema 硬绑定（`backend/AGENTS.md` §4.1），改字段需双端同步。
5. **雷达轴序与 `PORTRAIT_DIMS` 的 key 必须与后端 portrait 五维字段一致**（`:22-28`、`:154`），增删维度需双端同改。
6. **调整阶段称号阈值只改本页即可**；如需与后端/管理端对齐则属跨端变更，须双端同步。
7. Canvas 绘制逻辑一次性执行，若未来改为动画须补 onHide/onUnload 清理（当前无此需求，`frontend/AGENTS.md` §6.5 的清理约束暂不适用本页）。

## 9. 当前实现状态

- **已实现**：档案三态渲染、三请求并发刷新、荣誉卡、成就六格直达、五维雷达、足迹地图展开、时间轴；随 `7e587c9`/`ffd2570`/`3202404`/`44eb77b` 演进（§10）。
- **存在问题 / 已知事项（事实陈述）**：
  1. WXSS 6 个未使用选择器 + `.route-done` 无样式（§4-2）。
  2. docstring「入口：行军日历」与实际入口（仅「我的」页）不符（§4.1），**待确认**注释原意。
  3. `wx.getSystemInfoSync`（`:141`）为微信官方已拆分/不推荐的 API，当前仍可用；如需整改应换 `wx.getWindowInfo` 等（属代码改动，未做）。
  4. 错误态只有一行文案、无「重试」按钮，用户需退出重进触发 onShow（`profile.wxml:3`）。
- **待开发**：无（页面注释与提交历史中未见待办）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/profile/`（**6 个提交**）与 `docs/迭代记录.md` 对应条目。按时间倒序。

### 2026-10-13（`44eb77b`）
- 需求：V2.0「我的长征荣誉卡」。
- 修改内容：新增荣誉卡（js +9 / wxml +30 / wxss +116，`git show --stat` 实测；`docs/迭代记录.md` 的 `44eb77b` 条目「『我的长征』新增荣誉卡」），即现 `profile.wxml:23-46` 与 `profile.wxss:78-191`。
- 关联文件：`pages/points/points`（新增，荣誉卡跳转目标）等 V2.0 同批页面。
- 测试结果：提交信息自述「新增 v2 自动化验收（14/14）与报告」；细节见 `docs/迭代记录.md` 的 `44eb77b` 条目。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复批次。
- 修改内容（本页，diff 实测）：删除页内私有 `EVENT_ICONS`/`eventIcon`，改用 `util.eventIcon`；时间轴视图模型去掉冗余 `eventType` 字段、新增复合 `key`，`wx:key` 由 `eventType` 改 `key`（js -22 行净删）。
- 关联文件：`utils/util.js`（eventIcon 迁移目标）等多页。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-11（`01e214a`）
- 需求：V1.0 启动页自动登录。
- 修改内容（本页，diff 实测）：未登录守卫 reLaunch 目标由 `/pages/login/login` 改为 `/pages/launch/launch`（1 行）。
- 关联文件：`pages/launch/launch`、`services/auth.js`、`services/request.js` 等。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目。

### 2026-10-03（`3202404`）
- 需求：我的成就总览与数据画像（P1-7，需求 §17/§18）。
- 修改内容（涉本页）：新增成就六格（`achievements` + `goAchievement`）与五维雷达卡（`PORTRAIT_DIMS` + `drawPortrait` + canvas），消费后端画像五维评分接口（`docs/迭代记录.md` 的 `3202404` 条目「画像五维评分接口+档案页成就六格/雷达卡」，该条目无验证字段）。
- 关联文件：后端画像接口（见 `.qoder/backend/app/api/routes/profile.py.md`）。
- 测试结果：该条目未记录验证字段，**待确认**。

### 2026-10-03（`ffd2570`）
- 需求：我的长征足迹地图（P1-6，需求 §7）。
- 修改内容（涉本页）：新增足迹地图卡（`footprints`/`fpSelected`、`toggleFootprint`、fp-* 样式），消费后端足迹接口（`docs/迭代记录.md` 的 `ffd2570` 条目「足迹接口+档案页足迹地图卡」，该条目无验证字段）。
- 关联文件：`services/march.js`（`getFootprints`）、后端 march 路由。
- 测试结果：该条目未记录验证字段，**待确认**。

### 2026-10-02（`7e587c9`，11:13）
- 需求：小程序页面高级化升级（首页重组/档案/行军日历/到达动画/情报化/勋章墙）。
- 修改内容（涉本页）：创建档案页四件套（头部/核心数据/进度/历史数据/时间轴骨架；提交信息为唯一细化证据，`docs/迭代记录.md` 的 `7e587c9` 条目仅一句概述）。
- 关联文件：`services/profile.js`（同批创建，`.qoder/frontend/services/profile.js.md` §10）、`pages/calendar/` 等。
- 测试结果：见 `docs/迭代记录.md` 的 `7e587c9` 条目。
