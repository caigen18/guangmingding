-- 光明顶 v1 测试数据：1 个赛季 + 20 个玩家 + 20 个测试城市
-- 幂等：靠唯一约束 ON CONFLICT DO NOTHING，重复执行不会多出城市。

BEGIN;

-- 赛季 1（当前天数 1）
INSERT INTO seasons (season_no, name, current_day, status)
VALUES (1, '第一赛季', 1, 'active')
ON CONFLICT (season_no) DO NOTHING;

-- 20 个玩家（密码哈希留空，v1 登录后续接入）
INSERT INTO players (name)
SELECT '城主' || lpad(n::text, 2, '0')
FROM generate_series(1, 20) AS n
ON CONFLICT (name) DO NOTHING;

-- 20 座测试城市：5x4 网格，初始人口 100，初始资源相同
INSERT INTO cities (season_id, player_id, name, x, y, population, happiness, resources)
SELECT s.id, p.id, v.city_name, v.x, v.y, 100, 60,
       '{"grain": 120, "wood": 80, "stone": 60, "iron": 20, "cloth": 30}'::jsonb
FROM (VALUES
  ('金陵', '城主01', 0, 0), ('洛阳', '城主02', 1, 0), ('长安', '城主03', 2, 0), ('扬州', '城主04', 3, 0), ('成都', '城主05', 4, 0),
  ('苏州', '城主06', 0, 1), ('杭州', '城主07', 1, 1), ('开封', '城主08', 2, 1), ('太原', '城主09', 3, 1), ('襄阳', '城主10', 4, 1),
  ('江陵', '城主11', 0, 2), ('建康', '城主12', 1, 2), ('幽州', '城主13', 2, 2), ('凉州', '城主14', 3, 2), ('益州', '城主15', 4, 2),
  ('荆州', '城主16', 0, 3), ('徐州', '城主17', 1, 3), ('青州', '城主18', 2, 3), ('冀州', '城主19', 3, 3), ('并州', '城主20', 4, 3)
) AS v (city_name, player_name, x, y)
JOIN seasons s ON s.season_no = 1
JOIN players p ON p.name = v.player_name
ON CONFLICT (season_id, name) DO NOTHING;

-- 每个城市一套基础建筑：农田 5 级（100 人日均耗粮 50，产 60，刚好略有余粮）
INSERT INTO buildings (city_id, key, level, slot)
SELECT c.id, b.key, b.level, b.slot
FROM cities c
CROSS JOIN (VALUES
  ('farm', 1, 5), ('lumberyard', 2, 3), ('quarry', 3, 2),
  ('mine', 4, 1), ('workshop', 5, 2), ('market', 6, 1)
) AS b (key, slot, level)
ON CONFLICT (city_id, key) DO NOTHING;

-- 开市价格（第 1 天，基准价）
INSERT INTO market_prices (season_id, day, good, price, prev_price, delta_pct)
SELECT s.id, 1, p.good, p.price, p.price, 0
FROM seasons s
CROSS JOIN (VALUES
  ('grain', 10.00), ('wood', 12.00), ('stone', 14.00), ('iron', 30.00), ('cloth', 18.00)
) AS p (good, price)
WHERE s.season_no = 1
ON CONFLICT (season_id, day, good) DO NOTHING;

COMMIT;
