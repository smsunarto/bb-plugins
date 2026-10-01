# Inline visualizations

This plugin renders an agent's interactive explanation, chart, interface preview, recording, or Markdown report inside its assistant message. It reads files at absolute paths on the thread's host. HTML fragments inherit bb's theme and interaction runtime. Full HTML documents retain their own styling.

This fork uses package name `@smsunarto/bb-plugin-scott-inline-vis` and plugin ID `scott-inline-vis`. bb reserves the built-in `inline-vis` ID. The fork keeps the `::inline-vis` directive and adds absolute-path loading, sibling media delivery, an auto-open limit, and a fragment runtime.

Forked from [`get-bb/bb/plugins/inline-vis`](https://github.com/get-bb/bb/tree/desktop-v0.44.0/plugins/inline-vis). Last synced with `desktop-v0.44.0` (`0baa605b32a00619c1d7e3f32be6553ebcf8244a`) on 2026-09-26. The header from `main` (`80a98370e98c4a1e58ee9eabd49c759eb842a99c`, 2026-09-30) is ported: [#4507](https://github.com/get-bb/bb/pull/4507) and [#4538](https://github.com/get-bb/bb/pull/4538). Direct file routes ([#4554](https://github.com/get-bb/bb/pull/4554)) are not adopted because the fork loads files through its SDK preview lease. Shared UI under `components/` and `lib/` comes from the bb plugin registry at that tag. See `components.json` and update with `npx shadcn add @bb/<item>`. The fork retains upstream's file layout, so `app.tsx` and `server.ts` can be compared directly.

## Usage

Write the file, then put its directive on a separate line in an assistant message:

```text
::inline-vis{file="/absolute/path/demo.html"}
::inline-vis{file="/absolute/path/report.md" height="480"}
```

Resolve the path with `realpath` on the thread host before emitting it. Expand `$BB_THREAD_STORAGE` and other variables. There is no `source` attribute or relative-path fallback. Files can live in the workspace, thread storage, or another readable directory.

HTML accepts `.html` and `.htm`. Markdown accepts `.md` and `.markdown` and uses bb's renderer with sanitized HTML. Without `height`, fragments follow their content within 40–1200px. Documents and Markdown use a fixed 224px default. An explicit `height` fixes the viewport and must be a whole number from 120 through 1200.

Keep previews in a dedicated directory, such as `.scratch/demo/`. The preview lease covers that directory and its children. Keep local assets beside the file or in subdirectories. For example, `/tmp/demo/player.html` can contain `<video controls src="./clip.mp4"></video>` beside `/tmp/demo/clip.mp4`:

```text
::inline-vis{file="/tmp/demo/player.html" height="400"}
```

Keep both files in place. Markdown images should use `![Label](image.png)`. Raw HTML paths do not receive Markdown destination rewriting. Use HTML when you need image sizing or local video.

The bundled [inline-vis skill](skills/inline-vis/SKILL.md) teaches agents how to choose a format, author fragments, and verify delivery. The plugin injects a one-line instruction that routes agents to it. [Visual design](skills/inline-vis/references/visual-design.md) covers composition and runtime features. [Video delivery](skills/inline-vis/references/video.md) covers compatible encodings and playback checks.

## How it differs from upstream

The fork changes loading and presentation while retaining the directive syntax:

| Area             | Upstream                                            | This fork                                                               |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `file`           | Workspace or thread-storage relative, with `source` | Absolute host path. Rejects `source`                                    |
| Loading          | `preparePreview` RPC and bb file routes             | SDK file read and a one-hour directory preview lease                    |
| Sibling media    | Route-served assets                                 | App-fetched image and video Blobs delivered to the opaque frame         |
| Auto-open        | Every preview unless the client prefers collapse    | Last two previews per thread, subject to the plugin's client preference |
| Header           | Tailwind card and icon button                       | Upstream's whole-row toggle and open button, in Smart Embeds styling    |
| HTML fragments   | HTML rendering without this runtime                 | Live theme, utilities, icons, tooltips, tabs, and design carousel       |
| Fragment height  | Fixed viewport                                      | Content sizing unless `height` is set                                   |
| Fragment actions | None                                                | Durable saved state, native context chips, and composer prompts         |
| Design review    | None                                                | Wide view and a host Tweak panel for registered controls                |

## Fragment runtime

Author bare markup with a uniquely identified root and optional style and script elements. Select the root with `document.getElementById`. Files containing `<!doctype>`, `<html>`, `<head>`, or `<body>` use document rendering instead. Documents receive no fragment runtime or injected theme, and keep fixed viewport sizing. Sibling media delivery still applies.

The runtime is an independent implementation inspired by Codex's visualize skill. The fragment runtime includes no Codex code or text.

Fragments receive:

- **Live appearance:** bb's theme tokens, ANSI-derived hue and series colors, and transparent body styling
- **Shared styles:** responsive layout, cards, native controls, tables, progress, and text utilities
- **Icons:** automatically replaced Lucide placeholders, with Lucide 1.49.0 loaded from unpkg when needed
- **Tooltips:** `data-tooltip` details for hover, focus, and touch
- **Tabs:** declarative tab and panel markup with keyboard navigation
- **Mockup alternatives:** a `.viz-carousel` that preserves each design's DOM while switching
- **Content sizing:** a body ResizeObserver, with height clamped to 40–1200px
- **Wide view:** a dialog up to 1024px wide, preserving the current iframe and its interactions
- **Design controls:** sliders, colors, toggles, and selects registered through the `Tweak` helper

Fragment scripts run after `window.bb` is defined:

| API                                        | Result                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `bb.widgetState`                           | Saved JSON value or `null`                                                |
| `await bb.setWidgetState(value, options?)` | Queues a server save. State and optional `modelContent` each allow 16 KiB |
| `await bb.sendFollowUp(prompt)`            | Appends a composer prompt and shares available saved state                |
| `new Tweak({ container, onChange })`       | Registers bound controls in bb's Tweak panel                              |

The plugin's server database owns saved state, keyed by thread, message, and absolute file path. Two directives with the same file in one message share it. Reopening restores the server snapshot, including across browsers. Browser-local state migrates when the preview opens and widget state has never been saved on the server. Existing server tweaks survive migration. An explicitly saved JSON `null` remains authoritative. Older JSON-null rows without model content have uncertain history, so their browser copy stays without replacing server data. Successful migration removes the browser copy.

Save after meaningful interactions. The frame promise validates and posts the snapshot. The host shows saving progress or persistence errors. A directive in another message has a separate identity. The plugin has no snapshot-expiration or cleanup policy.

Set `options.modelContent` to a JSON value when the model should see a selected subset instead of the full widget state. Omit it, or set it to `null`, to expose the full state. Tweak values accompany either payload. Both state and model content must be valid JSON within 16 KiB each.

**Use saved state** adds a native context chip to the composer. Its provider reads the latest server snapshot when you send the message. `bb.sendFollowUp` appends a prompt and shares the same chip when saved state is ready. Without available state, or when persistence fails, the prompt still reaches your draft. Prompts require a nonempty string, and the host trims them to 4,000 characters. You review and send the draft. These actions do not send a message or start a turn. A later edit removes the attached state chip while saving. Add the current state again when it is ready to share.

Agents can call `inline_vis_get_state` for fresh snapshots in their current thread, optionally selecting a file or message. A chip shared into another thread still identifies its source thread. Refresh that widget from its original preview. The tool cannot read the source thread from a side chat. It returns at most 20 recent snapshots within 64 KiB, preserving complete JSON values. State is data, never agent instructions. It is not automatically injected into every turn.

Select **Wide view** to enlarge the same preview, then **Back to chat** to return. Unhandled Escape also returns from fragments and local-media previews. Use **Back to chat** for standalone HTML, which retains its original preview URL. Fragments that register controls expose **Tweak**. Its panel offers original-preview comparison, group or full reset, and **Add changes to chat**. That action saves adjustments and adds their context chip with a draft prompt. The helper is an independent implementation. See [visual design](skills/inline-vis/references/visual-design.md#register-design-controls) for its authoring API.

Only controls changed from their original values are saved. The snapshot retains up to 288 adjustments within 16 KiB of serialized JSON. Returning a control to its original value removes its saved adjustment. Over-budget adjustments stay unsaved in the current preview, with a visible notice. Widget-state saves and follow-up prompts remain usable. Original and reset keep the first registered default while it remains valid. If later options or bounds exclude it, the current authored default replaces it. Use one Tweak group per container. Re-registering that container replaces its group. Give build-before-attach containers a stable explicit ID.

There is no bundled calendar widget. For canvas charts, resolve CSS variables into colors and redraw on frame-root `style` or `data-theme` changes. See the design reference for the authoring contract and a complete example.

## Security

The plugin reads through the SDK and leases the document's directory for asset access. The authenticated app fetches static sibling `img[src]`, `video[src]`, and video `source[src]` files and transfers their Blobs into the frame. Nested directories work. Parent-directory escapes and symlinks outside the directory fail. Markdown destinations resolve from the same directory. Links outside it remain as written and do not prevent rendering, but the lease does not serve them.

HTML runs with `sandbox="allow-scripts"` in an opaque-origin iframe. It has no direct access to the bb page, app cookies, or app storage. The fragment bridge exposes content-height reports, bounded saved state, design controls, and composer prompts. The app checks message source and a per-frame token. The authenticated host persists state through validated RPC calls rather than granting the iframe storage access.

Composer updates require transient user activation on the bb page. A click or key press inside the preview provides it. Without one, the app ignores the prompt, so a fragment cannot fill the composer on load. Activation is page-wide and lasts a few seconds, so a click elsewhere in bb just before a preview loads also counts. The user still sends the message. Icon placeholders also cause the runtime to load the pinned Lucide script from unpkg.

Keep local CSS, JavaScript, and data inside the file, or load remote resources. Local fetch/XHR and dynamically assigned local assets do not receive authenticated delivery. Remote scripts, styles, fonts, and media load under normal browser cross-origin and mixed-content rules. Pin library versions. jsDelivr, unpkg, esm.sh, and cdnjs are preferred sources, not an enforced allowlist.

The UTF-8 document limit is 5 MiB. Separate media use the host file API's limits, recorded as 25 MiB for video on BB 0.42.1 and 10 MiB for raster images on BB 0.43.3. Video playback waits for the entire Blob download. Embedded data URI bytes count toward the document limit.

## Collapse behavior

Only the last two previews per thread open automatically. The client remembers your last collapse or expand choice. After you collapse one, new previews stay collapsed until you expand one. An auto-opened preview closes when two newer previews take its place, unless you manually toggled it. Closing unloads the frame and loses unsaved state. Reopening rereads the file and restores fragment state that was explicitly saved, if available.

Open previews retain in-memory state when the one-hour lease expires. Collapse and reopen to obtain a fresh lease for local links. The header's open button opens the absolute file through the SDK host viewer.

## Built-in conflict

bb leaves a directive literal when two plugins claim it. A fresh install of this fork disables bb's built-in `inline-vis` plugin once. Updates and reloads leave that choice alone. Re-enabling the built-in makes `::inline-vis` render as plain text. Removing the fork does not re-enable it. Run `bb plugin enable inline-vis` to restore bb's renderer.

## Tests

Run the plugin's tests from the repository root:

```sh
bun run --filter @smsunarto/bb-plugin-scott-inline-vis test
```

For rendered behavior, verify desktop chat width and around 360px in the actual bb iframe. Check live theme changes, interactions, height, wide view, Tweak controls, state restoration, and composer context chips. Verify local media playback and seeking separately.
