# .qoder/decisions · 架构决策索引

> 本目录**当前不存放新建的 ADR 文件**。原因：本项目的架构决策**已经以代码注释、模块文档串和专项文档的形式记录在源码里**，且这些记录比事后补写的 ADR 更贴近实现。本文件作为**索引**，把散落的决策依据汇总到一处，避免重复维护两份真相。
>
> 若今后出现「代码注释不足以承载」的重大取舍（例如引入 Redis、更换数据库、拆分服务），再在本目录新建 `YYYY-MM-DD-<主题>.md`。

---

## 1. 已记录的决策及其权威出处

### 1.1 数据库与兼容性

| 决策 | 取舍理由 | 权威出处 |
|---|---|---|
| 使用 openGauss 而非 PostgreSQL | 生产环境指定 | `.qoder/CHANGELOG.md` §2.2（2026-10-01 架构变更） |
| **对 `PGDialect._get_server_version_info` 打 monkey-patch** | openGauss 的 `version()` 返回串 SQLAlchemy 无法解析，会抛 `Could not determine version from string`；伪造为 `(9, 2, 4)` 后可启动 | `backend/app/core/database.py:11-43`，**注释里完整写了背景、处理、风险与边界、退出条件**（`:20-28`） |
| 补丁只在 `DATABASE_URL.startswith("postgresql")` 时生效 | 避免影响 SQLite（测试/本地）方言 | `backend/app/core/database.py:41-43` |
| 显式使用 `.over()` 写窗口函数，不依赖方言自动适配 | 补丁把版本伪造成 9.2 会关闭窗口函数等新特性的方言适配 | `backend/app/services/rank_service.py:40`；`docker/init/013`、`019` |
| **不使用 `ON CONFLICT`** | openGauss 不支持 | `docker/init/SQL_CONSTRAINTS.md` §1 |
| **不使用 `ADD/DROP COLUMN IF NOT EXISTS`** | openGauss 禁止；改用 `DO $$ … EXCEPTION WHEN undefined_column/duplicate_column … $$` 块 | `docker/init/SQL_CONSTRAINTS.md` §1 |
| **派生表必须显式加别名** | 历史事故：缺别名导致生产启动失败 | `docker/init/SQL_CONSTRAINTS.md` §1.4；事故记录 `f413ac6` → 更正 `51239b5` |
| **迁移不用 Alembic，改用编号 SQL + `schema_migrations`** | 需在容器初始化阶段以纯 SQL 执行，且 openGauss 方言支持有限 | `docker/compose.yml`；`docker/init/init-db.sh` |
| **已发布迁移脚本不得修改，只能新增编号** | 生产库已执行的脚本无法追溯重写 | `docker/init/SQL_CONSTRAINTS.md` §3 |
| 迁移必须幂等、必须在事务中、**不得删除数据** | 补跑安全性 | `docker/init/SQL_CONSTRAINTS.md` §2 |
| **全库无 CHECK 约束，所有「枚举」用 VARCHAR + 应用层常量** | openGauss 兼容性与迁移灵活性 | `.qoder/ARCHITECTURE.md` §13.2 |
| **13 处逻辑外键不建数据库级 FK**（原记「11 处」，2026-10-17 核实为 13，差额来自迁移 015 新增的 2 列） | 便于迁移与数据修复 | 同上；逐列清单见 `.qoder/backend/app/models/models.py.md` §4.7 |
| JSON 列用 `JSON` 而非 `JSONB` | 补丁伪造的 9.2 版本关闭了 JSONB 方言适配 | `backend/app/core/database.py:24-26` |
| `''` 在 openGauss（Oracle 兼容模式 A）落库为 **NULL** | 数据库行为，非本项目选择，但**所有代码必须按此假设编写** | `docker/init/SQL_CONSTRAINTS.md` §1 |

### 1.2 API 与契约

| 决策 | 取舍理由 | 权威出处 |
|---|---|---|
| **不使用 `{code, data, msg}` 响应信封** | FastAPI 直接返回业务 payload，减少一层拆包 | `frontend/services/request.js:77`（2xx 直接 `resolve(res.data)`）；`admin/src/api/request.ts:27-51` |
| **双命名契约**：小程序 camelCase（`CamelModel`）、管理端 snake_case（`Admin*`） | 两端各自的既有约定，不做全局切换 | `backend/app/schemas/schemas.py`；`.qoder/ARCHITECTURE.md` §4.2 |
| **准入控制走 HTTP 响应头**（`X-Account-Status` / `X-Activity-Status`）而非响应体字段 | 403 时前端无需解析 body 即可决定跳转，且直接调接口同样被拦截 | `backend/app/api/deps.py:46-81`（含注释）；`frontend/services/request.js:81-91` |
| **409 不使用**，冲突语义统一由 400 承载 | 简化前端错误分支 | `.qoder/ARCHITECTURE.md` §4.3 |
| 时间**存 UTC naive、业务日切按北京时间 UTC+8** | 跨时区一致性 + 活动按中国自然日结算 | `backend/app/services/helpers.py:9`、`:12-14`、`:22-24` |
| `quiz_records.answer_at` 用**毫秒 BigInteger** 而非 datetime | 答题计时需要毫秒精度 | `backend/app/models/models.py:287`；`quiz_service.py:55-57` |

### 1.3 鉴权与权限

| 决策 | 取舍理由 | 权威出处 |
|---|---|---|
| **权限不写入 JWT，`typ=user` 管理员每请求查库重建** | 撤销授权需即时生效，12 小时有效期仅作兜底 | `backend/app/core/security.py:36-40`（注释明说）；`api/deps.py:142-147` |
| **无 `typ` 的历史管理员令牌兼容为超管** | 避免 RBAC 改造导致存量会话集体失效 | `backend/app/api/deps.py:127-129`（含注释） |
| **无服务端会话存储、无 refresh token、无令牌黑名单** | 未引入 Redis；靠短有效期 + 每请求查库达到等效的即时断权 | `.qoder/ARCHITECTURE.md` §5.1 |
| **401 → 单飞静默重登 → 精确重试一次** | 用户无感知续期，且避免并发 401 触发多次 `wx.login` | `frontend/services/request.js:129-160`；`frontend/services/auth.js:14-15` |
| **用 `setReauthHandler` 注入而非直接 import** | 打破 `request.js` ↔ `auth.js` 的循环依赖 | `frontend/services/request.js:23-25`；`frontend/services/auth.js:164` |
| 重登失败时**若为网络错误则保留会话** | 网络抖动不应把用户踢下线 | `frontend/services/request.js`（`:129-160` 第 6 步） |
| **`loggedIn` 只在后端校验通过后才为 true，本地缓存不算已登录** | 防止缓存伪造登录态 | `frontend/app.js:6`（注释明说）；`frontend/design.md:103` |
| 管理员菜单权限粒度**只到菜单码，无按钮级** | 复杂度取舍，当前需求够用 | `.qoder/ARCHITECTURE.md` §5.3（列为已知限制） |

### 1.4 一致性与状态

| 决策 | 取舍理由 | 权威出处 |
|---|---|---|
| **小程序跨 tab 一致性 = 后端落库 + 各页 `onShow` 刷新**，不建跨页内存缓存层 | 微信 tab 页是常驻实例，`onLoad` 只跑一次；引入 store 会增加复杂度且不解决权威性问题 | `frontend/design.md:261-262`；`frontend/AGENTS.md` §4 |
| **每页自带单调递增 `_requestId` 做竞态守卫** | 快速切 tab / 切月时晚到的响应必须被丢弃 | `frontend/pages/` 下：`home.js:153-286`、`march.js:150-165`（`onHide:128-135`、`onUnload:137-138` 主动 bump）、`rank.js:53-94`、`calendar.js:48-69`、`points.js:43-89`、`org-select.js:69-82`。**注意与同名的 `frontend/services/*.js` 无关** |
| **小程序不消费 WS 的 `data_changed`**，只处理 `activity` | 数据同步已由 `onShow + refresh()` 覆盖，WS 只用于实时动态流 | `frontend/pages/home/home.js:142-146` |
| **WS `data_changed` 只发元信息、不带业务数据** | 避免「推送数据与随后拉取的数据不一致」，并避免在广播路径上做权限过滤 | `backend/app/core/ws.py:23-25`（注释明说「仅事件类型与元信息，不含业务数据」） |
| **WS 广播用 `run_coroutine_threadsafe` 投递到事件循环** | 同步业务路由运行在请求线程中，直接 await 会阻塞业务请求 | `backend/app/core/ws.py:1-6`（模块文档串）、`:62-71` |
| 无连接或事件循环不可用时**广播静默跳过** | 推送失败不能影响业务写入 | `backend/app/core/ws.py:64-65`、`:70-71` |
| **积分台账每人每来源每日一行 + `biz_key` 唯一 + 同事务重算覆盖** | 重复同步 / 重放 / 并发只会得到同一结果，天然幂等 | `backend/app/services/points_service.py:8-10`（文档串）；`docker/init/017_points_ledger.sql` |
| **步行积分用「累计结余口径」而非「每日各自取整」** | 修正跨日零碎步数少计分 | `points_service.py:5-6`；`4afccdd`（2026-10-15） |
| **启动时以源数据重算派生统计**（连续天数、步行积分） | 崩溃/中断后自愈，无需额外对账任务 | `backend/app/main.py:41-51` |
| 并发控制用**条件 UPDATE + `with_for_update()` 行锁**，不用乐观锁版本号 | 写冲突场景明确（同一用户同一天），行锁足够 | `backend/app/services/sport_service.py:105-111`；`points_service.py:71-77`；`invite_service.py:5` |
| **事务边界两种约定并存**（服务层自提交 vs 路由层提交） | 历史演进结果；审计写入刻意采用「service `db.add`、路由 commit」以便与业务写入同事务 | `backend/app/services/audit_service.py:2-5`（文档串明确此约定） |
| **流式导出使用独立 Session**（全项目唯一例外） | `StreamingResponse` 的生成器在路由返回后才执行，此时 `Depends(get_db)` 的 Session 已关闭 | `backend/app/services/admin_service.py:433-438`、`:485` |
| **管理端不用 Pinia/Vuex**，用 localStorage 轻量 store | 状态极少（token + 菜单 + 是否超管），引入状态库收益不足 | `admin/src/store/auth.ts` |
| 管理端 WS 刷新用 **800ms 防抖合并** | 广播风暴时避免重复拉取 | `admin/src/utils/liveUpdates.ts:22`、`:34-39` |

### 1.5 Excel 导入导出

| 决策 | 取舍理由 | 权威出处 |
|---|---|---|
| **两阶段导入（预览 → 确认），预览 payload 落库 + 一次性 uuid token（TTL 30 分钟）** | 让用户在写库前看到全部错误；避免大文件长时间占用内存 | `backend/app/services/import_service.py:25-27`、`:124-137` |
| 确认阶段用**条件 UPDATE（`pending → confirmed`）原子消费 token** | 防止同一 token 被重复提交 | `import_service.py:140-175` |
| **任一行出错则整批阻断**，不允许部分成功 | 导入是批量业务操作，半成功状态难以解释和回滚 | `import_service.py:280-286`；`schemas.py:1115-1131` |
| **不引入 pandas**，直接用 openpyxl | 依赖体积与部署包大小 | `import_service.py:17`；`.qoder/PROJECT.md` §3 |
| CSV 导出加 **UTF-8 BOM** + `yield_per(1000)` | Excel 打开中文不乱码；大表不撑爆内存 | `backend/app/api/routes/admin.py:347-362` |
| 导入导出双向做**公式注入防护**（`= + - @` 开头） | 防 CSV/Excel 公式注入 | `routes/admin.py:423-426` `_csv_text`；`import_service.py` |
| `ExcelImportDialog.vue` 通过 `api` prop 注入接口函数 | 一个组件复用于所有导入场景，避免每个页面各写一套 | `admin/src/components/ExcelImportDialog.vue:10-14`、`:101` |

### 1.6 小程序端渲染与性能

| 决策 | 取舍理由 | 权威出处 |
|---|---|---|
| **所有 Canvas 用 `type="2d"` 同层渲染，全项目零 `cover-view`** | 同层渲染后 DOM 可直接与 canvas 混排，无需 `cover-view` 的诸多限制 | 各页 WXML；`.qoder/ARCHITECTURE.md` §14 不变量 9 |
| **canvas 上要盖 DOM 时：快照成 `<image>` 再 `wx:if` 移除画布** | canvas 原生层会盖住 DOM 浮层，且 `visibility` 无效 | `frontend/pages/ceremony/ceremony.js:228-240` `finalizeScene`；项目记忆 `native-canvas-overlay` |
| **离屏 canvas 一律 try/catch → null 降级** | 低版本基础库或内存不足时不应导致整页崩溃 | `frontend/utils/routeCanvas.js` 等 |
| **Storage 访问只放在 `services/` 层，页面 JS 零 Storage 读写** | 收敛存储键管理，避免键名散落与账号串数据 | 24 处 Storage 调用全在 `services/`；`.qoder/ARCHITECTURE.md` §14 不变量 11 |
| **启动状态机放在 `pages/launch/launch.js`，`app.js` 只做极薄状态容器** | 入口页承担 phase 状态机（loading/blocked/disabled）便于渲染对应 UI；`app.js` 无 `onLaunch` | `frontend/app.js`（26 行）；`frontend/app.json:2-3` 把 `launch` 放首位 |
| **网络错误把微信原始 `errMsg` 追加进用户可见提示** | 真机看不到 console，必须把错误带到界面上 | `frontend/services/request.js:94-101`（注释明说） |
| **活动页跳转加 3 秒去抖** | 并发请求同时 403 时会重复 `reLaunch` | `frontend/services/request.js:7`、`:110-119` |
| **AI 问答是唯一 60 秒超时的接口**，其余默认 10 秒 | 模型调用耗时长 | `frontend/services/ai.js`；`services/request.js:73` |
| **AI 聊天页在 `onShow` 比较 `_uid` 并清空会话态** | tab 页常驻，避免跨账号数据泄漏 | `frontend/pages/ai-chat/ai-chat.js:44-55`（注释明说） |
| **不启用 npm 构建、不用 ESM、无 lint** | 原生小程序 CommonJS 足够；避免构建链复杂度 | `project.config.json` `nodeModules: false`；全项目 0 处 `import`/`export` |
| 首页 11 路并发 `Promise.all` 后**单次 `setData`** | 减少渲染层通信次数 | `frontend/pages/home/home.js:189-190`（注释） |
| tabBar 图标用**零依赖脚本生成 PNG** | 不引入 canvas/sharp 等 npm 包 | `frontend/test/gen-tabbar-icons.cjs` |
| `zip-dist.mjs` **零依赖手写 Zip**（`zlib.deflateRawSync` + 自实现 CRC-32 + MS-DOS 时间戳） | 避免为打包一个 zip 引入额外依赖 | `admin/scripts/zip-dist.mjs:17-19`、`:65`、`:127-139` |

### 1.7 AI 智能中心

| 决策 | 取舍理由 | 权威出处 |
|---|---|---|
| **多轮对话无状态**：把历史拼接进单个 prompt，服务端不维护上下文 | CloudBase Agent 的 ACP `session/prompt` 调用模式下，自维护会话需额外存储与过期策略 | `backend/app/services/cloudbase_service.py:7-8`、`:206`；`AI_CONTEXT_TURNS = 4`（`core/config.py:90`） |
| **AI 出题总量拆成多批并发调用** | 规避单次长回复被截断 | `core/config.py:75-78`（注释明说）；`AI_QUESTION_BATCH_SIZE=10`、`MAX_CONCURRENCY=3`、`MAX_COUNT=100` |
| **AI 运行时参数支持 DB 覆盖 env 默认** | 管理端「配置中心」可不重启调整；生效值 = DB 覆盖 > env 默认 | `core/config.py:80-82`（注释明说）；`ai_config_service.get_effective(db)` |
| **`AI_GLOBAL_DAILY_LIMIT = 2000` 全站日限额** | 防成本失控 | `core/config.py:85`（注释明说） |
| **`AI_ENABLED = false` 时所有 AI 接口返回明确提示，不影响其它业务** | 可安全降级 | `core/config.py:83`（注释明说） |
| **知识库检索用关键词匹配，不用向量检索** | Phase A 取舍，避免引入向量库 | `.qoder/PROJECT.md` §8（列为架构级限制） |
| `CLOUDBASE_API_KEY` **仅供后端调用，禁止写入前端代码、接口响应或日志** | 密钥保护 | `core/config.py:67`（注释明说）；`s26` G 组用例专门验证「任何响应不泄露 CLOUDBASE_API_KEY」 |
| 路线讲解**优先已发布知识、无知识时回退节点字段、且不调模型** | 省成本 + 保证草稿不泄露 | `s26_ai_center.py` R 组用例说明（`:12-13`） |
| 答题解析**题库已有解析时直接返回、不调模型**；**以库内答案为准** | 省成本 + 防模型给出与题库矛盾的答案 | `s26_ai_center.py` Q 组用例说明（`:14`） |

### 1.8 微信集成

| 决策 | 取舍理由 | 权威出处 |
|---|---|---|
| **`session_key` 从不落库、从不打日志** | 微信安全要求 | `backend/app/core/wx.py:3-4`（注释明说） |
| code2session 失败**抛 502，绝不回落到 mock** | 生产环境回落 mock 会造成账号串号 | `backend/app/services/auth_service.py:41-48` |
| mock openid 只在**未配凭证**或显式 `WX_LOGIN_ALLOW_MOCK=true` 时生效 | 「仅限本地自动化测试，生产必须为 false」 | `core/config.py:45-46`（注释明说） |
| 微信运动**近 7 日逐日覆盖而非累加**；缺失日期不写 0、不覆盖已有记录 | 微信返回的是每日快照，累加会重复计数 | `backend/app/services/sport_service.py:3`（文档串） |
| **真实用户绝不编造步数**，只有 mock 用户回退 `seeded_steps` | 数据可信度 | `sport_service.py:7`（文档串明说） |
| access_token **内存缓存 TTL 7000 秒**（官方 7200） | 留 200 秒余量避免边界失效 | `backend/app/services/wechat_service.py:21-50` |
| 邀请码**不写入日志与审计明细**（审计只记 id 与名称） | 邀请码是入驻凭证 | `backend/app/services/invite_service.py:6`（文档串明说） |
| 邀请码**只决定首次入驻资格**，已入驻用户登录不再校验 | 过期/停用/用满不应影响存量用户 | `invite_service.py:4`（文档串明说） |
| 登录按钮本身即 `<button open-type="chooseAvatar">`，**页面不设昵称输入框** | 微信头像昵称填写能力推荐用法；昵称改由后端赋默认值 + 一次性改名 | `frontend/pages/login/login.js:1-6`（注释） |

### 1.9 工程与协作

| 决策 | 取舍理由 | 权威出处 |
|---|---|---|
| **`APP_ENV` 只从系统环境变量读取**，写进 `.env` 不生效 | env 文件选择发生在解析 `.env` 之前 | `backend/app/core/config.py:12-15`（注释明说） |
| `DATABASE_URL` **必填、不提供默认连接串** | 缺失时启动即报错，避免回退到错误/过期的库或泄露内置凭证 | `core/config.py:31-34`（注释明说） |
| `.env` 文件锚定到 backend 根目录，**不依赖启动时的 cwd** | 本地 `run.py` 与服务器 uvicorn/systemd 从不同 cwd 启动都能读到同一份配置 | `core/config.py:9-11`（注释明说） |
| **`backend/.env` 与 `.env.prod` 经用户决定入库** | 用户明确要求；代价是密钥进入 git 历史 | `.gitignore` 的 `!backend/.env` 显式放行；仓库根 `agents.md` §1.3 |
| **`docker/` 改动默认不提交** | 用户明确要求；代价是 `021`/`022` 处于「本地已应用、生产缺失」状态 | 仓库根 `agents.md` §1.3；`.qoder/CHANGELOG.md` §2.13 |
| **一个任务一个提交，完成即推送，并在 `docs/迭代记录.md` 追加记录** | 避免积压与历史丢失 | 仓库根 `agents.md` §1 |
| 发布产物（`backend-update.tar.gz` / `sql.tar.gz` / `admin/dist.zip`）全部 gitignore | 构建产物不入库 | `.gitignore` |
| `build-backend.bat` **打包排除 `backend/test`** | 发布包不应包含测试脚本 | `6cdd80a`（2026-10-16） |
| **测试运行临时产物（含令牌）禁止入库** | 安全 | `.gitignore:44-50`（注释明说） |

---

## 2. 尚未形成决策记录的开放问题

以下问题在代码中**没有明确的取舍说明**，属真实开放项（详见 `.qoder/PROJECT.md` §10 与各文档的「待确认」章节）：

1. 是否引入 Redis 以支持多进程部署（当前 WS 连接表、限流计数、access_token 缓存均为进程内内存态）。
2. 是否引入 Alembic 替代编号 SQL。
3. 调试端点 `/api/quiz/reset`、`/api/sport/add` 是否加生产环境开关。
4. 是否统一 `admin/src/pages/` 与 `admin/src/views/`。
5. 是否为小程序补 `onError` / `onUnhandledRejection` 全局钩子与错误上报。
6. `master` 勋章的实现口径（总积分）与展示文案（答题积分）哪个为准。
7. 用户头像是否上传服务端。
8. 是否为 admin 引入可重复执行的自动化验收（当前 Playwright 从未入库为依赖）。
