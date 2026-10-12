START TRANSACTION;

-- ============ 邀请码准入（015）============
-- 首次入驻必须持 PC 后台生成的有效邀请码；/auth/login 不再自动建号。
-- invite_codes.code 为小程序码 scene 参数（i=<code>，scene 上限 32 字符）；
-- org_id 非空时仅允许选择该组织及其下级；max_uses 为空不限次数；时间均为 UTC。
CREATE TABLE IF NOT EXISTS invite_codes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(32) NOT NULL,
    name VARCHAR(64) NOT NULL,
    remark VARCHAR(200),
    org_id INTEGER,
    max_uses INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMP,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by VARCHAR(64),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invite_codes_code ON invite_codes (code);

-- 用户准入状态：active 正常 / disabled 停用（禁止访问受保护接口）。
-- 存量用户（含历史自动建号用户）全部保留并回填 active，invite_code_id 为空即「历史用户」。
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code_id INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMP;
UPDATE users SET onboarded_at = created_at WHERE onboarded_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_users_invite_code_id ON users (invite_code_id);

INSERT INTO admin_menus (code, name, sort_order)
SELECT 'invites', '入驻邀请码', 10
WHERE NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = 'invites');

INSERT INTO admin_role_menus (role_id, menu_id)
SELECT r.id, m.id FROM admin_roles r, admin_menus m
WHERE r.code = 'operator' AND m.code = 'invites'
  AND NOT EXISTS (
      SELECT 1 FROM admin_role_menus x WHERE x.role_id = r.id AND x.menu_id = m.id
  );

COMMIT;
