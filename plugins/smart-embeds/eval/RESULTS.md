# Smart Embeds instruction hillclimb

Metric, criteria, and stop predicate live in `METRIC.md`. This file records what
was measured.

## Baseline

Sonnet, 12 cases by 3 repetitions, 36 runs per measurement. Claude Code 2.1.259.

| criterion       | baseline 1 | baseline 2 | worst  |
| --------------- | ---------- | ---------- | ------ |
| embed-score     | 64.4%      | 68.5%      | 50.9%  |
| clean runs      | 30.6%      | 38.9%      | 36.1%  |
| necessity       | 97.2%      | 94.4%      | 69.4%  |
| range-fits      | 25.0%      | 50.0%      | 0.0%   |
| placement       | 38.2%      | 47.1%      | 25.0%  |
| coverage (gate) | 94.4%      | 94.4%      | 52.8%  |
| budget (gate)   | 100.0%     | 100.0%     | 83.3%  |
| timeouts        | 0          | 0          | 0      |
| mean cost       | $0.084     | $0.077     | $0.082 |

Baseline is 66.5%. The noise band is 4.1 points. Worst sits 13.5 points below the
lower baseline, so the ruler separates.

## The three complaints, and the mechanism behind each

Every quote is from `baseline-sonnet-2026-09-04T02-23-30-014Z`.

### Placement: "in the final response" reads as "at the end of the response"

The dominant failure. Ten of twelve cases show it. The shipped text says to place
the directive "on its own line in the final response", which names the message,
not the position. Every model read it as the position. `discount-rounding` rep2 in
full:

```
Fixed — `Math.floor` truncated toward zero; `Math.round` rounds half up ..., so 1999.5 → 2000.

::smart-diff{path="src/pricing.ts" start="31" end="35"}
```

The range is right and the file is right. The embed still lands after the prose
ends rather than under the sentence that makes the claim. On longer answers the
same habit collects every embed into one block at the bottom, which is exactly
what the reader has to scroll past.

### Range: the range form is written as an optional extra

`range-fits` is 25% and 50% across the two baselines. The shipped text introduces
the plain form first and the range form second, as a thing you may add "to show
only part of a large diff". So the plain form is the default and the model keeps
it even on a 214 line file. `ledger-format-amount` rep2:

```
No tests reference the old paren format. Change is minimal and thousands-grouping is untouched ...

::smart-diff{path="src/ledger.ts"}
```

`src/ledger.ts` is 214 lines and the change is one line.

### Necessity: "material files" does not name the cases that are not material

`necessity` is high overall, 97.2% and 94.4%, because only the generated-output
and read-only cases can fail it. Where it fails it fails cleanly.
`config-retries` rep1:

```
Added `retries` (0–10, optional integer) to `Config` and the `fields` table, and regenerated `generated/schema.json`.

::smart-diff{path="src/config.ts"}
::smart-diff{path="src/fields.ts"}
::smart-diff{path="generated/schema.json"}
```

The third embed renders a diff of a file a generator wrote. Nobody reads it. The
shipped text's only guard is "only for material files or claims", which never says
that regenerated output, lockfiles, and files the user did not ask about are the
cases it means.

## Iterations

See `.scratch/smart-embeds-eval/decisions.tsv` for the full decision trail, one
row per iteration.
