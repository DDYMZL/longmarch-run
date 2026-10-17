# sport.py

## 1. 文件路径

`backend/app/api/routes/sport.py`（83 行）

## 2. 文件职责

小程序运动域的 HTTP 路由层：微信运动步数同步、今日步数概况、最近 n 天记录、行军日历，以及一个手动补步数的调试端点。本文件只做参数接收、调 `sport_service` / `medal_service`、`ValueError`→`HTTPException` 转换与 WebSocket 广播，不含业务规则（分层约定见 `backend/AGENTS.md` §3.1）。

## 3. 业务需求

- 步数是全部业务（路线点亮、连续行军、步行积分、勋章）的唯一运动源数据；V1.0 起要求接入微信运动真实数据、杜绝模拟步数写库（提交 `3df3fd0`，2026-10-10）。
- 近 7 日步数补录与结余积分口径来自 V2.0 积分台账重构（提交 `6f2cfc3`，2026-10-15）。
- 行军日历对应聚合接口批次（提交 `18c2121`，2026-10-02）；「行军日历（功能 3）」见 `backend/app/services/sport_service.py:246` docstring。
- 活动时间准入（V2.0 需求一）：写接口按活动状态 403 拦截、读接口结束后可按配置放行（提交 `ce14a95`，2026-10-13）。

## 4. 核心功能

### 4.1 端点清单（5 个，与 `app.openapi()` 实测一致）

路由前缀 `/sport`（`sport.py:21`），经 `backend/app/main.py:73` 以 `settings.API_PREFIX`（`/api`）挂载。

| 方法 | 完整路径 | 函数名 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| GET | `/api/sport/today` | `today` | `sport.py:24-26` | `require_activity_view` | `SportToday`（`backend/app/schemas/schemas.py:133`） |
| POST | `/api/sport/sync` | `sync` | `sport.py:29-50` | `require_activity_participation` | `SportSync`（`schemas.py:151`） |
| GET | `/api/sport/recent` | `recent` | `sport.py:53-59` | `require_activity_view` | `List[RecentItem]`（`schemas.py:172`） |
| GET | `/api/sport/calendar` | `calendar` | `sport.py:62-70` | `require_activity_view` | `SportCalendarOut`（`schemas.py:196`） |
| POST | `/api/sport/add` | `add_steps` | `sport.py:73-82` | `require_activity_participation` | `SportToday` |

两个准入依赖由 `backend/app/api/deps.py:56-81` 的 `_activity_guard` 工厂产出：内部先 `get_current_user`（401/停用 403 优先），再按 `activity_settings` 判活动状态，拒绝时 403 + `X-Activity-Status` 响应头（`deps.py:68-72`）。

### 4.2 调用的 service 函数

| 路由 | service 调用 | 位置 |
|---|---|---|
| `today` | `sport_service.get_today` | `backend/app/services/sport_service.py:210-233` |
| `sync` | `sport_service.sync_today` | `sport_service.py:135-207` |
| `sync` / `add_steps` | `medal_service.check_and_grant` | `sport.py:48`、`:80`；实现 `backend/app/services/medal_service.py:33-113` |
| `recent` | `sport_service.get_recent` | `sport_service.py:318-327` |
| `calendar` | `sport_service.get_calendar` | `sport_service.py:245-315` |
| `add_steps` | `sport_service.add_steps` + `get_today` | `backend/app/services/sport_service.py:330-342`；`sport.py:79`、`:82` |

WebSocket 广播：`sync` 成功后广播 `sport.sync`（`sport.py:49`），`add_steps` 广播 `sport.add`（`:81`），均走 `backend/app/core/ws.py:23`（`build_event`）与 `:62`（`broadcast`）。

### 4.3 `POST /api/sport/sync` 完整链路（微信运动数据校验）

1. **请求体可选**：`payload: Optional[SportSyncRequest] = None`，缺省时 `body = payload or SportSyncRequest()`（`sport.py:31`、`:36`）。`SportSyncRequest`（`schemas.py:164-169`）三个可选字段 `code` / `encryptedData` / `iv`（camelCase 入参）。
2. **步数解析** `sport_service._resolve_steps`（`sport_service.py:71-102`）：
   - 已配置 `WX_APPID`/`WX_SECRET` 且三字段齐全：`code2session(code)` 换 `session_key`（`backend/app/core/wx.py:18-42`），失败抛 `ValueError("微信会话换取失败，请重新同步")`；随后 `decrypt_werun` 做 AES-128-CBC 解密并**校验 `watermark.appid` 与配置一致**（`wx.py:45-61`），解密或校验失败抛 `ValueError("微信运动数据解密失败/校验失败，请重新同步")`；解析 `stepInfoList` 按北京时间自然日建 `{日期: 步数}` 映射（`sport_service.py:91-96`），空结果抛 `ValueError`（`:97-98`）。
   - 仅 mock 登录用户（openid 以 `mock_` 开头）或未配置微信凭证时，回退 `seeded_steps` 稳定伪随机模拟（`sport_service.py:100-101`；`backend/app/core/helpers.py:47-58`，4000~12999）。
   - **真实用户未携带加密数据：抛 `ValueError("未获取到微信运动数据…")`，绝不写编造步数**（`sport_service.py:102`）。
3. **伪造数据 400 且零写入**：上述所有 `ValueError` 都在路由层被转成 400（`sport.py:46-47`）；`_resolve_steps` 在 `sync_today` 内位于任何数据库写入之前（`sport_service.py:149`，用户行锁 `:151`、逐日 upsert `:174` 均在其后），因此校验失败时**没有任何落库**。冒烟 `backend/test/s11_sport_sync_werun.py` 覆盖「加解密往返 / watermark 校验 / 伪造数据 400 零写入」场景（见 `.qoder/backend/requirements.txt.md` §10 的 2026-10-10 条目引文与 `backend/test/docs/`）。
4. **步数覆盖规则（同日重复同步）**：同步范围为最近 7 个北京时间自然日（`recent_dates(7)`，`sport_service.py:148`）；每日以**微信最终值覆盖而非累加**（`_upsert_day`，`sport_service.py:114-132`，模块 docstring `:3-5`）；同日重复同步幂等——逐日行锁 `with_for_update()`（`_lock_day`，`:105-111`）+ 用户行锁串行化（`:151`），值未变化则不产生副作用（`:132` 的 `changed` 判定）。微信本次未返回的日期**不写 0、不覆盖已有记录**，进 `failed_dates` 允许后续重试（`:145`、`:157-165`）；负数/非法格式跳过并入 `failed_dates`（`:166-173`）。
5. **积分与提交**：有处理日期时调 `points_service.recompute_walk`（`sport_service.py:180`）按运动源数据全量修复该用户步行台账（结余口径，`backend/app/services/points_service.py:100-108`），随后 `db.commit()`（`:182`）；`IntegrityError` 回滚并抛 `ValueError("步数同步冲突，请稍后重试")` → 400（`:183-185`）。
6. **提交后副作用** `_after_written`（`sport_service.py:46-68`）：`FIRST_STEP` / `STEP_10000` / `TOTAL_STEPS_100000` / `TOTAL_STEPS_500000` 事件（经 `event_service.record` 去重与广播）+ `streak_service.on_sport_written` 维护连续行军与 `DAILY_GOAL`/`STREAK_*` 事件（`backend/app/services/streak_service.py:62-104`）。
7. **勋章**：路由层在 service 成功返回后调 `medal_service.check_and_grant`（`sport.py:48`），满足 `backend/AGENTS.md` 不变量 5「sync 必须触发勋章检查」。

响应 `SportSync`（`schemas.py:151-161`）：`date/steps/totalSteps/synced/status(success|partial)/processedDates/failedDates/pointsChange/todayWalkPoints/walkCarry`。

### 4.4 `GET /api/sport/calendar` 的月份参数校验

`month` 为必填 Query（`sport.py:64`），路由层做**格式校验**（长度 7、第 5 位为 `-`、去 `-` 后全数字），不合法 400「month 格式应为 YYYY-MM」（`sport.py:68-69`）。这属于参数校验而非业务规则，符合分层约定。service 侧返回整月逐日步数与热力档位（0=0 步 / 1=1~4999 / 2=5000~9999 / 3=10000+，`sport_service.py:236-242`）、答题标记（`quiz_records`，`:263-268`）、点亮标记（`lit_nodes` join `route_nodes`，UTC 存储转本地日期归格，`:270-283`）与月度统计（`:305-315`）。

### 4.5 `POST /api/sport/add`（调试端点，生产暴露）

- summary 即「手动补充步数（演示用）」（`sport.py:73`）。请求体 `AddStepsRequest.delta`，`Field(0, ge=0)`（`schemas.py:202-205`）——**负数会被 Pydantic 拦为 422，但正数无上限**。
- service 行为：当天已有步数上累加 `delta`，`source="manual"`，随后同样 `recompute_walk` + commit + 副作用链（`backend/app/services/sport_service.py:330-342`）。
- **无任何环境开关**：`grep settings.DEBUG / APP_ENV` 在 `backend/app/api/routes/` 与 `sport_service.py` 中零命中（2026-10-17 实测）；`Settings` 虽有 `DEBUG`（`backend/app/core/config.py:26`）与 `APP_ENV`（`:28`）字段，但本端点未使用。生产环境暴露、可被用于刷步数/刷积分，已列为已知风险（`.qoder/ARCHITECTURE.md` §15 第 5 项、§16 第 11 项）。
- 小程序端**不调用**本端点（`frontend/services/sport.js` 只调 sync/today/calendar/recent，`:99/:112/:122/:131`）；调用方仅测试脚本（如 `backend/test/e2e_datasync.py:137`、`backend/test/e2e_full_flow.py:173`）。

## 5. 输入与输出

| 端点 | 输入 | 输出（camelCase，`CamelModel`，`schemas.py:17-22`） |
|---|---|---|
| `GET /api/sport/today` | 无参数（身份取自 JWT） | `SportToday`：date/steps/target(=20000，`sport_service.py:27`)/totalSteps/currentStreak/maxStreak/streakGoal(=5000，`config.py:95`)/todayGoalCompleted/nextStreakMilestone/streakRemain |
| `POST /api/sport/sync` | 可选 body `{code, encryptedData, iv}` | `SportSync`（见 §4.3） |
| `GET /api/sport/recent` | `n`：Query，默认 7，范围 1~90（`sport.py:55`） | `List[RecentItem]`：date/steps/text（`MM-DD`，`sport_service.py:327`），从旧到新 |
| `GET /api/sport/calendar` | `month`：必填 `YYYY-MM` | `SportCalendarOut`：month/days[]/stats |
| `POST /api/sport/add` | body `{delta}`（≥0） | `SportToday`（补步后重查，`sport.py:82`） |

错误码：400（`ValueError` 转换：微信换取/解密/校验失败、无数据、同步冲突；month 格式非法）；401（令牌无效，`deps.py:22-41`）；403（账号停用 `X-Account-Status: disabled`，`deps.py:46-53`；活动准入拒绝 `X-Activity-Status`，`deps.py:66-72`）；422（Pydantic 参数校验，如 `delta<0`、`n` 越界）。无响应信封，2xx 直接返回业务 payload（`.qoder/ARCHITECTURE.md` §4.1）。

## 6. 依赖关系

- **依赖模块**：`app.api.deps`（两个活动准入依赖 + `get_db` 重导出）、`app.core.ws`（广播）、`app.core.database.get_db`、`app.models.models.User`、`app.schemas.schemas`（6 个模型）、`app.services.medal_service`、`app.services.sport_service`（`sport.py:7-19`）。
- **service 层再依赖**：`core.wx`（code2session / decrypt_werun）、`core.helpers`（北京时间口径）、`points_service`、`streak_service`、`event_service`（`sport_service.py:21-25`）。
- **数据库表**：`daily_sport`（读写，user+date 唯一）、`users`（行锁串行化 + 连续天数缓存）、`points_log`（经 points_service 写）、`user_medals`（经 medal_service 写）、`user_event`（经 event_service 写）、`quiz_records` / `lit_nodes` / `route_nodes`（日历只读）。
- **被谁依赖**：`backend/app/main.py:73` 注册；小程序 `frontend/services/sport.js`（sync/today/calendar/recent）；测试脚本（含 `/sport/add`）。

## 7. 业务规则

路由层不含业务规则，以下为链路上必须知道的规则**所在位置**：

1. **步数覆盖**：同 user+date 一行，微信最终值覆盖、不累加；缺日不补 0（`sport_service.py:3-5`、`:114-132`、`:145`）。
2. **步行积分**：累计结余口径，每满 1000 步得 1 分、零头结转（`config.py:102`；`points_service.py:34-56`）；每次同步在同事务内 `recompute_walk` 全量修复（`sport_service.py:180`）。
3. **连续行军**：每日达标线 5000 步（`config.py:95`），达标翻转与里程碑事件由 `streak_service.on_sport_written` 维护（`streak_service.py:62-104`）。
4. **勋章副作用链**：sync / add 之后必须 `check_and_grant`（`backend/AGENTS.md` 不变量 5；本文件 `:48`、`:80` 已满足）。
5. **幂等与并发**：逐日 `with_for_update()` 行锁 + 用户行锁 + 覆盖式重算，重复同步结果一致（`sport_service.py:105-111`、`:151`；`.qoder/ARCHITECTURE.md` §9.1）。
6. **模拟步数边界**：仅 mock openid 或未配置微信凭证才允许 `seeded_steps` 回退（`sport_service.py:100-102`、`backend/app/core/helpers.py:48-53` docstring）。

## 8. 修改约束

1. **事务边界：service 自提交**（`sync_today` 在 `sport_service.py:182`、`add_steps` 在 `:340` commit；`event_service.record` 与 `streak_service` 内部也各自 commit）。路由层不得再 commit。
2. 响应模型必须保持 `CamelModel` camelCase 契约，与 `frontend/services/sport.js` 消费结构一致（`backend/AGENTS.md` 不变量 1、4）。
3. 不得绕过 `points_service` 直接写 `PointsLog`（不变量 5）；步数写入后必须走 `recompute_walk`。
4. 修改 sync/add 时必须保留 `medal_service.check_and_grant` 调用与 `ws_manager.broadcast`，否则破坏管理端实时刷新与勋章链。
5. `ValueError`→400 的转换模式（`sport.py:46-47`）是约定异常通道；service 新失败场景应抛 `ValueError` 而非在路由加判断。
6. 若给 `/api/sport/add` 加环境开关（建议项，见 §9），不得影响测试脚本以外的既有契约；改动需同步 `.qoder/ARCHITECTURE.md` §15 第 5 项。

## 9. 当前实现状态

- **已实现**：5 个端点全部可用；微信运动真实数据链路（code2session → AES 解密 → watermark 校验 → 逐日覆盖 → 积分重算 → 勋章 → 广播）完整；伪造/缺失数据 400 且零写入。
- **存在问题（已知风险项）**：
  1. `POST /api/sport/add` 为演示用调试端点，**无环境开关、生产暴露**，`delta` 无上限可刷步数与步行积分（`schemas.py:205` 仅挡负数）。`.qoder/ARCHITECTURE.md` §15 第 5 项已登记，截至 2026-10-17 未处理。
  2. mock 回退（`seeded_steps`）在**未配置微信凭证的部署**上对所有用户生效（`sport_service.py:100-101` 的 `not has_creds` 分支）；生产已配置凭证则不触发。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/sport.py`（6 个提交，2026-10-17 核对）；验证细节见 `docs/迭代记录.md` 对应条目。按时间倒序、按主题归并。

### 2026-10-15（`6f2cfc3`）

- 需求：近 7 日步数补录按结余口径计积分；答题按用户独立轮换。
- 修改内容：本文件仅改 `/sync` 的 summary 文案（「同步今日步数」→「同步微信运动近 7 日步数」）；同提交在 `backend/app/schemas/schemas.py` 为 `SportSync` 扩展 `pointsChange` / `todayWalkPoints` / `walkCarry` 字段，并重写 `backend/app/services/sport_service.py` 的同步实现（`git show 6f2cfc3 --stat` 实测核对）。
- 关联文件：`backend/app/services/sport_service.py`、`backend/app/services/points_service.py`、`backend/app/schemas/schemas.py`、`docker/init/019_sport_backfill_carry.sql`；测试报告 `backend/test/docs/s22-history-sync-quiz-rotation-report.md`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目与 s22 报告。

### 2026-10-13（`ce14a95`）

- 需求：V2.0 活动时间控制。
- 修改内容：全部端点接入活动准入依赖——写接口 `require_activity_participation`、读接口 `require_activity_view`（403 + `X-Activity-Status`）；业务日期统一北京时间。
- 关联文件：`backend/app/api/deps.py`、`backend/app/services/activity_service.py`、`docker/init/`（activity_settings 迁移）。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-10（`3df3fd0`）

- 需求：步数同步接入微信运动真实数据，杜绝模拟步数写库。
- 修改内容：`POST /api/sport/sync` 增加可选加密数据请求体（code/encryptedData/iv），后端解密与 watermark 校验；真实用户缺数据抛 400。
- 关联文件：`backend/app/core/wx.py`、`backend/app/services/sport_service.py`、`backend/requirements.txt`（新增 pycryptodome）、`frontend/`。
- 测试结果：据 `docs/迭代记录.md` —— S11 冒烟 8/8（含伪造数据 400 零写入）、e2e 178/178 回归、automator 4/4；真机部分记录被截断，完整结论待确认（引自 `.qoder/backend/requirements.txt.md` §10）。

### 2026-10-02（`18c2121`）

- 需求：小程序聚合接口批次（档案/足迹/日历/播报/知识画像）。
- 修改内容：新增 `GET /api/sport/calendar` 行军日历端点（含 month 格式 400 校验），模块 docstring 补「行军日历」。
- 关联文件：`backend/app/services/sport_service.py`、`backend/app/schemas/schemas.py`。
- 测试结果：据提交信息 —— S3 冒烟 **15/15**（`backend/test/s3_aggregates.py` + 验收报告）。

### 2026-10-01（`82af32c`）

- 需求：管理端实时数据变更通知。
- 修改内容：sync / add 成功后 `ws_manager.broadcast(build_event(...))`。
- 关联文件：`backend/app/core/ws.py`、`backend/app/api/routes/ws.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-09-30（`a94e685`）

- 需求：项目初始化。
- 修改内容：创建本文件，含 today / sync / recent / add 四个端点（calendar 为后续新增）。
- 关联文件：仓库初始代码。
- 测试结果：`docs/迭代记录.md` 该条目未记载验证结果，待确认。
