'use strict';
// Free-text item matching against the item master (policy 1.1).
// Deterministic token matching: abbreviations are expanded, noise words dropped,
// and every number in the request must appear in the item (a 6308 bearing is never a 6205).

const ABBREVIATIONS = {
  brg: 'bearing', brgs: 'bearing', hyd: 'hydraulic', pneu: 'pneumatic', pneum: 'pneumatic',
  rod: 'electrode', rods: 'electrode', elec: 'electrode', sw: 'switch', prox: 'proximity',
  ss: 'ss', ms: 'ms', cyl: 'cylinder', val: 'valve', sol: 'solenoid', sens: 'sensor',
  gloves: 'glove', shoes: 'shoe', goggles: 'goggle', plugs: 'plug', bags: 'bag', belts: 'belt',
  wheels: 'wheel', bolts: 'bolt', nuts: 'nut', screws: 'screw', boxes: 'box', laptops: 'laptop',
  monitors: 'monitor', seals: 'seal', hoses: 'hose', plates: 'plate', sheets: 'sheet',
  contactors: 'contactor', sensors: 'sensor', cylinders: 'cylinder', valves: 'valve',
  tyre: 'tire', mtr: 'meter'
};
const NOISE = new Set([
  'urgent', 'urgently', 'asap', 'as', 'per', 'sample', 'repeat', 'for', 'maintenance', 'required', 'need',
  'needed', 'pls', 'please', 'the', 'of', 'and', 'a', 'an', 'to', 'new', 'qty', 'quantity', 'nos', 'no',
  'pcs', 'pc', 'piece', 'pieces', 'inch', 'in', 'mm', 'want', 'buy', 'order', 'purchase', 'get', 'some',
  'with', 'i', 'we', 'by', 'at', 'from', 'on', 'my', 'our', 'plant', 'emergency', 'immediately'
]);

function tokenize(text) {
  let t = String(text || '').toLowerCase();
  t = t.replace(/["']/g, ' ').replace(/(\d)\s*x\s*(\d)/g, '$1 x $2').replace(/(\d)(mm|ltr|l|kg|mtr|m)\b/g, '$1 $2');
  t = t.replace(/[^a-z0-9./%+-]+/g, ' ').replace(/(^|\s)[.\-/]+|[.\-/]+(\s|$)/g, ' ');
  // split hyphenated codes: 6205-2rs -> 6205 2rs
  t = t.replace(/(\w)-(\w)/g, '$1 $2');
  const out = [];
  for (let w of t.split(/\s+/)) {
    if (!w) continue;
    if (ABBREVIATIONS[w]) w = ABBREVIATIONS[w];
    else if (w.length > 3 && w.endsWith('s') && !/\d/.test(w) && !w.endsWith('ss')) w = w.slice(0, -1);
    if (NOISE.has(w)) continue;
    out.push(w);
  }
  return out;
}
const isNumeric = (w) => /\d/.test(w);

function scoreItem(qTokens, item) {
  const iTokens = item._tokens;
  const iSet = new Set(iTokens);
  const qSet = new Set(qTokens);
  if (!qSet.size) return 0;
  const matched = [...iSet].filter((w) => qSet.has(w));
  const recall = matched.length / iSet.size;
  const precision = matched.length / qSet.size;
  // numbers typed by the requester must exist in the item
  const badNumber = [...qSet].some((w) => isNumeric(w) && !iSet.has(w));
  if (badNumber) return 0;
  // numbers of the item missing from the request are a weaker signal
  const missingNumbers = [...iSet].filter((w) => isNumeric(w) && !qSet.has(w)).length;
  return 0.6 * recall + 0.4 * precision - 0.08 * missingNumbers;
}

function prepareItems(items) {
  for (const it of items) it._tokens = tokenize(it.description);
  return items;
}

/**
 * Returns { status: 'exact'|'confident'|'ambiguous'|'none', best, candidates:[{item,score}] }
 */
function matchItem(text, items) {
  const q = tokenize(text);
  if (!q.length) return { status: 'none', best: null, candidates: [] };
  const ranked = items
    .map((item) => ({ item, score: scoreItem(q, item) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.item.item_code.localeCompare(b.item.item_code));
  if (!ranked.length) return { status: 'none', best: null, candidates: [] };
  const [top, second] = ranked;
  const candidates = ranked.slice(0, 5);
  const iSet = new Set(top.item._tokens);
  const covered = q.filter((w) => iSet.has(w)).length / q.length;
  const recall = top.item._tokens.filter((w) => q.includes(w)).length / top.item._tokens.length;
  // Accept when the request clearly points at one item: most of the item's words are present
  // and the request does not carry many words that the item does not have.
  // A short request that sits wholly inside exactly one item name (e.g. "nitrile gloves") is also a clear match.
  const fullyInside = ranked.filter((c) => q.every((w) => c.item._tokens.includes(w)));
  const strong = (recall >= 0.75 && covered >= 0.6) || (q.length >= 2 && covered === 1 && fullyInside.length === 1 && recall >= 0.5);
  if (!strong) {
    // weak overlap: only offer as a suggestion, never as a match
    return { status: top.score >= 0.45 ? 'ambiguous' : 'none', best: null, candidates: top.score >= 0.45 ? candidates : [] };
  }
  if (second && top.score - second.score < 0.06 && second.score > 0.6) {
    return { status: 'ambiguous', best: null, candidates };
  }
  return { status: top.score >= 0.97 ? 'exact' : 'confident', best: top.item, score: top.score, candidates };
}

module.exports = { tokenize, matchItem, prepareItems };
