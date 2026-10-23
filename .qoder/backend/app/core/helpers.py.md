# helpers.py

## 1. 文件路径

`backend/app/core/helpers.py`（58 行）

## 2. 文件职责

后端全局的**时间与日期口径唯一来源**，外加一个仅供开发兜底的伪随机步数生成器。它解决两个问题：①「库内存 UTC naive、业务按北京时间自然日切分」这套双口径换算在所有 service / schema 中必须一致；②Windows 无 tzdata，不能用 `zoneinfo`，需要一个不依赖服务器本地时区的固定 UTC+8 常量。

模块 docstring（`:1-5`）明确写出这两条设计前提。

## 3. 业务需求

- **每日步数 / 每日一题 / 每日积分 / 每日寄语**都以「自然日」为粒度，自然日必须是**北京时间**的日，不能是服务器本地日（生产为 Ubuntu，本地时区未确认；开发为 Windows，本地时区 UTC+8）。
- **活动时间控制（V2.0 需求一）**：活动起止时间由管理员按北京时间录入，与库内 UTC 存储列比较前必须换算 —— 提交 `ce14a95` 因此把本文件从「依赖服务器本地时区」改造为「固定 UTC+8」。
- **模拟步数**：迁移自小程序 `frontend/utils/util.js` 的 `seededSteps`，用于开发期无微信运动数据时给出稳定可复现的步数。提交 `3df3fd0` 之后其用途被严格收窄为开发兜底（见 §7）。

## 4. 核心功能

| 位置 | 名称 | 说明 |
|---|---|---|
| `:9` | `BEIJING_TZ` | `timezone(timedelta(hours=8))`，固定偏移常量；docstring `:3-4` 说明「用固定偏移而非 zoneinfo」的原因是 Windows 无 tzdata |
| `:12-14` | `now_utc()` | 返回 `datetime.utcnow()`，即**当前 UTC naive**，与库内时间列同口径 |
| `:17-19` | `now_beijing()` | `datetime.now(BEIJING_TZ).replace(tzinfo=None)`，返回**当前北京时间 naive** |
| `:22-24` | `today_str()` | `now_beijing().strftime("%Y-%m-%d")`，业务自然日字符串 |
| `:27-30` | `recent_dates(n)` | 以 `now_beijing().date()` 为终点，返回**含今天、从旧到新**的 n 个 `YYYY-MM-DD`；`range(n-1, -1, -1)` 保证顺序 |
| `:33-37` | `to_local(dt)` | 库内 UTC naive → 北京时间 naive；`None` 透传（`:35-36`）；实现为先贴 `timezone.utc` 再 `astimezone(BEIJING_TZ)` 再脱掉 tzinfo |
| `:40-44` | `local_to_utc(dt)` | 北京时间 → UTC naive；入参 naive 时按北京时间解释（`:42-43`），入参带 tzinfo 时直接换算，故两种入参都可用 |
| `:47-58` | `seeded_steps(date_str, user_id)` | 以 `f"{date_str}|{user_id}"` 为 key，逐字符做 `seed = (seed * 31 + ord(ch)) % 100000`（`:54-57`），返回 `4000 + (seed % 9000)`（`:58`），即 **[4000, 12999] 闭区间**内的稳定伪随机整数 |

**边界行为**（由代码直接决定，非推测）：

- `recent_dates(0)` 返回 `[]`（`range(-1, -1, -1)` 为空）；`recent_dates` 不接受负数的显式校验，负数同样返回 `[]`。
- `to_local` / `local_to_utc` **不做四舍五入、不截断微秒**，只做时区平移。
- `seeded_steps` 对同一 `(date_str, user_id)` 恒定同值，与调用次数、进程、机器无关（纯字符串哈希，无 `random` / `time` 参与）。

## 5. 输入与输出

| 函数 | 入参 | 返回 | 异常 |
|---|---|---|---|
| `now_utc` | 无 | `datetime`（UTC naive） | 无 |
| `now_beijing` | 无 | `datetime`（北京时间 naive） | 无 |
| `today_str` | 无 | `str`，`YYYY-MM-DD` | 无 |
| `recent_dates` | `n: int` | `List[str]`，长度 = `max(n, 0)` | 无 |
| `to_local` | `Optional[datetime]` | `Optional[datetime]`；`None` 入参返回 `None` | 入参若**已带 tzinfo**，`:37` 的 `replace(tzinfo=timezone.utc)` 会**覆盖**原时区（按 UTC 重新解释），不报错但语义可能与调用方预期不符 |
| `local_to_utc` | `datetime`（**不接受 None**） | `datetime`（UTC naive） | 入参为 `None` 时 `:42` 的 `dt.tzinfo` 抛 `AttributeError`；调用方须自行判空（现有调用方均如此，例如 `schemas.py:910`、`activity_service.py:164-165`） |
| `seeded_steps` | `date_str: str`、`user_id: int` | `int`，4000–12999 | 无 |

本文件是**纯工具模块**：不定义 HTTP 路由、不返回错误码、不接触数据库、不抛业务异常。

## 6. 依赖关系

**上游依赖**：仅标准库 `datetime`（`:6`）与 `typing`（`:7`）。**不 import 项目内任何模块**，符合 `backend/AGENTS.md` §3.1「core 不 import 业务模块」。

**被谁依赖**（以下为 `grep -rn "<名称>(" backend/app` 实测的**全部**调用点，路径相对 `backend/`；`schemas.py:14`、`admin.py:20`、`quotes.py:12` 等为 import 行）：

| 导出名 | 生产代码调用点（全量） |
|---|---|
| `BEIJING_TZ` | 2 处：`app/services/activity_service.py:73`（把 UTC naive 还原为带时区的北京时间）、`app/services/sport_service.py:95`（把微信 `stepInfoList` 的秒级时间戳按北京时间归日） |
| `now_utc` | 17 处：`activity_service.py:54`、`:79`、`:134`、`:180`、`:197`；`ai_chat_service.py:292`（`finalize_message` 刷新会话 `updated_at`）；`ai_knowledge_service.py:146`、`:162`、`:164`、`:178`、`:180`；`ai_question_service.py:501`、`:509`、`:532`、`:630`、`:686`；`sport_service.py:129` |
| `now_beijing` | 3 处：本文件内部 `:24`（`today_str`）、`:29`（`recent_dates`）；`app/services/streak_service.py:42`（连续行军天数游标） |
| `today_str` | 16 处：`app/api/routes/admin.py:565`、`:579`；`app/api/routes/quotes.py:20`；`ai_usage_service.py:26`、`:67`；`broadcast_service.py:46`；`dashboard_service.py:54`；`org_service.py:190`；`points_service.py:188`；`quiz_service.py:333`、`:352`、`:392`、`:531`；`sport_service.py:147`、`:212`、`:332` |
| `recent_dates` | 4 处：`dashboard_service.py:105`（趋势图日期轴）；`sport_service.py:101`（模拟步数覆盖最近 7 日）、`:148`（同步后核对的期望日期集合）、`:320`（历史步数查询） |
| `to_local` | 10 处：`activity_service.py:73`、`:146`、`:147`；`admin_service.py:430`（CSV 导出时间格式化）；`dashboard_service.py:127`、`:133`；`march_service.py:291`、`:305`；`profile_service.py:74`；`sport_service.py:283` |
| `local_to_utc` | 8 处：`app/schemas/schemas.py:910`；`access_service.py:415`；`activity_service.py:164`、`:165`；`broadcast_service.py:69`；`dashboard_service.py:123`；`sport_service.py:275`、`:276` |
| `seeded_steps` | **唯一调用点** `sport_service.py:101` |

**测试脚本调用点**（按 `.qoder/README.md` §4 不逐个建档）：`test/s17_quote_cycle_import.py:41`、`s18_quiz_submit_feedback.py:48`、`s20_v2_regression.py:58`、`s22_history_sync_quiz_rotation.py:18`、`s23_walk_sync_recalc.py:37`、`s24_walk_recalc_pg.py:26`、`s26_ai_center.py:48`。

**不涉及的数据库表**：本文件不做任何查询。它的输出被用于 `daily_sport.date`、`daily_questions.date`、`points_log.biz_key`、`user_event.event_time`、`ai_usage_logs.day_key` 等列的取值与比较（列语义见 `models/models.py:687` 的注释，其中直接点名 `helpers.today_str`）。

> **文档滞后提示**：`.qoder/ARCHITECTURE.md` §4.5 的时间约定表把本文件写作 `services/helpers.py:9`、`:12-14`、`:22-24`。`backend/app/services/` 下**不存在** `helpers.py`（实测目录列表），正确路径是 `backend/app/core/helpers.py`；所引行号 `:9`（`BEIJING_TZ`）、`:12-14`（`now_utc`）、`:22-24`（`today_str`）与当前文件一致，仅目录名有误。

## 7. 业务规则

1. **业务自然日 = 北京时间日**。`today_str()` / `recent_dates()` 是每日步数、每日一题、每日积分、每日寄语、AI 日用量的日切分口径，全部走 `now_beijing()`，**不得改回 `datetime.now()`**（提交 `ce14a95` 的整改项）。
2. **库内时间列 = UTC naive**。写入用 `now_utc()`，读出展示用 `to_local()`，与库内列比较用 `local_to_utc()`。三者构成闭环，缺一即产生 8 小时错位（提交 `18c2121` 修的正是这个缺陷）。
3. **`to_local` / `local_to_utc` 互为逆运算**，但仅在「naive + 约定时区」前提下成立；对已带 tzinfo 的入参，`to_local` 会覆盖其时区（见 §5 异常列）。
4. **`seeded_steps` 只能用于开发兜底**。docstring `:51-52` 与 `sport_service.py:7`、`:82-83` 三处一致规定：仅「mock 登录用户（`openid.startswith("mock_")`）或未配置微信凭证」时由 `/api/sport/sync` 回退使用；**真实微信用户步数一律来自 `wx.getWeRunData` 解密，真实用户缺数据抛 `ValueError`→400，绝不写编造步数**（`sport_service.py:100-102`）。此规则源于一次真实生产事故：提交 `3df3fd0` 之前后端对无参 `/sport/sync` 一律编造 4000~12999 假步数并覆盖用户真实步数，经用户确认删除了当天 5 条模拟记录（`docs/迭代记录.md` 2026-10-10 条目）。
5. **`seeded_steps` 的值域与算法是前后端契约**：小程序 `utils/util.js` 的 `seededSteps` 使用同一算法，改动哈希或值域会造成两端模拟数据不一致。

## 8. 修改约束

- **不得引入 `zoneinfo` / `pytz` 依赖**替换 `BEIJING_TZ`：docstring `:3-4` 明确 Windows 无 tzdata 是选型原因；改为 `zoneinfo` 会让开发机（Windows）启动失败或行为与生产不一致。
- **不得改变 `today_str()` 的返回格式**：`YYYY-MM-DD` 字符串直接落库为 `daily_sport.date`、`daily_questions.date` 等列值，且是 `points_log.biz_key`（`walk:{日期}` / `quiz:{日期}`）的组成部分，改格式即等于全量历史数据失配。
- **`to_local` 的 `None` 透传分支（`:35-36`）当前无生产调用方依赖**：全部 10 处调用点均在调用前自行判空（`activity_service.py:73`/`:146`/`:147`、`admin_service.py:430`、`march_service.py:291`/`:305` 用条件表达式或推导式过滤；`dashboard_service.py:127`/`:133`、`sport_service.py:283` 的入参来自已过滤的查询；`profile_service.py:72-73` 有显式 `is None` 分支）。删除该分支不会立即报错，但会让签名 `Optional[datetime] -> Optional[datetime]` 与实现不符 —— 保留或删除须同步改类型注解。
- **不得把 `local_to_utc` 改成接受 `None`** 之外还要同时改调用方语义：当前 8 处调用方均自行判空（如 `schemas.py:910` 的 `if value is not None`），签名变更需同步核对全部调用点。
- **`core` 层禁止 import 业务模块**（`backend/AGENTS.md` §3.1），本文件当前只依赖标准库，新增函数须保持这一点。
- **`seeded_steps` 不得被真实用户路径调用**：新增步数写入路径时必须先确认 openid 来源。

## 9. 当前实现状态

**已实现**：

- 北京时间口径的 4 个日期函数（`now_beijing` / `today_str` / `recent_dates` / `BEIJING_TZ`）与 UTC 口径的 `now_utc`，全部有真实生产调用点。
- UTC ↔ 北京时间双向换算 `to_local` / `local_to_utc`，被 schemas、6 个 service 使用。
- `seeded_steps` 开发兜底，唯一调用点 `sport_service.py:101`。
- 全部 8 个导出名（含 `BEIJING_TZ`）**均有真实调用者**，无死代码。

**存在问题 / 技术债**：

1. **`now_utc()` 并非全项目统一的 UTC 时间入口**。`backend/app/` 下仍有 **23 处**直接调用 `datetime.utcnow()`（不含 `helpers.py:14` 自身），分布：`services/invite_service.py` 4 处、`services/quiz_service.py` 3 处、`services/import_service.py` 3 处、`services/auth_service.py` 3 处、`services/setting_service.py` 2 处、`services/access_service.py` 2 处、`services/points_service.py` / `march_service.py` / `identity_service.py` / `event_service.py` 各 1 处、`core/ws.py:20` 1 处、`api/routes/admin.py` 1 处。行为等价（同为 UTC naive），但口径未收敛，属一致性技术债，**不影响功能**。
2. **`datetime.utcnow()` 在 Python 3.12+ 已被标记弃用**（DeprecationWarning）。本文件 `:14` 直接使用该 API，未来升级 Python 时需统一改为 `datetime.now(timezone.utc).replace(tzinfo=None)`。**当前项目 Python 版本要求未在仓库内声明**（`requirements.txt` 未固定 Python 版本），是否有实际影响**待确认**。
3. **`local_to_utc` 不接受 `None`**，与 `to_local` 的 `None` 透传形成不对称契约，新增调用方易踩 `AttributeError`。属设计取舍，非缺陷。
4. **调用方 `profile_service.py:75` 存在口径混用**：`_join_days` 在 `:74` 用 `to_local(created_at).date()`（北京时间）取注册日，却在 `:75` 用 `datetime.now().date()`（**服务器本地时区**）取今日，两者相减得「加入天数」。若服务器本地时区非 UTC+8，北京时间 00:00–08:00 期间会算出偏差 1 天的结果。生产服务器时区**待确认**（`docs/迭代记录.md` 2026-10-13 条目仅记「已原生部署到 Ubuntu」，未记时区），故实际影响**待确认**。正确写法应为 `now_beijing().date()`。**本条为调用方问题，不属本文件缺陷，登记于此以便一并整改。**

**待开发**：无。本文件无规划中的未完成能力。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/core/helpers.py`（4 条提交，全部列出），验证结论对照 `docs/迭代记录.md`。

### 2026-10-22（仅文档校正）

- 需求：补齐 AI 栈文档欠账。**本次源码未改（`backend/app/core/helpers.py` 仍为 58 行、8 个导出名一字未动），属补 `c660727`（LLM 上游由腾讯云 CloudBase Agent 迁至阿里云百炼，`cloudbase_service.py` → `llm_service.py`）与 `6a4dbb7`（AI 对话改真流式 SSE，`ai_chat_service` 拆出 `prepare_message`/`finalize_message`/`discard_message`）的文档欠账**——这两次提交让本文档 §6 中记录的**调用方行号**整体失效。
- 修改内容（**未改任何源码/配置/测试**）：
  - §6「被谁依赖」表 `now_utc` 行：`ai_chat_service.py:257` → **`:292`**（现位于 `finalize_message` 内刷新 `ai_conversations.updated_at`；改造前位于 `send_message`）；`ai_question_service.py:497`/`:505`/`:528`/`:626`/`:682` → **`:501`/`:509`/`:532`/`:630`/`:686`**（该文件因提示词规则新增而整体下移 4 行）。调用点总数仍为 **17 处**，`ai_knowledge_service.py` 五处行号未变。
  - §6 末「不涉及的数据库表」段：`ai_usage_logs.day_key` 的列语义注释由 `models/models.py:664` → **`:687`**（`AiUsageLog` docstring 在 `b712d81` 中重写，`models.py` 由 684 行增至 709 行；**表结构与列本身零变化**）。
  - 其余章节（§1~§5、§7~§9）经核对**无需改动**：本文件不 import 任何业务模块、不感知上游供应商，因此 `c660727`/`b712d81` 的 `CLOUDBASE_*` → `LLM_*` 更名与本文件无关；§6 中 `today_str` / `recent_dates` / `to_local` / `local_to_utc` / `seeded_steps` 的调用点均未受这几次提交影响。
- 关联文件（仅为其行号的来源，均未修改）：`backend/app/services/ai_chat_service.py`、`backend/app/services/ai_question_service.py`、`backend/app/models/models.py`。同批修订的文档：`.qoder/backend/app/services/ai_chat_service.py.md`、`ai_question_service.py.md`、`ai_usage_service.py.md`、`ai_config_service.py.md`、`setting_service.py.md`、`.qoder/backend/app/models/models.py.md`。
- 测试结果：**本次为纯文档改动，按任务约束未执行任何测试、未跑校验脚本**。文中行号均以 `grep -n` 实测当前源码为准（`now_utc()` 调用点、`models.py` 的 `today_str` 注释行）。

### 2026-10-13

- 需求：V2.0 需求一「活动时间控制」—— 活动起止时间按北京时间录入与判定，业务日期不得再依赖服务器本地时区。
- 修改内容：提交 `ce14a95`。模块 docstring 增补时区口径说明；新增 `BEIJING_TZ`（`:9`）、`now_utc()`（`:12-14`）、`now_beijing()`（`:17-19`）；`today_str()` 与 `recent_dates()` 的基准由 `datetime.now()` 改为 `now_beijing()`；`to_local()` 的 `astimezone()`（无参、按本地时区）改为 `astimezone(BEIJING_TZ)`；`local_to_utc()` 增补 naive 入参按北京时间解释的分支（`:42-43`）。文件由 46 行增至 58 行（当前版本）。
- 关联文件：`app/services/activity_service.py`（新增，本文件的主要消费方）、`app/api/routes/activity.py`、`app/api/deps.py`、`docker/init/016_activity_settings.sql`。
- 测试结果：TestClient 冒烟通过（默认状态、时间格式错误 422、开始晚于结束 400、未发布/已结束时写接口 403、结束后可查看与不可查看两种配置、无 Token 仍 401）；`s19_invite_admission.py` 回归 25/25 通过。（来源：`docs/迭代记录.md` 2026-10-13「V2.0 需求一：活动时间控制（后端）」）

### 2026-10-10

- 需求：修复「用户实际没走 9000 步，同步后当天却写入约 9000 步」—— 后端对无参 `/sport/sync` 一律用 `seeded_steps` 编造假步数落库。
- 修改内容：提交 `3df3fd0`。**本文件仅改 `seeded_steps` 的 docstring**（`:50-52`），把用途从「未接入真实微信运动数据时模拟每日步数」收窄为「仅开发模式兜底：mock 登录用户或未配置微信凭证时由 `/sport/sync` 回退使用；真实微信用户步数一律来自 `wx.getWeRunData` 解密，不得使用本函数编造」。**算法与值域未变**。
- 关联文件：`app/core/wx.py`（新增）、`app/services/sport_service.py`（`_resolve_steps` 改为解密优先、真实用户缺数据抛 `ValueError`）、`frontend/services/sport.js`、`frontend/pages/home/home.wxml`。
- 测试结果：S11 后端冒烟 8/8（`test/s11_sport_sync_werun.py`）；e2e 全链路 178/178 回归；小程序 automator 验收 4/4。真机（已开通微信运动设备）端到端回归当时记为「待用户确认」。（来源：`docs/迭代记录.md` 2026-10-10 条目）

### 2026-10-02

- 需求：新增小程序聚合接口（档案 / 足迹 / 日历 / 播报 / 知识画像）时，发现库内 UTC 存储时间与本地业务日期错位（日历点亮归格错误、今日点亮数错误、加入天数错误）。
- 修改内容：提交 `18c2121`。新增 `to_local()` 与 `local_to_utc()`（当时的实现依赖服务器本地时区：`astimezone()` 无参形式）；`import` 增补 `timezone` 与 `Optional`。文件由 27 行增至 46 行。
- 关联文件：`app/api/routes/profile.py`、`broadcast.py`（新增）、`app/services/dashboard_service.py`、`profile_service.py`、`march_service.py`、`app/schemas/schemas.py`。
- 测试结果：S3 冒烟 15/15 通过（`test/s3_aggregates.py` + 验收报告）。（来源：提交信息正文）

### 2026-09-30

- 需求：项目初始化，把小程序 `frontend/utils/util.js` 的日期与模拟步数工具迁移到后端。
- 修改内容：提交 `a94e685`（`feat: init`）。新建文件，27 行，含 `today_str()`（当时为 `datetime.now().strftime(...)`，即服务器本地日）、`recent_dates()`、`seeded_steps()` 三个函数。
- 关联文件：`app/services/sport_service.py`、`app/services/quiz_service.py`、`app/services/points_service.py` 等初始 service。
- 测试结果：待确认（`docs/迭代记录.md` 该条目仅记「仓库初始代码」，无验证结论）。
