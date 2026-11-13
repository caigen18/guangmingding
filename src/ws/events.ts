/**
 * M8 事件契约（v1.1，对齐 #4 第 6 节 + M6 落地实现，v1.0 作废）。
 * 六个事件：day.settled / events.arrived / market.tick / trade.incoming / trade.resolved / city.updated。
 * 通用：所有事件带 season_id(number) 与 day(number)；所有 id 是 uuid 字符串；
 *       货物 key 固定 grain/wood/stone/iron/cloth（中文名前端映射）。
 * 事件只负责推到 hub；业务层在事务提交后调用（settle / trade / ai）。
 */
import type { Good } from '../config/game.js';
import type { SeasonSummary } from '../game/season.js';
import { hub } from './hub.js';

export type Severity = 'low' | 'normal' | 'high';

export interface MarketQuote {
  good: Good;
  price: number;
  prevPrice: number;
  deltaPct: number;
}

export type EventEffects = {
  resources?: Record<string, number>;
  population?: number;
  happiness?: number;
  reputation?: number;
};

export type CityEventLog = {
  eventId: string;
  title: string;
  severity: Severity;
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

export interface EventChoice {
  choice_key: string;
  label: string;
  effects: EventEffects;
}

export interface EventCard {
  event_id: string;
  title: string;
  body: string;
  severity: Severity;
  choices: EventChoice[];
  generated_by: 'ai' | 'template';
  created_day: number;
  expires_day: number;
  status: 'pending';
}

export interface TradeItem {
  good: Good;
  amount: number;
}

// ---- 六个事件 data ----

export interface DaySettledData {
  season_id: number;
  day: number;
  duration_ms: number;
  city: CityDayLog;
  market: MarketQuote[];
  bankrupted: string[];
  season: SeasonSummary | null;
}

export interface EventsArrivedData {
  season_id: number;
  day: number;
  cards: EventCard[];
}

export interface MarketTickData {
  season_id: number;
  day: number;
  quotes: MarketQuote[];
}

export interface TradeIncomingData {
  season_id: number;
  day: number;
  trade_id: string;
  from_city: { city_id: string; name: string };
  give: TradeItem[];
  take: TradeItem[];
  created_day: number;
  expires_day: number;
}

export interface TradeResolvedData {
  season_id: number;
  day: number;
  trade_id: string;
  status: 'accepted' | 'declined' | 'expired' | 'cancelled';
  with_city: { city_id: string; name: string };
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

// ---- emit helpers ----

export function emitMarketTick(data: MarketTickData): void {
  hub.broadcast('market.tick', data);
}

export function emitCityUpdated(data: CityUpdatedData): void {
  hub.broadcast('city.updated', data);
}

export function emitDaySettled(perCity: Map<string, DaySettledData>): void {
  hub.broadcastPerCity('day.settled', perCity);
}

export function emitEventsArrived(perCity: Map<string, EventsArrivedData>): void {
  hub.broadcastPerCity('events.arrived', perCity);
}

export function emitTradeIncoming(perCity: Map<string, TradeIncomingData>): void {
  hub.broadcastPerCity('trade.incoming', perCity);
}

export function emitTradeResolved(data: TradeResolvedData): void {
  hub.broadcast('trade.resolved', data);
}
