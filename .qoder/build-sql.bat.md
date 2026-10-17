# build-sql.bat

## 1. 文件路径

`build-sql.bat`（仓库根，33 行，LF 行尾，正文纯 ASCII）

## 2. 文件职责

把整个 `docker/init/` 目录打成发布产物 `sql.tar.gz`，供线上解压后补跑数据库迁移；打包后回显归档清单供人工过目。

## 3. 业务需求

`0bc0d54`（2026-10-16 20:59，提交信息「chore: 补交遗留的 SQL 打包脚本与 docker 提交规则」）新增。需求来源：

- 表结构的唯一执行来源是 `docker/init/*.sql`（`backend/AGENTS.md` §4「架构不变量」第 8 项），后端不自动建表，因此每次结构变更都要把迁移脚本送到服务器并执行；
- 根 `agents.md` §1.3 规定 `docker/` 目录改动**默认不随任务自动提交**，`021_ai_center.sql`、`022_ai_admin_menus.sql` 至今未入库（实测 `git status` 为 `??`），服务器上无法靠 `git pull` 取得这些文件——必须用打包上传的方式送达（`build-prod.bat:39-40` 正是这样向运维说明的）；
- 缺迁移已造成两次生产事故（`.qoder/PROJECT.md` §5「数据库迁移执行」的告警段），需要一条固定、可复核的打包路径。

同批提交还在 `.gitignore` 忽略了该产物、在根 `AGENTS.md` 写入了 `docker/` 不自动提交的规则（依据 `git show --stat 0bc0d54`：改动 `.gitignore`、`AGENTS.md`、`build-sql.bat` 三个文件）。

## 4. 核心功能

### 4.1 脚本骨架（`:1-3`）

`@echo off` + `setlocal`（未开延迟展开，本文件不需要）+ `cd /d "%~dp0"` 把工作目录钉在仓库根，因此 `:19` 的相对路径 `-C docker init` 与从何处调用无关。

### 4.2 目录预检（`:5-8`）

`if not exist docker\init` → 打印 `[x] docker\init directory not found` 并 `goto :fail`。

### 4.3 [1/3] SQL 文件存在性检查（`:10-15`）

`:11` `dir /b /a-d docker\init\*.sql >nul 2>&1`（`/b` 裸格式、`/a-d` 排除目录），`:12-15` `if errorlevel 1` → 打印 `[x] no *.sql found under docker\init` 并失败。即「目录里一个 `.sql` 都没有」才拦下，不校验编号连续性、不校验是否入库、不校验文件内容。

### 4.4 [2/3] 打包（`:17-20`）

`:18` 先删除已存在的 `sql.tar.gz`（非原子替换，见 §9 第 4 条）；`:19` `tar -czf sql.tar.gz -C docker init`——先切到 `docker/` 再打 `init`，因此归档内路径以 `init/` 为前缀（如 `init/021_ai_center.sql`），解压到仓库根即落回 `docker/init/`。`:20` `if errorlevel 1 goto :fail` 捕获 `tar` 失败（含 `tar` 不在 PATH 时的 9009）。

**打包范围是「`docker/init/` 目录的工作区全量内容」，没有白名单、不按 git 跟踪状态过滤**，因此：

- 22 个 `*.sql`（001→022，含**未入库**的 `021`、`022`）全部进包；
- `docker/init/init-db.sh` 与 `docker/init/SQL_CONSTRAINTS.md` 也一并进包（前者是服务器执行迁移所需的脚本本体）；
- 任何被误放进该目录的文件都会进包（见 §9 第 1 条）。

### 4.5 [3/3] 校验与清单回显（`:22-24`）

`:23` `tar -tzf sql.tar.gz >nul 2>&1 || goto :fail` 确认归档完整可读；`:24` `for /f "delims=" %%F in ('tar -tzf sql.tar.gz') do echo   %%F` 把归档内每一条路径缩进两格打印出来，供人工核对「该有的编号都在、不该有的东西没混进来」。**本脚本不做任何断言式校验**（对比 `build-backend.bat:26-37` 有「不得含 X」的中止逻辑）。

### 4.6 成功与失败出口（`:26-33`）

成功打印空行与 `done: %~dp0sql.tar.gz` 后 `exit /b 0`（`:26-28`）；`:30-33` 的 `:fail` 标号打印 `[x] packaging failed`、`pause`、`exit /b 1`。`exit /b` 保证被 `build-prod.bat:101` 以 `call` 调用时只结束本子过程。

## 5. 输入与输出

- **输入**：仓库根下 `docker/init/` 的**工作区实际内容**（含未跟踪文件）；Windows 内置 `tar`、`dir`。不读 `.env`、不连数据库、不执行任何 SQL。
- **输出**：仓库根的 `sql.tar.gz`，归档内路径前缀 `init/`；已被 `.gitignore:25` 忽略。stdout 为 `[1/3]`/`[2/3]`/`[3/3]` 步骤标记、逐条归档清单、`[x]` 失败标记与 `done:` 行。
- **退出码**：`0` 成功；`1` 失败（目录缺失、无 `.sql`、tar 失败、归档不可读）。失败时 `:32` 的 `pause` 等待按键。
- **实测规模**：`docs/迭代记录.md` 的 `f2a8939` 条目记录 `sql.tar.gz` **15945 B / 24 条目**，含 `init/021_ai_center.sql`、`init/022_ai_admin_menus.sql`。当前 `docker/init/` 下实测 24 个文件（22 个 `*.sql` + `SQL_CONSTRAINTS.md` + `init-db.sh`），与 24 条目数量吻合（归档是否另含 `init/` 目录条目未逐条核对）。

## 6. 依赖关系

- **被谁调用**：`build-prod.bat:101`（`call build-sql.bat`，随后 `:102` 检查 errorlevel、`:103-106` 检查产物存在、`:139-143` 断言 021/022 在包内）；也可单独执行。
- **打包对象**：`docker/init/*.sql`（001→022）、`docker/init/init-db.sh`、`docker/init/SQL_CONSTRAINTS.md`。
- **产物消费者**：服务器侧按 `build-prod.bat:153-154` 把 `sql.tar.gz` 解压覆盖到仓库检出上，再执行 `docker compose run --rm database-init`；实际执行迁移的是 `docker/init/init-db.sh`（机制见 `.qoder/docker/init/init-db.sh.md` §4.6），它依赖 `docker/compose.yml:44` 的 `./init:/docker/init:ro` 挂载读到这些文件。
- **同族文件**：`build-backend.bat`（打后端源码）、`admin/scripts/zip-dist.mjs`（产出 `admin/dist.zip`）。三者共同构成 `.qoder/PROJECT.md` §5「发布产物」表。
- **规则出处**：根 `agents.md` §1.3（`docker/` 不自动提交）与本脚本的存在互为因果——正因为迁移脚本可能不入库，才需要一个绕过 git 的送达通道。

## 7. 业务规则

1. **全量打包、不做白名单**：`:19` 打的是目录而非文件清单，因此未入库的迁移照样送达服务器（这是设计意图，`build-prod.bat:39-40` 依赖它）；代价是目录卫生完全靠人工（§9 第 1 条）。
2. **归档前缀必须是 `init/`**：由 `-C docker init` 决定，服务器侧「解压覆盖仓库检出」的指令（`build-prod.bat:153`）据此成立；改成 `-C docker/init .` 会丢前缀、解压到错误位置。
3. **包内 `.sql` 会在服务器被执行**：`init-db.sh:30` 遍历 `/docker/init/*.sql`，凡未在 `schema_migrations` 登记的都会被执行并登记。因此「进了包」等价于「下次补跑时会执行」。
4. **非 `.sql` 文件进包但不会被执行**：`init-db.sh:30` 的 glob 只匹配 `*.sql`，`SQL_CONSTRAINTS.md` 与 `init-db.sh` 本身对迁移循环是惰性的（但 `init-db.sh` 会覆盖服务器上的同名文件，见 §9 第 2 条）。
5. **编号即执行顺序**：包内文件按 `NNN_` 三位前缀的字典序执行，打包顺序无关。
6. **产物不入库**：`.gitignore:25`；按根 `agents.md` §1.3，`docker/` 的改动本身也不随任务自动提交。

## 8. 修改约束

1. **不得改成只打 `*.sql`**：`init-db.sh` 是服务器执行迁移的脚本本体，`build-prod.bat:153` 的「解压覆盖仓库检出」流程依赖包内同时带上它；若改为白名单打包，必须另行保证服务器上的 `init-db.sh` 与仓库一致。
2. **不得引入 git 过滤（如 `git ls-files`）**：那会让未入库的 `021`、`022` 从包中消失，直接破坏 `build-prod.bat:139-143` 的断言与生产补跑路径。若确要过滤，必须先解决 `docker/` 的入库策略（根 `agents.md` §1.3）。
3. **新增校验时不要使用 `findstr /e`**：行尾锚定对 `tar -tzf` 的管道输出不生效，`build-backend.bat:26` 已因此成为死检查（`.qoder/build-backend.bat.md` §9 第 1 条）；应用子串匹配或 `for /f` + 全等比较（参照 `build-prod.bat:132`）。
4. **括号块内的 echo 文本不得含 `)`**：`:13` 在 `( ... )` 块内，已避开；新增文案须继续遵守（`docs/迭代记录.md` 的 `f2a8939` 条目记录过该坑）。
5. **保持 `exit /b` 与 `setlocal`**：`build-prod.bat:101` 以 `call` 复用本脚本。
6. **正文保持纯 ASCII、行尾保持 LF**：实测非 ASCII 字节数 0、`git ls-files --eol` = `i/lf w/lf`（四个根级 `.bat` 中只有 `start.bat` 是 CRLF，cmd 两者都能解析）。
7. **产物名与 `.gitignore:25`、`build-prod.bat:8`/`:103`/`:111`/`:151` 绑定**，改名需同步。
8. **不得让本脚本连接数据库或执行 SQL**：它的职责边界是「打包」，执行由服务器侧 `database-init` 承担；越界会把开发机指向生产库的风险引进来（`.qoder/README.md` §3 第 12 条）。

## 9. 当前实现状态

- **已实现且在用**：作为 `build-prod.bat` 的 [5/6] 步被复用；`docs/迭代记录.md` 的 `f2a8939` 条目记录实测产出 15945 B / 24 条目并含 021/022。
- **存在问题 / 风险**：
  1. **目录卫生无守卫（最主要的真实风险）**：`:19` 全量打包 + `init-db.sh:30` 遍历 `*.sql` 执行，意味着任何被误放进 `docker/init/` 的 `.sql`（例如手工备份成 `021_ai_center_old.sql`、调试用的 `tmp.sql`）都会进包、上传生产、并在下次 `database-init` 时被**真实执行且登记进 `schema_migrations`**。本脚本 `:24` 只把清单打印出来靠人眼看，无任何断言。非 `.sql` 的杂项文件进包但不会被执行，风险较低。
  2. **包内 `init-db.sh` 会覆盖服务器副本，并把本机行尾带过去**：`build-prod.bat:153` 的指令是「解压覆盖仓库检出」，因此本机 `docker/init/init-db.sh` 的字节会落到服务器。该文件由容器内 bash 执行（`docker/compose.yml:42`），若本机检出为 CRLF，服务器上的脚本会因 `\r` 报无效选项名而失败。本机 `core.autocrlf=true` 且仓库**无 `.gitattributes`**，当前实测该文件为 LF（`git ls-files --eol` = `i/lf w/lf`）；是否曾在他机复现**待确认**。
  3. **无断言式校验**：`:23` 只验归档可读，「必须含 021/022」由调用方 `build-prod.bat:139-143` 保证；**单独运行本脚本时无人把关**，可能打出一个缺迁移的包而不自知。
  4. **非原子替换**：`:18` 先删旧包，`:19` 失败时旧包已不存在，无回退。
  5. **失败路径的 `pause`（`:32`）会阻塞父脚本**：被 `build-prod.bat:101` 以 `call` 调用时，失败会让发布流程停在按键等待上（`build-backend.bat:45` 同理）。
  6. **`:11` 的 `dir` 预检价值有限**：只区分「有没有 `.sql`」，无法发现编号断档、重复编号或空文件；这类问题要到服务器执行时才暴露。
  7. **同一归档被 `tar -tzf` 列举 2 次**（`:23`、`:24`）；产物仅约 16KB，耗时可忽略，属可优化项。
- **文档缺口**：本文件的创建提交 `0bc0d54` 在 `docs/迭代记录.md` 中**没有对应条目**（实测按提交号 grep 零命中），与根 `agents.md` §1.8「每完成一个任务并提交后必须立即追加记录」不符；本文件 §10 的需求/内容因此取自该提交的 commit message，验证结论标记为待确认。

## 10. 迭代记录

数据来源：`git log --follow --format='%h|%ad|%s' --date=short -- build-sql.bat`，共 **1 个提交**（创建后未再修改）。**注意 `docs/迭代记录.md` 无该提交的条目**（见 §9「文档缺口」）。

### 2026-10-16（`0bc0d54`，20:59）
- 需求：把 `docker/init` 打包成 `sql.tar.gz` 以便线上补跑迁移（取自提交信息；`docs/迭代记录.md` 无对应条目，原始需求文档**待确认**）。
- 修改内容：新建本文件（33 行）——目录预检、`*.sql` 存在性检查、`tar -czf sql.tar.gz -C docker init` 全量打包、归档可读性校验与清单逐条回显、`:fail` 出口。
- 关联文件：`.gitignore`（新增忽略 `sql.tar.gz`）、根 `AGENTS.md`（明确 `docker/` 改动默认不随任务自动提交）；依据 `git show --stat 0bc0d54`，该提交共改 3 个文件、新增 35 行。
- 测试结果：**待确认**——`docs/迭代记录.md` 无 `0bc0d54` 条目，提交信息中亦无验证记录。间接证据：`docs/迭代记录.md` 的 `f2a8939` 条目（2026-10-17）记录经 `build-prod.bat` 调用本脚本后实测产出 `sql.tar.gz` 15945 B / 24 条目、含 `init/021_ai_center.sql` 与 `init/022_ai_admin_menus.sql`，说明本脚本在次日可正常工作。

### 关联变更（未修改本文件）
- `f2a8939`（2026-10-17）新增 `build-prod.bat`，以 `call build-sql.bat`（`build-prod.bat:101`）复用本脚本，并在其 [6/6] 步补上本脚本缺失的断言式校验（`build-prod.bat:139-143` 要求 021/022 必须在包内）。
