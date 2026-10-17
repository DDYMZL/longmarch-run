# auth.py

## 1. 文件路径

`backend/app/api/routes/auth.py`（124 行）

## 2. 文件职责

小程序侧鉴权与准入路由：微信登录、邀请码校验、持邀请码入驻（建号）、当前用户查询、昵称修改（两个语义不同的端点）。本文件承载了「不自动建号、凭邀请码入驻」准入模型的 3 个**登录前豁免**端点与 3 个需登录端点。

## 3. 业务需求

- 需求来源：`afbcba9`（2026-10-12）「邀请码准入全链路」——`/api/auth/login` 改为状态式返回 active/unregistered/disabled 且未入驻不建号，新增 `/api/auth/invite/verify` 与 `/api/auth/onboard`（提交信息原文，见 `docs/迭代记录.md:420`）。
- 昵称规则：`f820e0e`（2026-10-01）「微信名称直登与昵称仅可修改一次」；`43877dc`（2026-10-01）新增首次引导设置昵称接口（不消耗改名机会）。
- 设计文档：`docs/identity-binding-design.md`（身份采集部分）、`frontend/design.md:135`（入驻链路）。

## 4. 核心功能

**6 个端点**（router 无 prefix，路径内写全 `/auth/*`，`backend/app/main.py:71` 以 `/api` 前缀挂载）：

| # | 方法+路径 | 函数 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| 1 | `POST /api/auth/login` | `login` | `:29-44` | **无（登录前豁免）** | `LoginResponse` |
| 2 | `POST /api/auth/invite/verify` | `verify_invite` | `:47-60` | **无（登录前豁免）** | `InviteVerifyOut` |
| 3 | `POST /api/auth/onboard` | `onboard` | `:63-84` | **无（登录前豁免）** | `OnboardResponse` |
| 4 | `GET /api/auth/me` | `me` | `:87-89` | `Depends(get_current_user)` | `UserOut` |
| 5 | `PUT /api/auth/nickname` | `update_nickname` | `:92-104` | `Depends(get_current_user)` | `UserOut` |
| 6 | `PUT /api/auth/nickname/initial` | `set_initial_nickname` | `:107-123` | `Depends(get_current_user)` | `UserOut` |

关于不变量 2（`backend/AGENTS.md`：「除 `POST /api/auth/login` 外所有路由必须依赖 `Depends(get_current_user)`」）：端点 2、3 同样不带该依赖，因为它们与 login 一样处于**登录前**阶段（未入驻用户尚无令牌）；`afbcba9` 引入时即如此，属准入模型的必要豁免。全文件其余端点均依赖 `get_current_user`（`backend/app/api/deps.py:17-43`）。

辅助函数 `_after_sign_in(user, event)`（`:25-26`）：登录/入驻成功后向所有 WebSocket 连接广播 `data_changed` 事件（reason 为 `auth.login` / `auth.onboard`），经 `backend/app/core/ws.py:23-25` `build_event` 构造。

### 4.1 `POST /api/auth/login` 完整链路（`:29-44`）

1. 请求体 `LoginRequest`（`backend/app/schemas/schemas.py:39-44`）：`code`（wx.login 临时凭证，必填）、`avatar`（可选，默认 `""`）、`nickname`（可选，**本路由未读取该字段**，`auth.py:38` 只取 `payload.code` 与 `payload.avatar`，属遗留字段）。
2. 调 `auth_service.wx_login(db, code, avatar)`（`backend/app/services/auth_service.py:68-83`）：
   - `_resolve_openid`（`backend/app/services/auth_service.py:41-48`）调 `core/wx.py` 的 code2session；**mock openid 降级条件**：仅当 `WX_APPID`/`WX_SECRET` 未配置，或显式开启 `WX_LOGIN_ALLOW_MOCK`（仅本地测试，`backend/app/core/config.py:45-46`）时才回退 `_mock_openid`（`:35-38`，由 code 的 MD5 稳定派生）；已配置凭证且未开 mock 开关时换取失败抛 `WxLoginError`，路由转 **502**，detail「微信登录失败，请重试」（`auth.py:39-40`、`auth_service.py:47`）。
   - 按 openid 查 `users`：**查无此人 → `status="unregistered"`；`status != active` → `status="disabled"`；二者均不签发令牌**（`auth_service.py:79-82`）；active → `_sign_in`（`auth_service.py:51-61`：更新头像、真实微信响应时同步 `wx_mini` 身份行、`create_access_token` 签发 7 天 JWT）→ `status="active"`。
3. **三态表达**：HTTP 200 + 响应体 `LoginResponse.status` 字段（`schemas.py:47-52`）：`active` 带 `token`/`user`；`unregistered`/`disabled` 二者为 null。注意：**login 的 disabled 态不走 `X-Account-Status` 响应头**（200 状态码），该头只出现在 onboard 的 403（`auth.py:78-80`）与 `deps.get_current_user` 的 403（`backend/app/api/deps.py:46-53`）——准入判定「靠响应头不靠状态码」针对的是**已登录后的受保护接口**，login 本身用响应体字段表达。
4. 成功后 `_after_sign_in(user, "auth.login")`（`:43`）广播 WS 事件。
5. 小程序侧消费：`frontend/services/auth.js:99-114`（active 落 Token；disabled/unregistered 抛 admission 错误交启动页分流）。
6. **无限流**：`core/rate_limit.py:31` 的 `login_limiter` 只用于管理端账号登录（`backend/app/api/routes/admin.py:107`），`/auth/login` 未挂任何限流器（依赖 wx.login code 一次性有效这一微信侧约束）。

### 4.2 邀请码校验与入驻的前后关系（端点 2 → 端点 3）

- `POST /api/auth/invite/verify`（`:47-60`）**只查不核销**：`invite_service.get_usable`（`backend/app/services/invite_service.py:53`）校验有效性；不可用抛 `InviteError` → **400**，detail 为具体原因：「邀请码无效 / 已停用 / 已过期 / 使用次数已满」（`invite_service.py:43-49`）。返回 `InviteVerifyOut`（`schemas.py:61-66`）：`name`（邀请码名称）、`orgId`/`orgName`（组织范围锁定，null 表示不限）。**不返回邀请码本身与使用次数**（`:49` docstring 与 `:56-60` 实现一致）。
- `POST /api/auth/onboard`（`:63-84`）是**核销 + 建号**：`auth_service.onboard`（`backend/app/services/auth_service.py:92-155`）在同一事务内校验邀请码与组织范围（`ensure_org_in_scope`，`invite_service.py:68-73`，越界 400「所选组织不在邀请码允许的范围内」）、条件 UPDATE 原子核销（`consume`）、建 `users` 行并写审计（`auth_service.py:139-142`）。**幂等**：该微信身份已入驻时直接复用并签发令牌、不再核销（`auth_service.py:102-104`、`:118-124`、`:144-149`，覆盖重复提交/中途退出重扫/openid 唯一约束并发冲突三种情形），响应 `created` 字段区分新建与复用。
- 失败分支：`WxLoginError` → **502**；`AccountDisabledError`（已入驻但被停用后重复提交）→ **403 + `X-Account-Status: disabled` 头**，detail「账号已停用，请联系活动管理员」（`auth.py:77-80`、`auth_service.py:24`、`:86-89`）；`ValueError`（如「请填写姓名」，`auth_service.py:108`）与 `InviteError`（含核销失败后的「邀请码使用次数已满」，`auth_service.py:114-117`）→ **400**。
- 两个端点均挂 `invite_limiter`（60 次/分/IP，`backend/app/core/rate_limit.py:35`），超限 **429**「操作过于频繁，请稍后再试」（`auth.py:50`、`:69`）。
- 前端时序：启动页扫邀请码 → `frontend/pages/launch/launch.js:90` `verifyInvite` → 跳入驻页 → `frontend/pages/onboard/onboard.js:80` `auth.onboard`。verify 的作用是在用户填写信息**前**先确认码可用并取回组织锁定范围，onboard 提交时才真正核销；两次调用之间码可能被他人用满，故 onboard 自身完整重新校验。

### 4.3 两个昵称端点的确切区别（从 `backend/app/services/auth_service.py:158-195` 读出）

| | `PUT /auth/nickname`（`update_nickname`） | `PUT /auth/nickname/initial`（`set_initial_nickname`） |
|---|---|---|
| service | `auth_service.update_nickname`（`:158-177`） | `auth_service.set_initial_nickname`（`:180-195`） |
| 是否消耗「每人仅一次」改名机会 | **是**：写入 `nickname_changed_at`（`:174`），此后再调本端点 400「昵称仅可修改一次，无法再次修改」（`:166-167`） | **否**：只改 `nickname`，不写 `nickname_changed_at`（`:192-193`） |
| 曾用名回填 | 修改前把当前昵称记入 `original_nickname`（兼容存量用户，`:170-172`） | 不写 `original_nickname` |
| 已改过名（`nickname_changed_at` 非空）时 | 400「昵称仅可修改一次，无法再次修改」 | 400「昵称已修改过，无法覆盖」（`:188-189`，防止用 initial 端点绕开唯一机会限制） |
| 新名与当前名相同 | 视为无操作直接返回，不消耗机会（`:168-169`） | 同样无操作返回（`:190-191`） |
| 空昵称 | 400「昵称不能为空」（`:164-165`；另有 Pydantic 层 `min_length=1` 前置拦截，`schemas.py:85-88`） | 同左（`:186-187`） |
| 调用方 | `frontend/pages/mine/mine.js:132`（「我的」页改名，`frontend/services/auth.js:223-228`） | `frontend/pages/org-select/org-select.js:159`（首次引导选组织时用 `<input type="nickname">` 采集微信名，失败不阻塞；`frontend/services/auth.js:230-235`；`frontend/AGENTS.md` 不变量 7 亦载明「不消耗改名机会」） |

结论：`initial` 端点**是**首次设置专用、**不占用**那唯一一次改名机会；但它只在用户尚未行使改名机会时可用。两端点成功后都广播 `data_changed`（reason `auth.nickname`，`auth.py:103`、`:122`）并返回最新 `UserOut`。

## 5. 输入与输出

- 请求体 Schema（均为 Pydantic `BaseModel` + `populate_by_name`，接受 camelCase 别名）：`LoginRequest`（`schemas.py:39-44`）、`InviteVerifyRequest`（`inviteCode`，max_length=64，`:55-58`）、`OnboardRequest`（`code`/`inviteCode`/`nickname`(1-64)/`orgId`/`avatar`(≤500)，`:69-76`）、`NicknameUpdateRequest`（`nickname` 1-64，`:85-88`）。
- 响应 Schema（均 `CamelModel`，输出 camelCase）：`LoginResponse`（`:47-52`）、`InviteVerifyOut`（`:61-66`）、`OnboardResponse`（`token`/`user`/`created`，`:79-82`）、`UserOut`（`id`/`nickname`/`avatar`/`orgId`/`nicknameChangedAt`，avatar 空值归一为 `""`，`:26-36`）。
- 错误码汇总：400（业务校验，detail 见 §4）、401（`get_current_user` 链，`deps.py:22-41`）、403+`X-Account-Status: disabled`（onboard 停用 / 受保护端点停用）、429（邀请码限流）、502（微信换取失败）。Pydantic 请求体校验失败由 FastAPI 返回 422（框架默认，本文件无自定义处理）。

## 6. 依赖关系

- 依赖：`backend/app/api/deps.py`（`get_current_user`）、`backend/app/core/rate_limit.py`（`invite_limiter`）、`backend/app/core/ws.py`（广播，**注意是 core/ws.py，不是 routes/ws.py**）、`backend/app/core/database.py`（`get_db`）、`backend/app/models/models.py`（`User`）、`backend/app/schemas/schemas.py`（8 个 Schema）、`backend/app/services/auth_service.py` / `invite_service.py` / `org_service.py`。
- 被依赖：`backend/app/main.py:71` 注册；小程序 `frontend/services/auth.js`（login/me/nickname/nickname/initial/invite/verify/onboard 六个函数一一对应本文件 6 个端点）。
- 数据库表：`users`（读写）、`invite_codes`（verify 读 / onboard 条件 UPDATE 核销）、`user_identities`（`_sign_in`/onboard 经 `identity_service.ensure_wx_mini_identity` 同步）、`audit_logs`（onboard 写 `user.onboard` 审计，`auth_service.py:139-142`）。
- 事务边界：本文件全部为**服务层自提交**（`auth_service.py:55`/`:143`/`:175`/`:193` 等 `db.commit()`），路由层不 commit。

## 7. 业务规则

1. **不自动建号**：login 只识别身份，建号唯一入口是 onboard（`auth_service.py:3`、`:73` docstring）。
2. **一人一号**：openid 唯一约束 + 并发冲突回滚复用（`auth_service.py:98-99`、`:144-149`）。
3. **已入驻用户登录不校验原邀请码**（过期/停用/用满不影响，`auth_service.py:74`）。
4. **昵称仅可修改一次**（`nickname_changed_at` 为判据），首次引导设置不消耗该机会（§4.3）。
5. **副作用链（`backend/AGENTS.md` 不变量 5）**：不变量条文列举了 login，但**当前代码中 login/onboard 不调用 `medal_service.check_and_grant`，也不产生积分**（grep `check_and_grant` 全 backend/app 仅命中 `routes/medal.py:19`/`:29`、`routes/march.py:71`、`routes/quiz.py:35`/`:51`、`routes/sport.py:48`/`:80` 及 event/medal service 注释）。事实依据：`2f3f333`（2026-10-13）积分台账重构移除了 `_after_sign_in` 中的 `grant_daily_login`（提交信息「移除登录/达标/点亮/里程碑积分」，`docs/迭代记录.md:387`）；本文件保留的登录副作用只有 WS `data_changed` 广播。不变量条文与代码的这一出入属文档滞后，记录在此、不改代码。
6. **脱敏**：verify 不返回邀请码原文与使用次数（`:49`）；`afbcba9` 提交信息载明「日志/响应脱敏（不含 openid/session_key/wx code/原码）」。

## 8. 修改约束

1. 三态 `LoginResponse.status` 字符串（`active`/`unregistered`/`disabled`）是与 `frontend/services/auth.js:100-113`、`frontend/pages/launch/launch.js` 分流逻辑的硬契约，改值即破坏小程序启动链。
2. `OnboardResponse.created` 与幂等语义（重复提交返回令牌而非报错）被入驻页依赖，不得改为「重复入驻报错」。
3. 403 响应必须携带 `X-Account-Status: disabled` 头（`auth.py:79`），小程序 `frontend/services/request.js:81-86` 据此清会话，缺失将退化为普通 403 无跳转。
4. 响应模型必须继承 `CamelModel`（不变量 1）；路由层不得写业务规则、不得直接 commit（`backend/AGENTS.md` §3.1）。
5. 新增登录前豁免端点需显式说明理由（不变量 2）。
6. 两个昵称端点的「机会消耗」语义不可互换或合并，`frontend/AGENTS.md` 不变量 7 已把 initial 端点行为写入小程序侧契约。

## 9. 当前实现状态

- **已实现**：6 个端点全部可用；准入模型（verify→onboard→login 三态）经 `afbcba9` 的 s19 冒烟 25/25 + 真实 openGauss 并发 3/3 验证（提交信息，`docs/迭代记录.md:420`）。
- **存在问题 / 已知事项**：
  1. `LoginRequest.nickname` 字段声明但路由未使用（§4.1），属遗留冗余，删除需同步核对小程序请求体（`frontend/services/auth.js:96` 当前未发送该字段）。
  2. `/auth/login` 无限流（§4.1 第 6 点），防爆破完全依赖微信 code 一次性语义；mock 模式下（本地）无此保障。
  3. 不变量 5 条文与代码的 login/勋章出入（§7 第 5 条）。
- **待确认**：无（本文件范围内）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/auth.py`（6 个提交），与 `docs/迭代记录.md` 交叉核对。按时间倒序。

### 2026-10-13（`2f3f333`，11:25，`docs/迭代记录.md:387`）
- 需求：积分台账重构（总积分=步行+答题，biz_key 每日幂等）。
- 修改内容（涉本文件，据 diff 核实）：`_after_sign_in` 移除 `points_service.grant_daily_login` 调用并去掉 db 参数（登录不再产生积分），login docstring 同步删除「发放每日登录积分」表述；本文件自此不再 import `points_service`。
- 关联文件：`backend/app/services/points_service.py`、`docker/init/017_*.sql` 等（详见迭代记录条目）。
- 测试结果：见 `docs/迭代记录.md:387` 条目。

### 2026-10-12（`afbcba9`，`docs/迭代记录.md:420`）
- 需求：邀请码准入全链路。
- 修改内容（涉本文件）：login 改状态式三态返回、不自动建号；新增 `POST /auth/invite/verify` 与 `POST /auth/onboard`（原子核销+建号+审计+幂等复用）；停用账号 403+`X-Account-Status` 头；邀请码限流 60 次/分/IP。
- 关联文件：`backend/app/services/auth_service.py`、`invite_service.py`、`docker/init/015_*.sql`、admin、frontend。
- 测试结果：s19 功能/权限/脱敏 25/25 + 真实 openGauss 并发 3/3（提交信息）。

### 2026-10-11（`67c96b1`，`docs/迭代记录.md:568`）
- 需求：V1.0 扫码入驻登录健壮性。
- 修改内容（涉本文件，据 diff 核实）：login 增加 `try/except auth_service.WxLoginError` → 502（此前微信换取失败无捕获）；已配置微信凭证时不回退 mock openid（该逻辑在 `auth_service._resolve_openid`）；并发首登唯一约束复用在 service 层。当时 login 仍为自动建号模型，三态返回由次日 `afbcba9` 引入。
- 测试结果：见 `docs/迭代记录.md:568` 条目。

### 2026-10-01（`43877dc`，16:51，`docs/迭代记录.md:868`）
- 需求：首次引导设置昵称。
- 修改内容（涉本文件）：新增 `PUT /auth/nickname/initial`（`:107-123`），不消耗「每人仅一次」改名机会。
- 测试结果：见 `docs/迭代记录.md:868` 条目。

### 2026-10-01（`f820e0e`，15:54，`docs/迭代记录.md:884`）
- 需求：微信名称直登与昵称仅可修改一次（三端）。
- 修改内容（涉本文件）：新增 `PUT /auth/nickname`；`UserOut` 增加 `nicknameChangedAt`。
- 测试结果：见 `docs/迭代记录.md:884` 条目。

### 2026-09-30（`a94e685`，18:05，`docs/迭代记录.md:927`）
- 需求：项目初始化。
- 修改内容（涉本文件）：创建，含 login/me 等初始端点。
- 测试结果：早期简略条目，未记载验证结果（待确认）。
