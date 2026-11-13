// scripts/verify-counts.mjs —— 打印 11 张表 count（供 make verify 用）
// 用法：DATABASE_URL=... node scripts/verify-counts.mjs
import pg from 'pg';

const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('verify-counts: 需要 DATABASE_URL');
  process.exit(2);
}

// 与 db/schema.sql 的 11 张表一一对应（顺序固定，便于 diff 比对幂等）
const TABLES = [
  'seasons',
  'players',
  'cities',
  'buildings',
  'assignments',
  'events',
  'city_events',
  'day_logs',
  'market_prices',
  'trades',
  'ai_calls',
];

const client = new Client({ connectionString: url });
await client.connect();
try {
  for (const t of TABLES) {
    const r = await client.query(`SELECT count(*)::bigint AS c FROM ${t}`);
    console.log(`${t}=${r.rows[0].c}`);
  }
} finally {
  await client.end();
}
