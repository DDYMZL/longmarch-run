# 长征步迹：小程序与 PC 管理后台微信身份关联设计

> 版本：v1（2026-10-09）｜状态：待评审实施
> 选型结论：**PC 扫码登录采用「小程序码扫码确认」渠道**（复用现有小程序，无需开放平台账号/备案域名）；后台授权采用**完整 RBAC（角色 + 菜单权限）**。

## 1. 现状核查结论

| 项 | 现状 |
| --- | --- |
| 用户表 | `users`（openid 唯一），无 `sys_user`；无角色/菜单/权限模型，无审计日志 |
| 小程序登录 | `POST /api/auth/login`（`auth_service.wx_login`）：code2Session 仅取 openid，**unionid/session_key 被丢弃** |
| PC 登录 | `POST /api/admin/login`：比对配置 `ADMIN_USERNAME/ADMIN_PASSWORD`（明文），签发 `role=admin` JWT，不绑定任何用户 |
| JWT | HS256 单密钥双用途：用户令牌 `sub=user_id`（7 天）；管理员令牌 `sub=username, role=admin`（7 天）；无刷新机制 |
| 鉴权 | `deps.get_current_admin` 只看 payload 的 `role=admin`，不查库，权限撤销无法即时生效 |
| 微信配置 | 仅 `WX_APPID/WX_SECRET`（小程序）；无开放平台、无扫码、无绑定相关代码 |
| 迁移 | 无 Alembic；`docker/init/0XX_*.sql` + `schema_migrations` 表，当前最新 009 |
| 菜单 | admin 前端硬编码（`AdminLayout.vue`），后端无菜单权限模型 |

与需求文档的差异：① 无 `sys_user`，实际为 `users`；② 无既有「后台访问授权与菜单权限」可沿用，需新建；③ 超级管理员当前仅有一个账号级配置（保留为兜底超管）。

## 2. 总体设计

三层分离：

```
微信身份认证（provider 抽象） ──► 系统用户关联（user_identities） ──► 后台授权（RBAC 角色/菜单）
   wx_mini: code2Session（已实现）          provider/app_id/openid/unionid          admin_user_roles + admin_menus
   wx_web: qrconnect（阶段2，配置门控）     唯一约束 + unionid 一人规则              per-request 查库，撤销即时生效
```

- **认证渠道抽象**：`identity_service` 按 `provider` 分发；当前实现 `wx_mini`（登录时采集身份），预留 `wx_web`（开放平台网站应用，`WX_WEB_APPID/WX_WEB_SECRET` 为空时该渠道禁用）。
- **扫码登录**：PC 显示**小程序码**（`wxacode.getUnlimited`，scene=`L{随机凭证}`）→ 手机微信扫码 → 小程序确认 → 后端签发管理员 JWT。该方案在小程序资质内闭环，无需开放平台。
- **UnionID**：小程序登录 code2Session 若返回 unionid 即入库（`user_identities`）；冲突（同 unionid 已属他人）**拒绝合并**并审计告警。开放平台渠道落地后 unionid 用于 PC 自动关联。
- **超级管理员**：保留账号密码登录（`typ=super`），不依赖微信身份、不受 RBAC 限制，可见全部菜单（含「人员授权」「审计日志」）。**密码改为必须显式配置**（见 §6.6）。
- **会话失效**：管理员 JWT 仅作身份凭证，`get_current_admin` **每次请求查库**校验「用户存在 + 至少一个启用角色」，权限撤销/禁用立即生效；管理员令牌有效期缩短为 12 小时兜底。

## 3. 数据库设计（新增迁移 `docker/init/010_admin_identity.sql`）

`users` 表**不改动**（openid 保留为登录凭证兼容字段）。新增 8 张表：

### 3.1 user_identities（身份关联表）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | SERIAL PK | |
| user_id | INT NOT NULL REFERENCES users(id) | |
| provider | VARCHAR(32) NOT NULL | `wx_mini` / `wx_web`（阶段2） |
| app_id | VARCHAR(64) NOT NULL | 对应微信应用 appid |
| openid | VARCHAR(64) NOT NULL | 该应用下的 openid |
| unionid | VARCHAR(64) NULL | 开放平台 unionid（可能缺失） |
| verified_at | TIMESTAMP NULL | 身份经微信服务端验证的时间 |
| created_at / updated_at | TIMESTAMP NOT NULL | |

约束：
- `UNIQUE (provider, app_id, openid)`（`uq_identity_provider_openid`）— 同一微信身份不得关联多个系统用户；
- `UNIQUE (user_id, provider, app_id)`（`uq_identity_user_channel`）— 同一用户在同一渠道不得重复绑定；
- **unionid 一人规则**：openGauss 无法用索引表达「一个 unionid 只属一个用户」（同一用户多渠道会持有相同 unionid），由**应用层在事务内校验**：查该 unionid 现存行，若全部属于目标用户则允许，否则拒绝（不自动合并）。

### 3.2 bind_requests（绑定请求记录表）

| 列 | 说明 |
| --- | --- |
| id SERIAL PK | |
| token_hash VARCHAR(64) UNIQUE NOT NULL | **绑定凭证仅存 SHA-256 摘要**，不存可重放的明文 |
| user_id INT NULL | 确认方系统用户（确认后回填） |
| provider / app_id / openid / unionid | 目标身份信息（来自微信服务端，非前端提交） |
| status VARCHAR(16) NOT NULL | `pending` / `confirmed` / `used` / `cancelled` / `expired` |
| expires_at TIMESTAMP NOT NULL | 短有效期（默认 10 分钟） |
| used_at / confirmed_at TIMESTAMP NULL | |
| created_at TIMESTAMP NOT NULL | |

### 3.3 qr_login_sessions（PC 扫码登录会话表）

| 列 | 说明 |
| --- | --- |
| id VARCHAR(24) PK | 轮询用会话 ID（`qrId`），与扫码凭证分离 |
| scene_token_hash VARCHAR(64) UNIQUE NOT NULL | 小程序码内嵌凭证的 SHA-256 摘要 |
| status VARCHAR(16) NOT NULL | `pending` / `scanned` / `confirmed` / `failed` / `cancelled` / `expired` |
| fail_reason VARCHAR(200) NULL | 拒绝原因（如「无后台访问权限」） |
| user_id INT NULL | 确认登录的用户（confirmed 时回填） |
| token_issued BOOLEAN NOT NULL DEFAULT false | 管理员 JWT 仅签发一次，防轮询重放 |
| expires_at / created_at / confirmed_at | 有效期默认 5 分钟 |

### 3.4 RBAC 四表

- `admin_menus`：id、code（UNIQUE，如 `dashboard`/`rankings`/`route_nodes`/`questions`/`quotes`/`orgs`/`screen`/`access`/`audit`）、name、sort_order。
- `admin_roles`：id、code（UNIQUE）、name、is_builtin（内置角色不可删除）、created_at。
- `admin_role_menus`：role_id + menu_id 联合主键。
- `admin_user_roles`：id、user_id（REFERENCES users）、role_id、enabled（禁用即时生效）、granted_by、granted_at、updated_at；`UNIQUE (user_id, role_id)`。

### 3.5 audit_logs（审计日志）

id、actor_type（`super`/`user`）、actor_user_id（超管为 NULL）、action、target_user_id、detail（TEXT，JSON）、created_at。

### 3.6 种子数据（010 内幂等写入）

- 菜单 9 条（上表 code 全集）；
- 内置角色 `operator`（运营管理员，is_builtin）：含 7 个业务菜单（不含 `access`/`audit`，这两项默认仅超管可见；可通过角色管理授权给自定义角色）。

## 4. 接口设计

约定：`/api/auth/*` 响应 camelCase（CamelModel，小程序契约）；`/api/admin/*` 响应 snake_case（admin 前端契约）。

### 4.1 小程序侧（需用户 JWT，除注明外）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/auth/login | 改造：code2Session 同时取 unionid；真实微信响应（非 mock）时 upsert `user_identities`（provider=wx_mini），unionid 冲突不合并、审计告警、仍按 openid 放行登录 |
| POST | /api/auth/qr/info | 入参 `{scene}`。解析 `L{token}`/`B{token}`，校验凭证有效；会话置 `scanned`；返回 `{type: login|bind, status, target:{provider, appId, nickname?}, expiresAt}` |
| POST | /api/auth/qr/confirm | 入参 `{scene, action: confirm|cancel}`。**login**：事务校验会话→校验当前用户 RBAC（无启用角色→403，会话置 `failed`+原因）→置 `confirmed` 并回填 user_id→写审计。**bind**：见 §5 绑定事务。**cancel**：置 `cancelled` |
| GET | /api/auth/identities | 当前用户已绑定身份列表 `[{id, provider, appId, unionid, verifiedAt, createdAt}]` |
| DELETE | /api/auth/identities/{id} | 解绑；**禁止解绑 `wx_mini` 主登录身份**；校验归属；写审计 |

### 4.2 PC 管理侧

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | /api/admin/login | 公开（限流 10 次/分/IP） | 保留；`ADMIN_PASSWORD` 未配置时返回 403「未配置管理账号，请使用微信扫码登录」 |
| POST | /api/admin/wechat/qr | 公开（限流 10 次/分/IP） | 生成 qrId+scene 凭证→存 `qr_login_sessions`→调 `wxacode.getUnlimited` 返回 `{qr_id, image(base64), expires_in}`；**mock 模式**（无微信凭证）返回 `{qr_id, image:null, scene, mock:true}` 供开发直连测试 |
| GET | /api/admin/wechat/qr/{qr_id}/status | 公开（限流 60 次/分/IP） | 返回 `{status, fail_reason, expires_in}`；首次查到 `confirmed` 时签发管理员 JWT（typ=user，12h）并置 `token_issued`，返回 `{token, username, is_super:false, menus}` |
| GET | /api/admin/me | 管理员 | `{username, is_super, menus:[{code,name}], roles:[code]}`，前端据此渲染菜单 |
| GET | /api/admin/users | 菜单 `access` | 人员分页列表（关键词/组织/是否有后台角色 筛选），含昵称、组织、角色、启用状态 |
| GET/POST/PUT/DELETE | /api/admin/roles | 菜单 `access` | 角色 CRUD + 菜单勾选（PUT 全量覆盖菜单）；内置角色禁删；被用户引用的角色删除时提示 |
| POST | /api/admin/users/{user_id}/roles | 菜单 `access` | 全量覆盖该用户角色（写审计：grant/revoke） |
| PATCH | /api/admin/users/{user_id}/roles/{role_id}/enabled | 菜单 `access` | 启用/禁用（禁用即时生效） |
| GET | /api/admin/audit-logs | 菜单 `audit` | 审计日志分页 + 时间/动作/操作人筛选 |
| 既有 /api/admin/* 接口 | 按菜单码挂 `require_menu(...)` | 见下表 |

菜单码与接口组映射（`require_menu` 依赖）：

| 菜单码 | 接口组 |
| --- | --- |
| dashboard | /admin/dashboard, /admin/dashboard/trend, /admin/activities |
| screen | /admin/screen |
| rankings | /admin/rankings, /admin/users/{id}/overview |
| route_nodes | /admin/route-nodes* |
| questions | /admin/questions* |
| quotes | /admin/quotes* |
| orgs | /admin/orgs* |
| access | /admin/users*, /admin/roles* |
| audit | /admin/audit-logs |

`/admin/me` 与 WebSocket `/ws/updates` 仅要求「已认证管理员」（WS 的 admin 分支同样改为查库校验，禁用即时断权）。

### 4.3 JWT 载荷改造（`core/security.py`）

- 超管令牌：`{sub: username, role: "admin", typ: "super", iat, exp}`（exp 12h）；
- 微信关联管理员令牌：`{sub: str(user_id), role: "admin", typ: "user", iat, exp}`（exp 12h）；
- 用户令牌不变（7 天）；新增配置 `JWT_ADMIN_EXPIRE_MINUTES=720`。
- `deps.get_current_admin`：typ=super → 放行；typ=user → 查 user + 启用角色 + 菜单，任一步失败 401/403。`require_menu(code)` 依赖基于其菜单集合判断。

## 5. 关键流程

### 5.1 PC 扫码登录（本期落地）

```
PC 登录页「微信扫码」→ POST /admin/wechat/qr（后端生成 qrId + scene 凭证，
调微信接口出小程序码 PNG）→ PC 每 2s 轮询 /status
手机微信扫码 → 小程序 pages/bind/bind?scene=L…（未登录先跳登录页）
→ POST /auth/qr/info（会话置 scanned）→ 展示「确认登录 PC 管理后台？」
→ 确认 → POST /auth/qr/confirm：
   事务：校验凭证（存在/未过期/未使用）→ 校验 RBAC（无启用角色 → 403 + 会话 failed）
   → 会话 confirmed + user_id → 审计「admin.login.qr」
→ PC 轮询到 confirmed → 拿管理员 JWT + 菜单 → 跳转后台
取消/过期：会话 cancelled/expired，PC 提示刷新重扫
```

### 5.2 首次绑定（阶段2 渠道 wx_web，本期建表与小程序确认页，渠道代码配置门控）

```
PC qrconnect 授权 → 回调 code → 后端换 openid/unionid → 查 user_identities 无匹配
→ 创建 bind_requests（目标身份来自微信服务端，token 仅存摘要，10min 有效）
→ 生成小程序码 scene=B{token} → 用户小程序扫 → bind 页展示目标身份
→ 明确确认 → 事务：
   凭证校验（有效/未用/未过期）→ 身份唯一性检查（provider+app_id+openid 未绑他人、
   该用户该渠道未重复绑定、unionid 一人规则）→ 写入 user_identities（verified_at=now）
   → 消费凭证（status=used）→ 审计「identity.bind.confirm」
后续：PC 扫码登录凭 unionid/已验证网页身份自动关联唯一 user_id
```

### 5.3 权限撤销 / 账号禁用

授权变更或禁用只改库（`admin_user_roles.enabled` / 移除角色）；`get_current_admin` 每请求查库，**旧 JWT 下一请求即失效**；12h 过期兜底。审计记录变更。

### 5.4 解绑

小程序「我的 → 账号与绑定」：列出身份；`wx_mini` 主登录身份不可解绑（提示「登录凭证不可解绑」）；其余身份可解绑并审计。

## 6. 安全设计

1. **凭证不落明文**：bind_requests / qr_login_sessions 只存 SHA-256 摘要；qrId（轮询凭证）与 scene（扫码凭证）分离，互不可推导。
2. **身份不信任前端**：所有微信身份（openid/unionid）均由后端调微信服务端接口获取；前端仅提交 code/scene。
3. **限流**：账号登录 10 次/分/IP、扫码创建 10 次/分/IP、轮询 60 次/分/IP（进程内滑动窗口，`core/rate_limit.py`；多 worker 部署需换 Redis，已知限制）。
4. **会话与回调**：扫码会话短有效期（5 分钟）、单次签发 token、状态机防重复使用；HTTPS 部署要求写入 README。
5. **审计**：身份创建/绑定确认/取消、扫码登录成功、授权变更（grant/revoke/enable/disable）、解绑，全部写 `audit_logs`。
6. **不硬编码凭证**：`ADMIN_PASSWORD` 取消默认值（未配置则禁用账号登录，仅扫码登录）；微信密钥、JWT 密钥仅从环境变量/`.env` 读取（`.env` 已 gitignore）；日志禁止输出密钥/session_key/凭证。
7. **session_key 不落库**：code2Session 取到即弃（当前无 WeRun 解密需求）。

## 7. 需要修改的文件清单

### 后端 backend/

| 文件 | 动作 |
| --- | --- |
| `../docker/init/010_admin_identity.sql` | 新增：8 张表 + 菜单/内置角色种子 |
| `app/core/config.py` | 改：`JWT_ADMIN_EXPIRE_MINUTES=720`、`ADMIN_PASSWORD` 去默认值、`QR_LOGIN_TTL_SECONDS=300`、`BIND_REQUEST_TTL_SECONDS=600`、`WX_WEB_APPID/WX_WEB_SECRET`（阶段2门控） |
| `app/core/security.py` | 改：admin 令牌加 `typ`；新增 `create_admin_token_for_user` |
| `app/core/rate_limit.py` | 新增：进程内滑动窗口限流 |
| `app/models/models.py` | 改：新增 8 个 ORM 模型（与 010 SQL 同步） |
| `app/services/wechat_service.py` | 新增：access_token 缓存（TTL 7000s）+ `wxacode.getUnlimited`；mock 模式降级 |
| `app/services/auth_service.py` | 改：`_code2session` 返回 openid+unionid；登录成功 upsert 身份 |
| `app/services/identity_service.py` | 新增：扫码会话创建/轮询/确认、绑定事务、身份列表/解绑、unionid 一人规则 |
| `app/services/access_service.py` | 新增：RBAC（用户列表/角色 CRUD/授权变更）、审计写入 |
| `app/api/deps.py` | 改：`get_current_admin` 查库校验；新增 `require_menu` |
| `app/api/routes/admin.py` | 改：登录限流+密码未配置拒绝；新增 wechat/qr、me、users、roles、audit-logs；既有接口挂 `require_menu` |
| `app/api/routes/identity.py` | 新增：`/auth/qr/info`、`/auth/qr/confirm`、`/auth/identities*` |
| `app/api/routes/ws.py` | 改：admin 分支改为查库校验 |
| `app/schemas/schemas.py` | 改：新增 Admin*/Identity* 请求响应模型 |
| `app/main.py` | 改：注册 identity 路由 |
| `test/` | 新增集成测试（见 §9）+ `test/docs/` 报告 |
| `design.md` / `README.md` | 同步 API 一览、鉴权与安全说明 |

### 管理后台 admin/

| 文件 | 动作 |
| --- | --- |
| `src/api/admin.ts` | 改：新增 qr/status、me、users、roles、audit-logs 接口与类型 |
| `src/store/auth.ts` | 改：持久化 `username/isSuper/menus`（新增 `lm_admin_menus`、`lm_admin_is_super` 键） |
| `src/views/LoginView.vue` | 改：账号/扫码双 tab；扫码 tab 展示小程序码 + 2s 轮询 + 过期刷新；mock 模式显示场景码输入框（开发用） |
| `src/router/index.ts` | 改：新增 `/access`、`/audit` 路由（守卫同步校验菜单权限） |
| `src/layout/AdminLayout.vue` | 改：菜单按 `me` 返回的菜单集渲染（超管全量） |
| `src/views/AccessView.vue` | 新增：人员授权（列表筛选/角色全量覆盖/启用禁用）+ 角色管理（CRUD + 菜单勾选） |
| `src/views/AuditView.vue` | 新增：审计日志分页 + 筛选 |
| `test/docs/`、`test/images/` | 浏览器验收报告与截图 |

### 小程序 frontend/

| 文件 | 动作 |
| --- | --- |
| `app.json` | 改：注册 `pages/bind/bind`、`pages/account/account` |
| `pages/bind/bind.*` | 新增：扫码确认页（scene 解析、login/bind 双模式、未登录引导、确认/取消、结果态） |
| `pages/account/account.*` | 新增：账号与绑定（身份列表、解绑（主身份禁解绑）、错误态） |
| `pages/mine/mine.*` | 改：「我的」新增「账号与绑定」入口 |
| `services/identity.js` | 新增：qrInfo/qrConfirm/identities/unbind（复用 `request.js`） |
| `design.md` | 同步页面与服务层清单 |

### 根目录

- 新增 `docs/identity-binding-design.md`（本文件）；提交后同步追加 `docs/迭代记录.md`。

## 8. 测试方案

1. **后端集成测试（TestClient，`backend/test/`）**：
   - 身份关联：登录自动建 `wx_mini` 身份（真实/mock 分支）、unionid 冲突不合并；
   - 绑定：成功、凭证过期、凭证重复使用、openid 已绑他人（身份冲突 409）、同用户同渠道重复绑定、解绑主身份被拒；
   - 登录鉴权：无角色用户扫码登录被拒（403 + 会话 failed）、禁用后旧 token 失效、授权后登录成功、token 单次签发（二次轮询无 token）；
   - RBAC：无菜单码访问对应接口 403、超管全放行、授权变更即时生效。
   - **测试中不将普通用户自动升级为管理员**：测试夹具显式构造角色授权数据，断言的是授权链路而非特权提升。
2. **管理后台**：`npm run build` + 浏览器验收（双 tab 登录、扫码轮询、菜单按权限渲染、人员授权/角色管理/审计页交互与窄屏）。
3. **小程序**：开发者工具 + `node --check` 语法检查；bind/account 页交互与空态；真机扫码需配置 `WX_APPID/WX_SECRET`（发布版小程序，或 `env_version=trial` 体验版 + 白名单扫码）。

## 9. 实施顺序（每批一个提交）

1. 迁移 `010` + ORM 模型 + 配置项（`docker compose up -d` 验证建表）；
2. 后端：微信服务（access_token/小程序码）+ 身份/扫码会话服务 + `/auth/qr/*`、`/auth/identities*`、`/admin/wechat/qr*`、`/admin/me` + 集成测试；
3. 后端：RBAC 四表服务 + `/admin/users|roles|audit-logs` + 既有接口挂 `require_menu` + WS 改造 + 集成测试；
4. 管理后台：扫码登录 tab、菜单按权限、人员授权页、审计页 + 浏览器验收；
5. 小程序：bind/account 页 + mine 入口 + 开发者工具验收；
6. 文档同步（backend/design.md、README、frontend/design.md）+ 全链路回归。

## 10. 已知限制与前提

- 小程序码需**已发布小程序**（开发期可用 `env_version=trial` 体验版扫码，或 mock 模式直连调试）；真实验收依赖 `WX_APPID/WX_SECRET` 配置。
- 开放平台网站应用渠道（unionid 自动关联 PC 登录）为阶段 2，需开放平台账号 + 网站应用（企业主体 + ICP 备案域名）；`bind_requests` 表与小程序确认页本期已就绪。
- 限流为进程内内存实现，多 worker 部署需换 Redis。
- 超管账号密码仍为配置明文比对（本期仅去默认值）；改哈希存储建议后续单独任务。
