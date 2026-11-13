/**
 * npm run settle —— 手动结算一天：npm run settle [-- N]
 * 不传天数则结算赛季当前日。并发测试时两个进程传同一个 N。
 */
import { pool } from '../db/pool.js';
import { settleDay } from './settle.js';

async function main(): Promise<void> {
  const arg = process.argv[2];
  const day = arg ? Number(arg) : undefined;
  if (arg && !Number.isInteger(day)) throw new Error(`settle: 无效天数 ${arg}`);
  const r = await settleDay(day);
  console.log(
    JSON.stringify({
      day: r.day,
      skipped: r.skipped,
      citiesSettled: r.citiesSettled,
      durationMs: r.durationMs,
      population: `${r.totals.populationBefore} -> ${r.totals.populationAfter}`,
      market: r.market.map((m) => `${m.good}=${m.price}(${m.deltaPct > 0 ? '+' : ''}${m.deltaPct}%)`),
    }),
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error('settle failed:', err);
  await pool.end();
  process.exit(1);
});
