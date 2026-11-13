/**
 * season-reset.ts —— 世界重置（#4 第 4 节第 8 步）：开下一赛季，20 城 + 基础建筑 + 市场基准价复原，
 * 全员复活（破产状态清零），称号留在 players.titles 不动。
 */
import type { PoolClient } from 'pg';
import {
  GOODS,
  MARKET,
  STARTING_HAPPINESS,
  STARTING_POPULATION,
  STARTING_REPUTATION,
  STARTING_RESOURCES,
  STARTING_SILVER,
  type BuildingKey,
} from '../config/game.js';

/** 新赛季每座城的建筑模板（与 db/seed.sql 一致） */
const BUILDING_TEMPLATE: { key: BuildingKey; level: number; slot: number }[] = [
  { key: 'farm', level: 5, slot: 1 },
  { key: 'lumberyard', level: 3, slot: 2 },
  { key: 'quarry', level: 2, slot: 3 },
  { key: 'mine', level: 1, slot: 4 },
  { key: 'workshop', level: 2, slot: 5 },
  { key: 'market', level: 1, slot: 6 },
];

export async function resetSeason(
  client: PoolClient,
  fromSeasonId: string,
  fromSeasonNo: number,
): Promise<{ id: string; seasonNo: number }> {
  const nextNo = fromSeasonNo + 1;
  const created = await client.query<{ id: string; season_no: number }>(
    `INSERT INTO seasons (season_no, name, current_day, status)
     VALUES ($1, $2, 1, 'active')
     ON CONFLICT (season_no) DO NOTHING
     RETURNING id::text AS id, season_no`,
    [nextNo, `第${nextNo}赛季`],
  );
  let row = created.rows[0];
  if (!row) {
    const existing = await client.query<{ id: string; season_no: number }>(
      `SELECT id::text AS id, season_no FROM seasons WHERE season_no = $1`,
      [nextNo],
    );
    row = existing.rows[0];
  }
  if (!row) throw new Error('resetSeason: 新赛季创建失败');

  await client.query(
    `INSERT INTO cities (season_id, player_id, name, x, y, population, happiness, reputation, resources)
     SELECT $1, c.player_id, c.name, c.x, c.y, $2, $3, $4, $5::jsonb
       FROM cities c WHERE c.season_id = $6
     ON CONFLICT (season_id, name) DO NOTHING`,
    [
      row.id,
      STARTING_POPULATION,
      STARTING_HAPPINESS,
      STARTING_REPUTATION,
      JSON.stringify({ ...STARTING_RESOURCES, silver: STARTING_SILVER }),
      fromSeasonId,
    ],
  );

  await client.query(
    `INSERT INTO buildings (city_id, key, level, slot)
     SELECT nc.id, b.key, b.level, b.slot
       FROM cities nc
       CROSS JOIN jsonb_to_recordset($2::jsonb) AS b(key text, level int, slot int)
      WHERE nc.season_id = $1
     ON CONFLICT (city_id, key) DO NOTHING`,
    [row.id, JSON.stringify(BUILDING_TEMPLATE)],
  );

  await client.query(
    `INSERT INTO market_prices (season_id, day, good, price, prev_price, delta_pct)
     SELECT $1, 1, p.good, p.price, p.price, 0
       FROM jsonb_to_recordset($2::jsonb) AS p(good text, price numeric)
     ON CONFLICT (season_id, day, good) DO NOTHING`,
    [row.id, JSON.stringify(GOODS.map((g) => ({ good: g, price: MARKET.basePrice[g] })))],
  );

  await client.query(`UPDATE players SET status = 'alive'`);

  return { id: row.id, seasonNo: row.season_no };
}
