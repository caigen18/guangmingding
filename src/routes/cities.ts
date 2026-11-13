/**
 * GET /api/cities/:id —— 单城权威状态。
 * 对齐契约 §6：前端收到 city.updated 后按 version 判断，用本接口重拉全量
 * （断线重连 / 账目对账的权威来源）。返回与 city.updated 相同的 CityUpdatedData 形状。
 */
import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { activeSeason, cityUpdatedFromRow } from '../game/city-snapshot.js';

export async function cityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/cities/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const season = await activeSeason();
    if (!season) return reply.code(409).send({ error: 'no active season' });

    const { rows } = await pool.query(
      `SELECT id, name, population::float8 AS population, happiness::float8 AS happiness,
              reputation::float8 AS reputation, resources, version
         FROM cities WHERE id = $1`,
      [id],
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (!row) return reply.code(404).send({ error: 'city not found' });

    return reply.send(cityUpdatedFromRow(row, season.id, season.currentDay));
  });
}
