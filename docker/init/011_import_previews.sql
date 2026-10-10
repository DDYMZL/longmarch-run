START TRANSACTION;

-- ============ Excel 批量导入预览暂存（011，V1.1：题库/寄语/人员批量导入）============
-- 上传解析后的整批数据以 JSON 暂存，管理员确认后由后端在同一事务写入正式表并置 confirmed。
-- token 一次性使用 + 过期时间，防止重复提交造成重复导入；payload 不落任何明文敏感凭证。

CREATE TABLE IF NOT EXISTS import_previews (
    token VARCHAR(36) PRIMARY KEY,
    biz_type VARCHAR(20) NOT NULL,
    payload JSON NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending',
    created_by VARCHAR(64),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    confirmed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_import_previews_biz ON import_previews (biz_type, status);

COMMIT;
