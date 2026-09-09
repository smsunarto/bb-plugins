---
name: inline-vis
description: "Create inline BB visuals for explanations, comparisons, simulations, and UI previews, or embed an existing HTML demo or recording."
---

# Inline HTML visualizations

When the user should see a small HTML demo, chart, or report **inline in the
assistant message**, write (or update) a workspace-relative `.html` file, then
emit this **message directive** as its own block (not inside a fenced code
block):

```text
::inline-vis{file="demo.html"}
```

## Choose the format

Create a visual when seeing or exploring it materially helps the user understand
or decide. Use Markdown for ordinary tables and Mermaid when static labeled
relationships fully explain the subject. Use HTML for adjustable inputs,
spatial behavior, or interactive comparisons. Use standard plotting tools for
scientific figures and charts intended for export or publication.

A request to build a website, component, or app remains project work. This skill
applies when explaining or previewing it in conversation, not as a replacement
for the requested deliverable.

## Composition

- Prefer one dominant visual and compact controls. Add metrics only when they
  explain the behavior. Put changing values beside their controls or marks.
- Avoid filler cards, invented scores, redundant legends, and controls that do
  not serve the requested comparison. Put a short explanation beside the embed
  instead of repeating the answer inside it.
- Keep presentation interactions local. Make the first render useful before
  input changes, and use one control mechanism for each state.
- For comparisons, use shared scales and show the requested dimensions together.
  For sequences or parallel work, align lanes on one time axis and annotate
  waits and bottlenecks there. For allocation, show the category breakdown.
- For UI previews, use the product's own typography, colors, and chrome. Show
  realistic states. Offer a few local design alternatives when they help the
  user choose, without turning the preview into a settings dashboard.

## Responsive visuals and accessibility

- Fit the chat width and reflow down to 320px. Stack or wrap content rather than
  shrinking text. Keep chart labels at least 11 screen pixels and reserve space
  for the longest formatted values.
- Size SVGs from their actual containers. Redraw charts on resize rather than
  shrinking a fixed desktop viewBox. Reduce ticks and optional annotations
  before sacrificing readable labels.
- Use semantic, labeled native controls with keyboard access and visible focus.
  Keep essential content available without hover. Provide touch targets around
  44px and a tap alternative for hover details.
- Announce meaningful dynamic results with `aria-live="polite"`, not every
  animation frame. Give charts a concise accessible description. Pair color
  with labels, shapes, or line styles.
- Define the visual's own theme-aware styles and verify contrast on its actual
  background. Keep category colors consistent across marks and legends.
  Keep explanatory surfaces quiet and avoid decorative container chrome.
- Animate state changes only when motion clarifies the relationship. Respect
  `prefers-reduced-motion`; avoid gratuitous entrance animations or loops.
  Recorded demos can retain the video playback behavior below.

## Charts and data

- Prefer simple SVG for a few directly labeled values. Use a plotting library
  when scales, dense data, or native interactions materially improve the result.
- Derive domains from the data, including uncertainty and reference values.
  Label quantities and units, keep marks within the plot, and prevent overlap
  among ticks, labels, legends, and annotations.
- For multi-series inspection, show values at a consistent x position so the
  tooltip supports comparison. Toggle each series and its tooltip row together.
- Use uncertainty bands for dense estimates and whiskers for isolated ones.
  Aggregate or downsample large datasets without hiding relevant variation.
- Use sourced geographic geometry and coordinates for maps. Do not invent
  outlines or present a blank coordinate field as a geographic basemap.

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
`window.openai` exist in BB. Use BB's workspace-relative directive and the
runtime rules below, not Codex's fragment or absolute-path output contract.

## Rules

- `file` is **workspace-relative** (e.g. `demo.html`, `charts/out.html`). Never
  use absolute paths.
- `height` is optional and sets the iframe viewport height in pixels. It must be
  a whole number from 120 through 1200; omit it for the 224px default.
- Only `.html` / `.htm` files are accepted.
- Inline and external CSS/JavaScript are supported. Remote images, fonts,
  media, fetches, and WebSockets are also allowed subject to normal browser
  CORS, mixed-content, and remote-server policies. Scripts execute in an
  opaque-origin iframe and cannot access the bb page, cookies, or storage.
- The HTML document must be at most 5 MiB. Keep videos as separate workspace
  files instead of converting them to base64 or compressing them to fit the HTML.
- Static `video[src]` and nested `source[src]` paths resolve from the HTML
  artifact's directory. See the example below.
  Both files must remain in the owning thread's workspace. Nested paths and
  `../` within the workspace work. Escape paths and symlinks outside it fail.
- Relative videos also work through authenticated remote BB clients. Kitchen
  Sink fetches them through the owning thread's workspace route and transfers
  Blobs into the opaque iframe. The iframe receives no app credentials.
- On BB 0.42.1, each external video is limited to 25 MiB by the host file API.
  Playback waits for the full video download. Seeking then works from the
  buffered Blob. HTTP range streaming and larger files require BB core support.
- Existing data URI videos still work, with their encoded bytes counting toward
  the HTML limit. Remote URLs retain normal browser policies. Dynamically
  assigned media URLs and other authenticated relative assets are not rewritten.
- Emit the directive only after the file exists on disk in the current thread
  workspace.
- Do **not** put the directive inside backticks or a markdown code fence, or it
  stays literal text.
- Incomplete streaming syntax stays literal until the closing `}` arrives. Emit
  a complete directive in one piece when possible.

The bb app replaces the directive with a sandboxed preview. If the plugin is
disabled or the path is invalid, users see the original directive source or an
inline error from the plugin.

## Relative video example

Save `.scratch/demo/clip.mp4` and `.scratch/demo/player.html` in a gitignored
workspace directory. The HTML can be small:

```html
<!doctype html>
<style>
  html,
  body {
    margin: 0;
    height: 100%;
    background: #000;
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
</style>
<video controls autoplay muted loop playsinline>
  <source src="./clip.mp4" type="video/mp4" />
</video>
```

Then emit:

```text
::inline-vis{file=".scratch/demo/player.html" height="400"}
```

Keep both files in place. Use URL encoding for filename characters such as
spaces (`%20`), `#` (`%23`), and `?` (`%3F`). The optional `height` is fixed;
choose it for the video aspect ratio and the chat column width.

## Mobile video delivery

Preserve native captures. Point the player at a separate delivery MP4 when
recordings exceed a mobile decoder's capabilities. Use the bundled helper:

```bash
bash scripts/mobile-video.sh capture.mp4 clip-mobile.mp4
```

Resolve the script relative to this skill directory. It requires FFmpeg with
libx264 and refuses to overwrite existing files. The delivery copy uses H.264
High level 4.1, 8-bit yuv420p, at most 1920x1080, even dimensions, 30 fps,
bounded bitrate, AAC when audio exists, and fast-start metadata. It preserves
aspect ratio and does not upscale. Check the output remains below the host's
25 MiB limit. The original stays unchanged.

For a playback report, inspect the actual MP4 with ffprobe (profile, level,
pixel format, frame rate, dimensions) and inspect the player's MediaError,
readyState, currentSrc, and authenticated network response. Do not diagnose
autoplay from a blank player alone. Keep controls and playsinline so playback
can start with a tap when autoplay is unavailable. Test playback and seeking
through the actual inline iframe. Desktop WebKit or an iPhone viewport does
not establish physical iPhone Safari playback.
