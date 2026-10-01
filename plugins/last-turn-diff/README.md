# Last Turn Diff

Automatically displays the most recent completed turn's recorded file changes below its final assistant response. Each file expands into BB's diff viewer. Unity `.unity` and `.prefab` files expand into the shared object inspector with before/after properties and a Raw YAML toggle. A later turn with recorded changes replaces the previous preview. Replies without edits retain it under the response that made the changes. The previous completed turn remains available while the next turn runs.

The plugin has no agent tools, instructions, skills, message directives, message writes, or composer changes. The preview is never appended to the conversation or model input. BB's copy, quote, and fork actions continue to use the original message text.

Files under `/tmp` and `/private/tmp` outside known projects are hidden from the preview and its totals before preview limits are applied. A turn with only those changes retains the previous project preview. Project folders named `tmp`, checkouts under `/tmp`, and moves between temporary files and projects remain visible.

## Workspace snapshots

Turn diffs come from Git snapshots of the thread's checkout, the approach T3 Code uses. The diff between the captures around a turn is its patch, so shell, formatter, and code-generator edits appear alongside provider-recorded edits.

| Capture | Taken on                                                        | Role                                                                          |
| :------ | :-------------------------------------------------------------- | :---------------------------------------------------------------------------- |
| `start` | `message.dispatch` hook, while the message is held              | Baseline. Pinned at `thread.active` only if the hook waited for it to finish. |
| `open`  | `thread.active`                                                 | Marks the thread as running. Never a baseline.                                |
| `end`   | `thread.idle`, `thread.failed`, or the next dispatch if earlier | End of the turn. Marks the thread as done.                                    |
| `run`   | `thread.active` when the `open` snapshot failed                 | Marks the thread as running. Never bounds a diff.                             |
| `stop`  | `thread.idle` or `thread.failed` when the `end` snapshot failed | Marks the thread as done. Never bounds a diff.                                |

Timestamps alone never tie a capture to a turn. The server runs one thread's snapshot operations in arrival order, and the dispatch hook waits for that queue. So a baseline that finished inside the hook was taken before the turn could write, and every earlier `end` finished before it too. A baseline is dropped if the hook gave up on it, if its message was queued instead, or if a queued row it did not carry dispatched without the hook (Send-now). bb releases the dispatch lock before a warm turn turns active, and bb exposes no identity linking a dispatch to its turn. So when a second pass runs for the same thread within a minute of an unclaimed baseline, both baselines are dropped. An `end` counts only if no next turn has started, or if it finished no later than the next turn's pinned baseline. A pair proven once is remembered, so a later Send-now turn does not revoke it. Turns without that proof (Send-now, a first message before its environment is ready, a slow capture, overlapping dispatches) fall back below.

Each capture runs `git add --all` into a throwaway index seeded from the real one, with assume-unchanged and skip-worktree flags cleared, then `write-tree`, `commit-tree`, and `update-ref`. It never touches the real index, HEAD, or branches. Captures live under `refs/bb-last-turn/<checkout>/<thread>/`, keyed by a hash of the worktree root. A thread keeps its latest 24 and anything from the last six hours, the longest a turn is treated as running. Archiving or deleting a thread drops its older refs and leaves recent ones behind a `gone` marker as evidence for overlapping turns. Linked worktrees share one ref store, so any capture also sweeps other worktrees' captures older than 30 days. Absent sparse-checkout files keep their committed content. Ignored files and edits inside submodules are invisible to snapshots, so the provider's recorded edits there are kept.

GitButler: `but` ignores this ref namespace. The diff compares working-tree snapshots, so `but commit`, `but absorb`, and workspace-commit rewrites during a turn keep the change in the turn. `but pull` or `but apply` during a turn changes files, and those files appear too.

Concurrent agents in one checkout: the turn's window is cut at every capture any thread takes in it. A file changed while no other thread was mid-turn (between its `open` and `end`) belongs to this turn. A file changed while another thread was also running belongs to this turn only if its provider recorded editing it. Otherwise it is listed under **Other agents in this checkout** and left out of the totals. A shell write made while two agents ran is therefore listed under Other in both cards. A file both agents edited shows both agents' hunks. Paths are compared after resolving symlinks, so a project added as `/tmp/x` still matches edits reported under `/private/tmp/x`. Each turn is attributed when it ends, and the result is kept in plugin storage, so losing another thread's captures later never reshuffles a card. The turn's recorded edits are subtracted on every read, and files any read found recorded stay claimed, so provider data that arrives late claims its files and a failed read never revokes them.

An empty snapshot means the checkout ended where it began, so provider edits that were later reverted are not shown. Snapshot patches over 1,000,000 bytes show the limit notice.

The dispatch hook holds bb's dispatch lock, so it waits at most 1.5 seconds for a capture before letting the message through. A slower capture is dropped, and that turn and the one before it fall back.

## Fallbacks

Without a snapshot pair (non-Git environments, turns from before the plugin was installed, an offline host), a nonempty aggregate provider turn patch takes precedence. Empty patches fall back to successful recorded file edits. Providers without one use BB's recorded file-change items, grouping successive edits to a file under one expandable entry. Each recorded edit remains a separate, numbered diff inside that entry. The counts sum recorded edits, rather than claiming they form a net patch. Previews are bounded to 1,000,000 characters and 200 recorded edits. Large changes show a limit notice. Turns without a final assistant row have no placement target.

## DOM integration contract

Approved for this plugin: BB 0.42.1 has no below-message SDK slot. The `experimental_threadHeaderAction` registration owns the React lifecycle, RPC context, and per-pane thread identity. A DOM observer locates the final response by its exact `data-timeline-row-id` inside the owning `data-split-pane-id`, then appends a plugin-owned sibling outside the response's selectable Markdown and action bar. It never reads or rewrites message text. BB layout changes can require updates to these selectors. Missing targets fail closed. Reload, navigation, disable, and turn replacement remove the owned node and observer.

The query searches completed turns backward within the current context boundary. Only the latest query result is held in browser memory. Snapshots persist only as the Git refs above. Lifecycle notifications refresh visible threads, with a 15-second foreground reconciliation poll to cover queued turns and reconnect races.

## Develop

Use the repository's `bun run dev`. From this directory: `bun run test`, `bun run typecheck`, `bun run check`, and `bun run build`.

## Unity context

Changed values come exclusively from the recorded turn patch. For modified files, the plugin reads current workspace text through the SDK's host and root boundary, then applies the recorded patch in reverse with exact line matching to recover its prior values. Object names and unchanged context reflect the current workspace. Added and deleted assets can be reconstructed from the patch alone. Missing, binary, malformed, oversized, or mismatched sources retain the recorded YAML diff. Smart Code citations share the parser and UI through `@bb-plugins/unity-inspector`, but display only current values.
