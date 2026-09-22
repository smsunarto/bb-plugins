---
name: inline-vis
description: "Create inline BB visuals for explanations, comparisons, simulations, and UI previews, embed an existing HTML demo or recording, or show a Markdown plan, summary, or report from the workspace or thread storage."
---

# Inline previews

When the user should see a small HTML demo, chart, or report, or a Markdown
document, **inline in the assistant message**, write (or update) a
file, then emit its **absolute path** in a message directive on its own line:

```text
::inline-vis{file="/absolute/path/demo.html"}
::inline-vis{file="/absolute/path/notes.md"}
```

The file must exist on the thread's host. It can live in the workspace, thread
storage, or another readable directory. Expand `$BB_THREAD_STORAGE` to its actual
absolute value before emitting a directive. Relative `file` paths and the old
`source` attribute are rejected.

Before every embed, resolve and check the file on the thread host. For example,
run `realpath Logs/verify-rampage/ping-indicator/demo.html` there and copy the
returned absolute path into `file`. Do not emit the relative input, `~`, an
unexpanded variable, or a `file://` URL. If another machine produced the file,
copy it to the thread host first. Only asset URLs inside the document may be
relative. If BB reports `"file" must be an absolute path on the thread host`,
resolve the path and emit the corrected directive instead of repeating it.

Markdown links and images resolve from the document's directory. Keep local
assets in that directory or its children. Links outside that directory remain as written and do not abort the document.
They are not served by its preview lease.

## Choose the format

Create a visual when seeing or exploring it materially helps the user understand
or decide. Use Markdown for ordinary tables and Mermaid when static labeled
relationships fully explain the subject. Use HTML for adjustable inputs,
spatial behavior, or interactive comparisons. Use standard plotting tools for
scientific figures and charts intended for export or publication.

A request to build a website, component, or app remains project work. This skill
applies when explaining or previewing it in conversation, not as a replacement
for the requested deliverable.

## Read only the relevant reference

- Creating or changing a chart, simulation, comparison, or UI preview: read
  [visual design](references/visual-design.md) for composition, responsive
  layout, accessibility, and data presentation.
- Embedding a recording, creating a video player, or diagnosing playback: read
  [video delivery](references/video.md) for the player, mobile conversion,
  and playback checks. The conversion helper lives in this skill's `scripts/`.
- Showing an existing Markdown document: use the path and runtime rules here.
  No design or video reference is needed.

## Verify and deliver

Check the rendered result at desktop chat width and around 360px, including
light and dark appearance when supported. Exercise the primary interaction and
inspect labels, clipping, and runtime errors. Check the actual BB iframe when
behavior depends on embedding, media loading, or the fixed viewport height.
Do not claim a browser check that was not run.

Use durable, gitignored workspace files such as `.scratch/`. Keep the file in
place and emit its directive again whenever it changes. Choose a height that
fits the content after responsive reflow. BB does not auto-size this viewport.

Write self-contained HTML and explicitly provide the styles and libraries it
needs. Do not assume Codex's theme utilities, `Tweak`, Lucide global, or
`window.openai` exist in BB. Use the absolute-path directive and runtime rules below.

## Rules

- Keep each preview in a dedicated directory such as `.scratch/demo/`. The SDK
  lease covers that directory and its children.
- Markdown previews disable raw HTML. Use `![Label](image.png)` for images, or
  an HTML preview when image sizing is needed.
- On BB 0.43.3, separate raster images are limited to 10 MiB.
- `file` must be an absolute path on the thread's host. Do not use `source`.
- `height` is optional and sets the preview height in pixels. It must be a
  whole number from 120 through 1200; omit it for the 224px default.
- `.html`, `.htm`, `.md`, and `.markdown` files are accepted.
- Inline and external CSS/JavaScript are supported in HTML. Remote images,
  fonts, media, fetches, and WebSockets are also allowed subject to normal
  browser CORS, mixed-content, and remote-server policies. Scripts execute in an
  opaque-origin iframe and cannot access the bb page, cookies, or storage.
  Markdown uses BB's renderer with raw HTML disabled.
- The document must be at most 5 MiB. Keep videos as separate files beside the
  HTML instead of converting them to base64 or compressing them to fit the HTML.
- Static `img[src]`, `video[src]`, and nested video `source[src]` paths resolve
  from the HTML directory. Keep assets beside it or in child directories.
  Paths and symlinks outside that directory fail.
- Local images and videos also work through authenticated remote BB clients.
  Kitchen Sink uses the SDK's directory preview lease and transfers Blobs into
  the opaque iframe. The iframe receives no app credentials.
- Open previews keep their interactive state when the one-hour lease expires.
  Reopening a collapsed preview rereads the file and obtains a fresh lease. The header opens the absolute file on its host.
- On BB 0.42.1, each external video is limited to 25 MiB by the host file API.
  Playback waits for the full video download. Seeking then works from the
  buffered Blob. HTTP range streaming and larger files require BB core support.
- Existing data URI videos still work, with their encoded bytes counting toward
  the HTML limit. Remote URLs retain normal browser policies. Dynamically
  assigned media URLs and other authenticated relative assets are not rewritten.
- Emit the directive only after the file exists on disk on the thread host.
- Do **not** put the directive inside backticks or a markdown code fence, or it
  stays literal text.
- Incomplete streaming syntax stays literal until the closing `}` arrives. Emit
  a complete directive in one piece when possible.

The bb app replaces the directive with an inline preview. If the plugin is
disabled or the path is invalid, users see the original directive source or an
inline error from the plugin.
