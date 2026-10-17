# schemas.py

## 1. 文件路径

`backend/app/schemas/schemas.py`（1858 行，201 个 `class` 定义，其中 1 个是基类 `CamelModel`）

> 行尾为 **CRLF**（实测 1858 处 `\r\n`），与 `backend/app/` 下多数 LF 文件不同；编辑时注意不要混入两种行尾。

## 2. 文件职责

全后端 **HTTP API 请求/响应契约的唯一来源**。所有路由的 `response_model` 与请求体类型都在这里声明，服务层不重复定义 DTO。它同时承载三件事：

1. **命名风格转换**——小程序侧输出 camelCase、管理端输出 snake_case，靠两个不同基类实现（见 §7.1）；
2. **字段级校验**——请求模型上的 `Field` 约束与 9 个 `field_validator`；
3. **对外字段裁剪**——题目答案/解析、`openid`、`user_id`、AI 密钥等敏感或内部字段按调用方分别开放（见 §7.2）。

模块 docstring（`:1-7`）明确了「响应模型继承 `CamelModel`、字段与前端 mock 返回结构完全一致」这一原始设计意图。

**本文件不含任何业务逻辑**：无数据库查询、无 service 调用、无路由，只有数据形状与校验规则。

## 3. 业务需求

- `backend/AGENTS.md` §2 技术栈：「数据校验 = Pydantic v2，响应模型统一继承 `CamelModel`」；§3.1 分层规则：「schemas 层是 API 契约，所有响应必须声明 `response_model`，禁止路由直接返回裸 dict/ORM 对象」；§4 架构不变量 1「camelCase 输出契约」。
- `.qoder/ARCHITECTURE.md` §4.2「双命名契约」与 §14 不变量 6：小程序 camelCase / 管理端 snake_case，**不是**靠全局配置切换，而是两套并存的 Schema。
- 类 docstring 中直接引用的需求编号（均为文件内原文，可逐条核对）：§4.3/4.4 章节系统（`:240`）、§7 我的长征足迹（`:395`、`:407`）、§8.5 实时行军动态（`:714`）、§9 同组织同行者（`:762`、`:771`）、§10 组织共同长征目标（`:780`、`:790`）、§11 全员共同目标（`:369`、`:385`）、§14.2 人物志（`:321`）、§16 每日寄语（`:338`、`:1073`）、§17.2/17.3 数据画像（`:655`）、§20.4 完成仪式（`:277`）、V1.1 功能二 寄语循环（`:338`、`:1073`、`:1090`）、V1.1 Excel 批量导入（`:1114`）、V2.0 需求一 活动时间控制（`:1566`）、V1.0 AI 智能中心（`:1619`）。

## 4. 核心功能

### 4.1 `CamelModel` 基类（`:17-22`）

```python
model_config = ConfigDict(
    alias_generator=to_camel, populate_by_name=True, from_attributes=True
)
```

三项配置的作用：

| 配置 | 效果 |
|---|---|
| `alias_generator=to_camel` | 每个字段自动生成 camelCase 别名（`total_steps` → `totalSteps`）。FastAPI 序列化 `response_model` 时默认 `by_alias=True`，故**输出恒为 camelCase** |
| `populate_by_name=True` | 构造/校验时**别名与字段名都接受**，因此 service 层可以直接传 snake_case 的 dict 或 ORM 对象 |
| `from_attributes=True` | 允许 `Model.model_validate(orm_obj)` 直接从 ORM 实例读取属性 |

`to_camel` 来自 `pydantic.alias_generators`（`:12`）。实测（pydantic 2.13.4 / fastapi 0.141.1）：`BroadcastTodayOut` 序列化为 `{"global": {...}, "personal": {...}, "memory": null}`，嵌套字段全部 camelCase。

### 4.2 分节清单（按文件内注释 banner 划分）

「顶层」= 被路由直接用作 `response_model` 或请求体的类；其余为**仅被同文件其他 schema 作为字段类型引用的内嵌子模型**。实测：**201 个类中没有任何一个完全无引用**（要么被路由引用，要么被同文件其他类引用），本文件无死代码。

| banner 行 | 分节 | 类行号范围 | 类数 | `CamelModel` 子类 | 普通 `BaseModel` | 顶层类的 `response_model` 归属（路由前缀见 `ARCHITECTURE.md` §2.2） |
|---|---|---|---|---|---|---|
| `:1-15` | 模块 docstring + import | — | 0 | — | — | — |
| — | `CamelModel` 基类 | `:17-22` | 1 | （基类本身） | 1 | — |
| `:25` | 鉴权 / 用户 | `:26-88` | 8 | 4 | 4 | `LoginResponse`→`POST /api/auth/login`；`InviteVerifyOut`→`POST /api/auth/invite/verify`；`OnboardResponse`→`POST /api/auth/onboard`；`UserOut`→`GET /api/auth/me`、`PUT /api/auth/nickname`、`PUT /api/auth/nickname/initial` |
| `:91` | 身份关联 / 扫码确认 | `:92-129` | 5 | 3 | 2 | `QrInfoOut`→`POST /api/auth/qr/info`；`List[IdentityOut]`→`GET /api/auth/identities` |
| `:132` | 运动 | `:133-205` | 9 | 8 | 1 | `SportToday`→`GET /api/sport/today`、`POST /api/sport/add`；`SportSync`→`POST /api/sport/sync`；`List[RecentItem]`→`GET /api/sport/recent`；`SportCalendarOut`→`GET /api/sport/calendar` |
| `:208` | 长征路线 | `:209-409` | 20 | 20 | 0 | `RouteNodeConfigListOut`→`GET /api/march/route-nodes`；`RouteOut`→`GET /api/march/route`；`GlobalGoalOut`→`GET /api/march/global`；`FootprintsOut`→`GET /api/march/footprints`；`NodeDetailOut`→`GET /api/march/node/{node_id}`；`LightUpResult`→`POST /api/march/light-up`；`PersonDetailOut`→`GET /api/persons/{person_id}`；`QuoteTodayOut`→`GET /api/quotes/today` |
| `:412` | 答题 | `:413-532` | 12 | 11 | 1 | `QuizDailyOut`→`GET /api/quiz/daily`、`POST /api/quiz/start`；`QuizAnswerOut`→`POST /api/quiz/answer`；`List[QuizRecordOut]`→`GET /api/quiz/records`；`QuizKnowledgeOut`→`GET /api/quiz/knowledge` |
| `:535` | 积分 | `:536-569` | 4 | 4 | 0 | `PointsSummaryOut`→`GET /api/points`；`PointsDailyOut`→`GET /api/points/daily` |
| `:572` | 勋章 | `:573-592` | 3 | 3 | 0 | `MedalListOut`→`GET /api/medal/list`；`MedalGrantResult`→`POST /api/medal/check` |
| `:595` | 个人档案 / 足迹 | `:596-681` | 11 | 11 | 0 | `ProfileSummaryOut`→`GET /api/profile/summary`；`ProfileTimelineOut`→`GET /api/profile/timeline` |
| `:684` | 今日播报 | `:685-724` | 6 | 6 | 0 | `BroadcastTodayOut`→`GET /api/broadcast/today`；`ActivitiesOut`→`GET /api/broadcast/activities` |
| `:727` | 通用 | `:728-729` | 1 | 1 | 0 | `MessageOut`：全项目通用「操作成功」响应，被 `admin.py`、`ai.py`、`ai_admin.py`、`identity.py`、`quiz.py` 共 23 处 `response_model` 使用 |
| `:732` | 组织架构 | `:733-807` | 9 | 8 | 1 | `OrgChildrenOut`→`GET /api/org/children`；`UserOrgOut`→`GET /api/org/mine`、`POST /api/org/select`；`OrgCompanionsOut`→`GET /api/org/companions`；`OrgMarchOut`→`GET /api/org/march` |
| `:810` | 排名 | `:811-845` | 3 | 3 | 0 | `PointsRankOut`→`GET /api/rank/points`；`RankListOut`→`GET /api/rank/steps`（路由 summary 自述「旧版契约」） |
| `:848` | 管理后台（登录 / 扫码 / 邀请码 / 当前管理员） | `:849-957` | 14 | 0 | 14 | `AdminLoginOut`→`POST /api/admin/login`；`AdminQrCreateOut`→`POST /api/admin/wechat/qr`；`AdminQrStatusOut`→`GET /api/admin/wechat/qr/{qr_id}/status`；`AdminMeOut`→`GET /api/admin/me`；`AdminInviteOut`/`AdminInviteListOut`→`/api/admin/invites*`；`AdminInviteQrOut`→`GET /api/admin/invites/{invite_id}/qrcode` |
| `:960` | 人员授权 / 角色 / 审计 **+ 题库 / 寄语（`:1030-1111`，无独立 banner）** | `:961-1111` | 19 | 0 | 19 | `AdminUserListOut`→`GET /api/admin/users`；`AdminRoleOut`/`AdminRoleListOut`→`/api/admin/roles*`；`AdminAuditLogListOut`→`GET /api/admin/audit-logs`；`AdminQuestionOut`/`AdminQuestionListOut`→`/api/admin/questions*`；`AdminQuoteOut`/`AdminQuoteListOut`/`AdminQuoteCycleOut`→`/api/admin/quotes*` |
| `:1114` | 管理端 Excel 批量导入（V1.1） | `:1115-1138` | 4 | 0 | 4 | `AdminImportPreviewOut`→`POST /api/admin/questions/import-preview`、`POST /api/admin/quotes/import-preview`；`AdminImportConfirmOut`→两个 `import-confirm` |
| `:1141` | 管理端 AI 智能出题（不入库版） | `:1142-1195` | 6 | 0 | 6 | `AdminAiGenerateOut`→`POST /api/admin/ai/generate-questions`；`AdminAiBatchSaveOut`→`POST /api/admin/ai/questions/batch-save` |
| `:1198` | 管理端驾驶舱 / 大屏（banner 名义范围，实际含 4 个子域，见下） | `:1199-1560` | 35 | 0 | 35 | 见下方拆分 |
| — | `AdminOrgNodeOut.model_rebuild()` | `:1563` | — | — | — | 见 §4.4 |
| `:1566` | 活动时间控制（V2.0 需求一） | `:1567-1616` | 4 | 1 | 3 | `ActivityStatusOut`→`GET /api/activity/status`（**公开接口，无鉴权**）；`AdminActivitySettingOut`→`GET/PUT /api/admin/activity`、`POST /api/admin/activity/publish` |
| `:1619` | AI 智能中心（V1.0，小程序契约） | `:1621-1703` | 9 | 8 | 1 | `AiChatOut`→`POST /api/ai/chat`；`AiConversationListOut`→`GET /api/ai/conversations`；`AiConversationDetailOut`→`GET /api/ai/conversations/{id}`；`AiRouteGuideOut`→`GET /api/ai/route-guide/{node_id}`；`AiQuizExplanationOut`→`GET /api/ai/quiz-explanation/{question_id}` |
| `:1706` | 管理端 AI 智能中心契约 | `:1707-1858` | 18 | 0 | 18 | `AdminAiKnowledgeOut`/`ListOut`→`/api/admin/ai/knowledge*`；`AdminAiJobOut`/`JobListOut`→`/api/admin/ai/jobs*`；`AdminAiDraftOut`/`DraftListOut`→`/api/admin/ai/drafts*`；`AdminAiImportOut`→`POST /api/admin/ai/drafts/import`；`AdminAiConfigOut`→`GET/PATCH /api/admin/ai/config` |
| | **合计** | | **201** | **91**（+ 基类 1） | **109** | |

`:1198` banner 下的 35 个类实际横跨 4 个子域，banner 名已滞后于内容：

| 子域 | 行号范围 | 类数 | 顶层类 |
|---|---|---|---|
| 驾驶舱 / 数据大屏 | `:1199-1263` | 8 | `AdminDashboardOut`→`GET /api/admin/dashboard`；`AdminTrendOut`→`GET /api/admin/dashboard/trend`；`AdminActivityListOut`→`GET /api/admin/activities`；`AdminScreenOut`→`GET /api/admin/screen` |
| 组织架构管理 | `:1266-1325` | 6 | `AdminOrgTreeOut`→`GET /api/admin/orgs`；`AdminOrgNodeOut`→`POST/PUT /api/admin/orgs*`；`AdminOrgUserListOut`→`GET /api/admin/orgs/{org_id}/users`；`AdminOrgSyncOut`→`POST /api/admin/orgs/sync` |
| 路线节点管理 | `:1328-1388` | 4 | `AdminRouteNodeListOut`→`GET /api/admin/route-nodes`；`AdminRouteNodeOut`→`POST/PUT/PATCH /api/admin/route-nodes*` |
| 排名洞察 / 人员详情 / 积分核对 | `:1391-1560` | 17 | `AdminRankListOut`→`GET /api/admin/rankings`；`AdminUserOverviewOut`→`GET /api/admin/users/{user_id}/overview`；`AdminPointsVerifyOut`→`POST /api/admin/points/verify` |

### 4.3 校验器清单（9 个 `field_validator`，**0 个 `model_validator`**）

全文件没有任何跨字段校验器，即**无法在 schema 层表达「A 与 B 必须同时成立」这类规则**；这类规则（如活动 `start_at < end_at`）落在 service 层。

| 行号 | 所属类 | 字段 | mode | 作用 |
|---|---|---|---|---|
| `:33-36` | `UserOut` | `avatar` | `before` | `None` → `""` |
| `:603-606` | `ProfileUser` | `avatar` | `before` | 同上 |
| `:823-826` | `RankItem` | `avatar` | `before` | 同上 |
| `:1315-1318` | `AdminOrgUserOut` | `avatar` | `before` | 同上 |
| `:1417-1420` | `AdminRankItemOut` | `avatar` | `before` | 同上 |
| `:907-910` | `_InviteExpiry` | `expires_at` | 默认（`after`） | 调 `core/helpers.local_to_utc` 把北京时间入参归一为 UTC naive；`None` 透传 |
| `:1049-1052` | `AdminQuestionOut` | `category` | `before` | `None` → `""`（`questions.category` 可空，见 `models/models.py:141`） |
| `:1349-1355` | `AdminRouteNodeOut` | `brief`/`significance`/`figures`/`location`/`audio`/`keywords` 六字段 | `before` | `None` → `""`；docstring `:1354` 给出原因「本库空串按 NULL 存储（Oracle 兼容）」 |
| `:1357-1360` | `AdminRouteNodeOut` | `images` | `before` | `None` → `[]` |

**5 处 `empty_avatar` 是完全相同的三行代码，在 5 个类中重复**。根因是 `users.avatar` 可空（`models/models.py:193`，由 `docker/init/003_optional_user_avatar.sql` 放开 `NOT NULL`），而 schema 侧声明为非 Optional 的 `avatar: str`，必须在 `before` 阶段兜住 `None`。按仓库根 `agents.md` §2.2「拒绝冗余代码」，这 5 处可抽为一个共享 mixin，属**已识别但未处理的技术债**（见 §9）。

### 4.4 需要特别留意的构造

| 位置 | 构造 | 说明 |
|---|---|---|
| `:1279` + `:1563` | `children: List["AdminOrgNodeOut"]` 字符串前向引用 + 文件中部调用 `AdminOrgNodeOut.model_rebuild()` | 全文件唯一的自引用递归模型（组织树）。`model_rebuild()` 写在 `:1563`（`AdminUserOverviewOut` 之后、活动时间分节之前），**不在文件末尾**；在其之前引用 `AdminOrgNodeOut` 字段的路径不受影响，但**任何在 `:1563` 之前触发的序列化都依赖 Pydantic 的隐式构建** |
| `:708` | `global_: BroadcastGlobal = Field(alias="global", default_factory=BroadcastGlobal)` | `global` 是 Python 关键字，字段名加尾下划线并显式指定别名。实测输出键为 `"global"` |
| `:354` | `LightUpNodeOut(RouteNodeOut)` | 全文件仅有的 2 处 schema 间继承之一：在 `RouteNodeOut` 上追加 `gained_points`/`lit_at`/`next_node` |
| `:615` | `ProfileNextNode(ProfileNodeRef)` | 另一处继承：追加 `remain` |
| `:913`、`:920` | `AdminInviteCreate(_InviteExpiry)`、`AdminInviteUpdate(_InviteExpiry)` | 唯一的私有基类复用（`_InviteExpiry` 带下划线前缀，`:902-910`），用于把 `expires_at` 的时区换算共享给创建与更新两个请求体 |
| `:1699` | `AiQuizExplanationOut.options: List[AdminQuestionOption]` | **camelCase 契约复用了 `Admin*` 命名的 snake_case 模型**。当前安全仅因 `AdminQuestionOption`（`:1030-1034`）的两个字段 `label`/`text` 都是单词、camelCase 与 snake_case 同形；实测输出 `{"label": ..., "text": ...}`。若给该模型加多词字段，小程序侧会拿到 snake_case |
| `quotes.py:17` | `response_model=Optional[QuoteTodayOut]` | 全项目唯一可空的 `response_model`：无启用寄语时响应体就是 JSON `null` |
| `identity.py:91`、`quiz.py:56`、`sport.py:53` | `response_model=List[...]` | 3 处直接以裸 `List[X]` 作为响应模型，**不遵循 `ARCHITECTURE.md` §4.4 的 `{total, items}` 分页结构**（均为全量拉取的小数据量接口） |

## 5. 输入与输出

### 5.1 请求模型的三种别名机制（不一致，新增时须先选对）

小程序侧入参是 camelCase，管理端是 snake_case。文件内**并存三种写法**：

| 机制 | 类数 | 类清单（行号） |
|---|---|---|
| A. 普通 `BaseModel` + `ConfigDict(populate_by_name=True)` + 逐字段 `Field(alias="camelCase")` | 9 | `LoginRequest:39`、`InviteVerifyRequest:55`、`OnboardRequest:69`、`NicknameUpdateRequest:85`、`QrInfoRequest:92`、`QrConfirmRequest:114`、`AddStepsRequest:202`、`QuizAnswerRequest:528`、`SelectOrgRequest:804`（其中 `LoginRequest`/`AddStepsRequest` 的字段全是单词，无需别名） |
| B. 直接继承 `CamelModel`（自动全字段 camelCase 别名 + `from_attributes`） | 1 | `SportSyncRequest:164`（**全文件唯一把 `CamelModel` 用作请求体的类**） |
| C. 普通 `BaseModel` + `ConfigDict(alias_generator=to_camel, populate_by_name=True)`（不带 `from_attributes`） | 1 | `AiChatRequest:1630`，docstring `:1633` 自述理由「小程序以 camelCase 传参，故启用 to_camel 别名」 |
| D. 无任何 `model_config`（snake_case 进出） | 其余全部 | 所有 `Admin*` 请求体，如 `AdminLoginRequest:849`、`AdminRouteNodeUpsert:1368`、`AdminAiJobCreateRequest:1783` |

实测 B 与 C 均能接受 camelCase 入参（`{"encryptedData": "x"}`、`{"conversationId": 3}`），且因 `populate_by_name=True` 也接受 snake_case。

### 5.2 请求体 → 路由绑定全量（46 处，实测提取）

**小程序侧（11 个模型）**：`LoginRequest`→`POST /auth/login`；`InviteVerifyRequest`→`POST /auth/invite/verify`；`OnboardRequest`→`POST /auth/onboard`；`NicknameUpdateRequest`→`PUT /auth/nickname` 与 `PUT /auth/nickname/initial`；`QrInfoRequest`→`POST /auth/qr/info`；`QrConfirmRequest`→`POST /auth/qr/confirm`；`SelectOrgRequest`→`POST /org/select`；`QuizAnswerRequest`→`POST /quiz/answer`；`SportSyncRequest`→`POST /sport/sync`；`AddStepsRequest`→`POST /sport/add`；`AiChatRequest`→`POST /ai/chat`。

**管理端（27 个模型）**：`AdminLoginRequest`→`POST /admin/login`；`AdminRouteNodeUpsert`→`POST /admin/route-nodes`、`PUT /admin/route-nodes/{node_id}`；`AdminRouteNodeEnabled`→`PATCH /admin/route-nodes/{node_id}/enabled`；`AdminPointsVerifyRequest`→`POST /admin/points/verify`；`AdminQuestionUpsert`→`POST /admin/questions`、`PUT /admin/questions/{question_id}`；`AdminImportConfirmRequest`→`POST /admin/questions/import-confirm`、`POST /admin/quotes/import-confirm`；`AdminAiGenerateRequest`→`POST /admin/ai/generate-questions`；`AdminAiBatchSaveRequest`→`POST /admin/ai/questions/batch-save`；`AdminQuoteCycleUpdate`→`PUT /admin/quotes/cycle`；`AdminQuoteUpsert`→`POST /admin/quotes`、`PUT /admin/quotes/{quote_id}`；`AdminOrgUpsert`→`POST /admin/orgs`、`PUT /admin/orgs/{org_id}`；`AdminUserStatusRequest`→`PATCH /admin/users/{user_id}/status`；`AdminUserOrgRequest`→`PUT /admin/users/{user_id}/org`；`AdminInviteCreate`→`POST /admin/invites`；`AdminInviteUpdate`→`PATCH /admin/invites/{invite_id}`；`AdminRoleUpsert`→`POST /admin/roles`、`PUT /admin/roles/{role_id}`；`AdminUserRolesRequest`→`POST /admin/users/{user_id}/roles`；`AdminRoleEnabledRequest`→`PATCH /admin/users/{user_id}/roles/{role_id}/enabled`；`AdminActivitySettingUpdate`→`PUT /admin/activity`；`AdminActivityPublishRequest`→`POST /admin/activity/publish`；`AdminAiKnowledgeUpsert`→`POST /admin/ai/knowledge`、`PUT /admin/ai/knowledge/{kid}`；`AdminAiKnowledgeStatusRequest`→`PATCH /admin/ai/knowledge/{kid}/status`；`AdminAiJobCreateRequest`→`POST /admin/ai/jobs`；`AdminAiDraftUpdateRequest`→`PUT /admin/ai/drafts/{draft_id}`；`AdminAiDraftStatusRequest`→`PATCH /admin/ai/drafts/{draft_id}/status`；`AdminAiImportRequest`→`POST /admin/ai/drafts/import`；`AdminAiConfigPatchRequest`→`PATCH /admin/ai/config`。

### 5.3 `Field` 约束全量（校验失败一律 → HTTP 422）

| 行号 | 类.字段 | 约束 |
|---|---|---|
| `:58`、`:73` | `InviteVerifyRequest.invite_code`、`OnboardRequest.invite_code` | `max_length=64` |
| `:74`、`:88` | `OnboardRequest.nickname`、`NicknameUpdateRequest.nickname` | `min_length=1, max_length=64` |
| `:76` | `OnboardRequest.avatar` | `max_length=500`，默认 `""` |
| `:95`、`:117` | `QrInfoRequest.scene`、`QrConfirmRequest.scene` | `min_length=1, max_length=64` |
| `:118` | `QrConfirmRequest.action` | `pattern="^(confirm\|cancel)$"` |
| `:205` | `AddStepsRequest.delta` | `ge=0`，默认 `0` |
| `:532` | `QuizAnswerRequest.answer` | `default_factory=list, max_length=4`（对应最多 4 个选项） |
| `:914-917` | `AdminInviteCreate` | `name` `min_length=1, max_length=64`；`remark` `max_length=200`；`max_uses` `ge=1` |
| `:923-926` | `AdminInviteUpdate` | 同上但全部 `Optional`，docstring `:921` 说明「只处理请求中显式出现的字段，传 null 表示清空」 |
| `:931` | `AdminUserStatusRequest.status` | `pattern="^(active\|disabled)$"` |
| `:1001` | `AdminRoleUpsert.name` | `min_length=1, max_length=32` |
| `:1150` | `AdminAiGenerateRequest.count` | `Field(10, ge=1, le=100)` |
| `:1369-1384` | `AdminRouteNodeUpsert` 12 个字段 | `name` 1–50；`icon` ≤16；`target_steps` `ge=0`；`historical_time` ≤50；`latitude` `-90~90`；`longitude` `-180~180`；`sort_order` `ge=0`；`brief` ≤200；`figures` ≤500；`location` ≤100；`audio` ≤500；`keywords` ≤200 |
| `:1606-1612` | `AdminActivitySettingUpdate` | `name` 1–64；`end_title` ≤64；`end_message` ≤500；`start_at`/`end_at` 为**必填** `datetime` |
| `:1638` | `AiChatRequest.message` | `min_length=1, max_length=500` |
| `:1710-1712` | `AdminAiKnowledgeUpsert` | `title` 1–200；`content` `min_length=1`；`source` ≤300 |
| `:1786-1791` | `AdminAiJobCreateRequest` | `topic` 1–100；`count` `Field(10, ge=1, le=100)`；`extra_requirements` ≤300 |
| `:1846` | `AdminAiImportRequest.draft_ids` | `List[int] = Field(min_length=1)`（至少一条） |

**校验失败的响应形状**（实测，`OnboardRequest` + `nickname=""`）：状态码 **422**，响应体为 FastAPI 默认的
`{"detail": [{"type": "string_too_short", "loc": ["body","nickname"], "msg": "String should have at least 1 character", "input": "", "ctx": {"min_length": 1}}]}`。
后端**无自定义异常处理器**（`ARCHITECTURE.md` §2.1），故该形状不可配置。小程序侧 `services/request.js` 的 `errorMessage()` 会把数组形式的 `detail` 逐项取 `msg` 用「；」拼接后展示。

> **文档缺口**：422 未出现在 `ARCHITECTURE.md` §4.3 的状态码表中（该表只列 200/400/401/403/404/429/502）。

### 5.4 输出侧约定

- **无响应信封**：2xx 响应体即 schema 序列化结果本身（`ARCHITECTURE.md` §4.1、不变量 7）。
- **可选字段默认值约定**（`backend/AGENTS.md` §5「Schema 声明」）：`Optional[X] = None`、`List[X] = []`、标量给业务零值（`int = 0`、`str = ""`、`bool = False`）。Pydantic v2 会对可变默认值做逐实例拷贝，实测 `= []`、`= ProfilePortrait()`（`:670`）、`= BroadcastPersonal()`（`:709`）**不存在跨实例共享状态问题**；但与同文件 `default_factory=list`（`:532`）、`default_factory=BroadcastGlobal`（`:708`）两种写法并存，属风格不统一。
- **必填 vs 可选**：聚合类顶层模型（如 `PointsSummaryOut:542`、`ProfileSummaryOut:664`）的核心字段刻意不给默认值（`total`/`walk`/`quiz`/`rules`），service 漏传即 500 而非静默输出 0；扩展字段给默认值以保持向后兼容（如 `RouteOut` 的 `chapters`/`current_chapter_id`/`ceremony_pending`，`:275-278`）。
- **时间字段的三套形态**（详见 §7.3）。

## 6. 依赖关系

### 6.1 上游依赖（`:8-14`）

仅 4 项，全部为叶子依赖：标准库 `datetime`、`typing`；`pydantic`（`BaseModel`、`ConfigDict`、`Field`、`field_validator`）与 `pydantic.alias_generators.to_camel`；项目内**只 import 一个符号**——`app.core.helpers.local_to_utc`（`:14`，仅被 `_InviteExpiry.to_utc` 使用于 `:910`）。

**不 import `models/models.py`**：schema 与 ORM 之间无编译期耦合，`from_attributes=True` 是靠属性名鸭子类型匹配的，因此**改 ORM 字段名不会在 schema 层报错，只会在运行期产生校验失败或字段缺失**。

### 6.2 被谁依赖（实测全量）

| 依赖方 | 数量 | 说明 |
|---|---|---|
| `app/api/routes/*.py` | **17 / 18 个路由模块** | 唯一不 import 本文件的是 `routes/ws.py`（WebSocket 直接收发 JSON，无 schema） |
| `app/services/*.py` | **0** | 实测 `grep -rln schemas app/services/` 无命中：服务层返回 `dict` / ORM 对象 / 标量，由路由层的 `response_model` 完成序列化与校验 |
| `backend/test/s25_ai_question_generate.py:67` | 1 | 唯一 import schema 的测试脚本（`QuestionOut`） |

`app/api/deps.py`、`app/main.py` 均不 import 本文件。

### 6.3 对应的数据库表

Schema 不直接引用表，但字段形状与 `models/models.py` 的 ORM 一一对应（表清单见 `ARCHITECTURE.md` §13.1）。需要**双向同步**的强耦合点：

- `AdminRouteNodeOut`（`:1328-1360`）↔ `RouteNode`：7 个可空内容列的 `None`→`""` 归一完全依赖 schema 校验器，删掉校验器会让管理端表格出现 `null`。
- `AdminQuestionOut.category`（`:1047-1052`）↔ `Question.category`（`models.py:141`，可空）。
- `MedalItem`（`:573-583`）↔ `MedalDef`：`category`/`hidden`/`sort_order` 三列由 `docker/init/005_upgrade.sql` 追加，种子来源见 `app/data/seed.py` 的 `MEDALS`（12 枚）。
- `QuizRecordOut.answer_at`（`:464`）↔ `quiz_records.answer_at`：**毫秒级 `BigInteger`**，不是 `datetime`（`ARCHITECTURE.md` §4.5 例外项）。
- `ActivityStatusOut` / `AdminActivitySettingOut` ↔ `activity_settings`（单行 `id=1`）。
- AI 系列（`:1621-1858`）↔ 6 张 `ai_*` 表（`docker/init/021_ai_center.sql`）。

## 7. 业务规则

### 7.1 双命名契约（不变量 6）

**91 个 `CamelModel` 子类输出 camelCase；109 个普通 `BaseModel` 输出 snake_case。** 二者在同一文件内并存，靠类名区分：

- 小程序契约：无 `Admin` 前缀（`UserOut`、`RouteOut`、`QuizDailyOut`、`AiChatOut` …），**含 1 个例外** `ActivityStatusOut`（`:1567`，`CamelModel`，用于公开接口 `GET /api/activity/status`）。
- 管理端契约：一律 `Admin` 前缀，**全部是普通 `BaseModel`，无一继承 `CamelModel`**（实测：`:848` banner 之后共 108 个 `Admin*` 类 + `_InviteExpiry`，camel 数为 0）。
- 同一份业务数据面向两端时写两个类，不复用：`RankItem`（`:811`，camel）↔ `AdminRankItemOut`（`:1399`，snake）；`RecentItem`（`:172`）↔ `AdminOverviewRecentSport`（`:1456`）；`NodeDetailOut`（`:288`）↔ `AdminRouteNodeOut`（`:1328`）；`OptionOut`（`:413`）↔ `AdminQuestionOption`（`:1030`）。

### 7.2 对外字段裁剪（安全相关，不可随意放宽）

| 裁剪点 | 依据 |
|---|---|
| **作答中的题目不下发答案与解析**：`QuestionOut`（`:418-425`）只有 `id/type/question/options/score`；docstring `:419` 说明「解析可能暗示答案，提交后在 details 中展示」。管理端 `AdminQuestionOut`（`:1037-1047`）才有 `answer`/`analysis` | 提交 `25c954c`「答题改为提交后统一反馈……题目不下发答案与解析，提交须覆盖今日全部题目防伪造刷分」 |
| **`openid` 永不对外**：`QrInfoTarget`（`:98-103`）docstring「仅展示渠道信息，openid 不对外返回」；`IdentityOut`（`:121-129`）docstring「对外不返回 openid」，只暴露 `provider`/`app_id`/`unionid` | 与 `ARCHITECTURE.md` 不变量 12「`session_key` 不落库不打日志」同源 |
| **公开动态流不含 `user_id`**：`ActivityItemOut`（`:713-720`）docstring「仅昵称/行为文案/类型/时间，不含 user_id 与事件参数」；`CompanionItemOut`（`:761-767`）docstring「不含用户 id」。管理端对应的 `AdminActivityItem`（`:1241-1250`）**含** `user_id` 与 `data` | 需求 §8.5 / §9.4 |
| **AI 配置不含密钥**：`AdminAiConfigOut`（`:1772-1780`）docstring「不含任何密钥」，只暴露 values/defaults/ranges/prompts/prompt_version/overridden | — |
| **AI 知识来源脱敏**：`AiSourceOut`（`:1621-1627`）docstring「后端核验过的已发布资料，不含内部状态/审核人等字段」；管理端 `AdminAiKnowledgeOut`（`:1719-1732`）才有 `status`/`created_by`/`reviewed_by` | — |
| **导入错误只回传行号与列名**：`AdminImportErrorRow`（`:1115-1120`）`row`/`field`/`reason`，不回传原始行数据 | — |

### 7.3 时间字段的三套形态（易错点）

| 形态 | 字段 | 说明 |
|---|---|---|
| `datetime`，**UTC naive** | 绝大多数 `created_at`/`updated_at`/`granted_at`/`lit_at`/`verified_at`/`event_time`/`reached_at` 等 | 直接 `isoformat()` 输出，**无时区后缀**，前端必须走 `parseUtc`（`ARCHITECTURE.md` §4.5） |
| `datetime`，**带 `+08:00` 偏移** | `ActivityStatusOut.start_at`/`end_at`（`:1573-1574`）、`AdminActivitySettingOut.start_at`/`end_at`（`:1587-1588`）；两者的 `server_time`（`:1580`、`:1594`）同为带偏移 | docstring `:1568` 明确「时间均为 +08:00」。转换在 `services/activity_service.py:72-73`（`to_local(dt).replace(tzinfo=BEIJING_TZ)`）完成，**是全项目 REST 输出中唯一带时区偏移的一组字段** |
| `int`，**毫秒时间戳** | `QuizRecordOut.answer_at`（`:464`）、`QuizCurrentOut.started_at`/`deadline_at`/`remaining_ms`（`:478-480`）、`QuizDailyOut.server_time`（`:491`）、`AdminOverviewQuizRecord.answer_at`（`:1480`） | docstring `:474` 说明「剩余时间以服务器为准」，即逐题限时作答的计时基准由服务端下发（提交 `78a12ca`） |

**入参时区归一有两处不同实现**，属不一致：

- 邀请码有效期在 **schema 层**：`_InviteExpiry.to_utc`（`:907-910`）调 `local_to_utc`。
- 活动起止时间在 **service 层**：`AdminActivitySettingUpdate`（`:1603-1612`）的 docstring `:1604` 声称「时间入参按北京时间解释（naive 视为 +08:00，带时区按时区换算），精确到分钟」，但**该类没有任何 validator**；实际换算与秒/微秒截断发生在 `services/activity_service.py:164-165`（`local_to_utc(...).replace(second=0, microsecond=0)`）。

### 7.4 状态枚举一律是「无约束 `str` + docstring 说明」

数据库侧「无任何 CHECK 约束、所有枚举都是 VARCHAR + 应用层常量校验」（`ARCHITECTURE.md` §13.2），schema 侧与之对应：**只有 2 个字段用 `pattern` 约束**（`QrConfirmRequest.action:118`、`AdminUserStatusRequest.status:931`），其余枚举字段的取值只写在 docstring 里，Pydantic 不校验：

| 字段 | 取值（docstring 出处） |
|---|---|
| `LoginResponse.status`（`:50`） | `active` / `unregistered` / `disabled`（`:48`） |
| `QrInfoOut.type`（`:107`） | `login` / `bind`（行内注释） |
| `AdminInviteOut.status`（`:892`） | `active` / `disabled` / `expired` / `exhausted`（`:880`） |
| `ChapterOut.status`（`:245`） | `LOCKED` / `ACTIVE` / `COMPLETED`（`:240`） |
| `QuizProgressItem.status`（`:469`） | `answering` / `answered` / `timeout` / `pending`（行内注释） |
| `ActivityStatusOut.status`（`:1571`） | `unpublished` / `not_started` / `ongoing` / `ended`（`:1568`） |
| `AiRouteGuideOut.source_type`（`:1689`） | `knowledge` / `node`（`:1682`） |
| `AiQuizExplanationOut.source_type`（`:1702`） | `bank` / `ai`（`:1695`） |
| `AdminAiKnowledgeUpsert.status`（`:1716`） | `draft` / `pending` / `published` / `rejected` / `archived`（`:1708`） |
| `AdminAiDraftOut.status`（`:1802`） | `pending` / `approved` / `rejected` / `imported`（`:1796`） |
| `AdminQuestionUpsert.type`（`:1063`） | `single` / `judge`（`:1061`） |

后果：service 写错枚举值不会在 schema 层被拦下，会原样输出到前端。

### 7.5 分页与聚合

- 分页响应统一 `{total, items}`：`AdminInviteListOut:897`、`AdminUserListOut:982`、`AdminAuditLogListOut:1025`、`AdminQuestionListOut:1055`、`AdminQuoteListOut:1084`、`AdminOrgUserListOut:1321`、`AdminRouteNodeListOut:1363`、`AdminAiKnowledgeListOut:1735`、`AdminAiJobListOut:1825`、`AdminAiDraftListOut:1830`。
- **例外 1**：`PointsRankOut`（`:836-845`）用 `{top, list, me, page, page_size, has_more, total}`，docstring `:837` 说明「top 第 1~10 名；list 第 11 名起分页」——排行榜需要固定的领奖台区。
- **例外 2**：`AdminRankListOut`（`:1428-1441`）的 docstring `:1429-1430` 区分了两个 total：`total`/`total_steps`/`completed_users`/`avg_progress` 是**全员口径**，`match_total` 才是**筛选命中人数**，`items` 仅当前页。改这个类时不可把两者合并。
- **例外 3**：`AdminRoleListOut`（`:996`）只有 `items`，无 `total`（角色数量小，不分页）。
- **聚合模型**（一次请求返回多域数据，减少小程序请求数）：`ProfileSummaryOut:664`、`BroadcastTodayOut:707`、`RouteOut:262`、`QuizDailyOut:483`、`AdminScreenOut:1257`（docstring `:1258`「单接口减少大屏请求数」）、`AdminUserOverviewOut:1552`、`AdminDashboardOut:1221`。

### 7.6 幂等与一次性令牌

`AdminImportPreviewOut.preview_token`（`:1126`）是 Excel 两阶段导入的一次性凭证，docstring `:1124` 明确「任意一行校验失败时本批次禁止确认导入」；`AdminImportConfirmRequest`（`:1133-1134`）只带这一个字段。原子消费逻辑在 `services/import_service.py:140-175`（`ARCHITECTURE.md` 不变量 13）。

## 8. 修改约束

1. **不变量 1 / 6：小程序响应字段必须是 camelCase。** 新增面向小程序的响应模型必须继承 `CamelModel`；给已有 `CamelModel` 子类加字段时写字段名用 snake_case（别名自动生成），**绝不要手写 camelCase 字段名**——`to_camel("totalSteps")` 不会得到期望结果。
2. **管理端模型绝不可改成 `CamelModel`。** `admin/src/api/*.ts` 与全部 `admin/src/views/*` 直接消费 snake_case 键；把任一 `Admin*` 类的基类换成 `CamelModel` 会导致管理后台整页字段错位且不报错（TypeScript 侧类型对不上才可能被发现）。
3. **新增接口前必须先确认调用方**（`ARCHITECTURE.md` §4.2），选错基类的代价是整体字段错位。
4. **重命名 / 删除任何字段都是破坏性变更。** `backend/AGENTS.md` §4 不变量 1 规定「新增/修改字段若与前端 services 结构不一致，视为破坏性变更」；§6.2 要求「改接口必改三处」：`routes` + `services` + `schemas`，并核对小程序 `services/*.js` 与 `admin/src/api/*.ts`。
5. **不得把敏感字段加进小程序侧模型**：`answer`/`analysis` 只能出现在 `AdminQuestionOut`/`AdminQuestionUpsert`/`QuizDetailItem`（提交后才下发，`:437-451`）/`AiQuizExplanationOut`（`:1694`，答题结束后）中，**不得加进 `QuestionOut`（`:418`）**；`openid` 不得加进任何对外模型。
6. **`AdminOrgNodeOut` 的前向引用与 `model_rebuild()`（`:1279`、`:1563`）必须成对保留**：删掉 `:1563` 后自引用字段在首次序列化时的构建时机依赖 Pydantic 内部行为；把 `children` 改成非字符串引用会直接 `NameError`。
7. **`BroadcastTodayOut.global_` 的显式 `alias="global"`（`:708`）不可删**：字段名带尾下划线，删掉别名后输出键会变成 Pydantic 生成的形式，小程序 `pages/home` 与 `services/broadcast.js` 读的是 `global`。
8. **9 个 `field_validator` 的 `None` 归一不可移除**，除非同时把对应字段改成 `Optional[str]`。openGauss Oracle 兼容模式 A 下 `''` 落库为 NULL（`docker/init/SQL_CONSTRAINTS.md`），读出恒为 `None`。
9. **`AiQuizExplanationOut.options` 复用 `AdminQuestionOption`（`:1699`）是跨契约耦合**：给 `AdminQuestionOption` 增加多词字段会同时污染小程序侧输出。新增字段时须显式评估，或改为独立的 `AiOptionOut`。
10. **禁止给响应加 snake_case 字段**（`backend/AGENTS.md` §6.4），也**禁止在路由中返回裸 dict 而不声明 `response_model`**（§3.1）；当前唯一违例见 §9 第 6 项。
11. **不得在本文件写业务逻辑或查库**：分层规则 `api/routes → api/deps → services → models + core`，schemas 只被 routes 引用（§6.2 实测），引入 service 依赖会形成环。
12. **文件较大（1858 行），编辑时优先精准替换而非整文件覆盖**（与 `frontend/AGENTS.md` §6.2 同类历史事故的防范要求）。

## 9. 当前实现状态

**已实现**：

- 201 个类全部有引用（126 个被路由直接引用，其余 74 个为内嵌子模型 + `CamelModel` 基类），**无死代码**。
- 覆盖 18 个路由模块中 17 个的全部契约（`ws.py` 无 schema）；46 处请求体绑定、约 110 处 `response_model` 声明。
- 双命名契约完整落地：91 个 camelCase 模型 / 109 个 snake_case 模型，`Admin*` 系列 108 个无一继承 `CamelModel`。
- 9 个 `field_validator`、19 组 `Field` 约束、1 处 `model_rebuild()`。

**存在问题 / 技术债**：

1. **`empty_avatar` 校验器在 5 个类中逐字重复**（`:33-36`、`:603-606`、`:823-826`、`:1315-1318`、`:1417-1420`）。与仓库根 `agents.md` §2.2「重复出现的相似逻辑应抽取公共实现」不符。可抽为 `_AvatarMixin` 或改用 `Annotated[str, BeforeValidator(...)]`。**未处理**。
2. **`AdminRankNodeOut`（`:1391-1396`）与 `AdminOverviewNode`（`:1493-1500`）字段完全相同**（`id`/`name`/`target_steps`/`reached`/`reached_at`，类型与默认值一致），属重复定义。**未处理**。
3. **`OptionOut`（`:413`，camel）与 `AdminQuestionOption`（`:1030`，snake）字段相同**（`label`/`text`）。这一对属双命名契约的正常代价，但 `:1699` 让 camel 侧模型直接复用了 `Admin*` 类，破坏了「按前缀区分契约」的可读性约定。
4. **请求模型三种别名机制并存**（§5.1 的 A/B/C），`SportSyncRequest` 是唯一继承 `CamelModel` 的请求体、`AiChatRequest` 是唯一自带 `alias_generator` 的请求体。行为等价但新增时无明确范式可循。
5. **入参时区归一位置不统一**：`_InviteExpiry` 在 schema 层（`:907-910`），`AdminActivitySettingUpdate` 在 service 层（`activity_service.py:164-165`），而后者 docstring（`:1604`）读起来像是在 schema 层完成。
6. **`POST /api/march/ceremony`（`routes/march.py:76-81`）返回 `{"ok": True}`，既无 `response_model` 也无返回类型注解**，是 `backend/AGENTS.md` §3.1「所有响应必须声明 response_model」的**唯一违例**（`admin.py:347`/`:429`/`:582` 三处无 `response_model` 属 CSV/Excel 流式下载，返回 `StreamingResponse`，合理豁免；`admin.py:730` 用 `-> MessageOut` 注解替代 `response_model`，等效）。本文件可补一个 `CeremonyAckOut`，**未处理**。
7. **`:1198` banner「管理端驾驶舱 / 数据大屏」名不副实**：该 banner 之下 362 行、35 个类实际横跨驾驶舱、组织管理、路线节点管理、排名洞察与人员详情 5 个子域（§4.2 拆分表）。
8. **422 状态码未登记进 `ARCHITECTURE.md` §4.3 的状态码表**（§5.3）。
9. **`ActivityStatusOut`/`AdminActivitySettingOut` 的时间字段带 `+08:00` 偏移，是 REST 输出的孤例**（§7.3），与 `ARCHITECTURE.md` §4.5「REST 输出 = UTC naive isoformat」的总述不一致；该文档未记录这一例外。
10. **无 `model_validator`**：跨字段规则（活动起止先后、`AdminInviteUpdate` 的部分更新语义）全部下沉到 service 层，schema 层无法在 `/docs` 中体现这些约束。属设计取舍，非缺陷。

**待确认**：

- 生产环境 Python / pydantic 版本是否与开发机一致（开发实测 pydantic 2.13.4、fastapi 0.141.1）；`requirements.txt` 的固定策略见 `.qoder/backend/requirements.txt.md`。若生产为更低 pydantic 2.x，`Field(min_length=...)` 作用于 `List`（`:1846` `AdminAiImportRequest.draft_ids`）等写法的行为需回归验证，**待确认**。
- `RankListOut`（`:829`，对应 `GET /api/rank/steps`）能否下线：已查实**小程序端不再调用**——`frontend/services/rank.js` 只有 `/rank/points`（`:16`）一处请求，全 `frontend/` 与 `admin/src/` 对 `rank/steps` **0 命中**；现存调用方只有后端测试脚本（`backend/test/e2e_datasync.py:120`、`e2e_full_flow.py:340`/`:575`、`s7_perf_refactor.py:137`），且 `rank_service.py:16` 注释已标注「旧版 /rank/steps 榜单条数」。是否正式下线属产品决策，**待确认**。

**待开发**：无。管理端 5 个 AI 子页面「待开发」（`ARCHITECTURE.md` §11.3）指的是 `admin/src/` 前端页面，其所需的 `:1706-1858` 全部契约**已就绪**。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/schemas/schemas.py`（**40 条提交**，2026-09-30 至 2026-10-17），验证结论对照 `docs/迭代记录.md`。按主题归并如下，提交号与日期均为真实值。

### 2026-10-17

- 需求：V1.0 AI 智能中心 Phase A——历史助手对话、节点讲解、答题解析、管理端知识库/配置/题目工坊/调用记录。
- 修改内容：提交 `1600074`。新增 `:1619-1858` 两个分节共 27 个类：小程序契约 9 个（`AiSourceOut`、`AiChatRequest`、`AiChatOut`、`AiConversationItemOut`、`AiConversationListOut`、`AiMessageOut`、`AiConversationDetailOut`、`AiRouteGuideOut`、`AiQuizExplanationOut`）与管理端契约 18 个（知识库 4、配置 4、出题任务与草稿 8、导入 3 中的 `AdminAiImportRequest`/`AdminAiImportFailure`/`AdminAiImportOut`）。`AiChatRequest` 引入第三种别名机制（自带 `alias_generator=to_camel`）。
- 关联文件：`app/api/routes/ai.py`、`app/api/routes/ai_admin.py`、6 个 `app/services/ai_*_service.py`、`docker/init/021_ai_center.sql`、`docker/init/022_ai_admin_menus.sql`、`frontend/pages/ai-chat/`。
- 测试结果：冒烟 `s26` 47/47 通过（含真实 CloudBase Agent 调用）；小程序真机真实 Agent 全链路当时记为「待验证」（本机 DNS 劫持限制）。（来源：`ARCHITECTURE.md` §11.2）

### 2026-10-16

- 需求：题库接入 CloudBase Agent AI 出题（草稿审核后入库），Excel 导入完整保留。
- 修改内容：提交 `ea58b6c`。新增 `:1141-1195`「管理端 AI 智能出题」分节 6 个类（`AdminAiGenerateRequest`、`AdminAiQuestionDraft`、`AdminAiGenerateOut`、`AdminAiBatchSaveRequest`、`AdminAiSaveFailure`、`AdminAiBatchSaveOut`）。`AdminAiGenerateRequest` docstring（`:1143-1147`）记录了两条设计约束：`question_type` 仅支持 `single`、`difficulty` 只作提示词参数不入库（`questions` 表无难度列）。
- 关联文件：`app/api/routes/admin.py:500`/`:524`、`app/services/ai_question_service.py`、`admin/src/components/AiGenerateDialog.vue`。
- 测试结果：`admin/src/components/AiGenerateDialog.vue` 的 `validateItem`（`:86-104`）与后端 `_validate_question` 对齐，`failures.index` 为 1 基（`ARCHITECTURE.md` §11.3）。

### 2026-10-15

- 需求：步行积分口径调整与近 7 日步数补录。
- 修改内容：4 条提交。`6f2cfc3` 支持近 7 日步数补录结余积分与用户独立题目轮换（`SportSync` 增补 `walk_carry`，`:161`）；`6913b00` 修复节点详情路线位置缺少点位导致蓝屏；`85c5a55` 与 `9cb65b8` 取消步行积分单日 20000 封顶、改为累计步数 ÷ 1000，`PointsRules`（`:536-539`）不再下发 `walkStepCap`/`walkDailyCap`，`ProfileStats`（`:619-631`）仅保留原始 `total_steps`。
- 关联文件：`app/services/points_service.py`、`app/core/config.py`（删 `POINTS_WALK_STEP_CAP`）、`frontend/pages/points/`、`test/s20_v2_regression.py`。
- 测试结果：S20 26/26（含新边界 25000 步→25 分）、S23 13/13、S22 14/14；`node --check` 与 `py_compile` 通过。（来源：`docs/迭代记录.md` 2026-10-15 条目）

### 2026-10-13

- 需求：四项相互独立的后端改造同日落地。
- 修改内容：4 条提交。`ce14a95` 活动时间控制——新增 `:1566-1616` 分节 4 个类（`ActivityStatusOut`、`AdminActivitySettingOut`、`AdminActivitySettingUpdate`、`AdminActivityPublishRequest`），时间字段改为带 `+08:00` 偏移输出；`2f3f333` 积分台账重构——新增 `:535-569` 积分分节（`PointsRules`/`PointsSummaryOut`/`PointsDailyItem`/`PointsDailyOut`）与 `PointsRankOut`（`:836`）、`AdminPointsVerifyRequest`/`AdminPointsDiff`/`AdminPointsVerifyOut`（`:1530-1549`），总积分改为步行+答题、移除登录/达标/点亮/里程碑积分；`07d02af` 所属部门首次确定后锁定——`UserOrgOut` 增补 `locked`（`:756`），新增 `AdminUserOrgRequest`（`:934`）；`78a12ca` 答题改为逐题限时作答——新增 `QuizProgressItem`（`:467`）与 `QuizCurrentOut`（`:473`，服务器毫秒计时），`QuizDailyOut` 增补 `progress`/`current`/`question_shortage`/`shortage_message`/`server_time`（`:485-493`），`QuizDetailItem` 增补 `timeout`（`:448`）。
- 关联文件：`app/api/routes/activity.py`（新增）、`app/services/activity_service.py`、`points_service.py`、`quiz_service.py`、`docker/init/016_activity_settings.sql`、`017_points_ledger.sql`、`018_quiz_answers.sql`、`020_question_rotation.sql`。
- 测试结果：TestClient 冒烟通过（默认状态、时间格式错误 422、开始晚于结束 400、未发布/已结束时写接口 403 等）；`s19_invite_admission.py` 回归 25/25。（来源：`docs/迭代记录.md` 2026-10-13 条目）

### 2026-10-12

- 需求：邀请码准入全链路 + 答题改为提交后统一反馈。
- 修改内容：2 条提交。`25c954c` 移除单题判题契约：`QuestionOut`（`:418`）不再下发 `answer`/`analysis`（docstring `:419` 说明理由），新增 `QuizDetailItem`（`:437`）与 `WrongItem`（`:428`）承载提交后的逐题结果，`QuizRecordOut` 增补 `details`（`:463`）；`afbcba9` 邀请码准入——新增 `InviteVerifyRequest`/`InviteVerifyOut`/`OnboardRequest`/`OnboardResponse`（`:55-82`）与管理端 `AdminInviteOut`/`AdminInviteListOut`/`_InviteExpiry`/`AdminInviteCreate`/`AdminInviteUpdate`（`:879-927`）、`AdminUserStatusRequest`（`:930`），`LoginResponse`（`:47-52`）改为三态 `status` 且仅 `active` 下发 token。
- 关联文件：`app/api/routes/auth.py`、`app/services/invite_service.py`、`app/api/deps.py`、`docker/init/015_invite_admission.sql`、`frontend/pages/onboard/`、`admin/src/views/`。
- 测试结果：见 `docs/迭代记录.md` 2026-10-12 条目。

### 2026-10-11

- 需求：寄语循环 + Excel 批量导入 + 排名分页导出 + 小程序代码审查修复 + 扫码入驻健壮性。
- 修改内容：4 条提交。`d6acf7e` 新增 `AdminQuoteCycleOut`（`:1099`）/`AdminQuoteCycleUpdate`（`:1108`）与 `:1114-1138` Excel 导入 4 个类，`AdminQuoteOut`/`AdminQuoteUpsert` 改为 `sort_order` + `is_enabled` 口径；`b5d6035` 新增 `AdminRankNodeOut`/`AdminRankItemOut`/`AdminRankOrgOption`/`AdminRankListOut`（`:1391-1441`），`AdminRankListOut` docstring（`:1429-1430`）区分全员口径与筛选命中数；`e70b59f` 让 `LightUpResult`（`:362`）合并返回 `new_medals`，省去小程序单独请求勋章；`67c96b1` 扫码入驻健壮性（已配置微信时换取失败 502 不回退 mock）并新增通用入驻小程序码接口 `AdminInviteQrOut`（`:869`）。
- 关联文件：`app/services/import_service.py`、`quote_service.py`、`admin_service.py`、`auth_service.py`、`admin/src/components/ExcelImportDialog.vue`、`docker/init/013_daily_quote_cycle.sql`。
- 测试结果：见 `docs/迭代记录.md` 2026-10-11 条目。

### 2026-10-10

- 需求：题库 Excel 导入 + 步数同步接入微信运动真实数据。
- 修改内容：2 条提交。`54ea125` 新增 `AdminImportErrorRow`/`AdminImportPreviewOut`/`AdminImportConfirmRequest`/`AdminImportConfirmOut`（`:1115-1138`），`AdminQuestionListOut`（`:1055`）改服务端分页；`3df3fd0` 新增 `SportSyncRequest`（`:164`，承载 `code`/`encrypted_data`/`iv`），docstring `:165` 明确「缺省时仅开发模式回退模拟」。
- 关联文件：`app/services/import_service.py`、`app/core/wx.py`（新增）、`app/services/sport_service.py`、`frontend/services/sport.js`。
- 测试结果：S11 后端冒烟 8/8；e2e 全链路 178/178 回归；小程序 automator 验收 4/4。（来源：`docs/迭代记录.md` 2026-10-10 条目）

### 2026-10-09

- 需求：管理后台 RBAC 与审计、微信扫码登录与身份关联、组织人员明细。
- 修改内容：3 条提交。`a740973` 新增 `AdminOrgUserOut`（`:1306`）/`AdminOrgUserListOut`（`:1321`）；`b431e4d` 新增 `:91-129` 身份关联分节（`QrInfoRequest`/`QrInfoTarget`/`QrInfoOut`/`QrConfirmRequest`/`IdentityOut`）与 `AdminQrCreateOut`（`:859`）/`AdminQrStatusOut`（`:943`）、`AdminMeOut`（`:953`）；`4bf9acd` 新增 `:960-1027` 人员授权/角色/审计 10 个类（`AdminUserRoleItem`、`AdminUserItem`、`AdminUserListOut`、`AdminRoleOut`、`AdminRoleListOut`、`AdminRoleUpsert`、`AdminUserRolesRequest`、`AdminRoleEnabledRequest`、`AdminAuditLogOut`、`AdminAuditLogListOut`）。
- 关联文件：`app/api/deps.py`（`get_current_admin`/`require_menu`）、`app/services/access_service.py`、`identity_service.py`、`audit_service.py`、`app/core/security.py`（令牌 `typ` 区分）、`app/api/routes/ws.py`。
- 测试结果：S9 测试 30/30、S8 复测 23/23、S8 集成测试 23/23；`4bf9acd` 同时修复了「删除角色未清理菜单关联」的外键缺陷。（来源：提交信息正文）

### 2026-10-08

- 需求：修复第一轮全链路测试发现的 4 处缺陷（BUG-001~004）并复测回归。
- 修改内容：提交 `7607d7b`。涉及本文件的是 BUG-004「WS 时间戳契约」与 BUG-002「答题题目校验」相关的契约修正；BUG-001（组织主键无自增）与 BUG-003（补步下限）分别由 `docker/init/009_org_serial.sql` 与 service 层修复。
- 关联文件：`docker/init/009_org_serial.sql`、`app/services/admin_service.py`、`app/core/ws.py`、`docs/测试报告.md`。
- 测试结果：全量回归复测通过——e2e D11-D16、API 探针 200、浏览器 UI 创建组织成功；报告结论「高优先级缺陷 0」。（来源：`docs/测试报告.md` §3.1、§5）

### 2026-10-03 ~ 2026-10-04

- 需求：P0-3 / P1-1~P1-8 / P2-1 / P2-2 共 10 项功能连续交付（章节系统、行军轨迹后端统一计算、实时动态、同组织同行者、组织共同目标、全员共同目标、我的足迹地图、成就与数据画像、人物志、每日寄语、区域氛围与完成仪式）。
- 修改内容：8 条提交，本文件由「基础 CRUD 契约」扩张为「聚合契约」。`6a2fae3` 新增 `ChapterOut`（`:239`）/`ChapterCompletedOut`（`:253`），`RouteOut` 增补章节与轨迹字段（`:271-278`）；`05180c2` 把 `current_node_id`/`current_progress`/`route_progress` 收归后端计算（`:271-273`）；`17a4d98` 新增 `ActivityItemOut`/`ActivitiesOut`（`:713-724`）；`f37e3d7` 新增 `CompanionItemOut`/`OrgCompanionsOut`（`:761-776`）；`b4a8910` 新增 `OrgMarchNodeOut`/`OrgMarchOut`（`:779-801`）；`c92598c` 新增 `GlobalMilestoneOut`/`GlobalGoalNextOut`/`GlobalGoalOut`（`:368-391`）；`ffd2570` 新增 `FootprintNodeOut`/`FootprintsOut`（`:394-409`）；`3202404` 新增 `ProfilePortrait`（`:654`，五维评分）；`2a178b7` 新增 `PersonRefOut`/`PersonNodeRefOut`/`PersonDetailOut`（`:281-327`）；`71d1b9b` 新增 `QuoteNodeRefOut`/`QuoteTodayOut`（`:330-344`）；`79004f1` 新增 `RouteOut.ceremony_pending`（`:278`，需求 §20.4）。
- 关联文件：`app/api/routes/march.py`、`broadcast.py`（新增）、`org.py`、`profile.py`（新增）、`persons.py`（新增）、`quotes.py`（新增）、`app/services/march_service.py`、`app/data/seed.py`、`frontend/pages/` 多个新页面。
- 测试结果：各提交对应的冒烟与 automator 验收结论见 `docs/迭代记录.md` 2026-10-03 / 2026-10-04 条目。

### 2026-10-02

- 需求：小程序聚合接口与管理端驾驶舱/大屏。
- 修改内容：5 条提交。`18c2121` 新增 `:595-729`（个人档案 11 类 + 今日播报 6 类 + `MessageOut`）与运动日历 `CalendarDay`/`CalendarStats`/`SportCalendarOut`（`:178-199`）、知识画像 `KnowledgeCategory`/`QuizKnowledgeOut`（`:515-525`）；`2289fdd` 新增 `:1198-1263` 驾驶舱/大屏 8 类，并给节点与题库管理扩展内容字段（`AdminRouteNodeOut` 的 `brief`/`significance`/`figures`/`location`/`images`/`audio`/`keywords`，`:1339-1345`）；`e4f21df` 新增 `AdminOrgNodeOut`/`AdminOrgTreeOut`（`:1266-1284`，含直属/含下级两个用户数）；`05180c2`、`6a2fae3` 见上条。
- 关联文件：`app/api/routes/profile.py`、`broadcast.py`、`app/api/routes/admin.py`、`app/services/dashboard_service.py`、`profile_service.py`、`admin_service.py`。
- 测试结果：S3 冒烟 15/15 通过。（来源：`docs/迭代记录.md` 2026-10-02 条目、`.qoder/backend/app/core/helpers.py.md` §10）

### 2026-10-01

- 需求：管理后台首批 API + 微信名称直登与昵称仅可改一次。
- 修改内容：3 条提交。`337af78` 新增管理后台首批契约（登录、题库、组织架构、路线节点、排名），即 `:848` 分节的雏形与 `AdminQuestion*`/`AdminRouteNode*` 系列；`e7e2349` 新增人员详情聚合 `:1444-1560`（`AdminOverview*` 9 类 + `AdminUserOverviewOut`）；`f820e0e` 新增 `NicknameUpdateRequest`（`:85`）、`UserOut.nickname_changed_at`（`:31`）与 `AdminRankItemOut.original_nickname`/`nickname_changed_at`（`:1405-1406`）。
- 关联文件：`app/api/routes/admin.py`、`app/services/admin_service.py`、`docker/init/004_nickname_change.sql`、`frontend/pages/login/`、`admin/src/views/`。
- 测试结果：见 `docs/迭代记录.md` 2026-10-01 条目。

### 2026-09-30

- 需求：项目初始化，把小程序 `frontend/services/*.js` 的 Mock 返回结构迁移为后端 Pydantic 契约。
- 修改内容：提交 `a94e685`（`feat: init`）。建立 `CamelModel` 基类（`:17-22`）与鉴权/运动/路线/答题/勋章/组织/排名的首批模型；模块 docstring（`:1-7`）确立「与前端 mock 返回结构完全一致，前端切换真实接口时数据结构无需改动」的原始约束。
- 关联文件：`app/api/routes/` 首批路由、`app/services/` 首批 service、`app/models/models.py`。
- 测试结果：**待确认**（`docs/迭代记录.md` 该条目仅记「仓库初始代码」，无验证结论）。
