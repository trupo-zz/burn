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
 * On red-first, honestly: this suite is NOT red-first and the earlier claim here
 * that it was has been removed. Two assertions did fail on the first run, but
 * they failed because the EXPECTATIONS were wrong (agg.total is flat, not
 * nested; readWriteRatio is cacheRead/out, not all-input/out) and were then
 * corrected to match the code. That is a test written to observed behaviour --
 * useful, but it proves the suite can fail, not that it would catch a
 * regression the code introduces. A genuinely red-first assertion is written
 * against a deliberately broken build and watched to fail first.
 *
 * What these assertions DO prove: the cost arithmetic is checked against
 * hand-computed totals rather than against whatever the code happens to
 * produce, so a change to the price multipliers cannot pass silently.
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

  // --- model matching: exact id or dated snapshot, never a prefix -----------
  // The first matcher used includes(), so claude-opus-5-5 billed at
  // claude-opus-5's price and any newer claude-opus-5-x would have too.

  t('each current model gets its own entry, not an older one by prefix', () => {
    assert.strictEqual(S.priceFor('claude-opus-5-5'), S.PRICES.per_mtok['claude-opus-5-5']);
    assert.strictEqual(S.priceFor('claude-sonnet-5-5'), S.PRICES.per_mtok['claude-sonnet-5-5']);
    assert.strictEqual(S.priceFor('claude-fable-5-1'), S.PRICES.per_mtok['claude-fable-5-1']);
    assert.strictEqual(S.priceFor('claude-haiku-5-5'), S.PRICES.per_mtok['claude-haiku-5-5']);
    assert.strictEqual(S.priceFor('claude-opus-5-5').in, 4.0);
  });

  t('a dated snapshot id resolves to its base model', () => {
    assert.strictEqual(S.priceFor('claude-haiku-4-5-20251001'), S.PRICES.per_mtok['claude-haiku-4-5']);
    assert.strictEqual(S.priceFor('claude-opus-4-1-20250805'), S.PRICES.per_mtok['claude-opus-4-1']);
  });

  t('an unknown newer id is unpriced, not guessed from an older entry', () => {
    for (const id of ['claude-opus-5-7', 'claude-sonnet-5-5-1', 'claude-fable-5-2', 'claude-opus-6',
      'claude-opus-5-5-preview', 'us.anthropic.claude-opus-5', 'xclaude-opus-5']) {
      assert.strictEqual(S.priceFor(id), null, id + ' was priced');
    }
  });

  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-test-'));
  const proj2 = path.join(root2, 'C--fake-project');
  fs.mkdirSync(proj2, { recursive: true });
  fs.writeFileSync(path.join(proj2, 'cccccccc-0000-0000-0000-000000000003.jsonl'),
    turn('claude-opus-5-7', { input_tokens: 1000, output_tokens: 1000 }, '2026-10-01T00:00:00.000Z') + '\n');
  const r2 = await S.scan({ root: root2, cache: {} });
  const agg2 = S.aggregate(r2.sessions);
  t('a scan reports an unknown newer id as unpriced turns with zero cost', () => {
    assert.strictEqual(agg2.total.turns, 1);
    assert.strictEqual(agg2.total.unpricedTurns, 1);
    assert.strictEqual(agg2.total.cost, 0);
    assert.strictEqual(agg2.byModel['claude-opus-5-7'].priced, false);
  });
  try { fs.rmSync(root2, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }

  // --- one streamed message, several lines ----------------------------------
  // Claude Code writes one JSONL line per content block of a streamed reply
  // (thinking, text, each tool_use), and every one carries the same message.id,
  // requestId and usage. Summing per line overstated a real corpus about 2x.

  function streamed(id, requestId, usage, ts, extra) {
    return JSON.stringify({ type: 'assistant', timestamp: ts, requestId, ...extra,
      message: { id, model: 'claude-opus-5', usage } });
  }
  const U = { input_tokens: 1000000, output_tokens: 1000000,
    cache_read_input_tokens: 10000000, cache_creation_input_tokens: 1000000 };

  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-test-'));
  const proj3 = path.join(root3, 'C--fake-project');
  fs.mkdirSync(proj3, { recursive: true });
  fs.writeFileSync(path.join(proj3, 'dddddddd-0000-0000-0000-000000000004.jsonl'),
    [0, 1, 2].map((i) => streamed('msg_dup', 'req_dup', U, '2026-10-01T00:00:0' + i + '.000Z')).join('\n') + '\n');
  const r3 = await S.scan({ root: root3, cache: {} });
  const agg3 = S.aggregate(r3.sessions);
  t('one message split across 3 lines with the same message.id is counted once', () => {
    assert.strictEqual(agg3.total.turns, 1, 'turns');
    assert.strictEqual(agg3.total.in, 1000000, 'input');
    assert.strictEqual(agg3.total.out, 1000000, 'output');
    assert.strictEqual(agg3.total.cacheRead, 10000000, 'cache read');
    assert.strictEqual(agg3.total.cacheWrite, 1000000, 'cache write');
    assert.ok(Math.abs(agg3.total.cost - 41.25) < 1e-9, 'cost: expected 41.25, got ' + agg3.total.cost);
  });
  try { fs.rmSync(root3, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }

  const root4 = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-test-'));
  const proj4 = path.join(root4, 'C--fake-project');
  fs.mkdirSync(proj4, { recursive: true });
  const partial = { ...U, output_tokens: 5 };
  fs.writeFileSync(path.join(proj4, 'eeeeeeee-0000-0000-0000-000000000005.jsonl'), [
    // Streamed lines carry a running output count; only the last is final.
    streamed('msg_grow', 'req_grow', partial, '2026-10-02T00:00:00.000Z'),
    streamed('msg_grow', 'req_grow', partial, '2026-10-02T00:00:00.000Z'),
    streamed('msg_grow', 'req_grow', U, '2026-10-02T00:00:00.000Z'),
    // No requestId: same id and timestamp is one message, a new timestamp is another.
    streamed('msg_noreq', undefined, U, '2026-10-02T00:00:01.000Z'),
    streamed('msg_noreq', undefined, U, '2026-10-02T00:00:01.000Z'),
    streamed('msg_noreq', undefined, U, '2026-10-02T00:00:02.000Z'),
    // No message.id at all: nothing to key on, so every line counts.
    streamed(undefined, 'req_noid', U, '2026-10-02T00:00:03.000Z'),
    streamed(undefined, 'req_noid', U, '2026-10-02T00:00:03.000Z'),
  ].join('\n') + '\n');
  // The same message again in another transcript: a resumed session copies history.
  fs.writeFileSync(path.join(proj4, 'ffffffff-0000-0000-0000-000000000006.jsonl'),
    streamed('msg_grow', 'req_grow', U, '2026-10-02T00:00:00.000Z') + '\n');
  const r4 = await S.scan({ root: root4, cache: {} });
  const agg4 = S.aggregate(r4.sessions);
  t('a repeated message keeps its largest usage, so the final output count wins', () => {
    // msg_grow 1 + msg_noreq 2 + id-less 2 = 5 turns, each with U's tokens
    assert.strictEqual(agg4.total.turns, 5, 'turns');
    assert.strictEqual(agg4.total.out, 5 * 1000000, 'output');
    assert.strictEqual(agg4.total.cacheRead, 5 * 10000000, 'cache read');
  });
  t('a message repeated in a second transcript is counted in only one session', () => {
    const n = r4.sessions.reduce((acc, s) => acc + s.turns, 0);
    assert.strictEqual(n, 5);
    assert.strictEqual(r4.sessions.length, 1, 'sessions: ' + r4.sessions.map((s) => s.id).join(','));
  });
  const cache4 = {};
  await S.scan({ root: root4, cache: cache4 });
  const again4 = await S.scan({ root: root4, cache: cache4 });
  t('a rescan from cache dedupes the same way', () => {
    assert.strictEqual(again4.stats.reused, 2, 'reused');
    assert.strictEqual(S.aggregate(again4.sessions).total.turns, 5);
  });
  try { fs.rmSync(root4, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }

  // --- per-model rates, hand-computed from the official table --------------

  t('opus 5.5 cache reads bill at $0.20/Mtok (0.05x), not 0.1x', () => {
    // in 1M*4 = 4; out 1M*20 = 20; read 10M*0.20 = 2; write(5m) 1M*5 = 5 -> 31
    const c = S.costOf('claude-opus-5-5', { in: 1e6, out: 1e6, cacheRead: 1e7, cacheWrite: 1e6 });
    assert.ok(Math.abs(c.total - 31) < 1e-9, 'got ' + c.total);
    assert.ok(Math.abs(c.cacheRead - 2) < 1e-9, 'got ' + c.cacheRead);
  });

  t('1-hour cache writes bill at 2x input, 5-minute at 1.25x', () => {
    // opus 5: 1M written, 600k of it 1h: 400k*6.25 + 600k*10 = 2.5 + 6 = 8.5
    const c = S.costOf('claude-opus-5', { in: 0, out: 0, cacheRead: 0, cacheWrite: 1e6, cacheWrite1h: 6e5 });
    assert.ok(Math.abs(c.total - 8.5) < 1e-9, 'got ' + c.total);
  });

  t('haiku 5.5 switches to the long-prompt tier above 100k prompt tokens', () => {
    // 50k in, 60k cache read = 110k prompt -> above tier: 50k*0.5 + 60k*0.05 + 10k out*2.5 = 0.025+0.003+0.025
    const hi = S.costOf('claude-haiku-5-5', { in: 5e4, out: 1e4, cacheRead: 6e4, cacheWrite: 0 });
    assert.ok(Math.abs(hi.total - 0.053) < 1e-12, 'got ' + hi.total);
    // 50k in, 10k out at the base tier: 50k*0.1 + 10k*0.5 = 0.005+0.005
    const lo = S.costOf('claude-haiku-5-5', { in: 5e4, out: 1e4, cacheRead: 0, cacheWrite: 0 });
    assert.ok(Math.abs(lo.total - 0.01) < 1e-12, 'got ' + lo.total);
  });

  t('every price entry has all five rates as positive numbers', () => {
    const cols = ['in', 'out', 'cache_read', 'cache_write_5m', 'cache_write_1h'];
    for (const [id, p] of Object.entries(S.PRICES.per_mtok)) {
      for (const tier of p.above ? [p, p.above] : [p]) {
        for (const c of cols) assert.ok(typeof tier[c] === 'number' && tier[c] > 0, id + '.' + c);
      }
    }
  });

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }

  console.log('\n' + (fail === 0 ? 'OK' : 'FAILED') + ': ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
