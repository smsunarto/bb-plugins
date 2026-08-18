# A plugin is a flat package: one directory per concern, one file per unit

Decided 2026-08-17. The package root is the plugin root — no `src/`, no
`plugin/` nesting. Concerns live in fixed directories (there is no
collective term of art for them; "slot" was considered and retired as
unintuitive):

- `rpc/` — one procedure per file, with a sibling `<name>.test.ts`
- `cli/` — one command per file, with a sibling test
- `server/` — optional; context assembly, repositories, domain modules
- `ui/` — everything browser-bound; the app entry is `ui/app.tsx`
- `server.ts` — the shallow composition root, the only file that wires
  them together

A directory a plugin does not use is absent, not scaffolded empty. A
themes-only plugin is a manifest plus `themes/`.

The reconsider branch prototyped this layout and the dotfiles exemplar proved
it. The branch left one divergence — its spec text put `app.tsx` at the
package root while its exemplar used `ui/app.tsx` — resolved here
deliberately in favour of `ui/`: the root stays server-only, so "does this
import reach the browser bundle" is answerable from the path alone.

## Consequences

- The manifest points `bb.app` at `./ui/app.tsx`; `panel.tsx` and shared
  components live inside `ui/`.
- One file per procedure and command is what makes `bb-kit check`'s
  composition diagnostics (router ↔ `rpc/` files match) statically checkable.
- All nine plugins in this repo converge on this tree as they migrate.
