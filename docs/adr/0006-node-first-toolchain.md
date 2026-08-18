# The published toolchain targets Node, not Bun

Decided 2026-08-17. An external plugin author needs only Node ≥ 22.19 —
bb's own engines floor (`>=22.19.0`), and above the 22.18 threshold where
type-stripping turns on by default (verified empirically 2026-08-17;
22.6–22.17 need `--experimental-strip-types`, older 22.x cannot run `.ts`) —
so `.ts` files run directly, `node:test` is the scaffolded test runner, and
the `bb-kit` bin plus everything it generates assume `node` on PATH — never
`bun`.

The bb-plugins repo keeps Bun as its own package manager and workspace tool.
That is repo-internal and is not imposed on consumers.

Requiring Bun would double the toolchain for the default consumer (a
standalone single-plugin repo), and Node 22 type-stripping removed the
build-step argument for it. The bb host runs plugin code under its own runtime
anyway, so the author-side runtime is purely a dev-loop choice.

## Consequences

- bb-kit runtime source and all scaffolded code stay within erasable-syntax
  TypeScript (no enums, namespaces, or parameter properties), so `node` can
  execute them without a transpile step.
- CI must exercise the published-consumer path under plain Node even though
  this repo's dev loop uses Bun.
- `node:test` conventions (file naming, assertion style) become the
  framework's test vocabulary.
- JSX is the one thing Node cannot strip (verified 2026-08-17): scaffolds
  wire the `tsx` loader into `scripts.test` (`node --test --import tsx`)
  so tests can import `ui/*.tsx`. Test-time and in-memory only — still no
  build step, no artifacts. Test files stay `.test.ts`; a `.test.tsx` is
  never discovered by Node's default glob.
