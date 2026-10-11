START TRANSACTION;

-- ============ 大数据量查询索引（012）============
-- lit_nodes.lit_at：今日播报「今日点亮数」、驾驶舱趋势「新增点亮」按时间范围过滤；
-- users.created_at：驾驶舱趋势「新增用户」按注册时间范围过滤；
-- user_event (user_id, event_type)：一次性成就去重（has_event）按用户 + 类型定位。

CREATE INDEX IF NOT EXISTS ix_lit_nodes_lit_at ON lit_nodes (lit_at);
CREATE INDEX IF NOT EXISTS ix_users_created_at ON users (created_at);
CREATE INDEX IF NOT EXISTS ix_user_event_user_type ON user_event (user_id, event_type);

COMMIT;
