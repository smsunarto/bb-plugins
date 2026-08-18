# bb-kit is rewritten from scratch, in place, in plain TypeScript

bb-kit 0.1 (`@bb-kit/core` + `@bb-kit/cli`, unpublished, consumed only by
`plugins/dotfiles`) grew into safety machinery, and a second toolkit attempt
(bb-forge, Effect-based, phase 1 on an unpushed branch) ran in parallel.
Decided 2026-08-17: rewrite bb-kit from scratch in this repo under the same
name, in plain TypeScript aligned with bb's own plugin idiom — no Effect.
bb-forge is abandoned and is not an input to the rewrite; do not merge or mine
its branch.

Amended 2026-08-17: the unmerged Amp branch
`bb/reconsider-bb-kit-plugin-directory-thr_ss2vds65gf` (2026-08-14) prototyped
the same direction — flat per-file layout, no project lock, typed RPC instead
of generated catalogs. It is a design input only: its ideas go through the
design review one by one, but no file is lifted from it and all rewrite code is
written greenfield. Do not merge that branch either.

## Consequences

- During the rewrite, the old bb-kit is vendored into `plugins/dotfiles` so
  dotfiles keeps building while `packages/bb-kit*` goes greenfield. The
  vendored copy is deleted when dotfiles migrates to the new framework, which
  is the first dogfood milestone.
- `docs/bb-plugin-framework-spec.md` describes bb-kit 0.1 and is superseded.
