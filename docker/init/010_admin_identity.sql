-- 微信身份关联 + 管理后台 RBAC（微信身份关联设计 docs/identity-binding-design.md）
-- 新增 8 张表：user_identities / bind_requests / qr_login_sessions /
-- admin_menus / admin_roles / admin_role_menus / admin_user_roles / audit_logs。
START TRANSACTION;

CREATE TABLE IF NOT EXISTS user_identities (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    provider VARCHAR(32) NOT NULL,
    app_id VARCHAR(64) NOT NULL,
    openid VARCHAR(64) NOT NULL,
    unionid VARCHAR(64),
    verified_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_identity_provider_openid UNIQUE (provider, app_id, openid),
    CONSTRAINT uq_identity_user_channel UNIQUE (user_id, provider, app_id)
);

CREATE INDEX IF NOT EXISTS ix_user_identities_user_id ON user_identities (user_id);
CREATE INDEX IF NOT EXISTS ix_user_identities_unionid ON user_identities (unionid);

CREATE TABLE IF NOT EXISTS bind_requests (
    id SERIAL PRIMARY KEY,
    token_hash VARCHAR(64) NOT NULL,
    user_id INTEGER REFERENCES users (id),
    provider VARCHAR(32) NOT NULL,
    app_id VARCHAR(64) NOT NULL,
    openid VARCHAR(64) NOT NULL,
    unionid VARCHAR(64),
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP,
    confirmed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bind_requests_token_hash ON bind_requests (token_hash);

CREATE TABLE IF NOT EXISTS qr_login_sessions (
    id VARCHAR(24) PRIMARY KEY,
    scene_token_hash VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    fail_reason VARCHAR(200),
    user_id INTEGER REFERENCES users (id),
    token_issued BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    confirmed_at TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_qr_login_scene_hash ON qr_login_sessions (scene_token_hash);

CREATE TABLE IF NOT EXISTS admin_menus (
    id SERIAL PRIMARY KEY,
    code VARCHAR(32) NOT NULL,
    name VARCHAR(32) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_menus_code ON admin_menus (code);

CREATE TABLE IF NOT EXISTS admin_roles (
    id SERIAL PRIMARY KEY,
    code VARCHAR(32) NOT NULL,
    name VARCHAR(32) NOT NULL,
    is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_roles_code ON admin_roles (code);

CREATE TABLE IF NOT EXISTS admin_role_menus (
    role_id INTEGER NOT NULL REFERENCES admin_roles (id),
    menu_id INTEGER NOT NULL REFERENCES admin_menus (id),
    PRIMARY KEY (role_id, menu_id)
);

CREATE TABLE IF NOT EXISTS admin_user_roles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    role_id INTEGER NOT NULL REFERENCES admin_roles (id),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    granted_by VARCHAR(64),
    granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_admin_user_role UNIQUE (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS ix_admin_user_roles_user_id ON admin_user_roles (user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    actor_type VARCHAR(16) NOT NULL,
    actor_user_id INTEGER,
    action VARCHAR(50) NOT NULL,
    target_user_id INTEGER,
    detail TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_audit_logs_created_at ON audit_logs (created_at);
CREATE INDEX IF NOT EXISTS ix_audit_logs_target ON audit_logs (target_user_id);

-- 菜单种子（access/audit 默认仅超级管理员可见，可由角色管理授予自定义角色）
INSERT INTO admin_menus (code, name, sort_order) VALUES
    ('dashboard', '驾驶舱', 1),
    ('screen', '数据大屏', 2),
    ('rankings', '排名洞察', 3),
    ('route_nodes', '路线点位', 4),
    ('questions', '题库维护', 5),
    ('quotes', '每日寄语', 6),
    ('orgs', '组织架构', 7),
    ('access', '人员授权', 8),
    ('audit', '审计日志', 9);

-- 内置角色：运营管理员（全部业务菜单，不含人员授权/审计日志）
INSERT INTO admin_roles (code, name, is_builtin) VALUES ('operator', '运营管理员', TRUE);

INSERT INTO admin_role_menus (role_id, menu_id)
SELECT r.id, m.id FROM admin_roles r, admin_menus m
WHERE r.code = 'operator'
  AND m.code IN ('dashboard', 'screen', 'rankings', 'route_nodes', 'questions', 'quotes', 'orgs');

COMMIT;
