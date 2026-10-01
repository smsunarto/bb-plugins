# GitButler

A view of a thread's [GitButler](https://gitbutler.com) workspace in
bb's right panel: applied stacks, the branches in them, their commits, the
uncommitted work, and the target history below the common base.

Plain `git log` is misleading inside a GitButler project — it shows the
`gitbutler/workspace` merge commit and every branch at once, which is not the
model you work in. This panel reads `but --json` instead, so what it shows is
what `but status` shows.

## What it shows

- Applied stacks, in workspace order, with each stack's branches
- Per-branch push status, review id, and CI state
- Commits on each branch, with conflicted commits marked
- Upstream commits a branch has not integrated yet
- Uncommitted changes, and changes assigned to a specific stack
- The common base, and the target-branch history continuing below it
- Per-file diffs rendered by bb's own diff viewer

## Thread header and tab

- In a GitButler workspace, the thread header has a **View in GitButler**
  button that opens the GitButler tab.
- The first time a thread runs in a GitButler workspace, the GitButler tab is
  added to its side panel without taking focus. A closed tab stays closed.

## Branch actions

Each branch card can change the repository:

- **Rename:** click the branch name (`but reword <branch> -m <name>`).
- **Push**, or **Force push** after commits were rewritten (`but push`).
- **Create PR** spawns a subthread of the current thread. Its agent reads the
  branch, writes the title and description, and runs `but pr new`. While it
  works, the card links to it instead of offering a second one. It needs a
  forge authenticated with `but config forge auth`.
- **Land** onto the target without a PR, after a confirmation (`but land`).
  Only the bottom branch of a stack can land.

The panel never commits, amends, applies, unapplies, or restores from the
oplog.

## Requirements

- The GitButler CLI (`but`) installed on the machine hosting the thread's
  environment. The panel looks on `PATH` and in `/opt/homebrew/bin`,
  `/usr/local/bin`, `~/.local/bin`, and `~/.cargo/bin`.
- The repository set up as a GitButler project (`but setup`). The panel says so
  and names the command when it is not.

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
