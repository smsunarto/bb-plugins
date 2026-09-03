# bb-plugin-smart-embeds

Smart Embeds is a kitchen-sink bb plugin for rich assistant-message embeds.

The first two directives use [Diffs](https://diffs.com) to render project evidence:

- `::smart-diff{path="src/example.ts"}` renders branch and working-tree changes for one file.
- `::smart-diff{path="src/example.ts" start="40" end="72"}` renders only the hunks that touch those lines of the changed file, with nearby context. Deleted lines count at the position where they used to be.
- `::smart-code{path="src/example.ts" start="12" end="28"}` renders an exact code citation with nearby context.

Both directives resolve from the message thread's current workspace. Clicking the header opens the file in bb's workspace viewer.

Rendered embeds are cached in the browser for the page session, so remounts and thread revisits render at once. The server publishes a `workspace-changed` realtime signal when a thread goes idle, fails, is archived, or is deleted. Idle and failed refresh that thread's embeds in place. Archived and deleted free them. A realtime reconnect refreshes everything, and the cache also drops least recently used entries past 128 entries or 4 MB of patches.
