import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { healthRoutes } from '../routes/health.js';
import { ssrRoutes } from '../routes/ssr.js';
import { apiRoutes } from '../routes/api.js';
import { adminRoutes } from '../routes/admin.js';
import { wsRoutes } from '../routes/ws.js';
import { tradeRoutes } from '../routes/trades.js';
import { cityRoutes } from '../routes/cities.js';
import { pool } from '../db/pool.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(healthRoutes);
  await app.register(apiRoutes);
  await app.register(ssrRoutes);
  await app.register(adminRoutes);
  await app.register(tradeRoutes);
  await app.register(cityRoutes);
  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/',
    maxAge: '1h',
    decorateReply: false,
  });
  await wsRoutes(app);
  app.addHook('onClose', async () => {
    await pool.end();
  });
  return app;
}
