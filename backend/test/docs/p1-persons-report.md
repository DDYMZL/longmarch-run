# P1-8 长征人物志 + 答题即时判题（后端侧）测试报告

日期：2026-10-03 · 范围：人物志数据模型与接口（需求 §14）、单题即时判题接口（需求 §15）

## 改动摘要

- `docker/init/006_persons.sql`（已应用到运行库并登记 schema_migrations）
  - 新建 `persons`（id/name/avatar/brief，字符串列可空——本库 Oracle 兼容模式空串按 NULL 存储）；
  - 新建 `person_nodes`（person_id + node_id 复合主键，`idx_person_nodes_node` 支撑节点反查）。
- `app/models/models.py`：新增 `Person` / `PersonNode`（与 SQL 同步，未用 create_all）。
- `app/data/seed.py`：新增 `PERSONS`（13 位真实历史人物，简介仅采用公开史料记载、不虚构；群体表述如「全体红军指战员」不单列）与 `PERSON_NODES`（22 对，与节点 figures 字段口径一致）；`_seed_persons` 幂等（空表全量写、非空补新 id/补空简介、关联只增不删）。
- `app/services/person_service.py`（新增）：`get_persons_by_node`（节点反查人物）、`get_person_detail`（人物详情 + 关联节点=相关历史事件，仅启用节点、按路线顺序）。
- `app/services/march_service.py`：`get_node_detail` 返回新增 `persons[{id,name}]`（一条 JOIN 查询，节点 → 人物入口）。
- `app/services/quiz_service.py`：新增 `check_answer`（无状态比对答案，不写记录/不发积分）。
- `app/api/routes/persons.py`（新增）：`GET /api/persons/{person_id}`（404 边界）；`app/api/routes/quiz.py`：新增 `POST /api/quiz/check`；`app/main.py` 注册 persons 路由。
- `app/schemas/schemas.py`：`PersonRefOut` / `PersonNodeRefOut` / `PersonDetailOut` / `QuizCheckOut`；`NodeDetailOut` 增加 `persons` 字段。

## 设计取舍

- **三者关联极简实现（§14.4）**：不建知识图谱，人物相关的历史事件即其关联节点的事件（历史时间在 `route_nodes.historical_time`），关联仅 `person_nodes` 一张表。
- **即时判题安全边界**：`/quiz/check` 无状态、每日题目答案仍不下发；理论上可被逐选项探测答案后再提交满分（教育类内部活动，文档 §15.2 明确要求作答中即时反馈），最终成绩/积分仍以 `submit` 后端判分为唯一口径，**积分规则不变**。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P1Q-01 | 人物详情：毛泽东简介非空、关联瑞金/遵义/延安（按路线顺序、含历史时间与图标） | 通过 |
| P1Q-02 | 双向关联：飞夺泸定桥 persons 含王开湘/杨成武/廖大珠；王开湘详情回链泸定桥 | 通过 |
| P1Q-03 | 即时判题：今日首题逐选项探测恰 1 个正确分支；判题后 completed=false（无状态） | 通过 |
| P1Q-04 | 人物不存在 404；persons/check 未带 token 401 | 通过 |

执行：`python test/p1_persons.py` —— **4/4 通过**。

回归：`python test/p0_route_progress.py` 10/10、`python test/p0_chapters.py` 10/10、`python test/s3_aggregates.py` 15/15。

## 备注

- 种子写入验证：`persons` 13 行、`person_nodes` 22 行（启动时 init_seed 幂等补齐）。
- 测试用例名曾含「↔」字符触发 GBK 控制台 UnicodeEncodeError，已改纯中文表述（同 P1K「⊆」教训）。
