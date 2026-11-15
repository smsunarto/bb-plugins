# Sauce Live

Drive Sauce Labs real devices from bb threads with `bb sauce`.

The plugin runs Sauce Labs Live through a signed-in Chrome profile on the bb server machine (`~/.agent-browser/profiles/sauce-live`, driven by `agent-browser`). The account has one live-device slot, so the device is leased to one thread at a time.

```sh
bb sauce status
bb sauce upload ./build.apk
bb sauce apps
bb sauce devices "Galaxy S23"
bb sauce start "Samsung Galaxy S23" --os "Android 16"
bb sauce look
bb sauce tap 0.93 0.07 --wait changed --look
bb sauce type "hello" --fast
bb sauce key enter
bb sauce wait "log:Exception" --timeout 30s
bb sauce batch "drag 0.5 0.8 0.5 0.2" "wait stable" "look"
bb sauce end
```

Run `bb sauce --help` for every command. The `sauce-live` skill holds the workflow agents follow.

## Requirements

- `agent-browser` on the bb server's `PATH`.
- A Chrome profile signed in to Sauce Labs at `~/.agent-browser/profiles/sauce-live` (override with `SAUCE_LIVE_PROFILE`).

## The shared browser

The browser daemon runs in agent-browser's `bb-sauce` namespace, so `agent-browser` commands run by hand cannot reach it. To inspect it, set `AGENT_BROWSER_NAMESPACE=bb-sauce` and the same `AGENT_BROWSER_PROFILE`, `AGENT_BROWSER_CONFIG`, and `AGENT_BROWSER_HEADED` values the plugin uses (`src/server/browser.ts`), and only while no thread holds the device: a command with other launch settings restarts the browser and closes the live session.
