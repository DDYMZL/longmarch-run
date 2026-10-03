# P2-1 每日寄语（后端侧）测试报告

日期：2026-10-03 · 范围：每日寄语数据模型与接口（需求 §16）

## 改动摘要

- `docker/init/007_daily_quotes.sql`（已应用到运行库并登记 schema_migrations）
  - 新建 `daily_quotes`（id 自增主键 / date VARCHAR(10) 唯一 / content TEXT / source VARCHAR(200) / node_id 可空外键 → route_nodes）。
- `app/models/models.py`：新增 `DailyQuote`（与 SQL 同步，未用 create_all）。
- `app/data/seed.py`：新增 `QUOTES`（5 条有明确出处的毛泽东著作语录，2026-10-01..05，按语义关联路线节点，不虚构）；`_seed_quotes` 仅空表写入，之后完全交由后台维护。
- `app/services/quote_service.py`（新增）：
  - `get_today`（§16.2 展示规则：当天优先，否则最近一条 date <= today；都没有则不展示）；
  - 管理端：`list_quotes`（日期倒序分页，节点名批量查询无 N+1）、`validate_quote`（日期格式/非空/节点存在性）、`date_taken`（日期唯一友好提示）、`create_quote` / `update_quote` / `delete_quote` / `get_admin_out`。
- `app/api/routes/quotes.py`（新增）：`GET /api/quotes/today`（无寄语返回 null）；`app/api/routes/admin.py`：新增 `/api/admin/quotes` CRUD（日期冲突/坏日期/坏节点 400，寄语不存在 404）。
- `app/schemas/schemas.py`：`QuoteNodeRefOut` / `QuoteTodayOut`（小程序 camelCase）；`AdminQuoteOut` / `AdminQuoteListOut` / `AdminQuoteUpsert`（管理端 snake_case）。
- `app/main.py` 注册 quotes 路由。

## 设计取舍

- **内容为运营数据而非静态配置**：题库/勋章是「空表种子 + 后台可改」，寄语更进一步——种子仅在空表写入示例，非空表一律不动（尊重后台每日维护成果，不复活被删寄语）。
- **回退规则在后端**：前端不判断「今天有没有」，直接展示接口返回值；无当天寄语时由后端回退到最近一条更早寄语，保证多端口径一致（§28 后端为唯一事实源）。
- **日期用 VARCHAR(10) 字符串**：与业务「某一天一条」语义一致，唯一约束直接落在 date 上，避免时区换算问题。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P2A-01 | 今日寄语：date/content/source 非空，date 不晚于今天，关联节点含 id/name | 通过 |
| P2A-02 | 回退规则：删除当天寄语 → 回退到最近一条更早寄语；恢复后回到当天 | 通过 |
| P2A-03 | 管理端 CRUD：新增（带节点名）/日期冲突与坏参数 400/编辑/分页列表/删除/删后 404 | 通过 |
| P2A-04 | 鉴权：today 无 token 401；admin/quotes 无 token 401、普通用户 token 401 | 通过 |

执行：`python test/p2_quotes.py` —— **4/4 通过**。

回归：`python test/p1_persons.py` 4/4、`python test/p1_portrait.py` 3/3。

## 备注

- P2A-02 会真实删除并重建当天寄语（id 变化），属测试自恢复设计。
- 种子 5 条：10-01《七律·长征》→ 延安、10-02《忆秦娥·娄山关》→ 四渡赤水、10-03《清平乐·六盘山》→ 吴起镇、10-04《论反对日本帝国主义的策略》→ 延安、10-05《七律·长征》→ 翻越雪山。
