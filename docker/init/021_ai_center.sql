START TRANSACTION;

-- ============ AI 智能中心建表（021）============
-- 变更目的：为「长征 AI 智能助手 / 路线讲解 / 答题解析 / 题库工坊 / 用量限额」新增 6 张表，
--           支撑历史问答会话、知识资料审核、AI 出题任务与草稿、调用日志与日限额计数。
-- 影响面：仅新增表与索引，不改动任何现有业务表、不重算历史数据、不影响已有接口契约。
--         新表全部独立于现有 questions/users/route_nodes，AI 关闭时不被读写，业务零影响。
-- 回滚：无副作用，可直接忽略；如需彻底回退，单独走运维流程 DROP 这 6 张 ai_* 表（不在本脚本内）。

-- 知识资料：仅 status=published 参与正式问答检索；node_id 非空表示绑定路线节点固定讲解
CREATE TABLE IF NOT EXISTS ai_knowledge (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    source VARCHAR(300),
    related JSON,
    category VARCHAR(20),
    node_id INTEGER REFERENCES route_nodes (id),
    status VARCHAR(16) NOT NULL DEFAULT 'draft',
    created_by VARCHAR(64),
    reviewed_by VARCHAR(64),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMP
);

-- AI 会话：归属 user_id，跨用户不可读写；删除时服务层显式连同消息一并删除
CREATE TABLE IF NOT EXISTS ai_conversations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    title VARCHAR(100),
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- AI 消息：role=user/assistant/system；sources 为后端核验过的知识来源；used_tokens 为平台原值
CREATE TABLE IF NOT EXISTS ai_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL,
    content TEXT NOT NULL,
    sources JSON,
    used_tokens INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 题目生成任务：一次生成请求一条，记录请求/成功/失败数与执行状态
CREATE TABLE IF NOT EXISTS ai_generation_jobs (
    id SERIAL PRIMARY KEY,
    job_type VARCHAR(20) NOT NULL DEFAULT 'question',
    topic VARCHAR(100) NOT NULL,
    params JSON,
    requested INTEGER NOT NULL DEFAULT 0,
    succeeded INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    error TEXT,
    created_by VARCHAR(64),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP
);

-- AI 题目草稿：data 为题目内容 JSON；status=pending/approved/rejected/imported；question_id 为入库后正式题 id
CREATE TABLE IF NOT EXISTS ai_generated_questions (
    id SERIAL PRIMARY KEY,
    job_id INTEGER REFERENCES ai_generation_jobs (id),
    data JSON NOT NULL,
    errors JSON,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    reviewed_by VARCHAR(64),
    reviewed_at TIMESTAMP,
    question_id INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- AI 调用日志：day_key 为北京时间当日 YYYY-MM-DD，用于 (user_id, day_key) 日限额计数与后续用量统计
CREATE TABLE IF NOT EXISTS ai_usage_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    conversation_id INTEGER,
    feature VARCHAR(30) NOT NULL,
    model VARCHAR(64),
    used_tokens INTEGER,
    elapsed_ms INTEGER,
    status VARCHAR(16) NOT NULL DEFAULT 'success',
    error_code VARCHAR(50),
    day_key VARCHAR(10) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 索引：openGauss 部分版本不支持 CREATE INDEX IF NOT EXISTS，统一用 DO 块 + pg_indexes 判定（幂等）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'ai_knowledge' AND indexname = 'ix_ai_knowledge_status_cat') THEN
        CREATE INDEX ix_ai_knowledge_status_cat ON ai_knowledge (status, category);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'ai_knowledge' AND indexname = 'ix_ai_knowledge_node') THEN
        CREATE INDEX ix_ai_knowledge_node ON ai_knowledge (node_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'ai_conversations' AND indexname = 'ix_ai_conversations_user_updated') THEN
        CREATE INDEX ix_ai_conversations_user_updated ON ai_conversations (user_id, updated_at);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'ai_messages' AND indexname = 'ix_ai_messages_conv_id') THEN
        CREATE INDEX ix_ai_messages_conv_id ON ai_messages (conversation_id, id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'ai_generation_jobs' AND indexname = 'ix_ai_jobs_created') THEN
        CREATE INDEX ix_ai_jobs_created ON ai_generation_jobs (created_at);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'ai_generated_questions' AND indexname = 'ix_ai_genq_status') THEN
        CREATE INDEX ix_ai_genq_status ON ai_generated_questions (status);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'ai_generated_questions' AND indexname = 'ix_ai_genq_job') THEN
        CREATE INDEX ix_ai_genq_job ON ai_generated_questions (job_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'ai_usage_logs' AND indexname = 'ix_ai_usage_user_day') THEN
        CREATE INDEX ix_ai_usage_user_day ON ai_usage_logs (user_id, day_key);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'ai_usage_logs' AND indexname = 'ix_ai_usage_day') THEN
        CREATE INDEX ix_ai_usage_day ON ai_usage_logs (day_key);
    END IF;
END $$;

COMMIT;
