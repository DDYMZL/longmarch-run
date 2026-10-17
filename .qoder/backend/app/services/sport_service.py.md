# sport_service.py

## 1. 文件路径
`backend/app/services/sport_service.py`（342 行）

## 2. 文件职责
运动数据的**唯一写入与读取入口**：把微信运动（或开发模式模拟）的每日步数按 `user + date` 落到 `daily_sport` 表，同事务内按运动源数据全量核对修复步行积分台账，提交后触发连续行军维护与业务事件，并对外提供今日概况、行军日历、最近 N 天记录三个只读聚合（`backend/app/services/sport_service.py:1-13`）。

本文件是全项目唯一写 `daily_sport` **步数与同步元数据**的模块——在 `backend/app/` 下 grep `DailySport(`，除模型类定义 `backend/app/models/models.py:231` 外只命中 `backend/app/services/sport_service.py:121`；对已有行的 `record.steps =` / `record.distance =` 赋值也只出现在 `:126-127`。`daily_sport` 的**另一处写入**是 `streak_service.on_sport_written` 维护 `is_goal_completed`（`backend/app/services/streak_service.py:80`），由本文件 `:59` 在提交后调用。其余 10 个引用 `DailySport` 的模块（`march_service`、`broadcast_service`、`profile_service`、`points_service`、`rank_service`、`admin_service`、`org_service`、`dashboard_service`、`medal_service`、`streak_service` 的只读部分）一律只读该表。

## 3. 业务需求
- **微信运动步数同步（需求 §3.1）**：授权 `scope.werun` → `wx.login` 取 code → `wx.getWeRunData` 取加密数据上送，后端 `code2Session` 换 `session_key` 解密 `stepInfoList`，按**北京时间**归入自然日，逐日**覆盖**（非累加）。规则清单见 `.qoder/REQUIREMENTS.md` §3.1（该表 `:148-149` 两行已滞后，见 §9）。
- **近 7 日补录与结余积分（`6f2cfc3`，2026-10-15）**：缺失日期不写 0、不覆盖已有记录，作为 `failed_dates` 返回并允许后续重试（docstring `:145`）；步行积分按累计结余口径重算（`.qoder/backend/app/services/points_service.py.md` §4）。
- **今日目标 20000 步（`9c8f13f`，2026-10-15）**：`DAILY_TARGET = 20000`（`:27`），仅展示用，与「连续行军达标门槛 5000 步」（`settings.STREAK_GOAL_STEPS`，`backend/app/core/config.py:95`）是两个独立口径（`.qoder/REQUIREMENTS.md` §3.2「今日目标步数」行）。
- **行军日历（功能 3）**：整月逐日步数档位 + 答题/点亮标记 + 月度统计（`:245-315`）。
- **杜绝编造步数（`3df3fd0`，2026-10-10）**：真实用户未携带微信数据一律 400 不写库（docstring `:7`、`:83`、`:102`）。
- **V2.0 积分口径（`2f3f333` / `83d3552`）**：同步后按运动源数据全量重算步行台账，保证「累计步行积分 = 累计计分步数 // 1000」、重复同步幂等（docstring `:4-5`）。
- 路由层契约（路径/方法/权限/错误码/`response_model`）见 `.qoder/backend/app/api/routes/sport.py.md`，本文不复制。

## 4. 核心功能

### 4.1 模块常量
| 常量 | 行号 | 值 | 说明 |
|---|---|---|---|
| `DAILY_TARGET` | `:27` | `20000` | 今日目标步数，**仅 `get_today` 的 `target` 字段使用**（`:225`）。不参与任何达标判定；达标门槛是 `settings.STREAK_GOAL_STEPS`。`9c8f13f` 由 10000 改为 20000 |
| `TOTAL_MILESTONES` | `:28` | `[(100000, "TOTAL_STEPS_100000"), (500000, "TOTAL_STEPS_500000")]` | 累计步数里程碑阈值 → 事件类型，仅 `_after_written:65-67` 使用 |

两个常量在 `backend/app/` 下**无外部消费方**（grep 只命中本文件）。前端另有同名常量 `DAILY_TARGET = 20000`（`frontend/services/sport.js:13`），在 `getToday()` 服务边界**强制覆盖后端下发的 `target`**（`frontend/services/sport.js:113`），以防线上旧后端仍返回 10000（`docs/迭代记录.md` 的 `aa7dd82` 条目）。

### 4.2 `get_total_steps(db, user_id) -> int`（`:31-38`）
库内聚合 `coalesce(sum(daily_sport.steps), 0)`，无日期过滤、无单日上限，`:38` `int(total or 0)` 收敛（openGauss 的 `sum(Integer)` 返回 `bigint`，SQLite 返回 `int`，均安全）。这是**全项目累计步数的唯一口径**（`.qoder/REQUIREMENTS.md` §6.1「累计步数来源」行），`f59892e` 起统一由本函数提供（此前 `march_service` 内有各自的 `_total_steps`）。

调用方：`backend/app/services/march_service.py:193`、`:365`；本文件 `:153`、`:199`、`:226`、`:333`。

### 4.3 `_distance_of(steps) -> float`（`:41-43`）
`round(steps * settings.STRIDE_M / 1000, 2)`，即 **km = 步数 × 步长 ÷ 1000**。`STRIDE_M` 默认 `0.7`（`backend/app/core/config.py:94`，注释同式）。每次写入都重算，不做增量。

**类型注意（实测事实）**：`daily_sport.distance` 列为 `Numeric(10, 2)`（`backend/app/models/models.py:246`），写入的是 Python `float`，**读回时 psycopg2 返回 `decimal.Decimal`**（开发库实测形如 `Decimal('4.27')`）；`Mapped[float]`（`backend/app/models/models.py:246`）只是类型标注，SQLAlchemy 不做反向强制转换。本文件**从不读 `distance`**（只在 `:121`、`:127` 写），唯一读取方 `backend/app/services/profile_service.py:84` 已用 `round(float(total_distance), 2)`（`:91`）显式转换后再出参（`total_distance`，schema `backend/app/schemas/schemas.py:621`）。新增 `distance` 消费方必须自行处理 `Decimal`。

### 4.4 `_after_written(db, user_id, date, record, is_first_record, prev_record_steps, prev_total) -> int`（`:46-68`）
写入提交**之后**的统一副作用，返回「本日写入后的累计步数」供调用方串接下一日：
1. `:56-57` `is_first_record` 为真 → 写 `FIRST_STEP` 事件（`{"date", "steps"}`）。**去重依据是「该用户历史上没有任何 `daily_sport` 行」**（由调用方 `:189` 的 `created and not had_any` / `:342` 的 `created and is_first_record` 计算），不查事件表。
2. `:59` `streak_service.on_sport_written(db, user_id, date)`——维护 `is_goal_completed`、`users.continuous_days/max_continuous_days` 缓存，并在达标状态翻转时写 `DAILY_GOAL`、跨里程碑时写 `STREAK_{3,7,14,30,60}`（`backend/app/services/streak_service.py:62-103`）。**该函数内部自行 `db.commit()` 两次**（`backend/app/services/streak_service.py:81`、`:89`）。
3. `:61-62` `prev_record_steps < 10000 <= (record.steps or 0)` → 写 `STEP_10000`。**去重依据是「本日跨越 10000 的边界条件」，不查事件表**（对比第 4 步）。
4. `:64-67` `total = prev_total - prev_record_steps + (record.steps or 0)`（用增量推算避免再查一次库），逐个 `TOTAL_MILESTONES` 判断 `prev_total < threshold <= total` **且** `not event_service.has_event(...)` → 写 `TOTAL_STEPS_*`。这是本文件唯一查事件表去重的地方。
5. `:68` 返回 `total`。

`record.steps` 在 `:57`、`:61`、`:62`、`:64` 被多次读取，而调用点都在 `db.commit()` 之后（`:182` / `:340`）；`SessionLocal` 未关闭 `expire_on_commit`（默认 `True`，`backend/app/core/database.py:51`），故首次访问触发一次刷新 SELECT，之后走实例缓存。

### 4.5 `_resolve_steps(openid, code, encrypted_data, iv, date, user_id) -> Dict[str, int]`（`:71-102`）
决定本次同步的 `{日期: 步数}`（北京时间自然日）。三条互斥路径：

**(A) 真实微信路径**（`:86-99`，条件 `has_creds and code and encrypted_data and iv` 四者皆真，`has_creds = bool(settings.WX_APPID and settings.WX_SECRET)` 于 `:85` 实时读取）
- `:87` `code2session(code)`：**外部 HTTPS 调用** `GET https://api.weixin.qq.com/sns/jscode2session`，超时 5 秒（`backend/app/core/wx.py:15`、`:23-32`）。该函数**从不抛异常**：未配置凭证返回 `None`（`backend/app/core/wx.py:20-21`），任何异常（网络超时、非 JSON 响应、缺 `openid`）也返回 `None`（`:34-35`、`:41-42`）。`session_key` 不落库、不打日志（`backend/app/core/wx.py:3`）。
- `:88-89` 返回 `None` 或无 `session_key` → `raise ValueError("微信会话换取失败，请重新同步")`。
- `:90` `decrypt_werun(session_key, encrypted_data, iv)`：AES-128-CBC（pycryptodome）+ 去 PKCS#7 填充 + `json.loads`，任何失败抛 `ValueError("微信运动数据解密失败，请重新同步")`（`backend/app/core/wx.py:47-57`）；再校验 `watermark.appid == settings.WX_APPID`，不符抛 `ValueError("微信运动数据校验失败，请重新同步")`（`:58-60`）。**这是防伪造数据写库的唯一关卡**。
- `:92-96` 遍历 `payload["stepInfoList"]`，`datetime.fromtimestamp(int(ts), BEIJING_TZ).strftime("%Y-%m-%d")` 归日（`BEIJING_TZ` 见 `backend/app/core/helpers.py:9`），`step` 缺失按 0。**同一日多条时后者覆盖前者**。
- `:97-98` 解析结果为空 → `raise ValueError("微信运动本次未返回可用步数，请稍后重试")`。
- `:99` 返回。

**(B) 模拟回退路径**（`:100-101`，条件 `openid.startswith("mock_") or not has_creds`）
返回 `{day: seeded_steps(day, user_id) for day in recent_dates(7)}`——最近 7 个北京时间自然日，每日 4000~12999 的「日期+用户」稳定伪随机值（`backend/app/core/helpers.py:47-58`）。**这是唯一会写入非真实步数的路径**。

**(C) 拒绝路径**（`:102`）
`raise ValueError("未获取到微信运动数据，请在小程序内重新同步")`——真实用户（openid 非 `mock_`）在已配置凭证时未携带加密数据即走此路，绝不编造。

三条路径的 `ValueError` 全部被路由层 `backend/app/api/routes/sport.py:46-47` 捕获转 **HTTP 400**，且此时**尚未取得任何行锁、未写入任何数据**（`_resolve_steps` 在 `:149` 调用，早于 `:151` 的加锁）。

**与 `WX_LOGIN_ALLOW_MOCK` 的关系（`backend/app/core/config.py:46`，默认 `False`）**：`mock_` 前缀 openid 只由 `auth_service._mock_openid`（`backend/app/services/auth_service.py:35-38`）产生，其触发条件在 `_resolve_openid`（`:41-48`）——`code2session` 返回 `None` 时，若「已配置凭证 **且** `WX_LOGIN_ALLOW_MOCK` 为 `False`」则抛 `WxLoginError`（登录 502），否则回落 mock openid。因此：
| 凭证 | `WX_LOGIN_ALLOW_MOCK` | 登录结果 | 同步时 `_resolve_steps` 走向 |
|---|---|---|---|
| 未配置 | 任意 | mock openid | (B)（`mock_` 与 `not has_creds` 双条件均真） |
| 已配置 | `False` | 微信失败即 502，无 mock 用户 | 真实用户走 (A) 或 (C) |
| 已配置 | `True` | 微信失败时得 mock openid | 该用户若携带有效加密数据仍走 (A) 写真实步数 |

**形参 `date`（`:76）在函数体内从未被使用**：`6f2cfc3` 之前用于「必含今日」校验与单日模拟，改为「范围以微信实际返回为准」+ 近 7 日模拟后成为死参数（调用方 `:149` 仍传入）。

### 4.6 `_lock_day(db, user_id, date) -> Optional[DailySport]`（`:105-111`）
`SELECT ... WHERE user_id=? AND date=? FOR UPDATE`，取当日行并加行锁；不存在返回 `None`（**不创建**）。与 `uq_sport_user_date`（`backend/app/models/models.py:240`）配合构成并发写保护。

**注意**：`with_for_update()` 在 SQLite 上是空操作（SQLite 无 `SELECT ... FOR UPDATE`），而本项目的开发/冒烟环境支持 SQLite（`backend/app/core/database.py:46-48`）。因此**行锁只在 openGauss/PostgreSQL 上真正生效**。

### 4.7 `_upsert_day(db, user_id, date, steps, source) -> Tuple[DailySport, int, bool, bool]`（`:114-132`）
锁内按最终值**覆盖**某日记录，返回 `(record, previous, created, changed)`：
- `:118` `_lock_day`；`:119-123` 不存在则新建（含 `distance=_distance_of(steps)`，`previous = 0`）。
- `:124-127` 已存在则 `record.steps = steps`（**直接覆盖，不取 max**）、`record.distance` 同步重算。
- `:128-130` 无条件写 `source`、`synced_at = now_utc()`、`sync_status = "processed"`。
- `:131` `db.flush()`（**不 commit**）；`:132` `changed = created or previous != steps`。

`sync_status` 在本文件中**只会被写成 `"processed"`** 这一个值（`:130`），失败日期通过返回体的 `failed_dates` 表达、不落列（列定义 `backend/app/models/models.py:252`，默认值同为 `"processed"`；`source`/`synced_at`/`sync_status` 三列由 `docker/init/019_sport_backfill_carry.sql:8-10` 新增，各列语义见该文件 `:5-6` 的注释）。`is_makeup` / `makeup_at`（`backend/app/models/models.py:248-249`）**全仓无任何读写点**，属预留死字段（`.qoder/REQUIREMENTS.md` §3.3「补签（待开发）」段）。

### 4.8 `sync_today(db, user_id, openid="", code=None, encrypted_data=None, iv=None) -> Dict`（`:135-207`）
唯一的运动数据写入主流程，**11 步**：

| 步骤 | 行号 | 动作 | 事务/锁 |
|---|---|---|---|
| 1 | `:147` | `date = today_str()`（北京时间） | — |
| 2 | `:148` | `expected_dates = recent_dates(7)`（从旧到新） | — |
| 3 | `:149` | `_resolve_steps(...)`（含外部 HTTP） | **加锁前**，失败即 400 且零写入 |
| 4 | `:150` | `source = "mock" if openid.startswith("mock_") or not (WX_APPID and WX_SECRET) else "werun"` | — |
| 5 | `:151` | `db.query(User.id).filter(id==user_id).with_for_update().first()` | **取 `users` 行锁**，串行化同一用户的并发写 |
| 6 | `:152-154` | `before_points`、`prev_total_steps`、`had_any`（该用户是否已有任何 `daily_sport` 行） | 锁内读 |
| 7 | `:156-161` | 构造 `failed`：`expected_dates` 中不在 `steps_by_date` 的日期，理由固定「微信运动本次未返回该日数据，可稍后重试」 | — |
| 8 | `:162-177` | 按 `expected_dates` 从旧到新逐日：缺失跳过；`int()` 失败 → `failed` 追加「步数格式无效」；`value < 0` → `failed` 追加「步数无效」；否则 `_upsert_day`，进 `processed`，若 `changed` 再进 `written` | 锁内 flush |
| 9 | `:179-180` | `if processed: points_service.recompute_walk(db, user_id)` | **同一事务内**全量修复步行台账（该函数 docstring 明确「调用方需已串行化该用户写入并负责提交」，`backend/app/services/points_service.py:101`） |
| 10 | `:181-185` | `db.commit()`；`IntegrityError` → `db.rollback()` → `raise ValueError("步数同步冲突，请稍后重试")` | **事务边界**；`IntegrityError` 来源为 `uq_sport_user_date` 并发首写 |
| 11 | `:187-207` | 提交后：按 `written` 从旧到新逐日 `_after_written`（`:188-190`，`had_any` 首轮后置 `True`）；回查今日步数（`:192-194`）；`after_points`（`:195`）；组装返回（`:196-207`） | **锁已释放**，副作用不再串行化 |

返回体（`:196-207`）10 个键：`date`、`steps`（今日，`:198`）、`total_steps`（`:199` 再查一次 `get_total_steps`）、`synced`（`:200`）、`status`（`:201`）、`processed_dates`、`failed_dates`、`points_change`（`:204` = `after_points - before_points`）、`today_walk_points`（`:205` `points_service.walk_on`）、`walk_carry`（`:206` `points_service.walk_carry`）。

- **`synced` 的语义是「今日记录本次发生了变化」**，不是「同步成功」：`written` 只收 `changed` 为真的行（`:176-177`），故步数无变化的重复同步返回 `synced: false` 且 `status: "success"`。前端据此显示「已是最新」而非报错（`frontend/pages/home/home.js:334-343`）。
- **`status` 只有两个取值**：`"success"`（`failed` 为空）/ `"partial"`（有失败日期），`:201`。全部 7 日皆缺时不会走到这里——`_resolve_steps:97-98` 已先抛 `ValueError`。
- `points_change` 可能为负：历史步数被微信下修时 `recompute_walk` 会调减台账（`docs/迭代记录.md` 的 `83d3552` 条目列有「下调重算」用例）。

### 4.9 `get_today(db, user_id) -> Dict`（`:210-233`）
今日概况 + 连续行军卡字段，10 个键：`date`（`:223`）、`steps`（`:224`，无记录为 0）、`target`（`:225` = `DAILY_TARGET`）、`total_steps`（`:226`）、`current_streak` / `max_streak`（`:218` 由 `streak_service.compute_streaks` 按 `is_goal_completed` 重算）、`streak_goal`（`:229` = `settings.STREAK_GOAL_STEPS`）、`today_goal_completed`（`:230`）、`next_streak_milestone`（`:219-221`，`event_service.STREAK_MILESTONES` 中第一个大于 `current_streak` 的值，无则 `None`）、`streak_remain`（`:232`）。只读，不写库。

### 4.10 `_level_of(steps) -> int`（`:236-242`）
日历热力档位：`0` = 0 步、`1` = 1~4999、`2` = 5000~9999、`3` = ≥10000（docstring `:237`）。**阈值 5000 与 10000 是硬编码字面量**（`:238`、`:240`），未引用 `settings.STREAK_GOAL_STEPS`（`:229` 却在同一文件用了它）——见 §8。

### 4.11 `get_calendar(db, user_id, month) -> Dict`（`:245-315`）
行军日历（功能 3），5 段：
1. `:247-254` 解析 `month`：`int(month[:4])` / `int(month[5:7])`，用「下月 1 日 − 本月 1 日」求 `days_in_month`（`:248-253`，12 月特判 `:249-250`），生成整月日期串列表。
2. `:256-261` 一次 `IN` 查询取当月 `daily_sport` 行 → `{date: record}`。
3. `:263-268` 一次 `IN` 查询取当月 `quiz_records(date, score)` → `{date: score}`。
4. `:270-283` 一次 join 查询取当月点亮：`LitNode JOIN RouteNode`，过滤 `lit_at >= local_to_utc(month_start)` 且 `< local_to_utc(month_end)`（`:275-276`，naive 入参按北京时间解释，见 `backend/app/core/helpers.py:40-44`），再 `to_local(lit_at).strftime("%Y-%m-%d")` **按本地日期归格**（`:283`，注释 `:282`）。这段 UTC↔本地换算是 `18c2121` 修复「8 小时错位」的成果（`backend/test/docs/s3-miniapp-aggregates-report.md:36-41`）。
5. `:285-315` 逐日组装 7 字段（`date`/`steps`/`level`/`goal_completed`/`quiz_done`/`quiz_score`/`lit_nodes`）+ `stats` 5 字段（`month_steps`/`sport_days`/`avg_steps`（`:311`，`sport_days` 为 0 时取 0，不除零）/`max_steps`/`current_streak`）。

共 4 条 SQL（含 `streak_service.compute_streaks` 的 1 条，`:303`）。**`stats.current_streak` 是全局当前连续天数，不是「该月内」的连续天数**（`:303` 直接调 `compute_streaks`，与月份无关）。

### 4.12 `get_recent(db, user_id, n) -> List[Dict]`（`:318-327`）
最近 `n` 天（含今天，从旧到新，`recent_dates(n)`，`backend/app/core/helpers.py:27-30`）。一次 `IN` 查询后按日期序列补齐缺失日为 0，每项 `{date, steps, text}`，`text = d[5:]` 即 `MM-DD`（`:327`）。`n` 的上下界由路由 `Query(7, ge=1, le=90)` 强制（`backend/app/api/routes/sport.py:55`）。

### 4.13 `add_steps(db, user_id, delta) -> None`（`:330-342`）
手动补充步数（演示用），返回 `None`（路由另行调 `get_today` 出参，`backend/app/api/routes/sport.py:79-82`）：
1. `:332` `date = today_str()`；`:333` `prev_total = get_total_steps(...)`；`:334` `is_first_record`（该用户是否**没有**任何 `daily_sport` 行）——**这两步在取锁之前**（`:335`）。
2. `:335` `users` 行锁；`:336` `_lock_day` 当日行锁。
3. `:337` `value = (existing.steps or 0) + delta`（**累加**，与 `sync_today` 的覆盖语义相反）；`:338` `_upsert_day(..., source="manual")`。
4. `:339` `points_service.recompute_walk(db, user_id)`；`:340` **`db.commit()`——无 `IntegrityError` 捕获**（对比 `sync_today:181-185`）。
5. `:341-342` `if changed: _after_written(...)`。

`delta` 由请求模型约束为非负整数（`backend/app/schemas/schemas.py:202-205`，`Field(0, ge=0)`），故本函数不会写入负步数。前端已无调用入口（演示按钮由 `b1dc700` 移除），当前调用方为 automator 与 e2e 脚本。

## 5. 输入与输出

### 5.1 函数级 I/O
| 函数 | 输入 | 输出 | 抛出 |
|---|---|---|---|
| `get_total_steps` | `db`、`user_id` | `int` | 无 |
| `_distance_of` | `steps: int` | `float`（2 位小数） | 无 |
| `_after_written` | `db`、`user_id`、`date`、`record`、`is_first_record`、`prev_record_steps`、`prev_total` | `int`（写入后累计步数） | 不捕获；下游 `event_service.record` / `streak_service` 的异常原样上抛 |
| `_resolve_steps` | `openid`、`code`、`encrypted_data`、`iv`、`date`（**未使用**）、`user_id` | `Dict[str, int]`（北京时间日期 → 步数） | **`ValueError` ×4**（`:89`、`:98`、`:102`，以及 `decrypt_werun` 的两种，`backend/app/core/wx.py:57`、`:60`） |
| `_lock_day` | `db`、`user_id`、`date` | `Optional[DailySport]`（带行锁） | 无 |
| `_upsert_day` | `db`、`user_id`、`date`、`steps`、`source` | `(DailySport, previous:int, created:bool, changed:bool)` | `IntegrityError`（flush 时，由调用方处理） |
| `sync_today` | `db`、`user_id`、`openid=""`、`code`、`encrypted_data`、`iv` | `Dict`（10 键，见 §4.8） | `ValueError`（同步失败/冲突，路由转 400） |
| `get_today` | `db`、`user_id` | `Dict`（10 键） | 无 |
| `_level_of` | `steps: int` | `int` 0~3 | 无 |
| `get_calendar` | `db`、`user_id`、`month: str` | `Dict`（`month`/`days`/`stats`） | **`ValueError`（`datetime(year, mon, 1)`，月份越界时）**，见 §9 |
| `get_recent` | `db`、`user_id`、`n: int` | `List[Dict]`（`date`/`steps`/`text`） | 无 |
| `add_steps` | `db`、`user_id`、`delta: int` | `None` | `IntegrityError` 未捕获，见 §9 |

### 5.2 对外 HTTP 出口（本文件不定义路由，均为调用方）
| 方法 + 路径 | 权限依赖 | 调用的函数 | `response_model` | 业务错误码 |
|---|---|---|---|---|
| `GET /api/sport/today` | `require_activity_view`（`backend/app/api/routes/sport.py:25`） | `get_today`（`:26`） | `SportToday`（`backend/app/schemas/schemas.py:133-143`） | 401 / 403+`X-Account-Status` / 403+`X-Activity-Status` |
| `POST /api/sport/sync` | `require_activity_participation`（`:32`） | `sync_today`（`:38-45`） | `SportSync`（`schemas.py:151-161`） | **400**（`ValueError`，`:46-47`）+ 上述 |
| `GET /api/sport/recent` | `require_activity_view`（`:56`） | `get_recent`（`:59`） | `List[RecentItem]`（`schemas.py:172-175`） | 422（`n` 越界）+ 上述 |
| `GET /api/sport/calendar` | `require_activity_view`（`:65`） | `get_calendar`（`:70`） | `SportCalendarOut`（`schemas.py:196-199`） | **400**（`month` 格式校验，`:68-69`）+ 上述 |
| `POST /api/sport/add` | `require_activity_participation`（`:76`） | `add_steps`（`:79`）→ 再 `get_today`（`:82`） | `SportToday` | 422（`delta < 0`）+ 上述 |
| `GET /api/admin/users/{user_id}/overview` | `require_menu("rankings")`（`backend/app/api/routes/admin.py:369`） | 经 `admin_service.get_user_overview`（`backend/app/services/admin_service.py:489`）调 `get_today`（`:542`）与 `get_recent`（`:567`） | `AdminUserOverviewOut` | 404（用户不存在，`:374-375`） |

请求体 `SportSyncRequest`（`backend/app/schemas/schemas.py:164-169`）三字段全部 `Optional`，整个 body 也可为空（路由 `:31`、`:36` 用 `payload or SportSyncRequest()` 兜底）。

**写路径的两个额外副作用在路由层**（不在本文件）：`POST /api/sport/sync` 与 `POST /api/sport/add` 成功后各调一次 `medal_service.check_and_grant`（`backend/app/api/routes/sport.py:48`、`:80`）并广播 WS `data_changed` 消息（`:49` `build_event("sport.sync", ...)`、`:81` `build_event("sport.add", ...)`）。

## 6. 依赖关系

**依赖（`:14-25`）**
- 标准库：`datetime`（`:14`）、`typing`（`:15`）。
- SQLAlchemy：`func`（`:17`）、`IntegrityError`（`:18`）、`Session`（`:19`）。
- `app.core.config.settings`（`:21`）——**用模块级单例**，读取点：`STRIDE_M`（`:43`）、`WX_APPID`/`WX_SECRET`（`:85`、`:100`、`:150`）、`STREAK_GOAL_STEPS`（`:229`）。因 `settings = get_settings()` 且带 `lru_cache`（`backend/app/core/config.py:110-115`），测试可直接改写单例属性来模拟配置（`.qoder/backend/app/core/config.py.md` §6）。
- `app.core.helpers`（`:22`）：`BEIJING_TZ`（`:95`）、`local_to_utc`（`:275-276`）、`now_utc`（`:129`）、`recent_dates`（`:101`、`:148`、`:320`）、`seeded_steps`（`:101`）、`to_local`（`:283`）、`today_str`（`:147`、`:212`、`:332`）。
- `app.core.wx`（`:23`）：`code2session`（`:87`）、`decrypt_werun`（`:90`）——**本文件是这两个函数的唯一业务消费方**（另一处 `auth_service.py:43` 用 `code2session`）。第三方库 `httpx`、`pycryptodome` 经此间接引入。
- `app.models.models`（`:24`）：`DailySport`、`LitNode`、`QuizRecord`、`RouteNode`、`User`。
- `app.services`（`:25`）：`event_service`（`record` ×4 于 `:57`、`:62`、`:67`；`has_event` 于 `:66`；`STREAK_MILESTONES` 于 `:220`）、`points_service`（`recompute_walk` `:180`/`:339`、`get_total` `:152`/`:195`、`walk_on` `:205`、`walk_carry` `:206`）、`streak_service`（`on_sport_written` `:59`、`compute_streaks` `:218`/`:303`）。
- **依赖方向**：`sport_service` → {`event_service`, `points_service`, `streak_service`}；`march_service` → `sport_service`（`backend/app/services/march_service.py:20`、`:193`、`:365`）。无环（`sport_service` 不依赖 `march_service`）。

**被依赖**
| 调用方 | 位置 | 用到的函数 |
|---|---|---|
| 运动路由 | `backend/app/api/routes/sport.py:19`、`:26`、`:38`、`:59`、`:70`、`:79`、`:82` | 全部 5 个公开函数 |
| 长征服务 | `backend/app/services/march_service.py:193`、`:365` | `get_total_steps` |
| 管理端人员详情 | `backend/app/services/admin_service.py:34`、`:542`、`:567` | `get_today`、`get_recent` |
| 小程序 | `frontend/services/sport.js:86-102`（`syncToday`）、`:110-114`（`getToday`）、`:121-123`（`getCalendar`）、`:130-132`（`getRecent`） | 对应 4 个端点 |

**数据库表**
| 表 | 读/写 | 位置 |
|---|---|---|
| `daily_sport`（`backend/app/models/models.py:231-252`） | **读 + 写**（唯一写入方） | 写 `:121-131`；读 `:34`、`:107-110`、`:154`、`:192-194`、`:214-216`、`:257-259`、`:322-324` |
| `users`（`:179-205`） | 只读 + **行锁** | `:151`、`:335` |
| `lit_nodes`（`:255-268`） | 只读 | `:270-279`（日历点亮标记） |
| `route_nodes`（`:32-58`） | 只读 | `:271-272`（join 取节点名） |
| `quiz_records`（`:271-287`） | 只读 | `:264-266`（日历答题标记） |
| `points_log` | 经 `points_service` 读写 | `:180`、`:195`、`:205-206`、`:339` |
| `user_event` | 经 `event_service` 写 | `:57`、`:62`、`:66-67` |

**外部依赖**：微信 `jscode2session` HTTPS 接口（唯一外部 HTTP 调用，经 `backend/app/core/wx.py:15`），超时 5 秒，无重试。

## 7. 业务规则

### 7.1 事务边界（谁 commit）
- **`sync_today` 自己 commit**：主事务在 `:182` 收口，范围含「7 日 `_upsert_day` 的 flush（`:131`）+ `recompute_walk` 的台账修复（`:180`）」。`recompute_walk` 明确不自提交，要求「调用方需已串行化该用户写入并负责提交」（`backend/app/services/points_service.py:101`），本文件用 `:151` 的 `users` 行锁满足前半句、用 `:182` 满足后半句。**步数与步行积分因此是原子的**。
- **`add_steps` 自己 commit**：`:340`，范围同上（`:338` flush + `:339` recompute）。
- **提交之后的副作用各自独立提交**：`_after_written`（`:188-190` / `:342`）里，`event_service.record` 每条事件一次 `db.commit()`（`backend/app/services/event_service.py:121`），`streak_service.on_sport_written` 另有两次 commit（`backend/app/services/streak_service.py:81`、`:89`）。**一次同步最多产生 4 类事件 × 7 天 + 每日 2 次 streak commit**，均非原子；中途失败会留下「步数已写、部分事件缺失」的状态。
- **只读函数不 commit**：`get_total_steps`、`get_today`、`get_calendar`、`get_recent` 运行在 `get_db` 的请求级 session 中，`finally` 只 `db.close()`（`backend/app/core/database.py:58-64`）。
- **审计**：本文件**不写审计日志**（`audit_service` 未被 import）。管理端侧的积分修复审计在 `POST /api/admin/points/verify`（`docs/迭代记录.md` 的 `2f3f333` 条目），与同步链路无关。

### 7.2 幂等性
- **数据层幂等**：同一日重复同步用**相同的微信最终值覆盖**（`:126`），`changed` 为假（`:132`）→ 不进 `written`（`:176-177`）→ 不触发任何事件与 streak 维护。`recompute_walk` 仍会执行（`:179-180` 只要求 `processed` 非空），但其本身是「核对修复」实现，对已正确的台账零差异（`backend/app/services/points_service.py:103-107`）。
- **事件层幂等**：`TOTAL_STEPS_*` 靠 `has_event` 查表去重（`:66`）；`STREAK_*` / `DAILY_GOAL` 靠 `streak_service` 的「达标状态翻转」判定 + `has_event`（`backend/app/services/streak_service.py:78-79`、`:99-101`）；`FIRST_STEP` 靠「该用户首条 `daily_sport`」（`:189`）；**`STEP_10000` 只靠边界条件（`:61`），不查事件表**——若微信把某日步数由 12000 下修到 9000、之后再回到 12000，该事件会**重复写入**（`:61` 的 `prev_record_steps < 10000 <= record.steps` 会第二次成立）。
- **积分层幂等**：`points_log` 以 `(user_id, biz_key)` 唯一，`biz_key = "walk:{date}"`（`backend/app/services/points_service.py:64-65`），`set_daily` 在行锁内覆盖而非追加（`:68-97`）。

### 7.3 并发约束
- **同一用户的并发写靠 `users` 行锁串行化**：`sync_today:151` 与 `add_steps:335` 都在写任何数据**之前**先 `SELECT users.id ... FOR UPDATE`。第二个请求阻塞至第一个 `:182`/`:340` 提交。
- **`uq_sport_user_date`（`backend/app/models/models.py:240`）是最后一道兜底**：`sync_today` 捕获 `IntegrityError` → `rollback` → `ValueError("步数同步冲突，请稍后重试")` → 400（`:181-185`）。**`add_steps` 没有这层捕获**（`:340`），冲突会直接 500。
- **锁的生效范围**：`with_for_update()` 在 SQLite 上无效（§4.6），故开发/冒烟环境的并发保护只来自唯一约束；openGauss 上两者兼有。
- **锁在 commit 时释放，副作用在锁外**：`:187-190` 的事件与 streak 维护已不受 `users` 行锁保护，两个并发同步的副作用可能交错。`streak_service.on_sport_written` 内部对 `daily_sport` 与 `users` 的读写因此也可能相互覆盖（`backend/app/services/streak_service.py:69-89`）。
- **`add_steps` 的读在锁之前**：`prev_total`（`:333`）与 `is_first_record`（`:334`）先于 `:335` 取锁，并发写者可能使二者失真，进而影响 `_after_written` 的里程碑边界判定（`:66`）。
- **`sync_today` 的外部 HTTP 在加锁之前**（`:149` vs `:151`），这是有意为之：避免 5 秒超时的微信调用长时间持有行锁。

### 7.4 覆盖 vs 累加
- `sync_today` → **覆盖**（`_upsert_day:126`，取微信最终值）。`6f2cfc3` 之前的实现是 `record.steps = max(value, prev)`（只增不减），已被替换；`.qoder/REQUIREMENTS.md` §3.1「步数只增不减」行仍描述旧规则，见 §9。
- `add_steps` → **累加**（`:337`）。
- 两条路径都写 `source` 区分来源：`"werun"` / `"mock"`（`:150`）/ `"manual"`（`:338`）。

### 7.5 时间口径
- 业务自然日一律**北京时间**：`today_str()`（`:147`、`:212`、`:332`）、`recent_dates(7)`（`:148`、`:320`）、微信时间戳归日 `datetime.fromtimestamp(ts, BEIJING_TZ)`（`:95`）、模拟步数按日（`:101`）。
- 库内时间列一律 **UTC naive**：`synced_at = now_utc()`（`:129`）；读取比较时用 `local_to_utc`（`:275-276`）换算边界、用 `to_local`（`:283`）归格。
- `daily_sport.date` 是 `String(10)` 的北京时间日期串（`backend/app/models/models.py:244`），不是时间戳。

### 7.6 外部调用失败降级
| 失败点 | 行为 | 是否写库 |
|---|---|---|
| 未配置 `WX_APPID`/`WX_SECRET` | `has_creds` 为假 → 走 (B) `seeded_steps` 模拟 7 日，`source="mock"`（`:100-101`、`:150`） | **写**（开发模式兜底，`backend/app/core/helpers.py:50-52` 明确此为设计意图） |
| `code2session` 网络超时/异常/无 openid | 该函数吞掉异常返回 `None`（`backend/app/core/wx.py:41-42`）→ `:88-89` `ValueError` → 400 | 不写 |
| `session_key` 缺失 | `:88-89` `ValueError` → 400 | 不写 |
| 解密失败 / padding 非法 / JSON 失败 | `backend/app/core/wx.py:56-57` `ValueError` → 400 | 不写 |
| `watermark.appid` 不匹配（伪造数据） | `backend/app/core/wx.py:58-60` `ValueError` → 400 | 不写 |
| `stepInfoList` 为空 | `:97-98` `ValueError` → 400 | 不写 |
| 微信只返回部分日期 | 缺失日进 `failed_dates`（`:157-161`），其余正常写入，`status="partial"`（`:201`） | 部分写 |
| 真实用户未携带加密数据 | `:102` `ValueError` → 400 | 不写 |

**关键降级风险**：`not has_creds` 这一个条件就能让**任何** openid（含真实用户）走 (B) 写入伪随机步数（`:100`）。生产环境若 `WX_APPID`/`WX_SECRET` 意外为空，全平台步数将被模拟值覆盖且 `source` 标为 `"mock"`。凭证配置项说明见 `.qoder/backend/app/core/config.py.md`（本文不记录任何实际值）。

## 8. 修改约束

1. **`daily_sport` 的步数写入只能经 `_upsert_day`**：它是全仓唯一的 `steps`/`distance` 写入点（§2；`is_goal_completed` 由 `streak_service` 单独维护，`backend/app/services/streak_service.py:80`）。绕过它直接改 `record.steps` 会同时破坏「`distance` 同步重算」（`:127`）与「`recompute_walk` 台账一致性」（`:180`/`:339`）。
2. **`recompute_walk` 必须在行锁内调用、由调用方提交**：其 docstring 是硬性契约（`backend/app/services/points_service.py:101`）。新增写入路径时必须复刻 `:151` 的 `users` 行锁 + `:180` 的同事务重算 + `:182` 的提交三件套，否则「累计步行积分 = 累计计分步数 // 1000」的恒等式会被破坏。
3. **`_after_written` 必须在 commit 之后调用**：docstring `:55` 明确「均在主数据提交后触发」。提前调用会让 `event_service.record` 的 commit（`backend/app/services/event_service.py:121`）把未校验的步数一起提交，`IntegrityError` 兜底（`:183-185`）随之失效。
4. **`_resolve_steps` 的三条路径不得调换顺序**：`:86` 的真实路径必须优先于 `:100` 的模拟路径，否则携带有效加密数据的真实用户会被写入模拟值。`:102` 的兜底 `ValueError` 不得删除——它是「真实用户绝不编造步数」（docstring `:7`、`:83`）的唯一执行点。
5. **`decrypt_werun` 的 `watermark.appid` 校验不得移除**（`backend/app/core/wx.py:58-60`）：这是防伪造 `encryptedData` 写库的唯一关卡，`3df3fd0` 的验收用例专门覆盖「伪造数据 400 零写入」（`docs/迭代记录.md` 的 `3df3fd0` 条目）。
6. **`source` 取值集合 `{werun, mock, manual}` 是既有数据口径**：`docs/迭代记录.md` 的 `83d3552` 条目记录生产库 019 迁移时「存量 93 行 source 回填 werun」。新增来源须同步迁移与管理端展示。
7. **`_level_of` 的档位阈值 5000 / 10000 与 `settings.STREAK_GOAL_STEPS` 是隐式耦合但未共享常量**：`:238`、`:240` 是字面量，`:229` 读配置。若运营调整 `STREAK_GOAL_STEPS`（`backend/app/core/config.py:95`），日历热力档位不会跟随，而 `streak_service.on_sport_written:77` 的达标判定会跟随——三者会静默不一致。修改任一处必须同时核对另两处。
8. **`DAILY_TARGET` 与前端常量必须同步**：`frontend/services/sport.js:13` 有一份独立的 `20000`，且在 `:113` **覆盖**后端下发值。只改后端不生效（`docs/迭代记录.md` 的 `aa7dd82` 条目就是这个缺陷的修复记录）。
9. **返回体键名是 camelCase 硬契约**：`SportSync` 10 字段（`backend/app/schemas/schemas.py:151-161`）、`SportToday` 10 字段（`:133-143`）与 `frontend/services/sport.js:63-76`（`normalizeSyncResult` 兼容旧结构）、`frontend/pages/home/home.js:328-343`（按 `failedDates`/`processedDates`/`synced`/`pointsChange` 分支提示）逐字段绑定。删字段会破坏滚动发布期的兼容性。
10. **`synced` 的语义不得改成「同步成功」**：前端把 `synced === false && pointsChange === 0` 解释为「已是最新」（`frontend/pages/home/home.js:334-343`）。
11. **`get_calendar` 的 `month` 参数校验在路由层**（`backend/app/api/routes/sport.py:68-69`），service 内无二次校验（`:247`）；若新增其它调用方（如管理端月报），必须自行校验，否则月份越界会 500（§9）。
12. 修改本文件后须同步 `.qoder/backend/app/api/routes/sport.py.md`、`.qoder/REQUIREMENTS.md` §3、`.qoder/backend/app/models/models.py.md`（`daily_sport` 段）。

## 9. 当前实现状态

**已实现**
- 微信运动真实数据同步：`code2session` + AES-128-CBC 解密 + `watermark.appid` 校验，按北京时间归日（`:86-99`）。
- 近 7 日逐日覆盖补录，缺失日期不写 0、不覆盖、返回待重试明细（`:145`、`:157-161`、`:163-177`）。
- 步数与步行积分台账**同事务原子**写入 + 全量核对修复（`:151`、`:179-182`）。
- 并发保护：`users` 行锁 + 当日行锁 + 唯一约束兜底 + `IntegrityError` → 400（`:151`、`:105-111`、`:181-185`）。
- 提交后副作用链：`FIRST_STEP` / `STEP_10000` / `TOTAL_STEPS_*` / 连续行军 / `DAILY_GOAL` / `STREAK_*`（`:46-68`）。
- 三个只读聚合：今日概况（`:210-233`）、行军日历（`:245-315`）、最近 N 天（`:318-327`）。
- 手动补步（演示/测试用，`:330-342`）。

**存在问题（事实性陈述）**
1. **`get_calendar` 对月份越界返回 500 而非 400**：路由校验 `len(month) != 7 or month[4] != "-" or not month.replace("-","").isdigit()`（`backend/app/api/routes/sport.py:68`）只查长度、分隔符与数字，**不查范围**。`month="2026-13"` 或 `"2026-00"` 能通过校验，随后 `datetime(year, mon, 1)`（`:248`）抛 `ValueError: month must be in 1..12`，该异常无捕获 → 500。`int(month[:4])` 亦无年份范围校验。
2. **`add_steps` 的 `db.commit()`（`:340`）没有 `IntegrityError` 处理**，与 `sync_today:181-185` 不对称；并发首写冲突会以 500 而非 400 暴露。同时 `prev_total`/`is_first_record` 在取锁之前读取（`:333-334` vs `:335`），并发下可能失真。
3. **`_resolve_steps` 的 `date` 形参是死参数**（§4.5 末段），`6f2cfc3` 改造后未清理；调用方 `:149` 仍传值。
4. **`daily_sport.source` 与步数真实来源可能不一致**：`source` 由 `openid` 前缀与凭证状态推导（`:150`），而步数由 `_resolve_steps` 的**分支**决定（`:86` vs `:100`）。当「已配置凭证 + `WX_LOGIN_ALLOW_MOCK=True` + 该用户曾以 mock openid 登录 + 本次携带有效加密数据」同时成立时，写入的是**真实微信步数**但 `source` 记为 `"mock"`。反之，凭证被清空时真实用户会写入模拟步数且 `source="mock"`（此时标记反而正确）。
5. **docstring `:79` 「范围以微信实际返回为准」与实际写入范围不符**：写入循环只遍历 `expected_dates`（最近 7 个北京时间自然日，`:148`、`:163-165`），微信返回的更早日期被**静默丢弃**，且因 `failed` 也是从 `expected_dates` 构造（`:157-161`），这些日期既不入 `processed_dates` 也不入 `failed_dates`，调用方无从得知。
6. **`STEP_10000` 事件无表级去重**（§7.2），步数下修后再回升会重复写入。`TOTAL_STEPS_*` 与 `STREAK_*` 均有 `has_event` 保护，此处是唯一的例外。
7. **`.qoder/REQUIREMENTS.md` §3.1 两行已滞后**：「步数只增不减」「同一日重复同步取最大值」描述的是 `2f3f333` 引入、`6f2cfc3` **已删除**的 `_write_day` 行为（旧实现 `record.steps = max(value, prev)`，见 `git show 6f2cfc3 -- backend/app/services/sport_service.py`）。现行实现是直接覆盖（`:126`），允许下修（`docs/迭代记录.md` 的 `83d3552` 条目列有「下调重算」验证用例）。需按 `.qoder/README.md` §3.11 更正该总览文档。
8. **docstring `:4-5` 的「累计计分步数」措辞已滞后**：单日 20000 步计分封顶（`POINTS_WALK_STEP_CAP`）已由 `9cb65b8`（2026-10-15 18:03）删除，现行口径为无上限的累计步数 ÷ 1000（`.qoder/backend/app/services/points_service.py.md:78`、`.qoder/REQUIREMENTS.md` §12）。该提交未改动本文件（`git show --name-only 9cb65b8 -- backend/` 无 `sport_service.py`），故措辞留存。
9. **`sync_status` 列只会被写成 `"processed"`**（§4.7），失败态不落列，列的信息量目前为零。
10. **`is_makeup` / `makeup_at` 是死字段**（`backend/app/models/models.py:248-249`），补签功能未实现（`.qoder/REQUIREMENTS.md` §3.3「补签（待开发）」段）。
11. **提交后副作用不在锁内**（§7.3），并发同步的事件与 streak 维护可能交错。
12. **`with_for_update()` 在 SQLite 上无效**（§4.6），本地冒烟无法验证并发行为；相关并发用例只在 openGauss 上有意义（`docs/迭代记录.md` 的 `83d3552` 条目中的 S24-PG 即为此而设）。

**待开发**
- 补签（`is_makeup`/`makeup_at`）：字段已建、业务未实现，产品规则无需求依据（`.qoder/REQUIREMENTS.md` §3.3「补签（待开发）」段与 §14 第 9 项）。
- `add_steps` 的生产入口：前端演示按钮已由 `b1dc700` 移除（`docs/迭代记录.md` 的 `b1dc700` 条目），接口保留仅供 automator/e2e 补步使用；是否下线或加管理端权限——**待确认**。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/sport_service.py`（**9 个提交**）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-15（`83d3552`）
- 需求：修复「同步链路只从本次写入最早日期起重算台账，历史『每日各自取整』错账不修复」；同时生产库 `schema_migrations` 仅到 018，`daily_sport` 缺 019 的 `source`/`synced_at`/`sync_status` 列会导致同步 500（`:120` 原因字段）。
- 修改内容：`points_service` 删除增量 `sync_walk_from`、新增全量 `recompute_walk`；本文件把 `sync_today:180` 与 `add_steps:339` 的重算调用改为全量修复，docstring `:4-5` 改写为「按运动源数据全量核对修复该用户步行台账……保证累计步行积分 = 累计计分步数 // 1000，重复同步幂等」。6 insertions / 5 deletions。
- 关联文件：`backend/app/services/points_service.py`、`backend/test/s23_walk_sync_recalc.py`、`backend/test/s24_walk_recalc_pg.py`、报告 `backend/test/docs/walk-sync-full-recalc-fix-report.md`、`backend/README.md`、`backend/design.md`。
- 测试结果：`docs/迭代记录.md` 的 `83d3552` 条目「验证」字段原文——「S23 新增 13/13（复现 2611 步 1 分→同步修复 2 分、跨日零碎累计、999/1999/2000/3500 边界、幂等、下调重算、部分失败保留、残留清零、用户隔离、四处口径一致）、S24-PG 真实 openGauss 6/6、S20 26/26、S22 14/14、S21 4/4；全库匿名核对：87 用户步行台账与理论 0 不一致。」

### 2026-10-15（`9c8f13f`）
- 需求：今日行军目标由 1 万步调整为 2 万步。
- 修改内容：`DAILY_TARGET` 由 `10000` 改为 `20000`（`:27`）。1 insertion / 1 deletion。
- 关联文件：`frontend/services/sport.js`、`frontend/pages/home/home.js`、测试脚本与文档。
- 测试结果：`docs/迭代记录.md` 的 `9c8f13f` 条目「验证」字段原文——「S22 专项回归 14/14、首页状态分档断言 5/5 通过；Python 编译、`node --check` 及微信开发者工具编译通过。远程后端需部署本提交后线上首页才会收到 `target=20000`。」

### 2026-10-15（`6f2cfc3`）
- 需求：近 7 日微信运动补录 + 步数结余积分。
- 修改内容：本文件改动最大的一次（95 insertions / 67 deletions）——`_write_day`（含「只增不减 `max(value, prev)`」与 3 次 `IntegrityError` 重试循环）**整体替换为** `_upsert_day`（按微信最终值直接覆盖，`:114-132`）；`_resolve_steps` 由「必含今日、否则 400」改为「范围以微信实际返回为准」，模拟路径由单日改为 `recent_dates(7)`（`:100-101`），并因此使 `date` 形参失去用途；`sync_today` 新增 `expected_dates`/`processed_dates`/`failed_dates`/`status` 与逐日校验循环（`:148`、`:156-177`、`:200-203`），`IntegrityError` 处理由 `_write_day` 内循环上移到 `:181-185`；新增 `now_utc()` 写 `synced_at`（`:129`）与 `User` 行锁（`:151`）；docstring `:3-6` 改写。
- 关联文件：`backend/app/services/points_service.py`、`backend/app/services/quiz_service.py`、`backend/app/schemas/schemas.py:146-161`（`SportSyncFailure` 等）、`docker/init/019_sport_backfill_carry.sql`（新增 `daily_sport.source`/`synced_at`/`sync_status`）、`docker/init/020_question_rotation.sql`、`frontend/services/sport.js:63-76`、`frontend/pages/home/home.js:328-343`。
- 测试结果：`docs/迭代记录.md` 的 `6f2cfc3` 条目「验证」字段原文——「S22 新增专项测试 13/13、S18 限时答题回归 21/21、S20 V2 回归 25/25 通过；Python 编译与前端 `node --check` 通过；微信开发者工具 CLI 可正常打开项目。5800 步入账 5 分并结余 800，下一记录 200 步入账 1 分的验收用例通过。」同条目 `:162`「遗留」字段原文——「本机 Docker Desktop Linux 引擎不可用，未执行真实 openGauss 019/020 迁移与 S11；尚需具备微信运动权限的真机验证，以及登录态下部分同步、结余展示和题库不足 UI 验收。」（该遗留项中的 openGauss 迁移与 S11 后由 `83d3552` 的 S24-PG 6/6 覆盖。）

### 2026-10-13（`2f3f333`）
- 需求：V2.0 需求三/四——积分台账重构与总积分排名。
- 修改内容：92 insertions / 61 deletions。引入 `points_service` 台账模型（每人每来源每天一行、行锁重算覆盖）；本文件新增 `_lock_day`（`:105-111`）与 `_write_day`（后被 `6f2cfc3` 替换）、`users` 行锁、`before_points`/`after_points`/`points_change`（`:152`、`:195`、`:204`）；「步数同步只增不减，取当日最终步数；已有记录的往日按微信运动的最终步数校正，并按北京时间解析」（`:403`）；移除登录/达标/点亮/里程碑积分。
- 关联文件：`docker/init/017_points_ledger.sql`、`backend/app/services/points_service.py`、`backend/app/services/march_service.py`、`backend/app/services/event_service.py`、`backend/app/services/streak_service.py`、`backend/app/api/routes/points.py`、`backend/app/api/routes/rank.py`。
- 测试结果：`docs/迭代记录.md` 的 `2f3f333` 条目「验证」字段原文——「SQLite 冒烟 20/20 通过：999 / 1000 / 1999 / 20000 / 25000 步边界、增量不重复计分、重复同步幂等、重同步取最大值与往日校正、答题积分及重复提交、排名顺序、档案与管理端及 CSV 一致、篡改后核对能发现并修复、legacy 不计入。」「openGauss 上 016 / 017 迁移已执行，回填 92 条步行、12 条答题记录，核对 132 人 111 天差异为 0；10 线程并发补步后步数 10000、积分 10，与台账一致。」「回归：s11 8/8、s18 14/14、s19 25/25（已按新规则更新断言）、s6 8/8 通过。」「s5、s9 依赖旧的首登自动建号，在本地已配置真实 WX 凭证时登录返回 502，这是本次之前就存在的问题。」

### 2026-10-11（`f59892e`）
- 需求：后端热点查询 SQL 聚合化与去 N+1。
- 修改内容：21 insertions / 20 deletions。`_calc_total`（Python 侧遍历累加）改为 `get_total_steps`（库内 `coalesce(sum(...), 0)`，`:31-38`）；`sync_today` 的累计步数改为「写入后增量推算」（`:187-189` 的 `total` 串接）而非每日重查；连续行军改由 `streak_service` 按自然日判定。
- 关联文件：`backend/app/services/march_service.py`（删除各自的 `_total_steps`）、`backend/app/services/points_service.py`、`docker/init/012_perf_indexes.sql`、报告 `backend/test/docs/s14-hotspot-sql-report.md`。
- 测试结果：`docs/迭代记录.md` 的 `f59892e` 条目「验证」字段原文——「openGauss 已应用 012。e2e_full_flow 178/178，e2e_datasync 23/23，S2–S7、P0/P1/P2、昵称冒烟全部通过。排行、播报结果与旧实现逐项一致（92 用户 / 20 用户样本）。」

### 2026-10-10（`3df3fd0`）
- 需求：修复「实际没走 9000 步，同步后当天却写入约 9000 步」——根因是前端从不携带数据、后端对无参请求一律用 `seeded_steps` 生成 4000~12999 假步数落库（`:608` 原因字段）。
- 修改内容：43 insertions / 3 deletions。新增 `_resolve_steps`（`:71-102`）与真实微信解密路径，`sync_today` 签名扩展为 `(db, user_id, openid, code, encrypted_data, iv)`（`:135-142`），真实用户缺数据/解密失败 400 不写库，仅 mock 用户或未配置凭证时回退模拟；docstring `:6-7` 改写。
- 关联文件：`backend/app/core/wx.py`（同提交新建，`code2session` + AES-128-CBC 解密 + `watermark.appid` 校验）、`backend/app/services/auth_service.py:43`（收敛复用 `code2session`）、`frontend/services/sport.js:19-102`（授权 → `wx.login` → `wx.getWeRunData` 上送）、`backend/requirements.txt`（新增 pycryptodome）、`backend/test/s11_sport_sync_werun.py`。
- 测试结果：`docs/迭代记录.md` 的 `3df3fd0` 条目「验证」字段原文——「S11 后端冒烟 8/8（`test/s11_sport_sync_werun.py`，含加解密往返/watermark 校验/缺当日步数/伪造数据 400 零写入），e2e 全链路 178/178 回归；小程序 automator 验收 4/4（演示按钮已移除、devtools 取数失败友好报错且零写入，截图 s11-01）。真机（已开通微信运动设备）端到端回归待用户确认。」同条目 `:608` 记录了数据修复：「经用户确认删除当天全部 5 条模拟步数记录（真实用户 uid 345/347 + 3 个 mock 测试用户，已发积分不回溯）。」

### 2026-10-02（`18c2121`）
- 需求：小程序聚合接口批次（档案/足迹/**日历**/播报/知识画像）。
- 修改内容：96 insertions / 3 deletions。新增 `_level_of`（`:236-242`）与 `get_calendar`（`:245-315`），`get_today` 扩展连续行军 6 字段（`:218-221`、`:227-232`），新增 `streak_service.compute_streaks` 调用。
- 关联文件：`backend/app/api/routes/sport.py:62-70`（新增 `GET /sport/calendar`）、`backend/app/schemas/schemas.py:178-199`（`CalendarDay`/`CalendarStats`/`SportCalendarOut`）、`backend/app/core/helpers.py`（同批新增 `to_local`/`local_to_utc`，修复日历点亮归格的 8 小时错位）、`backend/test/s3_aggregates.py`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `18c2121` 条目未记录验证字段，仅有「内容：新增小程序聚合接口（档案/足迹/日历/播报/知识画像）并扩展现有契约」）。**另有独立验收报告可作证据**：`backend/test/docs/s3-miniapp-aggregates-report.md`（2026-10-02，S3 阶段）记载 **15/15 通过**，其中 `:28` 为「C1/C2/C3 calendar 格子/统计/格式校验 ✓」、`:28` 同行为「S1 sport/today 连续行军字段 ✓」，`:41` 记录修复项「`sport_service.get_calendar` 点亮记录按月范围（UTC 边界）过滤、按本地日期归格」。

### 2026-10-01（`be7e126`）
- 需求：统一事件系统与连续行军机制（005 迁移配套）。
- 修改内容：53 insertions / 3 deletions。新增 `TOTAL_MILESTONES`（`:28`）、`_distance_of`（`:41-43`）、`_after_written`（`:46-68`）——即 `FIRST_STEP`/`STEP_10000`/`TOTAL_STEPS_*` 三类事件的写入点与 `distance` 派生；`sync_today` 改为提交后调用 `_after_written`。
- 关联文件：`backend/app/services/event_service.py`（同提交新建）、`backend/app/services/streak_service.py`（同提交新建）、`backend/app/models/models.py`（`UserEvent`）、`docker/init/005_upgrade.sql`、`backend/test/s2_streak_events.py`（同提交新建，186 行）与报告 `backend/test/docs/s2-events-streak-report.md`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `be7e126` 条目未记录验证字段，仅有「内容：新增统一事件系统与连续行军机制，勋章体系扩展判定并接入事件链」）。`be7e126` 提交信息自述「新增 S2 冒烟脚本（8/8 通过）与验收报告」。

### 2026-09-30（`a94e685`）
- 需求：项目初始化。
- 修改内容：创建本文件（98 行）：`DAILY_TARGET`（当时为 `10000`）、`_calc_total`（后被 `f59892e` 替换为 `get_total_steps`）、`sync_today(steps=None)`（当时可接受显式步数入参，`3df3fd0` 改签名）、`get_today`、`get_recent`、`add_steps`。
- 关联文件：仓库初始代码全量（`backend/`、`frontend/`）。
- 测试结果：待确认（`docs/迭代记录.md` 的 `a94e685` 条目仅有「内容：仓库初始代码。」，未记录验证字段）。
