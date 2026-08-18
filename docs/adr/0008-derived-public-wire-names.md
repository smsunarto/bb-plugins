# RPC wire names are derived at define time, unlocked, and public

Decided 2026-08-17. A procedure's wire method is derived, never written by
hand: `snake(namespace)_snake(key)`, where the router namespace must equal
the plugin id. There is no lock file and no generated catalog.

The derivation is not a private implementation detail. bb serves every
registered method at `POST /api/v1/plugins/<id>/rpc/<method>` behind
local-origin checks only (no token, no session), ships cross-plugin
`bb.sdk.plugins.callRpc`, and bb's own desktop app hardcodes another
plugin's wire names. Wire names are therefore public API: renaming a
namespace or a procedure key is a breaking change and is documented like one.

Both prior positions were wrong ends of the same trade-off: bb-kit 0.1 held
renames in a project lock (ceremony on every rename), and the reconsider
branch treated the surface as sealed (refuted by the host's own endpoints).
One sentence of doctrine replaces both.

## Consequences

- Nothing to commit, regenerate, or keep in sync; the derivation exists
  once, at runtime, and `bb-kit check` prints the derived wire-name table
  (there is no type-level `SnakeCase` mirror to keep in agreement).
- Changelogs must flag wire renames as breaking even when the TypeScript
  surface is unchanged.
- An author who can attest that nothing outside the plugin calls a method may
  rename it freely (frontend and server reload atomically as one bundle);
  that attestation is the author's, and no tool tries to verify it.
