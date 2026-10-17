# ai.js

## 1. 文件路径

`frontend/services/ai.js`（68 行）

## 2. 文件职责

小程序「AI 智能中心 · 历史助手」的服务层：封装后端 `/api/ai/*` 的 4 个接口（提问对话、我的会话列表、会话详情、删除本人会话）。**请求/响应式，非流式**——全部经 `requestService.request`（`wx.request`）一次性返回，文件中不存在 `enableChunked`/`onChunkReceived` 等分块消费代码（`:1-68` 全文核实）；`chat` 通过覆写 `timeout: 60000` 容纳模型长耗时（`:23`，request 默认 10s，`frontend/services/request.js:73`）。

## 3. 业务需求

- AI 智能中心 Phase A §3.1「历史助手」（连续对话、来源引用、跨账号隔离、日限额）：后端随 `1600074`（2026-10-17）交付（`docs/迭代记录.md` 的 `1600074` 条目）；本文件随小程序 AI 聊天页 `0052108`（2026-10-17）交付（`docs/迭代记录.md` 的 `0052108` 条目）。
- 连续对话：`conversationId` 为空新建会话、非空在该会话内追问（`:6` 契约注释），历史上下文由后端注入（`frontend/pages/ai-chat/ai-chat.js:3` 页头注释「后端注入历史上下文」）。
- 会话归属与安全：归属一律由后端 JWT 判定、前端不传 user_id，读写他人会话按 404 处理（`:5`）。

## 4. 核心功能

**导出 4 个函数**（`module.exports`，`:63-68`）。后端契约权威见 `.qoder/backend/app/api/routes/ai.py.md` 与 `.qoder/backend/app/services/ai_chat_service.py.md`（本文档不重复推导后端逻辑）。

| # | 函数 | 行号 | 后端接口 | 说明 |
|---|---|---|---|---|
| 1 | `chat(message, conversationId?, nodeId?)` | `:19-24` | `POST /api/ai/chat` | 发送一条提问并获取回答（timeout 60s） |
| 2 | `listConversations(page?, pageSize?)` | `:33-38` | `GET /api/ai/conversations` | 我的会话列表（新到旧） |
| 3 | `getConversation(conversationId)` | `:47-49` | `GET /api/ai/conversations/{id}` | 会话详情（含历史消息） |
| 4 | `deleteConversation(conversationId)` | `:56-61` | `DELETE /api/ai/conversations/{id}` | 删除本人会话（后端校验归属） |

### 4.1 `chat`（`:19-24`）

- 入参：`message` 用户问题（1-500 字，`:13` JSDoc）；`conversationId`、`nodeId` 均为**truthy 才上送**（`:21-22`）——空/0/undefined 一律按「新建会话、无节点上下文」处理。`nodeId` 用于「在节点讲解内追问时携带」（`:15`）。
- 返回：`{conversationId, title, reply, sources[{id,title,source,category}], usedTokens}`（`:16-17`）。`sources` 为后端核验过的**已发布知识**来源（页头注释 `ai-chat.js:6`；后端约束「来源仅已发布知识」见 `docs/迭代记录.md` 的 `1600074` 条目）；`usedTokens` 可为 null。
- 非流式消费：页面等待整段 `reply` 后一次性追加气泡（`ai-chat.js:79`「成功后追加回答气泡」），加载期间以占位气泡呈现（`ai-chat.js:124`「去掉加载占位」）。

### 4.2 会话管理三函数（`:33-61`）

- `listConversations`：query 参数 `{page: page || 1, pageSize: pageSize || 20}`（`:36`，GET 的 data 由 `wx.request` 序列化为查询串）；返回 `{total, items[{conversationId,title,preview,messageCount,createdAt,updatedAt}]}`（`:30-31`）。唯一调用方实际传 `(1, 50)`（`ai-chat.js:181`），未做翻页加载。
- `getConversation`：返回 `{conversationId,title,createdAt,updatedAt,messages[{id,role,content,sources,createdAt}]}`（`:43-45`），供抽屉切换会话时回填历史。
- `deleteConversation`：返回 `{message}`（`:54`）；归属校验在后端（`:52`），前端不预检。

## 5. 输入与输出

- 输入：见 §4；无本地 Storage 读写、无缓存。
- 输出：Promise，resolve 为后端 camelCase JSON（契约注释 `:4`「camelCase，对应后端 /api/ai/*」）。
- 错误码（`:7` 契约注释 + `request.js` 实现核实）：
  - **403 = AI 未开放**、**429 = 今日额度用尽**、**502 = 上游异常**，均由 `request.js` 抛带后端 `detail` 文案的 `Error`（`frontend/services/request.js:48-54`、`:79-80`），且挂 `statusCode` 属性（`request.js:57-59`、`:80`）；
  - AI 的 403 **不带** `X-Account-Status`/`X-Activity-Status` 响应头，因此不会触发 `request.js` 的账号停用清场（`:84-86`、`:138-141`）或活动拦截跳转（`:87-91`、`:132-136`），按普通错误交页面处理；
  - 401 走 `request.js` 统一静默重登重试（`:129-160`）；他人会话按 404（`:5`）。

## 6. 依赖关系

- 依赖：`frontend/services/request.js`（`:9`）→ `config.js`（`API_BASE_URL`）→ 后端 `/api/ai/*`（`.qoder/backend/app/api/routes/ai.py.md`、`.qoder/backend/app/services/ai_chat_service.py.md`；用量/限额另见 `.qoder/backend/app/services/ai_usage_service.py.md`，配置开关见 `.qoder/backend/app/services/ai_config_service.py.md`——按后端文档目录存在性列出，细节以其为准）。
- 被依赖（grep 全量核实）：**唯一调用方为 AI 问答 tab 页** `frontend/pages/ai-chat/ai-chat.js:10`（require）——`ai.chat(trimmed, this.data.conversationId, this.nodeId)`（`:102`）、`ai.listConversations(1, 50)`（`:181`）、`ai.getConversation(id)`（`:203`）、`ai.deleteConversation(id)`（`:237`）。ai-chat 为 5 个 tabBar 页之一（`frontend/AGENTS.md` §7；`0052108` 提交信息「底部情报 tab 替换为 AI 问答」）。
- **导出函数零调用者：无**（4 个导出均被 ai-chat 页调用，grep 核实）。

## 7. 业务规则

1. **403（AI 未开放）降级路径**：前端无本地功能开关（`:1-68` 无任何配置判断），开放与否完全由后端判定；页面把 403/429 的 `err.message` 转为**顶部常驻提示条 banner**（非一闪而过的 toast），其余错误（含 502）toast 提示，失败的用户气泡标记 `failed` 供重试（`ai-chat.js:80`、`:133-139`、`:35-36` banner 字段注释「AI 未开放/额度用尽等，非致命错误」）。
2. **会话归属**：前端不传 user_id、不缓存他人数据；归属判定与 404 收敛在后端（`:5`）。
3. **连续对话**：追问沿用 `conversationId`（`:6`）；新建会话的 id 由 `chat` 响应回填（`ai-chat.js:102` 传 `this.data.conversationId`，首问为空）。
4. **消息长度**：1-500 字约束写在 JSDoc（`:13`），前端仅做 trim（`ai-chat.js:102` 传 `trimmed`），长度校验以后端为准。
5. **日限额**：429「今日额度用尽」（`:7`），限额计数与重置在后端（见 `.qoder/backend/app/services/ai_chat_service.py.md`），前端不做本地计数。

## 8. 修改约束

1. camelCase 契约与 4 个接口的字段结构是页面硬契约（`:4`、`frontend/AGENTS.md` §1），改动须与后端同步（`.qoder/README.md` §3 规则 6）。
2. `chat` 的 `timeout: 60000` 不得回退为默认 10s——模型生成耗时远超普通接口（`:23`；后端真实 Agent 调用耗时见 `docs/迭代记录.md` 的 `1600074` 条目冒烟记录）。
3. `conversationId`/`nodeId` 的 truthy 判断（`:21-22`）意味着传 `0` 等同不传；如后端出现 id=0 的合法语义需改造此处（现状自增 id 从 1 起，风险为理论性）。
4. 错误分流依赖 `request.js` 在 Error 上挂 `statusCode`（`request.js:57-59`）；若改造 request 错误结构，须同步核对 `ai-chat.js:133-135` 的 403/429 判断。
5. 若未来引入流式（SSE/chunked）输出，属架构级变更：`wx.request` 需 `enableChunked` 且现行「整段 reply」页面消费逻辑（`ai-chat.js:79`）需同步改造。

## 9. 当前实现状态

- **已实现**：4 个接口封装全部可用、全部有调用方（§6）；随 `0052108` 交付，验证为 automator「ai-chat 渲染 4/4（空态/对话含来源与失败态/抽屉）、tab 换防 5/5」（`docs/迭代记录.md` 的 `0052108` 条目）；**真机真实 Agent 全链路当时因本机 DNS 劫持标记待验证**（同条目，后端侧已真实验证）。
- **存在问题 / 已知事项**：
  1. `nodeId` 参数（节点讲解内追问）已预留（`:15`、`:22`），但后端 `1600074` 条目记载「node-detail 讲解面板、答题页 AI 讲解按钮按需求 §13 留后续阶段」——当前是否存在带 `nodeId` 跳入 ai-chat 的入口**待确认**（grep 未见其他页面传该参数的跳转，`ai-chat.js:102` 读 `this.nodeId`，其赋值来源未逐行核对）。
  2. `listConversations` 支持分页参数，但唯一调用方固定 `(1, 50)` 一次拉取、无触底加载（`ai-chat.js:181`）；会话数超 50 的用户体验**待确认**（是否需分页为产品决策）。
- **待开发**：答题页 AI 讲解、node-detail 讲解面板等 Phase 后续阶段入口（`docs/迭代记录.md` 的 `1600074` 条目），届时可能在本文件新增函数。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/ai.js`，共 **1 个提交**，在 `docs/迭代记录.md` 有条目。

### 2026-10-17（`0052108`，11:06）
- 需求：AI 智能中心 Phase A 小程序侧——新增 AI 历史助手聊天页，底部情报 tab 替换为 AI 问答（答题降级为首页情报卡入口子页）。
- 修改内容（涉本文件）：创建本文件，封装 `/ai/chat`、`/ai/conversations`（列表/详情/删除）4 个接口，确立 camelCase、JWT 归属、403/429/502 错误契约注释（`:1-68` 全部内容）。
- 关联文件：`frontend/pages/ai-chat/ai-chat.js`、`frontend/app.json`（tabBar 调整）；后端对端为同日 `1600074`（Phase A 后端，`docs/迭代记录.md` 的 `1600074` 条目）。
- 测试结果：见 `docs/迭代记录.md` 的 `0052108` 条目（automator ai-chat 4/4、tab 换防 5/5；截图与报告路径同条目；真机真实 Agent 全链路标记待验证）。
