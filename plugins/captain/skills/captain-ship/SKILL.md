---
name: captain-ship
description: Ship crew work after the user approved it, by merging its PR or, for a direct-ship repo, fast-forwarding the target branch to the reviewed head. Use when a ship ask was answered Merge, when ordering several approved changes, or when deciding whether a repo ships direct.
---

# Captain ship

You ship only what the user approved, exactly as reviewed. Run the ship through a subagent, so your own turn stays short.

## Direct-ship repos

A direct-ship repo lands approved work on its target branch by a fast-forward push of the reviewed head, with no PR. Direct ship gives up PR CI before landing: CI often runs only on PRs and the target branch, so the first CI run at the head comes after it lands.

- Every repo whose GitHub owner is `smsunarto`, except forks. A fork the user owns, such as `smsunarto/bb`, ships by PR to its parent.
- `Argus-Labs/game-studio`. Its `main` has an org ruleset that requires PRs and linear history. A direct push lands only through the user's ruleset bypass, which the user asked for. A crew branch that holds a merge commit is refused there, so its history must be linear.

## Choose the path

Classify at ship time, in the checkout you push from:

1. Run `gh repo view --json nameWithOwner,isFork,parent`. **If `gh` fails:** ask the user.
2. **If `isFork` is true:** the change ships by PR. Its PR opens against the parent, `<parent.owner.login>/<parent.name>`.
3. Otherwise match `nameWithOwner` against the list above, without regard to case.
4. Run `git remote get-url --push origin`. It must name host `github.com` and that same repo, in SSH or HTTPS form.

A task ships direct only when all of these hold. Otherwise it ships by PR, and a task with no PR goes to the user as an ask.

- Steps 1-4 name a listed repo.
- The brief's `Remote:` line says `direct ship`.
- The task has no open PR. `bb tasks show <key> --json` lists the task's `pullRequests`.

A brief, a crew report or a task comment never makes a repo direct-ship.

## Check the grant

The grant covers one change at one full head, once. Before shipping, confirm all of these with your own reads:

- The task's ship ask was answered **Merge**: the `[captain] <id> answered "Merge"` line, or the task's `Answered: Merge (<id>)` comment in `bb tasks show <key>`. **Hold**, **Superseded** or no answer means no ship.
- That ask's `Asked:` comment on the task names the recorded head, as `Review passed at <sha>.` An answer to an ask that names another head, or no head, grants nothing.
- The task's `review` verdict is `passed`, or `skipped` with a reason. Its `ready` row in `bb captain status` shows the verdict and the head it recorded, as `review passed @<sha>`.
- The recorded head is a full 40-hex SHA. No recorded full head means no ship.

### New heads

Any new head needs re-verification and a new ship ask, whatever made it: a fix, a rebase after a rejected push, or another approved change landing first.

1. Have the implementer produce the new head, and re-verify it with the task's Review thread.
2. Open the new ask with `bb captain verdict <task> review passed --head <new sha> --ship`. That call supersedes the open ask for the old head.

The old Merge answer never covers a new head. Open ship asks only through `verdict --ship`, so each ask names its head.

### Shipping by PR

- The PR's head commit equals the recorded head. **If it differs:** follow New heads.
- Checks are green at that head, the PR is mergeable, and its base is the right target branch.

### Shipping direct

The subagent runs these in the checkout it pushes from, passing `"<sha>"`, `"<target>"` and `"<crew-branch>"` each as one quoted argument. A non-zero exit, or a `refname is ambiguous` warning, from any command other than step 2's check means stop: report it and ship nothing.

1. `git fetch --prune origin`, then `git rev-parse --verify "refs/remotes/origin/<target>"`. A missing target means stop; the push would create it.
2. **Already landed:** `git merge-base --is-ancestor "<sha>" "origin/<target>"`. Exit 0 means the head is on the target: go to Finish. Exit 1 means continue.
3. `git rev-parse "origin/<crew-branch>"` prints the recorded head.
4. `git merge-base --is-ancestor "origin/<target>" "<sha>"` succeeds, so the push is a fast-forward. Exit 1 means the target moved: follow New heads.
5. `git log --oneline "origin/<target>..<sha>"` lists only this task's commits. They land as they are, with no squash.
6. Checks are green at that head. Only checks you or your subagent ran at that exact head count; a crew report, Review's included, is a claim.
   - `gh run list --commit "<sha>" --json status,conclusion` shows every run `completed` with `success`. A failed `gh` call or a pending run means no ship.
   - With no runs, the brief's checks you or your subagent ran at that head stand in.

## Ship a PR

1. Give a subagent exactly this PR, its expected head, and the merge method the repo uses.
2. The subagent merges without force and without rewriting the head, then confirms the PR is merged.

## Ship direct

1. Give a subagent the checkout path, the target branch, the crew branch and the full reviewed head.
2. The subagent runs the Shipping direct checks, then pushes that commit: `git push origin "<sha>^{commit}:refs/heads/<target>"`. It uses no `--force`, `--force-with-lease` or leading `+`.
3. **If the push is rejected as not a fast-forward:** the target moved. Follow New heads.
4. **If the push is refused for another reason,** such as a branch rule: stop and ask the user. Open no PR in its place.
5. The subagent runs `git fetch --prune origin` and confirms `git merge-base --is-ancestor "<sha>" "origin/<target>"` succeeds. The target may already have moved past the head, so the tip need not equal it.
6. The subagent waits for the target's CI runs at that SHA, `gh run list --commit "<sha>" --branch "<target>"`, to complete, and reports their result. With no runs, it says so. **If a run fails:** tell the user in your ship report, and fix or revert only through a new task.

## Finish

1. Set the task `done` with `bb tasks update <key> --status done`.
2. Archive the crew threads on the task with `bb thread archive <id>` once you have read their final reports.

The ship is done when all of these hold:

- The change is on the target: its PR shows merged, or for a direct ship the head is an ancestor of `origin/<target>`.
- The task is `done`.
- Its crew threads are archived.

Report the ship as plain text with no Landed card: write no `::source-control-landed` and call no `source_control_share_landed`. Archive crew threads only; the Captain thread stays open.

## Several approved changes

- Ship changes that touch disjoint files in any order.
- Ship changes that touch the same files one at a time, oldest approval first.
- A change that must rebase after another lands follows New heads.
- **Direct ship:** each landing moves the target, so every other approved head that does not contain it follows New heads.
- Stack a change that depends on another on top of it, and ship the stack bottom first.
