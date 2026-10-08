-- 修复 organizations.id 无自增序列（BUG-001）：
-- 早期建表为 INTEGER PRIMARY KEY（无 SERIAL），管理端新增组织时插入 NULL 主键报 500。
-- 已存在的库通过本迁移补建序列并接管默认值；新库由 001_schema.sql 的 SERIAL 直接创建。
START TRANSACTION;

CREATE SEQUENCE IF NOT EXISTS organizations_id_seq;

ALTER TABLE organizations
    ALTER COLUMN id SET DEFAULT nextval('organizations_id_seq');

-- setval(seq, max)：下一次 nextval 返回 max+1（空表时为 1）
SELECT setval('organizations_id_seq', COALESCE((SELECT MAX(id) FROM organizations), 0));

COMMIT;
