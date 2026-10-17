# security.py

## 1. 文件路径
`backend/app/core/security.py`

## 2. 文件职责
JWT 令牌的签发与校验（模块 docstring `:1`）：提供小程序用户令牌、管理端超管令牌、微信关联管理员令牌三类签发函数，以及统一的 `decode_token` 校验函数。是全后端唯一的令牌工厂与验签入口。

## 3. 业务需求
- 小程序登录后需持有 Bearer Token 访问业务接口（`backend/AGENTS.md` §4 不变量 2：除 `POST /api/auth/login` 外所有路由必须依赖 `get_current_user`）。
- 管理后台两种登录方式对应两类管理员令牌（`b431e4d`，2026-10-09 微信扫码登录与身份关联批次 2）：账号密码登录 → 超管令牌（`typ=super`）；小程序扫码确认登录 → 微信关联管理员令牌（`typ=user`），后者每请求查库校验、授权撤销即时生效。
- 无服务端会话存储、无 refresh token、无令牌黑名单（ARCHITECTURE.md §5.1）：令牌失效靠「短有效期兜底 + 每请求查库重建权限」实现。

## 4. 核心功能

### 4.1 `create_access_token(user_id, openid)`（`:10-19`）
签发小程序用户访问令牌。载荷（`:13-18`）：`sub`=用户主键 id 的字符串形式、`openid`、`iat`、`exp`；有效期 = `settings.JWT_EXPIRE_MINUTES`（默认 10080 分钟即 7 天，`core/config.py:39`）。

### 4.2 `create_admin_token(username)`（`:22-32`）
签发超管令牌（账号登录）。载荷（`:25-31`）：`sub`=用户名（**非数字 id**）、`role="admin"`、`typ="super"`、`iat`、`exp`；有效期 = `settings.JWT_ADMIN_EXPIRE_MINUTES`（默认 720 分钟即 12 小时，`core/config.py:40`）。

### 4.3 `create_admin_token_for_user(user_id)`（`:35-49`）
签发微信关联管理员令牌。载荷（`:42-48`）：`sub`=用户主键字符串、`role="admin"`、`typ="user"`、`iat`、`exp`；有效期同上 12 小时。docstring（`:36-40`）明确关键设计：**权限不写入令牌**——`get_current_admin` 每次请求查库校验，撤销即时生效，12 小时有效期仅作兜底。

### 4.4 `decode_token(token)`（`:52-59`）
统一验签：`jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])`（`:55-57`，算法为白名单列表，默认 HS256）。捕获 `jwt.PyJWTError`（过期/篡改/格式错误均在其内）后**返回 None 而非抛异常**（`:58-59`），由调用方决定 401 文案。

### 4.5 公共实现细节
- 三个签发函数均用 `datetime.now(timezone.utc)` 取当前时间（`:12`、`:24`、`:41`），`iat`/`exp` 以 `datetime` 对象放入载荷，由 PyJWT 自行转时间戳。
- 密钥与算法全部来自 `settings`（`JWT_SECRET`、`JWT_ALGORITHM`），本文件无硬编码。

## 5. 输入与输出
| 函数 | 入参 | 返回 | 异常 |
|---|---|---|---|
| `create_access_token` | `user_id: int`、`openid: str` | JWT 字符串 | 不主动抛（密钥未配置等由 PyJWT 抛出） |
| `create_admin_token` | `username: str` | JWT 字符串 | 同上 |
| `create_admin_token_for_user` | `user_id: int` | JWT 字符串 | 同上 |
| `decode_token` | `token: str` | 成功→载荷 dict；失败→`None` | **不抛异常**（`jwt.PyJWTError` 被吞并转 None） |

三类令牌的区分方式（消费方判别逻辑）：
- 用户令牌：无 `role`/`typ` 字段，`sub` 为数字字符串；
- 管理令牌：`role="admin"`；`typ="super"`（sub=用户名）与 `typ="user"`（sub=数字字符串）区分两类管理员；
- **改造前签发的历史管理令牌无 `typ` 字段**，`api/deps.py:127-129` 把「`typ != "user"`（含缺失）」一律按超管放行——兼容旧令牌的既定行为（ARCHITECTURE.md §5.3）。

**本文件不含密码哈希能力**：管理端账号密码登录是明文比对 `settings.ADMIN_PASSWORD`（`routes/admin.py:110-114`）；小程序用户无密码（微信登录）。凭证摘要（SHA-256）在 `services/identity_service.py`（扫码/绑定凭证），不属于本文件。

## 6. 依赖关系
- **依赖**：第三方 `jwt`（PyJWT，`:5`）；`app.core.config.settings`（`:7`）。无数据库、无业务模块依赖（core 层约束，`backend/AGENTS.md` §3.1）。
- **被依赖**：
  - `create_access_token`：`services/auth_service.py:16`（import）、`:61`（`_sign_in` 已入驻用户签发）、`:155`（入驻流程签发）。
  - `create_admin_token`：`routes/admin.py:21`（import）、`:115`（`POST /api/admin/login` 账号登录成功后签发）。
  - `create_admin_token_for_user`：`routes/admin.py:21`、`:166`（扫码登录轮询 `confirmed` 且单次签发校验通过后）。
  - `decode_token`：`api/deps.py:9`（import）、`:26`（`get_current_user`）、`:122`（`get_current_admin`）；`api/routes/ws.py:12`、`:30`（WebSocket 建连鉴权，令牌走 query string）。
  - 测试脚本：如 `test/s20_v2_regression.py:97` 直接用 `create_admin_token(settings.ADMIN_USERNAME)` 铸造管理端令牌。

## 7. 业务规则
- **`sub` 语义按令牌类型不同**：用户/`typ=user` 令牌为 `str(user_id)`，`typ=super` 令牌为用户名字符串；消费方 `deps.py` 对用户令牌做 `int(sub)` 转换，失败即 401（ARCHITECTURE.md §5.2）。
- **权限不进令牌**（`:38-39` 注释；ARCHITECTURE.md 不变量 8）：`typ=user` 管理员的菜单权限每次请求由 `access_service.build_principal` 查库重建；超管令牌在有效期内无法单独吊销，只能改 `JWT_SECRET` 全量失效。
- **校验失败静默**：`decode_token` 返回 None，401 状态码与文案由 `deps.get_current_user` / `get_current_admin` / `ws.py` 各自决定（`backend/AGENTS.md` §4 不变量 7）。
- 过期时间只由配置决定：用户 7 天、管理员 12 小时；无续签/刷新机制。

## 8. 修改约束
- 改 `JWT_SECRET` 会使**全部三类存量令牌同时失效**（全量踢下线），生产变更前须评估。
- 不得在令牌载荷中加入权限/菜单数据——破坏「撤销即时生效」设计（`:38-39` 注释、不变量 8）。
- `decode_token` 「失败返回 None」的契约被 3 处消费方依赖（deps 两处 + ws），改成抛异常属破坏性变更。
- `typ` 字段的取值（`super`/`user`/缺失=按超管）与 `deps.py:127-129` 的兼容分支耦合，新增令牌类型必须同步修改 `get_current_admin` 与 `ws.py` 的鉴权分支。
- 算法保持 HS256 对称签名；`decode` 侧用 `algorithms=[...]` 白名单（`:56`），不得改为 `algorithms=None` 或放开列表（防算法混淆攻击）。

## 9. 当前实现状态
- 已实现：三类令牌签发、统一验签、`typ` 区分与历史令牌兼容（兼容逻辑在 `deps.py`，本文件只负责写入字段）。
- 已知限制（现状记录，与 ARCHITECTURE.md §5.1 一致）：
  - 无 refresh token、无黑名单、无服务端会话存储；`typ=super` 令牌 12 小时内不可单独吊销。
  - 本文件不提供密码哈希；`ADMIN_PASSWORD` 为 env 明文配置 + 路由层明文比对（`routes/admin.py:110-114`）。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/core/security.py`（3 个提交）与 `docs/迭代记录.md`，按时间倒序。

### 2026-10-09
- 需求：微信扫码登录与身份关联（批次 2）——管理员令牌需区分超管与微信关联管理员，且关联管理员授权撤销要即时生效（提交 `b431e4d`）。
- 修改内容：`create_admin_token` 增加 `typ="super"`，有效期由 `JWT_EXPIRE_MINUTES`（7 天）改用新增的 `JWT_ADMIN_EXPIRE_MINUTES`（12 小时）；新增 `create_admin_token_for_user`（`typ="user"`、sub 存用户主键、权限不写入令牌，`:35-49`）。
- 关联文件：`core/config.py`（新增 `JWT_ADMIN_EXPIRE_MINUTES`）、`api/deps.py`（`get_current_admin` 每请求查库）、`routes/admin.py`、`services/identity_service.py`。
- 测试结果：S8 集成测试 23/23 通过（`backend/test/s8_identity_admin.py`，报告 `backend/test/docs/s8-identity-admin.md`）（`docs/迭代记录.md`）。

### 2026-10-01
- 需求：新增管理后台 API（登录/题库/组织架构/路线节点/排名），需要管理端令牌（提交 `337af78`）。
- 修改内容：新增 `create_admin_token(username)`——当时 `role="admin"`、无 `typ`，有效期用 `JWT_EXPIRE_MINUTES`（后由 `b431e4d` 调整）。
- 关联文件：`routes/admin.py`、`core/config.py`（`ADMIN_USERNAME`/`ADMIN_PASSWORD`）。
- 测试结果：待确认（`docs/迭代记录.md` 该条目只有内容摘要、未记录验证字段）。

### 2026-09-30
- 需求：项目初始化（提交 `a94e685`）。
- 修改内容：创建本文件：`create_access_token`（sub=用户主键字符串 + openid + iat/exp）与 `decode_token`（失败返回 None）。
- 关联文件：仓库初始代码（backend + frontend）。
- 测试结果：待确认（`docs/迭代记录.md` 该条目未记录验证字段）。
