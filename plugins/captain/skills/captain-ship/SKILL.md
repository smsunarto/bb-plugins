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

Classify at ship time, outside any crew checkout (so a mistaken bare `gh` call has no remotes to resolve from):

1. Read `Repo: <owner>/<repo>` from the Captain's Drive file `repos/<KEY>.md`, where `<KEY>` is the task's Tasks project. **If that line is missing:** stop and add it to `repos/<KEY>.md` before shipping. Never fall back to git config, the brief, or `gh repo view` with no repository argument.
2. Run `gh repo view <owner>/<repo> --json nameWithOwner,isFork,parent`. **If `gh` fails:** ask the user.
3. **If `isFork` is true:** the change ships by PR. Its PR opens against the parent, `<parent.owner.login>/<parent.name>`.
4. Otherwise match `nameWithOwner` against the list above, without regard to case, and pass `nameWithOwner` explicitly to `<skill-dir>/scripts/direct-ship.mjs` and to every `gh run list -R <owner>/<repo>` call. The script builds `https://github.com/<owner>/<repo>.git` (or SSH with `--ssh`) from that argument; never read a URL from any checkout's git config.

A task ships direct only when all of these hold. Otherwise it ships by PR, and a task with no PR goes to the user as an ask.

- Steps 1-4 name a listed repo via `repos/<KEY>.md` and `gh repo view`.
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

The subagent runs the direct-ship git sequence through `<skill-dir>/scripts/direct-ship.mjs` in a new empty temp directory `<workdir>` (under `$BB_THREAD_STORAGE` or `$TMPDIR`) and reports each result to you. The script manages two fresh clones of the URL built from `<owner>/<repo>`:

- `<workdir>/bare.git`: a bare blobless clone (`--bare --filter=blob:none`, never `--mirror`) used for refs, ancestry, the commit list, the push, and post-push confirmation.
- `<workdir>/checks`: a second fresh clone with its own `.git` directory (never `worktree add`), checked out detached at `<sha>^{commit}`, used for running the brief's checks.

- **Inputs and script guards:** `<skill-dir>/scripts/direct-ship.mjs` refuses `<target>` or `<crew-branch>` outside `^[A-Za-z0-9._/-]+$` and `<sha>` outside lowercase 40-hex. Every git call the script makes runs with `--no-replace-objects -c core.hooksPath=/dev/null` (plus `-c core.fsmonitor=false` for the checks clone), verifies that both `remote get-url --all origin` and `remote get-url --push --all origin` print exactly the URL built from `<owner>/<repo>` in both clones (catching URL rewrites as git resolves them), and matches `git ls-remote origin "refs/heads/<name>"` by exact second field (requiring one line).
- **Stop rule:** any `ambiguous` warning, any `matches more than one` failure, any exit 128, any other unexpected exit, or an output that differs from what a step requires means run `cleanup`, report it, and ship nothing. Only `verify` exit codes `2` (crew branch missing) and `3` (not fast-forward) and `push` exit code `3` (not fast-forward) carry specific recovery steps.
- **Cleanup on every exit path:** run `<skill-dir>/scripts/direct-ship.mjs cleanup --dir "<workdir>"` whenever the run ends — on stop, already landed, crew branch missing, New heads, rejected or refused push, and after `confirm`.
- **Trust boundary:** fresh clones and `repos/<KEY>.md` remove repo-local state — replace refs, grafts, shallow, refspecs, local hooks, and `includeIf` config scoped to the worktree — and defend against crew git config. They do not remove `~/.gitconfig`, credentials, or files that crew running as the same OS user can reach directly.

1. `<skill-dir>/scripts/direct-ship.mjs clone --repo "<owner>/<repo>" --dir "<workdir>"` (add `--ssh` for SSH).
2. `<skill-dir>/scripts/direct-ship.mjs verify --repo "<owner>/<repo>" --dir "<workdir>" --target "<target>" --branch "<crew-branch>" --sha "<sha>"` (checks target ref against exact `ls-remote`, already-landed, crew branch against exact `ls-remote`, fast-forward, commit list, and prepares `<workdir>/checks` at `<sha>`).
   - **`status: already-landed`:** run `cleanup`, report it, then run Go live if the repo reloads or deploys after landing (unless post-landing CI failed) and Finish.
   - **`status: crew-branch-missing` (exit 2):** run `cleanup`, have the implementer push `<crew-branch>` again at the same head, then re-clone from scratch and rerun checks 1-4.
   - **`status: not-fast-forward` (exit 3):** run `cleanup` and follow New heads.
   - **Any other non-zero exit:** run `cleanup`, stop, and ship nothing.
3. Read the commit list `verify` printed: confirm it holds only this task's commits. They land as they are, with no squash.
4. Checks are green at `<sha>`. Only checks you or your subagent ran in `<workdir>/checks` count; a crew report, Review's included, is a claim.
   - Run the brief's checks in `<workdir>/checks`. They are required whether or not CI ran.
   - Run `gh run list -R "<owner>/<repo>" --commit "<sha>" --limit 100 --json status,conclusion,name` outside any crew checkout: every run must be `completed` with conclusion `success`, `skipped`, or `neutral`. Any other conclusion, such as `failure` or `cancelled`, a pending run, or a failed `gh` call means run `cleanup` and ship nothing.

## Ship a PR

1. Give a subagent exactly this PR, its expected head, and the merge method the repo uses.
2. The subagent merges without force and without rewriting the head, then confirms the PR is merged.
3. **If the repo reloads or deploys after landing:** run Go live, then Finish. Otherwise run Finish.

## Ship direct

1. Give a subagent the verified `<owner>/<repo>` (from `gh repo view`'s `nameWithOwner`), the target branch, the crew branch, and the full reviewed head.
2. The subagent runs the Shipping direct checks (`clone`, `verify`, reads the commit list, runs the brief's checks in `<workdir>/checks`, and reads `gh run list -R`), then pushes as a separate call: `<skill-dir>/scripts/direct-ship.mjs push --repo "<owner>/<repo>" --dir "<workdir>" --target "<target>" --sha "<sha>"`. The script uses no `--force`, `--force-with-lease`, or leading `+`, and pushes `<sha>^{commit}:refs/heads/<target>` so `^{commit}` resolves `<sha>` as an object rather than a ref name even if origin holds a branch named `<sha>`. Because the script sets `core.hooksPath=/dev/null` on its git calls, none of the git calls the skill makes run client-side hooks (including `pre-push`); Shipping direct check 4 already ran the brief's checks in `<workdir>/checks`.
3. **If `push` reports `status: not-fast-forward` (exit 3):** run `cleanup`; the target moved — follow New heads.
4. **If `push` fails for another reason,** such as a branch rule or an `ambiguous` / `matches more than one` error: run `cleanup`, stop, and ask the user. Open no PR in its place.
5. Run `<skill-dir>/scripts/direct-ship.mjs confirm --repo "<owner>/<repo>" --dir "<workdir>" --target "<target>" --sha "<sha>"` (fetches `+refs/heads/<target>:refs/heads/<target>` into `bare.git`, verifies exact `ls-remote` match, and confirms `<sha>` is an ancestor of `refs/heads/<target>`), then run `<skill-dir>/scripts/direct-ship.mjs cleanup --dir "<workdir>"`. The target may already have moved past the head, so the tip need not equal it.
6. Poll `gh run list -R "<owner>/<repo>" --commit "<sha>" --branch "<target>" --limit 100 --json status,conclusion,name` outside any crew checkout once a minute for up to 30 minutes, until every run is `completed`. Report "no runs" only after 5 minutes with none, since GitHub registers runs a little after the push. When the 30 minutes pass, report the runs still pending.
7. The subagent reports the push, the `confirm` landing check, and the CI result to you. **If a run fails:** tell the user in your ship report, skip Go live, run Finish, and fix or revert only through a new task. Otherwise, **if the repo reloads or deploys after landing:** run Go live, then Finish; else run Finish.

## Go live

When a repo reloads or deploys after landing, run Go live only after the change is on the target branch — never before Review or merge.

- Reload only from a dedicated checkout holding only the target branch, never from a multi-branch workspace with other unmerged lanes applied. **If no target-only checkout is set up:** ask the user where to keep it instead of pulling into a shared workspace.
- After a reload or incident repair, verify the live runtime loads from that target-only checkout (for a bb plugin, `bb plugin source <id>`).

## Finish

1. Set the task `done` with `bb tasks update <key> --status done`.
2. Archive the crew threads on the task with `bb thread archive <id>` once you have read their final reports.

The ship is done when all of these hold:

- The change is on the target: its PR shows merged, or for a direct ship the post-push `confirm` check (Ship direct step 5) confirmed the head is an ancestor of `refs/heads/<target>`.
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
