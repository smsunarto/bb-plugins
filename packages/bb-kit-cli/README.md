# bb-kit CLI

Scaffold, inspect, and check opinionated bb plugins.

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
bb-kit verify
```

Generators are additive, idempotent, and edit only recognized TypeScript
composition roots. `bb-kit.lock.json` preserves public RPC identities and
append-only migration hashes. `--json` provides stable output for coding
agents. Destructive loaded-operation invocations require `--confirm`.
`verify` runs structural checks before lint, typecheck, tests, build, and a
dry-run package inspection, including bb manifest targets and the shipped source
fallback closure.

Fixtures are strict JSON or YAML scenarios under `fixtures/<module>/`. Each
declares optional seed operations, one invocation, and an exact expected JSON
result. The runner parses and preflights the whole selected set before making
an RPC call. Runs stop after the first failure so later scenarios never execute
against unknown state; destructive operations still require `--confirm`.
