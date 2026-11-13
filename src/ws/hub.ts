/**
 * 进程内广播中心（M8 的底座）：单进程、无 Redis，符合 v1 不引入任务队列/分布式的约定。
 * 挂在 Fastify 同端口的 /ws；六个事件由业务层在事务提交后推到这里。
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

/** 连接订阅上下文：客户端带 ?season=&city= 声明关注范围。 */
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

  private frame<T>(type: string, data: T): string {
    return JSON.stringify({ type, at: new Date().toISOString(), seq: ++seq, data });
  }

  /** 全局广播（market.tick / city.updated / trade.resolved 等无城市归属或需全员知会的）。 */
  broadcast<T>(type: string, data: T): void {
    const msg = this.frame(type, data);
    for (const ws of this.clients.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  /**
   * 按连接各自 city 过滤下发（day.settled / events.arrived / trade.incoming）：
   * 每个连接只收到自己那城那份，不带别人资源明细。
   */
  broadcastPerCity<T>(type: string, perCity: Map<string, T>): void {
    for (const [ws, ctx] of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const data = ctx.cityId ? perCity.get(ctx.cityId) : undefined;
      if (data === undefined) continue;
      ws.send(this.frame(type, data));
    }
  }

  send<T>(ws: WebSocket, type: string, data: T): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(this.frame(type, data));
  }
}

export const hub = new Hub();
