# SQL 迁移约束（生产 openGauss 实测口径）

本文是仓库内**数据库迁移 SQL 的唯一权威约束**，放在仓库根目录以便人与 AI Agent 都能第一眼看到。

适用范围：

- `docker/init/*.sql` 的全部新增与修改；
- 任何要在 openGauss 上执行的临时 SQL（补列、补数据、授权、排查查询）；
- AI Agent 输出的 SQL —— **必须按本文写，不得按 PostgreSQL 通用习惯写**。

`docker/init/SQL_CONSTRAINTS.md` 已改为指向本文的指针，不再单独维护；两处冲突时以本文为准。

---

## 0. 一句话原则

**迁移在生产「跑过了」不等于「生效了」。**

生产执行普遍带 `-v ON_ERROR_STOP=1`，脚本又以 `START TRANSACTION` 开头：任何一条语句报错都会中止整个文件并在会话结束时**整体回滚**，命令行上往往只闪一行错误，极易误判为成功。因此本文把「执行后回查」列为强制步骤（§6 第 4 步），不是可选项。

已因此发生 4 次线上故障，见 §10。

---

## 1. 两端环境事实

| 项 | 生产 | 本地容器 |
| --- | --- | --- |
| 形态 | 裸装 openGauss（**机器上没有 Docker**） | `docker/compose.yml` |
| 镜像/版本 | `.env.prod:7` 注释记 openGauss 6.0.1（Ubuntu）；**未用 `SELECT version();` 实测钉死，属待核实** | `opengauss/opengauss-server:latest`（浮动标签，`:15`、`:41`） |
| 端口 | 5432 | 容器内 5118 |
| 库 / 应用账号 | `longmarch` / `longmarch_app` | `longmarch` / `gaussdb` |
| DDL 执行账号 | `omm`（本地 socket 免密） | 容器内同一账号 |
| gsql 路径 | `/opengauss/inspect-server/bin/gsql` | `/usr/local/opengauss/bin/gsql` |
| 迁移执行入口 | 人工 `gsql -f`（`docker/init` 不入库，靠 `build-sql.bat` 打 `sql.tar.gz` 上传到 `/mnt/data/longmarch-run/sql/init/`） | `docker compose run --rm database-init`（`init-db.sh`，会自动登记 `schema_migrations`） |

**结论（本文存在的根本理由）**：本地用浮动 `latest` 镜像，与生产不是同一版本，且本地由 `init-db.sh` 执行、生产由人工 `gsql -f` 执行，两条路径的失败表现完全不同。**本地跑通不能作为「生产可用」的证据**；唯一证据是 §7 探针脚本在生产上的实测结果，以及 §6 第 4 步的回查。

不要写「因为生产版本较老所以不支持 X」这类推断——按实测结论说话，实测没覆盖的就先用探针跑一次。

---

## 2. 语法约束

分三档：**禁用**（生产实测报错）、**保守**（可能可用但新迁移不依赖）、**实测通过**（可直接用）。每条都标证据，便于日后复核。

### 2.1 禁用：生产实测报错

| 语法 | 生产报错 | 替代写法 |
| --- | --- | --- |
| `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` | `ERROR: syntax error at or near "NOT EXISTS"` | DO 块 + `information_schema.columns` 判定（见下） |
| `ALTER TABLE ... DROP COLUMN IF EXISTS` | 同上（同一语法族） | DO 块 + `information_schema.columns` 判定 |

证据：2026-10-16 生产补跑 `019_sport_backfill_carry.sql` 实测报上述错误；2026-10-18 `025_sync_failures.sql:15` 同因整文件回滚，导致生产缺 `daily_sport.fail_reason`、小程序「同步微信步数」报「请求失败」（该次未留存 gsql 报错原文，属同语法族推断）。

**唯一正确写法**（2026-10-18 生产实测通过）：

```sql
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_sport' AND column_name = 'fail_reason'
    ) THEN
        ALTER TABLE daily_sport ADD COLUMN fail_reason VARCHAR(200);
    END IF;
END $$;
```

不要用「直接 ADD 不加 IF NOT EXISTS，靠 `schema_migrations` 保证不重复」这种写法：生产是人工 `gsql -f`，台账全靠手工登记，重复执行的概率不低，一旦重复就中断整个事务。

### 2.2 保守：可能可用，但新迁移一律不依赖

| 语法 | 现状 | 新迁移怎么做 |
| --- | --- | --- |
| `CREATE [UNIQUE] INDEX IF NOT EXISTS` | 存量 11 个脚本在用（§9），生产库存在对应索引，倾向支持；但未做过受控实测 | 一律改 DO 块 + `pg_indexes` 判定（§2.3 已实测通过，含部分唯一索引） |
| `INSERT ... ON CONFLICT DO UPDATE/NOTHING` | 存量脚本**零实际使用**（只在注释里被明确规避） | 用 `WHERE NOT EXISTS` 或「先 UPDATE 再 INSERT」（`023`/`024` 的做法） |
| JSON/JSONB 操作符 `@>`、`?`、`?&` | 未实测 | 用 SQL 显式判断，别依赖 JSON 路径操作 |
| `ALTER COLUMN ... TYPE ... USING ...` | 未实测 | 拆成「加新列 → UPDATE 迁移 → 删旧列 → 重命名」四步 |
| `CREATE OR REPLACE TRIGGER` | 未实测 | 先 `DROP TRIGGER IF EXISTS` 再 `CREATE TRIGGER` |

索引的实测通过写法（2026-10-18 生产建 `uq_user_event_first_login` 部分唯一索引时验证）：

```sql
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'user_event' AND indexname = 'uq_user_event_first_login'
    ) THEN
        CREATE UNIQUE INDEX uq_user_event_first_login
            ON user_event (user_id) WHERE event_type = 'FIRST_LOGIN';
    END IF;
END $$;
```

### 2.3 生产实测通过（2026-10-18，可直接使用）

- `DO $$ ... END $$;` 匿名块（plpgsql `IF NOT EXISTS` 判定）
- `information_schema.columns` / `information_schema.tables` 查询
- `pg_indexes` 查询
- `CREATE TABLE IF NOT EXISTS`（`023_chapters.sql` 建表成功）
- 部分唯一索引：`CREATE UNIQUE INDEX ... ON t (col) WHERE <条件>`
- `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL`
- `INSERT INTO ... SELECT ... WHERE NOT EXISTS (...)`（回填 5 行成功）
- `UPDATE e SET ... FROM u WHERE ... AND e.x IS DISTINCT FROM u.x`
- `DELETE ... WHERE id NOT IN (SELECT MIN(id) ... GROUP BY ...)`
- `START TRANSACTION; ... COMMIT;` 显式事务
- `has_table_privilege('longmarch_app','chapters','SELECT')`
- `pg_class c JOIN pg_namespace n ... WHERE c.relkind = 'S'` 查序列名

### 2.4 生产不存在的系统视图/列（查了直接报错）

| 对象 | 说明 | 替代 |
| --- | --- | --- |
| `pg_sequences` | PostgreSQL 10+ 才有，openGauss 无 | `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'S' AND n.nspname = 'public'` |
| `pg_stat_activity.wait_event_type` | 无此列 | 只用 `pid, state, query` |

给用户的排查脚本里，**不要把这类对象放在必要检查之前**——2026-10-17 就因 `pg_sequences` 中断，导致后面的授权校验整段没跑到。

### 2.5 派生表必须显式起别名

```sql
-- 报错：ERROR: subquery in FROM must have an alias
SELECT COUNT(*) FROM (SELECT id FROM questions WHERE active);
-- 正确
SELECT COUNT(*) FROM (SELECT id FROM questions WHERE active) AS t;
```

**ORM 侧的连带坑**：SQLAlchemy 旧式 `db.query(X).count()` 会生成带别名列的派生表（`questions_active`），openGauss 报的是迷惑性极强的 `UndefinedTable: invalid reference to FROM-clause entry for table "questions"`，看起来像方言问题，**实际是缺列**。遇到这条报错先去核对表结构，不要改 ORM 代码（`f413ac6` 就是这么误诊的，后被 `51239b5` 回退）。

---

## 3. 幂等、事务与数据安全

1. **必须包事务**：首尾 `START TRANSACTION; ... COMMIT;`，中途失败整体回滚，不留半迁移状态。
2. **必须幂等**：所有 DDL 用 DO 块判定；数据回填用 `WHERE NOT EXISTS` / 差异过滤（`WHERE p.delta <> c.delta`）。手工重跑不得破坏数据。
3. **不删数据**：迁移只做「加列 / 加索引 / 重算派生字段」。禁止 `DROP TABLE`、`TRUNCATE`、无 `WHERE` 的 `DELETE`。确需清理走单独运维流程。
4. **重算类 UPDATE 必须收敛**：涉及积分、步数台账时 `WHERE` 必须限定 `biz_key`、`delta <> new_delta` 等条件，避免全表覆写管理员事后手工调整过的数据。
5. **禁止修改已在生产执行过的编号脚本**：需要变更就新增编号。

---

## 4. 权限：DDL 账号 ≠ 应用账号（生产专属的第二道坎）

生产上 DDL 由 `omm` 执行，应用用 `longmarch_app` 连接；`docker/init/*.sql` **全都不含 GRANT**，本地容器由同一账号建表并连接，所以本地永远复现不出这个坑。

新建表/序列后必须补授权，否则运行期报 `InsufficientPrivilege`：

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON <新表> TO longmarch_app;
GRANT USAGE, SELECT ON SEQUENCE <新表_id_seq> TO longmarch_app;
-- 一次性解决将来的迁移：
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO longmarch_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO longmarch_app;
```

**序列最容易漏**：表权限给了、`SELECT` 也正常，直到管理端第一次 `INSERT`（`SERIAL` 取号）才炸。

排查口诀：

- `permission denied for relation X` → 表在，缺授权；
- `relation X does not exist` → 表不在应用账号的 search_path（没建 / 建到别的 schema —— openGauss 建用户会自动创建同名 schema）。

500 的响应体只有 `Internal Server Error`，**这两种情况必须看 `journalctl -u longmarch-backend` 才能分辨**。

---

## 5. 文件规范

1. **文件名**：`NNN_主题.sql`，三位递增编号，与 `schema_migrations.version` 完全一致（= 带 `.sql` 的 basename，见 `init-db.sh:31`）。
2. **顺序**：`init-db.sh` 按字典序执行，编号严格递增；禁止 `010a_xxx.sql` 之类插入编号。
3. **主题**：英文下划线短语（`021_org_tree_cache.sql`），禁止 `fix.sql` / `update.sql`。
4. **顶部注释三段**（中文，必填）：

```sql
START TRANSACTION;

-- ============ 主题（编号）============
-- 变更目的：一句话说清为什么加这个迁移（对应需求/issue 编号更好）。
-- 影响面：涉及哪些表、是否重算历史数据、是否影响已有接口契约。
-- 回滚：出错如何回退（DROP COLUMN / 恢复备份 / 无副作用可忽略）。

-- 幂等：说明用哪种判定式实现可重复执行（information_schema / pg_indexes / NOT EXISTS）。

-- 具体 DDL/DML ...

COMMIT;
```

5. **注释里提到禁用语法时要写清是「禁用」**，避免后人把注释里的示例当可用写法抄走。

---

## 6. 生产执行 runbook（六步，第 4/5/6 步不可省）

**① 上传**：`docker/` 默认不入 git（根 `AGENTS.md` §1.3），服务器 `git pull` 永远拿不到新迁移。用根目录 `build-sql.bat` 打 `sql.tar.gz`，上传解压到 `/mnt/data/longmarch-run/sql/init/`。

**② 进 gsql**（`su - omm -c "..."` 是非交互 shell，不加载库路径，会报 `libssl.so.1.1: cannot open shared object file`；必须进交互 shell 后手工 export）：

```bash
su - omm            # 只粘这一行，等提示符变成 omm@... 再粘下一条
export LD_LIBRARY_PATH=/opengauss/inspect-server/lib:/opengauss/inspect-server/lib/postgresql:$LD_LIBRARY_PATH
```

**③ 执行**：

```bash
/opengauss/inspect-server/bin/gsql -d longmarch -p 5432 -v ON_ERROR_STOP=1 -f /mnt/data/longmarch-run/sql/init/NNN_xxx.sql
```

预期回显：`DO` 或 `ANONYMOUS BLOCK EXECUTE` / `ALTER TABLE` / `CREATE TABLE` / `INSERT 0 n` / `UPDATE n` / `COMMIT`。只看到 `COMMIT` 不代表中间的语句都执行了。

**④ 回查是否真生效**（强制）：

```bash
/opengauss/inspect-server/bin/gsql -d longmarch -p 5432 <<'SQL'
SELECT column_name FROM information_schema.columns
 WHERE table_name = '<表>' ORDER BY ordinal_position;
SELECT indexname FROM pg_indexes WHERE tablename = '<表>';
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' AND table_name = '<新表>';
SQL
```

多行命令**逐条粘贴**：把 `su - omm` 和后续命令一起粘，后一行会被 `su` 吃掉，SQL 直接落到 bash 上报一堆 `SELECT: command not found`（看着像执行了，其实一条没进库）。SQL 较长时先 `cat > /tmp/x.sql <<'EOF'` 落文件再 `-f`（heredoc 定界符要带引号，否则 `$$` 会被 bash 展开）。

**⑤ 登记台账**（`gsql -f` 不会自动登记，只有 `init-db.sh` 会）：

```sql
INSERT INTO schema_migrations (version) VALUES ('NNN_xxx.sql');
```

**⑥ 授权 + 接口冒烟**：按 §4 补 GRANT；冒烟**必须打得到新表/新列的接口**（例如新增 `ai_*` 表后要验管理端知识库列表返回 200）。「路由由 404 变 401」只证明代码到位，证明不了表到位 —— 2026-10-17 的漏检就是这个判据造成的。

DDL 补完**不需要重启后端**（SQLAlchemy 不缓存库结构）；只有改代码或改 `.env.prod` 才 `systemctl restart longmarch-backend`。

---

## 7. 生产语法探针（让本文与生产保持同步的手段）

本文的档位划分基于历史实测，会随生产 openGauss 升级而失效。**换服务器、升级 openGauss、或本文结论与实测冲突时**，跑一次下面的探针，按输出更新 §2 并标注实测日期。

原理：事务内建临时表 `_sql_probe`，每项语法用 `EXECUTE` 动态执行并由 plpgsql 子事务 `EXCEPTION` 捕获，最后 `ROLLBACK`，**对生产数据零残留**；错误都在子事务内被吃掉，所以带 `ON_ERROR_STOP=1` 也不会中断。

```bash
/opengauss/inspect-server/bin/gsql -d longmarch -p 5432 -v ON_ERROR_STOP=1 <<'SQL'
START TRANSACTION;
CREATE TABLE _sql_probe (id INTEGER, c VARCHAR(10));
DO $$
DECLARE
  probes TEXT[] := ARRAY[
    'ADD COLUMN IF NOT EXISTS|ALTER TABLE _sql_probe ADD COLUMN IF NOT EXISTS x1 INTEGER',
    'DROP COLUMN IF EXISTS|ALTER TABLE _sql_probe DROP COLUMN IF EXISTS x9',
    'CREATE INDEX IF NOT EXISTS|CREATE INDEX IF NOT EXISTS ix_sql_probe ON _sql_probe (id)',
    'partial unique index|CREATE UNIQUE INDEX uq_sql_probe ON _sql_probe (id) WHERE c IS NOT NULL',
    'CREATE TABLE IF NOT EXISTS|CREATE TABLE IF NOT EXISTS _sql_probe2 (id INTEGER)',
    'INSERT ON CONFLICT|INSERT INTO _sql_probe (id, c) VALUES (1, ''a'') ON CONFLICT (id) DO NOTHING',
    'ALTER COLUMN DROP NOT NULL|ALTER TABLE _sql_probe ALTER COLUMN c DROP NOT NULL',
    'UPDATE ... FROM|UPDATE _sql_probe p SET c = q.c FROM _sql_probe q WHERE p.id = q.id',
    'IS DISTINCT FROM|SELECT 1 WHERE NULL IS DISTINCT FROM 1',
    'derived table no alias|SELECT COUNT(*) FROM (SELECT id FROM _sql_probe)',
    'to_regclass|SELECT to_regclass(''public._sql_probe'')',
    'pg_sequences view|SELECT COUNT(*) FROM pg_sequences',
    'pg_stat_activity.wait_event_type|SELECT wait_event_type FROM pg_stat_activity LIMIT 1'
  ];
  item TEXT;
  name TEXT;
  stmt TEXT;
BEGIN
  FOREACH item IN ARRAY probes LOOP
    name := split_part(item, '|', 1);
    stmt := split_part(item, '|', 2);
    BEGIN
      EXECUTE stmt;
      RAISE NOTICE '[OK]   %', name;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[FAIL] % -> %', name, SQLERRM;
    END;
  END LOOP;
END $$;
ROLLBACK;
SQL
```

按本文当前口径，预期 `[FAIL]` 的应是：`ADD COLUMN IF NOT EXISTS`、`DROP COLUMN IF NOT EXISTS`、`derived table no alias`、`pg_sequences view`、`pg_stat_activity.wait_event_type`；其余为 `[OK]`。若实测与此不符，**以实测为准并更新 §2**。

想验应用账号的实际权限，把连接账号换成 `longmarch_app` 再跑一遍（`-U longmarch_app`，需密码），或用 `has_table_privilege` / `has_sequence_privilege` 直接查。

---

## 8. 本地验证

- 跑 `docker compose -f docker/compose.yml run --rm database-init`：`init-db.sh` 有 `schema_migrations` 兜底，已登记的整段跳过，安全；连跑两次验幂等。
- **禁止手工 `gsql -f` 全量重跑 `001`–`0NN`**：`005`/`017`/`019` 里的重算 `UPDATE`/`INSERT ... SELECT` 会按当前口径覆盖管理员事后手工调整过的 `points_log`；`002`/`006`/`007`/`013` 的种子 `INSERT` 若无 `ON CONFLICT` 会主键冲突中断、有的会刷掉后台改过的路线/题库/寄语配置；`010`/`015`/`016` 会重置管理员账号、邀请码、活动设置为默认值。
- 本地容器 gsql：全路径 `/usr/local/opengauss/bin/gsql`、`export LD_LIBRARY_PATH=/usr/local/opengauss/lib`、端口 **5118**；Git Bash 下需前缀 `MSYS_NO_PATHCONV=1` 防路径改写。更省事的替代：宿主机 Python + `psycopg2.connect(host='127.0.0.1', port=5118, dbname='longmarch', user='gaussdb', password='LongMarch@123')`。
- DDL 卡死排查：孤儿连接 `idle in transaction` 会持锁卡住 `ALTER TABLE`。`SELECT pid, state, query FROM pg_stat_activity WHERE state LIKE '%idle%'`，必要时 `SELECT pg_terminate_backend(<pid>)`。

---

## 9. 存量脚本违规清单（**禁止原样在生产重跑**）

以下脚本含 §2.1 禁用语法，它们在生产**从未原样跑通过**（例如 `019` 是手工 `ADD COLUMN` 补列 + 手工登记台账），需要重跑时必须先按 §2.1 改写成 DO 块。

| 文件 | `ADD/DROP COLUMN IF NOT EXISTS` | `CREATE [UNIQUE] INDEX IF NOT EXISTS` |
| --- | --- | --- |
| `001_schema.sql` | — | 13 处 |
| `002_route_node_config.sql` | 4 处 | — |
| `005_upgrade.sql` | 18 处 | 2 处 |
| `006_persons.sql` | — | 1 处 |
| `010_admin_identity.sql` | — | 9 处 |
| `011_import_previews.sql` | — | 1 处 |
| `012_perf_indexes.sql` | — | 3 处 |
| `013_daily_quote_cycle.sql` | 3 处 | 1 处 |
| `014_quiz_result_details.sql` | 1 处 | — |
| `015_invite_admission.sql` | 3 处 | 2 处 |
| `017_points_ledger.sql` | 5 处 | 2 处 |
| `018_quiz_answers.sql` | — | 1 处 |
| `019_sport_backfill_carry.sql` | 3 处 | — |
| `020_question_rotation.sql` | 1 处 | 1 处 |

统计口径：排除 `--` 注释行后的实际语句数（2026-10-18 `grep` 复核）。`ON CONFLICT` 在存量脚本中零实际使用。`021`–`025` 合规（`025` 于 2026-10-18 改写为 DO 块）。

新迁移**不得**以「存量脚本也这么写」为由使用禁用语法。

---

## 10. 事故记录（勿再犯）

| 日期 | 症状 | 根因 | 修复 |
| --- | --- | --- | --- |
| 2026-10-15/16 | `/api/sport/today` 500 `column daily_sport.source does not exist`；后端启动 seed 崩 `questions.active` 缺列 | 生产缺 `019`/`020`；且 `ADD COLUMN IF NOT EXISTS` 在生产不支持，原样跑 `019` 也失败 | 手工 `ADD COLUMN` 补列 + 登记台账；`f413ac6` 对 ORM 的误诊由 `51239b5` 回退 |
| 2026-10-17 | 体验版 AI 问答「发送失败，点击重试」；`/api/admin/ai/knowledge` 等 500 | `021`/`022` 从未上生产（`docker/` 不入库）；冒烟判据只看「404→401」，证明不了表到位 | 上传补跑 + 登记台账；补冒烟判据「打得到新表」 |
| 2026-10-17 | 补跑后仍 500 `InsufficientPrivilege: permission denied for relation ai_usage_logs` | DDL 由 `omm` 执行、应用连 `longmarch_app`，迁移脚本不含 GRANT；序列权限更易漏 | `omm` 补 GRANT（表 + 序列）+ `ALTER DEFAULT PRIVILEGES` |
| 2026-10-18 | 体验版点「同步微信步数」显示「请求失败 去开启」 | `025_sync_failures.sql:15` 用 `ADD COLUMN IF NOT EXISTS` → 生产语法报错 → `ON_ERROR_STOP` 中止 + `START TRANSACTION` 整体回滚，**025 一条未落**（同批 `023`/`024` 语法合规已成功）；ORM `DailySport` 已有 `fail_reason`，全实体查询必 500 | 改 DO 块 + `information_schema` 判定后补跑；本文 §0/§6 第 4 步即由此新增 |

第 4 次的完整因果链值得单独记：启动自检发现不了（lifespan 只用投影列查询 `DailySport.user_id/.date/.steps`，碰不到缺失列）→ 服务照常起、`/api/activity/status` 200 → 前端 `services/request.js:81` 把 500 的纯文本响应体兜底成「请求失败」→ `pages/home/home.wxml:77-80` 又对任何 `syncError` 无条件渲染「去开启 ›」，把后端故障伪装成微信运动授权问题 → 首页 `/sport/today` 的 500 被 `home.js:325` 的 `.catch(() => {})` 吞掉，只有点同步按钮才暴露。**五层叠加，缺一层都不会排查两小时。**

新增事故请在表末追加一行，写清日期、症状、根因、修复。

---

## 11. 新迁移提交前自检清单

- [ ] 未使用 §2.1 禁用语法；DDL 全部用 DO 块 + `information_schema` / `pg_indexes` 判定。
- [ ] 未依赖 §2.2 的保守语法（`CREATE INDEX IF NOT EXISTS`、`ON CONFLICT`、JSON 操作符等）。
- [ ] 所有派生表带别名（§2.5）；未查询 §2.4 中不存在的系统视图/列。
- [ ] 首尾包 `START TRANSACTION; ... COMMIT;`，重复执行无副作用。
- [ ] 顶部三段中文注释 + 幂等说明齐全（§5）。
- [ ] 编号连续未复用；未修改已在生产执行过的脚本。
- [ ] 本地 `database-init` 跑通，连跑两次幂等。
- [ ] 新建表/序列时，已在脚本外准备好 §4 的 GRANT 语句（含序列）与 `schema_migrations` 登记语句。
- [ ] 重算类 `UPDATE` 的 `WHERE` 有收敛条件（§3 第 4 条）；大表评估过锁范围与时长。
- [ ] 交付说明里写清 §6 六步（尤其第 4 步回查、第 5 步登记、第 6 步「打得到新结构」的冒烟判据），不要把「跑过了」当成「生效了」。
