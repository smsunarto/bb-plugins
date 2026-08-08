# bb-plugin-gh-stack

BB integration for [`gh stack`](https://github.com/github/gh-stack) — stacked
branches and pull requests via the GitHub CLI.

## What it does

- Adds a **Stack** action to the thread right panel. It runs
  `gh stack view --json` in the thread's workspace (resolved through the
  thread's environment), enriches each PR with its title and draft status via
  `gh pr view`, and renders a GitHub-style stack: PR titles with
  `#N · branch` sublines, commit-rail connectors down to a trunk chip, a
  highlighted current row, `needs rebase` warnings, and status pills
  (Draft / Open / Closed / Queued). Merged layers disappear. If the merged
  layer is checked out, the plugin checks out the nearest remaining layer
  above it, or the stack's trunk when none remains above. A running thread or
  dirty worktree defers that checkout without showing the merged layer. For
  open PRs the pill is a toggle — click to flip draft ⇄ ready for review
  (`gh pr ready [--undo]`).
- Every row carries a **`N files +A −D`** chip that expands into the
  **changed-file tree** for that layer (Pierre Trees, as in the PR
  walkthrough viewer), with per-file and aggregated per-directory deltas and
  git status colors. A branch's diff is computed against its stack parent
  (`git diff <parent>...<branch>`), so each layer shows only what it adds.
- The top row of the rail is the **next layer**: a name field whose subline
  reads like every other row — `#4 · scott/add-metrics-rate-limiter`, then
  the uncommitted files that `gh stack add` will carry onto it. The number is
  one past the highest issue or PR in the repository (a guess), the prefix is
  the namespace the stack's branches already share, and the subline falls
  back to `working tree` until a name is typed. Untracked files are counted
  with `wc -l`; binary files show no delta.
- **Sync** and **Submit** buttons run `gh stack sync` and
  `gh stack submit --auto` directly in the workspace, with toasts and a
  diagnostics tail whenever the command emits output. Exit status alone is
  not treated as success: divergence, best-effort push/PR warnings, branches
  that do not match their upstream refs, and missing PRs are detected and
  surfaced.
- **Layer composer**: that same row takes a PR-title-like layer name ("Add
  rate limiting to the API") and derives the branch from it (stopwords
  dropped, prefix applied, live preview). With no stack it runs
  `gh stack init <branch>`; on an existing stack it runs `gh stack top`
  followed by `gh stack add <branch>`, so more PRs can be stacked on top
  without leaving the panel. **Suggest** asks the thread's own agent harness
  for a title: it spawns a hidden helper thread in the same environment and
  provider, has it inspect the workspace changes, sanitizes its reply, and
  deletes the helper. Falls back to the thread title, then a humanized
  environment branch name, on timeout or failure.
- **Magic Stack 🪄**, beside the composer's own button: sends a prompt to the
  thread's own agent (whatever harness the session uses) to analyze the
  workspace, design layers, and submit draft PRs — automatic splitting, where
  the composer takes one layer at a time. The prompt adapts to the workspace:
  `gh stack init` when there is no stack, `gh stack top` + `add` on top of an
  existing one.
- **Ask agent to sync** drops the instruction into the thread composer for
  cases better handled by the agent (which has the `gh-stack` skill), e.g.
  conflicts.
- **Settings popup** (the gear beside Refresh) holds the two naming
  conventions the panel follows, global to the plugin rather than per
  repository:
  - **Branch prefix** — the namespace every derived branch gets. Empty means
    "detect it", the behavior before the setting existed: the namespace the
    stack's own branches share, else the checked-out branch's. A missing
    trailing separator is added (`scott` → `scott/`), and a value that
    cannot form a branch according to `git check-ref-format --branch` is
    rejected.
  - **Conventional Commits** — layer names read `feat: add rate limiting`
    and the type leads the branch slug (`scott/feat-add-rate-limiting`).
    Suggest asks the agent for a Conventional Commits title, and Magic Stack
    tells it to write commits, PR titles, and branch names the same way.
    Off, a name slugifies whole, as before.

  Both are stored in the plugin's kv (one global row) and travel on the
  `getStack` payload, so the popup opens without a second round trip and a
  save patches the cached payloads in place instead of re-running `gh`. The
  popup shows a live example of the branch the composer would build.
- Maps `gh stack` exit codes to actionable messages: not a stack, rebase
  conflict, GitHub API failure, stack file locked, stacked PRs unavailable,
  gh missing, timeout. Exit code 2 becomes “not a stack” only when the command
  explicitly reports that the current branch is not part of one.
- **Serialized workspace mutations**: Sync, Submit, Init, Add, and PR readiness
  changes, plus automatic checkout after a merge, share a server-side lock
  keyed by the repository's canonical Git common directory. A second
  operation is rejected while one is active. Add records the original
  checkout, verifies the requested branch became the checked-out top layer,
  and restores the original branch after a clean failure; possible partial
  mutations are reported instead of rolled back destructively.
- **Cached, self-refreshing panel**: the server keeps a per-thread cache of
  the computed stack, so opening the panel paints instantly
  (stale-while-revalidate — reads older than 10s trigger a background
  recompute). Every fresh compute is announced on a realtime channel and open
  panels silently refetch, so the rail updates on its own: panels poll the
  cache every 30s, the thread's agent going idle triggers a refresh for
  watched threads (read within the last 90s), and actions (Sync / Submit /
  create / draft toggle) force a fresh compute. The Refresh button also
  forces one; hover it for the last-updated time. Realtime reconnects
  reconcile missed signals; deleted threads evict their cache entry. A
  mutation invalidates every cached thread that resolves to the same Git
  common directory, so sibling threads sharing an environment cannot keep
  stale stack state.

## Requirements

- `gh` and the `gh-stack` extension on the BB **server** host:
  `gh extension install github/gh-stack`.
- The thread's workspace must exist on the server host (remote environments
  show an explanatory error).

## Install

From the repository root:

```
bun install
bb plugin install plugins/gh-stack
```

After editing sources, use `bb plugin dev plugins/gh-stack` for the watch loop,
or run `bun run --filter './plugins/gh-stack' build` and
`bb plugin reload gh-stack`.

## Layout

- `server.ts` — RPCs: `getStack` (thread → environment path →
  `gh stack view --json`, lenient zod parse, per-branch and working-tree
  diffs; served from the per-thread cache with background revalidation and
  `stack-updated` realtime announcements), `runAction` (sync / submit),
  `createStack` (init), `addBranch` (top + add), `setPrDraft`,
  `suggestStackName`, `magicStack`, `saveSettings` (normalize the prefix,
  write the kv row, patch cached payloads). Shared workspace resolution,
  exit-code mapping, and the settings-aware branch derivation the composer
  mirrors.
- `lib/git-diff.ts` — pure parsers for git's NUL-delimited `--numstat`,
  `--name-status`, and `status --porcelain=v1` output, plus change-set
  aggregation.
- `lib/branch-name.ts`, `lib/gh-stack-output.ts`, `lib/stack-layers.ts`,
  `lib/workspace-key.ts` — shared branch derivation, prefix normalization,
  classification of gh-stack's best-effort output, merged-layer projection
  and checkout planning, and canonical repository identity.
- `app.tsx` — `threadPanelAction` panel rendering the rail, plus the gear
  settings popup (responsive dialog / drawer); it imports the shared branch
  derivation for the live preview.
- `components/stack/changed-file-tree.tsx` — Pierre Trees file tree with
  `+A −D` row decorations; `app.css` themes it against the host tokens.
- `components/ui/`, `types/` — vendored shadcn components and the bundled
  plugin SDK types (scaffold defaults).
- `test/` — Node tests for branch/ref policy, gh-stack output classification,
  merged-layer projection, and Git's NUL-delimited diff formats.
