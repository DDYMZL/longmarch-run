# broadcast.js

## 1. 文件路径

`frontend/services/broadcast.js`（44 行）

## 2. 文件职责

「今日播报」服务层：封装后端 `/broadcast/today`（全局播报 + 个人进度 + 长征记忆彩蛋聚合）与 `/broadcast/activities`（实时行军动态）两个只读接口，并提供 `toActivityView` 把 **REST 条目与 WebSocket `activity` 消息两种来源归一为同一动态视图模型**（`frontend/services/broadcast.js:1-3`、`:7-9` 注释）。REST 与 WS 的通道分工（REST 负责首屏/回场初始列表与断线补拉，WS 负责在线期间实时增量）已由后端文档 `.qoder/backend/app/api/routes/broadcast.py.md` §7 规则 1 确立，本文档不重复其论证。

## 3. 业务需求

- `getToday`：需求「功能 6 全局播报 + 功能 7 长征记忆彩蛋」（后端 `broadcast_service.py` docstring，转引自 `.qoder/backend/app/api/routes/broadcast.py.md` §3）；前端消费随首页重组批次 `7e587c9`（2026-10-02）交付。
- `getActivities`/`toActivityView`：需求 §8.3/8.5「实时行军动态」（`:31` JSDoc），P1-1 批次 `17a4d98`（2026-10-03）交付（`docs/迭代记录.md` 的 `17a4d98` 条目）。

## 4. 核心功能

导出 3 个函数（`module.exports`，`:40-44`）：

### 4.1 `toActivityView(item)`（`:11-20`）

纯函数，REST/WS 共用的视图归一器。输入两种形态（`:8-9` 注释明示字段映射）：

- REST 条目：`{id, eventType, eventTime, nickname, text}`（后端 `ActivityItemOut`，见 `.qoder/backend/app/api/routes/broadcast.py.md` §4.2）；
- WS `activity` 消息：`{eventType, nickname, text, at(ms)}`（`frontend/services/ws.js` 下发，无 id、时间为毫秒时间戳）。

输出视图模型 `{id, icon, nickname, text, timeText}`：

- `id`：REST 用原 id；WS 消息无 id 时合成 `'ws-' + (at||Date.now()) + '-' + eventType`（`:14`），供列表 `wx:key` 使用；
- `icon`：`util.eventIcon(eventType)`（`:15`，`frontend/utils/util.js:82`）——图标映射表原在本文件，`e70b59f` 审查批次移入 util 去重（§10）；
- `nickname`：缺省兜底 `'战友'`（`:16`）；
- `text`：缺省空串（`:17`）；
- `timeText`：`util.formatRelative(atIso)` 相对时间（`:18-19`，`frontend/utils/util.js:55`）；`atIso` 取 `eventTime`，否则把 WS 的 `at` 毫秒数转 ISO 串（`:12`）。

### 4.2 `getToday()`（`:26-28`）

`GET /broadcast/today`，**原样透传**三段聚合 `{global, personal, memory}`（JSDoc `:24`；各段字段口径见 `.qoder/backend/app/api/routes/broadcast.py.md` §4.1）。无参数、无本地加工。

### 4.3 `getActivities(limit)`（`:34-38`）

`GET /broadcast/activities?limit=`，**limit 为空时前端默认 10**（`:36`，与后端默认一致）；取 `res.items || []` 后逐条 `map(toActivityView)`（`:37`）——页面拿到的是**视图模型列表**而非裸接口数据（JSDoc `:32`「视图模型列表」）。后端另有 1..50 钳制（`.qoder/backend/app/api/routes/broadcast.py.md` §4.2）。

## 5. 输入与输出

- `getToday()`：无入参；resolve `{global, personal, memory|null}`。
- `getActivities(limit)`：可选 number；resolve 视图模型数组（§4.1 结构）。
- `toActivityView(item)`：同步纯函数，不抛异常（各字段均有 `||` 兜底，`:12-18`）。
- 网络/401 异常以 Promise reject 冒泡；首页对 `getActivities` 显式 `.catch(() => null)` 兜底（见 §6）。

## 6. 依赖关系

- 依赖：`./request`（`:4`）、`../utils/util`（`:5`，`eventIcon`/`formatRelative`）→ `./config`（API_BASE_URL）→ 后端 `backend/app/api/routes/broadcast.py`。
- 被依赖（grep `services/broadcast|toActivityView|broadcast.get*` 全量核实，测试目录除外）：**唯一消费页为首页** `frontend/pages/home/home.js`：
  - `:12` require；
  - `:159` `broadcast.getToday()`（今日播报主数据）；
  - `:161` `broadcast.getActivities(6).catch(() => null)`——**动态流失败不阻塞首页主数据**（`:161` 行内注释；`.qoder/backend/app/api/routes/broadcast.py.md` §6 同口径）；
  - `:144` `broadcast.toActivityView(msg)`——WS `activity` 消息经同一函数归一后**插入动态流顶部、最多 6 条**（`home.js:139-146`，转引自 `.qoder/backend/app/api/routes/broadcast.py.md` §7 规则 1；首页只处理 `activity` 消息、忽略 `data_changed`）。
- **零调用方导出**：无——3 个导出均有调用（上述 grep 证据；`toActivityView` 除本文件内部 `:37` 使用外，还被 home.js 直接消费，这是它被导出的原因）。

## 7. 业务规则

1. **双通道一视图**：REST 与 WS 是同一 `user_event` 数据源的两种通道，字段形态不同（WS 无 `id`、时间戳为毫秒 `at`），必须经 `toActivityView` 归一后才进列表（`:7-9` 注释；通道分工与「WS 含 userId 属管理端通道、REST 不含」的隐私口径差异见 `.qoder/backend/app/api/routes/broadcast.py.md` §7 规则 1 与 §8 规则 2，勿在本层「对齐」字段）。
2. **WS id 合成规则**：`'ws-' + at + '-' + eventType`（`:14`）——同毫秒同类型的两条事件会生成相同 key，属理论边界；现状未见去重需求记录，是否有实际影响**待确认**。
3. `getToday` 无 WS 对应消息，「今日」数据的新鲜度完全依赖首页 `onShow + refresh()` 重拉（`frontend/AGENTS.md` §4.1 不变量；`.qoder/backend/app/api/routes/broadcast.py.md` §7 规则 1 同述）。
4. 昵称兜底 `'战友'`（`:16`）是展示层兜底，不改写后端脱敏规则（`ACTIVITY_MASK_NICKNAME` 见后端文档 §4.2）。

## 8. 修改约束

1. `toActivityView` 输出结构 `{id, icon, nickname, text, timeText}` 是首页 WXML 渲染硬契约（WXML 不能调原生方法，展示字段必须在 js 层备好——`frontend/AGENTS.md` §5.2），改字段须同步 `home.wxml/home.js`。
2. REST 响应 camelCase 契约（`.qoder/backend/app/api/routes/broadcast.py.md` §8 规则 1）：改后端字段须双端同步；`getToday` 的 `global` 段键名为后端 alias 输出，前端直接消费。
3. `eventIcon/formatRelative` 必须继续复用 `utils/util.js`，不得复制回本文件（`frontend/AGENTS.md` §5.1「禁止在多个 service 复制同一工具函数」；`e70b59f` 刚做过此次去重，见 §10）。
4. `getActivities` 的 `.map(toActivityView)` 在 service 层完成——页面不应再拿裸 `items`，保持「页面只依赖 service 返回结构」（`frontend/AGENTS.md` §1）。

## 9. 当前实现状态

- **已实现**：3 个导出全部可用且全部有真实调用方；后端两端点状态见 `.qoder/backend/app/api/routes/broadcast.py.md` §9（含该文档指出的总览表误标与活动闸门缺席两项后端侧待确认事项，非本文件问题）。
- **存在问题 / 已知事项**：WS 合成 id 的同毫秒碰撞边界（§7 规则 2，**待确认**是否有实际影响）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/broadcast.js`，共 **3 个提交**；均已核对存在于 `docs/迭代记录.md`。按时间倒序。注：后端 `GET /broadcast/today` 端点早于本文件、由 `18c2121` 交付（`git show 18c2121 --stat` 核实该提交只含后端文件；`.qoder/backend/app/api/routes/broadcast.py.md` §10 同述），前端消费方随 `7e587c9` 出现。

### 2026-10-11（`e70b59f`，19:18）
- 需求：小程序代码审查修复批次。
- 修改内容（涉本文件，`git show e70b59f -- frontend/services/broadcast.js` 核实）：删除本文件内的 `EVENT_ICONS` 映射表与 `activityIcon` 函数（-21 行），图标逻辑改为复用 `utils/util.js` 的 `eventIcon`。
- 关联文件：`frontend/utils/util.js` 等同批审查修复文件。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-03（`17a4d98`，00:45）
- 需求：实时行军动态（P1-1，需求 §8.3/8.5）。
- 修改内容（涉本文件）：新增 `getActivities` 与 `toActivityView`（REST/WS 归一）；同批交付 WS 客户端 `frontend/services/ws.js` 与首页实时行军卡（提交信息；`.qoder/backend/app/api/routes/broadcast.py.md` §10 同述）。
- 关联文件：`backend/app/api/routes/broadcast.py`、`frontend/services/ws.js`、`frontend/pages/home/home.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `17a4d98` 条目。

### 2026-10-02（`7e587c9`，11:13）
- 需求：小程序页面高级化升级（首页重组等）。
- 修改内容（涉本文件）：创建 `broadcast.js`（16 行，`git show --stat` 核实），提供 `getToday` 供重组后的首页今日播报卡消费。
- 关联文件：`frontend/pages/home/home.js`、`frontend/services/profile.js`（同批新增）等。
- 测试结果：automator 断言 11/11 + 截图巡礼 12/12，报告 `frontend/test/docs/s5-pages-report.md`（提交信息正文）；详见 `docs/迭代记录.md` 的 `7e587c9` 条目。
