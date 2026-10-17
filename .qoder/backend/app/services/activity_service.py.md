# activity_service.py

## 1. 文件路径

`backend/app/services/activity_service.py`（204 行）

## 2. 文件职责

活动时间控制的**唯一业务实现**：按服务器时间实时推导活动状态（未发布 / 未开始 / 进行中 / 已结束）与两种准入口径（可参与 / 可查看），对小程序输出公开状态，对管理端提供配置读写与发布开关，并作为 `api/deps.py` 活动守卫的判定内核（`backend/app/services/activity_service.py:1-10` 模块文档串）。

**状态不落库**——`activity_settings` 表只存配置（起止时间、发布位、限制开关等），状态每次请求实时计算（`:3-4`）。

## 3. 业务需求

- V2.0 需求一「活动时间控制」，由 `ce14a95`（2026-10-13 10:55）一次性交付（`docs/迭代记录.md` 的 `ce14a95` 条目）。
- 现行需求口径与规则表见 `.qoder/REQUIREMENTS.md` §1「活动时间控制与准入」（含 §1.2 前端行为、§1.3 待确认）；架构侧的准入闸门说明见 `.qoder/ARCHITECTURE.md` §5.4「活动准入闸门」。本文档不复制其正文。
- 管理端页面口径见 `.qoder/REQUIREMENTS.md` §11.4「活动配置」。
- 表结构来源：`docker/init/016_activity_settings.sql`（建表 + 单行默认配置 + `activity` 菜单，默认仅超管可见）；ORM 同步于 `backend/app/models/models.py:108-123`。

## 4. 核心功能

### 4.1 模块级常量（`activity_service.py:20-42`）

| 常量 | 行号 | 含义 |
|---|---|---|
| `SETTING_ID = 1` | `:20` | 配置为**单行**，主键固定 1（与 `docker/init/016_activity_settings.sql` 的 `INSERT ... WHERE NOT EXISTS` 一致） |
| `STATUS_UNPUBLISHED / NOT_STARTED / ONGOING / ENDED` | `:22-25` | 四个状态字符串常量，同时被复用作 `X-Activity-Status` 响应头取值（`backend/app/api/deps.py:71`） |
| `STATUS_TEXT` | `:27-32` | 状态中文文案（未发布 / 未开始 / 进行中 / 已结束） |
| `DEFAULT_NAME` | `:34` | 默认活动名「长征步迹·荣耀征程」（配置行不存在时使用） |
| `DEFAULT_END_TITLE` / `DEFAULT_END_MESSAGE` | `:35-36` | 结束标题与结束文案兜底值 |
| `_BLOCK_MESSAGE` | `:38-42` | 三种拒绝文案；**不含 `ongoing`**（进行中不会拒绝） |

### 4.2 状态与准入计算（`activity_service.py:45-73`）

- `get_setting(db)`（`:45-46`）：查 `activity_settings` 中 `id == 1` 的单行，可能为 `None`（测试库未执行 016 迁移时）。**每次调用一次 SQL，无进程内缓存。**
- `compute_status(setting, now=None)`（`:49-59`）：判定顺序为
  1. `setting is None` → **`ongoing`**（`:50-51`，兜底「不改变存量行为」）；
  2. `not setting.is_published` → `unpublished`（`:52-53`）；
  3. `now < start_at` → `not_started`（`:55-56`）；
  4. `now >= end_at` → `ended`（`:57-58`）；
  5. 否则 `ongoing`。
  `now` 缺省取 `now_utc()`（`:54`），与库内 UTC naive 时间列同口径（`backend/app/core/helpers.py:12-15`）。
- `_access(setting, status)`（`:62-68`）：
  - `setting is None` **或** `restrict_enabled == False` → 两者恒 `True`（`:63-64`，即总开关关闭时只展示状态、不拦截）；
  - 否则 `allow_participate = (status == ongoing)`（`:66`）；`allow_view = (status != ended) or allow_view_after_end`（`:67`）。
- `_bj(dt)`（`:71-73`）：把库内 UTC naive 转成**带 `+08:00` 时区**的北京时间，使 JSON 序列化的 ISO 串自带偏移，前端无歧义（依赖 `helpers.to_local`，`backend/app/core/helpers.py:33-37`）。

### 4.3 小程序公开状态 `get_status(db)`（`activity_service.py:76-98`）

一次调用 = 1 次 `get_setting` 查询。返回 11 个键（`:86-98`），由 `ActivityStatusOut`（`backend/app/schemas/schemas.py:1567-1580`，`CamelModel` → 出参 camelCase）校验：

`name` / `status` / `status_text` / `start_at` / `end_at` / `allow_participate` / `allow_view` / `restrict_enabled` / `end_title` / `message` / `server_time`。

`message` 生成逻辑（`:82-85`）：
- `status == ended` → `setting.end_message or DEFAULT_END_MESSAGE`；
- 否则 → 可参与时为 `""`，不可参与时取 `_BLOCK_MESSAGE[status]`。

注意：`ended` 分支**不判断 `restrict_enabled`**，即总开关关闭时活动结束文案仍会下发（只是不拦截请求）。

### 4.4 业务准入 `check(db, need_participate)`（`activity_service.py:101-109`）

通过返回 `None`；拒绝返回 `{"status": ..., "message": ...}`，供依赖层转 **403**（`:102` 文档串）。`:109` 的 `_BLOCK_MESSAGE.get(status, "活动当前不可访问")` 兜底分支在现实现下不可达（能拒绝的状态只有三种，均在 `_BLOCK_MESSAGE` 中）。

`is_participation_open(db)`（`:112-113`）= `check(db, True) is None`，专供 `/medal/list` 判断「是否还应发放勋章」。

**统一活动守卫**：`backend/app/api/deps.py:56-75` 的 `_activity_guard(need_participate)` 工厂产出两个依赖，`:66` 调用本文件 `check`，拒绝时抛 403 并带 `X-Activity-Status` 头（`:68-72`）：

- `require_activity_participation`（`backend/app/api/deps.py:79`，`need_participate=True`）：挂在 **8 个**产生新业务数据的端点上——`backend/app/api/routes/sport.py:32`（`POST /sport/sync`）、`:76`（`POST /sport/add`）、`backend/app/api/routes/quiz.py:31`（`POST /quiz/start`）、`:42`（`POST /quiz/answer`）、`:68`（`POST /quiz/reset`）、`backend/app/api/routes/march.py:68`（`POST /march/light-up`）、`backend/app/api/routes/medal.py:27`（`POST /medal/check`）、`backend/app/api/routes/org.py:61`（组织选择）。
- `require_activity_view`（`backend/app/api/deps.py:81`，`need_participate=False`）：挂在 **24 个**读取类端点上，分布于 `backend/app/api/routes/ai.py:56,116,131`、`march.py:28,34,40,48,57,77`、`medal.py:16`、`profile.py:15,22`、`points.py:15,27`、`org.py:45,53`、`quiz.py:25,57,62`、`rank.py:18,26`、`sport.py:25,56,65`。
- **不受活动闸门约束的用户侧路由**（仅 `get_current_user`）：`backend/app/api/routes/activity.py`（公开状态本身）、`auth.py`、`identity.py`、`persons.py:15`、`quotes.py:18`、`broadcast.py:15,22`、`ws.py`；管理端 `admin.py` / `ai_admin.py` 走 `require_menu`，同样不挂活动闸门。
- 守卫顺序：**先鉴权后判活动**（`backend/app/api/deps.py:63-64` 内层 `Depends(get_current_user)`），故无 Token 恒 401、停用账号恒 403 + `X-Account-Status`，之后才可能是活动 403。

### 4.5 管理端视图 `get_admin_view(db)`（`activity_service.py:117-128`）

在 `get_status(db)` 结果之上追加 7 个管理字段：`is_published`、`allow_view_after_end`、`end_message`、`end_title`、`updated_at`、`updated_by`、`configured`（`:127`，标记配置行是否真实存在）。出参模型 `AdminActivitySettingOut`（`backend/app/schemas/schemas.py:1583-1600`，**普通 `BaseModel` → snake_case**，管理端契约）。

`:124` 用 `""` 兜底覆盖了 `get_status` 里带 `DEFAULT_END_TITLE` 的 `end_title`，因此管理端看到的是**库内原值或空串**（便于表单回填），小程序端看到的是**兜底后的展示值**——同一字段两端语义不同，属有意设计。

本函数内 `get_setting(db)` 被调用两次（`:118` 一次、`:120` 经 `get_status` 再一次），即每次管理端读取多一次同表同主键查询。

### 4.6 写入：`update` 与 `set_published`（`activity_service.py:131-204`）

- `_ensure_setting(db)`（`:131-140`）：配置行缺失时创建 `id=1`、`name=DEFAULT_NAME`、`start_at=end_at=now`、`is_published=False` 的行，只 `db.flush()`（`:139`）**不提交**，交由调用方 `update` 统一 commit。
- `_snapshot(s)`（`:143-153`）：把 8 个字段序列化为审计用字典，时间格式化为北京时间 `YYYY-MM-DD HH:MM`（`:146-147`）。
- `update(db, data, operator, actor_type, actor_id)`（`:156-187`）：
  1. 入参时间按**北京时间**解释并截断到分钟（`:164-165`，`local_to_utc` + `replace(second=0, microsecond=0)`；`backend/app/schemas/schemas.py:1603-1612` `AdminActivitySettingUpdate` 文档串同口径）；
  2. 校验 `start >= end` → `ValueError("开始时间必须早于结束时间")`（`:166-167`）；名称去空后为空 → `ValueError("活动名称不能为空")`（`:168-170`）；
  3. 写 8 个字段 + `updated_at=now_utc()` + `updated_by=operator`（`:171-181`）；`end_title` / `end_message` 去空后为空则存 `None`（`:178-179`）；
  4. `audit_service.record(db, actor_type, actor_id, "activity.update", None, {operator, before, after})`（`:182-185`）；
  5. **`db.commit()`（`:186`）** → 变更与审计同一事务；
  6. 返回 `get_admin_view(db)`（`:187`）。
  **不修改 `is_published`**——发布是独立动作。
- `set_published(db, published, operator, actor_type, actor_id)`（`:190-204`）：配置行不存在时 `ValueError("请先保存活动配置")`（`:194-195`）；写 `is_published` + `updated_at` + `updated_by`，审计 action 按方向取 `activity.publish` / `activity.unpublish`（`:199-202`），**`db.commit()`（`:203`）** 后返回管理端视图。

## 5. 输入与输出

### 对外 HTTP 端点（4 个）

| 方法 + 路径 | 权限 | 调用点 | response_model |
|---|---|---|---|
| `GET /api/activity/status` | **公开**（登录前需判定） | `backend/app/api/routes/activity.py:12-16` | `ActivityStatusOut`（camelCase） |
| `GET /api/admin/activity` | `require_menu("activity")` | `backend/app/api/routes/admin.py:1041-1050` | `AdminActivitySettingOut`（snake_case） |
| `PUT /api/admin/activity` | `require_menu("activity")` | `backend/app/api/routes/admin.py:1053-1069` | 同上 |
| `POST /api/admin/activity/publish` | `require_menu("activity")` | `backend/app/api/routes/admin.py:1072-1088` | 同上 |

`activity` 菜单码由 `docker/init/016_activity_settings.sql` 写入 `admin_menus`，**默认只有超管可用**（超管在 `backend/app/api/deps.py:105-106` `has_menu` 中恒放行）。

### 错误码

| 场景 | 状态码 | 来源 |
|---|---|---|
| 活动未发布 / 未开始 / 已结束（且限制开启）访问受守卫端点 | **403** + `X-Activity-Status: <状态>` | `backend/app/api/deps.py:66-72` |
| 无 Token / Token 无效 | 401（优先于活动 403） | `backend/app/api/deps.py:22-30` |
| 账号停用 | 403 + `X-Account-Status: disabled`（优先于活动 403） | `backend/app/api/deps.py:46-53` |
| `PUT /api/admin/activity` 时间/名称非法 | **400**（`ValueError` → `HTTPException`） | `backend/app/api/routes/admin.py:1068-1069` |
| `POST /api/admin/activity/publish` 配置行不存在 | **400**，detail「请先保存活动配置」 | `backend/app/api/routes/admin.py:1087-1088` |
| `PUT /api/admin/activity` 时间格式非法 | **422**（Pydantic 校验，早于 service） | `backend/app/schemas/schemas.py:1603-1612` |

本服务**只抛 `ValueError`**，不直接抛 `HTTPException`（符合 `backend/AGENTS.md` §5「异常」约定）。

## 6. 依赖关系

- **依赖**：标准库 `datetime`、`typing`；`sqlalchemy.orm.Session`；`backend/app/core/helpers.py`（`BEIJING_TZ`、`local_to_utc`、`now_utc`、`to_local`，`:16`）；`backend/app/models/models.py`（`ActivitySetting`，`:17`）；`backend/app/services/audit_service.py`（`:18`）。**不依赖任何其他 service**。
- **数据库表**：`activity_settings`（读写，单行 `id=1`）；经 `audit_service` 间接写 `audit_logs`。
- **被依赖**：
  - `backend/app/api/deps.py:11`（import）、`:66`（`check`）→ 32 个业务端点的活动闸门；
  - `backend/app/api/routes/activity.py:7`、`:16`（`get_status`）；
  - `backend/app/api/routes/medal.py:10`、`:18`（`is_participation_open`，决定 `/medal/list` 是否顺带发放勋章）；
  - `backend/app/api/routes/admin.py:83`、`:1050`、`:1065`、`:1084`。
- **审计动作码**：`activity.update` / `activity.publish` / `activity.unpublish`，管理端中文映射见 `admin/src/views/AuditView.vue:62-64`。
- **前端消费**：`frontend/services/activity.js:13`（请求带 `skipActivityRedirect` 防自身被守卫重定向）；调用方 `frontend/pages/launch/launch.js:16`、`frontend/pages/home/home.js:15`、`frontend/pages/activity/activity.js:6`。管理端 `admin/src/api/admin.ts:341,345,349`。

## 7. 业务规则

1. **状态实时计算、不落库**：改服务器时间或改配置立即生效，无需重启、无缓存失效问题（`:3-4`）。代价是**每个受守卫的请求都多一次 `activity_settings` 单行查询**（`get_setting:45-46` 无缓存）。
2. **准入口径**：`allow_participate` 仅 `ongoing` 为真；`allow_view` 未结束恒真、结束后取 `allow_view_after_end`（`:62-68`）。
3. **总开关优先**：`restrict_enabled=False` → 两者恒真，只展示状态不拦截（`:63-64`）。
4. **配置缺失即「不限制」**：`setting is None` 时状态视为 `ongoing` 且准入全放行（`:50-51`、`:63`），保证未跑 016 迁移的测试库行为不变。
5. **时间口径**：库内 `start_at`/`end_at`/`updated_at` 为 **UTC naive**（`backend/app/models/models.py:109`）；管理端入参与对外出参一律**北京时间**（入参 `:164-165` 转 UTC，出参 `:71-73` 转 +08:00）；精确到分钟（秒/微秒被截断）。
6. **发布与保存解耦**：`update` 不动 `is_published`；未保存过配置就不能发布（`:194-195`）。
7. **审计与变更同事务**：`audit_service.record` 只 `db.add` 不提交（`backend/app/services/audit_service.py:3-4`），由本服务在 `:186` / `:203` 统一 commit，保证「变更 + 审计」原子落库。审计 `detail` 携带 `before` / `after` 全量快照（`:184`）。
8. **`updated_by` 存的是管理员用户名字符串**（`backend/app/api/routes/admin.py:1066`、`:1085` 传 `admin.username`），不是 user_id；`actor_type`/`actor_id` 另由 `_actor` 给出（`backend/app/api/routes/admin.py:752-754`：超管 `("super", None)`，微信关联管理员 `("user", user_id)`）。
9. **与积分/勋章无耦合**：本服务不发放任何积分，只做时间闸门。

## 8. 修改约束

1. **不得把状态落库或加进程内长缓存**：状态与「服务器当前时间」强绑定，缓存会导致管理端改配置后不即时生效（`.qoder/REQUIREMENTS.md` §1.1「状态计算」）。
2. **四个状态字符串是跨端硬契约**：同时用于 `ActivityStatusOut.status`、`X-Activity-Status` 响应头（`backend/app/api/deps.py:71`）与小程序跳转判定（`frontend/services/request.js`），改值需后端 2 处 + 小程序 1 处同步。
3. **`GET /api/activity/status` 不得加鉴权**：小程序启动页在登录前调用（`backend/app/api/routes/activity.py:14-15`）；新增公开接口须显式说明理由（`backend/AGENTS.md` §4 不变量 2）。
4. **`setting is None` 的兜底分支不得删除**：未执行 016 迁移的库依赖它保持「不限制」（`:9` 模块文档串）。
5. **不得在 `docker/init/016_activity_settings.sql` 上改已执行过的脚本**（`.qoder/README.md` §3.7、`docker/init/SQL_CONSTRAINTS.md`）；调整默认活动时间须新增编号迁移。
6. **管理端出参保持 snake_case、小程序出参保持 camelCase**（`.qoder/ARCHITECTURE.md` §4.2 双命名契约）；`AdminActivitySettingOut` 继承 `BaseModel` 而非 `CamelModel`，不要「顺手统一」。
7. **新增受活动时间约束的端点时必须显式选守卫**（participation / view），漏挂即绕过闸门；反之不要给 `persons` / `quotes` / `broadcast` 这类内容型只读接口盲目加闸门（当前有意未加）。
8. **审计 action 码新增时同步 `admin/src/views/AuditView.vue` 的 `ACTION_TEXT`**，否则管理端显示原始码。

## 9. 当前实现状态

- **已实现**：状态实时计算、双准入口径、总开关、配置缺失兜底、公开状态端点、管理端读写与发布、变更审计、北京时间口径统一。随 `ce14a95` 交付并经验证（见 §10）。
- **存在问题（事实性陈述）**：
  1. **每请求一次配置查询**：32 个受守卫端点每次调用都会执行 `get_setting`（`:45-46`），无缓存。单行主键查询开销小，但在高频接口（如 `/sport/sync`）上是固定的额外一次往返。
  2. `get_admin_view` 内 `get_setting` 被调用两次（`:118` 与 `:120`→`:78`）。
  3. `status == ended` 时 `message` 不判断 `restrict_enabled`（`:82-83`），总开关关闭仍下发结束文案；`allow_participate`/`allow_view` 仍为 `True`，故只是文案层面的表现差异，不影响放行。
  4. `:109` 的 `_BLOCK_MESSAGE.get(..., "活动当前不可访问")` 兜底文案在现实现下不可达（死分支）。
- **待开发**：无。
- **待确认**：
  - 生产库 `activity_settings` 的实际 `start_at`/`end_at`/`is_published` 值属运行时数据，不在仓库中（`.qoder/REQUIREMENTS.md` §1.3 已列为待确认）。
  - `backend/app/core/config.py` 的 `ACTIVITY_START_DATE`（默认 `2026-09-01`）**只用于答题「第 N 期」计算**（`backend/app/services/quiz_service.py:53`），与本表 `start_at` 无联动；两者是否应保持一致——待确认。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/services/activity_service.py`（**仅 1 个提交**）与 `docs/迭代记录.md` 的 `ce14a95` 条目（2026-10-13「V2.0 需求一：活动时间控制（后端）」）。`docs/迭代记录.md` 按倒序在文件头追加新条目、行号会整体漂移，故本章统一按**提交哈希 + 日期标题**定位，不写行号。

### 2026-10-13（`ce14a95`，10:55，范围 backend、docker）
- 需求：V2.0 需求一「活动时间控制」。
- 修改内容：新建本文件——按服务器时间实时算出四态与「可参与 / 可查看」两种准入；配套交付 `docker/init/016_activity_settings.sql`（单行表 + 默认进行中配置 + `activity` 菜单默认仅超管）、公开接口 `GET /api/activity/status`、管理端 `GET/PUT /api/admin/activity` 与 `POST /api/admin/activity/publish`（变更与审计同一事务）、依赖 `require_activity_participation` / `require_activity_view`（写接口未进行时 403 + `X-Activity-Status`，读接口结束后按配置放行，`/medal/list` 不可参与时只读不发放）；同批把 `helpers` 业务日期改为固定 UTC+8（同上条目「内容」）。
- 关联文件：`backend/app/api/deps.py`、`backend/app/api/routes/activity.py`、`backend/app/api/routes/admin.py`、`backend/app/api/routes/medal.py`、`backend/app/models/models.py:108-123`、`backend/app/schemas/schemas.py:1567-1616`、`backend/app/core/helpers.py`、`docker/init/016_activity_settings.sql`、`frontend/services/activity.js`。
- 测试结果：`docs/迭代记录.md` 的 `ce14a95` 条目「验证」原文——「TestClient 冒烟通过：默认状态、时间格式错误 422、开始晚于结束 400、未发布与已结束时写接口 403、结束后可查看与不可查看两种配置、无 Token 仍返回 401」；「`s19_invite_admission.py` 回归 25/25 通过」。
