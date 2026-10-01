# Video delivery

## Video example

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
::inline-vis{file="/absolute/workspace/.scratch/demo/player.html" height="400"}
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

Resolve `scripts/mobile-video.sh` from the skill root, one directory above this
reference. It requires FFmpeg with
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
