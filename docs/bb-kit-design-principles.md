# bb-kit design principles

Status: historical evidence — superseded as guidance by the clean rewrite
(see docs/adr/0002-simplicity-over-inherited-safety.md)
Current compatibility line: bb 0.37.x, plugin SDK protocol 0.4.1

This document records the design rules learned while building bb-kit, rewriting
the Dotfiles plugin with it, hardening its verification path, and upgrading the
workspace to bb 0.37. Use it to decide how bb-kit should change.

The [framework specification](bb-plugin-framework-spec.md) defines the complete
architecture and contracts. The [Dotfiles dogfood notes](bb-kit-dotfiles-dogfood.md)
contain the observed evidence. The
[dogfood follow-up plan](plans/2026-08-13-bb-kit-dogfood-follow-up.md) records the
implementation decisions and rejected alternatives.

## Core position

bb-kit exists to prevent predictable plugin mistakes. It does not exist to make
every choice configurable.

> Provide one safe path for correctness-sensitive work. Preserve direct access
> to native bb everywhere else.

Configuration is a cost. Each option adds another state that documentation,
diagnostics, tests, upgrades, and agents must understand. Add a choice only when
real projects need different outcomes, all outcomes are safe, and bb-kit can
verify each outcome. Otherwise, select one behavior or reject the invalid state.

This is not a mandate to own all plugin behavior. bb-kit must be strict about
shared invariants and restrained about domain code, UI design, and uncommon bb
capabilities.

## 1. Remove unsafe choices

When one option is known to be safe, make it the normal and only framework path.
Do not add a `--force` flag, custom range, fallback, or policy selector to avoid
designing the safe operation.

| Risk                                                             | bb-kit policy                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| An untested bb range can claim false compatibility               | Require one generated range: floor at the tested bb, cap at the next major.   |
| A different CLI can mutate generated SDK declarations            | Select and validate the exact bb CLI before any project tool runs.            |
| Package scripts can bypass the verification contract             | Own a fixed verification sequence; treat scripts as exact aliases.            |
| A package-family prefix can admit an unsupported runtime subpath | Allow exact host-shim specifiers only.                                        |
| Omitted input can mean `{}`, `null`, or no user input            | Use one `noInput` singleton; require a literal example for every other input. |
| A diagnostic command can accidentally mutate live state          | Give `doctor` no RPC, install, reload, or repair path.                        |

Safe defaults are useful, but an impossible invalid state is better than a
default plus an escape hatch.

## 2. Give each invariant one owner

One module must own each correctness decision. Other files can consume or attest
that decision, but they must not select it again.

Examples:

- The compatibility contract owns the bb version, engine range, SDK version,
  artifact format, declaration hashes, host shims, and component registry URL.
- An operation descriptor owns identity, kind, risk, input state, and example.
- The operation lock owns stable wire identities and migration hashes.
- The verifier owns the release gate and tool order.
- TanStack Query owns frontend server state. Realtime only invalidates it.
- A vertical module owns one domain capability from model through adapters and
  UI surfaces.

Manifests, generated files, and build metadata are checked representations. They
are not additional policy authorities.

Prefer a deep private module that hides probing, hashing, validation, process
selection, and rollback over several small public helpers that make callers
coordinate those details. Export a helper only when consumers need a stable
capability, not because an internal step has a name.

## 3. Fail before an effect

The safe order is:

```text
discover → parse → validate → plan → authorize → mutate or request → attest
```

If discovery or metadata is ambiguous, stop. Do not guess from schema internals,
runtime behavior, package prefixes, nearby files, or user intent.

This rule applies at every effect boundary:

- Validate the complete fixture batch before its first RPC request.
- Validate command risk before invocation.
- Validate the selected CLI and protected files before lint, test, or build.
- Compute the complete compatibility write plan before changing one file.
- Refuse an unfamiliar composition root before a generator edits it.
- Reject missing or extra operation input before a network request.

Errors must identify the violated invariant and the exact safe correction. A
failed preflight should produce zero external effects.

## 4. Derive contracts from authoritative evidence, then attest them

Do not maintain a compatibility table by hand when the selected bb release can
produce the answer. The compatibility probe scaffolds and builds a temporary
full-stack plugin, then derives the SDK protocol, artifact format, declarations,
hashes, registry URL, and exact host shims.

Store enough evidence to detect drift:

- Exact version and engine values.
- Raw-byte declaration hashes.
- Build metadata with the producing bb and SDK versions.
- Exact runtime shim specifiers.
- Release-pinned registry URLs.

Provenance must describe an event that occurred. Never rewrite build metadata to
claim that new output was built. Change source compatibility first, require a
real build, and then validate the new output.

The bb CLI is the best available authority for bb 0.37. The better upstream
contract is an official machine-readable compatibility command. It should expose
the same facts without requiring bb-kit to inspect bundled implementation shape.

## 5. Change coordinated state as one transaction

If several files form one invariant, a command that updates only one file is
unsafe even when that command works correctly.

A compatibility-line change coordinates:

- The root bb pin.
- Every plugin's bb and SDK engine declarations.
- Vendored SDK declarations and their hashes.
- The bb-kit compatibility contract.
- Exact host shims.
- Component registry URLs.
- Existing build provenance checks.

The workflow is therefore `inspect`, `upgrade`, rebuild, and `check`, not a
declaration-only refresh script.

A safe transaction must:

1. Discover the complete workspace and target contract.
2. Compute every owned write before mutation.
3. Reject unsupported targets, downgrades, and concurrent changes.
4. Change only recognized framework-owned state.
5. Run a post-write workspace check.
6. Restore prior bytes if that check fails.
7. Report required follow-up work without performing hidden effects.

Build, install, and reload stay outside the compatibility transaction. They have
different effects and evidence. In particular, an upgrade must not create false
build provenance or replace the plugin that a user is currently running.

## 6. Preserve authored work

Framework automation must be safer than a manual edit.

- Generators are additive and idempotent.
- Generated files have clear ownership and drift checks.
- Authored source is edited only through recognized AST shapes.
- Unknown shapes cause a refusal with manual insertion instructions.
- Structured edits preserve unrelated fields and formatting where possible.
- Concurrent changes and linked filesystem targets are rejected when they make
  transactional safety uncertain.
- Dirty, unrelated files remain untouched.

Public identities require stronger protection than file paths. Lock RPC wire
methods and other externally referenced names. Lock migration history with
append-only hashes. A file move must not silently rename public behavior, and a
generator must not infer deletion from absence.

## 7. Prefer static, inspectable metadata

Agents and tools must be able to understand a project before they start bb or
make a request.

Operation identity, kind, risk, input state, examples, surfaces, storage,
migrations, and generated resources should be statically discoverable. One
source should feed backend registration, frontend types, fixtures, invocation,
inspection, and documentation.

Static discovery must use precise accepted forms:

- Direct imports for semantic sentinels such as `noInput`.
- Literal finite JSON for operation examples.
- Known composition roots for generated registrations.
- Lock files for stable public identity and history.

Do not execute project code to discover metadata. Do not inspect private schema
representations. If bb-kit relies on a convention, `bb-kit info`, `describe`, or
another read-only command must show what it found. Stable `--json` output is part
of the product contract, not an optional presentation format.

## 8. Add narrow compatibility seams, not a shadow SDK

Native bb objects remain at plugin composition roots. Uncommon capabilities use
the native API directly. bb-kit wraps only repeated correctness machinery or a
proven compatibility mismatch.

`useOperationRpc(catalog)` is the model. It owns one bb 0.37 Standard Schema type
assertion and returns exact catalog-derived methods, inputs, and outputs. Plugin
code does not repeat the assertion, but bb-kit does not wrap the rest of the app
SDK or TanStack Query.

Before adding an abstraction, ask:

1. Does the same correctness-sensitive code already repeat across plugins?
2. Can one owner hide a real invariant or compatibility detail?
3. Will the interface be smaller than the implementation it hides?
4. Can plugin authors still use native bb for capabilities outside the seam?

If the change only renames a native call, predicts possible future variation, or
adds an object for one call site, do not add it.

## 9. Separate checks by evidence and risk

No command can prove every layer safely. Each command needs a narrow evidence
contract.

| Command or loop                             | Evidence                                                    | Allowed effects                                     |
| ------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `check`                                     | Static plugin invariants                                    | File reads only.                                    |
| `check --workspace` / `compatibility check` | Cross-package compatibility invariant                       | File reads only; no bb process.                     |
| `compatibility inspect`                     | Contract derived from a selected stable bb CLI              | Temporary scaffold and build; no workspace write.   |
| `verify`                                    | Deterministic tools, exact build, and packed source closure | Project tools and build output; no live bb request. |
| `doctor`                                    | Connected host, installed source, and manual checklist      | Supported read commands only; no RPC or repair.     |
| `invoke` / fixture runner                   | Explicit loaded-operation behavior                          | Native RPC after metadata and risk preflight.       |
| Live UI loop                                | Layout, focus, portals, host CSS, and interaction           | Explicit human or browser interaction.              |

Do not combine these to reduce command count. A live `verify` would make an
offline release gate host-dependent. An invoking `doctor` would make “read-only”
depend on metadata honesty. A static checker cannot prove package contents or UI
behavior. Keep the boundaries truthful.

## 10. Treat the packed plugin as the runtime product

Build success is not package success. bb can load shipped source as a fallback,
so a plugin package must contain every manifest target and the complete relative
source-import closure. Runtime imports used by that source must resolve from the
published package.

Verification must check:

- Manifest targets and fixed build outputs.
- Exact generated declarations and build metadata.
- The packed file list reported by the package manager.
- The transitive relative source-fallback closure.
- Runtime dependencies and package-boundary escapes.
- Exact host-shim imports rather than package-family assumptions.
- Required license and package metadata.

Static source checks give early errors. Dry-run pack inspection remains the
authority for what will ship.

## 11. Design for agents without weakening safety

Agents benefit from fewer branches, explicit state, and local correction steps.
The same properties also help human authors.

- Use stable diagnostic and error codes.
- Include the file, field, expected value, actual value, and safe next action.
- Keep command-local help accurate.
- Print exact invocation examples from discovered metadata.
- Bound and redact process output.
- Keep JSON output stable and complete enough for automation.
- Make risky actions explicit and separately authorized.
- Generate short local instructions from canonical framework policy.

Do not compensate for an ambiguous model with more prose. Remove the ambiguity
from the type, metadata, generator, or command contract first.

## 12. Verify the failure modes that matter

Tests should match release risk, not only successful examples.

High-value bb-kit cases include:

- Wrong or invalid explicit CLI causes zero later tool runs.
- A child tool that changes a protected declaration fails in that phase.
- Stale or false build metadata fails after build and pack.
- A partial workspace upgrade fails.
- Compatibility upgrade is idempotent and rolls back failed post-validation.
- Concurrent edits and unsafe filesystem targets fail without data loss.
- Unsupported host-shim subpaths and package escapes fail early.
- Missing, extra, malformed, or undiscoverable input causes zero RPC requests.
- A fixture batch is fully valid before its first seed operation.
- Generator reruns produce no change and preserve authored code.
- The dry-run package contains the source fallback closure.
- Doctor's process allowlist contains no mutation or RPC command.

Dogfood the framework on a real full-stack plugin. Unit and integration tests did
not find the Dotfiles split-diff truncation, narrow-panel overlap, or installed
source mismatch. Those required a real surface and connected host. Dogfood is not
a replacement for deterministic tests; it finds the remaining integration gaps.

## Lessons from the Dotfiles rewrite

| Observation                                                                    | bb-kit response                                                                               | General rule                                         |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| bb 0.37 and Zod exposed a frontend type mismatch in each consumer.             | Add one `useOperationRpc` seam.                                                               | Centralize a proven host quirk once.                 |
| The generated test command and generated TypeScript environment disagreed.     | Generate one `node:test` setup that Bun runs without extra types.                             | A scaffold must make one complete choice.            |
| The active CLI changed declarations before compatibility failure was reported. | Preflight the exact CLI, own build and verify, and recheck protected outputs after each tool. | Safety policy cannot depend on project scripts.      |
| A host-shimmed package did not support every package subpath.                  | Lock exact supported specifiers and inspect the packed closure.                               | Model the host ABI exactly.                          |
| Omitted operation input was ambiguous.                                         | Add one `noInput` value and require literal examples for every other schema.                  | Prefer one valid representation over better guesses. |
| Offline verification passed while responsive UI defects remained.              | Keep a separate doctor, explicit invoke step, and real UI checklist.                          | State exactly what each check proves.                |
| A release upgrade required edits in many files.                                | Replace partial refresh tools with one transactional compatibility workflow.                  | One invariant needs one coordinated writer.          |
| The connected host used a different Dotfiles source than the worktree.         | Make doctor report installed source without changing it.                                      | Observe live state before testing it.                |

## Deliberate freedoms

Opinionated safety does not require uniform application code. bb-kit deliberately
does not select:

- Domain models, business outcomes, or service internals.
- Persistence when the capability does not need it.
- Uncommon native bb APIs or adapters.
- The repository's development watcher.
- Test file locations; unscoped `bun test` owns discovery.
- Source-owned UI details and visual design.
- The manual or browser procedure used for final live UI evidence.

These choices remain free because bb-kit does not need them to prove its owned
invariants. If a free choice later causes repeated correctness failures, first
look for the narrow invariant that bb-kit should own. Do not absorb the whole
area by default.

## Remaining improvements

### bb upstream

1. Add an official machine-readable compatibility command. It should report the
   bb version, plugin SDK version and artifact format, generated declaration
   artifacts or hashes, exact host shims, and component registry base.
2. Keep this contract stable across bb releases so tools do not need to inspect
   bundled implementation structure.

### bb-kit

1. Reject duplicate JSON keys before a compatibility plan. A last-value parser
   and first-key structured edit can otherwise disagree. Transaction rollback
   prevents partial state now, but an early diagnostic is clearer.
2. Return structured required actions after compatibility upgrade. Report that
   source compatibility changed and build provenance is stale, with the exact
   build and final-check steps. Do not run them automatically.
3. Decide workspace membership from authoritative workspace metadata if the
   current `plugins/*` convention becomes insufficient. Do not add another
   project list that can drift.
4. Audit new public exports. Keep policy and workflow internals private unless a
   real consumer needs a stable API. The compatibility workspace functions are
   intentionally private today.

## Future-change checklist

Before adding a bb-kit feature, answer these questions:

1. What observed mistake or repeated correctness machinery does it remove?
2. Which module becomes the single owner of the decision?
3. Can the invalid state be unrepresentable or rejected before an effect?
4. What is the authoritative source, and what evidence detects drift?
5. Can the operation preserve unrelated authored work and be idempotent?
6. Does it keep native bb available outside the narrow seam?
7. Can `info`, `describe`, a diagnostic, or `--json` explain what happened?
8. What are its exact side effects, rollback behavior, and authorization point?
9. Which failure cases prove the safety claim?
10. Does the feature remove more choices and coordination than it adds?

If these answers are weak, keep the behavior native or gather more dogfood
evidence before adding framework surface.

## Definition of better

A bb-kit change is better when it reduces:

- Independent decisions required from a plugin author.
- Files that a user must coordinate by hand.
- Duplicated policy and compatibility assertions.
- Requests or mutations that occur before validation.
- Runtime inference and hidden discovery.
- Ways to claim compatibility or provenance without evidence.

It must do this without increasing unnecessary framework surface, hiding native
bb, or taking ownership of project-specific behavior.

The final test is:

> Does this prevent an important mistake or remove repeated correctness work
> with one clear owner, while preserving ordinary source and native bb access?

If yes, it can belong in bb-kit. If it adds configuration, ceremony, or a second
name for a native call, leave it out.
