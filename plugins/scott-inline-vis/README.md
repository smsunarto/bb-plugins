# Inline visualizations

Shows an agent's HTML demo, chart, recording, or Markdown report inside the
assistant message, from any absolute path on the thread's host.

This fork is published as `@smsunarto/bb-plugin-scott-inline-vis` with plugin ID
`scott-inline-vis`. bb reserves the built-in's `inline-vis` ID, so the fork
cannot reuse it. It keeps upstream's `::inline-vis` directive, and replaces
upstream's workspace-relative RPC loader with an absolute-path loader, sibling
media delivery, and an auto-open limit.

Forked from [`get-bb/bb/plugins/inline-vis`](https://github.com/get-bb/bb/tree/desktop-v0.44.0/plugins/inline-vis).
Last synced with `desktop-v0.44.0` (`0baa605b32a00619c1d7e3f32be6553ebcf8244a`)
on 2026-09-26 and reviewed against `main` (`e56f8542d`) on 2026-09-30. The
later header polish (#4507, #4538) and direct file routes (#4554) are not
adopted: the fork keeps its Smart Embeds header and SDK preview lease. Shared UI under `components/` and `lib/` is vendored from the bb
plugin registry at that tag (`components.json`; update with
`npx shadcn add @bb/<item>`). The fork keeps upstream's file layout, so
`app.tsx` and `server.ts` diff directly against their upstream counterparts.

## Usage

`::inline-vis{file="/absolute/path/demo.html"}` renders HTML directly in an assistant message. `.md` and `.markdown` files use bb's Markdown renderer with sanitized HTML. An optional `height="480"` sets a 120–1200 pixel viewport. The default is 224 pixels.

`file` is an absolute path on the thread's host. There is no `source` attribute or relative-path fallback. Files can live in the workspace, thread storage, or any other readable directory. Expand `$BB_THREAD_STORAGE` before emitting a directive.

For example, `/tmp/demo/player.html` can contain `<video controls src="./clip.mp4"></video>` beside `/tmp/demo/clip.mp4`. Emit `::inline-vis{file="/tmp/demo/player.html" height="400"}`. Keep both files in place.

Keep preview files in a dedicated directory such as `.scratch/demo/`; the SDK lease covers that directory and its children. Markdown previews sanitize raw HTML, and local paths inside raw HTML do not resolve from the preview directory. Use `![Label](image.png)` for local images, or an HTML preview for explicit sizing or local video.

The bundled `inline-vis` skill teaches agents when to emit the directive and how to write the file. The plugin also injects a one-line instruction that routes agents to that skill.

## How it differs from upstream

|               | Upstream                                                                | This fork                                                                                      |
| ------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `file`        | Relative to the workspace or thread storage (`source`)                  | Absolute host path. `source` is rejected                                                       |
| Loading       | `preparePreview` plugin RPC, then bb's worktree or thread-storage route | `useSdk()` file read plus a one-hour `files.createPreview` lease on the document's directory   |
| Sibling media | Served by the route                                                     | `img`, `video`, and `source` files fetched by the app and handed to the opaque iframe as Blobs |
| Auto-open     | Every preview, unless the client preference is collapsed                | Only the last two per thread. The collapse preference is keyed by plugin ID                    |
| Card          | Tailwind card with an icon button                                       | Collapsible header styled like Kitchen Sink's Smart Embeds                                     |

## Security

The plugin reads through the SDK and leases the document's directory for asset access. Static sibling `img[src]`, `video[src]`, and video `source[src]` files are fetched by the authenticated app and transferred as Blobs into the opaque iframe. Nested directories work. Parent-directory escapes and symlinks outside the document's directory fail. Markdown destinations resolve from the same directory. Links outside it remain as written and do not prevent the report from rendering. Keep HTML styles and scripts self-contained or use remote URLs.

HTML runs with `sandbox="allow-scripts"`, without app cookies or storage access. The document limit is 5 MiB. Separate media use the host file API's limits (25 MiB for video and 10 MiB for raster images on BB 0.43.3). Remote URLs retain normal browser policies. Dynamically assigned local assets are not rewritten.

## Collapse behavior

Only the last two previews per thread open automatically. The last collapse or expand choice is remembered on the client: after collapsing a preview, new previews stay collapsed until one is expanded. Collapsing unloads the preview. Reopening rereads the file. Open previews keep their state when the one-hour lease expires. Collapse and reopen to obtain a fresh lease for local links. The header opens the absolute file through the SDK host viewer.

## Built-in conflict

bb leaves a directive literal when two plugins claim the same directive, so a fresh install of this fork disables bb's built-in `inline-vis` plugin once. Updates and reloads leave that choice alone. Re-enabling the built-in makes `::inline-vis` render as plain text. Removing the fork does not re-enable it; run `bb plugin enable inline-vis` to get bb's renderer back.

## Tests

```sh
bun run --filter @smsunarto/bb-plugin-scott-inline-vis test
```
