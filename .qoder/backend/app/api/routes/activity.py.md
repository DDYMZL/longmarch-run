# activity.py

## 1. 文件路径

`backend/app/api/routes/activity.py`（17 行）

## 2. 文件职责

全仓库最薄的路由文件：仅 1 个公开端点 `GET /api/activity/status`，把 `activity_service.get_status` 的字典直接以 `ActivityStatusOut` 返回。无任何本文件内的逻辑——无鉴权依赖、无限流、无异常转换（`:12-16` 全部实现就一个 return）。

## 3. 业务需求

V2.0 需求一「活动时间控制」（`ce14a95`，2026-10-13，`docs/迭代记录.md:401`）。公开的动机写在路由 docstring（`:14-15`）：小程序启动页在**登录前**即需判定活动状态以决定是否进入，故不能挂 `get_current_user`；仅返回活动名称、起止时间、状态与提示文案，不含任何用户数据。

## 4. 核心功能

**1 个端点**：

| 方法+路径 | 函数 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|
| `GET /api/activity/status` | `status` | `:12-16` | **无（公开，登录前豁免，理由见 §3）** | `ActivityStatusOut` |

router 前缀 `/activity`（`:9`），`backend/app/main.py:70` 以 `/api` 挂载。返回内容由 `backend/app/services/activity_service.py:76-98` `get_status` 实时计算（**不落库**，服务器时间推导）：`name`/`status`（`unpublished`/`not_started`/`ongoing`/`ended`，`activity_service.py:22-25`）/`statusText`/`startAt`/`endAt`（北京时间 +08:00 序列化，`activity_service.py:71-73`）/`allowParticipate`/`allowView`/`restrictEnabled`/`endTitle`/`message`/`serverTime`（Schema `backend/app/schemas/schemas.py:1567-1580`）。配置行不存在（如测试库未跑迁移）时按 `ongoing` + 不限制处理（`activity_service.py:50-51`、`:63-64`、docstring `:9`）。

**与 `deps.py` 活动准入闸门的关系**：本端点是**只读状态源**，不做拦截；真正的拦截由 `backend/app/api/deps.py:56-81` `_activity_guard` 产出的 `require_activity_participation`/`require_activity_view` 挂在各业务路由上，二者共用同一套 `compute_status`/`_access` 判定（`activity_service.py:49-68`；闸门调 `check`，`:101-109`）。闸门拒绝时返回 **403 + `X-Activity-Status: unpublished|not_started|ended` 响应头**（`deps.py:66-72`），小程序 `frontend/services/request.js:87-91` 据头跳转活动状态页——即**准入判定靠响应头传递，本端点只供前端预检与活动页展示**。

## 5. 输入与输出

- 输入：无参数。
- 输出：`ActivityStatusOut`（camelCase，字段见 §4）；无错误分支（`get_status` 对本端点不抛业务异常；数据库不可用时为框架默认 500）。

## 6. 依赖关系

- 依赖：`backend/app/core/database.py`（`get_db`）、`backend/app/services/activity_service.py`、`backend/app/schemas/schemas.py`（`ActivityStatusOut`）。
- 被依赖：`backend/app/main.py:70` 注册；小程序 `frontend/services/activity.js:12-13`（请求带 `skipActivityRedirect`，避免自身被活动守卫重定向死循环），调用方为启动页 `frontend/pages/launch/launch.js:112`（登录后前置检查，**接口失败时默认放行 fail-open**，后端闸门兜底）、首页 `frontend/pages/home/home.js:166`（失败不展示横幅）、活动状态页 `frontend/pages/activity/activity.js:32`。
- 数据库表：`activity_settings`（只读，单行 id=1，`activity_service.py:20`、`:45-46`）。

## 7. 业务规则

本文件不含业务规则；状态计算与准入口径（`allow_participate` 仅 ongoing、`allow_view` 结束后取 `allow_view_after_end`、`restrict_enabled=False` 时恒放行）全部在 `backend/app/services/activity_service.py:49-68`，管理端写入口（保存/发布）在 `activity_service.py:156-204` 与 `backend/app/api/routes/admin.py`。

## 8. 修改约束

1. **不得给本端点加 `get_current_user`**：启动页在登录前调用（§3），加鉴权会把小程序启动链锁死；新增公开接口须显式说明理由（`backend/AGENTS.md` 不变量 2）。
2. 响应字段与 `frontend/services/activity.js`、活动页/启动页消费结构是 camelCase 硬契约（不变量 1），`status` 四个字符串值同时被 `X-Activity-Status` 头复用（`deps.py:71`），改值需前后端三处同步。
3. 本端点**未挂**活动闸门依赖，属有意为之（它本身就是状态的读取口）；不要把 `require_activity_view` 加到这里。

## 9. 当前实现状态

- **已实现**：端点可用，随 `ce14a95` 交付并经验证（见 §10）。
- 存在问题：无。
- 待开发：无。
- 待确认：无（本文件范围内）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/activity.py`，仅 **1 个提交**。

### 2026-10-13（`ce14a95`，10:55，`docs/迭代记录.md:401`）
- 需求：V2.0 活动时间控制。
- 修改内容：创建本文件（公开状态端点）；同批交付 `activity_settings` 迁移、`activity_service`、管理端设置/发布与审计、写接口按活动状态 403 拦截、读接口按结束后可查看配置放行、业务日期统一北京时间（提交信息）。
- 关联文件：`backend/app/services/activity_service.py`、`backend/app/api/deps.py`（`_activity_guard`）、`backend/app/api/routes/admin.py`、`docker/init/`、`frontend/services/activity.js`。
- 测试结果：见 `docs/迭代记录.md:401` 条目。
