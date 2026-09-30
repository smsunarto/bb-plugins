# Last Turn Diff

Automatically displays the most recent completed turn's recorded file changes below its final assistant response. Each file expands into BB's diff viewer. Unity `.unity` and `.prefab` files expand into the shared object inspector with before/after properties and a Raw YAML toggle. A later turn with recorded changes replaces the previous preview. Replies without edits retain it under the response that made the changes. The previous completed turn remains available while the next turn runs.

The plugin has no agent tools, instructions, skills, message directives, message writes, or composer changes. The preview is never appended to the conversation or model input. BB's copy, quote, and fork actions continue to use the original message text.

## Workspace snapshots

Turn diffs come from Git snapshots of the thread's checkout, the approach T3 Code uses. A `message.dispatch` hook captures the checkout before each new turn reaches the provider, and `thread.idle` or `thread.failed` captures it again. The diff between the two captures is the turn's patch, so shell, formatter, and code-generator edits appear alongside provider-recorded edits. `thread.active` captures a baseline when dispatch had no environment yet or Send-now skipped the hook.

Each capture runs `git add --all` into a throwaway index seeded from the real one, then `write-tree`, `commit-tree`, and `update-ref`. It never touches the real index, HEAD, or branches. Captures live under `refs/bb-last-turn/<checkout>/<thread>/`, keyed by a hash of the worktree root, 16 per thread. Archiving or deleting a thread drops its refs. Ignored files are excluded.

GitButler: `but` ignores this ref namespace. The diff compares working-tree snapshots, so `but commit`, `but absorb`, and workspace-commit rewrites during a turn keep the change in the turn. `but pull` or `but apply` during a turn changes files, and those files appear too.

Concurrent agents in one checkout: the turn's window is cut at every capture any thread takes in it. A file changed while no other thread was mid-turn belongs to this turn. A file changed while another thread was also running belongs to this turn only if its provider recorded editing it. Otherwise it is listed under **Other agents in this checkout** and left out of the totals. A shell write made while two agents ran is therefore listed under Other in both cards. A file both agents edited shows both agents' hunks. Paths are compared after resolving symlinks, so a project added as `/tmp/x` still matches edits reported under `/private/tmp/x`.

The dispatch hook holds bb's dispatch lock, so it waits at most 1.5 seconds for a capture before letting the message through. A slower capture finishes in the background.

## Fallbacks

Without a snapshot pair (non-Git environments, turns from before the plugin was installed, an offline host), a nonempty aggregate provider turn patch takes precedence. Empty patches fall back to successful recorded file edits. Providers without one use BB's recorded file-change items, retaining successive edits separately rather than claiming they form a net patch. Previews are bounded to 1,000,000 characters and 200 recorded edits. Large changes show a limit notice. Turns without a final assistant row have no placement target.

## DOM integration contract

Approved for this plugin: BB 0.42.1 has no below-message SDK slot. The `experimental_threadHeaderAction` registration owns the React lifecycle, RPC context, and per-pane thread identity. A DOM observer locates the final response by its exact `data-timeline-row-id` inside the owning `data-split-pane-id`, then appends a plugin-owned sibling outside the response's selectable Markdown and action bar. It never reads or rewrites message text. BB layout changes can require updates to these selectors. Missing targets fail closed. Reload, navigation, disable, and turn replacement remove the owned node and observer.

The query searches completed turns backward within the current context boundary. Only the latest query result is held in browser memory. Snapshots persist only as the Git refs above. Lifecycle notifications refresh visible threads, with a 15-second foreground reconciliation poll to cover queued turns and reconnect races.

## Develop

Use the repository's `bun run dev`. From this directory: `bun run test`, `bun run typecheck`, `bun run check`, and `bun run build`.

## Unity context

Changed values come exclusively from the recorded turn patch. For modified files, the plugin reads current workspace text through the SDK's host and root boundary, then applies the recorded patch in reverse with exact line matching to recover its prior values. Object names and unchanged context reflect the current workspace. Added and deleted assets can be reconstructed from the patch alone. Missing, binary, malformed, oversized, or mismatched sources retain the recorded YAML diff. Smart Code citations share the parser and UI through `@bb-plugins/unity-inspector`, but display only current values.
