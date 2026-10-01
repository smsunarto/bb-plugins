---
name: inline-vis
description: "Show interactive explanations, charts, simulations, comparisons, UI previews, existing HTML demos, recordings, or Markdown documents inline in bb. Author HTML fragments with bb's theme and interaction runtime."
---

# Show a preview in conversation

Use this skill when a visual helps someone understand behavior, compare options, or review an interface in chat. Write the preview file on the thread host and emit its absolute path. Verify the preview before the final handoff.

## Choose the format

Choose the smallest format that answers the request:

- Use ordinary Markdown for tables and prose
- Use Mermaid for labeled connections that don't change with input
- Use HTML for adjustable inputs, spatial behavior, simulations, and interactive comparisons
- Use standard plotting tools for scientific figures or charts intended for export or publication
- Preview existing Markdown plans, summaries, and reports with the same directive

A website, component, or app request remains project work. A conversation preview does not replace that deliverable.

## Emit the directive

Put a complete directive on its own line after the file exists:

```text
::inline-vis{file="/absolute/path/demo.html"}
::inline-vis{file="/absolute/path/notes.md" height="480"}
```

Do not wrap the delivered directive in backticks or a code fence. Incomplete syntax stays literal until the closing `}` arrives. With the plugin disabled, the directive may remain literal. Invalid attributes or files produce an inline error.

Before every embed, run `realpath` on the thread host and use the returned absolute path:

```bash
realpath .scratch/demo/demo.html
```

- Expand `$BB_THREAD_STORAGE` to its actual absolute value
- Never emit a relative path, `~`, an unexpanded variable, or a `file://` URL
- Never use `source`. There is no relative-path fallback
- Copy files produced on another machine to the thread host first
- Accept `.html`, `.htm`, `.md`, and `.markdown`. Keep the UTF-8 document within 5 MiB
- Keep previews and their assets in a dedicated, durable directory, such as a gitignored `.scratch/demo/`

The file can live in the workspace, thread storage, or another readable host directory. If bb rejects the path, resolve it and emit the corrected directive. The preview lease covers the file's directory and its children.

## Author an HTML fragment

Prefer bare markup with one uniquely identified root, followed by optional `<style>` and `<script>` elements. Select that root with `document.getElementById`. Scope custom selectors and DOM queries to it.

Omit `<!doctype>`, `<html>`, `<head>`, and `<body>`. Any of those tags outside comments, scripts, and styles turns the file into a document without the runtime. Fragment scripts execute after the runtime defines `window.bb`.

Fragments receive bb's live theme, utility styles, icons, tooltips, tabs, variant carousels, and content sizing. Read [visual design](references/visual-design.md) before creating or changing a chart, simulation, comparison, or UI preview. It covers these features and includes a complete fragment.

Use document rendering for existing standalone pages whose own styling you need to retain. Fragments can also use a fixed `height`. Documents receive no fragment theme or runtime. Supply their CSS and libraries yourself. Do not assume `window.openai`, `Tweak`, or a Lucide global is available.

## Use the runtime API

Use `window.bb` inside fragment scripts:

| API                              | Behavior                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `bb.widgetState`                 | Returns the last JSON value saved for this preview, or `null`                                            |
| `await bb.setWidgetState(value)` | Replaces that snapshot with a JSON-serializable value, up to 16 KiB. Larger snapshots reject the promise |
| `await bb.sendFollowUp(prompt)`  | Appends a prompt after any composer draft and focuses the composer                                       |

Restore compatible saved values during initial rendering. Save after meaningful interactions, never on load. Storage belongs to this browser's localStorage and uses the plugin, thread, message, and file as its key.

Identical file directives in one message share that key. Reopening or reloading restores saved values when storage is available. The promise does not acknowledge durable storage.

Saved state never reaches the model. Include relevant selections in an explicit follow-up prompt when an investigation needs them. Call `sendFollowUp` from a clearly labeled button's click handler and pass a nonempty prompt. bb ignores prompts sent without a recent click or key press in the preview.

The user reviews and sends the composer text. The API does not send a message or start a turn. Keep prompts within 4,000 characters because the host truncates longer ones.

bb has no wide mode, calendar widget, or Tweak design-controls panel. Use the documented utilities and local controls.

## Deliver local media and Markdown

Keep local assets beside the preview or in child directories:

- Static `img[src]`, `video[src]`, and nested video `source[src]` paths resolve from the HTML directory
- Use forward slashes and URL-encode filename characters such as spaces, `#`, and `?`
- Paths and symlinks outside the directory fail
- The authenticated app transfers local images and videos as Blobs into the frame, including through remote bb clients
- Dynamically assigned local media URLs, local scripts, stylesheets, fonts, and other authenticated relative resources are not supplied by that bridge
- Do not use fetch or XMLHttpRequest (XHR) to read local files. Embed small data in the fragment

Read [video delivery](references/video.md) before embedding recordings, creating a video player, or diagnosing playback. Keep videos separate from HTML. The conversion helper remains in `scripts/mobile-video.sh`. Existing data URI videos work, but their encoded bytes count toward the document limit.

On BB 0.42.1, the host file API limits each external video to 25 MiB. Playback waits for the whole download, then seeking uses the buffered Blob. HTTP range streaming and larger video delivery require bb core support. On BB 0.43.3, separate raster images have a 10 MiB limit. Check current host limits before relying on larger assets.

Markdown previews use bb's renderer and sanitize raw HTML. Write local images as `![Label](image.png)`. Raw HTML paths do not receive Markdown path resolution. Use HTML for image sizing or local video. Markdown links and images resolve from the document directory. Links outside that directory stay as written and do not abort rendering, but the lease does not serve them.

Inline CSS and JavaScript work in HTML. Pin remote library versions and prefer jsDelivr, unpkg, esm.sh, or cdnjs. Remote scripts, styles, fonts, images, media, fetches, and WebSockets follow browser cross-origin, mixed-content, and server policies. These preferred hosts are not an allowlist. The `sandbox="allow-scripts"` frame has an opaque origin and no direct access to bb's page, cookies, or storage. Use `bb.setWidgetState` for the host-managed storage bridge.

## Size, verify, and deliver

Omit `height` for fragments that follow their content. A body ResizeObserver reports their height, which bb clamps to 40–1200px. Avoid viewport-height layouts and internal scroll containers. Split content that exceeds 1200px into smaller previews.

Set `height="480"` only when a fixed viewport is useful. Explicit heights must be whole numbers from 120 through 1200. Documents and Markdown retain a fixed 224px default when `height` is absent.

Verify the rendered preview before the final handoff. For bb-specific behavior, first post a complete preview directive so its iframe exists. Inspect that frame, fix the file, and collapse/reopen it to check corrections. Re-emit the verified preview in the final response.

Check these behaviors:

1. Inspect desktop chat width and around 360px. Also design for reflow down to 320px
2. Check light and dark themes, labels, contrast, clipping, and console errors
3. Exercise the primary interaction, keyboard access, and touch alternatives
4. For fragments, verify live theme changes, content sizing, and saved-state restoration when used
5. Use the actual bb iframe for runtime APIs, media delivery, and embedding-dependent behavior
6. For video, test playback and seeking as described in [video delivery](references/video.md)

A standalone browser page does not supply the fragment runtime. Do not claim a browser check you did not run.

Keep the files in place and emit the directive again after changes. A directive in a new message has a new state key. It does not inherit the previous message's saved snapshot.

Collapse and reopen an existing preview to reread the file and renew its one-hour lease. Open previews retain their current in-memory state when the lease expires. Collapsing unloads the frame, so only explicitly saved fragment state survives reopening.

An automatically opened preview also unloads when two newer previews replace it in the auto-open group. A manual toggle overrides that automatic choice. Unsaved state is lost on unloading. The header's open button opens the absolute file on its host.
