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

## The climb, on Sonnet

Eleven iterations, one kept and ten reverted. Every variant was measured against
the then-current shipped text, judged in the same pass as its baseline so the two
sit on one scale. The `vs base` column is the variant minus the baseline measured
in that same judge pass.

| iteration | variant              | embed-score | vs base | verdict  |
| --------- | -------------------- | ----------- | ------- | -------- |
| 1         | range-by-default     | 79.6%       | +15.2   | kept     |
| 2         | place-under-claim    | 68.1%       | +3.7    | reverted |
| 3         | skip-unasked-files   | 65.7%       | +1.3    | reverted |
| 4         | name-then-show       | 73.1%       | -5.1    | reverted |
| 5         | claim-then-panel     | 74.1%       | -4.1    | reverted |
| 6         | fewer-embeds         | 76.9%       | -1.3    | reverted |
| 7         | show-the-shape       | 75.5%       | -4.1    | reverted |
| 8         | show-the-shape-twice | 83.8%       | +4.2    | reverted |
| 9         | lead-with-the-change | 73.6%       | -6.0    | reverted |
| 10        | shape-plus-trigger   | 76.9%       | -2.7    | reverted |
| 11        | shape-one-example    | 77.3%       | -2.3    | reverted |

Baseline 66.5%, final 79.6%. That is +13.1 points, or +19.7% relative, against a
4.1 point noise band.

Iteration 8 is the one that hurts to revert. It produced the best placement of
the whole run, 78.3% against 52.8%, by showing the prose-then-directive shape as
a worked example instead of describing it. It also cut coverage from 91.7% to
52.8%, far outside the 5 point gate, because the rewrite dropped the sentence
saying when to emit an embed at all. Iterations 10 and 11 put that sentence back
and recovered coverage only to 77.8% and 75.0%, still gate-red, while necessity
slipped to 88.9% and 86.1%. A worked example reliably teaches the shape and
reliably suppresses the count. Nothing tried so far buys the first without
paying the second.

## Placement did not yield

Nine of the eleven iterations attacked placement. All nine were reverted. After
the third, the criterion was split into its parts to stop guessing:

| variant          | judge says no | nothing above names it | all parked at the end |
| ---------------- | ------------- | ---------------------- | --------------------- |
| pre-hillclimb    | 24%           | 38%                    | 24%                   |
| name-then-show   | 19%           | 47%                    | 17%                   |
| claim-then-panel | 25%           | 39%                    | 11%                   |
| fewer-embeds     | 25%           | 47%                    | 11%                   |

Telling agents where to put the embed works: the share of answers that park every
embed at the end falls from 24% to 11%. It just does not pay, because the
binding term is the other one. Agents write a terse sentence describing the
change by its effect and never name the file or the function, so a reader still
cannot tell what the panel below is about. `restock-limit` is typical: "Added a
max-quantity check that returns 422 `invalid_quantity` when restock quantity
exceeds 10000", followed by a diff of a file the sentence never mentions.

## Opus confirmation

Two repetitions each, one judge pass over both.

| criterion       | pre-hillclimb | final (range-by-default) |
| --------------- | ------------- | ------------------------ |
| embed-score     | 68.1%         | 84.7%                    |
| clean runs      | 33.3%         | 66.7%                    |
| necessity       | 91.7%         | 100.0%                   |
| range-fits      | 0.0%          | 75.0%                    |
| placement       | 66.7%         | 70.8%                    |
| coverage (gate) | 91.7%         | 91.7%                    |
| budget (gate)   | 100.0%        | 100.0%                   |
| mean cost       | $0.287        | $0.270                   |

Opus confirms, +16.6 points against a 4.1 point band, with coverage and budget
unchanged. Opus never once used a line range under the old text, 0.0%.

## Iterations

See `.scratch/smart-embeds-eval/decisions.tsv` for the full decision trail, one
row per iteration.
