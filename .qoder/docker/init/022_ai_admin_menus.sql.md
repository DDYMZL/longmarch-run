# 022_ai_admin_menus.sql

## 1. 文件路径

`docker/init/022_ai_admin_menus.sql`（31 行）

> **⚠ 本文件未入库（untracked）**：`git status --porcelain -- docker/init/` 输出 `?? docker/init/022_ai_admin_menus.sql`，`git ls-files docker/init/` 中**不含**本文件。原因是仓库根 `agents.md` §1.3 规定「`docker/` 目录下的代码不自动提交」。后果：① `git log --follow` 与 `git blame` 对本文件**无任何输出**，§10 无法给出本文件自身的提交号；② **生产 openGauss 缺失本迁移**（`.qoder/PROJECT.md` §8「阻塞级」第 3 项、`.qoder/ARCHITECTURE.md` §12.4「生产迁移缺口」段）。

## 2. 文件职责

向 `admin_menus` 表注入「AI 智能中心」的 **5 个子页菜单码**（`ai_overview` / `ai_knowledge` / `ai_workshop` / `ai_logs` / `ai_config`），供后端 `require_menu(code)` 做细粒度鉴权、并作为管理端「人员授权」页可授予的权限项（`:4-5` 头注释）。**只写 `admin_menus` 一张表，不改任何业务表、不建表、不授予内置角色**（`:6-7`）。

## 3. 业务需求

《长征步迹 AI 智能中心开发需求 V1.0》Phase A（2026-10-17），与 `021_ai_center.sql` 同批产生、同批未入库。对应后端提交 `1600074`（该提交新增 `backend/app/api/routes/ai_admin.py` 381 行，其端点用 `require_menu("ai_knowledge")` / `require_menu("ai_workshop")` 等做守卫）。

业务场景：管理后台 RBAC 的权限粒度是**菜单码**（`.qoder/ARCHITECTURE.md` §5.3「RBAC 模型」段），后端每个管理端接口用 `require_menu(code)` 校验，管理端「人员授权」页按 `admin_menus` 表列出可授予项。AI 智能中心新增 5 个子页，就必须先在 `admin_menus` 里登记这 5 个码，否则：① `require_menu` 查不到菜单行、鉴权链路无法授权给自定义角色；② 授权页看不到这 5 项、无法勾选。先例是 `010_admin_identity.sql:106-115`（初始 9 码）、`015_invite_admission.sql`（`invites`）、`016_activity_settings.sql`（`activity`）。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:31`）。

### 4.1 幂等 DO 块（`:12-29`）

单个 `DO $$ BEGIN … END $$;` 内**逐码**做 `IF NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = '<码>') THEN INSERT INTO admin_menus (code, name, sort_order) VALUES (…); END IF;`，共 5 组判定 + 插入。

`:10-11` 头注释明确说明选型理由：「幂等：DO 块内逐码 `IF NOT EXISTS` 判定后 `INSERT ... VALUES`，重复执行不产生重复行；**不依赖 SELECT-without-FROM 与 `ON CONFLICT`**（openGauss 兼容性最稳）」——即刻意避开 `SQL_CONSTRAINTS.md` §1.5 明列不支持的 `INSERT ... ON CONFLICT DO UPDATE`，改用 §1.5 推荐的 `WHERE NOT EXISTS` 类手法。

### 4.2 5 条菜单种子

| 菜单码 | 名称 | `sort_order` | 行号 | 后端接口状态 |
|---|---|---|---|---|
| `ai_overview` | AI运行概览 | **10** | `:14-16`（INSERT 在 `:15`） | **未实现**（`.qoder/ARCHITECTURE.md` §11.3） |
| `ai_knowledge` | AI知识库 | **11** | `:17-19`（INSERT 在 `:18`） | 已就绪，6 个 `/knowledge*` 端点 |
| `ai_workshop` | AI题目工坊 | **12** | `:20-22`（INSERT 在 `:21`） | 已就绪，7 个 `/jobs*` + `/drafts*` 端点 |
| `ai_logs` | AI调用记录 | **13** | `:23-25`（INSERT 在 `:24`） | **未实现**（`.qoder/ARCHITECTURE.md` §11.3） |
| `ai_config` | AI配置中心 | **14** | `:26-28`（INSERT 在 `:27`） | 已就绪，2 个 `/config` 端点 |

- 三列写入：`code`（权限码，硬契约）、`name`（中文名，授权页与侧边栏展示用）、`sort_order`（排序）。
- **未写 `admin_role_menus`**：默认**不授予**内置 `operator` 角色，沿用 `010_admin_identity.sql:105` 对 `access`/`audit` 的做法——新菜单默认仅超级管理员可见，可由「人员授权」页按需授予自定义角色（`:6-7` 头注释）。已复核：全文件对 `admin_role_menus` 命中 0 次。

## 5. 输入与输出

- **输入（前置条件）**：`admin_menus` 表必须已存在——由 `010_admin_identity.sql:54-59` 建立（`id SERIAL PK`、`code VARCHAR(32) NOT NULL` + 唯一索引 `uq_admin_menus_code`、`name VARCHAR(32)`、`sort_order INTEGER NOT NULL DEFAULT 0`）。
- **输出**：`admin_menus` 新增 **5 行**（5 个 `ai_*` 菜单码）。**不建表、不加列、不建索引、不改任何业务表、不重算历史数据**。
- **对既有数据的影响**：仅追加。已存在的 9 个初始码（`010`）+ `invites`（`015`）+ `activity`（`016`）共 11 行**不被修改**，但 `sort_order` 的**排序语义被改变**——新码与既有码重号（§7.3）。
- **失败模式**：若 `admin_menus` 不存在则 DO 块报 `UndefinedTable`；若 `code` 撞唯一索引 `uq_admin_menus_code`，`IF NOT EXISTS` 判定已先行规避，正常路径不会触发。

## 6. 依赖关系

- **依赖先序迁移**：`010_admin_identity.sql`（建 `admin_menus` 表 + 初始 9 码 + 内置 `operator` 角色）。与 `015`、`016` 是**同表并列追加**关系（无 SQL 级依赖，但 `sort_order` 取值互相影响）。
- **与 `021_ai_center.sql` 的关系**：**逻辑配套、SQL 无依赖**。022 只写 `admin_menus`，不引用任何 `ai_*` 表；但业务上 5 个菜单码对应的管理页要读 021 建的表。两者必须**一起补跑**，只跑其一会造成「有表无权限码」或「有权限码无表」。
- **对应 ORM**：`backend/app/models/models.py:456-465`（`AdminMenu`）——本文件**不加列**，故 ORM 侧无对应改动；`code` 唯一性由 `010:61` 的 `uq_admin_menus_code` 承载。
- **读写方**：
  - `backend/app/api/routes/ai_admin.py`——`require_menu("ai_knowledge")`（`:80`、`:101`、`:105`、`:123`、`:136`、`:141`、`:159`、`:164`、`:182`、`:186`）、`require_menu("ai_workshop")`（`:204`、`:208`、`:232`、`:247`、`:260`、`:277`、`:282`、`:298`）等；`ai_config` 的守卫见 `.qoder/backend/app/api/routes/ai_admin.py.md`。
  - `backend/app/services/access_service.py`——`get_menu_codes`（`:55-66`）、`get_all_menu_items`（`:78-81`）读 `admin_menus` 并按 `sort_order` 排序。
  - `backend/app/api/deps.py`——`require_menu` 依赖实现。
  - `admin/src/router/menus.ts`——管理端侧边栏**静态数组**（本文件种的 5 个码在此**未登记**，见 §9）。

## 7. 业务规则

1. **权限粒度到菜单码**，无按钮级权限（`.qoder/ARCHITECTURE.md` §5.3「RBAC 模型」段）。`admin_menus.code` 是后端 `require_menu(code)` 与管理端路由权限码的**双向硬契约**，不得改名。
2. **新菜单默认超管专属**：本文件刻意不写 `admin_role_menus`，故内置 `operator` 角色看不到这 5 项（`:6-7`），与 `010:105` 对 `access`/`audit` 的处理一致。需要授予时由「人员授权」页操作，属运行期数据、不属迁移。
3. **⚠ `sort_order` 重号（已知技术债，只记录不修改）**：本文件 `:15` 的 `ai_overview` = **10** 与 `015_invite_admission.sql` 种的 `invites` = **10** 冲突；`:18` 的 `ai_knowledge` = **11** 与 `016_activity_settings.sql` 种的 `activity` = **11** 冲突。登记于 `.qoder/PROJECT.md` §8「代码级技术债」第 26 项与 `.qoder/ARCHITECTURE.md` §13.4；2026-10-17 经用户决定**只记录不修改**。
   - **实际影响面比登记的更窄**：管理端侧边栏顺序由 `admin/src/router/menus.ts` 的**静态数组**决定（该文件当前只登记到 `invites`、`activity`，见 §9），**不读 `sort_order`**，故重号**不影响侧边栏显示顺序**。
   - **真正的风险在后端排序不稳定**：`backend/app/services/access_service.py` 有**四处** `order_by(AdminMenu.sort_order)`——`:63`（`get_menu_codes`，角色菜单码并集）、`:80`（`get_all_menu_items`，超管可见全集）、`:201`、`:259`。四处均**只按 `sort_order` 单列排序、无二级排序键**，同分行（10/10、11/11）的相对顺序由 openGauss 的返回顺序决定，**跨查询、跨版本不保证稳定**。表现为：授权页菜单勾选列表、`/auth/me` 返回的 `menus` 数组中，`invites` 与 `ai_overview`（及 `activity` 与 `ai_knowledge`）的先后可能变化。不阻塞功能，但会让前端快照测试与人工验收结果不可复现。
   - **修复方向（未实施）**：给 `sort_order` 重编号，或在四处 `order_by` 补二级键 `.order_by(AdminMenu.sort_order, AdminMenu.id)`。因本文件已应用于本地库、且 `SQL_CONSTRAINTS.md` §3.1 禁止修改已执行脚本，正确做法是新增编号迁移改 `sort_order`。
4. **幂等**：`IF NOT EXISTS` 逐码判定（`:14`、`:17`、`:20`、`:23`、`:26`），重复执行不产生重复行、不报错——这是 §2.2 的合规实现，也是与 `010:106-123` 裸 INSERT（重跑撞唯一约束整批中止）的关键差别。
5. **`name` 是展示文案**：授权页与菜单接口直接返回该中文名（`access_service.py:75`、`:81`），改名不影响鉴权但会改变前端显示。

## 8. 修改约束

1. **⚠ 本文件未入库，故生产库缺失**：与 `021` 同批。`SQL_CONSTRAINTS.md` §3.1「禁止修改已在生产执行过的编号脚本」对本文件的适用情况是——**本地 openGauss 已应用并登记 `schema_migrations`，生产库尚未执行**。当前处于「可改但不应改」的窗口期；若确需变更（例如修 §7.3 的重号），正确做法是保持 `022` 不动、新增 `023_*.sql`，避免本地与生产 `schema_migrations` 出现**同名不同内容**（补跑时会被 `init-db.sh` 按 version 跳过，导致生产永久缺这 5 个菜单码）。
2. **必须与 `021` 一起补跑**：见 §6。补跑后须按 `SQL_CONSTRAINTS.md` §6 回填 `schema_migrations`。
3. **5 个 `code` 不得改名**：`ai_knowledge` / `ai_workshop` / `ai_config` 已被 `backend/app/api/routes/ai_admin.py` 的 `require_menu(...)` 硬编码引用（行号见 §6），改名等于让对应管理端接口全线 403。
4. **`sort_order` 追加新菜单时须避开既有值**——本文件自身已违反这条（§7.3），是 `.qoder/PROJECT.md` §8「代码级技术债」第 26 项的成因之一（`010_admin_identity.sql.md` §8.3 亦已登记该约束）。
5. **不得给内置 `operator` 角色批量授权这 5 个码**：`:6-7` 的「默认仅超管可见」是有意设计，与 `access`/`audit` 同口径；确需授予走运行期「人员授权」页，不写进迁移。
6. `admin_menus.name` 为 `VARCHAR(32)`（`010:58`），本文件 5 个中文名最长 6 字（`AI题目工坊`），未超长；追加新码时注意该长度上限。

## 9. 当前实现状态

- **已实现（本地）**：5 个菜单码已在本地 openGauss 应用并登记 `schema_migrations`；`ai_knowledge` / `ai_workshop` / `ai_config` 三个码已被 `backend/app/api/routes/ai_admin.py` 的 15 个端点实际守卫。
- **⚠ 生产库缺失（阻塞级）**：`.qoder/PROJECT.md` §8「阻塞级」第 3 项。生产未执行本迁移的直接后果：`require_menu("ai_knowledge")` 等查不到菜单行，**自定义角色无法被授予 AI 管理权限**，只有超级管理员（不走菜单码校验）能访问 `/api/admin/ai/*`。生产库当前 `schema_migrations` 与 `admin_menus` 实际内容：**待确认（本次建档禁止连库）**。
- **`ai_overview` / `ai_logs` 是「有码无接口」**：`:15`、`:24` 种入了这两个码，但 `backend/app/api/` 下**零命中**，`AiUsageLog` 在 api 层零引用（`.qoder/ARCHITECTURE.md` §11.3 已按此拆分为两行登记）。即 AI 运行概览与调用记录两个管理页**后端接口亦未实现**，这两个菜单码目前是纯占位。
- **⚠ 头注释与实际不符（本文件唯一的内容性错误）**：`:5` 声称 5 个码「与 `admin/src/router/menus.ts` 目录保持一致」。实测 `admin/src/router/menus.ts` 中 `ai_` 前缀命中 **0** 次，该文件当前只登记到 `invites`（`:12`）与 `activity`（`:14`）——**5 个 AI 菜单码在管理端路由里一个都没有登记**。这与 `.qoder/ARCHITECTURE.md` §11.3「管理后台 AI 子页面……待开发；`admin/src/router/menus.ts` 未登记」一致。**结论：注释表述超前于实现，应理解为「目标口径」而非「当前状态」**；本文件未入库，若后续修改应更正该句（但因 §8.1 的窗口期约束，建议连同重号修复一起走新编号）。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` 逐项）——与 `021` 并列为全库合规度最高的迁移**：
  - **§1.1 合规（0 处）**：全文件无 `ALTER TABLE`，未命中禁用语法（已 `grep -c "ADD COLUMN IF NOT EXISTS"` 复核，命中 0）。
  - **§1.2 不涉及**（无 CREATE INDEX）；**§1.3 不涉及**（无 CREATE TABLE）。
  - **§1.4 合规**：5 处 `SELECT 1 FROM admin_menus WHERE code = …` 是普通表查询，**无派生表**。
  - **§1.5 合规**：**未用 `ON CONFLICT`**（`:11` 头注释明写刻意规避），改用 DO 块内 `IF NOT EXISTS` 判定后裸 `INSERT`；也未依赖 `SELECT` 无 `FROM` 子句（`:11`）——这两点都是 openGauss 老版本的常见坑。未用 `ALTER COLUMN TYPE`、无触发器、无 JSON 操作符。
  - **§2.1 合规**（`:1`/`:31`）；**§2.2 完全合规**（逐码 `IF NOT EXISTS`，重跑纯 no-op）；**§2.3 合规**（无 DROP/TRUNCATE/DELETE；`:8` 的回滚 DELETE 只写在**注释里**、不是可执行语句）；**§2.4 不涉及**（无 UPDATE）。
  - **§4 完全合规**：`:4-8` 三段式头注释齐全——变更目的（`:4-5`）、影响面（`:6-7`）、回滚（`:8`）。**本批 6 个文件中只有 `021`、`022` 满足 §4**；`:10-11` 还额外说明了幂等手法选型理由，超出 §4 要求。
  - **可安全重跑**：DO 块 + `IF NOT EXISTS` 双重幂等，重跑不产生重复行、不报错、不改既有数据。与 `017`/`019` 的「不可重复执行」形成对比。
- **`ALL_MENU_CODES` 死常量与本文件的差异（`.qoder/PROJECT.md` §8「代码级技术债」第 22 项的补充证据）**：`backend/app/services/access_service.py:27-39` 定义了 `ALL_MENU_CODES` 列表，**全仓 grep 确认它只有 `:27` 的定义处一次命中、无任何引用**（`grep -rn "ALL_MENU_CODES" backend/ --include=*.py` 仅返回定义行），是死常量。其内容与本文件的差异：
  - 该常量含 **11 项**：`dashboard`、`screen`、`rankings`、`route_nodes`、`questions`、`quotes`、`orgs`、`access`、`audit`（`:28-36`，即 `010` 种的 9 码）+ `invites`（`:37`，`015` 种）+ `activity`（`:38`，`016` 种）。
  - **它已包含 `activity`**（`:38`）——若 §8 第 22 项的表述是「未含 `activity`」，与源码不符，需更正。
  - **它不含本文件种入的 5 个 `ai_*` 码**（`ai_overview`/`ai_knowledge`/`ai_workshop`/`ai_logs`/`ai_config`），即该常量停留在 `016` 时代，`022` 之后落后 5 项。
  - 因为它是死常量，**这个落后不产生任何运行时故障**；真正的菜单全集由 `get_all_menu_items`（`:78-81`）直接查库得到，天然包含本文件的 5 行。风险仅在于：若将来有人误信该常量是权威清单并据此做校验或初始化，会静默漏掉全部 AI 菜单。建议处置：删除该常量，或改为从库查询。
- **ORM 与 DDL 分歧**：**无**——本文件不建表、不加列、不建索引，只插入 `admin_menus` 的 3 个既有列（`code`/`name`/`sort_order`，均见 `models.py:456-465` 与 `010:54-59`），未涉及 `id`（SERIAL 自增）。插入值类型与列定义一致（`code` ≤ 13 字符 < `VARCHAR(32)`；`name` ≤ 6 字符 < `VARCHAR(32)`；`sort_order` 为整数字面量）。
- **敏感信息检查**：**本文件不含任何敏感种子值**——5 条 INSERT 只写菜单码、中文菜单名与排序整数，**无口令/密码/Token/AppSecret/JWT 密钥/连接串/CloudBase 环境 ID 或 API Key/邀请码明文/openid/unionid**，也不写 `admin_roles`、`admin_user_roles`、`admin_role_menus`（即不创建任何账号或授权关系）。**无需轮换处置。**
- **回滚方式**：`:8` 头注释已给出——「无副作用，可直接忽略；如需回退，单独 `DELETE FROM admin_menus WHERE code IN (下列 5 码)`」。即本文件**不含可执行回滚语句**（符合 `SQL_CONSTRAINTS.md` §2.3「迁移不删除数据」）。手工回滚需注意：删这 5 行会因 `admin_role_menus.menu_id` 的 FK（`010:73-77`）在**已被授予自定义角色**时失败，须先删 `admin_role_menus` 中对应关联行；且删码后 `require_menu("ai_knowledge")` 等会立即让 `/api/admin/ai/*` 对非超管全线 403。

## 10. 迭代记录

> **数据来源说明**：本文件按仓库根 `agents.md` §1.3「`docker/` 目录下的代码不自动提交」**未入库**，`git status --porcelain` 显示 `?? docker/init/022_ai_admin_menus.sql`，`git ls-files docker/init/` 不含本文件，故 `git log --follow -- docker/init/022_ai_admin_menus.sql` 与 `git blame` **均无输出**——**本节不列本文件自身的提交号，以下条目引用的是引入对应功能的后端/前端提交**（已逐个 `git show --stat` 核实确属 AI 智能中心）。

### 2026-10-17（`1fbacac`，11:26）
- 需求：VPN 关闭后重跑 AI 智能中心真实链路。
- 修改内容（涉本文件）：**未改动本文件**。该提交只涉及测试报告、结果 JSON 与新增 `frontend/test/automator/ai-chat-live.cjs`（5 个文件）。本文件的 5 个菜单码属**管理端**权限，该提交验证的是**小程序端**真实 Agent 链路，两者无交集；管理后台 5 个 AI 子页面至今待开发（`.qoder/ARCHITECTURE.md` §11.3），故这 5 个码**尚未经过真实管理端交互验收**。
- 关联文件：`backend/test/docs/s26-ai-center-report.md`、`frontend/test/automator/ai-chat-live.cjs`、`frontend/test/docs/ai-chat-page-report.md`。
- 测试结果：s26 47/47、小程序模拟器真实 Agent E2E 4/4。见 `docs/迭代记录.md` 的 `1fbacac` 条目。

### 2026-10-17（`1600074`，11:06）
- 需求：《长征步迹 AI 智能中心开发需求 V1.0》Phase A——管理端 AI 接口需要菜单码粒度的 RBAC 守卫。
- 修改内容（涉本文件）：本文件在此期间创建并应用于本地 openGauss（种入 5 个 `ai_*` 菜单码，`sort_order` 10–14，不授予内置 `operator`），但**未被该提交纳入版本库**。`1600074`（15 个文件、+3422 行）新增 `backend/app/api/routes/ai_admin.py` 381 行——即以这 5 个码为守卫的 15 个管理端端点（`require_menu("ai_knowledge")` 见 `:80`/`:101`/`:105`/`:123`/`:136`/`:141`/`:159`/`:164`/`:182`/`:186`，`require_menu("ai_workshop")` 见 `:204`/`:208`/`:232`/`:247`/`:260`/`:277`/`:282`/`:298`）；`git show --stat 1600074` 的文件清单中**无任何 `docker/init/*`**，是本文件未入库的直接证据。
- 关联文件：`backend/app/api/routes/ai_admin.py`、`backend/app/api/deps.py`（`require_menu`）、`backend/app/services/access_service.py`（菜单查询与排序）、`docker/init/021_ai_center.sql`（同批未入库）、`docker/init/010_admin_identity.sql`（`admin_menus` 表与初始 9 码）。
- 测试结果：冒烟 s26 **47/47** 通过（含真实 Agent 调用），报告 `backend/test/docs/s26-ai-center-report.md`。**注意**：s26 覆盖的是 `/api/ai/*` 与 `/api/admin/ai/*` 接口层，5 个菜单码在**管理端 UI 侧的授权交互未验收**（子页面待开发）。见 `docs/迭代记录.md` 的 `1600074` 条目。

### 2026-10-17（`0052108`，11:06）／（`37f3e40`，00:22）
- 需求：同批 AI 智能中心 Phase A 的小程序端与配置项交付。
- 修改内容（涉本文件）：**两个提交均未改动本文件，且与本文件无直接关系**——`0052108`（30 个文件）是小程序 `pages/ai-chat` 与 tab 换防，属 C 端；`37f3e40` 只改 `backend/.env`（+14）与 `backend/.env.prod`（+19/−3），是 AI 配置项而非菜单权限。此处一并列出以说明：本文件所属的 AI Phase A 批次共 4 个已核实提交，**没有任何一个把 `docker/init/021`、`022` 纳入版本库**，这正是 §1 所述生产缺口的成因。
- 关联文件：`frontend/pages/ai-chat/`、`frontend/services/ai.js`（`0052108`）；`backend/.env`、`backend/.env.prod`、`backend/app/core/config.py:66-91`（`37f3e40`，**依 `.qoder/README.md` §3.14 不记录任何值**）。
- 测试结果：`0052108` 见 `frontend/test/docs/ai-chat-page-report.md`、`ai-tab-swap-report.md`；`37f3e40` 见 `docs/迭代记录.md` 对应条目。
