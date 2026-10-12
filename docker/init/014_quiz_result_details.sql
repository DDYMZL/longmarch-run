START TRANSACTION;

-- ============ 答题提交后统一反馈（014）============
-- 答题过程中不再即时判题（移除 /quiz/check），提交后由后端统一判分并保存逐题结果：
-- details = [{index, question_id, type, question, options, user_answer, correct_answer, correct, score, analysis}]。
-- 历史记录不回填、不重算成绩（details 为 NULL，前端回退展示 wrong_list 错题回顾）。

ALTER TABLE quiz_records ADD COLUMN IF NOT EXISTS details JSON;

COMMIT;
