# ai-chat.js（页面级合一：ai-chat.js / ai-chat.wxml / ai-chat.wxss / ai-chat.json）

## 1. 文件路径

- `frontend/pages/ai-chat/ai-chat.js`（541 行）
- `frontend/pages/ai-chat/ai-chat.wxml`（112 行）
- `frontend/pages/ai-chat/ai-chat.wxss`（409 行）
- `frontend/pages/ai-chat/ai-chat.json`（5 行）

四件套合计 1067 行。按 `.qoder/README.md` §1「页面级合一例外」规则合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

「AI 智能中心 · 历史助手」聊天页：长征历史多轮问答 + 会话抽屉（查看/切换/删除本人会话）。它是 **tabBar 第 3 项「AI 问答」**（`frontend/app.json` tabBar 段），也是 `frontend/services/ai.js` 的**唯一消费页**（`.qoder/frontend/services/ai.js.md` §6）。自 `6a4dbb7`（2026-10-19）起为 **SSE 真流式**：回答按 `delta` 增量逐段下发，页面把增量先入字符队列、再由定时器分批做打字机渲染，生成中正文末尾带闪烁光标并可随时「停止」；首个增量到达前以三点加载占位气泡呈现（§4.4、§7 规则 1）。

四件套关系：js 承担会话状态机、流式发送/停止/重试、打字机渲染、抽屉数据与分页、滚动定位；wxml 纯条件渲染（消息行/空态/banner/节点上下文 chip/抽屉五块互不嵌套复用）；wxss 自带全部页面级样式（不依赖 app.wxss 的 `.card`/`.anim-card` 体系，与多数子页不同）；json 仅导航栏 3 项配置。四文件只服务本页，无被其他页面引用的模板/样式。

## 3. 业务需求

- AI 智能中心 V1.0 Phase A §3.1「历史助手」（连续对话、来源引用、跨账号隔离、日限额），随 `0052108`（2026-10-17）交付；同提交把底部「情报」tab 换防为「AI 问答」，quiz 降级为首页情报卡入口子页（`.qoder/REQUIREMENTS.md` §5.4「底部「情报」tab」行；`git log -S "ai-chat" -- frontend/app.json` 仅命中 `0052108` 一个提交）。后端对端为同日 `1600074`（`.qoder/backend/app/api/routes/ai.py.md` §10）。
- `53f2d62`（2026-10-18，十项增强 B5 批）：本页落地三项——节点上下文追问（节点详情「问 AI」进入，带可清除 chip 与节点专属建议问题）、建议问题后端化（接口失败回退硬编码）、会话抽屉分页（「加载更多」）。
- `c135f33`（2026-10-18）：AI 回答轻量 markdown 渲染（加粗/标题/列表/段落，经 `util.parseMarkdownLite`），替代纯文本 pre-wrap。
- `6a4dbb7`（2026-10-19）：AI 问答真流式改造（后端 + 前端同批）——新增 `POST /api/ai/chat/stream` SSE 通道（`start`/`delta`/`done`/`error` 事件），页面打字机逐字、停止按钮、失败/停止保留半截回答。
- 原始需求书《长征步迹 AI 智能中心开发需求 V1.0》未入库，§3.1 原文措辞**待确认**（`.qoder/backend/app/api/routes/ai.py.md` §3）。

## 4. 核心功能

### 4.1 模块级常量与工具函数（`ai-chat.js:11-51`）

- 依赖（`:11-14`）：`getApp()`、`services/ai`、`services/march`、`utils/util`。
- `COMMON_QUESTIONS`（`:17-22`）：4 条硬编码常见问题，是建议问题接口失败时的兜底文案（`:16` 注释）。
- `SESSION_PAGE_SIZE = 20`（`:24`）：会话抽屉分页大小，与后端 `page_size` 的默认值同值（`backend/app/api/routes/ai.py:189`）。
- 打字机节奏（`:26-33`）：`TYPE_TICK_MS = 45`（每 45ms 渲染一批字符）、`TYPE_MAX_PER_TICK = 12`（单拍字符上限）、`SCROLL_GAP_MS = 300`（生成中跟随滚动的最小间隔，逐字渲染每拍都 setData，滚动跟着刷会翻倍开销）、`BOTTOM_ANCHOR = 'ai-bottom'`（底部锚点 id；scroll-into-view 值不变不会重复触发，故先清空再定位）。
- `_seq`（`:35`）：模块级自增，生成气泡渲染键 `_k`。
- `markLast(blocks)`（`:38-41`）：给最后一个 markdown 块打 `last: true`，供 WXML 在正文末尾接闪烁光标。
- `markLastUserFailed(msgs)`（`:44-51`）：把最后一条用户气泡标记 `failed: true`（`:47`），供「点击重试」定位提问。

### 4.2 `data` 状态字段（`:54-72`，按关注点分组）

| 分组 | 字段 | 行号 | 说明 |
|---|---|---|---|
| 对话状态 | `messages` | `:55` | 气泡数组，元素形状见下表 |
| | `conversationId` / `title` | `:56-57` | 当前会话 id（null=下次发送新建）与标题（顶栏展示，WXML `:5`） |
| 输入状态 | `inputText` / `sending` / `toView` | `:58-61` | 输入内容；请求进行中标志——含逐字生成，此间发送按钮变「停止」且禁止切会话/新建/重发（`:59-60` 注释）；scroll-into-view 锚点 |
| 空态引导 | `commonQuestions` | `:62` | 初值 `COMMON_QUESTIONS`，`loadSuggestedQuestions` 成功后被后端建议问题覆盖 |
| 节点上下文 | `nodeContext` | `:63-64` | B5：从节点详情「问 AI」进入时为 `{id, name}`，渲染为可清除 chip |
| 会话抽屉 | `showSessions` / `sessions` / `sessionsLoading` / `sessionsHasMore` | `:65-69` | 抽屉开关、会话列表（映射后含 `timeText`）、加载态、是否还有下一页 |
| 提示条 | `banner` | `:70-71` | AI 未开放(403)/额度用尽(429) 等**非致命错误的顶部常驻提示** |

实例字段（不入 data）：`this.nodeId`（`:76`）、`this._sessionsPage`/`this._sessionsTotal`（`:77-78`，抽屉分页进度）、`this._uid`（`:88-90`，账号切换检测），以及 `send` 内初始化的九个流式渲染字段——`_pending`（已收到未渲染的字符队列）、`_shown`（已渲染进 AI 气泡的正文）、`_typing`（首拍标志：加载动画是否已换成正文）、`_aiIndex`（AI 气泡在 messages 中的下标）、`_result`（done 事件结果，等打字机排空再收尾）、`_lastQuestion`（停止时还回输入框用）、`_lastScroll`（跟随滚动节流时间戳）（`:190-196`）、`_stream`（`ai.chatStream` 返回句柄，带 `abort()`，`:205`）、`_timer`（打字机 `setInterval` 句柄，`:222`）。

**气泡对象形状**（`messages` 元素，页面内构造口径）：

| 字段 | 类型 | 来源 | 消费位置 |
|---|---|---|---|
| `_k` | string | 模块级 `_seq` 自增（`:35`、`:187-188`、`:487`） | `wx:key`（WXML `:32`）与失败重试定位（js `:382-390`） |
| `role` | `'user'`/`'assistant'` | 发送侧固定；历史消息非 `user` 一律归 `assistant`（`:488`） | 行方向、头像文案、气泡配色（WXML `:33-36`） |
| `content` | string | 输入文本 / 流式 `_shown`（`:252`）/ done 的 `res.reply`（`:272-276`）/ 历史 `m.content`（`:489`） | 用户气泡与无 `blocks` 时 `<text user-select>`（WXML `:41`） |
| `blocks` | array/null | `util.parseMarkdownLite` 解析 `_shown`/reply 后经 `markLast` 标尾块（`:253`、`:277`、`:301`、`:342`）；仅助手消息解析，用户消息为 null（`:490-491`） | 轻量 markdown 块渲染（WXML `:44-57`） |
| `sources` | array | done 事件 `res.sources`（`:278`）/ 历史 `m.sources`（`:492`）；元素 `{id,title,source,category}`（`.qoder/backend/app/api/routes/ai.py.md` §5.1） | 「参考来源」区块只用 `title`/`source`（WXML `:66-72`） |
| `loading` | boolean（可选） | 发送时占位气泡为 true（`:188`），打字机首拍置 false（`:255-257`） | 三点动画（WXML `:38-40`） |
| `streaming` | boolean（可选） | 打字机首拍置 true（`:258`），done/失败/停止置 false（`:281`、`:303`、`:344`） | 与 `blk.last` 联合渲染闪烁光标（WXML `:47`、`:51`、`:54`） |
| `failed` | boolean | 用户气泡发送失败（`:47`、`:309`）或 AI 气泡回答中断（`:304`） | 重试条（WXML `:61-63`），文案按 role 区分两种 |
| `usedTokens` | number/null（可选） | done 事件 `res.usedTokens`（`:279`） | **WXML 未渲染**（§9） |

### 4.3 生命周期与节点上下文

- `onLoad(options)`（`:74-80`）：解析 `options.nodeId`（`:75-76`，注释「tab 页主要走 globalData.pendingAiNodeId」）、初始化 `_sessionsPage`/`_sessionsTotal`（`:77-78`）、`loadSuggestedQuestions(this.nodeId)`（`:79`）。
- `onShow`（`:82-100`）：① 登录守卫——`app.globalData.loggedIn` 为假即 `wx.reLaunch('/pages/launch/launch')`（`:83-86`，不带 redirect 参数）；② **账号切换清理**——比较 `this._uid` 与当前用户 id，不一致时先 `stopStream()`（上一账号可能还在生成，先中止再清空，否则回调会写进新账号的消息列表，`:91` 行内注释）再清空 `messages/conversationId/title/banner/sessions/showSessions`（`:88-93`），避免 tab 页常驻导致串号展示（`.qoder/REQUIREMENTS.md` §10.5 记为「全项目唯一一处显式的跨账号数据清理」）；③ **消费节点上下文**——读 `app.globalData.pendingAiNodeId`，非空则置 null 并 `applyNodeContext(Number(pendingId))`（`:94-99`；`wx.switchTab` 不支持 query 故走 globalData，写入方为节点详情「问 AI」，`frontend/pages/node-detail/node-detail.js:232-236`）。**该通道在 Phase A 曾不可达（无写入方），`53f2d62` 起打通**。
- `onUnload`（`:103-105`）：`stopStream()`——页面销毁（如登录态失效 reLaunch 回启动页）时中止流式请求，避免回调打到已销毁页面（`:102` 注释）。
- `applyNodeContext(nodeId)`（`:111-124`）：记录 `this.nodeId`，先置 `nodeContext` 占位 `{id, name:''}`（`:115`）并刷新建议问题（`:116`），`march.getNodeDetail(nodeId)` 成功后补全 chip 名称——仅当 `this.nodeId === nodeId` 仍匹配才写入，防串扰（`:119-121`）；失败静默 catch，chip 仍展示 id（`:123`）。
- `clearNodeContext`（`:127-131`）：清 `nodeId`/`nodeContext`，恢复无上下文的默认建议问题。
- `loadSuggestedQuestions(nodeId)`（`:137-146`）：调 `ai.getSuggestedQuestions(nodeId)` → `GET /api/ai/suggested-questions`（不调模型、AI 关闭时仍可用，`backend/app/api/routes/ai.py:262-271`；`nodeId`/`node_id` 双参数名，`:266`），取 `items[].text` 非空文案（`:140`），空数组或失败均回退 `COMMON_QUESTIONS`（`:141`、`:143-145`）。
- 注意：头注释 `:9` 写「非 tab 页」，与 `frontend/app.json` 的 tabBar 注册**不符**，属注释瑕疵（§9）；onShow 守卫本身对 tab 页同样必要（`frontend/AGENTS.md` §4 不变量 5 的守卫口径）。

### 4.4 发送与流式渲染链路

1. 前置闸（`send(text)` `:175-216`）：`sending` 中 toast「AI 正在回答，可点「停止」后再提问」并返回（`:176-179`）；trim 后为空返回（`:180-181`）；超 500 字 toast「问题请控制在 500 字以内」（`:182-185`，与 WXML `maxlength="500"`、后端 `AI_MAX_INPUT_CHARS` 校验构成三道长度闸）。
2. **乐观渲染**（`:187-203`）：concat 用户气泡 + `loading: true` 的 assistant 占位气泡，初始化 `_pending`/`_shown`/`_typing`/`_aiIndex`/`_result`/`_lastQuestion`/`_lastScroll` 七个流式字段（`:190-196`），清空输入框、置 `sending`、清 `banner`（`:197-202`），随即 `scrollToBottom()`（`:203`）。
3. 发起流式（`:205-215`）：`this._stream = ai.chatStream(trimmed, conversationId, this.nodeId, {onStart, onDelta, onDone, onError})`——`onStart` 回填 `conversationId` 与 `title`（title 为空保留旧值，`:206-211`）；`onDelta` → `pushDelta`（`:212`）；`onDone` → `finishWhenDrained`（`:213`）；`onError` → `streamFailed`（`:214`）。
4. **打字机**：`pushDelta(piece)`（`:219-223`）把增量追加进 `_pending` 队列，`_timer` 未启动时懒启动 `setInterval(renderNextChunk, TYPE_TICK_MS)`（`:222`）。`renderNextChunk`（`:229-245`）每拍从队列取一批：批量大小 `max(1, min(TYPE_MAX_PER_TICK, ceil(队长/20)))` 自适应（`:232`，队列越长说明模型吐得越快、取多一点追上进度；队列短则一次一两个字保留逐字观感，`:26-27` 注释），追加进 `_shown` 后 `patchStreaming()` + `followScroll()`（`:233-237`）；队列已空时若 `_result`（done 已到）则 `completeStream`，否则 `stopTimer()` 停表等下一片，省掉空转定时器（`:239-244`）。
5. `patchStreaming`（`:248-261`）：只 setData **单条消息的字段路径** `messages[i].content` / `messages[i].blocks`（`markLast(parseMarkdownLite(_shown))`），不发整个 messages 数组——逐字渲染才不至于卡顿（`:226-227` 注释）；首拍由实例标志 `_typing` 判断（不依赖 setData 后 this.data 是否已同步，`:254-256`），同时把 `loading` 置 false、`streaming` 置 true（`:257-258`）——加载动画就此换成正文 + 光标。
6. `finishWhenDrained(res)`（`:264-267`）：done 事件只记下 `_result`；队列已空立即收尾，否则等打字机排空，避免尾字被一次性糊上去（`:263` 注释）。
7. `completeStream(res)`（`:270-284`）：`stopStreamState()` 后以后端完整正文 `res.reply` 为准（缺省回退 `_shown`，`:272`），写入 `content/blocks/sources/usedTokens`、`loading/streaming` 置 false、`sending` 置 false，再滚底（`:275-283`）。
8. **失败** `streamFailed(err)`（`:290-319`）：先 `stopStreamState()`；**已渲染出正文**则保留半截回答并标 `failed: true`（重试条挂 AI 气泡「回答中断」）+ toast 错误（`:298-306`）；**一个字没出**则 splice 掉空 AI 气泡（`:308`）、`markLastUserFailed` 把提问标失败（`:309`），且 **403/429 → `banner` 顶部常驻**（`:310-311`，注释「不弹一闪而过的 toast」），其余状态码（含 502）与网络错误 → toast `err.message` 或「AI 服务暂时不可用，请稍后重试」（`:296`、`:312-314`）。
9. **停止** `tapStop`（`:322-324`）→ `stopStream(restoreInput)`（`:331-359`）：`_stream` 为空（空闲态）直接返回、不动 messages（`:332`）；否则 `abort()`（`:333`）+ `stopStreamState()`。已渲染正文则保留半截回答——后端会把已推出部分落库，重进会话看到的内容一致（`:327` 注释）；一个字没出则撤掉空 AI 气泡并把本次用户提问一并移除（`:346-354`，后端同样已清库，`:347` 注释），仅 `restoreInput=true`（「停止」按钮；切会话/新建/换账号不塞旧问题，`:328-329` 注释）时把 `_lastQuestion` 还回输入框（`:355`）。
10. 资源清理：`stopStreamState`（`:362-367`）+ `stopTimer`（`:369-374`）清 `_timer`（clearInterval）、`_stream`、`_result`、`_pending`——done/失败/停止三条终止路径共用（`:361` 注释），加上 `onUnload`（`:103-105`）与账号切换（`:91`），**定时器无泄漏路径**。
11. 重试 `tapRetry(e)`（`:380-400`）：`sending` 中返回（`:381`）；按 `data-k` 定位失败气泡（`:382-391`）——失败标记可能挂在用户气泡（没出字）或 AI 气泡（半截回答）上，两种情况都回溯到对应提问（`:392-396`），把 messages 截断到提问之前再 `send(content)` 重发，避免同一问题出现两次（`:376-378` 注释、`:398-399`）。
12. 新建 `tapNew`（`:403-406`）：先 `stopStream()`（不带 restoreInput，`:404`），再清空 messages/conversationId/title/banner/showSessions；下次发送即新建会话。

### 4.5 其余事件处理与会话抽屉

| 处理函数 | 行号 | 行为 |
|---|---|---|
| `onInput` | `:150-152` | 输入框实时同步 `inputText`（**生成中输入框不禁用**，便于想好下一问，WXML `:79` 注释） |
| `tapCommon` | `:155-158` | 点空态/建议问题胶囊直接 `send(dataset.text)` |
| `tapSend` | `:161-168` | 只处理空闲态（生成中该按钮已换成「停止」，WXML `:84-85`）；空输入 toast「请先输入问题」 |
| `scrollToBottom` | `:412-416` | 见 §4.6 |
| `followScroll` | `:419-424` | 生成中跟随滚动，按 `SCROLL_GAP_MS=300ms` 节流（`:418` 注释） |
| `openSessions`/`closeSessions`/`noop` | `:427-436` | 抽屉开（并 `loadSessions(true)` 拉第一页）/关/空函数（`catchtap` 阻止抽屉内点击冒泡到遮罩，WXML `:90`） |
| `loadMoreSessions` | `:439-442` | `sessionsHasMore` 且非加载中才 `loadSessions(false)` 拉下一页（入口 WXML `:106-108`「加载更多」） |
| `loadSessions(reset)` | `:448-474` | `ai.listConversations(page, SESSION_PAGE_SIZE)`（`:451`）；映射 `title||'未命名会话'`/`preview`/`messageCount`/`timeText: util.formatRelative(updatedAt||createdAt)`（`:454-460`）；`reset` 决定覆盖或追加（`:461`）；`_sessionsPage`/`_sessionsTotal` 记进度、`sessionsHasMore = 已加载数 < total 且本页非空`（`:462-468`）；失败 toast（`:470-473`） |
| `tapSession` | `:478-508` | 先 `stopStream()`——切会话即放弃当前生成，半截回答后端已落库、切回来仍能看到（`:481-482` 注释）→ `wx.showLoading` 带 mask（`:483`）→ `ai.getConversation(id)` → 全量映射历史消息（role 非 `user` 一律归 `assistant`，仅助手消息做 markdown 解析，`:486-493`）→ 关抽屉、清 banner、滚底（`:494-502`）；成功/失败均 `hideLoading`（`:501`、`:505`，无悬挂） |
| `tapDeleteSession` | `:511-540` | `wx.showModal` 二次确认（confirmColor `#C8102E`，`:514-517`）→ 删的是当前会话且还在生成则先 `stopStream()`，别再往已删除的会话里写增量（`:520-521`）→ `ai.deleteConversation(id)`（`:522`，后端物理删除）→ 本地过滤（`:524`）；**删的是当前会话则同时清空对话区**（`:526-531`） |

### 4.6 滚动到底策略（`:412-416`）

`scroll-view` 用 `scroll-into-view="{{toView}}"` + `scroll-with-animation`（WXML `:20`）；消息列表末尾是固定底部锚点 `<view id="ai-bottom" class="ai-scroll-pad">`（WXML `:76`）。scroll-into-view 值不变不会重复触发，故 `scrollToBottom` 先把 `toView` 清空（`:414`）、再于 `wx.nextTick` 置为 `BOTTOM_ANCHOR`（`:415`，下一帧是为了等新气泡渲染完，`:408-411` 注释）；messages 为空直接返回（`:413`）。

### 4.7 加载与错误状态矩阵

| 状态 | 触发条件 | 呈现 | 行号 |
|---|---|---|---|
| 空态引导 | `messages.length === 0` | 灯笼图标 + 说明文案 + 建议问题胶囊（后端接口优先，失败回退硬编码 4 条） | WXML `:22-30`；js `:137-146` |
| 节点上下文 chip | `nodeContext` 非空 | 粉底横条「正在聊节点 <名称> ✕」，✕ 清除 | WXML `:13-17`；wxss `:47-74` |
| 消息级加载 | send 后至首个增量前 | assistant 占位气泡内三点动画 | js `:188`；WXML `:38-40` |
| 逐字生成中 | 首个增量后至 done/停止/失败前 | 正文按拍追加 + 最后一块末尾闪烁光标 | js `:248-261`；WXML `:47`、`:51`、`:54` |
| 全局请求中 | `sending === true` | 发送按钮变灰色「停止」（`tapStop`）；重发/重试被闸，新建/切会话/删当前会话改为先中止再生效；**输入框仍可用** | js `:176`、`:381`、`:404`、`:482`、`:521`；WXML `:79-85` |
| 失败可重试（没出字） | `streamFailed` 且 `_shown` 为空 | 用户气泡下红色「发送失败，点击重试 ↻」 | js `:307-309`；WXML `:61-63` |
| 失败可重试（半截回答） | `streamFailed` 且已有正文 | 保留半截回答并标 `failed`，「回答中断，点击重试 ↻」+ toast | js `:298-306`；WXML `:61-63` |
| 403/429 | `err.statusCode` 命中且没出字 | 顶部橙色 banner **常驻**，直至下次发送（js `:201`）、新建（`:405`）或切换会话（`:499`）时清除 | js `:310-311`；WXML `:10` |
| 其余错误（502/网络/400/404） | `streamFailed` 兜底 | toast `err.message` 或「AI 服务暂时不可用，请稍后重试」 | js `:296`、`:312-314` |
| 抽屉加载/空/加载更多 | `sessionsLoading` / 空列表 / `sessionsHasMore` | 「加载中…」/「暂无历史会话」/「加载更多」（加载中变「加载中…」） | WXML `:96-97`、`:106-108`；js `:450`、`:464-468` |
| 切换会话加载 | `tapSession` 期间 | `wx.showLoading` 带 mask，成功与失败路径均 `hideLoading`（无悬挂） | js `:483`、`:501`、`:505` |

## 4-1. WXML 专章（`ai-chat.wxml`，112 行）

- 结构：顶部工具条（☰ 会话 / 标题 / ＋ 新建，`:3-7`）→ banner（`:9-10`）→ 节点上下文 chip（`:12-17`）→ 消息 `scroll-view`（`:20-77`：空态建议问题引导 `:22-30`、消息行 `:32-75`、底部锚点 `:76`）→ 输入区（`:79-86`）→ 会话抽屉（`:88-111`）。
- 消息行：头像「我/AI」+ 气泡；加载态渲染三点动画（`:38-40`）；用户消息或无 `blocks` 时走 `<text user-select>` 纯文本、支持长按复制（`:41`）；AI 回答走轻量 markdown 块渲染（`:44-57`，标题 `h`/列表 `li`/段落三种块，块内 `segs` 再分加粗段 `seg.b`；`wx:key` 用块级 `_bk`、段级 `_sk`），`blk.last && item.streaming` 时在正文末尾接 `<text class="ai-cursor">` 闪烁光标（`:47`、`:51`、`:54`，`:42-43` 注释说明与 `util.parseMarkdownLite` 的结构对应关系）。
- 失败重试条（`:60-63`）：文案按宿主 role 区分——挂用户气泡为「发送失败，点击重试 ↻」、挂 AI 气泡为「回答中断，点击重试 ↻」（`:62`）；`data-k` 供 js 回溯定位对应提问（js `:380-400`）。
- 「参考来源」区块展示 `sources` 的 `《title》+ source`（`:65-72`，对应后端只下发**已发布知识**的来源，`.qoder/backend/app/api/routes/ai.py.md` §5.1）。
- 输入区（`:79-86`，注释「生成中输入框仍可用（便于想好下一问），发送按钮换成「停止」」）：`<textarea>`（`:81-83`）属性逐项——

| 属性 | 值 | 作用 |
|---|---|---|
| `value="{{inputText}}"` | 受控 | `onInput` 回写（js `:150-152`），发送即清空（js `:199`） |
| `maxlength="500"` | 500 | 输入硬上限，与 js 侧 500 字闸（`:182-185`）、后端 `AI_MAX_INPUT_CHARS` 同口径（`.qoder/REQUIREMENTS.md` §10.2） |
| `auto-height` | — | 随内容增高，WXSS `max-height: 200rpx` 封顶（wxss `:280`） |
| `confirm-type="send"` + `bindconfirm="tapSend"` | — | 键盘右下角为「发送」键，按下即触发 `tapSend`（js `:161-168`） |
| **无 `disabled`** | — | `6a4dbb7` 起生成中不再禁用输入框（旧版为 `disabled="{{sending}}"`）；发送互斥改由 js 闸拦截并 toast 提示（js `:176-179`） |
| `cursor-spacing="20"` | 20 | 光标与键盘的间距，避免气泡区遮挡 |
| `show-confirm-bar="{{false}}"` | false | 隐藏 iOS 键盘顶部「完成」栏 |
| `adjust-position` | 未设置（默认 true） | 键盘弹出时页面上推；页面为 `100vh` flex 布局（wxss `:2-8`），输入条贴底随之上移 |

- 发送/停止按钮双态（`:84-85`）：`sending` 时渲染 `.ai-send.ai-stop`「停止」（`bindtap="tapStop"`），空闲时渲染「发送」（`!inputText` 加 `.ai-send-disabled` 灰色样式但 `bindtap` 仍在，空输入由 `tapSend` 内 toast 拦截）。两者均非 `<button>` 而是 view。
- 会话抽屉（`:88-111`）：遮罩 `bindtap="closeSessions"`、面板 `catchtap="noop"` 阻止冒泡（`:89-90`）；条目展示标题/预览/时间·条数（`:98-103`）+「删除」按钮（`catchtap="tapDeleteSession"`，`:104`）；`sessionsHasMore` 时显示「加载更多」（`:106-108`，文案随 `sessionsLoading` 在「加载中…」/「加载更多」间切换）。
- `wx:key` 全部用数据唯一字段（`_k`、`_bk`、`_sk`、`*this`、`id`、`conversationId`），无原生方法调用——符合 `frontend/AGENTS.md` §5.2 两条约束。

## 4-2. WXSS 专章（`ai-chat.wxss`，409 行）

| 区块 | 关键类 | 行号 | 要点 |
|---|---|---|---|
| 页面骨架 | `.ai-page` | `:2-8` | flex 纵向 + `height: 100vh`；顶栏/banner/chip/输入条 `flex-shrink: 0`、消息区 `flex: 1`（`:18`、`:38`、`:48`、`:78`、`:268`） |
| 顶部工具条 | `.ai-topbar/.ai-toptitle/.ai-topbtn` | `:11-34` | 标题 `max-width: 380rpx` 单行省略（`:24-27`）；按钮长征红 |
| 提示条 | `.ai-banner` | `:37-44` | 橙底 `#FFF3E0` 常驻横条，配合 WXML `wx:if="{{banner}}"` |
| 节点上下文 chip | `.ai-ctx*` | `:47-74` | 粉底 `#FDECEF` 横条；名称单行省略（`:61-68`）；「✕」灰色（`:70-74`） |
| 消息滚动区 | `.ai-scroll/.ai-scroll-pad` | `:77-85` | `overflow: hidden` 交由 scroll-view；底部 24rpx 留白垫（即锚点元素） |
| 空态 | `.ai-empty*/.ai-common-item` | `:88-121` | 常见问题为白底红字胶囊 + 轻阴影 |
| 气泡 | `.ai-row/.ai-avatar/.ai-bubble-*` | `:124-175` | 用户行 `row-reverse`（`:129-131`）+ 红渐变气泡、右上顶角收小 4rpx（`:168-172`）；AI 白底、左上顶角收小 4rpx（`:162-167`）；`word-break: break-word`（`:160`）+ `.ai-text` `white-space: pre-wrap` 保留换行（`:173-175`） |
| markdown 块 | `.ai-md*` | `:178-212` | `.ai-md` 改回 `white-space: normal`（`:178-180`）；加粗 `.ai-md-b`（`:189-191`）；标题 h1-h4 字号递减（`:192-200`）；列表 flex + 深红标记（`:201-212`） |
| 加载三点 | `.ai-typing/@keyframes aiBlink` | `:215-233` | 纯 CSS 动画，点间 0.2s/0.4s 延迟错峰（`:228-229`） |
| 失败/来源 | `.ai-failed/.ai-sources*` | `:236-264` | 重试条红色小字；来源为米色半透明卡 |
| 输入区 | `.ai-inputbar/.ai-input/.ai-send*` | `:267-303` | 底部 `calc(16rpx + env(safe-area-inset-bottom))` 并 constant() 双写兼容全面屏（`:272-273`）；textarea `min/max-height` 64/200rpx（`:279-280`）；`.ai-stop` 灰底、尺寸沿用 `.ai-send` 避免输入区抖动（`:300-303` 注释） |
| 闪烁光标 | `.ai-cursor/@keyframes aiCursorBlink` | `:306-318` | 4rpx 宽长征红竖条，`step-end` 0.9s 闪烁，跟在逐字输出正文末尾 |
| 会话抽屉 | `.ai-mask/.ai-drawer/.ai-drawer-more/.ai-session-*` | `:321-409` | fixed 全屏半透明遮罩 `z-index: 100`（`:321-326`）；左侧 78% 宽面板 `aiSlideIn` 0.25s 滑入（`:327-339`）；「加载更多」红字居中（`:366-371`）；条目标题/预览单行省略（`:382-397`） |

- 配色遵循全局约定：导航主色 `#C8102E`、背景 `#F7F1E5`（`frontend/AGENTS.md` §2）。
- 三处 CSS 动画（三点 `aiBlink`、光标 `aiCursorBlink`、抽屉 `aiSlideIn`）均随 `wx:if`/`streaming` 条件移除元素自然停止，无 JS 清理需求；**本页唯一需要 JS 回收的句柄是打字机 `setInterval`**（`stopTimer`/`stopStreamState`/`onUnload`，js §4.4 第 10 条）。

## 4-3. JSON 专章（`ai-chat.json`，5 行）

仅 3 项：`navigationBarTitleText: "AI 历史助手"`、红底 `#C8102E`、白字——与全局 window 配置一致，无 `usingComponents`（全小程序零自定义组件，`.qoder/PROJECT.md` §8「代码级技术债」第 14 项）。tabBar 文案「AI 问答」在 `frontend/app.json`，页面 json 不管 tabBar 配置。

## 5. 输入与输出

- 输入：`onLoad options.nodeId`（`53f2d62` 起有真实入口——节点详情「问 AI」写 `app.globalData.pendingAiNodeId` 后 switchTab，onShow 消费，`frontend/pages/node-detail/node-detail.js:232-236`，§4.3）；用户输入与点击事件。
- 调用的 service → 后端路径（契约细节见 `.qoder/frontend/services/ai.js.md` §4 与 `.qoder/backend/app/api/routes/ai.py.md` §4-§5）：
  | 页面调用点 | service | 后端 |
  |---|---|---|
  | `:205` | `ai.chatStream(text, conversationId, nodeId, handlers)` | `POST /api/ai/chat/stream`（SSE，`enableChunked`；`ai.js:92-145`） |
  | `:138` | `ai.getSuggestedQuestions(nodeId)` | `GET /api/ai/suggested-questions`（`ai.js:189-193`；`ai.py:262-271`） |
  | `:117` | `march.getNodeDetail(nodeId)` | 节点详情（仅补节点上下文 chip 的名称展示） |
  | `:451` | `ai.listConversations(page, SESSION_PAGE_SIZE)` | `GET /api/ai/conversations`（`ai.js:154-159`） |
  | `:484` | `ai.getConversation(id)` | `GET /api/ai/conversations/{id}` |
  | `:522` | `ai.deleteConversation(id)` | `DELETE /api/ai/conversations/{id}` |
- **SSE 事件序列**（后端 `ai.py:110-178`，前端解析 `ai.js:109-126`）：前置检查失败（403 AI 未开放 / 429 额度用尽 / 400 参数 / 502 上游不可用）发生在**开流之前**，仍走普通 JSON 状态码（`ai.py:124`）；开流后先推 `start`（带 `conversationId`/`title`），随后逐段 `delta` 增量，正常结束推 `done`（带完整 `reply`/`sources`/`usedTokens`，`ai.py:166-172`）；流中途上游 `LlmError` → 本条回答作废并推 `error` 事件（`ai.py:156-162`），页面 `onError` 走 `streamFailed`；用户「停止」断开连接后，后端把已推出部分落库并结算会话（`ai.py:178`，与 js `:327` 注释口径一致）。
- 降级路径：`wx.request` 不支持 `enableChunked`（能力探测 `ai.js:95`）、或开流前 401 / 未收到任何增量即网络错误时，`ai.js` 自动回退 `plainChatStream`（`ai.js:51-73`）一次性调 `POST /api/ai/chat`，页面回调协议不变（`ai.js:131-133`）。
- 错误码语义（页面可观察）：401 由 `request.js` 静默重登重试；403=AI 总开关关闭、429=日限额用尽 → banner；**502=上游 LLM 异常**——自 `b712d81` 起上游由 `LLM_PROVIDER` 按双供应商门面分派（`openai`=阿里云百炼 / `cloudbase`=腾讯云 CloudBase Agent，`backend/app/services/llm_service.py:1-22`），供应商配置无效、当前供应商凭证缺失/失效或上游调用失败统一抛 `LlmError`（`backend/app/services/llm_base.py:16-25`）映射 502（`ai.py:5` 映射注释、`:56-57`）→ toast；400/404/422 → toast（矩阵见 `.qoder/backend/app/api/routes/ai.py.md` §5）。
- 各端点/事件响应中**本页实际消费的字段**（完整字段清单见 `.qoder/backend/app/api/routes/ai.py.md` §5，不复述）：

| 端点/事件 | 本页消费 | 未消费 |
|---|---|---|
| `POST /chat/stream` `start` | `conversationId`、`title`（为空保留旧值，`:206-211`） | 其余字段 |
| `POST /chat/stream` `delta` | 增量文本 → `_pending` 队列（`:212`、`:219-223`） | — |
| `POST /chat/stream` `done` | `reply`（收尾权威正文，`:272`）、`sources[]`（`:278`）、`usedTokens`（存入气泡但不渲染，`:279`） | — |
| `GET /suggested-questions` | `items[].text`（`:140`） | 其余字段 |
| `GET /conversations` | `items[].{conversationId,title,preview,messageCount,updatedAt,createdAt}`（`:454-460`）、`total`（分页进度，`:463`） | — |
| `GET /conversations/{id}` | `conversationId`、`title`、`messages[].{role,content,sources}`（`:486-500`） | `createdAt/updatedAt`、`messages[].id/createdAt` |
| `DELETE /conversations/{id}` | 无（成功即本地过滤 + 固定「已删除」toast，`:522-533`） | `message` |

## 6. 依赖关系

- 上游：`frontend/services/ai.js`（`:12`）、`frontend/services/march.js`（`:13`，仅 `getNodeDetail`）、`frontend/utils/util.js` 的 `formatRelative`（`:55`）与 `parseMarkdownLite`（`:130`）（`:14`；`.qoder/frontend/utils/util.js.md` §4）、`getApp().globalData`（`:11`、`:83`、`:88`、`:95-97`）。**无任何 Storage 读写、无出站页面跳转**（除未登录 reLaunch 启动页 `:84`；`.qoder/REQUIREMENTS.md` §10.5「`pages/ai-chat` 无出站页面跳转」）。
- 入口：tabBar（`frontend/app.json`）；节点详情「问 AI」不直接跳转本页，走 `globalData.pendingAiNodeId` + `wx.switchTab`（`node-detail.js:232-236`）。
- 后端契约对端：`.qoder/backend/app/api/routes/ai.py.md`、`.qoder/backend/app/services/ai_chat_service.py.md`（多轮上下文由后端拼接注入，无状态，`.qoder/REQUIREMENTS.md` §10.4）。上游 LLM 适配：`backend/app/services/llm_service.py`（门面，按 `LLM_PROVIDER` 分派）→ `llm_openai.py` / `llm_cloudbase.py`，共享类型在 `llm_base.py`。

## 7. 业务规则

1. **响应为 SSE 真流式、打字机逐字渲染**（`6a4dbb7` 起）：后端 `POST /api/ai/chat/stream` 按 `start → delta* → done/error` 推送（§5）；页面把增量先入 `_pending` 字符队列，由 `TYPE_TICK_MS=45ms` 定时器按自适应批量渲染（队列越长批量越大、单拍上限 12 字，`:232`），规避「模型常整段吐出，直接 setData 会一跳一大段」（`:4-5`、`:26-27` 注释）。done 时以后端完整 `reply` 为准收尾（`:272`）；中途失败/停止保留半截回答并给重试入口（`:298-306`、`:339-345`）。
2. **停止语义**：「停止」只中止前端连接与渲染；后端会把已推出部分落库，重进会话看到的内容一致（`:327` 注释、`ai.py:178`）；一个增量都没收到时前端撤掉本次提问与空气泡（`:346-354`），后端对应丢弃本次提问（`:347` 注释）。仅「停止」按钮（`restoreInput=true`）把问题还回输入框，切会话/新建/换账号不塞旧问题（`:328-329`、`:355`）。
3. **403（AI 未开放）降级路径**：后端 `AI_ENABLED=false` 时抛 `AiDisabledError` → 403「AI 助手当前未开放，请稍后再试」（`.qoder/backend/app/api/routes/ai.py.md` §7）。页面把 403/429 文案转为**顶部常驻 banner**（`:310-311`），用户仍可浏览历史会话（会话读写端点不校验 AI 开关，同文 §4）。AI 的 403 **不带** `X-Account-Status`/`X-Activity-Status` 头，不会触发 `request.js` 的清会话或活动页跳转（`.qoder/frontend/services/ai.js.md` §5）。
4. **上游配置缺失/无效是 502 而非 403**（如实记录）：自 `b712d81` 起 AI 上游由后端 `LLM_PROVIDER` 决定、双供应商可切换（`openai`=阿里云百炼 / `cloudbase`=腾讯云 CloudBase Agent，`backend/app/services/llm_service.py:1-22`）；供应商取值无效、当前供应商凭证缺失/失效或上游调用失败统一抛 `LlmError`（`backend/app/services/llm_base.py:16-25`）→ 路由映射 **502**（`ai.py:5`、`:56-57`），页面走 toast 分支（`:312-314`）。开发环境当前为 `cloudbase`（`backend/.env:38`），上线前须把 `.env.prod` 切回 `openai`（`backend/.env.prod:48` 告警注释）。另有部署级事实：**生产库缺 AI 迁移 021/022**（`.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 3 项），真机真实上游全链路**待验证**（§9）。
5. **会话归属与越权**：归属一律后端 JWT 判定、前端不传 user_id（`:6` 头注释；`.qoder/backend/app/api/routes/ai.py.md` §7）；越权时 chat=400、详情/删除=404，页面按普通错误 toast。
6. **连续对话**：`conversationId` 为空新建、非空追问，后端注入最近 `AI_CONTEXT_TURNS` 轮历史（`:3` 头注释；`.qoder/REQUIREMENTS.md` §10.4）；新会话 id/title 由 `start` 事件回填（`:206-211`）。
7. **账号切换隔离**：见 §4.3 onShow——清理前先 `stopStream()`，防旧账号的生成回调写进新账号消息列表（`:91`）。
8. **并发口径**：`sending` 只闸发送与重试两条路径（`:176-179` toast「AI 正在回答，可点「停止」后再提问」、`:381`）；新建/切会话/删当前会话**不被闸**，改为先 `stopStream()` 放弃当前生成再继续执行（`:404`、`:482`、`:521`）；生成中发送按钮变「停止」（WXML `:84-85`）。
9. **限额口径**：429 只统计成功调用，失败不消耗额度（`.qoder/backend/app/api/routes/ai.py.md` §7）；前端不做本地计数。

## 8. 修改约束

1. **打字机三件套不可拆**：`_pending` 队列、`setInterval` 定时器、按消息路径的 setData patch（`messages[i].content/blocks/loading/streaming`）配套工作（`:219-261`）；改成整数组 setData 会让逐字渲染卡顿，绕过队列直接 setData 会退回「一跳一大段」。批量自适应公式（`:232`）与 `TYPE_TICK_MS`/`TYPE_MAX_PER_TICK`（`:28-29`）耦合，调节奏须三处一起评估。
2. **定时器清理依赖 `stopStreamState`/`stopTimer` 共用**（`:362-374`）：done、失败、停止三条终止路径加 `onUnload`（`:103-105`）、账号切换（`:91`）都走这里；新增终止路径必须复用，否则 `setInterval` 泄漏（旧版非流式时本页零定时器，该约束为 `6a4dbb7` 新引入）。
3. `_k` 同时是 `wx:key` 与失败重试定位键（WXML `:32`、`:61`；js `:382-390`），其「单调递增、页面内唯一」的生成方式（`:35`、`:187-188`、`:487`）不可改，否则列表复用与重试回溯出错。
4. `BOTTOM_ANCHOR` 固定锚点 + 「先清空再定位」（`:412-416`，WXML `:76`）：scroll-into-view 值不变不会重复触发，删掉清空步骤会导致第二次滚动失效；`followScroll` 的 300ms 节流（`:419-424`）与逐字渲染的每拍 setData 开销配套，勿单独去掉。
5. 500 字前端闸（`:182-185`）与 WXML `maxlength="500"`（WXML `:82`）、后端 `AI_MAX_INPUT_CHARS` 同口径，改上限须三处同步。
6. 403/429 分流依赖 `request.js` 在 Error 上挂 `statusCode`（`.qoder/frontend/services/request.js.md` §5）；`streamFailed` 的「有字保留 / 无字撤回」分支依赖 `_shown` 快照（`:294`、`:298`），`stopStream` 的空闲态保护依赖 `_stream` 为 null（`:332`）。
7. 状态码分布（chat 越权 400、详情/删除越权 404）不要「顺手统一」，本页与 `ai.js` 的错误提示依赖当前分布（`.qoder/backend/app/api/routes/ai.py.md` §8）。
8. `nodeId` 通道有两条入口（onLoad query + `globalData.pendingAiNodeId`，`:74-99`），tab 页场景实际走后者；删除任一条都会破坏节点上下文追问（`.qoder/REQUIREMENTS.md` §14「`ai-chat` 的 `nodeId` 参数通道」行）。
9. tab 页常驻：新增本地状态时必须考虑 onShow 的账号切换清理清单（`:92`）是否需要同步扩充，以及生成中的流式回调是否会写进新账号（`:91` 先例）。

## 9. 当前实现状态

- **已实现**：SSE 真流式逐字输出 + 停止 + 半截回答保留（`6a4dbb7`）；轻量 markdown 渲染与闪烁光标（`c135f33`）；节点上下文追问 chip、建议问题后端化、会话抽屉分页与「加载更多」（`53f2d62`）；多轮对话、乐观渲染 + 失败重试、空态引导、来源展示、会话抽屉（列表/切换/删除）、403/429 banner、账号切换清理（含流式中止）、登录守卫（`0052108` 打底）。验收情况见 `docs/迭代记录.md` 各提交条目（§10）。
- **存在问题 / 已知事项**：
  1. 头注释 `:9`「非 tab 页」与 `frontend/app.json` 的 tabBar 注册不符（§4.3），属注释瑕疵，待修正。
  2. `usedTokens` 存入消息对象（`:279`）但 WXML 未渲染，预留用途**待确认**。
  3. **抽屉分页参数名错配、当前「巧合无害」**：后端 `GET /api/ai/conversations` 的 query 参数名是 `page_size`（`ai.py:189`），而 `ai.js` 发的是 `pageSize`（`ai.js:154-159`），被静默忽略、恒用默认 20；恰与页面 `SESSION_PAGE_SIZE=20`（`:24`）同值，故分页进度与「加载更多」目前工作正常——但这是巧合不是契约，任一侧单独改值即静默失效（修复归属在 `frontend/services/ai.js`；`.qoder/backend/app/api/routes/ai.py.md` §9）。
  4. 长会话详情不分页、一次全量返回（`:484-493`；`.qoder/backend/app/api/routes/ai.py.md` §9）。
  5. 真机真实上游全链路**待验证**（`.qoder/PROJECT.md` §8「待验证项」段；`.qoder/REQUIREMENTS.md` §10.6）：自 `b712d81` 起上游由 `LLM_PROVIDER` 分派（开发当前 `cloudbase`、生产要求 `openai`），流式链路需按两个供应商分别验收。
- **待开发**：本页专属待开发项无（原「`nodeId` 节点上下文追问入口（Phase B）」已由 `53f2d62` 落地，§4.3）。管理后台 AI 子页面仅部分有真实后端接口（运行概览/调用记录无接口），属管理端范围，与本页无直接耦合——见 `.qoder/ARCHITECTURE.md` §11.3「管理后台 AI 子页面：运行概览 / 调用记录」行、`.qoder/REQUIREMENTS.md` §10.6 同名行。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/ai-chat`，共 **4 个提交**，按时间倒序。各提交均在 `docs/迭代记录.md` 有对应条目（按提交号检索）。

### 2026-10-22（文档同步，本页源码零改动）
- 需求：本文档在 `0052108` 建档后未再更新，欠 `53f2d62`（B5 节点上下文/建议问题/会话分页）、`c135f33`（轻量 markdown 渲染）、`6a4dbb7`（SSE 真流式）三个源码提交的实质性功能描述；本次以补 `6a4dbb7` 欠账为重点——流式消费、打字机渲染、停止/重试、事件序列与错误处理、`data` 字段与定时器清理已全文记入 §4/§5/§7/§8——并按当前源码全面校正 §1-§9；同时按 `c660727`/`b712d81` 更新上游口径：AI 上游由后端 `LLM_PROVIDER` 按双供应商门面分派（`openai`=阿里云百炼 / `cloudbase`=腾讯云 CloudBase Agent，当前开发为 `cloudbase`，上线前须切回 `openai`）。本次 admin/frontend 源码未改，属文档同步。
- 修改内容（仅本文档）：§1 四件套行数 256/87/317/5 → 541/112/409/5；§2「非流式」改为 SSE 真流式；§3 补三次提交的需求演进；§4 全量重写（常量与工具函数、`data` 与九个流式实例字段、气泡形状含 `blocks`/`streaming`、生命周期含 `onUnload` 与节点上下文、流式发送链路与打字机、停止/重试、抽屉分页、状态矩阵）；§4-1/§4-2 按新行号刷新并补 chip、markdown 块、闪烁光标、停止按钮、「加载更多」；§5 调用点表改为流式事件、补 SSE 事件序列与降级路径、502 语义去「CloudBase」字样改供应商中立口径；§6 补 `march`/`parseMarkdownLite`/node-detail 入口依赖；§7 规则 1/2/4/8 重写（流式、停止语义、502 供应商口径、并发口径）；§8 约束重写（打字机、定时器清理、锚点、长度闸）；§9 状态更新（`nodeId` 通道已落地、抽屉已分页、`pageSize` 参数名错配巧合无害）。既有 `0052108` 条目按 `.qoder/README.md` §3.11 原文保留。
- 关联文件：本文档；校正依据 `frontend/pages/ai-chat/ai-chat.js`、`ai-chat.wxml`、`ai-chat.wxss`、`frontend/services/ai.js`、`frontend/utils/util.js`、`frontend/pages/node-detail/node-detail.js`、`backend/app/api/routes/ai.py`、`backend/app/services/llm_service.py`、`llm_base.py`、`backend/.env`、`backend/.env.prod`。
- 测试结果：无（纯文档改动，未运行小程序、未改任何源码）。

### 2026-10-19（`6a4dbb7`，16:39）
- 需求：AI 问答由「整段返回」改真流式：后端 SSE 逐字下发、前端打字机逐字渲染、可随时停止、失败/停止保留半截回答（本文档 §2、§4.4、§7 规则 1-2 即对该提交的补记）。
- 修改内容（涉本页，行号为当前位置）：发送链路由 `ai.chat` 改 `ai.chatStream`（`start`/`delta`/`done`/`error` 回调，现 `:205-215`）；新增字符队列 `_pending` + 45ms `setInterval` + 按消息路径 setData 的打字机（现 `:219-261`）；发送按钮生成中变「停止」（现 `:322-359`；WXML 现 `:84`），输入框生成中不再禁用（WXML 现 `:81-83`）；失败/停止保留半截回答、重试条区分「发送失败/回答中断」（现 `:290-319`、`:380-400`；WXML 现 `:61-63`）；气泡新增 `streaming` 字段与正文末尾闪烁光标（WXML 现 `:47`、`:51`、`:54`；wxss 现 `:306-318`）；新增 `onUnload` 中止流式（现 `:103-105`）。
- 关联文件：`frontend/services/ai.js`（`chatStream` 与 `plainChatStream` 降级）、`backend/app/api/routes/ai.py`（`/chat/stream` SSE）等后端同批文件（详见 `docs/迭代记录.md` 的 `6a4dbb7` 条目）。
- 测试结果：见 `docs/迭代记录.md` 的 `6a4dbb7` 条目。

### 2026-10-18（`c135f33`，12:50）
- 需求：AI 回答支持轻量 markdown（加粗/标题/列表/段落），替代纯文本渲染。
- 修改内容（涉本页，行号为当前位置）：助手气泡新增 `blocks` 字段，经 `util.parseMarkdownLite` 分块（现 js `:253`、`:277`、`:491`）；WXML 增加标题/列表/段落三种块渲染与加粗分段（现 `:44-57`）；WXSS 增加 `.ai-md*` 块样式（现 `:178-212`）；用户消息保持纯文本（现 WXML `:41`）。
- 关联文件：`frontend/utils/util.js`（`parseMarkdownLite`）。
- 测试结果：见 `docs/迭代记录.md` 的 `c135f33` 条目。

### 2026-10-18（`53f2d62`，11:53）
- 需求：十项增强 B5 批，本页落地三项——节点上下文追问、建议问题后端化、会话抽屉分页（§3）。
- 修改内容（涉本页，行号为当前位置）：新增 `nodeContext` 状态与 chip（现 js `:63-64`、`:111-131`；WXML 现 `:12-17`；wxss 现 `:47-74`）；`onShow` 增加 `globalData.pendingAiNodeId` 消费（现 `:94-99`，写入方 `frontend/pages/node-detail/node-detail.js:232-236`）；`loadSuggestedQuestions` 优先调 `GET /api/ai/suggested-questions`、失败回退硬编码（现 `:137-146`）；抽屉分页 `SESSION_PAGE_SIZE=20` + `sessionsHasMore` + `loadMoreSessions`（现 js `:24`、`:69`、`:439-474`；WXML 现 `:106-108`）。
- 关联文件：`frontend/services/ai.js`（`getSuggestedQuestions` 及会话列表分页参数）、`frontend/services/march.js`、`frontend/pages/node-detail/node-detail.js`、`backend/app/api/routes/ai.py`（`/suggested-questions`、`/conversations` 分页）。
- 测试结果：见 `docs/迭代记录.md` 的 `53f2d62` 条目。

### 2026-10-17（`0052108`，11:06）
- 需求：AI 智能中心 Phase A 小程序侧——历史助手聊天页；底部「情报」tab 换防为「AI 问答」。
- 修改内容：新建 `frontend/pages/ai-chat/` 四件套（本页全部代码）；`frontend/app.json` 注册页面并调整 tabBar 第 3 项；同批新建 `frontend/services/ai.js`。
- 关联文件：`frontend/services/ai.js`、`frontend/app.json`、`frontend/utils/util.js`（`formatRelative` 消费方，`.qoder/frontend/utils/util.js.md` §10）；后端对端 `1600074`。
- 测试结果：见 `docs/迭代记录.md` 的 `0052108` 条目（automator ai-chat 4/4、tab 换防 5/5；真机真实 Agent 全链路当时标记待验证）。
