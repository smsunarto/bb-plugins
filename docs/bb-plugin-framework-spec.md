# bb-kit: an opinionated framework for bb plugins

Status: superseded — describes bb-kit 0.1; the clean rewrite replaces it
(see docs/adr/0001-bb-kit-clean-rewrite.md)
Target baseline: bb 0.37.x, plugin SDK protocol 0.4.1
Working name: `bb-kit`

## Summary

`bb-kit` is an opinionated framework and toolchain for building bb plugins safely with humans and coding agents.

It is not a replacement for `BbPluginApi`. It provides:

1. A filesystem convention for organizing a plugin into cohesive vertical modules.
2. A narrow operation abstraction for headlessly invoking application queries and commands.
3. TanStack Query integration for RPC state and realtime invalidation.
4. Idempotent generators for coordinated, ordinary TypeScript source.
5. A structural checker with precise, agent-readable diagnostics.
6. A first-class development workflow with pure, loaded-plugin, and live-UI feedback loops.
7. Small agent skills with progressive disclosure, generated from one canonical registry.

The governing principle is:

> Generate broadly, abstract narrowly, diagnose precisely, and keep the resulting code ordinary.

The framework makes the correct path generated and easy, while making dangerous states fail during generation, typechecking, testing, or building.

The [bb-kit design principles](bb-kit-design-principles.md) distill the decision
rules behind this specification and the lessons from real plugin dogfood.

### Implementation snapshot

The repository now contains the two initial packages:

- `@bb-kit/core`: operation descriptors/catalogs, structural native RPC registration, TanStack Query options and boundary, and validated realtime invalidation with reconnect reconciliation.
- `@bb-kit/cli`: additive initialization, module/operation/migration/panel/fixture generation, stable identity and migration locks, inspectable compatibility/surface/storage discovery, structural diagnostics, machine-readable output, native loaded-RPC invocation, deterministic JSON/YAML regression scenarios with command-risk guardrails, and an ordered verification gate through dry-run package/source-closure inspection.

The first implementation deliberately stops at the accepted seams. The broader surface/tool/event/service generators, changed-file optimization, bare-package dependency closure analysis, graph output, recipe updater, and generated skill registry remain later delivery phases rather than shallow placeholders.

## Context

bb already exposes a broad backend plugin interface covering settings, storage, HTTP, RPC, realtime, background services and schedules, CLI commands, agent tools, UI interactions, events, status, hosts, the bb SDK, and disposal. The frontend SDK already supports slots, composer customization, content scripts, typed RPC, realtime signals, settings, navigation, and bb context.

The existing plugins in this repository show that backend registration syntax is not the main source of accidental complexity. The repeated, correctness-sensitive work is primarily:

- Coordinating RPC loading, error, refresh, and mutation states.
- Preventing stale RPC responses from winning races.
- Translating realtime signals into authoritative state refreshes.
- Reconciling state after a realtime connection gap.
- Preserving server/browser import boundaries.
- Managing plugin-generation-scoped resources correctly.
- Maintaining package manifests, source fallbacks, generated SDK declarations, and packed source closures.
- Repeating UI recipes that must remain compatible with bb's host React and portal behavior.
- Giving coding agents a deterministic way to exercise behavior without driving the GUI for every change.

The framework should absorb those concerns. It should not mirror every bb capability behind another API.

## Goals

### Product goals

- Make a new plugin useful with the smallest possible scaffold.
- Make common full-stack plugin changes obvious, local, and safe.
- Let a coding agent add a complete capability without coordinating unrelated files manually.
- Make application behavior testable without requiring the bb GUI.
- Reserve live UI testing for behavior that actually depends on rendering, interaction, routing, focus, portals, or host styling.
- Keep generated source understandable and directly editable.
- Make framework discovery and generation inspectable.
- Preserve access to every native bb capability.

### Engineering goals

- Establish one natural owner for each domain rule, operation, persistence decision, and public identity.
- Prevent browser code from importing server-only code.
- Treat RPC as the authoritative frontend state boundary.
- Treat realtime as ephemeral invalidation, never durable state.
- Scope databases, timers, sockets, subprocesses, and bb handles to one plugin generation.
- Make generators idempotent and conservative.
- Turn deterministic conventions into machine checks instead of prose-only rules.
- Support bb's source fallback and pre-1.0 SDK compatibility model.

### Agent-experience goals

- Give agents predictable paths and stable vocabulary.
- Emit diagnostics that explain the violation, why it matters, and the exact safe correction.
- Provide fast checks for changed modules and full checks before handoff.
- Keep primary skill instructions short and disclose specialized material only when needed.
- Generate instruction metadata, catalogs, and documentation from one source of truth.

## Non-goals

`bb-kit` will not:

- Replace or wrap the complete `BbPluginApi`.
- Introduce a declarative `definePlugin({...})` shadow SDK.
- Define a second RPC protocol.
- Require every use case to become a public `bb` CLI command.
- Hide native bb registration or lifecycle semantics.
- Make realtime messages authoritative state.
- Ship a compiled UI component library.
- Require an ORM, dependency-injection container, global event bus, or global client-state store.
- Make Zod 4 the framework's public RPC type boundary.
- Promise that jsdom or a screenshot reproduces bb host integration.
- Automatically rename public plugin identities when files move.
- Overwrite existing authored files during initialization or generation.
- Commit, push, publish, or perform destructive actions without explicit approval.

## Design principles

### 1. Native bb at the edges

Plugin composition roots receive and use native bb objects:

```ts
export default async function plugin(bb: BbPluginApi) {
  await installApprovals(bb);

  // Uncommon capabilities remain directly available.
  bb.background.schedule("prune", "17 4 * * *", pruneOldApprovals);
}
```

The framework may provide narrow helpers, but it must not make a new bb capability unavailable until `bb-kit` adds a wrapper for it.

### 2. Modules own cohesive capabilities

A plugin is divided into vertical modules. A module owns one cohesive capability across its domain model, headless operations, persistence, backend adapters, and frontend surfaces.

Modules are preferred over `features` because the term also fits infrastructure-like capabilities such as indexing, synchronization, authentication, and notifications.

### 3. Every meaningful use case is headless

Business behavior is implemented as a headless query or command before it is connected to RPC, CLI, agent tools, events, or UI.

This does **not** mean every operation is a public CLI command. It means every operation can be called through a typed application interface and tested without rendering the GUI.

### 4. Server state has one authority

Durable state lives behind backend operations. Frontend code reads it through RPC and TanStack Query. Realtime messages only tell clients what to invalidate.

### 5. The filesystem is an interface

Paths communicate ownership, runtime, and dependency direction. Framework-owned identities can derive from paths. Public bb identities are recorded and protected from accidental renames.

### 6. Discovery must be inspectable

If `bb-kit` discovers a module, operation, surface, migration, or dependency, `bb-kit info` must show it. Generated catalogs and graphs must be available as machine-readable artifacts.

### 7. Minimal projects stay minimal

A theme plugin should not receive React Query, SQLite, Hono, forms, and empty application layers. Directories and dependencies are added only when the plugin needs them.

### 8. Put each rule in the lowest-cost enforcing layer

- Type relationships belong in TypeScript.
- Dependency directions belong in structural checks.
- Manifest and package rules belong in schemas and package inspection.
- Generator invariants belong in generator tests.
- Workflow decisions and rationale belong in agent skills and documentation.
- Host rendering and interaction behavior belongs in live bb verification.

## Vocabulary

The framework, its diagnostics, its documentation, and its agent skills use these terms consistently.

| Term                | Meaning                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Plugin              | One installable bb package.                                                                             |
| Module              | One cohesive capability inside a plugin.                                                                |
| Model               | Domain values, invariants, and pure business rules.                                                     |
| Service             | The headless application interface implementing module use cases.                                       |
| Operation           | A typed, headlessly invocable query or command.                                                         |
| Query               | A read-only operation.                                                                                  |
| Command             | An operation that may change state or cause effects.                                                    |
| Contract            | Validated JSON input and output shared across process boundaries.                                       |
| Adapter             | An RPC, CLI, tool, event, persistence, or UI integration that invokes a service or operation.           |
| Surface             | A place where a human or agent interacts with the module, such as a panel, command, or tool.            |
| Composition root    | `plugin/server.ts` or `plugin/app.tsx`, where modules are installed explicitly.                         |
| Authoritative query | An RPC-backed frontend query whose value comes from durable backend state.                              |
| Signal              | An ephemeral realtime message that invalidates authoritative queries.                                   |
| Generation resource | A database handle, timer, socket, subprocess, SDK handle, or mutable resource owned by one plugin load. |
| Source fallback     | Shipped plugin source used by bb when a managed bundle is absent or SDK-incompatible.                   |
| Recipe              | Generated, locally owned source such as a shadcn component or portal helper.                            |

## Architectural model

MVC remains useful as a separation principle, but `bb-kit` is better described as vertical modules with ports and adapters.

```text
┌──────────────────────────────────────────────────────────┐
│ Plugin                                                   │
│                                                          │
│  ┌──────────────── Approvals module ──────────────────┐  │
│  │                                                    │  │
│  │  React panel ──RPC/query──▶ Operations             │  │
│  │                              │                     │  │
│  │  CLI / tool / event ─────────┤                     │  │
│  │                              ▼                     │  │
│  │                         Service / model             │  │
│  │                              │                     │  │
│  │                              ▼                     │  │
│  │                         Repository adapter          │  │
│  │                              │                     │  │
│  │                              ▼                     │  │
│  │                         bb KV / SQLite              │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Native bb APIs remain available at every composition    │
│  root for capabilities outside the operation seam.       │
└──────────────────────────────────────────────────────────┘
```

MVC correspondence:

| MVC role          | bb-kit equivalent                                                    |
| ----------------- | -------------------------------------------------------------------- |
| Model             | Module model, service, and durable state.                            |
| View              | React panels, slots, composer contributions, and content scripts.    |
| Controller        | RPC handlers, tools, CLI commands, and event handlers.               |
| Transport adapter | Operation contracts, RPC, TanStack Query, and realtime invalidation. |

## Package graph

The initial framework should contain two published packages.

### `@bb-kit/core`

A deliberately small runtime package:

- Operation descriptors and typed registration.
- RPC query and mutation option builders.
- A plugin-scoped TanStack Query boundary.
- Realtime signal validation and query invalidation.
- Reconnect reconciliation.
- Optional live settings snapshots if repeated usage proves the helper worthwhile.
- Focused testing utilities for framework helpers.

Suggested exports:

```text
@bb-kit/core
@bb-kit/core/operations
@bb-kit/core/query
@bb-kit/core/realtime
@bb-kit/core/testing
```

The operation runtime must not import or restate the SDK: leaking its type surface into emitted declarations would tie every bb-kit consumer to one SDK minor of a pre-1.0 package. Instead, operation registration accepts a narrow structural host that native `BbPluginApi` satisfies. Frontend realtime helpers retain the bare `@get-bb/plugin-sdk/app` runtime imports that bb host-shims. The package must not bundle a second React instance or host-shimmed frontend dependencies.

### `@bb-kit/cli`

Development tooling and executable assets:

- `bb-kit init`
- Module, operation, surface, migration, tool, event, command, and service generators.
- `bb-kit info` and graph generation.
- `bb-kit invoke` for loaded RPC operations.
- Exact-CLI `bb-kit build` and fixed offline `bb-kit verify`.
- Read-only live preflight through `bb-kit doctor`.
- Structural dependency checks.
- Manifest, package, SDK, migration, identity, and source-closure checks.
- Recipe templates.
- Agent skills and generated agent instructions.

`@bb-kit/create-bb-plugin` may later be published as a convenience entrypoint, but it should delegate to `bb-kit init` rather than own a second scaffold implementation.

### Packages not justified initially

Do not create empty `core`, `server`, `ui`, or `shared` packages merely for symmetry. Add a package only when it owns repeated, nontrivial semantics.

## Technology choices

### Default runtime stack

| Concern                      | Choice                                                               | Reason                                                                                   |
| ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Host integration             | Native `@get-bb/plugin-sdk` and `@get-bb/plugin-sdk/app`             | This is the actual interoperability contract.                                            |
| UI                           | Host React plus locally owned recipes                                | Avoid duplicate React and preserve plugin-specific divergence.                           |
| Frontend server state        | `@tanstack/react-query`                                              | Owns request lifecycle, deduplication, retries, caching, mutations, and invalidation.    |
| RPC validation               | Standard Schema V1                                                   | Matches bb's validator-neutral RPC contract.                                             |
| New-plugin schemas and tools | Zod 4                                                                | Good default and required by typed agent tools, without becoming the framework boundary. |
| Persistence                  | Native `bb.storage.kv` and host `better-sqlite3`                     | Preserves bb lifecycle, namespacing, and source compatibility.                           |
| Tests                        | Vitest and Testing Library                                           | Fast pure, contract, query, and component tests.                                         |
| UI source                    | Tailwind, `clsx`, `tailwind-merge`, CVA, copied shadcn/Radix recipes | Compatible with bb's source-owned UI model.                                              |
| HTTP routing                 | Hono, only when requested                                            | Fits bb's Web Standard request/response model without burdening every plugin.            |

### Toolchain dependencies

| Package                 | Use                                                                             |
| ----------------------- | ------------------------------------------------------------------------------- |
| `dependency-cruiser`    | Enforce server/browser, layer, module, and cycle constraints.                   |
| `ts-morph`              | Perform conservative, idempotent TypeScript edits in known composition roots.   |
| `jsonc-parser`          | Edit JSON/JSONC while preserving formatting and comments.                       |
| `fast-check`            | Prove generator idempotency and framework invariants.                           |
| `publint`               | Validate published package manifests and exports.                               |
| `@arethetypeswrong/cli` | Validate emitted declaration resolution.                                        |
| `@changesets/cli`       | Coordinate releases and compatibility-line changes once packages are published. |

`ts-pattern` may be offered as an optional recipe for exhaustive rendering of discriminated outcomes. Plain exhaustive `switch` statements remain supported.

### Conditional additions

- React Hook Form for substantial nested forms.
- XState for genuinely long-running workflows with explicit retries, cancellation, recovery, and many states.
- MSW for modules that consume substantial external HTTP APIs.
- Knip for mature plugins with accumulated dependency or export drift.

### Explicitly rejected foundations

| Package or category            | Reason                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| tRPC                           | Duplicates bb RPC transport, contracts, validation, and errors.                             |
| Effect                         | Adds a language-within-a-language and raises the burden on coding agents.                   |
| Redux or Zustand by default    | Encourages duplication of authoritative server state.                                       |
| NestJS or DI containers        | Obscures ownership and plugin-generation lifecycle.                                         |
| Drizzle or Kysely by default   | Adds a mandatory persistence abstraction over host-owned SQLite.                            |
| Compiled shared UI kit         | Risks conflicts with React, Radix portals, host styling, and intentional plugin divergence. |
| Generic event bus              | Obscures bb events, realtime, cancellation, and disposal.                                   |
| `neverthrow` everywhere        | Discriminated unions are simpler and already exhaustive in TypeScript.                      |
| Storybook as host verification | Does not reproduce bb routing, CSS, slots, focus, or portal behavior.                       |

## Project layout

The filesystem is an authored interface, inspired by Eve's project layout philosophy. `plugin/` contains the shipped plugin surface. Development-only material lives outside it.

### Full plugin

```text
my-plugin/
├── package.json
├── tsconfig.json
├── bb-kit.lock.json                 # committed identities and generated-state hashes
├── plugin/
│   ├── server.ts                    # backend composition root
│   ├── app.tsx                      # optional frontend composition root
│   ├── modules/
│   │   └── approvals/
│   │       ├── contract.ts          # browser-safe schemas and wire types
│   │       ├── model.ts             # pure domain values and rules
│   │       ├── service.ts           # headless application use cases
│   │       ├── repository.ts        # KV/SQLite adapter
│   │       ├── operations/
│   │       │   ├── get.ts           # approvals.get query descriptor
│   │       │   ├── approve.ts       # approvals.approve command descriptor
│   │       │   └── reject.ts
│   │       ├── migrations/
│   │       │   ├── 001-initial.sql
│   │       │   └── 002-add-revision.sql
│   │       ├── generated/
│   │       │   ├── operations.ts    # bb-kit-owned generated catalog
│   │       │   └── migrations.ts    # bb-kit-owned generated statements
│   │       ├── server.ts             # native backend registrations
│   │       ├── app.tsx               # native frontend registrations
│   │       ├── queries.ts             # canonical query keys/options
│   │       ├── panel.tsx              # React view
│   │       └── test/
│   ├── components/ui/                # copied, plugin-owned recipes
│   ├── skills/
│   ├── themes/
│   └── lib/
├── fixtures/                         # loaded-operation scenarios
│   └── approvals/
├── tests/                            # plugin-level integration tests
├── evals/                            # optional agent/tool behavior evals
├── types/                            # bb-generated SDK declarations
└── .bb-kit/                          # ignored inspection artifacts
    ├── catalog.json
    ├── dependency-graph.json
    ├── package-closure.json
    └── diagnostics.json
```

The `generated/` directories are machine-owned and checked for drift. Application code never edits them directly.

### Minimal forms

A theme plugin should be genuinely small:

```text
plugin/
├── server.ts
└── themes/
    └── monokai.css
```

A backend-only tool plugin should not have `app.tsx`, UI dependencies, or TanStack Query.

```text
plugin/
├── server.ts
└── modules/
    └── search/
        ├── contract.ts
        ├── service.ts
        └── server.ts
```

Directories are added only when a requested capability requires them.

## Filesystem contracts

| Path              | Responsibility                                    | Allowed dependencies                                         |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| `contract.ts`     | JSON wire schemas and shared transport types      | Browser-safe schema and type libraries only.                 |
| `model.ts`        | Domain values, invariants, and pure rules         | Pure module code only.                                       |
| `service.ts`      | Headless queries and commands                     | Model plus dependency interfaces.                            |
| `repository.ts`   | Persistence adapter                               | Model, repository interface, and native bb storage.          |
| `operations/*.ts` | Operation metadata and input/output contract      | Contract and browser-safe code.                              |
| `server.ts`       | Native backend adapters and resource construction | Entire backend side of the module.                           |
| `queries.ts`      | Query keys and TanStack options                   | Contract, operation metadata, app SDK, bb-kit query helpers. |
| `panel.tsx`       | React view and local interaction state            | Queries, model display types, and UI recipes.                |
| module `app.tsx`  | Native app slot/content/composer registration     | Frontend module code.                                        |
| `components/ui/`  | Plugin-owned UI source recipes                    | Frontend code only.                                          |
| `fixtures/`       | Loaded-operation examples and scenarios           | JSON/YAML data, no production imports.                       |

Required dependency direction:

```text
panel/app ───────▶ queries ───────▶ contract/operations
server ─────────▶ service ───────▶ model
server ─────────▶ repository ────▶ model
adapters ───────▶ service

panel/app ──X──▶ server/repository/node:*
contract ───X──▶ React/SQLite/node:*
model ──────X──▶ bb SDK/React/SQLite
module A ───X──▶ module B internals
```

Cross-module collaboration occurs through an explicitly exported interface, operation, or shared pure type—not by importing another module's repository or adapter.

## Identity policy

### Derived framework identities

Framework-owned identity comes from paths:

| Path                                       | Derived identity                      |
| ------------------------------------------ | ------------------------------------- |
| `plugin/modules/approvals/`                | Module `approvals`                    |
| `operations/get.ts`                        | Operation `approvals.get`             |
| `operations/approve.ts`                    | Operation `approvals.approve`         |
| `fixtures/approvals/approve-conflict.yaml` | Scenario `approvals.approve-conflict` |

Operation files do not repeat a `name` field.

### Stable public identities

RPC method names, tool names, CLI commands, slot IDs, storage keys, and mention provider IDs can outlive source paths. Their first derived values and later explicit mappings are recorded in committed `bb-kit.lock.json`.

Moving a file must not silently rename a public identity. Raw moves that alter one fail verification:

```text
BBK312 Public identity changed

Operation:
  approvals.approve → reviews.approve

Referenced by:
  RPC method approvals_approve
  agent tool approvals_approve
  4 fixtures

Use:
  bb-kit move approvals reviews --preserve-identity

Or explicitly accept the breaking change:
  bb-kit accept-identity-change reviews.approve
```

## Module contract

A module may have server-only, app-only, or full-stack behavior. Installation remains explicit.

```ts
// plugin/server.ts
import { installApprovals } from "./modules/approvals/server";
import { installNotifications } from "./modules/notifications/server";

export default async function plugin(bb: BbPluginApi) {
  await installApprovals(bb);
  await installNotifications(bb);
}
```

```tsx
// plugin/app.tsx
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { registerApprovalsApp } from "./modules/approvals/app";

export default definePluginApp((app) => {
  registerApprovalsApp(app);
});
```

The generator edits only recognized composition-root shapes. If a root has an unfamiliar structure, it refuses to guess and prints the exact import and installer call for manual insertion.

## Operations

Operations are the framework's primary application seam. They are intentionally narrower than a plugin DSL.

### Kinds

- A **query** reads authoritative state and has no externally visible side effect.
- A **command** may change state or cause an effect.

### Descriptor

An operation descriptor contains transport-safe metadata, not domain implementation:

```ts
// plugin/modules/approvals/operations/approve.ts
import { defineOperation } from "@bb-kit/core/operations";
import { z } from "zod";

export default defineOperation({
  kind: "command",
  risk: "destructive",
  input: z.object({
    approvalId: z.string(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  exampleInput: {
    approvalId: "A-123",
    expectedRevision: 2,
  },
  output: z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("approved"),
      approval: approvalSchema,
    }),
    z.object({
      outcome: z.literal("conflict"),
      currentRevision: z.number(),
    }),
    z.object({ outcome: z.literal("not-found") }),
  ]),
});
```

An operation has one of two input states. Import the frozen `noInput` singleton
directly from `@bb-kit/core/operations` when callers supply no input. Do
not add an example in that state. Every other Standard Schema input requires a
finite JSON `exampleInput`; this includes `z.null()`, which requires callers to
supply explicit JSON `null`.

CLI discovery is deliberately stricter than TypeScript resolution. It accepts a
direct named `noInput` import, including an import alias, and a literal JSON
`exampleInput`. Local aliases, wrappers, re-exports, calls, spreads, shorthand,
and computed values fail closed. bb-kit does not inspect private schema internals
or guess a default input.

Its operation identity is `approvals.approve`, derived from the path and stabilized in `bb-kit.lock.json`.

Framework identities may contain one dot; bb RPC method names may not. The lock records the legal wire mapping, initially `approvals.approve` → `approvals_approve`. `defineOperationCatalog` rejects illegal or colliding wire methods before any native registration occurs.

### Service

The service owns application behavior and accepts dependencies rather than constructing host resources internally:

```ts
export interface ApprovalService {
  get(input: GetApprovalInput): Promise<GetApprovalResult>;
  approve(input: ApproveInput): Promise<ApproveResult>;
  reject(input: RejectInput): Promise<RejectResult>;
}

export function createApprovalService(deps: {
  repository: ApprovalRepository;
  clock: Clock;
  publish: ApprovalPublisher;
}): ApprovalService {
  // Domain implementation.
}
```

### Registration

The module server creates generation-scoped adapters and explicitly binds operation descriptors to handlers:

```ts
export async function installApprovals(bb: BbPluginApi): Promise<void> {
  const repository = createApprovalRepository(bb.storage);
  const service = createApprovalService({
    repository,
    clock: systemClock,
    publish(event) {
      bb.realtime.publish("approvals-changed", event);
    },
  });

  registerOperations(bb, approvalOperations, {
    get: service.get,
    approve: service.approve,
    reject: service.reject,
  });
}
```

`registerOperations` uses bb's native RPC contract, validation, JSON boundary, errors, and authentication. It does not define a second transport.

The helper accepts a narrow structural `rpc.register` host so its published server declarations do not depend on the `@get-bb/plugin-sdk` package. A native `BbPluginApi` satisfies that structure directly; the adapter's unavoidable generic assertion remains private to bb-kit.

Capabilities that do not fit an application query or command use native bb directly:

```ts
bb.events.on("thread.deleted", ({ thread }) => repository.removeForThread(thread.id));

bb.agents.registerTool({
  name: "approvals_approve",
  parameters: approveInputSchema,
  execute: service.approve,
});
```

### Error semantics

Expected, user-correctable domain outcomes are represented as discriminated results. Programming and infrastructure failures throw and follow bb's native error normalization.

Views must exhaustively handle every domain outcome. `ts-pattern` may be used, but it is not required.

```ts
switch (result.outcome) {
  case "approved":
    return renderApproved(result.approval);
  case "conflict":
    return renderConflict(result.currentRevision);
  case "not-found":
    return renderMissing();
  default:
    return assertNever(result);
}
```

## Frontend state model

TanStack Query is the single default owner of frontend server state.

### Query keys

Each module owns one canonical key factory:

```ts
export const approvalKeys = {
  all: ["approvals"] as const,
  detail: (approvalId: string) => ["approvals", "detail", approvalId] as const,
};
```

### Queries

bb-kit helpers return native TanStack Query options rather than wrapping `useQuery`:

```tsx
const rpc = useOperationRpc(approvalOperations);

const approval = useQuery(
  operationQueryOptions({
    rpc,
    operation: approvalOperations.get,
    input: { approvalId },
    queryKey: approvalKeys.detail(approvalId),
    staleTime: 30_000,
  }),
);
```

Callers retain the complete native TanStack Query interface.
`useOperationRpc` is the one frontend SDK compatibility seam. It keeps the bb
0.37 Standard Schema assertion inside bb-kit and preserves exact catalog method,
input, and output inference for plugin code.

### Commands and invalidation

Generated command options require an invalidation decision:

```tsx
const approve = useMutation(
  operationMutationOptions({
    rpc,
    operation: approvalOperations.approve,
    queryClient,
    invalidate: ({ input }) => [approvalKeys.all, approvalKeys.detail(input.approvalId)],
  }),
);
```

If a command provably does not affect query state, it must say so explicitly:

```ts
invalidate: false;
```

### Realtime

Realtime payloads are untrusted, ephemeral signals. They must be validated and translated into query invalidation:

```tsx
useRealtimeInvalidation({
  channel: "approvals-changed",
  schema: approvalChangedSchema,
  keys: ({ approvalId }) => [approvalKeys.all, approvalKeys.detail(approvalId)],
  reconnect: [approvalKeys.all],
});
```

The helper owns:

- Payload validation.
- Targeted invalidation.
- Malformed-signal logging.
- Reconciliation after `reconnecting → connected`.
- Component-lifecycle cleanup.

It does not claim transport cancellation because bb SDK 0.4.1's RPC client does not accept an `AbortSignal`.

Realtime must never be the only carrier of durable state. Optimistic updates remain explicit, module-owned TanStack Query behavior.

## Generation-scoped resources

All host and mutable resources are constructed inside the plugin factory or a module installer. They must not be cached in process-global variables across plugin generations.

Long-running work uses native background services:

```ts
bb.background.service("indexer", {
  async start(signal) {
    await runIndexer({ signal });
  },
});
```

Other resources register cleanup immediately:

```ts
const client = createClient();
bb.onDispose(() => client.close());
```

The checker rejects obvious module-level instances of bb handles, database handles, timers, sockets, and subprocesses. Runtime and integration tests cover disposal behavior that static analysis cannot prove.

## Persistence and migrations

Modules choose KV or SQLite based on their needs:

- KV for small namespaced JSON values no larger than bb's per-value limit.
- SQLite for relational, queryable, transactional, or larger durable state.

SQLite migrations are numbered, append-only SQL files. `bb-kit` generates the statement array consumed by native `bb.storage.migrate` and records hashes in `bb-kit.lock.json`.

The checker rejects:

- Editing a locked migration.
- Removing or reordering a migration.
- Duplicate or missing sequence numbers.
- A generated migration catalog that is stale.

New migrations may only be appended. Database handles remain host-owned and generation-scoped.

## CLI and development commands

### Public plugin CLI

A plugin registers a public `bb <plugin>` command only when that interface is useful to humans or agents in normal use.

Public CLI commands are adapters over the same service methods as RPC and tools. They never contain separate business logic.

### Development invocation

`bb-kit invoke` is a development interface, not a promise that every operation becomes a public CLI command.

```sh
bb-kit operations
bb-kit describe approvals.approve
bb-kit invoke approvals.list
bb-kit invoke approvals.get --input @fixtures/approvals/get.json
bb-kit invoke approvals.approve --input '{"approvalId":"A-123","expectedRevision":2}'
```

For the MVP, loaded invocation supports operations registered through native bb RPC. It exercises:

- The loaded plugin generation.
- Operation discovery and registration.
- Input validation.
- RPC serialization.
- Real configured storage.
- Handler wiring.
- Output validation.
- Native bb error normalization.

Operations not exposed through RPC remain directly testable through their service interface. The framework must not create artificial production endpoints solely to claim universal loaded invocation.

Mutation guardrails:

- Queries run directly.
- Commands print their risk classification.
- Destructive commands require `--confirm` in interactive use.
- Canonical no-input operations reject `--input` and send exact JSON `null` when it is omitted.
- Every other schema requires `--input`; missing or undiscoverable metadata makes zero requests.
- `--json` emits stable machine-readable output.
- Exit codes distinguish input validation, domain outcomes, and infrastructure failures.
- Secrets are redacted from diagnostics, logs, and fixtures.

The implemented CLI resolves the server from `--server`, then `BB_SERVER_URL`, then bb's loopback default. It posts to `/api/v1/plugins/<id>/rpc/<locked-method>` with the JSON and local-origin headers required by native bb RPC. This is the existing plugin protocol, not a second production endpoint. Remote/non-default deployments must provide their supported `BB_SERVER_URL` route.

## Fixtures and scenarios

Committed regression scenarios live under `fixtures/<module>/` as strict JSON
or YAML data. Generate the smallest valid JSON form with:

```sh
bb-kit add fixture approvals.approve conflict
```

Each scenario has an optional name and seed list, one required invocation, and
one required exact expected result. A canonical no-input operation must omit
`input`. Every other operation must include `input`, even when its required value
is `null`. `expect` is always required and may explicitly be `null`. Stateful
scenarios use the same deliberately small shape:

```yaml
name: approve-conflict
seed:
  - operation: approvals.create
    input:
      approvalId: A-123
      revision: 2
invoke:
  operation: approvals.approve
  input:
    approvalId: A-123
    expectedRevision: 1
expect:
  outcome: conflict
```

Only `name`, `seed`, `invoke`, and `expect` are accepted. Each operation step
accepts only `operation` and `input`. There are deliberately no variables,
conditionals, loops, scripts, snapshots, or implicit partial matchers; the
format must not evolve into a general programming language.

```sh
bb-kit fixtures run approvals
```

The runner discovers files in stable path order and parses every selected file
before making a request. It then preflights every referenced operation and its
risk metadata as one batch. An unknown or unlocked operation, malformed
operation descriptor, or unconfirmed destructive command therefore causes zero
RPC calls, even if it appears after a mutating seed in a later scenario.

Seeds run in declaration order through the same native loaded-plugin RPC path
as `bb-kit invoke`; then the invocation result must exactly deep-equal `expect`.
The loaded operation boundary performs the input and output contract validation.
After a seed, invocation, transport, domain, or expectation failure, remaining
scenarios are reported as skipped rather than run against unknown state.
Machine-readable results identify the failed stage and operation, and redact
sensitive key values and bearer tokens. Destructive scenarios require one
explicit `--confirm` for the selected, reviewed fixture set.

## Developer workflow

### Initial creation

```sh
bunx @bb-kit/cli init my-plugin
```

Initialization:

1. Inspects the target directory.
2. Infers existing package and bb conventions.
3. Presents facts and only genuine decisions.
4. Shows planned edits.
5. Adds missing files and dependencies without overwriting authored files.
6. Initializes the compatibility lock and generated catalogs.
7. Runs a focused check.
8. Prints the next useful command and live surface, if any.

Running `bb-kit init .` twice must be a no-op the second time.

### Intent-level generation

```sh
bb-kit add module approvals --panel thread --storage sqlite
bb-kit add operation approvals.get --kind query
bb-kit add operation approvals.approve --kind command --risk destructive
bb-kit add tool approvals.search
bb-kit add command approvals
bb-kit add setting retention-days --type string
bb-kit add event approvals thread.idle
bb-kit add service approvals.indexer
bb-kit add migration approvals add-revision
```

Every generator:

1. Detects the existing structure.
2. Is idempotent.
3. Refuses ambiguous edits.
4. Creates contracts, implementation stubs, and focused tests together.
5. Wires only recognized composition roots.
6. Formats changed files.
7. Runs targeted structural and type checks.
8. Reports generated files and remaining implementation work.

AST edits use `ts-morph`, not regular expressions.

### Three feedback loops

#### 1. Pure logic loop

Fastest and preferred while changing rules:

```sh
bun test plugin/modules/approvals/test/model.test.ts
```

This loop uses pure models, service dependencies, and fake repositories. It does not require bb, SQLite, RPC, or React unless those are the behavior under test.

#### 2. Loaded-plugin loop

Used for bb wiring and real persistence:

```sh
# Keep the repository's bb plugin watcher running.
bb-kit invoke approvals.get --input @fixtures/approvals/get.json
bb-kit fixtures run approvals
```

This loop checks registration, validation, serialization, storage, and runtime lifecycle without opening the UI.

#### 3. Live UI loop

Used only for behavior that depends on:

- Rendering and visual states.
- Navigation and bb context.
- Keyboard or pointer interaction.
- Loading, empty, error, and optimistic presentation.
- Focus, dialogs, drawers, portals, and browser dimming.
- Responsive behavior.
- Host CSS and slot integration.

The normal bb plugin watcher remains the source of truth. bb-kit does not own or
configure the watcher.

### Fast verification

```sh
bb-kit check
bb-kit check --workspace
```

Runs deterministic static checks:

- Exact manifest engines, owned script aliases, and SDK declaration hashes.
- Package-local imports, exact host-shim specifiers, architecture boundaries, and cycles.
- Operation metadata, command risks, generated catalogs, and identity locks.
- Append-only migration hashes and composition-root invariants.

The workspace form also rejects partial bb compatibility upgrades. It compares
the root pin, generated framework contract, every plugin's major-bound
engine range, generated declarations, component registry URL, and any existing
build metadata.

### Full verification

```sh
bb-kit verify
```

The implemented gate runs, in order:

- Structural manifest, compatibility, import, operation, identity, generated-catalog, and migration checks.
- Selection and exact `--version` validation of bb CLI 0.37.0.
- Project-local Oxlint and TypeScript executables, then unscoped `bun test`.
- An internal build that directly runs the selected bb executable with `plugin build .`.
- `bun pm pack --dry-run`, parsed fail-closed against Bun's own file count.
- Packed bb manifest-target, fixed build-output, license, and transitive relative source-fallback closure validation.
- Canonical SDK declaration hashes after each tool, plus exact build metadata after build and pack.
- Stable JSON steps and bounded, secret-redacted failure output.

The generated package aliases are fixed: `build` is `bb-kit build`, `lint` is
`oxlint`, `typecheck` is `tsc --noEmit`, `test` is `bun test`, and `verify` is
`bb-kit verify`. These aliases are not extension points, and verify does not
execute them. Projects remain free to select a watcher and test layout.

It does not falsely claim that build success proves UI behavior.

### Read-only live preflight

```sh
bb-kit doctor
```

Doctor validates the exact CLI, reads the connected bb version and plugin list,
and reports host compatibility, installed source, enabled/running state, app SDK
facts, the first query by stable identity, and a surface-specific manual
checklist. Its command allowlist has no install, reload, mutation, or RPC path.
Run the suggested `invoke` and UI steps separately after doctor passes.

## Inspection and observability

Like Eve's `eve info`, `bb-kit info` makes all convention-based discovery visible.

```sh
bb-kit info
bb-kit info approvals
bb-kit info approvals.approve
bb-kit info --json
bb-kit graph
```

Representative output:

```text
Plugin: @acme/bb-plugin-approvals
ID: approvals
bb: 0.37.0
SDK: 0.4.1

Entrypoints
  server  plugin/server.ts
  app     plugin/app.tsx

Modules
  approvals
    Queries
      approvals.get
    Commands
      approvals.approve [destructive]
      approvals.reject  [destructive]
    Surfaces
      thread-panel approvals
      agent-tool approvals_approve
    Storage
      SQLite migrations 001–002

Diagnostics
  ✓ All operations are reachable
  ✓ Public identities are stable
  ✓ Browser/server imports are isolated
  ✓ Packed source closure is complete
```

Ignored `.bb-kit/` artifacts contain the same discovered system as JSON and graph data. The committed `bb-kit.lock.json` contains compatibility-sensitive identities and hashes; transient inspection output does not.

## Checker

The checker is the center of the foolproofing strategy. Diagnostics use stable codes and the framework vocabulary.

```text
BBK104 App/server import violation

plugin/modules/activity/panel.tsx:8 imports ./repository.ts.
Repository adapters may use Node and SQLite and cannot enter the app bundle.

Move the shared type to:
  plugin/modules/activity/contract.ts

Suggested command:
  bb-kit fix BBK104
```

Autofixes are offered only for deterministic changes. The checker never rewrites domain behavior.

### Required check categories

#### Manifest and packaging

- Package name and derived plugin ID agree.
- `bb.server` and `bb.app` point to shipped source, not generated bundles.
- Owned build, lint, typecheck, test, and verify aliases are exact.
- Every manifest target exists in the packed package.
- The transitive source fallback closure is shipped.
- Runtime imports are declared in `dependencies` when source fallback needs them.
- Required license and third-party notices are included.
- Workspace filters actually match the package.

#### Compatibility

- bb and plugin SDK engine ranges exactly match bb-kit's single compatibility contract.
- The build uses the exact pinned bb CLI.
- Generated SDK declarations match canonical raw-byte hashes.
- Build metadata reports the exact bb and plugin SDK versions.
- Framework and plugin compatibility declarations agree.

#### Architecture

- Browser/server imports obey the filesystem contract.
- Domain model files do not import infrastructure.
- Cross-module internal imports are rejected.
- Circular dependencies are rejected.
- Composition roots have no duplicate installer calls.
- Obvious generation resources are not created at module scope.

#### Operations and state

- Every operation has validated input and output.
- Contract types are browser-safe and JSON-compatible.
- Every command declares an invalidation policy or `false`.
- Realtime helpers validate payloads and invalidate authoritative keys.
- Query keys come from the owning module's key factory.
- Public operation identities are stable.

#### Persistence

- Migration numbering is contiguous and unique.
- Locked migrations are unchanged and present.
- Generated migration catalogs are current.
- KV use respects known value-size constraints where statically detectable.

#### Generation

- Generated files match canonical inputs.
- Re-running each generator is idempotent.
- Generated catalogs, docs indexes, and harness metadata agree with the canonical registry.

### Rule documentation format

Every important rule is represented in four forms:

1. **Invariant:** the valid shape.
2. **Counterexample:** the tempting invalid shape.
3. **Machine check:** the diagnostic that enforces it.
4. **Completion evidence:** the command and observable result that prove the fix.

Example:

```text
Invariant
  Realtime signals invalidate authoritative RPC queries.

Invalid
  A signal carries partial report state and directly patches several caches.

Check
  BBK221 rejects realtime integration without validated query invalidation.

Done
  Disconnect, mutate server state, reconnect, and observe a fresh RPC result.
```

## Agent skill system

The framework ships small, task-oriented skills rather than one enormous bb manual.

Suggested skill set:

```text
/bb-plugin-help
/bb-plugin-create
/bb-plugin-module
/bb-plugin-ui
/bb-plugin-storage
/bb-plugin-diagnose
/bb-plugin-verify
```

### Invocation modes

- User-invoked skills cover deliberate workflows such as initialization and migration.
- Model-invoked skills contain explicit trigger descriptions for matching implementation, UI, storage, diagnosis, and verification work.

Invocation policy is canonical metadata, not duplicated prose.

### Progressive disclosure

Each skill directory separates:

1. Frontmatter used for discovery.
2. A concise `SKILL.md` decision process.
3. Conditional references.
4. Executable templates and scripts.
5. Human-facing documentation.

```text
skills/bb-plugin-module/
├── SKILL.md
├── agents/openai.yaml               # generated adapter
├── references/
│   ├── operations.md
│   ├── persistence.md
│   └── frontend-state.md
├── templates/
└── scripts/
```

Primary skill files contain only rules every branch needs. Backend-only work does not load React guidance; theme work does not load SQLite guidance.

### Canonical registry

One registry owns skill identity, status, invocation, description, composition, and distribution:

```ts
export const skills = {
  "bb-plugin-module": {
    invocation: "model",
    status: "stable",
    description:
      "Add or change a vertical module in a bb plugin. Use for RPC, tools, events, storage, services, or connected UI.",
    composes: ["bb-plugin-verify"],
  },
};
```

The framework generates and verifies:

- Skill frontmatter.
- Harness-specific metadata.
- Router/catalog entries.
- README and documentation indexes.
- Distribution manifests.

This avoids the manually synchronized registries found in many skill repositories.

### Generated repository instructions

Initialization writes a concise local `AGENTS.md` section or a referenced agent document without overwriting existing instructions:

```md
# bb-kit plugin conventions

- Organize behavior under `plugin/modules/<name>/`.
- Keep `contract.ts` and `model.ts` browser-safe.
- Frontend code must not import `server.ts` or `repository.ts`.
- Implement business behavior as headless operations.
- RPC is authoritative; realtime signals only invalidate queries.
- Expected domain outcomes use discriminated unions.
- Create host resources inside the plugin generation.
- Import `noInput` directly for no-input operations; give every other input a literal JSON `exampleInput`.
- Run `bb-kit check` while editing and `bb-kit verify` before handoff.
```

## UI strategy

bb-kit follows bb's source-owned UI model.

- UI components and portal helpers are copied as recipes into the plugin.
- Generated recipes are ordinary source and may diverge deliberately.
- Recipe version metadata allows `bb-kit` to show available updates and diffs.
- Updates are never silently applied over locally modified source.
- React, supported Radix modules, Sonner, Vaul, and other host-shimmed dependencies retain the import forms expected by bb's frontend builder.
- The framework runtime does not export a broad component library.

Live bb verification remains mandatory for representative affected states.

## TypeScript defaults

Generated projects use strict defaults:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true
  }
}
```

Where bb's generated declarations or current toolchain cannot satisfy one of these flags, the compatibility adapter documents the exception rather than weakening all projects silently.

## bb and SDK compatibility

bb's plugin SDK is pre-1.0, so minor SDK versions may be breaking. As of bb 0.39.0:

- This repository targets bb 0.39.0 and plugin SDK protocol 0.4.8.
- The SDK ships as `@get-bb/plugin-sdk` on the public npm registry, pinned exactly in each plugin's `devDependencies`.
- Before 0.38 it was the unpublished `@bb/plugin-sdk`, represented locally by declarations `bb plugin new` vendored into `types/`. bb 0.38 stops generating those and `bb plugin migrate` deletes them; the host still shims the legacy `@bb/plugin-sdk/app` specifier for already-built frontends.
- The published package includes the `./testing` and `./testing/app` harness exports.
- `bb-app` is the distributable source of the matching bb CLI/build behavior.

The generated engine policy floors at the tested bb release and excludes only
the next major:

```json
{
  "engines": {
    "bb": ">=0.39.0 <1.0.0",
    "bbPluginSdk": ">=0.4.8"
  }
}
```

The floor rises only through a verified `compatibility upgrade`.

Framework SemVer is independent from bb SDK SemVer and maintains an explicit table:

| bb-kit     | bb                | Plugin SDK        | Status                        |
| ---------- | ----------------- | ----------------- | ----------------------------- |
| 0.1.x      | 0.37.x            | 0.4.1             | Current target                |
| Later line | Explicitly tested | Explicitly tested | Added only after verification |

Compatibility rules:

- Select and execute bb 0.37.0 exactly; do not download or silently fall back after an invalid `BB_CLI`.
- Keep generated declarations as the compile-time SDK source.
- Treat declaration and build-metadata drift as a hard failure before later tools run.
- Do not copy the complete bb API into framework-owned public types.
- Preserve bare host runtime imports.
- Declare bb-kit runtime packages in plugin `dependencies` so source fallback can resolve them.
- Publish framework runtime packages before plugins that depend on them.
- Include framework source/runtime dependencies in packed-source closure verification.
- Treat an SDK compatibility-line change as a deliberate framework release decision.

The release decision uses one fixed workflow:

```sh
bb-kit compatibility inspect
bb-kit compatibility upgrade
bun run build
bb-kit compatibility check
```

`inspect` and `upgrade` derive the contract from a selected stable `x.y.z` CLI:
the major-bound engine range, SDK version and artifact format, generated
declarations and hashes, exact frontend host shims, and release-pinned component
registry URL. The upgrade computes all writes before it changes the workspace,
updates only framework-owned compatibility state, rolls back a failed post-check,
refuses downgrades, and has no custom range, force, install, or reload path.
Existing `dist/` output is not rewritten or made to claim a false build
provenance; rebuild it before the final workspace check.

## Testing strategy

### Pure tests

- Domain invariants.
- Service behavior through fake repository and effect interfaces.
- Parsing and formatting.
- Exhaustive domain outcomes.

### Contract tests

- Valid and invalid operation inputs.
- Output validation.
- JSON serialization boundaries.
- Domain outcome shape.

### Framework tests

- Query option behavior.
- Mutation invalidation.
- Realtime payload rejection and invalidation.
- Reconnect reconciliation.
- Query boundary cleanup.
- Generator idempotency.
- Identity stability.
- Migration hashing.
- Manifest and package diagnostics.

`fast-check` should prove invariants such as:

> Running any generator twice produces the same filesystem as running it once.

### Loaded-plugin tests

- Native registration.
- Real bb RPC validation and errors.
- KV/SQLite behavior.
- Disposal and reload lifecycle.
- Background service cancellation.
- Packed source fallback.

The official `@get-bb/plugin-sdk/testing` harness is distributable from bb 0.38.0. Its frontend half needs the optional `@testing-library/react` peer before it will run, and no suite here uses it yet.

### Frontend tests

- Loading, success, empty, expected-domain-error, and unexpected-error states.
- Mutation pending and completion states.
- Exhaustive domain outcome rendering.
- Query invalidation behavior.
- Local interaction logic where host behavior is not required.

### Live UI verification

Use the real bb dev/reload loop for:

- Slot and route registration.
- Navigation.
- Host context.
- Focus and keyboard behavior.
- Portals, dialogs, drawers, and browser dimming.
- Host CSS and responsive behavior.
- Realtime connection gaps.
- Representative default, empty, error, pending, and narrow-viewport states.

An executed interaction is evidence; a screenshot only illustrates the observed result.

## Generator safety

Generators follow these requirements:

- Idempotent by construction.
- Preserve unrelated user changes.
- Never use regex to modify TypeScript composition roots.
- Refuse unrecognized shapes instead of guessing.
- Print planned edits for broad changes.
- Write temporary files atomically and clean them up.
- Validate output immediately.
- Never modify machine-owned generated SDK declarations except through the supported bb type-refresh workflow.
- Never silently change public identities.
- Never silently upgrade recipes with local modifications.
- Never perform Git commits, pushes, publication, or destructive cleanup.

## Security and safety

- Treat plugin code as full-trust code running inside bb's server/app model.
- Preserve bb's native HTTP and RPC authentication behavior.
- Never persist secrets in fixtures, generated catalogs, snapshots, logs, or `.bb-kit/` artifacts.
- Keep secret settings backend-only.
- Validate all external, stored, RPC, and realtime inputs at their seam.
- Require confirmation for destructive development commands.
- Ensure operation diagnostics redact values based on schema metadata and setting secrecy.
- Keep webhook authentication/signature verification explicit; Hono does not make an unauthenticated route safe.

## Failure modes and guardrails

### 1. bb-kit becomes a shadow SDK

**Risk:** every new bb capability requires a framework release, and users cannot access native behavior.

**Guardrail:** no general `definePlugin`, no wrapped `BbPluginApi`, and no wrappers added merely for symmetry. Operation and query abstractions remain narrow.

### 2. Realtime becomes state

**Risk:** disconnected clients miss updates and display permanent stale state.

**Guardrail:** validate signals, invalidate authoritative queries, and reconcile bounded module roots after reconnect.

### 3. Old plugin generations retain resources

**Risk:** stale databases, timers, sockets, or processes survive reload and act on invalid host handles.

**Guardrail:** construct resources inside installers, use native service abort signals and `bb.onDispose`, and test reload behavior.

### 4. SDK publication assumptions break consumers

**Risk:** a plugin ships the SDK as a runtime `dependency`, or widens the pin to a range, even though bb host-shims the specifier and only one SDK minor matches the running host.

**Guardrail:** keep `@get-bb/plugin-sdk` an exact `devDependencies` pin owned by the compatibility contract, use host runtime imports, exact bb pins, source-closure checks, and explicit compatibility lines.

### 5. Frontend dependencies conflict with host shims

**Risk:** duplicate React, broken Radix portals, conflicting toaster instances, or focus bugs.

**Guardrail:** one added frontend foundation—TanStack Query—while host-shimmed packages keep supported import forms and UI recipes remain source-owned.

### 6. Filesystem magic becomes obscure

**Risk:** agents cannot explain why a file is or is not loaded.

**Guardrail:** `bb-kit info`, generated catalogs, stable diagnostics, and explicit native composition roots.

### 7. Generators corrupt authored code

**Risk:** repeated or ambiguous commands duplicate imports, installers, IDs, or domain logic.

**Guardrail:** AST edits, recognized shapes, idempotency properties, atomic writes, and refusal on ambiguity.

### 8. Framework ceremony overwhelms small plugins

**Risk:** a theme or one-tool plugin receives a modular-monolith skeleton.

**Guardrail:** minimal templates and additive slots; only create layers that have an immediate responsibility.

## Proposed commands

```text
bb-kit init [directory]
bb-kit add module <name> [capabilities]
bb-kit add operation <module.name> --kind <query|command>
bb-kit add fixture <module.name> <name>
bb-kit add panel <module> --location <nav|thread|new-thread|settings>
bb-kit add tool <module.name>
bb-kit add command <name>
bb-kit add setting <name> --type <string|boolean|select|project>
bb-kit add event <module> <thread-event>
bb-kit add service <module.name>
bb-kit add migration <module> <name>
bb-kit move <from> <to> --preserve-identity
bb-kit accept-identity-change <identity>
bb-kit operations
bb-kit describe <identity>
bb-kit invoke <operation> --input <json|@file> [--confirm] [--json]
bb-kit fixtures run [module]
bb-kit info [module|operation] [--json]
bb-kit graph
bb-kit check [--workspace] [--json]
bb-kit compatibility inspect [--json]
bb-kit compatibility check [--json]
bb-kit compatibility upgrade [--json]
bb-kit build [--json]
bb-kit explain <diagnostic-code>
bb-kit fix <diagnostic-code>
bb-kit dev
bb-kit verify [--json]
bb-kit doctor [--json]
```

Not every command belongs in the MVP.

## Delivery plan

### Phase 0: compatibility and transport spikes

Resolve the highest-risk assumptions before building broad generators:

1. Prove a separately published bb-kit runtime package works in both managed bundles and source fallback.
2. Prove TanStack Query bundles correctly while React resolves to bb's host shim.
3. Prove `bb-kit invoke` can locate and call loaded native RPC operations using supported local-auth behavior.
4. Prove generated operation contracts can feed native bb RPC without weakening validation or error semantics.
5. Prove numbered SQL files can generate deterministic native migration statements and ship correctly.

Exit criterion: one small pilot plugin builds, reloads, invokes a query and command headlessly, reconnects realtime correctly, and works from its packed source fallback.

### Phase 1: narrow runtime MVP

Implement:

- Operation descriptors and typed native RPC registration.
- `operationQueryOptions` and `operationMutationOptions`.
- `PluginQueryBoundary`.
- Validated realtime invalidation and reconnect reconciliation.
- Focused framework tests.

Pilot first on a small existing RPC/realtime flow, not the most complex plugin.

### Phase 2: inspection and checker MVP

Implement:

- `bb-kit info` and JSON catalog.
- Dependency-cruiser architecture checks.
- Manifest and source-entry validation.
- SDK pin and generated-declaration validation.
- Packed source-closure validation.
- Public identity lock.
- Stable diagnostics with `explain` output.

Exit criterion: the checker catches intentionally seeded violations and points to safe corrections.

### Phase 3: conservative generation

Implement:

- `init` for theme, backend-only, and full-stack plugin shapes.
- `add module`.
- `add operation`.
- `add migration`.
- AST-based composition-root edits.
- Generator idempotency properties.
- Generated local agent instructions.

Exit criterion: running every generator twice is a no-op, and existing unrecognized composition roots are preserved with manual instructions.

### Phase 4: headless workflow

Implemented:

- Operation listing and description.
- Loaded RPC invocation.
- Strict JSON/YAML fixtures with deterministic execution and exact matching.
- Minimal stateful scenarios with ordered seeds and stop-on-failure semantics.
- Command risk and confirmation behavior.

Still deferred:

- Changed-module checking.

Exit criterion: common backend behavior can be developed and regression-tested without opening the bb GUI.

### Phase 5: agent skill system

Implement:

- Canonical skill registry.
- Router and task-oriented skills.
- Progressive references.
- Generated harness metadata and documentation indexes.
- CI drift checks.

### Later, only with evidence

- A live settings snapshot helper.
- Typed signal descriptor generation.
- Content-script RPC support after bb exposes a supported non-hook client.
- Official bb test-harness adapters once the package is distributable.
- Recipe update/diff tooling.
- Focused SSE or abortable-wait helpers after repeated identical implementations emerge.

Do not expand into declarative tools, CLI, HTTP, schedules, slots, or agent configuration merely for API completeness.

## MVP acceptance criteria

The MVP is complete when all of the following are true:

1. A backend-only plugin can be initialized without frontend dependencies.
2. A full-stack plugin can add one module with a query, command, SQLite repository, thread panel, and realtime invalidation.
3. The module's domain behavior is testable through its service without bb or React.
4. Its loaded query and command are invocable through `bb-kit invoke` using native RPC.
5. Its panel uses native TanStack Query results and reconciles after a realtime disconnect.
6. A browser-to-server import violation fails with a precise diagnostic.
7. A changed locked migration fails before build.
8. A raw module move that changes public identities fails with preservation instructions.
9. Re-running initialization and generators produces no filesystem change.
10. `bb-kit info` accurately reports entrypoints, modules, operations, surfaces, storage, compatibility, and diagnostics.
11. The packed plugin contains its complete source fallback and works under the target bb release.
12. A live bb check verifies the generated panel's loading, success, empty/error, mutation-pending, and reconnect states.

## Decisions retained from explored alternatives

### Selected

- Vertical modules, stored under `modules/`.
- Native bb composition roots.
- A narrow operation seam for headless queries and commands.
- TanStack Query for frontend server state.
- Realtime invalidation rather than realtime state replication.
- Path-derived framework identity with locked public identity.
- Source-owned UI recipes.
- Filesystem conventions plus inspectable discovery.
- Idempotent, AST-based generators.
- Deterministic checker plus agent-facing skills.
- Three development loops: pure, loaded-plugin, and live UI.

### Rejected

- A comprehensive declarative shadow SDK.
- Scaffold-only tooling with no runtime help for RPC state.
- Making all business logic a public CLI surface.
- Organizing solely by technical layers across the plugin.
- Calling cohesive plugin capabilities `features`, `services`, `domains`, `components`, or `resources`.
- Hidden automatic registration of every bb capability.
- A shared compiled UI system.
- Markdown-only enforcement of deterministic rules.

## Inspirations

### bb's native plugin architecture

The design preserves bb's host-owned plugin lifecycle, generated SDK declarations, native RPC and realtime contracts, source fallback, storage APIs, frontend runtime shims, and explicit composition model.

### Matt Pocock's skills repository

Adopted ideas:

- Small, task-oriented skills.
- Explicit invocation semantics.
- Progressive disclosure.
- Shared leading vocabulary.
- Phase gates and observable completion criteria.
- Co-located references, templates, and scripts.

Improvement made here:

- Generate catalogs, harness metadata, and docs indexes from one canonical registry instead of manually synchronizing several indexes.
- Put deterministic correctness in executable checks rather than Markdown alone.

Reference: <https://github.com/mattpocock/skills>

### Eve's project-layout DX

Adopted ideas:

- The filesystem as an authored interface.
- Identity from paths where safe.
- Minimal-first scaffolding.
- Clear separation between shipped source, tests/evals, runtime artifacts, and import-only code.
- An `info` command that explains discovery and diagnostics.
- Additive, non-destructive initialization.

Adaptation for bb:

- Native composition roots remain explicit.
- Public bb identities do not silently follow file moves.
- Framework discovery supplements rather than replaces bb's manifest and runtime contracts.

Reference: <https://eve.dev/docs/getting-started#project-layout>

## Final design rule

When deciding whether to add something to `bb-kit`, apply this test:

> Does this remove repeated correctness machinery or make an important invalid state mechanically impossible, while preserving direct access to native bb?

If yes, it may belong in the framework. If it merely renames a native bb call, predicts hypothetical variation, or adds ceremony to simple plugins, leave it out.
