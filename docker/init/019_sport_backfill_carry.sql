START TRANSACTION;

-- ============ 微信运动近 7 日补录 + 步数结余（019）============
-- daily_sport 新增数据来源与最近同步时间：
--   source：werun 微信运动解密 / mock 开发模式模拟 / manual 手动补步（演示）；存量行按 werun 回填。
--   synced_at：最近一次写入该日步数的时间（UTC）；存量行为 NULL。
-- 行存在即「已成功处理」；微信未返回的日期不落库，由同步接口返回失败日期，下次同步自动重试。
ALTER TABLE daily_sport ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'werun';
ALTER TABLE daily_sport ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP;
ALTER TABLE daily_sport ADD COLUMN IF NOT EXISTS sync_status VARCHAR(16) NOT NULL DEFAULT 'processed';

-- 步行积分改为「结余」口径：每日计分步数 min(steps, 20000)，按日期顺序累计，
-- 当日积分 = floor(累计 / 1000) - floor(前一日累计 / 1000)，不足 1000 步的零头结余到下一条记录。
-- 按新口径重算存量台账（只改 walk 行，不删除任何数据）。
UPDATE points_log p
SET delta = c.delta, ref_id = c.id, updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
FROM (
    SELECT id, user_id, date,
           CAST(FLOOR(cum / 1000) - FLOOR((cum - capped) / 1000) AS INTEGER) AS delta
    FROM (
        SELECT id, user_id, date, LEAST(GREATEST(steps, 0), 20000) AS capped,
               SUM(LEAST(GREATEST(steps, 0), 20000)) OVER (
                   PARTITION BY user_id ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS cum
        FROM daily_sport
    ) t
) c
WHERE p.user_id = c.user_id AND p.biz_key = 'walk:' || c.date AND p.delta <> c.delta;

INSERT INTO points_log (user_id, date, reason, delta, source_type, ref_id, biz_key, created_at, updated_at)
SELECT c.user_id, c.date, '步行积分', c.delta, 'walk', c.id, 'walk:' || c.date,
       CURRENT_TIMESTAMP AT TIME ZONE 'UTC', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
FROM (
    SELECT id, user_id, date,
           CAST(FLOOR(cum / 1000) - FLOOR((cum - capped) / 1000) AS INTEGER) AS delta
    FROM (
        SELECT id, user_id, date, LEAST(GREATEST(steps, 0), 20000) AS capped,
               SUM(LEAST(GREATEST(steps, 0), 20000)) OVER (
                   PARTITION BY user_id ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS cum
        FROM daily_sport
    ) t
) c
WHERE c.delta > 0
  AND NOT EXISTS (
      SELECT 1 FROM points_log p WHERE p.user_id = c.user_id AND p.biz_key = 'walk:' || c.date
  );

COMMIT;
