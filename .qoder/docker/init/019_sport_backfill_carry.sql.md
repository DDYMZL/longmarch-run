# 019_sport_backfill_carry.sql

## 1. 文件路径

`docker/init/019_sport_backfill_carry.sql`（49 行）

## 2. 文件职责

「微信运动近 7 日补录 + 步行积分结余口径」迁移，两件事：① 给 `daily_sport` 加数据来源三列 `source` / `synced_at` / `sync_status`（`:8-10`）；② 把步行积分从「每日各自取整」改为**累计结余口径**（不足 1000 步的零头结转到下一条记录），并用窗口函数按新口径**重算 + 补建** `points_log` 的 walk 台账行（`:15-47`）。

## 3. 业务需求

`6f2cfc3`（2026-10-15）「全端: 支持近7日步数补录结余积分与用户独立题目轮换」交付（`docs/迭代记录.md` 的 `6f2cfc3` 条目）。业务场景两个：

1. **近 7 日补录**：微信运动接口一次返回最近若干天数据，同步时须逐日覆盖落库（不只当天），并记录每天数据来自哪个渠道、何时写入，以便排查「步数不是我的」类问题；微信未返回的日期**不落库、不写 0**，由同步接口返回失败日期、下次自动重试（`:7` 头注释，实现见 `backend/app/services/sport_service.py:143-161`）。
2. **零头结转（`walkCarry`）**：旧口径每日独立 `floor(steps/1000)`，用户每天走 1900 步则永远得 1 分、900 步零头天天丢弃；新口径按日期顺序累计，跨日零头可攒够 1000 步再计分，累计步行积分恒等于「累计计分步数 // 1000」（`:12-13` 头注释，ORM 侧 `points_service.py:4-6`）。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:49`）。

### 4.1 `daily_sport` 来源三列（`:8-10`）

| 列 | DDL | 业务含义 |
|---|---|---|
| `source` | `VARCHAR(16) NOT NULL DEFAULT 'werun'`（`:8`） | 数据来源：`werun` 微信运动解密 / `mock` 开发模式模拟 / `manual` 手动补步（演示）（`:5`）。默认值 `werun` 使**存量行自动按 werun 回填**，无需额外 UPDATE（`:5`） |
| `synced_at` | `TIMESTAMP`（`:9`，可空、无默认） | 最近一次写入该日步数的时间（UTC）；**存量行保持 NULL**（`:6`），故 NULL 语义即「019 之前落库的历史行」 |
| `sync_status` | `VARCHAR(16) NOT NULL DEFAULT 'processed'`（`:10`） | 处理状态；默认 `processed`。设计口径是「**行存在即已成功处理**」（`:7`），失败日期根本不落库 |

三列全部使用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（§9 记为兼容性违规）。

### 4.2 walk 台账重算 UPDATE（`:15-28`）

三层嵌套，最内层（`:21-25`）用窗口函数按用户分区、按日期升序做**累计求和**：

- `capped = LEAST(GREATEST(steps, 0), 20000)`——单日计分步数，下限 0、上限 20000（`:21`）；
- `cum = SUM(capped) OVER (PARTITION BY user_id ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`——截至当日的累计计分步数（`:22-24`）；
- 中层（`:19`）算当日增量 `delta = CAST(FLOOR(cum/1000) - FLOOR((cum - capped)/1000) AS INTEGER)`，即「当日结束时的整千数 − 前一日结束时的整千数」，正是结余口径；
- 外层 `UPDATE points_log p SET delta = c.delta, ref_id = c.id, updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`（`:16`），条件 `WHERE p.user_id = c.user_id AND p.biz_key = 'walk:' || c.date AND p.delta <> c.delta`（`:28`）。

`:28` 的 **`p.delta <> c.delta` 是收敛过滤**——只改口径不一致的行，已正确的行不触碰，符合 `SQL_CONSTRAINTS.md` §2.4。两层派生表都显式起了别名（`:26` 的 `) t`、`:27` 的 `) c`），符合 §1.4。

### 4.3 walk 台账补建 INSERT（`:30-47`）

同样的三层窗口计算（`:33-43`，与 §4.2 完全重复的一段 SQL），`INSERT` 缺失的 walk 行：`reason='步行积分'`、`source_type='walk'`、`ref_id=c.id`、`biz_key='walk:' || c.date`。过滤 `c.delta > 0`（`:44`）+ `NOT EXISTS`（`:45-47`）——**幂等手法是 `WHERE NOT EXISTS`，不是 `ON CONFLICT`**。

`:44` 的 `delta > 0` 补上了 `017_points_ledger.sql:25` 的口径缺口：017 用 `s.steps >= 1000` 过滤，会漏掉「当日不足 1000 步但靠结转攒够 1000」的日期；本文件按 `delta > 0` 判定，这类日期能正确建行。

## 5. 输入与输出

- **输入（前置条件）**：`daily_sport` 已存在；**`points_log` 的 `biz_key` / `delta` / `ref_id` / `updated_at` / `source_type` 五列必须已由 `017` 建好**——本文件 `:16`、`:28`、`:31` 直接引用它们，若在 017 之前执行会报 `UndefinedColumn`。
- **输出**：`daily_sport` 新增 3 列（存量行 `source='werun'`、`sync_status='processed'`、`synced_at=NULL`）；`points_log` 中 walk 行的 `delta` / `ref_id` / `updated_at` 被改写为结余口径值（仅 `delta` 有差异的行）；缺失的 walk 行被补建（行数取决于存量数据，**本次建档禁止连库，实际影响行数待确认**）。
- **对既有数据的影响**：① 不删除任何数据（`:14` 头注释明写「只改 walk 行，不删除任何数据」）；② **quiz 行与 legacy 行完全不受影响**（`:28`、`:46` 的 WHERE 都限定 `biz_key = 'walk:' || …`）；③ 用户总积分会变化——结转口径通常使累计步行积分**增加**（旧口径丢弃的零头被找回）。
- **失败模式**：`ADD COLUMN IF NOT EXISTS`（`:8-10`）在不支持该语法的生产 openGauss 版本上直接语法报错。**这已实际发生过**：`SQL_CONSTRAINTS.md` §7 表格记录 2026-10-16 生产 `/api/sport/today` 500 `column daily_sport.source does not exist`，根因即「服务器 openGauss 缺 019 迁移；且 `ADD COLUMN IF NOT EXISTS` 语法在生产版本不支持，直接跑 019 也失败」，修复方式是手工 `ADD COLUMN` 补列 + 回填 `schema_migrations`。

## 6. 依赖关系

- **依赖先序迁移**：建 `daily_sport` 的迁移；**`017_points_ledger.sql`（强依赖，见 §5）**。
- **对应 ORM**：`backend/app/models/models.py:231-252`（`DailySport`）——`source`（`:250`，`String(16) default="werun"`）、`synced_at`（`:251`，可空）、`sync_status`（`:252`，`String(16) default="processed"`）；docstring `:236` 明写「source 数据来源（werun / mock / manual），synced_at 最近一次写入时间（UTC，019）」。`PointsLog` 见 `models.py:329-350`。
- **读写方**：
  - `backend/app/services/sport_service.py`——三列的唯一写入方：`_upsert_day` 在行锁内 `record.source = source` / `record.synced_at = now_utc()` / `record.sync_status = "processed"`（`:128-130`）；`source` 取值判定在 `:150`（openid 以 `mock_` 开头或未配置微信凭据 → `mock`，否则 `werun`）与 `:338`（`add_steps` 手动补步 → `manual`）；`sync_today`（`:135-180`）同步最近 7 个北京时间自然日（`:143`、`:148`），逐日覆盖后调 `points_service.recompute_walk`（`:180`）。
  - `backend/app/services/points_service.py`——结余口径的运行期实现：`walk_chain`（`:34-41`）、`walk_carry`（`:44-51`，当前结余步数，供小程序 `walkCarry` 展示，出口在 `sport_service.py:206`）、`recompute_walk`（`:100-108`）、`_expected_for`（`:266-289`）。
  - `backend/app/services/admin_service.py:348`、`:537`、`:594`——管理端台账核对与明细。
- **窗口函数依赖**：`:22-24`、`:38-40` 的 `SUM() OVER (...)` 是显式 `.over()` 之外的裸 SQL 窗口函数。`.qoder/ARCHITECTURE.md` §12.5 指出 `core/database.py` 的版本号 monkey-patch 会**关闭 SQLAlchemy 的窗口函数方言适配**，但同节明确「显式 `.over()` 窗口函数仍可用（`rank_service.py:40`、迁移 `013`、`019`）」——本文件即该处所指的 `019`。

## 7. 业务规则

1. **结余口径公式**：当日步行积分 = `floor(累计计分步数 / 1000) − floor(前一日累计计分步数 / 1000)`；累计步行积分恒等于 `累计计分步数 // 1000`（`:12-13`，ORM 侧 `points_service.py:4-6`、`:105`）。不足 1000 步的零头结转到下一条记录，即小程序展示的 `walkCarry`（`points_service.walk_carry`，`:44-51`）。
2. **单日计分步数上下限**：`LEAST(GREATEST(steps, 0), 20000)`（`:21`、`:37`）——负数按 0、超 20000 按 20000 计。**⚠ 这条上限在运行期已不存在**：`points_service.walk_chain:40` 是 `total += max(int(steps or 0), 0)`，只保留了 `GREATEST(…, 0)` 语义、**丢掉了 20000 上限**，`points_service.py:4` docstring 明写「不设单日上限」，`backend/app/core/config.py:102-104` 也没有 walk 上限配置项。详见 §9「ORM 与 DDL 分歧」第 1 条。
3. **重算只动 walk 行**：`:28`、`:46` 的 WHERE 均限定 `biz_key = 'walk:' || c.date`，quiz 与 legacy 行零影响（`:14`）。
4. **补录幂等**：`daily_sport` 受 `uq_sport_user_date`（`models.py:240`）约束为每人每日一行，`_upsert_day`（`sport_service.py:114-132`）在行锁内**按微信最终值覆盖**而非累加，故重复同步同一天结果相同；台账侧 `recompute_walk` 是「按源数据全量核对并修复」，同样幂等（`points_service.py:100-108`）。**因此运行期链路可重跑，但本迁移脚本的重算不可重跑**（见 §8.2）。
5. **失败日期不落库**：微信未返回的日期既不写 0 也不覆盖既有记录，作为 `failed_dates` 返回、下次同步自动重试（`:7`，实现 `sport_service.py:145`、`:157-161`、`:164-165`）。这是「步数只增不减」的保证之一。
6. **`sync_status` 实际是常量列**：`:10` 默认 `'processed'`，运行期唯一写入点 `sport_service.py:130` **硬编码 `"processed"`**，全仓 grep 未发现任何其他取值或读取方（§9）。设计意图是「行存在即已成功处理」，故该列目前不承载信息。

## 8. 修改约束

1. **禁止修改本文件**：已入库（`git ls-files` 含 `docker/init/019_sport_backfill_carry.sql`）且属已发布编号脚本（`SQL_CONSTRAINTS.md` §3.1）。生产库 `schema_migrations` 是否已登记 `019_sport_backfill_carry.sql`：**待确认（本次建档禁止连库）**；但 `SQL_CONSTRAINTS.md` §7 记录 2026-10-16 曾因缺失本迁移导致生产 500，并已「手工 ADD COLUMN 补列 + 回填 `schema_migrations`」——即生产库**列已补齐、但 §4.2/§4.3 的重算与补建是否执行过未记录，待确认**。
2. **不可重复执行**：`SQL_CONSTRAINTS.md` §6 第一条点名本文件——含重算 UPDATE，重复执行会覆盖管理员事后手工调整过的数据。具体后果见 §9「重跑后果」。
3. **执行顺序不可颠倒**：本文件强依赖 `017` 建的 `biz_key` 等五列（§5）；`init-db.sh` 字典序保证，但手工 `gsql -f` 补跑时必须自己核对顺序。
4. `source` 取值域 `werun` / `mock` / `manual` 与 `sport_service.py:150`、`:338` 的写入分支一一对应，新增值须同步 ORM docstring（`models.py:236`）与该两处。
5. **改积分口径必须走新编号迁移**，且要同时改三处：新迁移 SQL、`points_service.walk_chain`、`config.py` 的 `POINTS_WALK_STEPS_PER_POINT`。只改一处就会出现「迁移回填值被运行期覆盖」的分叉（§9 第 1 条即此分叉的现存实例）。
6. `:19` 与 `:35` 是同一段窗口计算 SQL 的**完整重复**（违反根 `agents.md` §2.2「拒绝冗余代码」的精神），但已发布脚本禁止修改，只能在文档中标注、不得就地重构。

## 9. 当前实现状态

- **已实现**：三列在用（`sport_service._upsert_day` 每次写入都刷新）；结余口径已由 `points_service` 在运行期接管，`recompute_walk` 在每次步数写入后被调用（`sport_service.py:180`、`:339`）。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` 逐项）**：
  - **§1.1 违规（3 处）**：`:8`、`:9`、`:10` 全部使用禁用的 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`。**这不是理论风险——`:8` 的 `source` 列已在 2026-10-16 生产环境实际炸过**（§7 表格：`/api/sport/today` 500），且该表格明确「后续所有 ADD COLUMN 迁移改用 §1.1 方式 A」。
  - **§1.2 合规**（无 CREATE INDEX）；**§1.3 不涉及**（无 CREATE TABLE）。
  - **§1.4 合规**：两层派生表都带别名（`:26` `) t`、`:27` `) c`；`:42` `) t`、`:43` `) c`）。这是 §1.4「历史事故 `f413ac6`」之后必须守住的点。
  - **§1.5 合规**：未用 `ON CONFLICT`（改 `WHERE NOT EXISTS`，`:45-47`）；未用 `ALTER COLUMN TYPE`；无触发器；无 JSON 路径操作符。**窗口函数 `SUM() OVER (…) ROWS BETWEEN`（`:22-24`、`:38-40`）不在 §1.5 表格中**，按 §1.5 末段要求本应「先在本地 openGauss 跑通、再在生产库 dry-run」；`SQL_CONSTRAINTS.md` §7 记有 `f413ac6` 的根因是「020 迁移未跑」而非窗口函数失败，可反推本地 openGauss 执行过本文件成功，但**生产 openGauss 6.0.1 是否支持该窗口帧语法：待确认（本次建档禁止连库）**。
  - **§2.1 合规**（`:1`/`:49`）；**§2.2 部分合规**：INSERT 段幂等（`NOT EXISTS`）、UPDATE 段有收敛过滤（`delta <> c.delta`），但整体不可重跑（见下）；**§2.3 合规**（无删数据）；**§2.4 合规**：`:28` 同时限定了 `biz_key` 与 `delta <> c.delta`，正是该节要求的写法。
  - **§4 部分合规**：`:3-7` 与 `:12-14` 说明了变更目的与影响面，但**未按三段式分列**，且**缺回滚段**。
- **重跑后果（这是本文件的核心风险）**：
  - `:8-10` 的 ADD COLUMN 重跑在不支持 `IF NOT EXISTS` 的版本上直接语法报错中止；在支持的版本上是 no-op。
  - `:15-28` 的 UPDATE **不是「跑两次同值」那么简单**：它的收敛目标（带 20000 上限的结余口径）**已经与运行期口径不一致**。运行期 `recompute_walk` 会按**无上限**的结余口径改写 `delta`（`points_service.py:40` 无 `LEAST`）。因此在 019 之后，只要用户同步过一次步数，其 walk 行 `delta` 就已是无上限值；**此时重跑 019 会把这些行按有上限口径改回去**（`:28` 的 `delta <> c.delta` 判定为「不一致」从而覆写），等于**回退运行期已经算对的账**。对有单日步数 > 20000 的用户，总积分会被压低。
  - `:30-47` 的 INSERT 可安全重跑（`NOT EXISTS` 防重），但同样只会按有上限口径补建行。
  - 结论：**重跑 019 = 用过期口径覆写现行台账 + 抹掉管理员对 walk 行 `delta` 的手工调整**，与 `SQL_CONSTRAINTS.md` §6 的告警一致。
- **ORM 与 DDL 分歧**：
  1. **单日 20000 步上限（重要）**：DDL `:21`、`:37` 用 `LEAST(GREATEST(steps,0), 20000)`；ORM `points_service.walk_chain:40` 只有 `max(int(steps or 0), 0)`，**无上限**，docstring `:4` 明写「不设单日上限」，`config.py:102-104` 无对应配置项。→ 迁移回填值会被运行期覆盖，019 的 walk 口径实际是**过渡态**。
  2. **时间默认值两套写法**：DDL `:9` 的 `synced_at` 可空且**无默认值**，ORM `models.py:251` 同样 `default=None`——一致；但写入侧 `sport_service.py:129` 用 `now_utc()`（应用侧 UTC），而 DDL `:16`、`:32` 的 `updated_at` 用 `CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`（DB 侧 UTC），两条 UTC 来源不同（`.qoder/ARCHITECTURE.md` §13.2）。
  3. **`source` / `sync_status` 默认值机制**：DDL 是 `DEFAULT 'werun'` / `DEFAULT 'processed'`（服务端默认），ORM `models.py:250`、`:252` 是 `default="werun"` / `default="processed"`（客户端默认、无 `server_default`）。取值一致，但 ORM 侧不带 server_default 意味着**任何绕过 ORM 的裸 INSERT 依赖 DDL 默认值**。
  4. **`sync_status` 是死列**：ORM `models.py:252` 声明、`sport_service.py:130` 恒写 `"processed"`，全仓 grep 未发现读取方，也未发现任何非 `processed` 取值——列存在但不承载信息（与 `019:7`「行存在即已成功处理」的设计一致）。
  5. **`daily_sport` 未加索引**：本文件未给 `source` / `synced_at` / `sync_status` 建索引，ORM 侧也无 `index=True`——一致；但 `:21-25`、`:37-41` 的窗口计算需按 `(user_id, date)` 全表排序，依赖 `001_schema.sql` 建的 `daily_sport` 既有索引（`uq_sport_user_date`，`models.py:240`）。大表执行时长**待确认**。
- **回滚方式**：文件内无回滚语句，头注释也未提供（§4 违规）。手工回滚 = 逐列 `ALTER TABLE daily_sport DROP COLUMN source / synced_at / sync_status;`——会让 `sport_service._upsert_day:128-130` 立即报 `UndefinedColumn`（`/api/sport/sync` 与 `/api/sport/today` 全线 500，正是 2026-10-16 事故的镜像）；walk 台账 `delta` 的回退则**无法用 SQL 还原**（旧值已被覆写，只能靠 `points_service.recompute_walk` 按现行口径重算）。**生产不可回滚**。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/019_sport_backfill_carry.sql`，共 **1 个提交**。

### 2026-10-15（`6f2cfc3`，12:18）
- 需求：支持微信运动近 7 日步数补录，并把步行积分改为「零头结转」口径（`walkCarry`），跨日不足 1000 步的零头可累计计分。
- 修改内容（涉本文件）：创建本文件。① `daily_sport` 加 `source`（默认 `werun`）/ `synced_at`（可空）/ `sync_status`（默认 `processed`）三列；② 用 `SUM() OVER (PARTITION BY user_id ORDER BY date)` 窗口函数按结余口径重算 `points_log` 的 walk 行（`WHERE biz_key='walk:…' AND delta <> c.delta` 收敛），并补建缺失行（`WHERE delta > 0 AND NOT EXISTS`）。不删除任何数据、不动 quiz/legacy 行。
- 关联文件：`backend/app/models/models.py`（`DailySport` 三列）、`backend/app/services/sport_service.py`（`sync_today` 近 7 日逐日覆盖、`_upsert_day` 写来源三列、`walk_carry` 出口）、`backend/app/services/points_service.py`（`walk_chain`/`recompute_walk` 结余口径）、小程序步数页 `walkCarry` 展示、`docker/init/020_question_rotation.sql`（同一提交）。
- 测试结果：见 `docs/迭代记录.md` 的 `6f2cfc3` 条目。**后续生产事故**：`docker/init/SQL_CONSTRAINTS.md` §7 表格记录 2026-10-16 生产 `/api/sport/today` 500（缺本迁移 + `ADD COLUMN IF NOT EXISTS` 语法不支持），已手工补列并回填 `schema_migrations`。
