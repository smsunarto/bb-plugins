# Dotfiles plugin conventions

Built on `@bb-kit/core` (subpath imports: `/plugin`, `/rpc`, `/cli`, `/query`, `/testing`).

## Layout

- `server.ts` at the plugin root is the composition root. It exports `rpc` (the
  `defineRPC` result), `type RPC`, `type Client`, and a default `definePlugin(...)`.
- `server/` holds `context.ts`, `domain.ts`, `repository.ts`, and
  `fake-repository.ts`. `domain.ts` carries only the genuinely shared values
  (task table, tweakable groups, allowlist, shared schemas); keep it
  browser-safe (zod-only imports).
- `rpc/` and `cli/` hold one unit per file: kebab-case basename, exactly one value
  export named the camelCase of the basename. No helper files directly in either
  directory — the checker treats every direct child as a unit. Duplicate shared
  micro-logic inline instead. Per-procedure schemas live module-private inside
  their unit; `export type` is unrestricted, so wire result types (for ui/)
  export from the unit that defines them.
- `ui/` holds the app (`ui/app.tsx`).

## Tests and checks

- Tests are sibling `<unit>.test.ts` files, run by `node --test --import tsx`
  (`bun run test`).
- `bun run check` runs the `@bb-kit/core` checker from source.
- Run `bun run typecheck` while editing and `bun run verify` before handoff.

## Wire names

The six RPC wire names are a public contract and must survive byte-identical:
`dotfiles_overview`, `dotfiles_publish`, `dotfiles_read_file`,
`dotfiles_remove_skill`, `dotfiles_run_task`, `dotfiles_save_file`. They derive
from namespace `dotfiles` plus the procedure keys `overview`, `publish`,
`readFile`, `removeSkill`, `runTask`, `saveFile` — do not rename either side.
