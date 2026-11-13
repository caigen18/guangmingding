// M8 互通实测：两个独立 WS 客户端（各自订阅一座城），跑真结算 + 真交易，打印全部收发。
import WebSocket from 'ws'; // ws 8.23 的 CJS 导出就是类本身，没有 .WebSocket 属性
import pg from 'pg';
const { Pool } = pg;
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3003';
const log = [];
function rec(line) {
  const t = new Date().toISOString().slice(11, 23);
  const s = `[${t}] ${line}`;
  log.push(s);
  console.log(s);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { rows: cities } = await pool.query(
  `SELECT c.id, c.name FROM cities c JOIN seasons s ON s.id = c.season_id ORDER BY c.name LIMIT 2`,
);
const { rows: seasonRows } = await pool.query(`SELECT id, current_day FROM seasons ORDER BY id DESC LIMIT 1`);
const season = seasonRows[0];
rec(`db: season=${season.id} day=${season.current_day} cityA=${cities[0].name}(${cities[0].id}) cityB=${cities[1].name}(${cities[1].id})`);

const received = [];
function connect(label, cityId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:3003/ws?city=${cityId}&season=${season.id}`);
    ws.on('open', () => rec(`${label}: ws open (subscribed city=${cityId})`));
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      received.push({ label, type: msg.type, cityId, data: msg.data });
      const brief = JSON.stringify(msg.data).slice(0, 220);
      rec(`${label} <= ${msg.type} seq=${msg.seq} ${brief}`);
    });
    ws.on('error', reject);
    ws.on('open', () => setTimeout(() => resolve(ws), 300));
  });
}

const wsA = await connect('A', cities[0].id);
const wsB = await connect('B', cities[1].id);

// 1) 真结算一天（POST /admin/settle，Basic Auth）
const auth = 'Basic ' + Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASS}`).toString('base64');
rec('A -> HTTP POST /admin/settle');
const settleRes = await fetch(`${BASE}/admin/settle`, { method: 'POST', headers: { authorization: auth } });
const settleBody = await settleRes.json();
rec(`settle: HTTP ${settleRes.status} day=${settleBody.day} citiesSettled=${settleBody.citiesSettled} durationMs=${settleBody.durationMs}`);
await new Promise((r) => setTimeout(r, 500));

// 2) A 向 B 发起交易 → B 收 trade.incoming
const tradeReq = {
  from_city_id: cities[0].id,
  to_city_id: cities[1].id,
  give: [{ good: 'grain', amount: 5 }],
  take: [{ good: 'wood', amount: 3 }],
};
rec(`A -> HTTP POST /api/trades ${JSON.stringify(tradeReq)}`);
const tRes = await fetch(`${BASE}/api/trades`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(tradeReq),
});
const tBody = await tRes.json();
rec(`trades: HTTP ${tRes.status} ${JSON.stringify(tBody)}`);
await new Promise((r) => setTimeout(r, 300));

// 3) B 接受 → 双方收 trade.resolved
rec(`B -> HTTP POST /api/trades/${tBody.trade_id}/accept`);
const aRes = await fetch(`${BASE}/api/trades/${tBody.trade_id}/accept`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ city_id: cities[1].id }),
});
rec(`accept: HTTP ${aRes.status} ${JSON.stringify(await aRes.json())}`);
await new Promise((r) => setTimeout(r, 500));

wsA.close();
wsB.close();
await pool.end();

// 汇总：每个事件谁收到了
const byType = {};
for (const r of received) (byType[r.type] ??= new Set()).add(r.label);
rec('---- 汇总（事件 -> 收到的客户端）----');
for (const [type, set] of Object.entries(byType)) rec(`${type}: ${[...set].sort().join(',')}`);
const outPath = process.env.LOG_PATH ?? 'out/m8-two-clients.log';
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, log.join('\n') + '\n');
console.log(`\nlog written: ${outPath} (${log.length} lines)`);
