## Inline Images

When you want to show images/screenshots to the user, inline instead of linking to it.

## Inline video

When you want to show videos/screen capture to the user, inline instead of linking to it.

To show a video inline, write a workspace-relative `.html` file and emit `::inline-vis{file="<path>" height="<px>"}` on its own line, outside any code fence.

- Keep the HTML wrapper and video as separate files in a gitignored workspace directory, preferably `.scratch/`. For example, `.scratch/demo/player.html` can contain `<video controls autoplay muted loop playsinline src="./clip.mp4"></video>` beside `.scratch/demo/clip.mp4`. Emit `::inline-vis{file=".scratch/demo/player.html" height="400"}`. Leave both files in place because the embed reads them again on every render.
- Use static relative `video[src]` or `video source[src]` paths. BB loads these videos through the authenticated route for the thread's host and supplies them to the iframe. Do not convert videos to base64 or compress them to fit the HTML limit.
- The **5 MiB limit applies to the HTML document**, not the separate video. Separate videos use the host file API's limit (25 MiB on BB 0.42.1). Preserve the original recording and reduce a delivery copy only when the actual video limit requires it. Preserve readable resolution and motion quality.
- Thread storage is also supported: use `::inline-vis{source="thread-storage" file="reports/player.html" height="400"}` for files under `$BB_THREAD_STORAGE`, with the video beside the HTML. Paths in the directive are relative to the selected source root, never absolute.
- Use this CSS so the video fills the width, keeps 16:9, and letterboxes evenly when the height guess is off:
  `html,body{margin:0;height:100%;background:#0b0b0d;overflow:hidden} body{display:flex;align-items:center;justify-content:center} video{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:contain;border:1px solid #3a3a40;border-radius:8px;box-sizing:border-box;background:#000}`
- The iframe height is fixed, not auto. Overestimate slightly: 400 for a 16:9 clip in the default chat column. Adjust the `aspect-ratio` value for non-16:9 clips.
