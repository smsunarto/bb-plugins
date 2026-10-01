# Pool Bar

CodexBar-style macOS menu bar meters for your Codex and Claude accounts. It reads the accounts in bb's Account Pooler. Without the pool, it reads the account each CLI is signed in to.

## What it does

- Adds one menu bar item per provider (Codex, Claude): the brand mark and the percent left on the account in use. Account Pooler does not report its active fallback, so this is the account with requests in flight, or else the one with the latest recorded use. The pool records use at most once a minute.
- Clicking an item opens a stacked card per account in priority order: the session, weekly, and per-model weekly limits, each with its reset countdown and a weekly pace line ("18% in reserve · Lasts until reset").
- **Limit Reset Credits** lists unused free limit resets and when each expires, for Codex and for Claude grants exposed by OAuth. Claude can hide full resets from Claude Code (`ineligible_reason: "surface"`) while showing them in desktop or web. In that case, **Check Claude for full resets** opens Claude’s usage page. No reset is redeemed by this plugin.
- **Extra usage** shows the Codex credit balance, or Claude's spend against its monthly cap.
- The gray header above each card carries the pool's routing state: its position, `In use` with the requests in flight, `Last used` for the account the menu bar shows when nothing is in flight, and held, exhausted, or disabled.
- **Refresh** (⌘R) re-reads every enabled account's usage and extras. **Open bb** (⌘O) brings bb forward. **Quit** (⌘Q) hides the items until bb restarts or the plugin reloads.

## Where the data comes from

- **Quota:** `account.list` from the `account-pool` plugin through `bb.sdk.plugins.callRpc`, every 15 seconds and whenever a menu opens.
- **Fallback quota:** when Account Pooler is not loaded or holds no accounts, the `provider-usage.v1` resources of bb's built-in Codex and Claude providers on this Mac. Collections, including failures, are cached for 5 minutes. Refresh bypasses that cache. Extras are matched by provider-issued account identity, including workspace identity.
- **Reset credits and extra usage:** the provider endpoints CodexBar uses, at most every 5 minutes, plus on Refresh.
  - Pool accounts use the pool's stored access token. This reads Account Pooler's private secret files under `<bb data dir>/plugins/account-pool/secrets/`. If that layout changes, these sections disappear while quota keeps working.
  - In fallback mode, the CLI's own credentials: `~/.codex/auth.json`, and Claude Code's keychain item or `~/.claude/.credentials.json`. macOS may ask once to allow keychain access.
  - Tokens are only read, never refreshed. An expired token hides the sections until its owner refreshes it.

## How it works

- A small AppKit helper, [`native/PoolBar.swift`](native/PoolBar.swift), draws the items. The plugin compiles it with `swiftc` on first start and caches the binary under `~/Library/Caches/bb-pool-bar/<source hash>/`.
- The helper talks to the server over stdin and stdout and exits when bb stops.
- Only the bb instance using `~/.bb` draws items, so dev instances do not add duplicates. Set `BB_POOL_BAR_ANY_INSTANCE=1` on a dev server to draw from it anyway.

## Requirements

- macOS with the Xcode command line tools (`xcode-select --install`), for `swiftc`. On other platforms the plugin idles.
- The bb server must run on the Mac whose menu bar should show the items, as the desktop app's bundled server does.
- Account Pooler accounts, or a signed-in Codex or Claude Code CLI. With neither, no items appear.
