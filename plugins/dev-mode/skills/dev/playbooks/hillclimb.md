# Hillclimb

Sustained improvement of one measurable thing against a target. A one-off fix is a [Bug fix](bug-fix.md) or [Perf issue](perf-issue.md); this is the loop.

The core habit is one change, one measurement, then keep or revert. Stacking untested changes or claiming a win from code inspection tends to mislead (`prove-it-works`).

What tends to work:

1. Ground the workload first. Learn the target's architecture, name the workload dimensions that can move the result (data size, history, state, concurrency), and pick a case that reproduces the user's complaint. If none does, fix the repro before climbing. Then fix one metric, its better direction, and a stop condition that pairs a target with a minimum number of attempts, so a lucky early win doesn't end the run. Use the user's numbers when given.
2. Build the measurement harness, show it is sensitive, then freeze it (`build-the-lever`, the `benchmark-checklist` skill). Contrasting workloads should separate as expected. Have it print its error count and how much work it did, and sample enough to clear the noise (a median of N runs). Record the baseline and a green run of the regression tests before any change.
3. Keep a decision log outside the tree, such as a `decision.tsv` with one row per attempt: id, hypothesis, change, before, after, delta, tests, kept or reverted, note. Reread it before each attempt.
4. Give each hypothesis a specific mechanism ("defer X off the boot path because it blocks first paint"), not "try memoizing something". For performance, the mantras in [Perf issue](perf-issue.md) suggest an order.
5. Loop one hypothesis at a time. Measure before and after with the frozen harness and run the regression tests. Keep the change only when the metric moves past noise and the tests stay green; otherwise revert it fully. Commit each accepted change on its own, and log the row either way. Independent hypotheses can run in parallel in separate worktrees (`separate-before-serializing-shared-state`).
6. Push past the first plateau. After several rejects in a row, switch category, combine near-misses, reread the source, or try something bolder. Correctness and simplicity outrank the number: revert a win that breaks behavior, and keep a simplification that holds the number (`grug-brain`).
7. Stop when the target is met or the remaining ideas aren't worth their cost. Don't relax the target to meet it, and surface a real dead end instead of spinning.

A good reply gives the metric and target, baseline to final with the percent change, attempts kept and reverted, each accepted change on one line, the decision log path, and the next idea you would try.
