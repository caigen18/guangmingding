/**
 * npm run check:m6 [-- N] —— M6（issue #16）三条验收自检。
 *
 * 1) 幂等：同一 day 结算两次，第二次 skipped，城市 version 与 day_logs 行数只 +1；
 * 2) advisory lock：一个连接持锁时，另一个连接 pg_try_advisory_xact_lock 拿不到；
 * 3) 耗时：连续结算 N 天（默认 20），每次 20 城端到端 < 2000ms。
 *
 * 前提：空库已跑过 npm run migrate && npm run seed（或 npm run db:reset）。
 */
import { pool } from '../db/pool.js';
import { settleDay } from './settle.js';

let failed = 0;

function ok(name: string, pass: boolean, detail: string): void {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!pass) failed += 1;
}

async function snapshot(): Promise<{ version: string; logs: string; silver: string }> {
  const r = await pool.query<{ version: string; logs: string; silver: string }>(
    `SELECT (SELECT COALESCE(MAX(version), 0) FROM cities)::text AS version,
            (SELECT count(*) FROM day_logs)::text AS logs,
            COALESCE((SELECT jsonb_typeof(resources->'silver') FROM cities ORDER BY name LIMIT 1), 'null') AS silver`,
  );
  const row = r.rows[0];
  return { version: row?.version ?? '0', logs: row?.logs ?? '0', silver: row?.silver ?? 'null' };
}

async function currentDay(): Promise<number> {
  const r = await pool.query<{ current_day: number }>(
    `SELECT current_day FROM seasons WHERE status = 'active' ORDER BY season_no LIMIT 1`,
  );
  const row = r.rows[0];
  if (!row) throw new Error('check:m6 需要一个 active 赛季（先 npm run seed）');
  return row.current_day;
}

async function main(): Promise<void> {
  const day = await currentDay();

  // 1) 幂等
  const before = await snapshot();
  const first = await settleDay(day);
  const second = await settleDay(day);
  const after = await snapshot();
  ok(
    '幂等：同一 day 结算两次',
    first.skipped === false &&
      second.skipped === true &&
      Number(after.version) - Number(before.version) === 1 &&
      Number(after.logs) - Number(before.logs) === 1,
    `first.skipped=${first.skipped} second.skipped=${second.skipped} version=${before.version}->${after.version} day_logs=${before.logs}->${after.logs}`,
  );
  ok(
    '资源保留非货物键（silver）',
    before.silver === 'number' && after.silver === 'number',
    `silver jsonb_typeof=${before.silver}->${after.silver}`,
  );

  // 2) advisory lock：A 持锁时 B 拿不到，A 释放后 B 能拿到
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query('BEGIN');
    await a.query("SELECT pg_advisory_xact_lock(hashtext('gmd:settle'), $1::int)", [day + 1]);
    const blocked = await b.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('gmd:settle'), $1::int) AS locked",
      [day + 1],
    );
    await a.query('ROLLBACK');
    const free = await b.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('gmd:settle'), $1::int) AS locked",
      [day + 1],
    );
    ok(
      'advisory lock 互斥',
      blocked.rows[0]?.locked === false && free.rows[0]?.locked === true,
      `持锁时第二连接 locked=${blocked.rows[0]?.locked}，释放后 locked=${free.rows[0]?.locked}`,
    );
  } finally {
    a.release();
    b.release();
  }

  // 3) 20 城耗时
  const days = Number(process.argv[2] ?? '20');
  const times: number[] = [];
  for (let i = 0; i < days; i += 1) {
    const r = await settleDay();
    if (!r.skipped) times.push(r.durationMs);
  }
  const sorted = [...times].sort((x, y) => x - y);
  const pick = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
  const over = times.filter((t) => t >= 2000).length;
  console.log(
    `      ${times.length} 次结算（每次 20 城）：min=${sorted[0]} p50=${pick(0.5)} p95=${pick(0.95)} max=${sorted[sorted.length - 1]} avg=${Math.round(times.reduce((s, t) => s + t, 0) / Math.max(times.length, 1))}`,
  );
  ok(
    '20 城端到端 < 2000ms',
    over === 0 && times.length === days,
    `over_2000ms=${over} runs=${times.length}/${days}`,
  );

  console.log(failed === 0 ? '\nM6 CHECK: PASS' : `\nM6 CHECK: FAIL (${failed})`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('check:m6 failed:', err);
  await pool.end();
  process.exit(1);
});
