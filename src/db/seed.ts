/**
 * npm run seed —— 执行 db/seed.sql，写入 20 个测试城市（幂等）。
 * 初始人口/幸福/资源与开市基准价从 config/game.ts 注入（替换 seed.sql 占位符），
 * 保证「改一个数全链路生效」（#17 第 2 步）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import {
  MARKET,
  STARTING_HAPPINESS,
  STARTING_POPULATION,
  STARTING_RESOURCES,
  STARTING_SILVER,
} from '../config/game.js';

/** 把 config 里的初始常数填进 seed.sql 的占位符 */
function renderSeedSql(raw: string): string {
  const resourcesJson = JSON.stringify({ silver: STARTING_SILVER, ...STARTING_RESOURCES });
  const priceValues = (Object.keys(MARKET.basePrice) as (keyof typeof MARKET.basePrice)[])
    .map((g) => `('${g}', ${MARKET.basePrice[g].toFixed(2)})`)
    .join(', ');

  // 必须全局替换：占位符在 seed.sql 的注释里也出现过一次，
  // String.prototype.replace(字符串) 只换第一个匹配，会换掉注释里那个，
  // 真正的 INSERT 里仍留着 __POPULATION__，Postgres 报 column "__population__" does not exist。
  const rendered = raw
    .replace(/__POPULATION__/g, () => String(STARTING_POPULATION))
    .replace(/__HAPPINESS__/g, () => String(STARTING_HAPPINESS))
    .replace(/__RESOURCES_JSON__/g, () => `'${resourcesJson}'`)
    .replace(/__PRICE_VALUES__/g, () => priceValues);

  const left = rendered.match(/__[A-Z_]+__/);
  if (left) throw new Error(`seed.sql 里还有未替换的占位符：${left[0]}`);
  return rendered;
}

async function main(): Promise<void> {
  const seedPath = fileURLToPath(new URL('../../db/seed.sql', import.meta.url));
  const sql = renderSeedSql(await readFile(seedPath, 'utf8'));
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
