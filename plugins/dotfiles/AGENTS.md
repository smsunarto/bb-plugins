# Dotfiles plugin conventions

Built on `@bb-kit/core` (subpath imports: `/plugin`, `/rpc`, `/rpc/query`, `/cli`, `/testing`).

## Layout

* `server/server.ts` is the composition root. It
  default-exports `definePlugin(...)`. The return carries `.rpc`. UI
  type-only imports that default and reads `(typeof plugin)["rpc"]`.
  RPC `execute` infers `ctx` and takes keyed args. Commands take inferred
  CommandContext and `{ args, options }`, then call RPC
  `.execute(ctx[, args])`.
* `server/` also holds `domain.ts`, `git.ts`,
  `fake-git.ts`, and `fake-context.ts`. `domain.ts` carries only the genuinely shared values
  (task table, tweakable groups, allowlist, shared schemas); keep it
  browser-safe (zod-only imports).
* `server/rpc/` and `server/cli/` hold one unit per file: kebab-case basename, exactly one value
  export named the camelCase of the basename. No helper files directly in either
  directory — the checker treats every direct child as a unit. Duplicate shared
  micro-logic inline instead. Per-RPC schemas live module-private inside
  their unit; `export type` is unrestricted, so wire result types (for `app/`)
  export from the unit that defines them.
* `app/` holds everything browser-bound (`app/app.tsx` is the app entry).
  Vendored shadcn source lives under `app/components`, `app/hooks`, and `app/lib`.

## Tests and checks

* Tests are sibling `<unit>.test.ts` files, run by `node --test --import tsx`
  (`bun run test`).
* `bun run check` runs the `@bb-kit/core` checker from source.
* Run `bun run typecheck` while editing and `bun run verify` before handoff.

## RPC names

The six RPC names are a public contract and must survive byte-identical:
`overview`, `publish`, `readFile`, `removeSkill`, `runTask`, `saveFile`.
Do not rename them.
