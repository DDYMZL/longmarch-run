# org.py

## 1. 文件路径

`backend/app/api/routes/org.py`（83 行）

## 2. 文件职责

小程序组织架构域的 HTTP 路由层：组织树逐级下钻、我的所属组织（含可选范围）、同组织同行者、组织共同长征目标、首次选定组织。路由层做参数接收、异常→状态码映射（`InviteError`/`ValueError`→404/400/403）与 WS 广播；组织口径、锁定与并发控制在 `org_service` / `invite_service`。

## 3. 业务需求

- 组织为多级树，用户可选定任意层级节点；**所属组织首次确定后即锁定，用户侧不可再改，仅管理员可调整并留审计**（`backend/app/services/org_service.py:1-5` 模块 docstring；提交 `07d02af`，2026-10-13）。
- 同组织同行者（需求 §9，提交 `f37e3d7`，2026-10-03）；组织共同长征目标（需求 §10，提交 `b4a8910`，2026-10-03）。
- 专属邀请码入驻的用户只能在该邀请码组织及其下级中选定（提交 `afbcba9`，2026-10-12 邀请码准入全链路）。

## 4. 核心功能

### 4.1 端点清单（5 个，与 `app.openapi()` 实测一致）

路由前缀 `/org`（`org.py:20`），经 `backend/app/main.py:79` 以 `/api` 前缀挂载。

| 方法 | 完整路径 | 函数名 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| GET | `/api/org/children` | `children` | `org.py:23-29` | **无鉴权**（仅 `get_db`，见 §9 问题 1） | `OrgChildrenOut`（`backend/app/schemas/schemas.py:742`） |
| GET | `/api/org/mine` | `mine` | `org.py:32-39` | `get_current_user`（无活动闸门） | `UserOrgOut`（`schemas.py:751`） |
| GET | `/api/org/companions` | `companions` | `org.py:42-49` | `require_activity_view` | `OrgCompanionsOut`（`schemas.py:770`） |
| GET | `/api/org/march` | `org_march` | `org.py:52-55` | `require_activity_view` | `OrgMarchOut`（`schemas.py:789`） |
| POST | `/api/org/select` | `select` | `org.py:58-82` | `require_activity_participation` | `UserOrgOut` |

### 4.2 调用的 service 函数

| 路由 | service 调用 | 位置 |
|---|---|---|
| `children` | `org_service.get_children` | `backend/app/services/org_service.py:30-52` |
| `mine` | `org_service.get_user_org` + `invite_service.user_scope_org` | `org_service.py:151-162`；`backend/app/services/invite_service.py:93-100` |
| `companions` | `org_service.get_companions` | `org_service.py:180-224` |
| `org_march` | `org_service.get_org_march` | `org_service.py:227-291` |
| `select` | `invite_service.check_user_org_scope` → `org_service.claim_user_org` → `org_service.get_user_org` | `invite_service.py:103-107`；`org_service.py:98-114`；`org.py:71-82` |

WS 广播：仅 `select` 成功后广播 `org.select`（`org.py:81`，`backend/app/core/ws.py:23`/`:62`）。

### 4.3 `GET /api/org/children`：分层参数与越级防护

- 分层参数：`parent_id: Optional[int] = Query(None, alias="parentId")`（`org.py:25`），**留空返回顶级**（`parent_id IS NULL`，`org_service.py:31`、`:36-37`）。
- **越级防护**：本端点只返回指定 parent 的**直接下级**一层，不递归下发整棵树；每项附 `hasChildren`/`childCount` 供前端决定是否继续下钻（`org_service.py:33`、`:42-52`；子级数量用一条 GROUP BY 批量统计防 N+1，`_child_counts` `:18-27`）。前端逐级请求（`frontend/services/org.js:12`）。
- 传入不存在/无下级的 `parentId` 返回空列表（过滤条件天然结果，不报 404）。
- 排序：`sort_order, id`（`org_service.py:38`）。

### 4.4 `GET /api/org/mine`：我的组织与可选范围

- `get_user_org`：未选组织返回 `{orgId: null, locked: false, ...}`；已选返回组织 id、名称、全路径名、面包屑 path、`locked: true`（`org_service.py:151-162`；全路径回溯带 32 层防环 guard，`:59-69`）。
- **scopeOrgId 语义**：`invite_service.user_scope_org` 非空表示用户由**专属邀请码**入驻，只能在该组织及其下级中改选（`org.py:34` docstring、`:36-38`；`invite_service.py:93-100` 经 `users.invite_code_id` → `invite_codes.org_id` 求范围根）。历史用户与通用码用户为 None，不受限。

### 4.5 `GET /api/org/companions` 与 `GET /api/org/march`

- `companions`：`limit` Query 默认 6，路由层钳制到 1~50（`org.py:44`、`:49` 的 `max(1, min(limit, 50))`）。口径：同组织 = 所选组织**整棵子树**；今日共同前进 = 子树成员当日步数之和；同行者按今日步数倒序限量，**隐私约束：只下发昵称/头像/今日步数/是否本人，不含用户 id、openid**（`org_service.py:181-186` docstring、`:200-223`；`schemas.py:761-767`）。未选组织返回空结构（`org_service.py:187-188`）。
- `org_march`：组织累计步数 = 子树成员 `daily_sport` 全量之和；组织路线按此现算（与个人路线共用 `march_service._route_state`，**无持久点亮概念**）；节点 pct：completed=100 / current=累计占比 / 其余 0（需求 §10.3/§10.4，`org_service.py:228-233` docstring、`:254-271`）。

### 4.6 `POST /api/org/select`：能否改选、是否可逆

- **只能选定一次，之后锁定，不可逆**：
  1. 路由层预检 `current.org_id is not None` → 403 `ORG_LOCKED`（「所属部门已锁定，如需调整请联系管理员」，`org.py:68-69`；常量 `org_service.py:15`）。
  2. service 层以 **`org_id IS NULL` 为条件的原子 UPDATE 兜底并发**，多请求同时认领只有一个生效；未生效方 rollback 并抛 `ValueError(ORG_LOCKED)` → 路由转 403（`org_service.py:105-112`；`org.py:75-78`）。
- **唯一「改选」通道是管理员**：`PUT /api/admin/users/{id}/org`（`org_service.admin_set_user_org`，`org_service.py:117-148`，写 `user.org_change` 审计），在 `backend/app/api/routes/admin.py`，不在本文件。
- 组织不存在：`claim_user_org` 返回 None → 404「组织不存在」（`org.py:79-80`；`org_service.py:103-104`）。
- 专属邀请码范围校验：`invite_service.check_user_org_scope`（`invite_service.py:103-107`）→ `_ensure_in_scope`（`:64-70`）：组织不存在抛 `InviteError("所选组织不存在")`，越界抛 `InviteError("所选组织不在邀请码允许的范围内")`。
- 成功后 WS 广播 `org.select`，并**重查**返回最新 `UserOrgOut`（`org.py:81-82`）。

## 5. 输入与输出

| 端点 | 输入 | 输出（camelCase，`CamelModel`） |
|---|---|---|
| `GET /api/org/children` | `parentId`（Query，可选，int） | `OrgChildrenOut`：nodes[]（id/name/parentId/level/hasChildren/childCount，`schemas.py:733-743`） |
| `GET /api/org/mine` | 无 | `UserOrgOut`：orgId/orgName/fullName/path[]/locked/scopeOrgId/scopeOrgName（`schemas.py:751-758`） |
| `GET /api/org/companions` | `limit`（Query，默认 6，服务端钳制 1~50） | `OrgCompanionsOut`：org/memberCount/todayTotalSteps/companions[]（`schemas.py:770-776`） |
| `GET /api/org/march` | 无 | `OrgMarchOut`：org/memberCount/totalSteps/progressPct/currentNodeName/nextNodeName/finished/litCount/totalCount/nodes[]（`schemas.py:789-801`） |
| `POST /api/org/select` | `SelectOrgRequest`：`orgId`(int, 别名；`BaseModel` 非 CamelModel，`schemas.py:804-807`) | `UserOrgOut`（选定后 locked=true） |

**异常转换模式（本文件特有，`org.py:70-80`）**：

| 异常 | 状态码 | 位置 |
|---|---|---|
| `current.org_id` 非空（预检） | 403 `ORG_LOCKED` | `org.py:68-69` |
| `InviteError("所选组织不存在")` | 404 | `org.py:72-74`（**按错误文案字符串匹配定状态码**） |
| 其它 `InviteError`（范围越界等） | 400 | `org.py:73` |
| `ValueError`（claim 并发失败 = ORG_LOCKED） | 403 | `org.py:75-78` |
| `claim_user_org` 返回 None（组织不存在） | 404「组织不存在」 | `org.py:79-80` |

另有通用错误：401（`mine`/`companions`/`org_march`/`select`，`children` 无）、403 停用/活动准入（响应头 `X-Account-Status`/`X-Activity-Status`，`backend/app/api/deps.py:46-81`）、422（orgId 非整数等）。

## 6. 依赖关系

- **依赖模块**：`app.api.deps`（`get_current_user` + 两个活动准入依赖 + `get_db`）、`app.core.ws`、`app.models.models.User`、`app.schemas.schemas`（5 个模型）、`app.services.invite_service`、`app.services.org_service`（`org.py:4-18`）。
- **service 层再依赖**：`audit_service`（管理员调整组织）、`march_service`（`_ordered_nodes`/`_route_state` 私有函数复用，`org_service.py:13`、`:254-256`）、`core.helpers.today_str`。
- **数据库表**：`organizations`（读，多级树）、`users`（读 + select 原子 UPDATE `org_id`）、`daily_sport`（companions/org_march 聚合）、`invite_codes`（scope 判定）、`audit_logs`（仅管理员通道）。
- **被谁依赖**：`backend/app/main.py:79` 注册；小程序 `frontend/services/org.js`（`:12` children、`:21` mine、`:30` select、`:38` companions、`:46` march）；入驻流程 `pages/onboard/`、组织选择页 `pages/org-select/`（经 org.js）。

## 7. 业务规则

1. **首次选定即锁定**（不可逆，用户侧无改选；管理员通道带审计）——规则本体：`org_service.py:2-4` docstring、`claim_user_org:98-114` 原子认领。
2. **同组织口径 = 整棵子树**（含下级组织成员），companions 与 org_march 一致（`org_service.py:182-183`、`:230-232`；子树 BFS `subtree_org_ids:165-177`，整表一次加载防 N+1）。
3. **专属邀请码范围**：scope 用户只能在范围根子树内选组织（`invite_service.py:64-70`、`:103-107`）。
4. **隐私**：同行者不下发用户 id/openid（需求 §9.4，`org_service.py:184-186`）。
5. **组织长征无持久点亮**：按组织累计步数现算，与个人 `lit_nodes` 无关（`org_service.py:231-232`）。
6. **组织锁定与活动准入的先后**：select 先过 `require_activity_participation`（401/403 优先），再进业务判定（`deps.py:57` docstring）。

## 8. 修改约束

1. **事务边界：service 自提交**——`claim_user_org` 在 `org_service.py:113` commit（失败路径 `:111` rollback）；本路由文件其余端点只读。路由层不得 commit。
2. `select` 的 403 语义有两层（路由预检 + service 原子 UPDATE 兜底），**不得删除 service 层的条件 UPDATE**——路由预检存在 TOCTOU 窗口，并发安全完全靠 `org_id IS NULL` 条件更新（`org_service.py:100-101` docstring）。
3. `InviteError`→状态码映射靠**错误文案字符串等值比较**（`org.py:73`），修改 `invite_service.py:68` 的文案会静默把 404 变 400；如需重构应改为异常携带状态码。
4. `OrgChildrenOut`/`UserOrgOut` 等契约与 `frontend/services/org.js`、`pages/org-select/` 强耦合（含 `scopeOrgId` 语义），改字段属破坏性变更（`backend/AGENTS.md` 不变量 1、4）。
5. `children` 若补加鉴权，会破坏启动页/入驻流程在**登录前浏览组织树**的现有交互（`org.py:28` docstring 明确「不鉴权也可浏览组织树」），需与前端一并评估。

## 9. 当前实现状态

- **已实现**：5 个端点全部可用；锁定、并发认领、邀请码范围、子树聚合、隐私字段收敛齐备。
- **存在问题 / 偏差**：
  1. **`GET /api/org/children` 完全无鉴权**（连 `get_current_user` 都没有，`org.py:24-27`），与 `backend/AGENTS.md` 不变量 2「除 POST /api/auth/login 外所有路由必须依赖 get_current_user」不符。代码 docstring（`org.py:28`）表明是有意为之（登录前入驻流程需浏览组织树），但**组织架构名称对外匿名可见**，未见文档化的显式豁免理由（`afbcba9` 提交信息提到「小程序扫码准入与入驻信息收集」场景）。是否收敛为「仅邀请码校验后可浏览」——**待确认**。
  2. 路由层 `select` 承载了较多业务分支（锁定预检、按文案映射状态码、None→404），比其它路由文件更「厚」；规则本体在 service 有原子兜底，属轻微分层偏差而非缺陷。
  3. `companions` 的 `limit` 钳制写在路由层（`org.py:49`），Query 未声明 ge/le（对比 `rank.py:17` 用 `Query(20, ge=1, le=50)` 声明式约束），两种风格并存。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/org.py`（7 个提交，2026-10-17 核对）；验证细节见 `docs/迭代记录.md` 对应条目。按时间倒序、按主题归并。

### 2026-10-13（`07d02af`）

- 需求：所属部门首次确定后锁定。
- 修改内容：`/org/select` 仅限未定组织用户（403 ORG_LOCKED），service 以 `org_id IS NULL` 原子认领防并发；`/org/mine` 返回 `locked`；管理员调整组织走 admin 路由并写审计。
- 关联文件：`backend/app/services/org_service.py`、`backend/app/api/routes/admin.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-13（`ce14a95`）

- 需求：V2.0 活动时间控制。
- 修改内容：companions/org_march 接入 `require_activity_view`，select 接入 `require_activity_participation`（children/mine 保持原鉴权档位）。
- 关联文件：`backend/app/api/deps.py`、`backend/app/services/activity_service.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-12（`afbcba9`）

- 需求：邀请码准入全链路。
- 修改内容：`mine` 增加 `scopeOrgId/scopeOrgName`（专属码范围）；`select` 前置 `check_user_org_scope` 范围校验（越界 400 / 组织不存在 404）。
- 关联文件：`backend/app/services/invite_service.py`、`docker/init/015_*.sql`、`frontend/pages/onboard/`、`admin/`。
- 测试结果：见提交信息（后端迁移/服务/路由/测试全链路）与 `docs/迭代记录.md`。

### 2026-10-03（`b4a8910`、`f37e3d7`）

- 需求：组织共同长征目标（P1-3，需求 §10）；同组织同行者（P1-2，需求 §9）。
- 修改内容：新增 `GET /api/org/march` 与 `GET /api/org/companions` 端点。
- 关联文件：`backend/app/services/org_service.py`、`frontend/pages/home/home.js`。
- 测试结果：据 `f37e3d7` 提交信息 —— 后端冒烟 **7/7**、automator **3/3**、截图 24。

### 2026-10-01（`82af32c`）

- 需求：管理端实时数据变更通知。
- 修改内容：select 成功后 WS 广播 `org.select`。
- 关联文件：`backend/app/core/ws.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-09-30（`a94e685`）

- 需求：项目初始化。
- 修改内容：创建本文件，含 children / mine / select 初始端点。
- 关联文件：仓库初始代码。
- 测试结果：`docs/迭代记录.md` 该条目未记载验证结果，待确认。
