# backend/test · 后端测试体系总览

> 最后核对时间：2026-10-17（对应 HEAD `031c323`）
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
| 结果产物 | 两类：`backend/test/docs/*.md` 人读报告（33 份）与 `backend/test/*-results.json` 机读结果（15 份，**已入库**） |
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
| `s<N>_` | **场景（Scenario）套件**，主线编号，目前到 S26 | 数据层起（S1）逐步累加 |
| `p0_` / `p1_` / `p2_` | **高级化升级计划的批次号**（P0-1…P0-4、P1-1…P1-8、P2-1…P2-2） | 2026-10-01 ~ 10-04 |
| `e2e_` | **端到端全链路**脚本，跨前后端 | 2026-10-01 |
| `<主题>_smoke.py` | 单一主题的临时冒烟（如 `nickname_change_smoke.py`） | 按需 |
| `_pg` 后缀 | **需真实 openGauss** 而非 SQLite | S19/S24 |

**编号存在缺口，且缺口是有原因的**：`s1_*`、`s10_*`、`s14_*`、`s15_*`、`s16_*` 的**脚本从未入库**（`git log --diff-filter=A` 无记录），但它们的**报告存在** —— `s1-data-layer-report.md`、`s14-hotspot-sql-report.md` 在 `backend/test/docs/`，`s10-rbac-admin-ui-report.md`、`s15-rankings-server-paging-report.md`、`s16-admin-review-fixes-report.md` 在 `admin/test/docs/`。这些场景或为管理端浏览器人工验收（S10/S15/S16），或脚本未保留（S1/S14）。**不要假定这些脚本存在。**

`s13_onboard_login.py` 曾在 `afbcba9`（2026-10-12 邀请码准入全链路）中被**删除**，因为准入模型改造后原脚本语义失效。

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
| `s25_ai_question_generate.py` | AI 出题（CloudBase Agent）生成与草稿入库 | `s25-ai-question-generate-results.json` | 有效 |
| `s26_ai_center.py` | **AI 智能中心 Phase A**，7 组用例 C/K/H/R/Q/W/G + L 组真实调用 | `docs/s26-ai-center-report.md`、`docs/s26-ai-question-backend-report.md`、`s26-ai-center-results.json` | 有效，**47/47 通过（含真实 Agent）** |

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
| `dns_shim.py` | **本机 DNS 劫持/不可用时的域名→IP 映射垫片**。`s26_ai_center.py:36` 在导入 `app.*` 前先 `import dns_shim` 并 `dns_shim.install()`。真实调用 CloudBase Agent 时可用 `LM_TEST_DNS_MAP=<gateway-host>=<ip>` 环境变量指定映射 |
| `serve_sqlite.py` | 用 SQLite 起一个本地后端，供小程序 automator 联调 |
| `fixtures_identity_bind.py` | 身份绑定场景的测试夹具（配合 `frontend/test/automator/fixtures-identity.json`） |
| `_smoke_*.db` | SQLite 临时库，`.gitignore:6` `*.db` 排除 |
| `images/` | 测试用图片资源 |

---

## 5. 执行约定与已知坑

### 5.1 执行

```bash
cd backend
.venv/Scripts/python.exe test/s26_ai_center.py

# 跳过 AI 真实调用（不消耗 Agent 配额）
set LM_AI_SKIP_LIVE=1

# 本机 DNS 不可用时（仅真实调用需要）
set LM_TEST_DNS_MAP=<gateway-host>=<ip>
```

需真实 openGauss 的脚本（`s19_invite_concurrency_pg.py`、`s24_walk_recalc_pg.py`）须先确保容器就绪；容器操作注意事项见项目记忆 `opengauss-docker-db-ops`（5118 端口、gsql 环境、DDL 被 idle-in-transaction 阻塞的处理）。

### 5.2 已知坑

1. **IDE 静态检查器返回「无法检测代码问题」是假阴性**，不能作为「代码没问题」的依据。参见项目记忆 `ide-tunneling-socket-econnrefused`。
2. **TestClient 新 API 陷阱**：见项目记忆 `backend-smoke-sqlite-testclient`。
3. **`_pg` 脚本不能在只有 SQLite 的环境下跑**，会因方言差异误报。
4. **`e2e_full_flow` / `e2e_datasync` / `s3_aggregates` 已失效**（V1 语义 + 502 登录），**不要拿它们的失败当作回归信号**；需要端到端验证时应先按当前准入模型（邀请码入驻）重写。
5. **`s20_v2_regression.py` 的边界断言已随 `9cb65b8`（取消 20000 封顶）更新**，若在旧分支上跑会得到不同的期望值。
6. **`s21_opengauss_compat.py` 是 `core/database.py:11-43` monkey-patch 的唯一回归防线**（该文件 `:28` 明确指向此脚本）。升级 SQLAlchemy 主版本后必须重跑，通过后方可考虑删除补丁。

### 5.3 产物入库规则

| 产物 | 是否入库 | 依据 |
|---|---|---|
| `backend/test/*.py` | ✅ 入库 | — |
| `backend/test/docs/*.md` | ✅ 入库 | — |
| `backend/test/*-results.json` | ✅ 入库（15 份） | `.gitignore` 未排除 backend 侧 json |
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
