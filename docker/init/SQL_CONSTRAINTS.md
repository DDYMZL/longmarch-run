# SQL 迁移编写约束（docker/init/*.sql）

本文件规定 `docker/init/` 下所有 `.sql` 迁移脚本的编写约束，**新增/修改迁移前必读**。目的：确保脚本在生产 openGauss 与本地 openGauss（`docker/compose.yml`）上都能一次性执行成功，不再出现"本地过、生产炸"的语法/行为差异。

## 1. 语法兼容性（硬约束）

生产 openGauss 版本较老，部分 PostgreSQL 常见语法**不支持**。写迁移时必须避开以下语法，改用等价兼容写法。

### 1.1 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` —— 禁用

**症状**：
```
ERROR: syntax error at or near "NOT EXISTS"
LINE 1: ALTER TABLE daily_sport ADD COLUMN IF NOT EXISTS source VARC...
```

**禁用写法**：
```sql
ALTER TABLE t ADD COLUMN IF NOT EXISTS c VARCHAR(16) NOT NULL DEFAULT 'x';
```

**兼容写法**（择一）：

- **方式 A：DO 匿名块 + information_schema 判定**（推荐，幂等）
  ```sql
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'daily_sport' AND column_name = 'source'
    ) THEN
      ALTER TABLE daily_sport ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'werun';
    END IF;
  END $$;
  ```

- **方式 B：直接 ADD，不加 IF NOT EXISTS**（仅当迁移编号唯一、确认从未跑过时可用）
  ```sql
  ALTER TABLE daily_sport ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'werun';
  ```
  由 `schema_migrations` 表保证不会重复执行；风险是若有人手工补过列，脚本会中断。

### 1.2 `CREATE INDEX IF NOT EXISTS` —— 谨慎使用

生产 openGauss 部分版本支持、部分不支持。**默认按不支持处理**，改用 DO 块 + `pg_indexes` 判定：

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename = 'questions' AND indexname = 'ix_questions_active'
  ) THEN
    CREATE INDEX ix_questions_active ON questions (active);
  END IF;
END $$;
```

### 1.3 `CREATE TABLE IF NOT EXISTS` —— 允许

生产 openGauss 支持该语法，可继续使用。

### 1.4 派生表（子查询）必须显式起别名

openGauss 要求 FROM 子句里的每个子查询都有别名，否则报：
```
ERROR: subquery in FROM must have an alias
```

**禁用**：
```sql
SELECT COUNT(*) FROM (SELECT id FROM questions WHERE active);
```

**必用**：
```sql
SELECT COUNT(*) FROM (SELECT id FROM questions WHERE active) AS t;
```

聚合函数遇到派生表列名歧义时，优先改写为 `func.count()` 直查（历史上 `f413ac6` 已因该问题修过一次）。

### 1.5 其它已知不支持/易踩的语法

| 语法 | 处理 |
| --- | --- |
| `ALTER TABLE ... DROP COLUMN IF EXISTS` | 用 DO 块 + information_schema 判定 |
| `ALTER TABLE ... ALTER COLUMN ... TYPE ... USING ...` | openGauss 支持有限，改成"加新列 → UPDATE 迁移 → 删旧列 → 重命名"四步 |
| `INSERT ... ON CONFLICT DO UPDATE` | 生产版本可能不支持，改用 `WHERE NOT EXISTS` 或先 UPDATE 再 INSERT |
| `RETURNING *` | openGauss 支持，但避免依赖 RETURNING 的复合结构（如 `RETURNING (col).*`） |
| 触发器 `CREATE OR REPLACE TRIGGER` | 老版本不支持，先 `DROP TRIGGER IF EXISTS` 再 `CREATE TRIGGER` |
| JSON 路径操作符 `@>`、`?`、`?&` | 生产库尽量不用 JSONB 索引操作；用 SQL 显式判断 |

新增迁移若使用未在上表出现的语法，**先在本地 openGauss（`docker/compose.yml`）跑通、再在生产库上手工 dry-run（`START TRANSACTION; ... ROLLBACK;`）验证一次**，然后才能提交。

## 2. 事务与幂等

1. **必须包事务**：脚本首尾 `START TRANSACTION; ... COMMIT;`，中途失败可回滚，不留半迁移状态。
2. **幂等**：即便被 `database-init` 跳过（`schema_migrations` 已记录），若有人手工重跑，也不应破坏数据。DDL 用 DO 块判定；数据回填用 `WHERE NOT EXISTS` 或 `WHERE p.delta <> c.delta` 之类的差异过滤。
3. **不删除数据**：迁移只做"加列 / 加索引 / 重算派生字段"，禁止 `DROP TABLE` / `TRUNCATE` / `DELETE FROM` 无 WHERE 的语句。确需清理，单独走运维流程。
4. **重算类 UPDATE 必须收敛**：涉及积分、步数台账等历史数据重算时，WHERE 必须限定 `biz_key`、`delta <> new_delta` 等收敛条件，避免全表覆写。

## 3. 命名与顺序

1. **文件名**：`NNN_主题.sql`（`NNN` 三位递增，与 `schema_migrations.version` 完全一致）。**禁止修改已在生产执行过的编号脚本**——需要变更就新增编号。
2. **顺序**：`init-db.sh` 按文件名字典序执行，编号必须严格递增，禁止 `010a_xxx.sql` 之类的插入编号（补编号请用下一个可用值）。
3. **主题**：用英文下划线短语描述本次变更（例：`021_org_tree_cache.sql`），不要写 `fix.sql` / `update.sql` 这种无信息名。

## 4. 注释规范

每份 SQL 顶部必须包含以下三段中文注释，方便运维和后续 Agent 快速判断风险：

```sql
START TRANSACTION;

-- ============ 主题（编号）============
-- 变更目的：一句话说清为什么加这个迁移（对应 issue/需求编号更好）。
-- 影响面：涉及的表、是否重算历史数据、是否影响已有接口契约。
-- 回滚：出错时如何回退（DROP COLUMN / 恢复备份 / 无副作用可直接忽略）。

-- 具体 DDL/DML ...

COMMIT;
```

## 5. 生产执行前的自检清单

新增迁移合并前，作者与 Reviewer 必须逐项确认：

- [ ] 未使用 §1.1、§1.2、§1.5 表格中列出的禁用语法；使用了兼容替代写法（DO 块 / information_schema）。
- [ ] 所有派生表都带别名（§1.4）。
- [ ] 首尾包了 `START TRANSACTION; ... COMMIT;`。
- [ ] 在本地 `docker compose -f docker/compose.yml run --rm database-init` 跑通，且重复跑一次无副作用（幂等）。
- [ ] 文件顶部三段中文注释齐全。
- [ ] 编号连续、未复用旧编号；`schema_migrations` 会正确记录文件名。
- [ ] 生产库上手工 `START TRANSACTION; <脚本主体> ROLLBACK;` dry-run 无报错（有条件时执行）。
- [ ] 若涉及大表 UPDATE，评估过锁范围与执行时长，必要时拆分批次。

## 6. 部署运维要点

- **不要绕过 `schema_migrations` 手工 `gsql -f` 全量重跑**：`017_points_ledger.sql`、`019_sport_backfill_carry.sql` 等含重算 UPDATE，重复执行会覆盖管理员事后手工调整过的数据。
- **只跑缺失编号**：`docker compose run --rm database-init` 自动跳过 `schema_migrations` 已记录的版本；如需手工补，先 `SELECT version FROM schema_migrations ORDER BY version` 对齐差异。
- **补跑完必须回填 `schema_migrations`**：手工 `gsql -f` 执行了某编号后，务必 `INSERT INTO schema_migrations (version) VALUES ('NNN_xxx.sql');`，否则下次 `database-init` 会重复执行。
- **生产报 `UndefinedColumn / UndefinedTable`**：先怀疑迁移缺口（参见项目记忆 `opengauss-migration-gap`），核对 `schema_migrations` 与 `docker/init/` 清单差异。

## 7. 历史踩坑记录（勿再犯）

| 提交号 | 症状 | 根因 | 修复 |
| --- | --- | --- | --- |
| `f413ac6` | 后端启动 seed 阶段报 openGauss 派生表列名歧义 | 题库 count 用了派生表且未起别名 | 改用 `func.count()` 直查（后被 `51239b5` 回退，真正根因是 020 迁移未跑） |
| 2026-10-16 生产 | `/api/sport/today` 500 `column daily_sport.source does not exist` | 服务器 openGauss 缺 019 迁移；且 `ADD COLUMN IF NOT EXISTS` 语法在生产版本不支持，直接跑 019 也失败 | 手工 ADD COLUMN 补列 + 回填 `schema_migrations`；后续所有 ADD COLUMN 迁移改用 §1.1 方式 A |

—— 新增踩坑请在上表追加一行，写清提交号/日期、症状、根因、修复方式。
