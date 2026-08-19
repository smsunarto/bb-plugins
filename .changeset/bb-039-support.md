---
"@smsunarto/bb-plugin-agent-proxy": patch
"@smsunarto/bb-plugin-agentation": patch
"@smsunarto/bb-plugin-amp": patch
"@smsunarto/bb-plugin-gh-stack": patch
"@smsunarto/bb-plugin-gtd-sidebar": patch
"@smsunarto/bb-plugin-monokai": patch
"@smsunarto/bb-plugin-notify": patch
---

Support bb 0.39. The engines range is no longer pinned to one minor: it now floors at the tested bb release and excludes only the next major (`>=0.39.0 <1.0.0`), so future bb minors load without a plugin update. Built against plugin SDK 0.4.8.
