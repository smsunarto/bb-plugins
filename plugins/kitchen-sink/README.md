<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Kitchen Sink

**Scott's kitchen sink of personal bb surfaces: composer commands, mentions, Smart Embeds, and inline HTML visualizations.**

![bb 0.41+](https://img.shields.io/badge/bb-0.41%2B-88C0D0?style=flat-square)

</div>

## What it does

bb's `/` menu lists skills, so each composer command ships as a skill under `skills/`. Mention providers live in `src/server/mentions.ts` and register on load.

| Command    | What the agent does                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ship-it` | Finds the repository's CI gates, runs them locally, commits this session's changes, then lands on `origin/main` for a personal GitHub repository or opens a pull request. |
| `/sync`    | Rebases the workspace onto the latest target branch and resolves every conflict by reading the intent of both sides.                                                      |

Both commands detect GitButler with `but status` and route every write through the `gitbutler` skill when it succeeds. Plain Git repositories use `git` and `gh`.

## Autorouter

Enable Autorouter in Kitchen Sink settings, then use the branching-arrow button
beside voice input to pause it for one composer. Blue means active, muted means
paused. The control is hidden when disabled globally or ineligible, including
Anthropic follow-ups. The model/reasoning selector shimmers yellow while routing.

Project and model routing have separate switches. Each model and reasoning level
has an enable switch and editable guidance, alongside a general rule and fallback.
Defaults enable Astra low/medium/high/xhigh/ultra, Luna Max, Fable high/xhigh/ultra,
and Opus high/xhigh. Opus is eligible only while BB reports Fable usage exhausted.
Follow-ups can change Astra reasoning or escalate Luna Max to Astra. They cannot
route to Luna or switch providers.

One Luna Medium inference runs before native Send or Enter. Agent guidance uses
BB subthreads for command execution, specialized UI work, and independent review.
Run `/index-projects` to build the editable repository index from `~/git`.
See the [autorouter integration contract](src/server/lib/autorouter/README.md)
for fallback behavior, session timing, and the approved native-picker integration.

## Thread motion

Kitchen Sink fades thread switches and smooths automatic timeline scrolling. See
[thread switching and scrolling](src/app/timeline-motion/README.md) for behavior and limitations.

## Smart Embeds

Smart Embeds render project evidence inside assistant messages through BB’s host-owned diff renderer:

- `::smart-code{path="src/example.ts" start="12" end="28"}` cites current source with nearby context and its original line numbers.
- `::smart-code{path="Assets/Player.prefab"}` renders current Unity properties grouped by named GameObject and component. Both `.prefab` and `.unity` are supported. Optional line ranges select properties. **Raw YAML** opens the source view.

Citations use the message thread's current workspace and refresh when it changes. They do not represent historical snapshots. Add `workspace="bb-plugins"` to cite or diff a different workspace — a project name or id, an `env_` id, or a `thr_` id. When a citation path is missing from the thread's workspace, known project checkouts are probed: the containing thread's project wins outright, a single foreign hit resolves, and several hits fail closed with the candidate names. Turn diffs and patches never leave their thread. Unity object IDs retain their precision, local references resolve names, and prefab overrides show target/property paths. Malformed or unsupported assets fall back to YAML. This is a serialized property inspector, not a rendered 3D preview.

- Agents are instructed never to embed diffs of the current turn's own changes. Last Turn already renders those below the final response. `smart-diff` is reserved for answering a user's question that cites an existing commit (`source="commit"` with a full SHA); `smart-patch` covers unapplied proposals.
- `::smart-diff{path="src/example.ts"}` reads the containing message’s recorded turn patch. Use it only when that exact turn has a recorded patch containing the file. File edits, commits, and the Last Turn inspector do not establish that a recording exists.
- `::smart-diff{path="src/example.ts" source="commit" sha="FULL_40_CHARACTER_SHA"}` selects one exact commit, including a shipped commit still available in the repository.
- `::smart-diff{path="src/example.ts" source="workspace"}` captures branch plus uncommitted changes at first display. This is the previous workspace behavior, now explicit because it cannot identify an old message’s changes after shipping.
- `::smart-patch{file="proposal.patch"}` reads a proposal from thread storage. It can also preserve a scoped change snapshot. All files render separately. Optional `path` selects the new or previous name. Select one file before using `start`/`end` ranges.

Diff and patch ranges use inclusive new-side line positions, with two context lines. Deletions anchor at the next new-side position (line 1 for a fully deleted file). An adjacent change outside the requested range does not make that range nonempty. Renames without text hunks render without a range.

If a recorded patch is unavailable, cite the exact commit or a saved patch. Repeating the bare directive will not recover the evidence. Do not substitute a workspace diff for a historical or session-scoped claim, particularly when other branches or agents are present.

Every successful smart-diff result is persisted in the plugin SQLite database, scoped to thread, message, path, range, and source identity. First-writer wins across concurrent loads. Original snapshots remain readable. Errors and empty results are not frozen. Proposals remain file-backed, so keep their files available.

Missing recorded turn patches, missing commits, truncated input, ambiguous repeated file changes, and invalid paths produce an explicit notice. Historical requests never fall back to today’s workspace. Recorded lookup pages through at most 10,000 diff events. Individual tool edits are not combined into an invented net patch. Use an explicit commit or proposal when a provider did not record the turn patch. Workspace mode first viewed after shipping can only show the workspace at that time.

`@pierre/diffs` supplies `getSingularPatch` and patch boundary constants for parsing file identity and renames. It does not recover Git history. BB’s public `threads.events.list` supplies recorded turn patches, `environments.diff` supplies `commit` and `all` targets, and `threads.storageLocation` plus root-confined `files.read` supplies proposals. `environments.diffFile` can load old/new commit contents, but is unnecessary for patch-only evidence and is not used to guess historical context. The app uses `experimental_Diff`, preserving BB’s theme and diff-renderer routing.

Recorded changes still appear automatically in Last Turn, including the Unity before/after inspector. Smart Code continues to show current Unity values. Clicking a citation filename opens the workspace file.

## Inline visualizations

`::inline-vis{file="demo.html"}` renders a workspace-relative HTML file directly in an assistant message. An optional `height="480"` sets a 120–1200 pixel viewport. The default is 224 pixels.

Only the last two inline visualizations in a thread's rendered conversation open automatically. Older previews stay collapsed without preparing or loading their HTML. Expand or collapse any preview from its header. Manual choices last while that directive is mounted and override the automatic default, including when a new preview arrives. Collapsing unloads the iframe, so reopening resets its interactive state.

Ordering uses the plugin's own card elements in document order, not registration timing or filenames. This keeps prepended history and repeated directives ordered correctly without depending on private bb DOM selectors. The SDK does not expose an ordinal for each directive, so the default applies to currently rendered directives, not unloaded timeline pages.

Disable the standalone `inline-vis` plugin before enabling this renderer. bb leaves a directive literal when two plugins claim the same `inline-vis` message directive.

The server accepts only `.html` and `.htm` documents up to 5 MiB and verifies the file through bb's root-confined workspace API. Static relative `video[src]` and `video source[src]` references resolve against the HTML directory. The app fetches those videos from the existing authenticated thread worktree route, which selects the owning environment and host and enforces symlink containment. It sends the resulting Blobs to the opaque iframe through a one-time, document-specific handshake. The iframe creates and releases its own Blob URLs. This supports remote clients without exposing app credentials or placing video bytes inside the HTML.

For example, `.scratch/demo/player.html` can contain `<video controls src="./clip.mp4"></video>` beside `.scratch/demo/clip.mp4`. Emit `::inline-vis{file=".scratch/demo/player.html" height="400"}`. No base64 conversion is needed.

**Current limits (BB 0.42.1):** HTML remains capped at 5 MiB. Each separate video can be at most 25 MiB, the host file API's non-image limit. The route buffers the complete file and returns HTTP 200 even for Range requests. Playback starts after download and seeking uses the buffered Blob. This plugin does not add HTTP range streaming or remove the host limit. Existing data URI embeds still work. Dynamically assigned sources and other authenticated relative assets are outside this video loader's scope.

Documents without relative videos keep using the original worktree URL. Scripts run in a sandboxed opaque-origin iframe with `allow-scripts`, without `allow-same-origin`. The header action opens the original file in bb's workspace viewer.

This capability is forked from [`get-bb/bb/plugins/inline-vis`](https://github.com/get-bb/bb/tree/06aeaa994942ae7527dc49d2268c1f801e8542a0/plugins/inline-vis). Kitchen Sink replaces the upstream plugin's private `@bb/shared-ui` imports with package-owned markup and CSS so the external plugin remains SDK-only.

## Add a command

Create `skills/<name>/SKILL.md` with `name` and `description` frontmatter. The test suite checks that the directory name matches the frontmatter name.

## Add a mention

Append a `PluginMentionProviderRegistration` to `mentionProviders` in `src/server/mentions.ts`. Ids must be unique within the plugin and contain no `:`.

## Turn completion sound

Kitchen Sink plays Cursor's completion sound when a thread becomes idle, using
macOS `afplay` on the Mac running BB. It also plays while the thread is focused.
This uses the same sound asset as the retired Notify plugin and requires Cursor
at `/Applications/Cursor.app`. Other operating systems skip playback. Missing
assets or audio failures are logged without interrupting the agent. Plugin reload
or shutdown stops any sound still playing.
