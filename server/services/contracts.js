'use strict';
// Contracts: list, add manually, extract from a signed PDF.
const { audit, tx } = require('../db');

const clean = (s) => s.replace(/\s+/g, ' ');
const money = (s) => Number(String(s).replace(/,/g, ''));

/** Pull the fields out of a Corvo rate contract PDF (text layer). Returns a draft the buyer confirms. */
async function extractFromPdf(buffer, itemsByCode) {
  const pdf = require('pdf-parse');
  const { text } = await pdf(buffer);
  const t = text.replace(/\u00a0/g, ' ');
  const flat = clean(t);
  const warnings = [];
  const id = /Contract No\.?\s*([A-Z]{2}-\d{4}-\d{3})/i.exec(flat);
  const sup = /\(Supplier ID\s*(S\d+)\)/i.exec(flat);
  const term = /valid from\s*(\d{4}-\d{2}-\d{2})\s*to\s*(\d{4}-\d{2}-\d{2})/i.exec(flat);
  const cap = /shall not exceed INR\s*([\d,]+(?:\.\d+)?)/i.exec(flat);
  const lines = [];
  const sched = t.slice(t.search(/Schedule A/i));
  for (const row of sched.split(/\n/)) {
    const m = /^\s*\d+\s*(ITM-\d{4})(.*?)([\d,]+\.\d{2})\s*$/.exec(row.trim());
    if (!m) continue;
    const item = itemsByCode.get(m[1]);
    if (!item) { warnings.push(`Item ${m[1]} is not in the item master`); }
    lines.push({ item_code: m[1], description: item ? item.description : m[2].trim(), uom: item ? item.uom : '', rate: money(m[3]) });
  }
  if (!id) warnings.push('Contract number not found');
  if (!sup) warnings.push('Supplier ID not found');
  if (!term) warnings.push('Validity dates not found');
  if (!cap) warnings.push('Value ceiling not found');
  if (!lines.length) warnings.push('No rate lines found in Schedule A');
  return {
    contract_id: id ? id[1].toUpperCase() : '', supplier_id: sup ? sup[1] : '', start_date: term ? term[1] : '', end_date: term ? term[2] : '',
    value_cap: cap ? money(cap[1]) : null, consumed_value: 0, lines, warnings
  };
}

function validateContract(db, c) {
  const errs = [];
  if (!/^[A-Za-z0-9-]{4,}$/.test(c.contract_id || '')) errs.push('contract_id is required');
  const sup = db.prepare('SELECT * FROM suppliers WHERE supplier_id=?').get(c.supplier_id);
  if (!sup) errs.push(`supplier ${c.supplier_id || '(blank)'} is not in the supplier master`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.start_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(c.end_date || '')) errs.push('start and end dates must be YYYY-MM-DD');
  else if (c.end_date < c.start_date) errs.push('end date is before start date');
  if (!(Number(c.value_cap) > 0)) errs.push('value ceiling must be greater than 0');
  if (!Array.isArray(c.lines) || !c.lines.length) errs.push('at least one item rate line is required');
  else for (const l of c.lines) {
    if (!db.prepare('SELECT 1 FROM items WHERE item_code=?').get(l.item_code)) errs.push(`item ${l.item_code} is not in the item master`);
    if (!(Number(l.rate) > 0)) errs.push(`rate for ${l.item_code} must be greater than 0`);
  }
  return errs;
}

function addContract(db, c, actor, pdfName) {
  const errs = validateContract(db, c);
  if (db.prepare('SELECT 1 FROM contracts WHERE contract_id=?').get(c.contract_id)) errs.push(`contract ${c.contract_id} already exists`);
  if (errs.length) { const e = new Error(errs.join('; ')); e.status = 400; throw e; }
  tx(db, () => {
    db.prepare('INSERT INTO contracts VALUES (?,?,?,?,?,?,?,?,?,?)').run(c.contract_id, c.supplier_id, c.start_date, c.end_date, Number(c.value_cap), Number(c.consumed_value || 0), pdfName ? 'pdf' : 'manual', pdfName || null, actor, new Date().toISOString());
    const st = db.prepare('INSERT INTO contract_lines VALUES (?,?,?,?,?)');
    for (const l of c.lines) st.run(c.contract_id, l.item_code, l.description || '', l.uom || '', Number(l.rate));
    audit(db, actor, 'add_contract', 'contract', c.contract_id, { supplier_id: c.supplier_id, source: pdfName ? 'pdf' : 'manual', lines: c.lines.length, value_cap: c.value_cap });
  });
  return c.contract_id;
}

function listContracts(db) {
  const lines = db.prepare('SELECT * FROM contract_lines').all();
  const sup = new Map(db.prepare('SELECT supplier_id, name, status FROM suppliers').all().map((s) => [s.supplier_id, s]));
  return db.prepare('SELECT * FROM contracts ORDER BY contract_id').all().map((c) => ({
    ...c, supplier_name: (sup.get(c.supplier_id) || {}).name, supplier_status: (sup.get(c.supplier_id) || {}).status,
    lines: lines.filter((l) => l.contract_id === c.contract_id)
  }));
}

/** Contracts signed after the last register update exist only as PDFs in contracts/pdf: load them on first start. */
async function seedPdfContracts(db, dir) {
  const fs = require('fs'); const path = require('path');
  if (!fs.existsSync(dir)) return [];
  const itemsByCode = new Map(db.prepare('SELECT * FROM items').all().map((i) => [i.item_code, i]));
  const added = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.pdf$/i.test(x))) {
    const id = f.replace(/\.pdf$/i, '');
    if (db.prepare('SELECT 1 FROM contracts WHERE contract_id=?').get(id)) continue;
    const draft = await extractFromPdf(fs.readFileSync(path.join(dir, f)), itemsByCode);
    if (draft.warnings.length) { console.warn(`Contract PDF ${f}: ${draft.warnings.join('; ')}`); continue; }
    addContract(db, draft, 'system', f);
    added.push(id);
  }
  return added;
}

module.exports = { seedPdfContracts, extractFromPdf, addContract, listContracts, validateContract };
