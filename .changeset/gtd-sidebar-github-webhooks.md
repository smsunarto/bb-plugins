---
"@smsunarto/bb-plugin-gtd-sidebar": minor
---

Accept signed GitHub webhooks to update PR badge colours in realtime. A **GitHub webhooks via Cloudflare** setting checks for `cloudflared` and opens a trycloudflare tunnel to a webhook-only local port (not the bb API). Hydrate on mount, reconcile every 10 minutes, and skip hook registration on session-gated bb connect URLs. The hourly snooze watch stays as a backup.
