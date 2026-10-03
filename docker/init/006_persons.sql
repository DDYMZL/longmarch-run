START TRANSACTION;

-- ============ 长征人物志：人物与人物-节点关联（006）============
-- 与 backend/app/models/models.py 同步；人物种子由 app/data/seed.py 在启动时幂等补齐。
-- 需求 §14：人物 ↔ 历史事件 ↔ 路线节点 三者关联；本库 Oracle 兼容模式，
-- 字符串内容列保持可空（'' 按 NULL 存储），读取时 None 即空值。

-- 人物表：avatar 为空时前端展示姓名首字占位（不伪造历史照片）
CREATE TABLE IF NOT EXISTS persons (
    id INTEGER PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    avatar VARCHAR(500),
    brief TEXT
);

-- 人物-节点关联：人物相关的历史事件即节点事件（历史时间在 route_nodes.historical_time）
CREATE TABLE IF NOT EXISTS person_nodes (
    person_id INTEGER NOT NULL REFERENCES persons(id),
    node_id INTEGER NOT NULL REFERENCES route_nodes(id),
    PRIMARY KEY (person_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_person_nodes_node ON person_nodes (node_id);

COMMIT;
