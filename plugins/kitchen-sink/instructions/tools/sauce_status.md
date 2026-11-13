Check whether this thread can use a Sauce Labs real device: the shared Sauce Live browser on the bb server machine, its sign-in, the account's one live-device slot, and which bb thread holds that device. Call it first in any Sauce device task. It is the sign-in check a task asks for when it says to open Sauce Live in a local Chrome: `ready` means the browser is signed in, and `browser` names where it runs.

Returns `state` with a `next` step:

- `ready`: browse builds and devices with `sauce_catalog`, then `sauce_start`.
- `signed_out`: call again with `sign_in: true` once. If it stays signed out, stop and report it.
- `held_by_other_thread`: `holder` names the thread. Wait for it with `bb thread wait <thread>` or message it; never take the device.
- `session_mine`: your session is live.
- `session_abandoned`: the holder went idle for 15 minutes; `sauce_start` takes the device over.
- `session_untracked` or `capacity_reached`: someone outside these tools is using the slot. Wait or ask the user; do not end their session.

A `browser_unavailable` error means the bb server machine cannot run the Sauce browser; report it rather than trying another browser.
