START TRANSACTION;

-- ============ 每日寄语按天循环（013，V1.1 功能二）============
-- 寄语由「按日期绑定」改为「排序号 + 启用状态」：启用寄语按 (sort_order, id) 升序排列，
-- 今日展示索引 = (今天 - 循环起始日期) % 启用条数，由后端按日期即时计算，无需定时任务。
-- 循环起始日期存 system_settings（quote_cycle_start），管理端可修改。

ALTER TABLE daily_quotes ADD COLUMN IF NOT EXISTS sort_order INTEGER;
ALTER TABLE daily_quotes ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN;

-- 按原展示日期编号，迁移后轮播顺序与原日期顺序一致
UPDATE daily_quotes q
SET sort_order = r.rn
FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY date, id) AS rn FROM daily_quotes) r
WHERE q.id = r.id AND q.sort_order IS NULL;
UPDATE daily_quotes SET is_enabled = TRUE WHERE is_enabled IS NULL;

ALTER TABLE daily_quotes ALTER COLUMN sort_order SET NOT NULL;
ALTER TABLE daily_quotes ALTER COLUMN sort_order SET DEFAULT 0;
ALTER TABLE daily_quotes ALTER COLUMN is_enabled SET NOT NULL;
ALTER TABLE daily_quotes ALTER COLUMN is_enabled SET DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS system_settings (
    setting_key VARCHAR(64) PRIMARY KEY,
    setting_value VARCHAR(200) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 起始日期取原最早寄语日期（原第一条寄语即循环首条）；空表时取迁移当天
INSERT INTO system_settings (setting_key, setting_value)
SELECT 'quote_cycle_start', COALESCE(MIN(date), to_char(CURRENT_DATE, 'YYYY-MM-DD'))
FROM daily_quotes
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'quote_cycle_start');

ALTER TABLE daily_quotes DROP COLUMN IF EXISTS date;

CREATE INDEX IF NOT EXISTS ix_daily_quotes_cycle ON daily_quotes (is_enabled, sort_order, id);

COMMIT;
