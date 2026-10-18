START TRANSACTION;

-- ============ 同步失败持久化 + 匿名事件（025）============
-- 变更目的（点13 数据运营分析）：
--   1) daily_sport 新增 fail_reason：配合已有 sync_status='failed' 记录微信运动未返回/格式无效等
--      失败原因，供管理端「同步失败清单」只读感知；失败行 steps 可为 0 占位、不计入累计步数与积分。
--   2) user_event.user_id 放开 NOT NULL：邀请漏斗埋点 INVITE_SCAN 为「扫码校验邀请码」的匿名事件，
--      尚无用户上下文（user_id 为空），仅按邀请码分组做漏斗统计，不进入实时动态流、不 WS 广播。
-- 影响面：daily_sport 加一列（存量行 fail_reason 为 NULL，等价「无失败原因」）；
--         user_event.user_id 由 NOT NULL 改为可空（存量行均非空，语义不变）。不改任何存量数据值。
-- 回滚：如需回退，ALTER TABLE daily_sport DROP COLUMN fail_reason；
--       user_event.user_id 恢复 NOT NULL 需先清理 user_id 为空的匿名事件行（INVITE_SCAN）后再 SET NOT NULL。

-- 幂等：openGauss 不支持 ADD COLUMN IF NOT EXISTS（SQL_CONSTRAINTS.md §1.1），
--       改用 DO 块 + information_schema 判定；DROP NOT NULL 对已可空列是无副作用的空操作。
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_sport' AND column_name = 'fail_reason'
    ) THEN
        ALTER TABLE daily_sport ADD COLUMN fail_reason VARCHAR(200);
    END IF;
END $$;
ALTER TABLE user_event ALTER COLUMN user_id DROP NOT NULL;

-- ============ 分析类事件去重加强 + FIRST_LOGIN 时间口径（025 / #21）============
-- 目的：FIRST_LOGIN 为「每用户至多一条」的一次性分析事件，并发登录下 has_event+record
--       仍存在竞态；用部分唯一索引在库层兜底（openGauss 兼容 PG 部分索引语法），
--       并把事件时间统一为用户 created_at，使邀请漏斗按「注册时刻」而非「首次触发登录时刻」归因。
-- 幂等：先去重（每用户保留最早一条 FIRST_LOGIN），再建唯一索引；回填/对齐均带存在性判据。

-- 1) 去重：删除同一用户多余的 FIRST_LOGIN，仅保留 id 最小（最早）的一条，避免建唯一索引冲突。
DELETE FROM user_event
WHERE event_type = 'FIRST_LOGIN'
  AND user_id IS NOT NULL
  AND id NOT IN (
      SELECT MIN(id) FROM user_event
      WHERE event_type = 'FIRST_LOGIN' AND user_id IS NOT NULL
      GROUP BY user_id
  );

-- 2) 部分唯一索引：FIRST_LOGIN 每用户至多一条（库层原子去重，兜底应用层 has_event 竞态）。
--    openGauss 对 CREATE INDEX IF NOT EXISTS 支持不稳定（SQL_CONSTRAINTS.md §1.2），改用 pg_indexes 判定。
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'user_event' AND indexname = 'uq_user_event_first_login'
    ) THEN
        CREATE UNIQUE INDEX uq_user_event_first_login
            ON user_event (user_id) WHERE event_type = 'FIRST_LOGIN';
    END IF;
END $$;

-- 3) 存量回填：为尚无 FIRST_LOGIN 的用户按其 created_at 补一条（NOT EXISTS 防重，可重复执行）。
--    event_data 置 NULL（漏斗统计不读该负载），避免 JSON 字面量方言差异。
INSERT INTO user_event (user_id, event_type, event_time, event_data)
SELECT u.id, 'FIRST_LOGIN', u.created_at, NULL
FROM users u
WHERE u.created_at IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM user_event e
      WHERE e.user_id = u.id AND e.event_type = 'FIRST_LOGIN'
  );

-- 4) 时间对齐：已存在的 FIRST_LOGIN 事件时间统一改为用户 created_at（仅在确有差异时更新）。
UPDATE user_event e
SET event_time = u.created_at
FROM users u
WHERE e.event_type = 'FIRST_LOGIN'
  AND e.user_id = u.id
  AND u.created_at IS NOT NULL
  AND e.event_time IS DISTINCT FROM u.created_at;

COMMIT;
