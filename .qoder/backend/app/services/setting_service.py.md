# setting_service.py

## 1. 文件路径
`backend/app/services/setting_service.py`（全文 22 行）

## 2. 文件职责
`system_settings` 键值表的**唯一**代码读写入口：`get_value` 按 key 取字符串值（无则返回 `None`），`set_value` 做 upsert（无行则 INSERT，有行则改 `setting_value` 与 `updated_at`）。**自身不 commit、不 flush、不 rollback**，提交责任在调用方（`backend/app/services/setting_service.py:16` docstring 明示「调用方负责提交」）。全仓 grep `SystemSetting` 只有 4 处命中：ORM 定义 `backend/app/models/models.py:98` 与注释 `backend/app/models/models.py:84`，以及本文件 `:7`/`:11`/`:17`/`:19` —— 即**没有任何其它代码路径直接读写该表**。

## 3. 业务需求
本文件服务两条独立需求，二者共用同一张 KV 表：

1. **每日寄语按天循环**（提交 `d6acf7e`，2026-10-11 新建本文件）：寄语改为「排序号 + 启用状态」按天循环后，循环起始日期需要一个管理端可改、重启不丢的存放点，于是新建 `system_settings` 表（迁移 `docker/init/013_daily_quote_cycle.sql:23-27`）与本文件，存 key `quote_cycle_start`。需求出处在代码注释中记为「需求 §16、V1.1 功能二」（`backend/app/services/quote_service.py:1`），但仓库内未找到对应的 V1.1 需求文档 —— 待确认。
2. **AI 智能中心 Phase A「配置中心」**（提交 `1600074`，2026-10-17 新增调用方）：13 个 `ai_*` key（9 个运行参数 + 3 个提示词 + 1 个提示词版本号）以「DB 覆盖 > env 默认」的方式生效，见 `.qoder/REQUIREMENTS.md` §10.2 与 `backend/app/services/ai_config_service.py:1-7` docstring。

导航层定位：`.qoder/ARCHITECTURE.md` §13.1「配置与内容」行把 `system_settings` 归入「配置与内容」表组；`.qoder/PROJECT.md` §7「管理后台（11 菜单）」记载管理端「每日寄语（含循环起始日 + Excel 导入）」。**本文档只补文件级细节，不复述上述正文。**

## 4. 核心功能
本文件只有 **2 个公开函数**，无类、无私有函数、无常量。

### 4.1 `get_value(db, key) -> Optional[str]`（`backend/app/services/setting_service.py:10-12`）
1. **只 SELECT 一列**：`db.query(SystemSetting.setting_value).filter(SystemSetting.setting_key == key).first()`（`:11`）。查列而非查实体，返回的是 `Row` 元组，行**不会进入 session identity map**、不参与脏检查。
2. **命中返回 `row[0]`，未命中返回 `None`**（`:12`）。
3. **刻意不做的事**（读代码可直接确认）：不做类型转换（布尔/整数一律以字符串返回，转换在 `backend/app/services/ai_config_service.py:120`、`:122` 完成）、不 `strip()`、不校验 key 是否合法、**不缓存**（每次调用一条 SQL）、**不抛业务异常**。
4. 空串按原样返回：调用方需自行判空。两处判空写法一致 —— `raw is None or str(raw).strip() == ""`（`backend/app/services/ai_config_service.py:117`、`:141`）；`backend/app/services/quote_service.py:49` 则用 `or DEFAULT_CYCLE_START` 兜底。

### 4.2 `set_value(db, key, value) -> None`（`backend/app/services/setting_service.py:15-22`）
1. 先 `db.query(SystemSetting).filter(setting_key == key).first()` 取整行（`:17`），按 `row is None` 分两支：
   - **INSERT 支**（`:18-19`）：`db.add(SystemSetting(setting_key=key, setting_value=value, updated_at=datetime.utcnow()))`；
   - **UPDATE 支**（`:20-22`）：直接改 ORM 对象的 `setting_value`（`:21`）与 `updated_at`（`:22`），由后续 flush 生成 UPDATE。
2. **两支都显式写 `updated_at=datetime.utcnow()`**（`:19`、`:22`），因此 `backend/app/models/models.py:105` 的 ORM 列默认在本函数路径上**永远不会被用到**；DDL 默认 `CURRENT_TIMESTAMP`（`docker/init/013_daily_quote_cycle.sql:26`）只对不经本函数的 SQL 级插入生效 —— 目前仅迁移种子语句 `docker/init/013_daily_quote_cycle.sql:30-33`（该 INSERT 未列出 `updated_at`）。这意味着库内同一张表的 `updated_at` 存在两种时间来源：本文件写 **UTC naive**，迁移种子写 **数据库本地时间**。
3. **不 commit、不 flush**（`:16` docstring 约定）。因 `SessionLocal` 为 `autoflush=False`（`backend/app/core/database.py:51`），写入在同一事务内的后续读取**默认不可见**，需要调用方显式 flush —— `backend/app/services/ai_config_service.py:221-223` 正是为此加了 `db.flush()` 并在注释里说明原因。
4. **不是原子 upsert**：SELECT 与 INSERT 之间没有唯一冲突处理（无 `ON CONFLICT` / 无 try-`IntegrityError`）。并发首次写入同一 key 时，后提交方会撞主键 `system_settings_pkey` 抛 `IntegrityError`（后果见 §9）。

## 5. 输入与输出

### 5.1 入参与返回
| 函数 | 参数 | 类型注解 | 说明 |
|---|---|---|---|
| `get_value` | `db` | `Session` | 调用方持有的会话（请求级 `Depends(get_db)`） |
| | `key` | `str` | `system_settings.setting_key`；本函数不校验长度/白名单 |
| | **返回** | `Optional[str]` | 值为字符串原样；key 不存在返回 `None` |
| `set_value` | `db` | `Session` | 同上 |
| | `key` | `str` | 同上；不存在则作为新行主键写入 |
| | `value` | `str` | **注解要求 `str`**；调用方实际写入的都是字符串（布尔 → `"true"`/`"false"`，整数 → `str(num)`，见 `backend/app/services/ai_config_service.py:200`、`:208`） |
| | **返回** | `None` | 调用方无法从返回值区分本次是 INSERT 还是 UPDATE |

### 5.2 异常
- 两个函数体内**均无 `try/except`、均不主动 `raise`**。
- 可能的运行期异常全部来自下游：值超列宽 `VARCHAR(200)` 或 key 超 `VARCHAR(64)` 时，在调用方 `flush()`/`commit()` 处抛 `sqlalchemy.exc.DataError`（openGauss/psycopg2 为 `StringDataRightTruncation`）；并发首写同 key 抛 `IntegrityError`。两者都**不是 `ValueError`**，路由层的 `except ValueError → 400` 不会捕获，最终表现为 500（实测依据见 §9 第 2 条）。

### 5.3 落库表结构（`system_settings`）
| 列 | ORM（`backend/app/models/models.py:98-105`） | DDL（`docker/init/013_daily_quote_cycle.sql:23-27`） | 说明 |
|---|---|---|---|
| `setting_key` | `Mapped[str]` = `String(64)`，`primary_key=True`（`:103`） | `VARCHAR(64) PRIMARY KEY`（`:24`） | 键名，即 upsert 的判定依据 |
| `setting_value` | `Mapped[str]` = `String(200)`（`:104`） | `VARCHAR(200) NOT NULL`（`:25`） | 一律存字符串；**列宽与提示词长度上限冲突，见 §9 第 2 条** |
| `updated_at` | `Mapped[datetime]` = `DateTime`，`default=datetime.utcnow`（`:105`） | `TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`（`:26`） | 本函数显式赋 UTC naive，列默认不生效 |

表无其它索引（主键即唯一索引），`get_value` 按主键等值查询。

### 5.4 当前在用的 setting_key（全仓 grep `get_value(`/`set_value(` 得出，共 **14 个**）
| key | 写入点 | 读取点 | 值口径 |
|---|---|---|---|
| `quote_cycle_start` | `backend/app/services/quote_service.py:55` | `backend/app/services/quote_service.py:49` | `YYYY-MM-DD`；写前经 `parse_date` 校验（`:53-54`）；空配置兜底常量 `DEFAULT_CYCLE_START = "2026-10-01"`（`:20`，注释 `:19` 说明「013 迁移会写入配置，此值仅用于空配置环境」） |
| `ai_enabled`、`ai_chat_daily_limit`、`ai_global_daily_limit`、`ai_max_input_chars`、`ai_max_output_tokens`、`ai_request_timeout`、`ai_max_retries`、`ai_context_turns`、`ai_knowledge_top_k`（9 个） | `backend/app/services/ai_config_service.py:200`（布尔）、`:208`（整数） | `backend/app/services/ai_config_service.py:116`、`:179` | 布尔存 `"true"`/`"false"`；整数存 `str(num)`，范围由 `_SPEC`（`:45-55`）的 `lo`/`hi` 在写前校验、读时再夹取（`_cast_int` `:100-109`） |
| `ai_prompt_chat`、`ai_prompt_route`、`ai_prompt_quiz`（3 个，键名映射见 `backend/app/services/ai_config_service.py:92-96`） | `backend/app/services/ai_config_service.py:213` | `backend/app/services/ai_config_service.py:140`、`:182` | 提示词正文；写前长度校验上限 `PROMPT_MAX_LEN = 4000`（`:18`、`:211-212`）；读时空值回退内置默认 `_DEFAULT_PROMPTS`（`:60-91`） |
| `ai_prompt_version` | `backend/app/services/ai_config_service.py:218` | `backend/app/services/ai_config_service.py:147`、`:182` | ≤32 字（`:216-217`）；空值回退常量 `PROMPT_VERSION = "v1"`（`:17`） |

> 传入 `"true"`/`"false"`、`str(num)` 等字符串化约定都在**调用方**，本文件不参与。

## 6. 依赖关系

### 6.1 本文件依赖（`backend/app/services/setting_service.py:2-7`，4 个 import）
| 依赖 | 用途 |
|---|---|
| 标准库 `datetime.datetime`（`:2`） | `updated_at` 赋值（`:19`、`:22`） |
| 标准库 `typing.Optional`（`:3`） | 返回类型注解 |
| `sqlalchemy.orm.Session`（`:5`） | 入参类型注解 |
| `app.models.models.SystemSetting`（`:7`） | 唯一 ORM 依赖 |

**不依赖** `app.core.config`、`app.core.database`、`app.core.helpers`、任何其它 service，也不 import FastAPI —— 处于 `backend/AGENTS.md` §3.1 分层图 `services -> models + core` 的最底层，无反向依赖、无循环依赖风险。数据库表：仅 `system_settings`（读 + 写）。第三方库：无（httpx / openpyxl 一概不涉及）。

### 6.2 被谁依赖（全仓 grep `setting_service`，共 **2 个 backend/app 文件**）
| 调用方 | import 位置 | `get_value` 调用点 | `set_value` 调用点 | **谁 commit** |
|---|---|---|---|---|
| `backend/app/services/quote_service.py` | `:16` | `:49` | `:55` | **调用方 service 自提交**：`set_cycle_start` 在 `backend/app/services/quote_service.py:56` 直接 `db.commit()` |
| `backend/app/services/ai_config_service.py` | `:14` | `:116`、`:140`、`:147`、`:179`、`:182` | `:200`、`:208`、`:213`、`:218` | **路由层提交**：`patch_config` 只 `db.flush()`（`:223`，docstring `:187` 明示「不提交，由路由统一 commit」），由 `backend/app/api/routes/ai_admin.py:377` `db.commit()`；失败路径 `:378-380` `db.rollback()` → 400 |

两个调用方恰好分属 `.qoder/ARCHITECTURE.md`（§9.4）记载的**两种并存提交约定**；本文件本身属「路由/调用方提交」一侧（不提交）。

### 6.3 端到端链路（route → service → 本文件）
| HTTP 方法 | 路径 | 权限依赖 | 调用链 |
|---|---|---|---|
| GET | `/api/quotes/today` | `get_current_user`（`backend/app/api/routes/quotes.py:18`） | `backend/app/api/routes/quotes.py:17-20` → `quote_service.get_today`（`:72`）→ `_pick`（`:65`）→ `get_cycle_start`（`:49`）→ **`get_value`** |
| GET | `/api/admin/quotes/cycle` | `require_menu("quotes")`（`backend/app/api/routes/admin.py:562`） | `backend/app/api/routes/admin.py:558-565` → `quote_service.get_cycle_info`（`:85`）→ `get_cycle_start`（`:89`→`:49`）→ **`get_value`**；`response_model=AdminQuoteCycleOut` |
| PUT | `/api/admin/quotes/cycle` | `require_menu("quotes")`（`backend/app/api/routes/admin.py:572`） | `backend/app/api/routes/admin.py:568-579` → `quote_service.set_cycle_start`（`:52`）→ **`set_value`**（`:55`）+ `commit`（`:56`）；`ValueError` → 400（`backend/app/api/routes/admin.py:577-578`） |
| GET | `/api/admin/ai/config` | `require_menu("ai_config")`（`backend/app/api/routes/ai_admin.py:346`） | `backend/app/api/routes/ai_admin.py:342-349` → `ai_config_service.get_config_view`（`:153`）→ **`get_value` ×26**（`get_effective` 9 + `get_prompt` 3 + `get_prompt_version` 1 + `overridden` 13，见 §9 第 5 条） |
| PATCH | `/api/admin/ai/config` | `require_menu("ai_config")`（`backend/app/api/routes/ai_admin.py:356`、`:360`） | `backend/app/api/routes/ai_admin.py:352-381` → `ai_config_service.patch_config`（`:186`）→ **`set_value` ×N** → `flush`（`:223`）→ 审计 `ai.config.patch`（`backend/app/api/routes/ai_admin.py:376`）→ `commit`（`:377`） |
| （间接）POST `/api/ai/chat`、GET `/api/ai/quiz-explanation/{id}` | `get_current_user` | `backend/app/services/ai_chat_service.py:192`、`:373` `ensure_enabled` → `get_effective`（`:116`）→ **`get_value` ×9**；`:235`、`:386` `get_prompt`（`:140`）→ **`get_value` ×1** |

管理端前端调用方：`admin/src/api/admin.ts:732-738`（`fetchQuoteCycle` / `updateQuoteCycle`，供 `admin/src/views/QuotesView.vue` 使用）。**AI 配置中心在 `admin/src/` 内零调用**（全仓 grep `/admin/ai/config` 只命中后端），与 `.qoder/REQUIREMENTS.md` §10.6「知识库 / 配置 / 题目工坊」行「管理后台 AI 子页面：知识库 / 配置 / 题目工坊 —— 待开发（后端接口已就绪）」一致，属 Phase A 预期状态而非缺陷。

## 7. 业务规则

### 7.1 「DB 覆盖 > env 默认」的合并规则不在本文件
本文件只负责存取字符串；**合并语义完全由 `backend/app/services/ai_config_service.py:112-123`（`get_effective`）实现**：DB 有非空值则覆盖 env，否则回退 env 默认，整数再按 `_SPEC` 的 `lo`/`hi` 夹取（`:122`→`_cast_int` `:100-109`）。寄语侧同理：DB 无值时用 `DEFAULT_CYCLE_START`（`backend/app/services/quote_service.py:49`）。因此**「删除一行 = 恢复默认」是本表的隐含语义**，任何改成「空串表示显式禁用」的方案都会与两个调用方的判空逻辑冲突。

### 7.2 空串与 NULL 的区别
DDL 为 `NOT NULL`（`docker/init/013_daily_quote_cycle.sql:25`），故正常写入不会产生 NULL。但 `ai_config_service.patch_config` 允许把提示词写成空串（`:210` 的 `"" if value is None else str(value)`），且 openGauss 处于 `datcompatibility='A'`（Oracle 兼容，空串按 NULL 存储，见 `backend/app/models/models.py:33-38` 同类说明），因此「空串」与「未配置」在读取侧被刻意合并处理（`:117`、`:141` 同时判 `None` 与 `strip()==""`）。

### 7.3 时间口径
`updated_at` 写 `datetime.utcnow()`（`:19`、`:22`）= **UTC naive**，与库内其它时间列一致（`.qoder/ARCHITECTURE.md` §4.5）。与 `backend/app/core/helpers.py:12-14` 的 `now_utc()` 行为等价（后者内部就是 `datetime.utcnow()`），但本文件直接用标准库、**未复用 helper**。

### 7.4 事务与提交责任
- `set_value` 只把变更挂到会话；**提交责任在调用方**，且两个调用方约定不同（见 §6.2 表）。
- 因 `autoflush=False`（`backend/app/core/database.py:51`），**同事务内「先写后读」必须显式 flush**，否则读到旧值 —— `backend/app/services/ai_config_service.py:221-223` 已按此处理；`backend/app/services/quote_service.py:52-56` 是「写完直接 commit，再由路由重新读」（`backend/app/api/routes/admin.py:579` 在 commit 之后调 `get_cycle_info`），不存在同事务读写问题。
- 失败回滚：`ai_config_service.patch_config` 在多键循环中途抛 `ValueError` 时，本函数已写入的前几个 key 会被 `backend/app/api/routes/ai_admin.py:379` 的 `db.rollback()` 一并撤销（同事务），不会留下半更新状态。

### 7.5 审计
本文件不写审计。调用方口径不一致：`ai.config.patch` 写审计（`backend/app/api/routes/ai_admin.py:376`，与配置变更同事务）；`quote_service.set_cycle_start` **不写审计**（`backend/app/services/quote_service.py` 全文无 `audit_service` 引用）。修改循环起始日期会影响全端「今日寄语」展示，是否需要审计 —— 待确认。

### 7.6 key 白名单不在本文件
本文件接受任意字符串 key。白名单在 `backend/app/services/ai_config_service.py:194-220`（`_BY_KEY` / `_PROMPT_KEYS.values()` / `_PROMPT_VERSION_KEY` 三类之外一律 `ValueError("不支持的配置项：{key}")` → 400）；寄语侧则硬编码单一常量 `CYCLE_START_KEY`（`backend/app/services/quote_service.py:18`）。

## 8. 修改约束
1. **禁止在 `set_value` 内加 `db.commit()` / `db.flush()`**：会破坏 `:16` docstring 约定，并让 `backend/app/api/routes/ai_admin.py:376-377` 的「配置变更 + 审计」失去同事务原子性（审计约定见 `.qoder/backend/app/services/audit_service.py.md` §7.2）。
2. **禁止改 `get_value` 的 `None` 语义**：两个调用方都以「`None` 或空串 = 未配置」判回退（`backend/app/services/ai_config_service.py:117`、`:141`、`:148`、`:179`、`:182`；`backend/app/services/quote_service.py:49`）。改成返回空串会让 `overridden` 标记（`:176-182`）与 env 回退同时失真。
3. **不要把 `get_value` 改成查实体**（`db.query(SystemSetting)`）：`:11` 只查一列是有意为之 —— `get_config_view` 一次请求内调用 26 次，查实体会把行挂进 identity map 并参与脏检查，与 `autoflush=False` 组合后行为更难预测。
4. **列宽 200 是硬约束**：`setting_value VARCHAR(200)`（`backend/app/models/models.py:104`、`docker/init/013_daily_quote_cycle.sql:25`）。若要支持长提示词，须**新增递增编号迁移**扩列宽并遵守 `docker/init/SQL_CONSTRAINTS.md`，**禁止修改已在生产执行过的 013**（`.qoder/README.md` §3.7）。同时须把长度校验与列宽对齐（现状冲突见 §9 第 2 条）。
5. **`updated_at` 保持 UTC naive**：不要改成 `now_beijing()` 或带时区时间，否则与 `.qoder/ARCHITECTURE.md` §4.5 的全库时间约定冲突。
6. **新增 key 时必须同步四处**：调用方的规格/白名单（`backend/app/services/ai_config_service.py:45-55` `_SPEC`、`:92-97` `_PROMPT_KEYS`/`_PROMPT_VERSION_KEY`）、必要的 env 默认（`backend/app/core/config.py`）、`.qoder/REQUIREMENTS.md` §10.2 的配置项表、以及本文件 §5.4 的 key 清单。
7. **并发写入不是安全的**：本函数是「先 SELECT 后 INSERT」，不是原子 upsert。现状只有管理端两个写入口（单人操作），风险低；若未来出现批量/并发写同 key 的场景，需改为数据库级 upsert 或捕获 `IntegrityError` 重试，**不要只在调用方加锁**（多进程部署下无效）。
8. **敏感信息**：`system_settings` 的值会被管理端读取回传（`get_config_view` 的 `prompts`/`values` 字段）。**禁止把 API Key、Token、密码、AppSecret、数据库连接串写入该表**；AI 上游密钥只走服务端 env（`backend/app/services/ai_config_service.py:5-6` docstring 明示「绝不读取或下发 CloudBase API Key、JWT 等任何密钥」；`.qoder/README.md` §3.14）。

## 9. 当前实现状态

**已实现**
- `get_value` / `set_value` 两个函数，覆盖当前在用的 **14 个 setting_key**（1 个寄语 + 13 个 AI），是全后端唯一的 `system_settings` 读写通道（§2 的 grep 结论）。
- 「不提交、调用方 commit」约定成立，且两个调用方都已落实提交（`backend/app/services/quote_service.py:56`；`backend/app/api/routes/ai_admin.py:377`）。
- 读路径已被自动化测试覆盖：S17 C01/C11/C12/C13 走 `GET/PUT /api/admin/quotes/cycle`（`backend/test/s17_quote_cycle_import.py:108`、`:246`、`:255`），S26 C01/C02/C03/C04 走 `GET/PATCH /api/admin/ai/config`（`backend/test/s26_ai_center.py:249-287`）。写路径的 **INSERT 支与 UPDATE 支都被覆盖**：S17 在 SQLite 空库上首次 `set_start` 走 INSERT（`backend/test/s17_quote_cycle_import.py:189`），后续 4 次（`:198`、`:219`、`:228`、`:233`）走 UPDATE。

**存在的问题（均为代码级事实，附依据）**
1. **`set_value` 非原子 upsert**：`:17-19` 是「SELECT 再 INSERT」，无 `ON CONFLICT`、未捕获 `IntegrityError`。并发首次写同一 key 时后提交方撞主键 → 500。现状风险低（仅两个管理端写入口，且均为单人操作），但代码层面确实无保护。
2. **本函数是「提示词长度超列宽 → 500」问题的最终写库点**：`ai_config_service.PROMPT_MAX_LEN = 4000`（`:18`，校验在 `:211-212`）允许 4000 字，而 `setting_value` 是 `VARCHAR(200)`。内置默认提示词本身就已超宽（chat 348 字 / 960 UTF-8 字节，quiz 214 字 / 592 字节，route 189 字 / 525 字节，长度由 `_DEFAULT_PROMPTS`（`backend/app/services/ai_config_service.py:60-91`）实测字符数得出），管理端把默认文本原样回写即触发。该问题已由 `.qoder/backend/app/services/ai_config_service.py.md` §9 第 1 条在开发库 openGauss 7.0.0-RC3 上实测确认：抛 `psycopg2.errors.StringDataRightTruncation` → 非 `ValueError` → `backend/app/api/routes/ai_admin.py:378-380` 不捕获 → **HTTP 500**，且 `db.flush()`（`:223`）导致同批次运行参数变更一起丢弃。冒烟 C02/C03（`backend/test/s26_ai_center.py:258-277`）只写运行参数与 8 字版本号 `"v2-test"`，**未覆盖长提示词写库**；且 S26 跑在 SQLite + `Base.metadata.create_all`（`:42`、`:237`）上，SQLite 不强制 VARCHAR 长度，故该缺陷在冒烟中不可见。**修复口径（扩列宽 vs 收紧 `PROMPT_MAX_LEN` vs 在本文件加长度校验）待确认** —— 按分层，长度校验应留在调用方，本文件保持无校验。
3. **`updated_at` 存在两种时间来源**：本文件写 UTC naive（`:19`、`:22`），迁移种子走 DDL 默认 `CURRENT_TIMESTAMP`（`docker/init/013_daily_quote_cycle.sql:26`、`:30-33`）即数据库本地时间。同一列混用两种口径，按 `updated_at` 排序/比对时会有最多 8 小时偏差。当前无代码读取该列（全仓 grep 未发现读取点），影响面为零，属事实性记录。
4. **未复用 `helpers.now_utc()`**：`:2` 直接 import 标准库 `datetime`，与 `backend/app/core/helpers.py:12-14` 重复表达同一语义（行为等价，`.qoder/backend/app/services/ai_config_service.py.md` §8 亦记录了这一点）。按根 `agents.md` §2.2「重复出现的相似逻辑应抽取公共实现」属可收敛点，是否收敛待确认。
5. **无缓存，读放大明显**：`GET /api/admin/ai/config` 一次请求触发 **26 条单行 SELECT**（`get_effective` 9 次 `:116` + `get_prompt` 3 次 `:140` + `get_prompt_version` 1 次 `:147` + `overridden` 13 次 `:179`/`:182`）；每次 AI 对话触发 9~10 条（`backend/app/services/ai_chat_service.py:192`、`:235`）。均为主键等值查询、单行返回，但条数与 key 数量线性相关。是否需要请求级缓存 —— 待确认。
6. **寄语循环起始日期的修改不写审计**（§7.5）—— 是否为有意取舍待确认。

**待开发**：无（本文件功能完整，无 TODO、无占位分支）。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/setting_service.py`（**仅 1 个提交**）与 `docs/迭代记录.md` 对应条目。`git show --stat d6acf7e` 显示本文件「22 ++」（新增 22 行），与当前全文 22 行一致 —— 即**自创建以来内容零变更**。

### 2026-10-11
- 需求：每日寄语从「按日期固定绑定」改为「排序号 + 启用状态按天循环展示」，循环起始日期需管理端可改、重启不丢（需求出处记为「需求 §16、V1.1 功能二」，见 `backend/app/services/quote_service.py:1`；对应需求文档在仓库内未找到 —— 待确认）。
- 修改内容：`d6acf7e` 新建本文件（22 行），提供 `get_value`（只查 `setting_value` 单列，缺失返回 `None`）与 `set_value`（SELECT 后分支 INSERT / UPDATE，两支均显式写 `updated_at=datetime.utcnow()`，**不提交**）。同批新建 `system_settings` 表并种入 `quote_cycle_start`（`docker/init/013_daily_quote_cycle.sql:23-33`）、改写 `quote_service` 循环算法、新增 `GET/PUT /api/admin/quotes/cycle`。该提交的完整范围（引自 `docs/迭代记录.md` `d6acf7e` 条目「内容」）还包括：寄语删除 `date` 列、新增 `GET /api/admin/quotes/import-template` 与 `POST /api/admin/quotes/import-preview|import-confirm`（复用题库导入框架：预览令牌、≤2MB/≤500 行、公式注入拦截、整批事务）、admin 抽出通用组件 `ExcelImportDialog`、删除 `p2_quotes.py` 并新增 `test/s17_quote_cycle_import.py`。
- 关联文件：`backend/app/services/quote_service.py`（`:16`、`:18`、`:49`、`:55-56`）、`backend/app/models/models.py:98-105`、`docker/init/013_daily_quote_cycle.sql`、`backend/app/api/routes/admin.py:558-579`、`backend/app/api/routes/quotes.py:17-20`、`admin/src/views/QuotesView.vue`、`admin/src/api/admin.ts:732-738`、`backend/test/s17_quote_cycle_import.py`。
- 测试结果：引自 `docs/迭代记录.md` `d6acf7e` 条目「验证」字段原文 ——「S17 13/13，S12 11/11，admin `npm run build` 通过。浏览器验收通过（新起后端 8011 + admin 5174）：今日位置计算、模板下载、错误导入与错误报告、重新选择文件、确认导入、行内启停、修改起始日期、编辑、删除、题库导入回归。迁移 013 已应用到本地 openGauss。」其中与本文件直接相关的是「修改起始日期」（走 `set_value`）与「今日位置计算」（走 `get_value`）。仓库内留存的结果文件 `backend/test/s17-quote-cycle-results.json` 现为 13 条、`ok` 全为 `true`（本次建档复核）。

### 后续间接扩展（未改动本文件，仅新增调用方，供追溯）
| 日期 | 提交 | 变化 | `docs/迭代记录.md` 记载的验证 |
|---|---|---|---|
| 2026-10-17 | `1600074` | 新建 `backend/app/services/ai_config_service.py`（`:14` import 本模块），把 13 个 `ai_*` key 接入本文件：读 `get_value` 5 处（`:116`、`:140`、`:147`、`:179`、`:182`）、写 `set_value` 4 处（`:200`、`:208`、`:213`、`:218`）；新增 `GET/PATCH /api/admin/ai/config`（菜单码 `ai_config`）。**本文件内容零变更。** | 「冒烟 `test/s26_ai_center.py` 47/47（含真实 Agent 调用 L01：reply 143 字、usedTokens=19715；空来源场景模型拒答不编造）；真库校验——迁移应用/表索引菜单齐备/ORM 与真库列 ALL_MATCH/JSON round-trip 后回滚、真库真实 Agent 对话一次（reply 194 字、usedTokens=431）；报告 `backend/test/docs/s26-ai-center-report.md`」（原文摘引）。仓库内 `backend/test/s26-ai-center-results.json` 现为 47 条、`ok` 全为 `true`（本次建档复核）。 |

> 建档时新增的实测/复核结论（非上述提交记载）：①§9 第 2 条的列宽冲突已由 `.qoder/backend/app/services/ai_config_service.py.md` §9 第 1 条在开发库实测确认，本文档仅做文件级归位；②内置默认提示词字符数/字节数为本次建档实算（chat 348/960、quiz 214/592、route 189/525）；③`GET /api/admin/ai/config` 的 26 条 SELECT 为按调用点逐条清点得出，未做 SQL 抓包 —— 待确认（如需精确值应开启 `echo=True` 实测）。
