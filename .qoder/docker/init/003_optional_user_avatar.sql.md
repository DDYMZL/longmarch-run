# 003_optional_user_avatar.sql

## 1. 文件路径

`docker/init/003_optional_user_avatar.sql`（5 行）

## 2. 文件职责

把 `users.avatar` 由 NOT NULL 放宽为可空：用户登录时可以不提供头像。

## 3. 业务需求

`bceeb26`（2026-10-01）openGauss 切换批次交付（`docs/迭代记录.md` 的 `bceeb26` 条目）。小程序微信授权登录中头像选择是可跳过的（`frontend/AGENTS.md` §4 不变量 7：login 页按钮即 `chooseAvatar`，未选头像的用户仍需能完成登录），故头像列不能强制非空。

## 4. 核心功能

### 4.1 放宽可空性（`:3`）

`ALTER TABLE users ALTER COLUMN avatar DROP NOT NULL;`——单语句，事务包裹（`:1`/`:5`）。放宽后 `001_schema.sql:48` 的 `avatar VARCHAR(500) NOT NULL` 对存量库失效，类型与长度不变。

## 5. 输入与输出

- **输入（前置条件）**：001 已建 `users` 表（含 NOT NULL 的 `avatar` 列）。
- **输出**：`users.avatar` 变为可空列；无数据变更。
- **失败模式**：`users` 表不存在时 `ON_ERROR_STOP=1` 中断整个迁移批次。

## 6. 依赖关系

- 依赖：`001_schema.sql`（`users` 表）。
- 被依赖：ORM `backend/app/models/models.py:193`（`avatar: Mapped[Optional[str]] ... nullable=True`，与本迁移后的 DDL 一致）；后端登录/头像持久化链路（`frontend/services/auth.js` 的头像可为空场景）。

## 7. 业务规则

1. **幂等**：`DROP NOT NULL` 对已可空的列是无副作用的 no-op（PostgreSQL 语义，openGauss 同源），手工重跑安全。
2. 放宽后未选头像的用户也能完成登录建档（本迁移目的，见 §3）；`users.nickname` 不受影响，仍 NOT NULL（缺省昵称「长征小战士」由 ORM 客户端默认补值，`models.py:192`）。

## 8. 修改约束

1. **禁止修改本文件**（已在生产执行，`docker/init/SQL_CONSTRAINTS.md` §3.1）。
2. 不得把 `avatar` 改回 NOT NULL——ORM 与登录链路均按可空契约实现。

## 9. 当前实现状态

- **已实现**：生效中，ORM/DDL 一致。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md`）**：§1 各项不涉及（无 ADD COLUMN IF NOT EXISTS、无索引、无派生表）；§2.1 事务合规（`:1`/`:5`）；§2.2 幂等合规；**§4 违规：无三段式头注释**（早于约束文档的历史包袱）。
- **回滚方式**：文件内无回滚语句。手工回滚 = `ALTER TABLE users ALTER COLUMN avatar SET NOT NULL;`——仅当库中无 `avatar IS NULL` 行时可执行，否则报错；需先把空头像行回填占位值，属数据修复流程，生产慎用。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/003_optional_user_avatar.sql`，共 **1 个提交**。

### 2026-10-01（`bceeb26`，10:26）
- 需求：数据库由 SQLite 切换为 Docker 承载的 openGauss（头像改为选填）。
- 修改内容（涉本文件）：创建本文件，`users.avatar` DROP NOT NULL。
- 关联文件：`docker/init/001_schema.sql`、`backend/app/models/models.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `bceeb26` 条目。
