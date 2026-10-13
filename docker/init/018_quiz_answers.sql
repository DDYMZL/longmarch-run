START TRANSACTION;

-- ============ 每题限时作答（018，V2.0 需求六）============
-- 一行 = 一次答题会话（daily_questions.id）中的一道题，记录服务器时间的开始/截止/提交，
-- 以及作答内容、判定结果与状态。时间均为 UTC。
-- status：answering 作答中 / answered 已作答 / timeout 已超时（超时不得分，之后不可再提交）。
-- (session_id, seq) 唯一：同一会话同一题序只能开题一次（并发开题由唯一约束兜底）。
CREATE TABLE IF NOT EXISTS quiz_answers (
    id           SERIAL PRIMARY KEY,
    session_id   INTEGER      NOT NULL REFERENCES daily_questions(id),
    user_id      INTEGER      NOT NULL REFERENCES users(id),
    date         VARCHAR(10)  NOT NULL,
    seq          INTEGER      NOT NULL,
    question_id  INTEGER      NOT NULL,
    started_at   TIMESTAMP    NOT NULL,
    deadline_at  TIMESTAMP    NOT NULL,
    submitted_at TIMESTAMP,
    user_answer  JSON,
    is_correct   BOOLEAN      NOT NULL DEFAULT FALSE,
    status       VARCHAR(16)  NOT NULL DEFAULT 'answering',
    points       INTEGER      NOT NULL DEFAULT 0,
    CONSTRAINT uq_quiz_answer_session_seq UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS ix_quiz_answers_user_date ON quiz_answers (user_id, date);

COMMIT;
