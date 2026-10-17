# .qoder · 长征步迹项目文档体系

本目录是「长征步迹」项目的**结构化文档库**，与源代码建立一一对应关系，供开发人员与 AI 编程工具快速理解项目现状。

> **本目录只放文档，不放任何可执行代码。** 文档不得替代源码成为事实来源；当文档与代码冲突时，**以代码为准**，并立即修正文档。

---

## 1. 目录结构与索引

```text
.qoder/
├── README.md           # 本文件：协作约定、排除规则、文档模板
├── PROJECT.md          # 项目总览：定位、模块、环境、运行与部署、已知问题
├── ARCHITECTURE.md     # 架构：四端调用关系、API 约定、鉴权、数据库、WS、导入导出、部署
├── REQUIREMENTS.md     # 业务需求清单与实现状态（已实现/部分实现/待开发/已废弃/待确认）
├── CHANGELOG.md        # 项目级变更记录（跨端影响、DB/API 变更、兼容性、部署）
├── decisions/          # 架构与技术决策记录（ADR），一事一文件
├── tasks/              # 单次需求的任务记录，命名 YYYY-MM-DD-<主题>.md
├── backend/            # 镜像 backend/ 的后端文件文档
│   ├── app/{api,core,data,models,schemas,services}/…<文件名>.md
│   └── test/README.md  # 后端测试体系总览（测试脚本不逐个建档）
├── frontend/           # 镜像 frontend/ 的小程序文件文档
│   ├── pages/<页面>/<页面>.js.md   # 页面级合一（含 WXML/WXSS/JSON 章节）
│   ├── services/…  utils/…  data/…
│   └── test/README.md  # 小程序 automator 测试体系总览
├── admin/              # 镜像 admin/ 的管理后台文件文档
│   ├── src/{api,components,layout,pages,plugins,router,store,utils,views}/…
│   └── test/README.md  # 管理后台验收体系总览
└── docker/
    └── init/           # 镜像 docker/init/ 的 SQL 迁移与初始化脚本文档
```

**镜像规则**：源文件 `backend/app/api/routes/quiz.py` → 文档 `.qoder/backend/app/api/routes/quiz.py.md`。文档名 = 原文件名 + `.md` 后缀，目录层级与源码完全一致。

**页面级合一例外**：小程序每个页面的 `.js/.wxml/.wxss/.json` 四件套合并为一份文档，命名取 `<页面名>.js.md`（如 `.qoder/frontend/pages/home/home.js.md`），文档内设 WXML / WXSS / JSON 专章并标注对应文件。理由：小程序页面是「四文件一体」的不可分割单元，拆成四份会造成大量重复且 wxml/wxss 单独成文信息量过低。

---

## 2. 与其他文档的关系（避免多头真相）

本仓库已有多套文档，职责划分如下，**不得重复维护同一事实**：

| 文档 | 定位 | 权威性 |
| --- | --- | --- |
| `docs/迭代记录.md` | 逐提交的迭代台账（138+ 条，含验证结果） | **提交级历史的唯一权威来源** |
| `agents.md`（根） | 跨子项目工作流规则：提交推送、提交粒度、编码质量原则 | 流程规则权威 |
| `backend/AGENTS.md`、`frontend/AGENTS.md`、`admin/agents.md` | 各端技术约定与架构不变量 | 各端技术约定权威；**冲突时子目录文档优先于根文档的技术细节** |
| `backend/design.md`、`frontend/design.md`、`admin/design.md` | 各端设计说明 | 参考；已知存在滞后（见 REQUIREMENTS.md「文档滞后项」） |
| `docker/init/SQL_CONSTRAINTS.md` | openGauss 迁移编写硬约束 | **写 SQL 迁移前必读，权威** |
| `docs/upgrade-plan.md`、`docs/长征步迹V*` | 阶段性规划与交付说明 | 历史快照，不随代码更新 |
| `.qoder/`（本目录） | 文件级功能说明 + 项目总览 + 需求实现状态 + 变更影响分析 | 文件级说明的权威；总览为**导航层**，细节回指上述文档 |

分工原则：
- **提交级明细**（谁在何时改了什么、验证结论）留在 `docs/迭代记录.md`，`.qoder/CHANGELOG.md` 只做**跨端影响与版本级归纳**并回指提交号，不复制其正文。
- **技术约定与禁止行为**留在各端 `AGENTS.md`，本目录只引用不复述。
- **文件级职责、接口、依赖、修改约束、迭代记录**是本目录独有职责。

---

## 3. 自动维护规则（每次任务必须遵守）

1. **开始任务前**，先读 `PROJECT.md`、`ARCHITECTURE.md`、`REQUIREMENTS.md`，以及本次涉及文件对应的 `.qoder/**/<文件>.md`。
2. **修改源代码前**，先核对现有实现与相关业务规则，避免重复实现已有功能。
3. **新增源文件时**，同步创建对应的文件说明文档（按第 5 节模板）。
4. **修改已有文件时**，同步更新该文件文档的「核心功能」「业务规则」「当前实现状态」，并在「迭代记录」章节**按时间倒序追加**一条（日期 / 需求 / 修改内容 / 关联文件 / 测试结果）。
5. **涉及多个模块时**，更新全部相关文件文档，并在 `.qoder/CHANGELOG.md` 记录本次变更；同时按根 `agents.md` §1.8 在 `docs/迭代记录.md` 追加条目。
6. **修改 API 时**，同步更新 `ARCHITECTURE.md` 的接口约定、以及**所有受影响调用方**的文档（后端 route/service/schema 三处 + 小程序 service + admin api）。前后端字段命名契约不同（小程序 camelCase、管理端 snake_case），改动须双端核对。
7. **修改数据库时**，同步更新 `.qoder/docker/init/<迁移文件>.sql.md` 与 `ARCHITECTURE.md` 的表结构说明，记录迁移方式与兼容性影响；新增迁移必须遵守 `docker/init/SQL_CONSTRAINTS.md`，**禁止修改已在生产执行过的编号脚本**。
8. **修复 Bug 时**，在对应文件文档记录问题原因、修复方式与回归测试结果。
9. **删除或重命名文件时**，同步删除/重命名对应文档，并更新引用它的其他文档与本 README 的目录说明。
10. **不得仅根据文件名推断功能**；必须阅读源代码、注释、Git 历史（`git log --follow <file>`）及既有需求文档后再落笔。
11. **不得覆盖、删除或随意改写已有迭代历史**。历史记录只可追加或在确证错误时更正，并须注明更正依据。
12. **未经明确要求，不要为了生成文档而修改业务代码、数据库数据或生产环境配置。**
13. **排除规则**见第 4 节。
14. **敏感信息**：对 `.env` 等文件只记录**配置项名称与用途**，绝不复制实际值；文档中不得出现密码、Token、AppSecret、JWT 密钥、数据库连接串、邀请码、真实 openid/unionid。
15. **引用 `docs/迭代记录.md` 只用提交号，禁止用行号**。该文件按根 `agents.md` §1.8 在**顶部**追加条目，任何一次提交都会使其后所有行号整体下移——写作当时正确的行号，下一次提交即失效（本仓库已出现过 116 处失效引用）。统一写法：`` `docs/迭代记录.md` 的 `<7 位提交号>` 条目 ``；提交号取该条目 `- 提交：`<hash>`` 一行。
16. **引用 `.qoder/` 四份总览文档（`PROJECT.md` / `ARCHITECTURE.md` / `REQUIREMENTS.md` / `CHANGELOG.md`）用「章节号 + 行标签」，不用行号**——这四份文档会被并行任务持续编辑，行号不稳定（本仓库已查出 8 处因此指到了错误的表格行）。写法：
    - 指向表格某一行：`` `.qoder/REQUIREMENTS.md` §10.1「后台 AI 接口」行 ``（引号内抄该行首列原文，行标签不会像行号那样漂移）；
    - 指向编号列表某一项：`` `.qoder/PROJECT.md` §8「代码级技术债」第 22 项 ``；
    - 指向整节/整段：`` `.qoder/ARCHITECTURE.md` §9.4 ``、`` `.qoder/ARCHITECTURE.md` §7「wx_web 半成品」段 ``。
    - **禁止**用 `DOC.md:482`/`:527` 这类省略写法并列引用多行——展开后第二个行号会失去归属。
17. **引用源码文件才写 `路径:行号`**（如 `backend/app/services/sport_service.py:126`），且必须实际读过该行、确认内容确为所述；行号范围不得超出文件实际行数。`.qoder/` **文件级**文档之间互引可保留行号（每份文档与一个源文件一一对应、几乎不会被并行任务改动），但同样须实读确认，且这些文档自身增删行后必须回来更正引用方。

---

## 4. 建档排除规则

以下类别**不逐个建文件级文档**，只在总览或对应 `test/README.md` 中集中说明：

| 类别 | 具体范围 | 处理方式 |
| --- | --- | --- |
| 第三方依赖 | `admin/node_modules/`、`frontend/test/automator/node_modules/`、Python 包 | 不建档；依赖清单见 `PROJECT.md` |
| 构建产物 | `admin/dist/`、`admin/dist.zip`、`backend-update.tar.gz`、`sql.tar.gz`、`*.tsbuildinfo` | 不建档；打包方式见 `ARCHITECTURE.md` 部署章节 |
| 缓存与虚拟环境 | `__pycache__/`、`.venv/`、`.pytest_cache/` | 不建档 |
| 本地数据库文件 | `backend/longmarch.db`、`backend/_smoke_*.db`、`backend/test/_smoke_*.db` | 不建档；属冒烟测试临时产物，**禁止视为源码修改目标** |
| 日志与临时文件 | `*.log`、`frontend/test/automator/probe-*.tmp.cjs` | 不建档 |
| 测试脚本 | `backend/test/*.py`（37 个）、`frontend/test/automator/*.cjs`（55 个）、`frontend/test/*.cjs` | **不逐个建档**，集中写入 `.qoder/backend/test/README.md`、`.qoder/frontend/test/README.md`（含脚本清单与覆盖场景对照表） |
| 测试报告与证据 | `*/test/docs/*.md`、`*/test/images/*.png`、`*-results.json` | 不建档；在各 `test/README.md` 中说明归档规则与索引方式 |
| 敏感配置 | `backend/.env`、`backend/.env.prod`、`project.config.json`、`admin/.env.*` | 建档但**只列配置项名称与用途**，不写值 |
| 本机私有配置 | `project.private.config.json`、`mini.project.json`（支付宝工具残留）、`.env*.local` | 不建档（已 gitignore）；在 `PROJECT.md` 说明其存在与风险 |
| 纯静态资源 | `frontend/images/tabbar/*.png` | 不建档；生成方式见 `.qoder/frontend/test/README.md` |
| 空/单行包标识文件 | `backend/app/**/__init__.py`（8 个，均为 1 行）、`admin/src/**` 中的纯 re-export 桶文件 | 不建档；其存在意义只是 Python 包标识，无业务含义。所在包的职责写进该包内实际业务文件的文档 |
| 既有说明文档 | `backend/AGENTS.md`、`backend/README.md`、`backend/design.md`、`frontend/AGENTS.md`、`frontend/design.md`、`admin/agents.md`、`admin/design.md`、`docker/init/SQL_CONSTRAINTS.md`、`docs/**` | **不建档也不复制内容**；它们是各自范围的权威出处，`.qoder/` 只做索引与交叉引用（分工见 §2），避免多头真相 |
| 测试结果产物 | `backend/e2e-full-results.json` 等仓库内散落的 `*-results.json` | 不建档；属测试产物，归档规则见 `.qoder/backend/test/README.md` |

**必须建档**的范围：`backend/app/**`、`backend/run.py`、`frontend/app.*`、`frontend/pages/**`（页面级）、`frontend/services/**`、`frontend/utils/**`、`frontend/data/**`、`admin/src/**`、`admin/scripts/**`、`docker/init/*.sql`、`docker/init/init-db.sh`、`docker/compose.yml`，以及各端工程配置文件（`package.json`、`vite.config.ts`、`tsconfig*.json`、`requirements.txt`、`.env*`、`project.config.json`、`sitemap.json`、根 `*.bat`）。

---

## 5. 文件说明文档模板

每份文件级文档统一使用以下结构。无法从代码、Git 历史或既有文档确认的信息，**必须写「待确认」，禁止推测填充**。

```markdown
# <文件名>

## 1. 文件路径
<相对项目根目录的路径>

## 2. 文件职责
<这个文件解决什么问题，1-3 句>

## 3. 业务需求
<对应的业务场景与需求来源；有需求文档时注明出处>

## 4. 核心功能
<逐项说明主要函数/类/组件/处理流程，标注行号>

## 5. 输入与输出
<参数、返回值、数据格式、异常与错误码>

## 6. 依赖关系
<依赖的模块、接口、数据库表、第三方库；以及被谁依赖>

## 7. 业务规则
<积分计算、权限校验、状态流转、幂等与并发约束等>

## 8. 修改约束
<不可破坏的兼容性要求、架构不变量、注意事项>

## 9. 当前实现状态
<已实现 / 存在问题 / 待开发，逐条列明>

## 10. 迭代记录
<按时间倒序；数据来源 git log --follow 与 docs/迭代记录.md>

### YYYY-MM-DD
- 需求：
- 修改内容：
- 关联文件：
- 测试结果：
```

按文件类型的补充要点：

- **后端 Python**：路由地址 + HTTP 方法 + 权限依赖（`get_current_user` / `require_menu(code)` / 活动守卫）；请求参数、`response_model`、错误码；route→service→model/schema 关系；数据库查询与事务边界（谁 commit）；异常处理与审计写入。
- **小程序**：页面路径与入口（从哪跳进来）；四件套关系；`data` 状态字段、事件处理、`onLoad/onShow/onHide/onUnload` 生命周期职责；调用的 service 与后端路径；登录守卫与缓存键；页面跳转关系；Canvas/动画/定时器清理。
- **Vue3 管理后台**：路由 path/name/menu 权限码；与公共组件的关系；调用的 `api/admin.ts` 函数与后端路径；表格/表单/弹窗交互；查询条件、分页方式（服务端 or 前端过滤）、导入导出与校验规则；加载/空态/错误态；是否订阅 WebSocket。
- **SQL 与数据模型**：表、字段、类型、可空性、默认值、索引、约束、关联关系；字段业务含义；数据来源与更新规则；迁移幂等性与执行顺序；openGauss 兼容性风险；回滚方式。
- **配置与部署文件**：配置项名称与用途（**不写值**）；生效环境（dev/prod）；被谁引用；部署与启动方式；修改的影响面。

---

## 6. 任务记录（tasks/）

每次独立需求在 `.qoder/tasks/` 建一份记录，命名 `YYYY-MM-DD-<英文短横线主题>.md`，包含：

1. 需求背景　2. 修改前的行为　3. 期望行为与验收标准　4. 影响文件清单　5. 实施方案
6. 实际修改记录　7. 数据库或接口变更　8. 测试结果　9. 发布与回滚说明

**只在确有该次任务时创建，不得把示例当真实历史。** 历史需求（V1.0/V1.1/V2.0/AI Phase A 等）的原始记录在 `docs/迭代记录.md` 与 `docs/长征步迹V*` 中，本目录不追溯补造。

架构级决策（选型、契约变更、放弃某方案）另在 `.qoder/decisions/` 记录，命名 `NNN-<主题>.md`，说明背景、备选方案、决定与后果。

---

## 7. 当前覆盖状态

建档进度与未覆盖清单（含分母口径）见 `PROJECT.md` 末节「文档覆盖率」。

**第一批（总览层）已交付，共 10 份：**

| 文档 | 内容 |
| --- | --- |
| `README.md` | 本文件：目录结构、与其他文档的分工、17 条自动维护规则、建档排除规则、文件级模板 |
| `PROJECT.md` | 项目定位、四端组成与真实目录、开发/运行/部署、核心业务规则、已知问题、文档覆盖率统计 |
| `ARCHITECTURE.md` | 四端调用关系、分层与请求链路、API 约定、鉴权与 RBAC、WebSocket、微信对接、导入导出、状态与一致性、部署与迁移、数据库结构、16 条架构不变量、架构级限制、待确认清单 |
| `REQUIREMENTS.md` | 现行有效业务需求逐条实现状态（已实现/部分实现/待开发/已废弃/待确认），含已废弃规则清单与文档滞后项 |
| `CHANGELOG.md` | 项目级变更归纳（13 个阶段），与 `docs/迭代记录.md` 的分工见其 §0；含 001→022 迁移全表与反复变更热点 |
| `backend/test/README.md` | 后端冒烟测试体系、编号语义、脚本→场景→报告对照表、辅助文件、执行约定与已知坑 |
| `frontend/test/README.md` | 小程序 automator 测试体系、`ui-test.cjs` 五阶段与四层防挂死机制、脚本清单、执行前置条件与已知坑 |
| `admin/test/README.md` | 管理后台验收体系（无自动化框架）、16 份报告清单、截图证据约定、已知坑 |
| `tasks/README.md` | 任务记录约定与 9 项模板；`docs/` 中已存在的 9 份真实任务/分析记录索引 |
| `decisions/README.md` | 架构与技术决策**索引**（不新建 ADR 文件，指向代码注释与模块 docstring 等权威出处） |

**文件级文档进度**：按 backend → frontend → admin → docker/init 分四批补齐，每批完成后提交推送。

| 批次 | 范围 | 状态 |
| --- | --- | --- |
| 一 | `.qoder/backend/**`（`app/services` 30、`app/api/routes` 18、`app/core` 7、`deps.py`、`main.py`、`seed.py`、`models.py`、`schemas.py`、`run.py`、`.env`、`.env.prod`、`requirements.txt`） | ✅ **64/64 已交付**（2026-10-17） |
| 二 | `.qoder/frontend/**`（25 页面 + 19 service + 3 util + 1 data + `app.*` + `sitemap.json` + 根 `project.config.json`） | 待补齐（52） |
| 三 | `.qoder/admin/**`（`src/**` 28 + 脚本与工程配置 7） | 待补齐（35） |
| 四 | `.qoder/docker/**`（22 SQL + `init-db.sh` + `compose.yml`）+ 根 `*.bat` 4 个 | 待补齐（28） |

`.qoder/frontend/`、`.qoder/admin/` 目前只有 `test/README.md`，`.qoder/docker/init/` 为空目录骨架。分母口径与实测依据见 `.qoder/PROJECT.md` §10。
