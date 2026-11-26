---
name: captain-review-lenses
description: The Review role's lenses, one file each, run as blind background subagents over a crew change. Use when reviewing a Captain task's diff.
---

# Captain review lenses

Pick the lenses the change needs, run one background subagent per lens, and merge what they find into one verified batch.

## Pick lenses

| Lens        | File                             | Runs when                                        |
| ----------- | -------------------------------- | ------------------------------------------------ |
| Brief       | [brief.md](brief.md)             | Always                                           |
| Bugs        | [bugs.md](bugs.md)               | Always                                           |
| Visual      | [visual.md](visual.md)           | The change touches UI                            |
| Code        | [code.md](code.md)               | The diff is more than a few lines                |
| Performance | [performance.md](performance.md) | Plugin app or server code changed                |
| Security    | [security.md](security.md)       | Auth, secrets, user input or shell paths changed |

- A change of a few lines gets Brief and Bugs only.
- A `Lenses:` line in the brief adds or drops lenses, such as `Lenses: +visual -code`. It wins over the table.
- **If the brief or `CREW.md` names a Drive lens:** read it with `bb captain drive read lenses/<name>.md` and run it like the others.

## Run them

1. Start one background subagent per lens. Give each the lens file's text, the brief, the worktree path, and the scoped diff: on a first round, `git diff <target>...HEAD`; on a re-verify round, the delta from the prior reviewed head (`git diff <prior-head>..HEAD`, or `git range-diff "$(git merge-base <target> <prior-head>)..<prior-head>" "<target>..HEAD"` when rebased onto a moved target) plus the prior round's named findings.
2. Keep lenses blind: never pass the implementer's report, implementer claims, or another lens's findings.
3. Wait for every subagent's result before you merge.

## Merge the batch

- Check each finding against the code yourself. Drop what you cannot confirm.
- Merge duplicates across lenses into one finding that names every lens that found it.
- Order findings by severity: `high` breaks behavior, security, or the brief; `medium` is a real defect reachable in normal use or an exploitable security defect; `low` is a cleanup. Drop unreachable non-security edge cases or list them separately as follow-ups.
- Report one batch, as your Review contract says: the head you reviewed, then each finding with file, line, severity, lens and steps to reproduce.

The review is done when every picked lens has returned and each kept finding is confirmed by your own read.
