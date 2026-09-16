Native `gh stack sync` already ran and reported a non-trivial recovery state; it may have partial effects. If a `gh-stack` skill is available, follow it; otherwise use the steps below. Inspect first — do not retry sync yet.
1. `git status`: is a rebase or merge in progress, which files conflict, and what is checked out?
2. If a rebase is in progress, `git rebase --show-current-patch` shows the stopped commit. Resolve and `git rebase --continue`, or `git rebase --abort` to return to the pre-sync state when the right resolution is not obvious.
3. `gh stack view --json`: which layers exist, and where does each branch point?
4. Recover the stack, then verify: clean `git status`, no rebase in progress, and `gh stack view --json` showing every layer on its intended parent.
{{submitRule}}
Report the state you found, what you changed, and the final `gh stack view --json`. If you cannot recover safely, stop and say what is blocking you — never force-push or delete branches to clear the error.
