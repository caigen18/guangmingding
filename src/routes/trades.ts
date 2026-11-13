/**
 * /api/trades —— 城市间交易（M8 的 trade.incoming / trade.resolved 两个事件的真实触发点）。
 *
 * v1 还没有登录态，接口用 body 里的城市 id 认身份（前端 SSR 页面从 cookie 里带同一份 id）。
 * 生命周期：pending → accepted | declined | cancelled；到期由 expires_day 判定（惰性，不发事件）。
 * 接受时在一个事务里换货，资源不足则 409，不会出现半笔交易。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db/pool.js';
import { activeSeason, cityUpdatedFromRow } from '../game/city-snapshot.js';
import {
  emitCityUpdated,
  emitTradeIncoming,
  emitTradeResolved,
  type CityRef,
  type TradeItem,
  type TradeStatus,
} from '../ws/events.js';

interface TradeBody {
  from_city_id?: string;
  to_city_id?: string;
  give?: TradeItem[];
  take?: TradeItem[];
  expires_day?: number;
}

function cleanItems(items: TradeItem[] | undefined): TradeItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i) => i && typeof i.good === 'string' && Number.isFinite(Number(i.qty)))
    .map((i) => ({ good: String(i.good), qty: Number(i.qty) }))
    .filter((i) => i.qty > 0);
}

async function cityRef(cityId: string): Promise<CityRef | null> {
  const { rows } = await pool.query(`SELECT id, name FROM cities WHERE id = $1`, [cityId]);
  const row = (rows as Array<{ id: string; name: string }>)[0];
  return row ? { city_id: String(row.id), name: row.name } : null;
}

type TradeRow = {
  id: string;
  status: string;
  from_city_id: string;
  to_city_id: string;
  from_name: string;
  to_name: string;
  give: TradeItem[];
  take: TradeItem[];
  created_day: number;
  expires_day: number;
};

type CityRow = {
  id: string;
  name: string;
  population: number;
  happiness: number;
  reputation: number;
  resources: Record<string, number>;
  version: number;
};

export async function tradeRoutes(app: FastifyInstance): Promise<void> {
  /** 发起要约：给 to_city 推 trade.incoming。 */
  app.post('/api/trades', async (req, reply) => {
    const body = (req.body ?? {}) as TradeBody;
    const give = cleanItems(body.give);
    const take = cleanItems(body.take);
    if (!body.from_city_id || !body.to_city_id) {
      return reply.code(400).send({ error: 'from_city_id and to_city_id are required' });
    }
    if (body.from_city_id === body.to_city_id) {
      return reply.code(400).send({ error: 'cannot trade with yourself' });
    }
    if (give.length === 0 && take.length === 0) {
      return reply.code(400).send({ error: 'give and take are both empty' });
    }
    const season = await activeSeason();
    if (!season) return reply.code(409).send({ error: 'no active season' });

    const fromCity = await cityRef(body.from_city_id);
    const toCity = await cityRef(body.to_city_id);
    if (!fromCity || !toCity) return reply.code(404).send({ error: 'city not found' });

    const createdDay = season.currentDay;
    const expiresDay = Number(body.expires_day) > 0 ? Number(body.expires_day) : createdDay + 3;
    const { rows } = await pool.query(
      `INSERT INTO trades (season_id, from_city_id, to_city_id, give, take, created_day, expires_day)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING id, status`,
      [season.id, fromCity.city_id, toCity.city_id, JSON.stringify(give), JSON.stringify(take), createdDay, expiresDay],
    );
    const trade = (rows as Array<{ id: string; status: string }>)[0] as { id: string; status: string };

    emitTradeIncoming(toCity.city_id, {
      season_id: season.id,
      day: createdDay,
      trade_id: String(trade.id),
      from_city: fromCity,
      give,
      take,
      created_day: createdDay,
      expires_day: expiresDay,
    });
    return reply.code(201).send({ trade_id: String(trade.id), status: trade.status });
  });

  /** 接受/拒绝/撤回：给双方推 trade.resolved（accepted 时同时换货并推 city.updated）。 */
  const resolve = (action: 'accept' | 'decline' | 'cancel') => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { city_id?: string };
      const actorCityId = body.city_id;
      if (!actorCityId) return reply.code(400).send({ error: 'city_id is required' });

      const season = await activeSeason();
      if (!season) return reply.code(409).send({ error: 'no active season' });

      const client = await pool.connect();
      let status: TradeStatus | null = null;
      let fromCity: CityRef | null = null;
      let toCity: CityRef | null = null;
      let give: TradeItem[] = [];
      let take: TradeItem[] = [];
      const touched: CityRow[] = [];
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `SELECT t.*, f.name AS from_name, c.name AS to_name
             FROM trades t
             JOIN cities f ON f.id = t.from_city_id
             JOIN cities c ON c.id = t.to_city_id
            WHERE t.id = $1 FOR UPDATE OF t`,
          [id],
        );
        const trade = (rows as TradeRow[])[0];
        if (!trade) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'trade not found' });
        }
        if (trade.status !== 'pending') {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: `trade already ${trade.status}` });
        }
        fromCity = { city_id: String(trade.from_city_id), name: String(trade.from_name) };
        toCity = { city_id: String(trade.to_city_id), name: String(trade.to_name) };
        give = (trade.give ?? []) as TradeItem[];
        take = (trade.take ?? []) as TradeItem[];

        const isFrom = actorCityId === fromCity.city_id;
        const isTo = actorCityId === toCity.city_id;
        if (!isFrom && !isTo) {
          await client.query('ROLLBACK');
          return reply.code(403).send({ error: 'not your trade' });
        }
        if (action === 'accept' && !isTo) {
          await client.query('ROLLBACK');
          return reply.code(403).send({ error: 'only the receiving city can accept' });
        }
        if (action === 'cancel' && !isFrom) {
          await client.query('ROLLBACK');
          return reply.code(403).send({ error: 'only the sending city can cancel' });
        }

        if (action === 'accept') {
          // 换货：from 给 give 拿 take，to 给 take 拿 give；任一城不够就整笔回滚。
          const moved = await client.query(
            `SELECT id, name, population::float8 AS population, happiness::float8 AS happiness,
                    reputation::float8 AS reputation, resources, version
               FROM cities WHERE id = ANY($1::uuid[])`,
            [[fromCity.city_id, toCity.city_id]],
          );
          const byId = new Map<string, CityRow>();
          for (const row of moved.rows as CityRow[]) byId.set(String(row.id), row);
          const apply = (cityId: string, add: TradeItem[], sub: TradeItem[]) => {
            const row = byId.get(cityId)!;
            const res = { ...((row.resources ?? {}) as Record<string, number>) };
            for (const i of sub) {
              if ((res[i.good] ?? 0) < i.qty) return `${cityId} 缺少 ${i.good}`;
              res[i.good] = Number(((res[i.good] ?? 0) - i.qty).toFixed(2));
            }
            for (const i of add) res[i.good] = Number(((res[i.good] ?? 0) + i.qty).toFixed(2));
            row.resources = res;
            row.version = Number(row.version) + 1;
            return null;
          };
          const shortage = apply(fromCity.city_id, take, give) ?? apply(toCity.city_id, give, take);
          if (shortage) {
            await client.query('ROLLBACK');
            return reply.code(409).send({ error: shortage });
          }
          for (const row of byId.values()) {
            const { rows: updated } = await client.query(
              `UPDATE cities SET resources = $2::jsonb, version = version + 1, updated_at = now()
                WHERE id = $1
                RETURNING id, name, population::float8 AS population, happiness::float8 AS happiness,
                          reputation::float8 AS reputation, resources, version`,
              [row.id, JSON.stringify(row.resources)],
            );
            touched.push((updated as CityRow[])[0] as CityRow);
          }
        }

        const next: TradeStatus =
          action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled';
        await client.query(
          `UPDATE trades SET status = $2, resolved_at = now() WHERE id = $1`,
          [id, next],
        );
        await client.query('COMMIT');
        status = next;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }

      if (fromCity && toCity && status) {
        emitTradeResolved(fromCity, toCity, {
          seasonId: season.id,
          day: season.currentDay,
          tradeId: id,
          status,
          give,
          take,
          resolvedAt: new Date().toISOString(),
        });
        for (const row of touched) emitCityUpdated(cityUpdatedFromRow(row, season.id, season.currentDay));
      }
      return reply.send({ trade_id: id, status });
    };
  };

  app.post('/api/trades/:id/accept', resolve('accept'));
  app.post('/api/trades/:id/decline', resolve('decline'));
  app.post('/api/trades/:id/cancel', resolve('cancel'));
}
