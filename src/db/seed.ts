/**
 * npm run seed —— 执行 db/seed.sql，写入 20 个测试城市（幂等）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

async function main(): Promise<void> {
  const seedPath = fileURLToPath(new URL('../../db/seed.sql', import.meta.url));
  const sql = await readFile(seedPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query<{ table: string; n: string }>(
      `SELECT 'cities' AS table, count(*)::text AS n FROM cities
       UNION ALL SELECT 'players', count(*)::text FROM players
       UNION ALL SELECT 'buildings', count(*)::text FROM buildings
       UNION ALL SELECT 'market_prices', count(*)::text FROM market_prices
       UNION ALL SELECT 'seasons', count(*)::text FROM seasons`,
    );
    console.log(`seed: ${seedPath} applied`);
    for (const r of rows) console.log(`seed: ${r.table} = ${r.n}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
