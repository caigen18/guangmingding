import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';

interface CityRow {
  id: string;
  name: string;
  population: number;
  happiness: number;
  resources: Record<string, number> | null;
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
        '<tr data-city="' + esc(c.id) + '">' +
        '<td class="nm">' + esc(c.name) + '</td>' +
        '<td class="pop">' + Math.round(num(c.population)) + '</td>' +
        '<td class="hap">' + Math.round(num(c.happiness)) + '</td>' +
        '<td class="grain">' + num(r.grain) + '</td>' +
        '<td class="wood">' + num(r.wood) + '</td>' +
        '<td class="stone">' + num(r.stone) + '</td>' +
        '<td class="iron">' + num(r.iron) + '</td>' +
        '<td class="cloth">' + num(r.cloth) + '</td>' +
        '</tr>'
      );
    })
    .join('');
}

function renderIndex(currentDay: number, rowsHtml: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>光明顶 · 第 ${currentDay} 日</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 14px; max-width: 640px; margin-inline: auto; }
  h1 { font-size: 18px; margin: 4px 0 2px; }
  .sub { color: #888; font-size: 12px; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: right; padding: 5px 6px; border-bottom: 1px solid rgba(128,128,128,.2); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #888; font-weight: 500; }
  #log { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; background: rgba(128,128,128,.08); border-radius: 8px; padding: 8px; margin-top: 12px; max-height: 40vh; overflow: auto; white-space: pre-wrap; }
  .st { color: #3c8; }
</style>
</head>
<body>
<h1>光明顶</h1>
<div class="sub">第 ${currentDay} 日 · <span id="conn" style="color:#c84">连接中…</span></div>
<table>
<thead><tr><th>城市</th><th>人口</th><th>幸福</th><th>粮</th><th>木</th><th>石</th><th>铁</th><th>布</th></tr></thead>
<tbody>${rowsHtml}</tbody>
</table>
<div id="log"></div>
<script>
(function () {
  var logEl = document.getElementById('log');
  var connEl = document.getElementById('conn');
  function log(line, cls) {
    var d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + line;
    logEl.appendChild(d);
    while (logEl.childElementCount > 200) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setCell(tr, sel, v) {
    var el = tr.querySelector(sel);
    if (el) el.textContent = v;
  }
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    var ws = new WebSocket(proto + '://' + location.host + '/ws');
    ws.onopen = function () { connEl.textContent = '已连接'; connEl.style.color = '#3c8'; log('connected', 'st'); };
    ws.onclose = function () { connEl.textContent = '已断开'; connEl.style.color = '#c84'; setTimeout(connect, 2000); };
    ws.onerror = function () { ws.close(); };
    ws.onmessage = function (ev) {
      var m = JSON.parse(ev.data);
      log(m.type + ' ' + JSON.stringify(m.data));
      if (m.type === 'city.updated' && m.data && m.data.city_id) {
        var tr = document.querySelector('tr[data-city="' + m.data.city_id + '"]');
        if (tr) {
          setCell(tr, '.pop', Math.round(m.data.population));
          setCell(tr, '.hap', Math.round(m.data.happiness));
          if (m.data.resources) {
            setCell(tr, '.grain', m.data.resources.grain);
            setCell(tr, '.wood', m.data.resources.wood);
            setCell(tr, '.stone', m.data.resources.stone);
            setCell(tr, '.iron', m.data.resources.iron);
            setCell(tr, '.cloth', m.data.resources.cloth);
          }
        }
      }
      if (m.type === 'day.settled') {
        var sub = document.querySelector('.sub');
        if (sub) sub.textContent = '第 ' + m.data.day + ' 日结算完成 · ' + connEl.textContent;
      }
    };
  }
  connect();
})();
</script>
</body>
</html>`;
}

export async function ssrRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (_req, reply) => {
    const season = await pool.query<{ id: string; current_day: number }>(
      `SELECT id::text AS id, current_day FROM seasons WHERE status = 'active' ORDER BY season_no LIMIT 1`,
    );
    if (season.rowCount === 0) {
      return reply
        .type('text/html')
        .send('<!doctype html><meta charset="utf-8"><title>光明顶</title><p>暂无 active 赛季</p>');
    }
    const { id: seasonId, current_day } = season.rows[0]!;
    const cities = await pool.query<CityRow>(
      `SELECT id::text AS id, name, population::float8 AS population, happiness::float8 AS happiness, resources
         FROM cities WHERE season_id = $1 ORDER BY name`,
      [seasonId],
    );
    return reply.type('text/html').send(renderIndex(current_day, cityRows(cities.rows)));
  });
}
