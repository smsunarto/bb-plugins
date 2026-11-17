---
name: captain-review-loop
description: Run review rounds on implemented work, from the first Review dispatch to the verdict. Use when an Implement report claims Final, when Review reports findings, or when deciding whether another round is worth it.
---

# Captain review loop

Review checks a change against its brief through blind lens subagents and reports one batch. You decide what goes back to the implementer and when to stop.

## Start a round

1. Check the Implement report as `captain.md`'s Check a report says: the branch holds commits, its head matches the report, and the checks it names pass. A PR is open unless the brief said the repo has no remote.
2. Dispatch Review on the same task: `bb captain dispatch <task> --role Review`. Its worktree starts from the implementer's branch.
3. Send Review nothing from the implementer's report. The brief and the diff are enough.
4. End the turn. Review's report wakes you.

## Read the batch

- **If Review reports `Final: 0 findings`:** check that its head equals the implementer's head, then record `bb captain verdict <task> review passed --head <sha>`. Add `--ship` when a PR is ready to merge.
- **If Review reports findings:** check each against the code, inline or through a background subagent, then record `bb captain verdict <task> review findings --head <sha>`.
- Drop findings you checked and found wrong. Keep "checked by me" apart from "reported by Review".

## Send one follow-up

1. Write the kept findings to one file in your Drive, such as `findings/<task>-r<round>.md`.
2. Send them to the original implementer in one message: `bb captain tell <task> --role Implement --message-file <file>`. Never send findings one at a time, and never start a new implementer for them.
3. When the implementer reports its fix, re-verify with the original Review thread: `bb captain tell <task> --role Review --message-file <file>`, naming the new head. It fast-forwards to that head first.

## Stop

- Stop when a round finds only rare edge cases. File those as follow-up tasks with `bb tasks create`, then record `review passed`.
- Stop and ask the user, with `bb captain ask`, when the same finding survives two fix rounds.
- **To skip review:** record `bb captain verdict <task> review skipped --reason "<why>"`. A skip without a reason is refused.

The loop is done when the task's `review` verdict is `passed` or `skipped`.
