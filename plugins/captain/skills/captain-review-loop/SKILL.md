---
name: captain-review-loop
description: Run review rounds on implemented work, from the first Review dispatch to the verdict. Use when an Implement report claims Final, when Review reports findings, or when deciding whether another round is worth it.
---

# Captain review loop

Review checks a change against its brief through blind lens subagents and reports one batch. You decide what goes back to the implementer and when to stop.

## Decide whether to review

- **Always review** a change that touches runtime behavior, a storage schema, permissions, sends, or another plugin, whatever its size.
- **Skip Review only when all of these hold:**
  - The diff is instruction, skill or docs text only; mockups or research with no code; or a mechanical change (rename, constant, formatting) under about 20 lines that existing tests cover.
  - The diff changes no runtime behavior, data or permissions.
  - You read the diff yourself and ran the brief's checks.
- **To skip:** record `bb captain verdict <task> review skipped --head <sha> --reason "<rule it met>"` with the full head you read, such as `--reason "docs text only"`. A skip without a reason is refused.
- Otherwise start a round.

## Start a round

1. Check the Implement report as `captain.md`'s Check a report says: the branch holds commits, its head matches the report, and the checks it names pass. A PR is open, unless the brief's `Remote:` line says `none` or `direct ship`; for `direct ship`, the branch is pushed at that head.
2. Dispatch Review on the same task: `bb captain dispatch <task> --role Review`. Its worktree starts from the implementer's branch.
3. Send Review nothing from the implementer's report. The brief and the diff are enough.
4. End the turn. Review's report wakes you.

## Read the batch

- **If Review reports `Final: 0 findings`:** check that its head equals the implementer's head, then record `bb captain verdict <task> review passed --head <sha>`. Add `--ship` when the change is ready to ship: its PR is open, or for `direct ship` its branch is pushed. `--ship` needs the full 40-hex `--head`. Pass `--reason` naming how it ships, such as `--reason "Direct ship to main."` or `--reason "Merges PR #12 into main."`, so the ask shows the user which path and branch.
- **If Review reports findings:** check each against the code, inline or through a background subagent, then record `bb captain verdict <task> review findings --head <sha>`.
- Drop findings you checked and found wrong. Keep "checked by me" apart from "reported by Review".

## Send one follow-up

1. Write the kept findings to one file in your Drive, such as `findings/<task>-r<round>.md`.
2. Send them to the original implementer in one message: `bb captain tell <task> --role Implement --message-file <file>`. Never send findings one at a time, and never start a new implementer for them.
3. When the implementer reports its fix, re-verify with the original Review thread: `bb captain tell <task> --role Review --message-file <file>`, naming the new head. It fast-forwards to that head first.

## Stop

- Stop when a round finds only rare edge cases. File those as follow-up tasks with `bb tasks create`, then record `review passed`.
- Stop and ask the user, with `bb captain ask`, when the same finding survives two fix rounds. Keep options ≤12 columns (wide characters count 2) with no ⭐/markers, such as `Fix again` or `Accept`; the finding goes in `--detail-file`.

The loop is done when the task's `review` verdict is `passed` or `skipped`.
