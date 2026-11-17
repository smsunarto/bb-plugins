---
name: captain-review-loop
description: Run review rounds on implemented work, from the first Review dispatch to the verdict. Use when an Implement report claims Final, when Review reports findings, or when deciding whether another round is worth it.
---

# Captain review loop

Review checks a change against its brief through blind lens subagents and reports one batch. You decide what goes back to the implementer and when to stop.

## Start a round

1. Check the Implement report first: the branch exists, the PR is open, the head commit matches, and the checks it names passed.
2. Dispatch Review on the same task with `bb captain dispatch <task> --role Review`. It starts from the implementer's branch.
3. Give Review the code, never the implementer's conclusions. The brief and the diff are enough.

## Read the batch

- **If Review reports `Final: 0 findings`:** check that it names the head it reviewed, then record `bb captain verdict <task> review passed`.
- **If Review reports findings:** record `bb captain verdict <task> review findings`, then decide which findings to send.
- Drop findings you checked and found wrong. Keep "checked by me" apart from "reported by Review".

## Send one follow-up

- Send the kept findings to the original implementer in one message: `bb captain tell <task> --role Implement --message-file <file>`.
- Do not send findings one at a time, and do not start a new implementer for them.
- When the implementer reports its fix, re-verify with the original Review thread: `bb captain tell <task> --role Review --message-file <file>`. It fast-forwards to the new head first.

## Stop

- Stop when a round finds only rare edge cases. Record those as follow-up tasks, then record `review passed`.
- Stop and ask the user, with `bb captain ask`, when the same finding survives two fix rounds.
- **To skip review:** record `bb captain verdict <task> review skipped --reason "<why>"`. A skip without a reason is refused.

The loop is done when the task's `review` verdict is `passed` or `skipped`.
