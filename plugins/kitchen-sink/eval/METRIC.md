# The metric

One number decides every iteration. It is frozen. Changing the harness, the
cases, or the criteria invalidates every number measured before the change.

## embed-score

The mean, over candidate runs, of the share of target criteria that a run met.
A run with two of its three applicable criteria satisfied scores 2/3. Higher is
better. Measured over 12 cases by 3 repetitions, 36 runs.

The plan defined this as the fraction of runs passing every criterion. That
version failed its own freeze gate. Baseline already fell short on placement and
range often enough that the deliberately bad prompt had no room to fall further,
and the two versions overlapped. Grading each run by the share of criteria met
removes that floor and separates cleanly. `clean runs`, the original all-or-
nothing number, is still reported beside it so nothing is hidden.

A run is one case answered once by `claude -p` inside a throwaway copy of that
case's fixture. Its ground truth is the response text plus `git diff -U0` from
the copy.

## Target criteria

A run passes only when all three hold. A criterion that does not apply to the
case is skipped, never counted as a pass.

**necessity.** No `::smart-diff` on a path the user never asked about. Applies to
every case. It fails when a smart-diff names a path in the case's `noDiffFor`,
when the case is read-only (`noDiffFor` is `"*"`) and any smart-diff appears at
all, or when a smart-diff names a file the run never changed. `::smart-code` is
always allowed and never counts against necessity.

**range-fits.** Applies when the case lists `rangeRequiredFor`. Every listed file
needs at least one smart-diff, and every smart-diff on it must carry `start` and
`end`, span at most 80 lines, and overlap a real new-side hunk from the run's own
diff.

**placement.** Applies when the run emitted at least one directive. Two
independent checks must both hold.

- Judge. A GPT-5.2 pass says the directive sits directly under the sentence it
  supports.
- Proxy. Each directive has one of the three lines above it naming its path, that
  path's basename, or one of the case's `anchorSymbols`. And the directives are
  not all parked past the last line of prose, unless the whole answer is a single
  paragraph carrying a single embed, where the claim and its evidence sit in the
  same place anyway.

## Gate criteria

These do not enter embed-score. They catch a variant that wins by emitting
nothing, and they must not drop more than 5 points below baseline.

**coverage.** Every path in `expectDiffFor` got a smart-diff, and a read-only case
got at least one smart-code.

**budget.** At most 6 directives, and zero directive-shaped lines that the
renderer would swallow (inside a fence, inline, or malformed).

`bun run test` in the plugin is the third gate and must stay green.

## Case mix

| kind          | count | what it probes                                                              |
| ------------- | ----- | --------------------------------------------------------------------------- |
| range         | 4     | a 150 to 300 line file where the task touches one function                  |
| investigation | 2     | a read-only question, where any diff is a miss                              |
| generated     | 2     | a real change beside regenerated output, where diffing the output is a miss |
| incidental    | 2     | a neighbour already dirty in the worktree that the prompt never names       |
| small         | 2     | a one-line edit, where a whole-file diff is fine                            |

## Blinding

Candidates never learn they are measured.

- Each run happens in a fresh `mktemp` directory named after the toy project, so
  no path carries eval, test, judge, score, or candidate.
- Prompts read as organic user requests.
- `--safe-mode` drops this machine's `CLAUDE.md`, skills, plugins, and hooks, so
  the only instruction under test is the appended prompt. Auth still works.
- The judge is GPT-5.2 through `cursor-agent`, a different model family from the
  Anthropic candidates. It sees one excerpt per directive under an opaque hash,
  shuffled across every run in the pass, so it cannot tell which variant or which
  model produced an item, or even how many variants are present.

The plan named Codex as the judge. Codex hit its account usage limit on
2026-09-04 and refused every request until 2026-09-08, so the judge moved to
GPT-5.2 through `cursor-agent`. Same requirement met, different vendor path.

## The frozen commands

```
bun eval/run.ts   --variant <name> --reps 3 --model sonnet --concurrency 6
bun eval/judge.ts <run-id> [<run-id> ...]
bun eval/score.ts <run-id>
bun eval/report.ts <run-id> [<run-id> ...]
```

`--case <id>` and `--reps 1` make exploring cheap. Those runs never count as a
measurement.

A run times out after 5 minutes and after 40 turns. A timeout scores as a failed
run. It is reported and never retried in silence.

## Noise band and sensitivity

Recorded once the sensitivity proof runs. Baseline is measured twice for the
band. `worst.md` appends every full-file diff in one block at the bottom, and
must land below baseline by more than the band before any hypothesis is tried.

| measurement | run id                                     | embed-score |
| ----------- | ------------------------------------------ | ----------- |
| baseline 1  | `baseline-sonnet-2026-09-04T02-23-30-014Z` | 64.4%       |
| baseline 2  | `baseline-sonnet-2026-09-04T02-28-09-603Z` | 68.5%       |
| worst       | `worst-sonnet-2026-09-04T02-30-04-227Z`    | 50.9%       |

Baseline is 66.5%, the mean of the two. The noise band is 4.1 points, the spread
between them. Worst sits 13.5 points below the lower baseline, more than three
times the band, so the ruler distinguishes a bad prompt from the shipped one.

Frozen on 2026-09-04 at this point. Every number above and after comes from the
same criteria. The three runs above were scored twice, before and after the two
criteria revisions, from the same stored artifacts. Rescoring is deterministic
given the response, the diff, and a stored `judgments.json`. It is not free of
the judge: placement depends on a GPT-5.2 pass, so rescoring only reproduces a
number when the same stored verdicts are reused.

Two limits on the band, stated plainly rather than smoothed over.

- It comes from two measurements. That is a spread, not a variance estimate, and
  two points cannot tell you the shape of the distribution. With 36 runs and a
  rate near 0.66, binomial noise alone puts the standard deviation of a single
  measurement near 8 points on `clean runs`; `embed-score` is graded and steadier,
  but 4.1 is a floor on the real noise, not a ceiling.
- The kept variant was measured four times on Sonnet across four separate judge
  passes over the same candidate outputs: 79.6, 78.2, 79.6, 79.6. That 1.4 point
  spread isolates judge noise only, since the candidate runs were identical. It
  does not bound candidate-side noise.

Treat a gap under about 5 points as unresolved. Both accepted results here, +13.1
on Sonnet and +16.6 on Opus, sit far outside that.

## Stop predicate

The original predicate was: embed-score at least 30 points above baseline, at
least 6 iterations logged, gate green. It was written against the all-or-nothing
metric, whose baseline was near 46%. After the metric was regraded the baseline
rose to 66.5%, which put +30 at 96.5% and required near-perfect placement. The
run did not meet it. It reached +13.1.

Partway through, the operator replaced the target with a different rule: stop
once a kept variant beats baseline past the noise band, does not regress coverage
or budget by more than 5 points, and the cheap placement hypotheses are spent.
That is the rule the run stopped under, and it is recorded here so nobody reads
the +30 as met.

The run stopped with:

1. embed-score 66.5% to 79.6% on Sonnet, +13.1 against a 4.1 point band. Short of
   the original +30.
2. Eleven iterations logged, one kept and ten reverted.
3. Gate green. Coverage 91.7% against 94.4%, budget 100% against 100%, and
   `bun run test` passing from the repository root.
