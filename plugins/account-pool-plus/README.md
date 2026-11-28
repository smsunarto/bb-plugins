# Account Pooler+ (`account-pool-plus`)

Full fork of BB's built-in Account Pooler with **Claude**, **Codex**, and **Antigravity (Gemini OAuth profile)** pooling.

## How each provider pools accounts

- **Claude & Codex:** Server-side HTTP proxy hub mounted at `/api/v1/plugins/account-pool-plus/http`, contributing machine-scoped hub env vars to `claude-code` and `codex`.
- **Antigravity (Gemini quota):** Isolated native `agy` OAuth profiles stored per account on the checkout host under `~/.bb-plugins/account-pool-plus/antigravity-profiles/<accountId>/.gemini/antigravity-cli`. Accounts sign in via native `agy acp --login`, Gemini 5-hour/weekly quotas are polled via `agy -p /usage`, and sessions route through `BB_ANTIGRAVITY_GEMINI_DIR` + `BB_ANTIGRAVITY_APP_DATA_DIR` + `BB_ANTIGRAVITY_DISABLE_KEYRING=1` (preserving real `$HOME`).

## Replacing `builtin:account-pool`

BB reserves plugin ID `account-pool` for `builtin:account-pool`. Disable `builtin:account-pool` before enabling `account-pool-plus` so `bb pool` CLI commands and `claude-code`/`codex` env contributions do not collide.
