/**
 * npm run check:m6:steps —— M6 按 #4 第 4 节八步逐项自检（需 SEASON_DAYS=10 + 空库 reset）。
 * 断言第 4/5/6/8 步：未选事件不罚、已选事件生效、连续两日负资产破产、赛季末排名+结局+世界重置。
 */
import { pool } from '../db/pool.js';
import { settleDay } from './settle.js';

let failed = 0;
function ok(name: string, pass: boolean, detail: string): void {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!pass) failed += 1;
}

async function main(): Promise<void> {
  const season = await pool.query<{ id: string; season_no: number; current_day: number }>(
    `SELECT id::text AS id, season_no, current_day FROM seasons WHERE status = 'active' ORDER BY season_no LIMIT 1`,
  );
  const s = season.rows[0];
  if (!s) throw new Error('check:m6:steps 需要一个 active 赛季（先 npm run seed）');

  const d1 = await settleDay(1);
  ok('第 1/2/3/7 步：day1 结算 20 城', d1.citiesSettled === 20 && !d1.skipped, `durationMs=${d1.durationMs} cities=${d1.cities.length}`);

  // day2 造事件：10 城已选（效果 +20 粮 +5 声望），10 城未选
  const ev = await pool.query<{ id: string }>(
    `INSERT INTO events (season_id, template_key, title, body, severity, choices)
     VALUES ($1, 'test_harvest', '秋收', '今年收成不错', 'normal', '[{"key":"accept"}]'::jsonb)
     RETURNING id::text AS id`,
    [s.id],
  );
  const eventId = ev.rows[0]?.id;
  if (!eventId) throw new Error('事件插入失败');
  await pool.query(
    `INSERT INTO city_events (city_id, event_id, day, expires_day, status, choice_key, effects)
     SELECT c.id, $2, 2, 3, 'pending',
            CASE WHEN c.name IN (SELECT name FROM cities WHERE season_id = $1 ORDER BY name LIMIT 10) THEN 'accept' ELSE NULL END,
            CASE WHEN c.name IN (SELECT name FROM cities WHERE season_id = $1 ORDER BY name LIMIT 10)
                 THEN '{"resources":{"grain":20},"reputation":5}'::jsonb ELSE NULL END
       FROM cities c WHERE c.season_id = $1`,
    [s.id, eventId],
  );

  const d2 = await settleDay(2);
  const byStatus = await pool.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM city_events WHERE day = 2 GROUP BY status ORDER BY status`,
  );
  const counts = Object.fromEntries(byStatus.rows.map((r) => [r.status, Number(r.n)]));
  ok('第 5 步：已选事件 10 条 resolved', counts.resolved === 10, JSON.stringify(counts));
  ok('第 4 步：未选事件 10 条 expired（不罚）', counts.expired === 10, JSON.stringify(counts));
  ok('第 7 步：每城一份账', d2.cities.length === 20, `cities=${d2.cities.length}`);
  const applied = d2.cities.filter((c) => c.event?.outcome === 'applied');
  const skipped = d2.cities.filter((c) => c.event?.outcome === 'skipped');
  ok('事件效果真的执行（声望 +5）', applied.length === 10 && applied.every((c) => Math.abs(c.reputation.after - c.reputation.before - 5) < 1e-9), `applied=${applied.length}`);
  ok('未选城市记 skipped', skipped.length === 10, `skipped=${skipped.length}`);

  const again = await settleDay(2);
  ok('幂等：同一 day 重复结算', again.skipped === true, `skipped=${again.skipped}`);

  // 破产：并州连续两天银<0 且 粮<0
  await pool.query(
    `UPDATE cities SET resources = resources || '{"silver":-10,"grain":-200}'::jsonb
      WHERE season_id = $1 AND name = '并州'`,
    [s.id],
  );
  await settleDay(3);
  const st1 = await pool.query<{ status: string }>(`SELECT status FROM players WHERE name = '城主20'`);
  const log3 = await pool.query<{ summary: { cities: { cityId: string; negative: boolean }[] } }>(
    `SELECT summary FROM day_logs WHERE season_id = $1 AND day = 3`,
    [s.id],
  );
  const bz3 = log3.rows[0]?.summary.cities.find((c) => c.negative === true);
  ok('第 6 步：第 1 日负资产只记 negative', Boolean(bz3) && st1.rows[0]?.status === 'alive', `negative=${Boolean(bz3)} status=${st1.rows[0]?.status}`);

  const d4 = await settleDay(4);
  const st2 = await pool.query<{ status: string }>(`SELECT status FROM players WHERE name = '城主20'`);
  const bz4 = d4.cities.find((c) => c.name === '并州');
  ok('第 6 步：连续 2 日破产，日志留原因', st2.rows[0]?.status === 'bankrupt' && bz4?.bankrupt === true, `status=${st2.rows[0]?.status} reason=${bz4?.bankruptReason ?? 'null'}`);

  for (let day = 5; day <= 10; day += 1) await settleDay(day);
  const d10 = await pool.query<{ summary: { season: { champion: { city: string } | null; rankings: unknown[] } | null } }>(
    `SELECT summary FROM day_logs WHERE season_id = $1 AND day = 10`,
    [s.id],
  );
  const season10 = d10.rows[0]?.summary.season;
  ok('第 8 步：day10 出赛季结局', Boolean(season10) && season10?.rankings.length === 20 && Boolean(season10?.champion), `champion=${season10?.champion?.city ?? 'null'} rankings=${season10?.rankings.length ?? 0}`);

  const ended = await pool.query<{ status: string }>(`SELECT status FROM seasons WHERE id = $1`, [s.id]);
  ok('第 8 步：赛季置 ended', ended.rows[0]?.status === 'ended', `status=${ended.rows[0]?.status}`);

  const next = await pool.query<{ status: string; cities: string; buildings: string }>(
    `SELECT s.status, (SELECT count(*) FROM cities c WHERE c.season_id = s.id)::text AS cities,
            (SELECT count(*) FROM buildings b JOIN cities c ON c.id = b.city_id WHERE c.season_id = s.id)::text AS buildings
       FROM seasons s WHERE s.season_no = $1`,
    [s.season_no + 1],
  );
  ok('第 8 步：世界重置，新赛季 20 城 + 120 建筑', next.rows[0]?.status === 'active' && next.rows[0]?.cities === '20' && next.rows[0]?.buildings === '120', JSON.stringify(next.rows[0] ?? {}));

  const alive = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM players WHERE status = 'alive'`);
  const titled = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM players WHERE jsonb_array_length(titles) > 0`);
  ok('留称号 + 新赛季全员复活', titled.rows[0]?.n === '20' && alive.rows[0]?.n === '20', `titles=${titled.rows[0]?.n} alive=${alive.rows[0]?.n}`);

  console.log(failed === 0 ? '\nM6 STEPS: PASS' : `\nM6 STEPS: FAIL (${failed})`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('check:m6:steps failed:', err);
  await pool.end();
  process.exit(1);
});
