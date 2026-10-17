# seed.py

## 1. 文件路径

`backend/app/data/seed.py`（424 行，UTF-8、LF 行尾；8 个模块级常量 + 6 个函数，无类定义）

行号锚点（均以带行号的 Read 输出核对）：

| 内容 | 行号 |
|---|---|
| 模块 docstring | `:1-8` |
| `from sqlalchemy.orm import Session` | `:9` |
| `from app.models.models import ...`（7 个模型） | `:11` |
| `PERSONS` / `PERSON_NODES` | `:16-30` / `:33-42` |
| `QUOTES` | `:47-78` |
| `ROUTE_NODES` | `:84-195` |
| `QUESTION_BANK` | `:200-276` |
| `MEDALS` / `MEDAL_NODE_MAP` | `:282-311` / `:314` |
| `ORGANIZATIONS` | `:318-332` |
| `_NODE_CONTENT_FIELDS` | `:335` |
| `_fill_empty` | `:338-341` |
| `_seed_route_nodes` / `_seed_questions` / `_seed_medals` / `_seed_persons` / `_seed_quotes` | `:344-355` / `:358-367` / `:370-383` / `:386-402` / `:405-412` |
| `init_seed`（含末行 `db.commit()`） | `:415-424`（`:424`） |

## 2. 文件职责

7 张静态配置表（`route_nodes` / `questions` / `medal_defs` / `persons` / `person_nodes` / `daily_quotes` / `organizations`）的**唯一数据来源**，并在应用启动时以幂等方式写入数据库。

「唯一来源」经实测确认：`docker/init/` 的 22 个迁移脚本只建表、不插数据 —— `grep -rn "INSERT INTO route_nodes\|INSERT INTO questions\|INSERT INTO medal_defs\|INSERT INTO organizations\|INSERT INTO persons\|INSERT INTO person_nodes\|INSERT INTO daily_quotes" docker/init/*.sql` **0 命中**（对比：`admin_menus` / `admin_roles` 确实由 `docker/init/010_admin_identity.sql:106`、`:118` 插入）。因此这 7 张表若不经 `init_seed`，建库后就是空表。

模块 docstring（`:1-8`）自我定义了幂等契约：「表为空时全量写入；表非空时仅『补空值/补新勋章 id』——节点历史内容、题目分类只填空字段，尊重管理端已做的编辑与删除（不复活被删节点/题目）」。

此外本文件还向两个服务层导出常量：`MEDALS` / `MEDAL_NODE_MAP` 被 `medal_service` 直接当作**运行时判定表与展示顺序表**使用，`ORGANIZATIONS` 被 `admin_service` 当作**组织同步的降级数据源**使用（详见 §6.2）。这两处不是「只在启动时读一次」，改常量会立即改变线上业务行为。

## 3. 业务需求

- `backend/AGENTS.md` §4 架构不变量 3「种子幂等」，原文：「`data/seed.py` 的写入必须幂等（**按主键存在即跳过**），重复启动不得产生重复数据。」——「重复启动不得产生重复数据」这半句实现成立；「按主键存在即跳过」这半句**与实现不完全一致**：`route_nodes` / `questions` / `medal_defs` / `persons` 在主键已存在时并非直接跳过，而是走 `_fill_empty` 回填空字段（`:354-355`、`:366-367`、`:381-383`、`:397`），`person_nodes` 更是缺失即补插（`:400-402`）。详见 §7.1 的幂等边界表。
- `backend/AGENTS.md` §4 不变量 8「表结构单一来源」：`docker/init/*.sql` 是结构的执行来源，禁止 FastAPI 启动流程自动建表——与 §2「本文件只插数据、不建表」的分工一致。
- `.qoder/ARCHITECTURE.md` §13.3（`:676-681`）种子链表已列出「10 个路线节点（id 1-10）、15 道题（id 1-15）、12 枚勋章、13 位人物、5 条金句（仅在表空时写入）、13 个组织（id 1-13）」，与本文 §4.1 的实测条数**逐项一致**；§16.1（`:750` 起）已验证决策「非自增主键的 id 分配一律 `max(id)+1`，无并发保护」——其成立前提就是本文件占用了 `questions.id` 1-15、`route_nodes.id` 1-10、`persons.id` 1-13、`organizations.id` 1-13 这些固定 id。
- 文件内注释直接标注的需求编号（可逐条核对原文）：
  - `:13`「长征人物志（需求 §14）」、`:14-15`「人物来源于节点 figures 字段中的真实历史人物（群体表述如「全体红军指战员」不单列）；简介仅采用公开史料记载，不虚构；avatar 留空由前端展示姓名首字占位」
  - `:44`「每日寄语（需求 §16）」、`:45-46`「仅收录有明确出处的公开史料/著作语录，不虚构」「寄语由后台维护（/admin/quotes），按 sort_order 循环展示；种子仅在建库空表时写入示例」
  - `:81`「target_steps 为累计步数要求；节点一旦点亮永久保留」
  - `:198-199`「type: single 单选 / judge 判断；每题 score 分」「category 知识画像分类：event 历史事件 / route 长征路线 / figure 历史人物」
  - `:279-281`「判定逻辑在 services/medal_service.check_and_grant 中实现」「category: starter 入门 / route 路线 / challenge 挑战 / complete 完成；hidden 为 True 的勋章未获得时不公开获取条件」
  - `:317`「parent_id 为空表示顶级；level 为层级深度」
  - `:334`「节点历史事件卡内容字段（种子仅补空值，尊重管理端编辑）」

## 4. 核心功能

### 4.1 常量清单与真实条数

条数由 AST/运行时实测（`len()`）得出，**不是抄注释**：

| 常量 | 行号 | 真实条数 | 目标表 | 主键形态 | 注释里的数字是否一致 |
|---|---|---|---|---|---|
| `ROUTE_NODES` | `:84-195` | **10** | `route_nodes` | 显式 `id` 1-10（连续、唯一） | 一致（`:80`「10 个」） |
| `QUESTION_BANK` | `:200-276` | **15** | `questions` | 显式 `id` 1-15（连续、唯一） | 一致（`:197`「15 题」） |
| `MEDALS` | `:282-311` | **12** | `medal_defs` | 显式字符串 `id` | 一致（`:278`「12 个」）；但 `backend/AGENTS.md:39` 仍写「勋章 6」→ 见 §9 |
| `MEDAL_NODE_MAP` | `:314` | **2** 项 | —（内存映射） | — | 一致 |
| `ORGANIZATIONS` | `:318-332` | **13** | `organizations` | 显式 `id` 1-13（连续、唯一） | 注释未给数字 |
| `PERSONS` | `:16-30` | **13** | `persons` | 显式 `id` 1-13（连续、唯一） | 注释未给数字 |
| `PERSON_NODES` | `:33-42` | **22** 对（去重后仍 22） | `person_nodes` | 复合主键 `(person_id, node_id)` | 注释未给数字 |
| `QUOTES` | `:47-78` | **5** | `daily_quotes` | **不给 id**（DDL 为 `SERIAL`） | 注释未给数字 |
| `_NODE_CONTENT_FIELDS` | `:335` | **7** 个字段名 | —（元组） | — | 注释未给数字 |

内容分布（实测统计，供数据校对）：

- 题库 15 题：`single` 10 / `judge` 5；`category` 分布 `event` 7 / `route` 6 / `figure` 2；`score` 全部为 20；`answer` 全部单元素；`options` 长度为 4（单选）或 2（判断）。
- 勋章 12 枚：`category` 分布 `starter` 3 / `route` 2 / `challenge` 6 / `complete` 1；`sort_order` 为 1-12 连续；`hidden=True` 只有 `fearless`（`:306-307`）；id 顺序为 `first-step, learner, persistence, luding, snow, day-10k, steps-100k, steps-500k, streak-30, master, fearless, victory`。
- 路线节点 10 个：`target_steps` 为 `0, 5000, 10000, 15000, 20000, 25000, 35000, 45000, 55000, 65000`（严格递增，`sort_order` 与 `id` 同序 1-10），`is_enabled` 全部 `True`，坐标齐全。
- 人物关联 22 对：覆盖节点 `1,2,3,4,5,6,9,10`；**节点 7（翻越雪山）与节点 8（过草地）无人物关联** —— 与 `:14-15` 注释一致（这两节点 `figures` 为「全体红军指战员」群体表述，不单列人物）。所有 `person_id` 均在 `PERSONS` 中、所有 `node_id` 均在 `ROUTE_NODES` 中（无悬挂引用）。
- 组织树 13 节点：层级分布 `level 1` 1 个 / `level 2` 3 个 / `level 3` 7 个 / `level 4` 2 个；`parent_id` 取值 `{None, 1, 2, 3, 4, 6}`，全部指向表内存在的 id；`sort_order` 在**同父节点内**从 1 开始（不同父下可重复，如 id 5 与 id 8 的 `sort_order` 都是 1）；存在**同名不同父**节点（「市场部」id 5/id 8、「技术部」id 6/id 9）。
- 每日寄语 5 条：`sort_order` 1-5，`node_id` 取值 `{10, 3, 9, 10, 7}`，全部指向存在的节点。

### 4.2 常量键与模型列的差集（决定哪些字段走数据库默认值）

逐个把常量 dict 的键集与 `models.py` 的表列集做差（实测）：

| 常量 | 键数 | 模型列数 | 模型有、常量无的列 | 后果 |
|---|---|---|---|---|
| `ROUTE_NODES` | 17 | 17 | 无 | 完全匹配 `RouteNode`（`models.py:42-58`） |
| `QUESTION_BANK` | 8 | 9 | `active` | 走模型默认 `True`（`models.py:142`）。该列由迁移 `020_question_rotation.sql:6` 新增，**缺 020 的库启动即崩**（见 §7.6） |
| `MEDALS` | 7 | 7 | 无 | 完全匹配 `MedalDef`（`models.py:154-160`） |
| `PERSONS` | 3 | 4 | `avatar` | 走模型默认 `None`（`models.py:68`），即 `:15` 注释所说「avatar 留空由前端展示姓名首字占位」 |
| `PERSON_NODES` | 2 | 2 | 无 | 复合主键两列都显式给 |
| `QUOTES` | 4 | 6 | `id`、`is_enabled` | `id` 由 `SERIAL` 分配（`007_daily_quotes.sql:9`）；`is_enabled` 走模型默认 `True`（`models.py:95`） |
| `ORGANIZATIONS` | 5 | 5 | 无 | 完全匹配 `Organization`（`models.py:171-175`） |

「常量有、模型无」的键：**0 个**（若有会在 `Model(**dict)` 处抛 `TypeError`）。

### 4.3 `_fill_empty`（`:338-341`）—— 幂等的原子操作

```python
def _fill_empty(row: object, field: str, value: object) -> None:
    """仅当库中字段为空时回填（空串 / None / 空列表视为空）。"""
    if not getattr(row, field, None):
        setattr(row, field, value)
```

三点值得注意：

1. 判空用 Python 真值，因此 `None`、`''`、`[]`、`0`、`False` **一律视为空**。对 `_NODE_CONTENT_FIELDS` 的 7 个内容字段（字符串/JSON 列表）是安全的；但同一函数被 `_seed_medals:381` 用于 `category`（字符串，安全）。`sort_order` 的「0 视为空」没有走 `_fill_empty`，而是在 `:382` 用 `if not row.sort_order` 单独判断——效果相同，写法不同。
2. `getattr(row, field, None)` 带默认值，字段名写错时**不会报错、静默不回填**。这是修改 `_NODE_CONTENT_FIELDS` 时的隐性风险（见 §8）。
3. 只写 ORM 属性、不 commit，靠脏检查在 `init_seed:424` 的统一 `db.commit()` 落盘。

### 4.4 六个函数与各自的幂等策略

`init_seed`（`:415-424`）依次调用 5 个私有 seeder，再内联处理组织表，最后**只 commit 一次**：

```
_seed_route_nodes(db)   # :417
_seed_questions(db)     # :418
_seed_medals(db)        # :419
_seed_persons(db)       # :420
_seed_quotes(db)        # :421
if db.query(Organization).count() == 0: db.add_all(...)   # :422-423
db.commit()             # :424
```

**幂等策略矩阵**（这是本文件最重要的一张表；「覆盖」= 会改掉库里已有的非空值）：

| 表 | 函数/行号 | 空表时 | 非空表时 | 覆盖已有非空值？ | 复活被删行？ |
|---|---|---|---|---|---|
| `route_nodes` | `_seed_route_nodes` `:344-355` | 全量写入 10 行（`:346-348`） | 遍历库中**全部**行，只对 `id ∈ 1-10` 的行按 `_NODE_CONTENT_FIELDS` 7 字段 `_fill_empty`（`:349-355`）；`id` 不在种子中的行 `continue` 跳过（`:352-353`） | **否** | **否** |
| `questions` | `_seed_questions` `:358-367` | 全量写入 15 行（`:360-361`） | 只对 `id ∈ 1-15` 且 `not row.category` 的行回填 `category`（`:363-367`） | **否** | **否** |
| `medal_defs` | `_seed_medals` `:370-383` | 无独立空表分支——12 枚全部走「id 不存在则插入」（`:375-379`） | 缺失的勋章 id 插入（`:378-379`）；`_fill_empty(category)`（`:381`）；`if not row.sort_order` 则写入种子 `sort_order`（`:382-383`） | `name`/`icon`/`desc`/`hidden` **否**（`:373` docstring 明示「不覆盖库中现值」）；`sort_order` 为 0 时**会被覆盖** | 是（缺 id 即插） |
| `persons` | `_seed_persons` `:386-402` | 无独立空表分支——13 人全部走「id 不存在则插入」（`:391-395`） | 缺失的人物 id 插入；`_fill_empty(brief)`（`:397`） | `name` **否**；`brief` 非空则**否** | 是（缺 id 即插） |
| `person_nodes` | `_seed_persons` `:398-402` | — | **只增不删**：补齐 `(person_id, node_id)` 不在库中且 `node_id` 存在于 `route_nodes` 的对（`:401`） | 不适用 | **是——被管理端删掉的关联会被重新插入**（与 `:389` docstring「尊重手工调整过的关联」的字面预期不符，见 §9） |
| `daily_quotes` | `_seed_quotes` `:405-412` | 写入 5 条（`node_id` 为 `None` 或存在于 `route_nodes` 时才写，`:411`） | `count() > 0` 直接 `return`（`:407-408`），**完全交给后台维护** | 否 | 否 |
| `organizations` | `init_seed` 内联 `:422-423` | 全量写入 13 行（显式 id 1-13） | `count() != 0` 则整段跳过 | 否 | 否 |

两种判定「表是否为空」的写法并存：`route_nodes` / `questions` / `daily_quotes` / `organizations` 用 `db.query(M).count()`（`:346`、`:360`、`:407`、`:422`）；`medal_defs` / `persons` 不判空表，而是把全表读进 dict 再按主键 upsert（`:375`、`:391`）。

`_seed_route_nodes:350` 与 `_seed_questions:364` 用 `db.query(M).all()` **把整表载入内存**（不做 id 过滤）。当前 `route_nodes` 19 行、`questions` 27 行，无性能问题；表变大后是 O(全表) 的启动开销。

### 4.5 硬编码 id 分配与 `max(id)+1` 的关系

本文件是「非自增主键靠 `max(id)+1` 分配」这一架构决策的**根因**——它先占掉了低位 id：

| 表 | DDL 主键 | 种子占用 | 后台/服务新增时如何取 id | 是否冲突 |
|---|---|---|---|---|
| `route_nodes` | `SERIAL`（`001_schema.sql:4`）+ 模型 `autoincrement=True`（`models.py:42`） | 显式 id 1-10 | `admin_service.create_route_node:46-47` 显式 `max(id)+1`，**不取序列默认值** | 不冲突（序列 `route_nodes_id_seq` 不被推进，但也没人用它） |
| `questions` | `INTEGER PRIMARY KEY`，**无序列**（`001_schema.sql:17`） | 显式 id 1-15 | `admin_service.create_question:172-176`（docstring 原文：「questions.id 无数据库自增（**种子占用固定 id**），显式取 max+1」）、`ai_question_service.py:378`+`:381`、`ai_question_service.py:674`+`:678`、`import_service.py:293`+`:295` | 不冲突，但四处各自 `max+1` 且**无并发保护** |
| `persons` | `INTEGER PRIMARY KEY`，无序列（`006_persons.sql:10`） | 显式 id 1-13 | **全库没有第二处创建 Person**：`grep -rn "Person(" backend/app` 只命中 `seed.py:395` 与 `models.py:61` 的类定义；管理端无人物管理路由 | 不冲突 |
| `medal_defs` | `VARCHAR(50) PRIMARY KEY`（`001_schema.sql:27`） | 12 个语义化字符串 id | 无勋章管理入口（`_seed_medals:373` docstring 明示；`grep -rn "medal" backend/app/api/routes/admin.py` 0 命中） | 不冲突 |
| `daily_quotes` | `SERIAL`（`007_daily_quotes.sql:9`） | **不给 id** | `quote_service.py:159`、`import_service.py:407` 也不给 id，由序列分配 | 不冲突 |
| `organizations` | `SERIAL`（`001_schema.sql:34`） | **显式 id 1-13** | `admin_service.create_org:691-699` 与 `sync_orgs:814-822` 行为不同：前者**不给 id**（依赖 `nextval`），后者**给显式 id** | **存在序列不同步风险**，见 §9「待确认」 |

### 4.6 事务边界

- 全文件**没有任何 `try`/`except`**（实测），也没有 `rollback`。
- 6 个函数中只有 `init_seed:424` 调 `db.commit()`，5 个私有 seeder 只 `db.add` / 改属性 → **整个种子写入是一个事务**，要么全成功要么全不落盘。
- `db` 由调用方创建与关闭：`main.py:44` `db = SessionLocal()`、`:50` `finally: db.close()`。`init_seed` 自己不关 session。
- 会话配置为 `SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)`（`core/database.py:51`）——`autoflush=False` 直接导致 §9「存在问题 1」的首启缺陷。

## 5. 输入与输出

### 5.1 函数签名

| 函数 | 入参 | 返回 | 副作用 |
|---|---|---|---|
| `_fill_empty(row: object, field: str, value: object)` `:338` | ORM 行对象、字段名、种子值 | `None` | 可能 `setattr` 修改行 |
| `_seed_route_nodes(db: Session)` `:344` | Session | `None` | 读 `route_nodes` 全表；写 10 行或补空字段 |
| `_seed_questions(db: Session)` `:358` | Session | `None` | 读 `questions` 全表；写 15 行或补 `category` |
| `_seed_medals(db: Session)` `:370` | Session | `None` | 读 `medal_defs` 全表；补缺失 id / 补 `category` / 补 `sort_order` |
| `_seed_persons(db: Session)` `:386` | Session | `None` | 读 `persons`、`person_nodes` 全表与 `route_nodes.id`；补缺失人物 / 补 `brief` / 补缺失关联 |
| `_seed_quotes(db: Session)` `:405` | Session | `None` | 读 `daily_quotes` 计数与 `route_nodes.id`；空表时写 5 行 |
| `init_seed(db: Session)` `:415` | Session | `None` | 上述全部 + 组织表 + `db.commit()` |

`init_seed` **无返回值**（`-> None`），调用方无法从返回值判断本次写了什么；要观察结果只能查库或看异常。

### 5.2 真实调用点（grep 确认）

`grep -rn "init_seed" --include=*.py --include=*.md --include=*.sh --include=*.yml .`（排除 `.qoder/`）命中：

| 位置 | 行号 | 性质 |
|---|---|---|
| `backend/app/main.py` | `:37` `from app.data.seed import init_seed`；`:46` `init_seed(db)` | **唯一的生产调用点**，位于 `lifespan`（`:41-51`）内 |
| `backend/test/s17_quote_cycle_import.py` | `:43` 导入；`:84` `init_seed(db)` | 测试脚本，`Base.metadata.create_all(engine)`（`:81`）建临时 SQLite 表后跑种子，随后 `:85-86` 清空 `daily_quotes` 以便测导入 |
| `backend/app/data/seed.py` | `:4`（docstring）、`:415`（定义） | 自身 |
| `docs/迭代记录.md` | `:66`、`:68`、`:78`、`:80` | 文档提及，非调用 |

`lifespan` 内的顺序（`main.py:44-51`）：`init_seed(db)`（`:46`）→ `streak_service.recompute_all(db)`（`:47`）→ `points_service.recompute_walk_all(db, fix=True)`（`:48`）→ `finally: db.close()`（`:50`）→ `yield`（`:51`）。**种子必须先于两个 recompute**，否则重算依赖的节点表可能为空。

模块级常量的导入点（`grep -rn "from app.data.seed import\|data\.seed"` 全仓）只有 4 处代码引用：

| 位置 | 导入内容 | 用途 |
|---|---|---|
| `backend/app/main.py:37` | `init_seed` | 启动种子 |
| `backend/app/services/medal_service.py:16` | `MEDALS, MEDAL_NODE_MAP` | `:70`/`:72` 用 `MEDAL_NODE_MAP.get("luding")`/`("snow")` 判定路线勋章；`:126` `for seed in MEDALS:` 注释「保持 seed 中定义的展示顺序」——**勋章列表接口的顺序与可见集合由本常量决定，不由数据库决定**（`:127-129`：库里存在但 `MEDALS` 中没有的勋章会被 `continue` 跳过，永不出现在列表） |
| `backend/app/services/admin_service.py:21` | `ORGANIZATIONS` | `_fetch_org_source:861-865`：`ORG_SYNC_API_URL` 为空时返回 `("seed（未配置 ORG_SYNC_API_URL，使用内置种子数据）", list(ORGANIZATIONS))` |
| `backend/test/s17_quote_cycle_import.py:43` | `init_seed` | 测试 |

另有 2 处**文档性**提及（非导入）：`models.py:4`、`models.py:166`。

`PERSONS` / `PERSON_NODES` / `QUOTES` / `ROUTE_NODES` / `QUESTION_BANK` / `_NODE_CONTENT_FIELDS` / `_fill_empty` **在 seed.py 之外无任何引用**（实测 grep 0 命中）——它们纯粹是启动期数据，运行期业务一律读数据库表。

### 5.3 异常与错误码

本文件不产生 HTTP 响应，也不定义异常。失败路径只有一条：

- 任一 SQL/约束错误（如缺列、主键冲突、外键悬挂）→ 异常从 seeder 冒泡出 `init_seed` → 冒泡出 `main.py:46` → `lifespan` 的 `try/finally` 只做 `db.close()`（`main.py:49-50`）不捕获 → **应用启动失败退出**。
- 历史实例（`docs/迭代记录.md` 的 `51239b5`、`f413ac6` 条目）：服务器 openGauss 缺迁移 020（`questions.active` 列不存在）时，`_seed_questions` 的 `db.query(Question).count()` 抛 `psycopg2.errors.UndefinedTable: invalid reference to FROM-clause entry for table "questions"`；同次提交把 count 改写后错误下移为 `psycopg2.errors.UndefinedColumn: column questions.active does not exist`。同一「缺列」根因在 openGauss 有两种文案。

因为 `init_seed` 是启动阻塞项，**任何对本文件的修改都必须先在真实 openGauss 上跑一次启动**（见 §8）。

## 6. 依赖关系

### 6.1 上游依赖（本文件 import 的东西）

| 依赖 | 行号 | 说明 |
|---|---|---|
| `sqlalchemy.orm.Session` | `:9` | 仅用于类型注解；**没有**导入 `func`（`f413ac6` 曾加过，`51239b5` 已移除） |
| `app.models.models` 的 `DailyQuote, MedalDef, Organization, Person, PersonNode, Question, RouteNode` | `:11` | 7 个 ORM 类，按字母序导入 |

**不依赖** `app.core.config`、`app.core.database`、`app.schemas`、任何 service 或 route —— 因此本文件处于依赖链最底层的业务侧，被 `services/` 反向导入也不违反 `backend/AGENTS.md` §3.1 的单向分层（`api/routes -> api/deps -> services -> models + core`；`data/seed.py` 与 `models/` 同属被 service 依赖的数据层）。

### 6.2 下游依赖（谁用本文件）

见 §5.2 的 4 处代码引用。运行期通过**数据库表**间接消费这 7 张表的模块（`grep -rln` 实测）包括：`march_service`（路线/点亮）、`quiz_service`（出题）、`medal_service`（勋章）、`person_service`（人物志，`:13-33` join `PersonNode`/`RouteNode` 且过滤 `RouteNode.is_enabled.is_(True)`）、`quote_service`（寄语循环，`:59-68` 按 `(sort_order, id)` 升序取启用寄语）、`org_service` / `access_service` / `dashboard_service` / `broadcast_service` / `profile_service` / `points_service` / `invite_service` / `import_service` / `ai_chat_service` / `ai_knowledge_service` / `ai_question_service` / `admin_service`。

### 6.3 数据库表与 DDL 出处

| 表 | 建表 | 后续变更 |
|---|---|---|
| `route_nodes` | `001_schema.sql:3-14`（`id SERIAL`） | `002_route_node_config.sql:3-6` 新增 `latitude`/`longitude`/`sort_order`/`is_enabled`（`:38-41` 回填后设 `NOT NULL`）；`005_upgrade.sql:45-51` 新增 `brief/significance/figures/location/images/audio/keywords` 7 列（正是 `_NODE_CONTENT_FIELDS`） |
| `questions` | `001_schema.sql:16-24`（`id INTEGER`，无序列） | `005_upgrade.sql:54` 新增 `category`；`020_question_rotation.sql:6-7` 新增 `active` + 索引 |
| `medal_defs` | `001_schema.sql:26-31`（`id VARCHAR(50)`） | `005_upgrade.sql:57-67` 新增 `category`、`hidden`（回填 `FALSE` 后设 `NOT NULL DEFAULT FALSE`）、`sort_order`（回填 `0` 后设 `NOT NULL DEFAULT 0`） |
| `persons` / `person_nodes` | `006_persons.sql:9-23`（`persons.id INTEGER`；`person_nodes` 复合主键 + 两个真实外键 `REFERENCES persons(id)` / `REFERENCES route_nodes(id)`） | — |
| `daily_quotes` | `007_daily_quotes.sql:8-14`（`id SERIAL`、`date VARCHAR(10) NOT NULL UNIQUE`） | `013_daily_quote_cycle.sql:8-18` 新增 `sort_order`（按 `ROW_NUMBER() OVER (ORDER BY date, id)` 回填）与 `is_enabled`，`d6acf7e` 同步把 `QUOTES` 的 `date` 键改成 `sort_order` |
| `organizations` | `001_schema.sql:33-42`（`id SERIAL` + `ix_organizations_parent_id`） | `009_org_serial.sql:6-12` 补建 `organizations_id_seq`、`ALTER COLUMN id SET DEFAULT nextval(...)`、`setval(seq, COALESCE(MAX(id),0))`（修 BUG-001：早期建表无 SERIAL 导致管理端新增组织插入 NULL 主键报 500） |

外键顺序约束：`person_nodes` 与 `daily_quotes` 都 `REFERENCES route_nodes(id)`，所以 `init_seed` 必须**先写路线节点**（`:417`）再写人物关联（`:420`）与寄语（`:421`）——当前顺序正确。

## 7. 业务规则

### 7.1 幂等的真实边界：什么会被改、什么绝不会

**永远不会被种子改动的（管理端编辑安全区）**：

- `route_nodes` 的 `name` / `target_steps` / `historical_time` / `icon` / `description` / `latitude` / `longitude` / `sort_order` / `is_enabled` —— 这 9 列不在 `_NODE_CONTENT_FIELDS`（`:335`）中，非空表路径完全不碰。
- `route_nodes` id ≥ 11 的行（管理端新增的节点）—— `:351-353` `seed_by_id.get(row.id)` 返回 `None` 即 `continue`。实测开发库 19 行中有 9 行（id 11-19）`brief` 为空且**始终为空**，因为种子里没有它们的对应项。
- `questions` 的 `type` / `question` / `options` / `answer` / `analysis` / `score` / `active`；以及 `category` 已非空的题。
- `medal_defs` 的 `name` / `icon` / `desc` / `hidden`（`:373` docstring 明示「不覆盖库中现值」）。
- `persons` 的 `name` / `avatar`。
- `daily_quotes` 与 `organizations` 的**全部内容**（表非空即整体跳过，`:407-408`、`:422`）。

**可能被种子改动的（3 处，都是「原本为空」才动）**：

1. `route_nodes` id 1-10 的 7 个内容字段中**值为 `None` / `''` / `[]`** 的那些 → 被填回种子原文（`:354-355`）。管理端若把某节点的 `brief` 清空，下次启动会被种子内容**重新填上**。
2. `questions` id 1-15 中 `category` 为空的 → 被填回种子分类（`:366-367`）。
3. `medal_defs` 中 `category` 为空的（`:381`）、`sort_order` 为 0 的（`:382-383`）→ 被填回种子值。由于 `sort_order` DDL 默认就是 `0`（`005_upgrade.sql:67`），「0」在这里等价于「未设置」，语义上可接受；但若将来做了勋章管理端并允许把排序号设为 0，就会被种子改回。

**会被种子「复活」的（1 处，是真实行为与注释不符点）**：

- `person_nodes`：`:399-402` 只比较「库里已有哪些对」，缺失即插入。管理端/SQL 手工删掉某条人物-节点关联后，下次启动会被重新插入。`:389` docstring 写「关联表只增不删：补齐缺失的 (person_id, node_id) 对，尊重手工调整过的关联」——「只增不删」描述准确，但「尊重手工调整过的关联」只对**新增**成立，对**删除**不成立。

### 7.2 种子会不会覆盖管理员在后台改过的数据

结论：**`init_seed` 自身不会覆盖任何非空的已编辑内容**（除 §7.1 的 3 处「空值回填」和 1 处「关联复活」）。但存在一条**间接覆盖路径**，必须知道：

`POST /api/admin/orgs/sync`（`admin.py:737-748`，权限 `require_menu("orgs")`，`response_model=AdminOrgSyncOut`，异常映射 502）→ `admin_service.sync_orgs:791-850`：

- `_fetch_org_source:861-865`：`settings.ORG_SYNC_API_URL` 为空时**降级使用本文件的 `ORGANIZATIONS`**（`:865`）。
- `:811-829`：按 id upsert，**`name` / `parent_id` / `level` / `sort_order` 全量覆盖**（`:825-828`）。
- `:832-849`：数据源中不存在的本地节点，无用户引用则**物理删除**（`:846-848`），有引用则保留并计入 `skipped`。

也就是说：在未配置 `ORG_SYNC_API_URL` 的环境里点一次「同步组织」，管理端对 id 1-13 组织的改名/改父/改排序会被**回退成种子值**，管理端新建的 id 14+ 组织（无人引用者）会被**删除**。这不是 `init_seed` 的行为，但数据源来自本文件，修改 `ORGANIZATIONS` 时必须一并考虑。实测开发库 `organizations` 仍是 13 行、`max(id)=13`，而 `organizations_id_seq.last_value=26`，说明历史上确有 id 14-26 的组织被创建过、现已不在表中。

### 7.3 内容真实性与史实约束

`:14-15`、`:45` 两处注释规定了硬约束：人物简介「仅采用公开史料记载，不虚构」；每日寄语「仅收录有明确出处的公开史料/著作语录，不虚构」。当前 5 条寄语全部出自毛泽东著作并标注篇名（`:51`《七律·长征》、`:57`《忆秦娥·娄山关》、`:63`《清平乐·六盘山》、`:69`《论反对日本帝国主义的策略》、`:75`《七律·长征》）；13 位人物均为节点 `figures` 字段中出现的真实历史人物，群体表述（节点 7、8 的「全体红军指战员」）不单列为人物。`persons.avatar` 一律留空（`:15`「不伪造历史照片」的等价实现，见 `006_persons.sql:8` 注释）。

### 7.4 空值语义（Oracle 兼容模式）

`006_persons.sql:5-6` 与 `models.py:36-37` 都说明：本库为 openGauss Oracle 兼容模式 A，**空字符串按 NULL 存储**，字符串内容列保持可空。这决定了 `_fill_empty` 必须同时把 `None` 和 `''` 当作「空」（`:340` 的 `not` 判断天然覆盖两者）。反方向（读出 `None` 归一为 `''`）由 schema 层负责，例如 `AdminRouteNodeOut` 的 `none_to_empty` 校验器（`schemas.py:1349-1355`）——种子与 schema 分工明确，本文件不做输出归一。

### 7.5 勋章的双份真相

`MEDALS` 常量与 `medal_defs` 表**同时**决定勋章行为，且常量优先：

- 展示顺序与可见集合：`medal_service.get_medal_list:126-129` 遍历 `MEDALS`，库里存在但常量中没有的勋章被跳过。
- 展示字段（`name` / `icon` / `desc` / `category` / `hidden` / `sort_order`）：取自数据库行 `m`（`:135-142`），**不是**取自常量。
- 路线勋章判定：`MEDAL_NODE_MAP`（`:314`，`{"luding": 6, "snow": 7}`）在 `medal_service.py:70`/`:72` 使用，注释 `:313` 说明与前端 `medal.js nodeByName` 口径一致。
- 其余 10 枚勋章的判定条件（`first-step` / `learner` / `master` / `victory` / `persistence` / `streak-30` / `day-10k` / `steps-100k` / `steps-500k` / `fearless`）硬编码在 `medal_service.py:64-90`，**不在本文件**；`desc` 文案（`:284-310`）必须与那些阈值手工保持一致。

实测开发库 `medal_defs` 恰为 12 行，id / `category` / `sort_order` 与常量完全一致。

### 7.6 对迁移完整性的隐性依赖

`_seed_questions:360` 与 `:364` 的 `db.query(Question)` 会 SELECT `Question` 的**全部**映射列，其中 `active`（`models.py:142`）由迁移 `020_question_rotation.sql:6` 添加。若目标库缺 020，`init_seed` 抛异常 → 后端启动失败（`main.py:46` 无捕获）。同理 `_seed_route_nodes` 依赖 `002_route_node_config.sql:3-6` 的 4 列与 `005_upgrade.sql:45-51` 的 7 列，`_seed_medals` 依赖 `005_upgrade.sql:57-67` 的 3 列，`_seed_quotes` 依赖 `013_daily_quote_cycle.sql:8-9` 的 2 列。

**部署新后端前必须核对 `schema_migrations` 是否已含 `docker/init/001..022` 全部编号**——`docs/迭代记录.md` 的 `51239b5` 条目记录的服务器事故正是缺 020 导致启动崩溃，真正修复动作是「对服务器 openGauss 补跑迁移 020，并核对 019 是否同样缺失、`schema_migrations` 是否需补记」。实测开发库 `schema_migrations` 含 22 条记录（001-022 齐全）。

## 8. 修改约束

1. **不得把 `_fill_empty` 改成无条件 `setattr`**。它是「不覆盖管理端编辑」这条不变量（`backend/AGENTS.md` §4 不变量 3）的唯一实现点；改了之后每次重启都会把 `route_nodes` 的 7 个内容字段、`medal_defs.category`、`persons.brief` 全部回退成种子值。
2. **`_seed_route_nodes` / `_seed_questions` 必须继续「遍历库中已有行」而不是「遍历种子常量」**（`:350`、`:364`）。这是「不复活被删节点/题目」的唯一保障：种子里有、库里没有的行永远不会被重新插入（整行 `add` 只发生在 `count() == 0` 的空表路径 `:347`、`:361`）。若改成 `for seed in ROUTE_NODES: upsert(...)`，管理端删掉的 id 1-10 节点会在下次启动复活。
3. **不得删掉 `:352-353` 的 `seed is None → continue` 分支**。它保护的是反方向——管理端新增的 id ≥ 11 节点不被种子触碰（实测开发库 id 11-19 共 9 行的 `brief` 始终为空）。
4. **`_NODE_CONTENT_FIELDS`（`:335`）必须与 `005_upgrade.sql:45-51` 新增的 7 列严格对应**。`_fill_empty` 用 `getattr(row, field, None)` 带默认值，字段名拼错**不报错、静默失效**；新增节点内容列时若忘记同步这个元组，该列永远不会被种子回填。
5. **不得改动已发布勋章的字符串 `id`**（`:284-310`）。`user_medals.medal_id` 是 `String(50)` 普通列、**无外键约束**（`models.py:361`，该表只有 `uq_user_medal` 唯一约束 `:357`），所以改 id 不会报错，而是静默产生孤儿数据：`_seed_medals:378-379` 把新 id 当「缺失勋章」插入，旧 id 行残留在 `medal_defs`、用户已获记录仍指向旧 id，`get_medal_list:124`+`:127-129` 因只遍历 `MEDALS` 而对两者都视而不见 → 用户「丢失」该勋章。`medal_service.py:64-90` 的候选 id 与 `MEDAL_NODE_MAP`（`:314`）也要同步。
6. **新增勋章必须同时改 3 处**：`MEDALS`（`:282-311`，含 `sort_order`）、`medal_service.py:64-90` 的判定分支、必要时 `MEDAL_NODE_MAP`。只加常量不加判定 → 勋章永远拿不到；只加判定不加常量 → `get_medal_list:128-129` 会跳过它，前端看不到。
7. **不得改动 `questions.id` / `route_nodes.id` / `persons.id` / `organizations.id` 的种子取值区间**，也不要在种子里改用「不指定 id」。四处 `max(id)+1` 分配（`admin_service.py:46`、`:175`，`ai_question_service.py:378`、`:674`，`import_service.py:293`）都假设种子占的是低位连续 id；`MEDAL_NODE_MAP`（`:314`）与 `PERSON_NODES`（`:33-42`）、`QUOTES.node_id`（`:52`、`:58`、`:64`、`:70`、`:76`）都硬引用节点 id 6/7/3/9/10。
8. **改 `ROUTE_NODES` 的 `id` 或删条目会连带破坏 `PERSON_NODES` 与 `QUOTES`**：`:401` 与 `:411` 会用 `node_id in node_ids` 静默过滤掉悬挂引用，结果是人物关联/寄语**少写而不报错**。
9. **保持 `init_seed` 内的调用顺序**（`:417-423`）：`route_nodes` 必须先于 `persons`/`person_nodes`/`daily_quotes`，否则 `006_persons.sql:18-19` 与 `007_daily_quotes.sql:13` 的外键会失败。
10. **不要在私有 seeder 里加 `db.commit()`**。当前是单事务（唯一 commit 在 `:424`），中途提交会让「失败即全不落盘」的原子性消失，产生半种子状态。
11. **不要给 `init_seed` 加宽泛的 `try/except` 吞异常**。启动期种子失败必须让进程崩溃而不是带空表继续服务——这是 `f413ac6`/`51239b5` 事件（见 `docs/迭代记录.md` 对应条目）能被发现的前提。
12. **修改 `ORGANIZATIONS`（`:318-332`）等于修改「同步组织」的降级数据源**（`admin_service.py:865`）。改 id/parent_id 会在下次 `POST /api/admin/orgs/sync` 时按 §7.2 的规则覆盖或删除线上组织。
13. **`QUOTES` 只是建库示例，不是内容源**（`:46`、`:406`）。表非空即整体跳过（`:407-408`），改这里对已上线环境**完全无效**；线上寄语内容通过 `/admin/quotes` 与 Excel 导入维护。
14. **史实约束不可破**：人物简介与寄语必须有公开出处、不虚构（`:14-15`、`:45`）。
15. **改完必须在真实 openGauss 上跑一次完整启动**（不是 SQLite 冒烟）。`docs/迭代记录.md` 的 `f413ac6`、`51239b5` 条目记录了 SQLite 不复现、openGauss 才崩的先例。
16. **本文件不得写入任何密钥、Token、数据库连接串**；它只含公开的静态业务数据。

## 9. 当前实现状态

### 已实现（实测确认）

- 7 张静态表的幂等种子全部实现，`init_seed` 单事务提交（`:424`）。
- 开发库（openGauss，只读查询实测）当前行数：`route_nodes` 19（种子 10 + 后台新增 9，id 连续 1-19）、`questions` 27（种子 15 + 后台/AI/导入 12；`category` 分布 `event` 19 / `route` 6 / `figure` 2）、`medal_defs` **12**、`persons` 13、`person_nodes` 22、`daily_quotes` 5（id 为 1,2,5,6,9，`sort_order` 1-5 全启用）、`organizations` 13（`max(id)=13`，`organizations_id_seq.last_value=26`）。
- 种子与后台数据的隔离性实测通过：id 11-19 的后台新增节点 `brief` 全为空且种子从不回填（9 行）。

### 存在问题

1. **首次启动时 `person_nodes` 与 `daily_quotes` 写入 0 行（真实缺陷，已复现）**
   - 机制：`_seed_route_nodes:347` 用 `db.add_all` 把 10 个 `RouteNode` 放进 session 但**不 flush**；`SessionLocal` 配置为 `autoflush=False`（`core/database.py:51`），因此 `_seed_persons:398` 与 `_seed_quotes:409` 的 `db.query(RouteNode.id).all()` 在同一事务内查不到这些 pending 对象，返回空集 → `:401` 的 `node_id in node_ids` 对 22 对全部为假、`:411` 对 5 条全部为假 → 一行都不写。`:424` commit 后节点落盘，**第二次启动**才补齐 22 对与 5 条。
   - 复现证据：临时 SQLite（`sessionmaker(bind=engine, autoflush=False, autocommit=False)`，与生产会话配置一致）连跑两次 `init_seed`——第 1 次 `{route_nodes:10, questions:15, medal_defs:12, persons:13, person_nodes:0, daily_quotes:0, organizations:13}`，第 2 次 `person_nodes:22, daily_quotes:5`。机制在 SQLAlchemy Session 层，与数据库方言无关。
   - 影响：全新部署首启后，人物志页（`person_service.py:13-33` join `PersonNode`）与首页寄语卡（`quote_service.py:59-68`）无数据，需**再重启一次**才自愈。
   - 引入时点：`2a178b7`（`_seed_persons`，2026-10-03）与 `71d1b9b`（`_seed_quotes`，2026-10-03）。
   - 未在 openGauss 空库上复现（开发库早已过首启，且本次任务禁止修改数据库数据）→ 该方言下的实际表现列为「待确认」。
2. **`:389` docstring 与实现不符**：「尊重手工调整过的关联」只对新增成立，**删除的 `person_nodes` 关联会在下次启动被复活**（`:399-402`）。
3. **`_seed_route_nodes:350` / `_seed_questions:364` 全表载入内存**（不做 id 过滤），随表增长而线性变慢；当前 19 / 27 行无影响。
4. **文档滞后（4 处，本次任务不允许改这些文件，仅记录）**：
   - `backend/AGENTS.md:39`「种子数据：路线 10 / 题库 15 / **勋章 6** / 组织树（幂等）」——`MEDALS`（`:282-311`）实际 **12 枚**，实测开发库 `medal_defs` 也是 12 行。6 枚是 `a94e685` 初始版本的数字，`d0933fb`（2026-10-01）已升级为 12 枚并同步改了本文件 `:278` 的注释，但 AGENTS.md 未跟；该行也漏了人物志 13 / 每日寄语 5。`.qoder/PROJECT.md` §8「文档滞后项」表 `backend/AGENTS.md:39` 行已记录此项，并在 2026-10-17 更正了自己早先并列引用 `models.py:5` 的错误（经核对 `models.py:1-9` 的 docstring 只列类名、不含勋章数量）。
   - `backend/AGENTS.md` §4 不变量 3 的措辞「按主键存在即跳过」与实现不符（实际是「按主键存在则只补空值」，`person_nodes` 还会补插）——见 §3 第 1 条。
   - `backend/design.md:52` 称种子含「后台菜单 9 项与内置角色（超管/运营）」——本文件**不含任何菜单/角色常量**；菜单与角色由 `docker/init/010_admin_identity.sql:106`、`:118` 种入（`.qoder/PROJECT.md` §8「文档滞后项」表 `backend/design.md` §2.2 行已记录，并指出菜单现为 16 个）。
   - `backend/test/docs/p2-quotes-report.md:10` 描述 `QUOTES` 为「2026-10-01..05」按日期——`d6acf7e`（2026-10-11）已把 `date` 键改为 `sort_order`（`:49`、`:55`、`:61`、`:67`、`:73`），报告未更新。

### 待确认

1. **`organizations` 序列在全新容器初始化时是否与种子 id 冲突**：种子显式写入 id 1-13（`:423`），显式插入**不推进** `organizations_id_seq`；`009_org_serial.sql:12` 的 `setval(seq, COALESCE(MAX(id),0))` 在迁移阶段执行，而迁移先于应用启动（此时表为空，`MAX(id)` 为 `NULL` → `setval(seq, 0)`）。因此首启后 `create_org`（`admin_service.py:691-699`，不指定 id、依赖 `nextval`）拿到的第一个值是否为 1（与种子 id 1 冲突报唯一键错误）——**未在真实 openGauss 空库上验证**，且 `setval(seq, 0)` 在 openGauss 上是报错还是被容忍也未验证。开发库 `last_value=26` 说明该库已被推进过，不能作为证据。
2. **问题 1（首启 `person_nodes=0` / `daily_quotes=0`）在 openGauss 上是否同样发生**：机制与方言无关，但按约束未在生产/开发 openGauss 的空库上实测。
3. **`route_nodes_id_seq` 当前值与是否有任何代码路径依赖它**：已确认 `admin_service.create_route_node:46-47` 用 `max(id)+1` 而非序列默认值，但未逐一排查是否存在其他不带显式 id 的 `RouteNode` 插入路径（`grep -rn "RouteNode(" backend/app` 只命中 `seed.py:347` 与 `admin_service.py:47`，据此判断没有）。

### 待开发

- 无。本文件不涉及任何未实现功能；勋章管理端（`_seed_medals:373` 提到「当前无勋章管理入口」）属于管理端需求，不在本文件范围内。

## 10. 迭代记录

数据来源：`git log --follow --format='%h|%ad|%s' --date=short -- backend/app/data/seed.py`（9 个提交，全部真实存在），背景对照 `docs/迭代记录.md`。按主题归并，时间倒序。

### 2026-10-16

- 需求：修复服务器 openGauss 上后端启动即崩溃；随后更正误诊。
- 修改内容：`f413ac6` 把 `_seed_questions` 的空表判定从 `db.query(Question).count()` 改为 `db.query(func.count()).select_from(Question).scalar()`，并新增 `from sqlalchemy import func`，试图规避 openGauss 对派生表列别名 `questions_active` 的解析报错（+4/-1 行）。同日 `51239b5` **完整回退**该改写（+1/-4 行），移除 `func` 导入——真实根因是服务器库缺迁移 `020_question_rotation.sql`（`questions.active` 列不存在），而非 openGauss 的派生表别名 quirk；补部署 f413ac6 后错误只是从 `count()` 下移到 `db.query(Question).all()`，异常文案由 `UndefinedTable` 变为 `UndefinedColumn`。
- 关联文件：`backend/app/data/seed.py`、`docker/init/020_question_rotation.sql`、`docs/迭代记录.md` 的 `f413ac6`、`51239b5` 条目。
- 测试结果：`51239b5` 在本地含 `active` 列的 openGauss 实测——原 `count()` 返回 17、`.all()` 返回 17 行、启动 `init_seed` 通过、`/docs` 200、`/api/activity/status` 正常；`f413ac6` 曾做 postgresql 方言编译对比与 SQLite 内存库 `init_seed` 连跑两次（题库均 15 条、幂等无重复）。服务器侧真正修复为补跑迁移 020。
- 净效果：**本文件当前代码与 `f413ac6` 之前完全一致**，`_seed_questions:360` 仍是 `db.query(Question).count()`。

### 2026-10-11

- 需求：每日寄语由「按日期一天一条」改为「排序号 + 启用状态按天循环展示」（迁移 013、循环起始日期可配置）。
- 修改内容：`d6acf7e` 把 `QUOTES` 5 条的 `"date": "2026-10-01..05"` 键改为 `"sort_order": 1..5`（+6/-6 行，即 `:49`、`:55`、`:61`、`:67`、`:73` 与 `:46` 注释），内容/出处/`node_id` 均未变。
- 关联文件：`docker/init/013_daily_quote_cycle.sql:8-18`（新增 `sort_order`、`is_enabled` 并按 `ROW_NUMBER() OVER (ORDER BY date, id)` 回填）、`app/services/quote_service.py:59-68`、`admin`、`docs/迭代记录.md` 的 `d6acf7e` 条目。
- 测试结果：见同提交的 `backend/test/s17_quote_cycle_import.py`（`:81-88` 建临时 SQLite 表、跑 `init_seed`、清空寄语表后测循环与导入）与 `backend/test/docs/s17-quote-cycle-import-report.md`。

### 2026-10-10

- 需求：清理前端 `mock/data.js` 死文件时同步修正过时文档描述。
- 修改内容：`4d8af39` 改本文件 2 行注释（+2/-2）——模块 docstring 由「数据精确迁移自前端 mock/data.js：长征路线节点(10)、题库(15)、勋章定义(12)」改为「长征路线节点(10)、题库(15)、勋章定义(12) 等静态数据唯一来源」（`:3`）；`ORGANIZATIONS` 上方注释删去「与前端 mock/data.js ORGANIZATIONS 完全一致」（`:317`）。**未改任何数据**。
- 关联文件：`frontend/mock/data.js`（删除）、`frontend/AGENTS.md`、`frontend/design.md`、`backend/AGENTS.md`、`backend/README.md`、`backend/design.md`、2 个 automator 脚本注释、`docs/迭代记录.md` 的 `4d8af39` 条目。
- 测试结果：该提交为文档/注释同步，无功能变更；`docs/迭代记录.md` 的 `4d8af39` 条目另记录了 `build-backend.bat` 产物校验中确认 `app/data/seed.py` 齐全。
- 遗留：本次修正**漏掉了** `backend/AGENTS.md:39` 的「勋章 6」（见 §9 文档滞后 1）。

### 2026-10-03

- 需求：P2-1 每日寄语与节点纪念票；P1-8 长征人物志与答题连胜效果（需求 §16、§14）。
- 修改内容：
  - `2a178b7`（+53/-2）新增 `PERSONS` 13 位真实历史人物（`:16-30`）与 `PERSON_NODES` 22 对关联（`:33-42`），`models` 导入加 `Person, PersonNode`（`:11`），新增 `_seed_persons`（`:386-402`，空表全量写、非空补新 id/补空 `brief`、关联只增不删）。
  - `71d1b9b`（+49/-2）新增 `QUOTES` 5 条有出处的毛泽东著作语录（当时用 `date` 键），`models` 导入加 `DailyQuote`，新增 `_seed_quotes`（`:405-412`，仅空表写入，之后完全交由后台维护）。
- 关联文件：`docker/init/006_persons.sql`、`docker/init/007_daily_quotes.sql`、`app/models/models.py:61-95`、`app/services/person_service.py`、`app/services/quote_service.py`、`app/api/routes/persons.py`、`app/api/routes/quotes.py`、前端人物志页与首页寄语卡、`docs/迭代记录.md` 的 `2a178b7`、`71d1b9b` 条目。
- 测试结果：`backend/test/docs/p1-persons-report.md:38`「种子写入验证：`persons` 13 行、`person_nodes` 22 行（启动时 init_seed 幂等补齐）」——注意「补齐」指的正是第二次启动，与 §9 存在问题 1 一致。
- 遗留：这两个提交引入了首启 `person_nodes=0` / `daily_quotes=0` 的缺陷（`autoflush=False` + 同事务内查 pending 的 `RouteNode`）。

### 2026-10-01

- 需求：数据模型扩展（005 迁移）——用户事件表、连续行军、历史事件卡字段；种子升级为 12 勋章 + 题目分类。同日早先为路线节点增加坐标、排序与启停配置。
- 修改内容：
  - `e8c6a09`（2026-10-01 10:28，本文件 +10/-0）为 `ROUTE_NODES` 10 个节点各补一行 `latitude` / `longitude` / `sort_order` / `is_enabled`（现 `:94`、`:105`、`:116`、`:127`、`:138`、`:149`、`:160`、`:171`、`:182`、`:193`）。
  - `d0933fb`（2026-10-01 22:53，本文件 +169/-31）是本文件最大一次改造：勋章由 6 枚扩到 **12 枚**并加 `category` / `hidden` / `sort_order`（`:282-311`，注释 `:278-281` 由「6 个」改为「12 个」）；题库加 `category`（`:202` 等 15 处，注释 `:199`）；路线节点加 `brief` / `significance` / `figures` / `location` / `images` / `audio` / `keywords` 7 个历史事件卡字段（注释 `:82-83`）；新增 `_NODE_CONTENT_FIELDS`（`:335`）、`_fill_empty`（`:338-341`）与 `_seed_route_nodes` / `_seed_questions` / `_seed_medals` 三个私有 seeder，把原先内联在 `init_seed` 里的写入改造为「空表全量 / 非空只补空值」的幂等策略。
- 关联文件（`git show --stat` 实测）：`e8c6a09` → `app/api/routes/march.py`、`app/models/models.py`、`app/services/auth_service.py`、`app/services/march_service.py`、`app/services/medal_service.py`（**未改 docker**；这 4 列的 DDL 在 `docker/init/002_route_node_config.sql:3-6`+`:38-41`，该文件由同日早 2 分钟的 `bceeb26`「数据库由 SQLite 切换为 openGauss」随整个 `docker/init/` 链一并建入）。`d0933fb` → `app/models/models.py`、`docker/init/005_upgrade.sql`、`frontend/mock/data.js`、`backend/test/docs/s1-data-layer-report.md`（**未改 `medal_service.py` / `event_service.py`**，勋章判定与事件链是同批次的其他提交）。文档背景见 。
- 测试结果：`backend/test/docs/s1-data-layer-report.md:46`「`python -m py_compile app/models/models.py app/data/seed.py` ✓」（该报告范围含 `005_upgrade.sql`、`models.py`、`seed.py`、`frontend/mock/data.js`，见 `:4`）。

### 2026-09-30

- 需求：项目初始化。
- 修改内容：`a94e685`（2026-09-30 18:05）新建本文件（+178 行），含 `ROUTE_NODES` 10 个节点、`QUESTION_BANK` 15 题、`MEDALS` **6** 枚、`MEDAL_NODE_MAP`、`ORGANIZATIONS` 13 节点与 `init_seed`；docstring 当时写「数据精确迁移自前端 mock/data.js：长征路线节点(10)、题库(15)、勋章定义(6)」。
- 关联文件：`backend/app/models/models.py`、`backend/app/main.py`、`backend/app/core/database.py`、`backend/.env.example`、`frontend/mock/data.js`、`docs/迭代记录.md` 的 `a94e685` 条目。**当时尚无 `docker/init/`**——`a94e685:.env.example` 的 `DATABASE_URL=sqlite:///./longmarch.db`，建表靠 SQLAlchemy `create_all`；`docker/init/001_schema.sql` 是次日 `bceeb26` 切 openGauss 时才出现的。
- 测试结果：仓库初始提交，无独立测试记录。

---

**9 个提交全清单**（`git log --follow --format='%h|%ad|%s' --date=short -- backend/app/data/seed.py` 原文顺序）：`51239b5`(2026-10-16) → `f413ac6`(2026-10-16) → `d6acf7e`(2026-10-11) → `4d8af39`(2026-10-10) → `71d1b9b`(2026-10-03) → `2a178b7`(2026-10-03) → `d0933fb`(2026-10-01) → `e8c6a09`(2026-10-01) → `a94e685`(2026-09-30)。
