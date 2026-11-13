#!/usr/bin/env python3
# 精确修补 ssr.ts：SEV_ZH 对齐、单选、结合库内 choice_key、提交落库、提交后禁用
import io

p = 'src/routes/ssr.ts'
s = io.open(p, encoding='utf-8').read()

def rep(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit('anchor not unique (%d): %s' % (n, label))
    s = s.replace(old, new, 1)
    print('patched:', label)

# 1) SEV_ZH：兼容低/中/高（强度）与机遇/代价/危机（#4 kind）
rep(
    'var SEV_ZH = {opportunity:"机遇",cost:"代价",crisis:"危机"};',
    'var SEV_ZH = {opportunity:"机遇",cost:"代价",crisis:"危机", low:"轻", normal:"中", high:"重"};',
    'SEV_ZH',
)

# 2) renderEvents：选中态优先取库里的 choice_key（断线重连后由 /api/state 恢复）
rep(
    '    var choices = (ev.choices || []).map(function(c){\n'
    '      var key = c.choice_key || c.key || "";\n'
    '      var sel = S.selection[ev.id] === key ? " sel" : "";\n'
    '      var ef = effectsHtml(c.effects || {});\n'
    '      return \'<label class="choice\'+sel+\'"><input type="radio" name="ev_\'+ev.id+\'" value="\'+key+\'"\'\n'
    '        + (S.selection[ev.id]===key ? " checked":"") + \' data-ev="\'+ev.id+\'" data-key="\'+key+\'" />\'\n'
    '        + \'<span><span class="cl">\'+esc(String(c.label||c.title||key))+\'</span><span class="ef">\'+ef+\'</span></span></label>\';\n'
    '    }).join("");',
    '    var chosenKey = ev.choice_key || S.selection[ev.id] || "";\n'
    '    var choices = (ev.choices || []).map(function(c){\n'
    '      var key = c.choice_key || c.key || "";\n'
    '      var sel = chosenKey === key ? " sel" : "";\n'
    '      var ef = effectsHtml(c.effects || {});\n'
    '      return \'<label class="choice\'+sel+\'"><input type="radio" name="ev_\'+ev.id+\'" value="\'+key+\'"\'\n'
    '        + (chosenKey===key ? " checked":"") + (S.submitted ? " disabled":"") + \' data-ev="\'+ev.id+\'" data-key="\'+key+\'" />\'\n'
    '        + \'<span><span class="cl">\'+esc(String(c.label||c.title||key))+\'</span><span class="ef">\'+ef+\'</span></span></label>\';\n'
    '    }).join("");',
    'renderEvents chosenKey',
)

# 3) 选卡改单选：一次只保留一张卡的选择；已提交后锁死
rep(
    'el("events").addEventListener("change", function(e){\n'
    '  var t = e.target;\n'
    '  if(t && t.getAttribute("data-ev")){\n'
    '    S.selection[t.getAttribute("data-ev")] = t.getAttribute("data-key");\n'
    '    persist(); renderEvents(); renderDraft();\n'
    '  }\n'
    '});',
    'el("events").addEventListener("change", function(e){\n'
    '  var t = e.target;\n'
    '  if(t && t.getAttribute("data-ev") && !S.submitted){\n'
    '    S.selection = {};  // 一日一卡（单选），换卡即清空旧选择\n'
    '    S.selection[t.getAttribute("data-ev")] = t.getAttribute("data-key");\n'
    '    persist(); renderEvents(); renderDraft();\n'
    '  }\n'
    '});',
    'radio single-select',
)

# 4) submitBtn：真正 POST /api/choose 落库，成功后重拉以库为准
rep(
    'el("submitBtn").addEventListener("click", function(){\n'
    '  S.submitted = true; persist(); renderDraft();\n'
    '});',
    'el("submitBtn").addEventListener("click", function(){\n'
    '  var ceIds = Object.keys(S.selection);\n'
    '  if(!ceIds.length || S.submitted){ return; }\n'
    '  var btn = el("submitBtn"); btn.disabled = true; btn.textContent = "提交中…";\n'
    '  var posts = ceIds.map(function(ceId){\n'
    '    return fetch("/api/choose", {\n'
    '      method:"POST", headers:{"content-type":"application/json"},\n'
    '      body: JSON.stringify({city_event_id: ceId, choice_key: S.selection[ceId]})\n'
    '    }).then(function(r){ if(!r.ok){ throw new Error("choose " + r.status); } });\n'
    '  });\n'
    '  Promise.all(posts).then(function(){\n'
    '    S.submitted = true; persist(); renderDraft(); refetch();\n'
    '  }).catch(function(){\n'
    '    btn.disabled = false; btn.textContent = "提交当日选择";\n'
    '    connState(false, "提交失败，请重试");\n'
    '  });\n'
    '});',
    'submitBtn POST',
)

io.open(p, 'w', encoding='utf-8').write(s)
print('ssr.ts patched OK')
