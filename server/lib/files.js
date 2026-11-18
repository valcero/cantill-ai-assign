'use strict';
// Reads the kit CSVs (used to seed the database and by tests).
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const ROOT = path.resolve(__dirname, '..', '..');
const readCsv = (p) => parse(fs.readFileSync(p), { columns: true, skip_empty_lines: true, trim: true, bom: true });
const n = (x) => (x === '' || x == null ? null : Number(x));

function loadKit(root = ROOT) {
  const items = readCsv(path.join(root, 'master_data', 'item_master.csv')).map((r) => ({ ...r, standard_price: n(r.standard_price) }));
  const suppliers = readCsv(path.join(root, 'master_data', 'supplier_master.csv')).map((r) => ({
    ...r, categories: String(r.categories || '').split(';').map((x) => x.trim()).filter(Boolean), on_time_pct: n(r.on_time_pct), quality_rating: n(r.quality_rating)
  }));
  const pos = readCsv(path.join(root, 'master_data', 'po_history.csv')).map((r) => ({ ...r, quantity: n(r.quantity), unit_price: n(r.unit_price) }));
  const plants = readCsv(path.join(root, 'master_data', 'plants.csv'));
  const reg = readCsv(path.join(root, 'contracts', 'contract_register.csv'));
  const lines = readCsv(path.join(root, 'contracts', 'contract_lines.csv'));
  const contracts = reg.map((c) => ({
    contract_id: c.contract_id, supplier_id: c.supplier_id, start_date: c.start_date, end_date: c.end_date,
    value_cap: n(c.value_cap), consumed_value: n(c.consumed_value), source: 'register',
    lines: lines.filter((l) => l.contract_id === c.contract_id).map((l) => ({ item_code: l.item_code, description: l.description, uom: l.uom, rate: n(l.rate) }))
  }));
  return { items, suppliers, pos, plants, contracts };
}
const loadSamplePrs = (root = ROOT) => readCsv(path.join(root, 'pr_batches', 'sample_pr_batch.csv'));

module.exports = { ROOT, readCsv, loadKit, loadSamplePrs };
