Capture the device screen at native resolution, upright, and save it as a PNG in this thread's storage. Returns `path`, `width`, `height`, `rotation`, and `rotation_measured`.

Open the PNG to see the screen. Its width and height define the frame `sauce_touch` uses: `x` and `y` are fractions of this image. `rotation` is how Sauce's canvas is turned; `sauce_touch` maps every touch through it, so take a new screenshot after `sauce_device` rotate, after the app launches or switches orientation, and whenever the layout may have changed. Cite `path` as evidence in reports.

`rotation_measured: false` means the screen changed while it was captured (a video or transition). The result's `note` says whether the earlier rotation was kept or the rotation is unknown; when it is `null`, `sauce_touch` refuses until a screenshot taken on a still screen measures it.
