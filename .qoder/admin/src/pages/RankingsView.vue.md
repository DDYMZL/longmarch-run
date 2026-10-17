# RankingsView.vue

## 1. 文件路径

`admin/src/pages/RankingsView.vue`（283 行）——注意位于 `pages/` 而非 `views/`（其余管理页均在 `views/`；该文件自创建即在 `pages/`，从未迁移，`.qoder/REQUIREMENTS.md` §11.5「RankingsView」行标注「来源 `81b86e5`，**原因未说明**」）。

## 2. 文件职责

「排名洞察」页（`<script setup>` 单文件组件）：全员征程排名的服务端分页列表（名次按总积分、同分按累计步数），含①5 张全员口径指标卡、②TOP 10 领跑者荣誉榜（1~3 名金银铜领奖台 + 4~10 名荣誉卡，不受筛选影响）、③关键词/组织/只看已改名三维服务端筛选、④行展开的节点轨迹、⑤行点击弹出的人员完整档案抽屉（运动/答题/勋章/长征/积分五块）、⑥按筛选条件的流式 CSV 导出、⑦积分台账核对与修复弹窗（先只读核对、二次确认后重算修复并写审计）。订阅 WebSocket `data_changed` 防抖重载当前页，是三个实时页中交互最重的一页。

## 3. 业务需求

- 需求出处：`.qoder/REQUIREMENTS.md` §11.5「其它管理页」`RankingsView` 行；排名口径与小程序排行榜同源（`.qoder/REQUIREMENTS.md` §7「排行榜」、§4「积分体系」——总积分 = 步行 + 答题，`legacy` 流水保留追溯但不计入，§12「旧版积分流水计入总积分」行）；导出规则见 §11.6「导出」「公式注入防护」两行。
- 演进（`git log --follow`，共 6 个提交）：`81b86e5`（2026-10-01）创建排名洞察页（全量拉取 + 前端筛选）→ `f820e0e`（2026-10-01）三端「昵称仅可修改一次」，本页展示改名记录 → `4e453a4`（2026-10-02）前端分页（大表整页渲染会卡死）→ `b5d6035`（2026-10-11）改服务端分页/筛选 + 流式 CSV 导出 → `30b4458`（2026-10-11）WS 防抖收口 + 统一格式化 → `e197a28`（2026-10-13）V2.0 排名积分化：总积分列/前 10 荣誉榜金银铜/积分核对修复。

## 4. 核心功能

### 4.1 路由与权限码

- 路由：path `/rankings`、name `rankings`、`meta.menu = 'rankings'`，AdminLayout 子路由懒加载本文件（`admin/src/router/index.ts:38-43`，`import('../pages/RankingsView.vue')` 在 `:41`）；侧边栏「排名洞察」+ `DataAnalysis` 图标（`admin/src/router/menus.ts:6`）。
- 前端守卫：`router/index.ts:112-116`；侧边栏过滤 `layout/AdminLayout.vue:15`。
- 后端守卫：本页 4 个接口全部挂 `require_menu("rankings")`——`GET /admin/rankings`（`backend/app/api/routes/admin.py:316`）、`POST /admin/points/verify`（`:332`）、`GET /admin/rankings/export`（`:350`）、`GET /admin/users/{id}/overview`（`:369`）。**积分核对/修复复用 `rankings` 菜单码**，无独立权限码。

### 4.2 状态与服务端分页加载（竞态守卫）

- 筛选态（`:10-15`）：`loading`、`exporting`、`keyword`（输入框即时值）、`appliedKeyword`（防抖后生效值）、`orgId`、`onlyChanged`。
- 数据态 `state`（`:16`）：`RankResult` 初始全 0/空数组（含 `total`、`total_steps`、`total_points`、`completed_users`、`avg_progress`、`match_total`、`org_options`、`route_nodes`、`podium`、`items`）。
- 派生：`averageSteps`/`averagePoints`（`:17-18`，全员口径 = 总量/总人数）；`podiumTop`（前 3）/`eliteCards`（第 4 名起）/`MEDAL` 类名表（`:20-22`）。
- 分页（`:25-27`）：`page`(1)、`pageSize`(**50**)、`filter` computed（keyword trim + org_id + only_changed）；`:24` 注释明确「服务端分页与筛选：人员基数大时只拉取、渲染当前页，指标与领奖台为全员口径」。
- `load`（`:29-46`）：`requestSeq` 竞态守卫（自增 `:31`、判等丢弃 `:35`、`finally` 判等关 loading `:44`）；**页码越界回退**——`items` 为空且 `page > lastPage`（按 `match_total` 算）时把 `page` 置回最后一页并 return（`:36-41`，由 watch 再触发一次加载），解决「筛选后数据变少停在空页」。
- 触发链（`:48-58`）：`keyword` 输入 300ms 防抖后写 `appliedKeyword`（`:48-55`）；`[appliedKeyword, orgId, onlyChanged]` 变化把 `page` 复位 1（`:56`）；`watch([page, pageSize, filter], load, {immediate: true})`（`:58`）——筛选变化与页码复位在同一轮 watcher flush 内合并，只发一次请求（`:57` 注释）；`immediate` 兼作首屏加载（`b5d6035` 起本页无 `onMounted`）。
- WS：`useLiveUpdates({ onDataChanged: load })`（`:61`）——`data_changed` 经 composable 内 800ms 合并防抖后重载**当前页**（`liveUpdates.ts:22`、`:35-39`）；本页不消费 `onActivity`。英雄区左侧 `ws-status` 圆点 + 三态文案（`:148`）。
- `onBeforeUnmount`（`:63-65`）清理关键词防抖定时器；WS 清理由 composable 托管（`liveUpdates.ts:104-105`）。

### 4.3 展示辅助函数

- `progress`（`:67`）：`completed_nodes/node_count` 取整百分比，`node_count=0` 回退 0。
- `initial`（`:68`）：头像回退字 = 昵称首字符，空昵称回退「员」。
- `time`（`:69`）：`formatDateTime(value, '尚未到达')`——UTC naive 经 `parseUtc` 补 `Z` 按浏览器本地时区渲染 YYYY/MM/DD HH:mm（`utils/format.ts:29-42`）；`30b4458` 前为页内私有 `TIME_FORMAT` + 手写补 Z 逻辑，已删除。
- `SOURCE_TEXT`（`:118`）：积分来源中文化 `walk`→步行、`quiz`→答题、`legacy`→旧规则（`legacy` 对应 `.qoder/REQUIREMENTS.md` §12「旧版积分流水计入总积分」行：保留追溯、不计入总积分）。

### 4.4 指标卡与荣誉榜

- 指标卡（`:151-157`）：参与人员/累计总积分(人均)/累计总步数(人均)/平均路线进度(节点数)/完成全程，图标 `User`/`Coin`/`Position`/`TrendCharts`/`CircleCheck` 以组件标签使用，均已在 `main.ts:42-74` 全局注册。全部为**全员口径**（后端 SQL 聚合），不随筛选变化。
- 荣誉榜（`:159-178`）：`v-if="state.podium.length"`；标题旁 `em`「总积分实时排名 · 不受筛选影响」（`:160`）。领奖台取 `podiumTop`（前 3），按 `MEDAL[rank-1]` 加 gold/silver/bronze 类（`:162`），冠军 `champion` 类 + `Trophy` 图标、其余 `Medal` 图标（`:163`），头像无图回退 `initial()`（`:164`），卡片含组织、总积分、步行/答题拆分与步数（`:165-167`）；CSS `order` 实现「2-1-3」领奖台排布（`:263`）。`eliteCards`（4~10 名）为荣誉卡网格（`:170-177`），名次 `padStart(2,'0')`。podium 由后端返回前 10（`e197a28` 后端同步扩容，`admin.ts:287` 注释）。
- 动效尊重系统偏好：`prefers-reduced-motion` 下关闭领奖台 hover 位移（`:282`）。

### 4.5 排名明细表（展开轨迹 + 行点击抽屉）

- 筛选控件（`:181`）：关键词输入（`Search` 前缀图标、clearable、300ms 防抖，后端按昵称或人员 ID 模糊匹配）；组织下拉（**选项来自响应的 `org_options`**，filterable + clearable，`@clear` 置 null）；「只看已改名」复选框（对应 `only_changed`）。
- 表格（`:182-191`）：`row-key="user_id"`、`empty-text="暂无人员数据"`、`@row-click="openOverview"`。列：
  1. `type="expand"`（`:183`）：节点轨迹——头部「已抵达 n/N」+ 进度条，`.track` 10 列网格逐节点渲染（到达=红底 `Check` 图标，未达=节点序号），每节点含名称/目标步数/`time(reached_at)`；
  2. 排名（`:184`）：`padStart(2,'0')` + 前三名金银铜着色；
  3. 人员（`:185`）：头像（回退 `initial`）+ 昵称 + **改名标签**（有 `nickname_changed_at` 时显示「改名」`el-tag`，tooltip 展示曾用名与修改时间，`:185`）+ ID；
  4. 所属组织（`:186`）：空显示「未分配组织」；
  5. 总积分（`:187`）：加粗分值 + 「步行 x · 答题 y」拆分；
  6. 累计步数（`:188`）；
  7. 路线进度（`:189`）：`el-progress` + 「n/N 节点」；
  8. 最近抵达（`:190`）：空值 `muted` 样式显示「尚未到达」。
- 分页器（`:192`）：`total=match_total`（筛选后总数），`page-sizes=[20,50,100,200]`（与后端 `page_size le=200` 上限对齐，`admin.py:320`），`layout="total, sizes, prev, pager, next"`——**是管理端少数带每页条数选择器的列表页**（对比 Audit/Access 固定 pageSize）。旁注「点击人员行查看完整档案」。
- `openOverview`（`:126-141`）：行点击开抽屉；先判点击目标在 `.el-table__expand-column` 内则放行展开、不开抽屉（`:127-128`）；记录 `overviewName`、清空旧数据、开抽屉后置 loading，`fetchUserOverview(row.user_id)`；**本页唯一带局部 `catch` 的加载**——失败 toast「人员详情加载失败」并关抽屉（`:135-137`）。
- 抽屉（`:195-236`，`size 560px`）：标题「X的完整档案」；五块——运动记录（今日/累计步数 + 近 N 日列表）、答题记录（日期 + 答对/总分/得分/积分）、勋章墙（图标/名称/描述/`time(granted_at)`）、长征记录（已抵达 n/N + 全部节点胶囊）、积分明细（总/步行/答题/全员排名 KPI + 流水列表：日期、`SOURCE_TEXT` 标签着色（quiz=warning、walk=danger、其余 info，`:231`）、reason、带正负号 delta）。各块空态为「暂无…」文案（`:207`、`:213`、`:219`、`:232`）。

### 4.6 CSV 导出（流式，服务端生成）

`exportData`（`:70-81`）：`match_total=0` 时 warning「当前没有可导出的排名数据」直接返回（`:71`）；`exporting` 锁 + 按钮 `:loading`（`:72`、`:148`）；调 `exportRankings(filter)`——**按当前筛选条件导出全量（不分页）**，`responseType:'blob'`、`timeout:0`（`admin.ts:299-301`）；`saveFile(data, 全员长征排名_<today()>.csv)` 落盘（`utils/download.ts:2-10`、`:20-23` 本地日期）；成功 toast 报 `match_total` 人数（`:74`、`:77`，见 §9 第 2 项）。后端为 `StreamingResponse` + 独立 Session + UTF-8 BOM + `QUOTE_ALL`（`admin.py:347-362`、`admin_service.iter_rank_csv:433-441`），单元格经 `_csv_text` 对 `= + - @` 开头前置单引号防公式注入（`admin_service.py:423-426`；`admin/agents.md`「开发约定」第 4 条、`.qoder/REQUIREMENTS.md` §11.6「公式注入防护」行）。文件名后端 `Content-Disposition` 也给了同名 UTF-8 编码（`admin.py:357-361`），前端 `saveFile` 用自己的文件名。

### 4.7 积分台账核对 / 修复弹窗

- 入口「积分核对」按钮（`Coin` 图标，`:148`）→ `openVerify`（`:111-116`）：清空上次结果、`verifyFixed=false`、开弹窗并立即跑一次**只读核对** `runVerify(false)`。
- `runVerify`（`:89-109`）：`verifying` 重入锁（`:90`）；`fix=true` 时先 `ElMessageBox.confirm`（warning、文案含将覆盖的不一致条数并声明「操作会记录审计日志」），**取消走 `catch { return }`（`:94-96`），无未处理 rejection**（优于 `AdminLayout.vue:17-21`/`AccessView` 删除角色的同场景写法）；随后 `verifyPoints(fix)`（POST，`timeout:0` 不超时，`admin.ts:307-309`）；修复成功后 toast「已修复 N 条」并 `load()` 刷新排名（`:102-105`）。
- 后端：`points_service.recompute_all(db, fix, user_ids)`（`admin.py:336`）按源数据（每日步数/答题明细）重算比对；`fix=true` 时写审计 `points.recompute`（含 operator 与 users/checked_days/fixed 计数）并 commit（`admin.py:337-343`）——该动作码在 `views/AuditView.vue` 的 `ACTION_TEXT` 有中文映射（points.* → primary 标签）。
- 弹窗（`:238-256`）：说明文案「核对为只读操作，确认后方可修复」（`:239`）；KPI 四格（核对人数/核对人日/不一致/已修复，`:242`）；无不一致时 `el-alert` success（文案区分「核对一致」与「修复完成」，`:243`）；有不一致时样本表（user_id/biz_key/expected/actual，`max-height 260`，`:244-249`）；底部「重新核对」/「修复不一致」——修复按钮 `:disabled="!verifyResult || !verifyResult.mismatches || verifyFixed"`（`:254`），**一次核对结果只允许修复一次**，修复后须重新核对；核对期间禁止点遮罩关闭（`:238` `:close-on-click-modal="!verifying"`）。

### 4.8 加载/空/错误态汇总

- 加载：整页 `v-loading="loading"`（`:145`）、抽屉 `v-loading="overviewLoading"`（`:196`）、核对弹窗 `v-loading="verifying"`（`:240`）、刷新/导出按钮 `:loading`（`:148`）。
- 空态：表格自定义 `empty-text`（`:182`）、荣誉榜整块 `v-if` 隐藏（`:159`）、抽屉各块「暂无…」、导出前空数据 warning（`:71`）。
- 错误态：仅 `openOverview` 有局部 catch（`:135-137`）；`load`/`exportData`/`runVerify` 均 `try…finally` 无 catch，失败依赖 `request.ts:46-48` 全局 toast 并产生未处理 rejection（§9 第 1 项）。

## 5. 输入与输出

- 输入：无 props / 无 emits。隐式输入为登录态（Bearer + WS token）、筛选/分页/行点击/弹窗操作、WS `data_changed` 消息。
- `api/admin.ts` 函数、类型与后端链路：

| 前端函数 | 方法与路径 | 请求/响应类型（行号） | 后端链路 |
|---|---|---|---|
| `fetchRankings`（`admin.ts:295-297`） | GET `/api/admin/rankings?page&page_size&keyword&org_id&only_changed` | `RankResult`（`:288`）、`RankItem`（`:286`）、`RankNode`（`:285`）、`RankFilter`（`:289`，经 `rankParams:291-293` 把空值转 `undefined`） | `admin.py:312-326`（`page_size` 默认 50 上限 200、`keyword max_length=64`）→ `admin_service.get_rank_overview`（`admin_service.py:375-383`：全员指标 + 前 10 荣誉榜（不受筛选影响）+ 当前页明细含节点到达时间） |
| `exportRankings`（`:299-301`） | GET `/api/admin/rankings/export`（blob、timeout 0） | `Blob`（CSV） | `admin.py:347-362` → `admin_service.iter_rank_csv`（`:433-441`，独立 Session 流式） |
| `verifyPoints`（`:307-309`） | POST `/api/admin/points/verify`，body `{fix}`（timeout 0） | `PointsVerifyResult`（`:305`：users/checked_days/mismatches/fixed/samples）、`PointsDiff`（`:304`） | `admin.py:329-344` → `points_service.recompute_all`；fix 时 `audit_service.record('points.recompute')` + commit |
| `fetchUserOverview`（`:280-282`） | GET `/api/admin/users/{userId}/overview` | `UserOverview`（`:271-278`）及 `OverviewUser`（`:202-210`）、`OverviewSport`（`:218-222`）、`OverviewQuizRecord`（`:224-231`）、`OverviewMedal`（`:233-239`）、`OverviewMarch`（`:249-253`）、`OverviewPoints`（`:263-269`，注释「与小程序同源：total = walk + quiz」） | `admin.py:365-376`（404「用户不存在」）→ `admin_service.get_user_overview`（`:489-496`） |

- 输出：CSV 文件（浏览器下载）；积分修复（`fix=true` 时后端重算台账并写审计）；其余为只读渲染。
- WS 输入：`{type:'data_changed'}`（`liveUpdates.ts:35-39`）。

## 6. 依赖关系

- 导入：`vue`（computed/onBeforeUnmount/ref/watch，`:2`）、`element-plus`（`ElMessage`/`ElMessageBox` 直接导入，`:3`；表格/分页/抽屉/弹窗/头像/进度条/标签/提示等由 `plugins/element-plus.ts` 注册）、`../api/admin`（4 函数 + 6 类型，`:4`）、`../utils/liveUpdates`（`:5`）、`../utils/format`（`formatDateTime`、`formatNumber as number`，`:6`）、`../utils/download`（`saveFile`/`today`，`:7`）。
- 图标：字符串引用 `'Refresh'`/`'Coin'`/`'Download'`/`'Search'` 与组件标签 `User`/`Coin`/`Position`/`TrendCharts`/`CircleCheck`/`Trophy`/`Medal`/`Check`，**全部已在 `main.ts:42-74` 全局注册**（逐一核对无缺）；新增图标须同步 `main.ts`。
- 被依赖：`admin/src/router/index.ts:41`（`/rankings` 懒加载）。
- 后端数据源：排名/档案聚合涉及用户、组织、路线节点进度、积分台账与每日步数/答题源数据（具体表与 SQL 见 `.qoder/backend/app/services/admin_service.py.md`）；核对修复走 `points_service`（`.qoder/backend/app/services/points_service.py.md`）；审计写 `audit_logs`（`.qoder/backend/app/services/audit_service.py.md`）。路由层文档 `.qoder/backend/app/api/routes/admin.py.md`。
- 关联页面：`views/DashboardView.vue`/`views/ScreenView.vue`（同用 `useLiveUpdates`；指标同源口径）；`views/AuditView.vue`（展示本页修复产生的 `points.recompute` 审计）；小程序 `pages/rank/rank`（排名同口径，`admin.ts:284` 注释「名次按总积分，与小程序同口径」）。

## 7. 业务规则

1. **排名口径**：总积分（步行+答题）降序，同分按累计步数（英雄区文案 `:147`、`admin.ts:284` 注释）；`legacy` 流水不计入总积分（`SOURCE_TEXT` 仅展示，`.qoder/REQUIREMENTS.md` §12）。
2. **全员口径 vs 筛选口径**：5 指标卡、荣誉榜前 10 为全员口径，不受 keyword/组织/改名筛选影响（`:24` 注释、`:160`、`admin_service.py:383` docstring）；明细表与 `match_total` 为筛选口径；导出跟随筛选、不跟随分页（§4.6）。
3. **权限**：需 `rankings` 菜单码；积分核对/修复、导出、人员档案共用该码（§4.1），无更细粒度按钮级权限。
4. **分页策略**：服务端分页（`page_size` 默认 50，前端可选 20–200，与后端 `le=200` 对齐，`admin.py:320`、`:192`）；筛选变化强制回第 1 页（`:56`）；空页自动回退最后一页（`:36-41`）。满足根 `agents.md` §2.4 大数据量要求（`b5d6035` 由前端全量过滤改造而来）。
5. **搜索防抖**：关键词 300ms（`:48-55`）；组织/改名筛选即时生效；所有变化经 watch 合并为单请求（`:57-58`）。
6. **实时刷新**：WS `data_changed` 800ms 合并后重载当前页（`:61`），保持用户所在页码与筛选；生产 WS 不可用见 `.qoder/ARCHITECTURE.md` §12.3（页面提供「刷新数据」按钮兜底，`:148`）。
7. **积分核对先读后写**：打开弹窗只跑只读核对；修复必须二次确认（文案声明覆盖条数与审计留痕，`:93`）；一次核对结果只允许修复一次（`verifyFixed` 禁用，`:254`）；修复写审计 `points.recompute`（`admin.py:337-343`）。
8. **改名记录**：昵称每人仅可改一次（`f820e0e` 三端规则），本页只读展示曾用名与修改时间（`:185`、`:200`「每人仅一次」文案），`only_changed` 筛选已改名人员。
9. **时区**：页面展示按浏览器本地时区（`utils/format.ts`）；**导出 CSV 内时间由后端按服务器本地时区渲染**（`admin_service._export_time:429-430` 用 `to_local`），两口径在服务器时区≠浏览器时区时会有差异。
10. **导出防护**：CSV 由后端流式生成，`QUOTE_ALL` + UTF-8 BOM + `_csv_text` 公式注入防护（§4.6）；前端不落任何用户明文到本地存储。

## 8. 修改约束

- **不得回退为前端全量过滤/分页**：`b5d6035` 的改造动机是「人员量大时不再全量加载与渲染」（提交信息原文）；`requestSeq` 守卫三处（`:31`、`:35`、`:44`）与空页回退（`:36-41`）必须成对保留。
- **watch 合并机制不可拆**：`:56` 的 page 复位与 `:58` 的统一加载 watch 依赖 Vue 同轮 flush 合并才做到「筛选变化只发一次请求」（`:57` 注释）；改成在筛选控件回调里直接调 `load` 会双请求。
- **CSV 注入防护在后端 `_csv_text`**（`admin_service.py:423-426`）：改导出列/新增导出接口必须复用；若未来改为前端拼 CSV，必须用 `utils/download.ts` 的 `csvCell`（`:13-17` 同款防护），二者不可都缺（`admin/agents.md`「开发约定」第 4 条）。
- **podium/指标的全员口径**不得与筛选耦合（后端聚合决定，前端 `:160` 文案是对外承诺）；荣誉榜前 10 的名额是前后端契约（`admin.ts:287` 注释 + `e197a28` 后端扩容），改名额须双端同改。
- **`RankItem`/`RankResult` 字段是前后端 snake_case 契约**（管理端约定 snake_case，与小程序 camelCase 不同，`.qoder/README.md` §3.6）：增删字段须同步 `backend/app/schemas/schemas.py`、`admin_service`、`admin.ts` 三处。
- 菜单码 `rankings` 四处一致：`router/menus.ts:6`、路由 `meta.menu`（`router/index.ts:42`）、后端 `require_menu("rankings")`（4 处）、DB `admin_menus`（`.qoder/admin/src/router/index.ts.md` §8 同一约束）。
- `verifyPoints`/`exportRankings` 的 `timeout: 0`（`admin.ts:300`、`:308`）不可改回默认超时：全员重算/流式导出在大库下耗时超过默认值。
- 修复类危险操作必须保留二次确认 + danger 按钮 + `verifyFixed` 单次修复限制（`:93`、`:254`）；`ElMessageBox.confirm` 必须保留 `catch`（`:94-96`），不得退化成 `AdminLayout` 式无 catch 写法。
- 时间显示继续走 `utils/format.ts`（`:6`、`:69`），不得恢复页内私有 `TIME_FORMAT`（`30b4458` 已删除一次）。
- 视觉：新增图标/EP 组件须同步 `main.ts` 与 `plugins/element-plus.ts` 按需注册（`element-plus.ts:3` 注释）；本页 `min-width:960px`（`:261`）+ 1280px 断点（`:265`），加列时注意总宽与窄屏横向滚动。

## 9. 当前实现状态

- **已实现**：服务端分页/三维筛选/防抖搜索、竞态守卫与空页回退、TOP10 荣誉榜（金银铜领奖台+荣誉卡）、节点轨迹展开、人员档案抽屉（五块聚合）、流式 CSV 导出、积分台账核对与修复（审计留痕）、WS 防抖重载、改名标记与筛选；历次浏览器验收见 §10（s15、s16、v2 报告及截图）。
- **已实现且符合规范**：服务端分页（根 `agents.md` §2.4）；CSV 公式注入防护（后端 `_csv_text`）；`confirm` 取消有 catch（`:94-96`）；抽屉加载有局部错误处理（`:135-137`）；本页引用的全部图标均已注册（§6）。
- **存在问题 / 已知事项**：
  1. **多数异步无 `catch`**：`load`（`:30-46`）、`exportData`（`:70-81`）、`runVerify` 的请求段（`:98-108`）均 `try…finally`，`watch(…, load)`/按钮点击处未 `.catch()`——失败产生未处理 Promise rejection（用户见全局 toast）。三实时页同模式。
  2. **导出人数文案可能与实际不符**：成功 toast 的 `count` 取点击时的 `match_total`（`:74`、`:77`），而导出接口在服务端重新查询——期间数据变化则文案人数 ≠ CSV 行数（轻微，展示层问题）。
  3. **blob 错误响应展示待确认**：`exportRankings` 为 `responseType:'blob'`，HTTP 失败时错误体也是 Blob，全局 toast（`request.ts:46-48`）能否解析出 `detail` **待确认**（需读 `request.ts` 错误分支对 blob 的处理或实测一次导出失败）。
  4. `openOverview` 依赖 Element Plus 内部类名 `.el-table__expand-column` 过滤展开列点击（`:127-128`）：组件库升级改类名会导致「点展开箭头也弹抽屉」。
  5. `time()` 的空值文案「尚未到达」被复用于勋章 `granted_at`（`:218`）：已发放勋章若 `granted_at` 为 null 会显示「尚未到达」，语义错位（边缘情况；`:185`/`:200` 的改名时间有 `v-if` 保护，不受影响）。
  6. 核对弹窗无进度/取消手段：`verifyPoints` 不超时（`admin.ts:308`），大库全量重算期间只有 `v-loading`，遮罩不可点关（`:238`），只能等完成。
  7. `min-width:960px`（`:261`）：窄屏出横向滚动条，与 `admin/agents.md`「窄屏可用性」存在张力（现有 1280px 断点只调指标卡网格）。
  8. 生产 WS 不可用（`.qoder/ARCHITECTURE.md` §12.3、`.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 1、2 项）——实时同步在生产退化为手动「刷新数据」；no-token 分支不重连（`liveUpdates.ts:56-59`）为三页共性。
  9. 文件位于 `pages/` 而非 `views/`（§1）：与其余页面目录约定不一致，`git log --follow` 确认自 `81b86e5` 创建即在 `pages/`、无迁移记录，原因无提交说明——**待确认**（`.qoder/REQUIREMENTS.md` §11.5 同标「原因未说明」）；如需归一应连同 `router/index.ts:41` 的 import 路径与本文档路径一起改。
- **待开发**：无本页专属待办；`verifyPoints` 的 `user_ids` 参数后端已支持（`admin.py:336`）但前端未暴露「按人核对」入口，属可选扩展（未见需求条目）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/pages/RankingsView.vue`，共 **6 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目。

### 2026-10-13（`e197a28`）
- 需求：V2.0 管理后台——排名洞察积分化（同批含活动设置页、人员组织调整弹窗、审计动作中文化）。
- 修改内容（涉本文件）：+108/-17 行（`git show --numstat` 实测）——① 排名口径由步数改为总积分：新增 `total_points`/`averagePoints`、指标卡插「累计总积分」、明细加总积分列（步行/答题拆分）、英雄区文案改「按总积分（步行 + 答题）实时排名，同分按累计步数」；② 荣誉榜由前 3 扩至前 10：拆 `podiumTop`/`eliteCards`，金银铜领奖台（Trophy/Medal 徽章、gold/silver/bronze 样式）+ 4~10 名荣誉卡网格；③ 新增「积分核对」按钮与核对/修复弹窗（`runVerify`/`openVerify`、样本表、`verifyFixed` 单次修复限制）；④ 新增 `SOURCE_TEXT` 与抽屉积分流水来源标签。
- 关联文件：`admin/src/api/admin.ts`（`verifyPoints`/`PointsVerifyResult`）、`admin/src/main.ts`（Trophy/Medal 图标注册）、`backend/app/services/admin_service.py`（荣誉榜扩至前 10）、后端 points 核对链路；报告 `admin/test/docs/v2-admin-report.md`（截图 v2-06~v2-09）。
- 测试结果：见 `docs/迭代记录.md` 的 `e197a28` 条目。

### 2026-10-11（`30b4458`）
- 需求：管理后台代码审查修复（本页涉及：实时推送防抖收口与统一格式化）。
- 修改内容（涉本文件）：+5/-21 行——① 删除页内自建 `scheduleReload` 800ms 防抖，改为 `useLiveUpdates({ onDataChanged: load })`（`:61`）；② 删除私有 `TIME_FORMAT` 与手写补 Z 的 `time()`，改 `formatDateTime(value, '尚未到达')`（`:6`、`:69`）；③ `onBeforeUnmount` 只保留关键词定时器清理（`:63-65`）。
- 关联文件：`admin/src/utils/liveUpdates.ts`、`admin/src/utils/format.ts`（新建）、`admin/src/views/DashboardView.vue`、`admin/src/views/ScreenView.vue` 等；报告 `admin/test/docs/s16-admin-review-fixes-report.md`。
- 测试结果：见 `docs/迭代记录.md` 的 `30b4458` 条目。

### 2026-10-11（`b5d6035`）
- 需求：排名洞察性能改造——人员量大时不再全量加载与渲染（根 `agents.md` §2.4）。
- 修改内容（涉本文件）：+58/-48 行——① 列表由「一次拉全量 + 前端 `computed` 过滤/切片」改为服务端分页/筛选：引入 `fetchRankings(page, pageSize, filter)`、`appliedKeyword`、`orgId`（组织选项改用后端 `org_options`）、`requestSeq` 竞态守卫与空页回退（`:29-46`）；② 关键词 300ms 防抖 + watch 合并单请求（`:48-58`），移除 `onMounted`（首载由 `immediate` watch 承担）；③ 导出改 `exportRankings` blob + `saveFile`（原先直接 `request.get`），删除页内本地接口类型定义（移入 `api/admin.ts`）。
- 关联文件：`admin/src/api/admin.ts`（`fetchRankings`/`exportRankings`/`RankFilter` 等）、`admin/src/utils/download.ts`、`backend/app/api/routes/admin.py`（分页参数 + `/rankings/export` 流式接口）、`backend/app/services/admin_service.py`（`get_rank_overview` SQL 聚合、`iter_rank_csv`）、`backend/app/schemas/schemas.py`；报告 `admin/test/docs/s15-rankings-server-paging-report.md`。
- 测试结果：见 `docs/迭代记录.md` 的 `b5d6035` 条目。

### 2026-10-02（`4e453a4`）
- 需求：打包体积优化（echarts/Element Plus 按需引入），同批给排名页加分页。
- 修改内容（涉本文件）：+20/-62 行——大表整页渲染会卡死页面，改为**前端分页**（当时仍是全量数据 + `pagedItems` 切片；后被 `b5d6035` 升级为服务端分页）。
- 关联文件：`admin/src/main.ts`、`admin/src/plugins/element-plus.ts`、`admin/src/views/DashboardView.vue`；报告 `admin/test/docs/s7-ondemand-perf-report.md`（截图 s7-02-rankings-pagination.png）。
- 测试结果：见 `docs/迭代记录.md` 的 `4e453a4` 条目。

### 2026-10-01（`f820e0e`）
- 需求：微信名称直登与「昵称仅可修改一次」（三端）。
- 修改内容（涉本文件）：+151/-13 行——排名洞察展示改名记录：`original_nickname`/`nickname_changed_at` 字段、「改名」标签与曾用名 tooltip、「只看已改名」筛选、档案抽屉改名信息（「每人仅一次」文案）。
- 关联文件：`admin/src/api/admin.ts`、后端 `auth.py`/`auth_service.py`/`admin_service.py`/`models.py`/`schemas.py`、`docker/init/004_nickname_change.sql`、小程序 login/mine 页；报告 `admin/test/docs/nickname-rename-record-report.md`。
- 测试结果：见 `docs/迭代记录.md` 的 `f820e0e` 条目。

### 2026-10-01（`81b86e5`）
- 需求：管理后台新增排名洞察与路线节点维护页面（P2 管理端）。
- 修改内容（涉本文件）：创建本文件（+102 行，直接落在 `pages/` 目录，原因无提交说明，§9 第 9 项）——初版为全量拉取 + 前端关键词/组织/改名筛选、前 3 名领奖台、节点轨迹展开、人员档案抽屉。
- 关联文件：`admin/src/views/RouteNodesView.vue`（新建）、`admin/src/router/index.ts`、`admin/src/layout/AdminLayout.vue`、`admin/src/api/admin.ts`、`admin/src/style.css`、`admin/vite.config.ts`、`admin/package.json`。
- 测试结果：见 `docs/迭代记录.md` 的 `81b86e5` 条目。
