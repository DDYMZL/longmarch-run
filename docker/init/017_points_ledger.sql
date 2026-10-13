START TRANSACTION;

-- ============ 积分台账（017，V2.0 需求三/四）============
-- 新口径：总积分 = 步行积分 + 答题积分，其余来源（登录/达标/点亮/里程碑等旧规则）不再发放，
-- 旧流水保留为 source_type='legacy' 仅供追溯，不计入总积分与排名。
-- 每个来源每人每自然日一行，biz_key 为业务唯一键（walk:YYYY-MM-DD / quiz:YYYY-MM-DD），
-- 由后端在业务事务内按源数据重算覆盖（幂等，重复同步/重放请求不会重复计分）。
-- ref_id：walk 行指向 daily_sport.id，quiz 行指向 daily_questions.id（当日答题会话）。
ALTER TABLE points_log ADD COLUMN IF NOT EXISTS source_type VARCHAR(16) NOT NULL DEFAULT 'legacy';
ALTER TABLE points_log ADD COLUMN IF NOT EXISTS ref_id INTEGER;
ALTER TABLE points_log ADD COLUMN IF NOT EXISTS biz_key VARCHAR(64);
ALTER TABLE points_log ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE points_log ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS uq_points_user_biz ON points_log (user_id, biz_key);
CREATE INDEX IF NOT EXISTS ix_points_log_source_user ON points_log (source_type, user_id);

-- 步行积分回填：floor(min(steps, 20000) / 1000)，不足 1000 步不生成行
INSERT INTO points_log (user_id, date, reason, delta, source_type, ref_id, biz_key, created_at, updated_at)
SELECT s.user_id, s.date, '步行积分',
       CAST(FLOOR(LEAST(s.steps, 20000) / 1000) AS INTEGER),
       'walk', s.id, 'walk:' || s.date,
       CURRENT_TIMESTAMP AT TIME ZONE 'UTC', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
FROM daily_sport s
WHERE s.steps >= 1000
  AND NOT EXISTS (
      SELECT 1 FROM points_log p WHERE p.user_id = s.user_id AND p.biz_key = 'walk:' || s.date
  );

-- 答题积分回填：答对数 × 2，单日上限 10
INSERT INTO points_log (user_id, date, reason, delta, source_type, ref_id, biz_key, created_at, updated_at)
SELECT q.user_id, q.date, '答题积分',
       LEAST(q.correct_count * 2, 10),
       'quiz', dq.id, 'quiz:' || q.date,
       CURRENT_TIMESTAMP AT TIME ZONE 'UTC', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
FROM quiz_records q
LEFT JOIN daily_questions dq ON dq.user_id = q.user_id AND dq.date = q.date
WHERE q.correct_count > 0
  AND NOT EXISTS (
      SELECT 1 FROM points_log p WHERE p.user_id = q.user_id AND p.biz_key = 'quiz:' || q.date
  );

UPDATE quiz_records SET points = LEAST(correct_count * 2, 10);

COMMIT;
