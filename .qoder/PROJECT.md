# PROJECT.md · 长征步迹项目总览

> 本文档是项目导航层。细节以源代码为准，提交级历史以 `docs/迭代记录.md` 为准。
> 最后核对时间：2026-10-17（对应 HEAD `031c323`）。

---

## 1. 项目基本信息

| 项 | 内容 |
| --- | --- |
| 项目名称 | 长征步迹（仓库名 `longmarch-run`） |
| 活动正式名 | 「长征步迹·荣耀征程」——来源：`docker/init/016_activity_settings.sql` 默认活动名种子 |
| 项目定位 | 以长征历史为主题的**企业微信小程序运动挑战 + 知识答题**活动：员工同步微信运动步数，累计步数沿长征路线节点推进，配合每日限时答题获取积分，形成个人/组织排行与荣誉体系 |
| 目标用户 | 企业内部员工（须持管理后台签发的邀请码扫码入驻，未入驻者不建号、不发 Token） |
| 活动周期 | 由管理后台「活动设置」页配置，存于 `activity_settings` 单行表。默认种子窗口为北京时间 2026-09-01 00:00 ~ 2026-12-31 23:59（`016_activity_settings.sql`）。**实际生效值以生产库为准，待确认** |
| 仓库远程 | `https://github.com/DDYMZL/longmarch-run.git`（URL 不含凭据） |
| 当前分支 | `master`（主分支） |
| 提交数 | 207（截至 HEAD `031c323`） |

### 核心玩法（一句话版）

微信授权登录 → 同步微信运动步数（服务端解密，无模拟数据）→ 累计步数解锁 10 个长征节点（瑞金 0 步 → 延安 65000 步）→ 每日 5 题限时答题（每题 90 秒）→ 总积分 = 步行积分 + 答题积分 → 排行榜 / 荣誉榜 / 勋章 / 纪念票 / 完成仪式 / AI 历史助手。

---

## 2. 项目组成与真实目录位置

| 模块 | 目录 | 技术形态 | 说明 |
| --- | --- | --- | --- |
| 微信小程序 | `frontend/` | 原生小程序（WXML/WXSS/JS，CommonJS，**无任何构建工具**） | 25 个页面（5 tab + 20 子页）、19 个 service、3 个 util、1 个静态数据文件 |
| 后端服务 | `backend/` | Python FastAPI + SQLAlchemy 2.0 同步 ORM + Pydantic v2 | 18 个路由模块、30 个 service、7 个 core 基础设施模块 |
| 管理后台 | `admin/` | Vue 3 + TypeScript + Element Plus + Vite 6 + ECharts 6 | 11 个业务页 + 登录页 + 数据大屏、2 个公共组件、**无 Pinia/Vuex** |
| 数据库 | `docker/` | openGauss（Docker 承载）+ 递增编号 SQL 迁移 | 34 张业务表 + `schema_migrations` 版本表；22 个迁移文件 |
| 项目文档 | `docs/` | Markdown | 迭代台账、测试报告、版本交付说明、设计分析报告 |
| 工程脚本 | 仓库根 | `.bat` / `.json` | 一键启动、后端与 SQL 发布打包、小程序工程配置 |

### 小程序工程配置的特殊层级

微信开发者工具打开的是**仓库根目录** `D:\project\longmarch-run`，而非 `frontend/`；根目录 `project.config.json:56` 通过 `"miniprogramRoot": "frontend/"` 间接指向源码根。`packOptions.ignore` 排除 `test/`、`design.md`、`AGENTS.md`，使测试脚本与文档不进包。

> ⚠️ 仓库根存在 `mini.project.json`（内容 `{"format": 2}`），是**支付宝小程序开发者工具的残留文件**，已被 `.gitignore:29` 忽略。**不要用支付宝开发者工具打开本项目**（会报 CE1000.01 找不到 axml）。

---

## 3. 技术栈与关键选型

### 后端（`backend/requirements.txt`）

| 组件 | 选型 | 约束 |
| --- | --- | --- |
| Web 框架 | FastAPI + Uvicorn | 路由一律同步 `def`，唯一 `async def` 是 WebSocket 端点 |
| ORM | SQLAlchemy 2.0（`Mapped` / `mapped_column`） | 建表**禁止** `create_all`，结构变更只走 `docker/init/*.sql` |
| 数据库驱动 | `psycopg2-binary`（PostgreSQL 兼容协议连 openGauss） | 需 openGauss 版本解析补丁，见 `ARCHITECTURE.md` |
| 校验 | Pydantic v2 + pydantic-settings | 小程序侧响应模型继承 `CamelModel`（camelCase），管理端 `Admin*` 模型为 snake_case |
| 鉴权 | PyJWT（HS256） | 自签发，**无服务端会话存储、无 refresh token** |
| 外部调用 | httpx（同步） | 微信接口 3 个 + 腾讯云 CloudBase Agent（ACP/SSE） |
| 加密 | pycryptodome | 微信运动数据 AES-128-CBC 解密 |
| Excel | openpyxl | **无 pandas**；导入用 `read_only=True` |
| 上传 | python-multipart | 仅管理端两个导入端点使用 |

**明确未引入**：Redis、Celery、Alembic、pandas。因此限流、WebSocket 连接表、微信 access_token 缓存、AI 图片缓存**全部是单进程内存态**，多 worker 部署会失效（见第 8 节）。

### 小程序

原生 CommonJS，无 ESM、无 TypeScript、无 ESLint。校验手段是 `node --check` 逐文件语法检查（IDE 的 GetProblems 返回「无法检测代码问题」是**假阴性**，不可当作通过）。地图用原生 `<map>`（腾讯地图，无需 key）+ Canvas 2D 双模式；全部 Canvas 使用 `type="2d"` 同层渲染新接口，**项目零 `cover-view`**。

### 管理后台

Vue 3.5 `<script setup>` + vue-router 4（History 模式）+ Element Plus 2.9（**按需注册**，见 `src/plugins/element-plus.ts`）+ axios 1.7 + echarts 6（**按需引入** BarChart/LineChart）+ Vite 6 + TypeScript 5.6（`strict: true`）。无路径别名、无 lint/format 配置、无自动化测试框架。

### 数据库

openGauss，Docker 镜像 `opengauss/opengauss-server:latest`（**未固定版本号**）。库运行在 **Oracle 兼容模式（A 模式）**，空字符串 `''` 按 `NULL` 存储，因此所有字符串内容列一律设计为可空。libpq 兼容层把 `server_version_num` 报告为 `90204`（等价 PostgreSQL 9.2.4）。

**开发库实测（2026-10-17，容器 `longmarch-opengauss`，宿主端口 5118）**：`version()` 返回 `openGauss 7.0.0-RC3 build 01b7e318`（compiled 2026-03-25）；`datcompatibility='A'`、`sql_compatibility='A'`；库编码 `UTF8`、collate `en_US.utf8`；`schema_migrations` 已登记 001→022 全部 22 个迁移。**注意 `compose.yml` 与 `init-db.sh` 均未显式指定编码与兼容模式，A 模式来自镜像默认值**——换镜像版本可能改变该默认值。生产库的版本、端口与兼容模式**未核实**（见 §10 待确认 2）。

---

## 4. 开发环境与运行方式

### 一键启动（Windows）

仓库根 `start.bat`：依次启动 openGauss 容器 → 等待健康检查 → 启动后端（8010）→ 启动管理后台 dev server（5173）。端口被占用则跳过该步，首次运行自动安装依赖。

### 分端启动

```bash
# 数据库（含迁移执行）
docker compose -f docker/compose.yml up -d
# → opengauss 容器 longmarch-opengauss，宿主机端口 5118
# → database-init 一次性容器执行 docker/init/init-db.sh，只跑 schema_migrations 中未登记的迁移

# 后端
cd backend && pip install -r requirements.txt && python run.py
# → http://127.0.0.1:8010，Swagger 在 /docs

# 管理后台
cd admin && npm install && npm run dev
# → http://127.0.0.1:5173，/api 由 Vite 代理到 VITE_API_PROXY（默认 http://127.0.0.1:8010）

# 小程序
# 微信开发者工具打开仓库根目录（非 frontend/），自动化端口 9420
```

### 端口与环境变量

| 端 | 本地端口 | 环境切换方式 |
| --- | --- | --- |
| openGauss | 5118（宿主机）→ 5118（容器） | `docker/compose.yml` 的 `GS_*` 变量 |
| 后端 | 8010 | 系统环境变量 `APP_ENV=prod` → 加载 `backend/.env.prod`；否则加载 `backend/.env`。`APP_ENV` **不能写进 env 文件**（文件选择发生在解析之前） |
| 管理后台 dev | 5173（`host: true`，局域网可访问） | `admin/.env.development`（本地）/ `admin/.env.prod`（`npm run dev:prod` 联调生产）；两者都只定义 `VITE_API_PROXY` |
| 小程序 | — | `frontend/services/config.js` 的 `ENV` 常量：`'remote'`（**当前值**，直连 `https://swkjdj.sz-watech.com/api`）/ `'local'`（devtools 走 127.0.0.1:8010，真机走硬编码 `LAN_IP`）。**模块加载时求值一次，运行期不可切换** |

### 管理后台构建命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发服务器（`.env.development`） |
| `npm run dev:prod` | 本地开发服务器，上游为生产后端 |
| `npm run build` | `vue-tsc --noEmit` 类型检查 → `vite build --mode prod` → `node scripts/zip-dist.mjs` 自动打包 `dist.zip` |
| `npm run zip` | 仅重新打包已有 `dist/` |
| `npm run preview` | 本地预览构建产物 |

---

## 5. 部署方式

### 生产拓扑

```
微信小程序（体验版/正式版）  ─┐
                            ├─→ https://swkjdj.sz-watech.com (443)
Vue3 管理后台（静态资源）    ─┘         │
                                    nginx 反代 /api
                                       │
                                       ↓
                          后端 FastAPI / Uvicorn (127.0.0.1:8010)
                                       │
                                       ↓
                                  openGauss
```

- 云主机历史联调 IP 为 `120.25.171.125`，后绑定域名 `swkjdj.sz-watech.com`；因体验版强制域名校验，接口从 `http://域名:8010` 改为 `https://域名`（443）——见 `docs/迭代记录.md` 2026-10-14 条目。
- 微信公众平台已配置 **request 合法域名** `https://swkjdj.sz-watech.com`；**socket 合法域名未配置**（已知遗留）。
- **nginx 配置文件不在本仓库内**，仓库中无任何 nginx 配置；后端进程管理方式（systemd / nohup / supervisor）**待确认**。
- 生产 openGauss 的版本号与端口**待确认**（仓库内无记录；`docker/compose.yml` 用 `latest` 镜像，本地为 5118）。

### 发布产物（三者均被 `.gitignore` 忽略）

| 产物 | 生成方式 | 内容与排除项 |
| --- | --- | --- |
| `backend-update.tar.gz` | 仓库根 `build-backend.bat` | 后端源码 + `.env.prod` + `.env.example`；**排除** `.venv/`、`__pycache__/`、`backend/test/`、`backend/.env`、`*.db`；脚本自带产物校验（实测条目 144 → 76） |
| `sql.tar.gz` | 仓库根 `build-sql.bat` | `docker/init/` 全量打包；**服务器端需人工执行迁移** |
| `admin/dist.zip` | `npm run build` 末段自动调用 `admin/scripts/zip-dist.mjs` | `dist/` 的**内容**（zip 根即 `index.html`、`assets/`），便于直接解压部署。该脚本**零第三方依赖**，用 Node 内置 `zlib.deflateRawSync` 手写 Zip 结构（自实现 CRC-32），规避环境无 `zip`/`7z` 的问题；36 文件约 520KB |
| 小程序包 | 微信开发者工具手工上传，**无 CI** | `packOptions.ignore` 已排除 `test/`、`design.md`、`AGENTS.md` |

### 数据库迁移执行

由 `docker/init/init-db.sh` 承担：校验库名 → 组装 `gsql`（带 `-v ON_ERROR_STOP=1`）→ 库不存在则 `CREATE DATABASE` → 建 `schema_migrations(version PK, applied_at)` → **按文件名字典序**遍历 `/docker/init/*.sql`，跳过已登记者，执行后写入版本号。文件名 `NNN_` 三位前缀保证字典序 = 数字序。

补跑生产库：`docker compose run --rm database-init`（只跑缺失编号）。手工 `gsql -f` 后**必须回填** `schema_migrations`，否则下次会重复执行。

> ⚠️ **迁移编写前必读 `docker/init/SQL_CONSTRAINTS.md`**。已发生两次生产事故：缺 019 迁移导致 `/api/sport/today` 500；缺 020 迁移导致启动崩溃（当时被误诊为 openGauss 派生表语法问题，`f413ac6` 的错误修复后被 `51239b5` 回退）。
>
> ⚠️ `docker/init/021_ai_center.sql` 与 `022_ai_admin_menus.sql` **已在本地 openGauss 应用并登记 `schema_migrations`，但按仓库规则（根 `agents.md` §1.3：`docker/` 不随任务自动提交）未纳入 git**。部署生产前必须单独提交并补跑。

---

## 6. 核心业务规则（摘要）

完整清单与实现状态见 **`REQUIREMENTS.md`**。此处仅列最容易被改错的几条：

1. **总积分 = 步行积分 + 答题积分**。登录积分、达标积分、点亮积分、里程碑积分**已全部取消**；旧流水保留为 `source_type='legacy'`，仅供追溯、不计入。
2. **步行积分 = 累计计分步数 ÷ 1000（向下取整），无单日封顶**；不足 1000 的零头**结余**到下一条记录。每日计分步数上限 20000 步。
3. **答题积分 = 每答对 1 题 2 分，每日封顶 10 分**（5 题全对即封顶）。
4. **每日 5 题，每题 90 秒服务器计时 + 2 秒宽限**；超时不得分且不可再提交。题目按用户独立轮换，**同日固定**。
5. **积分只能经 `points_service` 写入**，`(user_id, biz_key)` 唯一，`biz_key` = `walk:日期` / `quiz:日期`，同日同来源幂等覆盖。**禁止直接写 `points_log`**。
6. **业务自然日统一按北京时间 UTC+8**，库内时间统一存 UTC naive。
7. **昵称仅可修改一次**；首次引导设置昵称（`PUT /auth/nickname/initial`）**不消耗**该机会。
8. **组织首次确定后锁定**（`org_id IS NULL` 原子认领），仅管理员可调整并写审计。
9. **凡影响步数/点亮/答题/积分的操作，之后必须触发 `medal_service.check_and_grant`**。
10. **答题不下发答案与解析**，提交后统一判分；只下发当前题（防作弊）。

---

## 7. 已上线功能

### 小程序（25 页面，5 tab）

tabBar：首页 `home` / 长征 `march` / **AI 问答 `ai-chat`** / 排行 `rank` / 我的 `mine`。

- **启动与准入**：`launch` 启动状态机（自动登录 / 未入驻引导 / 停用拦截 / 活动窗口闸门）、`login`（`open-type="chooseAvatar"` 按钮即登录，无昵称输入框）、`onboard`（邀请码入驻）、`org-select`（层级下钻，双模式）、`bind`（PC 扫码登录与身份绑定确认）、`account`（身份列表，**已注册但入口隐藏**）。
- **运动**：微信运动步数同步（服务端 AES 解密 + watermark 校验）、近 7 日补录、`sport-records`（近 30 天）、`calendar`（月视图 4 级热力）。
- **长征路线**：`march` 双模地图（实景 `<map>` polyline/markers + Canvas 2D「星空远征」）、5 章节系统、节点点亮与到达弹窗、`node-detail`（史料 + 主题氛围粒子）、`person`（人物志）、`ticket`（Canvas 手绘纪念票）、`ceremony`（8 秒完成仪式，仅首次）、开场动画。
- **答题**：`quiz`（入口 + instant/review 双模）、`quiz-answer`（90 秒倒计时环、服务器权威剩余时间）、`quiz-result`（正确率滚动 + 星星逐颗点亮 + 满分彩带）、`quiz-records`。
- **积分与荣誉**：`points`（汇总 + 分页明细 + 步行结余）、`medals`（12 枚，4 类分组 + 神秘勋章遮罩）、`profile`（阶段称号 + 五维雷达 Canvas + 时间线 + 足迹 + 6 格成就）、`rank`（领奖台 + 分页触底加载）。
- **社交与氛围**：首页 11 路并发聚合（同组织同行者、组织共同长征、全员共同目标、实时行军动态流、每日寄语）。
- **活动状态**：`activity`（未开放/已结束告知页）。
- **AI**：`ai-chat`（多轮对话 + 会话抽屉 + 乐观渲染 + 403/429 常驻提示条 + 账号切换清理）。

### 管理后台（11 菜单）

驾驶舱、数据大屏、排名洞察、路线点位、题库维护（含 Excel 导入 + AI 智能出题）、每日寄语（含循环起始日 + Excel 导入）、组织架构（含外部同步 + 人员明细）、人员授权（RBAC 双 Tab）、入驻邀请码（含小程序码）、审计日志、活动设置。登录支持账号密码与微信扫码双通道。

### 后端

18 个路由模块、30 个 service；AI 智能中心 Phase A（历史助手 / 路线讲解 / 答题解析 / 题目工坊 / 用量限额 / 知识库）；WebSocket 实时广播；Excel 两段式导入（预览-确认，一次性 token，原子核销）；流式 CSV 导出（防公式注入）；进程内限流；审计日志。

---

## 8. 当前已知问题与遗留

### 阻塞级 / 功能不可用

| # | 问题 | 影响 | 依据 |
| --- | --- | --- | --- |
| 1 | **wss 在 443 上握手失败**。nginx 未把 `Upgrade`/`Connection` 头透传给后端，curl 带 Upgrade 直连得到 FastAPI 404 | 小程序与管理后台的实时推送均不可用（REST 接口不受影响，客户端有自动重连兜底）。需在 nginx 443 server 块补 `proxy_http_version 1.1;` + `proxy_set_header Upgrade $http_upgrade;` + `proxy_set_header Connection "upgrade";` | `docs/迭代记录.md` 2026-10-14 条目遗留项 1 |
| 2 | **微信公众平台 socket 合法域名未配置** | 体验版/正式版无法建立 wss 连接 | 同上 |
| 3 | **生产库缺 AI 迁移 021/022**（文件未提交） | 部署含 AI 功能的后端会因缺表 500 | `git status` + `docs/迭代记录.md` 2026-10-17 |

### 架构级限制

| # | 问题 | 说明 |
| --- | --- | --- |
| 4 | **单进程内存态**：限流器、WebSocket 连接表、微信 access_token 缓存、邀请码图片缓存 | 多 worker 部署会失效，需换 Redis。`backend/app/core/rate_limit.py` docstring 自述此限制 |
| 5 | **openGauss 版本 monkey-patch**（`backend/app/core/database.py:11-43`） | 把方言版本伪造为 (9,2,4)，副作用是关闭窗口函数/`ON CONFLICT`/JSONB 的方言自动适配。升级 SQLAlchemy 后须回归 `backend/test/s21_opengauss_compat.py` 并考虑删除补丁 |
| 6 | **无迁移工具**（未引入 Alembic） | 靠递增编号 SQL + 人工执行，已发生两次生产迁移缺口事故 |
| 7 | **头像未上传后端** | 小程序 `chooseAvatar` 返回临时路径，仅本地 `FileSystemManager.saveFile` 持久化；换设备/清缓存即丢头像。后端**无头像上传端点** |
| 8 | **调试端点暴露在生产 API 面** | `POST /api/quiz/reset`（重置当日答题）与 `POST /api/sport/add`（手动补步）仅挂活动参与守卫，任何登录用户可调用 |
| 9 | **AI 知识检索是关键词匹配**，未接入向量语义检索 | `ai_knowledge_service.py` docstring 明示为 V1.0 已知取舍 |
| 10 | **`wx_web`（开放平台网站应用）渠道半成品** | 配置项、表结构、确认流程已就绪，但**全代码库无任何创建 `BindRequest` 行的入口**，绑定只有确认/取消半程 |

### 代码级技术债

| # | 问题 | 位置 |
| --- | --- | --- |
| 11 | `march.js` 单文件 **1477 行**，混合状态机/地图数据构建/Canvas 绘制/手势/动画五类职责 | `frontend/pages/march/march.js` |
| 12 | **无 App 级 `onError`/`onUnhandledRejection`/`onPageNotFound`**，线上异常无回收手段、无错误上报 | `frontend/app.js`（全文 26 行） |
| 13 | **未启用** `lazyCodeLoading`、无 `subPackages` 分包、无 `preloadRule`、无骨架屏、无长列表虚拟滚动 | `frontend/app.json` |
| 14 | **小程序零自定义组件**，卡片/弹窗/进度点在多个 WXML 中重复实现 | 25 个页面 JSON 全量核对 |
| 15 | `pages/account` 已注册但**无任何跳转入口**；其 `handleUnbind` 对应按钮在 WXML 中未渲染（死代码路径） | `frontend/app.json:23`、`frontend/pages/account/account.js:52-78` |
| 16 | `images/tabbar/quiz.png` 与 `quiz-active.png` 存在但 `app.json` 未引用（quiz 已降级为子页） | `frontend/images/tabbar/` |
| 17 | `services/store.js` 仅供遗留 Mock 数据迁移，2 个调用点；旧 key `lm_data_{userId}` **迁移后不删除** | `frontend/services/store.js` |
| 18 | admin `ActivityView.vue:177-179` 用了 `<el-result>`，但 `plugins/element-plus.ts` 按需注册清单中**没有 `ElResult`**，触发该错误兜底分支时可能报「Failed to resolve component」 | `admin/src/views/ActivityView.vue` |
| 19 | admin `RankingsView.vue` 独占 `pages/` 目录，其余 11 个业务页在 `views/`；两目录被路由同等对待，**无功能区分**。溯源为 `81b86e5` 一次性引入，代码与文档均无解释 | `admin/src/pages/` |
| 20 | admin **无按钮级权限控制**，权限仅到菜单/路由级，敏感操作全靠后端二次校验兜底 | `admin/src/router/index.ts` |
| 21 | `RouteNodesView` 一次拉全量 + 前端 computed 过滤，与其它列表页的服务端分页范式不一致 | `admin/src/views/RouteNodesView.vue:18-34` |
| 22 | `access_service.ALL_MENU_CODES`（`backend/app/services/access_service.py:27-39`）定义后**无任何引用**，且未含 `activity` 与 5 个 `ai_*` 菜单码 | 疑似死代码 |
| 23 | 章节（CHAPTERS）配置**硬编码**在 `backend/app/services/march_service.py:47`，管理端无可视化编辑 | 文档注明「后续增强」 |
| 24 | 旧 e2e 测试脚本（`e2e_full_flow`、`e2e_datasync`、`s3_aggregates`）仍按 V1 口径（整卷提交、点亮发积分），登录链路 502，**未随 V2.0 改写** | `docs/迭代记录.md` `19b0d73` / `2f3f333` 遗留 |
| 25 | `frontend/test/automator/ui-test.cjs` phase1 T02 断言已过期；automator 22/23 中 T16a 为环境性失败 | `docs/测试报告.md`、`a60b94b` 遗留 |
| 26 | **`admin_menus.sort_order` 重号**：`invites`=10 与 `ai_overview`=10、`activity`=11 与 `ai_knowledge`=11。侧边栏顺序由 `menus.ts` 静态数组决定故不受影响，但三处 `order_by(AdminMenu.sort_order)` 在同分时**返回顺序不稳定**（角色菜单勾选列表、菜单全量列表、用户菜单码列表）。2026-10-17 经用户决定**只记录不修改** | `docker/init/015_invite_admission.sql:31-33`、`016_activity_settings.sql:36-38`、`022_ai_admin_menus.sql:15`/`:18`；`backend/app/services/access_service.py:63`/`:80`/`:201` |
| 27 | **非自增主键靠 `max(id)+1` 分配且无并发保护**：并发新增题目/路线点位可撞主键；AI 批量生成与 Excel 导入也走同一套 `max+1`。`persons` 更是只有 seed、无新增代码路径 | `admin_service.py:46-47`/`:175-176`、`ai_question_service.py:378`/`:674`、`import_service.py:293` |
| 28 | **ORM 类型注解与运行时不符**：`Numeric` 列注解为 `Mapped[float]`，但 psycopg2 实际返回 `decimal.Decimal`（`Mapped[...]` 只是 typing 元数据，不做强转）；出口靠 Pydantic 转 float。直接对这些字段做算术或比较时需注意 Decimal/float 混用 | `models.py:55-56`（`route_nodes.latitude`/`longitude`）、`:246`（`daily_sport.distance`） |
| 29 | **补签字段为死字段**：`daily_sport.is_makeup` / `makeup_at` 已由 `005_upgrade.sql:31-36` 建列且 NOT NULL DEFAULT FALSE，但全仓无任何业务写入点，库中 0 行为 true | `models.py:235` docstring、`:248-249` |

### 文档滞后项（代码正确，文档过时）

| 文档 | 滞后内容 |
| --- | --- |
| `frontend/design.md:54` | 仍写「登录后发每日登录积分」——该积分已于 `2f3f333` 取消 |
| `frontend/AGENTS.md` §5 | 提到前端硬编码坐标表 `NODE_COORDS`——**代码中不存在**，坐标全部来自 `GET /march/route` |
| `frontend/design.md:261` | 称跨端一致性靠「管理端 WebSocket 广播」——小程序端**只消费 `type === 'activity'`**，不处理任何数据变更事件 |
| `admin/design.md` §3 | 页面清单只列到 `/orgs`，**缺 `/access`、`/invites`、`/audit`、`/activity` 四个已实现路由** |
| `backend/design.md` §2.2 | 称 `seed.py` 写入「后台菜单 9 项与内置角色」——实际菜单与角色由 `docker/init/010_admin_identity.sql` 种入，`seed.py` 不含任何菜单/角色；且菜单现为 **16 个** |
| `backend/app/models/models.py:5`、`backend/AGENTS.md` | 写「勋章 6」——`seed.py` 实际 **12 枚** |
| `backend/app/models/models.py:524` | `ImportPreview` docstring 写 `biz_type: question / quote / staff`——`import_service` **只实现了 question 与 quote**，无 staff（人员）导入 |
| `project.config.json:57` vs `project.private.config.json` | `libVersion` 入库值 `3.0.0` 与本机私有值 `3.17.3` 不一致 |

### 待验证项（多处标注「待用户确认」）

真机扫码入驻、真机断网表现、真机微信运动端到端（`scope.werun` + `wx.getWeRunData`）、真机 AI 全链路（本机 DNS 劫持限制）、低端机星空地图帧率、小程序主包体积与 2MB 上限的实际余量。

---

## 9. 敏感信息与入库状态

**写文档时必须避开这些文件的真实值，只记录配置项名称与用途。**

### 已被 git 跟踪（入库）

| 文件 | 风险 |
| --- | --- |
| `backend/.env` | **高**：微信小程序 AppSecret、JWT 签名密钥、管理员口令、数据库连接串明文。`.gitignore` 以 `!backend/.env` 显式放行——**这是用户的明确决定** |
| `backend/.env.prod` | **高**：生产参数。其中生产库连接串 / `JWT_SECRET` / `ADMIN_PASSWORD` 为**占位符**，部署前须替换为服务器真实值；替换后不得回填入库 |
| `backend/.env.example` | **中**：模板。历史上 `865aec4` 曾误含真实 `WX_SECRET`，`1b02985` 已移除，但**旧值仍可从 git 历史检出**，须在微信公众平台重置该密钥 |
| `docker/compose.yml`、`docker/init/init-db.sh` | **中**：开发库初始口令与环境变量明文（仅开发用途） |
| `project.config.json` | **中**：含小程序 appid |
| `docs/迭代记录.md` | **中**：2026-10-09 一条记录的正文中含开发管理员账号与明文口令、`WX_APPID`。**引用该文件时不得复制这些值** |
| `admin/.env.development`、`admin/.env.prod` | **低**：仅 API 代理地址，无凭据 |

### 未跟踪（`.gitignore` 忽略，仅存本地）

`project.private.config.json`、`mini.project.json`、`frontend/test/token.txt`（登录令牌）、`frontend/test/*.json`、`frontend/test/automator/results*.json` / `state.json` / `console-log.json`、`backend-update.tar.gz`、`sql.tar.gz`、`admin/dist.zip`、`backend/*.db`、`_smoke_*.py`、`*.log`、`.env*.local`。

> 根 `agents.md` §1.3 的提交前检查显式点名 `frontend/test/token.txt` 之类临时凭证**不得入库**。

---

## 10. 文档覆盖率

### 本批已交付（总览层）

| 文档 | 状态 |
| --- | --- |
| `.qoder/README.md` | ✅ |
| `.qoder/PROJECT.md` | ✅ 本文件 |
| `.qoder/ARCHITECTURE.md` | ✅ |
| `.qoder/REQUIREMENTS.md` | ✅ |
| `.qoder/CHANGELOG.md` | ✅ |
| `.qoder/backend/test/README.md` | ✅ 后端测试体系总览 |
| `.qoder/frontend/test/README.md` | ✅ 小程序测试体系总览 |
| `.qoder/admin/test/README.md` | ✅ 管理后台验收体系总览 |
| `.qoder/tasks/README.md` | ✅ 任务记录约定 + `docs/` 中 9 份真实记录索引（**本批未新建任务记录**） |
| `.qoder/decisions/README.md` | ✅ 架构决策**索引**（指向代码注释等既有权威出处，**本批未新建 ADR 文件**） |

### 待补齐（文件级文档，按批次）

| 批次 | 范围 | 预计文档数 |
| --- | --- | --- |
| 一 | `backend/app/**`（api 21 + core 8 + data 2 + models 2 + schemas 2 + services 31）+ `backend/run.py` + 后端工程配置 | ~68 |
| 二 | `frontend/`：25 个页面（页面级合一）+ 19 service + 3 util + 1 data + `app.js`/`app.json`/`app.wxss`/`sitemap.json` | ~52 |
| 三 | `admin/src/**` 28 + 工程配置与脚本 ~9 | ~37 |
| 四 | `docker/init/` 22 个 SQL + `init-db.sh` + `compose.yml` | ~24 |

**建档分母说明**：git 跟踪文件共 676 个（不含尚未入库的 `.qoder/` 与 `docker/init/021`、`022`），其中约 400 个属第 4 节排除规则覆盖的测试脚本、测试报告、截图、构建产物与依赖，不建档。需建档的业务源文件约 **181 个**。

### 待确认问题清单（汇总）

2026-10-17 复核后，原 16 项中 **9 项已由代码与开发库实测查证解决**（见下表），**2 项经用户决定转为需求状态记录**（原 14、15），剩余 **5 项**（原 1、2、8、10、16）合并为下面 **4 条**仍需生产环境或后续工作才能确认的条目（原 2 与 8 同属生产部署事实，合并为第 2 条）。

**仍需确认（4 项）**

1. **生产环境实际活动窗口**：`activity_settings` 生产库值未知。开发库实测为 1 行、`start=2026-08-31 16:00`、`end=2026-12-31 15:59`、`published=true`，**不代表生产**。
2. **生产部署事实**：生产 openGauss 版本与端口、后端进程管理方式（systemd / nohup / supervisor）、nginx 配置文件位置、`ORG_SYNC_API_URL` 是否在生产启用。开发环境已实测（openGauss 7.0.0-RC3、5118、`datcompatibility='A'`），生产未核实。**用户决定：标注为待确认，不阻塞建档。**
3. **早期迁移语法兼容性**：002/005/013/015/017/019/020 含 `SQL_CONSTRAINTS.md` 后来禁用的 `ADD/DROP COLUMN IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS`；在**全新空库首次全量执行 001→022** 是否可行只有推理、无实测。**用户决定：暂不做 dry-run，仅标注风险。**
4. **81 份测试报告与当前代码的对应关系**：`frontend/test/docs/` 32 份、`backend/test/docs/` 33 份、`admin/test/docs/` 16 份，未逐份核对。

**已查证解决（9 项，2026-10-17）**

| 原编号 | 问题 | 查证结果与依据 |
| --- | --- | --- |
| 3 | 字符集与 `dbcompatibility` 模式 | 开发库实测：`UTF8` / `en_US.utf8`、`datcompatibility='A'`、`sql_compatibility='A'`、**openGauss 7.0.0-RC3 build 01b7e318**。`compose.yml` 与 `init-db.sh` 均未显式指定，A 模式是**镜像默认值** |
| 4 | 勋章数量口径 12 vs 6 | **12 枚为真**：`seed.py:282-313` MEDALS 12 项，库中 `medal_defs` 12 行。写「6 枚」的 `models.py:5` 与 `backend/AGENTS.md` 属文档滞后（见 §8） |
| 6 | `is_makeup` / `makeup_at` 是否有写入 | **纯预留死字段**：库中 0 行有值；全仓除 `models.py:248-249` 定义与 `005_upgrade.sql:31-36` 建列外无任何写入点，`models.py:235` docstring 自述「为补签预留字段」 |
| 7 | 非自增主键如何分配 id | 一律 **`max(id)+1`**：`admin_service.py:46-47`（route_nodes）、`:175-176`（questions）、`ai_question_service.py:378`/`:674`、`import_service.py:293`。**无并发保护**，并发新增可撞主键。`persons` 仅 seed（13 行，id 1-13），**无新增代码路径** |
| 9 | `Numeric` 列的 Decimal→float 处理 | 库实际返回 `Decimal`（`daily_sport.distance` → `Decimal('4.27')`、`route_nodes.latitude` → `Decimal('25.885000')`），而 ORM 注解为 `Mapped[float]`（`models.py:55-56`、`:246`）——**注解只是 typing 元数据，不做类型强转，注解与运行时类型不符**；出口由 Pydantic 转 float |
| 11 | 逻辑外键孤儿数据 | **全部 0 孤儿**：`users.org_id`、`lit_nodes.node_id`、`user_medals.medal_id`、`quiz_records.user_id`、`daily_sport.user_id`、`organizations.parent_id`、`points_log.ref_id`→`daily_questions`。（注意 `ref_id` 指向 **`daily_questions.id`** 而非 `quiz_records.id`，见 `quiz_service.py:260`/`:452` 传入 `session.id`） |
| 12 | `march` 双模式切换触发条件 | **有明确 UI 开关，非自动降级**：`frontend/pages/march/march.wxml:52-64` 两个 `bindtap="switchMode"` 按钮（`data-mode="real"` 实景地图 / `data-mode="canvas"` 星空长征），初值 `mode:'real'`（`march.js:49`），处理函数 `march.js:361-380` |
| 13 | 默认昵称「长征小战士」定义位置 | **`backend/app/models/models.py:192`**：`nickname: Mapped[str] = mapped_column(String(64), default="长征小战士")`，ORM 列默认值 |
| 5 | `admin_menus.sort_order` 重号 | **确认为真重号**：`invites`=10 与 `ai_overview`=10、`activity`=11 与 `ai_knowledge`=11（`015:31-33`、`016:36-38`、`022:15`/`:18`）。侧边栏顺序由 `admin/src/router/menus.ts` 静态数组决定**不受影响**；受影响的是 `access_service.py:63`/`:80`/`:201` 三处 `order_by(AdminMenu.sort_order)` 的返回顺序在同分时不稳定。**用户决定：只记录为已知问题，不改业务代码**（见 §8 代码级技术债） |

**转为需求状态记录（2 项）**

- `ai-chat` 的 `nodeId` 参数通道 → REQUIREMENTS.md 标为**待开发（Phase B，无明确排期）**。
- `pages/account` 入口恢复 → REQUIREMENTS.md 标为**已隐藏，恢复条件待产品确认**。
