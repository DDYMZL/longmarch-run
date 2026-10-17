# 011_import_previews.sql

## 1. 文件路径

`docker/init/011_import_previews.sql`（20 行）

## 2. 文件职责

为 Excel 批量导入的「预览→确认」两阶段机制建暂存表 `import_previews`（`:7-16`）：上传解析后的整批数据（有效行 + 错误行）以 JSON 存入 `payload`，管理员确认后由后端在同一事务写入正式表并把 `status` 置 `confirmed`（`:4` 头注释）。配套组合索引 `idx_import_previews_biz (biz_type, status)`（`:18`）。

## 3. 业务需求

V1.1 题库/寄语/人员批量导入（`:3` 注释）。`54ea125`（2026-10-10）「题库支持 Excel 模板下载与批量导入（预览校验+事务写入+防重复提交），题库列表改服务端分页」交付（`docs/迭代记录.md` 的 `54ea125` 条目）。核心诉求：任一行校验出错则整批阻断、token 一次性使用 + 30 分钟过期防重复提交（`:5` 注释）。导入链路总览见 `.qoder/ARCHITECTURE.md` §8.2 与 `.qoder/backend/app/services/import_service.py.md`。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:20`），注释在事务内（`:3-5`），与 `SQL_CONSTRAINTS.md` §4 模板顺序一致（但缺「回滚」段）。

### 4.1 建表 `import_previews`（`:7-16`）

| 列 | 类型/约束 | 业务含义 |
|---|---|---|
| `token` | `VARCHAR(36)` PRIMARY KEY | 一次性确认令牌，自然主键无序列；后端实际写入 `uuid4().hex`（32 位十六进制，`backend/app/services/import_service.py:126`），36 宽度留余量 |
| `biz_type` | `VARCHAR(20)` NOT NULL | 导入业务类型；注释与 ORM docstring 声称 question/quote/staff（`models.py:524`），**当前实现只用 question、quote**（`import_service.py:298`、`:410`），staff 未见实现（见 §9） |
| `payload` | `JSON` NOT NULL | `{"rows": [...], "errors": [...]}` 整批解析结果（`import_service.py:131`）；不落任何明文敏感凭证（`:5` 注释） |
| `status` | `VARCHAR(10)` NOT NULL DEFAULT `'pending'` | pending 待确认 / confirmed 已核销 |
| `created_by` | `VARCHAR(64)` 可空 | 操作人标识（非 FK） |
| `created_at` | `TIMESTAMP` NOT NULL DEFAULT CURRENT_TIMESTAMP | 暂存时间（DB 侧默认值） |
| `expires_at` | `TIMESTAMP` NOT NULL 无默认 | 过期时间 = 暂存 + 30 分钟（`PREVIEW_TTL_MINUTES = 30`，`import_service.py:27`、`:133`），**必须由应用写入** |
| `confirmed_at` | `TIMESTAMP` 可空 | 核销时间，条件 UPDATE 时写入（`import_service.py:165`） |

无任何 FK/REFERENCES；`token` 为唯一约束承载体。

### 4.2 索引（`:18`）

`CREATE INDEX IF NOT EXISTS idx_import_previews_biz ON import_previews (biz_type, status);`——服务管理端按业务类型 + 状态检索暂存批次。**命名前缀 `idx_` 与全库其余索引的 `ix_`/`uq_` 惯例不一致**，且 ORM 未声明该索引（见 §9）。

## 5. 输入与输出

- **输入（前置条件）**：无——不依赖任何先序迁移的表（独立新表）。
- **输出**：1 张表 + 1 个索引；不种任何数据、不改既有数据。
- **失败模式**：`CREATE TABLE IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS` 重跑均 no-op，整体幂等；唯一风险是 §1.2 的 `CREATE INDEX IF NOT EXISTS` 在生产 openGauss 按「不支持」处理时报语法错（见 §9）。

## 6. 依赖关系

- 依赖：无先序迁移依赖；执行顺序上仅要求排在 `init-db.sh` 字典序中 011 位。
- 被依赖（读写方）：
  - ORM `backend/app/models/models.py:519-536`（`ImportPreview`，字段与 DDL 逐列一致）。
  - `backend/app/services/import_service.py`：写入 `_save_preview`（`:124-137`）；核销 `_confirm`（`:140-175`），其中 `:162-168` 用**条件 UPDATE**（`WHERE token=? AND status='pending'` → `confirmed`）原子消费令牌，并发重复提交只有一个成功——这是 openGauss 不支持 `ON CONFLICT`（`SQL_CONSTRAINTS.md` §1.5）下的标准替代手法，DDL 与实现一致。
  - 路由 `backend/app/api/routes/admin.py`：题库 `:430`/`:439`/`:456`（import-template/preview/confirm），寄语 `:583`/`:592`/`:609`，均 `require_menu` 保护。

## 7. 业务规则

1. **整批阻断**：`payload.errors` 非空时确认阶段直接拒绝（`import_service.py:156-158`），任一行出错则整批不导入。
2. **令牌一次性**：`pending → confirmed` 条件 UPDATE 核销（`:162-168`）；核销后写入失败会 `db.rollback()`（`:172-174`），令牌恢复 pending 可重试。
3. **TTL 30 分钟**：`expires_at < utcnow()` 即拒绝（`:154-155`）。过期行**不自动清理**，表只增不减（清理策略待确认）。
4. `status` 仅 pending/confirmed 两态，无 CHECK 约束，靠应用层常量（`.qoder/ARCHITECTURE.md` §13.2「无任何 CHECK 约束」）。

## 8. 修改约束

1. **禁止修改本文件**（编号脚本一经生产执行不得修改，`SQL_CONSTRAINTS.md` §3.1）；变更需新增编号迁移。是否已在生产 `schema_migrations` 登记：待确认（本次建档禁止连库）；按功能上线时间（2026-10-10，早于 2026-10-16 生产迁移缺口事故所涉的 019）推定已执行。
2. `token` 主键宽度 36、`payload` 用 `JSON` 而非 `JSONB`（全库约定，`.qoder/ARCHITECTURE.md` §12.5「其他兼容事实」段）不得改动。
3. 条件 UPDATE 核销依赖 `(token, status)` 语义，若给 `status` 增加新状态须同步改 `import_service._confirm`。

## 9. 当前实现状态

- **已实现**：题库、寄语两类导入的预览/确认链路已上线（`54ea125` 及 `d6acf7e` 批次）。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md`）**：
  - §1.1 不涉及（实测 `ADD COLUMN IF NOT EXISTS` 命中 0 处）；§1.3 合规（`:7`）。
  - §1.2 **谨慎项 1 处**（`:18` `CREATE INDEX IF NOT EXISTS`）：生产版本按「不支持」处理时本行会失败；建议后续新迁移改 DO 块 + `pg_indexes` 判定，本文件已锁定不可改。
  - §1.4 不涉及（无派生表）；§1.5 合规（未用 `ON CONFLICT`，由应用侧条件 UPDATE 替代）。
  - §2.1 事务合规（`:1`/`:20`）；§2.2 幂等合规；§2.3 合规（无删数据）。
  - §4 部分合规：有主题/目的/影响面注释（`:3-5`），缺「回滚」段。
- **与 ORM 的差异**：
  1. 索引 `idx_import_previews_biz` **只存在于 DDL**，`ImportPreview` 无 `__table_args__`（`models.py:527`），ORM 元数据不体现该索引；因禁用 `create_all`，实际库以 DDL 为准，无运行时影响，但索引名 `idx_` 前缀与全库 `ix_` 惯例不一致。
  2. `created_at` 双默认值：DDL 侧 `CURRENT_TIMESTAMP`（`:13`）+ ORM 侧 `default=datetime.utcnow`（`models.py:534`），属全库两套默认值写法并存（`.qoder/ARCHITECTURE.md` §13.2）。
  3. `payload` DDL NOT NULL 无默认，ORM `default=dict`（`models.py:531`）客户端兜底。
- **staff 导入未落地**：`:3` 注释与 `models.py:524` docstring 均提及「人员批量导入（staff）」，但 `import_service.py` 全文无 staff 分支（grep 0 命中）——是预留还是已废弃，待确认（可对照 `.qoder/REQUIREMENTS.md` 相关条目）。
- **回滚方式**：文件内无回滚语句。手工回滚 = `DROP TABLE import_previews;`——仅销毁暂存中的预览批次（进行中的导入需重新上传），不影响正式业务数据，可回滚。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/011_import_previews.sql`，共 **1 个提交**。

### 2026-10-10（`54ea125`，23:31）
- 需求：V1.1 题库 Excel 批量导入（预览校验 + 事务写入 + 防重复提交）。
- 修改内容（涉本文件）：新建本文件，建 `import_previews` 暂存表与 `(biz_type, status)` 索引。
- 关联文件：`backend/app/services/import_service.py`、`backend/app/models/models.py`（`ImportPreview`）、`backend/app/api/routes/admin.py`（题库导入三接口）、管理端导入弹窗组件。
- 测试结果：见 `docs/迭代记录.md` 的 `54ea125` 条目。
