---
name: sauce-live
description: Test an app on Sauce Labs real devices through the sauce_* tools. Use for Sauce Live device checks, mobile bug hunts, and on-device verification of mobile builds.
---

# Sauce Live real-device testing

The `sauce_*` tools drive Sauce Labs Live in a shared, signed-in browser on the bb server machine. The account is a Live Testing plan with one live-device slot: Appium, saucectl, and the Real Device Access API are rejected, so these tools are the supported route.

## Workflow

1. `sauce_status`. Continue only on `ready`, `session_abandoned`, or `session_mine`. On `signed_out`, retry once with `sign_in: true`. On any other state, wait or report it; the result's `next` says which.
2. `sauce_catalog` with `kind: "apps"`, then `kind: "devices"` with a model query. Done when you have an exact device name and OS.
3. `sauce_start`. Done when it returns the session URL.
4. `sauce_screenshot` until the app shows its first screen (installs take 20-60 s). Open each PNG before deciding where to touch.
5. Drive the app with `sauce_touch` and `sauce_device`. Screenshot after each meaningful step; keep the PNG paths as evidence.
6. `sauce_end`. Done when it reports `released: true`. End before reporting, and before switching devices.

## Rules

- **One device for the whole machine:** never end or interrupt a session another thread or a person holds. Message the holder with `bb thread tell <thread> --mode steer`, or wait with `bb thread wait <thread>`.
- **Stay active:** Sauce ends a session after a few idle minutes. Plan the next steps before starting the device; keep long analysis for after `sauce_end`.
- **Coordinates** are fractions of the latest screenshot. Read positions off that image; layouts differ between aspect ratios, so do not reuse coordinates from another device.
- **One finger:** gestures needing two simultaneous touches cannot be tested; report that coverage gap rather than guessing.
- **iOS** has no ADB shell; screenshots, touch, rotation, and the device log still work.
- **Evidence:** cite screenshot and log paths from thread storage. Sauce's own session video and logs stay in the Sauce account under the session URL.

## Rampage notes

- The game runs landscape. Screenshots come back upright; the tools handle Sauce's sideways canvas.
- First launch: tap SKIP on the cinematic, tap the title screen, then accept the guest prompt. Matches start from the HQ DEPLOY table, then DEPLOY on the ops table.
- Unity logs reach the device log: `sauce_device` with `action: "log"` and `grep: "Unity|Exception"`.
