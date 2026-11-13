/**
 * /admin/* —— M8 联调触发入口（Basic Auth，账号来自 ADMIN_USER / ADMIN_PASS）。
 *   POST /admin/settle  真结算一天（触发 day.settled / market.tick / city.updated）
 *   POST /admin/emit    联调用：发一条 events.arrived / trade.incoming / trade.resolved
 *                       （后三者在 M9 / 交易流程落地前，用样例数据验证六个事件与按城路由）
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config/game.js';
import { pool } from '../db/pool.js';
import { settleDay } from '../game/settle.js';
import {
  emitEventsArrived,
  emitTradeIncoming,
  emitTradeResolved,
  type EventCard,
  type EventsArrivedData,
  type TradeIncomingData,
  type TradeResolvedData,
} from '../ws/events.js';

function authorized(req: FastifyRequest): boolean {
  if (!config.admin.pass) return false;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const [u, p] = decoded.split(':');
  return u === config.admin.user && p === config.admin.pass;
}

async function ctx() {
  const season = await pool.query<{ season_no: number; current_day: number }>(
    `SELECT season_no, current_day FROM seasons WHERE status = 'active' ORDER BY season_no LIMIT 1`,
  );
  const cities = await pool.query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM cities ORDER BY name LIMIT 3`,
  );
  const rows = cities.rows;
  const seasonNo = season.rows[0]?.season_no ?? 1;
  const day = season.rows[0]?.current_day ?? 1;
  return {
    seasonNo,
    day,
    city: rows[0] ?? { id: '00000000-0000-0000-0000-000000000000', name: '甲城' },
    other: rows[1] ?? rows[0] ?? { id: '00000000-0000-0000-0000-000000000000', name: '乙城' },
  };
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post('/admin/settle', async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const result = await settleDay();
    return reply.code(200).send({ ok: true, result });
  });

  app.post<{ Body: Record<string, unknown> }>('/admin/emit', async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { seasonNo, day, city, other } = await ctx();
    const type = req.body?.type as string;

    if (type === 'events.arrived') {
      const cards: EventCard[] = [
        {
          event_id: randomUUID(),
          title: '丰收',
          body: '今年收成比往年都好。',
          severity: 'normal',
          choices: [
            { choice_key: 'a', label: '加征粮食', effects: { resources: { grain: 10 } } },
            { choice_key: 'b', label: '免税一年', effects: { happiness: 2 } },
          ],
          generated_by: 'template',
          created_day: day,
          expires_day: day + 2,
          status: 'pending',
        },
      ];
      const data: EventsArrivedData = { season_id: seasonNo, day, cards };
      emitEventsArrived(new Map([[city.id, data]]));
      return reply.code(200).send({ ok: true, emitted: 'events.arrived', to: city.name });
    }

    if (type === 'trade.incoming') {
      const data: TradeIncomingData = {
        season_id: seasonNo,
        day,
        trade_id: randomUUID(),
        from_city: { city_id: other.id, name: other.name },
        give: [{ good: 'grain', amount: 100 }],
        take: [{ good: 'wood', amount: 50 }],
        created_day: day,
        expires_day: day + 3,
      };
      emitTradeIncoming(new Map([[city.id, data]]));
      return reply.code(200).send({ ok: true, emitted: 'trade.incoming', to: city.name });
    }

    if (type === 'trade.resolved') {
      const data: TradeResolvedData = {
        season_id: seasonNo,
        day,
        trade_id: randomUUID(),
        status: 'accepted',
        with_city: { city_id: other.id, name: other.name },
        give: [{ good: 'grain', amount: 100 }],
        take: [{ good: 'wood', amount: 50 }],
        resolved_at: new Date().toISOString(),
      };
      emitTradeResolved(data);
      return reply.code(200).send({ ok: true, emitted: 'trade.resolved' });
    }

    return reply.code(400).send({ ok: false, error: 'type must be events.arrived | trade.incoming | trade.resolved' });
  });
}
