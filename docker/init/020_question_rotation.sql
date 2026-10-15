START TRANSACTION;

-- ============ 用户独立题目轮换（020）============
-- 题目删除改为软停用：停用题不参与之后的新抽题，但当天已生成的题目仍可继续作答，
-- 避免管理端操作使既有 daily_questions / quiz_answers 失效。
ALTER TABLE questions ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS ix_questions_active ON questions (active);

COMMIT;
