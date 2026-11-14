/**
 * #11 / #12 E2E（无头 Chromium）：双浏览器各看一城、六事件实收、视口变化不重载、草稿不丢。
 * 用法：ADMIN_USER=… ADMIN_PASS=… node scripts/e2e-check.mjs [base]
 * 依赖：playwright（PW_PATH 指向其 ESM 入口）、服务已起且库里有 20 城。
 */
const PW = process.env.PW_PATH || '/root/agentes/shared/pw/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);

const BASE = (process.argv[2] || process.env.BASE || 'http://127.0.0.1:3010').replace(/\/$/, '');
const AUTH =
  'Basic ' +
  Buffer.from((process.env.ADMIN_USER || 'admin') + ':' + (process.env.ADMIN_PASS || 'change-me')).toString('base64');

const pass = [];
const fail = [];
const ok = (m) => {
  pass.push(m);
  console.log('  ✓ ' + m);
};
const bad = (m) => {
  fail.push(m);
  console.log('  X ' + m);
};

const state = await (await fetch(BASE + '/api/state')).json();
const board = state.leaderboard ?? [];
if (board.length < 2) {
  console.error('需要至少两座城，库里只有 ' + board.length);
  process.exit(1);
}
const A = board[0];
const B = board[1];
console.log(`base=${BASE} season=${state.season.season_no} day=${state.season.day}`);
console.log(`A=${A.name}(${A.id})  B=${B.name}(${B.id})`);

const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function openCity(city, viewport) {
  const ctx = await browser.newContext({
    viewport,
    serviceWorkers: 'block',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; HarmonyOS) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
  });
  // 记录页面 ws 收到的消息类型 + 一个「没重载」标记（重载会重置它）
  await ctx.addInitScript(() => {
    window.__noReload = 'keep';
    window.__wsLog = [];
    const RealWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      const ws = new RealWS(url, protocols);
      ws.addEventListener('message', (ev) => {
        try {
          const m = JSON.parse(ev.data);
          window.__wsLog.push({ type: m.type, data: m.data });
        } catch (e) {}
      });
      return ws;
    };
    window.WebSocket.prototype = RealWS.prototype;
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?city=${encodeURIComponent(city.id)}`, { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

const noHScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const okA = await openCity(A, { width: 390, height: 780 });

// 1) 首屏：城市、连接、关键数字、无横向滚动
try {
  await okA.page.waitForFunction(
    () => document.getElementById('connTxt')?.textContent?.includes('已连接'),
    null,
    { timeout: 15000 },
  );
  ok('A 首屏 ws 已连接（connTxt=已连接）');
} catch (e) {
  bad('A 首屏 ws 未在 15s 内连上：' + (await okA.page.textContent('#connTxt')));
}
const nameA = (await okA.page.textContent('#cityName')) ?? '';
nameA.includes(A.name) ? ok(`A 首屏城市正确（${A.name}）`) : bad(`A 首屏城市错：${nameA}`);
const keynums = (await okA.page.textContent('#keynums')) ?? '';
keynums.trim().length > 0 ? ok('A 首屏有关键数字') : bad('A 首屏关键数字为空');
const box = await okA.page.locator('#keynums').boundingBox();
box && box.y < 780 ? ok('A 关键数字在首屏可见') : bad('A 关键数字不在首屏');
(await noHScroll(okA.page)) ? ok('390vp 无横向滚动') : bad('390vp 有横向滚动');

// 2) 断点：320 / 600 / 800 / 1000 / 1200 都不横滚，且不重载
for (const width of [320, 600, 800, 1000, 1200]) {
  await okA.page.setViewportSize({ width, height: 780 });
  await okA.page.waitForTimeout(250);
  const noScroll = await noHScroll(okA.page);
  const marker = await okA.page.evaluate(() => window.__noReload);
  const lbOpen = await okA.page.evaluate(() => document.getElementById('lbDetail')?.open);
  const expectOpen = width >= 1000;
  noScroll ? ok(`${width}vp 无横向滚动`) : bad(`${width}vp 有横向滚动`);
  marker === 'keep' ? ok(`${width}vp 未重载`) : bad(`${width}vp 发生了重载`);
  lbOpen === expectOpen
    ? ok(`${width}vp 榜单折叠=${!expectOpen}`)
    : bad(`${width}vp 榜单 open=${lbOpen} 期望 ${expectOpen}`);
}
await okA.page.setViewportSize({ width: 390, height: 780 });
await okA.page.waitForTimeout(200);

// 3) 草稿：下单进 localStorage，换视口不丢，刷新后恢复
await okA.page.selectOption('#trDir', 'buy').catch(() => {});
await okA.page.fill('#trQty', '5');
await okA.page.click('#trAdd');
const draftKey = await okA.page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('gmd:draft:'));
  return k ? localStorage.getItem(k) : null;
});
let draft = null;
try {
  draft = JSON.parse(draftKey ?? 'null');
} catch (e) {}
draft?.trades?.length === 1 ? ok('下单草稿写入 localStorage') : bad('草稿未写入 localStorage');
const pendingTxt = (await okA.page.textContent('#pending')) ?? '';
pendingTxt.includes('1 笔订单') ? ok('操作条显示 1 笔订单') : bad(`操作条文案异常：${pendingTxt}`);
await okA.page.setViewportSize({ width: 1000, height: 780 });
await okA.page.waitForTimeout(200);
(await okA.page.textContent('#pending'))?.includes('1 笔订单')
  ? ok('换视口后草稿仍在（未丢）')
  : bad('换视口后草稿丢了');
await okA.page.reload({ waitUntil: 'domcontentloaded' });
await okA.page.waitForFunction(() => document.getElementById('connTxt')?.textContent?.includes('已连接'), null, {
  timeout: 15000,
});
(await okA.page.textContent('#pending'))?.includes('1 笔订单')
  ? ok('刷新后草稿从 localStorage 恢复')
  : bad('刷新后草稿未恢复');
await okA.page.setViewportSize({ width: 390, height: 780 });

// 4) 双浏览器：第二座城看到自己的城
const okB = await openCity(B, { width: 390, height: 780 });
await okB.page.waitForFunction(() => document.getElementById('connTxt')?.textContent?.includes('已连接'), null, {
  timeout: 15000,
});
const nameB = (await okB.page.textContent('#cityName')) ?? '';
nameB.includes(B.name) ? ok(`B 首屏城市正确（${B.name}）`) : bad(`B 首屏城市错：${nameB}`);
nameA !== nameB ? ok('两个浏览器看到的不是同一座城') : bad('两个浏览器城市相同');

// 5) 结算：day.settled / market.tick / city.updated 实收，页面不重载、日号前进
const beforeDay = Number((await okA.page.textContent('#dayNum')) ?? '0');
const settleRes = await fetch(BASE + '/admin/settle', { method: 'POST', headers: { authorization: AUTH } });
const settleBody = await settleRes.json().catch(() => ({}));
settleRes.ok
  ? ok(`POST /admin/settle 200（day=${settleBody.day} 城=${settleBody.citiesSettled} 用时=${settleBody.durationMs}ms）`)
  : bad(`/admin/settle ${settleRes.status}`);

async function waitTypes(page, types, ms = 15000) {
  const t0 = Date.now();
  const seen = new Set();
  while (Date.now() - t0 < ms) {
    const log = await page.evaluate(() => window.__wsLog || []);
    log.forEach((m) => seen.add(m.type));
    if (types.every((t) => seen.has(t))) return [...seen];
    await page.waitForTimeout(200);
  }
  return [...seen];
}

const seenA = await waitTypes(okA.page, ['day.settled', 'market.tick', 'city.updated']);
['day.settled', 'market.tick', 'city.updated'].forEach((t) =>
  seenA.includes(t) ? ok(`A 收到 ${t}`) : bad(`A 没收到 ${t}（收到：${seenA.join(',')}）`),
);
const afterDay = Number((await okA.page.textContent('#dayNum')) ?? '0');
afterDay > beforeDay ? ok(`A 日号前进 ${beforeDay}→${afterDay}`) : bad(`A 日号没前进（${beforeDay}→${afterDay}）`);
(await okA.page.evaluate(() => window.__noReload)) === 'keep' ? ok('结算推送后未重载') : bad('结算推送后发生了重载');

// 6) 六事件：events.arrived / trade.incoming / trade.resolved 由 /admin/emit 触发
async function emit(type) {
  const r = await fetch(BASE + '/admin/emit', {
    method: 'POST',
    headers: { authorization: AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ type }),
  });
  const body = await r.json().catch(() => ({}));
  r.ok ? ok(`POST /admin/emit ${type} → ${JSON.stringify(body)}`) : bad(`/admin/emit ${type} ${r.status} ${JSON.stringify(body)}`);
  return body;
}

// 契约 v1.1：events.arrived / trade.incoming 按城单播（只发目标城），trade.resolved 发交易双方。
// /admin/emit 的目标城由服务端按名字取头两座城，所以先问它发给谁，再找/开那座城的页面。
const nameToCity = new Map(board.map((c) => [c.name, c]));
const pages = new Map([
  [A.name, okA.page],
  [B.name, okB.page],
]);
async function pageFor(name) {
  if (pages.has(name)) return pages.get(name);
  const city = nameToCity.get(name);
  if (!city) throw new Error('未知城：' + name);
  const p = await openCity(city, { width: 390, height: 780 });
  await p.page.waitForFunction(() => document.getElementById('connTxt')?.textContent?.includes('已连接'), null, {
    timeout: 15000,
  });
  pages.set(name, p.page);
  return p.page;
}
async function otherPage(name) {
  for (const [n, p] of pages) if (n !== name) return p;
  return null;
}

// 先发一次只为问出目标城（服务端按名字取头两座），再开那座城的页面，第二次发才算数。
const evProbe = await emit('events.arrived');
const evPage = await pageFor(evProbe.to);
const decoy = await otherPage(evProbe.to);
const decoyBefore = decoy
  ? (await decoy.evaluate(() => (window.__wsLog || []).filter((m) => m.type === 'events.arrived').length))
  : 0;
const evBody = await emit('events.arrived');
const evSeen = await waitTypes(evPage, ['events.arrived'], 8000);
evSeen.includes('events.arrived')
  ? ok(`目标城 ${evBody.to} 收到 events.arrived`)
  : bad(`目标城 ${evBody.to} 没收到 events.arrived（收到：${evSeen.join(',')}）`);
if (decoy) {
  await decoy.waitForTimeout(1200);
  const decoyAfter = await decoy.evaluate(() => (window.__wsLog || []).filter((m) => m.type === 'events.arrived').length);
  decoyAfter === decoyBefore
    ? ok('非目标城没收到 events.arrived（按城单播成立）')
    : bad('非目标城也收到了 events.arrived（违背按城单播）');
}
const seenB2 = await waitTypes(okB.page, ['city.updated'], 8000);
seenB2.includes('city.updated') ? ok('B 收到 city.updated') : bad('B 没收到 city.updated');

const tiProbe = await emit('trade.incoming');
const tiPage = await pageFor(tiProbe.to);
const tiBody = await emit('trade.incoming');
const tiSeen = await waitTypes(tiPage, ['trade.incoming'], 8000);
tiSeen.includes('trade.incoming')
  ? ok(`目标城 ${tiBody.to} 收到 trade.incoming`)
  : bad(`目标城 ${tiBody.to} 没收到 trade.incoming（收到：${tiSeen.join(',')}）`);

await emit('trade.resolved');
// trade.resolved 发给交易双方，其中一方就是同一座按名字排序的城
const trSeen = await waitTypes(tiPage, ['trade.resolved'], 8000);
trSeen.includes('trade.resolved')
  ? ok(`交易方 ${tiBody.to} 收到 trade.resolved`)
  : bad(`交易方 ${tiBody.to} 没收到 trade.resolved（收到：${trSeen.join(',')}）`);

// 7) PWA 资源可达
for (const p of ['/manifest.webmanifest', '/sw.js', '/icon-192.png']) {
  const r = await fetch(BASE + p);
  r.ok ? ok(`${p} ${r.status}`) : bad(`${p} ${r.status}`);
}

await okA.ctx.close();
await okB.ctx.close();
for (const [n, p] of pages) if (n !== A.name && n !== B.name) await p.context().close();
await browser.close();

console.log(`\n通过 ${pass.length} / 失败 ${fail.length}`);
if (fail.length) {
  console.log(fail.map((f) => '  X   ' + f).join('\n'));
  process.exit(1);
}
