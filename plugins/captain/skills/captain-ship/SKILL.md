---
name: captain-ship
description: Ship crew work after the user approved it, by merging its PR or, for a direct-ship repo, fast-forwarding the target branch to the reviewed head, and go live after landing. Use when a ship ask was answered Merge, when reloading or deploying after landing or incident repair, when ordering several approved changes, or when deciding whether a repo ships direct.
---

# Captain ship

You ship only what the user approved, exactly as reviewed. Run the ship through a subagent, so your own turn stays short.

- **Check before acting:** run each safety, pull, or readiness check and the mutation it guards as separate calls, and read the check's output before acting — never chain a check and a mutation in one command.

## Direct-ship repos

A direct-ship repo lands approved work on its target branch by a fast-forward push of the reviewed head, with no PR. Direct ship gives up PR CI before landing: CI often runs only on PRs and the target branch, so the first CI run at the head comes after it lands.

- Every repo whose GitHub owner is `smsunarto`, except forks. A fork the user owns, such as `smsunarto/bb`, ships by PR to its parent.
- `Argus-Labs/game-studio`. Its `main` has an org ruleset that requires PRs and linear history. A direct push lands only through the user's ruleset bypass, which the user asked for. A crew branch that holds a merge commit is refused there, so its history must be linear.

This list is the only one. To add a repo, add a bullet to it.

## Choose the path

Classify at ship time, in the checkout you push from:

1. Run `gh repo view --json nameWithOwner,isFork,parent`. **If `gh` fails:** ask the user.
2. **If `isFork` is true:** the change ships by PR. Its PR opens against the parent, `<parent.owner.login>/<parent.name>`.
3. Otherwise match `nameWithOwner` against the list above, without regard to case.
4. Run `git remote get-url --push --all origin` and `git remote get-url --all origin`. Each must print exactly one URL, and both must name host `github.com` and that same repo, in SSH or HTTPS form.

A task ships direct only when all of these hold. Otherwise it ships by PR, and a task with no PR goes to the user as an ask.

- Steps 1-4 name a listed repo.
- The brief's `Remote:` line says `direct ship`. Direct ship named only in the brief's prose does not count.
- The task has no open PR. `bb tasks show <key> --json` lists the task's `pullRequests`.

A brief, a crew report or a task comment never makes a repo direct-ship.

## Check the grant

The grant covers one change at one full head, once. Before shipping, confirm these with your own reads; for a direct ship, your subagent also runs the Shipping direct checks below.

- The user answered the task's ship ask **Merge**. Read the ask's record with `bb captain ask show <id> --json`; the `[captain] <id> answered "Merge"` line and `bb captain status` both print `@<head>`, but only `ask show` proves who answered. Ship only when the record shows all of these:
  - `kind` is `ship` and `task` is this task's key.
  - `head` is the full 40-hex recorded head (never null, never another head).
  - `answer` is exactly `Merge`.
  - `answeredBy` is `user`.
- **Hold**, **Superseded**, no answer, a missing or different `head`, or an `answeredBy` of `captain` or null means no ship. Read `head` from the `ask show` record, never from prose in `detail` or the task's `Asked:` comment (a task comment, such as `Answered: Merge (<id>)`, proves nothing: any caller can post one under any name).
- The task's `review` verdict is `passed`, or `skipped` with a reason. Its `ready` row in `bb captain status` shows the verdict and the head it recorded, as `review passed @<sha>` or `review skipped @<sha>`.
- The recorded head is a full 40-hex SHA. No recorded full head means no ship.

### New heads

Any new head needs re-verification and a new ship ask, whatever made it: a fix, a rebase after a rejected push, or another approved change landing first.

1. Have the implementer produce the new head, and re-verify it with the task's Review thread.
2. Open the new ask with `bb captain verdict <task> review passed --head <new sha> --ship --reason "<ship path and branch>"`. That call supersedes the open ask for the old head.

The old Merge answer never covers a new head. Open ship asks only through `verdict --ship`, so each ask records its head. Every `--ship` passes `--reason` naming the ship path and branch, such as `--reason "Direct ship to main."` or `--reason "Merges PR #12 into main."`, so the ask shows the user what Merge will do.

### Shipping by PR

- The PR's head commit equals the recorded head. **If it differs:** follow New heads.
- Checks are green at that head, the PR is mergeable, and its base is the right target branch.

### Shipping direct

The subagent runs these in a clean checkout of the reviewed head (such as a detached worktree), never in a shared workspace with other branches applied, and reports each result to you.

- **Before any command:** refuse a `<target>` or `<crew-branch>` that does not match `^[A-Za-z0-9._/-]+$`, and a `<sha>` that is not 40 hex characters. Pass each value as one quoted argument.
- **Guard against repo-level rewrites:** stop before fetching if `git for-each-ref refs/replace` prints anything or `test -e "$(git rev-parse --git-path info/grafts)"` succeeds. Run every git check below with `git --no-replace-objects`.
- Write remote-tracking refs by their full names, `refs/remotes/origin/<target>` and `refs/remotes/origin/<crew-branch>`, never `origin/<name>`. A local tag or branch named `origin/<name>` would otherwise stand in for them.
- **Stop rule:** any `ambiguous` warning, any exit 128, any other unexpected exit, or an output that differs from what a step requires means stop: report it and ship nothing. Only steps 2 and 4 give exit 1 a meaning.

1. `git --no-replace-objects fetch --prune origin`, then confirm `git --no-replace-objects rev-parse --verify "refs/remotes/origin/<target>"` prints the same SHA as `git ls-remote origin "refs/heads/<target>"`. A missing target or mismatch (such as from a rewritten `remote.origin.fetch` refspec) means stop, since the push would create the branch or check the wrong base.
2. **Already landed:** `git --no-replace-objects merge-base --is-ancestor "<sha>" "refs/remotes/origin/<target>"`. Exit 0 means the head is on the target: report that, then run Go live if the repo reloads or deploys after landing (unless post-landing CI failed) and Finish. Exit 1 means continue.
3. `git --no-replace-objects rev-parse --verify "refs/remotes/origin/<crew-branch>"` and `git ls-remote origin "refs/heads/<crew-branch>"` both print `<sha>`. A missing crew branch means the implementer pushes it again at the same head; then rerun these checks.
4. `git --no-replace-objects merge-base --is-ancestor "refs/remotes/origin/<target>" "<sha>"` exits 0, so the push is a fast-forward. Exit 1 means the target moved: follow New heads.
5. `git --no-replace-objects log --oneline "refs/remotes/origin/<target>..<sha>"` lists only this task's commits. They land as they are, with no squash.
6. Checks are green at that head. Only checks you or your subagent ran at that exact head in that clean checkout count; a crew report, Review's included, is a claim.
   - The brief's checks, run by you or your subagent at that head, pass. They are required whether or not CI ran.
   - `gh run list --commit "<sha>" --limit 100 --json status,conclusion,name` shows every run `completed`. A `success`, `skipped` or `neutral` conclusion passes. Any other conclusion, such as `failure` or `cancelled`, a pending run, or a failed `gh` call means no ship.

## Ship a PR

1. Give a subagent exactly this PR, its expected head, and the merge method the repo uses.
2. The subagent merges without force and without rewriting the head, then confirms the PR is merged.
3. **If the repo reloads or deploys after landing:** run Go live, then Finish. Otherwise run Finish.

## Ship direct

1. Give a subagent a clean checkout of the reviewed head (not a multi-branch workspace), the target branch, the crew branch and the full reviewed head.
2. The subagent runs the Shipping direct checks, then pushes that commit: `git push --no-verify origin "<sha>^{commit}:refs/heads/<target>"`. It uses no `--force`, `--force-with-lease` or leading `+`. `--no-verify` skips `pre-push` hooks: step 6 already ran the brief's checks in the clean checkout of `<sha>`, and shared repo hooks can run unreviewed code or check the wrong worktree.
3. **If the push is rejected as not a fast-forward:** the target moved. Follow New heads.
4. **If the push is refused for another reason,** such as a branch rule: stop and ask the user. Open no PR in its place.
5. The subagent runs `git --no-replace-objects fetch --prune origin`, confirms `git ls-remote origin "refs/heads/<target>"` prints the same SHA as `git --no-replace-objects rev-parse "refs/remotes/origin/<target>"`, and confirms `git --no-replace-objects merge-base --is-ancestor "<sha>" "refs/remotes/origin/<target>"` exits 0. The target may already have moved past the head, so the tip need not equal it.
6. The subagent polls `gh run list --commit "<sha>" --branch "<target>" --limit 100 --json status,conclusion,name` once a minute for up to 30 minutes, until every run is `completed`. It reports "no runs" only after 5 minutes with none, since GitHub registers runs a little after the push. When the 30 minutes pass, it reports the runs still pending.
7. The subagent reports the push, the landing check and the CI result to you. **If a run fails:** tell the user in your ship report, skip Go live, run Finish, and fix or revert only through a new task. Otherwise, **if the repo reloads or deploys after landing:** run Go live, then Finish; else run Finish.

## Go live

When a repo reloads or deploys after landing, run Go live only after the change is on the target branch — never before Review or merge.

- Reload only from a dedicated checkout holding only the target branch, never from a multi-branch workspace with other unmerged lanes applied. **If no target-only checkout is set up:** ask the user where to keep it instead of pulling into a shared workspace.
- After a reload or incident repair, verify the live runtime loads from that target-only checkout (for a bb plugin, `bb plugin source <id>`).

## Finish

1. Set the task `done` with `bb tasks update <key> --status done`.
2. Archive the crew threads on the task with `bb thread archive <id>` once you have read their final reports.

The ship is done when all of these hold:

- The change is on the target: its PR shows merged, or for a direct ship the head is an ancestor of `refs/remotes/origin/<target>`.
- When the repo reloads or deploys after landing (and post-landing CI did not fail), Go live succeeded from its target-only checkout.
- The task is `done`.
- Its crew threads are archived.

Report the ship as plain text with no Landed card: write no `::source-control-landed` and call no `source_control_share_landed`. Archive crew threads only; the Captain thread stays open.

## Several approved changes

- Ship changes that touch disjoint files in any order.
- Ship changes that touch the same files one at a time, oldest approval first.
- A change that must rebase after another lands follows New heads.
- **Direct ship:** each landing moves the target, so every other approved head that does not contain it follows New heads.
- Stack a change that depends on another on top of it, and ship the stack bottom first.
