START TRANSACTION;

-- ============ 活动时间控制（016，V2.0 需求一）============
-- 单行配置（id 固定为 1）。start_at / end_at / updated_at 为 UTC naive 存储，
-- 管理端与小程序展示按北京时间换算；活动状态（未发布/未开始/进行中/已结束）
-- 不落库，由后端按服务器时间实时计算。
-- restrict_enabled=FALSE 时不拦截任何业务（仅展示状态）；
-- allow_view_after_end=TRUE 时活动结束后仍可查看历史成绩与历史排行。
CREATE TABLE IF NOT EXISTS activity_settings (
    id INTEGER PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    start_at TIMESTAMP NOT NULL,
    end_at TIMESTAMP NOT NULL,
    is_published BOOLEAN NOT NULL DEFAULT FALSE,
    restrict_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    allow_view_after_end BOOLEAN NOT NULL DEFAULT TRUE,
    end_title VARCHAR(64),
    end_message VARCHAR(500),
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by VARCHAR(64)
);

-- 默认配置保持现网行为：已发布、北京时间 2026-09-01 00:00 ~ 2026-12-31 23:59 进行中
INSERT INTO activity_settings (
    id, name, start_at, end_at, is_published, restrict_enabled, allow_view_after_end,
    end_title, end_message, updated_by
)
SELECT 1, '长征步迹·荣耀征程', TIMESTAMP '2026-08-31 16:00:00', TIMESTAMP '2026-12-31 15:59:00',
       TRUE, TRUE, TRUE,
       '征程圆满 · 荣耀永驻',
       '本次长征步迹活动已圆满结束，感谢每一位战友的坚持与奔跑。每一步都是致敬，每一程都是传承。',
       'system'
WHERE NOT EXISTS (SELECT 1 FROM activity_settings WHERE id = 1);

-- 活动设置菜单：默认仅超管可见，可在「人员授权 / 角色管理」中按需授予
INSERT INTO admin_menus (code, name, sort_order)
SELECT 'activity', '活动设置', 11
WHERE NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = 'activity');

COMMIT;
