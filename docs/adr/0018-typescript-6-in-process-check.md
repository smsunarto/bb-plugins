# bb-kit sits on TypeScript 6 and check parses in-process

Decided 2026-08-22. bb-kit moves from typescript 7.0.2 to 6.0.3: the
scaffold pins 6.0.3, the bb-kit-side workspace pins (root, bb-kit-core,
bb-kit-cli, dotfiles, notify) read `^6.0.0`, and `check` parses through
the TS6 JavaScript API — `require("typescript")` resolved from the
plugin's own node_modules — in the checker's own process. The tsconfig
parses once and must load: broken JSON or a config-level error (bad
`extends`, invalid option value, include matching nothing) fails check,
where the TS7 checker recovered best-effort. One program over the
tsconfig's files, with imports resolved, decides membership — a unit
file the include list omits but server.ts imports is still in the
project, matching the TS7 semantics. `noLib` and `types: []` keep the
default lib and @types out; only `getSyntacticDiagnostics` is read.

TS 7.0 ships no programmatic API: its `typescript/unstable/sync`
channel spawns the native compiler as a parser service, and Microsoft
says 7.1 will ship "a new (and different) API" (stable 2026-11-10).
The whole TS-API ecosystem meanwhile sits on 6.x — typescript-eslint
(peer `>=4.8.4 <6.1.0`), Angular's compiler-cli, ts-morph, prettier,
Volar, and the bb host itself, which pins
`npm:@typescript/typescript6` — so a TS7 pin blocked plugin authors
from typescript-eslint while buying check nothing. The TS6 API is also
in-process and bun-safe (verified empirically: zero child_process
calls, identical output under node and bun), which deleted the spawn
machinery, the hand-rolled TSNode typing layer, the `K` SyntaxKind
table, and bin.ts's bun refusal guard in one move.

Rejected: staying on 7.0.2 until 7.1 lands — months more of the spawn
machinery and the ecosystem block, and the 7.1 API rewrite is owed from
either starting point.

## Consequences

- The 7.1 API migration stays mandatory: 6.x's API is not 7.1's
  either, so this move defers that rewrite, it does not avoid it.
- 6.x is in maintenance mode — fixes only, no new language features.
- The never-run-check-under-bun rule dissolves; per ADR-0006, node
  stays the documented invocation.
- A tsconfig that fails to load now fails check — unparsable JSON, a
  broken `extends`, an invalid option value, or an include matching no
  files. TS7 silently recovered on all of these; `tsc -p` rejects them.
  Intentional tightening.
- Native tsc speed is lost only for DX typechecking
  (`scripts.typecheck`); plugins execute via Node type-stripping and
  never compile.
