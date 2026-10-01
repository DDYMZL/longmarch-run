START TRANSACTION;

-- ============ 高级化功能增强：数据模型扩展（005）============
-- 与 backend/app/models/models.py 同步；种子回填由 app/data/seed.py 在启动时幂等补齐。
-- 重要：本库为 Oracle 兼容模式，空字符串 '' 按 NULL 存储（已验证 '' IS NULL 为真），
-- 因此字符串内容列一律保持「可空」，代码层把 NULL 视为 ''（ORM/Schema 兜底）；
-- 数值/布尔列采用 002 的四步模式：加列 → 回填 → SET NOT NULL → SET DEFAULT。

-- 用户表：连续行军（sport 写入链路维护，启动时全量重算兜底）
ALTER TABLE users ADD COLUMN IF NOT EXISTS continuous_days INTEGER;
UPDATE users SET continuous_days = 0 WHERE continuous_days IS NULL;
ALTER TABLE users ALTER COLUMN continuous_days SET NOT NULL;
ALTER TABLE users ALTER COLUMN continuous_days SET DEFAULT 0;

ALTER TABLE users ADD COLUMN IF NOT EXISTS max_continuous_days INTEGER;
UPDATE users SET max_continuous_days = 0 WHERE max_continuous_days IS NULL;
ALTER TABLE users ALTER COLUMN max_continuous_days SET NOT NULL;
ALTER TABLE users ALTER COLUMN max_continuous_days SET DEFAULT 0;

-- 每日运动表：估算距离 / 行军达标标记 / 补签预留（补签机制本期不实现）
ALTER TABLE daily_sport ADD COLUMN IF NOT EXISTS distance NUMERIC(10, 2);
UPDATE daily_sport SET distance = ROUND(steps * 0.7 / 1000, 2) WHERE distance IS NULL;
ALTER TABLE daily_sport ALTER COLUMN distance SET NOT NULL;
ALTER TABLE daily_sport ALTER COLUMN distance SET DEFAULT 0;

ALTER TABLE daily_sport ADD COLUMN IF NOT EXISTS is_goal_completed BOOLEAN;
UPDATE daily_sport SET is_goal_completed = (steps >= 5000) WHERE is_goal_completed IS NULL;
ALTER TABLE daily_sport ALTER COLUMN is_goal_completed SET NOT NULL;
ALTER TABLE daily_sport ALTER COLUMN is_goal_completed SET DEFAULT FALSE;

ALTER TABLE daily_sport ADD COLUMN IF NOT EXISTS is_makeup BOOLEAN;
UPDATE daily_sport SET is_makeup = FALSE WHERE is_makeup IS NULL;
ALTER TABLE daily_sport ALTER COLUMN is_makeup SET NOT NULL;
ALTER TABLE daily_sport ALTER COLUMN is_makeup SET DEFAULT FALSE;

ALTER TABLE daily_sport ADD COLUMN IF NOT EXISTS makeup_at TIMESTAMP;

-- 节点点亮记录：点亮时刻累计步数快照（历史数据无法还原，保留 0，接口判空处理）
ALTER TABLE lit_nodes ADD COLUMN IF NOT EXISTS step_snapshot INTEGER;
UPDATE lit_nodes SET step_snapshot = 0 WHERE step_snapshot IS NULL;
ALTER TABLE lit_nodes ALTER COLUMN step_snapshot SET NOT NULL;
ALTER TABLE lit_nodes ALTER COLUMN step_snapshot SET DEFAULT 0;

-- 路线节点：历史事件卡内容字段（可空；种子仅补空值，尊重管理端编辑）
ALTER TABLE route_nodes ADD COLUMN IF NOT EXISTS brief VARCHAR(200);
ALTER TABLE route_nodes ADD COLUMN IF NOT EXISTS significance TEXT;
ALTER TABLE route_nodes ADD COLUMN IF NOT EXISTS figures VARCHAR(500);
ALTER TABLE route_nodes ADD COLUMN IF NOT EXISTS location VARCHAR(100);
ALTER TABLE route_nodes ADD COLUMN IF NOT EXISTS images JSON;
ALTER TABLE route_nodes ADD COLUMN IF NOT EXISTS audio VARCHAR(500);
ALTER TABLE route_nodes ADD COLUMN IF NOT EXISTS keywords VARCHAR(200);

-- 题库：知识画像分类（可空；event 历史事件 / route 长征路线 / figure 历史人物，种子按 id 回填）
ALTER TABLE questions ADD COLUMN IF NOT EXISTS category VARCHAR(20);

-- 勋章定义：分类（可空；starter/route/challenge/complete，种子回填）/ 隐藏 / 排序
ALTER TABLE medal_defs ADD COLUMN IF NOT EXISTS category VARCHAR(20);

ALTER TABLE medal_defs ADD COLUMN IF NOT EXISTS hidden BOOLEAN;
UPDATE medal_defs SET hidden = FALSE WHERE hidden IS NULL;
ALTER TABLE medal_defs ALTER COLUMN hidden SET NOT NULL;
ALTER TABLE medal_defs ALTER COLUMN hidden SET DEFAULT FALSE;

ALTER TABLE medal_defs ADD COLUMN IF NOT EXISTS sort_order INTEGER;
UPDATE medal_defs SET sort_order = 0 WHERE sort_order IS NULL;
ALTER TABLE medal_defs ALTER COLUMN sort_order SET NOT NULL;
ALTER TABLE medal_defs ALTER COLUMN sort_order SET DEFAULT 0;

-- 用户统一事件表：我的长征足迹 / 管理端实时动态 同源
CREATE TABLE IF NOT EXISTS user_event (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    event_type VARCHAR(30) NOT NULL,
    event_time TIMESTAMP NOT NULL,
    event_data JSON
);

CREATE INDEX IF NOT EXISTS ix_user_event_user_id ON user_event (user_id);
CREATE INDEX IF NOT EXISTS ix_user_event_time ON user_event (event_time);

COMMIT;
