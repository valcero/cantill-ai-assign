'use strict';
// End-to-end checks of the decision engine against the kit's worked examples (Worked_Examples.pdf),
// plus policy-as-data behaviour. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { open, seed, loadDataset } = require('../server/db');
const runs = require('../server/services/runs');
const pol = require('../server/services/policies');
const contracts = require('../server/services/contracts');
const { preferredList } = require('../server/engine/preferred');
const { matchItem } = require('../server/engine/matcher');

const ROOT = path.join(__dirname, '..');
const batch = runs.parseBatchCsv(fs.readFileSync(path.join(ROOT, 'pr_batches', 'sample_pr_batch.csv')));

async function freshDb() {
  const db = open(':memory:');
  seed(db);
  await contracts.seedPdfContracts(db, path.join(ROOT, 'contracts', 'pdf'));
  return db;
}
const byPr = (decisions) => new Map(decisions.map((d) => [`${d.pr_no}/${d.pr_line}`, d]));

test('worked examples under policy v5.0', async (t) => {
  const db = await freshDb();
  const out = runs.processBatch(db, batch, { actor: 'test' });
  const D = byPr(out.decisions);
  const expect = (pr, route, extra = {}) => {
    const d = D.get(`${pr}/1`);
    assert.ok(d, `${pr} missing`);
    assert.equal(d.route, route, `${pr} route`);
    if (extra.supplier) assert.equal(d.supplier_id, extra.supplier, `${pr} supplier`);
    if (extra.price) assert.equal(Math.round(d.unit_price), extra.price, `${pr} unit price`);
    if (extra.value) assert.equal(Math.round(d.group_value_inr), extra.value, `${pr} value`);
    if (extra.suggested) assert.equal(d.suggested_supplier_ids, extra.suggested, `${pr} suggestions`);
    if (extra.item) assert.equal(d.resolved_item_code, extra.item, `${pr} item`);
    return d;
  };
  await t.test('1 contract PO', () => expect('PR-26-00019', 'CONTRACT_PO', { supplier: 'S001', price: 9169, value: 137531 }));
  await t.test('2 PDF-only contract', () => expect('PR-26-00045', 'CONTRACT_PO', { supplier: 'S021', price: 2439, value: 26829 }));
  await t.test('3 contract ceiling used up, valued at lowest contract rate', () => {
    const a = expect('PR-26-00004', 'RFQ', { value: 220256, suggested: 'S014;S013;S016', item: 'ITM-1022' });
    assert.equal(a.group_id, D.get('PR-26-00026/1').group_id, 'clubbed with PR-26-00026');
  });
  await t.test('4 two contracts: lowest rate with room', () => expect('PR-26-00034', 'CONTRACT_PO', { supplier: 'S007', price: 7, value: 32547 }));
  await t.test('5 split PRs clubbed', () => {
    const d = expect('PR-26-00146', 'SPOT_PO', { supplier: 'S024', price: 166, value: 126472 });
    assert.equal(D.get('PR-26-00144/1').group_id, d.group_id);
    assert.equal(D.get('PR-26-00145/1').group_id, d.group_id);
  });
  await t.test('6 same item, different plants: not clubbed', () => {
    const a = expect('PR-26-00106', 'SPOT_PO', { supplier: 'S027', price: 22, value: 156170 });
    assert.notEqual(a.group_id, D.get('PR-26-00103/1').group_id);
  });
  await t.test('7 free text matched', () => expect('PR-26-00088', 'SPOT_PO', { supplier: 'S023', price: 392, value: 97955, item: 'ITM-1035' }));
  await t.test('8 emergency PO', () => expect('PR-26-00059', 'EMERGENCY_PO', { supplier: 'S014', price: 106, value: 253184 }));
  await t.test('9 RFQ above PO limit', () => expect('PR-26-00089', 'RFQ', { value: 336562, suggested: 'S043;S044;S042' }));
  await t.test('10 RFQ small but never bought', () => expect('PR-26-00050', 'RFQ', { value: 80300, suggested: 'S003;S002;S005' }));
  await t.test('11 RFP', () => expect('PR-26-00100', 'RFP', { value: 2070780, suggested: 'S020;S017;S019;S018' }));
  await t.test('12 capex', () => expect('PR-26-00047', 'CAPEX_SOURCING', { value: 6036704, suggested: 'S045;S047;S020;S048;S046' }));
  await t.test('13 new item', () => {
    const d = expect('PR-26-00170', 'NEW_ITEM_SOURCING', { value: 141100, item: 'NEW' });
    assert.equal(d.suggested_supplier_ids, '');
  });
  await t.test('14 several requirements on one PO', () => {
    const ids = ['PR-26-00031', 'PR-26-00035', 'PR-26-00034', 'PR-26-00032'].map((p) => D.get(`${p}/1`));
    assert.equal(new Set(ids.map((d) => d.po_id)).size, 1);
    assert.equal(new Set(ids.map((d) => d.group_id)).size, 2);
    assert.equal(Math.round(D.get('PR-26-00031/1').group_value_inr), 23227);
  });
  await t.test('blocked or inactive suppliers never used or suggested (5.7)', () => {
    const bad = new Set(db.prepare("SELECT supplier_id FROM suppliers WHERE status != 'Active'").all().map((r) => r.supplier_id));
    for (const d of out.decisions) {
      assert.ok(!bad.has(d.supplier_id), `${d.pr_no} PO to ${d.supplier_id}`);
      for (const s of String(d.suggested_supplier_ids).split(';').filter(Boolean)) assert.ok(!bad.has(s), `${d.pr_no} suggests ${s}`);
    }
  });
  await t.test('invalid lines are NOT_PROCESSED with a reason', () => {
    const np = out.decisions.filter((d) => d.route === 'NOT_PROCESSED');
    assert.ok(np.length >= 1);
    for (const d of np) assert.match(d.reason, /Not processed/);
  });
});

test('preferred supplier lists match the worked rankings', async () => {
  const db = await freshDb();
  const ds = loadDataset(db);
  const p = pol.activePolicyFor(db, '2026-11-01');
  const ids = (item) => preferredList(ds, item, '2026-11-01', p).map((r) => r.supplier_id);
  assert.deepEqual(ids('ITM-1048'), ['S029', 'S030']);
  assert.deepEqual(ids('ITM-1036'), ['S023', 'S022', 'S024']);
  assert.deepEqual(ids('ITM-1016'), ['S009', 'S010']);
});

test('item matching copes with short forms and does not invent items', async () => {
  const db = await freshDb();
  const ds = loadDataset(db);
  assert.equal(matchItem('brg 6205 2rs', ds.items).best.item_code, 'ITM-1021');
  assert.equal(matchItem('hyd hose 1/2 inch 2 wire', ds.items).best.item_code, 'ITM-1035');
  assert.equal(matchItem('brg 6299', ds.items).best, null);
  assert.equal(matchItem('Drinking water purifier 50 LPH', ds.items).best, null);
});

test('policy amendment changes decisions without code changes', async () => {
  const db = await freshDb();
  const before = byPr(runs.processBatch(db, batch, { actor: 'test' }).decisions);
  assert.equal(before.get('PR-26-00089/1').route, 'RFQ'); // value 3,36,562
  const p = await pol.propose(db, { text: 'Version 5.1, effective 1 November 2026. The spot PO limit is raised from Rs 2,00,000 to Rs 4,00,000.', actor: 'proc' });
  assert.equal(p.status, 'proposed');
  assert.equal(p.version, '5.1');
  // nothing changes until approval
  assert.equal(byPr(runs.processBatch(db, batch, { actor: 'test' }).decisions).get('PR-26-00089/1').route, 'RFQ');
  pol.approvePolicy(db, p.id, 'head');
  const after = byPr(runs.processBatch(db, batch, { actor: 'test' }).decisions);
  assert.equal(after.get('PR-26-00089/1').route, 'SPOT_PO');
  assert.equal(after.get('PR-26-00089/1').policy_version, '5.1');
});

test('a new version applies only to requirements dated on or after its effective date', async () => {
  const db = await freshDb();
  const p = await pol.propose(db, { text: 'Effective 4 November 2026: the spot PO limit is reduced from Rs 2,00,000 to Rs 50,000.', actor: 'proc' });
  pol.approvePolicy(db, p.id, 'head');
  const D = byPr(runs.processBatch(db, batch, { actor: 'test' }).decisions);
  // Example 5 hydraulic oil: requirement date 2 Nov, value 1,26,472 -> still v5.0 spot PO
  assert.equal(D.get('PR-26-00146/1').policy_version, '5.0');
  assert.equal(D.get('PR-26-00146/1').route, 'SPOT_PO');
  // Example 7 hose: requirement date 6 Nov, value 97,955 -> v5.1, above the new 50,000 limit -> RFQ
  assert.equal(D.get('PR-26-00088/1').policy_version, '5.1');
  assert.equal(D.get('PR-26-00088/1').route, 'RFQ');
});

test('a plant-only rule can be added from plain language', async () => {
  const db = await freshDb();
  const p = await pol.propose(db, { text: 'Effective 1 November 2026: for plant CHK1, all Safety & PPE requirements above Rs 50,000 must go to RFQ.', actor: 'proc' });
  const rule = p.body.rules.find((r) => r.id.startsWith('N'));
  assert.ok(rule, 'new rule added');
  assert.deepEqual(rule.when.all.slice(0, 2), [{ field: 'plant', op: 'eq', value: 'CHK1' }, { field: 'category', op: 'eq', value: 'Safety & PPE' }]);
  assert.equal(rule.outcome.route, 'RFQ');
});

test('a proposal can be corrected by hand and is re-validated', async () => {
  const db = await freshDb();
  const p = await pol.propose(db, { text: 'Effective 1 December 2026: the spot PO limit is raised from Rs 2,00,000 to Rs 3,00,000.', actor: 'proc' });
  const body = JSON.parse(JSON.stringify(p.body));
  body.rules.unshift({ id: 'X1', name: 'Office & IT at PUN1 to RFQ', when: { all: [{ field: 'plant', op: 'eq', value: 'PUN1' }, { field: 'category', op: 'eq', value: 'Office & IT' }] }, outcome: { decision: 'SOURCING_REQUEST', route: 'RFQ', supplier: 'none', suggest: 3 } });
  const edited = pol.updateProposal(db, p.id, body, 'proc');
  assert.ok(edited.changes.diff.some((d) => d.kind === 'added' && /X1/.test(d.text)));
  body.rules[0].when.all[0].field = 'no_such_fact';
  assert.throws(() => pol.updateProposal(db, p.id, body, 'proc'), /unknown field/);
});
