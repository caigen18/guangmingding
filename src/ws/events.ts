/**
 * M8 六个 WebSocket 事件，字段按《游戏 v1 前后端事件契约 v1.1》。
 *
 * 命名口径：信封顶层与事件字段一律 snake_case（season_id/day/duration_ms/trade_id/from_city/
 * with_city/created_day/expires_day/resolved_at/city_id/event_id/generated_by/choice_key/prev_price/
 * delta_pct）；只有嵌套的 CityDayLog 透传 settle.ts 的 camelCase（cityId/playerStatus/eventId/
 * choiceKey/bankruptReason）。market.tick 的 quote 用 prevPrice/deltaPct（契约原文如此）。
 *
 * 路由：day.settled / events.arrived / trade.* 只发本城；market.tick / city.updated 全服广播。
 * 调用时机：业务事务 COMMIT 之后（保证客户端看到的是已落库状态）。
 */
import type { CityDayLog } from '../game/settle.js';
import type { SeasonSummary } from '../game/season.js';
import { hub } from './hub.js';

export interface CityRef {
  city_id: string;
  name: string;
}

export interface TradeItem {
  good: string;
  amount: number;
}

export interface Quote {
  good: string;
  price: number;
  prevPrice: number;
  deltaPct: number;
}

export interface EventChoice {
  choice_key: string;
  label: string;
  effects: Record<string, number> | null;
}

export interface EventCard {
  event_id: string;
  title: string;
  body: string;
  severity: 'low' | 'normal' | 'high';
  choices: EventChoice[];
  generated_by: 'ai' | 'template';
  created_day: number;
  expires_day: number;
  status: 'pending';
}

export interface DaySettledData {
  season_id: number;
  day: number;
  duration_ms: number;
  city: CityDayLog;
  market: Quote[];
  bankrupted: string[];
  season: SeasonSummary | null;
}

export interface EventsArrivedData {
  season_id: number;
  day: number;
  city_id: string;
  cards: EventCard[];
}

export interface MarketTickData {
  season_id: number;
  day: number;
  quotes: Quote[];
}

export interface TradeIncomingData {
  season_id: number;
  day: number;
  trade_id: string;
  from_city: CityRef;
  give: TradeItem[];
  take: TradeItem[];
  created_day: number;
  expires_day: number;
}

export type TradeStatus = 'accepted' | 'declined' | 'expired' | 'cancelled';

export interface TradeResolvedData {
  season_id: number;
  day: number;
  trade_id: string;
  status: TradeStatus;
  with_city: CityRef;
  give: TradeItem[];
  take: TradeItem[];
  resolved_at: string;
}

export interface CityUpdatedData {
  season_id: number;
  day: number;
  city_id: string;
  name: string;
  population: number;
  happiness: number;
  reputation: number;
  resources: Record<string, number>;
  version: number;
}

/** 日结：每城一条，cities 数组不出网，每连接只拿自己那城的 city。 */
export function emitDaySettled(input: {
  seasonId: number;
  day: number;
  durationMs: number;
  cities: CityDayLog[];
  market: Quote[];
  bankrupted: string[];
  season: SeasonSummary | null;
}): void {
  if (hub.size === 0) return;
  for (const city of input.cities) {
    const data: DaySettledData = {
      season_id: input.seasonId,
      day: input.day,
      duration_ms: input.durationMs,
      city,
      market: input.market,
      bankrupted: input.bankrupted,
      season: input.season,
    };
    hub.sendToCity(city.cityId, 'day.settled', data);
  }
}

/** 事件卡：无事件日也发 cards: []。 */
export function emitEventsArrived(data: EventsArrivedData): void {
  if (hub.size === 0) return;
  hub.sendToCity(data.city_id, 'events.arrived', data);
}

export function emitMarketTick(data: MarketTickData): void {
  if (hub.size === 0) return;
  hub.broadcast('market.tick', data);
}

export function emitTradeIncoming(toCityId: string, data: TradeIncomingData): void {
  if (hub.size === 0) return;
  hub.sendToCity(toCityId, 'trade.incoming', data);
}

/** 双方各收一份，with_city 指向对方。 */
export function emitTradeResolved(
  fromCity: CityRef,
  toCity: CityRef,
  payload: { seasonId: number; day: number; tradeId: string; status: TradeStatus; give: TradeItem[]; take: TradeItem[]; resolvedAt: string },
): void {
  if (hub.size === 0) return;
  hub.sendToCities([fromCity.city_id, toCity.city_id], 'trade.resolved', (cityId) => {
    const data: TradeResolvedData = {
      season_id: payload.seasonId,
      day: payload.day,
      trade_id: payload.tradeId,
      status: payload.status,
      with_city: cityId === fromCity.city_id ? toCity : fromCity,
      give: payload.give,
      take: payload.take,
      resolved_at: payload.resolvedAt,
    };
    return data;
  });
}

export function emitCityUpdated(data: CityUpdatedData): void {
  if (hub.size === 0) return;
  hub.broadcast('city.updated', data);
}
