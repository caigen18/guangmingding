import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config/game.js';
import { pool } from '../db/pool.js';
import { activeSeason } from '../game/city-snapshot.js';
import { settleDay } from '../game/settle.js';
import {
  emitEventsArrived,
  emitTradeIncoming,
  emitTradeResolved,
  type EventCard,
  type TradeIncomingData,
} from '../ws/events.js';

function authorized(header: string | undefined): boolean {
  const expected = `Basic ${Buffer.from(`${config.admin.user}:${config.admin.pass}`).toString('base64')}`;
  return header === expected;
}

/** 联调用：取两座城当样例（events.arrived 发第一城，trade.* 在第一城与第二城之间）。 */
async function sampleCities() {
  const { rows } = await pool.query(`SELECT id::text AS id, name FROM cities ORDER BY name LIMIT 2`);
  const a = (rows as Array<{ id: string; name: string }>)[0] ?? { id: '00000000-0000-0000-0000-000000000000', name: '甲城' };
  const b = (rows as Array<{ id: string; name: string }>)[1] ?? a;
  return {
    city: { city_id: a.id, name: a.name },
    other: { city_id: b.id, name: b.name },
  };
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post('/admin/settle', async (req, reply) => {
    if (!authorized(req.headers.authorization)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Basic realm="gmd-admin"')
        .send({ error: 'unauthorized' });
    }
    const result = await settleDay();
    return reply.send(result);
  });

  // 联调口：M9 事件生成与交易流程落地前，用样例数据验证 events.arrived / trade.incoming / trade.resolved 的按城路由。
  app.post('/admin/emit', async (req, reply) => {
    if (!authorized(req.headers.authorization)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Basic realm="gmd-admin"')
        .send({ error: 'unauthorized' });
    }
    const season = await activeSeason();
    if (!season) return reply.code(409).send({ error: 'no active season' });
    const { city, other } = await sampleCities();
    const type = ((req.body ?? {}) as { type?: string }).type;

    if (type === 'events.arrived') {
      const cards: EventCard[] = [
        {
          event_id: randomUUID(),
          title: '丰收',
          body: '今年收成比往年都好。',
          severity: 'normal',
          choices: [
            { choice_key: 'a', label: '加征粮食', effects: { grain: 10 } },
            { choice_key: 'b', label: '免税一年', effects: { happiness: 2 } },
          ],
          generated_by: 'template',
          created_day: season.currentDay,
          expires_day: season.currentDay + 2,
          status: 'pending',
        },
      ];
      emitEventsArrived({ season_id: season.id, day: season.currentDay, city_id: city.city_id, cards });
      return reply.send({ ok: true, emitted: 'events.arrived', to: city.name });
    }

    if (type === 'trade.incoming') {
      const data: TradeIncomingData = {
        season_id: season.id,
        day: season.currentDay,
        trade_id: randomUUID(),
        from_city: other,
        give: [{ good: 'grain', amount: 100 }],
        take: [{ good: 'wood', amount: 50 }],
        created_day: season.currentDay,
        expires_day: season.currentDay + 3,
      };
      emitTradeIncoming(city.city_id, data);
      return reply.send({ ok: true, emitted: 'trade.incoming', to: city.name });
    }

    if (type === 'trade.resolved') {
      emitTradeResolved(other, city, {
        seasonId: season.id,
        day: season.currentDay,
        tradeId: randomUUID(),
        status: 'accepted',
        give: [{ good: 'grain', amount: 100 }],
        take: [{ good: 'wood', amount: 50 }],
        resolvedAt: new Date().toISOString(),
      });
      return reply.send({ ok: true, emitted: 'trade.resolved' });
    }

    return reply.code(400).send({ error: 'type must be events.arrived | trade.incoming | trade.resolved' });
  });
}
