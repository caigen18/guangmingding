/**
 * 进程内广播中心（M8 的底座）：单进程、无 Redis，符合 v1 不引入任务队列/分布式的约定。
 * M8 在此挂 Fastify 同端口的 /ws，并把六个事件推给连接的客户端。
 */
import type { WebSocket } from 'ws';

let seq = 0;

/** 统一信封：{ type, at, seq, data } */
export interface Envelope<T = unknown> {
  type: string;
  at: string;
  seq: number;
  data: T;
}

/** 连接订阅上下文：客户端可带 ?season=&city= 声明关注范围（v1 广播仍全局，前端按 data 过滤）。 */
export interface ClientContext {
  seasonId?: string;
  cityId?: string;
}

export class Hub {
  private readonly clients = new Map<WebSocket, ClientContext>();

  add(ws: WebSocket, ctx: ClientContext = {}): void {
    this.clients.set(ws, ctx);
    ws.on('close', () => this.clients.delete(ws));
  }

  get size(): number {
    return this.clients.size;
  }

  broadcast<T>(type: string, data: T): void {
    const msg = JSON.stringify({ type, at: new Date().toISOString(), seq: ++seq, data });
    for (const ws of this.clients.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  send<T>(ws: WebSocket, type: string, data: T): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type, at: new Date().toISOString(), seq: ++seq, data }));
  }
}

export const hub = new Hub();
