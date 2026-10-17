# 014_quiz_result_details.sql

## 1. 文件路径

`docker/init/014_quiz_result_details.sql`（10 行）

## 2. 文件职责

单列迁移：给 `quiz_records` 加可空 JSON 列 `details`（`:8`），留存每次答题提交后的**逐题判分结果快照**，支撑「答题改为提交后统一反馈」的结果页详情展示（`:3-4` 头注释）。

## 3. 业务需求

`25c954c`（2026-10-12）「答题改为提交后统一反馈——移除单题判题接口与作答中对错/连胜提示，题目不下发答案与解析，提交须覆盖今日全部题目防伪造刷分，逐题结果落库（迁移 014）并在结果页展示答题详情」交付（`docs/迭代记录.md` 的 `25c954c` 条目）。业务动机：作答过程中不再即时判题（移除 `/quiz/check`），答案与解析只能在提交后随结果一次性下发，故需落库逐题结果；历史记录不回填、不重算成绩（`details` 为 NULL，前端回退展示 `wrong_list` 错题回顾，`:6` 注释）。

## 4. 核心功能

事务包裹：`START TRANSACTION`（`:1`）… `COMMIT`（`:10`）；注释在事务内（`:3-6`），缺「回滚」段。

### 4.1 加列（`:8`）

`ALTER TABLE quiz_records ADD COLUMN IF NOT EXISTS details JSON;`

- 可空、无默认——存量行自然为 NULL，即「历史记录不回填」的实现方式；
- `JSON` 而非 `JSONB`（全库约定，`.qoder/ARCHITECTURE.md` §12.5「其他兼容事实」段）；
- 元素结构（`:5` 注释）：`[{index, question_id, type, question, options, user_answer, correct_answer, correct, score, analysis}]`。**实现已超出该注释**：现行 `_detail` 还写入 `timeout`、`points` 两键（`backend/app/services/quiz_service.py:205-220`，V2.0 每题限时作答批次追加），注释未更新（文件已锁定不可改，见 §8）。
- **`ADD COLUMN IF NOT EXISTS` 为 `SQL_CONSTRAINTS.md` §1.1 禁用语法（1 处）**，见 §9。

## 5. 输入与输出

- **输入（前置条件）**：`001_schema.sql:77` 已建 `quiz_records`。
- **输出**：1 个可空 JSON 列；无索引、无种子、不修改任何既有数据（存量行 `details=NULL`）。
- **失败模式**：支持该语法的库上重跑 no-op（幂等）；生产老版本 openGauss 不支持 `ADD COLUMN IF NOT EXISTS`，首跑即在 `:8` 失败（见 §9）。

## 6. 依赖关系

- 依赖：`001_schema.sql`（`quiz_records`）。
- 被依赖：
  - ORM：`QuizRecord.details`（`backend/app/models/models.py:286`，`JSON` nullable、`default=None`，注释明确「014 迁移新增；历史记录为 None，展示时回退 wrong_list」）。
  - 写入：`quiz_service._finalize` 提交判分时由 `quiz_answers` 行（018 表）逐题构造 `details` 后随 `QuizRecord` 一次落库（`quiz_service.py:223-256`，构造器 `_detail` `:205-220`）。
  - 读取：`quiz_service._record_out`（`:78-89`）输出结果详情，`details = r.details or []`（`:79`）即 NULL 回退空列表；历史列表不带详情（`:483` `with_details=False`）。
- **与 `018_quiz_answers.sql` 的职责边界（不重叠）**：018 建 `quiz_answers` 表记录**作答过程**（每题开始/截止/提交时间与状态，V2.0 每题限时）；014 的 `details` 是提交判分后从 `quiz_answers` 行 + 题目快照**派生出的结果快照**（冗余存储，供结果页与历史回看，避免回放时重查题目）。两者一过程一结果、互为上下游，无 DDL 冲突；如需了解过程表以 `018_quiz_answers.sql` 及其文档为准。

## 7. 业务规则

1. **只写一次**：`details` 在 `_finalize` 生成当日记录时写入（`quiz_records` user+date 唯一，并发只写一次），之后不更新、不回填。
2. **NULL 语义**：`details IS NULL` = 014 之前的历史记录，前端回退 `wrong_list` 错题回顾展示（`:6` 注释、`models.py:285`）。
3. 快照冗余原则：`details` 内嵌题目文本/选项/答案/解析，题目事后被编辑或删除不影响历史结果展示（`_detail` 对 `q is None` 有兜底，`quiz_service.py:205-220`）。
4. `payload` 为整批 JSON，**无行级查询需求**，故不建 GIN/表达式索引（openGauss JSON 索引亦属谨慎项，`SQL_CONSTRAINTS.md` §1.5）。

## 8. 修改约束

1. **禁止修改本文件**（`SQL_CONSTRAINTS.md` §3.1），包括更新 `:5` 的字段清单注释——`timeout`/`points` 两键的口径以 `quiz_service._detail` 为准。是否已在生产 `schema_migrations` 登记：待确认（本次建档禁止连库）；按功能上线时间（2026-10-12）推定已执行。
2. `details` 元素结构是前端结果页的隐式契约（小程序 camelCase 转换后消费），增删键须同步 `frontend` 答题结果页与其文档。
3. 不得据此列做 SQL 级过滤/聚合（JSON 无索引），统计一律走应用层。

## 9. 当前实现状态

- **已实现**：提交后统一反馈、结果页逐题详情已上线（`25c954c` 批次）；V2.0 限时作答批次（018）继续复用本列并扩展了 `timeout`/`points` 键。
- **openGauss 兼容性（对照 `SQL_CONSTRAINTS.md`）**：
  - §1.1 **违规 1 处**（`:8`）：生产老版本不支持 `ADD COLUMN IF NOT EXISTS`（2026-10-16 事故根因）。本文件早于约束文档定稿，已列入 `.qoder/ARCHITECTURE.md` §12.4「历史包袱」清单（014=1 处，实测复核一致）。
  - §1.2/§1.3/§1.4 不涉及；§1.5 合规（未用 `ON CONFLICT`）。
  - §2.1 事务合规（`:1`/`:10`）；§2.2 幂等合规（在支持该语法的库上）；§2.3 合规（无删数据，存量行不动）。
  - §4 部分合规：`:3-6` 有目的/影响面（含历史数据处理策略），缺「回滚」段。
- **与 ORM 的差异**：无——`models.py:286` 与 `:8` 类型（JSON）、可空性（nullable）、无默认值逐项一致。
- **注释滞后**：`:5` 字段清单缺 `timeout`/`points`（见 §4.1），属已锁定文件的历史注释，不改。
- **回滚方式**：文件内无回滚语句。手工回滚 = `ALTER TABLE quiz_records DROP COLUMN details;`——将销毁全部历史逐题结果（结果页详情退化为仅错题回顾），且现行 `quiz_service` 写入路径会立即报 UndefinedColumn，**生产不可回滚**。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- docker/init/014_quiz_result_details.sql`，共 **1 个提交**。

### 2026-10-12（`25c954c`，13:04）
- 需求：答题提交后统一反馈，逐题结果落库并在结果页展示。
- 修改内容（涉本文件）：新建本文件，为 `quiz_records` 增加可空 JSON 列 `details`。
- 关联文件：`backend/app/services/quiz_service.py`（判分与 `_record_out`）、`backend/app/models/models.py:286`、小程序答题/结果页（移除作答中对错提示）。
- 测试结果：见 `docs/迭代记录.md` 的 `25c954c` 条目。
