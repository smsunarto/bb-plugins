# Perf issue

A measured slowness to trace and improve against a baseline. Tie each fix to a measurement rather than to a reading of the source.

What tends to work:

1. Capture a baseline trace or timing on the real surface. The `benchmark-checklist` skill and `explain-the-number` help vet it and every later number.
2. Ground hypotheses in the trace. Try the performance mantras in order, cheapest first, and stop when one meets the target:
   1. Don't do it. Stop work whose result nothing uses rather than making it cheaper.
   2. Do it, but don't do it again.
   3. Do it less.
   4. Do it later.
   5. Do it when they're not looking.
   6. Do it concurrently.
   7. Do it cheaper.
3. Change one thing at a time and capture a post-fix trace after each attempt (`sequence-verifiable-units`).
4. Compare the artifacts directly, for example by diffing them or loading them into sqlite. An inconclusive or wrong-surface measurement is not a pass, so say so.

For sustained improvement of one metric, see [Hillclimb](hillclimb.md).

A good reply gives the baseline, the post-fix number, the delta, what limits it now, and the artifact paths.
