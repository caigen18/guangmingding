import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';

interface CityRow {
  id: string;
  name: string;
  population: number;
  happiness: number;
  reputation: number;
  resources: Record<string, number> | null;
  version: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function cityRows(cities: CityRow[]): string {
  return cities
    .map((c) => {
      const r = c.resources ?? {};
      return (
        '<tr data-city="' + esc(c.id) + '" data-version="' + num(c.version) + '">' +
        '<td class="nm">' + esc(c.name) + '</td>' +
        '<td class="pop">' + Math.round(num(c.population)) + '</td>' +
        '<td class="hap">' + Math.round(num(c.happiness)) + '</td>' +
        '<td class="rep">' + Math.round(num(c.reputation)) + '</td>' +
        '<td class="grain">' + num(r.grain) + '</td>' +
        '<td class="wood">' + num(r.wood) + '</td>' +
        '<td class="stone">' + num(r.stone) + '</td>' +
        '<td class="iron">' + num(r.iron) + '</td>' +
        '<td class="cloth">' + num(r.cloth) + '</td>' +
        '<td class="ver">' + num(c.version) + '</td>' +
        '</tr>'
      );
    })
    .join('');
}

function cityOptions(cities: CityRow[], selected: string | null): string {
  return cities
    .map((c) => '<option value="' + esc(c.id) + '"' + (c.id === selected ? ' selected' : '') + '>' + esc(c.name) + '</option>')
    .join('');
}
function renderIndex(opts: {
  currentDay: number;
  seasonNo: number;
  seasonId: string;
  cities: CityRow[];
  myCity: string | null;
}): string {
  const { currentDay, seasonNo, cities, myCity } = opts;
  const me = cities.find((c) => c.id === myCity) ?? null;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>光明顶 · 第 ${currentDay} 日</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 14px; max-width: 720px; margin-inline: auto; }
  h1 { font-size: 18px; margin: 4px 0 2px; }
  h2 { font-size: 14px; margin: 16px 0 6px; }
  .sub { color: #888; font-size: 12px; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: right; padding: 5px 6px; border-bottom: 1px solid rgba(128,128,128,.2); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #888; font-weight: 500; }
  tr.me { background: rgba(80,180,120,.14); }
  select, input, button { font: inherit; font-size: 13px; padding: 4px 6px; }
  button { cursor: pointer; }
  .card { border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 8px; margin: 6px 0; font-size: 13px; }
  .card .sev { font-size: 11px; color: #c84; margin-left: 6px; }
  #log { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; background: rgba(128,128,128,.08); border-radius: 8px; padding: 8px; margin-top: 12px; max-height: 32vh; overflow: auto; white-space: pre-wrap; }
  .st { color: #3c8; }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
</style>
</head>
<body data-city="${myCity ? esc(myCity) : ''}" data-season="${seasonNo}" data-season-id="${esc(opts.seasonId)}" data-day="${currentDay}">
<h1>光明顶</h1>
<div class="sub">第 <span id="day">${currentDay}</span> 日 · 赛季 ${seasonNo} · <span id="conn" style="color:#c84">连接中…</span> · 本城：<span id="me">${me ? esc(me.name) : '未选择'}</span></div>
<div class="row">选择本城：<select id="picker">${cityOptions(cities, myCity)}</select></div>

<h2>本城市场</h2>
<table id="market">
<thead><tr><th>货物</th><th>价</th><th>昨日</th><th>涨跌</th></tr></thead>
<tbody></tbody>
</table>

<h2>收到的事件</h2>
<div id="events"><div class="sub">（无）</div></div>

<h2>交易</h2>
<div id="trades"><div class="sub">（无）</div></div>
<div class="row">
  <select id="toCity">${cityOptions(cities.filter((c) => c.id !== myCity), null)}</select>
  给 <select id="giveGood"><option>grain</option><option>wood</option><option>stone</option><option>iron</option><option>cloth</option></select>
  <input id="giveAmt" type="number" min="1" value="10" style="width:64px">
  换 <select id="takeGood"><option>cloth</option><option>iron</option><option>stone</option><option>wood</option><option>grain</option></select>
  <input id="takeAmt" type="number" min="1" value="5" style="width:64px">
  <button id="sendTrade">发出要约</button>
</div>

<h2>全服 20 城</h2>
<table>
<thead><tr><th>城市</th><th>人口</th><th>幸福</th><th>声望</th><th>粮</th><th>木</th><th>石</th><th>铁</th><th>布</th><th>版本</th></tr></thead>
<tbody>${cityRows(cities)}</tbody>
</table>
<div id="log"></div>
<script>
(function () {
  var body = document.body;
  var S = {
    city: body.getAttribute('data-city') || null,
    season: Number(body.getAttribute('data-season') || 1),
    lastSeq: 0,
    versions: {},
    ws: null,
    trades: []
  };
  var logEl = document.getElementById('log');
  var connEl = document.getElementById('conn');
  window.__m8 = S;

  function log(line, cls) {
    var d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = new Date().toISOString().slice(11, 23) + ' ' + line;
    logEl.appendChild(d);
    while (logEl.childElementCount > 400) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setCell(tr, sel, v) { var el = tr.querySelector(sel); if (el) el.textContent = v; }

  document.getElementById('picker').addEventListener('change', function (e) {
    location.search = '?city=' + encodeURIComponent(e.target.value);
  });

  function renderMarket(quotes) {
    var tb = document.querySelector('#market tbody');
    if (!tb) return;
    tb.innerHTML = '';
    (quotes || []).forEach(function (q) {
      var tr = document.createElement('tr');
      tr.setAttribute('data-good', q.good);
      tr.innerHTML = '<td>' + q.good + '</td><td>' + q.price + '</td><td>' + q.prevPrice + '</td><td>' + (q.deltaPct > 0 ? '+' : '') + q.deltaPct + '%</td>';
      tb.appendChild(tr);
    });
  }

  function renderEvents(cards) {
    var box = document.getElementById('events');
    if (box.querySelector('.sub')) box.innerHTML = '';
    (cards || []).forEach(function (c) {
      var d = document.createElement('div');
      d.className = 'card';
      d.setAttribute('data-event', c.event_id);
      var choices = (c.choices || []).map(function (ch) { return '[' + ch.choice_key + '] ' + ch.label; }).join(' · ');
      d.innerHTML = '<b>' + c.title + '</b><span class="sev">' + c.severity + '</span><div>' + c.body + '</div><div class="sub" style="margin:4px 0 0">' + choices + '</div>';
      box.appendChild(d);
    });
  }

  function renderTrades() {
    var box = document.getElementById('trades');
    box.innerHTML = '';
    if (!S.trades.length) { box.innerHTML = '<div class="sub">（无）</div>'; return; }
    S.trades.forEach(function (t) {
      var d = document.createElement('div');
      d.className = 'card';
      d.setAttribute('data-trade', t.id);
      var give = (t.give || []).map(function (i) { return i.good + ' x' + i.amount; }).join(', ');
      var take = (t.take || []).map(function (i) { return i.good + ' x' + i.amount; }).join(', ');
      d.innerHTML = '<b>' + t.dir + '</b> ' + (t.city || '') + '<div>' + give + ' / ' + take + '</div><div class="sub">' + t.id.slice(0, 8) + ' · ' + t.status + '</div>';
      if (t.dir === 'incoming' && t.status === 'pending') {
        var acc = document.createElement('button'); acc.textContent = '接受'; acc.setAttribute('data-accept', t.id);
        var dec = document.createElement('button'); dec.textContent = '拒绝'; dec.setAttribute('data-decline', t.id);
        acc.addEventListener('click', function () { resolveTrade(t.id, 'accept'); });
        dec.addEventListener('click', function () { resolveTrade(t.id, 'decline'); });
        d.appendChild(acc); d.appendChild(dec);
      }
      box.appendChild(d);
    });
  }

  function resolveTrade(id, action) {
    fetch('/api/trades/' + id + '/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ city_id: S.city })
    }).then(function (r) { return r.json().then(function (j) { return { code: r.status, body: j }; }); })
      .then(function (r) { log('POST /api/trades/' + id.slice(0, 8) + '/' + action + ' -> ' + r.code + ' ' + JSON.stringify(r.body)); });
  }

  document.getElementById('sendTrade').addEventListener('click', function () {
    if (!S.city) { return; }
    var payload = {
      from_city_id: S.city,
      to_city_id: document.getElementById('toCity').value,
      give: [{ good: document.getElementById('giveGood').value, amount: Number(document.getElementById('giveAmt').value) }],
      take: [{ good: document.getElementById('takeGood').value, amount: Number(document.getElementById('takeAmt').value) }]
    };
    fetch('/api/trades', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { code: r.status, body: j }; }); })
      .then(function (r) {
        log('POST /api/trades -> ' + r.code + ' ' + JSON.stringify(r.body));
        if (r.code === 201) {
          S.trades.unshift({ id: r.body.trade_id, dir: 'outgoing', city: document.getElementById('toCity').selectedOptions[0].textContent, give: payload.give, take: payload.take, status: r.body.status });
          renderTrades();
        }
      });
  });

  function reloadMyCity() {
    if (!S.city) return;
    fetch('/api/cities/' + encodeURIComponent(S.city))
      .then(function (r) { return r.json(); })
      .then(function (c) {
        log('reload /api/cities/:id -> v' + c.version, 'st');
        applyCity(c.city_id, c.name, c.population, c.happiness, c.reputation, c.resources, c.version, true);
      })
      .catch(function (e) { log('reload failed ' + e); });
  }

  function applyCity(id, name, pop, hap, rep, res, version, force) {
    var known = S.versions[id] || 0;
    if (Number(version) < known || (Number(version) === known && !force)) { return false; }
    S.versions[id] = Number(version);
    var tr = document.querySelector('tr[data-city="' + id + '"]');
    if (tr) {
      setCell(tr, '.nm', name);
      setCell(tr, '.pop', Math.round(pop));
      setCell(tr, '.hap', Math.round(hap));
      setCell(tr, '.rep', Math.round(rep));
      if (res) {
        setCell(tr, '.grain', res.grain); setCell(tr, '.wood', res.wood); setCell(tr, '.stone', res.stone);
        setCell(tr, '.iron', res.iron); setCell(tr, '.cloth', res.cloth);
      }
      setCell(tr, '.ver', version);
      tr.setAttribute('data-version', String(version));
      if (id === S.city) tr.classList.add('me');
    }
    return true;
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    var url = proto + '://' + location.host + '/ws?season=' + S.season + (S.city ? '&city=' + encodeURIComponent(S.city) : '');
    var ws = new WebSocket(url);
    S.ws = ws;
    ws.onopen = function () {
      connEl.textContent = '已连接';
      connEl.style.color = '#3c8';
      log('connected ' + url.slice(url.indexOf('/ws')), 'st');
      reloadMyCity();
    };
    ws.onclose = function () {
      connEl.textContent = '已断开，2s 后重连';
      connEl.style.color = '#c84';
      log('closed', 'st');
      setTimeout(connect, 2000);
    };
    ws.onerror = function () { ws.close(); };
    ws.onmessage = function (ev) {
      var m = JSON.parse(ev.data);
      if (m.seq && m.seq <= S.lastSeq) { log('drop dup seq=' + m.seq); return; }
      if (m.seq) S.lastSeq = m.seq;
      var d = m.data || {};
      if (m.type === 'city.updated') {
        var ok = applyCity(d.city_id, d.name, d.population, d.happiness, d.reputation, d.resources, d.version, false);
        log('city.updated seq=' + m.seq + ' ' + d.name + ' v' + d.version + (ok ? '' : ' stale'));
        return;
      }
      if (m.type === 'market.tick') {
        renderMarket(d.quotes);
        log('market.tick seq=' + m.seq + ' day=' + d.day + ' ' + (d.quotes || []).map(function (q) { return q.good + ':' + q.price; }).join(' '));
        return;
      }
      if (m.type === 'day.settled') {
        document.getElementById('day').textContent = d.day;
        renderMarket(d.market);
        log('day.settled seq=' + m.seq + ' day=' + d.day + ' city=' + (d.city && d.city.cityId) + ' duration_ms=' + d.duration_ms);
        return;
      }
      if (m.type === 'events.arrived') { renderEvents(d.cards); log('events.arrived seq=' + m.seq + ' cards=' + (d.cards || []).length); return; }
      if (m.type === 'trade.incoming') {
        S.trades.unshift({ id: d.trade_id, dir: 'incoming', city: d.from_city && d.from_city.name, give: d.give, take: d.take, status: 'pending' });
        renderTrades();
        log('trade.incoming seq=' + m.seq + ' from=' + (d.from_city && d.from_city.name) + ' id=' + d.trade_id.slice(0, 8));
        return;
      }
      if (m.type === 'trade.resolved') {
        S.trades.forEach(function (t) { if (t.id === d.trade_id) t.status = d.status; });
        renderTrades();
        log('trade.resolved seq=' + m.seq + ' id=' + d.trade_id.slice(0, 8) + ' status=' + d.status + ' with=' + (d.with_city && d.with_city.name));
        reloadMyCity();
        return;
      }
      log(m.type + ' seq=' + m.seq + ' ' + JSON.stringify(d));
    };
  }
  connect();
})();
</script>
</body>
</html>`;
}

export async function ssrRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const q = req.query as { city?: string };
    const season = await pool.query<{ id: string; current_day: number; season_no: number }>(
      `SELECT id::text AS id, current_day, season_no FROM seasons WHERE status = 'active' ORDER BY season_no LIMIT 1`,
    );
    if (season.rowCount === 0) {
      return reply
        .type('text/html')
        .send('<!doctype html><meta charset="utf-8"><title>光明顶</title><p>暂无 active 赛季</p>');
    }
    const { id: seasonId, current_day, season_no } = season.rows[0]!;
    const cities = await pool.query<CityRow>(
      `SELECT id::text AS id, name, population::float8 AS population, happiness::float8 AS happiness,
              reputation::float8 AS reputation, resources, version
         FROM cities WHERE season_id = $1 ORDER BY name`,
      [seasonId],
    );
    const wanted = typeof q.city === 'string' ? q.city : null;
    const myCity = wanted && cities.rows.some((c) => c.id === wanted) ? wanted : null;
    return reply.type('text/html').send(
      renderIndex({ currentDay: current_day, seasonNo: season_no, seasonId, cities: cities.rows, myCity }),
    );
  });
}
