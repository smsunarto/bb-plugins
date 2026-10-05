# Usage Bar

CodexBar-style macOS menu bar meters for your Codex and Claude accounts. It reads the accounts in bb's Account Pooler. Without the pool, it reads the account each CLI is signed in to.

## What it does

- Adds one menu bar item per provider (Codex, Claude): the brand mark and the lowest percent left across the shared session and weekly limits of the account in use, so the number tracks the limit that runs out first. Its tooltip names that limit. Per-model weekly limits only divert that model's requests, so they show on the card, not in the menu bar. Account Pooler does not report its active fallback, so the account in use is the one with requests in flight, or else the one with the latest recorded use. The pool records use at most once a minute.
- Clicking an item opens a stacked card per account in priority order. Each card has the account's email and plan, when it was last read, and its routing state: `In use` with the requests in flight, or `Last used`, in the accent color, and held, exhausted, or disabled.
- Below that come the session, weekly, and per-model weekly limits, each with its reset countdown and a pace line ("18% in reserve", or "6% in deficit · Runs out in 14h 3m"). A limit that is still full shows only its bar. A limit whose reset has passed reads full until the pool reads it again.
- **Limit resets** counts unused free limit resets and shows when the next one expires. Hover for every expiry. This covers Codex and Claude. When Claude Code OAuth omits full resets, an installed CodexBar CLI reads the Claude web session. If that fallback is unavailable, the menu's **Check Claude for full resets** item opens Claude’s usage page. No reset is redeemed by this plugin.
- **Extra usage** shows the Codex credit balance, or what is left of Claude's monthly extra usage cap.
- **Refresh** (⌘R) re-reads every enabled account's usage and extras. **Open bb** (⌘O) brings bb forward. **Quit Usage Bar** (⌘Q) hides the items until bb restarts or the plugin reloads.
  Refresh waits for its fresh results even when a background read is already running. Account changes discard observations from the previous configuration. Disabled accounts do not fetch extras.
- An open menu keeps updating: countdowns tick, and cards resize as new readings arrive.

## Where the data comes from

- **Quota:** `account.list` from the `account-pool` plugin through `bb.sdk.plugins.callRpc`, every 15 seconds and whenever a menu opens.
- **Fallback quota:** when Account Pooler is not loaded or holds no accounts, the `provider-usage.v1` resources of bb's built-in Codex and Claude providers on this Mac. Collections, including failures, are cached for 5 minutes. Refresh bypasses that cache. Extras are matched by provider-issued account identity, including workspace identity.
  A failed resource does not hide healthy accounts. If the whole source fails, the menu keeps its last quota snapshot and says it could not refresh.
- **Reset credits and extra usage:** the provider endpoints CodexBar uses, at most every 5 minutes, plus on Refresh.
  - Pool accounts use the pool's stored access token. This reads Account Pooler's private secret files under `<bb data dir>/plugins/account-pool/secrets/`. If that layout changes, these sections disappear while quota keeps working.
  - In fallback mode, the CLI's own credentials: `~/.codex/auth.json`, and Claude Code's keychain item or `~/.claude/.credentials.json`. macOS may ask once to allow keychain access.
  - Tokens are only read, never refreshed. An expired token hides the sections until its owner refreshes it.
  - **Claude web resets:** optional `/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI`, using `usage --provider claude --source web --json`. CodexBar handles browser cookies. Usage Bar receives only usage JSON and retains the reset count, expiry text, and email for matching. A web email must uniquely match a Claude pool account, including disabled accounts. Duplicate emails across organizations are ambiguous and receive no web result. Built-in fallback requires a successful usage measurement with an account key and email. Web observations and failures are cached for 5 minutes, Refresh bypasses the cache, and the native menu hides stale web observations. The CLI exposes formatted expiry text rather than exact expiry timestamps.

## How it works

- A small AppKit helper, [`native/UsageBar.swift`](native/UsageBar.swift), draws the items. The plugin compiles it with `swiftc` on first start and caches the binary under `~/Library/Caches/bb-usage-bar/<source hash>/`.
- The helper talks to the server over stdin and stdout and exits when bb stops.
- Only the bb instance using `~/.bb` draws items, so dev instances do not add duplicates. Set `BB_USAGE_BAR_ANY_INSTANCE=1` on a dev server to draw from it anyway.

## Requirements

- macOS 13 or later with the Xcode command line tools (`xcode-select --install`), for `swiftc`. Without them, bb lists Usage Bar as needing configuration. On other platforms the plugin idles.
- The bb server must run on the Mac whose menu bar should show the items, as the desktop app's bundled server does.
- Account Pooler accounts, or a signed-in Codex or Claude Code CLI. With neither, no items appear.
