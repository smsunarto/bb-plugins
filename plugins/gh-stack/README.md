# bb-plugin-gh-stack

BB integration for [`gh stack`](https://github.com/github/gh-stack) — stacked
branches and pull requests via the GitHub CLI.

## What it does

- Adds a **Stack** action to the thread right panel. It runs
  `gh stack view --json` in the thread's workspace (resolved through the
  thread's environment), enriches each PR with its title and draft status via
  `gh pr view`, and renders a GitHub-style stack: PR titles with
  `#N · branch` sublines (branch names ellipsized past 25 characters — hover
  for the full name), commit-rail connectors down to a trunk chip, a
  highlighted current row, `needs rebase` warnings, and status pills
  (Draft / Open / Merged / Queued). For open PRs the pill is a toggle —
  click to flip draft ⇄ ready for review (`gh pr ready [--undo]`). The flip
  is **optimistic and reconciled**: the pill switches on the click, the write
  runs behind it, and a failure is the only thing that puts it back (with the
  reason). A spinner sits beside the label — never in place of it — for as
  long as GitHub has not confirmed the new state. `gh pr ready` returns before
  GitHub's read path reflects it, so
  both halves of the panel carry an overlay over what `gh pr view` reports —
  the client's covers the round trip, the server's covers every payload it
  serves (announced immediately, so other open panels flip too) until a
  compute comes back agreeing, which retires it. The cache itself always
  holds what GitHub said; nothing waits on a refresh, and nothing flickers
  back through Draft on the way to Open. Success is silent — the pill is the
  feedback. Clicking a row checks that branch out in the thread's
  workspace — a smart checkout: non-conflicting local changes ride along as
  with plain git; changes git refuses to carry are auto-stashed, tagged with
  the branch they belong to, and restored automatically the next time that
  branch is checked out from the panel (a conflicting restore keeps the
  stash entry and says so). Hand-made stashes are never touched, untracked
  files are never stashed, and the current branch's row is inert. On rows
  with a PR, cmd/middle-click opens github.com in a real browser tab.
- Every row carries a **`N files +A −D`** chip that expands into the
  **changed-file tree** for that layer (Pierre Trees, as in the PR
  walkthrough viewer), with per-file and aggregated per-directory deltas and
  git status colors. A branch's diff is computed against its stack parent
  (`git diff <parent>...<branch>`), so each layer shows only what it adds.
- The top row of the rail is the **next layer**: a name field whose subline
  reads like every other row — `#4 · bb/feat-api-add-metrics-rate-limiter`, then
  the uncommitted files that `gh stack add` will carry onto it. The number is
  one past the highest issue or PR in the repository (a guess), the prefix is
  the configured namespace (`bb/`) or the one the stack's branches already
  share, and the subline falls
  back to `working tree` until a name is typed. Untracked files are counted
  with `wc -l`; binary files show no delta.
- **Sync** and **Submit** buttons run `gh stack sync` and
  `gh stack submit --auto` directly in the workspace, with toasts and a
  diagnostics tail on failure. Each button's tooltip states what the click
  would do right now — "trunk moved (+3) · 2 branches to restack" on Sync,
  "opens 2 PRs, updates 1" on Submit. Sync and Submit each disable
  themselves only when the panel affirmatively knows the click would change
  nothing; failed remote probes keep both armed (Sync's tooltip then reads
  "remote state unknown"). When the
  stack needs a restack, Submit reads
  **Sync + Submit** and runs `gh stack sync` first, so branches are never
  pushed only to be rebased right after. A sync that fails non-trivially — a
  rebase conflict, or local/remote divergence ("Sync aborted") — is handed to
  the thread's agent automatically (it has the `gh-stack` skill); trivial
  failures surface as errors. Branch rows carry "needs rebase" and
  "N unpushed" badges (unpushed counts come from `git rev-list` against
  `origin/<branch>` as of the last fetch). When merged PRs leave local
  branches behind, a "Delete N merged local branches…" button appears and
  runs `gh stack sync --prune` after a confirmation dialog (prune failures
  are never auto-handed to the agent — recovery must not delete branches as
  a side effect). The count is of merged branches that still have a local
  ref, not of merged branches: a prune deletes the branch but keeps its stack
  entry, so `view --json` reports it as merged forever and the button would
  otherwise never go away.
- **Merge N layers** lands the stack from the bottom up through **GitHub's
  atomic stack-merge API** — `PUT
  repos/{owner}/{repo}/pulls/<PR>/merge-async` via `gh api`, then polling the
  returned uuid until the status leaves `pending`. **Squash by default**, so
  each branch reads as one commit on the base. It does **not** wait for the
  whole stack. A layer's PR targets the branch below it, so a layer can merge
  only once every layer under it can; the merge set is therefore the run from
  the trunk up that stops at the first layer GitHub would refuse (no PR, or
  still a draft), and the API merges the named PR plus everything below it in
  the stack, atomically — all land (or enqueue) together, or nothing does.
  With three of five layers ready the button reads **Merge 3 of 5 layers**
  and the dialog says the two above stay open and want a Sync afterwards to
  restack them. The panel sends the PR it offered to stop at and the server
  honours it, so a layer readied between opening the dialog and confirming is
  never swept in. Nothing merges only when the *bottom* layer is unready, and
  the tooltip then names that one layer rather than counting every layer
  above it. The dialog offers Merge commit and Rebase as alternatives, and
  warns when branches still hold unpushed commits (only what is on GitHub
  merges). A merge queue on the base comes back as an explicit `enqueued`
  status and is reported as queued, not merged.

  The API, not `gh stack merge`, is deliberate. The CLI is a thin wrapper
  over this same endpoint (v0.1.0 `internal/github/merge_async.go`), and its
  argument is ambiguous by design: a bare number is resolved as a *stack*
  number first and a PR number only on 404, with no flag, URL, or branch form
  to force the PR reading (`cmd/merge.go` `resolveMergeStack`) — so in a repo
  where a PR number collides with a live stack number, naming the PR would
  merge someone else's stack. The API path takes the PR number itself,
  resolving nothing. It also reports failures better than the CLI can: `gh
  api` prints non-2xx bodies, so a 400's reason survives, and a 409 (a merge
  request already exists for the stack) yields the existing request's uuid,
  which the server simply polls instead of failing. A 404 means the async
  merge API is not enabled for the repository; results expire 24 h after
  their last update. Every `#N` the panel shows is a pull request number —
  stack numbers appear nowhere.
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
- **Auto Stack** (wand icon), beside the composer's own button: sends a prompt to the
  thread's own agent (whatever harness the session uses) to analyze the
  workspace, design layers, and submit draft PRs — automatic splitting, where
  the composer takes one layer at a time. The prompt adapts to the workspace:
  `gh stack init` when there is no stack, `gh stack top` + `add` on top of an
  existing one.
- **Settings popup** (the gear beside Refresh) holds the two naming
  conventions the panel follows, global to the plugin rather than per
  repository:
  - **Branch prefix** — the namespace every derived branch gets, `bb/` by
    default. Empty means "detect it": the namespace the stack's own branches
    share, else the checked-out branch's. The trailing separator is never
    required — it is added wherever the prefix is joined or previewed
    (`bb` → `bb/`) — and a value that cannot be a git ref is rejected.
  - **Conventional Commits** — on by default: layer names read
    `feat(api): add rate limiting` and the type and scope lead the branch slug
    (`bb/feat-api-add-rate-limiting`). The scope is carried into the branch
    because it is often the only thing telling two layers of one stack apart —
    `add the plugin` says nothing on its own. Suggest asks the agent for a
    Conventional Commits title with a scope, and Auto Stack tells it to write
    commits, PR titles, and branch names the same way. Off, a name slugifies
    whole.

  Both are stored in the plugin's kv (one global row) and travel on the
  `getStack` payload, so the popup opens without a second round trip and a
  save patches the cached payloads in place instead of re-running `gh`. The
  popup shows a live example of the branch the composer would build.
- Maps `gh stack` exit codes to actionable messages: not a stack, rebase
  conflict, GitHub API failure, stack file locked, stacked PRs unavailable,
  gh missing, timeout.
- **Cached, self-refreshing panel**: the server keeps a per-thread cache of
  the computed stack, so opening the panel paints instantly
  (stale-while-revalidate — reads older than 10s trigger a background
  recompute). Every fresh compute is announced on a realtime channel and open
  panels silently refetch, so the rail updates on its own: panels poll the
  cache every 30s, the thread's agent going idle triggers a refresh for
  watched threads (read within the last 90s), and actions (Sync / Submit /
  create / merge / draft toggle) force a fresh compute. A draft toggle also
  announces the cache entry as it stands, without recomputing, so the other
  panels adopt the new pill immediately and the compute converges behind
  them. The refresh icon beside the
  header forces one too — it spins whenever a fetch is in flight, manual or
  automatic — and hovering it shows the last-updated time. Realtime
  reconnects reconcile missed signals; deleted threads evict their cache
  entry.

## Requirements

- `gh` and the `gh-stack` extension on the BB **server** host:
  `gh extension install github/gh-stack`.
- The thread's workspace must exist on the server host (remote environments
  show an explanatory error).

## Install

```
npm install
bb plugin install .
```

After editing sources: `bb plugin reload gh-stack` (or `bb plugin dev` for a
watch loop).

## Layout

- `server.ts` — RPCs: `getStack` (thread → environment path →
  `gh stack view --json`, lenient zod parse, per-branch and working-tree
  diffs; served from the per-thread cache with background revalidation and
  `stack-updated` realtime announcements), `runAction` (sync / submit /
  sync-submit / prune), `mergeStack` (derive the mergeable run from the trunk
  up, then GitHub's async stack-merge API: `PUT pulls/<PR>/merge-async` and
  poll the uuid),
  `createStack` (init), `addBranch` (top + add), `setPrDraft`,
  `checkoutBranch` (smart checkout of a stack branch a row click names:
  auto-stash on conflict, auto-restore on return),
  `suggestStackName`, `autoStack`, `saveSettings` (normalize the prefix,
  write the kv row, patch cached payloads). Shared workspace resolution,
  exit-code mapping, and the settings-aware branch derivation the composer
  mirrors.
- `lib/git-diff.ts` — pure parsers for git's NUL-delimited `--numstat`,
  `--name-status`, and `status --porcelain=v1` output, plus change-set
  aggregation.
- `app.tsx` — `threadPanelAction` panel rendering the rail, plus the gear
  settings popup (responsive dialog / drawer) and its own copy of the branch
  derivation for the live preview.
- `components/stack/changed-file-tree.tsx` — Pierre Trees file tree with
  `+A −D` row decorations; `app.css` themes it against the host tokens.
- `components/ui/`, `types/` — vendored shadcn components and the bundled
  plugin SDK types (scaffold defaults).
