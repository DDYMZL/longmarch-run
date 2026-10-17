# database.py

## 1. 文件路径
`backend/app/core/database.py`

## 2. 文件职责
数据库基础设施层：创建 SQLAlchemy 2.0 同步 engine 与 `SessionLocal` 会话工厂，声明 ORM 基类 `Base`，提供 FastAPI 请求级会话依赖 `get_db`；并针对 openGauss 的版本串解析问题对 PostgreSQL 方言打进程级 monkey-patch（`database.py:11-43`）。

## 3. 业务需求
- 全后端唯一的数据访问入口。项目数据库为 openGauss（兼容 PostgreSQL 协议，psycopg2 驱动），本地测试可用 SQLite，两条分支都要能跑（`:41-48`）。
- openGauss 的 libpq 兼容层把 `server_version_num` 报告为 `90204`（即 PostgreSQL 9.2.4），而 `version()` 返回 `openGauss x.y.z ...`，SQLAlchemy 的 PG 方言无法从该串解析版本，抛 `Could not determine version from string`（`:14-16` docstring 明确），不打补丁则无法建连——这是 `bceeb26`（数据库由 SQLite 切换为 openGauss）引入补丁的直接原因。
- 架构约定：表结构单一来源是 `docker/init/*.sql`，**后端禁止调用 `create_all`**（`backend/AGENTS.md` §4 不变量 8）——本文件初版含 `init_db()`（内部 `Base.metadata.create_all`），已在 `bceeb26` 中删除。

## 4. 核心功能

### 4.1 `_patch_opengauss_version()`（`:11-38`）
- `:30` 先保存原生 `PGDialect._get_server_version_info` 为 `original`。
- `:32-36` 替换实现：执行 `select pg_catalog.version()` 取版本串（`:33`），串中含 `openGauss` 时直接返回 `(9, 2, 4)`（`:34-35`），否则委托 `original` 走原生解析（`:36`）。
- `:38` 把替换函数赋回 `PGDialect._get_server_version_info`——**修改的是类方法，属进程级全局生效**。
- docstring（`:12-28`）完整记录背景、处理、风险与退出条件（见 §7、§8）。

### 4.2 补丁触发条件（`:41-43`）
仅当 `settings.DATABASE_URL.startswith("postgresql")` 时才调用 `_patch_opengauss_version()`（`:42-43`），SQLite（测试/本地）等其它方言不触碰（`:41` 注释）。该收敛由 `fc2597e` 引入，此前（`bceeb26`）为无条件调用。

### 4.3 engine 与 SessionLocal（`:45-51`）
- `:45-48` `_connect_args`：仅 SQLite 分支设 `{"check_same_thread": False}`（`:47` 注释：SQLite 默认禁用跨线程访问，FastAPI 多线程下需关闭该限制）；PostgreSQL 分支为空 dict。
- `:50` `engine = create_engine(settings.DATABASE_URL, connect_args=_connect_args, echo=False)`。**未配置任何连接池参数**，使用 SQLAlchemy 默认 QueuePool。
- `:51` `SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)`。`autoflush=False` 的影响在 `ai_config_service.py:221` 有注释说明（写入后需先 flush 才对随后读取可见）。

### 4.4 `Base`（`:54-55`）
`class Base(DeclarativeBase)`，所有 ORM 模型的基类；唯一消费方是 `models/models.py:28`（34 张表全部映射在它上面）。

### 4.5 `get_db()`（`:58-64`）
FastAPI 依赖注入用的生成器：`SessionLocal()` 建会话（`:60`）→ `yield db`（`:62`）→ `finally: db.close()`（`:63-64`）。**不做 commit、不做显式 rollback**；`close()` 归还连接并丢弃未提交的事务变更。

## 5. 输入与输出
- 输入：`settings.DATABASE_URL`（`core/config.py:34`，必填、无默认值）。
- 输出（模块级导出）：`engine`、`SessionLocal`、`Base`、`get_db`。
- 异常：本文件不抛业务异常。连接失败/版本解析失败等由 SQLAlchemy/psycopg2 在运行期抛出；`DATABASE_URL` 缺失则在 `core/config.py` 加载阶段即报 pydantic 校验错误（早于本模块执行）。
- 补丁副作用（`:24-26` docstring 明确）：伪造版本号 `(9, 2, 4)` 会让 SQLAlchemy 走 9.2 分支，**关闭窗口函数、`ON CONFLICT`、`JSONB` 去重等新特性的方言适配**。

## 6. 依赖关系
- **依赖**：`sqlalchemy`（`create_engine`、`PGDialect`、`DeclarativeBase`/`Session`/`sessionmaker`）、`app.core.config.settings`（`:4-8`）。
- **被依赖**：
  - `Base`：`models/models.py:28`（全部 ORM 模型）。
  - `get_db`：`api/deps.py:8`（重导出，作为 API 层统一入口）；18 个路由模块也直接 `from app.core.database import get_db`（`routes/admin.py:19`、`ai.py:13`、`ai_admin.py:16`、`auth.py:8`、`activity.py:5`、`broadcast.py:6`、`march.py:7`、`identity.py:12`、`medal.py:7`、`persons.py:6`、`org.py:9`、`profile.py:6`、`points.py:6`、`sport.py:9`、`rank.py:6`、`ws.py:11`、`quotes.py:8`、`quiz.py:9`）。
  - `SessionLocal`：`main.py:36`、`:44`（lifespan 启动钩子自建会话跑种子与重算）；`services/admin_service.py:19`、`:438`（流式 CSV 导出的独立 Session——**全项目唯一的服务层自建 Session 例外**，原因见 ARCHITECTURE.md §8.3：StreamingResponse 生成器在路由返回后才执行，届时 `get_db` 的 Session 已被关闭）。
  - `engine`：仅本文件内部使用（`:50-51`），backend/app 中无其它引用。
- **验证脚本**：`backend/test/s21_opengauss_compat.py`（`:28` docstring 指定的补丁回归脚本）。

## 7. 业务规则（事务边界约定）
- `get_db` 只提供会话、不提交。**谁 commit 分两种约定并存**（ARCHITECTURE.md §9.4）：
  1. 服务层自提交：多数业务 service 内部 `db.commit()`（如 `identity_service.py:158`、`auth_service.py:55`）；
  2. 路由层提交：service 只 `db.add()`/修改，由路由 `db.commit()`（审计写入约定，`services/audit_service.py:2-5` docstring 明确）。
- 修改代码前必须先确认目标 service 属于哪一种约定，重复 commit 或漏 commit 都会导致数据不一致。
- `autocommit=False, autoflush=False`（`:51`）：查询不会自动 flush 待写入变更，需要显式 `db.flush()`（参见 `sport_service.py:131`、`ai_config_service.py:221` 注释）。

## 8. 修改约束
- **禁止恢复 `create_all`/`init_db`**：表结构单一来源是 `docker/init/*.sql`（`backend/AGENTS.md` §4 不变量 8、§6.4 禁止行为）；`bceeb26` 已删除初版的 `init_db()`。
- **补丁退出条件**（`:27-28` docstring）：升级 SQLAlchemy 主版本后须回归验证，若官方方言已能解析 openGauss，应删除本补丁；验证脚本 `backend/test/s21_opengauss_compat.py`。
- **补丁收敛条件不得移除**（`:41-43`）：`startswith("postgresql")` 判断保证 SQLite 测试链路不受进程级全局改写影响（`fc2597e` 的整改结论）。
- 不得依赖被伪造版本关闭的方言特性：`ON CONFLICT` 不可用（`docker/init/SQL_CONSTRAINTS.md` 同口径）、SQLAlchemy 自动的窗口函数/JSONB 方言适配不可用；显式 `.over()` 窗口函数仍可用（ARCHITECTURE.md §12.5）。
- 服务层禁止自建 Session（`backend/AGENTS.md` §4 不变量 6），唯一例外是 `admin_service.py:438` 的流式导出，新增例外须对照该处说明理由。
- `get_db` 的 `finally: db.close()` 是会话不泄漏的保证，不得移除。

## 9. 当前实现状态
- 已实现：openGauss/SQLite 双方言支持、版本补丁及其作用域收敛、请求级会话依赖。
- 已知问题/现状记录：
  - 未配置连接池参数（`:50`），使用 SQLAlchemy 默认 QueuePool（池大小、超时均为库默认值）。
  - monkey-patch 属进程级全局修改，是 ARCHITECTURE.md §15 第 2 条架构级风险（升级 SQLAlchemy 可能失效或产生新行为），缓解手段为 `startswith("postgresql")` 收敛 + s21 回归脚本。
  - `engine` 无显式 `dispose` 流程；进程退出时连接由驱动回收（代码中无 shutdown 钩子，`main.py` lifespan `yield` 之后为空）。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/core/database.py`（3 个提交）与 `docs/迭代记录.md`，按时间倒序。

### 2026-10-13
- 需求：openGauss 兼容性整改——前期在生产/部署侧做的兼容处理同步回仓库，使本地成为可信源（提交 `fc2597e`）。
- 修改内容：补丁调用收敛为「仅 `DATABASE_URL` 为 postgresql 时生效」（`:41-43`），SQLite 等方言不再受全局改写影响；docstring 补充风险边界（伪造版本号关闭 9.2 之后方言特性适配）与升级 SQLAlchemy 后的验证指引（`:20-28`）。
- 关联文件：`core/config.py`（DATABASE_URL 必填化）、`backend/.env.example`、新增 `backend/test/s21_opengauss_compat.py`。
- 测试结果：S21 针对本地 docker openGauss（7.0.0-RC3，`server_version_num=90204`）4/4 通过；TestClient 启动健康检查 200；`DATABASE_URL=sqlite://` 时方言为 sqlite（补丁不触发）；S12 11/11 通过（`docs/迭代记录.md`）。

### 2026-10-01
- 需求：数据库由 SQLite 切换为 Docker 承载的 openGauss（提交 `bceeb26`）。
- 修改内容：新增 `_patch_opengauss_version()` 并无条件调用（openGauss 版本串无法被 SQLAlchemy PG 方言解析）；删除初版 `init_db()`（内部 `Base.metadata.create_all`），建表职责移交 `docker/init/*.sql`。
- 关联文件：`core/config.py`（DATABASE_URL 默认值改为 openGauss 连接串）、`docker/compose.yml`、`docker/init/`。
- 测试结果：待确认（`docs/迭代记录.md` 该条目只有内容摘要、未记录验证字段）。

### 2026-09-30
- 需求：项目初始化（提交 `a94e685`）。
- 修改内容：创建本文件：`engine`/`SessionLocal`（`autoflush=False, autocommit=False`）/`Base`/`get_db`，SQLite `check_same_thread=False` 分支；当时数据库为 SQLite（`DATABASE_URL` 默认 `sqlite:///./longmarch.db`），另含 `init_db()` 建表函数（后删除）。
- 关联文件：仓库初始代码（backend + frontend）。
- 测试结果：待确认（`docs/迭代记录.md` 该条目未记录验证字段）。
