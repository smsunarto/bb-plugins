# Sauce Live

Drive Sauce Labs real devices from bb threads with `bb sauce`.

The plugin runs Sauce Labs Live through a signed-in Chrome profile on the bb server machine (`~/.agent-browser/profiles/sauce-live`, driven by `agent-browser`). The account has one live-device slot, so the device is leased to one thread at a time.

```sh
bb sauce status
bb sauce apps
bb sauce devices "Galaxy S23"
bb sauce start "Samsung Galaxy S23" --os "Android 16"
bb sauce look
bb sauce tap 0.93 0.07 --wait stable --look
bb sauce batch "drag 0.5 0.8 0.5 0.2" "wait stable" "look"
bb sauce end
```

Run `bb sauce --help` for every command. The `sauce-live` skill holds the workflow agents follow.

## Requirements

- `agent-browser` on the bb server's `PATH`.
- A Chrome profile signed in to Sauce Labs at `~/.agent-browser/profiles/sauce-live` (override with `SAUCE_LIVE_PROFILE`).
