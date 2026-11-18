'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => (n === '' || n == null || Number.isNaN(Number(n))) ? '' : '\u20B9' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const state = { meta: null, runs: [], run: null, sel: null, suppliers: [], items: [] };

function user() { return ($('#userInput').value || 'anonymous').trim(); }
async function api(path, opts = {}) {
  const headers = { 'x-user': user(), ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) };
  const res = await fetch('/api' + path, { ...opts, headers, body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) { const msg = (data && data.error) || res.statusText; toast(msg, true); const e = new Error(msg); e.data = data; throw e; }
  return data;
}
let toastTimer;
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 7000 : 3500); }
const chip = (route) => `<span class="chip r-${esc(route)}">${esc(String(route).replace(/_/g, ' '))}</span>`;

// ---------- tabs
$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#nav button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + b.dataset.tab));
  ({ work: loadRuns, policy: loadPolicies, suppliers: loadPreferred, contracts: loadContracts, audit: loadAudit }[b.dataset.tab] || (() => {}))();
});
function goTab(name) { $(`#nav button[data-tab=${name}]`).click(); }

// ---------- header
async function loadMeta() {
  state.meta = await api('/meta');
  $('#todayInput').value = state.meta.today;
  $('#policyBadge').textContent = `Policy v${state.meta.active_policy.version}`;
  $('#policyBadge').title = `In force since ${state.meta.active_policy.effective_from}`;
  $('#prefDate').value ||= state.meta.today;
}
$('#userInput').value = localStorage.getItem('user') || 'Priya (Buyer)';
$('#userInput').addEventListener('change', () => localStorage.setItem('user', $('#userInput').value));
$('#todayInput').addEventListener('change', async () => { await api('/settings/today', { method: 'POST', body: { today: $('#todayInput').value } }); await loadMeta(); toast('System date updated'); });

// ---------- chat
const sid = localStorage.getItem('sid') || (localStorage.setItem('sid', 'web-' + Math.random().toString(36).slice(2)), localStorage.getItem('sid'));
function bubble(text, who) { const d = document.createElement('div'); d.className = 'msg ' + who; d.textContent = text; $('#chatlog').append(d); $('#chatlog').scrollTop = 1e9; }
function renderQuick(list) { $('#quick').innerHTML = (list || []).map((q) => `<button type="button">${esc(q)}</button>`).join(''); }
async function say(text) {
  if (!text.trim()) return;
  bubble(text, 'me'); renderQuick([]);
  try {
    const r = await api('/chat', { method: 'POST', body: { session_id: sid, message: text } });
    bubble(r.reply, 'bot'); renderQuick(r.quick);
    if (r.pr) { const l = JSON.parse(localStorage.getItem('myprs') || '[]'); l.unshift(r.pr); localStorage.setItem('myprs', JSON.stringify(l.slice(0, 20))); renderMyPrs(); }
  } catch (e) { bubble('Sorry, something went wrong: ' + e.message, 'bot'); }
}
$('#chatform').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#chatinput').value; $('#chatinput').value = ''; say(v); });
$('#quick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) say(b.textContent); });
function renderMyPrs() {
  const l = JSON.parse(localStorage.getItem('myprs') || '[]');
  $('#myprs').innerHTML = l.length ? l.map((p) => `<div style="margin:6px 0"><b>${esc(p.pr_no)}</b> ${chip(p.route)}<div class="muted small">${inr(p.value)} \u00B7 waiting for buyer</div></div>`).join('') : 'Nothing yet.';
}
bubble('Hi! Tell me what you need, for example: "need 200 nitrile gloves for Chakan by next Friday".', 'bot'); renderMyPrs();

// ---------- buyer workspace
async function loadRuns(selectId) {
  state.runs = await api('/runs');
  const sel = $('#runSelect');
  sel.innerHTML = state.runs.length ? state.runs.map((r) => `<option value="${r.id}">#${r.id} ${esc(r.source === 'chat' ? 'Chat requests' : r.filename || 'batch')} \u00B7 ${r.pending} pending</option>`).join('') : '<option value="">No runs yet</option>';
  if (state.runs.length) { sel.value = selectId || sel.value || state.runs[0].id; await openRun(sel.value); } else { $('#reqTable tbody').innerHTML = '<tr><td colspan="8" class="muted">Upload a PR batch CSV to see decisions. <b>Use the "Upload PR batch CSV" button above.</b></td></tr>'; $('#detail').innerHTML = '<p class="muted">Nothing selected.</p>'; $('#runSummary').innerHTML = ''; $('#runMeta').textContent = ''; }
}
$('#runSelect').addEventListener('change', (e) => openRun(e.target.value));
async function openRun(id) {
  state.run = await api('/runs/' + id);
  const r = state.run;
  $('#runMeta').textContent = `Policy v${r.policy_version || '-'} \u00B7 as of ${r.as_of} \u00B7 ${r.lines.length} lines \u00B7 ${r.requirements.length} requirements`;
  $('#exportRun').href = `/api/runs/${id}/export.csv`;
  const routes = {}; r.requirements.forEach((q) => (routes[q.decision.route] = (routes[q.decision.route] || 0) + 1));
  const np = r.lines.filter((l) => l.route === 'NOT_PROCESSED').length; if (np) routes.NOT_PROCESSED = np;
  $('#runSummary').innerHTML = Object.entries(routes).map(([k, v]) => `${chip(k)} <b>${v}</b>`).join(' &nbsp; ');
  const fr = $('#fRoute'); const cur = fr.value;
  fr.innerHTML = '<option value="">All routes</option>' + Object.keys(routes).filter((k) => k !== 'NOT_PROCESSED').map((k) => `<option>${k}</option>`).join(''); fr.value = cur;
  renderReqs();
  if (state.sel) { const q = r.requirements.find((x) => x.group_id === state.sel); if (q) showDetail(q); }
}
function filtered() {
  const q = $('#reqSearch').value.toLowerCase(), fr = $('#fRoute').value, fs = $('#fStatus').value;
  return state.run.requirements.filter((x) => (!fr || x.decision.route === fr) && (!fs || x.status === fs) &&
    (!q || JSON.stringify([x.item_code, x.item_name, x.lines.map((l) => l.pr_no), x.decision.supplier_id, x.decision.suggested_ids, x.group_id]).toLowerCase().includes(q)));
}
function renderReqs() {
  const rows = filtered();
  $('#reqTable tbody').innerHTML = rows.map((x) => {
    const d = x.decision; const e = x.override;
    const route = e ? e.route : d.route;
    const who = (e ? e.supplier_id : d.supplier_id) ? `<b>${esc(e ? e.supplier_id : d.supplier_id)}</b> @ ${inr(e ? e.unit_price : d.unit_price)}` : esc(((e && e.suggested_ids) || d.suggested_ids || []).join(', ') || '\u2014');
    return `<tr data-g="${esc(x.group_id)}" class="${state.sel === x.group_id ? 'sel' : ''}"><td>${esc(x.group_id)}<div class="muted small">${x.lines.length} line${x.lines.length > 1 ? 's' : ''}${x.emergency ? ' \u00B7 \u26A0 emergency' : ''}</div></td>
      <td>${esc(x.item_name)}<div class="muted small">${esc(x.item_code)}</div></td><td>${esc(x.plant)}</td><td>${esc(x.quantity)} ${esc(x.uom)}</td><td class="r">${inr(d.value)}</td>
      <td>${chip(route)}${e ? ' <span class="warn small">overridden</span>' : ''}</td><td>${who}</td><td class="s-${x.status}">${esc(x.status)}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">No requirements match.</td></tr>';
  const pend = rows.filter((x) => x.status === 'PENDING').length;
  $('#approveAllBtn').textContent = `Approve all shown pending (${pend})`; $('#approveAllBtn').disabled = !pend;
}
['reqSearch', 'fRoute', 'fStatus'].forEach((id) => $('#' + id).addEventListener('input', renderReqs));
$('#reqTable tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-g]'); if (!tr) return;
  state.sel = tr.dataset.g; renderReqs(); showDetail(state.run.requirements.find((x) => x.group_id === state.sel));
});
function showDetail(x) {
  const d = x.decision; const f = x.facts || {};
  const sameOrder = d.po_id ? state.run.requirements.filter((q) => q.group_id !== x.group_id && q.decision.po_id === d.po_id) : [];
  const pref = (x.preferred || []);
  $('#detail').innerHTML = `
    <h3>${esc(x.group_id)} \u00B7 ${esc(x.item_name)} ${chip(x.override ? x.override.route : d.route)}</h3>
    <div class="muted">${esc(x.item_code)} \u00B7 ${esc(x.plant)} \u00B7 requirement date ${esc(x.req_date)} \u00B7 ${esc(x.quantity)} ${esc(x.uom)}</div>
    <div class="why"><b>Why:</b> ${esc(d.reason)}</div>
    <div class="kv"><div>Policy</div><div>v${esc(d.policy_version)} \u00B7 clause ${esc(d.clause)} ${esc(d.rule_name ? '(' + d.rule_name + ')' : '')}</div>
      <div>Requirement value</div><div><b>${inr(d.value)}</b> <span class="muted">(${esc(x.valuation_basis)})</span></div>
      ${d.supplier_id ? `<div>Supplier</div><div><b>${esc(d.supplier_id)}</b> @ ${inr(d.unit_price)}</div>` : ''}
      ${d.po_id ? `<div>PO</div><div>${esc(d.po_id)}${sameOrder.length ? ` \u00B7 shared with ${sameOrder.map((q) => esc(q.group_id)).join(', ')}` : ''}</div>` : ''}
      ${(d.suggested || []).length ? `<div>Suggested</div><div>${d.suggested.map((s) => `${esc(s.supplier_id)} <span class="muted small">(${esc(s.source)})</span>`).join('<br>')}</div>` : ''}
      <div>Relied on</div><div>${esc(d.relied_on || '\u2014')}</div></div>
    <h4>PR lines</h4>
    <table class="mini"><thead><tr><th>PR/line</th><th>Created</th><th>Qty</th><th>Need by</th><th>Urgency</th></tr></thead><tbody>${x.lines.map((l) => `<tr><td>${esc(l.pr_no)}/${esc(l.pr_line)}</td><td>${esc(l.created_at)}</td><td>${esc(l.quantity)}</td><td>${esc(l.need_by_date)}</td><td>${esc(l.urgency)}</td></tr>${(l.notes || []).length ? `<tr><td colspan="5" class="muted small">${esc(l.notes.join('; '))}</td></tr>` : ''}`).join('')}</tbody></table>
    ${(d.contracts_checked || []).length ? `<h4>Contracts checked</h4><table class="mini"><thead><tr><th>Contract</th><th>Rate</th><th class="r">Consumed</th><th class="r">Ceiling</th><th>Usable</th></tr></thead><tbody>${d.contracts_checked.map((c) => `<tr><td>${esc(c.contract_id)} (${esc(c.supplier_id)})</td><td>${esc(c.rate)}</td><td class="r">${inr(c.consumed)}</td><td class="r">${inr(c.cap)}</td><td>${c.usable ? 'yes' : '<span class="err">no, over ceiling</span>'}</td></tr>`).join('')}</tbody></table>` : ''}
    <h4>Rules tried, in order</h4><div class="trace">${(d.trace || []).map((t) => `<span class="${t.matched ? 'hit' : ''}" title="${esc(t.name + ' ' + t.note)}">${esc(t.rule)}${t.matched ? ' \u2713' : ''}</span>`).join('')}</div>
    ${pref.length ? `<h4>Preferred suppliers (top ${pref.length})</h4><table class="mini"><thead><tr><th>#</th><th>Supplier</th><th>POs</th><th>Last PO</th><th>Contract</th><th>On-time</th><th>Qual</th><th>Score</th></tr></thead><tbody>${pref.map((p) => `<tr title="${esc(Object.values(p.breakdown).map((b) => `${b.label}: ${b.points}`).join(' | '))}"><td>${p.rank}</td><td>${esc(p.supplier_id)} ${esc(p.name)}</td><td>${p.po_count}</td><td>${esc(p.last_po_date || '\u2014')}</td><td>${p.has_contract ? 'yes' : 'no'}</td><td>${p.on_time_pct}%</td><td>${p.quality_rating}</td><td>${p.score}</td></tr>`).join('')}</tbody></table>` : ''}
    ${x.status === 'PENDING' ? `<div class="btnrow"><button class="primary" id="btnApprove">${d.decision === 'PO' ? 'Approve and create PO' : 'Approve and create ' + esc(d.route.replace(/_/g, ' '))}</button><button id="btnOverride">Override\u2026</button></div><div id="ovr"></div>` :
      `<div class="why"><b>${esc(x.status)}</b> by ${esc(x.decided_by)} at ${esc(x.decided_at)} \u2192 <b>${esc(x.order_number)}</b>${x.override ? `<br><b>Override reason:</b> ${esc(x.override.comment)}<br><span class="muted">Original: ${esc(x.override.original.route)} ${esc(x.override.original.supplier_id || '')}</span>` : ''}</div>`}`;
  const ab = $('#btnApprove'); if (ab) ab.onclick = async () => { await api(`/runs/${state.run.id}/requirements/${x.group_id}/approve`, { method: 'POST', body: {} }); toast(`${x.group_id} approved`); await openRun(state.run.id); };
  const ob = $('#btnOverride'); if (ob) ob.onclick = () => overrideForm(x);
}
async function overrideForm(x) {
  if (!state.suppliers.length) state.suppliers = (await api('/suppliers')).filter((s) => s.status === 'Active');
  const routes = [...state.meta.routes.po, ...state.meta.routes.sourcing];
  $('#ovr').innerHTML = `<div class="form proposal"><label>New route</label><select id="oRoute">${routes.map((r) => `<option ${r === x.decision.route ? 'selected' : ''}>${r}</option>`).join('')}</select>
    <div id="oPo"><label>Supplier (Active only)</label><select id="oSup">${state.suppliers.map((s) => `<option value="${s.supplier_id}" ${s.supplier_id === x.decision.supplier_id ? 'selected' : ''}>${s.supplier_id} ${esc(s.name)}</option>`).join('')}</select>
      <label>Unit price (blank = reference price)</label><input id="oPrice" type="number" step="0.01"></div>
    <div id="oSrc"><label>Suggested suppliers, separated by ; (blank = policy suggestion)</label><input id="oSug"></div>
    <label>Reason (required, kept with the original decision)</label><textarea id="oWhy" rows="2"></textarea>
    <div class="btnrow"><button class="primary" id="oGo">Save override and create order</button><button id="oNo">Cancel</button></div></div>`;
  const sync = () => { const po = ['CONTRACT_PO', 'EMERGENCY_PO', 'SPOT_PO'].includes($('#oRoute').value); $('#oPo').hidden = !po; $('#oSrc').hidden = po; };
  $('#oRoute').onchange = sync; sync();
  $('#oNo').onclick = () => ($('#ovr').innerHTML = '');
  $('#oGo').onclick = async () => {
    await api(`/runs/${state.run.id}/requirements/${x.group_id}/override`, { method: 'POST', body: { route: $('#oRoute').value, supplier_id: $('#oSup').value, unit_price: $('#oPrice').value, suggested_supplier_ids: $('#oSug').value, comment: $('#oWhy').value } });
    toast('Override saved'); await openRun(state.run.id);
  };
}
$('#approveAllBtn').onclick = async () => {
  const rows = filtered().filter((x) => x.status === 'PENDING');
  if (!confirm(`Approve ${rows.length} pending requirement(s) as decided by the policy?`)) return;
  let ok = 0; for (const x of rows) { try { await api(`/runs/${state.run.id}/requirements/${x.group_id}/approve`, { method: 'POST', body: {} }); ok++; } catch (e) { /* toast shown */ } }
  toast(`${ok} approved`); await openRun(state.run.id);
};
$('#batchFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append('file', f);
  toast('Processing ' + f.name + '\u2026');
  try { const r = await api('/process-batch', { method: 'POST', body: fd }); toast(`Processed ${r.summary.lines} lines under policy v${r.policy_version}`); state.sel = null; await loadRuns(r.run_id); } catch (err) { /* toast shown */ }
  e.target.value = '';
});

// ---------- policy
async function loadPolicies() {
  const list = await api('/policies');
  $('#polTable tbody').innerHTML = list.map((p) => `<tr data-id="${p.id}"><td><b>v${esc(p.version)}</b></td><td>${esc(p.effective_from)}</td><td class="s-${p.status === 'approved' ? 'APPROVED' : 'PENDING'}">${esc(p.status)}</td><td class="small">${esc(p.source_name || '')}<br><span class="muted">${esc(p.created_by || '')}</span></td><td><button data-view="${p.id}">View</button></td></tr>`).join('');
}
$('#polTable tbody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-view]'); if (!b) return;
  const p = await api('/policies/' + b.dataset.view);
  if (p.status === 'proposed') return showProposal(p);
  $('#polView').innerHTML = `<h4>Rules in v${esc(p.version)} (in order)</h4>` + p.body.rules.map((r) => `<div class="diff"><b>${esc(r.id)}</b> ${esc(r.name || '')}<br><code class="small">${esc(JSON.stringify({ when: r.when, outcome: r.outcome }))}</code></div>`).join('') + `<h4>Parameters</h4><pre>${esc(JSON.stringify(p.body.parameters, null, 1))}</pre>` + (p.changes ? `<h4>Changes from v${esc(p.base_version)}</h4>` + p.changes.diff.map((d) => `<div class="diff ${d.kind}">${esc(d.text)}</div>`).join('') : '');
});
async function showProposal(p) {
  const imp = await api(`/policies/${p.id}/impact`).catch(() => ({ available: false }));
  $('#proposal').innerHTML = `<div class="proposal"><h3>Proposed v${esc(p.version)} (not active yet)</h3>
    <div class="muted small">Read by: ${esc(p.changes.engine === 'llm' ? 'language model' : p.changes.engine === 'rules' ? 'built-in reader' : p.changes.engine)}. ${esc((p.changes.notes || []).join(' '))}</div>
    <h4>What will change</h4>${p.changes.diff.map((d) => `<div class="diff ${d.kind}">${esc(d.text)}</div>`).join('') || '<p class="muted">No differences found.</p>'}
    ${(p.changes.unread || []).length ? `<h4 class="warn">Sentences I could not turn into rules</h4>${p.changes.unread.map((u) => `<div class="diff">${esc(u)}</div>`).join('')}` : ''}
    ${imp.available ? `<h4>Impact on the last batch (run #${imp.run_id})</h4><p><b>${imp.changed_lines}</b> of ${imp.lines} lines would be decided differently.</p>${imp.examples.length ? `<table class="mini">${imp.examples.map((x) => `<tr><td>${esc(x.pr_no)}</td><td>${esc(x.item)}</td><td>${esc(x.before)}</td><td>\u2192</td><td>${esc(x.after)}</td></tr>`).join('')}</table>` : ''}` : ''}
    <div class="row"><label>Effective from <input type="date" id="effDate" value="${esc(p.effective_from)}"></label>
    <button class="primary" id="polApprove">Approve and activate</button><button id="polReject" class="danger">Reject</button></div></div>`;
  $('#polApprove').onclick = async () => { await api(`/policies/${p.id}/approve`, { method: 'POST', body: { effective_from: $('#effDate').value } }); toast(`Policy v${p.version} approved, effective ${$('#effDate').value}`); $('#proposal').innerHTML = ''; await loadMeta(); await loadPolicies(); };
  $('#polReject').onclick = async () => { await api(`/policies/${p.id}/reject`, { method: 'POST', body: {} }); toast('Rejected'); $('#proposal').innerHTML = ''; await loadPolicies(); };
}
$('#policyPropose').onclick = async () => {
  const file = $('#policyFile').files[0]; const text = $('#policyText').value.trim();
  if (!file && !text) return toast('Describe a change or choose a file first', true);
  const fd = new FormData(); if (file) fd.append('file', file); if (text) fd.append('text', text); if ($('#policyDate').value) fd.append('effective_from', $('#policyDate').value);
  try { const p = await api('/policies/propose', { method: 'POST', body: fd }); await loadPolicies(); showProposal(p); }
  catch (e) { const u = e.data && e.data.unread; if (u && u.length) $('#proposal').innerHTML = `<div class="proposal"><h4 class="warn">Could not read these</h4>${u.map((x) => `<div class="diff">${esc(x)}</div>`).join('')}</div>`; }
};

// ---------- preferred suppliers
let prefData = null;
async function loadPreferred() {
  const asOf = $('#prefDate').value || state.meta.today;
  prefData = await api('/preferred?as_of=' + asOf);
  $('#prefExport').href = `/api/preferred/export.csv?as_of=${asOf}`;
  renderPrefItems();
}
function renderPrefItems() {
  const q = $('#prefSearch').value.toLowerCase();
  $('#prefItems tbody').innerHTML = prefData.items.filter((i) => !q || (i.item_code + i.description + i.category).toLowerCase().includes(q)).map((i) => `<tr data-i="${i.item_code}"><td>${esc(i.description)}<div class="muted small">${i.item_code}</div></td><td>${esc(i.category)}</td><td>${i.list[0] ? esc(i.list[0].supplier_id + ' ' + i.list[0].name) : '<span class="muted">none yet</span>'}</td></tr>`).join('');
}
$('#prefDate').addEventListener('change', loadPreferred); $('#prefSearch').addEventListener('input', () => prefData && renderPrefItems());
$('#prefItems tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-i]'); if (!tr) return;
  const it = prefData.items.find((i) => i.item_code === tr.dataset.i);
  const w = prefData.weights;
  $('#prefDetail').innerHTML = `<h3>${esc(it.description)}</h3><div class="muted">As of ${esc(prefData.as_of)} \u00B7 policy v${esc(prefData.policy_version)}</div>
   <p class="small">Score = ${Object.entries(w).map(([k, v]) => `${v} \u00D7 ${k.replace('_', ' ')}`).join(' + ')}. Frequency is relative to the best supplier on this list. Recency is 1 within 90 days, 0.5 within 365, else 0.</p>
   ${it.list.length ? it.list.map((s) => `<div class="diff"><b>#${s.rank} ${esc(s.supplier_id)} ${esc(s.name)}</b> \u00B7 score ${s.score} \u00B7 ref price ${inr(s.reference_price)} <span class="muted small">(${esc(s.reference_source)})</span>
     <table class="mini"><tr>${Object.values(s.breakdown).map((b) => `<th>${esc(b.label)}</th>`).join('')}</tr><tr>${Object.values(s.breakdown).map((b) => `<td>${b.value} \u00D7 ${b.weight} = ${(b.value * b.weight).toFixed(3)}</td>`).join('')}</tr></table>
     <div class="muted small">${s.po_count} POs in window, last ${esc(s.last_po_date || 'none')}${s.has_contract ? ', contract ' + esc(s.contract_ids.join(', ')) : ''}, on-time ${s.on_time_pct}%, quality ${s.quality_rating}</div></div>`).join('') : '<p class="muted">No Active supplier has a PO in the window or a contract for this item. Sourcing uses a category top-up.</p>'}`;
});

// ---------- contracts
async function loadContracts() {
  const list = await api('/contracts');
  $('#conTable tbody').innerHTML = list.map((c) => `<tr><td>${esc(c.contract_id)}<div class="muted small">${c.lines.length} items</div></td><td>${esc(c.supplier_id)} ${esc(c.supplier_name)}${c.supplier_status !== 'Active' ? ` <span class="err small">${esc(c.supplier_status)}</span>` : ''}</td><td>${esc(c.start_date)} \u2192 ${esc(c.end_date)}</td><td class="r">${inr(c.value_cap)}</td><td class="r">${inr(c.consumed_value)}</td><td>${esc(c.source)}</td></tr>`).join('');
}
function conForm(d, pdfName) {
  $('#conForm').innerHTML = `<div class="form proposal">${(d.warnings || []).map((w) => `<div class="warn">\u26A0 ${esc(w)}</div>`).join('')}
    <label>Contract no.</label><input id="cId" value="${esc(d.contract_id)}"><label>Supplier ID</label><input id="cSup" value="${esc(d.supplier_id)}">
    <div class="row"><div><label>Start</label><input type="date" id="cStart" value="${esc(d.start_date)}"></div><div><label>End</label><input type="date" id="cEnd" value="${esc(d.end_date)}"></div></div>
    <label>Value ceiling (INR)</label><input id="cCap" type="number" value="${esc(d.value_cap ?? '')}"><label>Already consumed (INR)</label><input id="cCons" type="number" value="${esc(d.consumed_value ?? 0)}">
    <label>Rate lines (item_code, rate; one per line)</label><textarea id="cLines" rows="5">${esc((d.lines || []).map((l) => `${l.item_code}, ${l.rate}`).join('\n'))}</textarea>
    <div class="btnrow"><button class="primary" id="cSave">Save contract</button></div></div>`;
  $('#cSave').onclick = async () => {
    const lines = $('#cLines').value.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => { const [item_code, rate] = s.split(/[,\s]+/); return { item_code: item_code.toUpperCase(), rate: Number(rate) }; });
    const contract = { contract_id: $('#cId').value.trim(), supplier_id: $('#cSup').value.trim().toUpperCase(), start_date: $('#cStart').value, end_date: $('#cEnd').value, value_cap: Number($('#cCap').value), consumed_value: Number($('#cCons').value || 0), lines };
    if (pdfName) await api('/contracts/from-pdf', { method: 'POST', body: { contract, pdf_name: pdfName } }); else await api('/contracts', { method: 'POST', body: contract });
    toast('Contract saved'); $('#conForm').innerHTML = ''; loadContracts();
  };
}
$('#conManual').onclick = () => conForm({});
$('#conPdf').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append('file', f);
  const r = await api('/contracts/extract', { method: 'POST', body: fd }); conForm(r.draft, r.pdf_name); toast('Check what was read from the PDF, then save'); e.target.value = '';
});

// ---------- audit
async function loadAudit() {
  const list = await api('/audit');
  $('#auditTable tbody').innerHTML = list.map((a) => `<tr><td class="small">${esc(a.ts.replace('T', ' ').slice(0, 19))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.entity)} ${esc(a.entity_id)}</td><td class="small muted">${esc(JSON.stringify(a.detail)).slice(0, 220)}</td></tr>`).join('');
}

loadMeta().catch((e) => toast(e.message, true));
