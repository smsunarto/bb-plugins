# Pool Bar

CodexBar-style macOS menu bar meters for the accounts in bb's Account Pooler.

## What it does

- Adds one menu bar item per pooled provider (Codex, Claude): the brand mark and the percent left on the account the pool is using. Account Pooler does not report its active fallback, so this is the account with requests in flight, or else the one with the latest recorded use. The pool records use at most once a minute.
- Clicking an item opens a stacked card per account in priority order: the session, weekly, and per-model weekly limits, each with its reset countdown and a weekly pace line ("18% in reserve · Lasts until reset").
- The gray header above each card carries the pool's routing state: its position, `In use` with the requests in flight, `Last used` for the account the menu bar shows when nothing is in flight, and held, exhausted, or disabled.
- **Refresh** (⌘R) asks the pool to re-read every enabled account's usage. **Open bb** (⌘O) brings bb forward. **Quit** (⌘Q) hides the items until bb restarts or the plugin reloads.

## How it works

- The server reads `account.list` from the built-in `account-pool` plugin through `bb.sdk.plugins.callRpc` every 15 seconds and whenever a menu opens.
- A small AppKit helper, [`native/PoolBar.swift`](native/PoolBar.swift), draws the items. The plugin compiles it with `swiftc` on first start and caches the binary under `~/Library/Caches/bb-pool-bar/<source hash>/`.
- The helper talks to the server over stdin and stdout and exits when bb stops.

## Requirements

- macOS with the Xcode command line tools (`xcode-select --install`), for `swiftc`. On other platforms the plugin idles.
- The bb server must run on the Mac whose menu bar should show the items, as the desktop app's bundled server does.
- Account Pooler accounts. With none, no items appear.
