# 007_daily_quotes.sql

## 1. 文件路径

`docker/init/007_daily_quotes.sql`（16 行）

## 2. 文件职责

「每日一句长征寄语」建表迁移：新建 `daily_quotes` 表（初版按日期一天一条）。种子数据不在本文件，由 `backend/app/data/seed.py` 在表为空时写入（`:4` 注释；现为 5 条金句，`.qoder/ARCHITECTURE.md` §13.3）。

## 3. 业务需求

`71d1b9b`（2026-10-03）「每日寄语与节点纪念票（P2-1）——后台维护有出处语录、首页寄语卡、Canvas 节点纪念票」交付（`docs/迭代记录.md` 的 `71d1b9b` 条目）。文件头注释标注「需求 §16」，内容纪律（§16.4）：**不虚构历史名言，必须有明确出处、后台可维护、可关联历史节点**（`:5`）；展示规则：当天优先、否则最近一条历史寄语（`:6`）。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:16`）。

### 4.1 `daily_quotes`（`:8-14`）

| 列 | 类型/可空性 | 业务含义 |
|---|---|---|
| `id` | `SERIAL PRIMARY KEY` | 自增主键 |
| `date` | `VARCHAR(10) NOT NULL UNIQUE` | 寄语日期（YYYY-MM-DD），**一天一条**由列级 UNIQUE 保证 |
| `content` | `TEXT NOT NULL` | 寄语正文（有出处的史料语录） |
| `source` | `VARCHAR(200) NOT NULL` | 出处（§16.4 强制） |
| `node_id` | `INTEGER REFERENCES route_nodes(id)` 可空 | 关联历史节点（可无关联）；**真 FK** |

**注意：本表结构已被 `013_daily_quote_cycle.sql` 大幅改写**——013 删除了 `date` 列（`013:35`）、新增 `sort_order`/`is_enabled`（`013:8-9`）并建循环索引 `ix_daily_quotes_cycle`（`013:37`），寄语从「按日期一天一条」改为「启用寄语按 (sort_order, id) 循环展示」（`models.py:82-85` docstring）。本文件仅描述**初版**结构。

## 5. 输入与输出

- **输入（前置条件）**：001 已建 `route_nodes`（FK 目标）。
- **输出**：1 张空表；数据由 seed.py（表空时）与管理端「每日寄语」页维护。
- **失败模式**：`route_nodes` 缺失时建表失败回滚；同 date 二次插入违反 UNIQUE（初版运行期约束，013 删列后消失）。

## 6. 依赖关系

- 依赖：`001_schema.sql`（`route_nodes`）。
- 被依赖：`013_daily_quote_cycle.sql`（在其上改结构）；ORM `backend/app/models/models.py:81-95`（DailyQuote，**013 后形态**）；`backend/app/data/seed.py`；小程序首页寄语卡（quote service）；管理端寄语维护页（菜单码 `quotes`，`010_admin_identity.sql:112`）。

## 7. 业务规则

1. **幂等**：仅一条 `CREATE TABLE IF NOT EXISTS`（§1.3 允许），重跑无副作用。
2. 初版「一天一条」由 `date UNIQUE` 数据库级兜底；取数规则「当天优先、否则最近一条」（`:6`）。
3. `source` NOT NULL 是内容纪律的数据库表达——无出处的语录不允许入库（§16.4）。
4. `node_id` 可空：允许不绑定节点的通用寄语。

## 8. 修改约束

1. **禁止修改本文件**（已在生产执行，`docker/init/SQL_CONSTRAINTS.md` §3.1）；本文件与现行库结构的差异只能通过阅读 013 理解，不得「顺手修正」任何一侧。
2. 编号顺序不可变：013 假定本文件已建出含 `date` 列的表（其 DROP COLUMN 依赖该列存在）。
3. ORM DailyQuote 与 DDL 的对照必须以「007 + 013 叠加后」的形态为准（`backend/AGENTS.md` §4.8）。

## 9. 当前实现状态

- **已实现但已被后续迁移取代**：`daily_quotes` 表在用；但 `date` 列已由 013 删除，「按日期一天一条」的初版语义**已废弃**，现行为循环展示模型（`models.py:82-85`）。本文件保留仅为迁移历史完整性。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` §1）**：全部合规——§1.1 不涉及；§1.2 不涉及（未建任何索引，列级 UNIQUE 由建表语句内联）；§1.3 合规；§1.4 不涉及；§2.1 事务合规（`:1`/`:16`）；§2.2 幂等合规；§2.3 合规。§4 部分合规：有主题/目的/规则注释（`:3-6`）但缺「回滚」段。
- **与 ORM 的差异（重要）**：现行 ORM `DailyQuote`（`models.py:87-95`）**没有 `date` 列**，另有 `sort_order`/`is_enabled` 与 `ix_daily_quotes_cycle` 索引——三者均来自 `013_daily_quote_cycle.sql:8-9`、`:35`、`:37`，非本文件缺陷；对照本文件与 ORM 时必须叠加 013。
- **回滚方式**：文件内无回滚语句。手工回滚 = `DROP TABLE daily_quotes;`——销毁全部寄语（含 013 后的管理端维护数据），生产不应回滚；且回滚 007 前须先回滚 013（其对同表做过 ALTER）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/007_daily_quotes.sql`，共 **1 个提交**。

### 2026-10-03（`71d1b9b`，23:39）
- 需求：每日寄语与节点纪念票（P2-1，需求 §16）。
- 修改内容（涉本文件）：创建本文件，新建 `daily_quotes` 表（date 唯一、出处必填、可关联节点）。
- 关联文件：`backend/app/models/models.py`、`backend/app/data/seed.py`、小程序首页寄语卡、管理端寄语维护页、节点纪念票 Canvas。
- 测试结果：见 `docs/迭代记录.md` 的 `71d1b9b` 条目。
