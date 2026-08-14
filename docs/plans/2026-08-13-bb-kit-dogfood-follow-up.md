# Harden bb-kit after Dotfiles dogfood

| Field | Value |
|---|---|
| Status | Implemented; live worktree UI evidence remains pending |
| Owner | bb-kit maintainers |
| Updated | 2026-08-13 |

## Summary

- **Problem:** Dotfiles dogfood found one verification path that can silently refresh SDK declarations with the wrong bb release, plus repeated frontend, scaffold, inspection, and live-test friction.
- **Outcome:** bb-kit owns one safe build and verification path, makes invalid operation-input states unrepresentable, gives plugin authors a cast-free RPC client, and provides a mechanically read-only live preflight.
- **Approach:** Replace project-selected policy with one package-internal compatibility contract, fixed bb-kit commands, exact host shims, a branded `noInput` singleton, and fail-closed discovery.
- **Main tradeoff:** bb-kit-managed projects lose custom build and verification command selection. Existing dev watchers and Bun test discovery remain free because bb-kit does not need to own them.
- **Blocking decisions:** None.

This plan incorporates the findings in [`docs/bb-kit-dotfiles-dogfood.md`](../bb-kit-dotfiles-dogfood.md) and three Oracle reviews. The first review selected the milestone order and the boundary between offline verification and live testing. The second fixed the exact CLI-selection, environment, declaration-hash, and post-build contracts. The third replaced configurable seams with bb-kit-owned behavior and defined the canonical no-input contract.

## Problem and current state

### Observed

1. `verifyProject` runs project lint, typecheck, test, and build scripts without first checking the exact bb CLI. A build can therefore refresh `types/*.d.ts` before verification detects a compatibility problem ([`packages/bb-kit-cli/src/verify.ts`](../../packages/bb-kit-cli/src/verify.ts)). This occurred during Dotfiles dogfood when active bb 0.37 changed declarations in a repository pinned to bb 0.36.0.
2. `checkProject` checks the declared bb line but accepts several equivalent range strings. It does not verify generated declaration bytes ([`packages/bb-kit-cli/src/check.ts`](../../packages/bb-kit-cli/src/check.ts)).
3. The import checker treats several host packages as broad package families. It does not distinguish supported `@pierre/diffs` subpaths from unsupported `@pierre/diffs/edit`, and it does not report a local import that escapes the plugin package during `check`.
4. A Zod 4 operation catalog does not satisfy bb 0.37's frontend `useRpc` generic under `exactOptionalPropertyTypes`. Dotfiles defines a duplicate client shape and keeps an application cast in [`panel.tsx`](../../plugins/dotfiles/plugin/modules/dotfiles/panel.tsx) and [`queries.ts`](../../plugins/dotfiles/plugin/modules/dotfiles/queries.ts).
5. `bb-kit init` emits `"test": "bun test"` and Node types, but no starter test. A natural `bun:test` import does not typecheck with that setup ([`packages/bb-kit-cli/src/generate.ts`](../../packages/bb-kit-cli/src/generate.ts)).
6. `describe` does not show operation input guidance. Omitted `invoke` input always becomes `{}`, including for `z.null()` operations. Command-local `--help` is rejected by the generic parser ([`command.ts`](../../packages/bb-kit-cli/src/command.ts), [`invoke.ts`](../../packages/bb-kit-cli/src/invoke.ts)).
7. `verify` correctly stops at deterministic package evidence. It does not check the loaded plugin, installed source, or UI behavior. The framework design already assigns responsive layout, focus, portals, host CSS, and interaction behavior to live verification ([`docs/bb-plugin-framework-spec.md`](../bb-plugin-framework-spec.md)).

## Goals and non-goals

### Goals

- Stop build or verification before any child tool when the selected bb CLI, engine declarations, or generated SDK declarations do not match bb-kit's only compatibility contract.
- Make `bb-kit build` invoke the exact selected bb CLI directly, and make `bb-kit verify` run one fixed toolchain instead of package-authored scripts.
- Require canonical package-script aliases for the behavior that bb-kit owns, without prescribing a dev watcher or test directory.
- Detect package escapes, unresolved relative fallback imports, and unsupported host-shim subpaths during `check`, while retaining pack inspection.
- Give frontend code a catalog-derived RPC hook with no application cast.
- Generate a test script, TypeScript types, and starter test that work together.
- Give every operation exactly one input state: canonical no-input, or required input with a concrete example.
- Make `check`, fixtures, `describe`, and `invoke` reject missing, extra, or undiscoverable input metadata without an RPC request.
- Add a mechanically read-only doctor that reports loaded-plugin facts and prints a specific manual UI checklist and suggested query command.
- Prove each change on Dotfiles or a generated fixture before handoff.

### Non-goals

- Do not download, discover, or silently select another bb CLI.
- Do not expose compatibility selection, custom verification commands, build hooks, or a selector in `bb-kit.lock.json`.
- Do not sandbox or attest arbitrary lifecycle scripts that Bun can run during package operations. Recheck protected outputs after each tool.
- Do not replace pack-time package validation with static checks.
- Do not inspect private Zod internals or make Zod the public framework boundary.
- Do not wrap the complete frontend SDK, RPC protocol, TanStack Query hooks, or bb lifecycle.
- Do not impose one `dev` command, watcher implementation, or fixed test directory.
- Do not install, reload, enable, configure, remove, or invoke plugins from doctor.
- Do not automate UI interaction or treat screenshots as proof.
- Do not include unrelated bb-kit generators or backlog items.

## Scope

| In scope | Out of scope |
|---|---|
| One package-internal `@bb-kit/cli` compatibility constant | Compatibility profiles or new bb lines |
| Exact bb executable preflight and child environment | Automatic CLI installation or cache search |
| SDK declaration and build-metadata validation | Binary attestation against platform hashes |
| Package-local source closure and exact host shims | Complete npm dependency graph analysis |
| `bb-kit build`, fixed `verify`, and canonical package aliases | Project-selected build or verification commands |
| `useOperationRpc(catalog)` | General `@bb/plugin-sdk/app` wrapper |
| Generated `node:test` starter executed by Bun | Bun test typings |
| Branded `noInput`, required examples, AST discovery, and strict fixtures | Generic schema introspection or input-mode configuration |
| Read-only `bb-kit doctor`, checklist, and suggested manual query | `verify --live`, doctor RPC, or browser automation |
| Dotfiles migration as dogfood proof | Unrelated plugin migrations |

## Constraints and requirements

| Constraint or requirement | Source | Design effect |
|---|---|---|
| bb-kit 0.1 targets exact build CLI 0.37.0, bb 0.37.x, and plugin SDK 0.4.1 | Framework specification and repository `config.bbVersion` | One package-internal immutable constant owns all values. No selection API exists. |
| bb's SDK is unpublished and pre-1.0 | Framework specification | Keep generated declarations and do not leak SDK server types into bb-kit declarations. |
| Official bb entrypoints honor absolute `BB_CLI` | Repository workflow | Propagate one selected absolute path to every verification subprocess. |
| Package build scripts caused the observed wrong-CLI mutation | Dotfiles dogfood and Oracle review | `bb-kit build` directly runs the selected CLI; `verify` never runs the package's build script. |
| Bun package operations can still run lifecycle code | Oracle review | Recheck protected outputs after every fixed tool and after pack. |
| Existing repositories use valid watcher and test layouts | Repository inspection and Oracle review | Do not check `dev`; use unscoped `bun test` so Bun owns discovery. |
| Source fallback can load shipped source | Repository instructions | Check runtime dependencies, local closure, and package contents. |
| Standard Schema V1 has validation but no generic schema description | `standard-schema.ts` | Use identity-based `noInput`; all other schemas require authored literal JSON examples. |
| UI behavior needs a real bb surface | Framework specification | Keep `verify` offline; doctor observes and suggests, but never invokes. |
| Existing Dotfiles work is uncommitted | Current worktree | Preserve all unrelated and prior-session changes during implementation. |

## Proposed design

One package-internal compatibility constant is the source of truth for the supported bb line. `check`, `build`, `verify`, generation, import analysis, and doctor consume it without accepting it as a parameter. Plugin manifests and `bb-kit.lock.json` are checked consumer state; neither can select policy.

```diagram
┌─────────────────────────────┐
│ Private compatibility      │
│ CLI, engines, SDK, hashes,  │
│ metadata, exact host shims  │
└──────┬──────────┬───────────┘
       │          │
       ▼          ▼
┌────────────┐  ┌─────────────────────┐
│ bb-kit     │  │ bb-kit build/verify │
│ check      │  │ fixed direct tools  │
└─────┬──────┘  └────────┬────────────┘
      │                  │ protected environment
      │ diagnostics      ▼
      │          ┌─────────────────────┐
      │          │ Exact bb CLI, local │
      │          │ tools, Bun, pack    │
      │          └─────────────────────┘
      │
      ▼
┌─────────────────────────────┐
│ Plugin source and package   │
└─────────────────────────────┘

┌─────────────────────────────┐       ┌──────────────────────┐
│ Operation catalog           │──────▶│ useOperationRpc      │
│ noInput or required example │       │ native useRpc seam   │
└────────────┬────────────────┘       └──────────────────────┘
             │
             ├──────────────▶ AST discovery
             │
             └──────────────▶ check / fixtures / describe / invoke
```

The private constant owns compatibility policy. The exact `noInput` singleton and required `exampleInput` literals make operation files the common source for backend registration, frontend types, fixtures, and development invocation. Doctor reads discovered metadata only to print a manual next action.

### Verification flow

```diagram
┌──────────────┐
│ bb-kit verify│
└──────┬───────┘
       ▼
┌────────────────────────────┐   failure   ┌─────────────────────┐
│ Offline check + SDK hashes │────────────▶│ Stop before tools   │
└──────────────┬─────────────┘             └─────────────────────┘
               ▼
┌────────────────────────────┐   mismatch  ┌─────────────────────┐
│ Resolve exact bb executable│────────────▶│ Report path/version │
│ and run --version          │             │ Do not find another │
└──────────────┬─────────────┘             └─────────────────────┘
               ▼
┌────────────────────────────┐
│ local oxlint → hash → local│
│ tsc → hash → bun test      │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│ internal bb-kit build      │
│ selected bb plugin build . │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐   drift     ┌─────────────────────┐
│ pack → package checks      │
│ → final hash + metadata    │
└──────────────┬─────────────┘────────────▶│ Stop; do not restore│
               │                           └─────────────────────┘
               ▼
        ┌────────────┐
        │ Verified   │
        └────────────┘
```

Every successful tool is followed by a protected-output check. `verify` does not inspect or run package-authored lint, typecheck, test, or build scripts. Generated and checked scripts are convenience aliases to the same bb-kit-owned commands.

### Abstraction agreement

#### Types and state

| Type or schema | Key fields | Responsibility | Invariants | Owner |
|---|---|---|---|---|
| `compatibility` | `bbCliVersion`, `engines`, `pluginSdk`, `declarations`, `hostShims` | The only supported bb-kit compatibility line | Immutable; package-internal; no selector, public type, or lock field | `bb-kit-cli/src/compatibility.ts` |
| `ProtectedDeclaration` | package name, relative path, condition, SHA-256 | Describe one generated SDK declaration | Hash is over raw bytes | `compatibility.ts` |
| `BuildMetadataExpectation` | SDK major/version, format, plugin identity/version, `builtWith` | Validate `dist/*.meta.json` | Derived from `compatibility` plus manifest | `compatibility.ts` |
| `CommandRequest` | `file`, `args`, `cwd`, `env` | Make subprocess selection and environment explicit | `file` is not interpreted by a shell | `verify.ts` |
| `CommandResult` | status, signal, stdout, stderr, structured spawn error | Preserve actionable process failure data | A null status is not reported as a generic exit failure | `verify.ts` |
| `OperationRpcClientFor<Catalog>` | catalog-derived `call` signature | Hide the frontend SDK generic mismatch | Exact method, input, and output inference remains | `bb-kit/query` |
| `OperationJsonValue` | Recursive JSON scalar, array, or object | Keep invocation metadata transport-safe without importing bb SDK types | No `undefined`, functions, classes, or cyclic values | `bb-kit/operations` |
| `typeof noInput` | Frozen Standard Schema V1 singleton for `null`, private unique-symbol brand | Represent an operation that accepts no user input | Runtime classification is identity-only; validator accepts and returns only `null` | `bb-kit/operations` |
| `DiscoveredOperationInput` | `{ mode: "none" }` or `{ mode: "required", example }` | Carry fail-closed input metadata to CLI commands and fixtures | Only a direct named package import can produce `none` | `bb-kit-cli/project.ts` |
| `DoctorReport` | compatibility, CLI, host/plugin facts, suggested query, checklist | Stable read-only live preflight result | Contains instructions only; no RPC result state exists | `bb-kit-cli/doctor.ts` |

The package-internal constant is not exported from the CLI package entry point:

```ts
export const compatibility = {
  bbCliVersion: "0.37.0",
  engines: {
    bb: ">=0.37.0 <0.38.0",
    bbPluginSdk: "^0.4.1",
  },
  pluginSdk: {
    version: "0.4.1",
    major: 0,
    artifactFormatVersion: 1,
  },
  declarations: {
    server: {
      path: "types/bb-plugin-sdk.d.ts",
      required: "always",
      sha256: "92ed82ff874280ab0c239e11669da3ed040b800aa1e8dd59cdf9c617dafcaccb",
    },
    app: {
      path: "types/bb-plugin-sdk-app.d.ts",
      required: "when-bb-app-exists",
      sha256: "984e0539c6926d42ddaf666c6b6890a567d08f711d9ae73a9b986620230eed9a",
    },
  },
  hostShims: {
    server: ["@bb/plugin-sdk"],
    frontend: [
      "@bb/plugin-sdk/app",
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-context-menu",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-hover-card",
      "@radix-ui/react-menubar",
      "@radix-ui/react-navigation-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-select",
      "@radix-ui/react-tooltip",
      "sonner",
      "vaul",
    ],
  },
} as const;
```

Server metadata, and app metadata when `bb.app` exists, must report `builtWith.bbVersion: "0.37.0"` and plugin SDK version `"0.4.1"`. These values are derived from the constant; projects cannot override them.

Host shim entries are exact specifiers, not prefixes. The implementation must confirm this initial list against bb 0.37 source or build tests before it lands. A compatibility contract test then locks the list. `@pierre/diffs/edit`, arbitrary React subpaths, and arbitrary `@radix-ui/*` packages are not implied.

#### Methods and interfaces

| Method or command | Contract | Errors | Side effects | Consumers |
|---|---|---|---|---|
| `resolveBbCli(env): SelectedBbCli` | Require absolute executable `BB_CLI`, or resolve first `bb` on supplied `PATH`; return real absolute path and source | Invalid path, not executable, no PATH match | Filesystem metadata reads only | `verify`, `doctor`, and type-syncing `init` preflight |
| `run(request: CommandRequest): CommandResult` | Execute without a shell and capture bounded output | Spawn error, signal, non-zero status | Child process | Verification and doctor adapters |
| `checkSdkDeclarations(root)` | Compare required files with the only canonical hashes | Stable missing/drift diagnostics | File reads only | `check`, `build`, `verify` postconditions |
| `checkBuildMetadata(root, manifest)` | Validate server metadata and app metadata when `bb.app` exists | File, parse, field mismatch | File reads only | `build` and `verify` after build and pack |
| `buildProject(root, {run, env})` | Preflight; invoke `<selected-bb> plugin build .` directly; recheck declarations and metadata | Compatibility, spawn, build, drift, metadata | Exact bb child process and generated `dist/` | `bb-kit build`, `verify` |
| `verifyProject(root, {run, env})` | Run fixed local oxlint, local `tsc --noEmit`, unscoped `bun test`, internal build, and dry-run pack | Structured failed/skipped steps | Fixed tools, build output, Bun test and pack lifecycle | CLI and tests |
| `useOperationRpc(catalog)` | Call native `useRpc`; return `OperationRpcClientFor<typeof catalog>` | Native RPC rejection at call time | React hook call only | Plugin panels and query option builders |
| `defineOperation(descriptor)` | Accept exact `noInput` with no example, or another schema with an own finite acyclic JSON `exampleInput` | Invalid schema, missing/extra/non-JSON example | None | Operation modules and generators |
| `describe <operation>` | Show identity, kind, risk, wire method, discovered input state, and exact invoke command | Unknown or invalid operation metadata | None | Humans and agents |
| `invoke <operation>` | Omit `--input` only for exact `noInput`; require it for every other schema; reject extra no-input values | Missing, unexpected, malformed, undiscoverable input; risk gate; RPC error | At most one explicit RPC request | Loaded-plugin loop |
| `doctor` | Read supported CLI/host/plugin facts; print checklist and one manual query suggestion | Compatibility, host, source, or status failure | CLI reads only; zero RPC | Live handoff |

`CommandRunner` changes from positional arguments to this request object:

```ts
export interface CommandRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface CommandResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: { readonly code?: string; readonly message: string };
}

export type CommandRunner = (request: CommandRequest) => CommandResult;
```

The selected child environment is a copy of the caller environment with `BB_CLI` set to the selected real path and `BB_CLI_REEXEC` removed. Preserve `PATH`; do not modify `process.env`.

`bb-kit build` owns the build. `bb-kit verify` calls its `buildProject` function, not the package's `build` alias. The other fixed commands resolve project-local `oxlint` and `tsc`, run `bun test` without a directory argument, then run `bun pm pack --dry-run`. Generated projects and `check` require only these aliases:

```json
{
  "scripts": {
    "build": "bb-kit build",
    "lint": "oxlint",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "verify": "bb-kit verify"
  }
}
```

`dev` is intentionally absent from this contract. A project can retain its existing watcher because it is not an input to build or verification correctness.

`OperationDescriptor` has two states, selected by one exported value:

```ts
declare const noInputBrand: unique symbol; // module-private

export const noInput: StandardSchemaV1<null, null> & {
  readonly [noInputBrand]: true;
};

type OperationInput<Input extends StandardSchemaV1> =
  | {
      readonly input: typeof noInput;
      readonly exampleInput?: never;
    }
  | {
      readonly input: Input extends typeof noInput ? never : Input;
      readonly exampleInput: SchemaInput<Input> & OperationJsonValue;
    };
```

`noInput` is one frozen singleton. Its validator accepts only `null` and returns `null`. bb-kit exports no constructor, factory, brand, input-mode enum, or guidance object. `defineOperation` classifies no-input at runtime with `descriptor.input === noInput`; `z.null()` and structurally equivalent schemas remain required-input schemas. It rejects `exampleInput` on the singleton and requires an own, finite, acyclic JSON `exampleInput` for every other schema.

Static discovery uses the TypeScript AST, not schema execution or regex guesses. It produces:

```ts
type DiscoveredOperationInput =
  | { readonly mode: "none" }
  | {
      readonly mode: "required";
      readonly example: OperationJsonValue;
    };
```

`mode: "none"` requires an initializer that resolves to the direct named `noInput` import from `@bb-kit/core/operations`; an import alias is valid. Local aliases, wrappers, and re-exports fail static discovery even if they resolve to the same runtime object. For required input, `exampleInput` must be a statically readable JSON literal. Parentheses, `as const`, and `satisfies` are valid. Identifiers, calls, spreads, shorthand or computed fields, templates, `undefined`, non-finite numbers, and cycles fail closed.

Generated no-input operations import and use `noInput`. Generated required-input operations include a literal `exampleInput`. Fixtures omit `input` for no-input operations and copy `exampleInput` for required operations. A fixture rejects `input`, including `null`, for no-input operations; it rejects an omitted input for required operations. All seed and invoke steps preflight before the first RPC.

`describe --json` returns `DiscoveredOperationInput`. Text output says `Input: none`, `Wire input: null`, and shows an invocation without `--input`; or says `Input: required`, prints compact example JSON, and shows a POSIX-shell-quoted `--input` command.

`invoke` sends exact JSON `null` only when the operation is canonical no-input and the user omitted `--input`. Any supplied input then fails with `unexpected_operation_input`. Every other schema, including `z.null()`, requires explicit input and fails locally with `missing_operation_input` when absent. Missing, extra, malformed, or undiscoverable input makes zero fetch calls.

Doctor selects the first query by stable identity for its suggestion. A no-input query is shown without `--input`; a required query uses its discovered example. When no query exists, doctor states `no read-only invocation is available`. It never suggests a command.

#### Modules and ownership

| Module | Owns and hides | Depends on | Interface | Why this split exists |
|---|---|---|---|---|
| `compatibility.ts` | Only supported line, hashes, metadata, shims | No project state | Package-internal immutable constant and focused check functions | Prevent policy selection and duplicated compatibility knowledge |
| `check.ts` | Offline source, manifest, script-alias, operation-metadata diagnostics | Compatibility, AST project discovery | `checkProject` | No process or host access |
| `build.ts` | Exact bb selection, direct plugin build, protected postconditions | Checker, compatibility, command runner | `buildProject` | One safe owner replaces package-authored build policy |
| `verify.ts` | Fixed tool sequence and protected postconditions | Checker, build, package inspection, command runner | `verifyProject` | One safe handoff gate without command configuration |
| `package.ts` | Actual dry-run package authority | Packed paths and manifest | `checkPackedPackage` | Static checks cannot model ignore/pack behavior fully |
| `operations.ts` | Branded `noInput`, operation state union, runtime JSON checks | Standard Schema type | `noInput`, `defineOperation` | Make invalid operation-input states unrepresentable |
| `query.ts` | Frontend RPC type seam and Query options | Native app hook, operation types, TanStack Query | `useOperationRpc`, existing options | One justified host compatibility cast |
| `project.ts` | AST operation discovery and literal JSON extraction | ts-morph/source files, lock | `DiscoveredOperation` | All CLI consumers share one fail-closed metadata source |
| `fixtures.ts` | Whole-batch input preflight and seed/invoke execution | Discovered metadata, invocation | Fixture parser and runner | Prevent partial mutation before a later invalid step |
| `invoke.ts` | Input-state enforcement, risk gate, RPC request | Discovered metadata | `invokeOperation` | Keep development invocation out of runtime package |
| `doctor.ts` | Read-only loaded-host evidence, checklist, suggested manual query | CLI runner and discovery | `doctorProject` | Live facts must not make `verify` nondeterministic or mutating |

No new package is required.

## Key decisions and tradeoffs

### D1: Safety before authoring convenience

| Option | Benefits | Costs and risks | Constraint fit |
|---|---|---|---|
| A — Compatibility and closure first | Prevents silent source mutation and invalid packages | Delays frontend convenience | Best fit; highest-severity observed failure |
| B — Frontend helper first | Removes a visible cast quickly | Leaves unsafe build path active | Poor fit |

**Decision:** Implement compatibility and package safety first.

### D2: Hash canonical declarations, do not ship their bytes

| Option | Benefits | Costs and risks | Constraint fit |
|---|---|---|---|
| A — Canonical SHA-256 | Small, offline equality proof, CLI remains generator | Byte-sensitive | Best fit |
| B — Ship declaration bytes | Could support offline repair | Adds about 598 KB, licensing work, and a second apparent authority | Not required |

**Decision:** Ship hashes only. Reverse this only if offline generation or repair becomes a requirement.

### D3: bb-kit owns build and verification

| Option | Benefits | Costs and risks | Constraint fit |
|---|---|---|---|
| A — Direct fixed tools | Package scripts cannot bypass the selected CLI or silently skip a gate | Custom build and verification commands are unsupported | Best fit; removes the observed invalid path |
| B — Run package scripts with protected environment | Preserves customization | Each script remains a policy and mutation escape hatch | Reject; safety depends on cooperation |

**Decision:** Add `bb-kit build`; make `verify` run fixed tools and the internal build function. Package scripts become exact aliases, not extension points. Continue post-tool checks because Bun lifecycle code remains outside bb-kit's full control.

### D4: One narrow frontend hook

**Decision:** Add `useOperationRpc(catalog)`. Do not add a broad app SDK wrapper or wrap TanStack hooks. The compatibility assertion belongs inside this hook because a type alias cannot satisfy bb's narrower generic constraint.

### D5: One canonical no-input state

| Option | Benefits | Costs and risks | Constraint fit |
|---|---|---|---|
| A — Branded singleton plus required examples | Identity is exact; invalid missing/extra states fail at definition and discovery | Breaking migration for existing descriptors | Best fit; no guessing or structural ambiguity |
| B — Optional defaults and summaries | Easy incremental adoption | Preserves ambiguous omitted, `{}`, and `null` states | Reject |
| C — Infer from validators | Less metadata | Requires schema internals or execution and can misclassify | Reject |

**Decision:** Export one `noInput` singleton. Every other schema requires `exampleInput`; `z.null()` means required explicit `null`. Use AST literal extraction, never validator inspection.

### D6: Doctor stays separate from verify

| Option | Benefits | Costs and risks | Constraint fit |
|---|---|---|---|
| A — Separate doctor | `verify` remains offline and reproducible | Two commands in handoff | Best fit |
| B — `verify --live` | One command | Host-dependent results and risk of accidental mutation | Reject |

**Decision:** Add `doctor`. A real surface interaction remains manual evidence.

### D7: Doctor cannot invoke

| Option | Benefits | Costs and risks | Constraint fit |
|---|---|---|---|
| A — Observe and suggest only | Mechanical read-only guarantee; no operation classification can cause mutation | User runs one suggested query separately | Best fit |
| B — Optional query probe | More automatic evidence | “Read-only” depends on metadata and still sends a live RPC | Reject |

**Decision:** Doctor has no probe option and no RPC dependency. It suggests the first query by stable identity, with the canonical example when required, but never executes it.

### D8: Own only the conventions that prevent mistakes

**Decision:** Require fixed build, lint, typecheck, test, and verify aliases. Do not require a `dev` script or a test directory. Watcher behavior is not part of the handoff gate, and `bun test` already owns coherent discovery.

## Cross-cutting concerns

- **Security and privacy:** Keep existing output redaction. Doctor must not print secret setting values and cannot make RPC requests. Its suggested next action is a query only, never a command.
- **Reliability and recovery:** Fail closed. Do not repair, restore, install, select alternatives, or infer operation input automatically. If a tool changes a declaration, report the exact phase and leave recovery to the author.
- **Observability:** Stable JSON includes selected CLI path/source/version, compatibility facts, hashes, metadata field mismatches, process signal/error, operation input state, doctor facts, suggested query, and checklist items.
- **Performance:** Hashing two declaration files after each step is small compared with typecheck and build. Parse source once per check where practical.
- **Compatibility:** This is an intentional bb-kit 0.1 breaking refinement. Exact engine strings and script aliases become required. Existing operations must adopt `noInput` or `exampleInput`. JSON command output gains fields and verification steps.
- **Trust boundary:** CLI `--version` and build metadata are provenance checks, not cryptographic process attestation. A selected path can also be replaced after preflight.

## Implementation plan

| Slice | Change | Dependencies | Verification | Rollback or forward fix |
|---|---|---|---|---|
| 1 | Add package-internal `compatibility.ts`, exact engine checks, declaration hashes, and root-version consistency test; add no selector to lock state | None | Checker fixture accepts canonical files and rejects missing/drifted files; public exports and lock schema expose no policy selector | Revert compatibility consumers as one unit; no project mutation |
| 2 | Add package-local import resolution and exact host shim checks with separate diagnostics for escape, unresolved import, and unsupported subpath | Slice 1 | Seed all three failures; valid Pierre root/react imports pass | Keep pack check authoritative; narrow false-positive resolver cases |
| 3 | Replace `CommandRunner` with `CommandRequest`; resolve the exact CLI; pass `env` from `runCli`; preflight type-syncing `init` before it writes files | Slice 1 | Fake runner records selected path and child environment; invalid `BB_CLI` never falls back; wrong CLI leaves a new init target empty | Revert runner API as one unit |
| 4 | Add `buildProject` and `bb-kit build`; invoke `<selected-bb> plugin build .` directly; check declarations and metadata before and after | Slice 3 | A package-authored build script is not called; wrong 0.36 CLI runs no build; drift and metadata failures identify build | Forward-fix direct invocation; never fall back to package script or auto-restore files |
| 5 | Change `verify` to fixed project-local oxlint, project-local `tsc --noEmit`, `bun test`, internal build, and dry-run pack; check protected outputs after each; require canonical aliases | Slice 4 | Custom package scripts are not called; wrong CLI runs zero tools; unscoped tests in valid layouts run; each phase drift identifies its owner | Forward-fix tool resolution or ordering; do not add command configuration |
| 6 | Add `useOperationRpc(catalog)` and type tests against bb 0.37 declarations with Zod 4.4 and exact optional types | None after Slice 1 | No-cast fixture compiles; wrong input/output type assertions fail | Keep old structural `rpc` option accepted during migration |
| 7 | Migrate Dotfiles panel and query definitions to `useOperationRpc`; remove duplicate client and cast | Slice 6 | Dotfiles typecheck, service tests, build, and live query | Restore local seam temporarily if framework typing regresses |
| 8 | Generate a `node:test` starter; require canonical aliases; retain no opinion about `dev`; keep `bun test` and Node types aligned | Slice 5 | Fresh backend/fullstack/theme projects typecheck and test without manual edits; watcher fixtures remain valid | Remove only starter generation; do not weaken owned aliases |
| 9 | Add command-local help independent of operation metadata | None | Every documented command `--help` exits 0 and prints local usage only | Local parser change can revert independently |
| 10 | Add branded frozen `noInput`, the descriptor input union, runtime JSON checks, and compile-time tests; migrate bb-kit tests and Dotfiles operations | Slice 1 | Exact singleton accepts no example; every other schema requires one; `z.null()` remains required input; invalid JSON fails | Revert contract and consumers together before release; do not add optional metadata |
| 11 | Replace regex operation metadata with AST discovery; update generated operations, fixture generation/preflight, `describe`, and `invoke` | Slices 9 and 10 | Direct import alias works; wrappers fail closed; strict fixture states pass; missing/extra/malformed input sends zero requests | Forward-fix AST cases; never infer schema behavior or fixture defaults |
| 12 | Add read-only `doctor` using supported `bb settings version --json` and `bb plugin list --json`; print discovered-surface checklist and one manual query suggestion | Slices 3 and 11 | Host-offline, incompatible, wrong-source, failed-status, no-query, and suggested-query tests; zero RPC in all cases | Report unavailable fields rather than scrape private APIs or add probes |
| 13 | Update framework specification, package READMEs, generated AGENTS guidance, and dogfood notes | All prior slices | Docs use exact commands and boundaries; generated snapshot tests pass | Documentation-only forward fix |

Each slice must leave root typecheck and tests green. Keep milestones reviewable: Slices 1–5 are P0 safety and ownership; 6–8 are authoring P1; 9–11 are operation-contract P1; 12–13 are P2 live handoff and documentation.

## Verification

| Layer | Scenario | Expected evidence |
|---|---|---|
| Unit | Private compatibility constant and declaration conditions | Exact hash and required-file results; no selection state |
| Unit | CLI path resolution | Absolute real path, no fallback after explicit failure |
| Unit | Import resolution | Separate stable diagnostics for escape, unresolved path, unsupported shim |
| Unit | `noInput` identity and JSON example contract | Singleton is identity-only; missing/extra/non-JSON examples fail |
| Unit | Invocation input selection | Omitted singleton sends `null`; extra singleton input and missing required input stop locally |
| Type | Zod catalog through `useOperationRpc` | Exact call input/output inference and no app cast |
| Type | Descriptor input union | Singleton forbids examples; all other schemas require schema-compatible JSON examples |
| Generator | Fresh projects | `bun run typecheck` and `bun run test` pass |
| Integration | Direct build ownership | Selected CLI receives `plugin build .`; package build script is never called |
| Integration | Fixed verification ownership | Exact aliases pass; custom scripts do not run; tests outside a fixed directory are discovered |
| Integration | Wrong CLI verification | No lint, typecheck, test, build, or pack subprocess runs |
| Integration | Tool mutates SDK declaration | That phase fails; later steps are skipped |
| Integration | Wrong build metadata | Build fails despite exit 0 |
| Integration | Pack lifecycle mutation | Final protected-output check fails |
| Integration | AST discovery and fixture preflight | Only direct `noInput` import classifies as none; invalid batches make zero RPC requests |
| Integration | Doctor | Plugin facts, checklist, and suggested query; zero RPC POSTs in every case |
| Dogfood | Dotfiles | Cast removed; owned `build` and `verify`, canonical input states, `describe`, invoke, and doctor work |
| Repository | Full gate | Root typecheck, test, lint, pinned build, SDK check, and `git diff --check` |

### Required diagnostics

- Checker codes: keep `BBK004` and `BBK005` for exact engine mismatches; add `BBK011` for missing/drifted SDK declarations, `BBK012` for non-canonical owned script aliases, `BBK110` for package escapes, `BBK111` for unresolved local imports, `BBK112` for unsupported host-shim subpaths, and `BBK210` for invalid operation-input metadata.
- CLI error codes: add `bb_cli_invalid`, `bb_cli_not_found`, `bb_cli_version_mismatch`, `sdk_declaration_drift`, `build_metadata_mismatch`, `invalid_operation_metadata`, `missing_operation_input`, and `unexpected_operation_input`.
- Invalid explicit `BB_CLI`: supplied value and requirement for an absolute executable; no PATH fallback.
- Missing PATH executable: advise `BB_CLI=/absolute/path/to/bb`.
- Version mismatch: expected version, actual output, selected real path, and selection source.
- Declaration drift: file, expected/actual hash or missing state, and detection phase.
- Metadata mismatch: file and exact JSON field path.
- Spawn failure: error code/message, signal, status, and bounded redacted output.
- Unsupported shim: exact specifier and supported alternatives when known.
- Invalid operation metadata: operation identity, file, unsupported AST form or missing/extra property, and required canonical shape.
- Missing invocation input: operation identity, compact example, and exact POSIX-shell-quoted `--input` form.
- Unexpected invocation input: operation identity and instruction to omit `--input`.

### Acceptance criteria

- [x] A 0.37 plugin run with bb 0.36 fails before any child tool and leaves SDK declarations byte-identical.
- [x] A type-syncing `init` with the wrong CLI fails before it creates project files; `--skip-types` remains an explicit no-CLI path.
- [x] `check` catches missing/drifted SDK declarations, package escapes, unresolved relative imports, and `@pierre/diffs/edit`.
- [x] `bb-kit build` reports the selected absolute bb path and directly executes that binary with `plugin build .`; it never runs `bun run build`.
- [x] `verify` uses fixed project-local lint and typecheck tools, unscoped `bun test`, internal build, and dry-run pack; it never runs package-authored verification scripts.
- [x] `check` requires exact owned script aliases but accepts any `dev` script or no `dev` script.
- [x] Protected declarations are checked after every tool and after pack; build metadata is checked after build and pack.
- [x] Dotfiles uses `useOperationRpc` with no duplicate client shape or application cast.
- [x] A fresh generated project typechecks and runs its generated test.
- [x] `invoke --help` exits 0 with only invoke guidance.
- [x] Exact `noInput` with omitted `--input` sends JSON `null`; supplied input fails without a request.
- [x] Every other schema has a literal example and requires explicit `--input`; `z.null()` requires `--input null`.
- [x] Fixture batches reject missing or extra input before the first seed or invoke RPC.
- [x] Doctor has no probe option, no RPC dependency, and no mutation path.
- [x] Doctor prints a surface-specific manual checklist and suggests only the first query by stable identity.
- [x] Existing pack validation and destructive invocation confirmation remain active.

## Migration, rollout, and rollback

1. Land the private compatibility contract, exact checks, direct `bb-kit build`, fixed `verify`, and canonical aliases together. Update exact engine strings in bb-kit consumers. Do not add a temporary policy selector.
2. Align generated-project tests while retaining `bun test` discovery and existing project watchers. Do not rewrite existing test locations.
3. Land `useOperationRpc` without removing existing query helpers. Migrate Dotfiles as the proof consumer.
4. Land `noInput`, required `exampleInput`, AST discovery, strict fixtures, and all existing bb-kit operation consumers in one breaking slice. Do not support old optional metadata in parallel.
5. Add doctor as an additive, read-only command. Keep `verify` independent from host availability and keep all live RPC in explicit `invoke` commands.
6. Run the full repository gate with an explicit pinned `BB_CLI`, then run doctor, its suggested Dotfiles query, and one real panel flow as separate evidence.

**Rollback trigger:** P0 blocks a canonical bb 0.37 plugin, runs a package-authored build command, changes declarations during a failed preflight, or accepts metadata built by another bb release.

**Rollback action:** Revert the affected unreleased slice as one unit and retain current pack validation. Do not weaken hashes, widen compatibility, restore script configuration, or add an input fallback as an emergency bypass. For a frontend-only regression, restore the old Dotfiles cast while fixing the narrow hook.

## Open questions

None. Doctor must report a field as unavailable when bb 0.37's supported `plugin list --json` output does not provide it. It must not scrape private HTTP endpoints or invoke a plugin to fill a report field.

## Decision log

| ID | Decision | Rationale | Status |
|---|---|---|---|
| D1 | Deliver compatibility safety before frontend convenience | Prevent silent source mutation first | Accepted for handoff |
| D2 | Store canonical declaration hashes, not bytes | Equality proof without a second declaration authority | Accepted for handoff |
| D3 | bb-kit directly owns build and fixed verification commands | Removes package-authored policy from the unsafe path | Accepted for handoff |
| D4 | Add only `useOperationRpc(catalog)` | One justified compatibility seam without a shadow SDK | Accepted for handoff |
| D5 | Use one branded `noInput`; require literal examples everywhere else | Removes omitted, `{}`, and `null` ambiguity | Accepted for handoff |
| D6 | Keep doctor separate from verify | Preserve deterministic offline verification | Accepted for handoff |
| D7 | Make doctor mechanically read-only with no RPC | Observation cannot accidentally mutate state | Accepted for handoff |
| D8 | Preserve dev and test-layout freedom only | These choices do not weaken the owned safety path | Accepted for handoff |

## Implementation-ready check

- [x] Scope, goals, and non-goals are defined.
- [x] Abstractions and contracts are defined.
- [x] System diagram and flowchart match the design.
- [x] Material tradeoffs and consequences are recorded.
- [x] Verification covers goals and material risks.
- [x] Migration, rollout, and rollback are safe for the stated risk.
- [x] No blocking questions remain.
