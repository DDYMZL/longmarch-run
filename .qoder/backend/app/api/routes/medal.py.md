# medal.py

## 1. 文件路径

`backend/app/api/routes/medal.py`（33 行）

## 2. 文件职责

小程序勋章域的 HTTP 路由层：勋章列表（含未获得状态）与主动检查发放。勋章判定与发放规则全部在 `medal_service.check_and_grant`；本文件只做依赖注入、活动状态分支与 WS 广播。

## 3. 业务需求

- 勋章由后端根据用户行为**自动发放**（`backend/app/services/medal_service.py:1-11` 模块 docstring）；业务数据变化后调用 `check_and_grant` 刷新，是 `backend/AGENTS.md` 不变量 5「副作用链」的统一勋章入口。
- 勋章墙扩展字段（分类/隐藏/获得条件文案，功能 9）：提交 `18c2121`（2026-10-02，据其提交信息「medal/list 扩展分类与获得条件字段」）。
- 活动不可参与时勋章只读、不再发放（V2.0 需求一，提交 `ce14a95`，2026-10-13）。

## 4. 核心功能

### 4.1 端点清单（2 个，与 `app.openapi()` 实测一致）

路由前缀 `/medal`（`medal.py:12`），经 `backend/app/main.py:78` 以 `/api` 前缀挂载。

| 方法 | 完整路径 | 函数名 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| GET | `/api/medal/list` | `medal_list` | `medal.py:15-23` | `require_activity_view` | `MedalListOut`（`backend/app/schemas/schemas.py:586`） |
| POST | `/api/medal/check` | `check` | `medal.py:26-32` | `require_activity_participation` | `MedalGrantResult`（`schemas.py:591`） |

### 4.2 调用的 service 函数

| 路由 | service 调用 | 位置 |
|---|---|---|
| `medal_list` | `activity_service.is_participation_open`；条件满足时 `medal_service.check_and_grant`；`medal_service.get_medal_list`、`get_owned_count` | `backend/app/services/activity_service.py:112-113`；`medal_service.py:33-113`、`:116-147`、`:150-152` |
| `check` | `medal_service.check_and_grant` | `medal_service.py:33-113` |

WS 广播：仅 `POST /api/medal/check` 在**有新勋章时**广播 `medal.check`（`medal.py:29-31`），管理端人员档案据此实时刷新勋章模块（`medal.py:28` docstring）。`GET /api/medal/list` 即使发放了新勋章也**不广播**（现状事实，见 §9 问题 2）。

### 4.3 `GET /api/medal/list` 的写副作用与只读降级

- **GET 带写副作用**：活动进行中（`is_participation_open(db)` 为真，`medal.py:18`）先执行 `check_and_grant`（可能 INSERT `user_medals` + commit + 写 `BADGE_UNLOCK` 事件），再返回列表——即「查看勋章墙」本身就会补发漏掉的勋章。
- **活动不可参与时只读**：`is_participation_open` 为假（未发布/未开始/已结束，`activity_service.py:102-113`）时跳过发放，仅查询返回（`medal.py:17` docstring）。注意本端点挂 `require_activity_view`，活动结束后若配置 `allow_view_after_end` 仍可访问，此时不再产生发放。
- 返回结构：`medals[]`（含未获得，按 seed 定义顺序，扩展字段 category/hidden/sortOrder/grantedAt/conditionDesc，隐藏且未获得时 conditionDesc=「获得条件暂未公布」，`medal_service.py:116-147`）+ `ownedCount`。

### 4.4 `POST /api/medal/check` 与不变量 5

- **本端点就是不变量 5 所说的 `medal_service.check_and_grant` 的 HTTP 入口**（`backend/AGENTS.md` §4 不变量 5：sync/add/light-up/submit/login 等操作后必须触发 check_and_grant——那些触发点在各业务路由/服务内部调用同一函数，如 `backend/app/api/routes/sport.py:48`、`backend/app/api/routes/march.py:71`、`backend/app/api/routes/quiz.py:35`/`:51`；本端点供前端/测试主动兜底调用）。
- 幂等：`check_and_grant` 只对「达标且未拥有」的勋章 INSERT（`medal_service.py:92-97`），重复调用返回空列表、无写入；有新勋章时 commit 一次（`:98-99`）并逐枚写 `BADGE_UNLOCK` 事件（`:101-112`，事件经 `event_service.record` 自带 commit 与管理端动态广播）。
- 响应：`{"newly": [勋章id...]}`（`MedalGrantResult`，`schemas.py:591-592`）。

### 4.5 勋章判定条件（规则位置，不在本文件复述公式）

`check_and_grant`（`medal_service.py:63-90`）一次性查 `daily_sport` 全量在内存派生指标，判定 12 枚勋章：first-step（有运动记录）、learner（答题记录 ≥10 次）、master（总积分 ≥500）、luding/snow（点亮节点 6/7，`MEDAL_NODE_MAP`，`backend/app/data/seed.py:314`）、victory（全部启用节点点亮）、persistence/streak-30（最长连续达标 ≥7/≥30 天）、day-10k（存在单日 ≥10000 步）、steps-100k/steps-500k（累计 ≥10 万/50 万步）、fearless（隐藏，连续 7 天每天 ≥10000 步）。

## 5. 输入与输出

- 输入：两个端点均无参数，身份取自 JWT。
- 输出（camelCase，`CamelModel`，`schemas.py:17-22`）：
  - `MedalListOut`：`medals[]`（MedalItem：id(string)/name/icon/desc/owned/category/hidden/sortOrder/grantedAt/conditionDesc，`schemas.py:573-588`）+ `ownedCount`。
  - `MedalGrantResult`：`newly[]`（勋章 id 字符串数组）。
- 错误码：401（令牌无效）；403（账号停用 `X-Account-Status`；活动准入拒绝 `X-Activity-Status`——list 为 view 档、check 为 participation 档，`backend/app/api/deps.py:46-81`）。无 400/404 路径（service 不抛 `ValueError`，路由无 try 转换）。

## 6. 依赖关系

- **依赖模块**：`app.api.deps`、`app.core.ws`、`app.models.models.User`、`app.schemas.schemas`（2 个模型）、`app.services.activity_service`、`app.services.medal_service`（`medal.py:2-10`）。
- **service 层再依赖**：`app.data.seed`（`MEDALS`/`MEDAL_NODE_MAP` 常量，`medal_service.py:16`）、`points_service`（总积分）、`streak_service`（连续天数派生）、`event_service`（BADGE_UNLOCK）。
- **数据库表**：`medal_defs`（定义，读）、`user_medals`（读写，user_id+medal_id 唯一，`backend/app/models/models.py:353-354`）、`daily_sport`/`quiz_records`/`lit_nodes`/`route_nodes`/`points_log`（判定条件只读）、`user_event`（事件写）。
- **被谁依赖**：`backend/app/main.py:78` 注册；小程序 `frontend/services/medal.js:13` **只调 `/medal/list`**；`/api/medal/check` 无小程序调用方，调用者为测试脚本（`backend/test/e2e_datasync.py:145`、`backend/test/e2e_full_flow.py:335`）；其余触发点在各业务路由内部直接调 service 函数（不经本文件）。

## 7. 业务规则

1. **勋章总数 12 枚**：`backend/app/data/seed.py:282-311` 的 `MEDALS` 常量 12 项（seed.py:3 docstring「勋章定义(12)」；开发库 `medal_defs` 表 12 行——2026-10-17 用户实测，与 `.qoder/ARCHITECTURE.md` §13.3 一致）。**文档滞后项**：`backend/AGENTS.md:39` 目录注释仍写「勋章 6」，以 12 为准（详见 §9 问题 3）。
2. **只增不减**：勋章一经发放不回收（无撤销代码路径）；`check_and_grant` 幂等。
3. **发放时机**：所有影响步数/点亮/答题/积分的操作后由副作用链触发（不变量 5）；本域 list/check 为查看侧兜底。
4. **活动闸门**：发放类动作只在 `is_participation_open` 为真时发生（list 内条件判断 + check 的 participation 依赖双保险）。
5. **隐藏勋章**：`hidden=True`（当前仅 fearless，`seed.py:306`）未获得时不公开获取条件（`medal_service.py:144`）。

## 8. 修改约束

1. **事务边界：service 自提交**——`check_and_grant` 在 `medal_service.py:99` commit，`event_service.record` 内部各自 commit（`backend/app/services/event_service.py:106-129`）；路由层不得 commit。
2. 勋章 id 是字符串（`first-step` 等），`MedalItem.id: str`（`schemas.py:574`）与 `user_medals.medal_id`、seed `MEDALS[].id`、前端 `frontend/services/medal.js` 三处一致，改 id 属破坏性变更。
3. 新增勋章：在 `seed.py` `MEDALS` 追加（幂等补新 id，`seed.py:6` docstring）+ `check_and_grant` 增加判定分支 + `docker/init/` 无需迁移（medal_defs 由种子写入）；同步更新本文档与 `backend/AGENTS.md:39` 的数量描述。
4. 不得在 list/check 之外的读接口里再加 `check_and_grant`（GET 写副作用应保持在受活动状态保护的分支内，如 `medal.py:18-19`）。
5. `check` 的广播条件是「newly 非空」（`medal.py:30`），改成无条件广播会增加管理端无意义重拉。

## 9. 当前实现状态

- **已实现**：2 个端点全部可用；12 枚勋章判定齐备；幂等发放、事件与广播链完整。
- **存在问题 / 已知不一致**：
  1. `GET /api/medal/list` 发放新勋章时**不广播** `data_changed`（只有 `POST /api/medal/check` 广播，`medal.py:30-31`）——管理端在用户仅浏览勋章墙触发的发放上要等下一次通知/刷新才能看到。现状事实，是否需要补广播**待确认**。
  2. `master` 勋章文案与实现口径不一致：seed 描述为「累计**答题**积分达到 500」（`backend/app/data/seed.py:304`），实现判定用 `points_service.get_total`＝**总积分（步行+答题）**≥500（`medal_service.py:68-69`、`:48`）。属用户可见文案与规则口径偏差，**待确认**以哪边为准（改文案或改判定）。
  3. **文档滞后（勋章数量）**：实际 12 枚（`seed.py:282-311` MEDALS 12 项、开发库 `medal_defs` 12 行），但 `backend/AGENTS.md:39` 写「勋章 6」。核对说明：任务上下文称 `backend/app/models/models.py` 顶部 docstring 也写「勋章 6」，经 grep（`勋章 6|勋章6`）**未在该文件命中**——models.py 头部 docstring（`models.py:1-9`）不含勋章数量；滞后仅存在于 `backend/AGENTS.md:39`。以 12 为准。
  4. `POST /api/medal/check` 无小程序调用方（仅测试脚本），属兜底/调试性质接口，但因有活动闸门且幂等，无刷分风险。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/medal.py`（3 个提交，2026-10-17 核对）；验证细节见 `docs/迭代记录.md` 对应条目。按时间倒序。

### 2026-10-13（`ce14a95`）

- 需求：V2.0 活动时间控制。
- 修改内容：list 换 `require_activity_view` 并在活动不可参与时跳过发放（`is_participation_open` 分支）；check 换 `require_activity_participation`。
- 关联文件：`backend/app/api/deps.py`、`backend/app/services/activity_service.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-01（`82af32c`）

- 需求：管理端实时数据变更通知。
- 修改内容：check 发放新勋章后 WS 广播 `medal.check`。
- 关联文件：`backend/app/core/ws.py`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-09-30（`a94e685`）

- 需求：项目初始化。
- 修改内容：创建本文件，含 list / check 两个端点。
- 关联文件：仓库初始代码。
- 测试结果：`docs/迭代记录.md` 该条目未记载验证结果，待确认。
