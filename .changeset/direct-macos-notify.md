---
"@smsunarto/bb-plugin-notify": minor
---

Replace the window bridge, HTTP routes, durable queue, leases, polling, and
replay with one direct macOS Notification Center call from the plugin server.
Notifications work after `Cmd+W` while BB and its owned server remain open.
Native alerts are no longer attributed to BB and no longer open a thread when
clicked. `status` now reports settings instead of window and queue state.
