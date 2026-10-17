# march.js

## 1. 文件路径

`frontend/services/march.js`（117 行）

## 2. 文件职责

小程序「长征路线」域的服务层：封装后端 `/api/march/*` 的 6 个接口（路线进度、节点详情、点亮、全员目标、足迹、完成仪式标记），并额外承载长征 Tab 开场动画的**本地播放标记**读写（`wx.setStorageSync`）。页面只消费本模块返回值结构，不直接发请求（分层规则见 `frontend/AGENTS.md` §3.1）。

## 3. 业务需求

- 节点三态与「点亮永久保留」规则：文件头 docstring 标注出处「需求文档 十一 / 规则2 / 规则3」（`frontend/services/march.js:4-8`）。
- 全员共同长征目标：docstring 标注「需求 §11」（`:66`），`c92598c`（2026-10-03）交付（`docs/迭代记录.md` 的 `c92598c` 条目）。
- 我的长征足迹：docstring 标注「需求 §7」（`:74`），`ffd2570`（2026-10-03）交付（`docs/迭代记录.md` 的 `ffd2570` 条目）。
- 完成仪式仅首次触发：docstring 标注「需求 §20.4」（`:82`），`79004f1`（2026-10-04）交付（`docs/迭代记录.md` 的 `79004f1` 条目）。
- 开场动画仅首次完整播放：docstring 标注「需求 §5」（`:89`）。
- 章节系统（`newlyCompletedChapters` 字段来源）：`6a2fae3`（2026-10-02）「5 章配置化划分、章节完成仪式与 CHAPTER_COMPLETE 事件」（`docs/迭代记录.md` 的 `6a2fae3` 条目）。

## 4. 核心功能

**导出 8 个函数**（`module.exports`，`:108-117`），全部经 `requestService.request`（`:10`）走后端；后端契约见 `.qoder/backend/app/api/routes/march.py.md` 与 `.qoder/backend/app/services/march_service.py.md`（本文档不重复推导后端逻辑）。

| # | 函数 | 行号 | 后端接口 | 说明 |
|---|---|---|---|---|
| 1 | `getRoute()` | `:16-18` | `GET /api/march/route` | 路线整体进度与节点状态列表 |
| 2 | `getNodeDetail(nodeId)` | `:32-46` | `GET /api/march/node/{nodeId}` | 单节点详情（含未解锁节点），带坐标回退补齐 |
| 3 | `lightUpNodes()` | `:55-63` | `POST /api/march/light-up` | 按当前累计步数点亮达标节点 |
| 4 | `getGlobalGoal()` | `:69-71` | `GET /api/march/global` | 全员共同长征目标 |
| 5 | `getFootprints()` | `:77-79` | `GET /api/march/footprints` | 我的长征足迹 |
| 6 | `markCeremony()` | `:85-87` | `POST /api/march/ceremony` | 标记完成仪式已观看（后端持久化） |
| 7 | `hasPlayedIntro()` | `:92-98` | 无（本地 Storage） | 读开场动画播放标记 |
| 8 | `markIntroPlayed()` | `:100-106` | 无（本地 Storage） | 写开场动画播放标记 |

### 4.1 `getRoute`（`:16-18`）

JSDoc 声明返回 `{nodes, currentSteps, totalSteps, litCount, totalCount, nextNode, finished}`（`:14`）。节点状态三态（unlocked/current/completed）规则见文件头 `:4-8`。`finished` 字段即「路线完成」标志，是完成仪式链路（§4.6）的输入之一；仪式页还单独调 `getRoute()` 取路线数据（`frontend/pages/ceremony/ceremony.js:45`）。

### 4.2 `getNodeDetail`（`:32-46`）与坐标回退

先请求 `/march/node/{id}`；用内部函数 `hasCoordinates`（`:21-25`，**未导出**）判断 `latitude/longitude` 是否为有限数值，缺坐标时再调 `getRoute()` 按节点 id 从路线接口补齐坐标（`:35-43`），路线请求失败则保留原详情内容（`.catch(() => node)`，`:44`）。该回退是 `6913b00`（2026-10-15）修复「节点详情路线位置缺少点位导致蓝屏」时加入的兼容路径——同提交已在后端 `NodeDetailOut` 补充经纬度（`docs/迭代记录.md` 的 `6913b00` 条目），前端回退作为旧版接口/异常场景的双保险保留至今。

### 4.3 `lightUpNodes`（`:55-63`）

`POST /march/light-up`，无请求体。对返回值做兜底归一：`newlyLit` / `newlyCompletedChapters` / `newMedals` 三数组缺省为 `[]`（`:58-62`）。JSDoc（`:49-53`）明确：点亮判定与勋章刷新在后端完成、**V2.0 起点亮不再发放积分**；`newlyLit` 供「抵达事件卡」、`newlyCompletedChapters`（含 title/intro）供「章节完成仪式」、`newMedals` 为本次新获勋章 id。`e70b59f` 将 `newMedals` 合并进本接口返回，省去前端单独调勋章检查接口（`docs/迭代记录.md` 的 `e70b59f` 条目「light-up 合并返回 newMedals 省去单独勋章请求」）。

### 4.4 `getGlobalGoal`（`:69-71`）/ `getFootprints`（`:77-79`）

纯透传。`getGlobalGoal` 返回 `{totalSteps, targetSteps, progressPct, milestones[{name,steps,reached}], nextMilestone}`（JSDoc `:67`，全员累计步数 / 2 亿步总目标 / 阶段里程碑）；`getFootprints` 返回已点亮节点的 `{id,name,icon,litAt,litDate,daySteps,cumSteps}` 列表（JSDoc `:75`）。

### 4.5 `markCeremony`（`:85-87`）——完成仪式标记

`POST /march/ceremony`，返回 `{ok:boolean}`（JSDoc `:83`）。用途（`:82` 注释）：需求 §20.4「仅第一次完成路线触发完整动画」，观看后向后端落库标记，防止重复播放。与 §4.6 的开场动画标记不同，**仪式标记走后端持久化，换设备不重播**（依据：接口存在且注释写明「标记已观看」；后端存储表字段见 `.qoder/backend/app/api/routes/march.py.md`，本文档不复述）。调用方仅仪式页（`frontend/pages/ceremony/ceremony.js:426`，链式 `.markCeremony()`）。

### 4.6 开场动画本地标记（`:89-106`）

Storage 键 `INTRO_PLAYED_KEY = 'lm_march_intro_played'`（`:90`）。`hasPlayedIntro` 读、`markIntroPlayed` 写值 `1`，两者均 try/catch 吞异常：读失败按「未播放」处理（`:96`），写失败仅导致下次重播开场、不影响功能（`:104` 注释）。`e70b59f` 把该标记从页面收归本服务（`docs/迭代记录.md` 的 `e70b59f` 条目「开场标记 Storage 收归 services/march.js」），与 `frontend/AGENTS.md` §3.1「pages 层不得直接读写 Storage」约束一致。

## 5. 输入与输出

- 输入：仅 `getNodeDetail(nodeId)` 有参数（拼入 URL 路径，`:33`）；其余接口无参数。
- 输出：全部为 Promise，resolve 值为后端 camelCase JSON（契约见 §4 各 JSDoc 与 `.qoder/backend/app/api/routes/march.py.md`）。
- 错误：由 `request.js` 统一抛出带中文 message 的 `Error`（`frontend/services/request.js:48-59`）；401 自动静默重登并重试一次，仍失败清登录态回启动页（`request.js:129-160`）；**GET 类请求**（route/node/global/footprints）遇活动守卫 403（响应头 `X-Activity-Status`）时防抖 `reLaunch` 到活动状态页，**POST 类**（light-up/ceremony）只抛错交页面提示（`request.js:87-91`、`:106-119`、`:132-136`）。
- `lightUpNodes` 对返回体三字段做了 `|| []` 兜底（`:59-61`），页面可假定数组恒存在；其余函数未做结构兜底。

## 6. 依赖关系

- 依赖：`frontend/services/request.js`（`:10`，JWT 注入/401 重试/活动拦截）→ `frontend/services/config.js`（`API_BASE_URL`）→ 后端 `/api/march/*`（`.qoder/backend/app/api/routes/march.py.md`、`.qoder/backend/app/services/march_service.py.md`）；本地 `wx.getStorageSync/setStorageSync`（`:94`、`:102`）。
- 被依赖（grep `require('../../services/march')` 全量核实，6 个页面）：
  - `frontend/pages/home/home.js:9`——`getRoute()`（`:157`）、`getGlobalGoal().catch(() => null)`（`:164`，失败不阻塞首页主数据）、`lightUpNodes()`（`:320`，步数同步链路后调用）；
  - `frontend/pages/march/march.js:13`——`hasPlayedIntro()`（`:95`）、`markIntroPlayed()`（`:114`）、`getRoute()`（`:162`）；
  - `frontend/pages/node-detail/node-detail.js:9`——`getNodeDetail(id)`（`:36-37`）；
  - `frontend/pages/ceremony/ceremony.js:10`——`getRoute()`（`:45`）、`markCeremony()`（`:426`）；
  - `frontend/pages/profile/profile.js:10`——`getFootprints().catch(() => null)`（`:58`，足迹地图失败不阻塞档案主数据）；
  - `frontend/pages/ticket/ticket.js:7`——`getNodeDetail(id)` + `getFootprints()`（`:25`，纪念票绘制）。
- **导出函数零调用者：无**（grep 核实上述 8 个导出均有页面调用；`hasCoordinates` 为内部函数未导出）。

## 7. 业务规则

1. **节点状态三态 + 永久点亮**：unlocked/current/completed 由后端按累计步数判定；「节点一旦点亮永久保留，即使后续步数下降也不取消」（`:8`，判定实现在后端，见 `.qoder/backend/app/services/march_service.py.md`）。
2. **点亮不发放积分（V2.0 起）**：`:49` 注释明确「点亮不再发放积分」，`44eb77b` 同批「移除节点点亮弹层中的积分展示」（`docs/迭代记录.md` 的 `44eb77b` 条目）。
3. **前端不造业务数据**：本模块仅 `lm_march_intro_played` 一个本地键，且属 UI 播放标记而非业务数据，不违反「后端是唯一数据源」不变量（`frontend/AGENTS.md` §4.2）。
4. **两类「仅首次」标记的存储位置不同**：开场动画标记存本地 Storage（`:90`，换设备会重播）；完成仪式标记存后端（`:85-87`）。
5. **任意节点（含未解锁）可看详情**：`getNodeDetail` 注释「含未解锁节点」（`:28`），与 `frontend/AGENTS.md` §4.8 不变量一致，服务层不做解锁拦截。

## 8. 修改约束

1. 返回结构是页面硬契约（`frontend/AGENTS.md` §1「服务层返回结构稳定」最高优先级）；字段为 camelCase，与后端 `CamelModel` 输出一致，改名须双端同步（`.qoder/README.md` §3 规则 6）。
2. `getNodeDetail` 的坐标回退链（详情→路线补齐→失败保留原详情）不得简化为「缺坐标即报错」——`6913b00` 修复的正是缺坐标导致地图蓝屏（`docs/迭代记录.md` 的 `6913b00` 条目），且 node-detail 页仅在点位有效时渲染地图、否则显示空态。
3. `lightUpNodes` 一次请求需继续返回 `newlyLit + newlyCompletedChapters + newMedals` 三段，前端已不再单独调勋章检查接口（`e70b59f`，见 §4.3），拆分即回归。
4. `INTRO_PLAYED_KEY` 键名与 Storage 读写只能留在本文件，页面不得直接读写（`frontend/AGENTS.md` §3.1）。
5. 新增接口调用一律走 `requestService.request`，不得绕过其 401/活动拦截逻辑（`frontend/AGENTS.md` §6.5 禁止行为）。

## 9. 当前实现状态

- **已实现**：8 个导出函数全部可用且均有调用方（§6）；6 个后端接口在 `.qoder/backend/app/api/routes/march.py.md` 有对应文档。
- **存在问题 / 已知事项**：
  1. `getNodeDetail` 的路线回退会多发一次 `/march/route` 请求；自 `6913b00` 后端补坐标后该路径正常情况不再触发，仅旧数据/异常场景兜底（§4.2）。是否需要保留双保险为**现状事实**，是否计划移除**待确认**。
- **待开发**：无（后端 `1600074` 条目提及的「node-detail 讲解面板」属 AI 域后续阶段，不在本文件职责内）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/march.js`，共 **10 个提交**，与 `docs/迭代记录.md` 逐条核对存在。按时间倒序。

### 2026-10-15（`6913b00`，13:41）
- 需求：修复节点详情路线位置缺少点位导致地图蓝屏（缺陷）。
- 修改内容（涉本文件）：`getNodeDetail` 增加坐标缺失时从 `/march/route` 按节点 id 补齐的回退，路线请求失败仍保留详情内容（`:32-46`）。
- 关联文件：`backend/app/api/routes/march.py`、`NodeDetailOut` schema、`frontend/pages/node-detail/node-detail.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `6913b00` 条目（前端服务坐标回退 4/4、页面回归 11/11）。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0 小程序批次。
- 修改内容（涉本文件）：点亮不再发放积分（`:49` 注释现状）；该提交对本文件的具体 diff 未逐行核对，其余改动以提交信息为据（同批「移除节点点亮弹层中的积分展示」见 `docs/迭代记录.md` 的 `44eb77b` 条目）。
- 关联文件：`frontend/pages/march/march.js`、`frontend/pages/home/home.js` 等。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复批次。
- 修改内容（涉本文件）：开场动画标记 Storage 收归本服务（`:89-106`）；`lightUpNodes` 合并返回 `newMedals`，省去单独勋章请求（`:50-53`）。
- 关联文件：`frontend/pages/march/march.js`、`frontend/pages/home/home.js`、`frontend/services/ws.js` 等。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-04（`79004f1`，01:13）
- 需求：区域氛围与长征完成仪式（P2-2）。
- 修改内容（涉本文件）：新增 `markCeremony`（`POST /march/ceremony`，仅首次完成触发完整动画的已观看标记，`:81-87`）。
- 关联文件：`frontend/pages/ceremony/ceremony.js`、后端 march 路由/服务。
- 测试结果：见 `docs/迭代记录.md` 的 `79004f1` 条目。

### 2026-10-03（`ffd2570`，02:35）
- 需求：我的长征足迹地图（P1-6）。
- 修改内容（涉本文件）：新增 `getFootprints`（`GET /march/footprints`，`:73-79`）。
- 关联文件：`frontend/pages/profile/profile.js`、后端足迹接口。
- 测试结果：见 `docs/迭代记录.md` 的 `ffd2570` 条目。

### 2026-10-03（`c92598c`，02:02）
- 需求：全员共同长征目标（P1-4）。
- 修改内容（涉本文件）：新增 `getGlobalGoal`（`GET /march/global`，`:65-71`）。
- 关联文件：`frontend/pages/home/home.js`（首页全员同行卡）、后端全员目标接口。
- 测试结果：见 `docs/迭代记录.md` 的 `c92598c` 条目。

### 2026-10-02（`6a2fae3`，23:07）
- 需求：长征章节系统（P0-3）。
- 修改内容（涉本文件）：`lightUpNodes` 返回增加 `newlyCompletedChapters`（章节完成仪式数据源，`:52`、`:60`）。
- 关联文件：后端章节配置与 CHAPTER_COMPLETE 事件。
- 测试结果：见 `docs/迭代记录.md` 的 `6a2fae3` 条目。

### 2026-10-01（`6a24562`，17:53）
- 需求：服务层由本地 Mock 切换为后端真实接口。
- 修改内容（涉本文件）：改为经 `requestService.request` 调 `/march/*` 真实接口，页面改异步加载（提交信息为据）。
- 关联文件：`frontend/services/request.js` 及同批各 service。
- 测试结果：见 `docs/迭代记录.md` 的 `6a24562` 条目。

### 2026-10-01（`b0fd8b2`，10:31）
- 需求：小程序由本地 Mock 切换为真实后端接口（与 `6a24562` 同日同主题的前序提交）。
- 修改内容（涉本文件）：仅提交信息为据，具体 diff 未逐行核对。
- 测试结果：见 `docs/迭代记录.md` 的 `b0fd8b2` 条目。

### 2026-09-30（`a94e685`，18:05）
- 需求：仓库初始化（`feat: init`）。
- 修改内容（涉本文件）：创建本文件；初始形态为本地 Mock 实现（由后续 `b0fd8b2`/`6a24562`「由本地 Mock 切换为真实接口」的提交信息推知，init 时点代码未逐行核对）。
- 测试结果：无记录（早于迭代台账建立口径的部分以提交信息为据）。
