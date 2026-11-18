'use strict';
// Small pure helpers shared by the engine. No I/O in this folder.

const DAY = 86400000;

function toMs(s) {
  if (s == null || s === '') return NaN;
  const str = String(s).trim().replace('T', ' ');
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}
const dateOf = (s) => {
  const ms = toMs(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
};
// whole calendar days from a to b (b - a)
const dayDiff = (a, b) => Math.round((toMs(dateOf(b)) - toMs(dateOf(a))) / DAY);
const addDays = (d, n) => new Date(toMs(d) + n * DAY).toISOString().slice(0, 10);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function inr(n) {
  const x = Math.round(Number(n) || 0);
  const s = String(Math.abs(x));
  let out = s.length > 3 ? s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3) : s;
  return (x < 0 ? '-' : '') + '\u20B9' + out;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}
const clone = (x) => JSON.parse(JSON.stringify(x));

module.exports = { DAY, toMs, dateOf, dayDiff, addDays, round2, inr, getPath, setPath, clone };
