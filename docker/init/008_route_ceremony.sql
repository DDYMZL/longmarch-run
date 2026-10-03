START TRANSACTION;

-- ============ 长征完成仪式（008，需求 §20）============
-- 与 backend/app/models/models.py 同步。
-- route_ceremony_at 非空表示用户已观看「首次完成长征」仪式动画；
-- 触发规则（§20.4）：路线全部点亮且该字段为空时，/march/route 下发 ceremony_pending=true，
-- 前端播放完整仪式后调 POST /march/ceremony 标记，之后仅展示「已完成长征」。

ALTER TABLE users ADD COLUMN route_ceremony_at TIMESTAMP NULL;

COMMIT;
