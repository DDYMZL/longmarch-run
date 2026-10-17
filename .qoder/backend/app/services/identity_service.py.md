# identity_service.py

## 1. 文件路径
`backend/app/services/identity_service.py`

## 2. 文件职责
微信**身份关联**与 **PC 扫码登录**的服务层：管理扫码登录会话（创建 / 轮询 / 置已扫 / 确认 / 取消 / 令牌单次签发）、身份绑定确认事务、身份列表与解绑，以及小程序登录成功后的 `wx_mini` 身份行同步。模块 docstring（`backend/app/services/identity_service.py:1-8`）列明三条安全要点：凭证只存 SHA-256 摘要、`qrId` 与 `scene` 分离、unionid 一人规则在事务内校验且**冲突身份禁止自动合并**。

## 3. 业务需求
- **权威设计出处**：`docs/identity-binding-design.md`（v1，2026-10-09）——§2 三层分离（认证渠道 / 系统用户关联 / 后台授权）、§3.1 `user_identities` 与 unionid 一人规则、§3.2 `bind_requests`、§3.3 `qr_login_sessions`、§4.1 小程序侧四个接口、§4.2 PC 侧扫码接口、§5.1 PC 扫码登录流程、§5.2 首次绑定流程（阶段 2）、§5.4 解绑、§6 安全设计。本文档只描述实现现状并回指该文件，不复述其正文。
- **需求清单**：`.qoder/REQUIREMENTS.md` §2.4「员工身份绑定与扫码 — **部分实现**」。
- **架构定位**：`.qoder/ARCHITECTURE.md` §5.1（三类 JWT）、§5.3（管理端鉴权链）、§7（微信能力集成）。
- **交付批次**：`b431e4d`（2026-10-09 10:27）一次性创建本文件，此后**无任何提交改动过它**（`git log --follow -- backend/app/services/identity_service.py` 只有 1 条）。

## 4. 核心功能

### 4.1 常量与工具（`:22-39`）
| 名称 | 行号 | 值 / 说明 |
|---|---|---|
| `PROVIDER_WX_MINI` | `:22` | `"wx_mini"`，小程序渠道（当前唯一有生产写入路径的渠道） |
| `STATUS_PENDING` … `STATUS_USED` | `:24-29` | `pending`/`scanned`/`confirmed`/`failed`/`cancelled`/`used` 六个状态常量 |
| `FAIL_NO_ACCESS` | `:31` | 「无后台访问权限，请联系管理员授权」，写入 `qr_login_sessions.fail_reason` 并由路由作为 403 detail 返回 |
| `_sha256(raw)` | `:34-35` | `hashlib.sha256((raw or "").encode("utf-8")).hexdigest()`，64 字符，正好匹配两表的 `String(64)` 摘要列 |
| `_now()` | `:38-39` | `datetime.utcnow()`，全文件时间基准为 **UTC naive** |

**`"expired"` 没有常量**：三个置过期分支（`:68`、`:80`、`:157`）直接写字面量 `"expired"`，与 `:24-29` 的常量风格不一致（`STATUS_*` 六项里也没有 `STATUS_EXPIRED`）。

**`import json`（`:10`）未被使用**：全文件无 `json.` 调用，属未清理的导入。

### 4.2 PC 扫码登录会话（`:42-141`）
| 函数 | 行号 | 行为 |
|---|---|---|
| `create_login_session(db)` | `:43-55` | 生成明文 `scene_token = "L" + secrets.token_urlsafe(16)`（`:45`，1+22 = **23 字符**，满足微信 `wxacode.getUnlimited` 的 scene ≤32 字符限制）；主键 `id = secrets.token_urlsafe(18)`（`:47`，18 字节 base64url 恰为 **24 字符**，与 `qr_login_sessions.id String(24)` 主键等长，`backend/app/models/models.py:443`）；`scene_token_hash = _sha256(scene_token)`（`:48`，**含 `L` 前缀一起哈希**）；`status=pending`（`:49`）；`expires_at = _now() + QR_LOGIN_TTL_SECONDS`（`:50`）；`add → commit → refresh`（`:52-54`）；返回 `(session, 明文 scene)`（`:55`）——**明文只在此处出现一次，不落库** |
| `get_login_session(db, scene)` | `:58-71` | 按 `_sha256(scene)` 查（`:62`）；查不到返回 `None`（`:65-66`）；**仅当 `status == pending` 且已过期**时置 `"expired"` + commit + 返回 `None`（`:67-70`）；其余状态原样返回（`:71`） |
| `poll_login_session(db, qr_id)` | `:74-82` | 按主键 `qr_id` 查（`:76`）；未确认且已过期时**惰性**置 `"expired"` 并 commit（`:79-81`），但**仍返回会话对象**（`:82`），使 PC 能读到 `expired` 状态 |
| `mark_scanned(db, session)` | `:85-89` | 仅 `pending → scanned`（`:87-89`），其他状态静默不动（幂等） |
| `cancel_login(db, session)` | `:92-96` | 仅 `pending`/`scanned → cancelled`（`:94-96`），终态不可取消 |
| `confirm_login(db, session, user)` | `:99-119` | 见 §4.3 |
| `issue_admin_token(db, qr_id)` | `:122-141` | 见 §4.4 |

### 4.3 `confirm_login`（`:99-119`）——扫码登录的授权闸门
```
:105-106  status 不在 (pending, scanned) → ValueError("扫码凭证已使用或已失效")  ⇒ 路由 400
:107      函数内延迟 import access_service
:109-113  access_service.get_enabled_roles(db, user.id) 为空 →
             status = failed、fail_reason = FAIL_NO_ACCESS、commit、return FAIL_NO_ACCESS  ⇒ 路由 403
:114-118  status = confirmed、user_id = user.id、confirmed_at = _now()、
             audit_service.record(db, "user", user.id, "admin.login.qr", user.id, None)、commit
:119      return ""（空串表示成功）
```
- **返回值语义**：返回空串 = 成功；返回非空 = 失败原因（`backend/app/api/routes/identity.py:71-74` 据此抛 403）。**「无权限」走返回值而非异常**，因为需要先把会话置 `failed` 让 PC 端展示原因；「凭证非法」走 `ValueError` → 400。
- **不在本函数签发令牌**：只置 `confirmed` + 回填 `user_id`；令牌由 PC 轮询侧的 `issue_admin_token` + `create_admin_token_for_user` 完成（`backend/app/api/routes/admin.py:154-170`）。
- **不校验 `expires_at`**（见 §9 第 3 项）。
- `access_service` 为**函数体内延迟导入**（`:107`）。`backend/app/services/access_service.py:15-25` 的模块级导入并不包含 `identity_service`，故当前不构成真实循环依赖；延迟导入的实际动机无注释说明，**待确认**。

### 4.4 `issue_admin_token`（`:122-141`）——单次签发的并发保护
```
:127-131  UPDATE qr_login_sessions SET token_issued = true
             WHERE id = :qr_id AND token_issued IS FALSE     （synchronize_session=False）
:132      db.commit()
:133-134  rowcount == 0 → return None（已被签发过 / 会话不存在）
:135-137  回查会话；为 None 或 user_id 为 None → return None
:138      函数内延迟 import User（`:19` 只导入了 BindRequest/QrLoginSession/UserIdentity）
:140-141  查 User 并返回 (session, user)
```
- **原子性来源**：条件 UPDATE 的影响行数。并发轮询下第二个请求在 openGauss READ COMMITTED 下会等待行锁、重新求值 WHERE 后得到 0 行 → 返回 `None`，因此**管理员 JWT 只会签发一次**（防轮询重放）。docstring `:123-126` 明确此意图。
- **`commit` 在判定之前**（`:132`）：标记翻转先落库再判 rowcount，避免标记丢失。
- 副作用提示：`:136-137` 的防御分支会**消费掉 `token_issued` 却不返回用户**；正常链路不可达（`backend/app/api/routes/admin.py:154` 仅在 `status == "confirmed"` 时调用，而 `confirm_login:115` 必然已回填 `user_id`）。
- 调用方 `backend/app/api/routes/admin.py:155-170`：拿到 `(session, user)` 后用 `access_service.build_principal` 重建菜单（`:158-162`），再 `create_admin_token_for_user(user.id)` 签发 `typ=user` 的 12 小时令牌（`:166`）。若 `build_principal` 返回 `None`，路由用 `{"username": user.nickname, "menus": []}` 兜底（`:158-161`）——**仍会签发令牌**，但该令牌下一请求即被 `get_current_admin` 拒为 403。

### 4.5 身份绑定（`:144-236`，渠道 `wx_web` 属阶段 2）
| 函数 | 行号 | 行为 |
|---|---|---|
| `get_bind_request(db, scene)` | `:145-160` | scene 必须以 `B` 开头，否则直接 `None`（`:147-148`）；按 `_sha256(scene[1:])` 查 `token_hash`（`:151`，**去掉 `B` 前缀再哈希**，与登录凭证的哈希口径不同）；`pending` 且过期 → 置 `"expired"` + commit + `None`（`:156-159`） |
| `cancel_bind(db, request)` | `:163-167` | 仅 `pending → cancelled`（`:165-167`） |
| `confirm_bind(db, request, user)` | `:170-236` | 见下 |

`confirm_bind` 的四步事务（docstring `:171-175`：凭证校验 → 身份唯一性检查 → 写身份行 → 消费凭证 → 审计）：
1. **凭证状态**：`status != pending` → `ValueError("绑定凭证已使用或已取消")`（`:176-177`）。
2. **openid 归属**：同 `provider + app_id + openid` 已属**其他**用户 → `ValueError("该微信身份已绑定其他账号，禁止合并")`（`:179-190`）。
3. **同用户同渠道重复**：该用户在该 `provider + app_id` 下已有身份行 → `ValueError("该渠道身份已绑定当前账号，无需重复绑定")`（`:192-202`）。
4. **unionid 一人规则**：`request.unionid` 非空时取该 unionid 的**全部**身份行（`:204-209`），只要存在 `user_id != user.id` 的持有者 → `ValueError("UnionID 已关联其他账号，禁止自动合并")`（`:210-211`）。

通过后：写入 `UserIdentity(user_id, provider, app_id, openid, unionid, verified_at=now)`（`:213-223`）→ 消费凭证 `status=used`、回填 `user_id`/`used_at`/`confirmed_at`（`:224-227`）→ 审计 `identity.bind.confirm`（`:228-235`）→ **单次 `db.commit()`**（`:236`）。身份行、凭证消费与审计**同事务原子落库**。

> **`bind_requests` 当前没有任何生产写入路径**：全仓 `BindRequest(` 的构造只出现在测试代码（`backend/test/fixtures_identity_bind.py:28`、`backend/test/s8_identity_admin.py:224`/`:263`/`:273`/`:313`），`backend/app/` 内无创建绑定请求的代码。这与 `docs/identity-binding-design.md` §5.2「阶段 2 渠道 `wx_web`，本期建表与小程序确认页」一致：**表结构与确认流程已就绪，渠道侧（PC qrconnect 授权 → 换 openid/unionid → 建 `bind_requests`）尚未实现**。因此 `B` 场景在生产不可达。

### 4.6 身份列表与解绑（`:239-260`）
- `list_identities(db, user_id)`（`:240-247`）：按 `id` 升序返回 ORM 行，由路由转 `IdentityOut`（`backend/app/api/routes/identity.py:97-98`；`backend/app/schemas/schemas.py:121-129` 的 docstring 明确**对外不返回 openid**）。
- `unbind(db, user, identity_id)`（`:250-260`）：身份不存在**或非本人** → `ValueError("身份不存在")`（`:252-254`，用同一文案避免泄露他人身份是否存在）；`provider == wx_mini` → `ValueError("微信登录凭证不可解绑")`（`:255-256`）；否则 `db.delete` + 审计 `identity.unbind`（detail 只含 `provider`/`app_id`，不含 openid，`:257-259`）+ `commit`（`:260`）。

### 4.7 登录时身份同步 `ensure_wx_mini_identity`（`:263-314`）
**调用条件**：只在**真实微信响应**（非 mock）时被调用——两处调用点都在 `if session_info:` 分支内（`backend/app/services/auth_service.py:57-60`、`:151-154`），而 mock 模式下 `_resolve_openid` 返回空字典（`backend/app/services/auth_service.py:48`）。docstring `:267` 明确此约定。

```
:269-276  查 (user_id, provider=wx_mini) 的现有行——注意未带 app_id 条件
:278-290  已有行的更新分支：
   :279-286   仅当「传入 unionid 非空 且 现有行 unionid 为空」时尝试回填，
              且回填前先查该 unionid 是否已属他人（:280-284），有冲突则跳过回填
   :287-288   verified_at / updated_at 刷新为 now
   :289-290   commit 并 return（幂等：重复登录只刷时间戳）
:291-299  新建分支：先算 safe_unionid——若该 unionid 已属他人则置 None（:292-299），
             即「不合并、不写入 unionid」，但身份行本身照常写入
:300-309  db.add(UserIdentity(user_id, provider=wx_mini, app_id=settings.WX_APPID,
             openid, unionid=safe_unionid, verified_at=now))
:310-314  try: commit  except IntegrityError: rollback
             （注释 :313 说明：并发登录竞态下身份行已由同用户另一请求写入，回滚即可）
```
- **幂等**：同一用户重复登录不会重复插行（`:269-276` 先查后写），并发下靠 `uq_identity_user_channel`（`backend/app/models/models.py:395`）兜底并静默回滚（`:310-314`）。
- **unionid 冲突的处理是「静默降级」而非「拒绝」**：新建分支把 `safe_unionid` 置 `None` 后仍写入身份行（`:291-309`），登录照常放行。**不写任何审计告警**——与 `docs/identity-binding-design.md` §2「冲突（同 unionid 已属他人）拒绝合并并**审计告警**」的表述存在落差（拒绝合并已实现，审计告警未实现）。
- **`app_id` 只在新建时写入**（`:304`）：现有行的更新分支不刷 `app_id`（`:287-288`），因此若 `WX_APPID` 变更，旧身份行的 `app_id` 不会跟着更新（现状记录）。

## 5. 输入与输出

### 5.1 函数签名
| 函数 | 入参 | 返回 | 抛出的业务异常（`ValueError`） |
|---|---|---|---|
| `create_login_session` | `db` | `Tuple[QrLoginSession, str]`（会话, **明文 scene**） | — |
| `get_login_session` | `db`, `scene: str` | `Optional[QrLoginSession]` | — |
| `poll_login_session` | `db`, `qr_id: str` | `Optional[QrLoginSession]`（可能是刚被置 `expired` 的） | — |
| `mark_scanned` | `db`, `session` | `None` | — |
| `cancel_login` | `db`, `session` | `None` | — |
| `confirm_login` | `db`, `session`, `user`（`User` ORM） | `str`：`""` 成功 / `FAIL_NO_ACCESS` 无权限 | `扫码凭证已使用或已失效`（`:106`） |
| `issue_admin_token` | `db`, `qr_id: str` | `Optional[Tuple[QrLoginSession, object]]` | — |
| `get_bind_request` | `db`, `scene: str` | `Optional[BindRequest]` | — |
| `cancel_bind` | `db`, `request` | `None` | — |
| `confirm_bind` | `db`, `request`, `user` | `None` | `绑定凭证已使用或已取消` / `该微信身份已绑定其他账号，禁止合并` / `该渠道身份已绑定当前账号，无需重复绑定` / `UnionID 已关联其他账号，禁止自动合并` |
| `list_identities` | `db`, `user_id: int` | `List[UserIdentity]`（ORM） | — |
| `unbind` | `db`, `user`, `identity_id: int` | `None` | `身份不存在` / `微信登录凭证不可解绑` |
| `ensure_wx_mini_identity` | `db`, `user`, `openid: str`, `unionid: Optional[str]` | `None` | 不抛（`IntegrityError` 被内部吞掉并回滚，`:310-314`） |

### 5.2 route → service → schema 映射
**小程序侧（camelCase 契约，全部需 `get_current_user`）**——`backend/app/api/routes/identity.py`（4 个端点）：

| 端点 | 路由行号 | 调用的本文件函数 | `response_model` | 错误码 |
|---|---|---|---|---|
| `POST /api/auth/qr/info` | `backend/app/api/routes/identity.py:27-51` | `get_login_session`（`:36`）+ `mark_scanned`（`:39`）；`get_bind_request`（`:42`） | `QrInfoOut`（`backend/app/schemas/schemas.py:106-111`） | 凭证不存在/过期 **404**（`:38`、`:44`）；scene 前缀非 `L`/`B` **400**「无效的扫码场景」（`:51`） |
| `POST /api/auth/qr/confirm` | `backend/app/api/routes/identity.py:54-86` | `get_login_session`（`:65`）、`cancel_login`（`:69`）、`confirm_login`（`:71`）；`get_bind_request`（`:76`）、`cancel_bind`（`:80`）、`confirm_bind`（`:82`） | `MessageOut`（`backend/app/schemas/schemas.py:728`） | 凭证不存在/过期 **404**；`confirm_login` 返回非空原因 **403**（`:72-73`）；`ValueError` 统一 **400**（`:84-85`）；前缀非法 **400**（`:86`） |
| `GET /api/auth/identities` | `backend/app/api/routes/identity.py:89-98` | `list_identities`（`:97`） | `List[IdentityOut]`（`backend/app/schemas/schemas.py:121-129`） | — |
| `DELETE /api/auth/identities/{identity_id}` | `backend/app/api/routes/identity.py:101-115` | `unbind`（`:112`） | `MessageOut` | `ValueError` → **400**（`:113-114`） |

请求体：`QrInfoRequest.scene`（1–64 字符，`backend/app/schemas/schemas.py:92-95`）、`QrConfirmRequest.scene` + `action`（`^(confirm|cancel)$`，`:114-118`）。

**PC 管理侧（snake_case 契约，公开 + 限流）**——`backend/app/api/routes/admin.py`：

| 端点 | 路由行号 | 调用的本文件函数 | 限流 | 说明 |
|---|---|---|---|---|
| `POST /api/admin/wechat/qr` | `backend/app/api/routes/admin.py:119-139` | `create_login_session`（`:130`） | `qr_create_limiter` 10 次/分/IP（`:129`；`backend/app/core/rate_limit.py:32`） | 明文 scene 交给 `wechat_service.get_wxacode_png` 出码（`:131`）；**mock 模式**（出码失败）才把 scene 明文返回给前端（`:136`），真实模式返回 `image` 的 data URL、`scene=None`；`expires_in` 取 `settings.QR_LOGIN_TTL_SECONDS`（`:138`） |
| `GET /api/admin/wechat/qr/{qr_id}/status` | `backend/app/api/routes/admin.py:142-175` | `poll_login_session`（`:150`）、`issue_admin_token`（`:155`） | `qr_poll_limiter` 60 次/分/IP（`:149`；`backend/app/core/rate_limit.py:33`） | 会话不存在 **404**（`:151-152`）；`expires_in` 由 `session.expires_at - utcnow()` 取 `max(0, ...)`（`:153`）；仅 `status == "confirmed"` 时才尝试签发（`:154-170`） |

**间接消费方**：`backend/app/services/auth_service.py`（登录/入驻时同步 `wx_mini` 身份行）。

**前端消费方**：小程序 `frontend/services/identity.js`（`qrInfo`/`qrConfirm`/`identities`/`unbind`）、`frontend/pages/bind/bind.js`（scene 解析与确认页，`:49-61` 按首字符分流 `L`/`B`）、`frontend/pages/account/account.js`（身份列表与解绑）；管理后台 `admin/src/views/LoginView.vue`（扫码 tab 轮询，`:93-130`）。

## 6. 依赖关系

### 6.1 依赖
- **标准库**：`hashlib`（`:9`，凭证摘要）、`json`（`:10`，**未使用**）、`secrets`（`:11`，凭证与会话 id）、`datetime`/`timedelta`（`:12`）、`typing`（`:13`）。
- **第三方**：`sqlalchemy.exc.IntegrityError`（`:15`）、`sqlalchemy.orm.Session`（`:16`）。
- **项目内**：`app.core.config.settings`（`:18`，仅用 `QR_LOGIN_TTL_SECONDS` 于 `:50` 与 `WX_APPID` 于 `:304`）；ORM `BindRequest`/`QrLoginSession`/`UserIdentity`（`:19`）；`app.services.audit_service`（`:20`）。函数内延迟导入 `app.services.access_service`（`:107`）与 `app.models.models.User`（`:138`）。
- **数据库表**：`qr_login_sessions`（`backend/app/models/models.py:434-453`）、`bind_requests`（`:409-431`）、`user_identities`（`:385-406`）、`audit_logs`（`:503-516`，经 `audit_service`）；只读 `admin_user_roles`/`admin_roles`（经 `access_service.get_enabled_roles`）、`users`（`:140`）。
- **配置项**：`QR_LOGIN_TTL_SECONDS`（默认 300，`backend/app/core/config.py:56`）。**`BIND_REQUEST_TTL_SECONDS`（默认 600，`backend/app/core/config.py:57`）在本文件与整个 `backend/app/` 中均无引用**——绑定请求的有效期完全由库内 `bind_requests.expires_at` 列判定（`:156-159`），该列的值由创建方写入，而创建方尚不存在（§4.5）。

### 6.2 被依赖
| 调用方 | 行号 | 用到的函数 |
|---|---|---|
| `backend/app/api/routes/identity.py` | `:22` import；`:36`/`:39`/`:42`/`:65`/`:69`/`:71`/`:76`/`:80`/`:82`/`:97`/`:112` | 除 `create_login_session`/`poll_login_session`/`issue_admin_token` 外全部 |
| `backend/app/api/routes/admin.py` | `:89` import；`:130`/`:150`/`:155` | `create_login_session`、`poll_login_session`、`issue_admin_token` |
| `backend/app/services/auth_service.py` | `:19` import；`:58-60`/`:152-154` | `ensure_wx_mini_identity` |

**本文件不被 `backend/app/api/deps.py` 依赖**（管理端鉴权链走 `access_service.build_principal`）。测试侧 `backend/test/s8_identity_admin.py` 与 `backend/test/fixtures_identity_bind.py` 通过 HTTP 接口 + 直接构造 `BindRequest` 覆盖，**不 import 本模块**。

## 7. 业务规则

### 7.1 凭证与状态机
**两类凭证互不可推导**（docstring `:6`）：
- `qrId` = `qr_login_sessions.id`（24 字符随机，公开给 PC 用于轮询）；
- `scene` = `L{22 字符随机}`（只嵌在小程序码里，库内只存 SHA-256）。
两者由 `secrets` 独立生成（`:45`、`:47`），知道 `qrId` 无法推出 `scene`，反之亦然。绑定凭证为 `B{token}`，库内 `bind_requests.token_hash` 存**去掉 `B` 前缀**后的摘要（`:151`），与登录凭证「含前缀哈希」（`:48`、`:62`）口径不同——阶段 2 实现 `wx_web` 渠道创建 `bind_requests` 时必须沿用「不含前缀」的口径（测试夹具 `backend/test/fixtures_identity_bind.py:26`/`:29` 即如此）。

**扫码登录会话状态流转**（`backend/app/models/models.py:437` 注释列出 6 态）：
```
pending ──mark_scanned(:87-89)──► scanned ──confirm_login(:114)──► confirmed ──issue_admin_token(:127-132)──► (token_issued=true)
   │                                  │
   ├─ cancel_login(:94-96) ───────────┴──► cancelled
   ├─ confirm_login 无权限(:110) ─────────► failed（+ fail_reason）
   └─ 过期惰性判定(:67-70 / :79-81) ─────► expired
```
终态（`confirmed`/`failed`/`cancelled`/`expired`）不可再流转：`mark_scanned`/`cancel_login` 都有状态前置判断，`confirm_login` 在 `:105-106` 直接拒绝。

**绑定请求状态流转**：`pending → used`（`confirm_bind:224`）/ `pending → cancelled`（`cancel_bind:165-166`）/ `pending → expired`（`get_bind_request:156-158`）。

### 7.2 事务边界（本文件属「服务层自提交」）
**每个改状态的函数自己 `db.commit()`**，共 9 处：`:53`（创建会话）、`:69`（置 expired）、`:81`（置 expired）、`:89`（scanned）、`:96`（cancelled）、`:112`（failed）、`:118`（confirmed + 审计）、`:132`（token_issued）、`:158`（bind 置 expired）、`:167`（bind cancelled）、`:236`（绑定确认 + 审计）、`:260`（解绑 + 审计）、`:289`/`:311`（身份同步）。路由层不再提交（`backend/app/api/routes/identity.py` 与 `backend/app/api/routes/admin.py:119-175` 内无 `db.commit()`）。

`audit_service.record` **只 `db.add` 不提交**（`backend/app/services/audit_service.py:2-5`、`:28-36`），因此「状态变更 + 审计」由本文件的 `commit` 同事务落库。

**注意**：`get_login_session`/`poll_login_session`/`get_bind_request` 这三个**读函数在发现过期时会写库并 commit**（`:67-70`、`:79-81`、`:156-159`）——惰性过期是本文件的既定设计（无后台清理任务），但意味着「查询」也可能产生写副作用。

### 7.3 审计写入清单（`audit_logs`）
| action 码 | 写入位置 | actor | target | detail |
|---|---|---|---|---|
| `admin.login.qr` | `:117` | `("user", user.id)` | `user.id` | `None` |
| `identity.bind.confirm` | `:228-235` | `("user", user.id)` | `user.id` | `{"provider", "app_id"}`（不含 openid/unionid） |
| `identity.unbind` | `:259` | `("user", user.id)` | `user.id` | `{"provider", "app_id"}` |

三个 action 码在管理端均有中文映射（`admin/src/views/AuditView.vue:52-54`）。

**不写审计的操作**：创建会话、置 `scanned`、`cancel_login`、`cancel_bind`、`confirm_login` 的**失败分支**（置 `failed`）、`ensure_wx_mini_identity`（含 unionid 冲突降级）。其中「取消」与「unionid 冲突告警」在 `docs/identity-binding-design.md` §6.5 与 §2 中被列为应审计项，**实现未覆盖**（见 §9）。

### 7.4 权限校验链路
- 小程序侧四个端点全部依赖 `Depends(get_current_user)`（`backend/app/api/routes/identity.py:30`、`:57`、`:95`、`:108`）→ 401/停用 403 由 `backend/app/api/deps.py:17-53` 统一处理，**先于**本文件的任何逻辑。
- 「能否扫码登录后台」的授权判定在 `confirm_login:109`，复用 `access_service.get_enabled_roles`（`backend/app/services/access_service.py:45-52`）——**与 REST 每请求查库同源**，因此被撤销授权的用户扫码会被拒。
- PC 侧两个端点是**公开**的（无令牌），仅靠限流 + 凭证不可猜 + 单次签发保护。
- `unbind` 的归属校验（`:253`）是本文件唯一的对象级权限检查。

### 7.5 幂等与并发约束
| 场景 | 机制 | 行号 |
|---|---|---|
| 轮询重放导致多次签发令牌 | 条件 UPDATE `token_issued IS FALSE` + rowcount 判定 | `:127-134` |
| 重复打开确认页 | `mark_scanned` 只在 `pending` 时生效 | `:87-89` |
| 重复取消 / 取消终态会话 | `cancel_login`/`cancel_bind` 只在允许状态生效 | `:94-96`、`:165-167` |
| 重复确认 | `confirm_login:105-106`、`confirm_bind:176-177` 拒绝非 `pending`/`scanned` 状态 | — |
| 并发登录同时写 `wx_mini` 身份行 | 先查后写 + `IntegrityError` 静默回滚（依赖 `uq_identity_user_channel`） | `:269-276`、`:310-314` |
| 重复绑定同一渠道 | 唯一约束 `uq_identity_user_channel` + 应用层前置检查 | `:192-202`；`backend/app/models/models.py:395` |
| 同一 openid 绑到两个用户 | 唯一约束 `uq_identity_provider_openid` + 应用层前置检查 | `:179-190`；`backend/app/models/models.py:394` |
| **同一 unionid 属两个用户** | **仅应用层事务内校验，无数据库约束、无行锁** | `:204-211`、`:279-286`、`:291-299` |

**unionid 一人规则为何不能用索引表达**：同一用户在 `wx_mini` 与 `wx_web` 两个渠道会持有**相同的 unionid**，因此 `unionid` 上不能建唯一索引（`backend/app/models/models.py:388-389` 注释、`docs/identity-binding-design.md` §3.1）。代价是**并发下存在 TOCTOU 窗口**：两个不同用户的绑定/登录请求同时通过 `:204-211` 或 `:291-299` 的检查后各自 commit，会产生同 unionid 属两人的数据；`confirm_bind` 未使用 `SELECT ... FOR UPDATE` 或串行化隔离。当前 `wx_web` 渠道未实现、`wx_mini` 侧冲突走「静默置 `None`」而非写入，实际触发面很小（现状记录）。

### 7.6 有效期口径
- 扫码登录：`QR_LOGIN_TTL_SECONDS`（默认 300 秒）在**创建时**写入 `expires_at`（`:50`），之后判定只看库内列（`:67`、`:79`）。
- 绑定请求：`BIND_REQUEST_TTL_SECONDS`（默认 600 秒）**无代码引用**；判定只看 `bind_requests.expires_at`（`:156`），该列由创建方写入（创建方尚不存在）。
- 过期是**惰性**的：只有被 `get_login_session`/`poll_login_session`/`get_bind_request` 访问到时才置 `expired`，**无定时清理任务**，未被访问的过期行会长期停留在 `pending`。

## 8. 修改约束
- **明文凭证不得落库、不得写日志**：`scene` 明文只在 `create_login_session:55` 的返回值中出现一次，库内一律存 SHA-256（`:48`）；`bind_requests.token_hash` 同理（`backend/app/models/models.py:410` 注释）。mock 模式下把 scene 返回给 PC（`backend/app/api/routes/admin.py:136`）是**开发调试专用**分支，生产配置微信凭证后不会走到。
- **`qrId` 与 `scene` 必须保持分离**（docstring `:6`；`docs/identity-binding-design.md` §6.1）：不得由其中一方派生另一方。
- **`scene` 长度必须 ≤32 字符**：微信 `wxacode.getUnlimited` 的 scene 上限。当前 `"L" + token_urlsafe(16)` = 23 字符；改随机长度时须重新核算。
- **`qr_login_sessions.id` 恰为 24 字符**（`token_urlsafe(18)`），与列宽 `String(24)`（`backend/app/models/models.py:443`）等长，**改随机字节数会撑爆主键列**。
- **`token_issued` 的单次签发语义不得削弱**：`issue_admin_token` 必须保持「条件 UPDATE + 先 commit 再判 rowcount」（`:127-134`），改成「先查后改」会引入重放窗口。
- **冲突身份禁止自动合并**（docstring `:7`、`backend/app/models/models.py:388-389`、`docs/identity-binding-design.md` §3.1）：`confirm_bind` 的三条唯一性检查与 `ensure_wx_mini_identity` 的 unionid 冲突降级都不得改成「覆盖 / 合并 / 迁移身份行」。
- **`wx_mini` 主身份不可解绑**（`:255-256`）：它是小程序登录凭证的关联行，解绑会破坏后续登录的身份同步前提。
- **非本人身份统一报「身份不存在」**（`:253-254`）：不得改成区分文案，否则会泄露身份 id 是否存在。
- **`ensure_wx_mini_identity` 只能由真实微信响应触发**（docstring `:267`）：mock openid 是 `md5` 派生的假身份（`backend/app/services/auth_service.py:35-38`），写进 `user_identities` 会污染身份表。两处调用点都在 `if session_info:` 内（`backend/app/services/auth_service.py:57`、`:151`），不得移出。
- **写函数自己 commit**，且审计写入必须在 commit 之前（`backend/app/services/audit_service.py:2-5`）。
- 响应契约分叉：`/api/auth/*` 走 `CamelModel`（camelCase），`/api/admin/*` 走 `BaseModel`（snake_case）——改字段名须双端核对（`.qoder/README.md` §3.6）。
- `IdentityOut`/`QrInfoTarget` **刻意不返回 openid**（`backend/app/schemas/schemas.py:99`、`:122` docstring），新增字段时不得把 openid/unionid 之外的敏感身份标识暴露给前端。

## 9. 当前实现状态

### 已实现
- PC 扫码登录全链路（创建会话 → 出小程序码 → 小程序 `qr/info` 置 scanned → `qr/confirm` 校验 RBAC 并置 confirmed → PC 轮询单次签发 `typ=user` 令牌）；`backend/test/docs/s8-identity-admin.md` A1–A9 覆盖。
- 凭证 SHA-256 摘要存储、`qrId`/`scene` 分离、会话状态机与惰性过期、令牌单次签发防重放。
- 绑定确认事务的**全部校验与写入逻辑**（凭证状态、openid 归属、同渠道重复、unionid 一人规则、消费凭证、审计）；`s8` A10–A11 覆盖。
- 身份列表与解绑（`wx_mini` 禁解绑、非本人视为不存在、审计）；`s8` A12 覆盖。
- 登录时 `wx_mini` 身份行幂等同步与 unionid 回填（含冲突保护）。

### 部分实现 / 未实现
1. **`wx_web` 渠道（阶段 2）未实现**：`backend/app/` 内**没有任何创建 `bind_requests` 的代码路径**（构造只见于 `backend/test/fixtures_identity_bind.py:28` 与 `backend/test/s8_identity_admin.py:224`/`:263`/`:273`/`:313`），`WX_WEB_APPID`/`WX_WEB_SECRET`（`backend/app/core/config.py:48-50`）在 `backend/app/` 中亦无引用。因此 `B` 场景（`get_bind_request`/`cancel_bind`/`confirm_bind`）在生产不可达，`backend/app/api/routes/identity.py:41-50`、`:75-83` 的 bind 分支只有测试能走到。与 `docs/identity-binding-design.md` §5.2、`.qoder/REQUIREMENTS.md` §2.4 的「部分实现」结论一致。
2. **`BIND_REQUEST_TTL_SECONDS` 无引用**（`backend/app/core/config.py:57`）：配置项存在但绑定有效期实际由库内 `expires_at` 决定（`:156`）。是「遗漏」还是「刻意由创建方决定」——**待确认**（无注释或迭代记录说明）。

### 存在问题（事实陈述 + 缺陷判定分开）
3. **`scanned` 状态的会话在服务端永不过期**（缺陷判定）。事实：三处过期判定都带 `status == STATUS_PENDING` 前置条件（`:67`、`:79`、`:156`），而 `confirm_login` 只校验状态、**不校验 `expires_at`**（`:105`）。推论：一旦小程序打开过确认页（`mark_scanned`），该会话即使超过 `QR_LOGIN_TTL_SECONDS` 仍可被确认，且 PC 侧 `poll_login_session` 也不会把它置 `expired`。前端不会自然收口——`admin/src/views/LoginView.vue:107-129` 的轮询分支只判 `status`，**不消费 `expires_in`**，`scanned` 会一直显示「已扫码，请在手机上确认登录」并持续轮询。影响面：需要攻击者已持有有效的小程序 scene 凭证（即已扫到码），且过期窗口内小程序确认页仍可提交。
4. **`cancel_login`/`cancel_bind` 不写审计**（与 `docs/identity-binding-design.md` §6.5「身份创建/绑定确认/**取消**…全部写 `audit_logs`」不一致）。事实：`:92-96`、`:163-167` 无 `audit_service.record` 调用。
5. **unionid 冲突降级不写审计告警**（与 `docs/identity-binding-design.md` §2「冲突…**拒绝合并并审计告警**」不一致）。事实：`:291-299` 把 `safe_unionid` 置 `None` 后直接写入，无任何审计或日志。
6. **`import json`（`:10`）未使用**——死导入。
7. **`"expired"` 用字面量而非常量**（`:68`、`:80`、`:157`），`STATUS_*` 常量组（`:24-29`）缺 `STATUS_EXPIRED`；同时 `backend/app/api/routes/admin.py:154` 也用字面量 `"confirmed"` 而非 `STATUS_CONFIRMED`，跨文件无法靠常量收敛。
8. **`ensure_wx_mini_identity` 查现有行时未带 `app_id` 条件**（`:269-276`，只按 `user_id + provider`），而唯一约束是 `(user_id, provider, app_id)`（`backend/app/models/models.py:395`）。事实：若 `WX_APPID` 变更，旧行会被命中并只刷新时间戳（`:287-289`），`app_id` 与 `openid` 都不更新，新 appid 的身份行永远建不起来。当前项目为单小程序，实际不可达（现状记录）。
9. **`confirm_bind` 的 unionid 检查存在 TOCTOU 窗口**（`:204-211`，无行锁 / 无数据库约束，详见 §7.5）。因 `wx_web` 未实现，当前不可达。
10. **过期会话无清理机制**：`qr_login_sessions` 与 `bind_requests` 只增不删，未被访问的过期行永久保留（惰性过期只在被查询时触发）。数据量增长属运维层面问题，**是否需要定期清理待确认**。

### 待确认
- **微信 `code2Session` 是否返回 `unionid`**：取决于小程序是否已绑定微信开放平台账号，属**部署侧事实，无法从代码确认**（`backend/app/core/wx.py:38` 只是 `data.get("unionid")`）。标杆文档 `.qoder/backend/app/core/config.py.md` 同样将其列为待确认，本文档沿用该处理。若未绑定开放平台，`user_identities.unionid` 将长期为 `NULL`，unionid 一人规则实际不生效。
- `:107` 延迟导入 `access_service`、`:138` 延迟导入 `User` 的动机（无注释说明，且模块级导入图当前无环）。
- 生产库 `qr_login_sessions`/`bind_requests`/`user_identities` 的实际数据量与 `unionid` 覆盖率（本文档未查询生产库）。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/identity_service.py`（**仅 1 个提交**，即创建提交；截至 2026-10-17 无任何后续改动）与 `docs/迭代记录.md` 对应条目。

### 2026-10-09
- 需求：《长征步迹：小程序与 PC 管理后台微信身份关联设计》（`docs/identity-binding-design.md`，提交 `852013f`）批次 2——微信扫码登录与身份关联后端。
- 修改内容：`b431e4d`（10:27）**创建本文件**，一次性实现：小程序码扫码会话（`create_login_session`/`get_login_session`/`poll_login_session`/`mark_scanned`/`cancel_login`/`confirm_login`/`issue_admin_token`，令牌单次签发）、绑定确认事务（凭证只存 SHA-256 摘要、openid/unionid 冲突拒绝合并）、身份列表与解绑（`wx_mini` 主身份禁解绑）、登录同步采集 unionid 身份行（`ensure_wx_mini_identity`）。同批配套：管理员令牌 `typ` 区分超管/关联管理员、`get_current_admin` 每请求查库、登录/扫码/轮询限流、新增 `/auth/qr/*`、`/auth/identities*`、`/admin/wechat/qr*`、`/admin/me`。
- 关联文件：`backend/app/services/access_service.py`（同批创建）、`backend/app/services/auth_service.py`（改 `_code2session` 返回 openid+unionid 并调用 `ensure_wx_mini_identity`）、`backend/app/services/wechat_service.py`（access_token 缓存 + `wxacode.getUnlimited`）、`backend/app/api/routes/identity.py`（新增）、`backend/app/api/routes/admin.py`、`backend/app/api/deps.py`、`backend/app/core/security.py`、`backend/app/core/rate_limit.py`（新增）、`backend/app/models/models.py`（8 张新表 ORM）、`docker/init/010_admin_identity.sql`（前一日 `06b6313` 建表）。
- 测试结果：`docs/迭代记录.md` 该条目记录「S8 集成测试 **23/23 通过**（`backend/test/s8_identity_admin.py`，报告见 `backend/test/docs/s8-identity-admin.md`）」。报告明细：A1 mock 登录不产生身份行、A2 创建扫码会话（mock 模式返回 scene 明文、`image=None`、`expires_in=300`）、A3 轮询 pending 不含 token、A4 `qr/info` 置 scanned 与 401/400 分支、A5 无后台角色确认 → 403 + 会话 failed、A6 授权 operator 后确认 → 轮询返回 token+menus（含 `questions`、不含 `access`）、A7 令牌单次签发（二次轮询无 token）、A8 取消 → cancelled、A9 过期会话 info 404 + 轮询置 expired、A10 绑定确认成功 + 凭证重复使用 400、A11 同渠道重复绑定/openid 已绑他人/unionid 已属他人均 400、A12 解绑三分支。**报告同时说明：mock 模式下验证，真实小程序码链路待配置微信凭证后在真机验收（批次 5）；限流（429）未纳入本脚本。**
- 后续验证补充：`30b4458`（2026-10-11）迭代记录载明「后端回归 … **s8 23/23** …」，`4bf9acd`（2026-10-09）载明「S8 复测 23/23 回归通过」——即本文件在两次后续改动中均通过 S8 回归，但**本文件自身代码未被修改**。
