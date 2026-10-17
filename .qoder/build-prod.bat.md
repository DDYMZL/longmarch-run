# build-prod.bat

## 1. 文件路径

`build-prod.bat`（仓库根，183 行，LF 行尾，正文纯 ASCII）

## 2. 文件职责

一键生成三件发布产物（`admin\dist.zip`、`backend-update.tar.gz`、`sql.tar.gz`），并在打包前后做发布预检与产物内容校验，最后打印服务器侧执行顺序与冒烟判据。**只产出与校验，不代执行任何服务器侧或对外可见动作。**

## 3. 业务需求

`f2a8939`（2026-10-17 14:14）新增（`docs/迭代记录.md` 的 `f2a8939` 条目）。起因是排查「本地运行为何仍打生产 `/api/ai/chat`」时暴露的一串发布风险：

- 生产端当时没有 AI 路由（`/api/ai/*` 404），而 `docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql` 按根 `agents.md` §1.3 未入库、服务器上不存在这两个文件；
- 发布动作分散在 `build-backend.bat`、`build-sql.bat`、`admin npm run build` 与人工核对之间，容易漏跑迁移，或把 `backend/.env.prod` 里的占位符覆盖掉服务器上的真实值；
- 仓库副本的 `.env.prod` 仍带 `REPLACE_WITH_*` 占位符（`.qoder/ARCHITECTURE.md` §12.2「`.env.prod` 占位符现状」行：`JWT_SECRET` 仍是占位值），而该文件会被打进 `backend-update.tar.gz`。

因此需要一个把「预检 → 构建 → 校验 → 发布手册」串成一条命令的脚本。**明确不做的事**（同条目「内容」段）：不代执行服务器侧步骤——进程管理方式、生产 openGauss 版本与端口、nginx 配置位置在 `.qoder/PROJECT.md` §5 标为待确认，仓库内也无 SSH 信息；小程序上传也不自动执行（对外可见动作且需人工定版本号），只打印 `cli.bat upload` 命令。

## 4. 核心功能

### 4.1 脚本骨架（`:1-10`）

`@echo off` + `setlocal enabledelayedexpansion`（`:2`，括号块内需要 `!VAR!` 运行期展开）+ `cd /d "%~dp0"`（`:3`）+ `set "ROOT=%~dp0"`（`:4`，供 `:147`、`:172` 打印绝对路径）。`:6-10` 打印横幅并声明三件产物名。

### 4.2 [1/6] git 状态预检（`:12-42`）

- `:13-16` `git rev-parse --is-inside-work-tree`；不可用时打印 `[WARN] git not available, checks skipped` 并**跳过整个 [1/6]**（不失败）。
- `:17-23` `for /f` 遍历 `git status --porcelain` 输出，首次命中打印 `uncommitted changes:` 表头、置 `DIRTY`，逐行回显；全空则打印 `working tree clean`。
- `:25-33` `git rev-list --count "@{u}..HEAD"`（`:26`，`2^>nul` 为 for /f 内的重定向转义）取未推送提交数：无上游分支 → `[WARN] no upstream branch, cannot tell what is unpushed`（`:28`）；计数为 0 → `all local commits pushed`（`:30`）；否则 `[WARN] !AHEAD! local commits NOT pushed to remote`（`:32`，此处必须用延迟展开）。
- `:35-38` 用 `git ls-files --error-unmatch` 分别检查 `docker/init/021_ai_center.sql` 与 `022_ai_admin_menus.sql` 是否被 git 跟踪，未跟踪各打印一条 `[WARN] ... is NOT tracked by git`。
- `:39-40` 说明这两条告警的含义：未入库的迁移无法通过 `git pull` 到达服务器，但它们**仍在下面的 `sql.tar.gz` 里**，所以上传那个包即可。

### 4.3 [2/6] `backend\.env.prod` 预检（`:44-65`）

- `:45-48` 文件不存在 → `[x] backend\.env.prod not found`，硬失败（它必须进包，见 `:127-128`）。
- `:49-50` `findstr /r /c:"^CLOUDBASE_API_KEY=..*"`（要求 `=` 后至少一个字符）未命中 → `[WARN] CLOUDBASE_API_KEY is empty - AI endpoints will answer 403`。
- `:51-62` `findstr /c:"REPLACE_WITH"` 命中则：打印告警、用 `findstr /n` 列出命中行号与内容（`:54`）、说明该文件会被打进 `backend-update.tar.gz` 故占位符会覆盖服务器真实值（`:55-56`），然后 `set /p "CONT=   build anyway? y/N : "`（`:58`）交互确认，`if /i not "!CONT!"=="y" goto :fail`（`:59`）；未命中则打印 `no REPLACE_WITH placeholders`（`:61`）。
- `:63-64` `findstr /r /c:"^AI_ENABLED=false"` 命中 → `[WARN] AI_ENABLED=false - AI center is switched off in this build`。

### 4.4 [3/6] 管理后台构建（`:67-89`）

`:68-72` `where npm` 预检（缺失即硬失败）；`:73-79` 无 `admin\node_modules` 时 `pushd admin` + `call npm install`（`:77` 的 `if errorlevel 1 ( popd & goto :fail )` 保证目录栈不泄漏）；`:80-83` `call npm run build`；`:84-87` 校验 `admin\dist.zip` 已产出（该 zip 由 `admin/package.json:9` 的 `build` 脚本末段 `node scripts/zip-dist.mjs` 生成，不是 vite 的产物）；`:88` 打印 ok。

### 4.5 [4/6][5/6] 复用两个打包脚本（`:91-107`）

`:92` `call build-backend.bat` + `:93` errorlevel 检查 + `:94-97` 产物存在性检查；`:101` `call build-sql.bat` + `:102`、`:103-106` 同上。子脚本失败时其自身的 `pause` 会先阻塞（见 §9 第 6 条）。

### 4.6 [6/6] 产物校验（`:109-143`）

- `:110-119` 遍历三件产物，存在则打印 `ok <名> <字节数> <修改时间>`（`%%~zA`/`%%~tA`），缺失则打印 `[x] missing` 并置 `MISSING`，`:119` 统一失败。
- `:121-129` 用 `tar -tzf backend-update.tar.gz | findstr /c:"<路径>"` **子串**匹配，逐个要求包内含 `backend/app/api/routes/ai.py`、`ai_admin.py`、`app/services/ai_chat_service.py`、`backend/.env.prod`，全通过后打印 `ok backend package carries AI routes/services and .env.prod`。
- `:131-137` `.env` 泄漏检查：`for /f "delims=" %%E in ('tar -tzf backend-update.tar.gz') do if "%%E"=="backend/.env" set "LEAK=1"`——**整行全等**比较，因此既不会漏掉 `backend/.env`，也不会把 `backend/.env.prod` 误判为泄漏；命中即 `[x] local backend/.env leaked into the package - it holds dev secrets` 并失败，否则打印 ok。这是 `build-backend.bat:26` 那条失效守卫的有效替代。
- `:139-143` 用子串匹配要求 `sql.tar.gz` 内含 `init/021_ai_center.sql` 与 `init/022_ai_admin_menus.sql`，通过后打印 `ok sql package carries migrations 021/022`。

### 4.7 成功横幅与服务器侧手册（`:146-176`）

`:146-148` `BUILD OK` + 产物目录；`:149-175` 以 echo 打印 5 步运维顺序（**只打印、不执行**）：

1. `:151` 上传三件产物；
2. `:153-158` 迁移——把 `sql.tar.gz` 解压覆盖到服务器的仓库检出上，然后 `docker compose run --rm database-init`；说明它只跑 `schema_migrations` 中缺失的版本；核对语句 `SELECT version FROM schema_migrations ORDER BY version;`，并提示 DDL 前确认没有 idle-in-transaction 会话阻塞；
3. `:160-166` 后端——解压 `backend-update.tar.gz`，把 `.env.prod` 与线上副本比对，**保留服务器真实的 `DATABASE_URL` / `JWT_SECRET` / `ADMIN_PASSWORD`**，不要用仓库占位符覆盖；说明 `APP_ENV=prod` 来自 service unit 而非 `.env`；重启后端后用 `curl -o /dev/null -w "%%{http_code}\n"`（`:165`，批处理内 `%` 需写成 `%%`）打 `/api/ai/conversations`，期望 **401**，出现 **404 说明新代码没跑起来**；
4. `:168-169` 管理后台——把 `admin\dist.zip` 解压进 nginx web 根（zip 根即 `index.html` + `assets/`）；
5. `:171-175` 小程序——微信开发者工具的上传按钮或其 CLI `cli.bat upload --project "%ROOT%." -v VERSION -d "release note"`；说明无需改配置，trial/release 恒连已部署后端（依据 `frontend\services\config.js`），且**必须在第 3 步返回 401 之后**再做。

`:177` `exit /b 0`；`:179-183` `:fail` 标号打印 `[x] release build failed`、`pause`、`exit /b 1`。

## 5. 输入与输出

- **输入**：仓库工作区（`admin/`、`backend/`、`docker/init/`）；`backend\.env.prod`（只读校验，不修改）；`git` 仓库状态与上游分支；`npm`、`tar`、`findstr`、`git` 四个外部命令；**交互输入一处**——`:58` 的 `y/N` 确认。
- **输出**：仓库根的 `admin\dist.zip`、`backend-update.tar.gz`、`sql.tar.gz`（三者分别被 `.gitignore:21`、`:24`、`:25` 忽略）；stdout 为 `[n/6]` 步骤标记、`ok`/`[WARN]`/`[x]` 结论行、产物字节数与修改时间、以及末尾的运维手册。
- **退出码**：`0` 全部通过；`1` 任一硬失败（`.env.prod` 缺失、用户在 `:59` 未输入 y、npm/tar 缺失或构建失败、子脚本失败、产物缺失、内容校验未命中、`.env` 泄漏）。`[WARN]` 一律**不**影响退出码。
- **实测规模**：`docs/迭代记录.md` 的 `f2a8939` 条目「验证」段——`admin/dist.zip` 538153 B（vue-tsc 无错、vite 21.99s、zip-dist 36 文件 525.5 KB）、`backend-update.tar.gz` 183587 B（84 条目）、`sql.tar.gz` 15945 B（24 条目，含 021/022）。
- **副作用**：`:76` 可能安装 `admin/node_modules`；`:81` 会重建 `admin/dist/`；`:92`/`:101` 会删除并重新生成两个 tar 包。不触碰数据库、不触碰服务器、不上传小程序。

## 6. 依赖关系

- **调用**：`build-backend.bat`（`:92`）、`build-sql.bat`（`:101`）、`admin/package.json:9` 的 `build` 脚本（`:81`，其末段调 `admin/scripts/zip-dist.mjs` 产出 `admin/dist.zip`）、`git`、`npm`、`tar`、`findstr`。
- **被谁引用**：`start.bat:107` 的收尾提示 `Release build: build-prod.bat`；`.qoder/PROJECT.md` §5「发布产物」表（三件产物的生成方式）。
- **校验对象来自**：`backend/app/api/routes/ai.py`、`backend/app/api/routes/ai_admin.py`、`backend/app/services/ai_chat_service.py`、`backend/.env.prod`、`docker/init/021_ai_center.sql`、`docker/init/022_ai_admin_menus.sql`。
- **产物的下游**：服务器侧 systemd 服务 `longmarch-backend`（解压后端包后重启）、nginx web 根（解压 admin zip）、`docker compose run --rm database-init`（解压 sql 包后跑迁移），拓扑见 `.qoder/ARCHITECTURE.md` §12.1。
- **与 `start.bat` 的分工**：`start.bat` 起本地开发环境，本脚本出发布产物，两者都不代执行服务器侧步骤（`docs/迭代记录.md` 的 `651efc8` 条目「备注」）。

## 7. 业务规则

1. **`[WARN]` 不阻断、`[x]` 阻断**：git 脏工作区、未推送提交、021/022 未入库、`CLOUDBASE_API_KEY` 为空、`AI_ENABLED=false` 都只告警；`.env.prod` 缺失、npm 缺失、构建/打包失败、产物缺失、内容校验未命中、`.env` 泄漏都硬失败。唯一需要人工裁决的是 `REPLACE_WITH` 占位符（`:51-59`）。
2. **`.env.prod` 必须入包、`.env` 必须不入包**：前者由 `:127-128` 正向校验，后者由 `:131-137` 反向校验。这条不对称是有意的——生产配置随包上线，开发凭证绝不上线。
3. **发布顺序不可颠倒**：`:175` 明确小程序上传必须在后端冒烟返回 401 之后，否则会把指向 404 接口的小程序发出去。
4. **占位符不得覆盖服务器真实值**：`:55-56`、`:160-163` 两处反复强调；`APP_ENV=prod` 由 systemd 单元提供，写进 `.env` 不生效（`.qoder/ARCHITECTURE.md` §12.2「后端环境切换」行）。
5. **冒烟判据是状态码而非响应体**：`/api/ai/conversations` 期望 401（路由存在但未带 token），404 即代表旧代码仍在服务（`:166`）。本地对应判据见 `start.bat:138-141`。
6. **迁移补跑靠 `schema_migrations`**：`:155` 声明 `database-init` 只跑缺失版本，机制见 `.qoder/docker/init/init-db.sh.md` §4.6。
7. **版本号与发布说明由人工给定**：`:172` 的 `-v VERSION -d "release note"` 是占位写法，脚本不推断版本号、不读 git tag。

## 8. 修改约束

1. **批处理三坑必须继续遵守**（`docs/迭代记录.md` 的 `f2a8939` 条目「验证」段记录了调试中修掉的三个坑）：
   - `:2` 开了 `enabledelayedexpansion`，正文里**不得出现 `!`**（会被当变量定界符），故告警标记统一用 `[WARN]`（`:15`、`:28`、`:32`、`:36`、`:38`、`:50`、`:53`、`:64`）；实测四个根级 `.bat` 中 `[!]` 零命中。
   - **括号块内的 echo 文本不得含 `)`**，`set /p` 提示语同理——`:58` 的提示写作 `build anyway? y/N :` 而非 `(y/N)`；`:169` 的 `(zip root already is index.html + assets/).` 含括号但处于**顶层** echo（不在 `( ... )` 块内），故安全。
   - **`findstr` 不要用 `/e` 行尾锚定去匹配 `tar -tzf` 的管道输出**：`:121-128`、`:139-142` 一律用子串匹配，`:132` 用 `for /f` + 全等比较。新增校验不得回退到 `/e`。
2. **`%%` 转义不可省**：`:113` 的 `%%F`/`%%A`、`:165` 的 `%%{http_code}`、`:26` 的 `2^>nul` 都是批处理/for 语境的转义，改动时逐个核对。
3. **保持 `call` 调用子脚本 + `exit /b`**：`:92`、`:101` 用 `call`，`:177`、`:183` 用 `exit /b`，否则子脚本会终止整个会话。
4. **不得让脚本代执行服务器侧或对外动作**：`:149-175` 只能是 echo。新增 SSH/SCP/小程序上传会破坏「仓库内无生产凭证、对外动作需人工确认」的前提（§3）。
5. **硬编码清单需随代码演进维护**：`:35-38` 的迁移文件名、`:121-128` 的三个 AI 文件路径都是写死的白名单（见 §9 第 2 条）；新增同类文件时必须同步，否则校验会「通过但没覆盖」。
6. **正文保持纯 ASCII**：实测非 ASCII 字节数为 0，中文说明放 `docs/`。行尾为 LF（`git ls-files --eol` = `i/lf w/lf`），与 `start.bat` 的 CRLF 不同，cmd 两者都能解析。
7. **产物名与 `.gitignore` 绑定**：`:8`、`:84`、`:94`、`:103`、`:111`、`:151` 多处引用三个产物名，改名需同步 `.gitignore:21`/`:24`/`:25` 与 `.qoder/PROJECT.md` §5「发布产物」表。
8. **不得在本文件中打印 `.env.prod` 的真实值**：`:54` 只打印命中 `REPLACE_WITH` 的行（占位符行），新增校验不得扩大成整文件回显（`.qoder/README.md` §3 第 14 条）。

## 9. 当前实现状态

- **已实现且实测通过**：`docs/迭代记录.md` 的 `f2a8939` 条目「验证」段记录实跑两轮——中止分支（占位符提示输入 n）在 [2/6] 正确停下并报 `release build failed`；完整分支（输入 y）三件产物全部生成并校验通过；git 预检单独跑通，正确列出未提交改动、判定「all local commits pushed」、对 021/022 各出一条未入库告警。
- **存在问题 / 风险**：
  1. **当前仓库状态下 [2/6] 必然交互中断**：`.qoder/ARCHITECTURE.md` §12.2「`.env.prod` 占位符现状」行记录仓库副本的 `JWT_SECRET` 仍是 `REPLACE_WITH_STRONG_RANDOM_SECRET`，故 `:51` 的 `findstr /c:"REPLACE_WITH"` 必然命中、`:58` 必然等待人工输入。这意味着本脚本**无法无人值守运行**（当前也无 CI），且每次发布都要人工判断「是否覆盖服务器真实值」——该风险本身已在 `.qoder/PROJECT.md` §10「待确认问题清单」第 2 条「仍未核实」项中登记。
  2. **硬编码白名单会静默过期**：`:35-38` 只检查 `021`、`022` 两个文件名，`:121-128` 只检查三个 AI 相关文件路径。出现 `023_*.sql` 或新的 AI 路由文件时，本脚本不会告警也不会校验，需人工记得回来加行。
  3. **`:157` 的核对文案与实际登记值不一致**：手册写「must list 021_ai_center and 022_ai_admin_menus」，但 `docker/init/init-db.sh:31` 登记的 version 是**完整文件名**，库中实际为 `021_ai_center.sql`、`022_ai_admin_menus.sql`。运维照文案核对可能误判为「迁移没跑」。
  4. **`*.db` 无有效兜底校验**：`:131-137` 只兜 `.env`；`build-backend.bat:26` 的 `.env`/`*.db` 守卫是死检查（见 `.qoder/build-backend.bat.md` §9 第 1 条），因此「包内无 `.db`」目前只由 `build-backend.bat:17` 的 `--exclude=*.db` 保证，无二次校验。
  5. **`:132` 的全等比较只覆盖 `backend/.env` 这一个精确路径**：若将来出现嵌套目录下的 `.env`（如 `backend/sub/.env`），不会被这条检查捕获。
  6. **子脚本失败会停在 `pause` 上**：`build-backend.bat:45`、`build-sql.bat:32` 的 `pause` 在被 `:92`/`:101` 以 `call` 调用时同样生效，发布流程会静默等待按键而非直接退出。
  7. **`:111` 的产物循环依赖 `for %%F in (...)` 的字面量列表**：产物增删需同时改 `:8`、`:111`、`:151`，无单一来源。
  8. **生产域名与冒烟端点硬编码**：`:165`、`:174` 写死了生产域名（与 `frontend/services/config.js` 的远程地址同源）。域名变更需同时改这两处与该配置文件。
  9. **服务器侧前提未核实**：`:154` 的 `docker compose run --rm database-init` 假设服务器上存在同名的 `docker/compose.yml` 与 `database-init` 服务定义；服务器上的 compose 文件路径与内容**待确认**（`.qoder/PROJECT.md` §10「待确认问题清单」第 2 条「仍未核实」项）。
- **待确认**：`admin/dist.zip` 的体积/文件数会随管理后台改动变化，§5 引用的 538153 B / 36 文件是 `f2a8939` 当时实测值，非当前值。

## 10. 迭代记录

数据来源：`git log --follow --format='%h|%ad|%s' --date=short -- build-prod.bat`，共 **1 个提交**（创建后未再修改）。

### 2026-10-17（`f2a8939`，14:14）
- 需求：把分散在 `build-backend.bat`、`build-sql.bat`、`admin npm run build` 与人工核对之间的发布动作串成一条命令，并在打包前后拦住「漏跑迁移」「占位符覆盖服务器真实值」「AI 代码没进包」「本地 `.env` 泄漏」四类事故（背景见 §3）。
- 修改内容：新建本文件（183 行），六步结构——[1/6] git 预检（脏工作区、未推送数、021/022 是否入库）；[2/6] `backend\.env.prod` 预检（缺失硬失败、`CLOUDBASE_API_KEY` 空与 `AI_ENABLED=false` 告警、`REPLACE_WITH` 占位符列出并 y/N 确认）；[3/6] `admin npm run build` 并校验 `admin\dist.zip`；[4/6][5/6] 复用两个 `build-*.bat`；[6/6] 产物存在性 + 内容校验（三个 AI 文件、`.env.prod` 必须在，`backend/.env` 必须不在，021/022 必须在 sql 包内）；末尾打印 5 步服务器侧手册与 401/404 冒烟判据。服务器侧与小程序上传一律不代执行。
- 关联文件：`build-backend.bat`、`build-sql.bat`、`admin/package.json`、`admin/scripts/zip-dist.mjs`、`backend/.env.prod`、`docker/init/021_ai_center.sql`、`docker/init/022_ai_admin_menus.sql`、`frontend/services/config.js`。
- 测试结果：实跑两轮（中止分支与完整分支），三件产物 538153 B / 183587 B（84 条目）/ 15945 B（24 条目）全部校验通过，git 预检单独跑通；调试中修掉三个批处理坑（`enabledelayedexpansion` 下 `[!]` 被当变量定界符 → 改 `[WARN]`；`else (` 块内 `commit(s)` 的右括号提前闭合代码块；`findstr /e` 对 `tar -tzf` 输出不生效导致 `.env.prod` 误判缺失 → 改子串匹配）。详见 `docs/迭代记录.md` 的 `f2a8939` 条目（含「待办」段：本次未部署，生产发布仍需人工执行）。
