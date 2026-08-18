---
"@smsunarto/bb-plugin-amp": patch
---

Ship the ACP bridge in the tag. bb runs no lifecycle script for a git install,
so the sidecar it never compiles — `dist/bridge.js` and the CLI shim — has to be
committed rather than built on the consumer's machine. CI diffs both against a
fresh build so they cannot go stale.

Align `zod` with the plugin SDK's peer range, which the bridge shares.
