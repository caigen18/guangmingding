import type { FastifyInstance } from 'fastify';
import { loadState, type GameState } from './api.js';

/**
 * SSR 首页：移动优先 + 折叠屏自适应（#11 与 #12 同一套 H5）。
 * 服务端只渲染壳 + 内联初始状态 JSON，交互与重排全部由原生 JS 完成，无框架、无构建链。
 * 断点：320（最小外屏）/ 600（双列·近方内屏）/ 800 / 1000（三折叠全展开·平板·桌面）。
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderShell(state: GameState): string {
  const initial = JSON.stringify(state).replace(/</g, '\\u003c');
  const citiesOpts = state.cities
    .map((c) => `<option value="${esc(c.id)}"${c.id === state.me.id ? ' selected' : ''}>${esc(c.name)}</option>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#b78a4f" />
<title>光明顶 · ${esc(state.me.name)}</title>
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="icon" href="/icon.svg" type="image/svg+xml" />
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<style>
:root{
  --bg:#0f1115; --bg2:#171a21; --bg3:#1f242e; --line:#2a3140;
  --fg:#e8e6df; --muted:#9aa3b2; --accent:#b78a4f; --accent2:#7fae6a;
  --danger:#c0392b; --good:#7fae6a; --bad:#d1654f;
  --pad:12px; --r:10px;
  --safe-top:env(safe-area-inset-top,0px);
  --safe-bottom:env(safe-area-inset-bottom,0px);
  --safe-left:env(safe-area-inset-left,0px);
  --safe-right:env(safe-area-inset-right,0px);
  --topbar-h:48px;
  --measure:72ch;
  color-scheme: dark;
}
*{box-sizing:border-box}
html{background:var(--bg)}
html,body{margin:0;overflow-x:clip}
body{
  background:var(--bg); color:var(--fg);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  font-size:15px; line-height:1.5;
  padding-top:calc(var(--safe-top) + var(--topbar-h));
  padding-left:var(--safe-left); padding-right:var(--safe-right);
  min-height:100svh; min-height:100vh;
  min-height:var(--vvh,100vh);
  display:flex; flex-direction:column;
}
.num{font-variant-numeric:tabular-nums; font-feature-settings:"tnum"}
h1,h2,h3{margin:0; font-weight:650; letter-spacing:.02em}
a{color:var(--accent)}
button,input,select{font:inherit; color:var(--fg)}

/* ---- 顶栏（挖孔/前摄避让：padding-top 由 --safe-top 承担） ---- */
.topbar{
  position:fixed; top:0; left:0; right:0; z-index:40;
  height:calc(var(--safe-top) + var(--topbar-h));
  padding:var(--safe-top) var(--pad) 0;
  display:flex; align-items:center; gap:10px;
  background:linear-gradient(180deg, var(--bg3), var(--bg2));
  border-bottom:1px solid var(--line);
}
.topbar h1{font-size:18px; color:var(--accent)}
.topbar .day{font-size:13px; color:var(--muted)}
.topbar .day b{color:var(--fg); font-size:16px}
.topbar .conn{margin-left:auto; font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px}
.dot{width:8px; height:8px; border-radius:50%; background:var(--muted)}
.dot.on{background:var(--good)} .dot.off{background:var(--bad)}
.topbar select{
  background:var(--bg3); border:1px solid var(--line); border-radius:8px;
  padding:6px 8px; max-width:120px;
}

main{width:100%; max-width:1400px; margin:0 auto; padding:var(--pad); display:flex; flex-direction:column; gap:12px; flex:1}

/* ---- 当日关键数字：任何形态都在首屏顶部 ---- */
.keynums{
  display:grid; gap:8px; grid-template-columns:repeat(3,1fr);
}
@media(min-width:600px){ .keynums{ grid-template-columns:repeat(6,1fr) } }
.stat{
  background:var(--bg2); border:1px solid var(--line); border-radius:var(--r);
  padding:9px 10px; display:flex; flex-direction:column; gap:2px; min-width:0;
}
.stat .k{font-size:11px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.stat .v{font-size:19px; font-weight:700}
.stat .v.pos{color:var(--good)} .stat .v.neg{color:var(--bad)}

/* ---- 布局骨架：单列 → 双列 → 三列 ---- */
.layout{display:grid; gap:12px; grid-template-columns:1fr}
@media(min-width:600px){
  .layout{
    grid-template-columns:minmax(240px,.9fr) minmax(300px,1.1fr);
    grid-template-areas:
      "ledger events"
      "ledger actions"
      "side   actions";
    align-items:start;
  }
  .ledger{grid-area:ledger}
  .events{grid-area:events}
  .actions{grid-area:actions}
  .side{grid-area:side;min-width:0}
}
@media(min-width:1000px){
  .layout{
    grid-template-columns:minmax(250px,1fr) minmax(320px,1.1fr) minmax(250px,.9fr);
    grid-template-areas:
      "ledger events side"
      "ledger actions side";
  }
}

.panel{
  background:var(--bg2); border:1px solid var(--line); border-radius:var(--r);
  padding:12px; min-width:0;
}
.panel h2{font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:.08em; margin-bottom:10px; display:flex; align-items:center; gap:8px}
.panel h2 .tag{margin-left:auto; font-size:11px; color:var(--accent); text-transform:none}

/* ---- 总账 / 资源 ---- */
.resgrid{display:grid; grid-template-columns:repeat(2,1fr); gap:8px}
.res{display:flex; flex-direction:column; background:var(--bg3); border:1px solid var(--line); border-radius:8px; padding:8px 10px; min-width:0}
.res .rk{font-size:12px; color:var(--muted)}
.res .rv{font-size:17px; font-weight:650}
.res .rv .u{font-size:11px; color:var(--muted); font-weight:400}
.inv{margin-top:10px; padding:9px 10px; background:var(--bg3); border:1px solid var(--line); border-radius:8px; font-size:13px; color:var(--muted)}
.inv b{color:var(--accent); font-size:16px}
.builds{margin-top:8px; display:flex; flex-wrap:wrap; gap:6px}
.b{font-size:12px; color:var(--muted); background:var(--bg3); border:1px solid var(--line); border-radius:999px; padding:3px 9px}

/* ---- 事件卡 ---- */
.cards{display:flex; flex-direction:column; gap:10px}
.card{background:var(--bg3); border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:var(--r); padding:12px; min-width:0}
.card .head{display:flex; align-items:center; gap:8px; margin-bottom:6px}
.card .sev{font-size:11px; padding:2px 8px; border-radius:999px; background:var(--bg2); border:1px solid var(--line)}
.card .sev.opportunity{color:var(--good); border-color:var(--good)}
.card .sev.cost{color:var(--bad); border-color:var(--bad)}
.card .sev.crisis{color:#e6b84f; border-color:#e6b84f}
.card h3{font-size:16px; flex:1}
.card .body{font-size:13.5px; color:var(--muted); margin-bottom:10px; max-width:var(--measure)}
.choices{display:flex; flex-direction:column; gap:6px}
.choice{
  display:flex; gap:8px; align-items:flex-start; padding:8px 10px;
  background:var(--bg2); border:1px solid var(--line); border-radius:8px; cursor:pointer;
}
.choice:hover{border-color:var(--accent)}
.choice.sel{border-color:var(--accent); background:color-mix(in srgb, var(--accent) 14%, var(--bg2))}
.choice input{margin-top:3px; accent-color:var(--accent)}
.choice .cl{font-size:14px; font-weight:600}
.choice .ef{font-size:12px; color:var(--muted); margin-top:2px}
.choice .ef .up{color:var(--good)} .choice .ef .dn{color:var(--bad)}
.empty{color:var(--muted); font-size:13px; padding:12px 0; text-align:center}

/* ---- 操作 / 下单 ---- */
.ops{display:flex; flex-direction:column; gap:10px}
.tradeform{display:grid; grid-template-columns:1fr 1fr; gap:8px}
.tradeform label{font-size:12px; color:var(--muted); display:flex; flex-direction:column; gap:4px}
.tradeform select,.tradeform input{
  background:var(--bg3); border:1px solid var(--line); border-radius:8px; padding:9px 10px; width:100%;
}
.draft{margin-top:8px; font-size:13px; color:var(--muted); min-height:18px}
.draft b{color:var(--fg)}
.btn{
  width:100%; border:0; border-radius:10px; padding:12px; font-size:15px; font-weight:700;
  background:var(--accent); color:#141210; cursor:pointer;
}
.btn:active{opacity:.85}
.btn:disabled{opacity:.4; cursor:default}
.btn.ghost{background:var(--bg3); color:var(--fg); border:1px solid var(--line)}

/* ---- 榜单 / 日志（窄屏折叠，宽屏右栏） ---- */
details.panel summary{cursor:pointer; list-style:none; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:.08em; display:flex; align-items:center; gap:8px}
details.panel summary::after{content:"▾"; margin-left:auto; transition:transform .15s}
details.panel[open] summary::after{transform:rotate(180deg)}
details.panel{padding:10px 12px}
details.panel summary{margin:-10px -12px; padding:10px 12px}
details.panel .inner{padding-top:10px}
.lbrow{display:grid; grid-template-columns:26px 1fr auto; gap:8px; padding:6px 0; border-bottom:1px solid var(--line); font-size:13px; align-items:baseline}
.lbrow:last-child{border-bottom:0}
.lbrow .rk{color:var(--muted)}
.lbrow.me{color:var(--accent); font-weight:700}
.lbrow .sc{font-variant-numeric:tabular-nums; color:var(--muted); font-size:12px}
.logline{font-size:13px; color:var(--muted); padding:6px 0; border-bottom:1px solid var(--line)}
.logline:last-child{border-bottom:0}
.logline .d{color:var(--accent); font-variant-numeric:tabular-nums; margin-right:6px}

/* ---- 底部操作条（手势条避让 --safe-bottom） ---- */
.actionbar{
  position:sticky; bottom:0; z-index:30; width:100%; max-width:1400px; margin:0 auto;
  padding:10px var(--pad) calc(10px + var(--safe-bottom));
  background:linear-gradient(0deg, var(--bg2), color-mix(in srgb, var(--bg2) 86%, transparent));
}
.actionbar .row{display:flex; gap:8px; align-items:center}
.actionbar .pending{font-size:13px; color:var(--muted); white-space:nowrap}
.actionbar .pending b{color:var(--accent)}
.actionbar .btn{width:auto; flex:1}

/* 大屏行宽收敛：正文不超过 72 字符，靠断点重排而非拉伸 */
@media(min-width:1000px){
  body{font-size:16px}
  .card .body,.panel p{max-width:var(--measure)}
  .logline,.lbrow{max-width:var(--measure)}
}
@media(min-width:800px) and (max-width:999px){
  .stat .v{font-size:20px}
}
@media(max-width:599px){
  .resgrid{grid-template-columns:repeat(3,1fr)}
  .tradeform{grid-template-columns:1fr 1fr}
}
@media(max-width:359px){
  .keynums{grid-template-columns:repeat(2,1fr)}
  .resgrid{grid-template-columns:repeat(2,1fr)}
}
</style>
</head>
<body>
<header class="topbar">
  <h1>光明顶</h1>
  <div class="day">第 <b id="dayNum" class="num">${state.season.day}</b> 日</div>
  <select id="cityPicker" aria-label="选择城市">${citiesOpts}</select>
  <div class="conn"><span class="dot off" id="connDot"></span><span id="connTxt">连接中…</span></div>
</header>

<main>
  <section class="keynums" id="keynums" aria-label="当日关键数字"></section>

  <div class="layout">
    <section class="panel ledger" id="ledgerPanel" aria-label="总账与资源">
      <h2>总账 · <span id="cityName">${esc(state.me.name)}</span> <span class="tag" id="playerName">${esc(state.me.player)}</span></h2>
      <div class="resgrid" id="resources"></div>
      <div class="inv" id="inventory"></div>
      <div class="builds" id="builds"></div>
    </section>

    <section class="panel events" id="eventsPanel" aria-label="本日事件">
      <h2>本日事件 <span class="tag" id="evCount"></span></h2>
      <div class="cards" id="events"></div>
    </section>

    <section class="panel actions" id="actionsPanel" aria-label="操作">
      <h2>操作 · 下单</h2>
      <div class="ops">
        <div class="tradeform">
          <label>商品
            <select id="trGood">
              <option value="grain">粮</option><option value="wood">木</option>
              <option value="stone">石</option><option value="iron">铁</option>
              <option value="cloth">布</option>
            </select>
          </label>
          <label>数量<input id="trQty" type="number" min="1" value="10" inputmode="numeric" /></label>
          <label>单价<input id="trPrice" type="number" min="0" step="0.01" placeholder="随行就市" inputmode="decimal" /></label>
          <label>方向
            <select id="trDir"><option value="sell">卖出</option><option value="buy">买入</option></select>
          </label>
        </div>
        <button class="btn ghost" id="trAdd" type="button">加入待提交</button>
        <div class="draft" id="draft"></div>
      </div>
    </section>

    <aside class="side" aria-label="榜单与日志">
      <details class="panel" id="lbDetail">
        <summary>榜单</summary>
        <div class="inner" id="leaderboard"></div>
      </details>
      <details class="panel" id="logDetail">
        <summary>日志</summary>
        <div class="inner" id="logs"></div>
      </details>
    </aside>
  </div>
</main>

<footer class="actionbar">
  <div class="row">
    <span class="pending" id="pending">尚未选择</span>
    <button class="btn" id="submitBtn" type="button">提交当日选择</button>
  </div>
</footer>

<script>
(function(){
"use strict";
var INIT = ${initial};
var GOODS = ["grain","wood","stone","iron","cloth"];
var GOOD_ZH = {grain:"粮",wood:"木",stone:"石",iron:"铁",cloth:"布"};
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
var SEV_ZH = {opportunity:"机遇",cost:"代价",crisis:"危机", low:"轻", normal:"中", high:"重"};

/* ---- 内存状态：折叠/旋转只改布局，绝不清空 ---- */
var S = {
  state: INIT,
  ws: null,
  retry: 0,
  selection: {},          // { city_event_id: choice_key } 未提交的选卡
  submitted: false,
  trades: [],             // 待提交订单 {good,dir,qty,price}
  connected: false
};

/* 断网/刷新也不丢：当日未提交选择 + 订单落 localStorage */
var LS_KEY = "gmd:draft:" + INIT.season.season_no + ":" + INIT.me.id;
try {
  var saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
  if (saved) { S.selection = saved.selection || {}; S.trades = saved.trades || []; S.submitted = !!saved.submitted; }
} catch (e) {}
function persist(){
  try { localStorage.setItem(LS_KEY, JSON.stringify({selection:S.selection, trades:S.trades, submitted:S.submitted})); } catch (e) {}
}

/* ================= 渲染 ================= */
var el = function(id){ return document.getElementById(id); };
function fmt(n){ return (Math.round(n*100)/100).toLocaleString("zh-CN"); }
function deltaCls(d){ return d > 0 ? "pos" : d < 0 ? "neg" : ""; }

function renderKeynums(){
  var m = S.state.me, d = S.state.season.day;
  var items = [
    ["银", m.resources.silver, "两"],
    ["粮", m.resources.grain, "石"],
    ["人口", m.population, ""],
    ["民心", m.happiness, ""],
    ["声望", m.reputation, ""],
    ["家底", m.inventoryValue, "两"]
  ];
  el("keynums").innerHTML = items.map(function(x){
    return '<div class="stat"><span class="k">'+x[0]+'</span><span class="v num">'+fmt(x[1])+x[2]+'</span></div>';
  }).join("");
  el("dayNum").textContent = d;
  el("cityName").textContent = m.name;
  el("playerName").textContent = m.player;
}

function renderResources(){
  var m = S.state.me, out = "";
  out += '<div class="res"><span class="rk">银两</span><span class="rv num">'+fmt(m.resources.silver)+'</span></div>';
  GOODS.forEach(function(g){
    out += '<div class="res"><span class="rk">'+GOOD_ZH[g]+'</span><span class="rv num">'+fmt(m.resources[g])+'</span></div>';
  });
  el("resources").innerHTML = out;
  el("inventory").innerHTML = '家底估值 <b class="num">'+fmt(m.inventoryValue)+'</b> 两（按最近行情）';
}

function renderEvents(){
  var evs = S.state.events;
  el("evCount").textContent = evs.length ? evs.length + " 件待办" : "无待办";
  if(!evs.length){ el("events").innerHTML = '<div class="empty">今日事件已处理完毕</div>'; return; }
  el("events").innerHTML = evs.map(function(ev){
    var sev = ev.severity || "opportunity";
    var chosenKey = ev.choice_key || S.selection[ev.id] || "";
    var choices = (ev.choices || []).map(function(c){
      var key = c.choice_key || c.key || "";
      var sel = chosenKey === key ? " sel" : "";
      var ef = effectsHtml(c.effects || {});
      return '<label class="choice'+sel+'"><input type="radio" name="ev_'+ev.id+'" value="'+key+'"'
        + (chosenKey===key ? " checked":"") + (S.submitted ? " disabled":"") + ' data-ev="'+ev.id+'" data-key="'+key+'" />'
        + '<span><span class="cl">'+esc(String(c.label||c.title||key))+'</span><span class="ef">'+ef+'</span></span></label>';
    }).join("");
    return '<article class="card"><div class="head"><span class="sev '+sev+'">'+(SEV_ZH[sev]||sev)+'</span><h3>'+esc(ev.title)+'</h3></div>'
      + '<p class="body">'+esc(ev.body||"")+'</p><div class="choices">'+choices+'</div></article>';
  }).join("");
}

function effectsHtml(ef){
  var bits = [];
  var r = ef.resources || {};
  Object.keys(r).forEach(function(g){ var v = r[g]; bits.push('<span class="'+(v>=0?'up':'dn')+'">'+(v>0?"+":"")+v+' '+GOOD_ZH[g]+'</span>'); });
  if(typeof ef.happiness === "number" && ef.happiness) bits.push('<span class="'+(ef.happiness>0?'up':'dn')+'">'+(ef.happiness>0?"+":"")+ef.happiness+' 民心</span>');
  if(typeof ef.population === "number" && ef.population) bits.push('<span class="'+(ef.population>0?'up':'dn')+'">'+(ef.population>0?"+":"")+ef.population+' 人口</span>');
  if(typeof ef.reputation === "number" && ef.reputation) bits.push('<span class="'+(ef.reputation>0?'up':'dn')+'">'+(ef.reputation>0?"+":"")+ef.reputation+' 声望</span>');
  return bits.join(" · ") || "无增减";
}

function renderLeaderboard(){
  var lb = S.state.leaderboard;
  el("leaderboard").innerHTML = lb.map(function(r){
    var me = r.id === S.state.me.id ? " me" : "";
    return '<div class="lbrow'+me+'"><span class="rk num">'+r.rank+'</span><span>'+esc(r.name)+'</span>'
      + '<span class="sc num">望 '+fmt(r.reputation)+' · 银 '+fmt(r.silver)+'</span></div>';
  }).join("");
}

function renderLogs(){
  var logs = S.state.logs || [];
  el("logs").innerHTML = logs.length
    ? logs.map(function(l){ return '<div class="logline"><span class="d num">D'+l.day+'</span>'+esc(l.line)+'</div>'; }).join("")
    : '<div class="empty">尚无结算记录</div>';
}

function renderDraft(){
  var n = Object.keys(S.selection).length;
  var t = S.trades.length;
  var txt = (n? n+" 张卡已选":"尚未选卡") + (t? " · "+t+" 笔订单":"");
  el("pending").innerHTML = S.submitted ? "已提交 · 第 "+S.state.season.day+" 日" : txt;
  el("submitBtn").disabled = S.submitted;
  var draft = S.trades.map(function(tr){
    return GOOD_ZH[tr.good]+" "+(tr.dir==="sell"?"卖":"买")+" "+tr.qty+" @"+(tr.price||"市价");
  }).join("；");
  el("draft").innerHTML = S.trades.length ? "待提交：<b>"+draft+"</b>" : "";
}

function renderAll(){ renderKeynums(); renderResources(); renderEvents(); renderLeaderboard(); renderLogs(); renderDraft(); }

/* ================= 事件绑定（选卡 / 下单不依赖网络） ================= */
el("events").addEventListener("change", function(e){
  var t = e.target;
  if(t && t.getAttribute("data-ev") && !S.submitted){
    S.selection = {};  // 一日一卡（单选），换卡即清空旧选择
    S.selection[t.getAttribute("data-ev")] = t.getAttribute("data-key");
    persist(); renderEvents(); renderDraft();
  }
});

el("trAdd").addEventListener("click", function(){
  var good = el("trGood").value, qty = parseInt(el("trQty").value,10)||0;
  var price = el("trPrice").value ? parseFloat(el("trPrice").value) : null;
  var dir = el("trDir").value;
  if(qty<=0){ return; }
  S.trades.push({good:good, dir:dir, qty:qty, price:price});
  persist(); renderDraft();
  el("trQty").value = ""; el("trPrice").value = "";
});

el("submitBtn").addEventListener("click", function(){
  var ceIds = Object.keys(S.selection);
  if(!ceIds.length || S.submitted){ return; }
  var btn = el("submitBtn"); btn.disabled = true; btn.textContent = "提交中…";
  var posts = ceIds.map(function(ceId){
    return fetch("/api/choose", {
      method:"POST", headers:{"content-type":"application/json"},
      body: JSON.stringify({city_event_id: ceId, choice_key: S.selection[ceId]})
    }).then(function(r){ if(!r.ok){ throw new Error("choose " + r.status); } });
  });
  Promise.all(posts).then(function(){
    S.submitted = true; persist(); renderDraft(); refetch();
  }).catch(function(){
    btn.disabled = false; btn.textContent = "提交当日选择";
    connState(false, "提交失败，请重试");
  });
});

el("cityPicker").addEventListener("change", function(){
  var id = el("cityPicker").value;
  try{ localStorage.setItem("gmd:city", id); }catch(e){}
  location.search = "?city=" + encodeURIComponent(id);
});

/* ================= 视口：折叠/横竖屏只重排，不重载、不丢状态 ================= */
function applyVH(){
  var vv = window.visualViewport;
  var h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--vvh", h + "px");
  var wide = window.matchMedia("(min-width: 1000px)").matches;
  el("lbDetail").open = wide;
  el("logDetail").open = wide;
}
window.addEventListener("resize", applyVH);
window.addEventListener("orientationchange", applyVH);
if(window.visualViewport){
  window.visualViewport.addEventListener("resize", applyVH);
  window.visualViewport.addEventListener("scroll", applyVH);
}

/* ================= WebSocket：6 事件 + 断线重连重拉 ================= */
function connState(on, txt){
  S.connected = on;
  el("connDot").className = "dot " + (on ? "on" : "off");
  el("connTxt").textContent = txt;
}
function connectWS(){
  var proto = location.protocol === "https:" ? "wss" : "ws";
  var ws = new WebSocket(proto + "://" + location.host + "/ws?season=" + S.state.season.season_no + "&city=" + S.state.me.id);
  S.ws = ws;
  ws.onopen = function(){ S.retry = 0; connState(true, "已连接"); };
  ws.onclose = function(){ connState(false, "重连中…"); var d = Math.min(30000, 1000 * Math.pow(2, S.retry++)); setTimeout(connectWS, d); };
  ws.onerror = function(){ ws.close(); };
  ws.onmessage = function(ev){
    var msg; try{ msg = JSON.parse(ev.data); }catch(e){ return; }
    var d = msg.data || {};
    switch(msg.type){
      case "day.settled": S.state.season.day = d.day; refetch(); break;
      case "events.arrived": refetch(); break;
      case "market.tick":
        var row = (S.state.market||[]).filter(function(m){ return m.good === d.good; })[0];
        if(row){ row.price = d.price; row.delta_pct = d.delta_pct; renderKeynums(); renderResources(); }
        else refetch();
        break;
      case "trade.incoming": renderLogs(); break;
      case "trade.resolved": refetch(); break;
      case "city.updated":
        if(d.city_id === S.state.me.id){ refetch(); }
        else { updateBoardRow(d); }
        break;
    }
  };
}
function updateBoardRow(d){
  var lb = S.state.leaderboard;
  for(var i=0;i<lb.length;i++){ if(lb[i].id === d.city_id){ lb[i].reputation = d.reputation; lb[i].silver = d.silver; } }
  renderLeaderboard();
}
function refetch(){
  fetch("/api/state?city=" + encodeURIComponent(S.state.me.id))
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(j){
      if(!j) return;
      j = j; /* 重拉不覆盖用户未提交选择/订单 */
      S.state = j;
      renderAll();
    }).catch(function(){});
}

/* ================= 启动 ================= */
renderAll();
applyVH();
connectWS();
if("serviceWorker" in navigator){ navigator.serviceWorker.register("/sw.js").catch(function(){}); }
})();
</script>
</body>
</html>`;
}

export async function ssrRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (_req, reply) => {
    try {
      const state = await loadState((_req.query as Record<string, string | undefined>).city);
      return reply.type('text/html').send(renderShell(state));
    } catch (err) {
      return reply
        .type('text/html')
        .send(`<!doctype html><meta charset="utf-8"><title>光明顶</title><body style="background:#0f1115;color:#e8e6df;font-family:system-ui;padding:24px"><h1>光明顶</h1><p>尚无可用赛季数据：${esc(String((err as Error).message ?? err))}</p><p>请先执行 migrate + seed。</p></body>`);
    }
  });
}
