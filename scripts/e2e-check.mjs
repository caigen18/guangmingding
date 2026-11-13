/**
 * #11 / #12 E2E（无头 Chromium）：双浏览器互通、断网重连不丢选择、视口变化不重载。
 */
const PW = process.env.PW_PATH || '/root/agentes/shared/pw/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const BASE = process.argv[2] || 'http://127.0.0.1:3010';
const AUTH = 'Basic ' + Buffer.from((process.env.ADMIN_USER || 'admin') + ':' + (process.env.ADMIN_PASS || 'change-me')).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = [];
const fail = [];
const ok = (c, msg) => (c ? pass : fail).push(msg);

const cities = (await (await fetch(BASE + '/api/cities')).json()).cities;
const A = cities[0], B = cities[1];
const browser = await chromium.launch();
const mk = async (city) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.addCookies([{ name: 'gmd_city', value: city.id, url: BASE }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail.push('JS error @' + city.name + ': ' + e.message));
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  return { ctx, page };
};
const a = await mk(A);
const b = await mk(B);
const conn = (p) => p.evaluate(() => (document.getElementById('conn-text') || {}).textContent);
await sleep(500);
ok((await conn(a.page)).includes('已连接'), 'A connected');
ok((await conn(b.page)).includes('已连接'), 'B connected');
const beforeA = await a.page.textContent('#season-day');
await a.page.evaluate(() => { window.__noReload = 'marker-1'; });
const r = await fetch(BASE + '/admin/settle', { method: 'POST', headers: { authorization: AUTH } });
const settled = await r.json();
ok(
  r.status === 200 && typeof settled.day === 'number' && settled.citiesSettled > 0,
  'admin settle 200 (day=' + settled.day + ', cities=' + settled.citiesSettled + ', ' + settled.durationMs + 'ms)',
);
await sleep(1200);
const streamA = await a.page.textContent('#stream');
const streamB = await b.page.textContent('#stream');
ok(streamA.includes('day.settled'), 'A got day.settled');
ok(streamB.includes('day.settled'), 'B got day.settled');
ok(streamA.includes('city.updated') && streamB.includes('city.updated'), 'both got city.updated');
const afterA = await a.page.textContent('#season-day');
ok(beforeA !== afterA, 'A day text changed ' + beforeA + ' -> ' + afterA);
console.log('PHASE1 ok');

// ---- 2) 视口变化不重载、当日选择不丢 ----
const marker = await a.page.evaluate(() => window.__noReload);
await a.page.setViewportSize({ width: 700, height: 780 });
await sleep(300);
ok((await a.page.evaluate(() => window.__noReload)) === marker, 'expanded to 700 without reload');
const line = await a.page.textContent('#view-line');
ok(/重排/.test(line), 'view-line tracks reflow: ' + line);
await a.page.setViewportSize({ width: 320, height: 780 });
await sleep(300);
ok((await a.page.evaluate(() => window.__noReload)) === marker, 'back to 320 without reload');

// ---- 3) 断网 -> 重连 -> 重拉状态 + 草稿补交 ----
const { execFileSync } = await import('node:child_process');
const out = execFileSync('node', ['scripts/dev-demo-event.mjs', A.name], { cwd: process.cwd() }).toString().trim();
ok(/插好/.test(out), 'demo card ready: ' + out);
await a.page.reload({ waitUntil: 'networkidle' });
await sleep(300);
const choices = await a.page.$$('#cards button.choice');
ok(choices.length > 0, 'event card choices rendered: ' + choices.length);
// 3a) 连接被断 -> 自动重连 -> 重拉状态
await a.page.evaluate(() => window.__gmdDebug.drop());
let offlineText = '';
for (let i = 0; i < 20; i++) {
  await sleep(300);
  offlineText = await conn(a.page);
  if (/断开|重连|连接中/.test(offlineText)) break;
}
ok(/断开|重连|连接中/.test(offlineText), 'drop detected in UI: ' + offlineText);
let backText = '';
for (let i = 0; i < 30; i++) {
  await sleep(500);
  backText = await conn(a.page);
  if (backText.includes('已连接')) break;
}
ok(backText.includes('已连接'), 'auto reconnect: ' + backText);
const streamRe = await a.page.textContent('#stream');
ok(/重连|重拉/.test(streamRe), 'state re-pulled after reconnect');

// 3b) 提交失败 -> 选择不丢 -> 恢复后补交
await a.page.unroute('**/api/choice');
await a.page.route('**/api/choice', (route) => route.abort());
const btns = await a.page.$$('#cards button.choice');
if (btns.length) await btns[0].click();
await sleep(700);
const draft = await a.page.evaluate(() => Object.keys(localStorage).filter((k) => k.indexOf('gmd_draft') === 0));
ok(draft.length > 0, 'failed submit kept draft: ' + draft.join(','));
await a.page.unroute('**/api/choice');
await a.page.evaluate(() => window.__gmdDebug.flush());
await sleep(1500);
const draftLeft = await a.page.evaluate(() => Object.keys(localStorage).filter((k) => k.indexOf('gmd_draft') === 0));
ok(draftLeft.length === 0, 'draft flushed after submit works again');
const chosen = await a.page.evaluate(() => document.querySelectorAll('#cards .is-chosen').length);
ok(chosen > 0, 'card shows chosen state');

await browser.close();
console.log('PASS ' + pass.length + '\n' + pass.map((p) => '  ok  ' + p).join('\n'));
if (fail.length) { console.log('FAIL ' + fail.length + '\n' + fail.map((f) => '  X   ' + f).join('\n')); process.exit(1); }
