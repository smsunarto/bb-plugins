# HTML visualizations

This plugin renders an agent's interactive explanation, chart, interface preview, page, recording, or Markdown report inside its assistant message. The content comes from one of three places: a page the agent published with `html_render`, a file at an absolute path on the thread's host, or HTML the agent writes in a fenced block. All three render in the same card. HTML fragments inherit bb's theme and interaction runtime wherever they come from.

The plugin joins two lineages. Its file and fence previews are a fork of bb's built-in inline-vis plugin, formerly published here as `scott-inline-vis`. Its published pages port T3 Code's inline HTML pages. The package name is `@smsunarto/bb-plugin-html` and the plugin ID is `html`. bb reserves the built-in `inline-vis` ID; this plugin keeps the `::inline-vis` directive and the `scott-inline-vis` fence language so earlier threads keep rendering. Saved state from `scott-inline-vis` was not carried over.

## Published pages

`html_preview` and `html_render` port T3 Code's agent tools. Their descriptions in `instructions/tools/` are T3 Code's prompt (pingdotgg/t3code `cc0b86d`), changed only where bb differs from T3: the directive replaces T3's automatic placement, the column width is bb's 712px, there is no browser auto-install or separate mobile frame behavior, and a fragment gets the visualization runtime.

- `html_preview` renders the page in headless Chrome on the bb server and returns a PNG, the content height, and console output. A fragment is previewed inside the visualization runtime and a document with the page bootstrap, as the thread will show them.
- `html_render` stores the page on the bb server and returns a `::html-render{…}` directive. The agent puts it at the top of its reply.
- Absolute image paths are read from the machine the thread runs on and inlined. Each image may be at most 10 MiB and the page at most 25 MiB.
- Viewport-height units are rejected at publish, so a published page fits its content up to 20,000px.
- A fragment page gets the full runtime below, including saved state and Tweak. A full document gets T3's page bootstrap: the theme variables, a base stylesheet, content-fit height, and links and images that open through bb.
- The app loads the page from the plugin's `/page` route. Published pages never change, so the browser cache can show one while the server is unreachable. Deleting a thread deletes its pages and saved state.
- Previews reach only public addresses: Chrome's traffic goes through a local SOCKS proxy that refuses loopback, private, link-local, and the server's own addresses after resolving names.

Settings:

- `chromePath`: Chrome or Chromium on the bb server. Empty searches the usual macOS and Linux locations and the Playwright cache.
- `chromeNoSandbox`: run Chrome without its sandbox, for root accounts or AppArmor-restricted Ubuntu.

## Files and fenced blocks

The file and fence previews are forked from [`get-bb/bb/plugins/inline-vis`](https://github.com/get-bb/bb/tree/desktop-v0.44.0/plugins/inline-vis). Last synced with `desktop-v0.44.0` (`0baa605b32a00619c1d7e3f32be6553ebcf8244a`) on 2026-09-26. The header from `main` (`80a98370e98c4a1e58ee9eabd49c759eb842a99c`, 2026-09-30) is ported: [#4507](https://github.com/get-bb/bb/pull/4507) and [#4538](https://github.com/get-bb/bb/pull/4538). Direct file routes ([#4554](https://github.com/get-bb/bb/pull/4554)) are not adopted because the fork loads files through its SDK preview lease. Shared UI under `components/` and `lib/` comes from the bb plugin registry at that tag. See `components.json` and update with `npx shadcn add @bb/<item>`. Upstream's `app.tsx` corresponds to `src/app/app.tsx`.

### Usage

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

A small fragment can also be written directly in the reply as a fenced block with the language `scott-inline-vis`. Nothing is written to disk:

````text
```scott-inline-vis
<div id="latency-viz">…</div>
```
````

The card shows "Writing visualization…" until the closing fence arrives, then renders the block through the same frame and fragment runtime. Its header button toggles bb's code block for the source. An unclosed or empty block stays an ordinary code block. A block has no directory, so relative media does not load, and it takes no attributes: fragments size to their content and full documents use the 224px viewport. Its saved state lasts only while the preview is open, and its Tweak panel cannot add changes to chat. Use a file for anything that needs those.

The bundled [inline-vis skill](skills/inline-vis/SKILL.md) teaches agents how to choose a format, author fragments, and verify delivery. The plugin injects a one-line instruction that routes agents to it. [Visual design](skills/inline-vis/references/visual-design.md) covers composition and runtime features. [Video delivery](skills/inline-vis/references/video.md) covers compatible encodings and playback checks.

### How it differs from upstream

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
| Fenced blocks    | ` ```inline-vis ` page in a borderless frame        | ` ```scott-inline-vis ` fragment in the same card and runtime           |
| Published pages  | None                                                | `html_render` pages in the same card and runtime                        |

## Fragment runtime

Author bare markup with a uniquely identified root and optional style and script elements. Select the root with `document.getElementById`. Files containing `<!doctype>`, `<html>`, `<head>`, or `<body>` use document rendering instead. File and fence documents receive no fragment runtime or injected theme, and keep fixed viewport sizing. Sibling media delivery still applies. Published documents get the page bootstrap described above.

The runtime is an independent implementation inspired by Codex's visualize skill. The fragment runtime includes no Codex code or text.

Fragments receive:

- **Live appearance:** the shared page variables mapped from bb's theme, and transparent body styling
- **Links:** clicked http(s) links open through bb instead of inside the frame
- **Shared styles:** responsive layout, cards, native controls, tables, progress, and text utilities
- **Icons:** automatically replaced Lucide placeholders, with Lucide 1.49.0 loaded from unpkg when needed
- **Tooltips:** `data-tooltip` details for hover, focus, and touch
- **Tabs:** declarative tab and panel markup with keyboard navigation
- **Mockup alternatives:** a `.viz-carousel` that preserves each design's DOM while switching
- **Content sizing:** a body ResizeObserver, with height clamped to 40–1200px, or 80–20,000px for a published page
- **Wide view:** a dialog up to 1024px wide, preserving the current iframe and its interactions
- **Design controls:** sliders, colors, toggles, and selects registered through the `Tweak` helper

Fragment scripts run after `window.bb` is defined:

| API                                        | Result                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `bb.widgetState`                           | Saved JSON value or `null`                                                |
| `await bb.setWidgetState(value, options?)` | Queues a server save. State and optional `modelContent` each allow 16 KiB |
| `await bb.sendFollowUp(prompt)`            | Appends a composer prompt and shares available saved state                |
| `new Tweak({ container, onChange })`       | Registers bound controls in bb's Tweak panel                              |

The plugin's server database owns saved state, keyed by thread, message, and either the absolute file path or `html-render:<page id>`. Two directives with the same file in one message share it. Reopening restores the server snapshot, including across browsers. A fenced block keeps its state in memory only.

Save after meaningful interactions. The frame promise validates and posts the snapshot. The host shows saving progress or persistence errors. A directive in another message has a separate identity. The plugin has no snapshot-expiration or cleanup policy.

Set `options.modelContent` to a JSON value when the model should see a selected subset instead of the full widget state. Omit it, or set it to `null`, to expose the full state. Tweak values accompany either payload. Both state and model content must be valid JSON within 16 KiB each.

**Use saved state** adds a native context chip to the composer. Its provider reads the latest server snapshot when you send the message. `bb.sendFollowUp` appends a prompt and shares the same chip when saved state is ready. Without available state, or when persistence fails, the prompt still reaches your draft. Prompts require a nonempty string, and the host trims them to 4,000 characters. You review and send the draft. These actions do not send a message or start a turn. A later edit removes the attached state chip while saving. Add the current state again when it is ready to share.

Agents can call `html_get_state` for fresh snapshots in their current thread, optionally selecting a file, page key, or message. A chip shared into another thread still identifies its source thread. Refresh that widget from its original preview. The tool cannot read the source thread from a side chat. It returns at most 20 recent snapshots within 64 KiB, preserving complete JSON values. State is data, never agent instructions. It is not automatically injected into every turn.

Select **Wide view** to enlarge the same preview, then **Back to chat** to return. Unhandled Escape also returns from fragments and local-media previews. Use **Back to chat** for standalone HTML, which retains its original preview URL. Fragments that register controls expose **Tweak**. Its panel offers original-preview comparison, group or full reset, and **Add changes to chat**. That action saves adjustments and adds their context chip with a draft prompt. The helper is an independent implementation. See [visual design](skills/inline-vis/references/visual-design.md#register-design-controls) for its authoring API.

Only controls changed from their original values are saved. The snapshot retains up to 288 adjustments within 16 KiB of serialized JSON. Returning a control to its original value removes its saved adjustment. Over-budget adjustments stay unsaved in the current preview, with a visible notice. Widget-state saves and follow-up prompts remain usable. Original and reset keep the first registered default while it remains valid. If later options or bounds exclude it, the current authored default replaces it. Use one Tweak group per container. Re-registering that container replaces its group. Give build-before-attach containers a stable explicit ID.

There is no bundled calendar widget. For canvas charts, resolve CSS variables into colors and redraw on frame-root `style` or `data-theme` changes. See the design reference for the authoring contract and a complete example.

## Security

The plugin reads through the SDK and leases the document's directory for asset access. The authenticated app fetches static sibling `img[src]`, `video[src]`, and video `source[src]` files and transfers their Blobs into the frame. Nested directories work. Parent-directory escapes and symlinks outside the directory fail. Markdown destinations resolve from the same directory. Links outside it remain as written and do not prevent rendering, but the lease does not serve them.

HTML runs with `sandbox="allow-scripts allow-forms allow-downloads"` in an opaque-origin iframe. It has no direct access to the bb page, app cookies, or app storage. Fragments, published pages, and documents with local media load through the plugin's same-origin `/frame` route, which writes the prepared document into itself. Do not switch back to `srcdoc`: bb mobile's WebView cancels `about:srcdoc` frames. The route's matching `sandbox` CSP keeps the page opaque even outside the iframe, as does the `/page` route's. The fragment bridge exposes content-height reports, bounded saved state, design controls, and composer prompts. The app checks message source and a per-frame token. Link and image requests open only after a click inside that frame. The authenticated host persists state through validated RPC calls rather than granting the iframe storage access.

Composer updates require transient user activation on the bb page. A click or key press inside the preview provides it. Without one, the app ignores the prompt, so a fragment cannot fill the composer on load. Activation is page-wide and lasts a few seconds, so a click elsewhere in bb just before a preview loads also counts. The user still sends the message. Icon placeholders also cause the runtime to load the pinned Lucide script from unpkg.

Keep local CSS, JavaScript, and data inside the file, or load remote resources. Local fetch/XHR and dynamically assigned local assets do not receive authenticated delivery. Remote scripts, styles, fonts, and media load under normal browser cross-origin and mixed-content rules. Pin library versions. jsDelivr, unpkg, esm.sh, and cdnjs are preferred sources, not an enforced allowlist.

The UTF-8 document limit is 5 MiB. Separate media use the host file API's limits, recorded as 25 MiB for video on BB 0.42.1 and 10 MiB for raster images on BB 0.43.3. Video playback waits for the entire Blob download. Embedded data URI bytes count toward the document limit.

## Collapse behavior

Only the last two previews per thread open automatically. The client remembers your last collapse or expand choice. After you collapse one, new previews stay collapsed until you expand one. An auto-opened preview closes when two newer previews take its place, unless you manually toggled it. Closing unloads the frame and loses unsaved state. Reopening rereads the file and restores fragment state that was explicitly saved, if available.

Open previews retain in-memory state when the one-hour lease expires. Collapse and reopen to obtain a fresh lease for local links. The header's open button opens the absolute file through the SDK host viewer.

## Built-in conflict

bb leaves a directive literal, and a fenced block as plain code, when two plugins claim it. The fence language, `scott-inline-vis`, cannot collide with the built-in's `inline-vis`. The directive still collides, so a fresh install disables bb's built-in `inline-vis` plugin once. Updates and reloads leave that choice alone. Re-enabling the built-in makes `::inline-vis` render as plain text. Removing this plugin does not re-enable it. Run `bb plugin enable inline-vis` to restore bb's renderer. The same fresh install disables `scott-inline-vis`, which claims both the directive and the fence; uninstall it once this plugin works.

## Tests

Run the plugin's tests from the repository root:

```sh
bun run --filter @smsunarto/bb-plugin-html test
```

The `html_preview` tests run headless Chrome when one is installed; set `BB_HTML_TEST_CHROME` to choose it. For rendered behavior, verify desktop chat width and around 360px in the actual bb iframe. Check live theme changes, interactions, height, wide view, Tweak controls, state restoration, and composer context chips. Verify local media playback and seeking separately.
