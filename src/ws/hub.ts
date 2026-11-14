/**
 * 进程内广播中心（M8 底座）：单进程、无 Redis，符合 v1 不引入队列/分布式的约定。
 * 连接带订阅上下文（cityId / seasonId），六个事件据此路由：
 *   - 全服广播：market.tick / city.updated
 *   - 只发本城：day.settled / events.arrived / trade.incoming / trade.resolved
 * 客户端上行不走 ws（v1 是服务端渲染 + 表单 POST），这里只负责 push。
 */
import type { WebSocket } from 'ws';

let seq = 0;

/** 统一信封：{ type, at, seq, data }；seq 单进程单调递增，客户端据此丢乱序/重复帧。 */
export interface Envelope<T = unknown> {
  type: string;
  at: string;
  seq: number;
  data: T;
}

export interface ClientContext {
  seasonId?: number;
  cityId?: string;
}

export class Hub {
  private clients = new Map<WebSocket, ClientContext>();

  get size(): number {
    return this.clients.size;
  }

  add(ws: WebSocket, ctx: ClientContext = {}): void {
    this.clients.set(ws, ctx);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  remove(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  /** 单发给一条连接。 */
  send<T>(ws: WebSocket, type: string, data: T): void {
    this.push(ws, type, data);
  }

  /** 全服广播：market.tick / city.updated。 */
  broadcast<T>(type: string, data: T): void {
    for (const ws of this.clients.keys()) this.push(ws, type, data);
  }

  /** 只发给订阅了该城的连接。 */
  sendToCity<T>(cityId: string, type: string, data: T): void {
    for (const [ws, ctx] of this.clients) {
      if (ctx.cityId === cityId) this.push(ws, type, data);
    }
  }

  /** 一次推给多座城，每城可以拿不同的载荷。 */
  sendToCities<T>(cityIds: string[], type: string, dataFor: (cityId: string) => T): void {
    const wanted = new Set(cityIds);
    for (const [ws, ctx] of this.clients) {
      if (ctx.cityId && wanted.has(ctx.cityId)) this.push(ws, type, dataFor(ctx.cityId));
    }
  }

  private push<T>(ws: WebSocket, type: string, data: T): void {
    if (ws.readyState !== 1) return;
    const envelope: Envelope<T> = { type, at: new Date().toISOString(), seq: ++seq, data };
    try {
      ws.send(JSON.stringify(envelope));
    } catch {
      this.clients.delete(ws);
    }
  }
}

export const hub = new Hub();
