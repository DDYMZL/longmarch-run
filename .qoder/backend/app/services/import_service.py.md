# import_service.py

## 1. 文件路径
`backend/app/services/import_service.py`（410 行）

## 2. 文件职责
管理后台 Excel 批量导入的**通用框架 + 两类业务实现**：提供 .xlsx 模板生成、上传解析、公式注入拦截、整批校验、预览暂存（`import_previews`）与凭一次性令牌的事务化确认写入；在其上注册「题库」与「每日寄语」两套表头/说明/行解析/批量写入逻辑（模块 docstring `backend/app/services/import_service.py:1-11`）。

本文件不含路由，不做权限校验，也不直接返回 HTTP 错误码——文件类型与大小校验在路由层的 `_read_import_file`（`backend/app/api/routes/admin.py:419-426`）。

## 3. 业务需求
- **V1.1 功能一：题库 Excel 模板下载与批量导入**。提交 `54ea125`（2026-10-10）创建本文件（297 行），同期新增迁移 `docker/init/011_import_previews.sql`、`backend/test/s12_question_import.py` 与 `backend/requirements.txt` 的 `openpyxl`/`python-multipart` 两行依赖。
- **V1.1 功能二 / 需求 §16：每日寄语按天循环 + Excel 导入**。提交 `d6acf7e`（2026-10-11）在本文件追加寄语导入（+114 行），复用题库导入框架。
- 上层规则汇总见 `.qoder/ARCHITECTURE.md` §8「文件上传与 Excel 导入导出」与 `.qoder/REQUIREMENTS.md` §11.6「Excel 导入导出规则」；本文档只补文件级细节，不复制其正文。
- 关键设计取舍（两阶段预览、条件 UPDATE 消费令牌、整批阻断、不引入 pandas）已登记在 `.qoder/decisions/README.md:77-82`。

## 4. 核心功能

### 4.1 通用约定与常量
- 模块 docstring `:1-11` 明确 5 条通用约定：仅 .xlsx、限大小与行数；公式单元格整行判错防注入；**任一行失败则整批不可确认**；预览暂存 `import_previews`、确认凭 token 一次性事务写入并核销；**默认新增导入模式**（与库内既有数据重复的整行判错，不自动覆盖）。
- `MAX_FILE_SIZE = 2 * 1024 * 1024`（`:25`）、`MAX_ROWS = 500`（`:26`）、`PREVIEW_TTL_MINUTES = 30`（`:27`）。前两项由路由层 `_read_import_file` 读取（`backend/app/api/routes/admin.py:423-424`），第三项由 `_save_preview` 使用（`:133`）。
- `class ImportError(Exception)`（`:30-31`）：文件级错误（类型/大小/表头不符），docstring 注明「路由层转 400」。**该类在模块作用域内遮蔽了 Python 内置 `ImportError`**（同名）；`_read_sheet` 用 `except Exception`（`:66`）兜底后重抛本类，故不受遮蔽影响。

### 4.2 单元格与解析层
| 函数 | 行号 | 职责 |
|---|---|---|
| `_fail(row, field, reason)` | `:34-35` | 统一错误行结构 `{"row","field","reason"}`，对应 `AdminImportErrorRow`（`backend/app/schemas/schemas.py:1115-1120`）；`field` 为空串表示整行错误 |
| `_cell_text(value)` | `:38-55` | 单元格转纯文本 + 公式/DDE 注入拦截。`None` → `""`（`:44-45`）；**整数型 float 还原为整数字符串**（`:46-47`，docstring `:41-42` 说明是为避免分值/选项被污染成「20.0」）；`strip` 后为空 → `""`（`:48-50`）；首字符属 `=` `+` `@` → `ValueError`（`:51-52`）；首字符 `-` 且其余非数值 → `ValueError`（`:53-54`） |
| `_read_sheet(content, expected_headers)` | `:58-104` | 解析首个工作表，返回 `(有效数据行, 文件级错误)` |
| `_build_workbook(sheet_name, headers, instructions)` | `:107-121` | 生成双工作表模板：数据表（仅表头，列宽 18，`:112-114`）+「填写说明」表（A 列宽 100，`:115-118`），返回 `bytes` |

`_read_sheet` 细节（`:58-104`）：
- `load_workbook(io.BytesIO(content), read_only=True, data_only=False)`（`:65`）：`read_only` 流式读取避免大文件占内存；`data_only=False` 保留公式原文，是注入检测（`:51-54`）能生效的前提。解析异常统一转 `ImportError("文件无法解析…")`（`:66-67`）。
- 只取 `wb.worksheets[0]`（`:68`），第二张「填写说明」表被忽略。
- 空文件（无表头行）→ `ImportError`（`:70-73`）。
- **表头校验按位置比对**（`:74-77`）：`headers` 逐格过 `_cell_text`，滤掉空表头得 `trimmed`，比较 `trimmed[:len(expected_headers)] != expected_headers` → `ImportError("表头与模板不一致…")`。即「前 N 个非空表头必须与模板完全一致」，模板右侧多出的列被容忍（数据行也在 `:85-86` 截断到前 N 列）。
- 数据行循环 `enumerate(rows_iter, start=2)`（`:80`），`row` 即 Excel 真实行号；单元格注入 → **整行判错并 break**（`:87-91`）；`has_content` 为假（全空行）直接跳过（`:93-94`、`:97`）。
- 行数上限检查在循环内、追加之后（`:99-100`）：`len(data_rows) + len(errors) > MAX_ROWS` → `ImportError`。因此上限是**有效行 + 错误行合计 500**，空行不计入。
- `wb.close()`（`:101`）；既无有效行也无错误行 → `ImportError("未解析到任何数据行")`（`:102-103`）。
- 返回的数据行形如 `{"row": Excel行号, "raw": {表头文本: 单元格文本}}`（`:98`）。

### 4.3 预览暂存与确认核销（两阶段核心）
- `_save_preview(db, biz_type, rows, errors, operator) -> str`（`:124-137`）：`uuid.uuid4().hex` 生成令牌（`:126`），把 `{"rows": rows, "errors": errors}` 整体写入 `ImportPreview.payload`（`:131`），`expires_at = datetime.utcnow() + 30 分钟`（`:133`）。**事务边界：本函数 `:136` 自行 `db.commit()`**。
- `_confirm(db, token, biz_type, inserter) -> int`（`:140-175`）：核销令牌并批量写入，docstring `:146-150` 说明「令牌核销采用条件更新（status pending → confirmed），并发重复提交只有一个请求能核销成功；写入异常时回滚，令牌恢复 pending 可重试」。执行顺序：
  1. 按 token 查预览，不存在或 `biz_type` 不符 → `ValueError("预览不存在，请重新上传文件")`（`:151-153`）；
  2. `expires_at < utcnow()` → `ValueError("预览已过期，请重新上传文件")`（`:154-155`）；
  3. **`payload["errors"]` 非空 → `ValueError("存在校验失败的数据行，本批次禁止导入")`（`:156-158`）——这是「整批阻断」的实际强制点**；
  4. `payload["rows"]` 为空 → `ValueError("没有可导入的数据行")`（`:159-161`）；
  5. 条件 UPDATE：`WHERE token = ? AND status = 'pending'` → `SET status='confirmed', confirmed_at=utcnow()`（`:162-166`），`rowcount != 1` → `ValueError("该导入已确认，请勿重复提交")`（`:167-168`）；
  6. `count = inserter(db, rows)` 后 `db.commit()`（`:169-171`）；异常时 `db.rollback()` 再重抛（`:172-174`）。
  
  **事务边界：步骤 5 的令牌核销与步骤 6 的业务写入在同一个事务、同一次 `commit` 内**，因此写入失败回滚时令牌核销一并撤销，令牌回到 `pending` 可重试（与 docstring `:149-150` 一致）。

### 4.4 题库导入（`:178-298`）
- `QUESTION_HEADERS` 12 列（`:179-182`）：题型 / 题目内容 / 选项A~F / 正确答案 / 答案解析 / 分值 / 知识分类。
- `QUESTION_INSTRUCTIONS` 9 条填写说明（`:184-194`），其中第 7 条（`:192`）声明「默认新增导入，不覆盖」，第 8 条（`:193`）声明整批阻断。
- 别名表：`_QUESTION_TYPE_ALIASES`（`:196`，单选/single、判断/judge）、`_QUESTION_CATEGORY_ALIASES`（`:197-201`，历史事件/event、长征路线/route、历史人物/figure）。
- `build_question_template()`（`:204-206`）：数据表名「题目数据」。被 `GET /api/admin/questions/import-template` 调用（`backend/app/api/routes/admin.py:435`）。
- `_parse_question_row(raw)`（`:209-252`）：题型缺失或非法 → `ValueError`（`:211-213`）；分值留空默认 `"20"`、须为**正整数**（`:228-235`）；判断题固定生成 `A.正确 / B.错误` 两选项并按 `judge_map` 接受「正确/错误/A/B/对/错」（`:237-242`）；单选题收集 A~F 中非空选项，答案按中文逗号、顿号、英文逗号分割成列表（`:243-250`）；最后统一调用 `admin_service._validate_question(data)` 收口（`:251`）。
- `preview_question_import(db, content, operator)`（`:255-286`）：`existing = {q.question.strip() for q in db.query(Question.question).all()}`（`:261`）——**一次性加载题库全部题干**；逐行解析失败 → 错误行（`field` 为空串，`:264-267`）；与库内重复 → 「与题库中已有题目重复」（`:270-272`）；与文件内前序行重复 → 「与文件内第 N 行重复」（`:273-275`，`seen_texts` 记录首次出现行号）；`errors.sort(key=row)`（`:278`）后 `_save_preview(db, "question", …)`（`:279`）。
- `confirm_question_import(db, token)`（`:289-298`）：内嵌 `_insert`，`base_id = session.query(func.max(Question.id)).scalar() or 0`（`:293`），逐行 `session.add(Question(id=base_id + offset, **item["data"]))`（`:294-295`）。docstring `:290` 明确「id 取 max+1 起连续分配，与新增题目一致」。

### 4.5 每日寄语导入（`:301-410`）
- `QUOTE_HEADERS` 5 列（`:302`）：寄语内容 / 出处 / 排序号 / 启用状态 / 关联节点。
- `QUOTE_INSTRUCTIONS` 10 条（`:304-316`），其中第 2、3、4 条以 f-string 直接引用 `quote_service.CONTENT_MAX_LEN`（200）、`SOURCE_MAX_LEN`（200）、`SORT_ORDER_MAX`（999999）（`backend/app/services/quote_service.py:21-23`），**说明文案与后端校验阈值同源，不会漂移**。第 4 条（`:309-310`）声明排序号留空时的自动分配口径，第 7 条（`:313`）声明循环规则。
- `_ENABLED_ALIASES`（`:318`）：启用/是/1 → True；停用/禁用/否/0 → False；留空默认 True（`:353` 的 `.get(enabled_text, True)`）。
- `build_quote_template()`（`:321-323`）：数据表名「寄语数据」。被 `GET /api/admin/quotes/import-template` 调用（`backend/app/api/routes/admin.py:588`）。
- `_parse_quote_row(raw, nodes_by_name, node_ids)`（`:326-355`）：排序号非 `isdigit` → `ValueError("排序号", 原因)`（`:329-332`）；调用 `quote_service.check_fields` 做长度与非空校验（`:333`），并用「错误信息以字段名开头」的约定反查出错列名（`:335-336`）；启用状态非法 → `ValueError("启用状态", …)`（`:337-339`）；关联节点支持**节点 ID 或节点名称**两种写法，都不存在 → `ValueError("关联节点", "关联节点「X」不存在")`（`:340-348`）。返回 dict 中 `sort_order` 为 `None` 表示待自动分配（`:352`、docstring `:327`）。**本函数抛出的 `ValueError` 一律是两参 `(字段, 原因)`**，与调用点 `:373` 的 `*exc.args` 解包配对。
- `preview_quote_import(db, content, operator)`（`:358-392`）：一次查出全部路线节点建 `nodes_by_name` / `node_ids`（`:361-363`）、一次查出全部寄语文本建 `existing`（`:364`）；重复判定与题库同构（`:375-382`）；`_save_preview(db, "quote", …)`（`:385`）。
- `confirm_quote_import(db, token)`（`:395-410`）：内嵌 `_insert`，`db_max = max(DailyQuote.sort_order) or 0`（`:399`）、`file_max =` 本批已填排序号最大值（`:400`）、`next_order = max(db_max, file_max) + 1`（`:401`）；未填排序号的行按文件顺序依次取 `min(next_order, SORT_ORDER_MAX)` 并自增（`:402-406`）。`DailyQuote(**data)` **不显式指定 id**（`:407`），因为 `daily_quotes.id` 在库内是 `SERIAL PRIMARY KEY`（`docker/init/007_daily_quotes.sql:9`）。

## 5. 输入与输出

| 函数 | 入参 | 返回 | 抛出 |
|---|---|---|---|
| `build_question_template` / `build_quote_template` | 无 | `bytes`（.xlsx 内容） | 无 |
| `preview_question_import` / `preview_quote_import` | `db: Session`、`content: bytes`（已去头的 .xlsx 字节流）、`operator: str`（管理员用户名，写入 `created_by`） | `dict`：`preview_token` / `total` / `valid_count` / `invalid_count` / `errors`（`:280-286`、`:386-392`） | `ImportError`（文件级） |
| `confirm_question_import` / `confirm_quote_import` | `db: Session`、`token: str` | `int`（实际写入行数） | `ValueError`（业务级，6 种文案见 §4.3）、`inserter` 内任意异常（回滚后重抛） |

- 预览返回 dict 直接作为 `response_model=AdminImportPreviewOut` 的响应体（`backend/app/api/routes/admin.py:440`、`:593`；Schema 见 `backend/app/schemas/schemas.py:1123-1130`）。**该 Schema 继承 `BaseModel` 而非 `CamelModel`**，故输出为 snake_case，符合管理端契约。
- `total = valid_count + invalid_count`（`:282`、`:388`），即**文件级错误（表头不符等）不计入 total**——那类错误直接抛 `ImportError`，不产生预览。
- 确认返回值被路由包装为 `{"imported": n}`（`backend/app/api/routes/admin.py:466`、`:619`；Schema `backend/app/schemas/schemas.py:1137-1138`）。
- HTTP 错误码映射（路由层）：`ImportError` → **400**（`backend/app/api/routes/admin.py:451-452`、`:604-605`）；`ValueError` → **400**（`:464-465`、`:617-618`）；文件后缀非 `.xlsx` → 400（`:421-422`）；超 2MB → 400（`:424-425`）。
- 权限依赖：题库三个端点 `require_menu("questions")`（`backend/app/api/routes/admin.py:432`、`:446`、`:459`）；寄语三个端点 `require_menu("quotes")`（`:585`、`:599`、`:612`）。**预览端点把权限依赖写在参数上**（`admin: AdminPrincipal = Depends(require_menu(...))`）以便取 `admin.username` 作 `operator`，其余端点写在 `dependencies=[...]`。

## 6. 依赖关系

**依赖（import）**
- 标准库：`io`、`uuid`、`datetime`/`timedelta`、`typing`（`:12-15`）。
- 第三方：`openpyxl.Workbook` / `load_workbook`（`:17`，声明于 `backend/requirements.txt:12`）、`sqlalchemy.func`（`:18`）、`sqlalchemy.orm.Session`（`:19`）。
- ORM：`DailyQuote`、`ImportPreview`、`Question`、`RouteNode`（`:21`；定义于 `backend/app/models/models.py:81`、`:519`、`:126`、`:32`）。
- 服务层：`quote_service`（`:22`，取 3 个长度/排序常量与 `check_fields`）；`admin_service._validate_question`（`:23`）——**跨模块导入另一服务的私有（下划线）函数**，其定义在 `backend/app/services/admin_service.py:208-233`。
- 间接依赖：`python-multipart`（`backend/requirements.txt:13`）是 FastAPI 解析 `UploadFile = File(...)` 表单的底层包，**backend 代码中没有任何直接 `import multipart`**（全仓 grep 无命中）；两个上传端点在 `backend/app/api/routes/admin.py:444`、`:597`。

**数据库表**
| 表 | 访问方式 |
|---|---|
| `import_previews` | 预览阶段 INSERT（`:127-135`）；确认阶段 SELECT（`:151`）+ 条件 UPDATE（`:162-166`）。建表见 `docker/init/011_import_previews.sql`，含索引 `idx_import_previews_biz(biz_type, status)` |
| `questions` | 预览阶段全表 SELECT `question` 列（`:261`）；确认阶段批量 INSERT（`:295`） |
| `daily_quotes` | 预览阶段全表 SELECT `content` 列（`:364`）；确认阶段 `max(sort_order)`（`:399`）+ 批量 INSERT（`:407`） |
| `route_nodes` | 只读，全表 SELECT `id`/`name`（`:361`） |

**被依赖（唯一调用方）**
`backend/app/api/routes/admin.py`：import 于 `:90`；调用点 `:423-424`（两个常量）、`:435`（题库模板）、`:450-451`（题库预览 + `ImportError`）、`:463`（题库确认）、`:588`（寄语模板）、`:603-604`（寄语预览 + `ImportError`）、`:616`（寄语确认）。**无其它模块 import 本文件。**

**测试与前端**
- 冒烟脚本：`backend/test/s12_question_import.py`（题库导入，SQLite 临时库）、`backend/test/s17_quote_cycle_import.py`（寄语循环 + 导入）；结果产物 `backend/test/s12-question-import-results.json`、`backend/test/s17-quote-cycle-results.json`。索引见 `.qoder/backend/test/README.md:72-73`。
- 管理后台消费方：`admin/src/components/ExcelImportDialog.vue`（通过 `api: ExcelImportApi` prop 注入模板/预览/确认函数，同一组件复用于两类导入，见 `.qoder/ARCHITECTURE.md` §8.2）。

## 7. 业务规则

**校验规则汇总**

| 层级 | 规则 | 行号 |
|---|---|---|
| 文件级（抛 `ImportError` → 400，不产生预览） | 无法解析 / 空文件 / 表头与模板不一致 / 无数据行 / 有效行+错误行 > 500 | `:66-67`、`:72-73`、`:76-77`、`:102-103`、`:99-100` |
| 单元格级 | 首字符 `=` `+` `@`，或以 `-` 开头的非数值 → **整行判错** | `:51-54`、`:87-91` |
| 行级（题库） | 题型/分类别名映射、分值正整数、判断题答案映射、单选题答案唯一；最终由 `_validate_question` 收口（选项≥2、标签不重复、答案须在标签内、分值>0） | `:209-252`；`backend/app/services/admin_service.py:208-233` |
| 行级（寄语） | 内容与出处非空且 ≤200 字、排序号 0~999999、启用状态别名、关联节点须存在（ID 或名称） | `:326-355`；`backend/app/services/quote_service.py:99-110` |
| 批次级 | 与库内既有数据重复 → 整行判错；与文件内前序行重复 → 整行判错（**默认新增导入，不覆盖**） | 题库 `:270-275`；寄语 `:375-382` |

**失败行处理方式**：错误行**不阻断预览接口的返回**——预览照常生成令牌并落库，`errors` 全量回传给前端逐行展示（含 Excel 行号与列名）；真正的阻断发生在**确认阶段**（`:156-158`）：只要 `payload["errors"]` 非空，确认一律 `ValueError`。即「可预览、不可确认」，不存在部分成功导入。

**幂等与并发约束**
- 令牌一次性：条件 UPDATE `pending → confirmed`（`:162-166`）保证同一 token 并发/重复提交只有一个成功，其余得到「该导入已确认，请勿重复提交」（`:168`）。
- 令牌过期：30 分钟（`:27`、`:133`），过期后确认报「预览已过期」（`:154-155`），需重新上传。
- 写入失败可重试：`db.rollback()`（`:173`）同时撤销核销，令牌回到 `pending`。
- **预览阶段无去重令牌**：同一文件重复上传会生成多条 `import_previews` 行、多个 token，各自独立可确认。
- **确认阶段的重复数据检测有 TOCTOU 窗口**：重复判定发生在预览时（`:261`/`:364` 快照），确认时不再复检。若两次预览之间有人新增了同题干题目，确认仍会写入重复题干（`questions.question` 无唯一约束，`docker/init/001_schema.sql:16-24`）。

**事务边界（谁 commit）**
| 函数 | commit / rollback |
|---|---|
| `_save_preview` | **自己 commit**（`:136`） |
| `_confirm` | **自己 commit**（`:171`）/ 异常 rollback（`:173`） |
| `preview_*_import`、`confirm_*_import` | 通过上述两个内部函数提交，自身不额外 commit |
| `build_*_template` | 不触库 |

即：**本模块是「服务层自行 commit」的写入方**，路由层不参与事务。这与 `backend/AGENTS.md` §4 不变量 6（session 由 `Depends(get_db)` 提供、service 内不自建 session）不冲突——本模块只用注入的 session，不自建。

**审计**：本模块**不写审计日志**（无 `audit_service` 引用）。导入操作的留痕只有 `import_previews.created_by`（管理员用户名，`:132`）与 `confirmed_at`（`:165`）两列；正式表（`questions`/`daily_quotes`）不记录来源批次。

## 8. 修改约束
- **表头顺序即契约**：`_read_sheet:76` 按位置比对表头，改列名/列序必须同时改 `QUESTION_HEADERS`/`QUOTE_HEADERS` 与说明文案，并意识到**已下载到管理员本地的旧模板会立即失效**（报「表头与模板不一致」）。
- **不得改为部分成功导入**：这是 `.qoder/ARCHITECTURE.md` 不变量 13（`:693`）与 `.qoder/decisions/README.md:79` 登记的设计决定，`_confirm:156-158` 是唯一强制点，不要绕过。
- **令牌核销与业务写入必须保持在同一事务**（`:162-171`）：拆开会导致「令牌已核销但数据未写入」或「重复导入」。
- **寄语的 `ValueError` 必须两参**：`_parse_quote_row` 抛 `ValueError(字段, 原因)`，调用点 `:373` 用 `*exc.args` 解包成 `_fail(row, field, reason)`。若新增单参 `raise ValueError("...")`，会因缺位置参数在预览阶段抛 `TypeError`（500）。题库侧 `_parse_question_row` 相反，是单参 + `:267` 固定填空串 field——两侧不可混用。
- **id / sort_order 分配口径必须与既有新增接口一致**：题库 `max(id)+1`（`:293`）与 `backend/app/services/admin_service.py:175-176` 同源；`questions.id` 库内为 `INTEGER PRIMARY KEY` **无序列**（`docker/init/001_schema.sql:17`），ORM 也未声明 `autoincrement`（`backend/app/models/models.py:134`），因此不能简单删掉显式 id。
- **`_validate_question` 是跨模块私有函数**（`backend/app/services/admin_service.py:208`）：改其签名或校验口径会同时影响 `create_question`/`update_question`、AI 批量保存与本模块导入，须一并回归。
- 新增业务导入类型需同步：`biz_type` 取值、新的 `*_HEADERS`/`*_INSTRUCTIONS`/`_parse_*_row`/`preview_*`/`confirm_*` 五件套、`backend/app/schemas/schemas.py` 契约、`backend/app/api/routes/admin.py` 三个端点与菜单权限码、admin 侧 `ExcelImportDialog.vue` 的 api 注入。
- 上传大小/行数上限改动要同步路由层（`backend/app/api/routes/admin.py:423-425` 直接读本模块常量）与模板说明文案中的「单次最多 500 行」（`:186`、`:306`）。
- **不得把导入文件内容、管理员账号名等写入日志**：`payload` 里是整批业务数据（题干、寄语文本），`.qoder/README.md` §3.14 的敏感信息约束同样适用。

## 9. 当前实现状态

**已实现（可核对）**
- 题库导入完整闭环：模板下载 / 预览校验 / 确认写入（`:204-298`），三个端点均已挂载并带 `questions` 菜单权限。
- 寄语导入完整闭环：模板下载 / 预览校验 / 确认写入（`:321-410`），三个端点均已挂载并带 `quotes` 菜单权限。
- 公式注入拦截、2MB/500 行上限、30 分钟一次性令牌、条件 UPDATE 防重复确认、整批事务与回滚，全部有代码落点（见 §4、§7）。

**已知问题（事实陈述，均已登记且用户决定只记录不修改）**
1. **`confirm_question_import` 用 `max(id)+1` 分配主键且无并发保护**（`:293`）。并发导入、或导入与 `admin_service.create_question`/AI 批量保存同时进行，可分配到相同 id 触发主键冲突；此时 `_confirm` 回滚（`:172-174`）、令牌恢复 pending，整批失败但不产生脏数据。已登记为 `.qoder/PROJECT.md:254` 第 27 项、`.qoder/ARCHITECTURE.md:745`。
2. **`confirm_quote_import` 用 `max(sort_order)+1` 取排序号且无并发保护**（`:399-401`）。`daily_quotes.sort_order` **无唯一约束**（`docker/init/013_daily_quote_cycle.sql:8` 加列，`:37` 建的是非唯一索引 `ix_daily_quotes_cycle`），因此并发确认两批未填排序号的寄语**不会报错，只会静默产生重复排序号**；展示侧按 `(sort_order, id)` 升序兜底（模板说明第 4 条 `:309-310`、迁移注释 `docker/init/013_daily_quote_cycle.sql:4`）。
3. **排序号触顶静默截断**：`min(next_order, SORT_ORDER_MAX)`（`:405`）。当库内已存在 `sort_order = 999999` 时，后续所有未填排序号的行都会落 999999，既不报错也不提示。
4. **预览阶段全表加载**：`:261` 全表读 `questions.question`、`:364` 全表读 `daily_quotes.content`、`:361` 全表读 `route_nodes`。当前量级（种子 15 题、10 节点）无影响；数据量增长后是内存与查询开销点，且与 `MAX_ROWS=500` 的单批上限无关（重复检测必须比对全库）。
5. **表头单元格自身的公式注入未被 `ImportError` 覆盖**：`:74` 对表头行调用 `_cell_text`，若表头单元格以 `=`/`+`/`@` 开头会抛 `ValueError`，而两个预览端点只捕获 `import_service.ImportError`（`backend/app/api/routes/admin.py:451`、`:604`），结果是 500 而非 400。触发前提是人为篡改模板表头。
6. **`import_previews` 无清理路径**：全仓对 `ImportPreview` 的写操作只有本模块的 INSERT（`:127-135`）与状态 UPDATE（`:162-166`），**没有任何 DELETE**（grep `ImportPreview|import_previews` 仅命中本文件、`backend/app/models/models.py:519-536`、`docker/init/011_import_previews.sql` 与 schema/路由的引用）。过期行与已确认行永久留存，`payload` 内含整批业务数据。
7. `class ImportError`（`:30`）在模块作用域遮蔽同名内置异常（现状记录，当前无实际影响）。

**未实现 / 文档滞后**
- **`biz_type = "staff"`（人员导入）不存在**：本文件只注册了 `question` 与 `quote` 两类。但 `backend/app/models/models.py:520`、`:524` 的 `ImportPreview` docstring 与 `docker/init/011_import_previews.sql:3` 注释都写了「题库/寄语/**人员**」，`.qoder/PROJECT.md:268` 已登记该 docstring 滞后。另需注意 **`.qoder/REQUIREMENTS.md:562`「Excel 批量导入人员｜已实现，两阶段（预览 → 确认）｜`services/import_service.py`」与代码不符**——`backend/app` 内无人员导入代码路径（grep `staff`/`人员导入`/`名册` 仅命中 `models.py:520`、`:524`），`persons` 表本身也没有创建路径（`.qoder/PROJECT.md:347`）。该需求是「计划后取消」还是「待开发」——**待确认**。
- 覆盖导入模式（与库内重复时更新而非判错）未实现，docstring `:8` 的「默认新增导入模式」暗示曾有此设想——**待确认**（无对应需求文档或提交记录）。

**行号引用偏差（供交叉核对）**
- `.qoder/decisions/README.md:79` 与 `.qoder/REQUIREMENTS.md:614` 把「任一行出错则整批阻断」的依据标为 `import_service.py:280-286`；该区间是 `preview_question_import` 的返回统计段（错误**回传**格式），实际**阻断强制点**在 `_confirm:156-158`。`.qoder/ARCHITECTURE.md:431` 用 `:280-286` 指「错误回传格式」是准确的。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/import_service.py`（**2 个提交**）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-11
- 需求：每日寄语改为「排序号 + 启用状态」按天循环展示（需求 §16、V1.1 功能二），并支持 Excel 批量导入。
- 修改内容：`d6acf7e` 在本文件追加寄语导入段（+114 行 / -1 行，唯一删除行是 `:21` 的 ORM import 由 `ImportPreview, Question` 扩为 `DailyQuote, ImportPreview, Question, RouteNode`）：新增 `:22` 的 `quote_service` 依赖、`QUOTE_HEADERS`（`:302`）、`QUOTE_INSTRUCTIONS`（`:304-316`）、`_ENABLED_ALIASES`（`:318`）、`build_quote_template`（`:321-323`）、`_parse_quote_row`（`:326-355`）、`preview_quote_import`（`:358-392`）、`confirm_quote_import`（`:395-410`）。通用框架（`_cell_text`/`_read_sheet`/`_build_workbook`/`_save_preview`/`_confirm`）未改动，直接复用。
- 关联文件：`backend/app/api/routes/admin.py`（3 个寄语导入端点）、`backend/app/services/quote_service.py`、`backend/app/services/setting_service.py`、`backend/app/schemas/schemas.py`、`docker/init/013_daily_quote_cycle.sql`、`admin/src/components/ExcelImportDialog.vue`（抽取为通用组件供题库复用）、`backend/test/s17_quote_cycle_import.py`；删除 `backend/test/p2_quotes.py`。
- 测试结果（`docs/迭代记录.md` 该条目「验证」原文）：**S17 13/13，S12 11/11，admin `npm run build` 通过**；浏览器验收通过（新起后端 8011 + admin 5174）：今日位置计算、模板下载、错误导入与错误报告、重新选择文件、确认导入、行内启停、修改起始日期、编辑、删除、题库导入回归；**迁移 013 已应用到本地 openGauss**。报告：`backend/test/docs/s17-quote-cycle-import-report.md`、`admin/test/docs/s17-quote-cycle-import-admin-report.md`。

### 2026-10-10
- 需求：V1.1 功能一——题库支持 Excel 模板下载与批量导入，题库列表改服务端分页。
- 修改内容：`54ea125` 创建本文件（297 行）：通用约定 docstring、`MAX_FILE_SIZE`/`MAX_ROWS`/`PREVIEW_TTL_MINUTES` 三常量、`ImportError`、`_fail`、`_cell_text`（含整数型 float 还原与公式注入拦截）、`_read_sheet`、`_build_workbook`、`_save_preview`、`_confirm`（条件 UPDATE 抢占 + 整批事务），以及题库五件套（`QUESTION_HEADERS`/`QUESTION_INSTRUCTIONS`/`build_question_template`/`_parse_question_row`/`preview_question_import`/`confirm_question_import`）。
- 关联文件：`docker/init/011_import_previews.sql`（新建 `import_previews` 表与 `idx_import_previews_biz` 索引）、`backend/app/models/models.py`（`ImportPreview`，+20 行）、`backend/app/schemas/schemas.py`（`AdminImportErrorRow`/`AdminImportPreviewOut`/`AdminImportConfirmRequest`/`AdminImportConfirmOut`，+27 行）、`backend/app/api/routes/admin.py`（+72 行：`_xlsx_response`、`_read_import_file` 与 3 个题库导入端点）、`backend/app/services/admin_service.py`、`backend/requirements.txt`（新增 `openpyxl>=3.1.0`、`python-multipart>=0.0.9`）、`backend/test/s12_question_import.py`（220 行）、`admin/src/api/admin.ts`、`admin/src/views/QuestionsView.vue`。
- 测试结果（`docs/迭代记录.md` 该条目「验证」原文）：**S12 后端冒烟 11/11**（`backend/test/s12_question_import.py`，SQLite 临时库）；**admin `npm run build` 通过**。当时明确记录：**Docker/openGauss 未启动，迁移 011 落库与浏览器验收「待验证」**；且「按用户要求，批量导入的正式使用待准入机制完成后开放」。（后续 openGauss 侧落库与浏览器验收在 `d6acf7e` 条目中随寄语导入一并完成；迁移 011 本身是否单独做过 openGauss 落库验证——`docs/迭代记录.md` 未见专门记录，**待确认**。本机开发库 `schema_migrations` 已登记 001→022 全部 22 个迁移。）
