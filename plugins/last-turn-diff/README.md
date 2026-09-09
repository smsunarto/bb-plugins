# Last Turn Diff

Automatically displays the latest completed turn's recorded file changes below its final assistant response. Each file expands into BB's diff viewer. Finishing another turn replaces the previous preview, including removing it when the new turn has no changes. The previous completed turn remains available while the next turn runs.

This is presentation-only. The plugin registers a read-only RPC and lifecycle notifications. It has no agent tools, instructions, skills, message directives, message writes, composer changes, or workspace writes. The preview is never appended to the conversation or model input. BB's copy, quote, and fork actions continue to use the original message text.

The aggregate provider turn patch takes precedence. Providers without one use BB's recorded file-change items, retaining successive edits separately rather than claiming they form a net patch. Changes made through tools that the provider does not record as file edits may be absent. Previews are bounded to 1,000,000 characters and 200 recorded edits. Large changes show a limit notice. Turns without a final assistant row have no placement target.

## DOM integration contract

Approved for this plugin: BB 0.42.1 has no below-message SDK slot. The `experimental_threadHeaderAction` registration owns the React lifecycle, RPC context, and per-pane thread identity. A DOM observer locates the final response by its exact `data-timeline-row-id` inside the owning `data-split-pane-id`, then appends a plugin-owned sibling outside the response's selectable Markdown and action bar. It never reads or rewrites message text. BB layout changes can require updates to these selectors. Missing targets fail closed. Reload, navigation, disable, and turn replacement remove the owned node and observer.

Only the latest query result is held in browser memory. No historical diffs or additional server snapshots are persisted. Lifecycle notifications refresh visible threads, with a 15-second foreground reconciliation poll to cover queued turns and reconnect races.

## Develop

Use the repository's `bun run dev`. From this directory: `bun run test`, `bun run typecheck`, `bun run check`, and `bun run build`.
