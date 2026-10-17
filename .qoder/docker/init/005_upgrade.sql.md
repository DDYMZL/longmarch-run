# 005_upgrade.sql

## 1. 文件路径

`docker/init/005_upgrade.sql`（81 行）

## 2. 文件职责

「高级化功能增强」的数据模型扩展迁移：为 `users`/`daily_sport`/`lit_nodes`/`route_nodes`/`questions`/`medal_defs` 六张既有表加列（连续行军、估算距离、达标标记、补签预留、点亮步数快照、历史事件卡内容、知识画像分类、勋章分类/隐藏/排序），并新建用户统一事件表 `user_event`。头注释自述与 `backend/app/models/models.py` 同步、种子回填由 `app/data/seed.py` 启动时幂等补齐（`:4`）。

## 3. 业务需求

`d0933fb`（2026-10-01）「数据模型扩展（005迁移），新增用户事件表、连续行军与历史事件卡字段，种子升级为12勋章+题目分类」交付（`docs/迭代记录.md` 的 `d0933fb` 条目）。支撑四类业务：① 连续行军天数展示（首页/档案）；② 步数→估算距离与每日 5000 步行军目标；③ 节点「历史事件卡」内容（brief/图文/音频/关键词）与答题知识画像分类；④「我的长征足迹」与管理端实时动态同源的用户事件流（`models.py:365-371` UserEvent docstring）。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:81`）。数值/布尔列统一采用文件头自述的「四步模式」：加列（可空）→ 回填 → SET NOT NULL → SET DEFAULT（`:7`）。

### 4.1 `users`：连续行军缓存（`:10-18`）

`continuous_days`、`max_continuous_days` 各一组四步（回填 0，NOT NULL DEFAULT 0）。由 sport 写入链路维护、启动时按 `daily_sport` 全量重算兜底（`:9` 注释；`models.py:184-186` docstring，streak_service）。

### 4.2 `daily_sport`：距离/达标/补签（`:21-36`）

- `distance NUMERIC(10,2)`：回填公式 `ROUND(steps * 0.7 / 1000, 2)`（`:22`，步长 0.7 米→公里），NOT NULL DEFAULT 0。
- `is_goal_completed BOOLEAN`：回填 `steps >= 5000`（`:27`，每日行军目标 5000 步，连续行军判定依据），NOT NULL DEFAULT FALSE。
- `is_makeup BOOLEAN`（`:31-34`，NOT NULL DEFAULT FALSE）与 `makeup_at TIMESTAMP`（`:36`，可空）：**补签预留，机制本期不实现**（`:20` 注释）——现为死字段，见 §9。

### 4.3 `lit_nodes.step_snapshot`（`:39-42`）

点亮时刻累计步数快照，INTEGER 四步模式回填 0；头注释明确「历史数据无法还原，保留 0，接口判空处理」（`:38`；`models.py:258`）。

### 4.4 `route_nodes`：历史事件卡 7 列（`:45-51`）

`brief VARCHAR(200)`、`significance TEXT`、`figures VARCHAR(500)`、`location VARCHAR(100)`、`images JSON`、`audio VARCHAR(500)`、`keywords VARCHAR(200)`——**全部保持可空、无 DEFAULT**（`:44` 注释：种子仅补空值，尊重管理端编辑；Oracle 兼容模式下字符串内容列一律可空，`:5-6`）。

### 4.5 `questions.category` / `medal_defs` 三列（`:54-67`）

- `questions.category VARCHAR(20)` 可空（`:53` 注释：event/route/figure 知识画像分类，种子按 id 回填）。
- `medal_defs.category VARCHAR(20)` 可空（starter/route/challenge/complete）；`hidden BOOLEAN`、`sort_order INTEGER` 各一组四步（FALSE/0）。

### 4.6 新表 `user_event`（`:70-79`）

`id SERIAL PK`；`user_id INTEGER NOT NULL REFERENCES users(id)`（真 FK）；`event_type VARCHAR(30) NOT NULL`（取值枚举在 `services/event_service`：FIRST_STEP/DAILY_GOAL/NODE_UNLOCK/BADGE_UNLOCK/QUIZ_*/STREAK_*/COMPLETE_ROUTE 等，`models.py:368-370`）；`event_time TIMESTAMP NOT NULL`；`event_data JSON` 可空。索引 `ix_user_event_user_id`、`ix_user_event_time`（`:78-79`）。无唯一约束——事件流为追加型。

## 5. 输入与输出

- **输入（前置条件）**：001–004 已执行（`users`/`daily_sport`/`lit_nodes`/`route_nodes`/`questions`/`medal_defs` 存在）。
- **输出**：6 表共 18 个新列 + 1 张新表 + 2 个索引；历史行按 §4 公式回填。
- **失败模式**：`ADD COLUMN IF NOT EXISTS` 语法在不支持它的生产 openGauss 版本上直接语法报错、整事务回滚（`SQL_CONSTRAINTS.md` §7 已发生同类事故）；SET NOT NULL 前有回填兜底，不会因 NULL 失败。

## 6. 依赖关系

- 依赖：`001_schema.sql`（全部目标表）；`route_nodes` 4 个配置列已由 001/002 就位。
- 被依赖：ORM `models.py`（RouteNode `:48-54`、Question.category `:141`、MedalDef `:158-160`、User `:197-198`、DailySport `:246-249`、LitNode `:268`、UserEvent `:374-381`）；`backend/app/data/seed.py`（12 勋章、题目分类、事件卡内容补空）；`event_service`/`streak_service`/`broadcast_service`/`march_service`；012 为 `user_event` 追加复合索引 `ix_user_event_user_type`。

## 7. 业务规则

1. **Oracle 兼容模式空串即 NULL**：`''` 落库为 NULL（已验证 `'' IS NULL` 为真，`:5-6` 注释），故字符串内容列一律可空、代码层把 NULL 视为 `''`（ORM/Schema 兜底）——这是全库字符串列可空性设计的根因（`.qoder/ARCHITECTURE.md` §12.4 亦登记）。
2. **回填收敛**：所有 UPDATE 带 `WHERE <col> IS NULL` 过滤（`:11`、`:16`、`:22`、`:27`、`:32`、`:40`、`:60`、`:65`），手工重跑不会覆写已有值，符合 `SQL_CONSTRAINTS.md` §2.2/§2.4。
3. **种子只补空值**：事件卡/分类列的历史内容由 seed.py 按「空才写」策略维护，管理端编辑优先（`:44`、`:53`、`:56` 注释）。
4. 达标线 5000 步、步长 0.7 米为**硬编码业务常量**（`:22`、`:27`），与 service 层常量需人工保持一致。

## 8. 修改约束

1. **禁止修改本文件**（已在生产执行，`SQL_CONSTRAINTS.md` §3.1）；`.qoder/ARCHITECTURE.md` §12.4「历史包袱」段明确 005 使用了如今被禁止的语法，**不可照抄本文件写法新增迁移**。
2. 四步模式的顺序不可颠倒（先 SET NOT NULL 后回填会失败）。
3. `user_event` 是 REST 动态流与 WebSocket `activity` 推送的同源表（`.qoder/backend/app/api/routes/broadcast.py.md` §7），改结构需同时核对两条通道。
4. 补签两列即使确认废弃也不得用 `DROP COLUMN` 清理进本文件——只能新增编号迁移并走运维流程（§2.3 不删除数据）。

## 9. 当前实现状态

- **已实现**：全部列/表生效；连续行军、距离、达标、事件流均有业务写入。
- **死字段（核实为真）**：`is_makeup`/`makeup_at`（`:31-36`）——全仓仅 `models.py:248-249` 定义与 `backend/design.md` 表结构清单提及，**无任何业务写入点**，与 `.qoder/PROJECT.md` §8「代码级技术债」第 29 项登记一致（该项定位 `005_upgrade.sql:31-36`，经逐行核对无误：`is_makeup` 四步在 `:31-34`、`makeup_at` 加列在 `:36`，NOT NULL DEFAULT FALSE 属实）。按用户决定只记录不修改。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md` §1 逐项）**：
  - §1.1 **违规**：18 处 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（`:10`、`:15`、`:21`、`:26`、`:31`、`:36`、`:39`、`:45-51`、`:54`、`:57`、`:59`、`:64`）——现行约束禁用，生产老版本会语法报错（§7 踩坑表 2026-10-16 事故同因）；
  - §1.2 **风险**：`:78-79` 两处 `CREATE INDEX IF NOT EXISTS`（默认按不支持处理）；
  - §1.3 合规（`:70` CREATE TABLE IF NOT EXISTS）；§1.4 不涉及（无派生表）；§1.5 不涉及（无 ON CONFLICT/TYPE USING）；
  - §2.1 事务合规（`:1`/`:81`）；§2.2 幂等：在语法被支持的前提下重跑安全（加列跳过、回填有 IS NULL 过滤、SET NOT NULL/DEFAULT 幂等）；§2.3 合规（无删数据）。
  - §4 部分合规：有主题/目的/约定注释（`:3-7`）但缺标准三段式的「影响面/回滚」独立行。
- **与 ORM 的差异**：本文件所建列与 `models.py` 一一对应、类型可空性一致；唯一差异是 `UserEvent` ORM 另声明复合索引 `ix_user_event_user_type`（`models.py:375`），该索引**不在本文件**、由 `012_perf_indexes.sql:10` 创建。
- **回滚方式**：文件内无回滚语句。手工回滚 = 逐列 `ALTER TABLE ... DROP COLUMN`（18 列）+ `DROP TABLE user_event`——**销毁连续行军缓存、事件流全部历史**，且事件流无备份来源，生产不应回滚；确需回退先备份。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/005_upgrade.sql`，共 **1 个提交**。

### 2026-10-01（`d0933fb`，22:53）
- 需求：高级化功能增强（V1.1 批次）——连续行军、估算距离、历史事件卡、知识画像、勋章分类、用户事件流。
- 修改内容（涉本文件）：创建本文件，6 表加 18 列 + 新建 `user_event` 表。
- 关联文件：`backend/app/models/models.py`、`backend/app/data/seed.py`（12 勋章+题目分类）、event/streak/broadcast 服务层。
- 测试结果：见 `docs/迭代记录.md` 的 `d0933fb` 条目。
