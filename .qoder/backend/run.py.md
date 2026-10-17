# run.py

## 1. 文件路径

`backend/run.py`（11 行）

## 2. 文件职责

后端的**开发启动入口**：用一行 `uvicorn.run(...)` 把 `app.main:app` 跑在 `0.0.0.0:8010` 并开启热重载。它存在的意义是把启动参数集中在一处，避免在 `app/` 内写启动逻辑（`backend/AGENTS.md` §3 的目录注释明确「`run.py` # 开发启动入口（勿在 app/ 内写启动逻辑）」）。

模块 docstring（`:1-7`）写明用法：`cd backend` → `pip install -r requirements.txt` → `python run.py`（或等价的 `uvicorn app.main:app --reload`）。

## 3. 业务需求

- **本地一键起后端**：仓库根 `start.bat` 的第 2 步用它拉起后端进程（见 §6）。
- **热重载**：开发期改代码后自动重启，无需手动杀进程。`reload=True` 要求 `uvicorn.run` 的第一个参数是**导入字符串**而非 app 对象（uvicorn 需要在子进程中重新 import），这正是 `:11` 写作 `"app.main:app"` 而不是 `from app.main import app` 的原因。
- **监听所有网卡**：`host="0.0.0.0"` 使同一局域网内的其它设备（真机调试的小程序、他人浏览器的管理后台）可访问本机后端。对应需求见 `docs/迭代记录.md` 中「本机 IP+端口供他人访问管理后台」一条（该条目改的是 admin 的 `vite.config.ts` `server.host`，后端侧的 `0.0.0.0` 自项目初始化即如此）。

## 4. 核心功能

全文只有两段有效代码：

| 行号 | 内容 | 说明 |
|---|---|---|
| `:1-7` | 模块 docstring | 用法说明，标注「开发启动入口」 |
| `:8` | `import uvicorn` | 唯一的第三方导入 |
| `:10` | `if __name__ == "__main__":` | 守卫：**被 import 时不启动服务**（例如测试脚本导入本模块不会拉起进程） |
| `:11` | `uvicorn.run("app.main:app", host="0.0.0.0", port=8010, reload=True)` | 唯一的功能语句 |

**`:11` 的四个参数逐项说明**：

| 参数 | 值 | 来源 | 说明 |
|---|---|---|---|
| 第 1 位置参数 | `"app.main:app"` | **硬编码字面量** | 导入字符串，指向 `backend/app/main.py` 的 `app` 对象。解析依赖 `backend/` 在 `sys.path` 上 —— `python run.py` 时 Python 自动把脚本所在目录（`backend/`）加入 `sys.path[0]`，故必须在 `backend/` 目录下执行（docstring `:4` 的 `cd backend` 即此意） |
| `host` | `"0.0.0.0"` | **硬编码字面量** | 监听所有网卡 |
| `port` | `8010` | **硬编码字面量** | 与 `main.py:8` docstring、`start.bat:28`/`:48`/`:53`、`admin/.env.development:3` 的 `VITE_API_PROXY=http://127.0.0.1:8010` 一致 |
| `reload` | `True` | **硬编码字面量** | 开启文件监听热重载 |

**三个启动参数全部是硬编码字面量，不读 `settings`、不读环境变量、不接受命令行参数。** 本文件不 import `app.core.config`，因此 `backend/.env` 里的任何配置项都**无法**改变 host / port / reload。（`.env` 仍会被加载，但那是 `app.core.config` 在 import `app.main` 时自己做的，且其 env 文件路径已锚定到 `backend/` 目录、不依赖启动时的 cwd —— 见 `.qoder/decisions/README.md` 中「`.env` 文件锚定到 backend 根目录」一条，依据 `core/config.py:9-11`。）

**未传给 `uvicorn.run` 的参数**（即全部使用 uvicorn 默认值）：`workers`（`reload=True` 与多 worker 互斥，故不可能设置）、`log_level`、`access_log`、`reload_dirs`、`reload_excludes`、`proxy_headers`、`forwarded_allow_ips`、`ssl_keyfile` / `ssl_certfile`、`root_path`、`lifespan`。

**其中 `proxy_headers` 未开启**这一点有实际影响：uvicorn 默认不从 `X-Forwarded-For` 重写客户端地址，因此 `request.client.host` 是 TCP 直连对端。生产为 nginx → `127.0.0.1:8010` 反代（`.qoder/ARCHITECTURE.md` §12.2），若生产确以本文件启动，则 `core/rate_limit.py` 的按 IP 限流会退化为全局单 key（详见 `.qoder/backend/app/core/rate_limit.py.md` §8）。**生产是否用本文件启动待确认**，故该影响为条件性结论。

## 5. 输入与输出

- **输入**：无。不接受任何命令行参数（`sys.argv` 未被读取），不读环境变量，不读配置文件。
- **输出**：无返回值。副作用是**在前台阻塞运行 uvicorn 服务**，日志直接打到 stdout/stderr（uvicorn 默认格式，未配置落盘与轮转 —— `.qoder/ARCHITECTURE.md` §10.3 与 §16 第 4 项将「访问日志是否落盘」列为待确认）。
- **进程模型**：`reload=True` 时 uvicorn 会启动一个 **reloader 父进程** + 一个**实际服务子进程**。父进程监听文件变化并重启子进程。这带来一个本项目反复踩到的坑：直接关闭终端窗口或强杀子进程可能留下孤儿父进程继续占用 8010 端口 —— `.qoder/backend/test/README.md:31` 明确记载「冒烟结果异常时先确认 8010 端口是否残留旧代码的 uvicorn 进程」，`docs/迭代记录.md` 2026-10-17 条目也记有「顺带清理 8010 端口两个孤儿 `run.py` 及其 reload 子进程后单实例重启」。
- **退出码**：正常由 Ctrl+C / 关闭终端中断；端口被占用时 uvicorn 抛 `OSError` 并以非 0 退出（`start.bat:28-33` 因此先做端口探测再决定是否启动）。

## 6. 依赖关系

**上游依赖**：仅 `uvicorn`（`:8`，第三方库，声明于 `backend/requirements.txt`）。**不 import 项目内任何模块** —— `app.main` 是通过字符串被 uvicorn 在子进程中导入的，本文件自身不触发导入链。

**被谁使用**：

| 使用方 | 位置 | 方式 |
|---|---|---|
| 仓库根 `start.bat` | `:28`（端口探测 `call :port_in_use 8010`）、`:30` | `start "longmarch-backend" /d "%ROOT%backend" cmd /k ".venv\Scripts\python run.py"` —— 在新开的 cmd 窗口中、**以 `backend/` 为工作目录**、用 `backend\.venv` 的解释器前台运行；端口已占用则跳过（`:32`）。之后 `:48` `call :wait_port 8010 backend` 等待端口就绪 |
| 开发者手工执行 | — | `cd backend && python run.py`（`backend/AGENTS.md` §7、`backend/README.md:60`、`main.py:6` docstring 三处均如此记载） |
| 部署包 | `build-backend.bat:12-21` | 打包整个 `backend/` 目录为 `backend-update.tar.gz`，排除 `.venv`、`__pycache__`、`test`、`.env`、`*.db` 等。**`run.py` 未被排除，即随包发布到生产**。`docs/迭代记录.md` 两条打包验收记录（「`run.py`/`requirements.txt`/`app/main.py`/`app/data/seed.py` 齐全」「run.py、requirements.txt、.env.example 与 app 主模块齐全」）确认了这一点 |

**不使用本文件的路径**：

| 场景 | 实际启动方式 |
|---|---|
| 浏览器验收（本机无 Docker/openGauss） | `backend/test/serve_sqlite.py:40` 自行调 `uvicorn.run(app, host="127.0.0.1", port=8010, log_level="info")` —— 传 app 对象、**不开 reload**、只监听回环 |
| 冒烟测试 | `TestClient(app)` 进程内调用，**完全不启 uvicorn、不占 8010 端口**（`.qoder/backend/test/README.md:15`） |
| 生产 | **待确认**（见 §9） |

**数据库 / 表**：无直接关系。数据库连接在 `app.main` → `app.core.database` 导入链中建立；`APP_ENV=prod` 时加载 `backend/.env.prod`，否则加载 `backend/.env`（`core/config.py`，由 `app.main` 触发，与本文件无关）。

## 7. 业务规则

1. **本文件是开发入口，不是配置来源**：host / port / reload 三个值写死在代码里，改端口必须改代码（历史上确实这么改过 —— 提交 `bceeb26` 把 8000 改成 8010，理由记在提交信息里：「8000 被本机打印服务占用」）。
2. **端口 8010 是多处硬编码的约定值**，改动需同步：本文件 `:11`、`app/main.py:8` docstring、`start.bat:28`/`:48`/`:53`、`admin/.env.development:3`、`backend/AGENTS.md` §7、`backend/README.md`、`frontend/services/config.js` 的 `local` 分支。
3. **必须在 `backend/` 目录下执行**：导入字符串 `app.main:app` 依赖 `backend/` 在 `sys.path`。从仓库根执行 `python backend/run.py` 时 `sys.path[0]` 是 `backend/`（脚本所在目录），导入仍可成功；但 `start.bat:30` 显式用 `/d "%ROOT%backend"` 设定工作目录，`backend/AGENTS.md` §7 与 docstring `:4` 也都写了 `cd backend`。**跨目录执行是否在所有场景都可靠，未做验证，待确认。**
4. **`reload=True` 意味着每次代码改动都会重启进程**，进而**重新执行 `app/main.py:41-51` 的 lifespan 启动钩子**（种子写入 + 连续天数重算 + 步行积分台账全量修复）。开发期频繁保存会反复触发全量重算，数据量大时单次重启变慢。三个步骤都是幂等的，不会产生脏数据，但**会拖慢热重载**。
5. **热重载会清空所有进程内内存态**：WebSocket 连接表（`core/ws.py:14` 的 `_connections`）、限流计数（`core/rate_limit.py` 的 `_hits`）、微信 access_token 缓存（`services/wechat_service.py`）在每次重启后归零。开发期「WS 突然收不到消息」「限流莫名失效/生效」多半源于此。

## 8. 修改约束

- **不得把 `reload=True` 用于生产**：uvicorn 的 reloader 会额外派生父进程、监听文件系统，且 `reload` 与 `workers` 互斥，无法通过本文件扩容。若生产确以本文件启动（待确认），改造时应把 `reload` 改为读环境变量（例如 `reload=settings.DEBUG`）。
- **改 `port` 必须同步 §7 第 2 条列出的全部位置**，否则 `start.bat` 的端口探测与等待、admin 的开发代理、小程序 `local` 分支会指向错误端口。
- **不得把 `host` 收窄为 `127.0.0.1` 而不评估影响**：真机调试小程序与他人访问管理后台都依赖 `0.0.0.0`（`docs/迭代记录.md` 有「本机 IP+端口供他人访问管理后台」的明确需求）。
- **不得在本文件内写业务逻辑或建表**（`backend/AGENTS.md` §3「勿在 app/ 内写启动逻辑」的反向约束同样成立：启动逻辑集中在 `run.py`，业务与 DDL 一律不进本文件）。特别地，**不得在此调用 `Base.metadata.create_all`**（`backend/AGENTS.md` §6.4 禁止；`test/serve_sqlite.py:35` 的调用是 test 目录内的例外，不进部署包）。
- **必须保留 `if __name__ == "__main__":` 守卫（`:10`）**：去掉会让任何 `import run` 都启动服务。
- **若需支持命令行参数或 env 覆盖**，须保持「无参数时行为与当前完全一致」，因为 `start.bat:30` 与全部文档都以无参形式调用。
- **第一个参数必须保持为导入字符串**（不能换成 `from app.main import app` 再传对象），否则 `reload=True` 失效并告警。

## 9. 当前实现状态

**已实现**：

- 一行式 uvicorn 启动，`0.0.0.0:8010` + 热重载，导入字符串形式（`:11`）。
- `__main__` 守卫（`:10`），可被安全 import。
- 与 `start.bat` 的一键启动链完整对接（端口探测 → 启动 → 等待就绪）。

**存在问题 / 已知现状**：

1. **生产是否使用本文件启动，无法从仓库确认 —— 待确认。** 已知事实是：① `build-backend.bat` 把 `run.py` 打进 `backend-update.tar.gz` 发布到服务器；② `.qoder/ARCHITECTURE.md` §12.1 与 §16 第 3 项把「生产后端进程管理方式（systemd / nohup / supervisor / docker）」列为**待确认**；③ 仓库内**不存在** systemd unit 文件、`Dockerfile`、`supervisord.conf`、`gunicorn` 配置或任何生产启动脚本 —— `grep -rn "systemd\|nohup\|gunicorn\|supervisor"`（排除 `node_modules` 与 `.venv`）在**源码与部署脚本中零命中**，全部命中都落在 `.qoder/` 的既有文档里，且内容均为「进程管理方式待确认」；④ `run.py` 的 `reload=True` 与 `0.0.0.0` 组合并非生产推荐配置。综合以上：**本文件被发布到生产，但没有证据表明它就是生产的启动命令。**
2. **`reload=True` 无法关闭**：没有开关、没有环境变量、没有命令行参数。生产若直接用本文件，会带着 reloader 父进程与文件监听运行（性能与稳定性均非最优）。
3. **三个启动参数全部硬编码**：`port` 与 `host` 无法按环境切换；`.env.prod` 中即使有端口类配置项也不会被本文件读取（本文件不 import `settings`）。
4. **未开启 `--proxy-headers`**：反代场景下 `request.client.host` 为直连对端地址，影响 `core/rate_limit.py` 的 IP 维度限流（见 §4 末段，条件性影响）。
5. **未配置日志落盘与轮转**：使用 uvicorn 默认控制台日志。是否有外部重定向（如 systemd journal、nohup 重定向）**待确认**（`.qoder/ARCHITECTURE.md` §16 第 4 项）。
6. **孤儿进程风险**：`reload=True` 的双进程模型 + `start.bat` 用 `cmd /k` 开新窗口，容易残留占用 8010 的父进程。已在 `.qoder/backend/test/README.md:31` 与 `docs/迭代记录.md` 2026-10-17 条目中被记录为反复踩到的坑，**当前无自动清理机制**（`start.bat` 只做「端口占用则跳过启动」，不清理旧进程）。

**待开发**：无明确规划。若要支持生产直启，需要至少：`reload` 按环境关闭、`proxy_headers` 按反代拓扑开启、端口/host 可配置。这些**均未在仓库内提出为需求**，属本文档基于现状列出的改造点，非既有待办。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/run.py`（**仅 2 条提交**，全部列出），验证结论对照 `docs/迭代记录.md`。

### 2026-10-01

- 需求：数据库由 SQLite 切换为 Docker 承载的 openGauss；本机 8000 端口被打印服务占用，后端需换端口。
- 修改内容：提交 `bceeb26`。`:11` 的 `port=8000` 改为 `port=8010`。**这是本文件唯一一次功能性改动，`host`、`reload`、导入字符串、`__main__` 守卫、docstring 均未变。** 提交信息正文记录的理由为「run.py 与文档地址端口调整为 8010（8000 被本机打印服务占用）」。
- 关联文件：`app/main.py`（docstring 地址同步为 8010、移除 `init_db()`）、`app/core/database.py`（openGauss 版本兼容补丁、移除 `create_all`）、`app/core/config.py` 与 `backend/.env.example`（`DATABASE_URL` 指向 `127.0.0.1:5118`）、`docker/compose.yml`、`docker/init/001~003`、`requirements.txt`（新增 `psycopg2-binary`）。
- 测试结果：待确认（`docs/迭代记录.md` 2026-10-01「数据库由 SQLite 切换为 openGauss（架构变更）」条目只有「内容：切换为 Docker 承载的 openGauss」，无「验证」字段；提交信息正文列出变更点但未记测试结论）。

### 2026-09-30

- 需求：项目初始化，提供后端开发启动入口。
- 修改内容：提交 `a94e685`（`feat: init`）。**新建文件**，11 行，内容与当前版本仅差 `port`（初始为 8000）。docstring 自始即标注「开发启动入口」，`host="0.0.0.0"` 与 `reload=True` 自始即硬编码。
- 关联文件：`app/main.py`（同批新建）、`app/core/config.py`、`app/core/database.py`、`backend/requirements.txt`。
- 测试结果：待确认（`docs/迭代记录.md` 2026-09-30「项目初始化（init）」条目仅记「内容：仓库初始代码」，无验证结论）。
