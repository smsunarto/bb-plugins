---
"@smsunarto/bb-plugin-gtd-sidebar": minor
---

Rename the plugin from t3sidebar to GTD Sidebar, id `gtd-sidebar`.

bb keys a plugin by the id it derives from the package name, so this installs as
a separate plugin rather than an update: install `gtd-sidebar`, then uninstall
`t3sidebar`. Settled and snoozed shelves live in the old plugin's database and
do not carry over. Releases are now tagged `gtd-sidebar/vX.Y.Z`.

The warm-start cache moves to `gtd-sidebar:v1:*` in `localStorage`, and the
first successful write removes the `t3sidebar:v1:*` entries — bb's uninstall
does not clear web storage, and after the rename nothing else ever would.
