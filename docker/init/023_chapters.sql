START TRANSACTION;

-- ============ 长征章节外化（023）============
-- 变更目的：把 march_service.CHAPTERS 常量外化到 chapters 表，支持管理端可视化增删改章节，
--           实现「路线节点划分为若干章」的配置化（需求 §4）。
-- 影响面：新增 chapters 表并幂等种子 5 章（与常量一致）；march_service 改为查表，
--         库空时仍回退常量，故本迁移对既有库安全、可重复执行。不改任何既有业务表。
-- 回滚：无外键依赖，可直接 DROP TABLE chapters；删除后 march_service 自动回退常量，功能不中断。

-- node_ids_json 为该章归属的 route_nodes 主键数组（JSON）；sort_order 升序即章节顺序。
-- 与 backend/app/models/models.py 的 Chapter 模型同步（node_ids 映射到 node_ids_json 列）。
CREATE TABLE IF NOT EXISTS chapters (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    title VARCHAR(100) DEFAULT '',
    intro TEXT,
    node_ids_json JSON,
    sort_order INTEGER DEFAULT 0
);

-- 幂等种子：逐章 IF NOT EXISTS 判定后 INSERT，重复执行不产生重复行；
-- 不依赖 ON CONFLICT（openGauss 兼容性最稳，参照 022_ai_admin_menus.sql 写法）。
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM chapters WHERE id = 1) THEN
        INSERT INTO chapters (id, name, title, intro, node_ids_json, sort_order) VALUES
            (1, '出发', '第一章 · 出发',
             '1934年10月，中央红军从瑞金等地出发踏上战略转移征途；1935年1月，遵义会议在最危急的关头挽救了党和红军。',
             '[1,2]', 1);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM chapters WHERE id = 2) THEN
        INSERT INTO chapters (id, name, title, intro, node_ids_json, sort_order) VALUES
            (2, '转折', '第二章 · 转折',
             '四渡赤水出奇兵，巧渡金沙江摆脱数十万敌军围追堵截，红军由被动转为主动。',
             '[3,4]', 2);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM chapters WHERE id = 3) THEN
        INSERT INTO chapters (id, name, title, intro, node_ids_json, sort_order) VALUES
            (3, '突围', '第三章 · 突围',
             '1935年5月，强渡大渡河、飞夺泸定桥，红军以血肉之躯撕开北上通道。',
             '[5,6]', 3);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM chapters WHERE id = 4) THEN
        INSERT INTO chapters (id, name, title, intro, node_ids_json, sort_order) VALUES
            (4, '翻越', '第四章 · 翻越',
             '翻越皑皑雪山，跋涉茫茫草地，红军以非凡意志战胜自然极限。',
             '[7,8]', 4);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM chapters WHERE id = 5) THEN
        INSERT INTO chapters (id, name, title, intro, node_ids_json, sort_order) VALUES
            (5, '会师', '第五章 · 会师',
             '1935年10月中央红军抵达吴起镇，1936年10月三大主力胜利会师，长征宣告胜利结束。',
             '[9,10]', 5);
    END IF;
END $$;

-- 接管自增序列：种子用显式主键写入，需 setval 到 MAX(id)，避免管理端新增章节时主键冲突
-- （下一次 nextval 返回 MAX(id)+1，空表时为 1；参照 009_org_serial.sql）。
SELECT setval('chapters_id_seq', COALESCE((SELECT MAX(id) FROM chapters), 0));

COMMIT;
