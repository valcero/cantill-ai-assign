'use strict';
// Policy-as-data: condition evaluation, validation and plain-language rendering.
// The engine never hard-codes a limit or a rule: everything comes from the policy JSON.
const { inr } = require('./util');

// Facts the engine computes for every requirement. A policy rule may test any of them.
const FACTS = {
  item_code: 'string', item_name: 'string', item_type: 'string', category: 'string', plant: 'string',
  department: 'string', uom: 'string', quantity: 'number', value: 'number', urgency: 'string',
  emergency: 'boolean', is_new_item: 'boolean', contract_applicable: 'boolean', contract_usable: 'boolean',
  bought_recently: 'boolean', has_preferred_supplier: 'boolean', line_count: 'number', unit_price: 'number'
};
const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'contains'];
const OUTCOME_SUPPLIERS = ['contract', 'preferred_first', 'none'];
const DECISIONS = ['PO', 'SOURCING_REQUEST'];

function evalCond(c, facts) {
  if (!c) return true;
  if (c.all) return c.all.every((x) => evalCond(x, facts));
  if (c.any) return c.any.some((x) => evalCond(x, facts));
  if (c.not) return !evalCond(c.not, facts);
  const f = facts[c.field];
  const v = c.value;
  const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : x);
  switch (c.op) {
    case 'eq': return norm(f) === norm(v);
    case 'ne': return norm(f) !== norm(v);
    case 'lt': return f < v;
    case 'lte': return f <= v;
    case 'gt': return f > v;
    case 'gte': return f >= v;
    case 'in': return (v || []).map(norm).includes(norm(f));
    case 'not_in': return !(v || []).map(norm).includes(norm(f));
    case 'contains': return String(f ?? '').toLowerCase().includes(String(v).toLowerCase());
    default: return false;
  }
}

function validateCond(c, path, errors) {
  if (!c || typeof c !== 'object') { errors.push(`${path}: condition missing`); return; }
  if (c.all || c.any) {
    const arr = c.all || c.any;
    if (!Array.isArray(arr)) errors.push(`${path}: all/any must be a list`);
    else arr.forEach((x, i) => validateCond(x, `${path}[${i}]`, errors));
  } else if (c.not) validateCond(c.not, `${path}.not`, errors);
  else {
    if (!(c.field in FACTS)) errors.push(`${path}: unknown field "${c.field}" (known: ${Object.keys(FACTS).join(', ')})`);
    if (!OPS.includes(c.op)) errors.push(`${path}: unknown operator "${c.op}"`);
    if (c.value === undefined) errors.push(`${path}: value missing`);
  }
}

function validatePolicy(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['policy is not an object'];
  if (!p.version) errors.push('version missing');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.effective_from || '')) errors.push('effective_from must be YYYY-MM-DD');
  const pr = p.parameters || {};
  for (const k of ['clubbing', 'history', 'ranking', 'consolidation']) if (!pr[k]) errors.push(`parameters.${k} missing`);
  if (!Array.isArray(p.rules) || !p.rules.length) errors.push('rules missing');
  else {
    const ids = new Set();
    p.rules.forEach((r, i) => {
      const at = `rule ${r.id || i}`;
      if (!r.id) errors.push(`rule #${i + 1}: id missing`);
      if (ids.has(r.id)) errors.push(`${at}: duplicate id`);
      ids.add(r.id);
      validateCond(r.when, `${at}.when`, errors);
      const o = r.outcome || {};
      if (!DECISIONS.includes(o.decision)) errors.push(`${at}: outcome.decision must be PO or SOURCING_REQUEST`);
      if (!o.route) errors.push(`${at}: outcome.route missing`);
      if (o.supplier && !OUTCOME_SUPPLIERS.includes(o.supplier)) errors.push(`${at}: outcome.supplier must be one of ${OUTCOME_SUPPLIERS.join(', ')}`);
      if (o.decision === 'PO' && !['contract', 'preferred_first'].includes(o.supplier)) errors.push(`${at}: a PO outcome needs supplier contract or preferred_first`);
    });
    const last = p.rules[p.rules.length - 1];
    if (last && last.when && JSON.stringify(last.when) !== '{}' && !(last.when.all && !last.when.all.length)) {
      // not an error: the engine falls back to RFQ, but warn through validatePolicyWarnings
    }
  }
  const w = pr.ranking && pr.ranking.weights;
  if (w) for (const [k, v] of Object.entries(w)) if (typeof v !== 'number' || v < 0) errors.push(`ranking weight ${k} must be a non-negative number`);
  return errors;
}

// ---------- plain language ----------
const FIELD_WORDS = {
  item_type: 'the item type', category: 'the category', plant: 'the plant', value: 'the requirement value',
  emergency: 'the requirement', urgency: 'the urgency', is_new_item: 'the item', contract_usable: 'a rate contract',
  contract_applicable: 'a rate contract', bought_recently: 'the item', item_code: 'the item code', department: 'the department',
  quantity: 'the quantity', uom: 'the unit', item_name: 'the item name', has_preferred_supplier: 'the item', line_count: 'the number of PR lines', unit_price: 'the unit price'
};
function leafText(c) {
  const money = (v) => (typeof v === 'number' && ['value', 'unit_price'].includes(c.field) ? inr(v) : v);
  const val = Array.isArray(c.value) ? c.value.map(money).join(' or ') : money(c.value);
  if (c.field === 'is_new_item') return c.value ? 'the item is not in the item master' : 'the item is in the item master';
  if (c.field === 'emergency') return c.value ? 'it is marked Emergency' : 'it is not an Emergency';
  if (c.field === 'contract_usable') return c.value ? 'a rate contract can be used (valid, supplier Active, ceiling has room)' : 'no rate contract can be used';
  if (c.field === 'contract_applicable') return c.value ? 'a rate contract applies' : 'no rate contract applies';
  if (c.field === 'bought_recently') return c.value ? 'the item was bought from an Active supplier in the look-back period' : 'the item was not bought from an Active supplier in the look-back period';
  if (c.field === 'has_preferred_supplier') return c.value ? 'the item has a preferred supplier' : 'the item has no preferred supplier';
  const subject = FIELD_WORDS[c.field] || c.field;
  const verb = { eq: 'is', ne: 'is not', lt: 'is below', lte: 'is at most', gt: 'is above', gte: 'is at least', in: 'is one of', not_in: 'is not one of', contains: 'contains' }[c.op];
  return `${subject} ${verb} ${val}`;
}
function condText(c) {
  if (!c) return 'always';
  if (c.all) return c.all.length ? c.all.map(condText).join(' and ') : 'always';
  if (c.any) return '(' + c.any.map(condText).join(' or ') + ')';
  if (c.not) return `not (${condText(c.not)})`;
  return leafText(c);
}
function outcomeText(o) {
  const sup = { contract: 'the contract supplier at the contract rate', preferred_first: 'the 1st preferred supplier at its reference price', none: '' }[o.supplier || 'none'];
  if (o.decision === 'PO') return `place a PO (${o.route}) with ${sup}`;
  const n = o.suggest ? ` and suggest ${o.suggest} suppliers` : ', no supplier suggestions';
  return `raise a sourcing request (${o.route})${n}`;
}
function ruleText(r) { return `Rule ${r.id}${r.name ? ' (' + r.name + ')' : ''}: when ${condText(r.when)}, ${outcomeText(r.outcome)}.`; }

module.exports = { FACTS, OPS, evalCond, validatePolicy, condText, outcomeText, ruleText };
