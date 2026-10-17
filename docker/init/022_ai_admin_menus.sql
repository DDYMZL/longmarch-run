START TRANSACTION;

-- ============ AI 智能中心菜单码（022）============
-- 变更目的：向 admin_menus 注入「AI 智能中心」5 个子页的菜单码，供后端 require_menu 细粒度鉴权、
--           并作为管理端权限页可授予的权限项（与 admin/src/router/menus.ts 目录保持一致）。
-- 影响面：仅新增 admin_menus 记录；默认不授予内置 operator 角色（沿用 access/audit 的做法，
--         即新菜单默认仅超级管理员可见，可由「人员授权」页按需授予自定义角色）。不改任何业务表。
-- 回滚：无副作用，可直接忽略；如需回退，单独 DELETE FROM admin_menus WHERE code IN (下列 5 码)。

-- 幂等：DO 块内逐码 IF NOT EXISTS 判定后 INSERT ... VALUES，重复执行不产生重复行；
-- 不依赖 SELECT-without-FROM 与 ON CONFLICT（openGauss 兼容性最稳）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = 'ai_overview') THEN
        INSERT INTO admin_menus (code, name, sort_order) VALUES ('ai_overview', 'AI运行概览', 10);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = 'ai_knowledge') THEN
        INSERT INTO admin_menus (code, name, sort_order) VALUES ('ai_knowledge', 'AI知识库', 11);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = 'ai_workshop') THEN
        INSERT INTO admin_menus (code, name, sort_order) VALUES ('ai_workshop', 'AI题目工坊', 12);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = 'ai_logs') THEN
        INSERT INTO admin_menus (code, name, sort_order) VALUES ('ai_logs', 'AI调用记录', 13);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = 'ai_config') THEN
        INSERT INTO admin_menus (code, name, sort_order) VALUES ('ai_config', 'AI配置中心', 14);
    END IF;
END $$;

COMMIT;
