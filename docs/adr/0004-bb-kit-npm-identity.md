# bb-kit publishes as one @bb-kit-scoped package from this repo

Decided 2026-08-17. The unscoped npm name `bb-kit` is an unpublish remnant
(registry entry from 2021, zero versions, no maintainers) and is not claimable
by a normal publish, so bb-kit lives under the `@bb-kit` npm scope. The
0.1-era core/cli package split collapses into a single package that carries
both the runtime exports and the `bb-kit` bin; the split forced version
coordination and the workspace bin-linking scar for nothing, since CLI and
runtime always release together.

The framework stays in the bb-plugins monorepo and publishes through the
existing Changesets pipeline; a dedicated repo is deferred until external
contribution demands it. The published default consumer is a standalone
single-plugin repository; a multi-plugin workspace (this repo) is a
first-class second layout, not the default story.

## Consequences

- The `@bb-kit` npm org must be claimed by the owner before first publish;
  the fallback if the scope is taken is publishing under a personal scope.
- One package means subpath exports partition the surface (runtime vs CLI
  vs testing), not package boundaries.
- The package basename is `core`: the published package is `@bb-kit/core`
  (settled 2026-08-17, after this ADR was first written).
