# quiz_service.py

## 1. 文件路径
`backend/app/services/quiz_service.py`

## 2. 文件职责
每日答题的全部业务规则实现（V2.0 需求六「每题限时作答」）：按用户个人历史轮换抽题并缓存当日题组、逐题开题（每题 90 秒服务器计时）、每题一次提交即判定、超时处理、答题积分同事务同步、全部结束后生成当日答题记录，另含知识画像聚合与调试用重置。是路由层 `backend/app/api/routes/quiz.py` 6 个端点背后的唯一业务入口。

## 3. 业务需求
- V2.0 需求六「每题限时作答」：现行规则口径见 `.qoder/REQUIREMENTS.md` §5（题量/抽取/计时/提交/安全约束逐条列明，本文不复制其正文，只补文件级细节）。
- 情报化扩展（功能 8）：`issue_no`（第 N 期）与知识画像，模块 docstring `backend/app/services/quiz_service.py:14-16`。
- 用户独立题目轮换与题库不足明确状态：提交 `6f2cfc3`（2026-10-15），见 `.qoder/REQUIREMENTS.md` §5.1。
- 答题积分规则属积分体系 V2.0，见 `.qoder/REQUIREMENTS.md` §4.3 与 `.qoder/backend/app/services/points_service.py.md`。

## 4. 核心功能

### 4.1 模块常量（`backend/app/services/quiz_service.py:35-48`）
| 常量 | 值 | 说明 |
|---|---|---|
| `DAILY_COUNT` | 5 | 每日最多题数（`:35`） |
| `SCORE_PER_QUESTION` | 20 | 每题**得分**（score，满分 100，展示用）；与**积分**（points，答对 +2 封顶 10）是两套数字，勿混淆（`:36`、`:216`、`:245`） |
| `ANSWERING/ANSWERED/TIMEOUT` | `"answering"/"answered"/"timeout"` | 逐题状态机（`:37`） |
| `NOT_STARTED/ALREADY_ANSWERED/ANSWER_TIMEOUT` | 三条中文错误文案 | `ValueError` detail，路由转 400（`:39-41`） |
| `KNOWLEDGE_CATEGORIES` | event/route/figure 三类 | 知识画像分类，与 `questions.category` 取值对应（`:44-48`） |

### 4.2 内部工具函数
- `_issue_no`（`:51-55`）：第 N 期 = 当天与 `settings.ACTIVITY_START_DATE`（`"2026-09-01"`，读取于 `:53`）的天数差 + 1，早于起始日按 1 计。
- `_ms`（`:58-60`）：库内 UTC naive 时间 → 毫秒时间戳（按 UTC 解释）。
- `_grace`（`:63-64`）：`QUIZ_ANSWER_GRACE_SECONDS`（默认 2 秒）的 timedelta 形式。
- `_public_question`（`:67-75`）：作答阶段下发结构，只含 id/type/question/options/score，**不含 answer/analysis**。
- `_record_out`（`:78-91`）：`QuizRecord` → 响应 dict，派生 accuracy（正确率百分数）与 timeout_count（从 details 统计）。
- `_get_record`（`:94-99`）：按 user+date 查当日记录。
- `_question_usage`（`:102-128`）：用户各题已使用次数——以 `quiz_answers` 逐题记录为准；018 迁移之前已完成（无逐题数据）的历史场次回退按 `daily_questions.question_ids` join `quiz_records` 计数，`yield_per(500)` 流式读取（`:123`）。
- `_pick_questions`（`:131-146`）：分层轮换抽题——只取 `Question.active` 为真的题（`:133`），先抽「使用次数最少层」（`random.sample`），不足 5 题时跨入下一轮补足。
- `_session`（`:149-168`）：当日答题会话（`DailyQuestion` 抽题缓存，保证同日同一套题）；`create=True` 且缓存缺失/为空时抽题写入并 commit；题库不足打 warning 日志（`:159`）；并发首次获取由 `(user_id, date)` 唯一约束兜底，`IntegrityError` 回滚后以先写入者为准（`:164-168`）。**返回值是 `DailyQuestion` 对象（`daily_questions` 表行）**——这决定了积分台账 `ref_id` 的语义（见 §7）。
- `_answers`（`:171-178`）：本会话全部逐题作答行，按 seq 排序，`populate_existing()` 强制刷新。
- `_expire`（`:181-193`）：把 `deadline_at < cutoff` 且仍在 answering 的行标记 timeout——**条件 UPDATE（`status='answering'` 为 where 条件）**，与提交竞态只有一方生效；有变更才 commit。
- `_plan`（`:196-202`）：(本场总题数, 下一道待开题题目 id)；抽题后被删除（题库查不到）的题目不再开题、不计入总数。
- `_detail`（`:205-219`）：单题结果明细（含正确答案、解析、超时标记、score 与本题 points）。
- `_finalize`（`:222-272`）：全部题目结束后生成当日 `QuizRecord`（user+date 唯一）：先查已存在即直接返回（`:224-226`）；`db.flush()` 后调 `points_service.sync_quiz_day(..., session.id)` 再 `db.commit()`——**记录与答题积分台账同一事务**（`:258-261`）；`IntegrityError`（并发）回滚后返回他人已写入的记录（`:262-264`）；commit 成功后写 `QUIZ_COMPLETE` 事件、全对再写 `QUIZ_FULL_SCORE`（`:266-271`）。
- `_state`（`:275-319`）：今日答题状态响应体——issue_no、completed、total_count、题库不足标记与文案（`:308-311`）、time_limit（`:312` 下发 `QUIZ_QUESTION_SECONDS`）、server_time、逐题 progress（未开题的补 `pending` 占位）、current（含 started_at/deadline_at 毫秒时间戳与 remaining_ms，`:289-295`）、correct_count、points（经 `points_service.quiz_points` 实时计算，`:317`）、record。
- `_completed_state`（`:322-325`）：已有当日记录时的状态组装。

### 4.3 对外业务函数（被 `backend/app/api/routes/quiz.py` 调用）
| 函数 | 行号 | 路由端点 | 要点 |
|---|---|---|---|
| `get_daily` | `:328-344` | `GET /api/quiz/daily`（`backend/app/api/routes/quiz.py:24-27`） | 被动查询：先按「截止+宽限」判超时（`:339`），全部结束则 `_finalize` 生成记录（`:342-343`）；**不开题**，未开题时 current 为空 |
| `start` | `:347-384` | `POST /api/quiz/start`（`backend/app/api/routes/quiz.py:30-36`） | 幂等开题/继续：作答中且未截止返回同一题与剩余时间；当前题已截止则判超时并开下一题；最多重试 3 轮（`:357`），新题写 `QuizAnswer(started_at=now, deadline_at=now+90s)`（`:367-378`），`(session_id, seq)` 唯一约束冲突时回滚重读（`:379-382`） |
| `answer` | `:387-472` | `POST /api/quiz/answer`（`backend/app/api/routes/quiz.py:39-53`） | 提交即判定，见 §4.4 |
| `get_records` | `:475-483` | `GET /api/quiz/records`（`backend/app/api/routes/quiz.py:56-58`） | 记录列表（date 倒序），不含逐题 details 以控制体积 |
| `get_knowledge` | `:486-526` | `GET /api/quiz/knowledge`（`backend/app/api/routes/quiz.py:61-64`） | 知识画像：分母 = 该用户历史抽题缓存中各类题目出现次数（`:497-505`），分子错误数取自 `QuizRecord.wrong_list`（带 category 回退按 question_id 反查，`:507-513`）；另返回总正确率 overall_rate |
| `reset_today` | `:529-540` | `POST /api/quiz/reset`（`backend/app/api/routes/quiz.py:67-71`，调试用） | 删当日 `quiz_answers`/`quiz_records`/`daily_questions` 与当日答题积分台账行（按 `biz_key=quiz:日期` 删，`:536-539`），一次 commit；**不删 user_event 事件** |

### 4.4 `answer` 判定流程（`:387-472`）
1. 取当日会话（`create=False`，`:393`），按 `session_id + question_id` 定位作答行；行不存在 → `NOT_STARTED`（`:401-402`）；已 answered → `ALREADY_ANSWERED`（`:403-404`）；已 timeout → `ANSWER_TIMEOUT`（`:405-406`）。
2. 题目已下线（题库查不到）→ `ValueError("题目已下线")`（`:407-409`）。
3. 答案校验：去重排序后必须恰好 1 个选项（`:410-412`，**当前仅开放单选题**，见 `backend/app/services/ai_question_service.py:26` 注释），且必须是该题 options 中的合法 label（`:413-414`）。
4. 判定：`user_ans == sorted(q.answer)` 且正确答案非空才算对（`:416-417`）。
5. 本题积分 `gained` = `quiz_points(prior+1) - quiz_points(prior)`（prior 为本会话已答对数，`:418-425`）——用台账口径的差值，**单日封顶触顶后继续答对 gained=0**。
6. **条件 UPDATE**：where 含 `status='answering'` 且 `deadline_at >= now - 宽限`（`:426-443`），并发重复提交/提交与超时竞态只有一方生效；更新 0 行时回滚重读，区分「已被他请求答完」（`ALREADY_ANSWERED`）与超时（先按宽限补标 timeout 再抛 `ANSWER_TIMEOUT`）（`:444-450`）。
7. 更新成功后调 `points_service.sync_quiz_day(db, user_id, date, correct_count, session.id)` 并 `db.commit()`——**判定与当日答题积分同一事务**（`:451-453`）。
8. 若是最后一题则 `_finalize` 生成当日记录（`:455-457`），返回 `QuizAnswerOut` 结构（含 correct_answer/analysis/points/today_points/finished/record，`:458-472`）。

## 5. 输入与输出
- **入参**：均为 `(db: Session, user_id: int, ...)` 形式的服务层函数；`answer` 另收 `question_id: int` 与 `labels: List[str]`（请求模型 `QuizAnswerRequest`，`backend/app/schemas/schemas.py:528-532`，answer 数组 max_length=4）。
- **返回**：裸 dict/list，由路由声明的 `response_model` 转 camelCase——`get_daily`/`start` → `QuizDailyOut`（`backend/app/schemas/schemas.py:483-496`）、`answer` → `QuizAnswerOut`（`:499-512`）、`get_records` → `List[QuizRecordOut]`（`:454-464`）、`get_knowledge` → `QuizKnowledgeOut`（`:523-525`）。
- **异常**：业务失败一律抛 `ValueError`（中文 detail，`:39-41`、`:409`、`:412`、`:414`），由 `backend/app/api/routes/quiz.py:48-49` 统一转 `HTTPException 400`。
- **时间字段**：`server_time`/`started_at`/`deadline_at` 为 UTC 毫秒时间戳（`_ms`，`:58-60`）；`QuizRecord.answer_at` 亦是毫秒 BigInteger（`:255`；`backend/app/models/models.py:287`），不是 datetime。

## 6. 依赖关系
- **依赖模块**：`app.core.config.settings`（`:28`）、`app.core.helpers.today_str`（`:29`）、ORM 模型 `DailyQuestion/PointsLog/Question/QuizAnswer/QuizRecord`（`:30`）、`event_service` 与 `points_service`（`:31`）。
- **数据库表**：`daily_questions`（抽题缓存，`backend/app/models/models.py:290-299`）、`quiz_answers`（逐题作答，018 迁移，`backend/app/models/models.py:302-326`）、`quiz_records`（当日记录，`backend/app/models/models.py:271-287`）、`questions`（题库）、`points_log`（经 points_service 写入；reset_today 直接删当日 quiz 行 `:536-539`）、`user_event`（经 event_service 写入）。
- **被依赖**：`backend/app/api/routes/quiz.py`（6 个端点，`:19` import）；冒烟测试 `backend/test/s18_quiz_submit_feedback.py`、`backend/test/s22_history_sync_quiz_rotation.py:22`（直接调用 `_session`/`_question_usage`/`_plan` 等内部函数做白盒断言）。
- **事务边界（谁 commit）**：本服务**自行 commit**——`_session` 抽题（`:165`）、`_expire` 超时标记（`:192`）、`start` 开题（`:380`）、`answer` 判定+积分（`:453`）、`_finalize` 记录+积分（`:261`）、`reset_today`（`:540`）；事件写入由 `event_service.record` 在主数据 commit 后单独 commit（`backend/app/services/event_service.py:121`）。

## 7. 业务规则
- **每日 5 题、同日固定**：`DAILY_COUNT=5`（`:35`）；题组缓存于 `daily_questions`（user+date 唯一），当日重复进入不换题（`_session :149-168`）。
- **抽题轮换**：每用户独立，按逐题历史使用次数优先抽「最少使用层」，不足跨轮补足（`_pick_questions :131-146`）；只抽 `active` 题（`:133`），停用题保留在已生成会话中但 `_plan` 不再开题（`:196-202`）。
- **第 N 期**：以 `ACTIVITY_START_DATE="2026-09-01"` 为第 1 期（`_issue_no :51-55`）。
- **逐题限时**：每题 `QUIZ_QUESTION_SECONDS`（默认 90 秒，`backend/app/core/config.py`），开题即定 `deadline_at = 开题时间 + 90s`（`:375`），并作为 `time_limit` 下发（`:312`）；**计时只认服务器时间**（模块 docstring `:4`）。
- **宽限 `QUIZ_ANSWER_GRACE_SECONDS`（默认 2 秒）的确切作用范围**（`_grace :63-64`）：
  - `answer` 的条件 UPDATE 接受 `deadline_at >= now - 2s` 的提交——**截止后 2 秒内到达仍受理**（`:431`）；
  - 被动查询 `get_daily` 判超时同样给 2 秒宽限（`:339`），`answer` 失败路径补标 timeout 也用宽限（`:449`）；
  - **主动 `start` 开下一题不给宽限**：cutoff 就是 now（`:359`），即「开始下一题视为放弃当前题，截止即判超时」（docstring `:12`）。
- **每题一次提交、提交即判定**；超时不得分且不可再提交（`:403-406`；docstring `:5`）。
- **竞态约束**：判定与超时均以 `status='answering'` 为条件更新，并发重复提交/提交与超时只有一个生效（`:186-190`、`:428-432`；docstring `:10`）。
- **得分与积分两套口径**：score = 答对数 × 20（`:245`）；积分 = `points_service.quiz_points(答对数)` = 答对 × 2、单日封顶 10、不扣分（`:252`、`:317`、`:424`）。单题 `gained` 按封顶差值计算，触顶后为 0（`:423-425`）。
- **积分台账 `ref_id` 语义（关键）**：`sync_quiz_day` 传入的 `session.id` 是 **`daily_questions.id`（当日答题场次）**，不是 `quiz_records.id`（`:260`、`:452`；`_session` 返回 `DailyQuestion`，`:149`）。核对台账孤儿数据必须按 `daily_questions` join——按 `quiz_records` join 会得出虚假孤儿（开发库实测：按 `daily_questions` 为 0 孤儿）。
- **时区口径**：「哪一天」用北京时间（`today_str()`，`backend/app/core/helpers.py:22-24`；`get_daily/start/answer` 的 `date`，`:333`、`:352`、`:392`）；库内时间列（started_at/deadline_at/submitted_at）与计时 now 用 UTC naive（`datetime.utcnow()`，同上行；`backend/app/models/models.py:303` docstring「时间为 UTC」）。
- **安全**：只下发当前已开题的题目且不预先下发整套题，不含 answer/analysis（`_public_question :67-75`；docstring `:8`）；开题/截止/提交时间、作答、判定、超时全部落 `quiz_answers`（docstring `:9`）。
- **事件**：完成当日答题写 `QUIZ_COMPLETE`，全对再写 `QUIZ_FULL_SCORE`（`:266-271`），事件在记录 commit 之后写入。
- **中途退出**：已判定的题目与已得积分保留（逐题实时落库），下次进入从未完成的题继续。
- **题库不足**：不静默降级，返回 `question_shortage` 与明确文案（`:308-311`），并打 warning 日志（`:158-159`）。

## 8. 修改约束
- **积分发放必须走 `points_service`**，禁止直接写 `PointsLog`（`backend/AGENTS.md` §4 不变量 5；唯一例外是 `reset_today` 的调试性删除 `:536-539`）。判定与积分必须保持同一事务（`:451-453`、`:258-261`），拆开会产生「已判定但积分缺失」的中间态。
- **不得按 `quiz_records` 理解答题积分 `ref_id`**：它指向 `daily_questions.id`（见 §7）；做外键校验、孤儿清理或数据修复时按错误的表 join 会误报。
- **条件 UPDATE 的 where 子句（`status='answering'`、`deadline_at >= now - 宽限`）是并发正确性的根基**，不得改成「先查再改」；`_expire` 同理。
- **响应结构是前端契约**（camelCase 由 schemas 层转换）：改动 `_state`/`answer` 返回字段须同步 `backend/app/schemas/schemas.py:437-533` 与小程序 `frontend/services/quiz.js`（`backend/AGENTS.md` §4 不变量 1、4）。
- **副作用链**：路由在 `completed/finished` 后调 `medal_service.check_and_grant`（`backend/app/api/routes/quiz.py:34-35`、`:50-51`），并广播 `quiz.answer`/`quiz.reset` WS 事件（`:52`、`:70`）；改答题完成判定逻辑时不得绕过。
- **`GET /api/quiz/daily` 有写副作用**（建抽题缓存、判超时、生成记录），依赖 `require_activity_view` 而非 participation 守卫（`backend/app/api/routes/quiz.py:25`）——调整活动守卫时注意读写口径不同（`backend/app/api/deps.py:78-81`）。
- 删除题目一律走「停用」（`active=False`），不得物理删除，以保留已生成会话（`_plan` 对已删题的兜底 `:196-202` 只是防御）。
- `SCORE_PER_QUESTION=20`（score）与积分参数（`POINTS_QUIZ_PER_CORRECT` 等，定义于 `backend/app/core/config.py`）是两回事，改积分规则不要动 score。

## 9. 当前实现状态
- **已实现**：逐题限时作答全链路（开题/提交/超时/竞态防护）、用户独立轮换抽题、题库不足明确状态、答题积分同事务同步、当日记录与逐题明细、知识画像、期号、调试重置。
- **已知问题 / 事实性陈述**：
  - `POST /api/quiz/reset` 调试端点在生产环境暴露，可被用于重置答题状态刷分，尚无环境开关（`.qoder/REQUIREMENTS.md` §5.6、§13 第 13 条）。
  - 旧 e2e 脚本 `backend/test/e2e_full_flow.py`、`e2e_datasync`、`s3_aggregates` 仍按 V1 整卷提交口径编写（如 `backend/test/e2e_full_flow.py:281` 注释「每日答题 +5，满分额外 +10」），**其断言不是现行规则**（`.qoder/REQUIREMENTS.md` §15）。
  - 历史 `QuizRecord.details` 在 014 迁移前为 None，展示回退 wrong_list（`backend/app/models/models.py:285-286`）；`_record_out` 的 timeout_count 依赖 details，历史记录为 0（`:87`）。
  - `get_knowledge` 的分母按「抽题缓存出现次数」而非「实际作答次数」统计（`:487-490` docstring 自述口径），超时未作答的题也计入分母。
  - 曾存在的单题判题函数 `check_answer`（`2a178b7` 引入）已随 `25c954c`「提交后统一反馈」移除，现行文件无此函数。
- **待开发**：答题页「AI 讲解」按钮（后端接口已就绪，`.qoder/REQUIREMENTS.md` §5.5，属前端侧）。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/quiz_service.py`（10 个提交）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-15
- 需求：近 7 日步数补录与用户独立题目轮换（`6f2cfc3`）。
- 修改内容：抽题改为用户独立轮换——`_question_usage` 以逐题记录为准并回退历史场次、`_pick_questions` 最少使用层优先；题库不足返回明确状态（question_shortage/shortage_message）；删除题目改为停用、`_plan` 不再开题。
- 关联文件：`backend/app/services/points_service.py`、`backend/app/services/sport_service.py`、`docker/init/019、020` 迁移、小程序提示与积分展示。
- 测试结果：S22 专项 13/13、S18 限时答题回归 21/21、S20 V2 回归 25/25；Python 编译与 `node --check` 通过（`docs/迭代记录.md`）。遗留：当时本机 Docker 不可用，未执行真实 openGauss 019/020 迁移与 S11。

### 2026-10-13
- 需求：① V2.0 需求六「每题 90 秒限时作答」（`78a12ca`）；② V2.0 需求三/四「积分台账重构」（`2f3f333`）。
- 修改内容：`78a12ca` 重写为逐题作答——新增 `quiz_answers` 落库（018 迁移）、`start`/`answer` 逐题开题判定、移除整卷 `submit`、超时不得分不可再提交、答题积分按逐题答对数实时同步；`2f3f333` 答题积分改走台账（`sync_quiz_day` 与记录同事务），移除 V1 的「每日答题 +5 / 满分 +10」grant 调用，`reset_today` 改按 `biz_key` 删积分行。
- 关联文件：`backend/app/api/routes/quiz.py`、`backend/app/services/points_service.py`、`docker/init/017、018` 迁移、`backend/app/schemas/schemas.py`。
- 测试结果：`78a12ca`：s18 重写为限时作答用例 21/21（含 8 线程并发提交/开题只生效一次、宽限受理、封顶 10 分、核对重算无差异），s6/s11/s12/s19 全过，openGauss 并发冒烟通过；`2f3f333`：SQLite 冒烟 20/20、openGauss 回填核对 132 人 111 天差异 0、s11/s18/s19/s6 回归通过（`docs/迭代记录.md`）。

### 2026-10-12
- 需求：答题改为提交后统一反馈，防伪造刷分（`25c954c`）。
- 修改内容：移除单题判题接口与作答中对错/连胜提示；题目不下发 answer/analysis；提交须恰好覆盖今日全部题目；逐题结果落库 `quiz_records.details`（014 迁移）。
- 关联文件：`backend/app/api/routes/quiz.py`、`docker/init/014_quiz_result_details.sql`、`frontend/services/quiz.js`、结果页。
- 测试结果：后端 S18 14/14（含伪造刷分、非法选项、8 线程并发提交仅 1 次积分）；automator `v12-mine-quiz.cjs` A01–A07 通过；迁移 014 已应用到本地 openGauss（`docs/迭代记录.md`）。

### 2026-10-11
- 需求：热点查询 SQL 聚合化与去 N+1（`f59892e`，性能优化）。
- 修改内容：抽题只加载题目 id；判分只查今日抽中的题（原先两处全表加载题库）。
- 关联文件：`backend/app/services/rank_service.py`、`medal_service.py`、`streak_service.py`、`docker/init/012_perf_indexes.sql`。
- 测试结果：openGauss 已应用 012；e2e_full_flow 178/178、e2e_datasync 23/23、S2–S7 等全部通过，结果与旧实现逐项一致（`docs/迭代记录.md`；报告 `backend/test/docs/s14-hotspot-sql-report.md`）。

### 2026-10-08
- 需求：修复全链路测试发现的 4 处缺陷（`7607d7b`），其中 BUG-002 为「答题题目归属校验」。
- 修改内容：修复答题题目归属校验等 4 处缺陷并全量复测回归（对应现行 `answer` 按当日会话定位作答行、非本场题目返回「该题尚未开始作答」的校验，`backend/app/services/quiz_service.py:393-402`）。
- 关联文件：`backend/app/api/routes/quiz.py`、admin、docker。
- 测试结果：修复后复测轮通过，详见 `docs/测试报告.md` 第二轮（`docs/迭代记录.md`）。

### 2026-10-03
- 需求：长征人物志与答题连胜效果 P1-8（`2a178b7`）。
- 修改内容：新增即时判题 `check_answer` 与连胜反馈（该判题接口后于 `25c954c` 整体移除）。
- 关联文件：人物/关联表、人物志页、前端答题页。
- 测试结果：待确认（`docs/迭代记录.md` 该条目未记录验证字段；相关记载见 `backend/test/docs/p1-persons-report.md:14`）。

### 2026-10-02
- 需求：小程序聚合接口（`18c2121`）。
- 修改内容：新增知识画像 `get_knowledge`（按题目 category 聚合历史正确率，功能 8）。
- 关联文件：档案/足迹/日历/播报聚合路由。
- 测试结果：待确认（`docs/迭代记录.md` 该条目未记录验证字段）。

### 2026-10-01
- 需求：统一事件系统与连续行军机制（`be7e126`）。
- 修改内容：完成答题后写 `QUIZ_COMPLETE` / 满分写 `QUIZ_FULL_SCORE` 事件；wrong_list 增加 question_id 与 category 字段（知识画像的数据基础）。
- 关联文件：`backend/app/services/event_service.py`（新增）、`streak_service.py`（新增）、`medal_service.py`。
- 测试结果：`docs/迭代记录.md` 该条目未记录验证字段；提交 `be7e126` 的 commit message 载明「新增 S2 冒烟脚本（8/8 通过）与验收报告」。

### 2026-09-30
- 需求：项目初始化（`a94e685`）。
- 修改内容：创建本文件（V1 口径：每日随机 5 题、每题 20 分、整卷提交判分、每日答题 +5 满分额外 +10——该积分规则已随 `2f3f333` 废弃，见 `.qoder/REQUIREMENTS.md` §12）。
- 关联文件：仓库初始代码（backend + frontend）。
- 测试结果：待确认（`docs/迭代记录.md` 该条目未记录验证字段）。
