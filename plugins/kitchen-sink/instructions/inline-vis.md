## Inline Images

When you want to show images/screenshots to the user, inline instead of linking to it.

## Inline video

When you want to show videos/screen capture to the user, inline instead of linking to it.

To show a short video inline, write a workspace-relative `.html` file and emit `::inline-vis{file="<path>" height="<px>"}` on its own line, outside any code fence.

- Write the `.html` under a gitignored workspace dir. Prefer `.scratch/`; if `git check-ignore .scratch/x.html` fails, use `.bb/scratch/` or add `.scratch/` to `.git/info/exclude`. Never use thread storage or absolute paths, inline-vis only reads workspace-relative files. Leave the file in place, the embed re-reads it on every render.
- Embed the clip as a base64 `data:video/mp4` URI inside a `<video controls autoplay muted loop playsinline>` tag. The iframe cannot resolve relative paths. Keep the file under 5 MiB. Generate or shrink clips with ffmpeg if needed.
- Use this CSS so the video fills the width, keeps 16:9, and letterboxes evenly when the height guess is off:
  `html,body{margin:0;height:100%;background:#0b0b0d;overflow:hidden} body{display:flex;align-items:center;justify-content:center} video{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:contain;border:1px solid #3a3a40;border-radius:8px;box-sizing:border-box;background:#000}`
- The iframe height is fixed, not auto. Overestimate slightly: 400 for a 16:9 clip in the default chat column. Adjust the `aspect-ratio` value for non-16:9 clips.
