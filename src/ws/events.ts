/**
 * M8 事件契约（对 #4 第 6 节）：六个 WebSocket 事件。
 * 约定：所有事件 data 都带 season_id(number) 和 day(number)；城市级事件再带 city_id(uuid 字符串)。
 * 事件只负责推到 hub；业务层在事务提交后调用（settle / trade / ai）。
 */
import { hub } from './hub.js';

export interface MarketQuoteData {
  good: string;
  price: number;
  prev_price: number;
  delta_pct: number;
}

export interface DaySettledData {
  season_id: number;
  day: number;
  cities_settled: number;
  duration_ms: number;
  population_before: number;
  population_after: number;
  grain_price: number;
  market: MarketQuoteData[];
}

export interface MarketTickData {
  season_id: number;
  day: number;
  grain_price: number;
  quotes: MarketQuoteData[];
}

export interface CityUpdatedData {
  season_id: number;
  day: number;
  city_id: string;
  population: number;
  happiness: number;
  resources: Record<string, number>;
}

export interface EventsArrivedData {
  season_id: number;
  day: number;
  city_id: string;
  cards: Array<{ event_id: string; kind: string; strength: string; title: string; body: string }>;
}

export interface TradeIncomingData {
  season_id: number;
  day: number;
  trade_id: string;
  from_city: string;
  to_city: string;
  grain: number;
  silver: number;
}

export interface TradeResolvedData {
  season_id: number;
  day: number;
  trade_id: string;
  from_city: string;
  to_city: string;
  status: 'accepted' | 'declined';
}

export function emitDaySettled(data: DaySettledData): void {
  hub.broadcast('day.settled', data);
}
export function emitMarketTick(data: MarketTickData): void {
  hub.broadcast('market.tick', data);
}
export function emitCityUpdated(data: CityUpdatedData): void {
  hub.broadcast('city.updated', data);
}
export function emitEventsArrived(data: EventsArrivedData): void {
  hub.broadcast('events.arrived', data);
}
export function emitTradeIncoming(data: TradeIncomingData): void {
  hub.broadcast('trade.incoming', data);
}
export function emitTradeResolved(data: TradeResolvedData): void {
  hub.broadcast('trade.resolved', data);
}
