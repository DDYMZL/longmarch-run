START TRANSACTION;

-- ============ 每日一句长征寄语（007，需求 §16）============
-- 与 backend/app/models/models.py 同步；种子由 app/data/seed.py 在表为空时写入。
-- 内容要求（§16.4）：不虚构历史名言，必须有明确出处、后台可维护、可关联历史节点。
-- date 唯一：一天一条；展示取「当天优先、否则最近一条历史寄语」。

CREATE TABLE IF NOT EXISTS daily_quotes (
    id SERIAL PRIMARY KEY,
    date VARCHAR(10) NOT NULL UNIQUE,
    content TEXT NOT NULL,
    source VARCHAR(200) NOT NULL,
    node_id INTEGER REFERENCES route_nodes(id)
);

COMMIT;
