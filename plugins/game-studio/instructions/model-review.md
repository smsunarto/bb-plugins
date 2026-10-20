# Rendered 3D review evidence

For the 3D outputs, inspect topology, PBR channels, UVs, skeleton and animation in Game Studio's model viewer, and save representative rendered evidence. Saving that evidence under `canvas/evidence/` is the one file change this review may make. Inspect the captures before citing them. If the browser or renderer is unavailable, say so in the review.

This review's game is `{{gameId}}`, rooted at `{{rootPath}}`.

The viewer is at `$BB_SERVER_URL/plugins/game-studio/studio/{{gameId}}/viewer/<encodeURIComponent(projectRelativePath)>`.
`BB_SERVER_URL` is set in your environment and serves the BB app; on the BB host it
needs no sign-in. If the page asks you to sign in, report that rendered evidence was
unavailable. The viewer opens generated files before they are added to Assets.
Capture needs a self-contained model: a GLB, or a glTF with embedded buffers and
images. A glTF with external files can be viewed but not recorded.

With agent-browser, use a unique session. Before its first open:

```sh
agent-browser --session model-review set viewport 1920 1080 2
agent-browser --session model-review open "$BB_SERVER_URL/plugins/game-studio/studio/{{gameId}}/viewer/<encoded-path>"
agent-browser --session model-review wait --fn '!!window.gameStudioModelReview'
```

Inspect `window.gameStudioModelReview.stats` for available UVs, maps, joints,
textures and clips. Then evaluate JavaScript (not a string of executable code
inside the shot script). One capture call owns the run until it resolves:

```js
await window.gameStudioModelReview.capture({
  width: 1280,
  height: 720,
  shots: [
    { name: "topology-front", mode: "wireframe", camera: "front" },
    { name: "uv-check", mode: "uv-layout", camera: "three-quarter" },
    { name: "rig-side", mode: "skeleton", camera: "right" },
    {
      name: "animated-turntable",
      mode: "shaded",
      camera: "three-quarter",
      animation: { clip: "Swim", time: 0, speed: 1, loop: true },
      video: { duration: 3, fps: 24, turntable: true },
    },
  ],
});
```

Replace `Swim` with a real clip name. Omit unavailable shots; unsupported modes
reject the script before capture. `uv` shows a labelled A1–P16 checker through UV0;
`uv-layout` adds the UV0 edges as an inset. `joint` is a zero-based index into `stats.joints`.
For an exact camera pose, add `orbit: {position:[x,y,z], target:[x,y,z]}`
in model metres to a shot. Screenshot and Record controls preserve the current
orbit and pan. Video durations round up to the next frame at the requested fps.

For interactive inspection use `window.gameStudioModelReview.view({name:"inspect",
mode:"weights",joint:0,camera:"right"})` or the controls. Keys 1–8 select common
modes; Space toggles the selected animation. Use orbit/zoom/pan for closer review.

The result is `{runId, files}`. PNG/MP4 files and `shots.json` (including the
source model SHA-256) are under `canvas/evidence/<runId>/`. The existing Evidence
manifest is updated with compare-and-swap; refresh the Evidence tab to see the
run. Inspect the actual PNGs/video before attaching them to a review. The capture
does not infer a pass/fail verdict. A screenshot alone cannot establish rigging
quality; inspect the selected joint, clip and relevant poses too.

Frames render at explicit `index / fps` times, including glTF animation, and are
encoded with WebCodecs H.264 in MP4. This works headlessly in Chrome; there is no
wall-clock screen recording. Unsupported H.264 produces an error before saving.
Limits: 20 unique shot names, 64–2048 pixels per dimension, even video dimensions,
30 seconds per video, 60 fps, 1800 total frames, 2 billion rendered pixels, 25 MiB
per output. Split larger captures into separate calls. Cancel leaves incomplete
files ungrouped; only a completed run enters the manifest. Close only your browser
session after reviewing the returned files.
