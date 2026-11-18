'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadKit, ROOT } = require('./lib/files');
const { buildIndex } = require('./engine/engine');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (item_code TEXT PRIMARY KEY, description TEXT, uom TEXT, category TEXT, item_type TEXT, standard_price REAL);
CREATE TABLE IF NOT EXISTS suppliers (supplier_id TEXT PRIMARY KEY, name TEXT, city TEXT, categories TEXT, status TEXT, on_time_pct REAL, quality_rating REAL);
CREATE TABLE IF NOT EXISTS po_history (po_number TEXT PRIMARY KEY, po_date TEXT, supplier_id TEXT, item_code TEXT, quantity REAL, uom TEXT, unit_price REAL, plant TEXT, delivered_on_time TEXT);
CREATE TABLE IF NOT EXISTS plants (plant TEXT PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS contracts (contract_id TEXT PRIMARY KEY, supplier_id TEXT, start_date TEXT, end_date TEXT, value_cap REAL, consumed_value REAL, source TEXT, pdf_file TEXT, added_by TEXT, added_at TEXT);
CREATE TABLE IF NOT EXISTS contract_lines (contract_id TEXT, item_code TEXT, description TEXT, uom TEXT, rate REAL, PRIMARY KEY (contract_id, item_code));
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT UNIQUE, effective_from TEXT, status TEXT, body TEXT,
  base_version TEXT, changes TEXT, source_name TEXT, source_text TEXT, created_by TEXT, created_at TEXT, decided_by TEXT, decided_at TEXT, decision_note TEXT);
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, filename TEXT, policy_version TEXT, as_of TEXT, created_by TEXT, created_at TEXT, summary TEXT);
CREATE TABLE IF NOT EXISTS run_lines (run_id INTEGER, idx INTEGER, pr_no TEXT, pr_line TEXT, raw TEXT, result TEXT, PRIMARY KEY (run_id, idx));
CREATE TABLE IF NOT EXISTS requirements (run_id INTEGER, group_id TEXT, status TEXT, data TEXT, po_id TEXT, override TEXT, decided_by TEXT, decided_at TEXT, order_number TEXT, PRIMARY KEY (run_id, group_id));
CREATE TABLE IF NOT EXISTS orders (number TEXT PRIMARY KEY, run_id INTEGER, kind TEXT, po_id TEXT, supplier_id TEXT, plant TEXT, route TEXT, status TEXT, groups TEXT, suggested TEXT, created_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, action TEXT, entity TEXT, entity_id TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, kind TEXT, state TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_po_item ON po_history(item_code);
CREATE INDEX IF NOT EXISTS idx_req_run ON requirements(run_id);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA);
  return db;
}

const tx = (db, fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

function seed(db) {
  const has = db.prepare('SELECT COUNT(*) c FROM items').get().c;
  if (has) return;
  const kit = loadKit(ROOT);
  tx(db, () => {
    const ins = (sql, rows, map) => { const st = db.prepare(sql); for (const r of rows) st.run(...map(r)); };
    ins('INSERT INTO items VALUES (?,?,?,?,?,?)', kit.items, (r) => [r.item_code, r.description, r.uom, r.category, r.item_type, r.standard_price]);
    ins('INSERT INTO suppliers VALUES (?,?,?,?,?,?,?)', kit.suppliers, (r) => [r.supplier_id, r.name, r.city, r.categories.join(';'), r.status, r.on_time_pct, r.quality_rating]);
    ins('INSERT INTO po_history VALUES (?,?,?,?,?,?,?,?,?)', kit.pos, (r) => [r.po_number, r.po_date, r.supplier_id, r.item_code, r.quantity, r.uom, r.unit_price, r.plant, r.delivered_on_time]);
    ins('INSERT INTO plants VALUES (?,?)', kit.plants, (r) => [r.plant, r.name]);
    for (const c of kit.contracts) {
      db.prepare('INSERT INTO contracts VALUES (?,?,?,?,?,?,?,?,?,?)').run(c.contract_id, c.supplier_id, c.start_date, c.end_date, c.value_cap, c.consumed_value, 'register', null, 'system', new Date().toISOString());
      for (const l of c.lines) db.prepare('INSERT INTO contract_lines VALUES (?,?,?,?,?)').run(c.contract_id, l.item_code, l.description, l.uom, l.rate);
    }
    const pol = JSON.parse(fs.readFileSync(path.join(ROOT, 'policies', 'corvo_policy_v5.0.json'), 'utf8'));
    db.prepare('INSERT INTO policies (version, effective_from, status, body, source_name, created_by, created_at, decided_by, decided_at, decision_note) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(pol.version, pol.effective_from, 'approved', JSON.stringify(pol), 'Corvo_Procurement_Policy.pdf', 'system', new Date().toISOString(), 'system', new Date().toISOString(), 'Initial policy loaded from the kit');
  });
}

/** Load master data from the DB into an engine dataset. */
function loadDataset(db) {
  const items = db.prepare('SELECT * FROM items ORDER BY item_code').all();
  const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY supplier_id').all().map((s) => ({ ...s, categories: String(s.categories || '').split(';').filter(Boolean) }));
  const pos = db.prepare('SELECT * FROM po_history').all();
  const plants = db.prepare('SELECT * FROM plants').all();
  const lines = db.prepare('SELECT * FROM contract_lines').all();
  const contracts = db.prepare('SELECT * FROM contracts ORDER BY contract_id').all().map((c) => ({ ...c, lines: lines.filter((l) => l.contract_id === c.contract_id) }));
  return buildIndex({ items, suppliers, pos, plants, contracts });
}

function audit(db, actor, action, entity, entityId, detail) {
  db.prepare('INSERT INTO audit (ts, actor, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)')
    .run(new Date().toISOString(), actor || 'unknown', action, entity, String(entityId ?? ''), JSON.stringify(detail || {}));
}

function getSetting(db, key, dflt) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : dflt;
}
function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

/** "Today" for the app. Demo data is in Nov 2026, so it can be pinned with APP_TODAY or in Settings. */
function appToday(db) {
  const s = getSetting(db, 'today', process.env.APP_TODAY || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10);
}

module.exports = { open, seed, loadDataset, audit, tx, getSetting, setSetting, appToday };
