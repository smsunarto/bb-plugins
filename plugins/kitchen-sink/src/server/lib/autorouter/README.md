# Autorouter

This checkpoint contains the routing policy, validated project index, editable
settings, user-only `/index-projects` skill, and persisted composer toggle.
**The inference transport and composer submit integration are not connected yet.**
The toggle currently saves the setting only. Do not ship or reload this checkpoint
into live BB as a working autorouter.

The remaining integration needs a supported BB SDK surface that can asynchronously
transform a composer's project and execution selection before submission. SDK
0.4.48 exposes read-only draft observation and scheduled submission, but no such
transformation. Its backend `message.dispatch` hook deliberately cannot amend the
execution tuple. Changes to BB core or a workaround need the user's approval under
this repository's AGENTS.md.

The router must invoke Codex with `gpt-5.6-luna`, reasoning `medium`, exactly once
per submitted prompt, returning both decisions as structured JSON. BB's existing
helper inference contract only accepts reasoning `none`, so it also needs a
supported path for the requested effort. `routePrompt` accepts an inference
adapter to keep this policy independent of that pending SDK decision.

Model IDs and effort sets were checked against the live BB provider catalogs on
2026-09-09. Before applying a decision, the integration must populate
`availableRouteIds` from the destination host's current catalog. Never invent a
provider/model pair or silently replace an unavailable configured fallback.

Project routing compares explicit user instructions first, then the stored index.
Low project confidence keeps the current project. Low model confidence, malformed
output, or inference failure selects the configured fallback. The decisions are
independent. Known project IDs and allowed model/effort pairs are validated before
they leave the policy layer.

Settings have one persistence owner: `bb.settings`. The native plugin settings UI,
composer toggle, and indexing RPC all write through that owner. The index includes
unregistered repositories with `projectId: null` and distinguishes host/path pairs.
