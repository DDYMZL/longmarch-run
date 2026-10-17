# sport-records.js（页面级合一：运动记录页）

> 本文档为「页面级合一」文档（`.qoder/README.md` §1），覆盖 `frontend/pages/sport-records/` 四件套：`sport-records.js`（41 行）、`sport-records.wxml`（30 行）、`sport-records.wxss`（73 行）、`sport-records.json`（5 行），合计 149 行。

## 1. 文件路径

`frontend/pages/sport-records/sport-records.js` + 同目录 `.wxml` / `.wxss` / `.json`；在 `frontend/app.json:12` 注册（非 tab 页）。

## 2. 文件职责

「最近 30 天每日步数」只读列表页（docstring `sport-records.js:1-3`）：顶部汇总卡（总累计步数 / 平均每日步数）+ 每日步数横条列表。数据全部来自 `services/sport.js` 的 `getRecent(30)`，页面只做反转、求和与均值计算，无写操作、无 Storage、无定时器/动画/监听器（全文核实，故无 `onHide`/`onUnload` 清理需求）。

## 3. 业务需求

- 随项目初始提交 `a94e685`（2026-09-30）创建（Mock 期）；`6a24562`（2026-10-01）服务层切真实接口时本页改异步加载（js +15/-9，`git show --stat` 实测；`docs/迭代记录.md` 的 `6a24562` 条目）。
- 「我的」页与档案页成就六格「连续」格的步数明细落地页（入口清单见 §6）。

## 4. 核心功能（sport-records.js）

### 4.1 生命周期

`onShow`（`:14-21`）：登录守卫——`app.globalData.loggedIn` 为假即 `wx.reLaunch('/pages/launch/launch')`（`:16-18`，`frontend/AGENTS.md` §4 不变量 5 的子页自守卫）；已登录则 `refresh()`。符合不变量 1「数据展示页必须 onShow + refresh」。无 `onLoad`/`onHide`/`onUnload`。

### 4.2 `data` 字段（`:8-12`）

| 字段 | 说明 |
|---|---|
| `records` | 每日记录数组，**从新到旧**（`:9` 注释），元素为服务层原样返回的 `{date, steps, text}`（`.qoder/frontend/services/sport.js.md` §4.9） |
| `totalSteps` | 30 天窗口内步数总和 |
| `avgSteps` | 有步数天的日均值（§7 规则 2） |

### 4.3 `refresh()`（`:23-40`）

`sport.getRecent(30)`（接口契约与失败出口见 §5）成功：`result.reverse()` 转为新→旧（`:27`，后端返回从旧到新）；`reduce` 求和（`:28`）；`avgSteps = sum ÷ steps>0 的天数`（四舍五入，无有效天则 0，`:29`、`:34`）；一次 `setData` 写入三字段（`:31-35`）。失败：**静默清空**为 `records:[], totalSteps:0, avgSteps:0`（`:37-39`），无 toast/错误文案——错误态与真实无记录共用同一空状态（§9 已知事项 1）。

### 4.4 取数策略（对照根 `agents.md` §2.4）

**不分页、一次性拉取，但为固定 30 天有界窗口**：`n=30` 由页面写死（`:25`），后端对 `n` 强制 `Query(ge=1, le=90)` 上界（`.qoder/frontend/services/sport.js.md` §4.9），列表最多 30 行——不属于「大数据量长列表」场景，未做分页/虚拟滚动是可接受的现状，非违规。无下拉刷新（§4-3），刷新仅靠 onShow 重拉。

## 4-1. WXML 专章（sport-records.wxml，30 行）

汇总卡两格（`:3-12`）；列表卡标题「最近 30 天」（`:16`），`records.length > 0` 时 `wx:for` 渲染行（`:18`，`wx:key="date"`，date 唯一，符合 `frontend/AGENTS.md` §5.2），每行 = 日期文案 `{{item.text}}`（`:20`，服务层预格式化，WXML 无原生方法调用）+ 步数横条（内联 `style="width: {{item.steps > 0 ? (item.steps / 12000) * 100 : 0}}%"`，`:23`）+ `{{item.steps}} 步`（`:25`）；空状态「暂无运动记录，去首页同步步数吧」（`:28`）。无 bindtap 交互、无跳转。

## 4-2. WXSS 专章（sport-records.wxss，73 行）

汇总卡红渐变横幅白字（`:6-11`，`#A00D26→#C8102E`，数值 44rpx `:18-21`）；列表卡 `margin-top:-20rpx` 叠压汇总卡（`:30-32`）；每行 flex：日期列 110rpx（`:45-49`）、横条轨道米色圆角 `overflow:hidden`（`:51-58`）、红色渐变条 `min-width:4rpx`（`:60-65`）、步数列 140rpx 右对齐（`:67-73`）。无动画/媒体查询，全部选择器均被 WXML 使用（对照核实，无死样式）。

## 4-3. JSON 专章（sport-records.json，5 行）

仅导航栏 3 项——标题「运动记录」、背景 `#C8102E`、白字（`:2-4`）。**无 `enablePullDownRefresh`**，页面也无 `onPullDownRefresh`/`onReachBottom` 处理函数（js 全文核实），下拉刷新与触底加载均未启用。无 `usingComponents`。

## 5. 输入与输出

- **入参**：无 query 参数。页面未定义 `onLoad`（`:14` 起仅有 `onShow`），两处入口的 `navigateTo` 均不带参数（入口清单见 §6）。
- **出参（唯一 service 调用）**：`sport.getRecent(30)`（调用点 `:25`）→ `GET /api/sport/recent?n=30`（服务层 `frontend/services/sport.js:130-132`；后端契约见 `.qoder/backend/app/api/routes/sport.py.md` 与 `.qoder/backend/app/services/sport_service.py.md` §4.12）。入参 `n=30`；返回 `Array<{date, steps, text}>`、**从旧到新**（服务层 JSDoc `frontend/services/sport.js:126-128`），页面 `reverse()` 转为新→旧（`:27`）。
- **渲染输出**：`data` 三字段（清单与口径见 §4.2）→ 汇总卡两格数值（`sport-records.wxml:5`、`:9`）与最多 30 行列表（`wxml:18-26`：日期文案、横条宽度、步数）。
- **错误/空态**：请求 reject → 静默清空三字段（`:37-39`）→ 渲染空状态「暂无运动记录，去首页同步步数吧」（`wxml:28`），用户无法区分失败与无记录（§9 已知事项 1）；401/403 等由 `request.js` 链在到达本 catch 前统一处理（静默重登/活动拦截跳转，`.qoder/frontend/services/request.js.md` §4.9）。页面无 toast、无错误文案，也无下拉刷新/触底加载出口（§4-3）。

## 6. 依赖关系

- **require（`:4-5`，2 项全部有使用）**：`app = getApp()`（仅读 `globalData.loggedIn`，`:16`）、`services/sport`（仅用 `getRecent`，`:25`）。页面零直接 `wx.request`、零 Storage 读写、零跳转（分层与禁止行为见 `frontend/AGENTS.md` §3.1/§6.5）。
- **被依赖（入站，grep `pages/sport-records` 全仓实测，2 处）**：「我的」tab 页 `frontend/pages/mine/mine.js:92`；档案页成就六格「连续」格 `frontend/pages/profile/profile.js:118`（对应 `.qoder/frontend/pages/profile/profile.js.md` §4.4 的 `streak` 路由）。
- **上游后端**：`GET /api/sport/recent`（路径与契约见 §5）；前端不触库。

## 7. 业务规则

1. **窗口口径**：页面标题「最近 30 天」（`sport-records.wxml:16`）与 `getRecent(30)` 一致；窗口按后端 `/sport/recent` 的自然日口径（后端实现见 `.qoder/backend/app/services/sport_service.py.md` §4.12）。
2. **「平均每日步数」= 总和 ÷ 有步数（steps>0）的天数**（`:29`、`:34`），不是除以 30——只运动过 2 天时均值按 2 天算；标签文案（`wxml:10`）未注明该口径，属展示语义与计算语义的细微差（事实陈述）。
3. **汇总仅覆盖 30 天窗口**：`totalSteps` 标签为「总累计步数」（`wxml:6`），实际是窗口内总和，与「我的」页/档案页的全量累计步数（后端 summary 口径）**不是同一数字**（事实陈述，改动时勿混淆）。
4. 数据只读、以后端为准，无本地造数（不变量 2）；页面不直接发请求（不变量 §3.1 分层）。

## 8. 修改约束

1. **`result.reverse()`（`:27`）不可去掉**：后端契约返回从旧到新，去掉反转列表即倒序；该调用就地修改服务层返回的数组，若将来复用同一结果需注意副作用。
2. **展示字段一律预处理**：`item.text` 由服务层预格式化（`.qoder/frontend/services/sport.js.md` §4.9），WXML 表达式不得引入原生方法调用；`wx:key="date"` 依赖 date 在窗口内唯一，不得改用 index（`frontend/AGENTS.md` §5.2）。
3. **失败静默清空是现行行为**（`:37-39`）：若将来补错误态，必须与「暂无记录」空状态区分，否则用户仍无法判断（§9 已知事项 1）。
4. **横条宽度基准 12000 写死在 WXML**（`sport-records.wxml:23`），与今日目标常量不同源（差异见 §9 已知事项 2）；调整任一侧都需两处同步核对。
5. **`refresh()` 现无请求序号守卫**（`:23-40`）：现状因数据幂等可接受（§9 已知事项 3），若引入可变窗口、分页或写操作须重新评估并补守卫。

## 9. 当前实现状态

- **已实现**：30 天列表 + 汇总 + 空状态 + 登录守卫；随 `a94e685`/`6a24562`/`01e214a` 演进（§10）。
- **存在问题 / 已知事项（事实陈述）**：
  1. 请求失败静默清空（`:37-39`），用户无法区分「网络失败」与「暂无记录」，也无重试入口（只能退出重进触发 onShow）。`6a24562` 提交信息称各页面「补错误提示」，本页现行代码无错误提示——以代码为准。
  2. 横条宽度按 `steps / 12000` 折算（`wxml:23`），超过 12000 步时宽度 >100%，由 `.record-bar-wrap` 的 `overflow:hidden` 裁切（`wxss:56`）；12000 为写死的展示基准，与今日目标 20000（`services/sport.js` `DAILY_TARGET`）不一致，是否有意**待确认**。
  3. `refresh()` 无并发竞态守卫（请求序号）：onShow 快速连触时旧响应可能覆盖新响应；本页数据幂等（同窗口同结果），实际影响可忽略（对照 `e70b59f` 批次只为首页等页加守卫）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/sport-records/`（**3 个提交**）与 `docs/迭代记录.md` 对应条目。按时间倒序。

### 2026-10-11（`01e214a`）
- 需求：V1.0 启动页自动登录。
- 修改内容（本页，diff 实测）：未登录守卫 reLaunch 目标由 `/pages/login/login` 改为 `/pages/launch/launch`（1 行，`:17`）。
- 关联文件：`pages/launch/launch`、`services/auth.js`、`services/request.js` 等。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目。

### 2026-10-01（`6a24562`）
- 需求：服务层由本地 Mock 切换为后端真实接口，页面改异步加载。
- 修改内容（本页）：js +15/-9（`git show --stat` 实测），`refresh` 改走 `sport.getRecent` Promise 链（现行 `:23-40` 结构）；逐行细节以 `git show 6a24562 -- frontend/pages/sport-records/` 为准，`docs/迭代记录.md` 的 `6a24562` 条目仅一句概述。
- 关联文件：全部 `services/*.js` 与各页面。
- 测试结果：该条目未记录验证字段，**待确认**。

### 2026-09-30（`a94e685`）
- 需求：项目初始化（P0 前端从零搭建）。
- 修改内容（本页）：创建四件套（Mock 数据源，后由 `6a24562` 切换）。
- 关联文件：仓库初始代码全量。
- 测试结果：**待确认**（`docs/迭代记录.md` 的 `a94e685` 条目仅「仓库初始代码」）。
