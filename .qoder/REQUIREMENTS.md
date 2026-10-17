# REQUIREMENTS · 长征步迹 当前生效业务规则

> 最后核对时间：2026-10-17（对应 HEAD `031c323`）
>
> **本文档只描述当前代码中实际生效的规则**，每条均给出「依据来源」（代码 `文件:行号`、配置项名、SQL 迁移编号或 `docs/迭代记录.md` 条目）。计划中未落地的能力标为「待开发」，无法确认的标为「待确认」，被移除的旧规则集中列在第 12 章「已废弃规则」以免被误当作现行规则。

## 0. 状态标记定义

| 标记 | 含义 |
|---|---|
| **已实现** | 代码中存在且经测试报告或迭代记录验证生效 |
| **部分实现** | 主链路已实现，但存在明确未完成分支或未接入的入口 |
| **待开发** | 需求已确认、后端接口或数据表可能已就绪，但用户可见功能未落地 |
| **已废弃** | 曾实现后被明确移除，**不再是现行规则** |
| **待确认** | 无法从代码、Git 历史、需求文档或可靠记录中确认，不做推测 |

---

## 1. 活动时间控制与准入

**状态：已实现**（V2.0 需求一）

### 1.1 规则

| 规则 | 值 / 行为 | 依据 |
|---|---|---|
| 活动名称 | 「长征步迹·荣耀征程」（默认值，可在管理端改） | `services/activity_service.py:34` `DEFAULT_NAME`；`docker/init/016_activity_settings.sql` |
| 配置存储 | `activity_settings` 表**单行**，`id = 1` | `activity_service.py:20` `SETTING_ID`；`models/models.py:108-123` |
| 状态计算 | **由服务器时间实时计算，不落库**：`unpublished` / `not_started` / `ongoing` / `ended` | `activity_service.py:49-59` `compute_status` |
| 判定顺序 | `setting is None` → 视为 `ongoing`；`not is_published` → `unpublished`；`now < start_at` → `not_started`；`now >= end_at` → `ended`；否则 `ongoing` | 同上 |
| 参与准入 `allow_participate` | **仅 `ongoing` 为真**；约束「产生新业务数据」的接口：步数同步、答题、积分、勋章、节点点亮 | `activity_service.py:62-68`；`api/deps.py:79` |
| 查看准入 `allow_view` | 未结束时恒为真；结束后取 `allow_view_after_end` | `activity_service.py:62-68`；`api/deps.py:81` |
| 总开关 | `restrict_enabled = False` 时两者**恒为 True**（仅展示状态，不拦截） | `activity_service.py:63-64` |
| 配置缺失兜底 | 配置不存在（如测试库未执行迁移）时**按「不限制」处理**，保证存量行为不变 | `activity_service.py:63`；模块文档串 `:9` |
| 时间存储 | `start_at` / `end_at` 为 **UTC naive** | `models/models.py:109` 文档串 |
| 结束文案 | `end_title`（默认「征程圆满 · 荣耀永驻」）、`end_message`（默认一段感谢语） | `activity_service.py:35-36` |
| 拒绝时的状态码与头 | **403 + `X-Activity-Status: <状态>`** | `api/deps.py:68-72` |
| 拒绝文案 | `unpublished`→「活动暂未发布，敬请期待」；`not_started`→「活动尚未开始，请于开始后参与」；`ended`→「活动已结束，暂不支持继续参与」 | `activity_service.py:38-42` |

### 1.2 前端行为

- 小程序：`services/request.js:87-91` 读取 `X-Activity-Status` → `:110-119` `redirectActivityClosed()` 跳 `pages/activity/activity`，**3 秒去抖**（`ACTIVITY_REDIRECT_GAP_MS = 3000`，`:7`）。
- 小程序启动页 `pages/launch/launch.js:109-121` 前置检查 `allowView`，**接口失败时默认放行**（fail-open），后端才是最终闸门。
- 管理后台 `admin/src/views/ActivityView.vue` 使用 `clockOffset` 做**服务器时间校准**，避免管理员本机时钟偏差导致预览状态错误。

### 1.3 待确认

- 生产环境实际配置的 `start_at` / `end_at` / `is_published` 值（属运行时数据，不在仓库中）。代码默认值 `ACTIVITY_START_DATE = "2026-09-01"`（`core/config.py:96`）**只是「第 N 期」计算的基准**，不等于活动开始时间。

---

## 2. 账号、登录与身份

### 2.1 微信登录（小程序） — **已实现**

| 规则 | 值 / 行为 | 依据 |
|---|---|---|
| 登录方式 | `wx.login` 取 code → `POST /api/auth/login {code, avatar}` | `frontend/services/auth.js:84-120` `callLogin` |
| openid 获取 | 后端调微信 `sns/jscode2session` | `backend/app/core/wx.py:15`、`:18-42` |
| 换取失败处理 | 抛 **502，绝不回落到 mock** | `services/auth_service.py:41-48` `_resolve_openid` |
| mock 回退条件 | 仅当**未配置微信凭证**，或配置了凭证且 `WX_LOGIN_ALLOW_MOCK = true`（注释明确「仅限本地自动化测试，生产必须为 false」） | `core/config.py:42-46`；`auth_service.py:35-38` |
| 返回状态 | `active`（签发令牌）/ `disabled` / `unregistered`（后两者 reject 携带 `err.admission`） | `auth_service.py:68-83` |
| 令牌 | HS256 JWT，`sub` = 用户主键，**有效期 7 天**（`JWT_EXPIRE_MINUTES = 10080`） | `core/security.py:10-19`；`core/config.py:39` |
| 默认昵称 | 「长征小战士」（登录时前端**不传 nickname**，只传 avatar）；默认值是 **ORM 列默认值**，不由接口代码显式赋值 | `frontend/pages/login/login.js:1-6` 注释；**`backend/app/models/models.py:192`**（`nickname: Mapped[str] = mapped_column(String(64), default="长征小战士")`） |
| 头像 | 前端 `persistAvatar` 保存到 `wx.env.USER_DATA_PATH`，**不上传服务端**；已是用户目录路径或 `https://` 开头则原样返回；失败降级返回原路径 | `frontend/services/auth.js:18-34`（**未导出**） |
| 登录页形态 | 登录按钮本身就是 `<button open-type="chooseAvatar">`，**页面没有昵称输入框** | `frontend/pages/login/login.js:1-6` |
| 改名次数 | **每人仅一次**，走 `PUT /api/auth/nickname` | `frontend/services/auth.js:223-227`；`backend/app/api/routes/auth.py:92` summary「修改昵称（每人仅一次）」 |
| 初始昵称 | 另有 `PUT /api/auth/nickname/initial`，**不消耗改名次数** | `frontend/services/auth.js:230-234` |
| 本地缓存不代表已登录 | `globalData.loggedIn` 只有在后端 token 校验通过或登录成功后才为 true | `frontend/app.js:6` 注释；`frontend/design.md:103` |

### 2.2 入驻与邀请码 — **已实现**

| 规则 | 值 / 行为 | 依据 |
|---|---|---|
| 准入模型 | **只有持有效邀请码入驻过的用户才能登录使用**；`/auth/login` 对未注册用户返回 `unregistered` 而**不建号** | `routes/auth.py:29` summary「仅已入驻用户签发令牌」；`auth_service.py:68-83` |
| 邀请码格式 | 16 位，字母 + 数字（`secrets.choice`） | `services/invite_service.py:19-20`、`:33-34` |
| scene 格式 | `i={code}`；小程序码 scene 上限 32 字符，校验正则 `^[A-Za-z0-9]{1,32}$` | `invite_service.py:21`、`:22`；`frontend/pages/launch/launch.js:25-35` |
| 核销方式 | **带全部有效性条件的单条 UPDATE，按影响行数判定成功**，并发下不会超发 | `invite_service.py:4` 文档串 |
| 一次性语义 | 邀请码**只决定「首次入驻」资格**；已入驻用户登录不再校验原邀请码（过期/停用/用满不影响） | `invite_service.py:3` 文档串 |
| 组织越界 | 邀请码绑定的组织子树之外不可入驻，抛 `InviteError("所选组织不在邀请码允许的范围内")` | `invite_service.py:64-70` |
| 校验接口 | `POST /api/auth/invite/verify` **只校验不核销** | `routes/auth.py:47` summary |
| 入驻接口 | `POST /api/auth/onboard {code, inviteCode, nickname, orgId, avatar}` → `{user, created}` | `frontend/services/auth.js:180-220`；`auth_service.py:92-155` |
| 敏感信息约束 | 邀请码属入驻凭证，**不写入日志与审计明细**（审计只记 id 与名称） | `invite_service.py:5` 文档串 |
| 暂存 | 邀请码存入 `lm_pending_invite`，键结构 `{code, orgId, orgName}` | `frontend/services/auth.js:257-275` |
| 无邀请码时 | 启动页 `phase = blocked`，提供「扫码」与「重试」两个出口 | `frontend/pages/launch/launch.js:83-107`、`:141-162`、`:164-170` |

### 2.3 组织架构 — **已实现**

| 规则 | 值 / 行为 | 依据 |
|---|---|---|
| 结构 | **多级树**，`organizations.parent_id` 为空即顶级 | `services/org_service.py:3` 文档串 |
| 种子数据 | 13 个组织，id 1–13 | `backend/app/data/seed.py:318` `ORGANIZATIONS` |
| 用户可选层级 | **任意层级节点** | `org_service.py:3-4` |
| 排序 | `sort_order`, `id` | `org_service.py:38` |
| 下钻信息 | 每项附带 `has_children` / `child_count`，**批量统计避免逐项查询** | `org_service.py:18-27` `_child_counts`、`:30-51` |
| **锁定规则** | 所属组织**首次确定（入驻或首次选择）后即锁定，用户侧不可再改**，仅管理员可调整并留审计 | `org_service.py:4-5` 文档串；提示文案 `:15` `ORG_LOCKED` |
| 组织名自愈 | 小程序「我的」页每次 refresh 用后端返回的 `orgFullName` 反向校准本地 | `frontend/pages/mine/mine.js:41-46` |
| 换组织防残留 | 保存服务端 user 时，**仅当 id 相同且 orgId 相同**才保留本地 `orgName` / `orgFullName` | `frontend/services/auth.js:54-63` `saveServerUser` |
| 选择页双模式 | `from=onboard` → **免登录**、可选范围锁死在 `rootId` 子树内（`onTapCrumb` 的 `minIndex = 0` 防越级上溯）；其它 → 登录守卫 + 已锁定则只读 | `frontend/pages/org-select/org-select.js:31-65`、`:113-125` |
| 跨页回调 | 选择结果通过 `getOpenerEventChannel().emit('orgPicked', {orgId, orgName, orgFullName})` 回传，**非全局事件** | `org-select.js:140-177`；`onboard.js:48-65` |
| 外部同步 | `ORG_SYNC_API_URL` 留空时同步使用内置种子数据 | `core/config.py:63-64` |
| PC 端组织人数统计 | 已实现于 orgs 树接口（**排名/积分仍取消**，见第 12 章） | 项目记忆 `org-ranking-cancelled` |

### 2.4 员工身份绑定与扫码 — **部分实现**

| 规则 | 值 / 行为 | 状态 | 依据 |
|---|---|---|---|
| scene 前缀语义 | `L{token}` = PC 管理端登录确认；`B{token}` = 身份绑定 | 已实现 | `frontend/pages/bind/bind.js:48-71` `loadScene` |
| 扫码接口 | `POST /api/auth/qr/info`、`POST /api/auth/qr/confirm`、`GET /api/auth/identities`、`DELETE /api/auth/identities/{id}` | 已实现 | `frontend/services/identity.js` |
| 会话有效期 | `QR_LOGIN_TTL_SECONDS = 300`；`BIND_REQUEST_TTL_SECONDS = 600` | 已实现 | `core/config.py:56-57` |
| 状态机 | `pending` / `scanned` → 确认卡；`confirmed` / `used` / `cancelled` → 完成态；`failed` → 展示后端 `failReason` | 已实现 | `bind.js:74-96` `renderByStatus` |
| 未登录扫码 | `reLaunch` 到 `launch?redirect=<bind?scene=…>`，**登录后可原路返回扫码页** | 已实现 | `bind.js:26-45` |
| 取消遇终态 | 重新查询状态 | 已实现 | `bind.js:149-167` |
| 小程序码环境版本 | `WXACODE_ENV_VERSION` 默认 `trial`（体验版，扫码者须为体验成员）；**生产发布后须改 `release`** | 已实现，生产值待确认 | `core/config.py:52-53` |
| **`wx_web` 网页授权渠道** | 配置项 `WX_WEB_APPID` / `WX_WEB_SECRET` 存在（注释「扫码登录渠道阶段2；留空则该渠道禁用」），`user_identities.provider` 支持该值，管理端能展示，**但小程序端无任何触发路径** | **部分实现** | `core/config.py:48-50`；`frontend/pages/account/account.js` `PROVIDER_NAMES` |
| **`pages/account/account` 页面** | 已在 `app.json:23` 注册，但**全项目无任何跳转入口**；`frontend/design.md:48` 明确「入口暂时隐藏，页面与后端 API 保留」 | 已实现但入口隐藏 | 同上；`account.js:52-78` 的 `handleUnbind` 对主凭证做防御性提示，但该按钮在 WXML 里并未渲染（**死代码路径**） |
| 主凭证不可解绑 | 「微信登录凭证不可解绑」 | 已实现（但按钮未渲染） | `account.js:52-78` |

### 2.5 账号停用 — **已实现**

| 规则 | 行为 | 依据 |
|---|---|---|
| 即时断权 | 每个已鉴权请求都校验 `users.status`，非 `active` → **403 + `X-Account-Status: disabled`** | `api/deps.py:46-53` `_ensure_active` |
| 前端响应 | 小程序 `request.js:81-86` 置 `err.admission = 'disabled'`（兼容小写头名）→ `clearSession()` 重登 → 启动页 `phase = disabled` 停留页 | `frontend/pages/launch/launch.js:62-80` |
| 退出 | 停留页提供 `onExit` → `wx.exitMiniProgram`，`navigateBack` 兜底（try/catch 兼容旧基础库） | `launch.js:164-170` |
| 管理端 | `typ=user` 的管理员令牌每请求查库重建权限，**撤销即时生效** | `api/deps.py:142-147` |
| 管理端缺口 | `admin/src/api/request.ts` **403 无专门分支、不跳转、不消费上述两个响应头** | 已知限制 |

---

## 3. 微信运动步数同步

**状态：已实现**

### 3.1 同步规则

| 规则 | 值 / 行为 | 依据 |
|---|---|---|
| 授权 scope | `scope.werun` | `frontend/services/sport.js:19-27` |
| 数据来源 | 前端 `wx.getWeRunData()` 的加密数据 → 后端用 code2Session 换 `session_key` 解密 `stepInfoList` | `services/sport_service.py:6` 文档串 |
| 解密算法 | **AES-128-CBC**，并**校验 `watermark.appid`** | `core/wx.py:45-61` |
| `session_key` 处理 | **从不落库、从不打日志** | `core/wx.py:3-4` 注释 |
| 存储粒度 | **按 user + date 每日一行**（`daily_sport`） | `sport_service.py:3` 文档串 |
| 覆盖语义 | 微信最近 7 日数据**逐日覆盖而非累加** | 同上 |
| 时区口径 | 按**北京时间**处理解密结果中的近 7 个自然日 | `docs/迭代记录.md` 微信运动真机全链路条目 |
| 缺失日期 | **不写 0、不覆盖已有记录**，并返回待重试明细 | 同上 |
| 历史步数校正 | **可幂等校正**；补录后从受影响日期起重算积分台账 | 同上 |
| 步数只增不减 | 同步时步数只增不减 | `2f3f333` 提交说明 |
| 重复同步 | 同一日重复同步**取最大值**，幂等 | `docs/迭代记录.md` 积分 P01–P08 用例 |
| 并发控制 | 条件 UPDATE + `with_for_update()` 行锁 | `sport_service.py:105-111` |
| 派生字段 | `distance` 按步长估算同步更新；`is_goal_completed` 与连续行军由 `streak_service` 维护 | `sport_service.py:9-10` |
| 距离公式 | `距离(km) = 步数 × STRIDE_M / 1000`，`STRIDE_M = 0.7` | `core/config.py:94` |
| mock 步数 | **仅 mock 登录用户（开发模式）或未配置微信凭证时**回退 `seeded_steps` 模拟，**真实用户绝不编造步数** | `sport_service.py:7` 文档串 |
| 写入副作用（事件） | `FIRST_STEP` 首次运动 / `DAILY_GOAL` 当日达标 / `STEP_10000` 单日破万 / `TOTAL_STEPS_*` 累计突破，**均以事件表去重** | `sport_service.py:10-12` |
| 累计里程碑阈值 | `TOTAL_MILESTONES = [(100000, "TOTAL_STEPS_100000"), (500000, "TOTAL_STEPS_500000")]` | `sport_service.py:28` |

### 3.2 今日目标与连续行军

| 规则 | 值 | 依据 |
|---|---|---|
| **今日目标步数** | **20000**（展示用） | `sport_service.py:27` `DAILY_TARGET`；`GET /api/sport/today` 下发 |
| 前端强制覆盖 | `frontend/services/sport.js` 另有常量 `DAILY_TARGET = 20000`，在 `getToday()` **服务边界统一覆盖后端 `target` 字段**，防止线上旧后端返回 10000 时被首页 `refreshAll` 覆盖 | `docs/迭代记录.md`「前端服务层强制今日目标为 20000 步（缺陷修复）」 |
| **连续行军达标门槛** | 当天步数 **≥ 5000**（`STREAK_GOAL_STEPS`）即完成当日行军 | `core/config.py:95`；`services/streak_service.py:3` |
| 文案区分 | 5000 步门槛文案明确为**「连续行军目标」**，与 20000 的「今日目标」区分，避免混淆 | `docs/迭代记录.md` |
| 当前连续天数 | 从今天往前数连续达标日；**今天未达标时允许从昨天开始数**（今日尚未结束，连续仍有效）；昨天也未达标则为 0 | `streak_service.py:36-39` `streaks_of` 文档串 |
| 中断判定 | 缺记录的日期视为中断 | `streak_service.py:23` `longest_run` 文档串 |
| 缓存字段 | `users.continuous_days` / `max_continuous_days` 为**缓存**，供管理端列表免逐户重算；启动时 `recompute_all` 全量兜底 | `streak_service.py:8-9` |
| 里程碑积分 | **V2.0 起里程碑不再发放积分**（一次性成就仅写事件） | `streak_service.py:5-6` |

### 3.3 已知遗留

**补签（待开发）**：`daily_sport` 确有 `is_makeup`（`Boolean`，NOT NULL DEFAULT FALSE）与 `makeup_at`（`DateTime`，可空）两列，由 `docker/init/005_upgrade.sql:31-36` 建立，`backend/app/models/models.py:248-249` 映射，`:235` docstring 自述「为补签预留字段」。**但全仓无任何业务写入点**（`sport_service.py`、`streak_service.py` 均不读写），开发库实测 **0 行** `is_makeup=true` 或 `makeup_at` 非空。结论：**字段已建、业务未实现**，属预留死字段（另见 `PROJECT.md` §8 技术债 29）。补签的产品规则（可补几天、是否消耗积分、是否影响连续行军判定）**无任何需求依据，待产品确认**。

---

## 4. 积分体系（V2.0 现行口径）

**状态：已实现**（`2f3f333` 台账重构 → `4afccdd` → `83d3552` → `85c5a55` → `9cb65b8` 四次连续修正，见第 12 章与 CHANGELOG）

### 4.1 总公式

```
总积分 = 步行积分 + 答题积分
```
依据：`core/config.py:101` 注释「积分规则（V2.0）：总积分 = 步行积分 + 答题积分」；`services/points_service.py:1` 文档串。

### 4.2 步行积分（累计结余口径，**无单日上限**）

| 规则 | 值 / 行为 | 依据 |
|---|---|---|
| 计分单位 | **每满 1000 步得 1 分**，不足不计（`POINTS_WALK_STEPS_PER_POINT = 1000`） | `core/config.py:102` |
| 单日封顶 | **无**（原 20000 封顶已于 `9cb65b8` 移除，配置项 `POINTS_WALK_STEP_CAP` 已删除） | `points_service.py:4`「不设单日上限」；`core/config.py` 已无该项 |
| 逐日公式 | `当日积分 = floor(累计 / 1000) − floor(前一日累计 / 1000)` | `points_service.py:5-6`；`walk_chain()` `:34-41` |
| 结余 | 不足 1000 步的零头**结余到下一条记录**，跨日可累计 | `points_service.py:6`；`walk_carry()` `:44-51` |
| 恒等式 | **累计步行积分 ≡ 累计计分步数 // 1000** | `points_service.py:101-105` `recompute_walk` 文档串 |
| 重算范围 | 步数同步/补步后调 `recompute_walk`，按运动源数据**全量核对该用户全部步行台账**（不止本次写入日期，历史旧口径错账一并修正）；残留的无效 walk 行**清零** | `points_service.py:11-13`、`:100-108` |
| 启动兜底 | `main.py:48` 启动时执行 `points_service.recompute_walk_all(db, fix=True)` | `main.py:41-51` |
| 分批 | `RECOMPUTE_BATCH = 500` 用户 | `points_service.py:31` |

### 4.3 答题积分

| 规则 | 值 | 依据 |
|---|---|---|
| 每答对 1 题 | **+2 分**（`POINTS_QUIZ_PER_CORRECT = 2`） | `core/config.py:103` |
| 答错 | **不扣分** | `points_service.py:7`；`quiz_service.py:7` |
| 单日上限 | **10 分**（`POINTS_QUIZ_DAILY_CAP = 10`），即每日最多 5 题全对恰好触顶 | `core/config.py:104`；`quiz_points()` `points_service.py:59-61` |

### 4.4 台账（`points_log`）

| 规则 | 值 / 行为 | 依据 |
|---|---|---|
| 粒度 | **每人每来源每自然日一行** | `points_service.py:8` |
| `biz_key` | `walk:{日期}` / `quiz:{日期}` | `points_service.py:64-65` `biz_key()` |
| 唯一约束 | `(user_id, biz_key)` | `docker/init/017_points_ledger.sql`；`models/models.py:337` |
| 写入方式 | 业务写入时在**同一事务内按源数据重算覆盖**；`set_daily` **不提交，由调用方统一提交** | `points_service.py:9`、`:68-97` |
| 幂等性 | **重复同步 / 重放请求 / 并发只会得到同一结果，不会重复计分** | `points_service.py:10` |
| 行锁 | `set_daily` 在 `with_for_update()` 内覆盖 | `points_service.py:73-78`、`:96` |
| 零值处理 | 无既存行且 `delta <= 0` 时**不建行**，返回 False | `points_service.py:79-81` |
| 全量校验 | `recompute_walk_all` / `recompute_all` 按源数据（`daily_sport` / `quiz_answers`，**历史日回退 `quiz_records`**）全量核对并可修复 | `points_service.py:14-16` |
| 旧流水 | V2.0 之前的旧规则流水 `source_type = legacy`，**保留追溯但不计入总积分** | `points_service.py:13` |
| `ref_id` | 关联源记录 id，与 `delta` 一起判断是否发生变化。**答题积分的 `ref_id` 指向 `daily_questions.id`（当日答题会话），不是 `quiz_records.id`**；步行积分的 `ref_id` 指向 `daily_sport.id`。无 DB 级外键，开发库实测 0 孤儿 | `points_service.py:94-96`；答题侧传参见 `quiz_service.py:260`、`:452`（均传 `session.id`，`_session` 返回 `DailyQuestion`，见 `:149`） |

### 4.5 展示

- 小程序积分明细页 `pages/points/points`（`enablePullDownRefresh: true`）。
- `profile/summary` 仅保留原始 `totalSteps`（`scoredTotalSteps` 已随封顶移除而删除，`9cb65b8`）。
- 积分规则文案由后端 `rules` 下发，**不再包含 `walkStepCap` / `walkDailyCap`**（`9cb65b8`）。

---

## 5. 每日答题

**状态：已实现**（V2.0 需求六：每题限时作答）

### 5.1 题量与抽取

| 规则 | 值 / 行为 | 依据 |
|---|---|---|
| 每日题量 | **最多 5 题**（`DAILY_COUNT = 5`） | `services/quiz_service.py:35` |
| 同日固定 | **同日题组固定且不重复** | `quiz_service.py:4` 文档串 |
| 抽取策略 | **每用户按个人使用历史分轮随机**；逐题使用次数优先抽取**最少使用层**，题量不足时跨轮补足 | `quiz_service.py:4`；`docs/迭代记录.md` |
| 题库不足 | 返回**明确状态**（不静默降级） | `docs/迭代记录.md` |
| 题库规模 | 种子 **15 题**，id 1–15 | `backend/app/data/seed.py:200` `QUESTION_BANK` |
| 题型 | `single` 单选 / `judge` 判断 | `models/models.py:127` 文档串 |
| 删除题目 | 改为**停用以保留已生成会话** | `docs/迭代记录.md` |
| 期号 | `issue_no` = 第 N 期，以 `ACTIVITY_START_DATE`（`2026-09-01`）为第 1 期；**早于起始日按 1 计** | `quiz_service.py:15`、`:51-55` `_issue_no`；`core/config.py:96` |

### 5.2 计时与提交

| 规则 | 值 / 行为 | 依据 |
|---|---|---|
| 每题时限 | **90 秒**（`QUIZ_QUESTION_SECONDS`），**计时只认服务器时间** | `core/config.py:97`；`quiz_service.py:4` |
| 网络宽限 | 截止后 **2 秒**（`QUIZ_ANSWER_GRACE_SECONDS`）内到达的提交视为网络延迟**仍受理**；**仅用于接收提交** | `core/config.py:98`；`quiz_service.py:11` |
| 被动查询 | 亦按此宽限判定超时 | `quiz_service.py:11` |
| 提交次数 | **每题仅可提交一次，提交即判定** | `quiz_service.py:5` |
| 超时后果 | **不得分，且之后不可再提交** | `quiz_service.py:5` |
| 放弃当前题 | 主动「开始下一题」**视为放弃当前题，截止即判超时** | `quiz_service.py:12` |
| 竞态处理 | 判定与超时**均以 `status = 'answering'` 为条件更新**，并发重复提交 / 提交与超时竞态**只有一个生效** | `quiz_service.py:10` |
| 状态取值 | `answering` / `answered` / `timeout` | `quiz_service.py:37` |
| 错误文案 | `NOT_STARTED`「该题尚未开始作答」、`ALREADY_ANSWERED`「本题已作答，不能重复提交」、`ANSWER_TIMEOUT`「本题作答已超时，不能再提交」 | `quiz_service.py:39-41` |
| 当日记录 | **全部题目结束后**生成当日答题记录（`quiz_records`） | `quiz_service.py:5` |

### 5.3 安全约束

| 规则 | 行为 | 依据 |
|---|---|---|
| 下发范围 | **只下发「当前已开题」的题目**，不预先下发整套题（防止提前查答案） | `quiz_service.py:8` |
| 字段裁剪 | 下发内容**不含 `answer` / `analysis`** | `quiz_service.py:8` |
| 全量落库 | 开题时间、截止时间、提交时间、作答内容、判定与超时全部落 `quiz_answers` | `quiz_service.py:9` |
| 时间存储例外 | `quiz_records.answer_at` 存**毫秒级 BigInteger**，不是 datetime | `models/models.py:287`；`quiz_service.py:58-60` `_ms` |

### 5.4 情报化扩展（功能 8） — **已实现，入口已调整**

| 规则 | 状态 | 依据 |
|---|---|---|
| 返回 `issue_no` | 已实现 | `quiz_service.py:15` |
| `get_knowledge` 按题目 `category` 聚合历史答题正确率（知识画像） | 已实现 | `quiz_service.py:16`、`:44-48` `KNOWLEDGE_CATEGORIES`（`event` 历史事件 / `route` 长征路线 / `figure` 历史人物） |
| 底部「情报」tab | **已换防为「AI 问答」**；quiz 降级为子页，由**首页情报卡**进入 | 项目记忆 `ai-center-phase-a-status`（frontend `0052108`）；`frontend/app.json` tabBar |
| 情报 2「交卷看解析」 | 用**情报 tab 内模式切换**实现（原生 tabBar 上限 5 个，不能加第 6 个 tab） | 项目记忆 `quiz-modes-inpage-switch` |

### 5.5 待开发

| 项 | 状态 | 备注 |
|---|---|---|
| 答题页「AI 讲解」按钮 | **待开发** | 后端 `GET /api/ai/quiz-explanation/{question_id}` **已就绪** |

### 5.6 已知风险

**调试端点 `POST /api/quiz/reset` 在生产环境暴露**，可被用于重置答题状态刷分 —— 建议加环境开关，**尚未处理**。

---

## 6. 长征路线与节点点亮

**状态：已实现**

### 6.1 节点

| 规则 | 值 / 行为 | 依据 |
|---|---|---|
| 节点数 | **10 个**，id 1–10 | `backend/app/data/seed.py:84` `ROUTE_NODES` |
| 解锁依据 | **累计步数**达到该节点的 `target_steps` | `models/models.py:44`；`services/march_service.py:137` |
| 节点状态 | `completed` 已点亮（**一旦点亮永久保留**）/ `current` 进行中（达到上一节点但未达当前节点）/ `unlocked` 未解锁（未达到上一节点） | `march_service.py:4-6` |
| `current` 判定 | `prev is None or current_steps >= prev.target_steps` | `march_service.py:137` |
| 累计步数来源 | `sport_service.get_total_steps`（`daily_sport` 每日步数求和，**库内聚合**） | `sport_service.py:31-38` |
| 总目标 | `total_steps_target` = 最后一个节点的 `target_steps` = **65000** | `march_service.py:157`；`seed.py` id 10 延安 |
| 进度 | `min(1.0, current_steps / total_steps_target)` | `march_service.py:164` |
| 点亮动作 | `light_up_nodes(db, user_id)` 返回 `(新点亮, 章节完成)` 两个列表 | `march_service.py:354` |
| 点亮快照 | `lit_nodes.step_snapshot` 记录**点亮时刻累计步数快照**；历史回填数据 `snapshot = 0` | `march_service.py:278`、`:314` |
| 坐标来源 | **全部来自 `GET /api/march/route`**；`getNodeDetail` 缺坐标时回退再拉一次 route 补齐 | `frontend/services/march.js:32-46` |

### 6.2 节点门槛（种子数据）

| id | 节点 | `target_steps` | 历史时间 |
|---|---|---|---|
| 1 | 瑞金 🚩 | 0 | 1934年10月 |
| 2 | 遵义 🏛️ | 5,000 | 1935年1月 |
| 3 | 四渡赤水 🌊 | 10,000 | 1935年1-3月 |
| 4 | 巧渡金沙江 ⛵ | 15,000 | 1935年5月 |
| 5 | 强渡大渡河 ⚔️ | 20,000 | 1935年5月 |
| 6 | 飞夺泸定桥 🌉 | 25,000 | 1935年5月29日 |
| 7 | 翻越雪山 🏔️ | 35,000 | 1935年6月 |
| 8 | 过草地 🌾 | 45,000 | 1935年8月 |
| 9 | 吴起镇 🎺 | 55,000 | 1935年10月 |
| 10 | 延安 ⭐ | 65,000 | 1936年10月 |

依据：`backend/app/data/seed.py:84-199`。**这些是种子默认值，管理端可改**（`route_nodes` 表可编辑）。

### 6.3 章节系统（需求 §4） — **部分实现**

| 规则 | 状态 | 依据 |
|---|---|---|
| 10 个节点划分为 **5 章** | 已实现 | `march_service.py:8-9`；`CHAPTERS` `:23-44` |
| 章节划分 | 第一章·出发 [1,2]｜第二章·转折 [3,4]｜第三章·突围 [5,6]｜第四章·翻越 [7,8]｜第五章·会师 [9,10] | `march_service.py:23-44` |
| 每章含 `intro` 公开史实概述，供章节完成仪式展示 | 已实现 | 同上 |
| 章节状态由**后端统一下发** | 已实现 | `march_service.py:9` |
| 章节最后节点点亮写 `CHAPTER_COMPLETE` 事件（**不改变原有节点点亮逻辑**） | 已实现 | `march_service.py:9-10` |
| **`CHAPTERS` 硬编码在代码中** | **技术债** | `march_service.py:9` 文档串、`:22` 注释「管理端可视化编辑为后续增强」 |
| 管理端可视化编辑章节 | **待开发** | 同上 |

### 6.4 全员共同长征目标（需求 §11） — **部分实现**

| 规则 | 值 | 依据 |
|---|---|---|
| 活动总目标 | `GLOBAL_GOAL_STEPS = 200,000,000`（2 亿步） | `march_service.py:48` |
| 阶段里程碑 | 5000万 / 1亿 / 1.5亿 / 2亿 | `march_service.py:49-54` `GLOBAL_MILESTONES` |
| 里程碑发放积分 | **V2.0 起不再发放** | `streak_service.py:5-6` |
| 管理端可视化编辑 | **待开发**（`march_service.py:47` 注释「管理端可视化编辑为后续增强」） | 同上 |
| **里程碑仪式相关钩子** | **延后**（`march_service.py:242` 注释标记） | 技术债 |

### 6.5 仪式与凭证页

| 规则 | 行为 | 依据 |
|---|---|---|
| 仪式触发 | `route.ceremonyPending` → `reLaunch`/`navigateTo` 到 `pages/ceremony/ceremony` | `frontend/pages/march/march.js` |
| 仪式确认 | `handleConfirm` → `markCeremony` → `navigateBack` | 同上 |
| 页面配置 | `ceremony` 设 `disableScroll: true` | `frontend/pages/ceremony/ceremony.json` |
| Canvas 盖 DOM 解法 | 动画结束后 `finalizeScene` 用 `canvasToTempFilePath` 导出末帧，`wx:if` 移除 canvas 换成 `<image>`，此后 DOM 数据卡片可正常层叠 | `frontend/pages/ceremony/ceremony.js:228-240` |
| 开场动画一次性 | `lm_march_intro_played` 标记 | `frontend/services/march.js:90-106` |
| 节点凭证页 | `pages/ticket/ticket?id=`，**仅已点亮节点可进入** | `frontend/pages/node-detail/node-detail.js` |
| 人物页 | `pages/person/person?id=` | 同上 |

### 6.6 地图与手势（`pages/march/march.js`，1477 行）

| 规则 | 值 | 依据 |
|---|---|---|
| 双模式 | `real`（实景地图，原生 `<map>`）/ `canvas`（星空长征，Canvas 2D）。**由用户手动切换，不是自动降级**：WXML 顶部常驻两个按钮，初值 `real`；切到 `canvas` 时 `initCanvas()`，切回 `real` 时 `<canvas>` 已被 `wx:else` 移除，故显式置空 `ctx`/`canvas`/`staticLayer`/`glowGold`/`glowRed`/`arriveFx` 释放画布与离屏缓存，再用最新路线重建 markers 并重播视角动画 | 按钮：`frontend/pages/march/march.wxml:52-64`（两个 `bindtap="switchMode"` + `data-mode`）；初值：`march.js:49`；处理函数：`march.js:361-380` |
| 定位标记 | `buildMapData` 中 marker `id = 999`，标题「🚩 我在这里」 | 同上 |
| 手势命中半径 | `radius = 22 / v.scale`（**除以缩放比**，保持屏幕命中半径恒定） | `frontend/pages/march/march.js:1453-1467` `hitNode`（`radius` 在 `:1458`） |
| 路线绘制 | `utils/routeCanvas.js`：`sampleRoutePath`（`:62-101`）、`distToIndex`（`:104-113`）、`createGlowSprite`（`:120-133`） | — |
| 节点主题 | `frontend/data/node-themes.js` 定义 **5 套主题** + `NODE_THEME_MAP` | — |

### 6.7 待开发

| 项 | 状态 | 备注 |
|---|---|---|
| `node-detail` AI 讲解面板 | **待开发** | 后端 `GET /api/ai/route-guide/{node_id}` **已就绪** |

---

## 7. 排行榜

**状态：已实现**

| 规则 | 值 / 行为 | 依据 |
|---|---|---|
| 榜单口径 | **全员工「总积分」总榜，跨所有组织**；小程序与管理端**同一口径** | `services/rank_service.py:1` 文档串 |
| 排序 | 总积分降序 → **同分按累计步数降序** → 再按 `user_id` 升序，**保证名次稳定且两端一致** | `rank_service.py:4-5`；`:40` `func.row_number().over(order_by=(points.desc(), steps.desc(), User.id.asc()))` |
| 计算位置 | **在数据库内用窗口函数计算，只取榜单所需的少量行**，用户量大时不做全量加载 | `rank_service.py:6`；`ranked_users_subquery()` `:20-45` |
| 前十 | `ELITE_SIZE = 10` —— 小程序**领奖台 + 荣誉卡区（第 1~10 名）始终返回** | `rank_service.py:17` |
| 旧榜单条数 | `TOP_LIMIT = 100`（旧版 `/rank/steps`） | `rank_service.py:16` |
| 返回字段 | `user_id` / `steps` / `points` / `walk_points` / `quiz_points` / `rank` | `rank_service.py:21` 文档串 |
| 管理端 | 服务端分页 + 领奖台 + 详情抽屉 + `verifyPoints(fix)` 台账核对修复 | `admin/src/pages/RankingsView.vue` |
| 小程序领奖台顺序 | `PODIUM_ORDER = [1, 0, 2]`（视觉上 2-1-3 排列） | `frontend/pages/rank/rank.js` |
| 下拉刷新 | `rank` 页 `enablePullDownRefresh: true` | `frontend/pages/rank/rank.json` |
| 导出 | CSV 流式导出，走独立 Session + `yield_per(1000)` + UTF-8 BOM + 公式注入防护 | `routes/admin.py:347-362`；`admin_service.py:433-438`、`:456-458`、`:238`、`:423` |
| **组织排名 / 分组织积分对比** | **已取消**（不再实现） | 项目记忆 `org-ranking-cancelled` |
| **PC 端组织人数统计** | 2026-10-02 **重新纳入**，已实现于 orgs 树接口 | 同上 |

---

## 8. 勋章

**状态：已实现**

### 8.1 发放机制

| 规则 | 行为 | 依据 |
|---|---|---|
| 发放方式 | **由后端根据用户行为自动发放**，业务数据变化后调 `check_and_grant` 刷新 | `services/medal_service.py:3` |
| 返回 | 本次新获得的勋章 id 列表 | `medal_service.py:34` |
| 事件 | 新获勋章写 `BADGE_UNLOCK` 事件（**我的足迹与管理端动态同源**） | `medal_service.py:10` |
| 查询优化 | 运动类条件**只查一次 `daily_sport`**（每用户每日一行），在内存中派生全部指标 | `medal_service.py:37-42` 注释 |
| 节点映射 | `MEDAL_NODE_MAP = {"luding": 6, "snow": 7}`，**与前端 `medal.js` 的 `nodeByName` 口径一致** | `backend/app/data/seed.py:314` 及注释 |

### 8.2 12 枚勋章及条件（种子数据，管理端可改）

| # | id | 名称 | 图标 | 条件 | 分类 | 隐藏 |
|---|---|---|---|---|---|---|
| 1 | `first-step` | 初次出发 | 🏃 | 完成第一次运动同步 | starter | 否 |
| 2 | `learner` | 红色学习者 | 📖 | 完成 10 次每日答题 | starter | 否 |
| 3 | `persistence` | 坚持不懈 | 🔥 | 连续行军 7 天 | starter | 否 |
| 4 | `luding` | 飞夺泸定桥 | 🌉 | 点亮节点 id 6 | route | 否 |
| 5 | `snow` | 翻越雪山 | 🏔️ | 点亮节点 id 7 | route | 否 |
| 6 | `day-10k` | 日行万步 | 👟 | 单日步数达到 10,000 | challenge | 否 |
| 7 | `steps-100k` | 十万征程 | 🎖️ | 累计步数达到 100,000 | challenge | 否 |
| 8 | `steps-500k` | 五十万征程 | 💪 | 累计步数达到 500,000 | challenge | 否 |
| 9 | `streak-30` | 铁血行军 | ⛺ | 连续行军 30 天 | challenge | 否 |
| 10 | `master` | 知识达人 | ⭐ | 见下方 ⚠ | challenge | 否 |
| 11 | `fearless` | 不畏艰险 | 🧗 | 连续 7 天每天步数达到 10,000 | challenge | **是** |
| 12 | `victory` | 长征胜利 | 🏆 | 完成整个长征路线（点亮全部节点） | complete | 否 |

依据：`backend/app/data/seed.py:282-311`；条件实现见 `services/medal_service.py:4-9` 文档串与 `:68-69`。

### 8.3 ⚠ `master` 勋章文案与实现不一致

- **用户可见文案**（seed）：「累计**答题积分**达到 500」
- **代码实现**：`total_points = points_service.get_total(db, user_id)`（`medal_service.py:48`），`if total_points >= 500`（`:68-69`）—— `get_total` 返回的是 **总积分（步行 + 答题）**（`points_service.py:182-183`）
- **服务层文档串**：「master 累计积分 ≥ 500」（`medal_service.py:5`）—— 与代码一致

即：**实现按总积分判定，但展示文案写的是答题积分**。属实际存在的口径不一致，**修正方向待确认**（改文案还是改实现）。

---

## 9. 个人中心与我的

**状态：已实现**

| 规则 | 行为 | 依据 |
|---|---|---|
| 聚合接口 | `GET /api/profile/*`（`routes/profile.py`，前缀 `/profile`） | `main.py:81` |
| 积分概览 | `points_service.get_summary`：累计三项 + 今日两项（含今日步数/答对数，**供展示计分依据**）+ 当前步数结余 | `points_service.py:186-187` |
| 「我的」页字段 | 累计运动(步) 展示**原始 `totalSteps`**（`scoredTotalSteps` 已随封顶移除而删除） | `9cb65b8`；`docs/迭代记录.md:86` |
| 组织名自愈 | 每次 refresh 用后端 `orgFullName` 反向校准本地并 `auth.updateLocalUser({orgFullName})`，修复「重登或管理端调整后本地组织名过期/缺失」 | `frontend/pages/mine/mine.js:41-46` |
| 阶段称号 | `profile.js` 按阈值计算 `stageTitle` | `frontend/pages/profile/profile.js` |
| 日历热力 | `pages/calendar/calendar`，**4 个热力等级由后端提供**；快速切月用 `_requestId`（`:44-72`）防竞态 | 同上 |
| 退出登录 | `mine.js:151-163` `handleLogout` → `app.logout()` → `reLaunch('/pages/login/login')`；写 `lm_logged_out` 阻止静默重登 | `frontend/services/auth.js:250-254`；`services/request.js:28-45` |
| 已知注释坑 | `mine.js:119` 的 `showModal` 用的是 `title` 而非 `content`（注释已说明） | 同上 |
| 我的足迹 | 运动记录 `pages/sport-records`、答题记录 `pages/quiz-records`、勋章 `pages/medals` | `frontend/app.json` |

**25 个页面清单**（`frontend/app.json:2-28`，顺序即注册顺序，首项为默认入口）：
`launch, home, march, quiz, mine, login, node-detail, quiz-answer, quiz-result, sport-records, quiz-records, medals, org-select, rank, profile, calendar, person, ticket, ceremony, bind, account, onboard, points, activity, ai-chat`

**tabBar 5 个**：`home`(首页) → `march`(长征) → `ai-chat`(AI 问答) → `rank`(排行) → `mine`(我的)。

---

## 10. AI 智能中心（V1.0 Phase A）

**状态：部分实现**（2026-10-17 交付 Phase A，backend `1600074` + frontend `0052108`）

### 10.1 已实现

| 能力 | 接口 / 位置 |
|---|---|
| AI 问答（小程序聊天页） | `POST /api/ai/chat`；`frontend/pages/ai-chat/ai-chat.js`（256 行） |
| 路线讲解 | `GET /api/ai/route-guide/{node_id}`（**后端就绪，前端面板待开发**） |
| 答题讲解 | `GET /api/ai/quiz-explanation/{question_id}`（**后端就绪，前端按钮待开发**） |
| 后台 AI 接口 | `/api/admin/ai/*`（`routes/ai_admin.py:43`，前缀 `/admin/ai`）：知识库、配置、题目工坊、调用记录 |
| AI 出题对话框（管理端） | `admin/src/components/AiGenerateDialog.vue` |
| 数据表 | `ai_knowledge`、`ai_conversations`、`ai_messages`、`ai_generation_jobs`、`ai_generated_questions`、`ai_usage_logs`（`docker/init/021_ai_center.sql`） |
| 菜单码 | 5 个 AI 菜单（`docker/init/022_ai_admin_menus.sql`）；**`admin/src/router/menus.ts` 尚未登记** |

### 10.2 运行时默认值（`.env` 初始默认，管理端「配置中心」可在 `system_settings` 中逐项覆盖；**生效值 = DB 覆盖 > env 默认**，由 `ai_config_service.get_effective(db)` 合并）

依据：`backend/app/core/config.py:80-91` 及其注释。

| 配置项 | 默认值 | 用途 |
|---|---|---|
| `AI_ENABLED` | `true` | **AI 总开关**；关闭后所有 AI 接口返回明确提示，**不影响其它业务** |
| `AI_CHAT_DAILY_LIMIT` | 10 | 普通用户每天最多模型调用次数（**按北京时间当日**） |
| `AI_GLOBAL_DAILY_LIMIT` | 2000 | 全站每天模型调用上限（**防成本失控**） |
| `AI_MAX_INPUT_CHARS` | 500 | 单次用户输入最大字符数 |
| `AI_MAX_OUTPUT_TOKENS` | 800 | 单次回答 Token 上限（约束约 500 汉字） |
| `AI_REQUEST_TIMEOUT` | 60 | 单次对话/讲解调用超时（秒） |
| `AI_MAX_RETRIES` | 1 | 可恢复失败的最大重试次数 |
| `AI_CONTEXT_TURNS` | 4 | 对话默认携带的最近有效历史轮数 |
| `AI_KNOWLEDGE_TOP_K` | 4 | 检索已发布知识资料的最大条数 |

### 10.3 AI 出题策略

依据：`core/config.py:75-78` 及注释「总量拆成多批并发调用，规避单次长回复被截断」。

| 配置项 | 默认值 | 用途 |
|---|---|---|
| `AI_QUESTION_BATCH_SIZE` | 10 | 每批请求 Agent 生成的题数 |
| `AI_QUESTION_MAX_CONCURRENCY` | 3 | 批间并发上限 |
| `AI_QUESTION_MAX_COUNT` | 100 | 单次生成 / 单次保存的题数上限 |
| `CLOUDBASE_TIMEOUT_SECONDS` | 180 | 单批调用超时（秒） |

安全约束：`CLOUDBASE_API_KEY` **仅供后端调用，禁止写入前端代码、接口响应或日志**（`config.py:67` 注释）。

### 10.4 多轮对话实现方式

**无状态**：把历史拼接进单个 prompt（`services/cloudbase_service.py:7-8`），并在 `:206` 加系统提示词前缀。**服务端不维护会话上下文**，`AI_CONTEXT_TURNS` 控制携带的最近有效历史轮数。

### 10.5 前端约束

- AI 问答是**全项目唯一使用 60 秒超时的接口**（`frontend/services/ai.js`），其余均为默认 10 秒（`services/request.js:73`）。
- `pages/ai-chat` **无出站页面跳转**（`nodeId` 参数通道保留但未接入）。
- 账号切换隔离：`ai-chat.js:44-55` 在 `onShow` 比较 `this._uid` 与 `app.globalData.user.id`，不一致就清空 `messages/conversationId/title/banner/sessions` —— **全项目唯一一处显式的跨账号数据清理**。

### 10.6 待开发 / 待验证

| 项 | 状态 |
|---|---|
| 管理后台 5 个 AI 子页面（知识库 / 配置 / 题目工坊 / 运行概览 / 调用记录） | **待开发**（接口已就绪） |
| `node-detail` 讲解面板 | **待开发**（`GET /api/ai/route-guide/{node_id}` 已就绪） |
| 答题页 AI 讲解按钮 | **待开发**（`GET /api/ai/quiz-explanation/{question_id}` 已就绪） |
| usage / cost 统计页 | **待开发**（`ai_usage_logs` 表已建） |
| 小程序真机真实 Agent 全链路 | **待验证**（本机 DNS 劫持限制，需 dns_shim 或真机网络） |
| AI 知识库检索为**关键词匹配**，非向量检索 | 已知限制（Phase A 取舍） |

---

## 11. 管理后台功能

**状态：已实现**（11 个菜单）

### 11.1 菜单与权限

| 规则 | 行为 | 依据 |
|---|---|---|
| 权限粒度 | **菜单码**（`admin_menus.code`），**无按钮级权限** | `api/deps.py:150-160` `require_menu`；已知限制 |
| 权限来源 | 用户 → `admin_user_roles` → `admin_roles` → `admin_role_menus` → `admin_menus` | `models/models.py:456-503` |
| 超管 | `is_super` **拥有全部菜单**，绕过校验 | `api/deps.py:105-106` |
| 权限不落令牌 | `typ=user` 令牌只有身份，**每请求查库重建**，撤销即时生效 | `core/security.py:38-39` |
| 数据库菜单码总数 | **16 个**（9 个基础 `010` + `invites` `015` + `activity` `016` + 5 个 AI `022`） | `docker/init/010`、`015`、`016`、`022` |
| 前端登记菜单数 | **11 个**（5 个 AI 菜单未登记，与 AI 管理子页面「待开发」一致） | `admin/src/router/menus.ts` |
| 登录方式 | ①账号密码（`LoginView.vue:32-48`）；②微信扫码（`:76-130`，链式 setTimeout 轮询 + `pollGen` 代数计数器防止旧轮询污染） | — |
| 账号登录开关 | `ADMIN_PASSWORD` **未配置时账号登录禁用，仅允许微信扫码登录** | `core/config.py:59-61` |
| 路由守卫 | 4 步：白名单 `/login` → 未登录跳 `/login` → 已登录访问 `/login` 跳首页 → `hasMenu` 校验，无权跳 `firstAllowedPath()`（防死循环） | `admin/src/router/index.ts:9-12`、`:102-118` |
| 独立布局路由 | `/login` 与 `/screen` 是**独立顶层布局**，不套后台框架 | `admin/src/router/index.ts` |

### 11.2 人员管理

| 功能 | 状态 | 依据 |
|---|---|---|
| 用户列表（服务端分页） | 已实现 | `routes/admin.py` |
| 停用 / 启用账号 | 已实现，**停用即时断权**（403 + `X-Account-Status`） | `api/deps.py:46-53` |
| 调整用户所属组织（**唯一可改锁定组织的途径**） | 已实现，**留审计** | `services/org_service.py:4-5` |
| Excel 批量导入人员 | 已实现，两阶段（预览 → 确认） | `services/import_service.py` |
| 邀请码生成与维护 | 已实现，菜单码 `invites` | `services/invite_service.py:1` |
| RBAC 双 tab（角色 / 用户授权） | 已实现 | `admin/src/views/AccessView.vue` |
| 审计日志查看 | 已实现，`ACTION_TEXT` 20 项中文映射 | `admin/src/views/AuditView.vue` |

### 11.3 题库管理

| 功能 | 状态 | 依据 |
|---|---|---|
| 题目 CRUD | 已实现 | `admin/src/views/QuestionsView.vue` |
| 删除题目 | **改为停用**，以保留已生成会话 | `docs/迭代记录.md` |
| Excel 导入题目 | 已实现（复用 `ExcelImportDialog.vue`） | `admin/src/components/ExcelImportDialog.vue` |
| AI 出题 | 已实现（`AiGenerateDialog.vue`） | 见 §10 |
| AI 生成题校验 | 前端 `validateItem`（`AiGenerateDialog.vue:86-104`）**与后端 `_validate_question` 对齐** | — |
| 批量保存 | `batchSaveAiQuestions`（`:276-305`），`failures.index` 为 **1 基** | — |
| 中断生成 | `AbortController`（`:128-164`、`:170-173`） | — |
| 行内编辑防递归 | 深监听 + 签名比较（`:106-118`）避免递归 update | — |

### 11.4 活动配置

| 功能 | 状态 | 依据 |
|---|---|---|
| 活动名称 / 起止时间 / 发布开关 / 限制开关 / 结束后可查看 / 结束文案 | 已实现 | `models/models.py:108-123`；`admin/src/views/ActivityView.vue` |
| 服务器时间校准 | 已实现（`clockOffset`），避免管理员本机时钟偏差 | 同上 |
| 单行配置 | `id = 1` | `activity_service.py:20` |
| 变更留审计 | 已实现（`activity_service.py:18` import `audit_service`） | — |

### 11.5 其它管理页

| 页面 | 功能 | 备注 |
|---|---|---|
| `DashboardView` | 驾驶舱：7 张指标卡 + ECharts 双轴图（`trendSeq`） | 使用 `useLiveUpdates` |
| `ScreenView` | 数据大屏：**纯 CSS 柱状图**（不用 ECharts）+ 单个 `fetchScreen` 聚合接口 | 使用 `useLiveUpdates` |
| `RankingsView` | 排行：服务端分页 + 领奖台 + 详情抽屉 + `verifyPoints(fix)` | 位于 `pages/` 而非 `views/`，来源 `81b86e5`，**原因未说明** |
| `OrgsView` | 组织树：`collectSubtreeIds` 带环检测 + `EXPAND_ALL_LIMIT` 限制全展开规模 | — |
| `QuotesView` | 金句管理（增删改查 + 周期） | — |
| `InvitesView` | 邀请码管理 | — |
| `RouteNodesView` | 路线节点管理：**前端做筛选，未做服务端分页**（数据量小） | — |
| `AuditView` | 审计日志 | — |
| `AccessView` | RBAC 双 tab | — |
| `ExcelImportDialog.vue` | 通用导入对话框：通过 `api: ExcelImportApi` prop（`:10-14`）注入四个接口函数，**同一组件复用于所有导入场景**；`defineExpose({downloadTemplate})`（`:101`） | — |

### 11.6 Excel 导入导出规则（管理端通用）

| 规则 | 值 | 依据 |
|---|---|---|
| 允许扩展名 | **仅 `.xlsx`** | `routes/admin.py:419-426`（`_read_import_file`，校验在 `:421-422`）；`services/import_service.py:4` 文档串 |
| 大小上限 | **≤ 2 MB** | 同上 |
| 解析库 | `openpyxl`（**未引入 pandas**） | `import_service.py:17` |
| 预览 token | **一次性 uuid，TTL 30 分钟** | `import_service.py:25-27`、`:124-137` |
| 确认消费 | **条件 UPDATE（`pending → confirmed`）原子消费**，防重复提交 | `import_service.py:140-175` |
| 事务 | 确认阶段**同一事务内批量写入，任何失败全量回滚** | 同上 |
| 错误策略 | **任一行出错则整批阻断**，不允许部分成功；错误逐行携带行号与原因 | `import_service.py:280-286`；`schemas.py:1115-1131` |
| 导出 | 流式 CSV：`StreamingResponse` + 独立 Session + `yield_per(1000)` + **UTF-8 BOM** | `routes/admin.py:347-362`；`admin_service.py:433-438`、`:485` |
| 公式注入防护 | 导入侧防 `= + - @` 开头；导出侧 `_csv_text` | 导入侧 `import_service.py:52-54`；导出侧 `admin_service.py:423` `_csv_text` |

---

## 12. 已废弃规则（**不再是现行规则，勿按此实现**）

| 废弃项 | 原规则 | 废弃时间与依据 |
|---|---|---|
| **登录积分** | 每日登录得分 | `2f3f333`（2026-10-13）「移除登录/达标/点亮/里程碑积分」 |
| **达标积分** | 当日步数达标得分 | 同上 |
| **点亮积分** | 点亮路线节点得分 | 同上 |
| **里程碑积分** | 连续行军/累计步数跨越里程碑得分 | 同上；`streak_service.py:5-6` 明确「V2.0 起里程碑不再发放积分」 |
| **步行积分单日 20000 步封顶** | 每日按 `min(步数, 20000)` 计分后累计 ÷1000 | 引入于 V2.0（`docker/init/017_points_ledger.sql` 回填即用此口径）→ `9cb65b8`（2026-10-15）「步行积分取消单日 20000 封顶，改为累计步数÷1000 计分」，配置项 `POINTS_WALK_STEP_CAP` 与函数 `capped_steps` / `scored_total_steps` 一并删除 |
| **`scoredTotalSteps` 字段** | `profile/summary` 下发「计分口径步数」，「我的」页累计运动(步) 用它展示 | `85c5a55`（2026-10-15）引入 → `9cb65b8`（同日）移除，`profile/summary` 仅保留原始 `totalSteps` |
| **`rules.walkStepCap` / `rules.walkDailyCap`** | 后端向前端下发封顶参数 | `9cb65b8` 起不再下发 |
| **旧版积分流水计入总积分** | V2.0 之前的 `points_log` 行 | `2f3f333` 起标记 `source_type = 'legacy'`，**保留追溯但不计入总积分**（`points_service.py:13`） |
| **组织排名 / 分组织积分对比** | 曾计划实现 | **已取消**（项目记忆 `org-ranking-cancelled`） |
| **底部「情报」tab** | tabBar 第 3 项为 quiz 情报页 | `0052108` 起换防为「AI 问答」，quiz 降级为子页由首页情报卡进入；`frontend/images/tabbar/quiz.png` 与 `quiz-active.png` 成为未引用遗留资源（**用途待确认**） |
| **步行积分「每日各自取整」旧口径** | 每日 `floor(步数/1000)` 独立计算 | `4afccdd`（2026-10-15）改为累计结余口径，修正跨日零碎步数少计分；`83d3552` 增加「步数同步后全量重算」 |
| **今日目标 10000 步** | `GET /sport/today` 曾返回 `target = 10000` | 改为 **20000**；前端另加服务边界强制覆盖以防旧后端回退（`docs/迭代记录.md`） |

---

## 13. 待开发清单（需求已确认，功能未落地）

| # | 项 | 前置条件 |
|---|---|---|
| 1 | 管理后台 5 个 AI 子页面（知识库 / 配置 / 题目工坊 / 运行概览 / 调用记录） | 后端 `/api/admin/ai/*` 已就绪；需在 `admin/src/router/menus.ts` 登记菜单码 |
| 2 | 小程序 `node-detail` AI 讲解面板 | `GET /api/ai/route-guide/{node_id}` 已就绪 |
| 3 | 小程序答题页「AI 讲解」按钮 | `GET /api/ai/quiz-explanation/{question_id}` 已就绪 |
| 4 | AI usage / cost 统计页 | `ai_usage_logs` 表已建 |
| 5 | 章节（`CHAPTERS`）管理端可视化编辑 | 当前硬编码于 `march_service.py:23-44` |
| 6 | 全员共同目标（`GLOBAL_GOAL_STEPS` / `GLOBAL_MILESTONES`）管理端可视化编辑 | 当前硬编码于 `march_service.py:48-54` |
| 7 | 里程碑仪式相关钩子 | `march_service.py:242` 标记延后 |
| 8 | `wx_web` 网页授权绑定渠道（阶段 2） | `WX_WEB_APPID` / `WX_WEB_SECRET` 配置项已留，小程序端无入口 |
| 9 | `pages/account/account` 入口 | 页面与后端 API 已保留，入口按 `frontend/design.md:48` 主动隐藏 |
| 10 | nginx wss 转发修复 + 微信 socket 合法域名配置 | 见 ARCHITECTURE §12.3 |
| 11 | 生产库补跑 `021_ai_center.sql` / `022_ai_admin_menus.sql` | 两个文件本地已应用但**按仓库规则未提交** |
| 12 | 用户头像上传服务端 | 当前仅本地持久化 |
| 13 | 调试端点 `/api/quiz/reset`、`/api/sport/add` 的生产环境开关 | 当前生产暴露 |
| 14 | 管理后台 403 处理与 `X-Account-Status` / `X-Activity-Status` 消费 | 当前无专门分支 |
| 15 | `ElResult` 组件注册 | 当前被引用但未注册 |

---

## 14. 待确认清单（业务规则相关）

**仍需确认**

1. **`master` 勋章口径**：实现按总积分 ≥ 500 判定，展示文案写「累计答题积分达到 500」，**修正方向待定**（见 §8.3）。
2. **生产活动配置的起止时间与发布状态**（运行时数据，不在仓库）。开发库实测：1 行、`start=2026-08-31 16:00`、`end=2026-12-31 15:59`、`published=true`，**不代表生产**。
3. **`WXACODE_ENV_VERSION` 生产是否已改为 `release`**（代码默认 `trial`）。
4. **`ACTIVITY_MASK_NICKNAME`**（实时行动态昵称脱敏，需求 §8.5，开启后展示如「王*明」）代码默认 `false`（`core/config.py:99`），**生产是否开启待确认**。
5. **`ORG_SYNC_API_URL` 外部组织同步接口**是否在生产实际对接（代码默认空 → 用内置种子）。
6. **`lm_data_{userId}` 遗留 Storage 键**是否有清理计划（`frontend/design.md:104` 只说「迁移保留旧 key」）。
7. **`frontend/AGENTS.md` §5 的 `NODE_COORDS` 前端硬编码坐标表在代码中不存在**（坐标全部来自 `GET /api/march/route`）—— 该文档条目应视为失效，是否修订待确认。
8. **`images/tabbar/quiz.png` / `quiz-active.png`** 未被 `app.json` 引用，推测为「情报」曾作为 tab 的遗留，用途待确认。
9. **补签的产品规则**：字段已建但业务未实现（见 §3.3），可补几天 / 是否消耗积分 / 是否影响连续行军判定，**无需求依据**。

**待开发（无明确排期，2026-10-17 经用户确认按此标注）**

| 项 | 当前状态 | 依据 |
|---|---|---|
| `ai-chat` 的 `nodeId` 参数通道 | **待开发（Phase B）**。代码注释写「Phase A 先不接入」，仓库中无 Phase B 计划文档 | `frontend/pages/ai-chat/`；`.qoder/PROJECT.md` §7 |
| `pages/account` 入口恢复 | **已隐藏，恢复条件待产品确认**。页面已注册但无任何跳转入口，其 `handleUnbind` 对应按钮在 WXML 中未渲染（死代码路径） | `frontend/app.json:23`、`frontend/pages/account/account.js:52-78`、`frontend/design.md:48` |
| 管理后台 5 个 `ai_*` 菜单对应页面 | **待开发**。`022_ai_admin_menus.sql` 已把 `ai_overview`/`ai_knowledge`/`ai_workshop`/`ai_logs`/`ai_config` 写入 `admin_menus`，但 `admin/src/router/menus.ts` 只有 11 项、**不含任何一个 `ai_*`**，即 DB 有菜单码而前端无入口 | `docker/init/022_ai_admin_menus.sql:15-27` vs `admin/src/router/menus.ts:3-15` |

**已查证解决（原第 1、2 项，2026-10-17）**

- **补签字段是否存在** → 存在但为死字段，详见 §3.3。
- **默认昵称「长征小战士」的赋值位置** → `backend/app/models/models.py:192` 的 ORM 列默认值，详见 §2 登录表。

---

## 15. 文档滞后项（已知与代码不一致的既有文档）

以下既有文档存在与代码不符之处，**以代码为准**：

| 文档 | 滞后内容 |
|---|---|
| `frontend/design.md` | §3 等多处未反映 AI 问答 tab 换防；`:48` 关于 account 入口隐藏的描述仍有效 |
| `frontend/AGENTS.md` | §5 提到的 `NODE_COORDS` 前端硬编码坐标表**代码中不存在** |
| `admin/design.md` | §3 内容滞后于当前页面结构 |
| `backend/design.md` | 部分内容未反映 AI 智能中心 Phase A |
| `docs/长征步迹V2.0_交付说明.md` | **未记录生产 openGauss 版本与端口**（曾被误引，实际无此陈述） |
| `docker/init/005`、`013`、`015`、`017`、`019`、`020` | 使用了 `SQL_CONSTRAINTS.md` 如今禁止的语法（早于约束文档）；`017`、`019` 含重算类 UPDATE，**不可重复执行** |
| `backend/test/e2e_full_flow`、`e2e_datasync`、`s3_aggregates` | 仍按 V1 语义编写，登录会 502 |
| `frontend/test/automator/ui-test.cjs` | phase1 的 T02 断言已过时；T16a 为环境性失败 |

---

## 16. 相关文档

- 架构与调用约定 → `.qoder/ARCHITECTURE.md`
- 项目概况、技术栈、已知问题 → `.qoder/PROJECT.md`
- 版本级变更影响分析 → `.qoder/CHANGELOG.md`
- **提交级历史唯一权威** → `docs/迭代记录.md`（138 条，倒序）
- SQL 迁移编写约束（权威） → `docker/init/SQL_CONSTRAINTS.md`
- 文档体系与维护规则 → `.qoder/README.md`
