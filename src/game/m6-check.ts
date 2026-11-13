/**
 * m6-check —— M6 验收自检（#4 第 4 节八步）。
 * 用法：npm run db:reset && npm run check:m6   （.env 里 SEASON_DAYS=10）
 * 逐项打 [PASS]/[FAIL]，任何一项 FAIL 以非零码退出。
 */
import { pool } from '../db/pool.js';
import { settleDay, type CityDayLog } from './settle.js';
import { config } from '../config/game.js';

type DaySummary = { cities?: CityDayLog[] } & Record<string, unknown>;

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1;
    console.log(`[PASS] ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log(`seasonDays=${config.seasonDays} cities=20`);

  // ---- 第 1 步：结算 day 1 ----
  const d1 = await settleDay();
  ok(
    'day1 结算 20 城',
    d1.citiesSettled === 20 && !d1.skipped,
    `durationMs=${d1.durationMs} pop=${d1.totals.populationBefore}->${d1.totals.populationAfter}`,
  );

  // ---- 4/5 步：day2 造 10 条已选事件 + 10 条未选 ----
  const season = (
    await pool.query<{ id: string }>(
      `SELECT id::text FROM seasons WHERE status='active' ORDER BY season_no DESC LIMIT 1`,
    )
  ).rows[0];
  if (!season) throw new Error('没有 active 赛季');
  const ev = (
    await pool.query<{ id: string }>(
      `INSERT INTO events (season_id, template_key, title, body, severity, choices, generated_by, created_day)
       VALUES ($1, 't_grain_gift', '邻县赠粮', '邻县送来一批粮。', 'normal', '[{"key":"accept"}]'::jsonb, 'template', 2)
       RETURNING id::text AS id`,
      [season.id],
    )
  ).rows[0];
  if (!ev) throw new Error('事件插入失败');
  await pool.query(
    `WITH c AS (SELECT id, row_number() OVER (ORDER BY name) AS rn FROM cities WHERE season_id = $1)
     INSERT INTO city_events (city_id, event_id, day, expires_day, effects, choice_key)
     SELECT c.id, $2::uuid, 2, 2,
            CASE WHEN c.rn <= 10 THEN '{"resources":{"grain":20},"reputation":5}'::jsonb ELSE NULL END,
            CASE WHEN c.rn <= 10 THEN 'accept' ELSE NULL END
       FROM c`,
    [season.id, ev.id],
  );

  const d2 = await settleDay();
  ok('day2 结算 20 城', d2.citiesSettled === 20 && !d2.skipped, `durationMs=${d2.durationMs}`);
  const st = (
    await pool.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM city_events WHERE day = 2 GROUP BY status ORDER BY status`,
    )
  ).rows;
  const byStatus = Object.fromEntries(st.map((r) => [r.status, Number(r.n)]));
  ok('第 5 步：已选事件 10 条 resolved', byStatus.resolved === 10, JSON.stringify(byStatus));
  ok('第 4 步：未选事件 10 条 expired（不罚）', byStatus.expired === 10, JSON.stringify(byStatus));
  const log2 = (
    await pool.query<{ summary: DaySummary }>(`SELECT summary FROM day_logs WHERE day = 2`)
  ).rows[0]?.summary;
  const citiesLog: CityDayLog[] = log2?.cities ?? [];
  ok('第 7 步：day_logs 每城一份账（20 条）', citiesLog.length === 20, `cities=${citiesLog.length}`);
  const applied = citiesLog.filter((c) => c?.event?.outcome === 'applied');
  const skipped = citiesLog.filter((c) => c?.event?.outcome === 'skipped');
  ok(
    '事件效果真的执行（10 条 applied 且声望 +5）',
    applied.length === 10 &&
      applied.every((c) => Math.round(c.reputation.after - c.reputation.before) === 5),
    `applied=${applied.length}`,
  );
  ok('未选城市记 skipped', skipped.length === 10, `skipped=${skipped.length}`);

  // ---- 幂等 ----
  const again = await settleDay(2);
  const day2Logs = (
    await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM day_logs WHERE day = 2`)
  ).rows[0]?.n;
  ok(
    '同一 day 重复结算幂等（skipped，不写新日志）',
    again.skipped === true && day2Logs === '1',
    `skipped=${again.skipped} day_logs=${day2Logs}`,
  );

  // ---- 第 6 步：破产（银<0 且 粮<0 连续 2 日）----
  await pool.query(
    `UPDATE cities SET resources = resources || '{"silver":-10,"grain":-200}'::jsonb WHERE name = '并州'`,
  );
  await settleDay();
  const log3 = (
    await pool.query<{ summary: DaySummary }>(`SELECT summary FROM day_logs WHERE day = 3`)
  ).rows[0]?.summary;
  const c3 = (log3?.cities ?? []).find((c) => c.name === '并州');
  ok(
    '破产判定第 1 日：只记 negative，不破产',
    c3?.negative === true && c3?.bankrupt === false,
    `negative=${c3?.negative} bankrupt=${c3?.bankrupt} silver=${c3?.silver?.after} grain=${c3?.grain?.after}`,
  );
  await settleDay();
  const log4 = (
    await pool.query<{ summary: DaySummary }>(`SELECT summary FROM day_logs WHERE day = 4`)
  ).rows[0]?.summary;
  const c4 = (log4?.cities ?? []).find((c) => c.name === '并州');
  const p20 = (
    await pool.query<{ status: string }>(`SELECT status FROM players WHERE name = '城主20'`)
  ).rows[0]?.status;
  ok(
    '破产判定第 2 日：player 置 bankrupt 且日志留原因',
    p20 === 'bankrupt' && c4?.bankrupt === true && typeof c4?.bankruptReason === 'string',
    `status=${p20} reason=${c4?.bankruptReason}`,
  );

  // ---- 第 8 步：跑到第 10 日，赛季结算 + 世界重置 ----
  for (let i = 5; i <= 9; i += 1) await settleDay();
  const d10 = await settleDay();
  ok(
    '第 8 步：day10 结算并出赛季结局',
    d10.season !== null,
    `season=${JSON.stringify(d10.season ? { champion: d10.season.champion?.city, next: d10.season.nextSeason } : null)}`,
  );
  const seasonEnded = (
    await pool.query<{ status: string }>(`SELECT status FROM seasons WHERE season_no = 1`)
  ).rows[0]?.status;
  ok('赛季 1 置 ended', seasonEnded === 'ended', `status=${seasonEnded}`);
  const nextSeason = (
    await pool.query<{ season_no: number; status: string; cities: string }>(
      `SELECT s.season_no, s.status, (SELECT count(*)::text FROM cities WHERE season_id = s.id) AS cities
         FROM seasons s WHERE s.season_no = 2`,
    )
  ).rows[0];
  ok(
    '世界重置：赛季 2 已建且 20 城就位',
    nextSeason?.status === 'active' && nextSeason?.cities === '20',
    JSON.stringify(nextSeason),
  );
  const titles = (
    await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM players WHERE jsonb_array_length(titles) > 0`)
  ).rows[0]?.n;
  ok('留称号：20 人都有称号', titles === '20', `players_with_titles=${titles}`);
  const after = (
    await pool.query<{ alive: string; buildings: string }>(
      `SELECT (SELECT count(*)::text FROM players WHERE status = 'alive') AS alive,
              (SELECT count(*)::text FROM buildings b JOIN cities c ON c.id = b.city_id
                 JOIN seasons s ON s.id = c.season_id WHERE s.season_no = 2) AS buildings`,
    )
  ).rows[0];
  ok(
    '新赛季全员复活 + 120 座建筑',
    after?.alive === '20' && after?.buildings === '120',
    `alive=${after?.alive} buildings=${after?.buildings}`,
  );

  console.log(`--- ${fail === 0 ? 'ALL PASS' : 'FAIL'} pass=${pass} fail=${fail} ---`);
  await pool.end();
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
