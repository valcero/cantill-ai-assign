'use strict';
// Preferred supplier list (policy section 6): membership, ranking, reference price, suggestions.
const { dayDiff, addDays, round2 } = require('./util');

const WEIGHT_LABELS = {
  frequency: 'How often we bought it',
  recency: 'How recently',
  contract: 'Has held a contract',
  on_time: 'On-time delivery',
  quality: 'Quality rating'
};

/**
 * ds: dataset indexed by buildIndex(). Returns ranked list of
 * { supplier_id, rank, score, reference_price, reference_source, stats, breakdown }
 */
function preferredList(ds, itemCode, asOf, policy) {
  const hp = policy.parameters.history;
  const rk = policy.parameters.ranking;
  const from = addDays(asOf, -hp.preferred_window_days);
  const pos = (ds.posByItem.get(itemCode) || []).filter((p) => p.po_date >= from && p.po_date <= asOf);
  const bySup = new Map();
  for (const p of pos) {
    const s = ds.supplierById.get(p.supplier_id);
    if (!s || s.status !== 'Active') continue;
    if (!bySup.has(p.supplier_id)) bySup.set(p.supplier_id, { pos: [], contracts: [] });
    bySup.get(p.supplier_id).pos.push(p);
  }
  for (const c of ds.contractsByItem.get(itemCode) || []) {
    if (c.start_date > asOf) continue; // contract must have started on or before the date; expired is fine
    const s = ds.supplierById.get(c.supplier_id);
    if (!s || s.status !== 'Active') continue;
    if (!bySup.has(c.supplier_id)) bySup.set(c.supplier_id, { pos: [], contracts: [] });
    bySup.get(c.supplier_id).contracts.push(c);
  }
  const rows = [];
  for (const [sid, v] of bySup) {
    const s = ds.supplierById.get(sid);
    const sortedPos = [...v.pos].sort((a, b) => b.po_date.localeCompare(a.po_date) || String(b.po_number).localeCompare(String(a.po_number)));
    const last = sortedPos[0];
    const daysSince = last ? dayDiff(last.po_date, asOf) : null;
    let recency = 0;
    if (daysSince != null) {
      for (const t of [...rk.recency_tiers].sort((a, b) => a.within_days - b.within_days)) {
        if (daysSince <= t.within_days) { recency = t.score; break; }
      }
    }
    const sortedContracts = [...v.contracts].sort((a, b) => b.start_date.localeCompare(a.start_date));
    let refPrice = null, refSource = null;
    if (last) { refPrice = last.unit_price; refSource = `PO ${last.po_number} on ${last.po_date}`; }
    else if (sortedContracts[0]) { refPrice = sortedContracts[0].rate; refSource = `contract ${sortedContracts[0].contract_id} rate`; }
    rows.push({
      supplier_id: sid, name: s.name, po_count: v.pos.length, last_po_date: last ? last.po_date : null,
      last_po_number: last ? last.po_number : null, days_since_last_po: daysSince, recency,
      has_contract: sortedContracts.length > 0, contract_ids: sortedContracts.map((c) => c.contract_id),
      on_time_pct: s.on_time_pct, quality_rating: s.quality_rating,
      reference_price: refPrice == null ? null : round2(refPrice), reference_source: refSource
    });
  }
  const maxCount = Math.max(1, ...rows.map((r) => r.po_count));
  const w = rk.weights;
  for (const r of rows) {
    const comp = {
      frequency: r.po_count / maxCount,
      recency: r.recency,
      contract: r.has_contract ? 1 : 0,
      on_time: (r.on_time_pct || 0) / 100,
      quality: (r.quality_rating || 0) / 5
    };
    r.breakdown = {};
    let total = 0;
    for (const k of Object.keys(w)) {
      const pts = (comp[k] ?? 0) * w[k];
      r.breakdown[k] = { label: WEIGHT_LABELS[k] || k, value: round2(comp[k] ?? 0), weight: w[k], points: round2(pts * 100) / 100 };
      total += pts;
    }
    r.score = Math.round(total * 10000) / 10000;
  }
  rows.sort((a, b) => b.score - a.score || b.on_time_pct - a.on_time_pct || b.quality_rating - a.quality_rating || a.supplier_id.localeCompare(b.supplier_id));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

/** Policy 6.4: preferred list first, then other Active suppliers of the category, best delivery and quality first. */
function suggestSuppliers(ds, item, asOf, policy, count) {
  if (!count) return [];
  const list = preferredList(ds, item.item_code, asOf, policy);
  const out = list.slice(0, count).map((r) => ({ supplier_id: r.supplier_id, source: 'preferred list', rank: r.rank }));
  if (out.length < count) {
    const have = new Set(list.map((r) => r.supplier_id));
    const extra = ds.suppliers
      .filter((s) => s.status === 'Active' && !have.has(s.supplier_id) && s.categories.includes(item.category))
      .sort((a, b) => (b.on_time_pct / 100 + b.quality_rating / 5) - (a.on_time_pct / 100 + a.quality_rating / 5) || a.supplier_id.localeCompare(b.supplier_id));
    for (const s of extra) {
      if (out.length >= count) break;
      out.push({ supplier_id: s.supplier_id, source: `category top-up (${item.category})` });
    }
  }
  return out;
}

module.exports = { preferredList, suggestSuppliers, WEIGHT_LABELS };
