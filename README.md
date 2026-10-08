# burn

**Where your Claude Code money actually goes.**

On one heavy user's machine, 47% of the Claude Code cost at API rates was context
already paid for, re-read from the cache on the next turn. burn shows you your share,
and you can check that it makes no network calls.

```
git clone https://github.com/trupo-zz/burn && node burn/cli.js
```

That's it. No install, no account, no config, no network, nothing to add to
your project.

```
  burn — where your Claude Code money goes
  ----------------------------------------------------
  API-equivalent cost    $2,028
  model turns            18,692
  output tokens          17.1M   (the work you got)
  context re-read        2.3B   (cached input, 2.5-10% of input price)
  read : write ratio     133x
  cost per 1k output     $0.12
  spent re-reading       $950.49   (47% of total)
  unpriced turns         22   (counted in tokens, excluded from cost)

  by model
    claude-opus-5                    8,597 turns     7.5M out      $1,473
    claude-sonnet-5                  4,646 turns     5.7M out     $272.58
    claude-sonnet-5-5                2,766 turns     1.7M out     $147.03
    claude-opus-5-5                  1,388 turns     1.1M out      $88.00
    claude-haiku-4-5-20251001        1,257 turns     1.2M out      $45.91
    claude-fable-5-1                     6 turns      320 out       $1.27
    claude-haiku-5-5                    10 turns      661 out       $0.01
    ornith-9b-ctx64k:latest             18 turns      743 out  free/unpriced
    ornith:9b                            4 turns       46 out  free/unpriced

  most expensive sessions (top 10)
    3abd7394    $167.56    441 turns    532x read:write  2026-09-21
    ff014db2     $98.51    416 turns    454x read:write  2026-09-17
    72a2f0be     $93.20    308 turns    306x read:write  2026-09-22
    1321106e     $69.32    175 turns    424x read:write  2026-09-14
    99f0bc2e     $65.47    558 turns    157x read:write  2026-10-08
    342b95be     $55.58    104 turns    224x read:write  2026-09-18
    695bf47d     $53.61    263 turns    293x read:write  2026-09-15
    a0ebf23d     $52.17    266 turns    301x read:write  2026-09-12
    f933d4fd     $46.93    297 turns    337x read:write  2026-09-17
    03ae7281     $41.04    308 turns     81x read:write  2026-10-08

  3,117 transcripts in 7.3s · ~/.claude/projects
  Costs = recorded token counts x bundled price table (API rates, prices.json 2026-10-08).
  Fast-mode turns are priced at the standard rate, so they are under-counted.
```

(path shortened)

That's one real machine, n=1: one heavy user, the de-duplicated 2026-10-08 run (3,117
transcripts, each assistant message counted once; the turn count moves by a handful
between runs because transcripts are still being written). The dollar
figures are **API-equivalent cost**, what those tokens cost at API rates; if you are on
a subscription you do not pay this. **47% of that cost went to re-reading cached
context.** Cached reads bill at a tenth of input price or less, so this is not pure
waste, but the per-token number looks harmless and the volume is enormous. Your share
will differ.

133 tokens re-read for every token produced.

## What Anthropic's own pages show

Anthropic's Console Usage page shows usage by model, date and API key. It shows cache
as a rate (the percentage of input tokens read from cache), not as token counts, and
its Cost page does not separate cache out. Neither breaks anything down by session
(source: [Cost and usage reporting in Console](https://support.claude.com/en/articles/9534590-cost-and-usage-reporting-in-console),
read 2026-10-08). If you use Claude Code on a subscription there is no per-token bill
at all. burn reads the `usage` block Claude Code already writes into every
transcript on your disk, so it can rank sessions and show the re-read share of cost.

## burn vs ccusage and CodeBurn

Both are far more popular and broader, and if you want breadth you should use them.
Details below are from their repos on 2026-10-08 and may have changed.

- [ccusage](https://github.com/ccusage/ccusage) (about 18.9k stars): many agent CLIs,
  daily, weekly, monthly and session reports, and it shows cache creation and cache
  read tokens separately.
- [CodeBurn](https://github.com/getagentseal/codeburn) (about 11.4k stars): 37+ tools
  and agents, local, MIT. Its CLI sends nothing, but prices are fetched from LiteLLM
  (cached 24 hours) and some features call out. It has an `optimize` check that flags
  Claude re-reading the same files.

burn is deliberately narrower:

- **One question:** how much of the cost was re-reading cached context instead of
  producing new output. That share is the headline, not a column.
- **No network calls, zero dependencies.** Two small JS files you can read in a few
  minutes before running them on your transcripts; prices are bundled in
  `prices.json`. `grep -nE "require(|http|fetch" cli.js scan.js` shows only Node's
  `fs`, `path` and `readline` plus the local `scan.js`.
- **Claude Code only.** No plans to chase breadth.

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
| API-equivalent cost | every priced turn at API rates, summed from recorded token counts |
| output tokens | tokens the model actually produced — the work you got |
| context re-read | cached input tokens, billed at 2.5-10% of input price depending on model |
| read : write ratio | cached tokens re-read per token produced |
| cost per 1k output | what a thousand tokens of real work costs you |
| spent re-reading | the share of total cost that went to cache reads (discounted, so not pure waste) |
| most expensive sessions | ranked, with each one's read:write ratio |

A high read:write ratio on a single session usually means one thing: a long
conversation where large files stayed in context turn after turn. That is the
number to act on.

## Privacy

burn reads `~/.claude/projects` and nothing else. It makes no network calls of
any kind — there is no telemetry to turn off, because there is no telemetry. The
`--json` output is yours; nothing is uploaded anywhere.

## Accuracy

Costs are computed from each turn's recorded `usage` token counts, multiplied
by a bundled price table (`prices.json`, verified 2026-10-08 against
[Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing)).
Each model has its own cache-read rate, and cache writes are priced by TTL
(1-hour writes bill at 2x input, 5-minute at 1.25x). A model id is priced only
on an exact match or a dated snapshot of a known id, never by prefix. Two honest
caveats, both shown in the report rather than hidden:

- **Unpriced models are counted in tokens and excluded from cost.** A model with
  no price entry never gets a guessed price — guessing would silently corrupt
  the one number this tool exists to produce.
- **Fast-mode turns are under-counted.** They are priced at the standard rate,
  not the fast-mode premium.

Prices change. If the table drifts, `prices.json` is a single file — edit it, or
open an issue.

## Verify the math

Where it happens: `costOf` in `scan.js` computes the cost of one turn; `priceFor` picks
the price row; `aggregate` sums turns. Where prices come from: `prices.json`, in USD
per million tokens, copied from Anthropic's [pricing page](https://platform.claude.com/docs/en/about-claude/pricing)
and dated in its `verified` field (2026-10-08).

Recompute one turn by hand, from a clone of this repo:

```
node verify.js
```

That takes your newest transcript under `~/.claude/projects`. To check a specific
one, pass its path: `node verify.js path/to/session.jsonl`. Both forms work as-is in
bash and PowerShell; there is nothing to quote.

It prints the first priced turn's raw `usage` block, the `prices.json` row it was
matched to, and the cost worked out line by line:

```
cost = ( input_tokens × in
       + output_tokens × out
       + cache_read_input_tokens × cache_read
       + (cache_creation_input_tokens − 1h writes) × cache_write_5m
       + 1h writes × cache_write_1h ) ÷ 1,000,000
```

where 1h writes is `cache_creation.ephemeral_1h_input_tokens`. Haiku 5.5 switches to
its `above` row when the whole prompt is over the threshold. That hand computation
reads `prices.json` directly, without calling burn. The last two lines are the hand
total and burn's own `costOf` for the same turn, followed by `match` (exit 0) or
`MISMATCH` (exit 1).

Worked example with made-up numbers (a synthetic turn, not from my machine), on
`claude-opus-5-5` (in $4, out $20, cache read $0.20, 1h write $8 per million):
100 in, 500 out, 120,000 cache read, 2,000 1h cache write →
0.0004 + 0.0100 + 0.0240 + 0.0160 = **$0.0504**, of which $0.024 is cache read. burn
prints the same $0.0504 for that input.

## Tests

```
npm test
```

Seventeen assertions against a synthetic corpus and the price table, with
hand-computed answers, including per-model cache-read rates — the single most expensive thing to get wrong.

## License

MIT
