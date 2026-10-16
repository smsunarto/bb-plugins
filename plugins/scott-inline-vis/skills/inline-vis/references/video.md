# Video delivery

## Video example

Save `.scratch/demo/clip.mp4` and `.scratch/demo/player.html` in a gitignored
workspace directory. Write the player as a fragment:

```html
<video id="demo-clip" controls autoplay muted loop playsinline src="./clip.mp4"></video>
<style>
  #demo-clip {
    display: block;
    width: 100%;
    max-height: 640px;
    border-radius: var(--viz-radius);
    background: #000;
  }
</style>
```

Then emit the directive without `height`:

```text
::inline-vis{file="/absolute/workspace/.scratch/demo/player.html"}
```

The frame follows the video's aspect ratio at the chat column width. The
`max-height` letterboxes portrait recordings instead of filling the 1200px
limit. Do not add a fixed `height`. It clips the runtime's padding or leaves
empty space below the video.

Keep both files in place. Use URL encoding for filename characters such as
spaces (`%20`), `#` (`%23`), and `?` (`%3F`).

## Mobile video delivery

Preserve native captures. Point the player at a separate delivery MP4 made by
the bundled helper. Its output plays on mobile decoders and starts playing
before the download finishes:

```bash
bash scripts/mobile-video.sh capture.mp4 clip-mobile.mp4
```

Resolve `scripts/mobile-video.sh` from the skill root, one directory above this
reference. It requires FFmpeg with
libx264 and refuses to overwrite existing files. The delivery copy uses H.264
High level 4.1, 8-bit yuv420p, at most 1920x1080, even dimensions, 30 fps,
at most 6 Mbit/s, AAC when audio exists, a keyframe every two seconds, and
fast-start metadata. It
preserves aspect ratio and does not upscale. Check the output remains below
the host's 25 MiB limit. The original stays unchanged.

## Streaming playback

An MP4 or QuickTime video starts playing while it downloads when its index
precedes its media: a fast-start or fragmented file. The app copies its
packets into fragments and the frame plays them through MediaSource.
Playback starts after the first keyframe interval arrives, so frequent
keyframes start sooner. A file whose index trails its media, such as a raw
`agent-browser record` MP4, and WebM play once the download completes.
Streaming applies when the video has one local candidate, either
`<video src>` or a single `<source>`. Several `<source>` candidates wait for
their downloads so the browser can choose between them. Any MediaSource
failure falls back to the downloaded file. Run the helper on recordings that
should stream.
