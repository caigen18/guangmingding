/**
 * npm run bench:settle [-- N] —— 连续结算 N 天（默认 20），逐日计时并给统计。
 * 验收口径：20 城端到端单次结算 durationMs < 2000。
 */
import { performance } from 'node:perf_hooks';
import { pool } from '../db/pool.js';
import { settleDay } from './settle.js';

const LIMIT_MS = 2000;

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? '20');
  if (!Number.isInteger(n) || n < 1) throw new Error(`bench:settle 参数必须是正整数，收到 ${process.argv[2]}`);

  const runs: { day: number; durationMs: number; wallMs: number; cities: number; skipped: boolean }[] = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    const r = await settleDay();
    const wallMs = Math.round((performance.now() - t0) * 100) / 100;
    runs.push({ day: r.day, durationMs: r.durationMs, wallMs, cities: r.citiesSettled, skipped: r.skipped });
    console.log(
      r.skipped
        ? `day ${r.day}: SKIPPED (day_logs 已有记录)`
        : `day ${r.day}: cities=${r.citiesSettled} durationMs=${r.durationMs} wallMs=${wallMs} pop=${r.totals.populationBefore}->${r.totals.populationAfter}`,
    );
  }

  const ok = runs.filter((r) => !r.skipped).map((r) => r.durationMs).sort((a, b) => a - b);
  const q = (p: number): number => ok[Math.min(ok.length - 1, Math.floor(p * ok.length))] ?? 0;
  const sum = ok.reduce((a, b) => a + b, 0);
  const over = ok.filter((d) => d >= LIMIT_MS).length;

  console.log('--- summary ---');
  console.log(`runs=${runs.length} settled=${ok.length} cities=20`);
  console.log(`min=${ok[0]} p50=${q(0.5)} p95=${q(0.95)} max=${ok[ok.length - 1]} avg=${Math.round(sum / Math.max(ok.length, 1))}`);
  console.log(`over_${LIMIT_MS}ms=${over}`);
  console.log(over === 0 ? `PASS: ${ok.length} 次全部 < ${LIMIT_MS}ms` : `FAIL: ${over} 次 >= ${LIMIT_MS}ms`);

  const verify = await pool.query<{ day_logs: string; cities: string; last_day: string }>(
    `SELECT (SELECT count(*)::text FROM day_logs) AS day_logs,
            (SELECT count(*)::text FROM cities) AS cities,
            (SELECT max(day)::text FROM day_logs) AS last_day`,
  );
  console.log(
    `db: day_logs=${verify.rows[0]?.day_logs} cities=${verify.rows[0]?.cities} last_day=${verify.rows[0]?.last_day}`,
  );
  await pool.end();
  if (over > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('bench:settle failed:', err);
  await pool.end();
  process.exit(1);
});
