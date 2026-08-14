# bb-kit Dotfiles dogfood notes

Date: 2026-08-13

The Dotfiles plugin was rewritten from a root-level server and app into one bb-kit
vertical module. The rewrite used `init`, `add module`, `add operation`, `info`,
`operations`, `describe`, `invoke`, `check`, and `verify`, then exercised the loaded
plugin through its CLI, native RPC, and bb panel.

These notes preserve the observed evidence. The durable rules derived from it
are in the [bb-kit design principles](bb-kit-design-principles.md).

## What worked well

- `add operation` plus `bb-kit.lock.json` made all six operation identities and wire
  methods explicit. The generated catalog removed manual RPC-contract duplication.
- The service interface kept policy and expected outcomes independent from bb. Six
  focused tests cover overview projection, allowed paths, save conflicts, task mapping,
  and stale skill removal without a fake host.
- `check` caught structure, package placement, runtime dependency, operation-risk, and
  plugin-generation ownership errors early.
- `verify` was a useful handoff gate. It ran lint, typecheck, tests, build, dry-run pack,
  manifest targets, and the transitive relative source-fallback closure in one command.
- `invoke` exercised the loaded native RPC operations directly. Its destructive-risk
  gate refused `dotfiles.publish` without `--confirm` before any request was sent.
- The generated local `AGENTS.md` is short and puts the important module rules beside
  the code they govern.

## Issues, fixes, and product learnings

### 1. Keep compatibility assertions inside one framework-owned seam

With `exactOptionalPropertyTypes`, Zod 4.4's Standard Schema issue-path type is wider
than the copy in the bb 0.37 SDK declaration. The generated catalog works for backend
registration, but `useRpc<typeof catalog.rpcContract>()` does not typecheck.

bb-kit now owns `useOperationRpc(catalog)`. It calls native `useRpc` at one narrow seam
and returns exact catalog-derived method, input, and output types. Dotfiles no longer
has a duplicate RPC-client shape or application cast. The learning is to hide a known
host mismatch once, not give each plugin a configurable adapter.

### 2. Generate one test setup that works without a decision

The initial scaffold added `"test": "bun test"` and included tests in `tsconfig.json`,
but did not add Bun types. A natural first test that imported `bun:test` therefore
failed typecheck. This repository uses `node:test`, which Bun can execute, so the plugin
followed that convention instead.

The scaffold now generates a `node:test` starter that Bun discovers and executes. A
fresh generated project runs `bun test` without adding Bun types or asking the author
to select a test framework. bb-kit keeps test-directory freedom by running unscoped
`bun test`.

### 3. Safety policy must not be project-configurable

Before this follow-up, bb-kit pinned its tested line to `>=0.36.0 <0.37.0`. The
connected bb was 0.37.0, so the first path install became `incompatible` even though
the SDK protocol and built bundle were still 0.4.1-compatible. A temporary local engine range was needed
only for live verification; at that point, the repository manifest remained on bb-kit's tested line.
The old `verify` also ran the active 0.37 build, which refreshed the plugin's vendored SDK
declaration away from the repository's pinned 0.36 release without reporting the drift.
That initial dogfood build had to select the cached 0.36 CLI explicitly and restore the
declaration.

The repository now targets bb 0.37 after that safety work proved the upgrade path.
bb-kit 0.1 still has one internal compatibility contract. `check` locks exact engines and
raw declaration hashes. `build` and `verify` require bb CLI 0.37.0 before project tools,
propagate one protected child environment, call that binary directly, and validate
build metadata. Invalid explicit `BB_CLI` never falls back. `verify` owns fixed tools
instead of package scripts and rechecks protected outputs after every phase.

The read-only `doctor` keeps live observation separate from deterministic verification.
It correctly reports the compatible connected 0.37 host and that Dotfiles is installed
from `/Users/smsunarto/git/bb-plugins/plugins/dotfiles`, not this worktree.
It made no RPC or mutation request. The learning is to encode safety policy in the tool,
not in a lock selector or a list of user-selected commands.

### 4. Host-shimmed package subpaths need first-class modeling

BB shims `@pierre/diffs` and `@pierre/diffs/react`, but not
`@pierre/diffs/edit`. The old plugin reached into the workspace's hoisted
`node_modules` to bundle the edit runtime. That worked only in the monorepo and could
not survive a packed source fallback. Mixing that bundled edit runtime with BB's
host-owned renderer would also split Pierre's internal state.

Oracle recommended a plugin-owned text editor with the host-owned read-only diff, which
the rewrite uses. bb-kit now locks the exact bb 0.37 frontend shim specifiers from
`RUNTIME_SLOT_BY_SPECIFIER`; package-family prefixes do not imply subpath support.
`check` rejects unsupported shim subpaths, package escapes, and unresolved local imports.
Pack inspection remains authoritative. The learning is to model the host's exact ABI,
not a permissive package-name approximation.

### 5. Remove input ambiguity instead of improving guesses

The initial `describe` showed identity, kind, risk, and wire method, but not input
guidance. For a `z.null()` query, `invoke` defaulted to `{}` and required the non-obvious
`--input null`. Also, `bb-kit invoke --help` reported an unknown option and printed only
the global usage.

bb-kit now exports one frozen, privately branded `noInput` singleton. Every other schema
requires a schema-compatible finite JSON `exampleInput`; `z.null()` therefore requires
explicit `--input null`. AST discovery accepts only a direct named import and literal
JSON. `describe`, `invoke`, and fixtures use the same state, command help is local, and
missing, extra, or undiscoverable input makes zero requests. The learning is to create
one valid representation and reject all ambiguous forms rather than infer schema intent.

### 6. `verify` is strong for packages but intentionally stops before user behavior

The package gate proved the bundle and fallback closure, but it cannot prove layout,
unsaved-state behavior, confirmations, or compare-and-swap conflicts. Live testing found
that a split diff inside a half-width preview truncated short JSON lines, and that a
constrained panel let the stale warning overlap its controls. Both defects were fixed by
giving Split mode full diff width, wrapping long diff lines, stacking navigation on
constrained viewports, and allowing the editor toolbar to wrap.

A generated live-test checklist, without pretending to automate product behavior, would
make the boundary clear: package verification first, then plugin status/logs, safe CLI
and RPC probes, and one real surface flow.

`doctor` now generates that checklist and the first query by stable identity, but does
not execute either. This is intentionally less configurable and safer: observation,
explicit RPC, and UI interaction remain separate user actions.

## Final implementation evidence

- Runtime typecheck and 11 runtime tests passed.
- CLI typecheck and 47 CLI tests passed, including wrong-CLI zero-tool behavior,
  declaration mutation after fixed tools and pack, build-metadata drift, strict AST
  discovery, strict fixtures, and doctor's read-only command allowlist.
- Dotfiles typecheck and six service tests passed.
- `bb-kit check` returned no Dotfiles diagnostics.
- A pinned bb 0.37.0 `bb-kit build` passed and reported the exact selected executable.
- The fixed pinned `bb-kit verify` sequence passed lint, typecheck, test, build, and pack.
- Live query and panel evidence for this exact worktree remains blocked by the intentional
  host/source mismatch that doctor reported. The installed plugin was not changed.

## Compatibility workflow follow-up

The 0.37 migration showed that the remaining risk was not one weak declaration check.
It was the number of places a user had to edit together: the root pin, every plugin's
two engines, generated declarations, component registry URLs, and the framework's own
host-shim and metadata expectations. A script that refreshed only SDK types made a
partial upgrade easier instead of making the correct upgrade safe.

bb-kit now owns this as one workflow:

- `compatibility inspect` derives the target from the selected stable bb CLI and shows
  the complete file plan without changing the workspace.
- `compatibility upgrade` applies that plan as one transaction and restores prior bytes
  if its post-write workspace check fails.
- `compatibility check` and `check --workspace` reject a partial upgrade, an optimistic
  future-minor engine range, declaration or registry drift, and stale build metadata.
- The old declaration-only refresh script is gone. There is no custom range, force,
  downgrade, install, reload, or compatibility selector.

The release probe uses bb itself as the authority. It scaffolds and builds a temporary
full-stack plugin, then reads the SDK protocol, artifact format, declarations, hashes,
registry URL, and exact host shims. This was better than adding another hand-maintained
version table. A real bb 0.37 probe produced the existing contract byte-for-byte, and
an idempotent inspect planned zero workspace changes.

### Further bb-kit improvements found during implementation

1. **bb should expose machine-readable compatibility metadata.** bb-kit currently has
   to identify the host-shim export map structurally in the bundled CLI. It fails closed,
   but an official `bb plugin compatibility --json` response would remove coupling to
   bundle shape and make release probing faster.
2. **Reject duplicate JSON keys before planning.** JSON permits parsers to accept two
   keys with last-value wins, while structured editing can update the first key. The
   transaction post-check and rollback prevent a partial upgrade today, but a direct
   duplicate-key diagnostic would be earlier and clearer.
3. **Make stale build output explicit in upgrade results.** The upgrader does not rewrite
   `dist/` metadata because that would claim false provenance. A future result can list
   the required build as a structured next action while still keeping build, install,
   and reload outside the compatibility mutation.
4. **Keep inspect and check separate.** Inspect must execute a temporary scaffold/build
   to learn a new release. Check needs no bb process and remains suitable for every CI
   run. Combining them would make routine enforcement slower and less reliable.
