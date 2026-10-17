# requirements.txt

## 1. 文件路径

`backend/requirements.txt`

## 2. 文件职责

后端唯一的 Python 依赖声明文件，共 11 个运行时依赖，全部使用 `>=` 下界约束、**无锁文件**（无 `requirements.lock` / `poetry.lock` / `uv.lock`）。文件头两行是中文注释，说明用途与安装命令。

## 3. 业务需求

支撑「长征步迹」后端的四类能力：HTTP 服务与 OpenAPI 文档（FastAPI + Uvicorn）、openGauss 数据访问（SQLAlchemy + psycopg2）、微信对接与数据校验（httpx + pycryptodome + Pydantic）、管理后台 Excel 导入导出（openpyxl + python-multipart）。

技术栈选型约束见 `backend/AGENTS.md` §2「技术栈（不可随意更换）」，其中明确规定 Web 框架为 FastAPI + Uvicorn、ORM 为 SQLAlchemy 2.0（`Mapped`/`mapped_column` 风格）、数据校验为 Pydantic v2、鉴权为 PyJWT（HS256）、微信对接为 httpx、配置为 pydantic-settings。

## 4. 核心功能

逐条依赖的**实际使用位置**（均已 grep 核实，非按包名推断）：

| 行号 | 依赖声明 | 直接 import 位置 | 用途 |
|---|---|---|---|
| `:3` | `fastapi>=0.110.0` | `app/api/deps.py:4-5`、`app/api/routes/*.py`（全部 18 个）、`app/main.py` | 路由、依赖注入、`HTTPException`、`HTTPBearer`、OpenAPI 文档 |
| `:4` | `uvicorn[standard]>=0.29.0` | `backend/run.py:8` | ASGI 服务器；`[standard]` extra 提供 `uvloop`/`httptools`/`websockets` 等 |
| `:5` | `sqlalchemy>=2.0.25` | `app/models/models.py`、`app/core/database.py`、`app/services/*.py`、`app/api/deps.py:6` | ORM 与会话管理 |
| `:6` | `psycopg2-binary>=2.9.9` | **无任何直接 import** | 作为 DBAPI 驱动被 SQLAlchemy 按 `DATABASE_URL` 的 `postgresql+psycopg2://` 方案间接加载。两份 env 文件（`.env`、`.env.prod`）的 `DATABASE_URL` 均使用该方案 |
| `:7` | `pydantic>=2.6.0` | `app/schemas/schemas.py:11-12`（`BaseModel`、`ConfigDict`、`Field`、`field_validator`、`to_camel`） | 请求/响应模型与 camelCase 别名生成 |
| `:8` | `pydantic-settings>=2.2.0` | `app/core/config.py:7`（`BaseSettings`、`SettingsConfigDict`） | 从 env 文件加载 `Settings` |
| `:9` | `pyjwt>=2.8.0` | `app/core/security.py:5`（`import jwt`） | HS256 JWT 签发与校验 |
| `:10` | `httpx>=0.27.0` | `app/core/wx.py:10`、`app/services/admin_service.py:14`、`app/services/cloudbase_service.py:18`、`app/services/wechat_service.py:9` | 同步 HTTP 客户端：微信接口、CloudBase Agent、组织同步 |
| `:11` | `pycryptodome>=3.20.0` | `app/core/wx.py:11`（`from Crypto.Cipher import AES`） | AES 解密（微信侧加密数据） |
| `:12` | `openpyxl>=3.1.0` | `app/services/import_service.py:17`（`Workbook`、`load_workbook`） | Excel 模板生成与导入解析 |
| `:13` | `python-multipart>=0.0.9` | **无任何直接 import** | FastAPI 解析 `multipart/form-data` 的必需底层依赖；实际触发点是 `app/api/routes/admin.py:444` 与 `:597` 的 `file: UploadFile = File(...)`（读取辅助函数 `_read_import_file` 在 `:419`） |

## 5. 输入与输出

- **输入**：`pip install -r backend/requirements.txt`（文件头 `:2` 注释即此命令）。
- **输出**：安装到当前 Python 环境。项目本地使用 `backend/.venv/`（已 gitignore，不建档）。
- 无版本号上界，因此**不同时间安装会得到不同版本**，这是本文件最主要的可复现性风险（见 §9）。

## 6. 依赖关系

- **被谁引用**：`backend/AGENTS.md` §7「快速启动」的 `pip install -r requirements.txt`；`backend/README.md`；部署打包流程（见 `.qoder/ARCHITECTURE.md` 部署章节）。
- **依赖谁**：无（纯声明文件）。
- **间接依赖的关键性**：`psycopg2-binary` 与 `python-multipart` 都**不会被 import 语句检索到**，删掉任一个都会在运行时才暴露故障（前者连不上库，后者上传接口 400/500），修改时须特别注意。

## 7. 业务规则

本文件不含业务规则。与依赖相关的**运行时行为约束**记录在别处：

- openGauss 的 libpq 版本号解析问题需要 `app/core/database.py` 的 monkey-patch，详见 `.qoder/ARCHITECTURE.md`。
- 微信 `code2Session` 在 `WX_APPID`/`WX_SECRET` 为空时降级为 mock openid，配置后换取失败返回 502（`backend/AGENTS.md` §2）；该逻辑在 `app/core/wx.py`。

## 8. 修改约束

1. **不得随意更换技术栈**：`backend/AGENTS.md` §2 将上表前 6 项列为「不可随意更换」的选型。
2. **新增依赖必须同时新增到本文件**，否则部署环境会缺包；本地 `.venv` 装了但没写进来是最常见的隐性故障。
3. **不得删除 `psycopg2-binary` 与 `python-multipart`**，二者无直接 import（见 §4），静态检查不会报警。
4. 若将来需要固定版本以保证可复现，应新增锁文件而不是把本文件的 `>=` 改成 `==`——因为 `backend/AGENTS.md` 与部署脚本都以本文件为安装入口，改动语义需同步评估。
5. 严禁在本文件写入任何私有源地址、Token 或凭据。

## 9. 当前实现状态

**已实现且在使用**：11 项依赖全部有明确用途，无冗余声明（`psycopg2-binary` 与 `python-multipart` 为间接依赖，见 §4）。

**存在的问题**：

1. **声明下界与实测安装版本差距很大**，且无上界约束。2026-10-17 在 `backend/.venv` 实测（`pip freeze`）：

   | 依赖 | 声明下界 | 实测安装 |
   |---|---|---|
   | `fastapi` | `>=0.110.0` | **0.143.0** |
   | `uvicorn` | `>=0.29.0` | **0.54.0** |
   | `sqlalchemy` | `>=2.0.25` | **2.1.4** |
   | `psycopg2-binary` | `>=2.9.9` | **2.9.13** |
   | `pydantic` | `>=2.6.0` | **2.14.1**（`pydantic_core` 2.50.1） |
   | `pydantic-settings` | `>=2.2.0` | **2.15.0** |
   | `pyjwt` | `>=2.8.0` | **2.15.1** |
   | `httpx` | `>=0.27.0` | **0.28.1** |
   | `pycryptodome` | `>=3.20.0` | **3.24.1** |
   | `openpyxl` | `>=3.1.0` | **3.1.5** |
   | `python-multipart` | `>=0.0.9` | **0.0.32** |

2. **FastAPI 0.143.0 的 `include_router` 是惰性挂载**：`app.routes` 中 18 个路由模块表现为 `_IncludedRouter` 对象而不展开成 `APIRoute`，直接遍历 `app.routes` 只能数到 1 个 `APIRoute`（`backend/app/main.py:91` 的健康检查）。统计端点必须走 `app.openapi()` 或 `_IncludedRouter.original_router.routes`。**任何依赖遍历 `app.routes` 的测试或工具在本版本下都会得到错误结果**，详见 `.qoder/ARCHITECTURE.md` §2.2 的统计陷阱说明。
3. `pycryptodome` 以 `Crypto` 包名提供，与已废弃的 `pycrypto`、以及 `cryptodome` 分支**包名冲突**；环境中若同时存在会导致 import 到错误实现。当前 `.venv` 只装了 `pycryptodome`，无冲突。
4. **无 Python 版本声明**：本文件不含 `python_requires`，仓库中也无 `.python-version` / `runtime.txt`。实测本地 `.venv` 为 Python 3.13（`__pycache__` 中的字节码标签为 `cpython-313`）。生产 Python 版本**待确认**。

**待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/requirements.txt`，共 **4 个提交**，与 `docs/迭代记录.md` 逐条交叉核对。按时间倒序。

### 2026-10-17

- 需求：建立 `.qoder/` 文档体系，为后端依赖声明文件建档。
- 修改内容：**仅新增本文档，未修改 `requirements.txt` 本身**。核实 11 项依赖的真实 import 位置，确认 `psycopg2-binary` 与 `python-multipart` 为无直接 import 的间接依赖；实测 `.venv` 中 11 个包的实际版本并记录声明下界与实测值的差距；发现并记录 FastAPI 0.143.0 惰性挂载路由导致遍历 `app.routes` 失效的统计陷阱。
- 关联文件：`.qoder/ARCHITECTURE.md` §2.2（端点总数口径与统计陷阱）、`.qoder/PROJECT.md`（技术栈）。
- 测试结果：不涉及代码变更，无需测试。依赖用途以 grep 逐个核实；版本以 `pip freeze` 实测；端点口径以 `app.openapi()` 实测（107 唯一路径 / 125 HTTP 操作 / 1 WebSocket / 126 端点总计）。

### 2026-10-10（`54ea125`，23:31）

- 需求：题库支持 Excel 模板下载与批量导入（预览校验 + 事务写入 + 防重复提交），题库列表改服务端分页。
- 修改内容：新增 `openpyxl>=3.1.0` 与 `python-multipart>=0.0.9` 两行（diff 位于原第 9 行 `pydantic-settings` 之后）。前者用于 `backend/app/services/import_service.py` 的模板生成与解析，后者是 FastAPI 接收 `UploadFile` 的必需底层依赖。
- 关联文件：`backend/app/services/import_service.py`、`backend/app/api/routes/admin.py`、`docker/init/011_import_previews.sql`、`admin/`。
- 测试结果：据 `docs/迭代记录.md:590` 条目 —— S12 后端冒烟 **11/11**（`test/s12_question_import.py`，SQLite 临时库）；admin `npm run build` 通过。**Docker/openGauss 未启动，迁移 011 落库与浏览器验收当时标记为待验证**；批量导入的正式使用按用户要求待准入机制完成后开放。

### 2026-10-10（`3df3fd0`，12:05）

- 需求：步数同步接入微信运动真实数据，杜绝模拟步数写库。
- 修改内容：新增 `pycryptodome>=3.20.0`（diff 位于原第 8 行 `pydantic` 之后），用于 `backend/app/core/wx.py:11` 的 `from Crypto.Cipher import AES` 解密微信运动加密数据。
- 关联文件：`backend/app/core/wx.py`、`backend/app/services/sport_service.py`、`frontend/`。
- 测试结果：据 `docs/迭代记录.md:595` 条目 —— S11 后端冒烟 **8/8**（`test/s11_sport_sync_werun.py`，含加解密往返 / watermark 校验 / 缺当日步数 / 伪造数据 400 零写入），e2e 全链路 **178/178** 回归；小程序 automator 验收 **4/4**（演示按钮已移除、devtools 取数失败友好报错且零写入，截图 `s11-01`）。真机部分在该条目中被截断，**完整结论待确认**。

### 2026-10-01（`bceeb26`，10:26）

- 需求：数据库由 SQLite 切换为 Docker 承载的 openGauss。
- 修改内容：新增 `psycopg2-binary>=2.9.9`（diff 位于原第 3 行之后），作为 openGauss 的 PostgreSQL 协议 DBAPI 驱动。
- 关联文件：`backend/app/core/database.py`、`backend/app/core/config.py`、`docker/compose.yml`、`docker/init/`。
- 测试结果：`docs/迭代记录.md:910-912` 该条目**只有「内容：切换为 Docker 承载的 openGauss」一句，未记载验证结果** —— 属早期简略条目，测试情况**待确认**。

### 2026-09-30（`a94e685`，18:05）

- 需求：项目初始化。
- 修改内容：创建本文件，含 2 行中文注释与 **7 项依赖**：`fastapi>=0.110.0`、`uvicorn[standard]>=0.29.0`、`sqlalchemy>=2.0.25`、`pydantic>=2.6.0`、`pydantic-settings>=2.2.0`、`pyjwt>=2.8.0`、`httpx>=0.27.0`。此后 3 个提交各按需追加，共增至 11 项。
- 关联文件：`backend/`、`frontend/`（仓库初始代码）。
- 测试结果：`docs/迭代记录.md:926-928` 该条目**只有「内容：仓库初始代码」一句，未记载验证结果**，测试情况**待确认**。
