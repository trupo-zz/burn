#!/usr/bin/env node
'use strict';
/**
 * burn (CLI) -- the distributable form.
 *
 * The web app needs the smallcloud host; this needs nothing but node. That
 * matters for distribution: the ten people you can reach without ads will run
 * one command, not install a server. Same engine, same numbers.
 *
 *   node cli.js                    human-readable report
 *   node cli.js --json             machine-readable
 *   node cli.js --root <dir>       point at a different transcript root
 *   node cli.js --top 20           more expensive sessions
 *
 * Reads only local files. No network, no account, no upload.
 */
const path = require('path');
const S = require('./scan');

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}
const JSON_OUT = process.argv.includes('--json');
const TOP = Number(arg('--top', 10)) || 10;
const ROOT = arg('--root', null);

(async () => {
  const started = Date.now();
  if (!JSON_OUT) process.stderr.write('scanning transcripts...\r');
  const r = await S.scan({ root: ROOT || undefined, cache: {} });
  const agg = S.aggregate(r.sessions);

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      root: r.root, stats: r.stats, total: agg.total, derived: agg.derived,
      byModel: agg.byModel, byDay: agg.byDay,
      prices_verified: S.PRICES.verified,
    }, null, 2) + '\n');
    return;
  }

  const t = agg.total, d = agg.derived;
  const sessions = [...r.sessions].sort((a, b) => b.cost - a.cost).slice(0, TOP);

  process.stderr.write('                          \r');
  console.log('');
  console.log('  burn — where your Claude Code money goes');
  console.log('  ' + '-'.repeat(52));
  console.log(`  API-equivalent cost    ${money(t.cost)}`);
  console.log(`  model turns            ${fmt(t.turns)}`);
  console.log(`  output tokens          ${short(t.out)}   (the work you got)`);
  console.log(`  context re-read        ${short(t.cacheRead)}   (cached input, 2.5-10% of input price)`);
  console.log(`  read : write ratio     ${d.readWriteRatio == null ? '-' : fmt(Math.round(d.readWriteRatio)) + 'x'}`);
  console.log(`  cost per 1k output     ${money(d.costPerKOut)}`);
  console.log(`  spent re-reading       ${money(d.cacheReadCost)}`
    + (d.cacheShare == null ? '' : `   (${(d.cacheShare * 100).toFixed(0)}% of total)`));
  if (t.unpricedTurns) {
    console.log(`  unpriced turns         ${fmt(t.unpricedTurns)}   (counted in tokens, excluded from cost)`);
  }

  console.log('\n  by model');
  for (const [m, v] of Object.entries(agg.byModel).sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(`    ${m.padEnd(30)} ${fmt(v.turns).padStart(7)} turns  ${short(v.out).padStart(7)} out  `
      + `${(v.priced ? money(v.cost) : 'free/unpriced').padStart(10)}`);
  }

  console.log(`\n  most expensive sessions (top ${TOP})`);
  for (const s of sessions) {
    const ratio = s.tokens.out > 0 ? Math.round(s.tokens.cacheRead / s.tokens.out) + 'x' : '-';
    console.log(`    ${s.id.slice(0, 8)}  ${money(s.cost).padStart(9)}  ${fmt(s.turns).padStart(5)} turns  `
      + `${ratio.padStart(6)} read:write  ${s.lastTs ? new Date(s.lastTs).toISOString().slice(0, 10) : ''}`);
  }

  console.log(`\n  ${fmt(r.stats.files)} transcripts in ${((Date.now() - started) / 1000).toFixed(1)}s · ${r.root}`);
  console.log(`  Costs = recorded token counts x bundled price table (API rates, prices.json ${S.PRICES.verified}).`);
  console.log(`  Fast-mode turns are priced at the standard rate, so they are under-counted.\n`);
})().catch((e) => {
  console.error('burn: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});

function money(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 1000) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString('en-US');
}
function short(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function fmt(n) { return (Number(n) || 0).toLocaleString('en-US'); }
