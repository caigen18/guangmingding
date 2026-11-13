import type { FastifyInstance } from 'fastify';
import { config } from '../config/game.js';
import { settleDay } from '../game/settle.js';

function authorized(header: string | undefined): boolean {
  const expected = `Basic ${Buffer.from(`${config.admin.user}:${config.admin.pass}`).toString('base64')}`;
  return header === expected;
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
}
