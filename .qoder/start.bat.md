# start.bat

## 1. 文件路径

`start.bat`（仓库根，160 行，**CRLF 行尾**——四个根级 `.bat` 中唯一的 CRLF 文件，实测 `git ls-files --eol` = `i/lf w/crlf`、CR 字节 160；正文纯 ASCII）

## 2. 文件职责

Windows 本地开发环境的一键启动脚本：起 openGauss 容器并**等待迁移成功**、准备并启动后端、准备并启动管理后台、读取并解释小程序当前实际打到哪个后端、最后等端口就绪 + 打开浏览器 + 打两个冒烟请求。全程带配置预检，任一硬前置缺失即失败退出。

## 3. 业务需求

`8d63b6f`（2026-10-12 09:27）新增（`docs/迭代记录.md` 的 `8d63b6f` 条目）：本地起一套环境涉及 Docker、Python venv、pip、npm、微信开发者工具五套工具链，手工步骤多且顺序有依赖（库必须先就绪再启后端），需要一条命令收敛。

后续两次演进都源于**真实排障**：

- `651efc8`（2026-10-17 14:33，`docs/迭代记录.md` 的 `651efc8` 条目）：排查「本地运行为何仍打生产 `/api/ai/chat`」时发现脚本与现状脱节——它起了本机 8010 后端，但 `frontend/services/config.js` 的 `DEV_TARGET` 默认 `'remote'`，小程序根本不会访问它；AI 智能中心上线后 `backend/.env` 缺 `CLOUDBASE_*` 三件套会让 `/api/ai/*` 静默返回 403；8010 被残留 uvicorn 占用时脚本只提示「跳过」，旧代码继续服务且无从察觉。由三步扩为五步。
- `c1ee58e`（2026-10-17 14:48，`docs/迭代记录.md` 的 `c1ee58e` 条目）：`backend/.env` 自 `f05531a` 起按用户决定入库，模板 `backend/.env.example` 被删除，故「缺 `.env` 就从模板复制」改为**硬失败**，并更正 `:ai_config` 告警文案里两处与事实相反的话（原写 `.env`「is gitignored」、原写「Never write the API Key into .env.prod」）。

**明确不做的事**（`docs/迭代记录.md` 的 `651efc8` 条目「内容」段）：不代改 `frontend/services/config.js`（`DEV_TARGET` 属个人联调开关，脚本只读取并提示，避免把 `'local'` 写进库）；不自动杀残留进程（破坏性操作）。与 `build-prod.bat` 的分工：本脚本起本地环境，那个出发布产物，两者都不代执行服务器侧步骤。

## 4. 核心功能

### 4.1 脚本骨架（`:1-11`）

`@echo off` + `setlocal enabledelayedexpansion`（`:2`）+ `cd /d "%~dp0"`（`:3`）+ `set "ROOT=%~dp0"`（`:4`，供 `:49`、`:65` 的 `start /d` 使用）+ `set "COMPOSE=docker compose -f docker\compose.yml"`（`:5`，后续 `%COMPOSE%` 复用）。`:7-11` 打印横幅。

### 4.2 [1/5] 数据库（`:13-31`）

- `:14` `docker info` 预检 Docker 是否运行，未运行则打印提示并 `goto :fail`（`||` 后接 `(echo ... & goto :fail)` 内联块）。
- `:15` `%COMPOSE% up -d`——同时拉起 `opengauss` 与一次性的 `database-init`（`docker/compose.yml:4`、`:30`）。
- `:16-18` `%COMPOSE% ps -a -q database-init` 取容器 id（`-a` 含**已退出**容器），取不到即失败。
- `:19-25` `docker wait %INIT_ID%` 阻塞到容器退出并取回退出码；不为 `0` 时打印退出码、`%COMPOSE% logs --tail 30 database-init` 输出末 30 行日志，然后失败。**这是「库与迁移都就绪」的唯一判据**，实际执行迁移的是 `docker/init/init-db.sh`（见 `.qoder/docker/init/init-db.sh.md` §4.6）。
- `:26` 打印 `ready on 127.0.0.1:5118`（端口口径来自 `docker/compose.yml:13-15`）。
- `:27-29` `for /f "delims=" %%F in ('dir /b /a-d /o:n docker\init\*.sql')` 循环赋值、末次赋值胜出，配合 `/o:n`（按名升序）得到**最高迁移号**并打印；`:30` 说明 `database-init` 只补 `schema_migrations` 中缺失的版本。

### 4.3 [2/5] 后端（`:33-55`）

- `:34-36` 无 `backend\.venv\Scripts\python.exe` 时 `python -m venv backend\.venv`（用 PATH 中第一个 `python`）。
- `:37` 每次运行都 `backend\.venv\Scripts\python -m pip install -q -r backend\requirements.txt` 同步依赖。
- `:38-44` **硬失败**：无 `backend\.env` 时打印四行说明——它是入库文件、缺失即检出损坏、可用 `git checkout -- backend\.env` 恢复、本地读 `.env` 而生产因 systemd 单元里的 `APP_ENV=prod` 读 `.env.prod`——然后 `goto :fail`（`c1ee58e` 由「从模板复制」改为此行为）。
- `:45` 正常路径明示当前加载的是 `backend\.env`（括号内附生产口径说明）。
- `:46` `call :ai_config`（见 §4.6）。
- `:47-54` `call :port_in_use 8010`；`if errorlevel 1`（= 端口**未被占用**）时 `start "longmarch-backend" /d "%ROOT%backend" cmd /k ".venv\Scripts\python run.py"` 开新窗口启动；否则打印跳过，并警告残留进程仍在服务**旧代码**、若冒烟报出过期路由需同时杀掉 `run.py` 与其 reload 子进程（`:51-53`）。

### 4.4 [3/5] 管理后台（`:57-69`）

`:58-62` 无 `admin\node_modules` 时 `pushd admin` + `call npm install`（`:60` 的 `|| (popd & goto :fail)` 保证目录栈不泄漏）；`:63-68` `call :port_in_use 5173`，空闲则 `start "longmarch-admin" /d "%ROOT%admin" cmd /k "npm run dev"`，否则打印跳过。

### 4.5 [4/5] 小程序实际目标（`:71-96`）

- `:74-75` 用 `findstr /c:"const DEV_TARGET"` / `/c:"const LAN_IP"` 定位 `frontend\services\config.js` 中的声明行，再用 `for /f "tokens=2 delims='"` 取单引号之间的值（现有源码 `frontend/services/config.js:11`、`:15` 正是该写法）。
- `:76-79` 读不到 `DEV_TARGET` → `[WARN] DEV_TARGET not readable from config.js, check that file by hand` 并 `goto :mini_done` 跳过本步（不失败）。
- `:80-86` `local` 分支：开发者工具打 `http://127.0.0.1:8010/api`、真机打 `http://!LAN_IP!:8010/api`，并说明真机还需同一 Wi-Fi 且在开发者工具本地设置里勾选「不校验合法域名」、换网络后要更新 `LAN_IP`。
- `:87-93` 其它值（即 `'remote'`）分支：开发者工具与真机都打已部署的 HTTPS 后端，**不是**本脚本起的这个；要调试本机需把 `DEV_TARGET` 改成 `'local'` 并重新编译；跑 automator 回归时保持 `'remote'`，且**不要把 `'local'` 提交进库**。
- `:94` 声明 trial/release 构建忽略 `DEV_TARGET`、恒连已部署后端；`:95` 为 `:mini_done` 标号。
- **只读不写**：本步全程不修改 `config.js`（§3「明确不做的事」）。

### 4.6 [5/5] 等待、开浏览器与冒烟（`:98-109`）

`:99-100` `call :wait_port 8010 backend` / `call :wait_port 5173 admin`（超时只打印消息，返回值未被检查，见 §9 第 1 条）；`:101` `start "" http://localhost:5173` 打开浏览器；`:102` `call :smoke`；`:104-108` 打印汇总——后端地址与 `/docs`、管理后台地址、小程序需在微信开发者工具中手工打开本目录、发布构建用 `build-prod.bat`、停止方式（关窗口 + `%COMPOSE% stop`）；`:109` `exit /b 0`。

### 4.7 子过程 `:ai_config`（`:111-130`）

- `:112-116` 遍历 `CLOUDBASE_ENV_ID`、`CLOUDBASE_AGENT_ID`、`CLOUDBASE_API_KEY` 三个键，用 `findstr /r /c:"^%%K=..*"` 在 `backend\.env` 中要求「键存在且 `=` 后至少一个字符」，未命中则把键名累加进 `AI_MISSING`（`:115` 用 `!AI_MISSING!` 延迟展开）。
- `:117-122` 有缺失 → `[WARN] AI center not configured in backend\.env - missing or empty: ...`，并说明缺这些值时 `/api/ai/*` 与管理端 AI 生成会返回 403、需把真实 `CLOUDBASE_*` 值拷进 `backend\.env`，同时强调**两份 env 文件都被 git 跟踪，因此密钥绝不能进入小程序或管理后台构建产物**（`c1ee58e` 更正后的文案）。
- `:123-125` 无缺失 → 打印三键已配置。
- `:126-127` `findstr /r /c:"^AI_ENABLED=false"` 命中 → `[WARN] AI_ENABLED=false in backend\.env - AI endpoints are switched off`。
- `:128-129` `ADMIN_PASSWORD` 为空 → `note: ADMIN_PASSWORD is empty, so admin login by password is disabled`（后端具体降级行为以 `backend/app/api/routes/admin.py` 为准，本文档不展开）。
- `:130` `exit /b 0`——**本子过程只告警，永不失败**。

### 4.8 子过程 `:smoke`（`:132-142`）

`:133-134` 无 `curl` 则直接 `exit /b 0` 跳过；`:137-138` 两次 `curl -s -o nul -w "%%{http_code}" --max-time 10`（`%%` 为批处理转义，`nul` 为 Windows 空设备）分别打 `/api/activity/status` 与 `/api/ai/conversations`；`:139-141` 打印两个状态码与判据——前者期望 **200**，后者期望 **401**，出现 **404** 说明 8010 上的进程早于 AI 智能中心、必须重启。判据成立的原因：`/api/activity/status` 是公开端点（`backend/app/api/routes/activity.py:12-13`，summary 标注「公开」、无鉴权依赖），`/api/ai/conversations` 需 Bearer Token 故未带 token 时 401。

### 4.9 子过程 `:port_in_use` 与 `:wait_port`（`:144-154`）

- `:144-146` `netstat -ano | findstr /r /c:":%1 .*LISTENING" >nul` 后 `exit /b %errorlevel%`：**返回 0 = 端口已被监听，返回 1 = 空闲**（调用方 `:48`、`:64` 因此写作 `if errorlevel 1` 才启动服务）。
- `:148-154` `for /l %%n in (1,1,60)` 循环：命中即 `exit /b 0`，否则 `ping -n 2 127.0.0.1 >nul` 当约 1 秒延时；60 次后打印 `%2 did not listen on port %1 within 60s, check its window.` 并 `exit /b 1`。

### 4.10 `:fail` 出口（`:156-160`）

打印空行与 `Startup failed.`、`pause`、`exit /b 1`。

## 5. 输入与输出

- **输入（读取，不修改）**：`docker/compose.yml`（经 `%COMPOSE%`）、`docker/init/*.sql` 的文件名清单（`:28`）、`backend/requirements.txt`（`:37`）、`backend\.env`（`:114`、`:126`、`:128` 用 findstr 检查键是否非空，**不打印其值**）、`frontend\services\config.js`（`:74-75` 取两个常量）。**无交互输入**（除失败时的 `pause`）。
- **输入（环境）**：PATH 中的 `docker`、`python`、`pip`、`npm`、`netstat`、`findstr`、`curl`（可选，`:133` 有则用）；Docker Desktop 必须已运行（`:14`）。
- **输出/副作用**：启动/创建 `longmarch-opengauss` 与 `database-init` 容器（并**在库内执行迁移**）；可能创建 `backend\.venv` 与安装 Python 依赖；可能创建 `admin\node_modules`；新开两个 `cmd /k` 窗口分别运行后端与管理后台；打开默认浏览器到 `http://localhost:5173`；向后端发两个 HTTP 请求。stdout 为 `[n/5]` 步骤标记、`[WARN]`/`note:` 提示与末尾汇总。
- **退出码**：`0` 走完五步（含各类 `[WARN]` 与端口占用跳过）；`1` 硬失败（Docker 未运行、`up -d` 失败、`database-init` 容器缺失或退出码非 0、venv 创建失败、pip 失败、`backend\.env` 缺失、npm install 失败）。
- **不产出任何文件产物**（与 `build-prod.bat` 的区别）。

## 6. 依赖关系

- **依赖**：`docker/compose.yml`（`:5`、`:15`、`:17`、`:23`、`:108`）→ 进而依赖 `docker/init/init-db.sh` 与 `docker/init/*.sql`；`backend/requirements.txt`、`backend/run.py`、`backend\.env`（`:37`、`:38`、`:49`）；`admin/package.json` 的 `dev` 脚本（`:65` 的 `npm run dev` → `admin/package.json:7`）；`frontend/services/config.js` 的 `DEV_TARGET`/`LAN_IP` 两个常量（`:74-75`）。
- **探测的后端端点**：`/api/activity/status`（`backend/app/api/routes/activity.py:12`）、`/api/ai/conversations`（AI 智能中心路由，`.qoder/ARCHITECTURE.md` §11）。
- **被谁引用**：`.qoder/PROJECT.md` §4「一键启动（Windows）」；本脚本 `:107` 反向指向 `build-prod.bat`。
- **同族文件**：`build-prod.bat`（发布产物）、`build-backend.bat`、`build-sql.bat`。四者共用「`@echo off` + `cd /d "%~dp0"` + 分步 echo + `goto :fail`」的约定（`docs/迭代记录.md` 的 `f2a8939` 条目「内容」段）。

## 7. 业务规则

1. **迁移成功是后端启动的前置**：`:19-25` 以 `database-init` 退出码 0 为闸门，失败即整个脚本失败——不允许在库结构不完整的情况下起后端（后端启动会写种子数据，缺表即崩，参见 `.qoder/PROJECT.md` §5「数据库迁移执行」告警段记录的两次事故）。
2. **端口占用 = 跳过而非重启**：`:48`、`:64` 的语义是「已有监听就不动它」，因此**旧代码会继续服务**；`:51-53` 用文字警告替代自动杀进程（`651efc8` 明确不做破坏性操作）。
3. **`backend\.env` 缺失即检出损坏**：`:38-44` 视为硬失败而非自动补模板，因为该文件已入库（`c1ee58e`）。
4. **配置只读、只告警**：`:ai_config`（`:111-130`）与 [4/5]（`:71-96`）都不修改任何配置文件，`:130` 恒 `exit /b 0`；所有配置问题以 `[WARN]`/`note:` 呈现。
5. **密钥不得外泄**：`:120-122` 明示 `backend\.env` 与 `backend\.env.prod` 均被 git 跟踪，故 `CLOUDBASE_*` 等密钥绝不能进入小程序包或管理后台构建产物（与 `.qoder/README.md` §3 第 14 条同向）。
6. **`DEV_TARGET='local'` 不得提交**：`:92` 明示保持 `'remote'` 跑 automator、不要把 `'local'` 提交进库。
7. **trial/release 恒连已部署后端**：`:94`；机制见 `frontend/services/config.js` 按 `envVersion` 判定（`.qoder/ARCHITECTURE.md` §12.2「小程序环境切换」行）。
8. **冒烟判据是状态码**：200 / 401 为正常，404 代表进程过期（`:139-141`），与 `build-prod.bat:165-166` 的生产判据同构。
9. **告警标记用 `[WARN]` 而非 `[!]`**：`:2` 开启了延迟展开，正文中的 `!` 会被当变量定界符（实测四个根级 `.bat` 中 `[!]` 零命中）。

## 8. 修改约束

1. **批处理三坑必须继续遵守**（`docs/迭代记录.md` 的 `651efc8` 条目「验证」段记录沿用同日 `build-prod.bat` 的三条约束）：
   - 正文不得出现 `!`（延迟展开），告警统一 `[WARN]`（`:77`、`:118`、`:127`）；
   - **括号块内的 echo 不得含 `)`**——本文件所有 `( ... )` 块内的 echo（`:14`、`:18`、`:22-23`、`:39-42`、`:51-53`、`:67`、`:77`、`:81-86`、`:88-92`、`:118-122`、`:124`）均已避开右括号；单行 `if ... echo`（`:127`、`:129`）与顶层 echo（`:45`、`:104-108`、`:139-141`、`:153`）不受此限，故含括号的 `:45` 是安全的；
   - `<`/`>` 在 echo 中须写成 `-^>`（`:82`、`:83`）。
2. **`%%` 转义不可省**：`:137-138` 的 `%%{http_code}`、`:74-75`/`:113-115`/`:137-138` 的 `%%A`/`%%K`/`%%C`、`:28` 的 `%%F`、`:149` 的 `%%n`。
3. **`:port_in_use` 的返回语义是反直觉的**（0 = 已占用），改动 `:146` 或调用方 `:48`、`:64`、`:150` 时必须三处同步，否则会变成「端口空闲时跳过、被占用时重复启动」。
4. **不得让脚本写配置文件或杀进程**：`DEV_TARGET` 与残留进程都只提示不代改（§3「明确不做的事」）。
5. **新增步骤须保持「硬前置失败、配置问题告警」的分层**：把 `[WARN]` 升级成 `goto :fail` 会让缺 AI 配置的机器无法起本地环境。
6. **`:74-75` 的解析与 `frontend/services/config.js` 的写法强耦合**：依赖 `const DEV_TARGET = '<值>';` / `const LAN_IP = '<值>';` 的单引号形式；改动那个文件的声明方式必须同步这里，否则会退到 `:76-79` 的 `[WARN]` 分支。
7. **端口/地址常量分散在多处**：5118（`:26`）、8010（`:47`、`:49`、`:82`、`:90`、`:99`、`:104`、`:137-138`）、5173（`:63`、`:65`、`:100`、`:101`、`:105`）。改端口需同步 `docker/compose.yml:13-15`/`:23`/`:38`、`backend/.env`、`admin/vite.config.ts` 与本文件。
8. **行尾**：本文件当前为 CRLF（其余三个根级 `.bat` 为 LF）。`docs/迭代记录.md` 的 `651efc8` 条目「验证」段记录 LF 与转 CRLF 后各实跑一次、结果一致，故 cmd 对两种行尾均可解析；但仓库 `core.autocrlf=true` 且**无 `.gitattributes`**，行尾不由版本控制统一约束，改动后建议保持现状不混用。
9. **正文保持纯 ASCII**（实测非 ASCII 字节数 0，`:84` 的「不校验合法域名」等中文语义以英文表述），中文说明放 `docs/`。

## 9. 当前实现状态

- **已实现且实测通过**：`docs/迭代记录.md` 的 `651efc8` 条目记录真实跑通两轮（LF 与 CRLF 各一次，结果一致）——`database-init` 退出码 0、提示最高迁移 `022_ai_admin_menus.sql`、AI 三键齐备、8010/5173 均被占用故跳过启动、`DEV_TARGET=local` 分支正确打印本机与真机地址、冒烟实测 **200 / 401**；另用临时副本单独验证三条告警分支（`DEV_TARGET='remote'`、`config.js` 读不到 `DEV_TARGET`、缺 `CLOUDBASE_*` 叠加 `AI_ENABLED=false` 与 `ADMIN_PASSWORD` 为空）。`c1ee58e` 条目记录正常路径与 `.env` 缺失失败分支均实跑通过。
- **存在问题 / 风险**：
  1. **`:wait_port` 的超时返回值未被检查**：`:99-100` 用 `call` 调用但不看 errorlevel，超时只在 `:153` 打印一行消息，脚本继续执行 `:101` 打开浏览器与 `:102` 冒烟，并最终以 `exit /b 0`（`:109`）成功退出。即「服务没起来」不会反映在退出码上。
  2. **`docker wait` 可能读到上一次的退出码**：`:17` 用 `ps -a -q` 取容器（含已退出的），`:20` 的 `docker wait` 对一个**已退出**容器会立即返回其记录的退出码。若 `:15` 的 `up -d` 未重建这个一次性容器，取回的 `0` 反映的是上一轮结果，本轮迁移失败可能被掩盖。compose 在何种条件下重建 `database-init`（`docker/compose.yml:30-44`，`restart: "no"`）**待确认**；`:17` 的 `for /f` 在同名多容器时也只保留最后一个 id。
  3. **`:145` 的 netstat 解析有两处脆弱点**：① 依赖英文状态字 `LISTENING`，在本地化 Windows 上该列文案是否被翻译**待确认**——若被翻译，探测恒不命中，两个服务会被无条件重复启动且 `:wait_port` 恒超时；② 正则 `:%1 .*LISTENING` 也会匹配到**远端地址**列以 `:8010 ` 结尾的连接，理论上可把「有对外连接到 8010」误判为「本机在监听 8010」。
  4. **`:37` 每次启动都跑 `pip install`**：`-q` 静默且无版本锁校验，依赖不变时属纯耗时；失败仅靠 errorlevel 暴露，无差异提示。
  5. **`:34-36` 用 PATH 中第一个 `python` 建 venv，无版本校验**：生产为 Python 3.14（`.qoder/ARCHITECTURE.md` §12.2「服务器部署」行），本机版本不受约束，可能建出与生产不同大版本的环境。
  6. **新开的两个 `cmd /k` 窗口不被跟踪**：无 PID 记录，`:108` 要求人工关窗；这正是 `:51-53` 所述「残留进程服务旧代码」的成因，脚本按设计只告警不处置。
  7. **`:101` 无条件打开浏览器**：即便 5173 上监听的是别的进程（`:64` 因此跳过了启动），仍会打开该地址。
  8. **当前工作区处于本地联调态**：实测 `frontend/services/config.js:11` 为 `const DEV_TARGET = 'local';` 且该文件在 `git status` 中为已修改未提交（` M frontend/services/config.js`）。这与 `docs/迭代记录.md` 的 `f2a8939` 条目「待办」段一致：跑 automator 回归前需还原为 `'remote'`、且不得提交 `'local'`（本脚本 `:92` 亦如此提示）。因此现在运行本脚本会走 `:80-86` 的 `local` 分支。
  9. **`:129` 的 `ADMIN_PASSWORD` 为空提示属脚本自述**：其后端实际降级行为未在本任务中核对（见 §4.7）。

## 10. 迭代记录

数据来源：`git log --follow --format='%h|%ad|%s' --date=short -- start.bat`，共 **3 个提交**。

### 2026-10-17（`c1ee58e`，14:48）
- 需求：删除 `backend/.env.example` 模板后，「缺 `.env` 就从模板复制」这一步既无必要也有害（会用 25 个空值/占位符覆盖真实配置）。
- 修改内容：把 [2/5] 的缺失分支改为**硬失败**——打印四行说明（`.env` 是入库文件、缺失即检出损坏、`git checkout -- backend\.env` 可恢复、本地读 `.env` 而生产由 systemd 单元里的 `APP_ENV=prod` 读 `.env.prod`）后 `goto :fail`（现 `:38-44`）；正常路径新增一行明示当前加载的配置（现 `:45`）；更正 `:ai_config` 告警文案里两处与事实相反的话（原写 `backend\.env`「is gitignored」实为入库、原写「Never write the API Key into .env.prod」而该文件本就按用户决定携带 `CLOUDBASE_*` 真实值入库），改为陈述「两份 env 均入库，因此密钥绝不可进入小程序或管理后台构建产物」（现 `:120-122`）。
- 关联文件：`backend/.env.example`（删除）、`backend/README.md`、`backend/app/core/config.py`、`.qoder/backend/.env.md`、`.qoder/backend/.env.prod.md`、`.qoder/PROJECT.md`。
- 测试结果：正常路径实跑通过（新增行正确打印、AI 三键齐备、8010/5173 占用故跳过、`DEV_TARGET=local` 分支与冒烟 200/401 均如前）；失败分支把 `backend/.env` 临时改名后实跑，四行提示与 `Startup failed.` 按预期输出，随即改回并确认 `git status` 无差异。详见 `docs/迭代记录.md` 的 `c1ee58e` 条目（其「备注」另记录了 `build-backend.bat:26` 的死检查，本文件未涉及）。

### 2026-10-17（`651efc8`，14:33）
- 需求：脚本与现状脱节——起了本机 8010 后端，但小程序按 `DEV_TARGET='remote'` 根本不访问它；AI 智能中心上线后缺 `CLOUDBASE_*` 会让 `/api/ai/*` 静默 403；8010 被残留 uvicorn 占用时只提示「跳过」，旧代码继续服务且无从察觉。
- 修改内容：由三步扩为五步——① 起库后提示 `docker/init` 最高迁移号并说明 `database-init` 只补缺失项（现 `:27-30`）；② 后端预检 `CLOUDBASE_ENV_ID`/`AGENT_ID`/`API_KEY` 非空、`AI_ENABLED` 是否被关、`ADMIN_PASSWORD` 是否为空，并提示残留进程仍服务旧代码（现 `:ai_config`、`:51-53`）；③ 管理后台不变；④ 用 `for /f "tokens=2 delims='"` 读取 `config.js` 的 `DEV_TARGET` 与 `LAN_IP`，按值分支说明开发者工具与真机各自实际打到哪个地址，并声明 trial/release 恒连已部署后端（现 `:71-96`）；⑤ 等端口后 `curl` 冒烟 `/api/activity/status` 期望 200、`/api/ai/conversations` 期望 401，404 即说明 8010 上是 AI 之前的旧进程（现 `:smoke`）。原 `:port_in_use`/`:wait_port` 与「端口占用即跳过」语义不变。**明确不做**：不代改 `config.js`、不自动杀残留进程。
- 关联文件：`frontend/services/config.js`（只读）、`backend/.env`（只读）、`docker/compose.yml`、`build-prod.bat`（同日新增，分工见其 §3）。
- 测试结果：真实跑通两轮（LF 与转 CRLF 后各一次，结果一致）；另用临时副本单独验证三条告警分支，均按预期输出，临时文件已删除。详见 `docs/迭代记录.md` 的 `651efc8` 条目。

### 2026-10-12（`8d63b6f`，09:27）
- 需求：本地开发需要一条命令按依赖顺序起数据库、后端与管理后台。
- 修改内容：新建本文件——openGauss（`docker compose up -d` 后用 `docker wait` 等 `database-init` 成功退出，失败打印日志）→ 后端（无 `.venv` 时自动创建、每次 `pip install -q` 同步依赖、无 `.env` 时从样例复制〔该行为已由 `c1ee58e` 改为硬失败〕、新窗口 `python run.py`）→ admin（无 `node_modules` 时 `npm install`、新窗口 `npm run dev`）；8010/5173 已有监听时跳过对应服务；两端口就绪后打开浏览器访问 admin；小程序仍需在微信开发者工具中手工打开。
- 关联文件：`docker/compose.yml`、`backend/run.py`、`backend/requirements.txt`、`admin/package.json`。
- 测试结果：在服务已运行的环境实跑——数据库阶段通过（opengauss Healthy、`database-init` 退出码 0），后端与 admin 按端口已占用跳过，8010/5173 均返回 200；另实测 `start /d` 新窗口的启动方式（后端用 `backend\.venv` 解释器、admin 在 `admin\` 目录执行 npm）。详见 `docs/迭代记录.md` 的 `8d63b6f` 条目。
