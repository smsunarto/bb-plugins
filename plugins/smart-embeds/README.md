# bb-plugin-smart-embeds

Smart Embeds is a kitchen-sink bb plugin for rich assistant-message embeds.

The first two directives use [Diffs](https://diffs.com) to render project evidence:

- `::smart-diff{path="src/example.ts" start="40" end="72"}` renders only the hunks that touch those lines of the changed file, with nearby context. Deleted lines count at the position where they used to be. This is the form the agent instructions ask for by default.
- `::smart-diff{path="src/example.ts"}` renders the whole file's branch and working-tree changes. Meant for a new file, or one whose diff is short enough to read at a glance.
- `::smart-code{path="src/example.ts" start="12" end="28"}` renders an exact code citation with nearby context.

Both directives resolve from the message thread's current workspace. Clicking the header opens the file in bb's workspace viewer.

The instructions the plugin injects into agents live in `SMART_EMBED_INSTRUCTIONS` in `server/server.ts`. They are measured, not guessed. `eval/METRIC.md` defines the metric and `eval/RESULTS.md` records the climb: leading with the ranged form took embed-score from 66.5% to 79.6% on Sonnet and from 68.1% to 84.7% on Opus. Change that text through the harness, not by hand. `eval/prompts/baseline.md` must stay byte-identical to the shipped constant, and a test enforces it.

Rendered embeds are cached in the browser for the page session, so remounts and thread revisits render at once. The server publishes a `workspace-changed` realtime signal when a thread goes idle, fails, is archived, or is deleted. Idle and failed refresh that thread's embeds in place. Archived and deleted free them. A realtime reconnect refreshes everything, and the cache also drops least recently used entries past 128 entries or 4 MB of patches.
