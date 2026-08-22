# @bb-kit/core dogfood feedback

Feedback on `@bb-kit/core` 0.1.0 from its first dogfood: migrating `plugins/dotfiles` off the
vendored runtime (commit `0be0aae`, branch `bb-kit-clean-rewrite`, 2026-08-20).

**Evidence base.** One plugin, one migration, one host (macOS, this repo). Findings come from a
five-lens review pass (before/after diff, migration friction, fresh-scaffold API probe,
docs-vs-built, tooling timings) plus the migration commits themselves. Each claim names the file,
command, or output that grounds it. Two findings are second-hand and say so. Five dimensions were
not evaluated at all — see the last section. Timings are from this host and are not benchmarks.

## The good

### Layout and units

- One procedure lives in one file with a directly testable handler. `rpc/save-file.ts` is 32 lines
  holding input, output, and handler together. The old runtime spread the same procedure across
  four files (schema-only operation, service handler, generated catalog, queries factory).
- Codegen and the lockfile are gone. `ui/rpc.ts` is 5 lines. `panel.tsx` calls
  `rpc.overview.useQuery()` and `rpc.readFile.queryKey({path})` with full types and no generated
  catalog to regenerate or forget.
- Plugin test code grew from 174 lines in 1 file to about 744 lines in 12 sibling files, including
  the plugin's first UI render test (`ui/app.test.ts`).

### The check gate

- `bb-kit check` is static. It parses sources through the plugin's own TypeScript 7 compiler and
  never imports plugin code (`bin-check.ts:16-21`). It is safe on broken or untrusted trees.
  (Now TypeScript 6, parsed in-process — ADR-0018.)
- Errors are rule-tagged with file:line, and the message names both sides of a conflict:
  `RPC namespace "other-name" must equal derivePluginID(package.json name) = "probe-plugin"`.
- Success output prints the wire-name table on every run. The table is a live review artifact of
  the plugin's public RPC surface.
- Degradation is honest. Without a toolchain it prints `could not resolve TypeScript 7 ... install
devDependencies first (parse-dependent rules skipped)` instead of a false pass. (The TS6 move
reworded the message — ADR-0018.)
- A missing sibling test warns but never fails the gate. Wiring, naming, and manifest breaks are
  hard errors. That severity split matches how authors actually work.

### Errors at define time and call time

- `defineRPC` rejects duplicate wire names, reserved keys, and bad name patterns when the module
  loads, and the error names the exact conflict: `procedures "readUrl" and "readURL" both derive
the wire name "p_read_url"` (`rpc.ts:92-111`).
- The in-process client validates input before the handler and output after it. Both paths throw a
  typed `RPCValidationError` carrying `stage` and `issues` (`rpc.ts:155-203`).
- The query layer defends the cache: derived `queryKey`/`queryFn` are spread last so caller options
  cannot desync them, and the TanStack MutationCache gc-timer leak workaround cites the verified
  upstream source (`query.ts:191-196`, `query.ts:279-292`).

### The testing story

- Three tiers run under plain `node --test --import tsx` with no bb instance and no test framework:
  handler unit tests, fake-host integration, and jsdom UI render. Dotfiles runs 29/29 in under a
  second. A fresh scaffold passes 5/5 on first install.
- The CLI gained an in-process harness. `invokeCLI` asserts exact `{exitCode, stdout|stderr}`
  shapes. The old 143-line argv switch had zero tests.
- The full `verify` chain (oxlint, tsc, 29 tests, check, `bb plugin build`, pack dry-run) finished
  in 1.2 s wall on this host.

### Dependency discipline

- One runtime dependency: commander. `StandardSchemaV1` is a ~30-line vendored interface instead of
  a zod dependency. `HostSeam` is structural, so the real SDK host assigns cast-free (verified
  against SDK 0.4.8 in `host.test.ts`).
- The scaffold pre-empts the SDK testing trap. It pins better-sqlite3, cron-parser, and hono with a
  comment explaining that `@get-bb/plugin-sdk/testing` imports them at module top
  (`scaffold.ts:15-37`).
- `useQuery` passes caller options through untouched. Cache policy such as `staleTime` stays the
  plugin's decision, not a framework opinion.

### Docs that match the build

- The migrated `server.ts` matches the spec's composition-root example nearly line for line
  (spec §2 vs `plugins/dotfiles/server.ts:18-44`). The documented shape is the real shape.
- Spec gotchas carry repro-grade evidence: exact error codes, the misleading first line, and the
  tool versions they were verified against. That makes them checkable instead of folklore.
- The dev-workflow scaffold tree is byte-accurate against `scaffold.ts`. `bb-kit add` prints exact
  copy-paste wiring lines, and pasting them verbatim makes `check` pass.
- CONTEXT.md's glossary with Avoid-lists transferred: the dogfooded plugin's own docs reuse the
  same vocabulary.

## The bad

### Must fix before plugin #2

1. **Union-output handlers need an undocumented return annotation.** A handler returning a
   literal-discriminated object fails TS2769, and the diagnostic misdirects: literals widen to
   `string` and the message blames the wrong overload's arity ("Expected 2 or more, but got 1").
   Adding `: Promise<Result>` compiles clean. Reproduced on tsc 7.0.2 by two independent probes.
   Dotfiles carries the fix silently (`rpc/save-file.ts:13-16`, `rpc/remove-skill.ts:13`), and no
   doc mentions the requirement. Fix: add a spec gotcha in the existing evidence-citation style,
   or restructure the `define*` overloads so the output schema contextually types the return.
2. **`npx bb-kit` runs the wrong tool.** Both `@bb-kit/core` and the old `@bb-kit/cli` claim the
   `bb-kit` bin, and `node_modules/.bin/bb-kit` resolves to the old CLI. The README documents
   `npx bb-kit check`, the scaffold ships no `check` script, and the only working form is the
   52-character `node --import tsx ../../packages/bb-kit/src/bin.ts check`, which also needs tsx
   resolvable from cwd. The built `dist/bin.js` works from any cwd but nothing points at it. Fix:
   drop or rename the old CLI's bin, and scaffold a pinned `check` script that targets
   `dist/bin.js`.
3. **`check` dies then hangs under bun, and repo docs recommend the bun form.** TS 7's sync API
   reads `child.stdout._handle.fd` (`syncChannel.js:131`), a Node internal absent in Bun, and
   `bin.ts:63` sets `process.exitCode` without exiting, so the orphaned child keeps the event loop
   alive after the red result prints. `AGENTS.md:21` recommends `bun packages/bb-kit/src/bin.ts`
   and the spec invites bun repos with no warning. The hang was reproduced by three migration
   agents. This review pass did not re-run it because bun invocations of the checker are banned on
   this host. Fix: refuse with one line when `process.versions.bun` is set, force exit after a
   toolchain failure, and correct `AGENTS.md` and spec §10. (Fixed as written, then overtaken:
   ADR-0018's in-process TS6 parse removed the failure mode and the guard, and bun now runs check.)
4. **Four doc statements are now false.** The spec header still says "No code exists until this
   spec is confirmed". The doc baseline reads bb 0.38 / SDK 0.4.6 while the code pins bb ≥0.39 /
   SDK 0.4.8. Docs and scaffold call `@bb-kit/core` a devDependency while dotfiles ships it under
   `dependencies`, with no stated rule. The getting-started `npx @bb-kit/core create` 404s because
   0.1.0 is unpublished, and `create`'s mandatory install step fails on the same pin (no
   `--no-install` flag, exit 1 despite an intact scaffold). Fix: flip the spec header, re-baseline,
   state the dependency-placement rule, and either publish 0.1.0 or lead with the in-repo
   invocation.
5. **Every new procedure turns unrelated CLI tests red, and there is no stub helper.**
   `CLICommand.run` takes the full `Client`, so the six hand-written ~17-line `fakeClient` stubs
   (one per `cli/*.test.ts`) and the scaffold's own command test must all grow per procedure.
   Reproduced on a fresh scaffold: `add query` plus the printed wiring makes the scaffolded test
   fail TS2741. `@bb-kit/core/testing` exports only `installDom`. Fix: ship a typed
   `stubClient<C>(partial)` that fills missing procedures with throwing stubs.
6. **The test harness cannot reproduce StrictMode effects, and that blind spot shipped a real
   bug.** bb's app root renders every plugin panel under `<StrictMode>`
   (`apps/app/src/main.tsx:57` in bb 0.39). Its dev double mount ran `PluginQueryBoundary`'s
   cleanup and remounted the SAME owned client before the queued sweep microtask fired, so the
   sweep cleared the live client — silently cancelling the panel's first in-flight query and
   freezing it on `isPending` with no error, no retry, and exactly one POST on the wire. All 104
   framework tests and 29 plugin tests passed anyway, because React 19 grants strict effects only
   to StrictMode at the ROOT of the render, and the SDK's `renderSlot` always nests the component
   under its providers (verified against react 19.2.8 and SDK 0.4.8 `dist/testing/app.js:1190`).
   The bug is fixed (commit `d41a72f`: a mounted flag skips the sweep when the boundary remounted
   first) and the regression test renders through RTL directly with root-level StrictMode. The
   blind spot stands: nothing rendered through `renderSlot` exercises the double-mount path, so
   any future mount/cleanup pairing in the framework or a plugin needs its own RTL-direct test.
   Fix: document the limitation in the spec's testing section, and consider a
   `renderSlot({strict: true})` mode that mounts StrictMode above the harness providers.

### Warts

- **Wire-name rename safety regressed.** The old lockfile pinned each `rpcMethod` and carried a
  migrations map. The new framework derives names live and has no mechanism. The only guard is the
  hand-written six-literal pin in `plugins/dotfiles/server.test.ts:15-22`, and `check` prints the
  table but compares it to nothing. Fix: an optional committed wire-name manifest that `check`
  diffs, or generate the pin test for every plugin.
- **The lone-object `useQuery` heuristic rests on a 32-key TanStack snapshot.** The DRIFT comment
  (`query.ts:99-106`) admits a newer 5.x minor can silently break classification, and the peer
  range allows `^5`. The scaffold repeats the warning with the `useQuery(input, {})` workaround.
  Fix: make the two-argument form canonical, or warn in dev mode when a lone object mixes known
  and unknown keys.
- **One-unit-per-file leaves no home for shared micro-logic.** The identical allowlist guard is
  duplicated in `rpc/save-file.ts:18-23` and `rpc/read-file.ts:11-16`, each with an apology
  comment. Fix: bless a shared-helpers location in the layout convention and in `check`'s rules.
- **`RPCValidationError` messages drop the issue paths and the procedure name.** A nested failure
  reads `invalid input: Invalid input: expected string, received number` while `.issues` carries
  the paths that never reach the message, and the stutter is real (`rpc.ts:159`). Fix: include the
  dotted path per issue and the procedure key.
- **Procedures have no description field.** The always-on `rpc` CLI subtree can only print
  `(query)` as help (`plugin.ts:112`). Fix: optional `description` on
  `defineQuery`/`defineMutation`, surfaced in the subtree help.

### Nits

- `defineQuery`/`defineMutation` dropped the old risk taxonomy and required `exampleInput` with no
  replacement. The loss is dev-facing only: the old runtime never forwarded them to bb.
- The published package carries a 60-line README while the 921-line spec stays repo-only. An npm
  consumer sees five subpath exports with almost no shipped reference.
- The missing-toolchain path leaks a raw Node `Require stack:` dump from the SDK probe alongside
  the otherwise clean message.
- CLI output conventions are inconsistent and undocumented. Bare `bb-kit` prints usage to stdout
  while other usage errors go to stderr. `runProgram` appends a trailing newline to stderr, and
  commander shifts one guard's exit from 1 to 2. (The newline and exit deltas are second-hand from
  the migration journal, not re-run in this pass.)
- "Standard Schema v1, object-constrained" oversells. `JSONObjectSchema` pins zod's `_zod.output`
  channel, so a valibot or arktype schema would likely fail the constraint. (Inference from
  source. No non-zod compile was attempted.)

## Not evaluated

This pass did not look at five dimensions a maintainer would care about:

- Migration cost for the other 8 plugins, and whether a migration guide exists.
- Release wiring: whether `packages/bb-kit` is in the Changesets config and whether Linux CI runs
  its 104 tests.
- Multi-plugin runtime behavior: cross-plugin wire-name collisions and shared-vs-owned
  QueryClient in `PluginQueryBoundary`.
- Security of the RPC/CLI surface: path traversal in `readFile`/`saveFile` inputs, callers of the
  `dotfiles_*` wire methods, the 1 MiB CLI output cap.
- `npm pack` of the framework tarball itself: dist presence and all five subpath exports resolving
  from the tarball.

## Verdict

The design held. The migrated plugin is smaller, fully tested, and gated end to end in about a
second, and the docs mostly describe the thing that was actually built. The bad list is dominated
by delivery polish — the bin collision, the unpublished pin, and doc drift — not architecture. The
one real type-level wart is handler return inference under the `define*` overloads. Clear the five
must-fix items, then migrate plugin #2.
