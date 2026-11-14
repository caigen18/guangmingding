import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async (_req, reply) => {
    const body = {
      ok: true,
      uptimeMs: Date.now() - startedAt,
      db: 'up' as 'up' | 'down',
      sha: process.env.GIT_SHA ?? 'unknown',
    };
    try {
      await pool.query('SELECT 1');
    } catch {
      body.db = 'down';
      return reply.code(503).send({ ...body, ok: false });
    }
    return reply.code(200).send(body);
  });
}
