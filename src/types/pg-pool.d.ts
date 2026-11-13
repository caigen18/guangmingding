/**
 * pg 的 Pool.connect 是重载函数（无参 → Promise<PoolClient>，带 callback → void）。
 * TypeScript 的 ReturnType 取最后一个重载，于是 `Awaited<ReturnType<typeof pool.connect>>`
 * 被推成 void。这里补一个返回 Promise<PoolClient> 的重载放在末尾，让衍生类型对上真实行为。
 */
import 'pg';

declare module 'pg' {
  interface Pool {
    connect(): Promise<import('pg').PoolClient>;
  }
}
