---
name: account-pool-plus
description: "Configure or diagnose Account Pooler+ accounts (Claude, Codex, and Antigravity Gemini OAuth profiles), authentication, quota routing, and failover through bb pool."
---

# Account Pooler+

Use `bb pool` for this plugin's accounts and routes. Inspect current state with
`bb pool status --json` and `bb pool account list --json` before changing routing.
Use `bb pool --help` for available commands.

- **Claude & Codex:** Server-side HTTP proxy hub routing (`claude-code` and `codex`).
- **Antigravity (Gemini quota):** Isolated native `agy` Google OAuth profiles on each checkout host (`bb pool account add --provider antigravity --login [--host <id-or-name>]`), completed via `bb pool account login-complete --session <id> --code-stdin`.

For account sign-in and re-login, secret handling, quota refresh, routing settings,
ordering, or failover, read
[references/accounts-and-routing.md](references/accounts-and-routing.md).

Use stdin or the supported sign-in flows for credentials; never put secret values
in command arguments or chat. Confirm the resulting account and routing state.
Do not enable the plugin or change accounts unless the requested task calls for it.

Pooled rate-limit failures can be retried by Provider Retry using the pool’s
earliest usable account, even if the provider omits structured quota events.
Inspect `bb provider-retry explain <thread-id> --json` for the last decision
and `bb provider-retry status <thread-id> --json` for pending retries.
