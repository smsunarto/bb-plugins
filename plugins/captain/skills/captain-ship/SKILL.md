---
name: captain-ship
description: Merge a crew PR after the user approved it. Use when a ship ask was answered Merge, or when ordering several approved PRs.
---

# Captain ship

You merge only what the user approved, exactly as reviewed. Run the merge through a subagent, so your own turn stays short.

## Check the grant

The grant covers one PR, once. Before merging, confirm all of these with your own reads:

- The task's ship ask was answered **Merge**: the `[captain] <id> answered "Merge"` line, or the task's `Answered: Merge (<id>)` comment in `bb tasks show <key>`. **Hold** or no answer means no merge.
- The task's `review` verdict is `passed`, or `skipped` with a reason. Its `ready` row in `bb captain status` shows the verdict and the head it recorded, as `review passed @<sha>`.
- The PR's head commit equals that recorded head. **If the head moved:** send the task back to Review; the grant does not cover new commits.
- Checks are green at that head, the PR is mergeable, and its base is the right target branch. `bb tasks show <key> --json` lists the task's `pullRequests`.

## Merge

1. Give a subagent exactly this PR, its expected head, and the merge method the repo uses.
2. The subagent merges without force and without rewriting the head, then confirms the PR is merged.
3. Set the task `done` with `bb tasks update <key> --status done`.
4. Archive the crew threads on the task with `bb thread archive <id>` once you have read their final reports.

The merge is done when the PR shows merged, the task is `done`, and its crew threads are archived.

## Several approved PRs

- Merge PRs that touch disjoint files in any order.
- Merge PRs that touch the same files one at a time, oldest approval first.
- A PR that must rebase after another lands gets a new head, which the grant does not cover. Have its implementer rebase, then re-verify with its Review thread before you merge it.
- Stack a PR that depends on another on top of it, and merge the stack bottom first.
