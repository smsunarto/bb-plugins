# Usage Bar

CodexBar-style macOS menu bar meters for your Codex, Claude, and Antigravity accounts. It reads the Codex and Claude accounts in bb's Account Pooler. Without the pool, it reads the account each CLI is signed in to. Antigravity quota comes from the signed-in `agy` CLI.

## What it does

- Adds one menu bar item per provider (Codex, Claude, Antigravity): the brand mark and the lowest percent left across the shared session and weekly limits of the account in use (Claude has no session limit, so only its weekly limit counts), so the number tracks the limit that runs out first. Its tooltip names that limit. Per-model weekly limits only divert that model's requests, so they show on the card, not in the menu bar. Account Pooler does not report its active fallback, so the account in use is the one with requests in flight, or else the one with the latest recorded use. The pool records use at most once a minute.
- Clicking an item opens a stacked card per account in priority order. Each card has the account's email and plan, when it was last read, and its routing state: `In use` with the requests in flight, or `Last used`, in the accent color, and held, exhausted, or disabled.
- Antigravity has one card for the account the `agy` CLI is signed in to, with a session and a weekly limit for each model group the CLI reports, such as Gemini and Claude/GPT. Its menu bar number is the lowest percent left across all of them. The CLI reports neither the account's email nor its plan, so the card shows neither, and it has no limit resets or extra usage.
- Below that come the session (Codex only), weekly, and per-model weekly limits, each with its reset countdown and a pace line ("18% in reserve", or "6% in deficit · Runs out in 14h 3m"). A limit that is still full shows only its bar. A limit whose reset has passed reads full until the pool reads it again.
- **Limit resets** counts unused free limit resets and shows when the next one expires. Hover for every expiry. This covers Codex and Claude. When Claude Code OAuth omits full resets, an installed CodexBar CLI reads the Claude web session. If that fallback is unavailable, the menu's **Check Claude for full resets** item opens Claude’s usage page. No reset is redeemed by this plugin.
- **Extra usage** shows the Codex credit balance, or what is left of Claude's monthly extra usage cap.
- **Refresh** (⌘R) re-reads every enabled account's usage and extras. **Open bb** (⌘O) brings bb forward. **Quit Usage Bar** (⌘Q) hides the items until bb restarts or the plugin reloads.
  Refresh waits for its fresh results even when a background read is already running. Account changes discard observations from the previous configuration. Disabled accounts do not fetch extras.
- An open menu keeps updating: countdowns tick, and cards resize as new readings arrive.

## Where the data comes from

- **Quota:** `account.list` from the `account-pool` plugin through `bb.sdk.plugins.callRpc`, every 15 seconds and whenever a menu opens.
- **Fallback quota:** when Account Pooler is not loaded or holds no accounts, the `provider-usage.v1` resources of bb's built-in Codex and Claude providers on this Mac. Collections, including failures, are cached for 5 minutes. Refresh bypasses that cache. Extras are matched by provider-issued account identity, including workspace identity.
  A failed resource does not hide healthy accounts. If the whole source fails, the menu keeps its last quota snapshot and says it could not refresh.
- **Antigravity quota:** `agy -p /usage --output-format json --log-file /dev/null` on the machine running the bb server, the same `agy` bb's Antigravity agent runs. It is found on bb's tool path, which includes `~/.local/bin`.
  - Since agy 1.1.11 this answers from the CLI without starting an agent turn, spending quota, or leaving a conversation. Usage Bar runs `agy --version` before each read and asks only agy 1.1.12 or later; an older CLI would send `/usage` to the model as a prompt.
  - If a run ever reports a turn, a conversation, or a command other than `usage`, Usage Bar stops asking until the plugin reloads.
  - At most every 5 minutes, failures included, plus on Refresh, and only while a Mac that can draw the menu is connected. A poll answers from the last reading and the new one is drawn when it lands. Antigravity is read apart from Codex and Claude, and refreshes alongside them, so a slow CLI never delays them and their failure never hides it. Each run gets 30 seconds, then SIGTERM, then SIGKILL a second later. Refresh waits at most 15 seconds for it; a later answer is drawn when it lands.
  - After `agy` answers that it is missing or signed out, background checks wait 10, 20 and 40 minutes, then an hour. Refresh always checks, so after signing in, press Refresh.
  - The CLI reads its own sign-in from the system keyring; Usage Bar never sees a token. Like any `agy` start, a run may refresh the CLI's own access token. It rewrites agy's `~/.gemini/antigravity-cli/cache/onboarding.json` and opens its conversation index. Usage Bar lets agy keep its own state this way, as any agy session does.
  - Usage Bar never lets agy update itself: every run sets `AGY_CLI_DISABLE_AUTO_UPDATE=true`, and agy logs "Auto-update disabled via environment variable" instead of updating. agy reads only `true`; with `1` it still updates.
  - Runs get the server's home, locale, temporary, XDG, D-Bus, proxy, certificate, `AGY_*`, `GEMINI_*` and `GOOGLE_*` variables only, and `/usage` runs in its private temporary directory. `SSH_*` would make agy skip the keyring, so it is never passed, and neither is `BROWSER`.
  - Without `agy`, with a CLI older than 1.1.12, or signed in with a `GEMINI_API_KEY` (no account quota), no Antigravity item appears. A signed-out CLI opens a browser sign-in page with `open` (macOS) or `xdg-open` (Linux), then waits. Each run puts no-op openers first on `PATH`, from a private temporary directory it deletes afterwards, so no tab opens; Usage Bar stops the CLI at its sign-in prompt, discards the URL, and shows no item. A run that fails or times out keeps the last reading, dimmed, with "Couldn't refresh Antigravity. Showing the last reading." above its card.
- **Reset credits and extra usage:** the provider endpoints CodexBar uses, at most every 5 minutes, plus on Refresh.
  - Pool accounts use the pool's stored access token. This reads Account Pooler's private secret files under `<bb data dir>/plugins/account-pool/secrets/`. If that layout changes, these sections disappear while quota keeps working.
  - In fallback mode, the CLI's own credentials: `~/.codex/auth.json`, and Claude Code's keychain item or `~/.claude/.credentials.json`. macOS may ask once to allow keychain access.
  - Tokens are only read, never refreshed. An expired token hides the sections until its owner refreshes it.
  - **Claude web resets:** optional `/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI`, using `usage --provider claude --source web --json`. CodexBar handles browser cookies. Usage Bar receives only usage JSON and retains the reset count, expiry text, and email for matching. A web email must uniquely match a Claude pool account, including disabled accounts. Duplicate emails across organizations are ambiguous and receive no web result. Built-in fallback requires a successful usage measurement with an account key and email. Web observations and failures are cached for 5 minutes, Refresh bypasses the cache, and the native menu hides stale web observations. The CLI exposes formatted expiry text rather than exact expiry timestamps.

## How it works

- The server reads quota and pushes the menu to every connected bb host. On each Mac, the plugin's host entry draws it. Other hosts decline. So the items appear on the Mac you use, even when the bb server runs on another machine.
- A small AppKit helper, [`native/UsageBar.swift`](native/UsageBar.swift), draws the items. The host entry compiles it with `swiftc` on first start and caches the binary under `~/Library/Caches/bb-usage-bar/<source hash>/`.
- The helper talks to the host entry over stdin and stdout and exits when bb stops.
- One helper runs per Mac. When two bb servers reach the same Mac, the first helper keeps the menu bar and the second waits.
- Dev bb instances (data directories under `~/.bb-dev`) do not draw items. Set `BB_USAGE_BAR_ANY_INSTANCE=1` on a dev server to draw from it anyway.

## Requirements

- macOS 13 or later with the Xcode command line tools (`xcode-select --install`), for `swiftc`. Without them, bb lists Usage Bar as needing configuration. On other platforms the plugin idles.
- The Mac must be connected to bb as a host, as the desktop app's own Mac is. Fallback credentials and the CodexBar CLI are read on the machine running the bb server.
- Account Pooler accounts, or a signed-in Codex or Claude Code CLI. With neither, no Codex or Claude items appear.
- For Antigravity, `agy` 1.1.12 or later, signed in with a Google account, on the machine running the bb server.
