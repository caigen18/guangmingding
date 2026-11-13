/**
 * settleDay —— 一日结算（M6 / issue #16），按 #4 第 4 节八步：
 *   1 取赛季加锁：SELECT ... FOR UPDATE + pg_advisory_xact_lock(hashtext, day)
 *   2 产量：建筑按等级产粮/木/石/铁/布；市场按全服供需定统一价
 *   3 消耗：人口 1 人 1 日 0.5 粮（config）；缺粮记负数（欠账）→ 饥荒：人口降、幸福度降
 *   4 未选事件：保守过日，不罚、不生效，city_events 标 expired
 *   5 已选事件：执行 city_events.effects（资源/人口/幸福度/声望），标 resolved
 *   6 破产：银 < 0 且 粮 < 0 连续 GAME.bankruptDays 日 → players.status='bankrupt'，日志留原因
 *   7 每城一份账写进 day_logs.summary.cities（M8 day.settled 的载荷）
 *   8 current_day+1；到 config.seasonDays 由 season.ts 做 settling/排名/三档结局/ended/世界重置
 *
 * 并发：同一 day 只允许一个事务结算；后到的进程在 advisory lock 上等，拿到锁时看到
 *       day_logs 已有该 day 就 ROLLBACK 返回 skipped，不重复产出。
 */
import { performance } from 'node:perf_hooks';
import { pool } from '../db/pool.js';
import { closeSeason, type SeasonRankInput, type SeasonSummary } from './season.js';
import {
  BUILDINGS,
  CONSUMPTION_PER_CAPITA,
  GAME,
  GOODS,
  MARKET,
  POPULATION,
  SETTLE_LOCK_KEY,
  config,
  type BuildingKey,
  type Good,
} from '../config/game.js';
import { emitCityUpdated, emitDaySettled, emitMarketTick } from '../ws/events.js';

export type MarketQuote = { good: Good; price: number; prevPrice: number; deltaPct: number };

/** 事件效果：全是增量 */
export type EventEffects = {
  resources?: Record<string, number>;
  population?: number;
  happiness?: number;
  reputation?: number;
};

export type CityEventLog = {
  eventId: string;
  title: string;
  severity: string;
  outcome: 'applied' | 'skipped';
  choiceKey: string | null;
  effects: EventEffects | null;
};

export type CityDayLog = {
  cityId: string;
  name: string;
  player: string | null;
  playerStatus: string | null;
  population: { before: number; after: number };
  happiness: { before: number; after: number };
  reputation: { before: number; after: number };
  silver: { before: number; after: number };
  grain: { before: number; after: number };
  produced: Record<string, number>;
  consumed: Record<string, number>;
  event: CityEventLog | null;
  starving: boolean;
  negative: boolean;
  bankrupt: boolean;
  bankruptReason: string | null;
};

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
  cities: CityDayLog[];
  bankrupted: string[];
  season: SeasonSummary | null;
};

export type SettleOptions = { resetWorld?: boolean };

type CityRow = {
  id: string;
  name: string;
  player_id: string | null;
  player: string | null;
  player_status: string | null;
  population: number;
  happiness: number;
  reputation: number;
  resources: Record<string, number> | null;
  buildings: { key: BuildingKey; level: number }[];
};

type EventRow = {
  id: string;
  city_id: string;
  title: string;
  severity: string;
  choice_key: string | null;
  effects: EventEffects | null;
};

type Stock = Record<string, number>;

type CityUpdate = {
  id: string;
  population: number;
  happiness: number;
  reputation: number;
  resources: Stock;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const at = (s: Stock, k: string): number => num(s[k]);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

async function lockSeason(client: Awaited<ReturnType<typeof pool.connect>>): Promise<{
  seasonId: string;
  seasonNo: number;
  day: number;
}> {
  const season = await client.query<{ id: string; season_no: number; current_day: number }>(
    `SELECT id::text AS id, season_no, current_day FROM seasons
      WHERE status = 'active' ORDER BY season_no LIMIT 1 FOR UPDATE`,
  );
  const row = season.rows[0];
  if (!row) throw new Error('settleDay: 没有 active 赛季');
  return { seasonId: row.id, seasonNo: row.season_no, day: row.current_day };
}

export async function settleDay(targetDay?: number, opts: SettleOptions = {}): Promise<SettleResult> {
  const startedAt = performance.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await lockSeason(client);
    const seasonId = locked.seasonId;
    const day = targetDay ?? locked.day;

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), $2::int)', [
      SETTLE_LOCK_KEY,
      day,
    ]);

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
        cities: [],
        bankrupted: [],
        season: null,
      };
    }

    const cities = await client.query<CityRow>(
      `SELECT c.id::text AS id, c.name,
              c.player_id::text AS player_id, p.name AS player, p.status AS player_status,
              c.population::float8 AS population, c.happiness::float8 AS happiness,
              c.reputation::float8 AS reputation, c.resources,
              COALESCE(b.buildings, '[]'::json) AS buildings
         FROM cities c
         LEFT JOIN players p ON p.id = c.player_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('key', bb.key, 'level', bb.level)) AS buildings
             FROM buildings bb WHERE bb.city_id = c.id
         ) b ON TRUE
        WHERE c.season_id = $1
        ORDER BY c.name`,
      [seasonId],
    );

    const cityIds = cities.rows.map((c) => c.id);
    const events = await client.query<EventRow>(
      `SELECT ce.id::text AS id, ce.city_id::text AS city_id, e.title, e.severity,
              ce.choice_key, ce.effects
         FROM city_events ce
         JOIN events e ON e.id = ce.event_id
        WHERE ce.day = $2 AND ce.city_id = ANY($1::uuid[])`,
      [cityIds, day],
    );
    const eventsByCity = new Map<string, EventRow[]>();
    for (const e of events.rows) {
      const list = eventsByCity.get(e.city_id) ?? [];
      list.push(e);
      eventsByCity.set(e.city_id, list);
    }

    const prevLog = await client.query<{
      summary: { cities?: { cityId: string; negative?: boolean }[] };
    }>(`SELECT summary FROM day_logs WHERE season_id = $1 AND day = $2`, [seasonId, day - 1]);
    const prevNegative = new Set(
      (prevLog.rows[0]?.summary?.cities ?? [])
        .filter((c) => c.negative === true)
        .map((c) => c.cityId),
    );

    const updates: CityUpdate[] = [];
    const cityLogs: CityDayLog[] = [];
    const ranks: SeasonRankInput[] = [];
    const eventStatuses: { id: string; status: 'resolved' | 'expired' }[] = [];
    const bankruptPlayers: string[] = [];
    const bankrupted: string[] = [];
    const produced: Record<string, number> = {};
    const consumed: Record<string, number> = {};
    let populationBefore = 0;
    let populationAfter = 0;

    for (const city of cities.rows) {
      const resources: Stock = { ...(city.resources ?? {}) };
      for (const good of GOODS) if (!(good in resources)) resources[good] = 0;
      const resourcesBefore: Stock = { ...resources };
      const pop = num(city.population);
      const happinessBefore = num(city.happiness);
      const reputationBefore = num(city.reputation);

      // 2) 产量：建筑按等级产出
      const cityProduced: Record<string, number> = {};
      for (const b of city.buildings) {
        const def = BUILDINGS[b.key];
        if (!def || def.good === null) continue;
        const amount = def.outputPerLevel * b.level;
        resources[def.good] = round2(at(resources, def.good) + amount);
        cityProduced[def.good] = round2((cityProduced[def.good] ?? 0) + amount);
        produced[def.good] = round2((produced[def.good] ?? 0) + amount);
      }

      // 3) 消耗（缺粮记负数）
      const cityConsumed: Record<string, number> = {};
      let starving = false;
      const grainBeforeConsumption = at(resources, 'grain');
      for (const good of GOODS) {
        const perCapita = CONSUMPTION_PER_CAPITA[good] ?? 0;
        if (perCapita <= 0) continue;
        const need = pop * perCapita;
        const have = at(resources, good);
        resources[good] = round2(have - need);
        cityConsumed[good] = round2(need);
        consumed[good] = round2((consumed[good] ?? 0) + need);
        if (have + 1e-9 < need) starving = true;
      }

      // 人口 / 幸福度
      let happiness = happinessBefore;
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

      let reputation = reputationBefore;
      populationBefore += pop;
      populationAfter += popNext;

      // 4) / 5) 事件
      const evs = eventsByCity.get(city.id) ?? [];
      const chosen = evs.find((e) => e.choice_key !== null) ?? null;
      let eventLog: CityEventLog | null = null;
      for (const e of evs) {
        if (chosen && e.id === chosen.id) {
          const eff = e.effects ?? {};
          for (const [good, delta] of Object.entries(eff.resources ?? {})) {
            resources[good] = round2(at(resources, good) + num(delta));
          }
          popNext = Math.max(0, Math.round(popNext + num(eff.population)));
          happiness = clamp(happiness + num(eff.happiness), 0, 100);
          reputation = Math.max(0, round2(reputation + num(eff.reputation)));
          eventLog = {
            eventId: e.id,
            title: e.title,
            severity: e.severity,
            outcome: 'applied',
            choiceKey: e.choice_key,
            effects: eff,
          };
          eventStatuses.push({ id: e.id, status: 'resolved' });
        } else {
          eventStatuses.push({ id: e.id, status: 'expired' });
        }
      }
      if (!eventLog && evs.length > 0) {
        const first = evs[0];
        if (first) {
          eventLog = {
            eventId: first.id,
            title: first.title,
            severity: first.severity,
            outcome: 'skipped',
            choiceKey: null,
            effects: null,
          };
        }
      }

      updates.push({
        id: city.id,
        population: popNext,
        happiness: round2(happiness),
        reputation: round2(reputation),
        resources,
      });

      // 6) 破产：银 < 0 且 粮 < 0，连续 GAME.bankruptDays 日
      const silver = at(resources, 'silver');
      const grain = at(resources, 'grain');
      const negativeToday = silver < 0 && grain < 0;
      let bankrupt = false;
      let bankruptReason: string | null = null;
      if (negativeToday && prevNegative.has(city.id) && city.player_status !== 'bankrupt') {
        bankrupt = true;
        bankruptReason = `银 ${silver} < 0 且 粮 ${grain} < 0 连续 ${GAME.bankruptDays} 日`;
        if (city.player_id) bankruptPlayers.push(city.player_id);
        bankrupted.push(`${city.name}(${city.player ?? '无主'})`);
      }

      const buildingValue = city.buildings.reduce((s, b) => {
        const per = GAME.buildingValue[b.key];
        return s + num(per) * b.level;
      }, 0);
      ranks.push({
        cityId: city.id,
        city: city.name,
        player: city.player,
        playerId: city.player_id,
        population: popNext,
        happiness: round2(happiness),
        silver,
        grain,
        reputation: round2(reputation),
        buildingValue,
        bankrupt,
        bankruptReason,
      });

      cityLogs.push({
        cityId: city.id,
        name: city.name,
        player: city.player,
        playerStatus: city.player_status,
        population: { before: pop, after: popNext },
        happiness: { before: happinessBefore, after: round2(happiness) },
        reputation: { before: reputationBefore, after: round2(reputation) },
        silver: { before: round2(at(resourcesBefore, 'silver')), after: round2(silver) },
        grain: { before: round2(at(resourcesBefore, 'grain')), after: round2(grain) },
        produced: cityProduced,
        consumed: cityConsumed,
        event: eventLog,
        starving,
        negative: negativeToday,
        bankrupt,
        bankruptReason,
      });
    }

    // 市场价格：全服供需定价
    const prevPrices = await client.query<{ good: Good; price: number }>(
      `SELECT DISTINCT ON (good) good, price::float8 AS price
         FROM market_prices
        WHERE season_id = $1 AND day < $2
        ORDER BY good, day DESC`,
      [seasonId, day],
    );
    const prevMap = new Map(prevPrices.rows.map((r) => [r.good, r.price]));

    const market: MarketQuote[] = GOODS.map((good) => {
      const demand = round2(populationBefore * (MARKET.demandPerCapita[good] ?? 0));
      const supply = round2(produced[good] ?? 0);
      const prevPrice = prevMap.get(good) ?? MARKET.basePrice[good];
      const pressure = (demand - supply) / Math.max(supply, 1);
      const rawPct = MARKET.elasticity * pressure * 100;
      const deltaPct = round2(clamp(rawPct, -MARKET.maxDeltaPct, MARKET.maxDeltaPct));
      const price = round2(
        clamp(prevPrice * (1 + deltaPct / 100), MARKET.minPrice, MARKET.maxPrice),
      );
      return { good, price, prevPrice: round2(prevPrice), deltaPct };
    });

    // 批量写回：城市（含声望）+ 事件状态 + 破产玩家
    await client.query(
      `UPDATE cities c
          SET population = v.population,
              happiness  = v.happiness,
              reputation = v.reputation,
              resources  = v.resources,
              version    = c.version + 1,
              updated_at = now()
         FROM jsonb_to_recordset($1::jsonb)
              AS v(id uuid, population numeric, happiness numeric, reputation numeric, resources jsonb)
        WHERE c.id = v.id`,
      [JSON.stringify(updates)],
    );

    if (eventStatuses.length > 0) {
      await client.query(
        `UPDATE city_events ce
            SET status = v.status, resolved_at = now()
           FROM jsonb_to_recordset($1::jsonb) AS v(id uuid, status text)
          WHERE ce.id = v.id`,
        [JSON.stringify(eventStatuses)],
      );
    }

    if (bankruptPlayers.length > 0) {
      await client.query(
        `UPDATE players SET status = 'bankrupt'
          WHERE id = ANY($1::uuid[]) AND status <> 'bankrupt'`,
        [bankruptPlayers],
      );
    }

    await client.query(
      `INSERT INTO market_prices (season_id, day, good, price, prev_price, delta_pct)
       SELECT $1, $2, x.good, x.price, x."prevPrice", x."deltaPct"
         FROM jsonb_to_recordset($3::jsonb)
              AS x(good text, price numeric, "prevPrice" numeric, "deltaPct" numeric)
       ON CONFLICT (season_id, day, good)
       DO UPDATE SET price = EXCLUDED.price,
                     prev_price = EXCLUDED.prev_price,
                     delta_pct = EXCLUDED.delta_pct`,
      [seasonId, day, JSON.stringify(market)],
    );

    // 8) 赛季末日：settling → 排名/三档结局 → ended → 世界重置
    let seasonSummary: SeasonSummary | null = null;
    if (day >= config.seasonDays) {
      const grainQuote = market.find((m) => m.good === 'grain');
      seasonSummary = await closeSeason(client, {
        seasonId,
        seasonNo: locked.seasonNo,
        grainPrice: grainQuote ? grainQuote.price : MARKET.basePrice.grain,
        seasonDays: config.seasonDays,
        ranks,
        resetWorld: opts.resetWorld !== false,
      });
    }

    // 7) 每城一份账（玩家看到的就是这份）
    const durationMs = Math.round(performance.now() - startedAt);
    await client.query(
      `INSERT INTO day_logs (season_id, day, duration_ms, cities_settled, summary)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        seasonId,
        day,
        durationMs,
        updates.length,
        JSON.stringify({
          produced,
          consumed,
          populationBefore,
          populationAfter,
          market,
          cities: cityLogs,
          bankrupted,
          season: seasonSummary,
        }),
      ],
    );

    if (!seasonSummary) {
      await client.query(
        `UPDATE seasons SET current_day = GREATEST(current_day, $2) WHERE id = $1`,
        [seasonId, day + 1],
      );
    }

    await client.query('COMMIT');
    // M8：提交后推 WebSocket 事件（#4 第 6 节）。CLI/bench 进程里 hub 无连接，广播是空操作。
    const seasonIdNum = Number(seasonId);
    const grainQuote = market.find((m) => m.good === 'grain');
    const grainPrice = grainQuote ? grainQuote.price : 0;
    for (const u of updates) {
      emitCityUpdated({
        season_id: seasonIdNum,
        day,
        city_id: u.id,
        population: u.population,
        happiness: u.happiness,
        resources: u.resources,
      });
    }
    emitMarketTick({
      season_id: seasonIdNum,
      day,
      grain_price: grainPrice,
      quotes: market.map((m) => ({
        good: m.good,
        price: m.price,
        prev_price: m.prevPrice,
        delta_pct: m.deltaPct,
      })),
    });
    emitDaySettled({
      season_id: seasonIdNum,
      day,
      cities_settled: updates.length,
      duration_ms: Math.round(performance.now() - startedAt),
      population_before: round2(populationBefore),
      population_after: round2(populationAfter),
      grain_price: grainPrice,
      market: market.map((m) => ({
        good: m.good,
        price: m.price,
        prev_price: m.prevPrice,
        delta_pct: m.deltaPct,
      })),
    });

    return {
      day,
      durationMs: Math.round(performance.now() - startedAt),
      citiesSettled: updates.length,
      skipped: false,
      totals: { produced, consumed, populationBefore, populationAfter },
      market,
      cities: cityLogs,
      bankrupted,
      season: seasonSummary,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
