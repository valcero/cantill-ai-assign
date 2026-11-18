'use strict';
// Requester chat: slot filling (item, quantity, plant, need-by, urgency) with confirmation, then PR creation.
// Deterministic by design: it only ever offers items that exist in the item master.
const { loadDataset, getSetting, setSetting, appToday, audit, tx } = require('../db');
const { matchItem } = require('../engine/matcher');
const { runEngine } = require('../engine/engine');
const { activePolicyFor } = require('./policies');
const { summarize, hydrate } = require('./runs');
const { addDays, toMs, inr } = require('../engine/util');

const UOMS = ['nos', 'no', 'pcs', 'pc', 'pair', 'pairs', 'kg', 'kgs', 'mtr', 'meter', 'meters', 'metre', 'ltr', 'liter', 'litre', 'liters', 'litres', 'rol', 'roll', 'rolls', 'ream', 'reams', 'set', 'sets', 'job', 'jobs', 'cyl', 'bkt', 'brl', 'drum', 'drums', 'box', 'boxes', 'mon', 'months', 'month'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');

const newState = () => ({ stage: 'collect', draft: {}, candidates: [] });

function getSession(db, id) {
  const r = db.prepare('SELECT * FROM chat_sessions WHERE id=? AND kind=?').get(id, 'pr');
  return r ? JSON.parse(r.state) : newState();
}
function saveSession(db, id, st) {
  db.prepare('INSERT INTO chat_sessions (id, kind, state, updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at')
    .run(id, 'pr', JSON.stringify(st), new Date().toISOString());
}

// ---- parsing helpers
function parsePlant(t) {
  const l = t.toLowerCase();
  if (/\b(chk1|chakan)\b/.test(l)) return 'CHK1';
  if (/\b(pun1|bhosari|pune)\b/.test(l)) return 'PUN1';
  return null;
}
function parseDate(text, today) {
  const l = text.toLowerCase();
  let m;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(l))) return { date: m[0], span: m[0] };
  if ((m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(l))) return { date: `${m[3]}-${pad(m[2])}-${pad(m[1])}`, span: m[0] };
  const mon = MONTHS.join('|');
  if ((m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${mon})[a-z]*\\.?(?:\\s+(\\d{4}))?\\b`).exec(l)) || (m = null)) {
    if (m) return { date: fillYear(m[3], MONTHS.indexOf(m[2]) + 1, +m[1], today), span: m[0] };
  }
  if ((m = new RegExp(`\\b(${mon})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`).exec(l))) return { date: fillYear(m[3], MONTHS.indexOf(m[1]) + 1, +m[2], today), span: m[0] };
  if ((m = /\btoday\b/.exec(l))) return { date: today, span: m[0] };
  if ((m = /\btomorrow\b/.exec(l))) return { date: addDays(today, 1), span: m[0] };
  if ((m = /\bin\s+(\d{1,3})\s*days?\b/.exec(l))) return { date: addDays(today, +m[1]), span: m[0] };
  if ((m = /\b(?:in\s+)?(\d{1,2})\s*weeks?\b/.exec(l)) && /week/.test(l) && /\bin\b/.test(l)) return { date: addDays(today, 7 * +m[1]), span: m[0] };
  if ((m = /\bnext week\b/.exec(l))) return { date: addDays(today, 7), span: m[0] };
  if ((m = /\b(end of (?:the )?month|month end)\b/.exec(l))) { const d = new Date(toMs(today)); return { date: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10), span: m[0] }; }
  if ((m = new RegExp(`\\b(next|this)?\\s*(${WEEKDAYS.join('|')})\\b`).exec(l))) {
    const target = WEEKDAYS.indexOf(m[2]);
    const cur = new Date(toMs(today)).getUTCDay();
    let delta = (target - cur + 7) % 7 || 7;
    if (m[1] === 'next') {
      const daysToSunday = (7 - cur) % 7; // days left in the current Mon-Sun week
      if (delta <= daysToSunday) delta += 7;
    }
    return { date: addDays(today, delta), span: m[0] };
  }
  return null;
}
function fillYear(y, mo, d, today) {
  let year = y ? +y : +today.slice(0, 4);
  let s = `${year}-${pad(mo)}-${pad(d)}`;
  if (!y && s < today) s = `${year + 1}-${pad(mo)}-${pad(d)}`;
  return s;
}
function parseUrgency(t) {
  const l = t.toLowerCase();
  if (/\b(emergency|breakdown|line down|line stop|machine down|stoppage)\b/.test(l)) return 'Emergency';
  if (/\b(urgent|urgently|asap|immediately|critical)\b/.test(l)) return 'Emergency?';
  if (/\b(normal|routine|not urgent|no rush|regular)\b/.test(l)) return 'Normal';
  return null;
}

/** Take the message apart into slots. Whatever is left is the item text. */
function extract(message, today, expecting) {
  let t = ' ' + message.replace(/\s+/g, ' ').trim() + ' ';
  const out = {};
  const code = /\bITM-\d{4}\b/i.exec(t);
  if (code) { out.item_code = code[0].toUpperCase(); t = t.replace(code[0], ' '); }
  const plant = parsePlant(t);
  if (plant) { out.plant = plant; t = t.replace(/\b(?:for|at|in|to)?\s*\b(chk1|chakan|pun1|bhosari|pune)\b(?:\s+plant)?/gi, ' '); }
  const dt = parseDate(t, today);
  if (dt) { out.need_by = dt.date; t = t.replace(new RegExp(`(?:\\b(?:by|before|on|till|until|need(?:ed)?(?: by)?|required by|deliver(?:ed)? by)\\s+)?(?:the\\s+)?${dt.span.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), ' '); }
  const urg = parseUrgency(t);
  if (urg) { out.urgency = urg; t = t.replace(/\b(not urgent|no rush|urgent(?:ly)?|asap|immediately|critical|emergency|breakdown|line down|line stop|machine down|stoppage|normal|routine|regular)\b/gi, ' '); }
  t = t.replace(/\b(i|we)\s+(?:need|want|require)\b|\b(please|pls|kindly)\b|\b(raise|create|make)\s+(?:a\s+)?(?:pr|purchase request|requisition)\s*(?:for)?\b|\b(need|needs|needed|want|require|required|buy|order|purchase|get me|get|send|arrange|request)\b/gi, ' ');
  // quantity
  const uomRe = UOMS.join('|');
  let q;
  if ((q = new RegExp(`(?:^|\\s)(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${uomRe})\\b`, 'i').exec(t))) { out.quantity = Number(q[1].replace(/,/g, '')); out.uom_said = q[2].toLowerCase(); t = t.replace(q[0], ' '); }
  else if ((q = /\b(?:qty|quantity|of)\s*[:=]?\s*(\d[\d,]*(?:\.\d+)?)\b/i.exec(t))) { out.quantity = Number(q[1].replace(/,/g, '')); t = t.replace(q[0], ' '); }
  else if ((q = /^\s*(\d[\d,]*(?:\.\d+)?)\s+(?=[a-z])/i.exec(t))) { out.quantity = Number(q[1].replace(/,/g, '')); t = t.replace(q[0], ' '); }
  else if (expecting === 'quantity' && (q = /^\s*(\d[\d,]*(?:\.\d+)?)\s*$/.exec(t))) { out.quantity = Number(q[1].replace(/,/g, '')); t = ' '; }
  t = t.replace(/\b(for|of|the|a|an|some|to|by|at|in|on|from|with)\b/gi, (w) => w).replace(/^\s*(of|for)\s+/i, '').replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\b(for|by|at|in|on|to|and)\s*$/i, '').trim();
  t = t.replace(/^(a|an|the|some|any)\s+/i, '').trim();
  if (t && /[a-z0-9]/i.test(t) && t.length > 1) out.item_text = t;
  return out;
}

function summaryText(d) {
  const item = d.item ? `${d.item.description} (${d.item.item_code})` : `NEW item: ${d.item_text}${d.est_price ? ` @ ${inr(d.est_price)} est.` : ''}`;
  return `Item: ${item}\nQuantity: ${d.quantity} ${d.item ? d.item.uom : 'unit(s)'}\nPlant: ${d.plant}\nNeed by: ${d.need_by}\nUrgency: ${d.urgency}`;
}

function reply(st, text, extra = {}) { return { reply: text, stage: st.stage, draft: st.draft, quick: extra.quick || [], pr: extra.pr || null }; }

function nextPrompt(st, ds) {
  const d = st.draft;
  if (!d.item && !d.is_new) return reply(st, 'Which item do you need? Give me a description or an item code (for example "nitrile coated gloves" or ITM-1048).');
  if (d.is_new && !(d.est_price > 0)) { st.stage = 'ask_price'; return reply(st, `"${d.item_text}" is not in the item master, so it will go to sourcing as a new item. What is your estimated unit price in INR? (Procurement uses it to value the request.)`); }
  if (!(d.quantity > 0)) { st.stage = 'ask_quantity'; return reply(st, `How many ${d.item ? d.item.uom : 'units'} of ${d.item ? d.item.description : d.item_text} do you need?`); }
  if (!d.plant) { st.stage = 'ask_plant'; return reply(st, 'Which plant is this for?', { quick: ['Chakan (CHK1)', 'Bhosari, Pune (PUN1)'] }); }
  if (!d.need_by) { st.stage = 'ask_date'; return reply(st, 'By when do you need it? (a date like 25 Nov, or "next Friday", "in 10 days")'); }
  if (d.urgency === 'Emergency?') { st.stage = 'ask_urgency'; return reply(st, 'You sound urgent. Should I mark this as an Emergency? Emergency is for line-stopping needs and must be genuine.', { quick: ['Yes, Emergency', 'No, Normal'] }); }
  if (!d.urgency) { st.stage = 'ask_urgency'; return reply(st, 'Is this Normal or an Emergency?', { quick: ['Normal', 'Emergency'] }); }
  st.stage = 'confirm';
  return reply(st, `Please check your request:\n${summaryText(d)}\n\nShall I create the PR?`, { quick: ['Yes, create it', 'Cancel'] });
}

function resolveItem(st, ds, text) {
  const m = matchItem(text, ds.items);
  if (m.status === 'exact' || m.status === 'confident') {
    st.draft.item = m.best; st.draft.is_new = false; st.draft.item_text = text; st.candidates = [];
    return { found: true, note: `I matched that to ${m.best.description} (${m.best.item_code}, per ${m.best.uom}).` };
  }
  if (m.status === 'ambiguous') {
    st.candidates = m.candidates.slice(0, 5).map((c) => ({ item_code: c.item.item_code, description: c.item.description, uom: c.item.uom }));
    st.stage = 'pick_item'; st.draft.item_text = text;
    return { found: false, ask: `I found more than one possible match for "${text}". Which one do you mean?\n` + st.candidates.map((c, i) => `${i + 1}. ${c.description} (${c.item_code})`).join('\n') + '\nReply with the number, or say "new item" if none of these is right.', quick: st.candidates.map((c, i) => String(i + 1)).concat(['New item']) };
  }
  st.draft.item_text = text;
  st.stage = 'unknown_item';
  return { found: false, ask: `I could not find "${text}" in the item master, and I will not guess. You can give me a more specific description or the item code, or reply "new item" and I will raise it as a new item for sourcing.`, quick: ['New item'] };
}

async function handleMessage(db, sessionId, message, actor) {
  const ds = loadDataset(db);
  const today = appToday(db);
  const st = getSession(db, sessionId);
  const msg = String(message || '').trim();
  const low = msg.toLowerCase();
  if (!msg) return reply(st, 'Tell me what you need, for example: "need 200 nitrile gloves for Chakan by next Friday".');
  if (/^(cancel|reset|start over|restart|clear)\b/.test(low) && st.stage !== 'confirm') { const n = newState(); saveSession(db, sessionId, n); return reply(n, 'Okay, I cleared that. What do you need?'); }
  const d = st.draft;

  // ---- stage specific answers
  if (st.stage === 'confirm') {
    if (/^(yes|y|yep|yeah|ok|okay|confirm|create|create it|go ahead|correct|yes, create it)\b/.test(low)) {
      const pr = createPr(db, d, actor, today);
      const n = newState(); saveSession(db, sessionId, n);
      return { reply: pr.message, stage: 'collect', draft: {}, quick: ['Raise another request'], pr };
    }
    if (/^(no|n|cancel|stop|nope)\b/.test(low) && !/\d/.test(low)) { const n = newState(); saveSession(db, sessionId, n); return reply(n, 'Cancelled. Nothing was created. What else do you need?'); }
    // otherwise treat as a correction
    const fix = extract(msg, today, null);
    if (fix.quantity) d.quantity = fix.quantity;
    if (fix.plant) d.plant = fix.plant;
    if (fix.need_by) d.need_by = fix.need_by;
    if (fix.urgency) d.urgency = fix.urgency === 'Emergency?' ? 'Emergency?' : fix.urgency;
    if (!fix.quantity && !fix.plant && !fix.need_by && !fix.urgency) return reply(st, 'I did not catch a change. Say "yes" to create the PR, or tell me what to change (for example "make it 300" or "need by 30 Nov").', { quick: ['Yes, create it', 'Cancel'] });
    const r = nextPrompt(st, ds); saveSession(db, sessionId, st); return r;
  }
  if (st.stage === 'pick_item') {
    const pick = /^\s*(\d)\s*$/.exec(low);
    const byCode = /\bITM-\d{4}\b/i.exec(msg);
    let chosen = null;
    if (pick && st.candidates[+pick[1] - 1]) chosen = ds.itemByCode.get(st.candidates[+pick[1] - 1].item_code);
    else if (byCode && ds.itemByCode.get(byCode[0].toUpperCase())) chosen = ds.itemByCode.get(byCode[0].toUpperCase());
    else if (/\bnew item\b|none of|neither/.test(low)) { d.is_new = true; st.candidates = []; }
    else {
      const hit = st.candidates.find((c) => low.includes(c.description.toLowerCase()));
      if (hit) chosen = ds.itemByCode.get(hit.item_code);
    }
    if (chosen) { d.item = chosen; d.is_new = false; st.candidates = []; }
    else if (!d.is_new) {
      // maybe the user refined the description
      const ex = extract(msg, today, null);
      const again = ex.item_text && !/^\d+$/.test(ex.item_text) && !/^(yes|no|normal|emergency|ok|okay)$/i.test(ex.item_text) ? matchItem(ex.item_text, ds.items) : null;
      if (again && again.best) { Object.assign(d, pick1(ex)); d.item = again.best; d.is_new = false; st.candidates = []; }
      else return reply(st, `Please reply with one of the numbers: ${st.candidates.map((c, i) => i + 1).join(', ')}, or "new item".`, { quick: st.candidates.map((c, i) => String(i + 1)).concat(['New item']) });
    }
    st.stage = 'collect';
    const r = nextPrompt(st, ds); saveSession(db, sessionId, st); return r;
  }
  if (st.stage === 'unknown_item') {
    if (/^\s*new item\b|^\s*yes\b|^\s*raise (it )?as (a )?new/.test(low)) { d.is_new = true; d.item = null; st.stage = 'collect'; const r = nextPrompt(st, ds); saveSession(db, sessionId, st); return r; }
    // a more specific description
    const ex = extract(msg, today, null);
    Object.assign(d, pick1(ex));
    const text = ex.item_text || (ex.item_code ? null : msg);
    if (ex.item_code) { const it = ds.itemByCode.get(ex.item_code); if (it) { d.item = it; d.is_new = false; st.stage = 'collect'; const r = nextPrompt(st, ds); saveSession(db, sessionId, st); return r; } }
    const r0 = resolveItem(st, ds, text || msg);
    if (!r0.found) { saveSession(db, sessionId, st); return reply(st, r0.ask, { quick: r0.quick }); }
    st.stage = 'collect'; const r = nextPrompt(st, ds); saveSession(db, sessionId, st);
    r.reply = r0.note + '\n' + r.reply; return r;
  }
  if (st.stage === 'ask_price') {
    const m = /(\d[\d,]*(?:\.\d+)?)/.exec(msg);
    if (!m) return reply(st, 'Please give a number for the estimated unit price in INR (an approximate figure is fine).');
    d.est_price = Number(m[1].replace(/,/g, ''));
    const ex = extract(msg.replace(m[0], ''), today, null); Object.assign(d, pick1(ex, true));
    st.stage = 'collect'; const r = nextPrompt(st, ds); saveSession(db, sessionId, st); return r;
  }
  if (st.stage === 'ask_urgency') {
    if (/^(yes|y|emergency|yes, emergency)\b/.test(low)) d.urgency = 'Emergency';
    else if (/^(no|n|normal|no, normal|routine)\b/.test(low)) d.urgency = 'Normal';
    else { const u = parseUrgency(msg); if (u && u !== 'Emergency?') d.urgency = u; else return reply(st, 'Please answer Normal or Emergency.', { quick: ['Normal', 'Emergency'] }); }
    const r = nextPrompt(st, ds); saveSession(db, sessionId, st); return r;
  }

  // ---- collecting (also used for ask_quantity / ask_plant / ask_date answers and the first message)
  const ex = extract(msg, today, st.stage === 'ask_quantity' ? 'quantity' : null);
  if (ex.plant) d.plant = ex.plant;
  if (ex.need_by) {
    if (ex.need_by < today) return reply(st, `${ex.need_by} is already in the past (today is ${today}). Which date do you need it by?`);
    d.need_by = ex.need_by;
  }
  if (ex.urgency) d.urgency = ex.urgency;
  if (ex.quantity) d.quantity = ex.quantity;
  if (ex.item_code) {
    const it = ds.itemByCode.get(ex.item_code);
    if (!it) { return reply(st, `${ex.item_code} is not in the item master. Please check the code, or describe the item in words.`); }
    d.item = it; d.is_new = false;
  } else if (ex.item_text && (!d.item || !['ask_quantity', 'ask_plant', 'ask_date'].includes(st.stage))) {
    if (st.stage === 'ask_plant' || st.stage === 'ask_date') { /* answer to a different slot */ }
    else if (!d.item || /^\s*(change|instead)/.test(low)) {
      const r = resolveItem(st, ds, ex.item_text);
      if (!r.found) { saveSession(db, sessionId, st); return reply(st, r.ask, { quick: r.quick }); }
      st.pendingNote = r.note;
    }
  }
  if (st.stage === 'ask_plant' && !ex.plant) return reply(st, 'I need the plant: Chakan (CHK1) or Bhosari, Pune (PUN1).', { quick: ['Chakan (CHK1)', 'Bhosari, Pune (PUN1)'] });
  if (st.stage === 'ask_date' && !ex.need_by) return reply(st, 'I could not read that as a date. Try "25 Nov", "next Friday" or "in 10 days".');
  if (st.stage === 'ask_quantity' && !ex.quantity) return reply(st, 'Please give the quantity as a number.');
  st.stage = 'collect';
  const r = nextPrompt(st, ds);
  if (st.pendingNote) { r.reply = st.pendingNote + '\n' + r.reply; delete st.pendingNote; }
  saveSession(db, sessionId, st);
  return r;
}
function pick1(ex, onlyUseful) {
  const o = {};
  for (const k of ['quantity', 'plant', 'need_by', 'urgency']) if (ex[k]) o[k] = ex[k];
  return o;
}

// ---- PR creation and decision
function nextPrNo(db) {
  const n = Number(getSetting(db, 'chat_pr_seq', '0')) + 1;
  setSetting(db, 'chat_pr_seq', n);
  return `PR-C-${String(n).padStart(5, '0')}`;
}
function chatRunId(db) {
  let id = getSetting(db, 'chat_run_id', '');
  if (!id) {
    id = Number(db.prepare('INSERT INTO runs (source, filename, policy_version, as_of, created_by, created_at, summary) VALUES (?,?,?,?,?,?,?)')
      .run('chat', 'Chat requests', '', appToday(db), 'chat', new Date().toISOString(), '{}').lastInsertRowid);
    setSetting(db, 'chat_run_id', id);
  }
  return Number(id);
}

function createPr(db, d, actor, today) {
  return tx(db, () => {
    const prNo = nextPrNo(db);
    const now = new Date();
    const created = `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const raw = {
      pr_no: prNo, pr_line: '1', created_at: created, requester: actor, department: 'Chat', plant: d.plant,
      item_code: d.item ? d.item.item_code : '', description: d.item ? d.item.description : d.item_text, quantity: d.quantity,
      uom: d.item ? d.item.uom : d.uom || 'NOS', estimated_unit_price: d.est_price || '', need_by_date: d.need_by, urgency: d.urgency === 'Emergency' ? 'Emergency' : 'Normal'
    };
    const res = reprocessChat(db, raw, actor);
    audit(db, actor, 'create_pr', 'pr', prNo, { item: raw.item_code || raw.description, quantity: raw.quantity, plant: raw.plant, route: res.mine.decision.route });
    const dec = res.mine.decision;
    const plain = dec.decision === 'PO'
      ? `A purchase order is recommended (${dec.route.replace(/_/g, ' ')}) with supplier ${dec.supplier_id} at ${dec.unit_price} per unit.`
      : `It needs sourcing first (${dec.route.replace(/_/g, ' ')}${dec.suggested_ids && dec.suggested_ids.length ? ', suggested suppliers ' + dec.suggested_ids.join(', ') : ''}).`;
    const clubbed = res.mine.lines.length > 1 ? ` It was combined with ${res.mine.lines.length - 1} earlier request(s) for the same item and plant (policy 2.2), so the limits apply to the total of ${inr(dec.value)}.` : '';
    return { pr_no: prNo, run_id: res.runId, group_id: res.mine.group_id, route: dec.route, decision: dec.decision, value: dec.value,
      message: `Done. ${prNo} is created.\n${plain}${clubbed}\nA buyer will review and approve it in the Buyer workspace (requirement ${res.mine.group_id}, policy v${dec.policy_version}, clause ${dec.clause}).` };
  });
}

/** Re-decide all still-pending chat lines together with the new one, so clubbing and contract ceilings stay correct. */
function reprocessChat(db, rawNew, actor) {
  const runId = chatRunId(db);
  const reqRows = db.prepare('SELECT * FROM requirements WHERE run_id=?').all(runId).map(hydrate);
  const frozenLines = new Set();
  const extra = new Map();
  for (const r of reqRows) {
    if (r.status !== 'PENDING') {
      r.lines.forEach((l) => frozenLines.add(`${l.pr_no}/${l.pr_line}`));
      const d = r.override ? { ...r.decision, ...r.override } : r.decision;
      if (d.route === 'CONTRACT_PO' && r.decision.contract_id) extra.set(r.decision.contract_id, (extra.get(r.decision.contract_id) || 0) + r.decision.value);
    }
  }
  const all = db.prepare('SELECT * FROM run_lines WHERE run_id=? ORDER BY idx').all(runId);
  const pool = all.filter((l) => !frozenLines.has(`${l.pr_no}/${l.pr_line}`)).map((l) => JSON.parse(l.raw));
  pool.push(rawNew);
  const ds = loadDataset(db);
  const policyFor = require('./runs').policyResolver(db);
  const result = runEngine({ ds, policyFor, lines: pool, extraConsumed: extra });
  const policy = { version: result.policy_version };
  // stable ids: group = CH-<first pr>, PO = PO-<first group>
  const gmap = new Map();
  for (const r of result.requirements) { const nid = `CH-${r.lines[0].pr_no}`; gmap.set(r.group_id, nid); }
  const pmap = new Map();
  for (const p of result.pos) pmap.set(p.po_id, `PO-${gmap.get(p.groups[0])}`);
  for (const r of result.requirements) { r.group_id = gmap.get(r.group_id); r.decision.group_id = r.group_id; if (r.decision.po_id) r.decision.po_id = pmap.get(r.decision.po_id); }
  for (const l of result.lines) { if (l.group_id) l.group_id = gmap.get(l.group_id); if (l.po_id) l.po_id = pmap.get(l.po_id); }
  db.prepare("DELETE FROM requirements WHERE run_id=? AND status='PENDING'").run(runId);
  const poolKeys = new Set(pool.map((r) => `${r.pr_no}/${r.pr_line}`));
  for (const l of all) if (poolKeys.has(`${l.pr_no}/${l.pr_line}`)) db.prepare('DELETE FROM run_lines WHERE run_id=? AND idx=?').run(runId, l.idx);
  let idx = (db.prepare('SELECT COALESCE(MAX(idx),-1) m FROM run_lines WHERE run_id=?').get(runId).m) + 1;
  pool.forEach((r, i) => db.prepare('INSERT INTO run_lines VALUES (?,?,?,?,?,?)').run(runId, idx++, String(r.pr_no), String(r.pr_line), JSON.stringify(r), JSON.stringify(result.lines[i])));
  for (const r of result.requirements) db.prepare('INSERT INTO requirements (run_id, group_id, status, data, po_id) VALUES (?,?,?,?,?)').run(runId, r.group_id, 'PENDING', JSON.stringify(r), r.decision.po_id || '');
  db.prepare('UPDATE runs SET policy_version=?, as_of=? WHERE id=?').run(policy.version, rawNew.created_at.slice(0, 10), runId);
  const mine = result.requirements.find((r) => r.lines.some((l) => l.pr_no === rawNew.pr_no));
  return { runId, mine };
}

module.exports = { handleMessage, extract, parseDate, getSession, reprocessChat };
