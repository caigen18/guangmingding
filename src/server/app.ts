import Fastify, { type FastifyInstance } from 'fastify';
import { healthRoutes } from '../routes/health.js';
import { adminRoutes } from '../routes/admin.js';
import { wsRoutes } from '../routes/ws.js';
import { pool } from '../db/pool.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(healthRoutes);
  await app.register(adminRoutes);
  await wsRoutes(app);
  app.addHook('onClose', async () => {
    await pool.end();
  });
  return app;
}
