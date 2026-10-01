START TRANSACTION;

ALTER TABLE route_nodes ADD COLUMN IF NOT EXISTS latitude NUMERIC(9, 6);
ALTER TABLE route_nodes ADD COLUMN IF NOT EXISTS longitude NUMERIC(10, 6);
ALTER TABLE route_nodes ADD COLUMN IF NOT EXISTS sort_order INTEGER;
ALTER TABLE route_nodes ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN;

UPDATE route_nodes
SET latitude = CASE id
        WHEN 1 THEN 25.885
        WHEN 2 THEN 27.72
        WHEN 3 THEN 28.3
        WHEN 4 THEN 26.28
        WHEN 5 THEN 29.25
        WHEN 6 THEN 29.91
        WHEN 7 THEN 30.75
        WHEN 8 THEN 33.58
        WHEN 9 THEN 36.92
        WHEN 10 THEN 36.6
        ELSE COALESCE(latitude, 0)
    END,
    longitude = CASE id
        WHEN 1 THEN 116.027
        WHEN 2 THEN 106.93
        WHEN 3 THEN 106.42
        WHEN 4 THEN 102.47
        WHEN 5 THEN 102.3
        WHEN 6 THEN 102.24
        WHEN 7 THEN 102.65
        WHEN 8 THEN 102.96
        WHEN 9 THEN 108.18
        WHEN 10 THEN 109.49
        ELSE COALESCE(longitude, 0)
    END,
    sort_order = COALESCE(NULLIF(sort_order, 0), id),
    is_enabled = COALESCE(is_enabled, TRUE);

ALTER TABLE route_nodes ALTER COLUMN latitude SET NOT NULL;
ALTER TABLE route_nodes ALTER COLUMN longitude SET NOT NULL;
ALTER TABLE route_nodes ALTER COLUMN sort_order SET NOT NULL;
ALTER TABLE route_nodes ALTER COLUMN is_enabled SET NOT NULL;

COMMIT;
