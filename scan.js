'use strict';
/**
 * scan.js -- the parsing engine behind burn.
 *
 * Separated from app.js because the hard part here is not the dashboard, it is
 * reading a 260MB corpus of JSONL without hanging the host. smallcloud runs
 * node apps in-process, so a synchronous pass over 896 files would freeze the
 * server and every other app on it for seconds. Three things prevent that:
 *
 *   1. Streamed line-by-line parsing -- a 20MB transcript is never held in
 *      memory as one string.
 *   2. An explicit yield to the event loop between files, so other requests
 *      interleave with a scan in progress.
 *   3. A per-file cache keyed by (size, mtime). Transcripts are append-mostly
 *      and most never change again, so a rescan touches only what moved. The
 *      first scan is the slow one; every scan after it is near-instant.
 *
 * Cost model: tokens are read from each assistant message's `usage` block --
 * the token counts recorded in the transcript, priced with prices.json. A model with no price
 * entry contributes tokens and NO cost, and the caller is told how many such
 * records there were. Guessing a price would silently corrupt the one number
 * this whole app exists to produce.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const PRICES = JSON.parse(fs.readFileSync(path.join(__dirname, 'prices.json'), 'utf8'));

/** Default corpus location; overridable so this is testable and portable. */
function defaultRoot() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.claude', 'projects');
}

/**
 * Exact match, or the key plus a dated snapshot suffix (claude-haiku-4-5-20251001).
 *
 * Never substring or prefix: the first version used includes(), so
 * claude-opus-5-5 silently billed at claude-opus-5's price and any future
 * claude-opus-5-x would have too. A newer id with no entry must come out
 * unpriced, where the report shows it, not quietly guessed.
 */
const DATED = /-\d{8}$/;
function priceFor(model) {
  if (!model) return null;
  const id = String(model);
  const table = PRICES.per_mtok;
  if (Object.prototype.hasOwnProperty.call(table, id)) return table[id];
  const base = DATED.test(id) ? id.slice(0, -9) : null;
  if (base && Object.prototype.hasOwnProperty.call(table, base)) return table[base];
  return null;
}

/**
 * Cost of one turn, or null if the model is unpriced. Returns the total and the
 * cache-read share separately so the headline "spent re-reading" is summed per
 * turn at that turn's own rate.
 *
 * Cache writes are split by TTL when the usage block says so: Claude Code
 * mostly writes the 1-hour cache, which bills at 2x input, not the 1.25x of
 * the 5-minute cache. With no breakdown, writes are priced as 5-minute.
 * A model with an 'above' tier (Haiku 5.5) switches to it for the whole turn
 * once the prompt -- uncached input plus cache read plus cache write -- is
 * over the threshold.
 */
function costOf(model, t) {
  let p = priceFor(model);
  if (!p) return null;
  if (p.above && t.in + t.cacheRead + t.cacheWrite > p.above.tokens) p = p.above;
  const write1h = Math.min(t.cacheWrite1h || 0, t.cacheWrite);
  const cacheRead = t.cacheRead * p.cache_read / 1e6;
  const total = (t.in * p.in + t.out * p.out + (t.cacheWrite - write1h) * p.cache_write_5m
    + write1h * p.cache_write_1h) / 1e6 + cacheRead;
  return { total, cacheRead };
}

/**
 * Walk the corpus recursively, not just two levels deep.
 *
 * The first version stopped at root/project/*.jsonl and found 694 of 896 real
 * transcripts. The missing 200 were SUBAGENT transcripts, which live in nested
 * directories next to their parent -- and subagent turns cost real money. An
 * undercount is the one bug this app cannot have, since reporting spend
 * accurately is the entire product.
 *
 * Depth-capped and symlink-skipping so a loop or a stray junction can't turn a
 * scan into an infinite walk.
 */
async function listTranscripts(root, maxDepth = 6) {
  const out = [];

  async function walk(dir, project, depth) {
    if (depth > maxDepth) return;
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const it of items) {
      if (it.isSymbolicLink()) continue; // never follow links while walking
      const p = path.join(dir, it.name);
      if (it.isDirectory()) {
        await walk(p, project || it.name, depth + 1);
      } else if (it.isFile() && it.name.endsWith('.jsonl')) {
        out.push({ project: project || path.basename(dir), file: p });
      }
    }
  }

  await walk(root, null, 0);
  // readdir order is filesystem-dependent; sort so a message copied into two
  // transcripts is attributed to the same one on every machine.
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

/**
 * One assistant message can appear on several lines. Claude Code writes a line
 * per content block of a streamed reply (thinking, text, each tool_use), each
 * repeating the message's id, requestId and usage; a resumed session copies
 * earlier messages into its new transcript. Summing per line overstated a real
 * corpus about 2x, so every message is counted once, under this key.
 *
 * Same key as ccusage (rust/adapters/claude/src/lib.rs, usage_dedupe_hash):
 * message.id plus requestId; with no requestId, message.id scoped to the
 * session and timestamp. A line with no message.id has nothing safe to key on
 * and counts on its own (null key), as it does in ccusage.
 */
function messageKey(e, sessionId) {
  const id = e.message && e.message.id;
  if (!id) return null;
  if (e.requestId) return id + ':' + e.requestId;
  return id + '::' + (e.sessionId || sessionId) + ':' + (e.timestamp || '');
}

/**
 * Of two lines for the same message, keep the one with more tokens. Streamed
 * lines carry a running output count and only the last one is final, so
 * keeping the first would undercount output. Ties keep the one seen first.
 */
function bigger(a, b) {
  return a.in + a.out + a.cacheRead + a.cacheWrite > b.in + b.out + b.cacheRead + b.cacheWrite;
}

/**
 * Parse one transcript into its messages, de-duplicated within the file.
 * Streamed; never materializes the file. Malformed lines are counted and
 * skipped -- a partially-written transcript (the session is still running) is
 * the normal case, not an error. Cross-file duplicates are resolved in scan().
 */
function parseFile(file) {
  return new Promise((resolve) => {
    const out = { messages: [], badLines: 0, firstTs: null, lastTs: null };
    const sessionId = path.basename(file, '.jsonl');
    const byKey = new Map();
    let stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); }
    catch { return resolve(out); }
    stream.on('error', () => resolve(out));
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line) return;
      let e;
      try { e = JSON.parse(line); } catch { out.badLines++; return; }
      const ts = Date.parse((e && e.timestamp) || '');
      if (Number.isFinite(ts)) {
        if (out.firstTs == null || ts < out.firstTs) out.firstTs = ts;
        if (out.lastTs == null || ts > out.lastTs) out.lastTs = ts;
      }
      if (!e || e.type !== 'assistant' || !e.message) return;
      const u = e.message.usage;
      if (!u) return;
      const m = {
        key: messageKey(e, sessionId),
        model: e.message.model && e.message.model !== '<synthetic>' ? e.message.model : 'unknown',
        in: num(u.input_tokens), out: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens),
        cacheWrite1h: num(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens),
      };
      if (!(m.in || m.out || m.cacheRead || m.cacheWrite)) return;
      if (m.key == null) { out.messages.push(m); return; }
      const i = byKey.get(m.key);
      if (i == null) { byKey.set(m.key, out.messages.length); out.messages.push(m); }
      else if (bigger(m, out.messages[i])) out.messages[i] = m;
    });

    rl.on('close', () => resolve(out));
    rl.on('error', () => resolve(out));
  });
}

/** Roll a transcript's counted messages into the per-session summary. */
function summarize(parsed, messages) {
  const sum = {
    models: {}, turns: 0, badLines: parsed.badLines,
    firstTs: parsed.firstTs, lastTs: parsed.lastTs,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0, unpricedTurns: 0,
  };
  for (const t of messages) {
    sum.turns++;
    sum.tokens.in += t.in; sum.tokens.out += t.out;
    sum.tokens.cacheRead += t.cacheRead; sum.tokens.cacheWrite += t.cacheWrite;

    const m = sum.models[t.model] || (sum.models[t.model] = { turns: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheReadCost: 0, priced: priceFor(t.model) != null });
    m.turns++; m.in += t.in; m.out += t.out; m.cacheRead += t.cacheRead; m.cacheWrite += t.cacheWrite;

    const c = costOf(t.model, t);
    if (c == null) sum.unpricedTurns++;
    else { sum.cost += c.total; m.cost += c.total; m.cacheReadCost += c.cacheRead; }
  }
  return sum;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/**
 * Scan the corpus. `cache` is a plain object of path -> {size, mtime, parsed};
 * it is read and written in place so the caller can persist it.
 *
 * onProgress is called with (done, total) so the UI can show that a first scan
 * is working rather than hung -- a 260MB first pass takes long enough that a
 * blank page reads as broken.
 */
async function scan({ root, cache, onProgress, budgetMs } = {}) {
  root = root || defaultRoot();
  cache = cache || {};
  const started = Date.now();
  const files = await listTranscripts(root);
  const read = [];
  let parsed = 0, reused = 0, i = 0;
  let truncated = false;

  for (const { project, file } of files) {
    i++;
    let st;
    try { st = await fsp.stat(file); } catch { continue; }
    const key = file;
    const hit = cache[key];
    let p;
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs && hit.parsed) {
      p = hit.parsed; reused++;
    } else {
      p = await parseFile(file);
      cache[key] = { size: st.size, mtime: st.mtimeMs, parsed: p };
      parsed++;
      // Hand the event loop back between files. Without this the host is
      // unresponsive for the whole scan, which is the documented way to break
      // every other app running in the same process.
      await new Promise((r) => setImmediate(r));
    }
    read.push({ project, file, bytes: st.size, parsed: p });
    if (onProgress && (i % 25 === 0 || i === files.length)) onProgress(i, files.length);
    // A budget stops a first scan from running unbounded; the caller resumes
    // where it left off because the cache persists what was already parsed.
    if (budgetMs && (Date.now() - started) > budgetMs) { truncated = true; break; }
  }

  // A message copied into several transcripts counts once: in the transcript
  // holding its largest copy, or the first in path order on a tie.
  const owner = new Map();
  for (const r of read) {
    for (const m of r.parsed.messages) {
      if (m.key == null) continue;
      const o = owner.get(m.key);
      if (!o || bigger(m, o)) owner.set(m.key, m);
    }
  }
  const sessions = [];
  for (const r of read) {
    const kept = r.parsed.messages.filter((m) => m.key == null || owner.get(m.key) === m);
    const summary = summarize(r.parsed, kept);
    if (summary.turns > 0) {
      sessions.push({ id: path.basename(r.file, '.jsonl'), project: r.project, bytes: r.bytes, ...summary });
    }
  }

  return { sessions, stats: { files: files.length, parsed, reused, scanned: i, truncated, ms: Date.now() - started }, root };
}

/** Roll sessions up into the numbers the dashboard shows. */
function aggregate(sessions) {
  const total = { turns: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpricedTurns: 0 };
  const byModel = {};
  const byDay = {};

  for (const s of sessions) {
    total.turns += s.turns;
    total.in += s.tokens.in; total.out += s.tokens.out;
    total.cacheRead += s.tokens.cacheRead; total.cacheWrite += s.tokens.cacheWrite;
    total.cost += s.cost; total.unpricedTurns += s.unpricedTurns;

    for (const [m, v] of Object.entries(s.models)) {
      const acc = byModel[m] || (byModel[m] = { turns: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheReadCost: 0, priced: v.priced });
      acc.turns += v.turns; acc.in += v.in; acc.out += v.out;
      acc.cacheRead += v.cacheRead; acc.cacheWrite += v.cacheWrite; acc.cost += v.cost;
      acc.cacheReadCost += v.cacheReadCost || 0;
    }
    if (s.lastTs) {
      const day = new Date(s.lastTs).toISOString().slice(0, 10);
      const d = byDay[day] || (byDay[day] = { cost: 0, out: 0, cacheRead: 0, sessions: 0 });
      d.cost += s.cost; d.out += s.tokens.out; d.cacheRead += s.tokens.cacheRead; d.sessions++;
    }
  }

  // The headline insight: how many tokens you pay to re-read for every token
  // you actually produce. Cache reads are cheap per token and enormous in
  // volume, which is exactly why this ratio hides inside a normal-looking bill.
  const readWriteRatio = total.out > 0 ? total.cacheRead / total.out : null;
  const costPerKOut = total.out > 0 ? (total.cost / total.out) * 1000 : null;
  const cacheReadCost = Object.values(byModel).reduce((acc, v) => acc + v.cacheReadCost, 0);
  const cacheShare = total.cost > 0 ? cacheReadCost / total.cost : null;

  return {
    total, byModel, byDay,
    derived: { readWriteRatio, costPerKOut, cacheReadCost, cacheShare },
  };
}

module.exports = { scan, aggregate, listTranscripts, parseFile, messageKey, defaultRoot, priceFor, costOf, PRICES };
