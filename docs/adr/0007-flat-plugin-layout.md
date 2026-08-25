# A plugin is a flat package: one directory per concern, one file per unit

Decided 2026-08-17. The package root is the plugin root — no `src/`, no
`plugin/` nesting. Concerns live in fixed directories (there is no
collective term of art for them; "slot" was considered and retired as
unintuitive):

- `server/` — interned collaborators, domain modules, the composition
  root `server/server.ts`, and the unit directories `rpc/` and `cli/`
  beside it
- `app/` — everything browser-bound; the app entry is `app/app.tsx`
- `server/server.ts` — the shallow composition root, the only file that
  wires them together

A directory a plugin does not use is absent, not scaffolded empty. A
themes-only plugin is a manifest plus `themes/`.

The reconsider branch prototyped this layout and the dotfiles exemplar proved
it. The branch left one divergence — its spec text put `app.tsx` at the
package root while its exemplar nested the app — resolved here in favour
of `app/`. The same nesting applies to the server: `bb.server` is
`./server/server.ts`, matching `bb.app` at `./app/app.tsx`. The package
root stays free of TypeScript so "does this import reach the browser
bundle" is answerable from the path alone.

## Consequences

- The manifest points `bb.server` at `./server/server.ts` and `bb.app` at
  `./app/app.tsx`. Panel files and shared components live inside `app/`.
  Interned collaborators live beside the composition root in `server/`.
- One file per procedure and command is what makes `bb-kit check`'s
  composition diagnostics (router ↔ unit files beside `bb.server` match)
  statically checkable.
- All nine plugins in this repo converge on this tree as they migrate.
