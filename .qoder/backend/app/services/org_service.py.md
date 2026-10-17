# org_service.py

## 1. 文件路径
`backend/app/services/org_service.py`（291 行）
> **引用约定**：本文中所有**代码**引用一律为「仓库根相对路径 + 行号」；本文件自身的行号简写为 `:NN`。
> 对 `.qoder/PROJECT.md`、`.qoder/ARCHITECTURE.md`、`.qoder/REQUIREMENTS.md`、`.qoder/decisions/README.md`、`.qoder/backend/test/README.md`、`docs/迭代记录.md` 这几份**总览/台账类文档**，本文只给「路径 + 章节号/条目号/条目标题」而**不给行号**——编写期间实测这些文件正被并发修订、行号反复位移（例：`.qoder/ARCHITECTURE.md` 的架构不变量 13 在数十分钟内从 `:707` 移到 `:712`，`docs/迭代记录.md` 同一提交条目位移 6 行），写死行号会立刻失效并误导读者。对**不变动的历史归档件**（`backend/test/docs/*.md` 等测试报告）仍保留行号。


## 2. 文件职责
组织架构（多级树）的读服务与用户归属写服务：逐级下钻、面包屑路径回溯、全路径名批量拼接、子树 id 集合，以及「用户首次认领组织后锁定 / 仅管理员可改并留审计」两条写入路径；并在其上派生两个小程序聚合口径——同组织同行者（需求 §9）与组织共同长征目标（需求 §10）。模块 docstring 见 `backend/app/services/org_service.py:1-5`。

**本文件不负责**：组织树的增删改与外部同步、管理端组织树（含人数统计）——那些在 `backend/app/services/admin_service.py:602-858`；组织种子数据在 `backend/app/data/seed.py:318-332`（13 个节点，id 1–13）。

## 3. 业务需求
- **组织架构（多级树）与用户归属**：`.qoder/REQUIREMENTS.md` §2.3「组织架构 — 已实现」，其中「结构」「用户可选层级」「排序」「下钻信息」「锁定规则」五行直接以本文件为依据。
- **锁定规则（V2.0 需求五）**：所属组织首次确定（入驻或首次选择）后即锁定，用户侧不可再改，仅管理员可调整并留审计（docstring `:4`；提交 `07d02af`，2026-10-13）。
- **同组织同行者（P1-2，docstring 标注需求 §9）**：提交 `f37e3d7`（2026-10-03），测试报告 `backend/test/docs/p1-companions-report.md`。
- **组织共同长征目标（P1-3，docstring 标注需求 §10）**：提交 `b4a8910`（2026-10-03），测试报告 `backend/test/docs/p1-org-march-report.md`。
- **性能口径**：`get_full_name_map` 与 `subtree_org_ids` 的「整表一次加载 + 内存回溯」写法来自两轮去 N+1 优化（`20c79e3` 2026-10-02、`f59892e` 2026-10-11），报告见 `backend/test/docs/s7-perf-refactor-report.md`、`backend/test/docs/s14-hotspot-sql-report.md`。
- **已取消的需求**：**组织排名 / 分组织积分对比已取消，不再实现**（2026-10-02 经用户确认，登记于 `.qoder/REQUIREMENTS.md` §7「排行榜」表的「组织排名 / 分组织积分对比」行与 §12「已废弃规则」表的同名行，项目记忆 `org-ranking-cancelled`）。本文件与 `backend/app`、`admin/src`、`frontend` 中均无相关残留代码（grep `org_rank` / `orgRank` / `组织排名` / `分组织积分` 全仓无命中）。同批决定中「PC 端组织人数统计」被**重新纳入并已实现**，落点在管理端组织树接口 `backend/app/services/admin_service.py:603-632`（`direct_user_count` / `total_user_count`），**不在本文件**。

## 4. 核心功能

### 4.1 常量
- `ORG_LOCKED = "所属部门已锁定，如需调整请联系管理员"`（`:15`）：既是 `claim_user_org` 的 `ValueError` 文案（`:112`），也被路由层直接引用为 403 detail（`backend/app/api/routes/org.py:69`）。注意文案用「部门」而非「组织」。

### 4.2 组织树读取
| 函数 | 行号 | 查询次数 | 说明 |
|---|---|---|---|
| `_child_counts(db, parent_ids)` | `:18-27` | 1 | 批量统计一批组织的直接下级数量：`GROUP BY parent_id` + `count(id)`（`:23-26`）。空入参直接返回 `{}`（`:20-21`）。docstring `:19` 明确「避免逐项查询」；`f59892e` 把原先「拉两列后 Python 计数」改为 `group_by` |
| `get_children(db, parent_id=None)` | `:30-52` | **固定 2** | 某一层级的组织列表：一次按 `parent_id` 等值查询 + `ORDER BY sort_order, id`（`:35-40`），再一次 `_child_counts`（`:41`）。每项输出 `id/name/parent_id/level/has_children/child_count`（`:43-50`）。`parent_id=None` 返回顶级 |
| `get_org(db, org_id)` | `:55-56` | 1 | 单节点 ORM 对象，不存在返回 `None` |
| `get_path(db, org_id)` | `:59-69` | **≤ 层级深度** | 面包屑回溯：从目标节点起，每层调一次 `get_org` 向上走（`:66`），最后 `reverse()`（`:68`）。`guard < 32` 是环路/超深保护（`:64`）。返回 `[{id, name}]` |
| `get_full_name(db, org_id)` | `:72-74` | 同 `get_path` | `" / ".join(路径名)`，如「长征集团总部 / 华东分公司 / 技术部」（docstring `:73`） |
| `get_full_name_map(db, org_ids)` | `:77-95` | **固定 1** | 批量全路径名：**整表一次加载 `id/name/parent_id` 三列**（`:82`）建 dict，再对去重后的每个 id 在内存沿父链拼接（`:85-94`），`guard < 32` 环路保护（`:89`）。docstring `:78-80` 明确「避免逐组织逐层查询（N+1）」，不存在的 id 映射为空串。**组织表全量驻留内存**，与入参规模无关 |
| `subtree_org_ids(db, root_id)` | `:165-177` | **固定 1** | 子树 id 集合（含自身）：整表一次加载 `id/parent_id`（`:167`）建 `parent_id → [child_id]` 映射（`:168-170`），再从 `root_id` 出发用 `stack.pop()` 遍历（`:171-176`）。**docstring `:166` 写「内存 BFS」，实现是 `list.pop()`（LIFO）即 DFS**；两者结果集合相同，仅顺序不同，全部调用方都把它当 id 集合用（`.in_()` 或 `[1:]` 切片），故无功能影响 |

**`subtree_org_ids` 的两条隐含不变量**（调用方依赖，改动时不得破坏）：
1. `result[0]` 恒为 `root_id`（`:172-175`：栈初始只有 root，首次 pop 即 root）。`backend/app/services/admin_service.py:777`、`:782` 用 `[1:]` 取「不含自身的子孙」正是依赖这一点。
2. **`root_id` 不存在于组织表时仍返回 `[root_id]`**（`:175` 无条件 append），不返回空列表。调用方需自行判断组织是否存在（如 `backend/app/services/admin_service.py:660-662`）。

### 4.3 用户归属写入（两条路径）
- `claim_user_org(db, user_id, org_id) -> Optional[User]`（`:98-114`）——**用户侧首次认领**
  - 组织不存在返回 `None`（`:103-104`）；
  - **原子认领**：`UPDATE users SET org_id=? WHERE id=? AND org_id IS NULL`（`:105-109`，`synchronize_session=False`）。docstring `:101` 明确「以『org_id IS NULL』为条件的原子更新兜底并发：多个请求同时认领只有一个生效」；
  - 影响 0 行 → `db.rollback()`（`:111`，释放事务）后 `raise ValueError(ORG_LOCKED)`（`:112`）；
  - 成功 → **`db.commit()`（`:113`）** 后重新查一次 user 返回（`:114`）。
- `admin_set_user_org(db, user_id, org_id, operator, actor_type, actor_id) -> bool`（`:117-148`）——**管理员调整（唯一可改锁定组织的途径）**
  - 组织不存在 / 用户不存在均抛 `ValueError`（`:126-130`），路由层统一转 404（`backend/app/api/routes/admin.py:816-817`）；
  - **`with_for_update()` 行锁**读 user（`:128`），防止与其它写路径竞争；
  - 组织未变化 → `db.rollback()`（`:133`，释放行锁）并返回 `False`，**不写审计**（`:132-134`）；
  - 变更 → 赋值 `user.org_id`（`:135`）、用 `get_full_name_map` 一次取回新旧组织全名（`:136`）、写审计 `user.org_change`（`:137-146`，detail 含 `operator` / `before_org_id` / `before_org_name` / `after_org_id` / `after_org_name`）、**`db.commit()`（`:147`）**、返回 `True`。
  - `audit_service.record` 只 `db.add` 不提交（`backend/app/services/audit_service.py:1-5` docstring），因此「组织变更 + 审计」在同一事务原子落库。

### 4.4 当前用户组织视图
`get_user_org(db, user)`（`:151-162`）：
- 未选组织 → `{"org_id": None, "org_name": "", "full_name": "", "path": [], "locked": False}`（`:153-154`）；
- 已选 → 走 `get_path`，返回 `org_id` / `org_name`（路径末项名，`:158`）/ `full_name`（`:159`）/ `path` / **`locked: True`（`:161`）**。
- 路由 `GET /api/org/mine` 在此基础上追加 `scope_org_id` / `scope_org_name`（专属邀请码入驻用户的可选范围，`backend/app/api/routes/org.py:36-38`，取自 `invite_service.user_scope_org`）。

### 4.5 小程序聚合口径
- `get_companions(db, user, limit=6)`（`:180-224`）——同组织同行者（需求 §9）
  - 无组织 → 全零结构（`:187-188`）；
  - 「同组织」= **用户所选组织的整棵子树**（`:189` 调 `subtree_org_ids`，docstring `:183`）；
  - `member_count`：子树成员 `COUNT`（`:191-193`）；
  - `today_total_steps`：子树成员当日 `daily_sport.steps` 之和（`:194-199`，JOIN + `coalesce(sum,0)`，日期取 `today_str()`，`:190`）；
  - `companions`：子树成员 LEFT JOIN 当日步数，按 `coalesce(steps,0) DESC, user.id` 排序取前 `limit`（`:200-210`）；
  - **隐私口径（docstring `:184-185`，需求 §9.4）**：条目只输出 `nickname` / `avatar` / `today_steps` / `is_self`（`:215-223`），**不含 user id、openid**；
  - `org` 字段复用 `get_user_org`（`:212`）。
  - 查询次数：4 次聚合（子树 / COUNT / SUM / TOP-N，与 `backend/test/docs/p1-companions-report.md`「固定 4 次查询」一致）**+ `get_user_org` 的路径回溯（每层 1 次）**。
- `get_org_march(db, user)`（`:227-291`）——组织共同长征目标（需求 §10）
  - 无组织 → `empty` 结构（`:235-241`）；
  - 组织累计步数 = 子树成员 `daily_sport.steps` **全量**之和（`:246-252`）。docstring `:230-231`（§10.4）说明 `daily_sport` 按「用户+日期」覆盖存储，故求和天然无重复统计；
  - 组织路线**按累计步数现算、无持久点亮**：`lit = {节点 id | total >= target_steps}`（`:255`），再复用 `march_service._ordered_nodes(db)`（`:254`；定义 `backend/app/services/march_service.py:62-68`，1 次查询）与 `march_service._route_state(...)`（`:256`；定义 `backend/app/services/march_service.py:123`）——docstring `:231-232` 明确「与个人路线共用 `_route_state`，无持久点亮概念」；
  - 节点 `pct`（`:264-268`，§10.3）：`completed` → 100；`current` 且 `target_steps > 0` → `min(100, round(total / target_steps * 100))`；其余 → 0；
  - 「当前到达」= 第一个 `status != "completed"` 的节点，「下一站」= 其后一个（`:272-279`，§10.2 注释在 `:272`）；全部完成时当前 = 末节点、下一站为空串；
  - `progress_pct = round(state["route_progress"] * 100)`（`:284`）；
  - 查询次数：4 次（子树 / COUNT / SUM / 节点定义）+ `get_user_org` 的路径回溯。

## 5. 输入与输出

**路由映射（route → service）**

| 端点 | 方法 | 权限依赖 | 调用的本文件函数 |
|---|---|---|---|
| `/api/org/children` | GET | **无鉴权依赖**（`backend/app/api/routes/org.py:23-29`，该文件 docstring `backend/app/api/routes/org.py:28`「不鉴权也可浏览组织树」） | 本文件 `get_children`（`:30-52`）；路由在 `backend/app/api/routes/org.py:29` 调用，`parentId` 查询参数用 alias 接收（`backend/app/api/routes/org.py:25`） |
| `/api/org/mine` | GET | `get_current_user`（`backend/app/api/deps.py:17`） | `get_user_org`（`backend/app/api/routes/org.py:35`） |
| `/api/org/companions` | GET | `require_activity_view`（`backend/app/api/deps.py:81`） | `get_companions`（`backend/app/api/routes/org.py:49`，`limit` 在路由侧钳制 `max(1, min(limit, 50))`） |
| `/api/org/march` | GET | `require_activity_view` | `get_org_march`（`backend/app/api/routes/org.py:55`） |
| `/api/org/select` | POST | `require_activity_participation`（`backend/app/api/deps.py:79`） | `claim_user_org`（`backend/app/api/routes/org.py:76`） |
| `/api/auth/invite/verify` | POST | 公开 + `invite_limiter` | `get_org`（`backend/app/api/routes/auth.py:55`） |
| `/api/admin/users/{user_id}/org` | PUT | `require_menu("access")` | `admin_set_user_org`（`backend/app/api/routes/admin.py:813-815`） |

**返回值与 Schema**
- 小程序侧四个端点的响应模型均为 `CamelModel`（camelCase 输出）：`OrgChildrenOut`（`backend/app/schemas/schemas.py:742`）、`UserOrgOut`（`:751-758`）、`OrgCompanionsOut`（`:770-776`）、`OrgMarchOut`（`:789-800`）。**本文件返回的 dict 键是 snake_case**（如 `parent_id`、`member_count`、`today_total_steps`），由 `CamelModel` 的 `alias_generator` 转成 camelCase 后下发。
- 请求体 `SelectOrgRequest`（`backend/app/schemas/schemas.py:804-807`）用 `Field(alias="orgId")` + `populate_by_name`。
- `claim_user_org` 返回 `Optional[User]`（ORM 对象），路由再交 `get_user_org` 转 dict（`backend/app/api/routes/org.py:79-82`）。
- `admin_set_user_org` 返回 `bool`，路由据此选 message：`"已更新"` / `"组织未变化"`（`backend/app/api/routes/admin.py:820`），并在 `True` 时广播 WS 事件 `org.select`（`:818-819`）。

**异常与错误码**
| 抛出点 | 异常 | 路由转换 |
|---|---|---|
| `claim_user_org:112` | `ValueError(ORG_LOCKED)` | **403**（`backend/app/api/routes/org.py:77-78`） |
| `claim_user_org:104` 返回 `None` | — | **404**「组织不存在」（`backend/app/api/routes/org.py:79-80`） |
| `admin_set_user_org:127`「组织不存在」/ `:130`「用户不存在」 | `ValueError` | **404**（`backend/app/api/routes/admin.py:816-817`，两种文案都转 404） |
| 组织范围越界（`invite_service`） | `InviteError` | 404（「所选组织不存在」）/ 400（其它），见 `backend/app/api/routes/org.py:70-74` |

`/api/org/select` 的完整前置检查顺序：已有组织 → 403（`backend/app/api/routes/org.py:68-69`）；邀请码组织范围校验 → 404/400（`:70-74`）；原子认领 → 403/404（`:75-80`）；成功后广播 WS（`:81`）。

## 6. 依赖关系

**依赖（import，`:6-13`）**
- 标准库 `typing`；SQLAlchemy `and_`、`func`、`Session`。
- `app.core.helpers.today_str`（本文件 `:11`；定义于 `backend/app/core/helpers.py:22`）——`get_companions` 取当日日期（本文件 `:190`）。
- ORM：`DailySport`、`Organization`、`User`（本文件 `:12`；定义于 `backend/app/models/models.py:231`、`backend/app/models/models.py:163`、`backend/app/models/models.py:179`）。
- 服务层：`audit_service`（`:13`，仅 `admin_set_user_org` 用）、`march_service`（`:13`，仅 `get_org_march` 用其两个私有函数 `_ordered_nodes` / `_route_state`）。**跨模块引用另一服务的私有函数**，与 `march_service` 存在双向耦合风险（`march_service` 不反向 import 本模块）。
- 不 import `config.settings`；组织同步的 `ORG_SYNC_API_URL` 与本文件无关（见 §7）。

**数据库表**
| 表 | 访问 |
|---|---|
| `organizations` | 只读（`:23-26`、`:36-39`、`:56`、`:82`、`:167`）；`id` 为 `SERIAL PRIMARY KEY`（`docker/init/001_schema.sql:34`），`parent_id` 带索引（`backend/app/models/models.py:173`）。**无外键自引用约束**，环路只靠 `guard < 32` 兜底 |
| `users` | 读（`:106-109`、`:114`、`:128`、`:191-192`、`:200-206`、`:243-244`、`:247-249`）；写仅 `org_id` 一列（`:108`、`:135`） |
| `daily_sport` | 只读聚合（`:194-199`、`:201-205`、`:246-251`） |
| `audit_logs` | 经 `audit_service.record` 间接写（`:137-146`） |
| `route_nodes` | 经 `march_service._ordered_nodes` 间接只读（`:254`） |

**被依赖（backend/app 内 7 个文件 import 本模块）**
- 路由层：`backend/app/api/routes/org.py:18`（该文件内 7 处调用：`backend/app/api/routes/org.py:29`、`backend/app/api/routes/org.py:35`、`backend/app/api/routes/org.py:49`、`backend/app/api/routes/org.py:55`、`backend/app/api/routes/org.py:69`、`backend/app/api/routes/org.py:76`、`backend/app/api/routes/org.py:82`）、`backend/app/api/routes/auth.py:20`（调用点 `backend/app/api/routes/auth.py:55`）、`backend/app/api/routes/admin.py:92`（调用点 `backend/app/api/routes/admin.py:813`）。
- 服务层：`backend/app/services/admin_service.py:34`（该文件内调用 `get_full_name_map` 于 `backend/app/services/admin_service.py:406`、`backend/app/services/admin_service.py:451`、`backend/app/services/admin_service.py:675`，`get_full_name` 于 `backend/app/services/admin_service.py:556`，`subtree_org_ids` 于 `backend/app/services/admin_service.py:664`、`backend/app/services/admin_service.py:741`、`backend/app/services/admin_service.py:777`、`backend/app/services/admin_service.py:782`）、`backend/app/services/invite_service.py:17`（`get_path` 用于 `backend/app/services/invite_service.py:66`，`get_org` 用于 `backend/app/services/invite_service.py:100`、`backend/app/services/invite_service.py:168`）、`backend/app/services/profile_service.py:22`（`get_full_name` 用于 `backend/app/services/profile_service.py:135`）、`backend/app/services/rank_service.py:14`（`get_full_name_map` 用于 `backend/app/services/rank_service.py:67`）。
- 测试：`backend/test/s7_perf_refactor.py`（校验 `get_full_name_map` 口径）、`backend/test/p1_companions.py`、`backend/test/p1_org_march.py`。

## 7. 业务规则

**组织树的构建方式（三套并存，各有适用场景）**
1. **按层下钻**（`get_children`，`:30-52`）：每次只查一层 + 一次批量子节点计数，**固定 2 次查询、不组树**，树形结构由小程序端逐层展开维护（`frontend/pages/org-select/`）。用于组织规模可能很大的浏览场景。
2. **一次性内存组树**：管理端组织树走 `backend/app/services/admin_service.py:603-632`（全表一次查 + `tree_map` 按 `parent_id` 分组 + `_fill_children` 递归挂载 + `_accumulate_user_count` 后序累加人数），**不在本文件**。本文件不提供全树构建函数。
3. **单点回溯**（`get_path` / `get_full_name`，`:59-74`）：**逐级向上查库**，查询次数 = 层级深度（当前种子树最深 4 级，`backend/app/data/seed.py:318-332`）。这是本文件唯一「深度相关的多次查询」，`get_user_org`（`:155`）、`get_companions`（`:212`）、`get_org_march`（`:281`）都会触发。成批场景必须改用 `get_full_name_map`（1 次查询）。

**权限与状态流转**
- 用户侧：`org_id` 只能从 `NULL` 变为某值一次（`:105-109` 的条件 UPDATE），之后 `claim_user_org` 恒抛 `ORG_LOCKED`；`/api/org/select` 另有前置 403（`backend/app/api/routes/org.py:68-69`），条件 UPDATE 是**并发兜底**而非唯一防线。
- 入驻时写 `org_id` 的路径不经本文件：`auth_service.onboard` 直接构造 `User(org_id=org_id, …)`（`backend/app/services/auth_service.py:126-135`），同样属「首次确定」，之后锁定。
- 管理员侧：`admin_set_user_org` 是唯一能改已锁定组织的入口（`:117-148`），必须带 `operator`（管理员用户名）与 `actor_type`/`actor_id`（`backend/app/api/routes/admin.py:752-754` 的 `_actor`：超管为 `("super", None)`，微信关联管理员为 `("user", user_id)`）。
- 专属邀请码入驻的用户改选组织时，还受邀请码组织子树范围约束（`backend/app/services/invite_service.py:103-107`，由 `backend/app/api/routes/org.py:71` 调用）；历史用户（`invite_code_id` 为空）不受限。

**并发约束**
- `claim_user_org`：条件 UPDATE（`org_id IS NULL`），无行锁；并发认领只有一个 `rowcount == 1`。
- `admin_set_user_org`：`with_for_update()` 行锁（`:128`）。**这是本文件唯一的显式行锁**，符合 `.qoder/decisions/README.md`「并发控制用条件 UPDATE + `with_for_update()` 行锁，不用乐观锁版本号」一行。
- `get_companions` / `get_org_march`：纯读，无锁；同一请求内的多次聚合查询之间**不加事务隔离**，理论上可能读到不一致快照（如 COUNT 与 SUM 之间有新成员加入）。当前未见相关缺陷记录。

**事务边界（谁 commit）**
| 函数 | commit / rollback |
|---|---|
| `claim_user_org` | **自己 commit**（`:113`）；失败分支 rollback（`:111`） |
| `admin_set_user_org` | **自己 commit**（`:147`）；未变化分支 rollback（`:133`，释放行锁） |
| 其余全部函数 | 只读，不 commit / 不 rollback |

**组织同步与 `ORG_SYNC_API_URL`（本文件不参与，仅澄清归属）**
- 配置项 `ORG_SYNC_API_URL`（`backend/app/core/config.py:64`，默认空串）。
- **实际读取点在 `backend/app/services/admin_service.py:863`**（`_fetch_org_source`）：留空时**回退内置种子数据**，返回 `("seed（未配置 ORG_SYNC_API_URL，使用内置种子数据）", list(ORGANIZATIONS))`（`:864-865`）；非空时 `httpx.get(url, timeout=10)`，接受裸数组或 `{data: [...]}` 包装（`:866-876`），失败抛 `ValueError` 由路由转 **502**（`backend/app/api/routes/admin.py:743-748`）。
- 触发端点：`POST /api/admin/orgs/sync`（`backend/app/api/routes/admin.py:737-748`，菜单码 `orgs`），全量按 id upsert、数据源缺失的本地节点删除、仍被用户引用的节点保留并计入 `skipped`（`backend/app/services/admin_service.py:792-799` docstring）。
- **本文件与同步逻辑无任何代码关系**；种子数据同源（`backend/app/data/seed.py:318`），启动时由 `backend/app/main.py` lifespan 幂等写入。

**积分与派生统计**：本文件不写积分、不写事件、不写 `lit_nodes`——组织进度是纯实时聚合（`backend/test/docs/p1-org-march-report.md`「口径说明」：与个人路线解耦）。

## 8. 修改约束
- **camelCase 输出契约**（`backend/AGENTS.md` §4 不变量 1）：本文件返回的 dict 键名与 `OrgChildrenOut`/`UserOrgOut`/`OrgCompanionsOut`/`OrgMarchOut`（`backend/app/schemas/schemas.py:742-800`）字段一一对应，且最终下发给小程序 `frontend/services/org.js`。增删字段属破坏性变更，须三处同改（service + schema + 前端）。
- **隐私口径不得放宽**：`get_companions` 的条目只能含 `nickname`/`avatar`/`today_steps`/`is_self`（`:215-223`，需求 §9.4，docstring `:184-185`）。加 `user_id`、`openid` 即违约（冒烟用例 P1C-04 断言「条目字段 ⊆ {nickname,avatar,todaySteps,isSelf}」，`backend/test/docs/p1-companions-report.md`）。
- **`subtree_org_ids` 的 `result[0] == root_id` 不变量**：`backend/app/services/admin_service.py:777`、`:782` 依赖 `[1:]` 取「不含自身的子孙」。若改遍历实现（例如真改成 BFS 用 `pop(0)`），必须保证 root 仍在首位——`f59892e` 之前就因 `pop(0)` 的 O(n²) 被改过（`backend/test/docs/s14-hotspot-sql-report.md:22`）。
- **`get_path` 与 `get_full_name_map` 的 `guard < 32`**（`:64`、`:89`）是 `organizations` 无自引用外键时唯一的环路保护，不得删除；32 层是硬编码上限，超过即静默截断。
- **成批取组织名必须走 `get_full_name_map`**，不得在循环里调 `get_full_name`（每组织每层一次 DB 往返）——这正是 `20c79e3` 消除的 N+1（`backend/test/docs/s7-perf-refactor-report.md`）。
- **锁定语义不得回退**：`claim_user_org` 的条件 UPDATE（`:105-109`）与 `/api/org/select` 的前置 403（`backend/app/api/routes/org.py:68-69`）是双层防线，删任一层都会破坏 V2.0 需求五。
- **审计必须与组织变更同事务**：`audit_service.record` 不自行提交（`backend/app/services/audit_service.py:1-5`），`admin_set_user_org` 的 `:137-147` 顺序（record → commit）不可颠倒；「未变化不写审计」（`:132-134`）是 `07d02af` 明确的行为。
- **不得在本文件实现组织排名 / 分组织积分对比**：该需求已取消（`.qoder/REQUIREMENTS.md` §7「排行榜」表与 §12「已废弃规则」表的「组织排名 / 分组织积分对比」行）。
- 新增组织写路径须遵守 `backend/AGENTS.md` §4 不变量 6：session 一律由 `Depends(get_db)` 注入，service 内不自建（本文件符合；全项目唯一例外是 CSV 流式导出，见 `.qoder/ARCHITECTURE.md` §8.3）。

## 9. 当前实现状态

**已实现（可核对）**
- 组织树逐级下钻（固定 2 次查询）、面包屑路径、单个/批量全路径名、子树 id 集合。
- 用户首次认领锁定（条件 UPDATE 防并发）+ 管理员调整（行锁 + 审计 + 幂等「未变化不写审计」）。
- 同组织同行者（子树口径、隐私字段收敛、TOP-N）与组织共同长征目标（子树累计步数现算路线、节点 pct、当前/下一站）。
- 两轮去 N+1 优化已落地：`_child_counts` 用 `GROUP BY`（`:22-27`）、`get_full_name_map`（`:77-95`）、`subtree_org_ids`（`:165-177`）。

**存在问题 / 风险（事实陈述）**
1. **`get_path` 是深度相关的多次查询**（`:64-67`，每层 1 次 `get_org`）。当前组织树最深 4 级、13 个节点，影响可忽略；但 `get_user_org` 被 `get_companions`（`:212`）与 `get_org_march`（`:281`）内嵌调用，首页聚合并发拉取时会放大。单用户单次调用仍是有界（≤32）查询，**不是无界 N+1**。
2. **`get_full_name_map` / `subtree_org_ids` 每次调用都全表加载 `organizations`**（`:82`、`:167`）。设计上是「以整表一次查询换掉 N×depth 次查询」（`backend/test/docs/p1-companions-report.md`「备注」明确：组织树较小，若规模大幅增长可改物化路径，当前不做过度设计）。**同一次请求内多次调用会重复全表加载**：例如 `get_companions` 先 `subtree_org_ids`（`:189`）再 `get_user_org`→`get_path`（`:212`），`admin_set_user_org` 先 `with_for_update` 查 user（`:128`）再 `get_full_name_map`（`:136`）。
3. **`subtree_org_ids` 的 docstring 与实现不符**：`:166` 写「内存 BFS」，`:172-176` 用 `stack.pop()` 实为 DFS。结果集合相同，无功能影响，属注释滞后。
4. **`organizations` 无自引用外键**（`docker/init/001_schema.sql:33-39`、`backend/app/models/models.py:163-175`），`parent_id` 可指向不存在的 id；`get_path` 遇到断链会在 `get_org` 返回 `None` 时停止（`:64`、`:66`），得到**不完整的短路径**而非报错。
5. **`get_full_name_map` 对断链同样静默**：`:89` 的 `while current in info` 在父 id 缺失时终止，返回半截路径名。
6. `get_companions` 的 `limit` 默认 6（`:180`），路由侧钳制 1~50（`backend/app/api/routes/org.py:44`、`backend/app/api/routes/org.py:49`）；**service 层自身不钳制**，直接调用可传任意值。
7. `/api/org/children` **无任何鉴权依赖**（`backend/app/api/routes/org.py:23-29`），与 `backend/AGENTS.md` §4 不变量 2「除 `POST /api/auth/login` 外所有路由必须依赖 `get_current_user`」不一致；路由 docstring `:28` 明确写了「不鉴权也可浏览组织树」，属**有意为之的公开接口**（该不变量要求「新增公开接口需显式说明理由」，理由即此 docstring；`invite/verify` 与 `onboard` 亦为公开）。是否需要在 `.qoder/ARCHITECTURE.md` 的公开接口清单中补记——**待确认**。

**待开发 / 待确认**
- **组织排名与分组织积分对比：已取消，不实现**（`.qoder/REQUIREMENTS.md` §7「排行榜」表与 §12「已废弃规则」表的「组织排名 / 分组织积分对比」行；2026-10-02 用户确认）。本文件无相关代码，也**不应**新增。
- PC 端组织人数统计：已实现，但在 `backend/app/services/admin_service.py:603-632`（`GET /api/admin/orgs`，菜单码 `orgs`），不在本文件。
- 组织树「物化路径 / 闭包表」改造：仅在测试报告备注中作为规模增长后的备选提及（`backend/test/docs/p1-companions-report.md`），**无需求记录、无排期**——待确认。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/org_service.py`（**6 个提交**）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-13
- 需求：V2.0 需求五——所属部门首次确定后锁定（后端）。
- 修改内容：`07d02af`。① 模块 docstring 补锁定说明（`:4`）；② 新增 `ORG_LOCKED` 常量（`:15`）；③ `set_user_org` **改名并改语义**为 `claim_user_org`（`:98-114`）：由「查 user 再赋值」改为 `WHERE id=? AND org_id IS NULL` 的条件 UPDATE，影响 0 行即 rollback + 抛 `ORG_LOCKED`；④ 新增 `admin_set_user_org`（`:117-148`）：`with_for_update()` 行锁、未变化 rollback 返回 `False`、写 `user.org_change` 审计（操作人/原组织 id 与全名/新组织 id 与全名）；⑤ `get_user_org` 返回值新增 `locked` 字段（`:154`、`:161`）；⑥ import 增加 `audit_service`（`:13`）。复用 `users.org_id`，**无数据库迁移**。
- 关联文件：`backend/app/api/routes/org.py`（`/org/select` 前置 403 与 `/org/mine` 的 `locked`）、`backend/app/api/routes/admin.py`（新增 `PUT /admin/users/{user_id}/org`）、`backend/app/schemas/schemas.py`（`UserOrgOut.locked`、`AdminUserOrgRequest`）、`backend/test/s19_invite_admission.py`（I16/I17 更新）。
- 测试结果（`docs/迭代记录.md` 该条目「验证」原文）：**s19 25/25 通过**；I16/I17 已按锁定规则更新，覆盖专属码首次选组织的范围约束（越界 400、范围内 200、再次选择 403、`locked=true`）。

### 2026-10-11
- 需求：后端热点查询 SQL 聚合化与去 N+1（性能优化 / 缺陷修复）。
- 修改内容：`f59892e` 涉本文件两处。① `_child_counts`（`:18-27`）由「拉 `parent_id`/`id` 两列后在 Python 里累加」改为 `func.count(Organization.id)` + `GROUP BY parent_id` 直接返回 dict；② `_subtree_org_ids` **改名为公开的 `subtree_org_ids`**（`:165`）并同步两个内部调用点（`:189`、`:242`），以便 `admin_service` 复用、删除其重复的子树遍历（原实现 `pop(0)` 为 O(n²)）。实现体（整表一次加载 + 内存遍历）未变。
- 关联文件：`backend/app/services/admin_service.py`（组织删除/移动、`get_org_users`）、`backend/app/services/rank_service.py`、`backend/app/services/sport_service.py`、`backend/app/services/medal_service.py`、`backend/app/services/broadcast_service.py`、`backend/app/services/profile_service.py`、`backend/app/services/quiz_service.py`、`docker/init/012_perf_indexes.sql`。
- 测试结果（`docs/迭代记录.md` 该条目「验证」原文）：**openGauss 已应用 012；e2e_full_flow 178/178，e2e_datasync 23/23，S2–S7、P0/P1/P2、昵称冒烟全部通过；排行、播报结果与旧实现逐项一致（92 用户 / 20 用户样本）**。本文件相关的逐项对照另见 `backend/test/docs/s14-hotspot-sql-report.md:23`。

### 2026-10-03（P1-3）
- 需求：组织共同长征目标（docstring 标注需求 §10）。
- 修改内容：`b4a8910` 新增 `get_org_march`（`:227-291`）：子树成员累计步数求和、`lit` 集按 `total >= target_steps` 现算、复用 `march_service._route_state` 得到节点状态与路线进度、节点 `pct` 三档口径、「当前到达 / 下一站」按第一个未完成节点推导。同期 `march_service` 抽出 `_route_state`（个人路线与组织路线共用计算内核，lit 集由调用方构造）。
- 关联文件：`backend/app/services/march_service.py`、`backend/app/api/routes/org.py`（新增 `GET /org/march`）、`backend/app/schemas/schemas.py`（`OrgMarchNodeOut` / `OrgMarchOut`）、`frontend/pages/home/`（首页集体长征卡）、`backend/test/p1_org_march.py`。
- 测试结果：**待确认（`docs/迭代记录.md` 2026-10-03「组织共同长征目标 P1-3」条目只有「内容：组织集体长征接口+首页集体长征卡。」，未记录验证字段；`b4a8910` 提交信息正文亦无验证段）**。同期测试报告 `backend/test/docs/p1-org-march-report.md` 记录：`python test/p1_org_march.py` **6/6 通过**（P1M-01~06），回归 `backend/test/p0_route_progress.py` 10/10、`backend/test/p0_chapters.py` 10/10（`_route_state` 抽取零回归）。该报告另记：P1M-05 的完成态断言在 2026-10-09 批次 6 全链路回归中被改为「测试内显式补步推过目标」，以适配数据库重建。

### 2026-10-03（P1-2）
- 需求：同组织同行者（docstring 标注需求 §9，含 §9.4 隐私口径）。
- 修改内容：`f37e3d7`（+65 / −1 行）新增 `_subtree_org_ids`（后由 `f59892e` 改名为 `subtree_org_ids`，`:165-177`）与 `get_companions`（`:180-224`）：同行人数 = 子树成员 COUNT；今日共同前进 = 子树成员当日 `daily_sport.steps` JOIN 求和；同行者 = 子树成员 LEFT JOIN 当日步数、倒序限量、标 `is_self`，只下发昵称/头像/今日步数。
- 关联文件：`backend/app/api/routes/org.py`（新增 `GET /org/companions?limit=`）、`backend/app/schemas/schemas.py`（`CompanionItemOut` / `OrgCompanionsOut`）、`frontend/services/org.js`、`frontend/pages/home/`（首页「组织同行」卡）、`backend/test/p1_companions.py`。
- 测试结果：`docs/迭代记录.md` 2026-10-03「同组织同行者 P1-2」条目只有「内容：组织同行接口+首页组织同行卡。」，**未记录验证字段**；**提交信息正文**记「验证：后端冒烟 7/7、automator 3/3，截图 24」。测试报告 `backend/test/docs/p1-companions-report.md` 记录 `python test/p1_companions.py` **7/7 通过**（P1C-01~07，含子树口径与隐私字段收敛断言）。
- 备注：报告中「需用户 JWT」是当时口径；`/org/companions` 的权限依赖后续由活动时间守卫改造（`ce14a95`，2026-10-13）改为 `require_activity_view`（`backend/app/api/routes/org.py:45`）。

### 2026-10-02
- 需求：组织全名批量查询与驾驶舱计数优化，消除 N+1。
- 修改内容：`20c79e3`（+21 行，无删除）新增 `get_full_name_map`（`:77-95`）：一次性查出 `organizations` 的 `id/name/parent_id` 三列，内存中沿父链拼接全路径名（环路保护 32 层），替代 `rank_service` 里按组织逐层查库的私有 `_org_name_map`。
- 关联文件：`backend/app/services/rank_service.py`（删私有 `_org_name_map`，改走 `get_full_name_map`，`:67`）、`backend/app/services/admin_service.py`（`get_rank_overview` 点亮记录改 SQL 侧过滤且只取三列，`:406`）、`backend/app/services/dashboard_service.py`（`route_overview` 改排序 + `bisect_left` 计数）、`backend/test/s7_perf_refactor.py`、`backend/test/s5_org_user_counts.py`（修复既有脚本的清理顺序，与本次优化无关）。
- 测试结果：**待确认（`docs/迭代记录.md` 2026-10-02「组织全名批量查询与驾驶舱计数优化」条目只有内容摘要、未记录验证字段）**。提交信息正文记「口径经 S7 冒烟逐一核对不变」；测试报告 `backend/test/docs/s7-perf-refactor-report.md`（2026-10-02）记 `backend/test/s7_perf_refactor.py` **5/5 通过**，其中 P2 断言「`/admin/rankings` 134 个用户的 `org_name` 均为组织树可重建的全路径名」、P4 断言「小程序 `/rank/steps` 的 `orgName` 同为全路径名（同一 `get_full_name_map` 口径）」。

### 2026-09-30
- 需求：项目初始化。
- 修改内容：`a94e685` 创建本文件，含 `_child_counts`、`get_children`、`get_org`、`get_path`、`get_full_name`、`set_user_org`（后于 `07d02af` 改名 `claim_user_org`）、`get_user_org` 共 7 个函数；当时无 `ORG_LOCKED`、无 `audit_service` 依赖、无子树与聚合口径函数。
- 关联文件：仓库初始代码（backend + frontend）。
- 测试结果：待确认（`docs/迭代记录.md` 2026-09-30「项目初始化（init）」条目仅「内容：仓库初始代码。」，未记录验证字段）。
