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
- **Two-finger input:** one finger only.
- **Keys and text:** there is no keyboard command. On Android, `bb sauce shell -- input keyevent <code>` sends a key (4 is BACK). `input text <text>` is untried: look afterwards to confirm it typed. Report text entry on iOS as a gap.

## Workflow

1. `bb sauce status`. Continue only on `ready`, `session_abandoned`, or `session_mine`. On `signed_out`, retry once with `--sign-in`. On any other state, wait or report it; the result's `next` says which.
2. `bb sauce apps`, then `bb sauce devices <model> --app <build>`. Done when you have a build, an exact device name, and an OS.
3. `bb sauce start <device> --os <os> --app <build>`. Done when it prints the session URL.
4. `bb sauce look` until the app shows its first screen (installs take 20-60 s; `bb sauce wait changed --timeout 60s` between looks). Open each PNG before deciding where to touch.
5. Drive the app with the loop below. Keep the PNG paths as evidence.
6. `bb sauce end`. Done when it reports `released: true`. End before reporting, and before switching devices.

## The loop: look, act, wait

- **Look:** `bb sauce look` saves an upright PNG and prints its `frame` id. Coordinates are fractions (0 to 1) of that image from its top-left corner. `changed: false` means the screen matches the previous look.
- **Act:** `bb sauce tap <x> <y>` or `bb sauce drag <x> <y> <to-x> <to-y>`. Pass `--frame <id>` so a touch aimed at an older picture fails with `stale_frame` instead of landing somewhere else.
- **Wait for a condition, not a guessed time:** `--wait stable` returns once the screen holds still; `--wait changed` returns once it differs from before the gesture. Use `changed` for slow loads, then `stable`.
- **One command per step:** `bb sauce tap 0.93 0.07 --frame 4 --wait stable --look` taps, waits, and prints the new look.
- **Fixed sequences:** `bb sauce batch "tap 0.5 0.9" "wait changed --timeout 30s" "wait stable" "look"` runs steps in order and stops at the first failure. It prints only when the last step ends and saves the run to thread storage.
- **A wait that times out is a result (`timed_out: true`), not a failure.** An animated scene may never read as stable: look, and judge the picture.
- **A gesture result with `after_error` means the touch landed** and only the wait or look after it failed. Look again; do not repeat the touch.
- **Look again** after `bb sauce device rotate`, after the app launches or changes orientation, and whenever a touch seems to land mirrored. Taps refuse with `no_frame` until you do.

## Rules

- **One device for the whole machine:** never end or interrupt a session another thread or a person holds. Message the holder with `bb thread tell <thread> --mode steer`, or wait with `bb thread wait <thread>`.
- **Stay active:** Sauce ends a session after a few idle minutes. Plan the next steps before starting the device; keep long analysis for after `bb sauce end`.
- **Coordinates differ between devices:** read positions off the latest look; do not reuse them from another aspect ratio.
- **Scripts go through `bb sauce` too.** A script that drives the Sauce browser directly bypasses the lease and can end another thread's session.
- **iOS** has no ADB shell; looks, touches, rotation, and the device log still work.
- **Evidence:** cite look and log paths from thread storage. Sauce's own session video and logs stay in the Sauce account under the session URL.

## Rampage notes

- The game runs landscape. Looks come back upright; `bb sauce` handles Sauce's sideways canvas.
- First launch: tap SKIP on the cinematic, tap the title screen, then accept the guest prompt. Matches start from the HQ DEPLOY table, then DEPLOY on the ops table.
- Joystick: drag from the stick's centre toward the direction with `--hold` for as long as the character should move.
- Unity logs reach the device log: `bb sauce log --grep "Unity|Exception"`.
