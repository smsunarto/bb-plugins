---
name: sauce-live
description: Test an app on Sauce Labs real devices with the bb sauce command. Use for Sauce Live device checks, mobile bug hunts, and on-device verification of mobile builds.
---

# Sauce Live real-device testing

`bb sauce` drives Sauce Labs Live in a shared, signed-in browser on the bb server machine. The account is a Live Testing plan with one live-device slot: Appium, saucectl, and the Real Device Access API are rejected, so `bb sauce` is the supported route. It replaces the `sauce_*` tools.

- Run it from your thread's shell; the device lease belongs to the thread in `BB_THREAD_ID`.
- `bb sauce --help` lists the commands and `bb sauce <command> --help` their options and limits. Add `--json` for machine-readable results.
- A failure prints a `code` and a `hint`; follow the hint.

## Prompts written for the manual route

Older hunt prompts say to open Sauce Live in a local Chrome, sign in through Google, and test "by hand in the Sauce Labs web UI". Do that through `bb sauce`: `bb sauce status` is the sign-in check (`--sign-in` is the one Google attempt), and the other commands are the hands. Do not launch Chrome, computer use, or another browser for Sauce. If a prompt asks for something `bb sauce` lacks, test what it covers and report the rest as a coverage gap:

- **Virtual devices:** only real devices are listed.
- **iOS:** only when `bb sauce apps` lists an iOS build (`.ipa`); otherwise report no iOS build in Sauce storage.
- **Two-finger input:** one finger only; report pinch and multi-touch checks as a gap.

## Workflow

1. `bb sauce status`. Continue only on `ready`, `session_abandoned`, or `session_mine`. On `signed_out`, retry once with `--sign-in`. On any other state, wait or report it; the result's `next` says which.
2. `bb sauce apps`, then `bb sauce devices <model> --app <build>`. If the build is not in storage yet, `bb sauce upload <file>` first. Done when you have a build, an exact device name, and an OS.
3. `bb sauce start <device> --os <os> --app <build>`. Done when it prints the session URL.
4. `bb sauce look` until the app shows its first screen (installs take 20-60 s, longer on iOS; `bb sauce wait changed --timeout 60s` between looks). Touches and text refuse with `not_ready` while Sauce is still installing. Open each PNG before deciding where to touch.
5. Drive the app with the loop below. Keep the PNG paths as evidence.
6. `bb sauce end`. Done when it reports `released: true`. End before reporting, and before switching devices.

## The loop: look, act, wait

- **Look:** `bb sauce look` saves an upright PNG and prints its `frame` id. Coordinates are fractions (0 to 1) of that image from its top-left corner. `changed: false` means the screen matches the previous look.
- **Act:** `bb sauce tap <x> <y>` or `bb sauce drag <x> <y> <to-x> <to-y>`. Pass `--frame <id>` so a touch aimed at an older picture fails with `stale_frame` instead of landing somewhere else.
- **Text and keys:** tap the field, then `bb sauce type "<text>" --wait changed --look`; the device shows the text a moment after the command returns. `bb sauce key enter|backspace|tab|escape` presses one key; `bb sauce key back` is Android's BACK button.
- **Wait for a condition, not a guessed time:** `--wait changed` returns once the screen differs from before the action; `--wait stable` once it holds still; `--wait "log:<regex>"` once the device log prints a matching new line. Use `changed` for slow loads, then `stable`.
- **One command per step:** `bb sauce tap 0.93 0.07 --frame 4 --wait changed --look` taps, waits, and prints the new look.
- **Fast looks for navigating:** `--fast` (on `look`, `tap`, `drag`, `type`, `key`) saves the page's picture of the device instead of Sauce's screenshot. It is smaller and quicker, and good enough to find the next button. Take a full look for evidence, and whenever a fast look comes back sideways.
- **Fixed sequences:** `bb sauce batch "tap 0.5 0.9" "wait changed --timeout 30s" "wait stable" "look"` runs steps in order and stops at the first failure. It prints only when the last step ends and saves the run to thread storage.
- **A wait that times out is a result (`timed_out: true`), not a failure.** An animated scene may never read as stable: look, and judge the picture.
- **A gesture result with `after_error` means the touch landed** and only the wait or look after it failed. Look again; do not repeat the touch.
- **Look again** after `bb sauce device rotate`, after the app launches or changes orientation, and whenever a touch seems to land mirrored. Taps refuse with `no_frame` until you do.

## Rules

- **One device for the whole machine:** never end or interrupt a session another thread or a person holds. Message the holder with `bb thread tell <thread> --mode steer`, or wait with `bb thread wait <thread>`.
- **Stay active:** Sauce ends a session after a few idle minutes. Plan the next steps before starting the device; keep long analysis for after `bb sauce end`.
- **Coordinates differ between devices:** read positions off the latest look; do not reuse them from another aspect ratio.
- **Only `bb sauce` touches the Sauce browser.** Never run `agent-browser` against it, not even to read: a command with other launch settings restarts the browser and closes the live session. A script that drives it directly also bypasses the lease.
- **Builds:** `bb sauce upload <file>` puts an `.apk` or `.ipa` in Sauce app storage; do not upload through a browser.
- **iOS** has no ADB shell; looks, touches, rotation, and the device log still work.
- **Evidence:** cite look and log paths from thread storage. Sauce's own session video and logs stay in the Sauce account under the session URL.

## Rampage notes

- The game runs landscape. Looks come back upright; `bb sauce` handles Sauce's sideways canvas.
- First launch: tap SKIP on the cinematic, tap the title screen, then accept the guest prompt. Matches start from the HQ DEPLOY table, then DEPLOY on the ops table.
- Joystick: drag from the stick's centre toward the direction with `--hold` for as long as the character should move.
- Unity logs reach the device log: `bb sauce log --grep "Unity|Exception"` searches all of it; `bb sauce log --new --grep "Exception"` shows only what the panel printed since your last check.
