---
name: ship-it
description: Ship this session's work. Runs the repository's CI gates locally, commits, then lands on origin/main for a personal GitHub repository or opens a pull request otherwise. Use when the user says ship it, land it, or asks to push and open a PR.
---

# Ship it

Land this session's work once every CI gate is green locally. The whole command is one approval: commit, push, and open or update the pull request without asking again, unless something risky or surprising turns up.

## 1. Pick the mode

Run `but status` in the repository root. Success means GitButler manages this repository: read the `gitbutler` skill (`~/.agents/skills/gitbutler/SKILL.md`) and use `but` for every write below. Failure means plain Git.

Done when: the mode is chosen and, for GitButler, the skill is loaded.

## 2. Find the CI gates

The gates are whatever CI runs, in this order of authority:

1. `.github/workflows/*.y*ml`: every `run:` step of the jobs triggered by `push` or `pull_request`. Map each to its local command (a `package.json` script, `Makefile` or `justfile` target, or the literal command).
2. Pre-push hooks: `lefthook.yml`, `.husky/pre-push`, `.pre-commit-config.yaml`.
3. `AGENTS.md` or `CLAUDE.md` handoff checks.

Skip a gate only when it needs a secret, a service, or a runner this machine lacks, and name the skipped gate in the report.

Done when: every gate has a local command or a named reason to skip.

## 3. Run the gates

Run every gate. Fix a failure only when the fix belongs to this session's change (a missed format, a stale snapshot, a type error in touched code). A failure that lives outside the change stops the ship: report it and end. A gate that passes only after a fix reruns until it passes clean.

Done when: every gate passes in one clean run.

## 4. Commit

Commit only this session's changes. Other agents share the workspace, so changes you did not make stay uncommitted.

- GitButler: `but diff`, then `but commit -b scott/<short-description> -m "<type>(<scope>): <summary>" <id> <id>`. Reuse this session's branch when one exists.
- Git: `git add <paths>` for the touched files, then `git commit -m "<type>(<scope>): <summary>"`. Work on `main` moves to `scott/<short-description>` first (`git switch -c`).

Unrelated changes in one file split by hunk into separate commits.

Done when: `but status` or `git status` shows this session's changes committed and nothing else touched.

## 5. Land or open a pull request

Decide the destination from the `origin` remote owner:

```bash
git remote get-url origin        # github.com[:/]<owner>/<repo>
gh api user --jq .login          # the authenticated GitHub user
```

**Personal repository** (owner equals the login, or is `smsunarto`): land straight on `main`.

- GitButler: `but push <branch>`, then `git push origin <branch>:main`. That last push is the one Git write GitButler has no equivalent for. Follow with `but pull`, which marks the branch merged and removes it from the workspace.
- Git: `git fetch origin && git rebase origin/main`, then `git push origin HEAD:main`.

**Any other repository**: open or update a pull request.

- GitButler: `but pr new <branch> -m $'<title>\n\n<body>'`. It pushes first, so `but push` is redundant. An existing PR for this branch updates with `but push <branch>`.
- Git: `git push -u origin <branch>`, then `gh pr create --title "<title>" --body "<body>"`. An existing PR updates with the push alone.

The title is the commit summary. The body says what changed, why, and any decision worth review, in a few sentences.

Done when: `main` carries the commit, or the PR URL exists.

## Report

One line per gate with its result, the commit summaries, and either the `main` commit or the PR URL. Name every skipped gate and its reason.

## Gotchas

- A non-fast-forward push to `main` means upstream moved: rebase (`but pull` or `git rebase origin/main`), rerun the gates, push again. Never force-push `main`.
- `but pr new` sets stack metadata that `gh pr create` does not. In a GitButler workspace, `gh pr create` is wrong even when it works.
- `but push` on a branch marked `(merged upstream)` refuses. Start the work on a fresh branch instead.
- A repository whose `origin` is a fork of an organization repository is still "any other repository": the PR goes upstream, not to the fork's `main`.
