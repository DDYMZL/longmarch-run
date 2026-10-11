# S17 每日寄语按天循环与 Excel 导入 · 后端测试报告

- 日期：2026-10-11
- 范围：backend（迁移 013、quote_service / setting_service / import_service、`/api/quotes/today`、`/api/admin/quotes*`）
- 脚本：`backend/test/s17_quote_cycle_import.py`（FastAPI TestClient + 临时 SQLite，自动跑 `init_seed` 后清空寄语表），结果 `s17-quote-cycle-results.json`
- 替代：原 `p2_quotes.py`（按日期取寄语、日期唯一）规则已废弃，脚本删除；`p2-quotes-report.md` 仅作历史记录

## 1. 变更要点

| 项 | 说明 |
| --- | --- |
| 数据模型 | `daily_quotes` 去掉 `date`，新增 `sort_order`（0~999999）、`is_enabled`，索引 `(is_enabled, sort_order, id)`；新表 `system_settings` 存 `quote_cycle_start` |
| 迁移 013 | 按原 `date, id` 顺序回填排序号 1..N、全部置为启用；循环起始日期取原寄语最早日期（空表取当天）；本地 openGauss 已执行并登记 `schema_migrations`，5 条寄语排序号 1~5、起始日 2026-10-01 |
| 今日寄语 | 启用寄语按 `(sort_order, id)` 升序共 N 条，取第 `(今天 − 起始日).days % N` 条（`OFFSET` 单行查询，不全量加载）；起始日在未来取第 1 条；无启用寄语返回 `null`（原实现空表 500） |
| 循环设置 | `GET/PUT /api/admin/quotes/cycle`：起始日期、启用条数、今日寄语 id 与序号 |
| Excel 导入 | 模板（寄语数据 + 填写说明 9 条）→ 预览校验（错误定位到行与字段；库内/文件内重复判错、不覆盖）→ 令牌一次性确认；排序号留空的行接在库内与文件内已填排序号最大值之后 |
| 复用 | 路由层抽取 `_xlsx_response` / `_read_import_file`（扩展名与 2MB 校验），题库与寄语导入共用；`check_fields` 同时服务于管理端表单与导入逐行校验 |

## 2. 用例结果（13/13 通过）

| 编号 | 场景 | 结果 |
| --- | --- | --- |
| C01 | 无启用寄语：today 200 返回 null，cycle.enabled_count=0 | 通过 |
| C02 | 模板下载：xlsx 两个工作表（寄语数据/填写说明），表头 寄语内容/出处/排序号/启用状态/关联节点 | 通过 |
| C03 | 合法导入：统计正确；节点按名称/ID 解析；「停用」写入 is_enabled=False；空排序号接在最大值之后（与文件内显式排序号不冲突） | 通过 |
| C04 | 同一预览令牌重复确认 400「该导入已确认，请勿重复提交」 | 通过 |
| C05 | 错误行定位到行与字段：内容为空（寄语内容）/排序号非法（排序号）/启用状态非法（启用状态）/节点不存在（关联节点）/库内重复/文件内重复/公式注入；含错批次确认 400 | 通过 |
| C06 | 非 .xlsx 文件、表头与模板不一致 400 | 通过 |
| C07 | 按天循环：起始日当天第 1 条、次日第 2 条、第 3 天第 3 条，末条后回到第 1 条；起始日在未来兜底第 1 条 | 通过 |
| C08 | 同一天不同用户、重复请求得到同一条；date 为当天，含出处与关联节点 | 通过 |
| C09 | 停用寄语不参与循环，按最新启用列表重算序号 | 通过 |
| C10 | 排序号相同按 id 升序；修改排序号后按新顺序展示 | 通过 |
| C11 | 删除循环中的寄语不越界；仅剩一条时每天都展示该条 | 通过 |
| C12 | 管理端校验：内容为空 / 排序号越界 / 节点不存在 / 起始日期格式非法 400，不存在 404，正常新增 200 | 通过 |
| C13 | 鉴权：today 无 token 401；小程序用户 token 访问管理端 401 | 通过 |

## 3. 回归

| 项目 | 结果 |
| --- | --- |
| `s12_question_import.py`（题库导入，路由层重构后） | 11/11 通过 |
| 本地 openGauss 实库（新起 :8011 进程）：`/openapi.json` 含 cycle/import-template/import-preview/import-confirm 路由；管理端浏览器全流程（见 `admin/test/docs/s17-quote-cycle-import-admin-report.md`） | 通过 |

## 4. 注意

- 运行中的 8010 后端若是迁移前启动的旧进程，仍在查询已删除的 `daily_quotes.date` 列，**必须重启**后寄语接口才正常。
