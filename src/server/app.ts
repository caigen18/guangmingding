import Fastify, { type FastifyInstance } from 'fastify';
import { healthRoutes } from '../routes/health.js';
import { pool } from '../db/pool.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(healthRoutes);
  app.addHook('onClose', async () => {
    await pool.end();
  });
  return app;
}
