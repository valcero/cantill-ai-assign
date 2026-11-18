'use strict';
// Policy change handling: operations on the policy JSON, plain-language diff, and a document reader.
// The reader uses an LLM when LLM_API_KEY is set and always falls back to a deterministic parser,
// so the app works offline. Both produce the same list of operations, which is validated before use.
const { clone, getPath, setPath, inr } = require('../engine/util');
const { validatePolicy, ruleText, FACTS } = require('../engine/policy');

// ---------------------------------------------------------------- operations
function findRule(p, id) { return p.rules.find((r) => r.id === id); }

function walkLeaves(cond, fn) {
  if (!cond) return;
  if (cond.all || cond.any) (cond.all || cond.any).forEach((c) => walkLeaves(c, fn));
  else if (cond.not) walkLeaves(cond.not, fn);
  else fn(cond);
}

function applyOps(policy, ops) {
  const p = clone(policy);
  const log = [];
  for (const op of ops) {
    switch (op.op) {
      case 'set_param': {
        const before = getPath(p.parameters, op.path);
        if (before === undefined) throw new Error(`unknown parameter ${op.path}`);
        setPath(p.parameters, op.path, op.value);
        break;
      }
      case 'set_limit': {
        const r = findRule(p, op.rule_id);
        if (!r) throw new Error(`rule ${op.rule_id} not found`);
        let n = 0;
        walkLeaves(r.when, (l) => { if (l.field === op.field && l.op === op.cmp && (op.only_scope_free !== false)) { if (op.old === undefined || l.value === op.old) { l.value = op.value; n++; } } });
        if (!n) throw new Error(`rule ${op.rule_id} has no ${op.field} ${op.cmp} condition to change`);
        break;
      }
      case 'update_rule': {
        const r = findRule(p, op.rule_id);
        if (!r) throw new Error(`rule ${op.rule_id} not found`);
        Object.assign(r, clone(op.patch));
        break;
      }
      case 'add_rule': {
        if (findRule(p, op.rule.id)) throw new Error(`rule id ${op.rule.id} already exists`);
        let idx = p.rules.length;
        if (op.before) idx = p.rules.findIndex((r) => r.id === op.before);
        else if (op.after) idx = p.rules.findIndex((r) => r.id === op.after) + 1;
        else if (op.position === 'first') idx = 0;
        if (idx < 0 || (op.before && idx === -1)) throw new Error('insert position not found');
        p.rules.splice(idx, 0, clone(op.rule));
        break;
      }
      case 'remove_rule': {
        const i = p.rules.findIndex((r) => r.id === op.rule_id);
        if (i < 0) throw new Error(`rule ${op.rule_id} not found`);
        p.rules.splice(i, 1);
        break;
      }
      case 'move_rule': {
        const i = p.rules.findIndex((r) => r.id === op.rule_id);
        if (i < 0) throw new Error(`rule ${op.rule_id} not found`);
        const [r] = p.rules.splice(i, 1);
        let j = op.before ? p.rules.findIndex((x) => x.id === op.before) : p.rules.findIndex((x) => x.id === op.after) + 1;
        if (j < 0) throw new Error('target position not found');
        p.rules.splice(j, 0, r);
        break;
      }
      default: throw new Error(`unknown operation ${op.op}`);
    }
  }
  return { policy: p, log };
}

// ---------------------------------------------------------------- diff in plain language
function paramLabel(path) {
  return {
    'clubbing.created_within_days': 'Clubbing: PR lines created within (days) of the first line',
    'clubbing.need_by_within_days': 'Clubbing: need-by dates within (days) of the first line',
    'history.recent_purchase_days': 'Look-back for "bought recently" (days)',
    'history.preferred_window_days': 'Preferred-list purchase window (days)',
    'consolidation.window_hours': 'PO consolidation window (hours)'
  }[path] || path;
}
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out); else out[key] = v;
  }
  return out;
}

function diffPolicies(a, b) {
  const lines = [];
  if (a.effective_from !== b.effective_from) lines.push({ kind: 'date', text: `Effective date: ${a.effective_from} \u2192 ${b.effective_from}` });
  const fa = flatten(a.parameters), fb = flatten(b.parameters);
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) lines.push({ kind: 'param', text: `${paramLabel(k)}: ${JSON.stringify(fa[k])} \u2192 ${JSON.stringify(fb[k])}` });
  }
  const ma = new Map(a.rules.map((r) => [r.id, r])), mb = new Map(b.rules.map((r) => [r.id, r]));
  for (const r of b.rules) {
    if (!ma.has(r.id)) lines.push({ kind: 'added', text: `NEW ${ruleText(r)}` });
    else if (JSON.stringify([ma.get(r.id).when, ma.get(r.id).outcome]) !== JSON.stringify([r.when, r.outcome])) {
      lines.push({ kind: 'changed', text: `CHANGED\n  was: ${ruleText(ma.get(r.id))}\n  now: ${ruleText(r)}` });
    }
  }
  for (const r of a.rules) if (!mb.has(r.id)) lines.push({ kind: 'removed', text: `REMOVED ${ruleText(r)}` });
  const oa = a.rules.map((r) => r.id).filter((id) => mb.has(id)), ob = b.rules.map((r) => r.id).filter((id) => ma.has(id));
  if (JSON.stringify(oa) !== JSON.stringify(ob)) lines.push({ kind: 'order', text: `Rule order changed: ${b.rules.map((r) => r.id).join(' \u2192 ')}` });
  return lines;
}

// ---------------------------------------------------------------- deterministic reader
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const monthNum = (s) => MONTHS[s.slice(0, 4).toLowerCase()] || MONTHS[s.slice(0, 3).toLowerCase()];
const pad = (n) => String(n).padStart(2, '0');
const DATE_RES = [
  [/(\d{4})-(\d{2})-(\d{2})/g, (m) => `${m[1]}-${m[2]}-${m[3]}`],
  [/(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})/gi, (m) => `${m[3]}-${pad(monthNum(m[2]))}-${pad(m[1])}`],
  [/(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/gi, (m) => `${m[3]}-${pad(monthNum(m[1]))}-${pad(m[2])}`],
  [/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/g, (m) => `${m[3]}-${pad(m[2])}-${pad(m[1])}`]
];
function findDates(text) {
  const out = [];
  for (const [re, fn] of DATE_RES) { re.lastIndex = 0; let m; while ((m = re.exec(text))) out.push({ date: fn(m), index: m.index, len: m[0].length }); }
  return out.sort((a, b) => a.index - b.index);
}
function stripDates(text) { let t = text; for (const d of findDates(text).sort((a, b) => b.index - a.index)) t = t.slice(0, d.index) + ' '.repeat(d.len) + t.slice(d.index + d.len); return t; }

function parseMoney(sentence) {
  const t = stripDates(sentence);
  const out = [];
  const re = /(₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr\b|k\b|thousand|l\b)?/gi;
  let m;
  while ((m = re.exec(t))) {
    const raw = m[2].replace(/,/g, '');
    let v = parseFloat(raw);
    const unit = (m[3] || '').toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 14).toLowerCase();
    if (/^\s*(days?|hours?|hrs?|suppliers?|%|percent|lines?|pos\b|months?)/.test(after) && !m[1] && !unit) continue;
    if (/^\s*(days?|hours?)/.test(after)) continue;
    if (/^l/.test(unit)) v *= 100000; else if (/^(cr)/.test(unit)) v *= 10000000; else if (unit === 'k' || unit === 'thousand') v *= 1000;
    else if (!m[1] && v < 1000) continue; // bare small number: not money
    out.push({ value: v, index: m.index, end: m.index + m[0].length });
  }
  return out;
}

const ROUTE_WORDS = [
  ['capex', 'CAPEX_SOURCING'], ['emergency po', 'EMERGENCY_PO'], ['emergency', 'EMERGENCY_PO'], ['spot', 'SPOT_PO'],
  ['rfq', 'RFQ'], ['rfp', 'RFP'], ['contract po', 'CONTRACT_PO'], ['new item', 'NEW_ITEM_SOURCING']
];
function routesIn(s) {
  const t = s.toLowerCase();
  const out = [];
  for (const [w, r] of ROUTE_WORDS) { const i = t.search(new RegExp(`\\b${w}\\b`)); if (i >= 0 && !out.some((o) => o.route === r)) out.push({ route: r, index: i }); }
  return out.sort((a, b) => a.index - b.index);
}

function scopeIn(s, ctx) {
  const t = s.toLowerCase();
  const scope = [];
  const plants = [];
  for (const p of ctx.plants) {
    const names = [p.plant.toLowerCase(), ...String(p.name || '').toLowerCase().split(/[\s-]+/).filter((w) => w.length > 4 && w !== 'plant')];
    if (names.some((n) => new RegExp(`\\b${n}\\b`).test(t))) plants.push(p.plant);
  }
  if (plants.length) scope.push({ field: 'plant', op: plants.length > 1 ? 'in' : 'eq', value: plants.length > 1 ? plants : plants[0] });
  const cats = ctx.categories.filter((c) => t.includes(c.toLowerCase()));
  if (cats.length) scope.push({ field: 'category', op: cats.length > 1 ? 'in' : 'eq', value: cats.length > 1 ? cats : cats[0] });
  const tm = /\b(service|material|capex)\s+items?\b|item\s*type\s*(?:is\s*|=\s*)?(service|material|capex)\b/i.exec(s);
  if (tm) scope.push({ field: 'item_type', op: 'eq', value: (tm[1] || tm[2]).replace(/^./, (c) => c.toUpperCase()).toLowerCase().replace(/^./, (c) => c.toUpperCase()) });
  const cr = /(?:department|dept)\s+(?:is\s+)?([A-Za-z ]+?)(?:[,.]|\s+(?:above|below|must|should|go|need|$))/i.exec(s);
  if (cr) scope.push({ field: 'department', op: 'eq', value: cr[1].trim() });
  if (/\bemergenc(y|ies)\b/.test(t) && !/emergency po/.test(t) && /\b(urgency|marked|emergency (requirement|requests?|lines?|prs?))/.test(t)) scope.push({ field: 'emergency', op: 'eq', value: true });
  return scope;
}

function newRuleId(p, base) {
  let i = 1; const ids = new Set(p.rules.map((r) => r.id));
  while (ids.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

function routeOutcome(route, p) {
  const existing = p.rules.find((r) => r.outcome.route === route);
  if (existing) { const o = clone(existing.outcome); return o; }
  const map = {
    RFQ: { decision: 'SOURCING_REQUEST', route: 'RFQ', supplier: 'none', suggest: 3 },
    RFP: { decision: 'SOURCING_REQUEST', route: 'RFP', supplier: 'none', suggest: 5 },
    CAPEX_SOURCING: { decision: 'SOURCING_REQUEST', route: 'CAPEX_SOURCING', supplier: 'none', suggest: 5 },
    SPOT_PO: { decision: 'PO', route: 'SPOT_PO', supplier: 'preferred_first' },
    EMERGENCY_PO: { decision: 'PO', route: 'EMERGENCY_PO', supplier: 'preferred_first' }
  };
  return map[route] || null;
}

const PARAM_PATTERNS = [
  { re: /(club|split|same item)[^.\n]*?(\d+)\s*(?:calendar\s*)?days[^.\n]*?(?:first line|created|raised|window)?/i, path: 'clubbing.created_within_days', needNot: /need[- ]?by/i },
  { re: /need[- ]?by[^.\n]*?(\d+)\s*days/i, path: 'clubbing.need_by_within_days', group: 1 },
  { re: /(?:created|raised)\s+within\s+(\d+)\s*(?:calendar\s*)?days/i, path: 'clubbing.created_within_days', group: 1 },
  { re: /(?:consolidat|combined into one po|same po)[^.\n]*?(\d+)\s*hours?/i, path: 'consolidation.window_hours', group: 1 },
  { re: /(?:within|raised within)\s+(\d+)\s*hours?[^.\n]*(?:same po|one po|consolidat)/i, path: 'consolidation.window_hours', group: 1 },
  { re: /(?:preferred (?:supplier )?list|548)[^.\n]*?(\d{3,4})\s*days/i, path: 'history.preferred_window_days', group: 1 },
  { re: /(?:bought|purchase history|purchased|look[- ]?back)[^.\n]*?(?:last|past|within)?\s*(\d{2,4})\s*days/i, path: 'history.recent_purchase_days', group: 1, not: /preferred|548/i }
];

function heuristicParse(text, policy, ctx) {
  const ops = [], notes = [], unread = [];
  const dates = findDates(text);
  let effective_from = null;
  const eff = /(effective|w\.e\.f\.?|with effect|applicable|comes? into (?:force|effect)|from)\s*(?:from|on|date)?[:\s]*\s*/i;
  for (const d of dates) {
    const before = text.slice(Math.max(0, d.index - 40), d.index);
    if (eff.test(before) || /effective/i.test(before)) { effective_from = d.date; break; }
  }
  if (!effective_from && dates.length === 1) effective_from = dates[0].date;
  const vm = /version\s*(?:no\.?|number)?\s*[:\-]?\s*(\d+(?:\.\d+)*)/i.exec(text);
  const version = vm ? vm[1] : null;

  const sentences = text.replace(/\r/g, '').split(/(?<=[.;!?])\s+|\n+|\s*[\u2022\u25CF]\s*|\n\s*[-*]\s+|\n\s*\d+[.)]\s+/).map((s) => s.trim()).filter((s) => s.length > 8);
  const working = { policy: clone(policy) };
  const routeRule = (route) => working.policy.rules.find((r) => r.outcome.route === route);
  const used = new Set();

  for (const s of sentences) {
    const low = s.toLowerCase();
    const money = parseMoney(s);
    const routes = routesIn(s);
    const scope = scopeIn(s, ctx);
    const isNewRule = /\b(new rule|add(?:ed)? (?:a )?rule|additional rule|introduc|must (?:go|be|follow)|shall (?:go|be)|should go|will go|always (?:go|goes)|only apply|applies only|route[sd]? to|goes to|go to|need[s]? (?:an? )?(?:rfq|rfp|quotes|sourcing))\b/i.test(s);
    const isChange = /\b(make|change[sd]?|increase[sd]?|reduc(?:e|ed)|rais(?:e|ed)|lower(?:ed)?|revis(?:e|ed)|updat(?:e|ed)|now|instead of|from .* to|becomes?|set (?:to|at)|replace[sd]?|amend(?:ed)?)\b/i.test(s);
    let handled = false;

    // 1. Parameters
    for (const pp of PARAM_PATTERNS) {
      if (pp.not && pp.not.test(s)) continue;
      if (pp.needNot && pp.needNot.test(s)) continue;
      if (!pp.re.test(s)) continue;
      const nums = [...s.matchAll(/(\d+)\s*(?:calendar\s*)?(?:days|hours?|hrs)/gi)].map((x) => Number(x[1]));
      if (!nums.length) continue;
      const v = nums.length > 1 && /\bto\b|instead of|from/i.test(s) ? (/instead of/i.test(s) ? nums[0] : nums[nums.length - 1]) : nums[0];
      if (getPath(working.policy.parameters, pp.path) !== v && !used.has(pp.path)) { ops.push({ op: 'set_param', path: pp.path, value: v }); used.add(pp.path); notes.push(`Read: "${s}"`); handled = true; }
      else if (getPath(working.policy.parameters, pp.path) === v) handled = true;
      break;
    }
    if (handled) continue;
    // 2. suggestion counts
    const sg = /suggest(?:ed)?\s+(\d+)\s+suppliers?|(\d+)\s+suppliers?\s+(?:must|should|to)\s+be\s+suggested/i.exec(s);
    if (sg && routes.length) {
      const r = routeRule(routes[0].route);
      if (r) { const n = Number(sg[1] || sg[2]); if (r.outcome.suggest !== n) { ops.push({ op: 'update_rule', rule_id: r.id, patch: { outcome: { ...r.outcome, suggest: n } } }); notes.push(`Read: "${s}"`); } }
    }

    // 3. Limits and new rules need a route and a money amount
    if (routes.length && money.length) {
      const target = routes[0].route;
      const base = routeRule(target);
      const scoped = scope.filter((c) => !(c.field === 'emergency'));
      // change of an existing limit
      const looksLikeLimit = /limit|threshold|ceiling|cap\b|below|under|up to|upto|above|at or above|more than|less than/i.test(s);
      if (isChange && looksLikeLimit && base && !(isNewRule && !/limit|threshold/.test(low))) {
        // new value = amount after "to"/"now"/"becomes", else the last amount
        let m2 = null;
        const toRe = /(?:\bto\b|\bnow\b|becomes?|set at|instead of)\s*(?:be\s*)?(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr\b|k\b|l\b)?/gi;
        let mm; while ((mm = toRe.exec(stripDates(s)))) m2 = mm;
        let newVal = money[money.length - 1].value;
        if (m2) { const cand = parseMoney(m2[0]); if (cand.length) newVal = cand[0].value; }
        if (/\bfrom\b[^.]*\bto\b/i.test(s) === false && money.length === 2 && /instead of/i.test(s)) newVal = money[0].value;
        const leafField = 'value';
        const leafOp = { SPOT_PO: 'lt', EMERGENCY_PO: 'lte', RFQ: 'lt', RFP: 'gte' }[target];
        if (leafOp) {
          const oldLeaf = []; walkLeaves(base.when, (l) => { if (l.field === 'value' && l.op === leafOp) oldLeaf.push(l.value); });
          const old = oldLeaf[0];
          if (!scoped.length) {
            if (old !== newVal) {
              ops.push({ op: 'set_limit', rule_id: base.id, field: leafField, cmp: leafOp, value: newVal });
              // RFQ upper bound and RFP lower bound are the same boundary
              if (target === 'RFQ') { const rfp = routeRule('RFP'); if (rfp && rfp.when) ops.push({ op: 'set_limit', rule_id: rfp.id, field: 'value', cmp: 'gte', value: newVal }); }
              if (target === 'RFP') { const rfq = routeRule('RFQ'); if (rfq) ops.push({ op: 'set_limit', rule_id: rfq.id, field: 'value', cmp: 'lt', value: newVal }); }
              notes.push(`Read: "${s}"`);
            }
          } else {
            // limit that applies only to a scope: clone the rule with the scope and a new limit, exclude scope from the original
            const clonedRule = clone(base);
            clonedRule.id = newRuleId(working.policy, `${base.id}-S`);
            clonedRule.name = `${base.name || base.outcome.route} for ${scoped.map((c) => `${c.field} ${Array.isArray(c.value) ? c.value.join('/') : c.value}`).join(', ')}`;
            clonedRule.when = { all: [...scoped, ...(clone(base.when).all || [])] };
            walkLeaves(clonedRule.when, (l) => { if (l.field === 'value' && l.op === leafOp) l.value = newVal; });
            const exclusion = { not: { all: scoped } };
            const baseWhen = clone(base.when); baseWhen.all = [...(baseWhen.all || []), exclusion];
            ops.push({ op: 'add_rule', before: base.id, rule: clonedRule });
            ops.push({ op: 'update_rule', rule_id: base.id, patch: { when: baseWhen } });
            // keep next-tier rule consistent: scoped requirements above the new limit still reach RFQ/RFP by the unscoped rules
            notes.push(`Read: "${s}" (limit applies only to ${scoped.map((c) => c.field + '=' + c.value).join(', ')})`);
          }
          handled = true;
        }
      }
      if (!handled && isNewRule) {
        const outcome = routeOutcome(target, working.policy);
        if (outcome) {
          const conds = [...scope];
          const hasAbove = /(above|over|more than|at or above|exceed|greater|at least|≥|>=)/i.test(s);
          const hasBelow = /(below|under|less than|up to|upto|at most|<=|≤)/i.test(s);
          if (hasBelow && !hasAbove) conds.push({ field: 'value', op: /up to|upto|at most|<=|≤/i.test(s) ? 'lte' : 'lt', value: money[0].value });
          else conds.push({ field: 'value', op: /(above|over|more than|exceed|greater)(?!.*(at or|or more))/i.test(s) && !/at or above|at least|or more/i.test(s) ? 'gt' : 'gte', value: money[0].value });
          const rule = { id: newRuleId(working.policy, 'N'), name: `Added: ${s.slice(0, 80)}`, when: { all: conds }, outcome };
          const firstPo = working.policy.rules.find((r) => r.outcome.decision === 'PO' && r.id !== rule.id);
          const op = { op: 'add_rule', rule };
          if (/\b(even if|override|overrides|despite)\b.*contract|before.*contract/i.test(s) || true) { if (firstPo) op.before = firstPo.id; }
          ops.push(op); notes.push(`Read as new rule: "${s}"`); handled = true;
          working.policy = applyOps(working.policy, [op]).policy;
        }
      }
    } else if (routes.length && scope.length && isNewRule && !money.length) {
      // e.g. "Service items in plant CHK1 must always go to RFQ"
      const outcome = routeOutcome(routes[routes.length - 1].route, working.policy);
      if (outcome) {
        const rule = { id: newRuleId(working.policy, 'N'), name: `Added: ${s.slice(0, 80)}`, when: { all: [...scope] }, outcome };
        const firstPo = working.policy.rules.find((r) => r.outcome.decision === 'PO');
        const op = { op: 'add_rule', rule }; if (firstPo) op.before = firstPo.id;
        ops.push(op); notes.push(`Read as new rule: "${s}"`); handled = true;
        working.policy = applyOps(working.policy, [op]).policy;
      }
    }
    if (!handled && (money.length || routes.length) && (isChange || isNewRule)) unread.push(s);
  }
  return { ops, effective_from, version, notes, unread, engine: 'rules' };
}

// ---------------------------------------------------------------- LLM reader (optional)
async function llmParse(text, policy, ctx) {
  const key = process.env.LLM_API_KEY;
  if (!key) return null;
  const base = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  const system = `You convert a procurement policy amendment into JSON operations on a policy document.
Return ONLY JSON: {"effective_from":"YYYY-MM-DD"|null,"version":"x.y"|null,"ops":[...],"summary":"..."}.
Operations: {"op":"set_param","path":"clubbing.created_within_days","value":10}; {"op":"set_limit","rule_id":"5.4","field":"value","cmp":"lt","value":300000};
{"op":"update_rule","rule_id":"5.5","patch":{"outcome":{...}}}; {"op":"add_rule","before":"5.2","rule":{"id":"N1","name":"...","when":{"all":[{"field":"plant","op":"eq","value":"CHK1"}]},"outcome":{"decision":"SOURCING_REQUEST","route":"RFQ","supplier":"none","suggest":3}}};
{"op":"remove_rule","rule_id":"..."}; {"op":"move_rule","rule_id":"..","before":".."}.
Condition fields: ${Object.keys(FACTS).join(', ')}. Operators: eq, ne, lt, lte, gt, gte, in, not_in, contains. Combinators: all, any, not.
Rules run in order and the first match decides. When a limit applies only to some scope (plant/category), add a scoped copy of the rule before the original and exclude the scope from the original with {"not":{"all":[...]}}.
Outcome.supplier is one of contract, preferred_first, none. Categories: ${ctx.categories.join('; ')}. Plants: ${ctx.plants.map((p) => p.plant).join(', ')}.
Current policy: ${JSON.stringify({ parameters: policy.parameters, rules: policy.rules })}`;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: text.slice(0, 20000) }] })
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const j = await res.json();
  const parsed = JSON.parse(j.choices[0].message.content);
  return { ops: parsed.ops || [], effective_from: parsed.effective_from || null, version: parsed.version || null, notes: [parsed.summary || 'Read by language model'], unread: [], engine: 'llm' };
}

/** Read a document or chat message into operations. */
async function readChange(text, policy, ctx) {
  let result = null, llmError = null;
  try { result = await llmParse(text, policy, ctx); } catch (e) { llmError = e.message; }
  if (result) {
    try { applyOps(policy, result.ops); if (!result.ops.length) result = null; } catch (e) { llmError = `LLM output rejected: ${e.message}`; result = null; }
  }
  if (!result) result = heuristicParse(text, policy, ctx);
  if (llmError) result.notes.push(`Language model not used (${llmError}); used the built-in reader.`);
  return result;
}

module.exports = { applyOps, diffPolicies, readChange, heuristicParse, parseMoney, findDates, validatePolicy };
