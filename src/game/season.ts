/**
 * season.ts —— 赛季末结算（#4 第 4 节第 8 步）：
 *   settling → 净资产排名 → 三档结局（称雄/存活/出局）→ ended → 世界重置（下一赛季）
 *   称号追加到 players.titles，跨赛季保留。
 */
import type { PoolClient } from 'pg';
import {
  GAME,
  GOODS,
  MARKET,
  STARTING_HAPPINESS,
  STARTING_POPULATION,
  STARTING_REPUTATION,
  STARTING_RESOURCES,
  STARTING_SILVER,
  type BuildingKey,
} from '../config/game.js';

export type SeasonRankInput = {
  cityId: string;
  city: string;
  player: string | null;
  playerId: string | null;
  population: number;
  happiness: number;
  silver: number;
  grain: number;
  reputation: number;
  buildingValue: number;
  bankrupt: boolean;
  bankruptReason: string | null;
};

export type Ending = '称雄' | '存活' | '出局';

export type SeasonRank = SeasonRankInput & { rank: number; netWorth: number; ending: Ending };

export type SeasonSummary = {
  seasonNo: number;
  seasonDays: number;
  endedAt: string;
  grainPrice: number;
  champion: SeasonRank | null;
  rankings: SeasonRank[];
  nextSeason: { id: string; seasonNo: number } | null;
};

/** 净资产 = 银 + 粮 × 当日粮价 + 建筑估值 + 声望 × GAME.reputationValue（#1 胜负条件） */
export function netWorthOf(
  r: Pick<SeasonRankInput, 'silver' | 'grain' | 'reputation' | 'buildingValue'>,
  grainPrice: number,
): number {
  const raw = r.silver + r.grain * grainPrice + r.buildingValue + r.reputation * GAME.reputationValue;
  return Math.round(raw * 100) / 100;
}

export type CloseSeasonInput = {
  seasonId: string;
  seasonNo: number;
  grainPrice: number;
  seasonDays: number;
  ranks: SeasonRankInput[];
  resetWorld: boolean;
};

export async function closeSeason(
  client: PoolClient,
  input: CloseSeasonInput,
): Promise<SeasonSummary> {
  await client.query(`UPDATE seasons SET status = 'settling' WHERE id = $1`, [input.seasonId]);

  const rankings: SeasonRank[] = input.ranks
    .map((r) => ({ ...r, netWorth: netWorthOf(r, input.grainPrice), rank: 0, ending: '存活' as Ending }))
    .sort((a, b) => b.netWorth - a.netWorth)
    .map((r, i) => ({ ...r, rank: i + 1 }))
    .map((r) => ({
      ...r,
      ending: (r.bankrupt
        ? '出局'
        : r.rank === 1 && r.reputation >= GAME.championReputation
          ? '称雄'
          : '存活') as Ending,
    }));

  // 称号：称雄 / 前三名一方霸主 / 其余偏安一隅；破产者记出局
  for (const r of rankings) {
    if (!r.player) continue;
    const title =
      r.ending === '称雄' ? '称雄' : r.rank <= 3 ? '一方霸主' : r.ending === '出局' ? '出局' : '偏安一隅';
    await client.query(`UPDATE players SET titles = titles || $2::jsonb WHERE name = $1`, [
      r.player,
      JSON.stringify([
        { season: input.seasonNo, ending: r.ending, rank: r.rank, title, city: r.city },
      ]),
    ]);
  }

  await client.query(`UPDATE seasons SET status = 'ended', ends_at = now() WHERE id = $1`, [
    input.seasonId,
  ]);

  const nextSeason = input.resetWorld
    ? await createNextSeason(client, input.seasonId, input.seasonNo)
    : null;

  return {
    seasonNo: input.seasonNo,
    seasonDays: input.seasonDays,
    endedAt: new Date().toISOString(),
    grainPrice: input.grainPrice,
    champion: rankings[0] ?? null,
    rankings,
    nextSeason,
  };
}

/** 新赛季的一份新世界：同玩家同城名，资源/人口/幸福度/声望/建筑回到起始值 */
const BUILDING_TEMPLATE: { key: BuildingKey; level: number; slot: number }[] = [
  { key: 'farm', level: 5, slot: 1 },
  { key: 'lumberyard', level: 3, slot: 2 },
  { key: 'quarry', level: 2, slot: 3 },
  { key: 'mine', level: 1, slot: 4 },
  { key: 'workshop', level: 2, slot: 5 },
  { key: 'market', level: 1, slot: 6 },
];

async function createNextSeason(
  client: PoolClient,
  fromSeasonId: string,
  fromSeasonNo: number,
): Promise<{ id: string; seasonNo: number }> {
  const nextNo = fromSeasonNo + 1;
  const inserted = await client.query<{ id: string; season_no: number }>(
    `INSERT INTO seasons (season_no, name, current_day, status)
     VALUES ($1, $2, 1, 'active')
     ON CONFLICT (season_no) DO NOTHING
     RETURNING id::text AS id, season_no`,
    [nextNo, `第${nextNo}赛季`],
  );
  let row = inserted.rows[0];
  if (!row) {
    const existing = await client.query<{ id: string; season_no: number }>(
      `SELECT id::text AS id, season_no FROM seasons WHERE season_no = $1`,
      [nextNo],
    );
    row = existing.rows[0];
  }
  if (!row) throw new Error('createNextSeason: 新赛季创建失败');

  await client.query(
    `INSERT INTO cities (season_id, player_id, name, x, y, population, happiness, reputation, resources)
     SELECT $1, c.player_id, c.name, c.x, c.y, $2, $3, $4, $5::jsonb
       FROM cities c
      WHERE c.season_id = $6
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
       CROSS JOIN (VALUES
         ('farm', 5, 1), ('lumberyard', 3, 2), ('quarry', 2, 3),
         ('mine', 1, 4), ('workshop', 2, 5), ('market', 1, 6)
       ) AS b (key, level, slot)
      WHERE nc.season_id = $1
     ON CONFLICT (city_id, key) DO NOTHING`,
    [row.id],
  );

  await client.query(
    `INSERT INTO market_prices (season_id, day, good, price, prev_price, delta_pct)
     SELECT $1, 1, p.good, p.price, p.price, 0
       FROM jsonb_to_recordset($2::jsonb) AS p(good text, price numeric)
     ON CONFLICT (season_id, day, good) DO NOTHING`,
    [row.id, JSON.stringify(GOODS.map((g) => ({ good: g, price: MARKET.basePrice[g] })))],
  );

  // 世界重置：破产者在下一赛季复活，称号保留
  await client.query(`UPDATE players SET status = 'alive'`);

  return { id: row.id, seasonNo: row.season_no };
}
