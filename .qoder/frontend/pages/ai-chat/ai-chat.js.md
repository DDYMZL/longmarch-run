# ai-chat.js（页面级合一：ai-chat.js / ai-chat.wxml / ai-chat.wxss / ai-chat.json）

## 1. 文件路径

- `frontend/pages/ai-chat/ai-chat.js`（256 行）
- `frontend/pages/ai-chat/ai-chat.wxml`（87 行）
- `frontend/pages/ai-chat/ai-chat.wxss`（317 行）
- `frontend/pages/ai-chat/ai-chat.json`（5 行）

四件套合计 665 行。按 `.qoder/README.md` §1「页面级合一例外」规则合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

「AI 智能中心 · 历史助手」聊天页：长征历史多轮问答 + 会话抽屉（查看/切换/删除本人会话）。它是 **tabBar 第 3 项「AI 问答」**（`frontend/app.json:54-59`），也是 `frontend/services/ai.js` 的**唯一消费页**（`.qoder/frontend/services/ai.js.md` §6）。**非流式**：一问一答整段返回，等待期以三点加载占位气泡呈现（§7.1）。

四件套关系：js 承担会话状态机、发送/重试、抽屉数据与滚动定位；wxml 纯条件渲染（消息行/空态/banner/抽屉四块互不嵌套复用）；wxss 自带全部页面级样式（不依赖 app.wxss 的 `.card`/`.anim-card` 体系，与多数子页不同）；json 仅导航栏 3 项配置。四文件只服务本页，无被其他页面引用的模板/样式。

## 3. 业务需求

- AI 智能中心 V1.0 Phase A §3.1「历史助手」（连续对话、来源引用、跨账号隔离、日限额），随 `0052108`（2026-10-17）交付；同提交把底部「情报」tab 换防为「AI 问答」，quiz 降级为首页情报卡入口子页（`.qoder/REQUIREMENTS.md` §5.4「底部「情报」tab」行；`git log -S "ai-chat" -- frontend/app.json` 仅命中 `0052108` 一个提交）。后端对端为同日 `1600074`（`.qoder/backend/app/api/routes/ai.py.md` §10）。
- 原始需求书《长征步迹 AI 智能中心开发需求 V1.0》未入库，§3.1 原文措辞**待确认**（`.qoder/backend/app/api/routes/ai.py.md` §3）。

## 4. 核心功能

### 4.1 `data` 状态字段（`ai-chat.js:23-37`，按关注点分组）

| 分组 | 字段 | 行号 | 说明 |
|---|---|---|---|
| 对话状态 | `messages` | `:24` | 气泡数组，元素 `{_k, role, content, sources, failed?, loading?, usedTokens?}`；`_k` 为模块级 `_seq`（`:20`）自增生成的渲染键 |
| | `conversationId` / `title` | `:25-26` | 当前会话 id（null=下次发送新建）与标题（顶栏展示，`:5` WXML） |
| 输入状态 | `inputText` / `sending` / `toView` | `:27-29` | 输入框内容；发送中互斥锁；scroll-into-view 锚点 |
| 空态引导 | `commonQuestions` | `:30` | 4 条常见问题常量 `COMMON_QUESTIONS`（`:13-18`） |
| 会话抽屉 | `showSessions` / `sessions` / `sessionsLoading` | `:32-34` | 抽屉开关、会话列表（映射后含 `timeText`）、加载态 |
| 提示条 | `banner` | `:36` | AI 未开放(403)/额度用尽(429) 等**非致命错误的顶部常驻提示**（`:35` 注释） |

实例字段（不入 data）：`this.nodeId`（`:41`）、`this._uid`（`:51-52`，账号切换检测）。

**气泡对象形状**（`messages` 元素，页面内构造口径）：

| 字段 | 类型 | 来源 | 消费位置 |
|---|---|---|---|
| `_k` | string | 模块级 `_seq` 自增（`:20`、`:92-93`、`:108`、`:206`） | `wx:key` 与滚动锚点 id（WXML `:25-26`） |
| `role` | `'user'`/`'assistant'` | 发送侧固定；历史消息非 `user` 一律归 `assistant`（`:207`） | 行方向、头像文案、气泡配色（WXML `:26-29`） |
| `content` | string | 输入文本 / `res.reply`（`:110`）/ 历史 `m.content`（`:208`） | `<text user-select>`（WXML `:34`） |
| `sources` | array | `res.sources`（`:111`）/ 历史 `m.sources`；元素 `{id,title,source,category}`（`.qoder/backend/app/api/routes/ai.py.md` §5.1） | 「参考来源」区块只用 `title`/`source` 两项（WXML `:45-48`） |
| `loading` | boolean（可选） | 发送时的占位气泡（`:93`） | 三点动画（WXML `:31-33`） |
| `failed` | boolean | catch 中对最后一条用户气泡标记（`:126-131`） | 重试条（WXML `:38-40`），重试按 `_k` 定位（`:147-148`） |
| `usedTokens` | number/null（可选） | `res.usedTokens`（`:112`） | **WXML 未渲染**（§9） |

### 4.2 生命周期

- `onLoad(options)`（`:39-42`）：仅解析 `options.nodeId` 存入 `this.nodeId`。**该参数通道 Phase A 不可达**：注释明写「Phase A 先不接入，保留参数通道」（`:40`），且本页是 tabBar 页、`wx.switchTab` 不支持携带 query，grep 全 `frontend/pages/` 无任何指向本页的 `navigateTo`/`switchTab`——`this.nodeId` 恒为 `null`，请求体永不含 `nodeId`（`.qoder/backend/app/api/routes/ai.py.md` §7.6 已核实，结论「待开发（入口缺失），非缺陷」；`.qoder/REQUIREMENTS.md` §14「`ai-chat` 的 `nodeId` 参数通道」行标为待开发 Phase B）。
- `onShow`（`:44-55`）：① 登录守卫——`app.globalData.loggedIn` 为假即 `wx.reLaunch('/pages/launch/launch')`（`:45-48`，不带 redirect 参数）；② **账号切换清理**——比较 `this._uid` 与当前用户 id，不一致则清空 `messages/conversationId/title/banner/sessions/showSessions`（`:49-54`），避免 tab 页常驻导致上一账号会话串号展示（`.qoder/REQUIREMENTS.md` §10.5 记为「全项目唯一一处显式的跨账号数据清理」）。
- **无 `onHide`/`onUnload`**：页面没有任何 `setInterval`/`setTimeout`/动画循环/事件监听（全文核实，`wx.nextTick` 无需清理），故无清理缺口。在途 Promise 回调对已隐藏页面 `setData` 属 tab 页常驻下的正常行为。
- 注意：头注释 `:7` 写「非 tab 页」，与 `frontend/app.json:55` 的 tabBar 注册**不符**，属注释瑕疵（§9）；onShow 守卫本身对 tab 页同样必要（`frontend/AGENTS.md` §4 不变量 5 的守卫口径）。

### 4.3 发送链路 `send(text)`（`:83-143`）

1. 前置闸：`sending` 中直接返回（`:84`）；trim 后为空返回（`:85-86`）；超 500 字 toast「问题请控制在 500 字以内」（`:87-90`，与后端 Pydantic 422 / service 400 构成三道长度闸，`.qoder/backend/app/api/routes/ai.py.md` §7.4）。
2. **乐观渲染**：一次性 concat 用户气泡 + `loading: true` 的 assistant 占位气泡，清空输入框、置 `sending`、清 `banner`（`:92-99`），随即 `scrollToBottom()`。
3. `ai.chat(trimmed, this.data.conversationId, this.nodeId)`（`:102`）→ `POST /api/ai/chat`（timeout 60s，`.qoder/frontend/services/ai.js.md` §4.1）。
4. 成功（`:103-121`）：`pop` 掉加载占位，push 真实回答气泡 `{content: res.reply, sources: res.sources, usedTokens: res.usedTokens}`，回填 `conversationId` 与 `title`（首问由后端截题生成，`title` 为空时保留旧值，`:117`），再次滚底。
5. 失败（`:122-142`）：移除占位，把最后一条用户气泡标记 `failed: true` 供重试（`:126-131`）；**403/429 → `banner` 顶部常驻提示**（`:135-136`，注释「不弹一闪而过的 toast」），其余状态码（含 502）与网络错误 → `wx.showToast(err.message)`（`:138`）。错误对象上的 `statusCode`/`message` 由 `frontend/services/request.js` 归一（`.qoder/frontend/services/request.js.md` §5）。

### 4.4 其余事件处理

| 处理函数 | 行号 | 行为 |
|---|---|---|
| `onInput` | `:58-60` | 输入框实时同步 `inputText` |
| `tapCommon` | `:63-66` | 点空态常见问题直接 `send(dataset.text)` |
| `tapSend` | `:69-76` | 发送按钮；空输入 toast「请先输入问题」 |
| `tapRetry` | `:146-152` | 按 `_k` 找到失败气泡，**先移除再重发**，避免重复堆叠 |
| `tapNew` | `:155-158` | 新建对话：清空 messages/conversationId/title/banner 并关抽屉；下次发送即新建会话 |
| `scrollToBottom` | `:160-165` | 见 §4.5 |
| `openSessions`/`closeSessions`/`noop` | `:168-177` | 抽屉开（并拉列表）/关/空函数（`catchtap` 阻止抽屉内点击冒泡到遮罩，WXML `:68`） |
| `loadSessions` | `:179-196` | `ai.listConversations(1, 50)`，映射 `timeText: util.formatRelative(updatedAt || createdAt)`（`:188`）；失败 toast |
| `tapSession` | `:199-225` | `wx.showLoading` → `ai.getConversation(id)` → 全量映射历史消息（role 非 `user` 一律归 `assistant`，`:207`）→ 关抽屉、清 banner、滚底；成功/失败均 `hideLoading`（`:218`、`:222`，无悬挂） |
| `tapDeleteSession` | `:228-255` | `wx.showModal` 二次确认（confirmColor `#C8102E`）→ `ai.deleteConversation(id)`（后端物理删除，`.qoder/backend/app/api/routes/ai.py.md` §4.6）→ 本地过滤；**删的是当前会话则同时清空对话区**（`:242-246`） |

### 4.5 滚动到底策略（`:160-165`）

`scroll-view` 用 `scroll-into-view="{{toView}}"` + `scroll-with-animation`（WXML `:13`）；每条气泡带 `id="msg-{{item._k}}"`（WXML `:26`）。`scrollToBottom` 在 `wx.nextTick` 中把 `toView` 设为最后一条消息的锚点 id（`:164` 注释「下一帧再定位，确保新气泡已渲染」）。`_k` 每条消息递增，锚点值恒变化，不存在同值 setData 不触发滚动的问题。

### 4.6 加载与错误状态矩阵

| 状态 | 触发条件 | 呈现 | 行号 |
|---|---|---|---|
| 空态引导 | `messages.length === 0` | 灯笼图标 + 说明文案 + 4 条常见问题胶囊 | WXML `:15-23` |
| 消息级加载 | send 后至回复前 | assistant 占位气泡内三点动画 | js `:93`；WXML `:31-33` |
| 全局发送中 | `sending === true` | textarea 禁用、发送按钮灰化文案「…」、重试/新建/切会话均被闸 | js `:84`、`:149`、`:156`、`:201`；WXML `:59-62` |
| 失败可重试 | `send` catch | 用户气泡下红色「发送失败，点击重试 ↻」 | js `:126-131`；WXML `:38-40` |
| 403/429 | `err.statusCode` 命中 | 顶部橙色 banner **常驻**，直至下次发送（js `:98`）、新建（`:157`）或切换会话（`:216`）时清除 | js `:135-136`；WXML `:10` |
| 其余错误（502/网络/400/404） | catch 兜底 | toast `err.message` 或「AI 服务暂时不可用，请稍后重试」 | js `:134`、`:138` |
| 抽屉加载/空 | `sessionsLoading` / 空列表 | 「加载中…」/「暂无历史会话」 | WXML `:74-75`；js `:180`、`:190` |
| 切换会话加载 | `tapSession` 期间 | `wx.showLoading` 带 mask，成功与失败路径均 `hideLoading`（无悬挂） | js `:202`、`:218`、`:222` |

## 4-1. WXML 专章（`ai-chat.wxml`，87 行）

- 结构：顶部工具条（☰ 会话 / 标题 / ＋ 新建，`:3-7`）→ banner（`:10`）→ 消息 `scroll-view`（`:13-54`：空态常见问题引导 `:15-23`、消息行 `:25-52`、底部留白 `:53`）→ 输入区（`:57-64`）→ 会话抽屉（`:67-86`）。
- 消息行：头像「我/AI」+ 气泡；加载态渲染三点动画（`:31-33`），否则 `<text user-select>` 支持长按复制（`:34`）；失败重试条（`:38-40`）；「参考来源」区块展示 `sources` 的 `《title》+ source`（`:43-49`，对应后端只下发**已发布知识**的来源，`.qoder/backend/app/api/routes/ai.py.md` §5.1）。
- 输入区 `<textarea>`（`:58-60`）属性逐项：

| 属性 | 值 | 作用 |
|---|---|---|
| `value="{{inputText}}"` | 受控 | `onInput` 回写（js `:58-60`），发送成功即清空（js `:96`） |
| `maxlength="500"` | 500 | 输入硬上限，与 js 侧 500 字校验（`:87-90`）、后端 `AI_MAX_INPUT_CHARS` 默认值同口径（`.qoder/REQUIREMENTS.md` §10.2） |
| `auto-height` | — | 随内容增高，WXSS `max-height: 200rpx` 封顶（wxss `:213`） |
| `confirm-type="send"` + `bindconfirm="tapSend"` | — | 键盘右下角为「发送」键，按下即触发 `tapSend`（js `:69-76`） |
| `disabled="{{sending}}"` | — | 在途请求期间锁定输入 |
| `cursor-spacing="20"` | 20 | 光标与键盘的间距，避免气泡区遮挡 |
| `show-confirm-bar="{{false}}"` | false | 隐藏 iOS 键盘顶部「完成」栏 |
| `adjust-position` | 未设置（默认 true） | 键盘弹出时页面上推；页面为 `100vh` flex 布局（wxss `:2-8`），输入条贴底随之上移 |

- 发送按钮非 `<button>` 而是 view，`sending || !inputText` 时加 `.ai-send-disabled` 灰色样式、文案变「…」（`:61-63`）；**样式禁用但 `bindtap` 仍绑定**，空输入由 `tapSend` 内 toast 拦截（js `:71-73`），发送中由 `send` 的 `sending` 闸拦截（js `:84`）。
- `wx:key` 全部用数据唯一字段（`_k`、`conversationId`、`*this`），无原生方法调用——符合 `frontend/AGENTS.md` §5.2 两条约束。

## 4-2. WXSS 专章（`ai-chat.wxss`，317 行）

| 区块 | 关键类 | 行号 | 要点 |
|---|---|---|---|
| 页面骨架 | `.ai-page` | `:2-8` | flex 纵向 + `height: 100vh`；顶栏/输入条 `flex-shrink: 0`、消息区 `flex: 1`（`:18`、`:48`、`:201`） |
| 顶部工具条 | `.ai-topbar/.ai-toptitle/.ai-topbtn` | `:11-34` | 标题 `max-width: 380rpx` 单行省略（`:24-27`）；按钮长征红 |
| 提示条 | `.ai-banner` | `:37-44` | 橙底 `#FFF3E0` 常驻横条，配合 WXML `wx:if="{{banner}}"` |
| 消息滚动区 | `.ai-scroll/.ai-scroll-pad` | `:47-55` | `overflow: hidden` 交由 scroll-view；底部 24rpx 留白垫 |
| 空态 | `.ai-empty*/.ai-common-item` | `:58-91` | 常见问题为白底红字胶囊 + 轻阴影 |
| 气泡 | `.ai-row/.ai-avatar/.ai-bubble-*` | `:94-145` | 用户行 `row-reverse`（`:99-101`）+ 红渐变气泡；AI 白底、对应侧顶角收小为 4rpx（`:135`、`:141`）；`word-break: break-word` + `.ai-text` `white-space: pre-wrap` 保留模型换行（`:130`、`:143-145`） |
| 加载三点 | `.ai-typing/@keyframes aiBlink` | `:148-166` | 纯 CSS 动画，点间 0.2s/0.4s 延迟错峰（`:161-162`） |
| 失败/来源 | `.ai-failed/.ai-sources*` | `:169-197` | 重试条红色小字；来源为米色半透明卡（`:176-181`） |
| 输入区 | `.ai-inputbar/.ai-input/.ai-send*` | `:200-232` | 底部 `calc(16rpx + env(safe-area-inset-bottom))` 并 constant() 双写兼容全面屏（`:205-206`）；textarea `min/max-height` 64/200rpx；禁用态灰底（`:230-232`） |
| 会话抽屉 | `.ai-mask/.ai-drawer/.ai-session-*` | `:235-317` | fixed 全屏半透明遮罩 `z-index: 100`；左侧 78% 宽面板 `aiSlideIn` 0.25s 滑入（`:241-253`）；条目标题/预览单行省略（`:290-305`） |

- 配色遵循全局约定：导航主色 `#C8102E`、背景 `#F7F1E5`（`frontend/AGENTS.md` §2）。
- **两处 CSS 动画（三点 `aiBlink`、抽屉 `aiSlideIn`）均随 `wx:if` 移除元素自然停止，无 JS 清理需求**；本页因此没有任何定时器/动画句柄需要 `onHide`/`onUnload` 回收（§4.2）。

## 4-3. JSON 专章（`ai-chat.json`，5 行）

仅 3 项：`navigationBarTitleText: "AI 历史助手"`、红底 `#C8102E`、白字——与全局 window 配置一致（`frontend/app.json:29-35`），无 `usingComponents`（全小程序零自定义组件，`.qoder/PROJECT.md` §8「代码级技术债」第 14 项）。tabBar 文案「AI 问答」在 `frontend/app.json:56`，页面 json 不管 tabBar 配置。

## 5. 输入与输出

- 输入：`onLoad options.nodeId`（现实恒为 undefined，§4.2）；用户输入与点击事件。
- 调用的 service → 后端路径（契约细节见 `.qoder/frontend/services/ai.js.md` §4 与 `.qoder/backend/app/api/routes/ai.py.md` §4-§5）：
  | 页面调用点 | service | 后端 |
  |---|---|---|
  | `:102` | `ai.chat` | `POST /api/ai/chat`（60s 超时） |
  | `:181` | `ai.listConversations(1, 50)` | `GET /api/ai/conversations` |
  | `:203` | `ai.getConversation(id)` | `GET /api/ai/conversations/{id}` |
  | `:237` | `ai.deleteConversation(id)` | `DELETE /api/ai/conversations/{id}` |
- 错误码语义（页面可观察）：401 由 `request.js` 静默重登重试；403=AI 总开关关闭、429=日限额用尽 → banner；502=上游 CloudBase 异常、网络错误 → toast；400/404/422 → toast（矩阵见 `.qoder/backend/app/api/routes/ai.py.md` §5.2）。
- 各端点响应中**本页实际消费的字段**（完整字段清单见 `.qoder/backend/app/api/routes/ai.py.md` §5.1，不复述）：

| 端点（response_model） | 本页消费 | 未消费 |
|---|---|---|
| `POST /chat`（`AiChatOut`） | `conversationId`、`title`、`reply`、`sources[]`、`usedTokens`（存入气泡但不渲染） | — |
| `GET /conversations`（`AiConversationListOut`） | `items[].{conversationId,title,preview,messageCount,updatedAt,createdAt}`（`:183-189`） | `total`（无翻页逻辑） |
| `GET /conversations/{id}`（`AiConversationDetailOut`） | `conversationId`、`title`、`messages[].{role,content,sources}`（`:205-217`） | `createdAt/updatedAt`、`messages[].id/createdAt` |
| `DELETE /conversations/{id}`（`MessageOut`） | 无（成功即本地过滤 + 固定「已删除」toast，`:239-248`） | `message` |

## 6. 依赖关系

- 上游：`frontend/services/ai.js`（`:10`）、`frontend/utils/util.js` 的 `formatRelative`（`:11`、`:188`；`.qoder/frontend/utils/util.js.md` §4）、`getApp().globalData`（`:9`、`:45`、`:50`）。**无任何 Storage 读写、无出站页面跳转**（除未登录 reLaunch 启动页 `:46`；`.qoder/REQUIREMENTS.md` §10.5「`pages/ai-chat` 无出站页面跳转」）。
- 入口：**仅 tabBar**（`frontend/app.json:55`）；grep `pages/ai-chat` 全 frontend 只命中 `app.json` 两处注册，无页面跳转入口。
- 后端契约对端：`.qoder/backend/app/api/routes/ai.py.md`、`.qoder/backend/app/services/ai_chat_service.py.md`（多轮上下文由后端拼接注入，无状态，`.qoder/REQUIREMENTS.md` §10.4）。

## 7. 业务规则

1. **响应非流式、整段到达**：service 层无 `enableChunked`/`onChunkReceived`（`.qoder/frontend/services/ai.js.md` §2）；上游 CloudBase 虽是 SSE，但后端 `prompt_meta` 阻塞消费完整个流后一次性返回 JSON（`.qoder/backend/app/api/routes/ai.py.md` §4.3「是否流式：否」）。页面消费方式与之配套：占位气泡 → 整段替换（`:92-120`）。
2. **403（AI 未开放）降级路径**：后端 `AI_ENABLED=false` 时 `ensure_enabled` 抛 `AiDisabledError` → 403「AI 助手当前未开放，请稍后再试」（`.qoder/backend/app/api/routes/ai.py.md` §7.2）。页面把 403 文案转为**顶部常驻 banner**（`:135-136`），用户仍可浏览历史会话（会话读写 3 端点不校验 AI 开关，同文 §4.1）。AI 的 403 **不带** `X-Account-Status`/`X-Activity-Status` 头，不会触发 `request.js` 的清会话或活动页跳转（`.qoder/frontend/services/ai.js.md` §5）。
3. **`CLOUDBASE_*` 配置缺失不是 403 而是 502**（如实记录）：`CLOUDBASE_API_KEY` 为空、或 `CLOUDBASE_ENV_ID`/`CLOUDBASE_AGENT_ID` 缺失且未配显式地址时，`cloudbase_service` 抛 `CloudBaseError` → 路由映射 **502**（`.qoder/backend/app/services/cloudbase_service.py.md` §4-§5、`.qoder/backend/app/api/routes/ai.py.md` §4.2），页面走 toast 分支。配置项名称清单见 `.qoder/ARCHITECTURE.md` §11.1（该节把地址项写作 `CLOUDBASE_ACP_URL`，代码真名 `CLOUDBASE_AGENT_URL`，滞后更正见 `.qoder/backend/app/services/cloudbase_service.py.md` §9）。另有部署级事实：**生产库缺 AI 迁移 021/022**（`.qoder/PROJECT.md` §8「阻塞级 / 功能不可用」第 3 项），真机真实 Agent 全链路**待验证**（§10.6「小程序真机真实 Agent 全链路」行）。
4. **会话归属与越权**：归属一律后端 JWT 判定、前端不传 user_id（`:2-4` 头注释；`.qoder/backend/app/api/routes/ai.py.md` §7.1）；越权时 chat=400、详情/删除=404，页面按普通错误 toast。
5. **连续对话**：`conversationId` 为空新建、非空追问，后端注入最近 `AI_CONTEXT_TURNS` 轮历史（`:3` 头注释；`.qoder/REQUIREMENTS.md` §10.4）；新会话 id/title 由 chat 响应回填（`:116-117`）。
6. **账号切换隔离**：见 §4.2 onShow。
7. **并发互斥**：`sending` 锁住 send/retry/new/切会话四条路径（`:84`、`:149`、`:156`、`:201`）。
8. **限额口径**：429 只统计成功调用，失败不消耗额度（`.qoder/backend/app/api/routes/ai.py.md` §7.3）；前端不做本地计数。

## 8. 修改约束

1. `chat` 的 60s 超时与「整段 reply」消费逻辑绑定；引入流式（SSE/chunked）属架构级变更，须同步改造本页占位-替换逻辑（`.qoder/frontend/services/ai.js.md` §8.2、§8.5）。
2. 403/429 分流依赖 `request.js` 在 Error 上挂 `statusCode`（`:133-135`；`.qoder/frontend/services/ai.js.md` §8.4）。
3. `_k` 同时是 `wx:key` 与滚动锚点 id（WXML `:25-26`），其「单调递增、页面内唯一」的生成方式（`:20`、`:92-93`）不可改，否则滚动定位与列表复用出错。
4. 状态码分布（chat 越权 400、详情/删除越权 404）不要「顺手统一」，本页与 `ai.js` 的错误提示依赖当前分布（`.qoder/backend/app/api/routes/ai.py.md` §8.7）。
5. `nodeId` 参数通道为 Phase B 预留（`:40-41`、`:102`），删除即破坏既定演进路径（`.qoder/REQUIREMENTS.md` §14「`ai-chat` 的 `nodeId` 参数通道」行）。
6. tab 页常驻：新增本地状态时必须考虑 onShow 的账号切换清理清单（`:53`）是否需要同步扩充。

## 9. 当前实现状态

- **已实现**：多轮对话、乐观渲染 + 失败重试、空态引导、来源展示、会话抽屉（列表/切换/删除）、403/429 banner、账号切换清理、登录守卫。随 `0052108` 交付，automator 验收「ai-chat 渲染 4/4、tab 换防 5/5」（`docs/迭代记录.md` 的 `0052108` 条目）。
- **存在问题 / 已知事项**：
  1. **抽屉实际最多 20 条**：页面传 `(1, 50)`（`:181`），但后端 query 参数名是 `page_size` 而 `ai.js` 发的是 `pageSize`，被静默忽略、恒用默认 20——第 21 个会话起被截断（`.qoder/backend/app/api/routes/ai.py.md` §9 问题 1，修复归属在 `frontend/services/ai.js`）。
  2. 头注释 `:7`「非 tab 页」与 `frontend/app.json:55` tabBar 注册不符（§4.2），属注释瑕疵，待修正。
  3. `usedTokens` 存入消息对象（`:112`）但 WXML 未渲染，预留用途**待确认**。
  4. 会话列表无触底翻页（一次拉取，§4.4）；长会话详情不分页、一次全量返回（`.qoder/backend/app/api/routes/ai.py.md` §9 问题 3）。
  5. 真机真实 Agent 全链路**待验证**（`.qoder/PROJECT.md` §8「待验证项」段；`.qoder/REQUIREMENTS.md` §10.6）。
- **待开发**：`nodeId` 节点上下文追问入口（Phase B，§4.2）。管理后台 AI 子页面仅部分有真实后端接口（运行概览/调用记录无接口），属管理端范围，与本页无直接耦合——见 `.qoder/ARCHITECTURE.md` §11.3「管理后台 AI 子页面：运行概览 / 调用记录」行、`.qoder/REQUIREMENTS.md` §10.6 同名行。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/ai-chat`，共 **1 个提交**（四件套同批创建，此后未改动）。

### 2026-10-17（`0052108`，11:06）
- 需求：AI 智能中心 Phase A 小程序侧——历史助手聊天页；底部「情报」tab 换防为「AI 问答」。
- 修改内容：新建 `frontend/pages/ai-chat/` 四件套（本页全部代码）；`frontend/app.json` 注册页面并调整 tabBar 第 3 项；同批新建 `frontend/services/ai.js`。
- 关联文件：`frontend/services/ai.js`、`frontend/app.json`、`frontend/utils/util.js`（`formatRelative` 消费方，`.qoder/frontend/utils/util.js.md` §10）；后端对端 `1600074`。
- 测试结果：见 `docs/迭代记录.md` 的 `0052108` 条目（automator ai-chat 4/4、tab 换防 5/5；真机真实 Agent 全链路当时标记待验证）。
