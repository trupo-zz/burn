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
 * the numbers the API itself reported, not an estimate. A model with no price
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

function priceFor(model) {
  if (!model) return null;
  const key = Object.keys(PRICES.per_mtok).find((k) => String(model).includes(k));
  return key ? PRICES.per_mtok[key] : null;
}

function costOf(model, t) {
  const p = priceFor(model);
  if (!p) return null;
  const mult = PRICES.cache_read_multiplier;
  return (t.in * p.in + t.out * p.out + t.cacheRead * p.in * mult
    + t.cacheWrite * p.in * PRICES.cache_write_multiplier) / 1e6;
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
  return out;
}

/**
 * Parse one transcript into a summary. Streamed; never materializes the file.
 * Malformed lines are counted and skipped -- a partially-written transcript
 * (the session is still running) is the normal case, not an error.
 */
function parseFile(file) {
  return new Promise((resolve) => {
    const sum = {
      models: {}, turns: 0, badLines: 0,
      firstTs: null, lastTs: null,
      tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0, unpricedTurns: 0,
    };
    let stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); }
    catch { return resolve(sum); }
    stream.on('error', () => resolve(sum));
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line) return;
      let e;
      try { e = JSON.parse(line); } catch { sum.badLines++; return; }
      const ts = Date.parse((e && e.timestamp) || '');
      if (Number.isFinite(ts)) {
        if (sum.firstTs == null || ts < sum.firstTs) sum.firstTs = ts;
        if (sum.lastTs == null || ts > sum.lastTs) sum.lastTs = ts;
      }
      if (!e || e.type !== 'assistant' || !e.message) return;
      const u = e.message.usage;
      if (!u) return;
      const t = {
        in: num(u.input_tokens), out: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens),
      };
      if (!(t.in || t.out || t.cacheRead || t.cacheWrite)) return;

      sum.turns++;
      sum.tokens.in += t.in; sum.tokens.out += t.out;
      sum.tokens.cacheRead += t.cacheRead; sum.tokens.cacheWrite += t.cacheWrite;

      const model = e.message.model && e.message.model !== '<synthetic>' ? e.message.model : 'unknown';
      const m = sum.models[model] || (sum.models[model] = { turns: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: priceFor(model) != null });
      m.turns++; m.in += t.in; m.out += t.out; m.cacheRead += t.cacheRead; m.cacheWrite += t.cacheWrite;

      const c = costOf(model, t);
      if (c == null) sum.unpricedTurns++;
      else { sum.cost += c; m.cost += c; }
    });

    rl.on('close', () => resolve(sum));
    rl.on('error', () => resolve(sum));
  });
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/**
 * Scan the corpus. `cache` is a plain object of path -> {size, mtime, summary};
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
  const sessions = [];
  let parsed = 0, reused = 0, i = 0;
  let truncated = false;

  for (const { project, file } of files) {
    i++;
    let st;
    try { st = await fsp.stat(file); } catch { continue; }
    const key = file;
    const hit = cache[key];
    let summary;
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) {
      summary = hit.summary; reused++;
    } else {
      summary = await parseFile(file);
      cache[key] = { size: st.size, mtime: st.mtimeMs, summary };
      parsed++;
      // Hand the event loop back between files. Without this the host is
      // unresponsive for the whole scan, which is the documented way to break
      // every other app running in the same process.
      await new Promise((r) => setImmediate(r));
    }
    if (summary.turns > 0) {
      sessions.push({
        id: path.basename(file, '.jsonl'), project, bytes: st.size,
        ...summary,
      });
    }
    if (onProgress && (i % 25 === 0 || i === files.length)) onProgress(i, files.length);
    // A budget stops a first scan from running unbounded; the caller resumes
    // where it left off because the cache persists what was already parsed.
    if (budgetMs && (Date.now() - started) > budgetMs) { truncated = true; break; }
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
      const acc = byModel[m] || (byModel[m] = { turns: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: v.priced });
      acc.turns += v.turns; acc.in += v.in; acc.out += v.out;
      acc.cacheRead += v.cacheRead; acc.cacheWrite += v.cacheWrite; acc.cost += v.cost;
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
  const cacheReadCost = Object.entries(byModel).reduce((acc, [m, v]) => {
    const p = priceFor(m);
    return p ? acc + (v.cacheRead * p.in * PRICES.cache_read_multiplier) / 1e6 : acc;
  }, 0);
  const cacheShare = total.cost > 0 ? cacheReadCost / total.cost : null;

  return {
    total, byModel, byDay,
    derived: { readWriteRatio, costPerKOut, cacheReadCost, cacheShare },
  };
}

module.exports = { scan, aggregate, listTranscripts, parseFile, defaultRoot, priceFor, PRICES };
