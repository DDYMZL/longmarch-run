# 016_activity_settings.sql

## 1. 文件路径

`docker/init/016_activity_settings.sql`（40 行）

## 2. 文件职责

「活动时间控制」（V2.0 需求一）建表迁移：新建**单行配置表** `activity_settings`（`id` 固定为 1，`:9-21`），种入保持现网行为的默认配置 1 行（`:24-33`），并种入 `activity` 后台菜单（`:36-38`）。活动状态（未发布/未开始/进行中/已结束）**不落库**，由后端按服务器时间实时计算（`:5-6` 注释）。

## 3. 业务需求

`ce14a95`（2026-10-13）「活动时间控制——activity_settings 迁移/服务/公开状态接口/管理端设置发布与审计，写接口按活动状态 403 拦截、读接口按结束后可查看配置放行，业务日期统一北京时间」交付（`docs/迭代记录.md` 的 `ce14a95` 条目）。业务规则（`:4-8` 注释）：`start_at`/`end_at`/`updated_at` 为 UTC naive 存储，管理端与小程序展示按北京时间换算；`restrict_enabled=FALSE` 时不拦截任何业务（仅展示状态）；`allow_view_after_end=TRUE` 时活动结束后仍可查看历史成绩与历史排行。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:40`）；注释在事务内（`:3-8`、`:23`、`:35`），缺「回滚」段。

### 4.1 建表 `activity_settings`（`:9-21`）

| 列 | 类型/约束 | 业务含义 |
|---|---|---|
| `id` | `INTEGER` PRIMARY KEY（**非 SERIAL**） | 单行哨兵主键，恒为 1（`SETTING_ID = 1`，`backend/app/services/activity_service.py:20`） |
| `name` | `VARCHAR(64)` NOT NULL | 活动名称 |
| `start_at`/`end_at` | `TIMESTAMP` NOT NULL 无默认 | 活动起止时间，UTC naive 存储、北京时间展示（`:4-5` 注释） |
| `is_published` | `BOOLEAN` NOT NULL DEFAULT FALSE | 未发布时对所有用户隐藏活动（状态计算的第一个分支，`activity_service.py:52`） |
| `restrict_enabled` | `BOOLEAN` NOT NULL DEFAULT TRUE | 总开关：FALSE 时不拦截任何业务，仅展示状态 |
| `allow_view_after_end` | `BOOLEAN` NOT NULL DEFAULT TRUE | 结束后是否仍可查看历史成绩与排行 |
| `end_title` | `VARCHAR(64)` 可空 | 结束页标题文案 |
| `end_message` | `VARCHAR(500)` 可空 | 结束页正文文案 |
| `updated_at` | `TIMESTAMP` NOT NULL DEFAULT CURRENT_TIMESTAMP | 最近修改时间（DB 侧默认值） |
| `updated_by` | `VARCHAR(64)` 可空 | 最近修改人标识（非 FK） |

无 FK、无二级索引（单行表无需）；**不是 EAV 键值表**——是宽表式单行配置（与 013 的 `system_settings` EAV 表分工不同，见 §6）。

### 4.2 默认配置种子（`:24-33`）

`INSERT ... SELECT 1, ... WHERE NOT EXISTS (SELECT 1 FROM activity_settings WHERE id = 1)`——幂等（§1.5 推荐写法）。1 行、10 列：活动名与默认起止时间（按 `:23` 注释保持现网行为：已发布、北京时间 2026-09-01 00:00 至 2026-12-31 23:59 进行中，库内以对应 UTC 值存储）、三个开关全 TRUE、结束页标题/正文两条中文文案、`updated_by='system'`。**无任何凭据类敏感值**；文案与时间属业务配置，具体值以文件为准（本文档不整段抄录文案）。

### 4.3 菜单种子（`:36-38`）

INSERT `admin_menus` (`activity`,「活动设置」, `sort_order=11`)，`WHERE NOT EXISTS` 防重。默认**仅超管可见**，可在「人员授权/角色管理」中按需授予（`:35` 注释）——与 015 的 `invites` 不同，**未**给内置 `operator` 角色授权。

## 5. 输入与输出

- **输入（前置条件）**：`010_admin_identity.sql`（`admin_menus` 表及 `uq_admin_menus_code`）。
- **输出**：1 张表 + 2 行种子（1 行活动配置、1 行菜单）；不改任何既有表/数据。
- **失败模式**：全部语句幂等（`CREATE TABLE IF NOT EXISTS` + 两段 `WHERE NOT EXISTS`），手工重跑无副作用；实测无任何 §1.1 禁用语法（`ADD COLUMN IF NOT EXISTS` 命中 0 处），是 011–016 中兼容性最好的一份。

## 6. 依赖关系

- 依赖：`010_admin_identity.sql`（菜单表）。与 013 建的 `system_settings`（EAV 键值）**并存不重叠**：系统级零散配置进 `system_settings`，活动整体配置是结构化单行宽表进本表。
- 被依赖：
  - ORM：`ActivitySetting`（`backend/app/models/models.py:108-123`，逐列一致）。
  - 服务：`backend/app/services/activity_service.py`——`get_setting`（`:45-46` 按 `id=1` 查）、`compute_status`（`:49` 起，状态实时计算不落库）、`_access`（`:62-68`，`setting is None` 或 `restrict_enabled=FALSE` 时**放行一切**，即 fail-open）、`_ensure_setting`（`:131-141`，行缺失时后端自建未发布占位行）、`update`/`set_published`（`:156`/`:190`，管理端修改 + 审计快照 `_snapshot` `:143`）。
  - 路由：`backend/app/api/routes/admin.py` 活动设置管理接口（`require_menu("activity")` `:1048`、`:1061`、`:1080`）；公开状态接口与写接口 403 拦截（`ce14a95` 提交信息）。
  - 鉴权依赖：`backend/app/api/deps.py` 活动守卫按状态拒绝时返回 403 + `X-Activity-Status` 头（unpublished/not_started/ended，`:59-71`），小程序据此展示对应态（`.qoder/ARCHITECTURE.md` §14 不变量 5）。
  - 后续迁移：`022_ai_admin_menus.sql:18` 的 `ai_knowledge` 菜单与本文件 `sort_order=11` 撞号（见 §7 规则 3）。

## 7. 业务规则

1. **单行约定**：全表恒只有 `id=1` 一行；后端所有读写都按 `SETTING_ID=1` 过滤（`activity_service.py:20`、`:46`），不做多活动扩展。
2. **状态派生不落库**：未发布/未开始/进行中/已结束由 `is_published` + `start_at`/`end_at` + 服务器当前时间实时计算（`:5-6` 注释、`compute_status`），改时间即时生效，无状态列可失同步。
3. **`sort_order` 重号（已知问题，只记录不修改）**：`:37` 的 `activity=11` 与 `022_ai_admin_menus.sql:18` 的 `ai_knowledge=11` 冲突，登记于 `.qoder/PROJECT.md` §8「代码级技术债」第 26 项与 `.qoder/ARCHITECTURE.md` §13.4；2026-10-17 经用户决定**只记录不修改**。
4. **UTC 存储、北京时间展示**：种子行的起止时间即按此换算写入（`:23` 注释）；业务日期统一北京时间的口径见 `ce14a95` 提交信息。
5. `restrict_enabled=FALSE` 与 `setting` 缺行同为 fail-open（`_access` `:63`）——删表/删行不会锁死业务，但会失去时间管控。

## 8. 修改约束

1. **禁止修改本文件**（`SQL_CONSTRAINTS.md` §3.1）。是否已在生产 `schema_migrations` 登记：待确认（本次建档禁止连库）；按功能上线时间（2026-10-13）推定已执行。
2. `id=1` 单行哨兵、`activity` 菜单码、三个布尔开关的列名均为后端/管理端硬契约，不得改名；扩展活动配置优先加列（新编号迁移）而不是加行。
3. 修改默认活动时间/文案走**管理端设置页**（运行期数据），不要动本文件种子（只对全新库生效）。
4. `end_title`/`end_message` 长度上限 64/500，加长须新迁移改列。

## 9. 当前实现状态

- **已实现**：活动状态计算、写接口 403 拦截、读接口结束后可查看放行、管理端设置发布与审计均已上线（`ce14a95` 批次）。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md`）**：
  - §1.1 不涉及（实测 `ADD COLUMN IF NOT EXISTS` 命中 0 处）；§1.2 不涉及（无 CREATE INDEX）；§1.3 合规（`:9`）。
  - §1.4 合规（`:24-33`/`:36-38` 的 `WHERE NOT EXISTS` 为存在性子查询，非 FROM 派生表）；§1.5 合规（未用 `ON CONFLICT`）。
  - §2.1 事务合规（`:1`/`:40`）；§2.2 幂等合规（可安全重跑）；§2.3 合规（无删数据）。
  - §4 部分合规：`:3-8`/`:23`/`:35` 有目的/影响面/行为说明，缺「回滚」段。
  - `TIMESTAMP '2026-08-31 16:00:00'` 字面量写法（`:28`）未列入约束文档任何表格——按 §1.5 末段属「需本地跑通再生产 dry-run」的语法；该批次已随 V2.0 上线，视为已验证（生产执行留痕待确认）。
- **与 ORM 的差异**：结构逐列一致（`models.py:108-123`）；仅 `updated_at` 双默认值并存——DDL `CURRENT_TIMESTAMP`（`:19`）+ ORM 客户端 `default=datetime.utcnow`（`models.py:122`），属全库两套默认值写法（`.qoder/ARCHITECTURE.md` §13.2）。`is_published` 等三布尔 ORM 客户端默认（`models.py:117-119`）与 DDL DEFAULT 亦并存。
- **`sort_order` 重号复核**：本文件 `:37`（activity=11）与 `022_ai_admin_menus.sql:18`（ai_knowledge=11）、015 `:32`（invites=10）与 `022_ai_admin_menus.sql:15`（ai_overview=10）——行号实测仍准确，`.qoder/PROJECT.md` §8「代码级技术债」第 26 项登记属实。
- **敏感数据检查**：种子仅业务配置（活动名/时间/开关/结束文案）与 `updated_by='system'`，**无口令、Token、邀请码、openid**，无需轮换处置。
- **回滚方式**：文件内无回滚语句。手工回滚 = 删 `activity` 菜单行 + `DROP TABLE activity_settings;`——`activity_service._access` 对 `setting=None` fail-open（`:63`），业务不会被锁死，但时间管控与结束页文案失效、管理端设置页报错（`_ensure_setting` 会重建未发布占位行，`:131-141`），生产不建议回滚。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/016_activity_settings.sql`，共 **1 个提交**。

### 2026-10-13（`ce14a95`，10:54）
- 需求：V2.0 需求一——活动时间控制（发布/起止时间/结束后可查看）。
- 修改内容（涉本文件）：新建本文件；建 `activity_settings` 单行配置表、种入默认配置与 `activity` 菜单。
- 关联文件：`backend/app/models/models.py`（`ActivitySetting`）、`backend/app/services/activity_service.py`、`backend/app/api/routes/admin.py`、`backend/app/api/deps.py`（活动守卫）、管理端活动设置页、小程序状态展示。
- 测试结果：见 `docs/迭代记录.md` 的 `ce14a95` 条目。
