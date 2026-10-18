START TRANSACTION;

-- ============ 运营增强菜单码（024）============
-- 变更目的：向 admin_menus 注入本次「长征步迹体验与运营增强」新增的 5 个管理页菜单码，
--           供后端 require_menu 细粒度鉴权，并作为「人员授权 / 角色管理」可授予的权限项
--           （与 admin/src/router/menus.ts 目录保持一致）：
--             chapters         长征章节维护（A3 章节外化）
--             persons          人物志维护（A4）
--             medals           勋章维护（A4）
--             operation_config 运营参数配置（A2）
--             analytics        数据运营分析（A8）
-- 影响面：仅新增 admin_menus 记录；默认不授予内置 operator 角色（沿用 access/audit/AI 菜单做法，
--         即新菜单默认仅超级管理员可见，可由「人员授权」页按需授予自定义角色）。不改任何业务表。
-- 回滚：无副作用，可直接忽略；如需回退，单独 DELETE FROM admin_menus WHERE code IN (下列 5 码)。

-- 幂等：DO 块内逐码 IF NOT EXISTS 判定后 INSERT ... VALUES，重复执行不产生重复行；
-- 不依赖 SELECT-without-FROM 与 ON CONFLICT（openGauss 兼容性最稳）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = 'chapters') THEN
        INSERT INTO admin_menus (code, name, sort_order) VALUES ('chapters', '长征章节', 15);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = 'persons') THEN
        INSERT INTO admin_menus (code, name, sort_order) VALUES ('persons', '人物志维护', 16);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = 'medals') THEN
        INSERT INTO admin_menus (code, name, sort_order) VALUES ('medals', '勋章维护', 17);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = 'operation_config') THEN
        INSERT INTO admin_menus (code, name, sort_order) VALUES ('operation_config', '运营参数', 18);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM admin_menus WHERE code = 'analytics') THEN
        INSERT INTO admin_menus (code, name, sort_order) VALUES ('analytics', '数据运营分析', 19);
    END IF;
END $$;

COMMIT;
