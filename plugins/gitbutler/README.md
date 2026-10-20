# GitButler

A view of a thread's [GitButler](https://gitbutler.com) workspace in
bb's right panel: applied stacks, the branches in them, their commits, the
uncommitted work, and the target history below the common base.

Plain `git log` is misleading inside a GitButler project — it shows the
`gitbutler/workspace` merge commit and every branch at once, which is not the
model you work in. This panel reads `but --json` for GitButler workspaces.
Ordinary checkouts use Git directly to show their checked-out branch, changes,
and history.

## What it shows

- Applied stacks, in workspace order, with each stack's branches
- Per-branch push status: **Ahead** when local commits wait for a plain
  push, **Behind** when only the remote has new commits, **Diverged** when
  both sides moved or a force push is needed. GitButler calls a branch that
  is only behind "requiring force", so the panel asks git which it is.
- Each branch's PR, as a chip that opens it on the forge, and a chip for its
  checks: passed, failed, or running
- Commits on each branch, with conflicted commits marked
- Upstream commits a branch has not integrated yet
- Uncommitted changes, changes assigned to a specific stack, and files left
  with conflict markers
- How far the workspace is behind its target branch
- The common base, and the target-branch history continuing below it
- Per-file diffs rendered by bb's own diff viewer, for any commit, the target
  history included. The diff screen opens over the workspace, and Back or
  Escape returns to the same scroll position
- The same repository's branches in other checkouts, with their machine and
  path. See [Other machines](#other-machines)
- Branches GitButler knows that the workspace does not apply, under
  **Not applied**, closed until opened
- GitButler's operation history (`but oplog`), from the header's
  **Operation history** button
- The last board it read, at once when the panel opens again, while it reads
  the workspace behind it. Writes wait until that read lands

## Thread header and tab

- In a GitButler workspace, the thread header has a **View in GitButler**
  button that opens the GitButler tab.
- The first time a thread runs in a GitButler workspace, the GitButler tab is
  added to its side panel without taking focus. A closed tab stays closed.

## Branch actions

The commands below describe GitButler workspaces. Ordinary Git checkouts expose
the same controls through checkout-scoped Git operations; see [Other machines](#other-machines).

The header's **Pull** fetches, then rebases every applied branch onto the
target branch (`but pull`). It asks first when that would leave conflicted
commits or write conflict markers into uncommitted files, and says so when
there was nothing new.

Each branch card can change the repository:

- **Rename:** click the branch name (`but reword <branch> -m <name>`).
- **Pull** when the branch's remote has commits it lacks
  (`but branch update <branch>`). That command does not fetch, so the panel
  fetches first, then reads the dry run before changing anything. It asks
  before leaving conflicts or touching files with uncommitted changes, and
  asks again if a retry finds more. It refuses when GitButler would move
  another branch's commits into this one, which `but` 0.22.3 does to the
  lower branch of some stacks.
- **Push**, or **Force push** after commits were rewritten (`but push`). A
  push that would delete new upstream commits, on the branch or one below it
  in its stack, asks first. It fetches before it pushes, and stops if the
  remote then holds any commit the reader was not asked about. Old copies of
  commits that were since rebased don't count. A conflicted commit, on the
  branch or one below it that the push takes along, hides Push, Create PR,
  and Land: `but push` refuses it.
- **Create PR** spawns a subthread of the current thread. Its agent reads the
  branch, writes the title and description, and runs `but pr new`. While it
  works, the card links to it instead of offering a second one. It needs a
  forge authenticated with `but config forge auth`.
- **Land** onto the target without a PR, after a confirmation (`but land`).
  It pushes the target to the remote and can't easily be undone. Only the
  bottom branch of a stack can land. A branch of several commits is squashed
  into one first (`but squash <branch>`), under a message the confirmation
  prefills and lets you edit: the oldest commit's subject, then the later
  ones as a list. A branch behind the target, which `but land` would merge
  instead, is brought up to it first with `but pull`, which rebases every
  applied branch. The confirmation says so when the panel knows the target
  moved, and asks again before a pull that leaves conflicts or touches
  uncommitted files, as the header's Pull does. It refuses when the branch
  itself would conflict, and stops after the pull when the pull took commits
  the target already has out of the branch, so the message is written for
  what is left. A squash or a pull rewrites the branch's commits, so its PR
  stays open. Nothing that ran is undone when a later step fails, and the
  error says what ran: the pull, the squash, or both.
- **Delete**, after a confirmation that says what is lost
  (`but branch delete <branch>`). The local branch and its commits leave the
  workspace. The remote branch and any PR stay. Branches stacked above it
  move down onto the base. Unpushed commits survive only in GitButler's undo
  history. It asks once more when uncommitted changes sit in files the branch
  changed, because deleting it can write conflict markers into them.

`but` also reads a short argument as a CLI id, and `refs/heads/x` as the
branch `x`. Before each write, the panel checks that the branch is still in
the workspace and that its name is neither another item's id nor a name that
starts with `refs/`.

The panel never commits, amends, applies, unapplies, or restores from the
oplog. Its **Ask agent** buttons quote the request into the thread's composer
instead, for the agent to run.

## Conflicts

When a branch holds conflicted commits, or uncommitted files hold conflict
markers, a **Conflicts to resolve** section at the top of the panel names
them. Its **Resolve conflicts** button spawns a subthread of the current
thread, on the same workspace, that resolves every one of them: the files
first with `but resolve <path>`, then the commits with `but resolve apply`,
the lowest branch of each stack first. It does not push, land, or commit.

It stays out of resolution mode, which would swap the working tree out from
under the thread. GitButler resolves some conflicts only in that mode: a
deletion, a rename, or a binary or oversized file. The subthread lists those
and asks before it enters the mode.

There is one such subthread per repository, not per branch or per thread:
resolving a lower commit rebases every commit above it. While it works, the
section links to it, in every thread on that workspace. Once it stops, which
may mean it is waiting for an answer, **Continue resolving** sends it the job
again instead of starting a second one. Archive it to start fresh.

## Other machines

Below the board, other checkouts of this repository get cards showing their
machine, path, branches, and newest commit. **Open checkout** opens that checkout
in the full board, including diffs, Rename, Pull, Push, Create PR, Land, and Delete.
**Back to main checkout** returns to the thread's workspace.

**New chat** opens BB's native New thread screen with that checkout already
selected. It is available on each checkout card and above an opened checkout.
Choose your agent and write the first message there. The checkout must have a
ready BB environment with an unarchived visible thread; for discovered Git
worktrees without one, the click says why chat cannot start there yet.

Ordinary Git checkouts need no GitButler setup. Their header's Pull updates the
checked-out branch from its target; the branch's Pull integrates its upstream.
Land publishes one commit on the target and requires a clean checkout. Delete
detaches the checkout at its current commit before removing the local branch,
preserving its files. PR and conflict subthreads run in the selected checkout.

Writes recheck the checkout and refuse stale branch snapshots, branches tracked
by a shared GitButler workspace, and checkouts another BB thread is actively
using. Linked checkouts share a host-side write queue because they share Git refs.
Native writes also refuse custom GitButler metadata storage that the panel cannot
inspect safely.

The panel finds them through bb: every project source and ready environment on
each connected machine, plus the linked worktrees Git registers for those
repositories. This includes worktrees that have no separate BB environment.
A checkout counts when its `origin` is this one's, in any spelling (SSH or HTTPS).
Detached worktrees and repositories without an `origin` are omitted.
An offline machine is left out until it reconnects. The cards refresh every two
minutes, after a write to one of them, and on the header's **Refresh**.

## For other plugins

Two RPCs serve other plugins through `bb.sdk.plugins.callRpc`; the board does
not use them. [Code Review](../code-review) reads them for its **Unpublished**
inbox.

- `unpublishedBranches`: every branch with commits, no PR, and not yet
  integrated, in every GitButler workspace bb knows on every connected
  machine. Each has its machine, checkout path, origin, push status, `base`
  and `head` commits (`base..head` is the branch alone, without the branch
  it is stacked on), parent branch, and commits.
- `branchPatches`: `{ hostId, path, base, head }` to that range's per-file
  git patches, read on the branch's machine.

## Requirements

- Git installed on each checkout's host.
- For GitButler workspaces, the GitButler CLI (`but`) installed on that host.
  The panel looks on `PATH` and in `/opt/homebrew/bin`,
  `/usr/local/bin`, `~/.local/bin`, and `~/.cargo/bin`.
- Ordinary checkouts work without `but setup`; linked worktrees are never
  converted into GitButler workspaces by the panel.
- Create PR in ordinary checkouts requires an authenticated forge CLI on that host.

## Repository selection

The panel uses the thread environment's root when that root is itself a Git
worktree. Otherwise it looks at the immediate children of `repos/`. Discovery
is not recursive. With more than one repository, a picker appears in the
header and the choice is remembered per thread.

## Development

```sh
bun install
bun run --filter '@smsunarto/bb-plugin-gitbutler' test
bun run --filter '@smsunarto/bb-plugin-gitbutler' typecheck
bun run --filter '@smsunarto/bb-plugin-gitbutler' build
```

The host entry runs `but` and `git` on the thread environment's bb host, so
local worktrees and repositories on connected machines behave the same way.

## License

[MIT](LICENSE)
