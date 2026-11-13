Start a live session on one Sauce Labs real device with a build from Sauce app storage, and lease the device to this thread.

BEFORE CALLING

- `sauce_status` returned `ready` or `session_abandoned`.
- Copy `device` exactly and `os` as a prefix (for example "Android 16") from `sauce_catalog` devices listed for the same `app`. `app` matches text in a build label; omitted, the newest build is used.

RETURNS the device header and session URL. The app then installs and launches over 20-60 s; call `sauce_screenshot` before any `sauce_touch`, because the screenshot sets the coordinate frame.

The account has one live slot. Hold it only while testing: call `sauce_end` as soon as you finish or before switching devices. A lease idle for 15 minutes can be taken over, and Sauce itself ends a session left idle for a few minutes (tools then report `no_session`).

On `start_pending`, Start Test was clicked but the session page was slow; this thread keeps the device. Call `sauce_status` after a minute: continue on `session_mine`, otherwise call `sauce_end` to free the device.
