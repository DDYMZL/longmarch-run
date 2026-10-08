START TRANSACTION;

CREATE TABLE IF NOT EXISTS route_nodes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    target_steps INTEGER NOT NULL,
    historical_time VARCHAR(50) NOT NULL,
    icon VARCHAR(16) NOT NULL,
    description TEXT NOT NULL,
    latitude NUMERIC(9, 6) NOT NULL,
    longitude NUMERIC(10, 6) NOT NULL,
    sort_order INTEGER NOT NULL,
    is_enabled BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY,
    type VARCHAR(10) NOT NULL,
    question TEXT NOT NULL,
    options JSON NOT NULL,
    answer JSON NOT NULL,
    analysis TEXT NOT NULL,
    score INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS medal_defs (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    icon VARCHAR(16) NOT NULL,
    "desc" VARCHAR(200) NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    parent_id INTEGER,
    level INTEGER NOT NULL,
    sort_order INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_organizations_parent_id
    ON organizations (parent_id);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    openid VARCHAR(64) NOT NULL,
    nickname VARCHAR(64) NOT NULL,
    avatar VARCHAR(500) NOT NULL,
    org_id INTEGER,
    created_at TIMESTAMP NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_users_openid ON users (openid);
CREATE INDEX IF NOT EXISTS ix_users_org_id ON users (org_id);

CREATE TABLE IF NOT EXISTS daily_sport (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    date VARCHAR(10) NOT NULL,
    steps INTEGER NOT NULL,
    CONSTRAINT uq_sport_user_date UNIQUE (user_id, date)
);

CREATE INDEX IF NOT EXISTS ix_daily_sport_user_id ON daily_sport (user_id);
CREATE INDEX IF NOT EXISTS ix_daily_sport_date ON daily_sport (date);

CREATE TABLE IF NOT EXISTS lit_nodes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    node_id INTEGER NOT NULL,
    lit_at TIMESTAMP NOT NULL,
    CONSTRAINT uq_lit_user_node UNIQUE (user_id, node_id)
);

CREATE INDEX IF NOT EXISTS ix_lit_nodes_user_id ON lit_nodes (user_id);

CREATE TABLE IF NOT EXISTS quiz_records (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    date VARCHAR(10) NOT NULL,
    total_count INTEGER NOT NULL,
    correct_count INTEGER NOT NULL,
    score INTEGER NOT NULL,
    points INTEGER NOT NULL,
    wrong_list JSON NOT NULL,
    answer_at BIGINT NOT NULL,
    CONSTRAINT uq_quiz_user_date UNIQUE (user_id, date)
);

CREATE INDEX IF NOT EXISTS ix_quiz_records_user_id ON quiz_records (user_id);
CREATE INDEX IF NOT EXISTS ix_quiz_records_date ON quiz_records (date);

CREATE TABLE IF NOT EXISTS daily_questions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    date VARCHAR(10) NOT NULL,
    question_ids JSON NOT NULL,
    CONSTRAINT uq_dailyq_user_date UNIQUE (user_id, date)
);

CREATE INDEX IF NOT EXISTS ix_daily_questions_user_id ON daily_questions (user_id);
CREATE INDEX IF NOT EXISTS ix_daily_questions_date ON daily_questions (date);

CREATE TABLE IF NOT EXISTS points_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    date VARCHAR(10) NOT NULL,
    reason VARCHAR(50) NOT NULL,
    delta INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_points_log_user_id ON points_log (user_id);
CREATE INDEX IF NOT EXISTS ix_points_log_date ON points_log (date);

CREATE TABLE IF NOT EXISTS user_medals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    medal_id VARCHAR(50) NOT NULL,
    granted_at TIMESTAMP NOT NULL,
    CONSTRAINT uq_user_medal UNIQUE (user_id, medal_id)
);

CREATE INDEX IF NOT EXISTS ix_user_medals_user_id ON user_medals (user_id);

COMMIT;
