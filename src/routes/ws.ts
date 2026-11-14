/**
 * /ws —— 原生 ws 挂在 Fastify 同一个 HTTP server 上（不额外开端口）。
 * 客户端用 /ws?city=<uuid>&season=<number> 声明订阅上下文；连上后先收一帧 connected，
 * 再收一遍全服城市快照（city.updated，逐城一帧，只发给当前 socket，不广播给其他连接），
 * 之后只收增量。
 */
import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import { hub } from '../ws/hub.js';
import { activeSeason, listCitySnapshots } from '../game/city-snapshot.js';

export async function wsRoutes(app: FastifyInstance): Promise<void> {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cityId = url.searchParams.get('city') ?? undefined;
    const rawSeason = Number(url.searchParams.get('season'));
    const seasonId = Number.isFinite(rawSeason) && rawSeason > 0 ? rawSeason : undefined;
    hub.add(ws, { cityId, seasonId });
    hub.send(ws, 'connected', { clients: hub.size, city_id: cityId ?? null });

    // 连接时推全服快照（v1.1 字段），只发给当前 socket，不广播给其他连接。
    try {
      const season = await activeSeason();
      if (season) {
        const snaps = await listCitySnapshots(season.id, season.currentDay);
        for (const snap of snaps) hub.send(ws, 'city.updated', snap);
      }
    } catch (err) {
      app.log.warn({ err }, 'ws snapshot failed');
    }
  });

  app.addHook('onClose', async () => {
    for (const ws of wss.clients) ws.close(1001, 'server shutdown');
    wss.close();
  });
}
