---
"@smsunarto/bb-plugin-agentation": patch
---

Vendor the patched upstream instead of relying on a Bun patch. `patchedDependencies`
is a workspace-install feature; a consumer installing the tag got the unpatched
package. The modified copy now lives at `vendor/agentation` with its changes
recorded in `vendor/agentation.patch` and its PolyForm Shield licence beside it.
