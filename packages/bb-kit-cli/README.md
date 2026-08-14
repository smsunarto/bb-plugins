# bb-kit CLI

Scaffold, inspect, and check opinionated bb plugins.

The [bb-kit design principles](../../docs/bb-kit-design-principles.md) explain
why the CLI removes unsafe choices instead of exposing policy configuration.

```sh
bb-kit init my-plugin --kind fullstack
bb-kit add module approvals
bb-kit add operation approvals.get --kind query
bb-kit add operation approvals.approve --kind command --risk destructive
bb-kit add fixture approvals.get happy-path
bb-kit add migration approvals initial
bb-kit add panel approvals --location thread
bb-kit operations
bb-kit invoke approvals.get --input '{"approvalId":"A-1"}'
bb-kit fixtures run approvals
bb-kit info
bb-kit check
bb-kit check --workspace
bb-kit compatibility inspect
bb-kit compatibility check
bb-kit compatibility upgrade
bb-kit build
bb-kit verify
bb-kit doctor
```

Generators are additive, idempotent, and edit only recognized TypeScript
composition roots. `bb-kit.lock.json` preserves public RPC identities and
append-only migration hashes. `--json` provides stable output for coding
agents. Destructive loaded-operation invocations require `--confirm`.

bb-kit 0.1 has one compatibility contract: bb CLI 0.37.0, bb engine
`>=0.37.0 <0.38.0`, and plugin SDK 0.4.1. `check` fails on declaration drift,
non-canonical owned scripts, package escapes, unresolved local imports, and
unsupported host-shim subpaths. It also requires one statically discoverable
input state per operation: a direct `noInput` import, or another schema with a
literal JSON `exampleInput`.

`check --workspace` and `compatibility check` enforce the repository pin,
generated private contract, exact engine ranges, vendored declarations,
component registry URLs, and any existing build metadata across every plugin.
`compatibility inspect` selects any stable `x.y.z` bb CLI and derives its actual
SDK contract through a temporary full-stack scaffold and build. `compatibility
upgrade` applies that complete plan transactionally. It preserves unrelated
manifest fields and dirty files, rejects downgrades, custom ranges, and `--force`,
and never installs or reloads a plugin. It does not rebuild existing `dist/`
output; build after a line change so the workspace check can validate fresh
metadata.

`build` selects the exact bb executable, runs that executable as
`bb plugin build .`, and validates generated declarations and build metadata.
`verify` does not run package-authored scripts. It owns one fixed sequence:
project-local Oxlint, project-local TypeScript, unscoped `bun test`, the internal
build, and dry-run pack inspection. It checks protected outputs after each step.
Set `BB_CLI=/absolute/path/to/bb` when the `bb` on `PATH` is not 0.37.0.

`doctor` is read-only. It uses only bb version and plugin-list commands, reports
the connected host and installed source, and prints a suggested query and manual
UI checklist. It never installs, reloads, mutates, or invokes a plugin.

Fixtures are strict JSON or YAML scenarios under `fixtures/<module>/`. Each
declares optional seed operations, one invocation, and an exact expected JSON
result. The runner parses and preflights the whole selected set before making
an RPC call. Runs stop after the first failure so later scenarios never execute
against unknown state; destructive operations still require `--confirm`.
No-input steps must omit `input`. All other steps must include it, even when the
required value is JSON `null`.
