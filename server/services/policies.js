'use strict';
// Versioned policy storage: propose from a document or chat message, show the diff, approve with an effective date.
const { audit, appToday, tx } = require('../db');
const { applyOps, diffPolicies, readChange, validatePolicy } = require('../lib/policyChange');
const { clone } = require('../engine/util');

const parseRow = (r) => r && { ...r, body: JSON.parse(r.body), changes: r.changes ? JSON.parse(r.changes) : null };

/** The approved version in force on `date` (latest effective_from <= date). */
function activePolicyFor(db, date) {
  const r = db.prepare("SELECT * FROM policies WHERE status='approved' AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1").get(date)
    || db.prepare("SELECT * FROM policies WHERE status='approved' ORDER BY effective_from ASC, id ASC LIMIT 1").get();
  return r ? { ...JSON.parse(r.body), version: r.version, effective_from: r.effective_from } : null;
}
function latestApproved(db) {
  const r = db.prepare("SELECT * FROM policies WHERE status='approved' ORDER BY effective_from DESC, id DESC LIMIT 1").get();
  return { ...JSON.parse(r.body), version: r.version, effective_from: r.effective_from };
}
function policyByVersion(db, version) {
  const r = db.prepare("SELECT * FROM policies WHERE version=? AND status='approved'").get(String(version));
  return r ? { ...JSON.parse(r.body), version: r.version, effective_from: r.effective_from } : null;
}
function listPolicies(db) {
  return db.prepare('SELECT * FROM policies ORDER BY id DESC').all().map(parseRow).map((p) => ({ ...p, rules: p.body.rules.length }));
}
function getPolicy(db, id) { return parseRow(db.prepare('SELECT * FROM policies WHERE id=?').get(id)); }

function nextVersion(db, base, wanted) {
  const exists = (v) => db.prepare('SELECT 1 FROM policies WHERE version=?').get(v);
  if (wanted && !exists(wanted)) return String(wanted);
  const [maj, min] = String(base).split('.').map(Number);
  let m = (min || 0) + 1;
  while (exists(`${maj}.${m}`)) m++;
  return `${maj}.${m}`;
}

function context(db) {
  return {
    plants: db.prepare('SELECT * FROM plants').all(),
    categories: [...new Set(db.prepare('SELECT category FROM items').all().map((r) => r.category))]
  };
}

/**
 * text: document text or chat message. file JSON: a complete policy, or {changes:[ops]}.
 * Creates a 'proposed' version; nothing changes until it is approved.
 */
async function propose(db, { text, sourceName, actor, effectiveFrom, ops: givenOps, fullPolicy }) {
  const base = latestApproved(db);
  let ops = givenOps || [];
  let reader = { notes: [], unread: [], engine: 'manual' };
  let next;
  if (fullPolicy) {
    next = clone(fullPolicy);
    reader = { notes: ['Complete policy document supplied as JSON.'], unread: [], engine: 'json' };
  } else {
    if (!ops.length) reader = await readChange(text || '', base, context(db));
    if (!ops.length) ops = reader.ops;
    if (!ops.length && !reader.effective_from) {
      const e = new Error('I could not find any policy change in that text. Try: "Change the spot PO limit from 2,00,000 to 3,00,000, effective 1 December 2026" or upload a JSON patch.');
      e.status = 422; e.unread = reader.unread; throw e;
    }
    try { next = applyOps(base, ops).policy; } catch (err) { err.status = 422; throw err; }
  }
  const effective = effectiveFrom || reader.effective_from || next.effective_from || appToday(db);
  const version = nextVersion(db, base.version, fullPolicy ? fullPolicy.version : reader.version);
  next.version = version; next.effective_from = effective;
  const errors = validatePolicy(next);
  if (errors.length) { const e = new Error('The resulting policy is not valid: ' + errors.join('; ')); e.status = 422; throw e; }
  const diff = diffPolicies(base, next);
  const changes = { ops, diff, notes: reader.notes, unread: reader.unread, engine: reader.engine, base_version: base.version };
  const id = Number(db.prepare('INSERT INTO policies (version, effective_from, status, body, base_version, changes, source_name, source_text, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(version, effective, 'proposed', JSON.stringify(next), base.version, JSON.stringify(changes), sourceName || 'chat', (text || '').slice(0, 50000), actor, new Date().toISOString()).lastInsertRowid);
  audit(db, actor, 'propose_policy', 'policy', id, { version, base: base.version, effective_from: effective, changes: diff.length });
  return getPolicy(db, id);
}

function approvePolicy(db, id, actor, { effectiveFrom, note } = {}) {
  return tx(db, () => {
    const p = getPolicy(db, id);
    if (!p) { const e = new Error('Policy proposal not found'); e.status = 404; throw e; }
    if (p.status !== 'proposed') { const e = new Error(`This version is already ${p.status}`); e.status = 409; throw e; }
    const eff = effectiveFrom || p.effective_from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) { const e = new Error('Effective date must be YYYY-MM-DD'); e.status = 400; throw e; }
    const body = p.body; body.effective_from = eff;
    db.prepare("UPDATE policies SET status='approved', effective_from=?, body=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?")
      .run(eff, JSON.stringify(body), actor, new Date().toISOString(), note || '', id);
    audit(db, actor, 'approve_policy', 'policy', id, { version: p.version, effective_from: eff, note });
    return getPolicy(db, id);
  });
}
function rejectPolicy(db, id, actor, note) {
  const p = getPolicy(db, id);
  if (!p || p.status !== 'proposed') { const e = new Error('Only a proposed version can be rejected'); e.status = 409; throw e; }
  db.prepare("UPDATE policies SET status='rejected', decided_by=?, decided_at=?, decision_note=? WHERE id=?").run(actor, new Date().toISOString(), note || '', id);
  audit(db, actor, 'reject_policy', 'policy', id, { version: p.version, note });
  return getPolicy(db, id);
}

module.exports = { latestApproved, activePolicyFor, policyByVersion, listPolicies, getPolicy, propose, approvePolicy, rejectPolicy, context };
