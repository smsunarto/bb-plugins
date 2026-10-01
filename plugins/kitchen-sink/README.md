<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Kitchen Sink

**Scott's kitchen sink of personal bb surfaces: composer commands, provider branding, and Smart Embeds.**

![bb 0.41+](https://img.shields.io/badge/bb-0.41%2B-88C0D0?style=flat-square)

</div>

## What it does

bb's `/` menu lists skills, so each composer command ships as a skill under `skills/`. Mention providers live in `src/server/mentions.ts` and register on load.

Kitchen Sink also supplies the official Devin icon for the `acp-devin` agent provider.

| Command    | What the agent does                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `/ship-it` | Sends “Ship it”.                                                                                                     |
| `/sync`    | Rebases the workspace onto the latest target branch and resolves every conflict by reading the intent of both sides. |

`/sync` detects GitButler with `but status` and routes every write through the `gitbutler` skill when it succeeds. Plain Git repositories use `git` and `gh`.

## Thread motion

Kitchen Sink fades thread switches and smooths automatic timeline scrolling. A
"Jump to latest event" palette command (Mod+Shift+J) scrolls the current thread
to its live tail. See
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

### Before/after images

`::smart-image-compare{before=".scratch/before.png" after=".scratch/after.png" beforeLabel="Original" afterLabel="Updated"}` renders an image comparison using [React Compare Slider](https://react-compare-slider.js.org/?path=/story/demos--images). Drag the divider, or focus it and use arrow keys. Labels overlay the image corners and default to Before and After.

Images accept workspace-relative paths or HTTP(S) URLs. Add `source="thread-storage"` for paths relative to the owning thread's storage. Match both images' pixel dimensions, crop, scale, and subject alignment before embedding. UI captures should use the same viewport, device pixel ratio, zoom, and scroll position. The viewer preserves whole images and warns about unequal dimensions, but cannot align subjects automatically. Keep labels in the directive, not baked into the images.

Add `annotations='[{"x":72,"y":38,"label":"Background removed","side":"after"}]'` for numbered callout pins. Coordinates are percentages from the image's top-left, and `side` is `before`, `after`, or `both` (default). Click or keyboard-activate a pin to read its text. Pins move with their image and are clipped by the divider. Opened callout text remains readable in a bottom overlay. Up to 50 unique callouts are supported.

## Inline visualizations

`::inline-vis` moved to its own plugin, [`scott-inline-vis`](../scott-inline-vis/README.md), so its lineage from bb's forkable built-in stays clean.

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
