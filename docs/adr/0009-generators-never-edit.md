# Generators never edit existing files; check enforces the wiring

Decided 2026-08-17. Never-edit generators, an explicit typed composition
root, and zero manual wiring cannot coexist — pick two. bb-kit keeps the
first two: `bb-kit add` writes new files only and prints the exact wiring
lines (the import and the router key) for the author or agent to paste into
`server.ts`; `bb-kit check` fails until the wiring exists.

`check`'s scope is composition wiring (the router matches the `rpc/` files,
procedures are statically discoverable, no duplicate wire methods, namespace
equals the plugin id) plus manifest sanity (entry targets exist and do not
point at build output, engines pins are well-formed). Workspace policy —
license, files allowlists, canonical scripts, dependency-presence rules — is
the consuming repo's business, not the framework's. One deliberate
exception: `check` warns (never fails) on a missing sibling test, because
the one-file-one-test layout is the framework's own (ADR-0007), not
workspace policy.

Rejected: guarded AST edits (ts-morph editing `server.ts`, refusing
unrecognized composition roots). The refusal path is the fragility — the
moment a plugin grows past the recognizer, the tool breaks on exactly the
plugins that need it most.

## Consequences

- `server.ts` is written only by its author; there is no tool-ownership
  boundary inside a user file.
- "Forgot to wire it" cannot ship, but it is a check failure, not an
  unrepresentable state — the one place ADR-0002's preference is traded away
  for never-edit.
- No ts-morph or jsonc-parser machinery in the published package.
