#!/usr/bin/env node
'use strict';
/**
 * verify.js -- recompute one turn's cost by hand and compare it with burn's.
 *
 *   node verify.js                       newest transcript under ~/.claude/projects
 *   node verify.js path/to/session.jsonl that transcript
 *
 * Prints the first priced assistant turn's raw usage block, the price row it
 * was matched to, the arithmetic line by line, and burn's own costOf for the
 * same turn. The hand computation reads prices.json directly and does not call
 * scan.js, so it is an independent check, not the same code run twice.
 * No arguments to quote, so the same command works in bash and PowerShell.
 * Reads only local files.
 */
const fs = require('fs');
const path = require('path');
const S = require('./scan');

const PRICES = JSON.parse(fs.readFileSync(path.join(__dirname, 'prices.json'), 'utf8')).per_mtok;

// Same documented rule as the README: exact id, or the id plus a -YYYYMMDD snapshot suffix.
function row(model) {
  if (Object.prototype.hasOwnProperty.call(PRICES, model)) return [model, PRICES[model]];
  const base = /-\d{8}$/.test(model) ? model.slice(0, -9) : null;
  if (base && Object.prototype.hasOwnProperty.call(PRICES, base)) return [base, PRICES[base]];
  return [null, null];
}

function newestTranscript(dir, depth = 0, best = null) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return best; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isSymbolicLink()) continue;
    if (it.isDirectory() && depth < 6) best = newestTranscript(p, depth + 1, best);
    else if (it.isFile() && it.name.endsWith('.jsonl')) {
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
  }
  return best;
}

const file = process.argv[2] || (newestTranscript(S.defaultRoot()) || {}).p;
if (!file) { console.error('verify: no transcript found; pass a path to a .jsonl file'); process.exit(1); }

let lineNo = 0, found = null;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  lineNo++;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  const u = e && e.type === 'assistant' && e.message && e.message.usage;
  if (!u || !row(String(e.message.model))[1]) continue;
  if (!(u.input_tokens || u.output_tokens || u.cache_read_input_tokens || u.cache_creation_input_tokens)) continue;
  found = { model: String(e.message.model), u, lineNo };
  break;
}
if (!found) { console.error('verify: no priced assistant turn in ' + file); process.exit(1); }

const { model, u } = found;
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const tin = n(u.input_tokens), tout = n(u.output_tokens), read = n(u.cache_read_input_tokens), write = n(u.cache_creation_input_tokens);
const w1h = Math.min(n(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens), write), w5m = write - w1h;
let [key, p] = row(model), tier = '';
if (p.above && tin + read + write > p.above.tokens) { p = p.above; tier = ` (prompt over ${p.tokens.toLocaleString('en-US')} tokens: 'above' tier)`; }

const lines = [
  ['input', tin, p.in], ['output', tout, p.out], ['cache read', read, p.cache_read],
  ['cache write 5m', w5m, p.cache_write_5m], ['cache write 1h', w1h, p.cache_write_1h],
];
const byHand = lines.reduce((acc, [, t, rate]) => acc + (t * rate) / 1e6, 0);
const burn = S.costOf(model, { in: tin, out: tout, cacheRead: read, cacheWrite: write, cacheWrite1h: w1h });

const pad = (s, w) => String(s).padStart(w);
console.log(`transcript  ${file} (line ${found.lineNo})`);
console.log(`model       ${model}   prices.json row: ${key}${tier}`);
console.log(`usage       ${JSON.stringify(u)}`);
console.log('');
console.log(`                     ${pad('tokens', 12)} ${pad('$/Mtok', 8)} ${pad('$', 11)}`);
for (const [name, t, rate] of lines) {
  console.log(`  ${name.padEnd(18)} ${pad(t.toLocaleString('en-US'), 12)} ${pad(rate.toFixed(3), 8)} ${pad(((t * rate) / 1e6).toFixed(6), 11)}`);
}
console.log(`  ${'by hand'.padEnd(18)} ${pad('', 12)} ${pad('', 8)} ${pad(byHand.toFixed(6), 11)}`);
console.log(`  ${'burn costOf'.padEnd(18)} ${pad('', 12)} ${pad('', 8)} ${pad(burn.total.toFixed(6), 11)}`);
const ok = Math.abs(byHand - burn.total) < 1e-9;
console.log(ok ? '\nmatch' : `\nMISMATCH: differs by ${Math.abs(byHand - burn.total)}`);
process.exit(ok ? 0 : 1);
