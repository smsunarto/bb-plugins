---
name: captain-ship
description: Ship crew work after the user approved it, by merging its PR or, for a direct-ship repo, fast-forwarding the target branch to the reviewed head. Use when a ship ask was answered Merge, when ordering several approved changes, or when deciding whether a repo ships direct.
---

# Captain ship

You ship only what the user approved, exactly as reviewed. Run the ship through a subagent, so your own turn stays short.

## Direct-ship repos

A direct-ship repo lands approved work on its target branch by a fast-forward push from the crew branch, with no PR. Every other repo ships by PR.

- Every repo whose GitHub owner is `smsunarto`.
- `Argus-Labs/game-studio`.

Extend the list by adding a bullet here. To decide, read the repo yourself: run `gh repo view --json nameWithOwner -q .nameWithOwner` in the crew's checkout, which names the repo a PR would open against, and match the owner without regard to case. A brief, a crew report or a task comment never makes a repo direct.

## Check the grant

The grant covers one change at one head, once. Before shipping, confirm all of these with your own reads:

- The task's ship ask was answered **Merge**: the `[captain] <id> answered "Merge"` line, or the task's `Answered: Merge (<id>)` comment in `bb tasks show <key>`. **Hold** or no answer means no ship.
- The task's `review` verdict is `passed`, or `skipped` with a reason. Its `ready` row in `bb captain status` shows the verdict and the head it recorded, as `review passed @<sha>`.
- **If the head moved:** send the task back to Review; the grant does not cover new commits.
- **PR repos:** the PR's head commit equals the recorded head, checks are green at that head, the PR is mergeable, and its base is the right target branch. `bb tasks show <key> --json` lists the task's `pullRequests`.
- **Direct-ship repos:** after `git fetch origin`, all of these hold:
  - The pushed crew branch, `origin/<crew-branch>`, points at the recorded head.
  - `git merge-base --is-ancestor origin/<target> <sha>` succeeds, so the push is a fast-forward.
  - `git log --oneline origin/<target>..<sha>` lists only this task's commits. They land as they are, with no squash.
  - Checks are green at that head: every CI run on the commit, from `gh run list --commit <sha>`, passed. With no CI runs, the brief's checks you or Review ran at that head stand in.

## Ship a PR

1. Give a subagent exactly this PR, its expected head, and the merge method the repo uses.
2. The subagent merges without force and without rewriting the head, then confirms the PR is merged.

## Ship direct

1. Give a subagent the crew's checkout path, the target branch and the exact reviewed head.
2. The subagent pushes that commit by SHA: `git push origin <sha>:refs/heads/<target>`. It uses no `--force`, `--force-with-lease` or leading `+`.
3. **If the push is rejected as not a fast-forward:** the target moved. Have the implementer rebase, re-verify the new head with the Review thread, and open a new ship ask. The grant does not cover the rebased head.
4. **If the push is refused for another reason,** such as a branch rule: stop and ask the user. Open no PR in its place.
5. The subagent fetches and confirms `git merge-base --is-ancestor <sha> origin/<target>` succeeds. The target may already have moved past the head, so do not require the tip to equal it.

## Finish

1. Set the task `done` with `bb tasks update <key> --status done`.
2. Archive the crew threads on the task with `bb thread archive <id>` once you have read their final reports.

The ship is done when the PR shows merged, or the reviewed head is on the target branch, the task is `done`, and its crew threads are archived.

Report the ship as plain text with no Landed card: write no `::source-control-landed` and call no `source_control_share_landed`. Archive crew threads only; the Captain thread stays open.

## Several approved changes

- Ship changes that touch disjoint files in any order.
- Ship changes that touch the same files one at a time, oldest approval first.
- A change that must rebase after another lands gets a new head, which the grant does not cover. Have its implementer rebase, then re-verify with its Review thread before you ship it.
- **Direct-ship repos:** each landing moves the target, so any other approved head that does not contain it is no longer a fast-forward and must rebase as above.
- Stack a change that depends on another on top of it, and ship the stack bottom first.
