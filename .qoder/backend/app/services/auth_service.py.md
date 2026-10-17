# auth_service.py

## 1. 文件路径
`backend/app/services/auth_service.py`（195 行）

## 2. 文件职责
小程序端的**登录与入驻服务**：用 `wx.login` 的 code 换取 openid（真实微信或本地 mock），据此判定「已入驻 / 未入驻 / 已停用」三态并签发用户 JWT；承载**全仓唯一的建号入口** `onboard`（邀请码校验 + 组织范围校验 + 原子核销 + 建号 + 审计，同一事务提交）；以及「每人仅一次」的改名与不消耗机会的首次引导改名。本文件**不解析令牌、不抛 HTTP 异常**——401/403/400/502 的映射在 `backend/app/api/routes/auth.py` 与 `backend/app/api/deps.py`。

## 3. 业务需求
- **需求清单**：`.qoder/REQUIREMENTS.md` §2.1「登录」（`:56-69` 表格，其中 `:60` 换取失败 502 不回退 mock、`:61` mock 回退条件、`:62` 三态返回、`:67-68` 两个昵称接口）；§2.2「入驻与邀请码」（`:71-85` 表格，其中 `:75` 准入模型、`:78` 原子核销、`:79` 一次性语义、`:82` 入驻接口、`:83` 敏感信息约束）。
- **架构定位**：`.qoder/ARCHITECTURE.md` §3.2「小程序登录链」（`:168`）、§4.3 状态码约定（`:207` 502）、§4.6 准入控制响应头、§5.1 三类 JWT（`:250`）、§5.2 小程序用户鉴权链（`:260-268`）、§9.4 事务边界（`:478-489`）、§10.2 审计（`:505-507`）。
- **前置分析文档**：`docs/长征步迹V1.0_扫码入驻与自动登录差异分析.md`（`67c96b1` 的输入，见 `docs/迭代记录.md` 的 `67c96b1` 条目）。身份关联侧设计见 `docs/identity-binding-design.md`，本文件只在 `:57-60`、`:151-154` 调 `identity_service.ensure_wx_mini_identity` 与之衔接，**不复述其正文**（详见 `.qoder/backend/app/services/identity_service.py.md`）。
- **交付批次**：`a94e685`（2026-09-30）创建；`f820e0e`/`43877dc`（2026-10-01）加入两个昵称函数；`b431e4d`（2026-10-09）登录同步采集 unionid；`3df3fd0`（2026-10-10）code2session 收敛到 `core/wx.py`；`67c96b1`（2026-10-11）「不回退 mock」+ 并发首登复用；`afbcba9`（2026-10-12）改为状态式登录并新增 `onboard`。

## 4. 核心功能

### 4.1 模块 docstring 与常量（`:1-32`）
- `:1-7` 三句契约：登录「不建号」（`:3`）；入驻「仅持 PC 后台生成的有效邀请码可建号」（`:4`）；mock openid **仅**在未配置 `WX_APPID`/`WX_SECRET` 时使用，**已配置凭证时微信换取失败一律拒绝登录、不回退 mock，避免产生"假登录"用户**（`:5-6` 原文）。
- `:21-23` 三个登录态常量 `LOGIN_ACTIVE`/`LOGIN_UNREGISTERED`/`LOGIN_DISABLED`，值 `active`/`unregistered`/`disabled`。与 `backend/app/schemas/schemas.py:48` 的 `LoginResponse` docstring、`frontend/services/auth.js:100`（active）/`:109`（disabled）/`:113`（其余按未入驻）的分支一一对应。**这三个常量只在 `:80`/`:82`/`:83` 被本文件自己使用**（全仓 grep 无其他引用），前端比较的是字面量字符串。
- `:24` `ACCOUNT_DISABLED_MESSAGE`，被 `backend/app/api/deps.py:51` 复用为所有受保护接口 403 的 detail —— **停用文案全仓仅此一处定义**。
- `:27-28` `WxLoginError`（code 换取失败）、`:31-32` `AccountDisabledError`（账号停用）。二者继承 `Exception` 而**非** `ValueError`，因此不会被路由的 `except ValueError` 兜住，路由用独立分支映射 502 / 403（`backend/app/api/routes/auth.py:39-40`、`:75-80`）。对比：邀请码错误 `invite_service.InviteError` **继承 `ValueError`**（`backend/app/services/invite_service.py:29`），故统一落到 400。

### 4.2 `_mock_openid(code)` — `:35-38`
`"mock_" + md5(code or "dev").hexdigest()[:24]`，共 29 字符，落在 `users.openid`（`String(64)` 且 `unique=True, index=True`，`backend/app/models/models.py:191`）内。
- openid **完全由入参 code 派生**，故 mock 身份的稳定度等同 code 的稳定度；`backend/test/s19_invite_admission.py:577` 直接传固定字符串来断言「未建号」。
- `mock_` 前缀是下游判定「模拟用户」的唯一依据：`backend/app/services/sport_service.py:100`、`:150` 用 `openid.startswith("mock_")` 决定是否回退模拟步数。

### 4.3 `_resolve_openid(code)` — `:41-48`
1. `:43` 调 `backend/app/core/wx.py:18-42` 的 `code2session(code)`。该函数在未配置凭证（`backend/app/core/wx.py:20-21`）、响应无 `openid`（`:34-35`）、任何异常（`:41-42`）时**返回 None，从不抛异常**。
2. `:44-45` 拿到会话信息即返回 `(session_info["openid"], session_info)`；`session_info` 含 `openid`/`unionid`/`session_key` 三键（`backend/app/core/wx.py:36-40`）。**`session_key` 在本文件内只作为返回值流转，从不落库、不写日志**（与 `backend/app/core/wx.py:3` 同一约定）。
3. `:46-47` 唯一的「拒绝登录」判定：`WX_APPID` 与 `WX_SECRET` **同时非空**且 `WX_LOGIN_ALLOW_MOCK` 为假 → 抛 `WxLoginError("微信登录失败，请重试")`。三个配置项定义于 `backend/app/core/config.py:43`/`:44`/`:46`；`WX_LOGIN_ALLOW_MOCK` 默认 `False`，注释写明「仅限本地自动化测试……生产必须为 false」（`backend/app/core/config.py:45-46`），生产文件显式设为 false（见 `.qoder/backend/.env.prod.md:38`），本地 `backend/.env` 未设置故取默认值（见 `.qoder/backend/.env.md:99`）。
4. `:48` 其余情况回退 mock，且**会话信息为空字典 `{}`** —— 这个空字典是下游「是否写身份关联行」的开关（见 4.4）。

### 4.4 `_sign_in(db, user, session_info, avatar)` — `:51-61`
两个签发入口（`wx_login:83`、`_resume:89`）共用：
- `:53-56` 头像**仅在传入且与库中不同**时更新，并**立即 `db.commit()` + `db.refresh()`** —— 这是一次独立事务，早于后续任何写操作（见 §7.2）。静默重登传空串（`frontend/services/auth.js:135` 调 `callLogin('')`），不会清空头像。
- `:57-60` **仅当 `session_info` 非空**（即真实微信响应）才调 `identity_service.ensure_wx_mini_identity(db, user, session_info["openid"], session_info.get("unionid"))`（`backend/app/services/identity_service.py:264`）。mock 模式下 `session_info == {}` → **不写 `user_identities` 行**。
- `:61` `create_access_token(user.id, user.openid)`（`backend/app/core/security.py:10-19`）：HS256、`sub` = 用户主键字符串、载荷含 `openid`/`iat`/`exp`，有效期 `JWT_EXPIRE_MINUTES` = 10080 分钟（7 天，`backend/app/core/config.py:39`）。**令牌内不含权限、不含角色**，用户侧每次请求查库校验（`.qoder/ARCHITECTURE.md` §5.1）。

### 4.5 `wx_login(db, code, avatar="")` — `:68-83`
返回三元组 `(status, token, user)`：
- `:77` 先 `_resolve_openid`，失败即抛 `WxLoginError`，**不查库、不建号**。
- `:78-80` `_find_user`（`:64-65`，按 openid 精确匹配取第一条）查不到 → `(unregistered, None, None)`。
- `:81-82` `user.status != invite_service.STATUS_ACTIVE`（`backend/app/services/invite_service.py:24`，值 `"active"`）→ `(disabled, None, None)`，**不签发令牌**。
- `:83` 否则 `(active, _sign_in(...), user)`。
- docstring `:74` 明确：**已入驻用户登录不校验原邀请码**（过期/停用/用满均不影响），与 `.qoder/REQUIREMENTS.md` §2.2「一次性语义」行一致。
- `nickname` 参数在 `afbcba9` 已移除（原签名 `wx_login(db, code, nickname="", avatar="")`）；`LoginRequest.nickname` 字段仍保留（`backend/app/schemas/schemas.py:43`）但路由不再向下传（`backend/app/api/routes/auth.py:38` 只传 `code` 与 `avatar`）。

### 4.6 `_resume(db, user, session_info, avatar)` — `:86-89`
`onboard` 三条「已入驻」复用出口（`:104`、`:123`、`:149`）的统一收敛点：停用账号抛 `AccountDisabledError(ACCOUNT_DISABLED_MESSAGE)`，否则 `_sign_in` 并返回 `(token, user, created=False)`。`created=False` 让前端区分「入驻成功」与「欢迎回来」（`frontend/pages/onboard/onboard.js:94`）。

### 4.7 `onboard(db, code, invite_code, nickname, org_id, avatar="")` — `:92-155`
唯一建号入口，7 个阶段（事务时序见 §7.2、幂等与并发见 §7.3）：
1. `:101-104` `_resolve_openid` → 按 openid 查已有用户，命中即 `_resume` 直接签发，**不核销邀请码**（docstring `:97-99` 列明覆盖「中途退出后重新扫码、重复提交、并发提交」三种幂等场景）。
2. `:106-108` 昵称 `strip()` 后为空 → `ValueError("请填写姓名")`。`OnboardRequest.nickname` 已有 `min_length=1, max_length=64`（`backend/app/schemas/schemas.py:74`），但**纯空格串能通过 `min_length=1`**，故此处二次校验不可省；长度上限只由 schema 保证，服务层不再校验。
3. `:110-117` 邀请码阶段（整体在 `try` 内）：
   - `:111` `invite_service.get_usable(db, invite_code, now)`（`backend/app/services/invite_service.py:53-61`）：格式正则不匹配或查不到一律「邀请码无效」，再依次校验启用/未过期/未用满（`backend/app/services/invite_service.py:41-50`），失败抛 `InviteError`。
   - `:112` `ensure_org_in_scope(db, invite, org_id)`（`backend/app/services/invite_service.py:73-74` → `_ensure_in_scope:64-70`）：组织不存在抛「所选组织不存在」；专属码时要求 `org_id` 位于该组织子树内（含自身），否则抛「所选组织不在邀请码允许的范围内」。
   - `:113` **先取出 `invite.id` / `invite.name`** 供后续审计使用。
   - `:114` `invite_service.consume(db, invite_id, now)`（`backend/app/services/invite_service.py:77-90`）：把启用/次数/有效期三个有效性条件**全部写进 UPDATE 的 WHERE**，按 `rowcount == 1` 判定成功，**不提交**。
   - `:115-117` 核销失败时先 `db.rollback()`，再**重跑一次 `get_usable`（其返回值被丢弃，仅为让准确的失败原因先抛出）**，然后抛 `InviteError("邀请码使用次数已满")`。
4. `:118-124` `except invite_service.InviteError`：`db.rollback()`（**核销随之撤销**）→ 重新按 openid 查用户，命中则 `_resume` 复用（注释 `:119`：同一身份的并发请求可能已先入驻并核销）→ 未命中则 `raise` 原样上抛。
5. `:126-136` 构造 `User(openid, nickname, original_nickname=同名, avatar or None, org_id, status=active, invite_code_id, onboarded_at=now)` 并 `db.add`。**`nickname` 与 `original_nickname` 同时写入** → 入驻姓名即「曾用名」基线，管理端据此展示改名前后对比（读取点 `backend/app/services/admin_service.py:281-282`、`:466-473`、`:560-561`）。
6. `:137-149` `db.flush()` 拿到自增 id → `audit_service.record(db, "user", user.id, "user.onboard", user.id, {"invite_id", "invite_name", "org_id"})`（`backend/app/services/audit_service.py:14-36`，**只 `db.add` 不 commit**，见 `:2-5` docstring）→ `:143` **单次 `db.commit()`**，用户行 + 邀请码 `used_count+1` + 审计行原子落库。`except IntegrityError` → `db.rollback()` → 复查 openid，命中 `_resume`，未命中 `raise`（`:144-149`）。
7. `:150-155` `db.refresh(user)` → 真实微信响应时补写 `user_identities` → 返回 `(create_access_token(...), user, True)`。

审计 detail **只写邀请码 id 与名称、不写原码**，符合 `.qoder/REQUIREMENTS.md` §2.2「敏感信息约束」行；也不含 openid、code、session_key。

### 4.8 `update_nickname(db, user, nickname)` — `:158-177`
「每人仅一次」的**唯一强制执行点**（各层职责见 §7.5）：
- `:163-165` 空昵称 → `ValueError("昵称不能为空")`。
- `:166-167` `user.nickname_changed_at is not None` → `ValueError("昵称仅可修改一次，无法再次修改")`。
- `:168-169` 新名与当前名相同 → **直接返回、不提交、不消耗机会**（docstring `:161`）。
- `:170-172` 曾用名为空时先把当前昵称回填为 `original_nickname`（注释 `:170` 说明是兼容未回填的存量用户；迁移侧批量回填见 `docker/init/004_nickname_change.sql:8-10`）。
- `:173-176` 写 `nickname` 与 `nickname_changed_at = datetime.utcnow()`，`db.commit()` + `db.refresh()`。

### 4.9 `set_initial_nickname(db, user, nickname)` — `:180-195`
首次引导（组织选择页采集微信名）用：`:188-189` 已使用过改名机会则 `ValueError("昵称已修改过，无法覆盖")`（docstring `:183` 说明目的是「避免绕开唯一机会限制」）；`:190-191` 同名无操作；`:192-194` 只写 `nickname`、**不写 `nickname_changed_at`** → 可重复调用。调用方 `frontend/pages/org-select/org-select.js:158-160` 以 `.catch(() => null)` **吞掉失败**并继续 `org.select`。

## 5. 输入与输出

### 5.1 函数签名
| 函数 | 行 | 入参 | 返回 | 抛出 |
|---|---|---|---|---|
| `_mock_openid` | `:35-38` | `code: str` | `str`（`mock_` + 24 位） | — |
| `_resolve_openid` | `:41-48` | `code: str` | `Tuple[str, dict]` | `WxLoginError` |
| `_sign_in` | `:51-61` | `db, user, session_info: dict, avatar: str` | `str`（JWT） | 透传 `identity_service` 异常 |
| `_find_user` | `:64-65` | `db, openid` | `Optional[User]` | — |
| `wx_login` | `:68-83` | `db, code, avatar=""` | `Tuple[str, Optional[str], Optional[User]]` | `WxLoginError` |
| `_resume` | `:86-89` | `db, user, session_info, avatar` | `Tuple[str, User, bool]`（`created=False`） | `AccountDisabledError`、`WxLoginError` 不在此层 |
| `onboard` | `:92-155` | `db, code, invite_code, nickname, org_id: int, avatar=""` | `Tuple[str, User, bool]` | `WxLoginError`、`AccountDisabledError`、`ValueError`（含 `InviteError`） |
| `update_nickname` | `:158-177` | `db, user, nickname` | `User` | `ValueError` |
| `set_initial_nickname` | `:180-195` | `db, user, nickname` | `User` | `ValueError` |

### 5.2 对外 HTTP 契约（本服务的全部出口）
路由前缀 `/api` 来自 `backend/app/core/config.py:25`，在 `backend/app/main.py:71` 挂载。

| 方法 + 路径 | 路由 | 服务函数 | 请求 schema | `response_model` | 权限依赖 | 限流 |
|---|---|---|---|---|---|---|
| `POST /api/auth/login` | `backend/app/api/routes/auth.py:29-44` | `wx_login:68-83` | `LoginRequest`（`backend/app/schemas/schemas.py:39-44`） | `LoginResponse`（`:47-52`） | 无（公开） | **无** |
| `POST /api/auth/onboard` | `backend/app/api/routes/auth.py:63-84` | `onboard:92-155` | `OnboardRequest`（`backend/app/schemas/schemas.py:69-76`） | `OnboardResponse`（`:79-82`） | 无（公开） | `invite_limiter` 60 次/分/IP（`backend/app/api/routes/auth.py:69`） |
| `PUT /api/auth/nickname` | `backend/app/api/routes/auth.py:92-104` | `update_nickname:158-177` | `NicknameUpdateRequest`（`backend/app/schemas/schemas.py:85-88`） | `UserOut`（`:26-36`） | `get_current_user` | **无** |
| `PUT /api/auth/nickname/initial` | `backend/app/api/routes/auth.py:107-123` | `set_initial_nickname:180-195` | 同上 | `UserOut` | `get_current_user` | **无** |

`POST /api/auth/invite/verify`（`backend/app/api/routes/auth.py:47-60`）与 `GET /api/auth/me`（`:87-89`）**不经过本文件**：前者直接调 `invite_service`，后者只依赖 `get_current_user`。

登录态与 `created` 均通过响应体传递；`X-Account-Status: disabled` 响应头由 `backend/app/api/deps.py:52`（受保护接口）与 `backend/app/api/routes/auth.py:79`（onboard）两处设置。成功后路由广播 WS 事件（`backend/app/api/routes/auth.py:25-26`）：`auth.login`（`:43`）、`auth.onboard`/`auth.login`（`:83`，按 `created` 分流）、`auth.nickname`（`:103`、`:122`）。

### 5.3 异常 → HTTP 映射
| 服务层异常 | 抛出点 | 路由处理 | HTTP |
|---|---|---|---|
| `WxLoginError` | `:47` | `backend/app/api/routes/auth.py:39-40`、`:75-76` | 502 |
| `AccountDisabledError` | `:88` | `backend/app/api/routes/auth.py:77-80` | 403 + `X-Account-Status: disabled` |
| `ValueError("请填写姓名")` | `:108` | `backend/app/api/routes/auth.py:81-82` | 400 |
| `invite_service.InviteError`（无效/停用/过期/用满/组织越界） | `:111`、`:112`、`:117` | 同上（`InviteError` 是 `ValueError` 子类） | 400 |
| `ValueError("昵称不能为空" / "昵称仅可修改一次…" / "昵称已修改过，无法覆盖")` | `:165`、`:167`、`:187`、`:189` | `backend/app/api/routes/auth.py:99-102`、`:118-121` | 400 |
| `IntegrityError`（非 openid 冲突，或冲突后仍查不到用户） | `:144-148` 上抛 | **无专门分支** | 500 |

停用账号访问其他受保护接口时，403 文案同样来自本文件 `:24`（`backend/app/api/deps.py:46-53`）；WS 握手对停用用户直接 4403 关闭（`backend/app/api/routes/ws.py:46-50`）。

## 6. 依赖关系

### 6.1 本文件依赖（`:8-19`，全部被使用，无死导入）
| 导入 | 行 | 用途 |
|---|---|---|
| `hashlib` | `:8` | `_mock_openid:38` |
| `datetime` | `:9` | `:109`、`:116`、`:174` |
| `Optional` / `Tuple` | `:10` | 类型标注 |
| `sqlalchemy.exc.IntegrityError` | `:12` | `:144` |
| `sqlalchemy.orm.Session` | `:13` | 类型标注 |
| `app.core.config.settings` | `:15` | `:46` |
| `app.core.security.create_access_token` | `:16` | `:61`、`:155` |
| `app.core.wx.code2session` | `:17` | `:43` |
| `app.models.models.User` | `:18` | `:65`、`:126` |
| `app.services.audit_service` | `:19` | `:139` |
| `app.services.identity_service` | `:19` | `:58`、`:152` |
| `app.services.invite_service` | `:19` | `:81`、`:87`、`:111-118`、`:132` |

跨服务调用属常规做法（`.qoder/ARCHITECTURE.md` §3.1）。**本文件不 import `httpx`**——微信 HTTP 调用已在 `3df3fd0` 收敛到 `backend/app/core/wx.py`。

### 6.2 谁依赖本文件
| 调用方 | 位置 | 用到的符号 |
|---|---|---|
| `backend/app/api/routes/auth.py` | `:20` 导入；`:38`、`:71`、`:100`、`:119` 调用；`:39`、`:75`、`:77` 捕获异常 | `wx_login`、`onboard`、`update_nickname`、`set_initial_nickname`、`WxLoginError`、`AccountDisabledError` |
| `backend/app/api/deps.py` | `:51` | `ACCOUNT_DISABLED_MESSAGE` |
| `backend/test/s19_invite_admission.py` | `:87`、`:181`、`:319`、`:346`、`:460`、`:573`、`:593` 替换 `auth_service.code2session`；`:392` 直调 `onboard`；`:577` 用 `_mock_openid` | 测试桩 |
| `backend/test/s19_invite_concurrency_pg.py` | `:65`、`:103`、`:131` 替换 `auth_service.code2session` | 真实 openGauss 并发测试桩 |

### 6.3 数据库表
| 表 | 访问方式 | 位置 |
|---|---|---|
| `users` | 按 openid 查（`:65`）、插入（`:126-136`）、更新头像（`:53-56`）与昵称（`:173-174`、`:192`） | 模型 `backend/app/models/models.py:179-205` |
| `invite_codes` | 经 `invite_service` 读 + 条件 UPDATE 核销（不提交） | `backend/app/services/invite_service.py:53-61`、`:77-90` |
| `organizations` | 经 `invite_service` → `org_service.get_path` 只读（校验组织子树） | `backend/app/services/invite_service.py:66` |
| `user_identities` | 经 `identity_service.ensure_wx_mini_identity` 读/写/自行提交 | `backend/app/services/identity_service.py:264-314` |
| `audit_logs` | 经 `audit_service.record` 只 `db.add`，由本文件 `:143` 提交 | `backend/app/services/audit_service.py:28-36` |

## 7. 业务规则

### 7.1 准入模型：登录不建号
`afbcba9` 之前 `wx_login` 会自动建号（旧函数 `_get_or_create_user`，由 `67c96b1` 引入、`afbcba9` 删除，见 `git log -S"_get_or_create_user"`）。现行规则：**openid 不在 `users` 表中一律返回 `unregistered` 且不写任何数据**（`:79-80`）；建号只能走 `onboard` 且必须持可用邀请码。已入驻用户登录**不再回看邀请码状态**（`:74` docstring、`:81` 只判 `users.status`）。

### 7.2 事务边界（谁 commit）
本服务属**服务层自提交**约定（`.qoder/ARCHITECTURE.md` §9.4）。全部提交/回滚点：

| 位置 | 动作 | 落库内容 |
|---|---|---|
| `:55` | `commit` + `refresh` | 仅头像；**独立事务**，早于 `:57-60` 的身份行写入 |
| `:115` | `rollback` | 撤销核销失败前的会话变更 |
| `:120` | `rollback` | 撤销 `InviteError` 前的会话变更（含已执行的核销 UPDATE） |
| `:138` | `flush` | 只取自增 id，**不提交** |
| `:143` | `commit` | **onboard 唯一提交点**：用户行 + `invite_codes.used_count+1` + `user.onboard` 审计行 |
| `:145` | `rollback` | `IntegrityError` 时撤销上述全部 |
| `:175` | `commit` + `refresh` | `nickname` + `nickname_changed_at` |
| `:193` | `commit` + `refresh` | 仅 `nickname` |
| 间接 `backend/app/services/identity_service.py:289` / `:311` | `commit` | `user_identities` 行，由 `:57-60`、`:151-154` 触发；插入分支的 `IntegrityError` 在 `:312-314` 静默回滚 |

`audit_service.record` 只 `db.add` 不提交（`backend/app/services/audit_service.py:2-5`），因此「业务变更 + 审计」在 `:143` 原子落库。**路由层不做任何 commit**（`backend/app/api/routes/auth.py:29-123` 无 `db.commit`）。

### 7.3 `onboard` 的幂等与并发
| 场景 | 处理路径 | 结果 |
|---|---|---|
| 同一身份重复提交 / 中途退出后重扫 | `:102-104` 前置查用户 → `_resume` | `created=False`，**不核销** |
| 并发同身份，另一请求已先入驻并核销 | `:118-124` 捕获 `InviteError` → `rollback` → 复查 openid → `_resume` | `created=False` |
| 并发同身份，双方同时 INSERT | `:144-149` 捕获 `IntegrityError`（`users.openid` 唯一，`backend/app/models/models.py:191`）→ `rollback`（核销随之撤销）→ 复查 → `_resume` | 只建一个用户、只核销一次 |
| 并发多身份抢同一邀请码 | `invite_service.consume` 的条件 UPDATE（`backend/app/services/invite_service.py:77-90`）按 `rowcount` 判定 | 不超发 |

**无跨请求锁、无 SELECT … FOR UPDATE**；正确性完全依赖「条件 UPDATE + 唯一约束 + 回滚复用」三件套。真实 openGauss 并发已验证（`docs/迭代记录.md` 的 `afbcba9` 条目）。

`:116` 在 `rollback` 之后**再调一次 `get_usable` 且丢弃返回值**，目的只是让更准确的原因（过期/停用/无效）先于 `:117` 的「使用次数已满」抛出；这多一次 SQL，且两次查询之间状态可能再变，故文案不保证与真实原因一致。

### 7.4 权限校验链
| 接口 | 链路 |
|---|---|
| `/auth/login`、`/auth/onboard` | **公开**，无任何鉴权依赖（`backend/app/api/routes/auth.py:30`、`:64` 只依赖 `get_db`） |
| `/auth/nickname`、`/auth/nickname/initial` | `get_current_user`（`backend/app/api/deps.py:17-43`：Bearer → `decode_token` → `int(sub)` → 查用户 → `_ensure_active`），失败 401，停用 403 + 响应头 |
| 本文件其余接口 | **不挂 `require_menu`，也不挂活动守卫** `require_activity_participation` / `require_activity_view`（`backend/app/api/deps.py:56-81`）→ 改名在活动期间外同样可用 |

### 7.5 昵称「每人仅一次」的强制层级
| 层 | 位置 | 作用 |
|---|---|---|
| 数据库 | `docker/init/004_nickname_change.sql:5-6` | 仅新增 `original_nickname`、`nickname_changed_at` 两个**可空列，无任何约束** |
| 服务层 | `backend/app/services/auth_service.py:166-167` | **唯一强制点**：`nickname_changed_at` 非空即拒绝 |
| 路由层 | `backend/app/api/routes/auth.py:92`（summary「修改昵称（每人仅一次）」）、`:99-102` | 只把 `ValueError` 映射为 400，不做判定 |
| 小程序 | `frontend/pages/mine/mine.wxml:10-11`（按 `nicknameChangedAt` 隐藏入口）、`frontend/pages/mine/mine.js:112-119`（兜底拦截）、`:131-132`（调用） | 交互层隐藏 + 提示 |

绕过前端直接调接口时，服务层判定是唯一闸门。`:166-175` 的「读 `nickname_changed_at` → 写」不在行锁或条件 UPDATE 内，并发双请求理论上可都通过判定（**待确认**：未见相关测试用例覆盖）。

`set_initial_nickname` 是配套的「不消耗机会」通道：它**不写** `nickname_changed_at`（`:192-193`），但会在已改名后拒绝覆盖（`:188-189`），二者共同保证「唯一机会」不被绕过。

### 7.6 审计
本文件只写一条审计动作：`user.onboard`（`:139-142`），`actor_type="user"`、`actor_user_id` 与 `target_user_id` 均为新建用户自身 id，detail 为 `{invite_id, invite_name, org_id}`。动作码在管理端 `admin/src/views/AuditView.vue` 的 `ACTION_TEXT` 中翻译为中文。**`wx_login`、`update_nickname`、`set_initial_nickname` 均不写审计**；改名记录靠 `users.original_nickname` / `nickname_changed_at` 两列留存，管理端据此筛选与导出（`backend/app/services/admin_service.py:263`、`:281-282`、`:466-473`、`:560-561`）。

### 7.7 敏感信息
本文件不写任何日志（无 `logging`/`print`）；不落库 `session_key`、微信 code、邀请码原码；`users.openid` 是微信标识符，由 `_resolve_openid` 直接写入（`:127`），**不得出现在响应体、审计 detail 或日志中**（`afbcba9` 的脱敏整改结论）。

## 8. 修改约束
1. **`:46-47` 的「不回退 mock」判定是安全基线**（`67c96b1` 的整改结论）。任何改动都不得让「已配置 `WX_APPID`/`WX_SECRET` 且 `WX_LOGIN_ALLOW_MOCK=false`」时的换取失败走到 `:48`；`WX_LOGIN_ALLOW_MOCK` 生产必须为 false（`backend/app/core/config.py:45-46`、`.qoder/backend/.env.prod.md:38`）。
2. **不得恢复「登录自动建号」**。`:79-80` 的 `unregistered` 分支是邀请码准入模型的基石（`.qoder/REQUIREMENTS.md` §2.2「准入模型」行）；建号只能经 `onboard`。
3. **`:143` 必须是 onboard 的唯一 commit**，且审计写入（`:139-142`）必须留在同一事务内——拆开会产生「有用户无审计」或「核销了但没建号」。
4. **`:115`/`:120`/`:145` 三处 rollback 不可删**：`invite_service.consume` 只 `db.execute` 不提交（`backend/app/services/invite_service.py:77-90`），撤销核销完全依赖 rollback。
5. **`_sign_in:57` 的 `if session_info:` 门控不可去掉**：mock 会话信息是空字典（`:48`），去掉后会用 mock openid 写 `user_identities`，污染真实微信身份表并可能撞 `uq_identity_provider_openid`（`backend/app/models/models.py:394`）。
6. **`LOGIN_ACTIVE`/`LOGIN_UNREGISTERED`/`LOGIN_DISABLED` 的字符串值是跨端契约**（`frontend/services/auth.js:100`、`:109`、`:113` 与 `backend/app/schemas/schemas.py:48` 均按字面量比较），改值即破坏前端分流。
7. **`ACCOUNT_DISABLED_MESSAGE`（`:24`）被 `backend/app/api/deps.py:51` 引用**，改名/删除会连带影响全部受保护接口的 403 文案与前端停用提示（`frontend/pages/launch/launch.js:68-69`）。
8. **测试桩依赖模块级名称**：`backend/test/s19_invite_admission.py:87` 等直接替换 `auth_service.code2session`。若把 `:17` 改为 `from app.core import wx` 并以 `wx.code2session(...)` 调用，这些桩全部失效。
9. **昵称长度上限只在 schema 层**（`backend/app/schemas/schemas.py:74`、`:88` 的 `max_length=64`）；新增非路由调用方时必须自行校验，否则超长值会在 `:175`/`:193` 提交时被数据库拒绝。
10. 时间统一 `datetime.utcnow()`（`:109`、`:174`），与全库 UTC-naive 口径一致（`.qoder/ARCHITECTURE.md` §4.5）；改为本地时间会破坏邀请码有效期比较（`:111`、`:114` 传同一 `now`）。

## 9. 当前实现状态

**已实现**
- 三态登录（active/unregistered/disabled），未入驻不建号不签发令牌（`:68-83`）。
- 已配置凭证时微信换取失败 502 且不回退 mock（`:46-47`）。
- 邀请码入驻：校验 + 组织子树范围 + 原子核销 + 建号 + 审计单事务提交（`:92-155`）。
- 并发/重复入驻幂等：三条复用出口 + `IntegrityError` 回滚复用（`:102-104`、`:118-124`、`:144-149`）。
- 登录同步采集 unionid 身份行（`:57-60`、`:151-154`）。
- 昵称每人仅一次（`:166-167`）+ 首次引导不消耗机会（`:180-195`）+ 曾用名回填（`:170-172`、`:129`）。

**存在问题 / 已知限制（事实性陈述）**
1. `/auth/login`、`/auth/nickname`、`/auth/nickname/initial` **无限流**：`login_limiter` 只用于管理端账号登录（`backend/app/api/routes/admin.py:107`），`invite_limiter` 只挂在校验与入驻两个接口（`backend/app/api/routes/auth.py:50`、`:69`）。全仓 5 个限流调用点见 `.qoder/ARCHITECTURE.md` §10.1。
2. `_sign_in:53-56` 的头像提交是**独立事务**：若随后 `:57-60` 的身份同步抛出非 `IntegrityError` 异常，头像已落库而身份行未写，且该异常无路由分支处理 → 500。
3. `:116` 为取准确文案而重复执行一次 `get_usable` 并丢弃结果（多一次 SQL；两次查询间状态可变，文案不保证与真实原因一致）。
4. 昵称唯一机会的「读—判—写」（`:166-175`）无行锁、无条件 UPDATE、无数据库约束（`docker/init/004_nickname_change.sql:5-6` 仅加可空列），并发双请求的判定结果**待确认**。
5. `update_nickname` / `set_initial_nickname` **不写审计**（全文件仅 `:139-142` 一处 `user.onboard`）；改名前后对比只靠两列数据，无操作留痕（操作人/时间/IP）。
6. mock 模式（未配置凭证，或配置了凭证但开关为真）下 `_sign_in:57` 条件为假 → **不写 `user_identities`**，该用户无法参与 PC 扫码确认与身份绑定（`backend/app/services/identity_service.py:264` 是登录侧唯一写入点）。
7. `LoginRequest.nickname`（`backend/app/schemas/schemas.py:43`）在 `afbcba9` 之后已成**死字段**：路由不再向下传（`backend/app/api/routes/auth.py:38`）。
8. `LoginRequest.avatar` **无 `max_length`**（`backend/app/schemas/schemas.py:44`），而 `users.avatar` 为 `String(500)`（`backend/app/models/models.py:193`），服务层不做长度校验（`:53-55` 直接赋值并提交）；超长入参会由数据库报错且路由未捕获 → 500（**待确认**：未见测试覆盖）。对比 `OnboardRequest.avatar` 有 `max_length=500`（`backend/app/schemas/schemas.py:76`）。
9. `set_initial_nickname` 的失败被前端 `.catch(() => null)` 吞掉（`frontend/pages/org-select/org-select.js:159`），用户看不到「昵称已修改过，无法覆盖」提示，随后仍继续选组织。
10. `_find_user:64-65` 用 `.first()` 而非 `.one()`：依赖 `users.openid` 唯一约束（`backend/app/models/models.py:191`）保证至多一行，约束被破坏时不会暴露问题。

**待开发 / 不在本文件范围**
- 微信手机号快捷验证：`docs/迭代记录.md` 的 `7fcd037` 条目记「平台不满足手机号快捷验证条件改用批量绑定码」，同条又记「该方案随后被 V1.0 需求替代，未进入编码」；`docs/迭代记录.md` 的 `495d845` 条目记 V1.0 扫码入驻方案「替代此前员工名册/手机号/绑定码方案」。因此本文件只有邀请码一条准入路径，无手机号相关代码。

**待确认**
- 昵称唯一机会在并发下是否真能被绕过（无测试用例，无数据库约束）。
- `LoginRequest.avatar` 超长时的实际数据库行为（openGauss 报错文案与是否被上层捕获）。
- `afbcba9` 的小程序侧验收：`docs/迭代记录.md` 的 `afbcba9` 条目记「真机扫码与开发者工具 automator 的三态截图未纳入本次 CI，需另行手工验收（已在报告「未执行项」中标注）」，其后续是否已补做**待确认**。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/auth_service.py`（8 条提交）与 `docs/迭代记录.md`。按时间倒序。

### 2026-10-12
- 需求：小程序仅对受邀人员开放；未入驻不得建号、不得签发令牌（`.qoder/REQUIREMENTS.md` §2.2「准入模型」行）。
- 修改内容：提交 `afbcba9`。模块 docstring 改为「微信登录与邀请码入驻服务」（`:1-7`）；删除 `DEFAULT_NICKNAME` 与 `_get_or_create_user`（自动建号）；新增 `LOGIN_*` 三常量与 `ACCOUNT_DISABLED_MESSAGE`（`:21-24`）、`AccountDisabledError`（`:31-32`）、`_sign_in`（`:51-61`）、`_find_user`（`:64-65`）、`_resume`（`:86-89`）、`onboard`（`:92-155`）；`wx_login` 签名由 `(db, code, nickname="", avatar="") -> Tuple[str, User]` 改为 `(db, code, avatar="") -> Tuple[str, Optional[str], Optional[User]]` 并返回三态；新增 `invite_service` / `audit_service` 依赖（`:19`）。
- 关联文件：`docker/init/015_invite_admission.sql`、`backend/app/services/invite_service.py`、`backend/app/api/routes/auth.py`、`backend/app/api/deps.py`、`backend/app/models/models.py`（`users.status`/`invite_code_id`/`onboarded_at`）、`frontend/pages/onboard/onboard.js`、`frontend/services/auth.js`、`admin/src/views/InvitesView.vue`。同一提交**删除** `backend/test/s13_onboard_login.py`（`git log --diff-filter=D` 确认），故 `67c96b1` 的 S13 用例已不在树中。
- 测试结果：`docs/迭代记录.md` 的 `afbcba9` 条目原文——「后端 `test/s19_invite_admission.py` 25/25 通过（I01–I25：未入驻拒绝、各种无效码、专属码越界、历史用户不受限、停用 38 受保护接口 403、WS 4403、管理端 CRUD/审计/UTC、脱敏、过期 Token 复用用户）」；「真实 openGauss 并发 `test/s19_invite_concurrency_pg.py` 3/3（P01 多身份并发不超额、P02 同一身份并发只建一个用户只核销一次、P03 唯一约束冲突回滚复用已存在用户）。P03 初次失败后修 `auth_service.onboard` 为 `rollback → 复用已存在用户`，连跑 3 次通过」；「admin `npm run build` 通过」；「小程序侧 `node --check` 全部通过；真机扫码与开发者工具 automator 的三态截图未纳入本次 CI，需另行手工验收」。

### 2026-10-11
- 需求：修复「微信换取失败无条件回退 mock 造成假登录用户」与「并发首登撞唯一约束返回 500」。
- 修改内容：提交 `67c96b1`。从 `wx_login` 拆出 `_resolve_openid`（`:41-48`）与 `_get_or_create_user`（后者已在 `afbcba9` 删除）；新增 `WxLoginError`（`:27-28`）与 `WX_LOGIN_ALLOW_MOCK` 开关判定（`:46-47`）；并发首登改为 `IntegrityError` 回滚后复用已有用户。
- 关联文件：`backend/app/core/config.py:45-46`（新增开关）、`backend/app/api/routes/auth.py:39-40`（502）、`backend/app/services/wechat_service.py`（`get_onboarding_png`）、`backend/design.md`、`backend/README.md`。无数据库变更。
- 测试结果：`docs/迭代记录.md` 的 `67c96b1` 条目原文——「S13 冒烟 13/13（`test/s13_onboard_login.py`，SQLite 临时库：首登/重复/有效与过期 Token/微信失败 502/真实 openid/8 并发首登/唯一约束竞态分支/业务数据保留/39 个用户接口未登录 401/37 个管理接口拒绝普通用户 Token/入驻码权限与内容/测试开关）；S12 回归 11/11。真实微信出码与真机扫码**待验证**」。**注意**：该测试文件已被 `afbcba9` 删除，结论仅存于台账。

### 2026-10-10
- 需求：杜绝模拟步数写库；微信接口调用收敛到基础设施层。
- 修改内容：提交 `3df3fd0`。删除本文件内的 `_code2session` 与 `WX_CODE2SESSION` 常量、`httpx` 与 `settings` 的部分用途，改为 `from app.core.wx import code2session`（`:17`）；`_resolve_openid` 改调统一实现（`:43`）。本文件净减 28 行（`3 insertions, 31 deletions`）。
- 关联文件：`backend/app/core/wx.py`（新增）、`backend/app/services/sport_service.py`、`frontend/services/sport.js`、`backend/requirements.txt`（新增 pycryptodome）。
- 测试结果：`docs/迭代记录.md` 的 `3df3fd0` 条目原文——「S11 后端冒烟 8/8（`test/s11_sport_sync_werun.py`，含加解密往返/watermark 校验/缺当日步数/伪造数据 400 零写入），e2e 全链路 178/178 回归；小程序 automator 验收 4/4（演示按钮已移除、devtools 取数失败友好报错且零写入，截图 s11-01）。真机（已开通微信运动设备）端到端回归待用户确认」。

### 2026-10-09
- 需求：登录时同步采集 unionid 并写入 `user_identities`（`docs/identity-binding-design.md` 批次 2）。
- 修改内容：提交 `b431e4d`。`_code2session` 返回值由 `Optional[str]`（仅 openid）改为 `Optional[dict]`（openid + unionid），并在响应缺 openid 时返回 None；`wx_login` 改为先取 `session_info` 再派生 openid；新增真实响应时调 `identity_service.ensure_wx_mini_identity` 的分支（现 `:57-60`）；新增 `from app.services import identity_service`。
- 关联文件：`backend/app/services/identity_service.py`、`backend/app/models/models.py`（`UserIdentity`）、`docker/init/010_admin_identity.sql`。
- 测试结果：`docs/迭代记录.md` 的 `b431e4d` 条目原文——「S8 集成测试 23/23 通过（`backend/test/s8_identity_admin.py`，报告见 `backend/test/docs/s8-identity-admin.md`）」。

### 2026-10-01（`43877dc`，16:51）
- 需求：首次引导设置昵称不得占用「每人仅一次」的改名机会。
- 修改内容：新增 `set_initial_nickname`（`:180-195`，18 行新增，无其他改动）。
- 关联文件：`backend/app/api/routes/auth.py:107-123`（新增 `PUT /api/auth/nickname/initial`）、`frontend/pages/org-select/org-select.js:158-160`、`frontend/services/auth.js:230-234`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `43877dc` 条目只有「内容」字段，未记录验证字段）。

### 2026-10-01（`f820e0e`，15:54）
- 需求：微信名称直登；昵称仅可修改一次；排名洞察展示改名记录（三端）。
- 修改内容：新增 `update_nickname`（`:158-177`）与「每人仅一次」判定（`:166-167`）、曾用名回填（`:170-172`）；`wx_login` 建号时同时写 `original_nickname`（现由 `:129` 承担），并**删除登录时用微信昵称覆盖已有昵称**的分支（改为「昵称仅在首次创建时写入」）；新增 `from datetime import datetime`（`:9`）。
- 关联文件：`docker/init/004_nickname_change.sql`（新增两列并回填）、`backend/app/api/routes/auth.py:92-104`、`backend/app/services/admin_service.py:263`/`:281-282`/`:466-473`/`:560-561`、`frontend/pages/mine/mine.js`、`frontend/pages/mine/mine.wxml:10-11`、`admin` 排名洞察页。
- 测试结果：待确认（`docs/迭代记录.md` 的 `f820e0e` 条目只有「内容」字段，未记录验证字段）。

### 2026-10-01（`e8c6a09`，10:28）
- 需求：路线节点增加坐标、排序与启停配置（本文件为附带改动）。
- 修改内容：1 行——建号时 `avatar=avatar or ""` 改为 `avatar=avatar or None`（现由 `:130` 承担），配合「用户头像字段改为可空」。
- 关联文件：`backend/app/models/models.py:193`、`docker/init` 路线节点迁移。
- 测试结果：待确认（`docs/迭代记录.md` 的 `e8c6a09` 条目无「内容」与验证字段）。

### 2026-09-30（`a94e685`，18:05）
- 需求：项目初始化。
- 修改内容：创建本文件（75 行），含 `_mock_openid`、`_code2session`（内联 httpx 调 `sns/jscode2session`）、`wx_login`（换取 openid → 建/查用户 → 签发 JWT）。
- 关联文件：`backend/app/core/security.py:10-19`、`backend/app/models/models.py:179-205`、`frontend/services/auth.js`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `a94e685` 条目「内容：仓库初始代码」，未记录验证字段）。
