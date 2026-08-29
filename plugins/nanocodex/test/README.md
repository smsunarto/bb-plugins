# Test layers

Five layers, cheapest first. Each one exists because the layer below it cannot
see the failure it catches.

| file | layer | what only it catches |
|---|---|---|
| `prompt.test.ts`, `continuity.test.ts` | pure unit | the continuity policy: tiering, elision, byte budget, the fold's idempotence by ordinal, a truncated trailing line, compaction shadowing, a checkpoint slice. No process, no file for `prompt`. |
| `events.test.ts` | pure unit | schemas against lines copied verbatim from `hello.jsonl` and `tool-run.jsonl` — which together carry the code-mode string-`arguments` case, the `<parent>/code-N` ids, the content-block result body, and BOTH usage shapes. |
| `stream.test.ts` | assembled | drives `handleLine` and asserts the `ThreadEvent`s that come out of `experimental_createDeltaAssembler` — the REAL runtime assembler, with its 500 ms progress throttle and 100 ms text flush. Two turns in one session assert no item id repeats, which is the trap `session/resume-id-uniqueness` would otherwise find in production. |
| `conformance.test.ts` | end-to-end, in process | the 19 canonical scenarios against a real spawned fake CLI. |
| `parity.test.ts` | replay | that a refactor did not change a byte on the wire. Needs a custom `ReplayProviderProfile` — `DEFAULT_REPLAY_PROFILE` is for bridges with no provider child, and this one spawns a real child per turn, so the profile substitutes the recorded `provider->bridge` lane for the CLI. amp has a working example to crib. Skips when `test/recordings/nanocodex/` is absent; refreshed by hand with `BB_PROVIDER_BRIDGE_RECORD_DIR`. |
| `declaration.test.ts` | static | `validatePluginProviderDeclaration`, plus the pairs nothing else keeps honest: declaration `fork` vs handshake `fork` (the handshake may narrow, never widen), `permissionModes: ["full"]` vs `approvalEnforcedBy: "provider"`, `reasoningLevels` vs the `--thinking` mapping, and the declaration's model fallback vs the bridge's `model/list` answer. |
| `public-sdk-scan.test.ts` | static | `experimental_scanPublicSdkOnly` — the bridge imports only `@get-bb/plugin-sdk`, `zod`, and node builtins. |

The parity recordings are the only artifact that needs a real account.
Everything above them runs on a laptop with no network.
