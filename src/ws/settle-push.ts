/**
 * 日结后的推送（M8）：city.updated（逐城广播）→ market.tick → day.settled（逐城单播）→
 * events.arrived（逐城单播，空日也发 cards: []）。在 settleDay 的事务 COMMIT 之后调用。
 */
import { pool } from '../db/pool.js';
import type { CityDayLog, MarketQuote } from '../game/settle.js';
import type { SeasonSummary } from '../game/season.js';
import { pendingCards, cityUpdatedFromRow } from '../game/city-snapshot.js';
import { emitCityUpdated, emitDaySettled, emitEventsArrived, emitMarketTick } from './events.js';
import { hub } from './hub.js';

export interface SettlePushInput {
  seasonId: number;
  day: number;
  durationMs: number;
  cities: CityDayLog[];
  market: MarketQuote[];
  bankrupted: string[];
  season: SeasonSummary | null;
}

export async function pushSettleEvents(input: SettlePushInput): Promise<void> {
  if (hub.size === 0) return; // CLI / bench / 无人在线：不发，也不查库
  const ids = input.cities.map((c) => c.cityId);
  const { rows } = await pool.query(
    `SELECT id, name, population::float8 AS population, happiness::float8 AS happiness,
            reputation::float8 AS reputation, resources, version
       FROM cities WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  for (const r of rows as Array<Record<string, unknown>>) {
    emitCityUpdated(cityUpdatedFromRow(r, input.seasonId, input.day));
  }

  const quotes = input.market.map((m) => ({
    good: m.good,
    price: m.price,
    prevPrice: m.prevPrice,
    deltaPct: m.deltaPct,
  }));
  emitMarketTick({ season_id: input.seasonId, day: input.day, quotes });

  emitDaySettled({
    seasonId: input.seasonId,
    day: input.day,
    durationMs: input.durationMs,
    cities: input.cities,
    market: quotes,
    bankrupted: input.bankrupted,
    season: input.season,
  });

  for (const city of input.cities) {
    const cards = await pendingCards(input.seasonId, input.day, city.cityId);
    emitEventsArrived({
      season_id: input.seasonId,
      day: input.day,
      city_id: city.cityId,
      cards,
    });
  }
}
