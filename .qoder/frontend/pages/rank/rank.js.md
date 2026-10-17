# rank.js（页面级合一：rank.js / rank.wxml / rank.wxss / rank.json）

## 1. 文件路径

- `frontend/pages/rank/rank.js`（117 行）
- `frontend/pages/rank/rank.wxml`（114 行）
- `frontend/pages/rank/rank.wxss`（498 行）
- `frontend/pages/rank/rank.json`（8 行）

**tabBar 页**（「排行」tab，`frontend/app.json:61-65`）。按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

全员工总积分排行榜页（V2.0）：前 3 名金银铜领奖台（2-1-3 排布）+ 第 4~10 名荣誉卡 + 第 11 名起触底加载分页列表；本人在任一区域高亮，名次在 10 名以外时底部常驻「我的名次」条（docstring `rank.js:1-5`）。页面只做渲染与分页控制，排名口径全部在后端（`frontend/services/rank.js:2`「与管理端排名同口径」）。

## 3. 业务需求

- 现行为 V2.0「积分排行榜」形态：`44eb77b`（2026-10-13）交付——「排行榜改为积分榜，与 PC 同源：前 3 名金银铜领奖台，4–10 名荣誉卡，11 名起分页触底加载；本人排名在 10 名以外时底部常驻『我的排名』条」（`docs/迭代记录.md` 的 `44eb77b` 条目）。
- 此前形态：`a94e685`（init，Mock）→ `6a24562` 切后端真实接口（各页面改异步加载并补错误提示）→ `b0fd8b2` Mock 切真实后端批次（各条见 `docs/迭代记录.md` 对应条目；对本页的逐文件改动以提交信息为据）。
- 后端契约（`GET /api/rank/points` 分页、top/list/me 切分、排序键）见 `.qoder/backend/app/api/routes/rank.py.md` §4；总积分=步行+答题的台账口径见同文 §7 第 3 条。

## 4. 核心功能（rank.js）

### 4.1 模块常量与视图函数（`:9-28`）

| 名称 | 行号 | 用途 |
|---|---|---|
| `PAGE_SIZE = 20` | `:9` | 第 11 名起的每页条数（后端上限 50，`.qoder/backend/app/api/routes/rank.py.md` §4.1） |
| `PODIUM_ORDER = [1, 0, 2]` | `:11` | 领奖台展示顺序：亚军-冠军-季军（2-1-3 排布） |
| `MEDALS = ['gold','silver','bronze']` | `:12` | 按 top 数组下标（即名次-1）挂奖牌样式类 |
| `toView(item)` | `:15-28` | 榜单项 → 展示字段裁剪（10 个字段 + `initial` 昵称首字兜底、`orgName` 空值兜底「未选择组织」），docstring 自述「只保留渲染所需，减小 setData 体积」 |

### 4.2 `data` 状态字段（`:31-41`，按关注点分组）

| 分组 | 字段 | 说明 |
|---|---|---|
| 加载态 | `loading`（初始 true）、`errorMsg` | 首屏骨架 / 错误态二选一 |
| 榜单 | `podium`（前 3，含 `medal` 字段）、`elite`（第 4~10）、`list`（第 11 名起已加载部分）、`me`（本人条目或 null） | 均为 `toView` 后的视图对象；`podium` 项在 `:64` 经 `Object.assign` 附加 `medal` |
| 分页 | `total`（参与人数）、`hasMore`、`loadingMore` | 由后端响应回填（`:68-69`、`:97`） |

**实例字段（不进 data，不参与渲染）**：`this._requestId`（并发请求序号守卫，`:53-54`）、`this._page`（当前页码，`:60`、`:88`、`:95`）。

### 4.3 生命周期与清理

- `onShow`（`:43-49`）：登录守卫——`!app.globalData.loggedIn` 时 `wx.reLaunch('/pages/launch/launch')` 并 return（`frontend/AGENTS.md` §4 不变量 5）；随后 `refresh()`（不变量 1「数据展示页必须 onShow + refresh()」）。tabBar 页每次切回都重拉第 1 页。
- **无 `onLoad/onHide/onUnload`**：页面无 JS 定时器、无 Canvas、无事件监听器（全文仅 `wx.showToast`/`wx.stopPullDownRefresh`/`wx.reLaunch` 三个 wx API），无需清理；入场动画为纯 WXSS CSS 动画（§4-2），由渲染层随视图销毁，且带 `prefers-reduced-motion` 降级。

### 4.4 `refresh()`（`:52-82`）——首屏/重拉第 1 页

1. 请求序号守卫：`_requestId` 自增，响应回来时序号不一致直接丢弃（`:53-54`、`:58`、`:73`；并发守卫由 `e70b59f` 审查批次引入，`docs/迭代记录.md` 的 `e70b59f` 条目）。
2. 调 `rank.getPointsRank(1, PAGE_SIZE)`（`:56`）→ 后端 `GET /api/rank/points?page=1&page_size=20`（`.qoder/frontend/services/rank.js.md` §4）。
3. 成功：`top` 前 3 名按 `PODIUM_ORDER` 重排并过滤空位（`:64`，不足 3 人时领奖台缺位不报错）、`elite = top.slice(3)`（`:65`）、`list/me/total/hasMore` 回填（`:66-69`），`_page` 复位 1（`:60`）。
4. 失败分层（`:72-81`）：**已有榜单数据时保留旧数据只 toast**「排行榜刷新失败，请稍后重试」；首屏失败才置 `errorMsg` 错误态（`e70b59f` 条目「失败时保留旧数据」）。
5. 返回 Promise，供 `onPullDownRefresh` 串接（`:110`）。

### 4.5 `onReachBottom()`（`:85-107`）——触底加载下一页

- 前置拦截：`!hasMore || loadingMore || loading` 直接 return（`:86-87`）。
- 加载 `this._page + 1` 页，沿用当前 `_requestId`（下拉刷新发生后旧翻页响应作废，`:89`、`:94`）。
- **追加式 setData**：以 `patch['list[' + (start + i) + ']']` 路径键逐项写入，避免整表重发（`:96-101`，docstring `:84`「追加写入，避免整表 setData」）。
- 失败：复位 `loadingMore` + toast「加载失败，请上拉重试」（`:103-106`）。

### 4.6 `onPullDownRefresh()`（`:109-111`）与 `handleRetry()`（`:113-116`）

- 下拉刷新（`rank.json:7` `enablePullDownRefresh: true` 开启）：`refresh()` 完成后 `wx.stopPullDownRefresh()`。
- 错误态「重新加载」按钮：置回 `loading` 骨架并 `refresh()`（wxml `:35` 绑定）。

## 4-1. WXML 专章（rank.wxml，114 行）

- 根节点条件类 `with-me-bar`（`me.rank > 10` 时给底部常驻条留白，`:1`）。
- **Hero 区**（`:3-23`）：标题「长征步迹 · 荣耀征程」、副题「总积分 = 步行积分 + 答题积分 · 全员工同榜」；`my-strip` 三格：我的名次 / 我的总积分 / 参与人数（`total`），`me` 为 null 时名次显 `-`、积分显 0（`:9`、`:14`）。
- **四态分支**：`loading` 骨架（`:25-30`）→ `errorMsg` 错误态含重试按钮（`:32-36`）→ `podium.length === 0` 空态「暂无排名数据，同步步数或完成答题即可上榜」（`:38-41`）→ 正常内容 `block wx:else`（`:43-99`）。
- **领奖台**（`:45-60`）：`wx:for="{{podium}}" wx:key="userId"`，冠军加 👑（`:47`）；头像有 `avatar` 用 `<image lazy-load>`、否则昵称首字占位（`:49-50`）；本人加 `is-me` 类与「我」标签（`:46`、`:52`）；底座显名次与冠/亚/季军文案（`:55-58`）。
- **荣誉卡**（`:63-78`）：第 4~10 名，比列表行多一行积分拆分「步行 x · 答题 y」（`:74`）。
- **分页列表**（`:81-95`）：第 11 名起，行结构同荣誉卡但无拆分行；`load-tip`（`:96-98`）三态文案：`loadingMore`→「加载中…」/ `hasMore`→「上拉加载更多」/ 否则「— 已显示全部 —」。
- **底部我的名次条**（`:102-113`）：`me && me.rank > 10 && !loading` 才渲染，展示名次/头像/昵称/步行答题拆分/总积分。
- 全部列表 `wx:key="userId"`（唯一字段，非 index，`frontend/AGENTS.md` §5.2）；表达式无原生方法调用（`initial`/`orgName` 兜底已在 js `toView` 预处理）。

## 4-2. WXSS 专章（rank.wxss，498 行）

- 页面底色 `#F7F1E5`（`:4`，同全局背景）；`with-me-bar` 时 `padding-bottom: 180rpx` 防内容被常驻条遮挡（`:7-9`）。
- Hero 深红渐变 `#5C0716→#7D0B20→#B31230` + 金色文字 `#F8D477` + 纯装饰网格（`:12-32`）；`my-strip` 半透明卡片（`:51-89`）。
- 领奖台：`podiumUp` 0.6s 上浮入场动画，金/铜柱延迟 0.1s/0.2s（`:106-126`）；金银铜底座高度 170/130/110rpx、渐变配色（`:218-231`）；冠军头像 128rpx 带金色光晕（`:147-152`）。
- 荣誉卡/列表行：白底金边卡片、`is-me` 红边高亮 `#C8102E`（`:273-282`、`:369-373`）；数字列统一 `font-variant-numeric: tabular-nums` 对齐（`:73`、`:199`、`:349`、`:403`）。
- 底部 `me-bar`：`position: fixed` 深红渐变、`z-index: 10`（`:414-426`）。
- 骨架屏 `skShine` 1.4s 流光动画（`:451-471`）；`@media (prefers-reduced-motion: reduce)` 关闭全部动画（`:492-498`）。
- 长文本（昵称/组织名）统一 `ellipsis` 截断（`:174-192`、`:321-337`）。

## 4-3. JSON 专章（rank.json，8 行）

| 配置 | 值 | 说明 |
|---|---|---|
| `navigationBarTitleText` | 积分排行 | |
| `navigationBarBackgroundColor` | `#7D0B20` | 比全局 `#C8102E`（`app.json:30`）更深，与 Hero 渐变顶端同色 |
| `navigationBarTextStyle` / `backgroundTextStyle` | white / light | |
| `backgroundColor` | `#7D0B20` | 下拉刷新露出的窗口背景 |
| `enablePullDownRefresh` | true | `onPullDownRefresh`（`:109`）的开关 |

## 5. 输入与输出

- 输入：无页面参数（tabBar 页，`onLoad` 未定义、不读 `options`）。
- 输出：纯展示页，无回传；唯一请求为 `getPointsRank(page, pageSize)` → `GET /api/rank/points`，响应 `{top, list, me, page, pageSize, hasMore, total}`（`.qoder/frontend/services/rank.js.md` §5）。
- 错误路径：401 由 `request.js` 静默重登重试一次；活动结束/未开始时 GET 403（`X-Activity-Status`）被 `request.js` 防抖跳活动状态页（`.qoder/frontend/services/request.js.md` §4.9 第 1 步；后端闸门 `require_activity_view`，`.qoder/backend/app/api/routes/rank.py.md` §4.1）。

## 6. 依赖关系

- 依赖：`frontend/services/rank.js`（`:7`，唯一 service）；`getApp().globalData.loggedIn`（`:6`、`:44`）。**不读写 Storage、无任何缓存键**。
- 入口（grep 页面路径实测）：tabBar「排行」（`frontend/app.json:61-65`）；「我的」页 `frontend/pages/mine/mine.js:78` `wx.switchTab`；活动状态页 `frontend/pages/activity/activity.js:57` `wx.switchTab`。tabBar 页只能以 `switchTab` 进入。
- 跳出：本页无任何 `navigateTo/switchTab` 出口（除守卫 `reLaunch` 启动页），榜单行不可点击。
- 后端链路：`services/rank.js` → `request.js` → `GET /api/rank/points`（`rank_service.get_points_rank`，表 `points_log`/`daily_sport`/`users`/`orgs` 只读）——契约与排序规则见 `.qoder/backend/app/api/routes/rank.py.md` §4、§7。

## 7. 业务规则

1. **单一维度榜单**：只有「全员工总积分」一个榜，无步数榜切换、无组织筛选、无组织排名维度。后端两榜均为全员跨组织榜、无 org_id 过滤（`.qoder/backend/app/api/routes/rank.py.md` §4.3）。「组织排名 / 分组织积分对比」需求**已取消**（`.qoder/REQUIREMENTS.md` §7「排行榜」表与 §12「已废弃规则」表的「组织排名 / 分组织积分对比」行），故本页无组织维度属预期；同期「组织人数统计」重新纳入但落在管理端 orgs 树接口，与本页无关。
2. **名次与切分全在后端**：排序键（总积分降序→累计步数降序→user_id 升序）、无并列名次、`top` 恒返前 10、`me` 恒返本人真实名次、`total` 为全用户数（`.qoder/backend/app/api/routes/rank.py.md` §4.3、§7）；前端不排序不加工（`.qoder/frontend/services/rank.js.md` §7）。
3. **分页策略（大数据量性能，根 `agents.md` §2.4）**：第 11 名起每页 20 条触底加载，`has_more` 由后端 limit+1 探测；前端追加式 setData 路径键写入、榜单项经 `toView` 裁剪、头像 `lazy-load`——**不存在全量拉取或无界列表**。前 10 名（top）与本人（me）每次全量返回，规模恒定。
4. **刷新时机**：`onShow` 必刷（不变量 1）+ 下拉刷新 + 触底翻页三条路径共用 `_requestId` 守卫，晚到的旧响应一律丢弃。
5. **本人展示规则**：`me` 在领奖台/荣誉卡/列表内命中时 `isMe` 高亮（后端下发 `isMe` 字段）；名次 >10 时另加底部常驻条（`:102`）。

## 8. 修改约束

1. `top/list/me/hasMore/total` 字段名是与后端 `PointsRankOut` 的 camelCase 硬契约（`.qoder/frontend/services/rank.js.md` §8），改字段需三端同步（后端 routes/services/schemas + service + 本页）。
2. `page` 语义为「第 11 名起的页码」，top 10 不参与分页（`.qoder/backend/app/api/routes/rank.py.md` §8 第 3 条）——改 `onReachBottom` 页码逻辑时勿把 top 计入。
3. 不得移除 `onShow` 登录守卫与 `refresh()`（`frontend/AGENTS.md` §4 不变量 1、5）；不得给 WXML 表达式引入原生方法调用、`wx:key` 不得改 index（§5.2）。
4. `loading` 期间禁止触底翻页（`:87`）与 `me-bar` 渲染（wxml `:102`）的联动条件，改动需保持骨架/内容互斥。
5. 追加式 setData 的 `list[i]` 路径键写法（`:99`）依赖 `list` 只增不减；若引入「筛选后重排」需整表重置 `_page` 并回到 `refresh()` 路径。
6. 样式主色（导航栏 `#C8102E` 全局约定、本页导航特例 `#7D0B20`）与 `prefers-reduced-motion` 降级不得删除（`frontend/AGENTS.md` §5.2、rank.wxss `:492-498`）。

## 9. 当前实现状态

- **已实现**：领奖台/荣誉卡/分页列表/我的名次条/骨架/错误/空态/下拉刷新/触底加载/并发守卫齐备；随 `44eb77b` 通过 v2 自动化验收 14/14（`docs/迭代记录.md` 的 `44eb77b` 条目，含排行项）。
- **事实陈述（非缺陷）**：
  1. 榜单头像依赖后端 `users.avatar`；用户头像存在「选择后不上传后端」的架构级限制（`.qoder/PROJECT.md` §8「架构级限制」第 7 项），故实际展示以昵称首字占位（`toView` `:20-21`、wxml `:49-50`）为常态路径。
  2. 后端旧契约 `GET /api/rank/steps` 本页不消费、小程序无调用方（`.qoder/backend/app/api/routes/rank.py.md` §9 第 1 条），本页改造无需顾及。
  3. 列表未用虚拟滚动，但受分页约束（每页 20、触底追加），与根 `agents.md` §2.4 的「分页或虚拟滚动」要求以分页方式满足。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/rank`（7 个提交）与 `docs/迭代记录.md` 对应条目；早期提交对本页的逐文件改动仅以提交信息/台账摘要为据。按时间倒序。

### 2026-10-13（`44eb77b`）
- 需求：V2.0 积分排行榜（与 PC 同源积分榜）。
- 修改内容（涉本页面）：由步数榜改为积分榜现形态——领奖台/荣誉卡/分页触底/我的名次条/下拉刷新（`docs/迭代记录.md` 的 `44eb77b` 条目「排行与积分」段）。
- 关联文件：`frontend/services/rank.js`、后端 `app/api/routes/rank.py`（`2f3f333` 新增 `/rank/points` 分页契约）。
- 测试结果：`docs/迭代记录.md` 的 `44eb77b` 条目（`v2-miniprogram.cjs` 14/14，含排行项；报告 `frontend/test/docs/v2-miniprogram-report.md`）。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复（逻辑/冗余/大数据量性能）。
- 修改内容（涉本页面）：「排行榜刷新完成后再停 spinner，失败时保留旧数据」（台账原文）；并发请求序号守卫、头像 `lazy-load`、稳定 `wx:key` 等同批性能项亦落在本页现行代码（`:53-58`、`:75-77`，wxml `:46`、`:49`）。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目（`s16-review-smoke.cjs` 18/18）。

### 2026-10-11（`01e214a`）
- 需求：V1.0 启动页自动登录。
- 修改内容（涉本页面）：「各页登录守卫改为跳启动页；取消 home/march/quiz/rank/mine/login 的强制选组织」（台账原文），即现行 `onShow` 守卫 `reLaunch('/pages/launch/launch')`（`:44-46`）。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目。

### 2026-10-01（`6a24562` 与 `b0fd8b2`，同主题两提交）
- 需求：小程序由本地 Mock 切换为真实后端接口。
- 修改内容（涉本页面）：页面改异步加载并补错误提示（`docs/迭代记录.md` 的 `6a24562` 条目）；`b0fd8b2` 条目仅有标题行，细节以提交信息为据。
- 测试结果：`6a24562` 条目未记录针对本页的验证；`b0fd8b2` 条目无验证字段，待确认。

### 2026-09-30（`b0ba252`、`a94e685`）
- 需求：`a94e685` 项目初始化创建本页（当时为步数榜形态，由 `44eb77b` 台账「排行榜改为积分榜」反推）；`b0ba252`「强制已登录用户完成组织选择流程」触及本页（该强制流程后被 `01e214a` 取消）。两提交对本页的具体 diff 未逐行核对，以提交信息为据。
- 测试结果：`docs/迭代记录.md` 的 `a94e685` 条目无验证字段（待确认）；`b0ba252` 条目仅有标题行。
