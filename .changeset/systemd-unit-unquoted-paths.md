---
"@smsunarto/bb-plugin-agent-proxy": patch
---

Emit `WorkingDirectory=`, `StandardOutput=`, and `StandardError=` unquoted in the generated systemd user unit. systemd rejects a quoted `WorkingDirectory=` as a fatal unit error, so the core service never loaded on Linux, and quoted output directives silently sent core logs to the journal instead of `core.log`.
