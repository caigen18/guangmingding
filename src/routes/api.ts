import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';

/**
 * /api/state：给前端 H5 的只读状态（#11/#12 同一套前端的数据源）。
 * 返回当前 active 赛季、指定城市（?city=）的账目/资源/事件/行情/榜单/日志。
 * 结构稳定，供客户端首屏与 WebSocket 断线重连后按 season+day 重拉。
 *
 * /api/choose：提交当日事件卡选择（#11「看账→选卡→下单」的落库）。
 * 写 city_events.choice_key + 所选 choice 的 effects；status 保持 pending，
 * 由 settleDay 在结算时执行效果并推 resolved/expired。断线重连后 /api/state
 * 返回的 events[].choice_key 即当日已提交选择，不丢。
 */

const GOODS = ['grain', 'wood', 'stone', 'iron', 'cloth'] as const;

interface SeasonRow {
  id: string;
  season_no: number;
  current_day: number;
}

interface CityRow {
  id: string;
  name: string;
  player_id: string | null;
  population: number;
  happiness: number;
  reputation: number;
  resources: Record<string, number> | null;
}

const fnum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

export interface GameState {
  season: { id: string; season_no: number; day: number };
  me: {
    id: string;
    name: string;
    player: string;
    population: number;
    happiness: number;
    reputation: number;
    resources: Record<string, number>;
    inventoryValue: number;
  };
  market: Array<{ good: string; price: number; prev_price: number; delta_pct: number }>;
  events: Array<{
    id: string;
    day: number;
    status: string;
    choice_key: string | null;
    title: string;
    body: string;
    severity: string;
    template_key: string;
    choices: Array<Record<string, unknown>>;
  }>;
  leaderboard: Array<{
    rank: number;
    id: string;
    name: string;
    population: number;
    reputation: number;
    silver: number;
  }>;
  logs: Array<{ day: number; line: string }>;
  cities: Array<{ id: string; name: string }>;
  serverNow: string;
}

export async function loadState(wantCity?: string): Promise<GameState> {
  const season = await pool.query<SeasonRow>(
    `SELECT id::text AS id, season_no, current_day
       FROM seasons WHERE status = 'active' ORDER BY season_no LIMIT 1`,
  );
  if (season.rowCount === 0) throw new Error('no active season');
  const { id: seasonId, season_no, current_day } = season.rows[0]!;

  const cities = await pool.query<CityRow>(
    `SELECT id::text AS id, name, player_id::text AS player_id,
            population::float8 AS population, happiness::float8 AS happiness,
            reputation::float8 AS reputation, resources
       FROM cities WHERE season_id = $1 ORDER BY name`,
    [seasonId],
  );
  if (cities.rowCount === 0) throw new Error('no cities');

  const me =
    cities.rows.find((c) => c.id === wantCity) ??
    cities.rows.find((c) => c.name === wantCity) ??
    cities.rows[0]!;

  const playerName = me.player_id
    ? await pool
        .query<{ name: string }>(`SELECT name FROM players WHERE id = $1`, [me.player_id])
        .then((r) => r.rows[0]?.name ?? '—')
    : '—';

  let market = await pool.query<{
    day: number;
    good: string;
    price: number;
    prev_price: number;
    delta_pct: number;
  }>(
    `SELECT day, good, price::float8 AS price, prev_price::float8 AS prev_price,
            delta_pct::float8 AS delta_pct
       FROM market_prices WHERE season_id = $1 AND day = $2 ORDER BY good`,
    [seasonId, current_day],
  );
  if (market.rowCount === 0) {
    const latest = await pool.query<{ day: number }>(
      `SELECT day FROM market_prices WHERE season_id = $1 ORDER BY day DESC LIMIT 1`,
      [seasonId],
    );
    const d = latest.rows[0]?.day ?? current_day;
    market = await pool.query<{
      day: number;
      good: string;
      price: number;
      prev_price: number;
      delta_pct: number;
    }>(
      `SELECT day, good, price::float8 AS price, prev_price::float8 AS prev_price,
              delta_pct::float8 AS delta_pct
         FROM market_prices WHERE season_id = $1 AND day = $2 ORDER BY good`,
      [seasonId, d],
    );
  }

  const events = await pool.query<{
    id: string;
    day: number;
    status: string;
    choice_key: string | null;
    title: string;
    body: string;
    severity: string;
    template_key: string;
    choices: unknown;
  }>(
    `SELECT ce.id::text AS id, ce.day, ce.status, ce.choice_key,
            e.title, e.body, e.severity, e.template_key, e.choices
       FROM city_events ce JOIN events e ON e.id = ce.event_id
      WHERE ce.city_id = $1 AND ce.status = 'pending'
      ORDER BY ce.day DESC, ce.created_at DESC
      LIMIT 3`,
    [me.id],
  );

  const board = await pool.query<{
    id: string;
    name: string;
    population: number;
    reputation: number;
    silver: number;
  }>(
    `SELECT id::text AS id, name, population::float8 AS population,
            reputation::float8 AS reputation,
            (resources->>'silver')::float8 AS silver
       FROM cities WHERE season_id = $1
       ORDER BY reputation DESC, (resources->>'silver')::float8 DESC`,
    [seasonId],
  );

  const logsQ = await pool.query<{ day: number; summary: unknown }>(
    `SELECT day, summary FROM day_logs WHERE season_id = $1 ORDER BY day DESC LIMIT 7`,
    [seasonId],
  );

  const r = me.resources ?? {};
  const prices: Record<string, number> = {};
  for (const m of market.rows) prices[m.good] = m.price;
  let inventoryValue = fnum(r.silver ?? 0);
  for (const g of GOODS) inventoryValue += fnum(r[g] ?? 0) * fnum(prices[g] ?? 0);

  const logs = logsQ.rows.map((row) => {
    const s = row.summary as { cities?: Array<Record<string, unknown>> } | null | undefined;
    const mine = (s?.cities ?? []).find((c) => c.cityId === me.id);
    return { day: row.day, line: logLine(mine) };
  });

  return {
    season: { id: seasonId, season_no, day: current_day },
    me: {
      id: me.id,
      name: me.name,
      player: playerName,
      population: fnum(me.population),
      happiness: fnum(me.happiness),
      reputation: fnum(me.reputation),
      resources: {
        silver: fnum(r.silver ?? 0),
        grain: fnum(r.grain ?? 0),
        wood: fnum(r.wood ?? 0),
        stone: fnum(r.stone ?? 0),
        iron: fnum(r.iron ?? 0),
        cloth: fnum(r.cloth ?? 0),
      },
      inventoryValue: fnum(inventoryValue),
    },
    market: market.rows.map((m) => ({
      good: m.good,
      price: fnum(m.price),
      prev_price: fnum(m.prev_price),
      delta_pct: fnum(m.delta_pct),
    })),
    events: events.rows.map((e) => ({
      id: e.id,
      day: e.day,
      status: e.status,
      choice_key: e.choice_key,
      title: e.title,
      body: e.body,
      severity: e.severity,
      template_key: e.template_key,
      choices: Array.isArray(e.choices) ? e.choices : [],
    })),
    leaderboard: board.rows.map((b, i) => ({
      rank: i + 1,
      id: b.id,
      name: b.name,
      population: fnum(b.population),
      reputation: fnum(b.reputation),
      silver: fnum(b.silver),
    })),
    logs,
    cities: cities.rows.map((c) => ({ id: c.id, name: c.name })),
    serverNow: new Date().toISOString(),
  };
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/state', async (req, reply) => {
    try {
      const wantCity = (req.query as Record<string, string | undefined>).city;
      return reply.send(await loadState(wantCity));
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : 'error' });
    }
  });

  app.post('/api/choose', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { city_event_id?: string; choice_key?: string };
      const ceId = body.city_event_id;
      const key = body.choice_key;
      if (!ceId || typeof key !== 'string' || key === '') {
        return reply.code(400).send({ error: 'city_event_id and choice_key required' });
      }
      const row = await pool.query<{ choices: unknown; status: string }>(
        `SELECT e.choices, ce.status
           FROM city_events ce JOIN events e ON e.id = ce.event_id
          WHERE ce.id = $1`,
        [ceId],
      );
      if (row.rowCount === 0) return reply.code(404).send({ error: 'event not found' });
      const ce = row.rows[0]!;
      if (ce.status !== 'pending') return reply.code(409).send({ error: 'event already resolved or expired' });

      const choices = Array.isArray(ce.choices) ? (ce.choices as Array<Record<string, unknown>>) : [];
      const pick = choices.find((c) => (c.key ?? c.choice_key) === key);
      if (!pick) return reply.code(400).send({ error: 'unknown choice_key' });

      const upd = await pool.query(
        `UPDATE city_events SET choice_key = $1, effects = $2 WHERE id = $3 AND status = 'pending'`,
        [key, JSON.stringify(pick.effects ?? {}), ceId],
      );
      if (upd.rowCount === 0) return reply.code(409).send({ error: 'event already resolved or expired' });

      return reply.send({ ok: true, city_event_id: ceId, choice_key: key });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'error' });
    }
  });
}

/** 把一条结算 deltas 压成一行可读日志（供客户端“日志”折叠区）。 */
function logLine(mine: Record<string, unknown> | undefined): string {
  if (!mine) return '结算完成';
  const n = (k: string): string => {
    const v = (mine as Record<string, unknown>)[k] as
      | { before?: number; after?: number }
      | undefined;
    if (!v || v.before === undefined) return '';
    return `${v.before}→${v.after}`;
  };
  const ev = (mine as { event?: { title?: string } | null }).event;
  const parts = [
    `银 ${n('silver')}`,
    `粮 ${n('grain')}`,
    `人 ${n('population')}`,
    `望 ${n('reputation')}`,
  ].filter((x) => !x.endsWith(' '));
  const evLine = ev?.title ? `【${ev.title}】` : '';
  return `${evLine}${parts.join(' · ')}`.replace(/\s+/g, ' ');
}
