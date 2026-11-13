/**
 * settleDay —— 一日结算（M6 / issue #16）。
 *
 * 流程：BEGIN → 取 active 赛季（行锁）→ advisory xact lock → 幂等检查 → 读 20 城+建筑
 *      → 内存算产量/消耗/人口/幸福度/市场价格 → 一次批量写回 → day_logs → current_day+1 → COMMIT。
 * 并发：同一 day 只允许一个事务结算（pg_advisory_xact_lock），其他进程等到锁后
 *      看到 day_logs 已有记录就返回 skipped。
 */
import { performance } from 'node:perf_hooks';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import {
  BUILDINGS,
  CONSUMPTION_PER_CAPITA,
  GOODS,
  MARKET,
  POPULATION,
  SETTLE_LOCK_KEY,
  type BuildingKey,
  type Good,
} from '../config/game.js';

export type MarketQuote = { good: Good; price: number; prevPrice: number; deltaPct: number };

export type SettleResult = {
  day: number;
  durationMs: number;
  citiesSettled: number;
  skipped: boolean;
  totals: {
    produced: Record<string, number>;
    consumed: Record<string, number>;
    populationBefore: number;
    populationAfter: number;
  };
  market: MarketQuote[];
};

type CityRow = {
  id: string;
  population: number;
  happiness: number;
  resources: Record<string, number> | null;
  buildings: { key: BuildingKey; level: number }[];
};

type Stock = Record<Good, number>;
type CityUpdate = {
  id: string;
  population: number;
  happiness: number;
  resources: Record<string, number>;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export async function settleDay(targetDay?: number): Promise<SettleResult> {
  const startedAt = performance.now();
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const season = await client.query<{ id: string; current_day: number }>(
      `SELECT id::text AS id, current_day FROM seasons
        WHERE status = 'active' ORDER BY season_no LIMIT 1 FOR UPDATE`,
    );
    const seasonRow = season.rows[0];
    if (!seasonRow) throw new Error('settleDay: 没有 active 赛季');
    const seasonId = seasonRow.id;
    const day = targetDay ?? seasonRow.current_day;

    // 同一 day 只允许一个事务结算；后来的进程在锁上等，拿到锁时前一个已提交。
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), $2::int)', [SETTLE_LOCK_KEY, day]);

    const dup = await client.query('SELECT 1 FROM day_logs WHERE season_id = $1 AND day = $2', [
      seasonId,
      day,
    ]);
    if ((dup.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return {
        day,
        durationMs: Math.round(performance.now() - startedAt),
        citiesSettled: 0,
        skipped: true,
        totals: { produced: {}, consumed: {}, populationBefore: 0, populationAfter: 0 },
        market: [],
      };
    }

    const cities = await client.query<CityRow>(
      `SELECT c.id::text AS id,
              c.population::float8 AS population,
              c.happiness::float8  AS happiness,
              c.resources,
              COALESCE(b.buildings, '[]'::json) AS buildings
         FROM cities c
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('key', bb.key, 'level', bb.level)) AS buildings
             FROM buildings bb WHERE bb.city_id = c.id
         ) b ON TRUE
        WHERE c.season_id = $1`,
      [seasonId],
    );

    const produced: Record<string, number> = {};
    const consumed: Record<string, number> = {};
    const updates: CityUpdate[] = [];
    let populationBefore = 0;
    let populationAfter = 0;

    for (const city of cities.rows) {
      const resources: Stock = { grain: 0, wood: 0, stone: 0, iron: 0, cloth: 0 };
      for (const good of GOODS) resources[good] = round2(num(city.resources?.[good]));
      // 保留 GOODS 之外的资源键（如银 silver），结算不该抹掉它们
      const extras: Record<string, number> = {};
      for (const [key, value] of Object.entries(city.resources ?? {})) {
        if (!(GOODS as readonly string[]).includes(key)) extras[key] = round2(num(value));
      }

      // 1) 产量
      for (const b of city.buildings) {
        const def = BUILDINGS[b.key];
        if (!def || def.good === null) continue;
        const amount = def.outputPerLevel * b.level;
        resources[def.good] = round2(resources[def.good] + amount);
        produced[def.good] = round2((produced[def.good] ?? 0) + amount);
      }

      // 2) 消耗（存粮先扣，记录扣之前的量用于人口增长判断）
      const grainBeforeConsumption = resources.grain;
      const pop = num(city.population);
      let starving = false;
      for (const good of GOODS) {
        const perCapita = CONSUMPTION_PER_CAPITA[good] ?? 0;
        if (perCapita <= 0) continue;
        const need = pop * perCapita;
        const have = resources[good];
        const used = Math.min(have, need);
        resources[good] = round2(have - used);
        consumed[good] = round2((consumed[good] ?? 0) + used);
        if (used + 1e-9 < need) starving = true;
      }

      // 3) 人口 / 幸福度
      let happiness = num(city.happiness);
      let popNext = pop;
      const grainNeed = pop * (CONSUMPTION_PER_CAPITA.grain ?? 0);
      if (starving) {
        popNext = Math.max(0, Math.floor(pop * (1 - POPULATION.starveRate)));
        happiness -= POPULATION.starveHappiness;
      } else if (grainNeed > 0 && grainBeforeConsumption >= grainNeed * POPULATION.growthFoodRatio) {
        popNext = Math.max(1, Math.floor(pop * (1 + POPULATION.growthRate)));
        happiness += POPULATION.happinessDrift;
      }
      happiness = clamp(
        happiness +
          Math.sign(POPULATION.happinessNeutral - happiness) *
            Math.min(POPULATION.happinessDrift, Math.abs(POPULATION.happinessNeutral - happiness)),
        0,
        100,
      );

      populationBefore += pop;
      populationAfter += popNext;
      updates.push({
        id: city.id,
        population: popNext,
        happiness: round2(happiness),
        resources: { ...extras, ...resources },
      });
    }

    // 4) 市场价格（按全服总产量与总人口的日需求）
    const prevPrices = await client.query<{ good: Good; price: number }>(
      `SELECT DISTINCT ON (good) good, price::float8 AS price
         FROM market_prices
        WHERE season_id = $1 AND day < $2
        ORDER BY good, day DESC`,
      [seasonId, day],
    );
    const prevMap = new Map(prevPrices.rows.map((r) => [r.good, r.price]));

    const market: MarketQuote[] = GOODS.map((good) => {
      const demand = round2(populationAfter * (MARKET.demandPerCapita[good] ?? 0));
      const supply = round2(produced[good] ?? 0);
      const prevPrice = prevMap.get(good) ?? MARKET.basePrice[good];
      const pressure = (demand - supply) / Math.max(supply, 1);
      const rawPct = MARKET.elasticity * pressure * 100;
      const deltaPct = round2(clamp(rawPct, -MARKET.maxDeltaPct, MARKET.maxDeltaPct));
      const price = round2(clamp(prevPrice * (1 + deltaPct / 100), MARKET.minPrice, MARKET.maxPrice));
      return { good, price, prevPrice: round2(prevPrice), deltaPct };
    });

    // 5) 批量写回（一次 UPDATE、一次 INSERT）
    await client.query(
      `UPDATE cities c
          SET population = v.population,
              happiness  = v.happiness,
              resources  = v.resources,
              version    = c.version + 1,
              updated_at = now()
         FROM jsonb_to_recordset($1::jsonb)
              AS v(id uuid, population numeric, happiness numeric, resources jsonb)
        WHERE c.id = v.id`,
      [JSON.stringify(updates)],
    );

    await client.query(
      `INSERT INTO market_prices (season_id, day, good, price, prev_price, delta_pct)
       SELECT $1, $2, x.good, x.price, x.\"prevPrice\", x.\"deltaPct\"
         FROM jsonb_to_recordset($3::jsonb)
              AS x(good text, price numeric, \"prevPrice\" numeric, \"deltaPct\" numeric)
       ON CONFLICT (season_id, day, good)
       DO UPDATE SET price = EXCLUDED.price,
                     prev_price = EXCLUDED.prev_price,
                     delta_pct = EXCLUDED.delta_pct`,
      [seasonId, day, JSON.stringify(market)],
    );

    const durationMs = Math.round(performance.now() - startedAt);
    await client.query(
      `INSERT INTO day_logs (season_id, day, duration_ms, cities_settled, summary)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        seasonId,
        day,
        durationMs,
        updates.length,
        JSON.stringify({ produced, consumed, populationBefore, populationAfter, market }),
      ],
    );

    await client.query('UPDATE seasons SET current_day = GREATEST(current_day, $2) WHERE id = $1', [
      seasonId,
      day + 1,
    ]);

    await client.query('COMMIT');

    return {
      day,
      durationMs: Math.round(performance.now() - startedAt),
      citiesSettled: updates.length,
      skipped: false,
      totals: { produced, consumed, populationBefore, populationAfter },
      market,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
