# request.js

## 1. 文件路径

`frontend/services/request.js`（167 行）

## 2. 文件职责

全小程序**唯一的 HTTP 传输层**：封装 `wx.request`，统一拼接后端基址、注入 JWT Bearer 头、归一化错误（HTTP 状态码 / 网络失败 / 账号停用 / 活动拦截四类）、401 时静默重登并**精确重试一次**、失败清登录态回启动页。全部 15 个业务 service 与 `ws.js` 都经本文件访问后端；页面层禁止直接发请求（`frontend/AGENTS.md` §3.1、§6.5）。

## 3. 业务需求

- `b0fd8b2`（2026-10-01）「小程序由本地 Mock 切换为真实后端接口」创建本文件（`git log --follow` 最早提交；`docs/迭代记录.md` 的 `b0fd8b2` 条目仅有标题行，细节以提交信息为据）。
- `01e214a`（2026-10-11）V1.0 启动页自动登录：要求「401 静默重登并重试一次、失败可重试不假登录」（提交信息；`docs/迭代记录.md` 的 `01e214a` 条目）。
- `afbcba9`（2026-10-12）邀请码准入全链路：消费后端 `X-Account-Status: disabled` 响应头（`docs/迭代记录.md` 的 `afbcba9` 条目；后端侧见 `.qoder/backend/app/api/deps.py.md` §4.4）。
- `44eb77b`（2026-10-13）V2.0 活动状态页与查看拦截：消费 `X-Activity-Status` 响应头（提交信息「活动状态页与查看拦截」；后端侧见 `.qoder/backend/app/api/deps.py.md` §4.5）。
- `a60b94b`（2026-10-14）网络异常透出微信原始 `errMsg`（`docs/迭代记录.md` 的 `a60b94b` 条目）。
- 项目级 API 约定（无响应外壳、状态码、准入响应头）的权威阐述见 `.qoder/ARCHITECTURE.md` §4.1、§4.3、§4.6；令牌与静默重登链见 §5.5。

## 4. 核心功能

### 4.1 模块常量与状态（`:3-11`）

| 名称 | 行号 | 值 / 用途 |
|---|---|---|
| `TOKEN_KEY` | `:3` | `'lm_auth_token'`，JWT 存储键；**导出**供 `auth.js` 写删（`frontend/services/auth.js:101`、`:206`、`:252`） |
| `USER_KEY` | `:4` | `'lm_login_user'`，仅 `clearSession` 删除用（`:31`） |
| `LAUNCH_PAGE` | `:5` | `/pages/launch/launch`，清会话后的 reLaunch 目标 |
| `ACTIVITY_PAGE` | `:6` | `/pages/activity/activity`，活动拦截跳转目标 |
| `ACTIVITY_REDIRECT_GAP_MS` | `:7` | 3000，活动跳转去抖窗口 |
| `reauthHandler` | `:10` | 模块级变量，由 `setReauthHandler` 注入（auth.js:164 注入 `relogin`） |
| `lastActivityRedirect` | `:11` | 上次活动跳转时间戳，配合去抖 |

### 4.2 基址解析（`config.js` 追踪）

`:1` `const { API_BASE_URL } = require('./config')`，`:69` 拼为 `API_BASE_URL + opts.url`。`frontend/services/config.js` 在**模块加载时一次性**求值（`config.js:42-44` `module.exports = { API_BASE_URL: resolveBaseUrl() }`）：非开发版（`envVersion !== 'develop'`）恒为 `https://swkjdj.sz-watech.com/api`（`config.js:13`、`:29-31`）；开发版由 `DEV_TARGET` 决定，`'local'` 时开发者工具走 `http://127.0.0.1:8010/api`、真机走局域网 IP（`config.js:32-39`）。**当前工作区 `config.js:11` 为 `DEV_TARGET = 'local'`，是未提交的本地改动**（已提交值为 `'remote'`，`git diff frontend/services/config.js` 实测；最近提交 `a017284`）——只影响 develop 环境，体验版/正式版不受影响。

### 4.3 `getToken()`（`:14-20`）

每次 `send` 时**实时**读 `wx.getStorageSync(TOKEN_KEY)`（`:63`），异常吞掉返回 `''`。前端**不解析、不检查 JWT 过期时间**，有效性完全交给后端 401 判定（令牌 7 天有效期见 `.qoder/ARCHITECTURE.md` §5.1）。

### 4.4 `setReauthHandler(fn)`（`:23-25`）

注册 401 重登函数。**依赖注入而非 import 的原因**：打破 request ↔ auth 循环依赖（`:9` 注释；`auth.js:164` 是唯一注入点，注入 `relogin`）。

### 4.5 `clearSession()`（`:28-45`）

删 `lm_auth_token` + `lm_login_user`（Storage 失败仍继续，`:32-34`）→ 复位 `app.globalData.user/loggedIn` → `wx.reLaunch(LAUNCH_PAGE)`（App 未初始化时整段 try/catch 吞掉，`:42-44`）。

### 4.6 `errorMessage(data, fallback)`（`:48-54`）

解析 FastAPI 错误体：`detail` 为字符串直接用；为数组（Pydantic 422 校验错误）取各项 `msg` 用「；」拼接；否则用 fallback。与 `.qoder/ARCHITECTURE.md` §4.1 所述一致——**后端无 `{code,data,message}` 信封**，错误体是 `{"detail": ...}`。

### 4.7 `send(opts)`（`:62-104`）——单次请求，无 401 处理

- 头：`Content-Type: application/json` 打底，可被 `opts.header` 覆盖；有 token 时加 `Authorization: 'Bearer ' + token`（`:64-65`）。
- `timeout: opts.timeout || 10000`（`:73`，默认 10 秒）。
- 成功分支：`statusCode ∈ [200,300)` → **直接 `resolve(res.data)`，不拆任何包装**（`:75-78`；对应 `.qoder/ARCHITECTURE.md` §4.1「2xx 响应体就是业务 payload 本身」）。
- 失败分支（`:79-92`）：构造 `Error`，附 `statusCode`；401 的 fallback 文案为「登录已过期，请重新登录」，其余「请求失败」（`:79`）。再读响应头（大小写键名双兼容，`:82-83`、`:88`）：403 + `X-Account-Status: disabled` → `err.admission = 'disabled'`（`:84-86`）；403 + `X-Activity-Status`（unpublished/not_started/ended）→ `err.activityStatus`（`:89-91`）。两个头的后端设置点与取值见 `.qoder/backend/app/api/deps.py.md` §4.4、§4.5。
- `fail` 分支（`:94-101`）：`err.network = true` + `err.rawErrMsg`（微信原始 errMsg）；「url not in domain list」给公众平台合法域名专项提示，其余给通用网络提示；原始 errMsg 以「提示｜errMsg」拼接进 message（`:96-100`，`a60b94b` 引入，理由是真机看不了 console）。

### 4.8 `redirectActivityClosed()`（`:110-119`）

活动拦截跳转，**3 秒去抖**（`:111-113`，模块级 `lastActivityRedirect`）：并发请求同时被拦截只 `wx.reLaunch(ACTIVITY_PAGE)` 一次；reLaunch 失败（App 未初始化）吞掉，由启动页查询活动状态后跳转（`:116-118` 注释）。

### 4.9 `request(options)`（`:129-160`）——对外主入口，错误分派链

`send(opts).catch(...)` 按严格顺序分派（与 `.qoder/ARCHITECTURE.md` §5.5 的 6 步描述一致）：

1. `err.activityStatus` 存在（`:132-136`）：**仅 GET（查看类）且未传 `skipActivityRedirect`** 才跳活动页；POST 等参与类只抛错由页面提示（`:107-108` 注释）。无论如何 rethrow。
2. `err.admission === 'disabled'`（`:138-141`）：除非 `skipAuthRetry`，`clearSession()` 回启动页显示准入拦截；**不做静默重登**（`:137` 注释）。rethrow。
3. 非 401 或 `skipAuthRetry`（`:142`）：直接 rethrow。
4. 401 且 `reauthHandler` 未注册（`:143-146`）：`clearSession()` + rethrow。
5. 401 且有 handler（`:147-152`）：`reauthHandler()` 成功后 `send(opts)` **精确重试一次**（重发原 opts）；重试仍 401 → `clearSession()`，抛重试错误。
6. `reauthHandler()` 自身失败（`:153-157`）：`loginErr.network` 为真 → **保留会话**（网络抖动不踢下线，由页面提示重试）；否则（未入驻/已停用/已退出）`clearSession()`，抛重登错误。

**无通用重试/退避、无请求队列/去重**：只有上述 401 一次重试；并发 401 的合并（single-flight）在 `auth.js:14`、`:132-140` 实现，页面级并发竞态守卫（请求序号）在各页面自行实现（`e70b59f`，`docs/迭代记录.md` 的 `e70b59f` 条目）。

### 4.10 导出（`:162-167`）

`TOKEN_KEY`、`getToken`、`setReauthHandler`、`request` 四项，全部有消费方（§6）。

## 5. 输入与输出

**入参** `options`（`:126` JSDoc）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | 相对路径（如 `/quiz/daily`），前拼 `API_BASE_URL` |
| `method` | string | `'GET'` | `:70` |
| `data` | object | — | 请求体/query（交给 wx.request） |
| `header` | object | — | 与默认头合并，可覆盖（`:64`） |
| `timeout` | number | `10000` | 毫秒（`:73`） |
| `skipAuthRetry` | boolean | false | 登录相关请求自行处理 401/停用，不触发重登与清会话（`:124`；使用方 `auth.js:95`、`:150`、`:171`、`:194`） |
| `skipActivityRedirect` | boolean | false | 活动拦截时不自动跳转（`:125`） |

**返回**：`Promise<any>`，2xx 时 resolve 后端业务 payload 本身（camelCase，无外壳）。

**拒绝值**（均为 `Error` 实例附加属性，`:57-59` `buildError`）：

| 属性 | 出现条件 |
|---|---|
| `message` | 后端 `detail` 解析文案 / 网络提示＋原始 errMsg |
| `statusCode` | HTTP 非 2xx（`:80`） |
| `network: true`、`rawErrMsg` | wx.request fail，请求未达后端（`:100`） |
| `admission: 'disabled'` | 403 + `X-Account-Status: disabled`（`:85`） |
| `activityStatus` | 403 + `X-Activity-Status`，值 unpublished/not_started/ended（`:90`） |

## 6. 依赖关系

- **上游依赖**：`frontend/services/config.js`（`API_BASE_URL`，`:1`）；wx API（`wx.request`/`wx.getStorageSync`/`wx.removeStorageSync`/`wx.reLaunch`）；`getApp().globalData`（`:36-40`）。**不 import 任何业务模块**（auth 的 handler 靠注入，`:9-10`）。
- **被依赖（grep 实测）**：
  - `requestService.request`：15 个业务 service——`auth.js:7`、`sport.js:11`、`march.js:10`、`quiz.js:7`、`medal.js:4`、`org.js:4`、`rank.js:4`、`profile.js:4`、`person.js:4`、`quote.js:4`、`broadcast.js:4`、`points.js:7`、`identity.js:5`、`ai.js:9`、`activity.js:5`（均 `require('./request')`）。
  - `getToken`：`ws.js:32`（WS 连接串拼 token，WS 不走本文件的 wx.request）、`auth.js:146`（ensureLogin 判断本地是否有 token）。
  - `TOKEN_KEY`：`auth.js:101`、`:154`、`:206`、`:252`（写/删 JWT 均用此常量，键名不重复定义）。
  - `setReauthHandler`：`auth.js:164`（唯一注入点）。
  - **页面层零直接调用**（grep `pages/**` 无 `services/request` require），符合 `frontend/AGENTS.md` §3.1。
- **后端契约对端**：401/403 的产生与文案在 `backend/app/api/deps.py`（文档 `.qoder/backend/app/api/deps.py.md` §4.3-§4.5）；状态码约定见 `.qoder/ARCHITECTURE.md` §4.3。

## 7. 业务规则

1. **令牌契约（前后端核对结论）**：JWT 为 HS256、`sub`=用户 id、有效期 7 天（`JWT_EXPIRE_MINUTES=10080`，`.qoder/ARCHITECTURE.md` §5.1）；**无 refresh token、无黑名单**（同节）。后端 `get_current_user` 对缺失/过期/篡改/用户不存在一律 401（4 种文案），停用为 403+头（`.qoder/backend/app/api/deps.py.md` §4.3 表）。前端策略与之配套：**不本地判过期，401 即触发一次静默重登（wx.login + /auth/login）+ 一次原请求重试**；重登由 `auth.relogin` 单飞合并，并发 401 只登录一次（`frontend/services/auth.js:14`、`:132-140`）。
2. **重试语义是「精确一次」**：只对 401、只重发原始 opts、只重试一轮（`:147-152`）；重试仍 401 视为登录态不可恢复 → `clearSession` 回启动页。后端 `deps.py.md` §8 明确「401（而非 403）语义不可更改：小程序静默重登链只对 401 触发」。
3. **停用优先于重登**：`admission === 'disabled'` 分支在 401 分支之前（`:138` vs `:142`），停用账号不会被静默重登掩盖。
4. **活动拦截「查看跳页、参与只报错」**：GET 被拦 → 去抖跳 `/pages/activity/activity`；POST 被拦 → 抛错由页面展示后端 message（`:107-108`、`:132-136`）。
5. **网络失败不清会话**：`network` 错误（含重登时的网络错误）一律保留登录态（`:154-155`），避免弱网把用户踢下线。
6. `clearSession` 后登录恢复完全交给启动页 `ensureLogin`（`frontend/pages/launch/launch.js:57`），本文件不做任何自动重登。

## 8. 修改约束

1. `X-Account-Status` / `X-Activity-Status` 的**头名与取值**是跨端契约（`.qoder/backend/app/api/deps.py.md` §8；本文件 `:81-91` 消费且兼容小写头名），改动必须双端同步。
2. 后端 `detail` 文案会被 `errorMessage` 直接展示给用户（`:48-54`），改文案属跨端变更（`deps.py.md` §8 同款约束）。
3. **不得在本文件 import `auth.js`**：循环依赖靠 `setReauthHandler` 注入打破（`:9` 注释），改成直接 require 会成环。
4. 2xx **直接 resolve `res.data`** 是「无响应外壳」约定的小程序侧落点（`.qoder/ARCHITECTURE.md` §4.1），不得加拆包层；响应字段 camelCase 契约见同文 §4.2。
5. 401 重登链的分支顺序（活动拦截 → 停用 → skipAuthRetry → 无 handler → 重登重试）与 `auth.js`、启动页的错误处理（`err.admission`/`err.network`/`err.loggedOut`）逐一耦合，调整任一分支需同步核对 `frontend/pages/launch/launch.js` 与 `frontend/services/auth.js`。
6. `TOKEN_KEY`/`USER_KEY` 键名与 `lm_auth_token`/`lm_login_user` 是既有存储契约（`frontend/AGENTS.md` §4 不变量 3、`.qoder/ARCHITECTURE.md` §5.5 表），改名会使存量用户登录态失效。
7. 页面层绕过本文件直接 `wx.request` 属违规（`frontend/AGENTS.md` §6.5）。

## 9. 当前实现状态

- **已实现**：JWT 注入、无外壳解包、四类错误归一（statusCode/network/admission/activityStatus）、401 单飞重登 + 精确重试一次、停用清会话、活动拦截去抖跳转、网络错误详情透出（含原始 errMsg）。7 个提交演进见 §10。
- **已知事项（事实陈述）**：
  1. 本文件无请求级去重/取消，页面并发竞态靠各页请求序号守卫（`e70b59f`），属分层设计而非缺陷。
  2. 活动跳转去抖是**模块级全局** 3 秒窗口（`:11`、`:112`）：期间任何页面的 GET 活动拦截都不再重复跳转；`skipActivityRedirect` 可退出该行为，但 grep 未发现任何调用方传入该参数（仅 `:125`、`:134` 两处自身引用）——**当前为预留开关，零使用**。
  3. 工作区 `config.js:11` `DEV_TARGET='local'` 为未提交改动（已提交值 `'remote'`），仅影响 develop 环境基址（§4.2）；提交前须还原，否则开发版默认连本机。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/request.js`（**7 个提交**）与 `docs/迭代记录.md` 对应条目。按时间倒序。

### 2026-10-14（`a60b94b`）
- 需求：体验版扫码只报「网络异常」，真实原因（域名未过校验/连接被拒）被丢弃，真机无从定位。
- 修改内容（涉本文件）：fail 分支把微信原始 `errMsg` 追加进提示并附 `err.rawErrMsg`；「域名未过校验」提示改为指向公众平台 request 合法域名（`docs/迭代记录.md` 的 `a60b94b` 条目）。
- 关联文件：`pages/launch/launch.js`、`services/auth.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `a60b94b` 条目。

### 2026-10-13（`44eb77b`）
- 需求：V2.0 小程序批次——活动状态页与查看拦截等。
- 修改内容（涉本文件）：新增 `X-Activity-Status` 消费（`:87-91`）与 `redirectActivityClosed` 3 秒去抖跳转（`:110-119`）、`skipActivityRedirect` 开关（提交信息「活动状态页与查看拦截」；`docs/迭代记录.md` 的 `44eb77b` 条目）。
- 关联文件：`pages/activity/activity`（新增）、答题/排行/积分等多页。
- 测试结果：提交信息自述「新增 v2 自动化验收（14/14）与报告」；细节见 `docs/迭代记录.md` 的 `44eb77b` 条目。

### 2026-10-12（`afbcba9`）
- 需求：邀请码准入全链路——停用账号即时断权。
- 修改内容（涉本文件）：新增 `X-Account-Status: disabled` 消费（`:81-86`）→ `err.admission` → `clearSession` 不走静默重登（`:138-141`）（`docs/迭代记录.md` 的 `afbcba9` 条目及 `.qoder/backend/app/api/deps.py.md` §10 同日记录）。
- 关联文件：`services/auth.js`（verifyInvite/onboard）、后端 015 迁移等。
- 测试结果：见 `docs/迭代记录.md` 的 `afbcba9` 条目（后端 `s19_invite_admission.py` 25/25）。

### 2026-10-11（`01e214a`）
- 需求：V1.0 启动页自动登录——「后端校验 Token/静默 wx.login、401 静默重登重试、失败可重试不假登录」。
- 修改内容（涉本文件）：形成现行 `request()` 401 重登重试链与 `clearSession`（提交信息；`docs/迭代记录.md` 的 `01e214a` 条目）。
- 关联文件：`services/auth.js`（ensureLogin/relogin）、`pages/launch/launch.js`。
- 测试结果：`docs/迭代记录.md` 的 `01e214a` 条目——`node test/auth-flow-check.cjs` 11/11（覆盖并发 401 单次重登、重登失败回启动页等）；automator `v1-auto-login.cjs` 两轮 6/6；真机扫码当时待验证。

### 2026-10-02（`b467a8a`）
- 需求：清理 Mock 时代死代码。
- 修改内容（涉本文件）：条目仅记「移除 util/store 中零引用的 Mock 时代死代码」（`docs/迭代记录.md` 的 `b467a8a` 条目），对本文件具体删改内容以提交信息为据，细节**待确认**（可 `git show b467a8a -- frontend/services/request.js` 查证）。
- 关联文件：`utils/util.js`、`services/store.js`。
- 测试结果：该条目未记录验证字段。

### 2026-10-01（`7908088`）
- 需求：修复真机调试登录失败。
- 修改内容（涉本文件）：条目记「API 地址按平台自动切换局域网 IP」（`docs/迭代记录.md` 的 `7908088` 条目），即基址解析逻辑调整（现行实现已收敛在 `config.js`）。
- 测试结果：该条目未记录验证字段。

### 2026-10-01（`b0fd8b2`）
- 需求：小程序由本地 Mock 切换为真实后端接口。
- 修改内容（涉本文件）：创建本文件——统一 wx.request 封装、JWT 注入（`git log --follow` 最早提交；`docs/迭代记录.md` 的 `b0fd8b2` 条目仅有标题行，细节以提交信息为据）。
- 关联文件：全部 `services/*.js` 同批切换。
- 测试结果：待确认（该条目未记录验证字段）。
