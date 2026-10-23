# backend/test · 后端测试体系总览

> 最后核对时间：2026-10-22（对应 HEAD `aef5135`，即 AI 上游改为可切换供应商的 `b712d81` 之后）
>
> 按 `.qoder/README.md` §4 的排除规则，**测试脚本不逐个建档**，本文档作为该目录的唯一说明：讲清测试体系、执行方式，并给出「脚本清单 → 覆盖场景 → 报告路径」映射表。

---

## 1. 测试体系形态

| 项 | 事实 |
|---|---|
| 框架 | **无 pytest / unittest**。全部为**独立可执行的 Python 冒烟脚本**，每个脚本自带断言与结果输出 |
| 运行方式 | `.venv\Scripts\python.exe test\<脚本名>.py`（在 `backend/` 目录下） |
| 被测对象 | `fastapi.testclient.TestClient` 直接挂载 `app.main:app`，**不依赖 8010 端口、不依赖 openGauss** |
| 数据库 | **SQLite 临时库**，脚本内自建自删，文件名形如 `_smoke_s26.db`（被 `.gitignore:6` 的 `*.db` 排除） |
| 例外 | 少数脚本需**真实 openGauss**（脚本名以 `_pg` 结尾），见 §4 |
| 结果产物 | 两类：`backend/test/docs/*.md` 人读报告（**37 份**）与 `backend/test/*-results.json` 机读结果（**18 份**，**已入库**）。2026-10-22 实测：`ls backend/test/docs/*.md \| wc -l` = 37、`git ls-files backend/test \| grep -c results.json` = 18 |
| 脚本总数 | 2026-10-22 实测 `backend/test/*.py` 共 **40 个**（`git ls-files backend/test \| grep -c '\.py$'` = 40，全部已入库；2026-10-23 复跑同命令仍为 40），其中 3 个是辅助文件（`dns_shim.py`、`serve_sqlite.py`、`fixtures_identity_bind.py`，见 §4），即**测试脚本 37 个**。~~⚠ `.qoder/README.md` §4「测试脚本」行的「`backend/test/*.py`（37 个）」是 2026-10-17 的**文件总数**口径，本次 `s28`/`s29`/`s30` 三个脚本入库后已过期（应为 40 个文件 / 37 个脚本）；该文件不在本批次修订范围内，**待同步**~~ **已于同批（2026-10-23 复核确认）同步**：`.qoder/README.md` §4「测试脚本」行已改为「`backend/test/*.py`、`frontend/test/automator/*.cjs`、`frontend/test/*.cjs`（**份数不在此登记**——脚本随每次任务增删，权威清单见两份 `test/README.md`；2026-10-22 实测 backend 40 个 `.py`〔含 3 个辅助模块〕、automator 65 个 `.cjs`）」，即**从「写死份数」改为「指向本文档」**，避免下次增删脚本时两处再度失配（automator 65 个 `.cjs`、`frontend/test/*.cjs` 5 个均 2026-10-23 `ls \| wc -l` 复核通过） |
| 断言风格 | 脚本内累加 pass/fail 计数，末尾打印 `N/M 通过`，失败时 `sys.exit` 非 0 |
| 编码处理 | 脚本首行 `sys.stdout.reconfigure(encoding="utf-8", errors="replace")`，规避 Windows 控制台 GBK 报错 |
| 路径注入 | 脚本内 `sys.path.insert(0, _HERE)` + `sys.path.insert(0, _BACKEND)`，因此**必须在 `backend/` 下运行**才能正确解析 `app.*` |

### 1.1 快速建号的既有捷径

本地真实登录会被微信凭证与入驻门槛挡住（`/api/auth/login` 只对已入驻用户签发令牌）。冒烟脚本的通行做法是**用 SQLite + TestClient 直接建号**：写入 `users` 行并自行签发 JWT，绕过 `wx.login`。新增脚本应沿用此模式，不要试图走真实微信登录。

参见项目记忆 `backend-smoke-sqlite-testclient`（含 TestClient 新 API 的陷阱）。

### 1.2 端口残留导致的假失败

**冒烟结果异常时先确认 8010 端口是否残留旧代码的 uvicorn 进程** —— 这是本项目反复踩到的坑。只有 reloader 父进程存活且 8010 无监听时，可 `touch` 文件触发重载而免杀进程。参见项目记忆 `backend-uvicorn-orphan-process`。

---

## 2. 编号语义

后端测试的编号来自不同历史批次，**并非单一连续序列**，理解编号来源比记住号码更重要：

| 前缀 | 含义 | 引入阶段 |
|---|---|---|
| `s<N>_` | **场景（Scenario）套件**，主线编号，目前到 **S30** | 数据层起（S1）逐步累加 |
| `p0_` / `p1_` / `p2_` | **高级化升级计划的批次号**（P0-1…P0-4、P1-1…P1-8、P2-1…P2-2） | 2026-10-01 ~ 10-04 |
| `e2e_` | **端到端全链路**脚本，跨前后端 | 2026-10-01 |
| `<主题>_smoke.py` | 单一主题的临时冒烟（如 `nickname_change_smoke.py`） | 按需 |
| `_pg` 后缀 | **需真实 openGauss** 而非 SQLite | S19/S24 |

**编号存在缺口，且缺口是有原因的**：`s1_*`、`s10_*`、`s14_*`、`s15_*`、`s16_*` 的**脚本从未入库**（`git log --diff-filter=A` 无记录），但它们的**报告存在** —— `s1-data-layer-report.md`、`s14-hotspot-sql-report.md` 在 `backend/test/docs/`，`s10-rbac-admin-ui-report.md`、`s15-rankings-server-paging-report.md`、`s16-admin-review-fixes-report.md` 在 `admin/test/docs/`。这些场景或为管理端浏览器人工验收（S10/S15/S16），或脚本未保留（S1/S14）。**不要假定这些脚本存在。**

`s13_onboard_login.py` 曾在 `afbcba9`（2026-10-12 邀请码准入全链路）中被**删除**，因为准入模型改造后原脚本语义失效。

**同类缺口新增一例：`s27` 有报告无脚本** —— `docs/s27-llm-provider-migration-report.md`（`c660727`，AI 上游由腾讯云 CloudBase Agent 单向迁到阿里云百炼）的验证**复用 s25/s26 两套脚本**，从未新建 `s27_*.py`。查 AI 上游演进史要连读 `s27` 与 `s30` 两份报告。

**编号撞车必须当场改名**：`b712d81` 的新套件初版命名 `s29_llm_provider_switch.py`，与已入库的 `s29_route_stats.py`（报告 `docs/s29-route-stats-report.md`）**撞号**，最终改占 **S30**（脚本、报告、结果 JSON 三者同步改名）。新增脚本前先 `ls backend/test/` 确认号码未被占用——**包括「只有报告没有脚本」的号码**（S1/S10/S14/S15/S16/S27）。

---

## 3. 脚本清单 → 覆盖场景 → 报告映射

> **本节所有 `docs/...` 均指 `backend/test/docs/...`，`*-results.json` 均指 `backend/test/*-results.json`。**
> 三端编号共享，`frontend/test/docs/` 与 `admin/test/docs/` 下存在**同名报告**（如 `p0-chapters-report.md`、`nickname-change-test-report.md`、`node-detail-map-fix-report.md`、`s5-org-user-counts-report.md`），内容是各端各自的验证记录，**不可互相替代**。查一个场景的完整验证情况需三处都看（见 §6）。

### 3.1 场景套件（S 系列）

| 脚本 | 覆盖场景 | 结果产物 | 状态 |
|---|---|---|---|
| ~~`s1_data_layer.py`~~ | 数据层 | `docs/s1-data-layer-report.md` | **脚本未入库** |
| `s2_streak_events.py` | 统一事件系统与连续行军 | `docs/s2-events-streak-report.md` | 有效 |
| `s3_aggregates.py` | 小程序聚合接口 | `docs/s3-miniapp-aggregates-report.md` | ⚠ **V1 语义，当前登录会 502** |
| `s4_admin_dashboard.py` | 管理端驾驶舱/大屏聚合 | `docs/s4-admin-dashboard-report.md` | 有效 |
| `s5_org_user_counts.py` | 组织树直属/含下级人数统计 | `docs/s5-org-user-counts-report.md`（另有 `admin/test/docs/s5-org-user-counts-report.md`） | 有效 |
| `s6_org_user_detail.py` | 组织架构人员明细 | `docs/s6-org-user-detail-report.md` | 有效 |
| `s7_perf_refactor.py` | 热点查询 SQL 聚合化与去 N+1 | `docs/s7-perf-refactor-report.md` | 有效 |
| `s8_identity_admin.py` | 微信身份关联（管理端） | `docs/s8-identity-admin.md` | 有效 |
| `s9_rbac_access.py` | RBAC 菜单权限与审计 | `docs/s9-rbac-access.md` | 有效 |
| `s11_sport_sync_werun.py` | 微信运动真实数据同步与解密 | `docs/s11-werun-sync-report.md`、`s11-werun-sync-results.json` | 有效 |
| `s12_question_import.py` | 题库 Excel 模板下载与批量导入 | `s12-question-import-results.json` | 有效（**无 md 报告**） |
| `s17_quote_cycle_import.py` | 每日寄语按天循环与 Excel 导入 | `docs/s17-quote-cycle-import-report.md`、`s17-quote-cycle-results.json` | 有效 |
| `s18_quiz_submit_feedback.py` | 答题改为提交后统一反馈 | `s18-quiz-feedback-results.json` | 有效（**无 md 报告**） |
| `s19_invite_admission.py` | 邀请码准入全链路（I01–I25、P01–P03） | `docs/s19-invite-admission-report.md`、`s19-invite-admission-results.json` | 有效 |
| `s19_invite_concurrency_pg.py` | 邀请码并发核销不超发 | `s19-invite-concurrency-pg-results.json` | 🔶 **需真实 openGauss** |
| `s20_v2_regression.py` | V2.0 后端综合回归（积分边界 999/1000/1999/20000/25000、幂等、排名口径、legacy 不计入、台账核对修复） | `s20-v2-regression-results.json` | 有效；**边界断言已随 `9cb65b8` 更新**（25000 步 20 分 → 25 分） |
| `s21_opengauss_compat.py` | **openGauss 兼容性防线** C01–C04；C03（`:56-60`）校验 ORM 与 SQL 表覆盖一致（34/34） | 无独立产物 | 有效，**升级 SQLAlchemy 后必须重跑** |
| `s22_history_sync_quiz_rotation.py` | 近 7 日微信运动补录、步数结余积分、用户独立题目轮换 | `docs/s22-history-sync-quiz-rotation-report.md`、`s22-…-results.json` | 有效 |
| `s23_walk_sync_recalc.py` | 步数同步后全量重算步行积分台账 | `s23-walk-sync-recalc-results.json` | 有效 |
| `s24_walk_recalc_pg.py` | 步行台账重算（真实库） | `s24-walk-recalc-pg-results.json` | 🔶 **需真实 openGauss** |
| `s25_ai_question_generate.py` | AI 出题生成与草稿入库，A01–A16：Excel 模板/导入回归、参数校验、鉴权、模型故障映射（超时/鉴权/服务异常/回复截断/无效 JSON）、输出容错、逐题问题识别、草稿不落正式题库、批量保存部分失败与重复题拦截、A13 响应不泄密钥、A14/A15 真实调用（10 题 / 50 题分批） | `s25-ai-question-generate-results.json` | 有效，**16/16**（2026-10-22 实测）；**provider 感知**：`s25_ai_question_generate.py:76` 按 `settings.LLM_PROVIDER` 取当前供应商的密钥，用于「能否跑真实调用」判定与 A13 泄露检查 |
| `s26_ai_center.py` | **AI 智能中心 Phase A**，7 组用例 C/K/H/R/Q/W/G + L 组真实调用 | `docs/s26-ai-center-report.md`、`docs/s26-ai-question-backend-report.md`、`s26-ai-center-results.json` | 有效，**47/47**（2026-10-22 实测，含真实调用）；**provider 感知**：`s26_ai_center.py:76` 同上，L 组能否执行与 G 组密钥泄露检查随 `LLM_PROVIDER` 取 |
| `s28_ai_chat_stream.py` | **AI 历史助手 SSE 真流式**（`POST /api/ai/chat/stream`，由 `6a4dbb7` 引入）：S01–S11 打桩离线（事件序列 start→delta*→done、增量拼接 == done.reply == 落库正文、`text/event-stream` + `X-Accel-Buffering:no`、start 先给 conversationId/title、前置校验仍返回普通 JSON 同码、流中途故障收尾、连续对话与历史注入、客户端提前断开、中断收尾两分支、与非流式落库同构、不泄密钥）+ L01/L02 真实调用 | `docs/s28-ai-chat-stream-report.md`、`s28-ai-chat-stream-results.json` | 有效，**13/13**（2026-10-22 实测）；**provider 感知**：`s28_ai_chat_stream.py:69` 按 `LLM_PROVIDER` 取密钥；L01 的「正常结束原因」与首片占比阈值按供应商分叉（cloudbase `end_turn` / 0.95，openai `stop` / 0.8） |
| `s29_route_stats.py` | 全员路线抵达统计 `GET /api/march/route-stats`（R01–R09）：鉴权 401、camelCase 契约、按累计步数二分计数与完成率、仅启用节点且按 `sort_order` 升序、与管理端 dashboard `route_overview` 逐项一致、60s 进程内 TTL 缓存命中与失效、管理端不走缓存 | `docs/s29-route-stats-report.md`、`s29-route-stats-results.json` | 有效，报告记 **9/9**（2026-10-19） |
| `s30_llm_provider_switch.py` | **大模型供应商可切换（`LLM_PROVIDER`）防线**，23 例 4 组（由 `b712d81` 引入）：**A 组**分派与配置 6 例（provider→适配器、`model_label` 取值、非法 provider 时 `prompt_meta` 抛 `LlmError` 而 `model_label` 不抛、门面重导出的 `LlmError`/`CallResult` 与适配器是同一个类对象、两家缺 Key 都在发请求前抛错）；**B 组** openai 本地桩 7 例（请求体与 `system` role、显式 `max_tokens`、流式逐片与收尾 usage 分片、`LLM_QUESTION_EXTRA_BODY` 覆盖 `LLM_EXTRA_BODY`、错误映射与可重试性、按 `AI_MAX_RETRIES` 重试、空正文）；**C 组** cloudbase 本地桩 7 例（JSON-RPC `session/prompt`、SSE 只拼 `agent_message_chunk`、流式分片与非流式同构、`max_tokens`/`extra_body` 不进请求体、`stopReason=max_tokens`、`CLOUDBASE_AGENT_URL` 优先于 ENV_ID/AGENT_ID 拼接、401 文案不泄密钥）；**D 组**真实调用 3 例（非流式 / 真流式 / 出题长输出） | `docs/s30-llm-provider-switch-report.md`、`s30-llm-provider-switch-results.json` | 有效，**23/23**（2026-10-22 实测，结果 JSON 记 `provider=cloudbase`）；脚本内自建 `ThreadingHTTPServer` 桩**同时模拟两种协议**，离线可重复；D 组可用 `LM_AI_SKIP_LIVE=1` 跳过 |

> **AI 四套脚本本轮合计 99/99**（2026-10-22，`b712d81` 的验证口径）：s30 23 + s25 16 + s26 47 + s28 13。**改动 AI 上游（`llm_service` 门面、任一适配器、`LLM_*` / `CLOUDBASE_*` 配置）后必须四套一起跑**，只跑 s26 会漏掉流式与供应商分派两条链路。

### 3.2 高级化升级批次（P 系列）

| 脚本 | 对应需求 | 报告 |
|---|---|---|
| `p0_route_progress.py` | P0-1 行军轨迹 | `docs/p0-route-progress-report.md` |
| `p0_chapters.py` | P0-3 长征章节系统 | `docs/p0-chapters-report.md` |
| `p1_activities.py` | P1-1 实时行军动态 | `docs/p1-activities-report.md` |
| `p1_companions.py` | P1-2 同组织同行者 | `docs/p1-companions-report.md` |
| `p1_org_march.py` | P1-3 组织共同长征目标 | `docs/p1-org-march-report.md` |
| `p1_global_goal.py` | P1-4 全员共同长征目标 | `docs/p1-global-goal-report.md` |
| `p1_footprints.py` | P1-6 我的长征足迹地图 | `docs/p1-footprints-report.md` |
| `p1_portrait.py` | P1-7 我的成就总览与数据画像 | `docs/p1-portrait-report.md` |
| `p1_persons.py` | P1-8 长征人物志 | `docs/p1-persons-report.md` |
| `p2_ceremony.py` | P2-2 区域氛围与长征完成仪式 | `docs/p2-ceremony-report.md` |

**缺口**：P0-2（首页今日行军卡）、P0-4（开场动画）、P1-5（星空长征模式）、P2-1（每日寄语与节点纪念票）**无对应后端脚本** —— P2-1 的后端验证并入 `s17_quote_cycle_import.py`，其余为纯前端表现，由小程序 automator 覆盖（见 `.qoder/frontend/test/README.md`）。

### 3.3 端到端与专项

| 脚本 | 用途 | 报告 | 状态 |
|---|---|---|---|
| `e2e_full_flow.py` | 全链路端到端 | `docs/backend-test-report.md` | ⚠ **V1 语义，当前登录会 502** |
| `e2e_datasync.py` | 数据同步 e2e（配合 WS 广播） | `docs/backend-datasync-test-report.md` | ⚠ **V1 语义，当前登录会 502** |
| `nickname_change_smoke.py` | 昵称一次性改名 | `docs/nickname-change-test-report.md`、`nickname-smoke-results.json` | 有效 |

### 3.4 缺陷修复专项报告（无独立脚本）

以下报告记录的是缺陷修复的验证结论，验证脚本为临时 `_smoke_*.py`（被 `.gitignore` 排除，故未入库）：

| 报告 | 对应修复 |
|---|---|
| `docs/walk-points-cumulative-fix-report.md` | `4afccdd` 步行积分统一为累计步数口径 |
| `docs/walk-sync-full-recalc-fix-report.md` | `83d3552` 步数同步后全量重算台账 |
| `docs/node-detail-map-fix-report.md` | `6913b00` 节点详情路线位置缺少点位导致蓝屏 |
| `docs/s14-hotspot-sql-report.md` | `f59892e` 后端热点查询 SQL 聚合化（**脚本未入库**） |
| `docs/p2-quotes-report.md` | P2-1 每日寄语 |

---

## 4. 辅助文件（非测试套件，不建档）

| 文件 | 用途 |
|---|---|
| `dns_shim.py` | **按需生效的域名→IP 映射垫片**：`dns_shim.py:14` 只读环境变量 `LM_TEST_DNS_MAP`（格式 `域名=IP,域名=IP`），**未设置时 `install()` 是空操作**，不改写任何解析。在导入 `app.*` 之前安装它的脚本共 4 个：`s25_ai_question_generate.py:43`（`install()` 在 `:45`）、`s26_ai_center.py:35`（`:37`）、`s28_ai_chat_stream.py:40`（`:42`）、`serve_sqlite.py:23`（`:25`）。**当前口径（2026-10-22 实测）**：`c660727` 已把 `serve_sqlite.py` 里写死的 CloudBase 网关映射删除，本文件退为纯兜底；本地 Clash fake-ip 会把网关域名解析到 `198.18.x.x` 段，但本轮真实调用（CloudBase ACP 与百炼 OpenAI 兼容）**经代理正常出网、无需兜底**。仅当真实调用组报 DNS/连接错误时才设 `LM_TEST_DNS_MAP`：openai 侧域名形如 `dashscope.aliyuncs.com`（`s25_ai_question_generate.py:26` 的用法示例），cloudbase 侧为 `*.api.tcloudbasegateway.com` 网关域名（拼接规则见 `app/core/config.py:92` 注释） |
| `serve_sqlite.py` | 用 SQLite 起一个本地后端，供小程序 automator 联调；`c660727` 起**不再写死任何上游网关的 DNS 映射**，只保留 `dns_shim` 按需兜底（`serve_sqlite.py:5` 头注释、`:23` 导入） |
| `fixtures_identity_bind.py` | 身份绑定场景的测试夹具（配合 `frontend/test/automator/fixtures-identity.json`） |
| `_smoke_*.db` | SQLite 临时库，`.gitignore:6` `*.db` 排除 |
| `images/` | 测试用图片资源 |

---

## 5. 执行约定与已知坑

### 5.1 执行

```bash
cd backend
.venv/Scripts/python.exe test/s30_llm_provider_switch.py   # AI 上游供应商切换防线（离线桩，可重复跑）
.venv/Scripts/python.exe test/s26_ai_center.py

# 跳过 AI 真实调用（不消耗配额）：对 s26 的 L 组、s28 的 L01/L02、s30 的 D 组生效
set LM_AI_SKIP_LIVE=1

# s25 另有独立开关：只跳过 A15 的 50 题真实生成（见该脚本文件头「用法」）
set LM_AI_SKIP_LARGE=1

# 仅当真实调用报 DNS/连接错误时才需要；未设置时 dns_shim 是空操作（见 §4）
set LM_TEST_DNS_MAP=<host>=<ip>
```

**AI 真实调用组的开关是 provider 感知的**：s25/s26/s28/s30 都按 `settings.LLM_PROVIDER` 取「当前供应商」的密钥来决定真实调用组是否执行（`s25_…:76`、`s26_…:76`、`s28_…:69`；`llm_service.is_configured()` 就是为此而设，见 `app/services/llm_service.py:61-64`），改 `LLM_PROVIDER` 一行即可切换上游、**脚本无需改动**。当前两份 env（`.env` / `.env.prod`）的取值为 `cloudbase`，故本机默认跑 CloudBase 凭证；上线前改回 `openai` 后需复跑 s30（含 D 组）与 s25/s26/s28（切换步骤见 `docs/s30-llm-provider-switch-report.md` §5.1）。

需真实 openGauss 的脚本（`s19_invite_concurrency_pg.py`、`s24_walk_recalc_pg.py`）须先确保容器就绪；容器操作注意事项见项目记忆 `opengauss-docker-db-ops`（5118 端口、gsql 环境、DDL 被 idle-in-transaction 阻塞的处理）。

### 5.2 已知坑

1. **IDE 静态检查器返回「无法检测代码问题」是假阴性**，不能作为「代码没问题」的依据。参见项目记忆 `ide-tunneling-socket-econnrefused`。
2. **TestClient 新 API 陷阱**：见项目记忆 `backend-smoke-sqlite-testclient`。
3. **`_pg` 脚本不能在只有 SQLite 的环境下跑**，会因方言差异误报。
4. **`e2e_full_flow` / `e2e_datasync` / `s3_aggregates` 已失效**（V1 语义 + 502 登录），**不要拿它们的失败当作回归信号**；需要端到端验证时应先按当前准入模型（邀请码入驻）重写。
5. **`s20_v2_regression.py` 的边界断言已随 `9cb65b8`（取消 20000 封顶）更新**，若在旧分支上跑会得到不同的期望值。
6. **`s21_opengauss_compat.py` 是 `core/database.py:11-43` monkey-patch 的唯一回归防线**（该文件 `:28` 明确指向此脚本）。升级 SQLAlchemy 主版本后必须重跑，通过后方可考虑删除补丁。
7. **AI 真实调用组会因供应商切换而「静默跳过」**：s25/s26/s28 原先写死用 `settings.LLM_API_KEY` 判定，`LLM_PROVIDER=cloudbase` 时三套脚本的真实调用组会**整组静默跳过**——回归看似全绿、真实链路零覆盖。`b712d81` 已改为 provider 感知（见 §5.1）。**因此判断「AI 真实链路是否真跑过」不能只看总数全绿，要去结果 JSON 里确认 L 组 / D 组条目存在**。
8. **s28 的 L01 判定按供应商分叉**：cloudbase 取正常结束原因 `end_turn` + 首片占总耗时比 ≤0.95，openai 取 `stop` + ≤0.8。0.95 仍能区分「真流式」与「缓冲后一次吐」（后者 ≈1.0），**不是为了让用例通过而放宽**；新增第三家供应商时必须在 s28/s30 同步补该分叉，否则真实调用组会误判。
9. **本地 Clash fake-ip 不等于必须挂 `dns_shim`**：fake-ip 会把上游网关域名解析到 `198.18.x.x`，但 2026-10-22 实测 CloudBase ACP 与百炼 OpenAI 兼容两条真实调用**经代理正常出网**，`LM_TEST_DNS_MAP` 未设置、`dns_shim.install()` 为空操作即可跑通。只在真实调用报 DNS/连接错误时才配映射（`c660727` 已移除 `serve_sqlite.py` 里写死的网关映射，详见 §4）。
10. **扩展 s30 的 C 组时必须显式把 `CLOUDBASE_AGENT_URL` 指向本地桩**：该配置留空时适配器会按 `ENV_ID`/`AGENT_ID` 拼出**公网网关地址**（`app/core/config.py:92` 注释），离线用例会悄悄变成真实调用（消耗配额且结果不可重复）；拼接规则本身由 C06 直接断言 `_resolve_url()`（依据：`docs/迭代记录.md` 的 `b712d81` 条目备注①）。

### 5.3 产物入库规则

| 产物 | 是否入库 | 依据 |
|---|---|---|
| `backend/test/*.py` | ✅ 入库（40 个，2026-10-22 `git ls-files` 实测） | — |
| `backend/test/docs/*.md` | ✅ 入库 | — |
| `backend/test/*-results.json` | ✅ 入库（**18 份**，2026-10-22 `git ls-files backend/test \| grep -c results.json` 实测；原记 15 份，`s28`/`s29`/`s30` 各新增 1 份） | `.gitignore` 未排除 backend 侧 json |
| `backend/test/_smoke_*.db` | ❌ 排除 | `.gitignore:6` `*.db` |
| `backend/test/_smoke_*.py`（临时脚本） | ❌ 排除 | `.gitignore` 有 `_smoke_*.py` 规则 |
| `frontend/test/token.txt`、`frontend/test/*.json`、`frontend/test/automator/results*.json`、`state.json`、`console-log.json` | ❌ 排除 | `.gitignore:44-49`，注释「测试运行临时产物（含令牌等敏感数据，禁止入库）」 |

⚠ **`admin/test/images/console-errors.json` 未被排除、已入库** —— 该文件是浏览器控制台错误抓取，理论上不含凭据，但**新增同类产物时应确认不含 token**。

---

## 6. 与其它测试体系的关系

| 体系 | 位置 | 说明 |
|---|---|---|
| 小程序 automator | `frontend/test/automator/` | 见 `.qoder/frontend/test/README.md` |
| 管理后台浏览器人工验收 | `admin/test/` | 见 `.qoder/admin/test/README.md` |
| 提交级验证记录 | `docs/迭代记录.md` 每条的「验证」字段 | **权威**，记录当次提交实际跑了什么、结论如何 |

**三端编号是共享的**：同一个 `s19` 场景可能同时有 `backend/test/docs/s19-invite-admission-report.md`、`admin/test/docs/s19-invite-admin-report.md`、`frontend/test/docs/s19-invite-frontend-report.md`。查一个场景的完整验证情况需要三处都看。

---

## 10. 迭代记录

> 本文档是**目录级总览**（`.qoder/README.md` §4 排除规则：测试脚本不逐个建档），不设文件级模板的 §7–§9；本节沿用模板固定的 `## 10. 迭代记录` 编号与标题，按时间倒序追加，既有记录只追加不删改（`.qoder/README.md` §3.11）。

### 2026-10-23（同批交付前复核补正，未单独提交）

- 需求：本批 AI 上游文档同步在提交前做了一轮「抽查引用 + 计数复核」，发现 §1「脚本总数」行留的 `⚠ … 待同步` 已被同批解决，就地补正并复跑全部计数（与下方 `2026-10-22` 条目同属一次未提交的文档同步，故另立本条留痕、按 §3.11 不改写上一条）。
- 修改内容：① §1「脚本总数」行的 ⚠ 段用删除线保留原文并补「**已于同批同步**」——`.qoder/README.md` §4「测试脚本」行同批已改为**不再写死份数**、改指本文档为权威清单（并附 2026-10-22 实测的 backend 40 个 `.py`〔含 3 个辅助模块〕、automator 65 个 `.cjs`）；「待同步」的说法随之失效。② 复跑并确认本行与「结果产物」行的四个计数全部仍成立：`git ls-files backend/test \| grep -c '\.py$'` = **40**、`ls backend/test/docs/*.md \| wc -l` = **37**、`git ls-files backend/test \| grep -c 'results\.json$'` = **18**、`ls frontend/test/automator/*.cjs \| wc -l` = **65**（另 `ls frontend/test/*.cjs \| wc -l` = 5）。③ 复核 §3.1「AI 四套脚本本轮合计 **99/99**」的依据：逐个读取已入库结果 JSON 的 `total`/`passed` 字段，`s30-llm-provider-switch-results.json` 23/23、`s25-ai-question-generate-results.json` 16/16、`s26-ai-center-results.json` 47/47、`s28-ai-chat-stream-results.json` 13/13，相加确为 99；`s29-route-stats-results.json` 9/9 亦与 §3.1 该行一致。
- 关联文件（均未修改，仅作复核来源）：`.qoder/README.md`、`backend/test/*-results.json`（18 份）、`backend/test/docs/*.md`（37 份）。
- 测试结果：本文档为纯文档修订，**未执行任何测试脚本**；上列通过率全部抄自已入库的结果 JSON（2026-10-23 用 `json.load` 逐份读取 `total`/`passed` 字段核对，非重新运行）。

### 2026-10-22

- 需求：补齐 AI 上游三次变更在本目录总览中的欠账——`c660727`（上游由腾讯云 CloudBase Agent 单向迁到阿里云百炼，`cloudbase_service.py` → `llm_service.py`）、`6a4dbb7`（AI 问答改 SSE 真流式，新增 `POST /api/ai/chat/stream` 与 s28 套件）、`b712d81`（上游改为 `LLM_PROVIDER` 可切换的双供应商，新增 s30 套件、s25/s26/s28 三套脚本 provider 感知化）。**本次修订不改任何测试脚本或后端源码，纯文档同步**（源码与脚本的变更均已在上述三个提交中完成并各自验证）。
- 修改内容：① §1 核对时间更新为 2026-10-22 / HEAD `aef5135`，报告与结果 JSON 份数按实测改为 37 / 18，新增「脚本总数」行（40 个 `.py` = 37 个测试脚本 + 3 个辅助文件）并标注 `.qoder/README.md` §4「37 个」已过期、**待同步**；② §2 主线编号「目前到 S26」改为 **S30**，新增「`s27` 有报告无脚本」缺口与「s29 撞号→改占 S30」的编号纪律；③ §3.1 对照表新增 `s28`/`s29`/`s30` 三行（脚本 / 覆盖场景 / 报告 / 结果文件 / 实测通过率），`s25`/`s26` 两行改写为 **provider 感知**口径（密钥随 `LLM_PROVIDER` 取、行号已实读确认），并补「AI 四套合计 99/99、改上游须四套齐跑」的提示；④ §4 `dns_shim.py` 行按实测校正（只在设 `LM_TEST_DNS_MAP` 时生效、4 个安装点的真实行号、`c660727` 已移除 `serve_sqlite.py` 写死的网关映射、Clash fake-ip 下本轮无需兜底），`serve_sqlite.py` 行同步；⑤ §5.1 执行示例加入 s30、区分 `LM_AI_SKIP_LIVE` 与 `LM_AI_SKIP_LARGE` 的作用面、补 provider 感知与上线切回 `openai` 的复跑要求；⑥ §5.2 新增第 7–10 条已知坑（真实调用组静默跳过、s28 L01 阈值按供应商分叉、fake-ip ≠ 必须 dns_shim、扩展 s30 C 组须显式指向本地桩）；⑦ §5.3 入库份数 15 → 18 并给出实测依据。
- 关联文件：`backend/test/s30_llm_provider_switch.py`、`backend/test/docs/s30-llm-provider-switch-report.md`、`backend/test/s30-llm-provider-switch-results.json`、`backend/test/s25_ai_question_generate.py`、`backend/test/s26_ai_center.py`、`backend/test/s28_ai_chat_stream.py`、`backend/test/s29_route_stats.py`、`backend/test/dns_shim.py`、`backend/test/serve_sqlite.py`、`backend/app/services/llm_service.py`、`backend/app/core/config.py`；上游提交 `c660727`、`6a4dbb7`、`b712d81`（口径见 `docs/迭代记录.md` 对应条目）。
- 测试结果：本文档为纯文档修订，未执行任何测试脚本；表中通过率均**抄自各套件已入库的结果 JSON 与报告**（2026-10-22 实测 s30 23/23、s25 16/16、s26 47/47、s28 13/13，合计 99/99；s29 9/9 抄自其 2026-10-19 报告）。文件/份数统计以 `ls` 与 `git ls-files` 实测为准，未凭文件名推断。
