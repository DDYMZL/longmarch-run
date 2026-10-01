# S1 数据层扩展验证报告（005 迁移 + 种子增强）

日期：2026-10-01
范围：`docker/init/005_upgrade.sql`、`backend/app/models/models.py`、`backend/app/data/seed.py`、`frontend/mock/data.js`

## 1. 迁移执行

- `docker compose -f docker/compose.yml run --rm database-init` 应用 `005_upgrade.sql`，`schema_migrations` 记录成功插入。
- **踩坑记录**：本库为 Oracle 兼容模式，空字符串 `''` 按 NULL 存储（`'' IS NULL` 为真）。初版 005 用 `ADD COLUMN ... NOT NULL DEFAULT ''` / 四步模式加字符串列均报 `column "brief" contains null values`；改为字符串列保持可空、数值/布尔列保留四步模式后通过。事务内 ON_ERROR_STOP 使失败两次均整体回滚，无脏数据。

## 2. 数据库核验（gsql 直查）

| 检查项 | 结果 |
| --- | --- |
| medal_defs 总数 / 含分类 / 隐藏勋章 fearless hidden=t | 12 / 12 / ✓（sort_order 1-12 与种子一致） |
| route_nodes brief 非空 | 10 / 10（种子补空值生效） |
| questions category 非空 | 15 / 15 |
| user_event 表与索引 | 已创建，0 行 |
| daily_sport distance 回填（steps×0.7/1000） | 10 行 > 0 |
| daily_sport is_goal_completed 回填（steps≥5000） | 9 行 |
| users continuous_days / max_continuous_days | 98 行非空（默认 0） |
| lit_nodes step_snapshot | 40 行非空（历史回填 0） |

## 3. API 冒烟（重启后端后，真实 openGauss）

先清理 8010 端口旧进程树（PID 14088 reloader + 25712 worker，避免旧代码假结果），`python run.py` 重启。

| 接口 | 结果 |
| --- | --- |
| POST /api/auth/login（mock code） | ✓ 签发 token，新用户 id=105 |
| GET /api/medal/list | ✓ medals=12，ownedCount=0 |
| GET /api/march/route | ✓ nodes=10，nextNode=遵义，finished=false |
| GET /api/sport/today | ✓ {date, steps:0, target:10000, totalSteps:0} |
| GET /api/march/node/6 | ✓ 飞夺泸定桥，status=unlocked（未解锁可见） |
| GET /api/quiz/daily | ✓ 5 题，响应不含 answer 字段 |
| GET /api/points | ✓ 每日登录 +1（积分去重链路正常） |
| GET /api/rank/steps | ✓ total=99，myRank=99 |

## 4. 种子幂等

- 后端启动（含 WatchFiles 多次重载）后 medal_defs 精确 12 行、route_nodes 10 行、questions 15 行，无重复写入；既有行 name/desc 未被覆盖，仅空字段被补值。

## 5. 静态检查

- `node --check frontend/mock/data.js` ✓
- `python -m py_compile app/models/models.py app/data/seed.py` ✓

## 6. 结论

S1 数据层就绪：表结构、ORM、种子（10 节点历史内容 / 15 题分类 / 12 勋章）、前端 mock 结构同步完成，既有接口契约无破坏性变更，可进入 S2（事件系统与连续行军）。
