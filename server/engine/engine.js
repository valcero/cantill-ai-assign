'use strict';
// Decision engine: PR lines -> requirements -> valuation -> contract check -> policy route -> PO consolidation.
// Pure function of (dataset, policy, lines). No database, no HTTP, no hard-coded limits.
const { toMs, dateOf, dayDiff, addDays, round2, inr } = require('./util');
const { matchItem, prepareItems } = require('./matcher');
const { evalCond, ruleText } = require('./policy');
const { preferredList, suggestSuppliers } = require('./preferred');

/** Build lookup structures from plain arrays. */
function buildIndex({ items, suppliers, pos, contracts, plants }) {
  const ds = { items: prepareItems(items.map((i) => ({ ...i }))), suppliers, plants: plants || [] };
  ds.itemByCode = new Map(ds.items.map((i) => [i.item_code, i]));
  ds.supplierById = new Map(suppliers.map((s) => [s.supplier_id, s]));
  ds.posByItem = new Map();
  for (const p of pos) {
    if (!ds.posByItem.has(p.item_code)) ds.posByItem.set(p.item_code, []);
    ds.posByItem.get(p.item_code).push(p);
  }
  for (const arr of ds.posByItem.values()) arr.sort((a, b) => b.po_date.localeCompare(a.po_date) || String(b.po_number).localeCompare(String(a.po_number)));
  ds.contracts = contracts;
  ds.contractById = new Map(contracts.map((c) => [c.contract_id, c]));
  ds.contractsByItem = new Map();
  for (const c of contracts) {
    for (const l of c.lines) {
      if (!ds.contractsByItem.has(l.item_code)) ds.contractsByItem.set(l.item_code, []);
      ds.contractsByItem.get(l.item_code).push({ contract_id: c.contract_id, supplier_id: c.supplier_id, start_date: c.start_date, end_date: c.end_date, rate: l.rate });
    }
  }
  return ds;
}

const num = (x) => {
  if (x == null || String(x).trim() === '') return NaN;
  return Number(String(x).replace(/,/g, ''));
};

function prepareLine(raw, ds, plantSet) {
  const L = {
    pr_no: String(raw.pr_no || '').trim(), pr_line: String(raw.pr_line ?? '').trim(),
    created_at: String(raw.created_at || '').trim(), requester: raw.requester || '', department: raw.department || '',
    plant: String(raw.plant || '').trim().toUpperCase(), item_code: String(raw.item_code || '').trim().toUpperCase(),
    description: String(raw.description || '').trim(), quantity: num(raw.quantity), uom: raw.uom || '',
    estimated_unit_price: num(raw.estimated_unit_price), need_by_date: dateOf(raw.need_by_date),
    urgency: String(raw.urgency || 'Normal').trim() || 'Normal', notes: []
  };
  L.created_ms = toMs(L.created_at);
  L.created_date = dateOf(L.created_at);
  L.emergency = /^emerg/i.test(L.urgency);
  if (!L.pr_no) L.reject = 'PR number missing';
  else if (Number.isNaN(L.created_ms)) L.reject = `created_at "${raw.created_at}" is not a valid date`;
  else if (!L.plant) L.reject = 'plant missing';
  else if (plantSet.size && !plantSet.has(L.plant)) L.reject = `plant "${L.plant}" is not a Corvo plant (${[...plantSet].join(', ')})`;
  else if (!(L.quantity > 0)) L.reject = `quantity "${raw.quantity ?? ''}" is not greater than zero`;
  else if (!L.item_code && !L.description) L.reject = 'neither item code nor description given';
  if (L.reject) return L;
  // item resolution (policy 1.1)
  let item = null;
  if (L.item_code) {
    item = ds.itemByCode.get(L.item_code) || null;
    if (!item) L.notes.push(`item code ${L.item_code} is not in the item master`);
  }
  if (!item && L.description) {
    const m = matchItem(L.description, ds.items);
    if (m.best) { item = m.best; L.notes.push(`matched "${L.description}" to ${m.best.item_code} (${m.best.description})`); }
    else if (m.status === 'ambiguous') L.notes.push(`"${L.description}" could be ${m.candidates.slice(0, 3).map((c) => c.item.item_code).join(', ')}; treated as a new item`);
  }
  L.item = item;
  return L;
}

function shareFields(policy) {
  return policy.parameters.clubbing.match_fields || ['item_code', 'plant'];
}

function clubLines(lines, policy) {
  const cp = policy.parameters.clubbing;
  const fields = shareFields(policy);
  const sorted = [...lines].sort((a, b) => a.created_ms - b.created_ms || a.pr_no.localeCompare(b.pr_no) || (Number(a.pr_line) - Number(b.pr_line)) || 0);
  const reqs = [];
  for (const l of sorted) {
    const key = (x) => fields.map((f) => (f === 'item_code' ? x.item?.item_code : f === 'category' ? x.item?.category : x[f])).join('|');
    let joined = null;
    if (l.item || !cp.new_items_never_clubbed) {
      for (const r of reqs) {
        if (r.is_new && cp.new_items_never_clubbed) continue;
        if (r.is_new !== !l.item) continue;
        if (r.key !== key(l)) continue;
        if (dayDiff(r.first.created_date, l.created_date) > cp.created_within_days) continue;
        if (r.first.need_by_date && l.need_by_date) {
          if (Math.abs(dayDiff(r.first.need_by_date, l.need_by_date)) > cp.need_by_within_days) continue;
        } else if (!!r.first.need_by_date !== !!l.need_by_date) continue;
        joined = r; break;
      }
    }
    if (joined) joined.lines.push(l);
    else reqs.push({ lines: [l], first: l, key: key(l), is_new: !l.item, item: l.item });
  }
  reqs.forEach((r, i) => { r.group_id = `REQ-${String(i + 1).padStart(4, '0')}`; });
  return reqs;
}

function applicableContracts(ds, itemCode, reqDate) {
  return (ds.contractsByItem.get(itemCode) || []).filter((c) => {
    const s = ds.supplierById.get(c.supplier_id);
    return c.start_date <= reqDate && reqDate <= c.end_date && s && s.status === 'Active';
  });
}

function lastPo(ds, itemCode, reqDate, days, activeOnly) {
  const from = addDays(reqDate, -days);
  return (ds.posByItem.get(itemCode) || []).find((p) => p.po_date >= from && p.po_date <= reqDate &&
    (!activeOnly || (ds.supplierById.get(p.supplier_id) || {}).status === 'Active')) || null;
}

function evaluate(req, ds, policy, consumed) {
  const hp = policy.parameters.history;
  const reqDate = req.first.created_date;
  const qty = req.lines.reduce((s, l) => s + l.quantity, 0);
  const item = req.item;
  const ev = { contracts: [], trace: [] };
  const out = { qty, req_date: reqDate };

  let unitPrice, value, basis;
  let chosen = null;
  if (item) {
    const app = applicableContracts(ds, item.item_code, reqDate);
    for (const c of app) {
      const cv = qty * c.rate;
      const base = consumed.get(c.contract_id);
      const cap = ds.contractById.get(c.contract_id).value_cap;
      const room = cap - base;
      ev.contracts.push({ contract_id: c.contract_id, supplier_id: c.supplier_id, rate: c.rate, consumed: round2(base), cap, requirement_value_at_rate: round2(cv), usable: base + cv <= cap + 1e-9, room: round2(room) });
    }
    const usable = ev.contracts.filter((c) => c.usable).sort((a, b) => a.rate - b.rate || a.contract_id.localeCompare(b.contract_id));
    chosen = usable[0] || null;
    out.contract_applicable = app.length > 0;
    if (chosen) { unitPrice = chosen.rate; basis = `contract ${chosen.contract_id} rate`; }
    else if (app.length) {
      const low = [...ev.contracts].sort((a, b) => a.rate - b.rate)[0];
      unitPrice = low.rate; basis = `lowest applicable contract rate (${low.contract_id}); every applicable contract is out of ceiling`;
    } else {
      const po = lastPo(ds, item.item_code, reqDate, hp.recent_purchase_days, false);
      if (po) { unitPrice = po.unit_price; basis = `most recent PO ${po.po_number} (${po.po_date}) price`; out.valuation_po = po.po_number; }
      else { unitPrice = item.standard_price; basis = 'item master standard price (no PO in the look-back period)'; }
    }
    value = qty * unitPrice;
  } else {
    value = req.lines.reduce((s, l) => s + l.quantity * (Number.isNaN(l.estimated_unit_price) ? 0 : l.estimated_unit_price), 0);
    unitPrice = value / qty;
    basis = "requester's estimated unit price";
    if (req.lines.some((l) => Number.isNaN(l.estimated_unit_price))) basis += ' (no estimate given for some lines, valued at 0)';
  }
  out.value = round2(value); out.unit_price = round2(unitPrice); out.valuation_basis = basis;
  out.chosen_contract = chosen;

  const recentPo = item ? lastPo(ds, item.item_code, reqDate, hp.recent_purchase_days, true) : null;
  const list = item ? preferredList(ds, item.item_code, reqDate, policy) : [];
  out.preferred = list;
  const facts = {
    item_code: item ? item.item_code : 'NEW', item_name: item ? item.description : req.first.description,
    item_type: item ? item.item_type : '', category: item ? item.category : '', plant: req.first.plant,
    department: req.first.department, uom: item ? item.uom : req.first.uom, quantity: qty, value: out.value,
    unit_price: out.unit_price, urgency: req.lines.some((l) => l.emergency) ? 'Emergency' : req.first.urgency,
    emergency: req.lines.some((l) => l.emergency), is_new_item: !item, contract_applicable: !!out.contract_applicable,
    contract_usable: !!chosen, bought_recently: !!recentPo, has_preferred_supplier: list.length > 0, line_count: req.lines.length
  };
  out.facts = facts; out.recent_po = recentPo;

  let hit = null;
  for (const rule of policy.rules) {
    const matched = evalCond(rule.when, facts);
    let feasible = true, why = '';
    if (matched) {
      const sup = rule.outcome.supplier;
      if (sup === 'contract' && !chosen) { feasible = false; why = 'no usable contract'; }
      if (sup === 'preferred_first' && !(list[0] && list[0].reference_price != null)) { feasible = false; why = 'no preferred supplier with a reference price'; }
    }
    ev.trace.push({ rule: rule.id, name: rule.name || '', matched: matched && feasible, note: matched && !feasible ? `conditions met but skipped: ${why}` : '' });
    if (matched && feasible) { hit = rule; break; }
  }
  if (!hit) hit = { id: 'default', name: 'No rule matched: default to RFQ', outcome: { decision: 'SOURCING_REQUEST', route: 'RFQ', supplier: 'none', suggest: 3 } };
  out.rule = hit; out.ev = ev; out.facts = facts;
  return out;
}

function buildDecision(req, e, ds, policy, consumed) {
  const o = e.rule.outcome;
  const d = {
    group_id: req.group_id, decision: o.decision, route: o.route, clause: e.rule.id, rule_name: e.rule.name || '',
    rule_text: e.rule.when ? ruleText(e.rule) : e.rule.name, value: e.value, unit_price: null, supplier_id: '',
    suggested: [], policy_version: policy.version, relied_on: '', reason: ''
  };
  const val = inr(e.value);
  if (o.decision === 'PO') {
    if (o.supplier === 'contract') {
      const c = e.chosen_contract;
      d.supplier_id = c.supplier_id; d.unit_price = round2(c.rate); d.relied_on = `contract ${c.contract_id}`;
      d.reason = `Clause ${e.rule.id}: contract ${c.contract_id} with ${ds.supplierById.get(c.supplier_id).name} (${c.supplier_id}) is valid on ${e.req_date}, supplier Active, ceiling has room (${inr(c.consumed)} consumed + ${val} = ${inr(c.consumed + e.value)} of ${inr(c.cap)}). PO at contract rate ${c.rate}; requirement value ${val}.`;
      consumed.set(c.contract_id, consumed.get(c.contract_id) + e.value);
      d.contract_id = c.contract_id;
    } else {
      const p = e.preferred[0];
      d.supplier_id = p.supplier_id; d.unit_price = p.reference_price;
      d.relied_on = `${p.reference_source}; recent purchase ${e.recent_po ? 'PO ' + e.recent_po.po_number : ''}`.trim();
      d.reason = `Clause ${e.rule.id} (${e.rule.name || e.rule.outcome.route}): requirement value ${val}${e.facts.emergency ? ', Emergency' : ''}; item bought from an Active supplier in the last ${policy.parameters.history.recent_purchase_days} days (${e.recent_po ? 'PO ' + e.recent_po.po_number + ' on ' + e.recent_po.po_date : 'n/a'}). 1st preferred supplier ${p.supplier_id} ${p.name} (score ${p.score}, ${p.po_count} POs in window), reference price ${p.reference_price} from ${p.reference_source}.`;
    }
  } else {
    const n = o.suggest || 0;
    if (req.item && n) {
      d.suggested = suggestSuppliers(ds, req.item, e.req_date, policy, n);
      d.suggested_ids = d.suggested.map((s) => s.supplier_id);
    }
    const why = [];
    if (e.rule.id === '1.2' || !req.item) why.push('item is not in the item master (new item)');
    why.push(`requirement value ${val} (${e.valuation_basis})`);
    if (e.ev.contracts.length && !e.chosen_contract) {
      why.push('contract not usable: ' + e.ev.contracts.map((c) => `${c.contract_id} ceiling ${inr(c.cap)} has only ${inr(Math.max(0, c.room))} left for a ${inr(c.requirement_value_at_rate)} requirement`).join('; '));
    }
    if (!e.facts.bought_recently && req.item) why.push('no purchase from an Active supplier in the last 365 days');
    d.reason = `Clause ${e.rule.id} (${e.rule.name || e.rule.outcome.route}): ${why.join('; ')}. ` +
      (d.suggested.length ? `Suggested: ${d.suggested.map((s) => `${s.supplier_id} (${s.source})`).join(', ')}.` : n ? '' : 'Buyer finds suppliers.');
    d.relied_on = e.ev.contracts.map((c) => c.contract_id).join(';');
  }
  d.trace = e.ev.trace; d.contracts_checked = e.ev.contracts;
  return d;
}

/**
 * lines: raw PR rows. opts.extraConsumed: Map(contract_id -> additional consumed value)
 */
function runEngine({ ds, policy, lines, extraConsumed }) {
  const plantSet = new Set((ds.plants || []).map((p) => p.plant));
  const seen = new Set();
  const prepared = lines.map((raw) => {
    const L = prepareLine(raw, ds, plantSet);
    const k = `${L.pr_no}/${L.pr_line}`;
    if (!L.reject) { if (seen.has(k)) L.reject = `duplicate of PR line ${k} already in the batch`; seen.add(k); }
    return L;
  });
  const good = prepared.filter((l) => !l.reject);
  const reqs = clubLines(good, policy);
  const consumed = new Map(ds.contracts.map((c) => [c.contract_id, c.consumed_value + ((extraConsumed && extraConsumed.get(c.contract_id)) || 0)]));

  // requirements in creation order consume ceilings in that order (policy 4.2)
  for (const r of reqs) {
    const e = evaluate(r, ds, policy, consumed);
    r.eval = e; r.decision = buildDecision(r, e, ds, policy, consumed);
  }
  // PO consolidation (section 7)
  const cons = policy.parameters.consolidation;
  const pos = [];
  for (const r of reqs) {
    const d = r.decision;
    if (d.decision !== 'PO') continue;
    const keyOf = (x) => cons.match_fields.map((f) => (f === 'route' ? x.route : f === 'supplier_id' ? x.supplier_id : f === 'plant' ? r.first.plant : f === 'category' ? (r.item && r.item.category) : '')).join('|');
    const key = keyOf(d);
    let po = pos.find((p) => p.key === key && (r.first.created_ms - p.first_ms) <= cons.window_hours * 3600000);
    if (!po) { po = { key, po_id: `PO-${String(pos.length + 1).padStart(4, '0')}`, first_ms: r.first.created_ms, supplier_id: d.supplier_id, plant: r.first.plant, route: d.route, groups: [] }; pos.push(po); }
    po.groups.push(r.group_id);
    d.po_id = po.po_id;
  }
  const lineIndex = new Map();
  for (const r of reqs) {
    for (const L of r.lines) {
      const d = r.decision;
      lineIndex.set(`${L.pr_no}/${L.pr_line}`, {
        pr_no: L.pr_no, pr_line: L.pr_line, resolved_item_code: r.item ? r.item.item_code : 'NEW', group_id: r.group_id,
        po_id: d.po_id || '', decision: d.decision, route: d.route, supplier_id: d.supplier_id || '',
        unit_price: d.unit_price == null ? '' : d.unit_price, group_value_inr: d.value,
        suggested_supplier_ids: (d.suggested_ids || []).join(';'), policy_version: policy.version,
        reason: d.reason + (L.notes.length ? ' Note: ' + L.notes.join('; ') + '.' : '')
      });
    }
  }
  const out = prepared.map((L) => {
    if (L.reject) return { pr_no: L.pr_no, pr_line: L.pr_line, resolved_item_code: L.item ? L.item.item_code : '', group_id: '', po_id: '', decision: '', route: 'NOT_PROCESSED', supplier_id: '', unit_price: '', group_value_inr: '', suggested_supplier_ids: '', policy_version: policy.version, reason: `Not processed: ${L.reject}` };
    return lineIndex.get(`${L.pr_no}/${L.pr_line}`);
  });
  const requirements = reqs.map((r) => ({
    group_id: r.group_id, item_code: r.item ? r.item.item_code : 'NEW', item_name: r.item ? r.item.description : r.first.description,
    category: r.item ? r.item.category : '', plant: r.first.plant, req_date: r.eval.req_date, created_at: r.first.created_at,
    quantity: r.eval.qty, uom: r.item ? r.item.uom : r.first.uom, emergency: r.eval.facts.emergency, unit_price_valuation: r.eval.unit_price,
    valuation_basis: r.eval.valuation_basis, facts: r.eval.facts,
    lines: r.lines.map((L) => ({ pr_no: L.pr_no, pr_line: L.pr_line, created_at: L.created_at, quantity: L.quantity, need_by_date: L.need_by_date, urgency: L.urgency, requester: L.requester, department: L.department, description: L.description, notes: L.notes })),
    decision: r.decision, preferred: r.eval.preferred.slice(0, 5)
  }));
  const contractUse = [...consumed.entries()].map(([id, v]) => ({ contract_id: id, consumed_after: round2(v), start_consumed: ds.contractById.get(id).consumed_value, cap: ds.contractById.get(id).value_cap }));
  return { policy_version: policy.version, lines: out, requirements, pos, contract_use: contractUse };
}

module.exports = { buildIndex, runEngine, applicableContracts };
