---
name: go-development
description: Apply Scott's Go engineering conventions when designing, editing, or reviewing Go code. Covers package ownership, preferred libraries, and verification.
---

# Go Development

Follow clear repository conventions first. Otherwise use the preferences below for new
and relevant touched code. A small Go fix does not authorize a dependency migration,
project-wide lint rule, or package reorganization. For command or terminal work, also read
[go-cli](../go-cli/SKILL.md).

## Package ownership

Infer the product and module boundaries from `go.mod`, `go.work`, and the existing layout.
Use `cmd/<name>` and private `internal/...` packages in single-project repositories. In a
monorepo, keep deployables under its established application or service boundary. Reserve
`pkg/...` for intentionally shared code.

Prefer concrete types and small exported APIs. Introduce interfaces at consumer boundaries
for real alternatives or testing needs. Convert generated, transport, persistence, and
domain shapes at the owning boundary. Use named domain identifiers when crossing packages.

Prefer one primary struct per file, with its constructor and closely related methods.
Split supporting concerns when they grow. Name constructors `New` when the package supplies
the type's name. Use functional options when optional behavior or actual construction
variants justify them, not for speculative extension points.

Prefer channels or atomics over a mutex only when they express the actual synchronization
more clearly. Keep comments for non-obvious constraints rather than narrating code.

## Library preferences

| Concern                   | Default                             |
| ------------------------- | ----------------------------------- |
| Logging                   | `zerolog`                           |
| Environment configuration | `envconfig`                         |
| JSON                      | `goccy/go-json`, imported as `json` |
| Input validation          | `go-playground/validator`           |
| Test assertions           | `stretchr/testify`                  |
| Test runner               | `gotestsum`                         |
| Linting                   | `golangci-lint`                     |

Check existing dependencies before adding any. Prefer `zerolog` over introducing `slog`
unless a repository convention or public API requires it. Normalize input once at capture
boundaries. Prefer validation tags on input structs and translate failures at the API or
command boundary. Optional `.env` files may be absent, but typed environment parsing errors
must surface.

## Errors and verification

Use sentinel domain errors for expected outcomes and preserve `errors.Is` matching.
Translate dependency-specific absence close to the dependency. Wrap infrastructure errors
where useful context is added. Keep expected validation failures distinct from unexpected
infrastructure failures.

Use repository test and lint commands. Otherwise use `gotestsum` with the relevant package
selection and `golangci-lint`. Limit `nolint` to a named linter with a real reason. Encode
agreed project-wide library restrictions in lint configuration when that is in scope.

With testify, prefer `require` for preconditions and `assert` for independent observations.
Use isolated filesystem and environment state. Parallelize only tests without shared
process state. Prefer package-internal tests unless public API behavior benefits from an
external-package test. Verify relevant transitions and boundaries, not implementation text.

## Build cache during agent reviews

For disposable review checkouts, add `-trimpath` to Go build, test, and vet commands
while preserving existing flags. Absolute checkout paths otherwise create different
cache keys for unchanged packages. Keep normal debug builds under repository control.
Reuse a stable review directory for successive revisions when no other agent owns it.
Run focused packages for probes and mutations; run the broad suite at meaningful
checkpoints rather than once per temporary copy. `-count=1` reruns tests but does not
require clearing the compilation cache.

On managed Linux hosts, `go-cache-guard.timer` checks the default `~/.cache/go-build`
every five minutes. It trims cold artifacts above 20 GiB toward 15 GiB and reacts to
less than 20 GiB free disk. Entries touched within one hour are protected, so this is
not a hard quota. Custom `GOCACHE` paths are outside its scope: keep them task-owned
and remove them after their builds finish. Do not delete the shared cache mid-build.
