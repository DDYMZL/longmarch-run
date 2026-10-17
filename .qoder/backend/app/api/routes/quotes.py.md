# quotes.py

## 1. 文件路径

`backend/app/api/routes/quotes.py`（21 行）

## 2. 文件职责

小程序「每日寄语」域的 HTTP 路由层：单端点返回今日寄语。按天循环选取逻辑全部在 `quote_service`；本文件只做鉴权注入与传入北京时间当日日期串。

## 3. 业务需求

- 每日寄语（需求 §16、V1.1 功能二，`quotes.py:1` 模块 docstring）：每天给全体用户展示同一条寄语。
- V1.1 之后改为**按天循环**展示（提交 `d6acf7e`，2026-10-11，配套迁移 `docker/init/013_daily_quote_cycle.sql`）：不再按日期一对一匹配，寄语池用完后从头循环。
- 创建于提交 `71d1b9b`（2026-10-03，P2-1 每日寄语与节点纪念票）。

## 4. 核心功能

### 4.1 端点清单（1 个，与 `app.openapi()` 实测一致）

路由前缀 `/quotes`（`quotes.py:14`），经 `backend/app/main.py:83` 以 `/api` 前缀挂载。

| 方法 | 完整路径 | 函数名 | 行号 | 鉴权依赖 | response_model |
|---|---|---|---|---|---|
| GET | `/api/quotes/today` | `today` | `quotes.py:17-20` | `get_current_user`（**仅登录，无活动闸门**） | `Optional[QuoteTodayOut]`（`backend/app/schemas/schemas.py:337-344`；无启用寄语时返回 `null`） |

无查询/路径参数。路由层调 `today_str()` 取北京时间当日日期串传入 service（`quotes.py:12` import、`:20`；`backend/app/core/helpers.py:22-24`）。

### 4.2 调用的 service 函数

| 路由 | service 调用 | 位置 |
|---|---|---|
| `today` | `quote_service.get_today(db, today_str())` | `backend/app/services/quote_service.py:72`（选取核心 `_pick` `:59-69`，循环起点 `get_cycle_start` `:48-49`） |

### 4.3 按天循环规则（规则位置在 service，此处摘要）

- 启用寄语（`is_enabled`）按 `(sort_order, id)` 升序共 N 条；今日索引 = `(today - start).days % N`（`quote_service.py:59-69`，模块 docstring `:1-7`）。
- `today < start` 时取第 1 条（`quote_service.py:67`）。
- 循环起点 `start` 存 `system_settings.quote_cycle_start`（`get_cycle_start` `:48-49` 经 `setting_service.get_value` `:10`）；无配置时兜底 `DEFAULT_CYCLE_START = "2026-10-01"`（`:20`）。
- N=0（无启用寄语）返回 `None` → 响应 `null`。
- **同日全用户一致**：结果只取决于日期，无随机、无定时任务、不受服务重启影响（纯函数式推导）。
- 输出 `{id, date, content, source, node}`，`node` 为关联路线节点名（`quote_service.py:77-81`），供前端跳转节点详情。

### 4.4 迁移 013 要点（`docker/init/013_daily_quote_cycle.sql`）

- `daily_quotes` 加 `sort_order`/`is_enabled` 列，按原 `date` 列 `ROW_NUMBER` 回填 `sort_order`；
- 建 `system_settings` 表并写入 `quote_cycle_start = COALESCE(MIN(date), 迁移当天)`；
- **DROP `date` 列**（寄语与日期解耦）；建 `ix_daily_quotes_cycle` 索引。
- 历史包袱：013 使用了如今被项目禁用的 `ADD/DROP COLUMN IF NOT EXISTS` 语法（openGauss 兼容问题，`.qoder/ARCHITECTURE.md` §12.4），新迁移不得模仿。

### 4.5 事务边界与异常转换

- 只读端点，service 无 commit；session 由 `Depends(get_db)` 注入（不变量 6）。
- 无 try/except，无 400/404 路径：查无启用寄语不是错误，返回 `null`（200）。

### 4.6 鉴权档位说明

挂 `get_current_user` 而非 `require_activity_view`（`quotes.py:18`）：寄语是静态运营内容，与用户业务数据和活动状态无关，与 `persons.py` 同档位。是否需统一到 view 档见 §9。

## 5. 输入与输出

- 输入：无参数；身份取自 JWT（仅鉴权，不影响选取结果）；日期由服务端 `today_str()` 决定（北京时间业务日切，客户端无法指定日期）。
- 输出（camelCase，`CamelModel`，`schemas.py:17-22`）：`QuoteTodayOut`＝`id/date/content/source/node`（`schemas.py:337-344`），或 `null`。
- 错误码：401（令牌无效）；403（账号停用 `X-Account-Status: disabled`，`backend/app/api/deps.py:17-53`）。

## 6. 依赖关系

- **依赖模块**：`app.api.deps`、`app.core.database`、`app.core.helpers.today_str`、`app.models.models.User`、`app.schemas.schemas`（1 个模型）、`app.services.quote_service`（`quotes.py:2-12`）。
- **service 层再依赖**：`setting_service.get_value`（读 `system_settings`）、`route_nodes`（node 名关联）。
- **数据库表**：`daily_quotes`（只读）、`system_settings`（只读）、`route_nodes`（只读）。
- **被谁依赖**：`backend/app/main.py:83` 注册；小程序 `frontend/services/quote.js:11`。寄语维护（增删改）走管理端 admin 路由，不经本文件。

## 7. 业务规则

1. **同日全员一致**：索引只由日期与配置决定，任何用户任何时刻请求结果相同。
2. **循环不重复配置**：寄语池按 `sort_order` 循环，用尽自动回到第 1 条；换池只需管理端改寄语与（必要时）`quote_cycle_start`。
3. **业务日切为北京时间**：`today_str()`（`helpers.py:22-24`），与步数/答题的日切口径一致。
4. **空池降级**：无启用寄语返回 `null`（200），前端隐藏寄语卡片，不算故障。
5. **date 字段是「今日日期」而非寄语属性**：013 迁移后 `daily_quotes` 无 date 列，响应中的 `date` 即请求日。

## 8. 修改约束

1. **事务边界：无 commit**——本文件只读；寄语写入在管理端路由/service，不得在本文件加写操作。
2. `today_str()` 必须在**路由层调用并传参**（`quotes.py:20`），service 不自取当前时间——这是可测试性设计（测试可传任意日期），勿改成 service 内部 `today_str()`。
3. `response_model=Optional[QuoteTodayOut]`（`quotes.py:17`）：去掉 Optional 会让空池场景 500，勿动。
4. 循环公式（`quote_service.py:59-69`）与 `quote_cycle_start` 配置耦合，改公式需评估已上线的 `system_settings` 值（013 迁移写入的历史 MIN(date)）。
5. 新迁移禁止使用 `ADD/DROP COLUMN IF NOT EXISTS`（013 的历史包袱，openGauss 兼容约定见 `.qoder/ARCHITECTURE.md` §12.4）。

## 9. 当前实现状态

- **已实现**：1 个端点可用；循环展示、空池降级、节点关联齐备。
- **存在问题 / 已知不一致**：
  1. 鉴权档位为 `get_current_user`（无活动闸门），与多数业务端点 view 档不同；因属静态运营内容，现状可接受，是否需统一**待确认**。
  2. 迁移 `013` 使用被禁的 `IF NOT EXISTS` 列语法（历史包袱，`.qoder/ARCHITECTURE.md` §12.4），保留不改，仅约束新迁移。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/api/routes/quotes.py`（2 个提交，2026-10-17 核对）。按时间倒序。

### 2026-10-11（`d6acf7e`）

- 需求：每日寄语改为按天循环展示。
- 修改内容：本文件改传 `today_str()`、response_model 改 `Optional`；选取逻辑移入 `quote_service._pick` 循环索引。
- 关联文件：`backend/app/services/quote_service.py`、`docker/init/013_daily_quote_cycle.sql`（加 sort_order/is_enabled、建 system_settings、DROP date 列）。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。

### 2026-10-03（`71d1b9b`）

- 需求：P2-1 每日寄语与节点纪念票。
- 修改内容：创建本文件（初版按日期匹配寄语）。
- 关联文件：`backend/app/services/quote_service.py`、`docker/init/007_daily_quotes.sql`。
- 测试结果：见 `docs/迭代记录.md` 该提交条目。
