# build-backend.bat

## 1. 文件路径

`build-backend.bat`（仓库根，46 行，LF 行尾，正文纯 ASCII）

## 2. 文件职责

把 `backend/` 目录打成发布产物 `backend-update.tar.gz`，并在打包后校验产物内不含 `.env`/`*.db` 与 `backend/test/`。取代此前的手工打包，是后端上线的唯一打包入口。

## 3. 业务需求

`a0ca154`（2026-10-16 09:50）新增（`docs/迭代记录.md` 的 `a0ca154` 条目）：后端发布需要把源码上传到服务器解压覆盖，手工 `tar` 容易漏排除 `.venv`、`__pycache__`、本地数据库文件或把开发用的 `backend/.env` 一起带上（该文件含开发凭证）。`6cdd80a`（2026-10-16 15:11）追加需求：测试目录 `backend/test/`（报告、截图、automator、`_smoke_*.db`、`*results*.json`）不应进入发布包（`docs/迭代记录.md` 的 `6cdd80a` 条目）。产物在 `.qoder/PROJECT.md` §5「发布产物」表中登记，服务器侧解压步骤由 `build-prod.bat:160-166` 打印。

## 4. 核心功能

### 4.1 脚本骨架（`:1-3`）

`@echo off` + `setlocal`（**未**开启 `enabledelayedexpansion`）+ `cd /d "%~dp0"` 把工作目录钉在仓库根，因此脚本可从任意路径调用。四个根级 `.bat` 共用这套骨架（`build-prod.bat:1-3`、`build-sql.bat:1-3`、`start.bat:1-3`）。

### 4.2 目录预检（`:5-8`）

`if not exist backend` → 打印 `[x] backend directory not found` 并 `goto :fail`。防止在错误的目录下生成一个空包。

### 4.3 打包（`:10-22`）

`:11` 先删除已存在的 `backend-update.tar.gz`（不做原子替换，见 §9 第 4 条）；`:12-21` 用 `^` 续行调 `tar -czf backend-update.tar.gz` 打包 `backend`（`:21`），排除项依次为：

| 排除项 | 行 | 目的 |
| --- | --- | --- |
| `--exclude=.venv` | `:13` | 本地虚拟环境（体积大、平台相关） |
| `--exclude=__pycache__` | `:14` | 字节码缓存 |
| `--exclude=test` | `:15` | `backend/test/` 测试目录（`6cdd80a` 追加） |
| `--exclude=.env` | `:16` | **本地开发配置（含开发凭证）不得上线**；注意按 basename 匹配，`backend/.env.prod` 基名不同，**故意保留在包内** |
| `--exclude=*.db` | `:17` | SQLite 遗留文件与 `_smoke_*.db` 冒烟产物 |
| `--exclude=_smoke_*.py` | `:18` | 临时冒烟脚本 |
| `--exclude=_inspect_db.py` | `:19` | 临时排障脚本 |
| `--exclude=*results*.json` | `:20` | 测试结果产物（`.qoder/README.md` §4「测试结果产物」行） |

`:22` `if errorlevel 1 goto :fail` 捕获 `tar` 自身失败（含 `tar` 不在 PATH 时的 9009）。

### 4.4 产物校验（`:24-37`）

1. `:25` `tar -tzf backend-update.tar.gz >nul 2>&1 || goto :fail`——归档可完整读取（未截断、gzip 完好）。
2. `:26` `tar -tzf ... | findstr /e /c:".env" /c:".db"` + `:27-31` `if not errorlevel 1` → 打印 `[x] package contains .env or *.db, aborted`、删除产物、失败。**该行尾锚定检查实测不生效，是死检查**（§9 第 1 条）。
3. `:32-37` `tar -tzf ... | findstr /c:"backend/test/"` + `if not errorlevel 1` → 打印 `[x] package contains backend/test, aborted`、删除产物、失败。这条用**子串**匹配，是有效检查。

两处 `if not errorlevel 1` 的语义都是「findstr 命中（errorlevel 0）即中止」，即校验的是「**不该出现的东西出现了**」。

### 4.5 成功与失败出口（`:39-46`）

成功路径打印空行与 `done: %~dp0backend-update.tar.gz` 后 `exit /b 0`（`:39-41`）；`:43-46` 的 `:fail` 标号打印 `[x] packaging failed`、`pause`、`exit /b 1`。`exit /b`（而非 `exit`）保证被 `build-prod.bat:92` 以 `call` 调用时只结束本子过程、不关掉整个 cmd 会话。

## 5. 输入与输出

- **输入**：仓库根下的 `backend/` 工作区目录（**不是** git 索引内容，未跟踪文件同样会被打包，只受 `:13-20` 的排除项约束）；Windows 内置 `tar`（bsdtar）与 `findstr`。
- **输出**：仓库根的 `backend-update.tar.gz`，归档内路径以 `backend/` 为前缀；已被 `.gitignore:24` 忽略。stdout 为 `[1/2]`/`[2/2]` 步骤标记、`[x]` 失败标记与 `done:` 行。
- **退出码**：`0` 成功；`1` 失败（目录缺失、tar 失败、校验命中）。失败时 `:45` 的 `pause` 会等待按键（见 §9 第 5 条）。
- **实测规模**：`docs/迭代记录.md` 的 `c1ee58e` 条目记录 **83 条目 / 74 个文件**、env 类只有 `backend/.env.prod`；更早的 `6cdd80a` 条目记录条目数由 144 降至 76，`a0ca154` 条目记录初版 273KB / 144 条目。

## 6. 依赖关系

- **被谁调用**：`build-prod.bat:92`（`call build-backend.bat`，随后 `:93` 检查 errorlevel、`:94-97` 检查产物存在，并在 `:121-137` 对同一归档做更严的内容校验）。也可由开发者单独双击/命令行执行。
- **依赖**：Windows 10+ 内置 `tar`、`findstr`；`backend/` 目录结构。
- **产物消费者**：服务器侧按 `build-prod.bat:160-166` 解压覆盖代码目录，比对 `.env.prod` 后重启 systemd 服务 `longmarch-backend`（`.qoder/ARCHITECTURE.md` §12.2「服务器部署」行）。
- **同族文件**：`build-sql.bat`（打 `docker/init`）、`admin/scripts/zip-dist.mjs`（由 `admin/package.json:9` 的 `build` 脚本末尾产出 `admin/dist.zip`）。三者共同构成 `.qoder/PROJECT.md` §5「发布产物」表的三件产物。

## 7. 业务规则

1. **`backend/.env` 绝不入包**：由 `:16` 的 `--exclude=.env` 保证；`:26` 的二次校验因死检查并不提供额外保障（§9 第 1 条）。`build-prod.bat:131-137` 用逐行全等比较做了**有效**的兜底。
2. **`backend/.env.prod` 必须入包**：它是生产配置且按用户决定入库（`.qoder/PROJECT.md` §9「已被 git 跟踪」），`build-prod.bat:127-128` 会校验其存在；服务器侧解压后须与线上副本比对、保留真实 `DATABASE_URL`/`JWT_SECRET`/`ADMIN_PASSWORD`（`build-prod.bat:160-163`）。
3. **测试与临时产物一律不入包**：`:15`、`:18-20`，与 `.qoder/README.md` §4 的建档排除口径一致（测试脚本、测试报告、`*-results.json`、`*.db`）。
4. **校验命中即销毁产物**：`:29`、`:35` 在失败前 `del /q backend-update.tar.gz`，避免把可疑包留在线上流程里被误上传。
5. **打包范围看工作区、不看 git**：未提交/未跟踪的后端文件同样会被打进包，因此发布前必须先确认 git 状态（`build-prod.bat:12-42` 的 [1/6] 预检正是为此）。
6. **告警标记用 `[x]`/`[WARN]` 而非 `[!]`**：四个根级 `.bat` 统一约定。本文件 `:2` 未开延迟展开，`!` 在此其实安全；但 `build-prod.bat:2` 与 `start.bat:2` 开了 `setlocal enabledelayedexpansion`，正文里的 `!` 会被当变量定界符，故全仓统一避开（`docs/迭代记录.md` 的 `f2a8939` 条目「验证」段记录了这一坑）。

## 8. 修改约束

1. **不得移除或放宽 `:16` 的 `--exclude=.env`**：它是防止开发凭证上线的唯一有效手段（`:26` 的校验已失效）。
2. **修 `:26` 时不要沿用 `findstr /e`**：应改为子串匹配（如 `findstr /c:"backend/.env"`，但需避免误命中 `backend/.env.prod`）或 `build-prod.bat:132` 那样的 `for /f` + 全等比较。
3. **新增排除项要同步更新校验**：排除项与校验是两套独立逻辑，只加排除不加校验会重演 `:26` 的「有守卫但守卫失效」。
4. **保持 `exit /b` 与 `setlocal`**：`build-prod.bat:92` 以 `call` 复用本脚本，改成 `exit`（无 `/b`）会终止父脚本的 cmd 会话。
5. **保持正文纯 ASCII、中文说明放 `docs/`**：实测四个根级 `.bat` 的非 ASCII 字节数均为 0（`start.bat` 的 160 个额外字节是行尾 CR，非正文）。cmd 在非 UTF-8 代码页下输出中文会乱码。
6. **行尾**：本文件为 LF（实测 `git ls-files --eol` = `i/lf w/lf`）。四个根级 `.bat` 中只有 `start.bat` 是 CRLF；cmd 对两种行尾都能正确解析（`docs/迭代记录.md` 的 `651efc8` 条目「验证」段记录 LF 与 CRLF 各实跑一次、结果一致）。
7. **括号块内的 echo 文本不得含 `)`**、`set /p` 提示语同理：本文件 `:28`、`:34` 的失败提示都在 `( ... )` 块内，已避开括号；新增文案时须继续遵守（`docs/迭代记录.md` 的 `f2a8939` 条目记录过 `commit(s)` 的右括号提前闭合代码块）。
8. **产物名与 `.gitignore:24` 绑定**：改名需同步 `.gitignore` 与 `build-prod.bat:8`/`:94`/`:111`。

## 9. 当前实现状态

- **已实现且在用**：作为 `build-prod.bat` 的 [4/6] 步被复用；三次实测记录见 §5。
- **存在缺陷**：
  1. **`:26` 是死检查（真实缺陷，未修）**：`findstr /e`（行尾锚定）对 `tar -tzf` 的管道输出不生效，因此「包内不得含 `.env`/`*.db`」这条守卫从不触发，实际由 `:16`/`:17` 的 `--exclude` 兜住。依据：① `docs/迭代记录.md` 的 `c1ee58e` 条目「备注」明确记录该行尾锚定不生效、是死检查、靠 `--exclude=.env` 兜底；② `docs/迭代记录.md` 的 `f2a8939` 条目「验证」段记录同一 `/e` 行为曾使 `build-prod.bat` 误判 `.env.prod` 缺失，并已在那边改成子串匹配（`build-prod.bat:127`）与全等比较（`build-prod.bat:132`）；③ 实测 `findstr /e` 在四个根级 `.bat` 中**仅**出现在 `build-backend.bat:26`，即该处至今未按同样方式修复。**本任务不改 `.bat` 源码**，仅记录。
  2. **`*.db` 缺有效二次校验**：与第 1 条同源——`:26` 失效后，`build-prod.bat` 只对 `.env` 做了有效兜底（`:131-137`），对 `*.db` 没有任何等价检查，全靠 `:17` 的 `--exclude=*.db`。
  3. **`--exclude=test`（`:15`）按 basename 全局生效**：会连带排除 `backend/` 下任何名为 `test` 的目录。当前只有 `backend/test/`（正是要排除的），但未来若出现需要发布的同名目录会被静默丢弃。
  4. **非原子替换**：`:11` 先删旧包，`:12-21` 打包失败时旧包已不存在，无回退。
  5. **失败路径的 `pause`（`:45`）会阻塞父脚本**：被 `build-prod.bat:92` 以 `call` 调用时，一旦失败整个发布流程会停在按键等待上（`build-sql.bat:32` 同理，经 `build-prod.bat:101`）。当前无 CI（`.qoder/PROJECT.md` §5「发布产物」表「小程序包」行注明无 CI），影响仅限人工发布体验。
  6. **同一归档被 `tar -tzf` 列举 3 次**（`:25`、`:26`、`:32`），加上 `build-prod.bat:121-142` 的 5 次共 8 次；产物约 180KB，实测耗时可忽略，属可优化项而非缺陷。
- **待确认**：`tar` 的 `--exclude` 在其它 Windows 版本/bsdtar 版本上的匹配语义是否一致（本仓库仅在编写机实测）。

## 10. 迭代记录

数据来源：`git log --follow --format='%h|%ad|%s' --date=short -- build-backend.bat`，共 **2 个提交**。

### 2026-10-16（`6cdd80a`，15:11）
- 需求：发布包不应包含 `backend/test/`（报告、automator、`_smoke_*.db`、`*results*.json` 等）。
- 修改内容：`tar` 新增 `--exclude=test`（现 `:15`）；校验新增一步——`tar -tzf` 命中 `backend/test/` 即中止并删除产物（现 `:32-37`）。前端 `frontend/test` 由 `project.config.json` 的 `packOptions.ignore` 排除，本次未动。
- 关联文件：`.gitignore`（同批忽略发布产物）。
- 测试结果：实跑通过——产物含 `backend/test` 0 条，`.venv`/`__pycache__`/`.env`/`.db` 均 0 条，`run.py`/`requirements.txt`/`app/main.py`/`app/data/seed.py` 齐全，条目总数由 144 降至 76（`docs/迭代记录.md` 的 `6cdd80a` 条目）。

### 2026-10-16（`a0ca154`，09:50）
- 需求：后端发布需要一键打包，替代手工 `tar`，并自动排除凭证与垃圾文件。
- 修改内容：新建本文件——目录预检、带 7 项 `--exclude` 的 `tar -czf`、归档可读性校验、`.env`/`*.db` 与（后续追加的）测试目录守卫、`:fail` 出口。
- 关联文件：`.gitignore`（新增 `backend-update.tar.gz` 与 `frontend/dist.zip`）。
- 测试结果：脚本实测运行通过（含产物校验），新包 273KB / 144 条目，敏感与垃圾文件 0 个，`run.py`、`requirements.txt`、`.env.example` 与 app 主模块齐全（`docs/迭代记录.md` 的 `a0ca154` 条目）。注：其中 `.env.example` 已于 `c1ee58e`（2026-10-17）从仓库删除，该条属**当时**的关联事实，按历史记录不改写。

### 关联变更（未修改本文件）
- `f2a8939`（2026-10-17）新增 `build-prod.bat`，以 `call build-backend.bat`（`build-prod.bat:92`）复用本脚本，并在其 [6/6] 步对同一归档追加内容校验与 `.env` 泄漏的全等比较检查。
- `c1ee58e`（2026-10-17）删除 `backend/.env.example` 后重跑本脚本，实测 **83 条目 / 74 个文件**、env 类只剩 `backend/.env.prod`；同条「备注」记录了 `:26` 的死检查（本文件未随之修改）。
