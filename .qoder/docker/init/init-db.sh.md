# init-db.sh

## 1. 文件路径

`docker/init/init-db.sh`（37 行，LF 行尾）

## 2. 文件职责

数据库迁移的唯一执行器：在 openGauss 容器内建库、建 `schema_migrations` 登记表，并按文件名字典序把 `/docker/init/*.sql` 中**尚未登记**的脚本逐个执行、成功后登记版本号。开发环境与生产补跑共用同一套机制。

## 3. 业务需求

由 `bceeb26`（2026-10-01）「数据库由 SQLite 切换为 Docker 承载的 openGauss」一并交付（`docs/迭代记录.md` 的 `bceeb26` 条目）。需求来源：

- 后端禁止在启动流程调用 `Base.metadata.create_all`（`backend/AGENTS.md` §4「架构不变量」第 8 项「表结构单一来源」），因此必须有独立于应用的建表与迁移通道；
- 生产库已存在、只能增量补跑，且已发布脚本不得修改（`docker/init/SQL_CONSTRAINTS.md`），因此需要「跳过已执行编号」的登记机制；
- 缺迁移已造成两次生产事故（缺 019 → `/api/sport/today` 500；缺 020 → 启动崩溃），使「补跑」成为常规运维动作，见 `.qoder/PROJECT.md` §5「数据库迁移执行」的告警段。

## 4. 核心功能

### 4.1 运行前提与失败即停（`:1-2`）

`#!/usr/bin/env bash` + `set -euo pipefail`：任一命令非零退出、引用未定义变量、管道任一段失败都立即终止。实际由 `docker/compose.yml:42` 以 `["/bin/bash", "/docker/init/init-db.sh"]` 显式调用，因此 `:1` 的 shebang 与文件可执行位都不参与执行。

### 4.2 库名白名单校验（`:4-7`）

`[[ ! "${GS_DATABASE}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]` 不通过则向 stderr 打印 `Invalid database name: <名>` 并 `exit 1`。这是给后续把 `${GS_DATABASE}` 直接拼进 SQL 文本（`:20`、`:21`、`:24`）的唯一防线——白名单排除了引号、分号与空格。`GS_DATABASE` 未设置时由 `set -u` 先以 unbound variable 退出。

### 4.3 gsql 客户端封装（`:9`、`:11-18`）

`:9` 导出 `LD_LIBRARY_PATH=/usr/local/opengauss/lib`（容器内 gsql 的动态库路径，与 `docker/compose.yml:22` 健康检查里的写法一致）。`:11-18` 组装 bash 数组 `GSQL`：`/usr/local/opengauss/bin/gsql` + `-h $GS_HOST` + `-p $GS_PORT` + `-U $GS_USERNAME` + `-W $GS_PASSWORD`（openGauss 的 gsql 用 `-W` 直接传口令，非交互式）+ `-v ON_ERROR_STOP=1`（SQL 报错即让 gsql 非零退出，配合 `set -e` 中断整批迁移）。四个 `GS_*` 变量全部由 `docker/compose.yml:36-41` 注入，脚本自身不含任何连接信息。

### 4.4 幂等建库（`:20-22`）

连 `-d postgres`，以 `-t -A`（只输出值、无对齐）执行 `SELECT COUNT(*) FROM pg_database WHERE datname = '<库名>'`，结果为字符串 `0` 时才 `CREATE DATABASE <库名>`。对已存在的库重复运行是 no-op。

### 4.5 幂等建登记表（`:24-28`）

在目标库执行 `CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`。`version` 存**完整文件名（含 `.sql` 后缀）**，`applied_at` 由库端默认值填充。

### 4.6 迁移主循环（`:30-37`）

`for sql_file in /docker/init/*.sql`：

1. `:31` `version="$(basename "${sql_file}")"`——版本号即文件名（如 `021_ai_center.sql`）；
2. `:32` 以 `-t -A` 查 `schema_migrations` 中该 version 的计数；
3. `:33-36` 计数为 `0` 时才 `gsql -f <文件>` 执行，随后 `INSERT INTO schema_migrations (version) VALUES ('<文件名>')` 登记。

`/docker/init` 是**容器内路径**，由 `docker/compose.yml:44` 的 `./init:/docker/init:ro` 绑定挂载提供，故本脚本只能在容器内运行，不能在 Windows 宿主机直接执行。bash glob 展开为字典序，配合 `NNN_` 三位前缀即得到 001→022 的执行顺序（`.qoder/PROJECT.md` §5「数据库迁移执行」）。

## 5. 输入与输出

- **输入（环境变量，均由 `docker/compose.yml:36-41` 注入）**：`GS_HOST`（目标主机，compose 服务名）、`GS_PORT`、`GS_USERNAME`、`GS_PASSWORD`、`GS_DATABASE`（目标库名，受 `:4` 白名单约束）。
- **输入（文件）**：容器内 `/docker/init/*.sql` 全量，**含未被 git 跟踪的文件**（挂载的是宿主机工作区目录，与 git 状态无关）。
- **输出**：目标库的表结构与数据变更；`schema_migrations` 新增行；stdout/stderr 为 gsql 执行回显。
- **退出码**：`0` 全部成功；`1` 库名非法（`:6`）；其余非零由 `set -e` 触发（连接失败、SQL 报错、`CREATE DATABASE` 失败等）。`start.bat:19-25` 正是以 `docker wait` 取回的退出码是否为 0 判定成败。
- **失败语义**：`:32` 查询失败会使该赋值语句非零退出，脚本在**登记之前**中止，不会把未执行的文件误登记。

## 6. 依赖关系

- **被谁调用**：`docker/compose.yml:42`（`database-init` 服务的 entrypoint）；触发方式为 `start.bat:15` 的 `docker compose up -d`，或运维按 `build-prod.bat:153-154` 打印的指令执行 `docker compose run --rm database-init`。
- **依赖**：镜像 `opengauss/opengauss-server:latest` 提供的 `/usr/local/opengauss/bin/gsql` 及其 lib 目录（`docker/compose.yml:5`、`:31`）；`opengauss` 服务健康（`docker/compose.yml:33-35` 的 `condition: service_healthy`）；`docker/init/*.sql` 全部迁移脚本；`docker/init/SQL_CONSTRAINTS.md` 规定的编写约束（幂等、事务包裹、三段式头注释、已发布脚本不得修改）。
- **写库对象**：`pg_database`（只读查询）、目标库的 `schema_migrations`，以及各迁移脚本涉及的全部表。
- **不依赖后端代码**：FastAPI 启动只做幂等种子写入（`backend/app/main.py` 的 lifespan），不建表。

## 7. 业务规则

1. **登记即跳过**：`schema_migrations.version` 存在则整个文件不再执行，重跑 `database-init` 安全。
2. **版本号 = 完整文件名（含 `.sql`）**：`build-prod.bat:157` 打印的核对文案写作「must list 021_ai_center and 022_ai_admin_menus」，库中实际值为 `021_ai_center.sql`、`022_ai_admin_menus.sql`（见 §9 第 4 条）。
3. **执行与登记不是同一事务**：`:34` 成功而 `:35` 失败（如连接中断）会留下「已执行未登记」状态，下次重跑会**再执行一次**。因此迁移脚本自身必须幂等；而 `017`、`019` 含重算类 UPDATE、**不可重复执行**（`.qoder/ARCHITECTURE.md` §12.4「历史包袱」段），这是本机制最主要的残留风险。
4. **手工 `gsql -f` 后必须回填登记表**，否则下次自动重跑（`.qoder/PROJECT.md` §5「数据库迁移执行」）。
5. **字典序即执行序**：新增迁移必须沿用 `NNN_` 三位递增前缀；两位或四位前缀会打乱顺序。
6. **文件名不得含单引号**：`:32`、`:35` 把 `${version}` 直接拼进单引号 SQL 字面量且未转义。现有 22 个文件名均只含 `[0-9a-z_.]`，规则事实上成立但无代码强制。
7. **只增不改**：已在生产执行过的编号脚本禁止修改，结构变更只能新增编号。

## 8. 修改约束

1. **不得把库名/口令写进本文件**：四个 `GS_*` 必须继续由 compose 注入，脚本内不得出现明文连接信息（`.qoder/README.md` §3 第 14 条）。
2. **不得放宽 `:4` 的库名白名单**：它是 `:20-24` 拼接 SQL 的唯一防线。
3. **不得去掉 `-v ON_ERROR_STOP=1`（`:17`）或 `set -euo pipefail`（`:2`）**：去掉后单个 SQL 失败会被吞掉而脚本仍登记版本号，造成「表没建成却记为已迁移」的静默缺口，正是两次生产事故的形态。
4. **不得改动 `/docker/init` 路径**，除非同步改 `docker/compose.yml:44` 的挂载点。
5. **改动同时影响开发与生产**：生产 openGauss 为 6.0.1、开发容器为 `latest`（实测 7.0.0-RC3），存在版本偏斜（`.qoder/ARCHITECTURE.md` §12.2「生产 openGauss」行），涉及 gsql 参数或系统表查询的改动不能只在开发库验证。
6. **行尾必须保持 LF**：本文件由容器内 bash 解释，而 compose 挂载的是宿主机工作区副本（详见 §9 第 5 条）。
7. 按根 `agents.md` §1.3，`docker/` 目录改动**默认不随任务自动提交**，仅在用户明确要求时纳入。

## 9. 当前实现状态

- **已实现且在用**：`docs/迭代记录.md` 的 `651efc8` 条目记录 `database-init` 退出码 0、提示最高迁移为 `022_ai_admin_menus.sql`；`f2a8939` 条目记录本地 openGauss 已应用并登记 021/022。
- **存在问题 / 风险**：
  1. **执行与登记非原子**（`:34-35`）：见 §7 第 3 条，对 `017`、`019` 这类非幂等脚本是真实风险。
  2. **无失败记录**：`schema_migrations` 只登记成功项，无法从库端看出某编号曾失败过。
  3. **glob 无匹配时不报错而拼字面量**：`:30` 若无匹配，bash 默认把字面量 `/docker/init/*.sql` 交给循环，`:34` 的 `gsql -f` 因文件不存在而失败 → `set -e` 中止。表现为「文件不存在」而非「无迁移可跑」，属可读性问题，不影响正确性。
  4. **`build-prod.bat:157` 的核对文案与实际登记值不一致**（漏 `.sql` 后缀）；不影响脚本本身，属发布手册文案待更正项。
  5. **行尾风险（是否已在他机复现：待确认）**：本文件在仓库与工作区均为 LF，但仓库 `core.autocrlf=true` 且**无 `.gitattributes`**（实测 `git ls-files --eol docker/init/init-db.sh` = `i/lf w/lf attr/`）。全新克隆的 Windows 机器检出可能得到 CRLF，而 `docker/compose.yml:44` 挂载的正是这份工作区副本，容器内 bash 读到 `set -euo pipefail` 后跟 CR 会报无效选项名而使 `database-init` 失败。当前工作区为 LF、本机未复现。
  6. **生产库缺 021/022**：两文件按根 `agents.md` §1.3 未入库（实测 `git status` 为 `?? docker/init/021_ai_center.sql`、`?? docker/init/022_ai_admin_menus.sql`），生产库因此尚未执行这两个迁移，须靠 `sql.tar.gz` 上传后补跑（`.qoder/ARCHITECTURE.md` §12.4「生产迁移缺口」段）。
  7. **迁移覆盖度依赖宿主机目录内容**：`:30` 遍历挂载目录而非 git 清单，任何被误放进 `docker/init/` 的 `.sql`（备份、临时文件）都会在下次 `database-init` 时被执行并登记。

## 10. 迭代记录

数据来源：`git log --follow --format='%h|%ad|%s' --date=short -- docker/init/init-db.sh`，共 **1 个提交**（创建后未再修改）。

### 2026-10-01（`bceeb26`，10:26）
- 需求：数据库由 SQLite 切换为 Docker 承载的 openGauss，需要独立于应用启动的建库与迁移执行通道（后端禁止 `create_all`）。
- 修改内容：新建本文件（37 行）——库名白名单校验、gsql 数组封装（`ON_ERROR_STOP=1`）、幂等建库、`schema_migrations` 登记表、按字典序跳过已登记项的迁移主循环；同批由 `docker/compose.yml` 新增的 `database-init` 一次性服务承载。
- 关联文件：`docker/compose.yml`、`docker/init/001_schema.sql` 等全部迁移脚本、`backend/app/core/database.py`。
- 测试结果：`docs/迭代记录.md` 的 `bceeb26` 条目仅记「切换为 Docker 承载的 openGauss」，无本脚本的单独验证记录；可用性由后续 `docs/迭代记录.md` 的 `651efc8` 条目（`database-init` 退出码 0、最高迁移 022）间接验证。
