'use strict';
const path = require('path');
const express = require('express');
const multer = require('multer');
const { open, seed, loadDataset, tx, getSetting, setSetting, appToday } = require('./db');
const runs = require('./services/runs');
const pol = require('./services/policies');
const contracts = require('./services/contracts');
const chat = require('./services/chat');
const { preferredList } = require('./engine/preferred');
const { runEngine } = require('./engine/engine');
const { diffPolicies } = require('./lib/policyChange');
const { dateOf } = require('./engine/util');

function createApp(db) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
  app.use(express.json({ limit: '5mb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));
  const actor = (req) => String(req.get('x-user') || req.query.user || 'anonymous').slice(0, 60);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const api = express.Router();

  api.get('/meta', (req, res) => {
    const plants = db.prepare('SELECT * FROM plants').all();
    const active = pol.activePolicyFor(db, appToday(db));
    res.json({ today: appToday(db), plants, active_policy: { version: active.version, effective_from: active.effective_from },
      llm: !!process.env.LLM_API_KEY, routes: { po: runs.PO_ROUTES, sourcing: runs.SOURCING_ROUTES } });
  });
  api.post('/settings/today', (req, res) => {
    const d = dateOf(req.body && req.body.today);
    if (!d) return res.status(400).json({ error: 'today must be YYYY-MM-DD' });
    setSetting(db, 'today', d); res.json({ today: d });
  });

  // ---- batch processing
  api.post('/process-batch', upload.single('file'), wrap(async (req, res) => {
    let buf = req.file ? req.file.buffer : (typeof req.body === 'string' ? req.body : null);
    if (!buf) return res.status(400).json({ error: 'Send the PR batch CSV as a multipart field "file" or as a text/csv body.' });
    const rows = runs.parseBatchCsv(buf);
    const out = runs.processBatch(db, rows, { actor: actor(req), filename: req.file ? req.file.originalname : 'api-upload.csv', policyVersion: req.query.policy_version || null, asOf: req.query.as_of || null });
    if (req.query.format === 'csv' || /text\/csv/.test(req.get('accept') || '')) {
      res.type('text/csv').attachment(`decisions_run${out.run_id}.csv`).send(runs.toCsv(out.decisions, runs.OUT_COLUMNS));
    } else res.json(out);
  }));

  api.get('/runs', (req, res) => {
    const rows = db.prepare('SELECT r.*, (SELECT COUNT(*) FROM requirements q WHERE q.run_id=r.id) reqs, (SELECT COUNT(*) FROM requirements q WHERE q.run_id=r.id AND q.status=\'PENDING\') pending FROM runs r ORDER BY id DESC').all();
    res.json(rows.map((r) => ({ ...r, summary: JSON.parse(r.summary || '{}') })));
  });
  api.get('/runs/:id', (req, res) => {
    const r = runs.getRun(db, Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'Run not found' });
    res.json(r);
  });
  api.get('/runs/:id/export.csv', (req, res) => {
    const csv = runs.exportRun(db, Number(req.params.id));
    if (csv == null) return res.status(404).json({ error: 'Run not found' });
    res.type('text/csv').attachment(`decisions_run${req.params.id}.csv`).send(csv);
  });
  api.post('/runs/:id/requirements/:group/approve', (req, res) => res.json(runs.approve(db, Number(req.params.id), req.params.group, actor(req))));
  api.post('/runs/:id/requirements/:group/override', (req, res) => res.json(runs.override(db, Number(req.params.id), req.params.group, actor(req), req.body || {})));
  api.post('/runs/:id/approve-all', (req, res) => res.json(runs.approveAll(db, Number(req.params.id), actor(req), req.body || {})));
  api.get('/suppliers', (req, res) => res.json(db.prepare('SELECT * FROM suppliers ORDER BY supplier_id').all()));
  api.get('/items', (req, res) => res.json(db.prepare('SELECT * FROM items ORDER BY item_code').all()));

  // ---- preferred suppliers
  api.get('/preferred', (req, res) => {
    const asOf = dateOf(req.query.as_of) || appToday(db);
    const policy = pol.activePolicyFor(db, asOf);
    const ds = loadDataset(db);
    const items = req.query.item_code ? ds.items.filter((i) => i.item_code === req.query.item_code) : ds.items;
    res.json({ as_of: asOf, policy_version: policy.version, weights: policy.parameters.ranking.weights,
      items: items.map((i) => ({ item_code: i.item_code, description: i.description, category: i.category, list: preferredList(ds, i.item_code, asOf, policy) })) });
  });
  api.get('/preferred/export.csv', (req, res) => {
    const asOf = dateOf(req.query.as_of) || appToday(db);
    const policy = pol.activePolicyFor(db, asOf);
    const top = Math.max(1, Math.min(10, Number(req.query.top) || 3));
    const ds = loadDataset(db);
    const rows = [];
    for (const i of ds.items) for (const r of preferredList(ds, i.item_code, asOf, policy).slice(0, top)) rows.push({ item_code: i.item_code, rank: r.rank, supplier_id: r.supplier_id, reference_price: r.reference_price });
    res.type('text/csv').attachment(`preferred_suppliers_${asOf}.csv`).send(runs.toCsv(rows, ['item_code', 'rank', 'supplier_id', 'reference_price']));
  });

  // ---- contracts
  api.get('/contracts', (req, res) => res.json(contracts.listContracts(db)));
  api.post('/contracts', (req, res) => res.json({ contract_id: contracts.addContract(db, req.body, actor(req), null) }));
  api.post('/contracts/extract', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Upload the contract PDF as field "file"' });
    const ds = loadDataset(db);
    const draft = await contracts.extractFromPdf(req.file.buffer, ds.itemByCode);
    res.json({ draft, pdf_name: req.file.originalname });
  }));
  api.post('/contracts/from-pdf', (req, res) => res.json({ contract_id: contracts.addContract(db, req.body.contract, actor(req), req.body.pdf_name || 'uploaded.pdf') }));

  // ---- policy
  api.get('/policies', (req, res) => res.json(pol.listPolicies(db)));
  api.get('/policies/:id', (req, res) => {
    const p = pol.getPolicy(db, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  });
  api.post('/policies/propose', upload.single('file'), wrap(async (req, res) => {
    let text = req.body && req.body.text, name = (req.body && req.body.source_name) || 'chat', fullPolicy = null, ops = null;
    if (req.file) {
      name = req.file.originalname;
      const isPdf = /\.pdf$/i.test(name) || req.file.mimetype === 'application/pdf';
      if (isPdf) text = (await require('pdf-parse')(req.file.buffer)).text;
      else text = req.file.buffer.toString('utf8');
      if (/\.json$/i.test(name)) {
        let j; try { j = JSON.parse(text); } catch (e) { return res.status(400).json({ error: `Not valid JSON: ${e.message}` }); }
        if (Array.isArray(j)) ops = j; else if (j.changes || j.ops) ops = j.changes || j.ops; else if (j.rules) fullPolicy = j; else return res.status(400).json({ error: 'JSON must be a complete policy ({rules, parameters}) or {"changes":[...]}' });
        if (j.effective_from && !fullPolicy) req.body.effective_from = j.effective_from;
      }
    }
    if (!text && !ops && !fullPolicy) return res.status(400).json({ error: 'Describe the change or upload a document.' });
    const p = await pol.propose(db, { text, sourceName: name, actor: actor(req), effectiveFrom: dateOf(req.body && req.body.effective_from), ops, fullPolicy });
    res.json(p);
  }));
  api.get('/policies/:id/impact', (req, res) => {
    const p = pol.getPolicy(db, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const last = db.prepare("SELECT id FROM runs WHERE source='batch' ORDER BY id DESC LIMIT 1").get();
    if (!last) return res.json({ available: false });
    const rows = db.prepare('SELECT raw FROM run_lines WHERE run_id=? ORDER BY idx').all(last.id).map((r) => JSON.parse(r.raw));
    const ds = loadDataset(db);
    const before = runs.policyResolver(db);
    const proposed = { ...p.body, version: p.version, effective_from: p.effective_from };
    const after = (d) => (d && d >= p.effective_from ? proposed : before(d));
    const a = runEngine({ ds, policyFor: before, lines: rows });
    const b = runEngine({ ds, policyFor: after, lines: rows });
    const notCovered = rows.filter((r) => (dateOf(r.created_at) || '') < p.effective_from).length;
    const changed = [];
    a.lines.forEach((l, i) => { if (l.route !== b.lines[i].route || l.supplier_id !== b.lines[i].supplier_id) changed.push({ pr_no: l.pr_no, pr_line: l.pr_line, item: l.resolved_item_code, before: `${l.route} ${l.supplier_id || l.suggested_supplier_ids}`.trim(), after: `${b.lines[i].route} ${b.lines[i].supplier_id || b.lines[i].suggested_supplier_ids}`.trim() }); });
    res.json({ available: true, run_id: last.id, lines: rows.length, effective_from: p.effective_from, lines_before_effective: notCovered, changed_lines: changed.length, examples: changed.slice(0, 12) });
  });
  api.post('/policies/:id/approve', (req, res) => res.json(pol.approvePolicy(db, Number(req.params.id), actor(req), { effectiveFrom: dateOf(req.body && req.body.effective_from), note: req.body && req.body.note })));
  api.put('/policies/:id', (req, res) => res.json(pol.updateProposal(db, Number(req.params.id), req.body, actor(req))));
  api.post('/policies/:id/reject', (req, res) => res.json(pol.rejectPolicy(db, Number(req.params.id), actor(req), req.body && req.body.note)));

  // ---- chat
  api.post('/chat', wrap(async (req, res) => {
    const { session_id, message } = req.body || {};
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    res.json(await chat.handleMessage(db, String(session_id), message, actor(req)));
  }));
  api.post('/chat/reset', (req, res) => { db.prepare('DELETE FROM chat_sessions WHERE id=?').run(String((req.body || {}).session_id || '')); res.json({ ok: true }); });

  api.get('/audit', (req, res) => {
    const rows = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(Number(req.query.limit) || 200, 1000));
    res.json(rows.map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') })));
  });

  api.use((req, res) => res.status(404).json({ error: 'Unknown API route' }));
  app.use('/api', api);
  app.get('/healthz', (req, res) => res.send('ok'));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((err, req, res, next) => { // eslint-disable-line
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || 'Server error', unread: err.unread });
  });
  return app;
}

if (require.main === module) {
  const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');
  const db = open(dbFile);
  seed(db);
  contracts.seedPdfContracts(db, path.join(__dirname, '..', 'contracts', 'pdf')).then((a) => a.length && console.log('Loaded PDF-only contracts:', a.join(', '))).catch((e) => console.error('PDF contract load failed', e.message));
  const port = Number(process.env.PORT) || 3000;
  createApp(db).listen(port, () => console.log(`Corvo PR-to-PO app on http://localhost:${port} (db ${dbFile})`));
}

module.exports = { createApp };
