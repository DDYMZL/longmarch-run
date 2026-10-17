# sport.js

## 1. 文件路径

`frontend/services/sport.js`（139 行）

## 2. 文件职责

运动数据服务（小程序侧）：把微信运动的**加密数据链路**（`scope.werun` 授权 → `wx.login` 取 code → `wx.getWeRunData` 取 `encryptedData`/`iv`）组装上送 `POST /sport/sync`，由后端解密、按北京时间归日、近 7 日幂等补录并重算步行积分；另封装三个只读聚合（今日概况 / 行军日历 / 最近 N 天记录）。文件头 docstring `:1-10` 自述职责与「覆盖不累加」「真实用户绝不编造步数」两条规则来源（需求 8.3 / 规则 1）。

## 3. 业务需求

- 初始随 `a94e685`（2026-09-30）创建（Mock 版），`6a24562`（2026-10-01）切换为后端真实接口（`docs/迭代记录.md` 的 `6a24562` 条目）。
- `7e587c9`（2026-10-02）页面高级化升级新增行军日历 → `getCalendar`（提交信息「首页重组/档案/行军日历…」；`docs/迭代记录.md` 的 `7e587c9` 条目）。
- `3df3fd0`（2026-10-10）「步数同步接入微信运动真实数据，杜绝模拟步数写库」：前端补授权→code→加密数据上送链（`docs/迭代记录.md` 的 `3df3fd0` 条目，关联文件明列 `frontend/services/sport.js:19-102`）。
- `b1dc700`（2026-10-10）移除首页演示按钮时删除本文件 `addSteps` 方法（`docs/迭代记录.md` 的 `b1dc700` 条目）。
- `6f2cfc3`（2026-10-15）近 7 日补录 + 步数结余积分：同步响应新增 `processedDates`/`failedDates`/`pointsChange`/`todayWalkPoints`/`walkCarry` 等字段（`docs/迭代记录.md` 的 `6f2cfc3` 条目；后端侧 `.qoder/backend/app/services/sport_service.py.md` §10 同日记录）。
- `72d4894`（2026-10-15）滚动发布兼容：服务边界补齐旧响应缺失字段（`docs/迭代记录.md` 的 `72d4894` 条目）→ `normalizeSyncResult`。
- `aa7dd82`（2026-10-15）今日目标 20000 步的前端强制覆盖（`docs/迭代记录.md` 的 `aa7dd82` 条目）。
- 业务规则的项目级权威：微信运动解密与写入语义见 `.qoder/backend/app/services/sport_service.py.md`（本文只写前端侧事实并回指）；微信能力集成见 `.qoder/ARCHITECTURE.md` §7。

## 4. 核心功能

### 4.1 `DAILY_TARGET = 20000`（`:13`）

前端侧今日目标常量，在 `getToday()` 服务边界**强制覆盖**后端下发的 `target` 字段（`:113` `Object.assign({}, result, { target: DAILY_TARGET })`）。动机：后端 `9c8f13f` 把目标从 10000 改 20000 后，**线上旧后端在滚动发布期间仍返回 10000**，首页会用该值覆盖初始值（`docs/迭代记录.md` 的 `aa7dd82` 条目「原因」字段）。与后端同名常量是**必须双端同步的镜像**（`.qoder/backend/app/services/sport_service.py.md` §8 第 8 条：只改后端不生效）。

### 4.2 `authorizeWeRun()`（`:19-27`，未导出）

`wx.authorize({scope: 'scope.werun'})` Promise 化，**resolve 布尔值、从不 reject**（拒绝授权返回 false），由 `syncToday` 判断后抛「未授权微信运动，无法同步步数」（`:88-89`）。

### 4.3 `wxLoginCode()`（`:33-40`，未导出）

`wx.login` Promise 化取 code（无 code 或 fail 均 reject「微信登录失败，请重试」）。**每次同步都取新 code**：后端用该 code 调 `sns/jscode2session` 换 `session_key` 解密运动数据（`:30` 注释；`.qoder/ARCHITECTURE.md` §7 表首行），与 `auth.js` 的登录 code 相互独立、互不复用。

### 4.4 `getWeRunData()`（`:46-61`，未导出）

`wx.getWeRunData` Promise 化，resolve `{encryptedData, iv}`（`:49`，**前端不解密、不解析步数**，密文原样上送）。fail 归一化（`:50-58`）：errMsg 含「开通微信运动」→「请先在微信中开通『微信运动』后再同步」（透传微信侧明确原因便于用户自助解决，`:51` 注释）；其余 →「获取微信运动数据失败，请稍后重试」。

### 4.5 `normalizeSyncResult(result)`（`:64-76`，未导出）

同步响应兼容层（`72d4894`）：对后端旧结构（滚动发布期）补齐默认值——`status||'success'`、`processedDates`/`failedDates` 非数组置 `[]`、`pointsChange`/`todayWalkPoints`/`walkCarry` 非数字置 0；并产出派生标志 `historyDetailsAvailable` = 两个日期数组**同时**为数组（`:66`，即「后端已升级到近 7 日明细结构」）。首页据此区分「旧响应显示步数已同步/已是最新」与「新响应显示近 7 日及部分失败提示」（`docs/迭代记录.md` 的 `72d4894` 条目；消费点 `frontend/pages/home/home.js:328-343`，见 `.qoder/backend/app/services/sport_service.py.md` §8 第 9 条）。

### 4.6 `syncToday()`（`:86-102`）——唯一写路径

链式流程：`authorizeWeRun` → false 即抛错（`:88-89`）→ `wxLoginCode` → `getWeRunData` → 组装 `{code, encryptedData, iv}`（`:90-96`）→ `POST /sport/sync`（`:99`）→ `normalizeSyncResult`（`:101`）。

- **本地失败零请求**：授权/登录/取数任一失败即抛错、**不向服务端发请求**（`:81` 注释「避免写入非真实步数」）——与后端配合构成双保险：后端 `_resolve_steps` 对「真实用户未携带加密数据」一律 400 零写入（`.qoder/backend/app/services/sport_service.py.md` §4.5 路径 (C)）。
- 返回 12 键（JSDoc `:82-84` + normalize 补齐）：`date`/`steps`（今日，页面只用它展示今天，`:80` 注释）/`totalSteps`/`synced`/`status`/`processedDates`/`failedDates`/`pointsChange`/`todayWalkPoints`/`walkCarry`/`historyDetailsAvailable`。
- **`synced` 语义是「今日记录本次发生了变化」**，不是「同步成功」；步数无变化的重复同步返回 `synced:false` + `status:'success'`，前端显示「已是最新」而非报错（`.qoder/backend/app/services/sport_service.py.md` §4.8 与 §8 第 10 条；消费点 `home.js:334-343`）。

### 4.7 `getToday()`（`:110-114`）

`GET /sport/today` + `target` 强制覆盖（§4.1）。返回今日概况 10 键（JSDoc `:106-108`）：`date`/`steps`/`target`/`totalSteps`/`currentStreak`/`maxStreak`/`streakGoal`/`todayGoalCompleted`/`nextStreakMilestone`/`streakRemain`——连续行军卡字段，后端组装见 `.qoder/backend/app/services/sport_service.py.md` §4.9。**今日目标 20000 与连续行军达标门槛（`streakGoal`，后端配置 5000 步）是两个独立口径**（同文 §3）。

### 4.8 `getCalendar(month)`（`:121-123`）

`GET /sport/calendar?month=YYYY-MM`。query 用字符串拼接、未 `encodeURIComponent`——`month` 由调用方 `calendar.js:58` 的 `monthStr(year, month)` 生成，格式受控（`YYYY-MM` 无特殊字符）。返回 `{month, days[], stats}`（整月逐日步数档位 + 答题/点亮标记 + 月度统计，`:117` 注释；后端 4 条 SQL 组装见 `.qoder/backend/app/services/sport_service.py.md` §4.11；月份格式校验在后端路由层，同文 §8 第 11 条）。

### 4.9 `getRecent(n)`（`:130-132`）

`GET /sport/recent?n=`，`n` 缺省 7（`:131` `n || 7`），返回从旧到新 `[{date, steps, text}]`（`:127` 注释）。上下界由后端 `Query(7, ge=1, le=90)` 强制（`.qoder/backend/app/services/sport_service.py.md` §4.12），越界 422。

### 4.10 导出（`:134-139`）

`syncToday`、`getToday`、`getCalendar`、`getRecent` 四个，grep 确认**全部有调用方**（§6），零调用导出为 0 个；`authorizeWeRun`/`wxLoginCode`/`getWeRunData`/`normalizeSyncResult`/`DAILY_TARGET` 均未导出。曾有 `addSteps`（`POST /sport/add` 手动补步演示），`b1dc700` 删除（§10）；后端接口保留仅供 automator/e2e 使用（`.qoder/backend/app/services/sport_service.py.md` §9「待开发」段）。

## 5. 输入与输出

| 函数 | 输入 | 成功输出 | 失败输出（reject 的 Error.message） |
|---|---|---|---|
| `syncToday` | —（数据全部现取：授权态/code/加密数据） | §4.6 的 12 键对象 | 「未授权微信运动，无法同步步数」（`:89`）；「微信登录失败，请重试」（`:36-37`）；「请先在微信中开通『微信运动』后再同步」/「获取微信运动数据失败，请稍后重试」（`:54`、`:56`）；后端 400「微信会话换取失败/解密失败/校验失败/未返回可用步数/未获取到微信运动数据/步数同步冲突」（`.qoder/backend/app/services/sport_service.py.md` §4.5、§4.8，经 request.js `errorMessage` 透传 `detail`）；401/403 见 request.js 链 |
| `getToday` | — | §4.7 的 10 键对象（`target` 恒 20000） | 401 静默重登链；403 活动拦截（GET → 跳活动状态页，`request.js:132-136`） |
| `getCalendar` | `month: 'YYYY-MM'` | `{month, days, stats}` | 同上；后端 400（month 格式非法） |
| `getRecent` | `n?: number`（默认 7） | `[{date, steps, text}]` | 同上；422（n 越界 1..90） |

字段命名一律 camelCase（`.qoder/ARCHITECTURE.md` §4.2 双命名契约的小程序侧）；响应无外壳、2xx 即业务 payload（同文 §4.1，`request.js:75-78` 直接 resolve）。

## 6. 依赖关系

- **上游**：`services/request.js`（`:11`，唯一网络出口——JWT 注入、401 重登、活动拦截处理全部复用，本文件零 Storage、零 wx.request）；wx API（`wx.authorize`/`wx.login`/`wx.getWeRunData`）。
- **后端接口**（4 个，均挂活动准入闸门）：`POST /sport/sync`（`require_activity_participation`）、`GET /sport/today`、`GET /sport/calendar`、`GET /sport/recent`（`require_activity_view`）——权限与路由契约见 `.qoder/backend/app/api/routes/sport.py.md` 与 `.qoder/backend/app/api/deps.py.md` §6.2/§6.3；服务层实现见 `.qoder/backend/app/services/sport_service.py.md`（§4.5 解密、§4.8 同步 11 步、§7.2 幂等）。
- **被依赖（grep 实测，3 个页面）**：
  - `pages/home/home.js:8`：`:156` `getToday()`（refreshAll 并发拉取之一）、`:317` `syncToday()`（「重新同步」入口，`:328-343` 按 `failedDates`/`processedDates`/`synced`/`pointsChange` 分支提示）。**`syncToday` 全仓唯一页面调用点**（`frontend/design.md` 服务层表写「home/march 触发」，grep `pages/march/march.js` 无 sport 引用，实际只有 home 触发——design.md 该处描述与代码不符，属其滞后项）。
  - `pages/calendar/calendar.js:7`：`:58` `getCalendar(monthStr(...))`。
  - `pages/sport-records/sport-records.js:5`：`:25` `getRecent(30)`。
- **数据库表**：前端不触库；后端写 `daily_sport`（唯一写入方 sport_service）、读 `users`/`lit_nodes`/`route_nodes`/`quiz_records`/`points_log`/`user_event`（`.qoder/backend/app/services/sport_service.py.md` §6）。

## 7. 业务规则

1. **去重/幂等契约（前端零去重，全在后端）**：本文件不做任何本地判重、缓存或节流；重复同步的幂等由后端保证——同一日按微信最终值**覆盖**（非累加、非取 max），步数无变化时 `changed=false` → 不触发事件/积分变动，`synced:false`（`.qoder/backend/app/services/sport_service.py.md` §7.2、§7.4）；并发由后端 `users` 行锁 + `uq_sport_user_date` 唯一约束串行化（同文 §7.3）。前端唯一相关约束是 docstring `:4-6` 的「同一天多次同步以最新数据覆盖，绝不累计 +=」。
2. **步数真实性双保险**：前端「授权/登录/取数任一失败即抛错不发请求」（`:81`）；后端「真实用户未携带加密数据 400 零写入」+ `watermark.appid` 校验防伪造（`.qoder/backend/app/services/sport_service.py.md` §4.5、§8 第 5 条）。仅开发模式（mock 用户或后端未配置微信凭证）才会落模拟步数（docstring `:9`；同文 §7.6 降级表）。
3. **每次同步独立取 code**：code 一次性、5 分钟内有效属微信平台约束，故 `syncToday` 链内先 `wx.login` 再取运动数据（`:90-91` 顺序），不复用登录态 code。
4. **近 7 日范围**：同步范围是后端固定的最近 7 个北京时间自然日（前端不传日期参数，payload 只有 `{code, encryptedData, iv}`，`:92-95`）；更早日期被后端静默丢弃（`.qoder/backend/app/services/sport_service.py.md` §9 第 5 条）。
5. **活动拦截差异化**：`syncToday` 是 POST（参与类），活动未开始/已结束时只抛错由首页提示；三个 GET（查看类）被拦截时 request.js 自动去抖跳活动状态页（`request.js:107-108`、`:132-136`；闸门语义 `.qoder/backend/app/api/deps.py.md` §4.5）。
6. **`target` 前端覆盖是滚动发布兼容手段**（§4.1），后端部署新版后该覆盖仍无害（值相同）；若运营再调目标，**必须同时改后端 `DAILY_TARGET` 与本文件 `:13`**（`.qoder/backend/app/services/sport_service.py.md` §8 第 8 条）。

## 8. 修改约束

1. 同步响应 12 键与首页 `home.js:328-343` 的分支提示逐字段绑定（`failedDates`/`processedDates`/`synced`/`pointsChange`），删改字段破坏滚动发布兼容（`.qoder/backend/app/services/sport_service.py.md` §8 第 9 条）；`normalizeSyncResult` 的默认值补齐**不得移除**，除非确认线上后端已全量升级（`72d4894` 的引入原因）。
2. `synced === false && pointsChange === 0` = 「已是最新」的展示语义不得改成错误（同文 §8 第 10 条）。
3. payload 键名 `{code, encryptedData, iv}` 与后端 `SportSyncRequest` 是 camelCase 硬契约（`.qoder/backend/app/api/routes/sport.py.md`）；加密数据**必须原样透传**，前端不得解码/重组（解密只在后端 `core/wx.py`，`.qoder/ARCHITECTURE.md` §7）。
4. 「本地失败不发请求」的短路顺序（authorize → code → weRunData → request）不得调换或吞错，否则可能让后端收到无数据请求（虽有后端 400 兜底，但会丢失前端友好文案）。
5. 新增运动写入入口（如补签）必须走后端接口，前端禁止本地造步数（`frontend/AGENTS.md` §4 不变量 2、§6.5）。
6. `DAILY_TARGET` 双端镜像约束见 §7 第 6 条。

## 9. 当前实现状态

- **已实现**：微信运动真实数据同步链（授权/code/加密数据上送）、滚动发布响应兼容、今日概况（target 覆盖）、行军日历、最近 N 天记录。4 个导出全部有页面消费，无死代码（`addSteps` 已于 `b1dc700` 清除，`docs/迭代记录.md` 的 `b1dc700` 条目记录「全仓 grep 确认无残留」）。
- **存在问题 / 已知事项（事实陈述）**：
  1. `frontend/design.md` 服务层表写「home/march 触发 `syncToday()`」，实际 march 页不引用本服务（§6 grep 证据），design.md 描述滞后（`frontend/design.md` 属 `.qoder/README.md` §4「既有说明文档」，本目录只记录不修改）。
  2. `getCalendar`/`getRecent` 的 query 拼接未做参数校验/编码（`:122`、`:131`），依赖调用方传值受控与后端校验（422/400 兜底）；现状可用，非缺陷。
  3. 微信运动授权被拒后 `wx.authorize` 不会再次弹窗（平台行为），需用户去设置页开启；本文件与首页均未提供 `wx.openSetting` 引导——现状事实，是否需要**待确认**。
- **待开发**：无（补签为后端预留字段，见 `.qoder/backend/app/services/sport_service.py.md` §9「待开发」）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/sport.js`（**9 个提交**）与 `docs/迭代记录.md` 对应条目。按时间倒序。

### 2026-10-15（`aa7dd82`）
- 需求：线上旧后端 `GET /sport/today` 仍返回 `target=10000`，首页目标/进度/达标文案按 1 万步计算。
- 修改内容（涉本文件）：新增 `DAILY_TARGET = 20000`（`:13`），`getToday()` 服务边界统一覆盖后端 `target`（`:113`）（`docs/迭代记录.md` 的 `aa7dd82` 条目）。
- 关联文件：`pages/home/home.js`、测试脚本。
- 测试结果：Node 注入旧后端返回 `target=10000` → `getToday()` 输出 20000 通过；开发者工具 `dailyTarget=20000` 断言通过（`docs/迭代记录.md` 的 `aa7dd82` 条目「验证」字段）。

### 2026-10-15（`72d4894`）
- 需求：新版首页读取 `failedDates.length`，滚动发布期旧后端返回旧结构致「重新同步」运行时报错。
- 修改内容（涉本文件）：新增 `normalizeSyncResult`（`:64-76`），服务边界补齐近 7 日数组、积分变化与结余字段并标识 `historyDetailsAvailable`（`docs/迭代记录.md` 的 `72d4894` 条目）。
- 关联文件：`pages/home/home.js:328-343`。
- 测试结果：`node --check` 通过；Node 注入旧/新响应 8 项断言通过；开发者工具 CLI 编译通过；未触发真实微信运动同步以免测试账号写入（`docs/迭代记录.md` 的 `72d4894` 条目「验证」字段）。

### 2026-10-15（`6f2cfc3`）
- 需求：近 7 日微信运动补录、步数结余积分与用户独立题目轮换（全端）。
- 修改内容（涉本文件）：`syncToday` 返回体扩展 `processedDates`/`failedDates`/`pointsChange`/`todayWalkPoints`/`walkCarry` 消费与 JSDoc 更新（`.qoder/backend/app/services/sport_service.py.md` §10 该条目关联文件明列 `frontend/services/sport.js:63-76`）。
- 关联文件：后端 `sport_service.py`/`points_service.py`、docker 019/020 迁移、`pages/home/home.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `6f2cfc3` 条目（S22 13/13、S18 21/21、S20 25/25 等）；遗留项（真机微信运动验证等）同条目记载，openGauss 部分后由 `83d3552` 覆盖。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复批次（并发请求守卫、登录守卫、删除无引用服务与冗余字段等）。
- 修改内容（涉本文件）：条目未逐项列出本文件改动（`docs/迭代记录.md` 的 `e70b59f` 条目），按提交信息属「删除无引用服务与冗余字段」类清理，具体删改内容以提交信息为据、细节**待确认**（可 `git show e70b59f -- frontend/services/sport.js` 查证）。
- 关联文件：`pages/home/home.js`（请求序号守卫）等多页。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-10（`3df3fd0`）
- 需求：修复「实际没走 9000 步，同步后却写入约 9000 步」——前端从不携带微信数据，后端对无参请求生成假步数。
- 修改内容（涉本文件）：新增 `authorizeWeRun`/`wxLoginCode`/`getWeRunData` 与 `syncToday` 上送链（`:19-102`），本地失败不发请求（`docs/迭代记录.md` 的 `3df3fd0` 条目关联文件明列 `frontend/services/sport.js:19-102`）。
- 关联文件：后端 `core/wx.py`（新建）、`sport_service.py`、`auth_service.py`。
- 测试结果：S11 后端冒烟 8/8；e2e 178/178；automator 验收 4/4（devtools 取数失败友好报错且零写入）；真机端到端当时待用户确认（`docs/迭代记录.md` 的 `3df3fd0` 条目「验证」字段）。

### 2026-10-10（`b1dc700`）
- 需求：首页「演示 +2000步」按钮写入假步数污染真实数据，移除。
- 修改内容（涉本文件）：删除不再被引用的 `addSteps` 方法；后端 `/sport/add` 接口保留（automator/e2e 仍依赖）（`docs/迭代记录.md` 的 `b1dc700` 条目）。
- 关联文件：`pages/home/home.js`/`.wxml`/`.wxss`。
- 测试结果：`node --check` 通过；全仓 grep 确认无 `addSteps`/`handleAddSteps` 残留（`docs/迭代记录.md` 的 `b1dc700` 条目「验证」字段）。

### 2026-10-02（`7e587c9`）
- 需求：小程序页面高级化升级（首页重组/档案/行军日历/到达动画/情报化/勋章墙）。
- 修改内容（涉本文件）：新增 `getCalendar(month)` 支撑行军日历页（提交信息含「行军日历」；`docs/迭代记录.md` 的 `7e587c9` 条目仅一句概述）。
- 关联文件：`pages/calendar/calendar.js`（新增）、后端 `routes/sport.py`（`18c2121` 已备好接口）。
- 测试结果：该条目未记录验证字段，待确认。

### 2026-10-01（`6a24562`）
- 需求：服务层由本地 Mock 切换为后端真实接口，页面改异步加载并补错误提示。
- 修改内容（涉本文件）：四个方法全部改走 `request.js` 调 `/api/sport/*`（`docs/迭代记录.md` 的 `6a24562` 条目）。
- 关联文件：其余全部 `services/*.js` 与各页面。
- 测试结果：该条目未记录验证字段，待确认。

### 2026-09-30（`a94e685`）
- 需求：项目初始化。
- 修改内容（涉本文件）：创建本文件（Mock 实现：按日期种子生成模拟步数，`frontend/test/docs/miniprogram-test-report.md` 记载该时期 `syncToday` 用 `util.seededSteps` 造数，后由 `3df3fd0` 全面替换）。
- 关联文件：仓库初始代码全量。
- 测试结果：待确认（`docs/迭代记录.md` 的 `a94e685` 条目仅「仓库初始代码」）。
