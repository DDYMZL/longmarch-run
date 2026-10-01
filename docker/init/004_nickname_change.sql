START TRANSACTION;

-- 昵称修改（每人仅一次）：original_nickname 记录登录时的微信昵称，
-- nickname_changed_at 非空表示已使用唯一一次改名机会。
ALTER TABLE users ADD COLUMN original_nickname VARCHAR(64);
ALTER TABLE users ADD COLUMN nickname_changed_at TIMESTAMP;

-- 存量用户回填：以当前昵称作为曾用名（此后改名会记录时间）
UPDATE users SET original_nickname = nickname
WHERE original_nickname IS NULL OR original_nickname = '';

COMMIT;
