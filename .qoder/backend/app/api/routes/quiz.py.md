# quiz.py

## 1. 文件路径

`backend/app/api/routes/quiz.py`（72 行）

## 2. 文件职责

小程序每日一题域的 HTTP 路由层：今日答题状态、逐题开题、逐题提交作答、答题记录、知识画像，以及一个重置今日答题的调试端点。路由层只做参数接收、调 `quiz_service` / `medal_service`、`ValueError`→400 转换与 WS 广播；抽题、计时、判定、积分等规则全部在 service 层。

## 3. 业务需求

- V2.0 需求六「每题限时作答」：每用户按个人使用历史分轮随机抽题，每日最多 5 题且同日固定；每题 90 秒服务器计时，仅可提交一次，超时不得分（`backend/app/services/quiz_service.py:1-17` 模块 docstring；提交 `78a12ca`，2026-10-13）。
- 防伪造刷分：只下发「当前已开题」的题目且不含答案/解析；提交后统一反馈（提交 `25c954c`，2026-10-12）。
- 知识画像（功能 8）：按题目分类聚合历史正确率（提交 `18c2121`，2026-10-02）。
- 情报化：当天为活动第 N 期（`issue_no`，基准 `ACTIVITY_START_DATE=2026-09-01`，`backend/app/core/config.py:96`）。

## 4. 核心功能

### 4.1 端点清单（6 个，与 `app.openapi()` 实测一致）

路由前缀 `/quiz`（`quiz.py:21`），经 `backend/app/main.py:75` 以 `/api` 前缀挂载。

| 方法 | 完整路径 | 函数名 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| GET | `/api/quiz/daily` | `daily` | `quiz.py:24-27` | `require_activity_view` | `QuizDailyOut`（`backend/app/schemas/schemas.py:483`） |
| POST | `/api/quiz/start` | `start` | `quiz.py:30-36` | `require_activity_participation` | `QuizDailyOut` |
| POST | `/api/quiz/answer` | `answer` | `quiz.py:39-53` | `require_activity_participation` | `QuizAnswerOut`（`schemas.py:499`） |
| GET | `/api/quiz/records` | `records` | `quiz.py:56-58` | `require_activity_view` | `List[QuizRecordOut]`（`schemas.py:454`） |
| GET | `/api/quiz/knowledge` | `knowledge` | `quiz.py:61-64` | `require_activity_view` | `QuizKnowledgeOut`（`schemas.py:523`） |
| POST | `/api/quiz/reset` | `reset` | `quiz.py:67-71` | `require_activity_participation` | `MessageOut`（`schemas.py:728`） |

### 4.2 调用的 service 函数

| 路由 | service 调用 | 位置 |
|---|---|---|
| `daily` | `quiz_service.get_daily` | `backend/app/services/quiz_service.py:328-344` |
| `start` | `quiz_service.start`；完成时 `medal_service.check_and_grant` | `quiz_service.py:347-384`；`quiz.py:33-35` |
| `answer` | `quiz_service.answer`；finished 时 `check_and_grant` | `quiz_service.py:387-472`；`quiz.py:47`、`:50-51` |
| `records` | `quiz_service.get_records` | `quiz_service.py:475-483` |
| `knowledge` | `quiz_service.get_knowledge` | `quiz_service.py:486-526` |
| `reset` | `quiz_service.reset_today` | `quiz_service.py:529-540` |

WS 广播：`answer` 每次提交成功后广播 `quiz.answer`（`quiz.py:52`，无论是否 finished）；`reset` 广播 `quiz.reset`（`:70`）。`start`/`daily` 不广播。广播经 `backend/app/core/ws.py:23`/`:62`。

### 4.3 作答链路的超时、宽限期与重复作答拒绝

规则本体在 `quiz_service.answer`（`quiz_service.py:387-472`），路由层只把 `ValueError` 转 400（`quiz.py:48-49`）：

- **计时只认服务器时间**：每题时限 `QUIZ_QUESTION_SECONDS=90` 秒（`backend/app/core/config.py:97`），开题时写 `started_at`/`deadline_at`（`quiz_service.py:367-377`）。
- **宽限期**：截止后 `QUIZ_ANSWER_GRACE_SECONDS=2` 秒内到达的提交视为网络延迟仍受理（`config.py:98`；`quiz_service.py:11` docstring、`:63-64` `_grace`、`:431` 条件更新 `deadline_at >= now - _grace()`）；被动查询（daily/start）按「截止+宽限」判超时（`:339`、`:359`）。
- **重复作答拒绝**：状态机 `answering/answered/timeout`（`quiz_service.py:37`）；已作答再提交抛 `ValueError(ALREADY_ANSWERED)`＝「本题已作答，不能重复提交」→ 400（`:40`、`:403-404`）；已超时抛 `ANSWER_TIMEOUT` → 400（`:41`、`:405-406`）；未开题抛 `NOT_STARTED` → 400（`:39`、`:401-402`）。并发重复提交/提交与超时竞态由**条件 UPDATE（status='answering' 才生效）**保证只有一方成功（`:10` docstring、`:426-450`）。
- **其它 400**：题目已下线（`:407-409`）、未选答案「请选择一个答案后提交」（`:410-412`）、选项无效（`:413-414`）。
- **start 幂等**：作答中且未截止返回同一题与剩余时间；当前题已截止则判超时并开下一题（`quiz_service.py:347-384`；`quiz.py:32` docstring）。

### 4.4 答题积分重算与 `ref_id` 指向

- 每次判定与积分台账**同一事务**写入：`points_service.sync_quiz_day(db, user_id, date, correct_count, session.id)`，传参点 `quiz_service.py:260`（`_finalize` 生成当日记录时）与 `:452`（`answer` 判定后），随后由调用方 commit（`:261`、`:453`）。
- **`ref_id` = `session.id`，即 `daily_questions.id`（当日答题会话），不是 `quiz_records.id`**（2026-10-17 用户实测确认，与 `.qoder/ARCHITECTURE.md` §16.1 一致；台账重算侧同口径，`backend/app/services/points_service.py:281-288`）。
- 积分公式在 `points_service.quiz_points`：答对数 × 2，单日上限 10，不扣分（`points_service.py:59-61`；`config.py:103-104`）。台账行 `biz_key = quiz:{日期}`，每用户每天一行、覆盖式重算幂等（`points_service.py:64-97`、`:121-125`）。

### 4.5 抽题与每日固定

- 当日会话 `daily_questions`（user+date 唯一）缓存抽题结果，保证同日同一套题；并发首抽以先写入为准（`quiz_service.py:149-168`，`IntegrityError` 回滚重读）。
- 抽题按**用户独立轮换**：先取个人使用次数最少的一层随机，不足跨轮补足（`_pick_questions` `:131-146`；使用次数以 `quiz_answers` 为准、018 之前历史回退 `daily_questions`，`:102-128`）。题库不足 5 题时下发 `questionShortage`/`shortageMessage`（`:308-311`）。

### 4.6 `POST /api/quiz/reset`（调试端点，生产暴露）

- summary 即「重置今日答题（调试用）」（`quiz.py:67`）。service 行为：删除该用户当日的 `quiz_answers`、`quiz_records`、`daily_questions` 三表行，并**直接按 `biz_key=quiz:{日期}` 删除 `points_log` 台账行**，然后 commit（`quiz_service.py:529-540`）。
- **无环境开关**：`grep settings.DEBUG / APP_ENV` 在 `backend/app/api/routes/` 与 `quiz_service.py` 中零命中（2026-10-17 实测）。生产暴露，配合 `/quiz/start`+`/quiz/answer` 可反复重置刷答题积分（每日上限 10 分 × 无限次），已列为已知风险（`.qoder/ARCHITECTURE.md` §15 第 5 项、§16 第 11 项）。
- 小程序端有**可见的开发调试入口**：quiz 页「开发调试：重置本期情报」文字按钮（`frontend/pages/quiz/quiz.wxml:68`），经确认弹窗调 `resetToday`（`frontend/pages/quiz/quiz.js:103-122`；`frontend/services/quiz.js:63-64`）——即生产用户也能触达该端点，放大 §9 问题 1 的刷分风险。
- 两处与 `backend/AGENTS.md` 的偏差见 §9：直接删 `PointsLog`（不变量 5 要求积分统一走 `points_service`）；reset 后不回收已发勋章、也不重放 `check_and_grant`。

## 5. 输入与输出

| 端点 | 输入 | 输出（camelCase，`CamelModel`） |
|---|---|---|
| `GET /api/quiz/daily` | 无 | `QuizDailyOut`：date/issueNo/completed/totalCount/questionShortage/shortageMessage/timeLimit(=90)/serverTime(毫秒)/progress[]/current(未开题为 null)/correctCount/points/record（`schemas.py:483-496`） |
| `POST /api/quiz/start` | 无 body | 同 `QuizDailyOut`；current 含 seq/question(不含答案解析)/startedAt/deadlineAt/remainingMs（`schemas.py:473-481`） |
| `POST /api/quiz/answer` | `QuizAnswerRequest`：`questionId`(int, 别名)、`answer`(string[]，max_length=4)（`schemas.py:528-532`，`BaseModel` 非 CamelModel，靠 alias 收 camelCase） | `QuizAnswerOut`：seq/questionId/status/correct/userAnswer/correctAnswer/analysis/points/correctCount/todayPoints/totalCount/finished/record（`schemas.py:499-512`） |
| `GET /api/quiz/records` | 无 | `List[QuizRecordOut]` 从新到旧；**列表不含逐题 details 以控制体积**（`quiz_service.py:476`）；`answerAt` 为毫秒 BigInteger（`schemas.py:464`；`models.py:271` QuizRecord） |
| `GET /api/quiz/knowledge` | 无 | `QuizKnowledgeOut`：categories[]（key=event/route/figure，name/rate/asked/wrong，`quiz_service.py:44-48`）+ overallRate |
| `POST /api/quiz/reset` | 无 body | `MessageOut`：`{"message": "已重置今日答题"}`（`quiz.py:71`） |

错误码：400（service `ValueError`：NOT_STARTED / ALREADY_ANSWERED / ANSWER_TIMEOUT / 题目已下线 / 请选择一个答案后提交 / 答案选项无效）；401；403（停用 / 活动准入，响应头见 `.qoder/ARCHITECTURE.md` §4.6）；422（answer 超 4 项等 Pydantic 校验）。

## 6. 依赖关系

- **依赖模块**：`app.api.deps`、`app.core.ws`、`app.models.models.User`、`app.schemas.schemas`（6 个模型）、`app.services.medal_service`、`app.services.quiz_service`（`quiz.py:4-19`）。
- **service 层再依赖**：`points_service`（台账同事务重算）、`event_service`（QUIZ_COMPLETE / QUIZ_FULL_SCORE，`quiz_service.py:266-271`）、`core.config.settings`、`core.helpers.today_str`（北京时间日切，`backend/app/core/helpers.py:22-24`）。
- **数据库表**：`daily_questions`（当日会话/抽题缓存）、`quiz_answers`（逐题作答）、`quiz_records`（当日记录，user+date 唯一）、`questions`（题库）、`points_log`（quiz 行）、`user_event`、`user_medals`。
- **被谁依赖**：`backend/app/main.py:75` 注册；小程序 `frontend/services/quiz.js`（`:17` daily、`:25` start、`:37` answer、`:48` knowledge、`:56` records、`:64` reset）；答题讲解 AI 接口在 `backend/app/api/routes/ai.py`（独立域）。

## 7. 业务规则

1. **每日一题（5 题）规则**：每日最多 5 题（`DAILY_COUNT=5`，`quiz_service.py:35`）、同日固定、个人轮换随机（§4.5）；每题 20 分（`SCORE_PER_QUESTION=20`，`:36`），当日 score = 答对数 × 20。
2. **答题积分**：答对 × 2、上限 10、不扣分（`points_service.py:59-61`）；V2.0 起由台账覆盖式重算，重复提交/重放幂等（`points_service.py:8-10` docstring）。
3. **超时语义**：超时不得分、之后不可再提交；主动「开始下一题」视为放弃当前题、截止即判超时（`quiz_service.py:12` docstring）。
4. **勋章链**：当日全部完成（`completed`/`finished`）时路由层触发 `check_and_grant`（`quiz.py:34-35`、`:50-51`），对应「learner 完成 10 次答题」等判定（`backend/app/services/medal_service.py:66-67`）——不变量 5 已满足。
5. **被动判超时**：`GET /api/quiz/daily` 也可能写库（`_expire` 判超时、`_finalize` 生成当日记录与积分行，`quiz_service.py:339-343`）——读端点带写副作用，是本域的既定设计（`quiz_service.py:11`「被动查询亦按此宽限判定超时」）。
6. **期号**：`issueNo` 以 `ACTIVITY_START_DATE` 为第 1 期，早于起始日按 1 计（`quiz_service.py:51-55`）。

## 8. 修改约束

1. **事务边界：service 自提交**——`_session`/`_expire`/`start`/`answer`/`_finalize`/`reset_today` 内部各自 commit（`quiz_service.py:165`、`:192`、`:380`、`:453`、`:261`、`:540`）；`answer` 的判定更新与 `sync_quiz_day` 必须保持同事务（`:426-453`），拆开会产生「已判定但积分未入账」的中间态。
2. 不得绕过 `points_service` 写/删答题积分（不变量 5）；`ref_id` 必须继续传 `daily_questions.id`（§4.4），改成 `quiz_records.id` 会破坏台账重算 `_expected_for` 的对账口径（`points_service.py:281-288`）。
3. 题目下发不得包含 `answer`/`analysis`（作答阶段结构 `_public_question`，`quiz_service.py:67-75`；解析仅在提交后返回）。
4. `QuizAnswerRequest.answer` 上限 4 项、判定要求恰好 1 项（单选，`quiz_service.py:411-412`）——改多选需同步 service 判定与前端。
5. 响应保持 camelCase 契约；`answerAt` 毫秒整数口径不得改成 ISO 字符串（`models.py:271` QuizRecord、`schemas.py:464`）。

## 9. 当前实现状态

- **已实现**：6 个端点全部可用；逐题限时、宽限受理、并发竞态单生效、台账同事务、个人轮换抽题、知识画像齐备。
- **存在问题**：
  1. `POST /api/quiz/reset` 调试端点**无环境开关、生产暴露**，可无限刷答题积分（`.qoder/ARCHITECTURE.md` §15 第 5 项，截至 2026-10-17 未处理）。
  2. `reset_today` 在 service 内**直接删除 `PointsLog` 行**（`quiz_service.py:536-539`），未经过 `points_service`——`backend/AGENTS.md` 不变量 5 要求「积分发放必须统一走 points_service，禁止直接写 PointsLog」；删除属台账变更，同样绕开了统一入口（偏差点在 service 层而非本路由文件，如实记录）。
  3. `reset` 后已发放的勋章不回收（`user_medals` 不动），且不调用 `check_and_grant`；「learner 完成 10 次答题」按 `quiz_records` 计数（`medal_service.py:47`），重置当日记录会使计数与已发勋章不一致（勋章只增不减，无实际回收需求，属已知语义）。
- **待开发**：无（答题 AI 讲解在 `routes/ai.py`，前端入口待开发，见 `.qoder/ARCHITECTURE.md` §11.3）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/quiz.py`（7 个提交，2026-10-17 核对）；验证细节见 `docs/迭代记录.md` 对应条目。按时间倒序、按主题归并。

### 2026-10-13（`78a12ca`）

- 需求：答题改为逐题限时作答（V2.0 需求六）。
- 修改内容：本文件改为 start/answer 逐题开题判定结构；每题 90 秒服务器计时、超时不得分不可再提交；答题积分按逐题答对数实时同步。
- 关联文件：`backend/app/services/quiz_service.py`（重写）、`docker/init/018_*.sql`（quiz_answers）、`backend/app/models/models.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-13（`ce14a95`）

- 需求：V2.0 活动时间控制。
- 修改内容：全部端点接入活动准入依赖（daily/records/knowledge 为 view，start/answer/reset 为 participation）。
- 关联文件：`backend/app/api/deps.py`、`backend/app/services/activity_service.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-12（`25c954c`）

- 需求：答题改为提交后统一反馈，防伪造刷分。
- 修改内容：移除单题判题接口与作答中对错提示；题目不下发答案与解析；逐题结果落库（迁移 014）。
- 关联文件：`backend/app/services/quiz_service.py`、`frontend/pages/quiz-result/`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-03（`2a178b7`）

- 需求：长征人物志与答题连胜效果（P1-8）。
- 修改内容：即时判题连胜反馈（后被 `25c954c`/`78a12ca` 的形态取代）。
- 关联文件：`backend/app/api/routes/persons.py`、`frontend/pages/quiz-answer/`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-02（`18c2121`）

- 需求：小程序聚合接口批次。
- 修改内容：新增 `GET /api/quiz/knowledge` 知识画像；`daily` 返回 issueNo；wrongList 暴露 questionId/category。
- 关联文件：`backend/app/services/quiz_service.py`、`backend/app/schemas/schemas.py`。
- 测试结果：据提交信息 —— S3 冒烟 **15/15**（`backend/test/s3_aggregates.py` + 验收报告）。

### 2026-10-01（`82af32c`）

- 需求：管理端实时数据变更通知。
- 修改内容：answer/reset 成功后 WS 广播。
- 关联文件：`backend/app/core/ws.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-09-30（`a94e685`）

- 需求：项目初始化。
- 修改内容：创建本文件（当时为整卷提交/判题形态，后续多次重构）。
- 关联文件：仓库初始代码。
- 测试结果：`docs/迭代记录.md` 该条目未记载验证结果，待确认。
