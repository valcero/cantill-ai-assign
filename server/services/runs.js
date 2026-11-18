'use strict';
// Batch processing, persistence of decisions, and the buyer actions (approve, override).
const { parse } = require('csv-parse/sync');
const { loadDataset, audit, tx } = require('../db');
const { runEngine } = require('../engine/engine');
const { suggestSuppliers, preferredList } = require('../engine/preferred');
const { activePolicyFor, policyByVersion } = require('./policies');
const { dateOf, round2 } = require('../engine/util');

const OUT_COLUMNS = ['pr_no', 'pr_line', 'resolved_item_code', 'group_id', 'po_id', 'decision', 'route', 'supplier_id', 'unit_price', 'group_value_inr', 'suggested_supplier_ids', 'policy_version', 'reason'];
const REQUIRED = ['pr_no', 'created_at', 'plant', 'quantity'];

function parseBatchCsv(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  let rows;
  try {
    rows = parse(text, { columns: (h) => h.map((x) => String(x).trim().toLowerCase().replace(/\s+/g, '_')), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
  } catch (e) { const err = new Error(`Could not read the CSV: ${e.message}`); err.status = 400; throw err; }
  if (!rows.length) { const err = new Error('The CSV has no rows'); err.status = 400; throw err; }
  const missing = REQUIRED.filter((c) => !(c in rows[0]));
  if (missing.length) { const err = new Error(`CSV is missing columns: ${missing.join(', ')}. Expected: pr_no, pr_line, created_at, requester, department, plant, item_code, description, quantity, uom, estimated_unit_price, need_by_date, urgency`); err.status = 400; throw err; }
  return rows;
}

function toCsv(rows, cols) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}

function summarize(result) {
  const routes = {};
  for (const l of result.lines) routes[l.route] = (routes[l.route] || 0) + 1;
  return { lines: result.lines.length, requirements: result.requirements.length, pos: result.pos.length, routes };
}

function persistRun(db, { rows, result, source, filename, policy, asOf, actor }) {
  return tx(db, () => {
    const now = new Date().toISOString();
    const run = db.prepare('INSERT INTO runs (source, filename, policy_version, as_of, created_by, created_at, summary) VALUES (?,?,?,?,?,?,?)')
      .run(source, filename || '', policy.version, asOf, actor, now, JSON.stringify(summarize(result)));
    const runId = Number(run.lastInsertRowid);
    const st = db.prepare('INSERT INTO run_lines VALUES (?,?,?,?,?,?)');
    rows.forEach((r, i) => st.run(runId, i, String(r.pr_no || ''), String(r.pr_line ?? ''), JSON.stringify(r), JSON.stringify(result.lines[i])));
    const rq = db.prepare('INSERT INTO requirements (run_id, group_id, status, data, po_id) VALUES (?,?,?,?,?)');
    for (const r of result.requirements) rq.run(runId, r.group_id, 'PENDING', JSON.stringify(r), r.decision.po_id || '');
    audit(db, actor, 'process_batch', 'run', runId, { filename, policy_version: policy.version, ...summarize(result) });
    return runId;
  });
}

/** Process PR rows with the policy in force. Used by POST /api/process-batch. */
function processBatch(db, rows, { actor = 'api', filename = '', policyVersion = null, asOf = null, source = 'batch' } = {}) {
  const ds = loadDataset(db);
  const dates = rows.map((r) => dateOf(r.created_at)).filter(Boolean).sort();
  const as_of = asOf || dates[dates.length - 1] || new Date().toISOString().slice(0, 10);
  let policyFor;
  if (policyVersion) {
    const forced = policyByVersion(db, policyVersion);
    if (!forced) { const e = new Error(`Policy version ${policyVersion} not found`); e.status = 404; throw e; }
    policyFor = () => forced;
  } else policyFor = policyResolver(db);
  const result = runEngine({ ds, policyFor, lines: rows });
  const policy = { version: result.policy_version };
  const runId = persistRun(db, { rows, result, source, filename, policy, asOf: as_of, actor });
  const latest = policyFor(as_of);
  return { run_id: runId, policy_version: result.policy_version, policy_versions: result.policy_versions, policy_effective_from: latest.effective_from, as_of, summary: summarize(result), decisions: result.lines };
}

/** Cached lookup of the approved policy version in force on a date (latest effective_from on or before it). */
function policyResolver(db) {
  const cache = new Map();
  return (date) => {
    const d = date || '9999-12-31';
    if (!cache.has(d)) cache.set(d, activePolicyFor(db, d));
    return cache.get(d);
  };
}

function getRun(db, runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  if (!run) return null;
  const lines = db.prepare('SELECT result FROM run_lines WHERE run_id=? ORDER BY idx').all(runId).map((r) => JSON.parse(r.result));
  const reqs = db.prepare('SELECT * FROM requirements WHERE run_id=? ORDER BY group_id').all(runId).map(hydrate);
  const orders = db.prepare('SELECT * FROM orders WHERE run_id=? ORDER BY number').all(runId).map((o) => ({ ...o, groups: JSON.parse(o.groups), suggested: JSON.parse(o.suggested || '[]') }));
  return { ...run, summary: JSON.parse(run.summary), lines, requirements: reqs, orders };
}
function hydrate(r) {
  const data = JSON.parse(r.data);
  return { ...data, status: r.status, override: r.override ? JSON.parse(r.override) : null, decided_by: r.decided_by, decided_at: r.decided_at, order_number: r.order_number, run_id: r.run_id };
}

function effectiveDecision(req) {
  const d = { ...req.decision };
  if (req.override) {
    const o = req.override;
    d.route = o.route || d.route;
    d.decision = o.decision || d.decision;
    d.supplier_id = o.supplier_id !== undefined ? o.supplier_id : d.supplier_id;
    d.unit_price = o.unit_price !== undefined ? o.unit_price : d.unit_price;
    d.suggested_ids = o.suggested_ids || d.suggested_ids;
  }
  return d;
}

function ensureOrder(db, runId, req, d, actor) {
  const now = new Date().toISOString();
  if (d.decision === 'PO') {
    const poId = req.override && req.override.po_id_changed ? `${d.po_id}-OVR-${req.group_id}` : d.po_id;
    const number = `R${runId}-${poId}`;
    const ex = db.prepare('SELECT * FROM orders WHERE number=?').get(number);
    if (ex) {
      const g = JSON.parse(ex.groups); if (!g.includes(req.group_id)) g.push(req.group_id);
      db.prepare('UPDATE orders SET groups=? WHERE number=?').run(JSON.stringify(g), number);
    } else {
      db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(number, runId, 'PO', poId, d.supplier_id, req.plant, d.route, 'CREATED', JSON.stringify([req.group_id]), '[]', actor, now);
    }
    return number;
  }
  const kind = { RFQ: 'RFQ', RFP: 'RFP' }[d.route] || 'SOURCING';
  const number = `R${runId}-${kind}-${req.group_id}`;
  db.prepare('INSERT OR REPLACE INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(number, runId, kind, '', '', req.plant, d.route, 'CREATED', JSON.stringify([req.group_id]), JSON.stringify(d.suggested_ids || []), actor, now);
  return number;
}

function loadReq(db, runId, groupId) {
  const r = db.prepare('SELECT * FROM requirements WHERE run_id=? AND group_id=?').get(runId, groupId);
  if (!r) { const e = new Error('Requirement not found'); e.status = 404; throw e; }
  return hydrate(r);
}

function approve(db, runId, groupId, actor) {
  return tx(db, () => {
    const req = loadReq(db, runId, groupId);
    if (req.status !== 'PENDING') { const e = new Error(`Already ${req.status.toLowerCase()}`); e.status = 409; throw e; }
    const d = effectiveDecision(req);
    if (d.decision === 'PO') assertActiveSupplier(db, d.supplier_id);
    const number = ensureOrder(db, runId, req, d, actor);
    db.prepare("UPDATE requirements SET status='APPROVED', decided_by=?, decided_at=?, order_number=? WHERE run_id=? AND group_id=?").run(actor, new Date().toISOString(), number, runId, groupId);
    audit(db, actor, 'approve', 'requirement', `${runId}/${groupId}`, { route: d.route, order: number, policy_version: req.decision.policy_version, clause: req.decision.clause });
    return { group_id: groupId, status: 'APPROVED', order_number: number };
  });
}

function assertActiveSupplier(db, supplierId) {
  const s = db.prepare('SELECT * FROM suppliers WHERE supplier_id=?').get(supplierId);
  if (!s) { const e = new Error(`Supplier ${supplierId} not found`); e.status = 400; throw e; }
  if (s.status !== 'Active') { const e = new Error(`Supplier ${supplierId} is ${s.status}. Blocked or Inactive suppliers can never receive a PO or be suggested (policy 5.7).`); e.status = 400; throw e; }
}

const SOURCING_ROUTES = ['RFQ', 'RFP', 'CAPEX_SOURCING', 'NEW_ITEM_SOURCING'];
const PO_ROUTES = ['CONTRACT_PO', 'EMERGENCY_PO', 'SPOT_PO'];

function override(db, runId, groupId, actor, body) {
  const comment = String(body.comment || '').trim();
  if (comment.length < 5) { const e = new Error('An override needs a written reason (at least 5 characters).'); e.status = 400; throw e; }
  return tx(db, () => {
    const req = loadReq(db, runId, groupId);
    if (req.status !== 'PENDING') { const e = new Error(`Already ${req.status.toLowerCase()}`); e.status = 409; throw e; }
    const o = { comment, by: actor, at: new Date().toISOString(), original: { route: req.decision.route, decision: req.decision.decision, supplier_id: req.decision.supplier_id, unit_price: req.decision.unit_price } };
    const route = body.route || req.decision.route;
    if (![...SOURCING_ROUTES, ...PO_ROUTES].includes(route)) { const e = new Error(`Unknown route ${route}`); e.status = 400; throw e; }
    o.route = route;
    o.decision = PO_ROUTES.includes(route) ? 'PO' : 'SOURCING_REQUEST';
    if (o.decision === 'PO') {
      const sup = body.supplier_id || req.decision.supplier_id;
      if (!sup) { const e = new Error('Choose a supplier for the PO.'); e.status = 400; throw e; }
      assertActiveSupplier(db, sup);
      o.supplier_id = sup;
      let price = body.unit_price != null && body.unit_price !== '' ? Number(body.unit_price) : null;
      if (price == null) {
        if (sup === req.decision.supplier_id) price = req.decision.unit_price;
        else { const ref = (req.preferred || []).find((p) => p.supplier_id === sup); price = ref ? ref.reference_price : null; }
      }
      if (price == null || Number.isNaN(price)) { const e = new Error('Enter the unit price for this supplier.'); e.status = 400; throw e; }
      o.unit_price = round2(price);
      o.po_id_changed = route !== req.decision.route || sup !== req.decision.supplier_id;
    } else {
      let ids = body.suggested_supplier_ids ? String(body.suggested_supplier_ids).split(/[;,\s]+/).filter(Boolean) : null;
      if (ids) for (const id of ids) assertActiveSupplier(db, id);
      if (!ids && req.item_code !== 'NEW') {
        const ds = loadDataset(db); const pol = policyByVersion(db, req.decision.policy_version);
        const n = route === 'RFQ' ? 3 : 5;
        ids = suggestSuppliers(ds, ds.itemByCode.get(req.item_code), req.req_date, pol, n).map((s) => s.supplier_id);
      }
      o.suggested_ids = ids || []; o.supplier_id = ''; o.unit_price = null;
    }
    const merged = { ...req, override: o };
    const d = effectiveDecision(merged);
    const number = ensureOrder(db, runId, merged, d, actor);
    db.prepare("UPDATE requirements SET status='OVERRIDDEN', override=?, decided_by=?, decided_at=?, order_number=? WHERE run_id=? AND group_id=?")
      .run(JSON.stringify(o), actor, o.at, number, runId, groupId);
    audit(db, actor, 'override', 'requirement', `${runId}/${groupId}`, { comment, original: o.original, now: { route: o.route, supplier_id: o.supplier_id, unit_price: o.unit_price }, order: number });
    return { group_id: groupId, status: 'OVERRIDDEN', order_number: number };
  });
}

function approveAll(db, runId, actor, filter = {}) {
  const reqs = db.prepare("SELECT group_id FROM requirements WHERE run_id=? AND status='PENDING' ORDER BY group_id").all(runId);
  const done = [], failed = [];
  for (const r of reqs) {
    const req = loadReq(db, runId, r.group_id);
    if (filter.route && req.decision.route !== filter.route) continue;
    if (filter.decision && req.decision.decision !== filter.decision) continue;
    try { approve(db, runId, r.group_id, actor); done.push(r.group_id); } catch (e) { failed.push({ group_id: r.group_id, error: e.message }); }
  }
  return { approved: done.length, failed };
}

function exportRun(db, runId) {
  const run = getRun(db, runId);
  if (!run) return null;
  return toCsv(run.lines, OUT_COLUMNS);
}

module.exports = { parseBatchCsv, processBatch, getRun, approve, override, approveAll, exportRun, toCsv, OUT_COLUMNS, hydrate, persistRun, effectiveDecision, SOURCING_ROUTES, PO_ROUTES, summarize, policyResolver };
