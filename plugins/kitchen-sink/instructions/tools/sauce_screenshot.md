Capture the device screen at native resolution, upright, and save it as a PNG in this thread's storage. Returns `path`, `width`, `height`, and `rotation`.

Open the PNG to see the screen. Its width and height define the frame `sauce_touch` uses: `x` and `y` are fractions of this image. `rotation` is how Sauce's canvas is turned; `sauce_touch` maps every touch through it, so take a new screenshot after `sauce_device` rotate, after the app launches or switches orientation, and whenever the layout may have changed. Cite `path` as evidence in reports.
