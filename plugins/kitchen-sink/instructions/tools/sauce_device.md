Run a device-level action in this thread's live session:

- `home`: press the device's home button.
- `restart_app`: relaunch the app under test; screenshot once it is back.
- `rotate`: turn the device; take a `sauce_screenshot` before the next touch.
- `shell` (Android only): run `adb shell <command>` and return its output. Sauce allows a fixed list of commands such as `am`, `dumpsys`, `getprop`, `input`, `grep`; `logcat`, `cat`, `tail` and `wm` are refused.
- `log`: save the full device log (the last 50,000 lines, all apps) to thread storage and return its `path`. Add `grep` to also get the last 100 matching lines.
