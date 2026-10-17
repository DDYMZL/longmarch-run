# admin.py

> 最后核对时间：2026-10-17（仓库 HEAD `651efc8`；本文件最后一次变更在 `ea58b6c`，工作区对 HEAD 无未提交改动）
>
> 本文档所有行号均以带行号的源码阅读输出核对；端点数、路径、菜单码以 `app.openapi()` + 正则双向实测。无法从代码 / Git 历史 / 既有文档确认的一律标注「待确认」。

## 1. 文件路径

`backend/app/api/routes/admin.py`（**1088 行有效内容**，文件以换行结尾，带行号阅读器显示到第 1089 行的空行；是 `backend/app/api/routes/` 下最大的路由模块，也是全项目端点最多的单文件）

## 2. 文件职责

管理后台（`admin/`，Vue3 + Element Plus）的**全部业务 REST 接口层**：管理员登录、微信扫码登录、驾驶舱与数据大屏聚合、路线节点维护、排名洞察与流式 CSV 导出、人员详情、题库维护（含 Excel 两段式导入与 AI 出题）、每日寄语维护（含 Excel 两段式导入）、组织架构维护与外部同步、人员授权 / 角色 CRUD / 审计日志、入驻邀请码管理、活动时间控制。

本文件只承担 HTTP 协议层职责（参数接收、权限挂载、`ValueError → HTTPException` 转换、二进制/流式响应封装），业务规则全部下沉到 `backend/app/services/`。契约面向 `admin/` 前端，字段为 **snake_case**，与小程序的 camelCase 契约完全独立（模块 docstring `backend/app/api/routes/admin.py:1-6` 明确声明）。

## 3. 业务需求

| 需求来源 | 对应本文件的能力 |
|---|---|
| `.qoder/REQUIREMENTS.md` §11「管理后台功能」（§11.1 菜单与权限 / §11.2 人员管理 / §11.3 题库管理 / §11.4 活动配置 / §11.5 其它管理页 / §11.6 Excel 导入导出规则） | 全部 57 个端点 |
| `docs/identity-binding-design.md`（选型「小程序码扫码登录 + 完整 RBAC」） | `POST /wechat/qr`、`GET /wechat/qr/{qr_id}/status`、`GET /me`、`/users`、`/roles`、`/audit-logs` |
| `docs/长征步迹V1.0_扫码入驻与自动登录差异分析.md` | `GET /invites/{invite_id}/qrcode`（入驻小程序码） |
| `docs/长征步迹V2.0_交付说明.md`（V2.0 需求一 活动时间控制 / 需求三·四 积分台账 / 需求五 组织锁定） | `GET|PUT /activity`、`POST /activity/publish`、`POST /points/verify`、`PUT /users/{user_id}/org` |
| V1.1 功能一（题库 Excel 导入）、功能二（每日寄语按天循环 + Excel 导入）——`docs/迭代记录.md` `54ea125`、`d6acf7e` 条目 | `questions/import-*`、`quotes/import-*`、`GET|PUT /quotes/cycle` |
| V1.0 Phase A AI 智能中心（`.qoder/REQUIREMENTS.md` §10.3「AI 出题策略」） | `POST /ai/generate-questions`、`POST /ai/questions/batch-save` |

> 源码注释 `backend/app/api/routes/admin.py:541` 写作「需求 §16、V1.1 功能二」，其中「§16」指向的是**早期需求文档的章节号**，与现行 `.qoder/REQUIREMENTS.md` 的章节编号不对应（现行 REQUIREMENTS.md 无「每日寄语」独立章节，相关内容归入 §11.5）。属注释滞后，不影响功能。

## 4. 核心功能

### 4.1 文件骨架

| 行号 | 内容 |
|---|---|
| `:1-6` | 模块 docstring：声明「除 `POST /api/admin/login` 与扫码登录相关接口外，全部接口依赖 `get_current_admin`」与「snake_case 契约独立于小程序 camelCase」 |
| `:7-21` | 标准库与 FastAPI / SQLAlchemy import（`StreamingResponse` 在 `:12`） |
| `:15` | `from app.api.deps import AdminPrincipal, get_current_admin, require_menu` |
| `:16-21` | `core` 层 import：`rate_limit`、`ws as ws_manager`、`settings`、`get_db`、`today_str`、`create_admin_token` / `create_admin_token_for_user` |
| `:22` | `from app.models.models import User` —— **全文件唯一直接引用的 ORM 模型，且未被任何代码使用**（见 §9） |
| `:23-80` | 40 个 `Admin*` schema 与 `MessageOut` 的 import |
| `:81-96` | 15 个 service 的 import |
| `:98` | `router = APIRouter(prefix="/admin", tags=["admin"])` |
| `:101-1088` | 57 个路由处理函数 + 3 个模块级私有辅助函数 |

分区注释（banner）共 10 处：`:118`（微信扫码登录）、`:198`（驾驶舱 / 数据大屏）、`:243`（路线节点维护）、`:379`（题库维护）、`:498-499`（AI 智能出题）、`:541`（每日寄语维护）、`:665`（组织架构维护）、`:751`（人员授权 / 角色管理 / 审计日志）、`:823`（入驻邀请码）、`:1040`（活动设置）。**「排名洞察」相关的 4 个端点（`:312-376`）没有独立 banner**，物理上紧跟在「路线节点维护」区之后。

### 4.2 完整路径前缀的推导（实测）

```
settings.API_PREFIX = "/api"                          backend/app/core/config.py:25
router = APIRouter(prefix="/admin", tags=["admin"])   backend/app/api/routes/admin.py:98
app.include_router(admin.router, prefix=_prefix)      backend/app/main.py:86（_prefix 见 backend/app/main.py:69）
→ 实际前缀 = /api/admin
```

实测（`app.openapi()`，2026-10-17）：本文件贡献 **57 个 HTTP 方法级操作**、**45 个唯一路径字符串**；方法分布 `GET 23 / POST 18 / PUT 8 / PATCH 4 / DELETE 4`。`router.routes` 长度为 57，57 条全部能在 `app.openapi()['paths']` 中找到对应操作，**无遗漏、无重复**。与 `backend/app/api/routes/ai_admin.py`（前缀 `/admin/ai`，15 个端点）的路径集合**交集为空**。

> **AI 命名空间被拆在两个文件**：`/api/admin/ai/generate-questions` 与 `/api/admin/ai/questions/batch-save` 定义在**本文件**（`:500-538`），而 `/api/admin/ai/knowledge|jobs|drafts|config` 共 15 个端点定义在 `backend/app/api/routes/ai_admin.py`。查 AI 相关端点时必须同时看两个文件。

### 4.3 57 个端点完整清单

**权限依赖列的两种写法**：`dependencies=[Depends(require_menu(code))]`（**不注入**主体，仅做闸门）与 `admin: AdminPrincipal = Depends(require_menu(code))`（**注入**主体，供 `_actor()` / `admin.username` 使用）。下表用「注入」标注后者。菜单码字符串逐字取自源码，已与 `grep -n 'require_menu("'` 输出核对。

| # | 方法 | 完整路径 | 处理函数（行号） | 权限依赖（行号） | `response_model`（行号） | 主要下游 |
|---|---|---|---|---|---|---|
| 1 | POST | `/api/admin/login` | `login` `:102` | **无鉴权**；限流 `login_limiter` `:107` | `AdminLoginOut` `:101` | `core/security.create_admin_token` |
| 2 | POST | `/api/admin/wechat/qr` | `create_wechat_qr` `:124` | **无鉴权**；限流 `qr_create_limiter` `:129` | `AdminQrCreateOut` `:121` | `identity_service.create_login_session`、`wechat_service.get_wxacode_png` / `to_data_url` |
| 3 | GET | `/api/admin/wechat/qr/{qr_id}/status` | `poll_wechat_qr` `:147` | **无鉴权**；限流 `qr_poll_limiter` `:149` | `AdminQrStatusOut` `:144` | `identity_service.poll_login_session` / `issue_admin_token`、`access_service.build_principal` / `get_menu_items`、`create_admin_token_for_user` |
| 4 | GET | `/api/admin/me` | `admin_me` `:179` | `Depends(get_current_admin)` `:180`（**唯一直接用 `get_current_admin` 的端点**） | `AdminMeOut` `:178` | `access_service.get_all_menu_items` / `get_menu_items` |
| 5 | GET | `/api/admin/dashboard` | `dashboard` `:205` | `require_menu("dashboard")` `:203` | `AdminDashboardOut` `:201` | `dashboard_service.get_dashboard` |
| 6 | GET | `/api/admin/dashboard/trend` | `dashboard_trend` `:215` | `require_menu("dashboard")` `:213` | `AdminTrendOut` `:211` | `dashboard_service.get_trend` |
| 7 | GET | `/api/admin/activities` | `activities` `:227` | `require_menu("dashboard")` `:225` | `AdminActivityListOut` `:223` | `dashboard_service.get_activities` |
| 8 | GET | `/api/admin/screen` | `screen` `:239` | `require_menu("screen")` `:237` | `AdminScreenOut` `:235` | `dashboard_service.get_screen` |
| 9 | GET | `/api/admin/route-nodes` | `list_route_nodes` `:250` | `require_menu("route_nodes")` `:248` | `AdminRouteNodeListOut` `:246` | `admin_service.list_route_nodes` |
| 10 | POST | `/api/admin/route-nodes` | `create_route_node` `:261` | `require_menu("route_nodes")` `:259` | `AdminRouteNodeOut` `:257` | `admin_service.create_route_node` |
| 11 | PUT | `/api/admin/route-nodes/{node_id}` | `update_route_node` `:276` | `require_menu("route_nodes")` `:274` | `AdminRouteNodeOut` `:272` | `admin_service.update_route_node` |
| 12 | PATCH | `/api/admin/route-nodes/{node_id}/enabled` | `set_route_node_enabled` `:296` | `require_menu("route_nodes")` `:294` | `AdminRouteNodeOut` `:292` | `admin_service.set_route_node_enabled` |
| 13 | GET | `/api/admin/rankings` | `rankings` `:318` | `require_menu("rankings")` `:316` | `AdminRankListOut` `:314` | `admin_service.get_rank_overview` |
| 14 | POST | `/api/admin/points/verify` | `verify_points` `:330` | `require_menu("rankings")` `:332`（**注入**） | `AdminPointsVerifyOut` `:329` | `points_service.recompute_all` + 路由内 `audit_service.record` `:339` + `db.commit()` `:343` |
| 15 | GET | `/api/admin/rankings/export` | `export_rankings` `:352` | `require_menu("rankings")` `:350` | **无** `:347-351`（返回 `StreamingResponse`） | `admin_service.iter_rank_csv` |
| 16 | GET | `/api/admin/users/{user_id}/overview` | `user_overview` `:371` | `require_menu("rankings")` `:369` | `AdminUserOverviewOut` `:367` | `admin_service.get_user_overview` |
| 17 | GET | `/api/admin/questions` | `list_questions` `:386` | `require_menu("questions")` `:384` | `AdminQuestionListOut` `:382` | `admin_service.list_questions` |
| 18 | POST | `/api/admin/questions` | `create_question` `:404` | `require_menu("questions")` `:402` | `AdminQuestionOut` `:400` | `admin_service.create_question` |
| 19 | GET | `/api/admin/questions/import-template` | `download_question_import_template` `:434` | `require_menu("questions")` `:432` | **无** `:429-433`（返回 xlsx `Response`） | `import_service.build_question_template` + `_xlsx_response` `:411` |
| 20 | POST | `/api/admin/questions/import-preview` | `preview_question_import` `:443` | `require_menu("questions")` `:446`（**注入**） | `AdminImportPreviewOut` `:440` | `_read_import_file` `:419` + `import_service.preview_question_import` |
| 21 | POST | `/api/admin/questions/import-confirm` | `confirm_question_import` `:461` | `require_menu("questions")` `:459` | `AdminImportConfirmOut` `:457` | `import_service.confirm_question_import` |
| 22 | PUT | `/api/admin/questions/{question_id}` | `update_question` `:475` | `require_menu("questions")` `:473` | `AdminQuestionOut` `:471` | `admin_service.update_question` |
| 23 | DELETE | `/api/admin/questions/{question_id}` | `delete_question` `:493` | `require_menu("questions")` `:491` | `MessageOut` `:489` | `admin_service.delete_question`（**软停用**） |
| 24 | POST | `/api/admin/ai/generate-questions` | `ai_generate_questions` `:506` | `require_menu("questions")` `:504` | `AdminAiGenerateOut` `:502` | `ai_question_service.generate_questions` → `cloudbase_service` |
| 25 | POST | `/api/admin/ai/questions/batch-save` | `ai_batch_save_questions` `:530` | `require_menu("questions")` `:528` | `AdminAiBatchSaveOut` `:526` | `ai_question_service.batch_save_questions` |
| 26 | GET | `/api/admin/quotes` | `list_quotes` `:548` | `require_menu("quotes")` `:546` | `AdminQuoteListOut` `:544` | `quote_service.list_quotes` |
| 27 | GET | `/api/admin/quotes/cycle` | `get_quote_cycle` `:564` | `require_menu("quotes")` `:562` | `AdminQuoteCycleOut` `:560` | `quote_service.get_cycle_info` + `core/helpers.today_str` |
| 28 | PUT | `/api/admin/quotes/cycle` | `update_quote_cycle` `:574` | `require_menu("quotes")` `:572` | `AdminQuoteCycleOut` `:570` | `quote_service.set_cycle_start` + `get_cycle_info` |
| 29 | GET | `/api/admin/quotes/import-template` | `download_quote_import_template` `:587` | `require_menu("quotes")` `:585` | **无** `:582-586`（返回 xlsx `Response`） | `import_service.build_quote_template` + `_xlsx_response` `:411` |
| 30 | POST | `/api/admin/quotes/import-preview` | `preview_quote_import` `:596` | `require_menu("quotes")` `:599`（**注入**） | `AdminImportPreviewOut` `:593` | `_read_import_file` `:419` + `import_service.preview_quote_import` |
| 31 | POST | `/api/admin/quotes/import-confirm` | `confirm_quote_import` `:614` | `require_menu("quotes")` `:612` | `AdminImportConfirmOut` `:610` | `import_service.confirm_quote_import` |
| 32 | POST | `/api/admin/quotes` | `create_quote` `:628` | `require_menu("quotes")` `:626` | `AdminQuoteOut` `:624` | `quote_service.validate_quote` + `create_quote` + `get_admin_out` |
| 33 | PUT | `/api/admin/quotes/{quote_id}` | `update_quote` `:642` | `require_menu("quotes")` `:640` | `AdminQuoteOut` `:638` | `quote_service.validate_quote` + `update_quote` + `get_admin_out` |
| 34 | DELETE | `/api/admin/quotes/{quote_id}` | `delete_quote` `:659` | `require_menu("quotes")` `:657` | `MessageOut` `:655` | `quote_service.delete_quote`（**硬删除**） |
| 35 | GET | `/api/admin/orgs` | `org_tree` `:672` | `require_menu("orgs")` `:670` | `AdminOrgTreeOut` `:668` | `admin_service.get_org_tree` |
| 36 | GET | `/api/admin/orgs/{org_id}/users` | `org_users` `:682` | `require_menu("orgs")` `:680` | `AdminOrgUserListOut` `:678` | `admin_service.get_org_users` |
| 37 | POST | `/api/admin/orgs` | `create_org` `:702` | `require_menu("orgs")` `:700` | `AdminOrgNodeOut` `:698` | `admin_service.create_org` |
| 38 | PUT | `/api/admin/orgs/{org_id}` | `update_org` `:715` | `require_menu("orgs")` `:713` | `AdminOrgNodeOut` `:711` | `admin_service.update_org` |
| 39 | DELETE | `/api/admin/orgs/{org_id}` | `delete_org` `:730` | `require_menu("orgs")` `:728` | **由返回类型注解 `-> MessageOut` 推导** `:730`（装饰器无 `response_model=`） | `admin_service.delete_org` |
| 40 | POST | `/api/admin/orgs/sync` | `sync_orgs` `:743` | `require_menu("orgs")` `:741` | `AdminOrgSyncOut` `:739` | `admin_service.sync_orgs` |
| 41 | GET | `/api/admin/users` | `list_admin_users` `:762` | `require_menu("access")` `:770`（注入但**未使用**） | `AdminUserListOut` `:759` | `access_service.list_users` |
| 42 | PATCH | `/api/admin/users/{user_id}/status` | `set_user_status` `:783` | `require_menu("access")` `:787`（**注入**） | `MessageOut` `:780` | `invite_service.set_user_status` |
| 43 | PUT | `/api/admin/users/{user_id}/org` | `set_user_org` `:805` | `require_menu("access")` `:809`（**注入**） | `MessageOut` `:802` | `org_service.admin_set_user_org` + `ws_manager.broadcast` `:819` |
| 44 | GET | `/api/admin/invites` | `list_invites` `:829` | `require_menu("invites")` `:834`（注入但**未使用**） | `AdminInviteListOut` `:826` | `invite_service.list_invites` |
| 45 | POST | `/api/admin/invites` | `create_invite` `:845` | `require_menu("invites")` `:848`（**注入**） | `AdminInviteOut` `:842` | `invite_service.create_invite` |
| 46 | PATCH | `/api/admin/invites/{invite_id}` | `update_invite` `:864` | `require_menu("invites")` `:868`（**注入**） | `AdminInviteOut` `:861` | `invite_service.update_invite` |
| 47 | GET | `/api/admin/invites/{invite_id}/qrcode` | `get_invite_qrcode` `:886` | `require_menu("invites")` `:889`（注入但**未使用**） | `AdminInviteQrOut` `:883` | `invite_service.get_invite` / `scene_of` + `wechat_service.get_invite_image` / `to_data_url` / `ONBOARD_PAGE` |
| 48 | GET | `/api/admin/roles` | `list_roles` `:912` | `require_menu("access")` `:914`（注入但**未使用**） | `AdminRoleListOut` `:909` | `access_service.list_roles` |
| 49 | POST | `/api/admin/roles` | `create_role` `:924` | `require_menu("access")` `:927`（**注入**） | `AdminRoleOut` `:921` | `access_service.create_role` |
| 50 | PUT | `/api/admin/roles/{role_id}` | `update_role` `:943` | `require_menu("access")` `:947`（**注入**） | `AdminRoleOut` `:940` | `access_service.update_role` |
| 51 | DELETE | `/api/admin/roles/{role_id}` | `delete_role` `:963` | `require_menu("access")` `:966`（**注入**） | `MessageOut` `:960` | `access_service.delete_role` |
| 52 | POST | `/api/admin/users/{user_id}/roles` | `grant_user_roles` `:981` | `require_menu("access")` `:985`（**注入**） | `MessageOut` `:978` | `access_service.grant_roles` |
| 53 | PATCH | `/api/admin/users/{user_id}/roles/{role_id}/enabled` | `set_user_role_enabled` `:1003` | `require_menu("access")` `:1008`（**注入**） | `MessageOut` `:1000` | `access_service.set_role_enabled` |
| 54 | GET | `/api/admin/audit-logs` | `audit_logs` `:1025` | `require_menu("audit")` `:1032`（注入但**未使用**） | `AdminAuditLogListOut` `:1022` | `access_service.list_audit_logs` |
| 55 | GET | `/api/admin/activity` | `get_activity` `:1046` | `require_menu("activity")` `:1048`（注入但**未使用**） | `AdminActivitySettingOut` `:1043` | `activity_service.get_admin_view` |
| 56 | PUT | `/api/admin/activity` | `save_activity` `:1058` | `require_menu("activity")` `:1061`（**注入**） | `AdminActivitySettingOut` `:1055` | `activity_service.update` |
| 57 | POST | `/api/admin/activity/publish` | `publish_activity` `:1077` | `require_menu("activity")` `:1080`（**注入**） | `AdminActivitySettingOut` `:1074` | `activity_service.set_published` |

**合计 57 行 = 57 个端点**（与 `app.openapi()` 实测、`router.routes` 长度、`grep -c '^@router\.'` 三方一致）。

### 4.4 三个模块级私有辅助函数

| 函数 | 行号 | 职责 |
|---|---|---|
| `_xlsx_response(content, filename)` | `:411-416` | 把 openpyxl 生成的 bytes 包成 `Response`，`media_type` 为 xlsx 官方 MIME，`Content-Disposition` 用 RFC 5987 的 `filename*=UTF-8''` + `urllib.parse.quote` 传中文文件名。被端点 19、29 复用 |
| `_read_import_file(file)` | `:419-426` | 上传文件的**类型与大小闸门**：① `:421-422` 文件名（小写化）不以 `.xlsx` 结尾 → 400「仅支持 .xlsx 文件，请使用下载的模板」；② `:423` 用 `file.file.read(import_service.MAX_FILE_SIZE + 1)` **多读 1 字节**做哨兵；③ `:424-425` 读到的字节数 > `MAX_FILE_SIZE`（2 MB，`backend/app/services/import_service.py:25`）→ 400「文件大小超过 2MB 限制」；④ 返回 bytes。**只读一次，不 seek 回卷**，因此调用方必须紧接着把 bytes 交给 service。被端点 20、30 复用 |
| `_actor(admin)` | `:752-754` | 把 `AdminPrincipal` 翻译成审计操作人二元组：超管 → `("super", None)`，微信关联管理员 → `("user", admin.user_id)`。被 12 个端点调用（`:338`、`:792`、`:811`、`:851`、`:874`、`:930`、`:950`、`:969`、`:988`、`:1011`、`:1063`、`:1082`） |

### 4.5 特殊链路 A：Excel 两段式导入（预览 → 确认）

本文件承载**两套结构完全对称、业务解析完全不同**的导入链路。三个端点为一组：

| 阶段 | 题库 | 每日寄语 |
|---|---|---|
| ① 模板下载 | `GET /questions/import-template` `:429-435` | `GET /quotes/import-template` `:582-588` |
| ② 上传预览 | `POST /questions/import-preview` `:438-452` | `POST /quotes/import-preview` `:591-605` |
| ③ 确认写入 | `POST /questions/import-confirm` `:455-466` | `POST /quotes/import-confirm` `:608-619` |

**协作时序**

1. **模板下载**：路由只调 `import_service.build_question_template()`（`backend/app/services/import_service.py:204`）/ `build_quote_template()`（`:321`），二者都由 `_build_workbook()`（`:107-121`）生成**双工作表** xlsx：数据表（仅表头，列宽 18）+「填写说明」表（列宽 100）。表头常量 `QUESTION_HEADERS`（12 列，`:179-182`）与 `QUOTE_HEADERS`（5 列，`:302`）。文件名硬编码在路由：`长征步迹_题库导入模板.xlsx` `:435`、`长征步迹_每日寄语导入模板.xlsx` `:588`。
2. **预览**：`_read_import_file` 先做扩展名/大小闸门（§4.4），随后把 bytes 与 `admin.username` 一起交给 `import_service.preview_question_import(db, content, operator)`（`:255-286`）/ `preview_quote_import`（`:358-392`）。service 内部：`_read_sheet`（`:58-104`）解析首个工作表并校验表头 → 逐行 `_parse_*_row` → 库内查重 + 文件内查重 → `_save_preview`（`:124-137`）把 `{rows, errors}` 以 JSON 存入 `import_previews` 表并 **`db.commit()`**，返回 `uuid.uuid4().hex` 一次性令牌，TTL 30 分钟（`PREVIEW_TTL_MINUTES = 30`，`:27`）。响应体 `AdminImportPreviewOut`（`backend/app/schemas/schemas.py:1123-1130`）= `{preview_token, total, valid_count, invalid_count, errors[{row, field, reason}]}`。
3. **确认**：路由只把 `payload.preview_token` 交给 `import_service.confirm_question_import`（`:289-298`）/ `confirm_quote_import`（`:395-410`），二者共用 `_confirm()`（`:140-175`）：查 `import_previews` → 校验 `biz_type` 匹配 → 校验未过期 → **`errors` 非空则整批拒绝** → `rows` 为空则拒绝 → **条件 UPDATE `status pending → confirmed` 原子核销令牌**（`claimed != 1` 则 400「该导入已确认，请勿重复提交」）→ 在同一事务内批量写入 → 失败 `db.rollback()` 并抛出（令牌恢复 `pending` 可重试）。响应 `AdminImportConfirmOut` = `{imported: int}`（`backend/app/schemas/schemas.py:1137-1138`）。

**预览 payload 的存放与令牌核销要点**

- payload **不进内存、不进缓存**，落 `import_previews` 表（迁移 `docker/init/011_import_previews.sql`），因此**多进程部署下预览与确认可以打到不同 worker**（与 WS 连接表、限流计数的进程内内存态形成对比，见 `.qoder/ARCHITECTURE.md` §15）。
- 令牌是 `uuid4().hex`（32 位十六进制），**不绑定操作人**：`created_by` 只写库供追溯，`_confirm()` 不校验「确认者 == 预览者」，也不校验令牌持有者与菜单权限之外的任何关系（权限由端点 21 / 31 的 `require_menu` 保证）。
- 令牌**一次性**：`token_issued` 式的条件 UPDATE 语义由 `status` 列承担；核销成功后同一令牌再次确认必得 400。

**两套导入的业务差异**

| 维度 | 题库 | 每日寄语 |
|---|---|---|
| 表头 | 12 列（题型 / 题目内容 / 选项 A~F / 正确答案 / 答案解析 / 分值 / 知识分类），`backend/app/services/import_service.py:179-182` | 5 列（寄语内容 / 出处 / 排序号 / 启用状态 / 关联节点），`:302` |
| `biz_type` | `"question"`（`:279`） | `"quote"`（`:385`）—— **令牌不可跨业务复用**，`_confirm()` `:152` 会因 `biz_type` 不匹配抛「预览不存在，请重新上传文件」 |
| 查重键 | `questions.question`（题干）strip 后精确比对，`:261`、`:269-276` | `daily_quotes.content` strip 后精确比对，`:364`、`:375-382` |
| 别名归一 | 题型 `单选/single`、`判断/judge`；分类 `历史事件/event`、`长征路线/route`、`历史人物/figure`（`:196-201`） | 启用状态 `启用/是/1` → True，`停用/禁用/否/0` → False，留空默认 True（`:318`）；关联节点接受**节点 ID 或节点名称**（`:340-348`） |
| 主键分配 | `max(questions.id) + offset` 连续分配（`:293-295`），与 `admin_service.create_question`（`backend/app/services/admin_service.py:175-176`）同口径 | 不显式给 id；**未填排序号的行**按 `max(库内 sort_order, 本批已填 sort_order) + 1` 依次自动分配，并被 `SORT_ORDER_MAX`（999999）夹住（`:398-408`） |
| 错误定位 | `_parse_question_row` 抛单参 `ValueError`，路由侧 `field` 记为空串 `""`（`:267`） | `_parse_quote_row` 抛**双参** `ValueError(字段名, 原因)`，`_fail(row_no, *exc.args)` 直接展开（`:373`），因此 `field` 能精确到列名 |
| 跨 service 依赖 | 复用 `admin_service._validate_question`（`backend/app/services/import_service.py:23`） | 复用 `quote_service.check_fields` / `CONTENT_MAX_LEN` / `SOURCE_MAX_LEN` / `SORT_ORDER_MAX`（`backend/app/services/import_service.py:22`、`:307-309`、`:333`） |

**共同的行级安全约束**（`backend/app/services/import_service.py:38-55` `_cell_text`）：单元格文本以 `=` / `+` / `@` 开头，或以 `-` 开头且其后不是数值 → 抛 `ValueError`，**整行判错**，防 Excel 公式注入；整数型浮点（如 `20.0`）还原为 `"20"`，避免分值/选项被污染。上限 `MAX_ROWS = 500`（`:26`），超限抛 `ImportError`。

**异常映射差异（重要）**：预览端点 `:451`、`:604` 捕获的是 `import_service.ImportError`（文件级错误：无法解析 / 表头不符 / 空文件 / 超行数），转 **400**；确认端点 `:464`、`:617` 捕获的是 `ValueError`，转 **400**。两者是**不同的异常类型**——`ImportError` 是 `backend/app/services/import_service.py:30-31` 自定义的 `Exception` 子类（**不是** Python 内置 `ImportError` 的别名，也**不继承** `ValueError`），因此预览端点**不会**捕获行解析阶段的 `ValueError`；但行解析的 `ValueError` 在 `preview_*_import` 内部已被逐行 `try/except` 收敛成 `errors` 列表（`:266-268`、`:372-374`），不会外泄。

### 4.6 特殊链路 B：流式 CSV 导出 `GET /rankings/export`

端点定义 `:347-362`，权限 `require_menu("rankings")` 在 **`:350`**（`dependencies=[...]` 形式，不注入主体）。

```
:352-356  查询参数：keyword(str, max_length=64) / org_id(Optional[int]) / only_changed(bool)
          —— 与 GET /rankings 的筛选参数同名同义，但 **没有 page / page_size**：导出全部命中行
:357      filename = quote(f"全员长征排名_{datetime.now().strftime('%Y-%m-%d')}.csv")
:358-362  StreamingResponse(
              admin_service.iter_rank_csv(keyword, org_id, only_changed),
              media_type="text/csv; charset=utf-8",
              headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"})
```

**如何避免全量载入内存**（事实取自 `backend/app/services/admin_service.py:433-485`）：

- `iter_rank_csv` 是**生成器函数**（`-> Iterator[str]`），路由只负责把它交给 `StreamingResponse`；FastAPI 在**路由函数返回之后**才逐块消费。
- 数据侧 `:458` 用 `.yield_per(RANK_EXPORT_BATCH)`（`RANK_EXPORT_BATCH = 1000`，`backend/app/services/admin_service.py:238`）建立服务端游标，`:460` 用 `itertools.islice` 每次切 1000 行；每批只对本批 `user_id` 调一次 `_reached_map`（`:463`）查点亮记录，**不做全表 N+1**。
- 输出侧 `:439-446` 复用一个 `io.StringIO` 缓冲：`flush()` 取走当前内容后 `seek(0)` + `truncate(0)` 清空，因此内存中最多只驻留一批（1000 行）的 CSV 文本。
- `:456` 首块前置 `"\ufeff"`（**UTF-8 BOM**），保证 Excel 打开中文不乱码；`:440` `csv.writer(..., quoting=csv.QUOTE_ALL, lineterminator="\r\n")` 全字段加引号、CRLF 换行。
- 表头 `:452-455`：11 个固定列 + **每个启用路线节点一列「{节点名}到达时间」**（列数随 `route_nodes.is_enabled` 变化，不是固定宽度）。
- 防公式注入 `:423-426` `_csv_text`：以 `=` `+` `-` `@` 开头的单元格前置单引号；应用于昵称、曾用名、组织名与节点列名（`:454`、`:471-474`）。时间列走 `_export_time`（`:429-430`，`to_local` 转北京时间后 `%Y/%m/%d %H:%M`），未到达时写字面量 `"尚未到达"`（`:481`）。

**`iter_rank_csv` 自建 `SessionLocal` —— 刻意为之，不是隐患**：

- 代码事实：`backend/app/services/admin_service.py:438` `db = SessionLocal()`，`:484-485` `finally: db.close()`。`SessionLocal` 从 `backend/app/core/database.py` 直接 import（`backend/app/services/admin_service.py:19`），**绕过了 `Depends(get_db)`**。函数 docstring `:436` 已写明理由：「响应体在路由返回后才被逐块消费，不能依赖请求级会话」。
- 为什么必须如此：`backend/app/core/database.py` 的 `get_db()` 在 `finally` 中 `db.close()`，其生命周期与**请求处理**绑定；而 `StreamingResponse` 的生成器在响应阶段（路由已 return）才执行，此时注入的 Session 已关闭，继续查询会抛错。因此这是**由 FastAPI/Starlette 生命周期决定的必然选择**，`.qoder/ARCHITECTURE.md` §8.3 亦记载这是「全项目唯一的服务层自建 Session 例外」。
- 客观代价（如实记录，非缺陷指控）：① 会话不受 `get_db` 的统一关闭保障，靠生成器自身的 `finally` 兜底——若客户端中途断开导致生成器被 GC 而非正常耗尽，`finally` 仍会执行（`GeneratorExit` 会触发），但**连接归还时机依赖 GC**；② 长导出期间会**独占一条连接**（`core/database.py` 未配置连接池参数，使用 SQLAlchemy 默认 QueuePool）；③ 该 Session **不参与请求级事务**，导出过程中读到的是各批查询时刻的快照，跨批数据可能不一致（最终一致，非可重复读）。
- 与 `backend/AGENTS.md` §4 不变量 6「禁止在 service 内自建 session」的关系：该不变量的原文是「一律通过 `Depends(get_db)` 获取，禁止在 service 内自建 session；session 由依赖自动关闭」。`iter_rank_csv` **在字面上违反**此条，但属流式响应的必要例外，且已在 `.qoder/ARCHITECTURE.md` §3.1 / §8.3 与 `REQUIREMENTS.md` §11.6 登记为已知例外。**AGENTS.md 本身未记载该例外**（见 §9「与约定不符之处」）。

### 4.7 微信扫码登录链路（登录前）

三个端点全部**不挂任何鉴权依赖**，只有 IP 限流：

1. `POST /wechat/qr`（`:119-139`）：`identity_service.create_login_session(db)` 生成 `qrId`（`secrets.token_urlsafe(18)`）与 `scene` 明文（`"L" + token_urlsafe(16)`，≤32 字符），**库里只存 scene 的 SHA-256 摘要**（`backend/app/services/identity_service.py:43-55`）；随后 `wechat_service.get_wxacode_png(scene_token)` 出小程序码。**mock 模式**：未配置微信凭证或调用失败时 `png is None`，`image` 返回 `None` 并把 `scene` **明文回传**供开发直连（`:132-137`）——这是登录前接口，明文 scene 即登录凭证，生产环境依赖微信凭证已配置来避免走 mock 分支。`expires_in` 取 `settings.QR_LOGIN_TTL_SECONDS`（默认 300，`backend/app/core/config.py:56`）。
2. 小程序侧扫码确认由 `backend/app/api/routes/identity.py` 承担（不在本文件），确认后把会话置 `confirmed` 并写审计 `admin.login.qr`（`backend/app/services/identity_service.py:99-119`）。
3. `GET /wechat/qr/{qr_id}/status`（`:142-175`）：`poll_login_session` 惰性把过期的 `pending` 会话置 `expired`（`backend/app/services/identity_service.py:74-82`）；会话不存在 → 404（`:152`）。`status == "confirmed"` 时调 `identity_service.issue_admin_token(db, qr_id)`，后者用 `UPDATE ... WHERE token_issued = false` **原子地单次签发**（`backend/app/services/identity_service.py:122-134`），已签发过返回 `None`。签发成功则 `create_admin_token_for_user(user.id)`（`typ="user"`，12 小时）+ `is_super: False` + 菜单列表一并返回（`:163-170`）。
   - **`build_principal` 的兜底分支**（`:158-161`）：若 `build_principal` 返回 `None`（确认后被撤销全部角色），代码 `or {"username": user.nickname, "menus": []}` 兜底，**仍会签发令牌并返回 `status: confirmed`、空菜单**。后续任何受保护请求会被 `get_current_admin` 拦成 403「后台访问权限已被撤销或禁用」（`backend/app/api/deps.py:143-146`）。这是防御性写法，但会造成「拿到了令牌却什么都点不开」的观感（`:158-161` 的实际业务意图**待确认**）。
   - **第二次轮询拿不到令牌**：`token_issued` 已为 True，`issue_admin_token` 返回 `None`，控制流落到 `:171-175` 返回 `{status: "confirmed", fail_reason: None, expires_in}` —— **无 `token` 字段**（`AdminQrStatusOut.token` 为 `Optional`，`backend/app/schemas/schemas.py:947`）。前端必须在第一次拿到 `confirmed + token` 时立即落盘。
   - `expires_in` 计算 `:153` `max(0, int((session.expires_at - datetime.utcnow()).total_seconds()))`，基于 UTC naive。
4. `GET /me`（`:178-195`）：**唯一直接依赖 `get_current_admin`** 的端点（不经 `require_menu`），因此**任何有效管理员令牌都能调用，不受菜单权限限制**。超管 → `access_service.get_all_menu_items(db)`（全部 16 个菜单码，按 `sort_order` 排序）、`is_super: True`、`roles: []`；微信关联管理员 → `get_menu_items(db, admin.menus)`（角色菜单并集）、`is_super: False`、`roles` 为角色 code 列表。前端据此渲染侧边栏。

### 4.8 账号密码登录 `POST /login`（登录前）

`:101-115`。执行顺序**不可调换**：

1. `:107` 先过限流 `rate_limit.login_limiter`（10 次/分/IP，`backend/app/core/rate_limit.py:31`）—— 因此**密码错误的尝试也计入配额**。
2. `:108-109` `settings.ADMIN_PASSWORD` 为空 → **403**「未配置管理账号密码，请使用微信扫码登录」。这是「功能未启用」而非「权限不足」，与 `.qoder/REQUIREMENTS.md` §11.1「`ADMIN_PASSWORD` 未配置时账号登录禁用」一致（`backend/app/core/config.py:60-61` 默认 `ADMIN_USERNAME="admin"`、`ADMIN_PASSWORD=""`）。
3. `:110-114` 用户名或密码与配置不符 → **401**「用户名或密码错误」（统一文案，不区分是用户名错还是密码错）。比较为普通 `!=` 字符串比较（`:111-112`）。
4. `:115` 成功 → `create_admin_token(payload.username)` 签发 `typ="super"` 超管令牌（12 小时，`backend/app/core/security.py:22-32`），返回 `{token, username}`。

## 5. 输入与输出

### 5.1 路径参数

| 参数 | 类型 | 出现端点 |
|---|---|---|
| `qr_id` | `str` | 3 |
| `node_id` | `int` | 11、12 |
| `question_id` | `int` | 22、23 |
| `quote_id` | `int` | 33、34 |
| `org_id` | `int` | 36、38、39 |
| `user_id` | `int` | 16、42、43、52、53 |
| `invite_id` | `int` | 46、47 |
| `role_id` | `int` | 50、51、53 |

**无任何路径参数带 `Path(...)` 校验约束**（无 `ge=` / `pattern=`），非法值由 FastAPI 的类型转换直接返回 422。

### 5.2 查询参数（逐字取自源码）

| 端点 | 参数 |
|---|---|
| 6 `/dashboard/trend` | `days: int = Query(7, ge=1, le=90)` `:216` |
| 7 `/activities` | `limit: int = Query(50, ge=1, le=200)` `:228` |
| 13 `/rankings` | `page: Query(1, ge=1)`、`page_size: Query(50, ge=1, le=200)`、`keyword: Query("", max_length=64)`、`org_id: Optional[int] = Query(None)`、`only_changed: bool = Query(False)` `:319-323` |
| 15 `/rankings/export` | `keyword: Query("", max_length=64)`、`org_id: Optional[int] = Query(None)`、`only_changed: bool = Query(False)` `:353-355`（**无分页参数**） |
| 17 `/questions` | `page: Query(1, ge=1)`、`page_size: Query(20, ge=1, le=100)`、`keyword: Query("")`、`qtype: Query("")`、`category: Query("")` `:387-391` —— **`keyword`/`qtype`/`category` 三者均无 `max_length` 与 `pattern`**，与端点 13、26、41、44、54 的 `keyword: Query("", max_length=64)` 不一致 |
| 26 `/quotes` | `page`、`page_size: Query(20, ge=1, le=100)`、`keyword: Query("", max_length=64, description="按内容/出处模糊搜索")` `:549-551` |
| 36 `/orgs/{org_id}/users` | `scope: Query("direct", pattern="^(direct\|all)$")`、`page: Query(1, ge=1)`、`page_size: Query(20, ge=1, le=100)` `:684-686` |
| 41 `/users` | `page`、`page_size: Query(20, ge=1, le=100)`、`keyword: Query("", max_length=64)`、`org_id: Optional[int] = Query(None)`、`has_access: Optional[bool] = Query(None)`、`status: Query("", pattern="^(\|active\|disabled)$")` `:763-768` |
| 44 `/invites` | `page`、`page_size: Query(20, ge=1, le=100)`、`keyword: Query("", max_length=64)` `:830-832` |
| 54 `/audit-logs` | `page`、`page_size: Query(20, ge=1, le=100)`、`action: Query("", max_length=64)`、`actor_type: Query("", pattern="^(\|super\|user)$")`、`date: Query("", pattern="^(\|\d{4}-\d{2}-\d{2})$")` `:1026-1030` |

分页统一 `page`（从 1 起）+ `page_size`，响应统一 `{total, items}`（列表类端点由路由手工组装：`:252`、`:395`、`:555`、`:775`、`:837`、`:1037`；`/rankings` 与 `/activity` 由 service 直接返回完整结构）。

### 5.3 请求体模型

| 端点 | 请求体 | 定义位置 |
|---|---|---|
| 1 | `AdminLoginRequest` | `backend/app/schemas/schemas.py:849-851` |
| 10、11 | `AdminRouteNodeUpsert` | `backend/app/schemas/schemas.py:1368-1384`（`name` 1~50、`icon` ≤16、`target_steps ≥0`、`latitude ∈[-90,90]`、`longitude ∈[-180,180]`、`sort_order ≥0`、`brief ≤200`、`figures ≤500`、`location ≤100`、`audio ≤500`、`keywords ≤200`） |
| 12 | `AdminRouteNodeEnabled` | `backend/app/schemas/schemas.py:1387-1388`（`is_enabled: bool`） |
| 14 | `AdminPointsVerifyRequest` | `backend/app/schemas/schemas.py:1530-1534`（`fix: bool = False`、`user_ids: Optional[List[int]] = None`，为空表示全员核对） |
| 18、22 | `AdminQuestionUpsert` | `backend/app/schemas/schemas.py:1060` |
| 20、30 | `UploadFile = File(...)`（`multipart/form-data`，字段名 `file`） | `backend/app/api/routes/admin.py:444`、`:597`；前端组装见 `admin/src/api/admin.ts:643-647` |
| 21、31 | `AdminImportConfirmRequest` | `backend/app/schemas/schemas.py:1133-1134`（`preview_token: str`） |
| 24 | `AdminAiGenerateRequest` | `backend/app/schemas/schemas.py:1142-1154`（`topic` 必填、`count` 默认 10 且 `ge=1 le=100`、`question_type="single"`、`difficulty="medium"`、`category=""`、`extra_requirements=""`） |
| 25 | `AdminAiBatchSaveRequest` | `backend/app/schemas/schemas.py:1179-1182`（`questions: List[AdminQuestionUpsert]`） |
| 28 | `AdminQuoteCycleUpdate` | `backend/app/schemas/schemas.py:1108-1111`（`start_date: str`，YYYY-MM-DD） |
| 32、33 | `AdminQuoteUpsert` | `backend/app/schemas/schemas.py:1089-1096`（`content`、`source`、`sort_order=0`、`is_enabled=True`、`node_id=None`） |
| 37、38 | `AdminOrgUpsert` | `backend/app/schemas/schemas.py:1287-1292`（`name`、`parent_id=None`、`sort_order=0`；**`level` 不接受入参，由后端按父节点算**） |
| 42 | `AdminUserStatusRequest` | `backend/app/schemas/schemas.py:930` |
| 43 | `AdminUserOrgRequest` | `backend/app/schemas/schemas.py:934` |
| 45 | `AdminInviteCreate` | `backend/app/schemas/schemas.py:913`（继承 `_InviteExpiry`） |
| 46 | `AdminInviteUpdate` | `backend/app/schemas/schemas.py:920`（继承 `_InviteExpiry`，**全部字段可选**，路由用 `model_dump(exclude_unset=True)` `:870` 做部分更新） |
| 49、50 | `AdminRoleUpsert` | `backend/app/schemas/schemas.py:1000-1002`（`name` 1~32、`menus: List[str] = []`） |
| 52 | `AdminUserRolesRequest` | `backend/app/schemas/schemas.py:1005-1006`（`role_ids: List[int] = []`，**全量覆盖**语义） |
| 53 | `AdminRoleEnabledRequest` | `backend/app/schemas/schemas.py:1009-1010`（`is_enabled: bool`） |
| 56 | `AdminActivitySettingUpdate` | `backend/app/schemas/schemas.py:1603-1612`（`name` 1~64、`start_at` / `end_at` 为 `datetime`（**按北京时间解释**）、`restrict_enabled=True`、`allow_view_after_end=True`、`end_title ≤64`、`end_message ≤500`） |
| 57 | `AdminActivityPublishRequest` | `backend/app/schemas/schemas.py:1615-1616`（`published: bool`） |

**全部 `Admin*` schema 均为普通 `BaseModel`，输出 snake_case**（`.qoder/ARCHITECTURE.md` §4.2 双命名契约）。唯一例外是 `MessageOut`（`backend/app/schemas/schemas.py:728-729`）继承 `CamelModel`，但它只有 `message` 一个字段，camelCase 与 snake_case 同形，**不产生契约差异**。

### 5.4 输出与错误码

**无统一响应外壳**：2xx 直接返回业务 payload（`.qoder/ARCHITECTURE.md` §4.1）。错误一律 `HTTPException` → FastAPI 默认 `{"detail": ...}`。

本文件实际抛出的状态码（`grep -n 'status_code='` 全量核对，共 45 处）：

| 码 | 语义 | 抛出位置（`backend/app/api/routes/admin.py`） |
|---|---|---|
| 400 | 业务校验失败 | `:267`、`:284`、`:306`、`:408`、`:422`、`:425`、`:452`、`:465`、`:481`、`:521`、`:538`、`:578`、`:605`、`:618`、`:632`、`:646`、`:706`、`:719`、`:790`、`:796`（条件）、`:856`、`:872`、`:878`（条件）、`:935`、`:955`、`:972`、`:994`（条件）、`:1069`、`:1088` |
| 401 | 账号密码错误 | **仅 `:114`**（其余 401 全部来自 `backend/app/api/deps.py`） |
| 403 | 未配置 `ADMIN_PASSWORD`（功能未启用） | **仅 `:109`**（其余 403 来自 `deps.py` 的 `require_menu` / `_ensure_active`） |
| 404 | 资源不存在 | `:152`（扫码会话）、`:286` / `:308`（路线节点）、`:375`（用户）、`:483`（题目）、`:649` / `:661`（寄语）、`:692`（组织）、`:721`（组织）、`:796`（条件）、`:817`、`:878`（条件）、`:895`（邀请码）、`:994`（条件）、`:1016` |
| 429 | 触发限流 | 由 `backend/app/core/rate_limit.py:42-45` 抛出，触发点 `:107`、`:129`、`:149` |
| 502 | 上游故障 | `:519`（CloudBase Agent）、`:748`（外部组织架构接口） |
| 422 | 请求体/查询参数 Pydantic 校验失败 | FastAPI 框架自动产生，源码中无显式抛出 |

**未使用 409**（与全项目一致，冲突语义由 400 承载）；**无 500 显式抛出**（未捕获异常由 FastAPI 默认转 500，本文件无全局异常处理器可依赖）。

**三个端点无 `response_model`**（15、19、29）：实测 `app.openapi()` 中它们的 200 响应为 `{"content": {"application/json": {"schema": {}}}}` —— 即 **Swagger 把它们标注成返回空 JSON 对象**，而实际 `Content-Type` 分别是 `text/csv; charset=utf-8` 与 xlsx MIME。属二进制/流式响应的既有取舍（详见 §9）。端点 39（`DELETE /orgs/{org_id}`）装饰器内没有 `response_model=`，但函数签名有 `-> MessageOut` 返回注解，FastAPI 据此推导出 response model，实测 OpenAPI 正确显示 `MessageOut`。

## 6. 依赖关系

### 6.1 本文件依赖的模块

| 层 | 模块 | 用到的成员 |
|---|---|---|
| `api/deps` | `backend/app/api/deps.py` | `AdminPrincipal`（`backend/app/api/deps.py:84-106`）、`get_current_admin`（`backend/app/api/deps.py:109-147`）、`require_menu`（`backend/app/api/deps.py:150-160`）。详见 `.qoder/backend/app/api/deps.py.md` |
| `core` | `backend/app/core/rate_limit.py` | `login_limiter`（10/分/IP）、`qr_create_limiter`（10/分/IP）、`qr_poll_limiter`（60/分/IP）、`require_rate` |
| `core` | `backend/app/core/ws.py` | `broadcast`、`build_event` —— **仅 `:819` 一处调用** |
| `core` | `backend/app/core/config.py` | `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`QR_LOGIN_TTL_SECONDS`、`WXACODE_ENV_VERSION` |
| `core` | `backend/app/core/database.py` | `get_db` |
| `core` | `backend/app/core/helpers.py` | `today_str`（北京时间当日 YYYY-MM-DD）—— `:565`、`:579` |
| `core` | `backend/app/core/security.py` | `create_admin_token`（`typ="super"`）、`create_admin_token_for_user`（`typ="user"`） |
| `schemas` | `backend/app/schemas/schemas.py` | 40 个 `Admin*` 模型 + `MessageOut` |
| `services` | `access_service` | `build_principal`、`get_menu_items`、`get_all_menu_items`、`list_users`、`list_roles`、`create_role`、`update_role`、`delete_role`、`grant_roles`、`set_role_enabled`、`list_audit_logs` |
| `services` | `activity_service` | `get_admin_view`、`update`、`set_published` |
| `services` | `admin_service` | `list_route_nodes`、`create_route_node`、`update_route_node`、`set_route_node_enabled`、`get_rank_overview`、`iter_rank_csv`、`get_user_overview`、`list_questions`、`create_question`、`update_question`、`delete_question`、`get_org_tree`、`get_org_users`、`create_org`、`update_org`、`delete_org`、`sync_orgs` |
| `services` | `ai_question_service` | `generate_questions`、`batch_save_questions` |
| `services` | `audit_service` | `record`（**路由内直接调用仅 `:339` 一处**） |
| `services` | `cloudbase_service` | `CloudBaseError`（仅用于 `:517` 的异常类型判定） |
| `services` | `dashboard_service` | `get_dashboard`、`get_trend`、`get_activities`、`get_screen` |
| `services` | `identity_service` | `create_login_session`、`poll_login_session`、`issue_admin_token` |
| `services` | `import_service` | `MAX_FILE_SIZE`、`ImportError`、`build_question_template`、`build_quote_template`、`preview_question_import`、`confirm_question_import`、`preview_quote_import`、`confirm_quote_import` |
| `services` | `invite_service` | `list_invites`、`create_invite`、`update_invite`、`get_invite`、`scene_of`、`set_user_status` |
| `services` | `org_service` | `admin_set_user_org` |
| `services` | `points_service` | `recompute_all` |
| `services` | `quote_service` | `list_quotes`、`get_cycle_info`、`set_cycle_start`、`validate_quote`、`create_quote`、`update_quote`、`delete_quote`、`get_admin_out` |
| `services` | `wechat_service` | `get_wxacode_png`、`get_invite_image`、`to_data_url`、`ONBOARD_PAGE` |
| `models` | `backend/app/models/models.py` | `User`（`:22` import，**未被使用**，见 §9） |

**未 import 但被间接使用的关键依赖**：`python-multipart`（`File(...)` / `UploadFile` 的底层解析，无 import 语句，删掉后端点 20、30 运行时才报错，见 `.qoder/backend/requirements.txt.md` §4）。

### 6.2 涉及的数据库表

`users`、`route_nodes`、`questions`、`daily_quotes`、`system_settings`（寄语循环起始日）、`activity_settings`、`organizations`、`daily_sport`、`lit_nodes`、`quiz_records`、`points_log`、`user_medals`、`user_event`、`invite_codes`、`qr_login_sessions`、`admin_menus`、`admin_roles`、`admin_role_menus`、`admin_user_roles`、`audit_logs`、`import_previews`。**全部经 service 层访问，本文件零 SQL、零 ORM 查询表达式**（`grep` 核实：无 `db.query(`、无 `select(`）。

### 6.3 被谁依赖

- **`backend/app/main.py:86`**：`app.include_router(admin.router, prefix=_prefix)` 注册。
- **`admin/src/api/admin.ts`**（唯一调用方，20800 字节）：实测提取出 38 个 URL 模板 + 7 处导入/AI 相关模板字符串（`admin/src/api/admin.ts:654-656`、`:707`、`:741-743`），**57 个端点全部有前端调用点，无死端点**。三个导入接口经 `downloadImportTemplate` / `previewImport` / `confirmImport` 三个内部 helper（`admin/src/api/admin.ts:639-651`）封装后，以 `questionImportApi`（`admin/src/api/admin.ts:653-657`）与 `quoteImportApi`（`admin/src/api/admin.ts:740-744`）两个对象注入通用组件 `admin/src/components/ExcelImportDialog.vue` 的 `api` prop —— **同一组件复用于题库与寄语两个场景**。
- **小程序 `frontend/` 不调用本文件任何端点**（本文件契约面向管理后台）。

## 7. 业务规则

### 7.1 权限模型

- **无「超管专属」端点**：57 个端点中没有任何一个把 `admin.is_super` 用作准入门槛。超管之所以能访问全部端点，是因为 `AdminPrincipal.has_menu(code)` 实现为 `return self.is_super or code in self.menus`（`backend/app/api/deps.py:105-106`）—— 超管**绕过菜单码校验**。`is_super` 在本文件只出现在两处非准入用途：`admin_me`（`:183`，决定返回全部菜单还是角色菜单并集）与 `set_user_status`（`:789`，自改保护）。
- **`require_menu` 用到的菜单码共 11 个（去重后）**，逐字取自源码：

  | 菜单码 | 端点数 | 端点编号（§4.3） | 源码行号 |
  |---|---|---|---|
  | `dashboard` | 3 | 5、6、7 | `:203`、`:213`、`:225` |
  | `screen` | 1 | 8 | `:237` |
  | `route_nodes` | 4 | 9、10、11、12 | `:248`、`:259`、`:274`、`:294` |
  | `rankings` | 4 | 13、14、15、16 | `:316`、`:332`、`:350`、`:369` |
  | `questions` | 9 | 17~25 | `:384`、`:402`、`:432`、`:446`、`:459`、`:473`、`:491`、`:504`、`:528` |
  | `quotes` | 9 | 26~34 | `:546`、`:562`、`:572`、`:585`、`:599`、`:612`、`:626`、`:640`、`:657` |
  | `orgs` | 6 | 35~40 | `:670`、`:680`、`:700`、`:713`、`:728`、`:741` |
  | `access` | 9 | 41、42、43、48、49、50、51、52、53 | `:770`、`:787`、`:809`、`:914`、`:927`、`:947`、`:966`、`:985`、`:1008` |
  | `invites` | 4 | 44、45、46、47 | `:834`、`:848`、`:868`、`:889` |
  | `audit` | 1 | 54 | `:1032` |
  | `activity` | 3 | 55、56、57 | `:1048`、`:1061`、`:1080` |
  | **合计** | **53** | — | — |

  53 + 4（端点 1~4 不挂 `require_menu`）= **57**。菜单码是 `rankings`（**不是 `rank`**）、`route_nodes`（**不是 `route-nodes`**，路径用连字符、菜单码用下划线）、`orgs`（**不是 `org`**）、`quotes`（**不是 `quote`**）。

- 这 11 个码与 `admin/src/router/menus.ts:3-15` 登记的 11 个前端菜单**一一对应，无多无少**。数据库 `admin_menus` 另有 5 个 `ai_*` 码（`docker/init/022_ai_admin_menus.sql`），其中 `ai_knowledge` / `ai_workshop` / `ai_config` 被 `backend/app/api/routes/ai_admin.py` 使用；**`ai_overview` 与 `ai_logs` 在 `backend/app/` 与 `admin/src/` 中均无任何引用**（`grep -rn '"ai_overview"\|"ai_logs"'` 零命中）—— 属预留菜单码。
- **权限不在令牌里**：`typ="user"` 的管理员令牌只含 `sub` / `role` / `typ`，`get_current_admin` 每请求查库经 `access_service.build_principal` 重建 `roles` / `menus`（`backend/app/api/deps.py:142`），撤销授权或禁用角色**即时生效**（`.qoder/ARCHITECTURE.md` §5.1 / 不变量 8）。
- **鉴权豁免的 3 个端点**：1（`POST /login`）、2（`POST /wechat/qr`）、3（`GET /wechat/qr/{qr_id}/status`）—— 全部是**登录前**必须先能调通的端点。它们不挂任何 `Depends(get_current_admin)`，防护手段只有 IP 限流 + （端点 3 的）`qr_id` 随机性（`secrets.token_urlsafe(18)`）+ 令牌单次签发。端点 4（`GET /me`）挂 `get_current_admin` 但**不挂 `require_menu`**，因此对任何有效管理员令牌开放。
- `backend/AGENTS.md` §4 不变量 2 原文是「除 `POST /api/auth/login` 外，所有路由必须依赖 `Depends(get_current_user)`」—— 该条针对**小程序侧**；管理端对应的是 `get_current_admin` / `require_menu`，AGENTS.md 未单独成文（见 §9）。

### 7.2 审计写入

`audit_service.record(db, actor_type, actor_user_id, action, target_user_id, detail)`（`backend/app/services/audit_service.py:14-36`）**只 `db.add`、不 commit**（该文件 docstring `:1-5` 明确「调用方在同一事务内完成业务变更与审计写入后统一 commit」）。

本文件 57 个端点中，**13 个会产生审计记录**：

| 端点 | action 码 | 写入位置 | 是否条件写入 |
|---|---|---|---|
| 14 `POST /points/verify` | `points.recompute` | **路由内** `:339-342`，路由 `:343` commit | 仅 `payload.fix=True` 时（`:337`）；detail 含 `operator` + `users` / `checked_days` / `fixed` |
| 42 `PATCH /users/{id}/status` | `user.enable` / `user.disable` | `backend/app/services/invite_service.py:234-239`（service commit） | 仅 `user.status != status` 时（`:232`） |
| 43 `PUT /users/{id}/org` | `user.org_change` | `backend/app/services/org_service.py:137-147` | 仅组织实际变更时；未变更走 `db.rollback()` 并返回 `False`（`backend/app/services/org_service.py:132-134`） |
| 45 `POST /invites` | `invite.create` | `backend/app/services/invite_service.py:188-192` | 无条件 |
| 46 `PATCH /invites/{id}` | `invite.update` | `backend/app/services/invite_service.py:210-214`（detail 记 `sorted(fields)`，**不记旧值**） | 无条件（即使字段值未变） |
| 49 `POST /roles` | `access.role.create` | `backend/app/services/access_service.py:242-245` | 无条件 |
| 50 `PUT /roles/{id}` | `access.role.update` | `backend/app/services/access_service.py:294-297` | 无条件 |
| 51 `DELETE /roles/{id}` | `access.role.delete` | `backend/app/services/access_service.py:312-319` | 无条件 |
| 52 `POST /users/{id}/roles` | `access.roles.grant` / `access.roles.revoke` / `access.role.enable` | `backend/app/services/access_service.py:346-367` | **逐项**写入（每个新增/回收/重新启用的角色各一条） |
| 53 `PATCH /users/{id}/roles/{rid}/enabled` | `access.role.enable` / `access.role.disable` | `backend/app/services/access_service.py:387-395` | 仅 `row.enabled != is_enabled` 时（`:383-384` 提前 return） |
| 56 `PUT /activity` | `activity.update` | `backend/app/services/activity_service.py:182-186`（detail 含 `before` / `after` 完整快照） | 无条件 |
| 57 `POST /activity/publish` | `activity.publish` / `activity.unpublish` | `backend/app/services/activity_service.py:199-202` | 无条件 |

另有 1 条**不由本文件触发**但与之相关的审计：`admin.login.qr`（扫码登录后台）由 `identity_service.confirm_login` 在**小程序侧** `backend/app/api/routes/identity.py` 的确认接口中写入（`backend/app/services/identity_service.py:117-118`），本文件的端点 3 只负责签发令牌、不写审计。

**未写审计的写操作端点**（事实陈述）：9~12（路线节点增改启停）、18 / 22 / 23（题目增改删）、21 / 31（导入确认）、25（AI 题目批量入库）、32 / 33 / 34（寄语增改删）、28（寄语循环起始日）、37 / 38 / 39 / 40（组织增改删与同步）**全部不写审计**。`admin/src/views/AuditView.vue:51-72` 的 `ACTION_TEXT` 共 20 个 action 码，与上表 + `admin.login.qr` + `identity.bind.confirm` + `identity.unbind` + `user.onboard` 完全对应，**无未映射的 action，也无映射了但后端不产生的 action**。

**审计失败是否影响主流程**：`audit_service.record` **没有任何 try/except**，`json.dumps(detail)` 失败或 `db.add` 失败都会向上抛出，导致整个请求 500 且业务变更回滚。即**审计写入与业务变更同生共死，不存在「业务成功但审计静默丢失」的情况**，反之也不存在「审计失败但业务成功」的降级路径。

### 7.3 事务边界

- **约定**：service 层自 commit（`backend/AGENTS.md` §3.1、`.qoder/ARCHITECTURE.md` §9.4）。本文件遵循该约定的 56 个端点**路由层零 commit**。
- **唯一例外**：端点 14 `POST /points/verify` 在路由内 `db.commit()`（`:343`）。原因是 `points_service.recompute_all` → `_recompute`（`backend/app/services/points_service.py:316-336`）**已按批自行 commit**（`:328-329`，`fix=True` 时每批一次），而路由随后 `audit_service.record` 只 `db.add`，必须自己 commit 才能把审计落库 —— 这正是 `backend/app/services/audit_service.py:1-5` docstring 所述的「service `db.add`，路由 `commit`」约定的应用场景。**注意此处的语义割裂**：积分修复与审计**不在同一事务**（前者已按批提交），若审计写入失败，积分修复不会回滚。与其它 12 个端点「变更 + 审计原子落库」的保证不同。
- **无 `db.rollback()` 出现在本文件**；回滚全部由 service 内部或 `get_db` 的会话关闭处理。

### 7.4 其它业务规则（本文件承载的部分）

| 规则 | 位置 | 说明 |
|---|---|---|
| 禁止修改自己的账号状态 | `:789-790` | `if not admin.is_super and admin.user_id == user_id` → 400「不能修改自己的账号状态」。**超管可改任何用户**（`is_super` 时 `user_id` 为 `None`，条件短路） |
| 部分更新的显式非空校验 | `:870-872` | `AdminInviteUpdate.model_dump(exclude_unset=True)` 后，若 `name` 或 `is_enabled` **显式传了 `null`** → 400「名称与启用状态不能为空」。注意 `fields.get(key, "")` 的默认值是 `""`，**未传该键不会触发**，只有传了 `None` 才触发 |
| 组织调整触发 WS 通知 | `:818-819` | 仅当 `changed=True` 时 `ws_manager.broadcast(ws_manager.build_event("org.select", user_id))`。`data_changed` 消息**不携带业务数据**，管理端收到后自行重拉（`.qoder/ARCHITECTURE.md` §6.3）。这是**本文件唯一的 WS 推送点** |
| 组织删除是「子树删除 + 引用保留」 | `:731-734` | `admin_service.delete_org`（`backend/app/services/admin_service.py:733-762`）返回被保留的节点 id 列表（被用户引用的节点及其全部祖先）；非空时 message 为「部分节点仍被用户引用已保留：{ids}」，空时为「已删除」。**组织不存在时返回 `[]`，路由仍答「已删除」，不返回 404** |
| 题目删除是**软停用**且幂等 | `:493-495` | `admin_service.delete_question`（`backend/app/services/admin_service.py:196-205`）置 `active=False`；题目不存在或已停用**静默返回**，路由恒答 `{"message": "已删除"}`，**不返回 404**。与端点 34（寄语硬删除、不存在返回 404 `:660-661`）语义不一致 |
| 寄语的字段校验在**路由层**调用 | `:630-632`、`:644-646` | 路由先调 `quote_service.validate_quote(...)` 取错误串再抛 400，而不是让 service 抛 `ValueError`。这是全文件唯一「路由主动调校验函数」的写法 |
| 路线节点启停的完整性约束 | `:301-306` | `admin_service.set_route_node_enabled` → `_validate_enabled_route`（`backend/app/services/admin_service.py:124-138`）：启用节点集非空、且按 `sort_order` 目标步数**严格递增**，违反抛 `ValueError` → 400。校验失败时 service 内部 `db.rollback()`（`backend/app/services/admin_service.py:93-95`） |
| 组织父节点防环 | `:716-719` | `admin_service.update_org`：父节点不能是自身、不能是自身的子孙（`backend/app/services/admin_service.py:714-719`）→ `ValueError` → 400 |
| 排名导出与排名列表**同口径** | `:326` vs `:359` | 二者共用 `admin_service._ranked_user_query` + `_filter_rank_users`（`backend/app/services/admin_service.py:250-289`），筛选参数一致；差别仅在列表分页取当前页、导出遍历全部（`docs/迭代记录.md` `b5d6035` 条目记载「92 人全量翻页逐字段相等」） |
| CSV 文件名含**服务器本地日期** | `:357` | `datetime.now()`（本地时区）而非 `today_str()`（北京时间 UTC+8）。跨时区部署时文件名日期可能与业务日切分不一致（当前生产与开发均为北京时间，无实际影响） |

## 8. 修改约束

1. **端点数与路径是前端硬契约**：`admin/src/api/admin.ts` 有 57 个端点的全部调用点（§6.3）。改路径 / 方法 / 字段名 = 破坏性变更，必须同步改 `admin/src/api/admin.ts` 与相关视图，并按 `backend/AGENTS.md` §6.2「改接口必改三处」同步 `routes` / `services` / `schemas`。
2. **snake_case 不可动**：本文件所有响应用 `Admin*`（普通 `BaseModel`）。给管理端响应加 camelCase 字段、或把 `Admin*` 改成继承 `CamelModel`，会整体错位（`.qoder/ARCHITECTURE.md` 不变量 6）。新增管理端 schema 前先确认基类。
3. **菜单码字符串必须与 `admin_menus.code` 及 `admin/src/router/menus.ts` 三方一致**。写错菜单码不会报错，只会让**所有非超管永久 403**（超管因 `has_menu` 短路而察觉不到）。新增菜单码需同步：`docker/init/0NN_*.sql` 迁移（遵守 `docker/init/SQL_CONSTRAINTS.md`，禁止改已发布脚本）+ `admin/src/router/menus.ts` + 本文件 `require_menu`。
4. **新增端点必须挂权限依赖**：`require_menu(code)` 或 `get_current_admin`。只有「登录前必须可调」的端点才允许无鉴权，且必须加 IP 限流（参照 `:107`、`:129`、`:149`）。`backend/AGENTS.md` §4 不变量 2 要求「新增公开接口需显式说明理由」。
5. **不要把业务规则写进路由**（`backend/AGENTS.md` §3.1、§6.4）。本文件已存在的两处历史例外（`create_quote` / `update_quote` 在路由调 `validate_quote`，`:630-632`、`:644-646`；`verify_points` 在路由写审计并 commit，`:337-343`）不应被当作可复制的范式扩散。
6. **`ValueError → HTTPException` 的映射策略改动需谨慎**：现状是三种模式并存（统一 400 / 按文案区分 400-404 / 统一 404）。改任一处都会改变前端错误提示与 `admin/src/api/request.ts` 的分支行为。特别注意 `:795`、`:877`、`:993` 用**中文错误文案精确比对**（`str(exc) == "用户不存在"`）来决定 404 —— **改 service 的错误文案会静默把 404 变成 400**。
7. **`_read_import_file` 的读取语义不可改**：它 `read(MAX+1)` 后不回卷，service 只能接收 bytes 而非 `UploadFile`。若改为把 `UploadFile` 下传，必须在读取后 `file.file.seek(0)`。
8. **预览令牌不可跨业务复用**：`biz_type` 校验在 `backend/app/services/import_service.py:152`。新增第三套导入时必须注册新的 `biz_type` 并保证与现有值不同。
9. **`iter_rank_csv` 的独立 Session 不可「修回」`Depends(get_db)`**：流式响应在路由返回后才消费，改回注入会话必然在响应阶段报「Session is closed」。若要统一，须改造为「先物化再下载」或引入后台任务，属架构级变更。
10. **导出端点无分页上限**：`GET /rankings/export` 会遍历全部命中用户。人员量增长时导出耗时与连接占用线性上升（每批 1000 人 + 每批一次 `_reached_map`）。加大数据量前须评估（根 `agents.md` §2.4）。
11. **`AI` 命名空间跨两文件**：在 `backend/app/api/routes/ai_admin.py`（前缀 `/admin/ai`）与本文件（`:500-538`）之间新增 AI 端点时，注意避免路径冲突 —— 实测当前两者路径集合交集为空。
12. **不得在本文件写入任何密钥/令牌/连接串**。管理员口令经 `settings.ADMIN_PASSWORD` 读取（`backend/.env` / `.env.prod`，已入库但含密钥历史，见根 `agents.md` §1.3），**不得硬编码默认密码**（`:103-105` docstring 明确此设计意图，`06b6313` 提交取消了默认值）。
13. **`docker/` 目录改动默认不提交**（根 `agents.md` §1.3）；新增菜单码迁移时须单独说明。

## 9. 当前实现状态

### 9.1 已实现

- 57 个端点全部实现且**全部有前端调用点**（`admin/src/api/admin.ts`，§6.3），无死端点、无占位实现。
- Excel 两段式导入（题库 + 寄语两套）、流式 CSV 导出、AI 出题草稿与批量入库、扫码登录、RBAC 与审计、活动时间控制均已上线（验证记录见 §10）。
- 路由层零 SQL、零业务规则实现（除 §9.2 第 1 条列出的两处例外），符合 `backend/AGENTS.md` §3.1 分层。

### 9.2 与 `backend/AGENTS.md` 约定不符之处（逐条实测）

1. **§3.1「routes 层只做参数接收 / 调 service / 把 `ValueError` 转 `HTTPException`；路由中禁止出现业务规则代码」**
   - `create_quote`（`:628-633`）与 `update_quote`（`:642-650`）在**路由内**调 `quote_service.validate_quote(...)` 并按返回的错误串决定抛 400，而不是让 service 抛 `ValueError`。校验的**编排逻辑**落在了路由层（校验规则本身仍在 service）。全文件仅此两处这种写法，其余 40+ 个写端点均为 `try: service(...) except ValueError: 400`。
   - `update_invite`（`:870-872`）在路由内做「`name` / `is_enabled` 显式为 `null` → 400」的字段校验，属路由层业务规则。
   - `verify_points`（`:337-343`）在路由内组装审计 detail 字典并 `db.commit()`，超出「参数接收 + 调 service + 转异常」的范围。
   - `export_rankings`（`:357`）在路由内构造中文文件名（含日期格式化），属表现层逻辑，可接受但不属「只做参数接收」。
2. **§3.1「所有响应必须声明 `response_model`，禁止路由直接返回裸 dict/ORM 对象」**
   - **3 个端点无 `response_model`**：`GET /rankings/export`（`:347-351`）、`GET /questions/import-template`（`:429-433`）、`GET /quotes/import-template`（`:582-586`）。实测 OpenAPI 中三者 200 响应为空 schema `{}` 且 `Content-Type` 被标为 `application/json`，与实际（`text/csv` / xlsx）不符，Swagger UI 上无法体现真实响应类型。二进制/流式响应确实难以用 `response_model` 表达，属既有取舍，但**AGENTS.md 未登记该例外**。
   - **`DELETE /orgs/{org_id}`（`:725-730`）用返回类型注解 `-> MessageOut` 替代 `response_model=`**，是全文件唯一一处；实测 OpenAPI 能正确推导出 `MessageOut`，功能无差异，仅风格不统一。
   - **多个端点返回裸 dict**：`:115`、`:133-139`、`:163-170`、`:171-175`、`:184-189`、`:190-195`、`:230`、`:252`、`:395`、`:466`、`:555`、`:619`、`:633`（经 `quote_service.get_admin_out` 返回 dict）、`:650`、`:733-734`、`:775`、`:820`、`:837`、`:898-904`、`:916`、`:973`、`:995`、`:1017`、`:1037`。这些 dict 由 `response_model` 做出口校验，**实际不会漏字段**，但字面上违反「禁止返回裸 dict」。
   - **返回 ORM 对象**：端点 9~12（`RouteNode`）、37 / 38（`Organization`）直接把 ORM 实例交给 `response_model`。实测（FastAPI 0.143.0 + Pydantic 2.14.1，最小复现脚本）**FastAPI 校验响应模型时接受 ORM 对象**，即使模型未设 `from_attributes=True` 也能正常序列化，因此不构成运行时缺陷。`AdminRouteNodeOut` 显式设了 `model_config = ConfigDict(from_attributes=True)`（`backend/app/schemas/schemas.py:1347`，是全部 `Admin*` 模型中唯一一处），`AdminOrgNodeOut`（`backend/app/schemas/schemas.py:1266-1280`）则未设 —— 二者行为一致。
3. **§4 不变量 6「一律通过 `Depends(get_db)` 获取，禁止在 service 内自建 session」**
   - `admin_service.iter_rank_csv`（`backend/app/services/admin_service.py:438`、`:485`）自建并自关 `SessionLocal`，被本文件端点 15 调用。这是**流式响应的必要例外**（§4.6 已论证），`.qoder/ARCHITECTURE.md` §3.1 / §8.3 与 `.qoder/REQUIREMENTS.md` §11.6 均已登记，但 **`backend/AGENTS.md` 本身未记载该例外**，字面上仍属违反。
4. **§4 不变量 2「除 `POST /api/auth/login` 外，所有路由必须依赖 `Depends(get_current_user)`」**
   - 本文件的 3 个登录前端点（1、2、3）既无 `get_current_user` 也无 `get_current_admin`。该不变量面向小程序侧，管理端有对应的 `get_current_admin` 体系，**AGENTS.md 未为管理端单独成文**，属文档覆盖缺口而非代码缺陷。
5. **§5「路由 `summary` 用中文一句话描述」** —— 全部 57 个端点均有中文 `summary`（实测无一缺失），符合。
6. **§3.1「服务层签名统一 `def xxx(db: Session, ...)`」** —— `admin_service.iter_rank_csv(keyword, org_id, only_changed)`（`backend/app/services/admin_service.py:433`）**首参不是 `db`**，是同一例外的连带结果。

### 9.3 存在的问题（非阻塞，代码清理候选）

1. **`from app.models.models import User`（`:22`）是死 import**：全文件无任何 `User` 引用（`grep -n 'User'` 仅命中 `AdminPrincipal`、`user_id`、`AdminUser*` 等标识符）。可安全删除。
2. **6 个处理函数注入了 `admin` 却从不使用**（AST 实测）：`list_admin_users`（`:762`，注入在 `:770`）、`list_invites`（`:829` / `:834`）、`get_invite_qrcode`（`:886` / `:889`）、`list_roles`（`:912` / `:914`）、`audit_logs`（`:1025` / `:1032`）、`get_activity`（`:1046` / `:1048`）。权限校验仍生效（依赖照样执行），只是可改为 `dependencies=[Depends(require_menu(...))]` 以统一风格并消除未使用参数。
3. **`GET /questions` 的 3 个查询参数缺少长度/枚举约束**：`keyword: Query("")`、`qtype: Query("")`、`category: Query("")`（`:389-391`）既无 `max_length` 也无 `pattern`，而同类端点（`:321`、`:551`、`:765`、`:832`、`:1028`）的 `keyword` 均为 `max_length=64`，`:768` 的 `status`、`:684` 的 `scope`、`:1029-1030` 的 `actor_type` / `date` 均有 `pattern`。超长 `keyword` 会直接进入 LIKE 查询（service 侧 `backend/app/services/admin_service.py:157` 用了 `autoescape=True`，**无 SQL 注入风险**，仅缺输入长度上界）。
4. **404 / 400 映射不统一**（详见 §8 第 6 条）：
   - `DELETE /roles/{role_id}`（`:971-972`）把 `ValueError("角色不存在")`（`backend/app/services/access_service.py:307`）映射为 **400**，而 `PUT /roles/{role_id}`（`:954-955`）同样文案也映射为 400；对比 `PATCH /users/{id}/status`（`:795`）与 `POST /users/{id}/roles`（`:993`）会把「用户不存在」映射为 **404**。
   - `PUT /users/{id}/org`（`:816-817`）与 `PATCH /users/{id}/roles/{rid}/enabled`（`:1015-1016`）把**所有** `ValueError` 一律映射为 **404**，即使文案是「组织不存在」以外的校验错误（如 `backend/app/services/access_service.py:382` 的「该用户未被授予此角色」，语义上更接近 400/409）。
   - `POST /orgs/sync`（`:747-748`）把**所有** `ValueError` 映射为 **502**，但 `ValueError` 也可能来自数据格式问题（`backend/app/services/admin_service.py:874`「外部接口返回格式非法」、`:881`「组织节点必须为对象」），这类错误返回 502 语义偏差。
   - `DELETE /questions/{id}` 恒返回「已删除」不报 404，`DELETE /orgs/{id}` 对不存在的组织也返回「已删除」（`backend/app/services/admin_service.py:739-740` 返回 `[]`），而 `DELETE /quotes/{id}` 会 404（`:660-661`）。三个删除端点三种语义。
5. **`GET /rankings/export` 的文件名用 `datetime.now()`（服务器本地时区，`:357`）**，与全项目「业务日按北京时间 UTC+8」的口径（`backend/app/core/helpers.py:22-24`）不一致。当前部署环境本地时区即北京时间，无实际影响。
6. **模块 docstring（`:1-6`）覆盖不全**：只提「管理员登录、扫码登录、题库维护、组织架构维护与同步」，未提排名 / 寄语 / 角色 / 邀请码 / 审计 / 活动 / 驾驶舱 / 大屏 / 路线节点 / AI 出题（占 57 个端点中的绝大多数）。
7. **`docs/迭代记录.md` 的 `ea58b6c` 条目记载的 AI 批量保存路径与代码不符**：该条写作 `POST /api/admin/questions/batch-ai`，实际代码是 `POST /api/admin/ai/questions/batch-save`（`:524-525`）。**以代码为准**，属迭代记录笔误。

### 9.4 待确认

1. `poll_wechat_qr` 中 `access_service.build_principal(db, user) or {...}` 的兜底分支（`:158-161`）：在「确认后、轮询前」授权被撤销的场景下仍签发令牌并返回空菜单，是**有意的防御性设计**还是应改为返回 `failed` 状态 —— 代码注释未说明，**待确认**。
2. 端点 2 `POST /wechat/qr` 在 mock 模式下把 `scene` **明文**返回（`:136`）。生产环境是否可能因微信凭证缺失/接口故障而落入 mock 分支（此时任何拿到该响应的人都能完成扫码登录）——`wechat_service.get_wxacode_png` 失败即返回 `None`（`backend/app/services/wechat_service.py:53-73`），未见「生产禁用 mock」的环境开关，**待确认**是否为有意取舍。
3. `POST /login` 的口令比较为普通 `!=`（`:111-112`），非恒定时间比较。是否需要考虑时序侧信道 —— **待确认**（有限流 10 次/分/IP 兜底，`backend/app/core/rate_limit.py:31`）。
4. `GET /activities`（`:221-230`，实时动态流）与 `backend/app/api/routes/broadcast.py` 的职责边界：二者都提供动态流，前者挂 `require_menu("dashboard")`、后者挂 `get_current_user`（`backend/app/api/routes/broadcast.py:15`、`:22`）。**待确认**是否属重复能力或有意分端。
5. 端点 15 `GET /rankings/export` 无行数上限。当前生产人员规模下的导出耗时与连接占用未实测 —— **待确认**（`docs/迭代记录.md` `b5d6035` 条目记录的验收规模为「导出 19 人」与「92 人全量翻页」，不足以推断大数据量表现）。
6. `ai_overview` / `ai_logs` 两个菜单码在 `docker/init/022_ai_admin_menus.sql` 中已写入 `admin_menus`，但 `backend/app/` 与 `admin/src/` 均无引用。是为 Phase B 预留还是遗漏 —— **待确认**。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/admin.py` 与 `git log --follow --format='%h | %ad | %s' --date=format:'%Y-%m-%d %H:%M' -- backend/app/api/routes/admin.py`（两次结果一致，共 **19 个提交**），与 `docs/迭代记录.md` 逐条交叉核对。按主题归并，**引用的提交号、日期与时刻均逐字取自上述 git 输出**；时间倒序。

### 2026-10-17

- 需求：建立 `.qoder/` 文件级文档体系（第一批 backend）。
- 修改内容：**仅新增本文档，未修改 `backend/app/api/routes/admin.py` 或任何业务代码**。全文分段（1-300 / 300-498 / 498-696 / 696-895 / 895-1088）读完全部 1088 行；用 `app.openapi()` + `router.routes` + 正则三方核实端点数为 **57**（45 个唯一路径，`GET 23 / POST 18 / PUT 8 / PATCH 4 / DELETE 4`）；用 `grep -n 'require_menu("'` 核实 53 处菜单码依赖、去重得 **11 个菜单码**；用 AST 脚本核实 6 个处理函数注入 `admin` 却未使用；用最小复现脚本实测 FastAPI 0.143.0 校验响应模型时接受未设 `from_attributes` 的 ORM 对象。定稿前再用脚本把 §4.3 全部 57 行（方法 / 完整路径 / 处理函数名与行号 / `require_menu` 菜单码与行号 / `response_model` 名与行号）逐项回比源码，并校验全文 108 处跨文件引用的文件存在且行号在目标文件行数范围内，均为 0 处不符。
- 关联文件：`.qoder/backend/requirements.txt.md`、`.qoder/backend/app/api/deps.py.md`、`.qoder/ARCHITECTURE.md` §2.2 / §5.3 / §8、`.qoder/REQUIREMENTS.md` §11。
- 测试结果：不涉及代码变更，无需测试。

### 2026-10-16（`ea58b6c`，23:19）— AI 智能出题接入

- 需求：题库接入腾讯云 CloudBase Agent 做 AI 出题，草稿经管理员审核后入库；原有 Excel 导入链路完整保留。
- 修改内容：新增 `POST /ai/generate-questions`（`:500-521`）与 `POST /ai/questions/batch-save`（`:524-538`），均挂 `require_menu("questions")`。生成结果一律作为**草稿**返回不入库（`:498-499` 注释），必须由管理员在预览列表确认后再调 batch-save。异常映射刻意**先捕获 `cloudbase_service.CloudBaseError` 再捕获 `ValueError`**（`:517-521`，`CloudBaseError` 继承 `ValueError`，见 `backend/app/services/cloudbase_service.py:31-37`），上游故障映射 502、参数/校验问题映射 400。
- 关联文件：`backend/app/services/ai_question_service.py`、`backend/app/services/cloudbase_service.py`、`backend/app/schemas/schemas.py:1142-1195`、`admin/src/components/AiGenerateDialog.vue`、`admin/src/api/admin.ts:659-707`。
- 测试结果：据 `docs/迭代记录.md` 的 `ea58b6c` 条目 —— 后端冒烟 `backend/test/s25_ai_question_generate.py` **16/16**（含真实 Agent 生成 10 题与 50 题、401/403 越权、响应体不含密钥、小程序答题契约未变）；admin `npm run build` 通过；浏览器验收 **10/10**（截图 `admin/test/images/s26-01~09`，报告 `admin/test/docs/s26-ai-question-admin-report.md`、`backend/test/docs/s26-ai-question-backend-report.md`）；**无数据库结构或数据变更**。

### 2026-10-13（`07d02af` 11:36、`2f3f333` 11:25、`ce14a95` 10:54）— V2.0 三项需求

- 需求：V2.0 需求五（所属部门首次确定后锁定）、需求三/四（积分台账重构与总积分排名）、需求一（活动时间控制）。
- 修改内容：
  - `07d02af`：新增 `PUT /users/{user_id}/org`（`:800-820`，`require_menu("access")`），调 `org_service.admin_set_user_org`，组织变更与审计 `user.org_change` 同一事务；未变化时返回「组织未变化」不写审计；`ValueError` 一律 404；变更后 `ws_manager.broadcast(build_event("org.select", user_id))`（`:819`，本文件唯一 WS 推送点）。
  - `2f3f333`：新增 `POST /points/verify`（`:329-344`，挂 `rankings` 菜单码），调 `points_service.recompute_all(db, fix=..., user_ids=...)`；`fix=True` 时在**路由内**写审计 `points.recompute` 并 `db.commit()`（`:337-343`，本文件唯一的路由层 commit）。`GET /rankings`、`GET /users/{id}/overview`、`GET /rankings/export` 同步增加总积分 / 步行积分 / 答题积分口径。
  - `ce14a95`：新增 `GET /activity`（`:1041-1050`）、`PUT /activity`（`:1053-1069`）、`POST /activity/publish`（`:1072-1088`），均挂 `require_menu("activity")`，调 `activity_service.get_admin_view` / `update` / `set_published`，变更与审计同一事务。
- 关联文件：`backend/app/services/points_service.py`、`backend/app/services/org_service.py`、`backend/app/services/activity_service.py`、`docker/init/016_activity_settings.sql`、`docker/init/017_points_ledger.sql`、`backend/app/api/deps.py:56-81`（活动准入闸门）。
- 测试结果：据  —— `07d02af`：s19 **25/25**、SQLite HTTP 冒烟 **5/5**（含管理员调整并写审计、未变化不写审计、404、用户 Token 被拒）、openGauss 10 线程并发认领只 1 个成功。`2f3f333`：SQLite 冒烟 **20/20**、openGauss 回填 92 条步行 + 12 条答题、核对 132 人 111 天差异为 0、10 线程并发补步一致；回归 s11 8/8、s18 14/14、s19 25/25、s6 8/8；**s5、s9 依赖旧的首登自动建号，在已配置真实 WX 凭证时登录返回 502，属本次之前就存在的问题**。`ce14a95`：TestClient 冒烟通过（默认状态、时间格式错误 422、开始晚于结束 400、未发布/已结束时写接口 403、结束后可查看两种配置、无 Token 401），s19 回归 25/25。

### 2026-10-12（`afbcba9`）— 邀请码准入全链路

- 需求：小程序仅对受邀人员开放；管理后台管理入驻邀请码与账号启停。
- 修改内容：新增「入驻邀请码」区（`:823-904`）—— `GET /invites`（`:824-837`）、`POST /invites`（`:840-856`）、`PATCH /invites/{invite_id}`（`:859-878`）、`GET /invites/{invite_id}/qrcode`（`:881-904`），均挂 `require_menu("invites")`；新增 `PATCH /users/{user_id}/status`（`:778-797`，`require_menu("access")`，含「不能修改自己的账号状态」保护 `:789-790`）；`GET /users` 增加 `has_access` / `status` 筛选与邀请码来源列。**同时下线** `67c96b1` 前一天刚加的 `GET /api/admin/onboarding-qrcode`（`git log -S 'onboarding-qrcode'` 实测：`67c96b1` 加入、`afbcba9` 移除），改由每个邀请码各自出码。
- 关联文件：`backend/app/services/invite_service.py`、`docker/init/015_invite_admission.sql`、`admin/src/views/InviteView.vue`、`frontend/pages/launch/launch.js`、`frontend/pages/onboard/`。
- 测试结果：据 `docs/迭代记录.md` 的 `afbcba9` 条目 —— s19 集成测试通过（`backend/test/s19_invite_admission.py`），admin `npm run build` 与浏览器验收通过，迁移 015 已应用本地 openGauss；日志/响应脱敏（不含 openid、session_key、wx code、邀请码原码、AppSecret）。

### 2026-10-11（`d6acf7e`、`30b4458`、`b5d6035`、`225f99c`、`67c96b1`）— 寄语循环与导入、代码审查修复、排名服务端分页与流式导出

- 需求：V1.1 功能二（每日寄语按排序号 + 启用状态循环展示，起始日期可配置，支持 Excel 批量导入）；管理后台代码审查修复；排名洞察大数据量性能优化。
- 修改内容：
  - `d6acf7e`：新增「每日寄语维护」区（`:541-662`）—— `GET /quotes`（增 `keyword` 服务端搜索）、`GET|PUT /quotes/cycle`、`GET /quotes/import-template`、`POST /quotes/import-preview`、`POST /quotes/import-confirm`、`POST /quotes`、`PUT|DELETE /quotes/{quote_id}`，全部挂 `require_menu("quotes")`；复用题库导入框架（`_read_import_file` `:419`、`_xlsx_response` `:411`）。
  - `30b4458`：`GET /quotes` 新增 `keyword` 参数并改服务端搜索；寄语/题库/人员搜索在 service 侧对 LIKE 通配符转义；审计日志按日期筛选时后端把本地日期换算为 UTC 区间；扫码登录轮询在前端改链式 setTimeout + 代数计数。
  - `b5d6035`：`GET /rankings`（`:312-326`）改为**服务端分页 + 筛选**（`page` / `page_size ≤200` / `keyword` / `org_id` / `only_changed`），新增 `match_total` / `avg_progress` / `org_options` / `podium` 返回字段；**新增 `GET /rankings/export`（`:347-362`）**，独立会话 + 流式游标每批 1000 人 + 服务端防公式注入 + UTF-8 BOM。
  - `225f99c`：入驻二维码接口改用 `wechat_service.to_data_url`（按文件头识别 PNG/JPEG，`backend/app/services/wechat_service.py:87-90`）。
  - `67c96b1`：新增 `GET /api/admin/onboarding-qrcode`（**次日由 `afbcba9` 下线**）。
- 关联文件：`backend/app/services/quote_service.py`、`backend/app/services/import_service.py`、`backend/app/services/admin_service.py:375-485`、`docker/init/013_daily_quote_cycle.sql`、`admin/src/components/ExcelImportDialog.vue`、`admin/src/utils/download.ts`、`admin/src/pages/RankingsView.vue`。
- 测试结果：据  —— `d6acf7e`：S17 **13/13**、S12 **11/11**、admin build 通过、浏览器验收通过（今日位置计算 / 模板下载 / 错误导入与错误报告 / 重选文件 / 确认导入 / 行内启停 / 改起始日期 / 编辑 / 删除 / 题库导入回归），迁移 013 已应用本地 openGauss。`30b4458`：admin build 通过，后端回归 p2_quotes 4/4、s9 30/30、s8 23/23、s12 11/11、s4 13/13、e2e_datasync 23/23，浏览器验收通过。`b5d6035`：新旧实现对照 **92 人全量翻页逐字段相等**、各项指标与 5 组筛选一致，S7 8/8、昵称 12/12、datasync 23/23、e2e_full_flow 178/178，浏览器验收含「导出 19 人」通过。`225f99c`：admin build 通过、S13 13/13、浏览器验收通过，**真机扫码待验证**。`67c96b1`：S13 **13/13**（`backend/test/s13_onboard_login.py`，含 37 个管理接口拒绝普通用户 Token）、S12 回归 11/11，**真实微信出码与真机扫码待验证**。

### 2026-10-10（`54ea125`，23:31）— 题库 Excel 模板下载与批量导入

- 需求：V1.1 功能一，题库支持 Excel 模板下载与批量导入（预览校验 + 事务写入 + 防重复提交），题库列表改服务端分页。
- 修改内容：新增 `GET /questions/import-template`（`:429-435`）、`POST /questions/import-preview`（`:438-452`）、`POST /questions/import-confirm`（`:455-466`）；新增模块级辅助 `_xlsx_response`（`:411-416`）与 `_read_import_file`（`:419-426`）；`GET /questions`（`:380-395`）改服务端分页 + `keyword` / `qtype` / `category` 筛选。预览令牌 30 分钟有效、条件 UPDATE 抢占防重复确认、整批事务写入失败回滚（实现均在 `backend/app/services/import_service.py`）。
- 关联文件：`backend/app/services/import_service.py`、`docker/init/011_import_previews.sql`、`backend/requirements.txt`（新增 `openpyxl`、`python-multipart`）、`admin/src/components/ExcelImportDialog.vue`。
- 测试结果：据 `docs/迭代记录.md` 的 `54ea125` 条目 —— S12 后端冒烟 **11/11**（`backend/test/s12_question_import.py`，SQLite 临时库）、admin `npm run build` 通过；**当时 Docker/openGauss 未启动，迁移 011 落库与浏览器验收标记为待验证**（后续 `d6acf7e` 条目的 S12 11/11 回归可视为已覆盖）。

### 2026-10-09（`4bf9acd` 10:43、`b431e4d` 10:27、`06b6313` 10:15、`a740973` 09:35）— RBAC 与审计、扫码登录、身份关联建表、组织人员明细

- 需求：管理后台 RBAC（角色 / 菜单码）与审计接口；微信扫码登录；身份关联迁移建表；组织架构人员明细查看。
- 修改内容：
  - `4bf9acd`：**既有管理接口全部按菜单码挂 `require_menu`**（超管全放行、角色菜单缺项 403）；新增「人员授权 / 角色管理 / 审计日志」区（`:751-1037`）—— `GET /users`、`GET|POST /roles`、`PUT|DELETE /roles/{role_id}`、`POST /users/{user_id}/roles`、`PATCH /users/{user_id}/roles/{role_id}/enabled`、`GET /audit-logs`；新增 `_actor()` 辅助（`:752-754`）区分 `super` / `user` 操作人。
  - `b431e4d`：新增 `POST /wechat/qr`（`:119-139`）、`GET /wechat/qr/{qr_id}/status`（`:142-175`）、`GET /me`（`:178-195`）；管理员令牌按 `typ` 区分超管/关联管理员，`get_current_admin` 每请求查库校验；登录/扫码/轮询限流。
  - `06b6313`：`ADMIN_PASSWORD` **取消默认值**（未配置时账号登录禁用，仅允许扫码登录），落地为 `login` 中 `:108-109` 的 403 分支。
  - `a740973`：新增 `GET /orgs/{org_id}/users`（`:676-693`，`scope=direct|all` 口径与组织树统计一致、分页）。
- 关联文件：`backend/app/api/deps.py:84-160`、`backend/app/services/access_service.py`、`backend/app/services/identity_service.py`、`backend/app/core/security.py`、`docker/init/010_admin_identity.sql`、`admin/src/views/AccessView.vue`、`admin/src/views/AuditView.vue`。
- 测试结果：据  —— `4bf9acd`：S9 集成测试 **30/30**（`backend/test/s9_rbac_access.py`，报告 `backend/test/docs/s9-rbac-access.md`），S8 复测 **23/23**；测试发现并修复「删除角色未清理菜单关联行」的外键缺陷（现 `backend/app/services/access_service.py:315-317` 先删 `admin_role_menus`）。`b431e4d`：S8 **23/23**（`backend/test/s8_identity_admin.py`）。`06b6313`：`database-init` 容器成功应用迁移 010（建表 + 种子 INSERT 0 9/1/7），ORM 与 `app.main` 导入正常，`ADMIN_PASSWORD` 默认为空。`a740973`：条目仅记载功能内容，**未记载验证结果**，测试情况待确认。

### 2026-10-03（`71d1b9b`，23:39）— 每日寄语与节点纪念票（P2-1）

- 需求：后台维护有出处语录，小程序首页寄语卡与 Canvas 节点纪念票。
- 修改内容：新增每日寄语的基础 CRUD（`POST /quotes`、`PUT|DELETE /quotes/{quote_id}`、`GET /quotes`），是本文件「每日寄语维护」区的最初形态（循环与导入能力由后续 `d6acf7e` 补齐）。
- 关联文件：`backend/app/services/quote_service.py`、`backend/app/models/models.py`（`daily_quotes`）、`frontend/pages/home/home.js`、`frontend/pages/ticket/ticket.js`、`admin/src/views/QuotesView.vue`。
- 测试结果：`docs/迭代记录.md` 的 `71d1b9b` 条目**只有一句内容摘要，未记载验证结果**，测试情况**待确认**。

### 2026-10-02（`2289fdd`，10:09）— 驾驶舱 / 大屏聚合接口

- 需求：管理端驾驶舱与数据大屏的聚合数据源。
- 修改内容：新增 `GET /dashboard`（`:199-206`）、`GET /dashboard/trend`（`:209-218`）、`GET /activities`（`:221-230`）、`GET /screen`（`:233-240`），挂 `require_menu("dashboard")` / `require_menu("screen")`，全部委托 `backend/app/services/dashboard_service.py`；同期节点与题库管理扩展内容字段（`AdminRouteNodeUpsert` 的 `brief` / `significance` / `figures` / `location` / `images` / `audio` / `keywords`）。
- 关联文件：`backend/app/services/dashboard_service.py`、`backend/app/schemas/schemas.py:1198-1264`、`admin/src/views/DashboardView.vue`、`admin/src/views/ScreenView.vue`。
- 测试结果：`docs/迭代记录.md` 的 `2289fdd` 条目**只有一句内容摘要，未记载验证结果**，测试情况**待确认**。

### 2026-10-01（`e7e2349` 10:34、`337af78` 10:29）— 文件创建与管理后台 API 初版

- 需求：为 `admin/` 管理后台提供后端接口。
- 修改内容：
  - `337af78` **创建本文件**，含 `POST /login`、题库 CRUD、组织架构 CRUD 与同步、路线节点 CRUD 与启停、排名总览（`GET /rankings`）。
  - `e7e2349` 新增 `GET /users/{user_id}/overview`（`:365-376`）人员详情聚合（运动 / 答题 / 勋章 / 长征 / 积分五段），用户不存在返回 404。
- 关联文件：`backend/app/services/admin_service.py`、`backend/app/main.py:86`、`admin/src/api/admin.ts`、`admin/src/views/*`。
- 测试结果：`docs/迭代记录.md` 的 `e7e2349`、`337af78` 两条目**均只有内容摘要、未记载验证结果**（属早期简略条目），测试情况**待确认**；同日的 `7023079`（10:32）「三端测试脚本、报告与页面截图」提交可视为配套验证产物，但**未与该两条目建立明确对应关系**。
