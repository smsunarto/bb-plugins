---
name: sync
description: Update the working repository onto the latest target branch and resolve every rebase conflict by intent. Use when the user says sync, rebase, update from main, or pull main.
---

# Sync

Bring the repository's applied work onto the latest target branch, then leave every conflict resolved, marker-free, and checked. The user invoked this, so conflicts in every applied branch are yours to resolve, including branches other agents own.

## 1. Pick the mode

Run `but status` in the repository root. Success means GitButler manages this repository: read the `gitbutler` skill (`~/.agents/skills/gitbutler/SKILL.md`) and follow the GitButler branch below. Failure (no `but`, or "not a GitButler project") means plain Git: follow the Git branch.

Done when: one branch is chosen and, for GitButler, the skill is loaded.

## 2a. GitButler

1. `but pull`. Its output reports the fetched target, rebased branches, and every `{conflicted}` commit.
2. For each conflicted branch, oldest commit first: `but resolve conflicts <branch>` lists numbered conflicts with `ours` (new base), `base`, and `theirs` (the commit's own change). Resolve each with the intent rules below and `but resolve apply <path>:<N>` fed by a heredoc. Use `--ours` or `--theirs` only when one side fully supersedes the other. Loop until it reports no conflicts.
3. A wrong resolution is reverted with `but undo`.

Every write goes through `but`. Git write commands (`git rebase`, `git add`, `git checkout --ours`) corrupt the workspace.

Done when: `but status` shows no `{conflicted}` commit and no `(merged upstream)` branch remains applied.

## 2b. Git

1. `git fetch origin`. Target = `origin/<default>` where default comes from `git symbolic-ref refs/remotes/origin/HEAD` (fallback `main`).
2. Uncommitted changes: `git stash push -u -m sync`; pop it after the rebase and treat pop conflicts like rebase conflicts.
3. `git rebase origin/<default>`. On each stop, resolve every conflicted file with the intent rules below, `git add` it, then `git rebase --continue`.
4. `git diff --check` and `grep -rn '<<<<<<<' --exclude-dir=node_modules .` must both be empty before the last `--continue`.

Done when: `git status` reports the branch ahead of the target with a clean tree (plus the popped stash) and no rebase in progress.

## Intent rules for a conflict

Read both sides before writing anything:

- `ours`/upstream: `git log --oneline <base>..origin/<default> -- <file>` explains why upstream changed it.
- `theirs`/local: the conflicted commit's message and diff explain the local change.

Then choose:

- **Independent edits** touching the same lines for different reasons: keep both, in the order the code needs.
- **Same fix on both sides**: keep the upstream version, then re-apply whatever the local change adds beyond it.
- **Upstream renamed or moved** what the local side edited: apply the local edit at the new name or location.
- **Generated files and lockfiles** (`bun.lock`, `package-lock.json`, `*.snap`, `dist/`): take upstream, then regenerate with the repository's own command (`bun install`, the snapshot updater, the build).
- **Contradictory intent** (both sides need opposite behavior): stop, show both diffs and the two commit messages, and ask. Do not guess.

After the last conflict, run the repository's cheapest check that covers the conflicted files (typecheck, or the tests beside them). A red check means the resolution is wrong: fix before reporting.

## Report

State the target commit synced to, each branch rebased, each conflict and the rule that resolved it, and the check that passed. Uncommitted work that was stashed and restored is worth one line.

## Gotchas

- In a GitButler workspace `but pull` IS the rebase. `git pull`, `git rebase`, `but move`, and `but config target` are not substitutes.
- `but pull` refuses when uncommitted changes would conflict. Park them: `but commit -b <branch> -m "wip" <ids>`, pull, then `but uncommit` that commit.
- Commit IDs change after every `but resolve apply`. Address conflicts by branch name, never by a remembered commit ID.
- Finishing a lower conflicted commit rebases the ones above it, which can add or remove conflicts. Always re-list before the next apply.
