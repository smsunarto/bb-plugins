# Autonomous run

A long task to drive to completion without stopping, such as "run until done" or "loop until X".

What tends to work:

1. State the exit condition as a checkable predicate before the first iteration: tests green, repro fixed, all N PRs merged, pixel diff zero.
2. Pick how you'll wake. When there's an event to watch (CI, a merge, a ref advancing, a child thread finishing with `bb thread wait`), wait on it with a long time-based fallback. Without one, use a fixed interval sized to when the result is worth checking again.
3. Each iteration, make the smallest change the evidence justifies, check it against the predicate, and commit if it moved things forward. Revert changes that didn't help rather than letting "might help" ride (`sequence-verifiable-units`).
4. Handle mid-run discoveries yourself when they're reversible: broken skills, related bugs, flaky checks, tooling failures. Out-of-band fixes go in their own commit or PR, and then you return to the predicate. Pause for irreversible actions, product or preference calls no experiment can settle, or a real dead end.
5. Keep a short log outside the tree, one row per iteration: what changed and whether the predicate moved.
6. Stop when the predicate is met. A plateau is a cue to change approach, not to stop. Don't relax the predicate to declare victory.

A good reply covers the exit condition, iterations run, what landed, what was discarded, and the final predicate state.
