import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import { hub } from '../ws/hub.js';

/** 把 /ws 挂到 Fastify 同一个 HTTP server（原生 ws，无额外路由依赖）。 */
export async function wsRoutes(app: FastifyInstance): Promise<void> {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'ws://localhost');
    hub.add(ws, {
      seasonId: url.searchParams.get('season') ?? undefined,
      cityId: url.searchParams.get('city') ?? undefined,
    });
    hub.send(ws, 'connected', {
      clients: hub.size,
      season: url.searchParams.get('season'),
      city: url.searchParams.get('city'),
    });

    ws.on('message', (raw) => {
      // v1：客户端上行只做 ping/pong 心跳；权威状态走 REST，不做写操作。
      try {
        const msg = JSON.parse(String(raw)) as { type?: string };
        if (msg.type === 'ping') hub.send(ws, 'pong', { t: Date.now() });
      } catch {
        /* 忽略非法消息 */
      }
    });
  });

  // Fastify 在构造时即创建底层 http.Server（app.server），直接挂 upgrade 即可。
  app.server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'ws://localhost');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  app.addHook('onClose', async () => {
    for (const ws of wss.clients) ws.close(1001, 'server shutdown');
    wss.close();
  });
}
