/**
 * npm run db:reset —— 清空 public schema 后重建 + seed（只给测试/基准用）。
 * 生产环境（NODE_ENV=production）直接拒绕。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { config } from '../config/game.js';

async function main(): Promise<void> {
  if (config.nodeEnv === 'production') throw new Error('db:reset 不允许在 production 跑');
  const schemaSql = await readFile(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8');
  const seedSql = await readFile(fileURLToPath(new URL('../../db/seed.sql', import.meta.url)), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query(schemaSql);
    await client.query(seedSql);
    const { rows } = await client.query<{ cities: string; seasons: string; day: string }>(
      `SELECT (SELECT count(*)::text FROM cities) AS cities,
              (SELECT count(*)::text FROM seasons) AS seasons,
              (SELECT current_day::text FROM seasons ORDER BY season_no LIMIT 1) AS day`,
    );
    console.log(`db:reset OK — cities=${rows[0]?.cities} seasons=${rows[0]?.seasons} current_day=${rows[0]?.day}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('db:reset failed:', err);
  process.exit(1);
});
