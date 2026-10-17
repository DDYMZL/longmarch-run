# deps.py

## 1. 文件路径

`backend/app/api/deps.py`（160 行）

## 2. 文件职责

API 层横切依赖注入的唯一入口：数据库会话（`get_db` 重导出）、小程序用户鉴权（`get_current_user`）、停用账号即时断权（`_ensure_active`）、活动时间准入闸门（`require_activity_participation` / `require_activity_view`）、管理端身份重建与菜单权限（`AdminPrincipal` / `get_current_admin` / `require_menu`）。除少数公开接口（见 §6.4）外，全部 HTTP 路由的鉴权与准入都挂在本文件产出的依赖上。

## 3. 业务需求

- **鉴权边界**（`backend/AGENTS.md` §4 不变量 2）：除 `POST /api/auth/login` 外，所有路由必须依赖 `Depends(get_current_user)`；新增公开接口需显式说明理由。
- **停用即时断权**：邀请码准入全链路（提交 `afbcba9`，迁移 `015_invite_admission.sql`）要求被停用账号在所有受保护接口上立即 403。
- **活动时间控制**：V2.0 需求一（提交 `ce14a95`，迁移 `016_activity_settings.sql`）要求写接口在活动未发布/未开始/已结束时被拦截，读接口结束后按 `allow_view_after_end` 配置放行。
- **管理端 RBAC 撤销即时生效**：微信扫码登录与身份关联批次 2（提交 `b431e4d`，迁移 `010_admin_identity.sql`，设计文档 `docs/identity-binding-design.md`）。
- 项目级鉴权设计的权威阐述见 `.qoder/ARCHITECTURE.md` §5；本文档只记录本文件自身的事实。

## 4. 核心功能

### 4.1 `get_db` 重导出（`:8`）

`from app.core.database import get_db`，行内注释「在此重新导出，作为 API 层统一入口」。会话生命周期（`finally` 中 `db.close()`）由 `core/database.py` 管理，本文件不改动其行为；路由层按不变量 6 一律 `Depends(get_db)` 取会话。

### 4.2 `_bearer`（`:14`）

`HTTPBearer(auto_error=False)`：凭据缺失或格式不符时不由框架自动报错，`credentials` 以 `None` 进入依赖函数，401 文案统一由本文件控制。

### 4.3 `get_current_user`（`:17-43`）

从 `Authorization: Bearer <JWT>` 解析当前登录用户（JWT `sub` = 用户 id 的字符串形式，不变量 7）。完整失败分支：

| # | 条件 | 行号 | 状态码 | detail 文案 |
|---|---|---|---|---|
| 1 | `credentials is None` 或 `credentials.credentials` 为空 | `:22-25` | 401 | 未登录或令牌缺失 |
| 2 | `decode_token` 返回 `None`（过期/篡改，`core/security.py:52-59` 捕获 `PyJWTError` 返回 None）或 payload 无 `sub` | `:26-30` | 401 | 令牌无效或已过期 |
| 3 | `int(payload["sub"])` 抛 `TypeError`/`ValueError` | `:31-36` | 401 | 令牌无效 |
| 4 | 按 id 查库无此用户 | `:37-41` | 401 | 用户不存在 |
| 5 | `_ensure_active(user)` 不通过 | `:42` → `:46-53` | 403 | 账号已停用，请联系活动管理员（+ `X-Account-Status: disabled` 头） |

成功返回 `User` ORM 实例（`:43`）。

### 4.4 `_ensure_active`（`:46-53`）

停用账号即时断权：`user.status != invite_service.STATUS_ACTIVE`（值 `"active"`，`invite_service.py:24`）时抛 403（`:49-53`），detail 复用 `auth_service.ACCOUNT_DISABLED_MESSAGE`（值「账号已停用，请联系活动管理员」，`auth_service.py:24`），响应头 `X-Account-Status: disabled` 在 `:52` 设置。被 `get_current_user`（`:42`）与 `get_current_admin`（`:141`）两处调用。小程序 `frontend/services/request.js:81-86` 消费该头：置 `err.admission='disabled'` → `clearSession()` 回启动页，不走 401 静默重登链。

### 4.5 `_activity_guard` 工厂（`:56-75`）与两个准入依赖（`:79`、`:81`）

- 内部 `_check`（`:63-73`）先 `Depends(get_current_user)`（`:64`），因此 **401（未登录/令牌无效）与停用 403 永远先于活动准入 403**；再调 `activity_service.check(db, need_participate)`（`:66`，实现见 `activity_service.py:101-110`）。
- `check` 通过返回 `None`；拒绝返回 `{status, message}`，本文件转 403（`:68-72`）：detail = `blocked["message"]`（`:70`），响应头 `X-Activity-Status` = `blocked["status"]`（`:71`），取值 `unpublished` / `not_started` / `ended`（常量定义 `activity_service.py:22-25`）。
- 通过时返回 `user`（`:73`），路由函数直接拿到 `User`。
- `require_activity_participation = _activity_guard(need_participate=True)`（`:79`）：产生新业务数据（步数、答题、积分、勋章、点亮）的写接口用。
- `require_activity_view = _activity_guard(need_participate=False)`（`:81`）：读取成绩/排行等活动数据的接口用；活动结束后按 `activity_settings.allow_view_after_end` 决定放行（`activity_service.py:106`、`_access` `:64-67`）。
- 小程序 `frontend/services/request.js:87-91` 消费 `X-Activity-Status` → `redirectActivityClosed()` 跳活动状态页（3 秒去抖）。直接调接口（绕过小程序）同样被本闸门拦截。

### 4.6 `AdminPrincipal`（`:84-106`）

管理端身份主体。属性：`is_super` / `username` / `user_id` / `roles` / `menus`（`:91-103`，`roles`/`menus` 缺省为空列表）。`has_menu(code)`（`:105-106`）= `self.is_super or code in self.menus`。docstring（`:85-89`）区分两类主体：账号登录超管（`typ=super`，含历史无 `typ` 令牌）拥有全部菜单；微信关联管理员的 `user_id/roles/menus` 每次请求查库获得，撤销即时生效。

### 4.7 `get_current_admin`（`:109-147`）

解析管理员身份，完整分支：

| # | 条件 | 行号 | 状态码 | detail / 结果 |
|---|---|---|---|---|
| 1 | 凭据缺失 | `:118-121` | 401 | 未登录或令牌缺失 |
| 2 | `decode_token` 失败或 `payload["role"] != "admin"` | `:122-126` | 401 | 管理员令牌无效或已过期 |
| 3 | `payload.get("typ") != "user"`（含 `typ="super"` 与无 `typ` 历史令牌） | `:127-129` | — | 直接返回 `AdminPrincipal(is_super=True, username=str(payload.get("sub") or "admin"))`，不查库 |
| 4 | `int(payload["sub"])` 转换失败 | `:130-135` | 401 | 管理员令牌无效 |
| 5 | 查库无此用户 | `:136-140` | 401 | 管理员账号不存在 |
| 6 | `_ensure_active` 不通过 | `:141` | 403 | 账号已停用（+ `X-Account-Status: disabled`） |
| 7 | `access_service.build_principal(db, user)` 返回 `None`（无任何启用角色） | `:142-146` | 403 | 后台访问权限已被撤销或禁用 |
| 8 | 成功 | `:147` | — | `AdminPrincipal(**principal_data)` |

- **为什么权限不放进 token**：`core/security.py:38-39` 注释明确「get_current_admin 每次请求查库校验，撤销即时生效；12 小时有效期仅作兜底」（ARCHITECTURE §5.1、不变量 8）。`typ=user` 令牌载荷只有身份（`sub`/`role`/`typ`），`roles`/`menus` 每次请求由 `access_service.build_principal`（`access_service.py:84-98`）查库重建，返回 `{is_super: False, username: user.nickname, user_id: user.id, roles: [role.code], menus: [菜单码]}`。
- **为什么无 `typ` 的历史令牌被当作超管**：`b431e4d`（2026-10-09）改造前，`337af78`（2026-10-01）签发的管理员令牌没有 `typ` 字段（初版 `get_current_admin` 校验 `role=admin` 后直接返回 payload dict，git 历史可查）。`:127` 的判断是 `typ != "user"` 而非 `typ == "super"`，`:128` 注释明确「超管令牌（typ=super）与改造前的历史令牌（无 typ）均视为超管」，避免改造后已签发的超管令牌全部失效。

### 4.8 `require_menu(code)`（`:150-160`）

菜单权限依赖工厂：`Depends(get_current_admin)`（`:153`）→ `admin.has_menu(code)` 不通过抛 403「无该功能的访问权限」（`:154-157`）。菜单码与 `admin_menus.code` 列一一对应（`AdminMenu` docstring，`models.py:457`）。

## 5. 输入与输出

| 依赖 | 输入 | 成功输出 | 失败输出 |
|---|---|---|---|
| `get_db`（重导出） | — | yield `Session`（`finally` 关闭） | 数据库异常由框架转 500 |
| `get_current_user` | `Authorization: Bearer <JWT(sub=用户id)>` | `User` ORM 实例 | 401×4 种文案；403 停用 |
| `require_activity_participation` / `require_activity_view` | 同上 | `User` | 上述 401/403；另 403 活动准入 |
| `get_current_admin` | `Authorization: Bearer <JWT(role=admin, typ=super/user/缺失)>` | `AdminPrincipal` | 401×4 种文案；403 停用 / 403 授权撤销 |
| `require_menu(code)` | 同上 | `AdminPrincipal` | 上述 401/403；另 403 无菜单权限 |

准入语义通过 **403 响应头** 传递（不变量 5）：

| 响应头 | 设置行号 | 取值 |
|---|---|---|
| `X-Account-Status` | `:52` | `disabled` |
| `X-Activity-Status` | `:71` | `unpublished` / `not_started` / `ended`（取自 `activity_service.check` 返回值） |

## 6. 依赖关系

### 6.1 上游 import（`:2-11`）

`fastapi`（Depends/HTTPException/status、HTTPBearer/HTTPAuthorizationCredentials）、`sqlalchemy.orm.Session`、`app.core.database.get_db`、`app.core.security.decode_token`、`app.models.models.User`、`app.services` 的 4 个模块：`access_service`（`build_principal`）、`activity_service`（`check`）、`auth_service`（停用文案常量）、`invite_service`（`STATUS_ACTIVE` 常量）。符合分层规则 `api/routes → api/deps → services → models + core`（`backend/AGENTS.md` §3.1）。

### 6.2 `require_activity_participation` 的调用点（grep 实测，8 个端点）

| 端点 | 位置 |
|---|---|
| `POST /march/light-up` 点亮达标节点 | `routes/march.py:68` |
| `POST /medal/check` 检查并发放勋章 | `routes/medal.py:27` |
| `POST /org/select` 首次选定所属组织 | `routes/org.py:61` |
| `POST /quiz/start` 开始/继续当前题 | `routes/quiz.py:31` |
| `POST /quiz/answer` 提交当前题答案 | `routes/quiz.py:42` |
| `POST /quiz/reset` 重置今日答题（调试用） | `routes/quiz.py:68` |
| `POST /sport/sync` 同步微信运动近 7 日步数 | `routes/sport.py:32` |
| `POST /sport/add` 手动补充步数（演示用） | `routes/sport.py:76` |

### 6.3 `require_activity_view` 的调用点（grep 实测，24 个端点）

| 路由模块 | 端点（行号） |
|---|---|
| `routes/ai.py` | chat `:56`、route_guide `:116`、quiz_explanation `:131` |
| `routes/march.py` | route_nodes `:28`、route `:34`、global_goal `:40`、footprints `:48`、node_detail `:57`、ceremony `:77` |
| `routes/medal.py` | medal_list `:16`（不可参与时只读、不发放勋章） |
| `routes/org.py` | companions `:45`、org_march `:53` |
| `routes/points.py` | points `:15`、daily `:27` |
| `routes/profile.py` | summary `:15`、timeline `:22` |
| `routes/quiz.py` | daily `:25`、records `:57`、knowledge `:62` |
| `routes/rank.py` | points_rank `:18`、steps_rank `:26` |
| `routes/sport.py` | today `:25`、recent `:56`、calendar `:65` |

两个工厂的区别：`participation` 要求「可参与」（活动进行中且已发布），用于**产生新业务数据**的写接口；`view` 只要求「可查看」，用于**读取成绩/排行**的接口，活动结束后按 `allow_view_after_end` 放行。

### 6.4 其他下游与例外

- `get_current_user` 直接使用（不叠加活动准入）：`routes/ai.py` 会话列表/详情/删除 `:72`/`:86`/`:101`；`routes/auth.py` me `:88`、update_nickname `:95`、set_initial_nickname `:114`；`routes/broadcast.py` today `:15`、activities `:22`；`routes/identity.py` qr_info `:30`、qr_confirm `:57`、identities `:95`、unbind `:108`；`routes/org.py` mine `:33`；`routes/persons.py` detail `:15`；`routes/quotes.py` today `:18`。
- `get_current_admin` / `require_menu` / `AdminPrincipal`：`routes/admin.py:15` 导入三者（`require_menu(` 调用 53 处；`get_current_admin` 直接使用 1 处——`GET /admin/me`，`admin.py:178-180`）；`routes/ai_admin.py:14` 导入 `AdminPrincipal` 与 `require_menu`（`require_menu(` 调用 24 处）。
- **不经本文件的公开接口**：`POST /auth/login`、`POST /auth/invite/verify`、`POST /auth/onboard`（`routes/auth.py`，未引用本文件）；`GET /activity/status`（`routes/activity.py:5` 直接 import `core.database.get_db`，`:13` 无鉴权）；`POST /admin/login`（`routes/admin.py:101-102`）。
- **WebSocket 例外**：`routes/ws.py` 不导入本文件（`:7-14` 直接用 `decode_token` + `access_service`/`invite_service` 自行实现同等校验），因为 WS 令牌走 query string 而非请求头（ARCHITECTURE §6.1）。

## 7. 业务规则

- **鉴权顺序固定**：活动准入依赖内部先走 `get_current_user`，故 401 与停用 403 优先于活动 403（`_check` `:63-66`）。
- **准入语义走响应头而非响应体字段**（ARCHITECTURE 不变量 5）；小程序端两个头都消费，管理后台 `admin/src/api/request.ts` 不消费（已知限制，ARCHITECTURE §15 第 8 项）。
- **`typ=user` 管理员每请求查库重建权限**（不变量 8）：角色停用（`admin_user_roles.enabled=False`）、角色撤销、账号停用均即时生效；`typ=super` 令牌在 12 小时有效期内无法单独吊销，只能改 `JWT_SECRET` 全量失效（ARCHITECTURE §5.1）。
- 本文件只做身份与准入判定，**不含业务规则**；业务规则全部在 services 层（`backend/AGENTS.md` §3.1）。

## 8. 修改约束

- 401/403 的 detail 文案会被两端直接展示给用户（小程序 `request.js:48-54` `errorMessage` 解析 `detail`；管理后台 `request.ts` 同理），改文案属于跨端契约变更。
- `X-Account-Status` / `X-Activity-Status` 的**头名与取值**是跨端契约（`frontend/services/request.js:81-91` 消费，且兼容小写头名），修改必须同步小程序。
- 不变量 2：新增不挂 `get_current_user` 的公开接口需显式说明理由。
- 不变量 7：`decode_token` 失败返回空、由本文件统一转 401——不要在路由内绕过本文件自行解析令牌（`ws.py` 是协议限制下的唯一例外）。
- 不变量 8：不得把 `menus`/`roles` 写入 JWT 载荷，也不得把 `get_current_admin` 的每请求查库改成缓存，否则「撤销即时生效」失效。
- 「无 `typ` 历史令牌视为超管」（`:127-129`）不能随意收紧为仅认 `typ=super`，否则改造前签发、仍在 12 小时有效期内的超管令牌会立即失效；确需收紧应配套强制重登说明。
- 401（而非 403）语义不可更改：小程序静默重登链（`request.js:129-160`）只对 401 触发「单飞重登 + 精确重试一次」。

## 9. 当前实现状态

- **已实现**：6 个对外依赖（`get_db` 重导出、`get_current_user`、`require_activity_participation`、`require_activity_view`、`get_current_admin`、`require_menu(code)` 工厂）+ 1 个内部工厂（`_activity_guard`）+ 1 个主体类（`AdminPrincipal`），覆盖全部 HTTP 路由的鉴权与准入，行为已逐行核对。
- **已知问题**（均为项目级，非本文件缺陷）：
  - 管理后台不消费 `X-Account-Status` / `X-Activity-Status`，403 无专门分支（ARCHITECTURE §15 第 8 项）。
  - 调试/演示端点 `POST /api/quiz/reset`、`POST /api/sport/add` 生产环境暴露，虽走 `require_activity_participation`，活动进行中仍可被用于刷分（ARCHITECTURE §15 第 5 项，建议加环境开关，尚未处理）。
  - 超管令牌有效期内不可单独吊销（ARCHITECTURE §5.1）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/deps.py`（共 5 次提交）+ `docs/迭代记录.md`。按时间倒序。

### 2026-10-13
- 需求：V2.0 需求一「活动时间控制」——活动未进行时写接口拦截、读接口按配置放行（提交 `ce14a95`）。
- 修改内容：新增 `_activity_guard` 工厂（`:56-75`）与 `require_activity_participation` / `require_activity_view` 两个依赖（`:79`、`:81`），拒绝时 403 + `X-Activity-Status` 头（`unpublished/not_started/ended`）；模块 docstring 增补「活动准入」相关 service 导入。
- 关联文件：`services/activity_service.py`、`models/models.py`（ActivitySetting）、`docker/init/016_activity_settings.sql`、sport/quiz/march/medal/org 各写接口路由。
- 测试结果：TestClient 冒烟通过（未发布与已结束时写接口 403、结束后可查看/不可查看两种配置、无 Token 仍 401）；`s19_invite_admission.py` 回归 25/25（`docs/迭代记录.md`）。

### 2026-10-12
- 需求：邀请码准入全链路——停用账号即时断权（提交 `afbcba9`）。
- 修改内容：新增 `_ensure_active`（`:46-53`），接入 `get_current_user`（`:42`）与 `get_current_admin`（`:141`）；停用账号所有受保护接口 403 + `X-Account-Status: disabled`，detail 复用 `auth_service.ACCOUNT_DISABLED_MESSAGE`。
- 关联文件：`docker/init/015_invite_admission.sql`、`services/invite_service.py`/`auth_service.py`/`access_service.py`、`frontend/services/request.js`（消费该响应头）。
- 测试结果：`s19_invite_admission.py` 25/25（含「停用用户 38 个受保护接口 403」）；真实 openGauss 并发 `s19_invite_concurrency_pg.py` 3/3（`docs/迭代记录.md`）。

### 2026-10-09
- 需求：微信扫码登录与身份关联（批次 2）——管理端 RBAC，授权撤销即时生效（提交 `b431e4d`）。
- 修改内容：新增 `AdminPrincipal`（`:84-106`）与 `require_menu` 工厂（`:150-160`）；`get_current_admin` 由初版「校验 `role=admin` 后直接返回 payload dict」改造为 `typ` 分支（超管/历史令牌直接放行 `:127-129`）+ `typ=user` 每请求查库、`access_service.build_principal` 重建权限（`:142-147`，无启用角色 403）；权限不写入令牌。
- 关联文件：`core/security.py`（`create_admin_token` 增 `typ=super`、新增 `create_admin_token_for_user`）、`services/access_service.py`、`docker/init/010_admin_identity.sql`、`routes/admin.py`。
- 测试结果：S8 集成测试 23/23（`backend/test/s8_identity_admin.py`，报告 `backend/test/docs/s8-identity-admin.md`）。

### 2026-10-01
- 需求：管理后台 API 首批（登录/题库/组织架构/路线节点/排名）需要管理员鉴权（提交 `337af78`）。
- 修改内容：新增 `get_current_admin` 初版——校验 `payload["role"] == "admin"` 后直接返回 payload dict，无查库、无菜单权限；docstring 更新为「数据库会话、当前登录用户、管理员身份」。
- 关联文件：`routes/admin.py`（新增）、`core/security.py`（`create_admin_token`）。
- 测试结果：待确认（`docs/迭代记录.md` 该条目未记录验证细节）。

### 2026-09-30
- 需求：项目初始化，小程序接口需要统一鉴权与会话依赖（提交 `a94e685`）。
- 修改内容：文件创建——`get_db` 重导出（`:8`）、`_bearer = HTTPBearer(auto_error=False)`、`get_current_user`（Bearer → `decode_token` → 查库 → 返回 `User`，失败分支与现行一致）。
- 关联文件：`core/database.py`、`core/security.py`、`models/models.py`。
- 测试结果：待确认（初始提交，`docs/迭代记录.md` 无验证记录）。
