# 004_nickname_change.sql

## 1. 文件路径

`docker/init/004_nickname_change.sql`（12 行）

## 2. 文件职责

为「昵称仅可修改一次」功能给 `users` 表增加两列：`original_nickname`（登录时的微信昵称/曾用名）与 `nickname_changed_at`（改名时间，非空即已消耗唯一一次改名机会），并把存量用户的当前昵称回填为曾用名。

## 3. 业务需求

`f820e0e`（2026-10-01）「微信名称直登与昵称仅可修改一次，排名洞察展示改名记录（三端）」交付（`docs/迭代记录.md` 的 `f820e0e` 条目）。业务规则登记于 `.qoder/PROJECT.md` §6「核心业务规则（摘要）」第 7 条：昵称仅可修改一次；首次引导设置昵称（`PUT /auth/nickname/initial`）不消耗该机会（`frontend/AGENTS.md` §4 不变量 7）。文件内注释 `:3-4` 明确两列语义。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:12`）。

### 4.1 加列（`:5-6`）

裸 `ALTER TABLE users ADD COLUMN`（**不带** `IF NOT EXISTS`，即 `SQL_CONSTRAINTS.md` §1.1 方式 B）：
- `original_nickname VARCHAR(64)`——可空、无 DEFAULT，与 `nickname` 同长度；
- `nickname_changed_at TIMESTAMP`——可空，NULL = 未改过名。

### 4.2 存量回填（`:9-10`）

`UPDATE users SET original_nickname = nickname WHERE original_nickname IS NULL OR original_nickname = ''`——带 WHERE 过滤、可重复执行（收敛，符合 §2.4）。注意本库 Oracle 兼容模式下 `''` 落库即 NULL（`005_upgrade.sql:5-6` 注释），`OR = ''` 分支实际等价于 IS NULL，属防御性写法。

## 5. 输入与输出

- **输入（前置条件）**：001 已建 `users` 表；改名逻辑由后端 `PUT /auth/nickname` 链路消费（本文件只管结构）。
- **输出**：`users` 新增 2 列；存量行 `original_nickname` = 当时昵称。
- **失败模式**：**非幂等**——列已存在时重跑 `ADD COLUMN` 报 duplicate column，事务回滚、`ON_ERROR_STOP=1` 中断批次（正常路径由 `schema_migrations` 防重跑，`docker/init/init-db.sh:32-36`）。

## 6. 依赖关系

- 依赖：`001_schema.sql`（`users`）。
- 被依赖：ORM `backend/app/models/models.py:195-196`（`original_nickname`/`nickname_changed_at`，均可空，与 DDL 一致）；管理端「排名洞察」改名记录展示（`f820e0e` 三端改动）；小程序 org-select 页 `<input type="nickname">` 首次采集链路。

## 7. 业务规则

1. **改名机会判定**：`nickname_changed_at IS NOT NULL` ⇔ 已用过唯一一次改名；`original_nickname` 永远保留首次登录昵称，供管理端对照（`models.py:182-183` docstring）。
2. 回填只对存量用户执行一次语义：此后新用户的 `original_nickname` 由登录链路写入，不再依赖本迁移。
3. 两列均可空：Oracle 兼容模式下字符串空值按 NULL 处理，代码层把 None 视为空串（`005_upgrade.sql:5-6` 同款约定）。

## 8. 修改约束

1. **禁止修改本文件**（已在生产执行，`SQL_CONSTRAINTS.md` §3.1）。
2. 不得给两列加 NOT NULL/DEFAULT——ORM 按可空声明，且「NULL=未改名」是业务语义。
3. 手工补跑后必须回填 `schema_migrations`（`SQL_CONSTRAINTS.md` §6），否则下次 `database-init` 重复执行必然报错（本文件非幂等）。

## 9. 当前实现状态

- **已实现**：生效中，ORM/DDL 一致，无已知问题。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` §1）**：§1.1 合规（用方式 B 裸 ADD，未用被禁的 `IF NOT EXISTS`；方式 B 的代价是非幂等，见下）；§1.4 不涉及；§2.1 事务合规（`:1`/`:12`）；**§2.2 幂等违规**：`:5-6` 裸加列重跑即失败，未用 DO 块 + information_schema 判定（方式 A）；§4 部分合规：有目的注释（`:3-4`、`:8`）但缺「影响面/回滚」三段式。
- **回滚方式**：文件内无回滚语句。手工回滚 = `ALTER TABLE users DROP COLUMN original_nickname, DROP COLUMN nickname_changed_at;`——**会丢失全部改名记录**（管理端排名洞察的曾用名展示随之失效），生产不应回滚。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/004_nickname_change.sql`，共 **1 个提交**。

### 2026-10-01（`f820e0e`，15:54）
- 需求：微信名称直登与昵称仅可修改一次，排名洞察展示改名记录（三端）。
- 修改内容（涉本文件）：创建本文件，`users` 加 `original_nickname`/`nickname_changed_at` 并回填存量曾用名。
- 关联文件：`backend/app/models/models.py`、后端 auth 路由/服务、`admin` 排名洞察页、小程序 org-select/login。
- 测试结果：见 `docs/迭代记录.md` 的 `f820e0e` 条目。
