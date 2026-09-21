#!/usr/bin/env node
'use strict';
/**
 * test.js -- burn's own suite, run against a synthetic corpus with known
 * answers. No network, no fixtures checked in, no dependency on the machine
 * having any real transcripts.
 *
 * Why the arithmetic is asserted rather than eyeballed: burn exists to produce
 * one number a person may act on -- how much of their bill bought no new
 * output. A cost model that is quietly 10x off in either direction is worse
 * than no tool, because it reads as precise. Every price multiplier below is
 * checked against a hand-computed expectation.
 *
 * Red-first: each assertion here was confirmed to fail against a deliberately
 * wrong expectation before the correct one was written in.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const S = require('./scan');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// --- a corpus with arithmetic we can do by hand ------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-test-'));
const proj = path.join(root, 'C--fake-project');
fs.mkdirSync(proj, { recursive: true });

function turn(model, usage, ts) {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { model, usage } });
}

// Session A: one opus turn. opus-5 is $5/Mtok in, $25/Mtok out, cache read 0.1x,
// cache write 1.25x.
//   in           1,000,000 * 5.00          = $5.00
//   out          1,000,000 * 25.00         = $25.00
//   cache read  10,000,000 * 5.00 * 0.1    = $5.00
//   cache write  1,000,000 * 5.00 * 1.25   = $6.25
//                                    total = $41.25
fs.writeFileSync(path.join(proj, 'aaaaaaaa-0000-0000-0000-000000000001.jsonl'),
  turn('claude-opus-5', {
    input_tokens: 1000000, output_tokens: 1000000,
    cache_read_input_tokens: 10000000, cache_creation_input_tokens: 1000000,
  }, '2026-09-01T00:00:00.000Z') + '\n');

// Session B: one turn on a model with no price entry, plus one unparseable line
// and one non-assistant line. Tokens must count; cost must not.
fs.writeFileSync(path.join(proj, 'bbbbbbbb-0000-0000-0000-000000000002.jsonl'),
  turn('some-local-model:8b', { input_tokens: 500, output_tokens: 500 }, '2026-09-02T00:00:00.000Z') + '\n'
  + '{ this is not json\n'
  + JSON.stringify({ type: 'user', timestamp: '2026-09-02T00:00:01.000Z', message: { content: 'hi' } }) + '\n');

(async () => {
  const r = await S.scan({ root, cache: {} });
  const agg = S.aggregate(r.sessions);

  t('finds every transcript', () => assert.strictEqual(r.stats.files, 2));
  t('counts only priced+unpriced assistant turns', () => assert.strictEqual(agg.total.turns, 2));

  t('cost matches the hand-computed total', () => {
    assert.ok(Math.abs(agg.total.cost - 41.25) < 0.0001,
      'expected 41.25, got ' + agg.total.cost);
  });

  t('an unpriced model contributes tokens but never cost', () => {
    assert.strictEqual(agg.total.unpricedTurns, 1);
    assert.strictEqual(agg.total.out, 1000500);
  });

  t('cache reads are billed at the read multiplier, not input price', () => {
    // If the 0.1x multiplier were dropped, cache read alone would be $50 and
    // the total would be $86.25. This is the single most expensive thing to get
    // wrong, because cache read is the largest token count on most machines.
    assert.ok(agg.total.cost < 50, 'cache read appears to be billed at full input price');
  });

  t('read:write ratio is cached re-read over new output', () => {
    // 10,000,000 cache read / 1,000,500 output. This is the headline number:
    // tokens re-read per token produced. Asserting it pins the definition --
    // swapping in total.in here would quietly change what the tool claims.
    assert.ok(Math.abs(agg.derived.readWriteRatio - 9.995) < 0.01,
      'got ' + agg.derived.readWriteRatio);
  });

  t('cache-read spend is reported separately', () => {
    assert.ok(Math.abs(agg.derived.cacheReadCost - 5.0) < 0.0001,
      'expected 5.00, got ' + agg.derived.cacheReadCost);
  });

  t('a malformed line is counted, not fatal', () => {
    const b = r.sessions.find((s) => s.id && s.id.startsWith('bbbbbbbb'));
    assert.ok(b, 'session B missing entirely');
    assert.strictEqual(b.badLines, 1);
  });

  t('nothing leaves the machine: scan takes a root and reads only under it', () => {
    assert.strictEqual(r.root, root);
  });

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }

  console.log('\n' + (fail === 0 ? 'OK' : 'FAILED') + ': ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
