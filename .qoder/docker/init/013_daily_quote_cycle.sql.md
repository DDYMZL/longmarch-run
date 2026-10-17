# 013_daily_quote_cycle.sql

## 1. 文件路径

`docker/init/013_daily_quote_cycle.sql`（39 行）

## 2. 文件职责

「每日寄语按天循环」（V1.1 功能二）的结构迁移：把 `daily_quotes` 从 007 的「按日期绑定」（`date` 列 UNIQUE，一天一条）改为「排序号 + 启用状态」（`sort_order`/`is_enabled`，`:8-9`），按原日期顺序回填 `sort_order`（`:12-15`）；新建系统键值表 `system_settings`（`:23-27`）并种入循环起始日期 `quote_cycle_start`（`:30-33`）；**DROP 掉原 `date` 列**（`:35`）；建循环查询索引（`:37`）。今日展示索引 = (今天 − 起始日期) % 启用条数，由后端即时计算，无定时任务（`:5` 注释）。

## 3. 业务需求

`d6acf7e`（2026-10-11）「每日寄语改为排序号+启用状态按天循环展示（迁移 013、起始日期可配置），新增 Excel 模板下载与批量导入…」交付（`docs/迭代记录.md` 的 `d6acf7e` 条目）。原 007 模型（`007_daily_quotes.sql`，需求 §16）要求一天一条按日期绑定，内容生产压力大；改为循环展示后少量启用寄语即可无限期轮播，起始日期管理端可改。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:39`）；注释在事务内（`:3-6`、`:11`、`:29`），缺「回滚」段。

### 4.1 加列（`:8-9`）

`ALTER TABLE daily_quotes ADD COLUMN IF NOT EXISTS sort_order INTEGER;` / `... is_enabled BOOLEAN;`——先以可空无默认加入，回填后再收紧（两阶段加列，避免对存量行直接 NOT NULL 失败）。**`ADD COLUMN IF NOT EXISTS` 为 `SQL_CONSTRAINTS.md` §1.1 禁用语法（2 处）**，见 §9。

### 4.2 回填（`:12-16`）

- `:12-15`：`UPDATE daily_quotes q SET sort_order = r.rn FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY date, id) AS rn FROM daily_quotes) r WHERE q.id = r.id AND q.sort_order IS NULL;`——按原展示日期编号，保证迁移后轮播顺序与原日期顺序一致（`:11` 注释）。派生表带别名 `r`（§1.4 合规）；窗口函数 `ROW_NUMBER() OVER` 在 openGauss 可直接执行（`.qoder/ARCHITECTURE.md` §12.5 明确迁移 013 使用窗口函数可用）。`WHERE q.sort_order IS NULL` 使回填收敛（§2.2/§2.4 合规）。
- `:16`：`is_enabled` 存量行统一置 TRUE。

### 4.3 收紧约束（`:18-21`）

`sort_order` SET NOT NULL + DEFAULT 0；`is_enabled` SET NOT NULL + DEFAULT TRUE。`SET NOT NULL`/`SET DEFAULT` 本身可重复执行。

### 4.4 新建 `system_settings`（`:23-27`）

EAV 式系统键值表：`setting_key VARCHAR(64)` PRIMARY KEY、`setting_value VARCHAR(200)` NOT NULL、`updated_at TIMESTAMP` NOT NULL DEFAULT CURRENT_TIMESTAMP。通用配置载体，当前唯一键为 `quote_cycle_start`。

### 4.5 种子 `quote_cycle_start`（`:30-33`）

`INSERT ... SELECT 'quote_cycle_start', COALESCE(MIN(date), to_char(CURRENT_DATE,'YYYY-MM-DD')) FROM daily_quotes WHERE NOT EXISTS (同键已存在)`——起始日期取原最早寄语日期（原第一条即循环首条），空表时取迁移当天（`:29` 注释）。`WHERE NOT EXISTS` 幂等（§1.5 推荐的替代 `ON CONFLICT` 写法）。**必须在 `:35` DROP `date` 之前执行**（读取该列），文件内顺序已保证。

### 4.6 DROP 旧列与建索引（`:35`、`:37`）

- `:35`：`ALTER TABLE daily_quotes DROP COLUMN IF EXISTS date;`——销毁 007 的 `date VARCHAR(10) NOT NULL UNIQUE` 列（含其唯一约束与全部日期数据），详见 §9 的删数据争议。
- `:37`：`CREATE INDEX IF NOT EXISTS ix_daily_quotes_cycle ON daily_quotes (is_enabled, sort_order, id);`——与 ORM `models.py:88` 同名同列。

## 5. 输入与输出

- **输入（前置条件）**：`007_daily_quotes.sql` 已建 `daily_quotes`（含 `date` 列）。
- **输出**：`daily_quotes` 加 2 列、删 1 列（`date` 及其 UNIQUE 约束、数据）；新表 `system_settings`；1 行种子（`quote_cycle_start`）；1 个索引。
- **失败模式**：**手工重跑必然中止**——首跑成功后 `date` 列已不存在，重跑时 `:14` 的 `ORDER BY date` 与 `:31` 的 `MIN(date)` 报 UndefinedColumn，事务整体回滚（不留半迁移状态，但也无法「补跑一半」）。在生产老版本 openGauss 上首跑即会在 `:8` 因禁用语法失败。

## 6. 依赖关系

- 依赖：`007_daily_quotes.sql`（`daily_quotes` 表与 `date` 列）；`system_settings` 为全新表无先序依赖。
- 被依赖：
  - ORM：`DailyQuote`（`models.py:81-95`，**已无 `date` 列**，含 `sort_order`/`is_enabled` 与 `ix_daily_quotes_cycle`，与本迁移后状态一致）；`SystemSetting`（`models.py:98-105`）。
  - 服务：`backend/app/services/quote_service.py`——`CYCLE_START_KEY = "quote_cycle_start"`（`:18`）、`get_cycle_start`/`set_cycle_start`（`:48`/`:52`）、`_pick` 按 `(sort_order, id)` 升序取第 `(today − start) % N` 条（`:59-68`）；`backend/app/services/setting_service.py:10-19`（`system_settings` 通用读写）。
  - 管理端寄语管理页（排序号/启用状态维护，`d6acf7e` 同批）；寄语批量导入复用 011 的 `import_previews`（`import_service.py:358-410`，biz_type=quote）。

## 7. 业务规则

1. **循环规则**：启用寄语按 `(sort_order, id)` 升序排列共 N 条，起始日期对应第 1 条，今日索引 = (今天 − 起始日期) % N（`:4-5` 注释；`quote_service.py:59-68` 实现）。
2. `sort_order` 允许重复（无唯一约束），重复时以 `id` 次序打破平局；新增寄语默认 `sort_order=0`（`:19`）。
3. `is_enabled=FALSE` 的寄语退出循环且管理端列表仍可见（`quote_service.py:136-149` 分页按循环顺序列出全部）。
4. `quote_cycle_start` 修改即时生效（无缓存），格式 `YYYY-MM-DD`（`:31` to_char 与 `quote_service.parse_date`）。
5. **原「一天一条」规则随 `date` 列 UNIQUE 一并废除**——同一天可有多条启用寄语（按循环轮到哪条展示哪条）。

## 8. 修改约束

1. **禁止修改本文件**（`SQL_CONSTRAINTS.md` §3.1）。是否已在生产 `schema_migrations` 登记：待确认（本次建档禁止连库）；按 V1.1 功能上线时间（2026-10-11）推定已执行。
2. **不可重跑**（§5 失败模式）：任何「补跑 013」的运维操作都会因 `date` 列缺失而中止；若生产缺 013，须按缺口流程人工改写为 DO 块版本单独执行并回填 `schema_migrations`（参照 `SQL_CONSTRAINTS.md` §6 与 2026-10-16 事故处置）。
3. `system_settings` 是通用键值表：新增系统配置直接 INSERT 新键，**不要**再建独立单键表；键名约定见 `setting_service.py`。
4. `date` 列已物理删除，任何代码/文档不得再引用 `daily_quotes.date`（后端 grep 0 命中）。

## 9. 当前实现状态

- **已实现**：按天循环展示、起始日期管理端可改、寄语批量导入均已上线（`d6acf7e` 批次）；ORM 与迁移后结构一致。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md`）**：
  - §1.1 **违规 2 处**（`:8`、`:9` `ADD COLUMN IF NOT EXISTS`）：生产老版本不支持该语法（2026-10-16 事故根因），首跑在生产会直接失败。本文件早于约束文档定稿，已列入 `.qoder/ARCHITECTURE.md` §12.4「历史包袱」清单（013=2 处，实测复核一致）。
  - §1.5 **`DROP COLUMN IF EXISTS`（`:35`）**：约束表要求改 DO 块 + information_schema 判定，本行未改写——同属历史包袱（约束文档表格未给 013 记数，因其统计口径只含 ADD COLUMN）。
  - §1.2 谨慎项 1 处（`:37`）；§1.3 合规（`:23`）；§1.4 合规（`:14` 派生表带别名 `r`）；§2.1 事务合规（`:1`/`:39`）。
  - §4 部分合规：有目的/影响面注释，缺「回滚」段——而本迁移恰恰是**最需要回滚说明**的一个（见下）。
- **§2.3「不删除数据」争议（重要）**：`:35` DROP `date` 列**物理销毁**了 007 时代每条寄语的绑定日期与 UNIQUE 约束。§2.3 字面只禁 `DROP TABLE`/`TRUNCATE`/无 WHERE 的 `DELETE`，未列 `DROP COLUMN`，但删列同样不可逆地丢弃列数据，属「删数据」的实质情形。缓释措施：① 删除前 `sort_order` 已按 `date` 顺序回填（`:12-15`），**相对顺序**得以保留；② `MIN(date)` 存入 `quote_cycle_start`（`:30-33`），循环起点得以保留；③ 文件内未见任何 DROP 前备份语句，**每条寄语的原始日期值本身无备份、不可恢复**（当时是否另行导出备份：待确认，本次建档禁止连库/查运维记录）。
- **重跑行为**：见 §5/§8——首跑后重跑必报 UndefinedColumn 并整体回滚，数据无损但迁移无法「再执行」。
- **回滚方式**：文件内无回滚语句，且**实际不可回滚**：恢复 `date` 需要 `ADD COLUMN date VARCHAR(10)` 后逐条重建原日期值，而原值已随 DROP 丢失（仅存 MIN 值与相对顺序），无法还原 UNIQUE 日期绑定。
- **敏感数据**：无种子凭据；`system_settings` 仅 1 行日期配置。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/013_daily_quote_cycle.sql`，共 **1 个提交**。

### 2026-10-11（`d6acf7e`，20:14）
- 需求：V1.1 功能二——每日寄语按天循环展示，起始日期可配置。
- 修改内容（涉本文件）：新建本文件；`daily_quotes` 加 `sort_order`/`is_enabled` 并按原日期回填、删 `date` 列；新建 `system_settings` 并种入 `quote_cycle_start`；建 `ix_daily_quotes_cycle`。
- 关联文件：`backend/app/models/models.py`（`DailyQuote`/`SystemSetting`）、`backend/app/services/quote_service.py`、`setting_service.py`、管理端寄语页与通用导入弹窗。
- 测试结果：见 `docs/迭代记录.md` 的 `d6acf7e` 条目。
