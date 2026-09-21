# burn

**Where your Claude Code money actually goes.**

Your invoice tells you the total. It doesn't tell you that most of it can be
context you already paid to send, re-read again on the next turn.

```
git clone https://github.com/trupo-zz/burn && node burn/cli.js
```

That's it. No install, no account, no config, no network, nothing to add to
your project.

```
  burn — where your Claude Code money goes
  ----------------------------------------------------
  total spend            $4,132
  model turns            39,584
  output tokens          33.5M   (the work you got)
  context re-read        5.6B    (cached input, billed at 10%)
  read : write ratio     168x
  cost per 1k output     $0.12
  spent re-reading       $2,286  (55% of total)
```

That's one real machine. **Fifty-five percent of the bill bought no new output** —
it re-read context. Cached reads bill at a tenth of input price, which is exactly
why this hides: the per-token number looks harmless and the volume is enormous.

168 tokens re-read for every token produced.

## Why you can't see this any other way

The console shows you a total. Per-session cost isn't broken out, and cache
reads — the line item that dominates most bills — aren't separated from input at
all. burn reads the `usage` block Claude Code already writes into every
transcript on your disk, which is the same number the API reported and billed.

## Usage

```
node cli.js                  # the report
node cli.js --json           # machine-readable, for your own dashboards
node cli.js --top 20         # more of your expensive sessions
node cli.js --root <dir>     # a different transcript root
```

Node 18+. Zero dependencies — nothing to install, `git clone` is the install.

## What it measures

| number | meaning |
| --- | --- |
| total spend | every priced turn, summed from reported token counts |
| output tokens | tokens the model actually produced — the work you got |
| context re-read | cached input tokens, billed at 0.1x |
| read : write ratio | cached tokens re-read per token produced |
| cost per 1k output | what a thousand tokens of real work costs you |
| spent re-reading | the share of the bill that bought no new output |
| most expensive sessions | ranked, with each one's read:write ratio |

A high read:write ratio on a single session usually means one thing: a long
conversation where large files stayed in context turn after turn. That is the
number to act on.

## Privacy

burn reads `~/.claude/projects` and nothing else. It makes no network calls of
any kind — there is no telemetry to turn off, because there is no telemetry. The
`--json` output is yours; nothing is uploaded anywhere.

## Accuracy

Costs come from each turn's reported `usage` block, not an estimate, multiplied
by a bundled price table (`prices.json`, verified 2026-09-13). Two honest
caveats, both shown in the report rather than hidden:

- **Unpriced models are counted in tokens and excluded from cost.** A model with
  no price entry never gets a guessed price — guessing would silently corrupt
  the one number this tool exists to produce.
- **Fast-mode turns are under-counted.** Transcripts don't record the speed
  parameter, so those turns are priced at the standard rate.

Prices change. If the table drifts, `prices.json` is a single file — edit it, or
open an issue.

## Tests

```
npm test
```

Nine assertions against a synthetic corpus with hand-computed answers, including
the cache-read multiplier — the single most expensive thing to get wrong.

## License

MIT
