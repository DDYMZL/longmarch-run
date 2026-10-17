# identity.py

## 1. 文件路径

`backend/app/api/routes/identity.py`（116 行）

## 2. 文件职责

小程序侧身份关联路由：PC 扫码登录的场景查询与确认/取消、身份绑定确认、当前用户已绑定身份列表与解绑。全部业务规则在 `backend/app/services/identity_service.py`，本文件只做场景前缀分发（`L*` 登录 / `B*` 绑定）与异常转 HTTP 状态码。

**命名与路径不一致说明**：文件名叫 `identity.py`，但 4 个端点路径均为 `/auth/*`（`/auth/qr/info`、`/auth/qr/confirm`、`/auth/identities`、`/auth/identities/{identity_id}`），router 不设 prefix、路径内写全（`:24`，`backend/app/main.py:72` 以 `/api` 前缀挂载）。原因是小程序侧把「登录、身份」视为同一 `/auth` 命名空间（模块 docstring `:2-4` 明示「除本文件外小程序用户路由见 routes/auth.py」，前端调用方 `frontend/services/identity.js:14`/`:27`/`:35`/`:41` 也全部走 `/auth/*`）；文件按**服务域**（identity_service）拆分，路径按**前端契约**归组，两者口径不同。

## 3. 业务需求

- 需求来源：`b431e4d`（2026-10-09）「微信扫码登录与身份关联（批次2）」（`docs/迭代记录.md` 的 `b431e4d` 条目）；设计文档 `docs/identity-binding-design.md`（identity_service docstring `:1` 直接引用）。
- 业务场景：管理员在 PC 管理后台登录页展示小程序码，用手机微信扫码 → 小程序确认页确认 → PC 端签发管理员令牌，替代账号密码登录；以及为阶段 2 的 `wx_web` 渠道身份绑定预留确认流程。

## 4. 核心功能

**4 个端点**，全部依赖 `Depends(get_current_user)`（符合不变量 2，无豁免）：

| # | 方法+路径 | 函数 | 行号 | response_model |
|---|---|---|---|---|
| 1 | `POST /api/auth/qr/info` | `qr_info` | `:27-51` | `QrInfoOut` |
| 2 | `POST /api/auth/qr/confirm` | `qr_confirm` | `:54-86` | `MessageOut` |
| 3 | `GET /api/auth/identities` | `identities` | `:89-98` | `List[IdentityOut]` |
| 4 | `DELETE /api/auth/identities/{identity_id}` | `unbind` | `:101-115` | `MessageOut` |

### 4.1 PC 扫码登录完整时序（跨 3 个文件）

1. **PC 创建会话**：`POST /api/admin/wechat/qr`（`backend/app/api/routes/admin.py:119-139`，挂 `qr_create_limiter` 10 次/分/IP，`admin.py:129`）→ `identity_service.create_login_session`（`backend/app/services/identity_service.py:43-55`）：生成 `L{token}` 明文 scene（≤32 字符，适配微信 scene 长度限制），库内**只存 SHA-256 摘要**（`:48`），`expires_at = now + QR_LOGIN_TTL_SECONDS`（`:50`）。返回 qr_id（轮询凭证）+ scene + 小程序码图片；qr_id 与 scene **分离、互不可推导**（identity_service docstring `:6-7`）。
2. **PC 轮询**：`GET /api/admin/wechat/qr/{qr_id}/status`（`admin.py:142-175`，挂 `qr_poll_limiter` 60 次/分/IP，`admin.py:149`）→ `poll_login_session`（`identity_service.py:74-82`，pending 且过期时惰性置 `expired`）；confirmed 时经 `issue_admin_token` 单次签发（见第 5 步）；响应含 `fail_reason`（`admin.py:173`），PC 登录页据此展示失败原因（`admin/src/views/LoginView.vue:120-127`）。
3. **手机扫码进确认页**：小程序 `pages/bind/bind` 解析 scene（`frontend/pages/bind/bind.js:49-61`）→ `POST /api/auth/qr/info`（本文件端点 1）：`L` 前缀查会话，不存在/过期 **404「扫码凭证不存在或已过期」**（`:36-38`；过期判定在 `identity_service.get_login_session:65-70`，过期即置 `expired` 并返回 None）；命中则 `mark_scanned`（`:39`；仅 pending→scanned，`identity_service.py:85-89`）；返回 `type="login"` + status + expiresAt（`:40`）。
4. **手机确认**：`POST /api/auth/qr/confirm`（本文件端点 2）action=confirm → `identity_service.confirm_login`（`:99-119`）：会话非 pending/scanned 抛 ValueError「扫码凭证已使用或已失效」→ **400**（`:84-85`）；**无后台授权**（`access_service.get_enabled_roles` 为空）→ 会话置 `failed` + 写 fail_reason，路由返回 **403**，detail「无后台访问权限，请联系管理员授权」（`:71-73`、`identity_service.py:31`、`:109-113`）；成功则会话置 `confirmed`、记 user_id、写审计 `admin.login.qr`（`identity_service.py:114-118`），返回「登录已确认」。action=cancel → `cancel_login`（仅 pending/scanned 生效，`identity_service.py:92-96`），返回「已取消」（`:68-70`）。
5. **PC 换取令牌**：轮询见 confirmed → `identity_service.issue_admin_token`（`:122-141`）：`UPDATE ... WHERE token_issued = false` 条件更新保证并发轮询下**只签发一次**（`:127-131`），随后 `admin.py:155-166` 用返回的 user 经 `create_admin_token_for_user` 签发 `typ=user` 管理员令牌。

### 4.2 绑定场景（B 前缀，wx_web 阶段 2 预留）

- `qr/info` B 分支（`:41-50`）：`get_bind_request`（`identity_service.py:145-160`，token 摘要匹配、pending 过期惰性置 expired），不存在/过期 **404「绑定凭证不存在或已过期」**；命中返回 `type="bind"` + `target={provider, appId}`（`QrInfoTarget`，`schemas.py:98-103`，**openid 不对外返回**）。
- `qr/confirm` B 分支（`:75-83`）：confirm → `confirm_bind`（`identity_service.py:170-236`）事务内三重唯一性校验（身份已属他人 / 同渠道已绑当前账号 / unionid 已属他人，均 ValueError → **400**，禁止自动合并），通过后写 `user_identities` 行、凭证置 `used`、写审计 `identity.bind.confirm`；cancel → `cancel_bind`（仅 pending 可取消，`identity_service.py:163-167`）。
- 非 `L`/`B` 前缀：两个端点均 **400「无效的扫码场景」**（`:51`、`:86`）。

### 4.3 身份列表与解绑（端点 3、4）

- `GET /auth/identities`：`identity_service.list_identities(db, current.id)`（`:97`；`identity_service.py:240-247` **按 `user_id == current.id` 过滤**，id 升序），返回 `IdentityOut` 列表（`schemas.py:121-129`：id/provider/appId/unionid/verifiedAt/createdAt，**不含 openid**）。
- `DELETE /auth/identities/{identity_id}`：`identity_service.unbind(db, current, identity_id)`（`:112`；`identity_service.py:250-260`）。

## 5. 输入与输出

- 请求体：`QrInfoRequest`（`scene` 1-64，`schemas.py:92-95`）、`QrConfirmRequest`（`scene` 1-64 + `action` 正则限定 `confirm|cancel`，`schemas.py:114-118`）；路径参数 `identity_id: int`。
- 响应：`QrInfoOut`（`type`/`status`/`target`/`expiresAt`/`failReason`，`schemas.py:106-111`）——**注意 `failReason` 字段在本文件两个分支均未赋值，恒为 null**；失败原因由 PC 端轮询接口取（`admin.py:173`）。`MessageOut`（`message`，`schemas.py:728-729`）、`IdentityOut`。
- 状态值（会话/凭证 status，`identity_service.py:24-29`）：`pending`/`scanned`/`confirmed`/`failed`/`cancelled`/`used`，另有惰性写入的 `expired`（`:68`、`:80`、`:157`）。
- 错误码：400（场景前缀无效、凭证已用/已失效、绑定唯一性冲突、解绑校验失败）、401（`get_current_user` 链）、403（确认登录者无后台授权）、404（凭证不存在或已过期）、422（Pydantic 校验，框架默认）。**本文件端点未挂限流**（限流在 PC 侧创建/轮询接口，`admin.py:129`/`:149`）。

## 6. 依赖关系

- 依赖：`backend/app/api/deps.py`（`get_current_user`）、`backend/app/core/database.py`（`get_db`）、`backend/app/services/identity_service.py`（全部业务）、`backend/app/schemas/schemas.py`（6 个 Schema）。
- 间接依赖（经 identity_service）：`access_service.get_enabled_roles`（确认登录时的授权校验，`identity_service.py:107-109`）、`audit_service`（`admin.login.qr`/`identity.bind.confirm`/`identity.unbind` 三类审计）、`core/config.py` 的 `QR_LOGIN_TTL_SECONDS`。
- 被依赖：`backend/app/main.py:72` 注册；小程序 `frontend/services/identity.js`（4 个函数一一对应）、`frontend/pages/bind/bind.js`（确认页）、`frontend/pages/account/account.js`（列表与解绑）。
- 数据库表：`qr_login_sessions`（读+状态流转）、`bind_requests`（读+状态流转）、`user_identities`（读/写/删）、`audit_logs`（写）。
- 事务边界：服务层自提交（identity_service 各函数内 `db.commit()`），路由层不 commit。

## 7. 业务规则

1. **TTL 两个配置项的分工**（`backend/app/core/config.py:55-57`，值不入文档）：
   - `QR_LOGIN_TTL_SECONDS`：PC 扫码登录会话有效期。写入点 `identity_service.py:50`（创建会话时算 `expires_at`）；`admin.py:138` 以 `expires_in` 返回给 PC。过期判定为**惰性**（查询/轮询时发现过期才置 `expired`，`:67-70`、`:79-81`），无后台清理任务。
   - `BIND_REQUEST_TTL_SECONDS`：身份绑定请求有效期。**backend/app 代码中当前无任何引用**（全仓 grep 仅命中 `config.py:57` 定义、三份 env 文件、README/design 文档与 `.qoder/backend/app/core/config.py.md:68`）——因为绑定请求**没有对外创建接口**（`backend/test/fixtures_identity_bind.py:3` 注释「绑定请求无对外创建接口（wx_web 渠道阶段2 门控），测试直接经 ORM 落库」），过期实际由库内 `expires_at` 列判定（`identity_service.py:156-159`）。该配置属阶段 2 预留，当前是否遗漏接线**待确认**。
2. **归属校验（能否解绑他人身份）——确切结论：不能**。`identity_service.unbind:252-254`：`identity is None or identity.user_id != user.id` 一律抛 ValueError「身份不存在」→ 路由转 **400**（`:113-114`）。非本人身份与不存在身份返回同一文案，不泄露资源存在性；解绑他人身份在任何路径下都不可达（端点先过 `get_current_user`，再按 `current` 校验归属）。已由冒烟测试覆盖：`backend/test/s8_identity_admin.py` A12「非本人身份 400」（报告 `backend/test/docs/s8-identity-admin.md:22`）。
3. **`wx_mini` 为登录凭证不可解绑**：`identity_service.py:255-256`，400「微信登录凭证不可解绑」（解绑即失去登录方式）。
4. **provider 支持取值**：`wx_mini` 与 `wx_web`（`backend/app/models/models.py:386` 模型 docstring；`docs/identity-binding-design.md:47` 表设计一致）。`wx_mini` 由登录/入驻自动采集（`identity_service.ensure_wx_mini_identity:264-314`，仅真实微信响应时调用）；`wx_web` 只能经 B 场景 `confirm_bind` 写入。
5. **`wx_web` 预留能力结论（复核后仍成立）**：全仓 grep `wx_web` 核实——数据库与模型注释支持该值（`models.py:386`）；小程序 `frontend/pages/account/account.js:9-12` `PROVIDER_NAMES` 备好「微信网页授权」文案并能渲染/解绑该来源；但 **backend/app 内无任何创建 `BindRequest` 行的接口**（唯一写入路径 `confirm_bind` 的前置凭证无生产入口，仅测试 fixture 经 ORM 落库），`WX_WEB_APPID`/`WX_WEB_SECRET` 配置（`config.py:48-50`）在 backend/app 代码中无引用；管理后台无身份来源展示页（grep `identities` 在 `admin/src/` 无命中）。与 `.qoder/ARCHITECTURE.md` §7「wx_web 半成品」段、`.qoder/REQUIREMENTS.md` §2.4「wx_web 网页授权渠道」行、`.qoder/PROJECT.md` §8「架构级限制」第 10 项的「半成品/部分实现」结论一致：**确认/取消/列表/解绑半程已实现，凭证创建半程缺失**。
6. **凭证安全**：scene/qr 明文不落库，只存 SHA-256 摘要（`identity_service.py:5-6`、`:34-35`）；L/B 凭证仅后端可生成（本文件 docstring `:4`）；qrId 与 scene 分离互不可推导。
7. **一人一 unionid**：unionid 冲突禁止自动合并（`identity_service.py:203-211`、`:279-299`）。

## 8. 修改约束

1. `L`/`B` 场景前缀是与小程序码 scene、`frontend/pages/bind/bind.js:49-50` 分发逻辑的三方契约，改前缀需三端同步。
2. scene ≤32 字符受微信小程序码 scene 长度硬限制（`identity_service.py:44` docstring），生成逻辑不得突破。
3. 响应必须 camelCase（`CamelModel`，不变量 1）；`QrInfoOut`/`IdentityOut` **不得新增 openid 字段**（`schemas.py:99`、`:122` 注释明确不对外返回）。
4. 解绑的「非本人 = 不存在」同文案处理是安全设计，不得改成区分 404/403 而泄露存在性。
5. `confirm_login` 的失败必须同时落 `fail_reason`（PC 端轮询展示依赖，`admin.py:173`、`LoginView.vue:121`）。
6. 路由层只做前缀分发与异常转换，唯一性/状态机规则全部留在 identity_service（分层规则，`backend/AGENTS.md` §3.1）。

## 9. 当前实现状态

- **已实现**：4 个端点全部可用；PC 扫码登录全链路（创建/轮询/确认/取消/单次签发）经 S8 集成测试 23/23 验证（`b431e4d` 提交信息，`docs/迭代记录.md` 的 `b431e4d` 条目；报告 `backend/test/docs/s8-identity-admin.md`）；小程序确认页与账号页经 automator 验证（`frontend/test/docs/identity-bind-account-report.md`）。
- **部分实现（预留）**：`wx_web` 绑定渠道——确认流程就绪但无凭证创建入口（§7 第 5 条）。
- **存在问题 / 已知事项**：
  1. `BIND_REQUEST_TTL_SECONDS` 定义未接线（§7 第 1 条，待确认是否遗漏）。
  2. `QrInfoOut.fail_reason` 在本文件恒为 null（§5），字段仅对 PC 轮询接口有意义，属 Schema 复用产生的冗余可空字段。
  3. 会话/凭证过期为惰性置位，无清理任务，`qr_login_sessions`/`bind_requests` 表过期行会持续累积（无 TTL 删除逻辑；量级影响待确认）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/identity.py`，仅 **1 个提交**。

### 2026-10-09（`b431e4d`，10:27）
- 需求：微信扫码登录与身份关联（批次 2）。
- 修改内容：创建本文件（4 端点）；同批交付 `identity_service`（扫码会话创建/轮询/确认/取消/单次签发、绑定确认事务、身份列表与解绑、登录采集 unionid）、`qr_login_sessions`/`bind_requests`/`user_identities` 相关迁移、管理员令牌 typ 区分与每请求查库校验、接口限流。
- 关联文件：`backend/app/services/identity_service.py`、`backend/app/api/routes/admin.py`、`backend/app/api/routes/auth.py`（登录采集 unionid）、`frontend/pages/bind/`、`frontend/pages/account/`、`frontend/services/identity.js`。
- 测试结果：S8 集成测试 **23/23 通过**（提交信息；报告 `backend/test/docs/s8-identity-admin.md`）。
