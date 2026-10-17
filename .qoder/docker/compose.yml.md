# compose.yml

## 1. 文件路径

`docker/compose.yml`（47 行，LF 行尾）

## 2. 文件职责

定义**开发环境**的数据库栈：一个长驻的 openGauss 服务（容器内监听 5118、宿主映射 5118、数据落命名卷）与一个一次性的 `database-init` 服务（等库健康后执行 `init-db.sh` 跑迁移）。是本仓库唯一的 compose 文件，**不承担生产部署**。

## 3. 业务需求

由 `bceeb26`（2026-10-01）「数据库由 SQLite 切换为 Docker 承载的 openGauss」交付（`docs/迭代记录.md` 的 `bceeb26` 条目）。需求来源：后端 ORM/方言按 PostgreSQL 系设计，而项目数据库选型为 openGauss（`backend/AGENTS.md` §2「技术栈」表），开发者本机不装 openGauss，故用容器承载；同时 `backend/AGENTS.md` §4「架构不变量」第 8 项禁止应用自动建表，因此必须在 compose 里额外定义一个只负责跑 `docker/init/*.sql` 的一次性服务。

## 4. 核心功能

### 4.1 项目名（`:1`）

`name: longmarch`——compose 项目名，决定默认网络、命名卷与容器的前缀；`container_name`（`:6`）另行显式指定。

### 4.2 `opengauss` 服务（`:4-28`）

| 配置项 | 行 | 用途 |
| --- | --- | --- |
| `image` | `:5` | `opengauss/opengauss-server:latest`——**未固定版本标签**，见 §9 |
| `container_name` | `:6` | 固定容器名，便于 `docker logs`/`docker exec` |
| `privileged` | `:7` | 特权模式；openGauss 官方镜像初始化所需的宿主能力，开发专用（见 §8） |
| `restart` | `:8` | `unless-stopped`，Docker Desktop 重启后自动拉起 |
| `environment.GS_NODENAME` | `:10` | 数据库节点名 |
| `environment.GS_USERNAME` | `:11` | 镜像初始化时创建的管理/应用账号名 |
| `environment.GS_PASSWORD` | `:12` | 该账号口令，**明文硬编码**（见 §9 第 1 条） |
| `environment.GS_PORT` | `:13` | **容器内监听端口 5118**，不是 PostgreSQL 默认的 5432 |
| `ports` | `:14-15` | `5118:5118`，宿主端口与容器端口同号；后端 `backend/.env` 的连接串据此指向 `127.0.0.1:5118` |
| `volumes` | `:16-17` | 命名卷 `opengauss-data` 挂到 `/var/lib/opengauss`，数据跨容器重建保留；`docker compose down -v` 会销毁 |
| `healthcheck` | `:18-28` | 见 §4.3 |

### 4.3 健康检查（`:18-28`）

`CMD-SHELL` 在容器内以 `LD_LIBRARY_PATH=/usr/local/opengauss/lib` 调 `/usr/local/opengauss/bin/gsql`，连 `127.0.0.1:5118` 的 `postgres` 库执行 `SELECT 1` 并 `grep -q 1`。口令写作 `-W "$$GS_PASSWORD"`——`$$` 是 compose 的转义，使 `$GS_PASSWORD` **在容器内**由 shell 展开，而不是被 compose 在解析 YAML 时替换（`:23`）。节奏：`interval: 10s`、`timeout: 5s`、`retries: 20`、`start_period: 60s`（`:25-28`），即首次初始化最多约 60s 宽限 + 20 次重试。它是 `database-init` 的启动闸门。

### 4.4 `database-init` 一次性服务（`:30-44`）

| 配置项 | 行 | 用途 |
| --- | --- | --- |
| `image` | `:31` | 与 `:5` 同一镜像，只为取得 `gsql` 客户端 |
| `restart` | `:32` | `"no"`——跑完即退，不重启（引号是必需的，裸 `no` 会被 YAML 解析为布尔 false） |
| `depends_on` | `:33-35` | `opengauss: condition: service_healthy`，确保库可连后再跑迁移 |
| `environment.GS_HOST` | `:37` | 目标主机 = compose 服务名 `opengauss`（走 compose 默认网络的 DNS） |
| `environment.GS_PORT` | `:38` | 5118，与 `:13` 一致 |
| `environment.GS_USERNAME` / `GS_PASSWORD` | `:39-40` | 与 `:11`/`:12` **重复的第二份明文口令**（见 §9 第 1 条） |
| `environment.GS_DATABASE` | `:41` | 目标库名，受 `init-db.sh:4` 的白名单校验 |
| `entrypoint` | `:42` | `["/bin/bash", "/docker/init/init-db.sh"]`，覆盖镜像入口；显式用 bash 调用，故脚本的 shebang 与可执行位无关 |
| `volumes` | `:43-44` | `./init:/docker/init:ro`——把宿主机 `docker/init/` **只读**绑定挂载进容器 |

`:44` 的绑定挂载有两个直接后果：① 未被 git 跟踪的 `docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql` 照样会被执行（挂载看工作区、不看 git）；② 宿主机侧文件的行尾会原样进入容器内 bash（见 `.qoder/docker/init/init-db.sh.md` §9 第 5 条）。

### 4.5 命名卷声明（`:46-47`）

顶层 `volumes: opengauss-data:`，未指定 driver / external，使用 Docker 默认本地驱动。

### 4.6 未定义的内容

无 `networks` 段（使用默认 bridge 网络）、`database-init` 无 `container_name`、无资源限额、无 `profiles`；**没有生产环境的 compose 文件**——生产 openGauss 是 Ubuntu 上的 6.0.1、库 `longmarch`、端口 5432，不由本文件承载（`.qoder/ARCHITECTURE.md` §12.2「生产 openGauss」行）。

## 5. 输入与输出

- **输入**：本文件自身；宿主机 `docker/init/` 目录内容（`:44`）；镜像仓库中的 `opengauss/opengauss-server:latest`（`:5`、`:31`）。**不读取任何 `.env` 文件**，也没有 `${VAR}` 插值（唯一的 `$` 出现在 `:23`，且已被 `$$` 转义为容器内展开），因此 `docker compose config` 的输出与文件内容一致、不受宿主机环境变量影响。
- **输出/副作用**：创建并启动容器 `longmarch-opengauss` 与一个匿名 `database-init` 容器；创建命名卷 `opengauss-data` 与默认网络；在库内建库、建 `schema_migrations` 并执行迁移。
- **典型调用**：`start.bat:5` 把 `docker compose -f docker\compose.yml` 存进 `%COMPOSE%`，`:15` 执行 `up -d`，`:17` 用 `ps -a -q database-init` 取容器 id（`-a` 含已退出），`:20` 用 `docker wait` 取退出码；生产补跑用 `docker compose run --rm database-init`（`build-prod.bat:154`）。
- **失败模式**：Docker 未启动（`start.bat:14` 先 `docker info` 预检）；5118 端口被宿主其它进程占用；健康检查在 20 次重试后仍失败 → `database-init` 因 `depends_on` 永不启动；`init-db.sh` 非零退出 → `start.bat:21-25` 打印末 30 行日志并失败。

## 6. 依赖关系

- **被谁引用**：`start.bat:5`/`:15`/`:17`/`:23`/`:108`（本地一键启动与停止提示）；`build-prod.bat:154`（打印给运维的生产补跑指令）；`backend/AGENTS.md` §2「技术栈」表与 §6 第 5 条「验证」步骤、§7「快速启动」；`.qoder/PROJECT.md` §5「生产拓扑」与「数据库迁移执行」、`.qoder/ARCHITECTURE.md` §12.4「迁移执行机制」。
- **依赖**：`docker/init/init-db.sh`（`:42` 的 entrypoint）与 `docker/init/*.sql`（`:44` 挂载后被其遍历）；Docker Engine / Docker Desktop；`opengauss/opengauss-server` 镜像。
- **下游消费者**：`backend/app/core/database.py` 的 engine 按 `backend/.env` 的连接串连 `127.0.0.1:5118`（本地）；后端冒烟脚本同理。

## 7. 业务规则

1. **端口口径统一为 5118**：`:13`（容器监听）、`:15`（宿主映射）、`:23`（健康检查）、`:38`（迁移连接）四处必须同值；开发库端口与生产库（5432）不同，不可混用。
2. **迁移只由 `database-init` 执行**：`opengauss` 服务**没有**挂载 `./init`（`:16-17` 只有数据卷），镜像自带的初始化机制在本文件中不生效；首次建库建表与后续补跑走的都是 `init-db.sh`。`.qoder/ARCHITECTURE.md` §12.4「执行时机」行称「容器首次初始化时 openGauss 官方入口按字典序执行 `/docker/init` 下脚本」，与本文件不符（见 §9 第 5 条）。
3. **健康检查是迁移的前置闸门**：`depends_on: condition: service_healthy`（`:33-35`）保证不会在库未就绪时跑 DDL。
4. **数据持久化边界**：只有 `opengauss-data` 卷内的数据跨重建保留；`docker compose down -v`、删除卷或换机器都会得到空库，随后 `database-init` 会从 001 全量重跑（该场景从未实测，`.qoder/PROJECT.md` §10「待确认问题清单」第 3 条记录了「全新空库首次全量执行 001→022 只有推理、无实测」）。
5. **只读挂载**：`:44` 的 `:ro` 使容器内无法改写 `docker/init/`，迁移脚本与登记表是唯一的状态载体。
6. **口令为开发专用**：`:12`/`:40` 的口令只对本机容器有效，与生产库账号无关（生产应用账号非 `gaussdb`，`.qoder/ARCHITECTURE.md` §12.2「生产 openGauss」行）。

## 8. 修改约束

1. **改端口必须同改四处 + 后端配置**：`:13`、`:15`、`:23`、`:38`，以及 `backend/.env` 的连接串与 `.qoder/PROJECT.md` §4「端口与环境变量」。
2. **改口令必须同改两处**：`:12` 与 `:40`，以及 `backend/.env`；两处不一致会让 `database-init` 认证失败。
3. **不得把明文口令进一步扩散**：本文件已入库，新增配置项应优先用 `env_file`/变量插值而非再写一份字面量（`.qoder/README.md` §3 第 14 条）。
4. **不得把 `image` 标签换成固定版本或反过来随意 `docker pull`**：开发容器实测 7.0.0-RC3、生产 6.0.1，已存在版本偏斜；涉及 DDL 与方言的改动不能只靠开发库验证（`.qoder/ARCHITECTURE.md` §12.2「生产 openGauss」行、§12.5）。
5. **不得去掉 `privileged: true`（`:7`）而不重测**：openGauss 镜像初始化依赖它。
6. **不得把 `:44` 的绑定挂载改成构建期 COPY 或去掉 `:ro`**：前者会让未入库的 021/022 无法进入容器、也会固化行尾；后者失去对宿主机迁移目录的写保护。
7. **不得删除 `database-init` 服务**：它是开发环境唯一的建表通道（后端禁止 `create_all`），也是生产补跑指令 `docker compose run --rm database-init` 的目标。
8. **`restart: "no"`（`:32`）的引号不可省**：YAML 会把裸 `no` 解析成布尔值，compose 将报无效重启策略。
9. 按根 `agents.md` §1.3，`docker/` 目录改动**默认不随任务自动提交**，仅在用户明确要求时纳入并在提交信息中单独说明。

## 9. 当前实现状态

- **已实现且在用**：`docs/迭代记录.md` 的 `651efc8` 条目实测 `database-init` 退出码 0、迁移到 `022_ai_admin_menus.sql`；`start.bat` 与 `backend/AGENTS.md` §7「快速启动」均以本文件为入口。
- **存在问题 / 风险**：
  1. **明文硬编码口令**：`docker/compose.yml:12` 与 `docker/compose.yml:40` 各有一份 `GS_PASSWORD` 明文字面量（值不录入本文档），且该文件已入库、口令进入 git 历史。属开发库口令、不直接等同生产凭证，但与 `.qoder/README.md` §3 第 14 条「文档与仓库不得出现密码」的取向相悖；是否改为 `env_file` 由用户决定。
  2. **`image` 未固定标签**（`:5`、`:31`）：`latest` 会在任意一次 `docker pull`/换机时静默改变开发库大版本，与生产 6.0.1 的偏斜不可控。
  3. **口令重复两份**（`:12` vs `:40`）：无单一来源，改一处漏一处即认证失败。
  4. **`privileged: true`（`:7`）**：容器拥有近宿主权限，仅限本机开发使用；若把本文件挪作生产用途需重新评估。
  5. **`.qoder/ARCHITECTURE.md` §12.4「执行时机」行与本文件不符**：该行称首次初始化由 openGauss 官方入口执行 `/docker/init` 下脚本，但 `opengauss` 服务（`:4-28`）根本没有挂载 `./init`，只有 `database-init`（`:44`）挂载并以 `init-db.sh` 执行；首次建库同样出自 `database-init`。**待用户在总览文档更正**（本任务不改总览文档）。
  6. **无资源限额、无网络定义**：多服务共存时端口/资源冲突需人工排查（5118 被占用是最常见的启动失败原因）。
  7. **生产不由本文件承载**：`build-prod.bat:154` 打印的 `docker compose run --rm database-init` 前提是服务器上存在同名 compose 文件与同样的服务定义；服务器侧是否有本文件的副本、路径为何**待确认**（`.qoder/PROJECT.md` §10「待确认问题清单」第 2 条「仍未核实」项）。

## 10. 迭代记录

数据来源：`git log --follow --format='%h|%ad|%s' --date=short -- docker/compose.yml`，共 **1 个提交**（创建后未再修改）。

### 2026-10-01（`bceeb26`，10:26）
- 需求：数据库由 SQLite 切换为 Docker 承载的 openGauss，本机开发需要一键起库并自动建表。
- 修改内容：新建本文件（47 行）——`opengauss` 长驻服务（5118 端口、命名卷、gsql 健康检查）+ `database-init` 一次性服务（`service_healthy` 闸门、只读挂载 `./init`、entrypoint 指向 `init-db.sh`）+ 顶层命名卷声明。
- 关联文件：`docker/init/init-db.sh`（同批新建）、`docker/init/001_schema.sql` 等迁移脚本、`backend/app/core/database.py`、`backend/.env`。
- 测试结果：见 `docs/迭代记录.md` 的 `bceeb26` 条目（内容仅一句「切换为 Docker 承载的 openGauss」，无 compose 级验证记录）；实际可用性由 `docs/迭代记录.md` 的 `8d63b6f`（`start.bat` 起库、`database-init` 退出码 0）与 `651efc8`（迁移至 022）两条间接验证。
